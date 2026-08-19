---
title: 'Camera 开发（五）：DRM/KMS 资源探测'
description: '基于 RK3568 的 V4L2 Camera 应用开发记录，从打开 DRM 设备到自动选择 connector/CRTC/mode 的只读探测'
series: { id: 'camera-development', order: 5 }
tags: ['Camera', 'Linux', 'V4L2', 'DRM/KMS', '图像处理']
pubDate: 'Jun 20 2026'
---

## 本篇要解决的问题

第 4 篇结束时画出了目标链路：V4L2 → DMA-BUF → RGA → DRM framebuffer → VOP → DSI panel。其中 V4L2 那一头（前三篇）已经能采集、能导出 DMA-BUF fd。从本篇开始向 DRM 那一头延伸。

但写 DRM 代码不能直接从 `drmModeSetCrtc` 开始——`drmModeSetCrtc` 需要 connector ID、CRTC ID、mode 参数，这些数字每个板子都不一样，每次启动都可能变。如果硬编码 `connector_id=163`、`crtc_id=115` 这种从某次 `modetest` 抄来的数字，换一台板子或重启一次就跑不了。所以第一件事是**运行时探测**：打开 `/dev/dri/card0`，问内核"你有哪些 connector、哪个连着屏、它支持什么 mode、哪个 CRTC 能驱动它"。

本篇的目标就是写一个叫 `drm_probe` 的小程序，它打开 DRM 设备、自动选择 connected connector、preferred mode 和兼容 CRTC，把这些 ID 和能力打印出来。**只读，不申请 DRM master，不创建 framebuffer，不执行 modeset**——这样能在 Weston 运行时使用，不会把桌面搞黑。等下一篇真正做 modeset 时，再处理 master 和清理顺序。

## 基础知识：DRM/KMS 的对象模型

V4L2 那边的对象模型相对简单：device + buffer queue + format。DRM/KMS 这边的对象多一倍，新手最容易在这里绕晕。先把主要对象和关系画出来：

```text
Framebuffer ─── Plane ─── CRTC ─── Encoder ─── Connector ─── 物理 output
  (内存布局)    (图层)    (扫描/时序)   (路由)      (接口)        (DSI/HDMI/...)
```

逐个解释：

- **Framebuffer**：一张可被显示硬件读取的图像描述，指向一块 GEM/DDR 内存对象 + 像素格式 + stride。
- **Plane**：一层图像。primary plane 是主层，overlay plane 是叠加层。每个 plane 可以设来源区域、屏幕位置、缩放、旋转等。一个 CRTC 可以同时扫描多个 plane 做合成。
- **CRTC**：一条显示扫描流水线。负责产生显示时序（hsync/vsync/blanking/active），把各 plane 合成后逐行扫描输出。RK3568 里对应 VOP2 硬件。
- **Encoder**：从 CRTC 到输出接口的路由抽象。把 CRTC 的 RGB 像素流编码成对应接口的格式。
- **Connector**：物理输出接口，例如 `DSI-1`、`HDMI-A-1`、`eDP-1`。报告连接状态（connected/disconnected）和支持的 mode 列表。
- **Mode**：一个完整的显示时序参数集，包括分辨率（hdisplay/vdisplay）、刷新率、pixel clock、hsync/vsync 极性等。

典型关系：一块 framebuffer 挂到某个 plane 上，plane 挂到 CRTC 上，CRTC 通过 encoder 路由到 connector，connector 物理连接到屏幕。本篇要做的事就是：在 resources 列表里找到一条 `connector → encoder → CRTC` 的可用路由，再从 connector 的 mode 列表里选一个 preferred mode。

## 三个 character device 的区别

DRM 在 `/dev/dri/` 下通常有三个节点：

| 节点 | 用途 | 本篇用 |
| --- | --- | --- |
| `/dev/dri/card0` | primary node，KMS ioctl 入口 | ✅ |
| `/dev/dri/card1` | 另一个 DRM 设备（RK3568 上是 RKNPU，不是显示） | ❌ |
| `/dev/dri/renderD128` | render node，只用于 GPU 渲染，不能 modeset | ❌ |

`card1` 在 RK3568 上是 RKNPU（NPU）的 DRM 设备，不是显示 KMS，所以探测要明确指定 `card0`，不能遍历。`renderD*` 是无 master 的渲染入口，做 GPU 计算用，不能用来扫描显示——`drmModeSetCrtc` 在 render node 上会失败。

## DrmDevice：RAII 包装 DRM fd

和第 1 篇 `V4L2Device` 的思路一样，DRM fd 也要用 RAII 包装。`DrmDevice` 类定义：

```cpp
class DrmDevice {
public:
    explicit DrmDevice(const std::string& device_path);
    ~DrmDevice();

    DrmDevice(const DrmDevice&) = delete;
    DrmDevice& operator=(const DrmDevice&) = delete;

    DrmProbeResult probe() const;
    const std::string& path() const noexcept;

private:
    int fd_{-1};
    std::string device_path_;
};
```

结构和 `V4L2Device` 几乎一样：构造打开、析构关闭、禁复制、`fd_` 默认 `-1`。区别在于 `probe()` 是**只读**的——它只调用 `drmGetVersion`、`drmGetCap`、`drmModeGetResources`、`drmModeGetConnector`、`drmModeGetEncoder` 这些查询接口，**不调用 `drmSetMaster`、`drmModeCreateDumb`、`drmModeAddFB`、`drmModeSetCrtc`**。

构造函数：

```cpp
DrmDevice::DrmDevice(const std::string& device_path)
    : device_path_(device_path)
{
    if (device_path_.empty()) {
        throw std::invalid_argument("DRM device path must not be empty");
    }

    fd_ = ::open(device_path_.c_str(), O_RDWR | O_CLOEXEC);
    if (fd_ < 0) {
        throw systemError("open", device_path_);
    }
}
```

`O_RDWR` 是为了后续 KMS 阶段保持一致——本篇不会真正写，但用同一个 fd 后续可以直接做 modeset，不用重新打开。`O_CLOEXEC` 防止 `fork+exec` 时 fd 泄漏。注意和 V4L2 不同，这里**不加 `O_NONBLOCK`**：DRM 的查询 ioctl 都是同步阻塞的，没有"没有数据可读"这种语义，不需要非阻塞。

## libdrm

libdrm 是 C 库，所有返回堆对象的接口都配一个对应的 `Free` 函数：

```text
drmGetVersion         -> drmFreeVersion
drmModeGetResources   -> drmModeFreeResources
drmModeGetConnector   -> drmModeFreeConnector
drmModeGetEncoder     -> drmModeFreeEncoder
```

如果手工管理，很容易写出"early return 漏 free"的内存泄漏。C++ 的 `std::unique_ptr` 配自定义 deleter 可以把这件事自动化。先定义四个 deleter：

```cpp
struct DrmVersionDeleter {
    void operator()(drmVersion* version) const noexcept
    {
        if (version != nullptr) {
            drmFreeVersion(version);
        }
    }
};

struct DrmResourcesDeleter {
    void operator()(drmModeRes* resources) const noexcept
    {
        if (resources != nullptr) {
            drmModeFreeResources(resources);
        }
    }
};

/* DrmConnectorDeleter、DrmEncoderDeleter 同理 */
```

每个 deleter 是一个 `struct`，重载 `operator()`，里面调对应的 `Free` 函数。`noexcept` 是必须的——`unique_ptr` 的析构路径不允许抛异常。然后 typedef 出四种"拥有型智能指针"：

```cpp
typedef std::unique_ptr<drmVersion, DrmVersionDeleter> DrmVersionOwner;
typedef std::unique_ptr<drmModeRes, DrmResourcesDeleter> DrmResourcesOwner;
typedef std::unique_ptr<drmModeConnector, DrmConnectorDeleter> DrmConnectorOwner;
typedef std::unique_ptr<drmModeEncoder, DrmEncoderDeleter> DrmEncoderOwner;
```

使用时和普通 `unique_ptr` 一样：

```cpp
DrmResourcesOwner resources(drmModeGetResources(fd_));
if (!resources) {
    throw systemError("drmModeGetResources", device_path_);
}
/* ... 用 resources->count_connectors 等 */
/* 出作用域时自动 drmModeFreeResources */
```

这是 C++ 给 C 库做 RAII 包装的标准模式——比手工 `free` 安全、比包一层类省事。`unique_ptr` 的模板第二参数是 deleter 类型，所以每种"拥有型指针"都得有自己的 deleter struct，不能直接用 `std::default_delete`。这种写法在新代码里很常见，比如 `std::unique_ptr<FILE, decltype(&fclose)>`、`std::unique_ptr<void, decltype(&dlclose)>` 等都是同一套路。

`probe()` 里所有 libdrm 对象都用这个模式管理。所有 early return、所有异常抛出路径，析构函数都会自动调用对应的 `Free`。和第 2 篇 `V4L2BufferQueue` 的析构 best-effort 清理一样，都是 RAII 的好处。

## probe()：自动选择 connector/encoder/CRTC

`probe()` 的核心逻辑是"在 resources 列表里找到第一条可用路由"：

```cpp
for (int index = 0; index < resources->count_connectors; ++index) {
    DrmConnectorOwner connector(
        drmModeGetConnector(fd_, resources->connectors[index]));
    if (!connector || connector->connection != DRM_MODE_CONNECTED ||
        connector->count_modes <= 0) {
        continue;
    }

    std::uint32_t encoder_id = 0U;
    std::uint32_t crtc_id = 0U;
    if (!selectEncoderAndCrtc(fd_, *resources, *connector,
                               &encoder_id, &crtc_id)) {
        continue;
    }

    const drmModeModeInfo* const mode = selectMode(*connector);
    /* 填 result 并返回 */
    return result;
}
```

跳过 `!connector`（获取失败）、`disconnected`（没插屏）、`count_modes <= 0`（没 mode）的 connector。第一个同时满足"已连接、有 mode、有可用 encoder/CRTC"的就选定。

`selectEncoderAndCrtc` 的选择顺序很关键，分两步：

**第一步：优先用 connector 当前 encoder。** 如果 `connector->encoder_id != 0`，说明内核或 compositor 已经为这个 connector 建立了路由（比如 Weston 已经在用它）。优先用这个 encoder，因为它肯定能驱动这个 connector。然后从 encoder 选 CRTC：先看 `encoder->crtc_id`（当前绑定的 CRTC），不行再枚举 `possible_crtcs` bitmask。

**第二步：connector 未启用时枚举 encoders[]。** 如果 `connector->encoder_id == 0`（典型场景：板子刚启动还没人用过这个屏），就在 `connector->encoders[]` 列表里逐个试，找第一个能配上 CRTC 的组合。

`selectCrtc` 里的 bitmask 解析有个新手坑：

```cpp
for (int index = 0; index < resources->count_crtcs; ++index) {
    if (index < 32 &&
        (encoder.possible_crtcs & (1U << static_cast<unsigned int>(index))) != 0U) {
        *crtc_id = resources.crtcs[index];
        return true;
    }
}
```

`possible_crtcs` 是一个 bitmask，bit N 对应 `resources->crtcs[N]`——**不是 CRTC object ID**。也就是说第 0 个 CRTC 的 object ID 可能是 115，但 `possible_crtcs` 的 bit 0 表示"能用 `crtcs[0]`"，不是"能用 ID=0 的 CRTC"或"能用 ID=115 的 CRTC"。这个区别搞错会选到完全不相关的 CRTC，`drmModeSetCrtc` 会返回 `EINVAL`。

## selectMode：preferred mode 优先

connector 的 `modes[]` 数组里每个 mode 都可能带 `DRM_MODE_TYPE_PREFERRED` 标志，表示驱动认为它是这个 connector 的默认最佳 mode。优先选它：

```cpp
const drmModeModeInfo* selectMode(const drmModeConnector& connector)
{
    for (int index = 0; index < connector.count_modes; ++index) {
        if ((connector.modes[index].type & DRM_MODE_TYPE_PREFERRED) != 0U) {
            return &connector.modes[index];
        }
    }
    return &connector.modes[0];
}
```

没有 preferred 就用第一个。RK3568 DSI-1 实测返回的 preferred mode 是 `1080x1920`（注意是竖屏，宽 1080 高 1920）。

## refresh rate 计算

libdrm 不直接给刷新率，要自己从 mode timing 算：

```cpp
double calculateRefreshRate(const drmModeModeInfo& mode)
{
    if (mode.htotal == 0U || mode.vtotal == 0U) {
        return 0.0;
    }

    double refresh_rate =
        static_cast<double>(mode.clock) * 1000.0 /
        (static_cast<double>(mode.htotal) * static_cast<double>(mode.vtotal));
    if ((mode.flags & DRM_MODE_FLAG_INTERLACE) != 0U) {
        refresh_rate *= 2.0;
    }
    if ((mode.flags & DRM_MODE_FLAG_DBLSCAN) != 0U) {
        refresh_rate /= 2.0;
    }
    if (mode.vscan > 1U) {
        refresh_rate /= static_cast<double>(mode.vscan);
    }
    return refresh_rate;
}
```

`mode.clock` 单位是 kHz（每秒像素时钟数 × 1000），`htotal × vtotal` 是一帧的总像素数（包括 blanking）。两者相除就是每秒能扫多少帧。`INTERLACE`/`DBLSCAN`/`vscan` 是历史遗留的电视卡时代 flags，对 DSI panel 一般都用不到，但完整计算才和 `modetest` 输出对得上。

RK3568 DSI-1 实测 `clock=121000` kHz、`htotal=1144`、`vtotal=1943`，算出来 `121000 × 1000 / (1144 × 1943) ≈ 54.44 Hz`。这个 54.44 不是常见的 60 Hz，是 panel 实际时序决定的，不能想当然地按 60 处理。
## DrmProbeResult：不持有 libdrm 指针

`probe()` 的返回类型 `DrmProbeResult` 是个纯 POD 结构，只保存稳定值，**不持有 libdrm 返回的指针**：

```cpp
struct DrmProbeResult {
    std::string driver_name;
    bool dumb_buffer_supported{false};
    std::string connector_name;
    std::uint32_t connector_id{0U};
    std::uint32_t encoder_id{0U};
    std::uint32_t crtc_id{0U};
    DrmModeInfo mode;
};
```

这是另一个新手坑：libdrm 返回的 `drmModeRes*`、`drmModeConnector*` 等指针在 `drmModeFree*` 之后就失效了。如果 `probe()` 返回的 `DrmProbeResult` 里保存的是这些指针，调用方一旦访问就会 use-after-free。所以 `probe()` 在返回前把所有需要的值（ID、mode 参数、driver name 字符串）**拷贝**到 `DrmProbeResult`，libdrm 对象在 `probe()` 末尾全部释放。调用方拿到的是"快照"，安全。

这种"接口返回值不持有底层资源指针"的设计在跨 C/C++ 边界很常见——C 库的对象生命周期由 C 库管，C++ 包装层只返回拷贝。

## connector 类型名映射

`drmModeConnector` 有 `connector_type` 和 `connector_type_id` 两个字段，前者是枚举（`DRM_MODE_CONNECTOR_DSI` 等），后者是同类型内的序号。把它们拼成 `DSI-1`、`HDMI-A-1` 这种可读名称要自己写：

```cpp
const char* connectorTypeName(std::uint32_t connector_type)
{
    switch (connector_type) {
        case DRM_MODE_CONNECTOR_DSI:  return "DSI";
        case DRM_MODE_CONNECTOR_HDMIA: return "HDMI-A";
        /* ... 其他类型 ... */
        default: return "Unknown";
    }
}

std::string connectorName(const drmModeConnector& connector)
{
    return std::string(connectorTypeName(connector.connector_type)) + "-" +
           std::to_string(connector.connector_type_id);
}
```

为什么不直接用 `drmModeGetConnectorTypeName()`？因为 ATK BSP 自带的旧版 libdrm 还没有这个函数，直接调用会引入新符号依赖，要求升级目标板动态库。手动映射内核 UAPI 常量既不增加依赖，也保证和 `modetest` 输出一致。这是嵌入式现场常见的"用旧版 SDK"的妥协。
## drm_test_main.cpp：命令行入口

`drm_test_main.cpp` 是 `drm_probe` 可执行文件的入口，结构很简单：解析参数（可选的设备路径，默认 `/dev/dri/card0`）、构造 `DrmDevice`、调用 `probe()`、打印结果。`--help` 和 `--version` 在任何设备访问之前处理，和 `camera_demo` 的设计一致。

输出长这样：

```text
DRM device: /dev/dri/card0
  Driver: rockchip
  Dumb buffer: supported
  Connector: DSI-1
  Connector ID: 163
  Status: connected
  Mode: 1080x1920
  Resolution: 1080x1920
  Refresh: 54.44 Hz
  Preferred: yes
  Encoder ID: 158
  CRTC ID: 115
```

`Connector ID: 163`、`CRTC ID: 115` 这些数字**每次启动都可能不同**，不能写死。本篇的意义就是把"获取这些数字"自动化——后续真正做 modeset 时，调用方先 `probe()` 拿到 ID，再用这些 ID 调 `drmModeSetCrtc`。

## CMakeLists：libdrm 检测与 drm_probe target

第 5 篇首次引入外部库依赖 libdrm。CMakeLists 加了两个 option 和对应检测逻辑：

```cmake
option(CAMERA_DEMO_BUILD_DRM_PROBE
       "Build the read-only DRM/KMS resource probe when libdrm is available" ON)
option(CAMERA_DEMO_REQUIRE_DRM_PROBE
       "Fail configuration when drm_probe dependencies are unavailable" OFF)
```

`BUILD_DRM_PROBE` 默认 ON，但找不到 libdrm 时静默跳过——这样开发机没有 libdrm 开发头文件时 `camera_demo` 还能编。`REQUIRE_DRM_PROBE` 默认 OFF，板端交叉构建时设为 ON，强制要求 libdrm 必须找到，避免误以为已经构建了 `drm_probe` 实际却跳过。

libdrm 检测有个新手容易踩的坑——头文件分两处：

```cmake
find_path(LIBDRM_XF86_INCLUDE_DIR NAMES xf86drm.h)
find_path(LIBDRM_DRM_INCLUDE_DIR NAMES drm.h PATH_SUFFIXES libdrm)
find_library(LIBDRM_LIBRARY NAMES drm)
```
## 板端复现

```bash
# 交叉编译并推到板子
./tools/cross_build_rk3568.sh
adb push build-rk3568/stage/bin/drm_probe /home/reynor/

# 板端运行（Weston 可以保持运行，本命令是只读的）
adb shell "/home/reynor/drm_probe /dev/dri/card0"
# 期望输出：
#   DRM device: /dev/dri/card0
#     Driver: rockchip
#     Dumb buffer: supported
#     Connector: DSI-1
#     Connector ID: 163
#     Status: connected
#     Mode: 1080x1920
#     Resolution: 1080x1920
#     Refresh: 54.44 Hz
#     Preferred: yes
#     Encoder ID: 158
#     CRTC ID: 115
```

## 当前阶段与下一篇

本篇结束时，`drm_probe` 能在板端打印出 connector ID、CRTC ID、mode 等后续 modeset 需要的全部数字。但程序本身**没有申请 master、没有创建 framebuffer、没有 modeset**。

下一篇要做的事是：申请 DRM master、创建一个 XRGB8888 dumb buffer、用 `drmModeAddFB` 把它包成 framebuffer、调 `drmModeSetCrtc` 把它显示到屏幕上、画一组 RGB 彩条验证画面正确。届时第一次涉及"修改显示状态"，必须先停 Weston、处理 master 冲突、设计 framebuffer 生命周期和正常退出时恢复 CRTC 的清理路径。






