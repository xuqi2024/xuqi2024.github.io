---
title: 【C++17】（七）Filesystem 大全：从入门到工程应用
date: 2026-04-23 10:00:00
categories:
- C++新特性
tags:
- C++
- C++17
description: "还在用 fopen / opendir / stat 这些 C 风格 API 处理文件？C++17 引入的 std::filesystem 可能是你见过的最优雅的文件操作方案——一套 API…"
---

> 还在用 `fopen` / `opendir` / `stat` 这些 C 风格 API 处理文件？C++17 引入的 `std::filesystem` 可能是你见过的最优雅的文件操作方案——一套 API 打天下，跨平台、面向对象、功能齐全。

---

## 前言

在 C++17 之前，处理文件路径和目录是件痛苦的事：

- **Linux 下** 用 `opendir` / `readdir` / `closedir` 遍历目录
- **Windows 下** 用 `FindFirstFile` / `FindNextFile` / `FindClose`
- **跨平台？** 要么手写条件编译，要么引入 Boost

**结果**：代码里充斥着平台相关的 `ifdef`，维护噩梦。

C++17 统一了文件操作——`std::filesystem` 来了。

---

## 一、fs::path：路径操作的瑞士军刀

`fs::path` 是文件系统的核心，它把「路径字符串」抽象成对象，提供大量好用的成员函数。

### 1.1 路径解析

```cpp
#include <iostream>
#include <filesystem>
namespace fs = std::filesystem;

int main() {
    fs::path p = "/home/user/documents/file.txt";
    
    std::cout << "完整路径: " << p << "\n";
    std::cout << "文件名:    " << p.filename() << "\n";      // file.txt
    std::cout << "不含扩展名: " << p.stem() << "\n";          // file
    std::cout << "扩展名:    " << p.extension() << "\n";      // .txt
    std::cout << "父目录:    " << p.parent_path() << "\n";    // /home/user/documents
    std::cout << "根目录:    " << p.root_name() << "\n";      // (空或/home)
    std::cout << "根路径:    " << p.root_path() << "\n";      // /
}
```

### 1.2 路径拼接

`/` 操作符被重载，拼接路径再也不用手动加 `/`：

```cpp
fs::path base = "/home";
fs::path full = base / "user" / "documents" / "file.txt";
std::cout << full << "\n";  // /home/user/documents/file.txt
```

**注意**：C++17 的 `fs::path` 会自动处理多余的 `/`，你不用关心 `base` 后面有没有斜杠。

### 1.3 路径遍历

`fs::path` 可以像容器一样遍历每个路径元素：

```cpp
fs::path p = "/home/user/documents";
for (const auto& part : p) {
    std::cout << part << "\n";
}
// 输出: /   home   user   documents
```

---

## 二、目录遍历：directory_iterator

### 2.1 基本遍历

```cpp
// 遍历当前目录
for (const auto& entry : fs::directory_iterator(".")) {
    std::cout << entry.path().filename() << "\n";
}
```

### 2.2 递归遍历

`recursive_directory_iterator` 会递归进入子目录：

```cpp
// 递归遍历，深度优先
for (const auto& entry : fs::recursive_directory_iterator("/tmp")) {
    std::cout << entry.path() << "\n";
}
```

### 2.3 过滤遍历

可以结合 `directory_options` 跳过权限错误：

```cpp
for (const auto& entry : 
     fs::recursive_directory_iterator(".", 
         fs::directory_options::skip_permission_denied)) {
    // 跳过无权限访问的目录
}
```

---

## 三、文件状态判断

### 3.1 常见判断函数

```cpp
fs::path p = "test.txt";

if (fs::exists(p)) {
    std::cout << "文件大小: " << fs::file_size(p) << " bytes\n";
}

if (fs::is_regular_file(p)) {
    std::cout << "是普通文件\n";
}

if (fs::is_directory(p)) {
    std::cout << "是目录\n";
}

if (fs::is_symlink(p)) {
    std::cout << "是符号链接\n";
}
```

### 3.2 用 `status()` 一次性获取

```cpp
fs::path p = "test.txt";
fs::file_status s = fs::status(p);
std::cout << std::boolalpha;
std::cout << "存在: " << fs::exists(s) << "\n";
std::cout << "是文件: " << fs::is_regular_file(s) << "\n";
```

---

## 四、目录与文件操作

### 4.1 创建目录

```cpp
// 创建单个目录（父目录必须存在）
fs::create_directory("/tmp/mydir");

// 创建多级目录（父目录不存在也会创建）
fs::create_directories("/tmp/a/b/c/subdir");
```

### 4.2 删除操作

```cpp
// 删除文件（不能删目录）
fs::remove("temp.txt");

// 删除空目录
fs::remove("/tmp/emptydir");

// 递归删除目录及内容（慎用！）
fs::remove_all("/tmp/cleanup");
```

### 4.3 复制 / 移动

```cpp
// 复制文件
fs::copy_file("a.txt", "b.txt", fs::copy_options::overwrite_existing);

// 复制目录（递归）
fs::copy_directory("src", "dst");

// 移动 / 重命名
fs::rename("old.txt", "new.txt");
fs::rename("file.txt", "/new/location/file.txt");  // 也是移动
```

---

## 五、工程应用示例

### 5.1 配置加载框架

```cpp
#include <iostream>
#include <filesystem>
#include <fstream>
#include <string>

namespace fs = std::filesystem;

class ConfigLoader {
public:
    bool loadFromDir(const fs::path& dir) {
        if (!fs::exists(dir) || !fs::is_directory(dir)) {
            std::cerr << "目录不存在: " << dir << "\n";
            return false;
        }
        
        for (const auto& entry : fs::directory_iterator(dir)) {
            if (entry.is_regular_file() && entry.path().extension() == ".conf") {
                loadFile(entry.path());
            }
        }
        return true;
    }
    
private:
    void loadFile(const fs::path& p) {
        std::ifstream fin(p);
        std::cout << "加载配置: " << p.filename() << "\n";
        // 实际解析逻辑...
    }
};
```

### 5.2 文件监控框架

```cpp
#include <iostream>
#include <filesystem>
#include <chrono>
#include <thread>

namespace fs = std::filesystem;

class FileWatcher {
public:
    void watch(const fs::path& dir, int interval_sec = 2) {
        std::cout << "监控目录: " << dir << "\n";
        
        while (true) {
            try {
                for (const auto& entry : fs::recursive_directory_iterator(dir)) {
                    auto mtime = fs::last_write_time(entry);
                    // 检查文件是否有变化（简化示例）
                    if (mtime > last_check_) {
                        std::cout << "检测到变化: " << entry.path() << "\n";
                    }
                }
            } catch (const fs::filesystem_error& e) {
                std::cerr << "监控错误: " << e.what() << "\n";
            }
            
            last_check_ = fs::file_time_type::clock::now();
            std::this_thread::sleep_for(std::chrono::seconds(interval_sec));
        }
    }
    
private:
    fs::file_time_type last_check_ = fs::file_time_type::clock::now();
};
```

---

## 六、boost::filesystem vs std::filesystem

| 维度 | boost::filesystem | std::filesystem |
|------|-------------------|-----------------|
| **版本** | Boost 1.46+ (2008) | C++17 (2017) |
| **头文件** | `<boost/filesystem.hpp>` | `<filesystem>` |
| **命名空间** | `boost::filesystem` | `std::filesystem` |
| **跨平台** | ✅ 需编译 Boost | ✅ 标准支持，编译器自带 |
| **ABI 兼容性** | Boost 版本相关 | 标准保证 |
| **推荐** | 旧代码维护 | **新项目首选** |

**结论**：新项目直接用 `std::filesystem`，没有理由再用 Boost 的版本。

---

## 七、完整示例

```cpp
#include <iostream>
#include <filesystem>
namespace fs = std::filesystem;

int main() {
    fs::path p = "/home/user/documents/file.txt";
    std::cout << "filename: " << p.filename() << "\n";
    std::cout << "stem: " << p.stem() << "\n";
    std::cout << "extension: " << p.extension() << "\n";
    std::cout << "parent: " << p.parent_path() << "\n";
    
    // 遍历当前目录
    for (const auto& entry : fs::directory_iterator(".")) {
        std::cout << entry.path().filename() << "\n";
    }
    
    // 路径操作
    fs::path base = "/home";
    fs::path full = base / "user" / "file.txt";
    std::cout << full << "\n";
    
    // 判断
    if (fs::exists("test.txt")) {
        std::cout << "size: " << fs::file_size("test.txt") << "\n";
    }
    
    // 创建目录
    fs::create_directories("/tmp/test/subdir");
    
    // 复制文件
    fs::copy_file("a.txt", "b.txt", fs::copy_options::overwrite_existing);
}
```

---

> **行动建议**：把项目里散落在各处的 `FILE*` / `opendir` / `GetFileAttributes` 统一替换成 `std::filesystem` 吧——代码会更短、更安全、更好维护。
---

## 📚 C++17 新特性 系列导航

> 本文是《C++17 新特性》系列第 **7/8** 篇。

| 方向 | 章节 |
|:--|:--|
| ◀ 上一篇 | [（六）std::apply / std::invoke](/2026/04/23/2026-04-24-cpp17-any-apply-invoke/) |
| 下一篇 ▶ | [（八）Attribute 新增](/2026/04/23/2026-04-24-cpp17-attributes/) |

<details>
<summary>📖 全部 8 篇目录（点击展开）</summary>

1. [（一）Structured Bindings](/2026/04/23/2026-04-23-cpp17-structured-bindings/)
2. [（二）if constexpr](/2026/04/23/2026-04-23-cpp17-if-constexpr/)
3. [（三）Inline Variables 与 constexpr 加强](/2026/04/23/2026-04-23-cpp17-inline-constexpr/)
4. [（四）Fold Expressions](/2026/04/23/2026-04-23-cpp17-fold-expressions/)
5. [（五）std::optional / variant / any](/2026/04/23/2026-04-23-cpp17-optional-variant-any/)
6. [（六）std::apply / std::invoke](/2026/04/23/2026-04-24-cpp17-any-apply-invoke/)
7. [（七）Filesystem 大全](/2026/04/23/2026-04-24-cpp17-filesystem/) **← 当前**
8. [（八）Attribute 新增](/2026/04/23/2026-04-24-cpp17-attributes/)

</details>
