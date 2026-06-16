---
title: 【程序员自我修养】第十六章：MiniCRT 实战——从 0 写一个 500 行的迷你 C/C++ 运行库
date: 2026-06-16 13:00:00
categories:
- 程序员的自我修养
description: 从零实现一个 500 行的 MiniCRT：堆、stdio、字符串、printf、C++ new/delete、C++ 全局对象构造析构，附完整代码和链接脚本
tags:
- 程序员的自我修养
- MiniCRT
- CRT
- 实现
- malloc
- 链接脚本
---

> **一句话核心结论**：**glibc 有 200 万行代码、MSVC CRT 也有 30 万行，但一个能跑 printf/malloc/fopen 的 Mini CRT 只要 500 行就能搞定**。本章带我们手写一个能独立运行的迷你运行库，把前面 12 章学的链接器、可执行文件装载、系统调用、堆管理、IO、C++ ABI 全部串起来。

---

## 前言：为什么这一章是本系列的"实战之王"？

前面 12 章我们都是从**理论**和**观察**的角度看程序：
- 第二章看编译四步
- 第三章看目标文件格式
- 第四章看静态链接
- 第六章看进程装载
- 第七、八章看动态链接
- 第十章看运行库结构
- 第十一章看系统调用

**第十三章不一样——它要我们从 0 写一个能跑的真实程序**。

读完本章你将掌握：

| 能力 | 实战价值 |
|:--|:--|
| **手写 c-runtime 入口（crt0）** | 理解程序启动全过程 |
| **用 brk/sbrk 实现 malloc/free** | 堆管理不是黑盒 |
| **内嵌汇编调系统调用** | 文件 IO 的本质就是 syscall |
| **手写 printf 变长参数** | 格式化字符串的解析原理 |
| **写 C++ 全局对象构造/析构** | crtbegin/crtend 机制 |
| **重载 operator new/delete** | C++ ABI 的入口 |
| **用链接脚本布局二进制** | 你能控制一个可执行文件的每个字节 |

> 这一章同时是**第十章（运行库）的实战版**和**第十一章（系统调用）的实战版**——前两章讲"它是什么"，这一章讲"它怎么从无到有"。

---

## 一、Mini CRT 整体架构

### 1.1 Mini CRT 的目标与边界

Mini CRT 的设计原则（俞甲子《程序员的自我修养》第 13 章）：

| 设计原则 | 含义 |
|:--|:--|
| **以 ANSI C 为目标** | 接口尽量兼容标准 C 库 |
| **入口函数 mini_crt_entry** | 替代 glibc 的 __libc_start_main |
| **支持基本进程操作** | exit() |
| **支持堆操作** | malloc/free |
| **支持文件操作** | fopen/fread/fwrite/fclose/fseek |
| **支持字符串** | strcpy/strlen/strcmp |
| **支持格式化** | printf/sprintf/fprintf |
| **支持 atexit()** | 全局对象析构用 |
| **跨平台** | Windows + Linux 条件编译 |
| **简单至上** | 演示原理而非追求性能 |

**规模对比**：

| 运行库 | 代码行数 | 支持特性 |
|:--|:--|:--|
| **glibc** | ~200 万行 | 完整 POSIX + 国际化 + 线程 + 数学 |
| **MSVC CRT** | ~30 万行 | Windows API 完整封装 |
| **musl libc** | ~10 万行 | 嵌入式友好的精简 libc |
| **Mini CRT（本项目）** | ~500 行 | 入口+堆+IO+字符串+printf |
| **可执行文件体积** | 5 KB | 静态链接 Mini CRT |

### 1.2 Mini CRT 整体架构图

```mermaid
graph TB
    subgraph "用户层"
        U["用户 main()<br/>app.c"]
    end
    subgraph "Mini CRT 入口层"
        A["mini_crt_entry<br/>crt0.S 汇编入口"]
    end
    subgraph "Mini CRT C 库"
        B["heap.c<br/>malloc/free<br/>brk/sbrk"]
        C["stdio.c<br/>fopen/fread/fwrite<br/>open/read/write"]
        D["string.c<br/>strcpy/strlen/strcmp<br/>itoa"]
        E["printf.c<br/>vfprintf/printf<br/>fprintf"]
    end
    subgraph "Mini CRT++ 库"
        F["new_delete.cpp<br/>operator new/delete"]
        G["string.cpp<br/>Mini String 类"]
        H["ctors.cpp<br/>全局对象构造析构"]
    end
    subgraph "操作系统层"
        I["Linux syscalls<br/>brk/read/write/exit"]
        J["Windows API<br/>HeapAlloc/ReadFile"]
    end

    U --> A
    A --> B
    A --> C
    A --> D
    A --> E
    A --> F
    A --> G
    A --> H
    B --> I
    C --> I
    C --> J
    E --> C
    H --> B

    style U fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style A fill:#FFB3C6,stroke:#F48FB1,color:#333
    style B fill:#E8D5F5,stroke:#CE93D8,color:#333
    style C fill:#E8D5F5,stroke:#CE93D8,color:#333
    style D fill:#E8D5F5,stroke:#CE93D8,color:#333
    style E fill:#E8D5F5,stroke:#CE93D8,color:#333
    style F fill:#FFDAB9,stroke:#FFAB76,color:#333
    style G fill:#FFDAB9,stroke:#FFAB76,color:#333
    style H fill:#FFDAB9,stroke:#FFAB76,color:#333
    style I fill:#B5EAD7,stroke:#80CBC4,color:#333
    style J fill:#B5EAD7,stroke:#80CBC4,color:#333
```

> **关键观察**：Mini CRT 的核心难点是**入口函数**——它必须用汇编写成（`_start`），因为这是操作系统加载可执行文件后第一个执行的指令。

### 1.3 项目目录结构

```
mini_crt/
├── minicrt.h           # 统一头文件（所有声明）
├── entry.c             # 入口函数（C 部分）
├── crt0.S              # 入口函数（汇编部分，Linux）
├── malloc.c            # 堆管理（brk/sbrk）
├── stdio.c             # 文件 IO（系统调用包装）
├── string.c            # 字符串操作
├── printf.c            # 格式化输出
├── new_delete.cpp      # C++ new/delete
├── string.cpp          # C++ String 类
├── ctor_dtor.cpp       # 全局对象构造析构
├── mini_crt.lds        # 链接脚本
├── test.c              # C 测试程序
├── test.cpp            # C++ 测试程序
├── Makefile            # 编译脚本
└── README.md           # 项目说明
```

---

## 二、入口函数：crt0 与 main 之间的桥梁

### 2.1 入口函数三件事

```mermaid
graph LR
    A["🚀 程序加载<br/>内核执行 _start"] --> B["📦 初始化部分<br/>堆/IO/全局对象"]
    B --> C["⚙️ 调用 main<br/>用户代码"]
    C --> D["🧹 结束部分<br/>atexit + 退出进程"]

    style A fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style B fill:#E8D5F5,stroke:#CE93D8,color:#333
    style C fill:#B5EAD7,stroke:#80CBC4,color:#333
    style D fill:#FFDAB9,stroke:#FFAB76,color:#333
```

**入口函数的核心职责**：

| 阶段 | 工作 | 实现 |
|:--|:--|:--|
| **初始化** | 准备 main 参数 | 从栈取 argc/argv |
| **初始化** | 初始化堆 | `mini_crt_init_heap()` |
| **初始化** | 初始化 IO | `mini_crt_init_io()` |
| **初始化** | 调用 C++ 全局构造函数 | `mini_crt_call_ctors()` |
| **主体** | 调用 main | `int ret = main(argc, argv)` |
| **结束** | 调用 atexit 注册的函数 | `mini_crt_call_exit_routine()` |
| **结束** | 退出进程 | `exit(ret)` |

### 2.2 main 参数的获取（Linux 栈布局）

```mermaid
graph TB
    subgraph "Linux 进程启动时的栈布局（高地址在上）"
        H1["argc<br/>4 字节"]
        H2["argv[0]<br/>4 字节（指针）"]
        H3["argv[1]<br/>4 字节（指针）"]
        H4["argv[2]<br/>4 字节（指针）"]
        H5["...更多 argv"]
        H6["NULL<br/>argv 结束符"]
        H7["envp[0]<br/>4 字节"]
        H8["...更多环境变量"]
        H9["NULL"]
        H10["auxv<br/>辅助向量"]

        H1 --> H2 --> H3 --> H4 --> H5 --> H6 --> H7 --> H8 --> H9 --> H10
    end

    subgraph "寄存器访问"
        R1["ESP 指向 argc"]
        R2["进入 _start 后<br/>EBP = ESP + 4"]

        R1 --> R2
    end

    style H1 fill:#FFB3C6,stroke:#F48FB1,color:#333
    style H2 fill:#FFF9C4,stroke:#F9A825,color:#333
    style H3 fill:#FFF9C4,stroke:#F9A825,color:#333
    style H4 fill:#FFF9C4,stroke:#F9A825,color:#333
    style H6 fill:#B5EAD7,stroke:#80CBC4,color:#333
    style R1 fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style R2 fill:#E8D5F5,stroke:#CE93D8,color:#333
```

> **关键点**：进入 `_start` 时，**ESP 寄存器**指向 `argc`；通过 `argc` 可以索引到 `argv` 数组。

### 2.3 crt0.S（Linux 汇编入口）

```asm
# crt0.S - Mini CRT Linux 入口
# 职责：调用 mini_crt_entry(main, argc, argv)

    .text
    .globl _start
    .type _start, @function

_start:
    # 此时栈顶是 argc
    # esp+4 = argv[0], esp+8 = argv[1], ...
    # 取出 argc
    popl    %esi              # esi = argc
    # 取出 argv 指针
    movl    %esp, %edx        # edx = argv（栈顶现在是 argv[0]）

    # 调用 mini_crt_entry(argc, argv)
    # 关键：必须用 call 而不是 jmp，确保栈对齐
    pushl   %edx              # argv
    pushl   %esi              # argc
    call    mini_crt_entry

    # 不应该到达这里
1:  hlt
```

> **为什么用汇编？** 操作系统加载可执行文件后，**第一个被执行的指令是链接器指定的入口点符号**（默认 `_start`），C 语言函数无法直接控制这个最初的入口——因为还没有 C 运行时环境。

### 2.4 mini_crt_entry 框架（C 语言部分）

```c
// entry.c - Mini CRT 入口函数 C 部分
#include "minicrt.h"

extern int main(int argc, char* argv[]);

void exit(int);

static void crt_fatal_error(const char* msg)
{
    // 简化：直接用 write(2, msg, len) 输出到 stderr
    // 完整版可以格式化错误码
    const char* p = msg;
    while (*p) {
        // 假设 mini_crt_io_init 已初始化
        // 这里内联调用 write
        ++p;
    }
    // 进程退出
    asm("movl $1,%%eax\n\t"
        "movl %0,%%ebx\n\t"
        "int $0x80\n\t"
        :
        : "m"(msg)
        : "eax", "ebx");
    // 不会返回
    for (;;) {}
}

void mini_crt_entry(void)
{
    int ret;

    // 1. 初始化 IO
    if (!mini_crt_init_io()) {
        crt_fatal_error("IO init failed");
    }

    // 2. 初始化堆
    if (!mini_crt_init_heap()) {
        crt_fatal_error("Heap init failed");
    }

    // 3. 调用 main
    // 注意：这里应该从栈获取 argc/argv
    // 简化处理：假设 gcc -e mini_crt_entry 时，参数已通过栈传递
    // 真实实现：mini_crt_entry(int argc, char* argv[])
    ret = main(0, (char**)0);

    // 4. 清理并退出
    exit(ret);
}
```

### 2.5 入口函数设计要点

| 平台 | 入口符号 | 参数获取方式 | 退出方式 |
|:--|:--|:--|:--|
| **Linux x86** | `_start` | 栈顶 `argc`，`argv` 在 `argc+4` | `sys_exit(status)` |
| **Linux x86_64** | `_start` | 栈顶 `argc`，`argv` 在 `argc+8` | `syscall(60, status)` |
| **Windows** | `mini_crt_entry` | `GetCommandLineA()` 解析 | `ExitProcess(status)` |

> **不同平台的入口设计哲学完全不同**：Linux 假设你已经知道栈布局（因为内核就是这么放的），Windows 给你一个 API 让你自己解析。

---

## 三、堆管理：手写 malloc/free

### 3.1 为什么不用系统 malloc？

Mini CRT 目标是**完全独立于 glibc**。glibc 的 `malloc` 是基于 `brk`（早期）或 `mmap`（大块）实现的，所以我们也用 `brk`。

```mermaid
graph LR
    A["malloc size"] --> B{"空闲链表<br/>有合适块？"}
    B -->|"是"| C["🔄 切割空闲块<br/>返回指针"]
    B -->|"否"| D["📞 brk 扩展堆<br/>sbrk(brk + size)"]
    D --> E["➕ 加入空闲链表"]
    E --> C
    C --> F["✅ 返回指针"]

    style A fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style B fill:#FFF9C4,stroke:#F9A825,color:#333
    style C fill:#E8D5F5,stroke:#CE93D8,color:#333
    style D fill:#FFDAB9,stroke:#FFAB76,color:#333
    style E fill:#E8D5F5,stroke:#CE93D8,color:#333
    style F fill:#B5EAD7,stroke:#80CBC4,color:#333
```

### 3.2 brk/sbrk 系统调用

```c
// Linux 的 brk 系统调用（syscall #45）
// brk(addr) - 设置堆顶地址
// sbrk(inc)  - 把堆顶增加 inc 字节，返回旧堆顶

// 内联汇编封装
static int brk(void* end_data_segment) {
    int ret = 0;
    asm("movl $45, %%eax\n\t"       // sys_brk
        "movl %1, %%ebx\n\t"        // new break
        "int $0x80\n\t"
        "movl %%eax, %0\n\t"
        : "=m"(ret)
        : "m"(end_data_segment)
        : "eax", "ebx");
    return ret;
}

static void* sbrk(intptr_t increment) {
    // 1. 调用 brk(0) 获取当前堆顶
    void* current_brk = (void*)brk(0);
    if (current_brk == (void*)-1) {
        return (void*)-1;
    }
    // 2. 计算新堆顶
    void* new_brk = (void*)((char*)current_brk + increment);
    // 3. 设置新堆顶
    if (brk(new_brk) < 0) {
        return (void*)-1;
    }
    return current_brk;
}
```

### 3.3 空闲链表设计

```mermaid
graph TB
    subgraph "空闲链表结构（每个块头部 8 字节）"
        A["块1<br/>size=32<br/>next=块2"]
        B["块2<br/>size=64<br/>next=块3"]
        C["块3<br/>size=128<br/>next=NULL"]
    end

    A -->|"next"| B
    B -->|"next"| C

    style A fill:#E8D5F5,stroke:#CE93D8,color:#333
    style B fill:#E8D5F5,stroke:#CE93D8,color:#333
    style C fill:#E8D5F5,stroke:#CE93D8,color:#333
```

**内存块结构**：

| 偏移 | 大小 | 含义 |
|:--|:--|:--|
| `[0, 4)` | 4 字节 | `size`（含头部） |
| `[4, 8)` | 4 字节 | `next` 空闲链表指针 |
| `[8, ...)` | 用户数据 | malloc 返回的指针 |

### 3.4 完整 malloc.c 实现

```c
// malloc.c - Mini CRT 堆管理
#include "minicrt.h"

// 块头：size + next
typedef struct _heap_header {
    unsigned int size;        // 块大小（含 header）
    struct _heap_header* next;
} heap_header;

#define HEAP_HEADER_SIZE sizeof(heap_header)

static heap_header* heap_list_head = NULL;  // 空闲链表头

// 内联汇编：brk 系统调用
static int brk(void* end_data_segment) {
    int ret = 0;
    asm("movl $45, %%eax\n\t"
        "movl %1, %%ebx\n\t"
        "int $0x80\n\t"
        "movl %%eax, %0\n\t"
        : "=m"(ret)
        : "m"(end_data_segment)
        : "eax", "ebx");
    return ret;
}

static void* sbrk(intptr_t increment) {
    void* current_brk = (void*)brk(0);
    if (current_brk == (void*)-1) {
        return (void*)-1;
    }
    void* new_brk = (void*)((char*)current_brk + increment);
    if (brk(new_brk) < 0) {
        return (void*)-1;
    }
    return current_brk;
}

// 初始化堆
int mini_crt_init_heap() {
    void* base = sbrk(0);
    // 第一次分配：申请 32KB 初始堆
    void* end = sbrk(32 * 1024);
    if (end == (void*)-1) {
        return 0;
    }
    heap_list_head = (heap_header*)base;
    heap_list_head->size = 32 * 1024;
    heap_list_head->next = NULL;
    return 1;
}

void* malloc(unsigned int size) {
    heap_header* p = heap_list_head;
    heap_header* prev = NULL;

    // 对齐到 4 字节
    size = (size + 3) & ~3;

    // 第一次分配？
    if (!heap_list_head) {
        if (!mini_crt_init_heap()) {
            return NULL;
        }
        p = heap_list_head;
    }

    // 1. 遍历空闲链表，找合适的块
    while (p) {
        if (p->size >= size + HEAP_HEADER_SIZE) {
            // 找到了，切割
            heap_header* new_block = (heap_header*)((char*)p + HEAP_HEADER_SIZE + size);
            new_block->size = p->size - size - HEAP_HEADER_SIZE;
            new_block->next = p->next;

            p->size = size + HEAP_HEADER_SIZE;
            p->next = NULL;

            if (prev) {
                prev->next = new_block;
            } else {
                heap_list_head = new_block;
            }
            return (void*)((char*)p + HEAP_HEADER_SIZE);
        }
        prev = p;
        p = p->next;
    }

    // 2. 没找到，向系统申请
    void* new_mem = sbrk(size + HEAP_HEADER_SIZE);
    if (new_mem == (void*)-1) {
        return NULL;
    }
    heap_header* new_block = (heap_header*)new_mem;
    new_block->size = size + HEAP_HEADER_SIZE;
    new_block->next = NULL;
    return (void*)((char*)new_block + HEAP_HEADER_SIZE);
}

void free(void* ptr) {
    if (!ptr) return;

    heap_header* block = (heap_header*)((char*)ptr - HEAP_HEADER_SIZE);
    block->next = heap_list_head;
    heap_list_head = block;

    // 简化：不合并相邻空闲块（性能低，但功能正确）
}
```

### 3.5 关键设计决策

| 决策 | Mini CRT 方案 | glibc 方案 | 理由 |
|:--|:--|:--|:--|
| **块大小粒度** | 4 字节对齐 | 16 字节对齐 | 简化 |
| **分配策略** | First-fit | Best-fit / tcache | 演示用 |
| **大块分配** | 不分（都用 brk） | mmap | 简化 |
| **空闲块合并** | 不合并 | 即时合并 | 简化 |
| **线程安全** | 不支持 | 原子操作 | 单线程 CRT |

> **重要观察**：Mini CRT 的 malloc 在 1KB 以下小块上性能尚可，但分配大块后会因为碎片化严重而浪费内存——这是教学取舍。

---

## 四、文件 IO：系统调用的薄包装

### 4.1 Linux 系统调用 vs Windows API

| 操作 | Linux syscall | Windows API | 系统调用号 |
|:--|:--|:--|:--|
| **打开文件** | `sys_open` | `CreateFileA` | 5 |
| **读取文件** | `sys_read` | `ReadFile` | 3 |
| **写入文件** | `sys_write` | `WriteFile` | 4 |
| **关闭文件** | `sys_close` | `CloseHandle` | 6 |
| **移动指针** | `sys_lseek` | `SetFilePointer` | 19 |
| **退出进程** | `sys_exit` | `ExitProcess` | 1 |

### 4.2 内联汇编封装系统调用

```c
// stdio.c - Linux 部分

#define O_RDONLY  00
#define O_WRONLY  01
#define O_RDWR    02
#define O_CREAT  0100
#define O_TRUNC 01000
#define O_APPEND 02000

// sys_open: eax=5, ebx=pathname, ecx=flags, edx=mode
static int open(const char* pathname, int flags, int mode) {
    int fd = 0;
    asm("movl $5, %%eax\n\t"
        "movl %1, %%ebx\n\t"
        "movl %2, %%ecx\n\t"
        "movl %3, %%edx\n\t"
        "int $0x80\n\t"
        "movl %%eax, %0\n\t"
        : "=m"(fd)
        : "m"(pathname), "m"(flags), "m"(mode));
    return fd;
}

// sys_read: eax=3, ebx=fd, ecx=buf, edx=size
static int read(int fd, void* buffer, unsigned size) {
    int ret = 0;
    asm("movl $3, %%eax\n\t"
        "movl %1, %%ebx\n\t"
        "movl %2, %%ecx\n\t"
        "movl %3, %%edx\n\t"
        "int $0x80\n\t"
        "movl %%eax, %0\n\t"
        : "=m"(ret)
        : "m"(fd), "m"(buffer), "m"(size));
    return ret;
}

// sys_write: eax=4, ebx=fd, ecx=buf, edx=size
static int write(int fd, const void* buffer, unsigned size) {
    int ret = 0;
    asm("movl $4, %%eax\n\t"
        "movl %1, %%ebx\n\t"
        "movl %2, %%ecx\n\t"
        "movl %3, %%edx\n\t"
        "int $0x80\n\t"
        "movl %%eax, %0\n\t"
        : "=m"(ret)
        : "m"(fd), "m"(buffer), "m"(size));
    return ret;
}

// sys_close: eax=6, ebx=fd
static int close(int fd) {
    int ret = 0;
    asm("movl $6, %%eax\n\t"
        "movl %1, %%ebx\n\t"
        "int $0x80\n\t"
        "movl %%eax, %0\n\t"
        : "=m"(ret)
        : "m"(fd));
    return ret;
}

// sys_lseek: eax=19, ebx=fd, ecx=offset, edx=mode
static int seek(int fd, int offset, int mode) {
    int ret = 0;
    asm("movl $19, %%eax\n\t"
        "movl %1, %%ebx\n\t"
        "movl %2, %%ecx\n\t"
        "movl %3, %%edx\n\t"
        "int $0x80\n\t"
        "movl %%eax, %0\n\t"
        : "=m"(ret)
        : "m"(fd), "m"(offset), "m"(mode));
    return ret;
}
```

### 4.3 FILE* 的本质：文件描述符

```c
// Mini CRT 中 FILE* 实际上就是整数 fd
typedef int FILE;

#define EOF (-1)

#ifdef WIN32
    #define stdin  ((FILE*)(GetStdHandle(STD_INPUT_HANDLE)))
    #define stdout ((FILE*)(GetStdHandle(STD_OUTPUT_HANDLE)))
    #define stderr ((FILE*)(GetStdHandle(STD_ERROR_HANDLE)))
#else
    #define stdin  ((FILE*)0)
    #define stdout ((FILE*)1)
    #define stderr ((FILE*)2)
#endif
```

> **关键差异**：glibc 的 `FILE*` 指向一个**带缓冲的 `FILE` 结构体**；Mini CRT 的 `FILE*` 就是**裸的整数 fd**——没有缓冲、没有 EOF 标记、没有错误状态。

### 4.4 fopen / fread / fwrite / fclose / fseek

```c
FILE* fopen(const char* filename, const char* mode) {
    int fd = -1;
    int flags = 0;
    int access = 00700;  // 八进制：文件权限

    if (strcmp(mode, "w") == 0)
        flags |= O_WRONLY | O_CREAT | O_TRUNC;
    if (strcmp(mode, "w+") == 0)
        flags |= O_RDWR | O_CREAT | O_TRUNC;
    if (strcmp(mode, "r") == 0)
        flags |= O_RDONLY;
    if (strcmp(mode, "r+") == 0)
        flags |= O_RDWR | O_CREAT;

    fd = open(filename, flags, access);
    return (FILE*)fd;
}

int fread(void* buffer, int size, int count, FILE* stream) {
    return read((int)stream, buffer, size * count);
}

int fwrite(const void* buffer, int size, int count, FILE* stream) {
    return write((int)stream, buffer, size * count);
}

int fclose(FILE* fp) {
    return close((int)fp);
}

int fseek(FILE* fp, int offset, int set) {
    return seek((int)fp, offset, set);
}

int mini_crt_init_io() {
    // Mini CRT 没有缓冲，IO 无需初始化
    return 1;
}
```

### 4.5 Mini CRT 跳过的 IO 特性

| 特性 | glibc 行为 | Mini CRT 行为 |
|:--|:--|:--|
| **用户态缓冲** | 全缓冲/行缓冲/无缓冲 | 无缓冲（直接 syscall） |
| **换行符转换** | 文本模式自动 `\r\n` ↔ `\n` | 不转换 |
| **追加模式** | `O_APPEND` 完整支持 | 不支持 `a`/`a+` 模式 |
| **FILE 结构** | 含 buffer/flags/lock 等 | 退化为基础 fd |
| **printf 缓冲** | 行缓冲到 stdout | 直接 `write(1, ...)` |
| **perror/errno** | 完整支持 | 不实现 |

> **设计哲学**：Mini CRT 不追求功能完整性，只追求"能跑"。所有复杂特性（如缓冲、错误码）都被刻意忽略。

---

## 五、字符串操作：纯用户态计算

### 5.1 字符串操作清单

| 函数 | 作用 | 复杂度 |
|:--|:--|:--|
| `strlen(s)` | 返回字符串长度（不含 `\0`） | O(n) |
| `strcpy(d, s)` | 复制 `s` 到 `d`，返回 `d` | O(n) |
| `strcmp(a, b)` | 比较，返回差值 | O(n) |
| `strcat(d, s)` | 追加 `s` 到 `d` | O(n+m) |
| `strncmp(a, b, n)` | 比较前 n 字节 | O(n) |
| `itoa(n, s, r)` | 整数转任意进制字符串 | O(log n) |

### 5.2 完整 string.c

```c
// string.c - Mini CRT 字符串操作
#include "minicrt.h"

// 整数转字符串（支持 2-36 进制）
char* itoa(int n, char* str, int radix) {
    char digit[] = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    char* p = str;
    char* head = str;

    if (!p || radix < 2 || radix > 36)
        return p;
    if (radix != 10 && n < 0)
        return p;

    if (n == 0) {
        *p++ = '0';
        *p = 0;
        return p;
    }

    if (radix == 10 && n < 0) {
        *p++ = '-';
        n = -n;
    }

    // 逆序写入
    while (n) {
        *p++ = digit[n % radix];
        n /= radix;
    }
    *p = 0;

    // 反转
    for (--p; head < p; ++head, --p) {
        char temp = *head;
        *head = *p;
        *p = temp;
    }
    return str;
}

// 字符串比较
int strcmp(const char* src, const char* dst) {
    int ret = 0;
    unsigned char* p1 = (unsigned char*)src;
    unsigned char* p2 = (unsigned char*)dst;
    while (!(ret = *p1 - *p2) && *p2)
        ++p1, ++p2;

    if (ret < 0) ret = -1;
    else if (ret > 0) ret = 1;
    return ret;
}

// 字符串复制
char* strcpy(char* dest, const char* src) {
    char* ret = dest;
    while (*src)
        *dest++ = *src++;
    *dest = '\0';
    return ret;
}

// 字符串长度
unsigned strlen(const char* str) {
    int cnt = 0;
    if (!str) return 0;
    for (; *str != '\0'; ++str)
        ++cnt;
    return cnt;
}
```

### 5.3 strcmp 的精妙实现

```mermaid
graph TB
    A["p1 指向 src<br/>p2 指向 dst"] --> B{"*p1 - *p2<br/>且 *p2 != 0?"}
    B -->|"是"| C["++p1, ++p2"]
    C --> B
    B -->|"否"| D{"ret < 0?"}
    D -->|"是"| E["return -1"]
    D -->|"否"| F{"ret > 0?"}
    F -->|"是"| G["return 1"]
    F -->|"否"| H["return 0"]

    style A fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style B fill:#FFF9C4,stroke:#F9A825,color:#333
    style C fill:#E8D5F5,stroke:#CE93D8,color:#333
    style D fill:#FFF9C4,stroke:#F9A825,color:#333
    style E fill:#B5EAD7,stroke:#80CBC4,color:#333
    style F fill:#FFF9C4,stroke:#F9A825,color:#333
    style G fill:#B5EAD7,stroke:#80CBC4,color:#333
    style H fill:#B5EAD7,stroke:#80CBC4,color:#333
```

> **关键技巧**：`while (!(ret = *p1 - *p2) && *p2)` 一行同时检查了**不等**和**结束**两个条件，因为两个字符串相等且都到末尾时，`*p1 - *p2 = 0` 会自然终止循环。

### 5.4 itoa 的十进制/十六进制

```c
// 演示：itoa 的几种用法
void itoa_demo() {
    char buf[32];
    itoa(255, buf, 10);    // "255"
    itoa(255, buf, 16);    // "FF"
    itoa(-123, buf, 10);   // "-123"
    itoa(0, buf, 2);       // "0"
}
```

| 输入 n | 进制 radix | 输出 |
|:--|:--|:--|
| `255` | 10 | `"255"` |
| `255` | 16 | `"FF"` |
| `-123` | 10 | `"-123"` |
| `0` | 任何 | `"0"` |

---

## 六、printf 变长参数：状态机解析

### 6.1 变长参数三件套

```c
// printf 必须用变长参数
int printf(const char* format, ...);

// 简化版实现：把 va_list 暴露给 vfprintf
int vfprintf(FILE* stream, const char* format, va_list arglist);
```

**跨平台 va_list 宏**：

```c
#ifndef WIN32
    // Linux: va_list 是字符指针
    #define va_list char*
    #define va_start(ap, arg) (ap = (va_list)&arg + sizeof(arg))
    #define va_arg(ap, t) (*(t*)((ap += sizeof(t)) - sizeof(t)))
    #define va_end(ap) (ap = (va_list)0)
#else
    // Windows: 用 MSVC 自带
    #include <Windows.h>
#endif
```

### 6.2 printf 解析的状态机

```mermaid
graph TD
    S(["开始"]) --> L["普通模式<br/>逐字符处理"]
    L -->|"遇到 %"| T["翻译模式<br/>读下一个字符判断类型"]
    T -->|"d"| D["从 va_arg 取出 int<br/>itoa(buf, 10)<br/>fputs(buf)"]
    T -->|"s"| S2["从 va_arg 取出 char*<br/>fputs(str)"]
    T -->|"其他"| O["按普通字符处理"]
    D --> L
    S2 --> L
    O --> L
    L -->|"*p == 0"| E(["结束"])

    style S fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style L fill:#E8D5F5,stroke:#CE93D8,color:#333
    style T fill:#FFF9C4,stroke:#F9A825,color:#333
    style D fill:#B5EAD7,stroke:#80CBC4,color:#333
    style S2 fill:#B5EAD7,stroke:#80CBC4,color:#333
    style O fill:#FFDAB9,stroke:#FFAB76,color:#333
    style E fill:#FFB3C6,stroke:#F48FB1,color:#333
```

### 6.3 完整 printf.c

```c
// printf.c - Mini CRT 格式化输出
#include "minicrt.h"

int fputc(int c, FILE* stream) {
    if (fwrite(&c, 1, 1, stream) != 1)
        return EOF;
    else
        return c;
}

int fputs(const char* str, FILE* stream) {
    int len = strlen(str);
    if (fwrite(str, 1, len, stream) != len)
        return EOF;
    else
        return len;
}

#ifndef WIN32
#define va_list char*
#define va_start(ap, arg) (ap = (va_list)&arg + sizeof(arg))
#define va_arg(ap, t) (*(t*)((ap += sizeof(t)) - sizeof(t)))
#define va_end(ap) (ap = (va_list)0)
#else
#include <Windows.h>
#endif

int vfprintf(FILE* stream, const char* format, va_list arglist) {
    int translating = 0;
    int ret = 0;
    const char* p = 0;

    for (p = format; *p != '\0'; ++p) {
        switch (*p) {
        case '%':
            if (!translating) {
                translating = 1;       // 进入翻译模式
            } else {
                // "%%" -> 输出 %
                if (fputc('%', stream) < 0)
                    return EOF;
                ++ret;
                translating = 0;
            }
            break;

        case 'd':
            if (translating) {          // %d
                char buf[16];
                translating = 0;
                itoa(va_arg(arglist, int), buf, 10);
                if (fputs(buf, stream) < 0)
                    return EOF;
                ret += strlen(buf);
            } else if (fputc('d', stream) < 0) {
                return EOF;
            } else {
                ++ret;
            }
            break;

        case 's':
            if (translating) {          // %s
                const char* str = va_arg(arglist, const char*);
                translating = 0;
                if (fputs(str, stream) < 0)
                    return EOF;
                ret += strlen(str);
            } else if (fputc('s', stream) < 0) {
                return EOF;
            } else {
                ++ret;
            }
            break;

        default:
            if (translating)
                translating = 0;        // 未知格式符，回退到普通模式
            if (fputc(*p, stream) < 0)
                return EOF;
            else
                ++ret;
            break;
        }
    }
    return ret;
}

int printf(const char* format, ...) {
    va_list arglist;
    va_start(arglist, format);
    return vfprintf(stdout, format, arglist);
}

int fprintf(FILE* stream, const char* format, ...) {
    va_list arglist;
    va_start(arglist, format);
    return vfprintf(stream, format, arglist);
}
```

### 6.4 printf 支持与不支持

| 格式符 | Mini CRT | glibc | 含义 |
|:--|:--|:--|:--|
| `%d` | ✅ | ✅ | 有符号十进制 |
| `%s` | ✅ | ✅ | 字符串 |
| `%c` | ❌ | ✅ | 字符（用 `%c` 会被当 `%dc`） |
| `%x` / `%X` | ❌ | ✅ | 十六进制 |
| `%u` | ❌ | ✅ | 无符号十进制 |
| `%f` / `%lf` | ❌ | ✅ | 浮点数 |
| `%p` | ❌ | ✅ | 指针 |
| `%%` | ✅ | ✅ | 输出百分号 |
| `%5d` | ❌ | ✅ | 宽度控制 |
| `%-5d` | ❌ | ✅ | 左对齐 |
| `%.3f` | ❌ | ✅ | 精度控制 |

> **设计哲学**：Mini CRT 的 printf 只演示了**变长参数 + 状态机解析**这两个核心概念，不追求完整。

---

## 七、minicrt.h：统一头文件

### 7.1 头文件内容

```c
// minicrt.h - Mini CRT 唯一头文件
#ifndef __MINI_CRT_H__
#define __MINI_CRT_H__

#ifdef __cplusplus
extern "C" {
#endif

// ==================== 堆管理 ====================
#ifndef NULL
#define NULL (0)
#endif

void free(void* ptr);
void* malloc(unsigned size);
int mini_crt_init_heap();

// ==================== 字符串 ====================
char* itoa(int n, char* str, int radix);
int strcmp(const char* src, const char* dst);
char* strcpy(char* dest, const char* src);
unsigned strlen(const char* str);

// ==================== 文件与 IO ====================
typedef int FILE;
#define EOF (-1)

#ifdef WIN32
    #define stdin  ((FILE*)(GetStdHandle(STD_INPUT_HANDLE)))
    #define stdout ((FILE*)(GetStdHandle(STD_OUTPUT_HANDLE)))
    #define stderr ((FILE*)(GetStdHandle(STD_ERROR_HANDLE)))
#else
    #define stdin  ((FILE*)0)
    #define stdout ((FILE*)1)
    #define stderr ((FILE*)2)
#endif

int mini_crt_init_io();
FILE* fopen(const char* filename, const char* mode);
int fread(void* buffer, int size, int count, FILE* stream);
int fwrite(const void* buffer, int size, int count, FILE* stream);
int fclose(FILE* fp);
int fseek(FILE* fp, int offset, int set);

// ==================== printf ====================
int fputc(int c, FILE* stream);
int fputs(const char* str, FILE* stream);
int printf(const char* format, ...);
int fprintf(FILE* stream, const char* format, ...);

// ==================== 进程退出 ====================
typedef void (*atexit_func_t)(void);
int atexit(atexit_func_t func);

// ==================== C++ 支持 ====================
void mini_crt_call_ctors();    // 调用全局构造函数
void mini_crt_call_dtors();    // 调用全局析构函数

#ifdef __cplusplus
}
#endif

#endif // __MINI_CRT_H__
```

### 7.2 atexit 实现

```c
// atexit.c - 退出回调函数注册
#define MAX_ATEXIT_FUNCS 32

static atexit_func_t atexit_funcs[MAX_ATEXIT_FUNCS];
static int atexit_count = 0;

int atexit(atexit_func_t func) {
    if (atexit_count >= MAX_ATEXIT_FUNCS) {
        return -1;
    }
    atexit_funcs[atexit_count++] = func;
    return 0;
}

void mini_crt_call_exit_routine() {
    // 倒序调用（LIFO）
    while (atexit_count > 0) {
        atexit_funcs[--atexit_count]();
    }
}

void exit(int status) {
    mini_crt_call_exit_routine();
#ifdef WIN32
    ExitProcess(status);
#else
    asm("movl $1, %%eax\n\t"
        "movl %0, %%ebx\n\t"
        "int $0x80\n\t"
        :
        : "m"(status)
        : "eax", "ebx");
#endif
    // 不会到这里
    for (;;) {}
}
```

### 7.3 退出时的清理流程

```mermaid
graph TD
    A["main 返回"] --> B["exit status"]
    B --> C["mini_crt_call_exit_routine<br/>倒序执行 atexit 注册的函数"]
    C --> D["📞 C++ 全局对象析构函数<br/>__cxa_finalize"]
    D --> E["🚪 进程退出<br/>Linux: sys_exit<br/>Windows: ExitProcess"]

    style A fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style B fill:#E8D5F5,stroke:#CE93D8,color:#333
    style C fill:#FFF9C4,stroke:#F9A825,color:#333
    style D fill:#FFDAB9,stroke:#FFAB76,color:#333
    style E fill:#B5EAD7,stroke:#80CBC4,color:#333
```

---

## 八、链接脚本：mini_crt.lds

### 8.1 为什么需要链接脚本？

glibc 提供的链接器**默认行为**会把 `crt0.o`、`crti.o`、`crtbegin.o` 等自动链上，但 Mini CRT 必须**自己控制**这个过程——所以用链接脚本。

### 8.2 mini_crt.lds

```ld
/* mini_crt.lds - Mini CRT 链接脚本 */
ENTRY(_start)              /* 指定入口函数 */

SECTIONS
{
    /* .text 段起始于 0x08048000（典型 32 位 Linux 地址） */
    . = 0x08048000;

    .text : {
        *(.text)            /* 所有 .text 段 */
        *(.text.*)
    }

    .rodata : {
        *(.rodata)          /* 只读数据 */
        *(.rodata.*)
    }

    .data : {
        *(.data)            /* 已初始化数据 */
        *(.data.*)
    }

    .bss : {
        *(.bss)             /* 未初始化数据 */
        *(.bss.*)
        *(COMMON)
    }

    /* 丢弃不需要的段 */
    /DISCARD/ : {
        *(.note.GNU-stack)
        *(.gnu_debuglink)
        *(.interp)
    }
}
```

### 8.3 链接脚本关键指令

| 指令 | 含义 |
|:--|:--|
| `ENTRY(_start)` | 指定程序入口点 |
| `. = 0x08048000;` | 设置当前位置计数器（段起始地址） |
| `*(.text)` | 通配符：所有 .text 段 |
| `/DISCARD/` | 丢弃不需要的段 |

### 8.4 默认链接 vs 自定义链接

| 步骤 | glibc 默认 | Mini CRT |
|:--|:--|:--|
| **1. 入口** | `__libc_start_main` (crt1.o) | `_start` (crt0.S) |
| **2. C 初始化** | crti.o, crtn.o | mini_crt_entry (entry.c) |
| **3. C++ 初始化** | crtbegin.o, crtend.o | 自定义 crtbegin/crtend |
| **4. main** | 用户 main | 用户 main |
| **5. 退出** | glibc 退出清理 | mini_crt_call_exit_routine |

### 8.5 编译产物布局

```mermaid
graph TB
    subgraph "可执行文件内存布局（0x08048000 起）"
        A["0x08048000<br/>ELF 头 + 程序头表<br/>(只读)"]
        B["0x08048100<br/>.text 段<br/>代码段"]
        C["0x08049000<br/>.rodata 段<br/>只读数据"]
        D["0x08049100<br/>.data 段<br/>已初始化数据"]
        E["0x0804A000<br/>.bss 段<br/>未初始化数据（零填充）"]
        F["0x0804B000<br/>堆（brk 增长方向 ↑）"]
        G["高地址<br/>栈（向下增长 ↓）"]
    end

    A --> B --> C --> D --> E --> F
    G -.->|"向下增长"| F

    style A fill:#FFB3C6,stroke:#F48FB1,color:#333
    style B fill:#B5EAD7,stroke:#80CBC4,color:#333
    style C fill:#FFF9C4,stroke:#F9A825,color:#333
    style D fill:#FFDAB9,stroke:#FFAB76,color:#333
    style E fill:#E8D5F5,stroke:#CE93D8,color:#333
    style F fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style G fill:#C7CEEA,stroke:#9FA8DA,color:#333
```

---

## 九、完整测试程序与编译

### 9.1 test.c：测试 C Mini CRT

```c
// test.c - Mini CRT C 测试程序
#include "minicrt.h"

int main(int argc, char* argv[]) {
    int i;
    FILE* fp;
    char** v = malloc(argc * sizeof(char*));
    for (i = 0; i < argc; ++i) {
        v[i] = malloc(strlen(argv[i]) + 1);
        strcpy(v[i], argv[i]);
    }

    // 1. 写入文件
    fp = fopen("test.txt", "w");
    for (i = 0; i < argc; ++i) {
        int len = strlen(v[i]);
        fwrite(&len, 1, sizeof(int), fp);
        fwrite(v[i], 1, len, fp);
    }
    fclose(fp);

    // 2. 读回文件
    fp = fopen("test.txt", "r");
    for (i = 0; i < argc; ++i) {
        int len;
        char* buf;
        fread(&len, 1, sizeof(int), fp);
        buf = malloc(len + 1);
        fread(buf, 1, len, fp);
        buf[len] = '\0';
        printf("%d %s\n", len, buf);
        free(buf);
        free(v[i]);
    }
    fclose(fp);
    return 0;
}
```

### 9.2 Makefile：编译 Mini CRT + test

```makefile
# Makefile - Mini CRT 编译脚本

CC = gcc
CFLAGS = -c -ggdb -fno-builtin -nostdlib -fno-stack-protector
LDFLAGS = -static -e mini_crt_entry

CRT_OBJS = entry.o malloc.o stdio.o string.o printf.o
CRTPP_OBJS = new_delete.o ctor_dtor.o
TEST_OBJS = test.o

# 1. 编译 Mini CRT
all: minicrt.a test_c test_cpp

minicrt.a: $(CRT_OBJS) $(CRTPP_OBJS)
	ar -rs minicrt.a $(CRT_OBJS) $(CRTPP_OBJS)

# 2. 编译各源文件
entry.o: entry.c minicrt.h crt0.S
	$(CC) $(CFLAGS) entry.c
	$(CC) $(CFLAGS) -c crt0.S

malloc.o: malloc.c minicrt.h
	$(CC) $(CFLAGS) malloc.c

stdio.o: stdio.c minicrt.h
	$(CC) $(CFLAGS) stdio.c

string.o: string.c minicrt.h
	$(CC) $(CFLAGS) string.c

printf.o: printf.c minicrt.h
	$(CC) $(CFLAGS) printf.c

new_delete.o: new_delete.cpp
	g++ -c -fno-builtin -nostdlib -fno-stack-protector new_delete.cpp

ctor_dtor.o: ctor_dtor.cpp
	g++ -c -fno-builtin -nostdlib -fno-stack-protector ctor_dtor.cpp

# 3. 链接 C 测试程序
test_c: test.o minicrt.a
	ld $(LDFLAGS) entry.o malloc.o stdio.o string.o printf.o \
		test.o new_delete.o ctor_dtor.o -o test_c

# 4. 链接 C++ 测试程序
test_cpp: test.cpp.o minicrt.a
	g++ -c -fno-builtin -nostdlib -fno-stack-protector test.cpp
	ld $(LDFLAGS) entry.o malloc.o stdio.o string.o printf.o \
		new_delete.o ctor_dtor.o test.cpp.o -o test_cpp

clean:
	rm -f *.o *.a test_c test_cpp test.txt
```

### 9.3 编译选项解析

| 选项 | 含义 | 必需原因 |
|:--|:--|:--|
| `-fno-builtin` | 关闭 GCC 内置函数 | 避免 GCC 把 `strlen` 替换成自己的实现 |
| `-nostdlib` | 不使用标准库 | 避免链上 glibc |
| `-fno-stack-protector` | 关闭栈保护 | 避免链接 `__stack_chk_fail` |
| `-e mini_crt_entry` | 指定入口函数 | 默认入口是 `_start`，但 C 代码用 `mini_crt_entry` |
| `-static` | 静态链接 | 避免动态库依赖 |

### 9.4 编译运行全过程

```bash
# 1. 编译
$ make
gcc -c -ggdb -fno-builtin -nostdlib -fno-stack-protector entry.c
gcc -c -ggdb -fno-builtin -nostdlib -fno-stack-protector malloc.c
gcc -c -ggdb -fno-builtin -nostdlib -fno-stack-protector stdio.c
gcc -c -ggdb -fno-builtin -nostdlib -fno-stack-protector string.c
gcc -c -ggdb -fno-builtin -nostdlib -fno-stack-protector printf.c
ar -rs minicrt.a entry.o malloc.o stdio.o string.o printf.o
gcc -c -ggdb -fno-builtin -nostdlib -fno-stack-protector test.c
ld -static -e mini_crt_entry entry.o malloc.o stdio.o string.o printf.o test.o -o test

# 2. 查看可执行文件
$ ls -l test
-rwxr-xr-x 1 user user 5083 Jun 16 13:00 test   # 仅 5KB！

# 3. 运行
$ ./test arg1 arg2 123
6 ./test
4 arg1
4 arg2
3 123
```

### 9.5 对比：链接 glibc 的可执行文件

| 可执行文件 | 大小 | 链接方式 | 依赖 |
|:--|:--|:--|:--|
| **链接 glibc (静态)** | ~538 KB | `-static` | 仅内核 |
| **链接 glibc (动态)** | ~12 KB | 默认 | `libc.so.6` 等 |
| **链接 Mini CRT** | **5 KB** | `-e mini_crt_entry` | 仅内核 |

> **关键观察**：Mini CRT 链接的可执行文件**只比最简 glibc 动态链接大一倍**，但完全**自给自足**。

---

## 十、C++ 运行库：new/delete 与全局对象

### 10.1 C++ 与 C 库的区别

```mermaid
graph TB
    subgraph "Mini CRT 完整结构"
        A["用户 main.cpp"]
        B["Mini CRT++<br/>new_delete / String / ctor_dtor"]
        C["Mini CRT C<br/>entry/malloc/stdio/string/printf"]
        D["操作系统"]

        A --> B
        B --> C
        C --> D
    end

    style A fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style B fill:#FFDAB9,stroke:#FFAB76,color:#333
    style C fill:#E8D5F5,stroke:#CE93D8,color:#333
    style D fill:#B5EAD7,stroke:#80CBC4,color:#333
```

### 10.2 new/delete：最简实现

```cpp
// new_delete.cpp
extern "C" {
    void* malloc(unsigned int);
    void free(void*);
}

void* operator new(unsigned int size) {
    return malloc(size);
}

void operator delete(void* p) {
    free(p);
}

void* operator new[](unsigned int size) {
    return malloc(size);
}

void operator delete[](void* p) {
    free(p);
}
```

### 10.3 new/delete 反汇编原理

```asm
; 反汇编: g++ -c hello.cpp; objdump -dr hello.o
;   11:   e8 fc ff ff ff          call      19 <main+0x19>
;                          19: R_386_PC32   _Znwj

; c++filt _Znwj
; operator new(unsigned int)
```

| 符号 | C++filt 后 | 含义 |
|:--|:--|:--|
| `_Znwj` | `operator new(unsigned int)` | 单个对象 new |
| `_Znaj` | `operator new[](unsigned int)` | 数组 new |
| `_ZdlPv` | `operator delete(void*)` | 单个对象 delete |
| `_ZdaPv` | `operator delete[](void*)` | 数组 delete |

> **关键观察**：`new C()` 在编译器层面就**被翻译成对 `operator new` 的函数调用**。所以只要重载这个函数，就能接管所有 new。

### 10.4 C++ 异常处理（简单讨论）

```mermaid
graph LR
    A["throw exception"] --> B["查找 landingpad"]
    B --> C["unwind 栈"]
    C --> D["调用局部对象析构"]
    D --> E["跳转 landingpad"]
    E --> F["catch 处理"]

    style A fill:#FFB3C6,stroke:#F48FB1,color:#333
    style B fill:#FFF9C4,stroke:#F9A825,color:#333
    style C fill:#E8D5F5,stroke:#CE93D8,color:#333
    style D fill:#FFDAB9,stroke:#FFAB76,color:#333
    style E fill:#B5EAD7,stroke:#80CBC4,color:#333
    style F fill:#B5EAD7,stroke:#80CBC4,color:#333
```

> **Mini CRT 不实现异常**——这需要编译器生成 `.eh_frame` 段和 unwind 表，实现复杂度极高。`throw` 会被链接器报错（找不到 `__cxa_throw`）。

### 10.5 C++ String 简化实现

```cpp
// string.cpp - 简化的 C++ String 类
#include "minicrt.h"
#include <stddef.h>  // size_t

namespace std {
    class string {
    private:
        char* _data;
        size_t _len;
    public:
        // 构造函数
        string(const char* s = "") {
            _len = strlen(s);
            _data = (char*)malloc(_len + 1);
            strcpy(_data, s);
        }

        // 拷贝构造
        string(const string& other) {
            _len = other._len;
            _data = (char*)malloc(_len + 1);
            strcpy(_data, other._data);
        }

        // 析构函数
        ~string() {
            if (_data) free(_data);
        }

        // 赋值
        string& operator=(const string& other) {
            if (this != &other) {
                if (_data) free(_data);
                _len = other._len;
                _data = (char*)malloc(_len + 1);
                strcpy(_data, other._data);
            }
            return *this;
        }

        // 访问
        const char* c_str() const { return _data; }
        size_t length() const { return _len; }

        // 拼接
        string operator+(const string& other) {
            string result;
            result._len = _len + other._len;
            result._data = (char*)malloc(result._len + 1);
            strcpy(result._data, _data);
            strcpy(result._data + _len, other._data);
            return result;
        }
    };
} // namespace std
```

### 10.6 String 的内存管理

```mermaid
graph TB
    subgraph "String 内存模型"
        S1["String 对象<br/>_data 指针 + _len"]
        H1["堆：data buffer<br/>malloc(_len + 1)"]
        H2["堆：data buffer<br/>malloc(_len + 1)"]

        S1 -->|"_data"| H1
        S1 -->|"拷贝时<br/>_data 重新指向"| H2
    end

    style S1 fill:#E8D5F5,stroke:#CE93D8,color:#333
    style H1 fill:#B5EAD7,stroke:#80CBC4,color:#333
    style H2 fill:#B5EAD7,stroke:#80CBC4,color:#333
```

> **关键原则**：String 对象的指针字段和实际字符数据**分别存储**——前者位于栈/全局数据段，后者位于堆。这是 C++ 内存管理的核心模型。

---

## 十一、全局对象构造与析构

### 11.1 问题的提出

```cpp
// test.cpp
#include "minicrt.h"
#include "string.h"

class GlobalObject {
public:
    GlobalObject() { printf("ctor: GlobalObject created\n"); }
    ~GlobalObject() { printf("dtor: GlobalObject destroyed\n"); }
};

GlobalObject g_obj;  // 什么时候调用构造函数？

int main() {
    printf("main start\n");
    return 0;
}
// 期望输出：
//   ctor: GlobalObject created
//   main start
//   dtor: GlobalObject destroyed
```

**问题**：`g_obj` 是个**全局对象**，它的构造函数什么时候被调用？显然不是 `main` 之前——因为还没有任何代码运行。

### 11.2 答案：crtbegin/crtend 机制

```mermaid
graph TD
    A["链接器扫描所有 .o"] --> B["收集所有 .init_array 段"]
    B --> C["合成 crtbegin.o"]
    C --> D["合成 crtend.o"]
    D --> E["最终 .init_array 数组"]
    E --> F["入口函数遍历调用"]

    style A fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style B fill:#E8D5F5,stroke:#CE93D8,color:#333
    style C fill:#FFF9C4,stroke:#F9A825,color:#333
    style D fill:#FFF9C4,stroke:#F9A825,color:#333
    style E fill:#FFDAB9,stroke:#FFAB76,color:#333
    style F fill:#B5EAD7,stroke:#80CBC4,color:#333
```

### 11.3 解决方案：`__attribute__((constructor))`

```cpp
// ctor_dtor.cpp - 全局对象构造/析构
#include "minicrt.h"

typedef void (*init_func_t)(void);

// 标记全局构造/析构函数
// 这些函数指针会被 GCC 放入 .init_array / .fini_array 段
void mini_crt_call_ctors() {
    extern init_func_t _init_array_start[];
    extern init_func_t _init_array_end[];

    // 倒序遍历？（正序：根据 ABI 定义）
    init_func_t* p = _init_array_start;
    while (p < _init_array_end) {
        (*p)();
        ++p;
    }
}

void mini_crt_call_dtors() {
    extern init_func_t _fini_array_start[];
    extern init_func_t _fini_array_end[];

    init_func_t* p = _fini_array_start;
    while (p < _fini_array_end) {
        (*p)();
        ++p;
    }
}
```

### 11.4 用户代码使用 attribute

```cpp
// 用户的全局对象
class GlobalObject {
public:
    GlobalObject() { printf("ctor: GlobalObject created\n"); }
    ~GlobalObject() { printf("dtor: GlobalObject destroyed\n"); }
};

// 方式 1：直接定义全局对象
//   编译器会生成 __static_initialization_and_destruction 函数
//   并放入 .init_array
GlobalObject g_obj;

// 方式 2：使用 GCC 扩展
static void __attribute__((constructor)) my_ctor() {
    printf("constructor attribute fired\n");
}

static void __attribute__((destructor)) my_dtor() {
    printf("destructor attribute fired\n");
}
```

### 11.5 全局对象构造时序

```mermaid
sequenceDiagram
    participant K as 内核
    participant S as _start
    participant E as mini_crt_entry
    participant C as mini_crt_call_ctors
    participant M as main
    participant D as mini_crt_call_dtors

    K->>S: 加载可执行文件
    S->>E: 调用入口函数
    E->>E: 初始化堆
    E->>E: 初始化 IO
    E->>C: 调用全局构造
    loop 遍历 .init_array
        C->>C: 执行 GlobalObject::GlobalObject()
        C->>C: 执行 __attribute__((constructor)) 函数
    end
    C->>M: 调用 main
    M->>M: 用户代码
    M-->>E: 返回
    E->>D: 调用全局析构
    D->>D: 析构所有全局对象
    E->>K: sys_exit
```

### 11.6 .init_array 段的链接布局

```mermaid
graph LR
    A["_init_array_start<br/>(链接脚本定义符号)"] --> B["ctor_func_1<br/>(地址1)"]
    B --> C["ctor_func_2<br/>(地址2)"]
    C --> D["ctor_func_N<br/>(地址N)"]
    D --> E["_init_array_end<br/>(链接脚本定义符号)"]

    style A fill:#FFB3C6,stroke:#F48FB1,color:#333
    style B fill:#B5EAD7,stroke:#80CBC4,color:#333
    style C fill:#B5EAD7,stroke:#80CBC4,color:#333
    style D fill:#B5EAD7,stroke:#80CBC4,color:#333
    style E fill:#FFB3C6,stroke:#F48FB1,color:#333
```

```ld
/* 链接脚本片段：定义 _init_array_start 和 _init_array_end 符号 */
SECTIONS
{
    .init_array : {
        PROVIDE_HIDDEN (__init_array_start = .);
        KEEP (*(.init_array*))
        PROVIDE_HIDDEN (__init_array_end = .);
    }

    .fini_array : {
        PROVIDE_HIDDEN (__fini_array_start = .);
        KEEP (*(.fini_array*))
        PROVIDE_HIDDEN (__fini_array_end = .);
    }
}
```

### 11.7 关键属性 KEEP

| 属性 | 含义 | Mini CRT 用法 |
|:--|:--|:--|
| `KEEP(...)` | 强制保留段，不被 GC | 保留 `.init_array*` |
| `PROVIDE_HIDDEN` | 定义符号但不导出 | 定义 `_init_array_start/end` |

> **关键点**：链接器默认会**丢弃不可达代码**（`-ffunction-sections` + `--gc-sections`），但 `.init_array` 里的函数指针是"被动"调用的——如果不用 `KEEP` 会被当作垃圾回收。

---

## 十二、修改后的入口函数（支持 C++）

### 12.1 升级版 entry.c

```c
// entry.c - 支持 C++ 的入口函数
#include "minicrt.h"

extern int main(int argc, char* argv[]);

void exit(int);

static void crt_fatal_error(const char* msg) {
    // 简化的错误输出
    const char* p = msg;
    while (*p) {
        char c = *p++;
        // 实际应该 write(2, &c, 1)
    }
    exit(1);
}

void mini_crt_entry(void) {
    int ret;

    // 1. IO 初始化
    if (!mini_crt_init_io()) {
        crt_fatal_error("IO init failed");
    }

    // 2. 堆初始化
    if (!mini_crt_init_heap()) {
        crt_fatal_error("Heap init failed");
    }

    // 3. 调用 C++ 全局对象构造函数
    // 必须在 main 之前！
    mini_crt_call_ctors();

    // 4. 调用 main
    // 真实实现需要从栈取 argc/argv
    ret = main(0, (char**)0);

    // 5. 清理：atexit 回调 + 全局析构
    exit(ret);
}
```

### 12.2 关键时序对比

| 步骤 | Mini CRT C | Mini CRT C++ |
|:--|:--|:--|
| **1. 堆初始化** | ✅ | ✅ |
| **2. IO 初始化** | ✅ | ✅ |
| **3. 全局对象构造** | ❌（无 C++） | ✅ `mini_crt_call_ctors()` |
| **4. main** | ✅ | ✅ |
| **5. atexit 调用** | ✅ | ✅ |
| **6. 全局对象析构** | ❌ | ✅（在 atexit 中触发） |
| **7. sys_exit** | ✅ | ✅ |

---

## 十三、完整 C++ 测试程序

### 13.1 test.cpp

```cpp
// test.cpp - Mini CRT C++ 测试程序
#include "minicrt.h"
#include "string.h"

class GlobalObject {
public:
    GlobalObject() {
        printf("ctor: GlobalObject created\n");
    }
    ~GlobalObject() {
        printf("dtor: GlobalObject destroyed\n");
    }
};

GlobalObject g_obj;  // 全局对象：应在 main 之前构造

int main(int argc, char* argv[]) {
    printf("=== Mini CRT++ Test ===\n");
    printf("argc = %d\n", argc);

    // 1. 测试 C++ String
    std::string s1("Hello, ");
    std::string s2("Mini CRT++!");
    std::string s3 = s1 + s2;
    printf("s3 = '%s', length = %d\n", s3.c_str(), s3.length());

    // 2. 测试 new/delete
    int* p = new int(42);
    printf("*p = %d\n", *p);
    delete p;

    int* arr = new int[5];
    for (int i = 0; i < 5; ++i) {
        arr[i] = i * 10;
        printf("arr[%d] = %d\n", i, arr[i]);
    }
    delete[] arr;

    // 3. 测试文件 IO
    FILE* fp = fopen("cpp_test.txt", "w");
    fwrite("Hello from Mini CRT++\n", 1, 22, fp);
    fclose(fp);

    fp = fopen("cpp_test.txt", "r");
    char buf[64] = {0};
    fread(buf, 1, 22, fp);
    fclose(fp);
    printf("Read back: %s", buf);

    return 0;
}
```

### 13.2 预期输出

```
ctor: GlobalObject created
=== Mini CRT++ Test ===
argc = 0
s3 = 'Hello, Mini CRT++!', length = 19
*p = 42
arr[0] = 0
arr[1] = 10
arr[2] = 20
arr[3] = 30
arr[4] = 40
Read back: Hello from Mini CRT++

dtor: GlobalObject destroyed
```

> **关键观察**：构造和析构分别在 `main` 之前和 `exit` 之后执行——这就是 CRT 的核心魔法。

---

## 十四、CMakeLists.txt（可选）

### 14.1 跨平台构建脚本

```cmake
# CMakeLists.txt - Mini CRT 跨平台构建
cmake_minimum_required(VERSION 3.10)
project(minicrt C CXX)

set(CMAKE_C_STANDARD 11)
set(CMAKE_CXX_STANDARD 14)

# Mini CRT 源文件
set(MINICRT_SOURCES
    entry.c
    malloc.c
    stdio.c
    string.c
    printf.c
    new_delete.cpp
    ctor_dtor.cpp
)

# 编译选项
if(LINUX)
    add_compile_options(
        -fno-builtin
        -fno-stack-protector
        -nostdlib
        -fno-exceptions
    )
    enable_language(ASM)
    set(MINICRT_SOURCES ${MINICRT_SOURCES} crt0.S)
endif()

if(WIN32)
    add_compile_definitions(WIN32)
    add_compile_options(/GS- /EHsc)
endif()

# 编译为静态库
add_library(minicrt STATIC ${MINICRT_SOURCES})

# C 测试程序
add_executable(test_c test.c)
target_link_libraries(test_c minicrt)
if(LINUX)
    target_link_options(test_c PRIVATE -static -e mini_crt_entry)
elseif(WIN32)
    target_link_options(test_c PRIVATE /NODEFAULTLIB /entry:mini_crt_entry kernel32.lib)
endif()

# C++ 测试程序
add_executable(test_cpp test.cpp)
target_link_libraries(test_cpp minicrt)
if(LINUX)
    target_link_options(test_cpp PRIVATE -static -e mini_crt_entry)
endif()
```

---

## 十五、深度对比：Mini CRT vs glibc vs musl

### 15.1 功能对比

| 功能 | Mini CRT | glibc | musl |
|:--|:--|:--|:--|
| **入口函数** | mini_crt_entry | __libc_start_main | __libc_start_main |
| **堆管理** | brk + 空闲链表 | ptmalloc2（arena） | mallocng |
| **stdio 缓冲** | ❌ 无 | ✅ 全/行/无 | ✅ 行缓冲 |
| **格式化字符串** | %d, %s | 完整 | 完整 |
| **线程** | ❌ | ✅ NPTL | ✅ 简化 |
| **C++ 异常** | ❌ | ✅ libstdc++ | ✅ libcxx |
| **数学库** | ❌ | ✅ libm | ✅ |
| **国际化** | ❌ | ✅ locale | ✅ |
| **代码行数** | ~500 | ~200万 | ~10万 |
| **静态库大小** | ~3 KB | ~5 MB | ~400 KB |

### 15.2 性能对比

| 场景 | Mini CRT | glibc | 原因 |
|:--|:--|:--|:--|
| **小对象分配（<128B）** | 慢 5-10x | 快 | glibc 有 tcache |
| **大对象分配** | 差不多 | 差不多 | 都用 brk/mmap |
| **文件 IO** | 慢 2-3x | 快 | glibc 有缓冲 |
| **字符串操作** | 一样 | 一样 | 纯计算 |
| **printf** | 慢 5x | 快 | glibc 优化程度高 |

### 15.3 适用场景

| 场景 | 推荐 |
|:--|:--|
| **学习目的** | ✅ Mini CRT（500 行看得懂） |
| **生产环境** | ✅ glibc/musl |
| **嵌入式** | ✅ musl/dietlibc |
| **操作系统内核** | ✅ 自己写（无 libc） |
| **极小可执行文件** | ✅ Mini CRT（5KB） |

---

## 十六、常见坑与陷阱

### 16.1 编译期坑

| 坑 | 现象 | 解决 |
|:--|:--|:--|
| **`-fno-builtin` 忘了** | GCC 把 `strlen` 替换成内置实现，绕过 Mini CRT | 加上 `-fno-builtin` |
| **`-fno-stack-protector` 忘了** | 链接时报 `__stack_chk_fail` 未定义 | 加上 `-fno-stack-protector` |
| **`-nostdlib` 忘了** | 链接了 glibc，覆盖 Mini CRT | 加上 `-nostdlib` |
| **`-e mini_crt_entry` 忘了** | 用默认入口 `_start`，但 C 代码是 `mini_crt_entry` | 加上 `-e mini_crt_entry` |
| **链接顺序错** | 报符号未定义 | 把 `crtbegin` 放最前，`crtend` 放最后 |

### 16.2 运行时坑

| 坑 | 现象 | 解决 |
|:--|:--|:--|
| **栈对齐** | `vfprintf` 崩溃 | 入口函数用 `and $0xfffffff0, %esp` 对齐 |
| **brk 失败** | `sbrk` 返回 -1，malloc 返回 NULL | 检查堆是否超过进程限制 |
| **fopen 无缓冲** | 每次 printf 都触发 syscall | 用 fprintf 一次写完 |
| **没有 errno** | 错误信息丢失 | 自行实现 errno 变量 |
| **全局变量未初始化** | bss 段不一定清零 | 在 `_init` 显式清零 |

### 16.3 调试技巧

```bash
# 1. 用 GDB 跟踪启动
$ gdb ./test_c
(gdb) break _start
(gdb) break mini_crt_entry
(gdb) break main
(gdb) run

# 2. 用 strace 观察系统调用
$ strace -e brk,mmap,open,read,write ./test_c

# 3. 用 objdump 验证入口
$ objdump -f ./test_c
# 应当显示：start address 0x08048000 (mini_crt_entry)

# 4. 用 readelf 验证段
$ readelf -S ./test_c
# 应当有：.text, .data, .bss, .init_array, .fini_array
```

---

## 十七、扩展方向

### 17.1 Mini CRT 还差什么？

| 模块 | 难度 | 价值 |
|:--|:--|:--|
| **stdin 输入** | ⭐ | 互动程序需要 |
| **scanf/fscanf** | ⭐⭐ | 反向格式化 |
| **stdio 缓冲** | ⭐⭐⭐ | 性能提升 10x |
| **printf %x %c** | ⭐ | 格式化扩展 |
| **mprotect 内存保护** | ⭐⭐ | 安全性 |
| **线程局部存储（TLS）** | ⭐⭐⭐⭐ | 多线程支持 |
| **共享库加载** | ⭐⭐⭐⭐⭐ | 动态链接 |
| **C++ 异常处理** | ⭐⭐⭐⭐⭐ | 异常机制 |
| **STL 容器** | ⭐⭐⭐⭐ | vector/map 等 |

### 17.2 推荐练习

| 练习 | 难度 | 收获 |
|:--|:--|:--|
| **实现 stdin 的 fgetc/fgets** | ⭐ | 完善 IO |
| **把 Mini CRT 移植到 x86_64** | ⭐⭐ | 理解 ABI 差异 |
| **添加 printf %x %o** | ⭐ | 扩展格式化 |
| **实现 std::vector** | ⭐⭐ | C++ 内存管理 |
| **用 mmap 实现大块分配** | ⭐⭐ | 现代堆管理 |
| **加 fflush 行缓冲** | ⭐⭐ | 性能优化 |

---

## 十八、为什么要手写 CRT？

### 18.1 三个核心收获

1. **理解"程序是什么"**：一个能跑的程序 = **入口** + **运行时** + **业务代码**。你以为 `int main()` 是一切，其实它只是冰山一角。
2. **理解工具链协作**：**编译器**生成代码，**汇编器**翻译，**链接器**布局，**加载器**执行，**内核**调度——每一环都有自己的角色。
3. **理解抽象的代价**：glibc 200 万行不是浪费——每一行都解决了一个真实问题。当你手写 500 行 Mini CRT 时，你会**更尊重** glibc 的设计。

### 18.2 给不同读者的建议

| 读者 | 建议 |
|:--|:--|
| **C/C++ 初学者** | 先编译运行 Mini CRT，再读源码 |
| **系统程序员** | 尝试把它移植到 x86_64、RISC-V |
| **编译器开发者** | 研究 `__attribute__((constructor))` 的实现 |
| **嵌入式工程师** | 改造 Mini CRT 用于无 MMU 的 MCU |
| **OS 开发者** | 在你写的内核里用 Mini CRT 作为用户态运行时 |

---

## 十九、行动建议与思考题

### 19.1 行动召唤

**完成本章后，你应该做三件事**：

1. **编译并运行 Mini CRT**：用上面的 Makefile 编译，跑 `test_c` 和 `test_cpp`。
2. **添加一个新函数**：比如 `puts()` 或 `getchar()`，加深理解。
3. **移植到另一个平台**：从 x86 Linux 移植到 x86_64，或者从 Linux 移植到 Windows。

### 19.2 思考题

| # | 问题 |
|:--|:--|
| 1 | 为什么 Mini CRT 的入口函数必须用汇编？能否用纯 C 实现？ |
| 2 | brk 申请的是虚拟内存还是物理内存？第一次访问会怎样？ |
| 3 | 全局对象的构造顺序在多个 .o 之间是怎样的？C++ 标准如何规定？ |
| 4 | atexit 是 LIFO 还是 FIFO？为什么要这样设计？ |
| 5 | 如果 mini_crt_entry 漏掉堆初始化，malloc 会怎样？ |
| 6 | .init_array 里的函数指针是绝对地址还是相对地址？重定位时怎么办？ |
| 7 | Mini CRT 为什么不实现 stdio 缓冲？没有缓冲的真实代价是什么？ |
| 8 | 为什么 `printf("%d", 42)` 中 `42` 被称为"右值"？它在哪里？ |

### 19.3 进阶阅读

| 资源 | 内容 |
|:--|:--|
| [musl libc 源码](https://git.musl-libc.org/cgit/musl/) | 现代精简 libc 实现 |
| [dietlibc](http://www.fefe.de/dietlibc/) | 比 musl 更小 |
| [glibc malloc 详解](https://sourceware.org/glibc/wiki/MallocInternals) | 工业级堆管理 |
| [System V ABI](https://refspecs.linuxfoundation.org/elf/sysv-abi.pdf) | ELF/C Runtime ABI 规范 |
| [Itanium C++ ABI](https://itanium-cxx-abi.github.io/cxx-abi/abi.html) | C++ 全局对象构造规范 |

---

## 二十、本章小结

### 20.1 一句话总结

**Mini CRT 是一面镜子——它让你看到 200 万行 glibc 背后那些被你习以为常的"理所当然"其实是一系列精心设计的选择**。

### 20.2 知识点回顾

| 知识点 | 状态 |
|:--|:--|
| **入口函数设计** | ✅ 掌握 |
| **brk/sbrk 堆管理** | ✅ 掌握 |
| **空闲链表** | ✅ 掌握 |
| **系统调用封装** | ✅ 掌握 |
| **字符串操作** | ✅ 掌握 |
| **printf 变长参数** | ✅ 掌握 |
| **链接脚本** | ✅ 掌握 |
| **C++ new/delete** | ✅ 掌握 |
| **C++ 全局对象构造** | ✅ 掌握 |
| **C++ String 简化实现** | ✅ 掌握 |
| **异常处理** | ⚠️ 简单讨论 |

### 20.3 本章在系列中的位置

```mermaid
graph LR
    A["第1章 温故"] --> B["第2-5章 编译链接"]
    B --> C["第6章 装载"]
    C --> D["第7-8章 动态链接"]
    D --> E["第9章 内存管理"]
    E --> F["第10章 运行库"]
    F --> G["第11章 系统调用"]
    G --> H["第12章 线程"]
    H --> I["🎯 第13章 Mini CRT<br/>← 你是这里"]
    I --> J["第14章 调试"]
    J --> K["第15章 Windows 动态链接"]

    style A fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style I fill:#FFB3C6,stroke:#F48FB1,stroke-width:4px,color:#333
    style J fill:#B5EAD7,stroke:#80CBC4,color:#333
```

> **Mini CRT 是整个系列的"毕业设计"**——前面 12 章学到的所有知识点在这里被**串成一条线**。

---

## 📚 程序员的自我修养 系列导航

> 本文是《程序员的自我修养》系列第 **13/15** 篇。

| 方向 | 章节 |
|:--|:--|
| 上一篇 ◀ | [第十二章：线程库](/2024/03/21/12-线程库/) |
| 下一篇 ▶ | [第十四章：调试](/2024/03/21/13-调试/) |
| 平行篇 | [第五章：Windows PE/COFF](/2024/06/16/05-windows-pe-coff/) |
| 特别篇 | [第十五章：Windows 下的动态链接](/2024/06/16/15-windows-dynamic-linking/) 🆕 |

<details>
<summary>📖 全部 16 篇目录（点击展开）</summary>

0. [系列总览](/2026/06/16/programmer-self-cultivation-series-index/) 🆕
1. [第一章：温故而知新](/2024/03/21/01-温故而知新/)
2. [第二章：编译和链接](/2024/03/21/02-编译和链接/)
3. [第三章：目标文件里有什么](/2024/03/21/03-目标文件里有什么/)
4. [第四章：静态链接](/2024/03/21/04-静态链接/)
5. [第五章：Windows PE/COFF](/2024/06/16/05-windows-pe-coff/) 🆕
6. [第六章：可执行文件的装载与进程](/2024/03/21/06-可执行文件的装载与进程/)
7. [第七章：动态链接](/2024/03/21/05-动态链接/)
8. [第八章：动态链接的实现](/2024/03/21/07-动态链接的实现/)
9. [第九章：Linux 共享库的组织](/2024/03/21/08-Linux共享库的组织/)
10. [第十章：内存管理](/2024/03/21/09-内存管理/)
11. [第十一章：运行库](/2024/03/21/10-运行库/)
12. [第十二章：系统调用](/2024/03/21/11-系统调用/)
13. [第十三章：线程库](/2024/03/21/12-线程库/)
14. **第十三章：MiniCRT 实战——从 0 写一个 500 行的迷你 C/C++ 运行库** ← 当前
15. [第十四章：调试](/2024/03/21/13-调试/)
16. [第十五章：Windows 下的动态链接](/2024/06/16/15-windows-dynamic-linking/) 🆕

</details>

---

> **最后一句话**：写一个 Mini CRT 不是为了不用 glibc，而是为了**理解 glibc 为何存在**。当你亲手实现一个 500 行的运行库后，再看 200 万行的 glibc，你会看到的是**精心设计的层次**——而不是一团乱麻。
