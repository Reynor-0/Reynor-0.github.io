---
title: '随笔(八)：左值、右值、移动语义与完美转发'
description: '随手记录看到的一些知识点'
tags: ['C/C++']
series: { id: 'essay', order: 8 }
pubDate: 'Sep 6 2026'
---


## 左值、右值、移动语义与完美转发

现代 C++ 中经常会看到 `std::move()`、移动构造函数、右值引用和完美转发等概念。这几个概念其实是一条完整链路：左值和右值用于描述表达式的 Value Category，右值引用让程序能够识别“这个对象的资源已经可以被接管”，移动构造函数负责真正转移资源，而 `std::move()` 本身只是改变表达式的值类别。完美转发则进一步解决了模板函数在转交参数时如何保留调用者原始左值/右值属性的问题。

为了理解为什么需要移动语义，可以先看一个管理大块动态内存的类：

```cpp
class Buffer {
public:
    explicit Buffer(std::size_t size)
        : size_(size),
          data_(new char[size])
    {
    }

    ~Buffer()
    {
        delete[] data_;
    }

private:
    std::size_t size_;
    char* data_;
};
```

假设 `Buffer` 内部管理 100 MB 数据，如果执行：

```cpp
Buffer a(100 * 1024 * 1024);
Buffer b = a;
```

并且要求 `a` 和 `b` 分别独立拥有自己的数据，那么 `b` 就需要重新申请 100 MB 内存，再把 `a` 中的数据完整复制过去。对于大型 Buffer，这个过程显然非常昂贵。

但如果我们知道 `a` 后面已经不再需要原来的资源，就没有必要再复制 100 MB 数据。更高效的方法是把 `a.data_` 直接交给 `b`，然后把 `a.data_` 置空。所谓 Move Semantics，本质上就是为了表达并支持这种“资源所有权转移”。

### 左值和右值

在现代 C++ 中，左值和右值描述的是**表达式的类别**，而不是某一块内存属于 Stack 还是 Heap。一个比较实用的理解方式是：左值通常代表一个具有稳定身份、后面还可能继续访问的对象，而右值通常代表临时结果，或者一个资源已经可以被接管的对象。

例如：

```cpp
int a = 10;
int b = a;
```

这里表达式 `a` 是左值。虽然它在第二行出现在等号右边，但它依然代表一个具有稳定身份的对象，我们可以继续访问它、修改它，也可以获取它的地址：

```cpp
a = 20;
int* p = &a;
```

所以“左值就是出现在赋值号左边的值”只是非常粗略的入门说法。现代 C++ 中更重要的是“这个表达式是否代表一个具有身份的对象”。

相对而言，下面这些表达式通常属于右值：

```cpp
10
a + b
Buffer(1024)
```

`10` 是一个临时值，`a + b` 是计算产生的临时结果，而 `Buffer(1024)` 创建的是一个临时对象。它们通常不会像某个具名局部变量那样长期保留，因此编译器可以允许程序在合适的情况下直接接管它们内部的资源。

现代 C++ 对 Value Category 还有更精确的划分，其中包括 `lvalue`、`prvalue` 和 `xvalue`。对于移动语义来说，`xvalue` 尤其重要，它可以理解为“这个对象依然具有身份，但我们已经允许它的资源被转移”。`std::move()` 最终产生的就是这种表达式。

### 左值引用和右值引用

传统引用：

```cpp
T&
```

通常绑定左值。例如：

```cpp
int a = 10;
int& ref = a;
```

而：

```cpp
int& ref = 10;
```

通常不合法，因为 `10` 是右值，不能绑定到普通非 `const` 左值引用。

C++11 引入了右值引用：

```cpp
T&&
```

例如：

```cpp
int&& ref = 10;
```

右值引用最重要的意义不是语法上多了两个 `&`，而是让函数可以区分“普通仍需要保留的对象”和“资源已经允许被接管的对象”。

例如：

```cpp
void process(const Buffer& buffer);
void process(Buffer&& buffer);
```

如果调用：

```cpp
Buffer buffer(1024);
process(buffer);
```

`buffer` 是左值，因此通常匹配 `const Buffer&`。而：

```cpp
process(Buffer(1024));
```

传入的是临时对象，因此可以匹配 `Buffer&&`。这样程序就有机会针对右值采用移动而不是拷贝。

### 拷贝构造函数

拷贝构造函数通常写成：

```cpp
T(const T& other);
```

对于前面的 `Buffer`，可以这样实现：

```cpp
Buffer(const Buffer& other)
    : size_(other.size_),
      data_(new char[other.size_])
{
    std::copy(
        other.data_,
        other.data_ + size_,
        data_);
}
```

当执行：

```cpp
Buffer a(1024);
Buffer b = a;
```

时，`b` 是一个新对象，所以会调用 Copy Constructor。这个过程并不是简单复制 `data_` 指针，否则 `a` 和 `b` 会同时指向同一块内存，最终析构时发生 Double Free。正确的拷贝语义通常要求重新申请一块独立资源，再复制数据。

所以 Copy 的本质是：**根据已有对象，创建一份独立的新对象状态。**

对于普通小型对象，这个代价可能很低；对于管理大块 Heap Buffer、文件内容或复杂容器的对象，Copy 可能非常昂贵。

### 移动构造函数

移动构造函数通常写成：

```cpp
T(T&& other);
```

对于 `Buffer`，可以这样实现：

```cpp
Buffer(Buffer&& other) noexcept
    : size_(other.size_),
      data_(other.data_)
{
    other.size_ = 0;
    other.data_ = nullptr;
}
```

执行：

```cpp
Buffer a(100 * 1024 * 1024);
Buffer b = std::move(a);
```

时，不需要重新申请 100 MB 数据，也不需要执行大规模 `memcpy`。我们只是把 `a` 内部的资源句柄转移给 `b`：

```cpp
b.data_ = a.data_;
b.size_ = a.size_;

a.data_ = nullptr;
a.size_ = 0;
```

因此所谓“移动”，通常并不是把底层数据从一个地址搬到另一个地址，而是转移资源所有权。对于 `std::vector`、`std::string`、`std::unique_ptr` 这类对象，Move 通常只是转移内部 Pointer、Size、Capacity 或资源 Handle，真正的大块 Heap Memory 很可能原封不动地待在原来的物理位置。

### std::move() 本身并不会移动对象

这是整个移动语义中最重要的一点：

> `std::move()` 本身不会移动任何数据，也不会自动转移资源。

例如：

```cpp
Buffer a(1024);
std::move(a);
```

单独执行这一句不会发生资源转移，`a` 仍然是原来的对象。`std::move()` 真正做的只是把表达式转换成一个可以被当作右值处理的表达式。

它的实现可以粗略理解为：

```cpp
template <typename T>
std::remove_reference_t<T>&& move(T&& value)
{
    return static_cast<
        std::remove_reference_t<T>&&
    >(value);
}
```

所以：

```cpp
std::move(a)
```

本质上接近：

```cpp
static_cast<Buffer&&>(a)
```

也就是说，`std::move()` 只是在告诉编译器：

> 我们允许后续代码把 `a` 当作一个资源可以被接管的对象。

真正的移动发生在：

```cpp
Buffer b = std::move(a);
```

因为 `std::move(a)` 产生了 xvalue，Overload Resolution 因此可以选择：

```cpp
Buffer(Buffer&& other);
```

随后 Move Constructor 内部才真正完成资源所有权转移。

所以可以非常明确地理解成：

```text
std::move()
负责改变 Value Category

Move Constructor / Move Assignment
负责真正转移资源
```

### 有名字的右值引用仍然是左值

这一点非常容易混淆。

例如：

```cpp
void func(Buffer&& buffer)
{
}
```

变量 `buffer` 的类型确实是：

```cpp
Buffer&&
```

但表达式：

```cpp
buffer
```

本身却是左值，因为它已经拥有名字和稳定身份。

例如：

```cpp
void func(Buffer&& buffer)
{
    Buffer another = buffer;
}
```

这里通常会调用 Copy Constructor，因为 `buffer` 这个表达式是左值。

如果我们明确希望继续移动：

```cpp
void func(Buffer&& buffer)
{
    Buffer another = std::move(buffer);
}
```

才会把它重新转换成 xvalue，从而调用 Move Constructor。

因此有一句非常重要的规则：

> Named rvalue reference is an lvalue。

也就是“有名字的右值引用，在表达式中仍然是左值”。

### 移动之后原对象还能不能使用

例如：

```cpp
std::string a = "hello";
std::string b = std::move(a);
```

这里 `a` 并没有消失，它仍然是一个合法对象，后面仍然会正常执行 Destructor。

但移动之后，原对象通常只保证处于：

```text
valid but unspecified state
```

也就是“合法但状态未指定”。

所以我们可以对它执行：

```cpp
a.clear();
a = "world";
```

这类不依赖旧状态的操作，但通常不应该继续假设它仍然保存 `"hello"`，也不要随意依赖它一定为空，除非对应类型明确保证 Move 后的状态。

所以 Move 后原对象的正确理解不是“对象失效了”，而是：

> 对象仍然存在，但它原来的资源可能已经被另一个对象接管。

### 移动赋值和移动构造的区别

移动构造发生在“新对象正在创建”的时候：

```cpp
Buffer a(1024);
Buffer b = std::move(a);
```

这里调用：

```cpp
Buffer(Buffer&&);
```

而移动赋值发生在目标对象已经存在的时候：

```cpp
Buffer a(1024);
Buffer b(2048);

b = std::move(a);
```

这里调用：

```cpp
Buffer& operator=(Buffer&&);
```

一个典型实现是：

```cpp
Buffer& operator=(Buffer&& other) noexcept
{
    if (this != &other) {
        delete[] data_;

        size_ = other.size_;
        data_ = other.data_;

        other.size_ = 0;
        other.data_ = nullptr;
    }

    return *this;
}
```

相比移动构造，Move Assignment 多了一件事：`b` 原来已经拥有资源，因此在接管 `a` 的资源之前，需要先正确释放自己原来的资源。

类似地：

```cpp
Buffer b = a;
```

调用的是 Copy Constructor，而：

```cpp
Buffer b(1024);
b = a;
```

调用的是 Copy Assignment Operator。

可以总结成：

| 代码                    | 调用               |
| --------------------- | ---------------- |
| `T b = a;`            | Copy Constructor |
| `T b(a);`             | Copy Constructor |
| `b = a;`              | Copy Assignment  |
| `T b = std::move(a);` | Move Constructor |
| `b = std::move(a);`   | Move Assignment  |

### 为什么移动构造函数经常写 noexcept

我们经常看到：

```cpp
Buffer(Buffer&& other) noexcept;
```

这里的 `noexcept` 对标准容器非常重要。

例如：

```cpp
std::vector<Buffer> buffers;
```

当 `vector` 扩容时，需要把旧存储区中的对象转移到新的存储区。如果 `Buffer` 的 Move Constructor 保证不会抛异常，那么 `vector` 可以放心地使用 Move。

但如果 Move Constructor 可能抛异常，而 Copy Constructor 又存在，那么为了维持异常安全保证，某些标准库实现可能会选择 Copy，而不是 Move。

对于只是转移 Pointer、File Descriptor、Handle 等不会失败的 Move 操作，通常应该考虑声明：

```cpp
noexcept
```

这样不仅语义更准确，也有利于标准容器采用移动优化。

### const 对移动语义的影响

`std::move()` 并不保证一定会调用 Move Constructor。

例如：

```cpp
const Buffer a(1024);
Buffer b = std::move(a);
```

`a` 是 `const Buffer`，所以 `std::move(a)` 得到的是：

```cpp
const Buffer&&
```

而我们典型的移动构造函数是：

```cpp
Buffer(Buffer&& other);
```

它需要修改 `other`，例如：

```cpp
other.data_ = nullptr;
```

因此不能绑定 `const Buffer&&`。

此时如果存在：

```cpp
Buffer(const Buffer&);
```

编译器反而可能选择 Copy Constructor。

所以：

> `std::move()` 只负责改变表达式类别，不保证最终一定发生 Move。

最终调用 Copy 还是 Move，还取决于类型、`const` 属性以及 Overload Resolution。

### 返回局部对象时通常不要手工 std::move

例如：

```cpp
Buffer createBuffer()
{
    Buffer buffer(1024);
    return buffer;
}
```

通常没有必要写：

```cpp
return std::move(buffer);
```

现代 C++ 编译器首先可能进行 NRVO，也就是 Named Return Value Optimization，直接在调用者最终的存储位置构造 `buffer`，甚至连 Move Constructor 都不需要执行。

即使没有发生 NRVO，语言规则对于返回局部对象也通常能够自动采用 Move Semantics。

所以：

```cpp
return buffer;
```

通常是更好的写法。

反而显式写：

```cpp
return std::move(buffer);
```

在某些情况下可能阻止 NRVO。

### Copy Elision

考虑：

```cpp
Buffer create()
{
    return Buffer(1024);
}

Buffer buffer = create();
```

从表面上看，我们可能以为发生了：

```text
创建临时 Buffer
→ Move 到函数返回值
→ 再 Move 到 buffer
```

但现代 C++ 在很多场景下可以直接在 `buffer` 最终所在的位置构造 `Buffer(1024)`，中间的 Copy 和 Move 都不存在。

这就是 Copy Elision。

所以需要区分：

```text
Move
```

和：

```text
根本没有产生中间对象
```

后者通常比 Move 更高效。

## 完美转发

移动语义解决的是“已经明确允许转移资源时如何避免 Copy”，而 Perfect Forwarding 解决的是另一个问题：一个模板中间层如何在继续调用其他函数时，保留调用者原本传进来的左值或右值属性。

例如：

```cpp
void process(Buffer& buffer);
void process(Buffer&& buffer);
```

我们写一个包装函数：

```cpp
template <typename T>
void wrapper(T&& value)
{
    process(value);
}
```

然后：

```cpp
Buffer buffer(1024);

wrapper(buffer);
wrapper(Buffer(1024));
```

我们希望第一种情况调用：

```cpp
process(Buffer&);
```

第二种情况调用：

```cpp
process(Buffer&&);
```

但直接写：

```cpp
process(value);
```

会出现问题，因为无论 `value` 的声明类型最终是什么，只要它已经有名字，表达式 `value` 本身就是左值。

所以原本传进来的右值信息会在中间层丢失。

### Forwarding Reference

下面这种形式：

```cpp
template <typename T>
void wrapper(T&& value);
```

如果 `T` 是通过模板类型推导得到的，那么这里的 `T&&` 并不仅仅是普通右值引用，而是一种 Forwarding Reference。

它的特殊之处在于：

> 它既可以接收左值，也可以接收右值。

例如：

```cpp
int a = 10;

wrapper(a);
wrapper(10);
```

两者都可以正常调用。

这背后依赖 Reference Collapsing，也就是引用折叠规则。

### 引用折叠

引用折叠规则可以记成：

```text
T&  &   → T&
T&  &&  → T&
T&& &   → T&
T&& &&  → T&&
```

简单理解就是：只要组合中出现了左值引用 `&`，最后通常折叠成 `&`；只有两个都是 `&&` 时，最终才得到 `&&`。

例如：

```cpp
template <typename T>
void wrapper(T&& value);
```

调用：

```cpp
int a = 10;
wrapper(a);
```

因为 `a` 是左值，模板推导会得到：

```cpp
T = int&
```

于是：

```cpp
T&&
```

变成：

```cpp
int& &&
```

经过引用折叠得到：

```cpp
int&
```

所以 Forwarding Reference 可以接收左值。

如果调用：

```cpp
wrapper(10);
```

`10` 是右值，此时：

```cpp
T = int
```

所以：

```cpp
T&& = int&&
```

最终仍然是右值引用。

### std::forward()

由于 Forwarding Reference 接收参数以后，具名变量 `value` 自身会变成左值表达式，所以需要 `std::forward()` 恢复调用者最初传进来的 Value Category。

正确写法是：

```cpp
template <typename T>
void wrapper(T&& value)
{
    process(std::forward<T>(value));
}
```

如果调用：

```cpp
Buffer buffer(1024);
wrapper(buffer);
```

模板推导得到：

```cpp
T = Buffer&
```

所以：

```cpp
std::forward<T>(value)
```

最终仍然产生左值，调用：

```cpp
process(Buffer&);
```

而：

```cpp
wrapper(Buffer(1024));
```

此时：

```cpp
T = Buffer
```

所以 `std::forward<Buffer>(value)` 会恢复成右值，最终调用：

```cpp
process(Buffer&&);
```

这就是 Perfect Forwarding 的核心：

> 调用者传进来的是左值，我们继续按左值传递；调用者传进来的是右值，我们继续按右值传递。

### std::move 和 std::forward 的区别

这两个函数看起来很像，但语义完全不同。

```cpp
std::move(x)
```

表达的是：

> 从现在开始，无条件把 `x` 当成可以被移动的对象。

而：

```cpp
std::forward<T>(x)
```

表达的是：

> 根据模板推导结果，恢复调用者原来的左值/右值属性。

例如：

```cpp
template <typename T>
void wrapper(T&& value)
{
    process(std::move(value));
}
```

这样无论调用者最初传的是左值还是右值，都会被强行转换成右值，因此不是 Perfect Forwarding。

正确做法是：

```cpp
template <typename T>
void wrapper(T&& value)
{
    process(std::forward<T>(value));
}
```

可以总结：

| API                  | 作用                    |
| -------------------- | --------------------- |
| `std::move(x)`       | 无条件把 `x` 转换成可移动的右值表达式 |
| `std::forward<T>(x)` | 根据 `T` 保留原始左值/右值属性    |

### 完美转发的典型应用

完美转发最典型的应用之一就是工厂函数：

```cpp
template <typename T, typename... Args>
std::unique_ptr<T> makeObject(Args&&... args)
{
    return std::unique_ptr<T>(
        new T(std::forward<Args>(args)...)
    );
}
```

这里：

```cpp
Args&&... args
```

是一组 Forwarding References，而：

```cpp
std::forward<Args>(args)...
```

负责把每一个参数按照调用者原来的 Value Category 转交给 `T` 的构造函数。

标准库中的：

```cpp
std::make_unique
std::make_shared
std::vector::emplace_back
```

等接口背后都大量使用了这套机制。

例如：

```cpp
std::vector<Camera> cameras;

cameras.emplace_back(1, "front");
```

`emplace_back()` 会把 `1` 和 `"front"` 直接转发给 `Camera` 的构造函数，从而尽可能直接在容器内部构造对象，而不是先构造一个临时 `Camera` 再搬进去。

## 和智能指针的联系

前面介绍 `unique_ptr` 时，我们写过：

```cpp
auto p1 = std::make_unique<Camera>();
auto p2 = std::move(p1);
```

现在就可以完整解释这段代码。

`p1` 是一个有名字的变量，因此表达式 `p1` 是左值。但 `unique_ptr` 禁止 Copy Constructor，只允许 Move Constructor。

所以：

```cpp
auto p2 = p1;
```

无法编译。

而：

```cpp
std::move(p1)
```

把 `p1` 转换成 xvalue，于是能够匹配：

```cpp
unique_ptr(unique_ptr&&);
```

真正的 Ownership Transfer 由 `unique_ptr` 的 Move Constructor 完成，它把内部 Raw Pointer 转交给 `p2`，再让 `p1` 变为空状态。

因此：

```text
std::move
负责表达“资源允许被转移”

Move Constructor
负责真正转移 Ownership
```

`shared_ptr` 既支持 Copy，也支持 Move。Copy 一个 `shared_ptr` 会增加 Strong Reference Count，而 Move 通常只是把 Object Pointer 和 Control Block Pointer 转交给新对象，不需要增加新的共享 Owner，所以 Move 一般比 Copy 更轻量。

## Rule of Five

如果一个类手工管理资源，那么通常需要认真考虑下面五个函数：

```cpp
~T();

T(const T&);
T& operator=(const T&);

T(T&&);
T& operator=(T&&);
```

分别对应 Destructor、Copy Constructor、Copy Assignment、Move Constructor 和 Move Assignment。

这就是 Rule of Five。

例如前面的 `Buffer` 如果完整实现，可以写成：

```cpp
class Buffer {
public:
    explicit Buffer(std::size_t size)
        : size_(size),
          data_(new char[size])
    {
    }

    ~Buffer()
    {
        delete[] data_;
    }

    Buffer(const Buffer& other)
        : size_(other.size_),
          data_(new char[other.size_])
    {
        std::copy(
            other.data_,
            other.data_ + size_,
            data_);
    }

    Buffer& operator=(const Buffer& other)
    {
        if (this != &other) {
            char* new_data =
                new char[other.size_];

            std::copy(
                other.data_,
                other.data_ + other.size_,
                new_data);

            delete[] data_;

            data_ = new_data;
            size_ = other.size_;
        }

        return *this;
    }

    Buffer(Buffer&& other) noexcept
        : size_(other.size_),
          data_(other.data_)
    {
        other.size_ = 0;
        other.data_ = nullptr;
    }

    Buffer& operator=(Buffer&& other) noexcept
    {
        if (this != &other) {
            delete[] data_;

            size_ = other.size_;
            data_ = other.data_;

            other.size_ = 0;
            other.data_ = nullptr;
        }

        return *this;
    }

private:
    std::size_t size_ = 0;
    char* data_ = nullptr;
};
```

不过现代 C++ 更推荐尽量把底层资源交给 `std::unique_ptr`、`std::vector`、`std::string` 等已经正确实现 Copy/Move/Destructor 语义的 RAII 类型，从而让业务类尽量遵循 Rule of Zero。

## 总结

左值和右值描述的是表达式的 Value Category，而不是对象所在的内存区域。左值通常代表一个具有稳定身份、后面仍可能继续访问的对象；右值通常代表临时结果，或者资源已经允许被接管的对象。现代 C++ 又使用 xvalue 表示“对象仍然存在，但资源已经允许被转移”的表达式，而 `std::move()` 的作用正是把一个对象转换成这种表达式。

Copy Constructor：

```cpp
T(const T&);
```

负责根据现有对象创建一份独立状态，对于管理动态资源的对象而言，通常意味着重新申请资源并复制内容。

Move Constructor：

```cpp
T(T&&);
```

则允许直接接管源对象的资源，因此所谓“Move”通常不是移动底层数据本身，而是转移 Pointer、Handle 或 Ownership。

`std::move()` 本身不做资源转移，它只是一个 Cast；真正的移动发生在 Move Constructor 或 Move Assignment Operator 内部。`std::forward()` 则不同，它主要服务于模板中的 Perfect Forwarding，用于根据模板推导结果恢复调用者原始的左值或右值属性。

因此整套机制可以理解为：

```text
左值 / 右值
    ↓
描述表达式 Value Category

T&
    ↓
左值引用

T&&
    ↓
右值引用

std::move()
    ↓
把表达式转换成 xvalue

Move Constructor / Move Assignment
    ↓
真正转移资源

Forwarding Reference
    ↓
同时接收左值和右值

std::forward()
    ↓
恢复调用者原始 Value Category

Perfect Forwarding
    ↓
调用者怎么传进来，就怎么继续传递
```

理解这一套机制以后，`unique_ptr`、`shared_ptr`、`vector`、`emplace_back()`、`make_unique()`、`make_shared()` 等现代 C++ 接口背后的设计逻辑就能够自然串联起来。
