---
title: 'Ethernet中的PHY驱动开发'
description: '分析整理实习期间进行的功能开发，有关Ethernet中的PHY驱动开发'
tags: ['Ethernet', 'PHY', 'Switch', 'TC10', '低功耗']
series: { id: 'intern', order: 1 }
pubDate: 'Jul 12 2026'
---

## 写在前面

这段实习我 NIO 做车载 ECU 嵌入式软件开发，接触到了一个功能改动点，主要负责一个 100BASE-T1 PHY 驱动的多车型合并统一和 TC10 低功耗子模块，并参与了一个双 die Switch 的睡眠唤醒集成联调。写过几篇车载以太网的技术博客（VLAN / MDIO / PHY / Switch / DMA / gPTP），都是讲协议概念到代码实现的映射。这篇算是这些技术博客的"工程实证版"——在真实量产项目里，这些协议机制是怎么落地的，遇到了什么问题，怎么取舍的。所有代码用伪代码形式呈现，具体寄存器地址以 PHY/Switch datasheet 为准，重点讲清楚设计思路和踩坑经验。

## 背景

最初因为不同品牌车型的硬件配置差异，驱动源文件被拆成两份独立维护：一份服务 NIO 品牌车型，一份服务 ONVO 品牌车型，由构建系统在编译时按车型代号分流：

```cmake
# 分叉时期的构建逻辑（简化伪代码）
if (车型属于品牌A)
    编译 phy_driver_brand_a.c
else
    编译 phy_driver_brand_b.c
```

此后近两年，两份代码各自独立演进：品牌 A 版迭代出一套更完善的 TC10 唤醒状态机，品牌 B 版积累了针对旧硬件的 workaround。同一个 PHY 芯片养两套驱动，修一个 bug 要改两份，且行为差异导致跨品牌问题排查困难。

**重构目标**：消除品牌分叉，统一为单一驱动源文件，以更完善的版本为基线合入另一版本的有效特性，剔除过时的硬件 workaround。

## 关键技术点一：MDIO Clause 22 间接访问 Clause 45

### 2.1 为什么需要间接访问

88Q1110 的 TC10 寄存器大多位于 MDIO Clause 45 地址空间（按 device 分组：device 1 = PMA/PMD，device 3 = TC10/诊断，device 4 = Vendor）。但很多车载 MCU 的 MDIO 控制器只支持 Clause 22（5 位 PHY 地址 + 5 位寄存器地址，共 32 个寄存器）。

Marvell PHY 提供了一套标准机制：**用 Clause 22 的 reg 13 和 reg 14 作为窗口，间接访问 Clause 45 空间**。

### 2.2 间接访问封装

核心思路是四步操作：

```c
// 伪代码：用 Clause 22 间接访问 Clause 45 寄存器
uint32_t read_phy_reg(dev, phy_addr, device_addr, reg_addr) {
    // Step 1: 写 reg 13，装载 Clause 45 device address
    write_reg(dev, phy_addr, 13, device_addr, CLAUSE_22);

    // Step 2: 写 reg 14，装载目标寄存器地址
    write_reg(dev, phy_addr, 14, reg_addr, CLAUSE_22);

    // Step 3: reg 13 bit14 置 1，表示地址已装载，触发读操作
    write_reg(dev, phy_addr, 13, (1 << 14) | device_addr, CLAUSE_22);

    // Step 4: 读 reg 14，拿到 Clause 45 寄存器数据
    return read_reg(dev, phy_addr, 14, CLAUSE_22);
}
```

| 步骤 | 操作的 Clause 22 寄存器 | 作用 |
|---|---|---|
| 1 | reg 13 ← device_addr | 选中 Clause 45 device（1/3/4） |
| 2 | reg 14 ← reg_addr | 选中该 device 下的寄存器 |
| 3 | reg 13 ← 0x4000 \| device_addr | bit14=1 触发读写操作 |
| 4 | reg 14 | 读取数据 / 写入数据 |

封装后，上层调用只需 `read_phy_reg(dev, 0, 3, 0x8703)`——`3` 是 device address，`0x8703` 是寄存器地址，底层间接访问细节对上层透明。

## 关键技术点二：TC10 睡眠唤醒状态机

TC10 是 IEEE 802.3cg 定义的低功耗协议，PHY 有三种睡眠模式：

| 模式 | 说明 |
|---|---|
| Normal | 正常工作，链路建立 |
| TPS (Trained Power Save) | 链路训练信息保留，低功耗，可快速恢复 |
| LPSD (Link Pulse Sleep Detect) | 深睡眠，PHY 掉电，仅 LPSD 电路靠备用电源工作 |

### TPS 协商：带重试的睡眠请求

进入 TPS 需要和链路对端协商。请求睡眠后等待握手响应，可能失败，需要重试：

```c
// 伪代码：TPS 协商
std_return_t enter_tps(dev, port) {
    if (已处于 sleep 状态) return OK;

    if (link 未 up) return ERROR;   // 链路未建立无法协商

    for (retry = 1; retry <= 9; retry++) {
        // 写 TC10 控制寄存器 bit0=1，请求本地睡眠
        write_phy_reg(dev, port, 3, TC10_CTRL, read | 0x01);

        sleep(20ms);   // 等待握手超时

        // 读状态寄存器验证是否进入 sleep
        val = read_phy_reg(dev, port, 3, TC10_STATUS);
        if ((val & 0x07) == SLEEP_MODE) return OK;

        // 协商失败，检查链路是否还在
        if (link 未 up) {
            // 链路掉了，临时切 master 重建链路
            if (当前是 slave) {
                write master bit;
                soft_reset;
                sleep(5ms);
                切回 slave;
                soft_reset;
            }
            // 等待链路恢复，最多 100ms
            wait_link_up(max 5 次 × 20ms);
        }
    }
    return ERROR;
}
```

这里有个细节：TPS 协商失败时链路可能掉线，需要临时把 PHY 从 slave 切到 master 重新发起链路训练，等链路恢复后再切回 slave 继续重试。

### LPSD 深睡眠：关电源前的 wake source 配置

LPSD 模式下 PHY 主电源关闭，仅 LPSD 检测电路靠备用电源维持。进入前必须配置好唤醒源，否则 PHY 醒不过来：

```c
// 伪代码：进入 LPSD
std_return_t enter_lpsd(dev) {
    // 清 LPSD power-down 位（保留 LPSD 检测电路供电）
    val = read_phy_reg(dev, 0, 3, LPSD_CTRL);
    val &= ~0x01;
    write_phy_reg(dev, 0, 3, LPSD_CTRL, val);

    // 使能全部唤醒源（bit[4:0] = 0x1F）
    val = read_phy_reg(dev, 0, 3, LPSD_CTRL);
    val |= 0x1F;
    write_phy_reg(dev, 0, 3, LPSD_CTRL, val);

    sleep(10ms);

    // 读 INH 引脚确认真的进入睡眠
    if (is_sleep(dev)) {
        set_power(dev, OFF);   // 关 PHY 主电源
        return OK;
    }
    return ERROR;
}
```

唤醒源 bit[4:0] 含义：
- bit1：MDI 线缆能量唤醒（对端发信号）
- bit2：WAKE_IN 引脚脉冲唤醒（MCU 主动唤醒）
- 其他位：PHY 内部唤醒源

### 唤醒状态机

唤醒是最复杂的部分。唤醒对端（link-partner）时，必须根据 PHY 当前所处状态选择正确的唤醒手段，否则唤醒失败或链路无法重建。

合并前的旧逻辑只有两个分支（INH 高就拉 WAKE_IN，否则按 link 状态处理），**没有区分 TPS 态与 Normal 态**——TPS 态下链路训练信息还在，应该发 WUP（Wake-Up Pulse）而非切 master；只有 Normal 态下 link down 才需要切 master 重新发起训练。

重构后的四态状态机：

```c
// 伪代码：四态唤醒状态机
std_return_t set_wakeup(dev) {
    if (当前处于 SLEEP 态) {
        // 分支一：完整唤醒流程
        // Stage 1: 拉 WAKE_IN 脉冲（PHY 掉电态，只能 GPIO）
        wakeup_step1(dev);

        // 轮询 INH 等 PHY 退出深睡，最多 5 次 × 1ms
        do {
            sleep(1ms);
            is_sleep = check_inh(dev);
        } while (is_sleep && ++retry < 5);

        if (!is_sleep) {
            // Stage 2: 上电 + 释放复位 + MDIO 配置
            power_sequence(dev);
        } else {
            return ERROR;   // 5 次后还在睡，唤醒失败
        }
    } else {
        // 分支二：已唤醒但需重发 WUP/WUR
        if (INH 高) {
            // 状态1: LPSD 深睡 → 拉 WAKE_IN
            wakeup_step1(dev);
        } else {
            val = read_phy_reg(dev, 0, 3, TC10_STATUS);
            if (val == SLEEP_MODE) {
                // 状态2: TPS → 发 WUP（写 TC10_CTRL bit4=1）
                write_phy_reg(..., TC10_CTRL, read | 0x10);
            } else if (link 未 up) {
                // 状态3: Normal + link down → Slave PHY WUP Retry
                linkdown_count++;
                if (linkdown_count >= 3) {
                    // 切 master 5ms 主动唤醒对端，再切回 slave
                    val = read_phy_reg(..., MASTER_SLAVE_CTRL);
                    if (不是 master) {       // 防御性判断
                        write master bit;
                        sleep(5ms);
                        切回 slave;
                    }
                    linkdown_count = 0;
                    上报重试事件;
                }
            } else {
                // 状态4: Normal + link up → 发 WUR
                write_phy_reg(..., TC10_CTRL, read | 0x10);
            }
        }
    }
    return OK;
}
```

**四态对比**：

| 状态 | PHY 状态指示 | 唤醒手段 | 原因 |
|---|---|---|---|
| LPSD 深睡 | INH 高 | 拉 WAKE_IN 引脚 | PHY 掉电，MDIO 不可用 |
| TPS | INH 低 + 0x8703==Sleep | 写寄存器发 WUP | 链路训练信息还在 |
| Normal + link down | INH 低 + link 断 | 切 master 5ms | 需重新发起链路训练 |
| Normal + link up | INH 低 + link 通 | 写寄存器发 WUR | 链路还在，仅需唤醒请求 |


### 两阶段唤醒时序


LPSD 深睡时 PHY 掉电，唤醒必须分两阶段：

**Stage 1**（PHY 掉电态，纯 GPIO 操作）：
```
确认 INH 高（确实在深睡）
→ 拉低 RESET（保持复位态）
→ 拉高 WAKE_IN（发唤醒脉冲）
```

**中间**：轮询 INH，等 PHY 内部 LPSD 电路触发上电、退出深睡（INH 从高变低），最多 5ms。

**Stage 2**（PHY 已脱离深睡，走完整上电时序）：
```
拉高 power-enable（上电）
→ WAKE_IN 恢复常态
→ 释放 RESET（拉高）
→ 等 5ms（PHY 内部初始化）
→ 后续 MDIO 寄存器配置
```

为什么不能合成一步？因为掉电时 MDIO 总线不可用，只能用 GPIO 发硬件信号；必须先发 WAKE_IN 让 PHY 内部上电，等它醒来才能做 MDIO 配置。

## 关键技术点三：上电时序与电源保护

### 完整上电时序


```c
// 伪代码：上电时序
void poweron(dev) {
    // 阶段0: 如果当前掉电，等上一轮残余电压降到阈值以下
    if (!power_is_enabled(dev)) {
        wait_adc_below_threshold(dev);   // break-before-make 保护
    }

    // 阶段1: 上电
    set_power(dev, ON);
    sleep(1ms);

    // 阶段2: 如果在深睡态，发 WAKE_IN 唤醒脉冲
    if (INH 高) {
        set_wakein(WAKEUP);
        sleep(1ms);
        set_wakein(NORMAL);
        sleep(1ms);
    }

    // 阶段3: RESET 时序
    set_reset(RESET);     // 拉低
    sleep(2ms);
    set_reset(NORMAL);    // 释放
    sleep(5ms);           // 等 PHY 内部初始化
}
```

### ADC 残余电压等待：break-before-make

这个细节容易忽略但很重要。PHY 从工作态掉电后，3V3 电源轨电压因电容放电不会立刻归零。如果重新上电前不等残余电压降到阈值以下，可能出现：

- 残余电压 + 新上电电压叠加，PHY 进入不确定状态
- PHY 未完全复位就重新上电，寄存器状态残留

```c
// 伪代码：等待残余电压降到阈值以下
void wait_adc_below_threshold(dev) {
    elapsed = 0;
    while (elapsed <= timeout) {
        // 检查所有配置了阈值的 ADC 通道
        all_below = true;
        for (每个 ADC 通道) {
            if (ADC 值 > 阈值) {
                all_below = false;
                break;
            }
        }
        if (all_below) {
            log("power-on ADC check success after %d ms", elapsed);
            return;
        }
        sleep(polling_period);
        elapsed += polling_period;
    }
    log("power-on ADC check timeout");
}
```

这是电源管理里 break-before-make（先断后通）思路的软件实现——确保上一轮彻底断电再重新上电。

### PHY ID 校验


上电后不能直接配置寄存器，先读 PHY ID 确认 PHY 真的活着且型号正确：

```c
// 伪代码：PHY ID 校验
std_return_t power_sequence(dev) {
    // 先执行 Stage 2 上电时序
    wakeup_step2(dev);

    // 最多重试 5 次读 PHY ID
    for (retry = 0; retry < 5; retry++) {
        phy_id = read_phy_reg(dev, 0, 1, 0x0002);
        if (phy_id == 期望值) {
            break;
        }
    }

    // 清唤醒中断状态
    write_phy_reg(dev, 0, 4, 0x8703, 0xFFFF);

    // 使能包计数器
    enable_packet_counter(dev);

    // TC10 参数初始化
    tc10_init(dev);
}
```

## 关键技术点四：电源状态监控

### 为什么不用 INH 判电源状态

先前用INH来参加判定电源状态，但INH 引脚反映的是 PHY 的**睡眠/工作状态**（深睡时 INH 高），**不是电源电压是否正常**。

考虑这个场景：PHY 处于正常工作模式（INH 低），但 3V3 供电跌到 2.8V（欠压）。这时候 INH 仍然是低，如果用 INH 判电源状态，会认为"电源正常"——但 PHY 已经因欠压工作异常了。


所以电源状态必须用 ADC 采 3V3 电源轨的真实电压判定，和 INH 解耦：

```c
// 伪代码：3V3 电源状态判定
power_state_t get_3v3_power_state(dev) {
    // 通过 ADC 读 3V3 rail 实际电压（毫伏）
    if (read_3v3_voltage(dev, &rail_mv) == OK &&
        get_voltage_limits(dev, &lower_mv, &upper_mv) == OK) {
        if (rail_mv < lower_mv) return UNDERVOLTAGE;
        if (rail_mv > upper_mv) return OVERVOLTAGE;
        return GOOD;
    }
    return UNKNOWN;   // ECU 不支持电压采集时返回未知，不用 INH 兜底
}
```

### 移植层设计


`read_3v3_voltage` 和 `get_voltage_limits` 是 weak 函数，默认实现返回"不可用"。具体 ECU 集成时 override 提供真实实现：

```c
// 弱符号默认实现（驱动里）
__attribute__((weak)) std_return_t read_3v3_voltage(dev, uint16_t* mv) {
    return ERROR;   // 默认：该 ECU 未配置电压采集
}

// ECU 集成代码里 override
std_return_t read_3v3_voltage(dev, uint16_t* mv) {
    // 通过 ADC 读 3V3 rail，转换成毫伏
    *mv = adc_to_mv(adcif_read(...));
    return OK;
}
```

这种设计让驱动代码不依赖具体 ECU 的 ADC 通道配置，由 ECU 侧决定能不能采电压。阈值也与硬件诊断模块保持一致，确保两边判定标准相同。

## 关键技术点五：诊断与监控接口

### 寄存器读取命令库


```c
// 伪代码：统一控制接口
std_return_t control(dev, cmd, data) {
    switch (cmd) {
        case GET_SQI:
            // 读 SQI 寄存器 bit[15:12]
            *data = (read_phy_reg(..., 0x8230) & 0xF000) >> 12;
            break;
        case GET_LINK_FAILURES:
            // 读链路失败计数 bit[9:0]
            *data = read_phy_reg(..., 0x8234) & 0x3FF;
            break;
        case GET_TEMPERATURE:
            *data = read_phy_reg(..., 0x861B);
            break;
        // ... 数十个类似命令
    }
}
```

## 重构成果与总结

| 维度 | 重构前 | 重构后 |
|---|---|---|
| 源文件数量 | 2 份（按品牌分叉，各约 1500 行） | 1 份统一驱动 |
| 构建逻辑 | 按车型代号编译时分流 | 所有车型统一编译 |
| 唤醒状态机 | 二分支（不区分 TPS/Normal） | 四态精确分发 |
| 旧硬件 workaround | 运行时硬件版本判断（双层 #ifdef） | 删除，无条件走 GPIO |
| master 切换 | 无防御性判断，硬编码延时 | 防御性判断 + 参数化宏 |
