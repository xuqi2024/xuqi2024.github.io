---
title: 第八章：Linux共享库的组织
date: 2024-03-21
categories: 
  - 读书笔记
  - 计算机基础
tags:
  - 链接
  - 装载
  - 库
  - 计算机系统
---

# 第八章：Linux共享库的组织

## 8.1 共享库的版本

### 共享库版本号

共享库版本号的组成：
1. 主版本号
2. 次版本号
3. 发布号

示例代码：
```c:source/_posts/程序员自我修养/code/libversion.c
#include <stdio.h>

// 版本 1.0.0
void func_v1() {
    printf("Function version 1.0.0\n");
}

// 版本 1.1.0
void func_v2() {
    printf("Function version 1.1.0\n");
}

// 版本 1.1.1
void func_v3() {
    printf("Function version 1.1.1\n");
}
```

编译命令：
```bash
# 编译不同版本
gcc -shared -fPIC -Wl,-soname,libtest.so.1 libversion.c -o libtest.so.1.0.0
gcc -shared -fPIC -Wl,-soname,libtest.so.1 libversion.c -o libtest.so.1.1.0
gcc -shared -fPIC -Wl,-soname,libtest.so.1 libversion.c -o libtest.so.1.1.1

# 创建符号链接
ln -sf libtest.so.1.0.0 libtest.so.1
ln -sf libtest.so.1 libtest.so
```

### 符号版本化

符号版本化的实现：
1. 定义版本脚本
2. 标记符号版本
3. 链接时指定版本

示例代码：
```c:source/_posts/程序员自我修养/code/version_script.c
#include <stdio.h>

void func_v1() {
    printf("Function version 1\n");
}

void func_v2() {
    printf("Function version 2\n");
}
```

版本脚本：
```text:source/_posts/程序员自我修养/code/version.script
VERSION_1.0 {
    global: func_v1;
    local: *;
};

VERSION_1.1 {
    global: func_v2;
} VERSION_1.0;
```

编译命令：
```bash
# 编译带版本信息的共享库
gcc -shared -fPIC version_script.c -Wl,--version-script=version.script -o libversion.so
```

## 8.2 共享库的命名

### 命名规则

共享库的命名规则：
1. lib前缀
2. 库名
3. .so后缀
4. 版本号

示例代码：
```c:source/_posts/程序员自我修养/code/libname.c
#include <stdio.h>

void func() {
    printf("Function from libname\n");
}
```

编译命令：
```bash
# 编译共享库
gcc -shared -fPIC libname.c -o libname.so.1.0.0

# 创建符号链接
ln -sf libname.so.1.0.0 libname.so.1
ln -sf libname.so.1 libname.so
```

### 搜索路径

共享库的搜索路径：
1. LD_LIBRARY_PATH
2. /etc/ld.so.conf
3. /lib和/usr/lib

示例代码：
```c:source/_posts/程序员自我修养/code/search_path.c
#include <stdio.h>
#include <dlfcn.h>

int main() {
    // 加载共享库
    void *handle = dlopen("libname.so", RTLD_LAZY);
    if (!handle) {
        fprintf(stderr, "dlopen failed: %s\n", dlerror());
        return 1;
    }
    
    // 获取函数地址
    void (*func)() = dlsym(handle, "func");
    if (func) func();
    
    dlclose(handle);
    return 0;
}
```

编译和运行命令：
```bash
# 编译
gcc search_path.c -ldl -o search_path

# 设置搜索路径
export LD_LIBRARY_PATH=.

# 运行
./search_path
```

## 8.3 共享库的安装

### 安装位置

共享库的安装位置：
1. /usr/lib
2. /usr/local/lib
3. 自定义目录

示例代码：
```c:source/_posts/程序员自我修养/code/install_lib.c
#include <stdio.h>

void func() {
    printf("Function from installed library\n");
}
```

安装命令：
```bash
# 编译共享库
gcc -shared -fPIC install_lib.c -o libinstall.so.1.0.0

# 安装到系统目录
sudo cp libinstall.so.1.0.0 /usr/local/lib/
sudo ln -sf /usr/local/lib/libinstall.so.1.0.0 /usr/local/lib/libinstall.so.1
sudo ln -sf /usr/local/lib/libinstall.so.1 /usr/local/lib/libinstall.so

# 更新共享库缓存
sudo ldconfig
```

### 安装脚本

安装脚本的编写：
1. 复制文件
2. 创建符号链接
3. 更新缓存

示例脚本：
```bash:source/_posts/程序员自我修养/code/install.sh
#!/bin/bash

# 安装目录
INSTALL_DIR="/usr/local/lib"
LIB_NAME="libinstall"
VERSION="1.0.0"

# 复制共享库
cp ${LIB_NAME}.so.${VERSION} ${INSTALL_DIR}/

# 创建符号链接
ln -sf ${INSTALL_DIR}/${LIB_NAME}.so.${VERSION} ${INSTALL_DIR}/${LIB_NAME}.so.1
ln -sf ${INSTALL_DIR}/${LIB_NAME}.so.1 ${INSTALL_DIR}/${LIB_NAME}.so

# 更新共享库缓存
ldconfig
```

## 实践练习

1. 版本管理实验
```bash
# 创建不同版本的共享库
cat > libversion.c << EOL
#include <stdio.h>

void func_v1() { printf("Version 1\n"); }
void func_v2() { printf("Version 2\n"); }
EOL

# 编译不同版本
gcc -shared -fPIC -Wl,-soname,libversion.so.1 libversion.c -o libversion.so.1.0.0
gcc -shared -fPIC -Wl,-soname,libversion.so.1 libversion.c -o libversion.so.1.1.0

# 创建符号链接
ln -sf libversion.so.1.0.0 libversion.so.1
ln -sf libversion.so.1 libversion.so
```

2. 命名规则实验
```bash
# 创建共享库
cat > libtest.c << EOL
#include <stdio.h>

void test_func() {
    printf("Test function\n");
}
EOL

# 编译共享库
gcc -shared -fPIC libtest.c -o libtest.so.1.0.0

# 创建符号链接
ln -sf libtest.so.1.0.0 libtest.so.1
ln -sf libtest.so.1 libtest.so
```

3. 安装实验
```bash
# 创建安装脚本
cat > install.sh << EOL
#!/bin/bash

# 安装目录
INSTALL_DIR="/usr/local/lib"
LIB_NAME="libtest"
VERSION="1.0.0"

# 复制共享库
cp ${LIB_NAME}.so.${VERSION} ${INSTALL_DIR}/

# 创建符号链接
ln -sf ${INSTALL_DIR}/${LIB_NAME}.so.${VERSION} ${INSTALL_DIR}/${LIB_NAME}.so.1
ln -sf ${INSTALL_DIR}/${LIB_NAME}.so.1 ${INSTALL_DIR}/${LIB_NAME}.so

# 更新共享库缓存
ldconfig
EOL

# 执行安装
chmod +x install.sh
sudo ./install.sh
```

## 思考题

1. 共享库版本号的作用是什么？
2. 什么是符号版本化？它有什么作用？
3. 共享库的命名规则是什么？
4. 如何设置共享库的搜索路径？
5. 如何正确安装共享库？

## 参考资料

1. 《程序员的自我修养：链接、装载与库》
2. [动态链接器文档](https://man7.org/linux/man-pages/man8/ld.so.8.html)
3. [ELF 文件格式规范](https://refspecs.linuxfoundation.org/elf/elf.pdf)
4. [GNU Binutils 文档](https://www.gnu.org/software/binutils/)
5. [System V ABI](https://www.uclibc.org/docs/psABI-x86_64.pdf) 