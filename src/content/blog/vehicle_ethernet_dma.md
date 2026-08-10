---
title: '车载以太网（六）：DMA 描述符环'
description: 'DMA 描述符并不是数据本身，而是 CPU 与 Ethernet DMA 之间用来描述“数据放在哪里、长度是多少、现在归谁处理”的控制结构 '
category: '协议'
tags: ['Ethernet', 'DMA', 'MAC驱动', '汽车电子']
pubDate: 'Jun 08 2026'
updatedDate: 'Aug 06 2026'
---

# DMA 描述符环

在前面的 Ethernet MAC、PHY 等内容中，我们更多关注的是：

- Ethernet Frame 是什么样的
- MAC 如何通过 PHY 把数据发送到物理链路
- CPU 如何通过 MDIO 配置 PHY

但真正到了 Ethernet MAC 驱动中，会发现收发报文时并不是简单地：

```c
mac_send(data, length);
````

然后由 CPU 把每一个字节直接写到 Ethernet MAC。

现代 Ethernet MAC 通常都集成了 DMA：

```text
CPU / Ethernet Driver
        │
        │ 配置 DMA Descriptor
        ↓
DMA Descriptor Ring
        │
        │ 指向内存中的 Packet Buffer
        ↓
Memory Buffer
        │
        ↓
Ethernet MAC
        │
        ↓
PHY
```

CPU 主要负责准备数据和描述符，而真正的大块数据搬运由 DMA 完成。

因此在 Ethernet Driver 中，经常能看到：

```text
TX Descriptor
RX Descriptor
OWN
FD
LD
Buffer Address
Packet Length
Descriptor Ring
```

这些概念本质上都是在解决一个问题：

> CPU 和 Ethernet DMA 如何共享一批内存 Buffer，并且知道某个 Buffer 当前应该由谁处理。

---

## 为什么 Ethernet 需要 DMA

假设应用程序现在需要发送一个 1500 Byte 的 Ethernet Packet。

一种最简单的实现方式是 CPU 不断向 Ethernet MAC 的 FIFO 写数据：

```c
for (int i = 0; i < len; i++) {
    MAC_TX_FIFO = buffer[i];
}
```

这种方式理论上可以工作，但效率非常低。

因为 CPU 需要参与整个数据搬运过程：

```text
Memory
  ↓
CPU Load
  ↓
CPU Store
  ↓
Ethernet MAC FIFO
```

对于 100 Mbps、1 Gbps 甚至更高速率的 Ethernet 来说，大量 CPU 时间都会浪费在内存搬运上。

因此实际的 Ethernet Controller 通常都会加入 DMA：

```text
Memory Buffer
     │
     │ DMA 自动读取
     ↓
Ethernet MAC
```

CPU 不需要搬运整个 Packet，只需要告诉 DMA：

```text
数据在哪里？
数据有多长？
这是一个 Packet 的开始还是结束？
什么时候可以开始发送？
```

DMA 完成发送之后，再把结果通知 CPU。

所以 CPU 与 DMA 之间需要一种数据结构来传递这些信息，这就是：

> DMA Descriptor，DMA 描述符。

---

## 什么是 DMA Descriptor

DMA Descriptor 可以理解成 DMA 的一张任务单。

例如一个非常简化的 TX Descriptor 可以表示成：

```c
struct tx_descriptor {
    uint32_t buffer_addr;
    uint32_t length;
    uint32_t control;
    uint32_t status;
};
```

其中可能包含：

```text
buffer_addr
    数据 Buffer 在内存中的地址

length
    数据长度

control
    DMA 应该如何处理这个 Buffer

status
    DMA 执行完成后的状态
```

例如：

```text
TX Descriptor

+-------------------------+
| Buffer Address          | ───────┐
+-------------------------+        │
| Buffer Length = 1500    |        │
+-------------------------+        │
| OWN = 1                 |        │
| FD  = 1                 |        │
| LD  = 1                 |        │
| CIC = xx                |        │
| IOC = 1                 |        │
+-------------------------+        │
                                   ↓
                            +--------------+
                            | Ethernet     |
                            | Frame Buffer |
                            | 1500 Bytes   |
                            +--------------+
```

描述符本身通常只有几个 32-bit Word。

真正的 Ethernet Packet 数据存储在另外的 Buffer 中。

因此需要区分：

```text
Descriptor
    描述数据在哪里，以及如何处理

Buffer
    真正存储 Ethernet Packet
```

---

## 为什么需要 Descriptor Ring

如果每次只能准备一个 Descriptor：

```text
CPU 准备 Descriptor
        ↓
DMA 发送
        ↓
CPU 等待 DMA 完成
        ↓
CPU 再准备下一个 Descriptor
```

CPU 和 DMA 会频繁互相等待，性能并不好。

所以驱动一般会提前准备多个 Descriptor：

```text
Descriptor 0
Descriptor 1
Descriptor 2
Descriptor 3
Descriptor 4
...
```

DMA 处理完一个之后自动处理下一个。

进一步地，这些 Descriptor 通常会组成一个环：

```text
        +-------------+
        | Descriptor0 |
        +------+------+
               |
               ↓
        +-------------+
        | Descriptor1 |
        +------+------+
               |
               ↓
        +-------------+
        | Descriptor2 |
        +------+------+
               |
               ↓
        +-------------+
        | Descriptor3 |
        +------+------+
               |
               └─────────────→ Descriptor0
```

也可以画成：

```text
Descriptor Ring

        [0] → [1] → [2] → [3]
         ↑                 ↓
         └─────────────────┘
```

这就是所谓的：

> Descriptor Ring

驱动通常会分别维护：

```text
TX Descriptor Ring
RX Descriptor Ring
```

两者虽然使用方式不同，但基本思想完全一样。

---

## Descriptor Ring 本质上是什么

从软件角度看，Descriptor Ring 往往就是一个数组：

```c
#define TX_DESC_NUM 8

struct dma_desc tx_desc[TX_DESC_NUM];
```

然后维护一个 Index：

```c
uint32_t tx_index;
```

每发送一个 Packet：

```c
desc = &tx_desc[tx_index];

...

tx_index++;

if (tx_index >= TX_DESC_NUM)
    tx_index = 0;
```

也可以写成：

```c
tx_index = (tx_index + 1) % TX_DESC_NUM;
```

于是 Descriptor 会循环使用：

```text
0
↓
1
↓
2
↓
3
↓
0
↓
1
...
```

当然，真实硬件并不一定完全通过软件 `%` 实现 Ring。

不同 Ethernet DMA IP 可能采用：

```text
固定长度 Ring

Descriptor 中保存 Next Descriptor 地址

Ring Length Register

End Of Ring Bit
```

等不同方式。

但从驱动开发角度，可以统一理解成：

> 一组可以不断循环复用的 DMA Descriptor。

---

## CPU 和 DMA 的所有权：OWN Bit

理解 Descriptor Ring 最重要的一个概念就是：

> OWN Bit。

OWN 可以理解成 Ownership，表示这个 Descriptor 当前归谁控制。

Ethernet Driver 和 DMA 会共享同一批 Descriptor。

因此必须避免出现：

```text
CPU 正在修改 Descriptor

同时

DMA 也正在读取 Descriptor
```

否则就可能发生数据竞争。

所以 Descriptor 中通常会设计一个 OWN Bit。

一种常见约定是：

```text
OWN = 0
    Descriptor 属于 CPU

OWN = 1
    Descriptor 属于 DMA
```

注意：

> OWN 的具体 0/1 定义必须以实际 Ethernet MAC 手册为准。

但很多 Synopsys Ethernet DMA 使用的确是类似：

```text
OWN = 1 → DMA
OWN = 0 → CPU
```

---

## TX 中 OWN Bit 的变化

例如 CPU 准备发送一个 Packet。

一开始：

```text
Descriptor 0

OWN = 0
```

表示：

```text
CPU 可以修改
```

CPU 设置：

```text
Buffer Address
Packet Length
FD
LD
Checksum
Interrupt
...
```

例如：

```text
Descriptor 0

Buffer Address = 0x80001000
Length         = 512
FD             = 1
LD             = 1
OWN            = 0
```

准备完成以后，CPU 最后设置：

```text
OWN = 1
```

表示：

> Descriptor 已经准备好了，现在交给 DMA。

于是：

```text
CPU
 │
 │ prepare descriptor
 │
 │ OWN = 1
 ↓
DMA
 │
 │ read descriptor
 │
 │ read packet buffer
 │
 │ transmit packet
 ↓
Ethernet MAC
```

DMA 完成以后，再把：

```text
OWN = 0
```

交还给 CPU。

整个生命周期：

```text
CPU owns Descriptor
        │
        │ prepare buffer + descriptor
        ↓
OWN = 1
        │
        ↓
DMA owns Descriptor
        │
        │ transmit
        ↓
OWN = 0
        │
        ↓
CPU owns Descriptor again
```

因此驱动发送 Packet 之前通常要先判断：

```c
if (desc->OWN == 1) {
    /* DMA still owns descriptor */
    return BUSY;
}
```

---

## 一个简单的 TX Ring 示例

假设现在有四个 TX Descriptor：

```text
TX Ring

+-----+     +-----+     +-----+     +-----+
| TX0 | --> | TX1 | --> | TX2 | --> | TX3 |
+-----+     +-----+     +-----+     +-----+
   ↑                                   |
   └───────────────────────────────────┘
```

CPU 连续发送三个 Packet：

```text
Packet A
Packet B
Packet C
```

可能变成：

```text
TX0 → Packet A → OWN = DMA

TX1 → Packet B → OWN = DMA

TX2 → Packet C → OWN = DMA

TX3 → Free     → OWN = CPU
```

DMA 按顺序处理：

```text
TX0
 ↓
TX1
 ↓
TX2
```

完成 TX0 后：

```text
TX0 → OWN = CPU
TX1 → OWN = DMA
TX2 → OWN = DMA
TX3 → OWN = CPU
```

CPU 就可以再次复用 TX0。

因此 Ring 的目的就是让：

```text
CPU 准备 Packet
```

和：

```text
DMA 发送 Packet
```

能够并行执行。

---

## TX Descriptor 中常见的控制位

不同 Ethernet MAC 的 Descriptor 格式并不完全相同。

但经常会看到：

```text
OWN
FD
LD
CIC
IOC
```

这些字段。

---

### OWN

OWN 表示 Descriptor 当前归 CPU 还是 DMA。

常见定义：

```text
OWN = 0
CPU owns descriptor

OWN = 1
DMA owns descriptor
```

驱动一般完成所有 Descriptor 配置之后，最后才设置 OWN。

例如：

```c
desc->buffer = buffer;
desc->length = length;

desc->FD = 1;
desc->LD = 1;
desc->IOC = 1;

/* 最后交给 DMA */
desc->OWN = 1;
```

这里“最后设置 OWN”非常重要。

因为一旦 OWN 交给 DMA，就应该认为 CPU 不再拥有这个 Descriptor。

---

### FD：First Descriptor

FD：

```text
First Descriptor
```

表示：

> 当前 Descriptor 是一个 Packet 的第一个 Descriptor。

为什么会需要这个 Bit？

因为一个 Ethernet Packet 并不一定只使用一个 Buffer。

例如一个 4000 Byte Packet 可能被分成：

```text
Descriptor 0 → Buffer 0 → 1500 Byte
Descriptor 1 → Buffer 1 → 1500 Byte
Descriptor 2 → Buffer 2 → 1000 Byte
```

这三个 Descriptor 实际上属于同一个 Packet：

```text
Descriptor 0
FD = 1
LD = 0

Descriptor 1
FD = 0
LD = 0

Descriptor 2
FD = 0
LD = 1
```

表示：

```text
                One Packet

FD                                      LD
↓                                       ↓
+----------+     +----------+     +----------+
| Desc 0   | --> | Desc 1   | --> | Desc 2   |
+----------+     +----------+     +----------+
| Buffer A |     | Buffer B |     | Buffer C |
+----------+     +----------+     +----------+
```

---

### LD：Last Descriptor

LD：

```text
Last Descriptor
```

表示：

> 当前 Descriptor 是一个 Packet 的最后一个 Descriptor。

所以：

```text
FD = 1
LD = 1
```

通常表示：

> 整个 Packet 只占一个 Descriptor。

例如一个普通 512 Byte Packet：

```text
Descriptor

FD = 1
LD = 1

        │
        ↓

+-------------------+
| 512 Byte Packet   |
+-------------------+
```

---

## 为什么一个 Packet 会使用多个 Descriptor

因为网络协议栈中的 Packet 本身就可能并不是连续的一整块内存。

例如一个 Packet 可能由：

```text
Ethernet Header
IP Header
TCP Header
Application Data
```

组成。

软件中也可能分别存储：

```text
Buffer A → Header
Buffer B → Payload
```

如果 DMA 支持 Scatter/Gather，就可以直接：

```text
Descriptor 0 → Buffer A
Descriptor 1 → Buffer B
```

而不必先：

```text
memcpy(Buffer A + Buffer B → 一个新的连续 Buffer)
```

于是：

```text
Descriptor 0
FD = 1
LD = 0
       ↓
Ethernet Header + IP Header

Descriptor 1
FD = 0
LD = 1
       ↓
Payload
```

DMA 会把它们作为一个完整 Packet 发送出去。

这种能力通常称为：

```text
Scatter / Gather DMA
```

对于网络协议栈实现零拷贝非常重要。

---

## CIC：Checksum Insertion Control

现代 Ethernet MAC 往往支持硬件 Checksum Offload。

例如 TCP/IP Packet 中存在：

```text
IPv4 Header Checksum

TCP Checksum

UDP Checksum
```

如果完全由 CPU 计算：

```text
CPU
 ↓
读取整个 Packet
 ↓
计算 Checksum
 ↓
写回 Header
 ↓
交给 DMA
```

会增加 CPU 开销。

因此很多 Ethernet MAC 可以直接在 DMA/MAC 中计算 Checksum。

Descriptor 中通常会提供类似：

```text
CIC
Checksum Insertion Control
```

的字段。

例如概念上可能支持：

```text
CIC = 00
不进行 Checksum Offload

CIC = 01
只处理 IP Header Checksum

CIC = 10
处理部分协议 Checksum

CIC = 11
处理完整 TCP / UDP / IP Checksum
```

具体编码取决于硬件 IP。

因此驱动只需要告诉 DMA：

```text
这个 Packet 需要硬件计算 Checksum。
```

例如：

```c
desc->CIC = CHECKSUM_IP_TCP_UDP;
```

然后 DMA/MAC 在发送过程中自动完成。

从软件角度，这属于：

> Hardware Offload。

---

## IOC：Interrupt On Completion

如果 CPU 每发送一个 Packet 都不断轮询：

```c
while (desc->OWN == 1) {
}
```

效率显然非常低。

所以 DMA 可以在完成 Descriptor 后产生中断。

Descriptor 中常见：

```text
IOC
Interrupt On Completion
```

例如：

```text
IOC = 1
```

表示：

> 当前 Descriptor 处理完成以后产生中断。

于是流程变成：

```text
CPU
 │
 │ Submit Packet
 ↓
DMA
 │
 │ Transmit Packet
 ↓
TX Complete
 │
 │ Interrupt
 ↓
CPU IRQ Handler
```

CPU 就不需要一直等待 DMA。

---

# RX Descriptor

TX 的过程是：

```text
Memory
  ↓
DMA
  ↓
Ethernet MAC
  ↓
Network
```

RX 刚好相反：

```text
Network
  ↓
Ethernet MAC
  ↓
DMA
  ↓
Memory
```

但 RX 有一个很重要的问题：

> Packet 到达之前，CPU 并不知道它什么时候来。

所以 CPU 必须提前准备好 Buffer。

例如：

```text
RX Descriptor 0 → Buffer 0

RX Descriptor 1 → Buffer 1

RX Descriptor 2 → Buffer 2

RX Descriptor 3 → Buffer 3
```

并且把这些 Descriptor 提前交给 DMA。

---

## RX Ring 的初始化

CPU 初始化：

```text
RX0 → Buffer0 → OWN = DMA
RX1 → Buffer1 → OWN = DMA
RX2 → Buffer2 → OWN = DMA
RX3 → Buffer3 → OWN = DMA
```

表示：

> 如果 Ethernet Packet 到达，你可以直接把数据写进这些 Buffer。

所以刚初始化完成的时候可能是：

```text
CPU

       RX Descriptor Ring

        OWN = DMA
           ↓
        +------+
        | RX0  | → Buffer0
        +------+
           ↓
        +------+
        | RX1  | → Buffer1
        +------+
           ↓
        +------+
        | RX2  | → Buffer2
        +------+
           ↓
        +------+
        | RX3  | → Buffer3
        +------+
           │
           └──────────→ RX0
```

---

## Packet 到达以后发生什么

假设来了一个：

```text
128 Byte Ethernet Frame
```

DMA 找到 RX0：

```text
RX0
OWN = DMA
```

于是：

```text
Ethernet MAC
      ↓
DMA
      ↓
Buffer0
```

把 Packet 写入 Buffer0。

然后 DMA 更新 Descriptor：

```text
Packet Length = 128
FD = 1
LD = 1
Status = OK
```

最后：

```text
OWN = CPU
```

于是：

```text
RX0
OWN = CPU
Length = 128
```

驱动看到：

```c
if (desc->OWN == CPU) {
    process_packet(desc->buffer,
                   desc->packet_length);
}
```

处理完成以后，再把这个 Buffer 还给 DMA：

```c
desc->OWN = DMA;
```

于是 RX Descriptor 又可以接收新的 Packet。

完整生命周期：

```text
CPU 准备 RX Buffer
       ↓
OWN = DMA
       ↓
等待 Packet
       ↓
DMA 写入 Packet
       ↓
DMA 更新 Length / Status
       ↓
OWN = CPU
       ↓
CPU / Network Stack 处理 Packet
       ↓
重新准备 Buffer
       ↓
OWN = DMA
```

---

## RX Descriptor 中常见字段

RX Descriptor 中经常可以看到：

```text
OWN
FD
LD
PL
Buffer Address
Buffer Valid
Error Status
```

---

### RX OWN

RX OWN 与 TX 的核心含义一致：

```text
OWN = DMA
```

表示：

> DMA 可以向这个 Buffer 写 Packet。

而：

```text
OWN = CPU
```

意味着：

> DMA 已经完成了这个 Descriptor，CPU 可以读取 Buffer。

---

### RX FD 和 LD

RX Packet 同样可能跨越多个 Buffer。

例如：

```text
RX Buffer Size = 1024 Byte

Incoming Packet = 1500 Byte
```

一个 Buffer 放不下。

DMA 可能使用：

```text
RX Descriptor 0
FD = 1
LD = 0
Length ≈ 1024

RX Descriptor 1
FD = 0
LD = 1
Length ≈ Remaining Data
```

于是驱动知道：

```text
RX0 + RX1
```

属于同一个 Ethernet Frame。

可以理解成：

```text
              Ethernet Packet

        +---------------------+
        |                     |
        ↓                     ↓

+---------------+     +---------------+
| RX Desc 0     |     | RX Desc 1     |
| FD = 1        |     | LD = 1        |
+---------------+     +---------------+
        ↓                     ↓
+---------------+     +---------------+
| RX Buffer 0   |     | RX Buffer 1   |
+---------------+     +---------------+
```

---

### PL：Packet Length

PL：

```text
Packet Length
```

通常由 DMA 在接收完成之后写入 Descriptor。

例如收到：

```text
Ethernet Frame Length = 512 Byte
```

DMA 完成之后可能得到：

```text
OWN = CPU
FD = 1
LD = 1
PL = 512
```

于是驱动就可以知道：

```c
length = desc->PL;
```

Buffer 中前：

```text
512 Byte
```

才是有效数据。

---

## Buffer Valid

一些 Ethernet DMA Descriptor 允许一个 Descriptor 指向一个或多个 Buffer。

于是可能存在类似：

```text
Buffer 1 Valid

Buffer 2 Valid
```

的控制位。

其含义通常是告诉 DMA：

> 当前 Descriptor 中对应的 Buffer 地址是否有效。

例如：

```text
Descriptor

Buffer1 Address = 0x80001000
Buffer1 Valid   = 1

Buffer2 Address = 0x00000000
Buffer2 Valid   = 0
```

表示只使用 Buffer1。

不同 Ethernet DMA IP 的定义会有所区别，因此这里重点理解：

> Descriptor 不仅保存 Buffer 地址，还会保存 DMA 如何解释和使用这些 Buffer 的控制信息。

---

# TX 和 RX Ring 的区别

TX 和 RX Descriptor Ring 从结构上很类似：

```text
TX Ring
Descriptor → Buffer

RX Ring
Descriptor → Buffer
```

但二者最重要的区别是数据流方向。

TX：

```text
CPU / Network Stack
        ↓
Memory Buffer
        ↓
DMA
        ↓
Ethernet MAC
```

RX：

```text
Ethernet MAC
        ↓
DMA
        ↓
Memory Buffer
        ↓
CPU / Network Stack
```

所以 TX 是：

```text
CPU 准备数据
→ 交给 DMA
→ DMA 发送
```

而 RX 是：

```text
CPU 准备空 Buffer
→ 交给 DMA
→ DMA 填入数据
→ CPU 处理
```

---

# TX Ring 满了会怎么样

假设只有四个 TX Descriptor：

```text
TX0 OWN = DMA
TX1 OWN = DMA
TX2 OWN = DMA
TX3 OWN = DMA
```

此时所有 Descriptor 都正在被 DMA 使用。

CPU 再尝试发送：

```text
Packet E
```

就没有空闲 Descriptor 了。

这时就是：

```text
TX Ring Full
```

驱动可能：

```c
return ERR_MEM;
```

或者：

```c
return BUSY;
```

也可能暂时停止协议栈继续发送。

因此：

```text
Descriptor Ring Size
```

会直接影响 Ethernet Driver 的缓存能力。

Ring 太小：

```text
容易出现 TX Ring Full
容易出现 RX Buffer 不够
```

Ring 太大：

```text
占用更多内存
```

所以这本质上是：

> 内存占用和吞吐能力之间的权衡。

---

# RX Ring 没有 Buffer 会怎么样

RX 的情况更加危险。

假设：

```text
RX0 OWN = CPU
RX1 OWN = CPU
RX2 OWN = CPU
RX3 OWN = CPU
```

意味着：

> CPU 还没有处理完这些 Packet，也没有把 Descriptor 重新交给 DMA。

这时新的 Packet 到达，但是：

```text
没有 OWN = DMA 的 RX Descriptor
```

DMA 就没有地方存储新的 Packet。

可能产生：

```text
RX Buffer Unavailable

RX Descriptor Unavailable

RX Overflow

Packet Drop
```

因此 RX 驱动需要及时：

```text
处理 Packet
+
回收 RX Buffer
+
重新交给 DMA
```

---

# Descriptor Ring 中常见的两个指针

理解 Ring 时，可以抽象出两个角色：

```text
Producer
Consumer
```

例如 TX：

```text
CPU 是 Producer

DMA 是 Consumer
```

CPU 不断：

```text
产生新的 TX Descriptor
```

DMA 不断：

```text
消费 TX Descriptor
```

可以抽象成：

```text
        CPU Producer
             ↓

[0][1][2][3][4][5][6][7]
          ↑
          DMA Consumer
```

RX 则可以从不同角度理解：

```text
DMA 产生 Received Packet

CPU 消费 Received Packet
```

因此很多 Ethernet Driver 都会维护类似：

```c
tx_head;
tx_tail;

rx_head;
rx_tail;
```

这样的 Index。

即使具体变量名不同，其基本思想还是：

> 记录 CPU 和 DMA 当前处理到了 Ring 中的哪个位置。

---

# Interrupt Coalescing

如果每收到一个 Ethernet Packet 就产生一次中断：

```text
Packet 1 → IRQ
Packet 2 → IRQ
Packet 3 → IRQ
Packet 4 → IRQ
Packet 5 → IRQ
...
```

在高网络负载下，中断数量可能非常大。

例如：

```text
100000 Packet/s
```

如果：

```text
1 Packet = 1 Interrupt
```

就可能产生：

```text
100000 Interrupt/s
```

CPU 会频繁：

```text
进入中断
保存上下文
处理中断
恢复上下文
```

性能反而下降。

所以很多 Ethernet DMA 支持：

> Interrupt Coalescing

也就是中断聚合。

---

## Packet Count Coalescing

例如设置：

```text
每处理 8 个 RX Packet
产生一次中断
```

于是：

```text
Packet 1
Packet 2
Packet 3
Packet 4
Packet 5
Packet 6
Packet 7
Packet 8
    ↓
   IRQ
```

相比：

```text
8 个 IRQ
```

现在只需要：

```text
1 个 IRQ
```

---

## Timer Coalescing

另外一种方式是：

```text
最多等待 100 us
```

例如：

```text
Packet 1
Packet 2
Packet 3

        100 us
          ↓

         IRQ
```

于是 CPU 一次中断可以处理多个 Packet。

实际硬件可能同时使用：

```text
Packet Count Threshold

+

Timer Threshold
```

例如：

```text
收到 8 个 Packet

或者

等待超过 100 us

任何一个条件先满足就触发 IRQ
```

---

## Interrupt Coalescing 的权衡

Interrupt Coalescing 并不是越大越好。

如果设置：

```text
每 64 Packet 产生一次 IRQ
```

虽然 CPU 中断减少，但是第一个 Packet 可能需要等待更长时间。

所以存在一个典型权衡：

```text
中断频率低
        ↑
CPU 开销小
        ↑
Interrupt Coalescing 大
        ↓
Packet Latency 增加
```

反过来：

```text
Coalescing 小
        ↓
Latency 小
        ↓
Interrupt 多
        ↓
CPU 开销大
```

因此需要根据：

```text
吞吐量

实时性

CPU 负载
```

进行权衡。

车载系统尤其需要考虑实时性，因此不能只追求最高吞吐量。

---

# Polling 和 Interrupt

Ethernet Driver 并不一定完全依靠中断。

一种最简单的 RX 处理方式是：

```text
Packet 到达
 ↓
DMA IRQ
 ↓
CPU Interrupt Handler
 ↓
处理 Packet
```

但高速网络中也可能采用：

```text
Interrupt
   ↓
关闭/抑制后续 RX Interrupt
   ↓
Polling 一批 Descriptor
   ↓
处理多个 Packet
   ↓
重新打开 Interrupt
```

Linux NAPI 就是这种思想的一个典型实现。

它解决的是：

```text
低流量：
Interrupt 响应快

高流量：
Polling 效率高
```

虽然很多 MCU Ethernet Driver 不一定直接使用 NAPI，但理解这个思想对于阅读 Linux Ethernet Driver 很有帮助。

---

# 什么是 Copy Path

假设协议栈产生一个 Packet：

```text
Application Buffer
       ↓
TCP/IP Stack
       ↓
pbuf
```

但 DMA 要求使用自己固定的：

```text
DMA TX Buffer
```

那么驱动可能执行：

```c
memcpy(tx_dma_buffer,
       pbuf->payload,
       pbuf->len);
```

然后：

```text
lwIP pbuf
   │
   │ memcpy
   ↓
DMA TX Buffer
   │
   ↓
DMA Descriptor
   │
   ↓
Ethernet MAC
```

这就是比较典型的：

> Copy Path。

这种方式最大的优点是简单。

DMA Buffer 可以：

```text
提前分配
固定对齐
固定大小
统一管理 Cache
```

驱动实现比较容易。

缺点是：

```text
每发送一个 Packet
都需要 memcpy
```

对于高速网络来说，会增加：

```text
CPU 使用率
Memory Bandwidth
Latency
```

---

# 什么是 Zero-Copy

Zero-Copy 的目标是：

> 尽可能不复制 Packet 数据，而是让 DMA 直接使用协议栈现有的 Buffer。

例如：

```text
lwIP pbuf
   │
   └──────────────┐
                  ↓
             TX Descriptor
                  │
                  ↓
                 DMA
```

Descriptor 直接指向：

```text
pbuf->payload
```

于是不用：

```c
memcpy();
```

而是：

```c
desc->buffer = pbuf->payload;
desc->length = pbuf->len;
```

从概念上看：

```text
Copy Path

pbuf
 ↓
memcpy
 ↓
DMA Buffer
 ↓
DMA


Zero-Copy

pbuf
 ↓
DMA
```

---

# Zero-Copy 并不意味着完全没有数据搬运

这里很容易产生一个误解：

> Zero-Copy 是不是 Packet 一个字节都没有被复制？

并不是。

DMA 仍然需要：

```text
Memory → Ethernet MAC
```

或者：

```text
Ethernet MAC → Memory
```

搬运数据。

所谓 Zero-Copy 通常指的是：

> 减少 CPU 软件层额外执行的 memcpy。

例如避免：

```text
Network Stack Buffer
       ↓
     memcpy
       ↓
Driver DMA Buffer
```

这一层复制。

---

# Zero-Copy 为什么实现更复杂

Copy Path 很简单：

```text
协议栈 Buffer
和
DMA Buffer
```

是两套独立资源。

CPU 复制完成以后：

```text
协议栈可以立刻释放原 Buffer
```

因为 DMA 使用的是另外一块内存。

Zero-Copy 就不同了。

例如 TX：

```text
pbuf
 ↓
DMA
```

DMA 发送完成之前：

```text
pbuf 不能释放
```

否则可能出现：

```text
CPU 释放 pbuf
      ↓
内存被其他模块重新使用
      ↓
DMA 还在读取原地址
      ↓
发送错误数据
```

所以 Zero-Copy 必须解决：

```text
Buffer Lifetime
```

也就是 Buffer 生命周期问题。

可能需要：

```text
Reference Count

TX Complete Callback

Descriptor Reclaim
```

等机制。

---

# RX Zero-Copy

RX 的 Zero-Copy 更有代表性。

普通 Copy Path：

```text
Ethernet MAC
      ↓
DMA
      ↓
RX DMA Buffer
      │
      │ memcpy
      ↓
lwIP pbuf
      ↓
TCP/IP Stack
```

Zero-Copy：

```text
Ethernet MAC
      ↓
DMA
      ↓
RX Buffer
      │
      └─────────────→ lwIP pbuf
```

也就是说：

> DMA 收到 Packet 的那块 Buffer，直接交给协议栈。

于是省去了：

```c
memcpy();
```

但是这又引入一个问题。

原来的 RX Descriptor：

```text
RX Descriptor
     ↓
RX Buffer A
```

Buffer A 被交给协议栈以后：

```text
Buffer A 暂时不能重新交给 DMA
```

否则：

```text
协议栈还在读取 Buffer A

DMA 又把新的 Packet 写入 Buffer A
```

数据就会被覆盖。

所以 RX Zero-Copy 通常需要：

```text
Buffer Pool
```

例如：

```text
RX Descriptor
     ↓
Buffer A
```

收到 Packet 后：

```text
Buffer A → Network Stack

Buffer B → 补充给 RX Descriptor
```

等协议栈释放 Buffer A：

```text
Buffer A → Buffer Pool
```

之后再循环使用。

---

# Buffer Pool

因此真实的 Ethernet Driver 中，经常不仅仅存在：

```text
Descriptor Ring
```

还会存在：

```text
Buffer Pool
```

可以把它理解成：

```text
Descriptor Ring
负责描述 DMA 工作

Buffer Pool
负责提供真正的数据内存
```

例如：

```text
Buffer Pool

Buffer0
Buffer1
Buffer2
Buffer3
Buffer4
Buffer5
Buffer6
Buffer7
```

RX Descriptor 可能暂时绑定：

```text
RX0 → Buffer0
RX1 → Buffer1
RX2 → Buffer2
RX3 → Buffer3
```

剩下：

```text
Buffer4
Buffer5
Buffer6
Buffer7
```

作为备用 Buffer。

当：

```text
Buffer0
```

交给协议栈以后，可以把：

```text
Buffer4
```

补给 RX0。

---

# Cache Coherency

学习 Ethernet DMA 时，还有一个非常重要但很容易忽略的问题：

> CPU Cache。

因为 DMA 和 CPU 都会访问同一块内存。

假设 CPU 修改了：

```text
TX Buffer
```

但数据只存在 CPU Cache 中，还没有真正写回 RAM：

```text
CPU
 ↓
Cache
 │
 │ 尚未写回
 ↓
Memory
```

DMA 并不会自动读取 CPU Cache。

它可能直接从 Memory 中读取旧数据：

```text
DMA
 ↓
Memory
```

于是发送出去的可能还是旧 Packet。

---

## TX Cache 问题

例如：

```text
Memory 中：

AA BB CC DD

CPU 修改 Buffer：

11 22 33 44
```

但 CPU 只修改了 Cache：

```text
CPU Cache
11 22 33 44

Memory
AA BB CC DD
```

DMA 读取：

```text
AA BB CC DD
```

就发生错误。

因此在非 Cache-Coherent 系统上，TX 之前通常需要：

```text
Cache Clean / Flush
```

把 CPU Cache 中的数据写回 Memory。

概念流程：

```text
CPU write TX Buffer
        ↓
Clean D-Cache
        ↓
Memory contains new data
        ↓
OWN = DMA
        ↓
DMA reads Buffer
```

---

# RX Cache 问题

RX 方向相反。

DMA 已经把新 Packet 写进 Memory：

```text
Memory
11 22 33 44
```

但 CPU Cache 中可能还缓存着旧数据：

```text
CPU Cache
AA BB CC DD
```

CPU 如果直接读 Cache：

```text
AA BB CC DD
```

同样会出错。

所以 RX 完成以后通常需要：

```text
Cache Invalidate
```

让 CPU 下次重新从 Memory 读取 DMA 写入的新数据。

典型流程：

```text
DMA writes RX Buffer
        ↓
OWN = CPU
        ↓
Invalidate D-Cache
        ↓
CPU reads new Packet
```

---

# Descriptor 本身也有 Cache 问题

不仅 Packet Buffer 需要考虑 Cache。

Descriptor 本身同样是：

```text
CPU
和
DMA
```

共享的数据结构。

例如 CPU 写：

```text
Buffer Address
Length
FD
LD
OWN
```

如果这些修改只停留在 Cache：

```text
DMA 看到的 Descriptor
```

仍然可能是旧内容。

因此 Descriptor 的内存经常需要：

```text
Non-cacheable Memory

或者

显式 Cache Maintenance
```

实际驱动中经常会看到：

```text
Cache Clean
Cache Invalidate
Memory Barrier
```

这些操作。

它们与 Descriptor Ring 的正确工作密切相关。

---

# 为什么 OWN 通常最后设置

假设 CPU 这样写 Descriptor：

```c
desc->OWN = 1;

desc->buffer = buffer;
desc->length = length;
```

这里存在一个风险。

CPU 一旦执行：

```text
OWN = DMA
```

DMA 就可能立即开始读取 Descriptor。

此时 CPU 可能还没有写完：

```text
buffer
length
FD
LD
```

于是 DMA 看到一个只配置了一半的 Descriptor。

正确的思想应该是：

```c
desc->buffer = buffer;
desc->length = length;

desc->FD = 1;
desc->LD = 1;

/* memory barrier / cache clean */

desc->OWN = 1;
```

也就是：

> 先把 Descriptor 的所有内容准备完成，最后再把 Ownership 交给 DMA。

因此 OWN 实际上不仅仅是一个普通 Bit。

它也是：

```text
CPU 与 DMA 之间非常重要的同步边界。
```

---

# Memory Barrier

即使代码写的是：

```c
desc->buffer = buffer;
desc->length = len;
desc->OWN = 1;
```

现代 CPU、编译器和总线系统也可能存在：

```text
编译器重排

CPU Store Buffer

Memory Ordering
```

等问题。

所以底层驱动有时需要使用：

```text
Memory Barrier
```

保证：

```text
Buffer Address
Length
Control
```

等字段真正对 DMA 可见以后，才更新：

```text
OWN
```

逻辑上希望保证：

```text
Descriptor 内容全部完成
        ↓
Memory Barrier
        ↓
OWN = DMA
```

而不是：

```text
OWN = DMA

Descriptor 其他字段还没有真正对 DMA 可见
```

这也是为什么 DMA Driver 经常会涉及：

```text
Cache
Memory Barrier
Memory Alignment
```

这些看起来和 Ethernet 协议无关的底层概念。

---

# Descriptor Alignment

DMA Descriptor 通常还会有地址对齐要求。

例如硬件可能要求：

```text
Descriptor Address
```

按照：

```text
4 Byte

8 Byte

16 Byte

32 Byte

Cache Line
```

对齐。

因此驱动中经常能看到：

```c
__attribute__((aligned(32)))
struct dma_desc rx_desc[RX_DESC_NUM];
```

或者：

```c
ALIGN(32)
```

这样的定义。

原因可能包括：

```text
DMA Bus Access

Cache Line

硬件 Descriptor Fetch 机制
```

所以 Descriptor Ring 通常不能随意放在任意地址。

---

# DMA Descriptor 的完整 TX 生命周期

现在可以把 TX 整个过程串起来。

假设协议栈准备了一个 Packet：

```text
Application
    ↓
TCP / UDP
    ↓
IP
    ↓
Ethernet
    ↓
Packet Buffer
```

驱动找到一个空闲 TX Descriptor：

```text
OWN = CPU
```

然后：

```text
1. 设置 Buffer 地址
2. 设置 Buffer 长度
3. 设置 FD / LD
4. 设置 Checksum Offload
5. 设置 IOC
6. Clean Cache
7. Memory Barrier
8. 设置 OWN = DMA
9. 通知 DMA 有新的 Descriptor
```

DMA：

```text
10. Fetch Descriptor
11. 读取 Buffer
12. Ethernet MAC 发送 Packet
13. 更新 TX Status
14. OWN = CPU
15. 可选产生 Interrupt
```

CPU 收到 TX Complete 后：

```text
16. 回收 Descriptor
17. 释放或者减少 Buffer Reference
18. Descriptor 可以再次使用
```

可以总结成：

```text
Network Stack
     ↓
Packet Buffer
     ↓
TX Descriptor
     ↓
OWN = DMA
     ↓
DMA
     ↓
Ethernet MAC
     ↓
PHY
     ↓
Network

发送完成

DMA
 ↓
OWN = CPU
 ↓
Driver Reclaim
 ↓
Descriptor Reuse
```

---

# DMA Descriptor 的完整 RX 生命周期

RX 初始化阶段：

```text
1. 分配 RX Buffer
2. Descriptor 指向 Buffer
3. 设置 Buffer Size
4. Clean / Invalidate Cache
5. OWN = DMA
```

Packet 到达：

```text
Network
 ↓
PHY
 ↓
Ethernet MAC
 ↓
DMA
 ↓
RX Buffer
```

DMA：

```text
6. 写入 Packet
7. 设置 FD / LD
8. 设置 Packet Length
9. 设置 Status
10. OWN = CPU
11. 产生 RX Interrupt
```

CPU：

```text
12. 检查 OWN
13. Invalidate Cache
14. 获取 Packet Length
15. 检查 Error Status
16. 把 Packet 交给 Network Stack
17. 回收或者替换 Buffer
18. OWN = DMA
```

然后 Descriptor 再次等待下一个 Packet。

---

# 一个简化的 TX 伪代码

忽略具体硬件寄存器，一个 TX Driver 可以抽象成：

```c
int ethernet_tx(void *buffer, uint32_t length)
{
    struct dma_desc *desc;

    desc = &tx_ring[tx_index];

    /* Descriptor 还在 DMA 手中 */
    if (desc->OWN == DMA_OWN) {
        return TX_BUSY;
    }

    desc->buffer_addr = (uint32_t)buffer;
    desc->length = length;

    desc->FD = 1;
    desc->LD = 1;

    desc->CIC = CHECKSUM_ENABLE;
    desc->IOC = 1;

    cache_clean(buffer, length);
    memory_barrier();

    /*
     * 所有内容配置完成以后
     * 最后交给 DMA
     */
    desc->OWN = DMA_OWN;

    tx_index =
        (tx_index + 1) % TX_DESC_NUM;

    dma_tx_kick();

    return TX_OK;
}
```

这里只需要抓住：

```text
找 Descriptor

↓

准备 Buffer

↓

配置 Descriptor

↓

Cache / Barrier

↓

OWN = DMA

↓

通知 DMA
```

这个基本流程。

---

# 一个简化的 RX 伪代码

RX 可以抽象成：

```c
int ethernet_rx(void)
{
    struct dma_desc *desc;

    desc = &rx_ring[rx_index];

    /*
     * OWN 仍然属于 DMA
     * 说明暂时没有收到 Packet
     */
    if (desc->OWN == DMA_OWN) {
        return RX_EMPTY;
    }

    cache_invalidate(desc->buffer_addr,
                     desc->packet_length);

    if (desc->error) {
        drop_packet(desc);
    } else {
        network_input(desc->buffer_addr,
                      desc->packet_length);
    }

    /*
     * CPU 处理完成
     * 重新把 Buffer 交给 DMA
     */
    memory_barrier();
    desc->OWN = DMA_OWN;

    rx_index =
        (rx_index + 1) % RX_DESC_NUM;

    return RX_OK;
}
```

真实的 Zero-Copy RX 会比这个复杂，因为：

```text
network_input()
```

返回以后，协议栈可能仍然在使用 Buffer。

此时不能立即：

```text
OWN = DMA
```

而是需要更完善的 Buffer 生命周期管理。

---

# 从软件角度理解 Descriptor Ring

到这里，可以把 Ethernet DMA Ring 抽象成三个部分：

```text
             Ethernet Driver

                   │
        ┌──────────┴──────────┐
        │                     │
        ↓                     ↓
  TX Descriptor Ring    RX Descriptor Ring
        │                     │
        ↓                     ↓
   TX Buffer Pool        RX Buffer Pool
        │                     ↑
        ↓                     │
       DMA ←────────────→ Ethernet MAC
                               │
                               ↓
                              PHY
```

Descriptor 负责：

```text
数据在哪里

数据有多长

Packet 从哪里开始

Packet 在哪里结束

是否需要 Checksum

是否需要 Interrupt

当前归 CPU 还是 DMA
```

Buffer 负责：

```text
真正存放 Ethernet Frame 数据
```

Ring 负责：

```text
让多个 Descriptor 可以持续循环工作
```

OWN 负责：

```text
协调 CPU 和 DMA 对 Descriptor 的访问
```

---

# Copy 和 Zero-Copy 对比

可以简单总结成：

| 特性                | Copy Path | Zero-Copy |
| ----------------- | --------- | --------- |
| Driver 中是否 memcpy | 通常需要      | 尽量避免      |
| 实现复杂度             | 低         | 高         |
| Buffer 生命周期管理     | 简单        | 复杂        |
| Cache 管理          | 相对简单      | 更重要       |
| CPU 开销            | 较高        | 较低        |
| 内存带宽消耗            | 较高        | 较低        |
| 性能                | 一般        | 较好        |
| 调试难度              | 较低        | 较高        |

因此在 MCU 项目中，并不是：

```text
Zero-Copy 一定比 Copy 好。
```

如果：

```text
网络流量很低

CPU 性能足够

实时性要求不高

驱动希望简单可靠
```

Copy Path 完全可能是更合适的选择。

而对于：

```text
Gigabit Ethernet

大量 Packet

高 CPU Load

高吞吐要求
```

Zero-Copy 的价值就会更加明显。

---

# 中断聚合、Ring Size 和 Zero-Copy 的关系

学习 Ethernet DMA 时，可以发现很多配置最终都在做同一件事情：

> 在实时性、CPU 开销、内存占用和吞吐量之间做权衡。

例如：

```text
Ring Size 增大
    ↓
缓存 Packet 能力增强
    ↓
内存占用增加
```

```text
Interrupt Coalescing 增大
    ↓
Interrupt 数量减少
    ↓
CPU Load 降低
    ↓
Latency 可能增加
```

```text
Zero-Copy
    ↓
memcpy 减少
    ↓
CPU Load 降低
    ↓
Buffer 管理复杂度增加
```

因此 Ethernet Driver 并不仅仅是：

```text
把 Packet 发出去
```

更重要的是如何高效地协调：

```text
CPU

DMA

Memory

Cache

Ethernet MAC

Network Stack
```

---

# 如何建立整体认识

刚开始阅读 Ethernet DMA Driver 时，可以先不要纠结某个 Descriptor 的每一个 Bit。

先尝试回答下面几个问题：

```text
1. TX Descriptor Ring 在哪里？

2. RX Descriptor Ring 在哪里？

3. 每个 Descriptor 指向哪个 Buffer？

4. OWN = 0 / 1 分别代表 CPU 还是 DMA？

5. CPU 在什么时候把 Descriptor 交给 DMA？

6. DMA 在什么时候把 Descriptor 还给 CPU？

7. 一个 Packet 能不能跨多个 Descriptor？

8. FD / LD 如何表示一个完整 Packet？

9. TX Complete 后谁负责释放 Buffer？

10. RX Packet 被协议栈使用期间，Buffer 能不能重新交给 DMA？

11. DMA Buffer 是否需要 Cache Clean / Invalidate？

12. Descriptor Ring 满或者 RX Buffer 耗尽时会发生什么？
```

只要这几个问题能够回答清楚，基本就已经掌握了 Ethernet DMA Descriptor Ring 的主要工作原理。

之后再去看具体芯片中的：

```text
TX Descriptor Word0
TX Descriptor Word1
TX Descriptor Word2
TX Descriptor Word3

RX Descriptor Word0
RX Descriptor Word1
RX Descriptor Word2
RX Descriptor Word3
```

就不会只看到一堆没有意义的 Bit Mask，而是能够知道：

```text
这些 Bit 最终是在描述 Packet、

控制 DMA、

以及协调 CPU 与 DMA 的所有权。
```

---

## 总结

Ethernet MAC 中使用 DMA 的核心目的，是避免 CPU 亲自完成大块 Packet 数据搬运。

CPU 和 DMA 之间通过：

```text
DMA Descriptor
```

交换控制信息。

一个 Descriptor 通常记录：

```text
Buffer Address
Buffer Length
Packet Boundary
Checksum Control
Interrupt Control
DMA Status
Ownership
```

多个 Descriptor 首尾相连形成：

```text
Descriptor Ring
```

从而让 CPU 与 DMA 可以流水线工作。

其中最重要的概念是：

```text
OWN
```

它定义了 Descriptor 当前属于：

```text
CPU

还是

DMA
```

TX 的基本流程是：

```text
CPU 准备 Packet
→ 配置 TX Descriptor
→ OWN = DMA
→ DMA 发送
→ OWN = CPU
→ CPU 回收 Descriptor
```

RX 的基本流程是：

```text
CPU 准备空 Buffer
→ OWN = DMA
→ DMA 接收 Packet
→ OWN = CPU
→ CPU / Network Stack 处理
→ Buffer 回收
→ OWN = DMA
```

在这个基础上，又进一步产生：

```text
FD / LD
    一个 Packet 如何跨多个 Descriptor

CIC
    硬件 Checksum Offload

IOC
    DMA 完成后是否产生 Interrupt

Interrupt Coalescing
    如何降低高网络负载下的中断开销

Zero-Copy
    如何减少 Network Stack 与 DMA Buffer 之间的 memcpy
```

最终可以把 Ethernet DMA 的基本工作模式概括为：

```text
            Descriptor
CPU  ─────────────────────→ DMA
      地址 / 长度 / 控制

CPU  ←───────────────────── DMA
      状态 / 完成 / OWN

                │
                ↓

              Buffer

                │
                ↓

          Ethernet MAC
                │
                ↓
               PHY
```

理解 Descriptor Ring 之后，再去阅读具体 Ethernet MAC 驱动，最重要的就不再是记住某一个 Bit 位于 Word2 的 Bit 29，而是去寻找：

```text
这个 Descriptor 在什么时候被创建？

什么时候属于 CPU？

什么时候交给 DMA？

它指向哪个 Buffer？

一个 Packet 是如何从 Network Stack 一路流向 DMA 和 MAC 的？
```

把这条数据流理清以后，Ethernet DMA 驱动的整体结构就会清晰很多。







