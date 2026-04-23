---
title: 【C++23】（三）std::print / std::to_underlying / std::embed：工具箱大升级
date: 2026-04-23 09:53:00
categories:
- C++新特性
tags:
- C++
- C++23
---

> C++23 不仅带来了 `std::expected`、`if consteval` 这样的"大新闻"，还升级了一系列日常工具函数。`std::print` 让输出更简洁，`std::to_underlying` 让类型转换更清晰，`contains()` 让查找更直观。本文为你盘点这些"小而美"的改进。

---

## 一、std::print：一行搞定格式化输出

### 传统方式的繁琐

```cpp
// C++20: std::format + std::cout
#include <format>
#include <iostream>

std::cout << std::format("Hello {}! int={}, hex={:#x}\n", "World", 42, 42);
```

`std::format` 解决了"格式化字符串"的问题，但最终还是要 `<< std::cout`。C++23 的 `std::print` 直接一步到位：

```cpp
#include <print>

std::print("Hello {}!\n", "World");
std::print("int={:d}, hex={:#x}, float={:.2f}\n", 42, 42, 3.14159);
std::print(stderr, "Error occurred\n");  // 支持输出到任意 FILE*
```

### std::print 的优势

| 特性 | 说明 |
|------|------|
| **自动支持 chrono** | `std::print("{:{%H:%M:%S}}", now);` 无需手动转换 |
| **类型安全** | 编译期检查格式，与 `std::format` 相同 |
| **性能优异** | 直接写入缓冲区，避免 `operator<<` 的虚拟调用开销 |
| **FILE* 支持** | `std::print(stderr, ...)` 比 `fprintf` 更安全 |

### chrono 集成示例

```cpp
#include <print>
#include <chrono>

auto now = std::chrono::system_clock::now();
std::print("Current time: {:%Y-%m-%d %H:%M:%S}\n", now);
```

---

## 二、std::to_underlying：类型转换更清晰

### 痛点

C++11 引入了 `std::underlying_type`，但使用起来需要两步：

```cpp
enum Color : int { Red = 1, Green, Blue };

Color c = Color::Red;

// 旧方式：繁琐且容易写错
int underlying = static_cast<std::underlying_type_t<Color>>(c);

// 容易和 const_cast/ reinterpret_cast 混淆
```

### C++23 解决方案

```cpp
#include <type_traits>

Color c = Color::Red;
int underlying = std::to_underlying(c);  // ✅ 一行，语义清晰
```

`std::to_underlying(E e)` 等价于 `static_cast<std::underlying_type_t<E>>(e)`，但：
- 更短
- 不容易与 `const_cast` / `reinterpret_cast` 混淆
- 意图明确："提取底层类型值"

---

## 三、std::embed：C++26 的特性（本文勘误）

> ⚠️ **勘误说明**：部分早期资料将 `std::embed` 归为 C++23，但该特性已被推迟到 **C++26**。

`std::embed` 用于在编译期将文件内容嵌入为 `std::array<char, N>`：

```cpp
// C++26 特性（预计）
#include <embed>

constexpr auto shader_code = std::embed("shader.frag");
static_assert(shader_code.size() > 0);
```

C++23 的实用工具主要还是 **`std::to_underlying`** 和 **`std::print`**。

---

## 四、contains()：查找再也不需要 `!= end()`

### std::map / std::unordered_map

```cpp
std::map<int, std::string> m{{1,"one"}, {2,"two"}};

// 旧方式
if (m.find(1) != m.end()) { /* ... */ }

// C++23
if (m.contains(1)) { /* ✅ 更直观 */ }
```

### std::vector / std::list

```cpp
std::vector<int> v{1, 2, 3};

// 旧方式
if (std::find(v.begin(), v.end(), 2) != v.end()) { /* ... */ }

// C++23
if (v.contains(2)) { /* ✅ 一目了然 */ }
```

### std::string / std::string_view

```cpp
std::string_view sv = "hello world";

// 检查子串
if (sv.contains("world")) { /* ✅ 替代 find() != npos */ }

// 检查前缀/后缀 (C++20 已有 starts_with/ends_with)
if (sv.starts_with("hello")) { /* ... */ }
```

---

## 五、完整示例

```cpp
#include <iostream>
#include <print>     // C++23
#include <format>    // C++20
#include <map>
#include <vector>
#include <string_view>

enum Color : int { Red = 1, Green, Blue };

int main() {
    // std::print (C++23)
    std::print("Hello {}!\n", "World");
    std::print("int={:d}, hex={:#x}, float={:.2f}\n", 42, 42, 3.14159);
    std::print(stderr, "Error occurred\n");
    
    // std::to_underlying (C++23)
    Color c = Color::Red;
    int underlying = static_cast<int>(c);  // 旧方式
    // int underlying = std::to_underlying(c);  // C++23 方式
    (void)underlying;
    
    // std::map/vector::contains (C++23)
    std::map<int, std::string> m{{1,"one"}, {2,"two"}};
    if (m.contains(1)) std::cout << "m has key 1\n";
    
    std::vector<int> v{1, 2, 3};
    if (v.contains(2)) std::cout << "v has 2\n";
    
    // std::string_view::contains (C++23)
    std::string_view sv = "hello world";
    if (sv.contains("world")) std::cout << "found\n";
}
```

**输出：**
```
Hello World!
int=42, hex=0x2a, float=3.14
Error occurred
m has key 1
v has 2
found
```

---

## 六、C++23 其他小工具一览

| 特性 | 说明 |
|------|------|
| `std::views::chunk_by()` | 按谓词分组视图 |
| `std::flat_map` | 键值对容器，底层是 vector |
| `std::flat_set` | 集合容器，底层是 vector |
| `std::views::join_with` | 用分隔符连接视图 |
| `[[assume(expr)]]` | 提示编译器表达式为真，启用更多优化 |

---

> **总结**：C++23 的这些工具函数虽然不如 `std::expected`、`co_await` 那样重磅，但它们直接提升了日常编码体验。`std::print` 让输出代码从 3 行变 1 行，`contains()` 让布尔表达式更符合自然语言习惯，`to_underlying` 让类型转换意图更清晰。这些改进值得你在下一个项目中也用起来。
