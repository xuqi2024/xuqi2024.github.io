---
title: 【C++23】Ranges 增强与 views::chunk_by：数据处理新利器
date: 2026-04-24 10:00:00
categories:
- C++新特性
tags:
- C++23
- Ranges
- Views
---

> 数据处理时，你还在用循环 + 计数器分组吗？C++23 的 `views::chunk_by` 让「按条件对连续元素分组」变得优雅——一行代码搞定以前要 20 行的逻辑。

---

## 前言

C++20 引入了 Ranges 库，改变了我们写算法的方式：**惰性求值、管道语法、组合性**。

C++23 在此基础上大幅增强，带来了一批实用的新 views：

- `chunk_by`：按条件分组连续元素
- `enumerate`：带索引遍历
- `zip_transform`：多序列并行变换
- `concat`：拼接视图
- `ranges::to`：视图转容器

---

## 一、views::chunk_by：连续元素分组

### 1.1 痛点回顾

假设有这样一个需求：**把数组 `{1, 1, 2, 2, 2, 3, 1, 1}` 按「相邻相同元素」分组**。

以前要这么写：

```cpp
std::vector<int> nums = {1, 1, 2, 2, 2, 3, 1, 1};
std::vector<std::vector<int>> groups;
std::vector<int> current;

for (int n : nums) {
    if (current.empty() || current.back() == n) {
        current.push_back(n);
    } else {
        groups.push_back(current);
        current.clear();
        current.push_back(n);
    }
}
if (!current.empty()) groups.push_back(current);
```

**代码冗长，逻辑分散**。

### 1.2 chunk_by 的优雅解法

```cpp
#include <iostream>
#include <vector>
#include <ranges>

namespace rv = std::views;

int main() {
    std::vector<int> nums = {1, 1, 2, 2, 2, 3, 1, 1};
    
    // views::chunk_by: 按谓词分组相邻元素 (C++23)
    for (auto&& chunk : nums | rv::chunk_by(std::equal_to{})) {
        int first = *chunk.begin();
        int count = std::ranges::distance(chunk);
        std::cout << "value=" << first << " count=" << count << "\n";
    }
}
```

**输出**：
```
value=1 count=2
value=2 count=3
value=3 count=1
value=1 count=2
```

### 1.3 chunk_by 的语义

`chunk_by` 的关键点：

1. **比较相邻元素**：用传入的谓词（如 `std::equal_to{}`）判断相邻元素是否该分到同一组
2. **只分组连续相同**：非连续的相同值会分成不同组
3. **返回 views**：不复制数据，惰性求值

```cpp
// chunk_by 的分组逻辑图示
// nums:  {1, 1, 2, 2, 2, 3, 1, 1}
//          ───  ─────  ─  ───
//          group1  group2 g3 g4
```

### 1.4 自定义谓词

可以用任意二元谓词，不只是相等比较：

```cpp
// 按 "差值小于 3" 分组
std::vector<int> data = {1, 2, 4, 7, 8, 9, 12};
for (auto&& chunk : data | rv::chunk_by([](int a, int b) {
    return b - a <= 2;  // 差值小于等于2，认为是同一组
})) {
    // chunk: {1,2}, {4}, {7,8,9}, {12}
}
```

---

## 二、views::enumerate：带索引遍历

### 2.1 痛点

以前想知道元素的下标，往往要额外维护一个计数器：

```cpp
std::vector<std::string> words = {"hello", "world"};
for (size_t i = 0; i < words.size(); ++i) {
    std::cout << i << ": " << words[i] << "\n";
}
```

### 2.2 enumerate 的优雅解法

```cpp
#include <iostream>
#include <vector>
#include <string>
#include <ranges>

namespace rv = std::views;

int main() {
    std::vector<std::string> words = {"hello", "world"};
    for (auto [i, word] : words | rv::enumerate) {
        std::cout << i << ": " << word << "\n";
    }
}
```

**输出**：
```
0: hello
1: world
```

### 2.3 组合使用

enumerate 可以和其他 view 组合：

```cpp
std::vector<int> nums = {3, 6, 9, 12, 15};

// 找第一个大于 10 的元素的索引
auto result = nums | rv::enumerate 
                    | rv::filter([](auto&& item) { return item.second > 10; })
                    | rv::take(1);
```

---

## 三、views::zip_transform：多序列并行变换

### 3.1 痛点

想要把两个向量对应元素相加？以前要：

```cpp
std::vector<int> a = {1, 2, 3};
std::vector<int> b = {10, 20, 30};
std::vector<int> result;

for (size_t i = 0; i < a.size(); ++i) {
    result.push_back(a[i] + b[i]);
}
```

### 3.2 zip_transform 的优雅解法

```cpp
#include <iostream>
#include <vector>
#include <functional>
#include <ranges>

int main() {
    std::vector<int> a = {1, 2, 3};
    std::vector<int> b = {10, 20, 30};
    
    // zip_transform: 两两对应，经过变换
    for (int sum : std::views::zip_transform(std::plus<>{}, a, b)) {
        std::cout << sum << " ";  // 11 22 33
    }
    std::cout << "\n";
}
```

### 3.3 组合自定义变换

```cpp
// 两字符串对应字符拼接
std::vector<std::string> s1 = {"a", "b", "c"};
std::vector<std::string> s2 = {"1", "2", "3"};

for (auto&& combined : std::views::zip_transform(
        [](const std::string& x, const std::string& y) { 
            return x + y; 
        }, s1, s2)) {
    std::cout << combined << "\n";  // a1, b2, c3
}
```

---

## 四、views::concat：拼接视图

### 4.1 拼接多个容器

```cpp
#include <iostream>
#include <vector>
#include <ranges>

int main() {
    std::vector<int> a = {1, 2, 3};
    std::vector<int> b = {4, 5};
    std::vector<int> c = {6, 7, 8, 9};
    
    for (int n : std::views::concat(a, b, c)) {
        std::cout << n << " ";  // 1 2 3 4 5 6 7 8 9
    }
    std::cout << "\n";
}
```

**注意**：`concat` 返回的是 view，不复制数据，惰性求值。

---

## 五、std::ranges::to：视图转容器

### 5.1 痛点

Ranges 的 view 是惰性的，但最终往往需要转成具体容器：

```cpp
// C++20 繁琐写法
auto filtered = nums | rv::filter([](int n) { return n % 2 == 0; });
std::vector<int> v(filtered.begin(), filtered.end());  // 显式构造
```

### 5.2 C++23 的 to

```cpp
// C++23：一行搞定
auto v = nums | rv::filter([](int n) { return n % 2 == 0; }) 
              | std::ranges::to<std::vector>();

// 甚至可以指定容器类型
auto s = nums | rv::transform([](int n) { return n * 2; }) 
              | std::ranges::to<std::set>();
```

### 5.3 to 的工厂函数

```cpp
// 更简洁的写法
auto v = std::ranges::to<vector>(nums | rv::filter(pred));
auto m = std::ranges::to<map<string, int>>(pairs | rv::transform(...));
```

---

## 六、完整示例

```cpp
#include <iostream>
#include <vector>
#include <ranges>
#include <map>

namespace rv = std::views;

int main() {
    std::vector<int> nums = {1, 1, 2, 2, 2, 3, 1, 1};
    
    // views::chunk_by: 按谓词分组相邻元素 (C++23)
    for (auto&& chunk : nums | rv::chunk_by(std::equal_to{})) {
        int first = *chunk.begin();
        int count = std::ranges::distance(chunk);
        std::cout << "value=" << first << " count=" << count << "\n";
    }
    
    // views::enumerate: 带索引遍历 (C++23)
    std::vector<std::string> words = {"hello", "world"};
    for (auto [i, word] : words | rv::enumerate) {
        std::cout << i << ": " << word << "\n";
    }
    
    // views::zip_transform: 多序列并行变换
    std::vector<int> a = {1, 2, 3};
    std::vector<int> b = {10, 20, 30};
    for (int sum : std::views::zip_transform(std::plus<>{}, a, b)) {
        std::cout << sum << " ";  // 11 22 33
    }
    std::cout << "\n";
    
    // ranges::to: 视图转容器
    auto v = nums | rv::filter([](int n) { return n % 2 == 0; }) 
                  | std::ranges::to<std::vector>();
    (void)v;
}
```

---

## 七、C++23 Ranges 新特性一览

| 特性 | 作用 | 典型场景 |
|------|------|---------|
| `views::chunk_by` | 按谓词分组相邻元素 | 数据分块、合并连续区间 |
| `views::enumerate` | 带索引遍历 | 需要下标的循环 |
| `views::zip_transform` | 多序列并行变换 | 向量运算、交叉合并 |
| `views::concat` | 拼接多个视图 | 多个容器串接 |
| `ranges::to<Container>` | 视图转容器 | 最终物化结果 |

---

> **行动建议**：从今天起，遇到「分组」「索引」「两两运算」的场景，试试这些 C++23 Ranges 工具——你会发现数据处理代码可以如此简洁优雅。
