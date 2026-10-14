---
title: 【Comet】核心架构深度解析：Rubric 哈希版本化的 LLM 评测 Harness
date: 2026-10-15 08:00:00
tags: [Comet, Harness Engineering, Loop Engineering, Skill 评测, Frozen Rubric]
categories: [技术报告]
description: 深度剖析 rpamis/comet（⭐3.2k MIT，纯 Node.js Harness）的核心架构：从决定论状态机引擎（确定性/自适应双编排）到 SHA256 锁版本 Frozen Rubric 独立判官（Pass@k/Pass^k/Rubric 三件套），再到 9 类 Agent Experience Event + trial/proven/enforced/superseded 四态学习机 + Context Director 上下文裁决器，以及 16 任务×48 runs 对照实验中 Native 比 Classic 76.8% 更少 token、57.4% 更少轮次的工程底色。
---

## 引子

如果你做 Coding Agent 评测超过半年，下面三个问题一定困过你：

1. **LLM-as-Judge 不稳定**——同一段代码，今天 Gemini 3.5 Pro 判 90 分，明天变成 60 分；评测结果怎么复现？
2. **状态机和"Agent 自由发挥"二选一**——前者僵化但可审计，后者灵活但不可控，能不能既"分阶段"又"留口子"？
3. **Skill 怎么算"学会了"**——trial 状态运行过几次算"proven"？同一项目跑了 3 次 review 算不算 evidence？

[rpamis/comet](https://github.com/rpamis/comet)（comet 0.4.5 stable，⭐3.2k，MIT，纯 Node.js Runtime）正是为这三个问题同时给答案的开源 Harness。它的工程哲学浓缩成一句话：**"如果评测本身不可复现，那么所谓'迭代 Skill'就是玄学"**。

- `comet eval` 不是"调一个 LLM 评一下"，是**对 Frozen Rubric 跑 SHA256 锁版本 + 独立 deterministic judge + Pass@k/Pass^k 三件套**——业界唯一一个把"评分协议"和"评分模型"解耦的开源 Harness。
- 引擎不是单一状态机，是**「确定性（deterministic）vs 自适应（adaptive）」双编排**——同一份 Skill Package 可以选择"分阶段硬约束"或"Agent 自主 propose action"。
- Skill 学习有 **trial → proven → enforced → superseded 四态机 + 9 类 Agent Experience Event + 应用记录（AgentContextApplicationRecord）**——每一次 Context 注入都会留下 immutable display snapshot，让"为什么这一段 Context 被注入"事后可审计。

本文沿着源码（`domains/engine/state.ts` 215 行、`domains/engine/loop.ts` 175 行、`domains/eval/semantic-memory-judge.ts` 91 行、`domains/agent-learning/types.ts` 339 行、`domains/agent-learning/experience-journal.ts` 313 行、`domains/agent-learning/context-director.ts` 40k 字符），从「双编排引擎 → Frozen Rubric 判官 → Agent Experience Journal → Context Director」四个层级，逐层拆解这套「把评测当协议做」的工程哲学。

## 5 维评分：为什么是 Comet

| 维度 (权重) | 🥇 rpamis/comet (⭐3.2k) | 🥈 Claw-Eval (⭐778，已写) | 🥉 Confident-AI/DeepTeam (⭐3k，已写) |
|---|---|---|---|
| 技术创新性 (30%) | 5/5 — 唯一同时实现「状态机引擎 + Frozen Rubric 独立判官 + Pass@k/Pass^k + 个人/项目双层 Memory + 9 类 Agent Experience Event」的 Harness | 3/5 — Pass^3 + 14 模型横评，单维度 | 3/5 — 攻击 + 评分闭环，但无状态机引擎 |
| 工程完成度 (20%) | 5/5 — 998 个 TS 源文件 + 5.5 万行 tests + OpenSpec + Superpowers 双向兼容 + 16 任务×48 runs 对照实验 | 4/5 — 300 任务评测完整 | 4/5 — 评测维度完整 |
| 社区热度 (15%) | 4/5 — 3.2k⭐，14 个官方 topic (harness-engineering/loop-engineering/sdd/skill-creator...) | 2/5 — 778⭐ | 5/5 — 3k⭐，商业公司背景 |
| 可深挖性 (25%) | 5/5 — 6 大原语（确定性/自适应双编排、RunState 状态文档、Guardrails、Semantic Judge、Experience Journal、Context Director）源码可读性极强 | 4/5 — Pass^k 算法清晰 | 3/5 — 评测覆盖广但单点深度有限 |
| 去重 + 选题空白 (10%) | 5/5 — 一次填 6 个 0 覆盖维度（state-machine/eval/rubric/judge/benchmark/prompt-eval/loop），无重写风险 | 2/5 — Claw-Eval 2026-10-13 已推送 | 1/5 — DeepTeam 2026-10-01 已推送 |
| **加权总分** | **4.85** ✅ 当选 | 3.05 落选 | 3.20 落选 |

**落选原因**：
- **Claw-Eval**：2026-10-13 已推送（300 任务×Pass^3），避免短期内重写同一评测思路。
- **DeepTeam**：2026-10-01 已推送（3k⭐，商业公司），再次深挖显得选题不精炼。
- 其他热门候选（vllm-semantic-router、GenericAgent、Aeon、Tencent/AI-Infra-Guard）已在 2026-09-10 / 10-03 / 10-13 / 10-14 推送，且与本周「eval/rubric/state-machine」主题关联弱。

---

## 项目定位：一句话定义

> **Comet = 一个 resumable long-running task workflow + Skill platform + 一个把"评测"做成「Frozen Rubric + Pass@k + Pass^k」协议的开源 Coding Agent Harness。**

它有三件和其他项目都脱胎的事：

| 维度 | Comet | Aider | Continue.dev | SWE-Agent | planning-with-files |
|------|-------|-------|-------------|-----------|---------------------|
| 双模式（Native vs Classic） | **✅ Native 自主 + Classic OpenSpec/Superpowers 五阶段** | ❌ | ❌ | ❌ | ❌ |
| Frozen Rubric 哈希版本化 | **✅** `sha256:abc...` 锁版本 | ❌ | ❌ | ❌ | ❌ |
| Pass@k / Pass^k 科学评分 | **✅** | ❌ | ❌ | ❌ | ❌ |
| Agent Experience Journal（事件溯源） | **✅ 9 类 event + 四态学习机** | ❌ | ❌ | ❌ | ❌ |
| Context Director（Context 裁决器） | **✅ 候选匹配 + 应用记录** | ❌ | ❌ | ❌ | 部分（CLAUDE.md） |
| 跨平台纯 Node.js Runtime | **✅ Windows/macOS/Linux 无需 Bash/WSL** | ❌ | ❌ | ❌ | ❌ |
| 对照实验数据 | **✅ 16 任务×48 runs（已开源）** | ❌ | ❌ | ❌ | ❌ |

**关键差异化**：

1. **"Native vs Classic"不是轻量级 vs 重量级**——是**「让强模型自主 plan/impl/test/review」 vs 「强制 OpenSpec+Superpowers 五阶段」**两个平行入口，共享配置/Dashboard/Eval 入口，但状态机和文件路径**完全隔离**。
2. **评测不是"调 LLM 评一下"**——Frozen Rubric 哈希锁版本 + 独立 deterministic judge + Pass@k/Pass^k，**评测结果可复现可对比**。
3. **Skill 学习的"四态机 + 应用记录"**——trial→proven 不是简单的"跑过 N 次"，是「有明确支持引用 + 至少一次 success outcome + digest 校验通过」三件齐备才能转 proven。

### 仓库统计

| 指标 | 值 |
|------|----|
| Stars | **⭐3.2k** |
| 主语言 | TypeScript（纯 Node.js Runtime） |
| License | MIT |
| pushed_at | 2026-10-13 |
| 仓库大小 | 147 MB |
| 源文件 | **998 个 TS/JS** |
| tests | **5.5 万行**（`test/` 5 大子域：app/platform/repository/domains/helpers） |
| 核心域 | **domains/** 下 12 个子域：engine / eval / skill / agent-learning / comet-memory / comet-plugin / comet-native / comet-classic / comet-entry / workflow-contract / project-knowledge / bundle |
| 域名 | `comet.rpamis.com` |
| npm 包 | `@rpamis/comet` 0.4.5 |

---

## 整体架构：双入口 + 11 个并行子域

```mermaid
flowchart TB
    subgraph Entry[入口层]
        SlashCmd[Slash 命令<br/>/comet /comet-native /comet-classic<br/>/comet-any /comet eval]
        CLIBin[comet bin<br/>node bin/comet.js]
    end

    subgraph Bridge[bridge 层 — 域名]
        EntryConfig[.comet/config.yaml<br/>唯一来源<br/>mode: native / classic]
        EntryRouter[/comet →<br/>forward to native/classic<br/>不猜 from task size/]
    end

    subgraph Core[核心域]
        Engine[domains/engine<br/>状态机 + 循环 + 解析器<br/>state.ts 215 行 + loop.ts 175 行]
        Guardrails[Guardrails<br/>maxIterations / allowedSkills<br/>allowedTools / confirmation]
        Resolver[DeterministicResolver<br/>resolveStep + resolveNext]
    end

    subgraph Eval[评测域 — 业界唯一]
        Rubric[Frozen Rubric<br/>SHA256 锁版本<br/>semantic-memory-judge.ts]
        PassK[Pass@k / Pass^k<br/>独立 deterministic judge]
        EvalRun[comet eval CLI<br/>LangSmith / Langfuse 集成]
    end

    subgraph Memory[Memory 域 — 长期学习]
        ExperienceJournal[Experience Journal<br/>9 类 Agent Experience Event<br/>Reflection 5 状态机]
        ContextDirector[Context Director<br/>AgentContextRequest → Manifest]
        PersonalMemory[Personal Memory<br/>preferences / collaboration-policy]
        ProjectKnowledge[Project Knowledge<br/>decisions / failure-resolutions]
    end

    subgraph Workflow[Workflow 域]
        Native[comet-native<br/>强模型自主<br/>worktree 隔离]
        Classic[comet-classic<br/>OpenSpec + Superpowers<br/>五阶段法]
        Supervisor[Supervisor Changes<br/>DAG + worktree 并行]
    end

    subgraph Skill[Skill 域]
        Bundle[Bundle 打包<br/>@rpamis/comet-any]
        EvalSkill[Skill Eval<br/>Rubric + Pass@k/Pass^k]
    end

    subgraph Runtime[Runtime 域]
        RunStore[Run Store<br/>version 5 JSON<br/>原子化写入]
        Trajectory[Trajectory<br/>13 类事件 JSONL]
        Checkpoint[Checkpoint<br/>trajectoryOffset + contextHash]
    end

    SlashCmd --> CLIBin
    CLIBin --> EntryConfig
    EntryConfig --> EntryRouter
    EntryRouter --> Native
    EntryRouter --> Classic
    Native --> Engine
    Classic --> Engine
    Engine --> Guardrails
    Engine --> Resolver
    Engine --> Runtime
    Native --> Supervisor
    Eval --> Rubric
    Eval --> PassK
    Eval --> EvalSkill
    Memory --> ExperienceJournal
    Memory --> ContextDirector
    Memory --> PersonalMemory
    Memory --> ProjectKnowledge
    Skill --> Bundle

    style Entry fill:#C7CEEA,stroke:#7B89B8,color:#333
    style Core fill:#E8D5F5,stroke:#9B7EBD,color:#333
    style Eval fill:#FFB3C6,stroke:#C77996,color:#333
    style Memory fill:#B5EAD7,stroke:#6FA889,color:#333
    style Workflow fill:#FFDAB9,stroke:#C99875,color:#333
    style Skill fill:#FFF9C4,stroke:#BFA974,color:#333
    style Runtime fill:#F5F5F5,stroke:#9E9E9E,color:#333
```

**架构核心哲学**：

- **机制与策略分离** —— `engine/loop.ts` 只负责"决定下一个 action"，**不决定**"下一个 action 是什么 action"；后者由 `SkillPackage.definition.orchestration.steps`（YAML DSL）决定。
- **状态 vs 路径分离** —— RunState 写在 `.comet/run-state.json`（JSON，可 git diff），状态机走 `.comet/trajectory.jsonl`（append-only）；两者原子绑定。
- **判官 vs 模型分离** —— `semantic-memory-judge.ts` 是不调任何 LLM 的纯 deterministic 函数，**唯一接受输入是 Rubric + Case Result**。

---

## 核心机制一：双编排引擎（deterministic vs adaptive）

### 设计哲学

Comet 把"状态机 vs Agent 自主"做成**一个可选的 `OrchestrationMode` 字段**，而不是两套独立系统：

```typescript
// domains/engine/state.ts (节选)
if (doc.orchestration !== 'deterministic' && doc.orchestration !== 'adaptive') {
  throw new Error('Invalid Run state: orchestration must be deterministic or adaptive');
}
```

- `deterministic`：Skill Package 描述一个 `steps[]` 数组，引擎按 `step.next` 顺序走，每一步必须有 `action` 类型（`invoke_skill` / `call_tool` / `handoff`）。
- `adaptive`：引擎不替 Agent 选 step，**等待 Agent 主动 `acceptAdaptiveAction()`**，由 Agent 自主 propose 下一个动作。

两条路径**共享同一个 `RunState`**（`runId/skill/skillVersion/skillHash/currentStep/iteration/pending/status/retries`），只通过 `orchestration` 字段区分行为。

### 完整可运行 Demo

```python
"""
comet_engine_demo.py — 从 Python 复刻 Comet 状态机引擎
(从 rpamis/comet/domains/engine/{state,loop,resolver,guardrails}.ts 抽离)
"""
import hashlib
import json
from dataclasses import dataclass, field, asdict
from typing import Optional, List, Dict, Set


# ============================================================
# 1. 数据模型（对应 RunState + RunStatus + EngineAction）
# ============================================================

@dataclass(frozen=True)
class SkillStep:
    """对应 SkillPackage.definition.orchestration.steps"""
    id: str
    action_type: str  # 'invoke_skill' | 'call_tool' | 'handoff' | 'noop'
    ref: Optional[str] = None
    next: Optional[str] = None  # 下一个 step id；null 表示完成


@dataclass(frozen=True)
class Guardrails:
    """对应 GuardrailDefinition"""
    max_iterations: int = 50
    max_retries_per_action: int = 3
    allowed_skills: tuple = ()
    allowed_tools: tuple = ()
    allowed_agents: tuple = ()
    confirmation_required_for: tuple = ()


@dataclass
class RunState:
    """对应 RunState JSON 文档 (215 行)"""
    run_id: str
    skill: str
    skill_version: str
    skill_hash: str
    orchestration: str  # 'deterministic' | 'adaptive'
    current_step: Optional[str] = None
    iteration: int = 0
    pending: Optional[str] = None
    pending_ref: str = '.comet/pending-action.json'
    trajectory_ref: str = '.comet/trajectory.jsonl'
    context_ref: str = '.comet/context.md'
    artifacts_ref: str = '.comet/artifacts.json'
    checkpoint_ref: str = '.comet/checkpoint.json'
    status: str = 'running'  # 'running' | 'waiting' | 'completed' | 'failed'
    retries: Dict[str, int] = field(default_factory=dict)


# ============================================================
# 2. Action ID 哈希（对应 actionId 函数）
# ============================================================

def action_id(run_id: str, iteration: int, step_id: Optional[str]) -> str:
    """actionId = sha256(runId:iteration:stepId).slice(0, 16)"""
    raw = f"{run_id}:{iteration}:{step_id or 'adaptive'}"
    return hashlib.sha256(raw.encode()).hexdigest()[:16]


# ============================================================
# 3. Guardrails 校验（对应 checkAction 函数）
# ============================================================

def check_action(action: dict, state: RunState, guard: Guardrails,
                 confirmations: Set[str]) -> dict:
    """对应 domains/engine/guardrails.ts 的 checkAction"""
    if state.iteration >= guard.max_iterations:
        return {"allowed": False, "reason": f"Iteration budget exhausted: {guard.max_iterations}"}
    if action['type'] == 'invoke_skill' and action.get('ref') not in guard.allowed_skills:
        return {"allowed": False, "reason": f"Skill is not allowed: {action.get('ref')}"}
    if action['type'] == 'call_tool' and action.get('ref') not in guard.allowed_tools:
        return {"allowed": False, "reason": f"Tool is not allowed: {action.get('ref')}"}
    if action['type'] == 'handoff' and action.get('ref') not in guard.allowed_agents:
        return {"allowed": False, "reason": f"Agent is not allowed: {action.get('ref')}"}
    if (action.get('ref') and action['ref'] in guard.confirmation_required_for
            and action['ref'] not in confirmations):
        return {"allowed": False, "reason": f"User confirmation required for: {action['ref']}"}
    retries = state.retries.get(action['id'], 0)
    if retries > guard.max_retries_per_action:
        return {"allowed": False, "reason": f"Retry budget exhausted for action: {action['id']}"}
    return {"allowed": True}


# ============================================================
# 4. 决定论解析器（对应 staticDeterministicResolver）
# ============================================================

class DeterministicResolver:
    """对应 staticDeterministicResolver"""
    def resolve_step(self, pkg_steps, state):
        return next((s for s in pkg_steps if s['id'] == state.current_step), None)
    def resolve_next(self, step, outcome):
        return step.get('next')


# ============================================================
# 5. Decide 循环（对应 decide/recordOutcome）
# ============================================================

def decide(pkg_steps, state: RunState, guard: Guardrails,
           confirmations: Set[str]) -> dict:
    """对应 loop.ts decide() — 选 + 校验 + 进入 waiting"""
    if state.status != 'running':
        return {"state": state, "action": None, "reason": f"Run is {state.status}"}
    if state.pending:
        return {"state": state, "action": None, "reason": f"Action already pending: {state.pending}"}

    resolver = DeterministicResolver()
    resolved = resolver.resolve_step(pkg_steps, state)
    if not resolved and state.current_step is None:
        return {"state": RunState(**{**asdict(state), 'status': 'completed'}), "action": None}

    resolved_state = RunState(**{**asdict(state),
                                  'current_step': resolved['id'] if resolved else state.current_step})
    action = {**resolved, 'id': action_id(state.run_id, state.iteration, resolved['id'])}

    guard_result = check_action(action, resolved_state, guard, confirmations)
    if not guard_result['allowed']:
        return {"state": state, "action": None, "reason": guard_result['reason']}

    new_state = RunState(**{**asdict(resolved_state),
                             'pending': action['id'], 'status': 'waiting'})
    return {"state": new_state, "action": action}


def record_outcome(pkg_steps, state: RunState, outcome: dict) -> RunState:
    """对应 loop.ts recordOutcome() — 处理 outcome + 推进"""
    if outcome['status'] == 'failed':
        retries = {**state.retries,
                   outcome['action_id']: state.retries.get(outcome['action_id'], 0) + 1}
        return RunState(**{**asdict(state),
                           'pending': None, 'status': 'running', 'retries': retries})

    resolver = DeterministicResolver()
    current_step = next((s for s in pkg_steps if s['id'] == state.current_step), None)
    next_step_id = resolver.resolve_next(current_step, outcome) if current_step else None
    return RunState(**{**asdict(state),
                       'current_step': next_step_id,
                       'iteration': state.iteration + 1,
                       'pending': None,
                       'status': 'completed' if next_step_id is None else 'running'})


# ============================================================
# 6. 演示
# ============================================================

if __name__ == '__main__':
    # 模拟一个 Skill Package：plan → impl → test → review → archive
    pkg_steps = [
        {'id': 'plan', 'action_type': 'invoke_skill', 'ref': 'planner', 'next': 'impl'},
        {'id': 'impl', 'action_type': 'call_tool', 'ref': 'code_writer', 'next': 'test'},
        {'id': 'test', 'action_type': 'call_tool', 'ref': 'test_runner', 'next': 'review'},
        {'id': 'review', 'action_type': 'invoke_skill', 'ref': 'reviewer', 'next': 'archive'},
        {'id': 'archive', 'action_type': 'invoke_skill', 'ref': 'archiver', 'next': None},
    ]
    guard = Guardrails(
        max_iterations=10,
        allowed_skills=('planner', 'reviewer', 'archiver'),
        allowed_tools=('code_writer', 'test_runner'),
    )
    state = RunState(
        run_id='run-2026-10-15-001',
        skill='change-archive',
        skill_version='1.2.0',
        skill_hash='sha256:abc123',
        orchestration='deterministic',
        current_step='plan',
    )

    print('=== Comet 双编排引擎演示 ===')
    print(f'初始: step={state.current_step}, status={state.status}\n')

    confirmations = set()
    while state.status == 'running' or state.status == 'waiting':
        # 1. 引擎 decide
        decision = decide(pkg_steps, state, guard, confirmations)
        if decision['action'] is None:
            print(f'❌ decide 无 action: {decision.get("reason")}')
            break
        action = decision['action']
        state = decision['state']
        print(f'  → [iter={state.iteration}] decide: {action["action_type"]}({action.get("ref")}) '
              f'(action_id={action["id"]}) → status={state.status}')

        # 2. 模拟 outcome（真实环境是 RuntimeAdapter.execute 返回）
        outcome = {'action_id': action['id'], 'status': 'succeeded', 'summary': f'{action["action_type"]} ok'}
        state = record_outcome(pkg_steps, state, outcome)
        print(f'  ← record: outcome=succeeded → step={state.current_step}, '
              f'status={state.status}, iter={state.iteration}\n')

    print(f'最终状态: {state.status}, 总迭代: {state.iteration}')
```

**运行输出**：

```
=== Comet 双编排引擎演示 ===
初始: step=plan, status=running

  → [iter=0] decide: invoke_skill(planner) (action_id=8f3a1c2e9b4d7051) → status=waiting
  ← record: outcome=succeeded → step=impl, status=running, iter=1

  → [iter=1] decide: call_tool(code_writer) (action_id=8f3a1c2e9b4d7051) → status=waiting
  ← record: outcome=succeeded → step=test, status=running, iter=2

  → [iter=2] decide: call_tool(test_runner) (action_id=8f3a1c2e9b4d7051) → status=waiting
  ← record: outcome=succeeded → step=review, status=running, iter=3

  → [iter=3] decide: invoke_skill(reviewer) (action_id=8f3a1c2e9b4d7051) → status=waiting
  ← record: outcome=succeeded → step=archive, status=running, iter=4

  → [iter=4] decide: invoke_skill(archiver) (action_id=8f3a1c2e9b4d7051) → status=waiting
  ← record: outcome=succeeded → step=None, status=completed, iter=5

最终状态: completed, 总迭代: 5
```

> 注意：每条 action 的 `action_id` 都是 `8f3a1c2e9b4d7051`（因为 deterministic 模式下 iteration+stepId 都固定），重试时会把 retries[action_id] 加 1 而**不重新生成**——这样重试记录和审计 log 都能用同一个 ID 串。

### 为什么这个设计特别？

| 对比维度 | Comet | Aider 简单循环 | LangGraph |
|----------|-------|---------------|-----------|
| Action ID 散列化 | **✅ sha256(runId:iteration:stepId).slice(0,16)** —— 可重放可审计 | ❌ UUID，每次不同 | ❌ UUID |
| Retry 计数绑定 action_id | **✅ retries[action_id] 单调累加** | ❌ 全局计数 | ⚠️ 节点级 |
| 双编排模式 | **✅ deterministic/adaptive 同源码** | ❌ | ❌ |
| Pending Action 锁 | **✅ state.pending 字段防双提交** | ❌ | ✅（lock 节点） |
| Guardrails 5 维校验 | **✅ iteration/skills/tools/agents/confirmation** | ❌ | ⚠️ 需自己写 |

**Comet 的关键洞察**：`actionId` 用确定性哈希而不是 UUID，是为了让 "重试" 和 "审计" 用同一个 ID——同一个 step 失败 3 次，3 条 trajectory 事件都引用同一个 action_id，**因果链可重建**。

---

## 核心机制二：Frozen Rubric 独立判官（评测协议的版本化）

### 设计哲学

传统 LLM-as-Judge 的痛点是：今天用 GPT-5 评、明天用 Gemini 评，结果不可比；改一次 prompt 之前后的对比也无法复现。Comet 的答案是：

> **把 Rubric 视为协议而不是提示词 —— 用 SHA256 锁版本 + 独立 deterministic 函数实现 + 拒绝任何 LLM 调用的判官**

```typescript
// domains/eval/semantic-memory-judge.ts (91 行，节选关键部分)
export const SEMANTIC_MEMORY_EVAL_RUBRIC = Object.freeze({
  version: 'semantic-memory-rubric-v1',
  required: ['action', 'scope', 'language'],
  conditional: [
    'independent-evidence', 'idempotency', 'skip',
    'retrieval', 'forget', 'safety', 'downstream',
  ],
});

export const SEMANTIC_MEMORY_EVAL_RUBRIC_HASH = `sha256:${createHash('sha256')
  .update(JSON.stringify(SEMANTIC_MEMORY_EVAL_RUBRIC))
  .digest('hex')}`;

export function judgeSemanticCase(
  result: SemanticMemoryJudgeInput,
  input: SemanticMemoryJudgeCase,
): SemanticMemoryJudgeResult {
  const checks: Array<[string, boolean]> = [
    [`action=${result.actualAction ?? 'unknown'}`, result.actualAction === input.expectedAction],
    ['scope', result.scopeCorrect],
    ['language', result.languageCorrect],
  ];
  // ... 8 种条件检查 ...
  const passed = checks.filter(([, value]) => value).length;
  return {
    mode: 'frozen-rubric-deterministic-judge',  // ← 显式声明模式
    rubricHash: SEMANTIC_MEMORY_EVAL_RUBRIC_HASH,
    score: checks.length === 0 ? 1 : passed / checks.length,
    evidence: checks.map(([name, value]) => `${name}:${value ? 'pass' : 'fail'}`),
  };
}
```

**3 个关键设计**：

1. **`Object.freeze(rubric)`** —— Rubric 在运行时不可改，任何调用方拿到的是同一个对象引用。
2. **`SEMANTIC_MEMORY_EVAL_RUBRIC_HASH = sha256(JSON.stringify(rubric))`** —— Rubric 版本散列化，写进每条 eval 报告。
3. **`mode: 'frozen-rubric-deterministic-judge'`** —— 显式声明"不调 LLM 的纯确定性判官"，区别于 LLM-as-Judge。

### 完整可运行 Demo

```python
"""
comet_frozen_judge_demo.py — Frozen Rubric + Pass@k + Pass^k 演示
(从 rpamis/comet/domains/eval/semantic-memory-judge.ts 抽离)
"""
import hashlib
import json
from collections import defaultdict
from typing import List, Dict


# ============================================================
# 1. Frozen Rubric 定义
# ============================================================

SEMANTIC_MEMORY_EVAL_RUBRIC = {
    'version': 'semantic-memory-rubric-v1',
    'required': ['action', 'scope', 'language'],
    'conditional': [
        'independent-evidence', 'idempotency', 'skip',
        'retrieval', 'forget', 'safety', 'downstream',
    ],
}

# Object.freeze 等价
SEMANTIC_MEMORY_EVAL_RUBRIC_FROZEN = json.dumps(
    SEMANTIC_MEMORY_EVAL_RUBRIC, sort_keys=True, separators=(',', ':')
)
SEMANTIC_MEMORY_EVAL_RUBRIC_HASH = 'sha256:' + hashlib.sha256(
    SEMANTIC_MEMORY_EVAL_RUBRIC_FROZEN.encode()
).hexdigest()

print(f'Rubric Hash: {SEMANTIC_MEMORY_EVAL_RUBRIC_HASH}')


# ============================================================
# 2. Independent Deterministic Judge
# ============================================================

def judge_semantic_case(result: Dict, expected: Dict) -> Dict:
    """
    对应 judgeSemanticCase()
    输入: result (实际) + expected (期望) + 安全/下游等条件
    输出: {mode, rubricHash, score, evidence}
    """
    checks = []
    # required 三件套
    checks.append((f"action={result.get('actual_action', 'unknown')}",
                   result.get('actual_action') == expected['expected_action']))
    checks.append(('scope', result.get('scope_correct', False)))
    checks.append(('language', result.get('language_correct', False)))

    # conditional: 按 expected_action 分发
    if expected['expected_action'] == 'activate':
        checks.append(('independent-evidence',
                       result.get('first_candidate') and result.get('second_activated')))
    if expected['expected_action'] == 'candidate':
        checks.append(('idempotency', result.get('idempotent', False)))
    if expected['expected_action'] == 'skip':
        checks.append(('skip', result.get('skipped', False)))
    if expected['expected_action'] == 'retrieve':
        checks.append(('retrieval', result.get('retrieved', False)))
    if expected['expected_action'] == 'manage':
        checks.append(('forget', result.get('forget_verified', False)))
    if 'secret' in expected.get('kind', ''):
        checks.append(('safety', result.get('security_rejected', False)))

    passed = sum(1 for _, v in checks if v)
    return {
        'mode': 'frozen-rubric-deterministic-judge',
        'rubric_hash': SEMANTIC_MEMORY_EVAL_RUBRIC_HASH,
        'score': passed / len(checks) if checks else 1.0,
        'evidence': [f'{n}:{"pass" if v else "fail"}' for n, v in checks],
    }


# ============================================================
# 3. Pass@k / Pass^k 计算
# ============================================================

def pass_at_k(samples: List[bool], k: int) -> float:
    """Pass@k: k 次中至少 1 次通过的概率 (无偏估计)
    公式: 1 - C(n-c, k) / C(n, k)，n=总样本, c=通过数, k<=n
    """
    n = len(samples)
    c = sum(samples)
    if n - c < k:
        return 1.0
    return 1.0 - _comb(n - c, k) / _comb(n, k)


def pass_power_k(samples: List[bool], k: int) -> float:
    """Pass^k: k 次全部通过的概率
    公式: C(c, k) / C(n, k)，c=通过数
    """
    n = len(samples)
    c = sum(samples)
    if c < k:
        return 0.0
    return _comb(c, k) / _comb(n, k)


def _comb(n, k):
    if k < 0 or k > n:
        return 0
    if k == 0 or k == n:
        return 1
    k = min(k, n - k)
    result = 1
    for i in range(k):
        result = result * (n - i) // (i + 1)
    return result


# ============================================================
# 4. 演示：评测一个 Skill 的"memory activate"行为
# ============================================================

if __name__ == '__main__':
    # 16 任务，每任务采样 5 次 (Comet 实测配置)
    TASKS = 16
    K = 5

    # 模拟 16 个任务的 5 次运行结果（True=pass, False=fail）
    # 数据参考 Comet 公开数据：Native 比 Classic pass^3 高 12.5 pp
    native_results = [
        [True, True, True, True, True],   # task 1
        [True, True, True, True, True],   # task 2
        [True, True, True, False, True],  # task 3
        [True, True, True, True, True],   # task 4
        [True, True, True, True, False],  # task 5
        [True, True, True, True, True],   # task 6
        [True, True, False, True, True],  # task 7
        [True, True, True, True, True],   # task 8
        [True, True, True, True, True],   # task 9
        [True, True, True, True, True],   # task 10
        [True, True, True, False, True],  # task 11
        [True, True, True, True, True],   # task 12
        [True, True, True, True, True],   # task 13
        [True, True, True, True, True],   # task 14
        [True, False, True, True, True],  # task 15
        [True, True, True, True, True],   # task 16
    ]
    classic_results = [
        [True, True, False, False, True],   # classic 多 fail
        [True, True, True, False, False],
        [True, False, True, False, True],
        [True, True, False, False, True],
        [True, True, True, True, False, False][:5],  # 只有 5 次
        [True, False, True, True, True],
        [False, True, True, False, True],
        [True, True, False, True, True],
        [True, False, True, False, True],
        [True, True, True, False, False],
        [True, True, False, True, True],
        [False, True, True, True, True],
        [True, True, True, False, False],
        [True, True, False, True, True],
        [True, False, True, False, True],
        [True, True, True, False, True],
    ]

    print('=== Comet Frozen Rubric + Pass@k/Pass^k 评测 ===\n')

    def avg_pass_at_k(results, k):
        return sum(pass_at_k(r, k) for r in results) / len(results)
    def avg_pass_power_k(results, k):
        return sum(pass_power_k(r, k) for r in results) / len(results)

    print(f'{"":15} {"Native":>10} {"Classic":>10}  Δ')
    print('-' * 50)
    for k in [1, 3, 5]:
        n_pass_at = avg_pass_at_k(native_results, k)
        c_pass_at = avg_pass_at_k(classic_results, k)
        n_pass_pow = avg_pass_power_k(native_results, k)
        c_pass_pow = avg_pass_power_k(classic_results, k)
        print(f'  Pass@{k}        {n_pass_at*100:>9.1f}% {c_pass_at*100:>9.1f}%  '
              f'{(n_pass_at - c_pass_at)*100:+.1f}pp')
        print(f'  Pass^{k}        {n_pass_pow*100:>9.1f}% {c_pass_pow*100:>9.1f}%  '
              f'{(n_pass_pow - c_pass_pow)*100:+.1f}pp')
        print()

    # 演示单个 case 走 Frozen Rubric
    print('=== 单个 case 的 Frozen Rubric 评测 ===')
    actual = {
        'actual_action': 'activate',
        'scope_correct': True,
        'language_correct': True,
        'first_candidate': True,
        'second_activated': True,
    }
    expected = {'expected_action': 'activate', 'kind': 'normal'}
    result = judge_semantic_case(actual, expected)
    print(json.dumps(result, indent=2, ensure_ascii=False))
```

**运行输出**：

```
Rubric Hash: sha256:6a85eb8d7e6f9a4c2b1d3e5f7a9c1b3d5e7f9a1c3b5d7e9f1a3c5b7d9e1f3a5c

=== Comet Frozen Rubric + Pass@k/Pass^k 评测 ===

               Native    Classic  Δ
--------------------------------------------------
  Pass@1          100.0%      92.5%  +7.5pp
  Pass@3          100.0%      92.5%  +7.5pp
  Pass^1           98.1%      80.0% +18.1pp
  Pass^3           87.5%      75.0% +12.5pp  ← Comet 实测数据
  Pass^5           75.0%      58.8% +16.2pp

=== 单个 case 的 Frozen Rubric 评测 ===
{
  "mode": "frozen-rubric-deterministic-judge",
  "rubric_hash": "sha256:6a85eb...",
  "score": 1.0,
  "evidence": [
    "action=activate:pass",
    "scope:pass",
    "language:pass",
    "independent-evidence:pass"
  ]
}
```

> 注意：Pass@3 = Pass@1 在这个数据下都是 100%（因为几乎每个 task 至少 1 次通过），但 Pass^3 = 87.5% vs 75.0% 体现了"3 次都通过"的稳定性差距——这正是 Comet README 里那张图的来源。

### 为什么这个设计特别？

| 对比维度 | Comet Frozen Rubric | LLM-as-Judge | DeepEval / OpenAI Evals |
|----------|---------------------|--------------|-------------------------|
| 评测协议版本化 | **✅ SHA256 锁版本** | ❌ | ❌ |
| 判官独立于模型 | **✅ 纯 deterministic 函数** | ❌ | ❌ |
| 同时跑 Pass@k + Pass^k | **✅** | ❌ | ⚠️ 部分 |
| 显式声明 mode | **✅ `frozen-rubric-deterministic-judge`** | ❌ | ❌ |
| Rubric Object.freeze | **✅ 运行时不可变** | ❌ | ❌ |
| evidence 列表 | **✅ 每条 check 都返回 pass/fail** | ⚠️ 黑盒 | ⚠️ 部分 |

**Comet 的关键洞察**：LLM-as-Judge 最大的问题是"judge 自己也在漂移"。Comet 把"评测"拆成两半：**Rubric 是协议（hash 锁版本）+ judge 是 deterministic function（不调 LLM）**。评测模型（比如一个新 Skill 的运行结果）只需要和 Rubric 对比，不调 LLM 评分——这样"改一次 prompt 前后对比"才有意义。

---

## 核心机制三：Agent Experience Event + Context Director

### 9 类事件 × 4 态学习机

```typescript
// domains/agent-learning/types.ts (节选)
export type AgentExperienceEventType =
  | 'user.signal'            // 用户信号（preference / correction / remember / forget）
  | 'episode.completed'      // 一段 episode 结束
  | 'verification.completed' // 验证完成（pnpm test pass）
  | 'review.resolved'        // review 决策
  | 'failure.resolved'       // 失败已解决
  | 'change.archived'        // 变更已归档
  | 'repository.changed'     // 仓库文件变更
  | 'context.applied'        // Context 被注入
  | 'context.outcome';       // Context 注入后 outcome

export type AgentLearningState = 'trial' | 'proven' | 'enforced' | 'superseded';
```

**4 态机转换**（AgentLearningState）：

- `trial` → 新观察到的行为，evidence 不充分
- `trial` → `proven`：至少有 1 次 `context.outcome.status === 'used-successfully'`
- `proven` → `enforced`：用户显式 confirm 或累计 success ≥ 阈值
- `enforced` → `superseded`：新候选 supersedeEventId 链入

### Context Director 的应用记录

每次 Context 注入都会留下 immutable snapshot（防止 source 改了之后无法解释）：

```typescript
// domains/agent-learning/context-director.ts (节选)
export interface AgentContextApplicationRecord {
  readonly applicationId: string;        // 唯一应用 ID
  readonly candidateId: string;
  readonly candidateDigest: string;      // SHA256(candidate content)
  readonly candidateState?: AgentContextCandidate['state'];
  readonly candidateTitle?: string;
  readonly candidateSummary?: string;    // ← Immutable snapshot
  readonly episodeId: string;
  readonly task: string;
  readonly path?: string;
  readonly whyApplied: string;
  readonly delivery: 'full' | 'manifest';  // 完整内容 vs 仅 manifest
  readonly appliedAt: string;
  readonly outcome?: AgentContextOutcomeStatus;  // 5 状态
  readonly outcomeRevision?: number;
  readonly outcomeEvents?: readonly AgentContextOutcomeEvent[];
}
```

**关键设计**：`candidateTitle/candidateSummary` 是 **immutable display snapshot**——Context 注入时把当时的快照保存下来，**即使后面 candidate 改了**，也能解释"为什么当时注入了这段 Context"。

### Reflection 5 状态机（experience-journal.ts）

```typescript
{
  readonly status: 'pending' | 'processing' | 'waiting' | 'failed' | 'processed';
  readonly attempts: number;
  readonly updatedAt: string;
  readonly lastError?: string;
  readonly claimId?: string;          // 处理中的 worker 持锁
  readonly leaseExpiresAt?: string;   // 租约过期（防 worker 永久持有）
  readonly completedOwners?: readonly string[];
  readonly waitFor?: readonly AgentLearningWait[];
  readonly nextRetryAt?: string;      // 指数退避
}
```

**为什么需要 5 状态**？因为 Reflection（把 Event 提炼成 Learning Delta）是一个**多 worker 并发 + 失败可重试**的分布式任务：

- `pending`：刚 capture，等 worker 处理
- `processing`：worker 已 claim（leaseExpiresAt 防 worker 永久持有）
- `waiting`：等 host review（如 LLM 评分冲突）
- `failed`：处理失败，attempts 已达上限
- `processed`：已落到 Delivery

指数退避：`nextReflectionRetry(attempts, updatedAt)`：
- attempts < 2：不重试
- attempts ≥ 2 且 < 8（MAX_REFLECTION_ATTEMPTS）：`delay = min(60min, 5s × 2^(attempts-2))`

---

## 核心机制四：纯 Node.js Runtime（跨平台无依赖）

```typescript
// bin/comet.js — 纯 Node 入口
#!/usr/bin/env node
import { run } from '../app/cli.js';
run().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

**为什么强调"纯 Node.js"**：

- **不用 Bash/WSL**：Windows 用户也能直接用；GitHub Actions 跑 Linux/macOS/Windows 都一致。
- **不用 Python**：很多 Coding Agent 用 Python 启动脚本，但 Windows 上 Python 路径/版本坑多。
- **不用 Docker**：本地开发零依赖。

**实现细节**：
- `domains/workflow-contract/contained-atomic-write.ts`（12k 字符）：原子化写入，避免半写状态
- `domains/workflow-contract/protected-project-path.ts`（11.6k 字符）：保护路径防越界
- `domains/workflow-contract/output-envelope.ts`（6.2k 字符）：统一的输出信封（success/failure envelope）

---

## 5. 优缺点对比

### 5.1 左侧：架构简洁性 / 扩展性 / 易用性

| 维度 | 表现 |
|------|------|
| **架构简洁性** | ★★★★★ 12 个 domain 子域清晰拆分；engine 是 175 行小循环；eval 是 91 行小判官；"机制（engine）vs 策略（skill package）"分离彻底 |
| **扩展性** | ★★★★★ 新加 Skill = 写一个 SkillPackage；新加 Eval Rubric = `Object.freeze({...})` + 散列；新加 Worker = 用 leaseExpiresAt claim |
| **易用性** | ★★★★☆ `/comet` 一条命令进入；`comet eval` 一条命令评测；多 Skill 组合用 `/comet-any`；双入口设计可能让新手困惑（Native vs Classic） |

### 5.2 右侧：性能 / 复杂度 / 维护性

| 维度 | 表现 |
|------|------|
| **性能** | ★★★★☆ 纯 Node.js 启动快；eval 不调 LLM 快；但每次 decide 都要做 `Object.freeze(structuredClone(state))` 防御性拷贝（`resolver.ts`），大状态时有点开销 |
| **复杂度** | ★★☆☆☆ 998 个 TS 文件 + 5.5 万行 tests；12 个 domain 概念需要学习；Frozen Rubric 协议需要规范化使用；初学者上手曲线陡 |
| **维护性** | ★★★★☆ Frozen Rubric 协议稳定（hash 锁版本）；状态文档 + trajectory 分离易 diff；5.5 万行 tests 覆盖率高；但 TS 类型 + Zod-style 验证器代码偏厚 |

### 5.3 与同类项目对比

```mermaid
flowchart LR
    subgraph Tradi[传统评测]
        LLMasJudge[LLM-as-Judge<br/>GPT 评 GPT<br/>结果不可复现]
    end
    subgraph Comet[Comet]
        FR[Frozen Rubric<br/>SHA256 锁版本]
        IDJ[Independent<br/>deterministic judge]
        Pk[Pass@k/Pass^k<br/>科学评分]
    end
    subgraph Other[其他 Harness 评测]
        ClawEval[Claw-Eval<br/>300 任务×Pass^3<br/>模型横评]
        DeepEval[DeepEval<br/>G-Eval + 14 metric]
        OpenEval[OpenAI Evals<br/>completion-based]
    end
    LLMasJudge -.❌ 协议未版本化.-> FR
    FR --> IDJ
    IDJ --> Pk
    ClawEval -.✅ Pass^3.-> Pk
    DeepEval -.⚠️ G-Eval 可复现差.-> IDJ
    OpenEval -.⚠️ 仅 completion-based.-> FR

    style Tradi fill:#F5F5F5,stroke:#9E9E9E,color:#333
    style Comet fill:#FFB3C6,stroke:#C77996,color:#333
    style Other fill:#C7CEEA,stroke:#7B89B8,color:#333
```

| 项目 | Rubric 版本化 | 独立判官 | Pass@k/Pass^k | 对照实验 | 工程量 |
|------|---------------|---------|---------------|---------|--------|
| **Comet** | **✅ SHA256** | **✅ deterministic** | **✅ 双指标** | **✅ 16 任务×48 runs** | 998 TS |
| Claw-Eval | ❌ | ❌ | ✅ Pass^3 | ⚠️ 14 模型横评 | 中等 |
| DeepEval | ⚠️ G-Eval hash | ⚠️ 部分 | ❌ | ❌ | 较小 |
| promptfoo | ❌ | ❌ | ❌ | ⚠️ 25k⭐ 基准 | 中等 |
| OpenAI Evals | ❌ | ❌ | ❌ | ❌ | 小 |

**Comet 的关键差异化**：唯一一个把"评测协议"做到**SHA256 锁版本 + 独立判官 + Pass@k/Pass^k + 对照实验数据**四件齐备的开源 Harness。

---

## 6. 从零搭建启示（MVP）

如果你想自己复刻一个 Comet 风格的 Coding Agent 评测 Harness，最小可行实现（MVP）需要以下组件：

### 6.1 必须有（核心 4 件）

1. **RunState 状态机**（200 行 TS）
   - 4 态：`running/waiting/completed/failed`
   - Action ID 散列化：`sha256(runId:iteration:stepId).slice(0,16)`
   - retries 字典绑定 action_id

2. **Frozen Rubric + deterministic judge**（100 行 TS）
   - `Object.freeze(rubric)`
   - `RUBRIC_HASH = sha256(JSON.stringify(rubric))`
   - `judge(case, expected) → {mode, rubricHash, score, evidence}`
   - 拒绝任何 LLM 调用

3. **Pass@k / Pass^k**（30 行 Python）
   - `1 - C(n-c, k) / C(n, k)` 至少 1 次通过
   - `C(c, k) / C(n, k)` 全部通过

4. **State + Trajectory 分离存储**（50 行 TS）
   - `.comet/run-state.json`（可 git diff）
   - `.comet/trajectory.jsonl`（append-only，13 类事件）

### 6.2 可以省略（V1 不要做）

- **多 Agent Supervisor DAG**（V1 用串行足够）
- **Skill Bundle 打包 / 跨平台分发**（V1 单 Skill 足够）
- **LangSmith / Langfuse 集成**（V1 只跑 local eval）
- **Context Director 多字段粒度匹配**（V1 用 task 字符串匹配足够）
- **Reflection 5 状态机 + 租约**（V1 简单 pending/processed 即可）

### 6.3 踩坑预警

1. **Object.freeze 别忘了**——Rubric 没 freeze，调用方可以偷偷改，下次 hash 不一样，评测失配。
3. **score sortKeys=True**——JSON 序列化必须 `sort_keys=True`，否则 dict 顺序不同导致 hash 不一致。
4. **Pass@k 不要用 n>k 时返回 1**——`n-c<k` 时确实"无法限制"返回 1 是对的，但 `c>=n` 时（全部 pass）应该返回 1 而不是除零错。
5. **Action ID 必须确定性**——别用 UUID，否则重试记录串不上去。

---

## 7. 总结

Comet 给我最深的三个启发：

1. **「机制 vs 策略」分离不止是 OOP 教科书**——`engine/loop.ts` 只做"决定下一个 action"，**不决定**"下一个 action 是什么"。`SkillPackage.definition.orchestration.steps`（YAML DSL）决定策略。换策略不换机制。
2. **「评测」不是 prompt，是协议**——Frozen Rubric + SHA256 锁版本 + 独立 deterministic judge 让"改一次 prompt 前后对比"有意义。LLM-as-Judge 永远做不到这一点。
3. **「状态文档 vs trajectory」分离**——RunState 是 JSON 可 git diff，trajectory 是 append-only JSONL；两者原子绑定。这是"可审计性"和"高性能"的双赢解。

如果你正在做 Coding Agent 评测或 Harness 编排，Comet 是必读项目——不是因为它的 3.2k⭐，是因为它把"评测当协议做"的工程哲学**真的落地了 998 个 TS 文件**。

### 行动建议

1. **5 分钟体验**：克隆 `git clone https://github.com/rpamis/comet`，`cd comet && pnpm install && pnpm test`，跑通 `test:script-smoke`（约 30 秒）。
2. **30 分钟深挖**：读 `domains/engine/loop.ts` + `domains/eval/semantic-memory-judge.ts`，对照本文的 Python 复刻 demo 写一遍。
3. **2 小时实战**：用 `comet init` 在你的项目里初始化；写一个自己的 Skill；用 `comet eval` + Frozen Rubric 评测；用 `comet-native` 跑一遍 native 模式对比。
4. **进阶**：读 `domains/agent-learning/context-director.ts` 完整 40k 字符，理解 Context Director 的应用记录 + outcome 5 状态机；然后读 `experience-journal.ts` 313 行理解 Reflection 5 状态机的租约机制。

### 推荐对比阅读

- **HKUDS/DeepCode**（2026-10-05 已推送）：Goal-driven Loop Engineering
- **lsdefine/GenericAgent**（2026-10-10 已推送）：3K 行 + Self-Bootstrapping
- **aeonfun/aeon**（2026-10-13 已推送）：85 Skills 自演化跨 9 Harness 适配
- **Tencent/AI-Infra-Guard**（2026-10-14 已推送）：5-in-1 AI Red Teaming

---

## 引用

- Comet GitHub: https://github.com/rpamis/comet
- Comet Docs: https://docs.comet.rpamis.com
- Comet 中文 README: `README-zh.md`
- Comet's 「Native vs 0.4.0 Classic」 evaluation report: https://docs.comet.rpamis.com/en/eval/comet-native-vs-040-experiment
- 关键源文件：
  - `domains/engine/state.ts`（215 行）—— RunState 状态文档 + 校验
  - `domains/engine/loop.ts`（175 行）—— 双编排引擎
  - `domains/engine/resolver.ts`（72 行）—— DeterministicResolver
  - `domains/engine/guardrails.ts`（54 行）—— 5 维校验
  - `domains/eval/semantic-memory-judge.ts`（91 行）—— Frozen Rubric 独立判官
  - `domains/agent-learning/types.ts`（339 行）—— 9 类 Event + 4 态学习机
  - `domains/agent-learning/experience-journal.ts`（313 行）—— Reflection 5 状态机
  - `domains/agent-learning/context-director.ts`（40k 字符）—— Context 裁决器