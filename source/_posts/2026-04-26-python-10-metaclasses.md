---
title: 【Python AI教程】（十）元类：控制类的创建
date: 2026-04-23 14:00:00
categories:
- 技术分析
tags:
- Python
description: "类也是对象。元类是制造类的类。理解这句话，就理解了元类的一半。"
---

> 类也是对象。元类是制造类的类。理解这句话，就理解了元类的一半。

## 一、从 type() 说起

通常我们这样定义类：

```python
class MyClass:
    x = 42
```

但鲜为人知的是，`class` 关键字背后调用的其实是 `type()`：

```python
# === type() 创建类 ===
MyClass = type("MyClass", (object,), {
    "x": 42,
    "greet": lambda self: f"Hello, I'm {self.x}"
})
obj = MyClass()
print(obj.greet())  # Hello, I'm 42
```

`type(name, bases, dict)` 的三个参数：

| 参数 | 含义 | 示例 |
|------|------|------|
| `name` | 类名 | `"MyClass"` |
| `bases` | 父类元组 | `(object,)` |
| `dict` | 类属性字典 | `{"x": 42}` |

所以 `class MyClass:` 等价于 `MyClass = type("MyClass", (object,), {...})`。

## 二、元类：制造类的类

当 Python 执行 `class MyClass(metaclass=Meta)` 时：

```mermaid
flowchart TD
    A["class MyClass<br/>(metaclass=Meta)"] --> B["Meta.__new__()"]
    B --> C["创建类对象"]
    C --> D["Meta.__init__()"]
    D --> E["返回类对象"]

    style A fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style B fill:#FFF9C4,stroke:#F9A825,color:#333
    style C fill:#E8D5F5,stroke:#CE93D8,color:#333
    style E fill:#B5EAD7,stroke:#80CBC4,color:#333
```

```python
# === 基本元类 ===
class Meta(type):
    def __new__(mcs, name, bases, namespace, **kwargs):
        print(f"Creating class: {name}")
        cls = super().__new__(mcs, name, bases, namespace)
        return cls

class MyClass(metaclass=Meta):
    x = 10

# 输出: Creating class: MyClass
```

元类的第一个参数习惯上叫 `mcs`（metaclass），而不是 `cls`，以区分它创建的是类而不是实例。

## 三、`__new__` vs `__init__`：该用哪个？

| 方法 | 时机 | 能不能修改类结构 | 典型用途 |
|------|------|----------------|---------|
| `__new__` | 类对象创建**前** | 可以新增/删除属性 | 注册表、ORM 字段收集 |
| `__init__` | 类对象创建**后** | 只修改类属性 | 添加类方法、验证 |

**99% 的场景用 `__new__`**。因为你需要在类创建时做出干预：

```python
class Meta(type):
    def __new__(mcs, name, bases, namespace, **kwargs):
        # 在此刻可以：
        # 1. 修改 namespace（增删属性）
        # 2. 检查关键字参数（如 agent_type）
        # 3. 将类注册到全局注册表
        cls = super().__new__(mcs, name, bases, namespace)
        return cls
```

## 四、AI应用：Agent 注册表

在构建 Agent 系统时，我们希望根据类型动态获取 Agent 实现：

```python
# === AI应用: Agent 注册表 ===
class AgentRegistry(type):
    """元类: 自动注册所有 Agent 子类"""
    _registry = {}
    
    def __new__(mcs, name, bases, namespace, agent_type=None, **kwargs):
        cls = super().__new__(mcs, name, bases, namespace)
        if agent_type:  # 只有指定了 agent_type 才注册
            mcs._registry[agent_type] = cls
            print(f"Registered Agent: {agent_type} -> {name}")
        return cls
    
    @classmethod
    def get_agent(mcs, agent_type: str):
        """根据类型获取 Agent 类"""
        return mcs._registry.get(agent_type)
    
    @classmethod
    def list_agents(mcs):
        """列出所有可用的 Agent 类型"""
        return list(mcs._registry.keys())

class BaseAgent(metaclass=AgentRegistry):
    """所有 Agent 的基类"""
    pass

class ReasoningAgent(BaseAgent, agent_type="reasoning"):
    """推理型 Agent"""
    def think(self, prompt: str) -> str:
        return f"[Reasoning] {prompt}"

class CreativeAgent(BaseAgent, agent_type="creative"):
    """创造型 Agent"""
    def generate(self, prompt: str) -> str:
        return f"[Creative] {prompt}"

print(f"Available agents: {AgentRegistry.list_agents()}")
reasoning = AgentRegistry.get_agent("reasoning")()
print(reasoning.think("Solve this problem"))
```

运行输出：
```text
Registered Agent: reasoning -> ReasoningAgent
Registered Agent: creative -> CreativeAgent
Available agents: ['reasoning', 'creative']
[Reasoning] Solve this problem
```

**工作原理**：当 Python 执行 `class ReasoningAgent(..., agent_type="reasoning")` 时：
1. 检测到 `agent_type` 关键字参数
2. 调用 `AgentRegistry.__new__`
3. 将类存入 `_registry`
4. 返回新类

这样我们就能在运行时通过字符串动态获取 Agent 类。

## 五、工具自动发现元类

同样的思路用于自动发现和注册工具插件：

```python
# === 工具自动发现元类 ===
class ToolRegistry(type):
    _tools = {}
    
    def __new__(mcs, name, bases, namespace, tool_name=None, **kwargs):
        cls = super().__new__(mcs, name, bases, namespace)
        if tool_name:
            cls.tool_name = tool_name
            mcs._tools[tool_name] = cls
        return cls

class BaseTool(metaclass=ToolRegistry):
    """工具基类"""
    pass

class CalculatorTool(BaseTool, tool_name="calculator"):
    def execute(self, expr: str) -> str:
        return str(eval(expr))

class SearchTool(BaseTool, tool_name="search"):
    def execute(self, query: str) -> str:
        return f"Search results for: {query}"

print(f"Tools: {list(ToolRegistry._tools.keys())}")
calc = ToolRegistry._tools["calculator"]()
print(calc.execute("2+2"))
```

运行输出：
```yaml
Tools: ['calculator', 'search']
4
```

## 六、ORM 字段注册：经典案例

元类在 ORM 框架中的应用非常典型：

```mermaid
flowchart TB
    A["class User<br/>(Model)"] --> B["ORMMeta.__new__()"]
    B --> C["遍历类属性"]
    C --> D{"是 Field?"}
    D -->|"是"| E["收集到 _fields"]
    D -->|"否"| F["跳过"]
    E --> G["返回类"]
    F --> G

    style A fill:#C7CEEA,stroke:#9FA8DA,color:#333
    style B fill:#FFF9C4,stroke:#F9A825,color:#333
    style E fill:#B5EAD7,stroke:#80CBC4,color:#333
```

```python
class Field:
    """字段描述符基类"""
    def __init__(self, column_type):
        self.column_type = column_type
        self.name = None
    
    def __set_name__(self, owner, name):
        self.name = name

class ORMMeta(type):
    """ORM 元类: 自动收集字段并创建表结构"""
    def __new__(mcs, name, bases, namespace, **kwargs):
        cls = super().__new__(mcs, name, bases, namespace)
        # 收集所有 Field 属性
        cls._fields = {}
        for attr_name in dir(cls):
            attr = getattr(cls, attr_name)
            if isinstance(attr, Field):
                cls._fields[attr_name] = attr
        return cls

class Model(metaclass=ORMMeta):
    pass

class User(Model):
    name = Field("VARCHAR(100)")
    age = Field("INT")
    
    def __init__(self, name, age):
        self.name = name
        self.age = age

print(f"User fields: {list(User._fields.keys())}")  # ['name', 'age']
```

## 七、总结

| 场景 | 元类的作用 |
|------|-----------|
| Agent 注册表 | 自动注册所有 Agent 子类，运行时动态获取 |
| 工具发现 | 自动收集所有工具插件 |
| ORM | 自动收集字段，生成表结构 |
| 插件系统 | 动态加载和管理插件 |

**元类的核心逻辑**：`class X(metaclass=M)` → `M.__new__(M, "X", bases, ns, **kwargs)` → 返回类

> 描述符让我们控制属性访问，元类让我们控制类创建。两者结合，几乎可以实现任何自定义行为。下一篇文章我们来看 Protocol——Python 的结构化类型系统。
---
## 📚 Python AI教程 系列导航

> 本文是《Python AI教程》系列第 **10/14** 篇。

| 方向 | 章节 |
|:--|:--|
| ◀ 上一篇 | [（九）描述符协议](/2026/04/23/2026-04-26-python-09-descriptors/) |
| 下一篇 ▶ | [（十一）Protocol与结构化类型](/2026/04/23/2026-04-26-python-11-protocol-typing/) |

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
9. [（九）描述符协议](/2026/04/23/2026-04-26-python-09-descriptors/)
10. [（十）元类](/2026/04/23/2026-04-26-python-10-metaclasses/) **← 当前**
11. [（十一）Protocol与结构化类型](/2026/04/23/2026-04-26-python-11-protocol-typing/)
12. [（十二）异常链与日志](/2026/04/23/2026-04-27-python-12-exceptions-logging/)
13. [（十三）缓存艺术](/2026/04/23/2026-04-27-python-13-caching/)
14. [（十四）组合模式实战](/2026/04/23/2026-04-27-python-14-composite-ai-agent/)

</details>

## 对比分析

本章核心是 Python 的元类（`metaclass` / `__new__` / `__init__`）。

### 维度一：元类 vs 其他"控制类创建"手段

| 方案 | 触发时机 | 侵入性 | 适合 |
|------|----------|--------|------|
| **元类** | `class` 语句执行时 | 高 | 框架级：自动注册、ORM 字段、接口检查 |
| **类装饰器** | `class` 语句执行后 | 中 | 给单类附加功能 |
| **`__init_subclass__`**（PEP 487） | 子类创建时 | 低 | 父类想控制子类 |
| **`__set_name__`** | 描述符绑定到类时 | 低 | 描述符反向引用宿主 |
| **abc.ABCMeta（元类的典型应用）** | 同元类 | 高 | 抽象基类 |
| **手动 `type(name, bases, ns)`** | 显式调用 | 高 | 动态创建类 |

### 维度二：与其他语言的"元编程"机制

| 语言 | 元编程机制 | 与 Python 元类对比 |
|------|------------|----------------------|
| **Java** | 注解 + 反射 + 字节码库（cglib / ASM） | 注解本身无行为，需运行时织入；Python 元类"创建类时"自动生效 |
| **C++** | 模板元编程（TMP） + CRTP | 编译期元编程，零运行时；学习曲线极陡 |
| **Go** | 反射（reflect） | 没有元类；通过 `reflect.Type` 在运行时检查类型 |
| **Rust** | 宏（macro_rules! / proc-macro） + Trait | 编译期宏扩展，类型安全；比 Python 元类更"声明式" |
| **Ruby** | `class_eval` / `define_method` / `method_missing` | 元编程更灵活（"打开类"）；Ruby 社区比 Python 更常用 |
| **JavaScript** | `Proxy` + `Reflect` | Proxy 拦截一切操作；思路最接近 Python 元类但更"运行时" |
| **Lisp/Clojure** | 宏（macro） | 编译期宏，代码即数据；元编程之王 |

### 维度三：元类 vs 类装饰器 vs `__init_subclass__`

| 维度 | 元类 | 类装饰器 | `__init_subclass__` |
|------|------|----------|----------------------|
| 触发点 | 类创建时 | 类创建后 | 子类创建时 |
| 可影响 `__init_subclass__` | ✅ | ❌ | ❌ |
| 可被继承 | ✅（子类的 metaclass 必须是父类子类） | ❌ | ✅（自动） |
| 入侵性 | 高（影响所有子类） | 中（只影响单类） | 低（只在继承时） |
| 适用 | 框架级（注册、字段系统） | 给单类加方法 | 父类想统一子类行为 |

### 优缺点小结

- **Python 元类**：表达力最强（类即对象）；缺点是难以调试、影响继承链
- **Rust 宏**：编译期、零运行时开销；缺点是过程宏 API 复杂
- **Java 注解 + 反射**：生态成熟；缺点是运行期织入有性能损耗
- **C++ 模板元编程**：零成本；缺点是编译极慢、错误信息灾难
- **Ruby `method_missing`**：动态派发最自然；缺点是性能、IDE 支持弱

### 何时选

- 选 **`__init_subclass__`**：父类想统一子类（如 `__init_subclass__` 注册子类）— 90% 场景
- 选 **类装饰器**：单类需要增强（如 `@dataclass` 就是类装饰器 + 元类组合）
- 选 **元类**：框架级需求（Django ORM / SQLAlchemy / 抽象基类 ABCMeta）
- 选 **`__set_name__`**：描述符需要知道自己绑定到哪个属性名
- 避免 **多重继承 + 元类冲突**：metaclass 冲突错误非常难排查
