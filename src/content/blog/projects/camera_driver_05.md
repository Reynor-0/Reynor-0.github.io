---
title: 'Camera 驱动开发（五）：从 VIDIOC_STREAMON 到 IMX415 真正出流'
description: '在 rk3568 平台上为 IMX415 Sensor 编写驱动程序'
series: { id: 'camera-driver', order: 5 }
tags: ['Camera', 'Linux', 'V4L2', '图像处理']
pubDate: 'Jun 26 2026'
---
第四篇已经建立下面这条启用的 Media Graph：

```text
rkisp_mainpath
  <- rkisp-isp-subdev
  <- rkisp-csi-subdev
  <- rockchip-csi2-dphy0
  <- m00_b_imx415 4-001a-1
```

这张图只说明模块之间可以连接，并不代表 Sensor 已经输出像素。真正开始出流，需要用户态对 `/dev/video0` 调用 `VIDIOC_STREAMON`，然后由 VB2、RKISP、CSI2 D-PHY 和 IMX415 驱动依次启动硬件。

本篇要完成以下内容：

1. 为 RKISP video node 接入 `VIDIOC_STREAMON` 和 VB2 callbacks；
2. 在开流前准备用户 Buffer、MI DMA、resizer 和 crop；
3. 沿 enabled Media Graph 收集上游 subdev；
4. 按 `ISP → CSI2RX → D-PHY → Sensor` 的顺序启动；
5. 在 IMX415 中写 global/mode 寄存器、恢复 controls，并退出 standby；
6. 任意一步失败时按相反方向回滚；
7. 在 `STREAMOFF` 时安全停止像素源并归还 Buffer。

## `/dev/video0` 如何控制 IMX415

### fd 只负责找到 `/dev/video0` 对应的 `video_device`

RKISP 调用 `video_register_device()` 注册 mainpath 后，V4L2 core 为它分配 minor，并建立：


```text
/dev/video0
  -> V4L2 字符设备 minor
  -> video_devices[minor]
  -> struct video_device
  -> struct rkisp_stream
  -> struct rkisp_device
```

进程打开节点后获得的 fd 只是一个文件表索引。`ioctl(fd, ...)` 进入内核后，VFS 根据 fd 找到`struct file`；V4L2 core 再根据 inode minor 找回 `struct video_device`：


```c
/**
 * @brief 根据 video 字符设备 minor 找回驱动注册的 video_device。
 * @param file 当前系统调用对应的内核文件对象。
 * @return 当前 minor 对应的 video_device，节点已注销时可能为空。
 */
struct video_device *video_devdata(struct file *file)
{
    return video_devices[iminor(file_inode(file))];
}
```

所以 fd 没有被传给 IMX415，IMX415 也不需要保存 `/dev/video0` 的 fd。fd 的使命在 RKISP video node 这一层已经完成：它让内核知道这次 ioctl 应该交给哪个 `video_device`。

### `/dev/video0` 的 ioctl 先进入 RKISP

V4L2 core 的字符设备 file operations 收到 ioctl 后，会调用 RKISP 在 `video_device` 中登记的`.unlocked_ioctl = video_ioctl2`，再根据命令选择 `vdev->ioctl_ops`：

```text
ioctl(fd, VIDIOC_STREAMON, &type)
  -> VFS 根据 fd 找到 struct file
  -> V4L2 core 根据 minor 找到 rkisp_mainpath video_device
  -> V4L2 字符设备公共入口 v4l2_ioctl()
  -> rkisp_fops.unlocked_ioctl = video_ioctl2()
  -> __video_do_ioctl()
  -> v4l_streamon()
  -> video_device->ioctl_ops->vidioc_streamon()
```

截至这里，调用对象始终是 RKISP mainpath，还没有进入 IMX415。

这里存在两层 file operations：V4L2 core 的公共 `v4l2_fops` 负责所有 `/dev/video*` 字符设备；找到具体 `video_device` 后，再调用 RKISP 填入 `vdev->fops` 的操作。这样 V4L2 core可以统一管理 minor、引用计数和设备注销，具体驱动只实现自己的打开、ioctl、poll 和 mmap。

### Media Graph 不会自动转发 ioctl

第四篇创建的 Media Graph 只保存“谁连接谁”：

```text
mainpath <- ISP <- CSI2RX <- D-PHY <- IMX415
```

它不会看到 STREAMON 后自动把 ioctl 广播给整条链路。真正的控制者是 RKISP driver：

1. RKISP 从 mainpath 沿 enabled links 找到所有上游 subdev；
2. 把它们的 `struct v4l2_subdev *` 保存进 `pipeline->subdevs[]`；
3. 先配置 RKISP 自己的 MI、ISP 和 CSI2RX；
4. 显式调用 D-PHY 和 IMX415 的 `.s_stream(1)`。

因此 RKISP 在这里是 pipeline master，IMX415 是 pipeline 中的上游 subdev。这个控制关系由内核对象指针和 callback 完成，不是通过另一个 fd，也不是 RKISP 再发一次 ioctl。

### `v4l2_subdev_call()` 如何真正进入 `imx415_s_stream()`


IMX415 Probe 时把函数表挂到自己的 `v4l2_subdev`：

```c
static const struct v4l2_subdev_video_ops imx415_video_ops = {
    .s_stream = imx415_s_stream, /* RKISP 开关整条 pipeline 时调用。 */
};

static const struct v4l2_subdev_ops imx415_subdev_ops = {
    .video = &imx415_video_ops,
};

/* 将 I2C client、subdev 和上面的 operations 关联起来。 */
v4l2_i2c_subdev_init(&imx415->subdev,
                      client,
                      &imx415_subdev_ops);
```

RKISP 收集到 IMX415 的 `struct v4l2_subdev *sensor_sd` 后执行：

```c
ret = v4l2_subdev_call(sensor_sd, video, s_stream, 1);
```

该宏的逻辑可以理解为：

```c
ret = sensor_sd->ops->video->s_stream(sensor_sd, 1);
```

于是函数指针最终落到：

```text
imx415_subdev_ops.video
  -> imx415_video_ops.s_stream
  -> imx415_s_stream()
  -> __imx415_start_stream()
  -> I2C 写 IMX415_REG_CTRL_MODE = 0
```

这就是 `/dev/video0` 的 ioctl 控制 IMX415 出图的完整机制。不是“fd 跨驱动传递”，而是：

```text
fd 选择 RKISP video_device
  -> RKISP 的 STREAMON callback 被调用
  -> RKISP 根据 Media Graph 找到 IMX415 subdev 指针
  -> RKISP 调用 IMX415 注册的 s_stream 函数指针
```

## VB2

VB2 全称是 Videobuf2，是 Linux Media 子系统的通用视频 Buffer queue 框架。它位于 V4L2
ioctl 层与具体 DMA 硬件驱动之间：

```text
V4L2 ioctl 层
  -> VB2 通用 Buffer 状态机
     -> RKISP vb2_ops
        -> RKISP MI DMA 硬件
```

VB2 不是 ISP，不处理 Bayer/NV12，也不会控制 IMX415 寄存器。它解决的是所有视频 DMA
驱动都会遇到的公共问题：

- REQBUFS 时分配和释放一组 Buffer；
- QUERYBUF/mmap 时建立用户映射；
- QBUF/DQBUF 时管理 Buffer 所有权；
- poll 时等待已经完成的 Buffer；
- STREAMON/OFF 时维护 queue 状态；
- 驱动启动失败时检查 Buffer 是否被正确归还；
- 对接 MMAP、USERPTR、DMA-BUF 等不同内存模型。

如果没有 VB2，RKISP 必须自己实现这些 ioctl、状态机、等待队列和异常清理，代码会大量重复。

### VB2 的四组关键对象


| 对象 | 谁提供 | 作用 |
| --- | --- | --- |
| `struct vb2_queue` | RKISP 初始化，VB2 core 管理 | 表示 mainpath 的一条 Buffer queue |
| `struct vb2_buffer` | VB2 core | 表示一个内核 Buffer 及其 plane 和状态 |
| `struct vb2_ops` | RKISP driver | VB2 回调 RKISP 的硬件相关操作 |
| `struct vb2_mem_ops` | dma-sg/dma-contig backend | 分配、映射并取得 DMA 地址 |

mainpath 只有一个 `vb2_queue`，该 queue 可以管理四个或更多 `vb2_buffer`。不要把“VB2”理解
成某一个 Buffer，也不要把四个 Buffer 理解成四条 VB2 queue：

```text
rkisp_mainpath video_device
  -> 1 个 vb2_queue
     -> vb2_buffer[0]
     -> vb2_buffer[1]
     -> vb2_buffer[2]
     -> vb2_buffer[3]
```

当前 RK3568 RKISP 使用 DMA scatter-gather memory backend。VB2 memory operations 负责把这些 Buffer 映射为设备可访问的 DMA/IOMMU 地址；RKISP `.buf_queue()` 再把地址交给 MI 硬件。

最容易混淆的是两组 operations：

```text
v4l2_ioctl_ops：决定某个 V4L2 ioctl 由谁处理
vb2_ops：       决定 VB2 何时回调具体硬件驱动
```

当前 STREAMON 在两层的连接方式是：

```c
rkisp_v4l2_ioctl_ops.vidioc_streamon = vb2_ioctl_streamon;
rkisp_vb2_ops.start_streaming = rkisp_start_streaming;
```

第一行把 RKISP 的 STREAMON ioctl 交给 VB2 通用层；第二行告诉 VB2，通用检查完成后应调用哪个 RKISP 硬件启动函数。

### 一个 Buffer 的基本状态

简化后的状态变化是：

```text
DEQUEUED
  -> QBUF
QUEUED
  -> 交给 RKISP .buf_queue()
ACTIVE
  -> MI DMA 完成，RKISP 调用 vb2_buffer_done()
DONE / ERROR
  -> DQBUF
DEQUEUED
```

VB2 管理状态和等待唤醒；RKISP 决定 DMA 地址如何写入 MI 寄存器，以及在帧结束中断中何时调用 `vb2_buffer_done()`。

### VB2 与开流控制的边界

VB2 只知道“现在可以让驱动开始 streaming”，并不知道 RKISP 上游连接了 IMX415 还是其他 Sensor。`vb2_start_streaming()` 最后调用 `rkisp_start_streaming()`，从这一点开始，沿 Media Graph 启动 ISP、D-PHY 和 Sensor 才是 RKISP driver 的职责。

## 把 STREAMON 接到 VB2

RKISP mainpath 的 `video_device` 需要同时安装 `v4l2_ioctl_ops` 和 `vb2_queue`。

### V4L2 ioctl 分发表

注册 mainpath 时，RKISP 要把 video node、VB2 queue 和自己的 stream 私有数据关联起来：

```c
/**
 * @brief 关联 mainpath video_device、VB2 queue 和 RKISP stream。
 * @param stream 当前要注册的 RKISP capture stream。
 */
static void rkisp_connect_video_and_queque(struct rkisp_stream *stream)
{
    struct video_device *vdev = &stream->vnode.dev;
    struct vb2_queue *queue = &stream->vnode.bu_queue;
    /* video_drvdata(file) 后续可从 video_device 找回 rkisp_stream */
    video_set_drvdata(vdev, stream);
    /* VB2 ioctl 根据 vdev->queue 找到这一条 capture queue。 */
    vdev->queue = queue;
    /* RKISP 的 vb2_ops 根据 queue->drv_priv 找回 rkisp_stream。 */
    queue->drv_priv = stream;
}
```

```c
static const struct v4l2_ioctl_ops rkisp_v4l2_ioctl_ops = {
    .vidioc_reqbufs = vb2_ioctl_reqbufs,    /* 申请或释放 VB2 Buffer。 */
    .vidioc_querybuf = vb2_ioctl_querybuf,     /* 查询 Buffer mmap 信息。 */
    .vidioc_qbuf = vb2_ioctl_qbuf,             /* 把空 Buffer 交给驱动。 */
    .vidioc_dqbuf = vb2_ioctl_dqbuf,           /* 取回已经写完的 Buffer。 */
    .vidioc_streamon = vb2_ioctl_streamon,     /* 进入 VB2 开流流程。 */
    .vidioc_streamoff = vb2_ioctl_streamoff,   /* 停止并取消 Buffer queue。 */
};
```

`video_ioctl2()` 收到 `VIDIOC_STREAMON` 后，V4L2 core 最终调用：

```text
v4l_streamon()
  -> vdev->ioctl_ops->vidioc_streamon()
  -> vb2_ioctl_streamon()
```

video core 负责 ioctl 参数拷贝、命令检查和锁；VB2 负责 Buffer queue 状态；RKISP 只需要实现与本硬件相关的 `vb2_ops`。

`vb2_ioctl_streamon()` 本身很短，它通过 `video_device` 取出刚才关联的 queue：

```c
/**
 * @brief 将 video node 的 STREAMON 请求交给对应 VB2 queue。
 * @param file 当前 video node 的内核文件对象。
 * @param priv V4L2 file handle；本函数不直接使用。
 * @param type 调用者传入的 V4L2 Buffer 类型。
 * @return 成功返回 0，失败返回负 errno。
 */
int vb2_ioctl_streamon(struct file *file,
                       void *priv,
                       enum v4l2_buf_type type)
{
    struct video_device *vdev = video_devdata(file);

    /* 防止另一个 file handle 操作不属于自己的 queue。 */
    if (vb2_queue_is_busy(vdev, file))
        return -EBUSY;

    return vb2_streamon(vdev->queue, type);
}
```

至此已经完成 `fd -> video_device -> vb2_queue`。VB2 通用检查结束后，再通过`queue->ops->start_streaming` 进入 RKISP。

### VB2 queue callbacks


```c
static struct vb2_ops rkisp_vb2_ops = {
    .queue_setup = rkisp_queue_setup,          /* 给出 plane 数和每个 plane 大小。 */
    .buf_queue = rkisp_buf_queue,              /* 保存可供 MI DMA 使用的 Buffer。 */
    .start_streaming = rkisp_start_streaming,  /* 启动 RKISP 和所有上游 subdev。 */
    .stop_streaming = rkisp_stop_streaming,    /* 停止 pipeline 并归还 Buffer。 */
    .wait_prepare = vb2_ops_wait_prepare,      /* 阻塞等待前释放 queue mutex。 */
    .wait_finish = vb2_ops_wait_finish,        /* 等待结束后重新取得 queue mutex。 */
};
```


```c
/**
 * @brief 初始化一个 RKISP capture stream 的 VB2 queue。
 * @param queue 要初始化的 VB2 queue。
 * @param stream 对应 mainpath、selfpath 或 raw path 的 stream。
 * @param type V4L2 Buffer 类型。
 * @return 成功返回 0，失败返回负 errno。
 */
static int rkisp_init_vb2_queue(struct vb2_queue *queue,
                                struct rkisp_stream *stream,
                                enum v4l2_buf_type type)
{
    queue->type = type;
    queue->io_modes = VB2_MMAP | VB2_USERPTR | VB2_DMABUF;
    queue->drv_priv = stream;
    queue->ops = &rkisp_vb2_ops;
    queue->mem_ops = stream->ispdev->hw_dev->mem_ops;
    queue->buf_struct_size = sizeof(struct rkisp_buffer);

    /* 当前 vendor 驱动允许 0 个已排队 Buffer 时启动，并使用 dummy Buffer 兜底。 */
    queue->min_buffers_needed = 0;

    queue->timestamp_flags = V4L2_BUF_FLAG_TIMESTAMP_MONOTONIC;
    queue->lock = &stream->apilock;
    queue->dev = stream->ispdev->hw_dev->dev;

    return vb2_queue_init(queue);
}
```

## 理解 VB2 在调用驱动前做了什么

`vb2_ioctl_streamon()` 不直接启动 Sensor，它先进入 VB2 core：

```text
vb2_ioctl_streamon()
  -> vb2_streamon()
  -> vb2_core_streamon()
  -> vb2_start_streaming()
  -> rkisp_vb2_ops.start_streaming()
```

`vb2_core_streamon()` 首先检查：

- 请求的 `type` 是否等于 `queue->type`；
- queue 是否已经 streaming；
- 是否已经通过 REQBUFS 分配 Buffer；
- Buffer 数是否达到 `min_buffers_needed`。

随后 `vb2_start_streaming()` 将所有已 QBUF 的对象逐个交给驱动：

```c
/**
 * @brief 把已排队 Buffer 交给驱动，并调用硬件 start_streaming callback。
 * @param queue 当前 VB2 queue。
 * @return 成功返回 0，失败返回负 errno。
 */
static int vb2_start_streaming(struct vb2_queue *queue)
{
    struct vb2_buffer *vb;
    int ret;

    /* 先让驱动取得所有 QBUF Buffer 的 DMA 地址。 */
    list_for_each_entry(vb, &queue->queued_list, queued_entry)
        __enqueue_in_driver(vb);

    queue->start_streaming_called = 1;

    /* count 是当前已经由驱动持有的 Buffer 数量。 */
    ret = call_qop(queue,
                   start_streaming,
                   queue,
                   atomic_read(&queue->owned_by_drv_count));
    if (!ret)
        return 0;

    queue->start_streaming_called = 0;

    /* 驱动失败时必须把所有 ACTIVE Buffer 退回 VB2。 */
    return ret;
}
```

`__enqueue_in_driver()` 最终调用 RKISP 的 `.buf_queue()`。这一步只把 Buffer 加入驱动内部
队列，不会等待一帧完成。

### RKISP 如何保存一个待写 Buffer

```c
/**
 * @brief 提取 VB2 Buffer 的 DMA 地址，并加入 RKISP stream 队列。
 * @param vb 已由 VB2 转移给驱动的 Buffer。
 */
static void rkisp_buf_queue(struct vb2_buffer *vb)
{
    struct vb2_v4l2_buffer *v4l2_buf = to_vb2_v4l2_buffer(vb);
    struct rkisp_buffer *isp_buf = to_rkisp_buffer(v4l2_buf);
    struct rkisp_stream *stream = vb->vb2_queue->drv_priv;
    struct sg_table *sgt;
    unsigned long flags;

    /* RK3568 的 VB2 SG backend 从 scatter-gather table 取得 DMA/IOMMU 地址。 */
    sgt = vb2_dma_sg_plane_desc(vb, 0);
    isp_buf->buff_addr[0] = sg_dma_address(sgt->sgl);

    /* 单 memory plane NV12 的 UV 地址位于同一存储中的 Y 平面之后。 */
    isp_buf->buff_addr[1] = isp_buf->buff_addr[0] +
        stream->out_fmt.plane_fmt[0].bytesperline *
        stream->out_fmt.height;

    spin_lock_irqsave(&stream->vbq_lock, flags);
    list_add_tail(&isp_buf->queue, &stream->buf_queue);
    spin_unlock_irqrestore(&stream->vbq_lock, flags);
}
```

此时四个 Buffer 的状态是：

```text
调用进程：暂时不拥有该 Buffer
VB2：ACTIVE / owned_by_driver
RKISP：位于 stream->buf_queue，等待成为 curr_buf 或 next_buf
```

Buffer 如何在帧结束中断中完成，放到第七篇详细分析。本篇只需要保证开流前 DMA 目标可用。

## 实现 RKISP `start_streaming()` 总控

### 检查 graph 和 stream 状态

```c
/**
 * @brief 启动一个 RKISP capture stream。
 * @param queue 触发 STREAMON 的 VB2 queue。
 * @param count 当前已经交给驱动的 Buffer 数量。
 * @return 成功返回 0，失败返回负 errno并归还全部 Buffer。
 */
static int rkisp_start_streaming(struct vb2_queue *queue, unsigned int count)
{
    struct rkisp_stream *stream = queue->drv_priv;
    struct rkisp_device *isp_dev = stream->ispdev;
    struct rkisp_vdev_node *node = &stream->vnode;
    int ret;

    mutex_lock(&isp_dev->hw_dev->dev_lock);

    if (WARN_ON(stream->streaming)) {
        ret = -EBUSY;
        goto unlock;
    }

    atomic_inc(&isp_dev->cap_dev.refcnt);

    /* 没有有效输入或 mainpath link 未启用时不得启动硬件。 */
    if (!isp_dev->isp_inp || !stream->linked) {
        ret = -ENOLINK;
        goto return_buffers;
    }

    /* 后续步骤在下面逐项补入。 */
}
```

`count` 当前主要由 VB2 传入，vendor 实现没有直接使用它。开发新驱动时仍应保留参数，因为VB2 callback 原型要求它，并可用于检查启动所需的最少 Buffer 数。

### 首路开流时重新确认 active Sensor

```c
    if(atomic_read(&isp_dev->cap_dev.refcnt) == 1 && (isp_dev->isp_inp & (INP_CSI | INP_DVP))) {
        /* link 可能在打开节点后发生变化，因此开流前重新沿 graph 查询。 */
        ret = rkisp_update_sensor_info(isp_dev);
        if (ret)
            goto return_buffers;
    }
```

这里取得的 `active_sensor` 后续用于：

- 读取 Sensor media-bus format；
- 查询 `V4L2_CID_PIXEL_RATE`；
- 识别线性/HDR 输入模式；
- 构造 pipeline 上游 subdev 列表。

### 创建 dummy Buffer


```c
    /* 用户 Buffer 暂时不足时，给硬件一个合法的丢帧目标地址。 */
    ret = rkisp_create_dummy_buf(stream);
    if (ret)
        goto return_buffers;
```

dummy Buffer 的目的不是提高正常画质，而是防止真实 Buffer 供应不及时或 queue 暂时为空时，MI DMA
写到无效地址。写入 dummy Buffer 的帧不会进入正常的 DQBUF 完成队列。

### 打开 pipeline 并计算 ISP 时钟


```c
    ret = isp_dev->pipe.open(&isp_dev->pipe,
                             &node->vdev.entity,
                             true);
    if (ret)
        goto destroy_dummy;
```

`prepare=true` 会让 `rkisp_pipeline_open()` 做两件事：

1. 沿 enabled links 收集从 mainpath 到 Sensor 的所有上游 subdev；
2. 根据 Sensor pixel rate、输入 bit width 和安全余量选择 ISP clock。

### 先配置 mainpath/MI 硬件

```c
    /* 配置 resizer、crop、MI 地址和 DMA 写通路。 */
    ret = rkisp_stream_start(stream);
    if (ret)
        goto close_pipeline;
```

`rkisp_stream_start()` 内部顺序为：

```text
rkisp_stream_config_rsz()
  -> rkisp_stream_config_dcrop()
  -> rkisp_start()
       -> set_data_path()
       -> config_mi()
       -> enable_mi()
       -> stream->streaming = true
```

这一步发生在 Sensor 出流前，保证第一批像素到达 ISP 时，mainpath 和 DMA 写目标已经准备好。

### 最后启动 subdev pipeline

```c
    if (stream->id == RKISP_STREAM_MP ||
        stream->id == RKISP_STREAM_SP) {
        ret = isp_dev->pipe.set_stream(&isp_dev->pipe, true);
        if (ret)
            goto stop_stream;

        /* 标记 Media Controller pipeline 已被该 video node 占用。 */
        ret = media_pipeline_start(&node->vdev.entity,
                                   &isp_dev->pipe.pipe);
        if (ret)
            goto stream_off;
    }

    mutex_unlock(&isp_dev->hw_dev->dev_lock);
    return 0;
```

## 沿 Media Graph 收集开流对象


`__isp_pipeline_prepare()` 从 mainpath entity 开始，每次寻找当前 entity 的 enabled remote
source pad，然后向上游移动：

```c
/**
 * @brief 沿启用的 sink link 收集当前 capture pipeline 的上游 subdev。
 * @param pipeline RKISP pipeline 状态。
 * @param entity 起点，当前为 mainpath video entity。
 * @return 成功返回 0，无法找到上游 subdev 返回负 errno。
 */
static int rkisp_pipeline_prepare(struct rkisp_pipeline *pipeline,
                                  struct media_entity *entity)
{
    struct rkisp_device *isp_dev =
        container_of(pipeline, struct rkisp_device, pipe);

    pipeline->num_subdevs = 0;

    while (true) {
        struct media_pad *remote = find_enabled_remote_source(entity);
        struct v4l2_subdev *subdev;

        if (!remote)
            break;

        subdev = media_entity_to_v4l2_subdev(remote->entity);

        /* ISP subdev 由 pipeline_set_stream() 单独最先启动。 */
        if (subdev != &isp_dev->isp_sdev.sd)
            pipeline->subdevs[pipeline->num_subdevs++] = subdev;

        entity = &subdev->entity;

        /* 单 pad Camera Sensor 已经是链路终点。 */
        if (entity->num_pads == 1)
            break;
    }

    return pipeline->num_subdevs ? 0 : -EINVAL;
}
```

`find_enabled_remote_source()` 是为了说明算法而使用的概念名称；当前 SDK 实际通过遍历 sink
pad 并调用 `rkisp_media_entity_remote_pad()` 完成。

当前板端得到的数组顺序是：

```text
pipeline->subdevs[0] = rkisp-csi-subdev
pipeline->subdevs[1] = rockchip-csi2-dphy0
pipeline->subdevs[2] = m00_b_imx415 4-001a-1
```

这正好是从下游接收端到上游数据源的顺序。

## 按正确方向启动 subdev

### 开流顺序


```text
1. rkisp-isp-subdev.s_stream(1)
2. rkisp-csi-subdev.s_stream(1)
3. rockchip-csi2-dphy0.s_stream(1)
4. imx415.s_stream(1)
```

实现骨架：

```c
/**
 * @brief 按下游到上游的顺序启动或停止整条 subdev pipeline。
 * @param pipeline 已由 Media Graph 收集好的 RKISP pipeline。
 * @param on true 表示开流，false 表示关流。
 * @return 成功返回 0，失败返回负 errno。
 */
static int rkisp_pipeline_set_stream(struct rkisp_pipeline *pipeline,
                                     bool on)
{
    struct rkisp_device *isp_dev =
        container_of(pipeline, struct rkisp_device, pipe);
    int index;
    int ret;

    /* 多个 capture path 共用同一输入 pipeline，只在第一次真正启动。 */
    if (on && atomic_inc_return(&pipeline->stream_cnt) > 1)
        return 0;
    if (!on && atomic_dec_return(&pipeline->stream_cnt) > 0)
        return 0;

    if (on) {
        if (isp_dev->vs_irq >= 0)
            enable_irq(isp_dev->vs_irq);
        rockchip_set_system_status(SYS_STATUS_ISP);

        /* 先准备 ISP，使它能够接收即将到来的像素。 */
        ret = v4l2_subdev_call(&isp_dev->isp_sdev.sd,
                               video, s_stream, 1);
        if (ret && ret != -ENOIOCTLCMD)
            goto disable_system_status;

        /* 顺序为 CSI2RX、D-PHY、Sensor；Sensor 最后开始发送。 */
        for (index = 0; index < pipeline->num_subdevs; ++index) {
            ret = v4l2_subdev_call(pipeline->subdevs[index],
                                   video, s_stream, 1);
            if (ret < 0 && ret != -ENOIOCTLCMD && ret != -ENODEV)
                goto rollback_started_subdevs;
        }
        return 0;
    }

    /* 关流按相反方向：先停止 Sensor，再停止接收端。 */
    for (index = pipeline->num_subdevs - 1; index >= 0; --index)
        v4l2_subdev_call(pipeline->subdevs[index],
                         video, s_stream, 0);

    if (isp_dev->vs_irq >= 0)
        disable_irq(isp_dev->vs_irq);
    v4l2_subdev_call(&isp_dev->isp_sdev.sd, video, s_stream, 0);
    rockchip_clear_system_status(SYS_STATUS_ISP);
    return 0;

rollback_started_subdevs:
    while (--index >= 0)
        v4l2_subdev_call(pipeline->subdevs[index],
                         video, s_stream, 0);
    v4l2_subdev_call(&isp_dev->isp_sdev.sd, video, s_stream, 0);
disable_system_status:
    if (isp_dev->vs_irq >= 0)
        disable_irq(isp_dev->vs_irq);
    rockchip_clear_system_status(SYS_STATUS_ISP);
restore_count:
    atomic_dec(&pipeline->stream_cnt);
    return ret;
}
```

当前 vendor 实现对 ISP `.s_stream(1)` 的返回值没有检查。新写驱动时应尽量检查并回滚；若
必须兼容旧 subdev 没有实现该 callback，可把 `-ENOIOCTLCMD` 视为“不需要操作”。

### 为什么 Sensor 必须最后启动

如果先让 IMX415 退出 standby，再配置 D-PHY、CSI2RX、ISP 和 MI，最前面的 MIPI packet
会进入未准备好的接收端，可能产生：

- D-PHY lane/settle 错误；
- CSI-2 packet、ECC 或 CRC 错误；
- ISP frame start/end 不配对；
- MI 在 DMA 地址未准备时收到像素；
- 第一帧丢失或 Buffer 内容不完整。

让数据源最后启动，可以把 pipeline 看成逐级打开的接收漏斗。

## 启动 RKISP ISP 与 CSI2RX

### ISP subdev


`rkisp_isp_sd_s_stream(1)` 主要完成：

```c
/**
 * @brief 启动或停止 RKISP ISP 核心。
 * @param sd RKISP ISP subdev。
 * @param on 非零表示启动，0 表示停止。
 * @return 当前实现返回 0。
 */
static int rkisp_isp_sd_s_stream(struct v4l2_subdev *sd, int on)
{
    struct rkisp_device *isp_dev = sd_to_isp_dev(sd);

    if (!on) {
        rkisp_stop_3a_run(isp_dev);       /* 停止 3A 协同状态。 */
        rkisp_isp_stop(isp_dev);          /* 停止 ISP 接收和处理。 */
        rkisp_params_stream_stop(&isp_dev->params_vdev);
        return 0;
    }

    rkisp_start_3a_run(isp_dev);          /* 通知 3A 相关路径开始运行。 */
    rkisp_global_update_mi(isp_dev);      /* 把 MI shadow 配置更新到硬件。 */
    rkisp_config_cif(isp_dev);            /* 配置 CSI2RX/输入协议相关寄存器。 */
    rkisp_isp_start(isp_dev);             /* 使能 ISP 核心。 */
    return 0;
}
```

`rkisp_config_cif()` 名字中虽然有 CIF，但这里负责 RKISP 的输入侧配置；当前 active path 仍然
是 D-PHY 直连 RKISP CSI2RX，没有经过独立 RKCIF capture 设备。

### CSI subdev

线性模式下 `rkisp_csi_s_stream()` 主要清零错误/中断计数。HDR readback 模式还会配置额外的Y statistics。通用 CSI2RX 的核心寄存器配置已经由 ISP start 路径中的`rkisp_config_cif()` 完成。

不要因为该 `.s_stream()` 在线性模式工作很少，就从 Media Graph 中删除 CSI entity。它仍然代表 CSI-2 packet 接收、VC/Data Type 和错误中断这一层硬件职责。

## 配置并启动 CSI2 D-PHY

D-PHY 的 `.s_stream(1)` 不能直接写一个 enable bit。它必须先从当前 Sensor 取得实际速率和lane 配置。

### 从 `V4L2_CID_LINK_FREQ` 计算 lane bit rate

```c
/**
 * @brief 从远端 Sensor 的 link-frequency control 计算 D-PHY lane bit rate。
 * @param sd D-PHY subdev。
 * @return 成功返回 0，control 缺失或数值无效返回负 errno。
 */
static int csi2_dphy_get_sensor_data_rate(struct v4l2_subdev *sd)
{
    struct csi2_dphy *dphy = to_csi2_dphy(sd);
    struct v4l2_subdev *sensor = get_remote_sensor(sd);
    struct v4l2_ctrl *link_freq;
    struct v4l2_querymenu item = { .id = V4L2_CID_LINK_FREQ };
    int ret;

    link_freq = v4l2_ctrl_find(sensor->ctrl_handler,
                               V4L2_CID_LINK_FREQ);
    if (!link_freq)
        return -EPIPE;

    /* link_freq control 保存的是 menu index，不是直接的 Hz 值。 */
    item.index = v4l2_ctrl_g_ctrl(link_freq);
    ret = v4l2_querymenu(sensor->ctrl_handler, &item);
    if (ret)
        return ret;

    if (!item.value)
        return -EINVAL;

    /* DDR 每个时钟周期传输两个 bit。 */
    dphy->data_rate_mbps = item.value * 2;
    do_div(dphy->data_rate_mbps, 1000 * 1000);
    return 0;
}
```

当前线性 RAW10 mode：

```text
link frequency = 446 MHz
lane bit rate  = 446 MHz × 2 = 892 Mbit/s/Lane
data lanes     = 4
```
### 更新 lane/bus 配置
D-PHY 通过 Sensor 的 `.g_mbus_config()` 取得：

```text
bus type：V4L2_MBUS_CSI2
lane 数：4
clock mode：continuous clock
channel：VC0
```

这一步再次读取当前 Sensor 状态，而不是只相信 Probe 时缓存的 endpoint，便于 mode 或输入
发生变化后得到一致配置。

### 启动 D-PHY 硬件

```c
/**
 * @brief 准备 D-PHY 参数并启动接收硬件。
 * @param sd D-PHY subdev。
 * @return 成功返回 0，参数或硬件配置失败返回负 errno。
 */
static int csi2_dphy_s_stream_start(struct v4l2_subdev *sd)
{
    struct csi2_dphy *dphy = to_csi2_dphy(sd);
    int ret;

    if (dphy->is_streaming)
        return 0;

    ret = csi2_dphy_get_sensor_data_rate(sd);
    if (ret)
        return ret;

    ret = csi2_dphy_update_sensor_mbus(sd);
    if (ret)
        return ret;

    /* 根据 rate、lane 和 full/split mode 配置 RK3568 PHY 寄存器。 */
    ret = dphy->dphy_hw->stream_on(dphy, sd);
    if (ret)
        return ret;

    dphy->is_streaming = true;
    return 0;
}
```
底层 `csi2_dphy_hw_stream_on()` 主要完成：

- 选择 full/split lane mode；
- 使能 clock lane 和四条 data lane；
- reset D-PHY digital 部分；
- 根据 892 Mbit/s/Lane 选择 HS frequency range；
- 为 clock/data lanes 配置 `THS-SETTLE`；
- 需要时开启校准；
- 增加共享 D-PHY hardware stream 引用。

到这里，物理接收器已经等待高速 MIPI 信号，但 IMX415 仍处于 standby。

## 让 IMX415 最后退出 standby

### `imx415_s_stream()` 管理状态和 runtime PM


```c
/**
 * @brief 启动或停止 IMX415 连续输出。
 * @param sd IMX415 V4L2 subdev。
 * @param on 非零表示启动，0 表示停止。
 * @return 成功返回 0，I2C、control 或电源操作失败返回负 errno。
 */
static int imx415_s_stream(struct v4l2_subdev *sd, int on)
{
    struct imx415 *imx415 = to_imx415(sd);
    struct device *dev = &imx415->client->dev;
    int ret = 0;

    mutex_lock(&imx415->mutex);
    on = !!on;

    /* 重复请求保持幂等，不重复写整张寄存器表。 */
    if (on == imx415->streaming)
        goto unlock;

    if (on) {
        /* 保证整个寄存器写入期间设备不会 runtime suspend。 */
        ret = pm_runtime_get_sync(dev);
        if (ret < 0) {
            pm_runtime_put_noidle(dev);
            goto unlock;
        }

        ret = __imx415_start_stream(imx415);
        if (ret) {
            pm_runtime_put(dev);
            goto unlock;
        }
    } else {
        ret = __imx415_stop_stream(imx415);
        if (ret)
            goto unlock;
        pm_runtime_put(dev);
    }

    imx415->streaming = on;

unlock:
    mutex_unlock(&imx415->mutex);
    return ret;
}
```

即使 `open()` 已经通过 `.s_power(1)` 增加过 runtime PM 引用，`.s_stream(1)` 仍增加自己的
引用。这样即使以后 power/open 策略调整，streaming 期间也不会意外断电。关流释放 streaming
引用，最终 close 再释放 open/pipeline 引用。

### 写寄存器的正确顺序

```c
/**
 * @brief 配置当前 mode、恢复 controls，并让 IMX415 开始输出。
 * @param imx415 IMX415 驱动私有数据。
 * @return 成功返回 0，任意 I2C/control 操作失败返回负 errno。
 */
static int __imx415_start_stream(struct imx415 *imx415)
{
    int ret;

    /* 写与位深和基础时钟相关的全局初始化表。 */
    ret = imx415_write_array(imx415->client,
                             imx415->cur_mode->global_reg_list);
    if (ret)
        return ret;

    /* 写当前 3864x2192 RAW10 30 FPS mode 的寄存器表。 */
    ret = imx415_write_array(imx415->client,
                             imx415->cur_mode->reg_list);
    if (ret)
        return ret;

    /* 把开流前缓存的曝光、增益、VBLANK 和 flip 写入硬件。 */
    ret = __v4l2_ctrl_handler_setup(&imx415->ctrl_handler);
    if (ret)
        return ret;

    /* 0x3000 = 0：退出 standby，开始连续输出 MIPI 帧。 */
    return imx415_write_reg(imx415->client,
                            IMX415_REG_CTRL_MODE,
                            IMX415_REG_VALUE_08BIT,
                            0);
}
```

关键点是 `IMX415_REG_CTRL_MODE = 0` 必须最后写。global/mode/controls 尚未配置完成时就退出
standby，可能输出使用旧参数或处于中间状态的帧。

## 完整 STREAMON 调用链

把系统调用入口、V4L2 core、VB2 和四级硬件驱动连起来：

```text
ioctl(video_fd, VIDIOC_STREAMON, VIDEO_CAPTURE_MPLANE)
  -> V4L2 core v4l2_ioctl()
     -> video_devdata(file)：minor -> rkisp_mainpath video_device
     -> rkisp_fops.unlocked_ioctl = video_ioctl2()
        -> video_usercopy()
           -> __video_do_ioctl()
              -> v4l_streamon()
                 -> rkisp_v4l2_ioctl_ops.vidioc_streamon
                    = vb2_ioctl_streamon()
                    -> video_device->queue：取得 mainpath vb2_queue
                    -> vb2_streamon()
                       -> vb2_core_streamon()
                          -> vb2_start_streaming()
                             -> rkisp_buf_queue() × 已 QBUF Buffer
                             -> queue->ops->start_streaming
                                = rkisp_start_streaming()
                                -> rkisp_update_sensor_info()
                                -> rkisp_create_dummy_buf()
                                -> rkisp_pipeline_open()
                                   -> __isp_pipeline_prepare()
                                   -> __isp_pipeline_s_isp_clk()
                                -> rkisp_stream_start()
                                   -> config resizer/crop
                                   -> config and enable MI DMA
                                -> rkisp_pipeline_set_stream(true)
                                   -> rkisp_isp_sd_s_stream(true)
                                   -> rkisp_csi_s_stream(true)
                                   -> csi2_dphy_s_stream(true)
                                      -> get link frequency = 446 MHz
                                      -> data rate = 892 Mbit/s/Lane
                                      -> configure 4-lane D-PHY
                                   -> imx415_s_stream(true)
                                      -> pm_runtime_get_sync()
                                      -> write global register table
                                      -> write mode register table
                                      -> apply V4L2 controls
                                      -> write 0x3000 = 0
                                -> media_pipeline_start()
```

此调用链完成后，图像数据的实际方向与函数调用方向相反：

```text
IMX415 RAW10
  -> D-PHY
  -> CSI2RX
  -> ISP
  -> mainpath MI DMA
  -> 已 QBUF 的 VB2 Buffer
```

## 失败回滚


`start_streaming()` 失败时，VB2 要求驱动把所有已经取得的 Buffer 归还为
`VB2_BUF_STATE_QUEUED`。否则 VB2 会产生 warning，并强制回收 ACTIVE Buffer。

推荐的回滚标签与成功动作一一对应：

```c
    return 0;

stream_off:
    isp_dev->pipe.set_stream(&isp_dev->pipe, false);
stop_stream:
    rkisp_stream_stop(stream);
close_pipeline:
    isp_dev->pipe.close(&isp_dev->pipe);
destroy_dummy:
    rkisp_destroy_dummy_buf(stream);
return_buffers:
    /* STREAMON 失败时退回 QUEUED，使 queue 恢复到可重试状态。 */
    destroy_buf_queue(stream, VB2_BUF_STATE_QUEUED);
    atomic_dec(&isp_dev->cap_dev.refcnt);
    stream->streaming = false;
unlock:
    mutex_unlock(&isp_dev->hw_dev->dev_lock);
    return ret;
```

例如 IMX415 写 mode table 失败，回滚方向应是：

```text
已经启动：ISP、CSI2RX、D-PHY
失败位置：IMX415

回滚：D-PHY off
  -> CSI2RX off
  -> ISP off
  -> mainpath/MI stop
  -> pipeline close
  -> dummy Buffer free
  -> 用户 Buffer 退回 VB2
```

失败路径不得把 `streaming` 留为 true，也不得泄漏 runtime PM、atomic reference 或 Buffer
ownership。

## 板端验证命令

运行测试前，应先确认没有其他进程占用 `/dev/video0`。以下命令由你在开发板执行。

### 保存开流前拓扑

```bash
media-ctl -d /dev/media0 -p
v4l2-ctl -d /dev/video0 --all
```

### 用 v4l2-ctl 验证 100 帧

```bash
v4l2-ctl -d /dev/video0 \
  --set-fmt-video=width=1920,height=1080,pixelformat=NV12 \
  --stream-mmap=4 \
  --stream-poll \
  --stream-count=100 \
  --verbose
```

### 观察驱动日志和中断


```bash
dmesg -w | grep -E 'imx415|dphy|rkisp|csi|stream'
```

另一个终端查看硬件中断和 RKISP 状态：

```bash
cat /proc/interrupts | grep -E 'rkisp|csi|mipi'
cat /proc/rkisp-vir0
```












