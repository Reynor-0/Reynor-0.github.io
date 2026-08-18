---
title: '车载以太网（四）：TC10 休眠与唤醒'
description: '理解 TC10 的低功耗目标、LPS 休眠握手、WUR/WUP 唤醒机制，以及它们在车规 PHY 驱动中的实现。'
category: '协议'
series: { id: 'vehicle-ethernet', order: 4 }
tags: ['Ethernet', 'TC10', 'PHY', '低功耗', '唤醒']
pubDate: 'Jun 08 2026'
updatedDate: 'Aug 05 2026'
---

TC10 解决的是车载以太网链路如何受控休眠，以及普通数据链路关闭后如何重新唤醒的问题。本篇把协议状态、物理层信号和驱动实现串联起来。

## TC10

TC10 原本是 OPEN Alliance 的第 10 技术委员会（Technical Committee 10）；这个委员会制定了一系列车载以太网 Sleep/Wake-up 规范。一般我们说支持TC10 就是支持TC10规范定义的以太网休眠、唤醒和唤醒转发功能。
OPEN Alliance 的 TC10 当前负责不同速率 T1 以太网的 Sleep/Wake-up 机制，包括 10BASE-T1S、100BASE-T1、1000BASE-T1 和 Multi-GBASE-T1。

### 为什么需要TC10

汽车熄火之后，不可能让所有的ECU、交换机和PHY一直保持正常运行，否则静态功耗会持续小号蓄电池。但这些节点又必须能够被某些事件重新唤醒，例如：
```
车门解锁
远程启动
充电事件
OTA 任务
碰撞或防盗事件
定时任务
其他 ECU 的网络请求
```

因此车载网络需要解决两个问题：
1. 怎样让一条Ethernet链路安全、可控的进入休眠？
2. 链路已经关闭，不能传普通的Ethernet帧的时候，怎么样通过原来的双绞线把对端唤醒？

基础的 IEEE 100BASE-T1 和 1000BASE-T1 物理层标准定义了正常建链和数据传输，却没有完整定义这种整车级的受控休眠和快速唤醒机制；TC10 规范就是对这一缺口的补充。

### TC10位于网络的哪一层

TC10 的主要机制位于物理层PHY，可以将系统层次描述为以下的形式：
```
AUTOSAR Network Management
整车电源管理策略
          │
          │ 决定哪些 ECU 可以睡、何时唤醒
          ▼
MCU / Ethernet Driver
          │
          │ MDIO、控制引脚、服务请求
          ▼
TC10-capable PHY
          │
          │ LPS / WUR / WUP
          ▼
单对双绞线
          │
          ▼
对端 PHY
```

注意，TC10 负责提供物理层的休眠、唤醒和唤醒转发手段，但不负责决定整车中哪个 ECU 应该休眠。

### TC10的休眠流程

假设有两个 ECU：
```
ECU A / PHY A ←──── 1000BASE-T1 ────→ ECU B / PHY B
```

当前状态是link up，双方都在正常通信。现在ECU A希望进入休眠。

**第一步：上层允许休眠**

ECU A 的网络管理首先判断：
```
当前没有必须发送的数据
应用程序允许睡眠
诊断任务已经结束
对端也可以进入休眠
```
然后上层向 PHY 发出类似Sleep.request的请求。

**第二步：PHY A 发送 LPS**

因为链路仍然是 Link Up，PHY A 向 PHY B 发送 LPS：Low Power Sleep，表示希望关闭这条链路并进入低功耗状态，征求PHY同意。

**第三步：PHY B 判断是否接受**

PHY B 收到 LPS 后，通知本地管理层 Sleep.indication 。
B 可以检查自己是否能够休眠。例如 B 此时还有数据要发送，就可以拒绝或中止休眠。如果 B 同意，也向 A 返回 LPS：
```
PHY A ───── LPS ─────→ PHY B
PHY A ←──── LPS ────── PHY B
```
因此这是一个双向握手，而不是单方面关链。

**第四步：双方进入静默状态**

当双方都确认发送和接收过 LPS 后，逐渐进入：
```
NORMAL
   ↓
SLEEP_REQUEST / SLEEP_ACK
   ↓
SLEEP_SILENT
   ↓
SLEEP
```
SLEEP_SILENT 是一个重要的过渡阶段：
```
双方停止正常传输
等待线路完全静默
确认没有新的活动
再进入深度休眠
```
TC10 的 PHY 电源状态机还包含 SLEEP_FAIL 等状态；如果握手超时或被对端拒绝，PHY 会返回正常发送状态，而不是继续强制睡眠。
```
简化状态机如下：

                 对端不同意或握手超时
                ┌──────────────────┐
                ▼                  │
NORMAL → SLEEP_REQUEST → SLEEP_SILENT → SLEEP
   ▲                │
   └── SLEEP_FAIL ←─┘
```

**五、进入 Sleep 后，究竟关闭了什么**

进入 TC10 Sleep 后，通常可以关闭或降低功耗的部分包括：
```
正常 PAM 收发器
均衡器和回波抵消 DSP
PCS 数据路径
正常 Link Training 电路
MAC 或部分 SoC 电源域
外部稳压器或其他 ECU 电源域
```
但不能把所有电路完全关闭，否则将无法检测远端唤醒。

因此通常还会保留一个非常低功耗的 always-on 区域：
```
低功耗唤醒检测器
部分 PHY 状态机
唤醒引脚逻辑
必要的 always-on 电源
```

### TC10 唤醒
关键要看此时链路是否仍然活动：
```
Link Up   → WUR
Link Down → WUP
```

**情况一：链路仍是活动状态——WUR**

当链路还是 Link Up 时，可以通过活动链路中的物理层控制信息发送唤醒请求：
```
PHY A ───── WUR ─────→ PHY B
```
对 1000BASE-T1，WUR 通过 PCS 层的 OAM 信息传递，而不是普通应用层 Ethernet 数据包。

PHY B 收到后产生：Wakeup.indication, 通知本地控制器对端要求唤醒。

这种情况通常发生在：
```
PHY 链路仍然保持
但上层 ECU 或某些功能域处于较低功耗状态
```

**情况二：链路已经休眠——WUP**

链路进入 Sleep 后：
```
Link Down
不能传普通 Ethernet Frame
不能发送 IP、UDP 或 SOME/IP 报文
```

这时必须使用：WUP：Wake-Up Pulse
WUP 是 PHY 直接在 MDI 双绞线上发出的特殊物理层唤醒信号：
```
休眠中的 PHY A
       │
       │ WUP 特殊信号
       ▼
单对双绞线
       │
       ▼
PHY B 低功耗检测器
       │
       ▼
Wakeup.indication
```

对 1000BASE-T1，TC10 规范定义了相应 WUP 的符号模式、发送持续时间和检测要求；具体的低功耗能量检测算法由 PHY 厂商实现。收到 WUP 后，对端大致执行：
```
检测到 WUP
    │
    ▼
唤醒 always-on 控制逻辑
    │
    ▼
使能电源或拉起 INH
    │
    ▼
PHY 初始化
    │
    ▼
进行 Auto-Negotiation / Link Synchronization
    │
    ▼
Link Training
    │
    ▼
Link Up
    │
    ▼
恢复正常 Ethernet 通信
```

## 项目代码实证：TC10 如何落到 PHY 驱动

下面继续以 1000BASE-T1 车规 PHY 为例，观察 TC10 初始化、Sleep/Wakeup 控制和状态查询如何通过厂商寄存器实现。

### TC10 初始化：先解锁厂商私有寄存器再配置

```c
/* 伪代码：TC10 初始化 */
void phy_tc10_init(phy_device_t *dev)
{
    if (dev->is_support_sleep_wakeup) {
        /* 厂商私有寄存器配置（不同 PHY 不同，需向厂商索取 Programming Guide） */
        phy_write_reg(dev, 0, 3, VENDOR_PRIVATE_REG_1, 0x4837);
        phy_write_reg(dev, 0, 3, VENDOR_PRIVATE_REG_2, 0xC1B0);

        /* 使能 TC10：写 TC10 Control 寄存器 = 0x0002 */
        phy_write_reg(dev, 0, 3, TC10_CTRL_REG, 0x0002);

        /* 配置 LPSD 唤醒相关参数 */
        phy_write_reg(dev, 0, 3, VENDOR_PRIVATE_REG_3, 0x0010);

        /* 等 5 ms 让 PHY 内部状态机消化配置 */
        sleep_ms(5);

        /* 清掉 TC10 control 寄存器（保留硬件内部状态） */
        phy_write_reg(dev, 0, 3, TC10_CTRL_REG, 0x0000);
    }
}
```

**几个关键细节：**

1. **DEVAD=3 (PCS)**：TC10 寄存器通常在 PCS 层（不是 PMA/PMD）
2. **厂商私有寄存器**：`VENDOR_PRIVATE_REG_1/2/3` 不在 datasheet 公开部分，需要厂商提供 Programming Guide
3. **TC10 Control 寄存器**：bit 1 = TC10 enable
4. **写完等 5 ms**：PHY 内部状态机需要时间消化配置，不能立即读回校验
5. **最后清回 0**：保留 PHY 硬件内部使能状态，软件层 control 位清零


### TC10 Sleep/Wakeup：LPSD vs TPS vs Normal 三种模式

1000BASE-T1 PHY 的 TC10 状态机比博客讲的"Sleep / Wakeup"复杂——实际有三种低功耗状态，唤醒方式不同：

| 模式 | 全称 | INH 引脚 | 唤醒方式 |
|---|---|---|---|
| LPSD | Low-Power Sleep Detect（深度睡眠） | INH=低（PHY 完全进入 always-on 区） | 拉 wakein 引脚 |
| TPS | Transitional Port Sleep（过渡睡眠） | INH=高（PHY 主电源仍开） | 写 TC10 Control 寄存器 bit 4 = 1 发 WUP |
| Normal | 链路正常但需要唤醒对端 | - | 切到 master 模式唤醒 LP |

**set_wakeup 函数的三模式分发（伪代码）：**

```c
status_t phy_set_wakeup(phy_device_t *dev)
{
    if (dev->consumption_mode == MODE_SLEEP) {
        /* 当前在 Sleep 状态 */
        do {
            sleep_ms(1);
            is_sleep = phy_is_sleep(dev);
        } while (is_sleep && ++retry < WAKEIN_TO_INH_CHECK_CNT);  /* 等 5 次 × 1ms */

        if (!is_sleep) {
            /* 唤醒成功，触发 power sequence 重新初始化 */
            event_t event = EVENT_UNKNOWN;
            phy_control(dev, CMD_POWER_SEQ, &event);
            if (dev->event_cb) {
                dev->event_cb(dev_id(dev), event, NULL);
            }
            dev->consumption_mode = MODE_ACTIVE;
        }
    } else {
        /* 已经 awake 但需要唤醒对端 */
        if (dev->is_support_sleep_wakeup) {
            if (phy_get_inh(dev)) {
                /* INH=高 → LPSD 深度睡眠，拉 wakein 引脚 */
                phy_wakeup_sequence_step1(dev);
                linkdown_count_after_wakeup = 0;
            } else {
                /* INH=低（PHY 主电源开），查 TC10 状态寄存器 */
                val = phy_read_reg(dev, 0, 3, TC10_STATUS_REG);
                if ((val & SLEEP_STATUS_MASK) == SLEEP_MODE) {
                    /* TPS 模式，发 WUP */
                    val = phy_read_reg(dev, 0, 3, TC10_CTRL_REG);
                    val |= 0x10;   /* bit 4 = 1，发送 WUP */
                    phy_write_reg(dev, 0, 3, TC10_CTRL_REG, val);
                } else if (!phy_link_is_up(dev, 0)) {
                    /* Normal 模式但 link down → 切到 master 唤醒 LP */
                    ++linkdown_count_after_wakeup;
                    if (linkdown_count_after_wakeup >= 3) {
                        /* 连续 3 次 link down → 主动切 master */
                        val = phy_read_reg(dev, 0, 1, 0x0834);
                        if (0 == (val & 0x4000)) {
                            val |= 0x4000;   /* bit 14 = 1，切 master */
                            phy_write_reg(dev, 0, 1, 0x0834, val);
                            sleep_ms(KEEP_MASTER_TIMEOUT);  /* 5 ms */
                            val &= ~0x4000;  /* 切回 slave */
                            phy_write_reg(dev, 0, 1, 0x0834, val);
                        }
                        linkdown_count_after_wakeup = 0;
                        report_slave_phy_wup_retry();  /* 上报故障码 */
                    }
                }
            }
        }
    }
    return OK;
}
```


**对照先前里讲的 TC10 唤醒 WUP/WUR：**

| 协议概念 | 代码实现 | 备注 |
|---|---|---|
| WUP (Wake-Up Pulse) 链路已休眠 | 写 TC10_CTRL_REG bit 4 = 1 | 上面代码 `val |= 0x10` 这行 |
| WUR (Wake-Up Request) 链路仍活动 | 走 `phy_set_phy_mode(MODE_RUN)` 见下文 | 写 TC10_CTRL_REG bit 4 = 1 + bit 0 = 0 |
| 切 master 唤醒对端 | bit 14 = 1，5 ms 后切回 slave | 上面切 master 那段代码 |


### set_phy_mode: MODE_RUN 即发 WUP

```c
/* 伪代码：set_phy_mode 唤醒请求 */
static status_t phy_set_phy_mode(const phy_device_t *dev, uint8_t port, phy_port_mode_t mode)
{
    uint16_t addr = TC10_CTRL_REG;
    uint32_t val = 0;

    switch (mode) {
    case MODE_RUN:  /* 唤醒请求 */
        /* 读 TC10_CTRL_REG 当前值 */
        val = phy_read_reg(dev, port, 3, addr);
        val |= 1 << 4;   /* bit 4 = 1，发送 WUP */
        val &= ~1;       /* bit 0 = 0，清 sleep request */
        phy_write_reg(dev, port, 3, addr, val);

        sleep_ms(WAKEUP_DONE_TIMEOUT);  /* 3 ms 等唤醒完成 */

        /* 读 TC10_STATUS_REG 状态寄存器确认 */
        val = phy_read_reg(dev, port, 3, TC10_STATUS_REG);
        if ((val & SLEEP_STATUS_MASK) == NORMAL_MODE) {
            return OK;
        }
        break;

    case MODE_TPS:  /* 进入 TPS 睡眠 */
        /* ... */
        break;

    case MODE_LPSD:  /* 进入 LPSD 深度睡眠 */
        /* ... */
        break;
    }
    return ERR;
}
```


| 寄存器 | 用途 | 关键位 |
|---|---|---|
| TC10 Control (如 0x8702) | 控制：发 WUP、发 LPS、使能 TC10 | bit 4 = WUP, bit 0 = Sleep request, bit 1 = TC10 enable |
| TC10 Status (如 0x8703) | 状态：当前是 Normal/Sleep/Sleep Fail | bit 2:0 (mask 0x07) |

**SLEEP_STATUS_MASK = 0x07** 是状态字段掩码，对应 3 bit 状态值：
- `NORMAL_MODE = 0`：正常工作
- `SLEEP_MODE = 1`：已睡眠
- `SLEEP_FAIL = 2`：睡眠失败
- `SLEEP_ABORT = 3`：睡眠中止

### TC10 状态查询

```c
/* 伪代码：通过状态寄存器查 TC10 状态 */
static bool phy_is_sleep(phy_device_t *dev)
{
    uint32_t val = phy_read_reg((net_device_t*)dev, 0, 3, TC10_STATUS_REG);
    return ((val & SLEEP_STATUS_MASK) == SLEEP_MODE);
}
```

这是 set_wakeup 里 `phy_is_sleep()` 的实现——读状态寄存器、mask 0x07、判断是不是 `SLEEP_MODE`。

### 完整数据流图：从上电到 link up 再到 TC10 监控

```
ECU 上电
   │
   ▼
phy_init()                                  [PHY driver]
   │
   ├── mdio_register + bus_ops->init       注册 MDIO 总线
   │
   ├── phy_poweron()                        GPIO 上电
   │
   ├── [LPSD_SUPPORT] if INH=低：          PHY 处于深度睡眠
   │       set_wakein(WAKEIN) → 等 1ms → set_wakein(NORMAL)
   │       若仍 INH=低：enter_lpsd + 再次拉 wakein
   │
   ├── phy_power_sequence()
   │   │
   │   ├── 读 PHY ID (DEVAD 1, reg 0x0002)
   │   │   期望值由 PHY 型号决定，否则重试 5 次
   │   │
   │   ├── 清 TC10 状态寄存器（写 0xffff）
   │   │
   │   └── phy_tc10_init()
   │       └── 写 VENDOR_PRIVATE_REG + TC10_CTRL_REG + 等 5ms + 清 TC10_CTRL_REG
   │
   ├── [若 master/slave enable]
   │   读 DEVAD 1 reg 0x0834 → 配 bit 14 (master/slave)
   │   └── 写 DEVAD 1 reg 0x0000 = 0x8000 应用
   │
   └── consumption_mode = MODE_ACTIVE
       │
       ▼
ready_policy 启动                          [适配层]
   │
   ▼
QUERY_READY_MODE  (10ms 周期)
   │
   │  调 eth_control(CMD_GET_READY_STATUS)
   │  ready=1 → dev_ready=true
   │
   ▼
PHY_T1_PORT_CHECK_MODE  (200ms 周期)
   │
   │  每 200ms：
   │  ├── eth_control(CMD_GET_LINK_STATUS)
   │  │   ↓ 调 phy_link_is_up()  读 DEVAD 3 reg 0x8235 bit 0
   │  │
   │  └── if link up:
   │      └── eth_control(CMD_GET_SQI)
   │          ↓ 调 phy_read_reg(DEVAD 3, reg 0x8230) & 0xf000 >> 12
   │
   │  SQI ≤ 4：error_counter++，切到 REREAD 模式
   │
   ▼
PHY_T1_PORT_REREAD_SQI_MODE  (100ms 周期)
   │
   │  每 100ms：直接读 SQI（复检）
   │  read_counter 达 2：
   │  └── if error_counter ≥ 2:
   │      └── eth_control(CMD_PHY_HARDWARE_RESET)
   │          ↓ GPIO 拉 reset pin 10ms 后释放
   │
   ▼
回到 PHY_T1_PORT_CHECK_MODE 等 link 重新 up

=== 休眠分支（上层调用 set_sleep） ===

eth_set_sleep(dev_id)
   │
   ▼
phy_set_sleep()
   │
   ├── 判断模式（LPSD / TPS）
   │
   ├── TPS：写 TC10_CTRL_REG bit 0 = 1 发 LPS
   │
   ├── LPSD：进入 LPSD 模式（关 PHY 主电源，留 always-on 区）
   │
   └── consumption_mode = MODE_SLEEP

=== 唤醒分支（上层调用 set_wakeup） ===

eth_set_wakeup(dev_id)
   │
   ▼
phy_set_wakeup()
   │
   ├── 若当前 SLEEP 状态：
   │   └── 等 INH 变高（最多 5ms × 5 次），成功 → CMD_POWER_SEQ 重新初始化
   │
   └── 若当前 ACTIVE 状态但要唤醒对端：
       ├── INH=高 → LPSD 模式：wakeup_sequence_step1 拉 wakein 引脚
       ├── TC10_STATUS_REG 显示 SLEEP_MODE → TPS 模式：写 TC10_CTRL_REG bit 4 = 1 发 WUP
       └── link down 3 次：切 master 唤醒 LP，5ms 后切回 slave
```
