---
title: 【AI Agent】（七）CLI-Anything深度解析：重新定义AI Agent与软件的关系
date: 2026-04-15 21:12:00
categories:
- AI技术
tags:
- AI Agent
- 工具调用
- MCP
description: "Today's Software Serves Humans👨💻. Tomorrow's Users will be Agents🤖."
series: ai-agent

---

# CLI-Anything深度解析：重新定义AI Agent与软件的关系

## 前言

2026年3月8日，香港大学数据科学团队在GitHub上发布了一个名为 **CLI-Anything** 的开源项目。38天后，这个项目斩获了 **30,000+ Stars**，刷新了AI开源项目的增速记录。

但Stars只是表象。真正值得深思的问题是：**这个项目为什么能在这么短的时间内引发如此广泛的共鸣？**

答案藏在项目主页的第一句话里：

> **Today's Software Serves Humans👨💻. Tomorrow's Users will be Agents🤖.**
>
> 今天的软件服务于人类。明天的用户，将是AI Agent。

这不是一个功能强大的工具，而是一个**范式转变的起点**。本文将深入剖析CLI-Anything的本质、它所解决的根本问题、以及它对未来软件生态的深远影响。

## 一、根本问题：Agent与软件之间的"巴别塔"

### 1.1 被忽视的断层

过去几年，AI Agent的发展集中在**推理能力**的提升——从GPT-3到GPT-4，从单步推理到CoT、ReAct、Agentic Workflow。但有一个关键问题始终被回避：

> **AI Agent能推理，但它能真正"使用"软件吗？**

现实很残酷：

```mermaid
flowchart TB
    subgraph AI能力["🤖 AI的强项"]
        REASON["逻辑推理<br/>代码生成<br/>语言理解<br/>规划分解"]
    end
    
    subgraph 软件现实["💻 真实软件"]
        SW[" Blender<br/>FFmpeg<br/>GIMP<br/>LibreOffice<br/>专业软件群"]
    end
    
   断层["❌ Agent-Software Gap<br/>AI能思考，却无法操控真实软件"]
    
    REASON --> 断层
    SW --> 断层
    
    style 断层 fill:#FFA07A,stroke:#FF6347,color:#000
```

当今AI Agent的"工具调用"能力，本质上是**调用API或搜索网页**——这些都是为人类设计的接口。当Agent需要完成真实任务时，它面对的是：

| Agent看到的 | 真实情况 |
|------------|---------|
| "我可以用Python操作Word文档" | Word的COM接口需要Windows环境，且文档格式复杂 |
| "我可以用API调用FFmpeg" | FFmpeg参数上千种，输出格式验证困难 |
| "我可以控制Blender渲染3D" | Blender的Python API是bpy，不是blender命令行 |

### 1.2 现有方案的三个层次

```mermaid
flowchart TB
    subgraph 低层["❌ UI自动化层"]
        RPA["RPA (UiPath/AutoJS)<br/>截图→OCR→点击坐标<br/>脆弱：UI变即崩溃"]
    end
    
    subgraph 中层["⚠️ API集成层"]
        API["定制API集成<br/>为每个软件写SDK<br/>昂贵：每款软件独立开发"]
    end
    
    subgraph 高层["⚠️ 原生Agent层"]
        NATIVE["MCP / Tool Use<br/>为Agent设计接口<br/>问题：需要软件方主动适配"]
    end
    
    subgraph 理想["✅ CLI-Anything层"]
        CLIANY["任意软件 → Agent工具<br/>自动转换，持续可用"]
    end
    
    低层 --> 中层 --> 高层 --> 理想
```

**现有方案的共同困境**：它们都在让Agent"迁就"软件，而非让软件"变成"Agent的原生语言。

## 二、本质创新：重新设计软件与Agent的"中间协议"

### 2.1 CLI-Anything在做什么

CLI-Anything的核心不是"生成CLI工具"，而是**定义了软件与Agent之间的新协议**：

```text
传统协议（软件 → 人类）：
软件 → 图形界面 → 鼠标键盘 → 人类理解

Agent协议（软件 → Agent）：
软件 → CLI → SKILL.md → Agent理解 → 自然语言任务
```

```mermaid
flowchart TB
    subgraph 旧范式["旧范式：软件为人类设计"]
        OLD_SW["📦 软件<br/>GUI + API"]
        OLD_HUMAN["👨‍💻 人类<br/>理解UI, 操作鼠标"]
    end
    
    subgraph 新范式["新范式：软件为Agent设计"]
        NEW_SW["📦 软件<br/>CLI + SKILL.md"]
        NEW_AGENT["🤖 AI Agent<br/>解析SKILL.md<br/>自然语言 → CLI调用"]
    end
    
    OLD_SW --> OLD_HUMAN
    NEW_SW --> NEW_AGENT
    
    style 旧范式 fill:#FFE4B5,stroke:#FFA500
    style 新范式 fill:#98FB98,stroke:#228B22
```

### 2.2 SKILL.md的意义：Agent的"使用说明书"

SKILL.md是CLI-Anything最关键的创新——它本质上是**为Agent重写的软件使用手册**：

| 传统手册（给人看） | SKILL.md（给Agent看） |
|------------------|---------------------|
| "点击'文件'菜单，选择'导出'" | `cli-blender render --scene scene.blend --output ./render.png --engine CYCLES` |
| "拖动时间轴到第60帧" | `cli-blender seek --frame 60` |
| "在属性面板中设置材质" | `cli-blender material set --object Cube --material Wood --roughness 0.8` |

SKILL.md让Agent能像人类读手册一样理解软件的全部能力，并准确调用。

### 2.3 七阶段流水线的工程哲学

CLI-Anything的7阶段流水线不是简单地把"分析源码"和"生成代码"拼接起来，它的工程哲学在于**把人类专家的知识系统化**：

```mermaid
flowchart TB
    subgraph 人类专家行为["👨‍💻 人类专家的做法"]
        H1["理解软件功能"]
        H2["设计接口方案"]
        H3["编写CLI实现"]
        H4["编写测试验证"]
        H5["撰写使用文档"]
        H6["打包分发"]
    end
    
    subgraph CLI-Anything自动化["🔧 CLI-Anything的抽象"]
        A1["Analyze: LLM理解源码"]
        A2["Design: LLM设计接口"]
        A3["Implement: LLM编写CLI"]
        A4["Tests: LLM生成测试"]
        A5["Document: LLM生成SKILL.md"]
        A6["Publish: 标准化分发"]
    end
    
    H1 -.-> A1
    H2 -.-> A2
    H3 -.-> A3
    H4 -.-> A4
    H5 -.-> A5
    H6 -.-> A6
    
    style 人类专家行为 fill:#DDA0DD,stroke:#9370DB
    style CLI-Anything自动化 fill:#87CEEB,stroke:#4169E1
```

**关键洞察**：这个流水线把"人类专家如何将一个软件CLI化"的知识编码成了HARNESS.md——这是一个可以被LLM执行的方法论。

### 2.4 生成的CLI为何稳定可靠

传统UI自动化为什么脆弱？因为它操作的是**表现层**（像素、坐标），而非**功能层**（命令、参数）。

CLI-Anything生成的CLI操作的是**功能层**：

```mermaid
flowchart LR
    subgraph UI自动化["UI自动化"]
        PIX["像素/坐标<br/>❌ 表现层"]
        BREAK["UI变 → 全部失效"]
    end
    
    subgraph CLI生成["CLI-Anything"]
        CMD["命令/参数<br/>✅ 功能层"]
        STABLE["软件核心功能不变<br/>CLI永远有效"]
    end
    
    PIX --> BREAK
    CMD --> STABLE
    
    style UI自动化 fill:#FFA07A,stroke:#FF6347
    style CLI生成 fill:#98FB98,stroke:#228B22
```

这解释了为什么Blender每次大版本更新会导致大量脚本失效，但FFmpeg的命令行参数相对稳定——**操作功能层的接口天然更稳定**。

## 三、AI座舱：最迫切的落地场景

### 3.1 座舱软件的"Agent荒漠"现状

智能座舱是当今软件智能化程度最低的领域之一：

```mermaid
flowchart TB
    subgraph 手机生态["📱 手机生态（Agent化程度：高）"]
        PHONE["Apple Intelligence<br/>Google Assistant<br/>App深度集成"]
    end
    
    subgraph 家居生态["🏠 智能家居（Agent化程度：中）"]
        HOME["HomeKit<br/>米家<br/>语音控制设备"]
    end
    
    subgraph 座舱生态["🚗 智能座舱（Agent化程度：低）"]
        COCKPIT["❌ 语音助手：固定指令集<br/>❌ 车载App：无Agent能力<br/>❌ 车辆控制：封闭协议"]
    end
    
    style 座舱生态 fill:#FFA07A,stroke:#FF6347
```

**讽刺的现实**：你的车可能有最强大的芯片，但它最难被AI控制。

### 3.2 座舱Agent化的三层路径

```mermaid
flowchart TB
    subgraph Layer1["第一层：信息娱乐（近期可落地）"]
        L1_1["🎵 音乐/播客<br/>自然语言点歌、切歌<br/>\"播放我上次听到一半的那首歌\""]
        L1_2["🗺️ 导航<br/>\"带我去公司，路上顺便充个电<br/>找个有咖啡的充电站\""]
        L1_3["📞 通讯<br/>\"给张总回电话，说我在路上\""]
    end
    
    subgraph Layer2["第二层：车辆控制（中期可行）"]
        L2_1["❄️ 空调<br/>\"把温度调到22度，主驾开启座椅通风\""]
        L2_2["🚪 车门/车窗<br/>\"锁车并关闭所有车窗\""]
        L2_3["📊 车辆状态<br/>\"胎压怎么样？电池还剩多少电？\""]
    end
    
    subgraph Layer3["第三层：自动驾驶（远期探索）"]
        L3_1["🤖 驾驶模式切换<br/>\"切换到自动驾驶模式\""]
        L3_2["🛣️ 导航增强<br/>\"在下一路口接管，帮我并线\""]
    end
    
    Layer1 --> Layer2 --> Layer3
    
    style Layer1 fill:#98FB98,stroke:#228B22
    style Layer2 fill:#FFE4B5,stroke:#FFA500
    style Layer3 fill:#FFA07A,stroke:#FF6347
```

### 3.3 车载CLI生态的构建路径

```mermaid
flowchart TB
    subgraph Phase1["📦 第一阶段：工具箱建设<br/>2026 Q2-Q3"]
        P1_1["建立车载CLI规范标准<br/>v1.0版本"]
        P1_2["CLI-Anything扩展车载模板<br/>支持CAN/UDS协议"]
        P1_3["首批CLI发布<br/>FFmpeg(视频)、OBD(诊断)、<br/>充电桩API"]
    end
    
    subgraph Phase2["🤝 第二阶段：生态联盟<br/>2026 Q4 - 2027 Q2"]
        P2_1["与车企/Tier1合作<br/>提供源码级CLI生成服务"]
        P2_2["建立车载CLI-Hub<br/>类似PyPI的车载工具市场"]
        P2_3["定义车载SKILL.md标准<br/>统一Agent-车载接口"]
    end
    
    subgraph Phase3["🚀 第三阶段：Agent原生座舱<br/>2027 Q3+"]
        P3_1["Agent可通过自然语言<br/>控制座舱全部功能"]
        P3_2["跨车型通用车载Agent<br/>一辆车的Agent可以适配其他车"]
        P3_3["座舱OS内置Agent运行时<br/>原生支持自然语言交互"]
    end
    
    Phase1 --> Phase2 --> Phase3
    
    style Phase1 fill:#87CEEB,stroke:#4169E1
    style Phase2 fill:#DDA0DD,stroke:#9370DB
    style Phase3 fill:#98FB98,stroke:#228B22
```

### 3.4 必须跨越的五个门槛

```mermaid
flowchart TB
    subgraph Gate1["🚨 门槛一：安全隔离"]
        G1["车辆控制涉及生命安全<br/>必须在隔离环境中运行<br/>关键指令需要物理确认机制"]
    end
    
    subgraph Gate2["⏱️ 门槛二：实时性"]
        G2["座舱交互要求<500ms响应<br/>CLI需异步化设计<br/>关键路径不可走网络"]
    end
    
    subgraph Gate3["📜 门槛三：接口标准化"]
        G3["各车企协议私有<br/>需要建立行业标准<br/>CLI规范统一是前提"]
    end
    
    subgraph Gate4["🔐 门槛四：认证体系"]
        G4["车规级软件需过ISO 26262<br/>Automotive SPICE认证<br/>生成的CLI必须符合安全标准"]
    end
    
    subgraph Gate5["🔑 门槛五：权限控制"]
        G5["不是所有乘客都能控制全车<br/>驾驶员/乘客权限分级<br/>Agent的调用需要身份认证"]
    end
    
    G1 --> G2 --> G3 --> G4 --> G5
    
    style G1 fill:#FFA07A,stroke:#FF6347
    style G2 fill:#FFA07A,stroke:#FF6347
    style G3 fill:#FFE4B5,stroke:#FFA500
    style G4 fill:#FFA07A,stroke:#FF6347
    style G5 fill:#FFE4B5,stroke:#FFA500
```

### 3.5 具体落地案例：FFmpeg车载应用

```mermaid
flowchart TB
    subgraph 场景["🚗 场景：行车记录仪视频处理"]
        USER["\"把今天上午9点到11点的录像<br/>剪成一个10分钟的精华版\""]
    end
    
    subgraph Agent处理["🤖 Agent处理流程"]
        A1["解析SKILL.md<br/>了解cli-ffmpeg所有能力"]
        A2["分解任务：<br/>① 查询录像文件<br/>② 按时间剪切<br/>③ 合并为文件<br/>④ 添加时间戳字幕"]
        A3["执行CLI命令序列"]
    end
    
    subgraph 结果["✅ 输出"]
        RESULT["生成10分钟精华视频<br/>包含时间戳和关键事件标注"]
    end
    
    USER --> Agent处理 --> RESULT
```

这个场景今天**已经可以做到**——FFmpeg的CLI转换已经在CLI-Hub中。

## 四、更宏大的图景：软件生态的Agent化重构

### 4.1 CLI-Anything揭示的趋势

CLI-Anything的30k Stars背后，是一个正在形成的共识：

> **软件正在从"给人用"转变为"给Agent用"**

这意味着整个软件生态将经历一次重构：

```mermaid
flowchart TB
    subgraph 旧生态["🌐 旧软件生态"]
        OLD["闭源App → 开放API → 开发者生态<br/>开发者 → 用户<br/>人 是 软件的终点"]
    end
    
    subgraph 新生态["🤖 新软件生态"]
        NEW["任意软件 → CLI → SKILL.md<br/>Agent生态系统<br/>Agent → 用户（作为代理）<br/>Agent 是 软件的终点"]
    end
    
    OLD --> NEW
    
    style 旧生态 fill:#FFE4B5,stroke:#FFA500
    style 新生态 fill:#98FB98,stroke:#228B22
```

### 4.2 未来三年关键预测

```mermaid
timeline
    title 软件生态Agent化时间线
    2026 : CLI-Hub成为标配
         : 每个开发者的工具箱
         : 车载/IoT领域首批落地
    2027 : 企业软件全面CLI化
         : ERP/CRM/MES均有Agent接口
         : "AI同事"成为工作标配
    2028-2029 : 操作系统级支持
         : Windows/Mac/Linux原生Agent API
         : 软件的Agent接口成为第二API
    2030+ : 新软件形态
         : "Agent-First Software"出现
         : 软件天然具有Agent交互能力
```

### 4.3 开发者必须思考的问题

```mermaid
mindmap
  root((每个开发者必须思考))
    我的软件如何被Agent调用？
      有CLI吗？
      有SKILL.md吗？
      有MCP Tools吗？
    我的API是Agent可理解的吗？
      参数命名是否自解释？
      返回值是否结构化？
      错误信息是否可操作？
    我的软件对Agent友好吗？
      是否幂等？
      是否有dry-run模式？
      是否支持事务回滚？
```

## 五、技术局限与深层挑战

### 5.1 当前局限

| 局限 | 深层原因 | 解决路径 |
|------|---------|---------|
| **依赖强模型** | 源码分析需要强推理能力 | 模型能力持续提升；专用小模型蒸馏 |
| **必须有源码** | 闭源软件无法分析 | 协议逆向（法律允许范围）；与厂商合作 |
| **生成不完整** | 复杂软件难以一次性CLI化 | 多轮Refine；人类专家审核 |
| **非确定性** | LLM生成有随机性 | 测试驱动生成；输出验证 |

### 5.2 更根本的挑战

```mermaid
flowchart TB
    subgraph 哲学挑战["🤔 哲学层面的问题"]
        P1["软件是为人设计的<br/>Agent的认知模型与人不同"]
        P2["\"理解软件意图\"≠\"执行软件命令\""]
        P3["当Agent错误操作软件时<br/>责任归谁？"]
    end
    
    subgraph 技术挑战["🔧 技术层面的问题"]
        T1["状态管理：软件状态复杂<br/>CLI难以完全建模"]
        T2["错误恢复：GUI可以一步步撤回<br/>CLI的错误难以优雅恢复"]
        T3["功能发现：SKILL.md可能遗漏<br/>某些Agent不知道能做什么"]
    end
    
    P1 --> T1
    P2 --> T2
    P3 --> T3
    
    style 哲学挑战 fill:#DDA0DD,stroke:#9370DB
    style 技术挑战 fill:#FFA07A,stroke:#FF6347
```

## 六、项目纵览

```mermaid
flowchart TB
    subgraph 项目信息["📊 CLI-Anything 核心数据"]
        STARS["Stars: 30,000+<br/>Forks: 2,900+<br/>创建: 2026-03-08"]
        LANG["语言: Python ≥3.10<br/>框架: Click ≥8.0<br/>测试: 2,130+ 通过"]
        SUPP["平台: Claude Code<br/>OpenClaw / Pi / nanobot<br/>CLI数量: 16+持续增加"]
    end
    
    subgraph 核心价值["💡 核心价值"]
        CV1["方法论编码：HARNESS.md<br/>将人类专家知识系统化"]
        CV2["协议设计：SKILL.md<br/>软件-Agent的通用接口"]
        CV3["自动化生成：7阶段流水线<br/>无需人工干预的CLI化"]
    end
    
    style 项目信息 fill:#87CEEB,stroke:#4169E1
    style 核心价值 fill:#98FB98,stroke:#228B22
```

## 结语：站在Agent时代的起点

CLI-Anything的意义，远不止于"生成CLI工具"。它揭示了一个更深层的真相：

> **AI Agent时代需要的不是更强的AI，而是让软件"开口说话"的方法。**

CLI-Anything是第一个系统性地解决这个问题的开源项目。它的成功告诉我们：**把软件变成Agent能理解的语言，这个方向是对的。**

对于AI座舱而言，CLI-Anything的启发在于：**与其等待座舱软件原生支持Agent，不如主动将座舱软件CLI化。** 这是一条可以今天就开始走的路。

## 参考资料

| 资源 | 链接 |
|------|------|
| **GitHub** | github.com/HKUDS/CLI-Anything |
| **CLI-Hub** | clianything.cc |
| **HARNESS.md** | cli-anything-plugin/HARNESS.md |
| **论文** | arXiv:2304.03442 (Generative Agents原始论文) |

---

*本文为技术洞察，如有疑问或想法，欢迎交流。*

---

## 对比分析

CLI-Anything 提出把任意软件"CLI 化"以便 Agent 调用。下面选取两个也围绕"软件可由 Agent 操作"的项目做对比：Anthropic 的 Computer Use 与 OpenHands，并加上 pi-mono 做轻量对照。

### 对比维度一：与软件交互的接口
| 维度 | CLI-Anything | Anthropic Computer Use | OpenHands |
| --- | --- | --- | --- |
| 接入方式 | 生成 CLI 子命令 | 截屏 + 鼠标键盘 | 浏览器/Shell 自动化 |
| 适配目标 | 任何有 CLI 潜力的软件 | 任意带 GUI 的桌面应用 | 任意 Web/桌面 |
| 确定性 | 高，纯命令行 | 低，依赖视觉识别 | 中 |
| 可调试性 | 直接看终端 | 需要回放截图 | 工作区快照 |

### 对比维度二：Agent 友好度
| 维度 | CLI-Anything | Computer Use | OpenHands |
| --- | --- | --- | --- |
| LLM 工具调用友好 | 极好 | 一般 | 好 |
| 权限边界 | 文件级 + 命令级 | 屏幕级 | 沙箱级 |
| 学习成本 | 中，需要适配每个软件 | 低（直接给目标） | 中 |
| 适合生产 | 是 | PoC | 是 |

### 优缺点
- **CLI-Anything**：把"软件交互"压到最确定的形式，工具调用最稳；但需要为每个软件写适配。
- **Computer Use**：通用性最强，能跑任何 GUI；视觉链路不可控、耗 token。
- **OpenHands**：在仓库/浏览器场景最成熟；CLI 化软件的支持不是它的主战场。

### 何时选哪个
- 想让 Agent 操作企业内软件、可接受适配成本 → 选 CLI-Anything
- 想零改造操作任意 GUI 软件 → 选 Computer Use
- 想自动化 Web/仓库任务 → 选 OpenHands

### 参考资料
- Anthropic Computer Use 文档：https://docs.anthropic.com/en/docs/agents-and-tools/computer-use
- OpenHands 仓库：https://github.com/All-Hands-AI/OpenHands
- pi-mono 仓库：https://github.com/malcolmyu/pi-mono（作为轻量对照）
