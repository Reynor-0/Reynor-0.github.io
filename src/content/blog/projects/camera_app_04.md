---
title: 'Camera 开发（四）：RK3568 硬件拓扑与显示链路设计'
description: '基于 RK3568 的 V4L2 Camera 应用开发记录，在写显示代码之前先把板级硬件和软件对象的边界理清楚'
series: { id: 'camera-development', order: 4 }
tags: ['Camera', 'Linux', 'V4L2', 'RGA', '图像处理']
pubDate: 'Jun 19 2026'
---

## 本篇要解决的问题

前三篇一直在用户态打转：打开 `/dev/video0`、协商 NV12 格式、MMAP 采集、导出 DMA-BUF fd。到这里采集链路本身已经能跑，但下一步要把图像显示到屏幕，就立刻撞上一个问题——**RK3568 不是 PC，没有"显卡 + 显示器"这种简单的组合**。从摄像头 sensor 到 LCD 像素，中间经过的硬件 IP、内核驱动对象、用户态库、字符设备节点，数量远超想象。

如果不先把这些边界理清楚就直接开始写 DRM 代码，会遇到一系列难以定位的问题：为什么 `/dev/video0` 输出的 NV12 不能直接给 DRM 显示？为什么屏幕是竖屏但摄像头是横屏？为什么 `drmModeSetCrtc` 报错？

## 问题总结：

**坑 1：摄像头是横屏，屏幕是竖屏。** RKISP `/dev/video0` 输出 1920×1080（横屏），DSI panel 是 1080×1920（竖屏）。如果直接把摄像头 buffer 交给 DRM，画面要么方向错、要么只能显示一半。必须有人做旋转——是 VOP plane 自己旋转？是 RGA 旋转？还是用户态 CPU 旋转？不先搞清楚每个硬件 IP 能做什么，就不知道该让谁做。

**坑 2：`/dev/video0` 输出的是 NV12，不是 RGB。** DRM primary plane 在 RK3568 上已验证支持 LINEAR XRGB8888，但不一定接受 NV12。如果不先探测 plane 支持的格式，直接 `drmModeAddFB2(NV12)` 可能失败，或者表面上成功但画面是错的。


| 层次 | 是什么 | 例子 |
| --- | --- | --- |
| 板上物理器件 | PCB 上能看到的芯片和连接器 | Sensor 模组、LCD 模组、DDR 芯片、RK3568 SoC 封装 |
| SoC 内部硬件 IP | RK3568 硅片内部的数字/模拟电路 | CSI D-PHY RX、ISP、RGA2、VOP2、DSI Host、DSI D-PHY TX |
| 物理线路与协议 | 板上铜走线 + 线上的信号规则 | MIPI CSI-2 over D-PHY、I2C、MIPI DSI over D-PHY |
| Linux 内核软件对象 | 内核创建的描述/配置硬件的对象 | platform device、media entity、`/dev/video0`、DRM plane/CRTC/connector |
| 用户态库和本项目 C++ 对象 | 用户态代码 | libdrm、librga、V4L2 ioctl、`V4L2Device`、`V4L2BufferQueue` |

把这五层分清之后，很多困惑就自动消解了。举几个典型例子：

**"ISP 是软件还是硬件？"** ISP 是 SoC 内部真实硬件 IP，地址节点 `fdff0000.rkisp`。`rkisp_v5`、`rkisp-isp-subdev`、`/dev/video0` 是控制它的软件层。

**"`/dev/video0` 是摄像头吗？"** 不是。`/dev/video0` 是 ISP mainpath 的字符设备，是内核向用户态暴露的 DMA buffer 队列入口。Sensor 是外部物理器件，两者之间隔着 CSI D-PHY、CSI 接收器、ISP 一整套硬件流水线。

**"media-ctl 图上的每个框都是一块硬件吗？"** 不是。Sensor entity 对应外部物理器件，CSI/ISP entities 映射到 SoC 硬件功能；pads、links、`/dev/v4l-subdev*` 本身都是内核软件模型。

**"DMA-BUF 是一条总线或协议吗？"** 不是。DMA-BUF 是 Linux 内核的共享内存机制和 fd 句柄。像素仍在 DDR 中，硬件经 DMA/NoC 访问它。第 3 篇讲过的 `EXPBUF` 导出的 fd，本质就是"让另一个内核子系统引用这块 DDR 内存"的句柄，不是新的物理通路。

更详细的，后面会有camera的驱动开发介绍，更有助于读者完成整个从 sensor 到显示的链路理解。目前只是做一个简要介绍。

## 一帧图像从光到像素的完整路径


```text
光线
  │
  ▼
Sensor（IMX415/IMX335，外部物理器件）
  │ 输出 Bayer RAW10
  │ MIPI CSI-2 over D-PHY（板上差分走线）
  ▼
CSI D-PHY RX + CSI 接收器（SoC 内部硬件）
  │ 解包 CSI-2 数据包
  ▼
ISP（SoC 内部硬件，fdff0000.rkisp）
  │ demosaic / 3A / 颜色校正 / 降噪 / Gamma
  │ DMA 写入 DDR
  ▼
DDR 中的 V4L2 NV12 capture buffer（4 个，1920×1080）
  │ RGA 通过 DMA 读取
  ▼
RGA2（SoC 内部硬件，fdeb0000.rk_rga）
  │ 270° 旋转 + NV12 → XRGB8888
  │ DMA 写入另一块 DDR 内存
  ▼
DDR 中的 DRM display buffer（1080×1920 XRGB8888）
  │ VOP 通过 DMA 读取
  ▼
VOP2（SoC 内部硬件，fe040000.vop）
  │ 扫描 framebuffer / 生成显示时序
  ▼
DSI Host + DSI D-PHY TX（SoC 内部硬件）
  │ 封 DSI 包 / 电气串行化
  │ MIPI DSI over D-PHY（板上差分走线）
  ▼
LCD 模组（外部物理器件）
  │ DSI RX + TCON + 液晶像素
  ▼
屏幕显示
```

## 当前阶段与下一篇

本篇结束时，程序的功能和第 3 篇完全一样——能采集、能导出 DMA-BUF fd——但我们对"下一步该把 fd 交给谁、走什么路径到屏幕"有了清晰的地图。RGA 旋转是必须的，首版显示格式选 XRGB8888，目标链路是 `V4L2 → DMA-BUF → RGA → DRM framebuffer → VOP → DSI panel`。

下一篇会开始写 DRM 端代码：打开 `/dev/dri/card0`、枚举 connector/CRTC/plane、用 dumb buffer 做第一次 legacy modeset、显示一组 RGB 彩条。还不会接入真实摄像头——先把"DRM 能不能独立工作"验证清楚，再谈和 RGA、V4L2 的拼接。





