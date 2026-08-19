---
title: 'Camera 开发（九）：Worker 长期运行与确定性退出'
description: '基于 RK3568 的 V4L2 Camera 应用开发记录，从定时测试 demo 改造成可长期运行、有状态机和稳定退出码的 worker'
series: { id: 'camera-development', order: 9 }
tags: ['Camera', 'Linux', 'V4L2', 'DRM', '图像处理']
pubDate: 'Jun 24 2026'
---

## 本篇要解决什么

第 8 篇结束时，`camera_display_stream` 能连续显示真实摄像头画面，但本质上还是"测试型"程序——运行 N 秒后退出，退出码只有 0（成功）和 1（失败）两种。如果要把这个程序部署成真正的服务，至少还缺三样东西：

1. **长期运行模式**：`--stream N` 是定时测试，`--run-forever` 才是服务模式，只响应停止信号不自动退出。
2. **生命周期状态机**：程序在任何时刻被问"你现在什么状态"，要能明确回答 Starting/Running/Stopping/Stopped/Failed，而不是靠猜。
3. **稳定退出码**：失败时不能只返回 1——要区分"配置错"（不该重试）、"摄像头暂时断流"（退避后可重试）、"内部状态损坏"（立即重启）等不同情况，让上层 supervisor 据此决定恢复策略。

本篇（v0.11.0）把数据路径完全不动，只改控制面：加 `--run-forever`、引入 `PipelineController` 状态机、定义五个故障域和对应退出码、让 SIGINT/SIGTERM 区分记录、保证任何异常点都能 RAII 回滚。本篇结束时程序能长期运行、能响应信号安全退出、能从任何失败点返回带故障域的退出码。但本篇还不做自动故障恢复——连续超时仍然是直接退出，那是下一篇的事。

## 从测试 demo 到 worker：要改什么

第 8 篇的 `runStream` 结构是"初始化 → 循环 → 清理"，失败时 `catch (const std::exception&)` 打印错误返回 1。这种结构对测试够用，但对服务不够：

- **没有状态可见性**：外部观察者（supervisor、日志分析、看板）不知道程序当前是正在启动、正常运行、还是在停止。只能靠"进程是否存在"粗略判断。
- **退出码无语义**：返回 1 可能是摄像头打不开、可能是 RGA 失败、可能是配置错——supervisor 没法据此决定"该重试还是该报警"。
- **信号不区分**：SIGINT 和 SIGTERM 都设同一个 `g_stop_requested = 1`，日志分不清是人工 Ctrl+C 还是服务管理器发的 TERM。

v0.11.0 的改造针对这三个问题，引入四个新类型：

```text
WorkerExitCode      稳定退出码枚举（0/1/2/10/20/30/40/50）
FailureDomain       故障域枚举（Configuration/Capture/Transform/Display/Internal）
PipelineFailure     带故障域和退出码的异常类
PipelineController  顶层状态机（Starting/Running/Stopping/Stopped/Failed）
```

数据路径（V4L2/RGA/DRM 的采集和显示逻辑）完全不变，只在外面包了一层控制流。

## WorkerExitCode：退出码作为接口

退出码不只是"成功或失败"，它是 worker 和 supervisor 之间的接口契约：

```cpp
enum class WorkerExitCode {
    Success = 0,          // 正常停止（时间到/SIGINT/SIGTERM）
    RuntimeFailure = 1,   // 未归类运行故障
    Usage = 2,            // 命令行参数错误
    Configuration = 10,   // 格式/颜色元数据不兼容
    Capture = 20,         // V4L2 打开/ioctl/超时/buffer 错误
    Transform = 30,       // RGA 调用失败
    Display = 40,         // DRM modeset/flip/清理失败
    Internal = 50,        // 状态机不变量破坏
};
```

数字不是标准，关键是"重试有意义"和"重试不会解决"要分开：

- `Success(0)`：supervisor 不重启。
- `Usage(2)`：参数错，重试也是同样的错——不重启，报配置问题。
- `Configuration(10)`：格式不兼容（比如板载 librga 不支持 BT.709 full range），重试不会变——不重启。
- `Capture(20)`：摄像头暂时不可用——退避后重启 worker 可能有效。
- `Transform(30)`：RGA 失败——重建 RGA 或重启 worker 可能有效。
- `Display(40)`：DRM 失败——重建显示会话或重启 worker 可能有效。
- `Internal(50)`：状态机不变量破坏——立即重启并报警，因为继续运行可能制造更多损坏。

这个分类是后续做分级恢复的基础——supervisor 看到 `20` 可以退避重试，看到 `10` 直接报警不重试。本篇只定义退出码，supervisor 还没写，但接口先立起来。

## FailureDomain 与 PipelineFailure

`FailureDomain` 标记"异常发生时正在操作哪个子系统"：

```cpp
enum class FailureDomain {
    Configuration,
    Capture,       // V4L2/Sensor/ISP
    Transform,     // RGA
    Display,       // DRM/VOP/DSI
    Internal,      // 状态机/不变量
};
```

`PipelineFailure` 是带故障域和退出码的异常类，继承 `std::runtime_error`：

```cpp
class PipelineFailure : public std::runtime_error {
public:
    PipelineFailure(FailureDomain domain, WorkerExitCode code,
                    const std::string& detail)
        : std::runtime_error(detail), domain_(domain), code_(code) {}

    FailureDomain domain() const noexcept { return domain_; }
    WorkerExitCode exitCode() const noexcept { return code_; }

private:
    FailureDomain domain_;
    WorkerExitCode code_;
};
```

底层对象（`V4L2Device`、`DrmCrtcDisplay` 等）仍然抛 `std::runtime_error`——它们不知道自己的故障域。`runStream` 在 catch 时把 `std::runtime_error` 包装成 `PipelineFailure`，附上当前 `failure_domain` 和对应退出码。这样底层保持通用，故障域分类集中在顶层控制流。

`failureExitCode` 把故障域映射到退出码：

```cpp
WorkerExitCode failureExitCode(FailureDomain domain)
{
    switch (domain) {
        case FailureDomain::Configuration: return WorkerExitCode::Configuration;
        case FailureDomain::Capture:       return WorkerExitCode::Capture;
        case FailureDomain::Transform:     return WorkerExitCode::Transform;
        case FailureDomain::Display:       return WorkerExitCode::Display;
        case FailureDomain::Internal:      return WorkerExitCode::Internal;
    }
    return WorkerExitCode::RuntimeFailure;
}
```

## PipelineController：状态机

`PipelineController` 只管理顶层状态，不拥有任何 fd 或 buffer：

```cpp
enum class PipelineState {
    Starting,    // 设备/buffer/DRM 初始化中
    Running,     // STREAMON 成功，主循环处理帧
    Stopping,    // 收到停止信号或时间到，正在清理
    Stopped,     // 清理成功完成
    Failed,      // 异常退出，RAII 已回滚
};

class PipelineController {
public:
    PipelineController() = default;

    void beginRunning(bool run_forever, std::uint32_t duration_seconds);
    bool shouldContinue();
    void finish();           // Stopping → Stopped
    void fail() noexcept;    // 任意 → Failed

    PipelineState state() const noexcept { return state_; }
    StopReason stopReason() const noexcept { return stop_reason_; }

private:
    void requestStop(StopReason reason);

    PipelineState state_{PipelineState::Starting};
    StopReason stop_reason_{StopReason::None};
    bool run_forever_{false};
    std::chrono::steady_clock::time_point stream_start_{};
    std::chrono::steady_clock::time_point deadline_{};
};
```

状态转换：

```text
Starting
   │ 初始化成功 + STREAMON
   ▼
Running ──停止信号/时间到──▶ Stopping ──清理成功──▶ Stopped
   │                                          ▲
   │ 异常                                     │
   ▼                                          │
Failed ◀──RAII 回滚──────────────────────────┘
```

`shouldContinue()` 是主循环每帧调用的"要不要继续"判断：

```cpp
bool shouldContinue()
{
    if (state_ == PipelineState::Stopping) return false;
    if (state_ != PipelineState::Running) {
        throw std::logic_error("shouldContinue requires Running");
    }

    if (g_stop_signal == SIGINT) {
        requestStop(StopReason::SigInt);
    } else if (g_stop_signal == SIGTERM) {
        requestStop(StopReason::SigTerm);
    } else if (!run_forever_ &&
               std::chrono::steady_clock::now() >= deadline_) {
        requestStop(StopReason::DurationElapsed);
    }
    return state_ == PipelineState::Running;
}
```

`g_stop_signal` 是 signal handler 写的 `sig_atomic_t`——和第 2 篇的 `g_stop_requested` 类似，但保存的是信号编号而不是布尔值，这样能区分 SIGINT 和 SIGTERM：

```cpp
volatile std::sig_atomic_t g_stop_signal = 0;

void requestStop(int signal_number)
{
    if (g_stop_signal == 0) {   // 只记录第一个信号
        g_stop_signal = signal_number;
    }
}
```

"只记录第一个信号"是因为：如果 SIGTERM 后 supervisor 等不及又发了 SIGINT，程序应该按第一个信号（TERM）的语义走完清理，不被第二个信号打断。`g_stop_signal == 0` 检查保证第一个信号固定下来。

`requestStop` 是私有的，只在 `shouldContinue` 里被调——状态从 Running 原子地切到 Stopping，并固定 `stop_reason_`。一旦进入 Stopping，后续 `shouldContinue` 直接返回 false，主循环退出。

`fail()` 是 `noexcept` 的——异常路径里调用它不能再生异常。它只改状态标记，不做任何资源操作。

## failure_domain 随初始化推进

`runStream` 在 try 块里随初始化步骤推进 `failure_domain`：

```cpp
PipelineController controller;
FailureDomain failure_domain = FailureDomain::Internal;

try {
    SignalHandlerGuard signal_handlers;

    failure_domain = FailureDomain::Capture;
    V4L2Device camera(options.video_device);
    /* setFormat ... */

    failure_domain = FailureDomain::Configuration;
    validateFormat(format);
    const RgaYuvToRgbMode color_mode = selectColorMode(...);

    failure_domain = FailureDomain::Capture;
    V4L2BufferQueue queue(camera, format);
    queue.requestBuffers(4U);
    queue.exportDmaBuffers();
    queue.queueAll();

    failure_domain = FailureDomain::Display;
    DrmDevice drm(options.drm_device);
    /* probe, framebuffers, display ... */

    controller.beginRunning(options.run_forever, options.duration_seconds);
    queue.start();

    while (controller.shouldContinue()) {
        failure_domain = FailureDomain::Capture;
        /* waitForFrame, tryDequeue ... */
        failure_domain = FailureDomain::Transform;
        /* rotateNv12ToBgrx8888 ... */
        failure_domain = FailureDomain::Display;
        /* pageFlipAndWait ... */
    }
    /* ... */
} catch (const PipelineFailure&) {
    controller.fail();
    throw;
} catch (const std::exception& error) {
    controller.fail();
    throw PipelineFailure(
        failure_domain,
        failureExitCode(failure_domain),
        std::string(failureDomainName(failure_domain)) +
            " failure: " + error.what());
}
```

`failure_domain` 在每个关键操作前被设成对应域。如果 `V4L2Device` 构造抛异常，catch 时 `failure_domain == Capture`，退出码 `20`；如果 `rotateNv12ToBgrx8888` 抛异常，`failure_domain == Transform`，退出码 `30`；如果 `pageFlipAndWait` 抛异常，`failure_domain == Display`，退出码 `40`。

这个"在操作前设 domain"的模式有个好处：不需要在每个 catch 分支里判断"是哪一步失败的"——domain 自然反映了"异常发生时正在做什么"。代价是每个操作前要记得更新 domain，漏了就会归类错误。代码注释特意标注每次赋值的原因。

## catch 两层：PipelineFailure vs std::exception

catch 分两层：

```cpp
} catch (const PipelineFailure&) {
    controller.fail();
    throw;                     // 已经是 PipelineFailure，直接重抛
} catch (const std::exception& error) {
    controller.fail();
    throw PipelineFailure(
        failure_domain,
        failureExitCode(failure_domain),
        std::string(failureDomainName(failure_domain)) +
            " failure: " + error.what());
}
```

**第一层 `catch (const PipelineFailure&)`**：如果异常本身就是 `PipelineFailure`（比如某处主动抛的"配置不兼容"），直接 `controller.fail()` + 重抛，不二次包装。这避免把 `PipelineFailure` 包成 `PipelineFailure(PipelineFailure(...))` 的嵌套。

**第二层 `catch (const std::exception&)`**：底层抛的 `std::runtime_error` 在这里被包装成 `PipelineFailure`，附上 `failure_domain` 和退出码。原始错误信息 `error.what()` 保留在 detail 里，不丢失。

`throw;`（裸 throw）重抛原始异常，保持异常类型和 what 不变——和第 2 篇 `requestBuffers` catch 块的 `throw;` 同一用法。

## main 按退出码返回

`main` 按异常类型返回对应退出码：

```cpp
int main(int argc, char* argv[])
{
    try {
        /* --help, --version ... */
        runStream(parseOptions(argc, argv));
        return static_cast<int>(WorkerExitCode::Success);
    } catch (const std::invalid_argument& error) {
        std::cerr << "camera_display_stream: " << error.what() << '\n';
        return static_cast<int>(WorkerExitCode::Usage);
    } catch (const PipelineFailure& error) {
        std::cerr << "camera_display_stream: " << error.what() << '\n'
                  << "Failure domain: " << failureDomainName(error.domain()) << '\n'
                  << "Exit code: " << static_cast<int>(error.exitCode()) << '\n';
        return static_cast<int>(error.exitCode());
    } catch (const std::exception& error) {
        std::cerr << "camera_display_stream: " << error.what() << '\n'
                  << "Exit code: " << static_cast<int>(WorkerExitCode::Internal) << '\n';
        return static_cast<int>(WorkerExitCode::Internal);
    }
}
```

三种异常三种退出码：

- `std::invalid_argument`（参数解析失败）→ `Usage(2)`
- `PipelineFailure`（带故障域的运行时错误）→ `error.exitCode()`（10/20/30/40/50）
- `std::exception`（未归类的兜底）→ `Internal(50)`

第三层兜底理论上不应该被触发——`runStream` 内部已经把所有 `std::exception` 包装成 `PipelineFailure` 了。但如果某处漏了 try、或者 RAII 析构抛异常逃逸，这层兜底保证至少返回 `Internal(50)` 而不是未定义行为。

`static_cast<int>(WorkerExitCode)` 把枚举转成进程退出码。C++ 的 `enum class` 不能隐式转 int，必须显式 cast——这是 `enum class` 比 `enum` 安全的地方（不会意外和 int 混淆），代价是要多写 cast。

## 日志：状态转换可见

v0.11.0 的日志加了稳定标记，便于日志分析和 supervisor 解析：

```text
Lifecycle: STARTING
Lifecycle: RUNNING
Lifecycle: STOPPING reason=SIGTERM
Cleanup V4L2: STREAMOFF complete
Cleanup DRM: CRTC safely disabled
Cleanup buffers: framebuffer release complete
Lifecycle: STOPPED
```

失败时：

```text
Lifecycle: FAILED domain=capture
Cleanup: RAII rollback executed; external resource audit is required
Exit code: 20
```

"RAII rollback executed" 不等于"可以忽略外部核对"——RAII 析构做了 best-effort 清理，但故障测试仍应检查 DRM clients、`/dev/video0` 持有者和进程 PID，确认没有残留。这是 v0.11.0 文档特意强调的——析构是兜底，不能替代显式 `stop()` + `restore()` 的正常路径。

`StopReason` 的四种值对应不同退出场景：

```cpp
enum class StopReason {
    None,              // 还没进入 Stopping
    DurationElapsed,   // --stream N 时间到
    SigInt,            // Ctrl+C
    SigTerm,           // 服务管理器停止
};
```

`SigInt` 和 `SigTerm` 都返回 `Success(0)`——两者都是正常停止，只是来源不同。日志区分它们是为了让人看清楚"是人工 Ctrl+C 还是 supervisor 发的 TERM"，不影响退出码。

## --run-forever 模式

命令行新增 `--run-forever`，和 `--stream <seconds>` 互斥：

```bash
# 定时测试（N 秒后自动退出）
camera_display_stream --stream 10 --confirm-desktop-stopped /dev/video0 /dev/dri/card0

# 长期 worker（只响应信号）
camera_display_stream --run-forever --confirm-desktop-stopped /dev/video0 /dev/dri/card0
```

`PipelineController::beginRunning(run_forever, duration)` 根据 `run_forever` 决定是否设 deadline：

```cpp
void beginRunning(bool run_forever, std::uint32_t duration_seconds)
{
    run_forever_ = run_forever;
    stream_start_ = std::chrono::steady_clock::now();
    deadline_ = stream_start_ + std::chrono::seconds(duration_seconds);
    state_ = PipelineState::Running;
}
```

`shouldContinue` 里 `!run_forever_ && now >= deadline_` 才检查时间——`run_forever` 模式下永远不因时间退出，只响应信号。

## 板端运行脚本的信号转发

`run_camera_display_stream_rk3568.sh` 把 worker 作为子进程运行，收到信号时转发：

```sh
forward_sigint()
{
    if [ -n "${worker_pid}" ]; then
        kill -INT "${worker_pid}" >/dev/null 2>&1 || true
    fi
}

forward_sigterm()
{
    if [ -n "${worker_pid}" ]; then
        kill -TERM "${worker_pid}" >/dev/null 2>&1 || true
    fi
}
```

脚本不立刻退出，而是 `wait` worker 退出后才执行自己的 EXIT trap。这样避免 worker 仍持有 `/dev/dri/card0` 时脚本提前恢复 Weston——如果脚本先恢复了 Weston，两个进程会竞争 DRM master。

`forever` 模式下脚本不再按时间退出，只响应信号。`--keep-desktop-stopped` 让脚本退出后不恢复桌面——适用于"我要连续跑多次测试，不想每次都停启 Weston"的场景。

## 板端复现与验收

**forever + SIGTERM 单轮：**

```bash
adb shell "/home/reynor/run_camera_display_stream_rk3568.sh \
    forever /dev/video0 bt709-limited --keep-desktop-stopped"
# 几秒后在另一个 shell 发 SIGTERM
# 期望输出：
#   Lifecycle: STARTING
#   Lifecycle: RUNNING
#   ...
#   Lifecycle: STOPPING reason=SIGTERM
#   Cleanup V4L2: STREAMOFF complete
#   Cleanup DRM: CRTC safely disabled
#   Cleanup buffers: framebuffer release complete
#   Lifecycle: STOPPED
#   Stop reason: SIGTERM
#   exit 0
```

**三类失败退出码验证：**

```bash
# 不存在的 video node → capture 域 exit 20
adb shell "/home/reynor/camera_display_stream --stream 2 \
    --confirm-desktop-stopped /dev/video99 /dev/dri/card0"
# 期望：Exit code: 20

# BT.709 Full + auto → configuration 域 exit 10
# （需要摄像头确实输出 full range，或用 --color-mode 强制）
# 期望：Exit code: 10

# 不存在的 DRM device → display 域 exit 40
adb shell "/home/reynor/camera_display_stream --stream 2 \
    --confirm-desktop-stopped /dev/video0 /dev/dri/not-present"
# 期望：Exit code: 40
```

**资源泄漏检查：** 每次测试后检查：

- `camera_display_stream` PID 不存在
- `/sys/kernel/debug/dri/0/clients` 没有 camera client
- 没有进程持有 `/dev/video0`

**3 轮 SIGTERM 重复测试：** 用 `tools/test_camera_display_lifecycle_rk3568.sh` 自动跑 1-1000 轮：

```bash
ADB=/home/reynor/tools/platform-tools/adb \
ADB_SERIAL=8b34888e45c927c6 \
  ./tools/test_camera_display_lifecycle_rk3568.sh \
  3 /dev/video0 bt709-limited
# 3 轮全部 PASS，每轮后无残留 DRM client 或 video fd
```

## 当前阶段与下一篇

本篇结束时，`camera_display_stream` 从"定时测试 demo"变成了"可长期运行的 worker"——有状态机、有稳定退出码、能响应信号安全退出、能从任何失败点 RAII 回滚。但本篇还没做自动故障恢复——连续 3 次采集超时仍然是直接抛异常退出，返回 capture 域 exit 20。

下一篇要做的是第一层局部恢复（L1 stream recovery）：连续超时后不直接退出，而是尝试 `STREAMOFF → QBUF all → STREAMON` 重启 V4L2 capture queue，如果恢复成功就继续采集。同时引入恢复预算（60 秒内最多 3 次），避免永久硬件故障造成无界重启风暴。
