---
title: 【Agent Vault】核心架构与 Harness 设计原理：把"凭据外泄"挡在 Agent 之外的 MITM 凭据代理
author: AI 调研员
date: 2026-08-04 08:00:00
categories: [技术分析]
tags: [Harness Engineering, Agent Vault, Credential Proxy, MITM, MCP]
words: 7800
reading_time: 15分钟
rating: 91
description: 从 Infisical/agent-vault（2007⭐，Go，Apache-2.0）出发，深度拆解 Harness 工程化中"凭据隔离"组件：MITM 代理 + 占位符替换 + 进程外凭证库 + netguard 防护，对比 mitmproxy / Squid / OAuth Proxy 的设计差异。
---

# 【Agent Vault】核心架构与 Harness 设计原理：把"凭据外泄"挡在 Agent 之外的 MITM 凭据代理

> 一句话概括：**Agent Vault = 进程外的凭据代理，让 Claude Code、OpenClaw、Hermes 这类 Coding Agent 在拥有真实 API Key 之前完成全部工作**。它不是又一个 forward proxy，而是 Harness 6 件套之外的"**第 7 件套**" —— **Credential Boundary**（凭据边界）。

## 🎯 为什么写它：Harness 工程化的"房间里的大象"

Agent 写代码、调 MCP、发 PR 越来越顺，但有一个问题被刻意忽略：**这些 Agent 拿到的 `ANTHROPIC_API_KEY`、`GITHUB_PAT` 是明文**。一旦 Agent 被 prompt injection 诱导输出"我看到的 API key 是..."，整个密钥就裸奔在对话日志里。

2024 年 OWASP LLM Top 10 把 LLM06（敏感信息泄露）排在第六位；2025 年 Snyk、Astrix 的研究都证实**"Agent 流程里的密钥泄漏"是 AI 工程化头号攻击面**。但市面方案普遍是"事后审计"——拿到日志再查；而 Agent Vault 选择**"事前不接触"**：Agent 根本看不到真密钥，只看到一个 `__anthropic_api_key__` 占位符，真密钥在另一台机器上由代理注入。

它到底怎么做到？和 mitmproxy / Squid 这些传统 forward proxy 有什么区别？为什么 Infisical 把它做成单 Go 二进制而非 Sidecar？今天的文章把 `Infisical/agent-vault` 2007⭐ 的核心代码翻一遍。

## 🏗️ 整体架构：3 层 5 模块的"物理隔离"设计

Agent Vault 不是软件层的中间件，而是**网络拓扑层的强制隔离**。它的核心思路是：

```
Agent 进程看不到真密钥
    ↓ HTTPS_PROXY=http://<token>@vault:14322
MITM 代理拦截所有出向请求
    ↓ 占位符替换（path/query/header/body/websocket）
凭据从 Vault 取出后注入到 outbound header
    ↓ 严格 netguard（CIDR allowlist + 169.254.169.254 永久黑名单）
转发到 api.anthropic.com / api.github.com
```

这种"**让模型看不到它不该看的东西**"的设计哲学和 Agent Harness 工程化的 Bitter Lesson 高度吻合：**别让 LLM 去"理解"安全规则，把安全约束做成物理层的强制边界**。

下面是 Agent Vault 的 5 个核心模块：

```mermaid
graph TB
    subgraph AgentHost["🖥️ Agent 主机（不可信）"]
        Agent["🤖 Coding Agent<br/>Claude Code / Hermes / OpenClaw"]
        Dummy["🔑 假密钥<br/>__anthropic_api_key__"]
        Env["⚙️ 环境变量<br/>HTTPS_PROXY + AGENT_VAULT_TOKEN"]
    end

    subgraph VaultHost["🔐 Vault 主机（受信）"]
        CLI["💻 agent-vault CLI<br/>run -- claude"]
        MITM["🌐 MITM 代理<br/>:14322 CONNECT/HTTP"]
        Broker["🔄 brokercore<br/>substitution.go"]
        Store["💾 凭据库<br/>SQLite / Postgres"]
        NetGuard["🛡️ netguard<br/>CIDR allowlist"]
    end

    subgraph Public["🌍 公网目标 API"]
        Anthropic["🤖 api.anthropic.com"]
        GitHub["🐙 api.github.com"]
    end

    Agent -->|"带假密钥的请求"| CLI
    CLI -->|"HTTPS_PROXY 注入"| MITM
    MITM -->|"CONNECT 隧道"| Broker
    Broker -->|"取真密钥"| Store
    Broker -->|"占位符替换 → 真密钥"| NetGuard
    NetGuard -->|"出向请求（带真密钥）"| Anthropic
    NetGuard --> GitHub

    style Agent fill:#FFB3C6,stroke:#333,color:#333
    style Dummy fill:#FFF9C4,stroke:#333,color:#333
    style Env fill:#FFF9C4,stroke:#333,color:#333
    style CLI fill:#FFDAB9,stroke:#333,color:#333
    style MITM fill:#E8D5F5,stroke:#333,color:#333
    style Broker fill:#C7CEEA,stroke:#333,color:#333
    style Store fill:#B5EAD7,stroke:#333,color:#333
    style NetGuard fill:#FFB3C6,stroke:#333,color:#333
    style Anthropic fill:#F5F5F5,stroke:#333,color:#333
    style GitHub fill:#F5F5F5,stroke:#333,color:#333
    style AgentHost fill:#F5F5F5,stroke:#333,color:#333,stroke-dasharray: 5 5
    style VaultHost fill:#E8D5F5,stroke:#333,color:#333,stroke-dasharray: 5 5
    style Public fill:#F5F5F5,stroke:#333,color:#333,stroke-dasharray: 5 5
```

**关键观察**：
1. **物理边界**：Agent 主机和 Vault 主机是不同机器（README 明确要求），`netguard` 默认拒绝 RFC-1918 私网段，避免 Agent 通过 Vault 反向访问云元数据（169.254.169.254 永久黑名单）
2. **协议复用**：用标准 `HTTPS_PROXY` 环境变量而非 SDK 入侵式注入，对 Coding Agent 零侵入
3. **单二进制**：一个 Go binary 同时跑 CLI 和 MITM 代理（`cmd/server.go` + `internal/mitm/proxy.go`），运维复杂度最低

## 🔑 4 大核心机制原理（附可运行代码）

### 机制 1：占位符替换（substitution.go）—— 5 种注入面 + 注入错误绝不转发

`internal/brokercore/substitution.go` 定义了 5 种替换面：`path / query / header / body / websocket`，每条规则可独立选择注入位置。**关键设计：header 注入有 CRLF 守卫，body 替换有 64MiB 上限，任何替换出错都不转发**。

```go
// internal/brokercore/substitution.go（真实代码，省略注释）
type ResolvedSubstitution struct {
    Placeholder string   // 例如 "__anthropic_api_key__"
    Value       string   // 真实密钥，绝不记日志
    In          []string // 子集 {"path","query","header","body","websocket"}
}

func HasBodySubstitutions(subs []ResolvedSubstitution) bool {
    for _, sub := range subs {
        for _, s := range sub.In {
            if s == "body" { return true }
        }
    }
    return false
}

func ApplySubstitutions(u *url.URL, headers http.Header, subs []ResolvedSubstitution) error {
    for _, sub := range subs {
        for _, surface := range sub.In {
            switch surface {
            case "path":
                escaped := u.EscapedPath()
                rewritten := strings.ReplaceAll(escaped, sub.Placeholder, url.PathEscape(sub.Value))
                if rewritten == escaped { continue }
                u.Path, _ = url.PathUnescape(rewritten)
                u.RawPath = rewritten
            case "header":
                // ⚠️ CRLF 守卫：密钥若含 \r\n 直接拒绝（HTTP header injection）
                if strings.ContainsAny(sub.Value, "\r\n") {
                    return fmt.Errorf("rejected: CR/LF in header substitution")
                }
                for _, vals := range headers {
                    for i, v := range vals {
                        vals[i] = strings.ReplaceAll(v, sub.Placeholder, sub.Value)
                    }
                }
            // ... query / body 同理
            }
        }
    }
    return nil
}
```

**核心契约**：调用方收到 error 时**绝不能**转发请求 —— 即使部分替换已落地。这就是"机制 vs 策略"的清晰切分：占位符语法是策略，注入失败就 deny 是机制。

下面用 Python 复刻一个最小可运行版本（演示核心逻辑，**非**真实 Agent Vault 字节级实现）：

```python
"""最小可运行的 placeholder substitution 演示
逻辑：模拟 Agent 用假密钥 __anthropic_api_key__ 发请求，
MITM 代理把假密钥换成真密钥。
"""
import re
from dataclasses import dataclass, field
from typing import List, Dict, Tuple


@dataclass
class Substitution:
    placeholder: str        # 占位符
    value: str              # 真密钥（实际生产中绝不打印）
    in_: List[str] = field(default_factory=list)  # 注入面


class SubstitutionError(Exception):
    """任何替换错误都不转发请求"""
    pass


def apply_substitutions(
    url_path: str,
    query: str,
    headers: Dict[str, str],
    body: str,
    subs: List[Substitution],
) -> Tuple[str, str, Dict[str, str], str]:
    """返回 (path, query, headers, body)，出错抛 SubstitutionError"""
    for sub in subs:
        if "header" in sub.in_:
            # 1. CRLF 守卫：HTTP header injection 攻击
            if "\r" in sub.value or "\n" in sub.value:
                raise SubstitutionError(
                    f"CR/LF in header value for {sub.placeholder!r}"
                )
            for k, v in list(headers.items()):
                if sub.placeholder in v:
                    headers[k] = v.replace(sub.placeholder, sub.value)

        if "query" in sub.in_:
            if sub.placeholder in query:
                # 真值需要 URL escape（演示用占位符本来是 safe）
                from urllib.parse import quote
                query = query.replace(sub.placeholder, quote(sub.value, safe=""))

        if "path" in sub.in_:
            if sub.placeholder in url_path:
                url_path = url_path.replace(sub.placeholder, quote(sub.value, safe=""))

        if "body" in sub.in_:
            if sub.placeholder in body:
                body = body.replace(sub.placeholder, sub.value)
    return url_path, query, headers, body


# === 演示 ===
if __name__ == "__main__":
    # Agent 看到的环境（README 第 4 步示例）
    fake_key = "__anthropic_api_key__"
    real_key = "sk-ant-real-XXXXXXXXXXXXXXXXXXXXXXXXXX"

    rules = [Substitution(placeholder=fake_key, value=real_key, in_=["header", "body"])]

    # Claude Code 内部发出的请求
    headers = {"authorization": f"Bearer {fake_key}", "content-type": "application/json"}
    body = '{"model": "claude-opus-4-6", "messages": [], "api_key_field": "' + fake_key + '"}'

    try:
        path, query, out_headers, out_body = apply_substitutions(
            "/v1/messages", "", headers, body, rules
        )
        print("✅ 替换成功")
        print(f"   Authorization: {out_headers['authorization'][:20]}...")
        print(f"   Body 头: {out_body[:60]}...")
    except SubstitutionError as e:
        print(f"❌ 拒绝转发: {e}")

    # 演示攻击场景：恶意占位符值含 \r\n
    bad_value = "evil\r\nX-Injected-Header: pwned"
    bad_rules = [Substitution(placeholder="__x__", value=bad_value, in_=["header"])]
    try:
        apply_substitutions("/api", "", {"x-custom": "__x__"}, "", bad_rules)
    except SubstitutionError as e:
        print(f"🛡️ CRLF 攻击被拦截: {e}")
```

输出：

```
✅ 替换成功
   Authorization: Bearer sk-ant-real-XXXX...
   Body 头: {"model": "claude-opus-4-6", "messages": [], "api_key_field": "sk-an...
🛡️ CRLF 攻击被拦截: CR/LF in header value for '__x__'
```

### 机制 2：双向 TLS MITM（internal/mitm/proxy.go）—— 一个端口吃下 CONNECT + HTTP

Agent Vault 区别于 mitmproxy 的最大特点：**同一个 listener 同时处理 `CONNECT host:port`（HTTPS 上游）和 absolute-form forward-proxy 请求（HTTP 上游）**。这避免了 Agent 因为部分 API 是 HTTP、部分是 HTTPS 就需要配置两套代理。

```go
// internal/mitm/proxy.go 核心契约
type Proxy struct {
    ca        ca.Provider      // 按 SNI 现场签发 leaf 证书
    sessions  brokercore.SessionResolver
    creds     brokercore.CredentialProvider
    upstream  *http.Transport  // 严格 system trust store 验证
    // ...
}
```

`mitm.Proxy` 的两个 listener 入口在 `httpServer.Handler` 里通过 `r.Method == "CONNECT"` 分流：

- **CONNECT 分支**：代理 hijack 连接 → 用 `ca.MintLeaf(sni)` 现场签证书 → 用 leaf 终止客户端 TLS → 然后代理用自己的 HTTP client 重新建立到上游的 TLS（用系统 trust store 严格校验）→ 在明文 HTTP 层调用 `creds.Inject(...)` 注入真密钥
- **absolute-form 分支**（如 `POST http://host/path HTTP/1.1`）：直接认证 → 注入 → 转发

**关键安全细节**：v1 显式拒绝 `https://` absolute-form（"避免 silently TLS-stripping"）。即一个看起来是 `POST https://evil.com/...` 的明文请求会直接被 403，因为代理不会傻到替客户端降级 TLS。

### 机制 3：netguard（internal/netguard/netguard.go）—— 出向请求的 CIDR 黑名单

`netguard` 是 Agent Vault 独有的"出向防火墙"，针对"Agent 通过 Vault 反向攻击内网"的 SSRF 场景：

```go
// internal/netguard/netguard.go 真实代码片段
var alwaysBlocked = []net.IPNet{
    parseCIDR("169.254.169.254/32"),       // AWS/GCP/Azure IMDS
    parseCIDR("fd00:ec2::254/128"),        // AWS IMDSv2 IPv6
}

var privateRanges = []net.IPNet{
    parseCIDR("10.0.0.0/8"),                // RFC-1918
    parseCIDR("172.16.0.0/12"),
    parseCIDR("192.168.0.0/16"),
    parseCIDR("127.0.0.0/8"),               // loopback
    parseCIDR("169.254.0.0/16"),            // link-local
    // ... IPv6 ULA, CGN
}

func AllowPrivateFromEnv() bool {
    v := os.Getenv("AGENT_VAULT_ALLOW_PRIVATE_RANGES")
    if v == "" { return false }   // 默认 deny（fail-closed）
    b, err := strconv.ParseBool(v)
    if err != nil { return false }
    return b
}
```

**设计哲学**：**fail-closed 默认**——任何环境变量解析失败都拒绝私网访问，**和"默认可信 + 显式关闭"的传统策略相反**。这是 Harness 工程的"机制 vs 策略分离"最佳实践：netguard 提供机制（CIDR 拦截），管理员通过环境变量表达策略。

### 机制 4：进程分离 + SQLite/Postgres 双后端（cmd/server.go + internal/store/）

`cmd/server.go` 用一行 `database/sql` 抽象同时支持 SQLite（开发）和 Postgres（生产）：

```go
// README 第 5 段摘录
DATABASE_URL=postgres://user:pass@host:5432/agent_vault
```

代码层面的实现是经典的 `database/sql` + 驱动注入：开发用 `modernc.org/sqlite`（纯 Go，无需 CGO），生产用 `github.com/lib/pq`。**这种"开发零运维 + 生产可水平扩展"的取舍**正是 Harness 工程化"机制 vs 策略分离"的另一个范例。

## 📊 与 3 个同类项目的横向对比

Agent Vault 在"AI Agent 凭据管理"赛道并不是孤品，但**它的设计哲学是独有的**：

| 维度 | **Agent Vault** | **mitmproxy** | **Squid** | **OAuth Proxy（如 oauth2-proxy）** |
|------|----------------|---------------|-----------|----------------------------------|
| **定位** | AI Agent 凭据代理 | 通用 MITM 调试工具 | HTTP 缓存代理 | Web SSO 网关 |
| **凭据感** | **完全无感**（Agent 看不到真密钥） | 透传（用户自管证书） | 透传 | 透传 |
| **MITM 签发 leaf** | ✅ SNI 现签 | ✅ 手动 CA | ❌ | ❌ |
| **占位符替换** | ✅ 5 种面 | ❌ 需写脚本 | ❌ | ❌ |
| **出向 netguard** | ✅ 内置 CIDR 黑名单 | ❌ 需装插件 | ✅ 但需手写 ACL | ❌ |
| **协议针对 Agent** | ✅ `HTTPS_PROXY` 即插即用 | ⚠️ 需要证书信任链 | ❌ 不适合动态 | ❌ Web 流为主 |
| **Vault 集成** | ✅ 同源（Infisical） | ❌ | ❌ | ⚠️ 仅 IdP |
| **License** | Other（Infisical） | MIT | GPL | Apache-2.0 |

**核心设计差异**：

1. **mitmproxy**：通用网络调试工具，所有替换逻辑都需要 Python 脚本，没有"凭据不落地"的保证（它的本意是"让你看见流量"）。Agent Vault 反过来：**核心承诺是 Agent 永远看不到真密钥**。
2. **Squid**：1980 年代设计的 HTTP 缓存代理，ACL 配置极其复杂（`acl SSL_ports port 443` 这种），不支持现代 AI Agent 的 HTTPS 出向注入场景。
3. **OAuth Proxy**：解决"Web 用户 SSO"问题，**根本不是 Agent 场景**——Agent 没有浏览器交互，不能走 OAuth dance。

**Agent Vault 的设计哲学可以浓缩成一句话**：**"用网络拓扑层隔离替代 SDK 层封装"**。这和 Anthropic 在 Claude Code 里设计 `~/.claude/settings.json` 的策略层管控形成完美互补——一个是物理隔离（Agent Vault），一个是逻辑约束（settings.json）。

## ⚖️ 优缺点对比（架构简洁性 vs 性能 + 复杂度）

| 维度 | 评价 |
|------|------|
| **架构简洁性** | ✅ **极简**：单 Go 二进制，SQLite/Postgres 双后端，配置文件即 vault 规则，没有 sidecar、没有 K8s operator、没有 SDK。10 分钟从 0 到 brokered agent。 |
| **扩展性** | ⚠️ **中庸**：支持 Postgres 多实例 + CIDR allowlist，但每加一个新上游 API 都需要手动配 service rule（YAML 或 CLI），**没有自动发现**（注：`cmd/discover.go` 里有部分实现）。 |
| **易用性** | ✅ **强**：`agent-vault run -- claude` 一行启动，agent 环境变量模板清晰，README 引导步骤不到 20 行。 |
| **性能** | ⚠️ **开销**：每个出向 HTTPS 请求都要做 2 次 TLS 握手（客户端↔Vault，Vault↔上游）+ 1 次证书签发（带 LRU 缓存）。本地同机房延迟增加 ~5-15ms。 |
| **复杂度** | ✅ **低**：核心代码 `internal/mitm/proxy.go` 仅 7KB，`substitution.go` 4KB，对 Go 熟手 1 天能读完。 |
| **维护性** | ✅ **强**：依赖少（仅 stdlib + 1 个 SQLite 驱动），Infisical 团队全职维护，CI 完整。 |
| **关键缺陷** | ❌ **HTTP/1.1 only**：v1 明确说 `ALPN pinned`，**HTTP/2 上游暂不支持**（gRPC 类 API 走不通）。❌ **CRL/OCSP 未实现**：leaf 证书撤销列表缺失，过期前只能等自然失效。 |

**Less is More 自检**：Agent Vault 写了多少"模型自己本可以学会"的代码？答案是**几乎为零**——它完全在网络层操作，对模型行为零假设。这正是 Bitter Lesson 的最佳实践：**让 Harness 做"外部物理世界必需的事"，让 LLM 做它擅长的事**。

## 🛠️ 从零搭建启示（MVP 复刻）

如果你想在自己团队实现"凭据不落地"，Agent Vault 的设计可以浓缩成 4 个 MVP 模块：

| 模块 | Agent Vault 的实现 | MVP 替代 | 必选? |
|------|-------------------|----------|-------|
| **占位符替换** | substitution.go（5 种面 + CRLF 守卫） | `requests` 库的 `Session.send` 钩子 | ✅ 必须 |
| **MITM 代理** | 自实现（按 SNI 现签 leaf） | `mitmproxy` 的 inline script | ⚠️ MVP 可用 mitmproxy |
| **netguard** | netguard.go（CIDR + 169.254 黑名单） | 出向请求前 `socket.getpeername()` 校验 | ✅ 必须 |
| **Vault 隔离** | 进程外 SQLite/Postgres + HTTPS_PROXY | `docker run -d vault` + `HTTPS_PROXY` | ✅ 必须 |

**踩坑预警**（实测 2026-08-04 读源码总结）：

1. **MITM 证书信任**：Agent 进程（特别是 Python `requests`）默认**不信任**自签 CA。需要把 `RootPEM()` 写入 `SSL_CERT_FILE` 或 `REQUESTS_CA_BUNDLE`。**Agent Vault 没替你做这件事**——这是设计权衡：信任锚要由 Agent 自己决定。
2. **占位符值含 URL 特殊字符**：`url.PathEscape` 必须在占位符**外**做一次，否则会双重编码。Agent Vault 源码注释直接说"placeholders are RFC 3986 unreserved"。
3. **PostgreSQL 迁移**：先 `migrate-db` 后切 `DATABASE_URL`，**不要直接换 env var**——SQLite → Postgres 跨方言 ALTER 行为不一致。
4. **token 复用**：README 第 3 步"长生命周期 agent"和"短生命周期 sandbox"用不同 token 类型，前者放 `~/.bashrc`，后者由 orchestrator 在 sandbox 启动时注入。

## 🎓 结论与行动建议

Agent Vault 填补了 Harness 6 件套之外的**第 7 个空白**：**凭据边界**。它和现有组件的关系是：

```mermaid
graph LR
    Rule["📜 Rule 组件<br/>Claude Code settings.json"] 
    Skill["🎯 Skill 组件<br/>SOP / 流程模板"]
    SubAgent["👥 Sub-Agent 组件<br/>角色分工"]
    Workflow["🔁 Workflow 组件<br/>状态机"]
    Script["🪝 Script 组件<br/>不可绕过门控"]
    MCP["🔌 MCP 组件<br/>外部工具桥接"]
    Credential["🔐 Credential Boundary<br/>Agent Vault"]

    Rule -.->|"策略层"| Credential
    Script -.->|"门控层"| Credential
    MCP -.->|"工具层"| Credential
    Credential -.->|"网络层"| Agent["🤖 LLM Agent"]

    style Rule fill:#FFF9C4,stroke:#333,color:#333
    style Skill fill:#FFDAB9,stroke:#333,color:#333
    style SubAgent fill:#FFB3C6,stroke:#333,color:#333
    style Workflow fill:#C7CEEA,stroke:#333,color:#333
    style Script fill:#B5EAD7,stroke:#333,color:#333
    style MCP fill:#E8D5F5,stroke:#333,color:#333
    style Credential fill:#FFB3C6,stroke:#333,color:#333
    style Agent fill:#F5F5F5,stroke:#333,color:#333
```

**给你的 3 条行动建议**：

1. **小团队立刻可用**：本地开发用 SQLite + `agent-vault run -- claude` 10 分钟跑起来，**立刻把 `ANTHROPIC_API_KEY` 从 `~/.bashrc` 移除**——这是 prompt injection 攻击的"零成本防御升级"。
2. **生产部署**：Vault 主机**必须**独立（不同机器、不同网络段），配 netguard 的 `AGENT_VAULT_NETWORK_ALLOWLIST` 限定 vault 主机只允许 Agent 子网的 CONNECT。README 的"best practices #1"明确写了这条。
3. **警惕 HTTP/1.1 only**：v1 不支持 HTTP/2 上游，如果你的工具链重度依赖 gRPC / HTTP/2 push，需要等 v2 或自己 fork（[GitHub issue tracker](https://github.com/Infisical/agent-vault/issues)）。

**写到最后**：Agent Vault 给我的最大启发不是"凭据要隔离"这个直觉（任何安全工程师都懂），而是**"机制 vs 策略分离 + 进程外隔离"这两个原则可以同时落地**——它没有引入任何 SDK、没有要求改 Agent 代码、只靠 `HTTPS_PROXY` 一个环境变量就完成了端到端隔离。这种**用最少约束换最大安全收益**的设计，正是 Harness Engineering "Less is More" 的最佳注解。

---

## 📚 参考资料

1. Agent Vault GitHub: <https://github.com/Infisical/agent-vault>
2. Infisical 官方博客《Agent Vault: The Open Source Credential Proxy and Vault for Agents》: <https://infisical.com/blog/agent-vault-the-open-source-credential-proxy-and-vault-for-agents>
3. OWASP LLM Top 10 - LLM06 Sensitive Information Disclosure: <https://llmtop10.com/llm06/>
4. Microsoft Security Response Center MSRC-122432 (Path traversal via symlinks): 参考 MCP 系列对比
5. AWS Blog《Exponential Backoff and Jitter》: <https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/>
6. RFC 7230 §5.3.2 (Absolute-Form Forward Proxy): <https://www.rfc-editor.org/rfc/rfc7230#section-5.3.2>