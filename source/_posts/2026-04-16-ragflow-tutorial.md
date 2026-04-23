---
title: 【RAGFlow】开源RAG引擎完整入门：从零搭建基于深度文档理解的智能问答系统
date: 2026-04-16 19:38:00
categories:
- 教程
tags:
- RAG
- LLM
- 开源项目
---

# RAGFlow开源RAG引擎完整入门教程：从零搭建基于深度文档理解的智能问答系统

## 前言

RAG（Retrieval-Augmented Generation）作为当前最火热的LLM应用架构之一，已经成为企业构建知识库问答系统的首选方案。然而传统的RAG实现面临诸多痛点：文档解析粗糙 Chunking效果差、检索精度不足、结果无法溯源、无法处理复杂格式文档等。

**RAGFlow** 是由 [Infiniflow](https://github.com/infiniflow) 开源的新一代RAG引擎，它将**深度文档理解（DeepDoc）**与**Agent能力**深度融合，被认为是目前最先进的开源RAG解决方案之一。

本文将从零开始，详细介绍RAGFlow的核心特性、系统架构、快速部署、配置使用，以及如何用它搭建一个生产级别的智能问答系统。

```mermaid
mindmap
  root((RAGFlow))
    深度文档理解
      PDF/Word/Excel解析
      表格结构识别
      多模态理解
    智能分块
      可视化预览
      人工干预
      多种分块策略
    精准检索
      多路召回
      混合检索
      Fused重排序
    Agent能力
      意图识别
      工具调用
      迭代推理
    系统集成
      OpenClaw Skill
      MCP协议
      REST API
```

## 一、项目概览

### 1.1 什么是RAGFlow

RAGFlow是[Infiniflow](https://infiniflow.ai/)团队开源的**检索增强生成（RAG）引擎**，其核心特点是将深度文档理解技术与RAG全流程深度整合。

```mermaid
flowchart TB
    subgraph 输入["📥 多源数据输入"]
        PDF["PDF文档"]
        DOC["Word/Excel"]
        IMG["图片扫描件"]
        WEB["网页内容"]
        STRUCT["结构化数据"]
    end
    
    subgraph 解析层["🔍 DeepDoc深度解析"]
        LAYOUT["布局分析<br/>标题/段落/表格"]
        OCR["OCR识别"]
        TABLE["表格结构化"]
        FORMULA["公式解析"]
    end
    
    subgraph 分块层["✂️ 智能分块"]
        SEMANTIC["语义分块"]
        BALANCE["均衡分块"]
        PAPER["论文分块"]
        MANUAL["手动干预"]
    end
    
    subgraph 检索层["🔎 混合检索"]
        VECTOR["向量检索"]
        KEYWORD["关键词检索"]
        RERANK["Fused重排序"]
    end
    
    subgraph 生成层["🤖 LLM生成"]
        CONTEXT["上下文组装"]
        CITE["引用溯源"]
        RESPONSE["生成回答"]
    end
    
    输入 --> 解析层 --> 分块层 --> 检索层 --> 生成层
    
    style 输入 fill:#DDA0DD,stroke:#9370DB
    style 解析层 fill:#87CEEB,stroke:#4169E1
    style 分块层 fill:#98FB98,stroke:#228B22
    style 检索层 fill:#FFE4B5,stroke:#FFA500
    style 生成层 fill:#FFB6C1,stroke:#FF69B4
```

### 1.2 核心数据

| 指标 | 数据 |
|------|------|
| **GitHub Stars** | 28,000+ |
| **Fork** | 3,500+ |
| **最新版本** | v0.24.0 |
| **语言** | Python + React |
| **首次发布** | 2024年 |
| **维护团队** | Infiniflow |

### 1.3 关键特性

```mermaid
flowchart LR
    subgraph 特性["✨ RAGFlow核心特性"]
        F1["📄 深度文档理解<br/>复杂格式精准解析"]
        F2["🔍 无限Token检索<br/>大海捞针能力"]
        F3["🎯 可解释性强<br/>traceable citations"]
        F4["📊 可视化分块<br/>人工干预调节"]
        F5["🤖 Agentic RAG<br/>多轮对话迭代推理"]
        F6["🔗 MCP支持<br/>生态集成"]
    end
    
    F1 & F2 & F3 --> CORE["核心能力"]
    F4 & F5 & F6 --> CORE
    
    style 特性 fill:#87CEEB,stroke:#4169E1
    style CORE fill:#FFB6C1,stroke:#FF69B4
```

## 二、技术架构解析

### 2.1 系统架构图

```mermaid
flowchart TB
    subgraph 前端层["🌐 Web UI (React)"]
        UI["用户界面<br/>上传/配置/查询"]
    end
    
    subgraph 网关层["⚙️ API Gateway"]
        API["FastAPI<br/>REST API"]
    end
    
    subgraph 核心服务["🔧 核心服务"]
        RAG_SVC["RAG Service<br/>检索+生成"]
        DEEP_DOC["DeepDoc Service<br/>文档解析"]
        EMBED["Embedding Service<br/>向量化"]
        AGENT["Agent Service<br/>意图识别/推理"]
    end
    
    subgraph 数据层["💾 数据存储"]
        ES["Elasticsearch<br/>全文+向量检索"]
        MYSQL["MySQL<br/>元数据存储"]
        REDIS["Redis<br/>缓存"]
        MINIO["MinIO<br/>文件存储"]
    end
    
    UI --> API --> RAG_SVC
    RAG_SVC --> DEEP_DOC
    RAG_SVC --> EMBED
    RAG_SVC --> AGENT
    RAG_SVC --> ES
    RAG_SVC --> MYSQL
    RAG_SVC --> REDIS
    DEEP_DOC --> MINIO
    
    style 前端层 fill:#DDA0DD,stroke:#9370DB
    style 网关层 fill:#87CEEB,stroke:#4169E1
    style 核心服务 fill:#98FB98,stroke:#228B22
    style 数据层 fill:#FFE4B5,stroke:#FFA500
```

### 2.2 DeepDoc文档理解引擎

RAGFlow的**DeepDoc**是其核心技术亮点，能够处理复杂格式文档：

```mermaid
flowchart TB
    subgraph 文档类型["📄 支持的文档格式"]
        T1["PDF（含扫描件）"]
        T2["Word (.docx/.doc)"]
        T3["Excel (.xlsx/.xls)"]
        T4["PowerPoint"]
        T5["图片 (PNG/JPG)"]
        T6["HTML/Markdown"]
        T7["txt纯文本"]
    end
    
    subgraph 解析能力["🔬 DeepDoc解析能力"]
        P1["布局分析<br/>识别标题/段落/页眉/页脚"]
        P2["表格结构识别<br/>保留表格行列关系"]
        P3["OCR光学识别<br/>扫描件/图片文字提取"]
        P4["公式识别<br/>LaTeX/MathML"]
        P5["目录结构解析<br/>标题层级关系"]
    end
    
    文档类型 --> 解析能力
    
    style 文档类型 fill:#87CEEB,stroke:#4169E1
    style 解析能力 fill:#DDA0DD,stroke:#9370DB
```

### 2.3 检索流程

```mermaid
sequenceDiagram
    participant U as 用户
    participant UI as Web界面
    participant API as API服务
    participant EMBED as Embedding服务
    participant ES as 检索引擎
    participant RERANK as 重排序
    participant LLM as LLM服务
    
    U->>UI: 输入查询问题
    UI->>API: 提交查询
    API->>EMBED: 向量化查询
    EMBED-->>API: 返回query向量
    API->>ES: 发起混合检索请求
    ES-->>API: 返回候选文档块
    API->>RERANK: Fused重排序
    RERANK-->>API: Top-K排序结果
    API->>LLM: 组装上下文+引用
    LLM-->>API: 生成回答（含溯源）
    API-->>UI: 返回结果
    UI-->>U: 展示答案+引用来源
```

### 2.4 Agentic RAG能力

RAGFlow v0.15+ 引入了**Agentic RAG**，支持复杂的多轮对话和迭代推理：

```mermaid
flowchart TB
    subgraph Agent处理["🤖 Agent处理流程"]
        Q["用户问题"]
        INTENT["意图识别"]
        PLAN["规划子任务"]
        RETRIEVE["分步检索"]
        REASON["迭代推理"]
        ANSWER["综合回答"]
    end
    
    Q --> INTENT --> PLAN --> RETRIEVE --> REASON --> ANSWER
    
    subgraph 工具集["🛠️ Agent可用工具"]
        T1["向量检索"]
        T2["关键词检索"]
        T3["知识图谱查询"]
        T4["网页搜索"]
    end
    
    RETRIEVE -.-> T1 & T2 & T3 & T4
    
    style Agent处理 fill:#87CEEB,stroke:#4169E1
    style 工具集 fill:#98FB98,stroke:#228B22
```

## 三、快速部署

### 3.1 系统要求

| 组件 | 最低要求 | 推荐配置 |
|------|---------|---------|
| CPU | 4核 | 8核+ |
| 内存 | 16GB | 32GB+ |
| 硬盘 | 50GB | 100GB+ SSD |
| Docker | 24.0.0+ | 最新版 |
| Docker Compose | v2.26.1+ | 最新版 |

### 3.2 Docker一键部署

```bash
# 1. 克隆项目
git clone https://github.com/infiniflow/ragflow.git
cd ragflow

# 2. 进入Docker目录
cd ragflow/docker

# 3. 下载CPU版本（首次运行会自动下载镜像，约2GB）
docker compose -f docker-compose.yml up -d

# 4. 查看启动日志
docker logs -f docker-ragflow-cpu-1

# 5. 看到以下输出表示启动成功
#  ____ ___ ______ ______ __
# / __ \ / |/ ____// ____// /____ _ __
# / /_/ // /| | / __ / /_ / // __ \| | /| / /
# / _, _// ___ |/ /_/ // __/ / // /_/ /| |/ |/ /
# /_/ |_|/_/  |_|\____//_/ /_/ \____/ |__/|__/
#
#  * Running on all addresses (0.0.0.0)
```

### 3.3 GPU加速部署（如有NVIDIA GPU）

```bash
# 1. 修改docker/.env，添加GPU支持
echo "DEVICE=gpu" >> .env

# 2. 重启服务
docker compose -f docker-compose.yml up -d

# 3. 验证GPU是否被使用
docker exec docker-ragflow-cpu-1 nvidia-smi
```

### 3.4 配置LLM API Key

```bash
# 编辑配置文件
vim docker/service_conf.yaml.template

# 找到并配置LLM厂商
user_default_llm:  # 选择LLM厂商
  API_KEY: your_api_key_here
  # 可选：deepseek / openai / zhipu / minimax 等
```

支持的LLM厂商：

| 厂商 | 模型 | 配置名 |
|------|------|--------|
| OpenAI | GPT-4o, GPT-4-turbo, GPT-5 | `openai` |
| DeepSeek | DeepSeek-V3, DeepSeek-R1 | `deepseek` |
| 智谱AI | GLM-4, GLM-4V | `zhipu` |
| MiniMax | MiniMax-Text, MiniMax-VL | `minimax` |
| Google | Gemini 1.5 Pro, Gemini 2.0 | `gemini` |

### 3.5 访问RAGFlow

```bash
# 在浏览器中访问（默认端口80）
http://<服务器IP>

# 默认管理员账号
# 用户名: admin
# 密码: default_password
```

> ⚠️ **重要**：首次登录后请立即修改默认密码！

## 四、使用教程

### 4.1 创建知识库

```mermaid
flowchart TB
    subgraph 创建流程["📝 创建知识库步骤"]
        S1["Step 1: 上传文档"]
        S2["Step 2: 选择解析模板"]
        S3["Step 3: 配置分块策略"]
        S4["Step 4: 预览并调整"]
        S5["Step 5: 确认并索引"]
    end
    
    S1 --> S2 --> S3 --> S4 --> S5
    
    style 创建流程 fill:#87CEEB,stroke:#4169E1
```

**操作步骤**：

1. **上传文档**：点击"上传文件"按钮，选择要处理的PDF/Word/Excel等文件
2. **选择解析模板**：RAGFlow提供多种解析模板
   - `General`：通用文档
   - `Paper`：学术论文
   - `Manual`：用户手册
   - `Book`：书籍
   - `Laws`：法律法规
   - `Table`：表格
   - `Resume`：简历
3. **配置分块策略**：
   - `General`：基于段落自动分块
   - `Balanced`：均衡分块
   - `Quality`：高质量分块（语义理解）
   - `Manual`：手动设置
4. **预览分块结果**：可视化查看分块效果，可手动合并/拆分
5. **提交索引**：确认后开始向量化索引

### 4.2 分块策略详解

```mermaid
flowchart LR
    subgraph 分块策略["✂️ 分块策略对比"]
        P1["General<br/>按段落分块<br/>简单快速"]
        P2["Balanced<br/>语义+长度平衡<br/>推荐默认"]
        P3["Quality<br/>语义理解分块<br/>质量最高"]
        P4["Manual<br/>手动设置<br/>灵活控制"]
    end
    
    style P1 fill:#98FB98,stroke:#228B22
    style P2 fill:#87CEEB,stroke:#4169E1
    style P3 fill:#DDA0DD,stroke:#9370DB
    style P4 fill:#FFE4B5,stroke:#FFA500
```

| 参数 | 说明 | 推荐值 |
|------|------|--------|
| Chunk Size | 每个块的目标字符数 | 512-1024 |
| Chunk Overlap | 相邻块的重叠字符数 | 50-100 |
| Omit User Question | 是否在块中省略用户问题 | 否 |
| Auto Keywords | 自动提取关键词 | 启用 |

### 4.3 创建Agent对话

```mermaid
flowchart TB
    subgraph Agent配置["⚙️ Agent配置"]
        C1["选择知识库"]
        C2["配置LLM"]
        C3["设置检索参数"]
        C4["配置提示词模板"]
    end
    
    subgraph 检索设置["🔍 检索参数"]
        R1["Top-K: 召回数量"]
        R2["Similarity Threshold: 相似度阈值"]
        R3["Vector Weight: 向量权重"]
        R4["Rerank: 是否重排序"]
    end
    
    C1 --> C2 --> C3 --> C4
    C3 --> R1 & R2 & R3 & R4
    
    style Agent配置 fill:#DDA0DD,stroke:#9370DB
    style 检索设置 fill:#87CEEB,stroke:#4169E1
```

**推荐检索参数**：

| 参数 | 说明 | 推荐值 |
|------|------|--------|
| Top-K | 召回的文档块数量 | 10-20 |
| Similarity Threshold | 相似度得分阈值 | 0.5-0.7 |
| Vector Weight | 向量检索权重 | 0.7 |
| Keywords Weight | 关键词权重 | 0.3 |

### 4.4 API调用示例

RAGFlow提供RESTful API，可以集成到其他系统：

```bash
# 1. 获取API Key（在设置页面生成）
export API_KEY="your_api_key_here"
export BASE_URL="http://<服务器IP>"

# 2. 创建知识库
curl -X POST "${BASE_URL}/v1/datasets" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{"name": "my_knowledge_base", "description": "测试知识库"}'

# 3. 上传文档
curl -X POST "${BASE_URL}/v1/datasets/{dataset_id}/documents" \
  -H "Authorization: Bearer ${API_KEY}" \
  -F "file=@/path/to/document.pdf"

# 4. 获取文档列表
curl -X GET "${BASE_URL}/v1/datasets/{dataset_id}/documents" \
  -H "Authorization: Bearer ${API_KEY}"

# 5. 发起检索
curl -X POST "${BASE_URL}/v1/retrieval" \
  -H "Authorization: Bearer ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d '{
    "dataset_ids": ["dataset_id_1", "dataset_id_2"],
    "question": "什么是RAG？",
    "top_k": 10
  }'

# 6. 删除知识库
curl -X DELETE "${BASE_URL}/v1/datasets/{dataset_id}" \
  -H "Authorization: Bearer ${API_KEY}"
```

```python
# Python SDK调用示例
import requests

BASE_URL = "http://your-ragflow-server"
API_KEY = "your_api_key"
headers = {"Authorization": f"Bearer {API_KEY}"}

# 创建知识库
response = requests.post(
    f"{BASE_URL}/v1/datasets",
    headers=headers,
    json={"name": "test_kb", "description": "Test"}
)
dataset_id = response.json()["data"]["id"]

# 上传文档
with open("document.pdf", "rb") as f:
    files = {"file": f}
    response = requests.post(
        f"{BASE_URL}/v1/datasets/{dataset_id}/documents",
        headers=headers,
        files=files
    )

# 检索
response = requests.post(
    f"{BASE_URL}/v1/retrieval",
    headers=headers,
    json={
        "dataset_ids": [dataset_id],
        "question": "RAG的优势是什么？",
        "top_k": 10
    }
)
print(response.json())
```

## 五、进阶功能

### 5.1 Agentic RAG（多轮对话）

```mermaid
flowchart TB
    subgraph 多轮对话流程["💬 Agentic RAG多轮对话"]
        Q1["问题1: 解释RAG概念"]
        A1["回答1: RAG是检索增强生成..."]
        Q2["追问: 具体怎么实现？"]
        A2["回答2: 需要以下步骤..."]
        Q3["继续追问: 哪个步骤最难？"]
        A3["回答3: 检索质量最关键..."]
    end
    
    Q1 --> A1
    A1 --> Q2
    Q2 --> A2
    A2 --> Q3
    Q3 --> A3
    
    style 多轮对话流程 fill:#DDA0DD,stroke:#9370DB
```

RAGFlow的Agent支持：
- **意图识别**：自动判断用户是查询、总结还是对比
- **迭代推理**：多轮对话中保持上下文连贯
- **工具编排**：自动选择合适的工具组合

### 5.2 数据源同步

RAGFlow支持从多种数据源同步数据：

```mermaid
flowchart TB
    subgraph 数据源["📦 支持的数据源"]
        D1["Confluence"]
        D2["S3/MinIO"]
        D3["Notion"]
        D4["Discord"]
        D5["Google Drive"]
        D6["本地文件"]
    end
    
    subgraph 同步类型["🔄 同步方式"]
        S1["手动上传"]
        S2["定时同步"]
        S3["Webhook触发"]
    end
    
    D1 & D2 & D3 & D4 & D5 & D6 --> S1 & S2 & S3
    
    style 数据源 fill:#87CEEB,stroke:#4169E1
    style 同步类型 fill:#98FB98,stroke:#228B22
```

### 5.3 MCP协议集成

RAGFlow支持**Model Context Protocol (MCP)**，可以与其他AI系统集成：

```mermaid
flowchart LR
    subgraph MCP生态["🔗 MCP生态"]
        RAG["RAGFlow"]
        CLAUDE["Claude"]
        OPENCLAW["OpenClaw"]
        OTHER["其他AI应用"]
    end
    
    RAG --> MCP["MCP Server"]
    CLAUDE --> MCP
    OPENCLAW --> MCP
    OTHER --> MCP
    
    style MCP生态 fill:#DDA0DD,stroke:#9370DB
```

### 5.4 Agent Memory（记忆能力）

v0.16+ 支持Agent记忆功能：

```mermaid
flowchart TB
    subgraph 记忆类型["🧠 Agent Memory"]
        SHORT["短期记忆<br/>当前会话"]
        LONG["长期记忆<br/>跨会话累积"]
        USER["用户画像<br/>偏好/历史"]
    end
    
    subgraph 用途["📌 用途"]
        U1["个性化回答"]
        U2["上下文连续性"]
        U3["智能推荐"]
    end
    
    记忆类型 --> 用途
    
    style 记忆类型 fill:#87CEEB,stroke:#4169E1
    style 用途 fill:#98FB98,stroke:#228B22
```

## 六、与OpenClaw集成

### 6.1 RAGFlow OpenClaw Skill

RAGFlow官方提供了OpenClaw Skill，可以直接在OpenClaw中访问RAGFlow数据集：

```mermaid
flowchart TB
    subgraph OpenClaw["🤖 OpenClaw"]
        AGENT["AI Agent"]
        SKILL["RAGFlow Skill"]
    end
    
    subgraph RAGFlow["📚 RAGFlow"]
        KB["知识库"]
        API["API服务"]
    end
    
    AGENT --> SKILL
    SKILL --> API
    API --> KB
    
    style OpenClaw fill:#87CEEB,stroke:#4169E1
    style RAGFlow fill:#98FB98,stroke:#228B22
```

**安装方式**：

```bash
# 通过OpenClaw安装RAGFlow Skill
openclaw skills install https://clawhub.ai/yingfeng/ragflow-skill
```

### 6.2 集成配置

```yaml
# openclaw配置文件
ragflow:
  api_url: http://your-ragflow-server
  api_key: your_api_key
  default_dataset: my_knowledge_base
```

## 七、常见问题

### 7.1 部署问题

| 问题 | 解决方案 |
|------|---------|
| Docker镜像下载慢 | 配置国内镜像加速 |
| 内存不足 | 增加Docker内存限制到16GB+ |
| 端口冲突 | 修改.env中的SVR_HTTP_PORT |
| 启动失败 | 检查docker logs -f |

### 7.2 检索效果问题

| 问题 | 解决方案 |
|------|---------|
| 检索不到相关内容 | 降低Similarity Threshold |
| 答案不准确 | 调整分块策略，重新索引 |
| 引用来源错误 | 检查Top-K参数，增加召回数量 |
| 响应速度慢 | 启用GPU加速，清理历史会话 |

### 7.3 性能优化建议

```mermaid
flowchart TB
    subgraph 优化建议["⚡ 性能优化"]
        O1["使用GPU加速DeepDoc解析"]
        O2["启用ES/Redis缓存"]
        O3["定期清理过期索引"]
        O4["使用合适的分块大小"]
        O5["配置Nginx缓存静态资源"]
    end
    
    style 优化建议 fill:#FFB6C1,stroke:#FF69B4
```

## 八、总结

RAGFlow作为新一代开源RAG引擎，相比传统方案有显著优势：

```mermaid
flowchart LR
    subgraph 对比["RAGFlow vs 传统RAG"]
        T1["传统RAG"]
        T2["RAGFlow"]
    end
    
    T1 --> C1["❌ 文档解析粗糙"]
    T1 --> C2["❌ 分块效果差"]
    T1 --> C3["❌ 无法溯源"]
    T1 --> C4["❌ 复杂格式支持差"]
    
    T2 --> R1["✅ DeepDoc精准解析"]
    T2 --> R2["✅ 可视化智能分块"]
    T2 --> R3["✅ traceable citations"]
    T2 --> R4["✅ 复杂格式完美支持"]
    
    style T1 fill:#FFA07A,stroke:#FF6347
    style T2 fill:#98FB98,stroke:#228B22
```

**适用场景**：

| 场景 | 推荐度 | 理由 |
|------|--------|------|
| 企业知识库问答 | ⭐⭐⭐⭐⭐ | 复杂文档支持好 |
| 客服机器人 | ⭐⭐⭐⭐ | 快速部署，效果好 |
| 学术文档问答 | ⭐⭐⭐⭐⭐ | 论文解析专业 |
| 法律文档检索 | ⭐⭐⭐⭐ | 法规分块精准 |
| 技术文档库 | ⭐⭐⭐⭐ | 代码+文档混合 |

## 参考资源

| 资源 | 链接 |
|------|------|
| **GitHub** | github.com/infiniflow/ragflow |
| **官网** | ragflow.io |
| **在线Demo** | cloud.ragflow.io |
| **文档** | ragflow.io/docs |
| **OpenClaw Skill** | clawhub.ai/yingfeng/ragflow-skill |
| **Docker Hub** | hub.docker.com/r/infiniflow/ragflow |

---

*RAGFlow是目前最值得关注的开源RAG项目之一，推荐在生产环境中尝试！*
