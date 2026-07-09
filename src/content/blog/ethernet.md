---
title: "以太网驱动学习笔记：MAC、PHY 与 MII 接口"
description: "整理 Ethernet MAC、PHY、MII/RMII/RGMII 接口的基本概念、Linux BSP 配置思路以及常见 bring up 调试方法。"
pubDate: "Jul 09 2026"
---

## 前言

在学习以太网驱动时，经常会遇到一些容易混淆的概念，例如：

```text
MAC、PHY、MII、RMII、RGMII、MDIO、MDC、phy-mode
```

这些概念看起来都和网口有关，但它们所在的层次并不一样。如果不先把整体链路理清楚，很容易出现一种情况：知道很多调试命令，也看过很多设备树字段，但真正遇到网口不通时，仍然不知道应该从哪里开始排查。

这篇文章主要是我个人在学习以太网驱动时整理的一份笔记，重点围绕 **MAC、PHY 和 MII 接口** 展开。文章不追求把所有协议细节都展开，而是希望把几个核心问题串起来：

```text
MAC 和 PHY 分别负责什么？
MII/RMII/RGMII 是什么？
MDIO/MDC 和 MII 有什么区别？
Linux 设备树中的 phy-mode 为什么重要？
以太网 bring up 时应该按什么顺序排查？
```

整体上可以把这篇文章分成三条主线：

```text
第一条主线：硬件链路
    从 SoC 内部 MAC 到外部 PHY，再到 RJ45 和网线。

第二条主线：接口关系
    重点理解 MII/RMII/RGMII 负责数据传输，MDIO/MDC 负责管理 PHY。

第三条主线：Linux BSP 调试
    从设备树、驱动初始化、PHY 识别、link up、收发包、错误统计几个阶段逐步排查。
```

---

## 以太网硬件链路总览

一个典型的嵌入式以太网硬件链路大致如下：

```text
CPU / SoC
   |
   | 内部总线，例如 AXI / AHB / PCIe
   v
Ethernet MAC
   |
   | MII / RMII / RGMII / GMII / SGMII
   v
Ethernet PHY
   |
   | MDI，物理介质相关接口
   v
RJ45 / Transformer / 双绞线
   |
   v
交换机 / 路由器 / PC
```

在这个链路中，MAC 通常集成在 SoC 或 MCU 内部，负责处理以太网帧；PHY 通常是外部芯片，负责把数字信号转换成网线上的物理电气信号。MAC 和 PHY 之间需要通过某种标准数字接口连接，这类接口就包括 MII、RMII、RGMII 等。

可以先用一句话记住它们的关系：

```text
MAC 负责以太网帧，PHY 负责物理层电气信号，MII/RMII/RGMII 是 MAC 和 PHY 之间的数据接口。
```

另外还要注意 MDIO/MDC。它们经常和 MII 一起出现，但作用不同。MII/RMII/RGMII 主要负责传输真正的以太网数据帧，而 MDIO/MDC 主要负责读写 PHY 内部寄存器，例如读取 PHY ID、查询 link 状态、配置自协商、读取速率和双工模式等。

---

## MAC 和 PHY 分别是什么

### MAC

MAC 是 **Media Access Control**，中文可以理解为介质访问控制层。在以太网中，MAC 处理的是“以太网帧”这一层的内容。

MAC 通常负责以太网帧发送和接收、MAC 地址过滤、广播/组播/单播过滤、CRC 校验、帧长度检查、DMA 描述符管理、收发 FIFO、中断产生、流控以及全双工/半双工控制等工作。

在嵌入式平台中，MAC 常常是 SoC 内部的一个外设模块。例如 STM32 内部的 Ethernet MAC、NXP i.MX 系列中的 FEC/ENET、Rockchip 的 GMAC、某些车规 SoC 中的 Ethernet MAC 等。

MAC 本身并不直接驱动网线。它输出的是数字形式的以太网帧数据。真正连接网线、变压器、RJ45，并完成电气信号转换的是 PHY。

### PHY

PHY 是 **Physical Layer**，也就是物理层芯片。PHY 的主要职责是把 MAC 侧的数字信号转换成网线上的模拟电气信号，或者把网线上收到的信号恢复成数字数据交给 MAC。

PHY 常见功能包括数字信号和模拟信号转换、编码和解码、链路自协商、速率协商、全双工/半双工协商、网线侧电气驱动、链路状态检测、MDI/MDIX 自动翻转、信号均衡和时钟恢复等。

常见 PHY 芯片有 LAN8720、DP83848、DP83867、KSZ8081、RTL8211、YT8531、AR8035 等。不同 PHY 支持的速率、接口模式、延迟配置、诊断能力、车规等级都可能不同。

### 为什么 MAC 和 PHY 要分开

MAC 和 PHY 分开之后，SoC 厂商可以把 MAC 做成相对通用的数字模块，而不同产品可以根据实际需求选择不同 PHY。例如低成本 100M 产品可以使用 RMII PHY，高性能产品可以使用千兆 RGMII PHY，工业或车载产品可以选择带有更强诊断能力和可靠性的 PHY。

这种分离带来的好处是：SoC 的 MAC 可以复用，不同物理介质可以通过不同 PHY 适配，产品也可以根据成本、速率、工业等级、车规要求选择不同 PHY。

---

## MII、RMII、RGMII 的关系

MII 是 **Media Independent Interface**，意思是介质无关接口。它位于 MAC 和 PHY 之间，核心作用是在 MAC 和 PHY 之间传输以太网帧数据。

“Media Independent”的意思是：MAC 不需要关心外部最终接的是双绞线、光纤、背板还是其他介质，MAC 只需要通过标准数字接口和 PHY 通信，具体物理介质由 PHY 负责适配。

在实际工程中，“MII”有时也会被广义地用来表示 MAC-PHY 接口家族，例如 MII、RMII、GMII、RGMII、SGMII 等。这里重点整理最常见的 MII、RMII 和 RGMII。

| 接口  | 全称                        | 常见速率         | 数据位宽               | 典型时钟      | 主要特点                     |
| ----- | --------------------------- | ---------------- | ---------------------- | ------------- | ---------------------------- |
| MII   | Media Independent Interface | 10/100 Mbps      | TX 4bit + RX 4bit      | 100M 下 25MHz | 标准 10/100M 接口，引脚较多  |
| RMII  | Reduced MII                 | 10/100 Mbps      | TX 2bit + RX 2bit      | 50MHz REF_CLK | MII 的少引脚版本，常见于 MCU |
| RGMII | Reduced GMII                | 10/100/1000 Mbps | TX 4bit + RX 4bit，DDR | 千兆下 125MHz | 千兆常用，时序要求高         |

### 标准 MII

标准 MII 常用于 10/100 Mbps 以太网。它的数据宽度是 4 bit，发送和接收方向各有一组数据线。

发送方向常见信号包括 `TXD[3:0]`、`TX_EN`、`TX_ER`、`TX_CLK`；接收方向常见信号包括 `RXD[3:0]`、`RX_DV`、`RX_ER`、`RX_CLK`。

100 Mbps 模式下，MII 时钟通常是 25MHz，因此数据率可以简单理解为：

```text
4 bit × 25 MHz = 100 Mbps
```

10 Mbps 模式下，时钟通常降为 2.5MHz：

```text
4 bit × 2.5 MHz = 10 Mbps
```

标准 MII 的优点是结构清晰，缺点是引脚数量较多。因此在很多 MCU 场景中，RMII 更常见。

### RMII

RMII 是 **Reduced Media Independent Interface**，可以理解为 MII 的精简版。它把数据线从 4 bit 缩减为 2 bit，从而减少 MAC 和 PHY 之间的引脚数量。

RMII 常见信号包括 `TXD0`、`TXD1`、`RXD0`、`RXD1`、`TX_EN`、`CRS_DV`、`REF_CLK`、`MDIO`、`MDC`。

为了在 2 bit 数据宽度下支持 100 Mbps，RMII 使用 50MHz 参考时钟：

```text
2 bit × 50 MHz = 100 Mbps
```

RMII 常见于 MCU + 100M PHY 的场景，例如 STM32 + LAN8720 这类组合。调试 RMII 时，一个非常重要的问题是 50MHz REF_CLK 到底由谁提供。它可能由 PHY 提供给 MAC，也可能由 MAC 或外部晶振提供给 PHY 和 MAC。这个方向必须和原理图、设备树、时钟配置保持一致。

### RGMII

RGMII 是 **Reduced Gigabit Media Independent Interface**，可以理解为 GMII 的精简版，常用于 10/100/1000 Mbps 以太网。

RGMII 仍然使用 4 bit 数据线，但它采用 DDR 双沿采样，也就是时钟上升沿和下降沿都传输数据。千兆模式下可以理解为：

```text
4 bit × 2 edges × 125 MHz = 1000 Mbps
```

RGMII 常见信号包括 `TXD[3:0]`、`RXD[3:0]`、`TXC`、`RXC`、`TX_CTL`、`RX_CTL`、`MDIO`、`MDC`。

RGMII 的优势是支持千兆，并且引脚数比 GMII 少。它的难点是时序要求明显更高，尤其要关注 TX delay 和 RX delay。如果 delay 配置不正确，可能出现 PHY 能 link up，但 ping 不通；100M 能通，1000M 不通；小包能通，大包丢包；CRC error 增加等问题。

---

## MDIO/MDC：管理 PHY 的接口

MII/RMII/RGMII 负责 MAC 和 PHY 之间的数据通路，但 MAC 还需要配置 PHY、读取 PHY 状态，这就需要 MDIO/MDC。

MDC 是管理接口时钟，一般由 MAC 提供。MDIO 是双向数据线，用于读写 PHY 内部寄存器。

通过 MDIO/MDC，MAC 可以读取 PHY ID、读取 Basic Status Register、配置 Basic Control Register、查询 link up/down 状态、查询自协商结果、读取协商到的速率和双工模式、配置 loopback，以及访问 PHY 厂商自定义寄存器。

这里最容易混淆的一点是：

```text
MDIO/MDC 不传输以太网帧；
MDIO/MDC 只负责管理 PHY；
MII/RMII/RGMII 才负责 MAC 和 PHY 之间的数据收发。
```

因此在调试时，如果 MDIO 不通，通常表现为驱动读不到 PHY ID，或者报 MDIO timeout、No PHY found。即使 MDIO 能读到 PHY，也只能说明管理通路基本正常，并不代表 MAC-PHY 数据线一定正常。

---

## Linux BSP 中如何描述 MAC-PHY 接口

在 Linux BSP 中，MAC 和 PHY 的连接关系通常通过设备树描述。比较核心的字段有：

```text
phy-mode
phy-handle
reg
reset-gpios
clocks
status
```

一个简化的 RGMII 设备树示例：

```dts
&gmac0 {
    phy-mode = "rgmii-id";
    phy-handle = <&phy0>;
    status = "okay";
};

&mdio {
    phy0: ethernet-phy@1 {
        reg = <1>;
    };
};
```

一个简化的 RMII 设备树示例：

```dts
&eth0 {
    phy-mode = "rmii";
    phy-handle = <&phy0>;
    status = "okay";
};

&mdio {
    phy0: ethernet-phy@0 {
        reg = <0>;
    };
};
```

其中 `phy-mode` 表示 MAC 和 PHY 之间使用什么接口模式，例如 `"mii"`、`"rmii"`、`"rgmii"`、`"rgmii-id"`、`"rgmii-rxid"`、`"rgmii-txid"`、`"sgmii"` 等。`phy-handle` 用来指向具体 PHY 节点，`reg` 表示 PHY 在 MDIO 总线上的地址。

RGMII 相关的 `phy-mode` 尤其容易出问题：

| phy-mode     | 含义                       |
| ------------ | -------------------------- |
| `rgmii`      | 不额外增加内部 delay       |
| `rgmii-id`   | TX 和 RX 都使用内部 delay  |
| `rgmii-rxid` | 只对 RX 方向增加内部 delay |
| `rgmii-txid` | 只对 TX 方向增加内部 delay |

实际配置时不能只看驱动示例，必须结合原理图、PCB 走线、SoC 手册、PHY datasheet 和 PHY strap 配置一起判断。RGMII delay 可能由 SoC MAC 提供，也可能由 PHY 提供，也可能 PCB 已经通过走线做了延迟。如果多个地方重复加 delay，或者完全没有加 delay，都可能导致千兆链路不稳定。

---

## 以太网驱动初始化的大致流程

从 Linux 驱动角度看，以太网初始化大致可以理解为下面这个过程：

```text
Device Tree
    |
    v
MAC driver probe
    |
    +--> 解析 phy-mode
    +--> 获取 phy-handle
    +--> 注册或查找 MDIO bus
    +--> 通过 MDIO 读取 PHY ID
    +--> 绑定 PHY driver
    +--> 配置 MAC-PHY 接口模式
    +--> 注册 net_device
    |
    v
ip link set eth0 up
    |
    v
PHY autoneg
    |
    v
link up 后配置 MAC speed / duplex
    |
    v
开始收发数据
```

MAC driver 通常负责注册 `net_device`、配置 DMA descriptor、收发 skb、处理中断、启动或停止 MAC，并通过 phylib 或 phylink 与 PHY 建立连接。

PHY driver 则负责识别 PHY ID、配置自协商、读取 link 状态、读取速率和双工、处理中断以及执行厂商特定初始化。

在实际 BSP 调试中，可以把驱动分成两条路径看：

```text
控制路径：
    设备树解析、MDIO 读写、PHY 识别、自协商、link 状态更新。

数据路径：
    MAC DMA descriptor、skb 收发、中断、NAPI、MII/RMII/RGMII 数据线传输。
```

如果 PHY ID 都读不到，优先查控制路径，例如电源、reset、MDC/MDIO、PHY 地址和设备树。如果 PHY 能识别但收发包异常，就要进一步看数据路径，例如 phy-mode、RGMII delay、数据线、DMA、中断和错误统计。

---

## Ethernet bring up 的推荐排查顺序

以太网调试不要一开始就陷入驱动代码。更稳妥的方式是按照硬件链路从下到上逐步排查。

我个人更推荐下面这个顺序：

```text
1. 看原理图
   先确认 MAC 和 PHY 之间到底是 MII、RMII 还是 RGMII。
   同时确认 PHY 地址、reset 引脚、时钟来源、供电电压和网口连接。

2. 查 PHY datasheet
   确认电源轨、reset 时序、strap pin、PHY address、接口模式、delay 配置。

3. 检查设备树
   确认 phy-mode、phy-handle、reg、reset-gpios、clock、pinctrl、status 是否和硬件一致。

4. 上电测量
   用万用表或示波器确认 PHY 电源、reset、clock 是否正常。
   RMII 重点看 50MHz REF_CLK，RGMII 重点看 TXC/RXC。

5. 检查 MDIO
   如果能读到 PHY ID，说明 MDIO/MDC 管理通路基本正常。
   如果读不到 PHY ID，优先查电源、reset、MDC/MDIO 引脚复用、PHY 地址。

6. 检查 link
   使用 ethtool 查看 link、speed、duplex、自协商状态。
   如果 link 不起来，优先查网线、交换机、PHY 侧 MDI、晶振、strap、自协商。

7. 检查收发包
   使用 ping、tcpdump、iperf、ethtool -S 观察是否有包、是否有错误计数。
   如果 link up 但 ping 不通，要重点查 phy-mode、RGMII delay、MAC 地址、IP 和路由。

8. 长时间压力测试
   使用持续 ping、iperf、反复插拔网线等方式验证稳定性。
```

这个顺序的好处是可以避免一上来就改驱动。很多 Ethernet bring up 问题其实不是驱动核心逻辑错，而是设备树、reset、clock、PHY 地址、RGMII delay 或硬件连接不一致导致的。

---

## Linux 下常用调试命令

调试命令不需要每个都单独展开成一节，实际使用时按目的记住即可。

| 目的             | 命令                                               | 关注点                                         |
| ---------------- | -------------------------------------------------- | ---------------------------------------------- |
| 查看网卡是否存在 | `ip link` 或 `ifconfig -a`                         | 是否出现 `eth0`、`end0` 等网卡                 |
| 启动网卡         | `ip link set eth0 up`                              | 是否报错，dmesg 是否有 PHY/link 日志           |
| 查看内核日志     | `dmesg \| grep -i -E "eth\|phy\|mdio\|gmac\|enet"` | MAC probe、PHY ID、MDIO timeout、link 信息     |
| 查看链路状态     | `ethtool eth0`                                     | Speed、Duplex、Auto-negotiation、Link detected |
| 查看统计信息     | `ethtool -S eth0`                                  | rx/tx packets、crc error、drop、timeout        |
| 查看中断         | `cat /proc/interrupts`                             | 网卡中断计数是否增加                           |
| 抓包             | `tcpdump -i eth0 -n`                               | 是否有 ARP、ICMP、DHCP 等报文                  |
| 查看 IP 和路由   | `ip addr`、`ip route`                              | IP、网关、路由是否正确                         |
| 查看运行时设备树 | `ls /proc/device-tree/`                            | 实际加载的设备树是否符合预期                   |
| 读取 PHY 寄存器  | `phytool read eth0/0/1`                            | 是否能读寄存器，link bit 是否变化              |

如果系统没有 `phytool`，也可以根据平台情况使用 `mdio-tool`、`mii-tool` 或厂商提供的调试工具。需要注意，不同系统工具可用性不同，不能把某一个命令当作所有平台都一定存在的标准命令。

如果要反编译当前 dtb，可以使用类似命令：

```bash
dtc -I dtb -O dts -o running.dts /boot/xxx.dtb
```

但实际平台上 dtb 路径可能不同，有些系统甚至不会把 dtb 放在 `/boot` 下。因此这类命令更多是一个思路：确认系统实际加载的设备树，而不是只看源码里的 dts。

---

## 常见问题按现象排查

以太网问题可以按现象分层定位。下面这张表比把每个问题都拆成很多小节更适合个人学习时快速回顾。

| 现象                     | 常见原因                                                                       | 排查重点                                                             |
| ------------------------ | ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| MDIO 读不到 PHY          | PHY 未供电、reset 没释放、MDC/MDIO 引脚复用错误、PHY 地址不对、MDIO 节点没启用 | 测电源、看 reset、示波器看 MDC/MDIO、检查 `reg` 和 strap address     |
| PHY 能识别但 link 不起来 | 网线/交换机问题、自协商失败、PHY clock 异常、MDI 侧连接问题、PHY strap 错误    | 换网线和端口、看 `ethtool`、查 reset/clock、查 PHY 状态寄存器        |
| link up 但 ping 不通     | IP/路由问题、phy-mode 错误、RGMII delay 错误、数据线问题、MAC 地址异常         | 查 `ip addr`/`ip route`、抓 ARP、看 `ethtool -S`、核对设备树和原理图 |
| 100M 能通，1000M 不通    | RGMII 时序不满足、delay 配错、PCB 走线质量问题、千兆时钟不稳定                 | 检查 `rgmii-id/rxid/txid`、查 MAC/PHY delay、强制降速对比            |
| 丢包严重或 CRC error     | RGMII 时序问题、时钟抖动、PHY 电源噪声、网线质量差、接口电压不匹配             | 看 CRC 计数、降速测试、换网线、查 delay、测电源纹波和时钟            |
| eth0 不存在              | MAC 节点没启用、驱动未编译、compatible 不匹配、时钟/reset/pinctrl 缺失         | 查 dmesg、查设备树 `status`、查 kernel config、查驱动 probe          |

这里有一个很实用的判断思路：

```text
PHY ID 读不到：
    优先查 MDIO 管理通路、PHY 电源、reset、地址。

PHY ID 能读到，但 link 不起来：
    优先查 PHY 侧、网线、交换机、自协商、晶振和 MDI 连接。

link up，但不能收发包：
    优先查 MAC-PHY 数据接口、phy-mode、RGMII delay、MAC DMA、中断、IP 配置。

能收发，但错误很多：
    优先查时序、电源、信号质量、RGMII delay、PCB 和线缆质量。
```

---

## 从原理图判断接口类型

实际 bring up 时，原理图比猜测更可靠。可以通过 MAC 和 PHY 之间的信号名大致判断接口类型。

如果看到这些信号，大概率是标准 MII：

```text
TXD0 TXD1 TXD2 TXD3
RXD0 RXD1 RXD2 RXD3
TX_CLK
RX_CLK
TX_EN
RX_DV
CRS
COL
MDIO
MDC
```

如果看到这些信号，大概率是 RMII：

```text
TXD0 TXD1
RXD0 RXD1
TX_EN
CRS_DV
REF_CLK
MDIO
MDC
```

如果看到这些信号，大概率是 RGMII：

```text
TXD0 TXD1 TXD2 TXD3
RXD0 RXD1 RXD2 RXD3
TXC
RXC
TX_CTL
RX_CTL
MDIO
MDC
```

判断接口类型之后，再去检查设备树中的 `phy-mode`。例如硬件实际是 RMII，设备树却写成 RGMII，那么驱动可能仍然能 probe，PHY 也可能能读到，但数据链路一定会异常。

---

## 总结

MAC、PHY 和 MII 接口的关系可以概括为：

```text
MAC 负责以太网帧处理；
PHY 负责物理层信号转换；
MII/RMII/RGMII 负责 MAC 和 PHY 之间的数据传输；
MDIO/MDC 负责 MAC 对 PHY 的寄存器管理。
```

实际做 Linux BSP 或驱动 bring up 时，最关键的不是记住所有命令，而是建立分层排查思路：

```text
先确认硬件接口类型；
再确认设备树描述是否匹配；
再确认 PHY 电源、reset、clock；
再确认 MDIO 能否读到 PHY；
再确认 link 状态；
最后再看收发包、错误统计和 RGMII delay。
```

对于 MII/RMII/RGMII，可以简单记为：

```text
MII：
    标准 10/100M 接口，4bit 数据线，引脚较多。

RMII：
    Reduced MII，精简 10/100M 接口，2bit 数据线，使用 50MHz REF_CLK，引脚少，常见于 MCU。

RGMII：
    Reduced GMII，常用于千兆，以 4bit 数据线配合 DDR 双沿采样工作，性能高但时序要求更严格。

MDIO/MDC：
    PHY 管理接口，用来读写 PHY 寄存器，不传输真正的以太网帧。
```

如果把这些概念和实际调试流程串起来，就能比较完整地理解 Ethernet MAC-PHY 接口在硬件 bring up、设备树配置和 Linux 驱动调试中的作用。
