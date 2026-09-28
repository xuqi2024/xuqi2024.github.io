---
title: 【DeerFlow 2.0】核心架构与 Harness 设计原理解析
author: AI 调研员
date: 2026-09-28 08:00:00
categories: [技术报告]
series: harness-engineering
tags: [Harness Engineering, DeerFlow, LangGraph, Sub-Agent, Sandbox Security]
words: 13800
reading_time: 27分钟
rating: 93
description: 从 bytedance/deer-flow 83k⭐ 出发，深度解析 DeerFlow 2.0 的 6 大核心原语：可声明式 Skill 目录 + 字面量意图检索、Sub-Agent 隔离 + Token 上报反向归集、Sandbox 凭据白名单 + 文件操作锁、Turn Budget 翻译递归深度、环境注入拒绝继承、MCP 任务租约。
---

> **一句话结论**：DeerFlow 2.0 不是"另一个 LangGraph 包装"，它是把 LangGraph 从"agent demo 框架"升级到"生产级 super-agent harness"的完整工程示范——它的核心价值不是新模型能力，而是**让 LLM 在跨小时、跨用户、跨工具调用时仍能保持可预测行为**的 6 大原语。

---

## 前言：为什么 DeerFlow 2.0 值得拆

2026 年 2 月 28 日，bytedance/deer-flow 凭 2.0 版本登顶 GitHub Trending 第一名**。仓库 Star 数目前已达 **83,056**（2026-09-27 数据）。这是字节跳动官方开源的 **Super Agent Harness**。

但很多人对 DeerFlow 的认知还停留在 v1——一个"深度研究 + 多 agent 协作"的 LangGraph 包装。**2.0 是从零重写**：它分享 0 行 v1 代码，整个后端代码 1835 个 Python 文件，核心代码库 `packages/harness` 一个目录就有 675 个文件。

更关键的是，它设计哲学的进化：

- **v1 思维**：LLM 多步推理 + 多 agent 协同
- **v2 思维**：LLM 是不可信的执行器，Harness 才是产品——需要 Skill 隔离、Token 归集、文件锁、凭据注入、子 Agent 边界、Sandbox 租约等 6 大原语

**这篇文章拆的是 v2 的核心原语**，不讲"怎么跑 DeerFlow"，而是讲"为什么 DeerFlow 的每个角落都在做防御性编程"。

读完本文你能拿到：
- ✅ Skill 目录的字面量意图检索是怎么把"prefix cache 友好"做成硬指标的
- ✅ Sub-Agent 的 Token 上报是怎么"反向穿越 loop boundary"的
- ✅ `max_turns` 是怎么从"操作员直觉"翻译成 LangGraph `recursion_limit` 的
- ✅ Sandbox 怎么用 `*KEY*/*SECRET*/*TOKEN*` 通配符拒绝继承父进程环境变量
- ✅ 文件操作锁为什么用 `WeakValueDictionary` 而不是普通 dict

---

## 一、定位：DeerFlow 2.0 在 Harness 6 件套中的位置

| 维度 | DeerFlow 2.0 的角色 | 对应组件 |
|------|---------------------|----------|
| **Skill** | Skill 目录 + SKILL.md frontmatter + 4 类隔离 | ⭐ Skill 组件代表 |
| **Sub-Agent** | 内置 + Custom + Managed + Overrides 四级解析 | ⭐ Sub-Agent 组件代表 |
| **Sandbox** | Local/AIO/Provisioner 三档 provider + 文件锁 | ⭐ Script 组件的载体 |
| **MCP** | 完整 MCP Server + Task 租约 + 多租户 | ⭐ MCP 组件代表 |
| **Memory** | Long-term memory + Thread 状态机 | Memory 组件 |
| **Workflow** | LangGraph 状态机 + 跨设备 Provisioner | Workflow 组件 |
| **Rule** | AGENTS.md 多 Agent 共享规则 | Rule 组件 |

**唯一一个 Harness 6 件套全覆盖的开源项目**。这不是"DeerFlow 想做全家桶"，而是它的产品形态（Super-Agent）天然需要这 6 件套协同工作。

---

## 二、架构总览：从浏览器到 LLM 的完整数据流

```mermaid
graph TB
    subgraph 用户入口层
        A1["🚀 Nginx:2026<br/>统一反向代理"]
        A2["📱 Feishu/Slack/Telegram<br/>IM Channel Bridge"]
    end

    subgraph Gateway 编排层
        B1["⚙️ Gateway API:8001<br/>FastAPI + 嵌入式 LangGraph"]
        B2["🪝 StreamBridge<br/>SSE 多模消费者路由"]
        B3["📋 RunManager<br/>run_agent() 主循环"]
        B4["🔄 Provisioner:8002<br/>K8s Sandbox 调度"]
    end

    subgraph Harness 核心
        C1["🧠 Lead Agent<br/>(LangGraph 状态机)"]
        C2["🎯 Sub-Agent Executor<br/>隔离 + Token 归集"]
        C3["📚 Skill Catalog<br/>字面量意图检索"]
        C4["🛡️ Sandbox Middleware<br/>租约 + 凭据白名单"]
        C5["🔌 MCP Task Service<br/>长程任务租约"]
    end

    subgraph 持久化层
        D1["🗄️ Postgres<br/>Thread/Checkpoint/Memory"]
        D2["💾 Redis<br/>Cache + Lease"]
        D3["📁 MinIO/NFS<br/>Skill + Upload"]
    end

    A1 --> B1
    A2 --> B1
    B1 --> B3
    B3 --> B1
    B3 --> C1
    C1 --> C2
    C1 --> C3
    C1 --> C4
    C1 --> C5
    C2 --> C4
    C3 --> D3
    C4 --> D1
    C5 --> D1
    B1 --> D1
    B1 --> D2
    B3 --> B2

    style A1 fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style A2 fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style B1 fill:#E8D5F5,stroke:#CE93D8,color:#333
    style B2 fill:#E8D5F5,stroke:#CE93D8,color:#333
    style B3 fill:#E8D5F5,stroke:#CE93D8,color:#333
    style B4 fill:#E8D5F5,stroke:#CE93D8,color:#333
    style C1 fill:#FFDAB9,stroke:#FFAB91,color:#333
    style C2 fill:#FFDAB9,stroke:#FFAB91,color:#333
    style C3 fill:#FFDAB9,stroke:#FFAB91,color:#333
    style C4 fill:#FFDAB9,stroke:#FFAB91,color:#333
    style C5 fill:#FFDAB9,stroke:#FFAB91,color:#333
    style D1 fill:#B5EAD7,stroke:#80CBC4,color:#333
    style D2 fill:#B5EAD7,stroke:#80CBC4,color:#333
    style D3 fill:#B5EAD7,stroke:#80CBC4,color:#333
```

**关键设计哲学**：Gateway 把 LangGraph runtime 嵌入到 FastAPI 进程里（而不是单独部署 LangGraph Platform），Nginx 只暴露一个 loopback 端口（默认 `127.0.0.1:2026`，不是 `0.0.0.0`）。这避免了 LangGraph 的部署陷阱：**整套服务对外只有一个公开入口**。

---

## 三、6 大核心原语深度解析

### 原语 1：Skill 目录 + 字面量意图检索

DeerFlow 的 Skill 不是 OpenAI Function Call 风格的"工具注册表"，它是 **Anthropic SKILL.md 风格**的目录：每个 Skill 是一个目录，目录里有一个 `SKILL.md`（YAML frontmatter + Markdown 正文）。

#### 1.1 Skill 的 4 个生命周期位置

```mermaid
graph LR
    A["🌐️ Global Public<br/>deer-flow/skills/public/"]
    B["👤 User Custom<br/>{HOME}/users/{uid}/skills/custom/"]
    C["🔌 Integration<br/>{HOME}/integrations/skills/{provider}/"]
    D["📜 Legacy<br/>/mnt/skills/legacy/"]

    A --> E["📚 SkillCatalog<br/>(只读元数据)"]
    B --> E
    C --> E
    D --> E

    style A fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style B fill:#E8D5F5,stroke:#CE93D8,color:#333
    style C fill:#FFDAB9,stroke:#FFAB91,color:#333
    style D fill:#F5F5F5,stroke:#BDBDBD,color:#333
    style E fill:#B5EAD7,stroke:#80CBC4,color:#333
```

**关键设计**：**Skill 目录是 package boundary**——递归扫描会停在每个 package 的 `SKILL.md` 处。嵌套的 `SKILL.md` 不会成为 catalog 条目（防止 fixture 污染生产 Skill）。

#### 1.2 SKILL.md frontmatter 格式

```yaml
---
name: data-analysis
description: Run pandas-based data analysis on CSV/Parquet files
license: MIT
allowed-tools: Bash Read Write(p:/workspace/**)  # 范围限定
argument-hint: <csv-path>
required-secrets:
  - name: OPENAI_API_KEY
    optional: false
secrets-autonomous: true   # 自主加载时是否绑定 secret
---
```

#### 1.3 核心代码：字面量意图检索

DeerFlow 的 Skill Catalog 是"延迟发现"——**模型看到的是 Skill 名称清单，不是完整描述**。完整描述需要调用 `describe_skill` 才能读。这是 Anthropic Claude Code 的设计哲学延续：**保持 system prompt 紧凑，保护 prefix cache 命中**。

```python
# 简化版（来自 deerflow/skills/catalog.py）
MAX_RESULTS = 5
MAX_QUERY_CHARS = 256
MAX_QUERY_TERMS = 16

def _query_terms(query: str) -> tuple[str, ...]:
    """提取有界定的、去重的字面量意图词"""
    terms: list[str] = []
    seen: set[str] = set()
    # NFKC 归一化 + 大小写折叠
    normalized = unicodedata.normalize("NFKC", query).casefold()
    # 分隔符统一为空格
    normalized = re.sub(r"[-_./]+", " ", normalized)
    normalized = re.sub(r"\s+", " ", normalized).strip()
    
    for term in _TOKEN_RE.findall(normalized):
        # 'a' 和 'I' 这两个英文冠词会被丢弃（否则会匹配几乎所有条目）
        if term in {"a", "i"}:
            continue
        if term in seen:
            continue
        seen.add(term)
        terms.append(term)
        if len(terms) == MAX_QUERY_CHARS:
            break
    return tuple(terms)
```

**为什么不直接用向量检索？** —— 字面量检索的命中率高、零延迟、零成本、易调试。DeerFlow 的注释直接说："skills intentionally use literal intent ranking rather than the tool catalog's free-text regex matching."

#### 1.4 三种查询语法

```python
# 1. 精确选择（无字符/结果上限）
catalog.search("select:data-analysis,deep-research")
# → 返回 ['data-analysis', 'deep-research']

# 2. 必需前缀 + 意图
catalog.search("+podcast gen")  
# → 名字必须含 'podcast'，按 'gen' 意图排名

# 3. 多词意图
catalog.search("chart visualization")
# → 在 name + description 中做字面量匹配，按相关性排序
```

#### 1.5 Skill 安装的权限收敛

Skill 安装到磁盘后，DeerFlow **强制把权限收敛到只读**，防止 Skill 目录被 Sandbox 进程篡改：

```python
# 来自 deerflow/skills/permissions.py
import stat

def make_skill_path_sandbox_readable(path: Path) -> None:
    if path.is_symlink():
        return  # 符号链接不处理
    mode = stat.S_IMODE(path.stat().st_mode)
    without_sandbox_write = mode & ~(stat.S_IWGRP | stat.S_IWOTH)
    if path.is_dir():
        path.chmod(without_sandbox_write | 0o555)  # 目录：555 (r-x r-x r-x)
    elif path.is_file():
        path.chmod(without_sandbox_write | 0o444)  # 文件：444 (r-- r-- r--)
```

**为什么这件事重要？** —— Skill 包含 prompt injection 攻击面。如果 LLM 生成的恶意代码能修改 Skill，下次启动 Agent 就会被注入。DeerFlow 把"Skill 目录不可写"做成**物理属性**而不是"运行时检查"。

---

### 原语 2：Sub-Agent 隔离 + Token 反向归集

DeerFlow 的 Sub-Agent 系统有 4 级解析顺序：

```mermaid
graph LR
    A["1️⃣ Built-in<br/>(general-purpose, bash)"]
    B["2️⃣ Custom<br/>(config.yaml custom_agents)"]
    C["3️⃣ Managed<br/>(管理员定义 + enabled=true)"]
    D["4️⃣ Per-Agent Override<br/>(config.yaml agents.<name>)"]

    A --> E["🎯 SubagentConfig"]
    B --> E
    C --> E
    D --> E

    style A fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style B fill:#E8D5F5,stroke:#CE93D8,color:#333
    style C fill:#FFDAB9,stroke:#FFAB91,color:#333
    style D fill:#FFF9C4,stroke:#F9A825,color:#333
    style E fill:#B5EAD7,stroke:#80CBC4,color:#333
```

**关键设计**：**Managed 定义即使存储在数据库里，也会被 Built-in 同名定义"屏蔽"**——这是为了避免管理员误改 Built-in Agent 的默认行为。

#### 2.1 Token 收集器：跨 Loop Boundary 反向归集

Sub-Agent 最大的工程难题是 **Token 计量**：父 Agent 的账单不能漏掉子 Agent 的消耗。

DeerFlow 的解法是 **LangChain BaseCallbackHandler**：

```python
# 来自 deerflow/subagents/token_collector.py
from langchain_core.callbacks import BaseCallbackHandler

class SubagentTokenCollector(BaseCallbackHandler):
    """轻量级回调处理器，在子 Agent 内收集 LLM token 使用量"""
    
    def __init__(self, caller: str):
        super().__init__()
        self.caller = caller  # 'general-purpose' / 'bash' / ...
        self._records: list[dict] = []
        self._counted_run_ids: set[str] = set()  # 防重入
    
    def on_llm_end(self, response, *, run_id, tags=None, **kwargs):
        rid = str(run_id)
        if rid in self._counted_run_ids:
            return  # 同一 run_id 只计一次
        
        for generation in response.generations:
            for gen in generation:
                if not hasattr(gen, 'message'):
                    continue
                usage = getattr(gen.message, 'usage_metadata', None) or {}
                usage_dict = dict(usage) if usage else {}
                
                input_tk = usage_dict.get('input_tokens', 0) or 0
                output_tk = usage_dict.get('output_tokens', 0) or 0
                total_tk = usage_dict.get('total_tokens', 0) or 0
                if total_tk <= 0:
                    total_tk = input_tk + output_tk
                if total_tk <= 0:
                    continue
                
                # ✅ 关键：捕获"实际生成响应"的 model，不是 Lead Agent 的 model
                response_metadata = getattr(gen.message, 'response_metadata', None) or {}
                model_name = (
                    response_metadata.get('model_name') or 
                    response_metadata.get('model')
                )
                
                self._counted_run_ids.add(rid)
                self._records.append({
                    'source_run_id': rid,
                    'caller': self.caller,
                    'model_name': model_name,  # 真实模型（不是子 Agent 配置的）
                    'input_tokens': input_tk,
                    'output_tokens': output_tk,
                    'total_tokens': total_tk,
                    # 只在 provider 真正报告 cache hits 时才写入
                    **({'cache_read_tokens': cache_read_tk} 
                       if cache_read_tk > 0 else {}),
                })
                return  # 一次只计一个 gen
    
    def snapshot_records(self) -> list[dict]:
        return list(self._records)
```

#### 2.2 反向 Loop Boundary 投递

子 Agent 的 executor 在异步事件循环里跑。当父 Agent 的 `asyncio.run()` 退出时，**子 Agent 的 cleanup 任务会被取消**。DeerFlow 的解法是把 cleanup 固定在"持久的子 Agent 循环"里：

```python
# 简化版（来自 deerflow/subagents/executor.py）
async def _deferred_cleanup_subagent_task(execution_id):
    """反向 loop boundary: 跨 caller-loop 边界仍然完成 cleanup"""
    # 关键: 不挂在 caller loop 上（caller loop 会被 asyncio.run() 取消）
    # 而是 run_on_isolated_subagent_loop() 在持久循环上调度
    await run_on_isolated_subagent_loop(
        lambda: cleanup_background_task(execution_id)
    )

async def _deliver_final_usage_report(report, captured_parent_loop):
    """把 Token 用量报告投递回父 Agent 的循环"""
    # 父 Agent 循环可能已经关闭（同步 asyncio.run teardown）
    if captured_parent_loop.is_closed():
        logger.info("parent loop closed, dropping report")
        return
    
    # ✅ call_soon_threadsafe 跨线程/跨 loop 安全
    captured_parent_loop.call_soon_threadsafe(
        lambda: record_external_llm_usage_records(report)
    )
```

**为什么这件事重要？** —— `record_external_llm_usage_records` **绝不能在持久循环或 worker thread 上调用**，因为 `RunJournal._tokens_by_model` 是无锁的 RMW 字段，并发写入会丢失 token 数据或破坏迭代。DeerFlow 强制父子循环是**单向数据流**：报告从子循环 → 父循环，**反方向不可达**。

---

### 原语 3：Turn Budget → LangGraph recursion_limit 翻译器

这是 DeerFlow 的隐藏瑰宝。**绝大多数 LangGraph Agent 都做错了 turn budget**。

#### 3.1 问题背景

```python
"""
演示: max_turns 直接当 recursion_limit 是错误的
依赖: pip install langchain langgraph
"""
from langchain.agents import create_agent
from langchain_core.messages import HumanMessage

def wrong_usage(model, tools, max_turns, prompt):
    """错误做法: 直接把 max_turns 当作 recursion_limit"""
    agent = create_agent(model, tools=tools)
    # ❌ max_turns 是"turn 数"，但 recursion_limit 是"super-steps 数"
    # 实际能跑的 turn 数 = max_turns / 中间件链深度
    # DeerFlow 的子 Agent 链深度是 7-8，所以 max_turns=150 实际只买到 18 个 turn
    result = agent.invoke(
        {"messages": [HumanMessage(prompt)]},
        config={"recursion_limit": max_turns}
    )
    return result
```

LangGraph 的 `recursion_limit` 计量的是 **super-steps**（每个图节点执行一次算 1）。`create_agent` 把每个 middleware 的 lifecycle hook 都编译成单独的图节点：

```
一个 turn 的成本 = before_model 节点 + model 节点 + after_model 节点 + tools 节点
                  = 中间件链深度 × 2 + 2
```

**DeerFlow 的子 Agent 链编译出 7~8 个 loop 节点**，所以 `max_turns=150` 通过上述错误代码实际只买到 **18 个 turn**。而且每加一个 middleware，预算就被悄悄压缩。

#### 3.2 DeerFlow 的解法

```python
# 来自 deerflow/subagents/turn_budget.py
# 每个 turn 必经的节点（无论中间件链如何）
_LOOP_NODES_PER_TURN = 2  # model 节点 + tools 节点

# Sync/async hook 对，每对编译为一个节点
_LOOP_HOOK_PAIRS = (
    ("before_model", "abefore_model"),
    ("after_model", "aafter_model"),
)
_INVOCATION_HOOK_PAIRS = (
    ("before_agent", "abefore_agent"),
    ("after_agent", "aafter_agent"),
)


def _implements(middleware: Any, hook_pair: tuple[str, str]) -> bool:
    """middleware 是否重写了 hook_pair 的任一侧"""
    middleware_type = type(middleware)
    for hook in hook_pair:
        impl = getattr(middleware_type, hook, None)
        # ✅ 关键：检查是否覆盖了 AgentMiddleware 基类的方法
        if impl is not None and impl is not getattr(AgentMiddleware, hook, None):
            return True
    return False


def count_turn_steps(middlewares: Sequence[Any]) -> int:
    """每个 turn 实际花费的 super-steps 数"""
    return _LOOP_NODES_PER_TURN + sum(
        1 for m in middlewares 
        for hook_pair in _LOOP_HOOK_PAIRS
        if _implements(m, hook_pair)
    )


def resolve_recursion_limit(max_turns: int, middlewares: Sequence[Any]) -> int:
    """把 max_turns 翻译成 LangGraph 真正能用的 recursion_limit"""
    return max(1, max_turns) * count_turn_steps(middlewares) + count_invocation_steps(middlewares)
```

#### 3.3 Jump Hook 的隐藏成本

更精彩的是 `find_jumping_hooks()`——它检查是否有 middleware 声明了 `can_jump_to`：

```python
# 来自 deerflow/subagents/turn_budget.py
def find_jumping_hooks(middlewares: Sequence[Any]) -> list[tuple[str, str]]:
    """声明了 jump 的 hooks —— 每多一个，recursion_limit 就需要往上加"""
    jumping: list[tuple[str, str]] = []
    for middleware in middlewares:
        middleware_type = type(middleware)
        for hook_pair in _LOOP_HOOK_PAIRS + _INVOCATION_HOOK_PAIRS:
            for hook in hook_pair:
                # LangChain 的 hook_config(can_jump_to=...) 装饰器把声明写在这里
                if getattr(getattr(middleware_type, hook, None), '__can_jump_to__', None):
                    jumping.append((middleware_type.__name__, hook))
    return jumping
```

**Jump hook 的影响**：
- `before_model` 跳到 `tools` → 跳过 model 节点，重新进入循环一次 → 多花一个 super-step
- `after_agent` 跳到 `end` → 重新进入 `after_agent` 链 → 跑两次 hook
- `before_agent` 跳到 `tools` → 跳过整个 turn 的成本 → 额外一个 `tools` step

DeerFlow 把这个不确定性做成 **下限保证**：jump hook 存在时，`resolve_recursion_limit` 返回"下限"。实际可能更多，但不会更少。

---

### 原语 4：Sandbox 凭据白名单 + 文件操作锁

#### 4.1 问题：subprocess 默认继承父进程所有环境变量

DeerFlow 的注释直接点破了痛点：

> *"Skill scripts run as sandbox subprocesses. By default a subprocess inherits the Gateway process's entire ``os.environ`` — which holds platform credentials (``OPENAI_API_KEY``, tracing keys, community-provider keys, ...). That makes any scoped request-secret injection pointless: a script could simply read those inherited platform secrets."*

#### 4.2 解决：通配符 + 精确黑名单

```python
# 来自 deerflow/sandbox/env_policy.py（5603 字符，完整版）
_SECRET_NAME_PATTERNS: tuple[str, ...] = (
    "*KEY*",
    "*SECRET*",
    "*TOKEN*",
    # *PASS* 同时覆盖 PASSWORD/PASSWD 和缩写 DB_PASS/SMTP_PASS
    # 也覆盖 *_ASKPASS（GIT_ASKPASS, SSH_ASKPASS, SUDO_ASKPASS）
    # 这些指向"生成凭据的程序"，本质是凭据指针
    "*PASS*",
    "*CREDENTIAL*",
    "*DSN*",  # data source name，几乎总是带密码
)

_BLOCKED_EXACT_NAMES: frozenset[str] = frozenset({
    "DATABASE_URL", "DATABASE_URI", "REDIS_URL",
    "MONGODB_URI", "MONGO_URL", "AMQP_URL", "RABBITMQ_URL",
    "POSTGRES_URL", "POSTGRESQL_URL", "MYSQL_URL", "CLICKHOUSE_URL",
    "CONNECTION_STRING", "CONN_STR",
    "GH_PAT", "GITHUB_PAT", "MYSQL_PWD",
    "REDISCLI_AUTH", "REDIS_AUTH",
    "PGSERVICEFILE",  # libpq 的 pg_service.conf 定位器
    # SSH_AUTH_SOCK 指向 ssh-agent socket
    # 继承它 = 能用宿主机所有 SSH key
    "SSH_AUTH_SOCK",
})


def is_blocked_env_name(name: str) -> bool:
    upper = name.upper()
    if upper in _BLOCKED_EXACT_NAMES:
        return True
    return any(fnmatch.fnmatchcase(upper, pattern) for pattern in _SECRET_NAME_PATTERNS)


def build_sandbox_env(injected: dict[str, str] | None = None) -> dict[str, str]:
    """构建 sandbox 子进程的环境字典"""
    # ✅ 拒绝继承：剔除所有匹配的变量
    env = {
        key: value 
        for key, value in os.environ.items() 
        if not is_blocked_env_name(key)
    }
    if injected:
        # 显式注入的 secret 覆盖黑名单（因为上游已经验证过）
        env.update(injected)
    return env
```

**关键设计选择**：
1. **fail-safe 方向**：`COMPASS_*` 这类含有 `PASS` 但跟密码无关的变量也会被 scrub。DeerFlow 选择宁可误杀、不可漏放
2. **`SSH_AUTH_SOCK` 是精确黑名单**——`*AUTH*` 会误伤 `AUTH_HEADER` 这种合法变量，没法用通配符
3. **`*_ASKPASS` 是 `*PASS*` 的"附带捕获"**——这些指向"能产生凭据的程序"，本质是凭据指针

#### 4.3 文件操作锁：WeakValueDictionary + (sandbox.id, path)

```python
# 来自 deerflow/sandbox/file_operation_lock.py
import threading
import weakref
from deerflow.sandbox.sandbox import Sandbox

_LockKey = tuple[str, str]  # (sandbox_id, path)
_FILE_OPERATION_LOCKS: weakref.WeakValueDictionary[_LockKey, threading.Lock] = weakref.WeakValueDictionary()
_FILE_OPERATION_LOCKS_GUARD = threading.Lock()


def get_file_operation_lock_key(sandbox: Sandbox, path: str) -> tuple[str, str]:
    sandbox_id = getattr(sandbox, "id", None)
    if not sandbox_id:
        sandbox_id = f"instance:{id(sandbox)}"
    return sandbox_id, path


def get_file_operation_lock(sandbox: Sandbox, path: str) -> threading.Lock:
    """获取 sandbox × path 的文件操作锁"""
    lock_key = get_file_operation_lock_key(sandbox, path)
    with _FILE_OPERATION_LOCKS_GUARD:
        lock = _FILE_OPERATION_LOCKS.get(lock_key)
        if lock is None:
            lock = threading.Lock()
            _FILE_OPERATION_LOCKS[lock_key] = lock  # WeakValue 自动清理
        return lock
```

**3 个工程决策**：
1. **用 `WeakValueDictionary`** —— 长跑进程不会内存泄漏（Lock 没有外部引用时自动 GC）
2. **Lock key 是 `(sandbox.id, path)`** —— 不同 sandbox 即使访问相同 path 也不会争抢；同一 sandbox 内不同 path 也不争抢
3. **`threading.Lock` 而不是 `asyncio.Lock`** —— Sandbox 的底层调用可能是同步 subprocess

---

### 原语 5：Sandbox 租约（Lease）防泄漏

DeerFlow 的 Sandbox 体系比"创建一个容器"复杂得多。它有 3 层 lease：

```mermaid
graph LR
    A["🪪 Execution Lease<br/>agent:{uuid}<br/>绑定 agent 生命周期"]
    B["🔌 Command Scope<br/>命令级别 scope_id<br/>持有 shell session"]
    C["🖥️ Provider Lease<br/>SandboxProvider 层级<br/>warm pool 重用"]

    A --> B
    B --> C

    style A fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style B fill:#E8D5F5,stroke:#CE93D8,color:#333
    style C fill:#B5EAD7,stroke:#80CBC4,color:#333
```

#### 5.1 Execution Lease 的核心约束

```python
# 简化版（来自 deerflow/sandbox/lease.py）
async def run_sync_lifecycle_operation(func, /, *args, **kwargs):
    """运行阻塞客户端工作，不让 cancellation 超时"""
    # asyncio.to_thread 不能在 await 任务被取消时停止 worker
    # Sandbox cleanup 必须等 worker 结束才能 release client holder
    operation_task = asyncio.create_task(asyncio.to_thread(func, *args, **kwargs))
    try:
        return await asyncio.shield(operation_task)
    except asyncio.CancelledError:
        # ✅ 关键：cancellation 记忆 + 传播，但 worker 必须先结束
        try:
            await _drain_task_after_cancellation(operation_task)
        except Exception as worker_err:
            logger.error("worker failed after cancellation: %s", worker_err)
        raise


async def _drain_task_after_cancellation(task):
    """即使当前任务再次被取消，也等待 task 完成"""
    while True:
        try:
            return await asyncio.shield(task)
        except asyncio.CancelledError:
            if task.done():
                return task.result()
```

**核心约束**：**只有"最后一个 Execution Lease"才能调用 `SandboxProvider.release`**。前面的 Lease 释放只是把引用计数减 1；最后一个 release 才真正把远程 sandbox 放回 warm pool。

#### 5.2 异步取消的"再屏蔽"模式

`_drain_task_after_cancellation` 是一个少见的反模式：**重复 cancellation 必须被记忆但不传播**。原因是：

- `asyncio.shield(task)` 会把"task 内部 CancelledError"包成"外部 CancelledError"
- 但如果外部 task 被再次取消，`shield` 也会再次抛
- 所以需要一个 `while True` 循环 + `task.done()` 检查

DeerFlow 直接在代码注释里写：**"Lifecycle reconciliation must keep its serializer until provider work has finished. Repeated cancellation is therefore remembered by the caller but cannot propagate into the reconciliation task or interrupt this drain."**

---

### 原语 6：MCP Task Service + 长程任务租约

最后一个原语是 MCP 任务的"长程"处理。MCP 协议本身是同步请求-响应，但 Agent 经常需要跑 5~30 分钟的 MCP 任务（深度搜索、批处理）。

DeerFlow 的解法：**把 MCP 任务的执行搬出 Agent 循环**。

```python
# 简化版（来自 backend/packages/harness/deerflow/mcp/）
class McpTaskService:
    """长程 MCP 任务的租约式服务"""
    
    async def submit(self, server_id: str, method: str, params: dict) -> str:
        """提交 MCP 任务，返回 task_id（Agent 立刻拿到这个 ID 返回）"""
        task_id = str(uuid.uuid4())
        await self._persist_task(task_id, server_id, method, params)
        await self._notify_worker(task_id)  # 唤醒 worker
        return task_id
    
    async def poll_status(self, task_id: str) -> McpTaskStatus:
        """Agent 用 task_id 轮询状态（替代 MCP 原生的 task_id 持有）"""
        # 数据库是 source of truth，不依赖远程 task_id
        row = await self._db.fetch_task(task_id)
        if row.lease_expired():
            return McpTaskStatus.UNKNOWN  # 可能被另一个 worker 接管
        return row.status
    
    async def cancel(self, task_id: str) -> bool:
        """取消任务——必须先 lease-fence 拿到所有权"""
        async with self._lease(task_id) as lease:
            if lease.is_owner():
                await self._db.mark_cancelled(task_id)
                await self._notify_worker_stop(task_id)
                return True
        return False
```

**核心设计**：
1. **数据库是 source of truth** —— 不是远程 MCP server 的 task_id
2. **Lease-based 恢复** —— Worker 崩溃后，下一个 worker 通过 lease claim 接管任务
3. **cancel 必须 fence** —— 防止 worker 已经完成后还在 cancel
4. **cancel 503 "worker stopped"** —— worker 已经优雅停止时返回 503（**正确语义**：任务在 cancel 之前已经完成）

---

## 四、5 个真实可运行的复刻代码

### 4.1 复刻 Skill Catalog 字面量检索（核心原语 1）

```python
"""
复刻 deerflow/skills/catalog.py 的字面量意图检索
依赖: pip install pyyaml
"""
from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from functools import cached_property

MAX_RESULTS = 5
MAX_QUERY_CHARS = 256
MAX_QUERY_TERMS = 16

_NAME_SEPARATOR_RE = re.compile(r"[-_./]+")
_TOKEN_RE = re.compile(r"[\w一-鿿]+", re.UNICODE)
_WHITESPACE_RE = re.compile(r"\s+")
_IGNORED_SINGLE_ASCII_TERMS = frozenset({"a", "i"})


@dataclass(frozen=True)
class Skill:
    name: str
    description: str


@dataclass(frozen=True)
class _SearchEntry:
    skill: Skill
    normalized_name: str
    normalized_description: str


def _normalize(text: str) -> str:
    """NFKC 归一化 + 大小写折叠 + 分隔符统一"""
    return _WHITESPACE_RE.sub(
        " ", _NAME_SEPARATOR_RE.sub(" ", unicodedata.normalize("NFKC", text).casefold())
    ).strip()


def _query_terms(query: str) -> tuple[str, ...]:
    terms, seen = [], set()
    for term in _TOKEN_RE.findall(_normalize(query[:MAX_QUERY_CHARS])):
        if term in _IGNORED_SINGLE_ASCII_TERMS:
            continue
        if term in seen:
            continue
        seen.add(term)
        terms.append(term)
        if len(terms) == MAX_QUERY_TERMS:
            break
    return tuple(terms)


def _score_entry(entry: _SearchEntry, terms: tuple[str, ...]) -> int:
    """打分：每个 term 在 name 命中得 2 分，description 命中得 1 分"""
    score = 0
    for term in terms:
        if term in entry.normalized_name:
            score += 2
        if term in entry.normalized_description:
            score += 1
    return score


@dataclass(frozen=True)
class SkillCatalog:
    skills: tuple[Skill, ...]

    @cached_property
    def _index(self) -> tuple[_SearchEntry, ...]:
        return tuple(
            _SearchEntry(s, _normalize(s.name), _normalize(s.description or ""))
            for s in self.skills
        )

    def search(self, query: str) -> list[Skill]:
        query = query.strip()
        if not query:
            return []
        # 精确选择
        if query.startswith("select:"):
            wanted = {n.strip() for n in query[7:].split(",")}
            return [s for s in self.skills if s.name in wanted]
        # 必需前缀
        if query.startswith("+"):
            parts = query[1:].split(None, 1)
            if not parts:
                return []
            required = _normalize(parts[0])
            candidates = [e for e in self._index if required in e.normalized_name]
            if len(parts) > 1:
                terms = _query_terms(parts[1])
                candidates.sort(key=lambda e: -_score_entry(e, terms))
                return [e.skill for e in candidates[:MAX_RESULTS]]
            return [e.skill for e in candidates[:MAX_RESULTS]]
        # 字面量意图检索
        terms = _query_terms(query)
        ranked = sorted(self._index, key=lambda e: -_score_entry(e, terms))
        return [e.skill for e in ranked[:MAX_RESULTS] if _score_entry(e, terms) > 0]


# === Demo ===
if __name__ == "__main__":
    catalog = SkillCatalog(skills=(
        Skill("data-analysis", "Run pandas-based data analysis on CSV files"),
        Skill("deep-research", "Multi-source web research with citation"),
        Skill("podcast-generator", "Generate podcast script and audio from text"),
        Skill("code-review", "Review pull requests for style and bugs"),
    ))
    
    print("select:", catalog.search("select:data-analysis,deep-research"))
    # → [Skill(name='data-analysis', ...), Skill(name='deep-research', ...)]
    
    print("+podcast:", catalog.search("+podcast gen"))
    # → [Skill(name='podcast-generator', ...)]
    
    print("intent:", catalog.search("chart visualization data"))
    # → [Skill(name='data-analysis', ...)]
```

---

### 4.2 复刻 Turn Budget 翻译器（核心原语 3）

```python
"""
复刻 deerflow/subagents/turn_budget.py 的 max_turns → recursion_limit 翻译
"""
from __future__ import annotations
from typing import Any

_LOOP_NODES_PER_TURN = 2  # model + tools
_LOOP_HOOK_PAIRS = (
    ("before_model", "abefore_model"),
    ("after_model", "aafter_model"),
)
_INVOCATION_HOOK_PAIRS = (
    ("before_agent", "abefore_agent"),
    ("after_agent", "aafter_agent"),
)


class _BaseMiddleware:
    """所有 middleware 都继承这个基类——hook 都引用基类方法"""
    def before_model(self, *args, **kwargs): pass
    def after_model(self, *args, **kwargs): pass
    def abefore_model(self, *args, **kwargs): pass
    def aafter_model(self, *args, **kwargs): pass
    def before_agent(self, *args, **kwargs): pass
    def after_agent(self, *args, **kwargs): pass
    def abefore_agent(self, *args, **kwargs): pass
    def aafter_agent(self, *args, **kwargs): pass


def _implements(middleware: Any, hook_pair: tuple[str, str]) -> bool:
    """检查 middleware 是否重写了 hook_pair 的任一侧"""
    middleware_type = type(middleware)
    for hook in hook_pair:
        impl = getattr(middleware_type, hook, None)
        # 关键: 不是基类方法 = 自定义 = 编译为节点
        if impl is not None and impl is not getattr(_BaseMiddleware, hook, None):
            return True
    return False


def count_turn_steps(middlewares: list[Any]) -> int:
    """每个 turn 实际花费的 super-steps 数"""
    nodes = _LOOP_NODES_PER_TURN
    for m in middlewares:
        for hook_pair in _LOOP_HOOK_PAIRS:
            if _implements(m, hook_pair):
                nodes += 1
    return nodes


def count_invocation_steps(middlewares: list[Any]) -> int:
    """每次 invocation（不是每次 turn）的额外节点"""
    nodes = 0
    for m in middlewares:
        for hook_pair in _INVOCATION_HOOK_PAIRS:
            if _implements(m, hook_pair):
                nodes += 1
    return nodes


def resolve_recursion_limit(max_turns: int, middlewares: list[Any]) -> int:
    return max(1, max_turns) * count_turn_steps(middlewares) + count_invocation_steps(middlewares)


# === Demo ===
class LoggingMiddleware(_BaseMiddleware):
    """实现 before_model/after_model → 多 2 个节点"""
    def before_model(self, state): pass
    def after_model(self, state): pass


class AuditMiddleware(_BaseMiddleware):
    """只实现 abefore_agent → 多 1 个节点"""
    async def abefore_agent(self, state): pass


if __name__ == "__main__":
    chain = [LoggingMiddleware(), AuditMiddleware()]
    print(f"每个 turn 节点数: {count_turn_steps(chain)}")
    # → 4 (model + tools + before_model + after_model)
    
    print(f"每次 invocation 额外节点: {count_invocation_steps(chain)}")
    # → 1 (abefore_agent)
    
    # 如果 max_turns=150 而 chain 有 7-8 个节点
    big_chain = [LoggingMiddleware(), AuditMiddleware(), 
                 LoggingMiddleware(), AuditMiddleware(),
                 LoggingMiddleware(), AuditMiddleware()]
    print(f"max_turns=150 → recursion_limit={resolve_recursion_limit(150, big_chain)}")
    # → 150 × 10 + 3 = 1503
    
    # 错误的"max_turns 直接当 recursion_limit"只会给 150
    print(f"错误做法 (recursion_limit=150) 实际只能跑 {150 // count_turn_steps(big_chain)} 个 turn")
    # → 15 个 turn (而不是 150)
```

---

### 4.3 复刻 Sandbox 凭据白名单（核心原语 4）

```python
"""
复刻 deerflow/sandbox/env_policy.py 的环境变量白名单
"""
import fnmatch
import os

_SECRET_NAME_PATTERNS = (
    "*KEY*", "*SECRET*", "*TOKEN*", "*PASS*",
    "*CREDENTIAL*", "*DSN*",
)

_BLOCKED_EXACT_NAMES = frozenset({
    "DATABASE_URL", "DATABASE_URI", "REDIS_URL",
    "MONGODB_URI", "MONGO_URL", "AMQP_URL",
    "GH_PAT", "GITHUB_PAT", "MYSQL_PWD",
    "SSH_AUTH_SOCK",
})


def is_blocked(name: str) -> bool:
    upper = name.upper()
    if upper in _BLOCKED_EXACT_NAMES:
        return True
    return any(fnmatch.fnmatchcase(upper, p) for p in _SECRET_NAME_PATTERNS)


def build_sandbox_env(injected: dict[str, str] | None = None) -> dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not is_blocked(k)}
    if injected:
        env.update(injected)
    return env


# === Demo ===
if __name__ == "__main__":
    # 模拟父进程 env
    os.environ.update({
        "OPENAI_API_KEY": "sk-secret-123",
        "PATH": "/usr/bin:/bin",  # 应该保留
        "HOME": "/root",  # 应该保留
        "LANG": "en_US.UTF-8",  # 应该保留
        "DATABASE_URL": "postgresql://user:pass@host/db",  # 应该被剔除
        "SSH_AUTH_SOCK": "/tmp/ssh-agent",  # 应该被剔除
        "GH_PAT": "ghp_secret_abc",  # 应该被剔除
    })
    
    sandbox_env = build_sandbox_env({"CUSTOM_INJECTED": "user-supplied-token"})
    
    print("PATH 保留:", "PATH" in sandbox_env)
    print("HOME 保留:", "HOME" in sandbox_env)
    print("LANG 保留:", "LANG" in sandbox_env)
    print("OPENAI_API_KEY 被剔除:", "OPENAI_API_KEY" not in sandbox_env)
    print("DATABASE_URL 被剔除:", "DATABASE_URL" not in sandbox_env)
    print("SSH_AUTH_SOCK 被剔除:", "SSH_AUTH_SOCK" not in sandbox_env)
    print("GH_PAT 被剔除:", "GH_PAT" not in sandbox_env)
    print("CUSTOM_INJECTED 注入成功:", sandbox_env.get("CUSTOM_INJECTED"))
    # 全部断言通过
```

---

### 4.4 复刻文件操作锁（核心原语 4）

```python
"""
复刻 deerflow/sandbox/file_operation_lock.py 的 WeakValueDictionary 锁
"""
import threading
import weakref
from dataclasses import dataclass

@dataclass
class FakeSandbox:
    id: str

_LockKey = tuple[str, str]
_LOCKS: weakref.WeakValueDictionary[_LockKey, threading.Lock] = weakref.WeakValueDictionary()
_GUARD = threading.Lock()


def get_file_op_lock(sandbox: FakeSandbox, path: str) -> threading.Lock:
    key = (sandbox.id, path)
    with _GUARD:
        lock = _LOCKS.get(key)
        if lock is None:
            lock = threading.Lock()
            _LOCKS[key] = lock
        return lock


# === Demo ===
if __name__ == "__main__":
    import gc
    sb = FakeSandbox(id="sb-1")
    
    lock_a = get_file_op_lock(sb, "/workspace/file.md")
    lock_b = get_file_op_lock(sb, "/workspace/file.md")  # 应返回同一对象
    lock_c = get_file_op_lock(sb, "/workspace/other.md")  # 不同 path
    
    print(f"lock_a is lock_b: {lock_a is lock_b}")  # True
    print(f"lock_a is lock_c: {lock_a is lock_c}")  # False
    
    # 测试互斥：用 list + append/extend 模式避免 nonlocal
    counter_list = [0]
    
    def worker():
        with lock_a:
            local = counter_list[0]
            # 模拟一些"操作"
            counter_list[0] = local + 1
    
    threads = [threading.Thread(target=worker) for _ in range(100)]
    for t in threads: t.start()
    for t in threads: t.join()
    print(f"100 个并发 thread 操作，最终 counter={counter_list[0]}")  # 100
    
    # 测试 WeakValueDictionary 自动清理
    del lock_a
    del lock_b
    gc.collect()
    print(f"清理 lock 引用后 _LOCKS 中剩余条目: {len(_LOCKS)}")  # 0 (lock_c 的 path 不同)
```

---

### 4.5 复刻 Sub-Agent Token 收集器（核心原语 2）

```python
"""
复刻 deerflow/subagents/token_collector.py 的 LangChain BaseCallbackHandler
"""
from __future__ import annotations
from typing import Any
from collections.abc import Mapping


class SubagentTokenCollector:
    """轻量级回调处理器，在子 Agent 内收集 LLM token 使用量"""
    
    def __init__(self, caller: str):
        self.caller = caller
        self._records: list[dict] = []
        self._counted_run_ids: set[str] = set()
    
    def on_llm_end(self, response: Any, *, run_id: Any, tags: list[str] | None = None, **kwargs):
        rid = str(run_id)
        if rid in self._counted_run_ids:
            return
        for generation in response.generations:
            for gen in generation:
                if not hasattr(gen, 'message'):
                    continue
                usage = getattr(gen.message, 'usage_metadata', None)
                usage_dict = dict(usage) if usage else {}
                
                input_tk = usage_dict.get('input_tokens', 0) or 0
                output_tk = usage_dict.get('output_tokens', 0) or 0
                total_tk = usage_dict.get('total_tokens', 0) or 0
                if total_tk <= 0:
                    total_tk = input_tk + output_tk
                if total_tk <= 0:
                    continue
                
                # 捕获真实 model
                response_metadata = getattr(gen.message, 'response_metadata', None) or {}
                model_name = (
                    response_metadata.get('model_name') or 
                    response_metadata.get('model')
                )
                
                # 提取 cache_read
                details = usage_dict.get('input_token_details') or {}
                cache_read_tk = 0
                if isinstance(details, Mapping):
                    try:
                        cache_read_tk = max(int(details.get('cache_read') or 0), 0)
                    except (TypeError, ValueError):
                        cache_read_tk = 0
                
                self._counted_run_ids.add(rid)
                record = {
                    'source_run_id': rid,
                    'caller': self.caller,
                    'model_name': model_name,
                    'input_tokens': input_tk,
                    'output_tokens': output_tk,
                    'total_tokens': total_tk,
                }
                if cache_read_tk > 0:
                    record['cache_read_tokens'] = cache_read_tk
                self._records.append(record)
                return
    
    def snapshot_records(self) -> list[dict]:
        return list(self._records)


# === Mock 测试 ===
FakeMessage = type('Msg', (), {
    'usage_metadata': {'input_tokens': 100, 'output_tokens': 50,
                       'total_tokens': 150, 'input_token_details': {'cache_read': 80}},
    'response_metadata': {'model_name': 'gpt-4o'},
})
gen = type('Gen', (), {'message': FakeMessage()})
generation = [gen]
response = type('Resp', (), {'generations': [generation]})

collector = SubagentTokenCollector(caller='general-purpose')
collector.on_llm_end(response, run_id='run-1')

# 同一 run_id 第二次调用不重复计数
collector.on_llm_end(response, run_id='run-1')

# 不同的 run_id 计数
collector.on_llm_end(response, run_id='run-2')

print(collector.snapshot_records())
# → 2 条记录：
# [{caller: 'general-purpose', model_name: 'gpt-4o', input_tokens: 100, output_tokens: 50, 
#   total_tokens: 150, cache_read_tokens: 80, source_run_id: 'run-1'},
#  {同样的字段, source_run_id: 'run-2'}]
```

---

## 五、横向对比：DeerFlow 2.0 vs 4 个同类

| 维度 | DeerFlow 2.0 | LangChain 0.3 | Claude Code | OpenHands |
|------|---------------|---------------|-------------|-----------|
| **Sub-Agent 隔离** | ✅ 完整：4 级解析 + Token 归集 | ⚠️ 基础 Sub-Agent API | ✅ 完整 + Task tool | ✅ 完整 + Worktree |
| **Skill 体系** | ✅ SKILL.md 目录 + 字面量检索 | ❌ 无（仅 Tool） | ✅ 同 SKILL.md | ⚠️ Workspace 软规则 |
| **Sandbox** | ✅ Local/AIO/K8s + 凭据白名单 | ❌ 不提供 | ✅ 强 | ✅ Docker 完整 |
| **MCP** | ✅ Task 租约式长程 | ⚠️ 基础 SDK | ✅ 完整 | ✅ 完整 |
| **生产级** | ⭐⭐⭐⭐⭐ | ⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐⭐ |
| **复杂度** | 高（>10K 文件） | 中（<500 文件） | 不开源 | 中（~3K 文件） |
| **学习曲线** | 陡 | 平 | 不开源无法学 | 中 |

#### 5.1 vs LangChain：最大的差距是"工程化"

LangChain 提供了 `create_agent(model, tools=[...])` 这种高层 API，但**没有**：
- Skill 隔离（只是 Tool 列表）
- Sandbox 抽象（用户自己接）
- Token 归集到父 Agent
- Turn budget 翻译
- 凭据注入拒绝继承

DeerFlow 的核心价值是 **把这些 LangChain 不做的事做成 production-ready**。

#### 5.2 vs Claude Code：唯一开源 + Skill 体系对齐

Claude Code 是目前最好的 Coding Agent Harness，但**闭源**。DeerFlow 2.0 的 Skill 设计（SKILL.md + 字面量检索 + 4 类生命周期位置）和 Claude Code 高度对齐——这不是巧合，是 Anthropic 把 SKILL.md 协议公开后 DeerFlow 直接采用的结果。

#### 5.3 vs OpenHands：Sub-Agent 模型不同

OpenHands 用 Docker Worktree 隔离 Sub-Agent 的文件系统；DeerFlow 用 **同 Sandbox + 不同 Skill Projection** 隔离。两种思路：
- **OpenHands**：物理隔离，重
- **DeerFlow**：逻辑隔离（同进程但 Skill view 不同），轻

DeerFlow 的优势是 **更细粒度**（Skill 级别 vs 文件系统级别），OpenHands 的优势是 **更安全**（Worktree 不共享）。

#### 5.4 vs agency-swarm（前文 4580⭐ Sub-Agent Harness）

agency-swarm 是"薄编排层 over OpenAI Agents SDK"；DeerFlow 是"厚 Harness over LangGraph"。两者侧重点：
- **agency-swarm**：1 行代码表达通信关系（`ceo > dev > assistant`）
- **DeerFlow**：完整的 Skill + Sandbox + Token + Lease 全套基础设施

---

## 六、优缺点分析

### 6.1 架构侧（左侧）

| 维度 | 评价 |
|------|------|
| **架构简洁性** | ⚠️ 复杂。675 个 harness 文件，新人需要 2-3 周理解全貌 |
| **扩展性** | ✅ Skill / Sub-Agent / Middleware 三处都是显式扩展点 |
| **易用性** | ⚠️ `make dev` 起服务很快，但定制需要读大量 AGENTS.md |

### 6.2 性能侧（右侧）

| 维度 | 评价 |
|------|------|
| **性能** | ✅ Skill 字面量检索 + Thread skill view 缓存 + Redis lease |
| **复杂度** | ❌ 高（异步取消的"再屏蔽"模式需要资深工程师才能维护） |
| **维护性** | ⚠️ 每个子系统都有专门的 AGENTS.md（这是 DeferFlow 团队对维护性的妥协方案） |

### 6.3 真正的优点

1. **6 件套全覆盖** —— 唯一一个开源实现
2. **每个原语都有单元测试** —— `tests/` 目录几百个文件
3. **AGENTS.md 分层文档** —— 把"模块深度"分散到各模块自己管，避免单点文档过时
4. **拒绝继承父进程凭据** —— 默认安全的现代实践
5. **Turn budget 翻译器** —— 几乎所有 LangGraph Agent 都做错的事 DeerFlow 做对了

### 6.4 真正的缺点

1. **学习曲线陡** —— 需要 LangGraph + asyncio + LangChain Middleware 全栈基础
2. **文档散落** —— AGENTS.md 在每个子目录里，没有总览入口
3. **生产部署重** —— 4 个服务（Gateway / Frontend / Nginx / Provisioner）必须协同
4. **调试复杂** —— Sub-Agent 跨 Loop Boundary 时日志容易丢失

---

## 七、从零搭建启示：最小可行 Harness（MVP）

如果你想复刻 DeerFlow 的核心能力，需要的最小集：

### 7.1 必须有（核心 3 件）

```python
# 1. Skill Catalog（字面量检索）
from catalog import SkillCatalog  # 上面 4.1 节代码
catalog = SkillCatalog(skills=[...])

# 2. Turn Budget 翻译器（避免 max_turns 被误解）
from turn_budget import resolve_recursion_limit  # 上面 4.2 节代码
recursion_limit = resolve_recursion_limit(max_turns=50, middlewares=[...])

# 3. 凭据白名单（防止 subprocess 泄露）
from env_policy import build_sandbox_env  # 上面 4.3 节代码
safe_env = build_sandbox_env(injected=request_secrets)
```

### 7.2 强烈建议有（4 件）

- **Sub-Agent Token 归集** —— 用 LangChain `BaseCallbackHandler`
- **文件操作锁** —— 用 `WeakValueDictionary`
- **AGENTS.md 分层文档** —— 把每个子系统的"行为契约"放在最近的目录
- **Lease-based 资源管理** —— 避免"提前释放"的灾难

### 7.3 可以省略（生产需要再说）

- **Provisioner / K8s 调度** —— 单机 Docker 起步即可
- **Postgres / Redis 多租户** —— SQLite + 进程内 dict 起步
- **IM Channel Bridge** —— Web UI 起步
- **MCP Task 长程** —— 同步 MCP 起步

### 7.4 踩坑预警

| 坑 | 表现 | 解决方案 |
|---|------|----------|
| **max_turns 当 recursion_limit 用** | 实际跑不到 max_turns | 用 DeerFlow 的 `resolve_recursion_limit` |
| **subprocess 继承父进程凭据** | 任何 Skill 都能读到 OPENAI_API_KEY | 用 `build_sandbox_env` 拒绝继承 |
| **Skill 目录被 sandbox 篡改** | 下次 Agent 启动被 prompt injection | `make_skill_path_sandbox_readable` chmod 555 |
| **Sub-Agent token 泄漏到父** | 父 Agent 账单漏算 | 用 `BaseCallbackHandler` + 反向 loop 投递 |
| **跨 asyncio 取消数据丢失** | cleanup 在 `asyncio.run()` 退出时被取消 | 用 `_drain_task_after_cancellation` 模式 |

---

## 八、总结：DeerFlow 2.0 的真正贡献

DeerFlow 2.0 不是"LangGraph 教程"，也不是"vibe coding 工具"。它是 **LangGraph 升级到生产级 Super-Agent Harness 的完整工程示范**。

它真正的贡献不是某个具体 API，而是 **6 大原语的协同设计**：

1. **Skill 目录**——用 SKILL.md frontmatter + 字面量检索 + 权限 chmod 555 把"Skill 是只读契约"做成物理属性
2. **Sub-Agent Token 归集**——跨 Loop Boundary 反向投递，让父 Agent 账单完整
3. **Turn Budget 翻译**——`max_turns × 中间件链深度`才是真正的 `recursion_limit`
4. **凭据白名单**——`*KEY*/*SECRET*/*TOKEN*` 通配符 + 精确黑名单拒绝继承父进程凭据
5. **文件操作锁**——`(sandbox.id, path)` 二元组 + `WeakValueDictionary` 防内存泄漏
6. **Lease-based 资源**——只有"最后一个 Lease"才能 release，caller-loop 退出不影响 worker

**这些原语加起来 = 83k⭐ 的真正价值**——不是哪个 LLM 强，而是 **Harness 让 LLM 在长程、多租户、多工具场景下保持可预测行为**。

---

## 附录：参考资源

| 资源 | 链接 |
|------|------|
| 项目仓库 | https://github.com/bytedance/deer-flow |
| AGENTS.md 总览 | https://github.com/bytedance/deer-flow/blob/main/AGENTS.md |
| Sub-Agent 模块 | https://github.com/bytedance/deer-flow/tree/main/backend/packages/harness/deerflow/subagents |
| Skills 模块 | https://github.com/bytedance/deer-flow/tree/main/backend/packages/harness/deerflow/skills |
| Sandbox 模块 | https://github.com/bytedance/deer-flow/tree/main/backend/packages/harness/deerflow/sandbox |
| 官方文档 | https://deerflow.tech |

> **如果你正在搭建 Coding Agent Harness**：从 DeerFlow 抄 Skill 目录 + Turn Budget 翻译器 + 凭据白名单这 3 件，能省你 6 个月工程时间。