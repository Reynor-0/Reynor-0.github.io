---
title: 'Camera 驱动开发（一）：设备树修改'
description: '在 rk3568 平台上为 IMX415 Sensor 编写驱动程序'
series: { id: 'camera-driver', order: 1 }
tags: ['Camera', 'Linux', 'V4L2', '图像处理']
pubDate: 'Jun 26 2026'
---

## 设备树与硬件资源

首先我们需要理解


1. 内核如何知道 RK3568 开发板上存在一颗 IMX415？
2. 内核如何知道 IMX415 接在 I2C4 和 CSI2 D-PHY0 上？
3. D-PHY0 与 RKISP0 如何通过设备树连成一条 Camera pipeline？
4. 如何证明源码中的设备树确实成为了开发板当前正在使用的运行时设备树？

这一部分就是通过设备树完成。有关设备树的介绍这里不再详细介绍，想要了解可以查阅先前的博客[设备树详解]()。

**当前的RK3568开发板Camera链路**


```text
I2C4 controller @ 0xfe5d0000
  |
  +-- IMX415 @ I2C address 0x1a
        |  XVCLK: CLK_CIF_OUT
        |  reset: GPIO3_B6, active low
        |  power: GPIO4_B4, active high
        |  MIPI CSI-2: 4 data lanes
        v
CSI2 D-PHY0 logical device
  |
  +-- shared D-PHY hardware @ 0xfe870000
  v
RKISP virtual device 0
  |
  +-- RKISP hardware @ 0xfdff0000
  +-- RKISP IOMMU  @ 0xfdff1a00
  v
rkisp_mainpath
  v
/dev/video0
```

简略描述一下就是一个Camera Sensor接受I2C4控制器来控制，图像数据通过MIPI CSI-2接口传输到RKISP处理，处理完之后对外暴露为`'/dev/video0'`。

查看RK3568的SDK，进行内核编译时，首先要选择板级文件，也就是
```text
device/rockchip/rk356x/BoardConfig-rk3568-atk-evb1-ddr4-v10.mk
```

其中最关键的配置部分：

```bash
export RK_ARCH=arm64
export RK_KERNEL_DEFCONFIG=rockchip_linux_defconfig
export RK_KERNEL_DTS=rk3568-atk-evb1-ddr4-v10-linux
export RK_BOOT_IMG=boot.img
export RK_KERNEL_IMG=kernel/arch/arm64/boot/Image
export RK_KERNEL_FIT_ITS=boot.its
```

`RK_KERNEL_DTS` 决定最终编译哪个板级 DTS。分析设备树前先确认这个变量，不能仅凭文件名猜测开发板使用了哪个 DTS。

## DTS 的包含和编译关系

### 源文件包含关系

我们知道了入口文件是：

```text
kernel/arch/arm64/boot/dts/rockchip/
  rk3568-atk-evb1-ddr4-v10-linux.dts
```
这是最终的设备树文件，它包含了：

```dts
#include "rk3568-atk-evb1-ddr4-v10.dtsi"
#include "rk3568-linux.dtsi"
#include "rk3568-screen_choose.dtsi"
#include "rk3568-lcds.dtsi"
```
其中板级文件`rk3568-atk-evb1-ddr4-v10.dtsi` 又包含：

```dts
#include "rk3568.dtsi"
#include "rk3568-evb.dtsi"
```

可以把这种关系理解为：

```text
rk3568.dtsi
  定义 SoC 内部控制器、寄存器地址、中断、时钟和默认 disabled 状态
        |
        v
rk3568-atk-evb1-ddr4-v10.dtsi
  描述 ATK 板上实际焊接的器件，并覆盖需要启用的 SoC 节点
        |
        v
rk3568-atk-evb1-ddr4-v10-linux.dts
  作为 Linux 最终板级入口，再组合 Linux 和显示相关配置
```

因此，`rk3568.dtsi` 中的 `status = "disabled"` 与板级 DTSI 中的`status = "okay"` 并不冲突。后包含的板级内容通过 `&label` 修改了前面已经定义的节点。

### 编译设备树


```text
BoardConfig 中的 RK_KERNEL_DTS
  -> C 预处理器展开 #include 和宏
  -> DTC 编译为 rk3568-atk-evb1-ddr4-v10-linux.dtb
  -> Rockchip 构建脚本将 Image 和 DTB 打入 FIT boot.img
  -> Bootloader 从 boot.img 取出 DTB
  -> 将 DTB 地址传给 Linux 内核
  -> 内核展开为 live device tree
  -> /sys/firmware/devicetree/base
```

我们在开发板上执行`ls /sys/firmware/devicetree/base/`也可以得到以下的部分内容：
```bash
root@ATK-DLRK3568:/# ls /sys/firmware/devicetree/base/
...
 cpu0-opp-table                   qos@fe158180
 cpuinfo                          qos@fe158200
 cpus                             qos@fe158280
 crypto@fe380000                  qos@fe158300
 csi2-dphy0                       qos@fe180000
 csi2-dphy1                       qos@fe190000
 csi2-dphy2                       qos@fe190080
 csi2-dphy-hw@fe870000            qos@fe190100
...
```

### 一些关键字段

**label与节点引用**

```dts
//Soc文件中先定义了
i2c4: i2c@fe5d0000 {
    status = "disabled";
};

/* `i2c4` 是 label，供其他设备树代码引用。
 * `i2c@fe5d0000` 是节点名，`fe5d0000` 是 unit-address。
 * `&i2c4` 表示找到 label 为 `i2c4` 的原节点并追加或覆盖属性。
 */

// 接着板级文件再写，表示启动了这个节点
&i2c4 {
    status = "okay";
};
```

**compatible**

```dts
compatible = "sony,imx415";
```

`compatible` 是设备和驱动匹配的主要依据。I2C core 创建该设备的 `i2c_client` 后，会用这个字符串与 IMX415 驱动的 OF match table 匹配。匹配成功后才会调用驱动的`probe()`。

**reg**

`reg` 的解释由父节点的 `#address-cells` 和 `#size-cells` 决定。I2C4 定义了：

```dts
#address-cells = <1>;
#size-cells = <0>;
```

所以 Sensor 的：

```dts
reg = <0x1a>;
```
表示 7-bit I2C 从设备地址 `0x1a`，不是 MMIO 寄存器地址。

相反，SoC 设备的：

```dts
reg = <0x0 0xfdff0000 0x0 0x10000>;
```

表示 RKISP 的 MMIO 基地址是 `0xfdff0000`，地址空间大小是 `0x10000`。

**phandle**
```dts
clocks = <&cru CLK_CIF_OUT>;
reset-gpios = <&gpio3 RK_PB6 GPIO_ACTIVE_LOW>;
power-domains = <&power RK3568_PD_VI>;
```

phandle 本质上是“引用另一个设备树节点”。后面的 cell 由被引用节点所定义的
`#clock-cells`、`#gpio-cells` 或 `#power-domain-cells` 解释。

**`port`、`endpoint` 和 `remote-endpoint`**

Camera 数据链路不是 I2C 总线关系。I2C 只负责控制 Sensor，像素通过 MIPI CSI-2传输。因此设备树还需要使用 OF graph 表示数据通路：

```dts
sensor endpoint <----------> dphy sink endpoint
dphy source endpoint <-----> isp sink endpoint
```
一条连接的两端都写 `remote-endpoint`，形成双向引用。`media-ctl -p` 中看到的 Media link 正是驱动根据这些 endpoint 关系建立出来的。

## IMX415完整设备树源码解析


```dts
&i2c4 {
    status = "okay";                       // 启用 RK3568 的 I2C4 控制器。

    imx415: imx415@1a {
        status = "okay";                   // 允许内核创建该设备。
        compatible = "sony,imx415";        // 匹配 IMX415 驱动。
        reg = <0x1a>;                       // 7-bit I2C 地址 0x1a。

        clocks = <&cru CLK_CIF_OUT>;        // Sensor 外部输入时钟来源。
        clock-names = "xvclk";             // 驱动按名称取得该时钟。
        power-domains = <&power RK3568_PD_VI>; // 归属 RK3568 Video Input 电源域。

        pinctrl-names = "rockchip,camera_default"; // 当前默认引脚状态名称。
        pinctrl-0 = <&cif_clk>;             // 把对应引脚复用为 CIF clock 输出。

        reset-gpios = <&gpio3 RK_PB6 GPIO_ACTIVE_LOW>;
                                               // GPIO3_B6，低电平表示 reset 有效。
        power-gpios = <&gpio4 RK_PB4 GPIO_ACTIVE_HIGH>;
                                               // GPIO4_B4，高电平使能模组电源。

        rockchip,camera-module-index = <0>; // Rockchip Camera 模组编号。
        rockchip,camera-module-facing = "back";
                                               // 模组朝向，用于生成 entity 名称等信息。
        rockchip,camera-module-name = "CMK-OT1522-FG3";
                                               // 模组厂商/型号信息。
        rockchip,camera-module-lens-name = "CS-P1150-IRC-8M-FAU";
                                               // 镜头型号信息。

        port {
            imx415_out: endpoint {
                remote-endpoint = <&mipi_in_ucam1>;
                                               // 像素流送往 D-PHY0 的对应 sink。
                data-lanes = <1 2 3 4>;       // 使用四条 MIPI CSI-2 data lane。
            };
        };
    };
};
```
这里必须区分两条完全不同的路径：

```text
控制路径：CPU -> I2C4 -> IMX415 寄存器
数据路径：IMX415 -> 4-lane MIPI CSI-2 -> D-PHY -> RKISP
```

`reg = <0x1a>` 只属于控制路径；`endpoint` 和 `data-lanes` 属于数据路径。

## CSI2 D-PHY

### D-PHY 硬件节点

SoC 文件定义：

```dts
csi2_dphy_hw: csi2-dphy-hw@fe870000 {
    compatible = "rockchip,rk3568-csi2-dphy-hw";
    reg = <0x0 0xfe870000 0x0 0x1000>; // D-PHY MMIO 范围。
    clocks = <&cru PCLK_MIPICSIPHY>;    // D-PHY APB 配置时钟。
    clock-names = "pclk";
    rockchip,grf = <&grf>;              // 需要访问 GRF 中的 SoC 配置位。
    status = "disabled";
};
```
板级文件通过下面配置启用它：

```dts
&csi2_dphy_hw {
    status = "okay";
};
```

### D-PHY0 逻辑节点

SoC 文件定义：

```dts
csi2_dphy0: csi2-dphy0 {
    compatible = "rockchip,rk3568-csi2-dphy";
    rockchip,hw = <&csi2_dphy_hw>; // 多个逻辑节点引用同一套 D-PHY 硬件。
    status = "disabled";
};
```
RK3568 的 `csi2_dphy0` 使用四 lane full mode。`csi2_dphy1` 和 `csi2_dphy2` 是两个双 lane split mode。full mode 与两个 split mode 互斥，当前板使用 D-PHY0 full mode。

板级文件为 D-PHY0 添加 graph：

```dts
&csi2_dphy0 {
    status = "okay";

    ports {
        #address-cells = <1>;
        #size-cells = <0>;

        port@0 {                         // D-PHY 的输入 port。
            reg = <0>;

            mipi_in_ucam1: endpoint@2 {
                reg = <2>;               // 该 port 下 endpoint 的编号。
                remote-endpoint = <&imx415_out>;
                data-lanes = <1 2 3 4>;
            };
        };

        port@1 {                         // D-PHY 的输出 port。
            reg = <1>;

            csidphy_out: endpoint@0 {
                reg = <0>;
                remote-endpoint = <&isp0_in>;
            };
        };
    };
};
```

## RKISP、IOMMU 和 virtual device

### RKISP 硬件节点

SoC 文件中的核心属性是：

```dts
rkisp: rkisp@fdff0000 {
    compatible = "rockchip,rk3568-rkisp";
    reg = <0x0 0xfdff0000 0x0 0x10000>;
    interrupts = <...>;                  // MIPI、memory interface、ISP 中断。
    interrupt-names = "mipi_irq", "mi_irq", "isp_irq";
    clocks = <...>;                      // ISP 的总线和核心时钟。
    clock-names = "aclk_isp", "hclk_isp", "clk_isp";
    resets = <...>;                      // ISP 模块复位资源。
    power-domains = <&power RK3568_PD_VI>;
    iommus = <&rkisp_mmu>;               // ISP DMA 访问通过这个 IOMMU。
    status = "disabled";
};
```

板级文件将它改成 `okay`。只有硬件节点被启用，驱动才会获得 MMIO、中断、时钟、reset、
power domain 和 IOMMU 等资源。

### RKISP IOMMU


```dts
rkisp_mmu: iommu@fdff1a00 {
    compatible = "rockchip,iommu-v2";
    reg = <0x0 0xfdff1a00 0x0 0x100>;
    interrupts = <...>;
    clocks = <...>;
    power-domains = <&power RK3568_PD_VI>;
    #iommu-cells = <0>;
    status = "disabled";
};
```

板级文件也将它改成 `okay`。IOMMU 负责把 ISP DMA 使用的 I/O virtual address 映射到
实际物理内存页。它与用户态的虚拟内存不是同一层概念，但最终都参与同一块图像 buffer
的地址管理。

### RKISP virtual device 0

```dts
rkisp_vir0: rkisp-vir0 {
    compatible = "rockchip,rkisp-vir";
    rockchip,hw = <&rkisp>;               // 逻辑 ISP 实例使用上面的 ISP 硬件。
    status = "disabled";
};
```

板级文件启用它并补充输入 endpoint：

```dts
&rkisp_vir0 {
    status = "okay";

    port {
        isp0_in: endpoint@0 {
            reg = <0>;
            remote-endpoint = <&csidphy_out>;
        };
    };
};
```
`rkisp` 表示可访问的 ISP 硬件，`rkisp_vir0` 表示由驱动向 media framework 注册的逻辑
ISP 实例。开发板的 media device driver 因此显示为 `rkisp-vir0`。

## 从设备树节点到内核设备

启动阶段可以先用下面这张简化图理解：

```text
内核解析 DTB
  |
  +-- 为 i2c@fe5d0000 创建 platform_device
  |     |
  |     +-- I2C4 controller probe
  |           |
  |           +-- 为 imx415@1a 创建 i2c_client
  |                 |
  |                 +-- compatible 匹配 sony,imx415
  |                       |
  |                       +-- 调用 imx415_probe()
  |
  +-- 为 csi2-dphy-hw@fe870000 创建 platform_device
  +-- 为 csi2-dphy0 创建 platform_device
  +-- 为 rkisp@fdff0000 创建 platform_device
  +-- 为 rkisp-vir0 创建 platform_device
```

这些设备的 probe 顺序不需要与图中完全一致。V4L2 async notifier 会等待 Sensor、D-PHY和 ISP subdev 都准备好，再按照 endpoint 关系完成绑定。

## 源码、live device tree 与 media graph 的对应关系

| DTS 中的对象 | Linux 运行时对象 | Media Controller 对象 |
| --- | --- | --- |
| `i2c@fe5d0000/imx415@1a` | I2C client `4-001a-1` | `m00_b_imx415 4-001a-1` |
| `csi2-dphy0` | platform device `csi2-dphy0` | `rockchip-csi2-dphy0` |
| `rkisp@fdff0000` | platform device `fdff0000.rkisp` | ISP hardware 的后端资源 |
| `rkisp-vir0` | platform device `rkisp-vir0` | media device `rkisp0` |
| RKISP CSI 接收部分 | RKISP 内部 subdev | `rkisp-csi-subdev` |
| RKISP ISP 处理部分 | RKISP 内部 subdev | `rkisp-isp-subdev` |
| mainpath | video device | `/dev/video0` / `rkisp_mainpath` |

当前板端实际生成的 enabled 数据 link 是：

```text
m00_b_imx415 4-001a-1 (/dev/v4l-subdev3)
  -> rockchip-csi2-dphy0 (/dev/v4l-subdev2)
  -> rkisp-csi-subdev (/dev/v4l-subdev1)
  -> rkisp-isp-subdev (/dev/v4l-subdev0)
  -> rkisp_mainpath (/dev/video0)
```

设备树中只有 `IMX415 -> D-PHY -> rkisp_vir0` 的外部硬件连接。`rkisp-csi-subdev`、`rkisp-isp-subdev` 和 `rkisp_mainpath` 是 RKISP 驱动内部注册出来的 entity，所以不需要在板级 DTS 中逐个定义。

## 开发板上验证

```bash
tr '\0' '\n' </proc/device-tree/model
tr '\0' '\n' </proc/device-tree/compatible

tr '\0' '\n' </proc/device-tree/i2c@fe5d0000/imx415@1a/compatible
tr '\0' '\n' </proc/device-tree/i2c@fe5d0000/imx415@1a/status

od -An -tx1 /proc/device-tree/i2c@fe5d0000/imx415@1a/reg
od -An -tx1 \
  /proc/device-tree/i2c@fe5d0000/imx415@1a/port/endpoint/data-lanes
```

得到以下的内容
```bash
root@ATK-DLRK3568:/# tr '\0' '\n' </proc/device-tree/model
tr '\0' '\n' </proc/device-tree/compatible

tr '\0' '\n' </proc/device-tree/i2c@fe5d0000/imx415@1a/compatible
tr '\0' '\n' </proc/device-tree/i2c@fe5d0000/imx415@1a/status

od -An -tx1 /proc/device-tree/i2c@fe5d0000/imx415@1a/reg
od -An -tx1 \
  /proc/device-tree/i2c@fe5d0000/imx415@1a/port/endpoint/data-lanes
Rockchip RK3568 ATK EVB1 DDR4 V10 Board
rockchip,rk3568-evb1-ddr4-v10
rockchip,rk3568
sony,imx415
okay
 00 00 00 1a
 00 00 00 01 00 00 00 02 00 00 00 03 00 00 00 04
```

设备树中的 cell 使用 big-endian 编码，所以 `reg` 的原始字节是 `00 00 00 1a`，表示 I2C 地址为 0x1a。

不要直接用 `cat` 打印 `reg`、GPIO phandle 或 `data-lanes`，它们是二进制 cell，不是文本。

### 确认设备和驱动绑定


```bash
cat /sys/bus/i2c/devices/4-001a-1/name
readlink -f /sys/bus/i2c/devices/4-001a-1/of_node
readlink -f /sys/bus/i2c/devices/4-001a-1/driver

readlink -f /sys/bus/platform/devices/fdff0000.rkisp/driver
readlink -f /sys/bus/platform/devices/fdff0000.rkisp/iommu_group

dmesg | grep -iE 'imx415|csi2-dphy|rkisp|dummy regulator|sleep pinstate'
```

得到
```bash
root@ATK-DLRK3568:/# cat /sys/bus/i2c/devices/4-001a-1/name
readlink -f /sys/bus/i2c/devices/4-001a-1/of_node
readlink -f /sys/bus/i2c/devices/4-001a-1/driver

readlink -f /sys/bus/platform/devices/fdff0000.rkisp/driver
readlink -f /sys/bus/platform/devices/fdff0000.rkisp/iommu_group
imx415
/sys/firmware/devicetree/base/i2c@fe5d0000/imx415@1a
/sys/bus/i2c/drivers/imx415
/sys/bus/platform/drivers/rkisp_hw
/sys/kernel/iommu_groups/7
```













