---
title: 'Camera 开发（十一）：V4L2 CaptureSession 会话重建'
description: '基于 RK3568 的 V4L2 Camera 应用开发记录，L1 失败后销毁并重建完整 V4L2 capture session'
series: { id: 'camera-development', order: 11 }
tags: ['Camera', 'Linux', 'V4L2', '图像处理']
pubDate: 'Jun 26 2026'
---

## 本篇要解决什么？

第 10 篇的 L1 stream recovery 能处理"queue 状态紊乱"——`STREAMOFF/QBUF/STREAMON` 三步重启 capture queue。但 L1 有个根本局限：它复用同一个 video fd 和同一组 buffer。如果 `STREAMOFF`、`QBUF` 或 `STREAMON` **本身**失败，说明这个 fd 或 buffer pool 的状态已经不可靠——继续用它只会继续失败。另外 `poll()` 报告错误、`DQBUF` 返回无法验证的 metadata、`requeue` 失败，这些都不是 queue 状态问题，而是设备级问题，L1 处理不了。

本篇引入第二层局部恢复（L2 session rebuild）：把 V4L2 设备、格式协商、buffer pool、DMA-BUF fd 封装成一个可销毁重建的 `CaptureSession` 类。L1 失败后，不直接退出，而是**销毁整个 capture session**——`STREAMOFF` + close fd + munmap + 关 DMA-BUF fd + `REQBUFS(count=0)`，然后重新 `open /dev/video0`、重新协商格式、重新申请 buffer、重新导出 DMA-BUF、重新 `STREAMON`。这相当于"重启摄像头子会话"，但不动 RGA、DRM、进程。

本篇结束时，程序能在 L1 处理不了的故障后自动重建 V4L2 session 继续运行。但本篇还不处理"video node 消失"（`ENODEV`）和"新 session 首次创建失败后反复 open"——那是更后面的恢复层级。

## L1 vs L2：恢复成本对比

| | L1 stream recovery | L2 session rebuild |
| --- | --- | --- |
| 范围 | 同一 fd 的 queue | 完整 V4L2 会话 |
| 动作 | `STREAMOFF → QBUF → STREAMON` | close fd + 重开 + 全部重新协商 |
| 复用 buffer | ✅ 原 mmap 和 DMA-BUF fd 不动 | ❌ 全部销毁重建 |
| 耗时 | ~120 ms | ~130 ms（实测） |
| 处理能力 | queue 状态紊乱 | fd 损坏、ioctl 失败、metadata 不可验证 |
| 预算 | 60s 内 3 次 | 60s 内 2 次 |
| 退避 | 无 | 200ms、400ms |

L2 耗时和 L1 接近（都 100ms 级），因为主要耗时是 `STREAMON` 后 ISP 首帧稳定，不是 `open/close` 本身。但 L2 的"破坏性"更强——所有 capture buffer 的 fd 和 mmap 地址都变了，RGA 必须用新的 fd，不能缓存旧 fd。所以 L2 成功后主循环要重新拿 `session.format()` 和 `session.queue().dmaBufFd()`。

## CaptureSession：会话的唯一所有者

前 10 篇里 V4L2 资源分散在两个对象：`V4L2Device`（fd）和 `V4L2BufferQueue`（buffer pool，借用 fd）。这种"两个独立对象"在重建时有个麻烦——必须先销毁 queue（它借用 fd），再销毁 device（它拥有 fd），顺序不能错。如果重建逻辑散在 `runStream` 里，每个 L2 触发点都要手写这个顺序，容易漏。

所以本篇把它们封装成一个 `CaptureSession` 类，由它统一拥有 fd 和 queue，重建逻辑集中在一个 `rebuild()` 方法里：

```cpp
class CaptureSession {
public:
    explicit CaptureSession(const CaptureSessionConfig& config);
    ~CaptureSession();

    CaptureSession(const CaptureSession&) = delete;
    CaptureSession& operator=(const CaptureSession&) = delete;
    CaptureSession(CaptureSession&&) = delete;
    CaptureSession& operator=(CaptureSession&&) = delete;

    void rebuild();
    V4L2BufferQueue& queue();
    const VideoFormat& format() const;
    std::uint64_t generation() const noexcept;

private:
    CaptureSessionConfig config_;
    std::unique_ptr<V4L2Device> device_;
    std::unique_ptr<V4L2BufferQueue> queue_;
    VideoFormat format_;
    std::uint64_t generation_{0U};
};
```

`CaptureSessionConfig` 保存跨 rebuild 不变的请求参数（设备路径、宽高、fourcc、buffer 数、颜色元数据）。`generation` 每次成功 rebuild 递增——首次为 1，第一次 L2 后为 2，以此类推。这个数字让日志和上层能判断"当前是第几代会话"。

### 成员声明顺序与析构安全

注意成员声明顺序：`device_` 在 `queue_` 之前。C++ 成员析构按声明逆序——`queue_` 先析构，`device_` 后析构。这正好满足"先销毁借用者（queue），再销毁所有者（device）"的安全要求。

`device_` 和 `queue_` 都用 `std::unique_ptr` 而不是直接成员——因为 `rebuild()` 要在对象生命周期内替换它们。直接成员没法"销毁再重建"，`unique_ptr` 可以 `reset()`。

### 禁止移动

```cpp
CaptureSession(CaptureSession&&) = delete;
CaptureSession& operator=(CaptureSession&&) = delete;
```

第 1 篇 `V4L2Device` 禁止复制但不提移动；本篇 `CaptureSession` 连移动也禁了。原因是 `CaptureSession` 持有 `unique_ptr<V4L2BufferQueue>`，而 `V4L2BufferQueue` 内部借用 `V4L2Device` 的 fd——如果 `CaptureSession` 被移动，`queue_` 借用的 fd 指向的 `device_` 会跟着移动，但 `V4L2BufferQueue` 内部存的 `fd_` 是裸 int，不会自动更新。移动后 `queue_` 仍用旧 fd，而旧 `device_` 已被析构 close 了——use-after-close。禁移动彻底避免这个坑。

## rebuild()：销毁并重建会话

```cpp
void CaptureSession::rebuild()
{
    // queue 借用 device fd，必须先销毁。错误后的 queue 可能仍是 Streaming，
    // V4L2BufferQueue 析构会执行不抛异常的 STREAMOFF 和 buffer 回收。
    queue_.reset();
    device_.reset();
    format_ = VideoFormat();

    // replacement_queue 声明在 replacement_device 之后，异常回滚时按反序先释放
    // queue，再关闭它借用的 fd。只有所有初始化步骤成功才提交为当前 session。
    std::unique_ptr<V4L2Device> replacement_device(
        new V4L2Device(config_.device_path));
    const VideoFormat replacement_format = replacement_device->setFormat(
        config_.width, config_.height,
        config_.pixel_format, config_.requested_color);
    std::unique_ptr<V4L2BufferQueue> replacement_queue(
        new V4L2BufferQueue(*replacement_device, replacement_format));
    replacement_queue->requestBuffers(config_.buffer_count);
    replacement_queue->exportDmaBuffers();
    replacement_queue->queueAll();
    replacement_queue->start();

    device_ = std::move(replacement_device);
    queue_ = std::move(replacement_queue);
    format_ = replacement_format;
    ++generation_;
}
```

### 为什么不"先建新再切旧"

常见的无停机重建模式是"先创建新会话，成功后交换，再销毁旧会话"。但 `rebuild()` 故意不这么做——它先销毁旧会话，再创建新会话：

```text
queue_.reset()    ← 销毁旧 queue
device_.reset()   ← close 旧 fd
new V4L2Device    ← open 新 fd
new V4L2BufferQueue + requestBuffers + exportDmaBuffers + queueAll + start
std::move 提交    ← 全部成功才成为当前 session
```

原因：RKISP capture node 代表同一条硬件 pipeline。如果旧 fd 和旧 queue 仍存在时就打开替代 fd，两个会话可能争夺格式、streaming 状态或驱动资源。先彻底销毁旧会话，硬件所有权清楚，再创建新会话不会冲突。

代价是 rebuild 期间没有新帧——但 L2 本来就是"故障后恢复"，短暂停帧可接受。好处是不会有"两个 fd 争用同一硬件"的复杂错误。

### replacement 先建再提交

`replacement_device` 和 `replacement_queue` 是局部 `unique_ptr`，不是直接赋值给成员。只有 `requestBuffers + exportDmaBuffers + queueAll + start` 全部成功，才 `std::move` 到 `device_` 和 `queue_`。如果任一步抛异常：

- 局部 `replacement_queue` 先析构（声明在 `replacement_device` 之后，逆序析构）
- 局部 `replacement_device` 后析构（close fd）
- 成员 `device_`/`queue_` 仍是 `nullptr`（`reset()` 清空了）
- 对象处于"没有活动 queue"状态，`queue()` 调用会抛 `std::logic_error`

这是"要么完整重建，要么不留半成品"的 RAII 原则——重建失败不留下半初始化的成员，调用方能明确判断"session 已失效，该退出"。

### 为什么析构只 `= default`

```cpp
CaptureSession::~CaptureSession() = default;
```

析构函数什么都不用写——`unique_ptr` 成员的析构会自动 `reset()`，触发 `V4L2BufferQueue` 和 `V4L2Device` 的析构（它们自己有 RAII 清理）。`= default` 让编译器生成默认析构，比手写 `queue_.reset(); device_.reset();` 更简洁，也不会漏掉成员。

## 触发 L2 的场景

主循环里 L2 的触发点比 L1 多。L1 只在"连续超时"触发；L2 在以下情况触发：

### 场景 1：L1 失败后升级

```cpp
try {
    recoverCaptureStream(capture.queue(), &capture_recovery_budget,
                         &statistics, inject_l1_failure);
} catch (const RecoveryBudgetExhausted&) {
    throw;   // L1 预算耗尽，直接退出
} catch (const std::exception& l1_error) {
    if (inject_l1_failure) {
        ++diagnostic_stream_failures_completed;
    }
    recoverCaptureSession(capture, &capture_session_recovery_budget,
                          &statistics, l1_error.what());
    failure_domain = FailureDomain::Configuration;
    adoptCaptureSessionFormat(capture, options, &format, &color_mode);
    failure_domain = FailureDomain::Capture;
}
```

L1 的 `STREAMOFF/QBUF/STREAMON` 任一步失败 → catch `std::exception` → 调 `recoverCaptureSession` 升级 L2。注意 `RecoveryBudgetExhausted` 单独 catch 并 `throw`——L1 预算耗尽说明系统持续抖动，不绕过预算继续 L2，直接退出。

### 场景 2：poll/DQBUF/requeue 失败

`waitForFrame`、`tryDequeue`、`requeue` 任一抛异常都直接 L2，不经过 L1——因为这些不是"queue 状态紊乱"，而是设备级错误，L1 的 `STREAMOFF/ON` 不会解决：

```cpp
try {
    frame_ready = capture.queue().waitForFrame(kCapturePollTimeoutMilliseconds);
} catch (const std::exception& capture_error) {
    recoverCaptureSession(capture, &capture_session_recovery_budget,
                          &statistics, capture_error.what());
    adoptCaptureSessionFormat(capture, options, &format, &color_mode);
    continue;
}
```

三个调用点（poll、DQBUF、requeue）都包在独立 try 里，每个 catch 都走同一 L2 路径。这种"每个 V4L2 操作都可能触发 L2"的写法代码重复，但保证了"任何 capture 域异常都能恢复"的覆盖。

### 为什么 requeue 失败也 L2

`requeue` 失败通常意味着 buffer index 不对或 queue 状态异常。buffer 所有权此时不明——应用持有一块"想还还不了"的 buffer。与其尝试单独把这块 buffer QBUF 回去（可能更糟），不如销毁整个 session 重建所有权。`capture_session_recovery.md` 第 4 节特意说明：

> 同步 RGA 已经读取完成后发生 QBUF 失败，旧源 buffer 不再被 RGA 使用，可以安全销毁整个 capture session。

## recoverCaptureSession：退避 + 独立预算

```cpp
void recoverCaptureSession(CaptureSession& session,
                           RecoveryBudget* budget,
                           StreamStatistics* statistics,
                           const std::string& cause)
{
    if (!budget->tryAcquire()) {
        ++statistics->capture_session_recovery_budget_exhaustions;
        std::cerr << "Recovery capture: BUDGET_EXHAUSTED level=L2 ..."
                  << '\n';
        throw RecoveryBudgetExhausted(
            "capture session recovery budget exhausted: " + ...);
    }

    ++statistics->capture_session_recovery_attempts;
    const std::uint64_t attempt = statistics->capture_session_recovery_attempts;
    const std::uint32_t backoff_milliseconds =
        budget->attemptsInWindow() == 1U ? 200U : 400U;
    std::cout << "Recovery capture: STARTING level=L2 attempt=" << attempt
              << " cause=" << cause
              << " backoff_ms=" << backoff_milliseconds
              << " attempts_in_window=" << budget->attemptsInWindow() << '\n';

    std::this_thread::sleep_for(std::chrono::milliseconds(backoff_milliseconds));
    /* ... session.rebuild() ... */
}
```

### 两级预算独立

L2 有自己的 `RecoveryBudget`（60s 内 2 次），和 L1 的预算（60s 内 3 次）独立。L1 预算耗尽不会绕过限制继续 L2——L1 预算耗尽抛 `RecoveryBudgetExhausted`，主循环 catch 后直接 `throw` 退出，不调 L2。

为什么 L2 预算更紧（2 次 vs 3 次）？因为 L2 成本更高（close/open fd + 全部重建），反复 L2 说明硬件确实坏了，不值得继续试。L2 第三次请求被拒绝，worker 以 capture 域 exit 20 退出。

### 200ms/400ms 退避

```cpp
const std::uint32_t backoff_milliseconds =
    budget->attemptsInWindow() == 1U ? 200U : 400U;
std::this_thread::sleep_for(std::chrono::milliseconds(backoff_milliseconds));
```

第一次 L2 等 200ms，第二次等 400ms。退避的目的是给硬件恢复时间——某些 ISP 故障需要短暂间隔才能重新 open 成功。`std::this_thread::sleep_for` 是 C++11 的阻塞睡眠，简单直接。

## adoptCaptureSessionFormat：重验证格式

L2 成功后不能直接用旧 `format` 和 `color_mode`——重新 open 设备后驱动可能调整格式。`adoptCaptureSessionFormat` 重新验证：

```cpp
void adoptCaptureSessionFormat(const CaptureSession& session,
                               const Options& options,
                               VideoFormat* format,
                               RgaYuvToRgbMode* color_mode)
{
    const VideoFormat replacement_format = session.format();
    validateFormat(replacement_format);                    // 尺寸/fourcc/stride/颜色元数据
    const RgaYuvToRgbMode replacement_color_mode = selectColorMode(
        replacement_format, options.force_color_mode, options.color_mode);
    *format = replacement_format;
    *color_mode = replacement_color_mode;
    std::cout << "Recovery capture: VALIDATED level=L2 generation="
              << session.generation() << " size=" << format->width << 'x'
              << format->height << " stride=" << format->bytes_per_line[0U]
              << " color_mode=" << colorModeName(*color_mode) << '\n';
}
```

验证内容：实际尺寸仍为 1920×1080、fourcc 仍为 NV12、memory plane 数/stride/sizeimage 安全、颜色空间/YCbCr encoding/量化范围仍可由当前 RGA 模式处理。只有全部通过才更新主循环的 `format` 和 `color_mode`。

如果不验证直接用旧格式，可能出现"旧格式参数解释新 buffer"——stride 不对会导致 RGA 读到错位的像素，颜色元数据不对会导致 CSC 错误。`capture_session_recovery.md` 第 7 节强调：

> 只有验证通过才回到主循环。否则按 configuration 域退出，绝不会拿旧格式参数解释新 buffer。

验证失败抛异常 → `runStream` catch → `PipelineFailure(Configuration, exit 10)` 退出。这和第 8 篇"BT.709 full range 直接退出"是同一原则——格式不兼容不恢复，直接退出。

## RecoveryBudgetExhausted：区分预算耗尽和恢复失败

```cpp
class RecoveryBudgetExhausted : public std::runtime_error {
public:
    explicit RecoveryBudgetExhausted(const std::string& detail)
        : std::runtime_error(detail) {}
};
```

这个异常类存在的唯一目的是让主循环能区分两种失败：

- **预算耗尽**（`RecoveryBudgetExhausted`）：60s 窗口内恢复次数已达上限，说明系统持续故障——不继续尝试，直接退出。
- **恢复本身失败**（`std::exception`）：`rebuild()` 抛异常，新 session 创建失败——也可能只是偶发 open 失败，理论上有重试价值。

当前两种都最终退出（L2 失败后 `runStream` catch 包装成 `PipelineFailure(Capture, exit 20)`），但区分异常类型让后续可以针对性处理——比如 L2 失败但预算未耗尽时可以延长退避后重试。

主循环里 `catch (const RecoveryBudgetExhausted&) { throw; }` 直接重抛，不进 L2——L1 预算耗尽不该继续 L2，否则预算机制失效。

## L2 期间屏幕为什么不会黑

L2 只销毁 V4L2 capture buffer，不动 DRM framebuffer：

```text
旧 V4L2 session 销毁 / 新 session 创建
                     │
DRM framebuffer 不变 + VOP 继续扫描最近一帧
```

屏幕停在最后一帧，等新 session 出帧后继续 page flip。这是"capture 和 display 两端独立"的设计好处——第 8 篇说过 V4L2 的 4 个 capture buffer 和 DRM 的 2 个 display buffer 是不同物理内存，所有权流转互不影响。L2 重建 capture 端时，display 端完全不受影响。

## 故障注入：测试 L1→L2 升级

`--inject-stream-recovery-failures N` 在 L1 修改 queue 前抛出诊断失败，触发 L2：

```cpp
const bool inject_l1_failure =
    diagnostic_stream_failures_completed <
    options.injected_stream_recovery_failures;
try {
    recoverCaptureStream(capture.queue(), &capture_recovery_budget,
                         &statistics, inject_l1_failure);
} catch (...) {
    if (inject_l1_failure) {
        ++diagnostic_stream_failures_completed;
    }
    recoverCaptureSession(capture, ...);
}
```

注入的失败在"修改 queue 之前"抛出，不会真正把驱动置于异常状态——只是让控制流走到 L2 代码路径。随后走的是与真实 L1 ioctl 失败相同的 L2 代码，所以验证的是真实恢复逻辑，不是模拟。

两个选项组合测试：

```bash
--inject-capture-timeout-recoveries N    # 触发 N 次 L1 超时
--inject-stream-recovery-failures N      # 让前 N 次 L1 失败，升级 L2
```

## 板端复现与验收

**一次 L1 失败后 L2 重建并继续显示：**

```bash
adb shell "/home/reynor/camera-project/bin/camera_display_stream \
  --stream 4 \
  --confirm-desktop-stopped \
  --color-mode bt709-limited \
  --inject-capture-timeout-recoveries 1 \
  --inject-stream-recovery-failures 1 \
  /dev/video0 /dev/dri/card0"
# 期望输出：
#   Diagnostic injection: capture timeout streak=1 ...
#   Recovery capture: STARTING level=L1 attempt=1 ...
#   Recovery capture: FAILED level=L1 attempt=1
#   Recovery capture: STARTING level=L2 attempt=1 cause=... backoff_ms=200 ...
#   Recovery capture: SUCCEEDED level=L2 attempt=1 generation=2 elapsed_ms=132
#   Recovery capture: VALIDATED level=L2 generation=2 size=1920x1080 stride=1920 ...
#   captured/displayed: 101/101
#   sequence gaps: 0
#   Final capture session generation: 2
#   exit: 0
```

**连续三次 L1 失败验证 L2 预算：**

```bash
# 注入 3 次 L1 超时 + 3 次 L1 失败
# 前 2 次 L2 成功（generation 2、3），第 3 次 L2 预算耗尽退出
# 期望：
#   L2 attempt 1: SUCCEEDED, generation=2, 128 ms
#   L2 attempt 2: SUCCEEDED, generation=3, 131 ms
#   L2 attempt 3: BUDGET_EXHAUSTED
#   Lifecycle: FAILED domain=capture
#   Exit code: 20
```

**WSL 自动化四组用例：**

```bash
ADB=/home/reynor/tools/platform-tools/adb \
ADB_SERIAL=8b34888e45c927c6 \
  ./tools/test_camera_capture_recovery_rk3568.sh \
  /dev/video0 bt709-limited
```

脚本覆盖：L1 一次成功、L1 预算耗尽、L1 失败后 L2 一次成功、L2 预算耗尽。每组结束检查 worker PID、DRM client、`/dev/video0` fd 持有者。

## 当前阶段与下一篇

本篇结束时，capture 域有了两级恢复：L1 处理 queue 状态紊乱，L2 处理 fd/设备级故障。但 display 域还没有恢复能力——`page flip` 失败、`DRM event` 超时仍然直接按 display 域 exit 40 退出。
