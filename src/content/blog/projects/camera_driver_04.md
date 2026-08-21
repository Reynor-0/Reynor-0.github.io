---
title: 'Camera 驱动开发（四）：Media Graph 与异步绑定'
description: '在 rk3568 平台上为 IMX415 Sensor 编写驱动程序'
series: { id: 'camera-driver', order: 4 }
tags: ['Camera', 'Linux', 'V4L2', '图像处理']
pubDate: 'Jun 26 2026'
---

## 本篇开发目标

前面三篇已经完成设备树连接、IMX415 的 Probe/上电框架，以及 Sensor mode、时序和controls。现在各个驱动虽然可以分别 Probe，但它们仍然只是互不相干的 Linux 设备。

在本篇中，我们将学习如何将这些驱动整合到一个 Media Graph 中，并实现异步绑定，以创建一个完整的图像处理流水线。


```text
IMX415 source pad
  -> CSI2 D-PHY sink/source pad
  -> RKISP CSI2RX sink/source pad
  -> RKISP ISP sink/source pad
  -> rkisp_mainpath video node
```

开发完成后，内核应当能够通过 `/dev/media0` 描述完整的数据通路，并生成`/dev/v4l-subdev*` 与 `/dev/video*` 节点。

本篇只建立“谁连接谁、格式从哪里传递”的控制面，不开始 Sensor streaming，也不讲帧数据如何进入 VB2 Buffer。开流调用链放在下一篇。

## 开发前先明确三个对象

Media Controller 使用 entity、pad 和 link 描述拓扑：

| 对象 | 驱动开发中的含义 | 当前板端示例 |
| --- | --- | --- |
| entity | 一个能够产生、接收或处理媒体数据的模块 | IMX415、D-PHY、RKISP CSI、ISP、mainpath |
| pad | entity 的输入或输出端口 | Sensor pad 0 是 source；D-PHY pad 0 是 sink |
| link | 一个 source pad 到一个 sink pad 的连接 | IMX415 pad 0 → D-PHY pad 0 |

方向必须从数据流角度判断：

```text
source pad  -- media link -->  sink pad
```
`source` 不等于“设备树中写了 remote-endpoint 的一端”，`sink` 也不等于“驱动消费者”。它们只表示图像数据从哪个 pad 流出、从哪个 pad 流入。

## 为什么需要异步绑定

IMX415 是 I2C driver，D-PHY 和 RKISP 是 platform driver。三者的 Probe 顺序由设备注册、驱动加载和依赖关系共同决定，不能假设 Sensor 一定最先或最后完成 Probe。

如果 RKISP 在 Probe 中直接查找一个尚未注册的 Sensor，系统会产生脆弱的加载顺序依赖。V4L2 async notifier 的用途就是：

1. 消费者根据设备树 endpoint 登记“我在等待哪个远端 subdev”；
2. 提供者完成 `v4l2_async_register_subdev*()` 后进入异步匹配集合；
3. 两边的 firmware node 匹配时执行 `.bound()`；
4. notifier 中的所有 subdev 都绑定后执行 `.complete()`。

匹配依据是设备树 endpoint 对应的 firmware node，不是 `/dev/v4l-subdev3` 编号，也不是`sd->name` 字符串。

当前链路有两层 notifier：

```text
第一层：rockchip-csi2-dphy0 等待 IMX415
第二层：rkisp-vir0 等待 rockchip-csi2-dphy0
```
这样，无论三个 driver 的 Probe 顺序怎样变化，最终都能在对象齐备后建立同一张 Media Graph。

## 让每个模块先拥有正确的 entity 和 pad

### imx415: source pad
```c
static int imx415_init_media_entity(struct imx415 *imx415)
{
    /* Sensor 的唯一 pad 向下游输出 Bayer 像素。 */
    imx415->pad.flags = MEDIA_PAD_FL_SOURCE;
    /* 标记 entity 类型，供下游驱动判断这是 Camera Sensor。 */
    imx415->subdev.entity.function = MEDIA_ENT_F_CAM_SENSOR;
    /* 把一个 pad 挂到 subdev 内嵌的 media entity。 */
    return media_entity_pads_init(&imx415->subdev.entity,
                                  1,
                                  &imx415->pad);
}
```
该函数只创建 entity 和 pad，不创建到 D-PHY 的 link。Sensor 驱动不应该硬编码下游是谁。

### D-PHY：一个 sink pad 和一个 source pad

D-PHY 接收 Sensor 的 CSI-2 信号，并将恢复后的数据交给 CSI2RX，因此需要两个 pad：


```c
enum csi2_dphy_rx_pads {
    CSI2_DPHY_RX_PAD_SINK = 0,   /* 接收 Sensor 输出。 */
    CSI2_DPHY_RX_PAD_SOURCE,     /* 向 RKISP CSI2RX 输出。 */
    CSI2_DPHY_RX_PADS_NUM,
};

/**
 * @brief 初始化 D-PHY 的 pads 和 media entity 类型。
 * @param dphy D-PHY 驱动私有数据。
 * @return 成功返回 0，失败返回负 errno。
 */
static int csi2_dphy_init_entity(struct csi2_dphy *dphy)
{
    /* pad 0 必须连接一个上游像素源。 */
    dphy->pads[CSI2_DPHY_RX_PAD_SINK].flags = MEDIA_PAD_FL_SINK | MEDIA_PAD_FL_MUST_CONNECT;
    /* pad 1 是一个下游输出端口。 */
    dphy->pads[CSI2_DPHY_RX_PAD_SOURCE].flags = MEDIA_PAD_FL_SOURCE | MEDIA_PAD_FL_MUST_CONNECT;
    /* D-PHY 在 Media Graph 中属于视频接口桥。 */
    dphy->sd.entity.function = MEDIA_ENT_F_VIDEO_INTERFACE;
    return media_entity_pads_init(&dphy->sd.entity, CSI2_DPHY_RX_PADS_NUM, dphy->pads);
}
```

`MEDIA_PAD_FL_MUST_CONNECT` 表示该 pad 在有效 pipeline 中必须连接。它用于拓扑约束，不会自动创建 link。

### RKISP 内部模块
RKISP 驱动内部至少要注册以下对象：

```text
rkisp-csi-subdev：CSI-2 协议接收，包含一个 sink 和多个 source
rkisp-isp-subdev：ISP 处理，包含图像输入、参数输入、图像输出和统计输出
rkisp_mainpath：  V4L2 capture video node，只有一个 sink pad
```

这些对象由同一个 RKISP driver 管理，因此可以在 RKISP Probe 中同步注册。只有 D-PHY 是外部 subdev，需要通过 async notifier 等待。

## D-PHY 从设备树生成异步匹配项
当前设备树关系是：

```text
imx415_out <-> mipi_in_ucam1
```
D-PHY 解析输入端口 `port 0`，为它的远端 Sensor 建立 `v4l2_async_subdev` 描述项。同时保存lane 数和 CSI-2 bus flags，供后续配置 PHY 使用。

### 为匹配项附加 D-PHY 所需信息

```c
struct sensor_async_subdev {
    struct v4l2_async_subdev asd; /* V4L2 async 核心使用的匹配对象。 */
    struct v4l2_mbus_config mbus; /* CSI-2 bus 类型和 flags。 */
    int lanes;                    /* 设备树声明的数据 lane 数。 */
};
```

嵌入 `struct v4l2_async_subdev` 后，解析回调可以用 `container_of()` 找回 Rockchip 扩展数据。

### 解析一个 endpoint

这部分是rk3568的sdk实现：


```c
/**
 * @brief 解析 D-PHY 输入 endpoint 中的 CSI-2 参数。
 * @param dev D-PHY 设备，用于日志输出。
 * @param vep V4L2 已解析的 firmware endpoint。
 * @param asd 即将加入 notifier 的异步匹配对象。
 * @return 参数有效返回 0，否则返回负 errno。
 */
static int rockchip_csi2_dphy_fwnode_parse(
    struct device *dev,
    struct v4l2_fwnode_endpoint *vep,
    struct v4l2_async_subdev *asd)
{
    struct sensor_async_subdev *sensor_asd =
        container_of(asd, struct sensor_async_subdev, asd);
    struct v4l2_mbus_config *config = &sensor_asd->mbus;

    /* 当前硬件只把 port 0 作为 Sensor 输入端。 */
    if (vep->base.port != 0)
        return -EINVAL;

    /* 本驱动只接受 MIPI CSI-2 输入。 */
    if (vep->bus_type != V4L2_MBUS_CSI2)
        return -EINVAL;

    config->type = V4L2_MBUS_CSI2;
    config->flags = vep->bus.mipi_csi2.flags;
    sensor_asd->lanes = vep->bus.mipi_csi2.num_data_lanes;

    /* 将 lane 数编码进旧版内核使用的 mbus flags。 */
    switch (sensor_asd->lanes) {
    case 1:
        config->flags |= V4L2_MBUS_CSI2_1_LANE;
        break;
    case 2:
        config->flags |= V4L2_MBUS_CSI2_2_LANE;
        break;
    case 3:
        config->flags |= V4L2_MBUS_CSI2_3_LANE;
        break;
    case 4:
        config->flags |= V4L2_MBUS_CSI2_4_LANE;
        break;
    default:
        return -EINVAL;
    }

    return 0;
}
```

这里校验的是逻辑 endpoint 参数。寄存器、时钟和 PHY 硬件是否可用，属于 D-PHY 自身Probe 与开流配置的职责。

### 注册 D-PHY 子 notifier
```c
/**
 * @brief 创建 D-PHY entity，并登记它等待的上游 Sensor。
 * @param dphy D-PHY 驱动私有数据。
 * @return 成功返回 0，失败返回负 errno。
 */
static int rockchip_csi2dphy_media_init(struct csi2_dphy *dphy)
{
    int ret;

    ret = csi2_dphy_init_entity(dphy);
    if (ret)
        return ret;

    /* 只解析 port 0，并为每个远端 Sensor 分配扩展匹配对象。 */
    ret = v4l2_async_notifier_parse_fwnode_endpoints_by_port(
        dphy->dev,
        &dphy->notifier,
        sizeof(struct sensor_async_subdev),
        0,
        rockchip_csi2_dphy_fwnode_parse);
    if (ret)
        goto cleanup_entity;

    /* 没有输入 endpoint 时，D-PHY 无法组成 Camera pipeline。 */
    if (!dphy->notifier.num_subdevs) {
        ret = -ENODEV;
        goto cleanup_notifier;
    }

    /* 声明该 notifier 隶属于 D-PHY subdev。 */
    dphy->sd.subdev_notifier = &dphy->notifier;
    dphy->notifier.ops = &rockchip_csi2_dphy_async_ops;

    /* 登记 D-PHY 正在等待的上游 Sensor。 */
    ret = v4l2_async_subdev_notifier_register(&dphy->sd,
                                              &dphy->notifier);
    if (ret)
        goto cleanup_notifier;

    /* 最后把 D-PHY 本身放入 async subdev 匹配系统。 */
    ret = v4l2_async_register_subdev(&dphy->sd);
    if (ret)
        goto unregister_notifier;

    return 0;

unregister_notifier:
    v4l2_async_notifier_unregister(&dphy->notifier);
cleanup_notifier:
    v4l2_async_notifier_cleanup(&dphy->notifier);
cleanup_entity:
    media_entity_cleanup(&dphy->sd.entity);
    return ret;
}
```

上面是建议使用的完整回滚骨架。

## Sensor 与 D-PHY 匹配后创建第一条 link

当 IMX415 完成 async subdev 注册，V4L2 核心找到匹配的 firmware node 后，会调用 D-PHY notifier 的 `.bound()`。

```c
static const struct v4l2_async_notifier_operations
    rockchip_csi2_dphy_async_ops = {
        .bound = rockchip_csi2_dphy_notifier_bound,
        .unbind = rockchip_csi2_dphy_notifier_unbind,
    };
```

### `.bound()` 的实现任务


```c
/**
 * @brief 保存匹配到的 Sensor，并创建 Sensor 到 D-PHY 的 media link。
 * @param notifier D-PHY 所属的异步 notifier。
 * @param sd 已匹配成功的 Sensor subdev。
 * @param asd 与 Sensor endpoint 对应的异步匹配项。
 * @return 成功返回 0，失败返回负 errno。
 */
static int rockchip_csi2_dphy_notifier_bound(
    struct v4l2_async_notifier *notifier,
    struct v4l2_subdev *sd,
    struct v4l2_async_subdev *asd)
{
    struct csi2_dphy *dphy =
        container_of(notifier, struct csi2_dphy, notifier);
    struct sensor_async_subdev *sensor_asd =
        container_of(asd, struct sensor_async_subdev, asd);
    struct csi2_sensor *sensor;
    unsigned int source_pad;
    int ret;

    /* 防止超过私有数组能够保存的 Sensor 数量。 */
    if (dphy->num_sensors == ARRAY_SIZE(dphy->sensors))
        return -EBUSY;

    sensor = &dphy->sensors[dphy->num_sensors];
    sensor->sd = sd;
    sensor->lanes = sensor_asd->lanes;
    sensor->mbus = sensor_asd->mbus;

    /* 不假设 Sensor 的 source pad 永远是固定编号。 */
    for (source_pad = 0; source_pad < sd->entity.num_pads; ++source_pad) {
        if (sd->entity.pads[source_pad].flags & MEDIA_PAD_FL_SOURCE)
            break;
    }
    if (source_pad == sd->entity.num_pads)
        return -ENXIO;

    /* 第一个 Sensor 默认启用；其他候选输入保留为未启用 link。 */
    ret = media_create_pad_link(&sd->entity,
                                source_pad,
                                &dphy->sd.entity,
                                CSI2_DPHY_RX_PAD_SINK,
                                dphy->num_sensors == 0 ?
                                    MEDIA_LNK_FL_ENABLED : 0);
    if (ret)
        return ret;

    ++dphy->num_sensors;
    return 0;
}
```

### 为什么寻找 source pad，而不直接写 0

当前 IMX415 确实只有 pad 0，但 D-PHY 驱动是通用驱动，未来可能匹配包含多个 pad 的 bridge 或 Sensor。根据 `MEDIA_PAD_FL_SOURCE` 查找能够避免把实现偶然性写成接口约定。

### `.unbind()` 的最低职责


```c
/**
 * @brief 清除已经离开的 Sensor 引用。
 * @param notifier D-PHY 所属的异步 notifier。
 * @param sd 正在解除绑定的 Sensor subdev。
 * @param asd 对应的异步匹配项。
 */
static void rockchip_csi2_dphy_notifier_unbind(
    struct v4l2_async_notifier *notifier,
    struct v4l2_subdev *sd,
    struct v4l2_async_subdev *asd)
{
    struct csi2_dphy *dphy =
        container_of(notifier, struct csi2_dphy, notifier);
    struct csi2_sensor *sensor = sd_to_sensor(dphy, sd);

    /* 防止后续开流继续访问已经注销的 subdev。 */
    sensor->sd = NULL;
}
```

## RKISP 先建立自己的 Media 根对象

RKISP 是当前 `/dev/media0` 的 owner。它要先创建 `media_device`，再用 `v4l2_device` 把 V4L2 subdev/video node 关联到这张图：


```c
/**
 * @brief 注册 RKISP 的 Media Controller 和 V4L2 根对象。
 * @param isp_dev RKISP 逻辑设备。
 * @return 成功返回 0，失败返回负 errno。
 */
static int rkisp_register_media_root(struct rkisp_device *isp_dev)
{
    int ret;

    /* /dev/media0 展示的 model 和 driver_name 来自这里。 */
    strscpy(isp_dev->media_dev.model,
            "rkisp0",
            sizeof(isp_dev->media_dev.model));
    isp_dev->media_dev.dev = isp_dev->dev;
    isp_dev->media_dev.ops = &rkisp_media_ops;

    /* 让 V4L2 根设备加入同一个 media_device。 */
    isp_dev->v4l2_dev.mdev = &isp_dev->media_dev;

    ret = v4l2_device_register(isp_dev->dev, &isp_dev->v4l2_dev);
    if (ret)
        return ret;

    media_device_init(&isp_dev->media_dev);
    ret = media_device_register(&isp_dev->media_dev);
    if (ret) {
        v4l2_device_unregister(&isp_dev->v4l2_dev);
        return ret;
    }

    return 0;
}
```

实际驱动还会填写名称、controls、锁和硬件版本等字段。这里仅突出 Media Graph 相关顺序。

随后同步注册 RKISP 自有模块：

```text
rkisp_register_isp_subdev()
rkisp_register_csi_subdev()
rkisp_register_bridge_subdev()
rkisp_register_stream_vdevs()
rkisp_register_dmarx_vdev()
rkisp_register_stats_vdev()
rkisp_register_params_vdev()
rkisp_register_luma_vdev()
```

`rkisp_register_stream_vdevs()` 会调用 `video_register_device()` 生成 capture 节点，并为 video entity 初始化 sink pad。`/dev/video0` 的编号由 V4L2 core 分配，它不是 Sensor 创建的。

## RKISP 等待设备树中的 D-PHY

当前设备树第二段外部连接是：

```text
csidphy_out <-> isp0_in
```

RKISP 使用自己的 notifier 解析 endpoint：

```c
struct rkisp_async_subdev {
    struct v4l2_async_subdev asd; /* V4L2 async 匹配对象。 */
    struct v4l2_mbus_config mbus; /* 并口输入时保存 bus 配置。 */
};

/**
 * @brief 登记 RKISP 设备树中连接的外部 subdev。
 * @param isp_dev RKISP 逻辑设备。
 * @return 成功返回 0，失败返回负 errno。
 */
static int isp_subdev_notifier(struct rkisp_device *isp_dev)
{
    struct v4l2_async_notifier *notifier = &isp_dev->notifier;
    int ret;

    /* 解析 RKISP 的 endpoint，并创建等待列表。 */
    ret = v4l2_async_notifier_parse_fwnode_endpoints(
        isp_dev->dev,
        notifier,
        sizeof(struct rkisp_async_subdev),
        rkisp_fwnode_parse);
    if (ret)
        return ret;

    if (!notifier->num_subdevs)
        return -ENODEV;

    notifier->ops = &subdev_notifier_ops;

    /* 该 notifier 由 RKISP 的 v4l2_device 管理。 */
    return v4l2_async_notifier_register(&isp_dev->v4l2_dev,
                                        notifier);
}
```

MIPI 输入的 lane 信息已经由 D-PHY 保存，因此 `rkisp_fwnode_parse()` 对 MIPI endpoint 不必 重复提取；并口和 BT.656 输入才在这里保存 parallel bus flags。

## RKISP `.bound()` 只保存外部 subdev

RKISP 匹配到 `rockchip-csi2-dphy0` 时，当前 SDK 的 `.bound()` 并不立即创建所有 link，而是先保存对象：


```c
/**
 * @brief 把已匹配的外部 subdev 保存到 RKISP Sensor 输入表。
 * @param notifier RKISP 所属的异步 notifier。
 * @param subdev 已匹配的 D-PHY 或其他输入 subdev。
 * @param asd 对应的异步匹配项。
 * @return 成功返回 0，输入表已满返回 -EBUSY。
 */
static int subdev_notifier_bound(
    struct v4l2_async_notifier *notifier,
    struct v4l2_subdev *subdev,
    struct v4l2_async_subdev *asd)
{
    struct rkisp_device *isp_dev =
        container_of(notifier, struct rkisp_device, notifier);
    struct rkisp_async_subdev *rk_asd =
        container_of(asd, struct rkisp_async_subdev, asd);
    struct rkisp_sensor_info *slot;

    if (isp_dev->num_sensors == ARRAY_SIZE(isp_dev->sensors))
        return -EBUSY;

    slot = &isp_dev->sensors[isp_dev->num_sensors];
    slot->mbus = rk_asd->mbus;
    slot->sd = subdev;
    ++isp_dev->num_sensors;

    return 0;
}
```

把 link 创建推迟到 `.complete()` 的好处是：代码可以在所有候选输入都已绑定后统一决定默认启用哪一路，并一次完成整张图的后处理。

## 全部绑定完成后创建外部和内部 link

RKISP notifier 的所有等待项都匹配完成后，V4L2 core 调用 `.complete()`：

```c
static const struct v4l2_async_notifier_operations subdev_notifier_ops = {
    .bound = subdev_notifier_bound,       /* 保存每个已匹配输入。 */
    .complete = subdev_notifier_complete, /* 所有输入就绪后完成整图初始化。 */
};
```

### `rkisp_create_links()` 的决策

对于当前 D-PHY 输入，`entity.function` 不是 Camera Sensor，也不是 CIF composer。驱动再通过`g_mbus_config` 判断它是 CSI-2，最终创建两条 link：


```c
/**
 * @brief 为一个 CSI-2 D-PHY 输入创建 RKISP 侧 media links。
 * @param isp_dev RKISP 逻辑设备。
 * @param input 已绑定的外部输入 subdev。
 * @param source_pad 外部 subdev 的 source pad 编号。
 * @param flags link 的初始启用标志。
 * @return 成功返回 0，失败返回负 errno。
 */
static int rkisp_link_csi_input(struct rkisp_device *isp_dev,
                                struct v4l2_subdev *input,
                                unsigned int source_pad,
                                u32 flags)
{
    int ret;

    /* D-PHY 输出进入 RKISP 内部 CSI2RX。 */
    ret = media_create_pad_link(&input->entity,
                                source_pad,
                                &isp_dev->csi_dev.sd.entity,
                                CSI_SINK,
                                flags);
    if (ret)
        return ret;

    /* CSI2RX 的 VC0 输出进入 ISP 图像输入 pad。 */
    ret = media_create_pad_link(&isp_dev->csi_dev.sd.entity,
                                CSI_SRC_CH0,
                                &isp_dev->isp_sdev.sd.entity,
                                RKISP_ISP_PAD_SINK,
                                flags);
    if (ret)
        return ret;

    isp_dev->isp_inp = INP_CSI;
    isp_dev->csi_dev.sink[0].linked = !!flags;
    isp_dev->csi_dev.sink[0].index = BIT(0);
    return 0;
}
```

当前板端对应：

```text
rockchip-csi2-dphy0:pad1
  -> rkisp-csi-subdev:pad0
  -> rkisp-csi-subdev:pad1
  -> rkisp-isp-subdev:pad0
```

第一路输入使用 `MEDIA_LNK_FL_ENABLED`，其余候选输入默认不启用，避免两个数据源同时驱动同一个 ISP sink。

### ISP 到 mainpath 的 link 在哪里创建


mainpath video device 注册时，`rkisp_register_stream_vdevs()` 的下层逻辑创建：

```text
rkisp-isp-subdev:pad2 -> rkisp_mainpath:pad0
```

因此这条 link 不需要 async notifier 创建。async notifier 负责的是跨驱动、Probe 顺序不确定
的外部连接；RKISP 自己拥有的内部 entity 可以在各模块注册时同步连接。

## 在 `.complete()` 中完成整图初始化
当前 SDK 的完成顺序如下：

```c
/**
 * @brief 在所有外部 subdev 就绪后完成 RKISP Media Graph 初始化。
 * @param notifier RKISP 所属的异步 notifier。
 * @return 成功返回 0，失败返回负 errno。
 */
static int subdev_notifier_complete(
    struct v4l2_async_notifier *notifier)
{
    struct rkisp_device *isp_dev =
        container_of(notifier, struct rkisp_device, notifier);
    int ret;

    /* 防止其他线程在建图期间修改 link。 */
    mutex_lock(&isp_dev->media_dev.graph_mutex);

    /* 创建外部输入到 CSI/ISP 的 links。 */
    ret = rkisp_create_links(isp_dev);
    if (ret)
        goto unlock;

    /* 为带 HAS_DEVNODE 标志的 subdev 创建设备节点。 */
    ret = v4l2_device_register_subdev_nodes(&isp_dev->v4l2_dev);
    if (ret)
        goto unlock;

    /* 沿启用的 link 找到当前 active sensor，并读取格式。 */
    ret = rkisp_update_sensor_info(isp_dev);
    if (ret)
        goto unlock;

    /* 把 Sensor 格式传播到 CSI、ISP 和默认 capture 输出。 */
    ret = _set_pipeline_default_fmt(isp_dev);

unlock:
    mutex_unlock(&isp_dev->media_dev.graph_mutex);
    return ret;
}
```

这四步的依赖关系不能随意颠倒：没有 link 就无法找到 active sensor；没有 active sensor 的
格式，就无法设置 ISP 的默认输入、裁剪和 mainpath 输出。

## `_set_pipeline_default_fmt()` 在当前板上做了什么


该函数不是 Sensor 驱动的 `set_fmt()` 替代品，而是在完整 graph 建立后设置 RKISP 的默认
工作格式：

```text
1. 取得 active Sensor 当前格式：SGBRG10_1X10 / 3864x2192
2. 设置 RKISP ISP sink pad 的输入格式
3. 对齐并设置 ISP sink crop：(12,16) / 3840x2160
4. RAW Bayer 经过 ISP 后，将 source pad 默认设为 YUYV8_2X8
5. 把 mainpath/selfpath 默认 capture pixelformat 设为 NV12
```

简化代码如下：

```c
/**
 * @brief 根据 active Sensor 初始化 RKISP 各 pad 和 capture path 格式。
 * @param isp_dev RKISP 逻辑设备。
 * @return 当前实现固定返回 0。
 */
static int rkisp_set_pipeline_default_fmt(struct rkisp_device *isp_dev)
{
    struct v4l2_subdev_format fmt = isp_dev->active_sensor->fmt[0];
    struct v4l2_subdev_selection sel;

    /* 先把 Sensor RAW 格式送到 ISP sink。 */
    fmt.which = V4L2_SUBDEV_FORMAT_ACTIVE;
    fmt.pad = RKISP_ISP_PAD_SINK;
    v4l2_subdev_call(&isp_dev->isp_sdev.sd,
                     pad, set_fmt, NULL, &fmt);

    /* 设置 ISP 有效输入裁剪区域。 */
    rkisp_align_sensor_resolution(isp_dev, &sel.r, false);
    sel.which = V4L2_SUBDEV_FORMAT_ACTIVE;
    sel.target = V4L2_SEL_TGT_CROP;
    sel.pad = RKISP_ISP_PAD_SINK;
    v4l2_subdev_call(&isp_dev->isp_sdev.sd,
                     pad, set_selection, NULL, &sel);

    /* mainpath 的缺省用户态输出为 NV12。 */
    rkisp_set_stream_def_fmt(isp_dev,
                             RKISP_STREAM_MP,
                             sel.r.width,
                             sel.r.height,
                             V4L2_PIX_FMT_NV12);
    return 0;
}
```

这里的 3864x2192 是 Sensor 电气输出窗口，3840x2160 是 ISP 采用的有效图像区域。之后用户态对 `/dev/video0` 调用 `VIDIOC_S_FMT` 设置 1920x1080 NV12，mainpath 再执行缩放和输出格式配置。Media-bus format 与 video-node pixel format 不能混为一个对象。

## 当前板端真实对象是如何生成的


把整个注册过程按开发动作串起来：

```text
IMX415 Probe
  -> v4l2_i2c_subdev_init()
  -> media_entity_pads_init(source pad)
  -> v4l2_async_register_subdev_sensor_common()

D-PHY Probe
  -> v4l2_subdev_init()
  -> media_entity_pads_init(sink + source)
  -> parse port 0 endpoint
  -> v4l2_async_subdev_notifier_register() 等待 IMX415
  -> v4l2_async_register_subdev() 让 D-PHY 可被 RKISP 匹配

D-PHY notifier bound
  -> 保存 IMX415、lane 和 mbus 信息
  -> media_create_pad_link(IMX415 -> D-PHY)

RKISP Probe
  -> v4l2_device_register()
  -> media_device_register()
  -> 注册 CSI、ISP、video、stats、params 等内部 entity
  -> parse isp0_in endpoint
  -> v4l2_async_notifier_register() 等待 D-PHY

RKISP notifier bound
  -> 保存 D-PHY subdev

RKISP notifier complete
  -> rkisp_create_links(D-PHY -> CSI -> ISP)
  -> v4l2_device_register_subdev_nodes()
  -> rkisp_update_sensor_info()
  -> _set_pipeline_default_fmt()
```

## 板端拓扑逐条对照

```text
m00_b_imx415 4-001a-1:pad0 [Source]
  -> rockchip-csi2-dphy0:pad0 [Sink] [ENABLED]

rockchip-csi2-dphy0:pad1 [Source]
  -> rkisp-csi-subdev:pad0 [Sink] [ENABLED]

rkisp-csi-subdev:pad1 [Source]
  -> rkisp-isp-subdev:pad0 [Sink] [ENABLED]

rkisp-isp-subdev:pad2 [Source]
  -> rkisp_mainpath:pad0 [Sink] [ENABLED]
```

格式传播结果是：

```text
IMX415:     SGBRG10_1X10 / 3864x2192
D-PHY:     SGBRG10_1X10 / 3864x2192
CSI2RX:    SGBRG10_1X10 / 3864x2192
ISP sink:  SGBRG10_1X10 / 3864x2192，crop 为 3840x2160
ISP source:YUYV8_2X8 / 3840x2160
mainpath:  用户态可配置为 1920x1080 NV12
```

`media-ctl` 中的 `YUYV8_2X8` 是 ISP source pad 的 media-bus code；`v4l2-ctl` 中的 NV12 是capture video node 的内存像素格式。两者处在不同接口层。

`media-ctl -p` 还会显示 raw write/read、statistics 和 input-params 等分支。它们由 RKISP内部模块注册，分别服务 RAW 旁路、HDR 回灌和 3A 参数/统计，不属于 `/dev/video0` 的主显示数据通路；本篇先只追踪上面的 mainpath 主链。














