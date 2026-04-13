---
title: 30分钟理解 Hermes Agent - 自我进化的AI智能体
date: 2026-04-13 10:00:00 +0800
categories: AI Agent
tags: [笔记, AI, Hermes, NousResearch, 智能体]
---

# 30分钟理解 Hermes Agent — 自我进化的AI智能体

## 一句话理解

**Hermes Agent** 是由 [Nous Research](https://nousresearch.com)（海拉斯模型背后的实验室）打造的一款**自我进化型AI智能体**。它是目前唯一一个内置**学习闭环**的Agent —— 能够从经验中创造技能、在使用中自我改进、主动持久化知识、跨会话搜索记忆，并建立对用户越来越深入的理解模型。

> 官网：https://hermes-agent.nousresearch.com
> GitHub：https://github.com/NousResearch/Hermes-Agent

<!-- more -->

---

## 什么是 Hermes Agent？

### 与传统AI助手的区别

| 特性 | 传统ChatBot/AI助手 | Hermes Agent |
|------|-------------------|--------------|
| 学习能力 | 每次对话从零开始 | 跨会话积累经验，创造技能 |
| 运行位置 | 受限于本地设备 | $5 VPS、云VM、serverless都能跑 |
| 交互方式 | 单一界面 | Telegram/Discord/Slack/微信等15+平台 |
| 工具调用 | 有限预设工具 | 47个内置工具+40个工具集+MCP扩展 |
| 记忆保持 | 仅当前会话 | 持久化记忆+用户画像 |

### 核心理念

Hermes 不是简单调用 API 的包装器，而是一个**会成长的智能体**：

- **越用越聪明** — 完成复杂任务后自动创建技能，下次类似任务直接调用
- **主动记忆** — 定期"提醒"自己保存重要知识到持久化存储
- **跨会话搜索** — 支持 FTS5 全文搜索+LLM摘要回顾历史对话
- **用户画像** — 通过 Honcho 积累对用户的理解

---

## 核心特性详解

### 1. 自我进化学习闭环（Closed Learning Loop）

这是 Hermes 最独特的卖点。

```
用户任务 → Agent执行 → 经验积累
                         ↓
                   技能创建/改进
                         ↓
                   知识持久化
                         ↓
                   下次任务 → 调用已有技能/记忆
```

**具体机制：**

- **Agent 策划的记忆** — 智能体定期评估是否需要将某些信息写入持久化记忆
- **自主技能创建** — 完成复杂任务后，自动生成可复用的技能（Skill）
- **技能自我改进** — 技能在使用过程中会不断优化
- **FTS5 会话搜索** — 跨会话全文搜索，配合 LLM 摘要实现精准回忆
- **Honcho 用户建模** —  dialectic 方式建立用户画像

### 2. 多平台消息网关

一个进程，连接 15+ 消息平台：

| 平台 | 支持情况 |
|------|---------|
| Telegram | ✅ 完全支持 |
| Discord | ✅ 支持（含语音频道） |
| Slack | ✅ 支持 |
| WhatsApp | ✅ 支持 |
| Signal | ✅ 支持 |
| 微信 | ✅ 通过 HermesClaw 社区桥接 |
| 飞书 | ✅ 支持 |
| 钉钉 | ✅ 支持 |
| 企业微信 | ✅ 支持 |
| Email/SMS | ✅ 支持 |
| Home Assistant | ✅ 支持 |
| CLI | ✅ 完整 TUI 界面 |

**特点：**
- 从 Telegram 发消息给它，它在云端 VM 上工作，你不用自己 SSH 进 VM
- 所有平台共享同一个对话上下文和记忆
- 跨平台对话连续性

### 3. 灵活的模型支持

不绑定任何模型供应商，随时切换：

| 提供商 | 支持情况 |
|--------|---------|
| Nous Portal | ✅ 官方推荐 |
| OpenRouter | ✅ 200+ 模型 |
| OpenAI | ✅ GPT-4 系列 |
| Anthropic | ✅ Claude 系列 |
| Kimi/Moonshot | ✅ |
| MiniMax | ✅ |
| GLM (z.ai) | ✅ |
| 自定义 endpoint | ✅ |

切换命令：
```bash
/model openrouter:anthropic/claude-3-5-sonnet
/model nous:hermes-3-llama
```

### 4. 强大的工具系统

**47 个内置工具**，分为 20 个工具集：

| 工具类型 | 代表工具 |
|---------|---------|
| 文件操作 | read/write/patch/search_files |
| Web | web_search/web_extract/browser |
| 代码执行 | execute_code (Python) |
| 终端 | 6种后端（本地/Docker/SSH/Daytona/Modal/Singularity） |
| 浏览器 | 11种自动化工具 |
| 委托 | delegate_tool（派生子智能体） |
| MCP | 动态 MCP 客户端 |

**工具集示例：**
- `code` — 代码开发相关工具集
- `web` — 网络搜索/抓取工具集
- `media` — 图片生成/TTS工具集

### 5. MCP 支持（Model Context Protocol）

Hermes 可以连接任何 MCP 服务器，扩展能力：

```bash
# 配置 MCP 服务器
hermes tools enable mcp
hermes config set mcp.servers.custom "uvx mcp-server-example"
```

兼容 agentskills.io 开放标准，技能可移植、可共享。

### 6. 定时自动化（Cron）

用自然语言描述定时任务：

```
"每天早上8点给我一份昨日工作总结"
"每周日晚10点做一次代码备份"
"每小时检查一次服务器状态"
```

支持交付到任意平台（微信/TG/邮件等）。

### 7. 子智能体委托

将复杂任务分解，并行执行：

```python
# 通过 delegate_tool 派生子任务
/parallel
  /delegate "查一下今天的天气"
  /delegate "帮我整理本周工作"
  /delegate "列出3个待办事项"
```

每个子任务在隔离环境中运行，结果汇总后返回。

---

## 技术架构

### 系统架构图

```
┌─────────────────────────────────────────────────────────────┐
│ 入口点                                                        │
│  CLI (cli.py)    Gateway (gateway/run.py)    ACP (IDE集成)  │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────────┐
│ AIAgent (run_agent.py) — 核心对话循环                         │
│                                                             │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐        │
│  │ Prompt      │  │ Provider    │  │ Tool        │        │
│  │ Builder     │  │ Resolution  │  │ Dispatch    │        │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘        │
│         │                │                 │                │
│  ┌──────┴──────┐  ┌──────┴──────┐  ┌──────┴──────┐        │
│  │ 上下文压缩   │  │ 3种API模式   │  │ 工具注册表   │        │
│  │ & 缓存     │  │ chat/completions│ │ 47工具+40工具集│     │
│  └─────────────┘  └─────────────┘  └─────────────┘        │
└──────────────────────┬──────────────────────────────────────┘
                       │
         ┌─────────────┴─────────────┐
         ▼                           ▼
┌─────────────────────┐   ┌─────────────────────────────┐
│ Session Storage     │   │ Tool Backends              │
│ (SQLite + FTS5)    │   │ Terminal: 6种后端           │
│ 持久化会话存储       │   │ Browser: 5种后端             │
└─────────────────────┘   │ Web: 4种后端                │
                          │ MCP: 动态                    │
                          └─────────────────────────────┘
```

### 关键技术选型

| 技术 | 选择原因 |
|------|---------|
| Python | 主要实现语言 |
| SQLite + FTS5 | 会话持久化+全文搜索 |
| Anthropic Messages API | 支持 prompt caching |
| FTS5 | 跨会话全文检索 |
| Honcho | 用户画像建模 |
| Docusaurus | 文档站点 |

### 目录结构

```
hermes-agent/
├── run_agent.py       # AIAgent — 核心对话循环 (~9200行)
├── cli.py             # HermesCLI — 交互终端UI (~8500行)
├── model_tools.py      # 工具发现、分发
├── hermes_state.py     # SQLite会话/状态数据库
├── tools/             # 工具实现 (每工具一文件)
│   ├── registry.py    # 中心工具注册表
│   ├── terminal_tool.py
│   ├── file_tools.py
│   └── ...
├── gateway/           # 消息平台网关
│   ├── run.py        # GatewayRunner (~7500行)
│   └── platforms/    # 15个平台适配器
├── agent/             # Agent内部组件
│   ├── prompt_builder.py
│   ├── context_compressor.py
│   └── memory_manager.py
└── ...
```

---

## 安装与使用

### 安装（一键）

```bash
# Linux/macOS/WSL2
curl -fsSL https://raw.githubusercontent.com/NousResearch/hermes-agent/main/scripts/install.sh | bash

# Android (Termux)
# 需要特殊处理，详见官方文档
```

### 快速开始

```bash
# 1. 启动 CLI
hermes

# 2. 选择模型
/model openrouter:anthropic/claude-3-5-sonnet

# 3. 配置消息平台
hermes gateway setup
hermes gateway start

# 4. 常用命令
hermes tools     # 配置工具
hermes config set # 设置配置
hermes setup     # 全设置向导
```

### Docker 部署

```bash
# 运行 Docker 版本
docker run -d \
  --name hermes \
  -v ~/.hermes:/root/.hermes \
  nousresearch/hermes-agent:latest
```

---

## 优势与劣势

### ✅ 优势

1. **真正的自我进化** — 唯一内置学习闭环的Agent
2. **跨平台统一体验** — 15+平台一个Agent
3. **极低运行成本** — $5 VPS可运行，serverless近乎免费
4. **模型无关** — 不绑定供应商，灵活切换
5. **丰富的工具生态** — 47工具+40工具集+MCP扩展
6. **开源MIT协议** — 完全可控
7. **研究友好** — 内置 RL 训练环境和轨迹导出

### ❌ 劣势

1. **Windows 原生不支持** — 需 WSL2
2. **配置有一定门槛** — 新手需要阅读文档
3. **资源占用** — 完整安装包较大
4. **微信支持依赖社区桥接** — 非官方原生支持
5. **学习曲线** — 大量特性需要时间摸索

---

## 与 OpenClaw 的关系

Hermes 是 [Nous Research](https://nousresearch.com) 的作品，而 [OpenClaw](https://docs.openclaw.ai) 是另一个优秀的 Agent 框架。

**重要：Hermes 支持从 OpenClaw 迁移！**

```bash
# 迁移向导
hermes claw migrate          # 交互式迁移
hermes claw migrate --dry-run  # 预览迁移内容
```

**迁移内容：**
- SOUL.md — persona 文件
- MEMORY.md / USER.md — 记忆和用户信息
- 用户创建的 Skills
- 命令白名单
- 消息平台配置
- API 密钥
- TTS 资源文件

---

## 适用场景

| 场景 | 推荐度 | 说明 |
|------|--------|------|
| 个人AI助手 | ⭐⭐⭐⭐⭐ | 跨设备、跨平台统一体验 |
| 开发者工具 | ⭐⭐⭐⭐⭐ | 强大终端+代码执行+子智能体 |
| 自动化任务 | ⭐⭐⭐⭐ | Cron+自然语言描述 |
| 研究用途 | ⭐⭐⭐⭐⭐ | RL训练环境+轨迹导出 |
| 企业应用 | ⭐⭐⭐ | 需要一定技术能力 |
| AI学习研究 | ⭐⭐⭐⭐⭐ | 架构清晰，文档完善 |

---

## 总结

Hermes Agent 代表了 AI Agent 的一个新方向 —— **不是一次性工具，而是会成长的伙伴**。

它的核心创新在于：
1. **内置学习闭环** — 不再是每次对话从零开始
2. **平台无关设计** — 一个Agent，服务所有通信平台
3. **模型无关设计** — 自由切换模型，不被绑定

如果你需要一个**真正能记住你、适应你、为你自我进化**的 AI 助手，Hermes Agent 值得一试。

---

## 参考链接

- 官网：https://hermes-agent.nousresearch.com
- GitHub：https://github.com/NousResearch/Hermes-Agent
- Nous Research：https://nousresearch.com
- Discord 社区：https://discord.gg/NousResearch
- Skills Hub：https://agentskills.io

---

*本文整理自 Hermes Agent 官方文档，编写日期：2026年4月*
