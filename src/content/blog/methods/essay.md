---
title: '随笔'
description: '随手记录看到的一些知识点'
tags: ['C/C++', 'OS', 'Network', 'ARM']
series: { id: 'essay', order: 1 }
pubDate: 'Jun 14 2026'
---

## Cortex-A 中的GIC与Cortex-M 中NVIC的区别

### 中断简要回顾

首先简单介绍一下中断的意义。假设一个CPU连接着串口，定时器，以太网等各种各样的外设或者功能组件。UART收到数据要CPU处理，Timer到期要CPU处理，各种各样的事情都需要串口处理。最笨的方案就是放到一个大的while(1)里面不断轮询，让CPU不停主动询问，是否有数据需要处理，也就是polling，但这样显然不是一个好方法。于是我们期望从CPU不断主动去问，变成外设有事的时候主动通知CPU。也就是外设收到数据，产生中断请求给CPU，CPU暂停目前处理的程序，保存程序计数器等等寄存器(现场)，去执行相应的IRQHandler，执行完之后返回原程序。

那么这就带来新的问题，假如我有很多很多外设，难不成CPU要给每个外设单独准备一个中断输入？假如有几百个几千个呢？这显然不现实。所以就需要在CPU和外设之间加入一个中断控制器，这个中断控制器负责：
```
收集 记录中断信号源
屏蔽/使能
优先级判断
选择/路由
通知CPU处理中断
```

### NVIC and GIC

NVIC和GIC本质上都在解决一个问题：
```
很多中断源
    ↓
哪个发生了？
    ↓
哪个允许处理？
    ↓
哪个优先级最高？
    ↓
应该送给哪个 CPU？
    ↓
CPU 应该执行哪个 Handler？
```

区别只是他们的复杂度不同。因为Cortex-M一般是面向MCU的，而Cortex-A一般面向复杂的SoC。NVIC与处理器高度集成，而GIC是一套单独的中断控制体系。可以概括为以下的内容：

| Cortex-M + NVIC       | Cortex-A + GIC                     |
| --------------------- | ---------------------------------- |
| 面向 MCU                | 面向复杂 SoC                           |
| 通常一个或少量 CPU core      | 通常多核                               |
| NVIC 与处理器高度集成         | GIC 是独立的系统级中断控制体系                  |
| 中断数量相对较少              | 可以管理大量中断                           |
| Vector table 直接找到 ISR | GIC 先给 CPU 一个 IRQ/FIQ，再由软件读取 INTID |
| 自动压栈非常强               | 异常上下文保存更多由软件完成                     |
| 强调低延迟、确定性             | 强调多核路由、虚拟化、扩展性                     |

Arm 的 Cortex-M4 例如把 NVIC 作为集成特性，可以支持最高 240 个物理外部中断输入，实际芯片厂商可以实现较少的数量；而 GICv3 面向多核 A-profile 系统，包含 Distributor、每个 PE 对应的 Redistributor 和 CPU Interface 等组成。

### GIC

这里主要以GICv3来进行理解，以下是一个典型的架构;
```
                            SoC

  UART ------+
  USB -------+
  Ethernet --+
  Camera ----+------+
  DMA -------+      |
                    v
             +-------------+
             | Distributor |
             |    GICD     |
             +------+------+
                    |
          +---------+----------+
          |                    |
          v                    v
   +-------------+      +-------------+
   |Redistributor|      |Redistributor|
   |   CPU0      |      |   CPU1      |
   |   GICR      |      |   GICR      |
   +------+------+      +------+------+
          |                    |
          v                    v
   CPU Interface         CPU Interface
          |                    |
          v                    v
      Cortex-A0             Cortex-A1
```
GICv3 的核心逻辑组成是 Distributor、每个 PE 对应的 Redistributor、每个 PE 的 CPU interface。

#### Distributor

可以把Distributor理解为整个SoC的中断调度中心。假设我有以下的一些外设：
```
UART      interrupt 33
Ethernet  interrupt 45
Camera    interrupt 72
DMA       interrupt 81
```
camera对应的72中断到了，Distributor会判断以下的内容：
```
IRQ72 是否 enable？
IRQ72 当前是否 pending？
IRQ72 优先级多少？
IRQ72 属于哪个安全组？
IRQ72 应该送给哪个 CPU？
IRQ72 是 edge trigger 还是 level trigger？
```
所以Distributor保存了一大堆中断的配置状态和运行状态。GIC-400/GICv2 和 GICv3 都提供对共享外设中断的 enable、priority、security 和 CPU routing 等管理能力。

#### GIC中重要的三种中断

**SGI:**

software generated interrupt，顾名思义，就是软件产生的中断。例如多核操作系统里面：
```
CPU0：
    CPU3，你重新调度一下。

CPU0
 ↓
生成 SGI
 ↓
GIC
 ↓
CPU3 interrupt
```
Linux 中的 IPI——Inter-Processor Interrupt——就与这类机制密切相关。

**PPI:**

Private Peripheral Interrupt, 直译是私有外设中断，实际上这是某个CPU私有的中断，例如每个CPU自己的timer:
```
CPU0 private timer → CPU0 PPI
CPU1 private timer → CPU1 PPI
CPU2 private timer → CPU2 PPI
CPU3 private timer → CPU3 PPI
```

这些中断不是整个 SoC 共享一个实例。因此GICv3引入了ReDistributor，每个PE附近都有自己的ReDistributor，用于保存SGI/PPI 等私有终端的状态。

**SPI:**

这里不是什么SPI协议，而是Shared Peripheral Interrupt，直译就是共享外设中断。这就是我们平常在嵌入式Linux驱动中最常见的中断了，例如UART、I2C、SPI Controller、CSI、DSI等等了。

"Shared"不代表这个中断是所有CPU共享的，而是代表GIC可以路由给某个合适的CPU，而不是像PPI一样天然地属于某一个CPU。

#### ReDistributor

为什么又需要ReDistributor呢？假设有很多核心，规模就会很大Distributor要处理的事情就会很多。此外PPI和SGI天然的就是CPU私有的。那把某个CPU特有的IRQ配置放在芯片外部的统一控制器里面逻辑上也有点不合理。所以CPUx就有了自己的GICRx。

ARM对于GICv3的解释是，ReDistributor保存每个核心私有的中断的配置，并可以放得更加靠近PE，以改善大型多核系统的可扩展性。

#### CPU Interface

假设现在GIC已经选择了IRQ 72发送给CPU2，还不能让CPU2马上执行。CPU Interface还需要考虑以下的内容：
```
IRQ 72 priority是什么？
CPU当前正在处理什么中断 priority又是什么？
CPU priority mask是什么？
IRQ 72是否应该抢占当前中断？
IRQ 72所属的group是否启用
```
GICv3的CPU Interface提供了对中断的优先级、屏蔽、抢占等机制的支持。CPU Interface会根据这些信息决定是否将中断传递给CPU，并在适当的时候触发中断处理程序。对于CPU Interface的控制常通过ICC_*系统寄存器来完成，例如ICC_PMR_EL1用于设置中断优先级掩码，ICC_IAR1_EL1用于读取当前处理的中断ID等。

#### 完整的Cortex-A中断处理流程

假设UART收到了一个字节，UART向GIC发送了一个中断请求，这里假设UART对应的中断号是45, UART发送了IRQ45给GIC。GIC发现了IRQ45 asserted，于是内部的状态就从inactivate 变成了pending。假设当前：
```
IRQ45 enable = true
priority = 0x60
target CPU = CPU1
Group = Group1
```

GIC会判断IRQ45是否应该送给CPU1。假设CPU1当前正在处理一个中断IRQ72，IRQ72的优先级是0x80。GIC会比较IRQ45和IRQ72的优先级，发现IRQ45的优先级更高，于是GIC会将IRQ45送给CPU1，也就是GIC向CPU1发送 CPU1 IRQ exception request。注意GIC不会直接帮Cortex-A跳到UART_Handler，Cortex-A目前只知道有IRQ exception request，也就是有IRQ要处理了，CPU会进入IRQ exception vector，然后IRQ handler会去再问GIC到底是什么中断。GICv3中可以读取ICC_IAR1_EL1寄存器来获取当前处理的中断ID。IAR，Interrupt Acknowledge Register，例如
```ams
MRS X0, ICC_IAR1_EL1
```
读回来INIID=45，CPU就知道是UART的中断了。然后CPU就可以跳到UART_Handler去处理UART的中断了。ICC_IAR1_EL1返回的是当前可见的最高优先级pending interrupt的INTID，读取这个寄存器也是acknowledge流程的一部分。所以大致的流程就是：
```c
irq_handler() {
    int id = gic_acknowledge_interrupt();
    switch(id) {
        case UART_IRQ:
            uart_irq_handler();
            break;
        case CAMERA_IRQ:
            camera_irq_handler();
            break;
        default:
            break;
    }
    gic_end_of_interrupt(id);
}
```

ISR 做完 uart_irq_handler()之后还没有结束，软件需要告诉GIC IRQ45我处理完了。在GICv3 对应的寄存器是 ICC_EOIR1_EL1，End Of Interrupt Register。CPU写入这个寄存器告诉GIC我处理完了IRQ45了，GIC就会把IRQ45的状态从active变成inactivate。

**中断服务函数里面必须清外设中断状态**
假设 UART 是 level-triggered 的中断，UART 收到一个字节之后会把自己的中断状态寄存器置位。CPU 进入 UART_Handler 之后必须清除 UART 的中断状态寄存器，否则 GIC 会认为 IRQ45 仍然是 pending 状态，CPU 处理完之后又会再次进入 UART_Handler，这样就会形成中断风暴。所以软件上的流程必须是
```
进入ISR -> 读取/处理外设 -> 清除外设中断状态 -> 通知GIC处理完毕 -> 返回
```

### NVIC

现在再来看看Cortex-M的NVIC。NVIC是Cortex-M处理器内核的一部分，直接集成在处理器中。它的主要功能包括中断优先级管理、中断使能/禁用、中断挂起/清除等。
```
 中断到来
    ↓
 硬件决定优先级
    ↓
 硬件压栈
    ↓
 硬件读取向量表
    ↓
 直接跳进ISR
```

Cortex-M的NVIC提供硬件优先级和自动nested exception支持，这正是它低延迟中断模型的核心。

#### vector table

假设vector table放在内存0x0000 0000处，里面的内容大致如下：
```
Vector Tbale

Entry 0   Initial MSP
Entry 1   Reset_Handler
Entry 2   NMI_Handler
Entry 3   HardFault_Handler
...
Entry 11  SVC_Handler
...
Entry 14  PendSV_Handler
Entry 15  SysTick_Handler
Entry 16  IRQ0_Handler
Entry 17  IRQ1_Handler
Entry 18  IRQ2_Handler
...
```

这里要注意entry 0可不是什么中断函数，entry 0是MSP的初始值，也就是CPU上电之后MSP寄存器的初始值。entry 1是Reset_Handler，也就是CPU上电之后执行的第一个函数。entry 2是NMI_Handler，也就是NMI中断的处理函数。entry 3是HardFault_Handler，也就是硬件错误中断的处理函数。entry 11是SVC_Handler，也就是软件中断的处理函数。entry 14是PendSV_Handler，也就是挂起中断的处理函数。entry 15是SysTick_Handler，也就是系统滴答定时器中断的处理函数。entry 16开始才是外部中断的处理函数。这叫异常向量表，异常向量表的前16个entry是ARM Cortex-M架构定义的系统异常，entry 16开始才是外部中断。

**硬件自动保存上下文**

Cortex-M在 exception entry发生的时候，会自动创建exception stack frame，保存当前的上下文信息，包括R0-R3、R12、LR、PC、xPSR等寄存器的值。这样在中断处理函数执行完毕后，Cortex-M可以自动恢复上下文，返回到中断发生前的状态。

**NVIC怎么知道ISR的地址**

硬件完成stacking之后，Cortex-M会根据中断号去vector table中查找对应的ISR地址，然后直接跳转到该地址执行中断处理函数。这个过程是硬件自动完成的，无需软件干预。
```
exception number
    ↓
vector table
    ↓
ISR address
    ↓
    PC
```

例如IRQn = USART1_IRQn，那么 PC = *(vector_table_base + 16 + USART1_IRQn * 4)，也就是直接从vector table中获取USART1的ISR地址，然后跳转执行。这也就是为什么普通的Cortex-M ISR可以写成:
```c
void USART1_IRQHandler(void) {
    // 处理USART1中断
}
```
看起来和普通的C函数一样，但实际上它是通过vector table和硬件机制直接关联的。

#### 恢复现场

进入exception之后，LR不再只是普通的函数返回地址。CPU会给LR放一个特殊的值 EXC_RETURN，这个值告诉CPU
```
我需要返回 thread mode 还是 handler mode？
使用MSP还是PSP？
有没有floating point context？
```

CPU在执行 exception exit 时，会根据 LR 中的 EXC_RETURN 值来决定如何恢复上下文，包括选择使用哪一个堆栈指针（MSP 或 PSP）以及是否需要恢复浮点寄存器的状态。

#### MSP和PSP

Cortex-M有两个堆栈指针：主堆栈指针（MSP）和进程堆栈指针（PSP）。MSP通常用于处理异常和中断，而PSP用于线程模式下的任务堆栈。通过这种设计，Cortex-M可以在中断处理和任务执行之间高效切换，确保中断处理的低延迟和任务的独立性。裸机程序通常只使用MSP，而RTOS会使用PSP来管理任务堆栈。

#### Cortex-M的一次完整中断

假设UART收到了一个字节，UART向NVIC发送了一个中断请求，接下来的整个过程为：
```
USART RX FIFO
      |
      | interrupt condition
      v
NVIC IRQn input
      |
      v
set Pending
      |
      v
检查：
Enabled？
Priority？
PRIMASK？
BASEPRI？
当前 Active exception？
      |
      v
决定接受 IRQ
      |
      v
CPU exception entry
      |
      +--> 自动保存 R0-R3
      |
      +--> 自动保存 R12
      |
      +--> 自动保存 LR
      |
      +--> 自动保存 PC
      |
      +--> 自动保存 xPSR
      |
      v
根据 exception number
读取 Vector Table
      |
      v
得到 USART_IRQHandler 地址
      |
      v
PC = USART_IRQHandler
      |
      v
执行 ISR
      |
      +--> read USART data
      |
      +--> clear interrupt source
      |
      v
BX LR / exception return
      |
      v
hardware unstack
      |
      v
恢复 PC/xPSR/registers
      |
      v
继续原程序
```

