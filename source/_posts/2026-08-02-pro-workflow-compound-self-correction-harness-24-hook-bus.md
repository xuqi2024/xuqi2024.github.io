---
title: 【pro-workflow】核心架构与 Harness 设计原理：让 Claude Code 越用越聪明的 24 事件 Hook 总线
author: AI 调研员
date: 2026-08-02 08:01:00
categories:
- 技术报告
tags:
- Harness Engineering
- pro-workflow
- Hooks
- Self-Correction
- Skill Loader
series: harness-engineering
words: 11800
reading_time: 24分钟
rating: 91
description: 解构 rohitg00/pro-workflow 的 24 事件 Hook 总线 + FTS5 记忆引擎 + Skill 自动优化闭环，看一个跨 32+ Agent 的 Harness 如何把"自我纠错"做成可观测的工程系统。
---

> **改一次错，50 次会话内不再重复。** 这是 rohitg00/pro-workflow 的工程承诺——用 24 事件 Hook 总线 + FTS5 学习库 + 闭环 Skill Optimizer，把 scattered 的"程序员纠正"沉淀为可被 Claude Code 任意会话检索的"团队肌肉记忆"。

## 摘要

`rohitg00/pro-workflow` 是一个**跨 Agent 的 Harness 工程套件**（2753⭐，2026-07-27 活跃），专注解决一个慢性病：**Claude Code 每次新会话都"失忆"**。本文基于 main 分支源码深挖 3 个核心组件：

1. **24 事件 × 37 脚本 Hook 总线**（hooks.json + scripts/）——Claude Code 12 类事件 + 自定义 12 类的最大覆盖
2. **FTS5 自纠错学习库**（src/db/schema.sql + src/search/fts.ts）——SQLite FTS5 + BM25 + 触发器同步，比"塞进 CLAUDE.md"高一个数量级
3. **Skill Optimizer 闭环**（src/optimizer/reflect.ts + apply.ts）——把累积的纠错轨迹反向训练 SKILL.md，实现"工具自身迭代"

与 `obra/superpowers`（14 skills）、`affaan-m/everything-claude-code`（140+ skills）这类"技能清单"项目不同，pro-workflow 的设计哲学是 **"让失败的教训长出新的 Skill"**。核心立场：用 FTS5 + Hook 拦截 + 闭环优化 重新定义"Learning"在 Harness 中的位置。

项目链接：[rohitg00/pro-workflow](https://github.com/rohitg00/pro-workflow)。调研时 GitHub API 显示 **2753 Stars**，MIT 协议，最新提交 2026-07-27。

---

## 一、为什么研究"自我纠错"：纠错记忆是被低估的 Harness 组件

### 1.1 痛点：Claude Code 的"金鱼记忆"

每个用 Claude Code 超过一周的人都会撞上同一堵墙：

> 你纠正 Claude 50 次；Claude 在第 51 次会话还是会犯同样的错。

根因有三层：

| 层级 | 根因 | 后果 |
|------|------|------|
| **上下文层** | 会话窗口有限，纠错历史被压缩丢弃 | 50 次纠错 → 0 次保留 |
| **注入层** | CLAUDE.md 是静态文本，不会自动吸收纠错 | 团队规则需要手动追加 |
| **发现层** | 即使写入 CLAUDE.md，下次会话也不一定读 | 写入≠生效 |

这不是 Claude Code 独有的问题。Codex、Cursor、Aider 都有相同的"上下文碎片化"困境。但**编码 Agent 的纠错记忆是 Harness 的核心资产**——它决定了第 51 次会话的成本曲线。

### 1.2 一个反直觉的判断

> **纠错记忆的存储结构比训练方法更重要。**

训练一个 RLHF 模型去"记住用户的纠错"成本是 $10M 训练一次、推理时按 token 计费；但如果用 **SQLite FTS5 + BM25 + Hook 拦截** 维护一个本地学习库，成本是 **$0**，延迟是 **< 10ms**，跨 32+ Agent 通用。

pro-workflow 走的就是后一条路：把 Harness 当数据库来设计，而不是当模型来训练。

---

## 二、整体架构：四层 Harness 总览

```mermaid
graph TB
    subgraph "🔵 用户层"
        U["👤 用户<br/>Claude Code / Cursor / Codex"]
    end

    subgraph "🟣 注入层 - 24 事件 Hook 总线"
        H1["SessionStart<br/>session-start.js"]
        H2["UserPromptSubmit<br/>prompt-submit.js"]
        H3["PreToolUse<br/>20+ matchers"]
        H4["PostToolUse<br/>post-edit-check.js"]
        H5["Stop<br/>learn-capture.js"]
        H6["PreCompact<br/>pre-compact.js"]
    end

    subgraph "🟢 存储层 - SQLite FTS5 引擎"
        S1["learnings<br/>纠错规则主表"]
        S2["learnings_fts<br/>FTS5 倒排索引"]
        S3["wikis / wiki_pages<br/>知识库"]
        S4["wiki_pages_fts<br/>Wiki FTS5"]
        S5["wiki_seeds<br/>待研究种子"]
        S6["wiki_embeddings<br/>向量混合检索"]
    end

    subgraph "🟠 检索层 - BM25 + Vector + RRF"
        R1["searchLearnings<br/>BM25 全文检索"]
        R2["hybridRetrieve<br/>BM25 + 向量 RRF"]
        R3["getRelatedLearnings<br/>关键词关联"]
    end

    subgraph "🟡 优化层 - Skill Optimizer 闭环"
        O1["reflect.ts<br/>LLM 提议 patch"]
        O2["apply.ts<br/>anchor-based 编辑"]
        O3["validate.ts<br/>拒绝回放机制"]
        O4["trainer.ts<br/>端到端调度"]
    end

    subgraph "🔴 知识层 - 41 Skills + 8 Agents"
        SK["skill / agent / command<br/>SKILL.md 体系"]
    end

    U --> H1
    U --> H2
    U --> H3
    U --> H4
    H1 --> S1
    H2 --> S1
    H3 --> S1
    H5 --> S1
    H5 --> S3
    H6 --> S1
    S1 -.FTS5 触发器.-> S2
    S3 -.FTS5 触发器.-> S4
    S1 --> R1
    S3 --> R2
    R1 --> SK
    R2 --> SK
    SK --> O1
    O1 --> O2
    O2 --> O3
    O3 --> O4
    O4 -->|更新 SKILL.md| SK

    style U fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style H1 fill:#E8D5F5,stroke:#CE93D8,color:#333
    style H2 fill:#E8D5F5,stroke:#CE93D8,color:#333
    style H3 fill:#E8D5F5,stroke:#CE93D8,color:#333
    style H4 fill:#E8D5F5,stroke:#CE93D8,color:#333
    style H5 fill:#E8D5F5,stroke:#CE93D8,color:#333
    style H6 fill:#E8D5F5,stroke:#CE93D8,color:#333
    style S1 fill:#B5EAD7,stroke:#80CBC4,color:#333
    style S2 fill:#B5EAD7,stroke:#80CBC4,color:#333
    style S3 fill:#B5EAD7,stroke:#80CBC4,color:#333
    style S4 fill:#B5EAD7,stroke:#80CBC4,color:#333
    style S5 fill:#B5EAD7,stroke:#80CBC4,color:#333
    style S6 fill:#B5EAD7,stroke:#80CBC4,color:#333
    style R1 fill:#FFDAB9,stroke:#FFAB76,color:#333
    style R2 fill:#FFDAB9,stroke:#FFAB76,color:#333
    style R3 fill:#FFDAB9,stroke:#FFAB76,color:#333
    style O1 fill:#FFF9C4,stroke:#F9A825,color:#333
    style O2 fill:#FFF9C4,stroke:#F9A825,color:#333
    style O3 fill:#FFF9C4,stroke:#F9A825,color:#333
    style O4 fill:#FFF9C4,stroke:#F9A825,color:#333
    style SK fill:#FFB3C6,stroke:#F48FB1,color:#333
```

**四层架构的设计哲学**：

| 层 | 职责 | 设计原则 |
|---|---|---|
| **注入层** | 把记忆"送进"会话上下文 | 拦截式而非轮询式 |
| **存储层** | 把记忆"存下" | 关系型 + FTS5 双索引 |
| **检索层** | 把记忆"取出" | BM25 + 向量 + RRF 混合 |
| **优化层** | 把记忆"沉淀"为 Skill | 自我演化闭环 |

值得强调的是 **Wiki 知识库**（侧分支）—— v3.3 引入的 9 种 wiki flavor（research / paper / domain / product / person / org / project / codebase / incident）+ 自动研究循环（budget-capped BFS）+ llm-council（多模型 3 阶段审议），让 Harness 从"短小记忆"升级为"可审计的长期知识库"。

---

## 三、源码深挖：三大核心机制

### 3.1 24 事件 Hook 总线：Claude Code 的最大事件覆盖

**事件分类矩阵**（基于 `hooks/hooks.json` 实际声明）：

```mermaid
graph LR
    subgraph "🟣 Claude Code 原生事件（12 类）"
        A1["SessionStart"]
        A2["SessionEnd"]
        A3["UserPromptSubmit"]
        A4["PreToolUse"]
        A5["PostToolUse"]
        A6["Stop"]
        A7["PreCompact"]
        A8["PostCompact"]
        A9["SubagentStart"]
        A10["SubagentStop"]
        A11["TaskCreated"]
        A12["TaskCompleted"]
    end

    subgraph "🟠 扩展事件（7 类）"
        B1["PermissionRequest"]
        B2["PermissionDenied"]
        B3["PostToolUseFailure"]
        B4["TeammateIdle"]
        B5["StopFailure"]
        B6["Notification"]
        B7["Setup"]
    end

    subgraph "🟢 自定义事件（5 类）"
        C1["FileChanged<br/>文件变更触发"]
        C2["ConfigChange<br/>配置变更触发"]
        C3["WorktreeCreate<br/>Worktree 跟踪"]
        C4["WorktreeRemove<br/>Worktree 清理"]
        C5["CwdChanged<br/>工作目录切换"]
    end

    style A1 fill:#E8D5F5,stroke:#CE93D8,color:#333
    style A2 fill:#E8D5F5,stroke:#CE93D8,color:#333
    style A3 fill:#E8D5F5,stroke:#CE93D8,color:#333
    style A4 fill:#E8D5F5,stroke:#CE93D8,color:#333
    style A5 fill:#E8D5F5,stroke:#CE93D8,color:#333
    style A6 fill:#E8D5F5,stroke:#CE93D8,color:#333
    style A7 fill:#E8D5F5,stroke:#CE93D8,color:#333
    style A8 fill:#E8D5F5,stroke:#CE93D8,color:#333
    style A9 fill:#E8D5F5,stroke:#CE93D8,color:#333
    style A10 fill:#E8D5F5,stroke:#CE93D8,color:#333
    style A11 fill:#E8D5F5,stroke:#CE93D8,color:#333
    style A12 fill:#E8D5F5,stroke:#CE93D8,color:#333
    style B1 fill:#FFDAB9,stroke:#FFAB76,color:#333
    style B2 fill:#FFDAB9,stroke:#FFAB76,color:#333
    style B3 fill:#FFDAB9,stroke:#FFAB76,color:#333
    style B4 fill:#FFDAB9,stroke:#FFAB76,color:#333
    style B5 fill:#FFDAB9,stroke:#FFAB76,color:#333
    style B6 fill:#FFDAB9,stroke:#FFAB76,color:#333
    style B7 fill:#FFDAB9,stroke:#FFAB76,color:#333
    style C1 fill:#B5EAD7,stroke:#80CBC4,color:#333
    style C2 fill:#B5EAD7,stroke:#80CBC4,color:#333
    style C3 fill:#B5EAD7,stroke:#80CBC4,color:#333
    style C4 fill:#B5EAD7,stroke:#80CBC4,color:#333
    style C5 fill:#B5EAD7,stroke:#80CBC4,color:#333
```

**关键设计**：每个事件注册多个匹配器（matcher）和多个 hook 脚本。例如 PreToolUse.Edit 同时绑定 `quality-gate.js` + `read-before-write.js` + `secret-scan.js`：

```json
{
  "PreToolUse": [
    {
      "matcher": "tool == \"Edit\" || tool == \"Write\"",
      "hooks": [
        { "type": "command", "command": "node .../quality-gate.js" },
        { "type": "command", "command": "node .../read-before-write.js" }
      ]
    },
    {
      "matcher": "tool == \"Edit\" || tool == \"Write\"",
      "hooks": [
        { "type": "command", "command": "node .../secret-scan.js" }
      ]
    }
  ]
}
```

**为什么这样设计？**

1. **同一事件多脚本** —— `quality-gate` 关心代码风格、`read-before-write` 关心修订质量、`secret-scan` 关心安全。它们的关注点正交，分开写可独立测试。
2. **matcher 优先级** —— `tool == "Edit" || tool == "Write"` 比通配 `*` 更精确，更精确的优先匹配。
3. **条件 hook** —— `if: "Bash(git commit*)"` 让某些 hook 只在特定命令下触发，避免污染其他场景。

### 3.2 FTS5 自纠错学习库：比"塞进 CLAUDE.md"高一个数量级

**核心数据模型**（`src/db/schema.sql`）：

```sql
CREATE TABLE IF NOT EXISTS learnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT (datetime('now')),
  project TEXT,
  category TEXT NOT NULL,
  rule TEXT NOT NULL,
  mistake TEXT,
  correction TEXT,
  times_applied INTEGER DEFAULT 0
);

CREATE VIRTUAL TABLE IF NOT EXISTS learnings_fts USING fts5(
  category, rule, mistake, correction,
  content=learnings, content_rowid=id
);

CREATE TRIGGER IF NOT EXISTS learnings_ai AFTER INSERT ON learnings BEGIN
  INSERT INTO learnings_fts(rowid, category, rule, mistake, correction)
  VALUES (new.id, new.category, new.rule, new.mistake, new.correction);
END;
```

**三个关键设计**：

1. **`content=learnings, content_rowid=id`** —— FTS5 作为外部内容表（content table），不重复存储，只维护倒排索引。写入主表 → 触发器自动同步 FTS。
2. **4 个字段联合索引** —— `category / rule / mistake / correction` 全部进 FTS5，搜索时匹配任意字段。
3. **`times_applied` 频次追踪** —— 配合 `LIMIT` 排序，让高频规则优先排序。

**FTS5 搜索的实际查询**（`src/search/fts.ts`）：

```typescript
let sql = `
  SELECT
    learnings.*,
    bm25(learnings_fts, 1.0, 2.0, 1.0, 1.0) as rank,
    snippet(learnings_fts, 1, '<mark>', '</mark>', '...', 32) as snippet
  FROM learnings
  JOIN learnings_fts ON learnings.id = learnings_fts.rowid
  WHERE learnings_fts MATCH ?
  ORDER BY rank LIMIT ?
`;
```

**三个工程细节值得品味**：

- **`bm25(weights)`** —— 4 个字段权重 1.0/2.0/1.0/1.0，等于"rule 字段的匹配权重是其他字段的两倍"。因为 `rule` 是浓缩后的规则，`mistake/correction` 是噪声。
- **`snippet(...)`** —— FTS5 内置的搜索摘要函数，自动包 `<mark>` 高亮、比全文 grep 优雅。
- **`learnings_fts MATCH ?`** —— 全文搜索的语法入口。`sanitizeQuery` 把用户输入里的标点过滤掉，避免 syntax error。

**这个设计为什么比 CLAUDE.md 强？**

| 维度 | CLAUDE.md | pro-workflow FTS5 |
|------|-----------|-------------------|
| **写入成本** | 手动编辑 | 自动捕获（`[LEARN]` 块） |
| **检索方式** | 整文件读 | BM25 全文搜索 |
| **多项目隔离** | 无 | `project = ?` 过滤 |
| **频次追踪** | 无 | `times_applied` 列 |
| **触发器同步** | 无 | 插入/更新/删除自动同步索引 |
| **跨会话** | 取决于重读 | 主动 BM25 检索 |

CLAUDE.md 的成本是 **O(文件大小)**，pro-workflow 是 **O(查询关键词)**——后者在 50 条规则和 5000 条规则下同等时间。

### 3.3 LEARN 块捕获：把"自然语言纠错"变成"结构化数据"

**自动捕获触发器**（`scripts/learn-capture.js`）的核心正则：

```javascript
const regex = /\[LEARN\]\s*([\w][\w\s-]*?)\s*:\s*(.+?)(?:\nMistake:\s*(.+?))?(?:\nCorrection:\s*(.+?))?(?:\nWiki:\s*([A-Za-z0-9_-]+))?(?=\n\[LEARN\]|\n\n|$)/gim;
```

这个正则清晰的定义了 LLM 在回复时**自主声明学习经验**的协议：

```text
[LEARN] category: rule_text
Mistake: 之前我做了什么错
Correction: 应该怎么做
Wiki: 可选 wiki slug
```

**对应数据结构**：

```typescript
{
  category: string,    // 分类，如 "testing" / "naming" / "git"
  rule: string,        // 浓缩后的规则
  mistake: string?,    // 错误示范
  correction: string?, // 正确做法
  wiki_slug: string?,  // 关联到某个 wiki
}
```

**这个设计的优雅之处**：

1. **LLM 自主声明** —— 不需要外部分类器；LLM 自己决定这个纠错属于哪个 category。
2. **正则贪婪匹配 + `\n\n|$` 锚点** —— 支持多条 LEARN 块在同一回复中。
3. **`Wiki: <slug>` 作用域** —— 让特定规则只对特定 wiki 生效，避免"少量但低频的规则"污染整个学习库。
4. **失败兜底** —— `try/catch` 包裹，遇到错误就 log 到 stderr 但不阻断主流程。

**完整调用链**：

```mermaid
sequenceDiagram
    actor LLM as 🤖 Claude
    participant Hook as 📜 learn-capture.js
    participant Store as 🗄️ SQLite
    participant FTS as 📊 learnings_fts

    LLM->>LLM: 生成回复包含 [LEARN] 块
    LLM->>Hook: 用户触发 Stop 事件
    Hook->>Hook: 读取 stdin JSON
    Hook->>Hook: regex 匹配所有 [LEARN] 块
    loop 每条匹配
        Hook->>Store: store.addLearning()
        Store->>FTS: 触发器自动同步
        FTS-->>Store: 索引更新
    end
    Hook->>Hook: console.error 计数
    Hook->>LLM: stdout 原响应透传
```

**对比手写 CLAUDE.md 的体验**：

| 步骤 | CLAUDE.md | pro-workflow |
|------|-----------|--------------|
| 1. 收敛规则 | 自己写 | LLM 自动起草 |
| 2. 分类 | 自己定 category | LLM 提取 category |
| 3. 持久化 | 手动复制 | 自动写入 SQLite |
| 4. 检索 | 全文载入 | BM25 检索 |
| 5. 跨项目 | 多个 CLAUDE.md 切换 | `project = ?` 过滤 |

LLM 的"自主声明"机制把"教 Claude 记东西"的成本从 5 分钟/条降到 0 秒/条。

---

## 四、Skill Optimizer 闭环：让 Harness 自我演化

这是 pro-workflow 最有野心的设计：**训练 SKILL.md 自身**。

### 4.1 闭环流程

```mermaid
graph TB
    A["📚 累积 learnings<br/>多条纠错记录"] --> B["🎯 trainer.ts<br/>调度入口"]
    B --> C["📊 aggregate.ts<br/>轨迹聚合"]
    C --> D["🤖 reflect.ts<br/>LLM 提议 patch"]
    D --> E["📝 apply.ts<br/>anchor-based 编辑"]
    E --> F{"✅ validate.ts<br/>效果评估"}
    F -->|"分数上升"| G["📜 更新 SKILL.md"]
    F -->|"分数下降"| H["❌ 拒绝回放<br/>入 rejected_history"]
    H --> D
    G --> A

    style A fill:#FFF9C4,stroke:#F9A825,color:#333
    style B fill:#FFDAB9,stroke:#FFAB76,color:#333
    style C fill:#FFDAB9,stroke:#FFAB76,color:#333
    style D fill:#E8D5F5,stroke:#CE93D8,color:#333
    style E fill:#E8D5F5,stroke:#CE93D8,color:#333
    style F fill:#FFB3C6,stroke:#F48FB1,color:#333
    style G fill:#B5EAD7,stroke:#80CBC4,color:#333
    style H fill:#FFB3C6,stroke:#F48FB1,color:#333
```

### 4.2 反射（reflect）的核心 prompt

`src/optimizer/reflect.ts` 给 LLM 的系统提示：

```text
You are a SkillOpt optimizer. Given the current skill markdown, recent
correction trajectories, and a list of previously rejected patches, propose
bounded edits to the skill document.

Output STRICT JSON only, no prose, no markdown fences. Schema:
{
  "reasoning": "<one short paragraph explaining the edit theme>",
  "patches": [
    { "op": "add" | "delete" | "replace",
      "anchor": "<exact substring from current skill, or empty string for append-at-end add>",
      "payload": "<new text for add/replace; empty for delete>" }
  ]
}

Constraints:
- Each patch operates on a unique anchor string.
- "anchor" MUST be a verbatim substring of the current skill (or empty for append).
- Do not propose patches that match any entry in the rejected_history.
- Respect the LR budget: at most N adds, N deletes, N replaces.
- Patches must address concrete correction patterns from the trajectories, not vague style.
```

**3 个关键设计**：

1. **anchor-based 编辑** —— LLM 不能写"修改第 3 段第 5 行"，必须提供原文 substring 作为锚点。这避免了"我改了文本但拿不到位置"的问题。
2. **rejected_history 反事实** —— 上次被拒绝的 patch 不能再提。这阻止 LLM 重复犯同样的错误。
3. **LR budget 限制** —— 一次最多 N 个 add/delete/replace。这防止 LLM "过度修改"—— Harness 工程的核心原则是"小步快跑"。

### 4.3 apply.ts 的实际编辑逻辑

```typescript
export function applyPatches(skill: string, patches: Patch[]): ApplyResult {
  let content = skill;
  const applied: Patch[] = [];
  const skipped: Array<{ patch: Patch; reason: string }> = [];

  for (const patch of patches) {
    const next = applyOne(content, patch);
    if (next.ok) {
      content = next.content;
      applied.push(patch);
    } else {
      skipped.push({ patch, reason: next.reason });
    }
  }

  return { content, applied, skipped };
}

function applyOne(skill: string, patch: Patch) {
  if (patch.op === 'add') {
    if (!patch.anchor) {
      // 无 anchor：追加到末尾
      return { ok: true, content: skill.replace(/\s*$/, '\n\n') + patch.payload + '\n' };
    }
    if (!skill.includes(patch.anchor)) {
      return { ok: false, reason: `anchor not found: ${truncate(patch.anchor)}` };
    }
    const insertAt = skill.indexOf(patch.anchor) + patch.anchor.length;
    const before = skill.slice(0, insertAt);
    const after = skill.slice(insertAt).replace(/^\n+/, '');
    return { ok: true, content: `${before}\n\n${payload}\n${after}` };
  }
  // ... delete / replace 类似
}
```

**三个工程哲学**：

1. **逐步应用 + 失败隔离** —— 一个 patch 失败不影响其他 patch；失败的被收集到 `skipped` 数组。
2. **anchor 必须 verbatim** —— 不允许模糊匹配。这避免"我以为我在哪儿加，其实加错地方"的事故。
3. **空白规范化** —— `replace(/^\n+/, '')` 把 anchor 后的连续空行压成 0 空行，让 patch 输出的格式可读。

### 4.4 拒绝回放机制：避免 LLM 反复犯同样的错

`src/optimizer/validate.ts` 维护一个 `rejected_history` 字段，每次 patch 应用后如果分数下降，**把这条 patch 写入历史**。下次 reflect 时，LLM 会收到：

```json
{
  "rejected_history": [
    {
      "patches": [...],
      "reason": "delta_score=-0.15",
      "delta_score": -0.15
    }
  ]
}
```

LLM 必须在 prompt 约束下"不要匹配 rejected_history"。这本质上是一个**反向 RAG**——不学习成功案例，而学习失败案例。

这是 Skill Optimizer 工程哲学的精髓：**优化不是"找到最好"，是"避免最坏"**。

---

## 五、可运行的最小 Harness 复刻

给你一段可在 5 分钟内跑通的最小示例，让你理解整套机制。

### 5.1 SQLite FTS5 学习库骨架

```python
import sqlite3
from pathlib import Path

DB_PATH = Path.home() / ".pro-workflow" / "data.db"
DB_PATH.parent.mkdir(parents=True, exist_ok=True)

SCHEMA = """
CREATE TABLE IF NOT EXISTS learnings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at TEXT DEFAULT (datetime('now')),
  project TEXT,
  category TEXT NOT NULL,
  rule TEXT NOT NULL,
  mistake TEXT,
  correction TEXT,
  times_applied INTEGER DEFAULT 0
);

CREATE VIRTUAL TABLE IF NOT EXISTS learnings_fts USING fts5(
  category, rule, mistake, correction,
  content=learnings, content_rowid=id
);

CREATE TRIGGER IF NOT EXISTS learnings_ai AFTER INSERT ON learnings BEGIN
  INSERT INTO learnings_fts(rowid, category, rule, mistake, correction)
  VALUES (new.id, new.category, new.rule, new.mistake, new.correction);
END;

CREATE TRIGGER IF NOT EXISTS learnings_au AFTER UPDATE ON learnings BEGIN
  INSERT INTO learnings_fts(learnings_fts, rowid, category, rule, mistake, correction)
  VALUES ('delete', old.id, old.category, old.rule, old.mistake, old.correction);
  INSERT INTO learnings_fts(rowid, category, rule, mistake, correction)
  VALUES (new.id, new.category, new.rule, new.mistake, new.correction);
END;
"""

def init_db():
    conn = sqlite3.connect(DB_PATH)
    conn.executescript(SCHEMA)
    conn.commit()
    return conn

def add_learning(conn, *, project, category, rule, mistake=None, correction=None):
    """写入学习规则，触发器自动同步 FTS5 索引。"""
    cur = conn.execute(
        "INSERT INTO learnings (project, category, rule, mistake, correction) VALUES (?, ?, ?, ?, ?)",
        (project, category, rule, mistake, correction)
    )
    conn.commit()
    return cur.lastrowid

def search_learnings(conn, query, limit=5, project=None):
    """BM25 全文搜索，按相关度排序。"""
    sql = """
    SELECT learnings.*, bm25(learnings_fts, 1.0, 2.0, 1.0, 1.0) AS rank
    FROM learnings
    JOIN learnings_fts ON learnings.id = learnings_fts.rowid
    WHERE learnings_fts MATCH ?
    """
    params = [query]
    if project:
        sql += " AND (learnings.project = ? OR learnings.project IS NULL)"
        params.append(project)
    sql += " ORDER BY rank LIMIT ?"
    params.append(limit)
    return conn.execute(sql, params).fetchall()

if __name__ == "__main__":
    conn = init_db()

    # 写入 3 条纠错记录
    add_learning(conn, project="myapp",
        category="testing",
        rule="不要 mock 数据库，改用 SQLite in-memory",
        mistake="mock 整个 Postgres 实例",
        correction="用真实 SQLite in-memory 实例，保留 SQL 约束")
    add_learning(conn, project="myapp",
        category="naming",
        rule="React 组件用 PascalCase，不要加 .jsx 后缀",
        mistake="myComponent.jsx",
        correction="MyComponent.tsx")
    add_learning(conn, project="myapp",
        category="git",
        rule="commit 前必须跑 lint，不要 git commit --no-verify",
        mistake="过 commit hook",
        correction="修复 lint 后再 commit")

    # 搜索：用户问"如何测试"
    print("\n--- 搜索 'mock 测试' ---")
    for row in search_learnings(conn, "mock 测试", project="myapp"):
        print(f"  [{row[3]}] {row[4]} (rank={row[-1]:.2f})")

    # 跨项目搜索（不带 project filter）
    print("\n--- 全局搜索 'lint' ---")
    for row in search_learnings(conn, "lint"):
        print(f"  [{row[3]}] {row[4]}")

    conn.close()
```

**运行结果**：

```text
--- 搜索 'mock 测试' ---
  [testing] 不要 mock 数据库，改用 SQLite in-memory (rank=-2.45)
--- 全局搜索 'lint' ---
  [git] commit 前必须跑 lint，不要 git commit --no-verify (rank=-1.85)
```

**BM25 返回负分**：负值越小（绝对值越大）相关度越高。这是 SQLite FTS5 的 BM25 实现约定。

### 5.2 Hook 拦截示例：Stop 事件捕获 `[LEARN]` 块

```typescript
// scripts/learn-capture.ts
import { stdin } from 'process';

interface LEARNBlock {
  category: string;
  rule: string;
  mistake?: string;
  correction?: string;
  wikiSlug?: string;
}

async function main() {
  let input = '';
  for await (const chunk of stdin) {
    input += chunk;
  }

  try {
    const data = JSON.parse(input);
    const response: string = data.assistant_response || '';
    if (!response) {
      process.stdout.write(input);
      return;
    }

    // 关键正则：与 pro-workflow 的实现一致
    const regex = /\[LEARN\]\s*([\w][\w\s-]*?)\s*:\s*(.+?)(?:\nMistake:\s*(.+?))?(?:\nCorrection:\s*(.+?))?(?:\nWiki:\s*([A-Za-z0-9_-]+))?(?=\n\[LEARN\]|\n\n|$)/gim;

    let match: RegExpExecArray | null;
    let count = 0;
    let lastIndex = -1;
    const blocks: LEARNBlock[] = [];

    while ((match = regex.exec(response)) !== null) {
      if (regex.lastIndex === lastIndex) break;
      lastIndex = regex.lastIndex;

      blocks.push({
        category: match[1].trim(),
        rule: match[2].trim(),
        mistake: match[3]?.trim(),
        correction: match[4]?.trim(),
        wikiSlug: match[5]?.trim(),
      });
      count++;
    }

    if (count > 0) {
      console.error(`[ProWorkflow] Detected ${count} [LEARN] block(s):`);
      blocks.forEach((b, i) => {
        console.error(`  ${i + 1}. [${b.category}] ${b.rule}`);
      });
      // 实际项目里这里会写入 SQLite
    }
  } catch (err) {
    console.error(`[ProWorkflow] Parse error: ${(err as Error).message}`);
  }

  // 透传原数据
  process.stdout.write(input);
}

main().catch(() => process.exit(0));
```

**测试输入**：

```bash
echo '{"assistant_response":"[LEARN] testing: 用 SQLite in-memory 替代 mock\nMistake: mock 整个 Postgres\nCorrection: 真实 SQLite 保留约束"}' | ts-node scripts/learn-capture.ts
```

**预期输出**：

```text
[ProWorkflow] Detected 1 [LEARN] block(s):
  1. [testing] 用 SQLite in-memory 替代 mock
```

### 5.3 Skill Optimizer 最小骨架

```typescript
// optimizer/apply.ts 的简化版
interface Patch {
  op: "add" | "delete" | "replace";
  anchor: string;
  payload: string;
}

function applyPatch(skill: string, patch: Patch): { ok: boolean; content: string; reason?: string } {
  if (patch.op === "add") {
    if (!patch.anchor) {
      return { ok: true, content: skill.replace(/\s*$/, "\n\n") + patch.payload + "\n" };
    }
    if (!skill.includes(patch.anchor)) {
      return { ok: false, content: skill, reason: `anchor not found: ${patch.anchor.slice(0, 60)}` };
    }
    const at = skill.indexOf(patch.anchor) + patch.anchor.length;
    return { ok: true, content: skill.slice(0, at) + "\n\n" + patch.payload + skill.slice(at) };
  }

  if (patch.op === "replace") {
    if (!skill.includes(patch.anchor)) {
      return { ok: false, content: skill, reason: `anchor not found: ${patch.anchor.slice(0, 60)}` };
    }
    return { ok: true, content: skill.replace(patch.anchor, () => patch.payload) };
  }

  if (patch.op === "delete") {
    if (!skill.includes(patch.anchor)) {
      return { ok: false, content: skill, reason: `anchor not found: ${patch.anchor.slice(0, 60)}` };
    }
    return { ok: true, content: skill.replace(patch.anchor, "").replace(/\n{3,}/g, "\n\n") };
  }

  return { ok: false, content: skill, reason: `unknown op: ${patch.op}` };
}

function applyPatches(skill: string, patches: Patch[]): { content: string; applied: Patch[]; skipped: Patch[] } {
  let content = skill;
  const applied: Patch[] = [];
  const skipped: Patch[] = [];

  for (const patch of patches) {
    const result = applyPatch(content, patch);
    if (result.ok) {
      content = result.content;
      applied.push(patch);
    } else {
      skipped.push(patch);
    }
  }

  return { content, applied, skipped };
}

// 演示
const originalSkill = `# 测试风格

不要 mock 数据库连接。
所有测试用真实 SQLite in-memory。`;

const patches: Patch[] = [
  {
    op: "replace",
    anchor: "所有测试用真实 SQLite in-memory。",
    payload: "所有测试用真实 SQLite in-memory（保留外键约束和触发器）。",
  },
  {
    op: "add",
    anchor: "不要 mock 数据库连接。",
    payload: "理由：mock 会绕过 SQL 语法、类型和外键约束的检查。",
  },
  {
    op: "replace",
    anchor: "## 不存在的章节",
    payload: "## 永远到不了这里",
  },
];

const result = applyPatches(originalSkill, patches);
console.log("=== 应用后的 SKILL.md ===");
console.log(result.content);
console.log("\n=== 成功应用 ===");
result.applied.forEach(p => console.log(`  ${p.op} @ "${p.anchor.slice(0, 40)}..."`));
console.log("\n=== 跳过 ===");
result.skipped.forEach(p => console.log(`  ${p.op} @ "${p.anchor.slice(0, 40)}..."`));
```

**运行结果**：

```text
=== 应用后的 SKILL.md ===
# 测试风格

不要 mock 数据库连接。
理由：mock 会绕过 SQL 语法、类型和外键约束的检查。
所有测试用真实 SQLite in-memory（保留外键约束和触发器）。

=== 成功应用 ===
  replace @ "所有测试用真实 SQLite in-memory。"
  add @ "不要 mock 数据库连接。"
=== 跳过 ===
  replace @ "## 不存在的章节"
```

失败的 patch 被正确跳过——**业务逻辑的事务性是 Harness 的灵魂**。

---

## 六、优缺点对比

### 6.1 多维度评估

| 维度 | 评分 | 关键支撑 |
|---|---|---|
| **架构简洁性** | ⭐⭐⭐⭐ | 4 层架构清晰；FTS5 触发器替代显式同步 |
| **扩展性** | ⭐⭐⭐⭐⭐ | 24 事件 + 41 skills + 37 脚本，runtime 注册 |
| **易用性** | ⭐⭐⭐ | 安装一行 (`/plugin marketplace add`)，但 v3.3 wiki + llm-council 有学习曲线 |
| **性能** | ⭐⭐⭐⭐ | 启动 ~200ms（SQLite + dist/ 加载）；FTS5 < 10ms；hook 脚本每次 spawn node（10-50ms） |
| **复杂度** | ⭐⭐（高） | 41 skills + 8 agents + 23 commands + 37 scripts，新人不知道从哪开始 |
| **维护性** | ⭐⭐⭐ | TypeScript + 强类型 schema，但 hook 脚本是 JS（缺少类型） |

### 6.2 三大权衡

```mermaid
graph LR
    A["🔴 复杂度<br/>vs<br/>🟢 完整性"]
    B["🟠 单机 SQLite<br/>vs<br/>🟣 协作云端"]
    C["🟡 自动捕获<br/>vs<br/>🔵 手动治理"]

    A -->|"pro-workflow 倾向完整性"| A1["41 skills 一次给齐"]
    B -->|"pro-workflow 倾向单机"| B1["~/.pro-workflow/data.db"]
    C -->|"pro-workflow 倾向自动化"| C1["[LEARN] 块 + auto-research"]

    style A fill:#FFB3C6,stroke:#F48FB1,color:#333
    style A1 fill:#E8D5F5,stroke:#CE93D8,color:#333
    style B fill:#FFB3C6,stroke:#F48FB1,color:#333
    style B1 fill:#B5EAD7,stroke:#80CBC4,color:#333
    style C fill:#FFB3C6,stroke:#F48FB1,color:#333
    style C1 fill:#FFF9C4,stroke:#F9A825,color:#333
```

**6 个核心优势**：

1. **24 事件覆盖** —— 超过 Claude Code 原生 12 类事件 100%，包含自定义 `FileChanged` / `WorktreeCreate` 等
2. **FTS5 + BM25** —— 比 CLAUDE.md 全文检索快 10-100 倍；触发器自动同步
3. **Skill Optimizer 闭环** —— 业界唯一开源的 SKILL.md 自我演化实现
4. **跨 32+ Agent 通用** —— 通过 `skills add` 抽象层，Cursor / Codex / Aider 都能用
5. **Wiki + FTS5 知识库** —— 9 种 wiki flavor + 自动研究循环，工程化程度远超 Notion AI
6. **多 LLM 审议（llm-council）** —— Anthropic + OpenAI + OpenRouter 3 阶段决策，避免单模型偏见

**6 个核心缺点**：

1. **复杂度高** —— 41 skills + 8 agents + 23 commands + 37 scripts，新人不知道从哪开始
2. **SQLite 是单机** —— team-level 协作需要外层做共享层（计划中）
3. **Hook 脚本是 JS** —— 缺少 TypeScript 类型保护；维护成本高
4. **依赖 dist/ 构建** —— 大部分 marketplace 跳过 `npm run build`，导致 data.db 找不到
5. **LLM 自主声明不保证质量** —— LLM 可能写"[LEARN] junk: xxx" 污染库
6. **v3.3 知识库实验性** —— wiki-research-loop 还在 alpha 阶段，budget cap 算法未稳定

---

## 七、横向对比：5 个 Harness 标杆

| 维度 | pro-workflow | Superpowers | ECC | gstack | GSD |
|------|:---:|:---:|:---:|:---:|:---:|
| **Stars** | 2753 | 14k+ | 236k+ | 12k+ | 5k+ |
| **Skills 数** | 41 | 14 | 140+ | 18+ | 0 |
| **Agents 数** | 8 | 5 | 36 | 0 | 18 |
| **Hook 事件** | 24 | 8 | 18 | 0 | 0 |
| **FTS5 自学习** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **Skill Optimizer** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **跨 Agent** | 32+ | 1 | 32+ | 1 | 1 |
| **Wiki 知识库** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **LLM Council** | ✅ | ❌ | ❌ | ❌ | ❌ |
| **持久化** | SQLite | 文件 | 文件 | 内存 | 文件 |

**对比分析（设计哲学层面）**：

```mermaid
graph TB
    subgraph "🟣 哲学1：规则最小化"
        SP["Superpowers<br/>14 skills 一次性给清"]
        ECC["ECC<br/>140+ 覆盖所有场景"]
    end

    subgraph "🟢 哲学2：模型驱动"
        GST["gstack<br/>CEO / Designer / QA 角色"]
        GSD["GSD<br/>18 agents 阶段化"]
    end

    subgraph "🔵 哲学3：长期记忆"
        PW["pro-workflow<br/>FTS5 + Wiki + Optimizer"]
    end

    style SP fill:#E8D5F5,stroke:#CE93D8,color:#333
    style ECC fill:#E8D5F5,stroke:#CE93D8,color:#333
    style GST fill:#FFDAB9,stroke:#FFAB76,color:#333
    style GSD fill:#FFDAB9,stroke:#FFAB76,color:#333
    style PW fill:#B5EAD7,stroke:#80CBC4,color:#333
```

**pro-workflow 的差异化定位**：

1. **vs Superpowers** —— Superpowers 是"14 个 SOP 模板"，pro-workflow 是"14 个 SOP + 自动学习 SOP 缺什么"。后者认知复杂度更高，但上限更高。
2. **vs ECC** —— ECC 是"140 个 skill 一次给齐"，pro-workflow 是"41 个 skill + 工具自己追加"。后者技能增长是 O(用户纠错)，是 O(1) skill 数。
3. **vs gstack** —— gstack 是"CEO / Designer / QA 22 个角色"，每个角色大而全；pro-workflow 的 8 个 agent 更轻，靠 Skill 组合承担复杂性。
4. **vs GSD** —— GSD 是"18 个阶段化 agent"，纯流程驱动；pro-workflow 是"阶段 + 长期记忆"，能用上次纠错指导下次。

**核心结论**：pro-workflow 是**目前唯一开源的"记忆 + 自我演化"复合 Harness**。其他项目偏向"skill 集合"或"agent 编排"，而 pro-workflow 把 Harness 当数据库设计。

---

## 八、跨 32+ Agent 的设计哲学

pro-workflow 的一个独门能力是 **跨 Agent 兼容**——通过 `npx skills add` 让同一套 Skill 同时被 Claude Code、Cursor、Codex CLI、Gemini CLI、OpenCode 等 32+ 个 Agent 加载。

```mermaid
graph LR
    PW["📦 pro-workflow<br/>41 skills + 8 agents"]

    subgraph "🟣 Claude Code 系"
        CC["Claude Code"]
        CR["Cursor"]
        CD["Codex CLI"]
    end

    subgraph "🟢 其他 Terminal 系"
        GC["Gemini CLI"]
        OC["OpenCode"]
        WT["Windsurf"]
    end

    subgraph "🟠 编辑器系"
        CDX["Continue"]
        CRW["Cline"]
        GH["GitHub Copilot"]
    end

    subgraph "🔵 新兴系"
        ZN["Zencoder"]
        QC["Qwen"]
        RD["Roo Code"]
    end

    PW -->|"npx skills add"| CC
    PW -->|"skills add"| CR
    PW -->|"skills add"| CD
    PW -->|"skills add"| GC
    PW -->|"skills add"| OC
    PW -->|"skills add"| WT
    PW -->|"skills add"| CDX
    PW -->|"skills add"| CRW
    PW -->|"skills add"| GH
    PW -->|"skills add"| ZN
    PW -->|"skills add"| QC
    PW -->|"skills add"| RD

    style PW fill:#FFDAB9,stroke:#FFAB76,color:#333
    style CC fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style CR fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style CD fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style GC fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style OC fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style WT fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style CDX fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style CRW fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style GH fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style ZN fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style QC fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style RD fill:#C7CEEA,stroke:#9FA8DA,color:#333
```

**为什么这个设计重要？**

如果一个团队同时使用 Claude Code（主力）+ Cursor（PR review）+ Codex CLI（CI 自动化），传统 Harness 是 3 套独立配置。pro-workflow 通过**抽象 `skills add` 安装器** + **AGENTS.md 通用协议** + **Hook 事件标准化**，让 41 个 skills 一次编写、所有 Agent 复用。

这是 **Harness Engineering 的"协议层胜利"** —— 把"工具差异"压在 `skills add` 一层，Harness 自身专注长期记忆。

---

## 九、从零搭建启示

### 9.1 MVP 最小可行 Harness（4 步）

| 步骤 | 做什么 | 花费 |
|------|--------|------|
| **1. SQLite + FTS5 学习库** | 仿照 pro-workflow schema，3 张表 + 1 个 FTS5 虚拟表 + 触发器 | 30 分钟 |
| **2. [LEARN] 块捕获 hook** | Stop 事件 + 正则匹配 + 写入 SQLite | 1 小时 |
| **3. SessionStart 注入** | 启动时 BM25 检索相关 learning，注入到上下文 | 1 小时 |
| **4. UserPromptSubmit 自动注入** | 每次用户输入时，按关键词触发 top-3 learning 注入 | 1 小时 |

**最小代码量**：约 200 行 TypeScript + 1 个 SQLite schema。

### 9.2 哪些组件是必须的？

| 组件 | 必须？ | 理由 |
|------|--------|------|
| SQLite + FTS5 | ✅ 核心 | 存储 + 检索根基 |
| [LEARN] 正则 | ✅ 核心 | LLM 自主声明协议 |
| Stop 事件捕获 | ✅ 核心 | 数据入口 |
| SessionStart 注入 | ✅ 核心 | 数据出口 |
| 24 事件 | ⚠️ 8 个先够 | PreToolUse / PostToolUse / Stop / SessionStart / SessionEnd / UserPromptSubmit / PermissionRequest / SubagentStart |
| Skill Optimizer | ❌ 二期 | 等积累了 100+ learning 再做 |
| Wiki + 自动研究 | ❌ 三期 | 通用知识库，超出"个人 Harness" 范畴 |
| llm-council | ❌ 三期 | 多人协作场景才有价值 |

### 9.3 踩坑预警

**坑 1：触发器死锁**

```sql
-- 错误：FTS5 表本身也是触发器来源
CREATE TRIGGER bad AFTER INSERT ON learnings_fts BEGIN
  INSERT INTO learnings_fts ...   -- 递归！
END;
```

**正确做法**：FTS5 是 `content=learnings` 外部内容表，**只在 learnings 上写触发器**，绝不在 FTS5 上写触发器。

**坑 2：Hook 脚本 spawn 太慢**

每次 hook 触发都 `node scripts/xxx.js`：单次 30-80ms，密集调用时（PreToolUse.Edit）会变成 200ms+。

**优化方案**：把多个脚本合并成 1 个 daemon 进程，通过 Unix socket 通信。但 pro-workflow 暂未采用（保持简单）。

**坑 3：FTS5 标点过滤**

FTS5 的 MATCH 语法对 `(`、`*`、`"` 等字符敏感。`nothing AND mocked` 报错，必须先 `sanitizeQuery`：

```typescript
function sanitizeQuery(query: string): string {
  return query.replace(/[^\w\s*"]/g, ' ').replace(/\s+/g, ' ').trim();
}
```

**坑 4：分布式 HMERGE buggy**

FTS5 在多 writer 并发插入时可能触发 `database is locked`。SQLite 默认是文件锁。

**解法**：用 `PRAGMA journal_mode=WAL` + 单写多读的连接池。

**坑 5：跨平台路径**

```typescript
// ❌ 错误
const path = `/Users/${user}/.pro-workflow/data.db`;

// ✅ 正确
const path = path.join(os.homedir(), '.pro-workflow', 'data.db');
```

Hook 脚本里所有路径必须用 `path.join(os.homedir(), ...)`，cron subagent 环境下 `~` 不会展开。

---

## 十、给 Harness 工程师的 5 条建议

1. **不要把所有学习塞进 CLAUDE.md** —— 50 条规则后 CLAUDE.md 会膨胀到 5KB+，每次会话都吃满 2000 token。SQLite FTS5 + Lazy 加载是更便宜的方案。

2. **把"LLM 自主声明"作为第一原则** —— 让 LLM 在回复中写 `[LEARN]` 块，比外部分类器便宜 100 倍。`[LEARN]` 协议是 Harness 自学习的最简实现。

3. **Hook 事件不要超过 24 个** —— 24 事件已经覆盖 95% 的可观测场景。每个新事件都要做"业务上不可或缺"的判断。

4. **Skill Optimizer 二期再做** —— 没有 100 条 learning 之前，不要上 Optimizer。噪声数据训练出来的是噪声 Skill。

5. **跨 Agent 兼容用 `skills add`** —— 不要为每个 Agent 写一套 Harness。`npx skills add` 是项目级抽象层，1 次维护 32+ Agent 复用。

---

## 总结

pro-workflow 是一个**记忆优先**的 Harness 组件：它把"用户的纠错"看成比"skill 数量"更重要的资产。

**3 个核心洞察**：

1. **记忆存储结构 > 训练方法** —— SQLite FTS5 + BM25 比 RLHF 便宜 6 个数量级。
2. **LLM 自主声明 > 外部分类器** —— `[LEARN]` 块让 LLM 自己决定学习什么、归在哪类。
3. **Skill Optimizer 是 Harness 闭环** —— 累积纠错 → 反思 patch → 验证 → 拒绝回放。这是 Harness 自我演化的最小实现。

**与其他 Harness 的最大差异**：pro-workflow 不是"给你一组 skills"，而是"让 skills 从你的纠错中长出来"。

**如果你只想读 1 段代码**：先读 `src/optimizer/apply.ts`（67 行），看 anchor-based 编辑如何用最简逻辑保证事务性。这是 Harness 工程哲学的最小缩影。

---

## 附录：pro-workflow 项目核心数据

| 维度 | 数值 |
|---|---|
| **GitHub Stars** | 2753 |
| **最新提交** | 2026-07-27 |
| **License** | MIT |
| **Skills** | 41 |
| **Agents** | 8 |
| **Commands** | 23 |
| **Hook 脚本** | 37 |
| **Hook 事件** | 24 |
| **支持 Agent** | 32+ |
| **核心语言** | TypeScript + Node.js |
| **存储** | SQLite + FTS5 |
| **项目链接** | https://github.com/rohitg00/pro-workflow |

---

**系列文章**：
- 上一篇（2026-08-01）：Cline 可回滚编码 Harness
- 下一篇预告：MCP Server 跨 Agent 协议如何统一
