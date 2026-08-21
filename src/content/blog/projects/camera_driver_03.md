---
title: 'Camera 驱动开发（三）：IMX415 Mode、时序与 Controls'
description: '在 rk3568 平台上为 IMX415 Sensor 编写驱动程序'
series: { id: 'camera-driver', order: 3 }
tags: ['Camera', 'Linux', 'V4L2', '图像处理']
pubDate: 'Jun 26 2026'
---

## 本篇要解决的问题

上一篇已经能够让驱动识别出IMX415并注册 V4L2 subdev。本阶段要把临时固定格式改造成真正的 Sensor mode 数据模型，并建立时序和 controls。

开发完成后，驱动应能够：

```text
描述 3864x2192 RAW10 30 FPS mode
  -> 枚举和选择 media-bus format
  -> 报告 4 Lane CSI-2 link frequency 和 pixel rate
  -> 报告 3840x2160 有效裁剪区域
  -> 创建 HBLANK/VBLANK/EXPOSURE/GAIN/FLIP controls
  -> 把 control 数值转换为 IMX415 寄存器值
```

本阶段仍不实现完整 `.s_stream()` 调用链。寄存器表会准备好，但真正写表和退出 standby 放在之后的内容里。

## 建立mode 参数表

| 参数 | 线性 RAW10 mode |
| --- | --- |
| Sensor 输出尺寸 | 3864x2192 |
| ISP 有效裁剪尺寸 | 3840x2160 |
| Media-bus code | `MEDIA_BUS_FMT_SGBRG10_1X10` |
| Bits per sample | 10 |
| CSI-2 lanes | 4 |
| CSI-2 virtual channel | VC0 |
| Link frequency | 446 MHz |
| Lane bit rate | 约 892 Mbit/s/Lane |
| HMAX | 1100 timing clocks |
| VMAX | 2250 lines |
| Sensor timing clock | 74.25 MHz |
| Frame interval | 1/30 s |
| SHR0 default | 8 lines |

## 区分三个时钟/速率概念

### Sensor 行、帧时序

当前 mode 的实际寄存器值为：

```text
HMAX = 0x044c = 1100
VMAX = 0x0008ca = 2250
```
以 74.25 MHz timing clock 计算：

```text
line_time = HMAX / 74.25 MHz
          = 1100 / 74,250,000
          ≈ 14.8148 us

frame_time = VMAX * line_time
           = 2250 * 14.8148 us
           ≈ 33.333 ms

frame_rate = 1 / frame_time
           ≈ 30 FPS
```

### CSI-2 link frequency 与 lane bit rate

CSI-2 使用 DDR，因此每个 clock 周期传输两个 bit：

```text
lane_bit_rate = link_frequency * 2
              = 446 MHz * 2
              = 892 Mbit/s/Lane
```

寄存器表名称中的 `891M` 指接近 891/892 Mbit/s 的 lane data rate；V4L2 `V4L2_CID_LINK_FREQ` 报告的是约一半的 446 MHz clock frequency。

### V4L2 pixel rate
Linux 4.19 的 CSI-2 文档给出：

```text
pixel_rate = link_frequency * 2 * lanes / bits_per_sample
           = 446,000,000 * 2 * 4 / 10
           = 356,800,000 samples/s
```

它描述 CSI-2 链路的样本传输率。当前 active image 需要：

```text
3864 * 2192 * 30 = 254,096,640 samples/s
```

因此链路容量足以传输 RAW10 active data，并为 CSI-2 包开销留出空间。

### 不要混用时钟域

vendor 驱动定义：

```text
hts_def = HMAX * 4 lanes * 2 = 1100 * 8 = 8800
V4L2 pixel_rate = 356.8 MHz
```

不能直接计算：

```text
356.8 MHz / 8800 / 2250
```

因为这里的 pixel rate 来自 CSI-2 payload domain，而 HMAX/VMAX 来自 Sensor timing domain。使用 `hts_def=8800` 计算 30 FPS 时，对应的 timing pixel rate 是：

```text
74.25 MHz * 8 = 594 MHz
594 MHz / 8800 / 2250 = 30 FPS
```

驱动开发时必须分别保存并标注这些数值的物理含义，不能仅因单位都写成 Hz 就混在同一个公式中。

## 实现通用的寄存器写入
```c
/**
 * imx415_write_u8 - Write one byte to an IMX415 register.
 * @client: IMX415 I2C client.
 * @reg: 16-bit Sensor register address.
 * @value: 8-bit value to write.
 *
 * Return: 0 on success, or a negative errno value on failure.
 */
static int imx415_write_u8(struct i2c_client *client, u16 reg, u8 value)
{
    /* 发送 2-byte 寄存器地址和 1-byte 数据。 */
    u8 buffer[3] = { reg >> 8, reg & 0xff, value };
    int ret;

    /* 把完整写事务发送到 client->addr。 */
    ret = i2c_master_send(client, buffer, sizeof(buffer));
    if (ret < 0)
        return ret;

    /* 发送长度不完整也视为 I/O 错误。 */
    if (ret != sizeof(buffer))
        return -EIO;

    return 0;
}
```

### 寄存器表写入


```c
#define IMX415_REG_END 0xffff

struct imx415_reg {
    u16 address;
    u8 value;
};

/**
 * imx415_write_table - Write a sentinel-terminated register table.
 * @sensor: IMX415 private driver state.
 * @table: Register table ending with IMX415_REG_END.
 *
 * Return: 0 on success, or the first I2C error.
 */
static int imx415_write_table(struct imx415 *sensor,
                              const struct imx415_reg *table)
{
    unsigned int i;
    int ret;

    /* 按表中顺序逐项写入，遇到结束标记停止。 */
    for (i = 0; table[i].address != IMX415_REG_END; ++i) {
        ret = imx415_write_u8(sensor->client,
                              table[i].address,
                              table[i].value);
        if (ret)
            return ret;
    }

    return 0;
}
```

返回第一个错误，不使用 `ret |= write()` 合并多个 errno；第一个失败寄存器最有排查价值。

### 组织 global 与 mode 寄存器表

建议将寄存器分成两类：

```text
global table
  -> 与 RAW10 基础工作方式和 Sensor 公共模拟设置相关

mode table
  -> 与分辨率、HMAX、VMAX、位深和 MIPI rate 相关
```

下面只展示有明确含义的代表项。正式源文件必须使用经过厂商验证的完整表，不能省略未公开含义但硬件要求保留的寄存器。具体可以去看imx415的datasheet。

```c
/* RAW10 公共初始化表；正式代码中应放入完整厂商表。 */
static const struct imx415_reg imx415_global_raw10[] = {
    { 0x3002, 0x00 }, /* 采用正常 master 工作配置。 */
    { 0x3031, 0x00 }, /* 选择 10-bit ADC/output 设置。 */
    { 0x3032, 0x00 }, /* 配合设置 RAW10 输出。 */
    { IMX415_REG_END, 0x00 }, /* 结束标记，不写入 Sensor。 */
};

/* 3864x2192、RAW10、线性 30 FPS 的 mode 表。 */
static const struct imx415_reg imx415_3864x2192_raw10[] = {
    { 0x3020, 0x00 }, /* 使用全分辨率读出方式。 */
    { 0x3021, 0x00 }, /* 配合设置读出模式。 */
    { 0x3022, 0x00 }, /* 配合设置读出模式。 */

    { 0x3024, 0xca }, /* VMAX[7:0]，VMAX=0x08ca=2250。 */
    { 0x3025, 0x08 }, /* VMAX[15:8]。 */
    { 0x3026, 0x00 }, /* VMAX[19:16]。 */

    { 0x3028, 0x4c }, /* HMAX[7:0]，HMAX=0x044c=1100。 */
    { 0x3029, 0x04 }, /* HMAX[15:8]。 */

    { 0x3050, 0x08 }, /* SHR0[7:0]，默认 SHR0=8。 */
    { 0x3051, 0x00 }, /* SHR0[15:8]。 */
    { 0x3052, 0x00 }, /* SHR0[19:16]。 */

    { 0x30cf, 0x00 }, /* 选择线性而非 DOL HDR 输出。 */
    { 0x3260, 0x01 }, /* 线性模式要求的配套设置。 */
    { IMX415_REG_END, 0x00 },
};
```

## 定义 mode 数据模型

### Mode 结构体


```c
struct imx415_mode {
    /* Sensor source pad 输出的 Bayer media-bus code。 */
    u32 code;

    /* Sensor 原始输出尺寸，包含后续需要裁剪的边缘区域。 */
    u32 width;
    u32 height;

    /* V4L2 报告的帧间隔，例如 1/30 秒。 */
    struct v4l2_fract frame_interval;

    /* V4L2 HBLANK 计算使用的 line length。 */
    u32 hts;

    /* Sensor 默认 frame length，在线性模式下对应 VMAX。 */
    u32 vts;

    /* 默认曝光行数，而不是 SHR0 寄存器值。 */
    u32 exposure_default;

    /* link_freq_menu[] 中的索引。 */
    unsigned int link_freq_index;

    /* 当前 Bayer sample 的有效 bit 数。 */
    unsigned int bits_per_sample;

    /* 公共初始化表和当前 mode 专用表。 */
    const struct imx415_reg *global_table;
    const struct imx415_reg *mode_table;
};
```

### 单一线性 mode


```c
#define IMX415_NUM_LANES 4
#define IMX415_VTS_MAX   0x7fff

static const s64 imx415_link_freq_menu[] = {
    297000000,
    446000000,
    743000000,
    891000000,
};

static const struct imx415_mode imx415_modes[] = {
    {
        /* Sensor 输出 SGBRG 排列的 10-bit Bayer。 */
        .code = MEDIA_BUS_FMT_SGBRG10_1X10,

        /* 使用 Sensor 的完整 3864x2192 输出。 */
        .width = 3864,
        .height = 2192,

        /* numerator/denominator 表示 10000/300000=1/30 秒。 */
        .frame_interval = {
            .numerator = 10000,
            .denominator = 300000,
        },

        /* HMAX 1100 转换为 vendor V4L2 line-length 单位。 */
        .hts = 0x044c * IMX415_NUM_LANES * 2,

        /* VMAX=2250 lines。 */
        .vts = 0x08ca,

        /* SHR0 默认 8，因此曝光行为 VMAX-8=2242。 */
        .exposure_default = 0x08ca - 8,

        /* 选择菜单中的 446 MHz。 */
        .link_freq_index = 1,
        .bits_per_sample = 10,

        /* streaming 时先写 global，再写 mode。 */
        .global_table = imx415_global_raw10,
        .mode_table = imx415_3864x2192_raw10,
    },
};
```

开发初期先只保留一个确认可工作的 mode。单 mode 完整通过后，再添加 RAW12、HDR 或 1920x1080 binning。

## 扩展私有结构体

在上一篇的`struct imx415`中添加：

```c
struct imx415 {
    /* 已有的 client、power、subdev、mutex 等成员。 */

    /* 当前 ACTIVE format 选择的 mode。 */
    const struct imx415_mode *current_mode;

    /* 当前有效 VTS，VBLANK 改变时同步更新。 */
    u32 current_vts;

    /* 管理全部 V4L2 controls。 */
    struct v4l2_ctrl_handler ctrl_handler;

    /* 保存需要互相修改范围或更新值的 control 指针。 */
    struct v4l2_ctrl *link_freq;
    struct v4l2_ctrl *pixel_rate;
    struct v4l2_ctrl *hblank;
    struct v4l2_ctrl *vblank;
    struct v4l2_ctrl *exposure;
    struct v4l2_ctrl *analogue_gain;
};
```
probe 在初始化 controls 前设置默认 mode：

```c
/* 单 mode 阶段默认选择第 0 项。 */
sensor->current_mode = &imx415_modes[0];
sensor->current_vts = sensor->current_mode->vts;
```

## 实现格式枚举和选择

### 枚举 mode


```c
static int imx415_enum_frame_size(
    struct v4l2_subdev *sd,
    struct v4l2_subdev_pad_config *cfg,
    struct v4l2_subdev_frame_size_enum *size)
{
    const struct imx415_mode *mode;

    /* index 超过 mode 数量时表示枚举结束。 */
    if (size->index >= ARRAY_SIZE(imx415_modes))
        return -EINVAL;

    mode = &imx415_modes[size->index];

    /* 调用者的 code 必须与该 mode 匹配。 */
    if (size->code != mode->code)
        return -EINVAL;

    /* 每个 mode 只支持一个固定尺寸。 */
    size->min_width = mode->width;
    size->max_width = mode->width;
    size->min_height = mode->height;
    size->max_height = mode->height;
    return 0;
}


static int imx415_enum_frame_interval(
    struct v4l2_subdev *sd,
    struct v4l2_subdev_pad_config *cfg,
    struct v4l2_subdev_frame_interval_enum *interval)
{
    const struct imx415_mode *mode;

    /* 每个 index 对应 mode 表中的一项。 */
    if (interval->index >= ARRAY_SIZE(imx415_modes))
        return -EINVAL;

    mode = &imx415_modes[interval->index];
    interval->code = mode->code;
    interval->width = mode->width;
    interval->height = mode->height;
    interval->interval = mode->frame_interval;
    return 0;
}
```

### 选择最接近的 mode

```c
static const struct imx415_mode *imx415_find_mode(
    const struct v4l2_mbus_framefmt *requested)
{
    const struct imx415_mode *best = &imx415_modes[0];
    unsigned int best_distance = UINT_MAX;
    unsigned int i;

    /* 在 code 相同的 mode 中寻找分辨率距离最小的一项。 */
    for (i = 0; i < ARRAY_SIZE(imx415_modes); ++i) {
        const struct imx415_mode *mode = &imx415_modes[i];
        unsigned int distance;

        if (mode->code != requested->code)
            continue;

        distance = abs((int)mode->width - (int)requested->width) +
                   abs((int)mode->height - (int)requested->height);
        if (distance < best_distance) {
            best = mode;
            best_distance = distance;
        }
    }

    return best;
}
```

### TRY format 与 ACTIVE format

```c
static int imx415_set_fmt(struct v4l2_subdev *sd,
                          struct v4l2_subdev_pad_config *cfg,
                          struct v4l2_subdev_format *format)
{
    struct imx415 *sensor = to_imx415(sd);
    const struct imx415_mode *mode;

    mutex_lock(&sensor->mutex);

    /* 把调用者请求修正为驱动真正支持的 mode。 */
    mode = imx415_find_mode(&format->format);
    format->format.code = mode->code;
    format->format.width = mode->width;
    format->format.height = mode->height;
    format->format.field = V4L2_FIELD_NONE;

    if (format->which == V4L2_SUBDEV_FORMAT_TRY) {
        /* TRY 只保存临时结果，不改变真实硬件选择。 */
        *v4l2_subdev_get_try_format(sd, cfg, format->pad) =
            format->format;
    } else {
        /* ACTIVE 更新当前 mode，供 controls 和 streaming 使用。 */
        sensor->current_mode = mode;
        sensor->current_vts = mode->vts;
    }

    mutex_unlock(&sensor->mutex);
    return 0;
}
```

ACTIVE mode 改变后还要同步更新 control range，具体放在第 10 节。

## 报告 3840x2160 有效裁剪
IMX415 输出 3864x2192，RKISP 使用中心区域：

```text
left = (3864 - 3840) / 2 = 12
top  = (2192 - 2160) / 2 = 16
crop = (12, 16) / 3840x2160
```

```c
static int imx415_get_selection(struct v4l2_subdev *sd,
                                struct v4l2_subdev_pad_config *cfg,
                                struct v4l2_subdev_selection *selection)
{
    /* 阶段 3 只实现有效裁剪边界查询。 */
    if (selection->target != V4L2_SEL_TGT_CROP_BOUNDS)
        return -EINVAL;

    /* 返回 3864x2192 中心的 3840x2160 区域。 */
    selection->r.left = 12;
    selection->r.top = 16;
    selection->r.width = 3840;
    selection->r.height = 2160;
    return 0;
}
```

`media_pad` 和 selection rectangle 都只描述拓扑/格式，不保存实际图像数据。

## 创建 V4L2 Controls

### Control 数值

当前 mode 对应：

```text
HBLANK default = HTS - width  = 8800 - 3864 = 4936 pixels
VBLANK default = VTS - height = 2250 - 2192 = 58 lines
EXPOSURE default = VTS - SHR0 = 2250 - 8 = 2242 lines
LINK_FREQ = 446,000,000 Hz
PIXEL_RATE = 356,800,000 samples/s
```

### 初始化 controls

```c
static const struct v4l2_ctrl_ops imx415_ctrl_ops;

static int imx415_init_controls(struct imx415 *sensor)
{
    const struct imx415_mode *mode = sensor->current_mode;
    struct v4l2_ctrl_handler *handler = &sensor->ctrl_handler;
    u64 pixel_rate;
    u64 pixel_rate_max;
    u32 hblank;
    u32 vblank;
    int ret;

    /* 为本阶段的八个 controls 初始化 handler。 */
    ret = v4l2_ctrl_handler_init(handler, 8);
    if (ret)
        return ret;

    /* controls 与 format/power 状态共用同一把锁。 */
    handler->lock = &sensor->mutex;

    /* 创建 CSI-2 link frequency 菜单。 */
    sensor->link_freq = v4l2_ctrl_new_int_menu(
        handler, NULL, V4L2_CID_LINK_FREQ,
        ARRAY_SIZE(imx415_link_freq_menu) - 1,
        mode->link_freq_index, imx415_link_freq_menu);

    /* 当前 mode 决定 link frequency，不允许用户单独修改。 */
    if (sensor->link_freq)
        sensor->link_freq->flags |= V4L2_CTRL_FLAG_READ_ONLY;

    /* 按 CSI-2 DDR、lane 数和 sample 位深计算链路 pixel rate。 */
    pixel_rate = imx415_link_freq_menu[mode->link_freq_index] * 2ULL *
                 IMX415_NUM_LANES / mode->bits_per_sample;

    /* 使用菜单最高频率为后续新增 mode 预留 control 范围。 */
    pixel_rate_max = imx415_link_freq_menu[
        ARRAY_SIZE(imx415_link_freq_menu) - 1] * 2ULL *
        IMX415_NUM_LANES / 10;

    /* 创建只读 pixel-rate control。 */
    sensor->pixel_rate = v4l2_ctrl_new_std(
        handler, NULL, V4L2_CID_PIXEL_RATE,
        0, pixel_rate_max, 1, pixel_rate);
    if (sensor->pixel_rate)
        sensor->pixel_rate->flags |= V4L2_CTRL_FLAG_READ_ONLY;

    /* HBLANK 由 mode 固定，不允许单独修改。 */
    hblank = mode->hts - mode->width;
    sensor->hblank = v4l2_ctrl_new_std(
        handler, NULL, V4L2_CID_HBLANK,
        hblank, hblank, 1, hblank);
    if (sensor->hblank)
        sensor->hblank->flags |= V4L2_CTRL_FLAG_READ_ONLY;

    /* VBLANK 可增大，从而增加 VMAX 并降低帧率。 */
    vblank = mode->vts - mode->height;
    sensor->vblank = v4l2_ctrl_new_std(
        handler, &imx415_ctrl_ops, V4L2_CID_VBLANK,
        vblank, IMX415_VTS_MAX - mode->height, 1, vblank);

    /* 曝光用 line 数表示，最大值必须给 SHR0 留出 8 行。 */
    sensor->exposure = v4l2_ctrl_new_std(
        handler, &imx415_ctrl_ops, V4L2_CID_EXPOSURE,
        4, mode->vts - 8, 1, mode->exposure_default);

    /* analogue gain 数值直接对应当前 vendor 寄存器编码范围。 */
    sensor->analogue_gain = v4l2_ctrl_new_std(
        handler, &imx415_ctrl_ops, V4L2_CID_ANALOGUE_GAIN,
        0, 0xf0, 1, 0);

    /* 创建水平和垂直翻转开关。 */
    v4l2_ctrl_new_std(handler, &imx415_ctrl_ops,
                      V4L2_CID_HFLIP, 0, 1, 1, 0);
    v4l2_ctrl_new_std(handler, &imx415_ctrl_ops,
                      V4L2_CID_VFLIP, 0, 1, 1, 0);

    /* 任一 control 创建失败都会记录在 handler->error。 */
    if (handler->error) {
        ret = handler->error;
        v4l2_ctrl_handler_free(handler);
        return ret;
    }

    /* 把 controls 挂到 Sensor subdev。 */
    sensor->subdev.ctrl_handler = handler;
    return 0;
}
```

## 把 Control 转换为寄存器

### 多字节时序寄存器


```c
static int imx415_write_u20(struct imx415 *sensor, u16 low_reg, u32 value)
{
    int release_ret;
    int ret;

    /* 冻结同一组时序寄存器，避免一帧中出现部分新值。 */
    ret = imx415_write_u8(sensor->client, 0x3001, 0x01);
    if (ret)
        return ret;

    /* 先写低 8 bit。 */
    ret = imx415_write_u8(sensor->client, low_reg, value & 0xff);
    if (ret)
        goto release_group_hold;

    /* 再写中间 8 bit。 */
    ret = imx415_write_u8(sensor->client, low_reg + 1,
                          (value >> 8) & 0xff);
    if (ret)
        goto release_group_hold;

    /* 最后写高 4 bit。 */
    ret = imx415_write_u8(sensor->client, low_reg + 2,
                          (value >> 16) & 0x0f);

release_group_hold:
    /* 无论中间是否失败，都必须释放 group hold。 */
    release_ret = imx415_write_u8(sensor->client, 0x3001, 0x00);
    return ret ? ret : release_ret;
}
```

对运行中的 Sensor 更新多字节时序寄存器时使用 group hold，避免一帧中只应用部分新值。

### 更新 VBLANK 和曝光范围

```c
static void imx415_update_vblank_state(struct imx415 *sensor, u32 vblank)
{
    u32 vmax;

    /* VMAX 等于 active height 加 vertical blanking。 */
    vmax = sensor->current_mode->height + vblank;
    /* 保存当前值，供曝光到 SHR0 的换算使用。 */
    sensor->current_vts = vmax;
    /* VMAX 增大后同步放宽 exposure 最大值。 */
    __v4l2_ctrl_modify_range(sensor->exposure,
                             sensor->exposure->minimum,
                             vmax - 8,
                             sensor->exposure->step,
                             sensor->exposure->default_value);
}

static int imx415_write_vmax(struct imx415 *sensor)
{
    /* VMAX 从 0x3024 开始按低字节顺序写入。 */
    return imx415_write_u20(sensor, 0x3024, sensor->current_vts);
}
```

### 曝光转换为 SHR0

线性模式关系：

```text
exposure_lines = VMAX - SHR0
SHR0 = VMAX - exposure_lines
```

```c
static int imx415_set_exposure(struct imx415 *sensor, u32 exposure)
{
    u32 shr0;

    /* V4L2 曝光行数转换为 Sensor 的 shutter start。 */
    shr0 = sensor->current_vts - exposure;

    /* SHR0 从 0x3050 开始按低字节顺序写入。 */
    return imx415_write_u20(sensor, 0x3050, shr0);
}
```

### 增益与翻转

```c
static int imx415_set_gain(struct imx415 *sensor, u32 gain)
{
    int release_ret;
    int ret;

    /* 冻结 gain 寄存器，保证两个字节同时生效。 */
    ret = imx415_write_u8(sensor->client, 0x3001, 0x01);
    if (ret)
        return ret;

    /* 增益低 8 bit 写入 0x3090。 */
    ret = imx415_write_u8(sensor->client, 0x3090, gain & 0xff);
    if (ret)
        goto release_group_hold;

    /* 增益高位写入 0x3091。 */
    ret = imx415_write_u8(sensor->client, 0x3091,
                          (gain >> 8) & 0x07);

release_group_hold:
    /* 无论写入是否失败，都释放 group hold。 */
    release_ret = imx415_write_u8(sensor->client, 0x3001, 0x00);
    return ret ? ret : release_ret;
}

static int imx415_set_flip(struct imx415 *sensor,
                           bool horizontal, bool enabled)
{
    u8 value;
    u8 mask = horizontal ? BIT(0) : BIT(1);
    int ret;

    /* 先读取共享的 mirror/flip 寄存器。 */
    ret = imx415_read_u8(sensor->client, 0x3030, &value);
    if (ret)
        return ret;

    /* 只修改目标 bit，保留另一个翻转方向。 */
    if (enabled)
        value |= mask;
    else
        value &= ~mask;

    return imx415_write_u8(sensor->client, 0x3030, value);
}
```

### Control 回调

```c
static int imx415_set_ctrl(struct v4l2_ctrl *ctrl)
{
    struct imx415 *sensor = container_of(
        ctrl->handler, struct imx415, ctrl_handler);
    struct device *dev = &sensor->client->dev;
    int ret = 0;

    /* VBLANK 即使在休眠时也要先更新缓存和 exposure 范围。 */
    if (ctrl->id == V4L2_CID_VBLANK)
        imx415_update_vblank_state(sensor, ctrl->val);

    /* Sensor 未上电时只缓存 control 值，不进行 I2C 写入。 */
    if (!pm_runtime_get_if_in_use(dev))
        return 0;

    /* 根据 control ID 调用对应的寄存器转换函数。 */
    switch (ctrl->id) {
    case V4L2_CID_VBLANK:
        ret = imx415_write_vmax(sensor);
        break;
    case V4L2_CID_EXPOSURE:
        ret = imx415_set_exposure(sensor, ctrl->val);
        break;
    case V4L2_CID_ANALOGUE_GAIN:
        ret = imx415_set_gain(sensor, ctrl->val);
        break;
    case V4L2_CID_HFLIP:
        ret = imx415_set_flip(sensor, true, ctrl->val);
        break;
    case V4L2_CID_VFLIP:
        ret = imx415_set_flip(sensor, false, ctrl->val);
        break;
    default:
        ret = -EINVAL;
        break;
    }

    /* 与成功的 get_if_in_use() 成对释放 PM 引用。 */
    pm_runtime_put(dev);
    return ret;
}

static const struct v4l2_ctrl_ops imx415_ctrl_ops = {
    /* 所有可写 controls 共用同一个回调入口。 */
    .s_ctrl = imx415_set_ctrl,
};
```

回调取得 PM 引用后不能在 switch 分支中直接 return，否则会泄漏 runtime PM usage count。

## Mode 改变时同步 Controls

```c
static void imx415_update_controls(struct imx415 *sensor,
                                   const struct imx415_mode *mode)
{
    u64 pixel_rate;
    u32 hblank;
    u32 vblank;

    /* 更新只读 HBLANK。 */
    hblank = mode->hts - mode->width;
    __v4l2_ctrl_modify_range(sensor->hblank,
                             hblank, hblank, 1, hblank);

    /* 更新 VBLANK 范围并恢复该 mode 默认值。 */
    vblank = mode->vts - mode->height;
    __v4l2_ctrl_modify_range(sensor->vblank,
                             vblank,
                             IMX415_VTS_MAX - mode->height,
                             1, vblank);

    /* 选择 mode 对应的 link-frequency 菜单项。 */
    __v4l2_ctrl_s_ctrl(sensor->link_freq,
                       mode->link_freq_index);

    /* 更新 CSI-2 pixel rate。 */
    pixel_rate = imx415_link_freq_menu[mode->link_freq_index] * 2ULL *
                 IMX415_NUM_LANES / mode->bits_per_sample;
    __v4l2_ctrl_s_ctrl_int64(sensor->pixel_rate, pixel_rate);

    /* 恢复当前 mode 的 VTS 和 exposure 范围。 */
    sensor->current_vts = mode->vts;
    __v4l2_ctrl_modify_range(sensor->exposure,
                             4, mode->vts - 8, 1,
                             mode->exposure_default);
}
```

在 `imx415_set_fmt()` 的 ACTIVE 分支中调用它；TRY 分支不能改变真实 controls。

## 接入 Probe

```c
/* probe 已完成 subdev 初始化并选择默认 mode。 */
sensor->current_mode = &imx415_modes[0];
sensor->current_vts = sensor->current_mode->vts;

/* 创建并挂接 Sensor controls。 */
ret = imx415_init_controls(sensor);
if (ret)
    goto err_destroy_mutex;

/* 后续 power-on、chip ID 和 subdev 注册沿用阶段 2。 */
```

错误回滚增加：

```c
err_free_controls:
    /* 释放已经创建的全部 V4L2 controls。 */
    v4l2_ctrl_handler_free(&sensor->ctrl_handler);
err_destroy_mutex:
    mutex_destroy(&sensor->mutex);
    return ret;
```

`remove()` 中也要在销毁 mutex 前调用 `v4l2_ctrl_handler_free()`。





