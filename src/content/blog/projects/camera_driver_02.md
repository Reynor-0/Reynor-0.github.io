---
title: 'Camera 驱动开发（二）：IMX415 Probe 与上电框架'
description: '在 rk3568 平台上为 IMX415 Sensor 编写驱动程序'
series: { id: 'camera-driver', order: 2 }
tags: ['Camera', 'Linux', 'V4L2', '图像处理']
pubDate: 'Jun 26 2026'
---

## 本阶段要实现的目标

- Kconfig 和 Makefile 能选择并编译驱动。
- 上电和下电可以重复执行，不残留半上电状态。
- 能可靠读取并验证芯片 ID `0xe0`。
- 能注册一个带 source pad 的 V4L2 Camera Sensor subdev。
- runtime PM 能调用同一套 power-on/power-off 函数。

**代码规范**

RK3568 SDK 使用 Linux 4.19，编写骨架时应避免使用较新内核才提供的 API，例如`dev_err_probe()` 和 `pm_runtime_resume_and_get()`。

### 建立构建入口

**Kconfig**

在 `drivers/media/i2c/Kconfig` 增加：

```kconfig
config VIDEO_IMX415
	tristate "Sony IMX415 sensor support"
	depends on I2C && VIDEO_V4L2 && VIDEO_V4L2_SUBDEV_API
	depends on MEDIA_CAMERA_SUPPORT
	help
	  This is a Video4Linux2 sensor driver for the Sony IMX415 camera.

	  To compile this driver as a module, choose M here. The module
	  will be called imx415.
```

**Makefile**
在 `drivers/media/i2c/Makefile` 增加：

```make
obj-$(CONFIG_VIDEO_IMX415) += imx415.o
```

**验证构建系统**

先创建一个只有 module metadata 的 `imx415.c`，确认：

```text
CONFIG_VIDEO_IMX415=y -> imx415.o 被链接进内核
CONFIG_VIDEO_IMX415=m -> 生成 imx415.ko
CONFIG_VIDEO_IMX415=n -> 不参与构建
```

### `probe()`是否正确匹配

```c
// SPDX-License-Identifier: GPL-2.0

#include <linux/i2c.h>
#include <linux/module.h>

#define IMX415_NAME "imx415"

static int imx415_probe(struct i2c_client *client, const struct i2c_device_id *id)
{
    dev_info(&client->dev, "probe entered: adapter=%d address=0x%02x\n",
             client->adapter->nr, client->addr);
    return 0;
}

static int imx415_remove(struct i2c_client *client)
{
    dev_info(&client->dev, "remove\n");
    return 0;
}

static const struct of_device_id imx415_of_match[] = {
    {.compatible = "sony,imx415"},
    {/* sentinel */}
};

MODULE_DEVICE_TABLE(of, imx415_of_match);

static const struct i2c_device_id imx415_id[] = {
    { "sony,imx415", 0 },
    { /* sentinel */ }
};
MODULE_DEVICE_TABLE(i2c, imx415_id);

static struct i2c_driver imx415_i2c_driver = {
    .driver = {
        .name = IMX415_NAME,
        .of_match_table = of_match_ptr(imx415_of_match),
    },
    .probe = imx415_probe,
    .remove = imx415_remove,
    .id_table = imx415_id,
};

module_i2c_driver(imx415_i2c_driver);

MODULE_DESCRIPTION("Sony IMX415 sensor driver");
MODULE_LICENSE("GPL v2");
```

**板级验证**
日志应为：

```text
imx415 4-001a: probe entered: adapter=4 address=0x1a
```

### 设计私有状态和资源所有权

**私有结构体**

这里的“私有”不是安全或访问权限概念，而是说这份状态只由 IMX415 驱动解释。Linux 的I2C、clock、GPIO、V4L2 等框架只会把各自的通用对象或句柄交给驱动，不知道 IMX415 还需要组合哪些资源。因此驱动要为每一个 Sensor 实例建立一份上下文：


```text
一颗被匹配的 IMX415
  -> 一个 i2c_client
  -> 一份 struct imx415
       +-- 控制总线
       +-- 上下电资源
       +-- V4L2/Media 对象
       +-- 并发和软件状态
       `-- 模组描述信息
```


```c

static const char * const imx415_supply_names[] = {
    "dvdd",
    "dovdd",
    "avdd",
};

#define IMX415_NUM_SUPPLIES ARRAY_SIZE(imx415_supply_names)

struct imx415 {
    /* I2C core 为设备树节点创建的控制总线设备。 */
    struct i2c_client *client;
    /* Sensor 的 37.125 MHz 外部参考时钟句柄。 */
    struct clk *xvclk;
    /* 低有效硬件复位引脚的 GPIO descriptor。 */
    struct gpio_desc *reset_gpio;
    /* 高有效模组电源使能引脚的 GPIO descriptor。 */
    struct gpio_desc *power_gpio;
    /* DVDD、DOVDD 和 AVDD 三路 regulator consumer。 */
    struct regulator_bulk_data supplies[IMX415_NUM_SUPPLIES];
    /* 管理当前 Sensor 所使用的引脚复用状态。 */
    struct pinctrl *pinctrl;
    /* 工作状态：把对应引脚复用为 CIF_CLKOUT。 */
    struct pinctrl_state *pinctrl_default;
    /* 休眠状态：Sensor 下电时使用的引脚配置。 */
    struct pinctrl_state *pins_sleep;
    /* IMX415 在 V4L2 框架中的 sub-device 对象。 */
    struct v4l2_subdev subdev;
    /* Sensor 唯一的图像输出 pad。 */
    struct media_pad source_pad;
    /* 保护电源状态；后续还会保护 mode、controls 和 streaming。 */
    struct mutex mutex;
    /* 记录 .s_power 是否持有一份 runtime PM 引用。 */
    bool power_on;
    /* Rockchip 模组编号，用于生成稳定的 entity 名称。 */
    u32 module_index;
    /* 模组朝向，例如 "back" 或 "front"。 */
    const char *module_facing;
    /* Sensor 模组名称，不等同于芯片型号。 */
    const char *module_name;
    /* 镜头模组名称。 */
    const char *lens_name;
};

#define to_imx415(sd) container_of(sd, struct imx415, subdev)
```

### 解析模组属性

```c
static int imx415_parse_module_info(struct imx415 *sensor)
{
    /*拿到i2c客户端设备*/
    struct device *dev = &sensor->client->dev;
    /*dev->of_node指向的是创建该device的device tree节点*/
    struct device_node *node = dev->of_node;
    int ret;

    if (!node) 
    {
        dev_err(dev, "device-tree node is missing\n");
        return -ENODEV;
    }

    ret = of_property_read_u32(node, RKMODULE_CAMERA_MODULE_INDEX, &sensor->module_index);
    if(ret) return ret;

    ret = of_property_read_string(node, RKMODULE_CAMERA_MODULE_FACING, &sensor->module_facing);
    if(ret) return ret;

    ret = of_property_read_string(node, RKMODULE_CAMERA_MODULE_NAME, &sensor->module_name);
    if(ret) return ret;

    ret = of_property_read_string(node, RKMODULE_LENS_NAME, &sensor->lens_name);
    return ret;
}
```

### 获取硬件资源

下面骨架使用 Linux 4.19 可用的 API，并保留 `-EPROBE_DEFER`：

```c
static int imx415_get_resources(struct imx415 *sensor)
{
    /* 所有 devm 资源都绑定到这颗 Sensor 的 Linux device。 */
    struct device *dev = &sensor->client->dev;
    uint8_t i = 0;
    int ret = 0;

    sensor->xvclk = devm_clk_get(dev, "xvclk");
    if (IS_ERR(sensor->xvclk))
    {
        dev_err(dev, "failed to get xvclk: %d\n", ret);
        return PTR_ERR(sensor->xvclk);
    }

    /* Logical high asserts an active-low reset line. */
    sensor->reset_gpio = devm_gpiod_get(dev, "reset", GPIOD_OUT_HIGH);
    if (IS_ERR(sensor->reset_gpio))
    {
        dev_err(dev, "failed to get reset GPIO: %d\n", ret);
        return PTR_ERR(sensor->reset_gpio);
    }
        

    /* Keep module power disabled until imx415_power_on(). */
    sensor->power_gpio = devm_gpiod_get(dev, "power", GPIOD_OUT_LOW);
    if (IS_ERR(sensor->power_gpio))
    {
        dev_err(dev, "failed to get power GPIO: %d\n", ret);
        return PTR_ERR(sensor->power_gpio);
    }
        

    sensor->pinctrl = devm_pinctrl_get(dev);
    if (IS_ERR(sensor->pinctrl))
    {
        dev_err(dev, "failed to get pinctrl: %d\n", ret);
        return PTR_ERR(sensor->pinctrl);
    }

    sensor->pins_default = pinctrl_lookup_state(
        sensor->pinctrl, "rockchip,camera_default");
    if (IS_ERR(sensor->pins_default))
    {
        dev_err(dev, "failed to get default pinctrl state: %d\n", ret);
        return PTR_ERR(sensor->pins_default);
    }

    sensor->pins_sleep = pinctrl_lookup_state(
        sensor->pinctrl, "rockchip,camera_sleep");
    if (IS_ERR(sensor->pins_sleep)) {
        dev_warn(dev, "sleep pinctrl state is unavailable\n");
        sensor->pins_sleep = NULL;
    }

    for (i = 0; i < IMX415_NUM_SUPPLIES; ++i)
        sensor->supplies[i].supply = imx415_supply_names[i];

    ret = devm_regulator_bulk_get(dev, IMX415_NUM_SUPPLIES,
                                  sensor->supplies);

    if (ret) return ret;
    return 0;
}
```
不能把所有错误改成 `-EINVAL`。例如 clock/regulator provider 尚未 probe 时会返回`-EPROBE_DEFER`，保留它才能让 driver core 稍后自动重试。

**`devm_*()`** 

`devm` 是 device-managed resource。以 `devm_clk_get()` 为例：

```text
probe 成功
  -> 句柄挂在 client->dev 的 devres 链表
  -> remove/device detach 时自动 clk_put()

probe 中途失败
  -> driver core 释放此前成功取得的 devm 句柄
```
许多内核资源获取 API 的返回类型是指针，但还需要携带详细错误码。内核使用 error pointer：

```text
成功 -> 正常内核地址，例如 0xffff...1234
失败 -> 把 -ENOENT、-EBUSY、-EPROBE_DEFER 等编码进特殊指针值
```

对应宏：

```c
IS_ERR(pointer)  /* 判断它是不是 error pointer。 */
PTR_ERR(pointer) /* 从 error pointer 还原负 errno。 */
ERR_PTR(error)   /* 把负 errno 编码成 error pointer。 */
```

所以资源获取不能只写：

```c
if (!sensor->xvclk)
```

失败值通常不是 NULL。正确模式是：

```c
sensor->xvclk = devm_clk_get(dev, "xvclk");
if (IS_ERR(sensor->xvclk))
    return PTR_ERR(sensor->xvclk);
```

**`-EPROBE_DEFER`**

Sensor probe 时，clock、GPIO、pinctrl 或 regulator provider 可能尚未完成自己的 probe。这不等于设备树永久错误。provider 可以返回：

```text
-EPROBE_DEFER -> 当前先暂停这个 consumer 的 probe，稍后自动重试
```

简要介绍一下部分用到的API：
**`devm_gpiod_get()`**

| 参数 | reset 调用 | 作用 |
| --- | --- | --- |
| `dev` | `client->dev` | GPIO consumer 所属设备 |
| `con_id` | `"reset"` | 映射到 `reset-gpios` |
| `flags` | `GPIOD_OUT_HIGH` | 请求后立即设为输出逻辑 1 |

**pinctrl 的 get、lookup 和 select**

三个动作不能混淆：

```text
devm_pinctrl_get(dev)
  -> 取得这个 device 的 pinctrl 管理句柄

pinctrl_lookup_state(pinctrl, "state-name")
  -> 找到一个预定义状态，但不切换硬件

pinctrl_select_state(pinctrl, state)
  -> 真正把对应 pinmux、pull、drive strength 应用到硬件
```

多余不再详细介绍，读者可以自己去看pinctrl子系统的源码。

### 实现可回滚的上电状态机

**先把时序写成表，再写代码**


| 顺序 | 动作 | 等待 | 失败时撤销 |
| --- | --- | --- | --- |
| 1 | 选择 default pinctrl | 无 | 选择 sleep |
| 2 | 启用三路 regulator | 无 | 关闭 regulator |
| 3 | power 写逻辑 1 | 10~20 ms | power 写逻辑 0 |
| 4 | reset 写逻辑 0，解除复位 | 10~20 ms | reset 写逻辑 1 |
| 5 | 设置并启用 37.125 MHz XVCLK | 20~30 ms | disable XVCLK |
| 6 | 允许 I2C 访问 | — | — |

#### GPIO descriptor 使用逻辑有效值


当前 DTS：

```dts
reset-gpios = <&gpio3 RK_PB6 GPIO_ACTIVE_LOW>;
power-gpios = <&gpio4 RK_PB4 GPIO_ACTIVE_HIGH>;
```

因此：

```text
gpiod_set_value_cansleep(reset, 1) -> 物理低 -> 复位有效
gpiod_set_value_cansleep(reset, 0) -> 物理高 -> 解除复位
gpiod_set_value_cansleep(power, 1) -> 物理高 -> 电源开启
gpiod_set_value_cansleep(power, 0) -> 物理低 -> 电源关闭
```

#### power-on

```c
#define IMX415_XVCLK_RATE 37125000UL

static int imx415_power_on(struct imx415 *sensor)
{
    struct device *dev = &sensor->client->dev;
    int ret;

    ret = pinctrl_select_state(sensor->pinctrl, sensor->pins_default);
    if (ret)
        return ret;
    
    ret = regulator_bulk_enable(IMX415_NUM_SUPPLIES, sensor->supplies);
    if (ret)
        goto err_select_sleep;

    gpiod_set_value_cansleep(sensor->power_gpio, 1);
    usleep_range(10000, 20000);

    gpiod_set_value_cansleep(sensor->reset_gpio, 0);
    usleep_range(10000, 20000);

    ret = clk_set_rate(sensor->xvclk, IMX415_XVCLK_RATE);
    if (ret)
        goto err_assert_reset;

    if (clk_get_rate(sensor->xvclk) != IMX415_XVCLK_RATE) {
        dev_err(dev, "xvclk rate is %lu, expected %lu\n",
                clk_get_rate(sensor->xvclk), IMX415_XVCLK_RATE);
        ret = -EINVAL;
        goto err_assert_reset;
    }

    ret = clk_prepare_enable(sensor->xvclk);
    if (ret)
        goto err_assert_reset;

    usleep_range(20000, 30000);
    return 0;

err_assert_reset:
    gpiod_set_value_cansleep(sensor->reset_gpio, 1);
    gpiod_set_value_cansleep(sensor->power_gpio, 0);
    regulator_bulk_disable(IMX415_NUM_SUPPLIES, sensor->supplies);
err_select_sleep:
    if (sensor->pins_sleep)
        pinctrl_select_state(sensor->pinctrl, sensor->pins_sleep);
    return ret;
}
```
#### power-off

```c
static void imx415_power_off(struct imx415 *sensor)
{
    gpiod_set_value_cansleep(sensor->reset_gpio, 1);
    clk_disable_unprepare(sensor->xvclk);

    if (sensor->pins_sleep)
        pinctrl_select_state(sensor->pinctrl, sensor->pins_sleep);

    gpiod_set_value_cansleep(sensor->power_gpio, 0);
    regulator_bulk_disable(IMX415_NUM_SUPPLIES, sensor->supplies);
}
```

### 实现一个8-bit寄存器读取函数

读取 chip ID,实现最小、清晰的 16-bit 地址/8-bit 数据读函数：

```c
static int imx415_read_u8_reg(struct i2c_client *client, u16 addr, u8 *val)
{
    u8 address[2] = { addr >> 8, addr & 0xFF };
    struct i2c_msg messages[2] = {
        {
            .addr = client->addr;
            .flags = 0;
            .len = sizeof(address);
            .buf = address;
        },
        {
            .addr = client->addr;
            .flags = I2C_M_RD;
            .len = sizeof(*val);
            .buf = val;
        }
    };
    int ret;

    ret = i2c_transfer(client->adapter, messages, ARRAY_SIZE(messages));
    if (ret < 0)
        return ret;
    if (ret != ARRAY_SIZE(messages))
        return -EIO;

    return 0;
}
```

总线事务为：

```text
START + slave 0x1a(W) + 0x31 + 0x1a
REPEATED START + slave 0x1a(R) + one byte + STOP
```

`0x1a` 是 I2C 从设备地址，`0x311a` 是 Sensor 内部寄存器地址。

#### chip ID 检测

```c
#define IMX415_CHIP_ID_REG 0x311a
#define IMX415_CHIP_ID  0xe0

static int imx415_check_chip_id(struct imx415 *sensor)
{
    struct device *dev = &sensor->client->dev;
    u8 chip_id;
    int ret;

    ret = imx415_read_u8_reg(sensor->client, IMX415_CHIP_ID_REG, &chip_id);
    if (ret)
    {
        dev_err(dev, "failed to read chip ID: %d\n", ret);
        return ret;
    }

     if (chip_id != IMX415_CHIP_ID) {
        dev_err(dev, "unexpected chip ID 0x%02x\n", chip_id);
        return -ENODEV;
    }

    dev_info(dev, "detected IMX415, chip ID 0x%02x\n", chip_id);
    return 0;

```

区分：

- I2C transfer 失败：返回 `-EREMOTEIO`、`-EIO` 等原始通信错误。
- I2C 成功但 ID 不符：返回 `-ENODEV`。

### 注册最小V4L2 Sensor Subdev

本阶段创建：

```text
IMX415 V4L2 subdev
  entity function = MEDIA_ENT_F_CAM_SENSOR
  pad0 = MEDIA_PAD_FL_SOURCE
```

#### 提供固定的总线信息

```c
static int imx415_get_mbus_config(struct v4l2_subdev *sd, struct v4l2_mbus_config *config)
{
    /* 指定 Sensor 使用 MIPI CSI-2 总线。 */
    config->type = V4L2_MBUS_CSI2;
    /* 指定 4 Lane、VC0 和连续时钟模式。 */
    config->flags = V4L2_MBUS_CSI2_4_LANE |
                    V4L2_MBUS_CSI2_CHANNEL_0 |
                    V4L2_MBUS_CSI2_CONTINUOUS_CLOCK;
    return 0;
}
```
这段代码只说明物理接口是 four-lane CSI-2、VC0、continuous clock，不会让 Sensor 开始
发送像素。

#### 给 pad 提供临时固定格式


```text
MEDIA_BUS_FMT_SGBRG10_1X10
3864x2192
```

```c
#define IMX415_STAGE2_WIDTH  3864
#define IMX415_STAGE2_HEIGHT 2192


static int imx415_enum_mbus_code(struct v4l2_subdev *sd,
                                 struct v4l2_subdev_pad_config *cfg,
                                 struct v4l2_subdev_mbus_code_enum *code)
{
    /* 只有 pad0，并且只支持 index 0 这一种格式。 */
    if (code->pad != 0 || code->index != 0)
        return -EINVAL;
    /* 返回 10-bit SGBRG Bayer 格式。 */
    code->code = MEDIA_BUS_FMT_SGBRG10_1X10;
    return 0;
}

static int imx415_get_fmt(struct v4l2_subdev *sd,
                          struct v4l2_subdev_pad_config *cfg,
                          struct v4l2_subdev_format *format)
{
    /* Sensor 只有 pad0。 */
    if (format->pad != 0)
        return -EINVAL;
    /* 填写 Bayer 排列和每像素位数。 */
    format->format.code = MEDIA_BUS_FMT_SGBRG10_1X10;
    /* 填写阶段 2 使用的固定输出尺寸。 */
    format->format.width = IMX415_STAGE2_WIDTH;
    format->format.height = IMX415_STAGE2_HEIGHT;
    /* Sensor 输出逐行扫描图像，不使用隔行场。 */
    format->format.field = V4L2_FIELD_NONE;
    return 0;
}

static int imx415_set_fmt(struct v4l2_subdev *sd,
                          struct v4l2_subdev_pad_config *cfg,
                          struct v4l2_subdev_format *format)
{
    return imx415_get_fmt(sd, cfg, format);
}
```
这只是 bring-up 骨架。之后会将其替换成`supported_modes[]`、TRY/ACTIVE format处理和 mode 选择，不能把临时固定值当作完整 Sensor 驱动。

#### 组合 subdev ops

```c
/* 定义 Sensor 的 video 类回调。 */
static const struct v4l2_subdev_video_ops imx415_video_ops = {
    /* 上游通过该回调查询 CSI-2 物理总线配置。 */
    .g_mbus_config = imx415_get_mbus_config,
};

/* 定义 Sensor source pad 的格式类回调。 */
static const struct v4l2_subdev_pad_ops imx415_pad_ops = {
    /* 枚举支持的 media-bus code。 */
    .enum_mbus_code = imx415_enum_mbus_code,

    /* 读取当前 pad 格式。 */
    .get_fmt = imx415_get_fmt,

    /* 选择或修正 pad 格式。 */
    .set_fmt = imx415_set_fmt,
};

/* 把不同类别的回调表组合成完整 subdev ops。 */
static const struct v4l2_subdev_ops imx415_subdev_ops = {
    .video = &imx415_video_ops,
    .pad = &imx415_pad_ops,
};
```

### 初始化 entity 并异步注册

```c
static int imx415_register_subdev(struct imx415 *sensor)
{
    /* 取得内嵌的 V4L2 subdev，缩短后续表达式。 */
    struct v4l2_subdev *sd = &sensor->subdev;
    /* 保存 entity 名称中的前/后摄缩写。 */
    const char *facing;
    int ret;
    /* 允许 V4L2 core 为该 subdev 创建设备节点。 */
    sd->flags |= V4L2_SUBDEV_FL_HAS_DEVNODE;
    /* IMX415 的 pad0 只负责向 D-PHY 输出图像。 */
    sensor->source_pad.flags = MEDIA_PAD_FL_SOURCE;
    /* 将该 media entity 标记为 Camera Sensor。 */
    sd->entity.function = MEDIA_ENT_F_CAM_SENSOR;
    /* 为 Sensor entity 注册一个 source pad。 */
    ret = media_entity_pads_init(&sd->entity, 1, &sensor->source_pad);
    if (ret)
        return ret;
    /* 将设备树中的 back/front 转成 entity 名称使用的 b/f。 */
    facing = !strcmp(sensor->module_facing, "back") ? "b" : "f";
    /* 生成可在 media-ctl 中识别的 Sensor entity 名称。 */
    snprintf(sd->name, sizeof(sd->name), "m%02u_%s_imx415 %s",
             sensor->module_index, facing, dev_name(&sensor->client->dev));
    /* 注册 Sensor，等待 D-PHY/RKISP 通过 async notifier 与它绑定。 */
    ret = v4l2_async_register_subdev_sensor_common(sd);
    if (ret) {
        /* async 注册失败时撤销已经初始化的 media entity。 */
        media_entity_cleanup(&sd->entity);
        return ret;
    }

    /* Sensor subdev 注册完成。 */
    return 0;
}
```
`v4l2_async_register_subdev_sensor_common()` 的价值不是“立刻产生 `/dev/video0`”，而是把Sensor 放入 async framework。D-PHY/RKISP notifier 可以在它们各自 probe 完成后建立 link。

`/dev/v4l-subdevN` 的 N 取决于注册顺序。用户态若需要找到 IMX415，应查询 media graph 或entity name，不能永久写死 `/dev/v4l-subdev3`。

### 接入 runtime PM

不要在 power-on 还未单独验证时就加入 runtime PM，否则自动 suspend/resume 会让波形和日志难以判断。

#### PM 回调只调用已经验证的电源函数

```c
static int imx415_runtime_resume(struct device *dev)
{
    struct i2c_client *client = to_i2c_client(dev);
    struct v4l2_subdev *sd = i2c_get_clientdata(client);
    struct imx415 *sensor = to_imx415(sd);

    return imx_power_on(sensor);
}

static int imx415_runtime_suspend(struct device *dev)
{
    struct i2c_client *client = to_i2c_client(dev);
    struct v4l2_subdev *sd = i2c_get_clientdata(client);
    struct imx415 *sensor = to_imx415(sd);

    imx415_power_off(sensor);
    return 0;
}

static const struct dev_pm_ops imx415_pm_ops = {
    SET_RUNTIME_PM_OPS(imx415_runtime_suspend,
                       imx415_runtime_resume,
                       NULL)
};
```
再把 `.pm = &imx415_pm_ops` 放入 `i2c_driver.driver`。

#### `.s_power` 使用 PM 引用计数


```c
static int imx415_s_power(struct v4l2_subdev *sd, int on)
{
    struct imx415 *sensor = to_imx415(sd);
    struct device *dev = &sensor->client->dev;
    int ret = 0;

    mutex_lock(&sensor->mutex);

    on = !!on;
    if (sensor->power_on == on)
        goto out_unlock;

    if (on) {
        ret = pm_runtime_get_sync(dev);
        if (ret < 0) {
            pm_runtime_put_noidle(dev);
            goto out_unlock;
        }
        sensor->power_on = true;
    } else {
        pm_runtime_put(dev);
        sensor->power_on = false;
    }

    ret = 0;

out_unlock:
    mutex_unlock(&sensor->mutex);
    return ret;
}
```

然后加入 core ops：

```c
static const struct v4l2_subdev_core_ops imx415_core_ops = {
    .s_power = imx415_s_power,
};

static const struct v4l2_subdev_ops imx415_subdev_ops = {
    .core = &imx415_core_ops,
    .video = &imx415_video_ops,
    .pad = &imx415_pad_ops,
};
```

`power_on` bool 防止同一调用者重复 get/put，但真正决定硬件是否允许 suspend 的是 runtime
PM usage count。后续 `.s_stream()` 还会持有自己的 PM 引用。

### 最后的完整`probe`函数

```c
static int imx415_probe(struct i2c_client *client)
{
    struct device *dev = &client->dev;
    struct imx415 *sensor = NULL;
    int ret = 0;

    /* 为当前 Sensor 分配一份自动释放的私有结构体。 */
    sensor = devm_kzalloc(dev, sizeof(*sensor), GFP_KERNEL);
    if (!sensor)
        return -ENOMEM;
    /* 保存 I2C client，供后续寄存器访问和资源查询使用。 */
    sensor->client = client;
    /* 从设备树读取模组编号、朝向、模组名称和镜头名称。 */
    ret = imx415_parse_module_info(sensor);
    if (ret) {
        dev_err(dev, "failed to parse module information: %d\n", ret);
        return ret;
    }
    /* 取得 clock、GPIO、pinctrl 和 regulator 等硬件资源。 */
    ret = imx415_get_resources(sensor);
    if (ret) {
        dev_err(dev, "failed to acquire hardware resources: %d\n", ret);
        return ret;
    }
    /* 初始化用于保护电源和后续运行状态的互斥锁。 */
    mutex_init(&sensor->mutex);
    /* 初始化 V4L2 subdev，并把它与 I2C client 关联。 */
    v4l2_i2c_subdev_init(&sensor->subdev, client, &imx415_subdev_ops);
    /* 按硬件时序给 Sensor 上电并解除复位。 */
    ret = imx415_power_on(sensor);
    if (ret) {
        dev_err(dev, "failed to power on sensor: %d\n", ret);
        goto err_destroy_mutex;
    }
    /* 读取 chip ID，确认 I2C 设备确实是 IMX415。 */
    ret = imx415_check_chip_id(sensor);
    if (ret)
        goto err_power_off;
    /* 注册 Sensor entity、source pad 和异步 V4L2 subdev。 */
    ret = imx415_register_subdev(sensor);
    if (ret) {
        dev_err(dev, "failed to register V4L2 subdev: %d\n", ret);
        goto err_power_off;
    }
    /* 告诉 runtime PM 当前硬件已经由 probe 手动上电。 */
    pm_runtime_set_active(dev);
    /* 启用该 Sensor 的 runtime PM 管理。 */
    pm_runtime_enable(dev);
    /* probe 完成后允许 PM core 在空闲时执行下电。 */
    pm_runtime_idle(dev);
    /* 所有初始化步骤均已完成。 */
    dev_info(dev, "probe completed\n");
    return 0;

err_power_off:
    /* chip ID 或 subdev 注册失败：撤销已经完成的上电。 */
    imx415_power_off(sensor);
err_destroy_mutex:
    /* 销毁已经初始化的互斥锁并返回原始错误码。 */
    mutex_destroy(&sensor->mutex);
    return ret;
}
```

### `remove()` 和错误回滚按生命周期反向执行

```c
static int imx415_remove(struct i2c_client *client)
{
    struct v4l2_subdev *sd = i2c_get_clientdata(client);
    struct imx415 *sensor = to_imx415(sd);

    v4l2_async_unregister_subdev(sd);
    media_entity_cleanup(&sd->entity);

    pm_runtime_disable(&client->dev);
    if (!pm_runtime_status_suspended(&client->dev))
        imx415_power_off(sensor);
    pm_runtime_set_suspended(&client->dev);

    mutex_destroy(&sensor->mutex);
    return 0;
}
```

生命周期关系为：

```text
probe:  mutex -> power -> entity -> async register -> PM enable
remove: async unregister -> entity cleanup -> PM disable/power off -> mutex
```

规则很简单：只回收已经成功创建的对象，并以相反顺序回收。



