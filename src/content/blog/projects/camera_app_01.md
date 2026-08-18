---
title: 'Camera 开发（一）：V4L2 设备探测与格式协商'
description: '基于 RK3568 的 V4L2 Camera 应用开发记录，从设备能力探测到图像格式协商'
category: '项目'
series: { id: 'camera-development', order: 1 }
tags: ['Camera', 'Linux', 'V4L2', 'ISP', '图像处理']
pubDate: 'Jun 16 2026'
---

## 项目目标

目前手上有一块 RK3568 开发板和一个 Sony IMX415 Camera 模组，想要以此为基础在 Linux 上完成一个相对完整的 Camera Demo。

这里说的"完整"并不是简单调用一次 `v4l2-ctl` 把图像保存下来，而是希望自己把整个用户态的数据流程逐步搭建出来。前期先通过 V4L2 完成设备探测、格式协商和图像采集，之后再继续处理 Buffer、DMA-BUF，以及最终通过 DRM/KMS 将 Camera 图像输出到显示设备。

整个过程大致会涉及：

```text
IMX415
   │
   │ MIPI CSI-2
   ▼
CSI / DPHY
   │
   ▼
RKISP
   │
   │ V4L2
   ▼
/dev/videoX
   │
   │ MMAP / DMA-BUF
   ▼
Camera Application
   │
   │ DRM / KMS
   ▼
Display
```

其中 Sensor 驱动、设备树、MIPI CSI-2、Media Controller、RKISP 等更偏向驱动和 Camera Pipeline 的部分，我会放到另外的文章中记录。

这一篇先从用户态开始，只解决一个比较基础的问题：打开一个 `/dev/videoX` 之后，如何确认这个设备是什么、支持什么格式，以及最终应该按照什么样的图像内存布局来使用它。也就是说，目前还没有进入真正的 Buffer 申请和连续采集阶段。先把设备和格式这两件事情搞清楚，再继续往后做。

## 基础知识：V4L2 与本篇用到的 ioctl

做 Linux Camera 应用开发基本绕不开 V4L2。V4L2 全称是 Video for Linux 2，是 Linux 内核向用户空间提供的一套视频设备接口。对于应用程序来说，底层到底是 USB Camera、HDMI Capture，还是 RK3568 里的 ISP，并不是最重要的事情——只要驱动按照 V4L2 的接口向用户空间暴露设备，我们就可以使用统一的 `open()`、`ioctl()`、`mmap()` 等系统调用对它进行操作。

不过这里有一个刚开始比较容易产生的误解：并不是 Camera Pipeline 中的所有设备都会以 `/dev/videoX` 的形式出现。像 IMX415 这样的 Sensor，以及 CSI、ISP 内部的一些模块，在 Media Controller 架构下往往以 V4L2 Sub-device 的形式存在，对应 `/dev/v4l-subdevX`。真正承载完整视频帧、供应用程序执行 Capture 的节点，才通常表现为 `/dev/videoX`。

以我目前使用的 RK3568 为例，IMX415 采集到的 RAW Bayer 数据经过 MIPI CSI-2 和 RKISP 之后，ISP 的主路输出通过 `/dev/video0` 暴露给用户空间。应用程序现在操作的 `/dev/video0`，本质上是 ISP 的一个 Capture Queue，而不是直接在操作 IMX415 Sensor 本身。

因此现在的程序首先只围绕 `/dev/video0` 做几件事情：

```text
open
  ↓
VIDIOC_QUERYCAP
  ↓
VIDIOC_ENUM_FMT
  ↓
VIDIOC_ENUM_FRAMESIZES
  ↓
VIDIOC_S_FMT
  ↓
VIDIOC_G_FMT
```

本篇主要使用的 ioctl 如下：

| ioctl | 作用 |
| --- | --- |
| `VIDIOC_QUERYCAP` | 查询当前 video node 的身份和能力 |
| `VIDIOC_ENUM_FMT` | 枚举当前 Capture Queue 支持的像素格式 |
| `VIDIOC_ENUM_FRAMESIZES` | 查询某个像素格式支持的分辨率 |
| `VIDIOC_S_FMT` | 请求设置 Capture 格式 |
| `VIDIOC_G_FMT` | 获取驱动最终确认的实际格式 |

这一阶段并没有真正获取图像数据。它解决的是后面进行 Buffer 申请之前必须先知道的信息：这个节点是不是 Capture 设备？它使用 single-planar 还是 multi-planar API？是否支持 Streaming？支持哪些 Pixel Format、哪些分辨率？驱动最终确认的 width / height 是多少？一帧图像由几个 Memory Plane 组成？每个 Plane 的 stride 和 sizeimage 是多少？

这些值不能靠应用程序自己猜。尤其到了 ISP、DMA 和 DRM 这一层，图像在内存中的实际布局经常会受到硬件对齐的影响。即使应用请求的是 `1920x1080 NV12`，也不能简单认为 `size = 1920 * 1080 * 3 / 2` 就一定是驱动实际使用的 Buffer 大小。所以现在这一阶段的核心目标，其实就是从驱动那里获得一份可靠的"格式描述"。

## V4L2Device：用 C++ 把 fd 包成对象

V4L2 本身是一套 C API。如果直接使用 C，类似下面的代码非常常见：

```c
int fd = open("/dev/video0", O_RDWR);
if (fd < 0) {
    return -errno;
}

int rc = ioctl(fd, VIDIOC_QUERYCAP, &cap);
if (rc < 0) {
    close(fd);
    return -errno;
}

rc = ioctl(fd, VIDIOC_ENUM_FMT, &fmt);
if (rc < 0) {
    close(fd);
    return -errno;
}

/* ... */

close(fd);
```

这种写法本身并没有问题，但当程序越来越复杂以后，比较麻烦的是资源的生命周期。现在只有一个 video fd，后面进入正式采集之后，还会出现 mmap address、DMA-BUF fd、DRM fd、GEM handle、Framebuffer ID 等。这些资源几乎都是成对出现的：`open` 对 `close`、`mmap` 对 `munmap`、`EXPBUF` 对 `close`、`Create FB` 对 `Remove FB`。如果全部手工维护，那么任何一个中途失败的分支，都需要重新考虑当前已经申请了哪些资源以及应该按照什么顺序释放。

因此这个项目选择使用 C++ 来封装 V4L2。这里使用 C++ 并不是为了把 `ioctl()` 强行"面向对象化"，而是希望利用 RAII 管理系统资源。

RAII 是 Resource Acquisition Is Initialization 的缩写，简单可以理解成：一个对象负责拥有一个资源，对象存在时资源有效，对象销毁时自动释放资源。在 C++ 里这件事通过"构造函数申请资源、析构函数释放资源"这一组合实现——只要把资源获取写进构造函数、释放写进析构函数，编译器和运行时就会替你在所有出口（正常返回、提前 return、抛异常栈展开）自动执行清理，不需要再手写每个错误分支的 `close`。

目前的 `V4L2Device` 类定义长这样：

```cpp
class V4L2Device {
public:
    explicit V4L2Device(const std::string& path);
    ~V4L2Device();

    V4L2Device(const V4L2Device&) = delete;
    V4L2Device& operator=(const V4L2Device&) = delete;

    DeviceCapabilities queryCapabilities() const;
    std::vector<PixelFormatInfo> enumerateFormats() const;

    VideoFormat setFormat(std::uint32_t width,
                          std::uint32_t height,
                          std::uint32_t pixel_format);

    int fd() const noexcept;
    const std::string& path() const noexcept;

private:
    std::string path_;
    int fd_{-1};
};
```

构造函数负责打开设备，析构函数负责关闭：

```cpp
V4L2Device::V4L2Device(const std::string& path)
    : path_(path)
{
    fd_ = ::open(path_.c_str(),
                 O_RDWR | O_NONBLOCK | O_CLOEXEC);

    if (fd_ < 0) {
        throw systemError("open", path_);
    }
}

V4L2Device::~V4L2Device()
{
    if (fd_ >= 0) {
        ::close(fd_);
    }
}
```

使用方因此不需要关心 `close()`：

```cpp
try {
    V4L2Device camera("/dev/video0");

    const auto caps = camera.queryCapabilities();
    const auto formats = camera.enumerateFormats();
    const auto actual =
        camera.setFormat(1920, 1080, V4L2_PIX_FMT_NV12);

    /* ... */
}
catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
}
```

当 `camera` 离开当前作用域时，它的析构函数会自动执行。即使 `camera.queryCapabilities()` 或 `camera.setFormat(...)` 中途抛出了异常，只要 `camera` 对象之前已经完整构造完成，在 C++ 栈展开过程中它的析构函数仍然会被执行，因此 fd 也会正常关闭。这正是 RAII 相对手工 `close` 的核心好处——失败路径不再需要单独写清理代码。

这里需要特别区分另外一种情况：如果 `V4L2Device` 自己的构造函数执行过程中 `open()` 失败并抛出异常，那么这个对象实际上没有完成构造，因此 `V4L2Device::~V4L2Device()` 不会被调用。所以 `int fd_{-1};` 这个默认值并不是为了"构造失败以后析构还能安全执行"——它更像是一种明确的对象状态约定：`fd_ == -1` 表示当前没有持有有效 fd，`fd_ >= 0` 表示当前持有一个有效 fd。这可以让类内部始终有一个确定的初始状态，而不是让 `fd_` 保持未初始化值。

类里还禁止了复制：

```cpp
V4L2Device(const V4L2Device&) = delete;
V4L2Device& operator=(const V4L2Device&) = delete;
```

原因也很简单。假如允许直接复制 `V4L2Device b = a;`，两个对象内部很可能保存同一个 fd，最终两个析构函数都会尝试 `close(同一个 fd)`，第二次 close 要么报错要么更糟。对于 fd 这种具有明确所有权的资源，当前最简单的处理方式就是禁止复制。后面如果确实需要在对象之间转移资源，再考虑实现 Move Constructor 和 Move Assignment。

> C 程序员刚接触 C++ 时容易觉得"RAII + 异常"听起来很重，其实它解决的就是 C 里那种"每个 `if (rc < 0)` 都要写一遍清理"的体力活。

## xioctl：处理 EINTR 与 errno

V4L2 大部分操作最终都通过 `ioctl()` 实现，例如 `::ioctl(fd_, VIDIOC_QUERYCAP, &capability)`。当前代码又封装了一层：

```cpp
int xioctl(int fd,
           unsigned long request,
           void* argument)
{
    int result;

    do {
        result = ::ioctl(fd, request, argument);
    } while (result < 0 && errno == EINTR);

    return result;
}
```

主要是为了处理 `EINTR`。Linux 进程收到 Signal 时，正在执行的某些系统调用可能提前返回 `-1` 并把 `errno` 设置成 `EINTR`，表示系统调用被信号打断，并不等于 V4L2 驱动发生故障。因此这里遇到 `EINTR` 就重新执行一次原来的 ioctl。其他错误则保持原来的 `-1` 和 `errno` 交给调用方处理。

失败之后用一个小函数把 errno 转换成带操作名和设备路径的异常：

```cpp
std::runtime_error systemError(
    const std::string& operation,
    const std::string& path)
{
    const int error = errno;

    return std::runtime_error(
        operation + " failed for " + path +
        ": " + std::strerror(error) +
        " (errno=" + std::to_string(error) + ")");
}
```

`const int error = errno;` 会在函数一开始就把 `errno` 保存下来。原因是 `errno` 表示的是当前线程最近一次相关系统调用留下的错误状态，后面如果继续调用其他函数（包括 `std::strerror`、`std::to_string`、`std::string +` 这些标准库操作），就不应该再假定它一定还保持原值——这些函数本身可能修改 `errno`。所以比较稳妥的习惯是：

```cpp
if (xioctl(...) < 0) {
    const int error = errno;
    /* 后续再做日志或者字符串处理 */
}
```

不要先执行一大串其他代码，最后才回来读取 `errno`。这是 C/C++ 系统编程最常见的 bug 之一。

## 设备能力探测：QUERYCAP

打开 `/dev/video0` 并不代表已经知道它是什么设备。一台 Linux 机器上可能同时存在 USB Camera、Virtual Camera、ISP Main Path、ISP Self Path、Codec、HDMI Capture 等，所以打开设备后的第一步是 `VIDIOC_QUERYCAP`：

```cpp
DeviceCapabilities
V4L2Device::queryCapabilities() const
{
    v4l2_capability capability{};

    if (xioctl(fd_, VIDIOC_QUERYCAP, &capability) < 0) {
        throw systemError("VIDIOC_QUERYCAP", path_);
    }

    /* ... */
}
```

`v4l2_capability capability{}` 后面的 `{}` 是 C++11 的值初始化。对于这种要传递给内核的结构体，我一般都会先整体清零，尤其是 V4L2 UAPI 中经常包含 `reserved` 字段——驱动对未清零的 reserved 字段行为未定义。C 中比较常见的写法是 `memset(&cap, 0, sizeof(cap))`，C++ 中使用 `v4l2_capability capability{};` 会更加简单，效果一致。

`VIDIOC_QUERYCAP` 返回以后，可以获取 `driver`、`card`、`bus_info`、`capabilities`、`device_caps` 等字段。其中 `driver` / `card` / `bus_info` 主要用于确认设备身份，而 `capabilities` 和 `device_caps` 才决定后面应该使用什么 API。

这里有一个容易忽略的细节：不能永远直接使用 `capability.capabilities` 判断当前 `/dev/videoX` 的能力。如果 `capability.capabilities & V4L2_CAP_DEVICE_CAPS` 不为 0，说明驱动支持 `device_caps` 字段，此时当前这个具体 Video Node 的能力应该从 `capability.device_caps` 读取。所以项目中单独做了一层：

```cpp
std::uint32_t
effectiveCapabilities(const v4l2_capability& capability)
{
    if ((capability.capabilities
         & V4L2_CAP_DEVICE_CAPS) != 0U) {
        return capability.device_caps;
    }

    return capability.capabilities;
}
```

可以简单理解成：`capabilities` 可能描述的是更上层设备整体拥有的能力，而 `device_caps` 描述的是当前具体 `/dev/videoX` 节点的能力。对于一个 ISP 来说尤其容易出现这种情况，因为一个 ISP 可能同时对应多个 Video Node，每个 Node 的用途并不完全相同——`/dev/video0` 是 main path、`/dev/video1` 是 self path、`/dev/video2~4` 是 RAW writer、`/dev/video7` 是 ISP statistics 等。

拿到有效能力以后，还要判断当前节点到底采用 `V4L2_BUF_TYPE_VIDEO_CAPTURE` 还是 `V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE`：

```cpp
v4l2_buf_type
selectCaptureType(std::uint32_t capabilities)
{
    if ((capabilities
         & V4L2_CAP_VIDEO_CAPTURE_MPLANE) != 0U) {
        return V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE;
    }

    if ((capabilities
         & V4L2_CAP_VIDEO_CAPTURE) != 0U) {
        return V4L2_BUF_TYPE_VIDEO_CAPTURE;
    }

    throw std::runtime_error(
        "device is neither VIDEO_CAPTURE "
        "nor VIDEO_CAPTURE_MPLANE");
}
```

这里的 single-planar 和 multi-planar 是我刚开始看 V4L2 时比较容易理解错的一个地方。`VIDEO_CAPTURE_MPLANE` 里的 Plane，主要指的是 Memory Plane，而不是简单指 Y Plane / U Plane / V Plane。也就是说，这里描述的是**一帧图像在内存层面由几块独立的存储区域组成**，而不是单纯描述像素格式里面有几个颜色分量。

以 NV12 为例。从图像格式来看，它可以分成 Y 和 UVUVUV... 两部分，因此从图像数据的角度可以认为包含 Y Image Plane 和 UV Image Plane 两个 Image Plane。但是这两部分数据完全可以连续放在同一块内存中：

```text
┌──────────────────────────────┐
│                              │
│           Y Data             │
│                              │
├──────────────────────────────┤
│           UV Data            │
└──────────────────────────────┘
```

此时 Image Plane = 2，但 Memory Plane = 1。所以 Image Plane 和 Memory Plane 并不是同一个概念。这也解释了我目前 RK3568 上看到的情况：Capture API 是 `V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE`，Pixel Format 是 NV12，但 `num_planes == 1`。第一眼看可能会觉得矛盾——"既然是 MPLANE，为什么 num_planes 又等于 1？"实际上并不矛盾：`V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE` 表示当前设备使用 V4L2 的 Multi-planar API，而 `num_planes == 1` 表示当前这个具体格式实际上只有一个 Memory Plane。NV12 的 Y 和 UV Image Plane 仍然可以位于同一块 Memory Plane 中。这个区别后面进入 `QUERYBUF`、`mmap` 和 DMA-BUF 的时候会更加重要，现在先把概念区分开即可。

最后还强制检查 `V4L2_CAP_STREAMING`：

```cpp
if ((result.effective_caps & V4L2_CAP_STREAMING) == 0U) {
    throw std::runtime_error(
        path_ + " does not support streaming I/O");
}
```

这是因为这个项目后面的图像采集不会走简单的 `read()` 模式，而是计划使用 V4L2 Streaming API，也就是 `REQBUFS` / `QUERYBUF` / `QBUF` / `STREAMON` / `DQBUF` / `STREAMOFF` 再配合 `MMAP` 管理 Capture Buffer。因此如果设备本身不支持 `V4L2_CAP_STREAMING`，那么后面的 Buffer Queue 就没有继续实现的意义。不过 Buffer 部分目前还没有进入正式开发，这里只是提前确认设备具备这个能力。

## 格式枚举：ENUM_FMT 与 ENUM_FRAMESIZES

确认设备确实是 Capture Device 之后，下一步就是查询它能够输出什么格式。V4L2 使用 `VIDIOC_ENUM_FMT` 枚举 Pixel Format：

```cpp
for (std::uint32_t index = 0;; ++index) {
    v4l2_fmtdesc description{};

    description.index = index;
    description.type = type;

    if (xioctl(fd_, VIDIOC_ENUM_FMT, &description) < 0) {
        if (errno == EINVAL) {
            break;
        }

        throw systemError("VIDIOC_ENUM_FMT", path_);
    }

    /* 保存 description */
}
```

V4L2 很多枚举类 ioctl 都采用这种方式：从 `index = 0` 开始不断向驱动请求下一项，当 `index` 已经超过最后一个合法项时，驱动返回 `errno = EINVAL`。因此这里的 `EINVAL` 不应该按照普通 ioctl 失败处理——在 `VIDIOC_ENUM_FMT` 这个上下文里，它实际上表示"枚举结束"。同样的规则也会出现在 `VIDIOC_ENUM_FRAMESIZES` 和 `VIDIOC_ENUM_FRAMEINTERVALS` 等 V4L2 枚举接口中，是 V4L2 一类约定。

需要说明的是 `description.type` 必须设置成 `captureType()` 返回的 `V4L2_BUF_TYPE_VIDEO_CAPTURE` 或 `_MPLANE`——它告诉驱动你要枚举的是 capture queue 还是 output queue 的格式。本项目只关心 capture。

Pixel Format 在 V4L2 中通常使用 FourCC（Four Character Code）表示，例如 `NV12`、`YUYV`、`RGB3`、`RG10`，实际上会被编码成一个 32-bit 整数（`V4L2_PIX_FMT_NV12` 对程序来说本质上就是一个 `std::uint32_t`）。如果直接打印这个整数，可读性会非常差，所以项目中使用 `fourccToString()` 把它重新转换成人能够直接理解的四字符字符串。对于 Camera 调试来说，这种日志上的小细节还是比较重要的——后面遇到 Format Negotiation、DRM Format 或者 Buffer 不匹配时，相比一个十进制整数，直接看到 `NV12` / `YUYV` / `RG10` 会方便很多。

知道设备支持 NV12 以后，还不能简单理解成"既然支持 NV12，那什么分辨率都能输出"。Pixel Format 和 Resolution 实际上需要组合起来判断，所以对于枚举到的每个格式，又调用 `VIDIOC_ENUM_FRAMESIZES`，例如可能得到 `NV12` 支持 `640x480` / `1280x720` / `1920x1080` 三种尺寸。`v4l2_frmsizeenum` 的结果主要有 Discrete、Stepwise、Continuous 三种类型：

- **Discrete** 最直观，表示驱动明确给出了一个具体尺寸，例如 `1920x1080`。
- **Stepwise** 是一段带有步长约束的范围，例如 `min_width=320, max_width=1920, step_width=16`，表示宽度在这个区间内按照 16 为步长变化。
- **Continuous** 可以理解成步长约束为 1 的特殊情况。

当前代码把这些信息统一保存进 `FrameSizeInfo`，而不是让上层代码直接操作 `v4l2_frmsizeenum`。这样后面的 `main.cpp` 只需要关心项目自己的数据结构。

## 格式协商：S_FMT 与 G_FMT

完成能力和格式枚举以后，下一步就是 `VIDIOC_S_FMT`。例如应用希望 `1920x1080 NV12`，代码会先构造 `v4l2_format`：

```cpp
v4l2_format format{};
format.type = type;
```

这里需要注意：`v4l2_format` 内部包含一个 union。如果设备是 `V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE`，应该操作 `format.fmt.pix_mp`；如果是 `V4L2_BUF_TYPE_VIDEO_CAPTURE`，则操作 `format.fmt.pix`。例如：

```cpp
if (type == V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE) {
    format.fmt.pix_mp.width = width;
    format.fmt.pix_mp.height = height;
    format.fmt.pix_mp.pixelformat = pixel_format;
    format.fmt.pix_mp.field = V4L2_FIELD_ANY;
} else {
    format.fmt.pix.width = width;
    format.fmt.pix.height = height;
    format.fmt.pix.pixelformat = pixel_format;
    format.fmt.pix.field = V4L2_FIELD_ANY;
}
```

不能因为 `pix` 和 `pix_mp` 里面有很多相似字段就混着访问——`format.type` 决定当前 union 中应该按照哪一种格式解释数据。

这是 Format Negotiation 中比较重要的一点：调用 `VIDIOC_S_FMT` 不能简单理解成"我要求驱动输出 1920x1080 NV12，所以以后一定就是 1920x1080 NV12"。V4L2 驱动可能根据硬件能力对请求进行调整。比如应用请求 `1919x1079`，但是硬件要求宽高满足某种对齐，最终驱动可能调整成另外一个合法尺寸。因此 Requested Format 和 Actual Format 不能默认相等。

当前代码在 `VIDIOC_S_FMT` 之后又显式重新调用 `VIDIOC_G_FMT`：

```cpp
if (xioctl(fd_, VIDIOC_S_FMT, &format) < 0) {
    throw systemError("VIDIOC_S_FMT", path_);
}

format = {};
format.type = type;

if (xioctl(fd_, VIDIOC_G_FMT, &format) < 0) {
    throw systemError("VIDIOC_G_FMT", path_);
}
```

实际上 `VIDIOC_S_FMT` 本身返回时，驱动也会把调整后的格式写回 `v4l2_format`。这里再执行一次 `G_FMT`，主要是希望逻辑更加明确：`S_FMT` 请求设置格式，`G_FMT` 明确读取当前实际格式。后面的所有 Buffer 逻辑只应该相信最终读取出来的实际格式，而不应该继续使用应用最初请求的参数。

格式协商完成以后，目前最关心的几个数据是 `width`、`height`、`pixel_format`、`plane_count`、`bytesperline`（也就是我们经常说的 stride）和 `sizeimage`。对于 Multi-planar API：

```cpp
const v4l2_pix_format_mplane& actual = format.fmt.pix_mp;
```

读取 `actual.width`、`actual.height`、`actual.pixelformat`、`actual.num_planes`，每个 Memory Plane 还会有 `actual.plane_fmt[plane].bytesperline` 和 `actual.plane_fmt[plane].sizeimage`。

这里 `bytesperline`（stride）表示从当前行的起始位置走到下一行起始位置需要跨过多少字节。假设图像宽度是 1920，并不能直接认为 stride = 1920，因为硬件内存通常存在对齐要求。例如真实布局可能是：

```text
|<------ 有效数据 1920 ------>|<- Padding ->|

YYYYYYYYYYYYYYYYYYYYYYYYYYYY........
|<------------- 2048 -------------->|
```

这时 width = 1920 但 stride = 2048。如果程序处理下一行时直接 `address += width;` 就会访问到错误位置，正确的步长应该来自驱动返回的 `bytesperline`。而 `sizeimage` 表示驱动认为这一块 Memory Plane 至少需要多大的存储空间，所以后面进行 Buffer 映射时，也不能简单自己计算 `width * height` 然后作为 Buffer 大小——必须使用 `sizeimage`。

对于 Single-planar API，目前统一认为 `plane_count = 1`，并从 `actual.bytesperline` 和 `actual.sizeimage` 获取对应信息。最终这些数据都保存进项目自己的 `VideoFormat` 结构里。

## main.cpp：把这些拼成命令行工具

现在 `main.cpp` 的使用方式大致如下：

```cpp
int main(int argc, char* argv[])
{
    /* 参数检查 */

    const std::string device =
        argc >= 2 ? argv[1] : "/dev/video0";

    try {
        V4L2Device camera(device);

        const DeviceCapabilities capabilities =
            camera.queryCapabilities();

        const std::vector<PixelFormatInfo> formats =
            camera.enumerateFormats();

        /* 打印设备和格式 */

        if (argc == 5) {
            const std::uint32_t width =
                static_cast<std::uint32_t>(
                    std::stoul(argv[2]));

            const std::uint32_t height =
                static_cast<std::uint32_t>(
                    std::stoul(argv[3]));

            const std::uint32_t pixel_format =
                parseFourcc(argv[4]);

            const VideoFormat actual =
                camera.setFormat(
                    width,
                    height,
                    pixel_format);

            std::cout
                << "Requested format: "
                << width << 'x' << height << ' '
                << fourccToString(pixel_format)
                << '\n';

            std::cout
                << "Actual format: "
                << actual.width
                << 'x'
                << actual.height
                << ' '
                << fourccToString(
                       actual.pixel_format)
                << '\n';

            std::cout
                << "Memory planes: "
                << actual.plane_count
                << '\n';

            for (std::uint32_t plane = 0;
                 plane < actual.plane_count;
                 ++plane) {

                std::cout
                    << "Plane " << plane
                    << ": stride="
                    << actual.bytes_per_line[plane]
                    << ", size="
                    << actual.size_image[plane]
                    << '\n';
            }
        }
    }
    catch (const std::exception& error) {
        std::cerr
            << "camera_demo: "
            << error.what()
            << '\n';

        return EXIT_FAILURE;
    }

    return EXIT_SUCCESS;
}
```

这里使用的 `std::stoul()` 会在参数无法转换时抛出 `std::invalid_argument`，如果数值超出范围则抛出 `std::out_of_range`，最终都可以被外层 `catch (const std::exception& error)` 统一处理。这样**非法参数进不了 ioctl**——转换失败时根本不会调用到 `setFormat`。

目前 `main.cpp` 真正完成的工作其实还比较有限：打开设备、确认设备身份、确认 Capture API、确认是否支持 Streaming、枚举 Pixel Format、枚举 Frame Size、请求 Format、读取 Actual Format、输出 Plane / stride / sizeimage。虽然还没有真正获得一帧图像，但这一步实际上是后面所有 Buffer 操作的基础。如果连"当前到底有几个 Memory Plane、每个 Plane 的 stride 是多少、每个 Plane 的 sizeimage 是多少"都没有确认，就直接开始申请和解释 Buffer，后面的很多代码只能建立在猜测上。

## CMake 与交叉编译

项目目前使用 CMake 管理。`CMakeLists.txt` 的核心内容：

```cmake
cmake_minimum_required(VERSION 3.16)

project(camera_demo LANGUAGES CXX)

set(CMAKE_CXX_STANDARD 11)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_CXX_EXTENSIONS OFF)

set(CMAKE_EXPORT_COMPILE_COMMANDS ON)

option(CAMERA_DEMO_WARNINGS_AS_ERRORS
       "Treat warnings as errors"
       OFF)

add_executable(camera_demo
    src/main.cpp
    src/v4l2_device.cpp
)

target_include_directories(
    camera_demo
    PRIVATE
    ${CMAKE_CURRENT_SOURCE_DIR}/inc
)

target_compile_features(
    camera_demo
    PRIVATE
    cxx_std_11
)

target_compile_options(
    camera_demo
    PRIVATE
    -Wall
    -Wextra
    -Wpedantic
)

if(CAMERA_DEMO_TARGET_RK3568_AARCH64)
    target_compile_definitions(
        camera_demo
        PRIVATE
        CAMERA_DEMO_TARGET_RK3568_AARCH64=1
    )
endif()

install(
    TARGETS camera_demo
    RUNTIME DESTINATION bin
)
```

项目目前要求 ISO C++11，因此 `CMAKE_CXX_STANDARD 11` + `CMAKE_CXX_STANDARD_REQUIRED ON` + `CMAKE_CXX_EXTENSIONS OFF`。其中 `CMAKE_CXX_EXTENSIONS OFF` 会要求 CMake 尽量使用 `-std=c++11` 而不是 `-std=gnu++11`，避免代码在不知情的情况下依赖 GNU C++ 扩展。同时又写了 `target_compile_features(camera_demo PRIVATE cxx_std_11)`——对于当前只有一个 Target 的小项目来说，这两层确实有一定重复，但我更希望把语言要求也绑定在具体 Target 上。后面如果增加单元测试、DRM Demo 或其他可执行程序，每个 Target 的编译要求会更加明确。

另外一个对日常开发比较重要的设置是 `CMAKE_EXPORT_COMPILE_COMMANDS ON`。它会在构建目录生成 `compile_commands.json`，记录每个 `.cpp` 文件真实的编译命令，包括编译器路径、`-I` include path、`-D` 宏定义、C++ 标准、Sysroot 和其他编译参数。我平时使用 VSCode + clangd，因此 `compile_commands.json` 很重要——特别是交叉编译环境里，真正使用的可能是 `aarch64-linux-gnu-g++` 而不是电脑本身的 `g++`。clangd 如果拿不到真实编译参数，就很容易出现"代码明明能编译，但是 IDE 一直报错"的情况。

开发板使用的是 RK3568，而我平时写代码和编译是在 x86_64 Linux 主机上进行的，所以 Build Machine 是 x86_64 Linux，Target Machine 是 RK3568 / AArch64 Linux，不能直接用主机上的普通 `g++` 生成最终程序，而需要使用能够生成 AArch64 ELF 的交叉编译器。Toolchain 文件目前位于 `cmake/toolchains/rk3568-aarch64.cmake`，核心内容：

```cmake
set(CMAKE_SYSTEM_NAME Linux)
set(CMAKE_SYSTEM_PROCESSOR aarch64)

set(
    CAMERA_DEMO_TARGET_RK3568_AARCH64
    ON
    CACHE BOOL
    "Build camera_demo for a 64-bit RK3568 Linux target"
    FORCE
)

set(CMAKE_CXX_COMPILER ${RK3568_CROSS_COMPILE}g++)
set(CMAKE_C_COMPILER   ${RK3568_CROSS_COMPILE}gcc)
```

`CMAKE_SYSTEM_NAME Linux` 表示最终程序运行在 Linux 上，`CMAKE_SYSTEM_PROCESSOR aarch64` 描述目标处理器架构。不过真正决定最后使用哪个 Compiler 的仍然是 `CMAKE_C_COMPILER` 和 `CMAKE_CXX_COMPILER`。例如 `RK3568_CROSS_COMPILE=/opt/toolchain/bin/aarch64-linux-gnu-`，那么 `${RK3568_CROSS_COMPILE}g++` 最终就是 `/opt/toolchain/bin/aarch64-linux-gnu-g++`。

这里也有一个比较值得注意的地方：`set(CMAKE_SYSTEM_PROCESSOR aarch64)` 只是告诉 CMake 当前 Target 的架构信息，并不意味着随便配置一个 Compiler，CMake 就能够自动把它变成 AArch64 编译器。所以最终还需要确认真正生成出来的 ELF。当前 `tools/cross_build_rk3568.sh` 在构建结束以后会进行一次检查：

```bash
binary="${stage_dir}/bin/camera_demo"

machine="$(
    "${readelf_tool}" -h "${binary}" |
    sed -n 's/^[[:space:]]*Machine:[[:space:]]*//p'
)"

if [[ "${machine}" != *AArch64* ]]; then
    echo "error: output is not an AArch64 ELF: ${machine}" >&2
    exit 1
fi
```

这里检查的是 ELF Header 中的 `Machine`，最终必须是 `AArch64`。我比较喜欢这种检查方式，因为 Toolchain 文件里的 `aarch64` 只是配置，而真正生成出来的 ELF 才是最终结果。代码中另外还有一道简单检查：

```cpp
#if defined(CAMERA_DEMO_TARGET_RK3568_AARCH64)

static_assert(
    sizeof(void*) == 8U,
    "RK3568 AArch64 build requires a 64-bit target compiler");

#endif
```

`static_assert` 是编译期断言。如果误用了 32 位 ARM 编译器，`sizeof(void*) == 4`，那么程序会直接在编译阶段失败，而不是一直等到文件复制到开发板之后才发现架构不对。

## 当前阶段与下一篇

到目前为止，这个 Camera Demo 还停留在设备探测与格式协商阶段。

一开始看 V4L2 时，我比较容易把这部分理解成一堆固定流程——`QUERYCAP`、`ENUM_FMT`、`S_FMT`、`G_FMT`，照着示例代码依次调用就可以。真正自己开始封装以后，会发现这些 ioctl 实际上是在逐步确认后面数据通路需要遵守的条件。`QUERYCAP` 决定当前节点到底能不能按照预期进行 Capture；`VIDEO_CAPTURE` 和 `VIDEO_CAPTURE_MPLANE` 决定后面应该使用哪一套 V4L2 数据结构；`ENUM_FMT` 和 `ENUM_FRAMESIZES` 确认驱动真正支持的图像格式；`S_FMT` / `G_FMT` 则最终确定后续 Buffer 必须遵循的真实内存布局。

尤其是 Memory Plane、stride、sizeimage 这些信息，已经开始从"图像格式"进入"图像如何存在内存里"的问题。下一阶段就会正式开始申请 V4L2 Buffer，届时流程会继续进入 `VIDIOC_REQBUFS` → `VIDIOC_QUERYBUF` → `mmap` → `VIDIOC_QBUF` → `VIDIOC_STREAMON` → `VIDIOC_DQBUF`。到那时，需要重点解决的就不再只是设备能力和格式，而是一帧图像对应的 Buffer 到底存放在哪里、应用和驱动分别在什么时候拥有 Buffer，以及为什么 Capture 需要准备一组 Buffer 在两边循环流转。这一部分等实际代码完成以后再继续记录。
