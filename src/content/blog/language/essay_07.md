---
title: '随笔(七)：RAII与智能指针'
description: '随手记录看到的一些知识点'
tags: ['C/C++']
series: { id: 'essay', order: 7 }
pubDate: 'Sep 5 2026'
---

## RAII 与智能指针

前面介绍 Heap 时，我们提到使用 `new` 创建的对象需要通过 `delete` 释放，使用 `malloc()` 分配的内存需要通过 `free()` 释放。如果程序在正确的时间完成释放，一切都没有问题；但随着代码变复杂，手工维护资源生命周期会迅速变得困难。

例如：

```cpp
void process()
{
    Camera* camera = new Camera();

    doSomething();

    delete camera;
}
```

这段代码看起来没有问题，但如果 `doSomething()` 中途抛出异常：

```cpp
void process()
{
    Camera* camera = new Camera();

    doSomething();   // throw

    delete camera;   // 无法执行
}
```

`camera` 就无法被释放，最终产生 Memory Leak。

类似的问题并不仅仅存在于 Heap Memory。文件描述符、Socket、Mutex、文件句柄、DMA Buffer、设备句柄等资源都有类似的生命周期问题。

例如：

```cpp
int fd = open("/dev/video0", O_RDWR);

// 中间发生错误

close(fd);
```

如果中途某条路径提前 `return`，或者抛出异常，我们都必须保证 `close(fd)` 能够被执行。

C++ 为了解决这一类资源生命周期问题，形成了一个非常重要的设计思想：

> RAII，Resource Acquisition Is Initialization，也就是“资源获取即初始化”。

RAII 的核心并不是“智能指针”，而是：

> 将资源的生命周期绑定到一个 C++ 对象的生命周期上。

当对象构造时获得资源，当对象析构时自动释放资源。因为 C++ 的局部对象在离开作用域时会自动调用析构函数，所以资源释放也会自然发生。

### RAII 的基本思想

例如我们自己封装一个文件描述符：

```cpp
class FileDescriptor {
public:
    explicit FileDescriptor(int fd)
        : fd_(fd)
    {
    }

    ~FileDescriptor()
    {
        if (fd_ >= 0) {
            close(fd_);
        }
    }

private:
    int fd_;
};
```

使用：

```cpp
void process()
{
    FileDescriptor fd(open("/dev/video0", O_RDWR));

    doSomething();
}
```

无论 `process()` 是正常返回，还是中间发生异常，只要 `FileDescriptor` 对象能够正常析构，`close(fd)` 就会被执行。

因此 RAII 最重要的价值是：

> 我们不再手工记忆“什么时候应该释放资源”，而是让资源的生命周期自动跟随对象的生命周期。

这种思想不仅可以管理内存，也可以管理几乎所有需要成对操作的资源，例如 `new/delete`、`malloc/free`、`open/close`、`fopen/fclose`、`mmap/munmap`、`lock/unlock` 等。

只要资源存在明确的 Acquire / Release 关系，就可以考虑使用 RAII 进行封装。

### 为什么 RAII 和 Stack 联系非常紧密

前面介绍 Stack 时，我们提到局部对象的生命周期通常由作用域自动管理。

例如：

```cpp
void func()
{
    Camera camera;
}
```

离开 `func()` 时，`Camera::~Camera()` 会自动执行。

RAII 正是利用了这套 C++ Object Lifetime 机制。对象进入作用域时通过 Constructor 获取资源，离开作用域时通过 Destructor 释放资源。

所以 RAII 的本质不是某个库函数，而是一种建立在 `Constructor`、`Destructor`、`Scope` 和 `Object Lifetime` 之上的资源管理模型。

## 智能指针

动态内存是最常见的资源之一，所以 C++ 标准库在 RAII 基础上提供了 Smart Pointer，也就是智能指针。

现代 C++ 中最重要的三个智能指针是：

```cpp
std::unique_ptr
std::shared_ptr
std::weak_ptr
```

它们并不是三种“更安全的普通指针”这么简单，更准确地说，它们分别描述三种不同的 Ownership，也就是资源所有权关系。

| 类型                | 所有权语义                        |
| ----------------- | ---------------------------- |
| `std::unique_ptr` | 独占所有权                        |
| `std::shared_ptr` | 共享所有权                        |
| `std::weak_ptr`   | 不拥有资源，只观察 `shared_ptr` 管理的对象 |

因此使用智能指针之前，真正应该先问的是：

> 这个对象到底由谁拥有？

而不是：

> 这里应该用哪一种智能指针？

### unique_ptr

`std::unique_ptr` 表达的是：

> 当前资源只有一个 Owner。

例如：

```cpp
#include <memory>

auto camera = std::make_unique<Camera>();
```

当 `camera` 离开作用域时，`unique_ptr` 的析构函数会自动调用 `delete`，随后执行 `Camera` 的析构函数。

因此我们不需要再手动：

```cpp
delete camera;
```

#### unique_ptr 的基本使用

传统写法：

```cpp
Camera* camera = new Camera();

camera->start();

delete camera;
```

使用 `unique_ptr`：

```cpp
auto camera = std::make_unique<Camera>();

camera->start();
```

当作用域结束时会自动释放。

因此现代 C++ 中，如果对象确实需要动态分配，并且只有一个 Owner，通常优先考虑：

```cpp
std::unique_ptr
```

#### unique_ptr 为什么不能复制

例如：

```cpp
auto p1 = std::make_unique<Camera>();

auto p2 = p1;
```

这是不允许的。

原因不是编译器故意限制，而是因为 `unique_ptr` 表达的是 Unique Ownership。

如果 `p1` 和 `p2` 都认为自己拥有同一个 Camera，那么两个对象析构时都会执行 `delete`，最终发生 Double Free。

所以 `unique_ptr` 禁止 Copy：

```cpp
unique_ptr(const unique_ptr&) = delete;
```

但允许 Move：

```cpp
auto p1 = std::make_unique<Camera>();

auto p2 = std::move(p1);
```

此时所有权发生转移，`p2` 接管 Camera，而 `p1` 变为空状态。

这正是 Move Semantics 在资源管理中的一个非常典型用途。

#### unique_ptr 的底层原理

一个最简单的 `unique_ptr` 可以粗略写成：

```cpp
template <typename T>
class UniquePtr {
public:
    explicit UniquePtr(T* ptr = nullptr)
        : ptr_(ptr)
    {
    }

    ~UniquePtr()
    {
        delete ptr_;
    }

    UniquePtr(const UniquePtr&) = delete;
    UniquePtr& operator=(const UniquePtr&) = delete;

    UniquePtr(UniquePtr&& other) noexcept
        : ptr_(other.ptr_)
    {
        other.ptr_ = nullptr;
    }

    UniquePtr& operator=(UniquePtr&& other) noexcept
    {
        if (this != &other) {
            delete ptr_;

            ptr_ = other.ptr_;
            other.ptr_ = nullptr;
        }

        return *this;
    }

private:
    T* ptr_;
};
```

真实的 `std::unique_ptr` 要复杂得多，还要处理 Deleter、数组、Empty Base Optimization 等问题，但核心思想就是保存一个 Pointer，并在析构时调用对应的 Deleter。

因此在最常见情况下，`std::unique_ptr<T>` 自身通常只需要保存一个 Pointer 大小的数据。具体大小仍然取决于实现方式以及 Deleter。

#### make_unique

相比：

```cpp
std::unique_ptr<Camera> camera(new Camera());
```

现代 C++ 更推荐：

```cpp
auto camera = std::make_unique<Camera>();
```

这样代码更加简洁，也减少了直接操作裸 `new` 的机会。

对于数组也可以：

```cpp
auto buffer =
    std::make_unique<uint8_t[]>(1024);
```

#### release、reset 和 get

`unique_ptr` 提供几个容易混淆的接口。

`get()` 只是取出内部保存的 Raw Pointer：

```cpp
Camera* raw = camera.get();
```

所有权仍然属于 `camera`，因此通常不能对 `raw` 手工执行 `delete`，否则 `unique_ptr` 后续还会再次释放。

`reset()` 会释放原来的资源，并接管新的资源：

```cpp
camera.reset(new Camera());
```

如果：

```cpp
camera.reset();
```

则释放当前对象，并变成空状态。

`release()` 则完全不同：

```cpp
Camera* raw = camera.release();
```

它会放弃所有权，但不会释放对象。调用之后 `camera` 为空，而资源生命周期重新由 Raw Pointer 的持有者手工负责。

因此 `release()` 应该谨慎使用，因为它本质上是从 RAII 管理重新退回手工资源管理。

#### Custom Deleter

`unique_ptr` 并不只能调用 `delete`。

例如：

```cpp
FILE* fp = fopen("test.txt", "r");
```

正常需要：

```cpp
fclose(fp);
```

可以为 `unique_ptr` 自定义 Deleter：

```cpp
auto deleter = [](FILE* fp) {
    if (fp) {
        fclose(fp);
    }
};

std::unique_ptr<FILE, decltype(deleter)>
    file(fopen("test.txt", "r"), deleter);
```

这样析构时调用的是 `fclose()`，而不是 `delete`。

这说明智能指针本质上管理的并不只是 Heap Memory，而是：

> 一个 Resource Handle + 一个 Release Operation。

因此在嵌入式 C++ 中，我们也可以使用类似思想管理 `FILE*`、Socket、设备 Handle、映射内存等资源。

### shared_ptr

`std::shared_ptr` 表达的是：

> 一个对象可以同时被多个 Owner 共同拥有。

例如：

```cpp
auto camera =
    std::make_shared<Camera>();

auto p1 = camera;
auto p2 = camera;
```

此时 `camera`、`p1` 和 `p2` 都共同拥有同一个 Camera。只要还有一个 `shared_ptr` 存在，Camera 就不会被销毁。

最后一个 Owner 消失时，引用计数降为 0，Camera 才会真正析构。

#### shared_ptr 的引用计数

例如：

```cpp
auto p1 = std::make_shared<Camera>();
```

此时 Strong Reference Count 为 1。

继续：

```cpp
auto p2 = p1;
```

Strong Reference Count 变成 2。

然后：

```cpp
p1.reset();
```

引用计数变成 1。

最后：

```cpp
p2.reset();
```

引用计数变成 0，对象被销毁。

因此 `shared_ptr` 的核心就是：

> 多个智能指针共同维护一个共享的 Reference Count。

#### shared_ptr 的底层结构

一个典型的 `shared_ptr` 可以粗略理解为保存两个 Pointer：

```text
shared_ptr

+-----------------------+
| Object Pointer        |
+-----------------------+
| Control Block Pointer |
+-----------------------+
```

其中一个指向真正的 Object，另一个指向 Control Block。

Control Block 中通常包含 Strong Count、Weak Count、Deleter、Allocator 等信息。

多个 `shared_ptr` 并不会各自维护一份独立引用计数，而是共同引用同一个 Control Block。

因此：

```cpp
auto p1 = std::make_shared<Camera>();
auto p2 = p1;
auto p3 = p1;
```

可以理解为三个 `shared_ptr` 都指向同一个 Control Block，此时 Strong Count 为 3。

复制 `shared_ptr` 的主要动作就是复制 Object Pointer 和 Control Block Pointer，并增加 Strong Count。析构或 Reset 时则减少 Strong Count。

#### make_shared 为什么通常更推荐

可以这样创建：

```cpp
std::shared_ptr<Camera>
    camera(new Camera());
```

这种方式通常需要分别为 Camera Object 和 Control Block 进行 allocation。

而：

```cpp
auto camera =
    std::make_shared<Camera>();
```

标准库实现通常可以把 Object 和 Control Block 合并到一次 allocation 中。

因此 `make_shared()` 往往能够减少 Heap Allocation 次数，并改善一定的 Cache Locality。

不过这也意味着 Object 和 Control Block 的 allocation 生命周期会绑定得更紧。当 Object 已经析构，但仍然存在 `weak_ptr` 时，包含 Control Block 的那块 allocation 可能暂时不会完全释放。

### weak_ptr

有了 `shared_ptr` 以后，会出现一个经典问题：

> Circular Reference，也就是循环引用。

例如：

```cpp
class B;

class A {
public:
    std::shared_ptr<B> b;
};

class B {
public:
    std::shared_ptr<A> a;
};
```

然后：

```cpp
auto a = std::make_shared<A>();
auto b = std::make_shared<B>();

a->b = b;
b->a = a;
```

此时 A 拥有 B，而 B 又拥有 A。

即使外部执行：

```cpp
a.reset();
b.reset();
```

A 内部仍然通过 `shared_ptr` 拥有 B，B 内部也仍然通过 `shared_ptr` 拥有 A，所以它们的 Strong Count 都无法降到 0。

最终这两个对象永远不会析构，从而产生 Memory Leak。

#### weak_ptr 解决循环引用

`std::weak_ptr` 表示：

> 我知道这个对象，但我不拥有它。

例如：

```cpp
class A {
public:
    std::shared_ptr<B> b;
};

class B {
public:
    std::weak_ptr<A> a;
};
```

这时 B 对 A 的引用不会增加 Strong Reference Count，所以当外部 Owner 消失以后，A 可以正常析构，随后 B 也可以正常析构。

#### weak_ptr 为什么不能直接解引用

因为 `weak_ptr` 不拥有对象。

对象可能已经因为最后一个 `shared_ptr` 被释放而销毁，所以不能像普通 Pointer 那样直接：

```cpp
weak->start();
```

正确方式是：

```cpp
if (auto camera = weak.lock()) {
    camera->start();
}
```

`lock()` 会尝试创建一个新的 `shared_ptr`。如果对象还存在，就获得一个有效的 `shared_ptr`；如果对象已经销毁，则返回空的 `shared_ptr`。

这样就避免了悬空访问。

#### weak_ptr 与 Control Block

即使 Strong Count 已经变为 0，对象本身已经析构，只要还有 `weak_ptr` 存在，Control Block 通常仍然需要保留。

因为 `weak_ptr` 仍然需要通过 Control Block 判断对象是否已经失效。

所以可以理解为：

```text
Strong Count > 0
    → Object Alive
    → Control Block Alive

Strong Count = 0
    → Object Destroyed

Weak Count > 0
    → Control Block Still Alive

Weak Count = 0
    → Control Block Destroyed
```

因此 Object Lifetime 和 Control Block Lifetime 并不是完全相同的。

## unique_ptr、shared_ptr 和 weak_ptr 的区别

| 类型           | 是否拥有资源 | 是否可以复制 | 是否有引用计数      | 典型用途     |
| ------------ | ------ | ------ | ------------ | -------- |
| `unique_ptr` | 独占拥有   | 不可以    | 无            | 单一 Owner |
| `shared_ptr` | 共享拥有   | 可以     | Strong Count | 多 Owner  |
| `weak_ptr`   | 不拥有    | 可以     | Weak Count   | 观察共享对象   |

如果对象天然只有一个 Owner，通常优先使用 `std::unique_ptr`；只有多个组件确实需要共同决定对象生命周期时，才使用 `std::shared_ptr`；如果只是观察一个由 `shared_ptr` 管理的对象而不希望延长其生命周期，则使用 `std::weak_ptr`。

## 为什么不要全部使用 shared_ptr

`shared_ptr` 使用起来非常方便，但它的代价也明显高于 `unique_ptr`。

首先，它需要额外的 Control Block 来维护 Reference Count、Weak Count、Deleter 等信息；其次，每次复制和析构都需要更新引用计数。在多线程环境中，为了支持不同 `shared_ptr` 实例安全地共同管理同一个 Control Block，引用计数的更新通常需要使用原子操作。

因此 `shared_ptr` Copy 通常比 Raw Pointer Copy 或 `unique_ptr` Move 更昂贵。

另外，更大的问题是 Shared Ownership 会让对象生命周期变得不够明确。如果系统中到处都是 `shared_ptr`，我们很难快速判断到底哪个模块真正决定对象的生命周期。

所以更合理的原则通常是：默认使用 Unique Ownership；确实需要 Shared Ownership 时使用 `shared_ptr`；只观察对象时则使用 `weak_ptr`、Raw Pointer 或 Reference。

## shared_ptr 的线程安全

`shared_ptr` 的“线程安全”很容易被误解。

例如多个线程分别持有不同的 `shared_ptr` 实例，并共同指向同一个 Control Block，那么对引用计数的增加和减少通常由标准库正确处理。

但是：

> `shared_ptr` 的线程安全并不意味着它指向的对象自动线程安全。

例如：

```cpp
auto camera =
    std::make_shared<Camera>();
```

如果 Thread A 和 Thread B 同时执行：

```cpp
camera->state++;
```

仍然可能产生 Data Race。

所以 `shared_ptr` 解决的是 Ownership Metadata 的生命周期管理，而不是对象内部数据的并发同步。如果对象本身会被多个线程同时访问，仍然需要 Mutex、Atomic 等同步机制。

## Raw Pointer 还有没有必要

有智能指针以后，Raw Pointer 并不是不能使用。

真正需要区分的是：

> Ownership Pointer 和 Observer Pointer。

例如：

```cpp
class CameraManager {
private:
    std::unique_ptr<Camera> camera_;
};
```

这里 `camera_` 明确表示 `CameraManager` 拥有 Camera。

但如果某个函数只是暂时访问 Camera：

```cpp
void configure(Camera* camera);
```

这里的 `Camera*` 完全可以只是 Non-owning Pointer，它不负责释放 Camera。

如果对象一定存在，则还可以使用：

```cpp
void configure(Camera& camera);
```

因此现代 C++ 并不是要求所有 `T*` 都替换成智能指针，而是要求我们用智能指针清楚地表达 Ownership。

## 智能指针作为函数接口

如果函数要求对象一定存在，而且不接管生命周期：

```cpp
void configure(Camera& camera);
```

Reference 很合适。

如果对象可能不存在：

```cpp
void configure(Camera* camera);
```

可以通过 `nullptr` 表示没有对象。

如果函数需要接管唯一所有权：

```cpp
void setCamera(std::unique_ptr<Camera> camera);
```

调用时：

```cpp
setCamera(std::move(camera));
```

这明确表达了 Camera Ownership 被转移。

如果函数需要共同持有对象：

```cpp
void addCamera(std::shared_ptr<Camera> camera);
```

则意味着调用者和被调用者共同参与 Camera 生命周期管理。

不同参数类型实际上就是不同的 Ownership Contract。

## unique_ptr 作为返回值

Factory Interface 很适合使用 `unique_ptr`：

```cpp
std::unique_ptr<Camera> createCamera()
{
    return std::make_unique<Camera>();
}
```

调用：

```cpp
auto camera = createCamera();
```

这里的所有权关系非常清晰：`createCamera()` 创建对象，然后通过 `unique_ptr` 将 Ownership 转移给调用者。

由于 `unique_ptr` 支持 Move Semantics，所以不需要复制底层 Camera Object。

## unique_ptr 作为类成员

例如：

```cpp
class CameraSystem {
public:
    CameraSystem()
        : camera_(std::make_unique<Camera>())
    {
    }

private:
    std::unique_ptr<Camera> camera_;
};
```

这里明确表达：

> `CameraSystem` 独占拥有 `Camera`。

当 `CameraSystem` 析构时，成员 `camera_` 会自动析构，随后自动释放 `Camera`。

这就是 RAII 在类设计中的典型应用。

## shared_ptr 作为成员要更谨慎

例如：

```cpp
class Display {
private:
    std::shared_ptr<Frame> frame_;
};
```

这里表达的是：

> Display 也是 Frame 的一个 Owner。

即使 Frame Producer 已经释放自己的 `shared_ptr`，只要 Display 仍然持有 `frame_`，Frame 就不会销毁。

这可能正是我们想要的行为，也可能完全不是。

所以使用 `shared_ptr` 作为成员之前应该先确认：这个类是否真的应该参与被管理对象的生命周期。

如果只是临时访问对象，使用 `Frame*` 或 `Frame&` 往往更加准确。

## enable_shared_from_this

有时候一个已经被 `shared_ptr` 管理的对象，希望在成员函数中获得指向自己的 `shared_ptr`。

下面这种写法是危险的：

```cpp
class Camera {
public:
    std::shared_ptr<Camera> getSelf()
    {
        return std::shared_ptr<Camera>(this);
    }
};
```

假设：

```cpp
auto p1 = std::make_shared<Camera>();
auto p2 = p1->getSelf();
```

这可能形成两个完全独立的 Control Block，而它们都认为自己拥有同一个 Camera。最终两个 Control Block 都可能执行 `delete Camera`，造成 Double Free。

正确方式是使用：

```cpp
class Camera :
    public std::enable_shared_from_this<Camera>
{
public:
    std::shared_ptr<Camera> getSelf()
    {
        return shared_from_this();
    }
};
```

此时 `shared_from_this()` 会复用原来的 Control Block，而不是重新创建一套 Ownership。

## 不要重复用同一个 Raw Pointer 构造 shared_ptr

类似的问题还有：

```cpp
Camera* raw = new Camera();

std::shared_ptr<Camera> p1(raw);
std::shared_ptr<Camera> p2(raw);
```

虽然 `p1` 和 `p2` 都指向同一个 Camera，但它们分别拥有不同的 Control Block。

因此最终很可能发生两次 `delete Camera`。

正确做法应该是：

```cpp
auto p1 = std::make_shared<Camera>();
auto p2 = p1;
```

这样两个 `shared_ptr` 才会共享同一个 Control Block。

## 智能指针自身通常并不在 Heap

例如：

```cpp
void func()
{
    auto p = std::make_unique<Camera>();
}
```

这里的 `p` 本身是一个局部 C++ 对象，通常位于当前 Stack Frame 中，而它保存的 Pointer 指向动态分配的 Camera Object。

可以理解为：

```text
Stack
+------------------+
| unique_ptr p     |
| 保存一个 Pointer  |
+------------------+
        │
        ▼
Heap
+------------------+
| Camera Object    |
+------------------+
```

所以智能指针本身也是普通 C++ 对象，它可以位于 Stack、Heap、Global Object 或其他对象内部。真正由智能指针负责管理的是它所拥有的 Resource。

## RAII 不等于智能指针

这一点非常重要。

智能指针只是 RAII 的一种应用。

例如：

```cpp
std::lock_guard<std::mutex> lock(mutex);
```

也是非常典型的 RAII。

构造 `lock_guard` 时执行：

```cpp
mutex.lock();
```

离开作用域时，`lock_guard` 析构并自动执行：

```cpp
mutex.unlock();
```

所以：

```cpp
void func()
{
    std::lock_guard<std::mutex> lock(mutex);

    // critical section
}
```

即使中间发生 `return` 或异常，Mutex 仍然能够在对象析构时自动释放。

类似的还有 `std::fstream`，它在对象生命周期内管理文件资源。

因此 RAII 更准确地说是一种：

> 利用 C++ Object Lifetime 管理 Resource Lifetime 的设计模式。

## Rule of Three / Five / Zero

理解 RAII 以后，还需要继续理解 C++ 中非常重要的 Rule of Three、Rule of Five 和 Rule of Zero。

假设：

```cpp
class Buffer {
public:
    Buffer(size_t size)
    {
        data_ = new char[size];
    }

    ~Buffer()
    {
        delete[] data_;
    }

private:
    char* data_;
};
```

看起来已经自动管理资源了。

但如果：

```cpp
Buffer a(100);
Buffer b = a;
```

默认 Copy Constructor 只会复制 `data_` 这个 Pointer。

于是 `a.data_` 和 `b.data_` 会指向同一块内存。当两个对象分别析构时，就会对同一个地址执行两次 `delete[]`。

因此，一个类如果手工管理资源，就通常必须认真考虑：

```text
Destructor
Copy Constructor
Copy Assignment
Move Constructor
Move Assignment
```

这就是 Rule of Five。

更推荐的方式往往是：

```cpp
class Buffer {
private:
    std::unique_ptr<char[]> data_;
};
```

这样底层资源管理已经交给标准 RAII 类型处理，业务类自己就不需要重新手写复杂的 Destructor、Copy 或 Move 逻辑。

这就是 Rule of Zero。

现代 C++ 很重要的设计原则之一，就是尽量让资源管理交给成熟的 RAII 类型，让业务类本身只关心业务逻辑。

## 嵌入式 C++ 中的 RAII

RAII 在嵌入式中同样非常有价值，但不能简单理解成嵌入式开发应该大量使用 `shared_ptr`。

RAII 和 Dynamic Allocation 是两个完全不同的概念。

我们完全可以使用 RAII，但不使用 Heap。

例如：

```cpp
class InterruptGuard {
public:
    InterruptGuard()
    {
        disableInterrupts();
    }

    ~InterruptGuard()
    {
        enableInterrupts();
    }
};
```

使用：

```cpp
void updateRegisters()
{
    InterruptGuard guard;

    // critical operation
}
```

这里 `InterruptGuard` 本身就是一个 Stack Object，没有使用任何 `new` 或 `malloc()`，但仍然使用了 RAII：Constructor 负责关闭中断，Destructor 负责恢复中断。

所以：

> RAII 不等于 Dynamic Memory，也不等于 Smart Pointer。

RAII 是生命周期管理思想，而 Heap 只是资源来源之一。

## 嵌入式中使用智能指针需要考虑什么

在 Embedded Linux 用户态程序中，`unique_ptr` 和 `shared_ptr` 通常都可以正常使用。

但在资源受限或者具有严格实时要求的 MCU / RTOS 系统中，需要进一步考虑 Heap 是否允许动态分配、Allocator 是否可能产生碎片、`shared_ptr` Control Block 是否会引入额外 allocation、Atomic Reference Count 是否增加运行时开销，以及对象释放时间是否具有足够的确定性。

因此实时系统中经常会选择 Static Allocation、Memory Pool、Fixed-size Buffer Pool、Object Pool 等机制，然后在这些资源之上继续使用 RAII 管理生命周期。

## 自定义 RAII 封装

例如 Linux Camera 程序中，我们经常需要：

```cpp
int fd = open("/dev/video0", O_RDWR);
```

可以封装成：

```cpp
class FileDescriptor {
public:
    explicit FileDescriptor(int fd = -1)
        : fd_(fd)
    {
    }

    ~FileDescriptor()
    {
        if (fd_ >= 0) {
            close(fd_);
        }
    }

    FileDescriptor(const FileDescriptor&) = delete;
    FileDescriptor& operator=(const FileDescriptor&) = delete;

    FileDescriptor(FileDescriptor&& other) noexcept
        : fd_(other.fd_)
    {
        other.fd_ = -1;
    }

    FileDescriptor& operator=(FileDescriptor&& other) noexcept
    {
        if (this != &other) {
            if (fd_ >= 0) {
                close(fd_);
            }

            fd_ = other.fd_;
            other.fd_ = -1;
        }

        return *this;
    }

    int get() const
    {
        return fd_;
    }

private:
    int fd_;
};
```

这里的设计语义和 `unique_ptr` 非常接近：`FileDescriptor` 独占拥有 fd，禁止 Copy，允许 Move，并在 Destructor 中自动执行 `close()`。

这样：

```cpp
void capture()
{
    FileDescriptor fd(
        open("/dev/video0", O_RDWR)
    );

    // VIDIOC_QUERYCAP
    // VIDIOC_REQBUFS
    // ...
}
```

无论函数通过正常 `return`、错误路径还是异常退出，`fd` 都能够在析构时自动关闭。

同样的方式也可以封装 `mmap()`：

```cpp
class MappedBuffer {
public:
    MappedBuffer(void* addr, size_t length)
        : addr_(addr), length_(length)
    {
    }

    ~MappedBuffer()
    {
        if (addr_ != MAP_FAILED) {
            munmap(addr_, length_);
        }
    }

private:
    void* addr_;
    size_t length_;
};
```

这样 `MappedBuffer` 对象离开作用域时就会自动执行 `munmap()`。

## RAII 最终解决的是什么问题

没有 RAII 时，代码很容易变成：

```cpp
ResourceA a = acquireA();

if (...) {
    releaseA(a);
    return;
}

ResourceB b = acquireB();

if (...) {
    releaseB(b);
    releaseA(a);
    return;
}

ResourceC c = acquireC();

if (...) {
    releaseC(c);
    releaseB(b);
    releaseA(a);
    return;
}
```

随着资源越来越多，每一个错误路径都需要手工清理已经获得的资源。

而使用 RAII 后：

```cpp
void func()
{
    ResourceA a;
    ResourceB b;
    ResourceC c;

    ...
}
```

只需要保证每一个资源类自己的 Destructor 正确实现。

离开作用域时，对象会按照构造的逆序自动析构，所以 `c`、`b`、`a` 会依次释放对应资源。

因此 RAII 真正解决的是：

> Resource Cleanup 和复杂 Control Flow 之间的耦合问题。

我们不再需要在每一个 `return`、每一个错误分支和每一个异常路径中重复写 Cleanup Code。

## 总结

RAII 的核心思想是将 Resource Lifetime 绑定到 C++ Object Lifetime。对象构造时获得资源，对象析构时释放资源，因此资源清理不再依赖程序员手工维护所有退出路径。

智能指针只是 RAII 在动态内存上的一种标准实现。其中 `std::unique_ptr` 表示独占所有权，通常只有一个 Owner，并通过 Move Semantics 转移所有权；`std::shared_ptr` 通过 Control Block 和 Reference Count 实现共享所有权，最后一个 Owner 消失时才销毁对象；`std::weak_ptr` 不拥有对象，只观察 `shared_ptr` 所管理的资源，主要用于避免循环引用以及实现不会延长对象生命周期的观察关系。

从底层实现来看，`unique_ptr` 通常只需要保存一个 Pointer 和 Deleter，因此成本非常低；`shared_ptr` 还需要 Control Block，维护 Strong Count、Weak Count、Deleter 等信息，因此无论空间还是运行时成本都更高。`weak_ptr` 同样依赖 Control Block，但不会增加 Strong Reference Count。

在现代 C++ 中，如果对象有明确的单一 Owner，通常优先使用 `unique_ptr`；只有确实存在 Shared Ownership 时才使用 `shared_ptr`；如果只是观察一个由 `shared_ptr` 管理的对象而不希望延长其生命周期，则使用 `weak_ptr`。对于只是临时访问、不涉及所有权的接口，普通 Pointer 和 Reference 仍然是非常重要的工具。

更重要的是，我们不应该把 RAII 理解成“使用智能指针”，也不应该把智能指针理解成“避免写 `delete` 的语法糖”。RAII 真正改变的是资源管理方式：资源生命周期不再依赖手工 Cleanup，而是由 C++ 的构造、析构和作用域规则自动管理。

理解 RAII 以后，我们才能真正理解现代 C++ 为什么强调 Ownership、Move Semantics、Rule of Zero，以及为什么一个设计良好的 C++ 程序中往往很少直接出现裸 `new` 和 `delete`。
