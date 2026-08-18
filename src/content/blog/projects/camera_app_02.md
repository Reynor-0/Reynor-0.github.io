---
title: 'Camera 开发（二）：V4L2 MMAP 连续采集与 Buffer Queue'
description: '基于 RK3568 的 V4L2 Camera 应用开发记录，从 Buffer 申请到连续帧采集与安全退出'
category: '项目'
series: { id: 'camera-development', order: 2 }
tags: ['Camera', 'Linux', 'V4L2', '图像处理']
pubDate: 'Jun 17 2026'
---

## 本篇要解决什么

上一篇结束时，已经能打开 `/dev/video0`、确认它确实是 RKISP 的 multi-planar capture node、并协商出 `1920x1080 NV12 stride=1920 sizeimage=3110400`。但程序还没有真正取到一帧图像——既没有申请 buffer，也没有启动 streaming。

这一篇就把这两件事补上：通过 `VIDIOC_REQBUFS` 申请一组 MMAP buffer、`mmap` 映射到用户态、`QBUF` 全部交给驱动、`STREAMON` 启动采集，然后用 `poll + DQBUF + QBUF` 的循环连续取回帧并输出每帧的 `sequence` / `timestamp` / `bytesused` 等元数据，最后通过 SIGINT/SIGTERM 安全退出并清理资源。

也就是说，本篇结束时程序已经能在板端的 `/dev/video0` 上稳定采集 100 帧，并在 vivid 虚拟摄像头上同时覆盖 single-planar 和 multi-planar 两条 API 路径。但还没有把 buffer 导出成 DMA-BUF、也没有任何显示链路——这两件事分别留给第 3 篇和第 5 篇起。

## 基础知识：V4L2 Streaming 与三种内存模型

V4L2 的 streaming I/O 不是简单 `read()` 一帧返回一段内存，而是基于"buffer 在应用和驱动之间循环"的队列模型：

```text
应用 VIDIOC_QBUF ────────▶ 驱动 incoming queue
                              │
                              │ ISP/DMA 写入
                              ▼
                           outgoing queue
应用 VIDIOC_DQBUF ◀──────── 驱动归还 buffer
   │
   │ 应用读取帧
   ▼
应用 VIDIOC_QBUF ────────▶ 再次交给驱动
```

应用准备一组 buffer（典型 4 个），把它们一个个交给驱动；驱动让 ISP/DMA 往里写图像，写完的 buffer 进入 outgoing queue；应用通过 `DQBUF` 取回这些已填充的 buffer，读完后通过 `QBUF` 再交回去。只要应用及时把 buffer 还回去，整条流水线就能持续运行。

V4L2 的 streaming 一共有三种内存模型，区别在"buffer 这块内存到底由谁分配、应用怎么访问它"：

| 模型 | 谁分配内存 | 应用如何访问 |
| --- | --- | --- |
| `V4L2_MEMORY_MMAP` | V4L2 驱动分配 | `mmap()` 映射到用户态 |
| `V4L2_MEMORY_USERPTR` | 应用自己 `malloc`/`mmap` | 把用户态地址传给驱动 |
| `V4L2_MEMORY_DMABUF` | 外部设备分配（DRM/heap/V4L2 export） | 通过 DMA-BUF fd 导入 |

第一版选 MMAP 的理由很简单：buffer 由驱动分配，应用只要 `mmap` 一下就能访问，不需要自己解决对齐、IOMMU、连续物理内存这些事。USERPTR 在 ISP 类设备上限制较多；DMABUF 是后面把 V4L2 buffer 共享给 RGA/DRM 的关键，但那要先把 MMAP 采集链路跑通，第 3 篇再展开。所以本篇所有 `REQBUFS` / `QBUF` / `DQBUF` 都使用 `V4L2_MEMORY_MMAP`。

本篇用到的 ioctl 比上一篇多一倍：

| ioctl | 作用 |
| --- | --- |
| `VIDIOC_REQBUFS` | 申请一组 MMAP buffer，同时选定 streaming 内存模型 |
| `VIDIOC_QUERYBUF` | 查询每个 buffer 的 `offset` / `length`，供 `mmap` 使用 |
| `VIDIOC_QBUF` | 把 buffer 交给驱动（入队） |
| `VIDIOC_STREAMON` | 启动 capture streaming |
| `poll()` | 等待 fd 可读，表示可能有 buffer 可 DQBUF |
| `VIDIOC_DQBUF` | 取回已填充的 buffer（出队） |
| `VIDIOC_STREAMOFF` | 停止 streaming，清空队列并解锁所有 buffer |

## V4l2BufferQueue：把 buffer pool 包成 RAII 对象

上一篇的 `V4L2Device` 只管理一个 fd，析构只要 `close(fd)`。这一篇要管理的资源多得多：N 个 buffer、每个 buffer 1 个或多个 mmap 映射、streaming 状态、buffer 所有权标记。任何一步清理漏掉都会留下泄漏——例如 mmap 没解除就去 `REQBUFS(count=0)`，部分驱动会返回 `EBUSY`，于是内核 buffer 永远释放不掉。

所以这一篇引入第二个 RAII 类 `V4L2BufferQueue`，专门管理 buffer pool 的生命周期。它的核心是**一个状态机**：

```text
Idle
   │ VIDIOC_REQBUFS + QUERYBUF + mmap 成功
   ▼
BuffersAllocated
   │ VIDIOC_QBUF all + VIDIOC_STREAMON   ◀──┐
   ▼                                        │
Streaming                                    │ VIDIOC_STREAMOFF
   │                                        │
   └────────────────────────────────────────┘
```

`Idle` 表示还没向驱动申请 buffer；`BuffersAllocated` 表示已经申请并 `mmap` 完毕，但 streaming 没启动或已停止；`Streaming` 表示 `STREAMON` 成功，驱动可能正在写入已排队的 buffer。停止采集回到 `BuffersAllocated` 而不是 `Idle`——`mmap` 仍然有效，可以在重新 `queueAll` 后再次启动，不需要重新申请 buffer。

类定义的关键部分：

```cpp
enum class V4L2BufferQueueState {
    Idle,
    BuffersAllocated,
    Streaming,
};

class V4L2BufferQueue {
public:
    V4L2BufferQueue(const V4L2Device& device, const VideoFormat& format);
    ~V4L2BufferQueue();

    V4L2BufferQueue(const V4L2BufferQueue&) = delete;
    V4L2BufferQueue& operator=(const V4L2BufferQueue&) = delete;

    void requestBuffers(std::uint32_t requested_count);
    void queueAll();
    void start();
    bool waitForFrame(int timeout_ms) const;
    bool tryDequeue(CapturedFrame* frame);
    void requeue(std::uint32_t buffer_index);
    void stop();

    std::size_t bufferCount() const noexcept;
    std::uint32_t planeCount() const noexcept;
    V4L2BufferQueueState state() const noexcept;

private:
    int fd_{-1};
    std::string device_path_;
    v4l2_buf_type capture_type_{V4L2_BUF_TYPE_VIDEO_CAPTURE};
    std::uint32_t plane_count_{0U};
    V4L2BufferQueueState state_{V4L2BufferQueueState::Idle};
    std::vector<BufferSlot> buffers_;
    bool driver_buffers_allocated_{false};

    void queueBuffer(std::uint32_t buffer_index);
    void stopNoThrow() noexcept;
    void releaseMappings() noexcept;
    void releaseDriverBuffersNoThrow() noexcept;
};
```

几个值得说的细节：

**这个类不拥有 fd。** 构造函数从 `V4L2Device` 借用 fd，析构时不 `close`。这意味着 `V4L2Device` 对象必须比 `V4L2BufferQueue` 活得更久。这种"借用不拥有"的关系在 C++ 里靠引用/裸指针表达，比 `std::shared_ptr` 之类的所有权共享更轻量，但要靠程序员自己保证生命周期——本篇用 `V4L2Device camera(device); V4L2BufferQueue queue(camera, actual);` 的局部变量声明顺序自然保证 camera 先构造、queue 后构造、queue 先析构、camera 后析构。

**析构函数不抛异常。** 这是 C++ 一条重要约定：析构函数在栈展开过程中会被调用，如果此时再抛异常且栈上已有别的异常在传播，`std::terminate` 就会触发，程序直接挂掉。所以 `~V4L2BufferQueue()` 走的是 best-effort 清理路径，调用三个 `noexcept` 私有方法：

```cpp
V4L2BufferQueue::~V4L2BufferQueue()
{
    stopNoThrow();
    releaseMappings();
    releaseDriverBuffersNoThrow();
}
```

`noexcept` 是 C++11 的关键字，告诉编译器"这个函数承诺不抛异常"。编译器据此可以做更激进的优化，运行时也会把意外抛出的异常直接转成 `std::terminate` 而不是继续传播——这正好是析构路径想要的行为：清理失败时不再往上抛，只让进程结束，避免更深的状态破坏。

但要注意：**正常业务路径不应该依赖析构清理**。析构是兜底，正常停止应该显式调用 `stop()`，这样错误才能反馈给上层。`stopNoThrow` 等内部清理方法只负责"尽力释放资源 + 清除本地所有权标记"，不报告错误。

## 申请 Buffer：REQBUFS + QUERYBUF + mmap

`requestBuffers` 是这一篇最长的方法，因为要依次走完 `REQBUFS` → `QUERYBUF` × N → `mmap` × N×P，还要在任一步失败时正确回滚。

```cpp
v4l2_requestbuffers request{};
request.count = requested_count;
request.type = capture_type_;
request.memory = V4L2_MEMORY_MMAP;

if (xioctl(fd_, VIDIOC_REQBUFS, &request) < 0) {
    throw systemError("VIDIOC_REQBUFS", device_path_);
}
```

`VIDIOC_REQBUFS` 同时做两件事：选定这个 fd 后续使用的 streaming 内存模型（这里 `V4L2_MEMORY_MMAP`），以及申请 buffer 数量。一个关键约定是——**驱动可以返回少于或多于 `requested_count` 的数量**，所以必须用 `request.count` 的实际返回值，不能继续使用应用最初请求的值。如果驱动返回 `count=0`，说明一个 buffer 都没分配到，后续没法继续。

申请成功后，要逐个 `QUERYBUF` 拿每个 buffer 的 `offset` 和 `length`，再 `mmap` 映射到用户态。multi-planar 和 single-planar 在这里分叉：

```cpp
if (capture_type_ == V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE) {
    v4l2_buffer buffer{};
    v4l2_plane planes[VIDEO_MAX_PLANES]{};
    buffer.type = capture_type_;
    buffer.memory = V4L2_MEMORY_MMAP;
    buffer.index = index;
    buffer.m.planes = planes;
    buffer.length = plane_count_;       // 输入：plane 数组容量

    if (xioctl(fd_, VIDIOC_QUERYBUF, &buffer) < 0) {
        throw systemError("VIDIOC_QUERYBUF", device_path_);
    }
    // 成功返回时 buffer.length 是驱动实际使用的 plane 数
    ...
}
```

这里有个新手容易踩的坑：multi-planar API 必须给 `v4l2_buffer.m.planes` 提供一个 `v4l2_plane[]` 数组，并在 `buffer.length` 写入"这个数组的容量"。`ioctl` 成功返回时，`buffer.length` 被改写成驱动实际使用的 plane 数。如果不在 `QUERYBUF` 之前清零 `planes`、或者 `buffer.length` 给错，驱动可能返回错误的内存布局。

拿到每个 plane 的 `planes[plane].m.mem_offset` 和 `planes[plane].length` 后，就可以 `mmap`：

```cpp
void* const address =
    ::mmap(nullptr,
           static_cast<std::size_t>(planes[plane].length),
           PROT_READ | PROT_WRITE,
           MAP_SHARED,
           fd_,
           static_cast<off_t>(planes[plane].m.mem_offset));
if (address == MAP_FAILED) {
    throw systemError("mmap", device_path_);
}
```

`MAP_SHARED` 是必须的——`MAP_PRIVATE` 会触发 copy-on-write，DMA 写入对应用不可见。`PROT_READ` 是必须的，`PROT_WRITE` 在本阶段其实用不到（采集只读不写），但保留以便后续可能的回灌场景。

这里有一段 C++ 细节值得讲——**先 `resize` 再 `mmap`**：

```cpp
// 先确定 vector 大小，再执行 mmap。这样 mmap 成功后仅进行不会抛出的
// 字段赋值，避免 vector 扩容失败导致刚映射的地址没有被记录。
slot.planes.resize(static_cast<std::size_t>(buffer.length));

for (std::uint32_t plane = 0U; plane < buffer.length; ++plane) {
    /* ... mmap ... */
    MappedPlane& mapping = slot.planes[static_cast<std::size_t>(plane)];
    mapping.address = address;
    mapping.length = static_cast<std::size_t>(planes[plane].length);
}
```

如果顺序反过来——先 `mmap` 拿到地址，再 `slot.planes.push_back(...)` 把它存进 `vector`——`push_back` 触发的扩容可能 `std::bad_alloc` 抛异常，结果就是 mmap 得到的地址没有被任何对象持有，析构时不会 `munmap`，泄漏了。`resize` 提前把容量准备好，后面只剩"不会抛异常的字段赋值"，资源所有权就稳了。这种"先准备容器再获取资源"的写法在 RAII 代码里很常见。

最后是失败回滚。`requestBuffers` 整个流程包在 `try { ... } catch (...) { ... throw; }` 里：

```cpp
try {
    /* REQBUFS, QUERYBUF, mmap 循环 */
    state_ = V4L2BufferQueueState::BuffersAllocated;
} catch (...) {
    // mmap 必须先解除，再调用 REQBUFS(count=0)。部分驱动不支持 orphaned
    // buffers，如果仍有映射存在，反向顺序会使 count=0 返回 EBUSY。
    releaseMappings();
    releaseDriverBuffersNoThrow();
    throw;
}
```

`catch (...)` 是"捕获所有异常"的写法，配合末尾的 `throw;`（注意是裸 `throw;` 不是 `throw e;`）实现"先做清理再重新抛出原始异常"。清理顺序很关键：必须先 `munmap` 所有映射，再 `REQBUFS(count=0)` 让驱动释放内核 buffer。部分驱动不支持"孤立的 buffer"——如果还有 `mmap` 存在，`count=0` 会返回 `EBUSY`，于是内核 buffer 永远释放不掉。所以 `releaseMappings()` 必须在 `releaseDriverBuffersNoThrow()` 之前调用。

## 入队与启动：QBUF + STREAMON

`queueAll()` 把所有 buffer 一个个交给驱动：

```cpp
void V4L2BufferQueue::queueAll()
{
    if (state_ != V4L2BufferQueueState::BuffersAllocated) {
        throw std::logic_error("queueAll requires the BuffersAllocated state");
    }
    /* 检查所有 buffer 都由应用持有 */
    for (std::size_t index = 0U; index < buffers_.size(); ++index) {
        queueBuffer(static_cast<std::uint32_t>(index));
    }
}
```

`std::logic_error` 是 C++ 标准库的"程序逻辑错误"异常基类，用来表示"调用方违反了使用约定"——比如在 `Idle` 状态下调用 `queueAll`、或者 buffer 还在 streaming 时重复 `queueAll`。和 `std::runtime_error`（运行时错误，比如 ioctl 失败）区分开，调用方可以根据异常类型判断到底是程序写错了还是环境出问题了。

`queueBuffer` 是真正的 `QBUF` 调用，并更新所有权标记：

```cpp
void V4L2BufferQueue::queueBuffer(std::uint32_t buffer_index)
{
    v4l2_buffer buffer{};
    v4l2_plane planes[VIDEO_MAX_PLANES]{};
    buffer.type = capture_type_;
    buffer.memory = V4L2_MEMORY_MMAP;
    buffer.index = buffer_index;

    if (capture_type_ == V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE) {
        buffer.m.planes = planes;
        buffer.length = plane_count_;
    }

    if (xioctl(fd_, VIDIOC_QBUF, &buffer) < 0) {
        throw systemError("VIDIOC_QBUF", device_path_);
    }

    buffers_[static_cast<std::size_t>(buffer_index)].owned_by_application = false;
}
```

`QBUF` 成功后，buffer 的所有权就转移给驱动，应用不能再访问这块内存——直到 `DQBUF` 把它归还。`BufferSlot::owned_by_application` 这个标记就是用来在 C++ 对象里追踪"这块 buffer 现在归谁"的，所有 `QBUF` 调用都把它设为 `false`，所有 `DQBUF` 都设为 `true`。

启动流：

```cpp
void V4L2BufferQueue::start()
{
    if (state_ != V4L2BufferQueueState::BuffersAllocated) {
        throw std::logic_error("start requires the BuffersAllocated state");
    }
    /* 检查所有 buffer 都已 QBUF */
    v4l2_buf_type type = capture_type_;
    if (xioctl(fd_, VIDIOC_STREAMON, &type) < 0) {
        throw systemError("VIDIOC_STREAMON", device_path_);
    }
    state_ = V4L2BufferQueueState::Streaming;
}
```

`STREAMON` 的参数是 `v4l2_buf_type` 本身（不是 buffer），而且这个 `type` 必须与 `S_FMT`、`REQBUFS`、`QUERYBUF`、`QBUF` 用过的 `type` 完全一致。一个常见错误是先用 `_MPLANE` 协商格式，又用普通 `_CAPTURE` 启动流，`STREAMON` 会返回 `EINVAL`。

## 采集循环：poll + DQBUF + QBUF

采集主循环长这样：

```cpp
while (captured_count < options.frame_count && g_stop_requested == 0) {
    if (!queue.waitForFrame(options.timeout_ms)) {
        if (g_stop_requested != 0) break;
        ++timeout_count;
        ++consecutive_timeouts;
        if (consecutive_timeouts >= 3U) {
            throw std::runtime_error("capture timed out three consecutive times");
        }
        continue;
    }

    CapturedFrame frame;
    if (!queue.tryDequeue(&frame)) continue;
    consecutive_timeouts = 0U;

    /* 统计 sequence gap / error frame */
    /* 打印 frame metadata */
    queue.requeue(frame.buffer_index);
    ++captured_count;
}
```

`waitForFrame` 内部是 `poll`：

```cpp
pollfd descriptor{};
descriptor.fd = fd_;
descriptor.events = POLLIN;

const int result = ::poll(&descriptor, 1U, timeout_ms);
if (result == 0) return false;        // 超时
if (result < 0) {
    if (errno == EINTR) return false;  // 被 signal 打断，让上层检查退出标志
    throw systemError("poll", device_path_);
}
if ((descriptor.revents & POLLNVAL) != 0) throw ...;
if ((descriptor.revents & POLLHUP) != 0) throw ...;
if ((descriptor.revents & POLLERR) != 0) throw ...;
return (descriptor.revents & POLLIN) != 0;
```

这里有一个和上一篇 `xioctl` 不一样的处理：**`poll` 的 `EINTR` 不重试，直接返回 `false`**。原因是 `SIGINT` / `SIGTERM` 会让 `poll` 返回 `EINTR`，如果在这里无条件重试，程序就永远响应不了 Ctrl+C。返回 `false` 让上层检查 `g_stop_requested` 标志，循环就能优雅退出。`xioctl` 重试 `EINTR` 是因为信号打断 ioctl 不携带"该退出"的语义；`poll` 不重试是因为它正是用来在等待中响应信号的——这两个选择不矛盾，是同一原则在不同上下文下的应用。

`tryDequeue` 是真正的 `DQBUF`：

```cpp
v4l2_buffer buffer{};
v4l2_plane planes[VIDEO_MAX_PLANES]{};
buffer.type = capture_type_;
buffer.memory = V4L2_MEMORY_MMAP;
if (capture_type_ == V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE) {
    buffer.m.planes = planes;
    buffer.length = plane_count_;
}

if (xioctl(fd_, VIDIOC_DQBUF, &buffer) < 0) {
    if (errno == EAGAIN) return false;
    throw systemError("VIDIOC_DQBUF", device_path_);
}
```

`O_NONBLOCK` 设备打开后，`DQBUF` 在没有可取的 buffer 时返回 `EAGAIN`——这不算错误，调用方继续 `poll` 即可。`DQBUF` 成功后，驱动填好的 `buffer.sequence` / `buffer.timestamp` / `buffer.flags` 和每个 plane 的 `planes[plane].bytesused` / `planes[plane].data_offset` 就是这一帧的真实元数据。

这里又有一处 C++ 细节——**`DQBUF` 前预先 `resize` 输出 vector**：

```cpp
// 在 DQBUF 前完成 vector 分配。这样成功取回 buffer 后，metadata 复制不会再因
// bad_alloc 抛出并遗失这个必须 requeue 的 buffer index。
CapturedFrame result;
result.planes.resize(static_cast<std::size_t>(plane_count_));

v4l2_buffer buffer{};
/* ... DQBUF ... */
```

理由和 `requestBuffers` 里的 `resize` 一样：`DQBUF` 成功意味着这块 buffer 的所有权已经回到应用，**应用必须保证最终 `requeue` 它**。如果 `DQBUF` 成功后、`requeue` 之前因为 `vector` 扩容抛 `bad_alloc`，这个 buffer 的 index 就丢了——驱动不会再把它当作 outgoing 暴露给应用，应用也不会把它 `QBUF` 回去，最终这块 buffer 永久卡在"被应用持有但应用忘了"的状态。预先 `resize` 把可能抛异常的容器操作挪到 `DQBUF` 之前，就避免了这种所有权泄漏。

应用读完一帧后通过 `requeue` 把 buffer 还给驱动：

```cpp
void V4L2BufferQueue::requeue(std::uint32_t buffer_index)
{
    if (buffer_index >= buffers_.size()) {
        throw std::out_of_range("buffer index is outside the allocated pool");
    }
    if (state_ != V4L2BufferQueueState::Streaming) {
        throw std::logic_error("requeue requires the Streaming state");
    }
    if (!buffers_[buffer_index].owned_by_application) {
        throw std::logic_error("buffer is already owned by the V4L2 driver");
    }
    queueBuffer(buffer_index);
}
```

注意 `requeue` 之后，`CapturedFrame::planes[i].data` 指针立即失效——那块内存的所有权已经回到驱动，它可能随时被 ISP 覆盖。所以 `main.cpp` 在 `requeue` 之前就把 metadata 全打印完，绝不持有 `frame.planes[i].data` 跨循环迭代。

## 错误帧、sequence 与统计

采集循环里专门处理三种异常情况：

```cpp
if ((frame.flags & V4L2_BUF_FLAG_ERROR) != 0U) {
    ++error_count;
}
if (have_previous_sequence && frame.sequence != previous_sequence + 1U) {
    ++sequence_gap_count;
}
previous_sequence = frame.sequence;
have_previous_sequence = true;
```

**`V4L2_BUF_FLAG_ERROR`** 表示这一帧 ISP/DMA 写入时出错（比如传输错误、CRC 校验失败），buffer 里的数据不可信。本篇只计数并继续 `requeue`，不把这种帧当作"采集成功"。后续如果要做实际图像处理，要根据应用场景决定是丢帧还是降级使用。

**`sequence` 跳变**统计驱动丢帧。V4L2 约定每采一帧 `buffer.sequence` 递增 1，如果应用看到 `5 → 7`，说明中间丢了一帧。`have_previous_sequence` 用来跳过第一帧的基线建立——第一帧的 `previous + 1` 没有意义，不能计为 gap。

**连续 3 次超时退出**：

```cpp
if (!queue.waitForFrame(options.timeout_ms)) {
    ++timeout_count;
    ++consecutive_timeouts;
    if (consecutive_timeouts >= 3U) {
        throw std::runtime_error("capture timed out three consecutive times");
    }
    continue;
}
```

3 次是个保守值，主要是为了容忍偶发的 ISP 启动抖动——很多 sensor 在 `STREAMON` 后的前几帧会慢一些。如果连续 3 次都没帧，基本可以判定采集链路有问题（sensor 离线、CSI 时序错、ISP 配置错等），直接退出比无限等待更利于调试。

最终统计输出：

```text
Capture complete: captured=100 errors=0 timeouts=0 sequence_gaps=0
```

四个数字自洽性检查：`captured + errors` 应等于应用处理的帧数；`sequence_gaps` 反映驱动内部丢帧；`timeouts` 反映"应该有帧但没有"。如果 `captured=100` 但 `sequence_gaps=20`，说明驱动输出了 120 帧但应用只看到 100 帧——可能是 `DQBUF` 不够快、或 `requeue` 不够及时。

## SIGINT/SIGTERM 安全退出

V4L2 采集循环如果用 Ctrl+C 直接中断，最坏情况是 ISP 正在写一块 buffer、驱动还持有 buffer 锁、`STREAMOFF` 没机会执行，留下半截 streaming 状态。下一次启动可能要 `STREAMOFF` 几次才能清干净。所以本篇开始引入信号安全退出。

signal handler 极短：

```cpp
volatile std::sig_atomic_t g_stop_requested = 0;

void requestStop(int signal_number)
{
    static_cast<void>(signal_number);
    g_stop_requested = 1;
}
```

这里有两个 C++/POSIX 关键点：

**`std::sig_atomic_t` 是唯一保证信号安全的基本类型。** 信号 handler 里只能访问 `volatile sig_atomic_t` 类型的全局变量，不能调用 `printf`、`malloc`、`std::cout`、`ioctl`、iostream 之类——这些都不是异步信号安全的（async-signal-safe），在 handler 里调用可能死锁或破坏堆。所以 handler 只做一件事：把标志从 0 改成 1，立即返回。

**`volatile`** 在这里不是为了多线程可见性（C++11 之后多线程可见性应该用 `std::atomic`），而是告诉编译器"这个变量可能被异步修改，每次都要从内存读，不能缓存到寄存器"。这是 C 时代信号处理的写法，C++ 里依然有效。

主循环检测到 `g_stop_requested != 0` 后，会跳出 `while`、调用 `queue.stop()` 执行 `STREAMOFF`，然后 `V4L2BufferQueue` 和 `V4L2Device` 的析构函数按声明顺序逆序执行——`queue` 先析构（`stopNoThrow` + `releaseMappings` + `releaseDriverBuffersNoThrow`），`camera` 后析构（`close(fd)`）。整个过程不依赖 signal handler 做任何 ioctl 或资源释放，只依赖主控制流。

注册 handler 在 `--capture` 模式入口：

```cpp
if (argc >= 2 && std::string(argv[1]) == "--capture") {
    std::signal(SIGINT, requestStop);
    std::signal(SIGTERM, requestStop);
    return runCapture(parseCaptureOptions(argc, argv));
}
```

`std::signal` 是 ISO C/C++11 的接口，跨平台性比 `sigaction` 好，对本篇的单线程 poll 循环够用。

## main.cpp：--capture 模式

入口函数现在支持三种调用形式：

```bash
camera_demo [video-device]                                       # probe
camera_demo [video-device] <width> <height> <FOURCC>              # set format
camera_demo --capture <video-device> [--width N --height N --format FOURCC
               --buffers N --frames N --timeout-ms N]            # 采集
camera_demo -h | --help                                           # 帮助
camera_demo --version                                             # 版本
```

`--help` 和 `--version` 在任何设备访问**之前**处理，这样即使在没有摄像头权限、甚至没有 `/dev/video*` 的机器上也能获取帮助和版本信息：

```cpp
if (argc == 2) {
    const std::string command = argv[1];
    if (command == "-h" || command == "--help") {
        printUsage(argv[0], std::cout);
        return EXIT_SUCCESS;
    }
    if (command == "--version") {
        printVersion();
        return EXIT_SUCCESS;
    }
}
```

`--version` 输出含 CMake 注入的版本号和目标架构：

```text
camera_demo 0.2.0 (C++11, target=rk3568-aarch64-linux)
```

`--capture` 的完整采集函数 `runCapture(options)` 就是前面几节拼起来：打开设备 → `setFormat` → `V4L2BufferQueue` 构造 → `requestBuffers` → `queueAll` → `start` → `while` 循环（`waitForFrame` → `tryDequeue` → 统计打印 → `requeue`）→ `stop` → 输出统计。整段代码在 `try` 块里，任何异常被 `main` 的 `catch (const std::exception&)` 统一处理。

## 板端复现

**开发机 vivid 验证：**

```bash
sudo ./tools/virtual_camera_modules.sh load
cmake -S . -B build && cmake --build build

# multi-planar vivid 实例上采集 100 帧
./build/camera_demo --capture /dev/video1 --width 640 --height 360 \
    --format NV12 --frames 100 --timeout-ms 2000
# 期望输出末尾：Capture complete: captured=100 errors=0 timeouts=0 sequence_gaps=0

# single-planar vivid 实例上重复
./build/camera_demo --capture /dev/video0 --width 640 --height 360 \
    --format NV12 --frames 100 --timeout-ms 2000
```

板端 RKISP 真实采集：

```bash
# 交叉编译并推到板子
./tools/cross_build_rk3568.sh
adb push build-rk3568/stage/bin/camera_demo /home/reynor/camera-project/bin/

# 真实采集 100 帧
adb shell "/home/reynor/camera-project/bin/camera_demo \
    --capture /dev/video0 --width 1920 --height 1080 \
    --format NV12 --frames 100 --timeout-ms 2000"
# 期望输出（截取几行）：
#   frame=0 buffer=0 sequence=0 timestamp=1234.012345 flags=0x10000 planes=1
#     plane=0 bytesused=3110400 data_offset=0 mapped=3110400
#   frame=1 buffer=1 sequence=1 timestamp=1234.045678 flags=0x10000 planes=1
#     plane=0 bytesused=3110400 data_offset=0 mapped=3110400
#   ...
#   Capture complete: captured=100 errors=0 timeouts=0 sequence_gaps=0
```

`bytesused=3110400` 正好对应上一篇 `G_FMT` 协商出的 `sizeimage`，`data_offset=0` 表示有效数据从 mmap 起始地址开始（NV12 在 RKISP 这条路径上没有前置 metadata 头）。`flags=0x10000` 是 `V4L2_BUF_FLAG_TIMESTAMP_MONOTONIC`，表示时间戳是 `CLOCK_MONOTONIC`。

**SIGINT 安全退出测试：** 启动一个 1000 帧的采集，几秒后按 Ctrl+C：

```bash
adb shell "/home/reynor/camera-project/bin/camera_demo \
    --capture /dev/video0 --width 1920 --height 1080 --format NV12 --frames 1000"
# 几秒后 Ctrl+C
# 期望末尾输出：
#   Capture complete: captured=NN errors=0 timeouts=0 sequence_gaps=0
# （NN < 1000，程序在当前帧处理后停止，STREAMOFF 成功）
```

## 当前阶段与下一篇

到目前为止，程序已经能从 `/dev/video0` 连续采集帧、统计 `sequence` 与错误、响应 Ctrl+C 安全退出。但本篇还**没解决**的事也很多：

- ❌ 没有 `VIDIOC_EXPBUF`：buffer 还是只能通过 `mmap` 访问，没法把这块内存共享给 RGA 或 DRM
- ❌ 没有显示链路：采集到的帧只能在内存里读 metadata，看不到画面
- ❌ 没有 RGA 旋转/格式转换：摄像头是 1920×1080 横屏、屏幕是 1080×1920 竖屏，方向不对
- ❌ 没有 Atomic KMS、没有 fence、没有 supervisor
- ❌ `consecutive_timeouts >= 3` 直接抛异常退出，没有自动重启 stream
