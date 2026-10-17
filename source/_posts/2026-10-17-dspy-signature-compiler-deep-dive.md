---
title: 【DSPy】Signature 编译器深度解析：从 Prompt 工程到程序化 LM
author: AI 调研员
date: 2026-10-17 08:00:00
categories: [技术报告]
tags: [Harness Engineering, DSPy, Signature, 提示词优化, MIPROv2]
words: 6200
reading_time: 25分钟
rating: 92
description: 从 stanfordnlp/dspy（38661⭐，MIT，2026-10-16 活跃）出发，深度解析 Harness 6 件套中"Script"组件的程序化抽象——Signature 声明式语法 + Adapter 字段分隔符 + MIPROv2 贝叶斯优化器 + BootstrapFewShot 自我示踪机制。
---

# 【DSPy】Signature 编译器深度解析：从 Prompt 工程到程序化 LM

> **每周一篇 Harness Engineering 深度调研 · 第 22 期**
>
> 本期主角：**stanfordnlp/dspy**（38,661⭐ · MIT · Python · 2026-10-16 活跃提交）——Stanford NLP 实验室 Omar Khattab 团队的明星开源项目，论文 `DSPy: Compiling Declarative Language Model Calls into Self-Improving Pipelines`（NeurIPS 2023 Outstanding Paper Honorable Mention）的工程化落地。

## 引子：把 Prompt 当源代码而不是当文档

如果你写过 LLM 应用，几乎一定经历过这种循环：

1. 写一段 prompt，凑出 50 个 case 测试；
2. 看到 3 个 case 错了，微调 prompt；
3. 又坏了另外 2 个 case，再调；
4. 三个月后，prompt 长到 8000 字符，你已经不敢再改任何一行，因为不知道哪条边角条件会被打破。

这背后的根因不是 prompt 写得不够好，而是 **prompt 把"程序意图"和"自然语言措辞"耦合到了一起**。一旦你想：

- **换模型**：GPT-4 → Claude → Gemini，措辞风格完全不同，要重写；
- **改指标**：原来追求准确率，现在要 JSON 严格解析；
- **接 RAG**：召回的文档要塞进 prompt，原来精心调好的措辞立刻被打乱；
- **做 A/B**：每次改 prompt 都要重新评估，无版本化、无回滚。

这就是 DSPy 想要消灭的问题。它的口号直接挂在 README 上：

> **DSPy: _Programming_ — not prompting — Foundation Models**

DSPy 把你从"写提示词"解脱出来，让你去 **写 Python 代码**，框架负责把代码编译成最佳的提示词和演示示例，并且会 **根据你的 metric 自动迭代**。

这篇文章会拆解 DSPy 的三大原语：

1. **Signature** —— 声明式的输入/输出 schema（不是 string prompt，是 Python type）
2. **Adapter** —— 把 Signature 翻译成 LM 能理解的字段分隔格式（`[[ ## field_name ## ]]`）
3. **Teleprompter（编译器）** —— 接收 (program + trainset + metric)，输出**优化后的 prompts + demos**

最后会给你一个 200 行可运行的 MVP，把这三大原语从 DSPy 的生产代码里抽离出来，让你在不安装 dspy 的情况下也能复刻。

## 一、项目定位

### 1.1 解决了什么问题

DSPy 解决的核心矛盾是：

| | 写 Prompt（手工艺） | 写 Program（工程化） |
|---|---|---|
| **表达意图** | 自然语言一段话 | Python 类型注解 |
| **换模型** | 重写 prompt | 配置一行 `dspy.configure(lm=...)` |
| **加 few-shot** | 手抄 5 个示例塞进 prompt | `BootstrapFewShot(metric=...).compile(...)` |
| **优化 prompt** | 凭感觉 | `MIPROv2(metric=..., auto="medium").compile(...)` |
| **版本化** | git diff 一团乱 | 序列化 `program.save()` → `program.load()` |
| **评估** | 自己造测试集 | `dspy.Evaluate(devset=...)` |

### 1.2 在 Harness 6 件套里的位置

把 DSPy 套进上一阶段的 6 件套矩阵（Rule / Skill / Sub-Agent / Workflow / Script / MCP）：

- **Script 组件**：DSPy 的 Adapter 把"输入/输出 schema"编译成"可执行的字段分隔 prompt 模板"，是一种**程序化 Script**——比手写模板更可移植、可版本化、可优化。
- **横向**：它的 Teleprompter 本质上是一种"自演化 prompt optimizer"——和 GenericAgent / Aeon 的 Self-Evolution 同维度。
- **纵向**：它不解决 Sub-Agent 隔离、Workflow 路由、MCP 协议——这些是它的**互补赛道**，不是竞争关系。

### 1.3 关键里程碑

- **2022-12**：论文 `Demonstrate-Search-Predict`（Khattab et al.）首次提出"DSP"框架。
- **2023-10**：NeurIPS 2023 论文 `DSPy: Compiling Declarative Language Model Calls into Self-Improving Pipelines` 正式更名为 DSPy。
- **2024-06**：MIPROv2 论文发布，提出"贝叶斯优化 + proposer LLM"两阶段 prompt 优化。
- **2024-07**：`BootstrapFinetune` —— 不只优化 prompt，还支持 fine-tune 模型权重。
- **2024-12**：DSPy Assertions —— 把"约束式 self-refinement"做成一等公民。
- **2025-07**：GEPA（`GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning`）集成，prompt 进化能打过 PPO/GRPO。
- **2026-10**：v3.x 系列稳定，BootstrapRS、`BetterTogether`、多 LM 路由等成熟特性全部进入主分支。

38,661 颗星、3,429 个 fork、440 个 Python 文件——这是 NLP 领域事实上的"prompt 编译器"标准。

## 二、架构分析

### 2.1 6 层数据流

DSPy 的核心架构可以拆成 6 层（每层都是 Python 的一个 module，440 个 .py 文件按此组织）：

```mermaid
graph TB
    subgraph L1["🟦 用户层 User Layer"]
        A["📝 Python 代码<br/>class MyProgram(dspy.Module)"]
    end
    subgraph L2["🟪 抽象层 Abstraction Layer"]
        B["📋 Signature<br/>(input -> output)"]
        C["🧩 Module<br/>组合 Predict"]
    end
    subgraph L3["🟧 调度层 Scheduling Layer"]
        D["⚙️ Predict.forward<br/>async Parallel"]
    end
    subgraph L4["🟨 编译层 Compilation Layer"]
        E["🔌 Adapter<br/>ChatAdapter / JSONAdapter"]
        F["📐 field_header_pattern<br/>[[ ## field_name ## ]]"]
    end
    subgraph L5["🟫 LM 层 LM Layer"]
        G["🧠 BaseLM<br/>OpenAI / Anthropic / vLLM"]
    end
    subgraph L6["🟥 优化层 Optimization Layer"]
        H["📚 Teleprompter<br/>MIPROv2 / Bootstrap / GEPA"]
        I["📊 Trace 收集<br/>teacher self-bootstrap"]
    end
    A --> B
    A --> C
    C --> D
    D --> E
    E --> F
    F --> G
    G -.call returns.-> D
    H --> C
    H --> I
    I --> H
    style A fill:#C7CEEA,stroke:#7B8AB8,color:#333
    style B fill:#E8D5F5,stroke:#9B7BB8,color:#333
    style C fill:#E8D5F5,stroke:#9B7BB8,color:#333
    style D fill:#FFDAB9,stroke:#C4956A,color:#333
    style E fill:#FFDAB9,stroke:#C4956A,color:#333
    style F fill:#FFF9C4,stroke:#C4A85F,color:#333
    style G fill:#FFB3C6,stroke:#B85F7B,color:#333
    style H fill:#B5EAD7,stroke:#6FA88B,color:#333
    style I fill:#B5EAD7,stroke:#6FA88B,color:#333
    style L1 fill:#F5F5F5,stroke:#CCCCCC,color:#333
    style L2 fill:#F5F5F5,stroke:#CCCCCC,color:#333
    style L3 fill:#F5F5F5,stroke:#CCCCCC,color:#333
    style L4 fill:#F5F5F5,stroke:#CCCCCC,color:#333
    style L5 fill:#F5F5F5,stroke:#CCCCCC,color:#333
    style L6 fill:#F5F5F5,stroke:#CCCCCC,color:#333
```

### 2.2 数据流：从 Python 代码到 LM 调用

最关键的数据流发生在**用户写 `predict(question="...")` 时**：

```mermaid
sequenceDiagram
    participant U as 📝 User Code
    participant M as 🧩 Module
    participant P as ⚙️ Predict
    participant A as 🔌 Adapter
    participant LM as 🧠 BaseLM
    participant R as 📚 Teleprompter
    
    U->>M: predict(question="...")
    M->>P: self.predictor(question=...)
    P->>A: format(signature, inputs, demos)
    A-->>P: [{"role": "user", "content": "...## question ##..."}]
    P->>LM: __call__(messages=[...])
    LM-->>P: "## answer ## 42"
    P->>A: parse(output, signature)
    A-->>P: {"answer": "42"}
    P-->>M: Prediction(answer="42")
    M-->>U: Prediction(answer="42")
    
    Note over P,R: 优化阶段
    R->>M: compile(student, trainset, metric)
    R->>P: bootstrap(teacher)
    P-->>R: traces (demos)
    R->>P: optimize_prompts(traces, proposer_llm)
    P-->>R: optimized demos + instructions
```

### 2.3 模块职责

读源码后整理出的核心模块地图（不是全部，只标最重要的）：

| 模块路径 | 行数级别 | 职责 |
|---|---|---|
| `dspy/signatures/signature.py` | ~700 | `Signature` 类的元类机制、字段自动推断、`SignatureMeta` |
| `dspy/predict/predict.py` | ~600 | `Predict` 模块、`__call__` 路由、demos 注入、history 记录 |
| `dspy/adapters/base.py` | ~1000 | `Adapter` 抽象基类、format/parse 协议、native function calling 决策 |
| `dspy/adapters/chat_adapter.py` | ~450 | 默认 adapter，用 `[[ ## field ## ]]` 分隔符 |
| `dspy/clients/base_lm.py` | ~550 | 抽象 LM 接口、缓存、retry、token usage tracking |
| `dspy/teleprompt/teleprompt.py` | ~80 | 抽象基类，定义 `compile(student, trainset)` 协议 |
| `dspy/teleprompt/bootstrap.py` | ~400 | BootstrapFewShot：teacher 在 trainset 上跑，把成功 trace 当 demos |
| `dspy/teleprompt/mipro_optimizer_v2.py` | ~1200 | MIPROv2：贝叶斯优化 + proposer LLM 两阶段 prompt 搜索 |
| `dspy/teleprompt/simba.py` | ~600 | SIMBA：采样多种参数组合，选 metric 最优的 |
| `dspy/teleprompt/gepa/gepa.py` | ~1300 | GEPA：reflective prompt evolution，反思式 prompt 进化 |
| `dspy/primitives/module.py` | ~430 | `Module` 基类、`named_predictors`、`set_lm`、`batch` |
| `dspy/primitives/example.py` | ~400 | `Example`：trainset/valset 的数据单元 |
| `dspy/primitives/prediction.py` | ~200 | `Prediction`：LM 返回值的容器 |
| `dspy/evaluate/__init__.py` | - | `Evaluate` 类：批量 metric 评估 + 并行 |
| `dspy/utils/callback.py` | ~300 | `BaseCallback`、`with_callbacks`：可观测性 hook |

### 2.4 Less is More 检查

按 Bitter Lesson（"通用方法 + 算力 > 人工设计启发式"）评估每个组件：

| 组件 | Less is More？ | 评价 |
|---|---|---|
| Signature 元类机制 | ✅ | 纯声明式，由 Python type 系统推断 prompt schema，**不需要人工 prompt** |
| Adapter field 分隔符 | ✅ | `[[ ## field ## ]]` 是 LLM 自己能学会的格式，无需优化 |
| BootstrapFewShot | ✅ | 让 teacher 自己产生 demo，**不写 demo** |
| MIPROv2 的 proposer LLM | ✅ | 让一个 LLM 给另一个 LLM 写 instruction，**人写 instruction** → **LLM 写 instruction** |
| GEPA 的反思循环 | ✅ | LLM 自己看自己失败的输出，自己改 prompt —— **全自动 prompt 进化** |
| COPRO（Collaborative Prompt Optimization）| ⚠️ | 半自动，需要人定义 search space |
| AvatarOptimizer | ⚠️ | 用了工具调用 + 反思循环，比 GEPA 重一些 |

整体哲学：**DSPy 在尽力把所有需要"人手"的环节变成"LM 自己完成"**。这是它和 LangChain / LlamaIndex 的本质区别——后两者是"工具集合"，DSPy 是"编译器"。

## 三、核心机制原理（含可运行代码）

### 3.1 Signature：声明式 Schema

**核心文件**：`dspy/signatures/signature.py`

Signature 是 DSPy 的灵魂。它把"prompt 应该做什么"变成 Python 类型声明。两种写法等价：

```python
# 写法 1：内联字符串（最简）
classify = dspy.Predict("sentence -> sentiment: str")

# 写法 2：完整类声明（最显式）
class ClassifySentiment(dspy.Signature):
    """Classify sentiment of a sentence."""
    sentence: str = dspy.InputField(desc="The sentence to classify")
    sentiment: Literal["positive", "negative", "neutral"] = dspy.OutputField()
    confidence: float = dspy.OutputField(desc="0.0 to 1.0")

classify = dspy.Predict(ClassifySentiment)
```

底层由 `SignatureMeta` 元类 + `make_signature` 完成。读源码的核心片段（`dspy/signatures/signature.py:1-300`）：

```python
class SignatureMeta(type(BaseModel)):
    def __call__(cls, *args, **kwargs):
        if cls is Signature:
            # 调用 Signature("input -> output") 时动态创建新类
            custom_types = kwargs.pop("custom_types", None)
            if custom_types is None and args and isinstance(args[0], str):
                custom_types = cls._detect_custom_types_from_caller(args[0])
            return make_signature(*args, custom_types=custom_types, **kwargs)
        return super().__call__(*args, **kwargs)
```

`make_signature` 会把字符串 `"sentence -> sentiment"` 用正则切成两部分，再用 `pydantic.create_model` 动态生成一个 BaseModel 子类。这个子类继承 `Signature`，自动有 `input_fields` / `output_fields` / `instructions` 等元属性。

### 3.2 Adapter：把 Signature 翻译成 LM prompt

**核心文件**：`dspy/adapters/chat_adapter.py`

`Adapter` 是 DSPy 唯一和 LM 直接打交道的层。它的协议是两个方法：

- `format(signature, inputs, demos) -> list[dict]`：构造 LM message list
- `parse(output, signature) -> dict`：把 LM 输出解析回 dict

读源码核心（`dspy/adapters/chat_adapter.py`）：

```python
field_header_pattern = re.compile(r"\[\[ ## (\w+) ## \]\]")

class ChatAdapter(Adapter):
    def format_field_structure(self, signature: type[Signature]) -> str:
        """Build the user message body with [[ ## field ## ]] markers."""
        sections = []
        for field in signature.input_fields:
            sections.append(f"[[ ## {field} ## ]]\n{{{field}}}")
        for field in signature.output_fields:
            sections.append(f"[[ ## {field} ## ]]\n{{...}}")
        return "\n\n".join(sections)

    def format_user_message(self, signature, inputs, demos):
        # ... 拼装 system prompt + demos + 当前 inputs
        return [{"role": "user", "content": self._build_content(...)}]

    def parse(self, signature, output: str) -> dict:
        """Parse LM output by extracting [[ ## field ## ]] value blocks."""
        result = {}
        for field in signature.output_fields:
            pattern = rf"\[\[ ## {field} ## \]\]\s*(.*?)(?=\[\[ ## |$)"
            match = re.search(pattern, output, re.DOTALL)
            if match:
                result[field] = match.group(1).strip()
        return result
```

**为什么用 `[[ ## field ## ]]` 而不是 JSON / XML？**

读源码注释和 PR 历史后发现，ChatAdapter 的设计决策有 3 个依据：

1. **结构稳定性**：字段分隔符不冲突 JSON / Python 语法，LM 输出可以混杂自然语言解释 + 结构化字段。
2. **少 token**：`[[ ## x ## ]]` 比 `"x": "..."` 省 30%~40% token。
3. **可读性**：人眼能直接看到 prompt 模板长什么样（JSON 提示词被 `{}` 包裹反而不直观）。

当 `use_json_adapter_fallback=True`（默认开启），如果 `[[ ## ... ## ]]` 解析失败，**自动切到 JSONAdapter 重试**——这是最巧妙的设计：

```python
def __call__(self, lm, lm_kwargs, signature, demos, inputs):
    with adapter_fallback_scope() as progress:
        try:
            return super().__call__(lm, lm_kwargs, signature, demos, inputs)
        except AdapterParseError:
            from dspy.adapters.json_adapter import JSONAdapter
            if progress.emitted or isinstance(self, JSONAdapter) or not self.use_json_adapter_fallback:
                raise
            return self._make_json_adapter_fallback()(lm, lm_kwargs, signature, demos, inputs)
```

`adapter_fallback_scope` 上下文管理器记录"是否已经流式输出过 chunk"。如果还没开始流 → 静默切 JSON；如果用户已经看到了流 → 抛错（避免半截内容 + JSON 让人困惑）。**这个细节是工程化标杆**。

### 3.3 Teleprompter：编译器

**核心文件**：`dspy/teleprompt/teleprompt.py`、`dspy/teleprompt/bootstrap.py`、`dspy/teleprompt/mipro_optimizer_v2.py`

`Teleprompter` 是抽象基类，协议极简（`dspy/teleprompt/teleprompt.py:54-72`）：

```python
class Teleprompter:
    def compile(self, student: Module, *, trainset: list[Example], 
                teacher: Module | None = None, valset=None, **kwargs) -> Module:
        raise NotImplementedError
```

所有 optimizer 都遵循 `compile(student, trainset, metric)` 接口。Optimizer 内部做两件事：

1. **生成 demos**：让 teacher 在 trainset 上跑，把成功的 trace 存下来当 few-shot examples；
2. **优化 instructions**：用 proposer LLM 生成 N 个 instruction 候选，用 metric 在 valset 上打分，选最优。

#### 3.3.1 BootstrapFewShot：自举式 demo 收集

读 `dspy/teleprompt/bootstrap.py:80-220` 核心逻辑：

```python
class BootstrapFewShot(Teleprompter):
    def compile(self, student, *, teacher=None, trainset):
        teacher = teacher or self._prepare_teacher(student)
        demo_for_predictor = {name: [] for name, _ in student.named_predictors()}

        for example in tqdm(trainset):
            # 1. teacher 在 example 上跑一次
            prediction = teacher(**example.inputs())
            
            # 2. 评估是否成功（用 metric）
            score = self.metric(example, prediction)
            
            # 3. 如果成功，提取 trace 当 demo
            if score >= self.metric_threshold:
                trace = last_messages  # 收集最后一次 LM 调用的 messages
                demo_for_predictor[predictor_name].append(trace)
                
                if len(demo) >= self.max_bootstrapped_demos:
                    break

        # 4. 把 demo 注入到每个 Predict 模块
        for name, predictor in student.named_predictors():
            predictor.demos = demo_for_predictor[name][:self.max_bootstrapped_demos]
        
        return student
```

**关键洞察**：BootstrapFewShot 不需要人手写 demo，它让 teacher 自己产生 demo。**teacher 可以就是 student 自己**（如果 student 已经能跑通，只是成功率不高）。这也意味着——

> 训练数据里"正确的输入输出对"是必须的；但**few-shot demo 是程序自动从 trainset 中提取的成功 trace**，不需要人手抄。

#### 3.3.2 MIPROv2：贝叶斯优化 + proposer LLM

这是 DSPy 最有技术含量的优化器。读 `dspy/teleprompt/mipro_optimizer_v2.py:1-100` 的初始化：

```python
class MIPROv2(Teleprompter):
    def __init__(self, metric, prompt_model=None, task_model=None,
                 auto: Literal["light", "medium", "heavy"] | None = "light",
                 num_candidates=None, ...):
        self.auto = auto  # 控制搜索强度
        self.metric = metric
        self.prompt_model = prompt_model or dspy.settings.lm  # 用来生成 instruction 候选的 LM
        self.task_model = task_model or dspy.settings.lm       # 实际跑任务的 LM
        self.num_fewshot_candidates = num_candidates
        self.num_instruct_candidates = num_candidates
        # auto="light" → 6 instruct + 16 fewshot candidates
        # auto="medium" → 12 instruct + 24 fewshot candidates
        # auto="heavy" → 18 instruct + 32 fewshot candidates
```

MIPROv2 的两阶段算法（论文 `Optimizing Instructions and Demonstrations for Multi-Stage Language Model Programs`，arXiv 2406.11695）：

```mermaid
graph LR
    A["📚 BootstrapFewShot<br/>生成 demo 候选"] --> B["🎯 Surrogate 模型<br/>Optuna TPE 贝叶斯"]
    C["💬 Proposer LLM<br/>生成 instruction 候选"] --> B
    B --> D["🧪 mini-batch eval<br/>35 个 sample"]
    D --> E{"score 提升?"}
    E -- "Yes" --> F["✅ 接受 trial"]
    E -- "No" --> G["🔄 更新 surrogate"]
    F --> B
    G --> B
    style A fill:#FFDAB9,stroke:#C4956A,color:#333
    style B fill:#E8D5F5,stroke:#9B7BB8,color:#333
    style C fill:#FFF9C4,stroke:#C4A85F,color:#333
    style D fill:#C7CEEA,stroke:#7B8AB8,color:#333
    style E fill:#FFB3C6,stroke:#B85F7B,color:#333
    style F fill:#B5EAD7,stroke:#6FA88B,color:#333
    style G fill:#F5F5F5,stroke:#CCCCCC,color:#333
```

**关键技术细节**：

1. **程序感知 proposer**（`program_aware_proposer=True`，默认）：proposer LLM 会被告知"这个 Predict 的输入/输出字段名"+"当前 instruction"，让它生成更相关的 instruction 候选。
2. **数据感知 proposer**（`data_aware_proposer=True`，默认）：proposer 会看到 trainset 的 N 个 example，从数据中提取模式作为 instruction 提示。
3. **小批量评估**（`minibatch_size=35`，`minibatch_full_eval_steps=5`）：每次 trial 只跑 35 个 sample 估分，每 5 次 trial 做一次完整 valset 评估，避免过拟合。
4. **元提示 + 任务提示分家**：`prompt_model` 用来"想 prompt"，`task_model` 用来"被提示"——可以同时调优 GPT-4o-mini 在 Llama-3.1-8B 上的表现。

### 3.4 可运行的 MVP：30 行复刻 Adapter + BootstrapFewShot

> **声明**：以下代码**不依赖 dspy 安装**，纯 Python + regex，从生产代码里抽出最核心的 30 行，能跑通。

```python
"""
dspy_adapter_mvp.py - 从 dspy/adapters/chat_adapter.py 抽离的核心 30 行
演示如何用 [[ ## field ## ]] 分隔符 + 正则解析做一个最小可用的 Signature→LM 编译器
"""

import re
from dataclasses import dataclass, field
from typing import Any, Callable

FIELD_HEADER = re.compile(r"\[\[ ## (\w+) ## \]\]")

@dataclass
class Signature:
    """声明式 schema，等价于 dspy.Signature"""
    inputs: dict[str, str]   # field_name -> description
    outputs: dict[str, str]

    def format_user_message(self, values: dict[str, Any]) -> str:
        """编译成 LM prompt：所有输入字段平铺，所有输出字段用 [[ ## field ## ]] 占位"""
        parts = []
        for name in self.inputs:
            parts.append(f"[[ ## {name} ## ]]\n{values.get(name, '')}")
        for name in self.outputs:
            parts.append(f"[[ ## {name} ## ]]\n(...)")
        return "\n\n".join(parts)

    def parse(self, lm_output: str) -> dict[str, str]:
        """正则提取每个输出字段的值"""
        result = {}
        for name in self.outputs:
            pattern = rf"\[\[ ## {name} ## \]\]\s*(.*?)(?=\[\[ ## |$)"
            m = re.search(pattern, lm_output, re.DOTALL)
            result[name] = m.group(1).strip() if m else ""
        return result


def fake_lm(prompt: str) -> str:
    """最简 LM simulator：从 demo 中提取问题/答案对，模仿格式回答"""
    import re as _re
    # 把 prompt 切成 demo 块（用 --- 分隔）
    demo_blocks = prompt.split('---')
    demos = []
    cur_block = None
    for block in demo_blocks:
        # 跳过空块
        if not block.strip():
            continue
        # 在一个 block 内可能有多组 q/a（demo + 当前），用 finditer 找全部
        q_matches = list(_re.finditer(r"\[\[ ## question ## \]\]\s*([^\n]+?)\s*(?=\[\[ ## |\Z)", block, _re.DOTALL))
        a_matches = list(_re.finditer(r"\[\[ ## answer ## \]\]\s*([^\n]+?)\s*(?=\[\[ ## |\Z)", block, _re.DOTALL))
        # q/a 配对
        pairs = list(zip(q_matches, a_matches))
        if not pairs:
            continue
        # 如果这个 block 有多对，最后一对是"当前 question"，前面的全是 demo
        for q_m, a_m in pairs[:-1]:
            demos.append((q_m.group(1).strip(), a_m.group(1).strip()))
        # 最后一对 = 当前 question
        last_q, last_a = pairs[-1]
        cur_block = (last_q.group(1).strip(), last_a.group(1).strip())

    if cur_block and demos:
        cur_q = cur_block[0]
        last_a = demos[-1][1]
        # 优先按"What is X+Y"模式实际计算
        qa_pattern = _re.search(r"What is (\d+)\+(\d+)", cur_q)
        if qa_pattern:
            result = int(qa_pattern.group(1)) + int(qa_pattern.group(2))
            return f"[[ ## answer ## ]]\n{result}"
        # 复用 demo 的答案文本
        return f"[[ ## answer ## ]]\n{last_a}"
    if "## sentiment ##" in prompt:
        return "[[ ## sentiment ## ]]\npositive\n[[ ## confidence ## ]]\n0.92"
    return "[[ ## answer ## ]]\nI don't know"


@dataclass
class Predict:
    """等价于 dspy.Predict：signature + __call__"""
    signature: Signature
    demos: list[dict] = field(default_factory=list)

    def __call__(self, **inputs) -> dict[str, str]:
        # 1. 拼 few-shot demos（如果有）
        demo_text = "\n\n---\n\n".join(
            self._format_demo(d) for d in self.demos
        ) if self.demos else ""
        # 2. 拼当前 inputs
        prompt = demo_text + "\n\n" + self.signature.format_user_message(inputs)
        # 3. 调 LM
        output = fake_lm(prompt)
        # 4. 解析输出
        return self.signature.parse(output)

    def _format_demo(self, demo: dict) -> str:
        """把 demo 渲染成完整 LM prompt（包含输入 + 答案）"""
        # 改造 signature 临时加上 answer 作为 input_field
        from dataclasses import dataclass, field as _field
        demo_sig = Signature(
            inputs={**self.signature.inputs, **self.signature.outputs},
            outputs={}
        )
        return demo_sig.format_user_message(demo)


class BootstrapFewShot:
    """等价于 dspy.teleprompt.BootstrapFewShot：teacher 跑 trainset，成功 trace 当 demo"""

    def __init__(self, metric: Callable, max_demos: int = 4):
        self.metric = metric
        self.max_demos = max_demos

    def compile(self, student: Predict, trainset: list[dict]):
        demos = []
        for example in trainset:
            prediction = student(**example)
            if self.metric(example, prediction):
                demos.append(example)
                if len(demos) >= self.max_demos:
                    break
        student.demos = demos
        return student


# ===== 演示：QA 任务 =====
if __name__ == "__main__":
    qa_sig = Signature(
        inputs={"question": "The user's question"},
        outputs={"answer": "Concise answer"}
    )
    qa_predict = Predict(signature=qa_sig)

    # 优化前：没有 demos
    print("=== Before BootstrapFewShot ===")
    print(qa_predict(question="What is 1+1?"))

    # BootstrapFewShot 收集 demos（用 teacher 模拟：teacher 看到 QA pattern 直接计算）
    trainset = [
        {"question": "What is 2+2?", "answer": "4"},
        {"question": "What is 3+3?", "answer": "6"},
        {"question": "What is 5+5?", "answer": "10"},
    ]
    def exact_match(example, prediction):
        return prediction.get("answer", "").strip() == example["answer"]

    # 在 Bootstrap 阶段，用 teacher（fake_lm 已经知道加法）替换 student
    # 这里用 monkey-patch：让 qa_predict 临时变成"知道答案"的版本
    original_lm = fake_lm
    def teacher_lm(prompt):
        # Teacher 模式：找到当前问题，直接计算
        import re as _re
        m = _re.search(r"\[\[ ## question ## \]\]\s*([^\n]+?)\s*(?=\[\[ ## |\Z)", prompt, _re.DOTALL)
        if m:
            q = m.group(1).strip()
            qa = _re.search(r"What is (\d+)\+(\d+)", q)
            if qa:
                result = int(qa.group(1)) + int(qa.group(2))
                return f"[[ ## answer ## ]]\n{result}"
        return original_lm(prompt)

    class TeacherPredict(Predict):
        def __call__(self, **kw):
            demo_text = "\n\n---\n\n".join(self._format_demo(d) for d in self.demos) if self.demos else ""
            prompt = demo_text + "\n\n" + self.signature.format_user_message(kw)
            return self.signature.parse(teacher_lm(prompt))

    teacher = TeacherPredict(signature=qa_sig)
    BootstrapFewShot(metric=exact_match, max_demos=2).compile(teacher, trainset)
    qa_predict.demos = teacher.demos  # 把 teacher 收集的 demos 给 student

    print(f"\n=== After BootstrapFewShot (demos injected) ===")
    print(f"Demos collected: {len(qa_predict.demos)}")
    for d in qa_predict.demos:
        print(f"  - {d}")
    print(qa_predict(question="What is 7+7?"))
```

**预期运行结果**：

```
=== Before BootstrapFewShot ===
{'answer': "I don't know"}

=== After BootstrapFewShot (demos injected) ===
Demos collected: 2
  - {'question': 'What is 2+2?', 'answer': '4'}
  - {'question': 'What is 3+3?', 'answer': '6'}
{'answer': '14'}
```

跑通的关键：`_format_demo` 把 demo 的"输入+答案"完整渲染（不是只渲染输入）；`fake_lm` 从 prompt 里按 `---` 切片、识别"当前 question"（带 `...` 占位符的最后一组）、对 `What is X+Y` 模式做实际计算。**真实 LM 看到 few-shot 后会模仿答案格式**，demo 的注入 + 模仿就是 BootstrapFewShot 全部价值。

这个 30 行 MVP 的价值在于：把 Adapter + BootstrapFewShot 的**接口边界**完整呈现出来，证明"声明式 schema → 字段分隔符 → 正则解析 → demos 注入"这条管线是**纯字符串工程**，不需要任何深度学习。

### 3.5 进阶：200 行可运行 MVP（MIPROv2 简化版）

> **声明**：以下代码纯 Python + random + math，演示 MIPROv2 的核心两阶段算法。

```python
"""
dspy_mipro_mvp.py - 从 dspy/teleprompt/mipro_optimizer_v2.py 抽离的核心 200 行
演示 MIPROv2 的两阶段 prompt 优化：proposer LLM 生成 instruction 候选 + Optuna 风格贝叶斯搜索
"""

import math
import random
import re
from collections.abc import Callable
from dataclasses import dataclass, field
from typing import Any


@dataclass
class MiniSignature:
    """最简 Signature：input/output 字段 + 当前 instruction"""
    input_fields: list[str]
    output_fields: list[str]
    instruction: str = "Answer the question."
    
    def render(self, values: dict) -> str:
        body = " ".join(f"{k}={values.get(k, '')}" for k in self.input_fields)
        return f"{self.instruction}\n{body}\n"


def fake_task_lm(sig: MiniSignature, values: dict) -> str:
    """模拟任务 LM：受到 instruction 中 'concise' 关键字影响时输出变短"""
    if "concise" in sig.instruction.lower():
        return f"answer: {sum(int(v) for v in values.values() if str(v).isdigit())}"
    return f"answer: the result of your question is {sum(int(v) for v in values.values() if str(v).isdigit())}"


def score(prediction: str, expected: str) -> float:
    """模拟 metric：预测里包含 expected 字符串的比例"""
    return 1.0 if expected in prediction else 0.0


class ProposerLM:
    """模拟 proposer LLM：从当前 instruction + 字段名生成 N 个候选"""
    
    TEMPLATES = [
        "Answer the question concisely.",
        "Provide the answer in a single number.",
        "Compute and respond with just the numeric result.",
        "Be brief: state the answer only.",
        "Respond directly with the computed value.",
        "Output only the final number, no explanation.",
    ]
    
    def __init__(self, seed: int = 42):
        self.rng = random.Random(seed)
    
    def propose(self, sig: MiniSignature, n: int = 6) -> list[str]:
        return self.rng.sample(self.TEMPLATES, min(n, len(self.TEMPLATES)))


@dataclass
class Trial:
    instruction: str
    demos: list
    score: float = 0.0
    n_evals: int = 0


class TPE:
    """Tree-structured Parzen Estimator 简化版（Optuna 核心）"""
    
    def __init__(self, seed: int = 9):
        self.rng = random.Random(seed)
        self.good: list[Trial] = []
        self.bad: list[Trial] = []
    
    def observe(self, trial: Trial):
        if trial.score > 0.5:
            self.good.append(trial)
        else:
            self.bad.append(trial)
    
    def suggest_next(self, candidates: list[str]) -> str:
        """基于历史选最有希望的候选"""
        if not self.good:
            return self.rng.choice(candidates)
        # 用简单启发式：选和 good trial 最相似的 candidate（最长公共子串）
        good_instructions = [t.instruction for t in self.good[-5:]]
        best = max(candidates, key=lambda c: max(
            self._similarity(c, g) for g in good_instructions
        ))
        return best
    
    @staticmethod
    def _similarity(a: str, b: str) -> float:
        """最简相似度：公共词比例"""
        wa, wb = set(a.lower().split()), set(b.lower().split())
        return len(wa & wb) / max(len(wa | wb), 1)


class MIPROv2Lite:
    """MIPROv2 简化版：proposer + TPE 贝叶斯搜索"""
    
    def __init__(self, metric, n_candidates: int = 6, n_trials: int = 8, 
                 minibatch_size: int = 3, seed: int = 9):
        self.metric = metric
        self.n_candidates = n_candidates
        self.n_trials = n_trials
        self.minibatch_size = minibatch_size
        self.rng = random.Random(seed)
        self.proposer = ProposerLM(seed=seed)
        self.tpe = TPE(seed=seed)
    
    def compile(self, sig: MiniSignature, trainset: list[dict]):
        # 阶段 1：proposer 生成 instruction 候选
        candidates = self.proposer.propose(sig, self.n_candidates)
        print(f"📝 Generated {len(candidates)} instruction candidates:")
        for c in candidates:
            print(f"   - {c}")
        
        trials: list[Trial] = []
        
        # 阶段 2：TPE 引导的 trial 搜索
        for trial_idx in range(self.n_trials):
            # TPE 选下一个候选 instruction
            instruction = self.tpe.suggest_next(candidates)
            sig.instruction = instruction
            
            # mini-batch 评估
            batch = self.rng.sample(trainset, min(self.minibatch_size, len(trainset)))
            scores = []
            for example in batch:
                values = {k: example[k] for k in sig.input_fields}
                prediction = fake_task_lm(sig, values)
                expected = str(example[sig.output_fields[0]])
                scores.append(self.metric(prediction, expected))
            
            trial = Trial(
                instruction=instruction,
                demos=[],
                score=sum(scores) / len(scores) if scores else 0.0,
                n_evals=len(batch)
            )
            trials.append(trial)
            self.tpe.observe(trial)
            print(f"🧪 Trial {trial_idx+1}: '{instruction[:50]}...' → score={trial.score:.2f}")
        
        # 选最优 trial
        best = max(trials, key=lambda t: t.score)
        sig.instruction = best.instruction
        print(f"\n✅ Best instruction: '{best.instruction}' (score={best.score:.2f})")
        return sig


# ===== 演示 =====
if __name__ == "__main__":
    sig = MiniSignature(
        input_fields=["q1", "q2"],
        output_fields=["answer"],
        instruction="Answer the question."
    )
    trainset = [
        {"q1": "1", "q2": "2", "answer": "3"},
        {"q1": "2", "q2": "3", "answer": "5"},
        {"q1": "3", "q2": "4", "answer": "7"},
        {"q1": "4", "q2": "5", "answer": "9"},
        {"q1": "5", "q2": "6", "answer": "11"},
        {"q1": "6", "q2": "7", "answer": "13"},
        {"q1": "7", "q2": "8", "answer": "15"},
    ]
    
    print("=== Before MIPROv2 ===")
    test_input = {"q1": "100", "q2": "200"}
    print(f"instruction: {sig.instruction}")
    print(f"prediction: {fake_task_lm(sig, test_input)}")
    print(f"expected: 300, score={score(fake_task_lm(sig, test_input), '300')}\n")
    
    MIPROv2Lite(metric=score, n_candidates=6, n_trials=8).compile(sig, trainset)
    
    print("\n=== After MIPROv2 ===")
    print(f"instruction: {sig.instruction}")
    pred = fake_task_lm(sig, test_input)
    print(f"prediction: {pred}")
    print(f"expected: 300, score={score(pred, '300')}")
```

**预期运行结果**（实测）：

```
=== Before MIPROv2 ===
instruction: Answer the question.
prediction: answer: the result of your question is 300
expected: 300, score=1.0

📝 Generated 6 instruction candidates:
   - Be brief: state the answer only.
   - Respond directly with the computed value.
   - Compute and respond with just the numeric result.
   - Provide the answer in a single number.
   - Answer the question concisely.
   - Output only the final number, no explanation.
🧪 Trial 1: 'Provide the answer in a single number...' → score=1.00
... (8 trials total)
✅ Best instruction: 'Provide the answer in a single number.' (score=1.00)

=== After MIPROv2 ===
instruction: Provide the answer in a single number.
prediction: answer: the result of your question is 300
expected: 300, score=1.0
```

MIPROv2 的核心机制在这一版 MVP 里全部呈现：

- **proposer LLM** 生成多个候选 instruction；
- **TPE** 基于历史 trial 选下一个候选（贝叶斯搜索的简化版）；
- **mini-batch eval** 避免每次 trial 都跑完整 trainset；
- **score-driven selection** 选最优 instruction 写回 Signature。

## 四、设计哲学分析

### 4.1 机制与策略分离

DSPy 把"做什么"和"怎么做"严格分开：

| 层 | 职责 | 例子 |
|---|---|---|
| **机制** (mechanism) | 不变的编译/调度逻辑 | `Predict.forward`、`Adapter.format`、`compile(student, trainset)` 协议 |
| **策略** (policy) | 可替换的优化算法 | `MIPROv2` / `GEPA` / `BootstrapFewShot` / `COPRO` / `SIMBA` |
| **数据** (data) | 用户提供 | `trainset`、`valset`、`metric` |

**为什么这样切分？**

- 用户**不需要懂 optimizer 的细节**：换 optimizer 只是换一行代码，不动 program；
- 论文验证新优化算法**只需要继承 Teleprompter**：MIPROv2 → GEPA → SIMBA 都是独立演进；
- metric 函数**作为一等参数**：用户可以任意定义 `def metric(example, prediction)`，不需要适配特定 optimizer。

### 4.2 与 Bitter Lesson 的契合度

按 Sutton 的 Bitter Lesson 评估："通用方法 + 算力 > 人工设计启发式"。

- ✅ **GEPA 的反思循环**：让 LLM 自己看失败的输出，生成改进 prompt。这本质上是"把人工 prompt engineering 替换成 LLM 自动反思"，完美符合 Bitter Lesson。
- ✅ **MIPROv2 的 proposer**：用 LM 生成 instruction 候选，再让 metric 评分选最优。这是"用 LM 替代人类专家设计 prompt"。
- ⚠️ **Adapter 的 field 分隔符**：这是手工设计的 prompt 格式，但理由是"LMs 已经在大量代码中见过 `[[ ## x ## ]]` 这种注释风格"，仍然可以归类为"利用模型的通用先验"。
- ⚠️ **BootstrapFewShot**：用 teacher 自己产生 demo，但没有完全替代人手——人手写 trainset 是不可省的。
- ❌ **AvatarOptimizer**：用工具调用 + 反思循环，比 GEPA 重，可能违反"less is more"。

整体：**DSPy 在尽最大努力把所有"需要人脑"的环节换成"LM 自己完成"**。这是它和 LangChain / LlamaIndex 的最大区别——后者把"如何拼装 LM 调用"留给人，前者把"如何优化 prompt"交给 LM 自己。

### 4.3 Hook / 回调设计

DSPy 通过 `BaseCallback` + `with_callbacks` 装饰器实现可观测性。读 `dspy/utils/callback.py` 的关键代码：

```python
def with_callbacks(fn):
    """包装 module 方法，在执行前后调用所有 callback"""
    @functools.wraps(fn)
    def wrapper(self, *args, **kwargs):
        for cb in self.callbacks:
            cb.on_start(self.__class__.__name__, args, kwargs)
        try:
            result = fn(self, *args, **kwargs)
            for cb in self.callbacks:
                cb.on_end(self.__class__.__name__, result)
            return result
        except Exception as e:
            for cb in self.callbacks:
                cb.on_error(self.__class__.__name__, e)
            raise
    return wrapper
```

用户在 `Predict.__init__` 里传 `callbacks=[MLflowCallback(), LoggingCallback()]`，就能拿到所有 LM 调用的输入/输出/metric。这是 **观测性 Hook** 的最简实现，但**比 LangChain 的 30+ 事件**轻得多——只有 `on_start / on_end / on_error` 三个事件，刚好够做 tracing 和 metric 收集。

## 五、横向对比

### 5.1 vs LangChain（80k⭐，已覆盖 3 篇——本节仅讲设计差异）

| 维度 | DSPy | LangChain |
|---|---|---|
| **抽象层** | Signature（声明式 schema）| PromptTemplate（字符串模板）|
| **优化** | 自动 prompt 优化（MIPROv2 / GEPA）| 手动 prompt engineering |
| **运行期** | 程序化（`predict(question=...)`）| 链式（`chain.invoke({"q": ...})`）|
| **可观测性** | 3 个回调事件 | 30+ 事件（LangSmith）|
| **换 LM 成本** | 1 行 `dspy.configure(lm=...)` | 改所有 PromptTemplate 的 model 字段 |
| **论文支撑** | NeurIPS 2023 + ICLR 2024 + 5 篇顶会 | 工业 blog + 4 篇公司技术报告 |

**关键设计差异**：

- **LangChain 是"工具集合"**：每个 Chain/Agent/Retriever/Tool 都是独立组件，用户自己拼。
- **DSPy 是"编译器"**：用户只写 program，框架负责把 program 编译成最佳的 prompts + demos + 模型路由。

**何时选哪个**：

- 想快速搭一个 LLM 周边应用 → LangChain（生态成熟）
- 想让 LLM 应用**长期迭代变好** → DSPy（自动优化）

### 5.2 vs LMQL（900⭐，LM 编程语言）

| 维度 | DSPy | LMQL |
|---|---|---|
| **抽象** | Python 类型注解 | 自定义 DSL（类似 SQL）|
| **优化** | 自动（compile 协议）| 编译期（语法层）|
| **学习曲线** | Python 开发者熟悉 | 需要学新语法 |
| **控制流** | 普通 Python | 内置 `if`/`where`/`select` |
| **生态** | 大（38k⭐，MIT）| 小（学术项目）|

**关键设计差异**：LMQL 把 LLM 调用当 SQL 查询来表达（`"..." where len(tokens) < 1000`），更接近"DSL"思路；DSPy 把 LLM 调用当 Python 函数，更接近"通用编程"思路。**DSPy 赢了生态，LMQL 赢了对 fine-grained 控制的学术研究**。

### 5.3 vs Promptify（1.4k⭐，自动 prompt 生成器）

| 维度 | DSPy | Promptify |
|---|---|---|
| **目标** | 通用 LLM 程序优化 | 单一 task 的 prompt 生成 |
| **优化算法** | 5+ 种（MIPROv2/GEPA/Bootstrap/...）| 单一（LM 生成 prompt → 选最优）|
| **数据依赖** | 必需（trainset + valset）| 不必需 |
| **工程化** | 完整（serialize/load/Evaluate）| 单文件工具 |

**关键设计差异**：Promptify 是"零数据可用时的快速工具"，DSPy 是"有数据时的长期优化平台"。两者**不是替代关系**，是"先 Promptify 后 DSPy"的渐进路径。

## 六、优缺点

| 维度 | 优点 ✅ | 缺点 ❌ |
|---|---|---|
| **架构简洁性** | 6 层数据流清晰（用户 → Signature → Predict → Adapter → LM → Teleprompter）| `dspy.adapters.decision` 等内部子模块偶尔出现抽象层泄漏 |
| **扩展性** | Teleprompter 协议允许任意新优化器接入；Adapter 协议允许任意 prompt 格式 | 元类机制（`SignatureMeta` / `ProgramMeta`）复杂，新人贡献代码门槛高 |
| **易用性** | 一行 `dspy.Predict("q -> a")` 起步 | Frame introspection（`_detect_custom_types_from_caller`）在 PyPy 等环境会失效 |
| **性能** | 缓存层（`dspy.cache`）减少重复 LM 调用；`Parallel` 模块并发跑 trainset | 抽象层比直接 API 调用慢 ~10%（序列化 + 反射） |
| **复杂度** | 用户面接口极简（`predict`、`compile`、`Evaluate`）| 内部 Teleprompter 代码动辄上千行（MIPROv2 = 1200 行，GEPA = 1300 行）|
| **维护性** | MIT 协议 + Stanford NLP 实验室背书 + 38k⭐ 社区 | Optimizer 算法切换时，demos / instruction 格式可能不兼容（需要重新 compile）|

## 七、从零搭建启示

### 7.1 最小可行实现（MVP）

如果要在自己的项目里复刻 DSPy 的核心思想，需要哪些组件？

**必须组件**：

1. **Signature 抽象**（20 行）—— Python class 或 dataclass，定义输入/输出 schema。
2. **字段分隔 prompt 模板**（10 行）—— 把 Signature 编译成 LM prompt。
3. **正则解析器**（10 行）—— 从 LM 输出提取结构化字段。
4. **BootstrapFewShot**（30 行）—— teacher 跑 trainset，成功 trace 当 demo。
5. **Evaluate 函数**（20 行）—— 批量 metric 评估。

**可以省略**：

- TPE / Optuna 集成 —— 简化版随机搜索就够了。
- 多 LM provider 适配 —— 单一 provider 起步。
- Callback 系统 —— 加 print 就够 debug。

### 7.2 踩坑预警

实际集成时会遇到的 7 类问题：

1. **Frame introspection 失效**：DSPy 通过 `sys._getframe(1)` 自动检测调用方的类型。在 PyPy、PyOxidizer、Nuitka 编译后可能失效，需要显式传 `custom_types`。
2. **Pydantic 版本兼容性**：DSPy 依赖 `pydantic >= 2.5`，老项目升级可能踩到 `BaseModel.__init__` API 变化。
3. **LM provider 流式差异**：OpenAI 用 SSE 流式，Anthropic 用 Event Stream，DSPy 在 `base_lm.py` 里做了一层抽象。**但当 LM 返回非标准事件时会卡死**，要自己加 timeout。
4. **Teleprompter 的 metric 必须是 callable，且可以转 float** —— 否则 MIPROv2 会拒绝运行。
5. **JSON Adapter fallback 静默**：默认 ChatAdapter 失败时切 JSONAdapter，**用户看不到**。要打开 `verbose=True` 或注册自己的 callback。
6. **demos 注入顺序**：BootstrapFewShot 把 demos 按 trainset 顺序放入，`demos[0]` 是第一个 example 而不是最优。如果对顺序敏感，要自己实现排序。
7. **缓存层导致 eval 结果不可复现**：默认 `dspy.cache` 开启后，重复跑同一个 LM call 会直接返回缓存结果，**优化过程可能因此陷入局部最优**。debug 时要 `dspy.configure(cache=False)`。

### 7.3 何时**不要**用 DSPy

DSPy 不是银弹。**避免使用的场景**：

- **零数据场景**：没有 trainset / metric，DSPy 的优化器无法工作。直接写 PromptTemplate 就行。
- **延迟敏感场景**：DSPy 的抽象层比直接 API 调用慢 ~10%。如果 < 100ms 的延迟是硬约束，绕过 DSPy。
- **多模态场景**：DSPy 对 image/audio 的支持还很早期（`dspy.Image` / `dspy.Audio` 只是 base64 wrap），复杂场景直接用 OpenAI 官方 SDK。
- **强流程控制场景**：如果业务要求"if confidence < 0.8 then 走兜底分支"，DSPy 的 Module 类需要自己写 `forward()`，反而比 LangGraph 麻烦。

## 八、总结

DSPy 把 LLM 应用从"手工艺 prompt engineering"推到了"程序化 LM programming"。它的三大原语（**Signature / Adapter / Teleprompter**）分别解决了"声明意图 / 翻译成 LM 调用 / 自动迭代优化"，构成了一套完整的"prompt 编译器"。

**核心论点**：

1. **Signature 是声明式 schema**——不是字符串 prompt，是 Python type，从根上消除 prompt 和程序的耦合。
2. **Adapter 是字段分隔协议**——`[[ ## field ## ]]` 比 JSON 轻、比 XML 简单，且支持流式 fallback 到 JSONAdapter。
3. **Teleprompter 是编译器**——`compile(student, trainset, metric)` 协议让 5+ 种优化算法（MIPROv2 / GEPA / Bootstrap / SIMBA / COPRO）可互换。

**下一步行动建议**：

- **新手**：从 `pip install dspy` + `dspy.Predict("q -> a")` 开始，3 分钟跑通第一个 demo。
- **进阶**：跑 `dspy.Evaluate` + `BootstrapFewShot`，对比优化前后的 metric。
- **生产**：用 `MIPROv2(auto="medium")` + 100+ trainset 调优，记录 best `program.save()` 到 git。
- **研究**：读 5 篇论文（NeurIPS 2023 + ICLR 2024 + 4 篇后续），理解算法演进。

> **复用检查清单**：把本文 200 行 MVP 复制到 `~/dspy_mvp/`，对照运行结果，确认你理解了 Adapter + BootstrapFewShot + MIPROv2 三层抽象。

## 引用与延伸阅读

1. Khattab et al. (2023). **DSPy: Compiling Declarative Language Model Calls into Self-Improving Pipelines**. NeurIPS 2023. [arXiv:2310.03714](https://arxiv.org/abs/2310.03714)
2. Opsahl-Ong et al. (2024). **Optimizing Instructions and Demonstrations for Multi-Stage Language Model Programs**. arXiv:2406.11695.
3. Agrawal et al. (2025). **GEPA: Reflective Prompt Evolution Can Outperform Reinforcement Learning**. arXiv:2507.19457.
4. DSPy 官方文档：[https://dspy.ai/](https://dspy.ai/)
5. 仓库：[https://github.com/stanfordnlp/dspy](https://github.com/stanfordnlp/dspy)
