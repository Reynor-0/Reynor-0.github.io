---
title: '车载以太网（二）：MDIO 与 Clause 22/45'
description: '理解 MDC/MDIO 管理总线、Clause 22 与 Clause 45 寄存器访问，并结合 AURIX GETH 梳理 PHY 管理路径。'
series: { id: 'vehicle-ethernet', order: 2 }
tags: ['Ethernet', 'MDIO', 'Clause 22', 'Clause 45', 'PHY']
pubDate: 'Jun 08 2026'
updatedDate: 'Aug 05 2026'
---

这一篇聚焦车载以太网 PHY 的管理通路：CPU 如何通过 MDC/MDIO 访问 PHY，以及 Clause 22、Clause 45 和间接访问之间是什么关系。

## Clause 22和Clause 45

- Clause 22 定义传统MII管理接口，包括MDC/MDIO 总线及基本管理帧格式
- Clause 45 是对MDIO管理机制的扩展，重点是增加寄存器地址空间，并将PHY内部不同模块划分为多个MMD

他们管理的是PHY的寄存器，不负责传输正常的Ethernet数据帧。MAC和PHY的连接可以分为以下两类：
```
数据通路：
MAC ←→ MII / RMII / RGMII / SGMII ←→ PHY

管理通路：
MAC/SoC ←→ MDC + MDIO ←→ PHY 寄存器
```

MDC是管理时钟，通常由MAC、SoC或者专用的MDIO控制器提供；MDIO是双向的管理数据线，空闲时由上拉电阻保持为逻辑1.负责发起访问的一段称为STA， Station Management Entity。

***

### **Clause 22**

Clause 22的访问目标可以表示为：
```
PHY 地址 + 寄存器地址
更具体一点：
PHYAD: 5 bit
REGAD: 5 bit
DATA:  16 bit
```

因此一个MDIO控制理论上可以管理：
```
32个PHY x 每个PHY32个直接寄存器 x 每个寄存器16bit
结构为：

MDIO 总线
├── PHY 地址 0
│   ├── 寄存器 0
│   ├── 寄存器 1
│   └── ...
│       寄存器 31
├── PHY 地址 1
│   └── ...
└── PHY 地址 31

```

PHY 地址一般由芯片的 Strap 引脚、电阻上下拉或软件配置决定。例如某个 PHY 的 Strap 地址是 3，那么访问它时：PHYAD = 00011。

常见的 Clause 22寄存器：

|     地址 | 常见名称                    | 作用                 |
| -----: | ----------------------- | ------------------ |
| `0x00` | BMCR                    | 基本控制、复位、速率、双工、自协商  |
| `0x01` | BMSR                    | Link 状态、能力、自协商完成状态 |
| `0x02` | PHYID1                  | PHY 厂商及型号标识的一部分    |
| `0x03` | PHYID2                  | PHY 厂商、型号、版本标识     |
| `0x04` | ANAR                    | 本端自协商广播能力          |
| `0x05` | ANLPAR                  | 对端自协商能力            |
| `0x09` | 1000BASE-T Control      | 千兆主从及广播能力          |
| `0x0A` | 1000BASE-T Status       | 千兆主从及协商状态          |
| `0x0D` | MMD Access Control      | Clause 45 间接访问控制   |
| `0x0E` | MMD Access Address/Data | Clause 45 地址或数据窗口  |


***

**Clause 22 帧格式**

Clause 22 读写帧结构如下：
```
| PRE | ST | OP | PHYAD | REGAD | TA | DATA |
| 32b | 2b | 2b |  5b   |  5b   | 2b | 16b  |
```

完整表示结构：
```
Clause 22 Read：

PRE             ST  OP  PHYAD  REGAD  TA  DATA
111...111       01  10  AAAAA  RRRRR  Z0  DDDD...DDDD
<---32 bit--->                          <--16 bit-->


Clause 22 Write：

PRE             ST  OP  PHYAD  REGAD  TA  DATA
111...111       01  01  AAAAA  RRRRR  10  DDDD...DDDD
```

这里简要介绍一下各个字段的含义：

**PRE：Preamble**

32 个连续的 1，作用是让 PHY 与 MDC/MDIO 管理事务建立同步。

**ST：Start of Frame**

固定为 01，而Clause 45则使用 00。因此PHY 可以通过 ST 判断后续是 Clause 22 还是 Clause 45 格式。

**OP：操作类型**

Clause 22 只有两个主要操作：
```
OP = 01：Write
OP = 10：Read
```

**PHYAD**

PHY 地址，用于直接选择目标 PHY 中的某个 16-bit 寄存器。

**TA：Turnaround**

TA 用于完成 MDIO 数据线控制权切换。写操作时，STA 始终驱动 MDIO，TA=10。读操作时，需要把 MDIO 控制权从 STA 交给 PHY，TA = Z0。

**DATA**

每个寄存器是 16 bit，并且从最高位开始传输。


### **Clause 45**

现代 PHY 内部不再只是简单的 32 个寄存器，而是可能包含多个相对独立的功能模块：

```
PHY
├── PMA/PMD
├── PCS
├── PHY XS
├── Auto-Negotiation
├── FEC
├── EEE
├── 时间戳
├── 诊断模块
└── 厂商私有模块
```

Clause 45 把这些可管理功能模块称为 MMD, MDIO Manageable Device。这里要搞清楚MMD是PHY内部的逻辑功能模块。所以Clause 45的完整地址模型就是：
```
PRTAD + DEVAD + 16 bit REGAD
```

也就是选择哪一颗PHY，然后选择PHY内部的哪一个MMD，接着选择MMD中的哪一个寄存器。

IEEE Clause 45 将物理端口地址称为 PRTAD，其实际作用与 Clause 22 的 PHYAD 类似；DEVAD 则选择 PHY 内部的 MMD。
常见 DEVAD 示例包括：
```
DEVAD 1  ：PMA/PMD
DEVAD 3  ：PCS
DEVAD 7  ：Auto-Negotiation
DEVAD 30 ：Vendor Specific MMD
DEVAD 31 ：Vendor Specific MMD
```

***

**Clause 45 帧格式**

Clause 45 的单个管理帧仍然保持类似的 32-bit 核心结构：
```
Address：

PRE             ST  OP  PRTAD  DEVAD  TA  REGISTER ADDRESS
111...111       00  00  PPPPP  EEEEE  10  AAAAAAAAAAAAAAAA


Write：

PRE             ST  OP  PRTAD  DEVAD  TA  WRITE DATA
111...111       00  01  PPPPP  EEEEE  10  DDDDDDDDDDDDDDDD


Read-Increment：

PRE             ST  OP  PRTAD  DEVAD  TA  READ DATA
111...111       00  10  PPPPP  EEEEE  Z0  DDDDDDDDDDDDDDDD


Read：

PRE             ST  OP  PRTAD  DEVAD  TA  READ DATA
111...111       00  11  PPPPP  EEEEE  Z0  DDDDDDDDDDDDDDDD
```
Clause 45 的 OP 定义为：
| OP   | 操作                       |
| ---- | ------------------------ |
| `00` | Address，设置寄存器地址指针        |
| `01` | Write，写入数据               |
| `10` | Read Increment，读取后地址自动加一 |
| `11` | Read，读取当前地址的数据           |

Clause 22 中原来的 REGAD 位置，在 Clause 45 中变成了 DEVAD。真正的 16-bit 寄存器地址需要通过一个单独的 Address 帧发送。

**什么 Clause 45 一次访问通常需要两个帧**

Clause 45 把“指定寄存器地址”和“传输数据”拆成了两个阶段。假设读取
```
PRTAD = 3 DEVAD = 1 Register = 0x0834
```

首先要告诉PHY，我要访问 PHY 3 中，DEVAD 1 的 0x0834 寄存器。
就构建了以下内容的数据：
```
ST      = 00
OP      = 00
PRTAD   = 00011
DEVAD   = 00001
TA      = 10
ADDRESS = 0000 1000 0011 0100
```

发送后，PHY 内部相应 MMD 的地址指针变成：0x0834。这就是指定寄存器地址阶段。

随后再发一个读帧：
```
ST      = 00
OP      = 11
PRTAD   = 00011
DEVAD   = 00001
TA      = Z0
DATA    = PHY 返回 0x0834 寄存器内容
```

***

### Clause 22 如何间接访问 Clause 45 寄存器

有时会出现：PHY 支持 Clause 45 寄存器空间, 但 SoC 的 MDIO 控制器只支持 Clause 22 帧格式。
为了解决这个兼容问题，Clause 22 使用两个寄存器作为 Clause 45 的“访问窗口”：

```
Clause 22 Register 13 / 0x0D：
MMD Access Control Register

Clause 22 Register 14 / 0x0E：
MMD Access Address/Data Register
```

它不是发送原生 Clause 45 帧，而是连续发送多个 Clause 22 帧，通过寄存器 13、14 间接操作 MMD 地址空间。

**Register 13 的结构**

```
15          14 13                     5 4                 0
+--------------+-----------------------+-------------------+
| Function 2b  | Reserved              | DEVAD 5b          |
+--------------+-----------------------+-------------------+
```

| Function | 含义                     |
| -------- | ---------------------- |
| `00`     | Register 14 表示目标寄存器地址  |
| `01`     | Register 14 表示数据，不自动递增 |
| `10`     | 数据模式，读写后地址自动递增         |
| `11`     | 数据模式，仅写入后地址自动递增        |


假设读取：
```
PHYAD = 3
DEVAD = 7
MMD Register = 0x003C
```
需要进行四次 Clause 22 操作。

**第一步：选择 Address 模式和 DEVAD**
写 Clause 22 寄存器 13：Function = 00, DEVAD = 7。
```c
mdio_c22_write(3, 0x0D, 0x0007);
```

**第二步：写入目标 MMD 寄存器地址**
写 Clause 22 寄存器 14：
```c
mdio_c22_write(3, 0x0E, 0x003C);
```

至此 PHY 知道目标是DEVAD 7，Register 0x003C

**第三步：切换到 Data 模式**
Register 13 的 Function 改为：
```
01：Data，无地址递增
```

```c
mdio_c22_write(3, 0x0D, 0x4007);
```
其中0x4007由0x4000 | 0x0007组成。分别表示01数据模式 和第七个MMD。

**第四步：从 Register 14 读取数据**
```c
uint16_t value = mdio_c22_read(3, 0x0E);
```

此时读到的不是 Clause 22 寄存器 14 自身的普通配置，而是MMD 7，Register 0x003C 的数据。

**总结**

完整过程为
```c
uint16_t mdio_c22_read_mmd(uint8_t phy,
                           uint8_t devad,
                           uint16_t reg)
{
    mdio_c22_write(phy, 0x0D, devad);          // Address 模式
    mdio_c22_write(phy, 0x0E, reg);            // 设置 MMD 地址
    mdio_c22_write(phy, 0x0D, 0x4000 | devad); // Data 模式
    return mdio_c22_read(phy, 0x0E);            // 读取 MMD 数据
}
```

## 项目代码实证：在 AURIX TC3xx GETH 上 MDIO 是怎么收发的

前面讲了 Clause 22 / Clause 45 的帧格式、字段含义、以及 Clause 22 通过寄存器 13/14 间接访问 Clause 45 的过程。这些都是协议层抽象。下面看在量产代码里，MDIO 帧是怎么真正通过 MAC 控制器的寄存器发到 PHY 的。本节以一个基于 Infineon AURIX TC3xx GETH 硬件 MDIO 控制器的车载 MCU 平台为例，所有代码用伪代码形式呈现，重点在讲清楚寄存器位字段和协议字段的映射关系。

### AURIX GETH 的 MDIO 控制器：两个寄存器搞定一切

AURIX TC3xx 的 GETH（Gigabit Ethernet MAC）内置了一个硬件 MDIO 控制器，软件不需要用 GPIO bit-banging 模拟 MDC/MDIO 时序，只要写两个 32-bit 寄存器：

| 寄存器 | 作用 |
|---|---|
| `MAC_MDIO_ADDRESS` | 配置本次访问：PHY 地址、寄存器/设备地址、操作码、Clause 22/45 选择、启动位 |
| `MAC_MDIO_DATA` | 存放 16-bit 数据（写时由软件填，读时由硬件回填）；Clause 45 时还存放 16-bit 寄存器地址 |

这两个寄存器的位字段在 Infineon iLLD 头文件 `IfxGeth_bf.h` 里完整定义：


```c
/* AURIX GETH MAC_MDIO_ADDRESS 寄存器位布局（32 bit） */
#define IFX_GETH_MAC_MDIO_ADDRESS_GB_OFF     (0u)   /* bit 0     MII Busy，写 1 启动一次访问 */
#define IFX_GETH_MAC_MDIO_ADDRESS_C45E_OFF   (1u)   /* bit 1     Clause 45 Enable: 0=C22, 1=C45 */
#define IFX_GETH_MAC_MDIO_ADDRESS_GOC_0_OFF  (2u)   /* bit 2     GOC 低位（OP 字段 bit 0） */
#define IFX_GETH_MAC_MDIO_ADDRESS_GOC_1_OFF  (3u)   /* bit 3     GOC 高位（OP 字段 bit 1） */
#define IFX_GETH_MAC_MDIO_ADDRESS_SKAP_OFF   (4u)   /* bit 4     Skip Address Packet（C45 地址帧跳过） */
#define IFX_GETH_MAC_MDIO_ADDRESS_CR_OFF     (8u)   /* bit 11:8  Clock Range，MDC 分频系数 */
#define IFX_GETH_MAC_MDIO_ADDRESS_NTC_OFF    (12u)  /* bit 14:12 Number of Tracking Clocks */
#define IFX_GETH_MAC_MDIO_ADDRESS_RDA_OFF    (16u)  /* bit 20:16 Register/Device Address（5 bit） */
#define IFX_GETH_MAC_MDIO_ADDRESS_PA_OFF     (21u)  /* bit 25:21 PHY Address（5 bit） */
```


**对照协议字段：**

| 协议字段 | AURIX 寄存器字段 | 位偏移 | 位宽 |
|---|---|---|---|
| ST (Start of Frame) | `C45E` + `GOC` 隐式表达 | bit 1, bit 3:2 | 1+2 |
| OP (Operation) | `GOC[1:0]` | bit 3:2 | 2 |
| PHYAD / PRTAD | `PA` | bit 25:21 | 5 |
| REGAD / DEVAD | `RDA` | bit 20:16 | 5 |
| TA (Turnaround) | 硬件自动处理 | - | - |
| DATA | `MAC_MDIO_DATA`（另一个寄存器） | bit 15:0 | 16 |
| 寄存器地址（C45 only，16 bit） | `MAC_MDIO_DATA.B.RA` | bit 15:0 | 16 |
| 启动位 | `GB` (MII Busy) | bit 0 | 1 |

注意一个关键点：**协议里的 ST 字段在硬件寄存器里没有直接对应位**。AURIX 用 `C45E` 位（Clause 45 Enable）替代——`C45E=0` 走 clause 22 帧格式（ST=01），`C45E=1` 走 clause 45 帧格式（ST=00）。PHY 通过 ST 判断后续帧格式，硬件层帮软件处理了 ST 字段的生成。


### SMI 总线驱动伪代码

PHY 驱动和 AURIX GETH 硬件之间通过一个 SMI 总线驱动层衔接。下面用伪代码呈现关键逻辑：

```c
/* 伪代码：SMI 总线驱动关键宏 */
#define SMI_OP_TIMEOUT_US   (50000)                          /* 50 ms 超时 */
#define SMI_OP_DELAY_US     (5)                              /* 5 us 轮询间隔 */
#define PHY_ADDR_MASK(addr) ((uint32_t)(addr) & 0x1FU)      /* 5-bit PHY 地址掩码 */
#define DATA_MASK(data)     ((uint32_t)(data) & 0xFFFFU)     /* 16-bit 数据掩码 */
#define DEV_VALUE(reg)      (((uint32_t)(reg) >> 16) & 0x1FU) /* 从 21-bit 地址里取高 5 bit = DEVAD */
```

`DEV_VALUE(reg)` 这行很关键——它揭示了 clause 45 调用方传进来的 `regaddr` 参数其实是 21 bit 的：高 5 bit 是 DEVAD（Device Address，对应 MMD 编号），低 16 bit 是 MMD 内的寄存器地址。这是把"DEVAD + REGAD"打包到一个 uint32 里的设计，软件层不用单独传 DEVAD。


**等 busy 位清零（伪代码）：**

```c
/* 伪代码：写完 MAC_MDIO_ADDRESS 后等硬件操作完成 */
static bool wait_mdio_free(mdio_controller_t *hw)
{
    uint16_t timeout_cnt = 0;
    /* 轮询 GB (MII Busy) 位，等硬件清零表示操作完成 */
    while ((hw->MAC_MDIO_ADDRESS & GB_MSK) == 1
            && (timeout_cnt < (SMI_OP_TIMEOUT_US / SMI_OP_DELAY_US))) {
        timeout_cnt++;
        delay_us(SMI_OP_DELAY_US);   /* 5 us 一次 */
    }
    /* 最长等 50 ms / 5 us = 10000 次 */
    return (timeout_cnt < (SMI_OP_TIMEOUT_US / SMI_OP_DELAY_US));
}
```

写完 `MAC_MDIO_ADDRESS` 后，硬件把 GB 位置 1，开始发 MDIO 帧；操作完成后硬件自动清 GB。软件忙等 GB 清零（最长 50 ms 超时），这是无中断的简单实现，适合 MDIO 操作不频繁的场景。


SMI 总线是共享资源（一条 MDC/MDIO 总线挂多个 PHY），多核调用必须互斥：

```c
/* 伪代码：互斥锁保护 */
static mutex_t g_mdio_bus_lock[BUS_NUMBER];

static bool mdio_bus_lock(uint8_t bus_id) {
    return mutex_take(g_mdio_bus_lock[bus_id], MAX_DELAY) == OS_OK;
}

static void mdio_bus_unlock(uint8_t bus_id) {
    mutex_give(g_mdio_bus_lock[bus_id]);
}
```


### smi_read：clause 22 读

```c
/* 伪代码：clause 22 读 */
status_t mdio_read(uint8_t bus_id, uint32_t phyaddr, uint32_t regaddr,
                   uint16_t *regval, mdio_mode_t mode)
{
    mdio_controller_t *hw = get_hw(bus_id);
    if (hw == NULL || regval == NULL) {
        return ERR;
    }
    if (!mdio_bus_lock(bus_id)) {
        return ERR;
    }

    if (mode == CLAUSE_45) {
        /* Clause 45 路径，下面单独讲 */
        ...
    } else {
        /* ↓↓↓ Clause 22 读：组装 MAC_MDIO_ADDRESS 寄存器 ↓↓↓ */
        hw->MAC_MDIO_ADDRESS =
            (PHY_ADDR_MASK(phyaddr) << PA_OFF)  |   /* PA = phyaddr (5 bit) */
            (PHY_ADDR_MASK(regaddr) << RDA_OFF) |   /* RDA = regaddr (5 bit) */
            (0 << CR_OFF)  |                        /* CR = 0（MDC 时钟分频，0 表示最高速） */
            (2 << GOC_0_OFF) |                      /* GOC = 10 = Read (C22 OP=10) */
            (1 << GB_OFF);                          /* GB = 1，启动 */
        /* 注意 C45E 位没写，默认 0 → 走 clause 22 */
    }

    if (!wait_mdio_free(hw)) {                       /* 等 GB 清零 */
        mdio_bus_unlock(bus_id);
        return ERR;
    }

    /* 读回 MAC_MDIO_DATA 寄存器的低 16 位 */
    *regval = hw->MAC_MDIO_DATA & 0xFFFF;
    mdio_bus_unlock(bus_id);
    return OK;
}
```


**逐字段对照标准协议里 Clause 22 Read 帧格式：**

```
协议里：    PRE  ST  OP  PHYAD  REGAD  TA  DATA
                  01  10  AAAAA  RRRRR  Z0  DDDD...DDDD

代码里：                       PA        RDA       (硬件处理)  MAC_MDIO_DATA
                  (C45E=0) 10  phyaddr  regaddr             读回 16 bit
```

| 协议字段 | 协议值（C22 Read） | 代码值 | 代码字段 |
|---|---|---|---|
| ST | 01 | C45E=0（隐式 ST=01） | 不写，默认 0 |
| OP | 10 (Read) | GOC=2 (binary 10) | `(2 << GOC_0_OFF)` |
| PHYAD | 5 bit | `PHY_ADDR_MASK(phyaddr)` | `<< PA_OFF` |
| REGAD | 5 bit | `PHY_ADDR_MASK(regaddr)` | `<< RDA_OFF` |
| TA | Z0 (高阻 + 0) | 硬件自动 | - |
| DATA | 16 bit | 硬件回填到 `MAC_MDIO_DATA` | `*regval = MAC_MDIO_DATA & 0xFFFF` |
| - | - | GB=1（启动） | `(1 << GB_OFF)` |

注意 `(2 << GOC_0_OFF)` 这一行——`GOC_0_OFF = 2`，所以 `2 << 2 = 0b1000`，即 bit 3 = 1, bit 2 = 0，对应 GOC 字段 = `10`，正好是 clause 22 Read 的 OP 值。

### smi_write：clause 22 写

```c
/* 伪代码：clause 22 写 */
status_t mdio_write(uint8_t bus_id, uint32_t phyaddr, uint32_t regaddr,
                    uint32_t regval, mdio_mode_t mode)
{
    mdio_controller_t *hw = get_hw(bus_id);
    if (hw == NULL) {
        return ERR;
    }
    if (!mdio_bus_lock(bus_id)) {
        return ERR;
    }
    uint32_t data = DATA_MASK(regval);   /* 16-bit 数据 */

    if (mode == CLAUSE_45) {
        /* Clause 45 路径，下面单独讲 */
        ...
    } else {
        /* ↓↓↓ Clause 22 写 ↓↓↓ */
        /* Step 1：先把 16-bit 数据放到 MAC_MDIO_DATA 寄存器 */
        hw->MAC_MDIO_DATA = data;

        /* Step 2：组装 MAC_MDIO_ADDRESS，GOC = 01 = Write，启动 */
        hw->MAC_MDIO_ADDRESS =
            (PHY_ADDR_MASK(phyaddr) << PA_OFF)  |
            (PHY_ADDR_MASK(regaddr) << RDA_OFF) |
            (0 << CR_OFF)  |
            (1 << GOC_0_OFF) |                    /* GOC = 01 = Write (C22 OP=01) */
            (1 << GB_OFF);
    }

    if (!wait_mdio_free(hw)) {
        mdio_bus_unlock(bus_id);
        return ERR;
    }
    mdio_bus_unlock(bus_id);
    return OK;
}
```

**和 Read 的区别：**

| 区别点 | Read | Write |
|---|---|---|
| GOC 字段 | `2 << GOC_0_OFF` (=10) | `1 << GOC_0_OFF` (=01) |
| MAC_MDIO_DATA | 操作完成后读（硬件回填） | 操作开始前写（软件填） |
| TA 字段 | Z0（PHY 驱动） | 10（STA 驱动，硬件处理） |

### smi_read：clause 45 读

```c
/* 伪代码：clause 45 读（在 mdio_read 函数的 CLAUSE_45 分支里） */
if (mode == CLAUSE_45) {
    /* Step 1：把 16-bit 寄存器地址放到 MAC_MDIO_DATA 的 RA 字段
     * DATA_MASK(regaddr) = regaddr & 0xFFFF，取 21-bit regaddr 的低 16 bit
     * 这是 MMD 内部的 16-bit 寄存器地址 */
    hw->MAC_MDIO_DATA_RA = DATA_MASK(regaddr);

    /* Step 2：组装 MAC_MDIO_ADDRESS */
    hw->MAC_MDIO_ADDRESS =
        (PHY_ADDR_MASK(phyaddr) << PA_OFF)  |     /* PA = PRTAD (5 bit) */
        (DEV_VALUE(regaddr) << RDA_OFF) |          /* RDA = DEVAD (5 bit，从 21-bit regaddr 高 5 bit 取) */
        (0 << CR_OFF)  |
        (3 << GOC_0_OFF) |                          /* GOC = 11 = Read (C45 OP=11) */
        (1 << C45E_OFF) |                           /* C45E = 1，走 clause 45 帧格式 */
        (1 << GB_OFF);                              /* GB = 1，启动 */
}
```

**逐字段对照标准协议里 Clause 45 Read 帧格式：**

```
协议里 Address 帧：  ST  OP  PRTAD  DEVAD  TA  REGISTER ADDRESS
                    00  00  PPPPP  EEEEE  10  AAAAAAAAAAAAAAAA

协议里 Read 帧：     ST  OP  PRTAD  DEVAD  TA  READ DATA
                    00  11  PPPPP  EEEEE  Z0  DDDDDDDDDDDDDDDD
```

代码里只有一次寄存器写入（`GOC=11`，Read），看起来只发了一个 Read 帧，没发 Address 帧。**为什么？**

**关键点：AURIX GETH 硬件 MDIO 控制器把 clause 45 的两帧合并成了一次操作。** 软件只要：
1. 把 16-bit 寄存器地址写到 `MAC_MDIO_DATA` 的 RA 字段
2. 把 PRTAD/DEVAD/GOC=11/C45E=1/GB=1 写到 `MAC_MDIO_ADDRESS`

硬件会自动完成"先发 Address 帧（OP=00，把 RA 字段的 16-bit 地址送给 PHY 的 MMD 地址指针）→ 再发 Read 帧（OP=11，从 MMD 读 16-bit 数据）"两步操作，最后把数据回填到 `MAC_MDIO_DATA`，软件读 `MAC_MDIO_DATA & 0xFFFF` 拿结果。

这就是硬件 MDIO 控制器相对 GPIO bit-banging 的优势——硬件状态机帮你做了两帧的时序协调。

**逐字段对照：**

| 协议字段 | 协议值（C45 Read） | 代码值 | 代码字段 |
|---|---|---|---|
| ST | 00 | C45E=1（隐式 ST=00） | `(1 << C45E_OFF)` |
| OP (Address 帧) | 00 | 硬件自动发 | - |
| OP (Read 帧) | 11 (Read) | GOC=3 (binary 11) | `(3 << GOC_0_OFF)` |
| PRTAD | 5 bit | `PHY_ADDR_MASK(phyaddr)` | `<< PA_OFF` |
| DEVAD | 5 bit | `DEV_VALUE(regaddr)` | `<< RDA_OFF` |
| REGISTER ADDRESS | 16 bit | `DATA_MASK(regaddr)` | `MAC_MDIO_DATA_RA` |
| READ DATA | 16 bit | 硬件回填到 `MAC_MDIO_DATA` | `*regval = MAC_MDIO_DATA & 0xFFFF` |

### smi_write：clause 45 写

```c
/* 伪代码：clause 45 写（在 mdio_write 函数的 CLAUSE_45 分支里） */
if (mode == CLAUSE_45) {
    /* Step 1：MAC_MDIO_DATA 的高 16 位放寄存器地址，低 16 位放数据
     * mdio_data = (regaddr & 0xFFFF) << 16 | (regval & 0xFFFF) */
    mdio_data |= DATA_MASK(regaddr) << 16;
    hw->MAC_MDIO_DATA = mdio_data;

    /* Step 2：组装 MAC_MDIO_ADDRESS，GOC = 01 = Write */
    hw->MAC_MDIO_ADDRESS =
        (PHY_ADDR_MASK(phyaddr) << PA_OFF)  |
        (DEV_VALUE(regaddr) << RDA_OFF) |
        (0 << CR_OFF)  |
        (1 << GOC_0_OFF) |                     /* GOC = 01 = Write (C45 OP=01) */
        (1 << C45E_OFF) |                      /* C45E = 1 */
        (1 << GB_OFF);
}
```

**注意 `MAC_MDIO_DATA` 寄存器的双重用途：**

| 阶段 | `MAC_MDIO_DATA` 高 16 bit | `MAC_MDIO_DATA` 低 16 bit |
|---|---|---|
| clause 45 write 时软件写入 | 16-bit 寄存器地址 | 16-bit 待写数据 |
| clause 45 read 时软件写入 | (未用) | 16-bit 寄存器地址 |
| 硬件完成回填后低 16 bit | (未用) | 16-bit 读取结果 |

代码 `mdio_data |= DATA_MASK(regaddr) << 16` 这一行就是把 16-bit 寄存器地址放到 `MAC_MDIO_DATA` 的高 16 bit，配合低 16 bit 的 `regval`，硬件一次完成"地址帧 + 数据帧"两步写入。

### PHY 寄存器标准定义：以一个通用 PHY 为例


IEEE 802.3 标准定义了 clause 22 的 0~31 号寄存器（公开内容）。下面是 BMCR / BMSR 等标准寄存器的位字段定义，几乎所有 PHY 驱动都遵循这套命名：

```c
/* IEEE 802.3 标准 clause 22 寄存器地址 */
#define MII_BMCR      0x00 /* Basic mode control register */
#define MII_BMSR      0x01 /* Basic mode status register  */
#define MII_PHYSID1   0x02 /* PHYS ID 1                  */
#define MII_PHYSID2   0x03 /* PHYS ID 2                  */
#define MII_ADVERTISE 0x04 /* Advertisement control reg  */
#define MII_LPA       0x05 /* Link partner ability reg   */
#define MII_EXPANSION 0x06 /* Expansion register         */

/* BMCR (Basic Mode Control Register, 0x00) 位字段 */
#define BMCR_RESET       0x8000  /* bit 15: Reset to default state */
#define BMCR_LOOPBACK    0x4000  /* bit 14: TXD loopback bits */
#define BMCR_SPEED100    0x2000  /* bit 13: Select 100Mbps */
#define BMCR_ANENABLE    0x1000  /* bit 12: Enable auto negotiation */
#define BMCR_PDOWN       0x0800  /* bit 11: Enable low power state */
#define BMCR_ISOLATE     0x0400  /* bit 10: Isolate data paths from MII */
#define BMCR_ANRESTART   0x0200  /* bit 9:  Auto negotiation restart */
#define BMCR_FULLDPLX    0x0100  /* bit 8:  Full duplex */
#define BMCR_CTST        0x0080  /* bit 7:  Collision test */
#define BMCR_SPEED1000   0x0040  /* bit 6:  MSB of Speed (1000) */
#define BMCR_SPEED10     0x0000  /*        Select 10Mbps (bit 13=0, bit 6=0) */

/* BMSR (Basic Mode Status Register, 0x01) 位字段 */
#define BMSR_LINK_STATUS 0x0004  /* bit 2: Link Status (latching-low) */
```

### 实例 1：自协商重启（clause 22 写 BMCR）


```c
/* 伪代码：重启自协商 */
static int phy_restart_autonegotiation(phy_device_t *dev, uint8_t phy_idx)
{
    uint16_t val = 0xffff;

    /* Step 1：读 BMCR 当前值 */
    if (mdio_read(dev, phy_idx, MII_BMCR, &val, CLAUSE_22) != OK) {
        log("Failed reading BMCR\n");
        return -1;
    }

    /* Step 2：置上 ANRESTART 和 ANENABLE 位，保留其它位 */
    val |= BMCR_ANRESTART | BMCR_ANENABLE;       /* 0x0200 | 0x1000 = 0x1200 */

    /* Step 3：写回 BMCR */
    if (mdio_write(dev, phy_idx, MII_BMCR, val, CLAUSE_22) != OK) {
        log("Failed to restart auto-negotiation!\n");
        return -1;
    }
    return 0;
}
```


### 实例 2：Link 状态查询（clause 22 读 BMSR）

```c
/* 伪代码：查 link 状态 */
static int phy_get_link_status(phy_device_t *dev, uint8_t phy_idx)
{
    uint16_t reg_val;

    /* 读 BMSR (Basic Mode Status Register, 0x01) */
    if (mdio_read(dev, phy_idx, MII_BMSR, &reg_val, CLAUSE_22) != OK) {
        return -1;   /* 读失败，默认 link down */
    }

    /* BMSR 的 bit 2 = Link Status（实时链路状态） */
    return (reg_val & BMSR_LINK_STATUS) ? 0 : -1;   /* 0=link up, -1=link down */
}
```

`BMSR_LINK_STATUS = 0x0004`，对应 BMSR 寄存器的 bit 2。IEEE 802.3 规定这一位是"Link Status"，1 = link up，0 = link down。


**BMSR 的 latching 行为：**

BMSR 的 bit 2 (Link Status) 是 latching-low 属性——一旦 link down 过，这一位会被锁存为 0，直到被读取后才反映当前实时状态。所以严谨的代码应该连读两次 BMSR：

```c
/* 严谨写法（简化代码会漏掉这个细节）：*/
read(BMSR);              /* 第一次读，清锁存 */
val = read(BMSR);        /* 第二次读，反映实时状态 */
link = val & BMSR_LINK_STATUS;
```

### 实例 3：PHY 完整初始化流程

一个 PHY 从上电到 link up 的完整流程：

```c
/* 伪代码：PHY 完整初始化 */
static int phy_init(phy_device_t *dev, uint8_t phy_idx)
{
    int timeout = 1000;

    /* Step 1：初始配置（reset + 配置 BMCR） */
    if (phy_initial_config(dev, phy_idx) < 0) {
        return -1;
    }

    if (dev->auto_negotiation) {
        /* Step 2：重启自协商 */
        if (phy_restart_autonegotiation(dev, phy_idx) < 0) {
            log("PHY restart auto-negotiation failed!\n");
        }

        /* Step 3：轮询 BMSR 等 link up，最长 1000 次 × 10 ms = 10 秒 */
        while (timeout--) {
            if (phy_get_link_status(dev, phy_idx) >= 0) {
                log("Link successfully\n");
                return 0;
            }
            sleep_ms(10);   /* 每 10 ms 查一次 */
        }
        log("Link failed\n");
    }
    return -1;
}
```


其中 `phy_initial_config` 展示了 BMCR 的完整配置：

```c
/* 伪代码：BMCR 配置 */
static int phy_initial_config(phy_device_t *dev, uint8_t phy_idx)
{
    uint16_t reg_val;

    /* Step 1.1：软件复位 PHY（写 BMCR_RESET，等清零） */
    if (mdio_write(dev, phy_idx, MII_BMCR, BMCR_RESET, CLAUSE_22) != OK) return -1;
    do {
        if (mdio_read(dev, phy_idx, MII_BMCR, &reg_val, CLAUSE_22) != OK) return -1;
        sleep_ms(1);
    } while (reg_val & BMCR_RESET);   /* 等硬件清 reset 位 */

    /* Step 1.2：读 BMCR 当前值 */
    if (mdio_read(dev, phy_idx, MII_BMCR, &reg_val, CLAUSE_22) != OK) return -1;

    /* Step 1.3：配置双工 */
    reg_val |= BMCR_FULLDPLX;                          /* bit 8 = 1，全双工 */

    /* Step 1.4：配置自协商 */
    if (dev->auto_negotiation) {
        reg_val |= BMCR_ANENABLE;                       /* bit 12 = 1 */
    } else {
        reg_val &= ~BMCR_ANENABLE;
    }

    /* Step 1.5：配置速率（10/100/1000）*/
    if (dev->link_speed == LINK_100M) {
        reg_val |= BMCR_SPEED100;                       /* bit 13 = 1 */
        reg_val &= ~BMCR_SPEED1000;                     /* bit 6 = 0 */
    } else if (dev->link_speed == LINK_10M) {
        reg_val &= ~BMCR_SPEED100;                      /* bit 13 = 0 */
        reg_val &= ~BMCR_SPEED1000;                     /* bit 6 = 0 */
    } else {
        /* 1000 Mbps */
        reg_val &= ~BMCR_SPEED100;                      /* bit 13 = 0 */
        reg_val |= BMCR_SPEED1000;                      /* bit 6 = 1 */
    }

    /* Step 1.6：退出 Power Down 状态 */
    reg_val &= ~BMCR_PDOWN;                             /* bit 11 = 0 */

    /* Step 1.7：写回 BMCR */
    if (mdio_write(dev, phy_idx, MII_BMCR, reg_val, CLAUSE_22) != OK) return -1;

    return 0;
}
```


### 三层调用关系总览

把上面的代码串起来，一个典型的车载 MCU 以太网协议栈的 MDIO 调用链是三层结构：

```
应用层 / PHY 驱动
    │
    │ 例：phy_get_link_status(dev, phy_idx)
    │     知道"哪个 PHY 用什么寄存器、什么位字段、什么时序"
    ▼
MDIO 抽象层（msg 结构 + bus_ops 接口）
    │
    │ msg.phyaddr / msg.regaddr / msg.mode / msg.data
    │ bus_ops->read(&bus, &msg, 1)
    │ 屏蔽底层硬件差异（AURIX GETH / Synopsys EQOS / 其他 MAC）
    ▼
SMI 总线驱动（MAC 硬件寄存器层）
    │
    │ mdio_read(bus_id, phyaddr, regaddr, regval, mode)
    │ 写 MAC_MDIO_ADDRESS / MAC_MDIO_DATA 寄存器
    │ 等 GB 位清零
    │ 读 MAC_MDIO_DATA 拿 16-bit 结果
    ▼
MAC 控制器硬件 MDIO 控制器（如 AURIX GETH）
    │
    │ 自动生成 MDC 时钟
    │ 自动按 clause 22/45 帧格式发 MDIO 信号
    │ 自动处理 TA 字段
    │ 自动完成 clause 45 的 Address+Data 两帧
    ▼
PHY 芯片（MDIO 总线上的从设备）
```
