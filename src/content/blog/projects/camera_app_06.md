---
title: 'Camera 开发（六）：DRM Master 与彩条 Modeset'
description: '基于 RK3568 的 V4L2 Camera 应用开发记录，从申请 DRM master 到 dumb buffer 彩条显示与安全恢复'
series: { id: 'camera-development', order: 6 }
tags: ['Camera', 'Linux', 'V4L2', 'ISP', '图像处理']
pubDate: 'Jun 21 2026'
---

## 本篇要解决的问题

上一篇结束时，`drm_probe` 能在板端打印出 connector ID、CRTC ID、mode 等数字，但屏幕仍然是 Weston 在控制——程序没有真正"动"过显示。本篇要第一次真正改显示状态：申请 DRM master、创建一个 XRGB8888 dumb buffer、用 `drmModeAddFB2` 包成 framebuffer、调 `drmModeSetCrtc` 把它显示到屏幕上、画一组 RGB 彩条验证画面正确。

这一步的难点不在 ioctl 本身，而在**生命周期管理**。一旦程序持有 DRM master 并把 framebuffer 绑定到 CRTC，任何中途崩溃、Ctrl+C、异常退出都可能留下"屏幕卡在测试画面、Weston 起不来、CRTC 还在扫描已释放的 framebuffer"这种烂摊子。所以本篇要做两件事：写 modeset 代码，以及为这条 modeset 链路设计一套能从任意失败点安全回滚的清理路径。

本篇结束时，程序能在板端显示 5 秒红绿蓝白黑五条彩条，然后安全关闭 CRTC、释放 master、让 Weston 重新接管。但还没有 page flip、没有双缓冲、没有真实摄像头画面——这些留给后面几篇。

## 基础知识：DRM Master 与 dumb buffer

### DRM Master

DRM primary node(`/dev/dri/card0`)的fd默认是"普通客户端"——只能查询，不能修改显示状态。要执行 `drmModeSetCrtc`、`drmModePageFlip`、`drmModeSetPlane` 这类"modeset" ioctl，必须先成为 **DRM master**：

```text
drmSetMaster(fd)    → 成为 master，独占修改权
drmModeSetCrtc(...)  → 现在才能成功
drmDropMaster(fd)   → 主动放弃 master
```

同一时刻**只能有一个 fd 是 master**。如果 Weston 正在运行，它就是 master，其他进程调 `drmSetMaster` 会失败（`errno=EPERM`）。所以本篇的彩条测试必须先停 Weston，等测试结束再恢复。这是和上一篇只读探测最大的区别——只读探测不需要 master，Weston 运行时也能跑；modeset 必须独占。Weston是开发板出场时自带的桌面程序。

一个细节：`close(fd)` 会让内核自动释放该 fd 的 master 状态。所以即使程序异常退出，fd 被 close 后 master 也会释放——但程序异常退出前可能没机会执行"关闭 CRTC + 恢复显示"的清理，导致屏幕卡住。所以本篇的重点不是"master 怎么释放"，而是"master 持有期间怎么安全退出"。

### dumb buffer 三步法

DRM dumb buffer 是驱动分配的"简单线性内存"，适合 CPU 写、硬件扫描读。创建一个能显示的 dumb framebuffer 需要四步：

```text
1. DRM_IOCTL_MODE_CREATE_DUMB  → 驱动分配 GEM buffer，返回 handle + pitch + size
2. DRM_IOCTL_MODE_MAP_DUMB     → 拿到 mmap 需要的 offset
3. mmap(fd, offset)            → 映射到用户态，CPU 可以写
4. drmModeAddFB2(XRGB8888)     → 给 GEM handle 包一个 KMS framebuffer ID
```

注意第 2 步 `MAP_DUMB` **不直接建立映射**，只返回一个 offset，这个 offset 再传给 `mmap` 作为第 6 个参数。和 V4L2 的 `mmap` 用 `planes[plane].m.mem_offset` 是同一思路——DRM/V4L2 都把"获取 offset"和"建立映射"分成两个调用。

第 4 步 `drmModeAddFB2` 把"GEM handle + 宽高 + 格式 + pitch + offset"组合成一个 framebuffer object ID。这个 ID 才是 `drmModeSetCrtc` 接受的参数——`drmModeSetCrtc` 不认 GEM handle，只认 framebuffer ID。所以"创建 dumb buffer"和"包成 framebuffer"是两步，不能省。

### pitch padding

`CREATE_DUMB` 返回的 `pitch`（每行字节数）不一定等于 `width * 4`。驱动可能为对齐要求在每行末尾加 padding：

```text
|<------ 有效像素 width×4 ------>|<- padding ->|

XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX........
|<------------- pitch -------------->|
```

所以 CPU 写像素时必须用 `pitch` 跨行，不能用 `width * 4`。本篇的 `fillColorBars` 就要处理这个——每行从 `base + y * pitch` 开始写，而不是 `base + y * width * 4`。

## DrmDumbFramebuffer：RAII 包装 dumb buffer

和 `V4L2Device`、`V4L2BufferQueue` 一样，dumb buffer 也用 RAII 包装。`DrmDumbFramebuffer` 类拥有 GEM handle、mmap 地址、framebuffer ID，析构时按相反顺序释放：

```cpp
class DrmDumbFramebuffer {
public:
    DrmDumbFramebuffer(int fd, std::uint32_t width, std::uint32_t height);
    ~DrmDumbFramebuffer();

    DrmDumbFramebuffer(const DrmDumbFramebuffer&) = delete;
    DrmDumbFramebuffer& operator=(const DrmDumbFramebuffer&) = delete;

    void fillColorBars();  // CPU 写彩条
    std::uint64_t checksum() const;  // CPU 读 checksum 验证写入
    void release();  // 手动释放，析构时也会释放

    std::uint32_t width() const noexcept;
    std::uint32_t height() const noexcept;
    std::uint32_t pitch() const noexcept;
    std::size_t size() const noexcept;
    std::uint32_t handle() const noexcept;
    std::uint32_t framebufferId() const noexcept;

private:
    int drm_fd_{-1};
    std::uint32_t width_{0U};
    std::uint32_t height_{0U};
    std::uint32_t pitch_{0U};
    std::size_t size_{0U};
    std::uint32_t handle_{0U};
    std::uint32_t framebuffer_id_{0U};
    void* mapping_{nullptr};
};
```
构造函数依次执行 CREATE_DUMB → MAP_DUMB → mmap → AddFB2。每一步都可能失败，所以整个流程包在 `try { ... } catch (...) { releaseResources(false); throw; }` 里——任一步失败，已申请的资源立即回滚，然后重新抛出原始异常。

### 构造函数的一些细节

**ioctl 成功后立即接管 handle。** `CREATE_DUMB` 成功返回后，`handle_` 立即赋值，这样即使后续发现 pitch/size 异常，catch 分支仍能调 `DESTROY_DUMB`：

```cpp
if (drmIoctl(drm_fd_, DRM_IOCTL_MODE_CREATE_DUMB, &create) != 0) {
    throw framebufferError("DRM_IOCTL_MODE_CREATE_DUMB", errno);
}
handle_ = create.handle;    // 立即接管，失败路径才能 DESTROY_DUMB
```


**布局合法性检查。** 拿到 pitch 和 size 后要做 sanity check：

```cpp
const std::uint64_t visible_row_bytes =
    static_cast<std::uint64_t>(width_) * sizeof(std::uint32_t);
const std::uint64_t required_size =
    static_cast<std::uint64_t>(pitch_) *
    static_cast<std::uint64_t>(height_);
if (visible_row_bytes > static_cast<std::uint64_t>(pitch_) ||
    required_size > create.size ||
    (pitch_ % sizeof(std::uint32_t)) != 0U) {
    throw std::runtime_error(
        "DRM_IOCTL_MODE_CREATE_DUMB returned an unsafe buffer layout");
}
```

防御性检查 `width * 4 <= pitch`（有效行不超出 pitch）、`pitch * height <= size`（完整映射不超出分配大小）、`pitch % 4 == 0`（XRGB8888 像素对齐）。符合规范的驱动不会违反这些，但 BSP 旧驱动或调试中的驱动可能返回奇怪值。早检查比后面 `fillColorBars` 时段错误强。

**`drmIoctl` vs `ioctl`。** 注意这里用的是 `drmIoctl` 不是 `::ioctl`：

```cpp
if (drmIoctl(drm_fd_, DRM_IOCTL_MODE_CREATE_DUMB, &create) != 0) { ... }
```

`drmIoctl` 是 libdrm 提供的封装，内部已经处理了 `EINTR` 重试（和第 1 篇 `xioctl` 一样的逻辑）。所以 DRM 代码里不需要再写一遍 `xioctl`，直接用 `drmIoctl` 即可。这也是为什么 V4L2 那边的 `xioctl` 和 DRM 这边的 `drmIoctl` 名字相似但实现不同——V4L2 没有 libv4l 的统一封装，要自己写；DRM 有 libdrm 提供。

### fillColorBars：写彩条

```cpp
static const std::uint32_t kColors[] = {
    0x00ff0000U,  // 红
    0x0000ff00U,  // 绿
    0x000000ffU,  // 蓝
    0x00ffffffU,  // 白
    0x00000000U,  // 黑
};

std::memset(mapping_, 0, size_);  // 先清零，包括 pitch padding
unsigned char* const base = static_cast<unsigned char*>(mapping_);
for (std::uint32_t y = 0U; y < height_; ++y) {
    std::uint32_t* const row = reinterpret_cast<std::uint32_t*>(
        base + static_cast<std::size_t>(y) * static_cast<std::size_t>(pitch_));
    for (std::uint32_t x = 0U; x < width_; ++x) {
        const std::uint32_t color_index =
            (x * sizeof(std::uint32_t) * 5U) / (width_ * sizeof(std::uint32_t));
        row[x] = kColors[color_index];
    }
}
```

注意 `row` 的地址是 `base + y * pitch_`，不是 `base + y * width * 4`——这就是前面说的 pitch padding 处理。`color_index` 把 `x` 映射到 `[0, color_count)`，把屏幕等分成 5 条垂直色条。

XRGB8888 的字节序是 `X B G R`（小端），所以 `0x00ff0000` 在内存里是 `00 00 ff 00`，对应 R=255、G=0、B=0——红色。最高字节 `00` 是 X（unused padding）。新手常把 XRGB8888 和 RGB888 搞混，写 `0xff0000` 当红色——在 XRGB8888 里这是 `R=00, G=00, B=ff` 蓝色，画面颜色全反。

### checksum：验证 mmap 可读写

```cpp
std::uint64_t DrmDumbFramebuffer::checksum() const {
    const unsigned char* const bytes = static_cast<const unsigned char*>(mapping_);
    std::uint64_t hash = 14695981039346656037ULL;   // FNV-1a offset basis
    for (std::size_t index = 0U; index < size_; ++index) {
        hash ^= static_cast<std::uint64_t>(bytes[index]);
        hash *= 1099511628211ULL;   // FNV-1a prime
    }
    return hash;
}
```

FNV-1a 是个简单的非密码学哈希。这里用它不是为了安全，是为了**验证 mmap 确实可读写**——如果 mmap 失败或映射到了错误的地址，`checksum` 会段错误或返回不稳定值。稳定可重复的 checksum 是"这块内存真的被 CPU 拿到了"的证据。`--test-dumb-buffer` 模式就靠它验证 dumb buffer 生命周期。

### release：显式释放 + 错误汇报

`release()` 和析构函数都调 `releaseResources`，但参数不同：

```cpp
void DrmDumbFramebuffer::release()
{
    releaseResources(true);   // 报告错误
}

DrmDumbFramebuffer::~DrmDumbFramebuffer()
{
    releaseResources(false);  // 不抛异常
}
```

`releaseResources(bool report_error)` 按相反顺序释放：`drmModeRmFB` → `munmap` → `DESTROY_DUMB`。每一步失败都记录第一个错误，但**不停止后续清理**——即使 `RmFB` 失败，仍然要 `munmap` 和 `DESTROY_DUMB`。最后如果 `report_error` 为 true 且有错误，抛出包含第一个失败操作的异常。

这个"记录第一个错误但继续清理"的模式和第 2 篇 `V4L2BufferQueue` 的析构 best-effort 类似，但多了一步"正常路径报告错误"——析构是兜底（不抛），`release()` 是正常路径（要抛，让调用方知道清理失败）。

## DrmCrtcDisplay：Master 与 SetCrtc

`DrmCrtcDisplay` 负责申请 master、执行 `drmModeSetCrtc`、退出时关闭 CRTC 并释放 master。这个类用了 pImpl（pointer to implementation）模式：

```cpp
class DrmCrtcDisplay {
public:
    DrmCrtcDisplay(int drm_fd, std::uint32_t connector_id,
                   std::uint32_t crtc_id, const std::string& mode_name,
                   std::uint32_t mode_width, std::uint32_t mode_height,
                   bool allow_active_crtc);
    ~DrmCrtcDisplay();
    void show(std::uint32_t framebuffer_id);
    DrmCrtcRestoreResult restore();
private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
}
```

`Impl` 是私有嵌套结构，定义在`.cpp`里，持有`drmModeModeInfo`、connector/CRTC ID、mode name、width/height、master 状态等。析构时按相反顺序释放：关闭 CRTC → 释放 master。头文件只前向声明 `struct Impl`，不暴露 libdrm 类型。这样 `drm_display.hpp` 可以被不需要 libdrm 的代码 include（比如未来的单元测试），编译依赖更小。

### 构造函数

构造函数顺序很关键——**先确认 CRTC 处于 inactive，再碰 master**：

```cpp
DrmCrtcOwner initial_crtc(drmModeGetCrtc(drm_fd_, crtc_id));
if (!allow_active_crtc && 
    (initial_crtc->mode_valid != 0 || initial_crtc->buffer_id != 0)) {
    throw std::runtime_error("CRTC is active, but allow_active_crtc is false");
}

if (drmIsMaster(drm_fd) != 1 && drmSetMaster(drm_fd) != 0) {
    throw std::runtime_error("Failed to become DRM master");
}
```

为什么顺序这么重要？Rockchip 4.19 BSP 实测发现，对 active Weston 会话调 `drmSetMaster` 可能让 compositor 退出，即使应用随后没执行 modeset。所以必须先检查 CRTC 是 inactive（说明 Weston 已经停了或没绑定这个 CRTC），再申请 master。`allow_active_crtc` 参数是给"已确认桌面停止但 BSP 仍标记 CRTC active"这种边缘情况留的口子——调用方必须显式传 `true` 才允许覆盖。

### show() 执行 SetCrtc

```cpp
void DrmCrtcDisplay::show(std::uint32_t framebuffer_id)
{
    if (framebuffer_id == 0) {
        throw std::invalid_argument("framebuffer_id must be non-zero");
    }

    if (released) {
        throw std::logic_error("DrmCrtcDisplay has been released");
    }

    if (display_active) {
        throw std::logic_error("CRTC is already active");
    }

    std::uint32_t connector = connector_id;
    if (drmModeSetCrtc(drm_fd, crtc_id, framebuffer_id, 0U, 0U, &connector, 1U, &target_mode) != 0) {
        throw framebufferError("drmModeSetCrtc(color bars)", errno);
    }
    display_active = true;
}
```

`drmModeSetCrtc` 的参数：CRTC ID、framebuffer ID、xy 偏移（0,0）、connector 指针 + 数量（1 个）、mode 指针。一个调用同时完成 mode、connector 路由和 primary framebuffer 设置——这是 legacy KMS 的特点，所有状态分散在多个 ioctl 但 `SetCrtc` 把最核心的一组打包了。

`display_active = true` 只在 `SetCrtc` 成功返回后才设置。这是状态机约束——`restore()` 要靠这个标记决定是否需要关闭 CRTC。如果 `SetCrtc` 抛异常，`display_active` 保持 false，析构时不会尝试关闭一个从没启动的 CRTC。

### doRestore()：restore() 的内部实现

公开的 `restore()` 内部调用 `Impl::doRestore(true)`，析构调用 `doRestore(false)`。之所以把内部方法单独命名而不直接叫 `restore`，是为了和公开接口区分——`restore()` 无参数且抛异常（正常路径），`doRestore(bool)` 接受 `report_error` 参数且析构路径传 `false` 不抛。以下是 `doRestore` 的实现：

```cpp
DrmCrtcRestoreResult doRestore(bool report_error)
{
    if (released) {
        return restore_result;   // 幂等
    }

    int safety_error = 0;
    int drop_master_error = 0;
    if (display_active) {
        // 第一步：关闭 CRTC。不能在 framebuffer 仍被扫描时删除它。
        if (drmModeSetCrtc(drm_fd, crtc_id, 0U, 0U, 0U,
                           nullptr, 0, nullptr) != 0) {
            safety_error = errno;
        } else {
            restore_result = DrmCrtcRestoreResult::kCrtcDisabled;
        }
        display_active = false;
    }

    if (master_held) {
        if (drmDropMaster(drm_fd) != 0) {
            const int error = errno;
            // 另一个 compositor 可能已经重新成为 master，此时 drop 返回 EINVAL
            if (error != EINVAL && error != EACCES && error != EPERM) {
                drop_master_error = error;
            }
        }
        master_held = false;
    }
    released = true;
    /* ... 抛出 report_error 的错误 ... */
    return restore_result;
}
```

**关闭顺序：先 CRTC，再 master。** 不能反过来——如果先 `drmDropMaster`，CRTC 还在扫描测试 framebuffer，此时别的进程可能拿到 master 并 modeset，画面会闪烁或冲突。先关 CRTC（`SetCrtc(fb_id=0, connectors=nullptr, mode=nullptr)`），确认屏幕不再扫描测试画面，再释放 master。

**`drmDropMaster` 的容错。** Rockchip BSP 实测：如果另一个 compositor 已经重新成为 master，本 fd 的 `drmDropMaster` 可能返回 `EINVAL/EACCES/EPERM`。这不是错误——master 已经不在本 fd 手里了。所以代码特意把这三个 errno 排除，只有其他错误才报告。这是嵌入式 BSP 和主线内核行为差异的典型例子，代码里特意注释说明。

**幂等性。** `released` 标记保证 `doRestore()` 可以被重复调用——正常路径 `restore()` 调一次 `doRestore(true)`，析构再调一次 `doRestore(false)`，第二次直接返回缓存的结果。这是 RAII + 显式 restore 双路径模式的安全保障。

## 析构

```cpp
DrmDumbFramebuffer framebuffer(device.fd(), result.mode.width, result.mode.height);
framebuffer.fillColorBars();
DrmCrtcDisplay display(device.fd(), result.connector_id, result.crtc_id,
                        result.mode.name, result.mode.width, result.mode.height,
                        /*allow_active_crtc=*/false);
display.show(framebuffer.framebufferId());
waitForDisplay(duration_seconds);
const DrmCrtcRestoreResult restore_result = display.restore();
framebuffer.release();
```


声明顺序：先 `framebuffer`，后 `display`。C++ 的栈对象析构顺序是**声明逆序**——`display` 先析构，`framebuffer` 后析构。这正好符合"先关 CRTC 再删 framebuffer"的要求：

```text
display 析构  → 关闭 CRTC + 释放 master（屏幕不再扫描 framebuffer）
framebuffer 析构 → drmModeRmFB + munmap + DESTROY_DUMB（删除 framebuffer 本身）
```

如果顺序反了——先 `framebuffer` 后 `display`——`framebuffer` 析构时 CRTC 还在扫描它的 framebuffer ID，`drmModeRmFB` 可能失败或留下"扫描已删除 framebuffer"的危险状态。所以局部变量声明顺序不只是风格问题，是正确性问题。

不过正常路径不依赖析构——显式调 `display.restore()` 和 `framebuffer.release()`。析构是兜底，只在异常路径触发。但即使异常，声明顺序保证的逆序析构仍然正确清理。

## SignalHandlerGuard：RAII 管理信号 handler

第 2 篇的 `camera_demo` 用 `std::signal` 注册 handler 后不管恢复，因为整个进程退出时自然清理。本篇的 `drm_probe` 在 `--show-color-bars` 模式下也是进程退出，但为了让 handler 不"泄漏"到主流程之后，加了 `SignalHandlerGuard`：

```cpp
class SignalHandlerGuard {
public:
    SignalHandlerGuard()
    {
        old_sigint_ = std::signal(SIGINT, requestStop);
        if (old_sigint_ == SIG_ERR) {
            throw std::runtime_error("failed to install SIGINT handler");
        }
        old_sigterm_ = std::signal(SIGTERM, requestStop);
        if (old_sigterm_ == SIG_ERR) {
            static_cast<void>(std::signal(SIGINT, old_sigint_));  // 回滚
            old_sigint_ = SIG_ERR;
            throw std::runtime_error("failed to install SIGTERM handler");
        }
    }

    ~SignalHandlerGuard()
    {
        if (old_sigterm_ != SIG_ERR) {
            static_cast<void>(std::signal(SIGTERM, old_sigterm_));
        }
        if (old_sigint_ != SIG_ERR) {
            static_cast<void>(std::signal(SIGINT, old_sigint_));
        }
    }
    /* 禁复制 */
private:
    typedef void (*SignalHandler)(int);
    SignalHandler old_sigint_{SIG_ERR};
    SignalHandler old_sigterm_{SIG_ERR};
};
```

构造时保存旧 handler、安装新 handler；析构时恢复旧 handler。如果安装 SIGTERM 失败，要回滚已安装的 SIGINT——这是 RAII 构造失败路径的标准要求：要么完整构造，要么不留痕迹。

`SIG_ERR` 是 `std::signal` 失败时的返回值，用它作为"未保存旧 handler"的哨兵值。析构时检查这个哨兵，避免恢复从未保存的 handler。

`waitForDisplay` 的实现也值得说一下——用 `nanosleep` 100ms 粒度轮询 `g_stop_requested`：

```cpp
for (std::uint32_t tick = 0U;
     tick < total_ticks && g_stop_requested == 0;
     ++tick) {
    timespec remaining{};
    remaining.tv_sec = 0;
    remaining.tv_nsec = 100000000L;   // 100ms
    while (::nanosleep(&remaining, &remaining) != 0) {
        if (errno == EINTR) {
            if (g_stop_requested != 0) return;
            continue;   // 信号打断后用 remaining 继续睡
        }
        /* 其他错误抛异常 */
    }
}
```

`nanosleep` 被 `EINTR` 打断时，第二个参数 `remaining` 会被填入"剩余时间"。用 `while` 循环继续睡完剩余时间。这是 `nanosleep` 比 `sleep` 强的地方——`sleep` 被打断后不告诉你剩多少，`nanosleep` 会。100ms 粒度让 Ctrl-C 响应延迟不超过 100ms，对静态画面够用。后续做真实摄像头显示时会换成 `poll` 监听 DRM event，不再用 `nanosleep` 轮询。

## --confirm-desktop-stopped：安全开关

`--show-color-bars` 模式强制要求 `--confirm-desktop-stopped` 参数：

```cpp
if (first == "--show-color-bars") {
    if (argc != 4 && argc != 5) {
        throw std::invalid_argument(
            "--show-color-bars requires seconds and --confirm-desktop-stopped");
    }
    if (std::string(argv[3]) != "--confirm-desktop-stopped") {
        throw std::invalid_argument(
            "refusing modeset without --confirm-desktop-stopped");
    }
    /* ... */
}
```

这个参数本身不触发任何动作——它只是个"我确认已经停了桌面"的口令。为什么需要？因为 modeset 会改变屏幕内容，如果调用方没意识到这一点，误在 Weston 运行时跑，要么 `drmSetMaster` 失败（好情况），要么 BSP bug 导致 Weston 退出（坏情况）。强制要求显式确认，把"我已经停了桌面"从隐式假设变成显式声明。

这也是嵌入式现场常见的安全设计——破坏性操作要求显式 opt-in，不能默认执行。和 `rm -rf` 要 `--no-preserve-root` 一个思路。

## 板端运行脚本：停桌面 + trap 恢复

`tools/run_drm_color_bars_rk3568.sh` 把整个"停桌面 → 跑测试 → 恢复桌面"串起来：

```sh
trap restore_desktop EXIT
trap 'exit 130' HUP INT TERM

echo "Stopping systemui, vendor camera and Weston..."
/etc/init.d/S50systemui stop >/dev/null 2>&1 || true
killall camera >/dev/null 2>&1 || true
killall sysvolume >/dev/null 2>&1 || true
/etc/init.d/S49weston stop >/dev/null 2>&1 || true

# 等 Weston 真正退出
remaining_checks=30
while pidof weston >/dev/null 2>&1; do
    if [ "${remaining_checks}" -eq 0 ]; then
        echo "error: Weston is still running; refusing DRM takeover" >&2
        exit 1
    fi
    sleep 0.1
    remaining_checks=$((remaining_checks - 1))
done

"${program}" --show-color-bars "${duration_seconds}" --confirm-desktop-stopped
```

几个关键点：

**`trap restore_desktop EXIT`** 覆盖所有退出路径——正常退出、错误退出、信号退出（通过 `trap 'exit 130' HUP INT TERM` 把信号转成 EXIT）。这样无论测试成功、失败、Ctrl+C，`restore_desktop` 都会被调用。这是 shell 脚本里做"保证清理"的标准模式，和 C++ 的 RAII 析构异曲同工。

**等 Weston 真正退出。** `killall weston` 返回后进程可能还在清理 fd，直接 `drmSetMaster` 可能竞争失败。脚本用 30 次 100ms 轮询（共 3 秒）等 `pidof weston` 真的消失。这种"命令返回 ≠ 资源释放"的时序在嵌入式现场很常见，盲目重试会偶发失败。

**`restore_desktop` 只在脚本主动停了桌面时才恢复。** `desktop_restore_required` 标记记录"是不是我停的"。如果脚本启动时桌面就已经停着（`desktop_restore_required=0`），退出时就不恢复——避免把用户原本就停的桌面误启动。`--keep-desktop-stopped` 参数让调用方显式声明"我不要恢复"。

## 板端复现

```bash
# 交叉编译并推到板子
./tools/cross_build_rk3568.sh
adb push build-rk3568/stage/bin/drm_probe /home/reynor/
adb push tools/run_drm_color_bars_rk3568.sh /home/reynor/

# 在板端以 root 运行（会自动停桌面、跑 5 秒彩条、恢复桌面）
adb shell "/home/reynor/run_drm_color_bars_rk3568.sh 5"
# 期望输出：
#   Stopping systemui, vendor camera and Weston...
#   DRM device: /dev/dri/card0
#     Driver: rockchip
#     ...
#   Color bars are now visible:
#     Framebuffer ID: ...
#     CRTC ID: 115
#     Connector ID: 163
#     Duration: 5 seconds maximum
#     Press Ctrl-C to stop early.
#   Display cleanup: CRTC safely disabled; restart Weston
#   Restoring Weston and systemui...
```

屏幕上应看到 5 秒红绿蓝白黑五条垂直彩条，然后屏幕变黑（CRTC 关闭），最后 Weston 恢复桌面。

**只读探测 + dumb buffer 测试（不停桌面）：**

```bash
adb shell "/home/reynor/drm_probe /dev/dri/card0"
# 只查询，不改显示

adb shell "/home/reynor/drm_probe --test-dumb-buffer /dev/dri/card0"
# 创建 dumb buffer、画彩条、checksum、释放——但不绑定 CRTC
# 期望输出包含：
#   Dumb framebuffer test:
#     Format: XRGB8888
#     Resolution: 1080x1920
#     Pitch: 4352 bytes    ← 注意 pitch != 1080×4=4320，有 32 字节 padding
#     Size: 8386560 bytes
#     Checksum: 0x...
#     Bound to CRTC: no
#   Cleanup: complete
```

`Pitch: 4352` 而不是 `4320` 是 Rockchip VOP 对齐要求的直接证据——每行 32 字节 padding。这个数字后续 RGA/DRM 显示链路里都要用驱动返回的 pitch，不能自己算。

## 当前阶段与下一篇

本篇结束时，程序能独占 DRM、显示静态彩条、安全恢复。但画面是静态的——`drmModeSetCrtc` 只调用一次，没有翻页机制。如果要把摄像头实时画面显示出来，需要的是"持续提交新 framebuffer"的能力。

下一篇要做的是双 framebuffer + `drmModePageFlip` 翻页：准备两块 dumb buffer，初始 `SetCrtc` 显示 A，然后 `PageFlip` 到 B，等 flip-complete event，再 flip 回 A，循环。这会第一次引入 DRM event 处理（`poll(drm_fd)` + `drmHandleEvent`），也是后续真实摄像头显示的基石——摄像头每帧都要触发一次 page flip。

