---
title: '随笔(四)：volatile'
description: '随手记录看到的一些知识点'
tags: ['C/C++', 'volatile']
series: { id: 'essay', order: 4 }
pubDate: 'Sep 1 2026'
---

# Volatile

Volatile主要解决的是“编译器不能随意省略或者合并某些访问”的问题。

假设有一个变量：
```cpp
int flag = 0;
void wait()
{
    while(flag == 0)
    {
        // do nothing
    }
}
```
可以看出这里的意图就是只要flag为0，就一直等待。但是编译器可能会这样去做优化
> 在这个循环里面，我没有看到任何代码修改 flag。既然第一次读到的是 0，为什么还要每次都重新读取？
于是，代码可能优化成类似以下的行为：
```cpp
if (flag == 0)
{
    while(true)
    {

    }
}
```
也就是只知道flag为0，就一直等待。如果我们原先期望某个外部硬件、信号处理函数等等会修改这个值，那么这种编译器的优化就会与预期想要实现的功能冲突。

## Volatie告诉编译器什么

这里我们将变量声明为volatile：
```cpp
volatile int flag = 0;

void wait()
{
    while(flag == 0)
    {
        // do nothing
    }
}
```
编译器就不会自作主张去优化。可以理解为;
> 每次对这个对象的 volatile 访问都具有必须保留的可观察意义，编译器不能仅仅因为它认为值没变，就把这些访问随意省略、合并或替换成一次缓存读取。

## Volatile能不能保证线程安全？

**不能！**

假设有:
```c
volatile int counter = 0;
```
有两个线程同时执行:
```c
counter++;
```
那就有产生竞态的风险。`counter++` 操作实际上包含三个步骤：读取 counter 的值，将该值加 1，然后将结果写回 counter。这三个步骤不是原子操作，因此在多线程环境下可能会出现竞态条件。
```
load counter
counter + 1
store counter
```
两个线程可能这样交错：
```
初始 counter = 0

Thread A                  Thread B

load counter = 0
                          load counter = 0

计算 0 + 1
                          计算 0 + 1

store counter = 1
                          store counter = 1
```
最后`counter = 1`，但单从逻辑上期望的值，应该是`counter = 2`。

## std::atomic

如果只是原子计数：
```cpp
#include <atomic>

std::atomic<int> counter{0};

void increment()
{
    counter.fetch_add(1, std::memory_order_relaxed);
}
```
这里的 fetch_add 是原子读-改-写操作，不会发生两个线程都读到旧值后覆盖彼此结果的问题。

如果要发布数据，可以使用 acquire/release：
```cpp
#include <atomic>

int data = 0;
std::atomic<bool> ready{false};
```
生产者：
```cpp
void producer()
{
    data = 100;

    ready.store(true, std::memory_order_release);
}
```
消费者：
```cpp
void consumer()
{
    while (!ready.load(std::memory_order_acquire)) {
    }

    // 如果读取到了生产者发布的 true，
    // 就能观察到 release 之前对 data 的写入。
    std::cout << data;
}
```
这里真正建立同步的是：
```
data = 100
    ↓
release store
    ↓
acquire load 观察到对应的值
    ↓
读取 data
```
而不是 volatile。`std::atomic` 提供的是语言标准认可的并发语义，编译器会根据 x86、ARM 等具体架构生成合适的指令或屏障。

## 为什么寄存器经常使用volatile?

因为 MMIO 有一个特点：
> 某些内存地址并不对应普通 RAM，而是被映射成硬件寄存器。对这些地址的读取或写入，本身就是一次硬件操作。
例如某个MCU外设有：
```
0x4000 0000 -> STATUS 寄存器
0x4000 0004 -> CONTROL 寄存器
0x4000 0008 -> DATA 寄存器
```
CPU 执行：
```c
value = *reg;
```
可能不是在读取普通变量，而是在向总线发起一次外设寄存器读取。而寄存器的值可能被硬件独立改变，我们这里假设:
```cpp
#define STATUS_REG (*reinterpret_cast<volatile std::uint32_t*>(0x40000000))
```
硬件定义了bit0 为1的时候DMA完成，为0的时候DMA未完成。这时候软件通过以下逻辑来判断；
```cpp
while ((STATUS_REG & 0x01) == 0)
{
    ...
}
```
硬件可能在某个时刻DMA完成了，自动把STATUS_REG的bit 0设置为1了。这个变化不是 C++ 代码执行赋值造成的。如果没有 volatile，编译器可能认为循环中没有修改该地址的代码，于是把寄存器读取优化成一次。而使用 volatile 后，编译器必须保留每次寄存器访问。

# 指针和引用

C++中，指针(pointer)和引用(reference)都可以间接访问另一个对象，但他们的语义有明显的不同。最核心的区别就是:
> 指针是一个保存地址的对象，可以改变指向；引用是一个已有对象的别名，初始化后不能改为引用另一个对象。

## 一个最基本的例子
```cpp
// 指针
int a = 10;
int* p = &a;
*p = 20;

p      // 指针本身，值是地址
*p     // 解引用，访问 p 指向的对象
```
这里p保存的是a的地址。`*p=20`实际上是修改的a。
```cpp
int a = 10;
int& ref = a;
ref = 20;
```
这里 ref 是 a 的别名。
```
a ─────┐
       ├── 同一个 int 对象
ref ───┘
```
因此：
```cpp
ref = 20;
```
也是修改 a。引用不需要像指针一样写 *ref，直接使用引用名就相当于使用原对象。

## 区别
- 指针可以改变指向，引用不能重新绑定
- 指针可以为空，引用必须绑定到有效对象
- 引用本身不是一个独立的对象
- 引用不能直接形成“引用的引用”

## 函数参数中，指针和引用有什么区别？

1. 值传递
```cpp
void modify(int x)
{
    x = 100;
}

int a = 10;
modify(a);

//结果a还是等于10，因为函数修改的是副本
```

2. 指针传递
```cpp
void modify(int* p)
{
    *p = 100;
}

int a = 10;
modify(&a);

//结果a变成了100，因为函数修改的是指针指向的对象
```

3. 引用传递
```cpp
void modify(int& ref)
{
    ref = 100;
}

int a = 10;
modify(a);

//结果a变成了100，因为函数修改的是引用的对象
```

## 什么时候使用指针，什么时候使用引用？

现代 C++ 中，一个很实用的原则是：

> 必须存在一个对象、且不需要重新指向时，优先考虑引用；需要表达“可能没有对象”或“可以改变指向”时，使用指针。

例如：
```cpp
void process(Camera& camera);
```
表示调用者必须提供一个 Camera 对象。而：
```cpp
void process(Camera* camera);
```
可以表达：camera 可能为空，函数内部需要判断。
```cpp
void process(Camera* camera)
{
    if (camera == nullptr) {
        return;
    }

    camera->start();
}
```
当然，指针也常用于数组、动态内存、底层地址操作、C API 和硬件寄存器等场景。

## 引用还有一个重要能力：绑定临时对象

普通非 const 左值引用：
```cpp
int& ref = 10; // ❌
```
不能直接绑定到这个临时整数。但 const 引用可以：
```cpp
const int& ref = 10; // ✅
```
C++ 会让临时对象的生命周期延长到这个引用的生命周期结束（在这种直接绑定的场景下）。例如：
```cpp
const std::string& str = std::string("hello");
```
这是合法的。而：
```cpp
std::string& str = std::string("hello");
```
通常不允许，因为非 const 左值引用不能直接绑定这样的临时对象。这也是 const T& 非常灵活的原因之一。

## 野指针和悬空指针

野指针是指没有被初始化的指针，或者指向已经被释放的内存的指针。悬空指针是指指向已经被释放的内存的指针，但仍然被使用。这两种情况都可能导致程序崩溃或未定义行为。

```cpp
int *p;
*p = 10; //undefined behavior

int* p = new int(10);
delete p;
*p = 20; //undefined behavior: use after freee
```

## 悬空指针不一定是因为delete
只要对象生命周期结束，原先指向它的指针就可能悬空。

1. 返回局部变量的地址
```cpp
int* getValue()
{
    int value = 100;
    return &value;
}

int* p = getValue();
std::cout << *p << std::endl; //undefined behavior
```

原因是：
```
getValue() 调用

Stack frame
+----------------+
| value = 100    |
+----------------+
       ↑
       │
       p

函数返回
    ↓
value 生命周期结束
    ↓
p 仍保存旧地址
    ↓
悬空指针
```
即使那块栈内存里的数值暂时还是 100，也不能继续访问，因为对象已经不存在了。

2. 指向的局部对象离开作用域
```cpp
int* p = nullptr;

{
    int a = 10;
    p = &a;
}

// a 生命周期结束
*p = 20;  // 未定义行为
```
这里没有使用 new 或 delete，但 p 依然悬空。

3. 容器扩容导致地址失效

这在封装 V4L2 BufferQueue 时尤其需要注意：
```cpp
std::vector<int> values;
values.reserve(1);

values.push_back(10);

int* p = &values[0];

values.push_back(20);  // 可能触发扩容

std::cout << *p;       // 如果发生重分配，p 已悬空
```
当 `std::vector` 扩容时，可能把元素搬到新的内存区域，并释放旧存储。

## 如何排查野指针和悬空指针？

在 Linux 应用程序中，非常推荐 AddressSanitizer：
```bash
g++ -g -O1 -fsanitize=address -fno-omit-frame-pointer main.cpp -o app
```
运行：
```bash
./app
```
它可以帮助检测：
```
heap-use-after-free
stack-use-after-return（依赖编译器/运行时配置）
heap-buffer-overflow
stack-buffer-overflow
double-free
```
例如使用释放后的指针，ASan 往往能给出分配、释放和错误访问的调用栈。
