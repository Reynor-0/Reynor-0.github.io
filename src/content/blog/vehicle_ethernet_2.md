---
title: '车载以太网（五）：Switch 硬件转发模型'
description: '从嵌入式软件开发的角度理解车载以太网 Switch、VLAN、ATU、FID、端口配置与硬件转发。'
category: '协议'
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

## 从驱动代码反推硬件行为

理解 Switch 的硬件模型之后，再阅读驱动代码时，可以尝试按照“这段代码改变了什么硬件行为”进行分析。

例如看到下面的代码：

```c
switch_port_set_pvid(port, 10);
```

不要只停留在“向某个寄存器写入了 10”。

它真正表示的是：

```text
该端口收到 Untagged 帧时，默认将帧归入 VLAN 10
```

看到：

```c
switch_vtu_add(10, members, egress_mode);
```

可以进一步理解为：

```text
创建 VLAN 10
指定哪些端口属于 VLAN 10
指定这些端口发送时是否携带 VLAN Tag
```

看到：

```c
switch_atu_add(mac, fid, port_vector);
```

可以理解为：

```text
向 MAC 地址表中添加一条静态转发表项
当对应 FID 中出现该目的 MAC 时，发送到指定端口
```

看到：

```c
switch_port_set_state(port, FORWARDING);
```

表示的是：

```text
允许该端口参与正常数据转发
```

驱动里的寄存器值、位掩码和操作命令只是实现方式，最终目标都是改变 Switch 的转发行为。

## 阅读 Switch 驱动时可以关注什么

我现在阅读一份新的 Switch 驱动时，通常会先寻找最底层的寄存器访问函数。

例如：

```text
switch_read()
switch_write()
smi_read()
smi_write()
mdio_read()
mdio_write()
```

先确认 CPU 通过什么接口访问 Switch，以及设备地址、端口号和寄存器地址是怎样编码的。

然后再寻找端口初始化代码，确认每个端口的接口模式、速率、转发状态、PVID 和 VLAN 策略。

接下来重点关注 VTU 和 ATU 的操作函数，因为这两部分基本决定了 Switch 的二层转发行为。

最后再结合芯片手册，确认以下几个问题：

```text
一个端口属于哪些 VLAN
Untagged 帧进入后使用哪个 PVID
帧离开端口时是否携带 VLAN Tag
MAC 地址使用 VID 还是 FID 进行查找
未知单播、广播和组播怎样处理
CPU Port 是否使用厂商自定义 Tag
端口 Link Up 后是否还需要单独设置 Forwarding
```

只要能够回答这些问题，通常就已经能够建立起对整个 Switch 配置的基本认识。

## 总结

Switch 驱动与普通网络应用最大的区别，是驱动主要负责配置硬件转发规则，而不是由 CPU 逐包完成数据转发。

VLAN Table 决定帧可以在哪些端口之间活动，ATU/FDB 决定目的 MAC 地址位于哪个端口，FID 用于划分 MAC 地址的学习和查找域，端口寄存器则决定每个端口是否允许转发、怎样处理 VLAN Tag 以及怎样参与整个交换网络。

Access、Trunk 和 Hybrid 也不是完全独立的硬件功能，而是 PVID、VLAN Membership、Ingress Policy 和 Egress Tag 等配置组合后的表现。

最终，一个帧在 Switch 内部经历的过程可以概括为：

```text
入口端口检查
    ↓
VLAN 分类
    ↓
源 MAC 学习
    ↓
目的 MAC 查找
    ↓
出口端口过滤
    ↓
Egress Tag 处理
    ↓
硬件发送
```

CPU 通过寄存器、ATU 和 VTU 配置好这些规则后，Switch 就能够在不经过 CPU 软件转发的情况下，以硬件速度处理普通以太网帧。

理解了这个过程后，再去阅读 Switch 驱动中的端口初始化、VLAN 配置、ATU 操作、SMI 间接访问和 Busy 位轮询，代码背后的硬件行为就会清晰很多。

## 系列导航

- [车载以太网（一）：以太网帧与 VLAN](/blog/vehicle_ethernet_1/)
- [车载以太网（二）：MDIO 与 Clause 22/45](/blog/vehicle_ethernet_mdio/)
- [车载以太网（三）：100/1000BASE-T1 PHY、Master/Slave 与 SQI](/blog/vehicle_ethernet_phy/)
- [车载以太网（四）：TC10 休眠与唤醒](/blog/vehicle_ethernet_tc10/)
- [车载以太网（五）：Switch 硬件转发模型](/blog/vehicle_ethernet_2/)
