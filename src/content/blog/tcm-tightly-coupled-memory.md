---
title: 'TCM：紧耦合 CPU 内存学习笔记'
description: '整理 Tightly Coupled Memory 的基本概念、和 Cache/SRAM 的区别、典型使用场景、多核 TCM 地址别名机制以及软件开发中的注意事项。'
pubDate: 'Jul 02 2026'
---

## 1. TCM 是什么

TCM 是 **Tightly Coupled Memory** 的缩写，通常翻译为**紧耦合内存**。它是一块和 CPU 核心连接非常紧密的片上存储区域，目标是提供**低延迟、确定性强、可预测**的访问路径。

和普通外部 DDR 或带 Cache 的存储路径相比，TCM 的重点通常不是容量，而是：

- 访问延迟低；
- 访问路径短；
- 时序更可预测；
- 适合实时系统中的关键代码和关键数据。

可以简单理解为：

```text
TCM = CPU 核心旁边的一块高速片上 SRAM
```

但更准确地说：

```text
TCM 不是一种新的存储介质，而是一种面向 CPU 实时访问路径设计的片上内存区域。
```

TCM 通常仍然由 SRAM 实现，但不是所有 SRAM 都是 TCM。判断一块内存是不是 TCM，关键不在于它是不是 SRAM，而在于它是否通过专门的紧耦合接口连接到 CPU，并且能提供确定性的低延迟访问。

---

## 2. 为什么需要 TCM

在很多嵌入式系统、汽车 ECU、实时控制系统中，程序不仅关心“平均性能”，还非常关心“最坏情况下的执行时间”。

例如一个控制环路要求每 1ms 执行一次，那么我们关心的不只是：

```text
平均一次执行 0.2ms
```

还要关心：

```text
最坏一次会不会超过 1ms
```

Cache 可以显著提升平均性能，但它的问题是访问时间不完全确定。一次内存访问可能命中 Cache，也可能发生 miss；可能只是几个周期，也可能因为从外部内存取数、总线仲裁、Cache 替换、预取、写回等因素变得更慢。

而 TCM 的价值在于：

- 访问延迟更稳定；
- 不依赖 Cache 是否命中；
- 适合放置实时性要求高的代码和数据；
- 更容易分析最坏执行时间；
- 适用于中断处理、控制环路、启动代码、调度器数据、任务栈等关键路径。

一句话理解：

```text
Cache 追求平均性能，TCM 追求确定性。
```

---

## 3. TCM 和 Cache 的区别

| 对比项 | TCM | Cache |
| --- | --- | --- |
| 管理方式 | 软件、链接脚本或启动代码显式管理 | 硬件自动缓存 |
| 是否有明确地址 | 有，位于处理器地址空间中 | 通常对软件透明 |
| 延迟特点 | 通常更确定 | 命中快，miss 慢 |
| 适用目标 | 实时性、确定性、低延迟 | 平均性能、吞吐量 |
| 数据放置 | 开发者决定哪些代码/数据进 TCM | 硬件根据访问行为决定 |
| 容量 | 通常较小 | 取决于 Cache 层级 |
| 多核一致性 | 需要结合架构处理 | 可能由 Cache coherency 硬件处理，也可能需要软件维护 |

举一个直观例子：

```text
Cache 像是 CPU 桌面上的临时资料，硬件自动决定放什么；
TCM 像是 CPU 旁边的专用抽屉，软件明确决定放什么。
```

Cache 的优势是方便、自动、提升平均性能；TCM 的优势是可控、稳定、适合实时路径。

---

## 4. TCM 和 SRAM 的关系

TCM 通常由片上 SRAM 实现，所以很多时候我们会看到类似说法：

```text
TCM 是一块片上 SRAM
```

这个说法不算错，但容易让人误解。

更准确的理解是：

```text
SRAM 是存储介质；
TCM 是一种特殊访问路径和特殊地址区域下的 SRAM。
```

普通片上 SRAM 可能挂在系统总线上：

```text
CPU -> 总线/互连 -> SRAM
```

TCM 则更贴近 CPU 核心：

```text
CPU Core -> TCM Port -> TCM SRAM
```

所以 TCM 的核心特点不是“它是 SRAM”，而是：

```text
它与 CPU 连接得更紧，访问路径更短，访问时间更可预测。
```

---

## 5. TCM 的常见分类：ITCM、DTCM、ATCM/BTCM/CTCM

在一些处理器中，TCM 会分成指令和数据两类：

- **ITCM**：Instruction TCM，用于放置关键代码；
- **DTCM**：Data TCM，用于放置关键数据。

这种设计可以让取指和数据访问走不同路径，减少相互干扰。

例如：

```text
CPU 取指令 -> ITCM
CPU 读写数据 -> DTCM
```

在一些 Cortex-R 系列处理器中，也可能看到：

- **ATCM**
- **BTCM**
- **CTCM**

这类命名通常表示不同的 TCM bank 或 TCM port。具体每一块 TCM 的用途、大小、地址映射方式，需要结合芯片手册和工程 linker script 来看。

---

## 6. 软件如何使用 TCM

软件通常通过两类方式把代码或数据放入 TCM：

1. 在代码中用 section 属性标记；
2. 在链接脚本中把对应 section 放到 TCM MEMORY 区域。

例如：

```c
__attribute__((section(".itcm")))
void fast_isr_handler(void)
{
    // time-critical code
}

__attribute__((section(".dtcm")))
static uint8_t critical_buffer[1024];
```

链接脚本中可能有类似配置：

```ld
MEMORY
{
    TCM_CODE (rx)  : ORIGIN = 0x00040000, LENGTH = 64K
    TCM_DATA (rw)  : ORIGIN = 0x00050000, LENGTH = 64K
}

SECTIONS
{
    .itcm :
    {
        *(.itcm)
        *(.itcm.*)
    } > TCM_CODE

    .dtcm :
    {
        *(.dtcm)
        *(.dtcm.*)
    } > TCM_DATA
}
```

最终可以通过 map 文件确认符号是否真的进入了 TCM。

例如：

```text
TCM_CODE  0x00040000  0x00010000
TCM_DATA  0x00050000  0x00010000
```

如果某个函数或变量的地址落在这些区域内，说明它被链接到了对应的 TCM 区域。

---

## 7. 适合放进 TCM 的内容

适合放进 TCM 的内容通常有以下几类：

- 高频中断处理函数；
- 实时控制算法；
- 启动早期必须执行的代码；
- 调度器关键数据；
- 每核任务栈；
- 中断栈；
- 小型高频访问 buffer；
- 对执行时间抖动非常敏感的代码或数据。

不太适合放进 TCM 的内容包括：

- 大型日志缓冲；
- 大体积图像或视频帧；
- 低频访问数据；
- 普通业务逻辑；
- 可以接受 Cache miss 的数据；
- 大型查表数据；
- 多核频繁共享且需要一致性的全局变量。

原因很简单：TCM 容量通常比较小，应该留给真正影响实时性的路径。

---

## 8. 多核系统中的 TCM：每个核可能有自己的 TCM

在多核实时处理器中，经常是每个核心都有自己的 TCM。

例如：

```text
Core0 -> Core0 TCM
Core1 -> Core1 TCM
Core2 -> Core2 TCM
Core3 -> Core3 TCM
```

这时要特别注意一个概念：

```text
每个核心的 TCM 通常是 core-local 的。
```

也就是说，Core0 的 TCM 和 Core1 的 TCM 不是同一块物理内存。

如果在每个核心的 TCM 中都定义一个同名变量：

```c
uint32_t xxx;
```

那么可能实际存在的是：

```text
Core0 TCM 中的 xxx
Core1 TCM 中的 xxx
Core2 TCM 中的 xxx
Core3 TCM 中的 xxx
```

它们是不同的物理存储单元，不会自动同步。

所以多核 TCM 的一个重要原则是：

```text
TCM 很适合放每核私有数据；
TCM 不一定适合放真正的多核共享数据。
```

---

## 9. TCM 地址别名：本地地址和全局地址

这是多核 TCM 中最容易混淆的部分。

在一些多核架构中，同一块 TCM 可能同时有两种地址视图：

1. **本核本地地址**；
2. **系统全局地址**。

以一个四核系统为例，假设每个核心都有自己的 CTCM：

```text
Core0 CTCM global base = 0x11200000
Core1 CTCM global base = 0x11600000
Core2 CTCM global base = 0x11A00000
Core3 CTCM global base = 0x11E00000
```

同时，每个核心运行时都可以通过同一个本地地址窗口访问“自己的 CTCM”：

```text
Local CTCM base = 0x00500000
```

那么会出现如下关系：

```text
Core0 访问 0x00500000 -> Core0 自己的 CTCM
Core1 访问 0x00500000 -> Core1 自己的 CTCM
Core2 访问 0x00500000 -> Core2 自己的 CTCM
Core3 访问 0x00500000 -> Core3 自己的 CTCM
```

从系统全局视角看，它们又分别对应：

```text
Core0 local 0x00500000 -> global 0x11200000
Core1 local 0x00500000 -> global 0x11600000
Core2 local 0x00500000 -> global 0x11A00000
Core3 local 0x00500000 -> global 0x11E00000
```

可以画成：

```text
CPU0 视角：
0x00500000 + offset  ->  Core0 CTCM
0x11200000 + offset  ->  Core0 CTCM 的系统全局地址

CPU1 视角：
0x00500000 + offset  ->  Core1 CTCM
0x11600000 + offset  ->  Core1 CTCM 的系统全局地址

CPU2 视角：
0x00500000 + offset  ->  Core2 CTCM
0x11A00000 + offset  ->  Core2 CTCM 的系统全局地址

CPU3 视角：
0x00500000 + offset  ->  Core3 CTCM
0x11E00000 + offset  ->  Core3 CTCM 的系统全局地址
```

这里的 `0x00500000` 就是一种**本地地址别名**，也可以理解为 **core-local alias**。

---

## 10. `0x00500000` 是共享地址吗？

不是。

这一点非常重要。

虽然每个核心都能访问 `0x00500000`，但它不是一块真正的多核共享内存。

更准确地说：

```text
0x00500000 是每个核心访问“自己 TCM”的统一本地入口。
```

也就是说：

```text
Core0 的 0x00500000 != Core1 的 0x00500000
```

它们数值相同，但访问请求来自不同核心时，硬件会根据“当前是哪个核心发起访问”选择对应核心自己的 TCM。

这和普通共享 RAM 完全不同。

真正的共享 RAM 应该是：

```text
Core0 访问地址 X -> 同一块物理内存
Core1 访问地址 X -> 同一块物理内存
Core2 访问地址 X -> 同一块物理内存
Core3 访问地址 X -> 同一块物理内存
```

而 TCM 本地别名更像是：

```text
Core0 访问 0x00500000 -> Core0 私有 TCM
Core1 访问 0x00500000 -> Core1 私有 TCM
Core2 访问 0x00500000 -> Core2 私有 TCM
Core3 访问 0x00500000 -> Core3 私有 TCM
```

因此，不要把 `0x00500000` 这类地址简单理解成“公共地址”。

它更应该被理解为：

```text
每核统一的私有 TCM 逻辑地址。
```

---

## 11. 为什么要设计 TCM 本地别名

假设没有本地别名，每个核心想访问自己的 TCM，就可能需要写成：

```c
void *get_local_stack(void)
{
    uint32_t core_id = get_core_id();

    if (core_id == 0) {
        return (void *)0x112078C0;
    } else if (core_id == 1) {
        return (void *)0x116078C0;
    } else if (core_id == 2) {
        return (void *)0x11A078C0;
    } else {
        return (void *)0x11E078C0;
    }
}
```

这样的问题是：

- 每次都要判断当前 core；
- 代码和核心数量强绑定；
- 热路径上多了分支；
- 容易写错地址；
- 同一份代码难以在多个核心上复用；
- 不利于实现 per-core 数据。

有了本地 TCM 别名之后，可以直接写成：

```c
void *get_local_stack(void)
{
    return (void *)0x005078C0;
}
```

这段代码在 Core0 上执行，访问 Core0 的 TCM；在 Core1 上执行，访问 Core1 的 TCM。

所以本地别名的一个直接好处确实是避免：

```c
if (core0) {
    ...
} else if (core1) {
    ...
}
```

但它的意义不止于此。

更完整地说，本地别名的目的包括：

- 让所有核心可以运行同一份代码；
- 实现每核私有数据；
- 简化 RTOS 内核、调度器、任务栈的访问；
- 保持本核访问 TCM 的低延迟路径；
- 减少软件分支和地址判断；
- 同时保留系统全局地址，方便 DMA、调试器或其他核心访问指定核心的 TCM。

---

## 12. 本地地址和全局地址什么时候用

可以按照下面的原则判断。

| 场景 | 应该使用的地址 |
| --- | --- |
| 当前核心访问自己的任务栈 | 本地 TCM 地址，例如 `0x005xxxxx` |
| 当前核心访问自己的调度器数据 | 本地 TCM 地址 |
| 当前核心访问自己的中断栈 | 本地 TCM 地址 |
| 当前核心访问自己的 per-core 变量 | 本地 TCM 地址 |
| Core0 想访问 Core1 的 TCM | Core1 的全局 TCM 地址，例如 `0x116xxxxx` |
| DMA 初始化某个核心的 TCM | 目标核心的全局 TCM 地址 |
| 调试器查看某个核心的栈 | 目标核心的全局 TCM 地址 |
| 多个核心共同访问同一份变量 | 共享 SRAM / LMU / IPC RAM 地址 |
| 每个核心各自保存一份同名变量 | 本地 TCM 地址 |

一句话总结：

```text
本核自己的东西，用本地 TCM 地址；
明确访问某个核心的 TCM，用该核心全局地址；
真正多核共享的数据，放共享 RAM，不要误放到 per-core TCM。
```

---

## 13. 结合 map 文件理解 CORE0_TCM_C / CORE1_TCM_C

假设 map 文件中有如下内容：

```text
CORE0_TCM_C  0x11200000  0x10000
CORE1_TCM_C  0x11600000  0x10000
CORE2_TCM_C  0x11a00000  0x10000
CORE3_TCM_C  0x11e00000  0x10000
```

这说明链接器从系统全局视角为每个核心的 CTCM 分配了独立区域。

例如：

```text
Core0 CTCM: 0x11200000 ~ 0x1120FFFF
Core1 CTCM: 0x11600000 ~ 0x1160FFFF
Core2 CTCM: 0x11A00000 ~ 0x11A0FFFF
Core3 CTCM: 0x11E00000 ~ 0x11E0FFFF
```

如果 map 文件里还有：

```text
.fast_task_stack.CPU0  0x112078c0  0x3000
.fast_task_stack.CPU1  0x116078c0  0x3800
.fast_task_stack.CPU2  0x11a078c0  0x4800
.fast_task_stack.CPU3  0x11e078c0  0x2800
```

则说明每个核心的任务栈被放到了各自的 CTCM 中。

以 CPU0 为例：

```text
g_kerneltimermgr_c0_stack_buf  0x112078c0  0x800
g_hptimermgr_c0_stack_buf      0x112080c0  0x800
g_comt_high_0_c0_stack_buf     0x112088c0  0x800
g_comt_low_0_c0_stack_buf      0x112090c0  0x800
g_comt_medium_0_c0_stack_buf   0x112098c0  0x1000
```

这些栈是连续排列的：

```text
0x112078C0 ┌────────────────────────────┐
           │ kernel timer stack 0x800   │
0x112080C0 ├────────────────────────────┤
           │ hp timer stack     0x800   │
0x112088C0 ├────────────────────────────┤
           │ comt high stack    0x800   │
0x112090C0 ├────────────────────────────┤
           │ comt low stack     0x800   │
0x112098C0 ├────────────────────────────┤
           │ comt medium stack  0x1000  │
0x1120A8C0 └────────────────────────────┘
```

总大小为：

```text
0x800 + 0x800 + 0x800 + 0x800 + 0x1000 = 0x3000
```

这正好对应：

```text
.fast_task_stack.CPU0 size = 0x3000
```

如果 CPU0 运行时通过本地别名访问这些栈，那么对应关系可以理解为：

```text
global address = 0x112078C0
local alias    = 0x005078C0
offset         = 0x78C0
```

换算公式为：

```text
offset = global_address - core_global_tcm_base
local  = local_tcm_base + offset
```

对于 CPU0：

```text
offset = 0x112078C0 - 0x11200000
       = 0x78C0

local  = 0x00500000 + 0x78C0
       = 0x005078C0
```

对于 CPU1：

```text
offset = 0x116078C0 - 0x11600000
       = 0x78C0

local  = 0x00500000 + 0x78C0
       = 0x005078C0
```

注意，CPU0 和 CPU1 的本地地址数值都可以是 `0x005078C0`，但物理上分别访问的是自己的 TCM。

---

## 14. TCM 里放任务栈是否合理

任务栈非常适合放在 TCM 中，尤其是在实时系统或 AUTOSAR OS 中。

原因包括：

- 任务切换时频繁访问栈；
- 中断和异常处理会使用栈；
- 栈访问路径越稳定，系统实时性越好；
- 每个核心通常只使用自己的任务栈；
- 栈天然属于每核私有数据。

例如：

```text
CPU0 使用 CPU0 的 task stack
CPU1 使用 CPU1 的 task stack
CPU2 使用 CPU2 的 task stack
CPU3 使用 CPU3 的 task stack
```

正常情况下，CPU0 不应该随意访问 CPU1 的任务栈。其他核心访问某核心任务栈的合理场景通常是：

- 启动阶段初始化；
- 调试器读取栈；
- crash dump；
- 安全监控核检查栈溢出；
- 故障诊断时保存现场。

业务运行过程中，任务栈应该由所属核心独占使用。

---

## 15. 真正的共享变量应该放在哪里

如果有一个变量需要所有核心读写同一份值，例如：

```c
uint32_t vehicle_speed;
```

不要因为每个核心都能访问 `0x005xxxxx`，就把它放在本地 TCM 别名区域。

如果这样做，结果很可能是：

```text
Core0 读写的是 Core0 TCM 里的 vehicle_speed
Core1 读写的是 Core1 TCM 里的 vehicle_speed
Core2 读写的是 Core2 TCM 里的 vehicle_speed
Core3 读写的是 Core3 TCM 里的 vehicle_speed
```

也就是说，每个核心各有一份副本，它们不会自动一致。

真正的多核共享变量应该放到：

- 共享 SRAM；
- LMU；
- IPC RAM；
- 片上共享 RAM；
- DDR 中的 non-cacheable 共享区；
- 操作系统明确管理的共享内存区域。

结构应该是：

```text
Core0 ─┐
Core1 ─┤
Core2 ─┼──> shared_data：同一份物理内存
Core3 ─┘
```

然后再配合：

- 原子操作；
- spinlock；
- mutex；
- 内存屏障；
- mailbox；
- 核间中断；
- 双缓冲；
- 生产者-消费者队列。

地址放对了，只能说明多个核心访问的是同一块物理内存；并不自动保证访问顺序、原子性和一致性。

因此，判断一个变量应该放在哪里，可以先问自己三个问题：

```text
1. 这个变量是每个核心各自一份，还是所有核心共享一份？
2. 它是否处在实时关键路径上？
3. 它是否需要跨核同步或一致性保证？
```

如果答案是“每个核心各自一份，并且实时性要求高”，适合放入每核 TCM。

如果答案是“所有核心必须看到同一份数据”，更适合放到共享 SRAM / LMU / IPC RAM，并使用同步机制。

一句话总结：

```text
per-core 私有数据适合放 TCM；
真正共享数据应该放共享内存；
TCM 地址别名不能替代多核同步机制。
```