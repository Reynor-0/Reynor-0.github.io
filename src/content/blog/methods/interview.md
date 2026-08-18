---
title: '随笔'
description: '随手记录看到的一些知识点'
category: '方法'
tags: ['C/C++', 'OS', 'Network', 'ARM']
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




