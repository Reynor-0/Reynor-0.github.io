---
title: '车载以太网（五）：Switch 硬件转发模型'
description: '从嵌入式软件开发的角度理解车载以太网 Switch、VLAN、ATU、FID、端口配置与硬件转发。'
series: { id: 'vehicle-ethernet', order: 5 }
tags: ['Ethernet', 'Switch', 'VLAN', 'ATU', '汽车电子']
pubDate: 'Jun 08 2026'
updatedDate: 'Aug 05 2026'
---

在协议栈或者网络应用程序中，我们经常能够看到接收数据、解析协议、处理数据以及重新发送的代码。

但是在 Switch 驱动中，看到的内容往往完全不同。驱动代码通常围绕寄存器读写、端口初始化、VLAN 配置、ATU 操作和链路状态查询展开，很少能够看到真正“逐包处理”的逻辑。

刚开始阅读 Switch 驱动时，我也产生过类似的疑问：

- 驱动代码没有读取每一个以太网帧，数据是怎样被转发的？
- CPU 不参与普通数据转发，Switch 又怎样知道报文应该从哪个端口发出？
- VLAN、MAC 地址学习和端口模式分别由谁实现？
- 驱动中的一系列寄存器配置，最终改变了什么行为？

这些问题的答案，都建立在 Switch 的硬件转发模型之上。

只有先理解 Switch 内部怎样处理一个以太网帧，后续再看端口寄存器、VLAN 表、ATU 表和 SMI 操作时，才能明白每一项配置真正控制的是什么。

## Switch 是什么

Switch 可以理解为一个拥有多个以太网端口的二层转发设备。

每个端口都可以接收和发送以太网帧。Switch 芯片会根据帧中的 VLAN 信息、目的 MAC 地址、入口端口以及当前端口状态，决定这个帧最终应该从哪些端口发出。

假设 Port 1 收到下面这样一个以太网帧：

```text
DMAC = AA:BB:CC:DD:EE:FF
SMAC = 00:11:22:33:44:55
VID  = 100
```

如果采用纯软件转发，CPU 需要完成下面这些操作：

```text
接收以太网帧
    ↓
解析 VLAN 和 MAC 地址
    ↓
查询 MAC 地址表
    ↓
判断输出端口
    ↓
重新调用发送接口
```

这种方式会消耗大量 CPU 资源。随着报文速率和端口数量增加，CPU 很容易成为整个系统的性能瓶颈。

硬件 Switch 的工作方式则不同。

CPU 不需要处理每一个普通数据帧，而是在初始化阶段提前配置好转发规则，例如：

```text
VLAN 100 包含哪些端口
某个 MAC 地址位于哪个端口
某个端口发送报文时保留还是移除 VLAN Tag
未知单播、广播和组播允许向哪些端口转发
某个端口是否允许学习源 MAC 地址
```

这些规则写入 Switch 芯片后，后续报文就可以直接在硬件内部完成转发。

因此，一个典型的 Switch 系统可以分为两个部分：

```text
控制面：CPU 配置 Switch 的转发规则
数据面：Switch 硬件按照规则转发每一个以太网帧
```

CPU 与 Switch 之间通常通过 MDIO、SMI、SPI 或其他管理接口进行通信。

控制面的典型操作包括：

- 初始化 Switch 芯片和各个端口；
- 配置端口速率、双工模式和接口类型；
- 配置 VLAN 和端口成员关系；
- 添加或删除静态 MAC 地址；
- 设置 MAC 地址老化时间；
- 配置端口的转发状态；
- 配置 QoS 和优先级队列；
- 查询链路状态和统计计数器。

这些操作并不直接搬运普通业务报文，而是在配置 Switch 内部的硬件转发逻辑。

## Switch 芯片的基本组成

不同厂商、不同型号的 Switch 芯片在寄存器设计上会有很大差异，但内部通常都包含以下几类核心模块：

```text
Port
VLAN Table
ATU / FDB
Switch Core
CPU Port
Management Interface
PHY 或 SerDes
统计计数器与 QoS 模块
```

它们共同完成一个以太网帧从入口端口到出口端口的处理。

## Port

Port 就是 Switch 的端口。

不同端口可能连接不同类型的设备，例如：

```text
车载摄像头
毫米波雷达
激光雷达
域控制器
网关
中央计算平台
外部 PHY
另一个 Switch
```

每个端口通常都有自己独立的寄存器，用于控制该端口的行为。

常见的端口配置包括端口是否启用、是否允许转发、是否允许学习源 MAC、默认 VLAN、Ingress VLAN 处理方式、Egress Tag 行为、接口速率、双工模式、流控、QoS 和统计计数器等。

需要注意的是，端口的“链路已经连接”并不代表该端口一定能够正常转发数据。

一个端口可能已经 Link Up，但仍然处于 Blocking 或 Disabled 状态。在这种情况下，物理链路是通的，Switch 却不会允许普通数据帧经过这个端口。

因此，排查 Switch 问题时通常要分别确认：

```text
PHY 链路是否正常
MAC 接口是否正常
端口是否处于 Forwarding 状态
端口是否属于正确的 VLAN
Ingress 和 Egress VLAN 策略是否匹配
ATU/FDB 中是否存在异常表项
```

## VLAN Table

VLAN 的作用，是将一个物理 Switch 划分为多个相互隔离的二层网络。

例如，一个五端口 Switch 可以按照下面的方式配置：

```text
VLAN 10：Port 1、Port 2、Port 5
VLAN 20：Port 3、Port 4、Port 5
```

其中，Port 5 同时属于 VLAN 10 和 VLAN 20，通常用于连接上级 Switch、网关或者 CPU。

虽然所有端口都位于同一颗物理芯片上，但 VLAN 10 和 VLAN 20 中的普通二层数据不会被默认互相转发。

Switch 通常使用一张 VLAN 表保存这些配置。这张表在不同厂商的文档中可能叫作：

```text
VLAN Table
VTU
VLAN Translation Unit
VLAN Database
```

一条 VLAN 表项通常包含以下信息：

| 字段 | 作用 |
|---|---|
| VID | VLAN ID，用于识别具体 VLAN |
| FID | MAC 地址学习和查找使用的转发域编号 |
| Member Ports | 该 VLAN 包含哪些端口 |
| Egress Mode | 每个端口发送时保留、添加还是移除 VLAN Tag |
| Valid | 当前表项是否有效 |
| Policy | 其他过滤、优先级或厂商扩展配置 |

VLAN Table 解决的主要问题是：

> 一个帧允许在哪些端口之间活动。

它决定的是二层广播域和端口成员关系，但不能单独确定某个目的 MAC 地址位于哪个具体端口。

这个问题需要由 ATU 或 FDB 解决。

## Ingress 和 Egress

理解 VLAN 配置时，需要区分 Ingress 和 Egress。

Ingress 表示帧进入 Switch 的方向，Egress 表示帧离开 Switch 的方向。

```text
外部设备
    │
    │ Ingress
    ▼
Switch Port
    │
    │ Switch 内部转发
    ▼
Switch Port
    │
    │ Egress
    ▼
外部设备
```

### Ingress VLAN 处理

当一个帧进入端口时，Switch 首先需要确定它属于哪个 VLAN。

如果帧中已经携带 802.1Q VLAN Tag，Switch 通常可以直接从 Tag 中读取 VID。

如果帧是 Untagged 帧，Switch 通常会使用入口端口的默认 VLAN，也就是 PVID。

例如：

```text
Port 1 PVID = 10
```

当 Port 1 收到一个不带 VLAN Tag 的帧时，Switch 可以在内部将它归类为 VLAN 10。

这里的“归类”并不一定意味着马上向原始报文中插入一个 VLAN Tag。很多 Switch 会在内部使用额外的元数据记录这个帧所属的 VLAN，等到 Egress 阶段再决定最终是否输出 Tag。

Ingress 阶段还可能执行 VLAN 过滤，例如：

- 是否允许 Untagged 帧进入；
- 是否允许 Tagged 帧进入；
- 帧中的 VID 是否存在；
- 入口端口是否属于该 VLAN；
- 不符合规则的帧是否直接丢弃。

### Egress VLAN 处理

当帧即将从某个端口发出时，Switch 需要决定最终输出的帧是否携带 VLAN Tag。

常见的 Egress 行为包括：

```text
Tagged：保留或添加 VLAN Tag
Untagged：移除 VLAN Tag
Unmodified：保持原始报文格式
Forbidden：禁止从该端口输出
```

因此，同一个 VLAN 内的帧经过不同端口发送时，最终格式可能不同。

例如：

```text
VLAN 10：
Port 1 → Untagged
Port 2 → Untagged
Port 5 → Tagged
```

Port 1 和 Port 2 可以连接不感知 VLAN 的终端，而 Port 5 可以连接需要同时承载多个 VLAN 的上级设备。

## ATU 与 FDB

VLAN 决定一个帧能够在哪个二层转发域内活动，但它不能直接告诉 Switch 目的设备位于哪个具体端口。

这个问题由 MAC 地址表解决。

常见名称包括：

```text
FDB：Forwarding Database
ATU：Address Translation Unit
MAC Address Table
```

在很多 Switch 芯片中，ATU 是负责维护和操作 MAC 地址表的硬件单元，而 FDB 更偏向于描述这张转发表本身。

一张简化的 MAC 地址表可以表示为：

| MAC 地址 | FID | 端口 |
|---|---:|---|
| 00:11:22:33:44:55 | 10 | Port 1 |
| AA:BB:CC:DD:EE:FF | 10 | Port 2 |

### 源 MAC 学习

假设 Port 1 收到一个帧：

```text
SMAC = 00:11:22:33:44:55
VID  = 10
```

Switch 可以根据入口端口和源 MAC 地址学习到：

```text
00:11:22:33:44:55
        ↓
FID 10
        ↓
Port 1
```

之后，其他设备向这个 MAC 地址发送数据时，Switch 就知道目标设备位于 Port 1。

学习得到的动态 MAC 地址表项通常会带有老化时间。

如果某个 MAC 地址在较长时间内没有再次出现，Switch 会自动删除对应的动态表项，避免设备移动到其他端口后仍然使用旧的转发信息。

除了动态学习，CPU 也可以通过驱动写入静态 MAC 地址表项。

静态表项常用于固定设备、管理地址、组播地址或特殊转发策略，并且通常不会因为普通的老化机制而被删除。

### 目的 MAC 查找

完成源 MAC 学习后，Switch 会查询目的 MAC。

假设帧的目的 MAC 为：

```text
DMAC = AA:BB:CC:DD:EE:FF
```

Switch 查询 ATU/FDB 后得到：

```text
FID 10 + AA:BB:CC:DD:EE:FF
        ↓
Port 2
```

只要 Port 2 属于对应 VLAN，并且处于允许转发的状态，Switch 就可以只将这个帧发送到 Port 2。

这就是已知单播转发。

## 已知单播、未知单播和广播

Switch 对二层帧的处理方式，很大程度上取决于目的 MAC 地址的类型，以及这个地址能否在 ATU/FDB 中查到。

### 已知单播

如果目的 MAC 地址能够在 ATU 中查询到，帧通常只会被发送到对应的目标端口。

```text
DMAC 查询成功
    ↓
仅发送到目标端口
```

这种行为能够避免无关端口收到不属于自己的单播流量。

### 未知单播

如果目的 MAC 是单播地址，但在 ATU 中查询不到，这个帧就属于未知单播。

Switch 通常会在当前 VLAN 的成员端口中进行泛洪：

```text
入口端口：Port 1
VLAN 成员：Port 1、Port 2、Port 3、Port 5

未知单播输出端口：
Port 2、Port 3、Port 5
```

是否允许未知单播泛洪、允许泛洪到哪些端口，通常也可以通过寄存器进行配置。

### 广播

广播帧的目的 MAC 地址为：

```text
FF:FF:FF:FF:FF:FF
```

Switch 通常会将广播帧发送到当前 VLAN 中除入口端口之外的所有允许端口。

广播并不是简单地发送到 Switch 上的全部物理端口，而是仍然受到 VLAN 成员关系、端口状态和过滤策略的限制。

### 组播

组播地址的最低有效位为 1，例如：

```text
01:00:5E:xx:xx:xx
33:33:xx:xx:xx:xx
```

对于普通二层组播，Switch 可以根据静态 ATU 表项、组播表、IGMP Snooping 或其他策略决定输出端口。

如果 Switch 无法确定组播成员，部分芯片可能会像广播一样在 VLAN 内泛洪。

## FID

有些 Switch 在查找 MAC 地址时，并不直接使用 VLAN ID，也就是 VID，而是使用 FID。

```text
FID = Filtering Identifier
```

FID 可以理解为：

> Switch 进行 MAC 地址学习和 MAC 地址查找时所使用的二层转发域编号。

在最简单的配置中，通常是一个 VLAN 对应一个 FID：

```text
VID 10 → FID 10
VID 20 → FID 20
```

此时，VLAN 10 和 VLAN 20 分别属于两个独立的 MAC 地址学习域。

部分 Switch 也允许多个 VLAN 共用同一个 FID：

```text
VID 10 ─┐
        ├── FID 1
VID 20 ─┘
```

这意味着 VLAN 10 和 VLAN 20 虽然拥有不同的 VLAN ID 和端口成员关系，但可以共用同一个 MAC 地址学习域。

因此，ATU/FDB 的查找键通常不只是 MAC 地址，而是：

```text
FID + MAC Address
```

例如，Switch 内部可以同时存在下面两条表项：

```text
FID 10 + MAC-A → Port 1
FID 20 + MAC-A → Port 5
```

这表示相同的 MAC 地址在不同转发域中可以对应不同端口。

如果 ATU 只根据 MAC 地址进行查找，而不区分 FID，那么相同 MAC 地址出现在不同 VLAN 中时就可能发生冲突。

VID 和 FID 可以简单理解为：

```text
VID：识别 VLAN，决定端口成员关系和 VLAN Tag
FID：划分 MAC 地址学习与查找使用的转发域
```

两者在很多简单配置中是一一对应的，但概念并不完全相同。

## Access、Trunk 和 Hybrid

Access、Trunk 和 Hybrid 并不是三种完全不同的物理端口，而是对端口 VLAN 行为的概括。

真正写入 Switch 芯片的，通常仍然是下面这些配置：

```text
端口属于哪些 VLAN
端口的 PVID 是多少
Ingress 接受 Tagged 还是 Untagged 帧
Egress 时添加、保留还是移除 VLAN Tag
是否进行 VLAN 成员过滤
```

### Access 端口

Access 端口通常只承载一个 VLAN，并连接不理解 VLAN Tag 的终端设备。

例如：

```text
Port 1：
PVID = 10
VLAN 10 Member = Yes
VLAN 10 Egress = Untagged
```

当终端向 Port 1 发送 Untagged 帧时，Switch 会在内部将其归入 VLAN 10。

当 VLAN 10 的帧从 Port 1 发出时，Switch 会移除 VLAN Tag，终端看到的仍然是普通 Ethernet II 帧。

因此，Access 端口可以概括为：

```text
入口 Untagged
内部属于一个 VLAN
出口 Untagged
```

### Trunk 端口

Trunk 端口通常同时承载多个 VLAN，并连接另一个 Switch、路由器、网关或者支持 VLAN 的 CPU。

例如：

```text
Port 5：
VLAN 10 Egress = Tagged
VLAN 20 Egress = Tagged
VLAN 30 Egress = Tagged
```

不同 VLAN 的帧都可以通过 Port 5 传输，并通过 VLAN Tag 区分所属网络。

Trunk 端口通常可以概括为：

```text
一个物理端口
承载多个 VLAN
主要通过 VLAN Tag 区分流量
```

部分系统还会为 Trunk 端口配置 Native VLAN。Native VLAN 的帧可以不携带 Tag，但不同芯片对 Native VLAN 的处理方式可能不同，需要结合具体文档确认。

### Hybrid 端口

Hybrid 端口同样可以属于多个 VLAN，但允许不同 VLAN 使用不同的 Egress Tag 行为。

例如：

```text
Port 5：
VLAN 10 → Untagged
VLAN 20 → Tagged
VLAN 30 → Tagged
```

这使得同一个端口既可以发送不带 Tag 的普通帧，也可以发送带 Tag 的 VLAN 帧。

从硬件配置角度看，Hybrid 并不是一个神秘的新模式，而是更加灵活的 VLAN 成员关系和 Egress Tag 组合。

因此，在阅读 Switch 驱动时，不应该只查找名为 `ACCESS_MODE`、`TRUNK_MODE` 或 `HYBRID_MODE` 的寄存器。

很多芯片并不存在这样的单一模式寄存器，而是通过 PVID、VLAN Membership、Ingress Policy 和 Egress Tag 等多个配置共同实现这些效果。

## CPU Port

Switch 芯片通常会有一个端口连接 CPU、MCU 或 SoC 的 Ethernet MAC。

这个端口通常被称为：

```text
CPU Port
Host Port
Management Port
```

从硬件转发角度看，CPU Port 仍然是一个普通的 Switch Port，只是它连接的不是外部终端，而是本地处理器。

CPU Port 可以承担多种任务。

一种情况是，CPU 只通过 MDIO、SMI 或 SPI 配置 Switch，普通业务报文完全在外部端口之间转发。此时 CPU Port 可能只处理少量管理报文，甚至不参与普通数据路径。

另一种情况是，某些报文需要上传到 CPU，例如：

```text
目的 MAC 地址是 CPU 自身
ARP、DHCP 或诊断报文
需要软件路由的三层报文
镜像报文
异常报文
PTP 时间同步报文
控制协议报文
未知或特殊组播报文
```

CPU 处理完成后，也可以通过 CPU Port 将报文重新发送到 Switch。

为了让 CPU 知道报文来自哪个物理端口、属于哪个 VLAN，部分 Switch 会在 CPU Port 上使用特殊的厂商 Tag。

这种 Tag 不一定是标准 802.1Q VLAN Tag，而可能是 Switch 厂商自定义的头部或尾部字段，其中可以携带：

```text
源端口
目的端口
VLAN
优先级
转发原因
时间戳信息
```

因此，CPU Port 并不等于“所有数据都必须经过 CPU”。

在硬件转发正常配置的情况下，大部分普通报文仍然可以直接在 Switch 内部完成转发，只有需要软件处理的报文才会上送 CPU。

## Switch 的寄存器空间为什么要分类

复杂的 Switch 芯片拥有大量寄存器。

这些寄存器通常不会全部放在一个简单的连续地址空间中，而是按照功能和作用范围划分。

以部分 Marvell Switch 的设计为例，常见的寄存器或硬件资源空间包括：

```text
Per-Port Registers
Global 1 Registers
Global 2 Registers
PHY Registers
MMD Registers
ATU Table
VTU Table
Statistics Counters
Vendor-Specific Registers
```

这种划分能够让端口配置、全局配置、PHY 配置和内部表操作相互独立。

需要注意的是，Global 1 和 Global 2 并不是行业统一标准。它们只是部分芯片厂商使用的功能分组方式，具体含义必须结合芯片对应的 Programming Guide。

## Per-Port Registers

Per-Port Registers 是每个端口独立拥有的一组寄存器。

从访问形式上看，可能类似：

```text
Port 0, Register 0
Port 0, Register 1
Port 0, Register 2

Port 1, Register 0
Port 1, Register 1
Port 1, Register 2
```

这些寄存器通常用于控制：

```text
端口转发状态
端口 VLAN 模式
PVID
Ingress 过滤
Egress Tag
源 MAC 学习
端口默认优先级
流控
端口镜像
接口速率和双工模式
```

因此，在驱动代码中看到以端口号为参数的寄存器读写函数时，通常就是在操作 Per-Port Registers。

例如：

```c
switch_port_write(port, PORT_CONTROL_REG, value);
```

这里的 `port` 用来选择具体端口，而 `PORT_CONTROL_REG` 表示该端口寄存器空间中的某个偏移。

## Global 1 Registers

Global 1 通常用于控制影响整个交换核心的功能。

常见内容可能包括：

```text
ATU 操作
VTU 操作
全局转发控制
MAC 地址老化时间
全局状态
中断状态
设备编号
统计或管理功能
```

ATU 和 VTU 往往不是普通的线性寄存器数组，而是 Switch 内部的硬件表。

CPU 需要通过 Global 寄存器中的 Command、Operation、Data 和 Busy 位对这些表进行间接访问。

## Global 2 Registers

Global 2 通常用于另一组全局辅助功能，例如：

```text
SMI PHY 管理
PHY Polling
中断控制
设备映射
级联配置
跨芯片路由
EEPROM 初始化
厂商扩展管理功能
```

Global 1 和 Global 2 的具体划分完全取决于芯片型号。

因此，看到 `GLOBAL1` 或 `GLOBAL2` 这样的宏时，只能知道它属于某一组全局寄存器，不能仅根据名称推断寄存器的详细功能。

## PHY 和 MMD 寄存器

Switch 的端口可能连接内部 PHY，也可能连接外部 PHY。

这些 PHY 通常仍然通过 Clause 22 或 Clause 45 寄存器空间进行配置。

常见配置包括：

```text
PHY Reset
Auto-Negotiation
Master/Slave
Link Status
SQI
Cable Diagnostic
100BASE-T1
1000BASE-T1
低功耗或唤醒功能
```

需要注意的是，Switch Port 寄存器和 PHY 寄存器并不是同一套寄存器。

Switch Port 寄存器主要控制交换核心中的端口行为，而 PHY 寄存器主要控制物理层链路。

例如：

```text
PHY Link Up
```

只表示物理层已经建立连接。

端口是否允许转发，还要继续检查 Switch Port 的状态、VLAN 配置以及转发表配置。

## ATU 和 VTU 的间接访问

ATU 和 VTU 通常不会表现为可以直接随机访问的普通寄存器数组。

它们更像是 Switch 芯片内部的硬件表：

```text
ATU：MAC 地址表
VTU：VLAN 表
```

CPU 一般需要通过一组操作寄存器间接访问这些表。

例如，写入一个 VLAN 表项时，操作流程可能是：

```text
等待 VTU Busy 位清零
        ↓
写入 VID
        ↓
写入 FID
        ↓
写入成员端口
        ↓
写入各端口 Egress Tag 状态
        ↓
设置 Load 操作码
        ↓
置位 Busy 或 Start
        ↓
等待硬件操作完成
```

对应的伪代码可能类似：

```c
int switch_vtu_load(const struct vlan_entry *entry)
{
    int ret;

    ret = wait_vtu_ready();
    if (ret != 0)
        return ret;

    write_vtu_vid(entry->vid);
    write_vtu_fid(entry->fid);
    write_vtu_members(entry->members);
    write_vtu_egress_mode(entry->egress_mode);

    start_vtu_operation(VTU_OP_LOAD);

    return wait_vtu_ready();
}
```

ATU 操作也类似。

添加一个静态 MAC 地址表项时，可能需要依次写入：

```text
MAC 地址
FID
目标端口向量
表项状态
操作命令
```

然后启动 `LOAD` 或 `PURGE` 操作，并等待 Busy 位清零。

因此，Switch 驱动中经常能看到下面这样的结构：

```c
wait_busy_clear();
write_data_registers();
write_operation_register();
wait_busy_clear();
```

这并不是多余的代码，而是 CPU 与 Switch 内部硬件表之间的同步机制。

## SMI 间接访问

部分 Switch 芯片并不能通过普通 MDIO 地址直接访问全部寄存器。

CPU 可能需要先访问一个 SMI Command 寄存器和一个 SMI Data 寄存器，再由 Switch 内部完成真正的寄存器访问。

一个典型的间接读流程可能是：

```text
等待 SMI Busy 清零
        ↓
向 SMI Command 写入设备地址、寄存器地址和 Read 命令
        ↓
等待 SMI Busy 清零
        ↓
从 SMI Data 读取结果
```

对应的伪代码可能类似：

```c
int switch_smi_read(uint8_t dev, uint8_t reg, uint16_t *value)
{
    int ret;

    ret = wait_smi_ready();
    if (ret != 0)
        return ret;

    write_smi_command(
        SMI_BUSY |
        SMI_OP_READ |
        SMI_DEV_ADDR(dev) |
        SMI_REG_ADDR(reg)
    );

    ret = wait_smi_ready();
    if (ret != 0)
        return ret;

    *value = read_smi_data();
    return 0;
}
```

驱动中的 `SW_SMI_BUSY`、`SW_SMI_OP_READ`、`SW_SMI_DEV_ADDR` 和 `SW_SMI_REG_ADDR` 等宏，本质上就是在构造这条管理命令。

理解间接访问机制后，再看到大量移位、掩码和 Busy 轮询时，就能够知道这些代码是在访问 Switch 内部的哪个寄存器空间，而不是在处理普通网络数据。

## 一个帧经过 Switch 的完整过程

前面的内容比较分散，下面将这些模块串联起来，看一下一个普通以太网帧进入 Switch 后的完整处理过程。

假设 Port 1 收到下面这个帧：

```text
DMAC = AA:BB:CC:DD:EE:FF
SMAC = 00:11:22:33:44:55
帧格式 = Untagged
Port 1 PVID = 10
```

### 确认入口端口状态

Switch 首先检查 Port 1 当前是否允许接收和转发数据。

如果端口处于 Disabled、Blocking 或其他禁止状态，报文可能在这一阶段直接被丢弃。

### 确定 VLAN

由于收到的是 Untagged 帧，Switch 使用 Port 1 的 PVID：

```text
VID = Port 1 PVID = 10
```

随后查询 VLAN 10 对应的 VTU 表项，确认：

```text
VLAN 10 是否有效
Port 1 是否属于 VLAN 10
该端口是否允许 Untagged 帧进入
```

如果入口 VLAN 检查失败，报文会被丢弃。

### 确定 FID

Switch 从 VLAN 10 的表项中得到对应 FID：

```text
VID 10 → FID 10
```

后续源 MAC 学习和目的 MAC 查找都会使用这个 FID。

### 学习源 MAC

Switch 根据源 MAC、FID 和入口端口更新 ATU：

```text
FID 10 + 00:11:22:33:44:55 → Port 1
```

如果已经存在相同表项，Switch 可能刷新它的老化时间；如果该 MAC 原来位于其他端口，Switch 可能更新端口信息。

### 查询目的 MAC

Switch 使用下面的键查询 ATU：

```text
FID 10 + AA:BB:CC:DD:EE:FF
```

如果查询结果为 Port 2，那么这个帧属于已知单播。

如果查询不到，则按照未知单播策略在 VLAN 10 中泛洪。

### 生成候选出口端口

假设查询结果为 Port 2，Switch 得到候选出口端口：

```text
Candidate Egress Port = Port 2
```

随后还需要继续检查：

```text
Port 2 是否属于 VLAN 10
Port 2 是否处于 Forwarding 状态
Port 2 是否被端口隔离策略禁止
是否允许从入口端口转发到 Port 2
是否存在 ACL、STP 或其他过滤规则
```

只有所有条件都满足，Port 2 才会成为最终出口端口。

### 执行 Egress VLAN 处理

假设 VLAN 10 对 Port 2 的 Egress 配置为 Untagged：

```text
VLAN 10, Port 2 → Untagged
```

Switch 会在发送前移除 VLAN Tag，或者直接按照 Untagged 格式输出。

如果 Port 2 的配置为 Tagged，Switch 则会输出带有 VLAN 10 Tag 的帧。

### 从目标端口发送

最终，报文通过 Port 2 的 MAC 和 PHY 发送到目标设备。

整个过程可以概括为：

```text
Port 1 收到帧
        ↓
检查入口端口状态
        ↓
解析 VLAN Tag 或使用 PVID
        ↓
查询 VTU，获得成员端口和 FID
        ↓
学习源 MAC
        ↓
使用 FID + DMAC 查询 ATU
        ↓
生成候选出口端口
        ↓
执行 VLAN、端口状态和策略过滤
        ↓
决定 Egress Tag 行为
        ↓
从目标端口发送
```

在正常硬件转发路径中，这一系列操作都由 Switch 芯片内部完成，不需要 CPU 逐帧参与。

## 项目代码实证：在车载交换芯片上 Switch driver 真正做了什么

前面讲了 Switch 的硬件转发模型——控制面 vs 数据面、Port、VTU、ATU/FDB、FID、Ingress/Egress、CPU Port、寄存器空间分类、SMI 间接访问、一个帧经过 Switch 的完整过程。这些都是协议层抽象。下面看在量产代码里，Switch driver 真正实现了哪些、没实现哪些，以及实现的代码长什么样。

本节以某车载 MCU 平台上的两款 Marvell 交换芯片（88Q5192 双 die / 88Q5152 单 die）驱动为例，所有代码用伪代码形式呈现，重点在讲清楚协议概念到代码的映射关系。

### 一些问题

Marvell 88Q5192/88Q5152 中我并没有看到类似VTU/ATU/动态学习和老化的逻辑，似乎是由**预烧录**的固件解决的。这里我主要讲讲driver中涉及到的一些功能：
1. **电源/复位**：上电、复位、电源序列
2. **MDIO 访问层**：SMI 间接访问、多 die 信号量、PHY 寄存器间接访问
3. **端口 cmode/速率检测**：上电后读端口 cmode 寄存器确认配置生效
4. **链路状态查询**：周期性读端口 link 状态
5. **统计查询**：读 MIB 计数器
6. **TC10 睡眠唤醒**：见第 3 章
7. **外部 PHY 级联**：通过 switch 的 SMI 间接访问外部 PHY 寄存器

### 控制面 VTable：switch_ops_t

项目中实现了类似以下的一个控制面接口，抽象成了一个VTable

```c
/* 伪代码：Switch 控制面 VTable */
typedef struct {
        /*初始化 Switch 芯片和各个端口*/
    status_t (*init) (switch_dev_t *dev);
    status_t (*deinit) (switch_dev_t *dev);
    status_t (*set_wakeup) (switch_dev_t *dev);
    status_t (*set_sleep) (switch_dev_t *dev, sleep_mode_t mode);
    status_t (*set_force_sleep) (switch_dev_t *dev);
    status_t (*set_port_wakeup) (switch_dev_t *dev, uint8_t port);
    status_t (*set_port_sleep) (switch_dev_t *dev, uint8_t port);
    status_t (*set_ports_wakeup) (switch_dev_t *dev, uint32_t port_mask);
    status_t (*set_ports_sleep) (switch_dev_t *dev, uint32_t port_mask);
    status_t (*port_send_wake_msg) (switch_dev_t *dev, uint8_t port);

    /* 查端口功耗模式 */
    status_t (*get_port_status) (switch_dev_t *dev, uint8_t port, port_status_t *status);
    /* 查 switch 整体功耗模式 */
    status_t (*get_status) (switch_dev_t *dev, switch_status_t *status);

    /* 通过 Switch 间接访问外部 PHY 寄存器（级联场景） */
    status_t (*read_external_phy) (const switch_dev_t *dev,
                                    uint32_t phyaddr, uint32_t devaddr,
                                    uint32_t regaddr, uint32_t *result);
    status_t (*write_external_phy) (const switch_dev_t *dev,
                                     uint32_t phyaddr, uint32_t devaddr,
                                     uint32_t regaddr, uint32_t data);

    /* 通用 control 接口，分发到 SQI/Link/Reset/MIB 等命令 */
    status_t (*control)(const switch_dev_t *dev, uint32_t cmd, void *data);
} switch_ops_t;
```

### Switch device 抽象：switch_dev_t 结构

```c
/* 伪代码：Switch 设备结构 */
typedef struct switch_dev_t {
    net_device_t base;                       /* 继承 net_device 基类 */
    switch_status_t consumption_mode;        /* 当前功耗模式：SLEEP/ACTIVE/FAIL 等 */
    uint16_t port;                           /* 连到本地 CPU/MAC 的端口号（CPU Port 概念） */
    switch_diagnostic_t diagnostic;           /* 睡眠诊断：失败计数、per-port 失败记录 */
    uint8_t ext_phy_num;                     /* 级联的外部 PHY 数量 */
    const switch_phy_info_t *ext_phy;         /* 外部 PHY 信息数组 */
    const switch_ops_t *ops;                 /* 上面那个 VTable */
    switch_stats_t stats;                    /* 17 项 MIB 统计 */
} switch_dev_t;
```

### 统计计数器：17 项 MIB


```c
/* 伪代码：Switch MIB 计数器 */
typedef struct {
    uint32_t in_bad_octets;
    uint32_t in_unicast;
    uint32_t in_broadcasts;
    uint32_t in_multicasts;
    uint32_t in_rx_err;
    uint32_t in_fcs_err;
    uint32_t in_undersize;
    uint32_t in_oversize;
    uint32_t out_unicast;
    uint32_t out_broadcasts;
    uint32_t out_multicasts;
    uint32_t out_fcs_err;
    uint32_t inout_64Octets;           /* 64 字节包数 */
    uint32_t inout_65to127Octets;      /* 65~127 字节包数 */
    uint32_t inout_128to255Octets;
    uint32_t inout_256to511Octets;
    uint32_t inout_512to1023Octets;
    uint32_t inout_1024toMaxOctets;
} switch_stats_t;
```

**这 17 项字段对应 IEEE 802.3 clause 30（Management）规定的 MIB 计数器**——任何符合 802.3 的 Switch 都该有这套统计（不同厂商可能字段命名略有差异）。上层通过 `control(dev, CMD_PORT_MIB_DUMP, ...)` 命令一次性 dump 这些计数器。

**字节分布桶 `inout_64Octets` 等 6 项** 是按帧长分桶统计，对应 RFC 2819 RMON（远程监控）标准。可以用来分析链路上是小包多还是大包多——车载网络里诊断/控制流是小包，音视频流是大包，分布比例能反映流量健康度。


### SMI 间接访问：


```
等待 SMI Busy 清零
        ↓
向 SMI Command 写入设备地址、寄存器地址和 Read 命令
        ↓
等待 SMI Busy 清零
        ↓
从 SMI Data 读取结果
```

看伪代码实现：

```c
/* 伪代码：SMI 间接访问读 */
status_t switch_read_multi_addr_smi_reg(const switch_dev_t *dev, uint32_t port,
                                        uint32_t regaddr, uint32_t *result)
{
    uint32_t val = 0;
    uint32_t recval = 0u;
    uint8_t retry = 0;

    /* Step 1：组装命令字（Busy | Mode22 | Read | DevAddr | RegAddr） */
    val = SMI_CMD_BUSY | SMI_CMD_MODE_22 | SMI_CMD_READ
          | SMI_CMD_DEVADDR_SET(port) | SMI_CMD_REGADDR_SET(regaddr);

    /* Step 2：写 SMI Multi-Address Command 寄存器，触发硬件发起 SMI 访问 */
    switch_write_reg(dev, dev->bus_addr,
                     SMI_MULTI_ADDR_CMD_REG, val, CLAUSE_22);

    /* Step 3：轮询 Busy 位清零（最多重试 3 次，每次等 5 ms） */
    while (1) {
        switch_read_reg(dev, dev->bus_addr,
                        SMI_MULTI_ADDR_CMD_REG, &recval, CLAUSE_22);
        if ((0 == (recval & SMI_CMD_BUSY)) || (retry > 3)) {
            break;
        }
        sleep_ms(INIT_WAIT_MS);   /* 5 ms */
        retry++;
    }

    /* Step 4：Busy 清零后，从 SMI Multi-Address Data 寄存器读结果 */
    if ((retry <= 3)) {
        switch_read_reg(dev, dev->bus_addr,
                        SMI_MULTI_ADDR_DATA_REG, result, CLAUSE_22);
    }
    return OK;
}
```


**逐字段拆解 SMI Command 字的位布局**：

```c
#define SMI_MULTI_ADDR_CMD_REG          (0x0U)   /* Global2 空间的 SMI Command 寄存器偏移 */
#define SMI_MULTI_ADDR_DATA_REG         (0x01U)  /* Global2 空间的 SMI Data 寄存器偏移 */
#define SMI_CMD_BUSY                    (0x1<<15)  /* bit 15 = Busy */
#define SMI_CMD_MODE_22                 (0x1<<12)  /* bit 12 = 1 表示 Clause 22 模式 */
#define SMI_CMD_WRITE                   (0x01<<10) /* bit 10 = Write（OP=01） */
#define SMI_CMD_READ                    (0x02<<10) /* bit 11 = Read（OP=10） */
#define SMI_CMD_DEVADDR_OFFSET          (5U)
#define SMI_CMD_DEVADDR_SET(x)          ((x) << SMI_CMD_DEVADDR_OFFSET)  /* bit 9:5 = 设备地址 */
#define SMI_CMD_REGADDR_OFFSET          (0U)
#define SMI_CMD_REGADDR_SET(x)          (x << SMI_CMD_REGADDR_OFFSET)    /* bit 4:0 = 寄存器地址 */
```


**Write 路径**：

```c
/* 伪代码：SMI 间接访问写 */
status_t switch_write_multi_addr_smi_reg(const switch_dev_t *dev, uint32_t port,
                                         uint32_t regaddr, uint32_t data)
{
    /* Step 1：先把数据写到 SMI Data 寄存器 */
    switch_write_reg(dev, dev->bus_addr, SMI_MULTI_ADDR_DATA_REG, data, CLAUSE_22);

    /* Step 2：组装命令字（Busy | Mode22 | Write | DevAddr | RegAddr），写 Command 寄存器启动 */
    uint32_t val = SMI_CMD_BUSY | SMI_CMD_MODE_22 | SMI_CMD_WRITE
                 | SMI_CMD_DEVADDR_SET(port) | SMI_CMD_REGADDR_SET(regaddr);
    switch_write_reg(dev, dev->bus_addr, SMI_MULTI_ADDR_CMD_REG, val, CLAUSE_22);
    return 0;
}
```

注意 Write 比 Read 简单——不需要等 Busy 清零再读 Data，因为数据已经在第一步写进去了。但严格来说写完也应该轮询 Busy 确认硬件完成（部分实现会省略，因为 SMI Multi-Address Write 通常很快）。

### 多 die 信号量：


某些车载交换芯片（如 88Q5192）是**双 die 封装**——一个芯片里有 2 个独立的 Switch die（每个 die 最多 10 端口，共 20 端口）。两个 die 共享同一条 SMI 总线，但每个 die 有自己独立的 Global1/Global2 寄存器空间。

**问题**：如果 CPU 要在 die0 和 die1 上同时操作 ATU/VTU（共享硬件表），就需要互斥。

**方案**：在 Global1 寄存器空间里有一个 Semaphore 寄存器（`GLOBAL1_SEMAPHORE_REG = 0x15`），通过"写锁值 → 读回确认"实现硬件信号量。

```c
/* 伪代码：多 die 信号量加锁 */
static inline void switch_lock_semaphore(switch_dev_t *dev)
{
    uint8_t count = 0;
    uint32_t val = 0;

    if (dev->is_locked) {
        log("semaphore already locked\n");
        return;
    }

    /* 遍历两个 die */
    for (die_type_t die = DIE_0; die < DIE_UNUSED; die++) {
        /* Step 1：切到目标 die（写 SMI 间接访问的 die 选择位） */
        switch_switch_smi_die(dev, die);

        /* Step 2：尝试写 LOCK_VALUE (0x8000) 到 Semaphore 寄存器 */
        do {
            switch_write_multi_addr_smi_reg(dev, GLOBAL1_REG, SEMAPHORE_REG, LOCK_VALUE);
            val = 0u;
            switch_read_multi_addr_smi_reg(dev, GLOBAL1_REG, SEMAPHORE_REG, &val);
            if (LOCK_VALUE == val) {
                break;   /* 读回等于写值 → 拿到锁 */
            }
#ifdef COMPATIBLE_WITH_SEMAPHORE_REG
            else if (RMU_LOCK_VALUE != val && UNLOCK_VALUE != val) {
                /* 读到非预期值（可能是其它 master 持锁）→ 先解锁再重试 */
                switch_write_multi_addr_smi_reg(dev, GLOBAL1_REG, SEMAPHORE_REG, UNLOCK_VALUE);
                log("unexpected lock val [0x%x] die [%d]\n", val, die);
            }
#endif
            sleep_ms(1);
            count++;
        } while (count < 10u);   /* 最多重试 10 ms */

        if (LOCK_VALUE == val) {
            continue;   /* 这个 die 拿到锁，处理下一个 die */
        }
        /* 10 ms 还没拿到锁 → 强制解锁再锁一次（容错） */
        switch_write_multi_addr_smi_reg(dev, GLOBAL1_REG, SEMAPHORE_REG, UNLOCK_VALUE);
        switch_write_multi_addr_smi_reg(dev, GLOBAL1_REG, SEMAPHORE_REG, LOCK_VALUE);
        val = 0u;
        switch_read_multi_addr_smi_reg(dev, GLOBAL1_REG, SEMAPHORE_REG, &val);
        log("force lock val [0x%x] die [%d]\n", val, die);
    }
    dev->is_locked = true;
}

/* 伪代码：多 die 信号量解锁 */
static inline void switch_unlock_semaphore(switch_dev_t *dev)
{
    /* 解锁时分别给两个 die 写 UNLOCK_VALUE */
    switch_switch_smi_die(dev, DIE_0);
    switch_write_multi_addr_smi_reg(dev, GLOBAL1_REG, SEMAPHORE_REG, UNLOCK_VALUE);
    switch_switch_smi_die(dev, DIE_1);
    switch_write_multi_addr_smi_reg(dev, GLOBAL1_REG, SEMAPHORE_REG, UNLOCK_VALUE);
    dev->is_locked = false;
}
```

**关键宏定义**：

```c
#define GLOBAL1_SEMAPHORE_REG   (0x15u)    /* Global1 寄存器空间的 Semaphore 偏移 */
#define LOCK_VALUE              (0x8000u)  /* 锁值：bit 15 = 1 */
#define RMU_LOCK_VALUE          (0x0008u)  /* RMU（Remote Management Unit）持锁标志 */
#define UNLOCK_VALUE            (0x0000u)  /* 解锁值 */
```

### 完整数据流图：CPU → Switch → 外部 PHY

```
┌─────────────────────────────────────────────────────────────────────┐
│                       CPU / MCU / SoC                                │
│                                                                      │
│  switch_control(dev, CMD_PORT_MIB_DUMP)                              │
│      │                                                               │
│      ▼                                                               │
│  switch_ops_t.control()                                              │
│      │                                                               │
│      ▼                                                               │
│  switch_read_reg/write_reg()                                         │
│      │                                                               │
│      │ 调 bus_ops->read/write()，参数 mdio_msg_t                     │
│      ▼                                                               │
└──────┬──────────────────────────────────────────────────────────────┘
       │ MDIO 总线（MDC + MDIO 信号）
       │ clause 22/45 帧
       ▼
┌──────────────────────────────────────────────────────────────────────┐
│                  Switch 芯片                                          │
│                                                                       │
│  ┌─── Global2 寄存器空间 ───────────────────────────────┐           │
│  │  SMI_PHY_CMD (0x18)                                   │           │
│  │  SMI_PHY_DATA (0x19)                                  │           │
│  │  SMI_MULTI_ADDR_CMD (0x0)                            │           │
│  │  SMI_MULTI_ADDR_DATA (0x1)                           │           │
│  └───────────────────────────────────────────────────────┘           │
│      │                                                               │
│      │ CPU 写 SMI_PHY_CMD，触发 Switch 内部 SMI 控制器              │
│      ▼                                                               │
│  ┌─── Switch 内部 SMI 控制器 ─────────────────────────┐             │
│  │  根据 SMI_FUNC 字段选择目标：                        │             │
│  │    INNER_ACCESS  → die0/die1 内置 PHY                │             │
│  │    EXTER_ACCESS  → die 上端口级联的外部 PHY          │             │
│  │  发起第二次 MDIO 访问（clause 22 或 45）              │             │
│  └───────────────────────────────────────────────────────┘             │
│      │                                │                                │
│      ▼ 内部 PHY                       ▼ 外部 PHY                      │
│  ┌───────────────┐               ┌─────────────────┐                  │
│  │ die0 内置 PHY │               │ 外部 PHY（如     │                  │
│  │ 1000BASE-T1   │               │  88Q1110 等）   │                  │
│  └───────────────┘               └─────────────────┘                  │
│                                                                       │
│  ┌─── Global1 寄存器空间 ────────────────────────────────┐           │
│  │  GLOBAL1_SEMAPHORE_REG (0x15)  ← 多 die 互斥信号量     │           │
│  │  ATU/VTU 操作命令寄存器（项目代码未直接用）            │           │
│  └───────────────────────────────────────────────────────┘           │
│                                                                       │
│  ┌─── Per-Port 寄存器 ──────────────────────────────────┐            │
│  │  Port 0, reg 0x00 = cmode + speed 状态               │            │
│  │  Port 5, reg 0x00 = ext MCU port cmode + speed        │            │
│  │  ...                                                   │            │
│  │  （Port Forwarding、PVID、Egress Tag 等不在 driver 配置）│           │
│  └───────────────────────────────────────────────────────┘            │
│                                                                       │
│  ┌─── Switch 内置固件（ARM core）──────────────────────┐              │
│  │  • 加载出厂/产线烧录的 VTU/VLAN Membership 配置      │              │
│  │  • ATU 动态学习 + 老化                                │              │
│  │  • 已知单播/未知单播/广播/组播转发决策                │              │
│  │  • QoS 调度                                          │              │
│  │  → 这些 driver 都不参与                              │              │
│  └───────────────────────────────────────────────────────┘            │
└───────────────────────────────────────────────────────────────────────┘
```


