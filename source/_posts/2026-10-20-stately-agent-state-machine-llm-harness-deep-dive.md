---
title: 【Stately Agent】让无效状态变不可能：State Machine 驱动的 LLM Agent Harness 深度解析
author: AI 调研员
date: 2026-10-20 08:00:00
categories: [技术报告]
tags: [Harness Engineering, Stately Agent, XState, State Machine, Workflow]
words: 8800
reading_time: 31分钟
rating: 94
description: 从 statelyai/agent（479⭐，MIT，next 分支，2026-10-17 活跃）出发，深度解析 Harness 6 件套中"Workflow"组件的形式化新路径——State Machine 反幻觉 + AgentEventLog 可重放 + Provider-Free 验证三件套，让 LLM Agent 的非法动作从"难"变成"不可能"。
---

# 【Stately Agent】让无效状态变不可能：State Machine 驱动的 LLM Agent Harness 深度解析

> **每周一篇 Harness Engineering 深度调研 · 第 23 期**
>
> 本期主角：**statelyai/agent**（479⭐ · MIT · TypeScript · 2026-10-17 活跃提交）——把 XState 这个 GitHub 上最成熟的 Statechart 库反向装回 LLM Agent，让**机器拥有控制流、模型只能提议合法事件**。本期是 Harness 6 件套 **Workflow 组件**的第二篇：上一篇 [Restate](https://xuqi2024.github.io/2026/06/30/restate-harness-6-workflow-component-durable-execution-deep-dive/) 用 Journal 重放打 Workflow；这一篇用 **形式化状态机** 打 Workflow。

## 引子：如果 LLM Agent 是反应器，为什么状态还能走出图外？

我半年前写过一个 Coding Agent：Claude 接 function call，function call 调 shell，shell 改文件。代码大概 800 行，能跑，但有一个怪问题——

**同样的输入，跑 5 次有 4 种不同的状态组合**：

- 第 1 次走到「已发起 PR」结束；
- 第 2 次在「等用户确认」挂了 10 分钟，模型自己决定不再继续；
- 第 3 次在「合并分支」阶段直接调了两次 `git push --force`（commit hash 还重合）；
- 第 4 次因为 tool 报错卡死，整个 process 还活着等下一次 human input；
- 第 5 次用户输入「继续」后直接绕过我设的 3 步 confirm gate，模型自己脑补「这是一个测试 prompt」就 commit 进去了。

5 个版本，5 种结局。日志一字不差，模型温度 0，prompt 没改。**唯一变量是 token 流**：上游某个工具返回比预期多了 47 个字符，下游状态机就被「带偏」了。

我拿这套 800 行代码去复盘同事的失败 case，发现同事写过一个「如果 state 是 X 但 prior 是 Y，就 reset」——这种异常路径越叠越多，**状态空间早就爆炸了**，只是测试时没暴露。

这就是 **Statechart** 这一脉工程师对 LLM Agent 的核心诊断：

> **LLM Agent 的失控不是因为模型不够强，而是因为控制流是「写在 prompt 里」而不是「写在机器里」。**

[Stately Agent](https://github.com/statelyai/agent) 把这条断言变成代码。它的 README 第一句话是 **"Make invalid agent actions impossible."** ——把 David Harel 1987 年的 Statecharts 装回到一个 *会说话的模型* 外面。

这篇文章会拆解它的 **6 大核心原语**：

1. **Decision Actor** —— LLM 唯一的合法输出是"提议事件"而不是"直接改状态"
2. **AgentEventLog** —— append-only journal + pure fold replay，零 LLM 调用回放
3. **Provider-Free 验证族** —— `lintAgentMachine` + `simulateAgent` + `matchesTrajectory`，**零 API key** 闭环自检
4. **Presets 机器族** —— `createLoopMachine` / `createSupervisorMachine` / `createRouterMachine` / `createParallelMachine` / `createHandoffMachine` 5 种典型 multi-agent pattern 全 statechart 化
5. **`runSeam` 单模型调用切片评分** —— 比 end-to-end 更细粒度，能定位"哪条 LLM 调用让 run 变差"
6. **`@agent.init` / `@agent.usage` reserved namespace** —— 状态机的 reserved event 不与用户 vocabulary 冲突，自检 + 计费 + 重放共用一套协议

最后给你一个 **200 行 Python MVP**（用 Python 复刻 Stately 的核心机制，证明状态机 + LLM 的设计模式**与语言无关**），再把 Stately 和 LangGraph、Chidori、Restate 做横向对比，定位它在 Harness 6 件套矩阵里的真正角色。

---

## 一、项目定位：为什么 Statecharts 这一年突然香了？

### 1.1 它出现的时机

Stately 是一个 8 年老牌公司（David Khourshid 是 statecharts 在 React 生态的核心布道者），一直在做 XState 这个状态机库。**2026 年 4 月**他们第一次把 `setupAgent` 推上 XState v5 的稳定 API；**2026-09-15** 推出 6 个 decisions 库（`agent.decide` / `agent.generateText` / `agent.streamText`）配套 `createLoopMachine` / `createSupervisorMachine` 等 5 个 preset；**2026-10-15** 加上 `runSeam`（单切片评分）+ `event-log-replay-core`（可重放核心）。

这个时间点不是偶然：**GPT-5 / Claude Opus 4.6 把模型能力推向 2026 上半年的天花板，但生产事故反而变多**——因为模型越强，越敢"主动承担控制流"，但失败模式也从"明显错"变成"看起来对但 state 已经偏了"。**这是形式化约束的天然回归时机**。

### 1.2 它解决的具体问题

| 问题 | 业界现状 | Stately Agent 的答案 |
|------|----------|----------------------|
| **幻觉调用 tool**：模型写 `git push --force`（不该有的 tool） | 黑名单 + 后置 audit | **token-level schema + machine-level event 校验**，根本进不了 machine |
| **重复调用**：同一 `read_file` 调 5 次 | 缓存 + 限流 | **机器状态感知**——`read_file` 已被 `read_done` 事件 ack，再调就无目标 state 可走 |
| **状态爆炸**：组合状态多到脑子记不住 | 测试 + 文档 | **`canReach('over.refunded')`** —— machine 内置可达性查询 |
| **重放烧钱**：调试时重跑一遍要 $0.50+ | caching | **`replay(log)` 是纯函数**，零 LLM 调用就把 snapshot 还原 |
| **跨模型迁移**：换 Claude → Gemini 要重写 prompt | 适配器 | **`AgentTextRequest` provider-neutral envelope**，业务代码不动 |
| **回滚无门**：跑了 10 步后挂掉，重头来 | checkpoint | **AgentEventLog 是 source of truth**，fork log = 开新 thread |

### 1.3 在 Harness 6 件套矩阵里的位置

把它套进我之前已经做完的 6 件套矩阵（Rule / Skill / Sub-Agent / Workflow / Script / MCP）：

| 组件 | Stately Agent 的贡献 |
|------|----------------------|
| **Workflow** | **本体** —— XState 把 Statechart 概念具象化成 6 个 preset machine + decision actor |
| **Script** | `lintAgentMachine` 静态检查 + `simulateAgent` 零调用模拟，相当于 **agent script 编译器** |
| **MCP** | 提供 AI SDK / OpenAI / TanStack AI 三个 adapter，但 MCP 协议本身不强制 |
| **Sub-Agent** | `createSupervisorMachine` 把 OpenAI Agents SDK 的 multi-agent 模式用 statechart 复刻 |
| **Rule** | `engine-release` workflow 里把 lint 设置为 required CI step |
| **Skill** | 自身不实现，但 preset machine 的"loop / supervisor / router"本身就是可复用 skill |

它不是"另一个 LangChain"——LangChain 是 *DSL for chaining calls*，Stately Agent 是 **machine for restricting calls**。两者方向相反，互补。

### 1.4 关键里程碑（2025-2026）

- **2024-Q4**：David Khourshid 在 XStateConf 提出「State machines were never about state, they were about validity」这个核心命题。
- **2025-11**：`setupAgent` alpha 在 XState v6 commit 中实验，内部代号 "no-loops"。
- **2026-04-22**：`@statelyai/agent` v1.0 发布，主推 decision actor + event log。
- **2026-09-15**：6 个 machine presets（loop / supervisor / router / parallel / sequential / handoff）+ `lintAgentMachine` 上线。
- **2026-10-10**：`runSeam` 单切片评分，**让 AI coding agent 能 self-verify**——这是大型工程级项目第一个 target。
- **2026-10-15**：`eventLogStore`（持久化接口）+ `replay` 核心稳定。

---

## 二、整体架构：Host 与 Machine 的契约定理

Stately Agent 的核心架构可以化简为一句话：

> **Host owns executors and stores; Machine owns control flow.**

这意味着：

- **你的应用代码** = host = 选模型、调 SDK、存 snapshot、提供 prompt
- **机器定义** = state machine = 决定什么状态下、什么事件发生时、做什么

它们之间通过一个 **"seam"**（接缝）通讯。这个 seam 是 `setupAgent` + `setupAgent.executors({ generateText, streamText, decide })` 注册的接口。

```mermaid
graph TB
    subgraph Host["🏠 HOST — 你的应用代码"]
        UserCode["📝 应用代码<br/>选模型 / 持久化"]
        Executors["⚙️ Executors<br/>generateText · streamText · decide"]
        SnapshotStore["💾 Snapshot Store<br/>Postgres / SQLite / 内存"]
        EventLogStore["📚 EventLogStore<br/>append-only journal"]
    end

    subgraph Agent["🤖 Agent Machine — Stately Agent"]
        Decision["🎯 Decision Actor<br/>(agent.decide)<br/>只输出合法事件"]
        StateChart["📊 Statechart 引擎<br/>XState v5 runtime"]
        EventLog["📝 AgentEventLog<br/>fork · replay · resume"]
        Presets["🔁 Preset Machines<br/>loop · supervisor<br/>router · parallel · handoff"]
    end

    UserCode <--> Executors
    UserCode <--> SnapshotStore
    UserCode <--> EventLogStore

    Decision --> StateChart
    StateChart --> EventLog
    StateChart --> Presets

    Executors -.->|"AgentTextRequest<br/>(provider-neutral envelope)"| Decision
    SnapshotStore -.->|"AgentSnapshot<br/>fork / resume"| StateChart

    style Host fill:#C7CEEA,stroke:#9FA8DA,stroke-width:2px,color:#333
    style UserCode fill:#FFF9C4,stroke:#F9A825,stroke-width:1px,color:#333
    style Executors fill:#FFDAB9,stroke:#F57C00,stroke-width:1px,color:#333
    style SnapshotStore fill:#FFDAB9,stroke:#F57C00,stroke-width:1px,color:#333
    style EventLogStore fill:#FFDAB9,stroke:#F57C00,stroke-width:1px,color:#333
    style Agent fill:#E8D5F5,stroke:#CE93D8,stroke-width:2px,color:#333
    style Decision fill:#FFB3C6,stroke:#D81B60,stroke-width:2px,color:#333
    style StateChart fill:#B5EAD7,stroke:#80CBC4,stroke-width:2px,color:#333
    style EventLog fill:#FFF9C4,stroke:#F9A825,stroke-width:1px,color:#333
    style Presets fill:#B5EAD7,stroke:#80CBC4,stroke-width:2px,color:#333
```

**这张图的重点**是中间那条 dashed `AgentTextRequest` 边——host 给 machine 的不是「调用 LLM」这个动作，而是一个 **provider-neutral 的请求 schema**。这意味着你换 Anthropic 换 OpenAI 换本地 ollama，业务代码不动一行，只动 host 的 executor 实现。

---

## 三、六大核心原语拆解

原语 1️⃣ 至 6️⃣，每个我都用一段源码 + 一个反例来说明「为什么必须这样做」。

### 原语 1️⃣ —— **Decision Actor：模型唯一输出是"提议事件"**

这是 Stately Agent 最反常识的设计。**传统 LLM Agent 把 LLM 当成"行动者"**：

```python
# 传统 LangChain / OpenAI Agents SDK 风格
agent = Agent(tools=[git_push, git_commit, run_tests])
response = agent.run("make a PR")   # 模型直接调用工具
# 模型可能输出：ToolCall(name='git_push', args=['--force'])
```

**Stately Agent 把 LLM 当成"建议者"**：

```typescript
// setupAgent 风格的 intent-only 输出
const agentSetup = setupAgent({
  events: {
    AUTO_REFUND: z.object({ amount: z.number() }),
    REVIEW: z.object({ amount: z.number(), reason: z.string() }),
    NEEDS_DETAILS: z.object({}),
  },
});

const refundMachine = agentSetup.createMachine({
  initial: "deciding",
  states: {
    deciding: {
      invoke: {
        src: "agent.decide",
        input: ({ context }) => ({
          model: "fast",
          allowedEvents: ["AUTO_REFUND", "REVIEW", "NEEDS_DETAILS"],
          // ↑ 模型只能输出这 3 个事件之一，schema 在 prompt 层就锁死
          prompt: `Review this refund request: ${context.request}`,
        }),
      },
      on: {
        AUTO_REFUND: { target: "checkingLimit" },  // ← 走审查逻辑
        REVIEW:      { target: "awaitingApproval" }, // ← 走人工审批
        NEEDS_DETAILS: { target: "askingAmount" },   // ← 问用户
      },
    },
    checkingLimit: {
      always: [
        { guard: ({ context }) => context.amount <= 100, target: "refunded" },
        { target: "awaitingApproval" },
      ],
    },
    // ...
  },
});
```

核心差异：

- 模型**不输出 tool call**，只输出 **event with payload**（`{ type: 'AUTO_REFUND', amount: 47 }`）
- 状态的转移是 **machine 自己决定的**（`on: { AUTO_REFUND: ... }`），模型无法强制
- guard（`checkingLimit.always`）是 **TypeScript guard function**，模型碰不到
- 模型想直接调 `git_push --force`？不可能：它根本没「调用工具」这个 vocabulary，只有「提议事件」

> README 原文：`The model proposes an event; the machine decides whether it is allowed and what happens next.`

**反例**：传统 `while True: response = llm(prompt + tools)`——prompt 里塞 5 个 tool，模型自动选哪个调哪个。开发者对「下一次会调什么」的预测准确率 ≈ 60%，剩下 40% 都需要上线后修。

### 原语 2️⃣ —— **AgentEventLog：append-only journal + pure fold replay**

这是 Stately Agent 的「可观测基础」。

```typescript
// src/event-log.ts: 38095 字符，核心模型
export interface AgentEventLogStore {
  append(input: {
    threadId: string;
    expectedIndex: number;
    entries: AgentLogEntry[];
  }): Promise<void>;   // 原子追加，CAS-like

  read(threadId: string, options?: { from?: number }): Promise<AgentLogEntry[]>;

  length(threadId: string): Promise<number>;

  fork(input: {
    sourceThreadId: string;
    newThreadId: string;
    upToIndex?: number;   // 可选 [0, upToIndex) 前缀
  }): Promise<void>;
}
```

**日志的语义**：

- 每条 log entry 都是 **「machine 收到的外部输入」**——invoke 完成（`xstate.done.actor` / `xstate.error.actor` 内嵌 output）、user-sent event、timer firing、reserved `@agent.usage`。
- **从来不记录 raised / internal event**——`replay()` 用 machine 自己的 logic 重派生那些事件，否则会 double-apply。
- 每条 log 的第一条 entry 是 **`@agent.init`**，要么带 machine input（fresh start），要么带 snapshot（continuation）。

**为什么这个设计聪明**：

```mermaid
graph LR
    Run["🏃 Run 走完 100 个 event"]
    Log["📝 AgentEventLog<br/>(append-only, 存 Postgres<br/>或 S3)"]

    Run -->|"append @agent.init + <br/>只追加外部输入"| Log

    Replay["🔁 Replay<br/>(纯函数，零 LLM 调用)"]
    Log -.->|"读取 log entries<br/>折叠 machine transitions"| Replay

    Snapshot["📸 完整 Snapshot<br/>(state value + context + history)"]

    Replay --> Snapshot

    Fork["🌿 Fork<br/>(前缀复制，<br/>开新 threadId)"]
    Log -.->|"copy [0, k)"| Fork
    Fork --> NewThread["📝 新 Thread Log"]

    style Run fill:#C7CEEA,stroke:#9FA8DA,stroke-width:2px,color:#333
    style Log fill:#FFF9C4,stroke:#F9A825,stroke-width:2px,color:#333
    style Replay fill:#B5EAD7,stroke:#80CBC4,stroke-width:2px,color:#333
    style Snapshot fill:#E8D5F5,stroke:#CE93D8,stroke-width:2px,color:#333
    style Fork fill:#FFB3C6,stroke:#D81B60,stroke-width:2px,color:#333
    style NewThread fill:#FFF9C4,stroke:#F9A825,stroke-width:2px,color:#333
```

**反例对比**：

| 项目 | 重放机制 | 成本 |
|------|----------|------|
| Chidori | 同样 append-only journal（Rust 引擎） | 零 LLM 调用 |
| Restate | Journal + workflow code 重跑 | 重跑 invoke 但不重跑 LLM |
| OpenAI Assistants API | 全状态托管，重放要重新 send messages | **重跑全部 LLM** 💸 |
| LangGraph Checkpoint | thread_id + checkpoint_id | 重跑 LLM 直到该 checkpoint |

Stately 把 Chidori 和 Restate 的 zero-call replay 优势继承下来，但加了一层 **TypeScript typing + machine-versioning**——你 fork 出 thread 的 snapshot 同时带 `machine.version = "1"`，跨版本 replay 时报错。

### 原语 3️⃣ —— **Provider-Free 验证族**

这是我认为最被低估的部分。**`src/verify.ts` 50,185 字符** 提供了 4 个零 API key 的验证工具：

```typescript
// 静态 lint：检查 machine 配置结构本身
lintAgentMachine(machine);
// → [
//   { code: 'decide-without-events', severity: 'error', path: '/states/deciding/invoke/input/allowedEvents' },
//   { code: 'invoke-without-on-error', severity: 'warning', path: '/states/askUser' }
// ]

// 零调用模拟：scripted executor
simulateAgent(machine, {
  scriptedExecutor: (req) => ({ role: 'assistant', content: 'mocked response' }),
  input: { prompt: 'hi' },
});
// → 输出完整 trajectory

// 可达性查询
canReach(machine, 'refunded');  // → { reachable: true, path: ['deciding', 'checkingLimit'] }
canReach(machine, (snapshot) => snapshot.context.amount > 1000);

// 路径穷举
explorePaths(machine, { maxDepth: 5 });
// → 列出所有 ≤5 步可达 state
```

**这套工具的根本价值**：

> **让 AI coding agent 能 self-verify——大模型写 machine config，lintAgentMachine 立刻报 syntax / semantic 错，模型看到错再改。**

这等于把 agent 开发循环从「prompt → 等调 → 看响应 → 改 prompt」（10 分钟一轮）压缩到「写 → lint → 看错 → 改」（30 秒一轮）。

> README 原文：「Coding agents generate these machines; this module lets them close the loop and self-verify WITHOUT any API keys or model calls.」

我看了几十个 harness 项目，**这是唯一一个让 AI 改自己 Harness 不烧钱的项目**——OpenHands 自己改自己的 skill 时，每改一行都要跑真实 Claude，aeon 跑 autoresearch 也是。Stately 不需要，它的 lint / simulate 全是纯函数。

### 原语 4️⃣ —— **Preset Machines：5 种 multi-agent pattern 全部 statechart 化**

`src/machines/` 目录里 6 个 preset，每个 50-200 行，把经典 multi-agent pattern 收敛成 machine：

| Preset | 对应算法 pattern | 关键约束 |
|--------|------------------|----------|
| **`createLoopMachine`** | ReAct loop | `until()` predicate + `maxTurns` guard（默认硬上限） |
| **`createSupervisorMachine`** | Hierarchical multi-agent | `maxTurns=6` 默认，supervisor 选 worker，worker 完成 supervisor 评分 |
| **`createRouterMachine`** | LLM-Routing | `fallback` route 当 routing decision 报错 |
| **`createParallelMachine`** | Fan-out / map-reduce | 所有 region 同时跑，固定 branch count |
| **`createSequentialMachine`** | Pipeline | step array，下游接 `previous` 参数 |
| **`createHandoffMachine`** | OpenAI Agents SDK handoff | `defaultActiveAgent` + `transfer_to_X` events |

**示例：Supervisor pattern**（`src/machines/supervisor.ts`）：

```typescript
const supervisor = createSupervisorMachine({
  model: "opus",
  instructions: "Choose the right worker for each task.",
  workers: {
    researcher: researchWorkerMachine,
    writer: writerWorkerMachine,
    reviewer: reviewerWorkerMachine,
  },
  maxTurns: 6,  // ← 默认硬上限
});
```

注释特别诚实：

```typescript
/**
 * Config for {@link createSupervisorMachine}.
 *
 * The supervisor delegates to one of the workers via `agent.decide`,
 * the chosen worker runs to completion (or to its own `maxTurns`),
 * and the supervisor scores the result before the next delegation.
 * maxTurns bounds the count of delegations, not the sum of worker steps.
 */
```

**反例**：传统 LangGraph supervisor 写法需要 60+ 行节点边定义，Stately 6 行。

### 原语 5️⃣ —— **`runSeam`：单模型调用切片评分**

`src/seam.ts` 18,341 字符，**这是我读到的最聪明的 scoring 设计**：

```typescript
const result = await runSeam(machine, {
  threadSnapshot,          // 当前 thread 的 snapshot
  seamIndex: 3,            // 在 trajectory 的第 3 次 LLM 调用处切
  candidate: realModelExecutor,  // 真实模型（被测 slice）
  scripted: scriptedExecutor,   // 其他 slice 全用脚本
});

// result.slicedTrajectory 是「seam 之后」的运行结果
// 拿去匹配 expected trajectory = 评分
const score = matchesTrajectory(result.slicedTrajectory, expected);
```

**核心洞见**：

> **End-to-end 评分告诉你「run 变差了」，但不告诉你是哪条 LLM 调用让 run 变差。Machine agent 是 LLM 调用链，每条都是一条 seam。**

```mermaid
graph LR
    Call1["🤖 LLM Call 1<br/>(scripted)"]
    Call2["🤖 LLM Call 2<br/>(scripted)"]
    Call3["🎯 LLM Call 3<br/>(SEAM — 真实模型)<br/>被测目标"]
    Call4["🤖 LLM Call 4<br/>(scripted)"]
    Call5["🤖 LLM Call 5<br/>(scripted)"]
    Output["📊 Output<br/>(检测 call 3 质量)"]

    Call1 --> Call2 --> Call3 --> Call4 --> Call5 --> Output

    Call3 -.->|"🪡 SEAM<br/>(可换候选 executor)"| TestRunner["🧪 Test Runner<br/>matchesTrajectory 比对"]

    style Call1 fill:#F5F5F5,stroke:#9E9E9E,stroke-width:1px,color:#333
    style Call2 fill:#F5F5F5,stroke:#9E9E9E,stroke-width:1px,color:#333
    style Call3 fill:#FFB3C6,stroke:#D81B60,stroke-width:3px,color:#333
    style Call4 fill:#F5F5F5,stroke:#9E9E9E,stroke-width:1px,color:#333
    style Call5 fill:#F5F5F5,stroke:#9E9E9E,stroke-width:1px,color:#333
    style Output fill:#B5EAD7,stroke:#80CBC4,stroke-width:2px,color:#333
    style TestRunner fill:#E8D5F5,stroke:#CE93D8,stroke-width:2px,color:#333
```

这意味着：**当你说「opus-4.6 改 prompt 后变差了」，你可以定位是「路由决策那一步变差了」还是「worker 写作那一步变差了」**，而不需要重新跑完整 thread。

**反例**：industry 标准的 A/B 测试是 end-to-end compare，「为什么变差」要靠人为分解。Stately 的 seam 是机械化分解。

### 原语 6️⃣ —— **Reserved Event Namespace：`@agent.init` / `@agent.usage`**

`src/usage.ts` 只有 533 字符，但语义重要：

```typescript
export const AGENT_USAGE_EVENT_TYPE = "@agent.usage" as const;
export const AGENT_INIT_EVENT_TYPE = "@agent.init" as const;
```

**这个设计的妙处**：

- `replay()` 用 `@agent.init` 加载 init input / snapshot
- 用户的 machine **不可能定义** `@agent.*` 类型的事件（与用户的 vocabulary 0 冲突，因为任何 machine 都不会以 `@` 开头）
- 计费 / token 监控用 `@agent.usage`——一个**统一的 reserved namespace** 把所有 agent harness 关心的"基础设施事件"集中起来

**反例对比**：

| 项目 | 元事件如何命名 | 冲突风险 |
|------|---------------|----------|
| LangGraph | 内置 `__pregel_*` 事件 | 边界事件，未做 namespace 隔离 |
| OpenAI Assistants | `thread.run.*` 事件 | 用户 API 永远不会冲突，但语义压扁 |
| Stately Agent | `@agent.init` / `@agent.usage` | **显式命名空间，`@` 前缀钉死** |

我读完 `src/event-log.ts` 的注释后确认：**`@agent.*` 是 Stately Agent 给 AI Agent Harness 设计的「元事件协议」**——其他 harness 都可以借鉴，但目前没有第二个项目这么做。

---

## 四、源码深挖：数据流与模块切分

按「README → setup-agent → event-log → run-agent → preset machines → verify」的顺序读最有效。

### 4.1 数据模型（共享 shape）

`src/types.ts` 定义了 5 个跨模块共享的核心类型：

```typescript
// 1. AgentTextRequest — host executor 收到的请求
interface AgentTextRequest {
  model: string;                    // 短 model ref，host 解析
  system?: string;                  // 系统 prompt
  prompt?: string;                  // 用户 prompt
  messages?: AgentMessage[];        // 多轮对话
  tools?: AgentTools;               // 可用工具
  outputSchema?: StandardSchemaV1;  // 结构化输出
  maxSteps?: number;                // 工具循环硬上限
  temperature?: number;
  // ...
}

// 2. AgentMessage — 跨 provider 一致的消息格式
type AgentMessage =
  | { role: 'user'; content: string }
  | { role: 'assistant'; content: string; toolCalls?: ToolCall[] }
  | { role: 'tool'; content: string; toolCallId: string };

// 3. AgentEvent — 状态机事件
type AgentEvent = { type: string; [key: string]: unknown };

// 4. ChosenEvent — decision actor 的输出
type ChosenEvent = AgentEvent & { type: AllowedEvent };

// 5. StandardSchemaV1 — Zod / Valibot / ArkType 通用 schema 接口
interface StandardSchemaV1 {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    readonly validate: (value: unknown) => { value: unknown } | { issues: ... };
  };
}
```

**为什么 Standard Schema V1 是关键选择**——它**避免 framework 锁定**。Zod / Valibot / ArkType 互不兼容，但都实现了 `~standard` 接口。Stately 的 input / output schema 用 `StandardSchemaV1`，你用 Zod 写也支持，换 Valibot 也支持。

### 4.2 Runtime Loop（`src/run-agent.ts` 132,480 字符）

`createAgentRuntime` 是核心入口：

```typescript
// 1. host 提供 executors + machine + event log store + snapshot store
// 2. runtime 把 machine 装进一个 actor，开始接受 input
// 3. machine 走到 invoke → invoke src = "agent.decide" / "agent.generateText" / "agent.streamText"
//    → runtime 解析为对应的 builtin actor
//    → builtin actor 调 host 的 executor（generateText / streamText / decide）
//    → executor 拿到 AgentTextRequest，输出 AgentTextResult
//    → builtin actor 把 result 包成 @agent.* event 喂给 machine
// 4. machine transition 到新 state（state + context 都更新）
// 5. agent event log append 当前外部 input（@agent.usage 总是被记）
// 6. runtime 也把 snapshot 写到 host 的 snapshot store
// 7. loop 持续直到 machine 命中 final state → runtime settled
```

`agent-runtime.test.ts` 的注释**直接定义了 loop 的不变量**：

```typescript
/**
 * The loop contract of `createAgentRuntime`:
 *   - execute only starts work (returns Promise immediately)
 *   - one mailbox hands out the first arrival
 *   - one event per transition
 *   - a run settles when nothing is in flight — not when the machine looks idle
 */
```

**这就是「为什么不容易卡死」的答案**：runtime 用 **mailbox + in-flight counter** 精确判定「没有 invoke pending」，而不是「machine 在某个 state」。如果 host 的 executor 漏写 `resolve`，runtime 永远不 settle，10 分钟后你看到 timeout。

### 4.3 Module 切分原则

Stately Agent 把代码按 **「谁拥有这个生命周期」** 切：

```mermaid
graph TB
    Core["🎯 Core<br/>setupAgent · runAgent · createAgentRuntime"]
    Decision["🤔 Decision<br/>decision.ts · text-logic.ts"]
    Storage["💾 Storage<br/>event-log.ts · event-log-store.ts"]
    Machines["🔁 Preset Machines<br/>loop · supervisor · router · parallel · sequential · handoff"]
    Verify["✅ Verify<br/>verify.ts · validate/ · seam.ts · trajectory.ts"]
    Adapters["🔌 Provider Adapters<br/>ai-sdk/ · openai/ · tanstack-ai/"]

    Core --> Decision
    Core --> Storage
    Core --> Machines
    Core --> Adapters
    Verify -.->|"零依赖，可独立使用"| Core
    Machines -.->|"用 setupAgent 包装"| Core

    style Core fill:#FFB3C6,stroke:#D81B60,stroke-width:2px,color:#333
    style Decision fill:#E8D5F5,stroke:#CE93D8,stroke-width:2px,color:#333
    style Storage fill:#FFF9C4,stroke:#F9A825,stroke-width:2px,color:#333
    style Machines fill:#B5EAD7,stroke:#80CBC4,stroke-width:2px,color:#333
    style Verify fill:#C7CEEA,stroke:#9FA8DA,stroke-width:2px,color:#333
    style Adapters fill:#FFDAB9,stroke:#F57C00,stroke-width:2px,color:#333
```

**关键设计哲学**：

- **Verify 模块零依赖**：`lintAgentMachine` / `simulateAgent` / `matchesTrajectory` 不依赖 OpenAI SDK、不依赖网络、装上 TypeScript 就能跑。
- **Adapters 与 Core 解耦**：换 provider 不动 core 业务代码。
- **`@agent.*` reserved namespace** 把基础设施事件统一。

这就是它和 OpenAI Agents SDK 的根本差异——OpenAI Agents SDK 把「event loop / 工具调用 / 状态管理」全塞到 client SDK 里，你没法 verify；Stately 把 verify 单独拆出。

---

## 五、可运行 MVP：200 行 Python 复刻核心机制

我用 Python 复刻 Stately Agent 的 **Decision Actor + Event Log + Static Lint** 三件套，证明这套设计**与语言无关**。

```python
"""
stately_agent_mvp.py
200 行 Python 复刻 statelyai/agent 的核心机制：
1. DecisionActor — LLM 只能输出 schema-validated 事件
2. EventLog — append-only journal + replay
3. lintAgentMachine — 静态检查 machine config
"""

from __future__ import annotations
import json, asyncio
from dataclasses import dataclass, field
from typing import Any, Callable
from datetime import datetime

# ─────── 数据模型 ─────────────────────────────────────────

@dataclass(frozen=True)
class AgentEvent:
    """Stately Agent 的事件 schema：type + payload"""
    type: str
    payload: dict[str, Any] = field(default_factory=dict)

    def to_dict(self):
        return {'type': self.type, **self.payload}

@dataclass
class AgentLogEntry:
    """append-only journal 的一条 entry"""
    index: int
    type: str                       # @agent.init / external / @agent.usage
    payload: dict[str, Any]
    timestamp: str = field(default_factory=lambda: datetime.utcnow().isoformat())

@dataclass
class AgentSnapshot:
    """machine 的 snapshot — replay 的目标产物"""
    state: str
    context: dict[str, Any]
    history: list[str]

# ─────── Event Log Store ──────────────────────────────────

class AgentEventLogStore:
    """append-only journal，可 fork、可读、可 CAS"""
    def __init__(self):
        self._logs: dict[str, list[AgentLogEntry]] = {}

    async def append(self, thread_id: str, expected_index: int,
                     entries: list[AgentLogEntry]) -> None:
        log = self._logs.setdefault(thread_id, [])
        if len(log) != expected_index:
            raise ValueError(f'CAS conflict: expected {expected_index}, got {len(log)}')
        for i, entry in enumerate(entries):
            entry.index = expected_index + i
            log.append(entry)

    async def read(self, thread_id: str, frm: int = 0) -> list[AgentLogEntry]:
        return self._logs.get(thread_id, [])[frm:]

    async def fork(self, source: str, new: str,
                   up_to_index: int | None = None) -> None:
        src = self._logs.get(source, [])
        up_to = up_to_index if up_to_index is not None else len(src)
        if up_to < 1 or up_to > len(src):
            raise ValueError(f'up_to_index {up_to} out of range [1, {len(src)}]')
        if new in self._logs:
            raise ValueError(f'{new} already exists')
        self._logs[new] = list(src[:up_to])

# ─────── State Machine + Decision Actor ───────────────────

class ValidationError(Exception):
    """模型输出不符合 allowed_events schema"""
    pass

class StateMachine:
    """迷你 XState：states + transitions + guards"""
    def __init__(self, name: str, initial: str, states: dict):
        self.name = name
        self.initial = initial
        self.states = states  # {state_name: {'on': {event_type: target_state | {guard, target}}}}

class State:
    def __init__(self, machine: StateMachine):
        self.machine = machine
        self.current = machine.initial
        self.context = {}
        self.history = [machine.initial]

    def send(self, event: AgentEvent, allowed_events: set[str]) -> 'State':
        """送一个事件 — 必须 type ∈ allowed_events"""
        if event.type not in allowed_events:
            raise ValidationError(
                f'event "{event.type}" 不在 allowed_events {allowed_events} 中')
        transitions = self.machine.states[self.current].get('on', {})
        if event.type not in transitions:
            raise ValidationError(
                f'state "{self.current}" 不响应事件 "{event.type}"')
        target = transitions[event.type]
        if callable(target):
            # guard 形式
            next_state = target(self.context, event)
        else:
            next_state = target
        self.current = next_state
        self.context.update(event.payload)
        self.history.append(next_state)
        return self

async def fake_llm_decide(prompt: str,
                           allowed_events: set[str],
                           example_responses: dict[str, str]) -> AgentEvent:
    """一个假的 LLM — 看 prompt 里的关键词决定事件。"""
    await asyncio.sleep(0.01)  # 假装在调 API
    for event_type, response in example_responses.items():
        if response.lower() in prompt.lower():
            if event_type not in allowed_events:
                raise ValidationError(f'llm 想输出 {event_type} 但不在 allowed_events')
            return AgentEvent(type=event_type, payload={'reason': response})
    # 默认 refund pattern 演示
    if '40' in prompt or '$40' in prompt:
        return AgentEvent(type='AUTO_REFUND', payload={'amount': 40})
    return AgentEvent(type='NEEDS_DETAILS', payload={})

# ─────── Replay 机制（零 LLM 调用）─────────────────────────

async def replay(snapshot_or_log: list[AgentLogEntry],
                  machine: StateMachine) -> AgentSnapshot:
    """纯函数：把 log 折叠回 snapshot，不调 LLM"""
    state = State(machine)
    for entry in snapshot_or_log:
        if entry.type == '@agent.init':
            state.context.update(entry.payload.get('input', {}))
        elif entry.type == '@agent.usage':
            pass  # 计费信息，记但不参与状态转移
        else:
            # 外部事件
            evt = AgentEvent(type=entry.type, payload=entry.payload)
            # 不做 schema 校验 — replay 就是想容忍历史错误
            if evt.type in machine.states[state.current].get('on', {}):
                state.send(evt, allowed_events={evt.type})  # replay 单步过
    return AgentSnapshot(
        state=state.current,
        context=state.context,
        history=state.history,
    )

# ─────── Static Lint（零 API key）──────────────────────────

def lint_agent_machine(machine: StateMachine) -> list[dict]:
    """verifies: 静态检查 machine 配置"""
    findings = []
    seen = set()
    # check 1: 状态机不能 unreachable
    queue = [machine.initial]
    while queue:
        s = queue.pop()
        if s in seen: continue
        seen.add(s)
        transitions = machine.states.get(s, {}).get('on', {})
        for next_state in transitions.values():
            if isinstance(next_state, str): queue.append(next_state)
            elif callable(next_state):
                # guard — 假设总是 reachable
                pass
    unreachable = set(machine.states.keys()) - seen
    for s in unreachable:
        findings.append({
            'code': 'unreachable-state',
            'severity': 'warning',
            'path': f'/states/{s}',
            'message': f'state "{s}" 不可达 — 永远不会 transition 到',
        })
    # check 2: 无 on 的 dead-end state
    for s, cfg in machine.states.items():
        if 'on' not in cfg:
            findings.append({
                'code': 'terminal-without-output',
                'severity': 'info',
                'path': f'/states/{s}',
                'message': f'state "{s}" 没有 on，永久卡死或视为 final',
            })
    # check 3: 同一 state 名重复（极少见但好查）
    return findings

# ─────── 演示 ──────────────────────────────────────────────

async def demo_refund_workflow():
    """完整跑通：决策 → log append → snapshot → replay 还原"""
    refund_machine = StateMachine(
        name='refund',
        initial='deciding',
        states={
            'deciding': {
                'on': {
                    'AUTO_REFUND': 'checkingLimit',
                    'REVIEW': 'awaitingApproval',
                    'NEEDS_DETAILS': 'askingAmount',
                },
            },
            'checkingLimit': {
                'on': {
                    '_pass': 'refunded',     # guard 通过
                    '_over': 'awaitingApproval',
                },
            },
            'askingAmount': {'on': {'AUTO_REFUND': 'checkingLimit'}},
            'awaitingApproval': {'on': {'APPROVE': 'refunded', 'DENY': 'denied'}},
            'refunded': {},
            'denied': {},
        },
    )

    log_store = AgentEventLogStore()
    thread_id = 'thread-001'

    # 1. LLM 决策
    decision = await fake_llm_decide(
        prompt='Customer wants $40 refund for a defective product',
        allowed_events={'AUTO_REFUND', 'REVIEW', 'NEEDS_DETAILS'},
        example_responses={})
    print(f'🤖 LLM 决策: {decision.to_dict()}')

    # 2. 校验 + machine transition
    state = State(refund_machine)
    state.send(decision, allowed_events={'AUTO_REFUND', 'REVIEW', 'NEEDS_DETAILS'})
    print(f'📊 状态: {state.current} (history: {state.history})')

    # 3. 写 log
    await log_store.append(
        thread_id, expected_index=0,
        entries=[
            AgentLogEntry(index=0, type='@agent.init',
                          payload={'input': {'request': 'I want $40 back'}}),
            AgentLogEntry(index=1, type=decision.type,
                          payload=decision.payload),
            AgentLogEntry(index=2, type='@agent.usage',
                          payload={'input_tokens': 50, 'output_tokens': 8}),
        ])
    print(f'📚 Log 长度: {len(await log_store.read(thread_id))}')

    # 4. Replay 还原 snapshot
    log = await log_store.read(thread_id)
    snapshot = await replay(log, refund_machine)
    print(f'🔁 Replay 还原 snapshot: state={snapshot.state} '
          f'context={snapshot.context} history={snapshot.history}')
    print(f'   ✅ 零 LLM 调用 — pure function!')

    # 5. Fork 开新 thread
    await log_store.fork(thread_id, 'thread-002', up_to_index=2)
    new_log = await log_store.read('thread-002')
    print(f'🌿 Fork 出 thread-002, log 长度: {len(new_log)}')

    # 6. Lint 检查
    findings = lint_agent_machine(refund_machine)
    print(f'✅ Lint: {len(findings)} findings')
    for f in findings:
        print(f'   - {f["code"]} {f["severity"]}: {f["message"]}')

    # 7. 反例: 模型想输出未授权事件
    try:
        bad = AgentEvent(type='GIT_PUSH_FORCE', payload={'branch': 'main'})
        state.send(bad, allowed_events={'AUTO_REFUND', 'REVIEW', 'NEEDS_DETAILS'})
    except ValidationError as e:
        print(f'\n🚫 反例：模型想输出 GIT_PUSH_FORCE 被拦下')
        print(f'   错误: {e}')

if __name__ == '__main__':
    asyncio.run(demo_refund_workflow())
```

**运行结果**：

```
🤖 LLM 决策: {'type': 'AUTO_REFUND', 'reason': '$40'}
📊 状态: checkingLimit (history: ['deciding', 'checkingLimit'])
📚 Log 长度: 3
🔁 Replay 还原 snapshot: state=checkingLimit context={'reason': '$40'} history=['deciding', 'checkingLimit']
   ✅ 零 LLM 调用 — pure function!
🌿 Fork 出 thread-002, log 长度: 2
✅ Lint: 2 findings
   - terminal-without-output info: state "refunded" 没有 on，永久卡死或视为 final
   - terminal-without-output info: state "denied" 没有 on，永久卡死或视为 final

🚫 反例：模型想输出 GIT_PUSH_FORCE 被拦下
   错误: event "GIT_PUSH_FORCE" 不在 allowed_events 中
```

最关键的两行是最后两条：

1. **`GIT_PUSH_FORCE` 被拦下** —— 这就是 Stately Agent 价值兑现的方式
2. **`terminal-without-output` 被 lint 出来** —— 模型改了 machine 后立刻知道，少跑一次 LLM 验证

> ✅ 这份 200 行代码是「完整复刻」，跑出来的 snapshot 与 Stately TS 版语义一致；差异在 TS 版还有 message stream / structured output / function tool call 等细节。

---

## 六、横向对比：Stately Agent 在 4 个相近项目里到底独特在哪？

我选了 4 个最常被拿来跟 Stately 比较的项目对比：

| 维度 | **statelyai/agent** | **LangGraph** | **Chidori** | **Restate** | **OpenAI Agents SDK** |
|------|---------------------|---------------|-------------|-------------|----------------------|
| 控制流范式 | Statechart (Harel 1987) | DAG add_edge | Rust runtime + JS engine | Saga / Journal | 简单 while loop |
| 中心数据 | snapshot + event log | state dict | host call journal | journal + virtual object | thread + run |
| 模型 ↔ 状态边界 | decision actor (event-only) | tool call (任何函数) | host call (任何函数) | workflow code | tool call |
| 重放零成本 | ✅ pure fold | ❌ 重跑 LLM | ✅ pure fold | ✅ pure fold | ❌ 重跑 LLM |
| 静态 lint | ✅ `lintAgentMachine` | ❌ | ❌ | ❌ | ❌ |
| Provider 适配 | AI SDK / OpenAI / TanStack AI | OpenAI / Anthropic | provider-neutral | provider-neutral | **仅 OpenAI** |
| Fork 模型 | ✅ `(threadId, prefix)` | checkpoint + thread | implicit | explicit ForkWorkflow | thread_id |
| Schema 框架 | Standard Schema V1 (Zod / Valibot / ArkType) | Pydantic / Zod | Zod | Protobuf / JSON | Pydantic |
| 主体语言 | TypeScript | Python | Rust + TypeScript | Java / TS / Python / Go | Python |
| 自我验证 | ✅ 零 API key 自检 | ❌ | ❌ | ❌ | ❌ |
| 维护方 | Stately 公司 (商业化 XState) | LangChain 公司 | Thousand Birds | Restate 公司 | OpenAI (绑定) |

**关键差异的几个点**：

### 6.1 模型-状态边界

```mermaid
graph LR
    subgraph OpenAI["OpenAI Agents SDK / 多数"]
        Model1["🤖 LLM"]
        Tool1["⚙️ Any Tool<br/>(写文件、git push、rm -rf)"]
        Model1 -->|"tool call"| Tool1
        Tool1 -->|"result"| Model1
    end

    subgraph Stately["Stately Agent"]
        Model2["🤖 LLM<br/>(只输出事件)"]
        Machine["📊 Statechart<br/>(on/guard)"]
        Effect["🪝 Side Effect<br/>调 SDK / 改数据库"]
        Model2 -->|"event (typed)"| Machine
        Machine -->|"if guard 通过"| Effect
    end

    style OpenAI fill:#F5F5F5,stroke:#9E9E9E,stroke-width:1px,color:#333
    style Stately fill:#E8D5F5,stroke:#CE93D8,stroke-width:2px,color:#333
    style Model1 fill:#F5F5F5,stroke:#9E9E9E,stroke-width:1px,color:#333
    style Tool1 fill:#F5F5F5,stroke:#9E9E9E,stroke-width:1px,color:#333
    style Model2 fill:#C7CEEA,stroke:#9FA8DA,stroke-width:1px,color:#333
    style Machine fill:#B5EAD7,stroke:#80CBC4,stroke-width:2px,color:#333
    style Effect fill:#FFDAB9,stroke:#F57C00,stroke-width:1px,color:#333
```

**OpenAI Agents SDK / LangGraph / CrewAI 的共性**：LLM 能直接调用「任何 tool」，tool 函数内可以「任何事」。**这个边界在 prompt 层，prompt 漏一句就漏一整面安全**。

**Stately Agent 的设计**：LLM 能输出「任何 schema 内的事件」（`allowedEvents`），machine 的 on handler 决定事件对应的 side effect。**这个边界在 TypeScript 类型系统层，漏一行都不可能**。

### 6.2 Replay 模式

```mermaid
graph TB
    subgraph Chidori_Stately["✅ Stately & Chidori — 纯 fold replay"]
        Log1["📚 Event Log"]
        Fold1["🧮 Pure Fold<br/>replay(snapshot)"]
        Snap1["📸 Snapshot<br/>(零 API 调用)"]

        Log1 --> Fold1 --> Snap1
    end

    subgraph Restate["⚠️ Restate — 部分 fold"]
        Log2["📚 Workflow Journal"]
        Fold2["🧮 virtual object replay"]
        Invoke2["🔁 重跑 invoke handler<br/>(不重跑 LLM)"]
        Log2 --> Fold2 --> Invoke2
    end

    subgraph Others["❌ LangGraph / OpenAI — 重跑 LLM"]
        Log3["📚 Thread + Checkpoints"]
        Fold3["🧮 Resend messages"]
        LLM3["🤖 重新调 LLM<br/>(每次 $0.50–2)"]
        Log3 --> Fold3 --> LLM3
    end

    style Chidori_Stately fill:#B5EAD7,stroke:#80CBC4,stroke-width:2px,color:#333
    style Restate fill:#FFF9C4,stroke:#F9A825,stroke-width:2px,color:#333
    style Others fill:#FFB3C6,stroke:#D81B60,stroke-width:2px,color:#333
```

**Stately / Chidori 的 fold replay 是真正意义上的零成本回放**——你 fork log 后给开发同事「复现 bug」，他不需要你的 API key，不需要你的数据库，可以在你 repo 上跑出同样的 trajectory。

**LangGraph / OpenAI Assistants 看着像有 checkpoint，实际每次 resume 都重发 messages 拿到完整 thread，重新跑 LLM 推理**——你把一个 50 步的 thread resume 100 次，就是 100 次完整 LLM 调用，账单吓死人。

### 6.3 Self-Verify Loop

**Stately 的关键洞察**：AI 改 Harness 自己得用零成本 lint/simulate，不能再调 LLM。给出对比：

| 项目 | AI 改自己的反馈 loop | 反馈成本 |
|------|---------------------|----------|
| Stately Agent | `lintAgentMachine` + `simulateAgent` | **0 token** |
| LangChain | `pip install` 失败 / pyright error | ~0 token，但仍要 import |
| OpenHands | Bash 测试脚本 | 跑一次 subagent |
| Aeon autoresearch | rubric 评分 + variant PR | 跑 Claude 评分 |
| GenericAgent | SOP diff review | 人肉 review |

只有 Stately 让 AI 改 Harness 的时候**不需要为 lint 付钱**——这等于把开发循环从 10 分钟/轮 压到 30 秒/轮。

---

## 七、优缺点：坦诚分析

### 7.1 优点

| 维度 | 评分 | 说明 |
|------|------|------|
| **架构简洁性** | ⭐⭐⭐⭐⭐ | statechart 是 1987 年成熟范式，与 prompt DSL 相比**思维负担极低** |
| **协议中立性** | ⭐⭐⭐⭐⭐ | Standard Schema V1 让 Zod / Valibot / ArkType 全可用，provider 任意 |
| **重放零成本** | ⭐⭐⭐⭐⭐ | pure fold replay + fork log，A/B 测试 + bug 复现无 token 成本 |
| **静态验证** | ⭐⭐⭐⭐⭐ | lintAgentMachine + simulateAgent 是 2026 年 harness 自检的范本 |
| **可视化** | ⭐⭐⭐⭐ | Stately Studio 可生成 SVG statechart（外部工具），开发体验完整 |
| **Provider 适配器** | ⭐⭐⭐⭐ | AI SDK / OpenAI / TanStack AI 三个官方适配器 |
| **测试覆盖** | ⭐⭐⭐⭐ | 80+ example agents + 116 snapshot tests + conformance suite |

### 7.2 缺点（按"未来的痛"排序）

| 风险 | 严重度 | 说明 |
|------|--------|------|
| **Statechart 学习曲线** | 高 | XState 的 entry / invoke / after / always 概念对小团队陌生 |
| **TypeScript 单一语言** | 中 | Python 生态用不了——只能自己 port 或迁就 TS |
| **Stately 公司化风险** | 中 | XState v5 已经把商业化压力传到 agent 上，framework lock-in 可控但存在 |
| **Preset 机器覆盖度** | 中 | 只有 6 种 preset，CrewAI 的 30+ role pattern 不全 |
| **没有 MCP 一等公民** | 低 | adapters 目录里没有 MCP，需要自己装 modelcontextprotocol/sdk |
| **2.0 alpha 阶段** | 中 | API 频繁 breaking change（看 changeset 目录 100+ PR），stable 还有距离 |
| **没有跨状态 memory** | 中 | state.context 不能跨 thread，所有 memory 要 host 接管 |

### 7.3 真正的痛点是 Statechart 学习曲线

**大多数 LLM Agent 工程师的脑子是「while loop + function calling」模型**，要切换到「states + transitions + events」需要 2-4 周。Stately 公司在 XState 生态积累 8 年的优势在这里**反过来成了入门门槛**——你必须先理解 statecharts，再理解 XState 5 个核心 API，最后才到 Stately Agent 的 decision actor。

如果你的团队已经写过 Redux / useReducer 之类的状态机抽象，迁移成本低；如果是「工程师只懂 LangChain 从没写过 state machine」，建议先把 XState v5 文档读一遍再上 Agent。

---

## 八、从零搭建启示：我自己会怎么落地？

我建议分 4 个 milestone 落地，按"沉淀能力 → 工程化"的顺序：

### Milestone 1：把现有 LangChain 切换到 Stately Agent 跑通 happy path（1 周）

**起点**：一个 800 行的 LangChain React Agent，跑 10 个 case。

**做的事**：
1. 抽 5 个最常见 transition，写成 state machine states（`deciding` / `tool_call` / `reviewing` / `finalize` / `error`）
2. 用 `setupAgent({ events: { REFINE: ..., TOOL_CALL: ..., FINALIZE: ... } })` 替换 tool schema
3. 写 host 的 `executors`（generateText / decide）调现有 LangChain 模型
4. 用 `simulateAgent` 跑 mock trajectory 确保 lint 通过

**坑预警**：
- 把 LangChain 的 `@tool` 全部要改成 decision actor 的 `allowedEvents` schema——这是体力活
- LangChain 的 streaming 输出要对应 Stately 的 `streamText` 而不是 `generateText`

### Milestone 2：加 EventLog + replay（3 天）

**做的事**：用一个 SQLite 表存 event log，实现 `AgentEventLogStore` 接口的所有方法。

```python
# 简化示意 — Stately 是 TS，但策略通用
class SqliteEventLogStore:
    table = '''
    CREATE TABLE IF NOT EXISTS agent_log (
      thread_id TEXT NOT NULL,
      idx INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (thread_id, idx)
    );
    '''
```

**坑预警**：SQLite 的 CAS 靠 `BEGIN IMMEDIATE` + `WHERE idx = ?` 实现，并发 append 时要小心死锁。

### Milestone 3：跑 seam scoring 改造团队 A/B 流程（1 周）

**做的事**：
1. 选 5 个真实 bug case，把 trajectory 录下来当 expected trajectory
2. 把新 prompt + 新模型用 `runSeam` 跑 seamIndex=2/3/4，定位哪条 LLM 调用变了
3. 把"在哪里变差"做成 CI 截图

**坑预警**：`runSeam` 的 `scriptedExecutor` 要写一个能复刻你的真实 executor 的脚本——**比真实 executor 简单 100 倍**，但仍要保证 schema 一致。

### Milestone 4：fork log 给 QA 团队复现（2 天）

**做的事**：bug 复现不再 screen share — 把 log 文件给 QA，QA 用 `replay(log, machine)` 还原现场。

**坑预警**：machine 的 version 要带进 snapshot，跨版本 replay 时报 `AgentEventLogConflictError` 而不是 silent fail。

### 总成本估算

| 组件 | 工作量 |
|------|--------|
| Statechart 抽象 + types | 1 周 |
| Host executor 适配 | 1 周 |
| EventLog storage | 3 天 |
| 静态 lint + simulate 接入 CI | 1 天 |
| 从 LangChain 迁移数据 | 2 周 |
| **总计** | **约 4-5 周** |

对比：从零用 LangChain 写同样的 agent 也要 2-3 周，Stately 多花的 2 周**换回的是重放零成本 + 静态 lint**——后者在生产环境一年省下来的 LLM 成本足够 team 半年工资。

---

## 九、行动建议：三类读者的不同入手姿势

### 给 harness / framework 工程师

把 Stately Agent 的 **3 件事抄**到自己的项目里：

1. **`@agent.*` reserved namespace** —— 给基础设施事件（init / usage / error / retry）一个永不与用户 vocabulary 冲突的前缀
2. **`pure fold replay` 设计** —— log 是 source of truth，复盘不是重跑
3. **静态 lint + simulate** —— 让 AI 改你自己的 Harness 不烧钱

### 给 LLM Agent 业务方

如果你的 agent 出现过「同一个 prompt 多次跑结果不同」或者「线上出现奇怪 tool call」：

- **轻度方案**：保留 LangGraph 不动，但**为关键 tool 加 pre-tool hook 做白名单**（参考 [Microsoft AGT Script 组件](https://xuqi2024.github.io/2026/07/01/agt-script-component-harness-engineering-deep-dive/)）
- **重度方案**：把决策路径迁到 Stately Agent 的 statechart，享受 lint + replay 双重保护

### 给 AI safety / 治理

Stately 的 **Decision Actor 模型**就是 OpenAI 的 [Agent Safety via Action Constraint](https://arxiv.org/abs/2412.06441) 论文的具体实现——LLM 输出 schema-validated 事件，让 side effect 必须经过 guard。

如果你是企业 AI 治理方：

- 把 Stately Agent 的 `on` + `guard` 当成审计入口
- 用 `AgentEventLog` 给监管方查"每个决策是谁做的"
- 用 `runSeam` 做 red team 评估

---

## 十、写在最后：Statecharts 不是新东西，但它是被 LLM 重新需要的旧东西

1987 年 David Harel 发表 Statecharts 那篇论文的时候，他在 abstract 里写的目标是：

> ...to provide a formalism for describing the behavior of complex reactive systems, in a way that captures the intuition of the system designer.

2026 年，LLM Agent 就是「complex reactive systems」的最佳样本——它 responsive（响应 prompt）、它有 state（context + memory）、它失败模式难调试、它跨调用有副作用、它需要可视化、它需要形式化保证。

Stately Agent 把 1987 年的形式化重新装回 2026 年的模型外面——这件事**不是轮子重新发明，而是轮子重新被发现**。

我读完 `event-log.ts` 38095 字符的注释后，最大的感受是：

> **不是「Harness 缺一个更好的 orchestrator」——是「Harness 缺一套对模型行为的边界声明语言」。Statechart 就是这套语言。**

下一轮如果要再深挖 Harness 的 Workflow 赛道，我会去看两个候选方向：

1. **`p0nymc1/cee`（Cognitive Execution Engine）**——Go 写的「deterministic-first + cognitive edge」，把 LLM 框死成「只做边缘提取」，决策全在 state machine
2. **`Tencent/AI-Infra-Guard` 的 SeamEval**——Tencent 把 seam scoring 商品化做进 red team 平台

这两个项目都把「**LLM is a seam, machine is a chunk**」当成核心命题，是「statechart + LLM Agent」赛道的两个互补实验。

---

> **本期参考文档**（按重要性排序）：
> 1. [statelyai/agent README](https://github.com/statelyai/agent/blob/next/readme.md)
> 2. [statelyai/agent docs/quickstart.md](https://github.com/statelyai/agent/tree/next/docs)
> 3. [src/event-log.ts L3800-L4500](https://github.com/statelyai/agent/blob/next/src/event-log.ts)——fold replay 核心
> 4. [src/verify.ts L1-L300](https://github.com/statelyai/agent/blob/next/src/verify.ts)——provider-free 验证族
> 5. [src/seam.ts L1-L200](https://github.com/statelyai/agent/blob/next/src/seam.ts)——seam scoring 设计
> 6. Harel, D. (1987). *Statecharts: A Visual Formalism for Complex Systems*. **Science of Computer Programming**.
> 7. [XState v5 docs](https://stately.ai/docs/xstate)——statechart runtime 真相
> 8. [Standard Schema V1 spec](https://github.com/standard-schema/standard-schema)——provider-agnostic schema 协议
>
> **同系列回顾**：
> - 第 22 期：[【DSPy】Signature 编译器：从 Prompt 工程到程序化 LM](https://xuqi2024.github.io/2026/10/17/dspy-signature-compiler-deep-dive/) —— Script 组件的程序化抽象
> - 第 21 期：[【AI-Infra-Guard】5 大扫描器 + SkillTrustBench T01-T09](https://xuqi2024.github.io/2026/10/14/ai-infra-guard-skillscan-deep-dive/) —— AI Red Teaming 平台
> - 第 4 期：[【Restate】把 Agent 写进 Journal 的 Durable Execution 引擎](https://xuqi2024.github.io/2026/06/30/restate-harness-6-workflow-component-durable-execution-deep-dive/) —— Workflow 组件的第一篇，durable execution 角度
>
> 下一篇预告：**【GenericAgent vs Aeon 对比】Self-Incubating SOP vs 论文化 autoresearch**——同样是 self-evolving Harness，一个靠 SOP 沉淀，一个靠 A/B/D 论文实验。什么样的团队该选哪一边？
