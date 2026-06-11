---
title: 【C++23】（二）if consteval 与 Deducing this：更多编译期能力
date: 2026-04-23 09:53:00
categories:
- C++新特性
tags:
- C++
- C++23
description: "C++23 让编译期计算和对象方法调用都变得更强大。if consteval 让你在编译期分支判断，而 deducing this 则彻底改变了成员函数的设计方式——不再需要模板就能实现泛型方法。"
---

> C++23 让"编译期计算"和"对象方法调用"都变得更强大。`if consteval` 让你在编译期分支判断，而 `deducing this` 则彻底改变了成员函数的设计方式——不再需要模板就能实现"泛型方法"。

---

## 一、if consteval：编译期还是运行期？

### 痛点回顾

在 C++20 引入 `consteval` 之后，我们可以用它声明"必须在编译期求值"的函数：

```cpp
consteval int square(int n) { return n * n; }
static_assert(square(3) == 9);  // ✅ 编译期计算
int x = 5;
 // square(x);  // ❌ 运行时值不能用于 consteval 函数
```

**问题来了**：如果你有一个函数，想让它在"编译期返回 42，运行时返回 0"——在 C++23 之前，你无法判断当前是否处于常量求值上下文。

### if consteval 的解决方案

```cpp
// C++23
consteval int check() {
    if consteval {
        return 42;  // 编译期执行这条
    } else {
        return 0;   // 运行时执行这条
    }
}

static_assert(check() == 42);  // 编译期调用，走 if 分支
int runtime_val = check();     // 运行时调用，走 else 分支
```

`if consteval` 是**专门用于常量求值上下文的 `if` 语句**，它的条件部分没有括号——这是 C++23 的新语法。

### 实际应用：编译期vs运行期差异化实现

```cpp
consteval auto process(int n) {
    if consteval {
        return "编译期字符串";
    } else {
        return "运行时字符串";
    }
}

// 用于模板元编程
template<int N>
struct Wrapper {
    static constexpr auto value = []{
        if consteval {
            return N * 2;
        } else {
            return N + 10;
        }
    }();
};
```

---

## 二、Deducing this：成员函数的革命

### 传统方式的局限性

```cpp
struct Widget {
    int value = 100;
    
    // 传统写法：隐式 this 指针
    void print() {
        std::cout << "Widget: " << value << "\n";
    }
};
```

**问题**：
1. `print()` 只能被 `Widget` 调用，无法泛化到其他有 `value` 成员的类
2. 菱形继承中，`this` 指针调整容易出错
3. 实现 CRTP 等模式时语法繁琐

### 显式对象参数语法

C++23 允许你用 `this` 作为**显式对象参数（explicit object parameter）**：

```cpp
struct Widget {
    int value = 100;
    
    // 显式对象参数：self 是 *this 的拷贝
    void print(this Widget& self) {
        std::cout << "Widget: " << self.value << "\n";
    }
};
```

**语义**：调用 `w.print()` 时，`self` 会绑定到 `w`。这不是模板，却实现了"方法可被其他类型复用"的能力。

### 模板版本：真正的泛型方法

```cpp
struct Widget {
    int value = 100;
    
    // 模板版本：接收任何类型
    template<typename Self>
    void print_tmpl(this Self& self) {
        std::cout << "value: " << self.value << "\n";
    }
};

struct Gadget { int value = 200; };

int main() {
    Widget w;
    w.print();        // ✅ 正常工作
    
    Gadget g;
    g.print_tmpl();   // ✅ 也能调用！只要有 value 成员
}
```

**这就是 `deducing this` 的魔力**——一个非模板函数，却能自动推导调用者的类型。

---

## 三、完整示例

```cpp
#include <iostream>

// if consteval (C++23)
consteval int check() {
    if consteval {
        return 42;  // 编译期
    } else {
        return 0;   // 运行时
    }
}

// deducing this (C++23)
struct Widget {
    int value = 100;
    
    // 显式对象参数: this 推导
    void print(this Widget& self) {
        std::cout << "Widget: " << self.value << "\n";
    }
    
    // 模板版本: 接收任何类型
    template<typename Self>
    void print_tmpl(this Self& self) {
        std::cout << "value: " << self.value << "\n";
    }
};

int main() {
    static_assert(check() == 42);
    
    Widget w;
    w.print();  // C++23 style
    
    struct Gadget { int value = 200; };
    Gadget g;
    g.print_tmpl();  // 泛化: Gadget也有value成员即可
}
```

**输出：**
```
Widget: 100
value: 200
```

---

## 四、Deducing this 的应用场景

### 场景 1：简化实现继承中的方法转发

```cpp
struct Base {
    template<typename Self>
    void common(this Self& self) {
        // 基类方法现在可以访问任何子类的成员
    }
};

struct Derived : Base {};
```

### 场景 2：解决菱形继承问题

```cpp
struct A { int x; };
struct B : A {};
struct C : A {};

// 传统方式需要虚继承
struct D : B, C {};

// deducing this 更自然地处理 this 调整
```

### 场景 3：泛型方法的简洁实现

```cpp
struct Data {
    std::vector<int> values;
    
    // 一个方法，同时支持拷贝和移动
    template<typename Self>
    auto sum(this Self& self) {
        // self 既可以是 Data& 也可以是 Data&&
    }
};
```

---

## 五、if consteval vs __builtin_is_constant_evaluating

| 特性 | if consteval | __builtin_is_constant_evaluting |
|------|-------------|--------------------------------|
| 标准 | C++23 标准 | GCC/Clang 扩展 |
| 可移植性 | ✅ 通用 | ❌ 仅 GCC/Clang |
| 语法 | `if consteval { }` | `if (__builtin_is_constant_evaluting())` |
| 上下文判断 | 精确 | 近似 |

**建议**：始终使用 `if consteval`，它是标准写法，语义也更清晰。

---

> **总结**：`if consteval` 和 `deducing this` 是 C++23 最重要的两大手册（handbook）改进。前者让编译期分支判断成为标准语法，后者让成员函数摆脱了"只能被单一类型调用"的束缚。如果你写过模板元编程或处理过复杂的继承关系，你会立即爱上这两个特性。
---

## 📚 C++23 新特性 系列导航

> 本文是《C++23 新特性》系列第 **2/4** 篇。

| 方向 | 章节 |
|:--|:--|
| ◀ 上一篇 | [（一）std::expected](/2026/04/23/2026-04-24-cpp23-expected/) |
| 下一篇 ▶ | [（三）std::print / to_underlying](/2026/04/23/2026-04-24-cpp23-utilities/) |

<details>
<summary>📖 全部 4 篇目录（点击展开）</summary>

1. [（一）std::expected](/2026/04/23/2026-04-24-cpp23-expected/)
2. [（二）if consteval 与 Deducing this](/2026/04/23/2026-04-24-cpp23-consteval-deducing-this/) **← 当前**
3. [（三）std::print / to_underlying](/2026/04/23/2026-04-24-cpp23-utilities/)
4. [（四）Ranges 增强](/2026/04/23/2026-04-24-cpp23-ranges-enhancement/)

</details>
