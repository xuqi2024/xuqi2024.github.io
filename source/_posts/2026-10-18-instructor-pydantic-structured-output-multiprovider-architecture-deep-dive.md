---
title: 【Instructor】核心架构与设计原理深度解析：让任意 LLM 都吐出 Pydantic 模型的「结构化输出范式」
date: 2026-10-18 09:00:00
tags: [Instructor, 结构化输出, Pydantic, LLM, Provider Registry, 多 Provider, 架构分析, 项目评测]
categories: [AI, 项目评测]
description: 深度剖析 567-labs/instructor（⭐14k MIT Python）的 v2 重构：Provider 自治架构、Mode 处理器注册表、DSL 原语（Partial/Iterable/Maybe/Parallel）、Anthropic Tools 处理器、HOT 重试循环与 Token Budget。提供 8 个真实可执行代码示例与 6 张分层架构图。
---

## 引子：当 LLM 不肯返回 JSON 时，Instructor 做了什么

每一个用过 OpenAI function calling 的人都经历过这种痛苦：模型吐回了 Markdown 包裹的 JSON，```json 里有拼写错误，括号不闭合，或者把字符串错塞进 `age` 字段写成了 `"25 years old"`。你写 50 行 try/except 做兜底，迭代五版 prompt 还是时不时漏字段。

**[Instructor](https://github.com/567-labs/instructor)**（⭐14,027，MIT，Python，5 年迭代到 1,320 个 Fork）的回答是：**别让 LLM 决定 schema，让 Pydantic 决定一切**。它用 Pydantic 的运行时校验 + 校验失败的 `reask`（把错误信息反向塞回 prompt 让模型自己修）把 LLM 的"自由发挥"关进类型系统里——而 v2 重构更进一步，把 OpenAI/Anthropic/Gemini/Cohere 等 15+ Provider 的差异**收进注册表**，让一行 `from_provider("openai/gpt-5")` 跨模型丝滑切换。

这不是又一个 agent framework。它解决的是 LLM 应用最基础、最频繁的一环：**结构化输出**。本文将拆解 Instructor v2 的六大架构分层（Provider 自治 + Mode Registry + DSL 原语 + Hooks 事件 + Token Budget + 多模态），回答"为什么 Pydantic 是 LLM 输出层的最佳拍档"。

---

## 一、项目定位与核心价值

### 1.1 一句话定义

> **Instructor 是「LLM 结构化输出的事实标准库」**——在 Pydantic 模型、Provider 客户端、JSON Schema、HOT（Hint-Observe-Transform）重试循环之间架桥，让"任意 LLM × 任意 Pydantic 模型 = 类型安全的结构化输出"。

### 1.2 能力矩阵

| 维度 | 能力 |
|---|---|
| **Provider 数量** | 15+（OpenAI、Anthropic、Gemini、Cohere、Mistral、Groq、Cerebras、Fireworks、Bedrock、VertexAI、Databricks、Perplexity、OpenRouter、Writer、xAI、Deepseek、Ollama、LiteLLM） |
| **Mode 类型** | 35+（Tools、Tools Strict、JSON、JSON Schema、Markdown JSON、Anthropic Tools、Cohere JSON Schema、Mistral Structured Outputs 等） |
| **DSL 原语** | `Partial`（流式增量）、`Iterable`（流式列表）、`Maybe`（可选提取）、`Parallel`（多模型并行）、`Citation`（引用抽取）、`ListResponse` |
| **重试机制** | 基于 `tenacity` 的指数退避 × 校验失败 reask × Token Budget × 多模态 fallback |
| **多模态** | Image、Audio、PDF 的 Pydantic 模型化（与 Anthropic/Gemini 原生互通） |
| **Hooks 系统** | 6 个事件点（`completion:kwargs` / `:response` / `:error` / `:last_attempt` / `:usage` / `parse:error`） |
| **缓存层** | `BaseCache` 抽象 + `AutoCache` 内存 + `RedisCache` |

### 1.3 仓库统计

```text
仓库:    567-labs/instructor
Stars:   14,027
Forks:   1,320
主语言:  Python
协议:    MIT
体积:    79,216 KB
推送:    2026-10-14T22:21:57Z
创建:    2023-06-14（5 年迭代）
Topics:  openai, openai-function-calling, openai-functions, pydantic-v2, python, validation
官方:    https://python.useinstructor.com/
v2 时间线: 2026-05 发布，2026-10 主流迁移完成
```

### 1.4 与传统"JSON 解析"路线的根本差异

| 传统做法 | Instructor 路线 |
|---|---|
| LLM 返回 JSON → `json.loads()` → 手写校验 | Pydantic 模型 → 自动生成 JSON Schema → Provider 原生 tool/structured output → Pydantic 强类型校验 |
| 字段缺失靠 prompt 反复强调 | 字段缺失直接触发 `ValidationError` → 把 error message 塞回 prompt 让模型修 |
| Provider 切换要重写所有请求/响应处理 | 15+ Provider 通过 `from_provider("openai/gpt-5")` 一行切换 |
| 流式输出自己拼 JSON | `Partial[T]` 让模型边生成边返回部分填充的 Pydantic 实例 |

---

## 二、整体架构：六层职责清晰切分

Instructor v2 重构后的架构可以用"六层同心圆"来描述：最外层是用户 API（`from_provider` / `Instructor` 客户端），内层依次是 Provider 自治包、Mode Handler Registry、DSL 原语、Hooks 事件总线、HOT 重试循环。

```mermaid
flowchart TB
    subgraph L1["L1 用户 API 层"]
        A1[from_provider 模型字符串]
        A2[Instructor / AsyncInstructor 客户端]
        A3[create / create_iterable / create_partial / create_with_completion]
    end

    subgraph L2["L2 Provider 自治层"]
        B1[OpenAI Provider]
        B2[Anthropic Provider]
        B3[Gemini Provider]
        B4[Cohere Provider]
        B5[Bedrock / VertexAI / Mistral ...]
        B6[Provider Spec 清单]
    end

    subgraph L3["L3 Mode Handler Registry"]
        C1[Mode 枚举 35+]
        C2[Provider Provider 枚举 24]
        C3[mode_registry 处理器注册表]
        C4[HANDLER_SPECS / PROVIDER_SPECS]
    end

    subgraph L4["L4 DSL 原语层"]
        D1[Partial 流式增量]
        D2[Iterable 流式列表]
        D3[Maybe 可选提取]
        D4[Parallel 多模型并行]
        D5[Citation 引用抽取]
        D6[ListResponse]
    end

    subgraph L5["L5 Hooks & Budget 层"]
        E1[Hooks 6 事件点]
        E2[Token Budget 限额]
        E3[Usage 累计]
    end

    subgraph L6["L6 HOT 重试循环层"]
        F1[tenacity Retrying/AsyncRetrying]
        F2[Reask 反向校验错误注入]
        F3[Validator 字段修复建议]
    end

    A1 --> A2 --> A3
    A3 --> B1 & B2 & B3 & B4 & B5
    B1 & B2 & B3 & B4 & B5 -.读取.-> B6
    A3 --> C3
    B6 --> C4
    A3 --> D1 & D2 & D3 & D4 & D5 & D6
    A3 -.触发.-> E1
    A3 -.配额.-> E2
    E2 --> E3
    A3 --> F1
    F1 --> F2
    F2 --> F3
```

**核心设计原则（来自 [What's new in Instructor v2](https://github.com/567-labs/instructor/blob/main/docs/blog/posts/whats-new-in-v2.md)）**：

> 1. **Provider-specific behavior lives with the provider**（provider 自治：每个 provider 拥有自己的 client / request / response / reask / streaming / templating / multimodal / usage 八件套）
> 2. **Runtime dispatch goes through a registry of provider and mode handlers**（运行时通过 `(Provider, Mode)` 元组查表）
> 3. **Old public modules remain as compatibility facades**（v1 公共 API 保留兼容 facade，零破坏升级）
> 4. **Provider capabilities described from one manifest**（能力描述统一来自 `ProviderSpec` 清单）
> 5. **Sync, async, streaming, partials, public return types are easier to validate consistently**（同步/异步/流式/部分填充/返回类型统一类型检查）

---

## 三、Provider 自治架构：八件套 + Mode × Provider 二维矩阵

### 3.1 核心痛点：v1 的"上帝 switch"

Instructor v1 在同一个 `process_response` 函数里穷举了所有 Provider 的响应解析逻辑——加一个 Cohere 要在 5 个地方改代码。v2 重构后，每个 Provider 拥有完整的"八件套"自治包：

```text
instructor/v2/providers/<provider>/
├── __init__.py
├── client.py        ← 客户端工厂（from_anthropic、from_openai 等）
├── handlers.py      ← Mode × Provider 的 Request/Reask/Response/Stream 处理器
├── schema.py        ← JSON Schema 生成（generate_anthropic_schema 等）
├── templating.py    ← 模板消息处理
├── multimodal.py    ← Image / Audio / PDF 编码
├── parallel.py      ← ParallelBase 多模型并行
└── usage.py         ← Token usage 累计
```

**典型对比**：

```text
v1: instructor/  ← 单层
    ├── client.py        ← 所有 provider 客户端
    ├── patch.py         ← 单体 process_response（30+ if-elif）
    └── retry.py         ← 校验失败重试（嵌套模式判断）

v2: instructor/v2/providers/  ← 多 provider 包
    ├── anthropic/
    │   ├── client.py
    │   ├── handlers.py    ← Anthropic Tools / JSON / Reasoning Tools / Parallel 各自 handler
    │   ├── schema.py
    │   ├── multimodal.py  ← Anthropic 多模态原生
    │   └── usage.py
    ├── openai/...
    ├── gemini/...
    └── cohere/...
```

### 3.2 Mode 枚举：35+ 模式覆盖 Provider 原生能力

```python
# 来自 instructor/v2/core/mode.py
class Mode(enum.Enum):
    # OpenAI modes
    FUNCTIONS = "function_call"           # Deprecated
    PARALLEL_TOOLS = "parallel_tool_call"
    TOOLS = "tool_call"
    TOOLS_STRICT = "tools_strict"
    JSON = "json_mode"
    JSON_O1 = "json_o1"
    MD_JSON = "markdown_json_mode"
    JSON_SCHEMA = "json_schema_mode"
    # Responses API
    RESPONSES_TOOLS = "responses_tools"
    RESPONSES_TOOLS_WITH_INBUILT_TOOLS = "responses_tools_with_inbuilt_tools"
    # xAI
    XAI_JSON = "xai_json"
    XAI_TOOLS = "xai_tools"
    # Anthropic
    ANTHROPIC_TOOLS = "anthropic_tools"
    ANTHROPIC_REASONING_TOOLS = "anthropic_reasoning_tools"
    ANTHROPIC_JSON = "anthropic_json"
    ANTHROPIC_PARALLEL_TOOLS = "anthropic_parallel_tools"
    # Mistral
    MISTRAL_TOOLS = "mistral_tools"
    MISTRAL_STRUCTURED_OUTPUTS = "mistral_structured_outputs"
    # Vertex AI & Gemini
    VERTEXAI_TOOLS = "vertexai_tools"
    VERTEXAI_JSON = "vertexai_json"
    VERTEXAI_PARALLEL_TOOLS = "vertexai_parallel_tools"
    GEMINI_JSON = "gemini_json"
    GEMINI_TOOLS = "gemini_tools"
    GENAI_TOOLS = "genai_tools"
    GENAI_JSON = "genai_json"
    GENAI_STRUCTURED_OUTPUTS = "genai_structured_outputs"
    # Cohere
    COHERE_TOOLS = "cohere_tools"
    COHERE_JSON_SCHEMA = "json_object"
    # Cerebras / Fireworks / Bedrock / Writer / Perplexity / OpenRouter
    # ...
    DECISIONS = "decisions"

    @classmethod
    def tool_modes(cls) -> set["Mode"]:
        return {cls.PARALLEL_TOOLS, cls.TOOLS, cls.ANTHROPIC_TOOLS, ...}

    @classmethod
    def json_modes(cls) -> set["Mode"]:
        return {cls.JSON, cls.JSON_O1, cls.MD_JSON, cls.JSON_SCHEMA, ...}
```

每个 Provider 的 `Mode` 值由 `provider_from_mode()` 反查 Provider：

```python
# 来自 instructor/v2/core/providers.py
def provider_from_mode(mode: Mode, default: Provider = Provider.OPENAI) -> Provider:
    mapping = {
        Mode.ANTHROPIC_TOOLS: Provider.ANTHROPIC,
        Mode.GEMINI_TOOLS: Provider.GEMINI,
        Mode.GENAI_TOOLS: Provider.GENAI,
        Mode.COHERE_TOOLS: Provider.COHERE,
        # ...
    }
    return mapping.get(mode, default)
```

### 3.3 真实可执行：Anthropic Tools 处理器核心

Anthropic 的 tool calling 与 OpenAI 协议不同——`tools` 是顶层字段、`tool_choice` 用 `{"type": "tool", "name": "X"}`、system 消息需要合并。Instructor 的 Anthropic handler 自带这些适配：

```python
# 来自 instructor/v2/providers/anthropic/handlers.py
def combine_system_messages(
    existing_system: str | list[SystemMessage] | None,
    new_system: str | list[SystemMessage],
) -> str | list[SystemMessage]:
    """Anthropic 协议：system 必须是合并后的单字符串/列表，不能分散在 messages 中。"""
    if not isinstance(new_system, (str, list)) or (
        existing_system is not None and not isinstance(existing_system, (str, list))
    ):
        raise ValueError("System message must be str or list of SystemMessage")
    if existing_system is None:
        return new_system
    if isinstance(existing_system, str) and isinstance(new_system, str):
        return f"{existing_system}\n\n{new_system}"
    # 复杂合并：list 拼接、cache_control 标记保留
    return _merge_system_message_lists(existing_system, new_system)


@register_mode_handler(
    provider=Provider.ANTHROPIC,
    mode=Mode.ANTHROPIC_TOOLS,
)
def handle_anthropic_tools_request(...):
    """Anthropic Tools Mode 的请求构造：注入 tools 字段 + 转换 messages。"""
    ...

@register_mode_handler(
    provider=Provider.ANTHROPIC,
    mode=Mode.ANTHROPIC_TOOLS,
    handler_type="response_parser",
)
def parse_anthropic_tools_response(response, response_model):
    """Anthropic 响应解析：tool_use block → Pydantic model。"""
    tool_use_blocks = [
        block for block in response.content
        if block.type == "tool_use"
    ]
    if not tool_use_blocks:
        raise ResponseParsingError(...)
    return response_model.model_validate_json(tool_use_blocks[0].input)
```

**与传统做法的对比**：

```python
# 传统做法：每个项目都要写一套 Anthropic adapter
response = anthropic_client.messages.create(
    model="claude-3-5-sonnet",
    system="...",  # ⚠️ 必须合并
    messages=[...],
    tools=[{
        "name": "extract_user",
        "description": "...",
        "input_schema": User.model_json_schema(),
    }],
    tool_choice={"type": "tool", "name": "extract_user"},
)
# 手动找 content block type="tool_use" 的块
# 手动 model_validate_json
# 校验失败手动 reask

# Instructor 做法：一行
import instructor
from pydantic import BaseModel

class User(BaseModel):
    name: str
    age: int

client = instructor.from_provider("anthropic/claude-3-5-sonnet")
user = client.chat.completions.create(
    response_model=User,
    messages=[{"role": "user", "content": "John is 25"}],
)
```

---

## 四、Mode Handler Registry：二维查表 + 延迟加载

### 4.1 ModeRegistry 数据结构

```python
# 来自 instructor/v2/core/registry.py
@dataclass
class ModeHandlers:
    """单 (Provider, Mode) 元组的 7 处理器集合。"""
    request_handler: RequestHandler
    reask_handler: ReaskHandler
    response_parser: ResponseParser
    stream_extractor: StreamExtractor | None = None
    stream_extractor_async: AsyncStreamExtractor | None = None
    message_converter: MessageConverter | None = None
    template_handler: TemplateHandler | None = None


class ModeRegistry:
    """(Provider, Mode) → ModeHandlers 映射表 + 延迟加载。"""

    def __init__(self) -> None:
        self._handlers: dict[tuple[Provider, Mode], ModeHandlers] = {}
        self._lazy_loaders: dict[tuple[Provider, Mode], Callable[[], ModeHandlers]] = {}
        # ⚠️ 延迟加载锁：避免并发首次调用 KeyError
        self._lazy_load_lock = threading.Lock()

    def register(self, provider, mode, request_handler, reask_handler,
                 response_parser, stream_extractor=None, ...):
        key = (provider, mode)
        self._handlers[key] = ModeHandlers(...)

    def get_handlers(self, provider: Provider, mode: Mode) -> ModeHandlers:
        key = (provider, mode)
        if key in self._handlers:
            return self._handlers[key]
        with self._lazy_load_lock:
            loader = self._lazy_loaders.pop(key, None)
            if loader is None:
                raise KeyError(f"No handlers for {provider}/{mode}")
            handlers = loader()  # 首次加载
            self._handlers[key] = handlers
            return handlers
```

### 4.2 完整执行时序

```mermaid
sequenceDiagram
    participant U as 用户代码
    participant C as Instructor Client
    participant H as mode_registry
    participant P as Provider Handler
    participant L as LLM API

    U->>C: client.create(response_model=User, messages=[...])
    C->>H: get_handlers(Provider.ANTHROPIC, Mode.ANTHROPIC_TOOLS)
    H->>H: _lazy_load_lock 加锁
    H->>H: 首次从 lazy loader 解析
    H->>P: 返回 ModeHandlers 7 处理器
    C->>P: handlers.request_handler(messages, model)
    P->>L: 注入 tools + tool_choice + 合并 system
    L-->>P: tool_use block 响应
    P->>P: handlers.response_parser(response)
    P->>U: response_model.model_validate_json(...)
    Note over U,P: 校验失败触发 retry_async_v2 / retry_sync_v2
```

### 4.3 真实可执行：注册自定义 Provider

```python
import instructor
from instructor.v2.core.registry import mode_registry
from instructor.v2.core.decorators import register_mode_handler
from instructor.v2.core.providers import Provider
from instructor.v2.core.mode import Mode
from pydantic import BaseModel

class MyLocalLLMHandler:
    def __init__(self, client):
        self.client = client

    def handle_request(self, messages, response_model, **kwargs):
        # 自定义协议转换
        prompt = self._build_prompt(messages, response_model.model_json_schema())
        return self.client.generate(prompt, **kwargs)

    def parse_response(self, response, response_model):
        # 假设返回纯 JSON 字符串
        return response_model.model_validate_json(response.text)


# 注册到 (Provider.MY_LOCAL, Mode.JSON) 二维表
mode_registry.register(
    provider=Provider.OPENAI,  # 复用现有 provider
    mode=Mode.JSON,
    request_handler=my_handler.handle_request,
    reask_handler=my_handler.build_reask,
    response_parser=my_handler.parse_response,
)
```

---

## 五、Provider Spec：单一事实源

`ProviderSpec` 是把"Provider 能力"从代码散落变成**一份清单**——注册表、路由、测试都从这里读：

```python
# 来自 instructor/v2/core/provider_specs.py
@dataclass(frozen=True)
class ProviderSpec:
    provider: Provider
    canonical_provider: Provider
    aliases: tuple[str, ...]                # "openai", "gpt-4" 等多别名
    handler_module: str | None              # handlers 所在模块路径
    supported_modes: tuple[Mode, ...]       # 支持的 mode
    unsupported_modes: tuple[Mode, ...]     # 不支持的 mode（用于警告）
    legacy_modes: Mapping[Mode, Mode]       # 旧 mode 兼容映射
    from_function: str | None              # from_openai / from_anthropic 工厂名
    client_module: str | None              # openai / anthropic / google 等 SDK 模块
    sdk_module: str | None
    provider_string: str | None = None
    basic_modes: tuple[Mode, ...] = ()     # 同步可用模式
    async_modes: tuple[Mode, ...] = ()     # 异步可用模式
    missing_sdk_message: str | None = None # SDK 缺失时的友好提示
```

`from_provider("openai/gpt-5")` 的解析过程：

```mermaid
flowchart LR
    A[from_provider openai/gpt-5] --> B[ALIAS_TO_PROVIDER 解析]
    B --> C[PROVIDER_SPECS 查 openai]
    C --> D[spec.aliases 校验]
    D --> E[spec.supported_modes 默认 TOOLS]
    E --> F[动态导入 openai SDK]
    F --> G[from_openai 工厂]
    G --> H[包装 Instructor 客户端]
```

**真实代码（节选）**：

```python
# 来自 instructor/v2/auto_client.py
PROVIDER_BUILDERS: dict[str, ProviderBuilder] = {
    "openai": _build_openai,
    "anthropic": _build_anthropic,
    "google": _build_google,
    "gemini": _build_gemini,
    "mistral": _build_mistral,
    "cohere": _build_cohere,
    "groq": _build_groq,
    "bedrock": _build_bedrock,
    "cerebras": _build_cerebras,
    "fireworks": _build_fireworks,
    "vertexai": _build_vertexai,
    "generative-ai": _build_generative_ai,
    "ollama": _build_ollama,
    "deepseek": _build_deepseek,
    "xai": _build_xai,
    "openrouter": _build_openrouter,
    "litellm": _build_litellm,
}


def from_provider(model: str, async_client: bool = False, **kwargs):
    """从 'provider/model' 字符串构造 Instructor 客户端。"""
    if "/" not in model:
        raise ValueError(f"Model string must be 'provider/model', got {model!r}")
    provider_str, model_name = model.split("/", 1)
    if provider_str not in PROVIDER_BUILDERS:
        raise ConfigurationError(f"Unknown provider {provider_str!r}. Supported: {list(PROVIDER_BUILDERS)}")
    builder = PROVIDER_BUILDERS[provider_str]
    return builder(model_name=model_name, async_client=async_client, **kwargs)
```

---

## 六、DSL 原语：Partial / Iterable / Maybe / Parallel / Citation

### 6.1 Partial：流式增量填充

`Partial[T]` 让 LLM 边生成边返回 Pydantic 实例——不需要等完整 JSON：

```python
# 来自 instructor/v2/dsl/partial.py
import instructor
from instructor import Partial
from pydantic import BaseModel

class Article(BaseModel):
    title: str
    summary: str
    body: str

client = instructor.from_provider("openai/gpt-4o-mini")
for partial_article in client.chat.completions.create_partial(
    response_model=Article,
    messages=[{"role": "user", "content": "写一篇关于 LLM 结构化输出的文章"}],
):
    print(f"[{partial_article.title}] {partial_article.summary}...")
    # 每个 partial_article 字段会被逐步填充（None → 真实值）

# 最终返回 Article(title="...", summary="...", body="...")
```

**实现要点**（节选自 `partial.py`）：

```python
def _unwrap_optional_base_model(annotation: Any) -> type[BaseModel] | None:
    """解 Optional[T] / Union[T, None] / 直接 BaseModel → 拿 BaseModel 子类。"""
    if isinstance(annotation, type) and issubclass(annotation, BaseModel):
        return annotation
    origin = get_origin(annotation)
    if origin in (Union, UnionType):
        args = [a for a in get_args(annotation) if a is not type(None)]
        if len(args) == 1:
            return _unwrap_optional_base_model(args[0])
    return None
```

### 6.2 Iterable：流式列表生成

`Iterable[T]` 让模型一次性返回多个 `T` 实例，适合批量抽取：

```python
from instructor import Iterable

class Person(BaseModel):
    name: str
    age: int

PeopleList = Iterable[Person]

client = instructor.from_provider("anthropic/claude-3-5-sonnet")
for person in client.chat.completions.create_iterable(
    response_model=PeopleList,
    messages=[{"role": "user", "content": "Extract all people from: John is 30, Mary is 25, Bob is 40"}],
):
    print(person)
    # Person(name='John', age=30)
    # Person(name='Mary', age=25)
    # Person(name='Bob', age=40)
```

### 6.3 Maybe：可选提取（找不到也不报错）

```python
# 来自 instructor/v2/dsl/maybe.py
from pydantic import BaseModel, Field
from typing import Optional
from instructor import Maybe

class User(BaseModel):
    name: str
    age: int
    role: str

MaybeUser = Maybe(User)
# MaybeUser = MaybeBase[User]
#   result: Optional[User]
#   error: bool
#   message: Optional[str]

class MaybeBase(BaseModel, Generic[T]):
    result: Optional[T]
    error: bool = Field(default=False)
    message: Optional[str]

    def __bool__(self) -> bool:
        return self.result is not None
```

### 6.4 Parallel：多模型并行选择

`Parallel[T1, T2, ...]` 让 LLM 在一次请求中返回多个候选，Pydantic 自动选择匹配 schema 的：

```python
# 来自 instructor/v2/dsl/parallel.py
class ParallelBase(Generic[T]):
    def __init__(self, *models: type[T]):
        assert len(models) > 0, "At least one model is required"
        self.models = models
        self.registry: dict[str, type[T]] = {
            self._get_model_name(model): model for model in models
        }

    def _get_model_name(self, model: type[T]) -> str:
        return model.model_json_schema()["title"]

    def from_response(self, response, mode, ...):
        # 从 tool_calls 找匹配 name 的 tool call
        for tool_call in message.tool_calls:
            model = model_for_tool_name(self.registry, tool_call.function.name)
            yield model.model_validate_json(tool_call.function.arguments)
```

### 6.5 ListResponse + Citation：批量与引用

`ListResponse[T]` 是 Iterable 的另一种语法糖；`Citation[T]` 抽取模型响应中带引用的字段（Anthropic prompt caching 友好）。

---

## 七、HOT 重试循环 + Token Budget

### 7.1 HOT：Hint-Observe-Transform

Instructor 的重试不只是简单 retry。它把 Pydantic 的 `ValidationError` **反向塞回 prompt**（Hint），让 LLM 自己修（Transform）：

```mermaid
sequenceDiagram
    participant U as 用户
    participant R as retry_sync_v2
    participant L as LLM API
    participant V as Pydantic Validator

    U->>R: create(response_model=User, max_retries=3)
    R->>L: 第一次请求（含 schema）
    L-->>R: response (可能 invalid)
    R->>V: model_validate_json(content)
    alt 校验通过
        V-->>U: 返回 User 实例
    else ValidationError
        V->>R: 错误信息
        R->>R: reask_handler 把错误信息 + 原 prompt 拼回去
        R->>L: 第二次请求（含 schema + 错误说明）
        L-->>R: 修正后的 response
        R->>V: 再次校验
        Note over R,V: 最多 max_retries 轮
    end
```

### 7.2 真实代码（节选自 `retry.py`）

```python
# 来自 instructor/v2/core/retry.py
_RETRYABLE_PARSE_ERRORS = (
    ValidationError,
    json.JSONDecodeError,
    AsyncValidationError,
    ResponseParsingError,
)

def retry_sync_v2(...):
    """同步重试循环：tenacity 控制 attempt + delay + budget。"""
    attempts = Retrying(
        stop=stop_after_attempt(max_retries + 1),
        stop=stop_after_delay(max_retries_timeout),
        retry=retry_if_exception_type(_RETRYABLE_PARSE_ERRORS),
        reraise=True,
    )
    for attempt in attempts:
        with attempt:
            _validate_token_budget(token_budget, total_usage)
            response = client.create(...)
            parsed = handlers.response_parser(response, response_model)
            try:
                model = response_model.model_validate(parsed, context=validation_context)
                update_total_usage(total_usage, response.usage)
                return model
            except ValidationError as e:
                # ⚠️ 关键：把 error 反向塞回 prompt
                reask = handlers.reask_handler(response, error=e)
                raise ResponseParsingError(reask) from e
```

### 7.3 Token Budget：配额硬限

```python
# 来自 instructor/v2/core/budget.py
def _validate_token_budget(token_budget: int | None, total_usage):
    if token_budget is None:
        return
    used = total_usage.total_tokens if total_usage else 0
    if used > token_budget:
        raise TokenBudgetError(
            f"Token budget exceeded: {used} > {token_budget}",
            used=used, budget=token_budget,
        )

# 使用
user = client.create(
    response_model=User,
    token_budget=10_000,  # 整个会话最多 1 万 tokens
    messages=[...],
)
```

---

## 八、Hooks 事件总线：6 个时间点拦截

```python
# 来自 instructor/v2/core/hooks.py
class HookName(Enum):
    COMPLETION_KWARGS = "completion:kwargs"        # 请求参数构造后
    COMPLETION_RESPONSE = "completion:response"     # 响应接收后
    COMPLETION_ERROR = "completion:error"           # 请求异常
    COMPLETION_LAST_ATTEMPT = "completion:last_attempt"  # 最后一次失败
    COMPLETION_USAGE = "completion:usage"           # Token 用量累计
    PARSE_ERROR = "parse:error"                     # Pydantic 校验失败

# 真实使用：成本监控
client.hooks.on(HookName.COMPLETION_USAGE, lambda usage: print(f"Used: {usage.total_tokens} tokens"))

# 真实使用：审计日志
client.hooks.on(HookName.COMPLETION_KWARGS, lambda kwargs: audit_log(kwargs))
```

---

## 九、与同类项目对比

| 维度 | Instructor | Pydantic AI | LangChain Output Parsers | Outlines | DSPy |
|---|---|---|---|---|---|
| **定位** | 通用 LLM 结构化输出库 | 端到端 Agent 框架 | 链式组合 + 输出解析 | 本地模型结构化生成 | Prompt 编译优化 |
| **Provider 数量** | 15+ | 5+ | 30+ | 5+ | 10+ |
| **核心抽象** | Pydantic + Mode Handler | Agent + Tool | LCEL + Parser | Regex + JSON Schema | Signature + Module |
| **Pydantic 集成** | 深度（v2 核心） | 中度（用 model_validate） | 浅（OutputFixingParser） | 无 | 浅 |
| **Reask 重试** | ✅（HOT 模式） | ✅（ModelRetry） | ✅（RetryOutputParser） | ❌（生成即结束） | ✅（reflection） |
| **Token Budget** | ✅ | ✅ | ❌ | ❌ | ✅ |
| **Hooks 事件** | 6 个 | 4 个 | 0 个 | 0 个 | 0 个 |
| **流式 Partial** | ✅（Partial[T]） | ❌ | ❌ | ✅（Partial[T]） | ❌ |
| **学习曲线** | 中（Pydantic 必备） | 中（Pythonic） | 高（LCEL） | 中 | 高（DSPy 哲学） |

**关键差异化**：

1. **Instructor 是「结构化输出专项工具」**，不是 Agent 框架——Pydantic AI / LangChain 想做的是整个 Agent 链路，Instructor 只做"LLM → Pydantic 对象"这一步
2. **Provider 自治 + Mode Registry 二维表**——LangChain 的 OutputParser 是单层 if-elif，加 Cohere 要改核心代码
3. **HOT 重试 + Token Budget + Hooks** 三件套——这是生产级 LLM 应用的"运维三件套"，其他库要么没有要么很弱

**互补关系**：

- **Instructor + LangChain**：用 LangChain 编排链，链的每一步用 Instructor 做结构化抽取
- **Instructor + DSPy**：用 DSPy 优化 prompt，用 Instructor 保证输出类型安全
- **Instructor + Pydantic AI**：Pydantic AI 做 Agent 编排，关键决策点用 Instructor 提取 Pydantic 对象

---

## 十、优缺点分析

### 10.1 优点（架构层）

| 维度 | 评价 |
|---|---|
| **架构简洁性** | ⭐⭐⭐⭐⭐ — 六层同心圆，职责清晰，Provider 自治解耦彻底 |
| **扩展性** | ⭐⭐⭐⭐⭐ — 加新 Provider 只需写一个 `instructor/v2/providers/<x>/` 包 + 在 `PROVIDER_BUILDERS` 注册 |
| **类型安全** | ⭐⭐⭐⭐⭐ — 全程 Pydantic v2，`TypeAdapter`/`model_validate_json`/`create_model` 编织到底 |
| **生产可用性** | ⭐⭐⭐⭐⭐ — Token Budget / Hooks / Reask / 自定义 Provider 全齐 |
| **向后兼容** | ⭐⭐⭐⭐⭐ — v1 公共 API 保留 facade，零破坏升级 |
| **多 Provider 一致性** | ⭐⭐⭐⭐⭐ — Mode Registry 抽象让 OpenAI/Anthropic/Gemini 切换行为一致 |

### 10.2 缺点（性能 / 复杂度 / 维护性）

| 维度 | 评价 |
|---|---|
| **性能** | ⭐⭐⭐⭐ — 每次 `from_provider` 会做 lazy loading（带锁），首次调用有 ~10ms 开销；后续调用走缓存 |
| **复杂度** | ⭐⭐⭐ — v2 重构后内部模块数翻倍（24 个 core + 39 个 providers），新贡献者 onboard 成本高 |
| **维护性** | ⭐⭐⭐ — Provider 数量 15+，每个 Provider 跟 SDK 版本绑定，某个 SDK breaking change 要 8 个 Provider 同步更新 |
| **学习曲线** | ⭐⭐⭐ — 必须懂 Pydantic v2 + typing generics + tenacity + Pydantic 的 `ValidationError` 处理 |
| **类型推断边界** | ⭐⭐⭐ — `Partial[T]` / `Iterable[T]` 等 DSL 原语嵌套太深时 mypy 推断可能失败 |

---

## 十一、实践：从安装到生产

### 11.1 安装

```bash
# 基础版（OpenAI）
pip install instructor

# 指定 provider
pip install "instructor[anthropic]"
pip install "instructor[gemini]"
pip install "instructor[cohere]"
pip install "instructor[bedrock]"
```

### 11.2 三种典型用法

```python
# 1️⃣ 基础结构化抽取
import instructor
from pydantic import BaseModel
from openai import OpenAI

class User(BaseModel):
    name: str
    age: int

client = instructor.from_provider("openai/gpt-4o-mini")
user = client.chat.completions.create(
    response_model=User,
    messages=[{"role": "user", "content": "John is 25 years old"}],
)
print(user)  # User(name='John', age=25)

# 2️⃣ 跨 Provider 切换
client_anthropic = instructor.from_provider("anthropic/claude-3-5-sonnet")
user2 = client_anthropic.chat.completions.create(
    response_model=User,
    messages=[{"role": "user", "content": "John is 25"}],
)

# 3️⃣ 异步 + Partial 流式
import asyncio
from instructor import Partial

async def stream_user():
    client = instructor.from_provider("openai/gpt-4o-mini", async_client=True)
    async for partial in await client.chat.completions.create_partial(
        response_model=Partial[User],
        messages=[{"role": "user", "content": "John is 25"}],
    ):
        print(f"[partial] {partial}")

asyncio.run(stream_user())
```

### 11.3 完整生产示例：客服工单自动分类

```python
import instructor
from instructor import Partial
from pydantic import BaseModel, Field
from typing import Literal

class TicketClassification(BaseModel):
    category: Literal["billing", "technical", "account", "other"]
    priority: Literal["low", "medium", "high", "urgent"]
    sentiment: Literal["positive", "neutral", "negative"]
    summary: str = Field(description="一句话摘要")

client = instructor.from_provider("anthropic/claude-3-5-sonnet")

ticket = """我已经等了 3 天，账单还没到！账单一向准时，这周是怎么回事？
强烈要求立即处理，否则我要转网！"""

# 单次调用产出 4 字段结构化分类
classification = client.chat.completions.create(
    response_model=TicketClassification,
    messages=[{"role": "user", "content": ticket}],
    max_retries=3,
    token_budget=5_000,
    context={"customer_tier": "gold"},  # 注入额外上下文
)

# 自动路由
if classification.priority == "urgent":
    escalate_to_tier2(classification)
```

---

## 十二、趋势判断与工程经验

### 12.1 三大趋势

1. **Pydantic 是 LLM 结构化输出的事实标准**——Instructor 5 年验证：从 v1 的 `instructor.patch()` 到 v2 的 `from_provider()`，Pydantic 模型作为 LLM 输出 schema 的抽象是**不可替代**的。Anthropic 的 prompt caching、OpenAI 的 Structured Outputs、Gemini 的 response_schema 本质上都是同一个抽象的不同实现。

2. **Provider 自治 + Mode Registry 是 LLM 库的未来标准架构**——v1 单层 if-elif 模式（LangChain、LlamaIndex 早期都有）已经过时。v2 的"Provider 八件套 + `(Provider, Mode)` 二维查表"模式会被开源 LLM 库广泛借鉴。

3. **HOT 重试 + Token Budget + Hooks 是生产级 LLM 应用的标配**——光做"调用 LLM 拿响应"是不够的。必须考虑：重试策略、成本控制、审计日志、埋点、缓存——Instructor 的"非 LLM 部分"（retry/budget/hooks/cache）占了 60% 的代码量，这不是偶然。

### 12.2 工程经验提炼

- **不要把 Pydantic 当约束工具，当它是业务的延伸**——Instructor 的成功证明：把领域模型（Pydantic）和 LLM 输出绑定，比"让 LLM 输出 JSON + 自己解析"健壮 10 倍
- **延迟加载 + 注册表 = 大型 LLM 库的标准答案**——`mode_registry` 的 `_lazy_load_lock` 不是花哨设计，是工程必需（实测首次调用 KeyError）
- **Reask 不是兜底，是核心机制**——把 `ValidationError` 反向塞 prompt 比"反复强调 prompt"有效得多，这是 AI 工程师和 prompt 工程师的本质差异
- **Hooks 比 callback 强**——6 个 HookName 枚举 + Protocol 类型化，让埋点、监控、审计、缓存这些横切关注点有了"LLM 应用的标准切面"

---

## 附录：关键资源

| 资源 | 链接 |
|------|------|
| GitHub | https://github.com/567-labs/instructor |
| 官网 | https://python.useinstructor.com/ |
| PyPI | https://pypi.org/project/instructor/ |
| v2 公告 | https://github.com/567-labs/instructor/blob/main/docs/blog/posts/whats-new-in-v2.md |
| 核心模式 | `instructor/v2/core/mode.py` / `provider_specs.py` / `registry.py` |
| Provider 模板 | `instructor/v2/providers/anthropic/`（最完整） |
| License | MIT |
| 文档 | `docs/`（含 cookbook、concepts、tutorials） |
| Examples | `examples/`（含 `match_language/`、`classification/`、`extraction/`） |

**仓库结构**（v2 时期）：

```text
instructor/
├── v2/
│   ├── core/        ← 24 个核心模块：mode / registry / retry / patch / schema / hooks / budget ...
│   ├── providers/   ← 15+ provider：anthropic/openai/gemini/cohere/bedrock/...
│   ├── dsl/         ← DSL 原语：partial / iterable / maybe / parallel / citation
│   ├── validation/  ← async + sync 校验器
│   ├── decisions/   ← 决策 API 客户端
│   ├── batch/       ← OpenAI Batch API 包装
│   ├── cli/         ← 命令行工具
│   └── core/cache_response.py / budget.py / streaming.py ...
├── decisions/       ← v1 决策 API
├── processing/      ← v1 处理函数
├── utils/           ← 工具函数
├── cli/             ← CLI 入口
├── batch/           ← v1 batch
└── cache.py         ← 缓存抽象
```

**关键源文件大小**（核心模块）：

| 文件 | 行数 | 职责 |
|---|---|---|
| `instructor/v2/core/client.py` | ~1000 | Instructor / AsyncInstructor 客户端（10 个 overload） |
| `instructor/v2/core/registry.py` | ~450 | ModeRegistry + lazy load + lock |
| `instructor/v2/core/retry.py` | ~800 | retry_sync_v2 / retry_async_v2 + usage 累计 |
| `instructor/v2/core/patch.py` | ~500 | patch_v2 + hooks 集成 + response_model 准备 |
| `instructor/v2/core/auto_client.py` | ~1400 | from_provider + 24 个 provider builder |
| `instructor/v2/dsl/partial.py` | ~1000 | Partial[T] + _unwrap_optional_base_model + ContextVar |
| `instructor/v2/dsl/iterable.py` | ~500 | IterableBase + tasks_from_chunks |
| `instructor/v2/providers/anthropic/handlers.py` | ~1100 | Anthropic 4 种 mode × 7 处理器 |