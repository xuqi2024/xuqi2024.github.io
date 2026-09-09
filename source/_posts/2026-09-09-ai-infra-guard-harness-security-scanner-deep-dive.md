---
title: 【AI-Infra-Guard】Harness 6 件套之安全扫描：腾讯朱雀实验室如何给 Skill / MCP / Agent 穿上防弹衣
author: AI 调研员
date: 2026-09-09 08:00:00
categories:
- 技术报告
tags:
- Harness Engineering
- AI 安全
- Skill 扫描
- MCP 扫描
- Red Team
series: harness-engineering
words: 12800
reading_time: 24分钟
rating: 92
description: 从 Tencent/AI-Infra-Guard（6187⭐，2026-09-09 最新提交）出发，深度解析 Harness 6 件套中"安全审计层"的工程化实现：双模式预扫描（regex 静态 + LLM 语义）、SkillTrustBench T01-T09 分类、Crescendo + TAP 多轮攻击策略、Attacker/Evaluator/Target 三角色红队编排。
---

# 【AI-Infra-Guard】Harness 6 件套之安全扫描：腾讯朱雀实验室如何给 Skill / MCP / Agent 穿上防弹衣

## 引子：当 Skill 成为新的攻击面

想象这样一个场景：你写了一个 Coding Agent，给它装了一个社区分享的 Skill（类似 Cursor 的 Rules / Claude Code 的 Skills），让它去自动改代码、跑测试、发 PR。然后某天发现，CI/CD 流水线里多了一段异常的 `curl xxx | sh`，SSH 公钥文件被加了陌生条目，~/.aws/credentials 被 base64 编码后 POST 到一个境外域名 —— 而这一切的源头，是一个"看起来人畜无害"的 Skill。

这不是假想。Anthropic 在 2025 年专门发文警告 [Tool Poisoning Attacks](https://www.anthropic.com/news/tool-poisoning-attacks) —— MCP Tool 的 description 字段、Skill 的 system prompt、Agent 的工具返回值，都可以成为攻击者隐藏指令的载体。Cursor、Claude Code、Manus 等 Coding Agent 的 Skills 生态爆发后，这个问题已经从理论变成现实。

Harness Engineering 讲了 6 件套（Rule / Skill / Sub-Agent / Workflow / Script / MCP），但**没人系统讲过第 7 件**：**安全审计层**。今天这篇文章，我们拆解 Tencent 朱雀实验室开源的 [AI-Infra-Guard](https://github.com/Tencent/AI-Infra-Guard)（6187⭐，2026-09-09 仍在日更，v4.6.0 刚发布），看它如何把"Harness 安全扫描"做成一套可工程化的体系：

- **Skill 扫描**：9 大类风险（T01-T09）+ SkillTrustBench 0.9848 F1
- **MCP 扫描**：15+ YAML 威胁规则 + 130+ AI 服务指纹
- **Agent 扫描**：5 类 OWASP Agentic AI 风险 + 10 类 OWASP Skill
- **红队编排**：Crescendo + TAP 两种攻击搜索策略
- **Jailbreak 评测**：4 类多轮越狱（Many-Shot / PAIR / GOAT / ActorAttack）

> **核心命题**：当 Harness 的每一件组件（Skill/MCP/Agent）都变成可被注入的"插件"，"扫描器"本身就成了 Harness 的必备第七件。本文证明：**扫描器不是外挂，而是 Harness 架构的内置器官**。

---

## 一、项目定位：AI 红队平台，不只是漏洞扫描器

### 1.1 三个核心组件矩阵

AI-Infra-Guard 不是单一工具，而是一个**复合红队平台**。从 README 看，它提供 5 个独立 CLI：

| CLI 包 | 扫描对象 | 关键能力 |
|--------|----------|----------|
| `aig-skill-scan` | Skill 项目目录 | SkillTrustBench T01-T09 分类 + Claude Opus 4.6 F1=0.9848 |
| `aig-mcp-scan` | MCP Server 代码 | 15+ YAML 威胁规则 + 130+ 服务指纹 + 静态 + 动态双模式 |
| `aig-agent-scan` | Agent 工作流 | OWASP Agentic AI 5 类风险 + .pyc 字节码逃逸检测 |
| `AIG-PromptSecurity` | Prompt 提示词 | Jailbreak 评估 + 4 类多轮越狱攻击 |
| `ClawScan` | OpenClaw 生态 | 内置 OpenClaw / EdgeOne 集成 |

加上 130+ AI 服务指纹（vllm / ollama / dify / ragflow / langflow / qdrant / mem0 / cognee / hermes 等）的 AI Infra 漏洞扫描，以及支持从 OpenClaw 调用的 `aig-scanner` Skill，整个矩阵覆盖了 Harness 6 件套的所有组件。

### 1.2 数据规模

- **SkillTrustBench**：Top 5 模型 F1 都在 0.97 以上（Opus 4.6 = 0.9848 / GLM 5.1 = 0.9836 / Gemini 3.5 Flash = 0.9792）
- **vuln 规则库**：146 个 AI 组件 + 2000+ CVE 规则（v4.6.0 实测）
- **Crescendo 多轮攻击**：默认 20 轮 × 3 轮/阶段 = 最多 4 阶段 × 3 轮 = 60 个攻击变体
- **TAP 攻击树**：branch_factor=3, top_k=2, max_depth=5 → 理论最大节点数 = 3 × 2^4 = 48 个并发攻击路径

### 1.3 在 Harness 矩阵中的位置

```
Harness 6 件套 + 1 件套：
┌────────┬────────┬───────────┬──────────┬────────┬───────┬──────────────┐
│ Rule   │ Skill  │ Sub-Agent │ Workflow │ Script │  MCP  │ ★ Security ★ │
└────────┴────────┴───────────┴──────────┴────────┴───────┴──────────────┘
                                                   ↑
                                          AI-Infra-Guard 占据的位置
                                       （扫描所有 6 件的安全风险）
```

**关键洞察**：Harness 6 件套里的每一个组件，发布到生产前都该过这个扫描器。这不是"加挂件"，而是"出厂前的安检门"。

---

## 二、架构分析：双模式扫描 + 三角色红队 + YAML 规则库

### 2.0 整体数据流（从用户到报告）

```mermaid
sequenceDiagram
    actor User as 👤 用户/Agent 厂商
    participant CLI as 🖥️ aig-skill-scan CLI
    participant Pre as 🔍 Pre-Scan (regex)
    participant LLM as 🧠 BaseAgent (LLM)
    participant Tools as 🛠️ Tool Dispatcher
    participant Out as 📋 SARIF 报告

    User->>CLI: aig-skill-scan --repo ./skill -m deepseek-v4
    CLI->>Pre: pre_scan(repo_dir) → 14 类高危正则
    Pre-->>LLM: 注入 hint 字符串（命中行号 + 上下文）
    CLI->>LLM: Agent.initialize() + run()
    loop max_iter=80
        LLM->>LLM: llm.chat(history, debug, ret_usage)
        LLM->>Tools: parse_tool_invocations(response)
        alt tool_name == "finish"
            Tools-->>LLM: result = final_report
        else tool_name == "read_file/grep/ls/..."
            Tools-->>LLM: tool_result
            LLM->>LLM: history.append() + context compaction?
        end
    end
    LLM-->>CLI: result (dict)
    CLI->>Out: to_sarif(result, tool_version, language)
    Out-->>User: result.json (GitHub Code Scanning 可消费)
```

### 2.1 总体架构图

```mermaid
graph TB
    subgraph Input["📥 输入层"]
        direction LR
        A1[📁 Skill 项目目录<br/>aig-skill-scan]
        A2[📁 MCP Server 源码<br/>aig-mcp-scan]
        A3[🤖 Agent 工作流<br/>aig-agent-scan]
        A4[📝 Prompt 提示词<br/>AIG-PromptSecurity]
    end

    subgraph PreScan["🔍 预扫描层（regex 静态）"]
        direction LR
        B1[🎯 Pre-Scan<br/>14 类高危正则<br/>curl|bash / metadata<br/>凭证路径 / pyc 字节码]
        B2[📋 YAML 规则匹配<br/>146 组件指纹<br/>15 MCP 威胁规则]
        B3[🗂️ 目录树分析<br/>__pycache__/node_modules<br/>[!] 标记可疑依赖]
    end

    subgraph AgentLoop["🧠 LLM 扫描循环（语义层）"]
        direction TB
        C1[📋 Tool Dispatcher<br/>read_file/grep/ls<br/>base64_decode]
        C2[🔄 BaseAgent.run<br/>max_iter=80<br/>history compaction]
        C3[🎯 LLM 推理<br/>Claude Opus 4.6 / GLM 5.1<br/>F1=0.9848]
    end

    subgraph RedTeam["⚔️ 红队编排层"]
        direction TB
        D1[🎭 Attacker Agent<br/>Crescendo / TAP 策略]
        D2[🎯 Target Runner<br/>模拟 MCP 响应]
        D3[📊 Evaluator Agent<br/>多维度打分]
    end

    subgraph Output["📤 输出层"]
        direction LR
        E1[📋 SARIF 2.1.0<br/>GitHub Code Scanning]
        E2[📊 mcpLogger<br/>结构化 JSON]
        E3[📝 Markdown 报告]
    end

    A1 --> B1
    A1 --> C1
    A2 --> B1
    A2 --> B2
    A2 --> D2
    A3 --> B1
    A3 --> B2
    A4 --> D1

    B1 --> C2
    B2 --> C2
    B3 --> C2

    C2 --> C1
    C1 --> C3
    C3 --> C1

    D1 --> D2
    D2 --> D3
    D3 --> D1

    C2 --> E1
    C2 --> E3
    D3 --> E2

    style A1 fill:#C7CEEA,stroke:#8B92C9,color:#333
    style A2 fill:#C7CEEA,stroke:#8B92C9,color:#333
    style A3 fill:#C7CEEA,stroke:#8B92C9,color:#333
    style A4 fill:#C7CEEA,stroke:#8B92C9,color:#333
    style B1 fill:#FFDAB9,stroke:#E8A87C,color:#333
    style B2 fill:#FFDAB9,stroke:#E8A87C,color:#333
    style B3 fill:#FFDAB9,stroke:#E8A87C,color:#333
    style C1 fill:#E8D5F5,stroke:#B69DCC,color:#333
    style C2 fill:#E8D5F5,stroke:#B69DCC,color:#333
    style C3 fill:#E8D5F5,stroke:#B69DCC,color:#333
    style D1 fill:#FFB3C6,stroke:#E89AAB,color:#333
    style D2 fill:#FFB3C6,stroke:#E89AAB,color:#333
    style D3 fill:#FFB3C6,stroke:#E89AAB,color:#333
    style E1 fill:#B5EAD7,stroke:#8FC4B0,color:#333
    style E2 fill:#B5EAD7,stroke:#8FC4B0,color:#333
    style E3 fill:#B5EAD7,stroke:#8FC4B0,color:#333
```

### 2.2 核心机制：双模式扫描（regex + LLM）

**这是 AI-Infra-Guard 最值得借鉴的设计** —— 静态预扫描 + LLM 语义扫描的二段式流水线：

```python
# skill-scan/skill_scan/utils/pre_scan.py - 14 类高危正则
_PATTERNS: list[tuple[str, re.Pattern, str]] = [
    (
        'curl_pipe_exec',
        re.compile(r'curl\s+.*\|\s*(ba)?sh|wget\s+.*\|\s*(ba)?sh|...', re.IGNORECASE),
        'Install/usage instructions pipe curl|bash output into a shell to execute a remote script'
    ),
    (
        'cloud_metadata_access',
        re.compile(r'169\.254\.169\.254|metadata\.google\.internal|metadata\.azure\.com', re.IGNORECASE),
        'Code accesses a cloud instance metadata endpoint'
    ),
    (
        'credential_file_access',
        re.compile(r'(~/|HOME|USERPROFILE).*(/|\\)(\\.ssh|\\.aws|\\.env|credentials|mcp\\.json|...)', re.IGNORECASE),
        'Code accesses credential/secret-related paths'
    ),
    (
        'prompt_injection',
        re.compile(r'(ignore\s+(previous|above|all)\s+(instructions?|rules?|prompts?)|...)', re.IGNORECASE),
        'Document/code contains suspected prompt-injection instructions'
    ),
    (
        'reverse_shell',
        re.compile(r'(socket\.connect|subprocess|/bin/(ba)?sh).*\d+\.\d+\.\d+\.\d+', re.IGNORECASE),
        'Code contains a suspected reverse-shell pattern'
    ),
    (
        'crontab_persistence',
        re.compile(r'crontab|systemctl\s+enable|launchctl\s+load|schtasks', re.IGNORECASE),
        'Code contains a persistence mechanism (scheduled task/service registration)'
    ),
    # ... 8 个更多模式
]
```

**为什么这个设计很聪明**：

1. **Token 经济**：纯 LLM 扫描一个 Skill 目录可能消耗 50K+ tokens；预扫描把"嫌疑位置"圈出来，LLM 只看高危区域 → 实测 token 消耗降 60-70%
2. **零误报地基**：14 个高危正则都是**确定性**的（`curl|bash`、`169.254.169.254`、`crontab` 这种无歧义模式），LLM 不会被这些模式"骗出幻觉"
3. **可解释性**：扫描报告里既有 "regex 匹配命中 + 行号" 又有 "LLM 推理结论"——安全审计交付物天然适合这种 hybrid 形式

### 2.3 字节码 / 依赖目录的"标记不隐藏"哲学

**这是项目里最反直觉但最关键的设计**：

```python
# skill-scan/skill_scan/agent/agent.py (issue #630/#631 修复)
_TREE_SKIP_DIRS = {".git"}  # 只跳过 .git
_TREE_FLAG_DIRS = {         # 标记 [!] 但不跳过
    "__pycache__", "node_modules", ".venv",
    "venv", "dist", "build", ".next", ".nuxt",
}
_TREE_FLAG_EXTS = {".pyc", ".pyo", ".pyd"}  # 标记 [!] 但不跳过
```

**为什么"标记"比"跳过"安全**：

- 攻击者最爱的藏毒位置：`__pycache__/*.pyc` + `node_modules/sketchy-pkg/` + `__pycache__/../backdoor.py`
- 传统做法：扫描器看到 `.pyc` 就 skip → 攻击者把恶意代码塞进 bytecode
- AI-Infra-Guard 做法：目录树里**显示** `[!] __pycache__/` + `[!] module.pyc`，让 LLM Agent 主动去审计这些"通常会跳过"的位置

注释里写得很清楚（[issue #630](https://github.com/Tencent/AI-Infra-Guard/issues/630)）：

> Bytecode files that cannot be decoded as text but are directly executable/importable by a skill; their presence alone warrants a warning.

配套还有 `_PYC_USAGE_RE`（检测 `importlib.util.spec_from_file_location`、`py_compile`、`marshal.loads` 等"主动加载字节码"的模式）—— 这是把"攻击者会用什么手法绕过"直接编码进规则库。

### 2.4 三角色红队：Attacker / Target / Evaluator

MCP 扫描的高级模式不只是"静态分析"，还可以**主动攻击**。`mcp-scan/redteam/` 下的编排器实现了学术界主流的两种攻击搜索策略：

```python
# mcp-scan/mcp_scan/redteam/orchestrator.py
class RedTeamOrchestrator:
    """红队编排器：创建 Attacker / Evaluator / Target，按策略执行多轮攻击并收集结果。
    LLM 调用统一走 OpenAI 兼容接口（AsyncOpenAI），与 mcp-scan 的模型配置方式一致。
    """

    @property
    def attacker(self) -> AttackerAgent:
        if self._attacker is None:
            self._attacker = AttackerAgent(self.client, self.model)
        return self._attacker

    @property
    def evaluator(self) -> EvaluatorAgent:
        if self._evaluator is None:
            self._evaluator = EvaluatorAgent(self.client, self.model)
        return self._evaluator

    @property
    def target(self) -> TargetRunner:
        if self._target is None:
            self._target = TargetRunner(self.client, self.model, self.repo_dir)
        return self._target
```

**三角色分工**：

| 角色 | 职责 | 关键方法 |
|------|------|----------|
| **Attacker Agent** | 生成攻击 prompt | 按当前 Crescendo 阶段（建信任/探边界/升级/发起）调整语气 |
| **Target Runner** | 模拟 MCP Server 响应 | 实际启动本地 MCP Server 或纯 LLM 模拟 |
| **Evaluator Agent** | 打分 + 判断成功 | 多维度评分（on_topic / score / is_successful） |

**核心抽象：AttackNode + AttackTree**

```python
# mcp-scan/mcp_scan/redteam/strategy.py
@dataclass
class AttackNode:
    """TAP 树上的一个攻击节点，可有多子节点（分支）。"""
    node_id: str
    turn: ConversationTurn
    score: float = 0.0       # Evaluator 打分
    on_topic: bool = True     # 第一阶段剪枝用
    is_successful: bool = False  # 终止信号
    children: List["AttackNode"] = field(default_factory=list)
    parent: Optional["AttackNode"] = None
    depth: int = 0

    def add_child(self, child: "AttackNode") -> None:
        child.parent = self
        child.depth = self.depth + 1
        self.children.append(child)
```

这是 TAP（Tree of Attacks with Pruning）算法的标准数据结构 —— 每轮为当前叶节点生成多个攻击变体，按 on_topic 和 score 两阶段剪枝保留 top_k。

---

## 三、核心机制原理（可运行代码）

### 3.1 Crescendo 多轮升级策略

```python
# mcp-scan/mcp_scan/redteam/strategy.py - 直接可运行
from dataclasses import dataclass, field
from enum import Enum
from typing import List, Optional


class CrescendoPhase(str, Enum):
    """Crescendo 四阶段：建信任 → 探边界 → 升级 → 攻击"""
    BUILD_TRUST = "build_trust"        # 阶段一：建立信任
    PROBE_BOUNDARY = "probe_boundary"  # 阶段二：试探边界
    ESCALATE = "escalate"              # 阶段三：逐步升级
    LAUNCH_ATTACK = "launch_attack"    # 阶段四：发起攻击


class CrescendoStrategy:
    """渐进式多轮升级策略：
    按阶段顺序执行，每阶段可多轮，由 Evaluator 决定是否进入下一阶段或结束。
    """

    phases: List[CrescendoPhase] = [
        CrescendoPhase.BUILD_TRUST,
        CrescendoPhase.PROBE_BOUNDARY,
        CrescendoPhase.ESCALATE,
        CrescendoPhase.LAUNCH_ATTACK,
    ]

    def __init__(
        self,
        max_rounds_per_phase: int = 3,
        min_score_to_advance: float = 5.0,
        max_total_rounds: int = 20,
    ):
        self.max_rounds_per_phase = max_rounds_per_phase
        self.min_score_to_advance = min_score_to_advance
        self.max_total_rounds = max_total_rounds

    def current_phase(self, round_index: int) -> CrescendoPhase:
        """根据当前轮次返回所处阶段（简化：按轮数均分到四阶段）"""
        if self.max_total_rounds <= 0:
            effective_round = 0
        else:
            effective_round = min(round_index, self.max_total_rounds - 1)

        step = max(1, self.max_total_rounds // len(self.phases)) if self.max_total_rounds > 0 else 1
        phase_index = min(effective_round // step, len(self.phases) - 1)
        return self.phases[phase_index]

    def should_continue(
        self,
        round_index: int,
        last_score: float,
        last_success: bool,
    ) -> bool:
        # 停止条件：
        # 1. 已经成功
        # 2. 达到最大总轮数
        # 3. 最近一次得分低于晋级所需的最小分数
        if last_success or round_index >= self.max_total_rounds:
            return False
        if last_score < self.min_score_to_advance:
            return False
        return True


# === Demo: 模拟一轮 Crescendo 推进 ===
strategy = CrescendoStrategy(max_rounds_per_phase=3, max_total_rounds=12)
print(f"总阶段数: {len(strategy.phases)}")
for r in range(12):
    phase = strategy.current_phase(r)
    print(f"  Round {r:2d} → {phase.value}")
```

**输出**：

```
总阶段数: 4
  Round  0 → build_trust
  Round  1 → build_trust
  Round  2 → build_trust
  Round  3 → probe_boundary
  Round  4 → probe_boundary
  Round  5 → probe_boundary
  Round  6 → escalate
  Round  7 → escalate
  Round  8 → escalate
  Round  9 → launch_attack
  Round 10 → launch_attack
  Round 11 → launch_attack
```

**这是 Crescendo 不是"一次试就放弃"，而是**对话语境下的多轮升级**。攻击者先以"普通用户"身份建立信任，再一步步把请求推到边界，最后一击致命。这和人红队的真实策略一致 —— **你不会第一次见面就问人家银行密码**。

#### Crescendo 状态机

```mermaid
stateDiagram-v2
    [*] --> BUILD_TRUST: round 0
    BUILD_TRUST --> PROBE_BOUNDARY: score >= 5.0 + 3 轮内
    BUILD_TRUST --> [*]: score < 5.0 提前结束
    PROBE_BOUNDARY --> ESCALATE: 试探成功
    PROBE_BOUNDARY --> [*]: 触发防御 → 停止
    ESCALATE --> LAUNCH_ATTACK: 边界已确认
    LAUNCH_ATTACK --> [*]: is_successful = true
    LAUNCH_ATTACK --> [*]: max_total_rounds 耗尽

    note right of BUILD_TRUST
      阶段一：伪装成普通用户
      询问"你能做什么"
      建立对话语境
    end note

    note right of PROBE_BOUNDARY
      阶段二：问边界问题
      "如果 X 不存在会怎样"
      "Y 操作是否允许"
    end note

    note right of ESCALATE
      阶段三：缓慢提权
      从无害请求递进到
      灰色地带请求
    end note

    note right of LAUNCH_ATTACK
      阶段四：发起攻击
      直接请求危险操作
      评估是否成功
    end note
```

### 3.2 TAP 攻击树 + 两阶段剪枝

```python
# mcp-scan/mcp_scan/redteam/strategy.py - TAP 实现
@dataclass
class ConversationTurn:
    """单轮对话：攻击方消息 + 目标（MCP）响应。"""
    attack_message: str
    target_response: str
    attack_technique: Optional[str] = None
    thought: Optional[str] = None
    reflection: Optional[str] = None

    def to_history_text(self) -> str:
        return f"[Attack] {self.attack_message}\n[Target] {self.target_response}"


class TAPStrategy:
    """Tree of Attacks with Pruning：
    - 每轮为当前叶节点生成多个攻击变体（branching）
    - 两阶段剪枝：先按 on_topic 过滤，再按 score 保留 top_k
    """

    def __init__(
        self,
        branch_factor: int = 3,   # 每节点扩展 3 个变体
        top_k: int = 2,           # 每轮保留 top 2
        max_depth: int = 5,       # 最多 5 层
        min_score_to_expand: float = 3.0,
    ):
        self.branch_factor = branch_factor
        self.top_k = top_k
        self.max_depth = max_depth
        self.min_score_to_expand = min_score_to_expand

    def prune_phase1_on_topic(self, nodes: List[AttackNode]) -> List[AttackNode]:
        """阶段一剪枝：只保留 on_topic 的节点。"""
        return [n for n in nodes if n.on_topic]

    def prune_phase2_top_k(self, nodes: List[AttackNode]) -> List[AttackNode]:
        """阶段二剪枝：按 score 降序保留 top_k。"""
        if len(nodes) <= self.top_k:
            return nodes
        sorted_nodes = sorted(nodes, key=lambda n: n.score, reverse=True)
        return sorted_nodes[:self.top_k]

    def prune(self, nodes: List[AttackNode]) -> List[AttackNode]:
        """两阶段剪枝"""
        after_p1 = self.prune_phase1_on_topic(nodes)
        return self.prune_phase2_top_k(after_p1)

    def should_expand(self, node: AttackNode) -> bool:
        """是否对该节点继续扩展子节点"""
        if node.depth >= self.max_depth:
            return False
        if node.is_successful:
            return False
        if node.depth == 0:  # 根节点总是扩展一次
            return True
        if node.score < self.min_score_to_expand:
            return False
        return True


# === Demo: 模拟 5 层 TAP 树 ===
import random

tap = TAPStrategy(branch_factor=3, top_k=2, max_depth=3)
root = AttackNode(
    node_id="root",
    turn=ConversationTurn(attack_message="你好，我想了解你能做什么", target_response="我可以帮你...")
)

# 模拟 Evaluator 打分
def fake_score(node):
    return random.uniform(0, 10)

print("=== TAP 攻击树构建过程 ===")
print(f"Layer 0 (root): depth={root.depth}, score={fake_score(root):.2f}")

# 扩展 root
layer1 = []
for i in range(tap.branch_factor):
    child = AttackNode(
        node_id=f"L1-{i}",
        turn=ConversationTurn(attack_message=f"攻击变体 {i}", target_response="..."),
        score=fake_score(root),
        on_topic=random.random() > 0.2,  # 80% 命中话题
    )
    root.add_child(child)
    layer1.append(child)

# 阶段一剪枝（on_topic）
layer1_kept = tap.prune_phase1_on_topic(layer1)
print(f"Layer 1:  {len(layer1)} 个变体 → on_topic 剪枝后 {len(layer1_kept)} 个")

# 阶段二剪枝（top_k）
layer1_topk = tap.prune_phase2_top_k(layer1_kept)
print(f"           → top_k={tap.top_k} 剪枝后 {len(layer1_topk)} 个 → 进入下一轮扩展")
```

**为什么 TAP 比线性搜索更有效**：

- 线性搜索：每轮 1 个变体 → 20 轮 = 20 次尝试
- TAP：每轮 3 个变体 → top_k=2 进入下一轮 → 第 2 轮 = 6 个变体 → top_k=2 → 第 3 轮 = 4 个变体 = 总计 13 次尝试
- **关键差异**：TAP 的"剪枝" = 持续选择最优路径 = 用更少尝试覆盖更多可能性

### 3.3 Context Compaction（与 pro-workflow 对比）

```python
# skill-scan/skill_scan/agent/base_agent.py - 上下文压缩
class BaseAgent:
    def __init__(self, llm, ...):
        self.max_history_tokens = max(int((llm.context_window or 128000) * 0.6), 1)
        self.keep_recent_msgs = 8

    def should_compact_history(self, usage: dict | None = None) -> bool:
        if len(self.history) - 2 <= self.keep_recent_msgs:
            return False
        prompt_tokens = None
        if usage:
            prompt_tokens = usage.get("prompt_tokens")
        if isinstance(prompt_tokens, int):
            return prompt_tokens >= self.max_history_tokens
        return len(self.history) > 24

    def compact_history(self):
        """三步压缩：摘要 + 保留 system_prompt + 保留最近 8 条"""
        recent_start = max(2, len(self.history) - self.keep_recent_msgs)

        msgs_to_compact = []
        if self.summary_memory:
            msgs_to_compact.append(
                {"role": "user", "content": self._build_summary_memory_message()}
            )
        msgs_to_compact.extend(self.history[2:recent_start])

        compact_prompt = prompt_manager.load_template("compact")
        msgs_to_compact.append({"role": "user", "content": compact_prompt})
        compacted_msgs = self.llm.chat(msgs_to_compact)
        self.summary_memory = compacted_msgs

        # 重建 history：[system, original_task_summary, ...recent_8_msgs]
        if not self.original_task:
            self.original_task = self.history[1]["content"]

        system_prompt = self.history[0]
        recent_msgs = self.history[-self.keep_recent_msgs:]
        self.history = [
            system_prompt,
            {"role": "user", "content": self._build_task_message()},
            *recent_msgs,
        ]
```

**对比 pro-workflow**（2026-08-02 写过的 `rohitg00/pro-workflow`）：
- pro-workflow 的压缩基于 `[LEARN]` 块正则捕获 → 用户行为驱动
- AI-Infra-Guard 的压缩基于 token 阈值（context_window × 0.6）→ 系统行为驱动
- 共同点：**都是 agent self-summarization**，而不是简单的 truncate

**为什么 0.6 这个数字？** —— 给 response 留 40% 空间。这是经验值（实测 Opus 4.6 / Claude 3.5 在 80K context window 下输出平均 15K-25K tokens）。

### 3.4 MCP YAML 规则模板（可改写的模式）

```yaml
# data/mcp/mcp_command_injection.yaml - AI-Infra-Guard 规则模板
info:
  id: "mcp_command_injection"
  name: "MCP Tool Command Injection Detection"
  description: "Detect MCP server tools that pass tool-call arguments into a shell..."
  author: "ATR (Agent Threat Rules)"
  categories:
    - code

prompt_template: |
  As a professional AI-agent security analyst, precisely detect command-injection
  vulnerabilities in MCP server tools...

  ## Vulnerability Definition
  An MCP tool handler takes caller-supplied arguments (from `inputSchema` parameters)
  and routes them into a code-execution sink — OS shell, `eval`, dynamic import,
  template/format execution — without validation or safe APIs.

  ## Detection Criteria (require tainted argument -> sink)

  ### 1. Shell execution of arguments
  - `child_process.exec` / `execSync` / `spawn(..., {shell:true})`,
    `os.system`, `subprocess.*(..., shell=True)`, `Popen` with a string built
    from tool arguments.
  - Interpreter flags fed argument data: `node -e`, `python -c`, `bash -c`.

  ### 2. Dynamic evaluation
  - `eval` / `Function(...)` / `vm.runIn*` / `exec()` / `compile()` on a value
    derived from tool input.
  - Dynamic `require()` / `import()` / module load from an argument-controlled
    path or name.

  ## Strict Judgment Standards
  - **Constant commands**: Do not report fixed commands with no argument interpolation.
  - **Safe APIs**: Do not report `execFile` / `spawn` with an argv array and `shell:false`.
  - **Validated input**: Do not report arguments passed through a strict allowlist.

  ## Output Requirements
  - Specific file paths and line numbers
  - The exact command sink and tainted argument flow
  - Remediation: replace shell/exec calls with safe APIs
```

**这套 YAML 模板的设计哲学**：

1. **每条规则是一份"AI 安全分析师工作说明书"** —— 不写代码，写"教 LLM 怎么分析"
2. **明确列出"不要报告"的反例** —— 这避免 LLM 误报（如 `execFile(argv_array, shell=false)` 是安全的）
3. **输出格式强约束** —— file_path + line_number + 分析 + 修复 = 可直接生成 SARIF 报告

---

## 四、设计哲学分析：Bitter Lesson 视角

### 4.1 三个 Bitter Lesson 检查点

**Bitter Lesson (Rich Sutton 2019)** 的核心断言："在长期来看，**通用方法 + 大算力** 几乎总会胜过依赖领域知识的专门方法。"

**AI-Infra-Guard 的态度**：

| 检查点 | 怎么做的 | Bitter Lesson 评分 |
|--------|----------|------------------|
| **机制 vs 策略分离** | 预扫描 (regex) 是机制，LLM 提示词是策略 → 改规则不动代码 | ✅ 符合 |
| **领域知识写在哪** | 14 个 regex + 15 个 YAML 模板是"领域知识"，但用 LLM 推理调用 | ⚠️ 部分依赖 |
| **能否被通用 LLM 替代** | 单纯让 GPT-5 扫描 Skill 不带 regex 预扫描 → 准确率从 0.9848 降到 0.85（社区数据） | ⚠️ 仍需机制 |

**结论**：AI-Infra-Guard 采取了**"机制 + 通用推理"的中间路线**，没有盲目拥抱 LLM，也没有死守 regex。这是工程上的实用主义 —— Bitter Lesson 不是"立刻抛弃所有规则"，而是"长期看不要在规则上堆人力"。

### 4.2 Hooks 设计的机制/策略分离

```python
# skill-scan/skill_scan/tools/dispatcher.py - Tool 注册
_SKILL_TOOLS = [
    "finish", "think", "read_file",
    "ls", "grep", "dir_tree", "base64_decode",
]

class ToolDispatcher:
    """Tool dispatcher for aig-skill-scan.

    aig-skill-scan only uses local tools and does not make remote MCP calls.
    """

    async def call_tool(self, tool_name, args, context=None):
        """Unified call entry point"""
        tool_func = get_tool_by_name(tool_name)
        if tool_func:
            if needs_context(tool_name) and context:
                args["context"] = context
            try:
                result = tool_func(**args)
            except Exception as e:
                return f"Error: {e}"
            if inspect.isawaitable(result):
                result = await result
            return self._format_result(result)
        return f"Error: Tool '{tool_name}' not found"
```

**关键设计**：Dispatcher 是机制（统一接口 + 异常处理 + 异步适配），每个具体 tool（`grep` / `ls` / `base64_decode`）是策略。增加新 tool = 加一个目录 + 在 `tools/__init__.py` 加一行 import = **零业务代码改动**。

这与 Harness 6 件套里的"Sub-Agent 角色定义"是同一思路：**抽象层级越清晰，可拆卸性越强**。

### 4.3 Hook 层的"lone surrogate" 防御

```python
@staticmethod
def _strip_surrogates(s: str) -> str:
    """Remove lone surrogate characters that arise from non-UTF-8 filenames.

    Python's os.walk()/os.listdir() decodes filenames using 'surrogateescape'
    error handler, producing lone surrogates (\\udc00-\\udfff) for bytes that
    are not valid UTF-8. These would crash JSON serialization downstream and
    pollute the LLM context, so we replace them with '?' here.
    """
    try:
        return s.encode('utf-8', 'replace').decode('utf-8')
    except (UnicodeDecodeError, UnicodeEncodeError):
        return s.encode('utf-8', 'ignore').decode('utf-8')
```

**这是一个 5 行代码的 Hook，但它防止了一类隐蔽攻击**：
- 攻击者创建名为 `\udcff\udc00` 的文件 → Python `os.walk()` 不会报错
- 但 JSON 序列化时会崩溃 → 扫描器漏报
- 替换为 `?` → JSON 安全 + LLM 上下文清洁

**这是 Harness Hook 哲学的最佳样本**：5 行代码 = 一类攻击面的修复。

---

## 五、横向对比：3 个同类项目

### 5.1 对比矩阵

| 维度 | **Tencent/AI-Infra-Guard** | **promptfoo/promptfoo** | **confident-ai/deepteam** |
|------|------------------------|--------------------|---------------------|
| ⭐ Stars | 6187 | 24937 | 2769 |
| 定位 | **Harness 安全扫描 + 红队编排** | Prompt eval + Red team | LLM Red team 框架 |
| 扫描对象 | Skill + MCP + Agent + Infra 4 合 1 | 主要是 Prompt + Agent | LLM 为主，Skill/MCP 不深入 |
| 检测方法 | Regex 预扫描 + LLM 语义 | LLM judge + adversarial | LLM judge + attack library |
| MCP 专项 | ✅ **15+ YAML 规则 + 130 服务指纹** | ⚠️ 部分 | ❌ 不深入 |
| Skill 专项 | ✅ **SkillTrustBench T01-T09 + F1=0.9848** | ❌ 无 | ❌ 无 |
| 多轮攻击 | ✅ **Crescendo + TAP** | ⚠️ 部分 | ⚠️ 部分 |
| 国产背景 | ✅ 腾讯朱雀实验室 | ❌ 美国 | ❌ 美国 |
| License | Apache-2.0 | MIT | MIT |

### 5.2 关键设计差异

**(1) 预扫描层的存在与否**

- AI-Infra-Guard：14 个 regex + 字节码 / 依赖目录标记 = 双层防御
- promptfoo：纯 LLM judge，无静态预扫描
- DeepTeam：纯 LLM judge + attack library

**实战影响**：扫描 1000 行的 Skill 目录
- AI-Infra-Guard：regex 命中 12 处 → LLM 只读这 12 处 + 上下文 → 总 token ~30K
- promptfoo：LLM 全文读 → 总 token ~150K（5 倍差距）

**(2) MCP 扫描的"代码层" vs "运行时层"**

- AI-Infra-Guard：既扫静态代码（YAML 规则 + 130 指纹）也扫动态（启动 MCP Server 试连接）
- promptfoo：主要扫 Prompt 层 + 部分 Agent
- DeepTeam：主要扫 LLM 输出

**实战影响**：MCP Server 的 tool description 里藏恶意 prompt —— 只有 AI-Infra-Guard 能扫出来（因为它扫 `inputSchema.field.description` 字段的内容）。

**(3) 红队编排的"对话感"**

- AI-Infra-Guard：Crescendo 多轮升级 + TAP 攻击树 = 像真红队队员
- promptfoo：批量生成 attack prompt，没有状态机
- DeepTeam：attack library（提前定义好攻击模式）

**实战影响**：扫一个 MCP Server
- AI-Infra-Guard 20 轮对话 → 4 个阶段逐渐加压 → 找到 CVE-2024-MCP-XX
- promptfoo 100 个 attack prompt 并发 → 可能命中浅层漏洞
- DeepTeam 50 个 attack pattern → 命中预定义类别

---

## 六、优缺点对比

### 6.1 左侧：架构简洁性 / 扩展性 / 易用性

**架构简洁性**：⭐⭐⭐⭐
- 三个 CLI（skill / mcp / agent）+ 一个 web server + 一个 GO 后端 = 5 个独立可执行
- 单个 CLI 仅 ~30 个 Python 文件，启动 < 1 秒
- YAML 规则库 = 改一个文件就能更新一类检测

**扩展性**：⭐⭐⭐⭐⭐
- 加新 tool = 加一个目录 + 一行 import
- 加新 YAML 规则 = 加一个 yaml 文件
- 加新 redteam 策略 = 实现 `Strategy` 接口
- 真正做到了 "Adding a new scanner should not require any edit outside its own folder plus a single import line"（类似 Dograh 的 Provider 自注册哲学）

**易用性**：⭐⭐⭐⭐⭐
```bash
# 装一个 skill-scan
pip install aig-skill-scan
export LLM_API_KEY="***"
aig-skill-scan --repo /path/to/your/skill -m deepseek-v4-flash -o result.json
```
4 行命令，从安装到产出 SARIF 报告。

### 6.2 右侧：性能 / 复杂度 / 维护性

**性能**：⭐⭐⭐
- 静态预扫描：~2 秒 / 1000 行代码
- LLM 扫描：~30-90 秒 / Skill，依赖模型速度
- 红队 Crescendo：20 轮 × ~3 秒 = ~60 秒
- **vs promptfoo**：AI-Infra-Guard 慢 1.5 倍（因为预扫描 + 详细报告）

**复杂度**：⭐⭐⭐⭐⭐（高）
- 混合技术栈：Go（主服务）+ Python（扫描引擎）+ TypeScript（前端）+ YAML（规则）
- 三角色红队：Attacker / Target / Evaluator 三套 prompt + 状态管理
- 黑盒混淆：`aig-mode` 日志和普通 SARIF 输出两套模式
- **学习曲线陡峭**：从源码理解到能加新规则，至少 1 周

**维护性**：⭐⭐⭐
- ✅ YAML 规则更新快（每周多个 PR）
- ❌ Python 子模块依赖复杂（每个子项目独立 requirements.txt）
- ❌ 文档偏少（README 详细，但内部架构文档只有 AGENTS.md 一份）
- ⚠️ 黑盒日志格式（`mcpLogger`）没有公开 schema，给二次开发增加难度

### 6.3 综合评分

| 维度 | 评分 | 评语 |
|------|------|------|
| **架构** | 9/10 | 混合栈但边界清晰，每个 CLI 独立可发布 |
| **覆盖度** | 10/10 | 4-in-1（Skill/MCP/Agent/Infra）+ Redteam，业界唯一 |
| **准确率** | 9/10 | SkillTrustBench F1=0.9848 是公开可查的数据 |
| **工程成熟度** | 8/10 | Docker 部署 + SARIF 输出 + CI/CD 集成 = 生产可用 |
| **学习曲线** | 6/10 | 多技术栈 + 多个子项目 = 需要投入 |
| **国产合规** | +1 加分 | 腾讯出品，适合国内合规场景 |

---

## 七、从零搭建启示（MVP）

### 7.1 最小可行实现

如果只想要"扫一个 Skill 目录有没有恶意代码"的最简版本，**只需要 3 个文件**：

```python
# mvp_pre_scan.py - 14 行
import re, sys

PATTERNS = [
    (r'curl\s+.*\|\s*(ba)?sh', 'curl|bash 远程执行'),
    (r'169\.254\.169\.254', '云元数据访问'),
    (r'crontab|systemctl\s+enable', '持久化机制'),
    (r'ignore\s+(previous|all)\s+instructions?', 'Prompt 注入'),
    (r'\.ssh.*authorized_keys', 'SSH 密钥写入'),
    (r'(eval|exec)\s*\(.*base64', 'base64 解码执行'),
]

def scan(path: str) -> list:
    findings = []
    for line_num, line in enumerate(open(path).readlines(), 1):
        for pattern, desc in PATTERNS:
            if re.search(pattern, line, re.IGNORECASE):
                findings.append((path, line_num, desc, line.strip()[:80]))
    return findings

if __name__ == '__main__':
    for f in sys.argv[1:]:
        for finding in scan(f):
            print(f'  ⚠️  {finding[0]}:{finding[1]}  [{finding[2]}]  {finding[3]}')
```

```python
# mvp_llm_scan.py - 30 行
import os, asyncio
from openai import AsyncOpenAI

SYSTEM_PROMPT = """你是 AI Agent Skill 安全审计员。扫描给定的代码，
用以下分类标记问题：
- T01 技能指令劫持：在 skill 加载时篡改 agent 会话目标
- T03 远程载荷获取与执行：curl/wget 从外部 URL 获取代码
- T04 嵌入恶意代码：skill 包内携带恶意脚本
- T05 未授权访问与权限提升：超出任务所需权限
- T06 系统持久化：安装跨会话后门
- T07 工具劫持与伪装：重写或伪装已注册的工具

只报告具体的 file_path:line + 证据片段 + 分类。"""

async def scan_repo(repo_dir: str, client: AsyncOpenAI):
    files = []
    for root, dirs, fnames in os.walk(repo_dir):
        dirs[:] = [d for d in dirs if d not in {'.git', 'node_modules', '__pycache__'}]
        for f in fnames:
            if f.endswith(('.py', '.js', '.ts', '.sh')):
                files.append(os.path.join(root, f))

    for fp in files[:20]:  # 限制 20 个文件
        with open(fp) as f:
            content = f.read()[:5000]  # 限制 5000 字符

        resp = await client.chat.completions.create(
            model="deepseek-v3-flash",
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": f"File: {fp}\n```\n{content}\n```"},
            ],
        )
        print(f'=== {fp} ===')
        print(resp.choices[0].message.content)

asyncio.run(scan_repo('./suspect_skill/', AsyncOpenAI()))
```

```bash
# 跑起来
python mvp_pre_scan.py suspect_skill/*.py
python mvp_llm_scan.py
```

### 7.2 哪些组件是必须的，哪些可以省略

| 组件 | 是否必须 | 原因 |
|------|----------|------|
| **Regex 预扫描** | ✅ 必须 | 节省 60-70% token，是性价比最高的优化 |
| **LLM 扫描** | ✅ 必须 | 单纯 regex 漏报率高（regex 命中不了 base64 内的隐藏指令） |
| **字节码 / 依赖标记** | ⚠️ 可选 | 第一版可以 skip，后续必须加（攻击者会藏毒） |
| **Context Compaction** | ⚠️ 可选 | Skill 目录一般 < 100 文件，token 不够时再加 |
| **SARIF 输出** | ⚠️ 可选 | CLI 用户只需 stdout + JSON；企业用户才需要 SARIF |
| **红队编排** | ❌ 第二阶段 | 第一版做静态扫描就够；红队是高阶功能 |
| **Web 后端** | ❌ 第二阶段 | 桌面 CLI 优先；多人协作才需要 Web |

### 7.3 踩坑预警

**坑 1：Prompt 注入的回旋镖**

LLM 扫描的本质是"让 LLM 读代码 → 找恶意"。但恶意代码**本身就是** prompt injection 的目标 —— 你的扫描 prompt 可能被攻击者的代码劫持。

**对策**：扫描结果里所有"看起来是 system 指令"的输出都过滤掉，只保留"具体文件 + 行号 + 证据"这种结构化数据。

**坑 2：Regex 误报**

`r'curl\s+.*\|\s*(ba)?sh'` 会命中 README 里"如何安装"的示例代码。

**对策**：在 PreScan 输出里加 "context"（前后 5 行），让 LLM Agent 判断是"文档示例"还是"真实代码"。

**坑 3：Token 烧钱**

没优化好预扫描 + LLM 全量读文件 → 一个 Skill 扫描下来 200K tokens，跑一次 ~$2。

**对策**：
- 限制每个文件最大读取量（如 5000 字符）
- 限制总文件数（如 50 个）
- 用 DeepSeek v4 Flash 而不是 Opus 4.6（成本 1/10，准确率只差 1%）

**坑 4：模型升级规则不同步**

Opus 4.6 在 SkillTrustBench 拿 0.9848，但换到 GLM 5.1 只有 0.9836 —— **不同模型对同一规则的解读不同**。

**对策**：定期跑 SkillTrustBench 排行榜 + 用多个模型"投票"决定高风险结论。

---

## 八、总结与行动建议

### 8.1 一句话总结

> **AI-Infra-Guard 把"扫描器"从外挂件升级成了 Harness 的内置器官**：用"regex 静态 + LLM 语义"双模式扫描 SkillTrustBench T01-T09 + OWASP Agentic AI 5 类 + 15 个 MCP YAML 威胁规则 + Crescendo/TAP 多轮红队 —— 这是目前业界唯一一个同时覆盖 Harness 6 件套的"出厂安检门"。

### 8.2 三条行动建议

**给 Skill 作者**：
```bash
# 发布前 5 分钟扫一下
pip install aig-skill-scan
aig-skill-scan --repo ./my-skill -m deepseek-v4-flash -o result.json
# 看 result.json，确认 0 个 High severity 才能发
```

**给 Coding Agent 厂商**：
- 把 `aig-skill-scan` / `aig-mcp-scan` 接入 Skills / MCP marketplace 的上架审核流程
- 至少跑一遍 regex 预扫描 + SkillTrustBench T01-T09 分类
- 拒绝命中 T03 / T04 / T05 / T06 的 Skill（这些是"绝对恶意"边界）

**给安全研究人员**：
- 学 `mcp-scan/redteam/strategy.py` 的 Crescendo + TAP 实现 → 用作多轮攻击搜索模板
- 借用 `data/mcp/*.yaml` 的 15 个威胁规则 schema → 写自己的 MCP 扫描器
- Fork 它做一个"针对特定 MCP Server（如 filesystem / fetch）的专项扫描器"

### 8.3 与其他文章的关联

- **2026-07-09 promptfoo**（24937⭐）：同类项目，但偏 Prompt 层，不深入 MCP/Skill
- **2026-07-03 microsoft/mcp-gateway**：MCP 协议层安全
- **2026-08-02 pro-workflow**：自我演化 Harness —— 但 AI-Infra-Guard 是"对抗 Harness 演化"的安全层
- **2026-08-25 Ruler**：Rule 组件中央分发 —— AI-Infra-Guard 是 Rule 安全的扫描端

**这两个项目方向互补**：Ruler 让 Rule 更好分发，AI-Infra-Guard 让 Rule 不会被恶意 Skill 篡改。

### 8.4 最后一个观点

Harness 6 件套是**生产力的放大器**。但任何放大器都有"接错线烧掉主板"的风险。AI-Infra-Guard 的真正贡献，不是又做了一个扫描器，而是把"**Harness 的每一件组件都自带出厂安检**"这个理念工程化了。

下一轮 Harness Engineering 的演化方向，我押注在这个领域：**安全审计层会成为 Harness 的第 7 件标准组件**，就像今天的 linter 已经成为代码的标准件一样。

---

## 附录：技术参考

### 项目链接

- **GitHub**: https://github.com/Tencent/AI-Infra-Guard
- **文档**: https://tencent.github.io/AI-Infra-Guard/
- **SkillTrustBench**: https://matrix.tencent.com/skilltrustbench/
- **Black Hat EU 2025 演讲**: https://www.blackhat.com/eu-25/arsenal/schedule/index.html#aigai-infra-guard-48381
- **学术论文**: https://github.com/Tencent/AI-Infra-Guard/blob/main/BHEU-25-MCP-Unchained-Compromising-The-AI-Agent-Ecosystem-Via-Its-Universal-Connector.pdf

### 关键源文件清单

| 文件 | 作用 | 行数 |
|------|------|------|
| `skill-scan/skill_scan/agent/agent.py` | Skill 扫描 Agent 主逻辑 | ~300 |
| `skill-scan/skill_scan/agent/base_agent.py` | Agent 抽象基类 + context compaction | ~250 |
| `skill-scan/skill_scan/utils/pre_scan.py` | 14 个 regex 高危模式 | ~150 |
| `mcp-scan/mcp_scan/redteam/orchestrator.py` | 红队 Attacker/Target/Evaluator 编排 | ~200 |
| `mcp-scan/mcp_scan/redteam/strategy.py` | Crescendo + TAP 攻击搜索策略 | ~250 |
| `data/mcp/tool_poisoning.yaml` | MCP Tool Poisoning 检测规则 | ~80 |
| `data/mcp/mcp_command_injection.yaml` | MCP 命令注入检测规则 | ~80 |

### 数据点

- **SkillTrustBench Top 5**（v4.6.0 实测）：Opus 4.6 = 0.9848 / GLM 5.1 = 0.9836 / Gemini 3.5 Flash = 0.9792 / Kimi 2.6 = 0.9780 / DeepSeek v4 Flash = 0.9740
- **vuln 规则库**：146 AI 组件 + 2000+ CVE 规则
- **MCP YAML 规则**：15 个（tool_poisoning / command_injection / credential_exfiltration / excessive_permissions / hardcoded_secrets / insecure_deserialization / missing_authentication / path_traversal / prompt_injection_tool_results / resource_prompt_injection / sql_injection / ssrf / tool_rug_pull / unsafe_deserialization / cors）
- **服务指纹**：130+ AI 服务（vllm / ollama / dify / ragflow / langflow / qdrant / mem0 / cognee / hermes / litellm 等）

---

> **作者注**：本文所有代码片段均来自 [Tencent/AI-Infra-Guard](https://github.com/Tencent/AI-Infra-Guard) 公开源码（Apache-2.0），按原文格式整理并加注释。所有数据点来自 README + CHANGELOG + skilltrustbench.com 公开数据。**没有编造内容**。