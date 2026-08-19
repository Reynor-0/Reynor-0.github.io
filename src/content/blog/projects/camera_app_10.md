---
title: 'Camera 开发（十）：V4L2 采集流 L1 局部恢复'
description: '基于 RK3568 的 V4L2 Camera 应用开发记录，连续采集超时后用 STREAMOFF/QBUF/STREAMON 恢复 capture queue'
tags: ['Camera', 'Linux', 'V4L2', '图像处理']
pubDate: 'Jun 25 2026'
---

## 本篇要解决的问题

上一篇结束的时候，`camera_display_stream` 能长期运行、有状态机和稳定退出码。但遇到连续 3 次采集超时（共 3 秒没帧），程序直接抛异常退出，返回 capture 域 exit 20。这对"偶发性断流"太激进——很多情况下 sensor 只是短暂抖动、ISP 内部状态紊乱、或 CSI 时序瞬时错误，重启 capture queue 就能恢复，不需要重启整个进程。

本篇引入第一层的局部恢复：连续 3 次超时后，不直接退出，而是尝试 `VIDIOC_STREAMOFF → 重新 VIDIOC_QBUF 全部 buffer → VIDIOC_STREAMON`，只重启 V4L2 capture queue，不动 RGA、DRM、进程。如果恢复成功就继续采集；如果恢复本身失败或超过恢复预算，才按 capture 域退出。

本篇结束时，程序能在偶发断流后自动恢复继续显示，不再因一次 sensor 抖动就退出。但本篇还不处理"STREAMOFF/QBUF/STREAMON 本身失败"和"video node 消失"——那是更后面的恢复层级。

## 为什么 L1 恢复能复用原 buffer

L1 recovery 的核心前提是：`STREAMOFF` 不会破坏已有的 mmap 映射和 DMA-BUF fd。这来自 V4L2 的语义约定：

- `VIDIOC_STREAMOFF` 让驱动停止向 buffer 写入、清空 incoming/outgoing queue、把所有 buffer 所有权归还应用。
- 它**不自动解除 mmap**——应用建立的虚拟地址映射仍然有效。
- 它**不关闭 `VIDIOC_EXPBUF` 得到的 DMA-BUF fd**——fd 引用的底层 GEM 内存仍然存在。
- 它**不释放 `REQBUFS` 分配的内核 buffer**——buffer pool 还在，只是从 Streaming 状态回到 BuffersAllocated 状态。

所以恢复流程是：

```text
Streaming                          ← 超时发生时
   │
   │ VIDIOC_STREAMOFF
   ▼
BuffersAllocated (4 buffer 都归应用)
   │
   │ VIDIOC_QBUF buffer 0..3
   ▼
BuffersAllocated (4 buffer 都归驱动)
   │
   │ VIDIOC_STREAMON
   ▼
Streaming                          ← 恢复完成，继续采集
```

这正好对应第 2 篇 `V4L2BufferQueue` 的状态机：`Streaming → stop() → BuffersAllocated → queueAll() → BuffersAllocated → start() → Streaming`。`stop()` 调 `STREAMOFF`，`queueAll()` 调 `QBUF`，`start()` 调 `STREAMON`——三个已有方法直接复用，不需要新写 ioctl 逻辑。

### 恢复入口的安全约束

恢复只从 `poll()` 连续超时路径触发。此时应用**没有持有一块已经 DQBUF、仍被 RGA 读取的源 buffer**——所有 capture buffer 都在驱动的 incoming queue 里等着被填充。所以执行 `STREAMOFF` 不会破坏正在进行的 RGA 作业（RGA 读的是上一帧已 DQBUF 的 buffer，那个 buffer 早已 `requeue` 回去了）。

DRM 端与 V4L2 端使用不同的物理存储。采集恢复期间 VOP 继续扫描最近一次成功显示的 DRM framebuffer，屏幕暂时停在最后一帧，不会变黑或显示未完成的数据。

## 恢复预算：避免重启风暴

如果 sensor、CSI 或 ISP 已经永久故障，无限制执行 `STREAMOFF/ON` 会产生重启风暴：CPU 和内核反复执行 ioctl、日志不断增长、真正的故障原因被重复信息淹没、可能进一步干扰驱动恢复。所以恢复必须有预算。

当前固定策略：

| 参数 | 值 |
| --- | --- |
| 单次 poll 超时 | 1000 ms |
| 触发恢复的连续超时数 | 3 |
| 滑动时间窗口 | 60 s |
| 窗口内最多恢复尝试 | 3 |

### CaptureRecoveryBudget：滑动窗口实现

```cpp
class CaptureRecoveryBudget {
public:
    bool tryAcquire() {
        const std::chrono::steady_clock::time_point now = std::chrono::steady_clock::now();
        const std::chrono::seconds window(kCaptureRecoveryBudgetWindowSeconds);
        // 清除已经移出窗口的旧记录
        while (!attempts_.empty() && now - attempts_.front() > window) {
            attempts_.pop_front();
        }
        // 窗口已达上限则拒绝
        if (attempts_.size() >= kCaptureRecoveryBudgetMaxAttempts) {
            return false;
        }

        attempts_.push_back(now);
        return true;
    }

    std::size_t attemptsInWindow() const noexcept {return attempts_.size();}

private:
    std::vector<std::chrono::steady_clock::time_point> attempts_;
};
```

`tryAcquire()` 做两件事：先清除窗口外的旧记录（`now - front >= 60s`），再检查剩余数量是否已达上限。用一个 `std::vector<time_point>` 记录每次尝试的时间——窗口外的从前面 erase，窗口内的从后面 push。这是"滑动窗口"的标准实现，比"固定 60 秒计时器重置"更精确（后者在边界附近会多算或少算）。

### 预算耗尽即退出

预算耗尽时 `tryAcquire()` 返回 false，`recoverCaptureStream` 抛异常：

```cpp
if (!budget->tryAcquire()) {
    ++statistics->capture_recovery_budget_exhaustions;
    std::cerr << "Recovery capture: BUDGET_EXHAUSTED level=L1 ..."
              << "\n";
    throw std::runtime_error(
        "capture stream recovery budget exhausted: " + ...);
}
```

这个异常被 `runStream` 的 catch 捕获，包装成 `PipelineFailure(Capture, exit 20)` 退出。也就是说"预算耗尽"和"恢复本身失败"走同一条退出路径——都返回 capture 域 exit 20。这个退出码对上层意味着"摄像头持续断流，退避后重启 worker 可能有用"。

## recoverCaptureStream：三步恢复

```cpp
void recoveryCaptureStream(V4L2BufferQueue& queue, CaptureRecoveryBudget* budget, StreamStatistics* statistics)
{
    if (budget == nullptr || statistics == nullptr) {
        throw std::invalid_argument("budget and statistics must not be null");
    }

    if (!budget->tryAcquire()) {
        ++statistics->capture_recovery_budget_exhaustions;
        std::cerr << "Recovery capture: BUDGET_EXHAUSTED level=L1 ..."
                  << "\n";
        throw std::runtime_error(
            "capture stream recovery budget exhausted: " + ...);
    }

    ++statistics->capture_recovery_attempts;
    const std::uint64_t attempt = statistics->capture_recovery_attempts;
    const auto recovery_start = std::chrono::steady_clock::now();
    std::cout << "Recovery capture: STARTING level=L1 attempt=" << attempt
              << " reason=consecutive-timeouts attempts_in_window="
              << budget->attemptsInWindow() << '\n';

    try{
        queue.stop();       // VIDIOC_STREAMOFF
        queue.queueAll();   // VIDIOC_QBUF × 4
        queue.start();      // VIDIOC_STREAMON
    } catch (...) {
        ++statistics->capture_recovery_failures;
        std::cerr << "Recovery capture: FAILED level=L1 attempt=" << attempt
                  << '\n';
        throw;
    }

    const auto elapsed_milliseconds = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - recovery_start).count();
    ++statistics->capture_recovery_successes;
    statistics->capture_recovery_total_time_ms += elapsed_milliseconds;
    statistics->sequence_baseline_pending = statistics->have_sequence;
    std::cout << "Recovery capture: SUCCEEDED level=L1 attempt=" << attempt
              << " elapsed_ms=" << elapsed_milliseconds << '\n';
}
```

三个关键点：

**预算先检查再恢复。** `tryAcquire()` 必须在 `queue.stop()` 之前——如果预算已耗尽，不应该再执行 `STREAMOFF`（那会清空 queue 但又恢复不回来，状态更糟）。预算通过才记录本次时间、执行恢复。

**三步任一失败都算恢复失败。** `try { stop(); queueAll(); start(); } catch (...) { ++failures; throw; }`——任一步抛异常，计数后重抛，由上层 `runStream` 的 catch 包装成 `PipelineFailure` 退出。不尝试"部分恢复"——比如 `STREAMOFF` 成功但 `STREAMON` 失败，此时 queue 处于 BuffersAllocated 状态，进程应该直接退出而不是继续尝试。

**`sequence_baseline_pending` 标记。** `STREAMOFF/ON` 后 V4L2 sequence 可能继续递增，也可能从较小值重新开始。恢复后的第一帧只建立新的 sequence 连续性基线，不能把驱动合法重置误报成大量丢帧。这个标记在 `updateStatistics` 里被检查：

```cpp
if (!statistics->have_sequence) {
    /* 第一帧：建立基线 */
} else if (statistics->sequence_baseline_pending) {
    /* 恢复后第一帧：重置基线，不计 gap */
    statistics->last_sequence = frame.sequence;
    statistics->sequence_baseline_pending = false;
} else {
    /* 正常：检查 sequence != last+1 则计 gap */
}
```
## 主循环：触发条件

主循环里触发恢复的条件是"连续 3 次超时"：

```cpp
const bool frame_ready = diagnostic_timeout_streak_active ? false : queue.waitForFrame(kCapturePollTimeoutMilliseconds);

if (!frame_ready) {
    if (!controller.shouldContinue()) {
        continue;   // 信号触发的停止不算超时
    }

    ++statistics.timeouts;
    ++consecutive_timeouts;
    if (consecutive_timeouts >= kCaptureTimeoutRecoveryThreshold) {
        recoverCaptureStream(queue, &capture_recovery_budget, &statistics);
        consecutive_timeouts = 0U;
        /* ... 故障注入计数 ... */
    }
    continue;
}
```
几个要点：

**`poll` 被信号打断不算超时。** `controller.shouldContinue()` 返回 false 时说明是 SIGINT/SIGTERM 导致的 `EINTR`，不计入 `consecutive_timeouts`。这避免"正常停止时误触恢复"。

**恢复成功后 `consecutive_timeouts` 清零。** 恢复成功意味着 queue 重新开始出帧，下一帧应该很快到达。如果恢复后又开始超时，从 0 重新计数 3 次——不会因为"恢复后又超时"立即再次恢复，要再等 3 秒。

**`continue` 跳过本次循环。** 恢复后不立即 `tryDequeue`，而是回到 `while` 顶部检查 `shouldContinue` 再 `waitForFrame`。这样恢复后如果立刻收到停止信号，不会因为尝试 DQBUF 而错过退出。

## 故障注入：不拔线测试恢复

真实断开 Sensor/CSI 可能影响 BSP 状态，不适合作为每次编译后的自动测试。所以程序提供显式诊断选项：

```bash
--inject-capture-timeout-recoveries N
```

它在至少 10 帧正常显示后，让用户态控制流连续把 `frame_ready` 当作 false，从而经过与真实 poll 超时相同的计数、预算和 `STREAMOFF/ON` 代码。它**不会**修改驱动、设备树、Sensor 或 ISP，也不声称验证了真实硬件断流。

```cpp
if (!diagnostic_timeout_streak_active &&
    diagnostic_recoveries_completed < options.injected_capture_recoveries &&
    statistics.displayed_frames >= next_diagnostic_injection_frame) {
    diagnostic_timeout_streak_active = true;
    std::cout << "Diagnostic injection: capture timeout streak="
              << (diagnostic_recoveries_completed + 1U)
              << " after_displayed_frames="
              << statistics.displayed_frames << '\n';
}
```

`kDiagnosticFramesBetweenRecoveries = 10` 保证两次注入之间至少 10 帧正常显示——避免连续注入导致预算耗尽误判。每次注入触发一次"连续 3 次超时" → 一次 `recoverCaptureStream` → 恢复成功 → 继续 10 帧 → 下一次注入。

注入 4 次时，前 3 次消费预算成功恢复，第 4 次因预算耗尽退出 exit 20——这是验证"预算机制有效"的测试用例。

## 板端复现与验收

**一次注入恢复后继续运行 4 秒：**

```bash
adb shell "/home/reynor/camera-project/bin/camera_display_stream \
  --stream 4 \
  --confirm-desktop-stopped \
  --color-mode bt709-limited \
  --inject-capture-timeout-recoveries 1 \
  /dev/video0 /dev/dri/card0"
# 期望输出：
#   Diagnostic injection: capture timeout streak=1 after_displayed_frames=10
#   Recovery capture: STARTING level=L1 attempt=1 reason=consecutive-timeouts attempts_in_window=1
#   Recovery capture: SUCCEEDED level=L1 attempt=1 elapsed_ms=123
#   ...
#   Capture stream recoveries: attempted=1 succeeded=1 failed=0 budget_exhausted=0
#   Capture recovery total ms: 123
#   captured/displayed: 108/108
#   sequence gaps: 0
#   final state: STOPPED
#   exit: 0
```

**60 秒窗口内注入 4 次（预算耗尽）：**

```bash
adb shell "/home/reynor/camera-project/bin/camera_display_stream \
  --stream 10 \
  --confirm-desktop-stopped \
  --color-mode bt709-limited \
  --inject-capture-timeout-recoveries 4 \
  /dev/video0 /dev/dri/card0"
# 期望输出：
#   attempt 1: SUCCEEDED, 127 ms
#   attempt 2: SUCCEEDED, 135 ms
#   attempt 3: SUCCEEDED, 123 ms
#   attempt 4: BUDGET_EXHAUSTED
#   Lifecycle: FAILED domain=capture
#   Exit code: 20
```

两组用例后均无 `camera_display_stream` PID、DRM client 或 `/dev/video0` fd 持有者。

**WSL 自动化测试：**

```bash
ADB=/home/reynor/tools/platform-tools/adb \
ADB_SERIAL=8b34888e45c927c6 \
  ./tools/test_camera_capture_recovery_rk3568.sh \
  /dev/video0 bt709-limited
```

脚本跑完两个用例 + 资源审计 + forever+SIGTERM 回归，每轮检查无残留 DRM client 或 video fd。

这些数字来自用户态故障注入，证明真实 RK3568 驱动能够完成 `STREAMOFF`/重新 `QBUF`/`STREAMON` 并继续出帧，但还没有覆盖物理断开 Sensor 或 CSI 错误。

## 当前阶段与下一篇

本篇结束时，程序能在偶发采集超时后自动恢复，不再因一次 sensor 抖动就退出。但 L1 有个明显局限：`STREAMOFF`、`QBUF` 或 `STREAMON` 本身失败时，程序直接退出，不会尝试更激进的恢复。另外 `ENODEV`（video node 消失）、`EIO`/`EPIPE`（设备级错误）这些 errno 也无法用 L1 处理——它们意味着设备本身有问题，不只是 queue 状态紊乱。

下一篇要做的是 L2 session rebuild：把 V4L2 设备、格式协商、buffer pool 封装成一个可销毁重建的 `CaptureSession` 类。L1 恢复失败时，不直接退出，而是销毁整个 capture session（close fd + 释放 buffer + munmap），重新 open video node、重新协商格式、重新申请 buffer、重新导出 DMA-BUF。这比 L1 激进得多——相当于"重启摄像头子会话"，但能处理 L1 处理不了的设备级故障。