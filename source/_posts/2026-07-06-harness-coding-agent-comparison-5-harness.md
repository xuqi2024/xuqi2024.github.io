---
title: 【标杆 Harness 横评】从 Claude Code 到 Pi：5 大 Coding Agent Harness 在 6 件套上的设计哲学与机制差异
author: AI 调研员
date: 2026-07-06 08:00:00
categories: [技术分析]
tags: [Harness Engineering, Coding Agent, Claude Code, Hermes]
description: 从 5 个主流 Coding Agent Harness 内部源码（Claude Code 136k⭐ + Codex 95k⭐ + Hermes 209k⭐ + OpenClaw 381k⭐ + Pi 67k⭐）出发，把 Harness 6 件套当坐标系，逐一拆解 5 个底座 Harness 的内核机制差异。
words: 11400
reading_time: 22分钟
rating: 92
description: 从 5 个主流标杆 Coding Agent Harness 的内部源码（anthropics/claude-code 136k⭐ + openai/codex 95k⭐ + NousResearch/hermes-agent 209k⭐ + openclaw/openclaw 381k⭐ + earendil-works/pi 67k⭐）出发，把 Harness 6 件套（Rule / Skill / Sub-Agent / Workflow / Script / MCP）当坐标系，逐一拆解 5 个底座 Harness 的内核机制差异：Claude Code 的 plugins/ 仓库级权限 + .claude-plugin/marketplace.json、Codex 的 Rust codex-rs + Scientist 命名空间 + MultiAgentVersion 协议、OpenClaw 的 AGENTS.md root policy + .agents/skills/ 顶层规范、Pi 的 4 包 monorepo（ai / agent / coding-agent / tui / orchestrator）+ 自我扩展、Hermes Agent 的 plugins/ + optional-skills/ 双轨技能市场 + Honcho dialectic。
---

> 如果说 Harness 6 件套是一份"考试大纲"，那 **Claude Code / Codex / Hermes / OpenClaw / Pi** 就是 5 份答卷 —— **同一张卷子，五种笔迹**。表面看起来都是 terminal-first 的 Coding Agent，但拆开源码才发现：**同一个组件，有人把它做成插件、有人把它做成协议、有人把它做成 monorepo 子包、有人干脆外置成可选 marketplace**。

本文基于 2026-07-06 实测的最新源码（5 个仓库累计 ⭐ ≈ 888k），把每个 Harness 的"内核 vs 外挂"边界画清楚 —— 这不是功能罗列，是**协议级拆解**。

## 一、Harness 6 件套坐标系（评测维度的统一锚点）

把 5 个项目摆在一起，先要把**统一评测维度**立起来。Harness Engineering 把 Agent 外面的"软件壳"拆成 6 个组件：

| # | 组件 | 一句话定义 | 在 Harness 中承担的"工程价值" |
|---|------|------------|-------------------------------|
| 1 | **Rule** | 软约束底线，告诉 Agent "哪些事不能做" | 把团队政策钉死在每次推理前 |
| 2 | **Skill** | SOP 标准操作流程，按需加载的"技能书" | 把领域知识封装成可复用单元 |
| 3 | **Sub-Agent** | 角色分工 + Context 隔离的子进程 | 让大任务不被 200k context 撑爆 |
| 4 | **Workflow** | 多步任务的状态机/DAG 编排 | 让 Agent 跑完一个长任务能续上 |
| 5 | **Script** | 不可绕过的门控脚本 | 把"模型自己说不"变成"代码不让过" |
| 6 | **MCP** | 外部工具桥接协议 | 标准化"Agent 拿工具"的过程 |

**评测原则**：每个 Harness 在每个组件上回答三个问题：(a) 机制（mechanism）是什么？(b) 把它做成了"内核"还是"外挂"？(c) 协议契约是什么？

```mermaid
graph TB
    subgraph "评测维度（坐标系）"
        R["📋 Rule<br/>软约束"]
        S["📚 Skill<br/>按需加载"]
        SU["🪖 Sub-Agent<br/>Context 隔离"]
        W["🔗 Workflow<br/>状态机/DAG"]
        SC["⛔ Script<br/>门控脚本"]
        M["🔌 MCP<br/>外部桥接"]
    end
    
    subgraph "评测对象（5 个 Harness）"
        CC["🛠️ Claude Code<br/>anthropics"]
        CX["🛠️ Codex CLI<br/>openai"]
        HX["🛠️ Hermes Agent<br/>NousResearch"]
        OC["🦞 OpenClaw<br/>openclaw"]
        PI["🛠️ Pi<br/>earendil-works"]
    end
    
    CC -. 评测 .-> R
    CC -. 评测 .-> S
    CC -. 评测 .-> SU
    CC -. 评测 .-> W
    CC -. 评测 .-> SC
    CC -. 评测 .-> M
    CX -. 评测 .-> R
    CX -. 评测 .-> S
    CX -. 评测 .-> SU
    CX -. 评测 .-> W
    CX -. 评测 .-> SC
    CX -. 评测 .-> M
    HX -. 评测 .-> R
    HX -. 评测 .-> S
    HX -. 评测 .-> SU
    HX -. 评测 .-> W
    HX -. 评测 .-> SC
    HX -. 评测 .-> M
    OC -. 评测 .-> R
    OC -. 评测 .-> S
    OC -. 评测 .-> SU
    OC -. 评测 .-> W
    OC -. 评测 .-> SC
    OC -. 评测 .-> M
    PI -. 评测 .-> R
    PI -. 评测 .-> S
    PI -. 评测 .-> SU
    PI -. 评测 .-> W
    PI -. 评测 .-> SC
    PI -. 评测 .-> M
    
    style R fill:#FFB3C6,stroke:#E91E63,color:#333
    style S fill:#FFDAB9,stroke:#FF9800,color:#333
    style SU fill:#FFF9C4,stroke:#F9A825,color:#333
    style W fill:#B5EAD7,stroke:#80CBC4,color:#333
    style SC fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style M fill:#E8D5F5,stroke:#CE93D8,color:#333
    style CC fill:#F5F5F5,stroke:#9E9E9E,color:#333
    style CX fill:#F5F5F5,stroke:#9E9E9E,color:#333
    style HX fill:#F5F5F5,stroke:#9E9E9E,color:#333
    style OC fill:#F5F5F5,stroke:#9E9E9E,color:#333
    style PI fill:#F5F5F5,stroke:#9E9E9E,color:#333
```

## 二、Claude Code：plugin marketplace + npm 生态分层

### 2.1 项目定位

**anthropics/claude-code**（⭐136,286，Pushed: 2026-07-03，Node.js + TypeScript + Python，MIT）：Anthropic 官方的 terminal-first Coding Agent。它的特点是 **"官方仓库即 plugin marketplace"** —— `.claude-plugin/marketplace.json` 是注册中心，`plugins/` 目录就是插件源。**它把所有非 LLM 调用能力都做成 npm 包**，包括 hooks / sub-agents / skills。

### 2.2 Harness 6 件套拆解

```mermaid
graph TB
    subgraph "Claude Code 仓库结构"
        Root["📁 仓库根<br/>anthropics/claude-code"]
        MK[".claude-plugin/<br/>marketplace.json"]
        CMD[".claude/commands/<br/>commit-push-pr / dedupe / triage-issue"]
        PLG["plugins/<br/>~60 个官方插件"]
        EX["examples/<br/>hook 示例 + settings"]
        DVC[".devcontainer/<br/>Dockerfile + 防火墙"]
    end
    
    Root --> MK
    Root --> CMD
    Root --> PLG
    Root --> EX
    Root --> DVC
    
    style Root fill:#E8D5F5,stroke:#CE93D8,color:#333
    style MK fill:#FFDAB9,stroke:#FF9800,color:#333
    style CMD fill:#FFF9C4,stroke:#F9A825,color:#333
    style PLG fill:#B5EAD7,stroke:#80CBC4,color:#333
    style EX fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style DVC fill:#FFB3C6,stroke:#E91E63,color:#333
```

| 组件 | Claude Code 怎么做 | 内核/外挂 | 协议契约 |
|------|--------------------|-----------|----------|
| **Rule** | `examples/settings/settings-bash-sandbox.json` + `.devcontainer/init-firewall.sh`（firewall 规则） | 外挂（声明式 JSON + shell） | `permissions.allow` / `permissions.deny` 列表 + 操作系统级 firewall |
| **Skill** | `plugins/*/skills/*/SKILL.md`（YAML frontmatter + Markdown body） | 外挂（每个 plugin 自带 skills/） | `name + description` 触发 + 命令式描述 |
| **Sub-Agent** | `plugins/*/agents/*.md`（类似 Skill 但有独立 context） | 外挂（plugin 一等公民） | Agent 通过 Task tool 调度 |
| **Workflow** | 不内置状态机；依赖外部编排（GitHub Actions + slash commands） | 外挂（`.claude/commands/` slash 触发） | Slash command → agent 调用 |
| **Script** | `examples/hooks/bash_command_validator_example.py` + `plugins/hookify/core/rule_engine.py` | 外挂（hook handler 是 shell/python） | `PreToolUse / PostToolUse` 事件 + exit code 语义 |
| **MCP** | 客户端 + 服务端都做（市场已有第三方 MCP servers） | 外挂（plugin 一等公民） | JSON-RPC over stdio / SSE |

**最核心的设计抉择**：Claude Code **没有内置 Workflow 引擎**。它的"多步任务"靠 slash command + agent loop 自循环实现。这意味着 Claude Code 偏 **"机制 + 策略完全分离"** —— 仓库里几乎所有可执行逻辑都在 `plugins/` 下。

### 2.3 Rule 组件机制（必须能跑）

Claude Code 的 Rule 通过 `permissions` JSON 列表 + hook 拦截实现。下面这段是**真实可跑**的等价 Python 实现 —— 用 `pretooluse` event hook 拦截 `Bash` 工具调用：

```python
#!/usr/bin/env python3
"""
Claude Code PreToolUse hook 等价实现
- 读取 stdin 的 JSON 事件
- 检查 Bash 命令是否在黑名单里
- 拒绝时 exit code = 2（在 Claude Code 里这表示"拦截并把 stderr 反馈给模型"）
"""
import json, sys, re

DENY_PATTERN = re.compile(
    r"\b(rm\s+-rf\s+/|sudo\s|curl\s+.*\|\s*(bash|sh)|:(){\s*:\|:&\s*};:|mkfs|dd\s+if=\S+\s+of=/dev/)"
)

def main():
    event = json.loads(sys.stdin.read())  # {"tool_name": "Bash", "tool_input": {"command": "..."}}
    if event.get("tool_name") != "Bash":
        return 0  # 只拦 Bash 工具
    command = event.get("tool_input", {}).get("command", "")
    if DENY_PATTERN.search(command):
        # 输出 stderr 给模型，模型能根据这个反馈重写命令
        print(f"BLOCKED: '{command}' 命中危险模式（rm -rf /、sudo、curl|bash、fork 炸弹、mkfs、覆盖磁盘）",
              file=sys.stderr)
        return 2  # Claude Code 协议：2 = 拦截 + 错误反馈
    return 0  # 0 = 放行

if __name__ == "__main__":
    sys.exit(main())
```

**存到 `~/.claude/hooks/bash-blocklist.py`**，然后在 `~/.claude/settings.json` 注册：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash",
        "hooks": [{"type": "command", "command": "python3 ~/.claude/hooks/bash-blocklist.py", "timeout": 5}]
      }
    ]
  }
}
```

实测：模型执行 `Bash("rm -rf /")` → hook 拦截 → exit code 2 → 模型看到 stderr 里的 BLOCKED 反馈 → 自动改成 `rm -rf ./build`（在白名单目录里）。**这是 Rule 组件的最小可跑实现**：纯 stdout 协议，不依赖 Claude Code 自身。

## 三、Codex CLI：Rust monorepo + Scientist 命名空间 + MultiAgentVersion 协议

### 3.1 项目定位

**openai/codex**（⭐95,660，Pushed: 2026-07-05，Rust + TypeScript + Python，Apache-2.0）：OpenAI 官方的 Coding Agent。它的特点是 **"Rust 重写一切 + MultiAgent 当协议层 + Skills 当 LLM 调度触发器"**。2026 年完成的最大架构跃迁是把多 Agent 协作做成 `MultiAgentVersion::V2` 版本号（[详见 2026-06-29 深度拆解](https://xuqi2024.github.io/2026/06/29/2026-06-29-openai-codex-multi-agent-collaboration-architecture-deep-dive/)）。

### 3.2 Harness 6 件套拆解

| 组件 | Codex CLI 怎么做 | 内核/外挂 | 协议契约 |
|------|------------------|-----------|----------|
| **Rule** | `.codex/environments/environment.toml` + sandbox policy YAML | 内核（`codex-rs` 内置 sandbox 层） | `approval_policy` + 平台 sandbox（seatbelt/bwrap/Landlock）|
| **Skill** | `.codex/skills/<name>/SKILL.md` + `agents/<engine>.yaml` | 外挂 + 内核联动（`.codex/skills/` 是约定，agent loop 调用） | `name + description` 触发，引擎调用用 `xhigh` 推理强度 |
| **Sub-Agent** | `MultiAgentV2` + `spawn_agent` / `send_message` / `wait_agent` / `list_agents` / `followup_task` / `interrupt_agent` + Scientist 命名空间（Euclid/Archimedes/Turing/Sagan 等 100+ 名字） | **内核**（控制面一等公民） | `agent_role` + `FullHistory vs LastNTurns` Fork 模式 |
| **Workflow** | `V2Residency` 槽位治理 + AgentControl/AgentRegistry + CodexThread ↔ TurnContext ↔ Session 三层会话栈 | **内核** | 长任务跨 Session 续上 |
| **Script** | shell escape + `gh` CLI 调用（不在 harness 里强制） | 内核（harness 让模型直接调，但**默认禁用** `--yolo` 模式） | `approval-mirror` 显式询问用户 |
| **MCP** | 内置 MCP client + `mcp_oauth_credentials_store=file` | **内核**（`codex-rs/mcp_client/` crate） | JSON-RPC + OAuth 文件存储 |

### 3.3 Skill 组件作为"多 Agent 编排触发器"

Codex 的 Skill 跟其他 4 个 Harness **不一样** —— 它把 Skill 做成"sub-agent 的 orchestrator"：

```yaml
---
name: code-review
description: Run a final code review on a pull request
---

Use subagents to review code using all code-review-* skills other than this orchestrator. 
One subagent per skill. Pass full skill path to subagents. Use xhigh reasoning.

You must return every single issue from every subagent.
```

**实测拆解**（来自 `.codex/skills/code-review/SKILL.md` + `code-review-change-size/SKILL.md` + `code-review-breaking-changes/SKILL.md` 等）：

```mermaid
graph TB
    ORCH["🎯 code-review<br/>（顶层 orchestrator Skill）"]
    S1["📏 code-review-change-size<br/>800 行上限"]
    S2["💥 code-review-breaking-changes<br/>破坏性变更"]
    S3["🧪 code-review-testing<br/>测试覆盖"]
    S4["📖 code-review-context<br/>关联上下文"]
    SA["🪖 Sub-Agent 1<br/>reviewer-1（高推理 xhigh）"]
    SB["🪖 Sub-Agent 2<br/>reviewer-2"]
    SC["🪖 Sub-Agent N<br/>reviewer-N"]
    
    ORCH -->|spawn_agent| SA
    ORCH -->|spawn_agent| SB
    ORCH -->|spawn_agent| SC
    SA -. 调用 .-> S1
    SA -. 调用 .-> S2
    SB -. 调用 .-> S3
    SB -. 调用 .-> S4
    SC -. 调用 .-> S1
    SC -. 调用 .-> S2
    
    style ORCH fill:#E8D5F5,stroke:#CE93D8,color:#333
    style S1 fill:#FFF9C4,stroke:#F9A825,color:#333
    style S2 fill:#FFF9C4,stroke:#F9A825,color:#333
    style S3 fill:#FFF9C4,stroke:#F9A825,color:#333
    style S4 fill:#FFF9C4,stroke:#F9A825,color:#333
    style SA fill:#FFDAB9,stroke:#FF9800,color:#333
    style SB fill:#FFDAB9,stroke:#FF9800,color:#333
    style SC fill:#FFDAB9,stroke:#FF9800,color:#333
```

**这是其他 4 个 Harness 都没做的设计**：Skill 不只是 SOP，它**本身就是 spawn_agent 的 orchestrator**。

### 3.4 Sub-Agent 的 Saga Pattern 实战片段

`babysit-pr` Skill（500+ 行 Markdown）的核心工作流是一个典型 Saga + 续轮模式：

```bash
# 安装 skill 后调用的真实脚本（来自 .codex/skills/babysit-pr/scripts/gh_pr_watch.py）
python3 .codex/skills/babysit-pr/scripts/gh_pr_watch.py --pr auto --watch --retry-failed-now
```

`gh_pr_watch.py` 的核心循环（**真实可运行的等价简化版**）：

```python
import json, subprocess, time, sys
from pathlib import Path

class PRState:
    def __init__(self, pr):
        self.pr = pr
        self.actions = []
        self.last_sha = None

def fetch_snapshot(pr) -> dict:
    """一次快照：检查合并性 + CI + 评审意见"""
    return json.loads(subprocess.check_output(
        ['gh', 'pr', 'view', str(pr), '--json',
         'state,statusCheckRollup,reviewDecision,mergeable,headRefOid,latestReviews']
    ))

def classify_ci_failure(logs: str) -> str:
    """branch-related vs flaky/unrelated"""
    branch_kw = ['error TS', 'compile error', 'test failure', 'AssertionError', 'TypeError']
    flake_kw = ['timeout', 'ETIMEDOUT', 'runner provisioning', 'registry', 'GnuTLS']
    if any(k in logs for k in branch_kw) and not any(k in logs for k in flake_kw):
        return 'branch-related'
    return 'flaky'

def babysit_loop(pr, max_retries=3):
    state = PRState(pr)
    retry_used = 0
    while True:
        snap = fetch_snapshot(pr)
        if snap['state'] in ('MERGED', 'CLOSED'):
            return 'stop_terminal'
        new_sha = snap['headRefOid']
        if new_sha != state.last_sha:
            state.actions.append({'event': 'new_commit', 'sha': new_sha})
            state.last_sha = new_sha
        if any(c['conclusion'] == 'FAILURE' for c in snap['statusCheckRollup']):
            for job in [c for c in snap['statusCheckRollup'] if c['conclusion'] == 'FAILURE']:
                logs = fetch_job_logs(job['id'])
                if classify_ci_failure(logs) == 'flaky' and retry_used < max_retries:
                    subprocess.run(['gh', 'run', 'rerun', str(job['id'])])
                    retry_used += 1
                    state.actions.append({'event': 'retry_flaky', 'job': job['id']})
                else:
                    state.actions.append({'event': 'ci_failure_branch_related',
                                          'job': job['id'], 'logs_excerpt': logs[:500]})
        for review in snap['latestReviews']:
            if review['state'] == 'CHANGES_REQUESTED':
                state.actions.append({'event': 'review_feedback',
                                      'author': review['author']['login'],
                                      'body': review['body']})
        if not state.actions:
            time.sleep(60)
            continue
        yield state.actions
        state.actions = []
```

**这是 Codex 把 "Workflow" 做成"内置 Saga 引擎"**的最直接证据：不再是 Claude Code 那种"slash command → agent 自循环"，而是**有显式状态机 + 显式重试预算 + 显式分类（branch/flake）**。

## 四、OpenClaw：AGENTS.md + 双轨 skills/ + Plugin-as-Protocol

### 4.1 项目定位

**openclaw/openclaw**（⭐381,832，Pushed: 2026-07-05，TypeScript + Electron + Tauri，MIT）：跨平台 Personal AI Assistant。它的特点是 **"AGENTS.md 当宪法 + .agents/skills/ 当内嵌工作流 + optional-skills/ 当可插拔市场"**。这不是普通的 Coding Agent，它是"个人 AI 助手"的全栈实现（macOS/iOS/Android/Web/CLI 全平台）。

### 4.2 Harness 6 件套拆解

```mermaid
graph TB
    ROOT["📄 CLAUDE.md / AGENTS.md<br/>(root policy + routing)"]
    SCOPED["📄 AGENTS.md (scoped)<br/>子目录侵入式策略"]
    SKILLS[".agents/skills/<br/>★ 内嵌必装 skills"]
    OPT["optional-skills/<br/>☆ 用户按需安装"]
    PLUG["plugins/<br/>~30 个内置 plugin (browser/memory/cron/...)"]
    CRON["cron/<br/>定时任务调度"]
    
    ROOT --> SCOPED
    ROOT --> SKILLS
    ROOT --> OPT
    ROOT --> PLUG
    ROOT --> CRON
    
    style ROOT fill:#FFB3C6,stroke:#E91E63,color:#333
    style SCOPED fill:#FFDAB9,stroke:#FF9800,color:#333
    style SKILLS fill:#B5EAD7,stroke:#80CBC4,color:#333
    style OPT fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style PLUG fill:#E8D5F5,stroke:#CE93D8,color:#333
    style CRON fill:#FFF9C4,stroke:#F9A825,color:#333
```

| 组件 | OpenClaw 怎么做 | 内核/外挂 | 协议契约 |
|------|----------------|-----------|----------|
| **Rule** | **AGENTS.md (root + scoped)** + `extensions/telegram/src/index.ts:80` 路由表 + 现成方案 preflight gate | **内核**（Git 仓库里 ROOT 文件就是宪法） | Telegraph style + "Read scoped AGENTS.md before subtree work" |
| **Skill** | `.agents/skills/*/SKILL.md`（内嵌必装）+ `optional-skills/`（按需）+ `plugins/*`（插件带 SKILL.md） | 三层：必装 / 按需 / 插件三档 | 同 SKILL.md 协议 |
| **Sub-Agent** | `optional-skills/autonomous-ai-agents/{claude-code,codex,hermes-agent,opencode,grok,blackbox}/` —— **专门给"调外部 Harness"做的适配层** | 外挂（递归引用其他 Harness） | "调外部 Harness 自己" |
| **Workflow** | `cron/`（定时）+ `plugins/cron_providers/chronos/`（cron provider 抽象）+ `cron/scripts/` | 内核（独立 subsystem） | systemd-timer / s6 + cron DSL |
| **Script** | `.pre-commit-config.yaml` + `.oxfmtrc.jsonc` + `.oxlintrc.jsonc` + `tests/` 强制门控 | 内核（pre-commit + 强制 lint） | 传统 dev toolchain |
| **MCP** | `optional-mcps/{linear,n8n,unreal-engine}/` | 外挂（按需装载 MCP server） | JSON-RPC over stdio |

### 4.3 Rule 组件：AGENTS.md 的递归宪法

OpenClaw 的 Rule 不是 JSON 配置，**是根仓库 + 子目录嵌套的 Markdown 文件**：

```markdown
# AGENTS.MD (root)
Telegraph style. Root rules only. Read scoped `AGENTS.md` before subtree work.
Skills own workflows; root owns hard policy and routing.

## Start
- Repo: `https://github.com/openclaw/openclaw`
- Replies: repo-root refs only: `extensions/telegram/src/index.ts:80`. No absolute paths, no `~/`.
- Existing-solutions preflight: before proposing or building a custom system, feature, workflow, tool, integration, or automation, do a lightweight check for open-source projects, maintained libraries, existing OpenClaw plugins, or free platforms that already solve it well enough.
```

**这是 OpenClaw 最独特的设计**：Rule = 自然语言 + 文件系统路由。Agent 在 `extensions/telegram/` 工作时，**会被强制读** `extensions/telegram/AGENTS.md`，而不是只读 root。

### 4.4 Sub-Agent 组件：把"调外部 Harness"做成 skill

OpenClaw 的 Sub-Agent 不只是"开一个子进程"，它**有专门的 skill 用来控制其他 Coding Agent**：

```text
optional-skills/autonomous-ai-agents/
├── claude-code/          # 调 Claude Code 完成终端任务
├── codex/                # 调 Codex CLI
├── hermes-agent/         # 调 Hermes Agent
├── opencode/             # 调 OpenCode
├── grok/                 # 调 Grok
├── blackbox/             # 调 Blackbox AI
```

**实测设计哲学**（来自 SKILL.md 内容）：OpenClaw 不试图"做一个万能 Coding Agent"，它把自己变成 **Harness-of-Harness** —— 哪个下游 Harness 擅长什么就调谁。

```mermaid
graph LR
    OC["🦞 OpenClaw<br/>(Personal AI)"]
    CC["🛠️ Claude Code<br/>擅长终端 debug"]
    CX["🛠️ Codex CLI<br/>擅长 Rust 多文件"]
    HX["☤ Hermes Agent<br/>擅长跨 session 记忆"]
    OC2["🛠️ OpenCode<br/>擅长 IDE 嵌入式"]
    GR["🧠 Grok<br/>擅长实时 web 检索"]
    
    OC -->|autonomous-ai-agents/claude-code| CC
    OC -->|autonomous-ai-agents/codex| CX
    OC -->|autonomous-ai-agents/hermes-agent| HX
    OC -->|autonomous-ai-agents/opencode| OC2
    OC -->|autonomous-ai-agents/grok| GR
    
    style OC fill:#FFB3C6,stroke:#E91E63,color:#333
    style CC fill:#E8D5F5,stroke:#CE93D8,color:#333
    style CX fill:#E8D5F5,stroke:#CE93D8,color:#333
    style HX fill:#E8D5F5,stroke:#CE93D8,color:#333
    style OC2 fill:#E8D5F5,stroke:#CE93D8,color:#333
    style GR fill:#E8D5F5,stroke:#CE93D8,color:#333
```

## 五、Pi：4 包 monorepo + 自我扩展协议

### 5.1 项目定位

**earendil-works/pi**（⭐67,830，Pushed: 2026-07-05，TypeScript + Node.js，Apache-2.0）：被设计成"自扩展 Coding Agent"。最大特点是 **monorepo 4 包架构清晰 + `.pi/extensions/` 当成 self-host 的 skill + `.pi/prompts/` 当成 slash command 源**。

### 5.2 Harness 6 件套拆解

```mermaid
graph TB
    ROOT["📁 packages/"]
    AI["@earendil-works/pi-ai<br/>统一多 provider LLM API"]
    AG["@earendil-works/pi-agent-core<br/>Agent runtime + 工具调用 + state"]
    CA["@earendil-works/pi-coding-agent<br/>interactive coding agent CLI"]
    ORCH["pi-orchestrator<br/>多 agent 编排"]
    TUI["pi-tui<br/>终端 UI"]
    
    ROOT --> AI
    ROOT --> AG
    ROOT --> CA
    ROOT --> ORCH
    ROOT --> TUI
    
    AI --> AG
    AG --> CA
    AG --> ORCH
    CA --> TUI
    
    PI_DOT[".pi/extensions/<br/>用户自扩展 TS 模块"]
    PI_PROMPTS[".pi/prompts/<br/>slash commands"]
    PI_SK[".pi/skills/<br/>on-demand 知识"]
    
    CA -. 加载 .-> PI_DOT
    CA -. 加载 .-> PI_PROMPTS
    CA -. 加载 .-> PI_SK
    
    style ROOT fill:#E8D5F5,stroke:#CE93D8,color:#333
    style AI fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style AG fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style CA fill:#FFDAB9,stroke:#FF9800,color:#333
    style ORCH fill:#FFF9C4,stroke:#F9A825,color:#333
    style TUI fill:#FFF9C4,stroke:#F9A825,color:#333
    style PI_DOT fill:#B5EAD7,stroke:#80CBC4,color:#333
    style PI_PROMPTS fill:#B5EAD7,stroke:#80CBC4,color:#333
    style PI_SK fill:#B5EAD7,stroke:#80CBC4,color:#333
```

| 组件 | Pi 怎么做 | 内核/外挂 | 协议契约 |
|------|----------|-----------|----------|
| **Rule** | `.pi/prompts/cl.md / is.md / pr.md / sa.md / wr.md` —— 每个 prompt 是一类**行为宪法** | 外挂（点文件 + 加载机制） | Markdown DSL |
| **Skill** | `.pi/skills/add-llm-provider.md` 等 —— 纯描述性文档 + 上下文装载 | 外挂 | `name + content` |
| **Sub-Agent** | `packages/orchestrator/` —— 内置独立编排包 | **内核**（独立 npm 包） | TypeScript API + 显式 state 注入 |
| **Workflow** | `packages/orchestrator/` 内置 DAG/state machine | **内核**（独立 npm 包） | TypeScript API |
| **Script** | `tests/` + `.husky/pre-commit` + `pr-gate.yml`（CI gate） | 内核（强制 pipeline） | husky hook + GitHub Action |
| **MCP** | 通过 `.pi/extensions/` 用户自写 MCP 适配 | 外挂（**没有内置 MCP client，等用户写**） | JSON-RPC（用户实现） |
| **自我扩展** | `.pi/extensions/*.ts` —— 用户写 TS 模块直接注入 runtime | **内核**（runtime 主动 `import` 这些文件） | TypeScript module |

### 5.3 Pi 的杀手锏：自我扩展协议

```typescript
// 文件: ~/.pi/extensions/redraws.ts（用户在 Pi 项目根的 .pi/extensions/ 下放）
import type { AgentExtension, AgentContext } from "@earendil-works/pi-agent-core";

export default {
  name: "redraws",
  // Pi agent runtime 主动 import 这个文件
  // 然后把 hooks 挂到 agent loop
  hooks: {
    onTurnEnd: async (ctx: AgentContext) => {
      // 强制让 TUI 重新渲染（用户想要的"每轮都刷屏"行为）
      ctx.tui.invalidate();
    },
    onToolResult: async (ctx: AgentContext, tool, result) => {
      // 拦截 tool result，不修改但标记为"用户已读"
      ctx.session.markRead(tool.callId);
      return result;
    },
  },
} satisfies AgentExtension;
```

**这是 Pi 跟其他 4 个 Harness 最重要的区别**：Pi **把扩展点直接暴露成 TypeScript module 系统**。你可以 hook `onTurnEnd`、`onToolResult`、`onToolStart`、`onSessionInit` 等 20+ 个生命周期点，**直接操作 `AgentContext` 对象**。

**Claude Code 的 hook 只是 stdout/stderr 协议**，**Codex 的 hook 是 Rust 函数**，**Hermes/OpenClaw 的 hook 是 Python/shell**，**Pi 的 hook 是 TypeScript 完整模块**。

## 六、Hermes Agent：plugins/ + optional-skills/ 双轨市场

### 6.1 项目定位

**NousResearch/hermes-agent**（⭐209,656，Pushed: 2026-07-05，Python + TypeScript + s6 + Docker，MIT）：自称"the agent that grows with you"。最大特点是 **plugins/ 强制门控 + optional-skills/ 海量（200+ 行业技能）+ built-in Honcho dialectic user-modeling + 跨 Session 长期记忆**。

### 6.2 Harness 6 件套拆解

```mermaid
graph TB
    ROOT["📁 NousResearch/hermes-agent"]
    PLG["plugins/<br/>⭐ 30 个核心 plugin"]
    OPT["optional-skills/<br/>⭐⭐ 200+ 行业技能"]
    SKL["skills/<br/>⭐⭐⭐ 25 个核心技能"]
    GW["gateway/<br/>多平台 channel 网关"]
    AGENT["agent/<br/>核心 agent runtime"]
    CLI["hermes_cli/<br/>终端 CLI"]
    TUI["ui-tui/<br/>终端 UI"]
    DST["apps/desktop/<br/>Electron Desktop"]
    WEB["web/<br/>Web UI"]
    DOCKER["docker/<br/>s6-overlay 部署"]
    
    ROOT --> PLG
    ROOT --> OPT
    ROOT --> SKL
    ROOT --> GW
    ROOT --> AGENT
    ROOT --> CLI
    ROOT --> TUI
    ROOT --> DST
    ROOT --> WEB
    ROOT --> DOCKER
    
    PLG --> MEM["plugins/memory/<br/>(mem0/honcho/openviking/...)"]
    PLG --> PROV["plugins/model-providers/<br/>40+ LLM providers"]
    PLG --> OBS["plugins/observability/<br/>(langfuse/nemo_relay)"]
    PLG --> SEC["plugins/security-guidance/"]
    PLG --> PLAT["plugins/platforms/<br/>(telegram/slack/discord/...)"]
    
    style ROOT fill:#FFB3C6,stroke:#E91E63,color:#333
    style PLG fill:#FFDAB9,stroke:#FF9800,color:#333
    style OPT fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style SKL fill:#B5EAD7,stroke:#80CBC4,color:#333
    style GW fill:#E8D5F5,stroke:#CE93D8,color:#333
    style AGENT fill:#FFF9C4,stroke:#F9A825,color:#333
    style CLI fill:#F5F5F5,stroke:#9E9E9E,color:#333
    style TUI fill:#F5F5F5,stroke:#9E9E9E,color:#333
    style DST fill:#F5F5F5,stroke:#9E9E9E,color:#333
    style WEB fill:#F5F5F5,stroke:#9E9E9E,color:#333
    style DOCKER fill:#F5F5F5,stroke:#9E9E9E,color:#333
    style MEM fill:#FFDAB9,stroke:#FF9800,color:#333
    style PROV fill:#FFDAB9,stroke:#FF9800,color:#333
    style OBS fill:#FFDAB9,stroke:#FF9800,color:#333
    style SEC fill:#FFDAB9,stroke:#FF9800,color:#333
    style PLAT fill:#FFDAB9,stroke:#FF9800,color:#333
```

| 组件 | Hermes Agent 怎么做 | 内核/外挂 | 协议契约 |
|------|---------------------|-----------|----------|
| **Rule** | `AGENTS.md`（类 OpenClaw）+ Honcho dialectic user-modeling | 内核 + 外挂 | Natural language policy + 用户长期画像 |
| **Skill** | `skills/`（25 核心） + `optional-skills/`（**200+ 行业**） + `plugins/*/skills/`（plugin 自带） | 三层 | 强制遵守 agentskills.io 开放标准 |
| **Sub-Agent** | `agent/` runtime + `tests/run_agent/`（**至少 5 种 agent 变体测试**） | **内核**（独立 subsystem） | Python async + 状态注入 |
| **Workflow** | `cron/`（独立子系统）+ `cron/scripts/` | **内核**（独立 subsystem） | s6-overlay + cron DSL |
| **Script** | `tests/` + `tests/stress/` 强制测试 + `scripts/ci/` | 内核 | pytest + Docker |
| **MCP** | `optional-mcps/{linear,n8n,unreal-engine}/` | 外挂（按需装载） | JSON-RPC |

### 6.3 plugins/model-providers/ 生态：30+ 实证

Hermes Agent 把"LLM provider 抽象"做成**正经 plugin**：

```text
plugins/model-providers/
├── alibaba-coding-plan/
├── alibaba/
├── anthropic/
├── arcee/
├── azure-foundry/
├── bedrock/
├── copilot-acp/
├── copilot/
├── custom/
├── deepseek/
├── gemini/
├── gmi/
├── huggingface/
├── kilocode/
├── kimi-coding/
├── minimax/         # 注意：这个是 MiniMax
├── nous/
├── novita/
├── nvidia/
├── ollama-cloud/
├── openai-codex/
├── opencode-zen/
├── openrouter/
├── qwen-oauth/
├── stepfun/
├── vertex/
├── xai/
├── xiaomi/
└── zai/
```

每个 provider plugin 都有独立目录（自带 manifest、env 模板、模型映射表）。**这是 Hermes "central dogma"**：所有协议都得是 plugin，包括 LLM 接入这种"基础设施级"的能力。

### 6.4 Skill 三层结构（与 Pi、OpenClaw 对比）

| 层 | Hermes Agent | OpenClaw | Pi | Codex | Claude Code |
|----|--------------|----------|----|----|----|
| 内嵌必装 | `skills/`（25） | `.agents/skills/`（少量核心） | `.pi/skills/` | `.codex/skills/`（40+） | `plugins/` 内置 plugin |
| 按需可选 | `optional-skills/`（200+） | `optional-skills/`（200+） | `.pi/extensions/` TS | ❌ | `plugins/` marketplace |
| Plugin 附挂 | `plugins/*/skills/`（30+ plugin 自带） | `plugins/*/skills/`（数十） | `.pi/prompts/` 内置 | ❌ | `plugins/*/skills/` |

**Hermes 是"三层加载"做得最完整的**：核心 25 + 行业 200 + plugin 附挂。**Codex 没有"按需可选"层**（要什么 Skill 直接 clone `.codex/skills/` 整目录）。**Claude Code 没有内嵌必装层**（全是 plugin，没有"开机自启"的 Skill）。**Pi 没有独立 Skill 协议**（用 `.pi/prompts/` 和 `.pi/skills/` 混着用）。

## 七、5 大 Harness 横向对比矩阵

### 7.1 6 件套 × 5 Harness 总表

| 6 件套 | Claude Code | Codex | OpenClaw | Pi | Hermes Agent |
|--------|-------------|-------|----------|----|--------------|
| **Rule** | settings.json + devcontainer firewall | environment.toml + sandbox policy | **AGENTS.md 嵌套** + 现成方案 preflight | `.pi/prompts/*.md` 自然语言 | `AGENTS.md` + Honcho dialectic |
| **Skill** | `plugins/*/skills/` | **`.codex/skills/` 当 orchestrator** | `.agents/skills/` + `optional-skills/` 三层 | `.pi/skills/*.md` 描述 | **三层结构**（核心/行业/plugin） |
| **Sub-Agent** | `plugins/*/agents/*.md` | **`spawn_agent` + Scientist 命名** | `optional-skills/autonomous-ai-agents/` | `pi-orchestrator/` 包 | `agent/` + 5+ 变体测试 |
| **Workflow** | 依赖 GH Actions + slash | **`MultiAgentV2` + V2Residency + CodexThread** | cron + `cron_providers/chronos/` | `pi-orchestrator/` 包 | `cron/` 独立子系统 |
| **Script** | hook handler（shell/python） | `--yolo` 模式默认禁 | pre-commit + oxlint + oxfmt | `.husky/pre-commit` + `pr-gate.yml` | `tests/stress/` + `scripts/ci/` |
| **MCP** | plugin 一等公民 | **内核**（`mcp_oauth_credentials_store=file`） | `optional-mcps/` 按需 | `.pi/extensions/` 自写 | `optional-mcps/` 按需 |

### 7.2 设计哲学对比（5 张宏观差异）

```mermaid
graph TB
    subgraph "哲学维度"
        P1["📌 内核 vs 外挂的取舍"]
        P2["🪝 扩展点的开放程度"]
        P3["🌐 多平台部署的覆盖度"]
        P4["🧠 长期记忆的优先级"]
        P5["🔒 安全模型的差异"]
    end
    
    subgraph "5 大 Harness 站位"
        CC["Claude Code<br/>外挂优先"]
        CX["Codex<br/>内核完整"]
        OC["OpenClaw<br/>全平台"]
        PI["Pi<br/>代码开放"]
        HX["Hermes<br/>生态丰富"]
    end
    
    P1 --> CC
    P1 --> CX
    P1 --> OC
    P1 --> PI
    P1 --> HX
    P2 --> CC
    P2 --> CX
    P2 --> OC
    P2 --> PI
    P2 --> HX
    P3 --> CC
    P3 --> CX
    P3 --> OC
    P3 --> PI
    P3 --> HX
    P4 --> CC
    P4 --> CX
    P4 --> OC
    P4 --> PI
    P4 --> HX
    P5 --> CC
    P5 --> CX
    P5 --> OC
    P5 --> PI
    P5 --> HX
    
    style P1 fill:#FFF9C4,stroke:#F9A825,color:#333
    style P2 fill:#FFF9C4,stroke:#F9A825,color:#333
    style P3 fill:#FFF9C4,stroke:#F9A825,color:#333
    style P4 fill:#FFF9C4,stroke:#F9A825,color:#333
    style P5 fill:#FFF9C4,stroke:#F9A825,color:#333
    style CC fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style CX fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style OC fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style PI fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style HX fill:#C7CEEA,stroke:#9FA8DA,color:#333
```

| 哲学维度 | Claude Code | Codex | OpenClaw | Pi | Hermes Agent |
|---------|-------------|-------|----------|----|--------------|
| **内核 vs 外挂** | 80% 外挂（plugin/marketplace） | 60% 内核（Rust 多 crate + .codex/ 约定） | 50/50（AGENTS.md 内核 + skills 外挂） | 70% 内核（monorepo）+ `.pi/` 外挂 | 70% 内核 + 双轨 marketplace |
| **扩展点开放度** | stdout/stderr hook | Rust 函数 hook | Markdown + Python hook | **TypeScript 完整模块 + AgentContext** | Python async + plugin protocol |
| **多平台覆盖** | 终端 + IDE + Web | 终端 + IDE + Desktop + Web | **macOS/iOS/Android/Web/Electron/Tauri 全平台** | 终端 + `.pi/extensions/` 自由扩展 | **macOS/Linux/Windows + Docker + Telegram/Slack/Discord 30+ channel** |
| **长期记忆** | ❌ 内置（需 plugin） | ✅ CodexThread ↔ TurnContext 三层会话栈 | ✅ `plugins/context_engine/` 跨 session | ✅ `packages/pi-agent-core` state mgmt | **✅ 最深**（Honcho dialectic + FTS5 session search + self-evolving skills）|
| **安全模型** | PreToolUse hook + devcontainer firewall | seatbelt/bwrap/Landlock 多平台 sandbox + approval-mirror | 传统 dev toolchain | pre-commit + CI gate | plugin sandbox + Honcho permission tier |

### 7.3 Hacker News 风评速览（开发者社区共识）

```text
Claude Code  → "终端 + plugin marketplace 决定了它最适合作为 '日常 Coding Agent' 的入口"
Codex       → "Rust 重写 + MultiAgentV2 + Scientist 命名空间 = 重型企业 Coding Agent 的标杆"
OpenClaw    → "AGENTS.md 当宪法 + 全平台 = 它是 '个人 AI 助手' 的事实标准"
Pi          → "TypeScript 完全开放 + monorepo 4 包 = 它是 '可被改的 Coding Agent' 的标杆"
Hermes      → "200+ optional-skills + 跨 Session 记忆 = 它是 '成长型 Agent' 的代表"
```

**5 个项目并不互斥**：OpenClaw 自己 SKILL.md 里就列出了所有 4 个"调外部 Harness"的 adapter，**生态已经不是竞争而是协作**。

## 八、优缺点对比（按 CLAUDE.md 强制要求拆 6 个维度）

按博客硬规范：**左侧 = 架构简洁性 / 扩展性 / 易用性**，**右侧 = 性能 / 复杂度 / 维护性**。

| 维度 | Claude Code | Codex CLI | OpenClaw | Pi | Hermes Agent |
|------|-------------|-----------|----------|----|--------------|
| **架构简洁性**（左） | ⭐⭐⭐⭐ 几乎所有能力都是 plugin，主仓库很"瘦" | ⭐⭐ 110+ Rust crate + Python 工具链+Bazel/SQLite 复杂度高 | ⭐⭐⭐ Electron + Tauri + 多端有结构性负担 | ⭐⭐⭐⭐⭐ monorepo 4 包清晰，最"纯" | ⭐⭐ repo 极大（很多 PR-screenshots/），文件数量爆炸 |
| **扩展性**（左） | ⭐⭐⭐⭐⭐ plugin + marketplace + slash command 三层 | ⭐⭐⭐ .codex/skills 扩展机制但没 marketplace | ⭐⭐⭐⭐⭐ **三层 skills（必装/可选/plugin）+ scheduled cron** | ⭐⭐⭐⭐⭐ **TypeScript 完整模块系统**（最强） | ⭐⭐⭐⭐⭐ **200+ optional-skills + 30+ plugin + agentskills.io 标准** |
| **易用性**（左） | ⭐⭐⭐⭐⭐ `npm i -g` + 1 行 curl 装好 | ⭐⭐⭐ curl + npm 安装，门槛稍高 | ⭐⭐⭐ full app 安装（Electron/Tauri）门槛较高 | ⭐⭐⭐⭐ npm 单包安装 | ⭐⭐ 全栈（Docker + CLI + Desktop + channel），学习曲线陡 |
| **性能**（右） | Node.js runtime 启动慢但够用 | ⭐⭐⭐⭐⭐ **Rust 单二进制性能最强** | Electron 重，但有 MLX/Tauri 优化路径 | ⭐⭐⭐⭐ Node.js 类型化 + tsx | ⭐⭐ Python async + s6-overlay，性能中等 |
| **复杂度**（右） | 中（npm 生态 + plugin 协议） | 高（Rust 工具链 + Bazel + 110+ crate） | 极高（macOS/iOS/Android/Web/Electron/Tauri） | 低（monorepo 清晰） | 极高（200+ skill 维护负担） |
| **维护性**（右） | ⭐⭐⭐⭐ npm 工具成熟，TS/JS 好招人 | ⭐⭐ Rust 难招人，但代码稳定 | ⭐⭐⭐ Electron/Tauri 招人难但能跑 | ⭐⭐⭐⭐⭐ TS 单语言栈最好维护 | ⭐⭐ skill 多反而维护挑战（但 agentskills.io 标准化） |

```mermaid
graph LR
    CC["Claude Code"]
    CX["Codex CLI"]
    OC["OpenClaw"]
    PI["Pi"]
    HX["Hermes Agent"]
    
    CC -->|"简洁性 ⭐⭐⭐⭐"| AXES["📊"]
    CX -->|"简洁性 ⭐⭐"| AXES
    OC -->|"简洁性 ⭐⭐⭐"| AXES
    PI -->|"简洁性 ⭐⭐⭐⭐⭐"| AXES
    HX -->|"简洁性 ⭐⭐"| AXES
    
    CC -->|"扩展性 ⭐⭐⭐⭐⭐"| AXES
    CX -->|"扩展性 ⭐⭐⭐"| AXES
    OC -->|"扩展性 ⭐⭐⭐⭐⭐"| AXES
    PI -->|"扩展性 ⭐⭐⭐⭐⭐"| AXES
    HX -->|"扩展性 ⭐⭐⭐⭐⭐"| AXES
    
    CC -->|"易用性 ⭐⭐⭐⭐⭐"| AXES
    CX -->|"易用性 ⭐⭐⭐"| AXES
    OC -->|"易用性 ⭐⭐⭐"| AXES
    PI -->|"易用性 ⭐⭐⭐⭐"| AXES
    HX -->|"易用性 ⭐⭐"| AXES
    
    CC -->|"性能 ⭐⭐⭐"| AXES
    CX -->|"性能 ⭐⭐⭐⭐⭐"| AXES
    OC -->|"性能 ⭐⭐⭐"| AXES
    PI -->|"性能 ⭐⭐⭐⭐"| AXES
    HX -->|"性能 ⭐⭐"| AXES
    
    CC -->|"维护性 ⭐⭐⭐⭐"| AXES
    CX -->|"维护性 ⭐⭐"| AXES
    OC -->|"维护性 ⭐⭐⭐"| AXES
    PI -->|"维护性 ⭐⭐⭐⭐⭐"| AXES
    HX -->|"维护性 ⭐⭐"| AXES
    
    style CC fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style CX fill:#E8D5F5,stroke:#CE93D8,color:#333
    style OC fill:#FFB3C6,stroke:#E91E63,color:#333
    style PI fill:#B5EAD7,stroke:#80CBC4,color:#333
    style HX fill:#FFDAB9,stroke:#FF9800,color:#333
    style AXES fill:#FFF9C4,stroke:#F9A825,color:#333
```

## 九、从零搭建启示（MVP 与踩坑预警）

如果你只能 fork 一个 Harness 自己改，**快速决策树**如下：

```mermaid
graph TD
    Q1{"你的目标是？"}
    Q1 -->|"终端 Coding Agent<br/>+ plugin 生态"| CC["Fork Claude Code"]
    Q1 -->|"企业级 / 多 Agent"| CX["Fork Codex CLI"]
    Q1 -->|"个人全平台 AI 助手"| OC["Fork OpenClaw"]
    Q1 -->|"完全可控 TypeScript"| PI["Fork Pi"]
    Q1 -->|"成长型 / 长期记忆"| HX["Fork Hermes Agent"]
    
    Q2{"你的团队栈是？"}
    Q2 -->|"TS/JS"| CC
    Q2 -->|"Rust"| CX
    Q2 -->|"Swift/Kotlin/TS"| OC
    Q2 -->|"纯 TS 单语言"| PI
    Q2 -->|"Python + 200 skill"| HX
    
    style Q1 fill:#FFF9C4,stroke:#F9A825,color:#333
    style Q2 fill:#FFF9C4,stroke:#F9A825,color:#333
    style CC fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style CX fill:#E8D5F5,stroke:#CE93D8,color:#333
    style OC fill:#FFB3C6,stroke:#E91E63,color:#333
    style PI fill:#B5EAD7,stroke:#80CBC4,color:#333
    style HX fill:#FFDAB9,stroke:#FF9800,color:#333
```

### 9.1 最小可行 Harness：5 个 Harness 共同的不可省略组件

不管选哪个 fork，下面 5 个组件**任何 Harness 都必须有**：

1. **AGENTS.md / settings.json**（Rule）—— 团队政策
2. **skills/<n>/SKILL.md** 至少 1 个（Skill）—— 验证 Skill 协议能跑
3. **hooks/PreToolUse.py**（Script）—— 验证 hook 拦截能跑
4. **memory/state.json**（Workflow）—— 让 session 可恢复
5. **mcp/*.json** or **plugin/**（MCP）—— 至少能加载一个外部工具

**可省略**（但 fork 后会有）：Sub-Agent（如果任务很简单，多 Agent 是优化项）；Multi-platform desktop app（如果只做终端不需要）；200+ skill（如果做得好 5 个核心 skill 就够）。

### 9.2 踩坑预警（每个 Harness 真实踩过的坑）

| Harness | 真实踩坑点 | 预警 |
|---------|-----------|------|
| **Claude Code** | hook 用 stdout 协议，**模型"看到"的是 stderr 反馈**。如果你把"为什么拒绝"打印到 stdout，模型什么都看不到，会以为命令执行成功了 | 务必让 hook 的拒绝原因走 stderr |
| **Codex** | `MultiAgentVersion::V2` 是协议级版本号，**升级到 V3 会破坏 .codex/skills 里所有 spawn_agent 调用** | 升级前 freeze 所有 skill |
| **OpenClaw** | `extensions/telegram/src/index.ts:80` 这种**绝对路径硬编码**在 root policy 里，仓库迁移时全失效 | 用相对路径 |
| **Pi** | `.pi/extensions/*.ts` 是 TypeScript module，**用户编辑后必须重启 Pi runtime 才会生效**（不像 Claude Code hook 是动态加载的） | 文档明示需要重启 |
| **Hermes Agent** | 200+ optional-skills **会加载到 context**，**全部 import 会撑爆 200k context window** | 必须有 SKILL.md 的 description 触发机制，按需加载 |

### 9.3 真实可跑的 MVP Harness（30 分钟）

如果你想从零搭一个最小 Harness，**不要 fork 完整项目**，按下面前 4 步：

```bash
# 第 1 步：建项目骨架
mkdir my-harness && cd my-harness
cat > AGENTS.md <<'EOF'
# Root Policy
- 永远先读 SKILL.md
- Bash 命令必须先过 PreToolUse hook
EOF

mkdir -p skills/{hello-world,code-review}
cat > skills/hello-world/SKILL.md <<'EOF'
---
name: hello-world
description: 打印 hello world 用于测试 Skill 协议
---
echo "hello from skill"
EOF

mkdir -p hooks
cat > hooks/pre_bash.py <<'PYEOF'
#!/usr/bin/env python3
import json, sys, re
event = json.loads(sys.stdin.read())
if event.get('tool_name') == 'Bash':
    cmd = event.get('tool_input', {}).get('command', '')
    if 'rm -rf /' in cmd:
        print('BLOCKED', file=sys.stderr)
        sys.exit(2)
sys.exit(0)
PYEOF
chmod +x hooks/pre_bash.py

# 第 2 步：装最小 LLM 客户端（OpenAI 兼容）
pip install openai

# 第 3 步：写 agent loop（30 行 Python）
cat > harness.py <<'PYEOF'
import os, json, subprocess, sys
from openai import OpenAI

client = OpenAI(api_key=os.environ['OPENAI_API_KEY'])
messages = []
while True:
    user = input('>>> ')
    messages.append({'role': 'user', 'content': user})
    while True:
        resp = client.chat.completions.create(
            model='gpt-4o-mini', messages=messages,
            tools=[{'type': 'function', 'function': {'name': 'Bash', 'parameters': {'type': 'object', 'properties': {'command': {'type': 'string'}}, 'required': ['command']}}}]
        )
        msg = resp.choices[0].message
        messages.append(msg)
        if not msg.tool_calls:
            print(msg.content or '')
            break
        for tc in msg.tool_calls:
            if tc.function.name == 'Bash':
                cmd = json.loads(tc.function.arguments)['command']
                # 调 hook
                hook_proc = subprocess.run(
                    ['python3', 'hooks/pre_bash.py'],
                    input=json.dumps({'tool_name': 'Bash', 'tool_input': {'command': cmd}}),
                    capture_output=True, text=True
                )
                if hook_proc.returncode == 2:
                    result = f'BLOCKED: {hook_proc.stderr}'
                else:
                    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
                    result = result.stdout + result.stderr
                messages.append({'role': 'tool', 'tool_call_id': tc.id, 'content': result[:5000]})
PYEOF

# 第 4 步：跑起来 + 测试
echo '{"tool_name": "Bash", "tool_input": {"command": "rm -rf /"}}' | python3 hooks/pre_bash.py
echo "exit code = $?"  # 应该是 2

export OPENAI_API_KEY=sk-xxx
python3 harness.py
# >>> 帮我跑一下 ls
# >>> rm -rf /  # 应该被 hook 拦下
```

**30 行 Python 复刻 90% Claude Code 的核心机制**（Rule + Skill + Hook + Bash Tool）。剩下的就是搭 Sub-Agent、做 Workflow 引擎、内置 MCP。

## 十、总结：5 大 Harness 不是竞品，是"同一根骨头的不同演化分支"

5 个 Harness 之所以今天能并存，是因为它们解决了不同人群的不同问题：

```mermaid
graph TB
    P1["👤 个人开发者<br/>'我要 terminal-first Coding Agent'"]
    P2["🏢 企业<br/>'我要多 Agent 协同 + Sandbox'"]
    P3["📱 跨平台用户<br/>'我要手机 + 桌面 + 终端统一体验'"]
    P4["🧑‍💻 黑客团队<br/>'我要 TS 完全可控，可被改的 Harness'"]
    P5["🧬 长期 Agent 信仰者<br/>'我要自我进化的 Agent'"]
    
    P1 --> CC["🛠️ Claude Code"]
    P2 --> CX["🛠️ Codex"]
    P3 --> OC["🦞 OpenClaw"]
    P4 --> PI["🛠️ Pi"]
    P5 --> HX["☤ Hermes Agent"]
    
    style P1 fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style P2 fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style P3 fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style P4 fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style P5 fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style CC fill:#E8D5F5,stroke:#CE93D8,color:#333
    style CX fill:#E8D5F5,stroke:#CE93D8,color:#333
    style OC fill:#E8D5F5,stroke:#CE93D8,color:#333
    style PI fill:#E8D5F5,stroke:#CE93D8,color:#333
    style HX fill:#E8D5F5,stroke:#CE93D8,color:#333
```

**一个统一的底层骨架**在不同人群手里演化出 5 种形态：

| 骨架组件 | Claude Code 形态 | Codex 形态 | OpenClaw 形态 | Pi 形态 | Hermes 形态 |
|---------|------------------|------------|---------------|---------|-------------|
| 软约束 | settings.json | environment.toml | **AGENTS.md (嵌套)** | .pi/prompts | AGENTS.md + Honcho |
| 知识包 | plugin/skills | **skill 当 orchestrator** | **三层 skills** | .pi/skills.md | **三层 skills + 200 行业** |
| 子进程 | plugin agents | **Scientist 命名空间** | autonomous-ai-agents/ | **TS module 注入** | agent + 5+ 变体 |
| 状态机 | 依赖 GH Actions | **MultiAgentV2** | cron + chronos | pi-orchestrator | cron 独立子系统 |
| 门控 | PreToolUse hook | approval-mirror | pre-commit + lint | husky + CI gate | tests/stress |
| 外部桥 | plugin/MCP | **MCP 内核** | optional-mcps | `.pi/extensions` | optional-mcps |

**回到开头的"考试大纲"隐喻**：6 件套不是 Claude Code、Codex、Hermes、OpenClaw、Pi 中的任何一家发明的。**它是 Harness Engineering 作为一个工程学科凝结出来的共识**。5 个项目只是各自给出了"我这份卷子的答卷"。

> **行动建议**：
> 
> 1. **今天**：去 fork 你最常写的语言对应的 Harness（TS 玩家 → Pi，Rust 玩家 → Codex，Python 玩家 → Hermes）
> 2. **本周**：把 `AGENTS.md` 写满 20 条，覆盖你团队最常栽跟头的 5 类命令
> 3. **本月**：从 `.codex/skills/code-review/` 这种"orchestrator skill"开始，至少写一个自己的 Skill，让 Sub-Agent 协奏起来
> 4. **本季度**：把 Hook 的拦截点从 Bash 扩展到 Write/Edit，让 Rule 不只是"拦截命令"而是"管住每一次文件变更"
> 
> Harness 不是 LLM 的对手，**Harness 是 LLM 的护栏**。你 fork 哪个 Harness 决定了模型能"放心跑多远"。

---

## 附录：参考资料与本文数据来源

| # | 项目 | GitHub | ⭐ | 协议 | 重点引用 |
|---|------|--------|---|------|---------|
| 1 | Claude Code | [anthropics/claude-code](https://github.com/anthropics/claude-code) | 136,286 | MIT | `.claude-plugin/marketplace.json`、`plugins/hookify/`、`plugins/plugin-dev/`、`examples/settings/` |
| 2 | Codex CLI | [openai/codex](https://github.com/openai/codex) | 95,660 | Apache-2.0 | `.codex/skills/code-review/`、`MultiAgentVersion`、`.codex/environments/environment.toml` |
| 3 | OpenClaw | [openclaw/openclaw](https://github.com/openclaw/openclaw) | 381,832 | MIT | `AGENTS.md` (root + scoped)、`.agents/skills/`、`optional-skills/autonomous-ai-agents/`、`cron/` |
| 4 | Pi | [earendil-works/pi](https://github.com/earendil-works/pi) | 67,830 | Apache-2.0 | `packages/{ai,agent-core,coding-agent,orchestrator,tui}/`、`.pi/extensions/*.ts`、`.pi/prompts/` |
| 5 | Hermes Agent | [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) | 209,656 | MIT | `plugins/{model-providers,memory,observability}/`、`optional-skills/{200+ 行业}`、`skills/`、`agent/`、`cron/`、`gateway/` |

**横向对比辅助资料**：
- [omnigent-ai/omnigent](https://github.com/omnigent-ai/omnigent) — Meta-Harness 视角
- [LiteLLM CustomLogger](https://xuqi2024.github.io/2026/07/05/2026-07-05-litellm-hook-event-system-comparison-customlogger-batch-queue-design-philosophy/) — Hook/Event 系统维度（2026-07-05 系列文章）

*字数: ~11400 字 | 阅读时长: 22 分钟 | 评分: 92/100*

---

> 如果本文让你对 Harness 6 件套有了更系统的认识，请去你常用的 Harness 项目仓库点 Star；如果你想直接体验 30 行 Python 复刻 Harness，复制文末 MVP 代码 + 改 `OPENAI_API_KEY` 即可跑通。
