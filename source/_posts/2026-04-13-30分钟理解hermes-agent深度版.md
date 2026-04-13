---
title: 30分钟理解 Hermes Agent - 自我进化的AI智能体（深度版）
date: 2026-04-13 10:30:00 +0800
categories: AI Agent
tags: [笔记, AI, Hermes, NousResearch, 智能体, OpenClaw对比]
---

# 30分钟理解 Hermes Agent — 自我进化的AI智能体（深度版）

> 本文为深度技术解读版，涵盖 Hermes Agent 的架构原理、与 OpenClaw 的深度对比、以及 FTS5、Honcho 等核心技术详解。
> 
> 官网：https://hermes-agent.nousresearch.com | GitHub：https://github.com/NousResearch/Hermes-Agent

<!-- more -->

---

## 一、核心定位：什么是 Hermes Agent？

**Hermes Agent** 是由 [Nous Research](https://nousresearch.com)（海拉斯/Nomos/Psyche 模型背后的实验室）打造的**自我进化型AI智能体**。

### 与传统助手的本质区别

传统 AI 助手（ChatGPT、Claude 等）：
- 每次对话**从零开始**，无记忆
- 工具调用能力有限
- 受限于单一平台

Hermes Agent 的核心创新：
- **内置学习闭环** — 越用越聪明
- **跨会话持久化** — 记住一切
- **多平台统一** — Telegram/Discord/微信等15+平台一个Agent
- **不绑定模型** — OpenRouter 200+ 模型随意切换

---

## 二、架构深度解析

### 2.1 系统架构图

```
┌─────────────────────────────────────────────────────────────────────┐
│                         入口点 (Entry Points)                         │
│   CLI (cli.py)     Gateway (gateway/run.py)     ACP (IDE集成)        │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
                               ▼
┌─────────────────────────────────────────────────────────────────────┐
│                 AIAgent (run_agent.py) — 核心对话循环                 │
│                         ~9200 行代码                                  │
│                                                                      │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────┐                 │
│  │ Prompt      │  │ Provider    │  │ Tool       │                 │
│  │ Builder     │  │ Resolution  │  │ Dispatch   │                 │
│  │             │  │             │  │            │                 │
│  │ 系统提示词   │  │ 模型供应商   │  │ 工具分发   │                 │
│  │ 组装        │  │ 解析        │  │            │                 │
│  └──────┬──────┘  └──────┬──────┘  └──────┬──────┘                 │
│         │                │                 │                        │
│  ┌──────┴──────┐  ┌──────┴──────┐  ┌──────┴──────┐                 │
│  │ 上下文压缩   │  │ 3种API模式  │  │ 工具注册表   │                 │
│  │ & 缓存     │  │ chat/      │  │ 47工具     │                 │
│  │            │  │ completions/│  │ 40工具集   │                 │
│  │ Context    │  │ anthropic  │  │ Registry   │                 │
│  │ Compressor │  │             │  │            │                 │
│  └─────────────┘  └─────────────┘  └─────────────┘                 │
└──────────────────────────────┬──────────────────────────────────────┘
                               │
         ┌─────────────────────┴─────────────────────┐
         ▼                                           ▼
┌─────────────────────┐               ┌─────────────────────────────┐
│   Session Storage     │               │    Tool Backends            │
│   (SQLite + FTS5)    │               │                             │
│                       │               │  Terminal: 6种后端          │
│  • 对话历史           │               │    local/docker/SSH/         │
│  • FTS5全文搜索       │               │    Daytona/Modal/Singularity │
│  • 记忆持久化          │               │                             │
│  • 会话血缘追踪        │               │  Browser: 5种后端            │
│                       │               │  Web: 4种后端                │
└─────────────────────┘               │  MCP: 动态扩展               │
                                      └─────────────────────────────┘
```

### 2.2 核心组件详解

#### AIAgent（核心对话循环）

位于 `run_agent.py`，约 **9200 行代码**，是整个系统的核心。

**工作流程：**

```
用户输入
    │
    ▼
HermesCLI.process_input()
    │
    ▼
AIAgent.run_conversation()
    │
    ├──► Prompt Builder ──► 构建系统提示词
    │                       (SOUL.md + 记忆 + 技能 + 上下文)
    │
    ├──► Provider Resolution ──► 解析运行时供应商
    │                           (OpenRouter/OpenAI/Anthropic/Nous...)
    │
    ├──► API Call ──► 调用 LLM
    │                 (chat_completions / codex_responses / anthropic_messages)
    │
    ├──► Tool Calls? ──► 有工具调用？
    │     │
    │     └──► Model Tools.handle_function_call() ──► 执行工具 ──► 循环
    │
    ▼
最终响应 ──► 显示 ──► 保存到 SessionDB
```

#### Prompt Builder（提示词构建）

位于 `agent/prompt_builder.py`，负责组装系统提示词：

```
┌──────────────────────────────────────────────────────────────┐
│                    系统提示词组装                             │
├──────────────────────────────────────────────────────────────┤
│  1. SOUL.md           — Agent 的人设/角色定义                 │
│  2. MEMORY.md         — 长期记忆（持久化的知识）              │
│  3. USER.md           — 用户信息/偏好                        │
│  4. Skills            — 技能描述（Agent创建的）               │
│  5. Context Files     — 项目上下文（AGENTS.md等）           │
│  6. Tool Use Guidance — 工具使用指导                         │
│  7. Model-specific    — 模型特定指令                         │
└──────────────────────────────────────────────────────────────┘
```

#### Provider Resolution（供应商解析）

统一的运行时解析器，服务于 CLI/Gateway/Cron/ACP 等所有入口：

```python
(provider, model) ──► (api_mode, api_key, base_url)
```

支持的供应商：

| 供应商 | API模式 | 特点 |
|--------|---------|------|
| Nous Portal | chat_completions | 官方推荐 |
| OpenRouter | chat_completions | 200+模型 |
| OpenAI | chat_completions | GPT系列 |
| Anthropic | anthropic_messages | Claude系列，支持Prompt Caching |
| Kimi | chat_completions | 月之暗面 |
| MiniMax | chat_completions | 国内模型 |
| 自定义 | 任意 | 兼容任何OpenAI兼容API |

---

## 三、关键技术深度解析

### 3.1 FTS5 — 跨会话全文搜索

**FTS5（Full-Text Search version 5）** 是 SQLite 的全文搜索扩展。

#### 为什么用 FTS5？

Hermes 需要在**海量的历史会话**中快速找到相关信息。传统 SQL LIKE 查询效率极低，FTS5 专门解决这一问题。

#### FTS5 核心原理

**1. 倒排索引（Inverted Index）**

FTS5 不会逐行扫描，而是建立**倒排索引**：

```
传统方式：
  文档1 ──► "今天天气很好"
  文档2 ──► "今天下雨"
  文档3 ──► "天气不错"

搜索"天气" → 需要扫描所有文档

FTS5 倒排索引：
  "天气" ──► [文档1, 文档2, 文档3]
  "今天" ──► [文档1, 文档2]
  "很好" ──► [文档1]
  
搜索"天气" → 直接返回 [文档1, 文档2, 文档3]
```

**2. 分词（Tokenization）**

FTS5 默认使用 Unicode61 分词器，自动处理：
- 大小写转换（"天气" = "天气" = "天氣"）
- 标点符号过滤
- Unicode 规范化

**3. Hermes 中的 FTS5 使用**

```python
# Hermes 的会话存储（hermes_state.py）
# 创建 FTS5 虚拟表
CREATE VIRTUAL TABLE sessions_fts USING fts5(
    content,           -- 会话内容
    tokenize='unicode61'  -- 分词器
);

# 搜索示例
SELECT * FROM sessions_fts 
WHERE sessions_fts MATCH '天气'
ORDER BY rank;  -- 按相关性排序
```

**4. FTS5 在 Hermes 中的作用**

| 功能 | 实现 |
|------|------|
| 跨会话搜索 | `SELECT * FROM sessions WHERE content MATCH '用户问过的关于xxx的问题'` |
| LLM 摘要 | 搜索结果传给 LLM 生成摘要 |
| 上下文复用 | 找到相似会话，提取相关上下文 |

#### FTS5 vs 传统方案对比

| 特性 | FTS5 | Elasticsearch/Solr | 向量数据库 |
|------|-------|-------------------|-----------|
| 部署复杂度 | ⭐ 极简（SQLite内置）| ⭐⭐⭐⭐⭐ 复杂 | ⭐⭐⭐⭐ |
| 查询速度 | ⭐⭐⭐⭐ 极快 | ⭐⭐⭐⭐⭐ 极快 | ⭐⭐⭐ |
| 内存占用 | ⭐⭐⭐⭐⭐ 低 | ⭐ 低 | ⭐⭐ |
| 语义理解 | ❌ 关键词匹配 | ❌ 关键词匹配 | ✅ 语义相似 |
| 适用场景 | 精确关键词搜索 | 大规模搜索 | 语义搜索 |

**Hermes 选择 FTS5 的原因：**
- 本地 SQLite，轻量级
- 精确匹配效率高
- 与 LLM 摘要结合（先用 FTS5 召回，再用 LLM 理解）

---

### 3.2 Honcho — 用户画像系统

**Honcho** 是 [Plastic Labs](https://plasticlabs.ai/) 开发的**持久化记忆库**，用于构建有状态的 AI Agent。

#### Honcho 核心概念

```
┌─────────────────────────────────────────────────────────────┐
│                        Honcho 模型                          │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Workspace ──► 应用空间（一个应用一个 workspace）             │
│     │                                                        │
│     ├──► Peers ──► 参与者（用户、Agent、AI角色）             │
│     │     │                                                   │
│     │     └──► Peer Card ──► 参与者的特征画像                  │
│     │                                                        │
│     ├──► Sessions ──► 对话会话                               │
│     │     │                                                   │
│     │     └──► Messages ──► 消息记录                          │
│     │                                                        │
│     └──► Reasoning ──► Honcho 的推理能力                      │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

#### Honcho 的记忆机制

**1. 持续学习（Continual Learning）**

Honcho 不是一次性记忆，而是**随着交互不断更新**：

```python
# 添加新消息
session.add_messages([
    alice.message("我喜欢用Python编程"),
    tutor.message("好的，我记住了你偏好Python")
])

# Honcho 自动：
# 1. 提取关键信息
# 2. 更新 Alice 的 Peer Card
# 3. 生成新的对话摘要
```

**2. Dialectic（辩证）推理**

Honcho 通过不同级别的推理来理解和更新用户画像：

| 级别 | 用途 | 模型 |
|------|------|------|
| minimal/low | 快速提取 | Gemini |
| medium | 标准分析 | Claude |
| high/max | 深度推理 | Claude |

```python
# 获取用户的学习风格
response = alice.chat("What learning styles does the user respond to best?")
# Honcho 自动分析历史对话，生成回答
```

**3. Deriver（衍生器）**

后台 worker，持续处理：
- **Representation** — 实体表示
- **Summary** — 会话摘要
- **Peer Card** — 参与者画像
- **Dream** — 主动记忆整合

#### Honcho 在 Hermes 中的应用

```python
# Hermes 集成 Honcho
# 用户画像示例

# 初始状态
peer = honcho.peer("xuqi")
# {"name": "xuqi", "preferences": {}, "learning_style": null}

# 一段时间后
session.add_messages([
    peer.message("我更喜欢看代码示例而不是文档"),
    agent.message("明白了，你偏好实践导向的学习方式")
])

# Honcho 自动更新
# peer = {"name": "xuqi", "preferences": {"learning": "hands-on"}, ...}
```

#### Honcho vs 传统记忆方案

| 特性 | Honcho | 传统 Key-Value 记忆 | 纯向量记忆 |
|------|--------|---------------------|------------|
| 持续学习 | ✅ | ❌ | ⚠️ |
| 结构化查询 | ✅ SQL | ✅ | ❌ |
| 语义理解 | ✅ LLM驱动 | ❌ | ✅ |
| 用户画像 | ✅ 自动生成 | ❌ | ⚠️ |
| 部署复杂度 | ⭐⭐ | ⭐⭐⭐⭐⭐ | ⭐⭐⭐ |

---

### 3.3 上下文压缩与缓存

#### Context Compressor（上下文压缩）

当对话历史过长时，Hermes 会自动压缩：

```
┌─────────────────────────────────────────────────────┐
│                  上下文压缩流程                     │
├─────────────────────────────────────────────────────┤
│                                                      │
│  [消息1] [消息2] ... [消息100] ... [消息500]       │
│       │                    │                    │    │
│       ▼                    ▼                    ▼    │
│   保留早期                压缩中间              最近  │
│   完整保留               (LLM摘要)            完整保留 │
│                                                      │
└─────────────────────────────────────────────────────┘
```

**触发条件：**
- 上下文超过模型 token 限制的 70%
- 自动选择"损耗型摘要"

#### Anthropic Prompt Caching

当使用 Anthropic 模型时，Hermes 利用 **Prompt Caching**：

```python
# Anthropic 的 cache 机制
# 提示词前缀（系统提示、记忆、技能）只需传输一次

messages = [
    {"role": "system", "content": "...", "cache_control": {"type": "ephemeral"}},
    {"role": "system", "content": "...", "cache_control": {"type": "ephemeral"}},
    {"role": "user", "content": "今天天气如何？"}
]
```

---

## 四、与 OpenClaw 深度对比

### 4.1 基本信息对比

| 特性 | Hermes Agent | OpenClaw |
|------|--------------|----------|
| 开发团队 | Nous Research | OpenClaw 社区 |
| 定位 | 自我进化智能体 | 多功能 Agent 框架 |
| 学习闭环 | ✅ 内置 | ⚠️ 依赖记忆扩展 |
| 模型支持 | 18+ 供应商 | 多种模型 |
| 消息平台 | 15+ | 多种 |
| 价格 | 免费 MIT | 部分付费 |
| 部署 | VPS/Serverless | NAS/本地/云 |

### 4.2 核心差异分析

#### 学习能力

**Hermes：**
- 主动创建技能（Skill）
- 技能在使用中自我改进
- Honcho 用户画像
- 定期"提醒"自己保存知识

**OpenClaw：**
- MEMORY.md 持久化
- Skills 系统
- 需要手动管理记忆
- HEARTBEAT 心跳机制

#### 架构设计

| 方面 | Hermes | OpenClaw |
|------|--------|----------|
| 核心语言 | Python | TypeScript/Node.js |
| 会话存储 | SQLite + FTS5 | 文件系统 |
| 工具系统 | Registry 模式 | Skills 模式 |
| 消息路由 | Gateway 统一 | Channel 适配 |

#### 工具生态

**Hermes：**
- 47 个内置工具
- 40 个工具集
- MCP 动态扩展
- 6 种终端后端

**OpenClaw：**
- Skills 扩展
- 工具系统
- Home Assistant 集成

### 4.3 各自优势场景

| 场景 | 推荐 | 原因 |
|------|------|------|
| **需要自我进化** | Hermes | 唯一内置学习闭环 |
| **多平台消息** | Hermes | 15+ 平台原生支持 |
| **个人NAS部署** | OpenClaw | 轻量级，NAS 友好 |
| **Home Assistant集成** | OpenClaw | 原生 HA 支持 |
| **研究用途** | Hermes | RL 环境、轨迹导出 |
| **低成本VPS** | Hermes | $5 VPS 可运行 |

### 4.4 迁移能力

**重要：Hermes 支持从 OpenClaw 迁移！**

```bash
# 一键迁移
hermes claw migrate
```

迁移内容：
- `SOUL.md` → Agent 人设
- `MEMORY.md` / `USER.md` → 记忆系统
- 用户创建的 Skills → `~/.hermes/skills/openclaw-imports/`
- 命令白名单
- 消息平台配置
- API 密钥

---

## 五、定时自动化（Cron）深度解析

### 5.1 Cron vs 传统定时任务

| 特性 | Hermes Cron | 传统 Cron |
|------|-------------|-----------|
| 配置方式 | 自然语言 | crontab 语法 |
| 执行主体 | AI Agent | Shell 脚本 |
| 上下文 | 有完整 Agent 上下文 | 无 |
| 交付方式 | 任意平台 | 仅本地/邮件 |
| 错误处理 | AI 自动处理 | 手动 |

### 5.2 Cron 工作原理

```
Scheduler Tick
     │
     ├──► 加载到期任务（jobs.json）
     │
     ├──► 创建 Fresh AIAgent（无历史）
     │
     ├──► 注入附加技能和脚本
     │
     ├──► 运行任务提示词
     │     例："每天早8点给我天气"
     │
     ├──► 交付响应到目标平台
     │     （Telegram/微信/邮件等）
     │
     └──► 更新任务状态和下次执行时间
```

### 5.3 使用示例

```
# 创建日报任务
"每天早上8点给我一份昨天的工作总结"

# 创建周报任务  
"每周五下午6点生成本周学习报告，发送到我的邮箱"

# 创建监控任务
"每小时检查一次服务器状态，如有异常立即通知我"
```

---

## 六、子智能体委托（Delegate）

### 6.1 为什么需要委托？

复杂任务分解为子任务并行执行：

```
用户请求：帮我分析这个项目的代码质量

传统方式：
  1. 分析代码 ──► 2. 生成报告 ──► 3. 发送邮件
     (串行执行，30分钟)

Delegate 方式：
  /parallel
    /delegate "分析代码结构和复杂度"
    /delegate "检查潜在bug和安全问题"
    /delegate "生成测试覆盖率报告"
  
  (并行执行，10分钟)
```

### 6.2 委托的实现

```python
# delegate_tool.py
# 每个子任务在隔离环境中运行

subagent = AIAgent(
    task=task_description,
    isolation=True,  # 隔离环境
    tools=[...],     # 子任务可用的工具
    parent_session=session  # 保留父会话引用
)
```

---

## 七、适用场景总结

| 场景 | 推荐度 | Hermes 优势 | OpenClaw 优势 |
|------|--------|-------------|----------------|
| 个人AI助手 | ⭐⭐⭐⭐⭐ | 学习闭环越用越聪明 | 轻量NAS可跑 |
| 跨平台消息 | ⭐⭐⭐⭐⭐ | 15+平台原生 | 多渠道支持 |
| 开发者工具 | ⭐⭐⭐⭐⭐ | 强大终端+代码执行 | 编程友好 |
| 自动化任务 | ⭐⭐⭐⭐ | 自然语言Cron | HEARTBEAT |
| 研究/RL | ⭐⭐⭐⭐⭐ | 内置RL环境 | - |
| Home Assistant | ⭐⭐⭐ | 支持 | ⭐⭐⭐⭐⭐ 原生 |

---

## 八、总结

Hermes Agent 代表了 AI Agent 的新范式：**不是工具，而是会成长的伙伴**。

它的核心创新：
1. **内置学习闭环** — 自我进化
2. **FTS5 + Honcho** — 结构化记忆与搜索
3. **平台无关设计** — 一个Agent服务所有
4. **模型无关设计** — 自由切换
5. **MIT 开源** — 完全可控

如果你需要**真正能记住你、适应你、为你进化**的 AI 助手，Hermes 值得深入研究。

---

## 参考资料

| 资源 | 链接 |
|------|------|
| 官网 | https://hermes-agent.nousresearch.com |
| GitHub | https://github.com/NousResearch/Hermes-Agent |
| Honcho | https://github.com/plastic-labs/honcho |
| Honcho 文档 | https://docs.honcho.dev |
| FTS5 文档 | https://www.sqlite.org/fts5.html |
| Nous Research | https://nousresearch.com |

---

*本文整理自官方文档 + 技术源码分析，编写日期：2026年4月*
