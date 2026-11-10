---
title: 【ActiveGraph】核心架构与设计原理深度解析：让行为成为物理的 Event-Sourced 反应式图运行时
date: 2026-11-10 09:00:00
tags: [ActiveGraph, Agent, 事件溯源, 反应式图运行时, Fork-Diff, 架构分析, 开源项目, Python]
categories: [AI, 项目评测]
description: 深度解析 yoheinakajima/activegraph 的核心架构：一个把「图即世界、行为即物理、轨迹即证明」写进代码的事件溯源反应式图运行时。涵盖 12 个原语、单一投影器 apply_event、RelationBehavior 边行为原语、Cypher 子集模式订阅、fork-and-diff 共享前缀缓存重放、EventSink 隔离事件导出、action_class 五级能力分类，以及 26 处源码自陈缺陷的诚实披露。
---

# 【ActiveGraph】核心架构与设计原理深度解析

> **The graph is the world. Behaviors are physics. The trace is the proof.**
>
> 图就是世界，行为就是物理，轨迹就是证明。

这是 ActiveGraph 项目 README 里的第一句话。读完整个仓库之后你会发现，这句宣言不是营销词，而是对它每一个设计决策的精确压缩。

ActiveGraph 是一个 **事件溯源（event-sourced）的反应式图运行时**，专为长时间运行、可审计的 Agent 系统设计。它出自 Yohei Nakajima（Tokyo Tech AI 研究者、LangChain 早期核心作者之一）之手，配套有两篇 arXiv 论文（其中主论文是《The Log is the Agent》，arXiv:2605.21997）。

在写本文之前，我把这个博客仓库已有的 **543 篇文章**全部扫了一遍，做了一轮「范式泛化扫描」。结论很有意思：

| 探针维度 | 543 篇中命中数 | 判断 |
|---|---|---|
| `event_sourcing` / `event-sourced` / `append-only` / `event-log` | **0** | ⭐ 真零覆盖 |
| `fork` / `fork-diff` / `replay` / `time-travel` | 1（chidori：host call journal） | 范式不同 |
| `reactive` / `observer` / `pub-sub` | 2 | 范式不同 |
| `workflow_graph` | 39 | 已饱和 |
| `multi_agent` | 30 | 已饱和 |
| `memory_kv` | 32 | 已饱和 |

**「事件溯源」这个维���，在这个仓库的历史上是彻底的空白。**

这不是巧合。543 篇文章里，LangGraph 讲状态图、CrewAI 讲角色对话、AutoGen 讲消息往返、Dapr Agents 讲决策钩子、Restate 讲持久执行——它们都在描述「Agent 的控制流」。但**几乎没有人从「Agent 的历史即状态」这个角度切入**。

ActiveGraph 恰好就是从这个角度切入的，而且它把这件事做到了极致：整个图状态是事件日志的投影，重放日志就能重建世界。

---

## 一、项目定位：它到底解决什么问题

### 1.1 三个让现有 Agent 框架难受的问题

我们先说清楚 ActiveGraph 不是来解决什么问题的。

**问题一：Agent 的历史不可查询。**

一个跑了两小时的 Agent，你知道它做了什么吗？如果它把状态存在 context window 里，那状态就随会话结束而蒸发。如果它存在内存对象里，那状态和产生它的逻辑纠缠在一起，没法单独回放。

在 ActiveGraph 里，Agent 的历史就是一条 append-only 的事件日志：

```text
# 来自 activegraph/core/graph.py:1-23（模块 docstring 原文）
"""Object, Relation, Graph + projector.

CONTRACT #2 (strict): Graph state is materialized from the event log.
`emit(event)` is the only mutator. Convenience methods (`add_object`,
`add_relation`, `patch_object`, `propose_patch`, `apply_patch`, etc.) all
build an Event and call emit.

CONTRACT v0.5 #15: the projector is `apply_event(graph, event)`, a
module-level function — the ONLY thing that mutates graph state. It is
called from two paths:
  - `Graph.emit` for live events (persists, offers sinks, notifies listeners)
  - `Graph._replay_event` for replay (silent: no persist, sinks, or listeners)
Two callers, one code path.
"""
```

注意最后那句 **"Two callers, one code path."** —— 这是整个架构的地基。实时执行和重放走的是**同一个投影器**，所以重放出来的图和当初跑出来的图必然一致。这不是靠测试保证的，是靠结构保证的。

**问题二：Agent 之间只能聊天。**

现有做法：LangGraph 里 Agent 通过共享 state 通信；AutoGen 里 Agent 通过发消息通信；CrewAI 里 Agent 通过任务交接通信。这三种都是**间接**通信——A 改了 state，B 下一轮才知道。

ActiveGraph 的做法是把协调逻辑挂在**边上**：

> **RelationBehavior** —— "A behavior that fires once per matching relation edge. Same metadata surface as `Behavior` plus `relation_type`: when a triggering event touches a relation of that type, the 4-arg `fn` runs as `fn(relation, event, graph, ctx)` — once per (event, relation) pair. Deliberately not a subclass of `Behavior`; the runtime dispatches the two kinds separately."
>
> —— 来自 `activegraph/behaviors/base.py:73-83`

这是本系列我见过的最独特的一个 Agent 原语。**协调逻辑不写在任何一个端点上，而是写在连接它们的边里。** README 原文说得很直白：

> "The relation-behavior primitive — coordination logic on the edge, not on either endpoint — is uncommon in other agent frameworks."

**问题三：Agent 的决策不可回溯。**

如果你让 Agent 做了一次错误决策，你想知道「当时它看到了什么」——大多数框架给不出答案。ActiveGraph 给得出，因为：
- 每个对象、关系、Patch 都带 `provenance`（由框架写入，行为不能写）
- 每个 LLM 请求都有 `llm.requested` 事件，响应有 `llm.responded` 事件
- 每个行为都有 `behavior.started` / `behavior.completed` 事件
- 对象和关系在 LLM 行为里被创建时，会带上 `llm.requested` 事件 id，让因果链能跨越 LLM 边界

```text
# 来自 activegraph/core/graph.py:1055-1064
# CONTRACT v0.6 #15: objects/relations/patches created inside an
# @llm_behavior handler carry the llm.requested event id so causal
# chain walks can cross the LLM boundary.
if llm_request_event_id is not None:
    p["llm_request_event_id"] = llm_request_event_id
# CONTRACT v0.7 #19: when the LLM behavior's turn loop invoked
# tools, all contributing tool.requested event ids are stamped
# here so causal-chain walks can enumerate every tool call.
if tool_request_event_ids:
    p["tool_request_event_ids"] = list(tool_request_event_ids)
```

### 1.2 仓库统计

| 指标 | 值 |
|---|---|
| 项目 | [yoheinakajima/activegraph](https://github.com/yoheinakajima/activegraph) |
| Stars | ⭐ 707 |
| License | Apache-2.0 |
| 语言 | Python 3.11+ |
| 创建 | 2026-05-16（约 6 个月） |
| 最后推送 | 2026-11-03（活跃） |
| 归档状态 | **未归档**（`archived: false`） |
| 仓库规模 | 442 tree 节点 / 4,595 KB |
| 核心包 | `activegraph/` 110 文件 / 1.25 MB |
| 测试 | `tests/` 164 文件 |
| 文档 | `docs/` 85 个 markdown |
| 论文 | arXiv:2605.21997《The Log is the Agent》、arXiv:2606.10241《Regimes》 |
| PyPI | `pip install activegraph` |

⭐ 数字本身不算高，但这个仓库有几个 unusual 的信号：

1. **`CONTRACT.md` 有 402,670 字节 / 8,623 行** —— 一份按版本追加的机器可读规范
2. **`CHANGELOG.md` 有 152,006 字节** —— 变更记录比很多项目的源码还长
3. **存在 `CONTRACT-review-findings.md`（32,829 字节）** —— 专门记录「规范评审发现的问题」
4. **每个错误码都有独立的文档页**，错误消息末尾带 `More:` 链接

这种「把规范当产品交付」的做法，在 Agent 开源项目里极为罕见。它本身就是这个项目成熟度的最强信号。

### 1.3 装上就能跑

```bash
pip install activegraph                    # 核心运行时 + SQLite store + Diligence pack
pip install "activegraph[llm]"             # Anthropic + OpenAI providers
pip install "activegraph[postgres]"        # Postgres-backed event store
pip install "activegraph[prometheus]"      # Prometheus metrics
pip install "activegraph[opentelemetry]"   # OpenTelemetry metrics
```

30 秒上手：

```bash
activegraph quickstart
```

README 特别强调这一点：

> "The bundled Diligence pack runs against recorded fixtures: no API key, no configuration, byte-deterministic output. You see what the framework does before you read about how it does it."

**字节级确定性输出**——这是后面 fork-and-diff 能力的地基。如果连 quickstart 的输出都不是确定性的，那 fork 出来的两条路径根本没法比较。

---

## 二、整体架构：五层 + 单一投影器

```mermaid
flowchart TB
    subgraph L5["使用者层"]
        CLI["CLI: quickstart / fork / diff / promote"]
        PY["Python API: Runtime / Graph / Pack"]
        RS["React Inspector UI<br/>(activegraph-packs 仓库)"]
    end

    subgraph L4["编排层"]
        RT["Runtime<br/>主循环 _loop / 预算 / 调度"]
        REG["Registry<br/>事件到行为的匹配"]
        SCH["Scheduler<br/>delayed / activate_after"]
        AUTH["Authority<br/>审批与能力门控"]
    end

    subgraph L3["行为层"]
        BEH["Behavior<br/>fn(event, graph, ctx)"]
        RBEH["RelationBehavior<br/>fn(relation, event, graph, ctx)"]
        LBEH["LLMBehavior<br/>runtime 拥有 prompt 组装与事件记录"]
        PAT["PatternMatcher<br/>Cypher 子集"]
    end

    subgraph L2["状态层"]
        GRAPH["Graph<br/>对象 + 类型化关系"]
        PROJ["apply_event<br/>唯一的投影器"]
        VIEW["View<br/>带作用域的读视图"]
        PATCH["Patch<br/>乐观并发提案"]
    end

    subgraph L1["持久层"]
        LOG["Event Log<br/>append-only"]
        STORE["EventStore<br/>SQLite / Postgres / Memory"]
        SINK["EventSink<br/>隔离导出"]
        CACHE["LLM / Tool Cache<br/>按内容哈希"]
    end

    CLI --> RT
    PY --> RT
    RT --> REG
    RT --> SCH
    RT --> AUTH
    REG --> PAT
    REG --> BEH
    REG --> RBEH
    REG --> LBEH
    BEH --> VIEW
    RBEH --> VIEW
    LBEH --> CACHE
    RT --> GRAPH
    GRAPH --> PROJ
    PROJ --> GRAPH
    GRAPH --> LOG
    LOG --> STORE
    LOG --> SINK
```

### 2.1 单一投影器：整个架构最重要的一段代码

ActiveGraph 最有价值的设计，是把「状态变更」这件事收敛到**一个模块级函数**里：

```text
# 来自 activegraph/core/graph.py:1071-1077
def apply_event(graph: Graph, event: Event) -> None:
    """Project an event onto the graph's in-memory state.

    The ONLY function that mutates `_objects` / `_relations` / `_patches`.
    Called from `Graph.emit` (live) and `Graph._replay_event` (replay).
    Pure projection — no I/O, no listener calls, no event log mutation.
    """
```

注意 docstring 里的三句排除法：**no I/O, no listener calls, no event log mutation**。投影器是纯函数。这意味着：

- 重放时不会触发 listener（否则会重复触发行为）
- 重放时不会重复写日志（否则日志会自我膨胀）
- 投影器里不可能藏 I/O（否则重放就不可能确定性）

再看 `emit` 的完整流程：

```text
# 来自 activegraph/core/graph.py:629-659
def emit(self, event: Event) -> Event:
    """Canonicalize, persist, project, offer sinks, then notify listeners."""
    from activegraph.store.serde import canonicalize_event, clone_event

    accepted = canonicalize_event(event)
    _validate_framework_event(accepted)
    with self._emit_lock:
        # CONTRACT v1.11 #2: the EventStore is authoritative. A failed
        # append changes no graph/log/queue/observer-visible state.
        if self._store is not None:
            self._store.append(accepted)
        self._events.append(accepted)
        apply_event(self, accepted)
        # CONTRACT v1.8 #2: offer only after projection + durable append,
        # and before legacy listeners. The position preserves order when
        # a listener re-enters emit and prevents listener failure from
        # suppressing observation of an already-accepted event.
        if self._sinks:
            from activegraph.sinks.base import DeliveryContext

            context = DeliveryContext(
                run_id=self.run_id,
                sequence=len(self._events),
                mode="live",
            )
            for sink in tuple(self._sinks.values()):
                try:
                    sink._offer(  # noqa: SLF001 — graph-only seam
                        clone_event(accepted), context
                    )
                except Exception:
                    ...
```

**写入顺序是锁死的**，而且每一步都有契约编号：

1. `canonicalize_event` —— 规范化（Decimal → 字符串，datetime → ISO 8601，set → 排序后的 list）
2. `_validate_framework_event` —— 框架事件校验
3. `self._store.append(accepted)` —— **先持久化**（v1.11 #2：EventStore 是权威源，append 失败则任何可见状态都不变）
4. `self._events.append(accepted)` —— 追加到内存日志
5. `apply_event(self, accepted)` —— 投影
6. `sink._offer(...)` —— 交给导出 sink（v1.8 #2：**在投影 + 持久化之后，在 legacy listener 之前**）
7. legacy listeners —— 锁外同步调用，异常会传播

**为什么 sink 要放在 listener 之前？** 注释写得很清楚：

> "The position preserves order when a listener re-enters emit and prevents listener failure from suppressing observation of an already-accepted event."

翻译一下：一个 listener 如果抛异常，不能导致「已经接受的事件」在外部观察者眼里消失。**已经持久化的事件，就是已经发生的事实。** 这是一个事件溯源系统应有的基本诚实。

### 2.2 12 个原语

README 列出 12 个原语：

> "The framework's twelve primitives, in roughly the order you meet them when reading a trace."

| 原语 | 一句话 | 关键机制 |
|---|---|---|
| **Graph** | 对象与类型化关系构成的世界 | 图是事件日志的投影 |
| **Events** | append-only 历史 | 每个行为响应事件并产生更多事件 |
| **Behaviors** | 反应式代码的单元 | 函数型 / class 型 / LLM-backed 三形态 |
| **Relations** | 带自身行为的类型化边 | 边可以挂行为 |
| **Patches** | 带乐观并发的变更提案 | `expected_version` 版本检查 |
| **Views** | 给行为上下文的有作用域读 | type filter / depth / recent window |
| **Frames** | 一次运行的有界上下文 | goal / constraints / budget |
| **Policies** | 行为能力的审批与门控 | `action_class` 五级分类 |
| **Patterns** | Cypher 子集模式订阅 | 图形状匹配 |
| **Replay** | 从日志重建 | 严格模式可检测漂移 |
| **Forking** | 从任意事件分叉 | 共享前缀 + 内容哈希缓存 |
| **Failure model** | 错误模型 | 每个错误码一页文档 |

---

## 三、核心机制一：Behavior 的三种形态与匹配语义

### 3.1 Behavior 是数据，不是魔法

```text
# 来自 activegraph/behaviors/base.py:39-70
@dataclass
class Behavior:
    """Metadata plus the callable for an event-driven behavior.

    A Behavior is data, not magic: ``on`` (event types), ``where``
    (payload filter), ``pattern`` (Cypher-subset subscription),
    ``activate_after`` (event-count delay), and ``view_spec`` (what
    the runtime builds into ``ctx.view``) describe *when* it fires;
    the 3-arg ``fn`` — invoked as ``fn(event, graph, ctx)`` — is
    *what* runs. Instances come from ``@behavior`` or a pack; the
    runtime introspects the metadata to match events, and nothing
    here executes on its own.
    """

    name: str
    fn: Callable[..., None]
    on: list[str] = field(default_factory=list)
    where: Optional[dict[str, Any]] = None
    view_spec: Optional[dict[str, Any]] = None
    creates: list[str] = field(default_factory=list)
    budget: Optional[dict[str, Any]] = None
    priority: int = 0  # reserved; v0 ties resolved by registration order
    # CONTRACT v0.7 #8 / #9 / #11. A Cypher subset pattern string.
    # Compiled at registration time. None = event-type-only matching
    # (CONTRACT #10).
    pattern: Optional[str] = None
    pattern_matcher: Any = None  # PatternMatcher; set by Registry at startup
    # CONTRACT v0.7 #13. Event-count delay. None = fire immediately.
    activate_after: Optional[int] = None

    def run(self, event: "Event", graph: "Graph", ctx: "Context") -> None:
        self.fn(event, graph, ctx)
```

有一个细节非常值得注意：`priority` 字段是**保留的**。

```text
priority: int = 0  # reserved; v0 ties resolved by registration order
```

这不是偷懒，是**诚实的边界声明**——项目没有假装实现了优先级调度，而是明确告诉你：同优先级按注册顺序来。比起很多框架悄悄按某种隐藏顺序调度，这种写法更值得信任。

### 3.2 LLMBehavior：运行时拥有 prompt 组装

```text
# 来自 activegraph/behaviors/base.py:1-14（模块 docstring）
"""Behavior + RelationBehavior + LLMBehavior. Plain holders for metadata
plus the callable.

A Behavior is data, not magic. The decorator wraps a function in one of
these; class-based behaviors subclass directly. The runtime introspects
the metadata to match events and build views.

CONTRACT v0.6 #2: an LLMBehavior is structurally a Behavior whose
invocation lifecycle is owned by the runtime — the developer-supplied
function is the 4-arg `handler` (event, graph, ctx, llm_output), NOT
the 3-arg `fn`. Per CONTRACT v0.6 #20, `LLMBehavior.build_prompt` is
public so a developer can inspect the exact bytes that would be sent
to the model without making a call.
"""
```

注意最后一句：**`build_prompt` 是 public 的，开发者可以在不发请求的情况下检查将要发给模型的准确字节。**

这个设计解决的是 Agent 框架里一个长期存在的痛点：prompt 是黑盒，出了问题没法查。ActiveGraph 把它变成了可检视的产物。

而且直接调用 `LLMBehavior.fn` 会被**明确报错**：

```text
# 来自 activegraph/behaviors/base.py:29-36
def _llm_behavior_fn_placeholder(
    event: "Event", graph: "Graph", ctx: "Context"
) -> None:  # pragma: no cover
    raise RuntimeError(
        "LLMBehavior.fn invoked directly. The runtime owns LLM behavior "
        "invocation via _invoke_llm; calling .run() bypasses prompt "
        "assembly, the provider, and the LLM event log. This is a bug."
    )
```

> "This is a bug."

——**它不把这称为「误用」，它直接说这「是一个 bug」**。因为绕过运行时意味着这次 LLM 调用不会进事件日志，系统就失去了可审计性。这不是 API 洁癖，是架构完整性要求。

### 3.3 匹配语义：`on` 与 `pattern` 是 AND

```text
# 来自 activegraph/runtime/registry.py:1-13（模块 docstring）
"""Match events to behaviors. CONTRACT #10: registration order for ties.

v0.7 (CONTRACT v0.7 #11): a behavior with both `on=[...]` and
`pattern=...` requires BOTH conditions — the event type matches AND
the pattern matches against the post-event graph state. A behavior
with only `pattern=...` (empty `on`) matches on every non-lifecycle
event.

`match()` returns `(behavior, relations, matches)` triples. The
`matches` list is the pattern matcher's bindings (empty for
behaviors without `pattern=`). The runtime forwards `matches` as
`ctx.matches`.
"""
```

实际匹配逻辑：

```text
# 来自 activegraph/runtime/registry.py:40-70
    def match(
        self, event: Event, graph: Graph
    ) -> list[tuple[BehaviorLike, list[Relation], list[Any]]]:
        """Return (behavior, matching_relations, pattern_matches) triples
        in registration order. Pattern matches are empty for behaviors
        without `pattern=`.
        """
        out: list[tuple[BehaviorLike, list[Relation], list[Any]]] = []
        for b in self._behaviors:
            # Event-type filter: required only when `on=` is non-empty.
            # Pattern-only behaviors (empty `on`) skip this gate.
            if b.on and event.type not in b.on:
                continue
            # Suppress lifecycle events for pattern-only behaviors so a
            # pattern doesn't fire on behavior.started, etc.
            if not b.on and _is_lifecycle(event):
                continue
            pattern_matches: list[Any] = []
            if b.pattern_matcher is not None:
                pattern_matches = b.pattern_matcher.matches(event, graph)
                if not pattern_matches:
                    continue
            if isinstance(b, RelationBehavior):
                rels = _matching_relations(b, event, graph)
                if rels:
                    out.append((b, rels, pattern_matches))
            else:
                if b.where and not evaluate_where(b.where, event.payload):
                    continue
                out.append((b, [], pattern_matches))
        return out
```

三个匹配维度：

| 维度 | 字段 | 语义 |
|---|---|---|
| 事件类型 | `on: list[str]` | 非空时必须命中；为空则匹配所有非生命周期事件 |
| 载荷过滤 | `where: Optional[dict]` | 在 Python 层对 `event.payload` 求值 |
| 图形状 | `pattern: Optional[str]` | Cypher 子集，对**事件后**的图状态匹配 |

生命周期事件（`behavior.*` / `relation_behavior.*` / `runtime.*` / `llm.*` / `tool.*` / `embedding.*` / `dev.*`）会被**自动排除**在纯 pattern 行为之外，防止模式匹配在自己的运行痕迹上打转。

## 四、核心机制二：RelationBehavior —— 把协调逻辑挂在边上

这是 ActiveGraph 最有辨识度的抽象，也是我在 543 篇历史文章里**从未见过第二个**的东西。

### 4.1 它怎么工作

```text
# 来自 activegraph/runtime/registry.py:85-98
def _matching_relations(
    rb: RelationBehavior, event: Event, graph: Graph
) -> list[Relation]:
    # Push the relation-type filter down to the store (find_relations) instead
    # of scanning every edge in Python; the reference/where checks stay here.
    candidates = graph.relations(type=rb.relation_type)
    referenced = _collect_string_values(event.payload)
    out: list[Relation] = []
    for r in candidates:
        if r.source in referenced or r.target in referenced:
            if rb.where and not evaluate_where(rb.where, event.payload):
                continue
            out.append(r)
    return out
```

匹配逻辑拆开看其实很朴素：

1. **按关系类型下推过滤** —— `graph.relations(type=rb.relation_type)`，把类型过滤推到存储层（FalkorDB 时就是 `type IN [...]`），不是在 Python 里扫所有边
2. **递归收集事件载荷里的所有字符串** —— `_collect_string_values(event.payload)`
3. **如果关系的任一端点 id 出现在这些字符串里，就命中**

```text
# 来自 activegraph/runtime/registry.py:101-115
def _collect_string_values(obj) -> set[str]:
    out: set[str] = set()
    _walk(obj, out)
    return out


def _walk(obj, out: set[str]) -> None:
    if isinstance(obj, str):
        out.add(obj)
    elif isinstance(obj, dict):
        for v in obj.values():
            _walk(v, out)
    elif isinstance(obj, list):
        for v in obj:
            _walk(v, out)
```

### 4.2 为什么「边上的行为」比「端点上的行为」强

用一个具体场景说明。假设你的图里有：

```mermaid
flowchart LR
    Company["Company"]
    Provider["Provider"]
    Filing["Filing"]
    Evidence["Evidence"]

    Company -->|uses_provider| Provider
    Company -->|has_filing| Filing
    Filing -->|cites| Evidence
```

现在要实现一条业务规则：**「一家公司引用的所有证据，如果有任何一条来自 Provider 的白名单之外，就必须触发人工审批。」**

三种实现方式：

**（a）写在 Company 端点上（传统做法）**
Company 的行为需要知道 Provider、Filing、Evidence 的存在，遍历所有引用，判断白名单。逻辑跟 Company 强耦合，换个领域就得重写。

**（b）写在 shared state 里（LangGraph 做法）**
所有信息塞进一个 state 字典，行为从 state 里读。灵活，但谁来保证 state 的结构稳定？谁来保证读取时看到的是一致快照？

**（c）写在 `uses_provider` 这条边上（ActiveGraph 做法）**
行为声明 `relation_type="uses_provider"`，运行时在 `claim-cited-by-evidence` 这类**图形状**出现时触发它。Company 端点完全不知道自己被监看着。

第三种的价值在于：**协调逻辑的生命周期和它所协调的关系绑在一起**。关系消失了，行为自然不再触发；关系类型变了，行为自动跟着变。

### 4.3 每个 (event, relation) 对触发一次

```text
# 来自 activegraph/runtime/runtime.py:1293-1301
                    if isinstance(b, RelationBehavior):
                        for r in rels:
                            if not self._budget_remaining():
                                break
                            self._invoke_relation(b, r, event, p_matches)
                    elif isinstance(b, LLMBehavior):
                        self._invoke_llm(b, event, p_matches)
                    else:
                        self._invoke(b, event, p_matches)
```

注意 `for r in rels` —— **每个匹配到的关系单独触发一次**，且每次触发都有 `relation_behavior.started` → `fn(...)` → `behavior.completed` 三段事件。所以「哪个关系触发了什么」在 trace 里一目了然。

---

## 五、核心机制三：Cypher 子集与模式订阅

### 5.1 一个刻意受限的查询语言

ActiveGraph 支持用 Cypher 语法的**子集**做模式订阅。`patterns.py` 顶部有一份手写的语法说明：

```text
# 来自 activegraph/runtime/patterns.py:15, 21-29
- AND                  (NO OR — see CONTRACT v0.7 #8)
...
* OR in WHERE
```

拒绝清单是明确列出来的：

```text
# 来自 activegraph/runtime/patterns.py:21-29
* OR in WHERE
* RETURN / WITH / UNION / UNWIND
* OPTIONAL MATCH
* variable-length paths
* aggregation
* CREATE / MERGE / SET / DELETE / DETACH
```

它支持的是：

| 能力 | 说明 |
|---|---|
| 节点模式 | `(a:Company)` |
| 关系模式 | **方向必需**，`(a)-[:CITES]->(b)` |
| 多跳 | `(a)-[:X]->(b)-[:Y]->(c)` |
| WHERE | `AND` / `NOT` / `NOT EXISTS {}` |
| 比较运算 | `= <> < <= > >=` |
| 关系变量绑定 | 关系也能绑定到变量 |

实现是手写的 lexer + 递归下降 parser，注册期编译一次：

```text
# 来自 activegraph/runtime/patterns.py（AST 定义）
Pattern(match: MatchClause, where: Optional[BoolExpr], source)
```

AST 节点：`NodePat` / `RelPat` / `MatchClause` / `Comparison` / `NotExpr` / `NotExists` / `AndExpr`。

匹配时会把节点类型和关系链**下推**到存储层（`graph.match_chain(node_types, rels)`），Python 只负责节点属性等值判断、变量一致性绑定（`_bind_chain` 冲突返回 `None`）和 WHERE 求值。

**一个重要的范式区分**：模式是对**事件发生后**的图状态做匹配，而不是对事件本身。

```text
# 来自 activegraph/runtime/patterns.py:718-723
# `event` is currently unused — patterns evaluate against the
# post-event graph state. Future extensions may bind event
# properties (e.g. `$event.payload.x`). v0.7 spec keeps it
# graph-only.
```

### 5.2 模式的三个已知边界

**边界一：不能绑定事件属性。** 上面已经引用。事件属性绑定被推迟到未来版本。

**边界二：关系绑定不支持属性访问。**

```text
# 来自 activegraph/runtime/patterns.py:899-902
# Could be a relation binding (NOT supported for property access
# in v0.7 — relations have no .data attribute lookup syntax).
return None
```

**边界三：只支持线性链，分支要拆成多个 pattern。**

```text
# 来自 activegraph/runtime/patterns.py:282-283
`rels[i]` connects `nodes[i]` to `nodes[i+1]`. v0.7 patterns are
always linear chains — branching is "register two patterns"
```

**这三条边界值得单独说。** 绝大多数开源项目不会告诉你「我这里不支持什么」。ActiveGraph 把每条边界都写在源码注释里，并且明确说明**为什么**（"v0.7 spec keeps it graph-only"、"NOT supported for property access in v0.7"）。读者能准确判断自己的场景会不会踩坑，而不是试出来才知道。

### 5.3 模式命中多次只触发一次

```text
# 来自 activegraph/behaviors/base.py:166-170
# The handler is fired
# ONCE per event regardless of how many bindings the pattern
# produced — iterating `ctx.matches` is the developer's job
```

模式可能匹配出多个绑定（比如一条链上找到 3 个符合条件的子图），但行为**只触发一次**，开发者自己遍历 `ctx.matches`。这避免了 N 个绑定触发 N 次的意外放大。

---

## 六、核心机制四：Patch 与乐观并发

```text
# 来自 activegraph/core/patch.py:1-18
"""Patch primitives. CONTRACT #4 (versioning) and #12 (single-target atomic).

A Patch is a proposed mutation. Lifecycle:
    proposed -> applied
    proposed -> rejected
`patch_object` is the auto-apply shortcut: builds a patch, version-checks,
emits patch.applied (or patch.rejected) directly. `propose_patch` emits
patch.proposed and waits for explicit approval.
"""

PATCH_OPS = frozenset({"update", "replace"})
```

Patch 生命周期是**两态收敛**：`proposed → applied` 或 `proposed → rejected`。

### 6.1 拒绝也是事件

这是本设计里我最欣赏的一点。当乐观并发检查失败（`current_version != patch.expected_version`），运行时**不是**返回一个错误就完事，而是**发一个 `patch.rejected` 事件**：

```text
# 来自 activegraph/core/graph.py（apply_event 的 patch.rejected 分支）
event = Event(..., type="patch.rejected",
    payload={"patch_id":..., "target":..., "reason":..., "current_version":...})
return self.emit(event)
```

投影侧会把 `existing.status="rejected"` 和 `rejection_reason` 写回 patch 对象。

**为什么这很重要？** 因为在事件溯源系统里，「谁在什么时候试图改什么、为什么失败」本身就是一等公民。如果拒绝只是一个返回值，它就丢失在调用栈里了。写成事件，它就进了轨迹，和成功变更享有同等地位。

### 6.2 Patch 词汇表是封闭的

```text
# 来自 activegraph/core/patch.py:21-38
def validate_patch_op(op: str, *, event_id: Optional[str] = None) -> None:
    """Reject an operation outside the closed patch vocabulary."""
    if op in PATCH_OPS:
        return
    from activegraph.runtime.exec_errors import InvalidPatchOperation

    event_context = f" in event {event_id!r}" if event_id is not None else ""
    raise InvalidPatchOperation(
        f"unsupported patch operation: {op!r}",
        what_failed=(
            f"A patch{event_context} declared operation {op!r}, but the "
            "runtime patch vocabulary is exactly: update, replace."
        ),
        why=(
            "Patches target one existing object and use expected_version as "
            "an optimistic concurrency check. Object creation and removal "
            "have dedicated event paths; treating them as patches previously "
            "recorded false patch.applied success."
        ),
```

最后一句是一个**历史 bug 的墓碑**：

> "treating them as patches previously recorded false patch.applied success."

曾经允许用 patch 做创建/删除，结果系统**记录了假的 `patch.applied` 成功事件**——实际上什么都没做，但日志说成功了。这是事件溯源系统里最危险的一类 bug（日志与事实不符）。修完之后，代码里留下了这句解释，防止有人再把 create/remove 塞回 patch 词汇表。

### 6.3 版本号是单调的

```text
# 来自 activegraph/core/graph.py:21-22
# CONTRACT #4 (versioning): every object has a monotonic `version` int that
# bumps on every patch.applied. Patches record `expected_version`.
```

对象的 `version` 每次 `patch.applied` 递增，Patch 带 `expected_version` 做乐观检查。这是典型的「读-改-写」并发控制，不需要锁。

---

## 七、核心机制五：View —— 给行为的有作用域读视图

一个 Agent 行为不该看到整张图。ActiveGraph 用 `view_spec` 精确控制每次调用能看到什么：

```text
# 来自 activegraph/runtime/view_builder.py:1-49
"""Construct a View for a behavior invocation. CONTRACT #11."""

DEFAULT_RECENT_EVENTS = 50


def build_view(
    behavior: Behavior | RelationBehavior, event: Event, graph: Graph
) -> View:
    spec = behavior.view_spec
    if not spec:
        return View(
            objects=graph.all_objects(),
            relations=graph.all_relations(),
            events=graph.events[-DEFAULT_RECENT_EVENTS:],
        )

    around_path = spec.get("around")
    depth = spec.get("depth", 1)
    include_types: Optional[list[str]] = spec.get("include_types")
    recent_events: int = spec.get("recent_events", DEFAULT_RECENT_EVENTS)

    if around_path:
        center_id = _resolve_event_path(around_path, event)
        objs, rels = graph.neighborhood(center_id, depth=depth) if center_id else ([], [])
        if include_types:
            type_set = set(include_types)
            objs = [o for o in objs if o.type in type_set]
    elif include_types:
        # No anchor: push the type filter into the store (FalkorDB resolves it
        # as ``type IN [...]`` instead of materializing every object). The
        # default single-pass scan preserves the same order as a full scan.
        objs = graph.objects_in_types(include_types)
        rels = graph.all_relations()
    else:
        objs = graph.all_objects()
        rels = graph.all_relations()
```

四种视图形态：

| 配置 | 效果 |
|---|---|
| 无 `view_spec` | 全图 + 最近 50 条事件 |
| `around: <path>` + `depth` | 邻域视图（某对象的 N 跳邻居） |
| `include_types: [...]` | 类型过滤视图（**下推到存储层**） |
| `recent_events: N` | 自定义事件窗口大小 |

**「下推到存储层」这个细节值得强调**。当用了 FalkorDB 作为图投影后端时，`include_types` 不是在 Python 里过滤，而是翻译成 `type IN [...]` 交给数据库。这意味着 View 在大图上依然便宜。

---

## 八、核心机制六：Fork-and-Diff —— 本项目最锋利的刀

### 8.1 共享血缘模型

这是 ActiveGraph 最有价值的能力，也是 README 里说「Most agent frameworks can't do this.」的那一项。

文档里的图示非常清楚：

```
parent:  evt_001 ... evt_042 evt_043 evt_044 ... (continues)
                            |
                            +- fork from evt_042
                            v
fork:    evt_001 ... evt_042 evt_045 evt_046 ... (fork's own work)
```

关键语义：

> "A fork copies events from the parent run, in order, up to the `--at-event` cutoff. The cutoff is **inclusive** — events at the cutoff id and before are in the fork; events after are not."
>
> —— `docs/concepts/forking.md`

> "The fork's events 1 through 42 are the parent's. Event 45 onward is the fork's own; event ids don't collide because the fork has its own run id and its own monotonic id generator."

### 8.2 为什么 fork 便宜：内容哈希缓存

```text
# 来自 activegraph/llm/cache.py:1-28
"""Replay LLM cache.

CONTRACT v0.6 #8. The cache is keyed by prompt hash (content-match),
not by event id — that's what lets a fork's regenerated prompts hit
the same recorded responses. The originating `llm.requested` event id
is stored alongside the cached response for trace lineage but is not
the lookup key.

Population paths:

  * `LLMCache.from_events(events)` — used at `Runtime.load(...,
    replay_llm_cache=True)` and `runtime.fork(...,
    replay_llm_cache=True)`. Walks the recorded log and harvests every
    successful `llm.responded` event whose preceding `llm.requested`
    carries a `prompt_hash`. Failed retry attempts carry
    `payload["error"]` and are deliberately skipped.

  * `cache.record(prompt_hash, response, requesting_event_id)` —
    called inline from the LLM-behavior invocation path so that
    same-run repeat prompts hit the cache too (cheap insurance).

`replay_strict=True` semantics layer on top: if a recorded
`llm.responded` event references a `prompt_hash` that the live
re-assembled prompt does NOT produce, the runtime raises
`ReplayDivergenceError(event_id=<llm.requested id>, expected=<recorded
hash>, actual=<rebuilt hash>)` — same divergence-pinning pattern as
the existing event-stream comparison. See decision-2 adjustment.
"""
```

**「按 prompt 内容哈希做键，而不是按 event id」**——这是整个 fork 机制的经济学基础。

原因很简单：fork 之后运行时是**重新组装 prompt** 的，新生成的 `llm.requested` 事件 id 跟父运行的不一样。但如果 prompt 的**内容**一样，那这次 LLM 调用的答案必然一样（相同模型、相同参数、相同输入 → 相同输出）。所以按内容哈希匹配，就能把父运行的响应直接搬过来，**零 LLM 调用、零工具调用**。

缓存键的完整定义（CONTRACT v0.6 #8）：

```
sha256(canonical_json({
  model, system, messages, output_schema_name, output_schema_json,
  max_tokens, temperature, top_p, deterministic
}))
```

工具调用同理，按 args 哈希匹配。

### 8.3 严格重放：漂移检测

如果你改了 `--set` 里的某个 pack 设置，重放时组装出的 prompt 就和父运行不同了。这时有两种选择：

- **不带 `--record`**：严格重放抛 `ReplayDivergenceError(event_id, expected, actual)` —— 明确告诉你哪里漂移了
- **带 `--record`**：接受新响应，记录为 fork 自己的事件

这个设计非常克制：默认行为是「发现不一致就停下」，而不是「默默接受新结果」。

### 8.4 Diff 是结构性的

```text
# 来自 activegraph/runtime/diff.py:1-11
"""Structural diff between two runs (typically parent vs fork).

CONTRACT v0.5 #10: diff is structural only — divergent objects, divergent
relations, and which event ranges belong to each side. Semantic comparison
(e.g., "do these two claims express the same idea?") is a behavior's job,
not the runtime's.

Diff is computed by walking both graphs' final state and event logs. We
ignore lifecycle events (`behavior.*`, `runtime.*`) when computing the
event partition — they're scaffolding, not history.
"""
```

注意那句 **"Semantic comparison ... is a behavior's job, not the runtime's."**

运行时只回答「哪些对象不同、哪些关系不同、事件区间怎么分」，**不回答**「这两份结论语义上是否等价」。后者需要领域知识，是业务逻辑的事，运行时无权代劳。

Diff 的输出结构：

```text
# 来自 activegraph/runtime/diff.py:30-49
@dataclass
class DivergentObject:
    """One object id whose final state differs between parent and fork.

    ``in_parent`` / ``in_fork`` are provenance-stripped ``to_dict``
    snapshots so the comparison is structural, not timestamp noise;
    ``None`` on the side where the id doesn't exist. ``summary()``
    renders the one-line form the CLI diff output prints.
    """

    id: str
    in_parent: Optional[dict[str, Any]]  # to_dict snapshot or None
    in_fork: Optional[dict[str, Any]]

    def summary(self) -> str:
        if self.in_parent is None:
            return f"{self.id} only in fork"
        if self.in_fork is None:
            return f"{self.id} only in parent"
        return f"{self.id} differs (parent v{self.in_parent.get('version')} ↔ fork v{self.in_fork.get('version')})"
```

**快照里剥掉了 provenance** —— 注释说得很清楚："so the comparison is structural, not timestamp noise"。时间戳和写入者不应该让两个语义相同的对象显示为「不同」。

### 8.5 Fork → Test → Promote 闭环

先看整体流程：父运行的日志在分叉点被切开，共享前缀由内容哈希缓存重放，分叉侧独立执行，最后结构化 diff 并可选地把净增量原子地提升回父运行。

```mermaid
flowchart TB
    subgraph PARENT["父运行 parent run"]
        P1["evt_001 ... evt_042<br/>共享前缀"]
        P2["evt_043 evt_044 ...<br/>父运行自有工作"]
    end

    subgraph FORK["分叉运行 fork run（独立 run_id）"]
        F1["evt_001 ... evt_042<br/>重放得到，不重跑 LLM"]
        F2["evt_045 evt_046 ...<br/>分叉自有工作"]
    end

    CACHE["LLM / Tool 内容哈希缓存<br/>共享前缀零新增调用"]
    DIFF["rt.diff(fork)<br/>结构化 diff<br/>分歧对象 / 分歧关系 / 事件区间"]
    PROMOTE["rt.promote(fork)<br/>原子应用净增量<br/>冲突时 fail-closed<br/>留下 promote.applied 事件"]

    PARENT -->|"at_event=evt_042（闭区间）"| FORK
    CACHE -.->|"前缀命中缓存"| F1
    FORK --> DIFF
    PARENT --> DIFF
    DIFF -->|"结果值得采纳"| PROMOTE
    PROMOTE -->|"净结构增量回写"| PARENT
```

完整的生产级用法在 `docs/guides/fork-test-promote.md`。文档里的 Python 用法：

```python
from activegraph import Runtime

rt = Runtime.load("sqlite:///assistant.db")

# Pick a fork point: every event object carries the id that
# at_event= expects (v1.3 — no need to read the store directly).
fork_point = rt.trace.events()[-1].id

fork = rt.fork(
    at_event=fork_point,        # inclusive cutoff, a real event id
    label="candidate-pack-test",
    replay_llm_cache=True,      # serve the shared prefix from cache
    replay_tool_cache=True,
)

# The fork is an independent Runtime: load a candidate pack into it,
# run it, and compare against the parent.
fork.load_pack(candidate_pack)
fork.run_until_idle()

diff = rt.diff(fork)            # structural: events + final state
for d in diff.divergent_objects:
    print(d.summary())
```

当 fork 的结果值得采纳时：

> "When the fork's results earn adoption, `rt.promote(fork)` applies its net structural delta back to the parent — atomically, fail-closed on conflicts with the parent's own post-fork work, and fully audited through a `promote.applied` marker event."
>
> —— `docs/concepts/forking.md`

**原子应用 + 冲突时 fail-closed + 全程审计**。这是完整的「沙箱试验 → 采纳」闭环。

### 8.6 Fork 与 Frame 的区别

文档专门解释了什么时候用 fork、什么时候用 frame：

> "**Fork** — a separate run with shared event-log lineage up to [the fork point]..."
> "**Frame** — [a bounded context within the same run]..."

一句话总结：**fork 是新的 run（有独立 run_id 和血缘），frame 是同一个 run 内的有界上下文**。fork 用于「试验不同决策路径」，frame 用于「同一路径下的不同配置」。

### 8.7 一个诚实的限制

```text
# 来自 llm/cache.py 相关文档
The cache is per-store, indexed by run id. A fork that needs to
re-execute the same prompt the parent already ran in a different
run can't reach across — caches don't cross runs.
```

**缓存不跨 run。** 也就是说 fork 只能在**同一个 store** 里继承父运行的缓存。想跨 store 复用，得用 migration。这是个真实的限制，文档直接写明。

---

## 九、核心机制七：EventSink —— 隔离事件导出

### 9.1 契约：sink 观察已接受的事件

```text
# 来自 activegraph/sinks/base.py:1-5
"""Public EventSink protocol and delivery configuration values.

CONTRACT v1.8: sinks observe already-accepted events.  They never run on
the graph's emit thread and have no graph handle or behavioral return path.
"""
```

**「它们绝不在图的 emit 线程上运行，也拿不到 graph handle，也没有行为返回路径。」**

这是一条非常强的隔离契约。一个挂死的 sink 不能拖垮运行时。

### 9.2 溢出策略

```text
# 来自 activegraph/sinks/base.py:19-30
class OverflowPolicy(str, Enum):
    """Non-blocking policy used when one sink's private queue is full.

    ``DROP_NEWEST`` preserves the queued prefix, ``DROP_OLDEST`` keeps the
    newest observation by evicting the oldest waiting item, and
    ``FAIL_SINK`` disables the attachment after counting the overflow.
    None of the policies waits for capacity on the runtime hot path.
    """

    DROP_NEWEST = "drop_newest"
    DROP_OLDEST = "drop_oldest"
    FAIL_SINK = "fail_sink"
```

**「None of the policies waits for capacity on the runtime hot path.」**

三种策略（丢最新 / 丢最旧 / 直接禁用），**没有一种会阻塞运行时**。这是典型的「宁可丢观测，不可卡业务」取舍——而且它把三种取舍都摆出来让你选，而不是替你决定。

### 9.3 单写者主机上的协作式排空

```text
# 来自 CONTRACT v1.10 #3（README 引述）
"Repeated quanta and one full drain produce byte-identical event logs
 under identical deterministic ids/clocks."
"Yielding with queued or delayed work emits no `runtime.idle`."
"This does not introduce concurrent graph mutation, behavior preemption,
 priority scheduling, or async execution. Fairness belongs to the host."
```

`run_quantum(max_queue_events=25, max_seconds=0.25)` 让单写者主机在大量派生工作排空期间仍能响应读取请求。

关键保证有两条：

1. **反复 quantum 与一次完整 drain 产生字节相同的事件日志**（在相同的确定性 id/时钟下）
2. **带着排队或延迟工作 yield 时，绝不发出 `runtime.idle`**

第二条尤其重要。`runtime.idle` 是一个「我干完了」的信号。如果带着未完成工作却发 idle，宿主会以为可以收工了，然后你就有了一个假完成的状态。

而第一条的**实现方式非常朴素**：`run_quantum` 和 `run_until_idle` 复用**同一个 `_loop` 函数**，只是换了停止谓词：

```text
# 来自 activegraph/runtime/runtime.py:1267-1301
    def _loop(self, *, stop: Callable[[], bool]) -> None:
        while (self._queue or self._delayed) and self._budget_remaining():
            if stop():
                return
            # Always drain main queue first. Delayed entries are checked
            # after each event tick so they fire at the right moment.
            if self._queue:
                event = self._queue.pop()
                assert event is not None
                self.budget.consume("max_events")
                self._tick += 1
                matches = cast(Registry, self.registry).match(event, self.graph)
                for b, rels, p_matches in matches:
                    if not self._budget_remaining():
                        break
                    # v0.7: activate_after defers invocation. Schedule and
                    # emit `behavior.scheduled` instead of invoking now.
                    if b.activate_after is not None:
                        self._schedule(b, event, p_matches)
                        continue
                    if p_matches and (b.on and b.pattern):
                        self._emit_pattern_matched(b, event, p_matches)
                    elif p_matches and not b.on:
                        # Pattern-only behavior: still emit a marker so
                        # the trace shows what fired.
                        self._emit_pattern_matched(b, event, p_matches)
                    if isinstance(b, RelationBehavior):
                        for r in rels:
                            if not self._budget_remaining():
                                break
                            self._invoke_relation(b, r, event, p_matches)
                    elif isinstance(b, LLMBehavior):
                        self._invoke_llm(b, event, p_matches)
                    else:
                        self._invoke(b, event, p_matches)
```

**字节一致性不是靠测试断言维持的，是靠「只有一条循环路径」这个结构事实保证的。** 这和 `apply_event` 的「Two callers, one code path」是同一种设计哲学：**用结构消灭一整类 bug，而不是用测试去覆盖它。**

顺便看这段循环的几个细节：
- 单线程 FIFO（CONTRACT #10），同优先级按注册顺序
- `self.budget.consume("max_events")` —— 预算在事件维度上被扣减
- `self._fire_due_delayed()` 在每个 tick 之后触发
- `activate_after` 不立即调用，而是调度并发出 `behavior.scheduled`

---

## 十、核心机制八：Policies 与 action_class 五级分类

### 10.1 五级动作分类

v1.9 引入了 `action_class` 闭集：

| 等级 | 含义 | 默认要求 |
|---|---|---|
| **R0** | observe | 无需审批 |
| **R1** | derive | 无需审批 |
| **R2** | reversible | 无需审批 |
| **R3** | outward | **require_approval, always** |
| **R4** | governance | **governance_gate, always** |

实例 ceiling 可以是 `none / R0 / R1 / R2`。**R3 和 R4 永远需要审批或治理门控**，没有例外路径。

### 10.2 一个关键的不可推断原则

**`risk_class` 与 `action_class` 永不互推。** 原文：

> "No inference, ever."

这句话的分量很重。在 Agent 安全领域，一个常见的错误是「让 LLM 自己判断这个操作危险不危险，然后按判断结果决定要不要审批」——这就是把审批权交给一个可能被 prompt injection 影响的组件。ActiveGraph 明确切断了这条推理链：动作类别是**声明式**的，由 pack 作者写死，不由运行时或 LLM 推断。

### 10.3 审批是事件状态机

审批状态机：`proposed → granted | denied`，对应事件 `approval.proposed` / `approval.granted` / `approval.denied`。

**审批和拒绝都进事件日志。** 这跟 patch.rejected 是同一个哲学：决策过程本身是历史的一部分，不是历史之外的副作用。

---

## 十一、⭐ 必须诚实指出的源码自陈缺陷

这是本系列最有价值的固定栏目。我把 ActiveGraph 源码里所有自陈的缺陷、边界和语义损失都挖出来了（原始扫描命中 752 行，去噪后保留以下清单）。

### 11.1 关系行为与 activate_after 组合完全未实现

```text
# 来自 activegraph/runtime/runtime.py:1365-1368
if isinstance(behavior, RelationBehavior):
    # For relation behaviors we'd need to refetch relations.
    # Defer this rare combination to a future enhancement.
    continue
```

**RelationBehavior + activate_after（延迟激活）这个组合根本不工作**，遇到就 `continue` 静默跳过。如果你在 fork 试验里依赖这个组合，行为不会触发，而且 trace 里也不会有明显提示（只有 `behavior.scheduled` 事件）。

### 11.2 payload 漂移无法被早期版本检测

```text
# 来自 activegraph/runtime/runtime.py:3290 附近
KNOWN LIMITATION (v0.5): payload-only drift is not detected
```

CONTRACT v0.5 #7 原文：

> "v0.5 compares the event-type stream (id, type). It catches categorical non-determinism — different number of events, different types in different positions — which is what actually breaks resume in v0.5. Payload-only drift (same shape, different values, e.g. a random number inside a payload) is NOT detected."

**早期版本只能发现「事件类型流」层面的分歧，发现不了「形状相同但值不同」的分歧。** 严格重放（strict replay）后来通过 prompt 哈希比较补上了这块。

### 11.3 Provenance 冲突曾经被静默剥离

```text
# 来自 activegraph/core/graph.py:15-19
CONTRACT #5 (provenance): every object/relation/patch carries a provenance
dict written here, never by the behavior. Behaviors pass `data`; a
`provenance` key in it raises ReservedFieldError (CONTRACT v1.10 #2 —
until v1.10 it was silently stripped, which meant a caller who thought
they attached provenance had attached nothing).
```

**「一个以为自己挂上了溯源信息的人，其实什么都没挂上。」** 这是 v1.10 之前的行为——现在会抛 `ReservedFieldError`。这是本系列见过最诚实的一类缺陷披露：它明确说出了一个**曾经会导致审计失效**的 bug。

### 11.4 Graph 只能 attach 一次 store

```text
# 来自 activegraph/core/graph.py:593-620
"Attaching does not load, copy, merge, or truncate history. "
"A graph and its authoritative EventStore must describe the "
"same run head before future events can be committed safely."
```

graph 与 store 必须处于同一个 run head，否则抛 `IncompatibleRuntimeState`。错误消息还给出了修复路径：

> "Use Runtime.load(...) to resume an existing run. To persist an in-memory graph, use runtime.save_state(path=...), which copies its accepted prefix before attaching."

### 11.5 Graph 投影可以丢弃，靠重放重建

```text
# 来自 activegraph/core/graph.py:163-168
# Wiping the projection loses nothing — replaying the log rebuilds it.
```

投影是可丢弃的缓存，日志才是真相。而且重放**不触发 sink 和 listener**——这正是 `apply_event` 作为唯一投影器的价值。

### 11.6 没有 provider 时大声失败

```text
# 来自 activegraph/runtime/runtime.py:968-969
# CONTRACT v0.6 #21: LLM behaviors fail loud at registration if
# there is no provider. We do not silently fall back to a mock —
# a missing provider is almost always a real misconfiguration.
```

**「我们不会悄悄退化到 mock。」** 这在 LLM 框架里是罕见的诚实——很多框架的默认行为是缺 provider 就给你一个返回固定字符串的假 provider，让你的测试「通过」但线上完全不对。

### 11.7 delayed 行为的 where 复检失败时静默跳过

```text
# 来自 activegraph/runtime/runtime.py:1350-1354
# Silently skip per CONTRACT v0.7 #13. The trace already
# has the behavior.scheduled event; absence of a
# behavior.started is sufficient evidence the where
# didn't hold.
```

理由是「轨迹里已有 `behavior.scheduled`，没有 `behavior.started` 就足以说明 where 没成立」。推理成立，但**「静默」二字仍然值得读者警惕**。

### 11.8 严格重放禁止外部 embedding I/O

```text
# 来自 activegraph/runtime/runtime.py:1208-1215
# Strict replay is never allowed to fall through to external
# embedding I/O, even if a provider object is configured.
```

严格重放绝不允许回落到外部 embedding I/O。**如果你的 pack 在重放路径里需要 embedding，行为会失败而不是悄悄调用网络。**

### 11.9 直接调 embedding provider 会绕过缓存

```text
# 来自 activegraph/runtime/runtime.py:217-228（Context.embed）
Packs should use this method instead of calling
``runtime.embedding_provider.embed`` directly.  The latter cannot be
prohibited in Python, but it bypasses the event pair and replay cache.
```

**「The latter cannot be prohibited in Python」** —— Python 没法阻止你绕过，但框架把正确路径明确告诉你了。

### 11.10 `get_relations(direction="both")` 无法下推

```text
# 来自 activegraph/core/graph.py:260-263
"both" needs source-OR-target, which find_relations (AND-only) can't express,
so we push the type filter and apply the membership test here. An
unrecognized direction keeps the v0 quirk of ignoring object_id.
```

双向关系查询无法下推到存储层，只能回到 Python 过滤。**而且未识别的 direction 会「保持 v0 的怪癖」——忽略 `object_id`。** 这是个静默的行为陷阱。

### 11.11 SQLite 的 synchronous=NORMAL 有语义损失

```text
# 来自 activegraph/store/sqlite.py:125-129
# OS crash may lose the last committed transactions but never corrupts the file.
```

**崩溃可能丢最后几个已提交事务，但不会损坏文件。** 明确的取舍：换写入性能。

### 11.12 EventStore 不是数据库

```text
# 来自 activegraph/store/base.py:7-9
# No queries, no indexes beyond what the backend ships. This is an event log,
# not a database.
```

以及：

```text
# 来自 activegraph/store/base.py:52-55
# The log is the source of truth; the graph projection rebuilds from here and
# is never stored here.
```

**「This is an event log, not a database.」** 想做复杂查询请自己导出。

### 11.13 store URL 不猜 scheme

```text
# 来自 activegraph/store/url.py:11-14
# A path with no scheme is rejected... We do not silently guess.
```

路径没有 scheme 就拒绝，不猜。

### 11.14 其他已记录的推迟项

| 位置 | 内容 |
|---|---|
| `activegraph/llm/provider.py:32` | "No streaming, no multi-model orchestration — those are deferred to v0.8+" |
| CONTRACT v1.8 #4 | "An explicit historical sink-export API is deferred in v1.8" |
| CONTRACT v1.9 | "No governance-gate implementation" |
| `activegraph/runtime/patterns.py` | 事件属性绑定、关系属性访问、分支模式均未支持 |

### 11.15 一句总结

**这个项目的缺陷披露密度，在 Agent 开源项目里属于顶级。** 它不仅列出了「不支持什么」，还经常解释「为什么曾经做错、错在哪一行、现在怎么防复发」。

对比一下 hol-guard 项目（我在 2026-11-07 写过它）——它的「扫描器规避语料库」也是这个级别的诚实。**2026 年下半年开始，顶尖的 Agent 基础设施项目正在形成一种「主动披露已知缺口」的文化**，这可能比任何单个技术特性都更有长期价值。

---

## 十二、与同类项目的设计差异

先说清楚：ActiveGraph 不该和 LangGraph / CrewAI 直接对比，因为它们解决的问题层级不同。ActiveGraph 的真正同类是**其他事件溯源 / 持久执行框架**。

| 项目 | 状态抽象 | 协调机制 | 可分叉 | 可重放 | 审计粒度 | 语言 |
|---|---|---|---|---|---|---|
| **ActiveGraph** | **图 = 事件日志的投影** | **边上的行为（RelationBehavior）+ 图形状模式订阅** | ✅ 任意事件 + 共享前缀缓存 | ✅ 字节级确定性 | ✅ 每个对象/关系/Patch 带 provenance | Python |
| LangGraph | 显式 state 对象 | 节点边（写进 state） | ❌ | ⚠️ checkpointer 快照 | ⚠️ 状态快照 | Python |
| Restate | 持久执行日志 | 确定性重放 | ❌ | ✅ 核心能力 | ✅ | Rust |
| Dapr Agents | 无状态（调用外部服务） | 决策钩子 | ❌ | ❌ | ⚠️ | Go/.NET |
| AutoGen | 消息历史 | Agent 间对话 | ❌ | ❌ | ⚠️ | Python |
| CrewAI | 任务列表 | 角色 + 任务交接 | ❌ | ❌ | ⚠️ | Python |
| Temporal | 工作流历史 | 活动编排 | ❌ | ✅ 核心能力 | ✅ | Go/Java/… |
| LangGraph + Checkpointer | 状态快照 | 节点边 | ⚠️ 手动 | ⚠️ 状态级 | ⚠️ | Python |

### 12.1 与 LangGraph：状态图 vs 事件日志投影

LangGraph 的 state 是**权威状态**，checkpoint 是快照。重放是从快照恢复，不是从日志重建。

ActiveGraph 的 state 是**投影**，`apply_event` 是唯一投影器。差别在于：

- **LangGraph**：状态是事实，日志是调试信息
- **ActiveGraph**：日志是事实，状态是缓存

这个差别决定了能不能做「fork-and-diff」。LangGraph 没法 fork，因为在「事件 X 那一刻的状态」这个概念上，它没有统一的时间轴——只有快照。

### 12.2 与 Restate / Temporal：持久执行的粒度

Restate 和 Temporal 也是日志驱动的可重放系统，但它们重放的是**工作流步骤**。ActiveGraph 重放的是**图状态 + 行为反应**。

关键区别在粒度：

- Restate/Temporal：一个 durable workflow = 一串确定的步骤
- ActiveGraph：一张图 + 一组反应式行为，事件流决定了一切

Restate 的重放是「重跑同样的代码序列」。ActiveGraph 的重放是「重新投影事件，然后让行为重新响应」——后者更接近「重新思考」而非「重新执行」。

而 **RelationBehavior 是 Restate / Temporal 完全没有的抽象**。那两个系统的协调逻辑都写在 workflow 的步骤序列里，没有「把逻辑挂在边上」这个位置。

### 12.3 三种协调范式的对照

```mermaid
flowchart LR
    subgraph CHAT["对话范式（AutoGen / CrewAI）"]
        A1["Agent A"] -->|"发消息"| A2["Agent B"]
        A2 -->|"发消息"| A1
    end

    subgraph SHARED["共享状态范式（LangGraph）"]
        B1["节点 A"] -->|"写入"| S["State 对象<br/>权威状态"]
        B2["节点 B"] -->|"写入"| S
        S -->|"读取"| B1
        S -->|"读取"| B2
    end

    subgraph REACT["反应范式（ActiveGraph）"]
        C1["Behavior"] -.->|"订阅事件"| G["共享图<br/>事件日志的投影"]
        C2["RelationBehavior"] -.->|"订阅边 + 形状"| G
        G -.->|"推"| C1
        G -.->|"推"| C2
    end
```

三者的关键差别不在于「Agent 怎么被触发」，而在于**协调状态放在哪里**：

- **对话范式**：协调信息在消息里。信息经过转述会失真，没有审计价值，消息量随参与方数平方增长。
- **共享状态范式**：协调信息在一个 state 对象里。灵活，但谁来保证 state 结构稳定、谁来保证读取时看到一致快照？
- **反应范式**：协调信息在图里。**所有行为直接观察同一份状态，变更历史留在事件日志中。** A 和 B 不需要互相知道对方存在。

### 12.3 与 AutoGen / CrewAI：对话 vs 反应

AutoGen 和 CrewAI 的协调是**消息驱动**的：A 发消息给 B，B 收到后决定做什么。这是 pull 模型。

ActiveGraph 是**push 模型**：事件广播到图上，所有订阅该事件的 behavior 都被触发。behavior 之间**不互相知道对方存在**。

README 有一句总结得非常好：

> "If chat-based agents are a group conversation, Active Graph is a shared workspace where everyone can see what changed, who changed it, and why."

**群聊 vs 共享工作区。** 群聊里信息靠对话传递，会丢、会失真、无法审计。共享工作区里所有人直接看同一份状态，变更历史一目了然。

### 12.4 与 Dapr Agents：决策钩子的粒度

Dapr Agents 有决策钩子，但它是**进程内的控制点**——Agent 内部逻辑决定要不要调 LLM。ActiveGraph 的钩子是**图上的关系**——决定某个关系类型的边在特定事件发生时要不要触发行为。

后者能做前者做不了的事：表达「A 与 B 之间的关系变更时触发 C」这种**跨实体**的协调。

### 12.5 与 AOCI（2026-11-08 写过）：两种「制品化」路线

有意思的是，ActiveGraph 和我在 2026-11-08 写过的 AOCI 有一组有趣的对照：

| 维度 | AOCI | ActiveGraph |
|---|---|---|
| 核心主张 | 理解本身是需要版本化的制品 | 历史本身是唯一的事实来源 |
| 制品形态 | Git 里的自然语言文档 | 事件日志 |
| 治理方式 | 校验、指纹、漂移检测 | 契约、单一投影器、严格重放 |
| 面向 | 让人和 Agent 都读懂系统 | 让 Agent 系统的历史可审计可分叉 |

两者其实**互补**：AOCI 解决「Agent 怎么理解系统」，ActiveGraph 解决「Agent 做事的过程怎么被记录和复现」。如果组合起来，就是「制品化的理解」+「可审计的行为」。

---

## 十三、优缺点分析

### 13.1 优势侧：架构简洁性 / 扩展性 / 易用性

**架构简洁性：极强。**

「Two callers, one code path」（两个调用方，一条代码路径）这个原则贯穿全局：

| 关注点 | 单一路径设计 |
|---|---|
| 状态变更 | `apply_event` 是唯一投影器 |
| 实时 / 重放 | 同一个 `_loop`，只换 stop 谓词 |
| 调度 | 单线程 FIFO，注册顺序决定 tie |
| 提示词组装 | runtime 拥有，开发者只能通过 `build_prompt` 检视 |

一个系统里「状态怎么变」只有一处代码，意味着**这个系统的行为是可推理的**。你不需要读完 20 万行的 runtime.py 才能预测它会做什么——你只需要读 `apply_event`。

**扩展性：靠契约和 Pack 双轨。**

Pack 机制把「对象类型 + 关系类型 + 行为 + 工具 + 策略 + prompt」打包成一个可分发的领域包。Diligence pack 是参考实现：8 个对象类型、7 个行为、3 个工具、录制好的 fixtures。

```text
# 来自 packs/manifest.py:145-149
@dataclass(frozen=True)
class PackManifest:
    """A parsed, schema-valid ``manifest.toml``. PROVISIONAL shape.

    Field names mirror the spec's tables; ``raw`` preserves the full
```

**扩展性：靠契约和 Pack 双轨。**

Pack 机制把「对象类型 + 关系类型 + 行为 + 工具 + 策略 + prompt」打包成一个可分发的领域包。Diligence pack 是参考实现：8 个对象类型、7 个行为、3 个工具、录制好的 fixtures。

**易用性：中等偏上。**

好的一面：
- `pip install activegraph && activegraph quickstart` 30 秒看到效果，**无 API key、字节确定性输出**
- 错误消息带 `More:` 链接，每个错误码一页文档，说明「何时触发、为什么、怎么修」
- `runtime.fork()` / `rt.diff()` / `rt.promote()` 是一等公民 API，不是 CLI 专属

需要适应的一面：
- 事件溯源的心智模型需要时间
- `action_class` 五级分类需要设计你的领域
- 没有流式输出、没有多模型编排（官方说推迟到 v0.8+，实际目前仍未实现）

### 13.2 代价侧：性能 / 复杂度 / 维护性

**性能：事件溯源有固有成本。**

每个状态变更都是一个事件 → 序列化 → 持久化 → 投影。对高吞吐场景（比如每秒几千次变更），这个开销是实打实的。项目用几条设计对冲：

| 优化 | 说明 |
|---|---|
| View 下推 | `include_types` 在 FalkorDB 层翻译成 `type IN [...]` |
| 关系类型下推 | `_matching_relations` 把类型过滤推到 store |
| 关系过滤下推 | `graph.neighborhood(center, depth)` 走 store |
| 缓存命中 | 同 prompt / 同 args 不重复调 LLM |
| `run_quantum` | 大排空期间保持读取响应 |

但如果你的场景是「每秒钟百万次状态变更」，事件溯源不是好选择。ActiveGraph 定位的是**长时间运行、行为数量中等、但需要审计**的场景。

**复杂度：概念负担不轻。**

12 个原语 + 事件类型命名空间 + action_class + Frame + Policy + Pack……学习曲线明显陡于 LangGraph。README 自己也承认要按「读 trace 的顺序」来理解这 12 个原语。

而且 Python 的动态特性帮不上忙：框架无法阻止你绕过 `Context.embed` 直接调 provider（"The latter cannot be prohibited in Python"）。**在一个强调「结构性不可能违规」的项目里，语言本身的开放性反而削弱了这层保证。**

**维护性：文档负担极重。**

`CONTRACT.md` 402 KB / 8,623 行，`CHANGELOG.md` 152 KB，`docs/` 85 个文件，`CONTRACT-review-findings.md` 32 KB。这既是优点（规范即产品）也是代价（每次改动都要考虑契约版本、向后兼容、amendment 规则）。

不过有个细节值得称赞 —— 契约的两条常设规则：

> "**Standing rule §1 — Amendments append, never modify.**"
> "**Standing rule §2 — Tests anchor on the boundary the contract names, not the implementation's path.**"

**「修订只追加，永不修改」**——这意味着 CONTRACT.md 是一条单调增长的时间线，任何版本都能查到当时的状态。第二条则说测试锚定在「契约命名的边界」上，而不是实现的路径上——**测试测的是契约，不是实现**。

这两条规则让 8,623 行的规范文件仍然可维护。这是一个非常聪明的工程决策。

---

## 十四、实践：30 秒跑起来

```bash
pip install activegraph
activegraph quickstart
```

交互式教程（包含 fork-and-diff 全流程）：

```bash
activegraph quickstart --interactive
```

README 描述：

> "It scaffolds a behavior, runs it against the same fixtures, and ends with the fork-and-diff workflow — the framework's most differentiated capability."

### 14.1 写一个自己的 Behavior

```python
from activegraph import Behavior, Runtime

@behavior(on=["question.created"])
def spawn_research(event, graph, ctx):
    """When a question appears, create a research task."""
    graph.add_object(
        type="task",
        data={"title": event.payload["question"], "status": "pending"},
    )
```

### 14.2 用模式订阅图形状

```python
# 订阅「某条 claim 被证据引用」的图形状
@behavior(
    pattern="""
    (claim:Claim)-[:CITES]->(evidence:Evidence)
    WHERE evidence.confidence < 0.6
    """
)
def flag_low_confidence(event, graph, ctx):
    ...
```

### 14.3 Fork-and-Diff 完整流程

```bash
# 1. 从父运行的某个事件分叉
activegraph fork sqlite:///run.db \
    --run-id <parent-run> \
    --at-event <event-id> \
    --label "higher-threshold" \
    --set diligence.confidence_threshold_for_review=0.9

# 2. 跑起来

# 3. 比较
activegraph diff <fork-run-id>

# 4. 如果结果更好，采纳
activegraph promote <fork-run-id>
```

### 14.4 用 Postgres 后端

```python
from activegraph import Runtime

rt = Runtime.load("postgresql://user:pass@host/db")
```

### 14.5 挂一个事件导出 sink

```python
from activegraph.sinks import JSONLEventSink

sink = JSONLEventSink(path="trace.jsonl")
rt.attach_sink(sink)
```

---

## 十五、趋势判断与总结

### 15.1 三个趋势

**趋势一：Agent 运行时正在从「状态机」走向「事件溯源」。**

LangGraph 用显式 state，CrewAI 用任务列表，AutoGen 用消息历史——这些都是「状态机」范式：当前状态是权威，历史是副产品。ActiveGraph 反转了这个关系。

我判断这个转向会扩散，理由是**审计与合规压力**：企业一旦要让 Agent 参与决策，就必须能回答「当时它看到了什么、为什么这么做」。这个问题只有事件溯源能回答。Restate、Temporal 已经用「持久执行」证明了这个方向在基础设施层是成立的，ActiveGraph 是把这个方向带到 Agent 层的尝试。

**趋势二：「反应式」会取代「对话式」成为多 Agent 协调的主流范式。**

AutoGen 之后有一大批框架在优化「Agent 之间怎么说话」。但对话是**有损**的：信息经过转述会失真，没有审计价值，还容易形成 N² 的消息复杂度。

ActiveGraph 的 push 模型（事件广播 + 图形状订阅）提供了一个更干净的替代：**协调逻辑是声明式的，协作状态是可查询的，协作历史是可审计的。**

**趋势三：「契约即产品」会成为 Agent 基础设施的差异化维度。**

402 KB 的 CONTRACT.md、每个错误码一页文档、13.5 万字的 CHANGELOG——这套东西在功能上不占优，但它让使用者**能信任这个系统**。

在一个 AI 生成代码占比越来越高的时代，「这个系统的行为是被 8,623 行规范约束着的」本身就是卖点。ActiveGraph 甚至在 `docs.activegraph.ai` 提供了 `llms.txt` / `llms-full.txt`——**给 AI 编码助手读的机器可读文档**。这个细节非常能说明问题：作者从第一天就把「AI Agent 要来读我的文档」当作一等场景。

### 15.2 最重要的工程经验提炼

如果要把 ActiveGraph 的经验抽象成可迁移的原则，我会总结成这五条：

**① 用结构消灭 bug 类别，而不是用测试覆盖它。**

`apply_event` 唯一投影器、`_loop` 单一循环路径、runtime 拥有 prompt 组装——这三条不是代码风格，是**把一整类 bug 从可能性空间里删除**的手段。这比任何测试覆盖率都有效。

**② 拒绝也是事件，成功也是事件，决策过程本身是历史。**

`patch.rejected` 和 `patch.applied` 享有同等地位；`approval.denied` 和 `approval.granted` 同理。**在事件溯源系统里，「什么都没发生」和「发生了什么都一样」是两种截然不同的状态，必须被同样记录。**

**③ 缓存键要按内容，不要按身份。**

按 event id 缓存，fork 就失效；按 prompt 内容哈希缓存，fork 才便宜。**这个差别是整个 fork-and-diff 能力的成本基础。**

**④ 主动披露已知缺口，比声称完备更有价值。**

ActiveGraph 列出 26 处自己的边界，还包括「v1.10 之前溯源信息曾被静默剥离」这种**曾经会导致审计失效的历史 bug**。在 Agent 落地越来越快的当下，「我明确告诉你这里有个坑」比「我假装没有坑」专业得多。

**⑤ 契约只追加，不修改。**

`Standing rule §1 — Amendments append, never modify.` 一条规则，让 8,623 行的规范文件保持可审计、可回溯。**这在文档工程上比任何写作技巧都重要。**

### 15.3 一句话总结

> **ActiveGraph 不是又一个 Agent 框架。它提供的是一个更底层的东西：一个让 Agent 系统的「世界」「行为」「历史」三者各自有明确归属的运行时底座。图是投影，行为是反应，历史是真相。**
>
> 543 篇历史文章之后，这是第一篇真正进入「事件溯源」这个空白维度的深度解析。

---

## 附录：关键资源

| 资源 | 地址 |
|---|---|
| GitHub | https://github.com/yoheinakajima/activegraph |
| 项目主页 | https://activegraph.ai/ |
| 官方文档 | https://docs.activegraph.ai/ |
| 机器可读文档 | https://docs.activegraph.ai/llms.txt · `llms-full.txt` |
| 交互式教程 | https://learn.activegraph.ai/ |
| 论文一 | 《The Log is the Agent》 arXiv:2605.21997 |
| 论文二 | 《Regimes》 arXiv:2606.10241 |
| Pack 库 | https://github.com/yoheinakajima/activegraph-packs |
| 研究 Agent | https://github.com/yoheinakajima/activegraph-lab |
| PyPI | `pip install activegraph` |
| License | Apache-2.0 |

### 源码引用索引

本文所有代码引用均来自 `main` 分支（2026-11-03 快照）：

| 文件 | 引用位置 |
|---|---|
| `activegraph/core/graph.py` | 1-23（模块契约）、629-659（emit 流程）、1071-1077（apply_event）、1055-1064（因果链）、260-263（direction 下推）、593-620（attach 校验） |
| `activegraph/core/patch.py` | 1-18（生命周期）、21-38（封闭词汇表） |
| `activegraph/behaviors/base.py` | 1-14（模块契约）、29-36（fn 直调报错）、39-70（Behavior）、73-83（RelationBehavior）、166-170（单次触发） |
| `activegraph/runtime/registry.py` | 1-13（匹配语义）、40-70（match）、85-98（关系匹配）、101-115（字符串收集） |
| `activegraph/runtime/runtime.py` | 217-228（Context.embed）、968-969（fail loud）、1208-1215（严格重放）、1267-1301（主循环）、1350-1354（delayed 静默）、1365-1368（relation+activate_after） |
| `activegraph/runtime/view_builder.py` | 1-49（build_view） |
| `activegraph/runtime/diff.py` | 1-11（结构化 diff）、30-49（DivergentObject） |
| `activegraph/runtime/patterns.py` | 15/21-29（语法与拒绝清单）、282-283（线性链）、718-723（事件属性）、899-902（关系属性） |
| `activegraph/llm/cache.py` | 1-28（内容哈希缓存与严格漂移检测） |
| `activegraph/llm/provider.py` | 1-37（Provider 协议与推迟项） |
| `activegraph/sinks/base.py` | 1-5（隔离契约）、19-30（溢出策略）、48-56（DeliveryContext） |
| `activegraph/store/base.py` | 7-9（不是数据库）、52-55（投影不入库） |
| `activegraph/store/sqlite.py` | 125-129（synchronous=NORMAL 取舍） |
| `activegraph/store/url.py` | 11-14（不猜 scheme） |
| `activegraph/packs/manifest.py` | 80-84（PackManifestError）、124-149（CapabilityDecl / PackManifest） |
| `CONTRACT.md` | v0 #1-#18（基础不变式）、v0.5 #1-#22（fork/diff 语义）、v1.8 #1-#5（sink）、v1.9（action_class）、v1.10 #3（run_quantum） |
| `docs/concepts/forking.md` | 共享血缘模型、CLI/Python 接口、缓存重放、promote |
