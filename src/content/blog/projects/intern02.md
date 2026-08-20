---
title: 'TXE-8124的Trap问题'
description: '分析整理实习期间进行的功能开发，有关TXE-8124的Trap问题'
tags: ['io_expander', 'trap', '异步模型', 'txe8124']
series: { id: 'intern', order: 2 }
pubDate: 'Jul 13 2026'
---

## 背景

txe8124通过SPI总线扩展出24路GPIO，用于弥补MCU自身GPIO不够的情况。先前该芯片是调用方直接操纵总线的同步模型，但随着两个需求的出现，架构演进成了**生产者-消费者**的异步模型：

1. **多核 MCU 适配**：非主核也要访问 IO 扩展芯片，但总线只能由主核驱动，需要核间转发
2. **并发安全**：多个调用方同时操作总线会冲突，需要串行化

最终架构变成：调用方（中断 ISR、write 接口）把请求塞进 FIFO，后台线程串行消费执行。

```c
// 伪代码：异步架构引入的两个长生命周期资源
os_thread_t g_thread_handle = NULL;   // 后台消费线程
os_fifo_t   g_fifo_hdl      = NULL;   // 请求队列
bool        g_resource_init_flag = FALSE;
```

初始化时创建：

```c
// 伪代码：init 阶段创建线程和 FIFO
void init_resources() {
    os_fifo_create(&g_fifo_hdl, ...);              // 创建 FIFO
    os_thread_create(&g_thread_handle, ...);        // 创建线程，routine = main_thread
}
```

后台线程是个死循环，不断从 FIFO 出队消费：

```c
// 伪代码：消费者线程
void main_thread() {
    while (1) {                                     // 永不退出
        if (os_fifo_dequeue(g_fifo_hdl, &event) == OK) {
            // 读请求：清中断 → 读寄存器 → 触发回调
            // 写请求：写寄存器 → 回读校验 → 更新缓存
            // 都会访问 device、bus 等句柄
        }
    }
}
```

生产者（中断 ISR、write 接口）入队并通知线程：

```c
// 伪代码：中断处理（生产者）
void int_handle(device_id) {
    if (async_op_enabled && scheduler_started) {
        event.op = READ;
        os_fifo_enqueue(g_fifo_hdl, &event);        // 入队
        os_thread_notify_send(g_thread_handle);     // 唤醒线程
    }
}
```

至此架构是自洽的。但是出现了一个问题**txe8124线程访问 SPI 引起 trap**，通过查看DLT日志发现常在standby阶段发生。

## 定位原因

```c
// 伪代码：BUG 版本 deinit
void deinit(device) {
    clear_interrupt(device);          // 清中断
    device->status = UNINITIALIZED;   // 标记未初始化
    // ← 后台线程？FIFO？完全没处理
}
```

这是问题版本的deinit，它只做了"清中断 + 改状态标志"，**完全没有处理后台线程和 FIFO**。
把这个 deinit 放回 standby 唤醒时序里，竞争窗口就清楚了：

```
时间轴 →

[standby 准备阶段]  EcuM 调用 txe8124_deinit()
                      │
                      ├─ clear_interrupt(device)
                      │   ↑ 这一刻，设备/总线句柄仍然有效
                      │
                      ├─ device->status = UNINITIALIZED
                      │   ↑ 标志置位，但后台线程仍在 while(1) 里
                      │     可能在阻塞等 FIFO，也可能正准备 dequeue
                      │
                      └─ deinit 返回，EcuM 继续拆其他驱动
                          ↑ 此刻 device / bus 句柄即将被上层释放

   与此同时（并行）：
   后台线程 g_thread_handle 仍活着
     ↓
   可能正好 dequeue 到一个事件（唤醒源刚到时 ISR 入队的那批）
     ↓
   执行消费逻辑：
     get_handler(event.dev_id)  → 拿到的 device 可能已释放
     clear_interrupt(dev_id)    → 访问已失效的总线句柄
     update_port_value(device)  → 解引用野指针 → trap
```

trap 只在"deinit 刚执行完、device/bus 句柄刚被上层释放，而后台线程恰好在这个极短窗口里 dequeue 到事件并开始访问 SPI"时才发生。线程阻塞在 `os_fifo_dequeue` 的大部分时间是无害的，只有恰好跨越 deinit 那一刻才会踩到。这就是 standby 唤醒时序下偶发 trap 的本质。

**trap 的本质**：后台线程的生命周期超越了它所依赖的设备资源。线程还在消费事件，但事件里引用的设备句柄、总线句柄、回调函数指针全都已经失效。这相当于——**工厂拆了流水线，但工人还在干活，手伸向了已经搬走的机器**。而 standby 唤醒这个场景，恰好是"工厂要拆流水线时又来了一笔新订单（唤醒源）"，时序最容易撞上。

## 修复

分析清楚了原因，那么首先就需要在deinit开头就把后台线程删了。


```c
// 伪代码
void deinit(device) {
    if (g_thread_handle != NULL) {
        if (os_thread_delete(g_thread_handle) != OK) {
            log_error("failed to delete thread");
        } else {
            g_thread_handle = NULL;        // 置空，防悬垂句柄
            g_resource_init_flag = FALSE;
        }
    }

    if (device != NULL) {
        clear_interrupt(device);
        device->status = UNINITIALIZED;
    }
}
```

但还有一些问题：
1. FIFO 没清理，资源泄漏：`g_fifo_hdl` 仍然有效，里面可能还残留事件。

2. 状态置位顺序反了：

```c
// 伪代码：第一次修复的顺序（有问题）
clear_interrupt(device);          // ① 还在访问设备
device->status = UNINITIALIZED;   // ② 后置状态
```

清中断时设备还是 `INITIALIZED` 状态，如果此时中断触发，ISR 看到 `device->b_async_op` 仍为真就会入队——但线程已经删了，事件会永远滞留在 FIFO 里（线程没了，没人消费）。

3. 生产者没有句柄校验

```c
// 伪代码：修复前不检查句柄
void int_handle(device_id) {
    if (async_op_enabled && scheduler_started) {
        os_fifo_enqueue(g_fifo_hdl, &event);
        os_thread_notify_send(g_thread_handle);   // 句柄可能已 NULL
    }
}
```

deinit 后线程句柄为 NULL，`os_thread_notify_send(NULL, ...)` 的行为依赖 OS 实现——可能 trap，可能静默失败，都是隐患。

最后有以下完整的修复：

### 提取 deinit_resources

```c
// 伪代码：独立的资源清理函数
void deinit_resources() {
    // 1. 删线程
    if (g_thread_handle != NULL) {
        if (os_thread_delete(g_thread_handle) == OK) {
            g_thread_handle = NULL;
        }
    }
    // 2. 线程删成功后才 reset FIFO
    //    （避免线程还在跑时动 FIFO 造成竞争）
    if (ret == OK && g_fifo_hdl != NULL) {
        os_fifo_reset(g_fifo_hdl);
        g_fifo_hdl = NULL;
    }
}
```


### 调整 deinit 调用顺序

```c
// 伪代码：完整修复后的 deinit
void deinit(device) {
    if (device != NULL) {
        device->status = UNINITIALIZED;        // ① 先置状态（停生产）
        clear_interrupt(device);               // ② 再清中断（切断中断源）
    }

    if (deinit_resources() == OK) {            // ③ 删线程 + 清 FIFO
        g_resource_init_flag = FALSE;
    }
}
```

### 给生产者加句柄校验

```c
// 伪代码：修复后生产者检查句柄
void int_handle(device_id) {
    if (async_op_enabled && scheduler_started
        && g_thread_handle != NULL             // 新增校验
        && g_fifo_hdl != NULL) {               // 新增校验
        os_fifo_enqueue(g_fifo_hdl, &event);
        os_thread_notify_send(g_thread_handle);
    }
}
```

write 接口同样加这两个校验。这样 deinit 把句柄置 NULL 后，生产者立刻看到 NULL 就不再入队，不会再拿悬垂句柄调 OS API。

## 这个 trap 反映的通用原则

这个 case 是嵌入式多线程驱动里一个**很经典的资源生命周期问题**。核心原则可以提炼为一句话：

> **生产者-消费者模型拆除时，必须按"先停生产 → 再停消费 → 最后清缓冲"的顺序，且句柄置空和入队校验必须配套。**

| 步骤 | 做什么 | 不做的后果 |
|---|---|---|
| 停生产 | 置状态标志 + 清中断源 | 消费者停了但生产者还在塞，事件滞留或访问已释放资源 |
| 停消费 | 删线程 | 线程继续访问已释放的设备/总线句柄 → trap |
| 清缓冲 | reset FIFO | 资源泄漏；残留事件下次 init 被错误消费 |
| 置空句柄 | handle = NULL | 生产者拿悬垂句柄调 OS API → 行为未定义 |
| 校验句柄 | 入队前检查 != NULL | 置空了也没用，生产者照样调用 NULL 句柄 |




