---
title: 'Camera 开发（八）：真实摄像头单帧与连续双缓冲显示'
description: '基于 RK3568 的 V4L2 Camera 应用开发记录，第一次让真实摄像头数据流过 V4L2→RGA→DRM 完整链路'
series: { id: 'camera-development', order: 8 }
tags: ['Camera', 'Linux', 'V4L2', 'ISP', '图像处理']
pubDate: 'Jun 23 2026'
---

## 本篇要解决什么

前 7 篇分别把 V4L2 采集（第 1-3 篇）、DRM 显示（第 5-7 篇）、RGA 旋转（第 7 篇）三段各自跑通。第 7 篇的 `rga_drm_test` 用 CPU 生成的离线 NV12 色条验证了"RGA 能从 DMA-BUF 读、旋转、写到 DRM buffer"，但源数据不是真实摄像头。

本篇要做的是把前三段拼起来，让真实摄像头数据第一次流过完整链路：

```text
真实 /dev/video0 (ISP NV12 输出)
    │ V4L2 DQBUF
    ▼
capture DMA-BUF fd
    │ RGA 270° + NV12→BGRX8888
    ▼
DRM framebuffer
    │ drmModeSetCrtc / drmModePageFlip
    ▼
屏幕
```

分两步走：先做**单帧**端到端（`camera_display_once`），采集一帧、RGA 转换、显示静止画面，验证颜色、方向、stride、buffer 布局全部正确；再做**连续双缓冲**（`camera_display_stream`），循环 DQBUF → RGA → page flip，让屏幕实时显示摄像头画面。

## 颜色元数据：让 RGA 知道用什么矩阵

### 问题：NV12 不只是 NV12

前 7 篇一直说"NV12"，但 NV12 只描述了像素的内存布局（Y + UV 交错），**不描述颜色矩阵和量化范围**。同一份 NV12 字节流，按 BT.601 limited 解码和按 BT.709 full 解码，出来的 RGB 颜色完全不同。

V4L2 用四个独立字段描述颜色元数据：

| 字段 | 含义 |
| --- | --- |
| `colorspace` | 色度/光度定义，例如 `V4L2_COLORSPACE_REC709` |
| `xfer_func` | 传递函数（gamma），例如 `V4L2_XFER_FUNC_709` |
| `ycbcr_enc` | YCbCr 编码矩阵，例如 `V4L2_YCBCR_ENC_709` |
| `quantization` | 量化范围，`LIM_RANGE`（Y∈[16,235]）或 `FULL_RANGE`（Y∈[0,255]） |

第 1 篇的 `VideoFormat` 只保存宽高/stride/sizeimage，没保存这些。真实摄像头接入后必须把它们也读出来——否则 RGA 不知道用哪个 CSC 矩阵。

### VideoColorMetadata 与 VideoFormat 扩展


```cpp
struct VideoFormat {
    /* 原有 width/height/pixel_format/plane_count/bytes_per_line/size_image */
    std::uint32_t field{V4L2_FIELD_ANY};
    std::uint32_t colorspace{V4L2_COLORSPACE_DEFAULT};
    std::uint32_t xfer_func{V4L2_XFER_FUNC_DEFAULT};
    std::uint32_t ycbcr_enc{V4L2_YCBCR_ENC_DEFAULT};
    std::uint32_t quantization{V4L2_QUANTIZATION_DEFAULT};
};

struct VideoColorMetadata {
    std::uint32_t colorspace{V4L2_COLORSPACE_DEFAULT};
    std::uint32_t xfer_func{V4L2_XFER_FUNC_DEFAULT};
    std::uint32_t ycbcr_enc{V4L2_YCBCR_ENC_DEFAULT};
    std::uint32_t quantization{V4L2_QUANTIZATION_DEFAULT};
};
```

和第 1 篇讲过的"请求值 ≠ 实际值"一样，`VideoColorMetadata` 是请求值，`VideoFormat` 里的是 `G_FMT` 回填的实际值。RKISP 实测：请求 BT.709 limited，驱动返回 `colorspace=REC709 / ycbcr_enc=709 / quantization=LIM_RANGE`，匹配。

### RgaYuvToRgbMode：让 RGA CSC 显式选择

第 7 篇的 `rotateNv12ToBgrx8888` 硬编码 `IM_YUV_TO_RGB_BT709_LIMIT`。本篇将其参数化。


```cpp
enum class RgaYuvToRgbMode {
    Bt601Limited,
    Bt709Limited,
    Bt601Full,
};

RgaTransformResult rotateNv12ToBgrx8888(
    /* ... 原有参数 ... */,
    RgaYuvToRgbMode color_mode = RgaYuvToRgbMode::Bt709Limited);
```

为什么要让调用方选？因为板端 librga 1.3.1 只提供三种 CSC：BT.601 limited、BT.601 full、BT.709 limited。**没有 BT.709 full**——如果摄像头输出 BT.709 full range，RGA 无法正确转换，只能拒绝或用 BT.601 近似（颜色会偏）。

`selectColorMode` 函数根据 V4L2 返回的颜色元数据选 RGA 模式：

```cpp
if (format.quantization == V4L2_QUANTIZATION_LIM_RANGE) {
    return RgaYuvToRgbMode::Bt709Limited;
}
if (format.quantization == V4L2_QUANTIZATION_FULL_RANGE) {
    throw std::runtime_error(
        "camera rejected BT.709 limited range; installed librga cannot "
        "correctly convert BT.709 full range (use an explicit "
        "--color-mode diagnostic override to compare supported modes)");
}
```

**遇到 BT.709 full range 直接抛异常**，不静默混用 BT.601。这是颜色处理的硬约束——混用量化范围会让黑色变灰、白色过曝，肉眼可见的错误。命令行提供 `--color-mode` 诊断覆盖，让开发者强制用 BT.601 看近似效果，但默认路径必须严格匹配。

## camera_display_once：单帧端到端

### 完整流程

```text
1. V4L2Device + setFormat(1920x1080 NV12, BT.709 limited)
2. V4L2BufferQueue + requestBuffers(4) + exportDmaBuffers + queueAll + start
3. DrmDevice + probe()
4. DrmDumbFramebuffer(1080x1920)            ← 目标显示 buffer
5. DrmCrtcDisplay(master, connector, crtc, mode)
6. dequeueOneFrame(queue)                   ← 取一帧
7. validateCapturedFrame + analyzeLuma      ← 检查 + 统计
8. rotateNv12ToBgrx8888(capture_fd, dest_fd, ...)
9. queue.requeue(captured_buffer_index)     ← RGA 完成后立即归还 capture buffer
10. queue.stop()                             ← 单帧测试不需要继续采集
11. display.show(destination.framebufferId())
12. waitForDisplay(N 秒)
13. display.restore() + destination.release()
```

### dequeueOneFrame: 宽松超时等待

```cpp
CapturedFrame dequeueOneFrame(V4L2BufferQueue& queue) {
    for (std::uint32_t attempt = 0; attempt < 3U; ++attempt) {
        if (g_stop_requested != 0) {
            throw std::runtime_error("capture interrupted before a frame arrived");
        }
        if (!queue.waitForFrame(2000)) {
            continue;
        }
        CapturedFrame frame;
        if (queue.tryDequeue(&frame)) {
            return frame;
        }
    }
    throw std::runtime_error("capture timed out three consecutive times");
}
```
单帧等待比连续模式宽松——3 次每次 2 秒，共 6 秒。因为 ISP 首次 `STREAMON` 后可能需要几秒稳定，连续模式有重试余量但单帧必须一次拿到。

### analyzeLuma：颜色诊断

单帧验证的关键是确认颜色对不对。直接肉眼看屏幕颜色不够客观——不同光线、不同显示器都影响判断。代码在 RGA 转换前读 NV12 的 Y plane 做统计：

```cpp
LumaStatistics analyzeLuma(const CapturedFrame& frame, const VideoFormat& format)
{
    /* 256 桶直方图 */
    std::array<std::uint64_t, 256U> histogram{};
    /* 遍历有效 Y 像素，跳过 stride padding */
    for (std::uint32_t row = 0U; row < format.height; ++row) {
        const std::uint8_t* const pixels =
            base + static_cast<std::size_t>(row) * format.bytes_per_line[0U];
        for (std::uint32_t column = 0U; column < format.width; ++column) {
            ++histogram[pixels[column]];
        }
    }
    /* 计算 min/max/mean/percentile + below_16/above_235 计数 */
}
```

输出长这样：

```text
Luma active pixels: count=2073600 min=18 p01=24 p50=42 p99=128 max=235 mean=58.32
Luma outside limited nominal range: Y<16=0 (0%), Y>235=0 (0%)
```

`min=18` 和 `max=235` 落在 limited range 名义范围 `[16,235]` 内，`Y<16=0` 和 `Y>235=0` 意味着没有越界——这证明摄像头确实输出 BT.709 limited range，不是 full range。如果 `min=0` 且 `max=255`，说明实际是 full range，RGA 的 BT.709 limited CSC 会出错。

这是为什么代码要分位值而不是只看平均值——`p01`（1% 分位）反映暗部最深的真实亮度，`p99` 反亮部，两者组合能判断"是不是真的 limited range"。纯黑场景下 `p01` 应接近 16，纯白场景下 `p99` 应接近 235。

### 帧布局验证

```cpp
if (frame.planes.size() != 1U || frame.planes[0U].dma_buf_fd < 0 ||
    frame.planes[0U].data_offset != 0U ||
    frame.planes[0U].bytes_used < format.size_image[0U]) {
    throw std::runtime_error(
        "captured frame has an invalid one-plane NV12 DMA-BUF layout");
}
```

确认：1 个 memory plane（NV12 的 Y/UV 在同一块内存）、有 DMA-BUF fd（第 3 篇导出的）、`data_offset == 0`（有效数据从 mmap 起始地址开始，没有前置 metadata 头）、`bytes_used >= sizeimage`（写满了一帧）。任一不符就拒绝，避免把布局错的帧喂给 RGA。

### RGA 完成后立即 QBUF

```cpp
const RgaTransformResult transform = rotateNv12ToBgrx8888(
    frame.planes[0U].dma_buf_fd, /* ... */);

const std::uint32_t captured_buffer_index = frame.buffer_index;
queue.requeue(captured_buffer_index);
queue.stop();
```

注意 `requeue` 在 `display.show` **之前**——`IM_SYNC` 同步 RGA 返回时，RGA 已经不再读 capture buffer，可以立即 QBUF 归还 ISP。VOP 扫描的是 destination DRM buffer，和 capture buffer 是两块独立内存，VOP 不会再引用 capture buffer。这个"RGA 完成即 QBUF"是后续连续模式能跑起来的关键——采集和显示的 buffer 所有权完全解耦。
## camera_display_stream：连续双缓冲

### 双 framebuffer 的所有权状态

连续模式需要两块 DRM framebuffer 交替：

```text
时刻 T0：VOP 扫描 A，RGA 写入 B
时刻 T1：page flip A→B，VOP 扫描 B，RGA 写入 A
时刻 T2：page flip B→A，VOP 扫描 A，RGA 写入 B
...
```

`writable_framebuffer` 在 0/1 之间交替：

```cpp
DrmDumbFramebuffer framebuffer_a(drm.fd(), ...);
DrmDumbFramebuffer framebuffer_b(drm.fd(), ...);
DrmDumbFramebuffer* framebuffers[2] = {&framebuffer_a, &framebuffer_b};
const int destination_dma_fds[2] = {
    framebuffer_a.dmaBufFd(),
    framebuffer_b.dmaBufFd(),
};

std::size_t writable_framebuffer = 0U;
bool display_active = false;
```

`writable_framebuffer` 始终指向当前未被 VOP 扫描的那块——RGA 写它、`pageFlipAndWait` 把它切为新的扫描目标、然后 `writable_framebuffer = 1 - writable_framebuffer` 切到另一块（现在是旧扫描目标，可以重新写了）。

### 主循环

```cpp
while (g_stop_requested == 0 && std::chrono::steady_clock::now() < deadline) {
    if (!queue.waitForFrame(2000)) {
        ++statistics.timeouts;
        ++consecutive_timeouts;
        if (consecutive_timeouts >= 3U) {
            throw std::runtime_error("capture timed out three consecutive times");
        }
        continue;
    }

    CapturedFrame frame;
    if(!queue.tryDequeue(&frame)) {
        continue;
    }
    consecutive_timeouts = 0U;
    if ((frame.flags & V4L2_BUF_FLAG_ERROR) != 0U) {
        ++statistics.error_frames;
        queue.requeue(frame.buffer_index);
        continue;
    }
    validateCapturedFrame(frame, format);

    DrmDumbFramebuffer& target = *framebuffers[writable_framebuffer];
    const RgaTransformResult transform = rotateNv12ToBgrx8888(
        frame.planes[0U].dma_buf_fd, /* ... */,
        destination_dma_fds[writable_framebuffer], /* ... */,
        color_mode);

    updateStatistics(frame, transform, &statistics);
    queue.requeue(frame.buffer_index);

    if (!display_active) {
        display.show(target.framebufferId());
        display_active = true;
    } else {
        static_cast<void>(
            display.pageFlipAndWait(target.framebufferId(), 2000));
    }
    ++statistics.displayed_frames;
    writable_framebuffer = 1U - writable_framebuffer;
}
```
几个关键点：

**首帧用 `show`，后续用 `pageFlipAndWait`。** `drmModeSetCrtc` 是首次显示必须的（建立 CRTC 和 framebuffer 的绑定），之后切换用 `drmModePageFlip` 更高效。`display_active` 标记区分"首次显示"和"后续翻页"。

**`pageFlipAndWait` 的 2000ms 超时。** 板端 DSI panel 约 54.44 Hz，一个 vblank 周期约 18.4ms。2000ms 等于约 100 个 vblank——如果 100 个周期还没完成 flip，肯定有问题（驱动挂起或硬件故障），直接抛异常比无限等强。

**`requeue` 在 `pageFlipAndWait` 之前。** 同步 RGA 完成后 capture buffer 立即归还 ISP，不等显示端 flip 完成。采集和显示的 buffer 独立——这是"双 buffer pool"的核心：V4L2 的 4 个 capture buffer 和 DRM 的 2 个 display buffer 是不同的物理内存，所有权流转互不影响。

**错误帧丢帧不退出。** `V4L2_BUF_FLAG_ERROR` 帧计数后 `requeue` 继续，不让单坏帧中断整个流。连续 3 次超时才退出。

### 统计输出

循环结束打印累计统计：

```text
Continuous camera display started:
  Camera: /dev/video0
  Source: 1920x1080 NV12, stride=1920 bytes
  Capture buffers: 4
  Color metadata: colorspace=709 xfer=709 ycbcr=709 quantization=limited
  RGA color mode: BT.709 limited (metadata)
  DRM framebuffers: A=42 B=43 pitch=4352 bytes
  Duration: 10 seconds maximum

Cleanup: captured=295 displayed=295 errors=0 timeouts=0 sequence_gaps=0
         rga_min=5231us rga_max=7842us rga_avg=6218us flips=294
         elapsed=10.012s
```

`captured == displayed` 是自洽性检查——应用处理的每一帧都显示了。`sequence_gaps=0` 说明驱动没丢帧。`rga_avg=6218us` 远小于一帧 33ms（30 FPS），同步流水线有充足余量。`flips=294` 等于 `displayed-1`（首帧用 `show` 不算 flip）。

## 析构顺序：display → framebuffer_a/b → queue → camera

`runStream` 的局部变量声明顺序：

```cpp
V4L2Device camera(...);                        // 1. 先构造
V4L2BufferQueue queue(...);                    // 2.
DrmDumbFramebuffer framebuffer_a(...);         // 3.
DrmDumbFramebuffer framebuffer_b(...);         // 4.
DrmCrtcDisplay display(...);                   // 5. 后构造
```

逆序析构：`display` 先析构关 CRTC 释放 master，`framebuffer_b/a` 后析构删 FB + munmap + DESTROY_DUMB，`queue` 析构 stopNoThrow + releaseMappings，`camera` 最后 close(fd)。和第 6、7 篇同一原则——先停显示再删存储。

注意 `framebuffer_a` 和 `framebuffer_b` 的声明顺序：`a` 先 `b` 后，析构 `b` 先 `a` 后。两块 framebuffer 互不依赖，析构顺序不影响正确性——但如果其中一块还正在被 VOP 扫描就析构，会出问题。这就是为什么 `display` 必须在两块 framebuffer 之前析构：`display.restore()` 关 CRTC 后，VOP 不再扫描任何 framebuffer，此时删 `framebuffer_b/a` 才安全。

## 板端复现

**单帧端到端：**

```bash
./tools/cross_build_rk3568.sh
adb push build-rk3568/stage/bin/camera_display_once /home/reynor/

# 先停桌面（用提供的脚本）
adb shell "/home/reynor/run_camera_display_once_rk3568.sh 10 /dev/video0 bt709-limited"
# 期望输出：
#   Single captured frame is now visible:
#     Camera: /dev/video0
#     Source: 1920x1080 NV12, buffer=0, sequence=0
#     Source stride: 1920 bytes
#     Color metadata: colorspace=709 xfer=709 ycbcr=709 quantization=limited
#     RGA color mode: BT.709 limited (metadata)
#     Luma active pixels: count=2073600 min=18 p01=24 p50=42 p99=128 max=235 mean=58.32
#     Luma outside limited nominal range: Y<16=0 (0%), Y>235=0 (0%)
#     Destination: 1080x1920 XRGB8888, pitch=4352 bytes
#     Rotation: 270 degrees
#     RGA elapsed: 7147 us
#     Capture buffer state: requeued, then STREAMOFF completed
#     Duration: 10 seconds maximum
```

屏幕显示 10 秒静止的真实摄像头画面。检查方向（旋转后竖屏）、颜色（用 `Luma` 统计验证 limited range）、画面完整性。

**连续双缓冲：**

```bash
adb shell "/home/reynor/run_camera_display_stream_rk3568.sh 10 /dev/video0 bt709-limited"
# 期望输出末尾：
#   Cleanup: captured=295 displayed=295 errors=0 timeouts=0 sequence_gaps=0
#            rga_min=5231us rga_max=7842us rga_avg=6218us flips=294
#            elapsed=10.012s
```

屏幕显示实时摄像头画面 10 秒，看到的是连续运动的画面（不是静止帧）。Ctrl+C 可以提前退出，SIGTERM 路径会执行 `display.restore()` 安全关 CRTC。

**`--color-mode` 诊断：**

```bash
# 如果怀疑颜色元数据不对，强制用 BT.601 看近似效果
adb shell "/home/reynor/camera_display_once --show 5 --confirm-desktop-stopped \
    --color-mode bt601-limited /dev/video0 /dev/dri/card0"
# 输出会标记 (forced diagnostic)，颜色会偏（BT.601 矩阵 != BT.709）
```





