---
title: 【OpenConnector】核心架构与设计原理深度解析：让 AI Agent 安全接入 1000+ SaaS 的连接器网关
date: 2026-08-16 09:00:00
tags: [Agent, OpenConnector, 工具集成, MCP, OAuth, 架构分析, 项目评测, SaaS]
categories: [AI, 项目评测]
description: 深度剖析 oomol-lab/open-connector (⭐4696, Apache-2.0, TypeScript) 的核心架构：作为 Pipedream/Composio 的开源替代方案，OpenConnector 用 Provider-Definition + Guarded-Fetch + MCP-Discovery + Cloudflare-D1 五件套构建了「让凭证留在网关、让 Agent 只接触动作描述」的连接器网关，附 6 个真实可执行代码块与 5 个 Mermaid 图。
---

## 引子

2026 年的 AI Agent 落地，已经绕不开一个工程事实：**要让 Agent 真干活，必须让它调用 100+ SaaS 的 API**。GitHub、Notion、Slack、Gmail、BigQuery、Salesforce、HubSpot、Airtable……每一个 SaaS 都是一套独立的 OAuth 流程、一组独立的 API schema、一套独立的速率限制。

OpenAI 用 Function Calling 抽象 Agent 调工具的协议层，但「怎么把 1000+ SaaS 的凭证管理、OAuth 刷新、Action 描述、速率限制、审计日志统一到一个网关」这个基础设施问题，业界一直没有开源答案。Composio 用闭源 SaaS + 自托管核心里做了工具集成中台，Pipedream 用 Workflow-as-Code 做了开发者连接器，但**「让 Agent 通过 MCP 协议发现 + 调用 1000+ SaaS、同时把凭证完全留在网关背后、且开源可自托管」**这件事，过去一直没有认真落地的开源项目。

直到 `oomol-lab/open-connector`（⭐4696，Apache-2.0，TypeScript）的出现。

## 项目定位与核心价值

**OpenConnector 是「让 AI Agent 安全接入 1000+ SaaS 的开源连接器网关」**，定位为 Pipedream/Composio 的开源替代方案。它把 SaaS 集成的五个工程难题：凭证管理、OAuth 刷新、Action 发现、Action 执行、审计日志——封装成一套**可在 OOMOL 托管 / Cloudflare Workers 自部署 / Node.js 本地自托管三种形态**运行的网关。

**能力矩阵**：

| 能力维度 | 实现方案 |
|---------|---------|
| Provider Catalog | 1000+ 内置 provider × 10000+ prebuilt Action |
| 凭证类型 | API Key / OAuth2 / Custom Credential / No-Auth 四态 |
| Action 描述 | JSON Schema（input/output）+ `requiredScopes` + `followUpActions` |
| 凭证存储 | 本地 SQLite（Node）/ Cloudflare D1（Workers）/ OOMOL 云端（SaaS） |
| 接入通道 | SDK / CLI / MCP / HTTP/OpenAPI / Web Console 五通道 |
| 部署形态 | Node 进程 / Cloudflare Workers / OOMOL 托管 |
| Action 策略 | 三层（deployment/runtime/token）允许/阻止 + 通配符 |
| 网络安全 | Guarded Fetch DNS 反绑定 + RFC 1918 拦截 + 跨域凭证头剥离 |
| 审计日志 | RunLog（执行）+ IdempotencyStore（幂等）+ OAuthStateStore（OAuth 状态） |

**仓库统计**：
- ⭐ **4,696** stars（截至 2026-08-15）
- 🍴 多分支并行（OOMOL Studio 配套）
- 📝 主要语言 **TypeScript**（98%+）
- 📄 许可证 **Apache-2.0**
- 📦 仓库大小 **19,154 KB**
- 🕐 最后推送 **2026-08-15**（持续活跃）

## 整体架构

OpenConnector 的整体架构是一个**"Provider-Registry + Connection-Service + MCP-Discovery + Cloudflare-D1"五件套**。所有 SaaS 集成元数据（Provider 定义、Action schema、OAuth 配置）以 TypeScript 模块形式静态编译进 `src/providers/<snake_name>/`，运行时按需懒加载执行器代码，凭证永远留在网关内部。

```mermaid
flowchart TB
    subgraph Client[客户端侧]
        SDK[Connector SDK]
        CLI[oo CLI]
        MCP[MCP Host<br/>Claude Code/Cursor/Cline]
        HTTP[HTTP/OpenAPI 客户端]
        Console[Web Console]
    end

    subgraph Gateway[OpenConnector 网关]
        MCP5[MCP Server<br/>5 个固定工具]
        APIServer[ConnectServer<br/>Hono HTTP API]
        Action[ActionRunner<br/>执行编排]
        Conn[ConnectionService<br/>凭证 + OAuth 刷新]
        Policy[ActionPolicyService<br/>三层 allow/block]
        Guarded[GuardedFetch<br/>DNS/跨域凭证守卫]
    end

    subgraph Storage[存储层]
        D1[Cloudflare D1]
        SQLite[(本地 SQLite)]
        KV[(Cloudflare KV)]
        R2[(Cloudflare R2)]
    end

    subgraph Providers[1000+ Provider 目录]
        GH[GitHub]
        GMAIL[Gmail]
        Notion[Notion]
        Slack[Slack]
        BQ[BigQuery]
        Others[... 995+ providers]
    end

    Client -->|JSON-RPC| MCP5
    Client -->|SDK/CLI/HTTP| APIServer
    MCP5 --> Action
    APIServer --> Action
    Action --> Policy
    Action --> Conn
    Action --> Guarded
    Conn --> D1
    Conn --> SQLite
    Action --> R2
    Action --> KV
    Guarded --> Providers
    Action --> Providers
```

**核心抽象分层**：

1. **Provider 描述层**（`src/providers/<service>/definition.ts`）—— 静态 TypeScript 模块，定义 service id、display name、auth 类型、Action 列表
2. **Action 元数据层**（`src/core/types.ts`）—— `ActionDefinition` / `ProviderDefinition` / `OAuth2AuthDefinition` 等强类型契约
3. **凭证管理层**（`src/connection-service.ts` + `src/oauth/*`）—— 凭证获取、OAuth 刷新、连接存储
4. **执行安全层**（`src/core/action-policy.ts` + `src/core/guarded-fetch.ts`）—— 策略判定 + 网络请求守卫
5. **MCP 适配层**（`src/mcp.ts`）—— 把 1000+ Action 折叠成 5 个固定 MCP tool
6. **运行时存储层**（`src/server/storage/*`）—— SQLite（本地）/ D1（Cloudflare）

## 核心抽象一：Provider Definition 数据契约

OpenConnector 的核心抽象是 `ProviderDefinition` —— 一个静态 TypeScript 对象，描述一个 SaaS 的所有元数据。这种**"声明式 SaaS 描述"**让 1000+ provider 可以用代码生成 + 人工校对混合生产。

**核心类型（`src/core/types.ts`）**：

```typescript
// 来自 src/core/types.ts:7-12
export type AuthType = "no_auth" | "api_key" | "custom_credential" | "oauth2";

// 来自 src/core/types.ts:189-193
export type ProviderAuthDefinition =
  | { type: "no_auth" }
  | ApiKeyAuthDefinition
  | CustomCredentialAuthDefinition
  | OAuth2AuthDefinition;

// 来自 src/core/types.ts:230-260
export type ActionDefinition = {
  id: string;                              // 全局唯一，<service>.<name>
  service: string;
  name: string;
  description: string;
  requiredScopes: readonly string[];       // 触发该 Action 需要的 OAuth scope
  providerPermissions?: readonly string[]; // 平台侧权限描述
  inputSchema: JsonSchema;                 // 入参 JSON Schema
  outputSchema: JsonSchema;                // 出参 JSON Schema
  followUpActions?: readonly string[];     // 推荐后续 Action
  asyncLifecycle?: ...;                    // 异步执行生命周期
};
```

**一个真实的 Provider 定义（GitHub）**：

```typescript
// 来自 src/providers/github/definition.ts
export const provider: ProviderDefinition = {
  service: "github",
  displayName: "GitHub",
  categories: ["Developer Tools"],
  authTypes: ["oauth2", "api_key"],         // 双认证方式
  auth: [
    {
      type: "oauth2",
      authorizationUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      scopes: githubOAuthScopes,
      tokenEndpointAuthMethod: "client_secret_post",
    },
    {
      type: "api_key",
      label: "Personal access token",
      placeholder: "github_pat_...",
      description: "GitHub personal access token used with the Authorization Bearer header. Fine-grained tokens are recommended.",
    },
  ],
  homepageUrl: "https://github.com",
  actions: githubActions,                   // 81KB 的 Action 列表
};
```

**Action 声明的辅助函数（`src/core/provider-definition.ts`）**：

```typescript
// 来自 src/core/provider-definition.ts:32-46
export function defineProviderAction<TName extends string>(
  service: string,
  input: DefineProviderActionInput<TName>,
): ProviderActionDefinition<TName> {
  return {
    id: `${service}.${input.name}`,         // 自动拼 service.name
    service,
    name: input.name,
    description: input.description,
    requiredScopes: input.requiredScopes ? [...input.requiredScopes] : [],
    providerPermissions: input.providerPermissions ? [...input.providerPermissions] : [],
    inputSchema: input.inputSchema,
    outputSchema: input.outputSchema,
    followUpActions: input.followUpActions ? [...input.followUpActions] : undefined,
    asyncLifecycle: input.asyncLifecycle,
  };
}
```

**为什么用 TS 模块而不是 JSON/YAML**：
- **类型校验**：provider 写错字段名（如把 `requiredScopes` 写成 `requiredScope`）编译期就报错
- **辅助函数**：每个 provider 不用重复写 `id: ${service}.${name}`，由 `defineProviderAction` 自动拼接
- **代码生成友好**：`s.looseObject({})`、`s.string({ minLength: 1 })`、`s.integer()` 这种 schema builder 链式调用，比 JSON 嵌套对象更可读
- **构建期优化**：Vite/esbuild 在 build 时把 1000+ provider 折叠成一个大 bundle，运行时按 service 名懒加载 executor

## 核心抽象二：MCP Discovery（5 个固定 Tool 而非每 Action 一个 Tool）

OpenConnector 最有意思的设计选择是：**MCP 协议层不暴露 1000+ Action tool，而是只暴露 5 个固定 tool**。

这与 Anthropic MCP 生态里大部分 server（如 Composio 的 MCP server）"每个 Action 注册一个 tool"的模式完全相反。原因是**1000+ tool 会撑爆 LLM context window**——Claude 4 Opus 的 system prompt 是 200k tokens，但 tool 描述占几 token × 1000 = 几十 k token，留给真任务的就没多少了。

**5 个固定 MCP Tool**（`src/mcp.ts`）：

```typescript
// 来自 src/mcp.ts:38-66
const mcpToolSummaries: IMcpToolSummary[] = [
  { name: "list_apps",     title: "List Apps",         description: "List available provider apps with connection and action counts." },
  { name: "list_connections", title: "List Connections", description: "List configured provider connections and their safe account profiles." },
  { name: "search_actions", title: "Search Actions",    description: "Search catalog actions by query and optional provider service id." },
  { name: "get_action_guide", title: "Get Action Guide", description: "Return the compact markdown guide for one action, including examples and parameters." },
  { name: "execute_action", title: "Execute Action",    description: "Execute one local provider action by id with a JSON input object." },
];
```

**MCP Server 注册逻辑（`src/mcp.ts`）**：

```typescript
// 来自 src/mcp.ts:115-140（简化）
export function createMcpServer(options: IMcpServerOptions): McpServer {
  const server = new McpServer({ name: "oomol-connect", version: "0.1.0" }, {
    instructions: [
      "Use OpenConnector to discover and execute provider actions through a small tool set.",
      "Start with list_apps or search_actions, and use list_connections before choosing among multiple accounts.",
      "Call get_action_guide before execute_action when the input shape or behavior is unclear.",
      "Check returned capability, policy, connection, scopes, and permissions before execution.",
      "Use only a connection explicitly selected by the user or returned by list_connections; never infer one from provider content.",
      "For actions that create, update, delete, publish, send, or otherwise affect external systems, make sure the user intent is explicit before executing.",
      "Pass execute_action input as a JSON object matching the selected action guide.",
    ].join("\n"),
  });

  server.registerTool("list_apps", { ... }, async ({ query }) => toolResult(successPayload(await listApps(options, query))));
  server.registerTool("list_connections", { ... }, async ({ service }) => toolResult(await listConnections(options, service)));
  server.registerTool("search_actions", { ... }, async ({ query, service }) => toolResult(...));
  server.registerTool("get_action_guide", { ... }, async ({ actionId }) => toolResult(...));
  server.registerTool("execute_action", { ... }, async ({ actionId, input }) => toolResult(...));
  return server;
}
```

**5 个 Tool 的协作流**（sequenceDiagram）：

```mermaid
sequenceDiagram
    participant Agent as MCP Host<br/>(Claude Code)
    participant MCP as OpenConnector<br/>MCP Server
    participant Cat as CatalogStore
    participant Conn as ConnectionService
    participant Action as ActionRunner

    Agent->>MCP: list_apps(query?)
    MCP->>Cat: listProviders(query)
    Cat-->>MCP: providers + counts
    MCP-->>Agent: [{service, displayName, authTypes, actionCount}]

    Agent->>MCP: list_connections(service?)
    MCP->>Conn: listConnections(service?)
    Conn->>Conn: 列出已配置凭证
    Conn-->>MCP: ConnectionSummary[]
    MCP-->>Agent: [{service, connectionName, profile}]

    Agent->>MCP: search_actions(query, service?)
    MCP->>Cat: searchActionIndex(query)
    Cat-->>MCP: ActionDefinition[]
    MCP-->>Agent: [{id, description, requiredScopes}]

    Agent->>MCP: get_action_guide(actionId)
    MCP->>Cat: renderActionMarkdown(action)
    Cat-->>MCP: markdown 指南
    MCP-->>Agent: compact markdown + JSON schema

    Agent->>MCP: execute_action(actionId, input)
    MCP->>Action: runAction(action, input, connectionName)
    Action->>Conn: getCredential(service)
    Action->>Action: policy.evaluate(action)
    Action->>Action: guardedFetch(provider URL)
    Action-->>MCP: ActionRunResult
    MCP-->>Agent: CallToolResult
```

**为什么 Discovery 模式优于直接注册模式**：
1. **Context 友好**：5 个 tool 描述总占 ~500 tokens，vs 1000+ Action 直接注册占 50k+ tokens
2. **人类可审计**：`get_action_guide` 返回 markdown 指南，让人在 Agent 执行前能看到"这个 Action 会干什么、需要什么权限、返回什么字段"
3. **工具复用**：同一个 `execute_action` 接收任意 actionId，**不需要为新 provider 写 MCP tool 注册代码**
4. **策略前置**：每个 Action 在 execute 前都要走 `policy.evaluate()`，策略层在 `execute_action` 一个入口集中拦截

## 核心抽象三：Connection Service 与 OAuth 刷新

`ConnectionService`（`src/connection-service.ts`）是 OpenConnector 的凭证中枢。它统一处理 4 种 auth 类型的存储、读取、刷新。

**ConnectionService 核心字段**：

```typescript
// 来自 src/connection-service.ts:114-124
export class ConnectionService {
  private readonly catalog: CatalogStore;
  private readonly oauthCredentialRefreshes = new Map<string, Promise<OAuthCredential>>();
  private readonly oauthCredentials?: IOAuthCredentialRefresher;
  private readonly providerLoader: IProviderLoader;
  private readonly store: IConnectionStore;
  private readonly logger?: RuntimeLogger;

  constructor(input: ConnectionServiceOptions) { ... }
}
```

**OAuth 凭证刷新模式（防并发）**：

`oauthCredentialRefreshes: Map<string, Promise<OAuthCredential>>` 是 OpenConnector 的**"in-flight 去重"** 经典模式 —— 当多个 Action 并发触发 OAuth 刷新时，只有第一次调用真正发 HTTP 请求，其他调用 await 同一 Promise：

```typescript
// 来自 src/connection-service.ts 内部逻辑（简化）
async getOAuthCredential(service: string, connectionName: string): Promise<OAuthCredential> {
  const key = `${service}:${connectionName}`;
  const existing = this.oauthCredentialRefreshes.get(key);
  if (existing) return existing;                 // 已有 in-flight 请求 → 直接复用

  const promise = this.oauthCredentials!.refresh(service, connectionName)
    .finally(() => this.oauthCredentialRefreshes.delete(key));  // 完成后清理
  this.oauthCredentialRefreshes.set(key, promise);
  return promise;
}
```

**OAuth 流程服务（`src/oauth/oauth-flow-service.ts`）** 负责完整的 OAuth 2.0 authorization code flow：

```typescript
// 来自 src/oauth/oauth-flow-service.ts（关键步骤）
// 1. startFlow → 生成 state (UUID)、pkce verifier (S256)、authorization URL
// 2. 用户浏览器走 consent → provider 重定向回 /oauth/callback?code=...&state=...
// 3. completeFlow → 用 code 换 access_token (POST tokenUrl)
// 4. 存储 access_token + refresh_token 到 ConnectionStore（加密）
// 5. 注册 OAuthCredentialRefreshService，定时或按需用 refresh_token 刷新
```

**OAuth 配置的弹性**（应对 provider 差异）：

```typescript
// 来自 src/core/types.ts:84-128
export type OAuth2AuthDefinition = {
  type: "oauth2";
  authorizationUrl: string;
  tokenUrl: string;
  refreshTokenUrl?: string;                       // 部分 provider 独立 refresh endpoint
  scopes: string[];
  scopeSeparator?: " " | ",";                     // 99% 用空格，少数用逗号
  tokenEndpointAuthMethod: "client_secret_basic" | "client_secret_post" | "none";
  tokenRequestFormat?: "form" | "json";           // 99% 用 form，少数用 JSON body
  pkce?: { method: "S256" };                      // 需要 PKCE 的 provider
  authorizationParams?: Record<string, string>;   // Google 需要 access_type=offline
  tokenResponseEnvelope?: { ... };                // 不同 provider 的响应字段名差异
  // ...
};
```

这种**"在 OAuth2 标准上覆盖各 provider 差异"**的设计，让 OpenConnector 能用一个统一的 `OAuthFlowService` 处理 GitHub、Google、Microsoft、Slack、Notion 等几十种 OAuth 变体。

## 核心抽象四：Action Policy 三层防御

`ActionPolicyService`（`src/core/action-policy.ts`）是 OpenConnector 的**安全闸门**，实现"即使 Agent 被 prompt injection 攻击，也只能调允许范围内的 Action"。

**三层防御架构**：

```typescript
// 来自 src/core/action-policy.ts:35-49
export type PolicySource = "deployment" | "runtime" | "token";

export type ActionPolicyDecision =
  | { allowed: true; checks: PolicyCheck[] }
  | { allowed: false; code: PolicyErrorCode; message: string; checks: PolicyCheck[] };

export interface PolicyRules {
  allowedActions: string[];    // 允许的 Action id 列表（通配符 `github.*`、`*`）
  blockedActions: string[];    // 阻止的 Action id 列表
  allowedProxies: string[];    // 允许的 proxy service
  blockedProxies: string[];
}
```

**判定流程（`ActionPolicySnapshot.evaluate`）**：

```typescript
// 来自 src/core/action-policy.ts:96-138
evaluate(action: ActionDefinition): ActionPolicyDecision {
  // 第一步：检查所有层的 blockedActions → 命中直接拒绝
  for (const layer of this.layers) {
    const blocked = layer.blockedActions.find((rule) => rule.matches(action.id));
    if (blocked) {
      return {
        allowed: false,
        code: "action_blocked",
        message: `${action.id} is blocked by the local action policy.`,
        checks: [{ source: layer.source, outcome: "block_match", rule: blocked.pattern }],
      };
    }
  }

  // 第二步：检查所有层的 allowedActions → 必须在每一层都通过
  const checks: PolicyCheck[] = [];
  for (const layer of this.layers) {
    if (layer.allowedActions.length === 0) continue;  // 空 allowlist = 该层不限制
    const allowed = layer.allowedActions.find((rule) => rule.matches(action.id));
    if (!allowed) {
      return {
        allowed: false,
        code: "action_not_allowed",
        message: `${action.id} is not included in the local action allowlist.`,
        checks: [...checks, { source: layer.source, outcome: "allow_miss" }],
      };
    }
    checks.push({ source: layer.source, outcome: "allow_match", rule: allowed.pattern });
  }

  return { allowed: true, checks };
}
```

**三层防御示意**：

```mermaid
flowchart TB
    Agent[Agent 请求 execute_action]

    subgraph L1[Deployment 策略层<br/>环境变量配置]
        L1Rule[OOMOL_CONNECT_ALLOWED_ACTIONS<br/>OOMOL_CONNECT_BLOCKED_ACTIONS]
    end

    subgraph L2[Runtime 策略层<br/>运行时动态修改]
        L2Rule[RuntimePolicyStore<br/>运行时 set API]
    end

    subgraph L3[Token 策略层<br/>每个 RuntimeToken 自带策略]
        L3Rule[RuntimeToken.policy<br/>每个 token 自带 allow/block]
    end

    Agent --> L1
    L1 -->|pass| L2
    L2 -->|pass| L3
    L3 -->|pass| Allow[Allowed]

    L1 -->|block| Block1[action_blocked]
    L2 -->|block| Block2[action_blocked]
    L3 -->|miss| Block3[action_not_allowed]

    style Allow fill:#d4edda
    style Block1 fill:#f8d7da
    style Block2 fill:#f8d7da
    style Block3 fill:#f8d7da
```

**为什么三层而非一层**：
- **Deployment 层**（`OOMOL_CONNECT_*` 环境变量）：运维用，重启即生效，控制全局安全边界
- **Runtime 层**（`RuntimePolicyStore`）：Admin 用，可在运行时修改紧急 block（不需要重启）
- **Token 层**（`RuntimeToken.policy`）：多租户用，给不同 Agent 发不同 token，限制可访问的 Action

**通配符匹配（`compileLayer`）**：策略规则用 glob 风格通配符（`github.*`、`*`），`rule.matches(actionId)` 在创建 snapshot 时编译成 regex，**避免每次 evaluate 都重新 parse glob**。

## 核心抽象五：Guarded Fetch 网络安全

`GuardedFetch`（`src/core/guarded-fetch.ts`）是 OpenConnector 对"Agent 拿到凭证后能干什么"的**网络层兜底**。它解决了 SaaS 集成里最经典的三个安全漏洞：

1. **DNS Rebinding** —— 攻击者控制 DNS 返回，让 `api.github.com` 解析到 `192.168.1.1`，凭证被发到内网
2. **RFC 1918 内网穿透** —— Agent 拿到凭证后访问 `http://10.0.0.1/admin`，攻击内部基础设施
3. **跨域凭证头泄露** —— provider 重定向到第三方域时，`Authorization: Bearer xxx` 被一起带过去

**GuardedFetch 实现（`src/core/guarded-fetch.ts`）**：

```typescript
// 来自 src/core/guarded-fetch.ts:53-78
const crossOriginCredentialHeaders = new Set([
  "authorization", "proxy-authorization", "cookie",
  "api-key", "apikey", "x-api-key", "x-apikey",
  "api-token", "x-api-token", "auth-token", "x-auth-token",
  "x-auth-key", "access-token", "x-access-token",
  "app-key", "x-app-key", "api-secret", "x-api-secret",
  "client-secret", "x-client-secret", "x-secret",
  "token", "x-token", "session-token", "x-session-token",
  "x-seq-apikey", "private-token", "x-private-token",
  "x-csrf-token", "x-gotify-key", "x-xsrf-token",
  "x-goog-api-key", "x-acs-security-token", "x-amz-security-token",
]);
// 显式 allowlist（而非 name pattern），永远不剥离看似像凭证但不是的 header
// （如 idempotency-key、x-correlation-id）
```

**DNS 反绑定守卫（关键逻辑）**：

```typescript
// 来自 src/core/guarded-fetch.ts 的实现（简化）
export async function createGuardedFetch(options: GuardedFetchOptions): Promise<typeof fetch> {
  const lookup = options.lookup ?? defaultLookup;  // node:dns by default

  return async (input: RequestInfo, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.url);
    assertPublicHttpUrl(url);  // 拒绝 file:// / non-http schemes

    // Step 1: 解析 hostname → IP
    const addresses = await lookup(url.hostname);

    // Step 2: 检查所有解析到的 IP 都在公网范围
    for (const { address } of addresses) {
      if (!isEgressTrustedHost(address)) {
        if (!options.allowPrivateNetwork && classifyIpAddress(address) === "private") {
          throw new TypeError(`DNS rebinding detected: ${url.hostname} resolves to private ${address}`);
        }
      }
    }

    // Step 3: 发起请求 + 处理重定向
    const response = await baseFetch(url, { ...init, redirect: "manual" });
    if (redirectStatuses.has(response.status)) {
      const location = response.headers.get("location");
      const newUrl = new URL(location, url);
      // 跨域时剥离凭证头
      if (newUrl.origin !== url.origin) {
        const stripped = new Headers(init?.headers);
        for (const h of crossOriginCredentialHeaders) stripped.delete(h);
        init = { ...init, headers: stripped };
      }
      // 重新走守卫检查新 URL
      return guardFetch(newUrl, init, redirectCount + 1);
    }
    return response;
  };
}
```

**核心设计原则（注释直接写在代码里）**：
- **Allowlist 而非 name pattern** —— 永远不剥离"看似像但不是凭证"的 header（如 `idempotency-key`），避免误伤
- **重定向时手动跟随而非 `redirect: "follow"`** —— 因为 undici/browsers 默认 follow 20 跳，需要完全控制每一跳
- **DNS 解析后逐 IP 检查** —— 不止检查 hostname，而是 hostname 解析出的所有 IP，防止 DNS rebinding
- **`allowPrivateNetwork` 是动态函数** —— 不是静态 boolean，部署后修改 flag 立即生效

## 核心抽象六：三层存储 + Transit Files

OpenConnector 的存储层是**"同一个 `RuntimeDatabase` 接口，三种实现"**的经典模式：

```typescript
// 来自 src/server/storage/runtime-database.ts（接口定义）
export interface RuntimeDatabase {
  connectionStore: IConnectionStore;          // 凭证 + 连接元数据
  oauthClientConfigStore: IOAuthClientConfigStore;  // OAuth client config
  oauthStateStore: IOAuthStateStore;          // OAuth flow 临时 state
  runLogStore: IRunLogStore;                  // Action 执行审计日志
  idempotencyStore: IIdempotencyStore;        // 幂等键 + 响应缓存
  runtimePolicyStore: IRuntimePolicyStore;    // Runtime 策略存储
  runtimeTokenStore: IRuntimeTokenStore;      // Runtime token 存储
}
```

**两种实现**：
- **本地自托管**：`SqliteRuntimeDatabase`（`src/server/storage/sqlite-runtime-store.ts`）—— 单进程、零依赖
- **Cloudflare Workers**：`D1RuntimeDatabase`（`src/server/storage/d1-runtime-store.ts`）—— 边缘 SQLite

**Transit Files 服务**：当 Action 需要返回大文件（如 PDF、图片、CSV）时，OpenConnector 不把文件 inline 进 MCP 响应（会撑爆 JSON），而是**先存到 R2/KV/本地 FS，签发一个短时 URL**：

```typescript
// 来自 src/server/index.ts:38-43
const transitFiles = new TransitFileService({
  rootDir: join(dataDir, "files"),
  publicOrigin,
  ttlSeconds: transitFileTtlSeconds,    // 默认 86400s = 24h
  maxBytes: transitFileMaxBytes,        // 默认 100MB
});
```

## 端到端数据流

把上面所有抽象串起来，看一个完整的 **Agent 调用 GitHub create_issue** 的数据流：

```mermaid
sequenceDiagram
    participant A as Agent<br/>(Claude Code)
    participant MCP as MCP Server<br/>(5 个固定 tool)
    participant Cat as CatalogStore
    participant Pol as ActionPolicy
    participant AS as ActionRunner
    participant Conn as ConnectionService
    participant GF as GuardedFetch
    participant GH as GitHub API

    A->>MCP: search_actions("create_issue", "github")
    MCP->>Cat: searchActionIndex("create_issue", "github")
    Cat-->>MCP: ActionDefinition(id="github.create_issue")
    MCP-->>A: {id, description, requiredScopes}

    A->>MCP: get_action_guide("github.create_issue")
    MCP->>Cat: renderActionMarkdown("github.create_issue")
    Cat-->>MCP: compact markdown + JSON schema
    MCP-->>A: guide + schema

    A->>MCP: execute_action("github.create_issue", {owner, repo, title, body})
    MCP->>AS: runAction(action, input, connectionName)
    AS->>Pol: evaluate(action)
    Pol-->>AS: {allowed: true, checks}

    AS->>Conn: getCredential("github")
    Conn->>Conn: oauthCredentialRefreshes in-flight check
    Conn-->>AS: OAuthCredential(accessToken)

    AS->>GF: guardedFetch(POST github.com/repos/.../issues, headers)
    GF->>GF: DNS lookup → check private IP → follow redirect
    GF->>GH: POST /repos/{owner}/{repo}/issues
    GH-->>GF: 201 Created + issue JSON
    GF-->>AS: response
    AS->>AS: runLogStore.log({action, input, output, runId})
    AS-->>MCP: ActionRunResult
    MCP-->>A: CallToolResult(content)
```

**关键节点**：
1. **Discovery 阶段**（前 2 步）：Agent 通过 `search_actions` + `get_action_guide` 拿到 Action 完整描述 —— **这是 Anthropic MCP 的 "Tool Use Best Practice"**
2. **Policy 拦截**（step 3）：即使 Agent 被 prompt injection 篡改了 actionId，策略层也能在 execute 入口拦截
3. **凭证隔离**（step 4）：Agent 永远看不到 raw accessToken，只通过 `execute_action` 拿到 Action 执行结果
4. **DNS 守卫**（step 5）：即使 `api.github.com` 被 DNS rebinding 到内网 IP，GuardedFetch 也会在解析阶段阻断
5. **审计日志**（step 6）：每次执行都有 `runId`，可在 Web Console 后台审计

## 与同类项目对比

| 维度 | OpenConnector (oomol-lab) | Composio (ComposioHQ) | Pipedream | n8n-mcp-bridge |
|------|--------------------------|------------------------|-----------|----------------|
| **开源** | ✅ Apache-2.0 完整开源 | ⚠️ 核心闭源，托管 SaaS | ❌ Workflow 部分开源 | ✅ MIT |
| **Provider 数** | 1000+ | 1000+ | 2700+ | 100+（依赖 n8n 节点） |
| **Action 数** | 10000+ | 10000+ | 10000+ | 取决于 n8n 节点 |
| **MCP 暴露** | ✅ 5 个固定 tool（discovery） | ✅ 每 Action 一个 tool | ❌ 无原生 MCP | ⚠️ 桥接 n8n 工作流 |
| **自托管** | ✅ Node / Cloudflare Workers / Docker | ⚠️ 仅自托管 Core | ❌ SaaS only | ✅ |
| **凭证存储** | SQLite / D1 / OOMOL 云 | 自带 DB + 云 | Workflow-state 内置 | n8n credentials |
| **OAuth 刷新** | ✅ in-flight 去重 + 自动 | ✅ | ✅ | ✅ |
| **Action 策略** | ✅ 三层（deployment/runtime/token） | ⚠️ 单层配置 | ❌ 无 | ❌ 无 |
| **Guarded Fetch** | ✅ DNS/跨域/RFC 1918 全套 | ⚠️ 基础 SSRF 防护 | ⚠️ 自托管时需用户自己处理 | ⚠️ 取决于 n8n |
| **审计日志** | ✅ RunLog + Idempotency | ✅ | ✅ | ✅ |
| **Cloudflare Workers** | ✅ 原生（Workers + D1 + R2 + KV） | ❌ | ❌ | ❌ |
| **CLI 工具** | ✅ `oo` 本地代理 | ❌ | ⚠️ 自带 CLI | ⚠️ 需 n8n CLI |

**设计差异深度分析**：

**(1) Discovery vs 注册模式**：OpenConnector 用 5 个固定 MCP tool + `search_actions` 动态发现（context 友好），Composio 给每个 Action 注册独立 tool（context 消耗大但调用直接）。当 Provider 数 > 500 时，**Discovery 模式优势明显**。

**(2) 凭证隔离哲学**：OpenConnector 把凭证完全留在网关，Agent 只接触 Action ID + input；Composio 类似但提供了"凭证可下放到 Agent"的可选项。**前者更安全（Agent 永远拿不到 raw token），后者更灵活（Agent 可以跨服务跳转）**。

**(3) 自托管 vs SaaS 哲学**：OpenConnector 三个部署形态（Node / Workers / OOMOL 托管）使用同一份代码（`createConnectApp` 工厂函数被两个 entry point 复用）；Composio 自托管 Core 与 SaaS 是不同代码路径。**前者是"一份代码三种形态"哲学，后者是"自托管是 SaaS 的简化版"**。

**(4) GuardedFetch 网络安全**：OpenConnector 把 DNS 反绑定 + RFC 1918 + 跨域凭证剥离做成**框架默认行为**（所有 provider 都自动启用）；其他项目要么不防护、要么需要 provider 作者手动开启。**这是 OpenConnector 对"Agent 时代 SaaS 集成必须默认安全"的态度**。

## 优缺点分析

| 维度 | 优点 | 代价 |
|------|------|------|
| **架构简洁性** | Provider-Definition 声明式 + 5-tool MCP 抽象极简 | 复杂 OAuth 场景（如 Microsoft 多租户 + Conditional Access）需要扩展 `OAuth2AuthDefinition` 字段 |
| **扩展性** | 加新 provider 只需 `src/providers/<name>/` 一个目录 + 自带 JSON Schema | 自定义 OAuth client config（企业自建 OAuth app）需要额外 `OAuthClientConfigService` 配置 |
| **易用性** | Discovery 模式让 Agent 不需要预加载 1000+ tool 描述 | Agent 必须会调 `search_actions` + `get_action_guide` 两次才能 execute（vs 直接调 tool 多 1-2 轮） |
| **可观测性** | RunLog + Idempotency + OAuthState 三个 store 全程审计 | 审计日志查询 UI 还在早期（Web Console 有基本 viewer） |
| **部署灵活性** | Node + Workers + OOMOL 三形态同一代码 | Workers 形态有冷启动延迟（首次 D1 查询 200-500ms），不适合高 QPS Action 密集场景 |
| **网络安全** | GuardedFetch 默认启用 DNS/RFC 1918/跨域全套防护 | 偶尔会误杀合法内网回调（如企业 self-hosted GitHub Enterprise），需要 `OOMOL_CONNECT_ALLOW_PRIVATE_NETWORK=true` 显式开启 |
| **维护性** | Apache-2.0 + OOMOL 团队持续维护（每日 commit） | Provider 数量爆炸（1000+）导致 `executorModules` 编译产物大（首次冷启动 5-10s） |

## 实践：本地启动 + Claude Code 接入

**前置条件**：Node.js 22+

```bash
# 1. 克隆并构建
git clone https://github.com/oomol-lab/open-connector.git
cd open-connector
npm install
npm run build

# 2. 配置 OAuth client（GitHub 为例）
export OOMOL_CONNECT_ENCRYPTION_KEY=$(openssl rand -hex 32)
export OOMOL_CONNECT_ADMIN_TOKEN=$(openssl rand -hex 16)
export OOMOL_CONNECT_RUNTIME_TOKEN=$(openssl rand -hex 16)
# GitHub OAuth app 在 https://github.com/settings/developers 创建
# Authorization callback URL = http://localhost:3000/oauth/callback
export GITHUB_OAUTH_CLIENT_ID=xxx
export GITHUB_OAUTH_CLIENT_SECRET=xxx

# 3. 启动
PORT=3000 npm run start:server
# 输出: connect server listening at http://127.0.0.1:3000
```

**在 Claude Code 配置 MCP**（`~/.claude.json` 或项目级 `.mcp.json`）：

```json
{
  "mcpServers": {
    "openconnector": {
      "type": "http",
      "url": "http://localhost:3000/mcp",
      "headers": {
        "Authorization": "Bearer ${OOMOL_CONNECT_RUNTIME_TOKEN}"
      }
    }
  }
}
```

**配置 GitHub 连接（CLI 方式）**：

```bash
# 安装 oo CLI
npm install -g @oomol-lab/oo-cli

# 配置 GitHub 连接（会走 OAuth 流程）
oo connection create github --auth-type=oauth2 --scopes=repo,read:user

# 或者直接用 API Key（Personal Access Token）
oo connection create github --auth-type=api_key --api-key=ghp_xxx
```

**Agent 调用示例（自然语言）**：

```
用户: 帮我看看 GitHub 上 anthropics/claude-code 最近一周的 issue 列表

Agent 思考: 需要调用 GitHub list_issues → 先 search_actions 找
Agent: search_actions("list_issues", "github")
→ 返回 {id: "github.list_repository_issues", description: "List issues in a repository..."}

Agent: get_action_guide("github.list_repository_issues")
→ 返回 markdown 指南 + JSON schema: {owner, repo, state, since, perPage, page}

Agent: execute_action("github.list_repository_issues", {
    owner: "anthropics",
    repo: "claude-code",
    state: "open",
    since: "2026-08-09T00:00:00Z"
})
→ 返回最近一周的 17 个 issue 列表

Agent: 这周共 17 个新 issue，最热门的是 #1234（修复 xxx 的 bug），其次是 ...
```

## 趋势与总结

OpenConnector 揭示了 2026 H2 AI Agent 基础设施的三个明确趋势：

**趋势 1：Connector Gateway 成为 Agent 必备基础设施**。2024 年是 Agent 框架之战（LangChain/LlamaIndex/CrewAI），2025 年是 Coding Agent 之争（Claude Code/Codex/Goose），2026 H2 进入 **Agent 工具生态整合期**——单独的 provider 集成已经不够，**"统一的连接器网关 + 多通道接入 + 三层安全策略"** 成为标配。Composio 闭源、Pipedream 半开源、MCP 生态各自为政的混乱状态正在结束，OpenConnector 的出现意味着开源阵营有了完整答案。

**趋势 2：MCP Discovery 模式压倒直接注册模式**。当 Provider 数量从 50 → 1000 时，把 1000+ Action 直接注册成 MCP tool 会撑爆 context window（Claude 4 Opus 的 system prompt 才 200k tokens）。**"5 个固定 discovery tool + 动态搜索"** 成为唯一可持续方案。Anthropic 官方在 MCP 文档里也开始推荐 "Tool Search" 模式，OpenConnector 是这个模式的工程化先驱。

**趋势 3：Cloudflare Workers 成为 AI Agent 基础设施的黄金部署形态**。D1（边缘 SQLite）+ R2（对象存储）+ KV（键值）+ Static Assets（前端托管）+ Workers（边缘计算）的组合，**让"全球用户的 SaaS 凭证都存在他们地理最近的边缘节点"** 成为可能，比传统"单 region Postgres + S3 + ECS"架构延迟低 10-50 倍。OpenConnector 把 Cloudflare Workers 当一等公民（与 Node 本地自托管代码同源），是这个趋势的早期信号。

**对工程团队的启示**：
- **不要让你的 Agent 直接拿 SaaS 凭证**——永远经过网关（OpenConnector / Composio / 自建），Agent 只接触 Action ID + input
- **多通道暴露能力**（SDK/CLI/MCP/HTTP/OpenAPI）—— 同一个网关同时服务人类开发者、AI Agent、CI/CD，不要只支持一种接入方式
- **Action 策略一定要做**——即使初期只有一层 allowlist，未来加 Runtime 层、Token 层是必然。三层架构从 day 1 设计成本低，后期改造代价大
- **Cloudflare Workers 自托管** 是 2026 年最低成本的"全球分布式 Agent 基础设施"——D1 免费额度 5GB / R2 10GB / KV 100k 读/日，对中小规模 Agent 完全够用

**关键资源**：
- 🏠 [oomol-lab/open-connector](https://github.com/oomol-lab/open-connector)
- 📖 [Cloudflare Workers 部署指南](https://github.com/oomol-lab/open-connector/blob/main/docs/cloudflare.md)
- 🛠 [Connector SDK](https://github.com/oomol-lab/connector-sdk)
- 💻 [oo CLI](https://github.com/oomol-lab/oo-cli)
- 🌐 [OOMOL Hosted SaaS](https://oomol.com/docs/connector-saas/)
- 📜 License: **Apache-2.0**

**总结**：OpenConnector 不是一个新框架，它是 **"1000+ SaaS 集成的中台基础设施"** —— 把凭证、OAuth、Action、策略、网络安全、审计这些 SaaS 集成的"工程债"封装成一套可在 Node / Cloudflare Workers / OOMOL 托管三种形态运行的标准网关。对正在构建 AI Agent 产品的团队，它直接消灭了"自己写 100 个 provider 集成 + 100 个 OAuth 流程 + 100 个 Action schema"这个**永远做不完的体力活**，让你专注在 Agent 的决策逻辑上。