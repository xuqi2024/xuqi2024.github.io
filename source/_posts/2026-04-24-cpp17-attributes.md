---
title: 【C++17】（八）Attribute 新增与代码意图显式化：让编译器读懂你的设计
date: 2026-04-23 09:00:00
categories:
  - C++新特性
tags:
- C++
- C++17
description: "C++17 引入了 [[nodiscard]]、[[maybe_unused]]、[[fallthrough]]…"
---

> **一句话结论：`[[nodiscard]]` 告诉你「这个返回值必须用」，`[[maybe_unused]]` 告诉你「这个变量我知道没用」，`[[fallthrough]]` 告诉编译器「switch 里的 break 我故意不加」——三个 Attribute，把隐式意图全部显式化。**

---

## 一、为什么需要 Attribute？

在 C++11 之前，如果你想让编译器对某些代码行为发出警告或忽略警告，手段非常有限：只能靠 `#pragma`（不可移植）、编译器特定的 `__attribute__`（GCC/Clang 专用）。C++11 引入了统一的属性语法 `[[attr]]`，但标准库本身提供的属性寥寥无几。

C++17 终于补全了三个工程中真正需要的属性：**`[[nodiscard]]`**、**`[[maybe_unused]]`**、**`[[fallthrough]]`**。这三个属性直接对应了真实项目中最高频的代码模式。

---

## 二、`[[nodiscard]]`：返回值不能被丢弃

### 2.1 基本用法

`[[nodiscard]]` 标记一个函数或类，**告诉编译器：这个函数的返回值不能被忽略**。如果调用者没有使用返回值，编译器必须发出警告。

```cpp
#include <iostream>

// 标记函数：返回值不能忽略
[[nodiscard]] int compute_priority() {
    return 42;
}

// C++17 支持带消息的 nodiscard
[[nodiscard("Resource acquired must be released")]]
int* acquire_resource() {
    return new int(100);
}

int main() {
    compute_priority();  // ⚠️ 编译器警告: 返回值被忽略
    
    acquire_resource();   // ⚠️ 编译器警告: 分配的内存泄漏了
    // 正确做法:
    // int* p = acquire_resource();
    // delete p;
}
```

### 2.2 应用场景

**场景一：资源分配函数**

```cpp
[[nodiscard]] std::unique_ptr<Connection> connect(const std::string& host) {
    return std::make_unique<Connection>(host);
}

void bad() {
    connect("example.com");  // ⚠️ 警告：unique_ptr 被销毁，连接从未建立
}
```

**场景二：错误码返回**

```cpp
[[nodiscard]] ErrorCode init_system() {
    return ErrorCode::SUCCESS;
}

int main() {
    init_system();  // ⚠️ 警告：系统初始化结果被忽略
}
```

**场景三：类级别的 `[[nodiscard]]`**

```cpp
struct Result {
    int value;
    
    [[nodiscard]] bool is_valid() const { return value > 0; }
};

int main() {
    Result r{10};
    r.is_valid();  // ⚠️ 警告：bool 结果被丢弃
}
```

### 2.3 对比旧式方案

| 方案 | 原理 | 缺点 |
|------|------|------|
| `(void)result;` | 手动强制转换抑制警告 | 繁琐，代码丑陋，容易遗忘 |
| 注释 `// DO NOT IGNORE` | 对编译器无效 | 编译器不会强制检查 |
| `[[nodiscard]]` | 编译器强制检查 | C++17 以前不可用 |

---

## 三、`[[maybe_unused]]`：我知道这个变量没用到

### 3.1 基本用法

`[[maybe_unused]]` 告诉编译器：「这个变量/参数/函数我知道可能没用到，不要报警告」。这解决了两个高频痛点：

1. **回调函数参数**：接口定义需要参数，但某个具体实现用不上
2. **调试/条件编译**：`NDEBUG` 宏控制下某些变量可能不被使用

```cpp
#include <iostream>

// 场景一：回调接口，参数暂未使用
void on_event(int event_id, [[maybe_unused]] const void* data) {
    // data 参数暂时不需要，但接口签名要求必须有
    std::cout << "event: " << event_id << "\n";
}

// 场景二：函数定义，编译选项决定是否使用
void debug_log(const char* msg, [[maybe_unused]] int level = 0) {
#ifdef NDEBUG
    // level 在 release 版本中不使用
    (void)level;  // 旧式做法：必须手动 cast
#endif
    std::cout << msg << "\n";
}

// 场景三：类成员变量
struct Cache {
    [[maybe_unused]] int debug_counter = 0;  // 仅调试用
    int data;
};
```

### 3.2 对比 `(void)var;` 旧式写法

```cpp
// 旧式：必须手动写 (void) 强制消除警告
void old_style(int a, int b) {
    (void)b;  // b 未使用
    std::cout << a << "\n";
}

// C++17 新式：干净利落
void new_style(int a, [[maybe_unused]] int b) {
    std::cout << a << "\n";
}
```

---

## 四、`[[fallthrough]]`：switch 中故意不加 break

### 4.1 基本用法

在 `switch` 语句中，多个 `case` 共用同一段代码是常见模式。但编译器会把「漏写 `break`」当作 bug 并发出警告。`[[fallthrough]]` 让这个行为变得显式：

```cpp
#include <iostream>

void classify(char c) {
    switch (c) {
        case 'a':
        case 'e':
        case 'i':
        case 'o':
        case 'u':
            std::cout << c << " 是元音\n";
            [[fallthrough]];  // ✅ 显式声明：故意继续执行下一个 case
        default:
            std::cout << c << " 是辅音（或非字母）\n";
            break;
    }
}
```

### 4.2 警告：必须放在 `case` 体的最后一条语句

```cpp
// 错误：[[fallthrough]] 不是最后一条语句
switch (x) {
    case 1:
        std::cout << "one\n";
        [[fallthrough]];  // ⚠️ 仍然警告：不是最后语句
        std::cout << "also one\n";
}

// 正确
switch (x) {
    case 1:
        std::cout << "one\n";
        std::cout << "also one\n";
        [[fallthrough]];  // ✅ 最后一条
    case 2:
        std::cout << "two\n";
        break;
}
```

---

## 五、综合工程示例

```cpp
#include <iostream>
#include <memory>
#include <optional>

// === nodiscard 应用：资源分配/关键函数 ===
[[nodiscard("Connection must be released by caller")]]
std::unique_ptr<int, void(*)(int*)> make_connection() {
    auto deleter = [](int* p) { 
        std::cout << "Connection closed\n"; 
        delete p; 
    };
    return { new int(42), deleter };
}

// === maybe_unused 应用：接口定义/条件编译 ===
struct EventHandler {
    virtual ~EventHandler() = default;
    virtual void on_click(int x, int y, [[maybe_unused]] int button) {
        // button 参数当前不需要
        std::cout << "clicked at " << x << "," << y << "\n";
    }
};

// === fallthrough 应用：字符分类 ===
enum class CharType { Vowel, Consonant, Other };

[[nodiscard]] CharType classify_char(char c) {
    switch (c) {
        case 'a': case 'e': case 'i': case 'o': case 'u':
        case 'A': case 'E': case 'I': case 'O': case 'U':
            return CharType::Vowel;
            [[fallthrough]];  // 也打印 "also a vowel"
        default:
            if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
                std::cout << "(also a consonant in some orthographies)\n";
                return CharType::Consonant;
            }
            return CharType::Other;
    }
}

// === 组合使用 ===
class Parser {
    [[nodiscard]] std::optional<int> parse_int(const char* s) const {
        // 解析逻辑
        if (!s || *s == '\0') return std::nullopt;
        return std::stoi(s);
    }

public:
    void parse(const char* input, [[maybe_unused]] bool verbose = false) {
        auto result = parse_int(input);
        if (!result.has_value()) {
            std::cout << "parse failed\n";
        }
    }
};

int main() {
    // nodiscard 示例
    auto conn = make_connection();
    std::cout << "value: " << *conn << "\n";
    
    // maybe_unused 示例
    Parser p;
    p.parse("42");
    
    // fallthrough 示例
    classify_char('e');  // 打印 "e 是元音" 和 "(also a consonant...)"
    classify_char('b');  // 只打印 "b 是辅音（或非字母）"
}
```

---

## 六、Attribute 完整列表（C++11 到 C++17）

| Attribute | C++标准 | 含义 |
|-----------|---------|------|
| `[[noreturn]]` | C++11 | 函数永不返回（如 `std::exit`、`throw`） |
| `[[carries_dependency]]` | C++11 | 内存序依赖链 |
| `[[deprecated]]` | C++14 | 标记废弃（可带消息） |
| `[[nodiscard]]` | C++17 | 返回值不能忽略 |
| `[[maybe_unused]]` | C++17 | 实体可能未使用 |
| `[[fallthrough]]` | C++17 | switch case 故意穿过 |

---

## 七、总结与行动建议

**核心原理**：Attribute 是编译器级别的**意图声明**。编译器收到 `[[nodiscard]]` 后，不是改变了函数行为，而是对「违反意图」的行为（如忽略返回值）主动报警。静态分析工具（如 Clang-Tidy）也会读取这些属性。

**行动建议**：
1. **立即行动**：把资源分配函数和错误码返回函数标记 `[[nodiscard]]`
2. **清理遗留代码**：搜索项目中所有 `(void)` 强制转换，用 `[[maybe_unused]]` 替代
3. **团队规范**：在 code review 中检查 `switch` 是否有未标记的隐式 fallthrough
4. **C++20 预告**：`[[no_unique_address]]`、`[[likely]]`/`[[unlikely]]` 是 C++20 的重要补充

> **下篇预告**：C++17 的文件系统库 `std::filesystem` 让我们终于可以用跨平台的方式操作文件和目录——`fs::path`、`directory_iterator`、文件属性查询，一文打尽。

---

*编译测试：`g++ -std=c++17 -Wall -Wextra attribute_demo.cpp`*
---

## 📚 C++17 新特性 系列导航

> 本文是《C++17 新特性》系列第 **8/8** 篇。

| 方向 | 章节 |
|:--|:--|
| ◀ 上一篇 | [（七）Filesystem 大全](/2026/04/23/2026-04-24-cpp17-filesystem/) |

<details>
<summary>📖 全部 8 篇目录（点击展开）</summary>

1. [（一）Structured Bindings](/2026/04/23/2026-04-23-cpp17-structured-bindings/)
2. [（二）if constexpr](/2026/04/23/2026-04-23-cpp17-if-constexpr/)
3. [（三）Inline Variables 与 constexpr 加强](/2026/04/23/2026-04-23-cpp17-inline-constexpr/)
4. [（四）Fold Expressions](/2026/04/23/2026-04-23-cpp17-fold-expressions/)
5. [（五）std::optional / variant / any](/2026/04/23/2026-04-23-cpp17-optional-variant-any/)
6. [（六）std::apply / std::invoke](/2026/04/23/2026-04-24-cpp17-any-apply-invoke/)
7. [（七）Filesystem 大全](/2026/04/23/2026-04-24-cpp17-filesystem/)
8. [（八）Attribute 新增](/2026/04/23/2026-04-24-cpp17-attributes/) **← 当前**

</details>
