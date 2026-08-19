---
title: 'Camera 开发（三）：VIDIOC_EXPBUF 与 DMA-BUF 导出'
description: '基于 RK3568 的 V4L2 Camera 应用开发记录，把 MMAP buffer 导出为可跨设备共享的 DMA-BUF fd'
series: { id: 'camera-development', order: 3 }
tags: ['Camera', 'Linux', 'V4L2', 'DMA-BUF', '图像处理']
pubDate: 'Jun 18 2026'
---

## 本篇要解决的问题

上一篇结束时，程序已经能从 `/dev/video0` 连续采集 NV12 图像，但每帧的图像数据只能通过 `mmap` 得到的虚拟地址访问。这个地址是**进程私有的**——CPU 能读，但内核里其他子系统（RGA、DRM、GPU）拿不到这块内存的句柄。也就是说，采集到的帧现在只能"自己看"，没法交给显示硬件。

如果走"应用读 mmap 地址 → memcpy 到另一块内存 → 再交给 DRM"的路径，对于 1920×1080 NV12 一帧 3MB、30 FPS 来说，每秒 90MB 的 CPU 拷贝足以把一颗 Cortex-A55 吃满。这违背了项目"低延迟、无 CPU 图像拷贝"的目标。

Linux 解决跨设备共享内存的标准机制叫 **DMA-BUF**：一个由某设备（这里是 V4L2/RKISP）分配的内存对象，可以通过一个 fd 句柄传给另一个设备（后续的 RGA 或 DRM），后者用它自己的 DMA 直接读写同一块物理内存，全程不经过 CPU。本篇要做的事情就是把 V4L2 MMAP buffer 通过 `VIDIOC_EXPBUF` 导出成 DMA-BUF fd——为后续 RGA 旋转/格式转换和 DRM 显示打通"共享内存"这一步。

也就是说，本篇结束时程序能在原有采集流程之上额外打印每个 buffer/plane 对应的 DMA-BUF fd，并验证这块 fd 与 `mmap` 地址指向同一块底层存储。但本篇还不会真正把 fd 交给 RGA 或 DRM——那是后面几篇的事。

## 基础知识：DMA-BUF 是什么

DMA-BUF 不是一块新内存，而是**对已有内存的一种共享访问协议**。可以把它的核心概念归纳成三件事：

1. **一个 dma-buf 对象代表一块可被多个设备共享的内存。** 这块内存由某个"exporter"分配——本篇里 exporter 是 V4L2 驱动，它已经在 `REQBUFS(MMAP)` 时分配好了 buffer。
2. **每个 dma-buf 对象对应一个 fd。** exporter 通过 `VIDIOC_EXPBUF`（V4L2 场景）或 `drm_prime_handle_to_fd`（DRM 场景）等接口把这块内存"导出"成一个 fd，传给用户态。
3. **其他设备通过 fd 把同一块内存"导入"。** importer（后续的 RGA / DRM）拿到这个 fd 后，用自己的驱动接口把它映射到自己的 DMA 空间，就可以直接读写这块物理内存，不需要 CPU 介入。

可以用一张图理解 V4L2 场景下的关系：

```text
                    ┌─────────────────────────────┐
                    │   V4L2 驱动（exporter）     │
                    │   REQBUFS(MMAP) 分配的内存  │
                    └──────────────┬──────────────┘
                                   │
                ┌──────────────────┼──────────────────┐
                │                  │                  │
        mmap 虚拟地址         VIDIOC_EXPBUF      （未来）RGA/DRM
        （CPU 访问）           导出 dma-buf fd    （importer 访问）
                │                  │                  │
                ▼                  ▼                  ▼
            同一块物理内存     同一块物理内存     同一块物理内存
```

关键认知是：**`mmap` 地址和 `EXPBUF` 得到的 fd 不是两块内存，而是同一块物理内存在不同访问路径上的两种句柄。** CPU 用 `mmap` 地址访问；硬件用 fd 经 importer 访问。因此本篇不会复制任何图像数据——导出操作本身只创建一个 fd 和一些内核 bookkeeping，毫秒级完成。

## EXPBUF 的接口形态

V4L2 的 `VIDIOC_EXPBUF` 用 `v4l2_exportbuffer` 结构体作为参数：

```cpp
struct v4l2_exportbuffer {
    __u32 type;        // queue 类型，与 S_FMT/REQBUFS 一致
    __u32 index;       // 要导出的 buffer 在 pool 里的下标
    __u32 plane;       // multi-planar 时是 memory plane 下标；single-planar 必须为 0
    __u32 flags;       // O_CLOEXEC / O_RDWR / O_RDONLY
    __s32 fd;          // 输出：驱动填入的 dma-buf fd
    __u32 reserved[11];
};
```

调用流程是：填好 `type` / `index` / `plane` / `flags`，发起 `ioctl(VIDIOC_EXPBUF)`，成功返回后 `fd` 字段就是一个有效的 dma-buf fd。这个 fd 的所有权归应用——应用必须保证最终 `close()` 它，否则 exporter（V4L2 驱动）那边可能因为"还有外部引用"而拒绝释放底层 buffer。

一个 buffer 的每个 memory plane 都要单独调一次 `EXPBUF`。对于 RK3568 RKISP 的 NV12，虽然 `num_planes == 1`（Y 和 UV 在同一块内存里），但仍然要为这个 plane 调一次——拿到一个 fd，后续 RGA/DRM 用这个 fd 就能同时访问 Y 和 UV 数据。

## exportDmaBuffers：RAII 管理新增的 fd

上一篇的 `MappedPlane` 只保存 `mmap` 地址和长度，现在要再加一个字段：

```cpp
struct MappedPlane {
    void* address{nullptr};
    std::size_t length{0U};
    int dma_buf_fd{-1};   // EXPBUF 返回的 fd；未导出时为 -1
};
```

`-1` 表示"还没导出"，和 `fd_` 默认值的约定一致。`exportDmaBuffers()` 方法对每个 buffer/plane 调一次 `EXPBUF`：

```cpp
void V4L2BufferQueue::exportDmaBuffers()
{
    if (state_ != V4L2BufferQueueState::BuffersAllocated) {
        throw std::logic_error(
            "exportDmaBuffers requires the BuffersAllocated state");
    }
    if (buffers_.empty()) {
        throw std::logic_error(
            "exportDmaBuffers requires at least one allocated buffer");
    }
    if (dmaBuffersExported()) {
        throw std::logic_error("DMA-BUF planes have already been exported");
    }

    try {
        for (std::size_t buffer_index = 0U;
             buffer_index < buffers_.size();
             ++buffer_index) {
            BufferSlot& slot = buffers_[buffer_index];
            for (std::size_t plane_index = 0U;
                 plane_index < slot.planes.size();
                 ++plane_index) {
                MappedPlane& mapping = slot.planes[plane_index];

                v4l2_exportbuffer export_buffer{};
                export_buffer.type = capture_type_;
                export_buffer.index =
                    static_cast<std::uint32_t>(buffer_index);
                export_buffer.plane =
                    static_cast<std::uint32_t>(plane_index);
                export_buffer.flags = O_CLOEXEC | O_RDWR;

                if (xioctl(fd_, VIDIOC_EXPBUF, &export_buffer) < 0) {
                    throw systemError("VIDIOC_EXPBUF", device_path_);
                }
                if (export_buffer.fd < 0) {
                    throw std::runtime_error(
                        "VIDIOC_EXPBUF returned an invalid fd for " +
                        device_path_);
                }

                mapping.dma_buf_fd = export_buffer.fd;
            }
        }
    } catch (...) {
        closeDmaBufFds();
        throw;
    }
}
```

几个决策点要说清楚：

**状态机只允许在 `BuffersAllocated` 调用 `exportDmaBuffers`。** 这是为了保持状态明确——`Idle` 状态还没有 buffer 可导出；`Streaming` 状态驱动可能正在写入 buffer，此时导出的语义虽然内核允许，但应用层没必要在那种状态下做这件事。`BuffersAllocated` 是 `requestBuffers` 完成、`queueAll` 之前的稳定窗口，最适合做导出。

**`O_CLOEXEC | O_RDWR` 两个 flag 的选择。** `O_CLOEXEC` 和第 1 篇里 `open` 设备时用的同一个语义——`fork+exec` 时 fd 不会泄漏给子进程。嵌入式现场经常有人用 `system()` 调脚本，没这个 flag 设备 fd 会被意外占用。`O_RDWR` 而不是 `O_RDONLY` 是为了给 importer 留足选择——DRM scanout 只需要读，但 RGA 旋转/格式转换是"读源 + 写目标"，目标 buffer 的 fd 必须可写。统一用 `O_RDWR` 避免后续 RGA 写目标时才发现权限不够。

**`dmaBuffersExported()` 防重复导出。** `EXPBUF` 对同一个 buffer/plane 多次调用会返回多个不同的 fd，它们都指向同一块内存——这是合法但容易混乱的状态（哪天关哪个？）。`exportDmaBuffers` 在开头检查"是否已全部导出"，已导出就直接拒绝，强制走"先 `closeDmaBufFds` 全部撤销、再重新导出"的明确路径。

**失败时只撤销 fd，不动 mmap。** `catch (...)` 里调用 `closeDmaBufFds()` 关掉本次已导出的所有 fd，然后 `throw` 重新抛出。注意这里**不**调用 `releaseMappings()`——mmap 映射和内核 buffer 都保留着，queue 仍然处于 `BuffersAllocated` 状态。调用方可以决定是重试导出、还是放弃导出继续纯 MMAP 采集。这种"局部失败只回滚本阶段"的策略和上一篇 `queueAll` 的回滚不同（`queueAll` 失败会释放整个 queue），因为 fd 是"附加"在已有 mmap 之上的额外资源，撤销它不影响底层 mmap 的有效性。

## 借用访问器：dmaBufFd

导出之后，外部代码（后续的 RGA / DRM 模块）需要拿到某个 buffer/plane 的 fd：

```cpp
int V4L2BufferQueue::dmaBufFd(std::uint32_t buffer_index,
                              std::uint32_t plane_index) const
{
    if (buffer_index >= buffers_.size()) {
        throw std::out_of_range("DMA-BUF buffer index is outside the pool");
    }
    const BufferSlot& slot = buffers_[static_cast<std::size_t>(buffer_index)];
    if (plane_index >= slot.planes.size()) {
        throw std::out_of_range("DMA-BUF plane index is outside the buffer");
    }

    const int fd = slot.planes[static_cast<std::size_t>(plane_index)].dma_buf_fd;
    if (fd < 0) {
        throw std::logic_error("the requested memory plane is not exported");
    }
    return fd;
}
```

注意返回值是**借用**——调用方拿到 fd 但不拥有它，所有权仍在 `V4L2BufferQueue`，由它在析构时 `close`。如果调用方需要跨越 `V4L2BufferQueue` 生命周期持有这个 fd（比如后续 RGA 长期持有目标 buffer），应该自己 `dup()` 一份。

`std::out_of_range` 是 C++ 标准库专门给"下标越界"用的异常类型，比通用的 `std::runtime_error` 更精确——调用方 `catch` 时能区分"用户传错了下标"和"内核 ioctl 出错"。这里和上一篇 `requeue` 的下标检查用同一个异常类型，保持接口一致性。

## 析构顺序：fd → munmap → REQBUFS(count=0)

现在 `V4L2BufferQueue` 的析构路径多了一步——关闭 DMA-BUF fd。顺序必须是：

```text
1. STREAMOFF（如果在 Streaming）
2. close 所有 dma_buf_fd
3. munmap 所有 mmap 地址
4. REQBUFS(count=0) 让驱动释放内核 buffer
```

其中第 2、3 步在 `releaseMappings()` 里：

```cpp
void V4L2BufferQueue::releaseMappings() noexcept
{
    // 某些驱动不支持在仍存在导出引用时释放 V4L2 buffer。先关闭本对象拥有的
    // DMA-BUF fd，再解除 CPU 映射，最后由调用方执行 REQBUFS(count=0)。
    closeDmaBufFds();

    for (std::size_t buffer = 0U; buffer < buffers_.size(); ++buffer) {
        std::vector<MappedPlane>& planes = buffers_[buffer].planes;
        for (std::size_t plane = 0U; plane < planes.size(); ++plane) {
            if (planes[plane].address != nullptr && planes[plane].length > 0U) {
                static_cast<void>(
                    ::munmap(planes[plane].address, planes[plane].length));
                planes[plane].address = nullptr;
                planes[plane].length = 0U;
            }
        }
    }
    buffers_.clear();
    state_ = V4L2BufferQueueState::Idle;
}

void V4L2BufferQueue::closeDmaBufFds() noexcept
{
    for (std::size_t buffer_index = 0U;
         buffer_index < buffers_.size();
         ++buffer_index) {
        std::vector<MappedPlane>& planes = buffers_[buffer_index].planes;
        for (std::size_t plane_index = 0U;
             plane_index < planes.size();
             ++plane_index) {
            if (planes[plane_index].dma_buf_fd >= 0) {
                static_cast<void>(::close(planes[plane_index].dma_buf_fd));
                planes[plane_index].dma_buf_fd = -1;
            }
        }
    }
}
```

为什么必须先关 fd 再 munmap 再 `REQBUFS(count=0)`？这关系到上一篇提过的"orphaned buffers"问题：

- 如果还有 `mmap` 映射存在，部分驱动会拒绝 `REQBUFS(count=0)`，返回 `EBUSY`。
- 现在多了一种"外部引用"——dma-buf fd。即使 `mmap` 已经解除，只要还有 fd 引用这块 buffer，exporter（V4L2 驱动）也可能拒绝释放底层内存。

所以顺序是先关 fd（撤销 dma-buf 引用）→ 再 munmap（撤销 CPU 映射）→ 最后 `REQBUFS(count=0)`。三步都走完，内核才能彻底回收这块 buffer。如果顺序反了——先 `REQBUFS(count=0)` 再关 fd——很可能 `REQBUFS` 返回 `EBUSY`，于是 fd 还在但内核 buffer 已经"半释放"，状态混乱。

`closeDmaBufFds` 单独抽成一个方法而不是 inline 在 `releaseMappings` 里，是因为它还要被 `exportDmaBuffers` 的失败回滚路径调用（前面讲过）。两个调用点共用同一段清理逻辑，避免重复。

`static_cast<void>(::close(...))` 这个写法值得说一下：`::close` 的返回值在清理路径里我们处理不了（失败了也不能抛异常），但 C++ 编译器在某些 warning 级别下会抱怨"忽略返回值"。`static_cast<void>()` 是显式告诉编译器"我知道有返回值，但我故意不用"，比 `(void)` 的 C 风格更符合 C++ 习惯。配合 `noexcept`，这就是"best-effort 清理"的标准写法。

## CapturedPlane：暴露 fd 给应用

`tryDequeue` 返回的 `CapturedPlane` 也新增了 `dma_buf_fd` 字段，让应用拿到一帧时同时知道这块 buffer 对应的 dma-buf fd：

```cpp
struct CapturedPlane {
    const void* data{nullptr};
    std::size_t mapped_length{0U};
    std::uint32_t bytes_used{0U};
    std::uint32_t data_offset{0U};
    int dma_buf_fd{-1};   // 借用句柄；与 data 指向同一块底层存储
};
```

注释里特别强调"借用"——`CapturedFrame` 不拥有这个 fd，`requeue` 之后 fd 仍然有效（因为底层 `MappedPlane::dma_buf_fd` 没动），但对应的 buffer 所有权回到驱动，应用不能再使用这块内存。所以严格说，`CapturedPlane::dma_buf_fd` 的有效窗口和 `data` 指针一样——从 `DQBUF` 到 `requeue` 之间。

`tryDequeue` 实现里只是从 `MappedPlane` 拷贝 fd 到 `CapturedPlane`：

```cpp
CapturedPlane& captured = result.planes[static_cast<std::size_t>(plane)];
captured.data = mapping.address;
captured.mapped_length = mapping.length;
captured.bytes_used = planes[plane].bytesused;
captured.data_offset = planes[plane].data_offset;
captured.dma_buf_fd = mapping.dma_buf_fd;
```

这一行赋值本身不创建新的 fd 引用，只是把同一个 `int` 值复制一份给上层使用。内核里 dma-buf 的引用计数没变，仍然只有 `V4L2BufferQueue` 持有的那一份。

## main.cpp：--export-dmabuf 选项

`main.cpp` 新增 `--export-dmabuf` 布尔开关，没有参数：

```cpp
} else if (name == "--export-dmabuf") {
    options.export_dma_buffers = true;
    ++index;
    continue;
}
```

注意它的解析方式和 `--width` 等 key/value 选项不一样——`--export-dmabuf` 是"flag"，没有值，所以循环变量只前进 1（不是 2）。这种"flag + key/value 混合"的解析方式在 `parseCaptureOptions` 的 `for` 循环里要小心处理：先判断是不是已知 flag，再尝试取 key/value。

`runCapture` 在 `requestBuffers` 之后、`queueAll` 之前调用 `exportDmaBuffers`：

```cpp
V4L2BufferQueue queue(camera, actual);
queue.requestBuffers(options.buffer_count);
std::cout << "Buffers: requested=" << options.buffer_count
          << ", actual=" << queue.bufferCount() << '\n';
if (options.export_dma_buffers) {
    queue.exportDmaBuffers();
    std::cout << "DMA-BUF exports:\n";
    for (std::size_t buffer = 0U; buffer < queue.bufferCount(); ++buffer) {
        for (std::uint32_t plane = 0U; plane < queue.planeCount(); ++plane) {
            std::cout << "  buffer=" << buffer
                      << " plane=" << plane
                      << " fd=" << queue.dmaBufFd(
                             static_cast<std::uint32_t>(buffer), plane)
                      << '\n';
        }
    }
}
queue.queueAll();
queue.start();
```

`queueAll` 之前是 `BuffersAllocated` 状态窗口，正好符合 `exportDmaBuffers` 的状态要求。导出完成后立即打印每个 buffer/plane 的 fd，便于人眼对照——这是本篇的"验证产出物"。

每帧的 metadata 输出也新增 `dma_buf_fd` 字段：

```text
frame=0 buffer=0 sequence=0 timestamp=1234.012345 flags=0x10000 planes=1
  plane=0 bytesused=3110400 data_offset=0 mapped=3110400 dma_buf_fd=7
```

`dma_buf_fd=7` 是借用值，每帧的同一个 buffer index 会得到同一个 fd（因为底层 `MappedPlane::dma_buf_fd` 不变）。这是验证"fd 和 mmap 指向同一块存储"的间接证据——同一个 buffer index 的 `mapped` 和 `dma_buf_fd` 在整个采集过程中保持稳定配对。

## 板端复现

**开发机 vivid 验证：**

```bash
sudo ./tools/virtual_camera_modules.sh load
cmake -S . -B build && cmake --build build

# single-planar vivid 上导出 + 采集
./build/camera_demo --capture /dev/video0 --width 640 --height 360 \
    --format NV12 --frames 10 --export-dmabuf
# 期望输出：
#   DMA-BUF exports:
#     buffer=0 plane=0 fd=N
#     buffer=1 plane=0 fd=N+1
#     buffer=2 plane=0 fd=N+2
#     buffer=3 plane=0 fd=N+3
#   frame=0 buffer=0 ... dma_buf_fd=N
#   ...

# multi-planar vivid 上重复
./build/camera_demo --capture /dev/video1 --width 640 --height 360 \
    --format NV12 --frames 10 --export-dmabuf
```

板端 RKISP：

```bash
adb shell "/home/reynor/camera-project/bin/camera_demo \
    --capture /dev/video0 --width 1920 --height 1080 \
    --format NV12 --frames 100 --export-dmabuf"
# 期望输出（截取）：
#   Buffers: requested=4, actual=4
#   DMA-BUF exports:
#     buffer=0 plane=0 fd=7
#     buffer=1 plane=0 fd=8
#     buffer=2 plane=0 fd=9
#     buffer=3 plane=0 fd=10
#   frame=0 buffer=0 sequence=0 timestamp=... flags=0x10000 planes=1
#     plane=0 bytesused=3110400 data_offset=0 mapped=3110400 dma_buf_fd=7
#   ...
#   Capture complete: captured=100 errors=0 timeouts=0 sequence_gaps=0
```

注意 RKISP 的 NV12 虽然 `planes=1`（一个 memory plane），但 `bytesused=3110400` 涵盖了 Y + UV 全部数据——这就是上一篇讲过的"Y 和 UV 在同一块 memory plane 里"。导出的那个 fd=7 对 RGA 来说就是"一整帧 NV12 的入口"。

**fd 泄漏检查：** 采集 1000 帧前后对比 `/proc/$(pidof camera_demo)/fd` 数量，应该保持不变。如果每帧多一个 fd，说明 `EXPBUF` 被重复调用且没有正确关闭——但本篇的设计是只在 `BuffersAllocated` 阶段导出一次，后续采集循环只 `DQBUF`/`QBUF`，不再调 `EXPBUF`，所以 fd 总数恒定为 buffer_count × plane_count（RK3568 上是 4 × 1 = 4 个）。

## 当前阶段与下一篇

本篇结束后，程序已经能把 V4L2 MMAP buffer 导出成 DMA-BUF fd，但 fd 还只是"被打印出来"，没有真正交给任何 importer 使用。也就是说，"跨设备共享内存"这件事在协议层已经具备条件，在应用层还没有发生。

下一篇要做的是把这块 fd 真正交给 RGA，让 RGA 用它自己的 DMA 读取这块 NV12 内存、做旋转和格式转换、再写到另一块 buffer 里。届时才会第一次出现"两块硬件（RKISP 和 RGA）通过同一块 DDR 内存协作"的真实场景。同时也会涉及到 RK3568 板级硬件拓扑——Sensor、CSI、ISP、RGA、VOP、DSI 各自是什么，以及为什么显示链路需要 RGA 介入。这些更偏硬件的部分会单独用一篇来铺垫，再开始写 RGA 代码。










