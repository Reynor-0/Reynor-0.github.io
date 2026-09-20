---
title: '随笔(五)：内存'
description: '随手记录看到的一些知识点'
tags: ['C/C++']
series: { id: 'essay', order: 5 }
pubDate: 'Sep 5 2026'
---

## 内存分配

C/C++ 中存在很多内存分配方式，例如用户态常见的 `malloc`、`calloc`、`new`，以及 Linux 内核中的 `kmalloc`、`vmalloc`、`dma_alloc_coherent` 等。

这些接口表面上看起来都在做一件事：

> 给我一块内存。

但实际上，它们所处的层次、面向的对象、返回的地址类型以及底层依赖的内存管理机制都不一样。

在 Linux 用户态，可以先简单理解为：

```text
                        C / C++ 程序
                             │
             ┌───────────────┴────────────────┐
             │                                │
          自动对象                         动态对象
             │                                │
      编译器管理 Stack                 malloc / new
             │                                │
      调整 SP / 栈帧                     libc allocator
                                              │
                                  ┌───────────┴───────────┐
                                  │                       │
                               brk/sbrk                 mmap
                                  │                       │
                                  └───────────┬───────────┘
                                              │
                                         Linux Kernel
                                              │
                                         Virtual Memory
                                              │
                                      Page Table / Fault
                                              │
                                         Physical Page
```

而在 Linux 内核中，内存分配通常可以粗略理解为：

```text
                         Linux Kernel
                              │
                    Physical Page Allocator
                              │
                    PCP / Buddy System
                              │
             ┌────────────────┼────────────────┐
             │                │                │
          SLUB/SLAB         vmalloc          DMA API
             │                │                │
          kmalloc          虚拟连续       dma_alloc_coherent
          kzalloc          物理可散       dma_map_single
          kcalloc                          dma_map_sg
```

这里最重要的一点是：这些 API 并不是彼此独立的。`kmalloc` 往往建立在 SLUB/SLAB 分配器之上，而 SLUB/SLAB 底层仍然要向伙伴系统申请 page；`vmalloc` 同样需要向页分配器申请多个 page，只不过再通过页表将这些物理上不连续的页面映射成一段连续的内核虚拟地址。

因此，如果继续向下追，最终很多内核内存分配行为都会回到：

```text
Physical RAM
    ↓
Page Frame
    ↓
Buddy / Page Allocator
```

### malloc

```cpp
void *p = malloc(100);
```

这段代码通常不会直接进入 Linux Kernel 申请 100 Byte。

`malloc()` 是 C Library 提供的用户态动态内存分配接口。以 Linux 上常见的 glibc 为例，glibc 自己维护了一套内存分配器，它会从已经获得的大块内存中切出较小的 chunk，再返回给应用程序。

可以粗略理解为：

```text
Application
    │
    │ malloc(100)
    ▼
glibc allocator
    │
    ├── tcache 中有没有合适的 chunk？
    │
    ├── arena / free chunk 中有没有？
    │
    └── 都没有？
            │
            ▼
         brk / mmap
            │
            ▼
      Linux Virtual Memory
            │
            ▼
           VMA
            │
      第一次真正访问
            │
            ▼
        Page Fault
            │
            ▼
     Physical Page Allocator
            │
            ▼
        Physical RAM
```

也就是说，`malloc()` 更像一个位于用户态的“二级分配器”。

Linux Kernel 负责管理进程虚拟地址空间以及底层物理页，而 glibc 则负责把已经获得的大块地址空间进一步切分成用户程序所需要的几十字节、几百字节或者几 KB 的 allocation。

如果每一次：

```cpp
malloc(32);
```

都需要陷入内核进行一次系统调用，那么小块内存的频繁申请开销会非常大。因此 glibc 会提前管理较大的区域，然后自己进行 chunk 的切分、复用和合并。

#### tcache、arena 和 chunk

现代 glibc 中，小块 allocation 经常首先从线程本地的 `tcache` 中获取。

例如：

```text
malloc(32)
    ↓
检查当前线程 tcache
    ↓
有合适的 free chunk
    ↓
直接返回
```

这样甚至不需要访问其他线程共享的 allocator 数据结构。

如果 `tcache` 无法满足请求，则会继续进入 arena 中寻找空闲 chunk。arena 内部又会维护各种不同尺寸的 free chunk，以减少每一次申请都进入内核的需要。

因此，从应用层看只是：

```cpp
void *p = malloc(100);
```

但实际可能完全没有系统调用。

#### brk 与传统 Heap

当 glibc 已经管理的空间不够时，其中一种方式是扩展传统的 process heap。

Linux 进程中有一个 `program break`，可以简单理解为传统 heap 的边界：

```text
低地址

.text
.rodata
.data
.bss

-------------------
       Heap
-------------------
         ↑
   program break

      未使用区域

-------------------

高地址
```

allocator 可以通过 `brk()` 等机制扩展这片区域：

```text
原来的 Heap：

+------------------+
| allocator memory |
+------------------+
        ↑
       brk


扩大后：

+------------------+
| allocator memory |
|                  |
|  new area        |
+------------------+
        ↑
       brk
```

不过需要注意：

> `malloc` 并不等价于“从 `[heap]` 中分配”。

现代 glibc 对较大的 allocation 还可能直接使用匿名 `mmap()`。

例如：

```cpp
void *p = malloc(16 * 1024 * 1024);
```

这块 16 MB 内存可能获得一个单独的 anonymous mapping，而不是不断扩大传统 heap。

因此更准确的表述应该是：

> `malloc()` 分配的是动态存储，其底层可能来自 glibc 已经管理的 arena，也可能进一步通过 `brk` 或匿名 `mmap` 向内核获得更多虚拟地址空间。

#### malloc 成功不代表物理内存已经全部分配

还有一个非常重要的概念：

```cpp
void *p = malloc(1024 * 1024 * 1024ULL);
```

假设这里成功返回了 1 GB 的虚拟地址空间，并不代表 Linux 立刻拿出了完整的 1 GB Physical RAM。

Linux 使用虚拟内存和 Demand Paging。很多情况下，首先只是建立了一段合法的虚拟地址范围。

当程序真正访问：

```cpp
memset(p, 0, size);
```

时，每访问到一个尚未建立物理映射的 page，都可能产生 Page Fault。

随后 Kernel 才会：

```text
Page Fault
    ↓
Page Allocator
    ↓
找到 Physical Page
    ↓
更新 Page Table
    ↓
重新执行指令
```

因此：

```text
malloc 成功
```

和：

```text
所有对应 Physical Page 已经准备完成
```

并不是同一件事。

#### free

```cpp
free(p);
```

同样不意味着这块物理内存一定立即归还 Linux Kernel。

例如某个 128 Byte chunk 被释放以后：

```text
Application
    ↓
free()
    ↓
glibc allocator
    ↓
放回 tcache / free list
```

glibc 很可能暂时保留这块空间，以便下一次 `malloc()` 继续复用。

因此即使程序已经调用：

```cpp
free(p);
```

也不一定会立即看到进程的 RSS 明显下降。

对于一些通过独立 `mmap()` 得到的大 allocation，allocator 则更容易通过 `munmap()` 直接把对应 mapping 还给内核。

---

### calloc 和 realloc

`calloc()` 与 `malloc()` 的区别主要是：

```cpp
void *p = calloc(count, size);
```

会申请：

```text
count * size
```

字节，并将返回区域初始化为 0。

例如：

```cpp
int *array = static_cast<int *>(calloc(100, sizeof(int)));
```

得到的 100 个 `int` 初始值都为 0。

此外，`calloc(count, size)` 还能够对 `count * size` 的乘法溢出进行处理，因此对于数组分配通常比直接：

```cpp
malloc(count * size);
```

更安全。

`realloc()` 用于调整已有 allocation 的大小：

```cpp
p = realloc(p, new_size);
```

allocator 可能直接扩大原来的 chunk，也可能找到另一块更大的区域，将原数据复制过去以后释放旧区域，因此 `realloc()` 后返回地址可能发生变化。

---

## malloc 和 new 的根本区别

`malloc()` 解决的是原始存储问题。

例如：

```cpp
void *p = malloc(sizeof(Camera));
```

它的含义只是：

> 给我一块至少能够容纳 `Camera` 的 raw storage。

它不知道 `Camera` 是什么，也不知道：

```cpp
Camera::Camera();
Camera::~Camera();
```

这些构造和析构过程。

而：

```cpp
Camera *camera = new Camera();
```

关注的是 C++ Object Lifetime。

其过程可以简单理解成：

```text
new Camera()
    │
    ├── operator new(sizeof(Camera))
    │           ↓
    │      获取 raw storage
    │
    └── Camera::Camera()
                ↓
             构造对象
```

也就是：

```text
new
=
allocation
+
construction
```

释放时：

```cpp
delete camera;
```

可以理解为：

```text
Camera::~Camera()
       ↓
operator delete()
```

也就是：

```text
delete
=
destruction
+
deallocation
```

在常见 Linux C++ Runtime 中，默认的 global `operator new` 最终往往会利用底层 C allocator 获取内存，但：

> C++ 标准并没有要求 `operator new` 必须通过 `malloc()` 实现。

例如我们可以自己重载：

```cpp
void *operator new(std::size_t size)
{
    // 自定义 allocator
}
```

因此不能简单地写成：

```text
new = malloc
```

更准确的是：

```text
new-expression
      ↓
operator new
      ↓
获得 raw storage
      ↓
调用 constructor
```

---

## 内核态

Linux Kernel 本身并不使用普通用户态 libc：

```c
malloc();
printf();
pthread_mutex_lock();
```

这些都是用户空间运行库接口。

Linux Kernel 有自己的内存管理系统。在最底层，可以先简单理解为：

```text
Physical RAM
    ↓
Page Frame
    ↓
Page Allocator
    ↓
PCP / Buddy System
```

Kernel 会把 Physical RAM 按 page 管理，例如一个典型系统：

```text
PAGE_SIZE = 4 KB
```

每个 Physical Page Frame 都由内核的数据结构进行管理。

### Buddy System

伙伴系统主要用于解决：

> 如何从物理内存中分配连续的若干个 Page？

例如：

```text
order = 0
→ 2^0 个 page
→ 1 page

order = 1
→ 2^1 个 page
→ 2 pages

order = 2
→ 2^2 个 page
→ 4 pages
```

假设：

```text
PAGE_SIZE = 4 KB
```

那么：

```text
order 0 → 4 KB
order 1 → 8 KB
order 2 → 16 KB
order 3 → 32 KB
```

伙伴系统会把较大的连续 page block 拆分成两个 buddy block：

```text
Order 3

+--------------------------------+
|              32 KB             |
+--------------------------------+

                 ↓ split

+----------------+----------------+
|     16 KB      |      16 KB     |
+----------------+----------------+
     buddy A            buddy B
```

如果后续两个 buddy 都被释放，还可以重新合并成更大的 block。

因此 Buddy System 非常适合页级别的物理内存分配，但并不适合直接服务：

```text
32 Byte
64 Byte
128 Byte
```

这种小对象。

如果为了一个 64 Byte 的对象直接申请一个 4 KB Page，会造成大量浪费。

所以 Linux 又在 Buddy Allocator 之上建立了 SLAB/SLUB 分配器。

---

## SLAB / SLUB

SLAB/SLUB 的目标是：

> 在已经得到的 Page 上进一步切分出大量小对象。

Linux 现在常见的是 SLUB。

例如某个 4 KB Page：

```text
+------------+
| Object 0   |
+------------+
| Object 1   |
+------------+
| Object 2   |
+------------+
| Object 3   |
+------------+
| ...        |
+------------+
```

如果某种对象大小是 64 Byte，那么一个 page 中就可以存放大量 64 Byte object slot。

因此可以把这几个层次理解为：

```text
Physical RAM
    ↓
Buddy Allocator
    ↓
Page / Page Block
    ↓
SLUB
    ↓
Small Object
```

`kmalloc()` 就主要建立在这一层之上。

---

### kmalloc

```c
void *p = kmalloc(size, GFP_KERNEL);
```

可以理解为：

> 给 Kernel 申请一块适合普通内核对象使用的内存。

例如：

```c
kmalloc(50, GFP_KERNEL);
```

allocator 不一定真的只分配 50 Byte，它可能选择最接近的 size class，例如：

```text
64 Byte
```

因此：

```text
Requested = 50 Byte
Actually occupied slot = 64 Byte
```

其中多出来的 14 Byte 就属于一种 internal fragmentation。

但使用固定 size class 可以显著降低小对象频繁分配和释放的成本。

可以将 `kmalloc()` 的典型路径理解为：

```text
kmalloc(50)
    ↓
选择 kmalloc size class
    ↓
例如 64 Byte
    ↓
SLUB Cache
    ↓
找到一个空闲 object slot
    ↓
返回 Kernel Virtual Address
```

如果当前 slab 中没有足够空间：

```text
SLUB
 ↓
向 Page Allocator 请求更多 Page
 ↓
Buddy System
 ↓
Physical Page
```

因此：

> `kmalloc` 和 Buddy System 并不是竞争关系，而是上下层关系。

`kmalloc` 面向的是 Byte/Object，Buddy 面向的是 Page。

#### kmalloc 返回地址与物理连续性

`kmalloc()` 返回的是 Kernel Virtual Address。

对于普通 `kmalloc` allocation，它对应的 RAM 通常来自 kernel linear/direct mapping，底层物理空间具有连续性语义。

可以简单理解为：

```text
Kernel Virtual Address

0xffff800010000000
0xffff800010001000
0xffff800010002000

          ↓ direct mapping

Physical Address

0x41000000
0x41001000
0x41002000
```

这也是 `kmalloc()` 和 `vmalloc()` 一个非常重要的区别。

但需要注意：

> “`kmalloc` 对应物理连续内存”不等于“可以直接把这个地址交给 DMA Device”。

涉及 DMA 时，仍然应该通过 Linux DMA API 获取 Device 能够使用的 DMA Address。

#### 大块 kmalloc 为什么容易失败

例如：

```c
kmalloc(16 * 1024 * 1024, GFP_KERNEL);
```

可能失败，即使系统还有几百 MB Free Memory。

原因在于：

```text
Total Free Memory 很多
```

不代表：

```text
存在一整块足够大的 Physical Contiguous Memory
```

例如：

```text
Physical RAM

[USED][FREE][USED][FREE][FREE][USED][FREE][USED]
```

此时空闲页总量可能很多，但已经发生 external fragmentation。

如果申请最终需要高阶连续 Page Block，Buddy Allocator 可能无法提供。

所以：

> 小型 Kernel 对象适合使用 `kmalloc()`；大块内存如果不要求物理连续，应更多考虑 `vmalloc()` 或 `kvmalloc()`。

---

### kzalloc 和 kcalloc

`kzalloc()` 可以简单理解为：

```text
kmalloc
+
zero initialization
```

例如：

```c
struct device_data *data;

data = kzalloc(sizeof(*data), GFP_KERNEL);
```

这样得到的结构体所有 bit 初始都会被清零。

`kcalloc()` 更适合数组：

```c
int *array;

array = kcalloc(100, sizeof(int), GFP_KERNEL);
```

可以理解为 Kernel 版本的：

```c
calloc()
```

此外还有：

```c
kmalloc_array();
```

用于安全地进行数组尺寸计算，但不会自动清零。

---

### vmalloc

```c
void *p = vmalloc(16 * 1024 * 1024);
```

`vmalloc()` 解决的是另一类问题：

> 我需要一大块连续的 Kernel Virtual Address，但不要求对应 Physical Page 连续。

它仍然需要向底层 Page Allocator 请求 Page，只是这些 Page 可以位于任意物理地址。

例如：

```text
Physical Pages:

Page 100
Page 8
Page 721
Page 42
```

这些 Page 在 Physical RAM 中完全不连续。

随后 Kernel 会创建页表映射：

```text
Kernel VA

0xffff0000 → Physical Page 100
0xffff1000 → Physical Page 8
0xffff2000 → Physical Page 721
0xffff3000 → Physical Page 42
```

于是 CPU 看到的却是一段：

```text
0xffff0000
0xffff1000
0xffff2000
0xffff3000
```

连续的虚拟地址。

也就是说：

```text
              vmalloc

Kernel Virtual Address

+--------+--------+--------+--------+
| Page 0 | Page 1 | Page 2 | Page 3 |
+--------+--------+--------+--------+
     │        │        │        │
     ▼        ▼        ▼        ▼

Physical Memory

 Page100   Page8   Page721   Page42
```

这里的连续性是通过：

```text
Page Table
+
MMU
```

实现的。

#### kmalloc 和 vmalloc 的根本区别

可以简单理解：

```text
kmalloc

Kernel VA:
[0][1][2][3]

Physical:
[100][101][102][103]

物理基本连续
```

而：

```text
vmalloc

Kernel VA:
[0][1][2][3]

Physical:
[100][8][721][42]

只有虚拟连续
```

因此：

| 特性                     | `kmalloc`       | `vmalloc`          |
| ---------------------- | --------------- | ------------------ |
| Kernel Virtual Address | 连续              | 连续                 |
| Physical Memory        | 连续语义            | 可以不连续              |
| 页表额外映射                 | 通常依赖 direct map | 需要专门建立映射           |
| 适合                     | 小/中型对象          | 大块 CPU-only Buffer |
| 大块分配成功率                | 较低              | 较高                 |
| DMA 直接使用               | 仍应通过 DMA API    | 不能简单直接 DMA         |

由于 `vmalloc()` 要额外建立 Page Table Mapping，因此访问和管理成本通常比普通 `kmalloc` 更高。

---

### kvmalloc

如果：

```text
我希望小块的时候尽量使用 kmalloc，
但内存大了也允许退化为 vmalloc。
```

可以使用：

```c
void *p = kvmalloc(size, GFP_KERNEL);
```

它可以简单理解成：

```text
先尝试 kmalloc
    │
    ├── 成功
    │    ↓
    │   return
    │
    └── 失败
          ↓
       vmalloc
          ↓
        return
```

因此 `kvmalloc()` 返回的内存不能假设物理连续。

对应释放接口通常使用：

```c
kvfree(p);
```

---

### alloc_pages

如果需要直接操作 Page Allocator，可以使用：

```c
struct page *page;

page = alloc_pages(GFP_KERNEL, order);
```

这里不再是：

```text
给我 N Byte
```

而是：

```text
给我 2^order 个连续 Physical Page
```

例如：

```text
PAGE_SIZE = 4 KB

order = 0 → 4 KB
order = 1 → 8 KB
order = 2 → 16 KB
```

因此 `alloc_pages()` 更接近 Buddy Allocator 本身。

可以将整个关系理解为：

```text
                    Physical RAM
                         │
                         ▼
                  Buddy Allocator
                         │
            ┌────────────┴────────────┐
            │                         │
       alloc_pages                 SLUB/SLAB
                                      │
                                      ▼
                                   kmalloc
```

而 `vmalloc()` 则会：

```text
vmalloc
   ↓
请求多个 page
   ↓
这些 page 物理上可以分散
   ↓
建立新的 Page Table Mapping
   ↓
形成连续 Kernel VA
```

---

### kmem_cache_alloc

如果内核模块需要频繁分配大量完全相同的对象，例如：

```c
struct request {
    ...
};
```

可以创建专门的 slab cache：

```c
kmem_cache_create(...);
```

然后使用：

```c
kmem_cache_alloc(...);
kmem_cache_free(...);
```

例如：

```text
request cache

+----------+----------+
| request0 | request1 |
+----------+----------+
| request2 | request3 |
+----------+----------+
```

相比每次直接调用：

```c
kmalloc(sizeof(struct request));
```

专用 cache 能够更好地复用对象空间，同时减少一些 allocator 管理开销。

---

### 上下文问题

用户态调用：

```c
malloc(size);
```

通常不需要告诉 allocator：

> 我当前允许不允许 Sleep？

但 Linux Kernel 必须考虑执行上下文。

所以：

```c
kmalloc(size, GFP_KERNEL);
```

需要提供 `GFP Flags`。

最常见：

```c
GFP_KERNEL
```

表示：

> 当前处于正常 Kernel Context，允许分配器在必要的时候进行 reclaim，并允许睡眠。

例如：

```c
void probe(...)
{
    p = kmalloc(size, GFP_KERNEL);
}
```

通常没有问题。

而在某些不能 sleep 的上下文，例如硬中断：

```c
irqreturn_t irq_handler(...)
{
    ...
}
```

不能随意：

```c
kmalloc(size, GFP_KERNEL);
```

因为内存分配过程可能睡眠。

这类情况下某些场景会使用：

```c
GFP_ATOMIC
```

其目标是：

> 不通过可能睡眠的普通 reclaim 路径等待内存。

但 `GFP_ATOMIC` 并不是“更快的 `GFP_KERNEL`”，它使用范围更加受限，分配成功率也可能更低。

因此 Linux Kernel 中进行内存分配时，不仅要问：

```text
我要多少 Byte？
```

还要问：

```text
我现在是什么执行上下文？
```

---

## DMA 内存

DMA 内存和普通 Kernel allocation 解决的问题并不完全相同。

`kmalloc()`、`vmalloc()` 主要站在 CPU 的角度思考：

> CPU 如何获得一块内存？

而 DMA API 要同时考虑：

```text
CPU
+
Device
```

因此：

```c
dma_alloc_coherent()
```

不能简单理解成另外一个版本的 `kmalloc()`。

### dma_alloc_coherent

```c
void *cpu_addr;
dma_addr_t dma_addr;

cpu_addr = dma_alloc_coherent(dev,
                              size,
                              &dma_addr,
                              GFP_KERNEL);
```

这次调用会得到两个地址：

```text
cpu_addr
    ↓
CPU 使用

dma_addr
    ↓
Device DMA 使用
```

Linux DMA API 中：

```text
CPU Virtual Address
Physical Address
DMA Address
```

是三个需要区分的概念。

例如存在 IOMMU 时：

```text
CPU
 │
 │ CPU Virtual Address
 ▼
MMU
 │
 ▼
Physical RAM
 ▲
 │
IOMMU
 ▲
 │
DMA / IOVA
 ▲
 │
Device
```

可能：

```text
CPU VA = 0xffff800012340000
PA     = 0x4A000000
DMA    = 0x90000000
```

三个值完全不同。

所以驱动中：

```text
拿到了一个 Kernel Pointer
```

绝不等于：

```text
这个 Pointer 可以直接写进 Device DMA Address Register
```

正确做法应该通过 DMA API 获取 `dma_addr_t`。

---

### coherent

DMA 场景还需要考虑 CPU Cache。

例如：

```text
CPU
 │
 ▼
Cache
 │
 ▼
RAM
 ▲
 │
DMA Device
```

如果 CPU：

```text
写入新数据
↓
数据还停留在 Cache
```

而 Device 直接从 RAM 读取，就可能看到旧值。

反过来：

```text
Device 写入 RAM
```

但 CPU Cache 中还有旧数据，CPU 也可能看到过期内容。

`dma_alloc_coherent()` 提供的是 coherent DMA memory，目标是让 CPU 和 Device 可以按照 coherent DMA 语义共同访问这块内存，而无需驱动在每一次普通访问前后显式执行 Cache Clean/Invalidate。

但：

> Cache Coherency 不等于 Memory Ordering。

例如：

```c
desc->addr = dma_addr;
desc->length = 4096;
desc->owner = DEVICE_OWN;
```

Device 应当先看到：

```text
addr
length
```

再看到：

```text
owner = DEVICE_OWN
```

这属于内存访问顺序问题，即使 Descriptor 位于 coherent memory，也仍然可能需要 DMA API 所要求的 Memory Barrier。

因此需要区分：

```text
Cache Coherency
    ↓
CPU 与 Device 是否看到相同的数据

Memory Ordering
    ↓
CPU 与 Device 以什么顺序观察多个内存访问
```

---

### dma_alloc_coherent 适合什么

`dma_alloc_coherent()` 很适合 CPU 和 Device 长期共享的小型控制结构，例如：

```text
DMA Descriptor
Descriptor Ring
Command Queue
Control Block
```

例如一个 RX Ring：

```text
CPU                           Device

desc[0] <------------------> DMA
desc[1] <------------------> DMA
desc[2] <------------------> DMA
desc[3] <------------------> DMA
```

双方会长期访问，因此 coherent memory 很适合这种场景。

---

### Streaming DMA

对于 Camera Frame、Network Packet 等大量数据，并不一定适合全部使用：

```c
dma_alloc_coherent()
```

Linux 还提供 Streaming DMA Mapping：

```c
dma_map_single();
dma_unmap_single();
```

例如已经有一个 CPU Buffer：

```c
void *buf;

buf = kmalloc(size, GFP_KERNEL);
```

在 Device 使用之前：

```c
dma_addr_t dma_addr;

dma_addr = dma_map_single(dev,
                          buf,
                          size,
                          DMA_TO_DEVICE);
```

得到 Device 可以使用的 DMA Address。

DMA 完成以后：

```c
dma_unmap_single(dev,
                 dma_addr,
                 size,
                 DMA_TO_DEVICE);
```

整个流程可以理解为：

```text
CPU Buffer
    ↓
dma_map_single()
    ↓
DMA Address
    ↓
Device DMA
    ↓
dma_unmap_single()
```

对于非连续多个 Buffer，还存在：

```c
dma_map_sg();
dma_unmap_sg();
```

也就是 Scatter-Gather DMA。

因此：

> `kmalloc()` 得到的 Buffer 可以用于 DMA，但应通过 DMA API 将它映射成 Device 能够使用的 DMA Address，而不是自己简单通过 `virt_to_phys()` 获得物理地址以后直接写入设备寄存器。

DMA API 还需要考虑：

```text
DMA Mask
IOMMU
Cache Coherency
SWIOTLB / Bounce Buffer
```

这些平台相关细节。

---

## CMA

在 Camera、Video Codec、Display 等多媒体场景中，经常还会看到：

```text
CMA
Contiguous Memory Allocator
```

CMA 主要用于帮助 Linux 满足大块连续物理内存需求。

例如一帧图像：

```text
3840 × 2160 × 2 Byte
≈ 16 MB
```

如果准备四个 Buffer，就可能需要几十 MB 的内存。

系统运行一段时间后，普通 Physical Memory 很可能已经发生严重碎片化，此时再临时寻找几十 MB 连续 Page 会非常困难。

CMA 会管理一片适合后续进行连续内存分配的区域。例如：

```text
Physical RAM

+---------------------------+
| Normal Memory             |
|                           |
+---------------------------+
| CMA Managed Region        |
|                           |
| 可整理得到大块连续 Pages   |
|                           |
+---------------------------+
```

但驱动通常不应该把 CMA 当成：

```text
另一个 malloc()
```

直接到处调用。

在 V4L2、DRM、Codec 等框架中，通常会通过：

```text
DMA API
VB2
DMA-BUF
```

等更高层机制管理 Buffer，底层是否使用 CMA 则由具体 allocator 和平台决定。

---

## Camera Buffer 中不同地址的关系

Camera 是理解 Linux 内存管理和 DMA 最好的例子之一。

例如：

```text
IMX415
  ↓
MIPI CSI
  ↓
RKISP
  ↓
DMA
  ↓
DDR Buffer
```

同一块 Frame Buffer 在不同模块眼中可能具有不同的地址：

```text
Userspace
    │
    │ User Virtual Address
    ▼
+----------------------+
|                      |
|     Frame Buffer     |
|                      |
+----------------------+
    ▲
    │ Kernel Mapping
Kernel
    ▲
    │
Physical Pages
    ▲
    │ IOMMU Mapping
    ▲
DMA Address / IOVA
    ▲
    │
RKISP
```

因此同一块 Buffer 可能同时具有：

```text
User Virtual Address
Kernel Virtual Address
Physical Page
DMA Address / IOVA
DMA-BUF fd
```

这些值描述的是：

> 同一块底层存储在不同地址空间、不同模块中的表示。

所以在驱动开发中不能建立：

> 一个 Buffer 就只有一个地址。

这样的心智模型。

---

## 总结

将用户态和内核态放到一起，可以简单归纳为：

| API                  | 所处层次      | CPU 得到什么             | 底层特点                           | 典型用途              |
| -------------------- | --------- | -------------------- | ------------------------------ | ----------------- |
| 局部自动变量               | Compiler  | User VA              | Stack Frame / SP               | 函数局部对象            |
| `malloc`             | libc      | User VA              | allocator，后端可能为 `brk/mmap`     | C 动态内存            |
| `calloc`             | libc      | User VA              | `malloc` 类似机制 + zero           | 数组                |
| `new`                | C++       | `T*`                 | allocation + constructor       | C++ 对象            |
| `kmalloc`            | Kernel    | Kernel VA            | SLUB + Buddy，物理连续语义            | 小型 Kernel Object  |
| `kzalloc`            | Kernel    | Kernel VA            | `kmalloc` + zero               | Driver Structure  |
| `kcalloc`            | Kernel    | Kernel VA            | Array + zero                   | Kernel Array      |
| `vmalloc`            | Kernel    | Kernel VA            | VA 连续，Physical Page 可分散        | 大块 CPU Buffer     |
| `kvmalloc`           | Kernel    | Kernel VA            | `kmalloc` → `vmalloc` fallback | 大块通用分配            |
| `alloc_pages`        | Kernel MM | `struct page*`       | `2^order` Physical Pages       | 页级管理              |
| `kmem_cache_alloc`   | SLUB      | Kernel VA            | 固定尺寸 Object Cache              | 高频同类对象            |
| `dma_alloc_coherent` | DMA API   | CPU VA + DMA Address | Coherent DMA                   | Descriptor / Ring |
| `dma_map_single`     | DMA API   | DMA Address          | 映射已有 CPU Buffer                | Streaming DMA     |
| `dma_map_sg`         | DMA API   | SG DMA Mapping       | Scatter-Gather                 | 大块数据              |

最终可以把整个 Linux 内存分配体系串成：

```text
用户态：

Local Variable
    ↓
Stack / SP

malloc / new
    ↓
glibc allocator
    ↓
tcache / arena / chunk
    ↓
brk / mmap
    ↓
Virtual Memory
    ↓
Page Fault
    ↓
Physical Page


内核态：

Physical RAM
    ↓
Buddy / Page Allocator
    ↓
┌──────────────┬──────────────┐
│              │              │
SLUB         vmalloc       DMA API
│              │              │
kmalloc      Page Table     DMA Mapping
kzalloc      Remapping      IOMMU
kcalloc                     Coherency
```

从这个角度来看，`malloc`、`kmalloc`、`vmalloc` 和 `dma_alloc_coherent` 并不是简单的“不同内存分配函数”，而是分别服务于不同的内存管理层次：

```text
malloc
→ 用户态动态内存管理

kmalloc
→ Kernel Small Object Allocation

vmalloc
→ Kernel Virtual Contiguous Memory

dma_alloc_coherent
→ CPU / Device Shared DMA Memory
```

真正理解这些 API 的关键，不是记住函数名字，而是每次看到一个 Buffer 时都去思考：

```text
这个地址属于哪个 Address Space？

CPU 看到的是 Virtual Address 还是 Physical Address？

底层 Physical Page 是否连续？

Device 看到的是 Physical Address 还是 DMA / IOVA？

CPU 和 Device 之间是否需要 Cache Synchronization？

当前执行上下文是否允许 Sleep？
```

把这些问题想清楚，Linux 下绝大多数内存分配 API 的设计逻辑就能够串起来了。
