---
title: '现代 SoC 如何采集一帧图像：从 MIPI CSI-2 到 V4L2 Buffer'
description: '面向初学者梳理摄像头采集链路：Sensor 如何产生 RAW 图像，MIPI CSI-2 和 D-PHY 如何传输数据，SoC 如何通过 ISP、DMA 和 VB2 将图像交给用户程序。'
category: '协议'
series: { id: 'linux-camera', order: 1 }
tags: ['MIPI CSI-2', 'V4L2', 'Camera']
pubDate: 'Jul 21 2026'
heroImage: '../../../assets/blog-placeholder-5.jpg'
---

## 为什么要写这篇文章

学习 Linux Camera 驱动时，我们很容易遇到大量看起来彼此独立的名词：

- Sensor
- MIPI
- CSI-2
- D-PHY
- RAW10
- ISP
- V4L2
- Media Controller
- DMA
- IOMMU
- VB2
- `QBUF`
- `DQBUF`

单独解释这些名词并不算特别困难，真正困难的是把它们连接起来。

例如，驱动通过 I2C 向 Sensor 写入了 stream-on 寄存器之后，图像究竟从哪里出来？图像是不是通过 I2C 传输？MIPI、CSI-2 和 D-PHY 是不是同一个东西？CSI 接收到数据之后，为什么应用程序还要执行 `VIDIOC_QBUF` 和 `VIDIOC_DQBUF`？

这篇文章希望回答一个完整的问题：

> 从光线进入镜头开始，到用户程序从 `/dev/videoX` 取出一帧图像为止，这一帧图像经过了哪些硬件模块，Linux 又在其中做了什么？

本文主要讨论 Linux SoC 平台上常见的摄像头链路：

```text
Image Sensor
    -> MIPI CSI-2
    -> SoC Camera Receiver
    -> Capture / ISP
    -> DMA
    -> DDR Buffer
    -> V4L2 Application
```

在正式分析数据流之前，需要先把几个最容易混淆的概念解释清楚。

## 先理解几个最重要的概念

### 什么是 SoC

SoC 是 System on Chip 的缩写，中文通常称为“片上系统”。

普通计算机可能把 CPU、GPU、内存控制器、视频编解码器和各种接口控制器放在不同芯片中，而 SoC 会把这些模块集成到一颗芯片里。

一颗支持摄像头的 SoC 通常包含：

```text
CPU
GPU
DDR Controller
I2C Controller
MIPI D-PHY Receiver
CSI-2 Receiver
Camera Capture
ISP
DMA
IOMMU
Video Encoder
Display Controller
```

摄像头采集并不是只由 CPU 完成的。

CPU 主要负责配置硬件和管理状态，大量连续的图像数据则由 Sensor、CSI Receiver、ISP 和 DMA 等专用硬件模块处理。

### 什么是 Image Sensor

Image Sensor 是把光转换为数字图像的芯片。

常见的 Sensor 包括：

```text
Sony IMX415
Sony IMX219
OmniVision OV5640
OmniVision OV9281
Onsemi AR0231
```

Sensor 内部通常包含：

```text
像素阵列
模拟放大电路
模数转换器 ADC
曝光和增益控制电路
帧时序发生器
数字图像输出模块
CSI-2 Packetizer
D-PHY Transmitter
I2C 控制接口
```

这里要特别注意：

> I2C 主要用于配置 Sensor，而不是传输图像。

CPU 可以通过 I2C 设置曝光时间、模拟增益、输出分辨率和帧率，但真正的图像数据通常通过 MIPI CSI-2 高速接口发送。

### 什么是 MIPI

MIPI 最初是 Mobile Industry Processor Interface 的缩写。

它不是某一根具体的数据线，也不是一个单独的摄像头协议，而是一系列面向移动设备和嵌入式设备的接口规范。

MIPI Alliance 定义了很多不同用途的规范，例如：

| 规范 | 主要用途 |
|---|---|
| MIPI CSI-2 | 摄像头图像传输 |
| MIPI DSI | 显示屏数据传输 |
| MIPI D-PHY | 高速串行物理层 |
| MIPI C-PHY | 另一种高速物理层 |
| MIPI I3C | 低速控制总线 |
| MIPI A-PHY | 车载长距离高速传输 |

因此，“MIPI”这个词本身比较宽泛。

在摄像头驱动中，人们口头上说“启动 MIPI”，通常实际指的是：

```text
让 Sensor 按照 CSI-2 协议组织图像数据，
再通过 D-PHY 物理接口发送给 SoC。
```

更准确地说，常见摄像头接口应该写成：

```text
MIPI CSI-2 over D-PHY
```

其中：

- CSI-2 负责规定图像数据如何组织；
- D-PHY 负责规定数据如何变成引脚上的电信号。

### 什么是 CSI-2

CSI 是 Camera Serial Interface 的缩写。

CSI-2 是 MIPI Alliance 制定的一套摄像头串行传输协议，它规定了图像数据应该怎样封装和传输。

CSI-2 关心的是：

- 一帧从哪里开始；
- 一帧在哪里结束；
- 当前数据属于哪一路逻辑图像；
- 图像是 RAW10、RAW12 还是 YUV422；
- 一个数据包有多长；
- 数据传输过程中是否出现错误。

可以把 CSI-2 类比为快递打包规则。

真正的图像像素相当于包裹中的物品，CSI-2 会在外面增加标签：

```text
这是什么类型的数据？
属于哪一路图像？
数据有多长？
数据是否完整？
```

CSI-2 并不直接规定 PCB 引脚上的电压变化。把 CSI-2 数据真正发送到电路板走线上的任务，通常由 D-PHY 或 C-PHY 完成。

### 什么是 D-PHY

D-PHY 是 MIPI 定义的一种物理层规范。

所谓物理层，可以简单理解为：

> 数据最终应该以什么样的电信号，从哪些引脚发送出去。

D-PHY 负责：

- 将数字数据串行化；
- 产生高速差分信号；
- 在低功耗模式和高速模式之间切换；
- 规定 Clock Lane 和 Data Lane；
- 规定发送和接收时序；
- 在接收端完成采样、串并转换和 Lane 对齐。

因此，CSI-2 和 D-PHY 的关系可以概括为：

```text
CSI-2：规定数据包的格式和含义
D-PHY：负责把这些数据包变成高速电信号
```

也可以使用寄信的方式类比：

```text
图像像素        -> 信件内容
CSI-2           -> 信封格式和地址规则
D-PHY           -> 运输信件的公路和车辆
PCB 差分走线    -> 实际道路
```

这个类比只是为了帮助理解。真实系统中，CSI-2 是协议层，D-PHY 是物理层。

### 什么是 Lane

Lane 可以理解为一条高速数据通道。

一个常见的 D-PHY 摄像头接口可能包含：

```text
1 条 Clock Lane
2 条或 4 条 Data Lane
```

例如四 Lane 接口可能有以下差分引脚：

```text
CLK+
CLK-

D0+
D0-

D1+
D1-

D2+
D2-

D3+
D3-
```

每个 `+/-` 组成一对差分信号。

四条 Data Lane 并不表示四个摄像头，也不是每条 Lane 传输画面的四分之一。

更准确地说：

> CSI-2 产生的一条字节流，会按照协议规则分散到多条 Lane 上并行发送。

接收端必须先将多条 Lane 对齐并重新合并，才能恢复原始的数据包。

### 什么是差分信号

差分传输使用两根线共同表示一个信号，例如：

```text
D0+
D0-
```

接收端主要关心两根线之间的电压差，而不是某一根线相对于地的绝对电压。

差分传输具有较强的抗干扰能力，适合传输高速信号。

但高速差分信号对 PCB 设计也有要求，例如：

- 差分阻抗；
- P/N 极性；
- 两根线之间的长度匹配；
- 不同 Lane 之间的时延；
- 走线过孔；
- 信号完整性；
- Sensor 和 SoC 的 Lane 映射。

即使 I2C 可以正常读取 Sensor 芯片 ID，也不能证明 MIPI 高速链路一定正确。

I2C 正常只能说明低速控制通道基本可用。

## 先建立完整的数据流地图

一帧不经过 ISP 的 RAW 图像，可以简化为以下路径：

```text
外界光线
  -> 镜头
  -> Sensor 像素阵列
  -> 模拟前端
  -> ADC
  -> RAW Bayer 像素
  -> CSI-2 Packetizer
  -> Sensor D-PHY TX
  -> PCB 差分走线
  -> SoC D-PHY RX
  -> CSI-2 Receiver
  -> Camera Capture
  -> DMA
  -> DDR 中的 V4L2 Buffer
  -> 用户空间程序
```

如果图像还需要经过 ISP，路径可能变成：

```text
外界光线
  -> Sensor
  -> RAW Bayer
  -> MIPI CSI-2
  -> SoC CSI-2 Receiver
  -> ISP
  -> YUV / RGB
  -> DMA
  -> DDR Buffer
  -> 用户空间程序
```

这里的每个箭头都代表数据进入了下一个处理阶段。

不过，整个 Camera 系统中不只有图像数据这一条路径。

## 摄像头系统中同时存在三条路径

理解 Camera 驱动时，最好把整个系统分成三条相互配合但功能不同的路径。

### 控制流

控制流用于配置硬件。

例如：

```text
CPU
  -> I2C Controller
  -> Sensor 寄存器
```

CPU 可以通过 I2C 设置：

- 曝光时间；
- 模拟增益；
- 数字增益；
- 输出分辨率；
- 帧率；
- RAW 位宽；
- Lane 数量；
- Test Pattern；
- Stream On；
- Stream Off。

CPU 还会通过 MMIO 寄存器配置 SoC 内部的：

```text
D-PHY
CSI-2 Receiver
Capture
ISP
DMA
IOMMU
```

控制流的数据量非常小，通常只是一些寄存器读写。

### 像素数据流

像素数据流是真正的大流量图像数据。

典型路径为：

```text
Sensor
  -> MIPI CSI-2
  -> Capture / ISP
  -> DMA
  -> DDR
```

这一过程主要由硬件流水线完成。

CPU 不会逐像素从 Sensor 读取数据，也不会为每个 CSI-2 字节执行一次中断。

### Buffer 所有权流

第三条路径不是像素数据本身，而是 Buffer 的使用权变化。

```text
应用程序持有 Buffer
  -> QBUF
  -> Buffer 交给驱动
  -> DMA 向 Buffer 写入
  -> 一帧完成
  -> DQBUF
  -> Buffer 重新交给应用程序
```

`QBUF` 并不是请求 Sensor 立即拍一张照片，而是告诉驱动：

> 这块内存现在可以交给硬件写入。

`DQBUF` 也不一定发生整帧内存复制，它通常只是把已经由 DMA 写好的 Buffer 重新交给应用程序。

这三条路径可以总结为：

| 路径 | 作用 | 数据量 | 主要参与者 |
|---|---|---:|---|
| 控制流 | 配置 Sensor、CSI、ISP 和 DMA | 很小 | CPU 和驱动 |
| 像素数据流 | 连续传输图像 | 很大 | Sensor 和硬件流水线 |
| Buffer 所有权流 | 管理哪块内存由谁使用 | 很小 | 应用、V4L2、VB2、驱动 |

许多初学者的困惑，都是因为把这三条路径混在了一起。

## Sensor 是怎样产生 RAW 图像的

### 镜头负责把光投射到像素阵列

镜头本身不会产生数字图像。

它的主要作用是把外界场景中的光线汇聚到 Sensor 的像素阵列上。

Sensor 的每个感光像素会在曝光时间内积累电荷。

通常来说：

```text
光线越强
或曝光时间越长
  -> 像素积累的电荷越多
  -> 最终转换出的数字值越大
```

这只是基础理解。真实 Sensor 中还存在满阱容量、暗电流、读出噪声和非线性等问题。

### 为什么彩色 Sensor 的单个像素不能直接得到 RGB

常见彩色 Sensor 会在像素上方覆盖一层 Color Filter Array，也就是彩色滤光阵列。

最常见的是 Bayer 阵列。

例如一种 GBRG 排列：

```text
G B G B G B ...
R G R G R G ...
G B G B G B ...
R G R G R G ...
```

每个像素只测量一种颜色。

因此，Sensor 直接输出的数据不是完整的 RGB 图像，而是一个由不同颜色采样点组成的二维数组。

例如某个位置只能得到绿色强度，而不能同时得到这个位置的红色和蓝色强度。

后续 ISP 会通过周围像素估计缺失的颜色分量，这个过程叫作去马赛克，也称为 Demosaic。

### ADC 如何得到 RAW10 或 RAW12

像素首先产生模拟电信号。

这些模拟信号经过：

```text
像素读出
  -> 模拟放大
  -> 黑电平处理
  -> ADC
  -> 数字像素值
```

ADC 是 Analog-to-Digital Converter 的缩写，即模数转换器。

如果 Sensor 输出 RAW10，表示每个像素的有效数据宽度为 10 bit，其理论取值范围是：

```text
0 ~ 1023
```

如果输出 RAW12，理论取值范围是：

```text
0 ~ 4095
```

这里的 RAW 表示图像仍然接近 Sensor 原始采样数据。

它通常还没有完成：

- 去马赛克；
- 自动白平衡；
- 颜色校正；
- Gamma；
- 最终降噪；
- RGB 或 YUV 转换。

### 曝光、增益和帧时序由谁控制

Linux 驱动通常通过 I2C 修改 Sensor 寄存器。

常见参数包括：

```text
Exposure
Analogue Gain
Digital Gain
HMAX / HTS
VMAX / VTS
Readout Mode
Link Frequency
Test Pattern
```

这些参数会影响：

- 每一行何时开始读出；
- 一帧有多少行；
- 一帧需要多长时间；
- Sensor 每秒输出多少帧；
- 图像亮度；
- MIPI 输出速率。

CPU 只是设置这些参数。

真正按照帧时序完成曝光、逐行读出和数据发送的是 Sensor 内部硬件。

## Sensor 内部如何把 RAW 像素变成 CSI-2 数据包

ADC 输出的 RAW 像素仍然位于 Sensor 内部。

此时可以把它理解为一组并行数字像素。

Sensor 内部的 CSI-2 Packetizer 会把这些像素组织成 CSI-2 数据包。

Packetizer 可以理解为“打包器”。

它需要告诉接收端：

```text
一帧从这里开始
这一行是 RAW10 数据
这一包有多少字节
这一帧在这里结束
```

### CSI-2 中的短包和长包

CSI-2 数据包主要可以分为短包和长包。

短包不携带大量像素数据，主要用于表示事件。

例如：

```text
Frame Start
Frame End
Line Start
Line End
```

长包用于携带真正的数据，例如：

```text
RAW10 图像行
RAW12 图像行
YUV422 图像行
Embedded Metadata
```

一帧 RAW 图像可以抽象成：

```text
Frame Start

RAW10 Line 0
RAW10 Line 1
RAW10 Line 2
...
RAW10 Line N

Frame End
```

根据 Sensor 和接收器配置，Line Start 和 Line End 可能存在，也可能被省略。

### CSI-2 长包中包含什么

一个 CSI-2 长包可以简化表示为：

```text
Packet Header
  -> Virtual Channel
  -> Data Type
  -> Word Count
  -> Header ECC

Payload
  -> 真正的图像数据

Payload CRC
```

各字段的作用如下。

| 字段 | 作用 |
|---|---|
| Virtual Channel | 区分同一条 CSI-2 Link 上的不同逻辑数据流 |
| Data Type | 表示数据是 RAW10、RAW12、YUV422 还是其他类型 |
| Word Count | 表示 Payload 有多少字节 |
| Header ECC | 检测或修正包头错误 |
| Payload CRC | 检测 Payload 是否在传输中出错 |

### 什么是 Virtual Channel

Virtual Channel 通常缩写为 VC。

它用于在同一条 CSI-2 物理链路上区分不同的逻辑数据流。

例如，一个设备可能同时发送：

```text
VC0 -> 主图像
VC1 -> 第二路图像
VC2 -> 特殊曝光图像
VC3 -> 其他逻辑流
```

不过，Virtual Channel 并不等于 Data Lane。

它们属于不同层次：

```text
Data Lane       -> 物理传输通道
Virtual Channel -> 协议中的逻辑通道
```

四条 Lane 不代表四个 Virtual Channel，也不代表四路摄像头。

### 什么是 Data Type

Data Type 通常缩写为 DT。

它用于说明当前 CSI-2 Payload 应该怎样解释。

例如：

```text
RAW8
RAW10
RAW12
RAW14
YUV422
RGB888
Embedded Data
```

当 CSI-2 Receiver 收到一个数据包时，会根据 Data Type 判断这一包是什么内容。

如果 Sensor 发送 RAW10，但 CSI Receiver 被错误配置成 RAW12，就可能出现格式错误、数据错位或者无法完成路由。

## RAW10 在 CSI-2 中是怎样打包的

RAW10 表示每个像素有 10 个有效 bit。

如果直接为每个像素使用 16 bit，传输效率会比较低。

因此，CSI-2 通常会对 RAW10 进行紧凑打包。

四个 RAW10 像素一共有：

```text
4 × 10 bit = 40 bit
```

40 bit 正好可以放入：

```text
5 byte
```

因此，CSI-2 线上的 RAW10 通常可以理解为：

```text
4 个像素
  -> 打包成 5 个字节
```

但是，数据进入 SoC 和 DDR 后，不一定仍然保持这种布局。

Capture 硬件可能：

- 保留 Packed RAW10；
- 将每个 10-bit 像素展开到 16 bit；
- 在每行末尾增加对齐字节；
- 使用厂商特有的 RAW 格式。

所以不能简单认为：

```text
bytesperline = width × 10 / 8
```

应用程序应该使用 V4L2 驱动返回的：

```text
bytesperline
sizeimage
plane 数量
```

这些值才是驱动和应用之间真正的内存布局约定。

## D-PHY 怎样把 CSI-2 数据发送到 PCB 上

CSI-2 Packetizer 产生的是有结构的数字数据包。

D-PHY TX 接下来会将这些数据：

```text
按 Lane 分配
  -> 串行化
  -> 转换为高速差分信号
  -> 从 Sensor 引脚发送
```

### Clock Lane 和 Data Lane

传统 D-PHY Camera 链路通常包含独立的 Clock Lane。

例如：

```text
Clock Lane
Data Lane 0
Data Lane 1
Data Lane 2
Data Lane 3
```

Clock Lane 向接收端提供源同步时钟。

Data Lane 负责发送数据。

Sensor 和 SoC 两端需要对以下配置保持一致：

- Data Lane 数量；
- Lane 顺序；
- Lane 极性；
- Lane Rate；
- Continuous Clock 或 Non-Continuous Clock；
- HS 时序参数；
- LP 和 HS 状态切换。

### 什么是 LP 和 HS

D-PHY 支持不同的工作状态。

LP 是 Low Power 的缩写，表示低功耗状态。

HS 是 High Speed 的缩写，表示高速传输状态。

简单理解：

```text
没有大量数据需要发送
  -> 可以处于 LP / Stop State

需要发送 CSI-2 数据包
  -> 切换到 HS
  -> 发送高速差分数据
  -> 结束后返回 LP / Stop State
```

一次高速发送过程可以粗略表示为：

```text
LP Idle
  -> HS Request
  -> SoT
  -> High-Speed Data
  -> EoT
  -> LP / Stop State
```

其中：

- SoT 表示 Start of Transmission；
- EoT 表示 End of Transmission。

这些过程由 Sensor D-PHY 和 SoC D-PHY 硬件完成。

CPU 不会逐 bit 控制 Lane 电平。

### 什么是 Lane Rate

Lane Rate 表示每条 Data Lane 每秒传输的 bit 数量。

例如：

```text
891 Mbit/s per lane
```

表示每条 Lane 的传输速率约为每秒 891 Mbit。

如果有四条 Lane，理论总传输能力约为：

```text
4 × 891 Mbit/s
```

但真实可用带宽还会受到以下因素影响：

- CSI-2 包头；
- CRC；
- 帧时序；
- 行间隔；
- PHY 状态切换；
- 硬件保留余量。

因此，Lane Rate 通常不能刚好等于有效像素数据的平均速率。

### Link Frequency 和 Lane Rate 的关系

在常见 D-PHY DDR 传输中，数据会在时钟的上升沿和下降沿都传输。

因此经常可以看到：

```text
lane rate = 2 × link frequency
```

例如：

```text
link frequency = 445.5 MHz
lane rate      = 891 Mbit/s per lane
```

不过，在具体驱动中仍应根据 Sensor 数据手册、设备树绑定和驱动实现确认这两个值的含义，不能只根据变量名称猜测。

## SoC 的 D-PHY RX 做了什么

Sensor 通过 PCB 差分线发送高速信号后，首先到达 SoC 的 D-PHY RX。

物理连接可能类似：

```text
Sensor CLK+/-  ------------> SoC CSI CLK+/-
Sensor D0+/-   ------------> SoC CSI D0+/-
Sensor D1+/-   ------------> SoC CSI D1+/-
Sensor D2+/-   ------------> SoC CSI D2+/-
Sensor D3+/-   ------------> SoC CSI D3+/-
```

D-PHY RX 主要完成：

- 差分信号接收；
- HS 状态检测；
- 利用 Clock Lane 采样数据；
- 串并转换；
- 字节对齐；
- Lane 对齐；
- 将恢复出的字节交给 CSI-2 Receiver。

它只关心如何可靠恢复高速数据。

D-PHY 并不知道：

- 图像分辨率是多少；
- 图像是不是 RAW10；
- 当前是第几行；
- 图像是否需要经过 ISP；
- 最终 Buffer 在 DDR 的哪个地址。

这些属于更高层模块的职责。

## CSI-2 Receiver 做了什么

D-PHY RX 恢复出的是各条 Lane 上的字节。

CSI-2 Receiver 会进一步理解这些字节的协议含义。

它通常需要完成：

```text
合并多条 Lane
  -> 找到 Packet Header
  -> 解析 VC 和 DT
  -> 读取 Word Count
  -> 检查 ECC
  -> 检查 CRC
  -> 识别 Frame Start / Frame End
  -> 去除 CSI-2 协议字段
  -> 输出内部 Pixel Stream
```

CSI-2 Receiver 输出的通常已经不再是 PCB 上的差分信号，而是 SoC 芯片内部的数字数据流。

这个内部接口在不同芯片中可能被称为：

```text
Pixel Interface
IPI
AXI-Stream
Internal Camera Bus
Video Stream
```

逻辑上，它至少需要表达：

```text
pixel data
pixel valid
line boundary
frame boundary
virtual channel
data type
error status
```

此时数据仍然不一定已经进入 DDR。

CSI-2 Receiver 可能只是将数据交给下一级 Capture 或 ISP。

## Capture、ISP 和 DMA 分别是什么

### 什么是 Capture Engine

Capture Engine 是摄像头采集模块。

不同 SoC 厂商对它的命名不同，例如：

```text
VICAP
CIF
VI
ISI
Camera Capture
Camera DMA
```

它通常负责：

- 接收 CSI-2 Receiver 输出的 Pixel Stream；
- 选择 Virtual Channel；
- 选择 Data Type；
- 配置输入宽高；
- 配置 Crop；
- 处理行 FIFO；
- 转换内存 Packing；
- 计算或使用 Stride；
- 配置 DMA 地址；
- 在一帧完成时产生中断。

Capture Engine 往往是最终把数据写入 DDR 的硬件之一。

### 什么是 ISP

ISP 是 Image Signal Processor 的缩写，即图像信号处理器。

Sensor 直接输出的 Bayer RAW 通常不适合直接显示。

ISP 可以完成：

```text
黑电平校正
坏点校正
镜头阴影校正
去马赛克
白平衡
颜色校正
降噪
锐化
Gamma
色彩空间转换
```

例如：

```text
Bayer RAW
  -> ISP
  -> NV12 / YUYV / RGB
```

因此，CSI 和 ISP 不是同一个模块。

```text
CSI-2 Receiver
  -> 负责接收和解析传输协议

ISP
  -> 负责处理图像内容
```

可以不经过 ISP，直接采集 RAW。

但只要 Sensor 输出的是 CSI-2 信号，就不能跳过 D-PHY 和 CSI-2 Receiver，直接让软件理解差分信号。

### 什么是 3A

3A 通常表示：

```text
AE：Auto Exposure，自动曝光
AWB：Auto White Balance，自动白平衡
AF：Auto Focus，自动对焦
```

ISP 可以从当前帧中统计亮度、颜色和清晰度信息。

软件算法根据这些统计数据计算下一步参数，再通过驱动更新 Sensor 或 ISP。

整个过程可能是：

```text
第 N 帧图像
  -> ISP 生成统计信息
  -> 3A 算法分析
  -> 计算新的曝光、增益或白平衡参数
  -> 通过 V4L2 Control 设置 Sensor / ISP
  -> 在第 N+k 帧生效
```

为什么不是立即在当前帧生效？

因为：

- 当前帧可能已经开始曝光；
- I2C 配置需要时间；
- Sensor 寄存器可能只在特定帧边界更新；
- Sensor 内部可能存在若干帧流水线延迟。

因此，Camera Pipeline 不只有从前向后的图像流，还存在从后向前的控制反馈。

### 什么是 DMA

DMA 是 Direct Memory Access 的缩写，即直接内存访问。

DMA 允许硬件设备直接访问系统内存，而不需要 CPU 逐字节搬运。

在 Camera 系统中：

```text
Capture / ISP
  -> DMA
  -> DDR Buffer
```

Capture 或 ISP 内部的 DMA Engine 可以作为 SoC 总线上的 Bus Master，主动向 DDR 发起写操作。

数据路径可能是：

```text
Camera Line FIFO
  -> DMA Write Burst
  -> AXI / NoC
  -> IOMMU
  -> DDR Controller
  -> DRAM
```

CPU 的任务主要是提前告诉 DMA：

```text
Buffer 地址在哪里
一行跨过多少字节
图像有多少行
数据是什么格式
什么时候开始
```

配置完成后，DMA 会自行搬运图像。

## 设备树如何描述摄像头物理连接

在 Camera Pipeline 启动之前，Linux 必须知道板子上的硬件是怎样连接的。

例如：

```text
IMX415
  -> SoC MIPI CSI-2 Receiver
  -> Camera Capture
```

这些板级连接通常由设备树描述。

一个简化示例：

```dts
imx415: camera-sensor@1a {
	compatible = "sony,imx415";
	reg = <0x1a>;

	port {
		imx415_out: endpoint {
			remote-endpoint = <&csi2_in>;
			data-lanes = <1 2 3 4>;
			link-frequencies = /bits/ 64 <445500000>;
		};
	};
};

csi2_receiver {
	status = "okay";

	ports {
		port@0 {
			csi2_in: endpoint {
				remote-endpoint = <&imx415_out>;
				data-lanes = <1 2 3 4>;
			};
		};

		port@1 {
			csi2_out: endpoint {
				remote-endpoint = <&capture_in>;
			};
		};
	};
};
```

这段设备树不会直接产生图像，也不会自动完成数据传输。

它主要描述以下事实：

```text
Sensor 的输出连接到了哪个 CSI 输入
PCB 实际使用了几条 Data Lane
Lane 的编号和顺序是什么
支持的 Link Frequency 是多少
CSI Receiver 的输出连接到了哪个模块
```

### `remote-endpoint` 表示什么

`remote-endpoint` 用于把两个 Endpoint 连接起来。

例如：

```dts
remote-endpoint = <&csi2_in>;
```

表示当前 Sensor 输出 Endpoint 的远端是 `csi2_in`。

另一端通常也会反向引用：

```dts
remote-endpoint = <&imx415_out>;
```

这样就形成一条双向描述的逻辑连接。

它对应的物理含义可能是：

```text
Sensor MIPI 输出引脚
  -> PCB 差分走线
  -> SoC MIPI 输入引脚
```

### `data-lanes` 表示什么

例如：

```dts
data-lanes = <1 2 3 4>;
```

表示板子使用四条 Data Lane，并给出了 Lane 映射。

Sensor 驱动和 SoC CSI 驱动可以根据 Endpoint 信息获取 Lane 数量。

如果设备树写了四 Lane，但实际 PCB 只连接了两 Lane，或者 Lane 顺序错误，I2C 仍然可能正常，但 MIPI 图像无法正确接收。

### 设备树如何变成驱动对象

系统启动时，大致会经历：

```text
Bootloader 加载 DTB
  -> Linux 解析设备树
  -> I2C Core 创建 Sensor i2c_client
  -> Platform Bus 创建 PHY / CSI / Capture Device
  -> 各驱动执行 probe
  -> 注册 V4L2 Subdev、Media Entity 和 Pad
  -> Async Notifier 等待远端设备
  -> 根据 Endpoint 建立 Media Link
```

设备树描述的是静态硬件关系。

驱动 probe 后，这些关系会被转换成 Linux Camera Framework 中可操作的软件对象。

## Media Controller 是什么

现代 Linux Camera Pipeline 往往不只有一个简单设备节点，而是由多个相互连接的硬件模块组成。

例如：

```text
Sensor
  -> CSI-2 Receiver
  -> ISP
  -> Scaler
  -> Capture
```

Media Controller Framework 会把这些模块表示为一张图。

其中常见概念包括：

- Entity；
- Pad；
- Link；
- Route；
- Media Bus Format。

### 什么是 Entity

Entity 可以理解为 Media Graph 中的一个模块。

例如：

```text
IMX415 Sensor
CSI2RX
ISP
Scaler
Capture
```

每个硬件模块可以注册成一个 Media Entity。

### 什么是 Pad

Pad 表示模块的数据入口或出口。

常见类型包括：

```text
Sink Pad   -> 数据输入端
Source Pad -> 数据输出端
```

例如：

```text
IMX415 [Source Pad]
            |
            v
CSI2RX [Sink Pad] -> [Source Pad]
            |
            v
Capture [Sink Pad]
```

### 什么是 Media Link

Media Link 表示两个 Pad 之间的连接。

它可以对应真实硬件连接，也可以表示 SoC 内部固定或可配置的数据路由。

设备树中的 Endpoint 关系最终可能被转换成 Media Link。

### 一个简化的 Media Graph

```text
IMX415 [source pad 0]
       |
       | MEDIA_BUS_FMT_SGBRG10_1X10
       v
CSI2RX [sink pad 0] -> [source pad 1]
       |
       v
Capture [sink pad] -> /dev/videoX
```

这里可以看到两类对象：

```text
/dev/v4l-subdevX
  -> 通常对应 Sensor、CSI、ISP 等 Subdev

/dev/videoX
  -> 通常对应能够申请 Buffer 并采集数据的 Video Node
```

Sensor Subdev 本身通常不是最终给应用执行 `QBUF` 和 `DQBUF` 的节点。

### `media-ctl -p` 能证明有图像吗

不能。

`media-ctl -p` 主要展示驱动建立的软件拓扑。

它能证明：

```text
驱动已经注册
Entity 和 Pad 已经创建
Media Link 已经建立
```

但它不能直接证明：

```text
Sensor 已经开始发送
D-PHY 已经进入 HS
CSI-2 没有 CRC 错误
DMA 已经写入 DDR
```

Media Graph 正确，只表示 Linux 理解了模块应该怎样连接。

真正的数据流要等 Pipeline 配置完成并执行 Stream On 之后才会出现。

## 同一个 RAW10 为什么会有多个名字

图像格式在不同层中有不同的表示方式。

以 GBRG RAW10 为例：

| 所在层 | 典型表示 | 描述的内容 |
|---|---|---|
| Sensor 像素层 | GBRG Bayer、10-bit ADC | 每个像素采样哪种颜色以及有效位宽 |
| V4L2 Subdev Pad | `MEDIA_BUS_FMT_SGBRG10_1X10` | 模块之间传输的 Media Bus Format |
| CSI-2 数据包 | `MIPI_CSI2_DT_RAW10` | CSI-2 Payload 使用 RAW10 类型 |
| Video Node | `V4L2_PIX_FMT_SGBRG10` | DDR Buffer 中的像素格式 |
| VB2 Plane | `bytesperline`、`sizeimage` | Buffer 的实际内存布局 |

这些格式不能简单互相替代。

### Media Bus Format

Media Bus Format 描述的是 Camera Pipeline 中各个 Subdev Pad 之间传输的数据格式。

例如：

```c
MEDIA_BUS_FMT_SGBRG10_1X10
```

它主要用于描述：

- Bayer 顺序；
- 每个采样的有效位宽；
- 总线上的逻辑数据组织。

### V4L2 Pixel Format

V4L2 Pixel Format 通常通过 FourCC 表示，用于描述 Video Node 输出到内存中的格式。

例如：

```c
V4L2_PIX_FMT_SGBRG10
V4L2_PIX_FMT_NV12
V4L2_PIX_FMT_YUYV
```

它描述的是：

> 用户程序最终在 DDR Buffer 中会看到怎样的数据。

### 为什么两者可能不同

CSI-2 Receiver 或 Capture Engine 可能进行：

- RAW Unpack；
- RAW Repack；
- 字节对齐；
- 位宽扩展；
- 多平面组织；
- Stride 对齐。

因此，Pipeline 中传输的是 RAW10，并不意味着 DDR 中一定是严格的每四个像素五个字节。

最终应以 Video Node 返回的格式信息为准。

## V4L2 应用在 Stream On 之前做了什么

一个典型的 V4L2 MMAP 采集程序会执行：

```text
open("/dev/videoX")
  -> VIDIOC_QUERYCAP
  -> VIDIOC_ENUM_FMT
  -> VIDIOC_TRY_FMT
  -> VIDIOC_S_FMT
  -> VIDIOC_REQBUFS
  -> VIDIOC_QUERYBUF
  -> mmap()
  -> VIDIOC_QBUF
  -> VIDIOC_STREAMON
```

这些操作主要针对 `/dev/videoX`。

### `VIDIOC_S_FMT` 做了什么

应用可以请求：

```text
width       = 3864
height      = 2192
pixelformat = V4L2_PIX_FMT_SGBRG10
```

驱动会根据硬件能力进行检查和调整，然后返回最终配置，例如：

```text
实际宽度
实际高度
Pixel Format
bytesperline
sizeimage
Plane 数量
```

`bytesperline` 表示相邻两行起始地址之间的距离，也常被称为 Stride。

它不一定等于有效像素数据占用的字节数，因为每行末尾可能存在 Padding。

`sizeimage` 表示一个图像 Plane 至少需要多少内存。

### `VIDIOC_REQBUFS` 做了什么

`VIDIOC_REQBUFS` 用于向驱动请求若干个 Buffer。

例如请求四个 Buffer：

```text
Buffer 0
Buffer 1
Buffer 2
Buffer 3
```

这些 Buffer 通常由 VB2 和对应的内存后端管理。

### `mmap()` 做了什么

`mmap()` 将驱动管理的 Buffer 映射到用户进程地址空间。

这样应用程序可以在 Buffer 完成后直接读取其中的数据。

需要注意：

> `mmap()` 只建立用户空间映射，并不等于 Buffer 已经交给 DMA。

真正将 Buffer 交给驱动的是 `VIDIOC_QBUF`。

### `VIDIOC_QBUF` 做了什么

`QBUF` 可以理解为 Queue Buffer。

应用执行 `QBUF` 后，表示：

```text
这块 Buffer 暂时不再由应用使用，
驱动可以把它交给硬件写入。
```

Buffer 会进入 VB2 和驱动的等待队列。

如果应用只执行 `mmap()`，却没有执行 `QBUF`，DMA 仍然没有可用的目标 Buffer。

## 什么是 VB2

VB2 是 Videobuf2 的缩写。

它是 Linux V4L2 中常用的流式 Buffer 管理框架。

VB2 不负责产生图像。

它主要解决：

- Buffer 如何分配；
- Buffer 如何排队；
- Buffer 当前属于应用还是驱动；
- Buffer 何时正在被 DMA 使用；
- 一帧完成后如何唤醒应用；
- Stream Off 时如何回收未完成 Buffer。

一个 Buffer 的生命周期可以简化为：

```text
Buffer 已分配
  -> 应用 mmap
  -> 应用 QBUF
  -> VB2 Queued
  -> 驱动等待队列
  -> DMA Active
  -> Frame Done
  -> VB2 DONE
  -> 应用 DQBUF
  -> 应用处理
  -> 再次 QBUF
```

### 为什么要使用多个 Buffer

如果只有一个 Buffer：

```text
DMA 写入完成
  -> 应用处理
  -> 应用重新 QBUF
  -> DMA 才能继续写下一帧
```

在应用处理期间，硬件可能没有可写 Buffer。

使用多个 Buffer 后，可以形成流水线：

```text
DMA 正在写 Buffer A
应用正在处理 Buffer B
Buffer C 正在驱动队列等待
Buffer D 已经准备好
```

这样更容易维持连续采集。

### MMAP、DMABUF 和 USERPTR

VB2 可以支持不同的内存模型。

| 内存模型 | 内存主要由谁提供 | 常见用途 |
|---|---|---|
| `V4L2_MEMORY_MMAP` | 驱动或 VB2 分配 | 简单采集程序 |
| `V4L2_MEMORY_DMABUF` | 其他设备或分配器导出 | Camera 与 GPU、显示、编码器共享 |
| `V4L2_MEMORY_USERPTR` | 应用提供用户指针 | 受平台和驱动限制 |

是否支持某一种方式，取决于具体驱动实现。

## CPU 地址、物理地址和 DMA 地址为什么不同

应用程序通过 `mmap()` 得到的是用户虚拟地址。

DMA 寄存器中使用的通常是设备可见的 DMA 地址。

它们不是同一个概念。

```text
应用看到的用户虚拟地址
          |
          | CPU 页表转换
          v
      系统物理内存
          ^
          | IOMMU 映射
          |
   Camera DMA 看到的 IOVA
```

### 什么是虚拟地址

应用程序中的普通指针通常是虚拟地址。

例如：

```c
void *buffer = mmap(...);
```

`buffer` 是用户进程可访问的虚拟地址。

CPU 通过页表把它转换到实际物理页。

### 什么是 DMA 地址

DMA 地址是设备访问内存时使用的地址。

没有 IOMMU 时，它可能接近总线物理地址。

启用 IOMMU 后，DMA 常使用 IOVA。

### 什么是 IOMMU

IOMMU 是 Input-Output Memory Management Unit 的缩写。

它可以为设备提供类似 CPU MMU 的地址转换和访问保护。

例如：

```text
DMA 使用连续 IOVA
  -> IOMMU
  -> 映射到若干不连续的物理页
```

IOMMU 还可以限制 Camera DMA 只能访问已授权的内存。

如果 DMA 使用了错误的 IOVA，IOMMU 可能产生 Page Fault。

此时 Sensor 和 CSI-2 可能都工作正常，但 Buffer 始终无法完成。

## `VIDIOC_STREAMON` 到底启动了什么

应用在准备并排队足够的 Buffer 后调用：

```c
VIDIOC_STREAMON
```

它并不是只调用 Sensor 的 `.s_stream(1)`。

一条完整 Pipeline 通常需要依次准备：

```text
VB2
Capture DMA
ISP
CSI-2 Receiver
D-PHY
Sensor
```

通用启动过程可以理解为：

```text
VIDIOC_STREAMON
  -> V4L2 IOCTL Layer
  -> VB2 Stream On
  -> Capture Driver .start_streaming()
  -> 配置 DMA 和 Buffer 地址
  -> 配置 Capture / ISP
  -> 配置 CSI-2 Receiver
  -> 配置并启动 D-PHY
  -> 最后启动 Sensor
```

核心原则是：

> 先准备接收端，最后启动数据源。

### 为什么不能先启动 Sensor

假设先让 Sensor 发送数据，但此时：

```text
D-PHY 还没有准备好
CSI Receiver 还没有配置 VC / DT
Capture 还没有开启
DMA 还没有 Buffer 地址
```

那么最开始的数据包没有地方可去。

可能导致：

- Packet 丢失；
- Frame Start 丢失；
- FIFO Overflow；
- Size Mismatch；
- 第一帧错误；
- Stream 启动失败。

因此，正确思路通常是从数据流后端向前准备：

```text
DDR Buffer
  <- DMA Ready
  <- Capture Ready
  <- CSI Ready
  <- D-PHY Ready
  <- 最后 Sensor Start
```

## Capture 如何准备 DMA

Capture Driver 会从已排队的 VB2 Buffer 中取得 DMA 地址。

部分硬件支持 Ping-Pong Buffer，例如：

```text
FRAME0_ADDR -> Buffer A
FRAME1_ADDR -> Buffer B
```

硬件写 Buffer A 时，Buffer B 已经提前准备好。

一帧结束后，硬件可以快速切换到下一个 Buffer。

驱动还需要配置：

- 输入宽度和高度；
- Crop；
- Pixel Format；
- RAW Packing；
- Stride；
- Plane Address；
- Virtual Channel；
- Stream ID；
- DMA Burst；
- FIFO Threshold；
- Frame End Interrupt；
- Overflow Interrupt；
- Bus Error Interrupt。

到这一步，即使 Sensor 还没有发送数据，Capture 也已经知道：

> 第一行数据到来后，应该写到 DDR 的哪个位置。

## CSI Receiver 和 D-PHY 如何准备

CSI Receiver 通常需要知道：

```text
使用几条 Lane
Lane 怎样映射
Lane Rate 是多少
输入是什么 Media Bus Format
接收哪个 Virtual Channel
接收哪个 Data Type
输出路由到哪里
```

D-PHY Driver 根据 Lane Rate 等参数配置：

- HS 时序；
- Settle 时间；
- PHY Mode；
- Lane Enable；
- Clock Mode；
- Power On。

这里的 D-PHY Power On 并不表示图像已经开始传输。

它只是让 SoC 的模拟接收电路做好准备，等待 Sensor 进入 HS 并发送数据。

## 最后怎样启动 Sensor

当下游全部准备完成后，Pipeline 才会启动 Sensor。

以常见 Sensor 为例，大致会执行：

```text
Runtime PM 上电
  -> 打开 Regulator
  -> 打开输入时钟
  -> 释放 Reset
  -> 写入全局初始化寄存器
  -> 写入当前 Mode 寄存器
  -> 设置 Lane Mode
  -> 设置 MIPI Timing
  -> 写入 Exposure / Gain / Blanking
  -> 退出 Standby
  -> 写入 Stream On
```

这些动作仍然是 CPU 通过 I2C 完成的控制流。

只有最后的 Stream On 生效后，Sensor 才开始：

```text
曝光
  -> 逐行读出
  -> 生成 RAW
  -> CSI-2 打包
  -> D-PHY 发送
```

从这一刻起，大流量图像数据不再经过 I2C。

## 一帧图像在 MIPI CSI-2 上如何传输

### Rolling Shutter 是什么

很多 CMOS Sensor 使用 Rolling Shutter。

它不是让整张图像所有行在完全相同的时刻曝光，而是逐行开始和结束曝光。

可以粗略理解为：

```text
第 0 行先开始曝光
第 1 行稍后开始曝光
第 2 行再稍后开始曝光
...
```

读出时也通常逐行进行。

因此，高速运动物体可能出现倾斜或变形。

### HBLANK 和 VBLANK 是什么

HBLANK 表示一行有效像素以外的水平空白时间。

VBLANK 表示一帧有效行以外的垂直空白时间。

它们共同影响：

- 行周期；
- 帧周期；
- 帧率；
- 最长曝光时间；
- Sensor 读出节奏。

需要注意：

> Blanking 是时间概念，不一定表示 CSI Lane 上会发送大量“空白像素”。

在没有有效 Payload 时，Data Lane 可能进入 LP 或 Stop State，具体行为与 Sensor 和 Clock Mode 有关。

### 一帧数据包的顺序

一帧 RAW10 可以抽象成：

```text
Frame Start Short Packet

RAW10 Line 0 Long Packet
RAW10 Line 1 Long Packet
RAW10 Line 2 Long Packet
...
RAW10 Line N Long Packet

Frame End Short Packet
```

每一行 Long Packet 中包含：

```text
Header
Payload
CRC
```

Payload 就是这一行打包后的 RAW10 字节。

## 数据进入 SoC 后发生了什么

数据经过以下过程：

```text
PCB 差分波形
  -> D-PHY RX
  -> Lane 字节
  -> CSI-2 Receiver
  -> CSI-2 Packet
  -> Pixel Stream
```

### D-PHY RX 恢复电气信号

如果 D-PHY 无法：

- 进入 Stop State；
- 检测 HS；
- 检测 SoT；
- 稳定恢复时钟；
- 完成 Lane Alignment；

那么问题还在物理层附近。

此时优先检查：

```text
Sensor 是否真的 Stream On
Sensor 和 SoC 的 Lane 数是否一致
Lane Mapping 是否正确
P/N 极性是否正确
Lane Rate 是否一致
HS Settle 是否合理
PCB 信号完整性是否正常
```

还不应该立即把排查重点放在 VB2 或 `DQBUF` 上。

### CSI-2 Receiver 恢复 Packet

D-PHY 正常后，CSI-2 Receiver 会解析：

```text
Packet Header
Virtual Channel
Data Type
Word Count
Frame Start
Frame End
ECC
CRC
```

如果出现大量 ECC 或 CRC 错误，通常说明：

> 数据已经到达 CSI-2 Receiver，但传输内容不够可靠。

可能原因包括：

- Lane Rate 错误；
- PHY Timing 不合理；
- 信号完整性问题；
- Lane Mapping 错误；
- Sensor 和 Receiver 配置不一致。

### Capture 直出 RAW

一种常见路径是：

```text
CSI Pixel Stream
  -> Capture
  -> DMA
  -> DDR RAW Buffer
```

这种方式保留 Sensor 输出的 Bayer RAW，适合：

- Sensor Bring-up；
- 检查 MIPI 链路；
- RAW 标定；
- 离线 ISP；
- 算法开发。

### 经过 ISP 输出 YUV

另一种路径是：

```text
CSI Pixel Stream
  -> ISP
  -> YUV / RGB
  -> DMA
  -> DDR Buffer
```

这种方式更适合：

- 屏幕预览；
- 视频编码；
- 图像显示；
- 计算机视觉应用。

不同 SoC 的硬件拓扑不同。

有些平台支持：

```text
CSI -> ISP -> DDR
```

有些平台可能是：

```text
CSI -> DDR RAW
DDR RAW -> ISP
ISP -> DDR YUV
```

后者需要额外的 DDR 读写带宽。

判断具体平台的数据路径时，应该结合：

- 芯片数据手册；
- Media Graph；
- 设备树；
- 驱动代码；
- DMA 寄存器位置。

## DMA 如何把一帧写入 DDR

假设驱动配置：

```text
Buffer IOVA    = 0x10000000
bytesperline   = 4864
height         = 2192
```

DMA 会按照 Stride 逐行写入：

```text
Line 0 -> 0x10000000
Line 1 -> 0x10000000 + 4864
Line 2 -> 0x10000000 + 2 × 4864
...
```

每一行的有效像素可能只占其中一部分。

剩余区域可能是 Padding。

DMA 并不知道应用之后怎样解释这些数据。

它只根据驱动设置的：

```text
起始地址
Stride
高度
Plane Offset
Pixel Packing
```

完成写入。

如果应用错误地忽略 `bytesperline`，常见现象包括：

- 图像斜行；
- 每行错位；
- 图像撕裂；
- 半帧花屏；
- 图像周期性偏移。

## 为什么 Capture 中需要 FIFO

CSI-2 数据会按照 Sensor 时序连续进入 SoC。

DDR 写入则需要经过：

```text
AXI / NoC
IOMMU
DDR Controller
DRAM
```

这些资源可能还被 CPU、GPU、显示、编码器和其他 DMA 设备共享。

Capture 内部的 FIFO 可以吸收短时间的带宽波动。

数据路径可以理解为：

```text
CSI 持续输入
  -> Line FIFO 暂存
  -> DMA 分批写入 DDR
```

如果 DDR 或 AXI 长时间无法提供足够带宽，FIFO 会被填满。

这就是 FIFO Overflow。

可能导致：

- 当前行丢失；
- 当前帧标记 Error；
- 后续帧不同步；
- Capture 停止；
- `DQBUF` 超时。

因此：

> CSI 没有 CRC 错误，只能说明协议传输大致正常，不能证明图像已经安全写入 DDR。

## IOMMU Fault 为什么会导致 `DQBUF` 超时

假设 DMA 使用了：

- 未映射的 IOVA；
- 错误的 Plane Address；
- 越界地址；
- 已经释放的映射；
- 错误的 IOMMU Domain。

IOMMU 会阻止访问并报告 Fault。

此时可能出现：

```text
Sensor 正常输出
D-PHY 正常接收
CSI 能检测到 Frame Start 和 Frame End
但 DMA 无法完成 Buffer
```

应用最终看到的现象可能只是：

```text
poll() 一直超时
VIDIOC_DQBUF 一直等待
```

因此，`DQBUF` 超时并不一定是 Sensor 没有出图。

它也可能是 Capture、DMA 或内存路径出现问题。

## 一帧完成后 Buffer 如何回到应用

当 DMA 写完一帧后，Capture 硬件通常会产生 Frame End Interrupt。

中断处理程序需要完成：

```text
读取中断状态
  -> 判断哪个 DMA Slot 完成
  -> 检查 Overflow / Bus Error
  -> 更新 Buffer 的 Timestamp
  -> 更新 Sequence
  -> 更新 Bytesused
  -> 调用 vb2_buffer_done()
  -> 准备下一个 Buffer
```

典型调用可能类似：

```c
vb2_buffer_done(vb, VB2_BUF_STATE_DONE);
```

如果当前帧发生错误，也可能使用：

```c
vb2_buffer_done(vb, VB2_BUF_STATE_ERROR);
```

`vb2_buffer_done()` 会把 Buffer 放入完成队列，并唤醒等待中的应用程序。

应用随后执行：

```c
VIDIOC_DQBUF
```

得到的信息通常包括：

```text
Buffer Index
Sequence
Timestamp
Bytesused
Flags
Error State
```

对 MMAP Streaming 来说，`DQBUF` 通常不会再次复制整帧图像。

DMA 已经直接将数据写入 mmap 对应的 Buffer。

`DQBUF` 主要完成的是：

> 将这块 Buffer 的所有权从驱动交还给应用。

应用处理完成后，应再次执行 `QBUF`，使 Buffer 回到采集队列。

完整循环为：

```text
QBUF
  -> VB2 Queued
  -> Driver Queue
  -> DMA Active
  -> Frame Done Interrupt
  -> vb2_buffer_done()
  -> DQBUF
  -> Application Processing
  -> QBUF
```

## 应用处理太慢会发生什么

如果应用长期持有已经 `DQBUF` 的 Buffer，却没有及时重新 `QBUF`，驱动中的可用 Buffer 会越来越少。

最终可能出现：

```text
硬件没有新的 Buffer 可以写
```

根据具体硬件和驱动实现，可能导致：

- 丢帧；
- 覆盖旧帧；
- Capture 停止；
- FIFO Overflow；
- Pipeline Error。

所以 V4L2 采集程序应该尽快处理 Buffer。

耗时较长的算法通常需要：

- 增加 Buffer 数量；
- 使用独立处理线程；
- 将 Buffer 交给 GPU；
- 使用 DMABUF；
- 设计合理的丢帧策略。

## DMABUF 和零拷贝是什么

应用不一定需要让 CPU读取每个像素。

在预览、编码或 GPU 处理场景中，可以通过 DMABUF 在多个设备之间共享 Buffer。

例如：

```text
Camera DMA 写入 Buffer
  -> 导出或共享 DMABUF
  -> GPU 导入
  -> Display 导入
  -> Video Encoder 导入
```

所谓零拷贝，通常表示：

> 不需要额外执行一次 CPU `memcpy()`，把整帧从一个 Buffer 复制到另一个 Buffer。

零拷贝不表示什么操作都没有。

系统仍然可能需要：

- 建立 IOMMU 映射；
- 建立 DMA Attachment；
- 进行 Cache Synchronization；
- 等待 Fence；
- 管理设备间所有权；
- 处理格式和 Stride。

Camera 写完之前，GPU 或编码器不能提前读取同一个 Buffer。

因此仍然需要同步机制。

## Stream Off 时发生了什么

停止采集时，原则通常与启动时相反：

> 先停止数据源，再逐步关闭接收和存储路径。

可以简化为：

```text
VIDIOC_STREAMOFF
  -> 停止 Sensor 输出
  -> 等待或丢弃 Pipeline 中剩余数据
  -> 停止 CSI-2 Receiver
  -> 关闭 D-PHY
  -> 停止 Capture DMA
  -> 将未完成 Buffer 返回 VB2
  -> Runtime PM Autosuspend
```

实际驱动中的回调顺序可能因平台而异。

部分硬件可能需要先屏蔽 DMA Request，再等待 FIFO Drain。

但总体目标一致：

```text
不能在 Sensor 仍不断发送数据时，
毫无准备地关闭整个接收链路。
```

Stream Off 后，当前 VB2 Streaming 会话结束。

再次启动时，应用通常需要根据 V4L2 规则重新准备和排队 Buffer。

## 用一组数字理解图像带宽

假设 Sensor 输出：

```text
分辨率：3864 × 2192
格式：RAW10
帧率：30 fps
Lane 数量：4
```

每帧像素数量为：

```text
3864 × 2192
= 8,469,888 pixels
```

RAW10 每个像素有 10 bit，因此一帧有效像素数据量为：

```text
8,469,888 × 10 bit
= 84,698,880 bit
```

换算为字节：

```text
84,698,880 / 8
= 10,587,360 byte
```

约为：

```text
10.1 MiB per frame
```

30 fps 时，有效像素平均带宽为：

```text
84,698,880 × 30
= 2.541 Gbit/s
```

换算为字节速率约为：

```text
317.6 MB/s
```

四条 Lane 平均分担后，仅计算有效像素：

```text
2.541 Gbit/s / 4
= 635.2 Mbit/s per lane
```

真实 Lane Rate 需要比这个值更高，因为还要考虑：

- CSI-2 Header；
- CRC；
- Frame Start 和 Frame End；
- 行传输窗口；
- PHY 状态切换；
- 硬件时序余量。

### DDR 中的带宽可能更高

如果 Capture 将 RAW10 展开到 16 bit，则每个像素在 DDR 中占两个字节。

内存写入带宽变为：

```text
8,469,888 × 2 byte × 30 fps
= 508.2 MB/s
```

如果数据还需要：

```text
先写 RAW 到 DDR
  -> ISP 从 DDR 读 RAW
  -> ISP 再写 NV12 到 DDR
```

总 DDR 带宽会远高于 Sensor 的 CSI-2 有效 Payload。

多摄像头同时工作时，还需要把各路 Camera 的带宽叠加，并考虑瞬时 Burst 和其他硬件模块的竞争。

## CPU 到底参与了什么

CPU 主要参与：

- 通过 I2C 配置 Sensor；
- 通过 MMIO 配置 D-PHY；
- 配置 CSI-2 Receiver；
- 配置 ISP；
- 配置 Capture 和 DMA；
- 建立 DMA/IOMMU 映射；
- 管理 VB2 Buffer；
- 响应帧完成和错误中断；
- 处理 V4L2 IOCTL；
- 将完成的 Buffer 交给应用。

CPU 通常不会：

- 通过 I2C 逐像素读取图像；
- 为每个 CSI-2 字节执行一次中断；
- 用普通循环逐行复制 Sensor 数据；
- 参与 D-PHY 高速串并转换；
- 亲自完成每一次 AXI 写事务。

真正的大流量路径是：

```text
Sensor Hardware
  -> D-PHY Hardware
  -> CSI-2 Hardware
  -> Capture / ISP Hardware
  -> DMA
  -> DDR
```

CPU 更像一名调度者。

在采集开始前，它写好各个硬件模块的配置；一帧完成后，它再处理状态和 Buffer，而不是亲自搬运每一个像素。

## 把整个采集过程放到一条时间线上

```text
用户空间                   Linux 驱动                    硬件

open("/dev/videoX")

VIDIOC_S_FMT
    |---------------------> 设置内存输出格式

VIDIOC_REQBUFS
    |---------------------> VB2 分配或准备 Buffer

VIDIOC_QUERYBUF
mmap()
    |---------------------> 建立用户空间映射

VIDIOC_QBUF × N
    |---------------------> Buffer 进入驱动队列

VIDIOC_STREAMON
    |---------------------> VB2 Stream On
                              |
                              v
                         Capture .start_streaming()
                              |
                              | 配置 DMA 地址、Stride、格式
                              v
                         Capture / DMA Ready
                              |
                              | 配置 CSI Receiver 和 D-PHY
                              v
                         CSI / PHY Ready
                              |
                              | 通过 I2C 启动 Sensor
                              v
                         Sensor Stream On
                              |
                              v
                        Sensor 开始曝光
                              |
                              v
                        Sensor 逐行读出
                              |
                              v
                        CSI-2 Packetizer
                              |
                              v
                        Sensor D-PHY TX
                              |
                              v
                        PCB 差分走线
                              |
                              v
                        SoC D-PHY RX
                              |
                              v
                        CSI-2 Receiver
                              |
                              v
                        Capture / ISP
                              |
                              v
                        DMA 写入 DDR
                              |
                              v
                        Frame End Interrupt
                              |
                              v
                        vb2_buffer_done()
                              |
                              v
VIDIOC_DQBUF <------------- Buffer 进入完成队列

应用处理图像

VIDIOC_QBUF
    |---------------------> Buffer 再次回到驱动
```

这条时间线中有一个重要转折点。

在 Sensor Stream On 之前，主要是软件在：

```text
创建对象
准备 Buffer
建立地址映射
配置寄存器
```

Sensor 开始输出后，图像则主要由硬件连续传输。

直到一帧完成产生中断，软件才再次参与进来。

## 不同 SoC 上常见的模块名称

不同厂商对 Camera 模块的命名差异很大。

| 平台 | PHY / CSI 附近模块 | Capture / ISP 附近模块 |
|---|---|---|
| Rockchip | MIPI D-PHY、CSI2RX | RKCIF、VICAP、RKISP |
| Qualcomm | CSIPHY、CSID | VFE、IFE、CAMSS |
| NVIDIA Tegra | NVCSI | VI、ISP |
| NXP i.MX | MIPI CSI-2 RX | CSI、ISI、ISP |
| TI | CSI2RX | VPFE、CAL、ISP |
| Allwinner | MIPI CSI、CSI | VIN、ISP |

这些名字不能完全一一对应。

阅读驱动时，不要只根据名称猜测模块职责，而应该观察：

```text
这个模块的输入是什么？
是 D-PHY 字节、Pixel Stream，还是 DDR Buffer？

这个模块的输出是什么？

它有没有配置 DMA 地址？

它是不是 AXI Bus Master？

它在 Media Graph 中有哪些 Sink Pad 和 Source Pad？

它是否注册了 /dev/videoX？
```

这几类问题通常比记住模块名称更有用。

## 按照数据方向排查 Camera 问题

Camera Pipeline 很长。

最有效的调试方法不是随机修改寄存器，而是沿数据方向逐段证明。

### 芯片 ID 无法读取

现象：

```text
I2C 读取 Sensor Chip ID 失败
```

首先检查：

- Sensor 供电；
- Reset GPIO；
- Power Down GPIO；
- 输入时钟；
- I2C 地址；
- I2C Pinmux；
- I2C 总线；
- Sensor 上电时序。

此时控制通道还没有建立，没有必要先检查 CSI-2 或 VB2。

### I2C 正常，但 D-PHY 看不到 HS

现象：

```text
Chip ID 可以读取
Sensor 驱动 Probe 成功
但 SoC PHY 没有检测到高速数据
```

重点检查：

- Sensor 是否真的执行了 Stream On；
- Sensor 是否仍处于 Standby；
- MIPI 输出模式是否正确；
- Lane 数量是否一致；
- Link Frequency 是否正确；
- Sensor TX Timing 是否正确；
- PCB Lane 是否连接正确；
- Reset 是否被重新拉低；
- 输入时钟是否稳定。

I2C 正常不代表 MIPI 输出一定已经启动。

### 有 HS，但 PHY 无法稳定锁定

重点检查：

- Lane Mapping；
- P/N 极性；
- Lane Rate；
- HS Settle；
- Clock Settle；
- Continuous Clock 配置；
- Sensor 与 SoC 时序是否一致；
- 差分阻抗；
- 信号完整性；
- 连接器和排线。

此时说明高速电信号可能已经到达 SoC 引脚，但接收端无法可靠恢复。

### CSI 出现大量 ECC 或 CRC 错误

说明 CSI Receiver 已经收到了部分数据包，但内容不可靠。

重点检查：

- Lane Rate；
- PHY Timing；
- Lane Skew；
- Lane Mapping；
- 信号完整性；
- Sensor 输出格式；
- Clock Mode；
- SoC D-PHY 配置。

### CSI 能看到 Frame Start 和 Frame End，但没有 Frame Done

这通常说明：

```text
Sensor、D-PHY 和 CSI-2 协议层大致已经工作，
问题可能位于 Capture 或 DMA。
```

重点检查：

- CSI 到 Capture 的 Route；
- Virtual Channel；
- Data Type；
- Crop；
- 输入宽高；
- Capture Enable；
- DMA Enable；
- FIFO Overflow；
- Size Mismatch；
- Frame End Interrupt；
- Capture Clock 和 Reset。

### 出现 IOMMU Fault

说明 DMA 已经尝试访问内存，但地址映射存在问题。

重点检查：

- DMA Address；
- IOVA；
- Plane Address；
- Buffer Size；
- `sizeimage`；
- Stride；
- IOMMU Domain；
- Mapping 生命周期；
- 是否发生越界写入。

### `DQBUF` 能返回，但图像斜行

说明图像已经进入 DDR，但应用和驱动对内存布局的理解不一致。

重点检查：

- Pixel Format；
- Packed RAW 或 Unpacked RAW；
- `bytesperline`；
- `sizeimage`；
- 行对齐；
- Plane Offset；
- 应用是否错误地使用 `width × bytes_per_pixel` 计算下一行。

### 图像结构正常，但颜色错误

重点检查：

- Bayer Order；
- HFlip；
- VFlip；
- Sensor Crop；
- ISP 输入格式；
- RAW 位宽；
- Black Level；
- 白平衡；
- R、G、B 通道映射。

Sensor 执行水平或垂直翻转后，Bayer 排列可能发生变化。

例如，原本的 GBRG 可能变成其他 Bayer 顺序。

### 运行一段时间后开始丢帧

重点检查：

- DDR 带宽；
- AXI QoS；
- FIFO Overflow；
- 应用是否及时 QBUF；
- Buffer 数量；
- 中断延迟；
- CPU 负载；
- 内存带宽竞争；
- ISP 和编码器是否同时大量访问 DDR。

## 使用 Test Pattern 缩小问题范围

很多 Sensor 内部支持 Test Pattern。

例如：

- Color Bar；
- 渐变图；
- 固定灰度；
- 黑白条纹。

Test Pattern 由 Sensor 数字逻辑直接产生，不依赖镜头和真实光线。

如果 Test Pattern 可以稳定通过：

```text
Sensor Digital Output
  -> CSI-2
  -> D-PHY
  -> SoC Receiver
  -> Capture
  -> DMA
  -> DDR
```

说明从 Sensor 数字输出开始的后半段链路基本正常。

真实画面仍然异常时，可以进一步检查：

- 镜头；
- 曝光；
- 模拟增益；
- Sensor 模拟前端；
- Bayer 顺序；
- ISP 配置。

## 容易混淆的问题

### MIPI 和 CSI-2 是一回事吗

不是。

MIPI 是一系列接口规范的统称。

CSI-2 是其中用于摄像头数据传输的一套协议。

更准确的说法是：

```text
使用 MIPI CSI-2 协议传输摄像头数据
```

### CSI-2 和 D-PHY 是一回事吗

不是。

```text
CSI-2
  -> 规定数据包如何组织

D-PHY
  -> 规定数据如何通过引脚上的电信号传输
```

CSI-2 也可以运行在 C-PHY 上，并不只能使用 D-PHY。

### MIPI 四条 Lane 是四路图像吗

不是。

四条 Data Lane 是同一条高速物理链路的并行通道。

CSI-2 的字节流会被分散到多条 Lane 上发送，再由接收端合并。

区分不同逻辑图像流的是 Virtual Channel，而不是 Lane。

### I2C 会传输图像吗

通常不会。

I2C 主要用于：

```text
读写 Sensor 寄存器
设置曝光和增益
切换工作模式
启动或停止 Stream
```

大流量图像通过 CSI-2 和 D-PHY 传输。

### CSI 和 ISP 是一回事吗

不是。

```text
CSI-2 Receiver
  -> 解析通信协议

ISP
  -> 处理 RAW 图像内容
```

### Sensor Subdev 就是 `/dev/videoX` 吗

通常不是。

Sensor 多数注册为 V4L2 Subdev，对应：

```text
/dev/v4l-subdevX
```

它主要提供：

- Pad Format；
- Controls；
- Selection；
- Stream Operation。

能够申请 VB2 Buffer 并执行 `QBUF`、`DQBUF` 的终点通常是：

```text
/dev/videoX
```

### `STREAMON` 是否只调用 Sensor 的 `.s_stream()`

不是。

它通常需要先准备：

```text
VB2
DMA
Capture
ISP
CSI Receiver
D-PHY
```

最后才启动 Sensor。

新驱动也可能使用 `.enable_streams()`，而不是旧式 `.s_stream()`。

### `DQBUF` 时会复制整帧数据吗

对常见 MMAP 和 DMABUF Streaming 来说，通常不会。

DMA 已经直接把数据写入 Buffer。

`DQBUF` 主要返回：

- Buffer Index；
- Timestamp；
- Sequence；
- Bytesused；
- 状态信息。

并将 Buffer 所有权交还给应用。

### `media-ctl -p` 正常是否代表图像链路正常

不代表。

它只能说明软件拓扑已经建立。

还需要继续确认：

```text
Sensor 是否输出
D-PHY 是否进入 HS
CSI 是否有 Frame Start
Capture 是否有 Frame Done
DMA 是否写入 DDR
VB2 是否完成 Buffer
```

## 总结

现代 SoC 采集一帧图像，可以概括为三个阶段。

首先，Sensor 将光转换为 RAW 像素：

```text
光线
  -> 像素电荷
  -> ADC
  -> Bayer RAW
```

然后，Sensor 使用 CSI-2 和 D-PHY发送图像：

```text
RAW Pixel
  -> CSI-2 Packet
  -> D-PHY 差分信号
  -> PCB
  -> SoC D-PHY RX
  -> CSI-2 Receiver
```

最后，SoC 将图像写入内存并交给应用：

```text
Pixel Stream
  -> Capture / ISP
  -> DMA
  -> DDR VB2 Buffer
  -> Frame Done Interrupt
  -> DQBUF
  -> Application
```

从软件角度看：

```text
设备树
  -> 描述硬件连接

Media Controller
  -> 表示模块拓扑

V4L2 Subdev
  -> 配置 Sensor、CSI 和 ISP

Video Node
  -> 向应用提供采集接口

VB2
  -> 管理 Buffer 状态和所有权

DMA
  -> 搬运大流量图像数据

IOMMU
  -> 管理设备地址转换和访问权限
```

理解 Camera Pipeline 时，不必一开始就记住所有函数和寄存器。

先始终追问以下几个问题：

```text
数据从哪里产生？
当前处于物理层、协议层还是图像处理层？
这个模块的输入和输出分别是什么？
数据什么时候进入 DDR？
由哪个硬件执行 DMA？
Buffer 当前属于应用、驱动还是硬件？
一帧完成后由谁通知应用？
```

只要能够沿着数据流逐段回答这些问题，MIPI、CSI-2、ISP、V4L2、VB2、DMA 和 IOMMU 就不会再是互不相关的名词，而会变成一条完整且可以调试的 Camera Pipeline。
