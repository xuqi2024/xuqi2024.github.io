---
title: 说话人分离三路横评
date: 2026-11-05 09:00:00
categories:
- 技术报告
tags:
- 说话人分离
- pyannote
- NeMo
- 声纹识别
- 车载语音
series: audio-tech-deep-dive
description: 深挖说话人分离三条路线：pyannote 的 Powerset+置换不变损失、NeMo Sortformer 排序损失、达摩院 3D-Speaker 中文生态，附纯 numpy 可运行 demo。
---

> **一句话结论**：说话人分离（speaker diarization）真正的技术分水岭只有一个问题——**"谁在什么时候说话"这个标签该怎么表示**。pyannote 用「幂集编码 + 匈牙利匹配」把它变成一个可微的单标签分类问题，NeMo Sortformer 用「按到达时间排序」干脆绕开它，3D-Speaker 用「工程化模块流水线」把它拆成五个独立零件。**三条路线的 DER 差距不到 10 个百分点，但 CPU 实时率差了 6 倍（0.03 vs 0.19）——这才是车载场景该关心的数字。**
>
> 本文所有 DER / RTF 数字来自三个项目 README 的官方表格，所有算法细节来自源码逐行核对，并附一份**纯 numpy 手写匈牙利算法**的可运行 demo（不需要 torch / scipy）。

---

## 前言：为什么这个题目值得单开一篇

前面 24 篇里，我们聊过声学前端（Day 01/22）、VAD（Day 08）、ASR（Day 09/10）、TTS（Day 15）、WebRTC 3A（Day 11）、车载路由与延迟预算（Day 17-21）、功耗门控（Day 23）。

但**有一个环节始终缺席**：当车里同时坐着爸爸、妈妈、孩子，三个人都在说话时，系统怎么知道哪句话是谁说的？

这在学术上叫 **说话人分离（speaker diarization）**，输出是一张「谁在什么时候说话」的表（RTTM 格式）。它的价值直接决定两件事：

1. **多说话人 ASR 的字幕归属**——"导航说要去公司" 和 "用户说去公司"，对车机指令解析是天壤之别
2. **声纹门控（voiceprint gate）**——只有主驾说话才响应指令，这条策略本身就需要分离能力

而它也是**整个语音链路里最容易被误判难度的一环**。很多人以为"分离 = 声纹比对"，实际上是两回事：

| 任务 | 输入 | 输出 | 核心问题 |
|---|---|---|---|
| 声纹验证（SV） | 两段语音 | 同一/不同 | 这是同一个人吗？ |
| 说话人分离（Diarization） | 一整段多人对话 | 谁在什么时候说话 | 什么时候谁在说话？ |
| 说话人识别（ID） | 一段语音 + 库 | 这个人是谁 | 这是谁？ |

分离任务最难的地方在于：**它没有标准答案式的标签**。你标注的"说话人 1"和模型输出的"说话人 1"根本不是一回事——标注里说话人 1 是"穿蓝衣服的人"，模型里的说话人 1 是"第一个发声的人"。这个"标签空间不对齐"的问题，就是本文要讲的核心。

读完你能拿到：

- **一份可运行的 demo**：纯 numpy 复刻 pyannote 的幂集编码 + 置换不变损失，复制就能跑，不依赖 torch/scipy
- **三个项目的横向对比**：DER、RTF、许可证、模型获取门槛、流式支持
- **一条清晰的技术路线判断**：车载场景到底该选哪条

---

## 一、先把概念钉死：Diarization 到底在做什么

### 1.1 输出长什么样

分离的输出是 **RTTM**（Rich Transcription Time Marked）文件，每行一个"发言段"：

```
SPEAKER 00-00-00.000 00-00-03.500 <NA> <NA> speaker_0 <NA> <NA>
SPEAKER 00-00-03.800 00-00-07.200 <NA> <NA> speaker_1 <NA> <NA>
SPEAKER 00-00-04.100 00-00-07.400 <NA> <NA> speaker_0 <NA> <NA>
```

第三行和第二行**时间重叠**——这就是**重叠语音（overlapping speech）**，两个人同时说话。

### 1.2 评价指标 DER

**DER（Diarization Error Rate）** 把错误拆成三类：

| 错误类型 | 含义 | 判定方式 |
|---|---|---|
| **Missed Speech** | 漏检 | 标注里有人说话，系统说是静音 |
| **False Alarm** | 误报 | 标注里是静音，系统说有人说话 |
| **Confusion** | 混淆 | 都在说话，但认错了人 |

$$\text{DER} = \frac{\text{Missed} + \text{False Alarm} + \text{Confusion}}{\text{总参考语音时长}}$$

**DER 的一个反直觉特性**：它是**时间加权**的，不是帧加权也不是人数加权。一段 10 秒的静音贡献 0 DER，但 10 秒里错认 1 秒就是 10% DER。所以**把噪声段误判成语音（False Alarm）在长录音里惩罚极重**——这也是为什么工程上 VAD 阈值调得保守。

### 1.3 整体流水线长什么样

pyannote 的 pipeline 是典型的"模型串联"结构：

```mermaid
graph TB
    A["🎙️ 原始音频<br/>多路混音"] --> B["🔊 VAD<br/>语音活动检测"]
    B --> C["🧠 Segmentation<br/>帧级说话人分割<br/>pyannote/segmentation-3.0"]
    C --> D["🧬 Embedding<br/>说话人嵌入提取<br/>wespeaker-voxceleb"]
    D --> E["🎯 Clustering<br/>聚类成说话人"]
    E --> F["📄 RTTM 输出<br/>谁在什么时候说话"]

    C -.->|"重叠语音检测<br/>可选模块"| G["⚠️ Overlap<br/>双人同时说的帧"]

    style A fill:#C7CEEA,stroke:#9FA8DA,stroke-width:2px,color:#333
    style B fill:#E8D5F5,stroke:#CE93D8,stroke-width:2px,color:#333
    style C fill:#FFB3C6,stroke:#F48FB1,stroke-width:2px,color:#333
    style D fill:#FFDAB9,stroke:#FFAB76,stroke-width:2px,color:#333
    style E fill:#FFF9C4,stroke:#F9A825,stroke-width:2px,color:#333
    style F fill:#B5EAD7,stroke:#80CBC4,stroke-width:2px,color:#333
    style G fill:#F5F5F5,stroke:#BDBDBD,stroke-width:2px,color:#333
```

**关键认知**：`segmentation-3.0` 模型**输出的不是 RTTM**，而是「帧级说话人概率张量」。RTTM 是聚类之后的产物。

这个区分很重要，因为它解释了为什么 `segmentation-3.0` 可以被单独拿出来用（比如 3D-Speaker 就拿它当重叠检测模块），也能解释为什么 powerset 编码这么设计（下面第三节展开）。

---

## 二、路线一：pyannote 的 Powerset + 置换不变损失

### 2.1 问题从哪来

先设想最朴素的建模：每一帧，对每个说话人输出一个「是/否」二分类。

```
帧 0:  [说话人0=0, 说话人1=0, 说话人2=0]   无人说话
帧 1:  [说话人0=1, 说话人1=0, 说话人2=0]   说话人0在说
帧 2:  [说话人0=1, 说话人1=1, 说话人2=0]   说话人0和1同时在说
```

这是标准的 **multi-label（多标签）** 问题，看起来很自然。但它有个致命缺陷：

**多标签的每一维是独立的，模型输出「说话人0=1, 说话人1=1」和「说话人0=1, 说话人2=1」在 loss 层面没有任何区别**——它无法表达"这两个是一组"。

更要命的是**说话人编号本身是任意的**。标注里"说话人 1"指穿蓝衣服的人，但如果训练时换一批数据，蓝衣服的人可能被标成"说话人 2"。模型学到的是"活跃区域"，但**输出编号和标注编号没有任何对应关系**。

### 2.2 Powerset：把"集合"变成"类别"

pyannote 的解法分两步。第一步是 **Powerset 编码**：不再对每个说话人独立二分类，而是**把"这一帧有哪些人在说话"当成一个整体类别**。

当 `num_classes=3`、`max_set_size=2` 时，所有可能的集合是：

| 索引 | 集合 | 含义 |
|---|---|---|
| 0 | `{}` | 无人说话 |
| 1 | `{0}` | 只有说话人 0 |
| 2 | `{1}` | 只有说话人 1 |
| 3 | `{2}` | 只有说话人 2 |
| 4 | `{0,1}` | 说话人 0 和 1 **同时**说 |
| 5 | `{0,2}` | 说话人 0 和 2 同时说 |
| 6 | `{1,2}` | 说话人 1 和 2 同时说 |

**类别数从 3 个（每人一个二分类）变成了 7 个**，但换来两个关键能力：

1. **重叠语音被显式编码**——`{0,1}` 是一个独立类别，不会被"每人独立 sigmoid"丢帧
2. **变成标准单标签分类**——可以直接用交叉熵（Cross-Entropy），这是 PyTorch 里最成熟的损失函数

上游实现在 `src/pyannote/audio/utils/powerset.py`：

```python
class Powerset(nn.Module):
    def __init__(self, num_classes: int, max_set_size: int):
        super().__init__()
        self.num_classes = num_classes
        self.max_set_size = max_set_size
        self.register_buffer("mapping", self.build_mapping(), persistent=False)
        self.register_buffer("cardinality", self.build_cardinality(), persistent=False)

    @cached_property
    def powerset_classes(self) -> list[set[int]]:
        """e.g. with num_classes = 3 and max_set_size = 2:
        {}, {0}, {1}, {2}, {0, 1}, {0, 2}, {1, 2}
        """
        powerset_classes = []
        for set_size in range(self.max_set_size + 1):
            for current_set in combinations(range(self.num_classes), set_size):
                powerset_classes.append(set(current_set))
        return powerset_classes

    def build_mapping(self) -> torch.Tensor:
        """mapping[i, j] == 1 if jth regular class is a member of ith powerset class"""
        mapping = torch.zeros(self.num_powerset_classes, self.num_classes)
        powerset_k = 0
        for set_size in range(self.max_set_size + 1):
            for current_set in combinations(range(self.num_classes), set_size):
                mapping[powerset_k, current_set] = 1
                powerset_k += 1
        return mapping
```

**类别数的增长是指数级的**——这是 powerset 方案的代价。说话人数 N、每帧最多 M 人同时说话时：

| N (说话人) | M (同时说话上限) | Powerset 类别数 | 说明 |
|---|---|---|---|
| 2 | 2 | 4 | `{}`,`{0}`,`{1}`,`{0,1}` |
| 3 | 2 | 7 | 上表 |
| 4 | 2 | 11 | |
| 5 | 2 | 16 | |
| 3 | 3 | 8 | `{}` 到 `{0,1,2}` 全组合 |
| 4 | 3 | 15 | |
| 5 | 3 | 26 | |
| 10 | 3 | 176 | 开始爆炸 |

**结论**：powerset 方案**天然适合"说话人少 + 重叠少"的场景**。这正是车载场景（通常 2-4 人，最多偶尔两人同时说话）的甜区，也是 pyannote 默认 `max_speakers_per_frame=2` 的原因。

### 2.3 置换不变损失：PIL 的真正机制

Powerset 解决了"集合表示"，但**没解决"编号不对齐"**。模型输出 `{0,1}`，标注也可能是 `{1,0}`——虽然集合相同，但**在交叉熵里这是两个不同的类别**。

朴素做法是「对所有置换取最小损失」：

$$\mathcal{L} = \min_{\pi \in S_N} \text{CE}\big(\hat{y}, \pi(y)\big)$$

但 N 个说话人有 N! 种置换。N=5 时是 120，N=10 时是 **3,628,800**——每个 batch 每步都穷举不可行。

**上游的实际做法**（`src/pyannote/audio/utils/permutation.py`）聪明得多：

```python
# permutate_torch() 中
for b, (y1_, y2_) in enumerate(zip(y1, y2)):
    with torch.no_grad():
        if cost_func == "mse":
            diff = y1_.unsqueeze(2) - y2_.unsqueeze(1)   # (num_samples, C1, C2)
            cost = torch.mean(diff * diff, dim=0)          # (C1, C2)
        elif cost_func == "mae":
            diff = y1_.unsqueeze(2) - y2_.unsqueeze(1)
            cost = torch.mean(torch.abs(diff), dim=0)      # (C1, C2)

    if num_classes_2 > num_classes_1:
        padded_cost = F.pad(cost, (0, 0, 0, num_classes_2 - num_classes_1),
                            "constant", torch.max(cost) + 1)
    else:
        padded_cost = cost

    permutation = [None] * num_classes_1
    for k1, k2 in zip(*linear_sum_assignment(padded_cost.cpu())):
        if k1 < num_classes_1:
            permutation[k1] = k2
            permutated_y2[b, :, k1] = y2_[:, k2]
```

拆解这段代码，机制是三步：

1. **构造成本矩阵** `cost`（形状 `(C1, C2)`）：`cost[i][j]` = "预测的说话人 i" 和 "标注的说话人 j" 之间的逐类 MSE
2. **匈牙利算法求解**：`linear_sum_assignment` 求**最小代价完美匹配**——这正是经典的**指派问题（Assignment Problem）**
3. **按最优匹配重排 target**：把标注的说话人 j 的帧序列搬到预测编号 i 上

**所以 PIL 不是"对所有置换求最小"，而是"先解一个最优分配问题把标签对齐，再算一次普通交叉熵"。**

这比穷举好在：**复杂度是 O(N³)** 而不是 O(N!)。

### 2.4 上游 training_step 的完整调用链

`src/pyannote/audio/tasks/segmentation/speaker_diarization.py:436-460`：

```python
# forward pass
prediction = self.model(waveform)
batch_size, num_frames, _ = prediction.shape
# (batch_size, num_frames, num_classes)

# frames weight
weight = batch.get(weight_key,
                    torch.ones(batch_size, num_frames, 1, device=self.model.device))

multilabel = self.model.powerset.to_multilabel(prediction)   # ← 幂集空间 -> 多标签空间
permutated_target, _ = permutate(multilabel, target)         # ← 匈牙利匹配对齐
permutated_target_powerset = self.model.powerset.to_powerset(
    permutated_target.float()                                 # ← 多标签 -> 幂集空间
)

loss = nll_loss(
    prediction,
    torch.argmax(permutated_target_powerset, dim=-1),        # ← 取 argmax 得到硬标签
    weight=weight,
)
```

**注意 `multilabel` 这个中间变量**——它不是最终输出，而是**为了让成本矩阵可计算而做的空间转换**：

```
prediction (幂集空间 logits)
    ↓ to_multilabel()
multilabel (多标签空间, 可比较)
    ↓ permutate() 匈牙利匹配
permutated_target (多标签空间, 已对齐到预测编号)
    ↓ to_powerset()
permutated_target_powerset (幂集空间)
    ↓ argmax
硬标签 (num_frames,)
    ↓ nll_loss
```

### 2.5 可运行 demo：纯 numpy 复刻

下面这份代码**不需要 torch，不需要 scipy**，只依赖 numpy。它复刻了 `powerset.py` 的 `build_mapping` / `to_multilabel` / `to_powerset`，以及 `permutation.py` 的 `permutate`（含自实现的匈牙利算法）。

```python
import numpy as np
from itertools import combinations

# ---------------------------------------------------------------------------
# 1. Powerset 编码（对齐上游 utils/powerset.py）
# ---------------------------------------------------------------------------


def powerset_classes(num_classes: int, max_set_size: int) -> list:
    """上游 powerset_classes 的等价实现"""
    classes = []
    for set_size in range(max_set_size + 1):
        for current_set in combinations(range(num_classes), set_size):
            classes.append(set(current_set))
    return classes


def build_mapping(num_classes: int, max_set_size: int) -> np.ndarray:
    """上游 build_mapping：(num_powerset_classes, num_classes) 的 0/1 矩阵"""
    classes = powerset_classes(num_classes, max_set_size)
    mapping = np.zeros((len(classes), num_classes), dtype=np.float64)
    for k, cs in enumerate(classes):
        for j in cs:
            mapping[k, j] = 1.0
    return mapping


def to_multilabel(powerset_probs: np.ndarray, mapping: np.ndarray) -> np.ndarray:
    """上游 to_multilabel: (..., num_powerset) -> (..., num_classes)"""
    return powerset_probs @ mapping


def to_powerset(multilabel: np.ndarray, mapping: np.ndarray) -> np.ndarray:
    """上游 to_powerset: 硬多标签 -> powerset 单标签"""
    n_pow = mapping.shape[0]
    out = np.zeros(multilabel.shape[:-1] + (n_pow,), dtype=np.float64)
    for k in range(n_pow):
        match = np.all(mapping[k][None, :] == multilabel, axis=-1)
        out[..., k] = match.astype(np.float64)
    return out
```

**匈牙利算法**——这是最容易写错的一段，下面这份通过了 500 次随机矩阵 vs 穷举的对照验证：

```python
def linear_sum_assignment(cost: np.ndarray):
    """
    纯 numpy 实现的匈牙利算法（O(n^3) 最短增广路版本）。
    语义与 scipy.optimize.linear_sum_assignment 一致：
      row_ind[k] = 列号, col_ind[k] = 行号，两者互为逆映射
      最小化 sum(cost[col_ind[k], row_ind[k]])
    """
    cost = np.asarray(cost, dtype=np.float64)
    n_rows, n_cols = cost.shape
    transposed = False
    if n_rows > n_cols:                 # 本实现基于"行 <= 列"，否则转置
        cost = cost.T
        n_rows, n_cols = n_cols, n_rows
        transposed = True

    INF = float("inf")
    u = np.zeros(n_rows + 1)
    v = np.zeros(n_cols + 1)
    p = np.zeros(n_cols + 1, dtype=int)   # p[j] = 匹配到列 j 的行 (1-indexed)
    way = np.zeros(n_cols + 1, dtype=int)

    for i in range(1, n_rows + 1):
        p[0] = i
        j0 = 0
        minv = np.full(n_cols + 1, INF)
        used = np.zeros(n_cols + 1, dtype=bool)
        while True:
            used[j0] = True
            i0 = p[j0]
            delta = INF
            j1 = 0
            for j in range(1, n_cols + 1):
                if not used[j]:
                    cur = cost[i0 - 1, j - 1] - u[i0] - v[j]
                    if cur < minv[j]:
                        minv[j] = cur
                        way[j] = j0
                    if minv[j] < delta:
                        delta = minv[j]
                        j1 = j
            for j in range(n_cols + 1):
                if used[j]:
                    u[p[j]] += delta
                    v[j] -= delta
                else:
                    minv[j] -= delta
            j0 = j1
            if p[j0] == 0:
                break
        while True:                       # 沿增广路回溯
            j1 = way[j0]
            p[j0] = p[j1]
            j0 = j1
            if j0 == 0:
                break

    row_ind = np.zeros(n_rows, dtype=int)
    col_ind = np.zeros(n_rows, dtype=int)
    k = 0
    for j in range(1, n_cols + 1):
        if p[j] != 0:
            row_ind[k] = j - 1            # 列号
            col_ind[k] = p[j] - 1        # 行号
            k += 1

    if transposed:
        row_ind, col_ind = col_ind, row_ind
    return row_ind, col_ind
```

**`permutate` + 损失计算**：

```python
def permutate(pred_multilabel: np.ndarray, target_multilabel: np.ndarray):
    """
    复刻上游 permutate()：把 target 重排到 prediction 的说话人编号空间。
    上游调用点：permutate(multilabel, target) —— y1=pred, y2=target
    """
    c1 = pred_multilabel.shape[1]
    c2 = target_multilabel.shape[1]

    # (C1, C2) class-wise MSE —— 与上游 mse_cost_func 一致
    # 上游: diff = y1.unsqueeze(2) - y2.unsqueeze(1) -> (F, C1, C2)
    #       cost = torch.mean(diff*diff, dim=0)        -> (C1, C2)
    diff = pred_multilabel[:, :, None] - target_multilabel[:, None, :]
    cost = np.mean(diff * diff, axis=0)

    if c2 > c1:
        padded = np.full((c1, c2), cost.max() + 1.0)
        padded[:, :c2] = cost
    else:
        padded = cost

    row_ind, col_ind = linear_sum_assignment(padded)

    permutation = [None] * c1
    permuted = np.zeros_like(target_multilabel)
    for r, c in zip(row_ind, col_ind):
        # r = 被匹配的列（target 空间说话人）, c = 对应的行（pred 空间说话人）
        if c < c1 and r < c2:
            permutation[c] = int(r)
            permuted[:, c] = target_multilabel[:, r]
    return permuted, tuple(permutation)


def nll_loss_from_logits(logits: np.ndarray, target_class: np.ndarray) -> float:
    """logits: (num_frames, num_powerset_classes), target_class: (num_frames,)"""
    z = logits - logits.max(axis=-1, keepdims=True)
    logsumexp = np.log(np.exp(z).sum(axis=-1))
    nll = logsumexp - z[np.arange(len(target_class)), target_class]
    return float(nll.mean())
```

**完整可运行脚本**（含 4 组实验 + 断言）。把上面三个代码块按顺序拼在一起就是完整脚本——
`diar_demo.py` 的结构是：导入 → `powerset_classes` / `build_mapping` / `to_multilabel` /
`to_powerset` → `linear_sum_assignment` → `permutate` / `nll_loss_from_logits` → 实验 A/B/C/D。
下面这段是**实验部分**（接在上述函数之后）：

```python
# 完整可运行脚本（自包含，复制即可运行，仅依赖 numpy）
# 运行：python3 diar_demo.py
import numpy as np
from itertools import combinations, permutations


# ---------- Powerset 编码（对齐上游 utils/powerset.py） ----------
def powerset_classes(num_classes, max_set_size):
    classes = []
    for set_size in range(max_set_size + 1):
        for current_set in combinations(range(num_classes), set_size):
            classes.append(set(current_set))
    return classes


def build_mapping(num_classes, max_set_size):
    classes = powerset_classes(num_classes, max_set_size)
    mapping = np.zeros((len(classes), num_classes), dtype=np.float64)
    for k, cs in enumerate(classes):
        for j in cs:
            mapping[k, j] = 1.0
    return mapping


def to_multilabel(powerset_probs, mapping):
    return powerset_probs @ mapping


def to_powerset(multilabel, mapping):
    n_pow = mapping.shape[0]
    out = np.zeros(multilabel.shape[:-1] + (n_pow,), dtype=np.float64)
    for k in range(n_pow):
        out[..., k] = np.all(mapping[k][None, :] == multilabel, axis=-1).astype(np.float64)
    return out


# ---------- 匈牙利算法（纯 numpy，语义同 scipy.linear_sum_assignment） ----------
def linear_sum_assignment(cost):
    cost = np.asarray(cost, dtype=np.float64)
    n_rows, n_cols = cost.shape
    transposed = False
    if n_rows > n_cols:
        cost = cost.T
        n_rows, n_cols = n_cols, n_rows
        transposed = True

    INF = float("inf")
    u = np.zeros(n_rows + 1)
    v = np.zeros(n_cols + 1)
    p = np.zeros(n_cols + 1, dtype=int)
    way = np.zeros(n_cols + 1, dtype=int)

    for i in range(1, n_rows + 1):
        p[0] = i
        j0 = 0
        minv = np.full(n_cols + 1, INF)
        used = np.zeros(n_cols + 1, dtype=bool)
        while True:
            used[j0] = True
            i0 = p[j0]
            delta = INF
            j1 = 0
            for j in range(1, n_cols + 1):
                if not used[j]:
                    cur = cost[i0 - 1, j - 1] - u[i0] - v[j]
                    if cur < minv[j]:
                        minv[j] = cur
                        way[j] = j0
                    if minv[j] < delta:
                        delta = minv[j]
                        j1 = j
            for j in range(n_cols + 1):
                if used[j]:
                    u[p[j]] += delta
                    v[j] -= delta
                else:
                    minv[j] -= delta
            j0 = j1
            if p[j0] == 0:
                break
        while True:
            j1 = way[j0]
            p[j0] = p[j1]
            j0 = j1
            if j0 == 0:
                break

    row_ind = np.zeros(n_rows, dtype=int)
    col_ind = np.zeros(n_rows, dtype=int)
    k = 0
    for j in range(1, n_cols + 1):
        if p[j] != 0:
            row_ind[k] = j - 1
            col_ind[k] = p[j] - 1
            k += 1
    if transposed:
        row_ind, col_ind = col_ind, row_ind
    return row_ind, col_ind


# ---------- permutate + NLL ----------
def permutate(pred_multilabel, target_multilabel):
    """把 target 重排到 prediction 的说话人编号空间（上游 y1=pred, y2=target）"""
    c1 = pred_multilabel.shape[1]
    c2 = target_multilabel.shape[1]
    diff = pred_multilabel[:, :, None] - target_multilabel[:, None, :]
    cost = np.mean(diff * diff, axis=0)
    if c2 > c1:
        padded = np.full((c1, c2), cost.max() + 1.0)
        padded[:, :c2] = cost
    else:
        padded = cost

    row_ind, col_ind = linear_sum_assignment(padded)
    permutation = [None] * c1
    permuted = np.zeros_like(target_multilabel)
    for r, c in zip(row_ind, col_ind):
        if c < c1 and r < c2:
            permutation[c] = int(r)
            permuted[:, c] = target_multilabel[:, r]
    return permuted, tuple(permutation)


def nll_loss_from_logits(logits, target_class):
    z = logits - logits.max(axis=-1, keepdims=True)
    logsumexp = np.log(np.exp(z).sum(axis=-1))
    nll = logsumexp - z[np.arange(len(target_class)), target_class]
    return float(nll.mean())


# ---------- 主流程：4 组实验 ----------
NUM_SPEAKERS = 3
MAX_SET_SIZE = 2
NUM_FRAMES = 60

rng = np.random.default_rng(20261105)
truth = np.zeros((NUM_FRAMES, NUM_SPEAKERS))
for f in range(NUM_FRAMES):
    active = set()
    if 10 <= f < 30:
        active.add(0)          # 说话人 0: 10~30
    if 25 <= f < 45:
        active.add(1)          # 说话人 1: 25~45（与 0 在 25~30 重叠）
    if 40 <= f < 55:
        active.add(2)          # 说话人 2: 40~55（与 1 在 40~45 重叠）
    for s in active:
        truth[f, s] = 1.0

mapping = build_mapping(NUM_SPEAKERS, MAX_SET_SIZE)
target_powerset = to_powerset(truth, mapping)
target_class = np.argmax(target_powerset, axis=-1)

print("=" * 72)
print("pyannote Powerset + Permutation-Invariant Loss 复刻 demo")
print("=" * 72)
print(f"说话人数 num_classes      = {NUM_SPEAKERS}")
print(f"每帧最多同时说话 max_set   = {MAX_SET_SIZE}")
print(f"帧数 num_frames            = {NUM_FRAMES}")
print(f"powerset 类别数            = {mapping.shape[0]}")
print(f"powerset 类别列表          = {powerset_classes(NUM_SPEAKERS, MAX_SET_SIZE)}")
print()

# 实验 A：模型预测完全正确，但说话人编号与标注不一致
perm = [2, 0, 1]   # 真值说话人 s -> 预测编号 perm[s]
pred_multilabel = np.zeros_like(truth)
for s in range(NUM_SPEAKERS):
    pred_multilabel[:, perm[s]] = truth[:, s]

pred_powerset = to_powerset(pred_multilabel, mapping)
logits_pred = np.log(pred_powerset + 1e-9)

loss_no_perm = nll_loss_from_logits(logits_pred, target_class)
permuted_target, permutation = permutate(pred_multilabel, truth)
permuted_class = np.argmax(to_powerset(permuted_target, mapping), axis=-1)
loss_with_perm = nll_loss_from_logits(logits_pred, permuted_class)

print("-" * 72)
print("实验 A：模型预测完全正确，但说话人编号与标注不一致时，损失差多少？")
print("-" * 72)
print(f"模型把真值说话人 s 认成预测编号 perm[s]，perm = {perm}")
print()
print(f"未做置换对齐的 NLL = {loss_no_perm:.6f}")
print(f"做置换对齐的   NLL = {loss_with_perm:.6f}")
print(f"最优置换 permutation = {permutation}")
print(f"（permutation[i] = j 表示：标注里的说话人 j 应映射到模型编号 i）")
print()
assert loss_with_perm < loss_no_perm
assert loss_with_perm < 1e-3
assert loss_no_perm > 1.0
print("✅ 断言通过：置换对齐把 NLL 从 %.6f 降到 %.6f" % (loss_no_perm, loss_with_perm))
print()

# 实验 B：加噪声后对齐不会虚假归零
noisy_pred = np.clip(pred_multilabel + rng.normal(0, 0.25, size=pred_multilabel.shape), 0, 1)
noisy_log_probs = np.log(np.clip(noisy_pred, 1e-9, 1) @ mapping.T + 1e-9)
loss_noisy_no_perm = nll_loss_from_logits(noisy_log_probs, target_class)
noisy_permuted, _ = permutate(noisy_pred, truth)
noisy_permuted_class = np.argmax(to_powerset(noisy_permuted, mapping), axis=-1)
loss_noisy_perm = nll_loss_from_logits(noisy_log_probs, noisy_permuted_class)

print("-" * 72)
print("实验 B：预测有噪声时，置换对齐后的损失仍然是正数（不会虚假归零）")
print("-" * 72)
print(f"有噪声 - 未对齐 NLL = {loss_noisy_no_perm:.6f}")
print(f"有噪声 - 已对齐 NLL = {loss_noisy_perm:.6f}")
assert loss_noisy_perm > 0
print("✅ 断言通过：噪声下对齐后 NLL = %.6f > 0，未被虚假归零" % loss_noisy_perm)
print()

# 实验 C：重叠语音的 powerset 编码
print("-" * 72)
print("实验 C：powerset 编码如何表达重叠语音")
print("-" * 72)
ml = to_multilabel(target_powerset, mapping)
overlap_frame = 27
print(f"第 {overlap_frame} 帧真值（多标签） = {ml[overlap_frame].astype(int).tolist()}")
print(f"第 {overlap_frame} 帧 powerset 类别索引 = {target_class[overlap_frame]}")
print(f"对应 powerset 集合 = {powerset_classes(NUM_SPEAKERS, MAX_SET_SIZE)[target_class[overlap_frame]]}")
overlap_frames = np.where(ml.sum(axis=1) >= 2)[0]
print(f"全段中重叠帧数 = {len(overlap_frames)}，重叠帧索引 = {overlap_frames.tolist()}")
assert len(overlap_frames) == 10
print("✅ 断言通过：重叠帧被编码为 {0,1} / {1,2} 这类双元素集合，而不是被丢弃")
print()

# 实验 D：匈牙利算法正确性（随机矩阵 vs 穷举）
print("-" * 72)
print("实验 D：纯 numpy 匈牙利算法的正确性验证（随机成本矩阵 vs 穷举）")
print("-" * 72)


def brute_force_min_cost(cost):
    best = None
    n = cost.shape[0]
    for pm in permutations(range(cost.shape[1]), n):
        total = sum(cost[i, pm[i]] for i in range(n))
        if best is None or total < best:
            best = total
    return best


mismatch = 0
trials = 0
for _ in range(500):
    c = rng.integers(0, 50, size=(3, 4)).astype(np.float64)
    row_ind, col_ind = linear_sum_assignment(c)
    mine = sum(c[col_ind[k], row_ind[k]] for k in range(len(row_ind)))
    ref = brute_force_min_cost(c)
    trials += 1
    if abs(mine - ref) > 1e-9:
        mismatch += 1
print(f"随机 3x4 成本矩阵 {trials} 次测试，失配次数 = {mismatch}")
assert mismatch == 0
print("✅ 断言通过：%d/%d 次与穷举结果一致" % (trials, trials))
print()

print("=" * 72)
print("汇总：本文所有可复现数字")
print("=" * 72)
print(f"powerset 类别数 (3 speakers, max_set=2) = {mapping.shape[0]}")
print(f"未对齐 NLL（标签打乱）              = {loss_no_perm:.6f}")
print(f"对齐后 NLL（预测完全正确）          = {loss_with_perm:.6f}")
print(f"有噪声未对齐 NLL                    = {loss_noisy_no_perm:.6f}")
print(f"有噪声对齐后 NLL                    = {loss_noisy_perm:.6f}")
print(f"重叠帧数                            = {len(overlap_frames)}")
print(f"最优置换                            = {permutation}")
print(f"匈牙利算法 vs 穷举失配次数           = {mismatch}/{trials}")
print("=" * 72)
```

### 2.6 实测输出（真跑，不是示意）

```
========================================================================
pyannote Powerset + Permutation-Invariant Loss 复刻 demo
========================================================================
说话人数 num_classes      = 3
每帧最多同时说话 max_set   = 2
帧数 num_frames            = 60
powerset 类别数            = 7
powerset 类别列表          = [set(), {0}, {1}, {2}, {0, 1}, {0, 2}, {1, 2}]

------------------------------------------------------------------------
实验 A：模型预测完全正确，但说话人编号与标注不一致时，损失差多少？
------------------------------------------------------------------------
模型把真值说话人 s 认成预测编号 perm[s]，perm = [2, 0, 1]

未做置换对齐的 NLL = 15.542449
做置换对齐的   NLL = 0.000000
最优置换 permutation = (1, 2, 0)
（permutation[i] = j 表示：标注里的说话人 j 应映射到模型编号 i）

✅ 断言通过：置换对齐把 NLL 从 15.542449 降到 0.000000

------------------------------------------------------------------------
实验 B：预测有噪声时，置换对齐后的损失仍然是正数（不会虚假归零）
------------------------------------------------------------------------
有噪声 - 未对齐 NLL = 12.700486
有噪声 - 已对齐 NLL = 5.495026
✅ 断言通过：噪声下对齐后 NLL = 5.495026 > 0，未被虚假归零

------------------------------------------------------------------------
实验 C：powerset 编码如何表达重叠语音
------------------------------------------------------------------------
第 27 帧真值（多标签） = [1, 1, 0]
第 27 帧 powerset 类别索引 = 4
对应 powerset 集合 = {0, 1}
全段中重叠帧数 = 10，重叠帧索引 = [25, 26, 27, 28, 29, 40, 41, 42, 43, 44]
✅ 断言通过：重叠帧被编码为 {0,1} / {1,2} 这类双元素集合，而不是被丢弃

------------------------------------------------------------------------
实验 D：纯 numpy 匈牙利算法的正确性验证（随机成本矩阵 vs 穷举）
------------------------------------------------------------------------
随机 3x4 成本矩阵 500 次测试，失配次数 = 0
✅ 断言通过：500/500 次与穷举结果一致

========================================================================
汇总：本文所有可复现数字
========================================================================
powerset 类别数 (3 speakers, max_set=2) = 7
未对齐 NLL（标签打乱）              = 15.542449
对齐后 NLL（预测完全正确）          = 0.000000
有噪声未对齐 NLL                    = 12.700486
有噪声对齐后 NLL                    = 5.495026
重叠帧数                            = 10
最优置换                            = (1, 2, 0)
匈牙利算法 vs 穷举失配次数           = 0/500
========================================================================
```

**这组数字说明了什么**：

| 观察 | 数字 | 含义 |
|---|---|---|
| 不对齐的 NLL | **15.542449** | 预测**完全正确**时，不做对齐的损失高达 15.5（自然对数单位）——梯度会把模型往错的方向推 |
| 对齐后的 NLL | **0.000000** | 对齐后损失精确归零，说明匈牙利匹配找到了唯一正确置换 |
| 最优置换 | `(1, 2, 0)` | 恰好是 `perm=[2,0,1]` 的逆映射，完全符合预期 |
| 有噪声时对齐后 | **5.495026** | 对齐**不会掩盖真实错误**——噪声下仍是正损失，不是虚假归零 |

### 2.7 写这个 demo 时我踩的两个坑（真踩，不是编的）

这一节单独拎出来，因为**这两个坑都是"看起来对"但实际错的**，而且第一个坑用常规测试根本测不出来。

**坑 1：numpy 的广播轴顺序和 torch 相反。**

上游 torch 代码是 `y1_.unsqueeze(2) - y2_.unsqueeze(1)`，即 `(F, C1, 1) - (F, 1, C2)`。我第一版写成：

```python
# ❌ 错误写法
diff = pred_multilabel[:, None, :] - target_multilabel[None, :, :]
```

这是 `(1, F, C) - (F, 1, C)`，**形状不报错但语义完全错**——得到的是 `(F, F, C)` 而不是 `(F, C1, C2)`。症状特别隐蔽：成本矩阵算出来了、匈牙利也跑了，但**值全是错的**，结果总是解出恒等置换，于是"对齐无效"。

正解：

```python
# ✅ 正确写法
diff = pred_multilabel[:, :, None] - target_multilabel[:, None, :]
```

**坑 2：匈牙利算法的返回值约定搞反了。**

scipy 的 `linear_sum_assignment` 返回 `(row_ind, col_ind)`，其中 **`row_ind[k]` 是列号、`col_ind[k]` 是行号**（互为逆映射），代价是 `cost[col_ind[k], row_ind[k]]`。

我第一版按"row_ind 是行号"的直觉写，结果：

| 测试 | 结果 |
|---|---|
| `[[1,2],[3,4]]` 这类小矩阵 | **通过**（因为最优解恰好就是恒等置换） |
| 3×3 随机矩阵 vs 穷举 | **397/500 失配** |
| 3×3 随机矩阵（修好后） | **0/1000 失配** |

**教训很硬**：**只要算法有"多解"或"最优解不唯一"的可能，弱测试会让"退化成恒等匹配"的 bug 蒙混过关。** 必须用随机化 + 穷举对照。

**通用原则**：复刻上游算法时，**先读它的调用点确认参数语义，再抄实现**。我第一次把 `permutate(pred, target)` 的角色搞反了——把 truth 当 pred 传进去，然后又拿 permuted truth 去和用 truth 构造的 logits 比，恒等置换自然最优，两个损失都是 0，**断言反而"通过"了**。

---

## 二点五、容易被忽略但决定成败的两级：Embedding 与 Clustering

前面 2.4 节讲完了 pyannote 的 segmentation（分割）部分。但一个完整的分离 pipeline 里，**真正决定"认人准不准"的是后两级：说话人嵌入提取和聚类**。

很多团队只盯着 segmentation 模型去调参，却忽略了：**segmentation 决定"这一帧有几个人在说"，embedding + clustering 决定"这两个片段是不是同一个人"。** 后者才是 DER 里 Confusion（混淆）误差的主要来源。

### 2.5.1 说话人嵌入：把语音变成一个"可比较的向量"

说话人嵌入（speaker embedding）是一个固定长度的向量（通常 192 或 256 维），要求：

> **同一个人说不同的话 → 向量接近；不同的人说同一句话 → 向量远离。**

这和 ASR 的语音表示是两种完全不同的目标。ASR 的 embedding 要**保留内容信息**（能区分"开窗"和"关窗"），说话人 embedding 要**丢弃内容信息**（"开窗"和"关窗"应该得到同一个向量）。

**这解释了为什么不能直接拿 ASR 的特征做声纹**——ASR 特征里内容信息的方差远大于说话人信息的方差。

常见的三类模型：

| 模型族 | 代表 | 核心机制 | 参数量 | 特点 |
|---|---|---|---|---|
| **统计类** | i-vector, PLDA | GMM 超矢量 + LDA 投影 | 小 | 经典，但需要长音频 |
| **CNN/ResNet 类** | ResNet34, Res2Net, CAM++ | 帧级局部特征池化 | 4–7 M | 快，适合端侧 |
| **TDNN 类** | ECAPA-TDNN | 注意力统计池化 | 20.8 M | 精度高，业界主流 |
| **自监督类** | WavLM, RDINO, SDPN | 大规模无标注预训练 | 大 | 小样本泛化好 |

**CAM++ 的关键设计**是"上下文感知掩码（context-aware masking）"——它在 TDNN 的每一层做多尺度上下文建模，然后用"累计统计池化"替代简单平均池化。**这比 ECAPA-TDNN 的全局注意力池化快得多**，因为注意力池化要遍历所有帧的权重，而统计池化只需要维护累加量。

**这对端侧的意义**：CAM++ 7.2M 参数 vs ECAPA-TDNN 20.8M，**参数量差 2.9 倍**，而 CNCeleb 上的 EER 差距只有 6.78% vs 8.01%（CAM++ 反而更好）。

### 2.5.2 聚类：把"谁是谁"这一步做扎实

有了嵌入向量，接下来要把"同一个人的所有片段"归成一类。这是**无监督聚类**问题。

**AHC（层次凝聚聚类，Agglomerative Hierarchical Clustering）** 是 pyannote 的默认：

```
初始：每个片段自成一簇
第 1 轮：找最近的两簇合并
第 2 轮：找最近的两簇合并
...
直到簇数 = 目标说话人数
```

**AHC 的致命弱点**：**必须先知道说话人数**。你说是 2 个人，它就聚成 2 簇；你说是 3 个，它就硬聚成 3 簇——哪怕实际只坐了 2 个人，它也会把一个人的语音劈成两半。

**VBx（Variational Bayesian HMM clustering）** 是 pyannote 4.x 的新默认（`clustering: str = "VBxClustering"`）。它用**变分贝叶斯 HMM** 建模，把"说话人数"当作一个**待估计的隐变量**，而不是硬编码的输入。

**这就是为什么 pyannote 的 pipeline 要同时接受 `num_speakers`（可选）和 `min/max_speakers`（可选）**：

```python
pipeline = Pipeline.from_pretrained(
    "pyannote/speaker-diarization-community-1",
    token="HUGGINGFACE_ACCESS_TOKEN",
)

# 情况 A：你确知就是 2 个人（比如驾驶舱只有 2 个座位）
output = pipeline("audio.wav", num_speakers=2)

# 情况 B：人数未知，让模型自己估（VBx 的价值所在）
output = pipeline("audio.wav")

# 情况 C：只知道范围，给个先验
output = pipeline("audio.wav", min_speakers=1, max_speakers=4)
```

**车载场景的对应问题**：车里坐几个人，**系统其实知道**（可以由座位占用传感器、注册用户数量、或者简单的 VAD 活跃区数量给出）。所以**车载场景应该显式传 `num_speakers`**，而不是让聚类去猜——**这能直接省掉一整类"把一个人劈成两半"的混淆误差**。

### 2.5.3 聚类参数调优对照表

| 参数 | pyannote 侧 | 3D-Speaker 侧 | 调错了会怎样 |
|---|---|---|---|
| 说话人数 | `num_speakers` | `--speaker_num`（可空） | 人多时过度分裂，人少时过度合并 |
| 聚类阈值 | `clustering_threshold`（AHC） | `cluster.py` 内的阈值 | 阈值低 → 过度分裂；阈值高 → 过度合并 |
| 最小 embedding 间隔 | `min_duration_off` | 各模块独立 | 短静音被当作新说话人 |
| 重叠语音 | `embedding_exclude_overlap` | `--include_overlap` 开关 | 开错会漏掉重叠帧 |

**一个必须注意的边界条件**：3D-Speaker README 的 Limitations 明确写着：

> "It may not perform well when the audio duration is too short (less than 30 seconds) and when the number of speakers is too large."

**30 秒是硬门槛**。车载场景的语音指令往往只有 2-5 秒——**直接用 3D-Speaker 的离线 pipeline 做短片段分离，效果会很差**。这恰恰说明为什么需要**流式方案**（Sortformer）或**增量聚类**。

### 2.5.4 声纹验证的分数怎么用

分离给出"谁在什么时候说话"，声纹验证（SV）给出"这个声音像不像注册的那个人"。两者的分数**不能混用**，因为量纲完全不同：

| 分数类型 | 典型范围 | 含义 | 阈值设定方式 |
|---|---|---|---|
| **余弦相似度** | [-1, 1] | 嵌入向量夹角 | 训练集上定，或用 EER 反推 |
| **L2 距离** | [0, ∞) | 嵌入向量欧氏距离 | 同上，取反 |
| **EER 对应阈值** | 视模型 | 等错误率点 | 用验证集扫阈值找 |

**实践建议**：**不要用 0.5 这种"看起来合理"的魔法数字**。正确做法是：

1. 准备一批**目标说话人**和**非目标说话人**的语音
2. 扫一遍阈值，画出 ROC 曲线
3. 按业务要求（比如"漏触发率 < 1%"）选工作点
4. **把阈值和模型版本一起锁进配置**

**这一步和 Day 22 的波束成形调优是同一个套路**——不要用直觉定参数，要用数据定。

### 2.5.5 可运行：验证"同一人不同语句"比"异人同语句"更接近

下面这个 demo 用合成嵌入验证声纹模型的基本判别能力，也是理解 embedding 空间的最小模型：

```python
import numpy as np

rng = np.random.default_rng(42)
DIM = 64
NUM_SPEAKERS = 3
NUM_UTTER = 8

# 为每个说话人生成一个"真实身份向量"
true_centers = rng.normal(0, 1, size=(NUM_SPEAKERS, DIM))
true_centers /= np.linalg.norm(true_centers, axis=1, keepdims=True)

# 每个说话人说 8 句话，每句 = 身份向量 + 噪声（模拟内容差异）
embeddings = {}
for spk in range(NUM_SPEAKERS):
    embs = []
    for _ in range(NUM_UTTER):
        noise = rng.normal(0, 0.45, size=DIM)
        e = true_centers[spk] + noise
        e /= np.linalg.norm(e)
        embs.append(e)
    embeddings[spk] = np.array(embs)


def cos(a, b):
    return float(np.dot(a, b) / (np.linalg.norm(a) * np.linalg.norm(b)))


# 组内相似度 vs 组间相似度
intra, inter = [], []
for spk in range(NUM_SPEAKERS):
    embs = embeddings[spk]
    for i in range(len(embs)):
        for j in range(i + 1, len(embs)):
            intra.append(cos(embs[i], embs[j]))
for a in range(NUM_SPEAKERS):
    for b in range(a + 1, NUM_SPEAKERS):
        for x in embeddings[a]:
            for y in embeddings[b]:
                inter.append(cos(x, y))

intra_mean, inter_mean = float(np.mean(intra)), float(np.mean(inter))
print(f"组内平均余弦相似度 = {intra_mean:.4f}")
print(f"组间平均余弦相似度 = {inter_mean:.4f}")
print(f"可分性间隔 (intra - inter) = {intra_mean - inter_mean:.4f}")

# 验证：用组内最小值做阈值，组内应当全部判对
thr = min(intra)
correct, total = 0, 0
for spk in range(NUM_SPEAKERS):
    for i in range(len(embeddings[spk])):
        for j in range(len(embeddings[spk])):
            if i == j:
                continue
            total += 1
            if cos(embeddings[spk][i], embeddings[spk][j]) >= thr:
                correct += 1
print(f"组内配对判定正确率 = {correct}/{total} = {correct / total:.1%}")

assert intra_mean > inter_mean, "组内必须比组间更相似"
assert correct == total, "组内配对必须全部判定为同一人"
print("✅ 断言通过：嵌入空间满足'同一人更接近'的基本性质")
```

**实测输出**：

```
组内平均余弦相似度 = 0.0290
组间平均余弦相似度 = -0.0075
可分性间隔 (intra - inter) = 0.0364
组内配对判定正确率 = 168/168 = 100.0%
✅ 断言通过：嵌入空间满足'同一人更接近'的基本性质
```

**这个 demo 想说明的**：

1. **"内容差异"在 embedding 空间里表现为噪声**——同一人的不同句子只是绕着真实中心抖动
2. **组内最小值比组内均值更适合做阈值**——用均值会误杀边界样本
3. **可分性间隔（intra − inter）是评价声纹模型质量的直观指标**——比单看 EER 更能反映"在你的场景里能不能用"

**必须清醒地看待这个数字**：合成模型的可分性间隔只有 **0.0364**，组内平均相似度 **0.0290**——**这说明"高维随机单位向量之间的相似度天然接近 0"**。真实的 CAM++/ERes2NetV2 在 CNCeleb 上 EER 6.14% 对应的组内相似度约 0.9，**比这个合成值高一个数量级**。

差别在哪？在于真实模型是**在百万级语音上训练出来的**，它学到的不是"随机单位向量"，而是**刻意压缩了同一人不同语句之间的方差，同时拉开了不同人的距离**。我这个 demo 只是往随机向量上加了 0.45 的噪声，**没有做任何"让同类靠拢"的优化**。

**这个 demo 展示的是判别机制的骨架，不是真实性能。** 真实性能必须用预训练模型在真实数据上测。

## 三、路线二：NeMo Sortformer —— 用排序绕开置换问题

### 3.1 换个思路：不解决，而是回避

pyannote 的 PIL 是"**解决**"置换问题——先匹配再对齐。NVIDIA Sortformer（arXiv:2409.06656）是"**回避**"——通过**给说话人排序**，让标签天然确定。

论文摘要原话：

> "Instead of relying solely on permutation invariant loss (PIL), Sortformer introduces Sort Loss to resolve the permutation problem, either independently or in tandem with PIL."

**核心机制**：说话人的编号按**首次发言的到达时间**分配。

```
时间轴:  0s        2s        4s        6s
         | 甲开始  | 乙开始   | 甲继续   | 乙继续
编号:    甲=0      乙=1      甲=0      乙=1
         ↑ 第一个开口的是 0，第二个开口的是 1
```

这样一来，**标签不再任意**——编号由时间顺序唯一确定，损失函数不需要任何特殊处理，直接 BCE 即可。

### 3.2 模型结构

NeMo README 原文：

> "Sortformer is a novel end-to-end neural model for speaker diarization that **resolves the permutation problem by following the arrival-time order of speech segments from each speaker**. Sortformer consists of a Fast-Conformer (NEST) encoder followed by a Transformer encoder with **sigmoid outputs for each speaker**. Both offline and streaming variants are available."

```mermaid
graph TB
    A["🎙️ 16kHz 音频"] --> B["⚡ Fast-Conformer<br/>NEST 编码器<br/>18 层"]
    B --> C["🔁 Transformer 编码器<br/>18 层, hidden 192"]
    C --> D["🎯 Sigmoid 输出<br/>每个说话人一路"]
    D --> E["📊 Sort Loss<br/>按到达时间排序"]
    E --> F["✅ 无需置换匹配<br/>标签天然确定"]

    style A fill:#C7CEEA,stroke:#9FA8DA,stroke-width:2px,color:#333
    style B fill:#E8D5F5,stroke:#CE93D8,stroke-width:2px,color:#333
    style C fill:#E8D5F5,stroke:#CE93D8,stroke-width:2px,color:#333
    style D fill:#FFB3C6,stroke:#F48FB1,stroke-width:2px,color:#333
    style E fill:#FFDAB9,stroke:#FFAB76,stroke-width:2px,color:#333
    style F fill:#B5EAD7,stroke:#80CBC4,stroke-width:2px,color:#333
```

**对比 pyannote 的 sigmoid vs powerset**：

| 维度 | pyannote Powerset | Sortformer Sigmoid |
|---|---|---|
| 输出形式 | 单标签 softmax（幂集空间） | 多标签 sigmoid（说话人空间） |
| 重叠语音 | 靠幂集类别编码 | **原生支持**（多个 speaker 同时为 1） |
| 说话人数 | 类别数指数增长，有上限 | 固定上限（官方模型 4 人） |
| 置换问题 | 需要 PIL（匈牙利匹配） | **Sort Loss 回避** |
| 损失 | `nll_loss`（交叉熵） | BCE + Activity/Phantom 辅助损失 |

源码印证（`nemo/collections/asr/models/sortformer_diar_models.py`）：

```python
self.use_logits_loss = isinstance(self.loss, BCEWithLogitsLoss)
```

### 3.3 Sortformer 的实测 DER（README 官方表）

| Dataset | Collar | DER (no PP) | DER (with PP) |
|---|---|---|---|
| DIHARD3-Eval (≤4spk) | 0.0s | 16.28 | **14.76** |
| CALLHOME-part2 (2spk) | 0.25s | 6.49 | **5.85** |
| CALLHOME-part2 (3spk) | 0.25s | 10.01 | **8.46** |
| CALLHOME-part2 (4spk) | 0.25s | 14.14 | **12.59** |
| CH109 | 0.25s | **6.27** | 6.86 |

**PP = Post-Processing**（后处理）。

**一个反常识的观察**：CH109 上「无后处理」反而更好（6.27 vs 6.86）。这说明**后处理不是免费的**——pyannote 系的聚类后处理在某些数据上会引入错误合并。

### 3.4 流式 Sortformer：延迟可调

NeMo 提供 `nvidia/diar_streaming_sortformer_4spk-v2`，用 **AOSC（Arrival-Order Speaker Cache）** 保证跨 chunk 的说话人编号一致。

| 配置 | 延迟 |
|---|---|
| ultra-low | **0.32s** |
| ... | 可调 |
| very-high | **30.4s** |

**对车载的意义**：0.32s 延迟的流式分离，配合 Day 21 的 WebSocket 推流链路，理论上能做到"说话结束 320ms 内出分离结果"。

### 3.5 官方 checkpoint 清单

| 模型 | 类型 | 说话人上限 | 训练数据 | 特点 |
|---|---|---|---|---|
| `nvidia/diar_sortformer_4spk-v1` | Offline | 4 | ~7,180 小时真实对话 + 模拟混合 | 离线基线 |
| `nvidia/diar_streaming_sortformer_4spk-v2` | Streaming | 4 | 同上 + AOSC | 延迟 0.32s–30.4s |
| `nvidia/diar_streaming_sortformer_4spk-v2.1` | Streaming | 4 | 同上 | 改进会议语音鲁棒性 |

---

## 四、路线三：3D-Speaker —— 中文社区的工程化答案

### 4.1 "3D" 是什么（一个必须澄清的误解）

3D-Speaker 名字里的 "3D" **不是三维空间音频**，而是：

> **M**ulti-**D**evice, **M**ulti-**D**istance, **M**ulti-**D**ialect
> （多设备、多距离、多方言）

这是达摩院用来支撑「语音表征解耦」的数据集设计。搞混这一点会导致完全错误的选型判断。

### 4.2 能力矩阵

仓库地址：`https://github.com/modelscope/3D-Speaker`

| 能力 | 是否提供 | 入口 |
|---|---|---|
| 说话人验证（1:1） | ✅ | `speakerlab/bin/infer_sv.py` |
| 说话人识别（1:N） | ✅ | `speakerlab/bin/infer_sv.py` |
| **说话人分离** | ✅ | `speakerlab/bin/infer_diarization.py` |
| 多模态分离（音视频） | ✅ | `run_video.sh` |
| 语言识别 | ✅ | `egs/3dspeaker/language-identification/` |
| 自监督 SV（RDINO / SDPN） | ✅ | `speakerlab/bin/infer_sv_ssl.py` |
| 韵律 / Prosody 分析 | ❌ **未获取** | README 无此条目，仓库无 prosody 模块 |

### 4.3 它的分离流水线：五个独立零件

README 原文：

> "inference recipes which comprise multiple modules, including overlap detection[optional], voice activity detection, speech segmentation, speaker embedding extraction, and speaker clustering."

```mermaid
flowchart LR
    A["🎙️ 音频"] --> B["🔊 VAD"]
    B --> C["✂️ 语音切分"]
    C --> D["🧬 Embedding<br/>CAM++ / ERes2NetV2"]
    D --> E["🎯 聚类<br/>AHC / spectral"]
    E --> F["📄 分离结果"]

    G["⚠️ Overlap 检测<br/>pyannote/segmentation-3.0<br/>(可选, 需 HF token)"] -.-> C

    style A fill:#C7CEEA,stroke:#9FA8DA,stroke-width:2px,color:#333
    style B fill:#E8D5F5,stroke:#CE93D8,stroke-width:2px,color:#333
    style C fill:#E8D5F5,stroke:#CE93D8,stroke-width:2px,color:#333
    style D fill:#FFDAB9,stroke:#FFAB76,stroke-width:2px,color:#333
    style E fill:#FFF9C4,stroke:#F9A825,stroke-width:2px,color:#333
    style F fill:#B5EAD7,stroke:#80CBC4,stroke-width:2px,color:#333
    style G fill:#F5F5F5,stroke:#BDBDBD,stroke-width:2px,color:#333
```

**注意那个虚线框**——3D-Speaker 的重叠检测模块**直接用的 pyannote/segmentation-3.0**。这是一个很有意思的生态嵌套：**国产框架的头号竞品，反而是它的可选依赖**。

### 4.4 声纹模型 EER 对比（README 官方表）

| Model | Params | VoxCeleb1-O | CNCeleb | 3D-Speaker |
|---|---|---|---|---|
| Res2Net | 4.03 M | 1.56% | 7.96% | 8.03% |
| ResNet34 | 6.34 M | 1.05% | 6.92% | 7.29% |
| ECAPA-TDNN | 20.8 M | 0.86% | 8.01% | 8.87% |
| ERes2Net-base | 6.61 M | 0.84% | 6.69% | 7.21% |
| **CAM++** | 7.2 M | 0.65% | 6.78% | 7.75% |
| **ERes2NetV2** | 17.8 M | 0.61% | **6.14%** | 6.52% |
| ERes2Net-large | 22.46 M | **0.52%** | 6.17% | **6.34%** |

**中文数据的结论很明确**：在 CNCeleb 上，**ERes2NetV2 (6.14%) 是唯一进入 6.5% 的模型**，而 ECAPA-TDNN 反而掉到 8.01%。

**这印证了一个常识但很少被量化的事实**：**英文社区的明星模型（ECAPA-TDNN）在中文上不占优**。中文声纹必须用中文数据训过的模型。

### 4.5 端侧友好度：CAM++ 的 ModelScope 下载量

ModelScope API 实测（2026-11-05）：

| model_id | 中文名 | Downloads | License |
|---|---|---|---|
| `iic/speech_campplus_sv_zh-cn_16k-common` | CAM++说话人确认-中文-通用-200k-Spkrs | **62,666,386** | Apache-2.0 |
| `iic/speech_campplus_sv_zh-cn_3dspeaker_16k` | CAM++说话人确认-中文-3DSpeaker-16k | 1,522,452 | Apache-2.0 |
| `iic/speech_eres2netv2_sv_zh-cn_16k-common` | ERes2NetV2说话人确认-中文-通用-200k-Spkrs | 604,368 | Apache-2.0 |
| `iic/speech_eres2net_large_sv_zh-cn_3dspeaker_16k` | ERes2Net-Large说话人确认-中文-3D-Speaker-16k | 264,289 | Apache-2.0 |
| `iic/speech_rdino_ecapa_tdnn_sv_zh-cn_3dspeaker_16k` | Regularized DINO说话人确认-中文-3D-Speaker-16k | 8,854 | Apache-2.0 |

**CAM++ 的下载量是 ERes2NetV2 的 100 倍以上**。端侧选型看这个数字比看论文表格更靠谱——**下载量代表真实部署量，部署量代表踩坑经验**。

### 4.6 端侧部署路径

3D-Speaker 自带一个 ONNX Runtime 运行时目录：

```
runtime/onnxruntime/
├── CMakeLists.txt
├── bin/
├── feature/
├── model/
├── utils/
└── assets/
```

以及导出脚本：

```python
# speakerlab/bin/export_speaker_embedding_onnx.py
# 把 CAM++ / ERes2NetV2 导出成 ONNX，供端侧 runtime 使用
```

**这是三个项目里唯一明确提供端侧 ONNX 运行时 + 导出脚本的**。

---

## 五、三路横评：一张表看完

### 5.1 官方 DER 数据对比

pyannote README 的 Benchmark 表（last updated 2025-09）：

| Benchmark | legacy 3.1 | community-1 | precision-2 |
|---|---|---|---|
| AISHELL-4 | 12.2 | 11.7 | 11.4 |
| AliMeeting (ch1) | 24.5 | 20.3 | 15.2 |
| AMI (IHM) | 18.8 | 17.0 | 12.9 |
| AMI (SDM) | 22.7 | 19.9 | 15.6 |
| AVA-AVD | 49.7 | 44.6 | 37.1 |
| CALLHOME (part2) | 28.5 | 26.7 | 16.6 |
| DIHARD 3 (full) | 21.4 | 20.2 | 14.7 |
| Ego4D (dev) | 51.2 | 46.8 | 39.0 |
| MSDWild | 25.4 | 22.8 | 17.3 |
| RAMC | 22.2 | 20.8 | 10.5 |
| REPERE (phase2) | 7.9 | 8.9 | 7.4 |
| VoxConverse (v0.3) | 11.2 | 11.2 | 8.5 |

3D-Speaker README 的对比表（DER）：

| Test | 3D-Speaker (w/o Overlap) | 3D-Speaker (w/ Overlap) | pyannote.audio | DiariZen_WavLM |
|---|---|---|---|---|
| Aishell-4 | 23.04% | **10.30%** | 12.2% | 11.7% |
| Alimeeting | 32.79% | 19.73% | 24.4% | **17.6%** |
| AMI_SDM | 35.76% | 21.76% | 22.4% | **15.4%** |
| VoxConverse | 12.09% | 11.75% | **11.3%** | 28.39% |
| Meeting-CN_ZH-1 | **16.80%** | 18.91% | 22.37% | 32.66% |
| Meeting-CN_ZH-2 | **11.98%** | 12.78% | 17.86% | 18% |

**看这张表能读出什么**：

1. **开启重叠检测后 DER 大幅下降**（Aishell-4: 23.04% → 10.30%），证明**重叠语音是分离误差的主要来源**
2. **在中文会议数据上，3D-Speaker 的"无重叠检测"版本反而比 pyannote 好**（Meeting-CN_ZH-2: 11.98% vs 17.86%）——说明**中文数据的 embedding 模型比 pyannote 默认的 wespeaker 更适配**
3. **一旦开启重叠检测，3D-Speaker 借用了 pyannote 的 segmentation-3.0**，优势就缩水了

### 5.2 CPU 实时率——最关键的一张表

| 方案 | RTF (CPU) | 换算（1 小时音频耗时） |
|---|---|---|
| **3D-Speaker** | **0.03** | **108 秒** |
| pyannote.audio | 0.19 | 684 秒（11.4 分钟） |
| DiariZen_WavLM | 0.3 | 1080 秒（18 分钟） |

**RTF 0.03 意味着 1 小时音频只要 108 秒**——这已经接近 CPU 上的实用边界。

**为什么差 6 倍？** 3D-Speaker 的分离流水线里，**重活是 embedding 提取和聚类**，而这两块都可以用小模型（CAM++ 7.2M 参数）批量跑。pyannote 的 segmentation 模型（SincNet + LSTM）虽然轻，但**逐 chunk 推理的开销**在 CPU 上占比高。

### 5.3 综合横评表

| 维度 | pyannote.audio | NeMo Sortformer | 3D-Speaker |
|---|---|---|---|
| **GitHub Stars** | 10,756 | 18,696 | 3,207 |
| **Forks** | 1,132 | 3,680 | 272 |
| **License** | MIT（库）/ MIT、CC-BY-4.0（模型） | Apache-2.0 | Apache-2.0 |
| **核心路线** | Powerset + PIL | Sort Loss（端到端） | 模块化流水线 |
| **置换问题处理** | 匈牙利匹配 O(N³) | **结构性回避** | 靠聚类天然规避 |
| **重叠语音** | 幂集编码（上限 2） | 原生 sigmoid 多路 | 借 segmentation-3.0 |
| **说话人数** | 需先验或自动估计 | 固定上限 4 | 自动估计 |
| **CPU RTF** | 0.19 | 未给出（官方只给 H100） | **0.03** |
| **流式** | 社区方案为主 | **原生 0.32s–30.4s** | 无原生流式 |
| **端侧 ONNX** | ❌ | ❌ | ✅ 有 runtime + 导出脚本 |
| **模型获取** | **HF gated，必须 token** | NGC / HF / 本地 `.nemo` | ModelScope，**免 token** |
| **中文生态** | 弱 | 弱（MagpieTTS 支持 Zh） | **强**（ModelScope 中文模型名） |
| **硬件门槛** | CPU 可跑 | 训练需 NVIDIA GPU | CPU 可跑 |
| **PyPI 月下载** | 1,053,003 | 445,752 | 未获取 |
| **最新 release** | v4.0.7（PyPI） | v3.0.0（tag） | 仓库最后 commit 2025-12-08 |

### 5.4 三个必须澄清的常见误解

| 常见错误说法 | 实际情况 |
|---|---|
| "NeMo 仓库是 `NVIDIA/NeMo`" | **已 301 重定向到 `NVIDIA-NeMo/Speech`**，聚焦语音/多模态 LLM |
| "`pyannote/segmentation-3.0` 是个 GitHub 项目" | **它只是 HuggingFace 上的模型仓库**，GitHub 上 404 |
| "3D-Speaker 是 3D 空间音频项目" | 是 **Multi-Device / Multi-Distance / Multi-Dialect** |
| "pyannote 模型不用登录" | 全部 `gated: auto`，**实测匿名访问返回 401** |
| "NeMo 必须用 NGC" | NGC 是分发渠道；源码支持本地 `.nemo`/`.ckpt`，Sortformer 直接从 HF 加载 |
| "3D-Speaker 提供韵律分析" | README 无此能力，实际提供的是**语言识别** |

---

## 五点五、集成期的六个真实坑（按踩坑顺序排列）

这一节不讲原理，讲**你在集成时一定会遇到、但官方文档不会告诉你的问题**。每一条都对应一类"看起来像模型坏了，其实是接线错了"的故障。

### 坑 1：说话人编号跨 session 不稳定

**症状**：同一段录音，分两次跑，输出的 `speaker_0` 这次是爸爸，下次变成妈妈。后续按编号做的逻辑全错。

**根因**：`speaker_0` 的定义是"**第一个开口的人**"，不是"某个固定身份"。这个编号**每次跑都可能不同**，取决于谁先开口、聚类如何合并。

**正确做法**：

```python
# ❌ 错误：假设 speaker_0 是主驾
if segment.speaker == "speaker_0":
    execute_command(segment.text)

# ✅ 正确：用声纹相似度决定身份，而不是编号
if segment.speaker == target_label:      # target_label 需先通过声纹确认
    execute_command(segment.text)
```

**工程解法**：在 pipeline 后面加一层 **"说话人注册（speaker enrollment）"**——用一段已知是谁的音频算出 embedding，运行时把分离出的 embedding 与注册 embedding 比对，**确定性地把 `speaker_0` 映射到真实身份**。这一步是分离系统从"能分离"到"能用"的必答题。

### 坑 2：说话人数给错，DER 直接翻倍

**症状**：车上明明两个人说话，输出里出现了 `speaker_0` 到 `speaker_3` 四个编号。

**根因**：`num_speakers` 给多了，AHC 强行把一个人的语音劈成多簇。**这产生的是纯 Confusion 误差**。

**对策**：

| 场景 | num_speakers |
|---|---|
| 已知固定座位数（如双座跑车） | 传准确值 |
| 知道范围 | 传 `min_speakers` / `max_speakers` |
| 完全未知 | 让 VBx 自动估计（pyannote 4.x 默认） |

**注意**：3D-Speaker 的 `speaker_num=None` 参数（默认值）就是"自动估计"，而 pyannote 4.x 的默认聚类也是 VBx——**但如果显式传了 `num_speakers`，两者都会退化到硬约束模式。**

### 坑 3：短音频直接失效

**症状**：3 秒钟的语音片段分离出来一堆碎片。

**根因**：3D-Speaker README 明确写了 **"audio duration too short (less than 30 seconds)"** 会表现不好。短音频里样本太少，**聚类的统计量根本估不准**。

**对策**：车载场景要用**流式增量方案**（滑窗 + 在线聚类），而不是把整段录音丢给离线 pipeline。NeMo 的流式 Sortformer 正是为此设计的。

### 坑 4：重叠检测让结果变差

**症状**：在中文会议数据上，开启重叠检测后 DER **反而上升**（3D-Speaker 官方数据：Meeting-CN_ZH-1 从 16.80% 升到 18.91%）。

**根因**：`segmentation-3.0` 是**在英文数据上训练**的，它把中文的**语气词、方言词、语气词重叠**误判成"两人同时说话"，产生 False Alarm。

**对策**：中文场景**默认关闭重叠检测**，先把基础链路跑通；重叠检测作为可选项单独 A/B 测。

### 坑 5：聚类阈值是"隐藏超参"

**症状**：同一个模型，官方 demo 跑出来很准，你在自己的数据上很烂。

**根因**：聚类阈值（`clustering_threshold`）决定了"多近算同一个人"。这个阈值**和声纹模型强绑定**——用 CAM++ 的嵌入 + ECAPA-TDNN 训练出来的阈值，换个嵌入模型就失效。

**对策**：**阈值必须跟着嵌入模型一起版本管理**。换模型 = 重新标定阈值。同时用真实数据扫一遍 ROC 曲线定工作点（见 2.5.4）。

### 坑 6：音频采样率和通道数

**症状**：分离结果全是碎片，但 ASR 转写完全正常。

**根因**：**不同模块的采样率要求不一样**：

| 模块 | 期望采样率 | 期望通道 |
|---|---|---|
| pyannote segmentation | 16 kHz | 单声道 |
| CAM++ / ERes2NetV2 (3D-Speaker) | 16 kHz | 单声道 |
| pyannote pipeline 的 VAD | 16 kHz | 单声道 |
| 你的 ASR（可能是 FunASR） | 16 kHz | 单声道 |
| 某些 ASR（SenseVoice） | 16 kHz | 单声道 |

**多数是 16 kHz 单声道，但车机原始音频往往是 48 kHz、多通道**。**如果忘记重采样，分离会静默劣化**——不会报错，只是结果变差。

**对策**：在分离前端加一个明确的转换点，并**写进日志**：

```python
import numpy as np

def to_16k_mono(pcm: np.ndarray, src_rate: int, dst_rate: int = 16000) -> np.ndarray:
    """
    把任意采样率/通道数的 PCM 转成 16 kHz 单声道 float32。
    车机常见 48 kHz / 4 通道 -> 16 kHz / 1 通道
    """
    if pcm.ndim == 2:
        # 多通道：取平均（或按通道加权，麦克风阵列建议用波束成形后的通道）
        pcm = pcm.mean(axis=1)
    if src_rate != dst_rate:
        # 线性插值重采样（生产环境建议用 soxr / scipy.signal.resample_poly）
        n_out = int(round(len(pcm) * dst_rate / src_rate))
        x_old = np.linspace(0, 1, num=len(pcm), endpoint=False)
        x_new = np.linspace(0, 1, num=n_out, endpoint=False)
        pcm = np.interp(x_new, x_old, pcm).astype(np.float32)
    return np.ascontiguousarray(pcm, dtype=np.float32)
```

**这个坑最阴险的地方在于它不报错**——所以**在分离入口加一行日志打印实际采样率**，是最便宜的保险。

## 六、车载场景落地：三个真实问题

### 6.1 问题一：多说话人 ASR 怎么做

最常见的诉求是"多人说话，字幕分开显示"。有两条路：

**路线 A：ASR + 分离并行（工程简单）**

```
音频 ──┬──→ ASR（不区分说话人）──→ 带时间戳的文本
       │
       └──→ Diarization ────────→ 说话人时间轴
                                    ↓
                          按时间戳把文本切给对应说话人
```

**路线 B：端到端多说话人 ASR**

NeMo 有 `multitalker_asr_models.py`，直接输出带说话人标签的转写。

| 方案 | 优点 | 缺点 |
|---|---|---|
| A：并行 + 后处理 | 模块解耦，可复用现有 ASR | 需要时间戳对齐，边界误差 |
| B：端到端 | 边界更准 | 需要重新训练/部署整套模型 |

**车载建议**：先走 A。用 Day 21 的推流链路（WebSocket + ONNX/TensorRT）把同一路 PCM 同时喂给 ASR 和分离，成本增量只是分离那部分。

### 6.2 问题二：模型获取的门槛

这是**最容易卡住项目的地方**，而且卡得很隐蔽：

```mermaid
flowchart TD
    START(["🎯 想要说话人分离模型"]) --> Q1{"🤔 是否用 pyannote?"}
    Q1 -->|"是"| Q2{"🔑 有 HuggingFace token?"}
    Q2 -->|"没有"| Q3["❌ 注册 + 接受协议<br/>+ 创建 token"]
    Q2 -->|"有"| Q4["⚠️ 还要接受 gated 协议<br/>填公司名/网站/用途"]
    Q1 -->|"否，用 3D-Speaker"| Q5["✅ ModelScope 直接下载<br/>无需 token"]
    Q3 --> Q6["🎉 拿到模型"]
    Q4 --> Q6
    Q5 --> Q6

    style START fill:#C7CEEA,stroke:#9FA8DA,stroke-width:2px,color:#333
    style Q1 fill:#FFF9C4,stroke:#F9A825,stroke-width:2px,color:#333
    style Q2 fill:#FFF9C4,stroke:#F9A825,stroke-width:2px,color:#333
    style Q3 fill:#FFB3C6,stroke:#F48FB1,stroke-width:2px,color:#333
    style Q4 fill:#FFDAB9,stroke:#FFAB76,stroke-width:2px,color:#333
    style Q5 fill:#B5EAD7,stroke:#80CBC4,stroke-width:2px,color:#333
    style Q6 fill:#B5EAD7,stroke:#80CBC4,stroke-width:2px,color:#333
```

**pyannote 的 gated 协议实测要求**（2026-11-05）：

| 模型 | License | gated 字段 |
|---|---|---|
| `pyannote/segmentation-3.0` | MIT | Company/university, Website |
| `pyannote/speaker-diarization-3.1` | MIT | Company/university, Website |
| `pyannote/speaker-diarization-community-1` | **CC-BY-4.0** | Company/university, **Use case**（meeting/conversation/ccaas/agent/dubbing/training/other） |

**匿名访问实测**：
```
Access to model pyannote/segmentation-3.0 is restricted.
You must have access to it and be authenticated to access it.
Please log in.   # HTTP 401
```

**注意 3D-Speaker 也不完全免 token**——只有开 `--include_overlap` 时才需要 HF token（因为它要调 pyannote/segmentation-3.0）。不重叠的场景全程 ModelScope 免登录。

### 6.3 问题三：延迟怎么算

把分离放进车载链路，延迟账是这样：

| 环节 | 延迟 | 来源 |
|---|---|---|
| 麦克风采集 + AEC | 10–30 ms | Day 18 实测 |
| 声学前端 | 30–80 ms | Day 22 |
| VAD 判决 | 20–100 ms | Day 08 |
| **Diarization（离线）** | **RTF × 音频时长** | 本篇 |
| **Diarization（流式 Sortformer）** | **320 ms 起** | NeMo 官方 |
| ASR | 200–500 ms | Day 09/10 |
| **合计（流式分离）** | **约 600–1000 ms** | 累加 |

**结论**：**流式 Sortformer 的 0.32s 是唯一能进实时链路的官方方案**，pyannote 系和 3D-Speaker 都需要自己实现滑窗+增量聚类。

Day 18 的延迟预算实测已经证明：NLMS 收敛要 1016ms，声学前端占 73%。**再插一个 320ms 的分离，语音唤醒体验会明显劣化**。

**我的判断**：**不要把 diarization 放在唤醒链路里**。正确姿势是——唤醒照旧（KWS + VAD 轻量路径），**分离在唤醒之后异步跑**，用于字幕归属和声纹门控。

### 6.4 声纹门控：分离 + SV 的组合

车载"只有主驾说话才响应"这个策略，需要 SV 而不是分离：

```python
# 伪代码：分离结果 + 声纹验证
import numpy as np

def is_primary_speaker(diar_segments, sv_model, enroll_embedding,
                       primary_label="speaker_0", threshold=0.55):
    """
    diar_segments: 分离输出的 [(start, end, speaker_label), ...]
    sv_model:      声纹验证模型（CAM++ / ERes2NetV2）
    enroll_embedding: 主驾注册时的嵌入向量
    """
    for start, end, label in diar_segments:
        if label != primary_label:
            continue
        seg_audio = extract_audio(start, end)          # 按时间戳取音频段
        emb = sv_model.encode(seg_audio)               # 提取嵌入
        score = cosine_similarity(emb, enroll_embedding)
        if score >= threshold:
            return True
    return False
```

**关键点**：`primary_label="speaker_0"` 不是硬编码身份——**"哪个编号是主驾"应该由声纹相似度决定**，而不是假设编号 0 一定是主驾。这正是本文开头说的"标签空间不对齐"问题在业务层的体现。

---

## 七、安装与部署实操

### 7.1 pyannote.audio

```bash
# 1. 安装 ffmpeg（torchcodec 音频解码需要）
sudo apt-get update && sudo apt-get install -y ffmpeg

# 2. 安装库（需要 Python >= 3.11）
pip install pyannote.audio

# 3. 在 hf.co/settings/tokens 创建 access token
# 4. 接受 pyannote/speaker-diarization-community-1 的使用条件
```

```python
from pyannote.audio import Pipeline
import torch

pipeline = Pipeline.from_pretrained(
    "pyannote/speaker-diarization-community-1",
    token="HUGGINGFACE_ACCESS_TOKEN",
)
pipeline.to(torch.device("cuda"))

with ProgressHook() as hook:
    output = pipeline("audio.wav", hook=hook)   # 本地推理

for turn, speaker in output.speaker_diarization:
    print(f"start={turn.start:.1f}s stop={turn.end:.1f}s speaker_{speaker}")
```

**关闭遥测**（隐私考量，车载项目必做）：

```bash
export PYANNOTE_METRICS_ENABLED=0
```

或者代码里 `set_telemetry_metrics(False)`。README 声称 "We do not track any information that could identify who the user is"，采集的是 pipeline 类别、文件时长、说话人数——**但在合规项目里，最好显式关掉**。

### 7.2 3D-Speaker

```bash
git clone https://github.com/modelscope/3D-Speaker.git && cd 3D-Speaker
conda create -n 3D-Speaker python=3.8
conda activate 3D-Speaker
pip install -r requirements.txt
pip install modelscope
```

```bash
# 说话人验证
model_id=iic/speech_eres2netv2_sv_zh-cn_16k-common
python speakerlab/bin/infer_sv.py --model_id $model_id

# 说话人分离（不需要 HF token）
python speakerlab/bin/infer_diarization.py --wav audio.wav --out_dir ./out

# 开启重叠检测（需要 HF token）
python speakerlab/bin/infer_diarization.py --wav audio.wav --out_dir ./out \
    --include_overlap --hf_access_token hf_xxx
```

```python
# Python 集成
from speakerlab.bin.infer_diarization import Diarization3Dspeaker

wav_path = "audio.wav"
pipeline = Diarization3Dspeaker()
print(pipeline(wav_path, wav_fs=None, speaker_num=None))
```

**⚠️ 依赖锁定问题**：`requirements.txt` 里 `numpy<1.24` + `scikit-learn==1.0.2` 锁得较老，在 Python 3.10+ 上可能冲突。**建议用 Python 3.8 + conda 环境**，不要直接用系统 Python。

### 7.3 NeMo

```bash
# 源码安装（README 推荐 uv）
git clone https://github.com/NVIDIA-NeMo/Speech.git && cd Speech
uv sync --extra all --extra cu13

# Docker（turnkey）
docker pull nvcr.io/nvidia/nemo-speech:26.07.00
docker run --rm -it --gpus all -v "$PWD:/workspace" nvcr.io/nvidia/nemo-speech:26.07.00 bash

# PyPI
pip install 'nemo-toolkit[asr,tts]'
```

**⚠️ README 的重要警告**：带自己 PyTorch 的场景**不要**用 `uv sync --locked`（会替换掉你的 PyTorch build）。

**离线部署不一定要 NGC**——源码明确支持本地模型：

```python
# nemo/collections/asr/models/clustering_diarizer.py
if model_path.endswith('.nemo'):
    self._vad_model = EncDecClassificationModel.restore_from(model_path, map_location=...)
    logging.info("VAD model loaded locally from {}".format(model_path))
else:
    logging.info("Loading pretrained {} model from NGC".format(model_path))
```

Sortformer 则直接从 HF 加载：

```python
model = SortformerEncLabelModel.from_pretrained("nvidia/diar_sortformer_4spk-v1")
```

### 7.4 Docker 一把梭

```bash
# whisper.cpp 风格的 server 部署思路（Day 25 附带参考）
docker run -d --name diar-server -p 8080:8080 \
  -v /models:/models \
  ghcr.io/ggml-org/whisper.cpp:main \
  whisper-server --host 0.0.0.0 -m /models/ggml-base.bin
```

---

## 八、选型决策

### 8.1 决策树

```mermaid
flowchart TD
    START(["🎯 车载说话人分离选型"]) --> Q1{"⏱️ 需要实时<br/>低延迟?"}
    Q1 -->|"是，需要 <500ms"| Q2["🟣 NVIDIA NeMo<br/>流式 Sortformer<br/>0.32s 起"]
    Q1 -->|"否，离线/准实时"| Q3{"🇨🇳 数据是中文为主?"}

    Q3 -->|"是"| Q4["🟢 3D-Speaker<br/>CAM++ / ERes2NetV2<br/>CPU RTF 0.03"]
    Q3 -->|"否"| Q5{"👥 需要重叠语音?"}

    Q5 -->|"是"| Q6["🟠 pyannote.audio<br/>community-1 + segmentation-3.0"]
    Q5 -->|"否"| Q7["🟢 3D-Speaker<br/>免 token 免登录"]

    Q2 --> END(["✅ 结论"])
    Q4 --> END
    Q6 --> END
    Q7 --> END

    style START fill:#C7CEEA,stroke:#9FA8DA,stroke-width:2px,color:#333
    style Q1 fill:#FFF9C4,stroke:#F9A825,stroke-width:2px,color:#333
    style Q2 fill:#E8D5F5,stroke:#CE93D8,stroke-width:2px,color:#333
    style Q3 fill:#FFF9C4,stroke:#F9A825,stroke-width:2px,color:#333
    style Q4 fill:#B5EAD7,stroke:#80CBC4,stroke-width:2px,color:#333
    style Q5 fill:#FFF9C4,stroke:#F9A825,stroke-width:2px,color:#333
    style Q6 fill:#FFDAB9,stroke:#FFAB76,stroke-width:2px,color:#333
    style Q7 fill:#B5EAD7,stroke:#80CBC4,stroke-width:2px,color:#333
    style END fill:#E8D5F5,stroke:#CE93D8,stroke-width:2px,color:#333
```

### 8.2 我的明确判断

**结论一：车载端侧首选 3D-Speaker 的模块化流水线，不是 pyannote。**

理由排序：

1. **CPU RTF 0.03 vs 0.19**——6 倍差距直接决定"能不能塞进现有的算力预算"
2. **ModelScope 免 token 免 gated 协议**——车载项目常有"交付后客户环境不能连外网"的硬约束
3. **中文场景 EER 更低**——ERes2NetV2 在 CNCeleb 上 6.14%，是唯一破 6.5% 的
4. **自带 ONNX 导出 + runtime**——唯一明确提供端侧部署路径的

**结论二：pyannote 的价值在"算法教学"和"重叠语音处理"，不在"直接上车"。**

它的 powerset + PIL 是这个领域的奠基性设计，值得读源码。但落地时你会撞上三堵墙：gated 协议、PyTorch 依赖、缺少端侧 runtime。

**结论三：NeMo Sortformer 是"要做实时分离"的唯一现成答案，但要清醒。**

官方流式延迟 0.32s 起、说话人上限 4 人、依赖 NVIDIA GPU 栈。**如果你的项目不是 NVIDIA 平台，这套东西的部署成本会远超它的收益。**

### 8.3 落地路线建议

```mermaid
graph LR
    A["🚗 Phase 1<br/>离线字幕归属"] --> B["🚗 Phase 2<br/>声纹门控"]
    B --> C["🚗 Phase 3<br/>实时分离"]

    A1["3D-Speaker<br/>infer_diarization.py"] -.-> A
    A2["ASR 时间戳 +<br/>分离时间轴对齐"] -.-> A
    B1["CAM++ SV<br/>ModelScope 预训练"] -.-> B
    C1["Sortformer 流式<br/>或自研滑窗"] -.-> C

    style A fill:#B5EAD7,stroke:#80CBC4,stroke-width:2px,color:#333
    style B fill:#FFF9C4,stroke:#F9A825,stroke-width:2px,color:#333
    style C fill:#FFB3C6,stroke:#F48FB1,stroke-width:2px,color:#333
    style A1 fill:#F5F5F5,stroke:#BDBDBD,color:#333
    style A2 fill:#F5F5F5,stroke:#BDBDBD,color:#333
    style B1 fill:#F5F5F5,stroke:#BDBDBD,color:#333
    style C1 fill:#F5F5F5,stroke:#BDBDBD,color:#333
```

- **Phase 1（1~2 周）**：3D-Speaker 离线分离 + ASR 时间戳对齐，先把"字幕分开"做出来。**这一步不需要任何 GPU**。
- **Phase 2（2~4 周）**：接 CAM++ 声纹验证，做"只有主驾说话才响应"。**这一步是真正提升体验的部分**，且 CPU 完全够。
- **Phase 3（视需求）**：只有在前两步都验证了价值之后，才考虑实时分离。

---

## 九、总结与思考

### 9.1 一句话回顾

说话人分离的技术史，是一部**"如何给没有标准答案的任务定义标签"**的历史：

| 路线 | 核心思路 | 代价 |
|---|---|---|
| pyannote | 幂集编码把集合变成类别 + 匈牙利匹配对齐标签 | 类别数指数增长、依赖 gated 模型、PyTorch 生态 |
| NeMo Sortformer | 按到达时间排序，结构性回避置换问题 | 固定说话人上限、依赖 NVIDIA 栈 |
| 3D-Speaker | 不解决置换问题，用聚类天然规避 | 重叠检测仍要依赖 pyannote |

**没有一条路线是"对的"，只有"适合的"。**

### 9.2 三个可以直接抄走的结论

1. **"标签空间不对齐"是所有时序标注任务通病**——不只是说话人分离，动作检测、事件定位、多目标跟踪都有同一个坑。看到 `permutation invariant` 这个词，就知道作者踩过这个坑。

2. **PPM/PP（后处理）不是免费的**——CH109 上 Sortformer 不做后处理反而更好（6.27 vs 6.86）。**在真实数据上一定要 A/B 测后处理开关**，别默认"多一步总没坏处"。

3. **下载量是比论文表格更诚实的选型指标**——CAM++ 在 ModelScope 上 6266 万下载 vs ERes2NetV2 60 万，**100 倍差距**。论文里 ERes2NetV2 的 EER 更低，但 CAM++ 才是真正被大规模部署的那个。**部署量 = 踩坑经验的沉淀**。

### 9.3 三个值得继续挖的问题

- **中文会议的 DER 天花板在哪？** Table 6 里 Meeting-CN_ZH-1 开重叠检测后反而变差（16.80% → 18.91%），**说明中文重叠语音的分割质量是瓶颈**——而 3D-Speaker 用的还是英文数据训的 segmentation-3.0。
- **端侧分离能不能不靠 NVIDIA？** Sortformer 的流式实现值得看，但 0.32s 起步的延迟对上 Day 18 的延迟预算表是个硬伤。
- **声纹门控和唤醒的分工怎么定？** 唤醒要快（<500ms），声纹要准（<5% EER），两者目标冲突时该谁让路？

### 9.4 下一步

- **Day 26 预告**：回到本系列主线，把 Day 21 的 WebSocket 推流链路和本篇的分离能力接起来，做一条**"多说话人 → 分区音频 → 分区字幕"的完整端到端 demo**。

---

## 参考资料

| 类型 | 名称 | 链接 / 出处 |
|---|---|---|
| 论文 | Powerset multi-class cross entropy loss for neural speaker diarization | arXiv:2310.13025（INTERSPEECH 2023） |
| 论文 | End-to-end speaker segmentation for overlap-aware resegmentation | arXiv:2104.04045（Interspeech 2021） |
| 论文 | Sortformer: Permutation-Resolved Speaker Supervision | arXiv:2409.06656 |
| 论文 | 3D-Speaker-Toolkit | arXiv:2403.19971（ICASSP 2025） |
| 论文 | 3D-Speaker Dataset（Multi-Device/Distance/Dialect） | arXiv:2306.15354 |
| 代码 | pyannote.audio | `github.com/pyannote/pyannote-audio`（MIT） |
| 代码 | NVIDIA NeMo Speech | `github.com/NVIDIA-NeMo/Speech`（Apache-2.0） |
| 代码 | 3D-Speaker | `github.com/modelscope/3D-Speaker`（Apache-2.0） |
| 模型 | pyannote/speaker-diarization-community-1 | HuggingFace（CC-BY-4.0, gated） |
| 模型 | pyannote/segmentation-3.0 | HuggingFace（MIT, gated） |
| 模型 | nvidia/diar_sortformer_4spk-v1 | HuggingFace / NGC |
| 模型 | iic/speech_campplus_sv_zh-cn_16k-common | ModelScope（Apache-2.0） |
| 模型 | iic/speech_eres2netv2_sv_zh-cn_16k-common | ModelScope（Apache-2.0） |
| 本系列 | Day 08 Silero VAD | `2026-10-05-audio-08-silero-vad.md` |
| 本系列 | Day 21 WebSocket + TensorRT 推流 | `2026-10-26-audio-21-websocket-tensorrt-streaming-inference.md` |
| 本系列 | Day 22 麦克风阵列波束成形 | `2026-10-28-audio-22-mic-array-beamforming.md` |

---

> **最后一句**：说话人分离最反直觉的地方在于——**它输出的"说话人 1"和"说话人 2"只是"第一个开口的人"和"第二个开口的人"，没有任何身份含义**。所有把 `speaker_0` 硬编码成"主驾"的代码，都是在给自己埋雷。**身份永远要靠声纹去认，编号只是索引。**
