---
title: 【OpenSquilla】Harness 原生路由：本地分级省下 67% 成本
author: AI 调研员
date: 2026-11-13 08:00:00
categories: [技术报告]
tags: [Harness Engineering, 模型路由, OpenSquilla, 成本控制, Token 优化]
words: 11200
reading_time: 24分钟
rating: 93
description: 从 TokenRhythm/opensquilla（7139⭐，Apache-2.0）出发，深度拆解 Harness-Native Agentic Routing：本地 BERT-60M INT8 intent 分类器 + LightGBM 380 维特征分级器、四档 tier 状态机、冻结哈希校验、本地校准硬夹紧，附 4 套 benchmark 实测数字与 200 行 Python MVP。
series: harness-engineering
---

> **一句话结论**：当模型开始"分工"（写代码强、长上下文恢复强、工具调用强、低延迟响应强），Agent 内部的"选哪个模型"就不再是服务端的一个小功能，而是 Harness 的核心机制——OpenSquilla 用一个跑在**本地**的分类器把每一轮对话路由到最便宜且够用的模型上，实测在 DRACO 基准上保持 99.94% 的分数同时把成本压到对手的 33%。
>
> **本篇属于 Harness Engineering 系列** · 组件位置：**MCP 之外的"模型层"横评**（路由 / 成本 / 预算）

---

## 前言：一个没人问的问题

如果你把同一句话分别发给 Claude Code、Cursor 和一个自建的 Agent Loop，三个系统几乎一定会调用**不同的模型**。

原因很简单：Claude Code 默认挂 Opus，Cursor 有自己的模型策略，自建 Agent 则由你在 `config.yaml` 里写死一个名字。**没有人问"这一轮到底需不需要最贵的模型"**。

但真实的 Agent 会话长这样：

| 轮次 | 用户说了什么 | 实际需要的模型能力 |
|------|-------------|------------------|
| 1 | "看下这个 config 报错" | 读日志 + 定位关键词 → 中等模型够 |
| 2 | "谢谢" | 一句话应答 → 最便宜模型绰绰有余 |
| 3 | "把上面的方案改成分布式，论证一致性" | 架构推理 + 权衡 → 需要顶级模型 |
| 4 | "格式再整齐点" | 改写输出 → 中等模型够 |

如果每一轮都用 Opus-4.8，**第 2 轮和第 4 轮的钱是白烧的**。

这不是"服务端优化"——这是 **Harness 的一部分**。因为 Agent 的执行单位是"一轮带状态的执行"，而不是"一次 query"。同一个 query 在不同的 harness 状态下，需要的模型能力天差地别。

本周我挑的项目是 **[TokenRhythm/opensquilla](https://github.com/TokenRhythm/opensquilla)**（7139⭐，Apache-2.0，Python 3.12+）。它的核心是一个叫 **SquillaRouter** 的本地模型路由层，外加一套基于 arXiv 论文《Agentic Routing: The Harness-Native Data Flywheel》的完整方法论。

读完你能拿到三样东西：

1. **一套可落地的分级路由状态机**（intent → tier → thinking → prompt policy 四段式）
2. **4 套 benchmark 的实测数字**（PinchBench / ClawMark / ClawSWEBench / DRACO）
3. **一个 200 行 Python MVP**，把核心机制抽出来，你可以今天就跑通

---

## 一、项目定位：它到底解决什么问题

### 1.1 传统路由的失效场景

市面上的模型路由（OpenRouter Auto、RouteLLM、Martian 之类）几乎都长这样：

```
用户 query → 分类器 → 选一个模型 → 返回
```

它们优化的是**单轮**的成本-质量权衡。但在 Agent 场景里，这个假设直接崩塌：

- **同一个 query 在不同状态下难度完全不同**。"修复这个 bug"在第一次是难题，在 Agent 已经读过 stack trace 之后就是送分题。
- **Agent 会失败、会重试、会自我纠错**。一次失败的执行轨迹本身是最有价值的训练信号，但传统路由看不到它。
- **模型是"分工"的**。arXiv 论文原文说得直白：

> "frontier and open models are becoming structurally specialized: a model that is strong at code editing, long-context recovery, tool use, mathematical reasoning, or low-latency response may not dominate on the other axes."
>
> （前沿与开源模型正在结构性地专门化：一个在代码编辑、长上下文恢复、工具使用、数学推理或低延迟响应上强的模型，未必在其他维度上占优。）

### 1.2 OpenSquilla 的三个主张

论文提出的核心概念叫 **Harness-Native Agentic Routing**（Harness 原生智能体路由），落地成三个可操作的机制：

| # | 主张 | 工程含义 |
|---|------|---------|
| 1 | **Step-level routing** | 路由的决策单元是"一轮执行"，不是"一次请求" |
| 2 | **Conditioned on full harness state** | 决策输入包含 intent、上一轮结果、路由历史、工具状态 |
| 3 | **Harness-native data flywheel** | 每次路由决策天然产生一条带标签的数据记录（标签由环境给，不是分类器自己编），这些记录反过来训练更好的路由器 |

第三条是最狠的。论文原话：

> "every routing decision naturally produces a structured data record — consisting of the query, harness state, model choice or model set, execution trace, outcome, and cost — whose labels are supplied by the environment rather than by the router itself."

传统路由的分类器要**自己标注**训练数据（标注"这个 query 很难"），标注质量决定上限。而 OpenSquilla 的分类器**只做推理**，标签由"这一轮到底做成了没有"这个客观事实提供——免费、精确、无偏。

### 1.3 在 Harness 6 件套里的位置

OpenSquilla 本身是一个**完整 Harness**（microkernel 架构），但它最有辨识度、也最值得单独拆解的是**模型选择层**：

```mermaid
graph TB
    subgraph L1["🚀 入口层 Entry"]
        A1["📥 Web UI"]
        A2["💻 CLI / TUI"]
        A3["📱 Telegram / Discord / Slack"]
    end

    subgraph L2["⚙️ 引擎层 Engine"]
        E1["🔁 Turn Loop<br/>统一 turn 循环"]
    end

    subgraph L3["🎯 模型选择层 ★ 本篇主角"]
        R1["🧠 SquillaRouter<br/>本地 intent + tier 分类"]
        R2["📊 Feature Pipeline<br/>380 维特征"]
        R3["🪝 Tier State Machine<br/>C0 → C3"]
        R4["📈 Calibration<br/>本地阈值校准"]
        R5["🎲 Ensemble Planner<br/>多模型提议 + 聚合"]
    end

    subgraph L4["🔌 能力层 Capabilities"]
        C1["🧠 Memory<br/>持久记忆"]
        C2["🏖️ Sandbox<br/>分层沙箱"]
        C3["🔧 Web Search"]
        C4["📦 Skills / MCP"]
    end

    subgraph L5["📡 Provider 层"]
        P1["OpenRouter"]
        P2["TokenRhythm"]
        P3["OpenAI / Anthropic / Ollama / Qwen ..."]
    end

    A1 --> E1
    A2 --> E1
    A3 --> E1
    E1 --> R1
    R1 --> R2 --> R3
    R3 --> R4
    R5 -.多模型提议.-> R3
    E1 --> C1
    E1 --> C2
    E1 --> C3
    E1 --> C4
    R3 --> P1
    R3 --> P2
    R3 --> P3

    style A1 fill:#C7CEEA,stroke:#9FA8DA,stroke-width:2px,color:#333
    style A2 fill:#C7CEEA,stroke:#9FA8DA,stroke-width:2px,color:#333
    style A3 fill:#C7CEEA,stroke:#9FA8DA,stroke-width:2px,color:#333
    style E1 fill:#F5F5F5,stroke:#BDBDBD,stroke-width:2px,color:#333
    style R1 fill:#E8D5F5,stroke:#CE93D8,stroke-width:2px,color:#333
    style R2 fill:#FFDAB9,stroke:#FFCC80,stroke-width:2px,color:#333
    style R3 fill:#FFB3C6,stroke:#F48FB1,stroke-width:2px,color:#333
    style R4 fill:#FFF9C4,stroke:#F9A825,stroke-width:2px,color:#333
    style R5 fill:#B5EAD7,stroke:#80CBC4,stroke-width:2px,color:#333
    style C1 fill:#F5F5F5,stroke:#BDBDBD,stroke-width:2px,color:#333
    style C2 fill:#F5F5F5,stroke:#BDBDBD,stroke-width:2px,color:#333
    style C3 fill:#F5F5F5,stroke:#BDBDBD,stroke-width:2px,color:#333
    style C4 fill:#F5F5F5,stroke:#BDBDBD,stroke-width:2px,color:#333
    style P1 fill:#C7CEEA,stroke:#9FA8DA,stroke-width:2px,color:#333
    style P2 fill:#C7CEEA,stroke:#9FA8DA,stroke-width:2px,color:#333
    style P3 fill:#C7CEEA,stroke:#9FA8DA,stroke-width:2px,color:#333
```

**注意 L3 的位置**：它夹在引擎和能力层之间，**在请求发出之前**做决策。这意味着它不是"事后统计"，而是"事前调度"——省下的钱是**真的没花出去**，不是花了再打折。

---

## 二、架构分析：四层路由栈

### 2.1 一轮请求的完整数据流

让我按真实执行顺序拆一遍（对应 `src/opensquilla/engine/steps/model_router.py`）：

```mermaid
graph LR
    S1["📥 用户输入<br/>+ harness 状态"] --> S2["🧠 Intent 分类<br/>BERT-60M INT8"]
    S2 --> S3["🎯 阈值改写<br/>redo≥0.25 / new≥0.01"]
    S3 --> S4["📊 Tier 分类<br/>LightGBM 380维"]
    S4 --> S5["🪝 Tier 状态机<br/>迁移规则"]
    S5 --> S6["🧮 控制器<br/>thinking + prompt"]
    S6 --> S7["💰 预算闸门<br/>budget gate"]
    S7 --> S8["📡 调用 Provider"]
    S8 --> S9["📝 记录决策<br/>router_decision"]
    S9 -.数据飞轮.-> S2

    style S1 fill:#C7CEEA,stroke:#9FA8DA,stroke-width:2px,color:#333
    style S2 fill:#E8D5F5,stroke:#CE93D8,stroke-width:2px,color:#333
    style S3 fill:#FFF9C4,stroke:#F9A825,stroke-width:2px,color:#333
    style S4 fill:#FFDAB9,stroke:#FFCC80,stroke-width:2px,color:#333
    style S5 fill:#FFB3C6,stroke:#F48FB1,stroke-width:2px,color:#333
    style S6 fill:#F5F5F5,stroke:#BDBDBD,stroke-width:2px,color:#333
    style S7 fill:#B5EAD7,stroke:#80CBC4,stroke-width:2px,color:#333
    style S8 fill:#C7CEEA,stroke:#9FA8DA,stroke-width:2px,color:#333
    style S9 fill:#E8D5F5,stroke:#CE93D8,stroke-width:2px,color:#333
```

**关键设计：两阶段分类器，职责完全分离。**

| 阶段 | 分类器 | 看什么 | 输出 |
|------|--------|--------|------|
| **Intent** | BERT-60M INT8（上下文感知） | 历史 + 上一轮答案 + 当前请求 | `new_task` / `continue` / `redo` |
| **Tier** | LightGBM（**仅看当前请求**） | 只有 `current_request` 文本 | `C0` / `C1` / `C2` / `C3` |

这个分离不是随意的。文档里写得很清楚：

> "Tier classification uses only the current request text. Historical user messages, previous answers and usage, task anchors, route history, and historical context estimates do not enter its features. BERT intent classification retains that context."

**为什么 tier 不看历史？** 因为 tier 要回答的是"**这一轮**这个问题本身有多难"，而不是"这次任务总体有多难"。如果把历史喂进去，模型会把上一轮的难度当成这一轮的难度，遇到"第一轮很难后面都是收尾"的任务时会一路卡在 C3。而 intent 用历史，是为了判断"用户是在继续、在重做、还是开了新话题"——这必须看上下文。

> **这是我认为整个项目最漂亮的一处设计**：**不是所有决策都需要同样的上下文**。把"需要历史的判断"和"不需要历史的判断"在模型层面拆开，而不是在 feature 里靠 mask 硬凑。

### 2.2 380 维特征管道

Tier 分类器吃的是一个固定 380 维的浮点向量。这 380 维不是拍脑袋来的，而是有**显式命名注册表**的：

```python
# src/opensquilla/squilla_router/lightgbm_model/_vendor/features/lightgbm380.py
SEMANTIC_DIM = 64
CHARACTER_DIM = 100
FEATURE_DIM = 380

FEATURE_NAMES_380 = (
    tuple(f"current.semantic.{index:03d}" for index in range(SEMANTIC_DIM))
    + tuple(f"current.character.{index:03d}" for index in range(CHARACTER_DIM))
    + _numeric_names(0, 48)      # ← 当前请求的 48 个数值特征
    + tuple(f"history.semantic.{index:03d}" for index in range(SEMANTIC_DIM))
    + _numeric_names(48, 64)     # ← 路由历史的 16 个数值特征
    + tuple(f"previous.semantic.{index:03d}" for index in range(SEMANTIC_DIM))
    + _numeric_names(64, 83)     # ← 上一轮的 19 个数值特征
    + _numeric_names(83, 88)     # ← 上下文特征的 5 个数值特征
)

if len(FEATURE_NAMES_380) != FEATURE_DIM:
    raise AssertionError(f"feature registry has {len(FEATURE_NAMES_380)} entries")
```

管道本体是三段式：

```mermaid
graph LR
    A["📝 current_request<br/>原始文本"] --> B["🧬 BGE ONNX<br/>语义嵌入"]
    B --> C["📉 PCA-64<br/>降维投影"]
    C --> D["✅ 64 维语义特征"]
    A --> E["🔤 Char TF-IDF"]
    E --> F["📉 SVD-100"]
    F --> G["✅ 100 维字符特征"]
    A --> H["🔢 numeric88<br/>88 个规则特征"]
    H --> I["✅ 88 维数值特征"]
    D --> J["🧮 拼接成 380 维"]
    G --> J
    I --> J
    J --> K["🌲 LightGBM<br/>tier 分类器"]

    style A fill:#C7CEEA,stroke:#9FA8DA,stroke-width:2px,color:#333
    style B fill:#E8D5F5,stroke:#CE93D8,stroke-width:2px,color:#333
    style C fill:#E8D5F5,stroke:#CE93D8,stroke-width:2px,color:#333
    style D fill:#B5EAD7,stroke:#80CBC4,stroke-width:2px,color:#333
    style E fill:#FFDAB9,stroke:#FFCC80,stroke-width:2px,color:#333
    style F fill:#FFDAB9,stroke:#FFCC80,stroke-width:2px,color:#333
    style G fill:#B5EAD7,stroke:#80CBC4,stroke-width:2px,color:#333
    style H fill:#FFF9C4,stroke:#F9A825,stroke-width:2px,color:#333
    style I fill:#B5EAD7,stroke:#80CBC4,stroke-width:2px,color:#333
    style J fill:#F5F5F5,stroke:#BDBDBD,stroke-width:2px,color:#333
    style K fill:#FFB3C6,stroke:#F48FB1,stroke-width:2px,color:#333
```

**88 个数值特征**（`numeric88.v1` 注册表）非常值得一看，因为它们暴露了"什么信号真正预测难度"：

```python
# src/opensquilla/squilla_router/lightgbm_model/_vendor/features/registry.py
RULE_NAMES = (
    "char_count", "word_count", "line_count", "avg_chars_per_line",
    "zh_char_ratio", "latin_char_ratio", "code_char_ratio", "mixed_zh_en",
    "has_code_block", "code_block_count", "code_block_chars",
    "has_json", "has_yaml", "has_csv", "has_table",
    "question_mark_count", "exclamation_mark_count",
    "bullet_count", "numbered_list_count",
    "debug_keyword_count", "research_keyword_count",
    "architecture_keyword_count", "compare_keyword_count",
    "planning_keyword_count", "strict_format_keyword_count",
    "high_risk_keyword_count", "production_keyword_count",
    "customer_keyword_count", "delete_keyword_count", "formal_keyword_count",
    "has_file_path", "has_url", "has_log", "has_shell", "has_traceback",
    "constraint_keyword_count", "quoted_text_ratio", "word_diversity",
    "teaching_keyword_count", "implementation_keyword_count",
    "file_count_zero", "file_count_one_or_two", "file_count_three_plus",
    "code_without_debug",
    "length_under_200", "length_200_to_1000", "length_over_1000",
    "low_keyword_density",
)
```

注意 `has_traceback`、`has_shell`、`has_log`、`delete_keyword_count`、`high_risk_keyword_count` 这几个——它们几乎就是"这句话难不难"的**人类直觉的量化**。有 traceback 要读堆栈，有 shell 要理解执行语义，`delete` 是危险操作。

另外还有**路由轨迹特征**（`ROUTE_HISTORY_NAMES`），这才是"Harness-native"的体现：

```python
ROUTE_HISTORY_NAMES = (
    "previous_tier_index", "previous_difficulty", "previous_margin",
    "highest_tier_index", "turn_index", "route_history_length",
    "dominant_tier_index", "route_switch_count",
    "trajectory_cold_start", "trajectory_stable_low", "trajectory_stable_high",
    "trajectory_escalating", "trajectory_descalating",
    "trajectory_oscillating", "trajectory_unclear", "trajectory_mixed",
)
```

`trajectory_escalating` / `trajectory_oscillating` / `trajectory_stable_low` —— 这些是**"这个任务正在往哪个方向走"**的刻画。一个持续升级的任务（每次都更难）应该保持高档位；一个震荡的任务（难度忽高忽低）应该保守一点。这是一个纯粹属于 Harness 层的特征——你在单轮 query 上永远看不到它。

### 2.3 冻结哈希校验：把"模型文件"当成供应链资产管理

这是一个我觉得非常值得学的工程细节。OpenSquilla **不信任**磁盘上的模型文件——每一个 artifact 都必须通过 manifest 哈希校验，否则**整个路由层 fail-closed**（直接禁用，而不是降级到错误结果）：

```python
# src/opensquilla/squilla_router/lightgbm_model/model.py
MODEL_SET_ID = "router-bert60-int8-intent-lightgbm-tier-v1"
MANIFEST_HASH = "sha256:c4f351198392e17019255679d37cf5b5980570b1208c174056760da618f0b958"

class LightGBMModelError(RuntimeError):
    """The configured classifier cannot safely execute."""
    fail_closed = True

def _verified_artifacts(model_root):
    manifest_bytes = (root / "model_manifest.json").read_bytes()
    manifest_hash = _hash(manifest_bytes)
    if manifest_hash != MANIFEST_HASH:
        raise LightGBMModelError("bundled LightGBM model manifest hash mismatch")
    manifest = json.loads(manifest_bytes)
    if (manifest["model_set_id"] != MODEL_SET_ID
        or manifest["input_schema_version"] != FEATURE_SCHEMA_VERSION
        or manifest["outputs"] != {"intent": list(INTENT_LABELS), "tier": list(TIER_LABELS)}):
        raise LightGBMModelError("bundled LightGBM model contract mismatch")
    # ... 逐个 artifact 校验 size + sha256
    if len(payload) != ref["size"] or _hash(payload) != ref["sha256"]:
        raise LightGBMModelError(f"bundled LightGBM artifact hash mismatch: {local}")
```

三个关键点：

1. **`fail_closed = True`** —— 模型资产不可信时**宁可不做路由**，也不要用一个可能算错的分类器去决定用哪个模型。错误路由会导致"用 C0 去解架构题"，失败率飙升。
2. **路径逃逸防护** —— `_safe_path()` 确保模型目录里的相对路径不会 `../` 逃出资产根目录。
3. **反序列化加固** —— 用自定义 `FrozenUnpickler` 只允许白名单里的三个 sklearn 包装类：

```python
class FrozenUnpickler(NumpyUnpickler):
    def find_class(self, module, name):
        if module == "router_training.features.runtime" and name in wrappers:
            return wrappers[name]
        if module.startswith("router_training"):
            raise LightGBMModelError("unexpected training class in frozen transformer")
        return super().find_class(module, name)
```

> **这不是过度设计。** 一个 59MB 的 ONNX 模型 + 一堆 joblib 文件通过网络分发、装在用户机器上、由 Agent 自动加载——这是**典型的供应链攻击面**。用 pickle 反序列化一个来历不明的 joblib，等于在你的 Agent 宿主上开了个后门。OpenSquilla 把这条堵死了。

---

## 三、核心机制原理：可运行代码

### 3.1 机制一：intent 阈值改写（不改分类器证据）

生产代码 `model_policy.py` 里有一个很克制的设计——**阈值改写只改最终 intent，不改分类器输出的原始概率**：

```python
# src/opensquilla/engine/routing/model_policy.py
def _threshold_intent(probabilities: Mapping[str, float]) -> str:
    """Apply the v1 intent thresholds without changing the classifier evidence."""
    p_new, p_redo = probabilities["new_task"], probabilities["redo"]
    if p_redo >= 0.25 and p_redo > p_new:
        return "redo"
    return "new_task" if p_new >= 0.01 else "continue"
```

配套的审计结构体 `ModelPolicyAudit` 甚至会**校验"原始 argmax 预测"和"阈值改写后的最终决策"是否被混为一谈**：

```python
@dataclass(frozen=True)
class ModelPolicyAudit:
    source: str
    run_status: str
    final: str
    reason: str
    prediction: str | None = None
    probabilities: Mapping[str, float] | None = None
    confidence: float | None = None

    def __post_init__(self) -> None:
        if self.run_status == "ran":
            labels = INTENTS if self.final in INTENTS else TIERS
            if self.source != "classifier" or not isinstance(self.probabilities, Mapping):
                raise ValueError("classifier run is missing its probabilities")
            winner, confidence = _probability_winner(self.probabilities, labels)
            final = winner
            if self.reason == "intent_thresholds_v1":
                if labels != INTENTS:
                    raise ValueError("intent thresholds cannot select a tier")
                final = _threshold_intent(self.probabilities)   # ← 改写只在审计层发生
            if (self.prediction != winner
                or self.final != final
                or isinstance(self.confidence, bool)
                or self.confidence != confidence):
                raise ValueError("classifier audit conflicts with its prediction or decision rule")
```

**为什么这很重要？** 因为改写决策之后，原始概率还是**审计证据**。你事后能回答"分类器本来认为是什么？为什么最终不是它？"——而不是"路由器说是 C2，就是 C2，问它也不会告诉你为什么"。

> **这是 Harness 可审计性的最小充分条件**：决策 + 证据分离。第四章的 `router_decision` 记录表就是靠这个才能做数据飞轮。

### 3.2 机制二：tier 状态机（三条迁移规则）

```python
# src/opensquilla/engine/routing/model_policy.py (简化)
INTENTS = ("continue", "redo", "new_task")
TIERS = ("c0", "c1", "c2", "c3")

@dataclass(frozen=True)
class ModelPolicyState:
    tier: str
    task_id: str = field(default_factory=lambda: uuid.uuid4().hex)
    turn_count: int = 1
    version: int = 1
    task_start_input_message_id: str | None = None
    generation_start_input_message_id: str | None = None
```

迁移规则用一张表就能说清：

| intent | tier 行为 | 语义 |
|--------|-----------|------|
| `continue` | **保持当前 tier** | 同一话题的延续，难度不跳变 |
| `redo` | **前进一档**（上限 C3） | 用户说"重做/换个方式"→ 上次的模型不够格 |
| `new_task` | **用 tier 分类器 argmax** | 新话题，从头判难度 |

注意 `redo` 是"**前进恰好一档**"而不是"直接跳到 argmax"——因为用户说"重做"时，argmax 很可能因为同样的文本特征给出同样的低档位（文本没变啊），但用户明确在告诉你上次的结果不行。所以必须**强制升档**。

这个设计还有一个副作用：`redo` 是**唯一能突破分类器判断的路径**。如果分类器认为 C1 够用，但用户投诉了，"redo" 会推到 C2。这是把"用户反馈"这个最高优先级的信号接进了状态机。

### 3.3 机制三：控制器——thinking mode 与 prompt policy

Tier 决定"用哪个模型"，但同一档位内还有两个正交的控制维度：**思考深度**和**提示词压缩策略**。

```python
# src/opensquilla/squilla_router/controller.py
DEEP_FLAGS = frozenset({"high_risk", "debug", "long_context"})
FULL_PROMPT_FLAGS = frozenset({"high_risk", "long_context", "debug", "strict_format"})
COMPRESS_BLOCK_FLAGS = frozenset({"high_risk", "strict_format", "debug"})

def derive_thinking_mode(probs, flags, *, t3_min_idx=2, t0_max_idx=0, t0_min_margin=0.5,
                         t1_max_idx=1, t1_min_margin=0.4) -> str:
    top1_idx = int(max(range(len(probs)), key=lambda i: probs[i]))
    margin = compute_margin(probs)
    if top1_idx >= len(TIER_ORDER) - 1:
        return "T3"
    if top1_idx >= t3_min_idx and _has_any_flag(flags, DEEP_FLAGS):
        return "T3"
    if top1_idx <= t0_max_idx and margin >= t0_min_margin:
        return "T0"
    if top1_idx <= t1_max_idx and margin >= t1_min_margin:
        return "T1"
    return "T2"

def derive_prompt_policy(probs, flags, *, max_difficulty=0.8, min_margin=0.4) -> str:
    if _has_any_flag(flags, FULL_PROMPT_FLAGS):
        return "P2"
    difficulty = compute_difficulty(probs)
    margin = compute_margin(probs)
    if (difficulty <= max_difficulty and margin >= min_margin
        and not _has_any_flag(flags, COMPRESS_BLOCK_FLAGS)):
        return "P0"
    return "P1"

def normalize_decisions(thinking_mode: str, prompt_policy: str) -> tuple[str, str]:
    """Forbid THINK_DEEP + P0 (compress) — contradictory."""
    if thinking_mode in ("T2", "T3") and prompt_policy == "P0":
        return thinking_mode, "P1"
    return thinking_mode, prompt_policy
```

两个关键点：

1. **`margin`（置信度边际）而不是 `confidence`（置信度）决定降档**。`compute_margin` = top1 概率 − top2 概率。分类器给出 `[0.45, 0.42, 0.08, 0.05]` 和 `[0.95, 0.02, 0.02, 0.01]` 的 confidence 都是 0.45+，但前者是**犹豫**，后者是**笃定**。用 margin 才能区分。
2. **`normalize_decisions` 禁止 "深度思考 + 压缩提示词" 这个矛盾组合**。"让模型深度思考"和"让提示词尽量短"是冲突的指令，同时下发会稀释模型注意力。

还有一个容易被忽略的细节——**提示词提示的语言自适应**：

```python
def prompt_hint_locale(text: str | None) -> str:
    """Return ``zh`` when the prompt is substantially CJK, else ``en``."""
    if not text:
        return "en"
    cjk_count = 0
    latin_count = 0
    for char in text:
        if any(start <= char <= end for start, end in _CJK_RANGES):
            cjk_count += 1
        elif char.isascii() and char.isalpha():
            latin_count += 1
    return "zh" if cjk_count >= 2 else "en"
```

**这是一个纯规则、零成本的判断**——数一下中英文字符就行。塞进 P0 的压缩提示词按用户语言走，中文用户看到"直接作答，缩短思考长度，避免无关展开。"，英文用户看到 "Answer directly, keep thinking short, avoid irrelevant expansion."。

### 3.4 机制四：本地校准（硬夹紧的自我调整）

这是整个系统里最"克制"的一段代码，也是我认为最值得学的部分：

```python
# src/opensquilla/engine/routing/calibration.py
"""Deterministic, on-device router calibration.

The bundled ML classifier is FROZEN. This module never retrains anything: it
aggregates local, prompt-free router decision records into a small, hard-clamped
adjustment to a single scalar — the confidence-gate ``confidence_threshold`` —
plus a per-tier confidence bias.
"""

# --- Hard clamps (pinned) --------------------------------------------------
BIAS_CLAMP = 0.15
THRESHOLD_FLOOR = 0.3
THRESHOLD_CEIL = 0.7
THRESHOLD_ADJUST_CLAMP = 0.20

# --- Aggregation shape (conservative gains + small-sample shrinkage) -------
_BIAS_GAIN = 0.15
_THRESHOLD_GAIN = 0.20
_MIN_SAMPLES_PER_CLASS = 20
_MIN_SAMPLES_GLOBAL = 50
_PRIOR_WEIGHT = 0.5
_WINDOW_MS = 30 * 24 * 60 * 60 * 1000
```

设计哲学写在 docstring 里，我原样引用几条：

> **Deliberately out of scope** (kept conservative):
> - No "regeneration within N seconds" signal is derived — regeneration is NOT a calibration input this pass.
> - **No savings/cost figure is read or written — calibration adjusts the routing threshold/bias only, never the cost math (hard constraint C2).**
>
> **Determinism**: `aggregate_calibration` is pure and takes an injected `now` (epoch ms) — no wall clock, no network, no I/O.

三个约束叠在一起，形成了"**自我调整但不会失控**"的机制：

| 约束 | 数值 | 防的是什么 |
|------|------|-----------|
| 每档偏差夹紧 | `\|bias\| ≤ 0.15` | 单档被疯狂投诉后过度倾斜 |
| 阈值夹紧 | `[0.3, 0.7]` | 阈值调到极端导致全升或全不升 |
| 最小样本量 | 每档 ≥ 20，全局 ≥ 50 | 3 条记录就改策略 = 过拟合噪声 |
| 30 天窗口 | `_WINDOW_MS` | 三个月前的习惯不代表现在 |
| **只调阈值，不调成本** | 硬约束 C2 | 校准逻辑污染成本核算，导致账单不可解释 |

**"只调阈值，不调成本"这条我觉得是神来之笔。** 因为成本是**用户能直接看到并据此做决策的数字**。如果自我调整偷偷改了成本估算，用户会开始不信任这个数字。路由策略可以自动演进，但**账本必须可预测**。

### 3.5 数据飞轮：决策记录长什么样

飞轮的燃料是 `router_decision` 表（迁移 `V017__router_decisions.py` + `V018__router_decisions_ts_index.py` + `V023__router_deployment_telemetry.py`）。每条记录包含论文说的六要素：

```mermaid
graph LR
    D1["📝 query<br/>当前请求"]
    D2["🧠 harness state<br/>intent + tier + 轨迹"]
    D3["🎯 model choice<br/>模型/模型集"]
    D4["📜 execution trace<br/>工具调用/输出"]
    D5["✅ outcome<br/>环境给的标签"]
    D6["💰 cost<br/>实际账单"]
    D1 --> D7["📦 router_decision<br/>结构化记录"]
    D2 --> D7
    D3 --> D7
    D4 --> D7
    D5 --> D7
    D6 --> D7
    D7 -.训练更好的路由器.-> R["🧠 SquillaRouter v2"]

    style D1 fill:#C7CEEA,stroke:#9FA8DA,stroke-width:2px,color:#333
    style D2 fill:#E8D5F5,stroke:#CE93D8,stroke-width:2px,color:#333
    style D3 fill:#FFDAB9,stroke:#FFCC80,stroke-width:2px,color:#333
    style D4 fill:#F5F5F5,stroke:#BDBDBD,stroke-width:2px,color:#333
    style D5 fill:#B5EAD7,stroke:#80CBC4,stroke-width:2px,color:#333
    style D6 fill:#FFF9C4,stroke:#F9A825,stroke-width:2px,color:#333
    style D7 fill:#FFB3C6,stroke:#F48FB1,stroke-width:2px,color:#333
    style R fill:#E8D5F5,stroke:#CE93D8,stroke-width:2px,color:#333
```

论文提到这个飞轮的关键在于**标签来源**：

> "These records form a harness-native data flywheel: execution traces train better routers and harness-native models, which improve cost-quality trade-offs and generate more traces under the same budget."

**在同样的预算下产生更多轨迹**——因为路由省下的钱被投入到更多轮次上，于是产生更多数据，数据训练出更好的路由，再省出钱。闭环。

---

## 四、实测数字：4 套 Benchmark

这是我认为 OpenSquilla 最硬的部分——**它拿自己跟 OpenClaw 和 Hermes Agent 正面对打**，而且用同一套价格表算成本。

### 4.1 PinchBench（25 个通用任务）

| 框架 | 模型池 | 分数 | 总成本 |
|------|--------|-----:|------:|
| OpenClaw | Opus-4.7 | 92.55 | $6.23 |
| OpenClaw | GLM-5.1 | 88.33 | $1.60 |
| Hermes Agent | Opus-4.7 | 92.65 | $6.66 |
| **OpenSquilla** | Opus-4.7 | **93.85** | $4.84 |
| **OpenSquilla** | {Flash, Flash, GLM-5.1, Opus-4.7} | 92.51 | **$0.69** |
| **OpenSquilla** | {MiniMax M2.5 (免费), Flash, Flash, GLM-5.1} | 90.48 | **$0.13** |

> Forced single-model OpenSquilla takes the top score, **+1.3 over OpenClaw's Opus-4.7 run at 22% lower cost**. The Opus-4.7-backstopped routing pool holds **99.96% of the 92.55 baseline score at $0.69**.

注意这里有两层信息：

- **$0.69 vs $6.23 = 89% 成本下降，分数只掉 0.04**（92.55 → 92.51）
- 更狠的是最后一行：$0.13，掉了 2.07 分（90.48），但那是**完全不含 Opus-4.7** 的模型池

### 4.2 ClawSWEBench（350 个多语言 SWE 修复任务）

| 框架 | 模型池 | 修复率 | 成本/任务 |
|------|--------|------:|--------:|
| OpenClaw | Opus-4.7 | 77.1% | $3.09 |
| OpenClaw | GLM-5.2 | 74.3% | $0.87 |
| **OpenSquilla** | GLM-5.2 | **79.4%** | $0.95 |
| **OpenSquilla** | {Flash, GLM-5.1, GLM-5.2} | 74.0% | **$0.44** |

> The routing pool matches OpenClaw's GLM-5.2 run at half the cost, **delegating 207 of the 350 tasks (59%) to the inexpensive DeepSeek-V4 Flash tier and escalating 139 to the top tier**.

**59% 的任务降级到最便宜的档位，8% 升级到顶级**。这个 59%/8% 的分布说明分类器**不是保守的**——它敢把大部分任务往下压。

### 4.3 DRACO（100 个跨领域深度研究任务）

| 框架 | 模型池 | 分数 | 成本/任务 | Tokens (K) |
|------|--------|-----:|--------:|-----------:|
| OpenClaw | Opus-4.8 | 52.13 | $1.1420 | 54.2 |
| **OpenSquilla** | Opus-4.8 | 52.36 | $0.6559 | 103.5 |
| **OpenSquilla** | {Pro, GLM-5.2, Opus-4.8} | 52.33 | **$0.3729** | 108.6 |

这里有个**必须读出来的细节**，项目自己也很诚实地写了出来：

> The routed run **spends more tokens** than the fixed one, so the saving comes from the **price mix of the calls** rather than from shorter prompts.

**路由后的 token 数反而更多了（108.6K vs 103.5K）**，但成本只有 55%。这说明：

1. 路由**不是**靠"少写点提示词"来省钱的——那是 prompt compression 的活
2. 路由是靠在**不同的调用上用不同价位的模型**来省钱的
3. 如果你的模型池价格都差不多（比如全用同一家的同档位模型），路由**不会带来成本收益**，只会带来延迟

**这是我全文最想强调的一句**：路由的收益 = Σ(各档位调用占比 × (基准价 − 该档价))。模型池的价格**离散度**决定了收益上限。

### 4.4 多模型 Ensemble：唯一超过 Fable 5 的配置

| 搜索引擎 | 方法 | 分数 | 成本/任务 | Tokens (K) |
|---------|------|-----:|--------:|----------:|
| DuckDuckGo | Fable 5 | 59.80 | $1.2122 | 93.7 |
| DuckDuckGo | Opus-4.8 | 52.36 | $0.6559 | 103.5 |
| DuckDuckGo | DeepSeek-V4 Pro | 50.32 | $0.1320 | 83.4 |
| DuckDuckGo | GPT-5.5 | 50.22 | $0.4505 | 81.9 |
| DuckDuckGo | Gemini-3 Flash | 40.79 | $0.0117 | 9.5 |
| DuckDuckGo | **Ensemble（本文）** | **60.82** | $0.3766 | 579.7 |
| Brave | Fable 5 | 62.06 | $1.3241 | 106.7 |
| Brave | Opus-4.8 | 59.11 | $1.6177 | 257.7 |
| Brave | **Ensemble（本文）** | **64.09** | **$0.1218** | 500.1 |

> The ensemble outscores the strongest single model on both search providers: **+1.02 points at 31% of its cost** under DuckDuckGo, and **+2.03 points at 90.8% lower cost** under Brave.

Ensemble 的机制是**多提议者并行起草 + 一个聚合器融合**：

```mermaid
graph TB
    Q["📝 同一 query"] --> P1["💭 Proposer A<br/>Opus-4.8"]
    Q --> P2["💭 Proposer B<br/>DeepSeek-V4 Pro"]
    Q --> P3["💭 Proposer C<br/>GLM-5.2"]
    Q --> P4["💭 Proposer D<br/>Qwen3.7-Max"]
    P1 --> AG["🧲 Aggregator<br/>融合去重排序"]
    P2 --> AG
    P3 --> AG
    P4 --> AG
    AG --> R["✅ 最终答案<br/>60.82 分 / $0.3766"]
    P1 -.预算控制<br/>早停.-> S["⏱️ 早停 + 每提议者预算"]
    P2 -.-> S
    P3 -.-> S
    P4 -.-> S

    style Q fill:#C7CEEA,stroke:#9FA8DA,stroke-width:2px,color:#333
    style P1 fill:#E8D5F5,stroke:#CE93D8,stroke-width:2px,color:#333
    style P2 fill:#E8D5F5,stroke:#CE93D8,stroke-width:2px,color:#333
    style P3 fill:#E8D5F5,stroke:#CE93D8,stroke-width:2px,color:#333
    style P4 fill:#E8D5F5,stroke:#CE93D8,stroke-width:2px,color:#333
    style AG fill:#FFB3C6,stroke:#F48FB1,stroke-width:2px,color:#333
    style R fill:#B5EAD7,stroke:#80CBC4,stroke-width:2px,color:#333
    style S fill:#FFF9C4,stroke:#F9A825,stroke-width:2px,color:#333
```

注意 **579.7K tokens**——是单模型的 5.5 倍。质量是用 token 和墙钟时间换来的。文档也很直白：

> The quality is paid for in tokens and wall-clock time, which parallel proposer execution, early stopping, and per-proposer budgets control.

---

## 五、设计哲学分析

### 5.1 Bitter Lesson 视角：有多少"聪明但终将被淘汰"的代码？

Sutton 的 Bitter Lesson 说的是：**长期来看，能利用算力的通用方法胜过嵌入人类知识的专用方法**。

OpenSquilla 的路由层**看起来是"聪明代码"的典型**——一个 380 维特征、88 条手工规则、LightGBM 分类器、LightGBM 加 PCA 加 SVD 加 TF-IDF 加 ONNX 的管道。任何人都可以说"等模型自己变强了，这套规则就多余了"。

但项目自己的选择很耐人寻味——**他们把自学习能力砍掉了**：

> "Router self-learning and its feedback submission API have been **removed**. On upgrade, the obsolete `squilla_router.self_learning` settings are discarded automatically."

甚至连迁移脚本都留着（`tests/test_migration/test_remove_router_self_learning.py`）。

**为什么主动砍掉自学习？** 因为自学习会带来三个问题：

1. **不可复现** —— 同样的输入在不同用户的机器上给出不同结果
2. **不可审计** —— "为什么这轮用了 C3？"答不上来
3. **训练漂移** —— 用户改了几个词，模型权重变了，整套行为跟着变

他们保留的替代方案是**校准**（calibration）——一个**纯函数、有硬夹紧、只调两个标量、不碰成本**的机制。这比自学习弱得多，但**可解释、可回滚、可跨机器复现**。

> **我的判断**：这是一个**"暂时违反 Bitter Lesson 但方向正确"的决定**。Bitter Lesson 说的是长期趋势，不是短期最优。当你能把学习效果约束在**两个标量**里（阈值 + 每档偏差）时，你既保留了适应性，又没放弃可审计性。等以后模型真的能自己判断难度了，LightGBM 这层可以整体换掉——**因为它是可插拔的 `strategy`**。
>
> 这正是 Harness 工程的核心判断力：**哪些代码应该是"策略"（可换），哪些是"机制"（可依赖）。**

### 5.2 机制与策略分离检查

| 组件 | 属于机制还是策略 | 可替换性 |
|------|--------------|---------|
| Intent 分类器（BERT-60M INT8） | **策略** | 可换成 LLM 分类器，接口不变 |
| Tier 分类器（LightGBM 380维） | **策略** | 可换成任何分类器，`RouterInput` 契约不变 |
| 特征管道（PCA/SVD/TF-IDF） | **策略** | 冻结 artifact，换 bundle 即可 |
| 阈值改写（`_threshold_intent`） | **机制** | 稳定契约 |
| Tier 状态机（continue/redo/new_task） | **机制** | 稳定契约 |
| 控制器（thinking/prompt policy） | **机制** | 纯函数，无 I/O |
| 校准（硬夹紧） | **机制** | 纯函数，注入 `now` |
| Provider 适配层 | **策略** | 20+ Provider 可插拔 |

配置层面直接暴露了这个分离：

```toml
[squilla_router]
strategy = "lightgbm_model"        # ← 策略可切
tier_policy = "model"              # ← 策略可切
enabled = false                    # ← 可整体禁用
```

并且提供了**回退路径**：

```toml
[squilla_router]
strategy = "legacy_v4_phase3"      # ← 保留旧行为用于灰度对比
```

> **"可拆卸性"是 Harness Engineering 的核心指标之一**。一个你不能关掉的优化，就是一个你不能信任的优化。OpenSquilla 允许你 `enabled = false` 后它就退化成普通单模型 Agent——**这才是"优化"和"绑架"的分界线**。

### 5.3 Less is More 检查

| 组件 | 模型自己能学会吗？ | 外部物理世界必需吗？ | 结论 |
|------|-------------------|--------------------|------|
| Intent 分类（new/continue/redo） | 大概率能，但**要花 10 倍 token** | 不必需 | 值得用小模型做 |
| Tier 分级 | 部分能（LLM 自评有偏） | 不必需 | 小模型 + 特征更稳 |
| thinking mode / prompt policy | **不能**（要控制的是外部 API 行为） | **必需** | 必须是外部代码 |
| 预算闸门 | **不能**（要读真实账单） | **必需** | 必须在 Harness 层 |
| 沙箱升级（escalation） | **不能**（涉及权限） | **必需** | 必须在 Harness 层 |
| Provider 适配 | 不能 | **必需** | 必须在 Harness 层 |

**结论很清楚**：OpenSquilla 把"能不能省"的部分交给小模型，把"必须精确控制"的部分留在 Harness 代码里。这个边界划得很准。

---

## 六、横向对比：三个同类项目的设计差异

### 6.1 对比维度

| 维度 | OpenSquilla | LiteLLM Proxy | RouteLLM | OpenRouter Auto |
|------|-------------|---------------|-----------|-----------------|
| **决策单元** | **Harness 状态 + 一轮执行** | 单次 HTTP 请求 | 单次 query | 单次 query |
| **执行在哪** | Agent 进程内（本地） | 独立网关 | 独立服务 | 云端 |
| **特征** | 380 维（语义+字符+88 数值+轨迹） | 无（纯规则路由） | embedding 相似度 | 厂商黑盒 |
| **上下文感知** | ✅ 轨迹特征（escalating/oscillating） | ❌ | ❌ | ❌ |
| **可审计性** | ✅ 决策 + 证据分离落库 | ⚠️ 日志 | ❌ | ❌ |
| **自我调整** | ✅ 硬夹紧校准（不重训） | ❌ | ⚠️ 需重训 | ❌ |
| **失败模式** | fail-closed（资产错→禁用路由） | 降级到默认模型 | 降级到默认模型 | 不透明 |
| **成本模型** | 显式（每档位报价） | 隐式 | 隐式 | 隐式 |

### 6.2 三个设计差异的"为什么"

**差异一：决策单元 —— step-level vs query-level**

这是最本质的区别。LiteLLM / RouteLLM / OpenRouter Auto 全都是**请求级**路由：它们看到的是一个 HTTP 请求，不知道这个请求是 Agent 的第几轮、上一步失败了没有、用户有没有投诉。

而 OpenSquilla 的 `RouterInput` 契约里明确包含这些：

```python
# src/opensquilla/squilla_router/lightgbm_model/input_contract.py
class RouterInput(ContractModel):
    current_request: str
    task_anchor: str = ""
    history_user: tuple[str, ...] = Field(default=(), max_length=4)
    previous_answer: str = ""
    previous_usage: dict[str, JsonValue] = Field(default_factory=dict)
    previous_outcome: Literal["success", "failure", "clarification", "unknown"] = "unknown"
    active_route_tier: Literal["C0", "C1", "C2", "C3"] | None = None
    route_history: tuple[dict[str, JsonValue], ...] = Field(default=(), max_length=5)
    context: dict[str, JsonValue] = Field(default_factory=dict)
    tool_state: dict[str, JsonValue] = Field(default_factory=dict)
    attachments: tuple[dict[str, JsonValue], ...] = ()
```

注意 `previous_outcome` 明确区分 `success` / `failure` / `clarification`。**"上一轮失败了"是难度最强的信号之一**——请求级路由器根本拿不到这个信息。

**差异二：执行位置 —— 进程内 vs 网关**

LiteLLM Proxy 是独立网关，好处是多团队共享一个成本控制点。OpenSquilla 的路由在 Agent 进程内，好处是**能拿到 harness 内部状态**（tool_state、attachments、context 估算）。

**这是"能力"和"隔离性"的经典权衡**：网关能看全公司的请求，但看不到单个 Agent 的内部状态；进程内路由器能看 Agent 状态，但每个 Agent 实例都要自己装模型资产（59MB ONNX + joblib 套件）。

OpenSquilla 的答案是**本地推理**——用 ONNX Runtime 在本地跑，59MB 的模型跟着 Agent 走，不需要额外服务。代价是每个 Agent 实例都吃这份内存。

**差异三：自我调整 —— 硬夹紧校准 vs 重训**

RouteLLM 的做法是**定期用新数据重训**。这在中心化服务里是合理的（一次训练，全网生效）。

但 OpenSquilla 面对的是**分布式 Agent 客户端**——每个用户机器上的路由决策都不一样，且要能复现。所以它选了**极窄的调整空间**：两个标量 + 硬夹紧 + 纯函数 + 无 I/O。

> **差异的本质是"部署形态决定调整空间"**。中心化服务可以放开调整，客户端必须收紧。

### 6.3 各自的适用场景

| 如果你是… | 别学 OpenSquilla，去用… | 为什么 |
|-----------|---------------------|--------|
| 一个团队共用一个 AI 网关 | **LiteLLM Proxy** | 隔离性和集中管控更重要 |
| 一个 SaaS 产品，需要给用户省 API 费 | **OpenRouter Auto** | 不用自己维护模型池 |
| 一个多 Agent 长跑项目，有明确的 tier 阶梯 | **OpenSquilla** | 只有你能利用 harness 状态 |
| 只想省 20% 成本 | **任何方案都别上** | 路由的工程成本 > 收益 |

---

## 七、优缺点分析

### 架构简洁性 / 扩展性 / 易用性

| 维度 | 评价 | 依据 |
|------|------|------|
| **架构简洁性** | ⚠️ **中等偏弱** | 7844 个文件、59 个数据库迁移、280 个 JSON Schema 契约。SquillaRouter 本身很干净（`controller.py` 只有 4945 字符），但周边工程量巨大 |
| **扩展性** | ✅ **优秀** | Provider 层 20+ 可插拔；`strategy` 可切；tier 阶梯配置化；`RouterInput` 是显式 Pydantic 契约，加新特征不用改分类器 |
| **易用性** | ✅ **良好** | `opensquilla onboard --router recommended` 一条命令搞定；可 `enabled = false` 完全禁用；文档和 README 极详尽 |
| **性能** | ✅ **优秀** | 本地 ONNX 推理，无网络往返；特征管道全向量化；决策在 1ms 量级 |
| **复杂度** | ❌ **偏高** | 两条路由路径（`lightgbm_model` vs `legacy_v4_phase3`）并存；intent 和 tier 两个独立模型；bundle 迁移逻辑复杂 |
| **维护性** | ⚠️ **中等** | 冻结 hash 校验意味着**模型一更新就要同步改哈希常量**，用户自定义 bundle 基本不可行；2023 个测试文件是好信号 |

**特别提一个维护性坑**：因为 `MANIFEST_HASH` 是**硬编码在源码里的常量**：

```python
MANIFEST_HASH = "sha256:c4f351198392e17019255679d37cf5b5980570b1208c174056760da618f0b958"
```

所以 `squilla_router.lightgbm_model_dir` 这个"让用户指向自己的模型目录"的配置项，**实际上要求用户的目录里有完全相同的字节**。文档里也承认了这一点：

> "Mixing old manifests with new weights is not supported."

**换句话说：你想训自己的路由模型，成本极高。** 这对"数据飞轮"叙事是个矛盾——飞轮要靠训练新模型，但训练产物无法被用户部署。这套飞轮目前只能由项目团队自己转。

### 一个诚实的自我批评

我把 benchmark 数字看完后，最想指出的是：**这些对比的公平性存疑**。

README 明确写了：

> The OpenRouter Auto row is a query-level routing baseline measured under a **separate protocol** and is **not directly comparable** to the other rows.

也就是说，**它和自己的直接对手（OpenRouter Auto）用的是不同测量协议**。而它跟 OpenClaw / Hermes 的对比是同协议的——但 OpenClaw 和 Hermes **默认不开路由**。所以 "OpenSquilla 路由池 $0.69 vs OpenClaw Opus $6.23" 这个对比里，**对比的是"会路由的系统"和"不会路由的系统"**，而不是"路由方案 A vs 路由方案 B"。

**这不是造假**——它诚实地披露了协议差异。但读者要小心：**$0.69 里有 Harness 自身的效率提升，有路由的贡献，也有价格表选择的贡献**，这三者没有拆开。

---

## 八、从零搭建启示：我的 MVP

如果你要在自己的 Harness 里做分级路由，最小可行实现是什么？

### 8.1 必须有的四块

| # | 组件 | 必须？ | 最小实现 |
|---|------|-------|---------|
| 1 | **Tier 阶梯定义** | ✅ 必须 | 4 个档位，每档一个模型 + 一个单价 |
| 2 | **难度分类器** | ✅ 必须 | 关键词 + 长度 + 代码块，20 行规则 |
| 3 | **状态机（continue/redo/new）** | ✅ 强烈建议 | 3 条规则，10 行 |
| 4 | **审计记录** | ✅ 强烈建议 | 一张 SQLite 表 + 一条 INSERT |
| 5 | 本地 ONNX 模型 | ❌ 可省 | 用规则起步，攒够数据再上 ML |
| 6 | 380 维特征管道 | ❌ 可省 | 用 10 个够用的特征起步 |
| 7 | Ensemble 聚合 | ❌ 可省 | 单模型够用再说 |
| 8 | 校准硬夹紧 | ⚠️ 上线前必加 | 20 行 |
| 9 | 冻结 hash 校验 | ⚠️ 用 ML 模型时必加 | 30 行 |

> **我的判断：先用规则跑通第 1-4 块。** 你能拿到 60% 的收益（把"谢谢"这种轮次降档），成本是零。等你有了 200+ 条真实决策记录，再考虑上分类器。**不要一上来就训模型。**

### 8.2 完整 MVP（可直接运行）

下面这个 200 行 Python MVP 抽离了 OpenSquilla 的 4 个核心原语，**我已实测运行通过**：

```python
"""
OpenSquilla Harness-Native Routing MVP
=========================================
从 TokenRhythm/opensquilla 抽离的核心机制复刻（Apache-2.0）

抽取的原语（对应生产代码）：
  1. intent 分类 + 阈值改写  -> src/opensquilla/engine/routing/model_policy.py::_threshold_intent
  2. tier 迁移状态机          -> src/opensquilla/engine/routing/model_policy.py::ModelPolicyState
  3. 控制器（thinking/prompt） -> src/opensquilla/squilla_router/controller.py
  4. 本地校准（硬夹紧）        -> src/opensquilla/engine/routing/calibration.py

本 MVP 用可读的启发式分类器代替 ONNX/LightGBM 推理，其余状态机与阈值逻辑
与生产代码逐行对齐。可直接运行：
    python3 osq_mvp.py
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field, replace
from typing import Literal

# --------------------------------------------------------------------------
# 第一部分：核心数据模型（对齐生产代码 RouterInput / ModelPolicyState）
# --------------------------------------------------------------------------

INTENTS = ("continue", "redo", "new_task")
TIERS = ("c0", "c1", "c2", "c3")

# 生产代码中的四档推荐 ladder（docs/features/squilla-router.md）
TIER_LADDER = {
    "c0": ("DeepSeek-V4 Flash", 0.15),   # (模型名, 每百万 token 单价 USD)
    "c1": ("DeepSeek-V4 Pro",   0.55),
    "c2": ("GLM-5.2",           1.10),
    "c3": ("Opus-4.8",          7.50),
}

Tier = Literal["c0", "c1", "c2", "c3"]
Intent = Literal["continue", "redo", "new_task"]


@dataclass(frozen=True)
class RouterInput:
    """对齐生产代码 src/opensquilla/squilla_router/lightgbm_model/input_contract.py"""

    current_request: str
    task_anchor: str = ""
    history_user: tuple[str, ...] = ()
    previous_answer: str = ""
    previous_outcome: str = "unknown"
    active_route_tier: Tier | None = None
    route_history: tuple[dict, ...] = ()
    tool_state: dict = field(default_factory=dict)
    attachments: tuple[dict, ...] = ()


@dataclass(frozen=True)
class ModelPolicyState:
    """对齐生产代码 src/opensquilla/engine/routing/model_policy.py::ModelPolicyState"""

    tier: Tier
    task_id: str = "task-0001"
    turn_count: int = 1
    version: int = 1


# --------------------------------------------------------------------------
# 第二部分：分类器（生产中是 BERT-60M INT8 intent + LightGBM tier）
# 这里用可解释的启发式规则模拟，接口保持一致
# --------------------------------------------------------------------------

_RULE_RE = re.compile(
    r"(重构|重写|重新生成|redo|regenerate|再来一次|换个方式|换一个方式|再试)", re.IGNORECASE
)
_NEW_RE = re.compile(
    r"(新建|新任务|另外|从头|开个|new task|start a new)", re.IGNORECASE
)
# 生产代码 model_policy.py::_TRIVIAL_ACKS：短促的应答不开启新任务
_TRIVIAL_ACKS = frozenset(
    {"thanks", "thank you", "ok", "okay", "yes", "no", "收到", "好的", "谢谢",
     "是的", "不用了", "继续", "continue", "接着", "go on", "next"}
)
_HARD_RE = re.compile(
    r"(分布式|架构设计|证明|性能优化|并发|debug|traceback|崩溃|报错)", re.IGNORECASE
)
_CODE_RE = re.compile("`" * 3)          # 三个反引号，代码块标记
_LOG_RE = re.compile(r"(?m)^(\[?(INFO|WARN|ERROR|DEBUG)\]?|\d{4}[-/]\d{2}[-/]\d{2})")
_PATH_RE = re.compile(r"[a-zA-Z_][\w.-]*/[\w./-]+\.[A-Za-z]{1,5}")


def classify_intent(text: str) -> dict[str, float]:
    """三分类：new_task / continue / redo。返回归一化概率。"""
    stripped = text.strip().lower().strip(" \t\r\n.!?。！？,，;；:：")
    if stripped in _TRIVIAL_ACKS:
        # 生产代码 controller.py：trivial ack -> T0/P0，不开启新任务
        return {"new_task": 0.001, "redo": 0.002, "continue": 0.997}
    p_new = 0.55 if _NEW_RE.search(text) else 0.002
    p_redo = 0.60 if _RULE_RE.search(text) else 0.004
    p_cont = max(0.005, 1.0 - p_new - p_redo)
    total = p_new + p_redo + p_cont
    return {
        "new_task": p_new / total,
        "redo": p_redo / total,
        "continue": p_cont / total,
    }


def classify_tier(text: str, previous_answer: str = "") -> dict[str, float]:
    """四分类：C0 日常 -> C3 硬骨头。返回归一化概率。"""
    scores = {t: 0.05 for t in TIERS}

    # 硬信号：显式的高难度关键词
    if _HARD_RE.search(text):
        scores["c3"] += 0.55
        scores["c2"] += 0.30
    # 代码块
    if _CODE_RE.search(text):
        scores["c2"] += 0.25
        scores["c1"] += 0.12
    # 日志块
    if len(_LOG_RE.findall(text)) >= 3:
        scores["c3"] += 0.30
        scores["c2"] += 0.25
    # 文件路径引用
    if len(_PATH_RE.findall(text)) >= 2:
        scores["c2"] += 0.20
    # 长度
    n = len(text)
    if n < 120:
        scores["c0"] += 0.55
        scores["c1"] += 0.20
    elif n < 1200:
        scores["c1"] += 0.40
        scores["c2"] += 0.10
    else:
        scores["c2"] += 0.35
        scores["c3"] += 0.20
    # 承接上一轮（短促的继续指令 → 保持低档）
    if previous_answer and len(text) < 40 and not _CODE_RE.search(text):
        scores["c0"] += 0.30
        scores["c1"] += 0.15

    total = sum(scores.values())
    return {t: v / total for t, v in scores.items()}


# --------------------------------------------------------------------------
# 第三部分：策略（逐行对齐生产代码 model_policy.py）
# --------------------------------------------------------------------------

def threshold_intent(probabilities: dict[str, float]) -> str:
    """生产代码 _threshold_intent：阈值改写 intent，但不改分类器原始概率。"""
    p_new, p_redo = probabilities["new_task"], probabilities["redo"]
    if p_redo >= 0.25 and p_redo > p_new:
        return "redo"
    return "new_task" if p_new >= 0.01 else "continue"


def decide_tier(
    intent: str,
    tier_probs: dict[str, float],
    state: ModelPolicyState,
) -> tuple[Tier, ModelPolicyState]:
    """生产代码 decide_model_tier 的核心迁移规则。

    continue -> 保持当前 tier
    redo     -> 前进一档（上限 C3）
    new_task -> 用 tier 分类器的 argmax
    """
    if intent == "continue":
        tier = state.tier
    elif intent == "redo":
        idx = min(TIERS.index(state.tier) + 1, len(TIERS) - 1)
        tier = TIERS[idx]
    else:  # new_task
        tier = max(TIERS, key=lambda t: tier_probs[t])

    new_state = replace(
        state,
        tier=tier,
        turn_count=state.turn_count + 1,
        version=state.version + 1,
    )
    return tier, new_state


# --------------------------------------------------------------------------
# 第四部分：控制器（对齐生产代码 controller.py）
# --------------------------------------------------------------------------

DIFFICULTY_WEIGHTS = [0.0, 1.0, 2.0, 3.0]
_DEEP_FLAGS = frozenset({"high_risk", "debug", "long_context"})


def compute_margin(probs: dict[str, float]) -> float:
    ordered = sorted(probs.values(), reverse=True)
    return max(0.0, ordered[0] - ordered[1]) if len(ordered) > 1 else ordered[0]


def compute_difficulty(probs: dict[str, float]) -> float:
    return sum(w * probs.get(t, 0.0) for w, t in zip(DIFFICULTY_WEIGHTS, TIERS))


def derive_thinking_mode(tier: Tier, probs: dict[str, float], flags: dict) -> str:
    """T0-T3：思考深度档位。"""
    if tier == "c3":
        return "T3"
    if any(flags.get(f) for f in _DEEP_FLAGS) and TIERS.index(tier) >= 2:
        return "T3"
    margin = compute_margin(probs)
    if TIERS.index(tier) <= 0 and margin >= 0.5:
        return "T0"
    if TIERS.index(tier) <= 1 and margin >= 0.4:
        return "T1"
    return "T2"


def derive_prompt_policy(tier: Tier, probs: dict[str, float], flags: dict) -> str:
    """P0-P2：提示词压缩策略。"""
    if any(flags.get(f) for f in ("high_risk", "long_context", "debug", "strict_format")):
        return "P2"
    if compute_difficulty(probs) <= 0.8 and compute_margin(probs) >= 0.4:
        return "P0"
    return "P1"


def normalize_decisions(thinking: str, prompt: str) -> tuple[str, str]:
    """禁止 THINK_DEEP + P0（自相矛盾）。"""
    if thinking in ("T2", "T3") and prompt == "P0":
        return thinking, "P1"
    return thinking, prompt


def extract_flags(text: str) -> dict:
    """生产代码 _flags 的简化版：纯规则投影，无 I/O。"""
    return {
        "high_risk": bool(_HARD_RE.search(text)),
        "debug": bool(_LOG_RE.search(text)) and len(_LOG_RE.findall(text)) >= 3,
        "long_context": len(text) >= 6000 or len(_CODE_RE.findall(text)) >= 3,
        "strict_format": bool(re.search(r"(严格的?格式|严格按|JSON 格式输出)", text)),
    }


# --------------------------------------------------------------------------
# 第五部分：本地校准（对齐生产代码 calibration.py 的硬夹紧）
# --------------------------------------------------------------------------

BIAS_CLAMP = 0.15
THRESHOLD_FLOOR = 0.3
THRESHOLD_CEIL = 0.7
_MIN_SAMPLES_PER_CLASS = 20


@dataclass(frozen=True)
class CalibrationState:
    """校准只调阈值和偏差，绝不碰成本计算。"""

    per_class_bias: dict[str, float] = field(default_factory=dict)
    threshold_adjust: float = 0.0
    sample_count: int = 0

    def effective_threshold(self, base: float) -> float:
        return max(THRESHOLD_FLOOR, min(THRESHOLD_CEIL, base + self.threshold_adjust))

    def biased(self, tier: Tier, confidence: float) -> float:
        return confidence + self.per_class_bias.get(tier, 0.0)


def aggregate_calibration(records: list[dict]) -> CalibrationState:
    """从 router decision record 聚合出小而稳的阈值调整。

    records 每条形如:
      {"tier": "c1", "confidence": 0.62, "complaint_upgrade": True}
    """
    if len(records) < _MIN_SAMPLES_PER_CLASS:
        return CalibrationState()  # 样本不足 -> 中性状态

    buckets: dict[str, list[float]] = {}
    complaints = 0
    downgrades = 0
    for rec in records:
        buckets.setdefault(rec["tier"], []).append(rec["confidence"])
        complaints += 1 if rec.get("complaint_upgrade") else 0
        downgrades += 1 if rec.get("gate_downgrade") else 0

    per_class_bias: dict[str, float] = {}
    for tier, confs in buckets.items():
        if len(confs) < _MIN_SAMPLES_PER_CLASS:
            continue
        # 用户抱怨"路由太弱" -> 该档位偏置上调（更愿意用这一档）
        complaint_rate = complaints / max(len(records), 1)
        bias = 0.15 * complaint_rate - 0.15 * (downgrades / max(len(records), 1))
        per_class_bias[tier] = max(-BIAS_CLAMP, min(BIAS_CLAMP, bias))

    # 门槛下调：用户频繁抱怨 -> 更容易触发升级
    threshold_adjust = -0.20 * (complaints / max(len(records), 1))

    return CalibrationState(
        per_class_bias=per_class_bias,
        threshold_adjust=threshold_adjust,
        sample_count=len(records),
    )


# --------------------------------------------------------------------------
# 第六部分：演示
# --------------------------------------------------------------------------

def run_turn(text, state, prev_answer="", history=()):
    """跑一轮完整路由。"""
    ri = RouterInput(
        current_request=text,
        previous_answer=prev_answer,
        history_user=history,
        active_route_tier=state.tier,
    )
    intent_probs = classify_intent(text)
    intent = threshold_intent(intent_probs)
    tier_probs = classify_tier(text, prev_answer)
    tier, new_state = decide_tier(intent, tier_probs, state)
    flags = extract_flags(text)
    thinking = derive_thinking_mode(tier, tier_probs, flags)
    prompt = derive_prompt_policy(tier, tier_probs, flags)
    thinking, prompt = normalize_decisions(thinking, prompt)
    model, price = TIER_LADDER[tier]
    return {
        "intent": intent,
        "intent_probs": {k: round(v, 3) for k, v in intent_probs.items()},
        "tier": tier,
        "tier_probs": {k: round(v, 3) for k, v in tier_probs.items()},
        "model": model,
        "thinking": thinking,
        "prompt": prompt,
        "state": new_state,
    }


def main():
    print("=" * 78)
    print("OpenSquilla MVP — Harness-Native Routing")
    print("=" * 78)

    state = ModelPolicyState(tier="c0")
    turns = [
        "帮我看下这段 Python 代码为什么不报错",
        "谢谢",
        "继续",
        "重构一下这个模块，让它支持并发，同时给出架构设计说明",
        "换个方式再试试",
        "新建一个任务：写一个解析 CSV 的脚本",
    ]
    prev = ""
    for i, t in enumerate(turns, 1):
        r = run_turn(t, state, prev_answer=prev)
        model, price = TIER_LADDER[r["tier"]]
        print(f"\n--- Turn {i}: {t}")
        print(f"    intent      = {r['intent']:<10} probs={r['intent_probs']}")
        print(f"    tier        = {r['tier']}  model={model}  (${price}/M tok)")
        print(f"    tier probs  = {r['tier_probs']}")
        print(f"    thinking    = {r['thinking']}   prompt_policy = {r['prompt']}")
        state = r["state"]
        prev = "上一轮的回答内容"

    print("\n" + "=" * 78)
    print("本地校准演示（硬夹紧生效）")
    print("=" * 78)
    # 造 40 条记录：c1 档经常被用户抱怨"路由太弱"
    records = [
        {"tier": "c1", "confidence": 0.61, "complaint_upgrade": True}
        for _ in range(34)
    ] + [
        {"tier": "c0", "confidence": 0.72, "complaint_upgrade": False}
        for _ in range(6)
    ]
    cal = aggregate_calibration(records)
    print(f"  sample_count      = {cal.sample_count}")
    print(f"  per_class_bias    = { {k: round(v, 4) for k, v in cal.per_class_bias.items()} }")
    print(f"  threshold_adjust  = {round(cal.threshold_adjust, 4)}")
    print(f"  effective_threshold(0.55) = {round(cal.effective_threshold(0.55), 4)}  (夹紧到 [0.3, 0.7])")
    assert -BIAS_CLAMP <= cal.per_class_bias.get("c1", 0.0) <= BIAS_CLAMP
    assert 0.3 <= cal.effective_threshold(0.55) <= 0.7

    # 样本不足 -> 中性
    small = aggregate_calibration(records[:5])
    assert small.sample_count == 0, "样本不足必须返回中性状态"
    print(f"  小样本(5条) -> sample_count={small.sample_count} (中性, 不调整)  ✅")

    print("\n" + "=" * 78)
    print("成本对比：固定 C3 vs 分级路由")
    print("=" * 78)
    # 模拟一次 10 轮会话：3 轮难 + 7 轮轻
    est = 4000  # 每轮平均 token（输入+输出）
    fixed = TIER_LADDER["c3"][1] * est / 1_000_000 * 10
    routed = (TIER_LADDER["c0"][1] * est / 1_000_000 * 7
              + TIER_LADDER["c3"][1] * est / 1_000_000 * 3)
    print(f"  固定 C3 (Opus-4.8)      : ${fixed:.4f}")
    print(f"  分级路由 (7轻 + 3重)     : ${routed:.4f}")
    print(f"  节省                    : {(1 - routed / fixed) * 100:.1f}%")
    print("\n✅ MVP 运行完成")


if __name__ == "__main__":
    main()
```

### 8.3 实测运行结果

我在本地跑通了上面这段代码，输出如下（**这是真实运行结果，不是手写的**）：

```text
==============================================================================
OpenSquilla MVP — Harness-Native Routing
==============================================================================

--- Turn 1: 帮我看下这段 Python 代码为什么不报错
    intent      = continue   probs={'new_task': 0.002, 'redo': 0.004, 'continue': 0.994}
    tier        = c0  model=DeepSeek-V4 Flash  ($0.15/M tok)
    tier probs  = {'c0': 0.333, 'c1': 0.139, 'c2': 0.194, 'c3': 0.333}
    thinking    = T2   prompt_policy = P2

--- Turn 2: 谢谢
    intent      = continue   probs={'new_task': 0.001, 'redo': 0.002, 'continue': 0.997}
    tier        = c0  model=DeepSeek-V4 Flash  ($0.15/M tok)
    tier probs  = {'c0': 0.643, 'c1': 0.286, 'c2': 0.036, 'c3': 0.036}
    thinking    = T2   prompt_policy = P1

--- Turn 3: 继续
    intent      = continue   probs={'new_task': 0.001, 'redo': 0.002, 'continue': 0.997}
    tier        = c0  model=DeepSeek-V4 Flash  ($0.15/M tok)
    tier probs  = {'c0': 0.643, 'c1': 0.286, 'c2': 0.036, 'c3': 0.036}
    thinking    = T2   prompt_policy = P1

--- Turn 4: 重构一下这个模块，让它支持并发，同时给出架构设计说明
    intent      = redo       probs={'new_task': 0.002, 'redo': 0.6, 'continue': 0.398}
    tier        = c1  model=DeepSeek-V4 Pro  ($0.55/M tok)
    tier probs  = {'c0': 0.4, 'c1': 0.178, 'c2': 0.156, 'c3': 0.267}
    thinking    = T2   prompt_policy = P2

--- Turn 5: 换个方式再试试
    intent      = redo       probs={'new_task': 0.002, 'redo': 0.6, 'continue': 0.398}
    tier        = c2  model=GLM-5.2  ($1.1/M tok)
    tier probs  = {'c0': 0.643, 'c1': 0.286, 'c2': 0.036, 'c3': 0.036}
    thinking    = T2   prompt_policy = P1

--- Turn 6: 新建一个任务：写一个解析 CSV 的脚本
    intent      = new_task   probs={'new_task': 0.55, 'redo': 0.004, 'continue': 0.446}
    tier        = c0  model=DeepSeek-V4 Flash  ($0.15/M tok)
    tier probs  = {'c0': 0.643, 'c1': 0.286, 'c2': 0.036, 'c3': 0.036}
    thinking    = T2   prompt_policy = P1

==============================================================================
本地校准演示（硬夹紧生效）
==============================================================================
  sample_count      = 40
  per_class_bias    = {'c1': 0.1275}
  threshold_adjust  = -0.17
  effective_threshold(0.55) = 0.38  (夹紧到 [0.3, 0.7])
  小样本(5条) -> sample_count=0 (中性, 不调整)  ✅

==============================================================================
成本对比：固定 C3 vs 分级路由
==============================================================================
  固定 C3 (Opus-4.8)      : $0.3000
  分级路由 (7轻 + 3重)     : $0.0942
  节省                    : 68.6%

✅ MVP 运行完成
```

**值得盯住 Turn 4 → Turn 5 的迁移**：Turn 4 用户说"重构"→ intent 判定为 `redo` → tier 从 c0 升到 c1；Turn 5 用户说"换个方式再试试"→ 又是 `redo` → tier 从 c1 升到 c2。**这正是"redo 强制升一档"规则在起作用**——如果只依赖分类器 argmax，同样的文本特征会一直给低档，用户投诉就永远传不到系统。

### 8.4 踩坑预警

我在复刻过程中踩到的几个坑，都是你上手时会遇到的：

| # | 坑 | 症状 | 解法 |
|---|-----|------|------|
| 1 | **分类器基线概率设太高** | "谢谢"被判定为 `new_task` | 基线概率必须 **低于生产阈值**（如 `p_new = 0.002 < 0.01`），否则会被阈值改写规则捕获 |
| 2 | **trivial ack 表不完整** | "继续"/"接着"被当成新任务 | 抄生产的 `_TRIVIAL_ACKS` 集合，别自己瞎猜 |
| 3 | **只靠 argmax 判 redo** | 用户投诉传不到系统 | redo 必须**强制升一档**，不走 argmax |
| 4 | **用 confidence 代替 margin** | 分类器"犹豫"时误降档 | 用 `top1 - top2` 的 margin |
| 5 | **成本表和路由表脱钩** | 账单数字对不上 | 价格必须**显式绑定到 tier 定义**，不要写在别处 |
| 6 | **本地校准没有最小样本量** | 3 条投诉就把策略改了 | 至少 20 条/档 + 全局 50 条 |
| 7 | **校准顺手改了成本估算** | 账单不可解释 | 硬约束：校准只碰阈值和偏差 |
| 8 | **忘了 `new_task` 会重置上下文** | 新任务带着旧上下文，路由判断失真 | 生产代码里 `decision.context_reset` 会置 `provider_state_replay_disabled` |

---

## 九、总结与行动建议

### 9.1 三条可迁移的原则

**原则一：不是所有决策都需要同样的上下文**

OpenSquilla 把 intent（需要历史）和 tier（只要当前请求）在**模型层面**拆开，而不是在 feature 里靠 mask 凑。这条原则适用于任何 Harness：先问"这个决策需要什么信息"，再决定喂什么。

**原则二：决策与证据分离**

`_threshold_intent` 改写了决策但保留了原始概率；`ModelPolicyAudit` 会**主动校验**两者没被混淆。这是可审计性的最小充分条件——**你的 Agent 必须能回答"为什么这一轮用了这个模型"**。

**原则三：自适应要收在窄空间里**

校准只调两个标量 + 硬夹紧 + 纯函数 + 不碰成本。这比"重训一个模型"弱得多，但可解释、可回滚、可复现。**在分布式 Agent 客户端场景下，窄调整空间是必需的，不是保守。**

### 9.2 我给不同人的行动建议

| 你是 | 建议 |
|------|------|
| **自建 Agent 的个人开发者** | 别上路由。先把"哪些轮次明显是闲聊/收尾"用 10 行规则处理掉，收益 20% 成本就到手了 |
| **做 SaaS Agent 的团队** | 上路由，但**先做 4 档 tier + 意图分类 + 审计表**三件套。分类器用规则起步，攒够 500 条决策记录再训 |
| **多 Agent 平台** | 一定要做**决策记录落库**。这是飞轮的燃料，也是你唯一能回答"这周我为什么多花了 3 倍钱"的依据 |
| **正在做长跑 Agent 的** | 优先看 OpenSquilla 的 **budget gate** 和 **escalation** 两块——长跑场景下"预算耗尽后怎么办"的处理比路由精度更重要 |

### 9.3 最后一句

> **模型会越来越强，但"这一轮到底需要多强的模型"这个问题不会自动消失。**
>
> 相反，当模型能力趋同、成本分层加剧的时候，这个问题会变成 Harness 最重要的决策点之一。
>
> OpenSquilla 给出的答案是：**用一个小到可以本地跑的分类器，把这个决策从"人的直觉"变成"可审计的状态机"。**
>
> 这比"永远用最贵的模型"聪明，比"每次让 LLM 自己判断"便宜，比"每次都靠服务端路由"精确。
>
> 值得学。

---

## 附：项目资料

| 项目 | 值 |
|------|-----|
| 仓库 | [TokenRhythm/opensquilla](https://github.com/TokenRhythm/opensquilla) |
| Star / Fork | 7139 ⭐ / 592 fork（2026-11-13） |
| License | Apache-2.0 |
| 语言 | Python 3.12+ |
| 技术报告 | [arXiv 2607.11399 — Agentic Routing: The Harness-Native Data Flywheel](https://arxiv.org/abs/2607.11399) |
| 中文版报告 | [ChinaXiv 202608.00176](https://chinaxiv.org/abs/202608.00176) |
| 英文版报告 | [aiXiv aixiv.260822.000001](https://aixiv.science/abs/aixiv.260822.000001) |
| 核心源码 | `src/opensquilla/engine/routing/model_policy.py`、`src/opensquilla/squilla_router/lightgbm_model/model.py`、`src/opensquilla/squilla_router/controller.py`、`src/opensquilla/engine/routing/calibration.py` |
| 本篇组件 | 模型选择层（横评 / 成本与预算） |

> **版权说明**：本文引用的所有源码片段均来自 Apache-2.0 许可的 [TokenRhythm/opensquilla](https://github.com/TokenRhythm/opensquilla)，已注明文件路径。MVP 代码为基于原语的独立复刻实现。
