---
title: 'ARM基础知识整理'
description: '系统整理 ARM 架构、处理器模式、寄存器、指令、寻址方式、异常、中断以及异常向量表等基础内容。'
pubDate: 'Jul 07 2026'
heroImage: '../../assets/blog-placeholder-4.jpg'
---

## ARM 架构是什么

ARM 是一种非常常见的处理器架构，全称最初来自 Advanced RISC Machine。现在我们通常说的 ARM，既可能指 ARM 指令集架构，也可能指 ARM 公司设计的一系列 CPU 内核，还可能泛指使用 ARM 内核的 SoC 或 MCU。

在学习时需要先区分几个概念：

```text
ARM 架构：一种指令集架构，例如 ARMv7、ARMv8、ARMv9
ARM 内核：具体 CPU 核心，例如 Cortex-A53、Cortex-R5、Cortex-M4
SoC/MCU：芯片厂商基于 ARM 内核做出的完整芯片，例如 STM32、NXP i.MX、TI TDA4、车规 MCU 等
```

也就是说，ARM 公司通常不直接卖最终芯片，而是授权架构或 CPU 内核给芯片厂商。芯片厂商再把 CPU、内存控制器、外设、总线、中断控制器、Flash、SRAM、DDR 控制器等模块集成在一起，形成最终的芯片。

ARM 的核心思想是 RISC，也就是 Reduced Instruction Set Computer，精简指令集计算机。RISC 并不是说指令数量一定很少，而是说指令设计相对规整、执行路径清晰、很多操作倾向于在寄存器中完成。

ARM 常见特点包括：

- 指令格式相对规整；
- 寄存器数量较多；
- 大多数计算在寄存器中完成；
- 内存访问主要通过 load/store 指令；
- 支持多种工作模式或异常级别；
- 支持异常、中断、权限隔离；
- 支持 Thumb / Thumb-2 指令集以提高代码密度；
- 在嵌入式、车载、手机、服务器、MCU 中都有广泛应用。

### Load/Store 架构

ARM 很重要的特点就是 load/store 架构。

它的含义是：普通算术逻辑指令不能直接操作内存中的数据。CPU 通常需要先把内存中的数据加载到寄存器中，在寄存器中完成计算，最后再把结果写回内存。

例如 C 语言中有这样一句：

```c
memory_a = memory_b + memory_c;
```

从高级语言角度看，它似乎是直接把内存中的 `memory_b` 和 `memory_c` 相加，然后写入 `memory_a`。但在 ARM 这类 load/store 架构中，底层通常会拆成类似下面的过程：

```asm
LDR r0, [r1]      ; 从 r1 指向的内存地址读取数据到 r0
LDR r2, [r3]      ; 从 r3 指向的内存地址读取数据到 r2
ADD r4, r0, r2    ; 在寄存器中完成加法
STR r4, [r5]      ; 把结果写回 r5 指向的内存地址
```

其中：

```text
LDR：load register，从内存加载到寄存器
STR：store register，从寄存器存储到内存
ADD：寄存器之间做加法
```

这和 x86 这类 CISC 架构有明显区别。x86 中很多指令可以直接带内存操作数，而 ARM 通常要求先 load 到寄存器，再进行计算。

在嵌入式开发中，这个特点很重要。因为访问外设寄存器、本地 SRAM、DDR、TCM、Flash 时，最终都要通过 load/store 指令体现。

---

## ARM 架构、内核、芯片之间的关系

很多初学者会把 ARMv7、Cortex-A53、STM32、i.MX6、芯片、开发板这些概念混在一起。可以这样理解：

```text
ARMv7 / ARMv8 / ARMv9：架构版本
Cortex-A / Cortex-R / Cortex-M：ARM 官方提供的 CPU 内核系列
STM32 / NXP i.MX / TI / 瑞萨 / 英飞凌芯片：厂商基于 ARM 内核做出的芯片
开发板：把芯片、电源、晶振、接口、存储器等外围电路做在 PCB 上
```

例如：

```text
STM32F407：
    使用 Cortex-M4 内核
    属于 ARMv7-M 架构
    常用于 MCU、裸机、RTOS 场景

NXP i.MX6：
    使用 Cortex-A 系列内核
    属于应用处理器
    可以运行 Linux

Cortex-R5：
    面向实时控制
    常见于车载、工业控制、安全实时系统
```

所以，当我们说“学习 ARM”时，最好先明确是在学习哪一层：

```text
学习 ARM 指令集：关注寄存器、指令、寻址、异常模型
学习 Cortex-M：关注 NVIC、MSP/PSP、向量表、裸机/RTOS
学习 Cortex-A：关注 MMU、Cache、Linux、异常级别、GIC
学习 Cortex-R：关注实时性、TCM、MPU、锁步核、安全机制
```

---

## ARM 的几个 Profile

ARM 为不同应用场景设计了不同的 Profile。最常见的是 Cortex-A、Cortex-R、Cortex-M。

| Profile | 典型处理器 | 主要应用 |
| --- | --- | --- |
| Cortex-A | A53、A55、A76、A78、A510 等 | Linux、Android、车机、应用处理器 |
| Cortex-R | R5、R52、R82 等 | 实时系统、汽车 ECU、安全控制 |
| Cortex-M | M0、M3、M4、M7、M33 等 | MCU、裸机、RTOS、低功耗嵌入式 |

简单理解为：

```text
Cortex-A：Application，应用处理器，通常跑 Linux / Android
Cortex-R：Real-time，实时处理器，强调确定性和安全性
Cortex-M：Microcontroller，微控制器，常用于 MCU
```

### Cortex-A

Cortex-A 面向高性能应用处理器，常见于手机芯片、车机 SoC、网关、嵌入式 Linux 平台等。

Cortex-A 的典型特点：

- 性能强；
- 支持 MMU；
- 支持虚拟内存；
- 支持用户态和内核态隔离；
- 支持复杂 Cache 层级；
- 支持多核 SMP；
- 通常运行 Linux、Android、QNX 等操作系统。

其中 MMU 是 Memory Management Unit，内存管理单元。它可以把虚拟地址转换为物理地址，并配合操作系统实现进程隔离、权限控制、页表映射等功能。

例如在 Linux 中，用户程序看到的是虚拟地址。不同进程可以看到相同的虚拟地址，但它们实际映射到不同的物理内存。这就是 MMU 和操作系统配合实现的效果。

Cortex-A 的缺点是系统复杂，Cache、MMU、总线、DDR、中断路由都会影响实时性。因此它适合做高性能通用计算，但如果需要极强确定性，往往还会配合 Cortex-R 或 MCU 使用。

### Cortex-R

Cortex-R 面向实时系统，常用于汽车、工业控制、磁盘控制器、安全控制等场景。

Cortex-R 的典型特点：

- 强调实时性；
- 中断响应更确定；
- 常见 TCM；
- 常见 MPU；
- 支持锁步核；
- 常用于功能安全相关场景。

这里的 TCM 是 Tightly Coupled Memory，紧耦合内存。它通常是一块和 CPU 内核连接非常紧密的片上存储区域。访问 TCM 的延迟低，而且时间更确定。相比 DDR + Cache，TCM 的容量通常更小，但实时性更好。

这里的 MPU 是 Memory Protection Unit，内存保护单元。MPU 和 MMU 不同。MMU 主要负责虚拟地址到物理地址的转换，常用于 Linux 这类复杂操作系统；MPU 通常不做虚拟地址转换，而是对若干内存区域设置访问权限，例如某段内存只读、某段内存不可执行、某段内存仅特权模式可访问等。

Cortex-R 常用于这种场景：

```text
控制周期必须稳定
中断响应时间必须可预测
某些安全关键任务不能被普通任务破坏
需要 TCM 保存关键代码和数据
```

例如车载底盘控制、制动控制、转向控制、电机控制等场景，就非常关注最坏情况下的响应时间。

### Cortex-M

Cortex-M 面向 MCU，也就是微控制器。它常用于裸机程序、FreeRTOS、Zephyr、ThreadX 等轻量级系统。

Cortex-M 的典型特点：

- 功耗低；
- 成本低；
- 系统结构相对简单；
- 通常使用 Thumb / Thumb-2 指令；
- 使用 NVIC 管理中断；
- 异常入口硬件自动压栈；
- 非常适合中小型嵌入式控制场景。

Cortex-M 和 Cortex-A 的思路差异很大。Cortex-A 更像“可以跑完整操作系统的应用处理器”，而 Cortex-M 更像“直接控制外设和实时任务的微控制器”。

例如 STM32、GD32、NXP LPC、Nordic nRF 等常见 MCU，大多都是 Cortex-M 系列。

---

## ARM 寄存器基础

CPU 执行程序时，最核心的资源之一就是寄存器。寄存器可以理解为 CPU 内部最快的一小组存储单元。

### ARMv7-A/R 常见寄存器

在经典 ARMv7-A/R 中，常见通用寄存器包括：

| 寄存器 | 含义 |
| --- | --- |
| r0 ~ r12 | 通用寄存器 |
| r13 | SP，Stack Pointer，栈指针 |
| r14 | LR，Link Register，链接寄存器 |
| r15 | PC，Program Counter，程序计数器 |
| CPSR | Current Program Status Register，当前程序状态寄存器 |
| SPSR | Saved Program Status Register，异常模式下保存异常前状态 |

其中比较重要的是：

```text
SP：指向当前栈顶
LR：函数返回地址或异常返回地址
PC：当前程序执行位置
CPSR：保存条件标志位、中断屏蔽位、当前模式等状态
SPSR：发生异常时保存异常前的 CPSR
```

例如函数调用时，`BL function` 会把返回地址放入 LR，然后跳转到 function。函数返回时，常见做法是把 LR 的值恢复到 PC。

```asm
BL my_function     ; 跳转到 my_function，同时把返回地址保存到 LR
BX LR              ; 从函数返回
```

### ARMv8-A AArch64 常见寄存器

ARMv8-A 在 AArch64 状态下使用 64 位寄存器：

| 寄存器 | 含义 |
| --- | --- |
| x0 ~ x30 | 64 位通用寄存器 |
| w0 ~ w30 | x0 ~ x30 的低 32 位视图 |
| SP | 栈指针 |
| PC | 程序计数器 |
| PSTATE | 当前处理器状态 |
| ELR_ELx | 异常返回地址 |
| SPSR_ELx | 异常前状态 |
| VBAR_ELx | 异常向量表基地址 |
| ESR_ELx | 异常原因 |
| FAR_ELx | 访问异常地址 |

例如：

```text
ELR_EL1：进入 EL1 异常时保存返回地址
SPSR_EL1：保存异常发生前的 PSTATE
ESR_EL1：记录异常类型和原因
FAR_EL1：如果是访问异常，记录出错地址
```

这些寄存器在分析 Linux kernel panic、data abort、instruction abort 时非常重要。

---

## ARM 的模式

ARM 的“模式”指 CPU 当前处于什么运行状态、具有什么权限、使用哪些寄存器、如何响应异常。

不同 ARM 架构版本的模式并不完全一样。例如：

```text
ARMv7-A/R：使用 Processor Mode
Cortex-M：使用 Thread Mode / Handler Mode
ARMv8-A AArch64：使用 Exception Level，也就是 EL0 ~ EL3
```

### 经典 ARMv7-A/R 的处理器模式

在 ARMv7-A/R 中，常见处理器模式包括：

| 模式 | 英文 | 作用 |
| --- | --- | --- |
| User | usr | 普通用户模式，权限最低 |
| System | sys | 特权模式，但寄存器组类似 User |
| Supervisor | svc | 操作系统内核、SVC 异常进入 |
| IRQ | irq | 普通中断模式 |
| FIQ | fiq | 快速中断模式 |
| Abort | abt | 访问异常模式 |
| Undefined | und | 未定义指令异常模式 |
| Monitor | mon | TrustZone 安全监控模式 |
| Hyp | hyp | 虚拟化 Hypervisor 模式 |

这些模式的一个重要特点是：部分模式有自己的 banked register，也就是“影子寄存器”。

例如 IRQ 模式有自己的 `SP_irq` 和 `LR_irq`。当 CPU 从普通模式切换到 IRQ 模式时，不需要立即把原来的 SP、LR 保存到内存，因为 IRQ 模式可以使用自己独立的一组 SP、LR。

FIQ 模式拥有更多 banked registers，因此它可以减少保存现场的开销，适合低延迟中断场景。

### Cortex-M 的模式

Cortex-M 不使用 ARMv7-A/R 那套复杂的模式，而是简化为两种基本模式：

| 模式 | 含义 |
| --- | --- |
| Thread Mode | 普通程序运行模式 |
| Handler Mode | 异常或中断处理模式 |

简单理解：

```text
main()、普通任务、普通业务代码：Thread Mode
中断服务函数、HardFault_Handler、SysTick_Handler：Handler Mode
```

Cortex-M 还区分特权级：

```text
Privileged：特权级，可以访问所有系统资源
Unprivileged：非特权级，访问受限
```

裸机程序通常一直运行在特权级；RTOS 中可能会让普通任务运行在非特权级，以增强隔离能力。

### MSP 和 PSP 是什么

MSP 和 PSP 是 Cortex-M 中非常重要但初学者容易忽略的概念。

Cortex-M 有两个栈指针：

| 名称 | 全称 | 作用 |
| --- | --- | --- |
| MSP | Main Stack Pointer | 主栈指针 |
| PSP | Process Stack Pointer | 进程栈指针 |

简单理解：

```text
MSP：常用于异常、中断、系统启动阶段
PSP：常用于普通任务，尤其是 RTOS 中的线程/任务栈
```

Cortex-M 复位后默认使用 MSP。也就是说，芯片刚启动时，CPU 会从向量表第 0 项读取初始 MSP 值，然后从向量表第 1 项读取 Reset_Handler 地址，开始执行启动代码。

例如 Cortex-M 向量表的前两个表项通常是：

```c
__attribute__((section(".isr_vector")))
const void *vector_table[] = {
    &_estack,        // 初始 MSP 值
    Reset_Handler,   // 复位处理函数地址
};
```

这里的 `_estack` 就是初始主栈栈顶地址。

在没有 RTOS 的裸机程序中，通常一直使用 MSP 就足够了。

但在 RTOS 中，情况会更复杂。RTOS 通常希望每个任务都有自己的独立任务栈。如果所有任务都使用 MSP，就不方便进行任务切换。因此常见做法是：

```text
异常和中断使用 MSP
普通任务使用 PSP
```

这样设计的好处是：

```text
中断栈和任务栈分离
每个任务可以有自己的 PSP
PendSV 进行任务切换时可以保存和恢复 PSP
异常处理仍然使用稳定的 MSP
```

例如 FreeRTOS 在 Cortex-M 上进行任务切换时，经常会借助 PendSV 异常。每个任务都有自己的栈，当前任务的栈顶位置保存在 PSP 中。任务切换时，RTOS 保存当前 PSP，再恢复下一个任务的 PSP。

可以简单理解为：

```text
MSP：系统栈、中断栈
PSP：任务栈、线程栈
```

这并不是强制唯一用法，但这是 Cortex-M + RTOS 中非常典型的设计。

### ARMv8-A AArch64 的异常级别

在 ARMv8-A 的 AArch64 状态下，使用 Exception Level：

| 异常级别 | 含义 |
| --- | --- |
| EL0 | 用户态应用 |
| EL1 | 操作系统内核 |
| EL2 | Hypervisor 虚拟化层 |
| EL3 | Secure Monitor 安全监控层 |

例如 Linux 通常以以下形式运行：

```text
用户程序：EL0
Linux 内核：EL1
虚拟机管理器：EL2
安全固件：EL3
```

异常级别越高，权限越高。低异常级别不能随意访问高异常级别的资源。

例如用户程序不能直接操作 MMU、GIC、页表、物理外设寄存器。如果用户程序需要内核服务，就需要通过系统调用进入内核。

---

## ARM 指令

ARM 指令用于完成计算、访存、跳转、状态控制等操作。根据架构不同，ARM 指令集主要有几类：

- ARM 指令集；
- Thumb / Thumb-2 指令集；
- AArch64 指令集。

### ARM 指令集

经典 ARM 指令通常是 32 位定长指令。

特点包括：

- 指令规整；
- 执行效率高；
- 早期 ARM 中很多指令支持条件执行；
- 代码密度相对 Thumb 较低。

例如：

```asm
ADD r0, r1, r2     ; r0 = r1 + r2
SUB r3, r3, #1     ; r3 = r3 - 1
CMP r0, #0         ; 比较 r0 和 0
BEQ label          ; 如果相等则跳转
```

### Thumb / Thumb-2 指令集

Thumb 最初是 16 位指令集，目的是提高代码密度，节省存储空间。后来 Thumb-2 支持 16 位和 32 位混合编码。

特点包括：

- 代码密度高；
- 节省 Flash；
- Cortex-M 基本使用 Thumb / Thumb-2；
- 嵌入式 MCU 中非常常见。

很多 Cortex-M 芯片的 Flash 容量有限，因此 Thumb-2 的代码密度优势非常重要。

需要注意的是，Cortex-M 只支持 Thumb 状态，不支持传统 ARM 状态。如果跳转地址最低 bit 错误，可能会导致 HardFault 或 UsageFault。

### AArch64 指令集

ARMv8-A 的 64 位状态使用 AArch64 指令集。

特点包括：

- 64 位通用寄存器；
- 指令为 32 位定长；
- 寄存器更多；
- 异常模型变为 EL0 ~ EL3；
- 常用于现代 Cortex-A 处理器。

例如：

```asm
ADD x0, x1, x2      ; x0 = x1 + x2
LDR x0, [x1]        ; 从 x1 指向的地址加载 64 位数据到 x0
STR x0, [x1]        ; 把 x0 存储到 x1 指向的地址
BL function         ; 调用函数
RET                 ; 函数返回
```

### ARM 常见指令类型

ARM 指令可以按功能分成几类：

| 类型 | 作用 | 示例 |
| --- | --- | --- |
| 数据处理指令 | 算术、逻辑、移位 | ADD、SUB、AND、ORR、EOR、LSL |
| 访存指令 | 内存和寄存器之间搬运数据 | LDR、STR、LDM、STM |
| 跳转指令 | 改变程序执行流程 | B、BL、BX、RET |
| 比较指令 | 设置条件标志位 | CMP、TST |
| 乘除指令 | 乘法、除法 | MUL、MLA、SDIV、UDIV |
| 系统控制指令 | 修改系统状态 | MRS、MSR、CPSID、CPSIE |
| 异常触发指令 | 主动触发异常 | SVC、BKPT |

### 条件标志位

ARM 中很多比较和跳转都依赖条件标志位。常见标志位包括：

| 标志位 | 含义 |
| --- | --- |
| N | Negative，结果为负 |
| Z | Zero，结果为零 |
| C | Carry，进位或借位 |
| V | Overflow，有符号溢出 |

例如：

```asm
CMP r0, #0
BEQ zero_label
BNE nonzero_label
```

这里 `CMP r0, #0` 本质上会计算 `r0 - 0`，但不保存结果，只更新标志位。如果结果为 0，则 Z 标志位置位，`BEQ` 就会跳转。

---

## ARM 寻址方式

寻址方式指的是：一条指令如何计算要访问的内存地址。

在 C 语言中，我们经常写：

```c
value = array[i];
```

但在汇编层面，CPU 要知道：

```text
数组基地址在哪里？
i 的偏移是多少？
每个元素占几个字节？
最终访问地址是多少？
```

这些都和寻址方式有关。

### 立即数寻址

立即数就是直接写在指令里的常量。

```asm
MOV r0, #10      ; r0 = 10
ADD r1, r1, #4   ; r1 = r1 + 4
```

这里的 `#10`、`#4` 就是立即数。

### 寄存器寻址

操作数来自寄存器。

```asm
ADD r0, r1, r2   ; r0 = r1 + r2
```

这里 `r1` 和 `r2` 都是寄存器操作数。

### 寄存器间接寻址

寄存器中保存的是内存地址，指令通过这个地址访问内存。

```asm
LDR r0, [r1]     ; r0 = *(uint32_t *)r1
STR r0, [r1]     ; *(uint32_t *)r1 = r0
```

其中 `[r1]` 的意思是：把 r1 的值当作地址。

这在访问指针和外设寄存器时非常常见。

例如 C 语言：

```c
uint32_t value = *ptr;
```

可能对应：

```asm
LDR r0, [r1]
```

### 基址加偏移寻址

这是访问结构体成员、数组元素、外设寄存器时最常见的形式。

```asm
LDR r0, [r1, #4]     ; r0 = *(uint32_t *)(r1 + 4)
STR r2, [r1, #8]     ; *(uint32_t *)(r1 + 8) = r2
```

例如一个外设基地址是 `UART_BASE`，数据寄存器偏移是 `0x00`，状态寄存器偏移是 `0x04`：

```c
#define UART_BASE 0x40000000
#define UART_DR   (*(volatile unsigned int *)(UART_BASE + 0x00))
#define UART_SR   (*(volatile unsigned int *)(UART_BASE + 0x04))
```

底层就可能通过基址加偏移的方式访问：

```asm
LDR r0, [r1, #0x04]
```

### 前索引寻址

前索引寻址会先计算新地址，再访问内存，并且可以选择是否把新地址写回基址寄存器。

```asm
LDR r0, [r1, #4]!    ; r1 = r1 + 4，然后 r0 = *r1
```

感叹号 `!` 表示写回。也就是说，r1 自己也会被更新。

### 后索引寻址

后索引寻址是先用原地址访问内存，再更新基址寄存器。

```asm
LDR r0, [r1], #4     ; r0 = *r1，然后 r1 = r1 + 4
```

这种方式适合遍历数组或连续内存。

例如：

```text
先读取当前元素
然后指针自动移动到下一个元素
```

### 多寄存器访存

ARM 支持一次加载或存储多个寄存器，例如：

```asm
PUSH {r4-r7, lr}
POP  {r4-r7, pc}
```

本质上这类指令会把多个寄存器压入栈或从栈中恢复。

在函数调用、中断现场保存、任务切换中，这类指令非常常见。

### 字节、半字、字访问

ARM 访存时需要区分访问宽度：

| 指令 | 含义 |
| --- | --- |
| LDRB / STRB | 访问 8 bit 字节 |
| LDRH / STRH | 访问 16 bit 半字 |
| LDR / STR | 访问 32 bit 字 |
| LDRD / STRD | 访问 64 bit 双字，视架构支持情况而定 |

例如：

```asm
LDRB r0, [r1]    ; 读取 1 字节
LDRH r0, [r1]    ; 读取 2 字节
LDR  r0, [r1]    ; 读取 4 字节
```

访问外设寄存器时，必须按照芯片手册规定的宽度访问。错误的访问宽度可能导致读写无效，甚至触发总线错误。

### 对齐问题

很多 ARM 平台对内存对齐有要求。例如 32 位访问最好按 4 字节对齐。

```text
地址 0x20000000：4 字节对齐
地址 0x20000004：4 字节对齐
地址 0x20000002：不是 4 字节对齐
```

在某些平台上，非对齐访问可能由硬件自动处理，但会降低性能；在另一些平台上，非对齐访问可能直接触发异常。

嵌入式开发中，如果遇到 HardFault、Data Abort、BusFault，需要考虑是否存在：

```text
指针地址错误
访问地址未对齐
访问了不存在的外设地址
访问权限不足
访问宽度不匹配
```

---

## ARM 异常

异常是指 CPU 正常执行流程被打断，转去执行某个特殊处理程序。这里的“异常”是广义概念，不只是错误，也包括中断、系统调用、调试断点等。

ARM 中常见异常包括：

- Reset；
- Undefined Instruction；
- SVC / SWI；
- Prefetch Abort；
- Data Abort；
- IRQ；
- FIQ；
- SError；
- Debug Exception；
- HardFault、MemManage、BusFault、UsageFault。

不同 ARM 架构名称略有差异。

### 异常的本质

异常发生时，CPU 会自动完成一系列动作：

```text
1. 保存当前执行状态
2. 切换到对应异常模式或异常级别
3. 关闭或屏蔽某些中断
4. 跳转到异常向量表中的入口
5. 执行异常处理函数
6. 处理完成后恢复现场
7. 返回原程序继续执行
```

以一个普通中断为例：

```text
正常代码执行
    ↓
外设产生中断
    ↓
CPU 暂停当前代码
    ↓
保存现场
    ↓
跳到 IRQ handler
    ↓
处理中断
    ↓
恢复现场
    ↓
返回原代码
```

不同架构中，“保存现场”的方式不同。

例如 Cortex-M 中，异常入口时硬件会自动压栈一部分寄存器：

```text
R0
R1
R2
R3
R12
LR
PC
xPSR
```

所以 Cortex-M 的中断函数可以写成普通 C 函数形式，编译器和硬件会配合完成很多底层工作。

而在 Cortex-A/R 中，异常入口通常需要启动代码或异常入口汇编手动保存更多上下文。

### 同步异常和异步异常

异常可以分为同步异常和异步异常。

同步异常与当前执行的指令直接相关，例如：

- 执行了非法指令；
- 执行了 SVC 指令；
- 访问了非法地址；
- 指令取指失败；
- 数据访问失败。

同步异常的特点是：异常由当前指令引起，异常位置通常可以精确定位。

异步异常不是由当前指令直接引起的，而是外部事件打断当前执行流程。例如：

- 外设中断；
- 定时器中断；
- DMA 完成中断；
- 外部引脚中断。

异步异常的特点是：异常发生时间与当前执行指令没有直接关系。普通 IRQ 和 FIQ 通常属于异步异常。

### Reset

复位异常是系统启动时进入的第一个异常。复位后 CPU 会跳到 Reset 向量，执行启动代码。

启动代码通常负责：

- 设置栈；
- 初始化 .data 段；
- 清零 .bss 段；
- 配置时钟；
- 配置 Flash 等待周期；
- 配置中断向量表；
- 初始化 C 运行环境；
- 调用 SystemInit；
- 跳转到 main()。

对于 Cortex-M 来说，复位后硬件会先从向量表第 0 项读取 MSP，再从第 1 项读取 Reset_Handler。

这也是为什么 Cortex-M 向量表的第一个表项不是函数地址，而是初始栈顶地址。

### Undefined Instruction

当 CPU 遇到无法识别或当前状态不允许执行的指令时，会触发未定义指令异常。

可能原因包括：

- 指令编码非法；
- 当前 CPU 不支持该指令；
- 浮点协处理器未启用；
- ARM / Thumb 状态错误；
- 代码跳转到错误地址；
- 函数指针被破坏。

例如 Cortex-M 只支持 Thumb 指令，如果错误地跳转到一个最低 bit 没有置位的函数地址，就可能触发异常。

### SVC / SWI

SVC 是 Supervisor Call，以前也叫 SWI，Software Interrupt。它通常用于用户态请求内核服务。

在操作系统中，系统调用可以通过 SVC 进入内核。

流程类似：

```text
用户程序
  -> 执行 SVC 指令
  -> 进入 SVC 异常
  -> 内核根据系统调用号进行处理
  -> 返回用户程序
```

在 Cortex-M 的 RTOS 中，SVC 也经常用于启动第一个任务或进行特权操作。

### Prefetch Abort / Instruction Abort

Prefetch Abort 指取指阶段发生错误。

可能原因包括：

- PC 跳到了非法地址；
- 指令所在页没有执行权限；
- 指令访问了不存在的内存；
- MMU / MPU 权限错误；
- Flash 或存储器访问异常。

在 ARMv8-A 中，类似概念常称为 Instruction Abort。

### Data Abort

Data Abort 指数据访问阶段发生错误。

可能原因包括：

- 访问非法地址；
- 访问未映射内存；
- 权限不足；
- 非对齐访问；
- 总线错误；
- 访问外设地址错误；
- Cache/MMU 属性配置错误。

驱动开发中，如果把外设基地址写错，就可能触发 Data Abort。

例如：

```c
#define UART_BASE 0x12345678
*(volatile unsigned int *)(UART_BASE + 0x00) = 0x55;
```

如果这个地址并不存在，或者当前 MMU/MPU 没有映射该地址，就可能出错。

### IRQ

IRQ 是普通中断，也是最常见的外设中断类型。

例如：

- 定时器中断；
- UART 中断；
- CAN 中断；
- SPI 中断；
- DMA 中断；
- GPIO 中断；
- Ethernet 中断。

在实际项目中，绝大多数外设中断都走 IRQ。

### FIQ

FIQ 是快速中断。FIQ 通常优先级高于 IRQ。

在经典 ARM 中，FIQ 模式拥有更多 banked registers，因此可以减少保存现场开销。

FIQ 常用于：

- 高实时性中断；
- 安全关键中断；
- 极低延迟事件；
- 不希望被普通 IRQ 干扰的场景。

不过在现代系统中，FIQ 的具体用途和软件架构强相关。有些平台会把 FIQ 留给安全固件、TrustZone 或特殊实时任务使用。

---

## ARM 中断

中断是异常的一种，通常由外部硬件或定时器产生。

### 中断的基本流程

以一个外设中断为例：

```text
1. 外设产生事件
2. 外设设置中断状态位
3. 中断控制器接收到中断请求
4. 中断控制器根据使能状态和优先级选择一个中断
5. CPU 响应该中断
6. CPU 跳转到异常向量表中的 IRQ 入口
7. IRQ handler 查询具体中断源
8. 调用对应外设 ISR
9. ISR 清除外设中断标志
10. 返回中断
```

例如 UART 收到数据：

```text
UART RX event
  -> UART 设置 RX interrupt pending
  -> 中断控制器通知 CPU
  -> CPU 进入 IRQ
  -> UART ISR 读取数据寄存器
  -> 清除中断状态
  -> 返回原程序
```

这里需要注意一个实际细节：很多外设中断不只是 CPU 侧清除就结束了，还要清除外设内部的 pending 标志。

如果 ISR 没有正确清除外设中断标志，就可能出现：

```text
刚退出中断，又立刻再次进入中断
系统一直卡在中断里
CPU 占用率异常高
```

### 中断控制器

不同 ARM 系列使用的中断控制器不同。

### Cortex-A / Cortex-R 中的 GIC

Cortex-A / Cortex-R 常见的是 GIC，Generic Interrupt Controller。

GIC 负责：

- 管理多个中断源；
- 设置中断优先级；
- 分发中断到某个 CPU；
- 支持多核中断路由；
- 支持中断屏蔽；
- 支持中断抢占；
- 支持 SGI、PPI、SPI 等中断类型。

| 类型 | 含义 |
| --- | --- |
| SGI | Software Generated Interrupt，软件生成中断 |
| PPI | Private Peripheral Interrupt，每核私有外设中断 |
| SPI | Shared Peripheral Interrupt，共享外设中断 |

简单理解：

```text
SGI：软件主动发给某个 CPU 的中断，常用于核间通信
PPI：每个 CPU 私有的中断，例如本地定时器
SPI：多个 CPU 共享的外设中断，例如 UART、CAN、Ethernet
```

在多核系统中，GIC 很重要。因为一个外设中断到底送给哪个 CPU，需要由 GIC 路由和配置决定。

例如一个车载 SoC 有 4 个 Cortex-A 核心，某个 Ethernet 中断可以配置为发给 CPU0，也可以配置为发给 CPU1，甚至根据系统支持做负载分配。

### Cortex-M 中的 NVIC

Cortex-M 使用 NVIC，Nested Vectored Interrupt Controller。

NVIC 的特点：

- 中断控制器集成在内核中；
- 支持嵌套中断；
- 每个中断有独立向量入口；
- 异常入口自动压栈；
- 异常返回自动恢复现场；
- 编程模型相对简单。

Cortex-M 的中断处理流程相对直接：

```text
外设产生中断
  -> NVIC 判断优先级
  -> CPU 自动压栈
  -> 直接跳转到对应 IRQHandler
  -> ISR 执行
  -> 异常返回时自动出栈
```

因为每个外部中断在向量表中通常都有自己的入口，所以 Cortex-M 不一定需要像 Cortex-A/R 那样先进入统一 IRQ 入口再读取中断号分发。

### 中断优先级

中断优先级决定多个中断同时发生时，先处理谁。还决定高优先级中断能否打断低优先级中断。

例如：

```text
高优先级：电机保护中断
中优先级：控制周期定时器中断
低优先级：串口日志中断
```

如果系统正在处理串口中断，突然来了电机保护中断，高优先级中断可以抢占低优先级中断。这叫中断嵌套。

中断优先级设计要非常谨慎。优先级不是越高越好。如果太多中断都设置成最高优先级，系统反而难以控制。

实际设计中通常遵循：

```text
安全保护类中断优先级最高
控制周期类中断次之
通信收发类中断再次
日志、调试类中断最低
```

### 中断屏蔽

CPU 通常可以屏蔽中断。在 ARMv7-A/R 中，CPSR 中有中断屏蔽位：

| 位 | 含义 |
| --- | --- |
| I bit | 屏蔽 IRQ |
| F bit | 屏蔽 FIQ |

例如：

```asm
CPSID i     ; disable IRQ
CPSIE i     ; enable IRQ
CPSID f     ; disable FIQ
CPSIE f     ; enable FIQ
```

在临界区中，可能会短暂关闭中断，防止共享数据被打断。

但要注意，关中断时间不能太长，否则会影响实时性。

例如下面这种做法就不合适：

```c
disable_irq();

for (int i = 0; i < 1000000; i++) {
    do_heavy_work();
}

enable_irq();
```

因为这会导致系统在很长时间内无法响应外设中断。

### ISR 编写注意事项

ISR 是 Interrupt Service Routine，中断服务函数。

编写 ISR 时要注意：

- 尽量短；
- 尽快清除中断标志；
- 不要做耗时操作；
- 不要在 ISR 中长时间阻塞；
- 不要随意调用不可重入函数；
- 不要在 ISR 中做大量打印；
- 不要在 ISR 中动态分配内存；
- 与任务共享数据时要考虑同步；
- 必要时使用 deferred processing。

常见设计是：

```text
ISR 只做最紧急、最短的事情
复杂逻辑交给任务处理
```

例如 UART 接收中断：

```text
ISR 中读取 UART 数据寄存器
把数据放入 ring buffer
通知任务有新数据
退出中断

任务中解析协议、处理业务逻辑
```

在 RTOS 中，ISR 通常会通过信号量、队列、事件标志等机制通知任务。但要使用 RTOS 提供的 ISR-safe API。

例如 FreeRTOS 中通常使用：

```c
xSemaphoreGiveFromISR()
xQueueSendFromISR()
portYIELD_FROM_ISR()
```

而不是普通任务上下文使用的 API。

---

## ARM 异常向量表

异常向量表是 CPU 发生异常后跳转的入口表。

可以理解为：

```text
异常类型 -> 对应处理函数入口
```

当异常发生时，CPU 不会随便找 handler，而是根据异常类型跳到异常向量表中的固定位置。

### ARMv7-A/R 异常向量表

ARMv7-A/R 经典异常向量表如下：

| 偏移 | 异常类型 |
| --- | --- |
| 0x00 | Reset |
| 0x04 | Undefined Instruction |
| 0x08 | SVC / SWI |
| 0x0C | Prefetch Abort |
| 0x10 | Data Abort |
| 0x14 | Reserved |
| 0x18 | IRQ |
| 0x1C | FIQ |

可以理解为：

```text
Vector Base + 0x00 -> Reset
Vector Base + 0x04 -> Undefined Instruction
Vector Base + 0x08 -> SVC
Vector Base + 0x0C -> Prefetch Abort
Vector Base + 0x10 -> Data Abort
Vector Base + 0x14 -> Reserved
Vector Base + 0x18 -> IRQ
Vector Base + 0x1C -> FIQ
```

异常向量表可以放在低地址或高地址，取决于系统配置。也可以通过向量基址寄存器配置到其他地址。

### ARMv7-A/R 向量表中通常放什么

经典 ARM 向量表中，每个入口通常不是完整 handler，而是一条跳转指令。

例如：

```asm
_vectors:
    B reset_handler
    B undefined_handler
    B svc_handler
    B prefetch_abort_handler
    B data_abort_handler
    B reserved_handler
    B irq_handler
    B fiq_handler
```

因为每个向量入口只有 4 字节，刚好放一条跳转指令。

异常发生后：

```text
CPU 跳到 vector_base + offset
执行 B xxx_handler
跳到真正的异常处理函数
```

### Cortex-M 异常向量表

Cortex-M 的异常向量表和 ARMv7-A/R 不一样。Cortex-M 向量表中存放的不是跳转指令，而是：

```text
初始 MSP 值 + 各异常处理函数地址
```

典型 Cortex-M 向量表：

| 表项 | 含义 |
| --- | --- |
| 0 | 初始 MSP 值 |
| 1 | Reset_Handler |
| 2 | NMI_Handler |
| 3 | HardFault_Handler |
| 4 | MemManage_Handler |
| 5 | BusFault_Handler |
| 6 | UsageFault_Handler |
| 11 | SVC_Handler |
| 14 | PendSV_Handler |
| 15 | SysTick_Handler |
| 16+ | 外部中断 IRQ Handler |

例如：

```c
__attribute__((section(".isr_vector")))
const void *vector_table[] = {
    &_estack,
    Reset_Handler,
    NMI_Handler,
    HardFault_Handler,
    MemManage_Handler,
    BusFault_Handler,
    UsageFault_Handler,
    0,
    0,
    0,
    0,
    SVC_Handler,
    0,
    0,
    PendSV_Handler,
    SysTick_Handler,
    UART_IRQHandler,
    SPI_IRQHandler,
};
```

Cortex-M 复位后会：

```text
1. 从 vector_table[0] 读取初始 MSP
2. 从 vector_table[1] 读取 Reset_Handler 地址
3. 跳转到 Reset_Handler 执行
```

这也是 MSP 概念出现得非常早的原因。对于 Cortex-M 来说，系统启动的第一步就是设置 MSP。

### VTOR 和向量表重定位

在 Cortex-M 中，很多芯片支持通过 VTOR 寄存器修改向量表地址。

VTOR 是 Vector Table Offset Register。

它的作用是告诉 CPU：

```text
当前异常向量表放在哪里
```

这在 bootloader + app 场景中非常重要。

例如：

```text
芯片启动后先运行 bootloader
bootloader 的向量表在 Flash 起始地址
bootloader 检查升级标志
bootloader 跳转到 app
app 有自己的向量表
跳转前需要把 VTOR 改成 app 的向量表地址
```

否则会出现一个常见问题：

```text
程序已经跳到 app 执行
但中断发生后仍然跳到 bootloader 的中断向量表
导致中断处理错误或 HardFault
```

所以 bootloader 跳转 app 时，通常要做：

```text
关闭中断
设置 MSP 为 app 向量表第 0 项
设置 VTOR 为 app 向量表地址
跳转到 app Reset_Handler
```

### ARMv8-A AArch64 异常向量表

ARMv8-A AArch64 使用 VBAR_ELx 指定异常向量表基地址。

例如：

```text
VBAR_EL1：EL1 异常向量表基地址
VBAR_EL2：EL2 异常向量表基地址
VBAR_EL3：EL3 异常向量表基地址
```

AArch64 的异常向量表更复杂，会根据以下因素分组：

- 异常来自当前 EL 还是低 EL；
- 使用的是 SP0 还是 SPx；
- 异常是同步异常、IRQ、FIQ 还是 SError；
- 低 EL 是 AArch64 还是 AArch32。

可以简单理解为：AArch64 不再只是一张简单的 8 项向量表，而是按照异常来源和异常类型划分成多个入口。

### 异常向量表和中断控制器的关系

异常向量表只负责：

```text
CPU 收到某类异常后跳到哪里
```

中断控制器负责：

```text
具体是哪一个外设中断
优先级是多少
发给哪个 CPU
是否允许抢占
当前是否 pending
```

以 Cortex-A/R + GIC 为例：

```text
外设产生中断
  -> GIC 收到中断
  -> GIC 选择目标 CPU
  -> CPU 进入 IRQ exception
  -> CPU 跳到 vector_base + IRQ offset
  -> IRQ handler 读取 GIC 中断号
  -> 分发到具体外设 ISR
```

所以：

```text
异常向量表只能区分 IRQ/FIQ 这类大类；
具体是 UART、CAN、SPI、DMA，需要中断控制器进一步判断。
```

而 Cortex-M 的 NVIC 更进一步，向量表中通常每个外部中断都有独立入口，所以外设中断可以直接跳到对应的 `xxx_IRQHandler`。

---

## 从启动到 main 函数

理解 ARM 系统时，启动流程也很重要。很多异常、向量表、栈指针的问题都发生在启动阶段。

以 Cortex-M 为例，启动流程通常是：

```text
1. 芯片复位
2. CPU 从向量表第 0 项读取初始 MSP
3. CPU 从向量表第 1 项读取 Reset_Handler
4. 执行 Reset_Handler
5. 初始化 .data 段
6. 清零 .bss 段
7. 配置系统时钟
8. 初始化 C/C++ 运行环境
9. 调用 main()
```

其中 `.data` 和 `.bss` 是 C 程序中非常重要的段：

```text
.data：已经初始化的全局变量和静态变量
.bss：未初始化或初始化为 0 的全局变量和静态变量
```

例如：

```c
int a = 10;     // 通常放在 .data
int b;          // 通常放在 .bss
static int c;   // 通常放在 .bss
```

启动代码需要把 `.data` 从 Flash 拷贝到 RAM，并把 `.bss` 清零。否则 C 语言中的全局变量初始值就不正确。

---

## 从一条中断完整串起来理解

假设 UART 收到一个字节，产生中断。

整体流程如下：

```text
1. UART 收到数据
2. UART 设置中断 pending 标志
3. 中断控制器接收到 UART 中断
4. 中断控制器判断该中断是否使能
5. 中断控制器判断优先级和目标 CPU
6. CPU 当前没有屏蔽 IRQ
7. CPU 接受 IRQ 异常
8. CPU 保存当前现场
9. CPU 切换到 IRQ 模式或 Handler Mode
10. CPU 根据异常向量表跳到 IRQ 入口
11. IRQ 入口代码读取中断号或直接进入 UART_IRQHandler
12. UART_IRQHandler 读取数据寄存器
13. 清除 UART 中断标志
14. 把数据写入 ring buffer
15. 通知任务处理数据
16. 中断返回
17. CPU 恢复原来的程序继续执行
```

如果是在 Cortex-M + FreeRTOS 中，流程可能更接近：

```text
UART 收到数据
  -> NVIC 触发 UART_IRQHandler
  -> 硬件自动压栈
  -> ISR 读取 UART 数据寄存器
  -> ISR 写入 ring buffer
  -> ISR 使用 xQueueSendFromISR 通知任务
  -> 如果需要切换任务，则触发 PendSV
  -> 异常返回
  -> 调度器切换到被唤醒的任务
  -> 任务解析 UART 数据
```

这体现了一个实际工程中的常见原则：

```text
中断负责快速响应
任务负责复杂处理
```

---

## HardFault / Data Abort 调试思路

在实际嵌入式开发中，异常不是只停留在理论上。最常见的问题之一就是程序突然进入 HardFault 或 Data Abort。

### Cortex-M HardFault 常见原因

Cortex-M 中 HardFault 常见原因包括：

- 空指针访问；
- 野指针访问；
- 栈溢出；
- 函数指针被破坏；
- 中断向量表错误；
- 访问了不存在的外设地址；
- 非对齐访问；
- 使用了未使能的 FPU；
- bootloader 跳转 app 时 MSP 或 VTOR 设置错误；
- ISR 中调用了不该调用的阻塞函数。

调试 HardFault 时，通常需要关注：

```text
异常发生时的 PC：程序在哪里崩溃
LR：异常返回信息
SP：当前使用的是 MSP 还是 PSP
CFSR：Configurable Fault Status Register
HFSR：HardFault Status Register
MMFAR：Memory Management Fault Address Register
BFAR：Bus Fault Address Register
```

其中 PC 特别重要。因为 PC 往往能告诉你程序崩溃在什么指令附近。

### ARMv8-A Data Abort 常见调试信息

在 Cortex-A / ARMv8-A 中，如果发生 Data Abort，常见关键信息包括：

```text
ESR_ELx：异常原因
FAR_ELx：访问异常地址
ELR_ELx：异常返回地址
SPSR_ELx：异常前状态
```

例如：

```text
FAR_EL1 = 0x00000000
```

可能说明发生了空指针访问。

如果 FAR 指向一个外设地址，就需要检查：

```text
该外设地址是否正确
MMU 是否映射该地址
访问权限是否正确
设备内存属性是否正确
访问宽度是否符合手册
外设时钟是否打开
```

---

## 常见易混概念总结

### 异常和中断的关系

中断是异常的一种。

```text
异常：广义概念，包括中断、系统调用、访问错误、非法指令等
中断：通常由外设或定时器产生，是异步异常
```

### 向量表和中断控制器的区别

```text
向量表：CPU 发生异常后跳到哪里
中断控制器：管理具体中断源、优先级、pending 状态和路由
```

### MSP 和 PSP 的区别

```text
MSP：主栈指针，常用于启动阶段、异常、中断
PSP：进程栈指针，常用于 RTOS 中的普通任务
```

裸机程序中可能只用 MSP。RTOS 中常见做法是中断用 MSP，任务用 PSP。

### MMU 和 MPU 的区别

```text
MMU：内存管理单元，支持虚拟地址到物理地址转换，常用于 Linux
MPU：内存保护单元，主要做区域权限保护，常用于 MCU/实时系统
```

### Cortex-A、Cortex-R、Cortex-M 的区别

```text
Cortex-A：高性能，适合跑 Linux/Android
Cortex-R：强实时，适合安全关键和实时控制
Cortex-M：低功耗、低成本，适合 MCU、裸机、RTOS
```




