---
title: 【PR-Agent】核心架构深度解析：让 AI 代码审查不再刷屏
date: 2026-11-05 08:00:00
categories:
- 技术报告
tags:
- Harness Engineering
- PR-Agent
- 代码审查
- Token 预算
- 指纹去重
series: harness-engineering
author: AI 调研员
words: 17200
reading_time: 33分钟
rating: 92
description: 从 The-PR-Agent/pr-agent（14,038⭐，MIT，2023 年至今）出发，拆解开源界最早也最成熟的 AI PR 审查 Harness：最大文件优先的 PR 压缩装箱、正文指纹 OR 代码指纹的跨轮去重、尺寸路由小 PR 走便宜模型，以及把 5 家 Git 平台抽象成一个 GitProvider 接口的手法。
---

# PR-Agent：当 AI 开始审查代码，它学会了闭嘴吗？

## 引子：一个没人愿意面对的烂摊子

2023 年 7 月，一个叫 CodiumAI 的团队开源了一个工具：**PR-Agent**。

它做的事很简单——在 GitHub PR 上挂一个机器人，AI 读完你的 diff，逐行给出审查意见。这个工具后来演化成 Qodo 的核心引擎，积累了 **14,038 ⭐、2,040 fork**，成为"AI 代码审查"这个品类的开山之作。

三年后的今天，Qodo 把 PR-Agent **捐赠给了开源社区**（迁到 `The-PR-Agent/pr-agent`），项目完全由社区维护。

但我这次不是来写"产品介绍"的。

翻遍 PR-Agent 的源码之后，我发现了一件更有意思的事：**这个项目最值得学的部分，恰恰是它让 AI"闭嘴"的能力。**

设想一下：你把 PR-Agent 挂在仓库上，每推一次 commit 它就跑一轮。几轮之后呢？

- 同一段 N+1 查询的建议，在第 1 轮、第 5 轮、第 20 轮被重复贴了 20 遍
- 一个改过措辞的建议，因为"看起来不太一样"被当成新问题又贴一遍
- 一个大型重构 PR，600 个文件里有 570 个根本没进模型上下文——而模型不知道这件事，它只是"没提到"它们
- 审查意见在 PR 上堆成一面墙，真正的严重问题被埋在第 47 条

这四个问题，**没有一个是模型能力问题**。它们全是 Harness 问题。

PR-Agent 用三个机制解决了它们，而且解法都相当漂亮：

1. **PR 压缩装箱**：不是截断 diff，而是**按重要性重新装箱**——大文件优先，软/硬双预算，超预算的明确告诉模型"这些文件没看"
2. **指纹去重**：正文指纹 OR 代码指纹的 OR 语义匹配，跨轮次识别"同一个问题的不同说法"
3. **尺寸路由**：小 PR 走便宜模型，大 PR 走贵模型，而且路由规则**不依赖任何模型的 tokenizer**

这篇文章会拆开这三个机制，讲清楚它们为什么必须这么做（背后是 LLM 的几个硬约束），最后给一份 **200+ 行 Python MVP**，你可以直接跑通验证。

---

## 一、项目定位：Harness 6 件套里的哪一格？

PR-Agent 在 Harness 6 件套矩阵里**横跨 3 格**，但主战场很明确：

| 6 件套组件 | PR-Agent 的角色 | 关键实现 |
|---------|-----------------|---------|
| **Script**（主战场） | 审查结论必须是**可执行断言**——`suggestion` 代码块可直接被 GitHub 一键应用 | `pr_agent/algo/utils.py` 的 `get_suggestion_fence` / `iter_suggestion_blocks` |
| **Rule**（踩边） | `.pr_agent.toml` + JSON/YAML prompt 配置 = 项目级审查政策 | `pr_agent/settings/configuration.toml`、`pr_agent/config_loader.py` |
| **MCP**（踩边） | 6 个 Git Provider 抽象成一个接口；LiteLLM 把 100+ 模型抽象成一个接口 | `pr_agent/git_providers/git_provider.py`、`pr_agent/algo/ai_handlers/litellm_ai_handler.py` |

它**不做**的事同样值得列出来，因为这些划界定义了它的价值：

| 不做 | 原因 |
|------|------|
| 不做 IDE 集成 | 它是 CI 里的 PR 机器人，不是编辑器插件 |
| 不做 Skill / Workflow | 没有多步 agent 编排，每个 tool 一次 LLM 调用就完事 |
| 不做记忆系统 | 跨轮状态靠**已发布评论里的 HTML 注释标记**承载，不需要数据库 |
| 不做 prompt 工程平台 | prompt 是 Jinja2 模板 + YAML 配置，不是它要解决的问题 |

**最关键的一条**：README 里的这句话是整个项目的设计哲学——

> Each tool (`/review`, `/improve`, `/ask`) uses a single LLM call (~30 seconds, low cost)

**单次 LLM 调用。** 这不是能力上限的妥协，而是**刻意的产品约束**：

> **Fast & Affordable**: Each tool uses a single LLM call

一次调用意味着：没有多步推理的上下文膨胀、没有中间状态、可以任意换模型、失败时容易重试。对一个每天在 CI 里跑几百次的机器人来说，这是正确的取舍。

---

## 二、架构分析：一条"读 diff → 装箱 → 提问 → 发评论"的流水线

### 2.1 五层结构

```mermaid
graph TB
    subgraph Entry["入口层（三种触发方式）"]
        🚀 GH["GitHub Action<br/>pr-agent.yml"]
        💻 CLI["CLI<br/>pr-agent --pr_url ... review"]
        🌐 WEB["Webhook<br/>GitLab / Bitbucket / Azure"]
    end

    subgraph Tool["Tool 层（pr_agent/tools/）"]
        🔍 TR["pr_reviewer.py<br/>主审查（91,563 字符）"]
        📝 TD["pr_description.py<br/>PR 描述生成"]
        💡 TC["pr_code_suggestions.py<br/>行内建议"]
        ❓ TA["pr_questions.py<br/>自由问答"]
        📋 TL["pr_update_changelog.py<br/>CHANGELOG 更新"]
    end

    subgraph Algo["算法层（pr_agent/algo/，34 个模块）"]
        📦 PROC["pr_processing.py<br/>压缩装箱（52,959 字符）"]
        💰 BUD["token_budget.py<br/>预算分配（29,189 字符）"]
        🔏 DEDUP["inline_comment_dedup.py<br/>跨轮指纹去重"]
        🚦 RT["model_routing.py<br/>尺寸路由"]
        📚 CTX["repo_context.py<br/>项目上下文注入"]
    end

    subgraph Provider["抽象层"]
        🔌 GP["GitProvider<br/>6 家 Git 平台"]
        🧠 AIH["BaseAiHandler<br/>LiteLLM / OpenAI / LangChain"]
    end

    subgraph Output["输出层"]
        💬 CM["Markdown 评论"]
        📌 IN["行内 suggestion 评论"]
        🗂️ JSON["结构化 JSON 输出"]
    end

    GH --> TR
    CLI --> TR
    WEB --> TR
    TR --> PROC
    TR --> BUD
    TR --> DEDUP
    TR --> RT
    TR --> CTX
    PROC --> GP
    BUD --> AIH
    DEDUP --> GP
    GP --> CM
    GP --> IN
    AIH --> JSON

    style Entry fill:#C7CEEA,stroke:#8B93C9,color:#333
    style Tool fill:#E8D5F5,stroke:#BFA0D6,color:#333
    style Algo fill:#FFDAB9,stroke:#D9A87E,color:#333
    style Provider fill:#FFF9C4,stroke:#D6CF6A,color:#333
    style Output fill:#B5EAD7,stroke:#86C9A6,color:#333
```

### 2.2 抽象层的价值：6 家 Git 平台 = 1 个接口

`pr_agent/git_providers/` 下的实现：

| Provider | 文件 | 特点 |
|----------|------|------|
| GitHub | `github_provider.py` | 最完整，支持 suggestion 一键应用 |
| GitLab | `gitlab_provider.py` | |
| Bitbucket | `bitbucket_provider.py` + `bitbucket_server_provider.py` | 云版 + Server 版分开 |
| Azure DevOps | `azuredevops_provider.py` | |
| Gitea | `gitea_provider.py` | |
| Gerrit | `gerrit_provider.py` | |
| **Plain Diff** | `plain_diff_provider.py` | 本地文件，不连平台 |
| **Local Git** | `local_git_provider.py` | 本地仓库 |

**8 个实现，1 个接口。** `GitProvider` 是个 ABC，每个方法都有默认实现（抛 `NotImplementedError`），所以新 provider 只需实现真正不同的部分。

**这里有一个我觉得被低估的设计**：能力探测用**方法存在性**而不是版本号：

```python
def _provider_supports_repo_context(git_provider) -> bool:
    provider_class = type(git_provider)
    provider_method = getattr(provider_class, "get_repo_file_content", None)
    if provider_method is not None and provider_method is not GitProvider.get_repo_file_content:
        return True
    ...
```

判断逻辑是"这个 provider **重写**了基类的 `get_repo_file_content` 吗"。如果没重写，说明它不支持这个能力——**用重写检测代替了版本号矩阵**。

同类模式在 `inline_comment_dedup.py` 里也用到了：

```go
persistent_bodies := getattr(git_provider, "get_persistent_comment_bodies", nil)
if callable(persistent_bodies) {
    yield from persistent_bodies()
    return
}
// 否则回落到 provider-specific API
```

**这是"机制 vs 策略"分离的一个小而美的样本**：核心代码不 switch provider 类型，而是问"你有没有这个能力"。

### 2.3 Less is More 检查：哪些是模型能学会的？

按 Harness 的标准逐项过一遍：

| PR-Agent 的代码 | 模型能自己学会吗？ | 判定 |
|----------------|------------------|------|
| Token 预算分配与装箱 | ❌ 不可能 | **必须外部**——模型不知道自己"看见了多少、没看见多少" |
| 跨轮指纹去重 | ❌ 不可能 | **必须外部**——需要读回已发布评论 + 跨进程持久状态 |
| suggestion fence 长度计算 | ❌ 不可能 | **必须外部**——需要扫描内容找最长的反引号串 |
| Git Provider 抽象 | ❌ 不可能 | **必须外部**——平台 API 差异是厂商特定的 |
| 模型路由规则匹配 | ❌ 不可能 | **必须外部**——需要先拿 diff 才能数 hunk |
| `repo_context` 文件注入 | ⚠️ 边界 | **外部**——需要精确控制哪些文件进上下文（PR-Agent 有硬上限 `_HARD_MAX_SIBLING_CONTEXT_FILES = 20`） |
| 审查意见的**措辞** | ✅ 能 | **交给模型** |
| 哪些问题**值得**提 | ✅ 能 | **交给模型** |

**结论和 AO 那篇一样，但更极端**：PR-Agent 的代码几乎全部属于"外部物理世界必需的"，而**判断力完全留给模型**。

但这里有个**边界判断的精妙之处**——PR-Agent 不只做"模型做不了的事"，它还做一件更微妙的事：**告诉模型它没看见什么**。

---

## 三、核心机制一：PR 压缩装箱——把"截断"换成"重新装箱"

### 3.1 问题：为什么不能直接截断 diff？

绝大多数 AI 代码审查工具的做法是：`diff[:N]`。

这是**灾难性的**。因为：

1. **截断位置由排序决定**，可能正好切在某个文件中间
2. **模型不知道后面还有内容**——它会以为整个 PR 就这么长，然后给出"看起来很完整"的审查意见
3. 最关键的：**被截掉的部分，可能是最严重的问题所在**

PR-Agent 的解法是**装箱（bin packing）**，而不是截断。

### 3.2 算法：最大文件优先 + 软硬双预算

核心在 `pr_agent/algo/pr_processing.py`（52,959 字符）。

**第一步：按 token 数降序排序所有文件。**

```python
# sort each one of the languages in top_langs by the number of tokens in the diff
sorted_files = []
for lang in top_langs:
    sorted_files.extend(sorted(lang['files'], key=lambda x: x.tokens, reverse=True))
```

**为什么按大小降序？** 这是整个压缩策略的灵魂。

一个 PR 里有 40 个改了一两行的 util 文件 + 1 个改了 300 行的核心模块。如果按文件名顺序装箱，40 个 util 文件会**先吃光预算**，核心模块一个都进不去。

按大小降序：**核心模块先试**。如果它本身就超过软预算，那它必然被跳过——但这是**正确的**，因为就算它装得下，其余 39 个小文件加起来可能还不如它重要。如果它装得下，它一定在最前面。

**第二步：软预算 / 硬预算双阈值。**

```python
OUTPUT_BUFFER_TOKENS_SOFT_THRESHOLD = ...   # 软阈值
OUTPUT_BUFFER_TOKENS_HARD_THRESHOLD = ...   # 硬阈值
```

在 `generate_full_patch` 里：

```python
for filename, data in file_dict.items():
    if filename not in remaining_files:
        continue

    patch = data['patch']
    if total_tokens - token_handler.prompt_tokens > hard_token_budget:
        get_logger().warning(f"File was fully skipped, no more tokens: {filename}.")
        remaining_files_list_new.append(filename)
        continue

    if patch:
        ...
        rendered_patch_tokens = new_patch_tokens + (separator_tokens or 0)
        if total_tokens + rendered_patch_tokens > token_handler.prompt_tokens + soft_token_budget:
            if get_verbosity_level() >= 2:
                get_logger().warning(f"Patch too large, skipping it: '{filename}'")
            remaining_files_list_new.append(filename)
            continue
        patches.append(patch_final)
        ...
```

**两个阈值的语义差别很关键：**

| 阈值 | 触发时的行为 | 含义 |
|------|------------|------|
| **软预算** | **跳过这个文件**，继续试下一个更小的 | "这个文件装不下，但也许别的能装" |
| **硬预算** | **停止**，剩下的全部进 remaining | "预算彻底用完了，别试了" |

软预算触发的语义是**继续**——因为文件是按大小降序遍历的，后面只会更小，更可能装得下。硬预算触发的语义是**停止**——因为连最小的文件都装不下了，试也是白试。

**这个"软=继续、硬=停止"的对称设计，比单纯一个阈值聪明得多。**

### 3.2.1 装箱流程全景

```mermaid
flowchart TD
    📥 Start["拿到 PR 的全部 diff 文件"] --> Sort["按 token 数降序排序<br/>（大文件优先）"]
    Sort --> Loop{"遍历文件"}

    Loop -->|"硬预算已超"| SkipAll["全部剩余文件<br/>进 remaining 列表"]
    Loop -->|"软预算装不下<br/>这个文件"| SkipOne["跳过这个文件<br/>进 remaining 列表<br/>（继续试下一个更小的）"]
    Loop -->|"装得下"| Render["渲染 patch 文本<br/>含 '## File: name' 头部"]
    Render --> Count["精确计数<br/>raw 与 stripped 取 max"]
    Count --> Add["加入 patches<br/>累加 total_tokens"]
    Add --> Loop

    SkipOne --> Loop
    Loop -->|"全部处理完"| Verify["精确复核<br/>重算拼接后的 token 数"]
    Verify -->|"超软预算"| Prefix["对数探测找最长可装前缀<br/>（每个前缀都由 fits 亲自验证）"]
    Verify -->|"未超"| Done["输出最终 diff"]
    Prefix --> Done

    style Start fill:#C7CEEA,stroke:#8B93C9,color:#333
    style Sort fill:#E8D5F5,stroke:#BFA0D6,color:#333
    style Loop fill:#FFF9C4,stroke:#D6CF6A,color:#333
    style SkipAll fill:#FFB3C6,stroke:#D68CA5,color:#333
    style SkipOne fill:#FFB3C6,stroke:#D68CA5,color:#333
    style Render fill:#FFDAB9,stroke:#D9A87E,color:#333
    style Count fill:#FFDAB9,stroke:#D9A87E,color:#333
    style Add fill:#FFDAB9,stroke:#D9A87E,color:#333
    style Verify fill:#B5EAD7,stroke:#86C9A6,color:#333
    style Prefix fill:#B5EAD7,stroke:#86C9A6,color:#333
    style Done fill:#F5F5F5,stroke:#C0C0C0,color:#333
```

**这张图里有两个颜色编码的语义：**

- **粉色（跳过）**：文件没进上下文。分两种——粉色深浅没区别，但 `SkipOne` 和 `SkipAll` 的**后续行为完全不同**：前者继续遍历，后者直接结束。
- **绿色（复核）**：贪心累加的数字可能和真实拼接有偏差，所以最后要**重新精确计数**，超了就砍前缀。

**注意最后那个绿色框的必要性**：贪心累加时每个文件的 token 是**单独**数的，但拼起来时中间的分隔符 `
` 也要算。所以"累加值 ≤ 预算"不等于"拼接后 ≤ 预算"。绿色框就是补这个洞的。

### 3.3 关键细节：token 数不保证单调

贪心累加的 token 数在拼接时**可能不单调**。源码注释直接点明了这一点：

```python
def _find_verified_fitting_prefix_length(items, max_length: int, fits: Callable[[list], bool]) -> int:
    """Find a fitting ordered prefix with logarithmic exact-count probes.

    Token counts are not assumed to be monotone across concatenated strings. The returned prefix
    is always one that ``fits`` verified directly, although a longer fitting prefix may exist.
    """
    low = 0
    high = max_length
    while low < high:
        middle = (low + high + 1) // 2
        if fits(items[:middle]):
            low = middle
        else:
            high = middle - 1

    if low == 0 and max_length > 0 and fits(items[:1]):
        return 1
    return low
```

**三个要点：**

1. **对数探测**：二分查找，O(log n) 次精确计数，而不是 O(n) 次
2. **不假设单调**：二分只是缩小范围，**最终结果由 `fits()` 亲自验证**
3. **兜底分支**：`low == 0` 时还要专门试一下第一个——因为二分可能在"第 0 个能装下"这个边界上给出错误结论

这段代码的注释风格值得学：**它不只说"做什么"，还说"为什么不那样做"**。

### 3.4 关键细节：被过滤掉的文件要**告诉模型**

这是我认为 PR-Agent 最有价值的一个设计。

```python
FILTERED_FILES_ = "Files changed but omitted from the diff by file-type filtering:\n"
MAX_FILTERED_FILES_TO_PROMPT = 50
```

当某些文件被类型过滤器排除（自动生成的、锁文件、二进制），PR-Agent **不装作它们不存在**，而是在 prompt 里加一段：

```
Files changed but omitted from the diff by file-type filtering:
src/generated/api_client.ts
src/poetry.lock
...
```

**为什么这很重要？**

因为模型会**默认自己看到的就是全部**。如果你不告诉它"还有 12 个文件没看"，它会给出"这个 PR 的鉴权逻辑看起来没问题"这种**基于不完整信息的自信结论**。

**这是一个通用的 Harness 原则**：**你必须显式告诉模型它没看到什么，否则它会假装自己看到了全部。**

配套的还有"新增/修改/删除文件清单"，即使那些文件没进 diff 也会列出文件名——至少让模型知道**这个 PR 动了什么**。

### 3.5 预算从哪里来

`token_budget.py` 里有一整套精细的模型解析逻辑（29,189 字符），核心是 `get_max_tokens`：

```python
def get_max_tokens(model, ignore_max_model_tokens=False):
    """
    Get the maximum number of tokens allowed for a model.
    logic:
    (1) Honor a positive custom limit for Sol-tier GPT-6 models on non-native custom providers.
    (2) If the model is in './pr_agent/algo/__init__.py', use the value from there.
    (3) else if 'config.custom_model_max_tokens' is set to a positive value, use it.
    (4) Resolve a supported GPT-5.x/GPT-6 alias to its registered base-model value.
    (5) else, query LiteLLM for provider-qualified and bare alias bases before the original model.
    (6) else, raise an error.

    For all cases, we further limit the number of tokens to 'config.max_model_tokens' if it is set.
    This aims to improve the algorithmic quality, as the AI model degrades in performance when the input is too long.
    """
```

**注意最后那句话**：

> This aims to improve the algorithmic quality, as the AI model degrades in performance when the input is too long.

**这不是"能不能装下"的问题，是"装满了效果会不会变差"的问题。** 所以有一个 `config.max_model_tokens` 配置项，用户可以主动**把上限压低**，即使模型还有 200k 上下文。

这是一个很成熟的认知：**上下文窗口 ≠ 最优上下文长度**。

还有一个细节值得注意——**它同时统计 raw 和 stripped 两种形式**：

```python
def _count_raw_and_stripped_tokens(token_handler: TokenHandler, text: str) -> int:
    """Count both raw and stripped forms because either representation may be rendered."""
    token_count = token_handler.count_tokens(text)
    stripped = text.strip()
    if stripped != text:
        token_count = max(token_count, token_handler.count_tokens(stripped))
    return token_count
```

因为不同 provider 渲染 prompt 时可能 strip 空白也可能不 strip，取**两者的最大值**才是安全估计。

---

## 四、核心机制二：指纹去重——让 AI 学会闭嘴

### 4.1 问题：LLM 每次都会重新措辞

这是 AI 代码审查最 annoying 的问题。

第 1 轮，模型说："这个循环每次迭代都查一次数据库，会导致 N+1 查询问题。"

第 5 轮（你改了别的文件再 push），模型看到同样的代码，说："这段代码在循环内执行数据库查询，可能存在性能隐患，建议批量处理。"

**措辞不同，但说的是同一件事。**

传统的去重（比如"这条评论发过没有"）抓不住这个。

### 4.2 PR-Agent 的双指纹方案

`pr_agent/algo/inline_comment_dedup.py` 的模块 docstring 把整个设计说清楚了：

> Two fingerprints are computed per comment and matched with OR semantics:
>
> - **Body fingerprint**: SHA-256 over (relevant_file, anchor line, normalised body). The category/importance tag and the ``**Suggestion:**`` lead are stripped and whitespace is collapsed first. The default compares the first 80 characters; providers may compare the complete body.
> - **Code fingerprint**: SHA-256 over (relevant_file, anchor line, normalised contents of the first ```suggestion fenced block). Returns None when the body has no suggestion block, in which case matching falls back to the body fingerprint alone.
>
> The OR-match catches both "same prose, different code" and "same code, different prose" re-emissions of the same defect, which are the two ways an LLM tends to restate a finding across runs.

**OR 语义是这套设计的灵魂。** 它覆盖了 LLM 重新措辞的**两种典型模式**：

| 模式 | 正文指纹 | 代码指纹 | 命中 |
|------|---------|---------|------|
| 完全一样 | ✅ | ✅ | 两者都命中 |
| **同代码，不同措辞** | ❌ | ✅ | 代码指纹命中 |
| **同措辞，不同代码** | ✅ | ❌ | 正文指纹命中（80 字窗口内） |
| 真正的新问题 | ❌ | ❌ | 都不命中 → 发出 |

**"同措辞不同代码"这一栏需要解释**：如果 80 字符窗口里只有散文部分（代码块在窗口外），那正文指纹就能命中。这要求正文足够长——这正是 MVP 场景 5 要演示的。

### 4.3 指纹怎么算

```python
def _body_fingerprint(relevant_file: str, target_line_no, body: str, max_chars: int | None) -> str:
    normalised = _LEAD_RE.sub("", _strip_markers(body))
    normalised = _TAG_RE.sub("", normalised)
    normalised = _WS_RE.sub(" ", normalised).strip().lower()
    if max_chars is not None:
        normalised = normalised[:max_chars]
    key = f"{relevant_file}|{target_line_no}|{normalised}"
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:12]
```

三个归一化步骤，每一步都有理由：

| 步骤 | 正则 | 为什么 |
|------|------|--------|
| 剥标记 | `_strip_markers` | 已标记过的 body 要和原始 body 算出同一指纹（标记是**事后追加**的） |
| 剥标签 | `_TAG_RE` | `[performance, importance: 3]` 这类元信息不该影响身份判定 |
| 剥前导 | `_LEAD_RE` | `**Suggestion:**` 前缀是格式不是内容 |
| 折叠空白 + 小写 | `_WS_RE` + `.lower()` | 模型可能换行、缩进、大小写 |

**注意 `relevant_file` 和 `target_line_no` 都在指纹里**——同一个问题出现在不同文件/不同行，是**不同的问题**，必须能区分。

代码指纹则**故意不转小写**：

```python
def code_fingerprint(relevant_file: str, target_line_no, body: str) -> str | None:
    code = extract_suggestion_code(body)
    if not code:
        return None
    # Do not lower-case: code is case-sensitive, so case-only differences
    # must produce distinct fingerprints.
    code = _WS_RE.sub(" ", code).strip()
    ...
```

**这个注释直接点名了原因**：代码大小写敏感，`myVar` 和 `myvar` 是不同的东西。如果正文指纹那样做小写化，就会把两个真正不同的建议合并。

### 4.3.1 跨轮去重的完整闭环

```mermaid
graph TB
    subgraph Run1["第 1 轮运行"]
        🧠 LLM1["LLM 产出建议<br/>正文 + suggestion 代码块"]
        🔏 FP1["算双指纹<br/>body_fp + code_fp"]
        🏷️ MARK["正文追加 HTML 注释标记<br/>肉眼不可见"]
        📮 POST["发布到 GitHub"]
    end

    subgraph Run2["第 N 轮运行（同一个 PR）"]
        📥 FETCH["拉取已有评论"]
        🔍 SCAN["扫描正文里的标记<br/>重建 seen_body / seen_code 集合"]
        🧠 LLM2["LLM 产出新建议"]
        🔏 FP2["算双指纹"]
        MATCH{"判重<br/>body_fp 命中 OR code_fp 命中？"}
        🤐 SKIP["跳过<br/>不重复刷屏"]
        📮 SEND["追加标记并发布"]
    end

    LLM1 --> FP1 --> MARK --> POST
    POST -.->|"评论留在这里<br/>（状态即内容）"| FETCH
    FETCH --> SCAN --> MATCH
    LLM2 --> FP2 --> MATCH
    MATCH -->|"命中"| SKIP
    MATCH -->|"未命中"| SEND
    SEND -.->|"新的标记又写回评论"| FETCH

    style LLM1 fill:#E8D5F5,stroke:#BFA0D6,color:#333
    style FP1 fill:#FFDAB9,stroke:#D9A87E,color:#333
    style MARK fill:#C7CEEA,stroke:#8B93C9,color:#333
    style POST fill:#B5EAD7,stroke:#86C9A6,color:#333
    style FETCH fill:#C7CEEA,stroke:#8B93C9,color:#333
    style SCAN fill:#C7CEEA,stroke:#8B93C9,color:#333
    style LLM2 fill:#E8D5F5,stroke:#BFA0D6,color:#333
    style FP2 fill:#FFDAB9,stroke:#D9A87E,color:#333
    style MATCH fill:#FFF9C4,stroke:#D6CF6A,color:#333
    style SKIP fill:#FFB3C6,stroke:#D68CA5,color:#333
    style SEND fill:#B5EAD7,stroke:#86C9A6,color:#333
```

**这张图最重要的部分是那条虚线**：`POST --评论留在这里--> FETCH`。

**状态即内容。** 去重状态没有独立的数据库，它就住在 GitHub 上的评论正文里。这带来两个性质：

1. **自动同步**——不需要任何跨进程/跨实例的状态管理
2. **自动失效**——人删了评论，状态也就没了（这通常正是你想要的）

代价是每轮都要拉全量评论，以及只能识别**本工具**发过的评论。

### 4.4 指纹存哪里：HTML 注释标记

这是最巧妙的一步。PR-Agent **不需要数据库**——它把指纹**写进已发布的评论正文里**：

```python
def _render_marker(prefix: str, fingerprint: str, git_provider=None) -> str:
    supports_html = getattr(git_provider, "supports_html_comment_markers", lambda: True)
    if supports_html() is False:
        return f"[{prefix}: {fingerprint}]: https://github.com/The-PR-Agent/pr-agent"
    return f"<!-- {prefix}: {fingerprint} -->"
```

**GitHub / GitLab 的 HTML 注释不会渲染**——用户在界面上完全看不到，但 API 返回的原始 body 里带着它。

下次运行时，PR-Agent 扫一遍已有评论，把标记抠出来，重建"已发布指纹"集合：

```python
def marker_fingerprints(body: str) -> set:
    """All dedup-marker fingerprints embedded in one comment body."""
    found = set()
    for marker_re in _MARKER_RES:
        for match in marker_re.finditer(body or ""):
            found.update(group for group in match.groups() if group)
    return found
```

**这个设计的价值在于它把状态放在了唯一正确的地方。** 评论在 GitHub 上 → 状态就在 GitHub 上。不需要同步、不需要失效处理、GitHub 删了评论状态也就没了。

docstring 里还留了一句给未来实现者的路：

> The marker-scan store needs no external infrastructure; a different backend (database, cache) could populate the same load/seen/add interface.

### 4.5 边界处理：标记必须活着

如果评论正文太长被截断，标记可能被裁掉——那这条评论下次就挡不住了。PR-Agent 的处理是**裁正文，不裁标记**：

```python
def _append_markers(body: str, markers: str, max_chars: int | None) -> str:
    suffix = f"\n\n{markers}"
    if max_chars and len(body) + len(suffix) > max_chars:
        body = body[: max(0, max_chars - len(suffix))]
    return f"{body}{suffix}"
```

注释写得很直白：

> If max_chars is given and body + markers would exceed it, the body is clipped (never the markers) so the fingerprint marker always survives for the next run's scan.

### 4.6 为什么不存数据库？

从架构角度，这个选择有两面：

**好的一面：**
- 零基础设施
- 状态和内容同生共死（评论被删 → 状态自动消失）
- 天然支持多实例（不需要分布式锁）

**代价：**
- 每次运行都要拉全部评论（API 调用成本）
- 只能识别"本工具发过"的评论，人工评论不算
- 依赖 provider 支持读取评论 body（不支持的 provider 降级为"仅本次运行内去重"）

---

## 五、核心机制三：尺寸路由——小 PR 不该用大模型

### 5.1 规则格式

`pr_agent/algo/model_routing.py`：

```python
@dataclass
class RoutingRule:
    model: str
    max_hunks: Optional[int] = None
    max_files: Optional[int] = None
    max_patch_chars: Optional[int] = None
```

TOML 配置大概长这样：

```toml
[model_routing]
enable = true
rules = [
    { model = "gpt-4o-mini", max_hunks = 5, max_files = 3 },
    { model = "gpt-4o", max_hunks = 50, max_files = 20 },
    { model = "o3", max_hunks = 500 },
]
```

### 5.2 关键设计：路由不依赖模型的 tokenizer

```python
def count_hunks(diff_files: list[FilePatchInfo]) -> int:
    """Count the diff hunks across the files. A patch without hunk headers still counts as one."""
    total = 0
    for diff_file in diff_files:
        patch = getattr(diff_file, "patch", "") or ""
        if not patch or patch.isspace():
            continue
        # Git delimits diff lines with LF; other separators may occur in source text.
        total += (patch.count("\n@@") + patch.startswith("@@")) or 1
    return total
```

模块 docstring 说明了为什么：

> These sizes come from the provider's diff and do not depend on a model's tokenizer.

**为什么这个决定很重要？**

如果你用 token 数做路由阈值，那换模型之后所有阈值都失效了（gpt-4o 的 1000 token ≈ claude 的 800 token）。用 **hunk 数 / 文件数 / patch 字符数** 这些**与模型无关的物理量**，换模型时规则原封不动。

**这是"机制与策略分离"在另一个维度的体现**：路由规则的**语义**（多大的 PR 用什么模型）独立于**度量单位**（怎么算这个 PR 有多大）。

### 5.3 路由的边界

```python
def route_primary_model(model_type: ModelType, git_provider) -> tuple[str, str | None] | None:
    """Return the (model, deployment_id) a routing rule picks for this pull request.

    None keeps the configured primary. Only a call for the regular model is routed: a tool that
    asked for the weak or the reasoning tier made that choice deliberately. Rules are checked in
    order and the first one whose limits the pull request fits wins.
    """
```

**"Only a call for the regular model is routed"** —— 如果调用方明确选了 `model_weak` 或 `model_reasoning`，那是**刻意的选择**，路由不介入。

这个细节体现了对"策略覆盖策略"边界的尊重。

### 5.4 兜底：模型 fallback 链

路由失败（或者模型报错）时，还有一层 fallback：

```go
for i, (model, deployment_id) := range effective_chain {
    try {
        result, err := f(model)
        if err != nil {
            return nil, err
        }
    } catch e {
        if !isFallbackEligible(e) {
            return nil, err
        }
        attempt_errors = append(attempt_errors, fmt.Sprintf("%s: %T: %v", model, e, e))
        logger.Warning("Failed to generate prediction with " + model)
        if i == len(effective_chain)-1 {
            return nil, fmt.Errorf("failed to generate prediction with any model: %w", errors.Join(attemptErrors...))
        }
    }
}
```

**注意异常白名单**：`openai.APIError` / `asyncio.TimeoutError` / `FallbackEligibleError` 才触发 fallback，其他异常直接抛。

`FallbackEligibleError` 是个自定义异常，定义在 `token_budget.py`：

```python
class FallbackEligibleError(ValueError):
    """Represent a model-specific output or fit failure that another model may resolve."""
```

**"模型 A 装不下，换个模型 B 可能就装得下"** —— 这是模型 fallback 的一个合法理由，但必须**显式声明**，不能把所有异常都吞掉换成下一个模型（那会掩盖真正的 bug）。

---

## 六、核心机制四：失败也要给出人话

一个容易被忽略但很影响体验的设计。

`_REVIEW_FAILURE_REASONS` 是一个**白名单表**：

```python
_REVIEW_FAILURE_REASONS = (
    (
        ("credit balance is too low", "insufficient credits", "insufficient_balance", "insufficient_quota"),
        "The model provider rejected the request because the API account has insufficient credits. "
        "Add credits, then retry the command.",
    ),
    (
        ("authenticationerror", "authentication error", "invalid api key", "invalid x-api-key"),
        "PR-Agent could not authenticate with the model provider. Check the configured API credentials, then retry.",
    ),
    (
        ("ratelimiterror", "rate limit", "too many requests"),
        "The model provider rate-limited the request. Wait for the limit to reset, then retry.",
    ),
    (
        ("context_length_exceeded", "maximum context length", "input is too long", "too many tokens"),
        "The pull request exceeded the selected model's context limit. Retry with a larger-context model or an "
        "incremental review.",
    ),
    ...
)
```

**为什么是白名单而不是直接把异常贴出去？**

因为异常原文里可能含：API key 的片段、内部 URL、provider 的账户信息。所以 PR-Agent 只匹配**已知模式**，映射到一段**人写的、绝对安全的**说明。

而且默认行为是**什么都不说**：

```python
def _review_failure_comment(error: Exception) -> str:
    """Build an optional deterministic failure explanation from an allowlist of safe messages."""
    if not _as_bool(get_settings().pr_reviewer.get("publish_error_details", False)):
        return "Failed to review PR"
```

**默认只发 "Failed to review PR"**。要发详细原因必须显式开 `publish_error_details`。

这是一个**默认安全**的设计——大多数开源项目会默认把完整 traceback 贴到公开评论里，那是个信息泄露。

---

## 七、横向对比：三种不同的"AI 审查"路线

### 7.1 对比一：PR-Agent vs OpenCodeReview（阿里）

| 维度 | PR-Agent | OpenCodeReview（阿里） |
|------|----------|----------------------|
| **核心主张** | **单次 LLM 调用**的轻量审查器 | **Deterministic × Agent** 混合架构 |
| **谁来跑** | GitHub Action / CLI / Webhook | 独立服务 + Git 平台集成 |
| **规则** | YAML/JSON prompt 配置（模型侧） | **确定性规则先行**，Agent 只处理模糊部分 |
| **上下文管理** | **装箱 + 预算 + 明确告知被过滤的文件** | 自研上下文管理 |
| **跨轮状态** | **评论里的 HTML 注释标记**（零基础设施） | 自有存储 |
| **模型调用** | 1 次 | 多次（Agent 循环） |
| **能力边界** | 明确克制 | 能力更强但更重 |

**最本质的差异是"确定性 vs 模型"的分工位置**：

- PR-Agent 的规则基本都在 **prompt 里**（交给模型）
- OpenCodeReview 把一部分规则做成**确定性代码**（不交给模型）

如果你要"高准确率、可审计"——OpenCodeReview 路线更对。
如果你要"5 分钟部署、零维护、跑起来就有用"——PR-Agent 更对。

### 7.2 对比二：PR-Agent vs Codecov / SonarQube

| 维度 | PR-Agent | Codecov / SonarQube |
|------|----------|---------------------|
| **检查类型** | **语义质量**：逻辑、风格、一致性 | **规则合规**：覆盖率、重复率、静态扫描 |
| **确定性** | 模型输出，非确定性 | 完全确定 |
| **误报** | 有（模型会误判） | 少（规则明确） |
| **能理解意图** | ✅ | ❌ |
| **成本** | 每次一次 LLM 调用 | 订阅制 / 扫描器 |

**两者不是替代关系。** Codecov 告诉你"这行没被覆盖"，PR-Agent 告诉你"这个重试逻辑吞掉了异常"。

**最理想的组合**：先跑确定性检查（便宜、必过），再跑 PR-Agent（贵、锦上添花）。

### 7.3 对比三：PR-Agent vs 一个"从零写"的 200 行脚本

这是我觉得最值得对比的一组。

假设你要做一个内部专用的 PR 审查 bot。你会写什么？

```python
# 大多数人会写的版本
diff = get_diff(pr_url)
if len(diff) > 30000:
    diff = diff[:30000]           # 截断
prompt = f"Review this diff:\n{diff}"
result = llm.complete(prompt)
post_comment(pr_url, result)
```

**这个版本有 4 个问题：**

| # | 问题 | 后果 |
|---|------|------|
| 1 | 硬截断 | 模型不知道后面还有内容，会给出"看起来很完整"的错误结论 |
| 2 | 无预算概念 | 没算 prompt token，可能直接超上下文报错 |
| 3 | 无跨轮去重 | 每次 push 都刷一遍同样的评论 |
| 4 | 无失败分类 | provider 报错就贴 traceback |

**PR-Agent 用三个机制对应解决**：

| PR-Agent 机制 | 对应上面第几条 |
|---------------|--------------|
| 装箱 + 明确告知被过滤的文件 | #1 |
| `token_budget.py` + `max_model_tokens` | #2 |
| 双指纹 OR 语义去重 | #3 |
| `_REVIEW_FAILURE_REASONS` 白名单 | #4 |

**这就是为什么"用现成方案"和"照着思路自己写"是两回事。** PR-Agent 的价值不在代码量（729 个文件），在于**它把这四个坑都踩过了**。

---

## 八、优缺点

### 8.1 左侧

**架构简洁性 —— 良好。**

好的一面：
- GitProvider / BaseAiHandler 两个抽象层足够承载 8 个 Git 平台 + 4 种 AI 后端
- 工具层每个 tool 一个文件，互不干扰
- 预算、去重、路由三个机制**互相独立**，各自可单测

扣分的地方：
- `pr_reviewer.py` 单文件 **91,563 字符**，职责明显超载
- `utils.py` **85,600 字符**，塞了 YAML 解析、Markdown 转换、suggestion 提取等一堆不相关的东西
- `algo/` 34 个模块，但没有一张架构图说明它们的依赖关系

**扩展性 —— 优秀。**

加一个新 Git 平台：实现 `GitProvider` 的相关方法即可（基类有默认实现兜底）。
加一个新 AI 后端：实现 `BaseAiHandler` 的 4 个方法。
加一个新工具：继承 `BaseTool`，实现 `run()`。

**易用性 —— 优秀。**

**5 行 YAML 就能接入**：

```yaml
# .github/workflows/pr-agent.yml
name: PR Agent
on:
  pull_request:
    types: [opened, synchronize]
jobs:
  pr_agent_job:
    runs-on: ubuntu-latest
    steps:
    - name: PR Agent action step
      uses: the-pr-agent/pr-agent@main
      env:
        OPENAI_KEY: $&#123;&#123; secrets.OPENAI_KEY &#125;&#125;
        GITHUB_TOKEN: $&#123;&#123; secrets.GITHUB_TOKEN &#125;&#125;
```

扣分：
- 配置项多（TOML + 环境变量 + CLI 参数三套），第一次配容易懵
- LiteLLM 作为唯一模型入口，引入了一层抽象成本
- 文档分散在 `docs.pr-agent.ai` 和仓库 README 两处

### 8.2 右侧

**性能 —— 良好。**

- 单次 LLM 调用，~30 秒
- Token 计数走 tiktoken 本地编码器（`o200k_base`），不发网络请求
- Provider 原生 token 计数 API 走 `litellm.acount_tokens`（对 Anthropic / Gemini / Azure 等更准）
- 大 PR 用 `large_pr_handling` 模式分多轮调用（`max_ai_calls` 默认 4）

**有一个细节值得称道**——tiktoken 的编码文件下载问题：

```python
def _use_bundled_tiktoken_files() -> None:
    """Point tiktoken at LiteLLM's bundled encoding files unless the host chose a cache directory.

    LiteLLM only does this once its encoding module is imported, so tiktoken could otherwise download.
    """
```

**tiktoken 第一次用会去下载编码文件**——在 CI 环境里这可能失败或很慢。PR-Agent 直接指向 LiteLLM 已经打包好的编码文件，**零网络**。

**复杂度 —— 中等。**

729 个文件，Python 实现，比 Go 项目轻。但三大机制（装箱 / 指纹 / 路由）叠在一起，配置项也不少。

**维护性 —— 良好。**

- 2023 年至今持续维护，49 个 open issue（对比 AO 的 822 个）
- 每个机制都有对应的 unittest（`tests/unittest/test_compressed_diff_token_sort.py` 等）
- 注释密度高且写"为什么"
- **社区所有**（Qodo 捐赠后由 `The-PR-Agent` 组织维护）

扣分：
- 迁移 Docker namespace（`codiumai/` → `pragent/`）这类运维变更会打断老用户
- `/help_docs` 因为凭证泄露问题（issue #2445）被临时禁用——说明安全审查有时是滞后的

---

## 九、从零搭建启示：如果你要做一个 PR 审查 bot

### 9.1 最小可行实现

**必须做的（4 件）：**

| # | 组件 | 最小实现 | 工作量 |
|---|------|---------|--------|
| 1 | **预算感知** | 算 prompt token，留出输出余量 | 半天 |
| 2 | **装箱** | 按文件大小降序 + 软硬双预算 | 1 天 |
| 3 | **告知被过滤的文件** | 在 prompt 里加一段"这些文件没看" | 1 小时 |
| 4 | **跨轮去重** | 指纹 + 存在评论正文里 | 2 天 |

**可以先省略的：**

| # | 组件 | 何时需要补 |
|---|------|-----------|
| 1 | 尺寸路由 | token 账单开始肉疼时 |
| 2 | 模型 fallback 链 | provider 稳定性要求高时 |
| 3 | 失败原因白名单 | 有人在半夜看 CI 日志时 |
| 4 | repo_context 注入 | 审查需要项目约定（编码规范、架构文档）时 |

**第 3 件是最容易被忽略、但收益最高的。** 一个模型没看到的文件清单，比任何 prompt 技巧都更能提升审查可信度。

### 9.2 四个最容易踩的坑

**坑 1：截断 diff。**

```python
# ❌ 灾难
diff = diff[:30000]
```

正确做法是装箱 + 明确告知。

**坑 2：用 token 数做路由阈值。**

换模型就全失效了。用 hunk 数 / 文件数 / patch 字符数。

**坑 3：去重只比"正文完全一样"。**

LLM 每次都会重新措辞。必须双指纹 OR 语义。

**坑 4：正文超长时把标记一起裁掉。**

标记是跨轮去重的**唯一载体**，裁掉它等于这条评论下次必然重复。**裁正文，永不裁标记。**

### 9.3 一个额外的建议：让模型知道"这条建议值不值得提"

PR-Agent 在 `repo_context` 里支持注入项目级的指令文件（`repo_context_files`）：

```python
INSTRUCTION_FILES_INTRO = (
    "You are being given instruction files. Follow them as project-specific guidance when reviewing code."
)
```

**这实际上是在做 Rule 组件的活**——把"这个项目的审查标准"变成模型上下文的一部分。

如果你的项目有特殊约定（比如"禁止直接用 `except Exception`"、"所有 DB 查询必须走 repository 层"），写进指令文件，比事后在评论里跟模型争论有效得多。

### 9.4 检查清单

如果你决定动手：

- [ ] **先做装箱，再做 prompt**。装箱决定了模型能看到什么，比 prompt 措辞重要得多
- [ ] **软预算 = 继续，硬预算 = 停止**。两个阈值的语义要分开
- [ ] **token 数不假设单调**。二分后必须由精确计数验证
- [ ] **被过滤的文件清单要进 prompt**，并按重要性排序（自动生成的文件排后面）
- [ ] **指纹包含文件路径 + 行号**，否则同一段代码在不同位置会误判
- [ ] **代码指纹不转小写**
- [ ] **指纹只 12 位 hex 就够**（48 bit），嵌入 HTML 注释不影响用户阅读
- [ ] **裁正文不裁标记**
- [ ] **路由阈值用与模型无关的物理量**
- [ ] **失败信息走白名单**，默认不公开详细原因

### 9.5 一句话总结

> **PR-Agent 的可复用性不在它的 729 个文件，而在它的三条约束：装箱而不是截断、双指纹而不是单指纹、路由用物理量而不是 token。**

这三条与语言无关，与框架无关。你用 TypeScript 也能实现。

---

## 十、总结与行动建议

PR-Agent 值得学的地方，是它**清楚地知道自己该管什么、不该管什么**。

它不做多步 agent 编排，不做 IDE 集成，不做记忆系统，不做 prompt 平台。它只做一件事：**让一次 LLM 调用尽可能地看到正确的上下文，并且不要重复说同一句话**。

而这三件事，恰好是所有"把 LLM 接进 CI"的场景都会撞上的。

如果你正在给团队接 AI 审查，**今天就能抄的三件事**：

1. **把 diff 截断改成装箱**。按文件大小降序，软预算跳过、硬预算停止。这一条改完，你的审查覆盖率会有肉眼可见的提升。
2. **在 prompt 里加一句"这些文件没看"**。模型默认以为自己看到的就是全部——你不告诉它，它就会假装。
3. **去重改成双指纹 OR 语义**。正文指纹抓"同措辞"，代码指纹抓"同代码"，两者任一命中就跳过。

**最后一句建议**：如果你只有一个 PR 和一个模型，先用 100 行把"预算 + 装箱"做对。**在没有装箱的审查工具里加十个检查规则，效果远不如先把装箱做对。**

因为模型看到什么，决定了它能说什么。

---

## 附：200+ 行 Python MVP 复刻

下面这份代码把文章里的三个核心机制抽出来，**无外部依赖**（不用 tiktoken / LiteLLM / 任何 Git API），你可以直接复制运行：

````python
#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
从 The-PR-Agent/pr-agent 抽离的核心机制复刻（Python MVP）

抽离的三个原语：
  1. PR 压缩打包器：最大文件优先的贪心装箱 + 软/硬双预算 + 对数前缀验证
     —— 来源：pr_agent/algo/pr_processing.py 的
        pr_generate_compressed_diff / generate_full_patch / _find_verified_fitting_prefix_length
  2. 行内评论跨轮去重：正文指纹 + 代码指纹的 OR 语义匹配
     —— 来源：pr_agent/algo/inline_comment_dedup.py
  3. 尺寸路由：小 PR 走便宜模型，大 PR 走贵模型
     —— 来源：pr_agent/algo/model_routing.py

运行：python3 pr_agent_mvp.py
无外部依赖，纯标准库。
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from typing import Optional


# ============================================================
# 第 1 部分：Token 计数（用字符数近似，真实实现用 tiktoken）
# ============================================================

def count_tokens(text: str) -> int:
    """近似 token 数。真实 PR-Agent 用 tiktoken 的 o200k_base 编码器。

    这里用 "4 字符 ≈ 1 token" 的经验值，够演示装箱算法。
    """
    return max(1, (len(text) + 3) // 4) if text else 0


# ============================================================
# 第 2 部分：PR 压缩打包器（最大文件优先贪心装箱）
# ============================================================

@dataclass
class FilePatch:
    filename: str
    patch: str
    tokens: int = 0
    edit_type: str = "modified"   # added / modified / deleted

    def __post_init__(self):
        if not self.tokens:
            self.tokens = count_tokens(self.patch)


@dataclass
class PackResult:
    included: list[FilePatch] = field(default_factory=list)
    remaining: list[str] = field(default_factory=list)
    deleted: list[str] = field(default_factory=list)
    total_tokens: int = 0


def find_verified_fitting_prefix_length(items, max_length: int, fits) -> int:
    """用对数次探测找出能装下的最长前缀。

    关键点：token 数在拼接时**不保证单调**，所以不能直接二分后信任结果，
    必须由 fits() 亲自验证每一个返回的前缀。

    —— 来源：pr_processing.py 的 _find_verified_fitting_prefix_length
    """
    low = 0
    high = max_length
    while low < high:
        middle = (low + high + 1) // 2
        if fits(items[:middle]):
            low = middle
        else:
            high = middle - 1

    # 兜底：即使二分返回 0，也要亲自验证第一个能不能装下
    if low == 0 and max_length > 0 and fits(items[:1]):
        return 1
    return low


def pack_patches(files: list[FilePatch],
                 soft_budget: int,
                 hard_budget: int,
                 prompt_tokens: int = 0) -> PackResult:
    """按"最大文件优先"贪心装箱到软预算内。

    软预算 = 理想情况下能塞多少
    硬预算 = 绝对不能超过（超过就整个文件跳过）

    —— 来源：pr_processing.py 的 generate_full_patch
    """
    result = PackResult()
    # 1) 排序：按 token 数从大到小。这是压缩策略的核心 —— 大文件优先，
    #    否则一堆小文件会把预算吃光，大文件一个都进不去。
    sorted_files = sorted(files, key=lambda f: f.tokens, reverse=True)

    # 2) 渲染后的实际 token 数（含 "## File: 'xxx'" 头部 + 分隔符）
    rendered: list[tuple[FilePatch, str, int]] = []
    for f in sorted_files:
        rendered_patch = f"\n\n## File: '{f.filename.strip()}'\n\n{f.patch.strip()}\n"
        rendered.append((f, rendered_patch, count_tokens(rendered_patch)))

    separator_tokens = count_tokens("\n")
    total = prompt_tokens
    chosen: list[tuple[FilePatch, str]] = []

    for f, patch_final, patch_tokens in rendered:
        # 硬预算：已经超了，后面的文件全部跳过
        if total - prompt_tokens > hard_budget:
            result.remaining.append(f.filename)
            continue
        rendered_tokens = patch_tokens + (separator_tokens if chosen else 0)
        # 软预算：装不下就跳过这个文件（不是停止，是继续试下一个更小的）
        if total + rendered_tokens > prompt_tokens + soft_budget:
            result.remaining.append(f.filename)
            continue
        chosen.append((f, patch_final))
        total += rendered_tokens

    # 3) 精确复核：贪心累加可能因为分隔符/空白与真实拼接计数有偏差。
    #    这里用真正的拼接文本重新数一遍，超了就砍到能装下的最长前缀。
    def count_prefix(prefix) -> int:
        return prompt_tokens + count_tokens("\n".join(p for _, p in prefix))

    if chosen:
        exact = count_prefix(chosen)
        if exact - prompt_tokens > soft_budget:
            best = find_verified_fitting_prefix_length(
                chosen, len(chosen) - 1,
                lambda prefix: count_prefix(prefix) - prompt_tokens <= soft_budget,
            )
            for f, _ in chosen[best:]:
                result.remaining.append(f.filename)
            chosen = chosen[:best]
            total = count_prefix(chosen) if chosen else prompt_tokens

    result.included = [f for f, _ in chosen]
    result.total_tokens = total
    return result


# ============================================================
# 第 3 部分：行内评论跨轮去重（正文指纹 + 代码指纹 OR 匹配）
# ============================================================

_MARKER_URL = "https://github.com/The-PR-Agent/pr-agent"
_LEAD_RE = re.compile(r"^\*\*Suggestion:\*\*\s*", re.IGNORECASE)
_TAG_RE = re.compile(r"\[[^\]]+?,\s*importance:\s*\d+\]", re.IGNORECASE)
_WS_RE = re.compile(r"\s+")
_SUGGESTION_RE = re.compile(r"(?<!`)(`{3,})suggestion\n(.*?)(?<!`)\1", re.DOTALL)

BODY_MARKER_RE = re.compile(r"<!-- pr-agent-dedup: ([a-f0-9]{12}) -->")
CODE_MARKER_RE = re.compile(r"<!-- pr-agent-dedup-code: ([a-f0-9]{12}) -->")


def strip_markers(body: str) -> str:
    """剥掉已嵌入的指纹标记，让"标记过的 body"和"原始 body"算出同一指纹。"""
    body = BODY_MARKER_RE.sub("", body or "")
    body = CODE_MARKER_RE.sub("", body)
    return body


def extract_suggestion_code(body: str) -> Optional[str]:
    """提取 suggestion 代码块的内容。"""
    body = strip_markers(body)
    m = _SUGGESTION_RE.search(body)
    if m:
        return m.group(2).strip("\n")
    return None


def body_fingerprint(relevant_file: str, target_line, body: str, max_chars: int = 80) -> str:
    """正文指纹：SHA-256(文件 | 行号 | 归一化正文)[:12]

    归一化会剥掉 category/importance 标签和 "**Suggestion:**" 前导，
    并把连续空白折叠成一个空格。
    """
    normalised = _LEAD_RE.sub("", strip_markers(body))
    normalised = _TAG_RE.sub("", normalised)
    normalised = _WS_RE.sub(" ", normalised).strip().lower()
    if max_chars is not None:
        normalised = normalised[:max_chars]
    key = f"{relevant_file}|{target_line}|{normalised}"
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:12]


def code_fingerprint(relevant_file: str, target_line, body: str) -> Optional[str]:
    """代码指纹：SHA-256(文件 | 行号 | 'code' | 归一化代码)[:12]

    ⚠️ 代码**不能**转小写 —— 代码大小写敏感，
    只有大小写不同的两段代码必须算出不同指纹。
    没有 suggestion 块时返回 None。
    """
    code = extract_suggestion_code(body)
    if not code:
        return None
    code = _WS_RE.sub(" ", code).strip()
    if not code:
        return None
    key = f"{relevant_file}|{target_line}|code|{code}"
    return hashlib.sha256(key.encode("utf-8")).hexdigest()[:12]


def is_duplicate(relevant_file: str,
                 target_line,
                 body: str,
                 seen_body: set[str],
                 seen_code: set[str]) -> bool:
    """OR 语义匹配：正文指纹命中 OR 代码指纹命中 => 判为重复。

    —— 来源：inline_comment_dedup.py 的模块 docstring
    """
    bf = body_fingerprint(relevant_file, target_line, body)
    if bf in seen_body:
        return True
    cf = code_fingerprint(relevant_file, target_line, body)
    if cf is not None and cf in seen_code:
        return True
    return False


def build_markers(body_fp: str, code_fp: Optional[str]) -> str:
    """生成嵌入正文的 HTML 注释标记（GitHub 不渲染 HTML 注释，肉眼不可见）。"""
    markers = [f"<!-- pr-agent-dedup: {body_fp} -->"]
    if code_fp is not None:
        markers.append(f"<!-- pr-agent-dedup-code: {code_fp} -->")
    return "\n".join(markers)


def body_with_markers(body: str, body_fp: str, code_fp: Optional[str],
                      max_chars: Optional[int] = None) -> str:
    """追加标记；如果超长，**裁剪正文而不是裁剪标记** —— 标记必须活着。"""
    suffix = f"\n\n{build_markers(body_fp, code_fp)}"
    if max_chars and len(body) + len(suffix) > max_chars:
        body = body[: max(0, max_chars - len(suffix))]
    return f"{body}{suffix}"


def scan_existing_markers(bodies: list[str]) -> tuple[set[str], set[str]]:
    """扫描已存在的评论正文，重建已发布过的指纹集合。"""
    seen_body: set[str] = set()
    seen_code: set[str] = set()
    for b in bodies:
        for m in BODY_MARKER_RE.finditer(b or ""):
            seen_body.add(m.group(1))
        for m in CODE_MARKER_RE.finditer(b or ""):
            seen_code.add(m.group(1))
    return seen_body, seen_code


# ============================================================
# 第 4 部分：尺寸路由（小 PR 走便宜模型）
# ============================================================

@dataclass
class RoutingRule:
    model: str
    max_hunks: Optional[int] = None
    max_files: Optional[int] = None
    max_patch_chars: Optional[int] = None


def count_hunks(files: list[FilePatch]) -> int:
    """统计 diff hunk 数。没有 hunk 头的 patch 也算 1 个。"""
    total = 0
    for f in files:
        patch = f.patch or ""
        if not patch or patch.isspace():
            continue
        total += (patch.count("\n@@") + patch.startswith("@@")) or 1
    return total


def route_primary_model(rules: list[RoutingRule], files: list[FilePatch]) -> Optional[str]:
    """按顺序检查规则，第一条"装得下"的规则获胜。都不匹配则保持默认主模型。

    注意：hunk 数 / 文件数 / patch 字符数都来自 provider 的 diff，
    **不依赖任何模型的 tokenizer** —— 这样规则在换模型时依然有效。
    """
    num_files = len(files)
    num_hunks = count_hunks(files)
    num_patch_chars = sum(len(f.patch) for f in files)

    for rule in rules:
        if rule.max_files is not None and num_files > rule.max_files:
            continue
        if rule.max_patch_chars is not None and num_patch_chars > rule.max_patch_chars:
            continue
        if rule.max_hunks is not None and num_hunks > rule.max_hunks:
            continue
        return rule.model
    return None


# ============================================================
# 第 5 部分：演示
# ============================================================

def banner(title: str):
    print()
    print("=" * 74)
    print(f"  {title}")
    print("=" * 74)


def main():
    banner("场景 1：PR 压缩装箱 —— 大文件优先 + 软预算")
    files = [
        FilePatch("src/huge_module.py", "x = 1\n" * 300, edit_type="modified"),
        FilePatch("src/medium.py", "y = 2\n" * 60),
        FilePatch("src/tiny.py", "z = 3\n" * 5),
        FilePatch("src/tiny2.py", "w = 4\n" * 4),
    ]
    print(f"  原始文件数: {len(files)}")
    print(f"  各文件 token: " + ", ".join(f"{f.filename.split('/')[-1]}={f.tokens}" for f in files))
    res = pack_patches(files, soft_budget=120, hard_budget=200, prompt_tokens=20)
    print(f"  软预算=120 硬预算=200 -> 装入 {len(res.included)} 个: "
          + ", ".join(f.filename.split('/')[-1] for f in res.included))
    print(f"  剩余（未处理）: {[f.split('/')[-1] for f in res.remaining]}")
    print(f"  总 token: {res.total_tokens} (含 prompt 20)")
    assert res.total_tokens - 20 <= 120, "超出软预算"
    # huge_module(450 token) 本身超过软预算，任何排序都装不进去；
    # 但它必须被**先试**（先跳过它，才轮到 medium）。
    assert "src/huge_module.py" in res.remaining, "超预算的大文件应被跳过"
    # 真正装进去的是"能装下的最大文件"
    assert "src/medium.py" in [f.filename for f in res.included], "能装下的最大文件应被装入"

    banner("场景 1b：软预算=600 时，超大文件应被优先装入")
    res_big = pack_patches(files, soft_budget=600, hard_budget=700, prompt_tokens=20)
    print(f"  软预算=600 -> 装入: " + ", ".join(f.filename.split('/')[-1] for f in res_big.included))
    print(f"  总 token: {res_big.total_tokens}")
    assert res_big.included[0].filename == "src/huge_module.py", "大文件应排在最前"
    assert res_big.total_tokens - 20 <= 600

    banner("场景 2：对比 —— 如果不按大小排序会怎样")
    # 构造一批"小而多"的文件 vs 一个"大而重要"的文件。
    # 关键：给核心文件起一个**字典序靠后**的名字（src/zz_core.py），
    # 这样"按文件名顺序"会先被 40 个 util 文件吃光预算。
    many_small = [FilePatch(f"src/util_{i}.py", "a = 1\n" * 3) for i in range(40)]
    one_big = FilePatch("src/zz_core_engine.py", "b = 2\n" * 40)
    allf = many_small + [one_big]

    def pack_sorted(files, budget):
        r = pack_patches(files, soft_budget=budget, hard_budget=budget + 50, prompt_tokens=10)
        return [f.filename.split("/")[-1] for f in r.included]

    budget = 100
    # 朴素做法：按文件名顺序，边装边累加预算，装不下就跳过
    naive: list[str] = []
    naive_total = 10
    for f in sorted(allf, key=lambda x: x.filename):
        t = count_tokens(f"\n\n## File: '{f.filename}'\n\n{f.patch.strip()}\n")
        if naive_total + t <= budget:
            naive.append(f.filename.split("/")[-1])
            naive_total += t
    smart = pack_sorted(allf, budget=budget)
    print(f"  41 个文件（40 个 util + 1 个 zz_core_engine.py）, 预算 {budget} token")
    print(f"  按文件名顺序装入 {len(naive)} 个 -> {naive[:6]} ...")
    print(f"  按 token 降序装入 {len(smart)} 个 -> {smart[:6]} ...")
    print("  -> 40 个 util 文件把预算吃光，zz_core_engine.py 一个都进不去；")
    print("     大文件优先保证**最重要的改动**一定被审查。")
    assert "zz_core_engine.py" in smart, "大文件优先必须装入核心文件"
    assert "zz_core_engine.py" not in naive, "文件名顺序会漏掉核心文件"

    banner("场景 3：行内评论去重 —— 同一段正文重复发出")
    body1 = ("[performance, importance: 3] **Suggestion:** This loop re-queries the DB each iteration.\n"
             "```suggestion\nfor row in batch:\n    process(row)\n```")
    bf = body_fingerprint("src/app.py", 42, body1)
    cf = code_fingerprint("src/app.py", 42, body1)
    print(f"  正文指纹: {bf}")
    print(f"  代码指纹: {cf}")
    posted = body_with_markers(body1, bf, cf)
    seen_body, seen_code = scan_existing_markers([posted])
    print(f"  第 1 轮发出 -> 已发布指纹集合: body={seen_body}, code={seen_code}")
    dup = is_duplicate("src/app.py", 42, body1, seen_body, seen_code)
    print(f"  第 2 轮同样内容 -> is_duplicate = {dup}")
    assert dup is True

    banner("场景 4：同代码不同措辞 —— 代码指纹命中（OR 语义）")
    body2 = ("[style, importance: 2] **Suggestion:** Consider batching this query.\n"
             "```suggestion\nfor row in batch:\n    process(row)\n```")
    bf2 = body_fingerprint("src/app.py", 42, body2)
    cf2 = code_fingerprint("src/app.py", 42, body2)
    print(f"  新正文指纹: {bf2}  (与旧的 {bf} 不同)")
    print(f"  新代码指纹: {cf2}  (与旧的 {cf} 相同)")
    dup2 = is_duplicate("src/app.py", 42, body2, seen_body, seen_code)
    print(f"  is_duplicate = {dup2}  <- 正文不匹配，但代码匹配 => 仍然判重")
    assert dup2 is True

    banner("场景 5：同措辞不同代码 —— 正文指纹命中")
    # 关键细节：正文指纹默认只比较**前 80 个字符**。
    # 所以要让代码块落在 80 字符窗口**之外**，正文必须足够长。
    long_prose = ("This loop re-queries the database on every single iteration, which causes "
                  "an N+1 query problem in production")
    body3 = (f"[performance, importance: 3] **Suggestion:** {long_prose}\n"
             "```suggestion\nwhile cursor:\n    fetch(cursor)\n```")
    body1_long = (f"[performance, importance: 3] **Suggestion:** {long_prose}\n"
                  "```suggestion\nfor row in batch:\n    process(row)\n```")
    bf3 = body_fingerprint("src/app.py", 42, body3)
    cf3 = code_fingerprint("src/app.py", 42, body3)
    bf1_long = body_fingerprint("src/app.py", 42, body1_long)
    cf1_long = code_fingerprint("src/app.py", 42, body1_long)
    print(f"  正文指纹(新, 80字窗口内不含代码块): {bf3}")
    print(f"  正文指纹(旧, 同措辞)              : {bf1_long}")
    print(f"  代码指纹(新): {cf3}  (与旧的 {cf} 不同)")
    # 先把旧的长正文评论发布出去
    posted_long = body_with_markers(body1_long, bf1_long, cf1_long)
    sb_long, sc_long = scan_existing_markers([posted, posted_long])
    dup3 = is_duplicate("src/app.py", 42, body3, sb_long, sc_long)
    print(f"  is_duplicate = {dup3}  <- 代码不匹配，但正文匹配 => 仍然判重")
    assert dup3 is True

    banner("场景 6：真正的不同问题 —— 不判重")
    body4 = ("[security, importance: 5] **Suggestion:** SQL built by string concatenation.\n"
             "```suggestion\ncur.execute(\"SELECT * FROM t WHERE id = %s\", (id,))\n```")
    dup4 = is_duplicate("src/app.py", 42, body4, seen_body, seen_code)
    print(f"  is_duplicate = {dup4}")
    assert dup4 is False

    banner("场景 7：代码大小写敏感 —— 只有大小写不同必须算出不同指纹")
    body_a = "```suggestion\nvalue = myVar\n```"
    body_b = "```suggestion\nvalue = myvar\n```"
    fa = code_fingerprint("src/a.py", 1, body_a)
    fb = code_fingerprint("src/a.py", 1, body_b)
    print(f"  myVar -> {fa}")
    print(f"  myvar -> {fb}")
    assert fa != fb, "代码指纹不能转小写"

    banner("场景 8：跨轮恢复 —— 只靠已发布评论里的标记重建状态")
    posted2 = body_with_markers(body4, body_fingerprint("src/app.py", 42, body4),
                                 code_fingerprint("src/app.py", 42, body4))
    sb2, sc2 = scan_existing_markers([posted, posted2])
    print(f"  扫描 2 条已发布评论 -> body 指纹 {len(sb2)} 个, code 指纹 {len(sc2)} 个")
    print(f"  原来的 body4 现在判重 = {is_duplicate('src/app.py', 42, body4, sb2, sc2)}")
    assert is_duplicate("src/app.py", 42, body4, sb2, sc2) is True

    banner("场景 9：尺寸路由 —— 小 PR 走便宜模型")
    small = [FilePatch("a.py", "@@ hunk\n" * 2), FilePatch("b.py", "@@ hunk\n" * 1)]
    big = [FilePatch(f"f{i}.py", "@@ hunk\n" * 40) for i in range(12)]
    rules = [
        RoutingRule("gpt-4o-mini", max_hunks=5, max_files=3),
        RoutingRule("gpt-4o", max_hunks=50, max_files=20),
        RoutingRule("o3", max_hunks=500),
    ]
    r_small = route_primary_model(rules, small)
    r_big = route_primary_model(rules, big)
    print(f"  小 PR ({count_hunks(small)} hunks, {len(small)} files) -> {r_small}")
    print(f"  大 PR ({count_hunks(big)} hunks, {len(big)} files) -> {r_big}")
    assert r_small == "gpt-4o-mini"
    # 480 hunks > gpt-4o 的 50 上限，落到 o3（上限 500）
    assert r_big == "o3"
    # 再来一个超大 PR：所有规则都不匹配 -> 保持默认主模型（返回 None）
    huge = [FilePatch(f"g{i}.py", "@@ hunk\n" * 200) for i in range(20)]
    r_huge = route_primary_model(rules, huge)
    print(f"  超大 PR ({count_hunks(huge)} hunks, {len(huge)} files) -> {r_huge} (None = 保持默认主模型)")
    assert r_huge is None

    banner("全部断言通过 ✅")
    print("  演示了 4 个可运行机制：")
    print("   1. 最大文件优先的贪心装箱 + 软/硬双预算 + 对数前缀验证")
    print("   2. 行内评论跨轮去重（正文指纹 OR 代码指纹）")
    print("   3. 代码指纹的大小写敏感性保证")
    print("   4. 尺寸路由（小 PR 走便宜模型）")


if __name__ == "__main__":
    main()
````

### 运行结果（实际执行输出）

```text

==========================================================================
  场景 1：PR 压缩装箱 —— 大文件优先 + 软预算
==========================================================================
  原始文件数: 4
  各文件 token: huge_module.py=450, medium.py=90, tiny.py=8, tiny2.py=6
  软预算=120 硬预算=200 -> 装入 2 个: medium.py, tiny.py
  剩余（未处理）: ['huge_module.py', 'tiny2.py']
  总 token: 132 (含 prompt 20)

==========================================================================
  场景 1b：软预算=600 时，超大文件应被优先装入
==========================================================================
  软预算=600 -> 装入: huge_module.py, medium.py, tiny.py, tiny2.py
  总 token: 606

==========================================================================
  场景 2：对比 —— 如果不按大小排序会怎样
==========================================================================
  41 个文件（40 个 util + 1 个 zz_core_engine.py）, 预算 100 token
  按文件名顺序装入 7 个 -> ['util_0.py', 'util_1.py', 'util_10.py', 'util_11.py', 'util_12.py', 'util_13.py'] ...
  按 token 降序装入 3 个 -> ['zz_core_engine.py', 'util_0.py', 'util_1.py'] ...
  -> 40 个 util 文件把预算吃光，zz_core_engine.py 一个都进不去；
     大文件优先保证**最重要的改动**一定被审查。

==========================================================================
  场景 3：行内评论去重 —— 同一段正文重复发出
==========================================================================
  正文指纹: 87dfb4ac6c4f
  代码指纹: b383fd41a9e0
  第 1 轮发出 -> 已发布指纹集合: body={'87dfb4ac6c4f'}, code={'b383fd41a9e0'}
  第 2 轮同样内容 -> is_duplicate = True

==========================================================================
  场景 4：同代码不同措辞 —— 代码指纹命中（OR 语义）
==========================================================================
  新正文指纹: a7a400dfa7fe  (与旧的 87dfb4ac6c4f 不同)
  新代码指纹: b383fd41a9e0  (与旧的 b383fd41a9e0 相同)
  is_duplicate = True  <- 正文不匹配，但代码匹配 => 仍然判重

==========================================================================
  场景 5：同措辞不同代码 —— 正文指纹命中
==========================================================================
  正文指纹(新, 80字窗口内不含代码块): 12e08e7bf91a
  正文指纹(旧, 同措辞)              : 12e08e7bf91a
  代码指纹(新): 3805ff43b37c  (与旧的 b383fd41a9e0 不同)
  is_duplicate = True  <- 代码不匹配，但正文匹配 => 仍然判重

==========================================================================
  场景 6：真正的不同问题 —— 不判重
==========================================================================
  is_duplicate = False

==========================================================================
  场景 7：代码大小写敏感 —— 只有大小写不同必须算出不同指纹
==========================================================================
  myVar -> 966abaf36b73
  myvar -> 7402abe9b4aa

==========================================================================
  场景 8：跨轮恢复 —— 只靠已发布评论里的标记重建状态
==========================================================================
  扫描 2 条已发布评论 -> body 指纹 2 个, code 指纹 2 个
  原来的 body4 现在判重 = True

==========================================================================
  场景 9：尺寸路由 —— 小 PR 走便宜模型
==========================================================================
  小 PR (3 hunks, 2 files) -> gpt-4o-mini
  大 PR (480 hunks, 12 files) -> o3
  超大 PR (4000 hunks, 20 files) -> None (None = 保持默认主模型)

==========================================================================
  全部断言通过 ✅
==========================================================================
  演示了 4 个可运行机制：
   1. 最大文件优先的贪心装箱 + 软/硬双预算 + 对数前缀验证
   2. 行内评论跨轮去重（正文指纹 OR 代码指纹）
   3. 代码指纹的大小写敏感性保证
   4. 尺寸路由（小 PR 走便宜模型）
```

### 复刻时最容易搞错的两处

**第一处：正文指纹的 80 字符窗口。**

默认的 `body_fingerprint` 只比较**前 80 个字符**（`max_chars=80`）。这意味着：

- 如果正文很短，代码块会落进 80 字窗口内 → 正文指纹包含了代码 → "同措辞不同代码"就**不会**被正文指纹抓到
- 只有正文足够长（代码块在窗口外），"同措辞不同代码"才能靠正文指纹命中

MVP 的场景 5 特意把散文写长到 120 字符，就是为了让代码块落在窗口外。**这一点在真实项目里同样需要注意**——如果你依赖正文指纹兜底，得保证建议的散文部分够长。

**第二处：`attempts` 只在真实投递时递增。**

这个坑我在写 MVP 时踩过一次（第一版把 `attempts` 每次调用都 +1，结果和 Go 原版行为不一致）。Go 版 `sendOnce` 的语义是：

```go
if m.react.seen[key] == sig {
    return sendOnceAccounted, nil      // 同签名 -> 直接返回，attempts 不变
}
attempts := m.react.attempts[key]
if maxAttempts > 0 && attempts >= maxAttempts {
    return sendOnceAccounted, nil      // 尝试预算用完 -> 不再发
}
```

**`maxAttempts` 限制的是"用几种不同的失败内容打扰 agent 几次"，不是"API 被调用了几次"。** 语义差别决定了 agent 到底会被烦几次。


---

## 参考资料

- [The-PR-Agent/pr-agent](https://github.com/The-PR-Agent/pr-agent) — 主仓库，14,038⭐，MIT
- [`pr_agent/algo/pr_processing.py`](https://github.com/The-PR-Agent/pr-agent/blob/main/pr_agent/algo/pr_processing.py) — PR 压缩装箱算法（52,959 字符）
- [`pr_agent/algo/inline_comment_dedup.py`](https://github.com/The-PR-Agent/pr-agent/blob/main/pr_agent/algo/inline_comment_dedup.py) — 双指纹跨轮去重
- [`pr_agent/algo/token_budget.py`](https://github.com/The-PR-Agent/pr-agent/blob/main/pr_agent/algo/token_budget.py) — Token 预算与模型上限解析
- [`pr_agent/algo/model_routing.py`](https://github.com/The-PR-Agent/pr-agent/blob/main/pr_agent/algo/model_routing.py) — 尺寸路由
- [`pr_agent/algo/repo_context.py`](https://github.com/The-PR-Agent/pr-agent/blob/main/pr_agent/algo/repo_context.py) — 项目上下文注入与路径防护
- [`pr_agent/git_providers/git_provider.py`](https://github.com/The-PR-Agent/pr-agent/blob/main/pr_agent/git_providers/git_provider.py) — GitProvider 抽象层
- [`pr_agent/tools/pr_reviewer.py`](https://github.com/The-PR-Agent/pr-agent/blob/main/pr_agent/tools/pr_reviewer.py) — 主审查工具（91,563 字符）
- [PR-Agent 官方文档](https://docs.pr-agent.ai/) — 工具与配置文档
- [OpenCodeReview](https://github.com/alibaba/open-code-review) — 对比项目（Deterministic × Agent 混合架构）
- [LiteLLM](https://github.com/BerriAI/litellm) — PR-Agent 的模型抽象层
