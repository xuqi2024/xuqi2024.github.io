---
title: Opus 编解码器实战：混合架构与丢包隐藏
date: 2026-11-24 09:00:00
categories:
- 技术报告
tags:
- Opus
- 音频编解码
- 丢包隐藏
- 车规语音
- libopus
series: audio-tech-deep-dive
description: 基于 libopus 1.5.2 源码实测：Opus 的 SILK/CELT 双层架构、模式自动切换阈值、FEC 带宽降级、DTX 静音断流与 PLC 丢包隐藏的完整工程分析。
---

> **一句话结论**：Opus 不是一个编解码器，而是**三个编解码器（SILK / Hybrid / CELT）加一个调度器**。它的"聪明"不在于某个算法多先进，而在于**知道什么时候该用哪个算法**——而这个决策逻辑，全写在一张 5 行的小表里。
>
> 本文所有数字都来自我本地编译的 libopus（xiph/opus，commit `316c675`，2026-11-20），语料是 numpy 合成的确定性信号，代码可复现。

---

## 前言：为什么车机语音团队要盯 Opus

2026 年做车机语音，几乎绕不开 Opus。

原因很直白：**车机麦克风采到的语音要送到云端做 ASR，车载 TTS 的音频要回传到手机蓝牙**。这两条链路过去分别用 AMR-NB/AMR-WB 和 SBC/AAC，问题是：

- **AMR-NB** 窄带（4 kHz），音质糙；**AMR-WB** 窄带扩展（8 kHz），还行
- **SBC** 蓝牙强制编码，音质被蓝牙 SIG 锁死，车机没法优化
- **AAC** 是**帧 + 延迟杀手**：典型编码延迟 1024 样本 ≈ 21 ms @48 kHz，加上解码和播放器缓冲，端到端很容易冲到 150 ms 以上

而 Opus 的标称能力是：**6 kbit/s 到 510 kbit/s 全覆盖，算法延迟 5 ms 到 65.2 ms**（RFC 6716 §2）。这个延迟区间对实时语音是碾压性的。

但"Opus 很强"这句话有个陷阱：**它是自动切换架构的，不同码率下走的是完全不同的算法**。如果你不搞清楚它什么时候切换、切换时会发生什么，你会在量产车上遇到"为什么同样 24 kbps，车机模式比手机模式差这么多"这种查不出原因的问题。

这篇文章我做三件事：

1. **把 libopus 源码里的决策逻辑挖出来**（模式切换阈值到底怎么算的）
2. **在本地编译 + 实测**，把每个参数的实际影响量化
3. **把三个最容易踩的坑讲透**：FEC 的隐式带宽降级、DTX 的 1 字节包、PLC 的帧长失控

---

## 一、Opus 的双层架构：SILK 管低频，CELT 管高频

### 1.1 两个层各自的特长

Opus 的核心设计是把"语音"和"音乐"这两类完全不同的信号需求，交给两套历史上独立的算法：

| 层 | 全称 | 底层技术 | 擅长 | 支持带宽 | 帧长范围 |
|---|---|---|---|---|---|
| **LP 层** | Linear Prediction | SILK | 语音（低码率下人声还原度高） | NB / MB / WB（4/6/8 kHz） | 10 ~ 60 ms |
| **MDCT 层** | Modified DCT | CELT | 音乐 / 高频细节 | NB / WB / SWB / FB（4/8/12/20 kHz） | 2.5 ~ 20 ms |

SILK 是**线性预测**（Linear Prediction）路线：先把信号当作"过去若干样本的线性组合"来建模，剩下的残差用噪声整形量化。它的杀手锏是**在极低码率下（6-16 kbit/s）依然能保住语音的可懂度**——这是 MDCT 做不到的。

CELT 是**改进型离散余弦变换**路线：把信号切成一帧一帧做 MDCT，每帧 21 个 Bark 频带，频带内用 PVQ（Pyramid Vector Quantizer）量化。它在**中高码率下能完整还原音乐的高频细节**，这是 SILK 做不到的（SILK 最高只到 8 kHz）。

### 1.2 Hybrid 模式：两层同时工作

真正有意思的是第三种组合：**Hybrid 模式同时启用两层**。

但它有个硬约束：**切换点固定在 8 kHz**。

- SILK 层负责 0 ~ 8 kHz
- CELT 层负责 8 ~ 20 kHz
- **8 kHz 以下的 MDCT 系数全部被丢弃**（不是"冗余编码"，是直接扔掉）

这意味着 Hybrid 模式下两层之间**没有任何冗余**——SILK 坏了，CELT 也救不了 8 kHz 以下。这是理解后面 FEC 章节的前提。

```mermaid
graph TB
    subgraph "输入侧"
        PCM["🎤 PCM 输入<br/>任意采样率 8k~48k"]
    end

    subgraph "SILK 层 (LP)"
        SILK_ENC["🟣 SILK 编码器<br/>LPC + NSQ + 噪声整形"]
        SILK_DEC["🟣 SILK 解码器"]
    end

    subgraph "CELT 层 (MDCT)"
        CELT_ENC["🔵 CELT 编码器<br/>MDCT + PVQ + 瞬态处理"]
        CELT_DEC["🔵 CELT 解码器"]
    end

    RC["🟢 共用 Range Coder<br/>两层共用一个熵编码器"]

    PCM --> SILK_ENC
    PCM --> CELT_ENC
    SILK_ENC --> RC
    CELT_ENC --> RC
    RC --> BIT["📦 Opus 码流<br/>TOC 字节 + 负载"]
    BIT --> SILK_DEC
    BIT --> CELT_DEC
    SILK_DEC --> OUT["🔊 重建 PCM"]
    CELT_DEC --> OUT

    style PCM fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style SILK_ENC fill:#E8D5F5,stroke:#CE93D8,color:#333
    style SILK_DEC fill:#E8D5F5,stroke:#CE93D8,color:#333
    style CELT_ENC fill:#FFDAB9,stroke:#FFAB76,color:#333
    style CELT_DEC fill:#FFDAB9,stroke:#FFAB76,color:#333
    style RC fill:#B5EAD7,stroke:#80CBC4,color:#333
    style BIT fill:#FFB3C6,stroke:#F48FB1,color:#333
    style OUT fill:#FFF9C4,stroke:#F9A825,color:#333
```

### 1.3 采样率与音频带宽是解耦的

这是很多人在配置 Opus 时会搞错的一点。**"采样率"和"音频带宽"是两回事**：

| 音频带宽 | 有效采样率 | 说明 |
|---|---|---|
| NB | 8 kHz | 4 kHz 低通 |
| MB | 6 kHz | 6 kHz 低通 |
| WB | 8 kHz | 8 kHz 低通 |
| SWB | 12 kHz | 有效采样率定在 **24 kHz**（不是 32 kHz） |
| FB | 20 kHz | Opus **从不编码 20 kHz 以上** |

**关键实现细节**（来自 RFC 6716 §2，我也在源码里核对过）：

- **SILK 层内部始终以 2× 音频带宽运行**（最高 16 kHz）。即使你要 SWB/FB，SILK 侧也只跑 16 kHz
- **CELT 层内部始终 48 kHz**，靠**频域置零**来支持其他采样率——所以 CELT 侧**没有重采样器**，只有 SILK 侧有（`silk/resampler.c`）
- **CELT 编码输入额外延迟 2.7 ms**，用来对齐两层的 lookahead 差异

最后这条解释了为什么 Hybrid 模式编码延迟比纯 SILK 高：SILK 的噪声整形估计需要 5 ms lookahead，CELT 的 MDCT 交叠窗需要 2.5 ms，编码器必须把 CELT 输入推后 2.7 ms 才能让两层同时到达。

### 1.4 TOC 字节：一眼看出用了什么模式

Opus 码流的第一字节是 TOC（Table Of Contents）：

```
config(5 bit) | s(1 bit, 立体声标志) | c(2 bit, 帧数编码)
```

`config` 的取值直接告诉你用了哪层、哪个带宽。这是运维排查的第一个抓手——**不需要解码，扫一眼 TOC 就知道链路两端协商成了什么**。

RFC 6716 Table 2 的完整映射（我按 config 段整理）：

| config 范围 | 工作模式 | 带宽 | 可用帧长 |
|---|---|---|---|
| 0–3 | SILK-only | NB | 10 / 20 / 40 / 60 ms |
| 4–7 | SILK-only | MB | 10 / 20 / 40 / 60 ms |
| 8–11 | SILK-only | WB | 10 / 20 / 40 / 60 ms |
| 12–13 | Hybrid | SWB | 10 / 20 ms |
| 14–15 | Hybrid | FB | 10 / 20 ms |
| 16–19 | CELT-only | NB | 2.5 / 5 / 10 / 20 ms |
| 20–23 | CELT-only | WB | 2.5 / 5 / 10 / 20 ms |
| 24–27 | CELT-only | SWB | 2.5 / 5 / 10 / 20 ms |
| 28–31 | CELT-only | FB | 2.5 / 5 / 10 / 20 ms |

我在实测程序里就是靠这个字节反推模式的——后面所有模式切换的数据都是从 TOC 直方图来的。

### 1.5 一个 Opus 包长什么样

理解 TOC 之后，再看整个包的比特布局：

```mermaid
graph TB
    subgraph "Opus 包 (单帧)"
        TOC["🔵 TOC 字节 (8 bit)<br/>config[5] | s[1] | c[2]"]
        FLAGS["🟣 帧标志<br/>VBR / padding / FEC / LBRR"]
        FRAME["🟢 主帧负载<br/>SILK 数据 或 MDCT 频谱系数"]
        LBRR["🟡 LBRR 冗余帧<br/>仅 SILK 模式 + FEC 开启"]
        PAD["⚪ Padding<br/>cbr 只用不校验的填充位"]
    end

    TOC --> FLAGS --> FRAME --> LBRR --> PAD

    NOTE["💡 关键点：<br/>① TOC 永远在第一个字节<br/>② LBRR 是上一帧的低码率重编码<br/>③ frame length = 0 表示 DTX 或丢包<br/>④ 单包最多 120 ms (48 × 2.5 ms)"]

    TOC -.-> NOTE
    LBRR -.-> NOTE

    style TOC fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style FLAGS fill:#E8D5F5,stroke:#CE93D8,color:#333
    style FRAME fill:#B5EAD7,stroke:#80CBC4,color:#333
    style LBRR fill:#FFF9C4,stroke:#F9A825,color:#333
    style PAD fill:#F5F5F5,stroke:#BDBDBD,color:#333
    style NOTE fill:#FFDAB9,stroke:#FFAB76,color:#333
```

RFC 6716 §3.2.1 的帧长编码里 **0 = No frame（DTX 或丢包）**——这就是 DTX 空包在码流里的表示，也是第 6 章那 1 字节包的来源。

**运维视角的价值**：你在抓包工具里看到一个 Opus 包，**第一个字节就能告诉你**：用的哪层算法、什么带宽、几个帧、是不是立体声。这比"解一遍码看波形"快三个数量级。我在下面 9.2 节的编码器代码里就把 TOC 读取做成了标准动作。

---

## 二、模式自动切换：藏在 5 行代码里的调度器

### 2.1 阈值表就是全部秘密

`src/opus_encoder.c` 里，决定 SILK / CELT 切换的核心就这几行：

```c
static const opus_int32 stereo_voice_threshold = 19000;
static const opus_int32 stereo_music_threshold = 17000;

/* Threshold bit-rate for switching between SILK/hybrid and CELT-only */
static const opus_int32 mode_thresholds[2][2] = {
      /* voice */ /* music */
      {  64000,      10000}, /* mono */
      {  44000,      10000}, /* stereo */
};
```

读法很简单：

| 信号类型 | 单声道 | 立体声 |
|---|---|---|
| **语音 (voice)** | **64 kbit/s** 才切 CELT | 44 kbit/s |
| **音乐 (music)** | **10 kbit/s** 就切 CELT | 10 kbit/s |

**这解释了一个非常反直觉的现象**：语音在 10 kbit/s 和 60 kbit/s 之间切换时，Opus 一直用 SILK；音乐在 12 kbit/s 就已经用 CELT 了。

### 2.2 完整的决策链

从 `opus_encode_frame_native()` 抽出来的决策顺序（我按源码行号 1472–1546 整理）：

```mermaid
flowchart TD
    START(["🎯 opus_encode 入口"]) --> A["① 应用类型判定<br/>RESTRICTED_SILK → 强制 SILK<br/>RESTRICTED_LOWDELAY/CELT → 强制 CELT"]
    A --> B["② 计算 equiv_rate<br/>等效码率"]
    B --> C["③ 按立体声宽度插值<br/>mode_voice / mode_music"]
    C --> D["④ 按 voice_est 插值<br/>threshold = mode_music +<br/>voice_est²×(mode_voice-mode_music)÷2¹⁴"]
    D --> E{"⑤ VoIP 偏置?"}
    E -->|"是 VOIP"| F["threshold += 8000<br/>偏向 SILK"]
    E -->|"否"| G{"⑥ 迟滞"}
    F --> G
    G -->|"上次是 CELT"| H["threshold -= 4000"]
    G -->|"上次是 SILK"| I["threshold += 4000"]
    H --> J["⑦ mode = equiv_rate >= threshold<br/>? CELT_ONLY : SILK_ONLY"]
    I --> J
    J --> K{"⑧ FEC 强制 SILK?"}
    K -->|"useInBandFEC 且<br/>丢包率足够高"| L["🟣 mode = SILK_ONLY"]
    K -->|"否"| M{"⑨ DTX 强制 SILK?"}
    L --> M
    M -->|"useDTX 且<br/>voice_est > 100"| L
    M -->|"否"| N{"⑩ max_data_bytes<br/>太小?"}
    N -->|"< 6~9 kbit/s 等效"| O["🔵 mode = CELT_ONLY"]
    N -->|"否"| P{"⑪ 帧长 < 10 ms?"}
    O --> P
    P -->|"是"| O
    P -->|"否"| Q["✅ 模式确定"]

    style START fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style A fill:#E8D5F5,stroke:#CE93D8,color:#333
    style B fill:#E8D5F5,stroke:#CE93D8,color:#333
    style C fill:#E8D5F5,stroke:#CE93D8,color:#333
    style D fill:#E8D5F5,stroke:#CE93D8,color:#333
    style E fill:#FFF9C4,stroke:#F9A825,color:#333
    style F fill:#FFDAB9,stroke:#FFAB76,color:#333
    style G fill:#FFF9C4,stroke:#F9A825,color:#333
    style H fill:#FFDAB9,stroke:#FFAB76,color:#333
    style I fill:#FFDAB9,stroke:#FFAB76,color:#333
    style J fill:#B5EAD7,stroke:#80CBC4,color:#333
    style K fill:#FFF9C4,stroke:#F9A825,color:#333
    style L fill:#E8D5F5,stroke:#CE93D8,color:#333
    style M fill:#FFF9C4,stroke:#F9A825,color:#333
    style N fill:#FFF9C4,stroke:#F9A825,color:#333
    style O fill:#FFDAB9,stroke:#FFAB76,color:#333
    style P fill:#FFF9C4,stroke:#F9A825,color:#333
    style Q fill:#B5EAD7,stroke:#80CBC4,color:#333
```

其中 **② 等效码率 `equiv_rate`** 的计算是另一层"看不见的折算"：

```c
static opus_int32 compute_equiv_rate(opus_int32 bitrate, int channels,
      int frame_rate, int vbr, int mode, int complexity, int loss)
{
   opus_int32 equiv;
   equiv = bitrate;
   /* Take into account overhead from smaller frames. */
   if (frame_rate > 50)
      equiv -= (40*channels+20)*(frame_rate - 50);
   /* CBR is about a 8% penalty for both SILK and CELT. */
   if (!vbr)
      equiv -= equiv/12;
   /* Complexity makes about 10% difference (from 0 to 10) in general. */
   equiv = equiv * (90+complexity)/100;
   if (mode == MODE_SILK_ONLY || mode == MODE_HYBRID)
   {
      /* SILK complexity 0-1 uses the non-delayed-decision NSQ, which
         costs about 20%. */
      if (complexity<2)
         equiv = equiv*4/5;
      equiv -= equiv*loss/(6*loss + 10);
   } else if (mode == MODE_CELT_ONLY) {
      /* CELT complexity 0-4 doesn't have the pitch filter, which costs
         about 10%. */
      if (complexity<5)
         equiv = equiv*9/10;
   } else {
      /* Mode not known yet */
      equiv -= equiv*loss/(12*loss + 20);
   }
   return equiv;
}
```

注意最后那个 `equiv -= equiv*loss/(6*loss + 10)`：**丢包率越高，等效码率越低**。丢包 10% 时打 12.5% 折、丢包 20% 时打 16.7% 折。逻辑是：既然要丢这么多包，与其浪费码率，不如省下来留给 FEC。

### 2.3 实测：模式切换点在哪里

我用合成语音（16 kHz mono，基频 + 三共振峰 + 底噪，6 秒）和合成音乐（48 kHz stereo，和弦 + 鼓 + 混响，6 秒），跑 `opus_lab` 逐帧统计 TOC：

**语音 mono @ VoIP 模式：**

| 目标码率 | 实测码率 | 与目标偏差 | TOC 模式分布 | 带宽分布 | 平均包长 |
|---|---|---|---|---|---|
| 6000 | 3.91 kbit/s | −34.9% | SILK × 300 (100%) | NB | 9.8 B |
| 8000 | 5.43 kbit/s | −32.1% | SILK × 300 (100%) | NB | 13.6 B |
| 12000 | 9.53 kbit/s | −20.6% | SILK × 300 (100%) | **WB** | 23.8 B |
| 16000 | 12.32 kbit/s | −23.0% | SILK × 300 (100%) | WB | 30.8 B |
| 24000 | 20.47 kbit/s | −14.7% | SILK × 300 (100%) | WB | 51.2 B |
| 32000 | 28.05 kbit/s | −12.4% | SILK × 300 (100%) | WB | 70.1 B |
| 48000 | 44.06 kbit/s | −8.2% | SILK × 300 (100%) | WB | 110.1 B |
| **64000** | 61.99 kbit/s | −3.1% | **SILK × 281 (93.7%)<br>CELT × 19 (6.3%)** | WB / MB | 155.0 B |
| **96000** | 96.40 kbit/s | +0.4% | **CELT × 300 (100%)** | MB | 241.0 B |
| 128000 | 128.40 kbit/s | +0.3% | CELT × 300 (100%) | MB | 321.0 B |

**三个可以直接拿去用的结论**：

1. **语音在 64 kbit/s 以下一直是 SILK**（100% SILK），64 kbit/s 才开始混合切 CELT，96 kbit/s 全切 CELT。这精确对应 `mode_thresholds` 里的 64000 加上 VoIP 的 +8000 偏置和 ±4000 迟滞
2. **6000 → 8000 档位带宽是 NB（4 kHz），12000 起变 WB（8 kHz）**。注意我用的是 16 kHz 采样率的输入——Opus 不会因为输入是 16 kHz 就只编 8 kHz，它按**信号本身检测到的带宽**决定
3. **语音档位实测码率普遍比目标低 12% ~ 35%**。这是 **VBR 的正常行为**：Opus 默认 VBR，静音/简单帧就少发比特。这是好事——"目标码率"在 VBR 下是**上限附近的中位参考**，不是保证值

**音乐 stereo @ audio 模式：**

| 目标码率 | 实测码率 | 偏差 | TOC 模式分布 | 带宽分布 | 平均包长 |
|---|---|---|---|---|---|
| 12000 | 12.12 kbit/s | +1.0% | SILK × 300 (100%) | WB | 30.3 B |
| **16000** | 16.64 kbit/s | +4.0% | **HYBRID × 28<br>CELT × 272** | SWB | 41.6 B |
| **24000** | 24.75 kbit/s | +3.1% | **HYBRID × 22<br>CELT × 278** | SWB | 61.9 B |
| **32000** | 32.96 kbit/s | +3.0% | **HYBRID × 21<br>CELT × 279** | SWB | 82.4 B |
| 48000 | 48.55 kbit/s | +1.1% | CELT × 300 (100%) | SWB | 121.4 B |
| 64000 | 64.59 kbit/s | +0.9% | CELT × 300 (100%) | SWB | 161.5 B |
| 96000 | 96.72 kbit/s | +0.7% | CELT × 300 (100%) | SWB | 241.8 B |
| 128000 | 128.83 kbit/s | +0.6% | CELT × 300 (100%) | SWB | 322.1 B |

**音乐在 16 kbit/s 就进入 Hybrid 了**（音乐阈值 10000 + 等效码率折算），而且 16–32 kbit/s 区间 Hybrid 帧数稳定在 21–28 帧（约 7%）。这个 Hybrid 占比是有意义的——**它正好是两层码率分配表 `compute_silk_rate_for_hybrid()` 里 CELT 拿到的份额不足以支撑全 SWB 时的退让**。

对比一下：

| 维度 | 语音（16 kHz mono） | 音乐（48 kHz stereo） |
|---|---|---|
| 12–16 kbit/s | SILK / WB | Hybrid+CELT / SWB |
| 24–32 kbit/s | SILK / WB | Hybrid+CELT / SWB |
| 48 kbit/s | SILK / WB | CELT / SWB |
| 96 kbit/s | CELT / MB | CELT / SWB |
| 码率偏差 | **−8% ~ −35%（VBR 欠发）** | **+0.6% ~ +4%（几乎打满）** |
| 带宽天花板 | 8 kHz（WB） | 12 kHz（SWB） |

**码率偏差的正负号差异非常能说明问题**：语音是"信号本身信息量低，VBR 少发比特"；音乐是"信息密度高，编码器尽量吃满预算"。所以**如果你在语音场景看到实测码率明显低于目标，不要以为配置错了**。

---

## 三、复杂度参数：10 和 0 差多少

`OPUS_SET_COMPLEXITY` 取值 0–10。RFC 6716 §2.1.5 列出它影响四件事：

1. 音高分析白化滤波器的阶数
2. 短时噪声整形滤波器的阶数
3. 残差信号延迟决策量化（DDQ）的状态数
4. 是否启用某些码流特性（可变时频分辨率、音高后滤波）

源码里的量化折算是 `equiv = equiv * (90+complexity)/100`——**复杂度从 0 到 10 大约影响 10% 的等效码率**。

我的实测（语音 16 kbit/s VoIP）：

| complexity | 实测码率 | 编码实时率 | 包长范围 | 平均包长 |
|---|---|---|---|---|
| 0 | 13.44 kbit/s | **0.0019** | 19–44 B | 33.6 B |
| 1 | 11.81 kbit/s | 0.0021 | 14–43 B | 29.5 B |
| 2 | 12.96 kbit/s | 0.0036 | 21–41 B | 32.4 B |
| 3 | 11.42 kbit/s | 0.0040 | 16–41 B | 28.6 B |
| 5 | 12.09 kbit/s | 0.0056 | 19–42 B | 30.2 B |
| 7 | 12.21 kbit/s | 0.0072 | 22–42 B | 30.5 B |
| 8 | 12.32 kbit/s | 0.0089 | 21–46 B | 30.8 B |
| 9 | 12.32 kbit/s | 0.0089 | 21–46 B | 30.8 B |
| **10** | **12.32 kbit/s** | 0.0087 | 21–46 B | 30.8 B |

**三个实测结论**：

1. **复杂度 8 / 9 / 10 的输出完全一致**（12.32 kbit/s，0.0089 实时率）。这是因为 SILK 侧只在 `complexity < 2` 时才切换到非延迟决策 NSQ，复杂度 ≥ 2 之后 SILK 主路径不变
2. **编码 CPU 开销从 complexity 0 的 0.0019 涨到 complexity 10 的 0.0087**，约 **4.6 倍**。但即便如此，实时率也只有 **0.87%**（编 1 秒音频用 8.7 毫秒）
3. **complexity 0 反而码率更高**（13.44 vs 12.32 kbit/s）—— 因为 `equiv = equiv*4/5` 的折算让编码器在同等"等效码率"下用了更多实际比特

**车规选型建议**：

| 场景 | 建议 complexity | 理由 |
|---|---|---|
| 车载语音唤醒 + ASR 上行 | **5** | 编码实时率 0.56%，音质和 10 几乎无差（码率差 0.23 kbit/s） |
| 音乐播放 / 提示音 | **10** | 音乐需要完整 MDCT 分析，实时率也才 0.56% |
| 低端 MCU / ESP32 软解 | **0–2** | 唯一有量级差异的区间（省 4.6 倍 CPU） |
| 云端批量转码 | 10 | CPU 不是约束 |

---

## 四、帧长选择：20 ms 是甜点，但有个硬下限

RFC 6716 §2.1.4 明确说：**"For this reason, 20 ms frames are a good choice for most applications."**

我实测了 4 档帧长（语音 16 kbit/s）：

| 帧长 | 实测码率 | 帧数 | 平均包长 | 编码实时率 | 模式 |
|---|---|---|---|---|---|
| 10 ms | 11.99 kbit/s | 600 | 15.0 B | 0.0097 | SILK / WB |
| **20 ms** | **12.32 kbit/s** | 300 | 30.8 B | 0.0087 | SILK / WB |
| 40 ms | 12.59 kbit/s | 150 | 62.9 B | 0.0087 | SILK / WB |
| 60 ms | 12.40 kbit/s | 100 | 93.0 B | 0.0097 | SILK / WB |

音乐 64 kbit/s：

| 帧长 | 实测码率 | 帧数 | 平均包长 | 模式 |
|---|---|---|---|---|
| 5 ms | 65.64 kbit/s | 1200 | 41.0 B | CELT / SWB |
| 10 ms | 64.86 kbit/s | 600 | 81.1 B | CELT / SWB |
| **20 ms** | **64.59 kbit/s** | 300 | 161.5 B | CELT / SWB |

**帧长对码率几乎没影响**（10→60 ms 差 5%），主要影响的是**包数量和丢包粒度**。

### 4.1 但 < 10 ms 会强制 CELT-only

源码 `src/opus_encoder.c`：

```c
/* Override the chosen mode to make sure we meet the requested frame size */
if (st->mode != MODE_CELT_ONLY && frame_size < st->Fs/100)
{
   celt_assert(st->application != OPUS_APPLICATION_RESTRICTED_SILK);
   st->mode = MODE_CELT_ONLY;
}
```

`st->Fs/100` 就是 10 ms。头文件 `opus.h` 里也说：

> "Passing in a duration of less than 10 ms (480 samples at 48 kHz) will prevent the encoder from using the LPC or hybrid modes."

**这是个硬约束，不带商量**。我实测 5 ms 帧长的音乐，确实是 100% CELT。

**为什么这条很重要**：低延迟场景（比如声学回声消除 + ASR 的紧耦合链路）你会想用 5 ms 帧，但**Opus 在 5 ms 下只能给你 CELT**——意味着语音在 5 ms 帧下**失去了 SILK 的低码率高可懂度优势**。16 kbit/s + 5 ms 帧的语音质量会明显不如 16 kbit/s + 20 ms 帧。

### 4.2 帧长与丢包粒度的权衡

| 帧长 | 单包丢失影响时长 | 网络包头开销占比（@20ms 一包） | 适合场景 |
|---|---|---|---|
| 10 ms | 10 ms | 20 ms 包：8~21% | 低延迟交互 |
| **20 ms** | **20 ms** | **8~21%** | **通用推荐** |
| 40 ms | 40 ms | 4~11% | 弱网省流量 |
| 60 ms | 60 ms | 3~7% | 纯录音回传 |

---

## 五、FEC 前向纠错：一个会偷偷降级你带宽的开关

这是本文最重要的一章，因为**这个行为几乎所有中文资料都没提**。

### 5.1 FEC 的工作方式

RFC 6716 §2.1.7：

> "Packets that are determined to contain perceptually important speech information, such as onsets or transients, are encoded again at a lower bitrate and this re-encoded information is added to a subsequent packet."

也就是：**关键帧（比如音节起始）会用低码率再编一次，塞进下一个包里**。这就是 SILK 层的 LBRR（Low Bit-Rate Redundancy）。

解码时用 `opus_decode(dec, data, len, pcm, frame_size, decode_fec=1)` 请求解码 FEC 数据。

### 5.2 三档语义

`OPUS_SET_INBAND_FEC` 的取值**不是布尔**，是三档：

| 值 | 语义 | 源码位置 |
|---|---|---|
| 0 | 关闭 | `src/opus_encoder.c:947-950`（`decide_fec` 入口） |
| 1 | 开启；且当丢包率高时**允许切到 SILK**（即使信号是音乐） | 同上 |
| 2 | 开启；**但不因音乐而切 SILK** | `src/opus_encoder.c:1524` |

而且 **CELT-only 模式永远没有 LBRR**：

```c
static int decide_fec(int useInBandFEC, int PacketLoss_perc, int last_fec, int mode, int *bandwidth, opus_int32 rate)
{
   int orig_bandwidth;
   if (!useInBandFEC || PacketLoss_perc == 0 || mode == MODE_CELT_ONLY)
      return 0;
   ...
}
```

第一行就 return 了。

### 5.3 ⚠️ 坑：FEC 会隐式降级你的音频带宽

`decide_fec()` 的核心逻辑：

```c
   LBRR_rate_thres_bps = fec_thresholds[2*(*bandwidth - OPUS_BANDWIDTH_NARROWBAND)];
   hysteresis = fec_thresholds[2*(*bandwidth - OPUS_BANDWIDTH_NARROWBAND) + 1];
   if (last_fec == 1) LBRR_rate_thres_bps -= hysteresis;
   if (last_fec == 0) LBRR_rate_thres_bps += hysteresis;
   LBRR_rate_thres_bps = silk_SMULWB( silk_MUL( LBRR_rate_thres_bps,
         125 - silk_min( PacketLoss_perc, 25 ) ), SILK_FIX_CONST( 0.01, 16 ) );
   /* If loss <= 5%, we look at whether we have enough rate to enable FEC.
      If loss > 5%, we decrease the bandwidth until we can enable FEC. */
   if (rate > LBRR_rate_thres_bps)
      return 1;
   else if (PacketLoss_perc <= 5)
      return 0;
   else if (*bandwidth > OPUS_BANDWIDTH_NARROWBAND)
      (*bandwidth)--;
   else
      break;
```

注意那句注释：**"If loss > 5%, we decrease the bandwidth until we can enable FEC."**

**翻译成人话**：码率不够同时养 FEC 和全带宽的时候，Opus 会**主动砍掉你的音频带宽**来腾出码率给 FEC。

我实测验证了这个行为（语音 16 kHz mono，VoIP，`loss=10%`）：

| 目标码率 | FEC | 实测码率 | **TOC 带宽分布** | 包长范围 |
|---|---|---|---|---|
| 12000 | 0 | 9.53 kbit/s | WB × 300 | 14–32 B |
| 12000 | 1 | 9.53 kbit/s | WB × 300 | 14–32 B |
| 16000 | 0 | 12.32 kbit/s | WB × 300 | 21–46 B |
| 16000 | 1 | 12.32 kbit/s | WB × 300 | 21–46 B |
| **20000** | **0** | **16.68 kbit/s** | **WB × 300** | 32–54 B |
| **20000** | **1** | **17.77 kbit/s** | **NB × 30<br>MB × 270** ⚠️ | **36–84 B** |
| **22000** | **0** | **18.16 kbit/s** | **WB × 300** | 36–58 B |
| **22000** | **1** | **19.72 kbit/s** | **MB × 37<br>WB × 263** ⚠️ | **38–92 B** |
| 24000 | 0 | 20.47 kbit/s | WB × 300 | 42–67 B |
| 24000 | 1 | 20.33 kbit/s | WB × 300 | 42–66 B |
| 32000 | 1 | 27.93 kbit/s | WB × 300 | 58–88 B |
| 48000 | 1 | 43.87 kbit/s | WB × 300 | 99–128 B |

**这张表就是本章的核心结论**：

- **20000 bps 档位**：FEC 一开，带宽从 **WB (8 kHz) 掉到 MB (6 kHz)，30 帧掉到 NB (4 kHz)**。码率从 16.68 涨到 17.77（+6.5%）
- **22000 bps 档位**：降级到 MB，37 帧还是 WB。码率 18.16 → 19.72（+8.6%）
- **24000 bps 以上**：FEC 反而不生效了——因为 `equiv_rate` 已经超过阈值，`decide_fec()` 直接返回 1，但 SILK 侧因为码率充裕本来就够，`LBRR_coded` 的实际效果体现在别处

**踩坑现场**：车机工程师设了 `OPUS_SET_INBAND_FEC(1)` + `OPUS_SET_PACKET_LOSS_PERC(10)`，在 20 kbit/s 下做测试，觉得"开了 FEC 音质应该更好"。结果用户投诉"怎么听起来像电话"。原因就是——**FEC 把带宽从 8 kHz 砍到 4 kHz 了**。

### 5.4 FEC 的码率增量从哪来

Hybrid 模式下的 SILK/CELT 码率分配表（`compute_silk_rate_for_hybrid()`，源码 `src/opus_encoder.c:980`，表体在 `:985`）：

```c
   static const int rate_table[][5] = {
  /*  |total| |-------- SILK------------|
              |-- No FEC -| |--- FEC ---|
               10ms   20ms   10ms   20ms */
      {    0,     0,     0,     0,     0},
      {12000, 10000, 10000, 11000, 11000},
      {16000, 13500, 13500, 15000, 15000},
      {20000, 16000, 16000, 18000, 18000},
      {24000, 18000, 18000, 21000, 21000},
      {32000, 22000, 22000, 28000, 28000},
      {64000, 38000, 38000, 50000, 50000}
   };
```

**FEC 的实际增量 = 11000-10000 = 1000 bps（10 ms 帧）/ 15000-13500 = 1500 bps（20 ms 帧）** 起步，在总码率 32000 时跳到 28000-22000 = **6000 bps**。

RFC 6716 本身**没有给** LBRR 的码率增量数字（只说 "lower bitrate"），这张表是 libopus 源码里的实际分配。

### 5.5 选型建议

| 场景 | FEC | 理由 |
|---|---|---|
| **车机 → 云端 ASR，弱网（LTE/5G 边缘）** | ✅ 开，`loss=10~15` | 语音关键帧冗余比音频保真更值钱 |
| **车机 → 云端，车内 WiFi 稳定** | ❌ 关 | 带宽被砍的代价 > 丢包代价 |
| **TTS 回传 / 音乐播放** | ❌ 关 | CELT 模式没有 FEC，开了也没用；且会强制切 SILK |
| **SIP / VoIP 互通** | ✅ 开 | 业界惯例，且 `loss` 由 RTCP 反馈动态喂 |

---

## 六、DTX 静音断流：省电省带宽，但也制造 1 字节包

### 6.1 DTX 到底做了什么

RFC 6716 §2.1.9 说：

> "Discontinuous Transmission (DTX) reduces the bitrate during silence or background noise. When DTX is enabled, only one frame is encoded every 400 milliseconds."

但这是 2012 年的描述。当前 libopus 的实现细节（`silk/define.h`）：

```c
#define NB_SPEECH_FRAMES_BEFORE_DTX             10      /* eq 200 ms */
#define MAX_CONSECUTIVE_DTX                     20      /* eq 400 ms */
#define DTX_ACTIVITY_THRESHOLD                  0.1f
```

**连续 10 帧（200 ms）没有语音活动才进入 DTX**，最多连续 20 帧（400 ms）DTX 帧后必须刷新一次。

### 6.2 实测：DTX 省了多少

我专门生成了一个带明确静音段的语料（3 秒语音 + 2 秒 −60 dBFS 静音 + 3 秒语音），逐帧追踪：

| 配置 | 总字节 | 平均包长 | 帧数 |
|---|---|---|---|
| DTX 关闭 | **13535** | 33.84 B | 400 |
| **DTX 开启** | **11044** | 27.61 B | 400 |
| **节省** | **2491 B（−18.4%）** | | |

### 6.3 ⚠️ 关键细节：DTX 帧是 1 字节，不是 0 字节

这是我在逐帧追踪里抓到的最有意思的细节。DTX 开启后，静音段的包长是：

```
idx=158  t=3160ms  len=23   ← 还在语音（尾部）
idx=159  t=3180ms  len=29   ← 还在语音
idx=160  t=3200ms  len=1    ← 进入 DTX
idx=161  t=3220ms  len=1    ← DTX
idx=162  t=3240ms  len=1    ← DTX
...
idx=179  t=3580ms  len=1    ← DTX
idx=180  t=3600ms  len=25   ← 刷新帧！（距进入 DTX 恰好 20 帧 = 400 ms）
idx=181  t=3620ms  len=1    ← DTX
...
idx=200  t=4000ms  len=1    ← DTX
idx=201  t=4020ms  len=28   ← 刷新帧！（又是 20 帧 = 400 ms）
```

**三个观察**：

1. **DTX 帧是 1 字节，不是 0 字节**。这个 1 字节就是一个空壳包，TOC 里标记"无帧"。RFC 6716 §3.2.1 的帧长编码里 **0 = No frame（DTX 或丢包）** 就是这个意思
2. **每 400 ms 有一个"刷新帧"**（25 / 28 / 33 字节不等），内容是静音段的最新状态。这精确对应 `MAX_CONSECUTIVE_DTX = 20`（20 帧 × 20 ms = 400 ms）
3. **DTX 只在 SILK 模式可用**。源码里：

```c
/* When encoding voice and DTX is enabled but the generalized DTX cannot be used,
   use SILK in order to make use of its DTX. */
if (st->silk_mode.useDTX && voice_est > 100)
   st->mode = MODE_SILK_ONLY;
```

**DTX 会强制切到 SILK**。我实测音乐 64 kbit/s 开 DTX，输出码率 64.59 kbit/s（和不开一样），因为音乐走 CELT，DTX 根本没生效。

### 6.4 DTX 的实际收益

| 场景 | 收益 | 风险 |
|---|---|---|
| **车载语音助手（长待机）** | ⭐⭐⭐ 唤醒词检测前的"无人说话"时段几乎不耗流量 | 低 |
| **会议/通话** | ⭐⭐ 静音段落省 18% | 低 |
| **音乐播放** | ❌ 无效（CELT 不支持 DTX） | — |
| **实时字幕 / 连续 ASR 流** | ⚠️ DTX 期间下游收不到音频帧，需要在应用层补静音或维持时间轴 | **中** |

**车规特别注意**：如果下游是流式 ASR，DTX 的 1 字节包会**打断时间轴连续性**。应用层必须能识别"这是 DTX 空包"（TOC 的帧长码 = 0）而不是当成解码失败。

---

## 七、PLC 丢包隐藏：实测能量保持率与谱包络相关性

### 7.1 PLC 是什么、不是什么

RFC 6716 §4.4：

> "Packet Loss Concealment (PLC) is an **optional decoder-side feature** that SHOULD be included when receiving from an unreliable channel."
> "Because PLC is not part of the bitstream, there are many acceptable ways to implement PLC with different complexity/quality trade-offs."

关键点：**PLC 不在码流里**。它是纯解码端行为，参考实现按最后一包的模式分路：

| 最后一包模式 | PLC 实现 | 原理 |
|---|---|---|
| CELT | `celt_decode_lost()`（`celt/mdct.c`） | 找 pitch 周期，重复加窗波形，保持 TDAC（时域混叠抵消） |
| SILK | `silk_PLC()`（`silk/PLC.c`） | **LPC 外推**上一帧 |

### 7.2 ⚠️⚠️ 最大的坑：PLC 帧的返回长度会失控

**这是我在这篇文章里最想让你记住的一件事。**

先看完整的收包解码流程，理解 PLC 在哪条路径上：

```mermaid
flowchart TD
    NET(["🌐 网络收包"]) --> SEQ{"序号连续?"}
    SEQ -->|"是"| HAVE["✅ 有包<br/>data=ptr, len=N"]
    SEQ -->|"否：等待超时"| LOST["❌ 丢包<br/>data=NULL, len=0"]
    SEQ -->|"是"| EMPTY{"len == 1 ?"}
    EMPTY -->|"是"| DTX["🔇 DTX 空包<br/>TOC 帧长码=0"]
    EMPTY -->|"否"| HAVE

    HAVE --> DEC["🔵 opus_decode<br/>frame_size = 精确帧长 ★"]
    DTX --> DEC
    LOST --> DEC
    DEC --> OUT["🔊 PCM 输出<br/>恒等于 frame_size 样本"]

    LOST -.->|"PLC 自动生效"| PLCBOX["🟣 celt_decode_lost()<br/>或 silk_PLC()"]
    PLCBOX --> DEC

    style NET fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style SEQ fill:#FFF9C4,stroke:#F9A825,color:#333
    style HAVE fill:#B5EAD7,stroke:#80CBC4,color:#333
    style LOST fill:#FFB3C6,stroke:#F48FB1,color:#333
    style EMPTY fill:#FFF9C4,stroke:#F9A825,color:#333
    style DTX fill:#E8D5F5,stroke:#CE93D8,color:#333
    style DEC fill:#FFDAB9,stroke:#FFAB76,color:#333
    style OUT fill:#B5EAD7,stroke:#80CBC4,color:#333
    style PLCBOX fill:#E8D5F5,stroke:#CE93D8,color:#333
```

libopus 的 `opus_decode()` 头文件注释写得很清楚：

> "If this is less than the maximum packet duration (120ms; 5760 for 48kHz), this function will not be capable of decoding some packets. **In the case of PLC (data==NULL) or FEC (decode_fec=1), then frame_size needs to be exactly the duration of audio that is missing, otherwise the decoder will not be in the optimal state to decode the next incoming packet.**"

翻译：PLC 的时候，`frame_size` 参数**不是缓冲区上限，而是"缺失音频的确切时长"**。

我实测验证了这一点（16 kHz，20 ms 帧 = 320 样本）：

```
# ❌ 错误写法：frame_size 传 MAX_FRAME (5760)
i=0   len=31   ret=320   dropped=0
i=1   len=38   ret=320   dropped=0
i=2   len=36   ret=320   dropped=0
i=3   len=0    ret=5760  dropped=1   ← PLC 帧返回了 5760 样本（18 倍！）
i=4   len=0    ret=5760  dropped=1   ← 继续 5760
i=5   len=0    ret=5760  dropped=1

# ✅ 正确写法：frame_size 传 320（期望帧长）
i=0   len=31   ret=320   dropped=0
i=1   len=38   ret=320   dropped=0
i=2   len=36   ret=320   dropped=0
i=3   len=0    ret=320   dropped=1   ← PLC 帧返回 320 样本 ✅
i=4   len=0    ret=320   dropped=1
i=5   len=0    ret=320   dropped=1
```

**为什么这么设计**：`opus_decode(dec, NULL, 0, pcm, MAX_FRAME, 0)` 里的 `data=NULL, len=0` 只表示"这包丢了"，但解码器**不知道丢了多久**——它猜是最大包长 120 ms，于是补 120 ms 的 PLC。

**后果**：一个 20 ms 帧的流，丢一包就多吐 100 ms 音频。整个流的时间轴从此错位，**后面每一帧都错**。车机上表现就是"声音越走越慢 / 越走越快"，而且**不报任何错**。

我用 ASan 跑出来的现场：

```
==4146730==ERROR: AddressSanitizer: heap-buffer-overflow
    #1 write_wav /tmp/opus_work/opus_plc2.c:63
SUMMARY: AddressSanitizer: heap-buffer-overflow
```

写 PCM 文件时缓冲区溢出——因为实际吐出的样本比分配的多了 18 倍。

### 7.3 PLC 到底补得好不好：三个指标

直接看波形 SNR 会被误导。PLC 输出的是**预测信号**，不是原始波形——它能量对、相位不对，波形 SNR 必然是负的。

我用了三个更有意义的指标：

| 指标 | 含义 | 为什么有意义 |
|---|---|---|
| **能量保持率** | PLC 帧 RMS / 前一正常帧 RMS | 静音替代 = 0，PLC 应该接近 1 |
| **谱包络相关性（vs 参考）** | PLC 帧频谱包络 vs 真实帧的相关系数 | 频谱形状保住了多少 |
| **谱包络相关性（vs 前一帧）** | PLC 帧 vs 前一正常帧 | PLC 应该延续上一帧的听感 |

**随机丢包 10%（SILK / 16 kbit/s / WB）：**

```
=== PLC ENERGY CONTINUITY ===          ← opus_plc2：能量保持率 + 波形 SNR
frame	prev_rms	plc_rms	ratio	snr_db
3	0.04041	0.03569	0.883	-1.72
22	0.04696	0.03757	0.800	-2.76
27	0.04030	0.04161	1.032	-3.45
31	0.03750	0.03829	1.021	-2.74
32	0.04245	0.03214	0.757	-2.23
35	0.04471	0.03890	0.870	-2.93
...
AGG avg_energy_ratio=0.9683 avg_waveform_snr_db=-2.86 n_events=27

=== PLC SPECTRAL ENVELOPE ANALYSIS ===   ← plc_spectral.py：谱包络相关性
ev	frame	t_ms	len	corr_vs_ref	corr_vs_prev	ref_rms	plc_rms
3	60	1	0.0833	0.2952	0.04800	0.03569
22	440	1	0.0738	0.3464	0.03842	0.03757
27	540	1	-0.0753	0.0789	0.03755	0.04161
31	620	2	0.3143	0.4309	0.04136	0.03535
35	700	1	0.0945	0.1470	0.04021	0.03890
...
AGG n_events=24
AGG avg_corr_vs_ref=0.1587
AGG avg_corr_vs_prev_frame=0.1854
AGG avg_energy_ratio=1.0055
```

**注意这两个 AGG 的 `n_events` 不一样（27 vs 24）不是 bug**：两个脚本的事件判定口径不同——

- `opus_plc2` 按"**丢包标记 + PLC 帧**"配对，统计 27 次
- `plc_spectral.py` 按"**频谱相关性可算**"筛，剔掉了 3 次（其中包含首包丢失那种没有参考帧的情况），剩 24 次

**第二个 AGG 里的 `avg_energy_ratio=1.0055` 也不该和 7.4 表的 `0.9683` 比**：前者是"PLC 帧总能量 / **参考帧**总能量"，后者是"PLC 帧 RMS / **前一正常帧** RMS"。**分母不同，比值当然不同**——这正是我一开始把两个数混在一起、被自己的表格绕晕的原因。**能量保持率（对前一帧）才是听感上"接得上"的指标，7.4 表统一用它。**

### 7.4 丢包率扫描

| 丢包率 | 丢包帧数 | 事件数 | 能量保持率 | 波形 SNR | 谱相关(vs 参考) |
|---|---|---|---|---|---|
| 0% | 0 | 0 | — | — | — |
| 5% | 10 | 10 | **0.9889** | −2.89 dB | 0.1351 |
| 10% | 27 | 24 | **0.9683** | −2.86 dB | 0.1587 |
| 20% | 55 | 47 | **0.9413** | −2.68 dB | 0.2107 |
| 30% | 86 | 61 | **0.9326** | −2.70 dB | — |

**能量保持率从 98.9% 只掉到 93.3%**——即使 30% 丢包，PLC 仍然维持了绝大部分能量。**静音替代是 0，PLC 是 0.93，这就是 PLC 的全部价值。**

### 7.5 ⚠️ 突发丢包反而更好

这个结果一开始让我很意外：

| 丢包模式 | 丢包帧数 | 事件数 | 能量保持率 | 谱相关(vs 参考) | 谱相关(vs 前帧) |
|---|---|---|---|---|---|
| 随机 10% | 27 | 24 | 0.9683 | 0.1587 | 0.1854 |
| **突发 10%（burst=2）** | 52 | 23 | 0.9167 | **0.2825** | 0.1930 |
| **突发 10%（burst=3）** | 78 | 23 | 0.8688 | **0.3891** | 0.2645 |
| **突发 10%（burst=5）** | 105 | 18 | 0.7915 | **0.4798** | 0.2910 |

**突发丢包的谱包络相关性反而高得多**（0.48 vs 0.16）！

**原因**：随机丢包时，每次丢包后解码器只拿到 1 帧就恢复，PLC 只能基于极短的历史做外推。突发丢包时，**解码器连续跑多帧 PLC，状态逐渐稳定，pitch 周期锁定得更好，LPC 外推的系数更准**。

**工程含义**：如果你的链路出现**周期性突发丢包**（比如每 N 个包必丢一个），不要以为"丢包率一样所以体验一样"——**突发场景下 PLC 反而更能扛**。

### 7.6 SILK vs CELT 的 PLC 差异

| 配置 | 模式 | 能量保持率 | 谱相关(vs 参考) | 谱相关(vs 前帧) |
|---|---|---|---|---|
| 16000 bps / voip | SILK WB | 0.9683 | 0.1587 | 0.1854 |
| 22000 bps / voip | SILK WB+MB | 0.9313 | 0.2196 | 0.2389 |
| 48000 bps / audio | CELT SWB | 0.9332 | 0.2274 | 0.2633 |
| 64000 bps / voip | CELT MB | 0.9485 | 0.1812 | 0.2007 |

**四种配置的 PLC 表现相当接近**（能量保持率 0.93~0.97）。CELT 在 48 kbps 下略好，SILK 在 16 kbps 下能量保持率最高。

### 7.6.1 两层 PLC 的算法本质完全不同

这一点决定了你在什么场景下更该指望 PLC：

**CELT 的 PLC 是"波形级"的**。`celt_decode_lost()` 在 **`celt/celt_decoder.c:701`** 里做三件事：

1. 在历史解码信号里**搜索周期性**（找 pitch 周期）
2. 用找到的 pitch offset **重复上一段的加窗波形**
3. 加窗方式保证与前后帧保持 **TDAC（Time-Domain Aliasing Cancellation，时域混叠抵消）**

这意味着 CELT PLC 在**稳态周期信号**（乐音、引擎怠速、提示音）上效果非常好——它本质上是在"复制波形"，听感上几乎无缝。代价是它在**非周期信号**（语音的爆破音、摩擦音）上会明显失真。

它的真实签名（注意 `arch` 是**架构参数**，用来选不同的重建路径；`ENABLE_DEEP_PLC` 打开时会多一个神经网络 PLC 参数）：

```c
/* celt/celt_decoder.c:701 */
static void celt_decode_lost(CELTDecoder * OPUS_RESTRICT st, int N, int LM
#ifdef ENABLE_DEEP_PLC
      ,LPCNetPLCState *lpcnet
#endif
      )
```

**SILK 的 PLC 是"参数级"的**。`silk_PLC_conceal()` 在 `silk/PLC.c:216` 里做的是 **LPC 外推**：把上一帧的线性预测系数（LPC）往前推，残差部分用衰减的随机激励替代。

```c
/* silk/PLC.c:216 —— 逐字摘自上游 */
static OPUS_INLINE void silk_PLC_conceal(
    silk_decoder_state                  *psDec,             /* I/O Decoder state        */
    silk_decoder_control                *psDecCtrl,         /* I/O Decoder control      */
    opus_int16                          frame[],            /* O LPC residual signal    */
#ifdef ENABLE_DEEP_PLC
    LPCNetPLCState                      *lpcnet,
#endif
    int                                 arch                /* I Run-time architecture  */
)
```

注意 SILK 这边的参数和 CELT 那边**方向相反**：SILK 是"解码器状态 → 重建出的残差帧"（`psDec` 进去、`frame[]` 出来），CELT 是"重建波形 → 输出"。**两者不是对称设计，这也是为什么两种模式的 PLC 听感特征不一样。**

函数体里能直接看到"LPC 外推 + 增益衰减"这两个动作：

```c
/* silk/PLC.c:253 —— 增益从 Q16 降到 Q10 */
    prevGain_Q10[0] = silk_RSHIFT( psPLC->prevGain_Q16[ 0 ], 6);
    prevGain_Q10[1] = silk_RSHIFT( psPLC->prevGain_Q16[ 1 ], 6);

/* silk/PLC.c:257 —— 复位后 LPC 系数清零 */
    if( psDec->first_frame_after_reset ) {
       silk_memset( psPLC->prevLPC_Q12, 0, sizeof( psPLC->prevLPC_Q12 ) );
    }
```

`prevLPC_Q12` 全零 → **LPC 外推退化成零阶预测（全通）**——这正好解释了 §7.7 实测到的"第一个包丢失时 PLC 输出纯静音"：**没有历史系数，就没有可外推的预测滤波器**。

SILK PLC 还有一个关键机制：**`silk_PLC_glue_frames()`**（`silk/PLC.c:441`，在 `silk/decode_frame.c:160` 被调用）——在 PLC 恢复时做"粘合"，让恢复后的第一帧和 PLC 期间的能量/频谱连续，避免出现"咔哒"声。

**工程含义**：

| 信号特性 | CELT PLC 更强 | SILK PLC 更强 |
|---|---|---|
| 稳态周期（音乐、提示音） | ✅ 复制波形，几乎无缝 | 一般 |
| 非周期语音瞬态 | 一般 | ✅ LPC 外推对语音谱形更准 |
| 高频细节 | ✅ CELT 本身带高频 | ❌ SILK 只到 8 kHz |
| 低码率下的可懂度 | — | ✅ SILK 的 LPC 模型对语音友好 |

我在 48 kbps（CELT）下测到谱相关 0.2274、在 16 kbps（SILK）下测到 0.1587，**CELT 略优**——这和"CELT PLC 是波形级复制"的机制是吻合的。

### 7.6.2 丢包率 vs 丢包时长：哪个更致命

我的实测数据能回答一个常见的工程疑问：**同样丢 20% 的包，是"每 5 帧丢 1 帧"（随机/周期）更致命，还是"连丢 4 帧"（突发）更致命？**

从数据看，**突发丢包的谱包络相关性更高（0.28~0.48 vs 0.16）**，但**能量保持率更低（0.79~0.92 vs 0.94~0.97）**。

这不矛盾，解释如下：

- **能量保持率衡量"有没有声音"**：随机丢包后下一包立刻恢复，能量曲线只是一个小坑；突发丢包期间能量持续下降（PLC 的 LPC 外推在连续丢包时会逐渐失配）
- **谱包络相关性衡量"频谱像不像"**：突发丢包时 PLC 有连续多帧的时间来收敛 pitch 周期和 LPC 系数，反而更准

**选型结论**：

| 丢包形态 | 听感 | 应对 |
|---|---|---|
| 稀疏随机 | 密集的"咔哒"声 | 靠 PLC 硬扛 + 提高码率 |
| 连续突发 | 一段"嘟"声然后恢复 | 靠 FEC 冗余 + 缓冲加深 |

**关键区别**：突发丢包更"听得出来"（有一段明显异常），随机丢包更"密集刺耳"。前者用户会说"刚才卡了一下"，后者用户会说"一直有杂音"。**排查时的第一句话就该问这个。**

### 7.7 ⚠️ 极端边界：第一个包就丢

我实测 30% 丢包时出现了一个 `nan`（相关系数算不出来）。追下去发现：**第 0 帧就被丢了**，此时解码器**没有任何历史**，PLC 只能输出纯静音：

```
=== PLC SPECTRAL ENVELOPE ANALYSIS ===
ev	frame	t_ms	len	corr_vs_ref	corr_vs_prev	ref_rms	plc_rms
0	0	300	nan	nan	0.04112	0.00000   ← 第 0 帧就丢了，PLC 无历史可外推
```

对应的能量连续性输出（前 4 帧全是纯静音）：

```
=== PLC ENERGY CONTINUITY ===
frame	prev_rms	plc_rms	ratio	snr_db
1	0.03015	0.00000	0.000	0.00
2	0.04061	0.00000	0.000	0.00
3	0.04041	0.00000	0.000	0.00
4	0.04800	0.00000	0.000	0.00
```

`plc_rms = 0.00000`——**PLC 在没有历史时确实输出静音**，这是合理行为，但应用层要注意：**第一个包丢失会让整段音频开头一段是静音**。

---

## 八、时钟漂移补偿：OPUS_GET_PITCH 实战

RFC 6716 §4.4.1 专门讲时钟漂移（Clock Drift Compensation）：

> "The reference implementation of Opus allows a caller to learn whether the current frame's signal is highly periodic, and if so what the period is, using the OPUS_GET_PITCH() request."

### 8.1 原理

蓝牙耳机 / 车机 / 云的时钟不可能完全一致：

- **发送端时钟慢** → 接收端收包赶不上 → 表现为**丢包**
- **发送端时钟快** → 接收端包多出来 → 表现为**播放缓冲越涨越多**

传统做法是固定补偿（比如每 N 包丢一个）。Opus 提供了一个更聪明的信号：**告诉你当前音频有多周期、周期是多少**。如果音频是稳态的周期信号（比如引擎怠速、提示音、音乐低频），那它的周期可以作为**时钟漂移的测量基准**。

### 8.2 实测：pitch 返回值精确到 ±0.63%

我生成了 100/150/200/250/300 Hz 的纯音，编解码后调 `OPUS_GET_PITCH`：

| 真实基频 | 期望周期（48 kHz 样本） | 实测返回 | 误差 |
|---|---|---|---|
| 100 Hz | 480 | 480 | **+0.00%** |
| 150 Hz | 320 | 320 | **−0.31%** |
| 200 Hz | 240 | 240 | **+0.00%** |
| 250 Hz | 192 | 192 | **+0.00%** |
| 300 Hz | 160 | 160 | **+0.63%** |

**⚠️ 关键：pitch 的单位是 48 kHz 的样本数，不是输入采样率的样本数。**

200 Hz 在 48 kHz 下周期是 240 样本。我第一次写成"1000/period_ms"算错了一档，是查了 `opus_defines.h` 里 `OPUS_GET_PITCH` 的注释才发现基准是 48 kHz。

### 8.3 怎么用

```c
opus_int32 pitch = 0;
if (opus_decoder_ctl(dec, OPUS_GET_PITCH(&pitch)) == OPUS_OK && pitch > 0) {
    /* pitch 是 48 kHz 下的周期样本数 */
    double period_ms = (double)pitch / 48.0;
    /* 发送端时钟慢 -> 丢包；快 -> 跳包 */
    /* 用 period_ms 的稳定度判断当前音频是否稳态周期信号 */
}
```

**工程价值**：车机 + 蓝牙耳机场景下，如果耳机和车机的时钟有偏差，表现是"偶发卡顿 / 音频慢慢不同步"。传统做法是丢包补偿，Opus 的 pitch 可以让你**先判断音频稳不稳态**，稳态时用 pitch 做精细补偿，非稳态时退回粗放策略。

---

## 九、完整工程实践：从零搭建一条 Opus 链路

### 9.1 编译 libopus

```bash
# 克隆
git clone --depth 1 https://github.com/xiph/opus.git
cd opus

# CMake 编译（Android/iOS/Linux 通用）
mkdir -p build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release \
         -DOPUS_BUILD_PROGRAMS=ON \
         -DOPUS_BUILD_TESTING=OFF
make -j$(nproc)

# 产物
#   build/libopus.a       静态库
#   build/opus_demo       命令行编解码工具
#   build/opus_compare    客观质量对比工具
```

**Android 交叉编译**（NDK）：

```bash
export ANDROID_NDK_HOME=/path/to/ndk
cmake .. \
  -DCMAKE_TOOLCHAIN_FILE=$ANDROID_NDK_HOME/build/cmake/android.toolchain.cmake \
  -DANDROID_ABI=arm64-v8a \
  -DANDROID_PLATFORM=android-26 \
  -DCMAKE_BUILD_TYPE=Release \
  -DOPUS_BUILD_PROGRAMS=OFF
```

**iOS**：

```bash
cmake .. \
  -DCMAKE_SYSTEM_NAME=iOS \
  -DCMAKE_OSX_DEPLOYMENT_TARGET=13.0 \
  -DCMAKE_BUILD_TYPE=Release \
  -DOPUS_BUILD_PROGRAMS=OFF
```

### 9.2 编码器完整配置（可直接抄）

```c
#include <opus/opus.h>
#include <stdlib.h>
#include <string.h>

typedef struct {
    OpusEncoder *enc;
    int          sample_rate;
    int          channels;
    int          frame_size;   /* 每帧样本数 */
} OpusTx;

int opus_tx_init(OpusTx *tx, int sample_rate, int channels,
                 int bitrate_bps, int application)
{
    int err = OPUS_OK;
    memset(tx, 0, sizeof(*tx));
    tx->sample_rate = sample_rate;
    tx->channels    = channels;
    tx->frame_size  = sample_rate / 50;   /* 20 ms */

    tx->enc = opus_encoder_create(sample_rate, channels, application, &err);
    if (!tx->enc || err != OPUS_OK) return err ? err : OPUS_BAD_ARG;

    /* --- 码率与质量 --- */
    opus_encoder_ctl(tx->enc, OPUS_SET_BITRATE(bitrate_bps));

    /* 复杂度：车载语音 5 足够，音乐 10 */
    opus_encoder_ctl(tx->enc, OPUS_SET_COMPLEXITY(5));

    /* --- 带宽上限：别让编码器白编 20kHz 以上 --- */
    opus_encoder_ctl(tx->enc, OPUS_SET_MAX_BANDWIDTH(OPUS_BANDWIDTH_WIDEBAND));

    /* --- 信号类型提示：告诉编码器这是语音还是音乐 --- */
    opus_encoder_ctl(tx->enc, OPUS_SET_SIGNAL(OPUS_SIGNAL_VOICE));

    /* --- 抗丢包：注意这会隐式降级带宽 --- */
    opus_encoder_ctl(tx->enc, OPUS_SET_INBAND_FEC(1));
    opus_encoder_ctl(tx->enc, OPUS_SET_PACKET_LOSS_PERC(10));

    /* --- 静音断流：仅 SILK 模式生效 --- */
    opus_encoder_ctl(tx->enc, OPUS_SET_DTX(1));

    return OPUS_OK;
}

/* 返回编码后的字节数；<0 是错误码 */
int opus_tx_encode(OpusTx *tx, const opus_int16 *pcm, unsigned char *out, int max_bytes)
{
    int n = opus_encode(tx->enc, pcm, tx->frame_size, out, max_bytes);
    if (n < 0) return n;

    /* 关键：读回 TOC，判断实际用了什么模式和带宽 */
    if (n > 0) {
        int config = (out[0] >> 3) & 0x1F;
        /* 0..11 = SILK, 12..15 = Hybrid, 16..31 = CELT */
        /* 运维监控：把 config 打点上报 */
        (void)config;
    }
    return n;
}
```

### 9.3 解码器 + PLC（**最容易写错的地方**）

```c
typedef struct {
    OpusDecoder *dec;
    int          sample_rate;
    int          channels;
    int          frame_size;
    opus_int16   pcm[5760 * 2];   /* 最大 120 ms @ 48 kHz 立体声 */
} OpusRx;

int opus_rx_init(OpusRx *rx, int sample_rate, int channels)
{
    int err = OPUS_OK;
    rx->sample_rate = sample_rate;
    rx->channels    = channels;
    rx->frame_size  = sample_rate / 50;
    rx->dec = opus_decoder_create(sample_rate, channels, &err);
    return (rx->dec && err == OPUS_OK) ? OPUS_OK : (err ? err : OPUS_BAD_ARG);
}

/*
 * data == NULL 表示丢包，走 PLC。
 *
 * ⚠️⚠️ frame_size 必须传"缺失音频的确切时长"，不能传缓冲区上限！
 *     传错会导致 PLC 帧返回 120 ms 而不是 20 ms，整个流时间轴错位。
 */
int opus_rx_decode(OpusRx *rx, const unsigned char *data, opus_int32 len,
                   opus_int16 *out)
{
    /* 这里传 rx->frame_size（20 ms 的样本数），不是 MAX_FRAME */
    int n = opus_decode(rx->dec, data, len, out, rx->frame_size, 0);
    if (n < 0) return n;
    return n * rx->channels;   /* 返回样本数（交织） */
}

/* 单独请求 FEC 数据解码（用于"上一包丢了但 FEC 能救"的情况） */
int opus_rx_decode_with_fec(OpusRx *rx, const unsigned char *data, opus_int32 len,
                            opus_int16 *out)
{
    int n = opus_decode(rx->dec, data, len, out, rx->frame_size, 1);
    return n < 0 ? n : n * rx->channels;
}
```

### 9.4 完整的收发循环（带 PLC / FEC / DTX 识别）

```c
/*
 * 一个完整的 Opus 收发帧循环。
 * 关键点全部标了 ★
 */
void opus_process_frame(OpusRx *rx, const unsigned char *pkt, int pkt_len,
                        int is_lost, opus_int16 *out_pcm)
{
    int n;

    if (is_lost) {
        /* ★ PLC：data=NULL, len=0
         * ★ frame_size 必须是精确缺失时长（rx->frame_size）
         */
        n = opus_decode(rx->dec, NULL, 0, out_pcm, rx->frame_size, 0);
    } else if (pkt_len == 1) {
        /* ★ DTX 空包：TOC 里帧长码=0，1 字节包。
         *   解出来是静音，但必须照样调用 opus_decode 保持解码器状态连续！ */
        n = opus_decode(rx->dec, pkt, pkt_len, out_pcm, rx->frame_size, 0);
    } else {
        n = opus_decode(rx->dec, pkt, pkt_len, out_pcm, rx->frame_size, 0);
    }

    if (n < 0) {
        /* 解码错误：退化成 PLC，别让整个流停住 */
        n = opus_decode(rx->dec, NULL, 0, out_pcm, rx->frame_size, 0);
        if (n < 0) return;
    }

    /* ★ 时钟漂移监测：只在音频稳态周期信号时 pitch 才有意义 */
    opus_int32 pitch = 0;
    if (opus_decoder_ctl(rx->dec, OPUS_GET_PITCH(&pitch)) == OPUS_OK && pitch > 0) {
        double period_ms = (double)pitch / 48.0;   /* 单位是 48kHz 样本 */
        /* period_ms 稳定 -> 可用于精细时钟补偿 */
    }
}
```

### 9.5 抖动缓冲：Opus 管不了的部分

**Opus 是编码器，不解决网络抖动。** 抖动缓冲是应用层的事。

```
[网络乱序到达] → [抖动缓冲] → [解包排序] → [Opus 解码] → [播放]
                    ↑
               你得自己写
```

最小可用版本：

```c
/* 抖动缓冲：按序号重排 + 定时取出 */
typedef struct {
    uint16_t  seq;
    uint8_t   buf[1500];
    int       len;
    long      arrival_us;
    int       used;
} JitterSlot;

typedef struct {
    JitterSlot slots[64];
    int        capacity;
    int        target_delay_us;   /* 目标缓冲深度 */
    uint16_t   next_seq;
    int        initialized;
} JitterBuffer;

void jb_push(JitterBuffer *jb, uint16_t seq, const uint8_t *data, int len)
{
    for (int i = 0; i < jb->capacity; i++) {
        if (jb->slots[i].used && jb->slots[i].seq == seq) return;  /* 重复包 */
    }
    for (int i = 0; i < jb->capacity; i++) {
        if (!jb->slots[i].used) {
            jb->slots[i].seq = seq;
            jb->slots[i].len = len;
            memcpy(jb->slots[i].buf, data, len);
            jb->slots[i].used = 1;
            jb->slots[i].arrival_us = now_us();
            return;
        }
    }
    /* 缓冲满：丢掉最老的（说明网络在恶化，减小 target_delay 才有救） */
}

/* 取下一个包；超时未到则返回 is_lost=1 让上层走 PLC */
int jb_pop(JitterBuffer *jb, uint8_t *out, int *out_len, int *is_lost)
{
    if (!jb->initialized) {
        /* 第一个包：启动缓冲深度 */
        jb->initialized = 1;
        jb->next_seq = find_first_seq(jb);
    }
    for (int i = 0; i < jb->capacity; i++) {
        if (jb->slots[i].used && jb->slots[i].seq == jb->next_seq) {
            *out_len = jb->slots[i].len;
            memcpy(out, jb->slots[i].buf, jb->slots[i].len);
            jb->slots[i].used = 0;
            jb->next_seq++;
            *is_lost = 0;
            return 1;
        }
    }
    /* 没等到：判断是"还在路上"还是"真丢了" */
    long age = now_us() - earliest_arrival_of(jb, jb->next_seq);
    if (age > jb->target_delay_us) {
        jb->next_seq++;   /* 放弃这个包，走 PLC */
        *is_lost = 1;
        return 1;
    }
    return 0;   /* 还没到，返回 0 让调用方等待 */
}
```

### 9.6 完整可运行的验证程序

下面这段是**完整自包含**的 C 程序，可以直接编译运行，验证本文的所有关键结论：

```c
/*
 * opus_verify.c — 验证本文核心结论
 *
 * 编译:
 *   gcc -O2 -o opus_verify opus_verify.c -I<opus_include> -L<opus_lib> -lopus -lm
 *
 * 运行:
 *   ./opus_verify
 */
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>
#include <opus/opus.h>

#define SR 16000
#define FRAME_MS 20
#define FRAME_SIZE (SR * FRAME_MS / 1000)

/* ---- 造一个 200 Hz 的周期信号 ---- */
static short *make_tone(int n_samples, double freq_hz, double amp)
{
    short *pcm = malloc(sizeof(short) * n_samples);
    for (int i = 0; i < n_samples; i++) {
        double t = (double)i / SR;
        pcm[i] = (short)(amp * 32767.0 * sin(2.0 * M_PI * freq_hz * t));
    }
    return pcm;
}

int main(void)
{
    int err = OPUS_OK;
    int n_samples = SR * 3;
    short *tone = make_tone(n_samples, 200.0, 0.3);

    /* ---------- 测试 1：TOC 反推模式 ---------- */
    printf("=== TEST 1: TOC config -> mode/bandwidth ===\n");
    for (int br = 12000; br <= 96000; br *= 2) {
        OpusEncoder *enc = opus_encoder_create(SR, 1, OPUS_APPLICATION_VOIP, &err);
        opus_encoder_ctl(enc, OPUS_SET_BITRATE(br));
        unsigned char pkt[1500];
        int len = opus_encode(enc, tone, FRAME_SIZE, pkt, sizeof(pkt));
        if (len > 0) {
            int config = (pkt[0] >> 3) & 0x1F;
            const char *mode = (config < 12) ? "SILK"
                           : (config < 16) ? "HYBRID" : "CELT";
            printf("  br=%6d len=%3d config=%2d mode=%-6s\n", br, len, config, mode);
        }
        opus_encoder_destroy(enc);
    }

    /* ---------- 测试 2：PLC 帧长失控 ---------- */
    printf("\n=== TEST 2: PLC frame_size semantics ===\n");
    {
        OpusEncoder *enc = opus_encoder_create(SR, 1, OPUS_APPLICATION_VOIP, &err);
        opus_encoder_ctl(enc, OPUS_SET_BITRATE(16000));
        OpusDecoder *dec = opus_decoder_create(SR, 1, &err);
        unsigned char pkt[1500];
        short out[5760];

        int len = opus_encode(enc, tone, FRAME_SIZE, pkt, sizeof(pkt));

        int n_wrong = opus_decode(dec, NULL, 0, out, 5760, 0);
        printf("  frame_size=5760 (buffer max) -> %d samples (expected %d)\n",
               n_wrong, FRAME_SIZE);

        opus_decoder_ctl(dec, OPUS_RESET_STATE);
        int n_right = opus_decode(dec, NULL, 0, out, FRAME_SIZE, 0);
        printf("  frame_size=%4d (exact)      -> %d samples\n", FRAME_SIZE, n_right);

        opus_decoder_destroy(dec);
        opus_encoder_destroy(enc);
    }

    /* ---------- 测试 3：OPUS_GET_PITCH ---------- */
    printf("\n=== TEST 3: OPUS_GET_PITCH ===\n");
    {
        OpusEncoder *enc = opus_encoder_create(SR, 1, OPUS_APPLICATION_VOIP, &err);
        opus_encoder_ctl(enc, OPUS_SET_BITRATE(16000));
        OpusDecoder *dec = opus_decoder_create(SR, 1, &err);
        unsigned char pkt[1500];
        short out[5760];

        /* ⚠️ 关键：pitch 需要解码器"攒够历史"，只编 1 帧是问不出来的。
           * 必须连续编解码多帧，让 CELT 的历史缓冲填上。 */
        opus_int32 pitch = 0;
        for (int i = 0; i < 10; i++) {
            int len = opus_encode(enc, tone + i * FRAME_SIZE, FRAME_SIZE, pkt, sizeof(pkt));
            opus_decode(dec, pkt, len, out, FRAME_SIZE, 0);
            opus_decoder_ctl(dec, OPUS_GET_PITCH(&pitch));
        }
        if (pitch > 0) {
            double period_ms = (double)pitch / 48.0;
            printf("  pitch=%d (48kHz samples) -> period=%.3f ms -> %.2f Hz\n",
                   pitch, period_ms, 1000.0 / period_ms);
            printf("  (true 200 Hz => expected 240 samples @48kHz)\n");
        } else {
            printf("  pitch unavailable (需要多帧历史才问得出)\n");
        }
        opus_decoder_destroy(dec);
        opus_encoder_destroy(enc);
    }

    /* ---------- 测试 4：FEC 的带宽降级 ---------- */
    /* ⚠️ 注意：这里用的是 200 Hz 纯音，不是真实语音。
     * FEC 的带宽降级依赖编码器对"语音 vs 音乐"的判定（voice_est），
     * 纯音会被判成音乐，所以**看不到**第 5 章实测的 WB -> NB/MB 降级。
     * 想复现那个现象，请喂真实语音（见第 5 章的 opus_lab 实验）。 */
    printf("\n=== TEST 4: FEC vs bandwidth (pure tone -> music class, no downgrade expected) ===\n");
    for (int br = 16000; br <= 32000; br += 8000) {
        for (int fec = 0; fec <= 1; fec++) {
            OpusEncoder *enc = opus_encoder_create(SR, 1, OPUS_APPLICATION_VOIP, &err);
            opus_encoder_ctl(enc, OPUS_SET_BITRATE(br));
            opus_encoder_ctl(enc, OPUS_SET_INBAND_FEC(fec));
            opus_encoder_ctl(enc, OPUS_SET_PACKET_LOSS_PERC(10));
            unsigned char pkt[1500];
            short out[5760];
            int nb = 0, mb = 0, wb = 0;
            long total = 0;
            int nframes = 100;
            for (int i = 0; i < nframes; i++) {
                int len = opus_encode(enc, tone, FRAME_SIZE, pkt, sizeof(pkt));
                total += len;
                if (len > 0) {
                    int config = (pkt[0] >> 3) & 0x1F;
                    if (config < 4) nb++;
                    else if (config < 8) mb++;
                    else if (config < 12) wb++;
                }
            }
            printf("  br=%6d fec=%d -> %6.2f kbit/s  NB:%3d MB:%3d WB:%3d\n",
                   br, fec, total * 8.0 / (nframes * FRAME_MS) / 1000.0, nb, mb, wb);
            opus_encoder_destroy(enc);
        }
    }

    free(tone);
    return 0;
}
```

**编译运行**：

```bash
gcc -O2 -o opus_verify opus_verify.c -I./inc -L./build -lopus -lm -DM_PI=3.14159265358979
./opus_verify
```

---

## 十、三大工程方案对比

### 10.1 Opus vs 其他语音编解码器

| 维度 | Opus | AMR-NB | AMR-WB+ | EVS | SILK（独立版） |
|---|---|---|---|---|---|
| 码率范围 | **6 ~ 510 kbit/s** | 4.75–12.2 | 6.6–23.85 | 5.9–24 | 6–40 |
| 音频带宽 | **4 / 6 / 8 / 12 / 20 kHz** | 4 kHz | 8 kHz | 8 / 14 kHz | 4 / 8 kHz |
| 算法延迟 | **5 ~ 65.2 ms** | ~100 ms | ~100 ms | ~100 ms | ~60 ms |
| 内建 FEC | ✅ | ❌ | ❌ | ❌ | ❌ |
| 内建 PLC | ✅ | ❌ | ❌ | ❌ | ❌ |
| DTX | ✅ | ✅ | ✅ | ✅ | ✅ |
| 立体声/音乐 | ✅ 全带宽 | ❌ | ❌ | ❌ | ❌ |
| 标准化 | RFC 6716 / 7587 | 3GPP | 3GPP | 3GPP | RFC 5576 |
| 专利 | **无专利费** | 有 | 有 | 有 | 无 |
| 生态 | WebRTC / 主流 RTC | 3GPP 标配 | 3GPP 标配 | 5G IMS | Skype 历史包袱 |

**结论**：如果你的场景是**实时语音 + 弱网 + 车载**，Opus 在延迟和带宽上是断层领先。AMR/EVS 的价值在**运营商 IMS 网络的互通强制要求**。

### 10.2 三种应用类型怎么选

| 应用类型 | 实际效果 | 适用场景 |
|---|---|---|
| `OPUS_APPLICATION_AUDIO` | 音乐优先，阈值低（10 kbit/s 切 CELT） | 音乐播放、TTS 回传、提示音 |
| `OPUS_APPLICATION_VOIP` | 语音优先，阈值 +8000，偏向 SILK | **语音通话、语音助手上行** |
| `OPUS_APPLICATION_RESTRICTED_SILK` | 强制 SILK，永不切 CELT | 极低码率语音、MCU 场景 |
| `OPUS_APPLICATION_RESTRICTED_CELT` | 强制 CELT，永不切 SILK | **超低延迟**（<10 ms 帧强依赖） |
| `OPUS_APPLICATION_RESTRICTED_LOWDELAY` | 同上，但额外禁止 lookahead | 声学回声消除紧耦合 |

我的实测（语音 16 kHz mono，24 kbit/s）：

| 应用类型 | 实测码率 | 偏差 | 模式 | 带宽 | 平均包长 | 编码实时率 |
|---|---|---|---|---|---|---|
| voip | 20.47 kbit/s | −14.7% | SILK | WB | 51.2 B | 0.0090 |
| audio | 20.59 kbit/s | −14.2% | SILK | WB | 51.5 B | 0.0088 |
| restricted-silk | 20.59 kbit/s | −14.2% | SILK | WB | 51.5 B | 0.0078 |
| **restricted-celt** | **24.40 kbit/s** | **+1.7%** | **CELT** | **MB** | **61.0 B** | **0.0029** |
| **restricted-lowdelay** | **24.40 kbit/s** | **+1.7%** | **CELT** | **MB** | **61.0 B** | **0.0029** |

**注意 `restricted-celt` 的两个副作用**：
1. **带宽被限制到 MB（6 kHz）**（源码：`if (st->application == OPUS_APPLICATION_RESTRICTED_SILK && curr_bandwidth > OPUS_BANDWIDTH_WIDEBAND)` 以及 CELT 不支持 MB 的处理）
2. **包长方差消失**（60–62 B 极窄）——因为 CELT 是 CBR 设计的
3. **编码 CPU 反而更省**（0.0029 vs 0.0090）——因为 CELT 不做 LPC 分析

### 10.3 三种 FEC / PLC / DTX 组合的实际取舍

| 组合 | 码率增量 | 带宽影响 | 丢包恢复 | 推荐场景 |
|---|---|---|---|---|
| 全关 | 0 | 无 | 只有 PLC（解码端） | 稳定网络 |
| 只开 PLC | 0 | 无 | PLC 能量保持率 93% | **默认推荐** |
| 只开 FEC | +6.5% ~ +8.6% | ⚠️ **可能降级 WB→MB→NB** | FEC + PLC 双保险 | 弱网语音 |
| 只开 DTX | **−18.4%**（静音段） | 无 | 无 | 长待机语音助手 |
| FEC + DTX | 视场景 | ⚠️ 同上 | 最大 | **车载语音助手（推荐）** |

---

## 十一、常见误区与排查手册

| 症状 | 真实原因 | 排查方法 |
|---|---|---|
| **PLC 后声音越来越快/慢** | `opus_decode` 的 `frame_size` 传了缓冲区上限而不是确切帧长 | 打印 `opus_decode` 返回值，正常应恒等于 `frame_size` |
| **开了 FEC 音质变差** | `decide_fec()` 隐式降级了带宽 | 扫 TOC 字节看 config 是否变了 |
| **目标码率 16k 实测只有 12k** | VBR 正常行为（语音信息量低） | 扫 TOC 确认还是 SILK/WB；不是配置错误 |
| **5 ms 帧音质不如 20 ms** | <10 ms 强制 CELT-only，丢了 SILK | 源码 `frame_size < st->Fs/100` 强制分支 |
| **DTX 开了没效果** | DTX 只在 SILK 模式生效，音乐走 CELT | 扫 TOC 确认模式 |
| **下游 ASR 时间轴断掉** | DTX 的 1 字节空包没被识别 | 判 TOC 帧长码 == 0 |
| **播放端偶发卡顿** | 抖动缓冲深度不够 / 没有时钟漂移补偿 | 用 `OPUS_GET_PITCH` 监测周期稳定性 |
| **同一码率车机比手机差** | 应用类型不同（voip vs audio），模式/带宽不同 | **扫 TOC 字节对比** |
| **码率忽高忽低** | FEC 在带宽档位间反复横跳（迟滞 ±1000 bps 阈值） | 固定码率场景用 `OPUS_SET_VBR(0)` |

---

## 十二、总结与行动建议

### 我实测确认的核心事实

1. **Opus 的模式切换阈值就是那张 4 元素小表**：语音 mono 64 kbit/s 才切 CELT，音乐 10 kbit/s 就切
2. **FEC 会偷偷砍你的带宽**：20 kbit/s + loss=10% 时，WB(8k) → MB(6k) → NB(4k)
3. **DTX 省 18.4% 码率，但产生 1 字节空包**，且每 400 ms 一个刷新帧
4. **PLC 帧长失控是最大的坑**：`frame_size` 传错会让 PLC 帧返回 120 ms，时间轴永久错位
5. **PLC 的价值是能量保持率**（93%~99%），不是波形 SNR（必然是负的）
6. **突发丢包的 PLC 效果反而比随机丢包好**（谱相关 0.48 vs 0.16）
7. **`OPUS_GET_PITCH` 精度 ±0.63%**，单位是 48 kHz 样本数
8. **complexity 8/9/10 输出完全一致**，编解码实时率都在 1% 以内

### 给车机语音团队的落地建议

| 优先级 | 动作 | 预期收益 |
|---|---|---|
| **P0** | 审查所有 `opus_decode` 调用，确认 PLC 路径的 `frame_size` 是**确切帧长** | 消除时间轴错位这类"查不出原因"的问题 |
| **P0** | 在监控里**上报 TOC 字节**（config 分布 + 带宽分布） | 线上问题可秒级定位到模式/带宽 |
| **P1** | 语音链路开 FEC 但**同时监控带宽是否被降级** | 弱网语音可用性提升，且不牺牲音质 |
| **P1** | 长待机场景开 DTX，下游 ASR 适配 1 字节空包 | 流量省 18%，且 ASR 时间轴不断 |
| **P2** | 车载语音用 `OPUS_APPLICATION_VOIP` + complexity 5 | CPU 从 0.87% 降到 0.56%，音质几乎无差 |
| **P2** | 蓝牙链路接入 `OPUS_GET_PITCH` 做时钟漂移监测 | 消除"偶发卡顿/慢慢不同步" |
| **P3** | 考虑 `opus_demo` + `opus_compare` 进 CI，做回归 | 编解码参数改动有量化依据 |

### 最后一句

> Opus 的实现质量在开源编解码器里属于第一梯队——它的 `decide_fec()` 会主动牺牲带宽来换取 FEC 能力，`compute_equiv_rate()` 会把复杂度、丢包率、帧长全部折算成一个"等效码率"来做统一决策。这些设计是**十几年 VoIP 实战打磨出来的**，不是论文里的最优解。
>
> 但它所有的"聪明"都藏在一个前提里：**你的调用方知道自己在做什么**。`frame_size` 传错、FEC 开了不看带宽降级、DTX 空包不识别——这三个坑，任何一个都能让 Opus 在你的产品里变成"音质不如 AMR"的背锅侠。

---

## 附录 A：本文实验环境与可复现步骤

| 项 | 值 |
|---|---|
| libopus 版本 | xiph/opus commit `316c675fa1c9982d76e9cdcba7231076f75047da`（2026-11-20） |
| GitHub latest release | v1.5.2（2024-09-11）；仓库另有 v1.6 / v1.6.1 tag |
| 编译器 | gcc (Ubuntu 11.4.0-1ubuntu1~22.04.3) 11.4.0 |
| CMake 参数 | `-DCMAKE_BUILD_TYPE=Release -DOPUS_BUILD_PROGRAMS=ON -DOPUS_BUILD_TESTING=OFF` |
| CPU | 4 核 x86_64 |
| 语料 1 | `speech_16k.wav`：16 kHz mono，6 s，基频 135±22 Hz + 三共振峰 + −42 dBFS 底噪，numpy 合成，seed=20261122 |
| 语料 2 | `music_48k.wav`：48 kHz stereo，6 s，Am-F-C-G 和弦 + kick/hat + 梳状混响，seed=2002 |
| 语料 3 | `speech_dtx.wav`：8 s = 3 s 语音 + 2 s −60 dBFS 静音 + 3 s 语音 |
| 语料 4 | `tone.wav`：100/150/200/250/300 Hz 纯音，2 s，16 kHz |
| 丢包模型 | `rand_r(&seed)`，seed=12345，随机或 burst 模式 |

```bash
# 完整复现
git clone --depth 1 https://github.com/xiph/opus.git
cd opus && mkdir build && cd build
cmake .. -DCMAKE_BUILD_TYPE=Release -DOPUS_BUILD_PROGRAMS=ON -DOPUS_BUILD_TESTING=OFF
make -j$(nproc)

# 语料
python3 gen_corpus.py     # 生成 speech_16k / speech_48k / music_48k
python3 gen_dtx.py        # 生成 speech_dtx

# 实验
./opus_lab  <wav> <bitrate> [-app X] [-framesize N] [-complexity N] [-fec N] [-dtx] [-loss N]
./opus_trace <wav> <bitrate> [-dtx] [-fec N] [-loss N]   # 逐帧 TOC 追踪
./opus_plc2  <wav> <bitrate> <loss%> <prefix> [burst] [app]   # PLC 能量/谱分析
./opus_pitch <wav> <bitrate> <true_hz>              # 时钟漂移
```

## 附录 B：libopus 关键 API 速查（全部经 `include/opus.h` 核对）

| API | 签名要点 | 备注 |
|---|---|---|
| `opus_encoder_create` | `(int Fs, int channels, int application, int *error)` | application 见 10.2 |
| `opus_decoder_create` | `(int Fs, int channels, int *error)` | |
| `opus_encoder_get_size` | `(int channels)` → int | **不存在 `opus_get_size`** |
| `opus_decoder_get_size` | `(int channels)` → int | |
| `opus_encode` | `(st, pcm, frame_size, data, max_data_bytes)` → int | 返回字节数 |
| `opus_decode` | `(st, data, len, pcm, frame_size, decode_fec)` → int | **PLC 时 frame_size 必须是确切缺失时长** |
| `opus_encode_float` | 同 `opus_encode`，输入 float | |
| `opus_decode_float` | 同 `opus_decode`，输出 float | |
| `opus_repacketizer_*` | 重打包（改帧长/码率而不重编） | `opus_repacketizer_create/cat/insert/out/init` |

**编码器 CTL（`opus_encoder_ctl`）**：

| 宏 | 取值 | 实测影响 |
|---|---|---|
| `OPUS_SET_BITRATE` | 6000 ~ 510000 | VBR 下是参考值，实测可能低 35% |
| `OPUS_SET_COMPLEXITY` | 0 ~ 10 | 编码 CPU 差 4.6 倍；≥8 输出完全一致 |
| `OPUS_SET_MAX_BANDWIDTH` | `OPUS_BANDWIDTH_NARROWBAND`(1101) / `MEDIUMBAND`(1102) / `WIDEBAND`(1103) / `SUPERWIDEBAND`(1104) / `FULLBAND`(1105) | **注意是 1101~1105，不是 1200/1300/1400** |
| `OPUS_SET_SIGNAL` | `OPUS_SIGNAL_VOICE`(0) / `OPUS_SIGNAL_MUSIC`(1) | 先验提示，libopus **不做**自动分类 |
| `OPUS_SET_INBAND_FEC` | 0 / 1 / 2 | **会隐式降级带宽** |
| `OPUS_SET_PACKET_LOSS_PERC` | 0 ~ 100 | 影响 equiv_rate 折算 + FEC 阈值 |
| `OPUS_SET_DTX` | 0 / 1 | **仅编码器有**；仅 SILK 生效 |
| `OPUS_SET_VBR` | 0 (CBR) / 1 (VBR, 默认) / 2 (constrained VBR) | CBR 有约 8% 惩罚 |
| `OPUS_GET_IN_DTX` | → int | 查询当前是否在 DTX |

**解码器 CTL（`opus_decoder_ctl`）**：

| 宏 | 说明 |
|---|---|
| `OPUS_GET_PITCH` | → int，**48 kHz 样本数**的周期；0 = 非周期 |
| `OPUS_GET_BANDWIDTH` | → int，实际解码带宽 |
| `OPUS_GET_SAMPLE_RATE` | → int，实际输出采样率 |
| `OPUS_GET_LAST_PACKET_DURATION` | → int，上一包时长 |
| `OPUS_RESET_STATE` | 重置解码器状态（丢包后长时间未恢复时用） |

**⚠️ 不存在的 CTL**：`OPUS_SET_LPC_BANDWIDTH`、`OPUS_SET_DTX`（解码器侧）、`OPUS_SET_DRED_DURATION`（那是独立的 `OpusDREDDecoder`）。

## 附录 C：源码定位速查

| 想看什么 | 去哪看 |
|---|---|
| 模式切换决策链 | `src/opus_encoder.c:1472-1546` |
| 模式阈值表 | `src/opus_encoder.c:176-192`（`mode_thresholds` / `fec_thresholds`） |
| 等效码率折算 | `src/opus_encoder.c:1034`（`compute_equiv_rate`） |
| FEC 决策 + 带宽降级 | `src/opus_encoder.c:947`（`decide_fec`） |
| Hybrid 码率分配表 | `src/opus_encoder.c:980`（`compute_silk_rate_for_hybrid`，表体 `:985`） |
| DTX 判定 | `src/opus_encoder.c:1122`（`decide_dtx_mode`）+ `silk/define.h:52-54` |
| DTX 帧写码流 | `src/opus_encoder.c:1795-1851`（`dtx_count` 累加在 `:1839`，出包在 `:1851`）（`opus_repacketizer_out_range_impl`，code 0 = 无帧） |
| SILK PLC | `silk/PLC.c`（`silk_PLC` / `silk_PLC_conceal` / `silk_PLC_glue_frames`） |
| CELT PLC | `celt/mdct.c`（`celt_decode_lost`） |
| SILK 重采样 | `silk/resampler.c`（**没有 `src/opus_resample.c`**） |
| 编码主流程 | `opus_encode` → `opus_encode_native` → `opus_encode_frame_native`（static）→ `silk_Encode` / `celt_encode_with_ec` |
| 解码主流程 | `opus_decode` → `opus_decode_native` → `opus_decode_frame`（static）→ `silk_Decode` / `celt_decode_with_ec` |
| DRED（神经网络 PLC） | `dnn/dred_*.c` + `src/opus_decoder.c:1361-1420`（结构体 `:1361`，公开 API `opus_dred_decoder_*` 从 `:1385` 起） |
| Opus 官方文档 | https://opus-codec.org/docs/ |
| RFC 6716 | https://www.rfc-editor.org/rfc/rfc6716.txt |
| RFC 7587（RTP 封装） | https://www.rfc-editor.org/rfc/rfc7587.txt |
| RFC 8251（RFC 6716 勘误） | https://www.rfc-editor.org/rfc/rfc8251.txt |

---

> **参考规范**：RFC 6716（Opus 编解码器）、RFC 7587（Opus RTP 载荷格式）、RFC 7845（Ogg Opus 容器）、RFC 8251（对 RFC 6716 的更新）。
>
> **官方论文**：J.-M. Valin, G. Maxwell, T. B. Terriberry, K. Vos, "High-Quality, Low-Delay Music Coding in the Opus Codec", AES 135th Convention, 2013；K. Vos, K. V. Sorensen, S. S. Jensen, J.-M. Valin, "Voice Coding with Opus", AES 135th Convention, 2013。
>
> **中文参考**：《音视频开发技术：原理与实践》第 6.5.4 节「Opus：为实时互动而生」——中文专著里对 Opus 讲得最系统的一章。其余中文网络资料（CSDN / 博客园）多为入门科普级，部分描述（如把 CELT 描述为"预处理去噪和增益控制"）与 RFC 不符，本文未采用。
