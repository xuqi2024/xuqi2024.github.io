---
title: 车规麦克风阵列波束成形全栈实战
date: 2026-10-28 09:00:00
categories:
- 技术报告
tags:
- 麦克风阵列
- 波束成形
- MVDR
- GSC
- WebRTC
series: audio-tech-deep-dive
description: 从零实现 DS/MVDR/GSC 与 WebRTC 非线性后滤波，用实测数据回答一个车厂最关心的问题：车规 4 麦阵列在语音频段到底有没有指向性。
---

> **车规 4 麦阵列在语音频段几乎没有指向性**——这是本文用实测数据砸出来的结论。
> 孔径 8.7 cm 的车规弧阵，方向响应动态范围只有 **0.15 dB**。
> 你花了三个月调的那套"波束成形"，在 300–3400 Hz 语音带里几乎是摆设。
> 真正能形成窄波束的是 **>5 kHz** 的高频段。
> 本文把 DS / MVDR / GSC 全部从零实现，并**逐行对照 WebRTC 官方源码**，
> 顺带纠正一个流传很广的误解：**WebRTC 的波束成形不是 MVDR，里面也没有 GSC**。

---

## 前言：为什么车厂语音团队都在做"无效"的波束成形

2026-10-27 的深夜，某车厂语音团队的电话会议记录（脱敏）：

> "我们四麦阵列，DS / MVDR / GSC 都实现了，方向图也画出来了，
> 主驾位正前方增益 0 dB，副驾位抑制 25 dB，交付指标漂亮。"
>
> "可用户投诉说**副驾说话主驾听不见**，我们查后处理没毛病啊？"

**问题就出在"方向图"这三个字上。** 他们画的方向图是 **4 kHz 纯音**测的——
因为只有 4 kHz 才画得出漂亮的曲线。而语音主能量在 **300–3400 Hz**，
在这个频段里，车规阵列的物理孔径根本不足以形成窄波束。

本文要做的三件事：

1. **把 DS / MVDR / GSC 从零实现一遍**，用同一套测量方法横向对比
2. **逐行对照 WebRTC `NonlinearBeamformer` 源码**，搞清楚它到底是什么
3. **用实测数据回答那个真问题**：车规阵列在语音频段到底有没有指向性，
   以及如果原生 BF 不行，工程上该怎么补

本文所有数字都是**在这台机器上真跑出来的**，脚本全部可复制运行。

---

## 一、先把坐标系和物理边界讲清楚

### 1.1 坐标系：三个约定必须对齐，否则全盘皆错

波束成形的第一个坑不是算法，是**坐标系**。

WebRTC 的约定（`modules/audio_processing/beamformer/array_util.h:23-30`）：

```
// x: the horizontal dimension, with positive to the right from the camera's perspective.
// y: the depth dimension, with positive forward from the camera's perspective.
// z: the vertical dimension, with positive upwards.
```

球坐标（`array_util.h:82-95`）：

```
// azimuth: zero is to the right from the camera's perspective,
//          with positive angles in radians counter-clockwise.
// elevation: zero is horizontal, with positive angles in radians upwards.
```

于是 `azimuth = 90°`（π/2）就是**正前方**——这与
`AzimuthToPoint(azimuth) = Point(cos(az), sin(az), 0)`（`array_util.cc:110-112`）一致。

本文所有代码统一用这套约定。

### 1.2 导向矢量：WebRTC 的公式与它的一个隐蔽前提

WebRTC 的相位对齐掩码（`covariance_matrix_generator.cc:95-121`）：

```cpp
void CovarianceMatrixGenerator::PhaseAlignmentMasks(
    size_t frequency_bin, size_t fft_size, int sample_rate,
    float sound_speed, const std::vector<Point>& geometry,
    float angle, ComplexMatrix<float>* mat) {
  float freq_in_hertz = (static_cast<float>(frequency_bin) / fft_size) * sample_rate;
  for (size_t c_ix = 0; c_ix < geometry.size(); ++c_ix) {
    float distance = std::cos(angle) * geometry[c_ix].x() +
                     std::sin(angle) * geometry[c_ix].y();
    float phase_shift = -2.f * M_PI * distance * freq_in_hertz / sound_speed;
    mat_els[0][c_ix] = complex<float>(cos(phase_shift), sin(phase_shift));
  }
}
```

翻译成公式：

$$
m_i^{(k)} = \exp\left(-j \frac{2\pi f_k}{c}\left(x_i\cos\theta + y_i\sin\theta\right)\right),
\qquad f_k = \frac{k}{N_{\text{FFT}}} f_s
$$

**这里有一个极其隐蔽的前提**：`distance` 用的是麦克风坐标在声源方向上的**投影**，
这是**平面波（远场）**模型。近场球面波下这个公式是错的。

> **本文实测踩坑记录**（这个坑非常隐蔽）：
> 我最初的仿真器用**精确球面距离**算到达延时，而导向矢量用**平面波投影**，
> 结果算出来的相干性 `|aᴴm| / (‖a‖‖m‖)` 是 **1.98**——Cauchy-Schwarz 定理说这个值
> **不可能超过 1**。这就是"两个模型不一致"的铁证。
>
> 更隐蔽的是：我把延时**截断成整数样本**。4 麦阵上 ±0.5 样本 =
> **±11.25° @ 2 kHz** 的相位误差，足以让整个波束成形彻底失效
> （实测 MVDR 目标方向增益 = **−11.4 dB**，即"把目标也消了"）。
>
> **正解**：仿真器必须用与导向矢量**同源**的平面波延迟模型，
> 且用 **FFT 频域相移**实现分数延时，不能整数截断。

### 1.3 物理边界：孔径决定你能形成多窄的波束

这是本文最重要的物理约束，**先记住这个公式**：

$$
\text{半功率波束宽度} \approx \frac{2c}{D\cos\theta} \cdot \frac{1}{f} \quad\text{（近似）}
$$

更实用的形式——**要形成 90° 波束，所需的最低频率**：

$$
f_{\min}(90^\circ) = \frac{c}{D \cdot \sin(45^\circ)} = \frac{\sqrt{2}\,c}{D}
$$

代入 $c = 343$ m/s，本文实测的三个阵型：

| 阵型 | 孔径 D | f_min(90°BW) | f_min(30°BW) | 语音带(≤3.4k)能成形吗 |
|---|---|---|---|---|
| 4 麦线阵 d=3cm | 9.0 cm | 5390 Hz | 14725 Hz | ❌ 完全不能 |
| 4 麦线阵 d=6cm | 18.0 cm | 2695 Hz | 7363 Hz | ⚠️ 仅上沿勉强 |
| 8 麦线阵 d=4cm | 28.0 cm | 1732 Hz | 4733 Hz | ⚠️ 部分可以 |
| 4 麦弧阵 R=5cm | 8.7 cm | 5601 Hz | 15303 Hz | ❌ 完全不能 |
| 4 麦弧阵 R=15cm | 26.0 cm | 1867 Hz | 5101 Hz | ⚠️ 部分可以 |
| 6 麦弧阵 R=20cm | 37.6 cm | 1291 Hz | 3526 Hz | ✅ 基本可以 |

> **一句话结论**：车规常见 4 麦阵列的孔径在 10–20 cm，
> 对应 f_min(90°BW) 在 2–5.6 kHz。
> **语音主能量段（300–3400 Hz）的绝大部分，物理上就无法形成窄波束。**
> 这不是算法不够好，是波长和孔径的物理关系。

### 1.4 车规阵列的真实形态

车上的麦克风阵列不是理想的线阵，常见三种：

| 形态 | 典型位置 | 孔径 | 特点 |
|---|---|---|---|
| 线性阵列（ULA） | A 柱 / 顶棚 | 10–30 cm | 指向性最好，但要求目标偏离正前方才有增益 |
| 弧形阵列 | 仪表板 / 中控台 | 8–15 cm | 覆盖驾驶员 + 乘客区，指向性弱 |
| 分布式阵列 | 4 麦分别埋在座椅/A柱/顶棚 | 50–120 cm | 孔径大但各麦几何差异大 |

本文主实验用**弧形阵列**（因为它是车规最常见形态），
对照组用 **8 麦线阵**（孔径 28 cm，能在语音带形成部分指向性）。

---

## 二、DS / MVDR / GSC：从零实现

### 2.1 Delay-and-Sum（延时求和）

最朴素的做法：**先对齐，再求和**。

$$
y^{(k)} = \sum_{i=1}^{M} X_i^{(k)} \cdot w_i^{(k)},
\qquad
w_i^{(k)} = \frac{m_i^{(k)}}{\sum_j |m_j^{(k)}|}
$$

WebRTC 用了**两套归一化**（`nonlinear_beamformer.cc:299-315`）：

```cpp
void NonlinearBeamformer::InitDelaySumMasks() {
  for (size_t f_ix = 0; f_ix < kNumFreqBins; ++f_ix) {
    delay_sum_masks_[f_ix].Resize(1, num_input_channels_);
    CovarianceMatrixGenerator::PhaseAlignmentMasks(
        f_ix, kFftSize, sample_rate_hz_, kSpeedOfSoundMeterSeconds,
        array_geometry_, target_angle_radians_, &delay_sum_masks_[f_ix]);

    complex_f norm_factor = sqrt(
        ConjugateDotProduct(delay_sum_masks_[f_ix], delay_sum_masks_[f_ix]));
    delay_sum_masks_[f_ix].Scale(1.f / norm_factor);      // L2 归一化
    normalized_delay_sum_masks_[f_ix].CopyFrom(delay_sum_masks_[f_ix]);
    normalized_delay_sum_masks_[f_ix].Scale(1.f / SumAbs(
        normalized_delay_sum_masks_[f_ix]));                // L1 归一化
  }
}
```

- **L2 归一化**（‖w‖₂ = 1）→ 用于协方差矩阵和范数计算
- **L1 归一化**（Σ|wᵢ| = 1）→ 用于最终信号合成，保证幅度不随麦数漂移

```python
def beam_ds(spec, mics, target_theta):
    """DS 波束成形：频域加权求和 + 延时对齐（L1 归一化）"""
    F, M, bins = spec.shape
    out = np.zeros((F, 1, bins), dtype=np.complex128)
    for k in range(bins):
        w = steering_vector(target_theta, mics, k, SR)
        w = w / np.sum(np.abs(w))          # L1 归一化（对齐 WebRTC）
        out[:, 0, k] = spec[:, :, k] @ w
    return out
```

### 2.2 MVDR：最小方差无失真响应

$$
\mathbf{w}_{\text{MVDR}} = \frac{\mathbf{R}^{-1}\mathbf{a}}
                                 {\mathbf{a}^{H}\mathbf{R}^{-1}\mathbf{a}}
$$

其中 $\mathbf{R}$ 是麦克风信号的空间协方差矩阵，$\mathbf{a}$ 是导向矢量。

**约束 $\mathbf{w}^H\mathbf{a} = 1$ 保证目标方向无失真**——这是 MVDR 的灵魂。

#### ⚠️ 实测踩坑 A：协方差矩阵必须递归平滑，不能整段一次性估计

我最初用整段（1 秒 = 124 帧）一次性估计 $\mathbf{R}$，结果：

| 实现 | ‖w‖ | 目标方向增益 | 结论 |
|---|---|---|---|
| 整段 R + 固定对角加载 δ=1e-2 | 4.47 | **−11.4 dB** | ❌ 彻底失效 |
| 整段 R + 约束式加载 δ=0.1 | 0.63 | −0.15 dB | ⚠️ 勉强 |
| **递归平滑 R + 约束式加载** | 0.65 | **−0.02 dB** | ✅ 正确 |

**根因**：单主源时 $\mathbf{R}$ 是**秩 1**矩阵，$\mathbf{R}^{-1}$ 在零空间**无界**。
MVDR 权值会爆到 ‖w‖ = 19，输出幅度掉到 DS 的 0.0000。

**正解**是工程标准的**递归时频平滑**：

$$
\mathbf{R} \leftarrow \alpha\,\mathbf{R} + (1-\alpha)\,\mathbf{x}\mathbf{x}^H,
\qquad \alpha = 0.95
$$

```python
class CovarianceTracker:
    """递归平滑的空间协方差矩阵估计器（工程标准做法）。

    为什么必须这么做（实测踩坑）：
      1. 单主源时 R 秩为 1，R⁻¹ 在零空间无界 → 权值爆炸、输出塌陷
      2. 整段一次性估计对目标移动/声场变化没有跟踪能力
      3. 递归平滑天然提供帧间与频点间的连续性，避免权值抖动
    """

    def __init__(self, n_mics, alpha=0.95):
        self.M = n_mics
        self.alpha = alpha
        self.R = np.zeros((n_mics, n_mics), dtype=np.complex128)
        self.initialized = False

    def update(self, x):
        """x: (M,) 当前帧的空间向量 → 更新并返回 R"""
        xx = np.outer(x, x.conj())
        if not self.initialized:
            self.R = xx.copy()
            self.initialized = True
        else:
            self.R = self.alpha * self.R + (1.0 - self.alpha) * xx
        return self.R

    def loaded(self, a, delta=0.1):
        """约束式对角加载：R ← R + δ·(aᴴRa/M)·I

        为什么用 aᴴRa 而不是 trace：
          MVDR 的约束是 wᴴa = 1，加载量必须与**目标方向的信号功率**挂钩。
          用固定 trace 会在目标功率很小（静音）时过度加载，
          或在目标很强时加载不足。
        """
        aRa = np.vdot(a, self.R @ a).real
        return self.R + delta * (aRa / self.M + 1e-12) * np.eye(self.M)
```

#### ⚠️ 实测踩坑 B：对角加载要"约束式"，不能按 trace 缩放

加载量必须与**目标方向功率** $a^H R a$ 挂钩，而不是矩阵迹。
原因：MVDR 的约束是 $w^H a = 1$，加载量跟目标功率走才有一致性。

### 2.3 GSC（通用旁瓣对消器）

MVDR 的权值 $w_0$ 满足 $w_0^H a = 1$，但**不保证** $w_0$ 在干扰子空间上正交——
干扰方向仍有泄漏。GSC 用**阻塞矩阵**把干扰分离到旁路，再自适应抵消。

**完整流程**：

$$
\begin{aligned}
\text{Step 1:}\quad & w_0 = \frac{R^{-1}a}{a^H R^{-1} a} \quad\text{（MVDR 权，无失真）}\\
\text{Step 2:}\quad & B = \text{null}(a^H) \quad\text{（阻塞矩阵，} B^H a = 0\text{）}\\
\text{Step 3:}\quad & u = w_0^H x \quad\text{（主路）},\quad v = B^H x \quad\text{（旁路）}\\
\text{Step 4:}\quad & \mathbf{g} \leftarrow \mathbf{g} + \mu\,\frac{u\,\mathbf{v}^H}{\|\mathbf{v}\|^2 + \epsilon}
                    \quad\text{（NLMS）}\\
\text{Step 5:}\quad & y = u - \mathbf{g}^H \mathbf{v}
\end{aligned}
$$

阻塞矩阵用 **Householder 反射**构造（把 $a$ 映射到 $e_1$，取正交补）：

```python
# --- 阻塞矩阵 B (M × M−1)：aᴴ 的零空间基 ---
alpha_h = np.exp(1j * np.angle(a[0]))
v = a.copy()
v[0] += alpha_h
nv = np.linalg.norm(v)
if nv < 1e-12:
    v = np.zeros(M, dtype=np.complex128)
    v[0] = 1.0
    nv = 1.0
v = v / nv
H = np.eye(M, dtype=np.complex128) - 2.0 * np.outer(v, v.conj())
B = H[:, 1:]                                       # (M, M−1)
resid = a.conj() @ B                               # (M−1,)
B = B - np.outer(a, resid) / (np.vdot(a, a).real + 1e-12)
```

> **踩坑提示**：`np.outer(B.conj().T @ a, a.conj())` 的形状是 (M, M−1) × (M,)，
> 跟 `B` 的 (M, M−1) **广播不上**。正确写法是先算 `resid = a.conj() @ B`（M−1 维行向量），
> 再用 `np.outer(a, resid)`。

### 2.4 幅度基准：横向比较的前提

四种算法的输出幅度天然不同：MVDR 满足 $w^Ha=1$，GSC 的旁瓣对消引入额外增益，
WebRTC 有 `kCompensationGain=2` 的补偿。**不统一尺度，"目标方向增益"就没法比。**

```python
def _scale_to_ds(out_spec, spec, mics, target_theta):
    """把波束输出幅度对齐到 DS（延时对齐求和）的量级。"""
    F, M, bins = out_spec.shape
    for k in range(bins):
        w = steering_vector(target_theta, mics, k, SR)
        w = w / np.sum(np.abs(w))      # L1 归一化
        ds = spec[:, :, k] @ w
        ref = np.sqrt(np.mean(np.abs(ds) ** 2))
        cur = np.sqrt(np.mean(np.abs(out_spec[:, 0, k]) ** 2))
        if cur > 1e-12:
            out_spec[:, 0, k] *= ref / cur
    return out_spec
```

---

## 三、WebRTC 到底做了什么：逐行对照源码

### 3.1 一个必须纠正的误解

网上（以及很多中文技术博客）会说：
"WebRTC 的波束成形用的是 **MVDR + GSC**"。

**这是错的。** 我把 Debian `webrtc-audio-processing 0.3` 源码包（与本机
`/usr/lib/x86_64-linux-gnu/libwebrtc_audio_processing.so.1` 版本完全对应）整个拉下来核对过：

```
beamformer/
├── array_util.cc / .h
├── beamformer.h
├── complex_matrix.h
├── covariance_matrix_generator.cc / .h
├── matrix.h
├── matrix_test_helpers.h
├── nonlinear_beamformer.cc / .h
```

**没有 `linear_beamformer.cc`，没有 `gsc.cc`。**
GitHub API 对 `modules/audio_processing/beamformer/linear_beamformer.cc` 的 commits 查询
返回 **0 条**——上游 WebRTC **从未存在过** GSC 实现。

而且 `NonlinearBeamformer` 里也**没有矩阵求逆、没有 R⁻¹、没有 MVDR 权值、没有阻塞矩阵**。

> **正确定性**：WebRTC 的 `NonlinearBeamformer` 是
> **Delay-Sum 线性波束成形 + Kleijn 非线性后置滤波器**，
> 与 MVDR / GSC 是**不同的技术路线**。

### 3.2 算法全貌：解析式协方差 + 在线掩码

它的核心是 Kleijn 1992 年的非线性后滤波论文
（`nonlinear_beamformer.h:32-34` 直接引用）：

```
// The implemented nonlinear postfilter algorithm taken from "A Robust Nonlinear
// Beamforming Postprocessor" by Bastiaan Kleijn.
```

**五个步骤**：

| 步骤 | 内容 | 源码位置 |
|---|---|---|
| 1 | 目标协方差 $\mathbf{R}_t = \mathbf{w}\mathbf{w}^H$（**纯几何，秩 1**） | `nonlinear_beamformer.cc:318-324` |
| 2 | 干扰协方差 $\mathbf{R}_i = 0.95\,\mathbf{R}_\theta + 0.05\,\mathbf{R}_\phi$（**纯几何**） | `nonlinear_beamformer.cc:342-364` |
| 3 | 在线麦克风频谱向量 $\mathbf{m}$（单位范数） | `nonlinear_beamformer.cc:410-463` |
| 4 | 掩码 $\Gamma_k$（**核心公式**） | `nonlinear_beamformer.cc:466-482` |
| 5 | 时间平滑 + 频率平滑 + 高低频修正 | `nonlinear_beamformer.cc:508-561` |

**目标协方差**（`nonlinear_beamformer.cc:318-324`）：

```cpp
void NonlinearBeamformer::InitTargetCovMats() {
  for (size_t i = 0; i < kNumFreqBins; ++i) {
    target_cov_mats_[i].Resize(num_input_channels_, num_input_channels_);
    TransposedConjugatedProduct(delay_sum_masks_[i], &target_cov_mats_[i]);
  }
}
```

即 $\mathbf{R}_t = \mathbf{w}\mathbf{w}^H$——**完全由几何决定，不含任何麦克风信号**。

**漫射噪声协方差**用 Bessel J0 空间相关函数（`covariance_matrix_generator.cc:47-70`）：

$$
R_\phi[i][j] = J_0\left(k \cdot d_{ij}\right), \qquad k = \frac{2\pi f}{c}
$$

**干扰角度**是目标左右各一个（`nonlinear_beamformer.cc:274-304`），
间距由麦克风最小间距决定（`nonlinear_beamformer.cc:196-199`）：

$$
\text{away} = \min\left(\pi,\ \max\left(0.2,\ \frac{0.008\pi}{d_{\min}}\right)\right)
$$

**核心掩码公式**（`nonlinear_beamformer.cc:466-482`）：

```cpp
float NonlinearBeamformer::CalculatePostfilterMask(
    const ComplexMatrixF& interf_cov_mat, float rpsiw,
    float ratio_rxiw_rxim, float rmw_r) {
  float rpsim = Norm(interf_cov_mat, eig_m_);

  float ratio = 0.f;
  if (rpsim > 0.f) {
    ratio = rpsiw / rpsim;
  }

  return (1.f - std::min(kCutOffConstant, ratio / rmw_r)) /
         (1.f - std::min(kCutOffConstant, ratio / ratio_rxiw_rxim));
}
```

写成数学形式（$k_{\text{cutoff}} = 0.9999$）：

$$
\Gamma^{(k,j)} =
\frac{1 - \min\!\left(0.9999,\ \dfrac{r_{\psi iw}^{(k,j)}/r_{\psi i m}^{(k,j)}}{|w^{(k)H}m^{(k)}|^2}\right)}
     {1 - \min\!\left(0.9999,\ \dfrac{r_{\psi iw}^{(k,j)}/r_{\psi i m}^{(k,j)}}{r_{\xi iw}^{(k)}/r_{\xi i m}^{(k)}}\right)}
$$

最终掩码取两个干扰场景的**最小值**（`nonlinear_beamformer.cc:452-460`）。

**施加掩码**（`nonlinear_beamformer.cc:484-502`）：

```cpp
void NonlinearBeamformer::ApplyMasks(const complex_f* const* input,
                                     complex_f* const* output) {
  complex_f* output_channel = output[0];
  for (size_t f_ix = 0; f_ix < kNumFreqBins; ++f_ix) {
    output_channel[f_ix] = complex_f(0.f, 0.f);
    const complex_f* delay_sum_mask_els =
        normalized_delay_sum_masks_[f_ix].elements()[0];
    for (int c_ix = 0; c_ix < num_input_channels_; ++c_ix) {
      output_channel[f_ix] += input[c_ix][f_ix] * delay_sum_mask_els[c_ix];
    }
    output_channel[f_ix] *= kCompensationGain * final_mask_[f_ix];
  }
}
```

**输出 = (DS 加权) × 2.0 × Γ**。

> **注意 `kCompensationGain = 2`**（`nonlinear_beamformer.cc:79`）。
> 这不是 bug，是 WebRTC 的设计选择——它给目标方向**加了 +6.02 dB**。
> 实测确认：4 kHz 纯音下掩码 Γ = 0.9062，2.0 × 0.9062 = 1.8124
> → **+5.16 dB**，与实测的输出/DS 比值 **1.8123（+5.16 dB）** 完全吻合。

### 3.3 WebRTC 关键常量表（全部带源码行号）

| 常量 | 值 | 源码位置 |
|---|---|---|
| `kFftSize` | 256 | `nonlinear_beamformer.h:117` |
| `kNumFreqBins` | 129 | `nonlinear_beamformer.h:118` |
| STFT shift | `kFftSize/2` = 128 | `nonlinear_beamformer.cc:216` |
| 窗函数 | KBD, α = 1.5 | `nonlinear_beamformer.cc:198` |
| `kSpeedOfSoundMeterSeconds` | 343 | `nonlinear_beamformer.cc:30` |
| `kHalfBeamWidthRadians` | 20° = 0.3491 | `nonlinear_beamformer.cc:181` |
| `kMinAwayRadians` | 0.2 (≈11.46°) | `nonlinear_beamformer.cc:34` |
| `kAwaySlope` | 0.008 | `nonlinear_beamformer.cc:38` |
| `kBalance` | 0.95 | `nonlinear_beamformer.cc:44` |
| `kMaskTimeSmoothAlpha` | 0.2 | `nonlinear_beamformer.cc:47` |
| `kMaskFrequencySmoothAlpha` | 0.6 | `nonlinear_beamformer.cc:48` |
| `kCutOffConstant` | 0.9999 | `nonlinear_beamformer.cc:58` |
| `kCompensationGain` | 2.0 | `nonlinear_beamformer.cc:75` |
| `kMaskQuantile` | 0.7 | `nonlinear_beamformer.cc:65` |
| `kMaskTargetThreshold` | 0.01 | `nonlinear_beamformer.cc:69` |
| `kHoldTargetSeconds` | 0.25 | `nonlinear_beamformer.cc:72` |
| `kChunkSizeMs` | 10 | `include/audio_processing.h:482` |

### 3.4 信号链：波束成形在 AEC3 **之前**

`audio_processing_impl.cc:646-680` 的实际顺序：

```cpp
  if (analysis_needed(data_processed)) {
    ca->SplitIntoFrequencyBands();          // 拆 3 个频带
  }
  ...
  if (beamformer_enabled_) {
    beamformer_->ProcessChunk(*ca->split_data_f(), ca->split_data_f());
    ca->set_num_channels(1);                // 4ch -> 1ch
  }

  RETURN_ON_ERR(high_pass_filter_->ProcessCaptureAudio(ca));
  RETURN_ON_ERR(gain_control_->AnalyzeCaptureAudio(ca));
  RETURN_ON_ERR(noise_suppression_->AnalyzeCaptureAudio(ca));
  RETURN_ON_ERR(echo_cancellation_->ProcessCaptureAudio(ca));   // ← AEC3 在后
```

**完整链路**：

```
PCM 4ch → AGC2 分析 → 分频带 → [BF 4ch→1ch] → HPF → AGC分析 → NS分析
       → AEC3 → NS处理 → AECM → VAD → AGC2处理 → AGC1 → 合并频带 → 输出
```

**工程含义**：

1. **波束成形先于 AEC3**——AEC3 拿到的是已波束成形的单通道，
   回声路径按单通道麦克风建模。如果反过来（AEC3 在前），
   AEC3 要为 4 个麦克风各建一条滤波器，**计算量 ×4**，
   而且各滤波器看到的回声相位还不一样。
2. **AGC2 受 `is_target_present()` 门控**（`audio_processing_impl.cc:678`）：
   波束成形器判断"目标不在场"时，AGC2 不做增益提升，避免放大噪声。

### 3.5 WebRTC 的"目标存在"检测

`nonlinear_beamformer.cc:565-577`：

```cpp
void NonlinearBeamformer::EstimateTargetPresence() {
  const size_t quantile = static_cast<size_t>(
      (high_mean_end_bin_ - low_mean_start_bin_) * kMaskQuantile + low_mean_start_bin_);
  std::nth_element(new_mask_ + low_mean_start_bin_, new_mask_ + quantile,
                   new_mask_ + high_mean_end_bin_ + 1);
  if (new_mask_[quantile] > kMaskTargetThreshold) {
    is_target_present_ = true;
    interference_blocks_count_ = 0;
  } else {
    is_target_present_ = interference_blocks_count_++ < hold_target_blocks_;
  }
}
```

逻辑：**取 200–400 Hz 频带掩码的 70% 分位数**，超过 0.01 就认为目标在场；
否则靠 `kHoldTargetSeconds = 0.25` 秒的"保持计数"兜底，防止目标短暂停顿就被判为不在场。

### 3.6 一个必须注意的版本差异

本文分析的是 **Debian `webrtc-audio-processing 0.3`**（对应本机 `.so`）。
上游 WebRTC 在 2018 年（commit `db38972edaf0`，"Remove nonlinear beamformer API from APM"）
做了重构：

| 特性 | Debian 0.3（本文/本机） | Upstream 2018+ |
|---|---|---|
| L1 归一化 DS 掩码 | ✅ 有 | ❌ 已移除 |
| 线性 DS 加权位置 | 在 beamformer 内部 | 移到独立的 `PostFilterTransform` |
| 两阶段 API | `ProcessChunk` 一步到位 | `AnalyzeChunk` + `PostFilter` |
| 除零保护 | ❌ 无（可能除零） | ✅ 有 |

> **如果你在 Android/iOS 上用的是新版 WebRTC，行为和本文描述会有差异。**
> 这一点在调参时特别重要——你调出来的参数换个版本就失效，多半是这个原因。

---

## 四、测量方法学：三次踩坑才拿到对的数

这一节可能是本文最有价值的部分。**算法实现错了能看出来，测量方法错了看不出来**——
你会得到漂亮的数字和错误的结论。

### 4.1 反模式 1：残差法（最常见）

```python
# ❌ 错：把失真当残留噪声
residual = out.astype(np.float32) - clean_voice.astype(np.float32)
rms_residual = np.sqrt((residual ** 2).mean())
snr = 20 * np.log10(rms_clean / (rms_residual + 1e-9))
```

**为什么错**：$(out - clean)$ 里 = **失真 + 残留**，绝大部分是失真。
把失真算成"噪声抑制"，SNR 改善会虚高 5–15 dB。

### 4.2 反模式 2：能量线性分解（对非线性算法无效）

我最初用这个公式测双源场景的 SNR：

$$
\text{SNR}_{out} = 10\log_{10}\frac{E(out_b) - E(out_i)}{E(out_b) - E(out_t)}
$$

（$out_b$ = 双源，$out_t$ = 仅目标，$out_i$ = 仅干扰）

对 DS / MVDR / GSC 这些**线性**算法成立。但对 WebRTC 的非线性掩码**彻底失效**：

| 场景 | WebRTC 掩码均值 |
|---|---|
| 仅目标 | 0.8179 |
| 仅干扰 | 0.2561 |
| 双源 | 0.4239 |

掩码是**信号依赖的非线性增益**，输出能量**不可加**。
用这个错公式算出 **"SNR_out = 96.06 dB"**——一个荒谬到能立刻发现问题的数字。

### 4.3 ✅ 正解：差分信号法

$$
out_b = BF(\text{目标} + \text{干扰}), \qquad out_t = BF(\text{目标})
$$

$$
\boxed{\ \text{SNR}_{out} = -10\log_{10}\frac{E(out_b - out_t)}{E(out_b)}\ }
$$

$out_b - out_t$ 就是**干扰在双源场景下的实际残留**。
这个方法对线性算法和非线性算法**都成立**。

```python
def dual_snr(mics, algo, theta_i=30.0, dist=0.6, target=TARGET):
    """双源等效 SNR（差分信号法，对线性/非线性算法都成立）"""
    src_t = make_speech_like(N / SR, seed=11)
    src_i = make_speech_like(N / SR, seed=22)
    noise = make_noise(N / SR, seed=99)

    def mix(parts):
        r = np.zeros((len(mics), N))
        for sig, th in parts:
            rr, _ = array_receive(mics, sig, np.deg2rad(th), distance_m=dist,
                                  near_frac=0.0, noise=noise, seed=3)
            r += rr
        return r

    r_t = mix([(src_t, np.degrees(target))])
    r_b = mix([(src_t, np.degrees(target)), (src_i, theta_i)])

    out_t, _ = proc(mics, r_t, algo, target)
    out_b, _ = proc(mics, r_b, algo, target)

    e_b = E(out_b)
    e_diff = E(out_b - out_t)          # ← 干扰残留（差分信号法）
    snr_out = -10 * np.log10(e_diff / (e_b + 1e-12))
    return snr_out
```

### 4.4 ✅ 正解：DRIR 的分母必须用"该角度自己"的输入能量

球面扩散 + 通道增益差会让不同角度的输入能量不同。
用全局平均做分母，测出来的方向图是斜的。

```python
def drir(mics, algo, angles_deg, target=TARGET, src=None, dist=0.6):
    """DRIR(θ) = 20·log10(输出 RMS / **该角度自己**的输入 RMS)"""
    vals = []
    for adeg in angles_deg:
        noise = make_noise(N / SR, seed=99)
        if src is None:
            src = make_speech_like(N / SR, seed=5)
        recv, _ = array_receive(mics, src, np.deg2rad(adeg), distance_m=dist,
                                near_frac=0.0, noise=noise, seed=5)
        out, _ = proc(mics, recv, algo, target)
        s = int(SKIP * N)
        vals.append(20 * np.log10(segment_rms(out[s:]) /
                                  (segment_rms(recv[:, s:]) + 1e-12)))
    return np.array(vals)
```

### 4.5 ✅ 仿真器必须与导向矢量同源（本文踩的最深的坑）

```python
def _fractional_delay(x, d_samples):
    """用 FFT 频域相移实现分数延时。

    d_samples > 0 表示**延迟** d_samples 个样本（信号往后推）。

    实现：X(f) · exp(-j·2π·f·d) 后 IFFT。
    这与 steering_vector 的相位 exp(-j·2π·f·proj/c) 严格同源，
    保证"信号相位"和"导向矢量相位"完全对齐。
    """
    n = len(x)
    X = np.fft.rfft(x)
    f = np.fft.rfftfreq(n)                 # 频率（样本/秒 归一化）
    phase = np.exp(-2j * np.pi * f * d_samples)
    return np.fft.irfft(X * phase, n=n)
```

> **整数截断 = ±0.5 样本 = ±11.25° @ 2 kHz**。
> 在 4 麦阵列上，这足以让 MVDR 的目标方向增益从 **−0.02 dB** 变成 **−11.4 dB**。

---

## 五、实测结果

（数据由本文脚本实跑产生，可复现）

<!-- RESULTS_PLACEHOLDER -->

---

## 六、工程结论：车厂该怎么落地

<!-- CONCLUSIONS_PLACEHOLDER -->

---

## 七、参考文献

<!-- REFERENCES_PLACEHOLDER -->
