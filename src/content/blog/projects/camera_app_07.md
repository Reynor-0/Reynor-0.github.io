---
title: 'Camera 开发（七）：DRM Page Flip 与离线 RGA 验证'
description: '基于 RK3568 的 V4L2 Camera 应用开发记录，从双缓冲翻页到 NV12 经 RGA 旋转写入 DRM framebuffer'
category: '项目'
series: { id: 'camera-development', order: 7 }
tags: ['Camera', 'Linux', 'V4L2', 'RGA', '图像处理']
pubDate: 'Jun 22 2026'
---

## 本篇要解决什么问题

上一篇结束的时候，程序已经能够用`drmModeSetCrtc` 显示一帧静态的彩色bar。但是我们最终要将摄像头输入到屏幕上，会表现为一个视频流的形式，也就是持续提交新 framebuffer——`SetCrtc` 每帧调一次会很慢且有闪烁，正确的做法是 `drmModePageFlip`。

此外，还有一个关键的约束：imx415摄像头输出的是横屏的1920x1080 NV12，而屏幕是竖屏的1080x1920 XRGB8888。中间必须由 RGA 做旋转 + 格式转换。如果直接把真实摄像头接入，画面出错时分不清是 V4L2 buffer 出问题、RGA 参数错、还是 DRM pitch 不对。

所以本篇做两件事，对应两条验证线：

1. **page flip 双缓冲**：在 `DrmCrtcDisplay` 上加 `pageFlipAndWait`，用 `drmModePageFlip + DRM_MODE_PAGE_FLIP_EVENT + poll + drmHandleEvent` 实现双 framebuffer 翻页。这条线证明"DRM 能持续提交新帧"。

2. **离线 RGA 验证**：写一个 `rga_drm_test` 程序，用 CPU 在 DRM dumb buffer 里生成已知 NV12 色条，导出 DMA-BUF fd，让 RGA 旋转 270° + 转 BGRX8888 写到另一块 DRM framebuffer，再显示出来。这条线证明"RGA 能从 DMA-BUF 读、旋转、写到 DRM buffer"，且不依赖真实摄像头。

本篇结束时，两条线各自验证通过，但还没拼在一起——真实摄像头采集 → RGA → DRM 实时显示是后面两篇的事。

## 基础知识：Page Flip 与 DRM Event

### 为什么不用 SetCrtc 翻页

`drmModeSetCrtc` 能改 framebuffer，但它本质是"重新 modeset"——可能触发面板重新初始化、画面闪烁、耗时几毫秒到几十毫秒。30 FPS 视频每帧只有 33ms，经不起每帧 modeset。

`drmModePageFlip` 专门为"换 framebuffer"设计：它告诉内核"在下一个垂直消隐期（vblank）把 CRTC 扫描的 framebuffer 换成这个新的"，然后立即返回。内核在 vblank 时原子地完成切换，无闪烁、无 modeset 开销。切换完成后内核通过 DRM event 通知应用。

### DRM Event 机制

`drmModePageFlip` 的第三个参数传 `DRM_MODE_PAGE_FLIP_EVENT`，表示"完成后给我发事件"。事件通过 DRM fd 可读体现——应用 `poll(drm_fd, POLLIN)` 等待，fd 可读后调 `drmHandleEvent` 解析事件并触发回调：

```text
应用调 drmModePageFlip(fb=B, EVENT)
    │
    │ 内核在下一个 vblank 切换 A→B
    ▼
DRM fd 变可读
    │
    │ poll 返回
    ▼
drmHandleEvent(fd, &event_context)
    │
    │ 回调 page_flip_handler
    ▼
应用知道 B 已经在扫描，A 可以重新写入
```

`event_context` 是个 `drmEventContext` 结构，里面填回调函数指针。`drmHandleEvent` 内部读 fd 上的事件数据、解析、调你注册的回调。回调里通常更新"哪个 framebuffer 现在在扫描"的状态。

### 双缓冲的必要性

只有一块 framebuffer 时，应用写它的时候 VOP 也在读它——CPU/RGA 写到一半被 VOP 扫出去，画面撕裂。双缓冲解决这个：A 在扫描时应用写 B，写完后 page flip 到 B，等 flip 完成再写 A。任意时刻 VOP 扫描的和应用写的是不同 buffer，无撕裂。

本篇的 page flip 测试用两块 framebuffer 交替显示不同色条，验证 flip 机制本身。真实摄像头显示时也是双缓冲，只是内容从色条变成 RGA 输出。

## DrmCrtcDisplay::pageFlipAndWait

`pageFlipAndWait` 把 page flip + 等待 event 封装成同步调用——调用返回时 flip 已完成，调用方可以立即写旧 buffer。这是"同步流水线"的第一步（后续才会做异步事件循环）。

### 状态机新增字段

`Impl` 新增几个字段跟踪 flip 状态：

```cpp
/** 当前 CRTC 正在扫描的 framebuffer；0 表示尚未 modeset。 */
std::uint32_t current_framebuffer_id{0U};

/** 已提交但尚未收到完成事件的 framebuffer。 */
std::uint32_t pending_framebuffer_id{0U};

/** true 表示不得覆盖 current/pending 两个 framebuffer 或再提交 flip。 */
bool flip_pending{false};

/** 已完成 page flip 的总数。 */
std::uint64_t completed_flip_count{0U};
```

`flip_pending` 是核心约束——同一时刻只允许一个 flip 在途。如果上一个 flip 还没完成就提交新 flip，内核会返回 `EBUSY`。本篇保持同步，一个 in-flight flip 够用。

### pageFlipAndWait 实现

```cpp
std::uint64_t pageFlipAndWait(std::uint32_t framebuffer_id, int timeout_ms)
{
    if (framebuffer_id == 0U || timeout_ms <= 0) {
        throw std::invalid_argument("...");
    }
    if (released) {
        throw std::logic_error("session has already been restored");
    }
    if (!display_active) {
        throw std::logic_error("pageFlipAndWait requires an active CRTC");
    }
    if (flip_pending) {
        throw std::logic_error("a DRM page flip is already pending");
    }
    if (framebuffer_id == current_framebuffer_id) {
        throw std::logic_error("pageFlipAndWait requires a different framebuffer");
    }

    pending_framebuffer_id = framebuffer_id;
    flip_pending = true;
    if (drmModePageFlip(drm_fd, crtc_id, framebuffer_id,
                        DRM_MODE_PAGE_FLIP_EVENT, this) != 0) {
        const int error = errno;
        pending_framebuffer_id = 0U;
        flip_pending = false;
        throw framebufferError("drmModePageFlip", error);
    }
    /* ... poll + drmHandleEvent 等待 ... */
}
```

`drmModePageFlip` 的第 5 个参数 `this` 是 user_data——内核完成 flip 后会把这个指针塞进事件里，`drmHandleEvent` 回调时能拿到。这里传 `this`（`Impl*`），回调里就能更新对应 `Impl` 的状态。

`framebuffer_id == current_framebuffer_id` 的检查防止"flip 到同一个 buffer"——这没意义且内核可能拒绝。

### 等待 flip-complete event

```cpp
drmEventContext event_context{};
event_context.version = DRM_EVENT_CONTXT_VERSION;
event_context.page_flip_handler = &Impl::pageFlipEventHandler;

const std::chrono::steady_clock::time_point deadline =
    std::chrono::steady_clock::now() + std::chrono::milliseconds(timeout_ms);
while (flip_pending) {
    const std::chrono::steady_clock::time_point now = std::chrono::steady_clock::now();
    if (now >= deadline) {
        throw std::runtime_error("DRM page flip timeout after " + std::to_string(timeout_ms) + " ms");
    }

    const std::chrono::milliseconds remaining = 
        std::chrono::duration_cast<std::chrono::milliseconds>(deadline - now);
    const int poll_timeout = remaining.count() > 0 ? static_cast<int>(remaining.count()) : 1;
    pollfd descriptor{};
    descriptor.fd = drm_fd;
    descriptor.events = POLLIN;
    const int poll_result = ::poll(&descriptor, 1, poll_timeout);
    if (poll_result < 0) {
        if (errno == EINTR) {
            continue;  // 被信号打断，重试
        }
        throw framebufferError("poll", errno);
    }
    if (poll_result == 0) {
        continue;  // 超时，重新计算剩余时间
    }
    if ((descriptor.revents & (POLLERR | POLLHUP | POLLNVAL)) != 0) {
        throw std::runtime_error("DRM fd reported an error while waiting for page flip");
    }
    if ((descriptor.revents & POLLIN) != 0 &&
        drmHandleEvent(drm_fd, &event_context) != 0) {
        throw framebufferError("drmHandleEvent(page flip)", errno);
    }
}
return completed_flip_count;
```

几个要点：

**deadline 计算用 `std::chrono::steady_clock`。** 不能用 `time(NULL)` 或 `clock_gettime(CLOCK_REALTIME)`——系统时间可能被 NTP 调整导致跳变，steady_clock 单调递增不受影响。这是 C++11 `<chrono>` 的标准用法，比 `gettimeofday` + 手工减法安全。

**poll 的 timeout 用 `remaining` 计算，不是固定值。** 每次 `poll` 返回后重新算剩余时间，保证总等待不超过 `timeout_ms`。如果 poll 返回 0（poll 自己超时但还没到 deadline），继续循环——poll 的超时粒度是毫秒，可能比 deadline 早几毫秒返回。

**`EINTR` 时 continue 而非返回 false。** 和第 2 篇 V4L2 的 `poll` 不同——那里 `EINTR` 返回 false 让上层检查退出标志；这里 `EINTR` continue 是因为信号打断 poll 后，flip event 还在内核里没消费，必须继续等。区别在于语义：V4L2 那边 `EINTR` 可能意味着"该退出了"，这里 `EINTR` 只是"被信号打断了一下，flip 还没完成"。

### handlePageFlipEvent 回调

```cpp
static void handlePageFlipEvent(int fd,
                                unsigned int sequence,
                                unsigned int tv_sec,
                                unsigned int tv_usec,
                                void* user_data)
{
    Impl* const self = static_cast<Impl*>(user_data);
    self->current_framebuffer_id = self->pending_framebuffer_id;
    self->pending_framebuffer_id = 0U;
    self->flip_pending = false;
    self->last_flip_sequence = sequence;
    ++self->completed_flip_count;
}
```

```cpp
static void handlePageFlipEvent(int fd,
                                unsigned int sequence,
                                unsigned int tv_sec,
                                unsigned int tv_usec,
                                void* user_data)
{
    Impl* const self = static_cast<Impl*>(user_data);
    self->current_framebuffer_id = self->pending_framebuffer_id;
    self->pending_framebuffer_id = 0U;
    self->flip_pending = false;
    self->last_flip_sequence = sequence;
    ++self->completed_flip_count;
}
```

回调收到 `user_data`（就是 `pageFlipAndWait` 传的 `this`），把 `pending` 提升为 `current`，清除 `flip_pending` 标记，递增完成计数。`sequence` 是内核给的 vblank 序号，保留供诊断（可以用来发现丢帧）。

回调是 `static` 的——因为 libdrm 的回调签名是 C 函数指针，不能直接用成员函数（成员函数有隐式 `this` 参数，签名不匹配）。`static` 成员函数没有 `this`，签名匹配，通过 `user_data` 手动恢复对象指针。这是 C++ 回调 C 库的标准模式。

## DrmDumbBuffer：可导出 DMA-BUF 的纯存储

```cpp
class DrmDumbBuffer {
public:
    DrmDumbBuffer(int drm_fd, std::uint32_t width, std::uint32_t height,
                  std::uint32_t bits_per_pixel);
    ~DrmDumbBuffer();

    int dmaBufFd();              // drmPrimeHandleToFD 导出
    void* data() noexcept;       // mmap 地址
    std::uint32_t pitch() const noexcept;
    std::size_t size() const noexcept;
    /* ... */
};
```
和 `DrmDumbFramebuffer` 的区别：

| | `DrmDumbBuffer` | `DrmDumbFramebuffer` |
| --- | --- | --- |
| 创建 dumb | ✅ | ✅ |
| mmap | ✅ | ✅ |
| 导出 DMA-BUF | ✅ `dmaBufFd()` | ✅ `dmaBufFd()` |
| `drmModeAddFB2` | ❌ | ✅ |
| 用途 | RGA 源 buffer（不显示） | DRM 显示 buffer |

`bits_per_pixel` 参数让 `DrmDumbBuffer` 能创建 8-bit buffer（NV12 的 Y/UV 都是 8-bit），而 `DrmDumbFramebuffer` 固定 32-bit XRGB8888。NV12 源 buffer 按 8 bpp、1920×1620 请求（1620 = 1080 Y + 540 UV），驱动按 8 bit/像素分配，总大小 = pitch × 1620。

`dmaBufFd()` 用 `drmPrimeHandleToFD` 把 GEM handle 导出成 DMA-BUF fd——这是 DRM 端的 EXPBUF 等价物。V4L2 那边用 `VIDIOC_EXPBUF` 导出，DRM 这边用 `drmPrimeHandleToFD`，两者都产生可跨设备共享的 fd。

## DMA_BUF_IOCTL_SYNC：CPU 与设备的访问交接

`rga_drm_test` 在 CPU 写 NV12 buffer 前后，要显式调 `DMA_BUF_IOCTL_SYNC`：

```cpp
dmaBufSync(source_dma_fd,
           DMA_BUF_SYNC_START | DMA_BUF_SYNC_WRITE,
           "DMA_BUF_IOCTL_SYNC(START WRITE)");
fillNv12ColorBars(source, source_width, source_height, source_height_stride);
dmaBufSync(source_dma_fd,
           DMA_BUF_SYNC_END | DMA_BUF_SYNC_WRITE,
           "DMA_BUF_IOCTL_SYNC(END WRITE)");
```

这是 DMA-BUF 的显式同步机制——CPU 访问 DMA-BUF 内存前必须 `SYNC(START)`，访问后必须 `SYNC(END)`，否则：

- CPU 写的数据可能还在 cache 里没刷到内存，RGA DMA 读到的是旧数据。
- 或者 RGA 还在写，CPU 读到半成品。

`SYNC(START | WRITE)` 告诉内核"我要开始写了"——内核做 cache invalidate/flush，保证后续 CPU 写能被设备看到。`SYNC(END | WRITE)` 告诉内核"我写完了"——内核把 cache 刷回内存，设备可以读了。

## RGA 旋转：rotateNv12ToBgrx8888

`rga_transform.cpp` 用 librga 的 IM2D 接口提交同步 RGA 作业。核心流程是 `wrapbuffer_fd_t` → `imcheck_t` → `improcess`。

### wrapbuffer_fd_t：用 fd 描述 buffer

```cpp
rga_buffer_t source = wrapbuffer_fd_t(
    checkedInt(source_width, "source width"),
    checkedInt(source_height, "source height"),
    checkedInt(source_stride_pixels, "source stride"),
    checkedInt(source_height_stride, "source height stride"),
    RK_FORMAT_YCbCr_420_SP);
```
`wrapbuffer_fd_t` 把 DMA-BUF fd + 宽高 + stride + 格式打包成 `rga_buffer_t`——RGA 作业的输入描述。`RK_FORMAT_YCbCr_420_SP` 就是 NV12（Y + UV 交错，single plane）。目标是 `RK_FORMAT_BGRX_8888`。

这里有个新手容易踩的坑——**stride 单位**。RGA 的 stride 参数单位是"像素"不是"字节"。XRGB8888 每像素 4 字节，所以 DRM dumb buffer 返回的 `pitch`（字节）要除以 4 传给 RGA：

```cpp
destination.pitch() / 4U   // 字节 stride → 像素 stride
```

如果直接传字节 stride，RGA 会按"像素"理解，实际跨度变成 4 倍，画面错位。

### color_space_mode：BT.709 limited

```cpp
source.color_space_mode = IM_YUV_TO_RGB_BT709_LIMIT;
destination.color_space_mode = IM_COLOR_SPACE_DEFAULT;
```

NV12 → RGB 的颜色转换不是无脑公式——BT.601 和 BT.709 的矩阵不同，limited range（Y∈[16,235]）和 full range（Y∈[0,255]）的偏移不同。代码注释特意说明：

> 板端 librga 1.3.1/so 2.1.0 不支持 full-CSC 组合，但明确支持 BT.709 limited YUV→RGB。真实相机接入前必须让 ISP 输出与此处一致的 limited range。

### imcheck_t + improcess

```cpp
const int usage = IM_HAL_TRANSFORM_ROT_270 | IM_SYNC;
rga_check_perpare(&source, &destination, &pattern, ...);
const IM_STATUS check_status = imcheck_t(source, destination, pattern, ...);
if (check_status != IM_STATUS_NOERROR) {
    throw rgaError("imcheck_t(NV12->BGRX rotate 270)", check_status);
}

const IM_STATUS process_status = improcess(source, destination, pattern, ...);
if (process_status != IM_STATUS_SUCCESS) {
    throw rgaError("improcess(NV12->BGRX rotate 270)", process_status);
}
```

`imcheck_t` 是"预检查"——提交前问 RGA 驱动"这个组合（NV12 1920×1080 → BGRX8888 1080×1920 + 270° 旋转）你支持吗"。不支持就 `throw`，不浪费一次 `improcess`。`IM_SYNC` 表示同步作业——`improcess` 返回时 RGA 已经完成，源 buffer 可以释放、目标 buffer 可以显示。本篇保持同步，后续如果要让 RGA 和显示并行才需要考虑异步作业。

### BGRX8888 vs XRGB8888 的字节序

RGA 的 `RK_FORMAT_BGRX_8888` 内存字节顺序匹配 little-endian `DRM_FORMAT_XRGB8888`。这听起来矛盾——BGRX 怎么等于 XRGB？

关键在"little-endian"。DRM fourcc `XRGB8888` 在 little-endian 系统上的内存布局是 `B G R X`（低字节在前），正好和 RGA 的 `BGRX_8888` 一致。fourcc 名字描述的是"字节序无关的通道顺序"，实际内存布局取决于 CPU endianness。ARM AArch64 是 little-endian，所以两者匹配。如果在大端系统上就不匹配了——但嵌入式 Linux 几乎都是 little-endian，不用纠结。

## rga_drm_test：离线验证链路

`rga_drm_test_main.cpp` 把前面所有零件拼成一条离线验证链路：

```text
1. DrmDevice + probe()
2. DrmDumbBuffer(1920x1620, 8bpp)         ← 源 NV12 存储
3. source.dmaBufFd()                       ← 导出 DMA-BUF fd
4. DMA_BUF_SYNC(START WRITE)
5. CPU 写 NV12 色条到 source.data()
6. DMA_BUF_SYNC(END WRITE)
7. DrmDumbFramebuffer(1080x1920)           ← 目标 XRGB8888 + FB ID
8. destination.dmaBufFd()                  ← 导出 DMA-BUF fd
9. rotateNv12ToBgrx8888(source_fd, dest_fd, ...)
10. DrmCrtcDisplay + show(destination.framebufferId())
11. 等待 N 秒
12. restore() + release()
```

注意第 9 步 `rotateNv12ToBgrx8888` 拿的是两块 buffer 的 DMA-BUF fd，不是 mmap 地址——RGA 通过 fd 经自己的 DMA 引擎访问内存，CPU 写入的 NV12 数据被 RGA DMA 读取、旋转、转换、写到目标 buffer，全程 CPU 不参与像素搬运。

目标 buffer 的 `dmaBufFd()` 是 RGA 写入的入口，`framebufferId()` 是 DRM 显示的入口——两个 ID 指向同一块 GEM 内存，只是不同子系统的句柄。这和第 3 篇 V4L2 EXPBUF 的"同一块内存两种句柄"是同一模式。

```cpp
const std::uint32_t source_width = 1920U;
const std::uint32_t source_height = 1080U;
const std::uint32_t source_height_stride = source_height;
const std::uint32_t allocation_height =
    source_height_stride + source_height / 2U;   // 1080 + 540 = 1620

DrmDumbBuffer source(device.fd(), source_width, allocation_height, 8U);
```

NV12 的 Y plane 是 1920×1080，UV plane 是 1920×540（UV 交错，垂直分辨率减半）。所以按 8 bpp 请求 1920×1620 的 buffer：前 1080 行放 Y，后 540 行放 UV。`height_stride` 和 `height` 分开是因为某些驱动要求 Y plane 的 height 按对齐填充（比如 1080 → 1088），此时 `height_stride=1088` 但 `height=1080`。当前板 RKISP 返回 `height_stride == height`，但代码仍然分开传，保持对其他驱动的兼容。

### fillNv12ColorBars：CPU 生成 NV12 色条

```cpp
static const YuvColor kColors[] = {
    {63U, 102U, 240U},    // 红（BT.709 limited）
    {173U, 42U, 26U},     // 绿
    {32U, 240U, 118U},    // 蓝
    {235U, 128U, 128U},   // 白
    {16U, 128U, 128U},    // 黑
};
```

这些 YUV 值是 BT.709 limited range 下纯色的对应值。`Y=235` 是满亮度（limited range 的 max），`Y=16` 是黑电平（limited range 的 min）。`U=V=128` 是无色度（灰阶）。CPU 按这个填充 Y plane 和 UV plane，生成一幅 1920×1080 的 5 条垂直色条。

UV plane 的写入要特别注意——NV12 的 UV 是交错的（`U V U V ...`），不是分两个 plane：

```cpp
unsigned char* const chroma =
    base + static_cast<std::size_t>(buffer.pitch()) * height_stride;
for (std::uint32_t y = 0U; y < height / 2U; ++y) {
    unsigned char* const row =
        chroma + static_cast<std::size_t>(y) * buffer.pitch();
    for (std::uint32_t x = 0U; x < width; x += 2U) {
        const std::size_t color_index =
            static_cast<std::size_t>(x) * color_count / width;
        row[x] = kColors[color_index].u;
        row[x + 1U] = kColors[color_index].v;
    }
}
```

UV plane 高度是 Y 的一半（540 行），每行 `U V` 交替。`x += 2U` 因为一对 UV 对应两个 Y 像素。

## 析构顺序：display → destination → source

`runTest` 的局部变量声明顺序保证逆序析构正确：

```cpp
DrmDumbBuffer source(...);                    // 先构造
DrmDumbFramebuffer destination(...);
DrmCrtcDisplay display(...);                  // 后构造
/* ... show ... */
/* restore() + destination.release() + source.release() */
```

析构顺序 `display` → `destination` → `source`——先关 CRTC（停止扫描），再释放 framebuffer（删 FB ID + munmap + DESTROY_DUMB），最后释放源 buffer。和第 6 篇同样的"先停显示再删存储"原则。

## 板端复现

**page flip 双缓冲测试：**

```bash
./tools/cross_build_rk3568.sh
adb push build-rk3568/stage/bin/drm_probe /home/reynor/
adb shell "/home/reynor/drm_probe --show-color-bars 5 --confirm-desktop-stopped"
# 屏幕显示色条，5 秒后退出（本 commit 的 drm_probe 已支持 page flip 测试）
```

**离线 RGA 验证：**

```bash
adb push build-rk3568/stage/bin/rga_drm_test /home/reynor/
adb shell "/home/reynor/rga_drm_test --show 5 --confirm-desktop-stopped"
# 期望输出：
#   RGA to DRM image is now visible:
#     Source: 1920x1080 NV12
#     Source pitch: 1920 bytes
#     Source DMA-BUF fd: N
#     Destination: 1080x1920 XRGB8888
#     Destination pitch: 4352 bytes
#     Destination DMA-BUF fd: N+1
#     Rotation: 270 degrees
#     RGA version: ...
#     RGA elapsed: 4722 us
#     Duration: 5 seconds maximum
```

屏幕上应看到 5 秒的红绿蓝白黑五条**垂直**色条（旋转后方向正确）。如果看到水平色条，说明旋转角度错了（90° 而非 270°）。如果颜色全反（红蓝互换），说明 BGRX/XRGB 字节序没对齐。`RGA elapsed: 4722 us` 是单次同步 RGA 作业的实测耗时——约 4.7ms，远小于一帧 33ms，同步流水线有充足余量。

## 当前阶段与下一篇

本篇验证了两条独立链路：DRM page flip 能持续翻页，RGA 能从 DMA-BUF 读 NV12、旋转、写到 DRM buffer。但两条链路还没拼在一起——RGA 的源是 CPU 生成的离线色条，不是真实摄像头。

下一篇要做的是真实摄像头单帧端到端：用前三篇的 V4L2 采集拿到一帧 NV12 的 DMA-BUF fd，把它直接喂给本篇的 `rotateNv12ToBgrx8888`，再显示到屏幕。这是第一次让真实摄像头数据流过完整链路 V4L2 → DMA-BUF → RGA → DRM → 屏幕。不过单帧验证还不涉及连续翻页——先确认一帧的颜色、方向、stride 全对，再谈 30 FPS 连续显示。









