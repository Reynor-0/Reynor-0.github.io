---
title: 'Camera 驱动开发（六）：从 IMX415 RAW10 到 RKISP MainPath NV12'
description: '在 rk3568 平台上为 IMX415 Sensor 编写驱动程序'
series: { id: 'camera-driver', order: 6 }
tags: ['Camera', 'Linux', 'V4L2', '图像处理']
pubDate: 'Jun 26 2026'
---

## 1. 本篇开发目标

上一篇已经完成开流控制链：RKISP 在准备好接收端后，最终调用
`imx415_s_stream(..., 1)`，让 Sensor 退出 standby。本篇从第一批有效像素离开
IMX415 开始，站在驱动开发者视角实现并验证下面的数据通路：

```text
IMX415 曝光、ADC
  -> Bayer RAW10
  -> MIPI CSI-2 packet
  -> CSI2 D-PHY 接收
  -> CSI2RX 解包和分流
  -> RKISP21 Bayer 处理
  -> MainPath crop / resize / YUV420
  -> MI DMA
  -> DDR 中的 NV12 Buffer
```

本篇需要解决四个开发问题：

1. 每一级硬件接收什么、输出什么，以及明确不负责什么；
2. 如何让 Sensor、D-PHY、CSI2RX、ISP 和 MainPath 使用一致的数据格式；
3. RKISP 如何把 3864x2192 RAW10 变成 1920x1080 NV12；
4. 哪一个中断才表示一帧已经完整写入 DDR。

本文只讨论内核驱动与硬件数据面。VB2 的完整 Buffer 状态机、MMAP 和 DMA-BUF
所有权循环放在下一篇。

### 1.1 当前板端基线

| 项目 | 当前值 |
| --- | --- |
| Sensor active format | 3864x2192 `SGBRG10_1X10` |
| Sensor crop bounds | `(12,16)/3840x2160` |
| 帧率 | 30 FPS |
| MIPI data lane | 4 |
| Link frequency | 446 MHz |
| Lane bit rate | 892 Mbit/s/Lane |
| CSI-2 Virtual Channel | VC0，线性模式 |
| CSI-2 Data Type | RAW10，DT=`0x2b` |
| ISP 输入 | 3864x2192 Bayer RAW10 |
| ISP crop | 3840x2160 |
| ISP source format | 3840x2160 `YUYV8_2X8` |
| MainPath 输出 | 1920x1080 NV12 |
| MainPath video node | `/dev/video0` |

这里的 `SGBRG10_1X10` 不只是“每个像素 10 bit”，它还记录 Bayer 排列为 GB/RG。
CSI-2 包头中的 RAW10 Data Type 只表示位深和打包类型，不携带 GB/RG 排列；下游 ISP
必须从 Media Bus format 获得 Bayer 顺序。

### 1.2 重点源码

```text
Sensor：
  kernel/drivers/media/i2c/imx415.c

D-PHY：
  kernel/drivers/phy/rockchip/phy-rockchip-csi2-dphy.c
  kernel/drivers/phy/rockchip/phy-rockchip-csi2-dphy-hw.c

CSI2RX、ISP：
  kernel/drivers/media/platform/rockchip/isp/csi.c
  kernel/drivers/media/platform/rockchip/isp/rkisp.c
  kernel/drivers/media/platform/rockchip/isp/isp.c
  kernel/drivers/media/platform/rockchip/isp/params_v21.c
  kernel/drivers/media/platform/rockchip/isp/regs.h

MainPath、MI：
  kernel/drivers/media/platform/rockchip/isp/capture.c
  kernel/drivers/media/platform/rockchip/isp/capture_v21.c
  kernel/drivers/media/platform/rockchip/isp/hw.c
```

## 2. 开发前先拆开控制面和数据面

Camera 驱动同时存在两条完全不同的通路：

```text
控制面：CPU -> I2C/MMIO 寄存器 -> Sensor、D-PHY、CSI2RX、ISP、MI
数据面：Sensor -> MIPI lanes -> CSI2RX -> ISP -> AXI -> DDR
```

I2C 只用于配置 IMX415 的 mode、曝光、增益和开关流。3864x2192 RAW10 图像不会经过
I2C，也不会先进入 CPU。像素从 MIPI 进入 RKISP 后，大部分时间在片上硬件流水线中前进，
最终由 MI 作为 AXI bus master 直接写入 DDR。

因此，开发这条链路时不能只检查函数返回值。每一级都要建立一个可验证的边界：

| 边界 | 要确认的内容 |
| --- | --- |
| Sensor -> D-PHY | lane 数、bit rate、连续时钟、实际是否进入 HS 状态 |
| D-PHY -> CSI2RX | 时钟恢复稳定，没有 SoT/同步错误 |
| CSI2RX -> ISP | VC、DT、帧边界、行长度、RAW10 格式一致 |
| ISP -> MainPath | Bayer 顺序、crop、YUV source size 正确 |
| MainPath -> MI | resize、NV12、stride、Y/UV 地址正确 |
| MI -> DDR | frame-end 到达，Buffer 完整写入后才标记完成 |

## 3. 第一项增量：只让 IMX415 产生确定的 RAW10

### 3.1 从一个固定 mode 开始

驱动第一次打通数据面时，不应同时支持多分辨率、HDR 和多 VC。先固定以下条件：

```text
3864x2192
SGBRG10
30 FPS
4 data lanes
VC0
linear mode
```

Sensor driver 中的 mode 至少要提供尺寸、时序、Media Bus code、link frequency 和寄存器表：

```c
/**
 * @brief 描述一种经过验证的 IMX415 输出模式。
 */
struct imx415_mode {
    u32 width;                    /* Sensor 实际输出宽度，单位：pixel。 */
    u32 height;                   /* Sensor 实际输出高度，单位：line。 */
    u32 hts_def;                  /* 默认行周期，单位由 Sensor 时序定义。 */
    u32 vts_def;                  /* 默认帧长，单位：line。 */
    u32 code;                     /* Bayer 顺序和位深对应的 Media Bus code。 */
    u32 link_freq_index;          /* link frequency 菜单中的索引。 */
    const struct regval *reg_list;/* 写入 Sensor 的 mode 寄存器表。 */
};
```

必须把以下三个概念分开：

- `MEDIA_BUS_FMT_SGBRG10_1X10`：Linux 驱动之间协商的逻辑像素格式；
- CSI-2 `DT=0x2b`：线上长包使用的 RAW10 数据类型；
- IMX415 RAW10 packing：协议规定的 4 个 10-bit pixel 打包为 5 byte。

这三者应当一致，但用途不同。Media Bus code 还包含 Bayer 顺序，CSI-2 Data Type 不包含。

### 3.2 先检查带宽是否成立

仅按 active pixel 估算，当前模式每秒有效 RAW payload 为：

```text
3864 * 2192 * 30 * 10
= 2,540,966,400 bit/s
```

四条 lane 的理论传输能力为：

```text
446 MHz * 2 * 4
= 3,568,000,000 bit/s
```

有效像素 payload 约占理论 lane 带宽的 71.2%。余量还要容纳 CSI-2 包头、CRC、帧/行边界
和 Sensor blanking 等开销。这个估算只能用来提前发现明显错误，不能代替硬件时序验证。

### 3.3 本项验收

在继续开发 D-PHY 前，应当能回答：

- 当前寄存器表是否真的选择 10-bit、4 lane 和 linear VC0；
- `g_mbus_config()` 是否报告四条 CSI-2 data lane；
- link frequency control 是否为 446 MHz；
- source pad 是否报告 `SGBRG10_1X10/3864x2192`；
- flip 改变后 Bayer code 是否也按驱动约定更新。

## 4. 第二项增量：配置 D-PHY 物理接收

### 4.1 D-PHY 负责什么

D-PHY 接收 clock lane 和最多四条 data lane 上的差分高速信号，完成 HS 状态检测、时钟恢复、
lane 使能、采样时序和串并转换。它不理解 Bayer 顺序，不做去马赛克，也不决定输出 NV12。

可以把边界理解为：

```text
模拟/高速差分信号
  -> D-PHY
  -> 已恢复并对齐的 lane 字节流
```

CSI-2 packet 的 VC、DT、word count、ECC 和 CRC 由后面的 CSI2RX 协议逻辑处理。

### 4.2 从上游 subdev 取得 lane 和速率

D-PHY driver 不应硬编码“永远四 lane、永远 892 Mbit/s”。它要从设备树 endpoint、
Sensor bus config 和 link frequency control 得到当前配置，再选取 RK3568 对应的 HS frequency
range 和 THS-SETTLE 参数。

```c
/**
 * @brief 根据当前 Sensor bus 配置启动 RK3568 CSI2 D-PHY。
 * @param dphy D-PHY 驱动私有数据。
 * @param hw 共享 D-PHY 硬件实例。
 * @return 成功返回 0，参数或硬件状态错误时返回负 errno。
 */
static int csi2_dphy_hw_stream_on(struct csi2_dphy *dphy,
                                  struct csi2_dphy_hw *hw)
{
    /* 复位数字逻辑，避免沿用上一次 streaming 的 lane 状态。 */
    csi2_dphy_hw_reset(hw);

    /* 按 endpoint 配置 clock lane 和 data lane 的路由、方向与数量。 */
    csi2_dphy_config_grf(dphy, hw);

    /* 根据 lane bit rate 选择接收频率范围和 THS-SETTLE。 */
    csi2_dphy_config_hsfreq(dphy, hw);

    /* 最后使能 clock lane 与实际使用的 data lanes。 */
    csi2_dphy_enable_lanes(dphy, hw);
    return 0;
}
```

上面是用于说明职责和开发顺序的简化骨架，函数名不要求与 BSP 内部 helper 完全相同。
当前 BSP 的实际入口是 `csi2_dphy_hw_stream_on()`，频率范围表为
`rk3568_csi2_dphy_hw_hsfreq_ranges[]`。

### 4.3 为什么 THS-SETTLE 很重要

THS-SETTLE 决定接收端在检测到 HS 传输后，从什么时间点开始把 lane 当作稳定数据采样。
配置过早可能采到过渡区，过晚可能丢失包头。典型现象是 SoT、同步或 CRC 错误，而不是
“颜色稍微不对”。

所以 D-PHY 的调试顺序是：

1. 核对 lane mapping 和 lane 数；
2. 核对 Sensor 实际 lane bit rate；
3. 核对驱动选择的 HS frequency range；
4. 再观察 PHY/packet error status；
5. 只有错误稳定指向 settle 时才调整时序参数。

不要在 Bayer、ISP 或 NV12 代码中修复 D-PHY 同步错误。

## 5. 第三项增量：让 CSI2RX 正确接收 RAW10 packet

### 5.1 先理解 CSI-2 在线数据

对于当前 linear RAW10，数据可以简化为：

```text
Frame Start short packet
  -> 多个 RAW10 long packet
       header:  Data ID(VC + DT) + Word Count + ECC
       payload: RAW10 packed pixels
       footer:  CRC
  -> Frame End short packet
```

RAW10 长包中，4 个 10-bit pixel 占 5 byte。CSI2RX 根据 Data ID 找到 VC0 和 DT=0x2b，
检查包头、payload CRC 和帧边界，再把有效像素送入 ISP 输入通路。

### 5.2 从 Media Bus code 生成 CSI-2 Data Type

RKISP 不能把 `SGBRG10_1X10` 的枚举值直接写进 CSI2RX 寄存器，必须转换成协议 Data Type：

```c
/**
 * @brief 把 V4L2 Media Bus 像素格式转换为 CSI-2 Data Type。
 * @param pixelcode 上游 subdev 协商出的 Media Bus code。
 * @return 成功时返回 CSI-2 Data Type，不支持时返回负 errno。
 */
static int mbus_pixelcode_to_mipi_dt(u32 pixelcode)
{
    switch (pixelcode) {
    case MEDIA_BUS_FMT_SGBRG10_1X10:
        return CIF_CSI2_DT_RAW10; /* CSI-2 RAW10，值为 0x2b。 */
    default:
        return -EINVAL;
    }
}
```

实际 BSP 同时映射四种 RAW10 Bayer code，因为它们在线上都使用 `DT=0x2b`。

### 5.3 配置 lane、VC/DT 和错误中断

`csi_config()` 是当前 RKISP21 CSI2RX 的关键配置入口。第一次实现时至少要完成：

```c
/**
 * @brief 配置 CSI2RX，使其接收当前 Sensor 的 CSI-2 数据流。
 * @param csi RKISP CSI 接收模块私有数据。
 * @return 成功返回 0，格式、lane 或 HDR 配置无效时返回负 errno。
 */
static int csi_config(struct rkisp_csi_device *csi)
{
    /* 硬件用 lanes - 1 编码；当前四 lane 应写入 3。 */
    rkisp_write(dev, CSI2RX_CTRL1, lanes - 1, true);

    /* linear mode 只接收 VC0/RAW10；HDR 模式才需要额外 VC。 */
    rkisp_write(dev, CSI2RX_DATA_IDS_1, csi->mipi_di[0], true);

    /* 清除开流前的残留状态，避免把旧错误计入新一次采集。 */
    rkisp_csi_clear_errors(dev);

    /* 打开 PHY、packet、overflow、size/drop 等错误中断。 */
    rkisp_csi_enable_error_irqs(dev);
    return 0;
}
```

这里的 `mipi_di` 是 CSI-2 Data Identifier，包含 VC 与 DT。linear VC0 RAW10 的核心信息是：

```text
VC = 0
DT = 0x2b
```

如果 Sensor 输出 RAW10，而 CSI2RX 按 RAW12 接收，或者 Sensor 使用 VC1 而接收端只允许 VC0，
即使 D-PHY 已经锁定，也无法形成正确的 ISP 输入帧。

### 5.4 CSI2RX 的错误分类

当前 RKISP21 分别记录以下错误来源：

| 类别 | 说明 | 优先检查 |
| --- | --- | --- |
| PHY error | SoT、同步、EOT、ESC 等物理接收错误 | lane、bit rate、settle、信号质量 |
| Packet error | frame sequence、ECC、checksum 等协议错误 | VC/DT、链路稳定性、Sensor 输出 |
| Overflow | 接收 FIFO 来不及向后级输出 | 下游时钟、ISP 状态、带宽 |
| Status error | frame size、line count、drop frame 等 | mode 尺寸、crop、包长、时序 |

`rkisp_mipi_v21_isr()` 负责读取和统计这些错误。它表示 CSI 接收情况，但它不会把 capture
Buffer 标记为完成。

## 6. 第四项增量：选择 MIPI 输入并建立 ISP acquisition window

### 6.1 把 RKISP 输入 mux 指向 CSI2RX

RKISP 还可以从并口、DMA readback 等其他来源取数据，因此建立 Media Graph 后仍需配置
硬件 data-path mux。当前 CSI-2 Sensor 路径在 `rkisp_config_path()` 中选择：

```text
CSI2RX -> ISP input
```

对应硬件配置使用 `CIF_VI_DPCL_IF_SEL_MIPI`。如果 mux 选择错误，Media Graph 看起来仍然
完整，但 ISP 不会收到来自 D-PHY 的像素。

### 6.2 配置 RAW Bayer 输入模式

`rkisp_config_isp()` 根据 sink pad format 和 crop 设置 ISP acquisition：

```c
/**
 * @brief 配置 ISP 输入格式、采集窗口和 Bayer 处理入口。
 * @param dev 当前 RKISP virtual device。
 * @return 成功返回 0，输入输出组合不受支持时返回负 errno。
 */
static int rkisp_config_isp(struct rkisp_device *dev)
{
    /* 根据 SGBRG10 设置 10-bit Bayer 输入和 GB/RG 排列。 */
    rkisp_config_acq_properties(dev, in_fmt);

    /* 配置从 3864x2192 输入中取出的 ISP acquisition window。 */
    rkisp_write(dev, CIF_ISP_ACQ_H_OFFS, crop.left, true);
    rkisp_write(dev, CIF_ISP_ACQ_V_OFFS, crop.top, true);
    rkisp_write(dev, CIF_ISP_ACQ_H_SIZE, crop.width, true);
    rkisp_write(dev, CIF_ISP_ACQ_V_SIZE, crop.height, true);

    /* Bayer 输入转为 YUV 输出时使能 debayer 路径。 */
    rkisp_enable_debayer(dev);
    return 0;
}
```

当前 acquisition window 为：

```text
输入：3864x2192 SGBRG10
偏移：(12,16)
大小：3840x2160
```

这个 crop 在 ISP 输入端去掉 Sensor 有效阵列边缘，和 MainPath 后面的 dual-crop 不是同一
硬件模块。

### 6.3 Bayer 顺序错了会发生什么

ISP 必须知道左上角像素属于 G、B、R 中的哪一种。若 Sensor 实际输出 SGBRG10，而驱动错误
报告 SRGGB10，D-PHY 与 CSI2RX 仍可能完全无错，帧大小和 sequence 也正常，但去马赛克结果
会严重偏色。

因此排查顺序应当是：

```text
有无帧、CSI 是否报错
  -> 帧尺寸是否正确
  -> Bayer code 是否匹配 flip/crop 后的排列
  -> ISP 参数和白平衡
```

不能因为画面偏色就先修改 D-PHY settle。

## 7. 第五项增量：建立最小 ISP Bayer 到 YUV 通路

### 7.1 先实现最小可出图配置

RKISP21 包含黑电平、坏点校正、镜头阴影、去马赛克、白平衡、颜色矩阵、Gamma、降噪、
锐化和颜色空间转换等模块。第一次打通时，不要同时手工调完所有图像质量模块。

最小目标是：

1. ISP 正确接收 SGBRG10；
2. debayer 路径开启；
3. output pad 产生有效 3840x2160 YUV；
4. 无 picture-size/data-loss 错误；
5. 再由 params/RKAIQ 按帧更新图像质量参数。

当前 `rkisp_config_isp()` 在 Bayer 输入、YUV 输出时打开 debayer，并调用 colorspace 与第一组
params 配置。具体启用哪些 ISP 算法块取决于 params node 和 RKAIQ 下发的配置，不能仅凭
硬件支持列表断言所有模块都处于工作状态。

### 7.2 `YUYV8_2X8` 不是一张中间 DDR 图像

Media Graph 显示 ISP source pad 为：

```text
YUYV8_2X8/3840x2160
```

它描述 ISP 与后级 MainPath 之间的片上 Media Bus 数据格式。它不表示驱动先在 DDR 中写出
一张 3840x2160 YUYV，再由 CPU 或 DMA 复制成 NV12。

真实路径是：

```text
ISP YUV stream
  -> 片上 MainPath crop/resizer
  -> MI 按 NV12 layout 写 DDR
```

只有最终 MainPath Buffer 必须落入 DDR。本路径没有一张由软件可见的中间 YUYV Buffer。

### 7.3 colorspace 也必须协商一致

`rkisp_config_color_space()` 根据 colorspace、quantization 等字段选择 BT.601、BT.709 或
BT.2020 相关矩阵及 full/limited range。颜色不正确时，除了 Bayer 顺序，还要检查：

- ISP source pad 的 colorspace；
- MainPath capture format 中的 colorspace/quantization；
- 后续消费者使用的 YUV 到 RGB 矩阵。

这些元数据不会替代像素处理；驱动仍需把对应矩阵真正写入负责颜色转换的硬件模块。

## 8. 第六项增量：配置 MainPath crop、resize 和 NV12

### 8.1 MainPath 的三个硬件步骤

对于当前 `/dev/video0`，MainPath 需要完成：

```text
ISP source：3840x2160 YUV422
  -> dual-crop：当前不再裁剪，3840x2160
  -> main resizer：3840x2160 -> 1920x1080
  -> chroma subsampling / MI format：YUV420 NV12
```

`rkisp_stream_config_dcrop()` 比较 MainPath crop 和 ISP source window。当前二者相同，因此
dual-crop 可以关闭。`rkisp_stream_config_rsz()` 分别计算 luma 与 chroma 的输入输出尺寸，
再配置 main resizer。

### 8.2 格式表同时描述 color plane 和 memory plane

RKISP `mp_fmts[]` 中的 NV12 条目核心信息是：

```c
{
    .fourcc = V4L2_PIX_FMT_NV12,       /* Y 平面后紧跟交错 UV。 */
    .fmt_type = FMT_YUV,               /* MainPath 输出属于 YUV。 */
    .bpp = { 8, 16 },                  /* Y 为 8 bit；UV 每组为 16 bit。 */
    .cplanes = 2,                      /* 两个颜色平面：Y 和 UV。 */
    .mplanes = 1,                      /* 一个连续的 DMA memory plane。 */
    .uv_swap = 0,                      /* UV 顺序；NV21 才交换为 VU。 */
    .write_format = MI_CTRL_MP_WRITE_YUV_SPLA,
}
```

因此当前格式是：

```text
1 个 memory plane
  ├─ color plane Y
  └─ color plane UV
```

这也解释了为什么 V4L2 multi-planar API 返回 `Memory planes: 1`，而 MI 仍要配置 Y 地址和
CB/UV 地址。API 的 memory plane 数量与像素格式的 color plane 数量不是同一个概念。

### 8.3 选择 MainPath 数据路由

`mp_set_data_path()` 在 `CIF_VI_DPCL` 中选择：

```text
MainPath channel -> Main Resizer -> Memory Interface
```

对应标志为 `CIF_VI_DPCL_CHAN_MODE_MP | CIF_VI_DPCL_MP_MUX_MRSZ_MI`。若未选择这条路，
即使 ISP 已输出正确 YUV，MI 也不会收到 main resizer 的结果。

## 9. 第七项增量：让 MI DMA 把 NV12 写入 DDR

### 9.1 MI 是什么

MI 是 RKISP Memory Interface。它是 DMA 写入端，接收 MainPath 的像素流，通过 AXI 向 DDR
写数据。CPU 只负责提前写入 DMA 地址、尺寸和格式；每个像素不是由 CPU 循环存入内存。

```text
MainPath pixel stream
  -> MI write engine
  -> AXI/IOMMU
  -> DDR Buffer
```

### 9.2 从 VB2 Buffer 取得 DMA 地址

VB2 memory backend 为 Buffer 建立 DMA mapping。RKISP 的 `.buf_queue()` 从 mapping 中取得
设备可访问地址，并保存到 `struct rkisp_buffer::buff_addr[]`：

```c
/**
 * @brief 取得已排队 Buffer 的 DMA 地址并加入 RKISP 空闲队列。
 * @param vb VB2 交给 RKISP 的 Buffer 描述对象。
 */
static void rkisp_buf_queue(struct vb2_buffer *vb)
{
    /* SG backend 取得第一段设备 DMA 地址。 */
    ispbuf->buff_addr[RKISP_PLANE_Y] =
        sg_dma_address(vb2_dma_sg_plane_desc(vb, 0)->sgl);

    /* 单 memory plane NV12 的 UV 地址位于有效 Y 图像之后。 */
    ispbuf->buff_addr[RKISP_PLANE_CB] =
        ispbuf->buff_addr[RKISP_PLANE_Y] +
        bytesperline * height;

    /* 将空 Buffer 放入 RKISP 自己的待写入队列。 */
    list_add_tail(&ispbuf->queue, &stream->buf_queue);
}
```

这是依据当前 BSP 的简化代码。实际函数还处理 dma-contig、多 memory plane、三个 color
plane 和 spinlock。

### 9.3 当前 NV12 的内存布局

当前 1920x1080、stride=1920：

```text
Y size  = 1920 * 1080       = 2,073,600 byte
UV size = 1920 * 1080 / 2   = 1,036,800 byte
payload = Y + UV            = 3,110,400 byte
```

地址关系为：

```text
Y DMA address  = buffer base
UV DMA address = buffer base + 2,073,600
```

Buffer 实际分配长度可能是 3,133,440 byte：

```text
1920 * ALIGN(1080, 16) * 3 / 2
= 1920 * 1088 * 3 / 2
= 3,133,440 byte
```

多出的空间来自按 16 行对齐的 allocation，便于 Rockchip 编码器直接使用 DMA Buffer。
它不代表有效图像变成 1920x1088；当前有效 payload 仍是 3,110,400 byte。

### 9.4 配置 MI 寄存器

`mp_config_mi()` 在 STREAMON 时完成四类配置：

```c
/**
 * @brief 为 MainPath 配置 MI 尺寸、NV12 写格式和第一块 Buffer。
 * @param stream RKISP MainPath stream。
 * @return 成功返回 0，配置失败返回负 errno。
 */
static int mp_config_mi(struct rkisp_stream *stream)
{
    /* Y/UV 大小决定 MI 对每个颜色平面写入多少数据。 */
    mi_set_y_size(stream, y_size);
    mi_set_cb_size(stream, uv_size);
    mi_set_cr_size(stream, 0);

    /* NV12 使用 UV；NV21 才打开 CB/CR swap。 */
    mi_config_uv_order(stream, false);

    /* 设置 burst、semi-planar write format 和自动地址更新。 */
    mi_config_write_mode(stream, MI_CTRL_MP_WRITE_YUV_SPLA);

    /* 开启 MI frame-end IRQ，并装入第一块 Buffer 地址。 */
    mi_frame_end_int_enable(stream);
    mi_frame_end(stream);
    return 0;
}
```

实际 BSP 直接操作 `y_size_init`、`cb_size_init`、`CIF_MI_CTRL` 等寄存器。这里保留 helper
形式，是为了突出开发顺序而不是展开每一个 bit。

### 9.5 没有可用 Buffer 时怎么办

MI 不能因为软件暂时没有空 Buffer 就把 DMA 写到任意地址。当前 BSP 在 `update_mi()` 中：

1. 有 `next_buf`：把它的 Y、CB、CR DMA 地址写入 MI；
2. 没有 `next_buf`：把地址切换到预分配的 dummy buffer；
3. 增加 `frameloss` 计数；
4. 保持硬件 pipeline 连续运行。

这就是采集端生产速率高于 Buffer 归还速率时的底层保护机制之一。驱动丢弃无法交付的帧，
而不是覆盖仍由其他模块持有的有效 Buffer。

## 10. 第八项增量：用正确的中断定义“一帧完成”

### 10.1 三类中断不能混为一谈

当前路径至少涉及三类中断：

| 中断 | 含义 | 是否可直接完成 capture Buffer |
| --- | --- | --- |
| CSI2RX interrupt | packet/PHY/overflow/size 状态变化 | 否 |
| ISP FRAME interrupt | ISP 处理到帧边界 | 否 |
| MI MainPath frame-end | MainPath 帧已经完成内存写入 | 是 |

CSI 收到 Frame End，不等于 DDR 写入已经结束；ISP 处理完最后一个像素，也不等于 AXI 最后
一笔写事务已经完成。对 `/dev/video0` 来说，必须以 MI frame-end 作为 Buffer 完成边界。

### 10.2 MI frame-end 调用链

```text
RKISP MI frame-end IRQ
  -> mi_irq_hdl()
  -> rkisp_mi_isr()
  -> rkisp_mi_v21_isr()
  -> mi_frame_end(stream)
  -> 填 payload / sequence / timestamp
  -> vb2_buffer_done(..., VB2_BUF_STATE_DONE)
```

`mi_frame_end()` 同时完成上一帧和准备后续帧：

```c
/**
 * @brief 在 MI 帧结束时完成当前 Buffer，并准备后续 DMA 地址。
 * @param stream 产生 frame-end 的 RKISP stream。
 * @return 成功返回 0。
 */
static int mi_frame_end(struct rkisp_stream *stream)
{
    if (stream->curr_buf) {
        /* 有效载荷、序号和时间戳只在完整写入后发布。 */
        vb2_set_plane_payload(vb, 0, sizeimage);
        vbuf->sequence = next_sequence;
        vb->timestamp = frame_timestamp;
        vb2_buffer_done(vb, VB2_BUF_STATE_DONE);
    }

    /* 已经开始写入的 next_buf 成为 curr_buf。 */
    stream->curr_buf = stream->next_buf;

    /* 从空闲队列再取一块，作为下一帧之后要写入的地址。 */
    stream->next_buf = rkisp_pop_queued_buffer(stream);

    /* 在硬件规定的 shadow-register 时机更新后续 MI 地址。 */
    stream->ops->update_mi(stream);
    return 0;
}
```

RKISP 使用 `curr_buf`、`next_buf` 和 `buf_queue`，是因为硬件正在写当前帧时，下一帧的地址
必须提前写入 shadow register。中断到来后才临时寻找当前帧地址已经太晚，容易造成 FIFO
overflow 或帧丢失。

完整的 Buffer 状态和四 Buffer 轮转将在下一篇展开。

## 11. 一帧真实数据的完整时序

下面按当前板端配置跟踪一帧，不再按驱动函数分组：

```text
1. IMX415 根据 VMAX/HMAX 开始一帧曝光。
2. 每个 photosite 经模拟前端和 ADC 得到 10-bit Bayer sample。
3. Sensor 按 SGBRG 排列生成 3864x2192 RAW10。
4. Sensor 把 RAW10 按 CSI-2 规则打包，通过 VC0/DT 0x2b 发送。
5. 四条 data lane 各以约 892 Mbit/s 传输，clock lane 提供源同步时钟。
6. RK3568 D-PHY 完成 HS 接收、时钟恢复、lane 对齐和串并转换。
7. CSI2RX 解析 short/long packet，检查 ECC/CRC、VC、DT 和帧尺寸。
8. CSI2RX 将解包后的 3864x2192 SGBRG10 像素送入 ISP。
9. ISP acquisition 从 (12,16) 取得 3840x2160 Bayer 区域。
10. ISP 执行 debayer 以及当前 params 允许的图像处理，输出片上 YUV stream。
11. MainPath dual-crop 保持 3840x2160，main resizer 缩小到 1920x1080。
12. MainPath/MI 将 YUV420 按 NV12 的 Y + UV layout 组织。
13. MI 用预先配置的 Y/UV DMA 地址，通过 AXI/IOMMU 写入 DDR。
14. MI frame-end IRQ 到达，说明这一帧的内存写入已经完成。
15. RKISP 填写 payload、sequence、timestamp，并调用 vb2_buffer_done()。
16. MI shadow register 切换到下一块 Buffer，硬件继续接收后续帧。
```

整个过程只有配置寄存器、处理中断和管理 Buffer 元数据需要 CPU。像素 payload 不经过
CPU 的逐像素读写，也没有从 ISP 中间 YUYV 到最终 NV12 的 CPU 整帧拷贝。

## 12. 从零开发时的推荐提交顺序

不要一次提交完整 Camera pipeline。建议按以下可独立验证的增量开发：

### 12.1 提交一：固定 RAW10 数据契约

- Sensor 只保留一个 3864x2192 RAW10 linear mode；
- 正确报告 Bayer code、lane、link frequency 和 frame interval；
- 只验证 format/control，不要求 capture 成功。

### 12.2 提交二：D-PHY 最小接收

- 取得 endpoint lane mapping；
- 根据 link frequency 计算 lane bit rate；
- 选择 RK3568 HS frequency range 与 THS-SETTLE；
- 能可靠 stream on/off，无持续 PHY error。

### 12.3 提交三：CSI2RX linear VC0/RAW10

- Media Bus code 转换为 `DT=0x2b`；
- 配置四 lane、VC0、RAW10；
- 启用并分类记录 packet/PHY/overflow/size errors；
- 暂不加入 HDR 多 VC 分支。

### 12.4 提交四：ISP acquisition 与最小 YUV 输出

- 选择 MIPI input mux；
- 配置 3864x2192 Bayer input 与 `(12,16)/3840x2160` crop；
- 正确设置 SGBRG Bayer pattern；
- 开启 debayer，获得稳定的 3840x2160 YUV source stream。

### 12.5 提交五：MainPath 与 MI

- 注册并协商 NV12；
- 配置 3840x2160 到 1920x1080 的 main resizer；
- 正确计算 Y/UV 大小和 DMA 地址；
- 以 MI frame-end 完成 Buffer；
- 无空 Buffer 时安全写入 dummy buffer。

### 12.6 提交六：错误统计和长期稳定性

- 分开记录 CSI、ISP、MI 错误；
- 检查 sequence gap、frame loss 和 timeout；
- 持续采集验证时钟、带宽和 Buffer 补充速度；
- 最后再加入 HDR、多 mode 和高级 ISP 参数。

每一个提交都只跨越一个主要故障边界。这样“没有图像”时，可以从最后一个通过验收的边界
继续定位，而不需要同时猜测 Sensor、PHY、CSI、ISP 和 DMA。

## 13. 驱动边界排查表

| 现象 | 最可能的边界 | 首先核对 |
| --- | --- | --- |
| 完全没有 CSI 活动 | Sensor -> D-PHY | standby、XVCLK、lane、Sensor mode |
| 大量 SoT/同步错误 | D-PHY | lane mapping、bit rate、THS-SETTLE、硬件信号 |
| ECC/CRC/sequence 错误 | CSI-2/CSI2RX | VC/DT、链路稳定性、packet 配置 |
| picture-size/line-count 错误 | CSI2RX -> ISP | Sensor 输出尺寸、word count、crop |
| 有帧但严重偏色 | ISP | Bayer 顺序、flip、black level、AWB/CCM |
| 图像正常但尺寸不对 | MainPath | dual-crop、main resizer、output format |
| 绿紫色交替或 UV 错位 | MainPath/消费者 | NV12/NV21、stride、UV offset |
| ISP 有中断但 Buffer 不完成 | MI | DMA 地址、MI enable、frame-end mask |
| 采集一段时间后丢帧 | MI/VB2 | 空 Buffer 数、dummy buffer、DDR 带宽 |

## 14. 板端验证命令

以下命令只用于触发和观察驱动边界，不展开采集应用的实现。

### 14.1 查看静态格式链路

```bash
media-ctl -d /dev/media0 -p
v4l2-ctl -d /dev/video0 --get-fmt-video
v4l2-ctl -d /dev/v4l-subdev3 --get-subdev-fmt pad=0
cat /proc/rkisp-vir0
```

应重点确认：

```text
IMX415/D-PHY/CSI：SGBRG10_1X10 3864x2192
ISP sink crop：   (12,16)/3840x2160
ISP source：      YUYV8_2X8 3840x2160
MainPath：        NV12 1920x1080
```

### 14.2 用通用工具触发 100 帧

测试前确认没有其他进程占用 Camera：

```bash
v4l2-ctl -d /dev/video0 \
  --set-fmt-video=width=1920,height=1080,pixelformat=NV12 \
  --stream-mmap=4 \
  --stream-count=100 \
  --stream-poll
```

该命令只是触发 V4L2 驱动工作，用于观察内核路径；它不是本篇要开发的应用代码。

### 14.3 观察错误和中断

采集前后分别执行：

```bash
cat /proc/interrupts | grep -Ei 'rkisp|isp|mipi|csi'
dmesg | grep -Ei 'mipi|csi|dphy|pic_size|data_loss|overflow|drop frame'
cat /proc/rkisp-vir0
```

判断规则：

- 中断计数持续增加、无 CSI/ISP error，说明数据至少穿过了对应硬件；
- 100 帧能够结束，不代表色彩一定正确，还需验证 Bayer 和 colorspace；
- 只看 `/dev/video0` 节点存在，不能证明 Sensor 正在输出数据；
- 只看 CSI Frame End，也不能证明最终 DDR Buffer 已完整写入。

## 15. 本篇验收清单

- [ ] 能区分 I2C 控制面与 MIPI 像素数据面。
- [ ] 能解释 `SGBRG10_1X10`、RAW10 和 `DT=0x2b` 的区别。
- [ ] 能解释 D-PHY 与 CSI2RX 的职责边界。
- [ ] 能从 446 MHz 推导 892 Mbit/s/Lane。
- [ ] 能说明 3864x2192 如何 crop 为 3840x2160。
- [ ] 能解释 debayer 为什么必须知道 Bayer 顺序。
- [ ] 能说明 `YUYV8_2X8` 不是一张中间 DDR Buffer。
- [ ] 能说明 MainPath 如何把 3840x2160 缩放为 1920x1080。
- [ ] 能区分 NV12 的两个 color plane 和一个 memory plane。
- [ ] 能计算 3,110,400 byte payload 和 3,133,440 byte allocation。
- [ ] 能说明 MI 为什么需要 `curr_buf`、`next_buf` 和 dummy buffer。
- [ ] 能说明只有 MI frame-end 才能完成 MainPath capture Buffer。

## 16. 下一篇入口

本篇已经把一帧送到 DDR，但只把 VB2 当作 DMA Buffer 的提供者。下一篇将从驱动开发者
视角实现 `vb2_queue`，完整解释：

```text
REQBUFS 分配
  -> QUERYBUF / mmap
  -> QBUF 交出所有权
  -> rkisp_buf_queue()
  -> curr_buf / next_buf / buf_queue
  -> MI DMA 写入
  -> frame-end
  -> vb2_buffer_done()
  -> poll / DQBUF
  -> 再次 QBUF
```

重点是弄清 MMAP、VB2 Buffer、DMA 地址、DMA-BUF fd 和四个 Buffer 的动态所有权，而不是
再次展开 Sensor 或 ISP 图像处理。
