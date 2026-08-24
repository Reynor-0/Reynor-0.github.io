---
title: 'Camera 驱动开发（七）：VB2、MMAP、DMA-BUF 与四 Buffer'
description: '弄清楚buffer管理机制'
series: { id: 'camera-driver', order: 7 }
tags: ['Camera', 'Linux', 'V4L2', '图像处理']
pubDate: 'Jun 26 2026'
---

## 1. 本篇的目标

上一篇我们已经理解了 RKISP MainPath 的 MI 单元能够把处理后的图像写入DDR，但是我们还没有弄清楚：这块DDR内存到底是谁创建的，应用调用`mmap()`之后得到的到底是什么，为甚恶魔还需要`vb2_buffer`？

本篇只在让读者理解：

1. `mmap()`究竟在干什么
2. `vb2_buffer` 的作用是什么
3. DMA地址、用户虚拟地址以及DMA-BUF fd指向的为什么是同一份真实存储
4. NV12为什么有两个color plane，却只有一个memory plane?
5. 申请的四块Buffer如何在VB2、RKISP、MI和应用之间循环？
6. 应用消费过慢的时候，驱动的是如何管理生产速度过快的Sensor端的？

### 1.1 当前板端基线

| 项目 | 当前值 |
| --- | --- |
| Video node | `/dev/video0`，RKISP MainPath |
| Buffer type | `V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE` |
| 输出格式 | 1920x1080 NV12 |
| memory plane 数 | 1 |
| color plane 数 | 2，Y 与交错 UV |
| `bytesperline` | 1920 byte |
| 有效 payload | 3,110,400 byte |
| 实际分配长度 | 3,133,440 byte |
| Buffer 数 | 4 |
| 当前采集结果 | 100 帧、30 FPS、无 timeout/error/sequence gap |

这里的 1920x1080 NV12 是应用对 RKISP MainPath 选择的输出格式，不是 IMX415 Sensor
驱动被固定成 NV12。Sensor 仍从自己的 mode 表中协商 RAW mode，ISP 再把 RAW 数据处理成
MainPath 的 NV12。第七篇只管理后者在 DDR 中的 Buffer。

## 2. 先理解正确的Buffer对象模型

### 2.1 VB2

VB2 全程是 Videobuf2。它为 V4L2 streaming 驱动统一处理以下的这些工作：

- Buffer 分配、释放和mmap；
- Buffer index、plane和长度检查；
- `REQUBUFS/QBUF/DQBUF/STREAMON/STREAMOFF` 状态机;
- done queue、等待队列以及`poll()`唤醒
- MMAP、USERPTR、DAM-BUF等memory model
- 将通用的V4L2 Buffer包装后交给具体的硬件驱动。

VB2 不采集像素，也不了解 IMX415 寄存器。RKISP 驱动仍然必须负责：

- 从 VB2 Buffer 取得设备可用的 DMA 地址；
- 将 Y/UV 地址写入 MI 寄存器；
- 在 frame-end 中断里判断哪块 Buffer 已经写完；
- 填写 payload、sequence、timestamp 和状态；
- 调用 `vb2_buffer_done()` 把 Buffer 归还给 VB2。

因此，“VB2 Buffer”和“mmap Buffer”不是两份内存。前者强调内核中的管理对象，后者强调
同一份存储在用户进程中的映射方式。

### 2.2 RKISP Buffer

```text
struct rkisp_buffer
  ├── struct vb2_v4l2_buffer
  │     ├── struct vb2_buffer
  │     │     ├── planes[]
  │     │     ├── index
  │     │     ├── state
  │     │     └── vb2_queue *
  │     ├── sequence
  │     ├── field
  │     └── flags
  ├── list_head queue
  └── buff_addr[]             RKISP MI 使用的 DMA 地址
```

可以按下面的最小结构开始设计：

```c
struct rkisp_buffer{
    /** VB2/V4L2 通用 Buffer 元数据，必须作为驱动 Buffer 的组成部分。 */
    struct vb_v4l2_buffer vb;
    /** 挂入 rkisp_stream::buf_queue 的驱动私有链表节点。 */
    struct list_head queue;
    /**
     * RKISP MI 可访问的 Y、Cb 和 Cr DMA 地址。
     * 对单 memory-plane NV12，UV 地址由 Y 基地址加 Y plane 大小计算得到。
     */
    dma_addr_t buff_addr[VIDEO_MAX_PLANES];
}
```

### 2.3 一条 MainPath stream 的对象关系

```text
/dev/video0
  -> struct video_device
  -> struct rkisp_vdev_node
       -> struct vb2_queue
  -> vb2_queue.drv_priv
       -> struct rkisp_stream
            -> buf_queue
            -> curr_buf
            -> next_buf
            -> vbq_lock
            -> out_fmt
            -> rkisp_device
```
对应的驱动私有结构可保留以下核心成员：

```c
/**
 * @brief 表示 RKISP 的一条 capture 输出流，例如 MainPath。
 */
struct rkisp_stream {
    /** 当前 stream 所属的 RKISP 设备。 */
    struct rkisp_device *ispdev;

    /** 包含 video_device、media pad 和 vb2_queue。 */
    struct rkisp_vdev_node vnode;

    /** 应用在该 video node 上协商出的输出尺寸、stride 和 sizeimage。 */
    struct v4l2_pix_format_mplane out_fmt;

    /** 已由 VB2 交给驱动、但尚未写入硬件寄存器的 Buffer 链表。 */
    struct list_head buf_queue;

    /** 正在承接当前帧，frame-end 后才允许完成。 */
    struct rkisp_buffer *curr_buf;

    /** 已预先写入 shadow register、供下一帧使用的 Buffer。 */
    struct rkisp_buffer *next_buf;

    /** 保护 buf_queue、curr_buf 和 next_buf，允许在中断上下文使用。 */
    spinlock_t vbq_lock;

    /** 串行化进程上下文中的 V4L2 queue 操作。 */
    struct mutex apilock;

    /** 当前硬件 stream 是否已启动。 */
    bool streaming;
};
```

必须区分两条队列：

| 队列 | 管理者 | 含义 |
| --- | --- | --- |
| VB2 内部 queued/done queue | VB2 core | 维护标准 V4L2 Buffer 状态和等待关系 |
| `rkisp_stream::buf_queue` | RKISP 驱动 | 保存已经交给驱动、等待写入 MI 的 Buffer |

`rkisp_buf_queue()` 的作用就是把一块 Buffer 从 VB2 管理边界接入 RKISP 私有队列；它不是
重新分配 Buffer，也不是把图像复制进另一个链表。

## 3. 为MainPath 初始化`vb2_queue`

### 3.1 驱动回调

```c
/** RKISP 提供给 VB2 的硬件相关回调。 */
static const struct vb2_ops rkisp_vb2_ops = {
    /* 根据当前输出格式报告 plane 数和每个 plane 的分配大小。 */
    .queue_setup = rkisp_queue_setup,
    /* Buffer 进入驱动后，取得 DMA 地址并挂入 RKISP 私有队列。 */
    .buf_queue = rkisp_buf_queue,
    /* VB2 等待时释放 queue mutex，唤醒后重新取得 mutex。 */
    .wait_prepare = vb2_ops_wait_prepare,
    .wait_finish = vb2_ops_wait_finish,
    /* STREAMON 时配置 MI、启动 pipeline 和上游 subdev。 */
    .start_streaming = rkisp_start_streaming,
    /* STREAMOFF 时停止硬件，并归还驱动持有的所有 Buffer。 */
    .stop_streaming = rkisp_stop_streaming,
};
```

### 3.2 初始化 queue

```c
/* 部分实现 */
static int rkisp_init_vb2_queue(struct vb2_queue *queue, struct rkisp_stream *stream, enum v4l2_buf_type type)
{
    memset(queue, 0, sizeof(*queue));
    /* MainPath 对外使用 multi-planar capture API。 */
    queue->type = type;
    /* 声明 queue 能接受的 V4L2 memory model。 */
    queue->io_modes = VB2_MMAP | VB2_USERPTR | VB2_DMABUF;
    /* 让每个 VB2 回调都能找回所属的 rkisp_stream。 */
    queue->drv_priv = stream;
    /* 安装 RKISP 的 queue_setup、buf_queue 和 streaming 回调。 */
    queue->ops = &rkisp_vb2_ops;
    /*
     * 内存后端由 RKISP hardware device 统一选择。
     * 有 IOMMU/SG 配置时可选择 dma-sg；其他平台也可能使用 dma-contig。
     */
    queue->mem_ops = stream->ispdev->hw_dev->mem_ops;
    /* 要求 VB2 为每个 Buffer 分配驱动扩展结构，而非只有通用结构。 */
    queue->buf_struct_size = sizeof(struct rkisp_buffer);
    /* 使用单调时钟，避免系统墙上时间调整造成时间戳倒退。 */
    queue->timestamp_flags = V4L2_BUF_FLAG_TIMESTAMP_MONOTONIC;
    /* 串行化 ioctl 进程上下文中的 queue 操作。 */
    queue->lock = &stream->apilock;
     /* memory backend 以 RKISP DMA device 建立映射。 */
    queue->dev = stream->ispdev->hw_dev->dev;

    return vb2_queue_init(queue);
}

```


不能无条件把 `queue->mem_ops` 写成 `&vb2_dma_sg_memops`。正确做法是先确认：

- RKISP 是否挂在 IOMMU domain；
- 当前 BSP 是否把 capture Buffer 映射为连续 IOVA；
- `hw_dev->mem_ops` 在 probe/attach 阶段选择了 dma-sg 还是 dma-contig；
- RKISP MI 寄存器是否只接受 32-bit DMA 地址。

当前 SDK 的 RKISP21 路径能够按硬件配置选择 SG 或 contiguous backend。驱动后面获取 DMA
地址时也必须与这个选择保持一致。

### 3.3 将queue接到video node

```c
static int rkisp_mainpath_init(struct rkisp_device *dev, struct rkisp_stream *stream)
{
    int ret;

    stream->ispdev =dev;
    INIT_LIST_HEAD(&stream->buf_queue);
    spin_lock_init(&stream->vbq_lock);
    mutex_init(&stream->apilock);

    ret = rkisp_init_vb2_queue(&stream->vnode.buf_queue, stream, V4L2_BUF_TYPE_VIDEO_CAPTURE_MPLANE);
    if (ret)
        return ret;
    stream->vnode.vdev.queue = &stream->vnode.buf_queue;

    return video_register_device(&stream->vnode.vdev, VFL_TYPE_VIDEO, -1);
}
```

实际 RKISP SDK 还会初始化 media pad、stream ops、默认格式和多个输出节点。这里仅保留 VB2 建链所需的最小关系。

## 4. 实现`REQBUFS`的分配

### 4.1 `REQBUFS` 如何进入驱动

用户态对`/dev/video0`调用`VIDIOC_REQBUFS` 之后，内核的行为：

```text
ioctl(fd, VIDIOC_REQBUFS, &req)
    -> video_ioctl2()
    -> vb_ioctl_reqbufs()
    -> vb2_reqbufs() / vb2_core_reqbufs()
    -> rkisp_queue_setup()
    -> queue->mem_ops->alloc()  × Buffer 数 × memory plane 数
    -> 建立 vb2_buffer / rkisp_buffer 对象
    -> req.count 返回实际成功的分配数量
```

驱动不需要自己实现`vidioc_reqbufs` 中的完整状态机。将 ioctl ops 接到 VB2 helper 后，RKISP 只需在 `queue_setup()` 中回答两个硬件相关问题：有几个 memory plane，每个 plane 至少多大。

### 4.2 `queue_setup()` 的实现

```c
/**
 * @brief 根据 MainPath 当前格式报告 Buffer 的 memory-plane 布局。
 * @param queue 发起分配请求的 VB2 queue。
 * @param num_buffers 输入为请求数量，必要时可由驱动调整。
 * @param num_planes 返回每个 Buffer 的 memory plane 数量。
 * @param sizes 返回每个 memory plane 需要分配的最小字节数。
 * @param alloc_devs 可选的逐 plane DMA allocation device 数组。
 * @return 格式有效时返回 0，否则返回负 errno。
 */
static int rkisp_queue_setup(struct vb2_queue *queue,
                             unsigned int *num_buffers,
                             unsigned int *num_planes,
                             unsigned int sizes[],
                             struct devices *alloc_devs[])
{
    struct rkisp_stream *stream = queue->drv_priv;
    const struct v4l2_pix_format_mplane *pixm = &stream->out_fmt;
    const struct capture_fmt *format = &stream->out_isp_fmt;

    if (!format || format->mplanes == 0)
        return -EINVAL;

    /* mplanes 描述独立分配、独立 mmap 的 memory plane 数。 */
    *num_planes = format->mplanes;

    for (i = 0; i < *num_planes; i++)
    {
        const struct v4l2_plane_pix_format *plane = &pixm->plane_fmt[i];
        /*
         * RKISP BSP 为 YUV Buffer 按 16 行对齐分配空间，便于后续硬件共享。
         * sizeimage 仍表示可见图像的有效载荷大小。
         */
        if (format->fmt_type == FMT_YUV) {
            sizes[i] = plane->sizeimage / pixm->height *
                       ALIGN(pixm->height, 16);
        } else {
            sizes[i] = plane->sizeimage;
        }

    }
    return 0;
}

```

### 4.3 解释当前的两个长度

1920x1080 NV12 的有效 payload 为：

```text
Y  = 1920 * 1080       = 2,073,600 byte
UV = 1920 * 1080 / 2   = 1,036,800 byte
总计                      3,110,400 byte
```

当前 SDK 的 YUV 分配公式为：

```text
sizeimage / height * ALIGN(height, 16)
= 3,110,400 / 1080 * 1088
= 3,133,440 byte
```

因此测试日志中的：

```text
bytesused = 3110400
mapped    = 3133440
```

完全合理。前者是这一帧有效图像载荷，后者是包含 8 行对齐余量的实际内存对象长度。
应用不能因为 mmap 长度更大，就把尾部 padding 当成额外有效像素。

### 4.4 `REQBUFS` 真正创建了什么

执行`REQBUFS(count=4, memory=MMAP)`后，每个 Buffer 至少形成三类对象：

```text
Buffer 0
    -> struct rkisp_buffer / vb2_buffer 元数据
    -> memory backend 私有对象
    -> 1 个长度为 3,133,440 byte 的 memory plane

```

四块 Buffer 的有效载荷总计约 11.87 MiB，按实际 allocation length 计算约 11.95 MiB。
`REQBUFS` 的 `count` 是请求值，不是强制值；VB2 可以因为内存限制或驱动约束返回其他数量，
驱动和测试工具都必须读取返回的实际 `req.count`。

## 5. 实现 `QUERYBUF` 与 MMAP

### 5.1 `QUERYBUF`


```text
VIDIOC_QUERYBUF(index)
  -> VB2 找到对应 vb2_buffer
  -> 填写 length、flags、memory、plane 信息
  -> 为每个 MMAP plane 返回一个 offset
```

用户态拿到的 `m.offset` 或 `mem_offset` 是 mmap 标识，不是 MI DMA 地址，也不是可以直接
解引用的内核虚拟地址。它只允许后续 `mmap(video_fd, ..., offset)` 找到对应 plane。

### 5.2 mmap 只增加一种访问视图

```text
mmap(video_fd, length, offset)
  -> vb2_fop_mmap()
  -> vb2_mmap() / vb2_core_mmap()
  -> queue->mem_ops->mmap()
  -> 在当前进程页表中建立映射
```

这一步没有重新申请 3 MB 内存，也没有执行一次内核到用户态的整帧 `memcpy()`。完成后，
同一 memory plane 出现了不同的访问名称：


```text
VB2 memory object
  ├── 用户虚拟地址：应用 CPU 访问
  ├── DMA/IOMMU 地址：RKISP MI 访问
  └── 后续可选 DMA-BUF fd：其他设备导入
```

“MMAP 零拷贝”准确的含义是避免 capture 后再把整帧从内核缓冲区复制到应用缓冲区；它不
表示 DDR 不参与，也不表示任何 CPU cache 同步都可以忽略。cache 方向与同步由选定的 VB2
memory backend、DMA API 和 DMA-BUF attachment 共同处理，不能在驱动中随意删掉
`prepare/finish` 一类同步步骤。

### 5.3 为什么应用能读，DMA 也能写


应用访问的是 CPU 虚拟地址，MI 寄存器保存的是设备 DMA 地址。两者经过页表和 IOMMU 映射
后可以落到同一组 DDR page：

```text
CPU virtual address
  -> CPU page table
  -> DDR pages

RKISP DMA address / IOVA
  -> IOMMU page table
  -> 同一组 DDR pages
```

所以不能比较两个地址的数值来判断它们是否指向同一 Buffer。它们属于不同地址空间，本来
就不应相等。

## 6. 支持 `VIDIOC_EXPBUF`

### 6.1 EXPBUF 不是再次分配

`VIDIOC_EXPBUF` 是 MMAP memory model的扩展：

```text
VIDIOC_EXPBUF(index = 0, plane = 0)
     -> VB2 找到 Buffer 0 的 memory plane 0
     -> memory backend 为该对象创建/取得 dma_buf
     -> 安装一个 fd
     > 将 fd 返回用户态
```


它不会执行：

```text
旧 V4L2 Buffer -> memcpy -> 新 DMA-BUF
```

而是为同一个存储对象增加一个可跨设备传递的引用：

```text
                 mmap address（CPU 可访问）
                /
同一 DDR Buffer ---- DMA address（RKISP 可访问）
                \
                 DMA-BUF fd（RGA/DRM 可导入）
```

### 6.2 memory plane 决定导出次数

当前格式是 `V4L2_PIX_FMT_NV12`，不是 `V4L2_PIX_FMT_NV12M`：

| 格式 | color plane | memory plane | EXPBUF 次数/Buffer |
| --- | ---: | ---: | ---: |
| NV12 | 2：Y、UV | 1 | 1 |
| NV12M | 2：Y、UV | 2 | 2 |

对当前 `/dev/video0`，每个 Buffer 只需要导出 `plane=0`，得到四个 DMA-BUF fd。Y 和 UV
位于同一个 memory object 内，UV 起始位置由格式布局计算，不需要再虚构第二个 fd。

### 6.3 不要混淆导出和导入


```text
REQBUFS(memory=MMAP) + EXPBUF
  含义：V4L2/RKISP 分配内存，再把它导出给其他设备。

REQBUFS/QBUF(memory=DMABUF)
  含义：其他子系统分配内存，V4L2 作为 DMA-BUF importer 使用它。
```

本项目当前 capture 方向采用第一种。`queue->io_modes` 中声明 `VB2_DMABUF`，表示 queue 也
具备作为 importer 的能力，但这不代表当前四块 MMAP Buffer 是由应用或 DRM 分配的。

### 6.4 fd 生命周期

- `EXPBUF` 成功后，DMA-BUF fd 属于调用进程；
- fd 是引用，不是 Buffer index，也不是 DMA 地址；
- RGA/DRM 导入会各自持有 attachment 或 GEM 引用；
- 所有消费者释放引用并关闭 fd 后，底层内存才具备彻底回收条件；
- 销毁 queue 前应先解除下游导入，再关闭 DMA-BUF fd、解除 mmap，最后释放 VB2 Buffer。

## 7. 让 `QBUF` 把 Buffer 交给 RKISP

### 7.1 QBUF 的所有权含义

应用调用 `VIDIOC_QBUF` 后，承诺在下一次成功 `DQBUF` 之前不读写这块 Buffer。此时所有权
已经交给驱动，即使硬件尚未立刻选中它。

```text
STREAMON 之前：
QBUF -> VB2 记录为已排队，等待统一交给驱动

STREAMON 之后：
QBUF -> VB2 完成检查和 DMA 同步 -> rkisp_buf_queue()
```

首次 `STREAMON` 时，VB2 会把之前已经 QBUF 的 Buffer 逐个调用 `rkisp_buf_queue()`，然后
才调用 `rkisp_start_streaming()`。

### 7.2 Buffer 状态不是一个布尔值

可将正常 capture 生命周期简化为：

```text
DEQUEUED
  -> QBUF
QUEUED
  -> 交给驱动并被硬件选中
ACTIVE
  -> frame-end + vb2_buffer_done(DONE)
DONE
  -> DQBUF
DEQUEUED
```

如果 STREAMOFF、DMA error 或开流失败，驱动应以 `VB2_BUF_STATE_ERROR` 或框架要求的回滚
状态归还 Buffer，不能让 Buffer 永久留在 ACTIVE，导致 `DQBUF` 一直阻塞。

### 7.3 实现 `rkisp_buf_queue()`

下面保留当前 NV12 路径需要的关键逻辑：


```c
/**
 * @brief 将一块已由 VB2 验证的 Buffer 加入 RKISP DMA 等待队列。
 * @param vb VB2 已完成通用检查和内存准备的 Buffer。
 */
static void rkisp_buf_queue(struct vb2_buffer *vb)
{
    struct vb2_v4l2_buffer *v4l2_buffer;
    struct rkisp_buffer *buffer;
    struct rkisp_stream *stream;
    const struct capture_fmt *format;
    struct sg_table *sgt;
    unsigned long flags;
    unsigned int i;

    v4l2_buffer = to_vb2_v4l2_buffer(vb);
    buffer = container_of(v4l2_buffer, struct rkisp_buffer, vb);
    stream = vb->vb2_queue->drv_priv;
    format = &stream->out_isp_fmt;

    memset(buffer->buff_addr, 0, sizeof(buffer->buff_addr));

    for (i = 0; i < format->mplanes; ++i)
    {
        if (stream->ispdev->hw_dev->is_dma_sg_ops) {
            /*
             * dma-sg backend 返回已映射到 RKISP DMA domain 的 SG table。
             * 在 IOMMU 下，sg_dma_address() 通常是设备看到的 IOVA。
             */
            sgt = vb2_dma_sg_plane_desc(vb, i);
            if (!sgt || !sgt->sgl) {
                vb2_buffer_done(vb, VB2_BUF_STATE_ERROR);
                return;
            }
            buffer->buff_addr[i] = sg_dma_address(sgt->sgl);
        } else {
            /* dma-contig backend 直接提供该 plane 的 DMA 地址。 */
            buffer->buff_addr[i] =
                vb2_dma_contig_plane_dma_addr(vb, i);
        }
    }

    if (format->mplanes == 1 && format->cplanes > 1) {
        /* 单 memory-plane NV12：UV 紧跟在完整 Y plane 后。 */
        buffer->buff_addr[RKISP_PLANE_CB] =
            buffer->buff_addr[RKISP_PLANE_Y] +
            stream->out_fmt.plane_fmt[0].bytesperline *
            stream->out_fmt.height;
    }

    /*
     * QBUF 可能运行在进程上下文，取 Buffer 则发生在 frame-end IRQ。
     * 必须用 irq-safe spinlock 保护共享链表。
     */
    spin_lock_irqsave(&stream->vbq_lock, flags);
    list_add_tail(&buffer->queue, &stream->buf_queue);
    spin_unlock_irqrestore(&stream->vbq_lock, flags);
}
```

这段代码的核心产物不是用户虚拟地址，而是 RKISP MI 能写入的 DMA 地址。驱动不应把
`vb2_plane_vaddr()` 返回值写进硬件寄存器；CPU virtual address 对 DMA engine 没有意义。

### 7.4 SG 不等于硬件支持任意离散地址


`vb2_dma_sg_plane_desc()` 返回 scatter-gather table，并不自动证明 RKISP MI 能在一帧中遍历
任意物理离散段。目标 BSP 通常借助 IOMMU 把多个物理 page 映射成连续 IOVA，MI 只看到
首地址和连续地址空间。

如果关闭 IOMMU，却仍把 `sg_dma_address(sgt->sgl)` 当作整帧连续地址使用，就必须确认：

- backend 强制分配了物理连续内存；或者
- 硬件本身支持 SG descriptor；或者
- SG table 实际只有一个 DMA segment。

三者都不成立时，仅保存第一段地址会导致越界 DMA 或花屏。

### 8. 用四块 Buffer 驱动 MI 流水线

### 8.1 为什么 RKISP 同时需要 `curr_buf` 和 `next_buf`

RKISP 大量寄存器带有 shadow 机制。当前帧正在写入时，驱动必须提前准备下一帧地址；硬件
在规定的帧边界把 init register 更新到 shadow register。于是驱动需要：


```text
curr_buf：当前帧正在使用或刚刚完成的 Buffer
next_buf：已经为后续帧准备的 Buffer
buf_queue：更后面的候选 Buffer
```

这三个位置是 RKISP 驱动的流水线视图，不等于额外创建了三份图像。

### 8.2 四 Buffer 的稳定轮转

假设应用依次 QBUF B0、B1、B2、B3，忽略启动瞬间不同硬件版本的指针更新细节，稳定状态可以表示为：


| 时刻 | MI 当前写入 | 已预装下一帧 | RKISP 等待队列 | 应用持有 |
| --- | --- | --- | --- | --- |
| 开流后 | B0 | B1 | B2、B3 | 无 |
| 第 0 帧结束 | B1 | B2 | B3 | B0 可 DQBUF |
| 应用重新 QBUF B0 | B1 | B2 | B3、B0 | 无 |
| 第 1 帧结束 | B2 | B3 | B0 | B1 可 DQBUF |
| 应用重新 QBUF B1 | B2 | B3 | B0、B1 | 无 |
| 第 2 帧结束 | B3 | B0 | B1 | B2 可 DQBUF |

这正是当前日志中 Buffer index 按 `0,1,2,3,0,1,2,3...` 循环的原因。顺序循环不是 V4L2
协议强制保证，而是当前生产和消费都足够稳定时，FIFO 排队自然得到的结果。

## 9. 在 frame-end 中断中完成 Buffer

### 9.1 中断调用链

```text
RKISP MI frame-end
  -> RKISP IRQ handler
  -> rkisp_mi_v21_isr(mis_val, dev)
  -> 找到产生中断的 stream
  -> 清除对应 frame-end interrupt
  -> mi_frame_end(stream)
  -> vb2_set_plane_payload()
  -> 填写 sequence / timestamp
  -> vb2_buffer_done(DONE)
  -> curr_buf = next_buf
  -> 从 buf_queue 取新的 next_buf
  -> update_mi() 写入后续 DMA 地址
```

只有确认 MI 已完整写完一帧，才能把 Buffer 标记为 DONE。Sensor frame-start、CSI frame-end
或 ISP 内部处理结束都不能代替 MainPath MI frame-end，因为这些时刻 DDR 写入可能尚未完成。

### 9.2 实现核心轮转

```c
/**
 * @brief 处理一条 RKISP stream 的 MI frame-end。
 * @param stream 产生 frame-end 的 capture stream。
 * @return 成功返回 0。
 */
static int mi_frame_end(struct rkisp_stream *stream)
{
    struct rkisp_buffer *done;
    struct vb2_buffer *vb;
    unsigned long flags;
    unsigned int i;

    done = stream->curr_buf;
    if(done)
    {
        vb = &done->vb.vb2_buf;
        /* 报告可见图像的有效字节数，而不是对齐后的 allocation length。 */
        for (i = 0; i < stream->out_isp_fmt.mplanes; ++i) {
            vb2_set_plane_payload(
                vb,
                i,
                stream->out_fmt.plane_fmt[i].sizeimage);
        }

        /* sequence 表示帧序号，用于识别丢帧或乱序。 */
        done->vb.sequence = rkisp_get_frame_sequence(stream);

        /* 使用当前 queue 声明的单调时钟域填写纳秒时间戳。 */
        vb->timestamp = rkisp_get_frame_timestamp(stream);

        /* 发布 DONE 后，驱动不得再访问该 Buffer 的图像内容。 */
        vb2_buffer_done(vb, VB2_BUF_STATE_DONE);
        stream->curr_buf = NULL;
    }

    /* 已经预装的 Buffer 接替当前帧位置。 */
    stream->curr_buf = stream->next_buf;
    stream->next_buf = NULL;

    /* 取一块更后面的 Buffer，准备下一次 shadow register 更新。 */
    spin_lock_irqsave(&stream->vbq_lock, flags);
    if (!list_empty(&stream->buf_queue)) {
        stream->next_buf = list_first_entry(&stream->buf_queue,
                                             struct rkisp_buffer,
                                             queue);
        list_del(&stream->next_buf->queue);
    }
    spin_unlock_irqrestore(&stream->vbq_lock, flags);

    /* 有 next_buf 就写真实地址，否则写 dummy buffer 地址。 */
    stream->ops->update_mi(stream);
    return 0;
}
```


### 9.3 `vb2_buffer_done()` 实际完成什么

调用后，VB2 会把 Buffer 从驱动 ACTIVE 状态移入 done queue，并唤醒等待该 queue 的进程。
后续用户态可能通过以下任一方式被唤醒：

- 阻塞式 `VIDIOC_DQBUF`；
- `poll()`/`select()`/`epoll()` 监听 video fd；
- 非阻塞 `DQBUF` 在 ready 后成功返回。

驱动不需要分别为 poll、select 和 epoll 实现三套 frame wait。它只需要正确调用
`vb2_buffer_done()`，VB2 的等待队列会向这些用户态机制提供统一的 readiness。

### 9.4 元数据的边界

| 字段 | 驱动应在何时填写 | 当前意义 |
| --- | --- | --- |
| `bytesused`/payload | MI frame-end | 3,110,400 byte 有效 NV12 数据 |
| `sequence` | 当前帧完成时 | 检查是否出现 frame gap |
| `timestamp` | 与当前帧事件对应的时刻 | 单调时钟域，用于时序和延迟分析 |
| `flags` | VB2 状态及驱动附加信息确定后 | DONE、ERROR、timestamp 类型等 |
| `data_offset` | plane 内有效载荷不从 0 开始时 | 当前日志为 0 |

不能在 QBUF 时把 `bytesused` 固定成“已经采集完成”，也不能在真正 DMA 完成前发布 DONE。

## 10. 处理应用消费过慢

### 10.1 驱动不能覆盖应用持有的 Buffer

应用成功 DQBUF B0 后，B0 的所有权属于应用。即使下一帧已经到来，RKISP 也不能把 MI 地址
重新指向 B0，否则应用可能一边读取旧帧，DMA 一边覆盖同一内存，最终得到撕裂或混合帧。

只有应用再次 QBUF B0，驱动才可以重新使用它。

### 10.2 四块 Buffer 全部耗尽时


如果应用持续 DQBUF 却不及时 QBUF，状态会逐渐变成：

```text
B0：应用持有
B1：应用持有
B2：应用持有
B3：MI 当前使用或即将完成
RKISP buf_queue：空
next_buf：NULL
```

Sensor 是实时像素源，通常不能因为 MainPath 没有 Buffer 就无限暂停曝光和 MIPI 传输。为了
维持 CSI/ISP pipeline，RKISP 会把后续 MI 地址切到预先分配的 dummy buffer：

```text
有 next_buf   -> MI 写入可交付的真实 Buffer
无 next_buf   -> MI 写入 dummy buffer，并增加 frame-loss 统计
```

dummy buffer 的目的不是保存待应用稍后读取的帧，而是安全吸收无法交付的数据，防止 DMA
写入无效地址或覆盖应用所有权下的 Buffer。写入 dummy 的帧随后被丢弃。

### 10.3 驱动和应用各自应做什么

驱动侧：

- 永远遵守 Buffer 所有权；
- 无真实 Buffer 时切 dummy，而不是复用未 QBUF 的 Buffer；
- 记录 frame loss、overflow 或 sequence 信息；
- 新 Buffer 到达后恢复真实地址；
- STREAMOFF 时把所有 ACTIVE/QUEUED Buffer 归还 VB2。

应用侧：

- DQBUF 后尽快完成消费并 QBUF；
- 实时预览优先处理最新帧，避免建立无界软件队列；
- 需要长期持有帧时增加合理 Buffer 数，或复制到自己的存储域；
- 使用 sequence 和 timestamp 监控丢帧、抖动和延迟。

驱动不应该擅自决定应用究竟要“低延迟预览”还是“每帧必达”。它提供安全、可观测的队列
语义，具体业务策略由用户态选择。

## 11. 正确实现 STREAMOFF 和释放

### 11.1 stop 回调必须归还所有 Buffer

```c
/**
 * @brief 停止 RKISP capture，并把驱动持有的 Buffer 归还 VB2。
 * @param queue 正在停止的 VB2 queue。
 */
static void rkisp_stop_streaming(struct vb2_queue *queue)
{
    struct rkisp_stream *stream = queue->drv_priv;

    /* 先阻止硬件继续写入 Buffer，并等待停止边界生效。 */
    rkisp_stream_stop(stream);

    /* 再关闭上游 pipeline，避免 Sensor 继续向已停止接收端送数据。 */
    rkisp_pipeline_set_stream(stream, false);

    /*
     * 将 curr_buf、next_buf 和 buf_queue 中的全部 Buffer 以 ERROR 归还。
     * 这是停止清理状态，不表示每块内存本身已经损坏。
     */
    rkisp_return_all_buffers(stream, VB2_BUF_STATE_ERROR);

    rkisp_destroy_dummy_buf(stream);
}
```

正确顺序的原则是：先保证 DMA 不再访问，再归还 Buffer。若先 `vb2_buffer_done()`、后停 MI，
应用可能立即获得并改写一块硬件仍在使用的内存。


### 11.2 `STREAMOFF` 不等于释放内存

```text
VIDIOC_STREAMOFF
  -> 停止硬件
  -> 所有权回到 VB2/应用
  -> Buffer allocation 仍存在
  -> mmap 和 DMA-BUF fd 仍可能存在
```

这使应用可以重新 QBUF 并再次 STREAMON，而不必每次重建全部 Buffer。

真正销毁 MMAP pool 的典型顺序是：

```text
停止所有下游 DMA 使用
  -> 解除 DRM/RGA 等 importer 引用
  -> close EXPBUF 得到的 DMA-BUF fd
  -> munmap 用户虚拟地址
  -> VIDIOC_REQBUFS(count=0)
  -> close video fd
```

如果仍有 mmap 或外部 DMA-BUF 引用，memory backend 可能无法立即回收底层 pages。驱动开发
时应把这种情况当成引用生命周期问题，而不是简单认为 `REQBUFS(count=0)` 一定立刻释放物理
内存。

### 11.3 开流失败也必须回滚

`rkisp_start_streaming()` 如果在创建 dummy buffer、打开 power domain、配置 MI 或启动上游
subdev 时失败，必须按相反顺序清理，并把已经交给驱动的 Buffer 归还给 VB2。否则下一次
STREAMON 可能遇到：

- queue 中 Buffer 数量变少；
- 某些 Buffer 永远停在 ACTIVE；
- dummy buffer 泄漏；
- pipeline refcount 或 runtime PM 引用不平衡。

## 12. 并发、所有权与 DMA 同步

### 12.1 为什么同时需要 mutex 和 spinlock

| 锁 | 运行上下文 | 保护内容 |
| --- | --- | --- |
| `queue->lock` / `apilock` | ioctl 进程上下文 | REQBUFS、QBUF、STREAMON/OFF 等长操作 |
| `vbq_lock` | 进程与 IRQ 共享 | `buf_queue`、`curr_buf`、`next_buf` 的短临界区 |

中断上下文不能睡眠，所以 frame-end 与 `rkisp_buf_queue()` 共享的链表不能用 mutex 保护。
反过来，也不应在持有 spinlock 时执行内存分配、pipeline 开关或可能睡眠的 V4L2 subdev 调用。

### 12.2 Buffer 所有权规则

```text
应用拥有：成功 DQBUF 后，到再次 QBUF 前
VB2 拥有：负责状态检查、排队和完成队列
RKISP 拥有：buf_queue / next_buf / curr_buf 阶段
MI 使用：地址被写入硬件，到对应 frame-end 为止
```

“拥有”表示谁有权访问或改变 Buffer 状态，不代表 DDR page 在各阶段发生移动。

### 12.3 CPU 与设备同步

即使没有整帧 memcpy，也存在 CPU cache 和 DMA 可见性问题：

- capture 前，memory backend 要让设备获得正确 DMA mapping；
- capture 后，CPU 或其他设备访问前需要完成相应同步；
- DMA-BUF importer 必须遵守 attachment、map/unmap 和 fence/同步约定；
- 应用在 Buffer 尚未 DQBUF 时不能靠 mmap 地址偷读正在 DMA 的内容。

如果图像偶发出现旧数据或局部撕裂，应先检查所有权和 cache/DMA 同步，而不是立刻怀疑
Sensor 寄存器。

## 13. 从 ioctl 到硬件的完整调用链

### 13.1 分配与映射

```text
VIDIOC_REQBUFS
  -> VB2 校验 type/memory/queue state
  -> rkisp_queue_setup()
  -> mem_ops->alloc()

VIDIOC_QUERYBUF
  -> VB2 返回 index、plane length 和 mmap offset

mmap
  -> vb2_fop_mmap()
  -> mem_ops->mmap()

VIDIOC_EXPBUF
  -> VB2 定位 MMAP plane
  -> mem_ops->get_dmabuf()
  -> dma_buf_fd()
```

### 13.2 排队与开流

```text
VIDIOC_QBUF × 4
  -> VB2 校验 plane 和状态
  -> Buffer 进入 VB2 queued 状态

VIDIOC_STREAMON
  -> VB2 将已排队 Buffer 逐个交给 rkisp_buf_queue()
  -> rkisp_start_streaming()
  -> 创建 dummy buffer
  -> 配置 MI 和第一批 DMA 地址
  -> 启动 RKISP pipeline 与上游 subdev
```

### 13.3 每帧循环

```text
MI frame-end IRQ
  -> rkisp_mi_v21_isr()
  -> mi_frame_end()
  -> 填写 payload / sequence / timestamp
  -> vb2_buffer_done(DONE)
  -> VB2 唤醒 poll/DQBUF

VIDIOC_DQBUF
  -> 应用取得 Buffer 所有权
  -> 消费同一 mmap/DMA-BUF memory object

VIDIOC_QBUF
  -> 所有权再次交给驱动
  -> rkisp_buf_queue()
  -> 等待成为 next_buf/curr_buf
```





