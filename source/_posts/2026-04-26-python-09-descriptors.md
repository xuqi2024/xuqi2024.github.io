---
title: 【Python AI教程】（九）描述符协议：属性的高级玩法
date: 2026-04-23 10:00:00
categories:
- 技术分析
tags:
- Python
description: "很多人写了几年 Python，却不知道 property 底层是怎么实现的。答案就三个字：描述符协议。"
---

> 很多人写了几年 Python，却不知道 `property` 底层是怎么实现的。答案就三个字：**描述符协议**。

## 一、为什么需要描述符？

想象你写了一个 AI Agent 配置类：

```python
class AgentConfig:
    def __init__(self, temperature):
        self._temperature = temperature
```

然后发现 temperature 必须是 0-2.0 之间的浮点数，否则就报错。你会怎么做？

方案一：在 `__set__` 里加验证逻辑，但每次都要手动调用。

方案二：用 `@property`，但它只能针对单个类。

**方案三：用描述符**——一次定义，处处复用，自动生效。

## 二、描述符协议：三钩子掌控属性

```mermaid
graph LR
    A["读取属性<br/>obj.attr"] --> B["__get__"]
    C["赋值属性<br/>obj.attr = x"] --> D["__set__"]
    E["删除属性<br/>del obj.attr"] --> F["__delete__"]

    style A fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style C fill:#FFDAB9,stroke:#FFAB76,color:#333
    style E fill:#FFB3C6,stroke:#F48FB1,color:#333
```

Python 的描述符协议只有三个方法：

| 方法 | 调用时机 | 典型用途 |
|------|---------|---------|
| `__get__(self, instance, owner)` | 读取属性时 | 惰性计算、转换 |
| `__set__(self, instance, value)` | 赋值属性时 | 验证、记录日志 |
| `__delete__(self, instance)` | 删除属性时 | 清理关联资源 |

```python
# === 描述符协议 ===
class Temperature:
    """温度描述符: 自动在摄氏/华氏间转换"""
    
    def __set__(self, instance, value):
        if not isinstance(value, (int, float)):
            raise TypeError(f"Temperature must be numeric, got {type(value).__name__}")
        instance.__dict__["_celsius"] = value
    
    def __get__(self, instance, owner):
        if instance is None:
            return self  # 类访问时返回描述符本身
        return instance.__dict__.get("_celsius", 0)

class Room:
    temperature = Temperature()  # 描述符实例作为类属性
    
    def __init__(self, temp: float):
        self.temperature = temp

room = Room(25)
print(room.temperature)  # 25
room.temperature = 30
print(room.temperature)  # 30
# room.temperature = "hot"  # TypeError!
```

运行输出：
```text
25
30
```

## 三、Data Descriptor vs Non-Data Descriptor：优先级之战

描述符分两种，区别在于属性查找的优先级：

```mermaid
flowchart TD
    START["属性访问"] --> Q1{"有 Data Descriptor?"}
    Q1 -->|"是"| RESULT1["调用 Data Descriptor 的 __get__"]
    Q1 -->|"否"| Q2{"实例字典有该属性?"}
    Q2 -->|"是"| RESULT2["返回实例字典的值"]
    Q2 -->|"否"| Q3{"有 Non-Data Descriptor?"}
    Q3 -->|"是"| RESULT3["调用 Non-Data Descriptor 的 __get__"]
    Q3 -->|"否"| RESULT4["抛出 AttributeError"]

    style Q1 fill:#FFF9C4,stroke:#F9A825,color:#333
    style Q2 fill:#FFF9C4,stroke:#F9A825,color:#333
    style Q3 fill:#FFF9C4,stroke:#F9A825,color:#333
```

| 描述符类型 | 定义方法 | 优先级 |
|-----------|---------|--------|
| **Data Descriptor** | 同时定义 `__get__` + `__set__` | 最高（甚至高于实例字典） |
| **Non-Data Descriptor** | 只定义 `__get__` | 最低（低于实例字典） |

这意味着：如果同时定义了 `__set__`，即使你在 `__init__` 里给实例属性赋值，也会优先调用描述符。

## 四、property 底层就是描述符

`@property` 装饰器背后就是一个 **Non-Data Descriptor**：

```python
# === property 底层 ===
# property 就是一个 non-data descriptor

class Property:
    """模拟内置 property 的实现"""
    def __init__(self, fget=None, fset=None, fdel=None, doc=None):
        self.fget = fget
        self.fset = fset
        self.fdel = fdel
        self.__doc__ = doc or (fget.__doc__ if fget else None)
    
    def __get__(self, obj, objtype=None):
        if obj is None:
            return self  # 类访问返回描述符
        return self.fget(obj)
    
    def __set__(self, obj, value):
        if self.fset is None:
            raise AttributeError("can't set attribute")
        self.fset(obj, value)
    
    def __call__(self, func):
        """装饰器用法：@property"""
        return Property(func, self.fset)

# 使用示例
class Person:
    @property
    def name(self):
        return self._name
    
    @name.setter
    def name(self, value):
        self._name = value
```

为什么 `property` 用 Non-Data Descriptor 而不是 Data Descriptor？因为它只需要拦截读操作，写操作通过单独的 setter 处理。

## 五、惰性计算描述符

描述符最经典的应用场景：**惰性计算**。直到第一次访问才计算，之后缓存结果。

```python
# === 惰性计算描述符 ===
class Lazy:
    """惰性计算描述符: 第一次访问时才计算"""
    def __init__(self, func):
        self.func = func
        self.attr_name = None  # 稍后通过 __set_name__ 获取
    
    def __set_name__(self, owner, name):
        """自动获取属性名（Python 3.6+）"""
        self.attr_name = name
    
    def __get__(self, instance, owner):
        if instance is None:
            return self  # 类访问返回描述符
        # 缓存未命中：执行计算并存储
        if self.attr_name not in instance.__dict__:
            value = self.func(instance)
            instance.__dict__[self.attr_name] = value
        return instance.__dict__[self.attr_name]  # 缓存命中：直接返回

class Agent:
    def __init__(self, name: str):
        self.name = name
    
    @Lazy
    def summary(self) -> str:
        """只在下一次访问时计算"""
        print(f"[Computing summary for {self.name}...]")
        return f"Agent {self.name} summary"

agent = Agent("Alice")
print("Agent created")  # 不触发计算
print(agent.summary)    # 触发计算
print(agent.summary)    # 缓存命中，不再计算
```

运行输出：
```text
Agent created
[Computing summary for Alice...]
Agent Alice summary
Agent Alice summary
```

这在 AI 场景里非常有用——比如 Agent 的"思考链"可能很耗时，我们希望它只在真正需要时才计算。

## 六、AI应用：Agent 配置验证描述符

在 Agent 开发中，我们经常需要对参数进行严格的类型和范围验证：

```python
# === AI应用: Agent配置验证 ===
class Validated:
    """验证描述符: 类型和范围检查"""
    def __init__(self, expected_type, min_val=None, max_val=None):
        self.expected_type = expected_type
        self.min_val = min_val
        self.max_val = max_val
    
    def __set__(self, instance, value):
        # 类型检查
        if not isinstance(value, self.expected_type):
            raise TypeError(f"Expected {self.expected_type.__name__}, got {type(value).__name__}")
        # 范围检查
        if self.min_val is not None and value < self.min_val:
            raise ValueError(f"Value {value} below minimum {self.min_val}")
        if self.max_val is not None and value > self.max_val:
            raise ValueError(f"Value {value} above maximum {self.max_val}")
        instance.__dict__[self.name] = value
    
    def __set_name__(self, owner, name):
        self.name = name
    
    def __get__(self, instance, owner):
        return instance.__dict__.get(self.name)

class AgentConfig:
    temperature = Validated(float, min_val=0.0, max_val=2.0)
    max_tokens = Validated(int, min_val=1, max_val=128000)
    
    def __init__(self, temperature: float, max_tokens: int):
        self.temperature = temperature
        self.max_tokens = max_tokens

config = AgentConfig(temperature=0.7, max_tokens=2048)
print(f"temp={config.temperature}, tokens={config.max_tokens}")
# config.temperature = 3.0  # ValueError: Value 3.0 above maximum 2.0
```

运行输出：
```text
temp=0.7, tokens=2048
```

尝试 `config.temperature = 3.0` 会抛出明确错误，而不是让程序在调用 API 时才发现参数无效。

## 七、日志描述符：追踪每一次访问

```python
class Logged:
    """日志描述符: 记录所有访问和修改"""
    def __set_name__(self, owner, name):
        self.name = name
        self.log = []  # 每个实例独立的日志
    
    def __get__(self, instance, owner):
        if instance is None:
            return self
        instance.log.append(f"READ: {self.name}")
        return instance.__dict__.get(self.name)
    
    def __set__(self, instance, value):
        instance.log.append(f"WRITE: {self.name} = {value}")
        instance.__dict__[self.name] = value
```

## 八、总结

| 描述符类型 | 定义 | 查找优先级 | 典型用途 |
|-----------|------|-----------|---------|
| Data Descriptor | `__get__` + `__set__` | 最高 | 验证、自动转换 |
| Non-Data Descriptor | 仅 `__get__` | 最低 | 惰性计算、property |

**描述符是 Python 属性机制的核心**。掌握它，你就能在类之间复用属性逻辑，实现自动验证、惰性计算、日志追踪等高级功能。这些技巧在构建 AI Agent 框架时会非常有用。

> 下一步：尝试结合元类（下一篇）和描述符，实现一个完整的 ORM 字段系统。
---
## 📚 Python AI教程 系列导航

> 本文是《Python AI教程》系列第 **9/14** 篇。

| 方向 | 章节 |
|:--|:--|
| ◀ 上一篇 | [（八）函数式编程](/2026/04/23/2026-04-26-python-08-functional-programming/) |
| 下一篇 ▶ | [（十）元类](/2026/04/23/2026-04-26-python-10-metaclasses/) |

<details>
<summary>📖 全部 14 篇目录（点击展开）</summary>

1. [（一）闭包与装饰器](/2026/04/23/2026-04-25-python-01-closures-decorators/)
2. [（二）上下文管理器](/2026/04/23/2026-04-25-python-02-context-managers/)
3. [（三）生成器与迭代器](/2026/04/23/2026-04-25-python-03-generators-iterators/)
4. [（四）类型提示](/2026/04/23/2026-04-25-python-04-type-hints/)
5. [（五）Dataclass 与 attrs](/2026/04/23/2026-04-25-python-05-dataclass-attrs/)
6. [（六）async/await](/2026/04/23/2026-04-26-python-06-async-await/)
7. [（七）Threading 与 Multiprocessing](/2026/04/23/2026-04-26-python-07-threading-multiprocessing/)
8. [（八）函数式编程](/2026/04/23/2026-04-26-python-08-functional-programming/)
9. [（九）描述符协议](/2026/04/23/2026-04-26-python-09-descriptors/) **← 当前**
10. [（十）元类](/2026/04/23/2026-04-26-python-10-metaclasses/)
11. [（十一）Protocol与结构化类型](/2026/04/23/2026-04-26-python-11-protocol-typing/)
12. [（十二）异常链与日志](/2026/04/23/2026-04-27-python-12-exceptions-logging/)
13. [（十三）缓存艺术](/2026/04/23/2026-04-27-python-13-caching/)
14. [（十四）组合模式实战](/2026/04/23/2026-04-27-python-14-composite-ai-agent/)

</details>

## 对比分析

本章核心是 Python 的描述符协议（`__get__/__set__/__delete__`）。

### 维度一：描述符 vs 其他"属性控制"手段

| 方案 | 触发时机 | 可复用性 | 适合场景 |
|------|----------|----------|----------|
| **描述符协议** | `obj.attr` 时自动触发 | ✅ 类级别复用 | 跨实例共享属性逻辑 |
| **@property** | `obj.attr` 时自动触发 | ❌ 单类内 | 单类内简单计算属性 |
| **`__getattr__` / `__getattribute__`** | 属性查找失败 / 每次 | 类内 | 代理、动态属性 |
| **`__setattr__`** | 每次赋值 | 类内 | 全局拦截 |
| **普通方法** | 显式调用 | ✅ | 行为，不适合做属性包装 |
| **外部包装函数** | 显式 `wrap(x)` | 临时 | 一次性变换 |

### 维度二：与其他语言的属性 / 拦截机制

| 语言 | 属性机制 | 与 Python 描述符对比 |
|------|----------|------------------------|
| **Java** | getter/setter 约定 + Lombok | 约定驱动，需要 IDE 配合；没有语言级"协议" |
| **C#** | Property（`get { } set { }`） | 语言级一等公民；底层是字段 + 访问器；比 Python 描述符更"声明式" |
| **Kotlin** | `val` / `var` + 自定义 getter/setter | 编译期生成，比 C# 更简洁；与 `@property` 思路类似 |
| **C++** | 成员函数 + 运算符重载 | 没有"统一拦截点"；模板 + CRTP 可模拟但繁琐 |
| **Go** | Struct 字段 + 方法 | 没有属性拦截；要"计算属性"得写方法 |
| **Rust** | 字段 + impl + Getter/Setter 方法 | 零成本；Trait 提供扩展点但不像描述符那样"挂到类上" |
| **JavaScript** | `Object.defineProperty` 的 getter/setter | 思路最像；区别在 JS 是对象级，Python 描述符是类级 |

### 维度三：Data Descriptor vs Non-Data Descriptor

| 类型 | 定义 | 优先级 | 例子 |
|------|------|--------|------|
| **Data Descriptor** | 同时定义 `__set__` 或 `__delete__` | 覆盖实例 `__dict__` | `property`、`__set_name__` 描述符 |
| **Non-Data Descriptor** | 只定义 `__get__` | 被实例 `__dict__` 覆盖 | 函数（`method`）、`classmethod` 的旧实现 |

### 优缺点小结

- **Python 描述符**：协议完整、组合性强（`property` / `classmethod` / `staticmethod` 都基于它）；缺点是学习曲线陡、易与 MRO 冲突
- **C# Property**：语言级、IDE 支持最好；缺点是只能针对单类
- **Kotlin val/var**：语法最简洁；缺点是 JVM 平台限制
- **JS Object.defineProperty**：对象级灵活；缺点是没有类级复用

### 何时选

- 选 **@property**：单类内简单计算属性（如 `obj.full_name`）
- 选 **描述符**：跨实例复用同一逻辑（如 ORM 字段、统一类型转换）
- 选 **`__getattr__`**：代理类（包装另一个对象）
- 选 **`__set_name__`**（PEP 487）：描述符需要知道宿主类名字
- 选 **functools.cached_property**：惰性缓存 + 自动失效
- 不推荐 **重写 `__getattribute__`**：性能损耗大、副作用难调试
