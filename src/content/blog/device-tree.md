---
  title: '设备树基础：从 DTS 到驱动匹配'
  description: '介绍整理有关设备树的内容。'
  pubDate: 'Jun 29 2026'
  heroImage: '../../assets/blog-placeholder-4.jpg'
---

## 设备树

设备树，Device Tree, DT，本质上是描述硬件组成和连接关系的数据，它可以告诉操作系统，当前的板子上有哪些设备，这些设备分别挂载在哪条总线上，设备地址是什么，使用哪些中断、时钟、GPIO、电源，设备之间如何连接的，设备的状态。是一种高效的描述嵌入式系统的组件与架构的方法，具备标准化，可复用的特点。设备树本身只负责描述硬件，本身不会执行具体的处理，如初始化等等。

## 为什么需要设备树？

### 很多嵌入式设备没法被自动发现

PCIe、USB设备通常能够被系统自动枚举，例如PCIe设备内部有Vendor ID、Device ID，Linux可以扫描PCI总线，发现：
- 是否存在设备
- 厂商ID是多少
- 设备ID是多少
- BAR地址是多少

但很多嵌入式接口不具备这种自发现的能力，例如I2C、SPI、GPIO、I2S、MIPI CSI-2等等，例如Linux只能知道SoC上存在着一条I2C总线，但没法通过扫描来确定以下的信息：
- 0x1a地址对应什么硬件？
- 假如是camera sensor，具体又是什么类型的，是OV2311还是IMX390？
- 复位引脚对应哪个GPIO？
- Sensor使用什么时钟？

这些信息必须有BSP工程师明确告诉内核 ，具体实现途径就是设备树。

### 将硬件差异与驱动代码分离

假设同一颗SoC用在不同的三个板子上，
- 开发板A：IMX219 Camera，连接 CSI0
- 开发板B：IMX390Camera，连接 CSI1
- 车载板C：4路GMSLCamera，连接CSI0和CSI0 和 CSI2

如果没有设备树描述，那么驱动代码中可能会变成以下的形式：
```c
if (board_a) {
    reset_gpio = 12;
    i2c_addr = 0x10;
} else if (board_b) {
    reset_gpio = 35;
    i2c_addr = 0x1a;
}
```

这种方式在板子变多之后简直是一种灾难，且难以维护。而使用设备树之后，驱动具体负责如何控制具体的Sensor，而设备树则描述具体的板子上如何连接，因此同一个驱动可以复用在不同的板子上。

### 同一个内核支持多种硬件

可以使用同一个内核，配合不同的设备树（编译完善的DTB文件）来支持不同板型。内核代码一致，只需要更换描述硬件的DTB文件即可。

## 设备树常见平台

设备树最常见于：
- ARM / ARM64 嵌入式 Linux
- RISC-V Linux
- Android 底层 Linux
- 汽车 SoC
- 工业控制 SoC
- 等等

典型平台包括：
- NXP i.MX
- TI Jacinto / TDA4
- NVIDIA Jetson
- Qualcomm Snapdragon
- Rockchip RK3568 / RK3588

## 设备树是如何工作的

### 设备树文件形式

1. .dts
Device Tree Source，板级设备树源文件，通常用于描述具体的板子
2. .dtsi
Device Tree Source Include，共享设备树文件，通常用于描述SoC公共资源，由.dts include
3. .dtb
Device Tree Blob，编译后的二进制设备树，使用设备树编译器 dtc

```shell
dtc -I dts -O dtb vehicle-camera-board.dts \
    -o vehicle-camera-board.dtb
```

Linux 内核启动时使用的是 .dtb，不是原始 .dts 文本

### 设备树基本语法

用一个最简单的 I²C Camera Sensor节点
```dts
&i2c2 {
    status = "okay";

    camera@1a {
        compatible = "sony,imx390";
        reg = <0x1a>;

        clocks = <&cam_clk>;
        clock-names = "xclk";

        reset-gpios = <&gpio3 5 GPIO_ACTIVE_LOW>;

        avdd-supply = <&cam_2v8>;
        dvdd-supply = <&cam_1v2>;
        dovdd-supply = <&cam_1v8>;

        port {
            camera_out: endpoint {
                data-lanes = <1 2 3 4>;
                remote-endpoint = <&csi0_in>;
            };
        };
    };
};
```

&i2c2 表示引用 SoC 公共设备树中已经定义的 i2c2 控制器。SoC 的 .dtsi 中可能已经存在：
```dts
i2c2: i2c@30a40000 {
    compatible = "vendor,soc-i2c";
    reg = <0x30a40000 0x10000>;
    interrupts = <45>;
    status = "disabled";
};
```

板级文件通过以下方式启动：
```dts
&i2c2 {
    status = "okay";
};
```

节点名称一般由“设备类型@地址”组成。camera@1a 表示节点名称为camera，i2c的地址为0x1a。
compatible是最重要的属性之一，用于让设备和驱动匹配。驱动中通常会有：
```c
static const struct of_device_id imx390_of_match[] = {
    { .compatible = "sony,imx390" },
    { }
};
MODULE_DEVICE_TABLE(of, imx390_of_match);
```

设备树中是：
```dts
compatible = "sony,imx390";
```

两者相同，内核就知道应当让 IMX390 驱动管理这个设备。

reg 在 I²C 子节点中通常表示 I²C 从设备地址，reg 的含义取决于父总线。例如：
- I²C 子节点：I²C 地址
- SPI 子节点：Chip Select 编号
- MMIO 外设：寄存器物理地址和长度

reset-gpios 
```dts
reset-gpios = <&gpio3 5 GPIO_ACTIVE_LOW>;
```
表示GPIO 控制器为gpio3，引脚编号为5，低电平有效。

后面的*-supply、port、endpoint等分别是电源、描述多媒体之间连接关系等，具体可以由读者自行深入理解。

### 设备树具体是如何工作的

首先是整体流程：
```text
编写 DTS/DTSI
        ↓
dtc 编译为 DTB
        ↓
Bootloader 加载 Kernel 和 DTB
        ↓
Bootloader 把 DTB 地址传给 Linux
        ↓
Linux 解析设备树
        ↓
根据节点创建对应设备
        ↓
根据 compatible 匹配驱动
        ↓
调用驱动 probe()
        ↓
驱动读取 GPIO、时钟、电源、中断等属性
        ↓
完成硬件初始化
```

从bootloader出发，以uboot为例，可能执行
```bash
load mmc 0:1 ${kernel_addr_r} Image
load mmc 0:1 ${fdt_addr_r} vehicle-camera-board.dtb

booti ${kernel_addr_r} - ${fdt_addr_r}
```
这里将内核镜像地址和DTB地址，传递给linux内核，linux在启动早期解析 DTB，将扁平二进制结构转换成内核中的设备树节点对象。根据先前描述的compatible字段匹配，匹配成功调用probe函数，probe中可能执行读取资源，设置引脚，启用时钟等操作。

## 简单总结
设备树不是驱动，也不是程序，而是一份由 Bootloader 交给 Linux 的硬件描述数据。后续会继续深入v4l2框架下的camera驱动学习。


