---
title: '车载以太网（三）：100/1000BASE-T1 PHY、Master/Slave 与 SQI'
description: '梳理车载以太网 PHY 的启动与建链流程、Master/Slave 时钟关系、SQI 诊断及其驱动实现。'
category: '协议'
tags: ['Ethernet', '100BASE-T1', '1000BASE-T1', 'PHY', 'SQI']
pubDate: 'Jun 08 2026'
updatedDate: 'Aug 05 2026'
---

车载使用 100/1000BASE-T1，是因为它能在保留标准以太网帧、全双工和交换式点对点通信能力的同时，把传统四对线压缩为单对线，并针对短距离汽车线束、连接器尺寸、重量、成本、EMC 和可靠性进行优化。针对他们之间的电气特性等等这里不做过多研究。

## 车载PHY芯片的启动、初始化流程

首先看看PHY链路是怎么启动的：
```
PHY 上电或复位
      │
      ▼
确定速率、能力和 Master/Slave
      │
      ├── 开启 AN：
      │      Clause 98 Auto-Negotiation
      │
      └── 关闭 AN：
             软件/Strap 强制配置
             + Link Synchronization
      │
      ▼
Link Training
训练接收器、同步时钟和数据结构
      │
      ▼
双方确认接收状态正常
      │
      ▼
从 Training Mode 切换到 Data Mode
      │
      ▼
Link Up，开始收发 MAC 帧
```

这里最容易混淆的是：
```
Auto-Negotiation ≠ Link Training
Link Synchronization ≠ Link Training
```
它们解决的是三个不同问题：
| 阶段                   | 解决的问题                       |
| -------------------- | --------------------------- |
| Auto-Negotiation     | 双方支持什么模式，最终使用哪个模式，谁做 Master |
| Link Synchronization | 不使用 AN 时，让两端确认彼此存在并协调训练起点   |
| Link Training        | 根据真实线缆和信号情况，把接收器训练到可靠工作状态   |

IEEE 1000BASE-T1 的启动控制会在 Auto-Negotiation 或 Link Synchronization 完成之后进入 Training，训练成功后才进入能够交换 MAC 帧的 Data 状态。

***

## Master/Slave

1000BASE-T1 中的 Master/Slave，主要定义的是链路时钟来源和启动训练关系，不是两个 ECU 之间的业务控制关系。它不表示：

```
Master ECU 可以命令 Slave ECU
Master 负责发送，Slave 只能接收
Master 的数据优先级更高
交换机一定是 Master
摄像头一定是 Slave
```

链路建立以后，两端都可以同时发送和接收以太网帧，带宽和通信能力是对等的。

### Master 和 Slave 最核心的区别：时钟从哪里来

1000BASE-T1 是单对线全双工，两端同时在同一对线上发送信号，因此 PHY 的时钟关系不能完全独立，否则会增加接收、回波抵消和符号判决的难度。

**Master PHY**
Master 使用自己的本地参考时钟，决定发送符号的时序：
```
本地晶振/振荡器
       │
       ▼
Master TX Clock
       │
       ▼
Master 在单对线上发送信号
```

**Slave PHY**

Slave 从收到的 Master 信号中恢复时钟，再用恢复出的时钟控制自己的发送：
```
Master 发送信号
       │
       ▼
Slave Clock Recovery
       │
       ▼
恢复出 Master 时钟
       │
       ▼
Slave 使用恢复时钟发送
```
IEEE 对 1000BASE-T1 的定义就是：Master 的发送时钟来自本地时钟源，而 Slave 的发送时钟来自接收信号恢复出的时钟。

***

### 为什么单对线全双工需要这种时钟关系

在单对线上，本端接收到的并不只是对端信号，而是：
```
接收端看到的线路信号 = 对端发送信号 + 本端发送信号的回波 + 线缆反射 + 外部噪声
```

PHY 需要把自己的发送回波从混合信号中消除：
```
线路混合信号 - 预测出的本端回波 = 尽可能恢复对端信号
```

这种机制称为Echo Cancellation，也就是回波抵消。如果双方发送时钟彼此完全独立，两个方向的符号时序会不断漂移，回波抵消、采样和均衡过程就会更加复杂。通过 Master/Slave 的 loop timing：Master 提供时钟基准，Slave 跟随 Master 时钟。

## SQI

SQI, Signal Quality Indicator，信号质量指示值。它不是线上直接传输的字段，也不在 Ethernet Frame 中，而是 PHY 内部 DSP 根据接收信号状态计算出的一个诊断值。OPEN Alliance 的定义允许 PHY 从 MSE（均方误差）或其他可比较的信号质量信息推导 SQI，并将结果划分为 8 个等级。也就是说，SQI 是一个经过量化的质量等级，而不是直接的电压、SNR 或误码率数值。

**Current SQI 和 Worst-case SQI**

一些符合 OPEN Alliance 诊断要求的 PHY 不只提供当前值，还会提供Current SQI 和 Worst-case SQI。例如：
```
时间       SQI
t0          7
t1          7
t2          2    ← 短暂干扰
t3          7
t4          7
```

如果软件只在 t4 读取当前 SQI，可能看到：
```
Current SQI = 7
```
从而错过 t2 的瞬态干扰。

Worst-case 字段则可能记录：
```
Worst-case SQI = 2
```
这对于发现电机切换、逆变器噪声、ESD 或接触不稳定造成的短时信号恶化很有用。OPEN Alliance 的诊断定义要求，在当前 SQI 之外，还保存自上一次寄存器读取以来计算到的最低 SQI。

总结一下，SQI 是 PHY 根据接收信号质量计算出来的一个离散等级。通常由软件通过 MDIO 读取 PHY 寄存器获得。OPEN Alliance 定义的常见形式是 3 bit，因此取值为 0～7，但“多少算好、多少算差”不能脱离具体 PHY 数据手册判断。

## 项目代码实证：Master/Slave 与 SQI 如何落到 PHY 驱动

前面说明了 T1 PHY 的启动流程、Master/Slave 时钟关系和 SQI 等级。下面以一个 1000BASE-T1 车规 PHY 为例，观察这些机制如何通过 MDIO 寄存器访问落到驱动代码中。具体寄存器地址以对应 PHY 的数据手册为准，代码使用伪代码呈现。

### PHY driver 全景

1000BASE-T1 PHY driver 通常包含以下功能模块（按职责分类）：

| 模块 | 职责 |
|---|---|
| MDIO read/write 包装 | 包装 clause 45 访问，屏蔽底层 MAC 控制器差异 |
| PHY ID 检测 | 上电后读 PHY identifier 寄存器，确认硬件版本对得上 |
| Link 状态查询 | 周期性查 link up/down |
| Master/Slave 配置 | 配置 T1 链路的 master/slave 角色 |
| SQI 读取 | 读 Current SQI 和 Worst-case SQI |
| TC10 初始化 | 配置睡眠唤醒信令相关寄存器 |
| Set sleep / Set wakeup | 主动进入睡眠 / 唤醒对端 |
| Control 命令分发 | 上层调 control(dev, cmd, data)，分发到 SQI/Link/Reset 等具体操作 |
| SQI 监控状态机 | 三阶段定时器，周期性监控 SQI，持续差触发 PHY 复位 |



### PHY ID 检测：上电后先确认是哪颗 PHY

PHY 上电后第一件事不是配置寄存器，而是读 PHY ID 确认硬件版本对得上。1000BASE-T1 PHY 的 PHY ID 在 PMA/PMD（DEVAD=1）的寄存器 0x0002：

```c
/* 伪代码：PHY ID 检测 */
status_t phy_power_sequence(phy_device_t *dev)
{
    int retry = 0;
    bool reset_success = false;

    while (retry < 5 && !reset_success) {
        /* 读 clause 45：DEVAD=1 (PMA/PMD), 寄存器 0x0002 (PHY identifier) */
        uint32_t phy_id = phy_read_reg(dev, port=0, devaddr=0x01, regaddr=0x0002);
        if (phy_id != EXPECTED_PHY_ID) {       /* 期望值由 PHY 型号决定 */
            log("PHY ID mismatch: 0x%04x, retry %d\n", phy_id, retry);
            retry++;
            continue;
        }
        reset_success = true;
    }
    /* 清 TC10 状态寄存器 + TC10 初始化 */
    phy_write_reg(dev, 0, 4, 0x8703, 0xffff);
    phy_tc10_init(dev);
    return OK;
}
```


**逐字段拆解：**

```
phy_read_reg(dev, port=0, devaddr=0x01, regaddr=0x0002)
                ↑           ↑              ↑
                │           │              └── IEEE 规定 0x0002 是 PHY Identifier 寄存器
                │           └── DEVAD = 1，对应 PMA/PMD 层
                └── 88Q1110 的第一个端口
```

- `devaddr=0x01`：clause 45 的 DEVAD = 1，对应 **PMA/PMD** 层（IEEE 802.3 规定 DEVAD 1 = PMA/PMD、DEVAD 3 = PCS、DEVAD 7 = Auto-Negotiation、DEVAD 30/31 = Vendor Specific）
- `regaddr=0x0002`：MMD 1 内的 0x0002 号寄存器，IEEE 规定这是 PHY Identifier 寄存器
- 返回值是 PHY 厂商 ID + 型号编码，不同 PHY 型号有不同期望值

注意是 clause 45 访问，因为 1000BASE-T1 PHY 的所有配置寄存器都在 MMD 空间（clause 22 的 0~31 号寄存器装不下，必须用 clause 45）。

### Master/Slave 配置：bit 14 一位决定角色

1000BASE-T1 的 master/slave 角色由 PMA/PMD（DEVAD=1）的某个寄存器（以某 PHY 为例是 0x0834）的 bit 14 决定：

```c
/* 伪代码：master/slave 配置 */
if (dev->is_init_port_master_slave_enable) {
    /* 读 DEVAD 1 寄存器 0x0834 当前值 */
    uint32_t val = phy_read_reg(dev, 0, 0x01, 0x0834);
    uint32_t init_val = val;

    if (dev->is_init_port_master) {
        val |= 0x4000u;    /* bit 14 = 1 → master 模式 */
    } else {
        val &= ~0x4000u;   /* bit 14 = 0 → slave 模式 */
    }

    if (init_val != val) {
        /* 写新值 */
        phy_write_reg(dev, 0, 0x01, 0x0834, val);
        /* 写 DEVAD 1 寄存器 0x0000 = 0x8000，触发应用（PHY 标准 reset/apply 位） */
        phy_write_reg(dev, 0, 0x01, 0x0000, 0x8000);
    }
}
```

**对照协议里讲的 Master/Slave 时钟关系：**

| 协议概念 | 代码字段 | 寄存器:位 | 值 |
|---|---|---|---|
| Master 角色配置（用本地时钟） | `is_init_port_master = true` | DEVAD 1, reg 0x0834, bit 14 | 1 |
| Slave 角色配置（用恢复时钟） | `is_init_port_master = false` | 同上 | 0 |
| 应用配置 | - | DEVAD 1, reg 0x0000, bit 15 | 写 1（reset/apply） |

### Link Up 检测：PCS 层 bit 0

1000BASE-T1 PHY 不用 clause 22 的 BMSR bit 2 查 link（第 2 章的 RTL8211F 那种），而是用 clause 45 的 PCS（DEVAD=3）寄存器（以某 PHY 为例是 0x8235）bit 0：

```c
/* 伪代码：link up 检测 */
static bool phy_link_is_up(const phy_device_t *dev, uint8_t port)
{
    /* 读 DEVAD 3 (PCS) 寄存器 0x8235 */
    uint32_t val = phy_read_reg(dev, port, 3, 0x8235);

    /* 注意 val != 0xFFFF 判断：MDIO 读不到 PHY 时返回全 1（总线错误或 PHY 未上电）
     * 要先排除这种情况，否则会误判为 link up */
    if ((val != 0xFFFF) && (0u != (val & 0x1))) {
        return true;
    }
    return false;
}
```

**`val != 0xFFFF` 这个判断是工程经验：**

- MDIO 总线读不到 PHY 时，硬件控制器返回全 1（0xFFFF），表示"总线无应答"
- 不加这个判断，0xFFFF & 0x1 = 1，会误判为 link up
- 加了之后，PHY 没上电/掉线时不会误报

### SQI 读取：bit 15:12 是 Current，bit 11:8 是 Worst-case


```c
/* 伪代码：SQI 命令分发 */
case CMD_GET_SQI:
{
    if (data != NULL) {
        /* Register 0x8230, bits 15:12 = Current SQI Level */
        *((uint32_t*)data) = (phy_read_reg(dev, 0, 3, 0x8230) & 0xf000) >> 12;
        return OK;
    }
    break;
}
case CMD_GET_LOWEST_SQI:
{
    if (data != NULL) {
        /* Register 0x8230, bits 11:8 = Lowest SQI Level (worst-case) */
        *((uint32_t*)data) = (phy_read_reg(dev, 0, 3, 0x8230) & 0x0f00) >> 8;
        return OK;
    }
    break;
}
```


**对照先前里讲的 SQI：**

| 协议概念 | 代码字段 | 寄存器:位 | 掩码 |
|---|---|---|---|
| Current SQI | `CMD_GET_SQI` | DEVAD 3, reg 0x8230, bit 15:12 | `& 0xf000` 然后 `>> 12` |
| Worst-case SQI | `CMD_GET_LOWEST_SQI` | DEVAD 3, reg 0x8230, bit 11:8 | `& 0x0f00` 然后 `>> 8` |


**额外的诊断字段**（Open Alliance TC12 诊断规范要求）：

```c
case CMD_GET_LINKUP_TIME:
    /* reg 0x8231, bits 7:0 = Link Training Time（建链花了多久） */
    *((uint32_t*)data) = phy_read_reg(dev, 0, 3, 0x8231) & 0xff;
    break;

case CMD_GET_LINK_LOSSES:
    /* reg 0x8234, bits 15:10 = Link Losses（链路丢失次数） */
    *((uint32_t*)data) = (phy_read_reg(dev, 0, 3, 0x8234) & 0xfc00) >> 10;
    break;

case CMD_GET_LINK_FAILURES:
    /* reg 0x8234, bits 9:0 = Link Failures（建链失败次数） */
    *((uint32_t*)data) = phy_read_reg(dev, 0, 3, 0x8234) & 0x3ff;
    break;

case CMD_GET_POLARITY_DETECTION:
    /* reg 0x8009, bit 1 = Polarity (real time)（极性检测） */
    *((uint32_t*)data) = (phy_read_reg(dev, 0, 3, 0x8009) & 0x2) >> 1;
    break;

case CMD_GET_CABLE_TEST:
    /* reg 0x8517 + 0x8510 = TDR 电缆测试 */
    /* ... 触发测试 + 轮询完成位 + 读结果 ... */
    break;
```

这些字段都对应 Open Alliance TC12 诊断规范里要求的诊断信息——SQI 只是其中一个，还有建链时间、丢链次数、链路失败次数、极性、TDR 电缆测试等。


### SQI 监控状态机：三阶段定时器

光读 SQI 一次不够，量产代码要周期性监控 SQI，发现持续差就触发 PHY 复位。一个典型的实现是用三阶段定时器状态机：

```c
/* 伪代码：关键阈值 */
#define QUERY_READY_MAX_CNT             (50)    /* 50 次超时 */
#define MAX_LINKUP_TIME_MS              (100)   /* 100 ms link up 等待 */
#define QUERY_INTERVAL_MS               (10)    /* 10 ms 查询间隔 */
#define CHECK_PORT_FAILED_INTERVAL_MS   (2000)  /* 2000 ms 失败后重试间隔 */
#define SQI_THRESHOLD                   (4)     /* SQI ≤ 4 认为差 */
#define SQI_CHECK_INTERVAL_MS           (100)   /* 100 ms SQI 复检间隔 */
#define LINK_STATUS_CHECK_INTERVAL_MS   (200)   /* 200 ms link 查询间隔 */
#define READ_COUNTER_MAX                (2)     /* SQI 复检最多 2 次 */
#define ERROR_COUNTER_MAX               (2)     /* 错误次数超 2 次触发 reset */
#define CHECK_COUNTER_MAX               (3)     /* 总检查次数 3 次 */
```

**状态机三阶段：**

```
阶段 1: QUERY_READY_MODE
   │  每 10 ms 查 link 是否 up
   │  link up → 切到阶段 2
   ▼
阶段 2: PHY_T1_PORT_CHECK_MODE
   │  每 200 ms 查 SQI（先查 link，link up 才查 SQI）
   │  SQI ≤ 4 → error_counter++，切到阶段 3
   │  check_counter 达 3 次后：
   │     - error_counter ≥ 2 → 切到 PORT_CHECK_FAILED_MODE（2000ms 等待）
   │     - 否则 → 回到阶段 1
   ▼
阶段 3: PHY_T1_PORT_REREAD_SQI_MODE
   │  每 100 ms 复检 SQI
   │  SQI ≤ 4 → error_counter++
   │  read_counter 达 2 次后：
   │     - error_counter ≥ 2 → 触发 PHY_HARDWARE_RESET（硬件复位 PHY）
   │     - 回到阶段 2 重查 link
```

**阶段 2 完整代码（伪代码）：**

```c
case PHY_T1_PORT_CHECK_MODE:
    if (switch_is_ready) {
        /* Step 1: 先查 link 状态 */
        eth_control(dev, CMD_GET_LINK_STATUS, &data);
        if (data == TRUE) {
            /* Step 2: link up，才查 SQI */
            eth_control(dev, CMD_GET_SQI, &data);
            if (SQI_THRESHOLD >= data) {
                /* SQI ≤ 4，错误计数 +1 */
                error_counter++;
                /* 切到复检模式（更密的查询） */
                dev->timer_mode = PHY_T1_PORT_REREAD_SQI_MODE;
                timer_change_period(dev->timer, SQI_CHECK_INTERVAL_MS);  /* 100 ms */
            }
        }

        check_counter++;
        if (CHECK_COUNTER_MAX <= check_counter) {
            /* 总检查 3 次到了，判定 */
            if (ERROR_COUNTER_MAX <= error_counter) {
                /* 错误 ≥ 2 次，进入 PORT_CHECK_FAILED_MODE，2000 ms 等待 */
                dev->timer_mode = PORT_CHECK_FAILED_MODE;
                timer_change_period(dev->timer, CHECK_PORT_FAILED_INTERVAL_MS);
            } else {
                /* 错误少，恢复正常，回到 QUERY_READY_MODE */
                dev->timer_mode = QUERY_READY_MODE;
                timer_stop(dev->timer);
            }
        }
    }
    break;
```

**阶段 3 复检代码（伪代码）：**

```c
case PHY_T1_PORT_REREAD_SQI_MODE:
    /* 直接读 SQI（不再查 link，因为阶段 2 已确认 link up） */
    eth_control(dev, CMD_GET_SQI, &data);
    if (SQI_THRESHOLD >= data) {
        error_counter++;   /* 错误计数 +1 */
    }
    read_counter++;

    if (READ_COUNTER_MAX <= read_counter) {
        /* 复检 2 次到了，判定 */
        if (ERROR_COUNTER_MAX <= error_counter) {
            /* 错误次数 ≥ 2，触发 PHY 硬件复位！ */
            data = TRUE;
            eth_control(dev, CMD_PHY_HARDWARE_RESET, &data);
        }
        /* 回到阶段 2 重查 link（复位后 link 可能 down，要重新等） */
        dev->timer_mode = PHY_T1_PORT_CHECK_MODE;
        timer_change_period(dev->timer, LINK_STATUS_CHECK_INTERVAL_MS);
    }
    break;
```

**这套状态机的实战意义：**

- 单次 SQI 差可能是瞬态干扰（电机切换、ESD），不该立即复位
- 通过"先阶段 2 粗查 + 阶段 3 密查复检"双确认，过滤瞬态误报
- 复检还是差才触发硬件复位——避免频繁 reset 导致链路抖动
- PHY 硬件复位后回到阶段 2 重新查 link，等 link 重新 up 后再开始查 SQI

## 系列导航

- [车载以太网（一）：以太网帧与 VLAN](/blog/vehicle_ethernet_1/)
- [车载以太网（二）：MDIO 与 Clause 22/45](/blog/vehicle_ethernet_mdio/)
- [车载以太网（三）：100/1000BASE-T1 PHY、Master/Slave 与 SQI](/blog/vehicle_ethernet_phy/)
- [车载以太网（四）：TC10 休眠与唤醒](/blog/vehicle_ethernet_tc10/)
- [车载以太网（五）：Switch 硬件转发模型](/blog/vehicle_ethernet_2/)
