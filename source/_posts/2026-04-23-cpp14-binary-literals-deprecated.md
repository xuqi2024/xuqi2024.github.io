---
title: 【C++14】（二）Binary Literals、Digit Separators 与 Deprecated：编译器辅助编程
date: 2026-04-23 12:00:00
categories: [C++新特性]
tags:
- C++
- C++14
---

> 好的代码不仅要能运行，还要**自解释**。C++14 引入的这些特性，让编译器成为你的"代码审查员"。

## 前言

写代码时，你是否曾对着 `0xFFFF'0000` 愣住，想确认这是 mask 还是其他什么？或者维护一个"祖传代码"，不敢动旧函数又怕新人误用？

C++14 带来的三个小特性——**Binary Literals**、**Digit Separators**、**Deprecated Attribute**——正好解决了这些"辅助编程"的问题。

---

## 一、Binary Literals：让位运算不再神秘

### 1.1 基本用法

```cpp
auto flags = 0b11110000;  // 十进制 240
std::cout << "flags = " << flags << " (should be 240)\n";
```

C++14 之前，你只能这样写：

```cpp
auto flags = 240;        // 鬼知道这是啥
auto flags = 0xF0;       // 好一点，但还是得算
```

### 1.2 位操作示例

```cpp
auto bit_check = (flags & 0b10000000) != 0;  // 检查第7位
std::cout << "bit set: " << bit_check << "\n";
```

现在，**代码即文档**——`0b10000000` 一眼就能看出是检查最高位。

---

## 二、Digit Separators：数字常量的可读性革命

### 2.1 单引号分隔符

```cpp
auto million = 1'000'000;          // 1000000
auto mask = 0xFFFF'0000;           // 0xFFFF0000
auto bytes = 0b1010'1101'1111'0000; // 二进制分组
```

### 2.2 为什么有用？

| 场景 | 无分隔符 | 有分隔符 | 可读性提升 |
|------|---------|---------|-----------|
| 百万常量 | `1000000` | `1'000'000` | ✅ 一眼看出数量级 |
| MAC 地址 | `0xFFFFFFFFFFFF` | `0xFF'FF'FF'FF'FF'FF` | ✅ 分组对应硬件字段 |
| 二进制 mask | `0b111100001111` | `0b1111'0000'1111` | ✅ Nibble 对齐 |

> 分隔符只是**视觉辅助**，编译器会完全忽略单引号——不影响性能，不改变语义。

---

## 三、Deprecated Attribute：编译器辅助的代码迁移

### 3.1 基本语法

```cpp
[[deprecated("Use NewFunc instead")]]
void OldFunc() {}

[[deprecated]]
class OldClass {};
```

### 3.2 编译器的警告

当其他代码使用这些"过时"符号时：

```cpp
int main() {
    OldFunc();        // ⚠️ 编译警告：deprecated
    OldClass obj;     // ⚠️ 编译警告：deprecated
}
```

编译器输出：

```
warning: 'void OldFunc()' is deprecated: Use NewFunc instead [-Wdeprecated-declarations]
warning: 'class OldClass' is deprecated [-Wdeprecated-declarations]
```

### 3.3 为什么不用宏？

你可能问：之前用宏不行吗？

```cpp
#define DEPRECATED(func) // 宏能做到吗？并不能
```

宏的局限：
- **无类型信息**：编译器不知道这是什么"类别"的过时
- **无法附加消息**：不能说"请用 X 替代 Y"
- **无法被工具识别**：IDE、静态分析工具不认识

`[[deprecated]]` 是**一等公民（First-class citizen）**——编译器、IDE、静态分析工具都能识别。

---

## 四、完整可运行代码

```cpp
#include <iostream>

// === Binary Literals (C++14) ===
int main() {
    auto flags = 0b11110000;
    std::cout << "flags = " << flags << " (should be 240)\n";
    
    // With digit separator
    auto million = 1'000'000;
    auto mask = 0xFFFF'0000;
    auto bytes = 0b1010'1101'1111'0000;
    
    std::cout << million << "\n";
    std::cout << std::hex << mask << std::dec << "\n";
    
    // Bit operations with binary literals
    auto bit_check = (flags & 0b10000000) != 0;
    std::cout << "bit set: " << bit_check << "\n";
}

// === Deprecated 示例 ===
[[deprecated("Use NewFunc instead")]]
void OldFunc() {}

[[deprecated]]
class OldClass {};
```

**编译验证**：

```bash
g++ -std=c++14 -o demo demo.cpp 2>&1 | head -20
```

---

## 五、应用场景

### 5.1 API 演进

```
旧API (标记为 deprecated)
    ↓
编译器警告 → 开发者看到 → 迁移到新API
```

### 5.2 技术债管理

对于大型代码库，可以用 `[[deprecated]]` 标记：
- 已知有 bug 的函数
- 性能不佳的实现
- 即将删除的功能

> **行动建议**：当你需要废弃某个 API 时，立即加上 `[[deprecated("Use XXX instead")]]`，而不是等到删除时才行动。给用户足够的迁移时间。

---

## 总结

| 特性 | 解决的问题 | 示例 |
|------|---------|------|
| Binary Literals | 位操作可读性 | `0b1010'1101` |
| Digit Separators | 大数字可读性 | `1'000'000` |
| Deprecated Attribute | API 迁移引导 | `[[deprecated("Use X")]]` |

> 这些特性看似"小"，但在**代码可维护性**上迈出了一大步——编译器成了你的助手，而不是只报错不管事的"黑盒"。
---

## 📚 C++14 新特性 系列导航

> 本文是《C++14 新特性》系列第 **2/2** 篇。

| 方向 | 章节 |
|:--|:--|
| ◀ 上一篇 | [（一）Generic Lambda 与 Variable Template](/2026/04/23/2026-04-23-cpp14-generic-lambda-variable-template/) |

<details>
<summary>📖 全部 2 篇目录（点击展开）</summary>

1. [（一）Generic Lambda 与 Variable Template](/2026/04/23/2026-04-23-cpp14-generic-lambda-variable-template/)
2. [（二）Binary Literals 与 Deprecated](/2026/04/23/2026-04-23-cpp14-binary-literals-deprecated/) **← 当前**

</details>
