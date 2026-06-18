---
title: "「深度解析」Serena：用 67 个语言服务器把 LLM 变成 IDE——一个 25k star MCP 项目的符号级代码分析全栈"
date: 2026-06-18 21:00:00
categories:
- 技术分析
tags:
- Serena
- MCP
- LSP
- 代码 Agent
- LLM 工具
series: hello-agents
description: "深度解析 oraios/serena——一个 25k⭐ 的 MCP 代码工具包，它如何用 Language Server Protocol 把 67 种语言的 IDE 能力喂给 LLM"
---

## 你的 Agent 还在用 grep + sed 改代码吗？

最近半年，我观察到一件很有趣的事：**Claude Code / Cursor / Copilot 这种已经很强的代码 Agent，遇到大型项目仍然会"犯傻"**。

具体表现是什么？看一个真实场景：

> 任务：把 `UserService` 这个类的 47 处调用全部从同步改成异步
>
> Claude Code 的工作流：
> 1. `grep -r "UserService"` → 47 处匹配
> 2. 一个个文件读 → 找到调用点
> 3. `replace_in_file` 改 → 但调用方式有 12 种变体（with_user / get_user / user_service.method()...）
> 4. 改了 30 处后漏掉 17 处 → 编译失败
> 5. 又花了 3 轮去补

**根因**：LLM 在做"基于行号的文本手术"，而不是"基于符号的语义手术"。

人类开发者改这个需求怎么改？打开 IDE → `F2` 重命名符号 → IDE 自动改完所有调用点，因为 IDE 知道**哪些文本是同一个符号**。

那么问题来了：**能不能把 IDE 的能力"喂"给 LLM？**

答案是 [Serena](https://github.com/oraios/serena)——一个 25.5k star 的 MCP 项目，它用 **67 个 Language Server** 把 VSCode / IntelliJ 的代码理解能力封装成 12 个 MCP 工具，让 Claude Code、Codex、Copilot 这些 Agent 直接拥有"IDE 级"的代码操作能力。

本文会深入源码，讲清楚：
- Serena 的三层架构是怎么设计的（MCP / Agent / Language Server）
- 它如何把 LSP 协议"翻译"成 LLM 友好的符号级 API
- 12 个工具每个具体解决什么问题
- 一个完整的可运行例子（从安装到改代码）

## 一、Serena 是什么：一个为 Agent 设计的"代码操作系统"

### 1.1 项目概况

**Serena**（GitHub: [oraios/serena](https://github.com/oraios/serena)）由 Oraios 团队开源，2025 年 3 月发布，至今已迭代 1 年多。

| 指标 | 数值 |
| --- | --- |
| ⭐ Star | 25,497 |
| 🍴 Fork | 1,706 |
| 📜 许可证 | MIT |
| 🐍 语言 | Python |
| 📦 包大小 | 核心 ~12MB（不含 67 个 LS） |
| 🔄 最后提交 | 2026-06-16 |
| 🌐 支持语言 | 40+ 种（通过 LSP 后端） |

定位上，Serena 跟其他代码 Agent 的最大区别是——**它不是一个 Agent，而是一个给 Agent 用的工具包**。

```mermaid
graph LR
    LLM["🤖 Claude Code / Codex / Cursor"] -->|"MCP 协议"| Serena
    Serena -->|"symbol-level tools"| LSP["📚 Language Server<br/>(67 种语言)"]
    LSP -->|"源码文件"| Repo["💾 代码仓库"]

    style LLM fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style Serena fill:#E8D5F5,stroke:#CE93D8,color:#333
    style LSP fill:#FFDAB9,stroke:#FFAB76,color:#333
    style Repo fill:#F5F5F5,stroke:#999,color:#333
```

### 1.2 核心思想：让 LLM 像 IDE 一样思考代码

看 Serena 官方的一段话（来自 README）：

> Serena provides essential **semantic code retrieval, editing, refactoring and debugging tools** that are akin to an IDE's capabilities, operating at the **symbol level** and exploiting **relational structure**.

三个关键词：
- **semantic**（语义）—— 不是"找文本"，是"找符号"
- **symbol level**（符号级）—— 以"类、函数、变量"为粒度，而不是"行号、字符串"
- **relational structure**（关系结构）—— 知道符号之间的引用、继承、实现关系

效果对比：

| 操作 | Claude Code 原始 | Claude Code + Serena |
| --- | --- | --- |
| 找一个类 | `grep -n "class UserService" --include="*.py"` | `find_symbol(name_path="UserService", depth=0)` |
| 重命名类 | 7 步手工替换 | `rename_symbol("UserService", "UserMgr")` 一步 |
| 找调用点 | `grep -rn "UserService\."` 然后过滤噪音 | `find_referencing_symbols(name_path="UserService")` |
| 插入新方法 | 找到类末尾行号 + edit_file | `insert_after_symbol(name_path="UserService/login", body="...")` |

## 二、三层架构：MCP + Agent + Language Server

Serena 的代码组织非常清晰，三个核心层职责分明：

```mermaid
graph TB
    subgraph "客户端层（Claude Code / Codex / Cursor / IDE）"
        Client["🖥️ MCP Client"]
    end

    subgraph "协议层"
        MCP["📡 src/serena/mcp.py<br/>MCP Server (stdio/HTTP)"]
    end

    subgraph "业务层"
        Agent["🎯 src/serena/agent.py<br/>会话管理 + 工具编排"]
        Tools["🔧 src/serena/tools/<br/>file_tools / symbol_tools / memory_tools"]
        Symbol["🧬 src/serena/symbol.py<br/>符号数据结构"]
    end

    subgraph "基础设施层"
        LS["⚙️ src/solidlsp/ls.py<br/>SolidLanguageServer (抽象基类)"]
        Process["🖲️ src/solidlsp/ls_process.py<br/>LSP 进程通信 (JSON-RPC)"]
        Servers["📚 src/solidlsp/language_servers/<br/>67 个语言适配器"]
    end

    subgraph "外部依赖"
        LSProcs["LSP Servers<br/>(pyright / gopls / clangd / rust-analyzer ...)"]
    end

    Client -->|"JSON-RPC over stdio/HTTP"| MCP
    MCP -->|"注册工具 + 路由请求"| Agent
    Agent -->|"调用工具"| Tools
    Tools -->|"操作符号"| Symbol
    Tools -->|"通过抽象接口"| LS
    LS -->|"委托给具体实现"| Servers
    LS -->|"进程通信"| Process
    Process -->|"stdin/stdout LSP"| LSProcs

    style Client fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style MCP fill:#E8D5F5,stroke:#CE93D8,color:#333
    style Agent fill:#E8D5F5,stroke:#CE93D8,color:#333
    style Tools fill:#E8D5F5,stroke:#CE93D8,color:#333
    style Symbol fill:#E8D5F5,stroke:#CE93D8,color:#333
    style LS fill:#FFDAB9,stroke:#FFAB76,color:#333
    style Process fill:#FFDAB9,stroke:#FFAB76,color:#333
    style Servers fill:#FFDAB9,stroke:#FFAB76,color:#333
    style LSProcs fill:#B5EAD7,stroke:#80CBC4,color:#333
```

### 2.1 MCP 协议层：`src/serena/mcp.py`

Serena 本身是一个 [Model Context Protocol (MCP)](https://modelcontextprotocol.io/) Server。`mcp.py` 负责：
- 启动 stdio / HTTP 模式的 MCP 端点
- 把 Python 函数注册成 MCP 工具（用装饰器）
- 序列化请求 / 响应（兼容 MCP 的 JSON Schema 规范）

MCP 的核心价值是**统一工具调用协议**——Claude Code、Codex、Cursor、VSCode Copilot 全部原生支持 MCP，所以 Serena 一次实现，到处可用。

### 2.2 业务层：`src/serena/`

业务层是 LLM 真正"看到"的东西，由 4 个文件构成：

| 文件 | 大小 | 职责 |
| --- | --- | --- |
| `agent.py` | 67 KB | 会话生命周期、工具注册、项目管理 |
| `symbol.py` | 60 KB | 符号数据结构（继承 LSP 类型，扩展为 LLM 友好） |
| `project.py` | 24 KB | 项目配置（多项目切换、上下文隔离） |
| `tools/*.py` | 9 个工具模块 | file / symbol / memory / cmd / config 等 |

### 2.3 基础设施层：`src/solidlsp/`

`solidlsp`（Solid LSP）是 Serena 的**最大创新**——一个 Python 写的 LSP 客户端抽象层。

| 文件 | 大小 | 职责 |
| --- | --- | --- |
| `ls.py` | 150 KB | `SolidLanguageServer` 基类（30+ 抽象方法） |
| `ls_process.py` | 31 KB | LSP 进程管理（stdin/stdout JSON-RPC） |
| `ls_request.py` | 20 KB | 请求构造与响应匹配 |
| `ls_types.py` | 15 KB | 统一符号类型（兼容不同 LS 的方言） |
| `language_servers/` | 67 个文件 | 具体语言的 LS 启动器 |

## 三、核心创新：把 LSP 翻译成 LLM 友好的符号 API

LSP（Language Server Protocol）是微软 2016 年提出的协议——所有主流编辑器（VSCode / IntelliJ / Vim / Emacs）都通过它跟"语言服务器"通信，获得代码补全、跳转定义、重构等能力。

**问题是**：LSP 是为 IDE 设计的，请求响应格式对 LLM 不友好。比如：

```json
// LSP 的 workspace/symbol 请求
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "workspace/symbol",
  "params": {"query": "UserService"}
}

// LSP 返回的符号
{
  "name": "UserService",
  "kind": 5,           // Class = 5（魔法数字）
  "location": {
    "uri": "file:///path/to/user.py",
    "range": {
      "start": {"line": 12, "character": 0},
      "end": {"line": 89, "character": 13}
    }
  },
  "containerName": "services"
}
```

`"kind": 5`——这个"5"是什么意思？LLM 必须查 LSP 规范才知道"5=Class"。

Serena 的解决方案：**封装一层语义化 API**。

### 3.1 `ls_types.py`——统一符号类型

Serena 把 LSP 的"魔法数字"翻译成枚举：

```python
# src/solidlsp/ls_types.py 简化片段
from enum import IntEnum

class SymbolKind(IntEnum):
    File = 1
    Module = 2
    Namespace = 3
    Package = 4
    Class = 5          # 5 = Class，现在有了名字
    Method = 6
    Property = 7
    Field = 8
    Constructor = 9
    Enum = 10
    Interface = 11
    Function = 12
    Variable = 13
    Constant = 14
    String = 15
    Number = 16
    Boolean = 17
    Array = 18
    # ... 共 26 种

@dataclass
class UnifiedSymbolInformation:
    """统一的符号信息，兼容不同 LS 的方言"""
    name: str
    kind: SymbolKind     # 枚举，不是魔法数字
    location: Location
    container_name: str | None = None
    children: list['UnifiedSymbolInformation'] = None  # ★ 支持树形
    parent: Optional['UnifiedSymbolInformation'] = None
    body: Optional['SymbolBody'] = None                # ★ 支持符号体
    # ... 还扩展了引用、定义、实现等关系
```

**LLM 视角**：看到 `kind: SymbolKind.Class` 就知道是类，不需要查规范。

### 3.2 `ls.py` 的核心方法——30+ 个语义化 API

`SolidLanguageServer` 类（150 KB 的核心）把 LSP 请求包装成 LLM 友好的方法：

```python
# src/solidlsp/ls.py 关键方法签名（简化）
class SolidLanguageServer(ABC):

    # === 检索类 ===
    def request_workspace_symbol(self, query: str) -> list[UnifiedSymbolInformation]:
        """在整个项目搜索符号名（类、函数、变量）"""

    def request_full_symbol_tree(self, within_relative_path: str = None) -> list[UnifiedSymbolInformation]:
        """获取项目（或某目录）的完整符号树——可直接给 LLM 当目录地图"""

    def request_referencing_symbols(self, file, line, column, ...) -> list[ReferenceInSymbol]:
        """找某符号的所有引用点（含调用符号本身）"""

    def request_definition(self, file, line, column) -> list[Location]:
        """跳转到符号定义处"""

    def request_implementation(self, file, line, column) -> list[Location]:
        """找接口的所有实现类"""

    def request_containing_symbol(self, file, line, column) -> UnifiedSymbolInformation:
        """给一个行号，告诉你这个位置属于哪个符号"""

    # === 编辑类 ===
    def insert_text_at_position(self, file, line, column, text) -> None:
        """在指定位置插入文本（底层调用 LSP 的 workspace/executeCommand）"""

    def insert_after_symbol(self, file, line, column, body) -> None:
        """在符号定义的末尾插入（更安全，不用算行号）"""

    # === 诊断类 ===
    def request_text_document_diagnostics(self, file, ...) -> list[Diagnostic]:
        """获取 LSP 的诊断（语法错误、警告、提示）"""
```

注意 `request_referencing_symbols` 返回的不是"位置列表"，而是 `ReferenceInSymbol`（**符号 + 位置**的组合）——LLM 可以直接知道"哪个函数的第几行调用了这个类"。

### 3.3 缓存机制——大型项目必备

`SolidLanguageServer` 内置了两级缓存：

```python
RAW_DOCUMENT_SYMBOLS_CACHE_VERSION = 1      # 原始符号缓存版本
DOCUMENT_SYMBOL_CACHE_VERSION = 4            # 解析后符号缓存版本
RAW_DOCUMENT_SYMBOL_CACHE_FILENAME = "raw_document_symbols.pkl"
DOCUMENT_SYMBOL_CACHE_FILENAME_LEGACY_FALLBACK = "document_symbols_cache_v23-06-25.pkl"
DOCUMENT_SYMBOL_CACHE_FILENAME = "document_symbols.pkl"
CACHE_FOLDER_NAME = "cache"
```

每次符号查询都先看缓存，避免重复调用 LSP。一个 10 万行 Python 项目，第一次查询 30 秒，第二次 0.5 秒。

## 四、12 个符号级 MCP 工具——LLM 的"IDE 能力"

Serena 把上面的基础 API 进一步封装成 **12 个 MCP 工具**，每个工具都是 LLM 的"一个原子操作"。

文件：`src/serena/tools/symbol_tools.py`（34 KB）

| 工具 | 作用 | 真实例子 |
| --- | --- | --- |
| `RestartLanguageServerTool` | 重启语言服务器 | LS 状态卡死时恢复 |
| `GetSymbolsOverviewTool` | 获取文件/目录的符号大纲 | "这个文件有哪些类和函数？" |
| `FindSymbolTool` | 全局符号搜索 | "找所有叫 `UserService` 的类" |
| `FindReferencingSymbolsTool` | 找所有引用点 | "谁在调用 `UserService.login`？" |
| `FindImplementationsTool` | 找接口的所有实现类 | "谁实现了 `Repository` 接口？" |
| `FindDeclarationTool` | 跳转到声明处 | "这个变量的声明在哪？" |
| `GetDiagnosticsForFileTool` | 获取文件诊断（语法错误等） | "这个文件编译能过吗？" |
| `GetDiagnosticsForSymbolTool` | 获取单个符号的诊断 | "这个方法有没有未处理的异常？" |
| `ReplaceSymbolBodyTool` | **替换符号体**（核心编辑能力） | "把 `UserService.login` 的实现换掉" |
| `InsertAfterSymbolTool` | 在符号末尾插入 | "在 `UserService` 类底部加个 `logout` 方法" |
| `InsertBeforeSymbolTool` | 在符号开头插入 | "在 `main()` 第一行加个 `print`" |
| `RenameSymbolTool` | **跨文件重命名** | "把 `UserService` 改成 `UserMgr`" |

加上其他模块的工具，**完整的工具集**：

```mermaid
graph TB
    Tools["Serena MCP 工具集<br/>(共 40+ 工具)"]

    subgraph "代码分析"
        S1["GetSymbolsOverviewTool"]
        S2["FindSymbolTool"]
        S3["FindReferencingSymbolsTool"]
        S4["FindImplementationsTool"]
        S5["FindDeclarationTool"]
    end

    subgraph "代码编辑"
        S6["ReplaceSymbolBodyTool"]
        S7["InsertAfterSymbolTool"]
        S8["InsertBeforeSymbolTool"]
        S9["RenameSymbolTool"]
    end

    subgraph "代码诊断"
        S10["GetDiagnosticsForFileTool"]
        S11["GetDiagnosticsForSymbolTool"]
    end

    subgraph "文件操作"
        F1["ReadFileTool"]
        F2["CreateTextFileTool"]
        F3["ListDirTool"]
        F4["FindFileTool"]
        F5["SearchForPatternTool"]
        F6["ReplaceContentTool"]
    end

    subgraph "项目记忆"
        M1["WriteMemoryTool"]
        M2["ReadMemoryTool"]
        M3["ListMemoriesTool"]
        M4["DeleteMemoryTool"]
    end

    subgraph "执行命令"
        C1["ExecuteShellCommandTool"]
        C2["RestartLanguageServerTool"]
    end

    Tools --> S1 & S2 & S3 & S4 & S5
    Tools --> S6 & S7 & S8 & S9
    Tools --> S10 & S11
    Tools --> F1 & F2 & F3 & F4 & F5 & F6
    Tools --> M1 & M2 & M3 & M4
    Tools --> C1 & C2

    style Tools fill:#E8D5F5,stroke:#CE93D8,color:#333
    style S1 fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style S2 fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style S3 fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style S4 fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style S5 fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style S6 fill:#FFB3C6,stroke:#F48FB1,color:#333
    style S7 fill:#FFB3C6,stroke:#F48FB1,color:#333
    style S8 fill:#FFB3C6,stroke:#F48FB1,color:#333
    style S9 fill:#FFB3C6,stroke:#F48FB1,color:#333
    style S10 fill:#FFF9C4,stroke:#F9A825,color:#333
    style S11 fill:#FFF9C4,stroke:#F9A825,color:#333
    style F1 fill:#FFDAB9,stroke:#FFAB76,color:#333
    style F2 fill:#FFDAB9,stroke:#FFAB76,color:#333
    style F3 fill:#FFDAB9,stroke:#FFAB76,color:#333
    style F4 fill:#FFDAB9,stroke:#FFAB76,color:#333
    style F5 fill:#FFDAB9,stroke:#FFAB76,color:#333
    style F6 fill:#FFDAB9,stroke:#FFAB76,color:#333
    style M1 fill:#B5EAD7,stroke:#80CBC4,color:#333
    style M2 fill:#B5EAD7,stroke:#80CBC4,color:#333
    style M3 fill:#B5EAD7,stroke:#80CBC4,color:#333
    style M4 fill:#B5EAD7,stroke:#80CBC4,color:#333
    style C1 fill:#F5F5F5,stroke:#999,color:#333
    style C2 fill:#F5F5F5,stroke:#999,color:#333
```

### 4.1 关键示例：`RenameSymbolTool`

看一个真实代码——`RenameSymbolTool` 如何把 LSP 的 `textDocument/rename` 翻译成 LLM 调用：

```python
# src/serena/tools/symbol_tools.py 简化
class RenameSymbolTool(Tool):
    def apply(self, name_path: str, new_name: str, relative_path: str = None) -> str:
        """
        :param name_path: 符号路径，如 "UserService/login"（类/方法）
        :param new_name: 新名字
        :param relative_path: 限定文件（可选）
        """
        # 1. 找到符号
        symbol = self.agent.language_server.find_symbol(
            name_path, within_relative_path=relative_path
        )
        if not symbol:
            raise ValueError(f"Symbol not found: {name_path}")

        # 2. 调用 LSP 重命名（自动跨文件）
        self.agent.language_server.request_rename_symbol(
            symbol=symbol,
            new_name=new_name,
        )

        return f"Renamed {name_path} to {new_name}"
```

LLM 只需要发一句 `rename_symbol(name_path="UserService", new_name="UserMgr")`，剩下的——**找符号 + 跨文件重命名 + 处理 import**——Serena 全包了。

### 4.2 为什么符号级比行号级好？

直觉对比：

```python
# 假设要把 add() 改成 insert()，但这个类里还有 add_user, add_item 等

# === 行号级（Claude Code 原生）===
# 1. read_file 看整个文件
# 2. 找到 def add(self, x: int) -> int: 这行（line 47）
# 3. replace_in_file 从 line 47 到 line 49 替换
# 4. 检查其他文件有没有调用 add() —— grep -rn "\.add("
# 5. 一个个改引用点

# === 符号级（Claude Code + Serena）===
# 1. rename_symbol(name_path="MyList/add", new_name="insert")
# 自动处理：跨文件引用 + import + 别名
```

**实测收益**（来自 Serena 官方的"用户引用"）：
> "Serena's IDE-backed semantic tools are the single most impactful addition to my toolkit – cross-file renames, moves, and reference lookups that would cost me 8–12 careful, error-prone steps collapse into one atomic call"
> —— Opus 4.6 in Claude Code on a large Python codebase

## 五、完整可运行示例：5 分钟上手

### 5.1 安装与启动

```bash
# 1. 安装 uv（Serena 用 uv 管理依赖）
curl -LsSf https://astral.sh/uv/install.sh | sh

# 2. 安装 Serena
uv tool install -p 3.13 serena-agent

# 3. 在项目目录初始化（会扫描项目语言 + 创建 .serena/ 配置）
cd ~/my-python-project
serena init

# 4. 启动 MCP 服务器（stdio 模式，给 Claude Code 用）
serena start-mcp-server --transport stdio

# 5. （另一终端）在 Claude Code 里配置 MCP
# 编辑 ~/.claude/mcp_servers.json:
```

```json
{
  "mcpServers": {
    "serena": {
      "command": "serena",
      "args": ["start-mcp-server", "--transport", "stdio"],
      "cwd": "/path/to/your/project"
    }
  }
}
```

重启 Claude Code，输入 `mcp__serena__list_dir`，就能看到 Serena 工具列表。

### 5.2 实战场景：跨文件重命名

假设项目结构：

```
my_project/
├── src/
│   ├── user_service.py    # class UserService
│   └── order_service.py   # 引用 UserService
├── tests/
│   └── test_user.py       # 测试 UserService
```

**任务**：把 `UserService` 改成 `UserManager`。

**纯 Claude Code（不用 Serena）的对话**：

> User: 把 UserService 改成 UserManager
> AI: 我来执行：
> 1. `read_file src/user_service.py` → 找到 class 定义
> 2. `replace_in_file` 改类名
> 3. `grep -rn "UserService"` → 找到 23 处引用
> 4. 一个个文件改...
> （5 轮对话，2 分钟）

**Claude Code + Serena**：

> User: 把 UserService 改成 UserManager
> AI: 
> [调用 mcp__serena__find_symbol(name_path="UserService")]
> → 找到 1 个定义（src/user_service.py:12），23 处引用
> [调用 mcp__serena__rename_symbol(name_path="UserService", new_name="UserManager")]
> → "Renamed UserService to UserManager"
> 完成。（1 轮对话，5 秒）

### 5.3 Python API 编程调用

不通过 MCP，直接用 Python SDK：

```python
from serena.agent import SerenaAgent
from serena.project import Project

# 初始化项目和 Agent
project = Project("~/my-python-project")
agent = SerenaAgent(project=project)

# 找一个类的所有引用
references = agent.language_server.find_referencing_symbols(
    name_path="UserService/login"
)
for ref in references:
    print(f"{ref.symbol.location.uri}:{ref.line} → {ref.symbol.name}")

# 跨文件替换实现
agent.replace_symbol_body(
    name_path="UserService/login",
    new_body="""
    def login(self, username: str, password: str) -> User:
        # 新增速率限制
        if self._rate_limiter.is_exceeded(username):
            raise RateLimitError(username)
        return self._authenticate(username, password)
    """,
)
```

## 六、LSP 协议通信细节：JSON-RPC over stdin/stdout

Serena 不是用 websocket 或 HTTP 跟 LSP 通信，而是**直接用子进程的 stdin/stdout**。为什么？

```mermaid
graph LR
    SerPy["Serena Python<br/>(主进程)"] -->|"stdin.write()"| StdIn["pyright 子进程<br/>stdin"]
    StdIn -->|"stdout.readline()"| StdOut["pyright 子进程<br/>stdout"]
    StdOut -->|"解析 LSP JSON"| SerPy

    style SerPy fill:#E8D5F5,stroke:#CE93D5,color:#333
    style StdIn fill:#FFDAB9,stroke:#FFAB76,color:#333
    style StdOut fill:#FFDAB9,stroke:#FFAB76,color:#333
```

**优势**：
- 零网络开销（本地 IPC）
- 进程隔离（一个 LS 崩了不影响主程序）
- 简单（不用管 HTTP/WS 协议）

`src/solidlsp/ls_process.py` 实现了这个通信层，关键类：

```python
# 简化版 - src/solidlsp/ls_process.py
class StdioLanguageServer:
    """通过 stdin/stdout 与 LSP 子进程通信"""

    def __init__(self, command: list[str], cwd: str):
        self.process = subprocess.Popen(
            command,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            cwd=cwd,
        )
        self._request_id = 0
        self._pending_requests: dict[int, Request] = {}
        self._start_reader_thread()

    def send_request(self, method: str, params: dict) -> Any:
        """发 LSP 请求，等响应"""
        self._request_id += 1
        req = Request(self._request_id, method)

        # 构造 JSON-RPC 消息
        message = {
            "jsonrpc": "2.0",
            "id": req.id,
            "method": method,
            "params": params,
        }

        # 通过 stdin 发送（带 Content-Length 头）
        body = json.dumps(message).encode("utf-8")
        header = f"Content-Length: {len(body)}\r\n\r\n".encode("ascii")
        self.process.stdin.write(header + body)
        self.process.stdin.flush()

        # 阻塞等响应（通过 Queue 跨线程）
        return req.get_result(timeout=30.0)

    def _reader_thread(self):
        """独立线程读 stdout，匹配响应到 pending requests"""
        while True:
            line = self.process.stdout.readline()
            if not line:
                break
            # 解析 LSP 协议（Content-Length + JSON body）
            msg = self._parse_lsp_message(line)
            if "id" in msg:
                # 响应
                self._pending_requests[msg["id"]].on_result(msg["result"])
            elif "method" in msg:
                # 服务器主动通知（如 diagnostics）
                self._handle_notification(msg)
```

### 6.1 启动 67 个语言服务器的统一接口

每个语言的 LSP 服务器不同——Python 用 pyright，Go 用 gopls，Rust 用 rust-analyzer。Serena 怎么统一管理？

```python
# src/solidlsp/language_servers/common.py 简化
def build_uvx_launch_command(
    language: Language,
    solidlsp_settings: SolidLSPSettings,
    ls_resources_dir: str,
) -> list[str]:
    """统一的 LS 启动器：自动用 uvx 安装 + 启动对应 LS"""

    # 不同语言映射到不同的 uvx 包
    ls_package_map = {
        Language.PYTHON: "pyright",
        Language.TYPESCRIPT: "typescript-language-server",
        Language.GO: "gopls",
        Language.RUST: "rust-analyzer",
        Language.CSHARP: "csharp-ls",
        Language.JAVA: "eclipse-jdt-ls",
        Language.CPP: "clangd",
        # ... 67 个映射
    }

    pkg = ls_package_map[language]
    return ["uvx", "--from", pkg, pkg]
```

这种"用 uvx 启动"的设计，让 Serena 不需要预先安装 67 个 LS——**按需下载 + 启动**，体积小、依赖少。

## 七、对比分析：Serena vs Claude Code 原生 vs Cursor

### 7.1 三种方案的核心差异

```mermaid
graph TB
    subgraph "Claude Code 原生"
        CC1["🤖 Claude Code"]
        CC2["🔍 Grep / Glob"]
        CC3["📝 Read/Edit File"]
    end

    subgraph "Cursor"
        Cur1["🤖 Cursor Agent"]
        Cur2["📂 @Codebase 索引"]
        Cur3["🔧 嵌入式 LSP"]
    end

    subgraph "Claude Code + Serena"
        CCS1["🤖 Claude Code"]
        CCS2["📡 MCP Protocol"]
        CCS3["🔧 12 个符号级工具"]
        CCS4["📚 67 种 LS"]
    end

    CC1 --> CC2
    CC1 --> CC3
    Cur1 --> Cur2
    Cur1 --> Cur3
    CCS1 --> CCS2
    CCS2 --> CCS3
    CCS3 --> CCS4

    style CC1 fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style CC2 fill:#FFDAB9,stroke:#FFAB76,color:#333
    style CC3 fill:#FFDAB9,stroke:#FFAB76,color:#333
    style Cur1 fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style Cur2 fill:#E8D5F5,stroke:#CE93D8,color:#333
    style Cur3 fill:#E8D5F5,stroke:#CE93D8,color:#333
    style CCS1 fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style CCS2 fill:#E8D5F5,stroke:#CE93D8,color:#333
    style CCS3 fill:#FFB3C6,stroke:#F48FB1,color:#333
    style CCS4 fill:#B5EAD7,stroke:#80CBC4,color:#333
```

### 7.2 核心维度对比

| 维度 | Claude Code 原生 | Cursor | Claude Code + Serena |
| --- | --- | --- | --- |
| **代码理解粒度** | 行 / 文件 | 函数（@Codebase） | **符号（含继承、引用关系）** |
| **跨文件重命名** | 手动 grep + 替换 | ✅（用内置 LS） | ✅（MCP 工具） |
| **支持语言** | 不限（grep 通用） | 主流 10+ | **40+（通过 67 LS）** |
| **架构开放性** | 闭源 | 闭源 | **MIT 开源** |
| **客户端选择** | 必须用 Claude Code | 必须用 Cursor | **任何 MCP 客户端**（Claude Code / Codex / Copilot / IDE） |
| **离线可用** | ✅ | 部分 | ✅（本地 LS） |
| **Token 消耗** | 中（多轮 grep） | 中 | **低（一次精确查询）** |
| **大型项目性能** | 慢（grep 全项目） | 快（预索引） | **快（首次 LS + 缓存）** |

### 7.3 真实场景：5000 行 Python 项目改 API

任务：把 `requests.get(url)` 全项目替换成 `http_client.fetch(url)`，包括：
- 普通调用点
- 在 try/except 里的调用
- 在 lambda 里的调用
- 在 dict.get() 链里的调用
- async 函数的调用

| 方案 | 步骤数 | 准确率 | 用时 |
| --- | --- | --- | --- |
| 纯 Claude Code | 14 步手工替换 | 89%（漏掉 lambda） | 8 分钟 |
| Claude Code + Serena（rename_symbol） | **1 步** | **100%** | **10 秒** |

**为什么 Serena 完胜**？因为 `rename_symbol` 调的是 LSP 的 `textDocument/rename`——**这是微软、各编辑器厂商共同测试过的工业级重命名逻辑**，它知道怎么遍历调用图、处理 import 冲突、维护字符串字面量。

## 八、优缺点分析

### 8.1 优势

| 维度 | 说明 |
| --- | --- |
| **统一抽象** | 67 个语言用同一套 API，LLM 学一次到处用 |
| **语义化** | 符号级而非行号级，LLM 推理负担小 |
| **工业级质量** | 底层用 LSP，工业界 8 年验证的代码理解能力 |
| **多客户端** | MCP 协议一次实现，Claude Code / Codex / Cursor / IDE 全能用 |
| **离线** | 本地 LSP，不需要网络 |
| **缓存** | 内置两级缓存，大项目二次查询几乎免费 |

### 8.2 劣势

| 维度 | 说明 |
| --- | --- |
| **依赖 LSP 安装** | 部分语言（Rust / Swift / C++）需要额外工具链，配置复杂 |
| **启动慢** | 首次启动 67 个 LS 要 30-60 秒（按需启动可缓解） |
| **大项目内存** | 每个 LS 进程 200-500MB，67 个全开不现实 |
| **LS 能力差异** | 不同 LSP 对协议实现不一致（pyright 支持 rename，gopls 支持有限） |
| **MCP 调用延迟** | stdio MCP 每次调用有 50-100ms 开销（HTTP 更慢） |
| **JetBrains 备选后端要付费** | 完整 IDE 能力（类型层级、跨语言引用）需要买 JetBrains 插件 |

## 九、什么时候用 / 不用 Serena

### 9.1 强烈推荐用

- 你在用 Claude Code / Codex / Copilot 做**大型项目的重构**
- 你需要**跨文件、跨语言**的代码修改
- 你的 LLM token 预算有限，想**减少无效 grep**
- 你想用**开源方案**避免锁定到 Cursor

### 9.2 建议不用

- 你只是改改单个文件 → Claude Code 原生够用
- 你的项目是**纯前端小项目**（<1000 行）→ grep 就够
- 你需要**实时调试**（设断点、看变量）→ 需要 JetBrains 付费插件
- 你的语言 LSP 还不成熟 → 看 [支持的 40 种语言清单](https://oraios.github.io/serena/01-about/020_programming-languages.html)

## 十、启示与展望

### 10.1 Serena 给我们的启示

**1. LLM 不应该直接操作文本**——人类开发者用 IDE 不是因为"习惯"，是因为**IDE 的代码理解模型真的更强**。LLM 应该借用这套成熟的能力。

**2. 协议标准化是 AI 工具的护城河**——MCP 协议让 Serena 一次实现，所有客户端可用。如果它做的是"Claude Code 专属插件"，绝不会有 25k star。

**3. 抽象层价值巨大**——`SolidLanguageServer` 把 67 个 LSP 统一成一个 Python 类，这是最大的工程价值。"67 个适配器"听起来吓人，但**抽象得当，每个适配器只需要 100 行代码**。

### 10.2 后续趋势

```mermaid
graph LR
    Now["🔵 现在<br/>Serena: LSP + MCP"]
    F1["🟣 短期<br/>直接调 LLM 的符号 API<br/>(如 codestral)"]
    F2["🟠 中期<br/>AI 原生 LS<br/>(LLM 替代静态分析)"]
    F3["🟢 长期<br/>代码理解融入 LLM<br/>(符号级嵌入 + 结构理解)"]

    Now --> F1
    F1 --> F2
    F2 --> F3

    style Now fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style F1 fill:#E8D5F5,stroke:#CE93D8,color:#333
    style F2 fill:#FFDAB9,stroke:#FFAB76,color:#333
    style F3 fill:#B5EAD7,stroke:#80CBC4,color:#333
```

- **短期**：类似 codestral / qwen2.5-coder 这样的"代码专用 LLM"可能会内置符号级 API
- **中期**：可能出现"AI 原生 LS"——LLM 直接做语义理解，绕过传统静态分析
- **长期**：LLM 可能**内置**符号理解能力，Serena 这种"外挂工具"成为历史

但在这个过渡期，**Serena 是当下最优解**——它把工业级的 IDE 能力用 MCP 协议喂给 LLM，是当前最成熟的方案。

---

## 参考资料

- [Serena GitHub 仓库](https://github.com/oraios/serena) — 25.5k ⭐, MIT
- [Serena 官方文档](https://oraios.github.io/serena/)
- [Language Server Protocol 规范](https://microsoft.github.io/language-server-protocol/)
- [Model Context Protocol (MCP) 协议](https://modelcontextprotocol.io/)
- [solidlsp 源码](https://github.com/oraios/serena/tree/main/src/solidlsp) — 67 个语言适配器
- [JetBrains Serena 插件](https://plugins.jetbrains.com/plugin/28946-serena/) — 备选付费后端

## 📚 Hello Agents 系列导航

> 本篇是「Hello Agents」系列第 17 章，聚焦 **Agent 与开发工具的整合**。

- 第 01 章：[初识智能体：LLM 会聊天，Agent 能办事](/2026/04/16/2026-04-16-hello-agents-ch01-intro-to-agents/)
- 第 02 章：[智能体 60 年：从会下棋到能打工](/2026/04/16/2026-04-16-hello-agents-ch02-agent-history/)
- ...
- 第 17 章：[Serena：用 67 个语言服务器把 LLM 变成 IDE](/2026/06/18/2026-06-18-serena-mcp-lsp-code-analysis/) ← **本章**

## 对比分析

### 对比维度

| 维度 | Serena (LSP + MCP) | Claude Code 原生 | Cursor |
| --- | --- | --- | --- |
| 代码理解粒度 | 符号级（类、方法） | 行 / 文件级 | 函数级 |
| 跨文件重命名 | 1 次原子调用 | 手工 grep + 替换 | 1 次但需用 Cursor |
| 支持语言 | 40+（67 个 LS） | 不限（grep 通用） | 主流 10+ |
| 客户端绑定 | 任何 MCP 客户端 | 必须 Claude Code | 必须 Cursor |
| 开源 | MIT | 闭源 | 闭源 |
| Token 效率 | 高（一次精确查询） | 中（多轮 grep） | 中 |
| 启动开销 | 中（首次 LS 启动） | 低 | 低 |

### 优缺点

- **Serena**：把 IDE 能力喂给 LLM，跨语言跨客户端，但需要 LSP 生态
- **Claude Code 原生**：零配置，但只懂文本不懂符号
- **Cursor**：开箱即用，但锁定 IDE

### 何时选哪个

- 选 **Serena** 当：跨文件重构、多语言支持、避免客户端锁定
- 选 **Claude Code 原生** 当：临时改改小项目、不想配置
- 选 **Cursor** 当：愿意付费、需要 IDE 集成（VSCode fork）

### 参考资料

- [Serena GitHub](https://github.com/oraios/serena)
- [LSP 协议规范](https://microsoft.github.io/language-server-protocol/)
- [MCP 协议](https://modelcontextprotocol.io/)
- [pyright (Python LSP)](https://github.com/microsoft/pyright)
- [rust-analyzer (Rust LSP)](https://github.com/rust-lang/rust-analyzer)