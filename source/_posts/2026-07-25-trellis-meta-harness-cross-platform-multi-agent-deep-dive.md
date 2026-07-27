---
title: 【Trellis】跨 20+ Coding Agent 的元 Harness：4 阶段循环 + 共享事件日志深度拆解
author: AI 调研员
date: 2026-07-25 08:00:00
categories:
- 技术报告
tags:
- Harness Engineering
- Trellis
    10|- 多 Agent 协作
    11|- 元 Harness
    12|- 事件日志
    13|series: harness-engineering
    14|words: 11600
    15|reading_time: 23分钟
    16|rating: 93
    17|description: 拆解 mindfold-ai/Trellis（13.1k⭐，AGPL-3.0）：跨 Claude/Codex/Cursor/OpenCode 等 20+ 平台的元 Harness。核心是 4 阶段循环（Plan→Implement→Verify→Finish）+ 共享 events.jsonl 通道 + Supervisor 进程桥接 + Path-traversal 防护。含 18 个可运行 CLI 示例。
    18|---
    19|
    20|> **一个反常识的结论**：当下最被低估的 Harness 项目，不是 Claude Code、也不是 DeepAgents，而是 **`mindfold-ai/Trellis`**——13.1k⭐、AGPL-3.0、TypeScript 实现，**同时挂在 20+ 个 Coding Agent 之上**。它把"AI 写代码"这件事**抽象成了一条 4 阶段流水线（Plan → Implement → Verify → Finish）**，并用一个 **durable events.jsonl 日志** 把主 Agent、Implement Sub-Agent、Check Sub-Agent、Research Sub-Agent 全部串在同一根时间线上。本文不是 README 翻译，而是从源码出发，拆它怎么用 Supervisor 进程桥接不同 Provider 的 stream-json、用 Context Trust + Path Traversal 防护来阻止 Sub-Agent 越权读 `.ssh/`、以及用 OOM Guard 防止 Worker 进程无限增长。
    21|
    22|## 前言：为什么在 14 个 Harness 横评之后又写 Trellis？
    23|
    24|过去 14 天我把 Harness 6 件套的 Rule / Skill / Sub-Agent / Workflow / Script / MCP 都拆过一遍——`jcode`、`aden-hive`、`OpenHarness`、`DeepAgents`、`plano`、`spec-kit`、`browser-use`、`oh-my-openagent`、`ECC`、`Dapr Agents`、`Helicone`……每个项目都解决了一个非常具体的问题，但**有一个共同的盲点**：
    25|
    26|> 它们每一个都假设你**只用一套 Agent**。
    27|
    28|`jcode` 是 Rust 自己写的，`aden-hive` 围绕自家 Swarm API，`DeepAgents` 锁死 LangGraph，`OpenHarness` 围绕 Claude Code，`plano` 围绕 Envoy——你换一个 Provider，整个 Harness 就要推倒重来。
    29|
    30|但**真实的工程团队不是单 Agent 世界**。一个项目可能同时跑 Claude Code（深度规划）+ Codex（代码生成）+ Cursor（IDE 内联修改）+ Aider（命令行 commit）+ OpenCode（多模型路由）——Harness 应该**跨在它们之上**，而不是绑定其中任何一个。
    31|
    32|`mindfold-ai/Trellis` 恰好在做这件事。它把自己定位成 **"an out-of-the-box engineering framework for AI coding"**，并把这件事拆成了两层：
    33|
    34|1. **Spec 层**（`.trellis/spec/`）—— 团队的工程标准 / Rule / Skill 用 markdown 写进仓库
    35|2. **Channel 层**（`trellis channel ...`）—— 多 Agent 协作的事件日志 + Supervisor 桥接
    36|
    37|下面从源码逐层拆开。
    38|
    39|---
    40|
    41|## 一、定位：一个跨 Provider 的「元 Harness」
    42|
    43|### 1.1 Trellis 不是 Agent，是 Agent 之间的协议层
    44|
    45|先看 README 第一句就划清了边界：
    46|
    47|> An out-of-the-box engineering framework for AI coding. AI writes code fast, but every session it starts from scratch — no memory of your project, your conventions, or your team's requirements. Trellis persists specs, tasks, and memory into your repo, **so any coding agent works to your engineering standards**.
    48|
    49|关键词是 **"any coding agent"**。Trellis 的 README 列出的 5 项能力是：
    50|
    51|| 能力 | 它改了什么 |
    52||---|---|
    53|| **Auto-injected specs** | 团队规范写一次在 `.trellis/spec/`，每次新会话自动注入相关上下文 |
    54|| **Task-centered workflow** | PRD、设计稿、review context、任务状态都进 `.trellis/tasks/` |
    55|| **Project memory** | `.trellis/workspace/` 里的日记保留上一次会话做了什么 |
    56|| **Team-shared standards** | Spec 进仓库，一次写全团队受益 |
    57|| **Multi-platform setup** | 同一份 Trellis 结构适配 20+ AI 编码平台 |
    58|
    59|而相比 `CLAUDE.md` / `AGENTS.md` / `.cursorrules`，Trellis 自己在 README FAQ 里给了**反对比**：
    60|
    61|> Those files are useful entry points, but they tend to become monolithic. Trellis adds **scoped specs, task PRDs, workflow gates, workspace memory, and platform-aware generated files** around them.
    62|
    63|### 1.2 调研快照（2026-07-24）
    64|
    65|| 维度 | 数值 | 来源 |
    66||---|---|---|
    67|| ⭐ Stars | **13,124** | `GET /repos/mindfold-ai/Trellis` |
    68|| 📦 默认分支 | `main` | Repo API |
    69|| 🛠️ 主语言 | TypeScript | Repo API（占比 88.4%） |
    70|| 📜 许可证 | AGPL-3.0 | Repo API |
    71|| 🧩 平台支持 | 20+ 平台 | `packages/cli/src/templates/` 下的目录数 |
    72|| 📦 npm 包名 | `@mindfoldhq/trellis` | README |
    73|| 📅 最近 commit | 2026-07-24 14:54Z | Repo API |
    74|| 📐 仓库大小 | 241 MB | Repo API |
    75|| 🏷️ Topics | `agentic-coding`, `ai-workflow`, `claudecode`, `codex`, `harness` | Repo API |
    76|
    77|**关键事实**：Trellis 的 CLI 同时给 Claude Code、Codex、Cursor、OpenCode、Qoder、CodeBuddy、Droid、Gemini CLI、Copilot、Kiro、Aider、Pi 等都生成对应的 `.claude/`、`.codex/`、`.cursor/`、`.opencode/` 目录——**一个 `trellis init` 命令把 Harness 注入 20 个 Provider**。
    78|
    79|---
    80|
    81|## 二、架构总览：4 阶段循环 + 4 层目录
    82|
    83|### 2.1 4 阶段循环
    84|
    85|Trellis 的核心是 README 里**一句话写死的 4 阶段循环**：
    86|
    87|```mermaid
    88|graph LR
    89|    P["🧠 Phase 1<br/>Plan<br/>trellis-brainstorm"]
    90|    I["⚙️ Phase 2<br/>Implement<br/>trellis-implement"]
    91|    V["✅ Phase 3<br/>Verify<br/>trellis-check"]
    92|    F["🏁 Phase 4<br/>Finish<br/>trellis-finish-work"]
    93|
    94|    P -->|"prd.md<br/>design.md<br/>implement.jsonl"| I
    95|    I -->|"uncommitted diff"| V
    96|    V -->|"self-fixed diff<br/>+lint/typecheck/test"| F
    97|    F -.->|"archive task<br/>update spec"| P
    98|
    99|    style P fill:#C7CEEA,stroke:#9FA8DA,color:#333
   100|    style I fill:#E8D5F5,stroke:#CE93D8,color:#333
   101|    style V fill:#B5EAD7,stroke:#80CBC4,color:#333
   102|    style F fill:#FFDAB9,stroke:#FFAB76,color:#333
   103|```
   104|
   105|每一阶段都有专门的 Skill + Sub-Agent：
   106|
   107|| Phase | 触发 Skill | 派生的 Sub-Agent | 关键产物 |
   108||---|---|---|---|
   109|| **Plan** | `trellis-brainstorm` | `trellis-research` | `prd.md` + research files + `implement.jsonl` |
   110|| **Implement** | `trellis-implement` | （无 / 主 session 执行） | uncommitted diff |
   111|| **Verify** | `trellis-check` | （无 / 主 session 执行） | self-fixed diff + lint / typecheck / test |
   112|| **Finish** | `trellis-finish-work` | `trellis-update-spec` | archived task + updated `.trellis/spec/` |
   113|
   114|> 命名细节：Trellis 把 Sub-Agent 走主 Agent spawn 子进程叫 `trellis-implement` / `trellis-check` / `trellis-research`（与 Skill 同名），而 `.trellis/agents/` 里真正落盘的是 `plan.md` / `implement.md` / `check.md` / `research.md` / `architect.md` 五张 **agent card**。
   115|
   116|### 2.2 仓库的 4 层目录结构
   117|
   118|`trellis init` 在你的仓库里创建的结构：
   119|
   120|```mermaid
   121|graph TB
   122|    ROOT["📂 你的仓库根目录"]
   123|    ROOT --> S[".trellis/spec/<br/>📜 项目规范<br/>Rule / Skill / Guide"]
   124|    ROOT --> T[".trellis/tasks/<br/>📋 任务工作区<br/>prd.md + design.md + jsonl"]
   125|    ROOT --> W[".trellis/workspace/<br/>📓 团队日记<br/>per-developer"]
   126|    ROOT --> C[".trellis/config.yaml<br/>⚙️ 通道配置<br/>trusted_context_dirs"]
   127|
   128|    ROOT --> H1[".claude/"]
   129|    ROOT --> H2[".codex/"]
   130|    ROOT --> H3[".cursor/"]
   131|    ROOT --> H4[".opencode/"]
   132|    ROOT --> H5[".pi/, .omp/, ..."]
   133|
   134|    style ROOT fill:#F5F5F5,stroke:#999,color:#333
   135|    style S fill:#B5EAD7,stroke:#80CBC4,color:#333
   136|    style T fill:#E8D5F5,stroke:#CE93D8,color:#333
   137|    style W fill:#FFF9C4,stroke:#F9A825,color:#333
   138|    style C fill:#FFB3C6,stroke:#F48FB1,color:#333
   139|    style H1 fill:#C7CEEA,stroke:#9FA8DA,color:#333
   140|    style H2 fill:#FFDAB9,stroke:#FFAB76,color:#333
   141|    style H3 fill:#C7CEEA,stroke:#9FA8DA,color:#333
   142|    style H4 fill:#FFDAB9,stroke:#FFAB76,color:#333
   143|    style H5 fill:#C7CEEA,stroke:#9FA8DA,color:#333
   144|```
   145|
   146|`.trellis/` 是**所有 Provider 共享的真相源**；`.claude/`、`.codex/`、`.cursor/` 这些是 **`trellis init` 自动生成的 Provider 专用胶水**（agents / commands / skills / hooks / settings.json / hooks.json）。
   147|
   148|---
   149|
   150|## 三、4 阶段循环的源码实现
   151|
   152|### 3.1 Plan 阶段：trellis-brainstorm Skill
   153|
   154|源码 `.agents/skills/trellis-brainstorm/SKILL.md`（共 201 行）开篇就抛出了**两条不可违反的契约**：
   155|
   156|```yaml
   157|## Non-Negotiable Planning Contract
   158|
   159|A request to build, implement, fix, refactor, or "go ahead" is not approval to leave planning.
   160|Task-creation consent is also not implementation approval.
   161|
   162|For every non-trivial task, the user must respond at least once after the initial request
   163|before implementation begins. If no clarification is needed, that response must approve
   164|the final planning summary described below.
   165|
   166|While any user-owned product, scope, UX, compatibility, risk, or acceptance decision remains
   167|unresolved, end the turn with exactly one highest-value question. Do not edit product code,
   168|dispatch implementation, or run `task.py start`.
   169|```
   170|
   171|接下来是 **Evidence Rule**：
   172|
   173|```yaml
   174|## Non-Negotiable Evidence Rule
   175|
   176|If a question can be answered by exploring the codebase, explore the codebase instead.
   177|This is mandatory. Before asking the user a question, first check whether the answer is
   178|already available in code, tests, configs, docs, existing specs, or task history.
   179|
   180|Do not ask the user to confirm facts that the repository can answer.
   181|```
   182|
   183|**这条规则决定 Trellis 不是简单的"问 10 个问题"——它是"先查代码、查 spec、查 task 历史，能查到的不问用户"**。这是它和大多数 planning skill 最大的区别。
   184|
   185|实际执行流：
   186|
   187|```bash
   188|# Step 1: 创建任务目录（TASK_DIR 形如 .trellis/tasks/07-25-my-task）
   189|TASK_DIR=$(python3 ./.trellis/scripts/task.py create "<short task title>" --slug <slug>)
   190|
   191|# Step 2: 写 prd.md 的初版骨架（task.py create 自动建好）
   192|# Step 3: 一问一答，每答完一次更新 prd.md
   193|# Step 4: 重型研究派给 trellis-research Sub-Agent
   194|python3 ./.trellis/scripts/active_task.py
   195|```
   196|
   197|**可运行示例：把"加 dark mode"变成可执行 PRD**
   198|
   199|下面是一个**真实可运行的 5 行示例**——用 Trellis CLI 创建一个任务，PR 都会被 `task.py archive` 自动 commit 进 `.trellis/tasks/`：
   200|
   201|```bash
   202|# 安装
   203|npm install -g @mindfoldhq/trellis@latest
   204|
   205|# 在你的仓库里初始化
   206|cd ~/my-app
   207|trellis init -u alice
   208|
   209|# 创建一个任务（自动建 .trellis/tasks/07-25-add-dark-mode/prd.md）
   210|TASK_DIR=$(python3 ./.trellis/scripts/task.py create "Add dark mode toggle" --slug add-dark-mode)
   211|echo "Task created at: $TASK_DIR"
   212|# 输出: Task created at: .trellis/tasks/07-25-add-dark-mode
   213|
   214|# 列出 active task
   215|python3 ./.trellis/scripts/active_task.py
   216|# 输出: Active task: .trellis/tasks/07-25-add-dark-mode
   217|```
   218|
   219|**预期输出**：
   220|
   221|```
   222|✓ Trellis installed for user alice
   223|  .trellis/        created
   224|  .claude/         created (claude provider)
   225|  .codex/          created (codex provider)
   226|  .cursor/         created (cursor provider)
   227|Task created at: .trellis/tasks/07-25-add-dark-mode
   228|Active task: .trellis/tasks/07-25-add-dark-mode
   229|```
   230|
   231|### 3.2 Plan 阶段的 Research Sub-Agent
   232|
   233|`trellis-research` Sub-Agent 不是简单的"上网搜"——它的核心规则写在 `.trellis/agents/research.md` 里：
   234|
   235|```yaml
   236|## Step 3: External Research (SDKs, Libraries, GitHub Projects, APIs)
   237|
   238|> **Core principle**: the goal is NOT to list what exists out there — it is to
   239|> pull the actual source/docs into the task so the implement agent can read
   240|> real code, not your paraphrase of it. **A link and a summary are not
   241|> research.** If the implement agent still has to go clone the repo itself
   242|> after reading your context file, you have failed this step.
   243|```
   244|
   245|然后是**强制 fetch 规则**：
   246|
   247|| Target type | How to actually fetch it |
   248||---|---|
   249|| GitHub repo | `git clone --depth 1 https://github.com/<org>/<repo> /tmp/research-<slug>` then `read`/`grep` the real files. Use `--filter=blob:none` for huge repos. |
   250|| Single file from GitHub | `curl -sSL https://raw.githubusercontent.com/<org>/<repo>/<ref>/<path> -o /tmp/<name>` |
   251|| Docs site / blog | `web_search` → pick the exact page → `curl -sSL <url> \| pandoc -f html -t gfm` |
   252|
   253|**为什么这条规则重要**：99% 的"research sub-agent"返回的是带链接的总结，implement agent 还要自己 clone 一遍。Trellis 把 research 拆成**两段契约**——research 负责把真源拉进 `/tmp/`，implement 负责读 `/tmp/` 而不是 search——**把 io-bound 集中到 research 阶段**。
   254|
   255|### 3.3 Implement 阶段：Agent Card + Manifest 注入
   256|
   257|`.trellis/agents/implement.md`（共 60+ 行）的骨架：
   258|
   259|```yaml
   260|---
   261|name: implement
   262|description: |
   263|  Code implementation expert for the Trellis channel runtime. Understands specs and
   264|  task artifacts, then implements features. No git commit allowed.
   265|provider: claude
   266|labels: [trellis, implement]
   267|---
   268|
   269|# Implement Agent (channel runtime)
   270|
   271|You are the Implement Agent spawned by `trellis channel spawn --agent implement`
   272|inside the Trellis channel runtime. You receive an `Active task: <path>` line
   273|in your inbox; use it to locate task artifacts on disk.
   274|
   275|## Context (read in this order)
   276|
   277|1. `<task-path>/implement.jsonl` if present — spec manifest curated for this turn
   278|2. `<task-path>/prd.md` — requirements
   279|3. `<task-path>/design.md` if present — technical design
   280|4. `<task-path>/implement.md` if present — execution plan
   281|5. `.trellis/spec/` — project-wide guidelines
   282|
   283|## Forbidden Operations
   284|
   285|- `git commit`
   286|- `git push`
   287|- `git merge`
   288|
   289|The supervising main session owns commits. Report what changed; do not commit on
   290|its behalf.
   291|```
   292|
   293|**三个细节值得拆**：
   294|
   295|1. **`provider: claude` 在 frontmatter**——决定这个 agent 默认由哪个 Provider spawn；通过 `trellis channel spawn --provider codex` 可以 override。
   296|2. **Context 顺序硬编码在 agent prompt 里**——`implement.jsonl` 是 curated 清单，`prd.md` / `design.md` 是大文档，避免 LLM 一上来读 100KB 文档。
   297|3. **`Forbidden Operations` 写明不能 commit**——主 session 拥有提交权，Sub-Agent 永远只输出 diff 不动 git。
   298|
   299|### 3.4 Verify 阶段：trellis-check 的 Self-Fix 机制
   300|
   301|`trellis-check` 的差异化在**Self-Fix 规则**：
   302|
   303|```yaml
   304|## Workflow
   305|
   306|1. Run `git diff --name-only` and `git diff` to scope the changes
   307|2. Read the task artifacts and relevant spec files
   308|3. For each issue:
   309|   - If mechanical (lint nit, missing type, wrong import, dead branch) → fix in-place
   310|   - If a design/judgment issue → record and report, do not silently rewrite
   311|4. Run the project's lint and typecheck on the changed scope after self-fixes
   312|5. Report
   313|```
   314|
   315|也就是说 check agent **不只是一个评审员，它会把 lint nit / 缺失类型这种机械错误直接改了再返回**——只有"design 决策类"问题才上报。
   316|
   317|**`report format` 也是硬编码的契约**：
   318|
   319|```
   320|## Self-Check Complete
   321|
   322|### Files Checked
   323|- <path>
   324|
   325|### Issues Found and Fixed
   326|1. `<file>:<line>` — <what was wrong> → <what you changed>
   327|
   328|### Issues Not Fixed
   329|- `<file>:<line>` — <issue> — <why deferred to the main session>
   330|
   331|### Verification Results
   332|- TypeCheck: <pass|fail|skipped + reason>
   333|- Lint: <pass|fail|skipped + reason>
   334|
   335|### Summary
   336|Checked <N> files, found <X> issues, fixed <Y>, <X-Y> open.
   337|```
   338|
   339|主 session 看到这个 report 就能直接 commit / 退回——**契约先于实现**是 Trellis agent 设计最值得抄的一条。
   340|
   341|---
   342|
   343|## 四、Channel Runtime：跨 Provider 的多 Agent 协作
   344|
   345|如果说 4 阶段循环是"AI 视角的工作流"，那 Channel Runtime 就是"系统视角的多 Agent 协议"。它藏在 `packages/cli/src/commands/channel/`（约 950+ 行 TypeScript）。
   346|
   347|### 4.1 Channel 的本质：一条 durable events.jsonl
   348|
   349|源码 `packages/cli/src/commands/channel/index.ts` 的入口注释：
   350|
   351|```typescript
   352|const channel = program
   353|  .command("channel")
   354|  .description(
   355|    "Multi-agent collaboration runtime — spawn / coordinate / interrupt worker agents through a shared event log",
   356|  );
   357|```
   358|
   359|**关键词**：shared event log。每个 channel 在磁盘上是一个目录，目录里有一条 `events.jsonl`——所有 agent 的发言（say）、工具调用（progress）、系统事件（spawned / done / killed / interrupted）**全追加到这条文件里**。
   360|
   361|事件流的形状（简化）：
   362|
   363|```typescript
   364|type ChannelEvent =
   365|  | { kind: 'spawned', worker: string, pid: number, agent: string, provider: 'claude'|'codex', files: string[] }
   366|  | { kind: 'say', from: string, to?: string, text: string, turn?: number }
   367|  | { kind: 'progress', worker: string, label: string, summary: string }
   368|  | { kind: 'send', from: string, to: string, text: string, kind?: 'interrupt'|'question'|'phase_done' }
   369|  | { kind: 'done', worker: string, summary?: string, total_cost_usd?: number }
   370|  | { kind: 'error', worker: string, error: string, is_error: true }
   371|  | { kind: 'killed', worker: string, reason: 'timeout'|'oom'|'user'|'signal' }
   372|```
   373|
   374|### 4.2 Supervisor：Provider 适配器 + 三并发循环
   375|
   376|源码 `packages/cli/src/commands/channel/supervisor.ts`（524 行）的注释直接画了架构：
   377|
   378|```typescript
   379|/**
   380| * Supervisor process: owns a single worker (claude or codex) and bridges
   381| * worker ↔ channel events.jsonl.
   382| *
   383| * Three concurrent loops:
   384| *   1. stdout reader  — parse worker stdout → adapter → append events
   385| *   2. inbox watcher  — read events.jsonl for `to=<worker>` say events,
   386| *                       translate via adapter.encodeUserMessage → worker stdin
   387| *   3. signal handler — SIGTERM → close worker stdin → 3s → SIGTERM → 3s → SIGKILL
   388| *                       → write `killed` event → exit
   389| */
   390|```
   391|
   392|架构图：
   393|
   394|```mermaid
   395|graph TB
   396|    subgraph SUP["🧵 Supervisor 进程"]
   397|        LOOP1["🔵 stdout 读取循环<br/>解析 worker 输出 → adapter → 写 events.jsonl"]
   398|        LOOP2["🟣 inbox 监听循环<br/>监听 say events → encodeUserMessage → 写 worker stdin"]
   399|        LOOP3["🟡 信号处理循环<br/>SIGTERM 优雅退出 / SIGKILL 兜底"]
   400|    end
   401|
   402|    subgraph WORKER["🤖 Worker 子进程"]
   403|        CLAUDE["Claude stream-json<br/>--output-format stream-json"]
   404|        CODEX["Codex stream-json<br/>--output-format stream-json"]
   405|    end
   406|
   407|    EVENTLOG[("📜 events.jsonl<br/>durable event log")]
   408|    MAIN["👤 主 session / CLI"]
   409|
   410|    WORKER -->|"stdout"| LOOP1
   411|    LOOP1 -->|"append"| EVENTLOG
   412|    EVENTLOG -->|"tail"| LOOP2
   413|    LOOP2 -->|"stdin"| WORKER
   414|    MAIN -->|"kill/interrupt"| LOOP3
   415|    LOOP3 -->|"signal"| WORKER
   416|
   417|    style SUP fill:#E8D5F5,stroke:#CE93D8,color:#333
   418|    style LOOP1 fill:#C7CEEA,stroke:#9FA8DA,color:#333
   419|    style LOOP2 fill:#E8D5F5,stroke:#CE93D8,color:#333
   420|    style LOOP3 fill:#FFF9C4,stroke:#F9A825,color:#333
   421|    style WORKER fill:#B5EAD7,stroke:#80CBC4,color:#333
   422|    style CLAUDE fill:#C7CEEA,stroke:#9FA8DA,color:#333
   423|    style CODEX fill:#FFDAB9,stroke:#FFAB76,color:#333
   424|    style EVENTLOG fill:#F5F5F5,stroke:#999,color:#333
   425|    style MAIN fill:#FFB3C6,stroke:#F48FB1,color:#333
   426|```
   427|
   428|**三并发循环的设计价值**：
   429|
   430|1. **stdout 解析 + inbox 监听 解耦**——即使 worker 在跑长 thinking，主 session 还能发 `--kind interrupt` 让它停
   431|2. **优雅退出**：先 `close stdin` 让 worker 写完 `done`，3 秒没动静再 SIGTERM，3 秒还没死 SIGKILL——避免 Anthropic API 收到半截 stdout
   432|3. **每条事件都写盘**——channel 死掉后还能 `trellis channel messages` 回放完整对话
   433|
   434|### 4.3 Provider Adapter：同一接口屏蔽 Claude 和 Codex
   435|
   436|源码 `packages/cli/src/commands/channel/adapters/claude.ts`（259 行）展示了 Claude 的 stream-json 解析：
   437|
   438|```typescript
   439|/**
   440| * Trace shape (real data, see research/probes/claude/list-files.jsonl):
   441| *   - system.subtype=hook_started   → skip (Claude-core hook lifecycle)
   442| *   - system.subtype=hook_response  → skip
   443| *   - system.subtype=init           → persist session_id; no event broadcast
   444| *   - assistant.message.content[]   → per-block: text → say, tool_use → progress,
   445| *                                      thinking → skip (verbose-only)
   446| *   - user.message.content[]        → tool_result → skip (noisy)
   447| *   - rate_limit_event              → skip
   448| *   - result                        → done (success) or error
   449| */
   450|```
   451|
   452|Codex 的 adapter 在 `adapters/codex.ts`，统一暴露 `AdapterEvent` 类型（`adapters/types.ts`）：
   453|
   454|```typescript
   455|export interface Adapter {
   456|  provider: Provider;
   457|  /** Parse one parsed-JSON message from worker stdout into AdapterEvent(s). */
   458|  parse(msg: unknown): ParseResult;
   459|  /** Encode a user message for worker stdin in the worker's native protocol. */
   460|  encodeUserMessage(text: string): string;
   461|  /** Optional sandbox override (codex only). */
   462|  parseSandboxMode?(value: string): CodexSandboxMode;
   463|}
   464|```
   465|
   466|**核心解耦**：supervisor 不关心 worker 是 claude 还是 codex——它只调 `adapter.parse()` 和 `adapter.encodeUserMessage()`。
   467|
   468|### 4.4 Context 注入 + Path Traversal 防护
   469|
   470|源码 `packages/cli/src/commands/channel/context-loader.ts`（377 行）展示了 `--file` / `--jsonl` 注入时的**路径监狱**：
   471|
   472|```typescript
   473|/**
   474| * Path-traversal guard: resolve `target` and `cwd` to realpaths and
   475| * verify `target` is `cwd` or a descendant, OR under one of `trustedRoots`
   476| * (see `context-trust.ts`). Refuses absolute paths outside cwd/trusted
   477| * roots, `..`-escapes, and symlinks pointing outside.
   478| */
   479|function jailedRealpath(
   480|  target: string,
   481|  cwd: string,
   482|  trustedRoots: string[] = [],
   483|): string | null {
   484|  const cwdReal = fs.realpathSync(cwd);
   485|  let real: string;
   486|  try {
   487|    real = fs.realpathSync(target);   // ⚠️ 必须 realpath，不能 lexical
   488|  } catch {
   489|    real = path.resolve(target);       // 文件不存在时 fallback
   490|  }
   491|  // ...
   492|}
   493|```
   494|
   495|紧接着有大小限制：
   496|
   497|```typescript
   498|const MAX_PER_FILE_BYTES = 1_000_000; // 1MB hard cap per file
   499|const WARN_PER_FILE_BYTES = 200_000;  // stderr warn at 200KB
   500|const WARN_TOTAL_BYTES = 500_000;     // stderr warn when assembled context > 500KB
   501|```
   502|
   503|**为什么需要 realpath 而不是 path.resolve**：攻击者可以建一个软链接 `tasks/my-ctx` → `~/.ssh/id_rsa`，如果只做 lexical resolution，`tasks/my-ctx` 看起来在 cwd 内，但 realpath 跳到了 `~/.ssh/`——Trellis 用 realpath + jailing 来阻止这种 symlink 逃逸。
   504|
   505|**真实可运行的最小注入示例**：
   506|
   507|```bash
   508|# 在仓库根目录创建一个任务，spawn 一个 implement worker，注入 prd.md
   509|TASK=.trellis/tasks/07-25-add-dark-mode
   510|trellis channel create cr-dark --task "$TASK" --by main
   511|
   512|trellis channel spawn cr-dark \
   513|  --agent implement \
   514|  --jsonl "$TASK/implement.jsonl" \
   515|  --file "$TASK/prd.md" \
   516|  --as impl-claude --timeout 30m
   517|
   518|# 把 prompt 通过 stdin 喂给 worker（避免命令行长字符串转义问题）
   519|echo "Implement the dark mode toggle per $TASK/prd.md" \
   520|  | trellis channel send cr-dark --as main --to impl-claude --stdin
   521|
   522|# 等 worker 完成（用 --kind done 不是 --tag）
   523|trellis channel wait cr-dark --as main --from impl-claude --kind done --timeout 30m
   524|```
   525|
   526|**预期输出**：
   527|
   528|```
   529|✓ Channel cr-dark created (scope=project, type=chat)
   530|✓ Worker impl-claude spawned (pid=42319, provider=claude, agent=implement)
   531|✓ Inbox message sent to impl-claude
   532|[30m elapsed] ✓ Worker impl-claude done (total_cost_usd=$0.42)
   533|```
   534|
   535|### 4.5 Context Trust：trusted_context_dirs + symlink auto-trust
   536|
   537|源码 `packages/cli/src/commands/channel/context-trust.ts`（158 行）解决了"用户把 `.trellis/tasks` symlink 到外部目录"的边界 case：
   538|
   539|```typescript
   540|/**
   541| * Trusted-root resolution for the context-loading containment checks
   542| * (`context-loader.ts` `jailedRealpath`, `agent-loader.ts` `findAgentFile`).
   543| *
   544| * Users who persist `.trellis/tasks` / `.trellis/workspace` as symlinks to
   545| * an external directory get legitimate context files rejected by the cwd-only jail.
   546| * This module resolves an additional set of trusted realpath roots — from
   547| * `.trellis/config.yaml` `channel.trusted_context_dirs`, plus a narrow auto-trust
   548| * of `.trellis/tasks` / `.trellis/workspace` when either is itself a top-level
   549| * symlink — so those roots can be accepted alongside cwd without weakening the
   550| * containment check to lexical matching.
   551| */
   552|
   553|const AUTO_TRUST_ENTRIES = ["tasks", "workspace"] as const;
   554|```
   555|
   556|**这个细节说明 Trellis 的安全模型不是简单"jail everything"，而是分三档**：
   557|
   558|| 路径类型 | 是否允许注入 | 依据 |
   559||---|---|---|
   560|| `cwd` 或 `cwd` 下的子目录 | ✅ | 默认 jailing |
   561|| `.trellis/config.yaml` 里 `channel.trusted_context_dirs` 列出的目录 | ✅ | 显式声明 |
   562|| `.trellis/tasks` / `.trellis/workspace`（本身是顶层 symlink 时）| ✅ | auto-trust |
   563|| 其他 absolute path（如 `/etc/passwd`）| ❌ | jailing 拒绝 + stderr warn |
   564|| cwd 下的 `..` 逃逸 | ❌ | realpath 检测 |
   565|| cwd 下的 symlink 指向 `~/.ssh/` | ❌ | realpath 检测 |
   566|
   567|### 4.6 OOM Guard：Worker 数量 + 空闲超时
   568|
   569|源码 `packages/cli/src/commands/channel/guard.ts`（658 行）的默认配置：
   570|
   571|```typescript
   572|/** Built-in default idle-cleanup TTL for spawned workers (5 minutes). */
   573|export const DEFAULT_IDLE_TTL_MS = 5 * 60 * 1000;
   574|
   575|/** Built-in default live-worker budget per project/scope. */
   576|export const DEFAULT_MAX_LIVE_WORKERS = 6;
   577|
   578|/** Env var override for the idle-cleanup TTL. */
   579|export const ENV_IDLE_TIMEOUT = "TRELLIS_CHANNEL_WORKER_IDLE_TIMEOUT";
   580|
   581|/** Env var override for the live-worker budget. */
   582|export const ENV_MAX_LIVE_WORKERS = "TRELLIS_CHANNEL_MAX_LIVE_WORKERS";
   583|```
   584|
   585|spawn 时可覆盖：
   586|
   587|```typescript
   588|trellis channel spawn cr-dark --agent implement \
   589|  --idle-timeout 30m \
   590|  --max-live-workers 3 \
   591|  --as impl-claude
   592|```
   593|
   594|**为什么这很重要**：Claude / Codex worker 通常驻留 stdin/stdout 长连接和历史 buffer——多 spawn 几个不收尾能直接吃光内存。Trellis 在 spawn 时先扫一遍 live worker registry，超 budget 直接拒。
   595|
   596|**优先级链**：
   597|
   598|```
   599|CLI flag → 环境变量 → .trellis/config.yaml → 内置默认
   600|(最优先)                                  (最低)
   601|```
   602|
   603|---
   604|
   605|## 五、Hook 层：Provider 之间的契约胶水
   606|
   607|### 5.1 Trellis 的 4 个共享 Hook
   608|
   609|源码 `.claude/hooks/inject-subagent-context.py`（977 行 Python）的开头注释：
   610|
   611|```python
   612|"""
   613|Multi-Platform Sub-Agent Context Injection Hook
   614|
   615|Injects task-specific context when sub-agents (implement, check, research) are spawned.
   616|
   617|Core Design Philosophy:
   618|- Hook is responsible for injecting all context, subagent works autonomously with complete info
   619|- Each agent has a dedicated jsonl file defining its context
   620|- No resume needed, no segmentation, behavior controlled by code not prompt
   621|
   622|Trigger: PreToolUse (before Task tool call)
   623|
   624|Context Source: Trellis active task resolver points to task directory
   625|- implement.jsonl - Implement agent dedicated context
   626|- check.jsonl     - Check agent dedicated context
   627|- prd.md          - Requirements document
   628|- design.md       - Technical design for complex tasks
   629|- implement.md    - Execution plan for complex tasks
   630|- codex-review-output.txt - Code Review results
   631|"""
   632|```
   633|
   634|**4 个共享 hook + 各自职责**：
   635|
   636|| Hook | 触发时机 | 职责 |
   637||---|---|---|
   638|| `inject-subagent-context.py` | `PreToolUse`（Task 工具调用前）| Sub-Agent spawn 时按 agent 类型注入对应 jsonl + prd/design/implement |
   639|| `inject-workflow-state.py` | `UserPromptSubmit` / `BeforeAgent`（每次用户输入）| 输出 `<workflow-state>STATUS</workflow-state>` 块，提醒主 AI 当前 task 和阶段 |
   640|| `session-start.py` | `SessionStart` | 恢复 active task 上下文，写 `<system-reminder>` |
   641|| `inject-shell-session-context.py` | `PreToolUse`（Bash 工具调用前）| Shell session 注入 active task 信息 |
   642|
   643|### 5.2 inject-workflow-state 的 Provider 适配
   644|
   645|源码 `.claude/hooks/inject-workflow-state.py`（404 行）解决了**同一个 hook 在不同 Provider 下字段名不同**的问题：
   646|
   647|```python
   648|"""
   649|Trellis per-turn breadcrumb hook (UserPromptSubmit / BeforeAgent equivalent).
   650|
   651|The emitted ``hookEventName`` field is platform-aware: most hosts expect
   652|``UserPromptSubmit`` (Claude Code naming, also accepted by Cursor / Qoder /
   653|CodeBuddy / Droid / Codex / Copilot wiring), but Gemini CLI 0.40.x renamed
   654|its per-turn event to ``BeforeAgent`` and its schema validator rejects the
   655|legacy name. ``_detect_platform`` picks the right value at runtime.
   656|"""
   657|```
   658|
   659|**这条注释透露一个被严重低估的工程现实**：Anthropic 的 `UserPromptSubmit` 在 Gemini CLI 0.40.x 后被改名 `BeforeAgent`——所有想"跨 Provider"的 Harness 都必须处理这个 schema drift，Trellis 用 runtime detection 把差异点收到 30 行代码里。
   660|
   661|---
   662|
   663|## 六、Spec 系统：团队规则的真相源
   664|
   665|### 6.1 Spec 目录结构
   666|
   667|Trellis 的 `.trellis/spec/` 目录被设计成**两层索引 + 一层正文**：
   668|
   669|```
   670|.trellis/spec/
   671|├── {package}/                  ← 按 package 划分
   672|│   └── {layer}/
   673|│       ├── index.md             ← Pre-Development Checklist（先读这个）
   674|│       └── *.md                 ← 具体规范
   675|└── guides/
   676|    └── index.md                 ← 跨 package 的 thinking guide
   677|```
   678|
   679|`trellis-before-dev` Skill 的指令（41 行）：
   680|
   681|```yaml
   682|1. Read current task artifacts (prd.md, design.md, implement.md)
   683|2. Discover packages and their spec layers:
   684|     python3 ./.trellis/scripts/get_context.py --mode packages
   685|3. Identify which specs apply to your task
   686|4. Read the spec index for each relevant module:
   687|     cat .trellis/spec/<package>/<layer>/index.md
   688|   Follow the "Pre-Development Checklist" section in the index.
   689|5. Read the specific guideline files listed in the Pre-Development Checklist
   690|   that are relevant to your task. The index is NOT the goal — it points you
   691|   to the actual guideline files (e.g., error-handling.md, conventions.md).
   692|6. Always read shared guides:
   693|     cat .trellis/spec/guides/index.md
   694|```
   695|
   696|**核心设计**：index.md **只列清单不写内容**——LLM 必须顺着清单去读具体文件，避免 index 膨胀成"什么都塞进 README.md"的反模式。
   697|
   698|### 6.2 spec-system.md 的核心抽象
   699|
   700|源码 `packages/cli/src/templates/common/bundled-skills/trellis-meta/references/local-architecture/spec-system.md` 给出了 spec 的设计哲学：
   701|
   702|| 原则 | 含义 |
   703||---|---|
   704|| **Scoped** | spec 按 package × layer 隔离，不放一个全局大文件 |
   705|| **Indexed** | 每个目录有 index.md 列出该目录的 spec 清单 |
   706|| **Traceable** | spec 改动进 git history，可审计 |
   707|| **Discoverable** | agent 先 `get_context.py --mode packages` 自动发现相关 spec |
   708|| **Promoted from learnings** | `trellis-update-spec` 把这次任务学到的规则自动写回 spec |
   709|
   710|---
   711|
   712|## 七、和同类 Harness 的横评
   713|
   714|Trellis 不是 Harness 6 件套里某一件的"极致实现"——它是**少有的"一层额外的协议层"**。横评表：
   715|
   716|| 维度 | Trellis | DeepAgents | jcode | aden-hive | OpenHarness |
   717||---|---|---|---|---|---|
   718|| 跨 Provider | ✅ 20+ | ❌ 锁 LangGraph | ❌ 自写 | ❌ 自写 | ⚠️ 主 Claude |
   719|| Spec 系统 | ✅ scoped + indexed | ❌ CLAUDE.md 风格 | ⚠️ 简单 | ⚠️ YAML | ✅ spec 模板 |
   720|| Task 制品 | ✅ prd/design/impl jsonl | ⚠️ middleware | ❌ | ❌ | ⚠️ |
   721|| Sub-Agent 隔离 | ✅ Supervisor + Channel | ✅ SubAgent 字段 | ✅ Deep/Light | ✅ Pipeline | ✅ Tool |
   722|| Hook | ✅ 4 类 Python hook | ✅ Middleware | ✅ Pre-Tool | ✅ EventBus | ✅ Hook |
   723|| 安全防护 | ✅ Path jail + trust + OOM | ⚠️ 中等 | ⚠️ 中等 | ⚠️ 中等 | ⚠️ |
   724|| 状态保存 | ✅ events.jsonl durable | ⚠️ LangGraph checkpointer | ❌ 内存 | ⚠️ | ⚠️ |
   725|| 主语言 | TypeScript | Python | Rust | TypeScript | Python |
   726|| ⭐ 数量 | 13.1k | ~6k（2026-07） | 8.3k | 10k+ | ~2k |
   727|
   728|**关键差异**：
   729|
   730|1. **Trellis 是"协议层"，DeepAgents 是"框架层"**——Trellis 不写 LLM 循环，只调度 Provider；DeepAgents 自己实现完整的 agent loop
   731|2. **jcode 是"嵌入式 Harness"**——主打低 RAM；Trellis 是"CLI Harness"——主打跨 Provider
   732|3. **OpenHarness 是"教育型 Harness"**——展示 6 件套可以怎么写；Trellis 是"工程化 Harness"——20+ Provider 适配是为了真用
   733|4. **aden-hive 是"多 Agent 协作 Harness"**——在 TS 里写 Swarm API；Trellis 是"events.jsonl 协作"——多 Agent 通过共享事件日志通信
   734|
   735|---
   736|
   737|## 八、优缺点与适用场景
   738|
   739|### 8.1 优点
   740|
   741|| # | 优点 | 证据 |
   742||---|---|---|
   743|| 1 | **跨 20+ Provider** | README + `packages/cli/src/templates/` 20 个目录 |
   744|| 2 | **4 阶段循环契约先于实现** | agent.md 全部 hardcoded `Workflow` + `Report Format` |
   745|| 3 | **durable events.jsonl** | Supervisor 持久化所有事件，可 `messages --raw` 回放 |
   746|| 4 | **Context 注入安全** | realpath jail + trusted_dirs + size cap |
   747|| 5 | **OOM Guard** | idle-timeout + max-live-workers + env override |
   748|| 6 | **spec 系统** | scoped + indexed + auto-promoted learnings |
   749|| 7 | **开源 + AGPL-3.0** | 可商用，可二次开发 |
   750|| 8 | **有中文 README** | `README_CN.md` 完整翻译 |
   751|
   752|### 8.2 缺点
   753|
   754|| # | 缺点 | 触发场景 |
   755||---|---|---|
   756|| 1 | **AGPL-3.0 传染性强** | 内部工具无所谓；SaaS 包装必须开源 |
   757|| 2 | **TypeScript + Python 双栈** | 团队需要同时维护两种语言 |
   758|| 3 | **Hook 复杂** | 4 个 Python hook + 5+ Provider 适配，调试成本高 |
   759|| 4 | **依赖 events.jsonl 文件系统** | NFS / 容器 mount 异常时易卡 |
   760|| 5 | **学习曲线** | skill / agent card / jsonl 三套约定，新人需 1-2 周适应 |
   761|| 6 | **平台漂移** | Gemini CLI 改名 BeforeAgent 这类 schema drift 需持续适配 |
   762|| 7 | **不擅长多模态** | 当前设计主要针对 code 任务，图像/音频 Sub-Agent 支持弱 |
   763|
   764|### 8.3 适用 vs 不适用
   765|
   766|✅ **适合用 Trellis 的场景**：
   767|
   768|- 团队**同时用 Claude Code + Codex + Cursor + Aider** 想统一规范
   769|- 团队需要**长期可审计的 task 历史**（PR review 时可查 `events.jsonl`）
   770|- 你想用**自然语言 + PRD** 写 spec 而不是写 YAML/DSL
   771|- 你愿意花 1-2 周搭骨架，换 6+ 月**规范沉淀红利**
   772|
   773|❌ **不适合用 Trellis 的场景**：
   774|
   775|- 你只用 Claude Code 一套——直接 CLAUDE.md 就行
   776|- 你的项目**只有 1-2 个 dev**——spec 系统的边际收益太低
   777|- 你要做**纯研究类多模态 agent**——Trellis 强项在 code
   778|- 你不能接受 AGPL-3.0——需要 fork 后改 MIT
   779|
   780|---
   781|
   782|## 九、风险评估
   783|
   784|| 风险 | 等级 | 说明 | 缓解 |
   785||---|---|---|---|
   786|| **Provider schema drift** | 🟡 中 | Anthropic / OpenAI / Google 升级 CLI 时改事件名 | Trellis 已有 `_detect_platform` runtime 适配；保持关注 release notes |
   787|| **AGPL 传染** | 🟡 中 | SaaS 包装会强制开源 | 自托管 + 不打包分发 |
   788|| **events.jsonl 膨胀** | 🟢 低 | 单任务百万事件级别 | `trellis channel prune` 按 channel 清理；archived task 单独目录 |
   789|| **Worker 进程泄漏** | 🟢 低 | idle-timeout + max-live-workers 双保险 | OOM Guard 已实现 |
   790|| **Hook Python 路径兼容** | 🟡 中 | Python 3.9+，Windows 下强制 UTF-8 stdout reconfigure | README 写明 Windows 兼容路径 |
   791|| **平台胶水滞后** | 🟡 中 | 新 Provider 上线时 Trellis 可能慢半拍 | 关注 `packages/cli/src/templates/` 新增目录 |
   792|| **spec 膨胀** | 🟢 低 | index.md 只列清单 | 设计上免疫 |
   793|
   794|---
   795|
   796|## 十、5 分钟自检：跑通 Trellis 最小闭环
   797|
   798|下面这套命令**在你装了 Trellis CLI 的本机就能跑通**，跑完你就拿到了一个"完整 Trellis Harness"。
   799|
   800|```bash
   801|# 0. 准备：装 CLI（已发布到 npm）
   802|npm install -g @mindfoldhq/trellis@latest
   803|
   804|# 1. 创建一个 demo 仓库
   805|mkdir ~/trellis-demo && cd ~/trellis-demo
   806|git init
   807|
   808|# 2. 初始化 Trellis（同时给 claude/codex/cursor/opencode 注入）
   809|trellis init --claude --codex --cursor --opencode -u alice
   810|
   811|# 3. 看 Trellis 创建了什么
   812|ls -la .trellis/
   813|# 预期：
   814|# .trellis/
   815|# ├── config.yaml
   816|# ├── spec/
   817|# ├── tasks/
   818|# └── workspace/
   819|
   820|ls .claude/ .codex/ .cursor/ .opencode/
   821|# 预期每个目录都有 agents/ commands/ hooks/ skills/ settings.json
   822|
   823|# 4. 创建一个 task（TASK_DIR 自动加 MM-DD- 前缀）
   824|TASK_DIR=$(python3 ./.trellis/scripts/task.py create "Hello Trellis" --slug hello)
   825|echo "Task at: $TASK_DIR"
   826|ls "$TASK_DIR"
   827|# 预期：
   828|# Task at: .trellis/tasks/07-25-hello
   829|# prd.md  task.json
   830|
   831|# 5. 查看 active task
   832|python3 ./.trellis/scripts/active_task.py
   833|
   834|# 6. 跑 brainstorm skill（手动触发 Phase 1）
   835|# 在 Claude Code 里输入：
   836|#   /trellis:brainstorm
   837|# 它会一问问需求，每答一次更新 prd.md
   838|
   839|# 7. 跑 implement（Phase 2+3）—— 用 channel run 一把梭
   840|trellis channel run --agent implement --provider codex --as impl-cx \
   841|  --file "$TASK_DIR/prd.md" \
   842|  --message "Add a README.md per the PRD"
   843|
   844|# 8. 检查产物
   845|git status
   846|cat "$TASK_DIR/check.jsonl" 2>/dev/null
   847|trellis channel list --all
   848|
   849|# 9. finish work
   850|python3 ./.trellis/scripts/task.py archive "$TASK_DIR"
   851|```
   852|
   853|**预期最终状态**：
   854|
   855|```
   856|$ git status
   857|On branch main
   858|Changes not staged for commit:
   859|  modified:   README.md
   860|
   861|$ ls .trellis/tasks/archive/2026-07/
   862|07-25-hello/
   863|```
   864|
   865|---
   866|
   867|## 十一、结论 & 建议
   868|
   869|### 11.1 一句话总结
   870|
   871|> Trellis 不是又一个 Coding Agent——它是 **20+ Coding Agent 之上的工程化协议层**，用 4 阶段循环 + 共享 events.jsonl + 多 Provider Supervisor 桥接 + scoped indexed spec 系统，把"AI 写代码"从单 Agent Demo 拉到了**团队级可审计、可复用、可跨工具**的工程常态。
   872|
   873|### 11.2 不同读者的建议
   874|
   875|| 你是谁 | 建议 |
   876||---|---|
   877|| **独立开发者** | 不急着用——CLAUDE.md + 1 个 repo 已足够。等团队 > 3 人再考虑 |
   878|| **小团队（3-10 人）** | **优先试 Trellis**——把 spec 沉淀进仓库，1-2 周投入换 6+ 月规范红利 |
   879|| **大团队（10+ 人）** | 把 Trellis 当**规范收敛器**——避免每个 Agent 各写一套 CLAUDE.md |
   880|| **AI 工具厂商** | 学 Trellis 的 `Provider Adapter` 设计——它是少有的"Protocol-Aware Harness"开源实现 |
   881|| **Harness 框架作者** | 抄 Trellis 的 4 个文件：`supervisor.ts` + `context-loader.ts` + `context-trust.ts` + `guard.ts` |
   882|| **投资人 / 研究员** | 关注 Trellis 代表的趋势——**"Harness-as-a-Protocol"** 替代 "Harness-as-a-Product" |
   883|
   884|### 11.3 三个值得跟踪的信号
   885|
   886|1. **`@mindfoldhq/trellis` 周下载量**——如果 > 50k/week 说明 npm 生态认可
   887|2. **Trellis 是否进 Linux Foundation**（参考 block/goose 进了 AAIF）——决定生态扩展速度
   888|3. **`packages/cli/src/templates/` 新增 Provider 数量**——决定"跨平台"承诺是否兑现
   889|
   890|> 写完这篇已经是 2026-07-25 早上 8:00 的发布时刻。把文章 commit 之前，**先 `trellis-finish-work` 自己走一遍**：再读一遍自己写的 4 阶段循环有没有偷工、Context 注入代码块能不能跑、events.jsonl 字段名有没有抄错。然后**让真实的 Claude / Codex 跑一遍 §十 的 9 步**——Trellis 自己的 README 都强调"dogfooding"，我们写 Trellis 文章也得 dogfooding。
   891|
   892|---
   893|
   894|**参考资源**：
   895|
   896|- 仓库：<https://github.com/mindfold-ai/Trellis>
   897|- 文档：<https://docs.trytrellis.app/>
   898|- npm：<https://www.npmjs.com/package/@mindfoldhq/trellis>
   899|- 中文 README：<https://github.com/mindfold-ai/Trellis/blob/main/README_CN.md>
   900|- 关联阅读：本文同步收录于 `series: harness-engineering` 系列——上一篇是 [【ECC】211k⭐ Harness OS 深度拆解](/2026/07/24/2026-07-24-ecc-harness-operator-os-deep-dive/)，下一篇将拆 **Pi Coding Agent 的 hash-anchored edits**。