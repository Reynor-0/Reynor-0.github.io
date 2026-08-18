---
title: '实习期间Ethernet项目总结'
description: '分析整理实习期间进行的功能开发，有关Ethernet中的PHY/Switch驱动开发'
category: '项目'
tags: ['Ethernet', 'PHY', 'Switch', 'TC10', '低功耗']
pubDate: 'Aug 12 2026'
---

## 写在前面

这段实习我 NIO 做车载 ECU 嵌入式软件开发，接触到了一个功能改动点，主要负责一个 100BASE-T1 PHY 驱动的多车型合并统一和 TC10 低功耗子模块，并参与了一个双 die Switch 的睡眠唤醒集成联调。写过几篇车载以太网的技术博客（VLAN / MDIO / PHY / Switch / DMA / gPTP），都是讲协议概念到代码实现的映射。这篇算是这些技术博客的"工程实证版"——在真实量产项目里，这些协议机制是怎么落地的，遇到了什么问题，怎么取舍的。所有代码用伪代码形式呈现，具体寄存器地址以 PHY/Switch datasheet 为准，重点讲清楚设计思路和踩坑经验。

## 背景

原先仓库中有一个 88q1110 PHY驱动，总共有ONVO和NIO两个版本，也就是区分乐道和蔚来两个车型。假设要区分车型A和B
```
ext-drivers/ethernet-dev-drv/src/
├── phy_xxx_driver_brandA.c   # 品牌 A 的 PHY 驱动
└── phy_xxx_driver_brandB.c   # 品牌 B 的 PHY 驱动
```

两个版本之间通过**运行时读硬件版本**来区分行为：

```c
/* 伪代码：原分叉版本的运行时分支判断 */
hw_version_t hw_version;
nvos_hardware_version_get(1, &hw_version);

if (hw_version.hw_version != HW_INFO_DOM_VERSION_B) {
    /* 品牌 A 的行为 */
    phy_power_read();
} else {
    /* 品牌 B 的行为：直接返回 0，不读电源 */
    return 0;
}
```

这种方式在维护上有很多麻烦的地方，例如新增功能或者改bug，两个文件都要去改一遍，很麻烦。运行时也会带来额外的开销。还有DLT日志上都会带来日志分析上的麻烦，要用不同的过滤规则去过滤。

## 方案：编译器配置统一

合并的核心思路：**把运行时分支判断改成编译时配置**。AUTOSAR 的 BSW 模块通常支持通过 `#ifdef` 在编译时区分配置。我们把这个思路用到 PHY 驱动上：


```c
/* 伪代码：合并后的单一驱动，编译时配置区分 */
void phy_power_on(phy_device_t *dev)
{
    /* 所有车型共用的逻辑 */
    phy_set_power_gpio(dev, 1);
    os_thread_sleep(OS_MS_TO_TICKS(1));

#ifdef SWITCH_LPSD_SUPPORT   /* 编译时配置：是否支持 LPSD 深睡眠 */
    if (phy_get_inh_gpio(dev)) {
        phy_set_wakein(dev, WAKEIN_WAKEUP_STATUS);
        os_thread_sleep(OS_MS_TO_TICKS(1));
        phy_set_wakein(dev, WAKEIN_NORMAL_STATUS);
        os_thread_sleep(OS_MS_TO_TICKS(1));
    }
#endif

    phy_set_reset(dev, RESET_PIN_RESET_STATUS);
    os_thread_sleep(OS_MS_TO_TICKS(2));
    phy_set_reset(dev, RESET_PIN_NORMAL_STATUS);
    os_thread_sleep(OS_MS_TO_TICKS(5));
}
```


**对应概念**：

| 原分叉版本 | 合并后 | 含义 |
|---|---|---|
| `hw_version != DOM_VERSION_B` 运行时判断 | `#ifdef SWITCH_LPSD_SUPPORT` 编译时判断 | 零运行时开销 |
| 两个文件 `_brandA.c` / `_brandB.c` | 单一文件 `phy_xxx_driver.c` | 单一代码源 |
| DLT 通道 `phy_xxx_driver_brandA/B` | DLT 通道 `phy_xxx_driver` | 日志统一 |
| TPS 重试上限 PHY 无定义、Switch 定义 9 | PHY 也定义 `PHY_TPS_SLEEP_RETRY_MAX = 9` | 跨芯片统一 |

合并后，新增功能只需要改一个文件，编译时按车型配置生成不同的二进制。这是车载 ECU 软件多车型支持的常见做法——**一份代码源 + 多份配置**。

## TC10睡眠唤醒

相关协议介绍我在之前的博客上讲解过，可以去看看。相关链接喂：

TC10主要就是分两级，TPS和LPSD。一个是PHY级协商睡眠。本地发 LPSD，对端回 LPSR，双方进入低功耗链路。链路仍物理连接，PHY 大部分电路下电但保留链路保持逻辑。功耗中等（几十 mA），唤醒快（ms 级）。另一个就是深度睡眠。PHY 仅保留唤醒检测电路，功耗极低（μA-mA 级），需配合电源域 power off。唤醒慢（百 ms 级，需 poweron + reset + firmware init）。

### Sleep 流程实现


```c
/* 伪代码：PHY Sleep 流程 */
status_t phy_set_sleep(phy_device_t *dev)
{
    /* 1. 幂等检查：已经在 sleep 就直接返回 */
    if (dev->consumption_mode == ETHERNET_DEV_SLEEP) {
        return E_OK;
    }

    /* 2. TPS 协商：先尝试链路级睡眠 */
    if (dev->is_support_sleep_wakeup) {
        ret = phy_set_phy_mode(dev, 0, SW_TPS_MODE);
        if (ret != E_OK) {
            return ret;   /* TPS 失败直接返回，不进 LPSD */
        }
    }

    /* 3. LPSD 深睡眠：配置唤醒源 + INH 确认 + GPIO 下电 */
#ifdef SWITCH_LPSD_SUPPORT
    ret = phy_enter_lpsd(dev);
#else
    ret = phy_poweroff(dev);
#endif

    /* 4. 更新状态 + 通知上层 */
    if (ret == E_OK) {
        dev->consumption_mode = ETHERNET_DEV_SLEEP;
        dev->dev_ready = false;
        if (dev->event_cb) {
            dev->event_cb(dev_id, ETHDEV_SLEEP_EVENT, NULL);
        }
    }
    return ret;
}
```

**TPS 协商的时序设计**：


```c
/* 伪代码：TPS 协商，重试 9 次 */
status_t phy_set_phy_mode(phy_device_t *dev, uint8_t port, phy_port_mode_t mode)
{
    /* 先检查是否已经在 sleep */
    val = phy_read_phy_reg(dev, port, 3, PHY_TC10_STATUS_REG);
    if ((val & SW_SLEEP_STATUS_MASK) == SW_SLEEP_MODE) {
        return E_OK;   /* 已 sleep，幂等 */
    }

    /* 必须 link up 才能 TPS */
    if (!phy_link_is_up(dev, port)) {
        return E_NOT_OK;
    }

    /* 重试循环：最多 9 次 */
    for (retry = 1; retry <= PHY_TPS_SLEEP_RETRY_MAX; retry++) {
        /* 写 sleep request：reg 0x8702 bit0 = 1 */
        val = phy_read_phy_reg(dev, port, 3, PHY_TC10_CONTROL_REG);
        val |= 0x01;
        phy_write_phy_reg(dev, port, 3, PHY_TC10_CONTROL_REG, val);

        /* 等 20ms（T_SleepReqTimer，datasheet 规范 16ms + 4ms 余量）*/
        os_thread_sleep(OS_MS_TO_TICKS(SW_SLEEP_REQ_TIMER_TIMEOUT));

        /* 读 status 验证 */
        val = phy_read_phy_reg(dev, port, 3, PHY_TC10_STATUS_REG);
        if ((val & SW_SLEEP_STATUS_MASK) == SW_SLEEP_MODE) {
            return E_OK;   /* 协商成功 */
        }
        /* 失败重试 */
    }
    return E_NOT_OK;
}
```


**逐字段拆解**：

```
phy_read_phy_reg(dev, port=0, devaddr=3, regaddr=0x8703)
                    │           │              │
                    │           │              └── TC10 Status 寄存器（PCS MMD）
                    │           └── DEVAD = 3，对应 PCS 层
                    └── PHY 的端口 0
```

- `devaddr=3`：Clause 45 的 DEVAD = 3，对应 **PCS** 层（TC10 寄存器在 PCS MMD）
- `regaddr=0x8703`：TC10 Status 寄存器，bits[2:0] 表示 sleep status
- Sleep status 值：0=Normal, 1=Sleep, 2=Sleep Fail, 3=Sleep Aborted

### Wakeup 流程：两阶段时序


唤醒比睡眠复杂，因为要处理三种场景：LPSD 深睡眠唤醒、TPS 睡眠唤醒、已唤醒但 link down 重发 WUP。

```c
/* 伪代码：PHY Wakeup 流程 */
status_t phy_set_wakeup(phy_device_t *dev)
{
    if (dev->consumption_mode == ETHERNET_DEV_SLEEP) {
        /* 场景 1：从 LPSD 深睡眠唤醒 */
        phy_wakeup_sequence_step1(dev);  /* 拉 WAKE_IN 脉冲 + reset */
        linkdown_count_after_wakeup = 0;

        /* 轮询 INH，等 PHY 真正醒来 */
        do {
            os_thread_sleep(OS_MS_TO_TICKS(1));
            is_sleep = (phy_is_sleep(dev) == E_OK);
        } while (is_sleep && ++retry < SW_WAKEIN_TO_INH_CHECK_CNT);

        if (!is_sleep) {
            /* 唤醒成功，走 power sequence 重新初始化 */
            event = ETHDEV_UNKNOWN_EVENT;
            ret = phy_control(dev, ETH_DEV_POWER_SEQ_CMD, &event);
        }
    } else {
        /* 场景 2/3：已唤醒，但需要发 WUP/WUR */
        if (phy_get_inh(dev)) {
            /* LPSD 模式：拉 wakein */
            phy_wakeup_sequence_step1(dev);
        } else {
            val = phy_read_phy_reg(dev, 0, 3, PHY_TC10_STATUS_REG);
            if ((val & SW_SLEEP_STATUS_MASK) == SW_SLEEP_MODE) {
                /* 场景 2：TPS 模式，发 WUP */
                val = phy_read_phy_reg(dev, 0, 3, 0x8702);
                val |= 0x10;   /* bit4 = WUP request */
                phy_write_phy_reg(dev, 0, 3, 0x8702, val);
            } else if (!phy_link_is_up(dev, 0)) {
                /* 场景 3：已唤醒但 link down，Slave WUP Retry */
                handle_slave_phy_wup_retry(dev);
            } else {
                /* link up，发 WUR */
                val = phy_read_phy_reg(dev, 0, 3, 0x8702);
                val |= 0x10;
                phy_write_phy_reg(dev, 0, 3, 0x8702, val);
            }
        }
    }
    return E_OK;
}
```

**两阶段唤醒时序**：

```c
/* 伪代码：两阶段唤醒 */
void phy_wakeup_sequence_step1(phy_device_t *dev)
{
    if (phy_get_inh(dev)) {   /* INH 高 = 在 sleep */
        phy_set_reset(dev, RESET_PIN_RESET_STATUS);
        phy_set_wakein(dev, WAKEIN_WAKEUP_STATUS);  /* 拉 WAKE_IN */
    }
}

void phy_wakeup_sequence_step2(phy_device_t *dev)
{
    os_thread_sleep(OS_MS_TO_TICKS(1));
    phy_set_power(dev, 1);                            /* power on */
    os_thread_sleep(OS_MS_TO_TICKS(1));
    phy_set_wakein(dev, WAKEIN_NORMAL_STATUS);       /* 释放 WAKE_IN */
    os_thread_sleep(OS_MS_TO_TICKS(1));
    phy_set_reset(dev, RESET_PIN_NORMAL_STATUS);     /* 释放 reset */
    os_thread_sleep(OS_MS_TO_TICKS(5));
}
```

### Slave PHY WUP Retry

唤醒后双方 PHY 可能都是 slave 模式（没人主动发 link training），导致 link 一直 down。我们可以设计一个重试的机制：


```c
/* 伪代码：Slave PHY WUP Retry */
void handle_slave_phy_wup_retry(phy_device_t *dev)
{
    ++linkdown_count_after_wakeup;
    if (linkdown_count_after_wakeup >= 3) {
        val = phy_read_phy_reg(dev, 0, 1, 0x0834);  /* Master/Slave reg */
        if (0 == (val & 0x4000)) {                  /* 当前 slave */
            /* 切 master，主动发 link training */
            val |= 0x4000;
            phy_write_phy_reg(dev, 0, 1, 0x0834, val);

            os_thread_sleep(OS_MS_TO_TICKS(5));     /* 保持 master 5ms */

            /* 回 slave，正常协商 */
            val &= ~0x4000;
            phy_write_phy_reg(dev, 0, 1, 0x0834, val);
        }
        linkdown_count_after_wakeup = 0;
        report_dtc(DEM_EVENT_ID_DTC_SLAVEPHYWUPRETRYOCCURRS);
    }
}
```

这个机制解决了一个微妙的死锁：TC10 唤醒后双方都等对方发 training，谁都不发，link 永远 down。临时切 master 打破僵局，再回 slave 正常协商。简单但有效。

### Ready 状态机：轮询 + 重试 + 超时强制 ready

PHY 上电或唤醒后，固件初始化是异步的，需要轮询"设备是否真正 Ready"才能通知上层（UDP NM）恢复链路。

#### 状态机的四种模式


```text
READY_TIMER_QUERY_READY_MODE (10ms 轮询)
    │ ready == 1
    ▼
PHY_T1_PORT_CHECK_MODE (200ms)
    │ switch ready 后才启动
    │ 读 link status，link up → 读 SQI
    │ SQI < 4 → error_counter++
    │ 切到 REREAD_SQI
    ▼
PHY_T1_PORT_REREAD_SQI_MODE (100ms)
    │ 再读 SQI
    │ read_counter++ (最多 2 次)
    │ read_counter >= 2 && error_counter >= 2
    │   → ETH_DEV_PHY_HARDWARE_RESET
    │ 切回 PORT_CHECK_MODE
    ▼
（3 轮 check 后）
    │ error_counter >= 2
    ▼
PORT_CHECK_FAILED_MODE (2s 周期打印 log)
```


**SQI 监控的容错设计**：

| 设计点 | 值 | 思考 |
|---|---|---|
| SQI 阈值 | 4 | TC10 规范要求 ≥4 视为可用 |
| 重读次数 | 2 | 单次 SQI 跌落可能是瞬态干扰，连续 2 次才确认硬件问题 |
| Check 轮数 | 3 | 区分偶发和持续性问题 |
| 触发动作 | 硬件复位 | 软件重置可能不够，GPIO 硬件复位 + 重新初始化 |
| 超时强制 ready | 500ms | 宁可误报 ready 也不能让上层永久阻塞，记 ERROR 日志 |

最后一点值得展开：500ms 超时仍未 ready 会**强制** `dev_ready = true` 并发 `ETHDEV_READY_EVENT`。这是"宁可误报也不能卡死"的工程取舍——上层（UDP NM）等不起，宁可让链路尝试恢复也不能永久阻塞。当然会记 ERROR 日志方便后续分析。

## Switch部分

项目上先前的Switch相关驱动源码主要就是写配置寄存器相关的内容，常见的QoS 调度、ATU 动态学习 + 老化等等都没看到，可能是出场的固件烧录了。88Q5192 是一个双 die的架构。对于双 die 要注意以下的一些特殊问题：


| 注意点 | 解决方案 |
|---|---|
| 跨 die 寄存器访问 | `switch_smi_die()` 切换当前访问的 die |
| SMI Semaphore 锁 | 写 reg 0x15 = 0x8000 请求锁，双 die 都要锁，防 Host/Firmware 并发冲突 |
| WUP/WUR 跨 die 转发 | 一个 die 收到 TC10 wake，转发到另一 die 的对应 port |
| Firmware Init 同步 | 双 die 都写 0xA5A5 才算 operable |

### Sleep 流程


```c
/* 伪代码：Switch 双 die Sleep 流程 */
status_t switch_set_sleep_impl(switch_device_t *dev)
{
    /* 1. 收集所有支持睡眠的 port */
    uint32_t port_mask = 0;
    for (port = 0; port < SWITCH_PORT_NUMBER; port++) {
        if (dev->port_info[port].is_support_sleep_wakeup &&
            dev->port_info[port].connect_status == PORT_CONN_INNER_PHY) {
            port_mask |= 1 << port;
        }
    }

    /* 2. TPS 协商所有 port */
    ret = switch_set_inner_phy_mode(dev, port_mask, SW_TPS_MODE);
    /* 内部：逐 port 写 sleep request → 等 20ms → 读 status → 重试 9 次 */

    /* 3. 进入 LPSD：两个 die 都要 */
    ret = switch_enter_lpsd(dev, SWITCH_DIE_0);
    if (ret == E_OK) {
        ret = switch_enter_lpsd(dev, SWITCH_DIE_1);
        /* 写 scratch_misc 0x32 = 0x08 (DeepSleepEn) */
    }

    /* 4. 等 INH 确认 + power off */
    if (ret == E_OK) {
        os_thread_sleep(OS_MS_TO_TICKS(1));
        ret = switch_is_sleep(dev);   /* 读 INH GPIO */
        if (ret == E_OK) {
            switch_poweroff(dev);
        } else {
            /* LPSD 失败，回退：wakein pulse */
            switch_set_wakein(dev, WAKEIN_WAKEUP_STATUS);
            os_thread_sleep(OS_MS_TO_TICKS(1));
            switch_set_wakein(dev, WAKEIN_NORMAL_STATUS);
        }
    }
    return ret;
}
```

## 诊断部分

原驱动只有 link status / SQI / cable test 等基础查询。我新增了覆盖 PMA/PMD Status、100BASE-T1 Status、PHY Status、TX FIFO、Bad Link Counter、Receiver Status、Sleep/Wakeup Status、Undervoltage、Temperature Sensor、LPSD Control 等的读取命令，供故障定位和 ethmon 监控使用。


```c
/* 伪代码：新增的诊断命令分发 */
case ETH_DEV_GET_TEMPERATURE_SENSOR_1:
    *data = phy_read_phy_reg(dev, 0, 3, 0x861B);   /* Temperature Sensor 1 */
    break;
case ETH_DEV_GET_UNDERVOLTAGE_STATUS:
    *data = phy_read_phy_reg(dev, 0, 4, 0x8704);  /* Undervoltage Status */
    break;
case ETH_DEV_GET_SLEEP_STATUS:
    *data = phy_read_phy_reg(dev, 0, 3, 0x8703);   /* TC10 Sleep Status */
    break;
```

## 测试

测试 TC10 睡眠唤醒用了一套组合工具：

| 工具 | 用途 |
|---|---|
| `swtools --sleep 0/16` | ECU 串口命令，控制 Switch/PHY 睡眠 |
| `swtools --wake 0/16` | ECU 串口命令，控制唤醒 |
| pytest + HIL | 自动化测试框架 |
| tcpdump | 抓 TC10 帧（LPSD/LPSR/WUP/WUR） |
| DLT Viewer | 分析 ECU 端日志 |


**三类睡眠判定**：
1. **ping 判定**：sleep 后 ping 失败，wake 后 ping 成功
2. **串口静默判定**：监听 500ms 空窗口确认 ECU 真睡（避免半行日志误判）
3. **功耗判定**：电流 < 阈值（默认 20mA），最长等 20s

## 收获

1. **TC10 规范的工程落地**：理解了 PHY 级低功耗的两级机制（TPS 协商 + LPSD 深睡眠），以及与上层 UDP NM / CAN NM 的协同。协议文档里的 LPSD/LPSR 在代码里就是 reg 0x8702 的 bit0 和对端的 status 寄存器。
2. **多车型代码合并的工程方法**：学会了如何把分叉代码通过编译时配置统一，避免运行时分支开销。这是一份代码源 + 多份配置的车载 ECU 标准做法。
3. **Ready 状态机的容错设计**：理解了"轮询 + 重试 + 超时强制 ready"的思路，以及 SQI 监控 + 硬件复位的自愈机制。500ms 超时强制 ready 是"宁可误报也不能卡死"的工程取舍。
4. **PHY-Switch 端到端集成**：理解了 PHY 的 TC10 协商与 Switch 的双 die LPSD 协同，WUP/WUR 跨 die 转发的完整链路。



