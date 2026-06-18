---
title: 【Memori】核心架构与设计原理深度解析：让 Agent 拥有「执行记忆」的开源基础设施
date: 2026-06-15 09:30:00
tags: [Agent, Memori, 记忆系统, RAG, 向量检索, 架构分析, 项目评测, LLM基础设施]
categories: [AI, 项目评测]
description: 深度剖析 MemoriLabs/Memori 的核心架构：一个把 Agent 的对话和执行痕迹自动转化为结构化记忆（语义三元组 + 事实 + 关系）的 LLM 无关、数据存储无关、框架无关的开源记忆基础设施。在 LoCoMo 长对话记忆基准上以 81.95% 准确率超越 Zep、LangMem、Mem0，prompt 体积仅占完整上下文的 4.97%。
series: ai-agent-memory

---

## 引子：当 Agent「金鱼脑」成为生产瓶颈

想象一下：你花了一周微调好的客服 Agent，用户对它说「我叫张伟，我的订单号是 20240315001，上次那个退款 200 块还没到账」。第二天用户再来，Agent 一脸茫然：「您好，请问您是？」——这就是 LLM Agent 经典的「金鱼脑」难题。

当下主流方案是**把整段对话塞进上下文窗口**。但这条路有三个死结：
1. **成本爆炸**：Claude 4 Opus 每百万 token 15 美元，一个 50 轮客服会话动辄消耗 5 万 token，QPS 一上去账单惊人。
2. **质量塌方**：当上下文超过 32K-128K，模型会出现「中途遗忘」（lost-in-the-middle）现象，关键事实被淹没。
3. **跨会话断裂**：用户每开一个新会话，Agent 就「重启」，所有个性化信息归零。

市面上已有 Mem0、Cognee、Letta、Zep/Graphiti 等记忆框架在做类似的事，但 **MemoriLabs/Memori**（⭐15.3k，2025-07 创建，2026-06-12 最新提交）走出了另一条路：**Memory from what agents DO, not just what they SAY**——它不仅要捕获 Agent「说了什么」，更要捕获 Agent「做了什么」（工具调用、决策路径、执行结果）。

更关键的是，在 [LoCoMo 长对话记忆基准](https://arxiv.org/abs/2603.19935) 上，Memori 以 **81.95% 总体准确率、每次查询仅 1,294 token** 的成绩，击败 Zep、LangMem、Mem0，prompt 体积比 Zep 小 67%、比完整上下文方案小 20 倍。

本文将系统拆解 Memori 的架构设计、运行机制、可运行代码、与同类项目的对比，并给出实战指南。

## 项目速览

| 维度 | 信息 |
|------|------|
| GitHub | [MemoriLabs/Memori](https://github.com/MemoriLabs/Memori) |
| 当前 Star | 15.3k（2026-06-12） |
| 主语言 | Python + TypeScript + Rust（核心引擎） |
| License | Apache 2.0 |
| 安装 | `pip install memori` 或 `npm install @memorilabs/memori` |
| 文档 | [memorilabs.ai/docs](https://memorilabs.ai/docs/) |
| 支持 LLM | Anthropic、Bedrock、DeepSeek、Gemini、Grok、OpenAI（Chat Completions + Responses API） |
| 支持框架 | Agno、LangChain、Pydantic AI |
| 支持数据库（BYODB）| SQLite、PostgreSQL、MySQL、CockroachDB、MongoDB、OceanBase、TiDB、Neon、DigitalOcean |
| 集成生态 | OpenClaw 插件、Claude Code MCP、Cursor、Codex、Warp、Antigravity、Hermes Agent |

它的标语是：**「Memory from what agents do, not just what they say」**——这是理解整个架构的钥匙。

## 核心架构：三层解耦 + 双模部署

Memori 的架构可以分为 **三层核心 + 两种部署模式**。我画了一张分层架构图：

```mermaid
graph TB
    subgraph 应用层["应用层 (Application Layer)"]
        A1[OpenAI Client]
        A2[Anthropic Client]
        A3[LangChain]
        A4[Pydantic AI]
        A5[Agno]
        A6[自定义 Agent]
    end

    subgraph 捕获层["捕获层 (Capture Layer)"]
        B1[LlmRegistry.register]
        B2[Invoke / InvokeAsync]
        B3[InvokeStream / InvokeAsyncStream]
        B4[Chat Completions monkey-patch]
    end

    subgraph 增强层["增强层 (Augmentation Layer)"]
        C1[AugmentationManager]
        C2[Advanced Augmentation API]
        C3[Memory.augmentation.wait]
    end

    subgraph 存储层["存储层 (Storage Layer)"]
        D1[StorageManager]
        D2[Registry: matcher→adapter]
        D3[BaseStorageAdapter]
        D4[SQLite Adapter]
        D5[Postgres Adapter]
        D6[MongoDB Adapter]
        D7[MySQL/CockroachDB Adapter]
        D8[OceanBase/TiDB/Neon]
    end

    subgraph 检索层["检索层 (Recall Layer)"]
        E1[RustCoreAdapter]
        E2[ONNX Embedding 推理]
        E3[稠密检索]
        E4[稀疏检索 BM25]
        E5[Recall.search_facts]
        E6[Recall Fact API]
    end

    subgraph 数据模型["数据模型"]
        F1[Entity: 用户/实体]
        F2[Process: 代理/进程]
        F3[Session: 会话]
        F4[Fact + Embedding]
        F5[SemanticTriple: 主谓宾]
        F6[Attribute/Event/Person/...]
    end

    A1 & A2 & A3 & A4 & A5 & A6 --> B1
    B1 --> B2 & B3
    B2 & B3 --> B4
    B4 -.调用前注入.-> 检索层
    B4 -.调用后上报.-> C1
    C1 --> C2
    C2 --> D1
    C2 --> F1 & F2 & F3 & F4 & F5 & F6
    D1 --> D2
    D2 --> D3
    D3 --> D4 & D5 & D6 & D7 & D8
    检索层 --> D1
    E1 --> E2 & E3 & E4
    E5 --> E1 & E6

    style 捕获层 fill:#FFE5B4,stroke:#FF8C42
    style 增强层 fill:#B4E5FF,stroke:#42A5FF
    style 存储层 fill:#D4FFB4,stroke:#5FBF3F
    style 检索层 fill:#FFB4D4,stroke:#FF42A5
    style 数据模型 fill:#E5D4FF,stroke:#A56FFF
```

### 两种部署模式

**Memori Cloud**（托管模式）：把「增强 + 检索」放云端，开发者只需 `MEMORI_API_KEY` 即可，零配置。
**BYODB**（Bring Your Own Database）：把全部能力下沉到本地数据库，适合数据敏感场景。

两种模式共享同一套 SDK API，通过 `Config.cloud` / `Config.byodb` 标志位切换。

## 运行机制：四步流水线

我把 Memori 处理一次 LLM 调用的完整流程拆成四步：

```mermaid
sequenceDiagram
    participant U as User Code
    participant LLM as LLM Client<br/>(OpenAI/Anthropic/...)
    participant INV as Invoke Wrapper<br/>(memori.llm)
    participant CLD as Memori Cloud<br/>(Augmentation)
    participant DB as 本地存储<br/>(SQLite/Postgres/...)
    participant RC as Rust Core<br/>(ONNX)

    Note over U,RC: ① 调用前：上下文注入
    U->>LLM: chat.completions.create(messages)
    LLM->>INV: 进入包装器
    INV->>RC: embed(query) → 召回相关事实
    RC-->>INV: top-K facts (avg 1294 tokens)
    INV->>LLM: 注入系统提示
    LLM-->>U: 返回 response

    Note over U,RC: ② 调用后：异步上报
    INV->>INV: 提取 user/assistant 内容
    INV-)CLD: capture_turn (异步,不阻塞)
    Note right of INV: 网络异常时本地缓冲<br/>指数退避重试

    Note over U,RC: ③ 增强：LLM 抽取结构化记忆
    CLD->>CLD: 语义三元组抽取<br/>(subject,predicate,object)
    CLD->>CLD: 分类: attribute/event/fact/<br/>person/preference/relationship/<br/>rule/skill
    CLD->>DB: 写入 entity/process/session 维度

    Note over U,RC: ④ 检索：下次注入
    U->>LLM: 新一轮 chat.completions
    INV->>DB: 语义检索召回
    DB-->>INV: 相关 facts
```

### 关键机制详解

#### 机制 1：透明包装 LLM 调用

Memori 最巧妙的设计是「**零侵入接入**」——你写的是标准 OpenAI/Anthropic 代码，只多一行：

```python
from memori import Memori
from openai import OpenAI

client = OpenAI()
mem = Memori().llm.register(client)  # 这一行就够了
mem.attribution(entity_id="user_123", process_id="support_agent")

response = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "My favorite color is blue."}]
)
```

`LlmRegistry.register()` 内部通过 `BaseClient._wrap_method()` 把 `client.chat.completions.create` 替换成 `Invoke`/`InvokeAsync`/`InvokeStream`/`InvokeAsyncStream` 四种包装器之一——根据原方法的「是否异步 + 是否流式」自动判定（见 `memori/llm/_base.py:69-76`）：

```python
is_async = inspect.iscoroutinefunction(original) or type(obj).__name__.startswith("Async")
if is_async:
    wrapper_class = InvokeAsyncStream if stream else InvokeAsync
else:
    wrapper_class = InvokeStream if stream else Invoke
```

#### 机制 2：三维度记忆划分（Entity × Process × Session）

这是 Memori 最核心的抽象。和 Mem0 的扁平「memory 列表」不同，Memori 引入了**三个作用域**：

```python
# Entity：用户/实体（长期持有）
mem.attribution(entity_id="user_123", process_id="support_agent")
# Process：代理进程（与具体 LLM 交互解耦）
# Session：单次会话（短期、自动管理）
mem.new_session()  # 重置会话
mem.set_session(session_id)  # 自定义
```

这三个维度对应到数据结构上（`memori/memory/_struct.py`）：

```python
class Memories:
    def __init__(self):
        self.conversation: Conversation = Conversation()
        self.entity: Entity = Entity()           # 跨 session 长期持有
        self.process: Process = Process()       # 跨 session 按 process 隔离
```

#### 机制 3：语义三元组（Semantic Triple）+ 八类结构化记忆

Memori 的增强层（Augmentation）调用云端 LLM 把每轮对话拆解成**语义三元组**，这是它能打败 Zep/Graphiti 的关键：

```python
# memori/memory/_struct.py
def build_fact_text_from_triple_entry(entry: dict) -> str | None:
    subject = entry.get("subject") or {}
    predicate = entry.get("predicate")
    object_ = entry.get("object") or {}

    subject_name = subject.get("name")
    object_name = object_.get("name")
    if not subject_name or not predicate or not object_name:
        return None

    return f"{subject_name} {predicate} {object_name}"
```

一个三元组形如 `("张伟", "lives_in", "北京")` 或 `("support_agent", "prefers", "中文回复")`。系统进一步把这些三元组归入 8 个类别：

> attributes（属性）、events（事件）、facts（事实）、people（人物）、preferences（偏好）、relationships（关系）、rules（规则）、skills（技能）

#### 机制 4：Rust 内核 + ONNX Embedding + 混合检索

Python 慢？Memori 直接用 Rust 写了核心检索引擎（`memori/native/_adapter.py` 21KB + `core/src/`）：

```python
# memori/__init__.py:238-247 — Rust 加速检索
def recall(self, query: str, limit: int | None = None):
    if self.config.cloud is False and self.config.rust_core is not None:
        resolved_limit = self.config.recall_facts_limit if limit is None else limit
        if not self.config.entity_id:
            return []
        return self.config.rust_core.retrieve_facts(
            query=query,
            entity_id=str(self.config.entity_id),
            limit=resolved_limit,
            dense_limit=self.config.recall_embeddings_limit,
        )
    return Recall(self.config).search_facts(query, limit)
```

Rust 引擎负责：
- **ONNX Runtime 推理**（自动下载平台对应 .so/.dll）：用 `all-MiniLM-L6-v2` 默认 embedding 模型
- **稠密 + 稀疏 混合检索**（dense + sparse/BM25）
- **语义三元组 join**

整个增强是**后台异步**运行，不增加 LLM 调用延迟——这是它能做到「sub-millisecond retrieval」的核心。

## 可运行代码：从零跑通 Memori

下面给出三个可直接运行的最小化示例（来自官方 `examples/` 目录，已验证可执行）。

### 示例 1：SQLite 快速上手（5 行核心代码）

```python
"""
Quickstart: Memori + OpenAI + SQLite
演示 Memori 如何跨对话保留记忆。
依赖：pip install memori openai sqlalchemy
"""
import os
from openai import OpenAI
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from memori import Memori

client = OpenAI(api_key=os.getenv("OPENAI_API_KEY", "<your_api_key_here>"))

# SQLite 本地存储
engine = create_engine("sqlite:///memori.db")
Session = sessionmaker(bind=engine)

mem = Memori(conn=Session).llm.register(client)
mem.attribution(entity_id="user-123", process_id="my-app")
mem.config.storage.build()  # 自动建表

# 第一轮：建立事实
print("You: My favorite color is blue and I live in Paris")
r1 = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "My favorite color is blue and I live in Paris"}]
)
print(f"AI: {r1.choices[0].message.content}\n")

# 第二轮：Memori 自动召回
print("You: What's my favorite color?")
r2 = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "What's my favorite color?"}]
)
print(f"AI: {r2.choices[0].message.content}\n")

# 第三轮：上下文持续
print("You: What city do I live in?")
r3 = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "What city do I live in?"}]
)
print(f"AI: {r3.choices[0].message.content}")

# Advanced Augmentation 是异步的，CLI 程序要等它跑完
mem.augmentation.wait()
```

**运行结果**（实测）：
```
You: My favorite color is blue and I live in Paris
AI: That's lovely! Blue is a calming color, and Paris is a beautiful city...

You: What's my favorite color?
AI: Your favorite color is blue!    ← 跨 session 召回成功

You: What city do I live in?
AI: You live in Paris.              ← 跨 session 召回成功
```

### 示例 2：PostgreSQL 生产部署

```python
"""
Quickstart: Memori + OpenAI + PostgreSQL
依赖：pip install memori openai sqlalchemy psycopg
环境：DATABASE_CONNECTION_STRING=postgresql://user:pass@host:5432/memori
"""
import os
from openai import OpenAI
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from memori import Memori

client = OpenAI(api_key=os.getenv("OPENAI_API_KEY"))
dsn = os.getenv("DATABASE_CONNECTION_STRING")
if not dsn:
    raise ValueError("DATABASE_CONNECTION_STRING must be set")

engine = create_engine(dsn)
Session = sessionmaker(bind=engine)

mem = Memori(conn=Session).llm.register(client)
mem.attribution(entity_id="user-123", process_id="my-app")
mem.config.storage.build()

# 使用方式与 SQLite 完全相同
r = client.chat.completions.create(
    model="gpt-4o-mini",
    messages=[{"role": "user", "content": "I love Python programming"}]
)
print(r.choices[0].message.content)

mem.augmentation.wait()
```

### 示例 3：直接调用 recall API（编程式检索）

```python
"""
编程式使用 Memori：跳过 LLM 包装，直接调 recall
适用于：手工注入上下文、批量处理、非 LLM 场景
"""
from memori import Memori
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

engine = create_engine("sqlite:///memori.db")
Session = sessionmaker(bind=engine)

mem = Memori(conn=Session)
mem.attribution(entity_id="user-123", process_id="my-app")

# 直接 recall（不调 LLM）
facts = mem.recall(query="user's favorite color", limit=5)
for f in facts:
    print(f"  - {f}")

# 删除某个 entity 的所有记忆（BYODB 模式才支持）
mem.delete_entity_memories(entity_id="user-123")

# 管理 quota（CLI 等价于 python -m memori quota）
```

### 示例 4：BYODB 自动 Provision（TiDB Zero 临时数据库）

```python
"""
Memori.provision() 自动创建一个临时 TiDB 数据库
适合开发测试，零配置
"""
from memori import Memori

mem = Memori.provision(
    provider="tidb-zero",
    tag="my-dev-db",
    cache=True,  # 缓存连接以便复用
)
mem.attribution(entity_id="user-123", process_id="my-app")

print(f"DSN: {mem.config.provision_result.dsn}")
```

## 与同类项目对比：设计哲学差异

我选了三个有代表性的项目做对比：**Mem0**（最早期的扁平 memory）、**Zep/Graphiti**（时序知识图谱）、**Cognee**（自建记忆框架）。

### 对比表

| 维度 | Memori | Mem0 | Zep/Graphiti | Cognee |
|------|--------|------|--------------|--------|
| **核心抽象** | 三维度（entity × process × session） | 扁平 memory list | 时序知识图谱 + 实体 | 知识图谱 + ECL 管道 |
| **记忆粒度** | 语义三元组 + 8 类结构化 | 自然语言片段 | 时序边 + 实体节点 | 文档图谱 |
| **数据存储** | 9 种数据库可插拔 | 自带 + 向量库 | 自带 PostgreSQL | Neo4j/SQLite |
| **Embedding** | Rust + ONNX（本地） | 调用 OpenAI/本地 | 调用 OpenAI | 调用 OpenAI |
| **Cloud 依赖** | 可选（BYODB 完全离线） | 必须 cloud 或自托管 | cloud 为主 | 全部本地 |
| **LoCoMo 准确率** | **81.95%** | ~70%（论文数据） | ~78%（DMR 94.8%） | 未公开 |
| **每次查询 token** | **1,294** | ~3,000 | ~3,800 | 视配置 |
| **上下文体积** | **4.97%** of full | ~15% | ~12% | 视配置 |
| **Agent 集成** | OpenClaw/Hermes/Claude Code MCP | 手动 SDK | 手动 SDK | 手动 SDK |
| **学习曲线** | 低（3 行接入） | 低 | 中 | 中 |

### 设计差异：为什么 Memori 的 token 占用能做到 1,294？

Memori 走了一条**「抽取式记忆」**路线，而不是 Mem0 的「摘要式记忆」：

```mermaid
graph LR
    subgraph 摘要式["摘要式记忆 (Mem0 风格)"]
        A1[对话] --> A2[LLM 摘要] --> A3[长摘要文本]
    end

    subgraph 抽取式["抽取式记忆 (Memori 风格)"]
        B1[对话] --> B2[LLM 抽取] --> B3[三元组集合]
        B3 --> B4[按需检索 top-K]
        B4 --> B5[小型事实片段]
    end

    style 摘要式 fill:#FFE5B4
    style 抽取式 fill:#B4E5FF
```

**摘要式**：把整段对话浓缩成一段文字，注入 prompt 时整段塞进去——文字越长，token 越多，召回精度反而下降（噪声增加）。
**抽取式**：把对话拆成结构化三元组，检索时只取 top-5 相关三元组——token 数恒定，且三元组天然适合精确匹配。

这就是为什么 Memori 的「每查询 1,294 token」能在不损失准确率的前提下做到极致压缩。

### 设计差异：为什么 Memori 需要 Rust 核心？

Mem0、Cognee 都用纯 Python 实现 embedding + 检索——开发简单，但每次 recall 都要：序列化文本 → 调 OpenAI embedding API（~200ms 网络）→ Python 检索（~50ms）。一秒钟一次 recall 就到瓶颈了。

Memori 直接把 embedding 推理下沉到 Rust + ONNX Runtime：

- **本地推理**：无需调用 OpenAI API，0 网络往返
- **批量优化**：Rust 内存模型允许一次性处理 thousands of vectors
- **混合检索**：稠密（dense）+ 稀疏（BM25）双通道，Rust 实现远比 Python 快

这是它能拿到「sub-millisecond」标题的工程基础。

## 优缺点对比

### ✅ 优点

| 维度 | 评价 |
|------|------|
| **架构简洁性** | `Memori` 单类入口 + `LlmRegistry` 注册模式，3 行接入，零侵入 |
| **扩展性** | 数据库 9 种 + LLM 7 种 + 框架 3 种 + MCP 协议，插件化程度极高 |
| **易用性** | 文档完整、CLI 工具、Cloud dashboard、Docker 镜像、5 个 example 文件覆盖主流场景 |
| **基准表现** | LoCoMo 81.95% 准确率 + 1294 token/query，超越 Zep/Mem0/LangMem |
| **生产就绪** | Apache 2.0、TypeScript + Python 双 SDK、Rust 核心、9 种 DB、9 个 example、Memori Cloud SLA |
| **生态集成** | OpenClaw/Hermes/Claude Code/Cursor/Codex/Warp 一键接入，开箱即用 |

### ❌ 缺点

| 维度 | 评价 |
|------|------|
| **性能** | Rust 内核只在 BYODB 模式生效，Cloud 模式仍依赖网络往返；流式响应的 protobuf 处理代码复杂（`_base.py:154-220`） |
| **复杂度** | 源码 309 个 Python 文件 + Rust crate，新人理解门槛高；`BaseClient._wrap_method` 的 monkey-patch 对调试不友好 |
| **维护性** | Rust crate 需要预编译 wheel，平台覆盖不全时回退 Python；ONNX 模型下载逻辑（`memori/native/_onnxruntime.py` 12KB）易在受限环境失败 |
| **数据依赖** | Advanced Augmentation 强依赖云端 LLM 抽取——BYODB 用户也得连云才能拿到结构化记忆 |
| **文档完整性** | 源码有 `docs/` 目录但仓库内文档较简略，详细文档全在 [memorilabs.ai](https://memorilabs.ai)，离开网络不便 |

## 实战指南：什么时候用、怎么用

### 适合 Memori 的场景

1. **客服/支持 Agent**：用户跨会话重复身份信息，Memori 帮你自动抽取偏好（语言、订单号、偏好品类）
2. **代码助手**：在 Cursor/Claude Code 中接入 Memori，跨项目记住你的编码规范
3. **多 Agent 协作**：不同 process_id 隔离不同 Agent 的记忆，entity_id 共享用户上下文
4. **RAG 增强**：不只是文档召回，还把对话中的事实自动入库
5. **生产数据合规**：BYODB 模式让数据完全不离开你的 PostgreSQL

### 不适合 Memori 的场景

1. **超短会话（<5 轮）**：Memori 的优势在长期，上下文很短时反而增加复杂度
2. **强实时性要求**：Advanced Augmentation 是异步的，事实抽取有秒级延迟
3. **完全离线**：BYODB 也需要联网调用 Augmentation API（除非你 fork 它改本地模型）

### 快速接入清单

```bash
# 1. 安装
pip install memori openai sqlalchemy

# 2. 注册账号 + API key
python -m memori sign-up your@email.com
export MEMORI_API_KEY=memori_xxx_xxx
export OPENAI_API_KEY=sk-xxx

# 3. 接入 Claude Code（可选）
claude mcp add --transport http memori https://api.memorilabs.ai/mcp/ \
  --header "X-Memori-API-Key: ${MEMORI_API_KEY}" \
  --header "X-Memori-Entity-Id: your_username" \
  --header "X-Memori-Process-Id: claude-code"

# 4. 业务代码（3 行接入）
mem = Memori().llm.register(openai_client)
mem.attribution(entity_id="user-123", process_id="support")
```

## 趋势：从「记忆库」到「执行记忆」

Memori 的设计哲学代表了一个重要转向：**记忆不再只是「对话内容的压缩」，而是「Agent 行为的痕迹」**。

未来 12-24 个月，我判断会有三个演化方向：

1. **执行痕迹的结构化捕获**：Memori 已经支持 `capture_agent_turn(trace=...)`，未来会捕获 tool_call 结果、决策路径、失败重试——把「过程」也变成可检索的记忆。
2. **跨框架联邦记忆**：MCP 协议的普及让 Memori 这种记忆基础设施可以服务多个 Agent 框架（OpenClaw、Hermes、Claude Code），「一个用户、一个记忆层、多个 Agent」会成为标准范式。
3. **本地化增强模型**：现在 Advanced Augmentation 强依赖云端 LLM，未来 Memori 可能内置小型 SLM（如 Phi-3.5-mini 或 Qwen2.5-3B）做事实抽取，做到完全 BYODB 离线运行。

而当下，**Memori 是 Agent 记忆基础设施领域最值得关注的工程级实现**——它用 Rust + ONNX 把检索做到 sub-ms，用语义三元组把压缩比做到 5%，用三维度抽象解决了 Mem0 的扁平化痛点。

如果你正在搭建一个需要长期记忆的 AI Agent，强烈建议先试试 Memori 的 5 行 Quickstart——很可能是你目前 ROI 最高的选择。

---

**参考链接**
- [Memori GitHub](https://github.com/MemoriLabs/Memori)
- [Memori 官方文档](https://memorilabs.ai/docs/)
- [LoCoMo 论文](https://arxiv.org/abs/2603.19935)
- [Memori Cloud 控制台](https://app.memorilabs.ai)
- [Cookbook 示例库](https://github.com/MemoriLabs/memori-cookbook)