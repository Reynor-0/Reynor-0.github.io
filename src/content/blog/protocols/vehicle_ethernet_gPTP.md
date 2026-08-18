---
title: '车载以太网（七）：gPTP / IEEE 802.1AS 时间同步'
description: '去理解为什么需要时间同步，时间同步又是怎么做的'
category: '协议'
series: { id: 'vehicle-ethernet', order: 7 }
tags: ['Ethernet', 'gPTP', '时间同步', 'IEEE 802.1AS', '汽车电子']
pubDate: 'Jun 08 2026'
updatedDate: 'Aug 09 2026'
---
# gPTP / IEEE 802.1AS 时间同步

在普通 Ethernet 通信中，我们通常关心数据有没有正确发送、Packet 有没有丢、网络延迟是多少、带宽够不够。但在车载网络、工业控制、音视频同步以及 TSN 中，还存在另外一个非常重要的问题：

> 网络中的不同 ECU，怎么知道“现在几点”？

假设一辆车上同时存在 Camera ECU、Radar ECU、ADAS ECU、Domain Controller 和 Gateway，它们内部都有各自独立的本地时钟。

假设 Camera 在 `10:00:00.100000000` 采集了一帧图像，Radar 也在 `10:00:00.100000000` 采集了一组点云。从日志上看，这两个事件似乎发生在完全相同的时刻。

但如果 Camera ECU 和 Radar ECU 的本地时钟本身就相差 1 ms，那么这两个看起来完全相同的时间戳，实际上对应的是两个不同的真实时刻。

对于 Sensor Fusion 来说，这意味着我们可能把 `t = 100 ms` 时刻的 Camera 图像和 `t = 101 ms` 时刻的 Radar 点云错误地认为是同一个时刻的数据。车辆速度越高，这种时间误差最终越可能表现为空间位置上的误差。

因此，车载 Ethernet 除了需要解决“数据怎么传”，还需要解决“整个网络中的时间怎么统一”。

这就是 gPTP 和 IEEE 802.1AS 所要解决的问题。

---

## 为什么不同 ECU 的时间会越来越不一样

首先需要理解一个非常基础的问题：为什么两个 ECU 的时钟不能天然保持一致？

假设 ECU A 和 ECU B 内部各自都有一个晶振。理想情况下，真实世界过去 1 秒，ECU A 和 ECU B 都应该刚好过去 1 秒。

但现实中的晶振不可能完全准确。例如：

```text
真实时间：1.000000 s
ECU A：   1.000000 s
ECU B：   1.000020 s
```

那么 ECU B 每经过真实世界的 1 秒，就会比 ECU A 多走 `20 us`，也就是大约 `20 ppm`。

这里的 ppm 是 Parts Per Million：

```text
20 ppm = 20 / 1,000,000
```

这意味着即使启动的时候两个 ECU 的时间完全一样，只要运行一段时间，它们之间仍然会逐渐产生越来越大的时间差。

因此时间同步实际上需要解决两个问题：

* **Frequency Offset**：两个时钟走得快慢不一样。
* **Phase Offset / Time Offset**：两个时钟当前显示的时间不一样。

---

## Phase Offset 和 Frequency Offset

可以把一个本地时钟简单表示为：

$$
LocalClock(t)=\alpha t+\beta
$$

其中，$\alpha$ 表示这个时钟走得快还是慢，而 $\beta$ 表示当前时间整体偏移了多少。

假设 Grandmaster 的时间为：

$$
GM(t)=t
$$

某个 Slave 的本地时钟为：

$$
Slave(t)=1.000020t+0.001
$$

其中 `1.000020` 表示 Slave 的时钟速度比 Grandmaster 快大约 `20 ppm`，而 `0.001` 表示它还存在 `1 ms` 的初始时间偏差。

因此时间同步可以进一步拆成两个目标。

### Frequency Synchronization

Frequency Synchronization 解决的是：

> 两个时钟走得是否一样快？

也就是尽量让：

$$
\alpha \rightarrow 1
$$

假设某一瞬间我们强行把两个时钟调整成完全一致：

```text
GM     = 10:00:00.000
Slave  = 10:00:00.000
```

但 Slave 的晶振仍然快 `20 ppm`，那么过一段时间以后，两者还是会重新产生偏差。

因此，仅仅把时间“对齐一次”是不够的，还需要不断修正两个 Clock 的频率关系。

### Phase Synchronization

Phase Synchronization 解决的是：

> 两个时钟当前是不是指向同一个时间？

也就是让：

$$
\beta \rightarrow 0
$$

最终我们希望达到类似：

```text
GM     = 10:00:00.123456789
Slave  = 10:00:00.123456790
```

这样的状态。

所以可以简单理解为：

* Frequency Synchronization 负责让两个 Clock **走得一样快**。
* Phase Synchronization 负责让两个 Clock **当前显示的时间一致**。

这个区别非常重要，因为后面 Servo Controller 不仅需要处理当前的 Offset，还需要持续调整 Clock Frequency。

---

## PTP 到底在做什么

PTP 全称 Precision Time Protocol。

它的核心思想其实并不复杂：

> 在网络中选择一个可靠的时钟作为时间参考，其他设备不断测量自己与这个参考时钟之间的差异，然后持续调整自己的本地时钟。

整个网络中最顶层的参考时钟通常称为 **Grandmaster**，简称 **GM**。可以把它理解为整个时间同步网络中的时间源。

如果把整个过程极度简化，可以理解成：

```text
Grandmaster
     │
     │ 提供参考时间
     ↓
   Slave
     │
     │ 计算时间偏差
     ↓
   Offset
     │
     ↓
   Servo
     │
     ↓
调整本地 Clock
```

但这里马上会遇到一个问题。

假设 Grandmaster 在 `1,000,000 ns` 时发送一个 Packet，Slave 在自己的 `1,000,500 ns` 时收到它。这并不能说明 Slave 比 Grandmaster 快 `500 ns`，因为这个 Packet 本身也需要时间在 Ethernet Link 上传播。

所以，要进行精确时间同步，至少需要知道两个信息：

1. Grandmaster 发送这个 Packet 的准确时间是多少？
2. Packet 从对端传到本地花了多长时间？

在 gPTP 中，可以先简单理解为：

* **Pdelay** 负责回答：“这一段 Link 有多长？”
* **Sync / Follow_Up** 负责回答：“参考时间是多少？”

知道这两个信息以后，Slave 才能够进一步计算自己的 Clock Offset。

---

## IEEE 1588 和 IEEE 802.1AS

PTP 最主要的标准来源是 IEEE 1588。

IEEE 1588 是一套比较通用的精确时间同步协议，可以应用于工业网络、通信设备、测试仪器、Ethernet、UDP/IP 等很多不同场景。

不同应用领域还可以在 IEEE 1588 的基础上定义自己的 PTP Profile，用来约束具体使用哪些报文、使用什么同步周期、采用什么 Delay Measurement 机制以及使用怎样的 Clock Selection 规则等。

IEEE 802.1AS 则可以理解为面向局域网、Bridged Ethernet 和 TSN 场景定义的一套更加严格的时间同步规范。IEEE 802.1AS 中使用的时间同步机制通常被称为 **gPTP（generalized Precision Time Protocol）**。

从概念上可以简单理解为：

```text
IEEE 1588
   │
   │ 提供通用 PTP 机制
   ↓
IEEE 802.1AS
   │
   │ 对 LAN / TSN 场景中的使用方式进行约束
   ↓
gPTP
```

因此，IEEE 802.1AS 并不是一套完全独立于 PTP 的协议，它大量复用了 IEEE 1588 中关于 Timestamp、Sync、Follow_Up、Clock Dataset、Best Master Clock Algorithm 等机制。

---

## 为什么 gPTP 要逐跳测量 Link Delay

IEEE 1588 中存在不同的 Delay Measurement Mechanism，例如 E2E（End-to-End）和 P2P（Peer-to-Peer）。

在常见的全双工 Ethernet 场景中，IEEE 802.1AS 主要采用 Peer-to-Peer Delay Measurement。它的核心思想是：

> 每一段直接相连的 Ethernet Link，都分别测量自己的链路传播延迟。

例如网络拓扑为：

```text
GM
 │
 │ Link 1
 ↓
Switch A
 │
 │ Link 2
 ↓
Switch B
 │
 │ Link 3
 ↓
ECU
```

gPTP 并不是直接去测量 GM 到 ECU 总共需要多长时间，而是分别测量：

```text
GM       ↔ Switch A
Switch A ↔ Switch B
Switch B ↔ ECU
```

每一段 Link 都维护自己的 `meanLinkDelay`。

因此，每一个 gPTP Port 都需要知道：

> 我和直接相邻的设备之间，Packet 单向传播大约需要多长时间？

而这个测量过程就是 Pdelay。

---

## Pdelay：测量相邻设备之间的链路延迟

gPTP 中用于测量相邻两个节点之间链路传播延迟的主要报文包括：

* `Pdelay_Req`
* `Pdelay_Resp`
* `Pdelay_Resp_Follow_Up`

假设 Node A 和 Node B 直接相连：

```text
Node A                         Node B

  |                              |
  | Pdelay_Req                   |
  |----------------------------->|
 t1                             t2
  |                              |
  |        Pdelay_Resp           |
  |<-----------------------------|
 t4                             t3
  |                              |
  |   Pdelay_Resp_Follow_Up      |
  |<-----------------------------|
  |                              |
```

这里会产生四个非常重要的时间戳：

* `t1`：Pdelay_Req 真正离开 Node A 的时间。
* `t2`：Pdelay_Req 到达 Node B 的时间。
* `t3`：Pdelay_Resp 真正离开 Node B 的时间。
* `t4`：Pdelay_Resp 到达 Node A 的时间。

对于 Node A 来说：

$$
t_4-t_1
$$

表示从发送 Pdelay_Req 到收到 Pdelay_Resp 的整个时间。

但这个时间不仅包含网络传播时间，还包含 Node B 收到 Req 之后等待并发送 Resp 所花费的时间：

$$
t_3-t_2
$$

因此，如果暂时忽略两个节点之间的 Clock Rate 差异，并假设链路两个方向上的传播延迟基本对称，那么可以得到：

$$
meanLinkDelay=
\frac{(t_4-t_1)-(t_3-t_2)}{2}
$$

例如：

```text
t1 = 1000 ns
t2 = 1500 ns
t3 = 2500 ns
t4 = 3000 ns
```

整个往返时间为：

$$
t_4-t_1=2000ns
$$

Node B 内部等待时间为：

$$
t_3-t_2=1000ns
$$

那么真正用于链路传播的时间就是：

$$
2000-1000=1000ns
$$

假设两个方向传播时间一致，那么单向传播延迟就是：

$$
meanLinkDelay=500ns
$$

于是 Node A 就知道，它与 Node B 之间的 Ethernet Link 单向传播大约需要 `500 ns`。

---

## neighborRateRatio：为什么 Pdelay 还要考虑频率差

前面的计算实际上隐藏了一个假设：

> Node A 的 1 ns 和 Node B 的 1 ns 完全一样长。

但现实中并不是这样。

假设 Node A 的时钟比较准确，而 Node B 的 Clock 快 `20 ppm`。那么：

* `t4 - t1` 是在 Node A 的 Clock Domain 中测量的；
* `t3 - t2` 是在 Node B 的 Clock Domain 中测量的。

如果直接对两者进行计算，实际上是在拿两个不同 Clock Domain 的时间间隔做运算。

因此，gPTP 还需要估计相邻两个设备之间的 Clock Rate Ratio，也就是 `neighborRateRatio`。

它描述的本质是：

> 相邻两个 Clock 的运行速率到底相差多少？

例如可能得到：

```text
neighborRateRatio ≈ 1.000020
```

有了这个 Rate Ratio 以后，就可以把不同 Clock Domain 中测量得到的时间间隔转换到同一个时间基准下，再进一步计算 Link Delay。

因此，Pdelay 并不仅仅负责测量链路传播延迟，它同时也和相邻 Clock 的频率关系估计密切相关。

---

## Sync：真正把参考时间传递下来

Pdelay 解决了“这条 Link 有多长”的问题，但 Slave 仍然不知道 Grandmaster 当前的时间。

这个问题主要由 `Sync` 和 `Follow_Up` 来解决。

最容易理解的是 Two-Step Clock。

### Two-Step 同步

假设 Grandmaster 和 Slave 之间进行如下同步：

```text
Grandmaster                       Slave

    |                               |
    | Sync                          |
    |------------------------------>|
   t1                              t2
    |                               |
    | Follow_Up                     |
    |------------------------------>|
    | preciseOriginTimestamp = t1   |
    |                               |
```

Grandmaster 首先发送 Sync。

当 Sync Frame 真正从 MAC 发出时，硬件记录一个精确的 TX Timestamp，也就是 `t1`。Slave 收到这个 Sync 时，同样由硬件记录 RX Timestamp，也就是 `t2`。

这里存在一个实际工程问题：CPU 在构造 Sync Packet 时，Packet 还没有真正离开 MAC。

一个 Packet 从应用层发送出去，通常需要经过：

```text
Application
    ↓
Socket
    ↓
Network Stack
    ↓
Driver
    ↓
DMA
    ↓
MAC
    ↓
PHY
```

所以 CPU 在构造 Packet 的时候并不知道它最终会在哪一个纳秒真正离开 MAC。

因此 Two-Step 的处理方式是：

1. 先发送 Sync。
2. 等 MAC 真正把 Sync 发出去以后，硬件获得精确的 TX Timestamp `t1`。
3. 再发送 Follow_Up，把刚才 Sync 的真实发送时间告诉 Slave。

这就是 Two-Step 这个名字的来源。

---

## Slave 怎么计算 Offset

假设只有一条链路：

```text
Master
   │
   ↓
Slave
```

Master 的 Sync 真正发送时间为：

```text
t1 = 1,000,000 ns
```

Slave 收到 Sync 时自己的本地时间为：

```text
t2 = 1,150,500 ns
```

通过 Pdelay 已经知道：

```text
meanLinkDelay = 500 ns
```

那么当 Sync 到达 Slave 时，Master 的理论时间应该是：

$$
1,000,000+500=1,000,500ns
$$

而 Slave 自己显示：

$$
1,150,500ns
$$

因此 Slave 相对于 Master 的时间偏差为 offset = 150 us

说明 Slave 的 Clock 比 Master 快了大约 `150 us`。

于是 Servo Controller 就可以根据这个 Offset 去调整 Slave 的 Clock。

所以 PTP 最核心的过程实际上可以概括为：

```text
准确的发送时间
+
准确的接收时间
+
网络传播时间
        ↓
计算 Clock Offset
        ↓
调整 Local Clock
```

---

## One-Step 和 Two-Step

除了 Two-Step 之外，PTP 中还存在 One-Step Clock。

Two-Step 的基本流程是：

```text
Sync
 ↓
获取 Hardware TX Timestamp
 ↓
Follow_Up
```

而 One-Step 的思路是，当 Sync Frame 真正经过 MAC 发送时，硬件直接获得精确的 Timestamp，并在 Frame 发送过程中修改相应的时间字段。

也就是说，时间信息是在 Packet 真正离开 MAC 的过程中由硬件动态写进去的，因此不再需要额外发送一个 Follow_Up。

可以简单理解为：

```text
Two-Step：

Sync
+
Follow_Up
```

而 One-Step：

```text
Sync
```

就可以完成一次时间信息传递。

不过 One-Step 对 MAC 和 Ethernet Controller 的硬件能力要求更高，因此实际项目采用哪一种模式，需要结合 MAC、Switch、Driver 以及具体 gPTP Profile 来判断。

---

## PTP Event Message 和 General Message

理解 Hardware Timestamp 时，还需要区分 PTP 中两类不同的 Message。

第一类叫做 **Event Message**，例如：

* Sync
* Pdelay_Req
* Pdelay_Resp

这些 Packet 真正什么时候发送、什么时候接收，会直接参与时间同步公式，因此需要尽可能准确的 TX/RX Timestamp。

另一类叫做 **General Message**，例如：

* Follow_Up
* Pdelay_Resp_Follow_Up
* Announce
* Signaling
* Management

这些 Message 主要负责传递已经获得的时间信息、Clock Dataset 或者协议控制信息。它们自己究竟在哪一个纳秒到达，通常不会直接参与对应的时间测量公式，因此一般不需要像 Event Message 那样记录精确的事件时间戳。

可以简单理解成：

> Event Message 关注的是：“这个事件究竟什么时候发生？”

而 General Message 关注的是：

> “我要把一个已经知道的信息告诉你。”

---

## 为什么一定要使用 Hardware Timestamp

假设我们在应用程序中这样记录一个 Packet 的发送时间：

```cpp
clock_gettime(...);
send(fd, packet, len, 0);
```

这个时间实际上只能表示 CPU 调用 `send()` 附近的时间。

真正的 Packet 在发送到 Ethernet Link 之前，还可能经过：

```text
Application
     ↓
Socket
     ↓
Network Stack
     ↓
qdisc
     ↓
Driver
     ↓
DMA Ring
     ↓
MAC FIFO
     ↓
MAC
     ↓
PHY
     ↓
Wire
```

中间可能存在几十微秒甚至更大的延迟，而且这个延迟还会随着 CPU Load、Interrupt、Scheduling、Network Traffic 和 DMA 状态不断变化。

如果我们要求的是微秒甚至纳秒级别的时间同步，那么这种不确定的软件路径延迟就无法忽略。

因此更理想的方式是在 MAC 真正发送或者接收 Ethernet Frame 的位置记录 Timestamp。

例如发送方向：

```text
Packet
  ↓
 MAC  ← Timestamp
  ↓
 PHY
  ↓
Wire
```

接收方向：

```text
Wire
  ↓
 PHY
  ↓
 MAC  ← Timestamp
  ↓
Driver
```

这样，应用层、协议栈和驱动调度产生的大部分不确定延迟就不会进入时间测量结果。

这就是 Hardware Timestamp 在 PTP/gPTP 中非常重要的原因。

---

## Linux 中的 SO_TIMESTAMPING

Linux 为网络时间戳提供了 `SO_TIMESTAMPING` 接口。

用户程序可以通过 `setsockopt()` 请求不同类型的 Timestamp，例如：

```cpp
int flags =
    SOF_TIMESTAMPING_TX_HARDWARE |
    SOF_TIMESTAMPING_RX_HARDWARE |
    SOF_TIMESTAMPING_RAW_HARDWARE;

setsockopt(fd,
           SOL_SOCKET,
           SO_TIMESTAMPING,
           &flags,
           sizeof(flags));
```

其中：

* `SOF_TIMESTAMPING_TX_HARDWARE`：请求 TX Hardware Timestamp。
* `SOF_TIMESTAMPING_RX_HARDWARE`：请求 RX Hardware Timestamp。
* `SOF_TIMESTAMPING_RAW_HARDWARE`：希望获得底层 Hardware Clock 提供的原始 Timestamp。

不过需要注意，`SO_TIMESTAMPING` 只是整个 Hardware Timestamp 机制中的一部分。

底层还需要 MAC/NIC、Ethernet Driver 以及 PTP Hardware Clock 共同支持：

```text
MAC Hardware Timestamp
        ↓
Ethernet Driver
        ↓
Linux Timestamp Interface
        ↓
SO_TIMESTAMPING
        ↓
gPTP Daemon
```

在 Linux 中，通常还需要通过硬件时间戳配置接口告诉 Driver 对哪些类型的 Packet 进行 Timestamp。

调试时可以使用：

```bash
ethtool -T eth0
```

查看网卡支持的 Timestamp 能力。

---

## PHC：网卡自己的 PTP Hardware Clock

很多支持 PTP Hardware Timestamp 的 Ethernet Controller 内部，都存在一个专门用于 PTP 的硬件时钟，称为 **PTP Hardware Clock**，简称 **PHC**。

Linux 通常会把 PHC 暴露成设备节点，例如：

```text
/dev/ptp0
/dev/ptp1
```

于是整个关系大致可以理解成：

```text
Ethernet MAC
     │
     ├── Hardware Timestamp
     │
     └── PHC
           │
           ↓
       /dev/ptp0
```

gPTP Daemon 从 MAC 获得 Hardware Timestamp，计算 Clock Offset，然后通过 Servo 去调整 PHC。

因此 Linux 系统中的同步链路可能是：

```text
Grandmaster
     ↓
Ethernet Frame
     ↓
MAC Hardware Timestamp
     ↓
gPTP Daemon
     ↓
Servo
     ↓
PHC
```

需要注意的是，PHC 和 Linux 的 `CLOCK_REALTIME` 并不是天然相同的 Clock。

有些系统中 gPTP 只负责同步 PHC，随后再通过另外一个机制把：

```text
PHC
 ↓
System Clock
```

同步起来。

因此调试 PTP/gPTP 时，一个非常重要的问题就是：

> 当前程序真正调整的是 PHC，还是 Linux System Clock？

---

## 为什么 gPTP 经常使用 AF_PACKET

普通的 UDP 网络程序经常使用：

```cpp
socket(AF_INET, SOCK_DGRAM, ...)
```

而在 gPTP 实现中，经常能够看到：

```cpp
socket(AF_PACKET, ...)
```

这是因为在常见的 IEEE 802.1AS Ethernet 场景中，gPTP 可以直接工作在 Layer 2，也就是直接收发 Ethernet Frame，并不需要经过 IP、UDP 或 TCP。

其数据路径可以简单理解为：

```text
gPTP Daemon
     ↓
AF_PACKET
     ↓
Ethernet Driver
     ↓
MAC
     ↓
PHY
```

PTP over Ethernet 使用的 EtherType 为：

```text
0x88F7
```

因此在抓包或者阅读协议代码时，如果看到 `AF_PACKET` 和 `0x88F7`，通常就意味着程序正在直接处理 Layer 2 的 PTP/gPTP Frame。

---

## BMCA：到底谁来当 Grandmaster

到这里还有一个问题没有解决：

> 网络里面这么多设备，到底谁应该成为 Grandmaster？

如果 ECU A、ECU B、Gateway 和 Domain Controller 都认为自己应该作为时间源，那么整个网络就无法形成统一的时间基准。

因此 PTP/gPTP 还需要一个选主机制，也就是 **Best Master Clock Algorithm，BMCA**。

具备 Grandmaster 能力的节点会发送 Announce Message，其中携带描述本地 Clock 能力和质量的数据，例如：

* `priority1`
* `clockClass`
* `clockAccuracy`
* `offsetScaledLogVariance`
* `priority2`
* `clockIdentity`

其他节点收到 Announce 后，会比较不同 Clock 的 Dataset，并最终判断哪一个 Clock 更适合作为 Grandmaster。

例如某个节点可能具有更高的优先级、更好的 Clock Accuracy 或更稳定的 Clock Quality，那么它最终就可能成为整个网络的 Grandmaster。

所以 BMCA 首先解决的是：

> 整个网络到底应该相信谁的时间？

---

## BMCA 不只是选出一个 Grandmaster

BMCA 还有另外一个非常重要的作用，就是确定时间在网络中的传播方向。

假设物理网络为：

```text
      A
     / \
    B---C
     \ /
      D
```

Ethernet 网络中可能存在多条物理路径。

但时间同步不能形成这样的逻辑关系：

```text
A 同步 B
B 同步 C
C 又反过来同步 A
```

否则时间传播关系会形成逻辑环。

因此，在选出 Grandmaster 以后，各个 Port 还需要根据收到的时间信息决定自己应该从哪里接收时间，以及应该向哪里继续传播时间。

从宏观上，可以把最终形成的关系理解成一棵有方向的 Synchronization Tree。

需要注意的是，这里的 Synchronization Tree 是时间同步关系，和 Ethernet 中 STP/RSTP 用于消除 Layer 2 转发环路的 Spanning Tree Protocol 不是一回事。

---

## gPTP Port 的角色

经过 BMCA 和 Port Role Selection 以后，一个 Time-Aware System 中的不同 Port 会承担不同的时间同步角色。

为了便于入门，可以先简单理解为：

* **Slave Port**：从上游接收时间。
* **Master Port**：向下游传播时间。
* **Passive Port**：当前不参与这条同步路径的时间传播。

例如：

```text
Grandmaster
      │
      │ Master Port
      ↓
   Switch A
      ↑
   Slave Port
      │
      │
      │ Master Port
      ↓
   Switch B
      ↑
   Slave Port
      │
      ↓
     ECU
```

对于 Switch A 来说，它从上游 Port 接收 Grandmaster 的时间，再通过其他 Port 将时间继续向下游传播。

因此，一个支持 gPTP 的 Ethernet Switch 并不是简单地把 PTP Multicast Frame 当成普通 Ethernet Packet 转发。

它本身也是整个时间同步系统中的一个 **Time-Aware System**，需要参与 Pdelay、Clock Rate Measurement、Sync、Follow_Up、BMCA、Port State 和时间传播等过程。

---

## 多跳网络中的时间怎么传递

实际的车载 Ethernet 网络通常不会只有：

```text
GM → ECU
```

一条链路。

更常见的是：

```text
Grandmaster
     │
     ↓
  Switch A
     │
     ↓
  Switch B
     │
     ↓
    ECU
```

这时候每一条 Link 都有自己的 `meanLinkDelay`，而且 Switch 本身也会参与时间同步。

因此，下游 ECU 最终需要考虑的不仅仅是最开始 Grandmaster 提供的 Origin Timestamp，还要结合整个时间传播路径上的 Link Delay、Clock Rate Ratio 以及 Correction 信息。

从概念上可以理解成：

```text
Grandmaster Time
       ↓
Link 1 Delay
       ↓
Switch A
       ↓
Link 2 Delay
       ↓
Switch B
       ↓
Link 3 Delay
       ↓
ECU
```

最终 ECU 真正想知道的是：

> 当这个 Sync 到达我这里的时候，按照 Grandmaster 的 Clock，现在应该是什么时间？

然后 ECU 再把这个参考时间和自己的 RX Hardware Timestamp 进行比较，从而计算本地 Clock Offset。

这也是为什么 gPTP Switch 不能被简单理解为“帮忙转发几个 PTP Packet”。

---

## Servo Controller：真正负责调整 Clock

到这里，我们通过 Pdelay、Sync、Follow_Up 和 Hardware Timestamp，终于获得了一个非常重要的结果：

```text
Clock Offset
```

例如测量得到：

```text
Offset = +500 ns
```

说明本地 Clock 相对于 Grandmaster 存在大约 `500 ns` 的偏差。

但是协议计算出了 `Offset = 500 ns`，并不会自动让 Clock 变准。

真正负责调整本地 Clock 的组件通常称为 **Clock Servo**。

整个过程可以理解成：

```text
Grandmaster
     ↓
PTP Measurement
     ↓
Clock Offset
     ↓
Servo
     ↓
Frequency Adjustment
     ↓
Local Clock
     │
     └────────→ 下一轮 Measurement
```

Servo 会不断重复这个过程：

```text
测量 Offset
    ↓
计算调整量
    ↓
调整 Clock
    ↓
下一次 Sync
    ↓
重新测量 Offset
```

最终让 Phase Offset 越来越小，同时让 Frequency Offset 越来越稳定。

---

## 为什么不能每次直接修改 Clock

最直观的想法可能是：

假设测量得到 Slave 比 Grandmaster 快 `100 us`，那直接：

```text
Slave Clock -= 100 us
```

不就可以了吗？

这种直接修改 Clock 当前值的方式通常可以称为 **Step**。

在系统刚启动、初始时间差非常大的情况下，直接 Step 一次有时是合理的。

但系统进入正常运行以后，如果每次发现几个微秒的 Offset 都直接修改 Clock，就可能导致时间发生跳变。

例如某个应用刚刚记录：

```text
10:00:00.000002
```

紧接着 Clock 被向后调整 `2 us`，那么下一条日志可能变成：

```text
10:00:00.000001
```

于是出现“后发生的事件反而具有更小的 Timestamp”。

这对于日志、Timer、Sensor Fusion、TSN Scheduling 等功能都可能产生问题。

因此在进入正常同步以后，更常见的做法是：

> 不直接跳时间，而是稍微调整 Clock 的运行速度，让它逐渐追上参考时间。

例如 Slave 当前快 `100 us`，Servo 可以暂时让它走得稍微慢一些，使 Offset 逐渐变化：

```text
100 us
 ↓
80 us
 ↓
50 us
 ↓
20 us
 ↓
5 us
 ↓
0
```

这种平滑调整 Clock 的方式通常称为 **Slew**。

---

## PI Servo

PTP 中非常常见的一种 Servo Controller 是 **PI Controller**，也就是 Proportional + Integral Controller。

可以用一个简化模型理解：

$$
u(k)=K_p e(k)+K_i\sum_{i=0}^{k}e(i)
$$

其中：

* $e(k)$ 表示当前测量得到的 Clock Offset。
* $u(k)$ 表示最终希望施加到 Clock 上的 Frequency Adjustment。
* $K_p$ 是比例系数。
* $K_i$ 是积分系数。

例如当前：

```text
Offset = +500 ns
```

Servo 根据 PI Controller 计算以后，可能决定对 Clock 施加：

```text
-10 ppm
```

或者某个以 ppb 表示的频率修正量。

在 Linux 中，最终可能通过 `clock_adjtime()`、`adjtimex()` 或 PHC Driver 对 Clock Frequency 进行调整。

---

## Kp：根据当前误差快速响应

PI Controller 中的 P 是 Proportional，也就是比例项。

它主要关注当前这一刻的 Offset：

$$
P=K_p \times Offset
$$

如果当前 Offset 很大，Servo 就产生比较大的修正；如果 Offset 已经非常小，修正量也会随之减小。

因此 Kp 可以简单理解成：

> 发现当前时间偏了以后，要多激进地去追 Grandmaster？

如果 Kp 太小，Clock 收敛会比较慢。例如：

```text
1000 ns
 ↓
950 ns
 ↓
900 ns
 ↓
850 ns
```

但如果 Kp 太大，又可能出现 Overshoot：

```text
+1000 ns
 ↓
-500 ns
 ↓
+300 ns
 ↓
-200 ns
```

也就是 Clock 在 Grandmaster 两侧不断振荡。

因此 Kp 需要在收敛速度和稳定性之间进行权衡。

---

## Ki：补偿长期频率偏差

如果只使用比例控制，还可能存在一个问题。

假设 Slave 的晶振天然快 `20 ppm`。即使当前 Offset 已经比较小，这个晶振仍然会持续让本地 Clock 向前漂移。

Integral 项关注的不是某一次 Offset，而是一段时间以来累计的误差。

例如连续测量得到：

```text
+100 ns
+90 ns
+110 ns
+95 ns
+105 ns
```

虽然每一次 Offset 都不算特别大，但它们长期都向正方向偏。

这意味着本地 Clock 很可能存在持续性的 Frequency Bias。

Integral 项会逐渐累计这些误差，最终形成一个比较稳定的频率补偿。

例如 Servo 最终可能发现这个 Clock 天然快大约 `20 ppm`，于是长期给它施加接近：

```text
-20 ppm
```

的 Frequency Adjustment。

因此可以简单理解为：

> Kp 负责处理“现在偏了多少”。

而：

> Ki 负责处理“为什么长期一直向某个方向偏”。

这也是 PI Servo 既能够快速收敛当前 Offset，又能够补偿晶振长期 Frequency Error 的原因。

---

## Kp 和 Ki 太大会发生什么

PI Servo 的参数并不是越大越好。

如果 Kp 太大，系统可能出现频繁 Overshoot，甚至发生振荡。

如果 Kp 太小，系统的 Lock Time 会非常长。

如果 Ki 太大，历史 Offset 被过度累计，可能导致 Frequency Correction 过强，引起新的 Overshoot。

如果 Ki 太小，则长期 Frequency Offset 可能迟迟无法被有效消除。

因此实际 gPTP 实现中的 `kp`、`ki` 参数会直接影响：

* Lock Time
* Steady-State Offset
* Clock Jitter
* Overshoot
* Servo Stability

阅读实际 gPTP Servo 代码时，如果看到类似 `kp`、`ki`、`drift`、`frequency adjustment` 这样的变量，就可以把它们放回这个反馈控制模型中理解。

---

## 什么叫 Clock Locked

Servo 不断运行以后，整个同步过程通常会经历：

```text
Startup
   ↓
Large Offset
   ↓
Frequency Estimation
   ↓
Fast Convergence
   ↓
Fine Adjustment
   ↓
Locked
```

所谓 Locked 并不意味着：

```text
Offset 永远严格等于 0 ns
```

现实中由于 Timestamp Noise、Oscillator Noise、Link Jitter 以及测量误差，Offset 通常只是在 `0 ns` 附近轻微波动。

例如：

```text
+20 ns
-15 ns
+8 ns
-12 ns
+5 ns
```

当 Offset 已经足够小，Frequency Adjustment 也已经比较稳定，并且连续多个同步周期满足要求以后，就可以认为 Clock 已经进入稳定同步状态。

---

## 一个完整的 gPTP 同步过程

现在可以把前面的内容串起来。

假设网络为：

```text
Grandmaster
     │
     ↓
   Switch
     │
     ↓
    ECU
```

系统启动以后，大致会经历下面几个阶段。

首先，各个 Ethernet Port 建立自己的 gPTP 状态，并开始和直接相邻的节点交换 Pdelay Message：

```text
Pdelay_Req
Pdelay_Resp
Pdelay_Resp_Follow_Up
```

通过这些报文逐渐获得：

```text
meanLinkDelay
neighborRateRatio
```

也就是先弄清楚：

> 这条 Link 有多长？相邻两个 Clock 的速率关系是什么？

与此同时，网络中的候选 Clock 会通过 Announce 传播自己的 Clock Dataset。

各个节点运行 BMCA，最终选出 Grandmaster，并确定时间从哪个 Port 接收、向哪些 Port 继续传播。

Grandmaster 随后周期性发送 Sync。

如果采用 Two-Step，则还会继续发送 Follow_Up，告诉下游节点刚才那个 Sync 真正离开 Grandmaster 的精确时间。

Slave 在收到 Sync 时，由 MAC 获取精确的 RX Hardware Timestamp，然后结合：

* Origin Timestamp
* Link Delay
* Rate Ratio
* Correction 信息

估算 Sync 到达本地时对应的 Grandmaster Time。

然后再计算：

$$
Offset=LocalTime-GrandmasterTime
$$

这个 Offset 被送入 Servo Controller。

Servo 根据当前 Offset 和历史 Offset 计算 Frequency Adjustment，再通过 PHC Driver 等接口调整本地 Clock。

随后下一轮 Sync 再次到来，于是形成持续的闭环：

```text
Sync
 ↓
Hardware Timestamp
 ↓
Calculate Offset
 ↓
Servo
 ↓
Adjust Clock
 ↓
Next Sync
 ↓
Calculate Offset
 ↓
...
```

最终，Clock 的 Frequency Offset 逐渐稳定，Phase Offset 逐渐接近 0，系统进入稳定同步状态。

---

## 从宏观上理解 gPTP

如果暂时忽略协议中的大量状态机和字段，其实整个 gPTP 可以先拆成四个核心问题。

### 谁的时间是对的？

通过：

```text
Announce
   ↓
BMCA
   ↓
Grandmaster
```

解决时间源选择问题。

### 我和邻居之间的 Link 有多长？

通过：

```text
Pdelay
   ↓
meanLinkDelay
```

解决链路传播延迟问题。

### Grandmaster 现在几点？

通过：

```text
Sync
+
Follow_Up
+
Hardware Timestamp
+
Correction
```

把参考时间沿着网络传播下来。

### 知道自己偏了以后怎么办？

通过：

```text
Clock Offset
    ↓
Servo
    ↓
Frequency Adjustment
    ↓
Local Clock
```

不断调整本地 Clock。

所以从整体上看，gPTP 可以理解成：

```text
                   Announce
                      │
                      ↓
                    BMCA
                      │
                      ↓
               Grandmaster


                    Pdelay
                      │
                      ↓
             Measure Link Delay
                      │
                      ↓
                meanLinkDelay


             Sync + Follow_Up
                      │
                      ↓
              Hardware Timestamp
                      │
                      ↓
             Calculate Clock Offset
                      │
                      ↓
                    Servo
                      │
                      ↓
            Adjust Local Clock
                      │
                      └─────────────┐
                                    │
                                    ↓
                               Next Sync
```

从控制系统的视角来看，它本质上又可以抽象成：

```text
Reference Clock
      │
      ↓
Measurement
      │
      ↓
Clock Error
      │
      ↓
Controller
      │
      ↓
Local Clock
      │
      └──────── Feedback
```

因此，gPTP 并不只是“发送几个 PTP Packet”。

它实际上是由 **Ethernet Protocol、Hardware Timestamp、Clock Hardware、Delay Measurement、Clock Selection 和 Feedback Control** 共同组成的一套分布式时间同步系统。

理解这个整体关系以后，再去阅读实际 gPTP 代码中的：

```text
Pdelay State Machine
Sync State Machine
Announce State Machine
BMCA
Timestamp Handler
Servo
PHC Driver
```

就会容易很多。

这些模块看起来分别在处理不同的事情，但最终都服务于同一个目标：

> 让整个 Ethernet 网络中的不同设备，对“现在是什么时间”这件事情形成统一的认识。

## 项目代码实证

前面讲了 gPTP / IEEE 802.1AS 时间同步——Phase/Frequency Offset、Pdelay、Sync/Follow_Up、Two-Step、Hardware Timestamp、SO_TIMESTAMPING、AF_PACKET、PHC、BMCA、PI Servo、Step/Slew、Locked。这些都是协议层抽象。下面看在量产代码里，这些机制是怎么真正通过 BSD socket、Linux 内核 PHC 接口、ptpd 协议栈落到工程上的。本节以一个基于 ptpd 2.8（BSD 开源项目）衍生的跨平台 PTP 协议栈为例，所有代码用伪代码形式呈现，重点在讲清楚协议概念到 Linux 接口的映射关系。

###  SO_TIMESTAMPING + AF_PACKET

**创建 socket 用 AF_PACKET + SOCK_RAW**：

```c
Boolean net_init(NetPath *netPath, RunTimeOpts *rtOpts, PtpClock *ptpClock)
{
    ...
    struct sockaddr_ll addr;    /* 注意是 sockaddr_ll，AF_PACKET 专用 */
    struct ifreq iface;

    /* PTP多播多播 MAC */
    memcpy(netPath->etherDest.ether_addr_octet, ptp_ether_dst, ETHER_ADDR_LEN);
    memcpy(netPath->peerEtherDest.ether_addr_octet, ptp_ether_peer, ETHER_ADDR_LEN);

    proto = get_sock_protocol();   /* ETH_P_1588 = 0x88F7 */

    if (-1 == netPath->eventSock && -1 == netPath->generalSock)
    {
        /* ↓↓↓ 关键：用 PF_PACKET + SOCK_RAW 创建 socket，绕过 TCP/IP 协议栈 ↓↓↓ */
        if ((netPath->eventSock = socket(PF_PACKET, SOCK_RAW, proto)) < 0
#ifndef MERGE_EVENT_AND_GENERAL_SOCKET
        || (netPath->generalSock = socket(PF_PACKET, SOCK_RAW, proto)) < 0
#endif
        ) {
            PERROR("failed to initialize general/event sockets\n");
            return FALSE;
        }
    }

#ifdef MERGE_EVENT_AND_GENERAL_SOCKET
    /* Event 和 General 共用一个 socket —— 后面会用动态切换 timestamping 模式 */
    netPath->generalSock = netPath->eventSock;
#endif

}
```

**SO_TIMESTAMPING 设置**：

```c
static Boolean net_init_timestamping(NetPath *netPath, const RunTimeOpts *rtOpts)
{
    ...
#if defined(SO_TIMESTAMPING) && defined(SO_TIMESTAMPNS)
    val = get_timestamping_flags();   /* 拿 SO_TIMESTAMPING_TX/RX_HARDWARE + RAW_HARDWARE 组合 */

    if(val == 1) {
        /* 老接口：SO_TIMESTAMPNS */
        if (setsockopt(netPath->eventSock, SOL_SOCKET, SO_TIMESTAMPNS, &val, sizeof(int)) < 0) {
            result = FALSE;
        }
    } else {
        /* ↓↓↓ 主路径：setsockopt(SO_TIMESTAMPING) 启用硬件时间戳 ↓↓↓ */
        if (setsockopt(netPath->eventSock, SOL_SOCKET, SO_TIMESTAMPING, &val, sizeof(int)) < 0) {
            result = FALSE;
        }
    }

    /* fallback 到软件时间戳 SO_TIMESTAMP */
#if defined(SO_TIMESTAMP)
    if (!result) {
        if (setsockopt(netPath->eventSock, SOL_SOCKET, SO_TIMESTAMP, &val, sizeof(int)) < 0) {
            result = FALSE;
        }
        result = TRUE;
    }
#endif
    return result;
}
```

代码明确按优先级 fallback：`SO_TIMESTAMPING`（硬件）> `SO_TIMESTAMPNS`（纳秒级软件）> `SO_BINTIME`（FreeBSD）> `SO_TIMESTAMP`（毫秒级软件）。如果都没有，编译期 `#error` 直接报错。


### Event vs General Message 两类报文在代码层怎么区分

用两种方式：

**方式 A：两个独立 socket**（`MERGE_EVENT_AND_GENERAL_SOCKET` 未定义）：
- `eventSock`：发 Sync/Pdelay_Req/Pdelay_Resp，开 SO_TIMESTAMPING_TX_HARDWARE + RX_HARDWARE
- `generalSock`：发 Follow_Up/Announce，只开 RX_HARDWARE

**方式 B：合并 socket + 动态切换 timestamping 模式**（`MERGE_EVENT_AND_GENERAL_SOCKET` 定义）

```c
static Boolean net_event_socket_transform_tx_mode(NetPath *netPath, Boolean isEventMode)
{
    Boolean result = TRUE;
    int val = isEventMode
                ? (SOF_TIMESTAMPING_TX_HARDWARE + SOF_TIMESTAMPING_RX_HARDWARE +
                   SOF_TIMESTAMPING_RAW_HARDWARE)        /* Event 模式：TX+RX 都打时间戳 */
                : (SOF_TIMESTAMPING_RX_HARDWARE + SOF_TIMESTAMPING_RAW_HARDWARE);  /* General 模式：只 RX 打 */
    if (gTxRxTsOpt != val) {
    if (setsockopt(netPath->eventSock, SOL_SOCKET, SO_TIMESTAMPING, &val,
                   sizeof(int)) < 0) {
      result = FALSE;
    } else {
      gTxRxTsOpt = val;
    }
  }
  return result;
}
```

### TX 时间戳通过 MSG_ERRQUEUE 拿

Two-Step Clock：先发 Sync，硬件记录 TX Timestamp t1，再发 Follow_Up 把 t1 告诉 Slave。问题：软件怎么拿到硬件写的 t1？Linux 的答案是 **socket error queue (MSG_ERRQUEUE)**：

```c
/* 伪代码：从 errqueue 拿 TX 时间戳 */
static Boolean get_tx_timestamp(NetPath* netPath, TimeInternal* timeStamp)
{
    ...
    /* Step 1：select 检查 error queue 是否有数据 */
    if(select(netPath->eventSock + 1, &tmpSet, NULL, NULL, &timeOut) > 0) 
    {
        if (FD_ISSET(netPath->eventSock, &tmpSet)) {
            /* Step 2：从 MSG_ERRQUEUE 读 TX 时间戳 */
            length = net_recv_event(msg_ibuf, timeStamp,
                netPath, MSG_ERRQUEUE);
            if (length > 0 && tx_timestamp_check(msg_ibuf, msg_obuf)) {
                return TRUE;
            }
            /* ... 错误处理 ... */
        }
    }

    /* Step 3：第一次没拿到，重试 3 次（每次 10 us） */
    for(i = 0; i < 3; i++) {
        length = net_recv_event(msg_ibuf, timeStamp, netPath, MSG_ERRQUEUE);
        if(length > 0 && tx_timestamp_check(msg_ibuf, msg_obuf)) {
            return TRUE;
        }
        usleep(10);
    }

    /* Step 4：最后再等 LATE_TXTIMESTAMP_US，确认拿不到 */
    usleep(LATE_TXTIMESTAMP_US);
    length = net_recv_event(msg_ibuf, timeStamp, netPath, MSG_ERRQUEUE);
    if(length > 0 && tx_timestamp_check(msg_ibuf, msg_obuf)) {
        return TRUE;
    }
    return FALSE;
}
```

**为什么 TX 时间戳要走 MSG_ERRQUEUE 而不是普通 recv？**


- 普通的 `sendto()` 是异步的：CPU 调完 `sendto()` 返回时，包还在 socket buffer / qdisc / driver / DMA 队列里，没真正发出 MAC
- 真正发出 MAC 后，硬件时间戳模块才会生成 TX 时间戳
- Linux 把这个"延迟到达的 TX 时间戳"通过 socket 的 error queue 投递（不阻塞正常 RX 路径）
- 软件通过 `recvmsg(..., MSG_ERRQUEUE)` 拿

**`tx_timestamp_check()` 验证包身份**：


```c
static inline Boolean tx_timestamp_check(Octet *inbuf, Octet *outbuf)
{
    /* 检查 messageType 和 sequenceId 是否匹配刚发的那个包 */
    return (*(Enumeration4 *) inbuf) == (*(Enumeration4 *) outbuf) &&
        (*(UInteger16 *) (inbuf +30) == *(UInteger16 *) (outbuf +30));
}
```

error queue 里可能有多个 TX 时间戳排队，必须用 messageType + sequenceId 匹配出"我刚发的那个包"的时间戳。

### RX 时间戳通过 cmsg 拿

```c
ssize_t net_recv_event(Octet *buf, TimeInternal *ti, NetPath *netPath, int flags)
{
    ...

    union {
        struct cmsghdr cm;
        char   control[256];     /* cmsg 缓冲区 */
    } cmsg_un;

    ...
#ifdef BASE_AFPACKET_ZERO_COPY
    vec[0].iov_base = buf - ETHER_HDR_LEN;   /* 零拷贝：buf 前留 ETH 头空间 */
    vec[0].iov_len = PACKET_SIZE + ETHER_HDR_LEN;
#else
    vec[0].iov_base = buf;
    vec[0].iov_len = PACKET_SIZE;
#endif

    /* ... 初始化 msg、from_addr 等 ... */

    ret = recvmsg(netPath->eventSock, &msg, flags | MSG_DONTWAIT);   /* 收包 */
    if (ret <= 0) {
        if (errno == EAGAIN || errno == EINTR) return 0;
        return ret;
    }

    /* ... 检查 MSG_TRUNC/MSG_CTRUNC ... */

    /* ↓↓↓ 遍历 cmsg 链表找 SO_TIMESTAMPING 时间戳 ↓↓↓ */
    for (cmsg = CMSG_FIRSTHDR(&msg); cmsg != NULL; cmsg = CMSG_NXTHDR(&msg, cmsg)) {
        if (cmsg->cmsg_level == SOL_SOCKET) {
#if defined(SO_TIMESTAMPING) && defined(SO_TIMESTAMPNS)
            if(cmsg->cmsg_type == SO_TIMESTAMPING || cmsg->cmsg_type == SO_TIMESTAMPNS) {
                ptpd_read_timestamp(ti, CMSG_DATA(cmsg));   /* 解析时间戳 */
                timestampValid = TRUE;
                break;
            }
#elif defined(SO_TIMESTAMPNS)
            /* ... */
#elif defined(SO_BINTIME)
            /* ... */
#endif
        }
    }
    /* ... */
    return ret;
}
```


**关键点**：

1. **`recvmsg + msghdr + cmsghdr`**：Linux 标准 socket 辅助数据机制，cmsg 链表携带时间戳
2. **`cmsg->cmsg_type == SO_TIMESTAMPING`**：内核把硬件时间戳塞到 cmsg 里
3. **`ptpd_read_timestamp(ti, CMSG_DATA(cmsg))`**：解析 `struct scm_timestamping`（含三个 `struct timespec`：系统时间、硬件原始时间、硬件转换后时间）
4. **`BASE_AFPACKET_ZERO_COPY`**：零拷贝路径，让 buf 前留 `ETHER_HDR_LEN` 字节空间，AF_PACKET 内核直接把以太网帧（含 ETH 头）写到 buf-14 位置，避免 memcpy
5. **`(flags & MSG_ERRQUEUE) ? "(TX)" : "(RX)"`**：同一个函数处理 TX（从 errqueue 拿）和 RX（从普通队列拿），日志区分

### Step vs Slew：两种 Clock 调整方式

**Slew 模式：调频率**：

```c
/* 伪代码：调频率（Slew） */
/*
 * Apply a tick / frequency shift to the kernel clock
 */
Boolean adj_freq(double adj)
{
    struct timex t;
    Integer32 tickAdj = 0;

    memset(&t, 0, sizeof(t));

#ifdef HAVE_STRUCT_TIMEX_TICK
    /* Get the USER_HZ value */
    Integer32 userHZ = sysconf(_SC_CLK_TCK);

    /*
     * Get the tick resolution (ppb) - offset caused by changing the tick value by 1.
     * The ticks value is the duration of one tick in us. So with userHz = 100  ticks per second,
     * change of ticks by 1 (us) means a 100 us frequency shift = 100 ppm = 100000 ppb.
     *
     * If we are outside the standard +/-512ppm, switch to a tick + freq combination:
     *
     * The offset change will not be super smooth as we flip between tick and frequency,
     * but this is the only way to go beyond 512ppm on older kernels.
     */

    /* ... 计算 tickAdj ... */
#endif

    t.freq = (long long) round(dFreq);   /* 设置目标频率 */

    return !adjtimex(&t);   /* ↓↓↓ Linux adjtimex(2) 系统调用，调整 PHC 频率 ↓↓↓ */
}
```

**对应博客讲"PI Servo 输出 Frequency Adjustment"**：


- `adj` 参数是 PI Servo 算出的频率调整值（ppb 级）
- `adjtimex(&t)` 是 Linux 标准 NTP daemon 也用的系统调用
- `t.freq` 字段是相对标准频率的偏移量
- 注释明确"Apply a tick / frequency shift to the kernel clock" —— 就是博客讲的 Slew

**Step 模式：直接跳时间**：


```c
/* 伪代码：直接跳时间（Step） */
Boolean step_clock(const RunTimeOpts *rtOpts, PtpClock *ptpClock)
{
    /* ... 计算 step 后的新时间 ... */
    /* 调 set_time()（即 clock_settime(CLOCK_PTPTIME)）直接跳时间 */
    /* 对应博客讲 "Slave Clock -= 100 us" 这种直接修改 */
}
```

**Slew 包装函数**：

```c
/* 伪代码：Slew 包装 */
void adj_freq_wrapper(const RunTimeOpts *rtOpts, PtpClock *ptpClock, double adj)
{
    /* 包装 adj_freq()，加上 observedDrift 持久化、统计、告警等 */
    /* 如果 adj > 某阈值会触发 warn_operator_fast_slewing */
}
```

**`update_clock` 顶层函数做策略选择**：

```c
/* 伪代码：Step vs Slew 策略选择 */
void update_clock(const RunTimeOpts *rtOpts, PtpClock *ptpClock)
{
    /* 如果 offset 很大（启动初期）→ step_clock 直接跳 */
    /* 如果 offset 很小（正常运行）→ adj_freq_wrapper 微调 */
    /* 如果 servo 还没稳定 + offset 大幅震荡 → 维持当前频率不动 */
    /* 这就是博客讲"系统刚启动时可以 Step 一次，正常运行后必须 Slew" */
}
```

### BMCA 完整算法


```c
/* 伪代码：BMCA 数据集比较（IEEE 1588 Fig 27） */
int bmc_data_set_comparison(const ForeignMasterRecord *a, const ForeignMasterRecord *b,
                            const PtpClock *ptpClock, const RunTimeOpts *rtOpts)
{
    int comp = 0;

    /* 0. 先看是否被取消资格（disqualified）—— 任何比较前先过滤 */
    if(a->disqualified > b->disqualified) return -1;
    if(a->disqualified < b->disqualified) return 1;

    /* 1. 比较 grandmasterIdentity —— 决定是否同一个 GM */
    comp = memcmp(a->announce.grandmasterIdentity,
                  b->announce.grandmasterIdentity,
                  CLOCK_IDENTITY_LENGTH);
    if (comp != 0) goto dataset_comp_part_1;   /* 不同 GM，走完整比较 */

    /* === 同一个 GM 的两个 Announce（stepsRemoved 比较路径） === */
    /* 2. stepsRemoved：距离 GM 的跳数 */
    if (a->announce.stepsRemoved > b->announce.stepsRemoved+1) return 1;
    if (a->announce.stepsRemoved+1 < b->announce.stepsRemoved) return -1;

    /* 3. 距离相近 → 比较路径上的 clockIdentity + portNumber */
    if (a->announce.stepsRemoved > b->announce.stepsRemoved) {
        comp = memcmp(a->header.sourcePortIdentity.clockIdentity,
                      ptpClock->parentDS.parentPortIdentity.clockIdentity,
                      CLOCK_IDENTITY_LENGTH);
        if(comp < 0) return -1;
        if(comp > 0) return 1;
        return 0;
    }
    /* ... 类似的镜像分支 ... */

    /* === 不同 GM，走完整比较（IEEE 1588 Fig 27） === */
dataset_comp_part_1:

    /* 4. （可选）domain 比较 —— 对应 AS2020 多时间域 */
    if(rtOpts->anyDomain) {
        if(a->header.domainNumber == rtOpts->domainNumber && b->header.domainNumber != ptpClock->defaultDS.domainNumber)
            return -1;
        /* ... */
    }

    /* 5. localPreference（用于 unicast negotiation） */
    if(a->localPreference < b->localPreference) return -1;
    if(a->localPreference > b->localPreference) return 1;

    /* 6. priority1 —— 对应博客讲的第一关键字段 */
    if (a->announce.grandmasterPriority1 < b->announce.grandmasterPriority1) return -1;
    if (a->announce.grandmasterPriority1 > b->announce.grandmasterPriority1) return 1;

    /* 7. （非标准扩展）优先选 UTCV flag 有效的 GM */
    if(rtOpts->preferUtcValid) {
        Boolean utcA = IS_SET(a->header.flagField1, UTCV);
        Boolean utcB = IS_SET(b->header.flagField1, UTCV);
        if(utcA > utcB) return -1;
        if(utcA < utcB) return 1;
    }

    /* 8. clockClass —— 对应博客讲的第二关键字段 */
    if (a->announce.grandmasterClockQuality.clockClass <
        b->announce.grandmasterClockQuality.clockClass) return -1;
    if (a->announce.grandmasterClockQuality.clockClass >
        b->announce.grandmasterClockQuality.clockClass) return 1;

    /* 9. clockAccuracy —— 对应博客讲的第三关键字段 */
    if (a->announce.grandmasterClockQuality.clockAccuracy <
        b->announce.grandmasterClockQuality.clockAccuracy) return -1;
    if (a->announce.grandmasterClockQuality.clockAccuracy >
        b->announce.grandmasterClockQuality.clockAccuracy) return 1;

    /* 10. offsetScaledLogVariance —— 对应博客讲的第四关键字段 */
    if (a->announce.grandmasterClockQuality.offsetScaledLogVariance <
        b->announce.grandmasterClockQuality.offsetScaledLogVariance) return -1;
    if (a->announce.grandmasterClockQuality.offsetScaledLogVariance >
        b->announce.grandmasterClockQuality.offsetScaledLogVariance) return 1;

    /* 11. priority2 —— 对应博客讲的第五关键字段 */
    if (a->announce.grandmasterPriority2 < b->announce.grandmasterPriority2) return -1;
    if (a->announce.grandmasterPriority2 > b->announce.grandmasterPriority2) return 1;

    /* 12. clockIdentity —— 最后 tie-break */
    if (comp < 0) return -1;
    return 1;
}
```

### PI Servo：


```c
/* 伪代码：PI Servo 初始化 */
void setup_pi_servo(PIservo* servo, const RunTimeOpts* rtOpts)
{
    servo->maxOutput = rtOpts->servoMaxPpb;   /* 输出上限（防过度调整） */
    servo->kP = rtOpts->servoKP;              /* Kp 参数，来自配置 */
    servo->kI = rtOpts->servoKI;              /* Ki 参数 */
    servo->dTmethod = rtOpts->servoDtMethod;  /* dt 计算方式 */
#ifdef PTPD_STATISTICS
    servo->stabilityThreshold = rtOpts->servoStabilityThreshold;  /* Locked 阈值 */
    servo->stabilityPeriod = rtOpts->servoStabilityPeriod;
    servo->stabilityTimeout = (60 / rtOpts->statsUpdateInterval) * rtOpts->servoStabilityTimeout;
#endif
}

/* 伪代码：PI Servo 核心 */
double run_pi_servo(PIservo* servo, const Integer32 input)   /* input = 当前 offset */
{
    double dt;
    TimeInternal now = {0};
    TimeInternal delta = {0};

    /* === Step 1: 计算 dt（两次 Sync 之间的时间间隔）=== */
    switch (servo->dTmethod) {
    case DT_MEASURED:    /* 实测时间间隔（用 CLOCK_MONOTONIC） */
        get_time_monotonic(&now);
        if(servo->lastUpdate.seconds == 0 && servo->lastUpdate.nanoseconds == 0) {
            dt = servo->dT;
        } else {
            sub_time(&delta, &now, &servo->lastUpdate);
            dt = delta.seconds + delta.nanoseconds / 1E9;
        }
        /* 限制 dt 不超过 maxdT × dT，防丢包时 dt 过大导致 Integral 项爆 */
        if(dt > (servo->maxdT * servo->dT))
            dt = (servo->maxdT + 0.0) * servo->dT;
        break;
    case DT_CONSTANT:    /* 固定值 */
        dt = servo->dT;
        break;
    case DT_NONE:
    default:
        dt = 1.0;
        break;
    }
    if(dt <= 0.0) dt = 1.0;

    servo->input = input;

    /* 防 Kp/Ki 为 0（避免除零和 Servo 失效） */
    if (servo->kP < 0.000001) servo->kP = 0.000001;
    if (servo->kI < 0.000001) servo->kI = 0.000001;

    /* === Step 2: Integral 项累加（Ki·Σe(i)）===
     * observedDrift 是累计的 frequency adjustment，对应博客讲的"长期 Frequency Bias" */
    servo->observedDrift += dt * ((input + 0.0) * servo->kI);

    /* === Step 3: 输出限幅（防过度调整）===
     * 如果累计 drift 超过 servoMaxPpb（如 1000 ppb），限制到边界值 */
    if(servo->observedDrift >= servo->maxOutput) {
        servo->observedDrift = servo->maxOutput;
        servo->runningMaxOutput = TRUE;
#ifdef PTPD_STATISTICS
        servo->stableCount = 0;   /* 限幅期间不算稳定 */
        servo->updateCount = 0;
        servo->isStable = FALSE;
#endif
    } else if(servo->observedDrift <= -servo->maxOutput) {
        servo->observedDrift = -servo->maxOutput;
        servo->runningMaxOutput = TRUE;
        /* ... 同上 ... */
    } else {
        servo->runningMaxOutput = FALSE;
    }

    /* === Step 4: 输出 = P 项 + I 项 ===
     * servo->output = Kp × e(k) + Ki × Σe(i)
     * 对应博客讲的 PI 公式 u(k) = Kp·e(k) + Ki·Σe(i) */
    servo->output = (servo->kP * (input + 0.0)) + servo->observedDrift;

    if(servo->dTmethod == DT_MEASURED)
        servo->lastUpdate = now;

    DBGV("Servo dt: %.09f, input (ofm): %d, output(adj): %.09f, accumulator (observed drift): %.09f\n",
         dt, input, servo->output, servo->observedDrift);

    /* 返回负值 —— 正 offset 表示本地快，需要负频率调整让它慢下来 */
    return -servo->output;
}
```

### 完整数据流图


把所有代码串起来，gPTP 的完整同步过程：

```
═══════════════════════ 启动阶段 ═══════════════════════

ptpd_startup()
   │
   ├── net_init()
   │   ├── socket(PF_PACKET, SOCK_RAW, ETH_P_1588)
   │   ├── setsockopt(SO_TIMESTAMPING, TX/RX_HARDWARE)
   │   └── getInterfaceInfo + bind to interface
   │
   ├── init_clock()
   │   ├── 清空 meanPathDelay / delaySM / delayMS
   │   └── for each domain: 清空 sync_receive_time / offsetFromMaster
   │
   └── setup_pi_servo()
       └── servo->kP/Ki/maxOutput 从配置加载

═══════════════════════ Pdelay 阶段（测 meanLinkDelay） ═══════════════════════

net_send_peer_event(Pdelay_Req)
   │
   ├── 动态切换 timestamping 模式（Event 模式：开 TX 时间戳）
   │   └── net_event_socket_transform_tx_mode(isEventMode=TRUE)
   │
   ├── sendto(eventSock, Pdelay_Req, ...)
   │
   └── get_tx_timestamp()
       ├── select() 查 error queue
       └── recvmsg(MSG_ERRQUEUE) 拿 t1
           └── ptpd_read_timestamp 从 cmsg 解析

              ↓ Pdelay_Req 真正离开 MAC 的时间 = t1

对端收到 Pdelay_Req → 记 RX 时间戳 t2 → 发送 Pdelay_Resp（带 t2）
   │
   └── 我方收到 Pdelay_Resp
       └── net_recv_event()
           ├── recvmsg()
           └── 遍历 cmsg 找 SO_TIMESTAMPING → ptpd_read_timestamp 拿 t4

对端发 Pdelay_Resp_Follow_Up（带 t3）
   │
   └── 我方收到 Follow_Up（General Message，无 TX 时间戳）
       └── net_recv_general()

update_peer_delay()
   └── meanLinkDelay = ((t4-t1) - (t3-t2)) / 2
       （对应博客讲的 Pdelay 公式）

═══════════════════════ BMCA 阶段（选 Grandmaster） ═══════════════════════

收到 Announce Message（General Message）
   │
   ▼
bmc_state_decision() → bmc_data_set_comparison()
   │
   ├── disqualified → priority1 → UTCV → clockClass → clockAccuracy
   ├── → offsetScaledLogVariance → priority2 → clockIdentity
   │
   └── 选出 Grandmaster + 确定 Port Role（Master/Slave/Passive）

═══════════════════════ Sync 阶段（传递参考时间） ═══════════════════════

Grandmaster 发 Sync（Event Message）→ 我方收
   │
   └── net_recv_event() → 拿 RX 时间戳 t2

Grandmaster 发 Follow_Up（General Message）→ 我方收
   │
   └── Follow_Up 携带 preciseOriginTimestamp = t1（GM 发 Sync 的 TX 时间戳）

═══════════════════════ Offset 计算与 Servo ═══════════════════════

update_offset()
   │
   ├── master_time_when_sync_arrives = t1 + meanLinkDelay + correctionField
   ├── offset = t2 - master_time_when_sync_arrives
   │        （对应博客讲的 Slave 比 Master 快/慢多少 ns）
   │
   └── run_pi_servo(servo, offset)
       │
       ├── dt = CLOCK_MONOTONIC - lastUpdate   （注意不是 PTPTIME！）
       │
       ├── Integral 项累加：
       │   servo->observedDrift += dt × (offset × kI)
       │   （对应博客讲"Ki 累计历史 offset 估出长期 frequency bias"）
       │
       ├── 限幅：observedDrift ∈ [-maxOutput, +maxOutput]
       │
       ├── P + I：
       │   servo->output = (kP × offset) + observedDrift
       │   （对应博客公式 u(k) = Kp·e(k) + Ki·Σe(i)）
       │
       └── return -output  （正 offset → 负频率调整）

═══════════════════════ 调整 PHC ═══════════════════════

update_clock()
   │
   ├── |offset| 很大（启动初期）：
   │   └── step_clock() → set_time()
   │       └── clock_settime(CLOCK_PTPTIME, new_time)
   │           （对应博客讲 Step 模式直接跳时间）
   │
   └── |offset| 很小（正常运行）：
       └── adj_freq_wrapper() → adj_freq()
           └── adjtimex(&t)
               （对应博客讲 Slew 模式调频率，Linux adjtimex(2) 系统调用）

═══════════════════════ Locked 判断 ═══════════════════════

check_servo_stable()
   │
   ├── ofm 标准差 < stabilityThreshold
   ├── observedDrift 标准差 < driftStdDev 阈值
   ├── 连续 stabilityPeriod 个周期都满足
   │
   └── servo->isStable = TRUE
       （对应博客讲"连续多个周期满足要求 → Locked"）
```




