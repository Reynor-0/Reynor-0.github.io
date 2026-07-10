---
title: 'IMX415 驱动学习'
description: '学习整理Linux项目中关于IMX415驱动'
pubDate: 'Jul 09 2026'
---

# IMX415

代码来源 https://git.kernel.org/pub/scm/linux/kernel/git/torvalds/linux.git

## 头文件与宏定义部分

```c
#include <linux/clk.h>                                        //获取和控制 sensor 外部输入时钟                                        
#include <linux/gpio/consumer.h>                              //控制 reset GPIO                           
#include <linux/i2c.h>                                        //sensor 通过 I2C 配置寄存器               
#include <linux/pm_runtime.h>                                 //runtime PM，上电/下电管理                       
#include <linux/regmap.h>                                     //寄存器访问抽象                   
#include <linux/regulator/consumer.h>                         //电源 regulator 管理                               

#include <media/v4l2-cci.h>                                   //Camera Control Interface 寄存器读写                   
#include <media/v4l2-ctrls.h>                                 //V4L2 controls，例如曝光、增益、翻转                       
#include <media/v4l2-fwnode.h>                                //解析设备树 endpoint / MIPI CSI-2 配置                       
#include <media/v4l2-subdev.h>                                //V4L2 sub-device 框架                          
```

```c
#define IMX415_MODE          CCI_REG8(0x3000)                  //控制 standby / operating       
#define IMX415_XMSTA         CCI_REG8(0x3002)                  //控制 streaming start / stop 
#define IMX415_VMAX          CCI_REG24_LE(0x3024)              //控制一帧总行数，影响帧率和曝光上限     
#define IMX415_HMAX          CCI_REG16_LE(0x3028)              //控制一行长度，影响行周期     
#define IMX415_SHR0          CCI_REG24_LE(0x3050)              //控制曝光     
#define IMX415_GAIN_PCG_0    CCI_REG16_LE(0x3090)              //控制模拟增益     
#define IMX415_SENSOR_INFO   CCI_REG16_LE(0x3f12)              //读取芯片 ID
```

这里的 CCI_REG8、CCI_REG16_LE、CCI_REG24_LE 表示寄存器宽度和大小端格式，方便后面用 cci_read() / cci_write() 统一读写寄存器。

## 电源

```c
static const char *const imx415_supply_names[] = {
    "dvdd",
    "ovdd",
    "avdd",
};
```

与设备树中的电源配置相呼应
```dts
dvdd-supply = <&...>;
ovdd-supply = <&...>;
avdd-supply = <&...>;
```

这三个电源可以理解为digital core 电源、I/O 电源、analog 电源。

## Link Frequency
```c
static const s64 link_freq_menu_items[] = {
    594000000 / 2,
    720000000 / 2,
    891000000 / 2,
    1440000000 / 2,
    1485000000 / 2,
};
```
Linus也标注了 IMX415 的 datasheet 使用 lane rate来描述 MIPI CSI-2速率，而 v4l2 用Link Frequency 来描述。这个驱动内部尽量使用 lane rate，需要给 V4L2 时再除以 2。

## 时钟参数表

```c
struct imx415_clk_params {
	u64 lane_rate;
	u64 inck;
	struct cci_reg_sequence regs[IMX415_NUM_CLK_PARAM_REGS];
};

static const struct imx415_clk_params imx415_clk_params[] = {
	{
		.lane_rate = 594000000UL,
		.inck = 27000000,
		.regs[0] = { IMX415_BCWAIT_TIME, 0x05D },
		.regs[1] = { IMX415_CPWAIT_TIME, 0x042 },
		.regs[2] = { IMX415_SYS_MODE, 0x7 },
		.regs[3] = { IMX415_INCKSEL1, 0x00 },
		.regs[4] = { IMX415_INCKSEL2, 0x23 },
		.regs[5] = { IMX415_INCKSEL3, 0x084 },
		.regs[6] = { IMX415_INCKSEL4, 0x0E7 },
		.regs[7] = { IMX415_INCKSEL5, 0x23 },
		.regs[8] = { IMX415_INCKSEL6, 0x0 },
		.regs[9] = { IMX415_INCKSEL7, 0x1 },
		.regs[10] = { IMX415_TXCLKESC_FREQ, 0x06C0 },
	},
	{
		.lane_rate = 594000000UL,
		.inck = 37125000,
		.regs[0] = { IMX415_BCWAIT_TIME, 0x07F },
		.regs[1] = { IMX415_CPWAIT_TIME, 0x05B },
		.regs[2] = { IMX415_SYS_MODE, 0x7 },
		.regs[3] = { IMX415_INCKSEL1, 0x00 },
		.regs[4] = { IMX415_INCKSEL2, 0x24 },
		.regs[5] = { IMX415_INCKSEL3, 0x080 },
		.regs[6] = { IMX415_INCKSEL4, 0x0E0 },
		.regs[7] = { IMX415_INCKSEL5, 0x24 },
		.regs[8] = { IMX415_INCKSEL6, 0x0 },
		.regs[9] = { IMX415_INCKSEL7, 0x1 },
		.regs[10] = { IMX415_TXCLKESC_FREQ, 0x0984 },
	},
    /*  后面还有很多中配置受限于篇幅原因就不粘贴了*/
}

```

imx415_clk_params 结构体由以下三个成员：
- lane_rate：MIPI 每条 lane 的数据速率
- inck：sensor 外部输入时钟
- regs：该 lane_rate + inck 组合下需要写入的寄存器序列

而imx415_clk_params[]用来适配多种输入时钟和 MIPI lane rate 组合。例如：
- lane_rate = 720 Mbps, inck = 24 MHz
- lane_rate = 891 Mbps, inck = 27 MHz
- lane_rate = 1440 Mbps, inck = 72 MHz

这部分根据设备树中的 link-frequencies 和实际 clk_get_rate() 得到的外部输入时钟，选择一组正确的 sensor PLL / MIPI timing / escape clock 配置。如果这里匹配不到，驱动后面会报：
```text
no valid sensor mode defined
Mode x not supported
```

## MIPI 时序表和 supported_modes

代码中有几组 MIPI CSI-2 时序配置表：
```c
imx415_linkrate_720mbps[]
imx415_linkrate_1440mbps[]
imx415_linkrate_891mbps[]
```

这些表配置的是 MIPI D-PHY 时序参数，例如：
- TCLKPOST
- TCLKPREPARE
- TCLKTRAIL
- TCLKZERO
- THSPREPARE
- THSZERO
- THSTRAIL
- THSEXIT
- TLPX

这些参数影响 sensor MIPI 输出信号的时序。如果配置不对，常见现象是：
- sensor 能 probe 成功
- I2C 能读写
- 但是 CSI 接收不到帧
- 或者出现 CRC/ECC error
- 或者 stream on 后没有图像

supported_modes[] 描述驱动当前支持的 sensor 输出模式：
```c
struct imx415_mode {
	u64 lane_rate;
	u32 hmax_min[2];
	struct imx415_mode_reg_list reg_list;
};
```
该结构体有三个成员
- lane_rate：该模式需要的 MIPI lane rate
- hmax_min：不同 lane 数下的最小 HMAX
- reg_list：该模式对应的 MIPI 时序寄存器表

该驱动代码主要通过lane rate来区分不同mode，主要有720 Mbps, 1440Mbps, 891Mbps

## struct imx415

```c
struct imx415 {
    struct device *dev;
    struct clk *clk;
    unsigned long pixel_rate;
    struct regulator_bulk_data supplies[...];
    struct gpio_desc *reset;
    struct regmap *regmap;

    const struct imx415_clk_params *clk_params;

    struct v4l2_subdev subdev;
    struct media_pad pad;

    struct v4l2_ctrl_handler ctrls;
    struct v4l2_ctrl *vblank;
    struct v4l2_ctrl *hblank;
    struct v4l2_ctrl *hflip;
    struct v4l2_ctrl *vflip;
    struct v4l2_ctrl *exposure;

    unsigned int cur_mode;
    unsigned int num_data_lanes;
};
```

dev指针描述

## imx415_init_table

imx415_init_table[] 是一组 sensor 上电后需要写入的固定寄存器：
```c
static const struct cci_reg_sequence imx415_init_table[] = {
    { IMX415_WINMODE, 0x00 },
    { IMX415_ADDMODE, 0x00 },
    { IMX415_REVERSE, 0x00 },
    { IMX415_ADBIT, 0x00 },
    { IMX415_MDBIT, 0x00 },
    ...
};
```
Linus 注释了前面三个寄存器配置为"all-pixel readout" "no flip"，后面两个用来配置为"RAW 10-bit"，在后面的一些寄存器被称作"SONY MAGIC REGISTERS"寄存器，应该就需要阅读有关摄像头的datasheet了。

## to_imx415：从 subdev 找回私有结构体

```c
static inline struct imx415 *to_imx415(struct v4l2_subdev *sd)
{
    return container_of(sd, struct imx415, subdev);
}
```
这是 Linux 内核里常见写法。因为 V4L2 框架回调函数经常只给一个：
```c
struct v4l2_subdev *sd
```
但驱动真正需要的是：
```c
struct imx415 *sensor
```
所以用 container_of() 根据成员 subdev 的地址反推出整个 struct imx415 的地址。

## 测试图控制

```c
static int imx415_set_testpattern(struct imx415 *sensor, int val)
{
	int ret = 0;

	if (val) {
		cci_write(sensor->regmap, IMX415_BLKLEVEL, 0x00, &ret);
		cci_write(sensor->regmap, IMX415_TPG_EN_DUOUT, 0x01, &ret);
		cci_write(sensor->regmap, IMX415_TPG_PATSEL_DUOUT,
			  val - 1, &ret);
		cci_write(sensor->regmap, IMX415_TPG_COLORWIDTH, 0x01, &ret);
		cci_write(sensor->regmap, IMX415_TESTCLKEN_MIPI, 0x20, &ret);
		cci_write(sensor->regmap, IMX415_DIG_CLP_MODE, 0x00, &ret);
		cci_write(sensor->regmap, IMX415_WRJ_OPEN, 0x00, &ret);
	} else {
		cci_write(sensor->regmap, IMX415_BLKLEVEL,
			  IMX415_BLKLEVEL_DEFAULT, &ret);
		cci_write(sensor->regmap, IMX415_TPG_EN_DUOUT, 0x00, &ret);
		cci_write(sensor->regmap, IMX415_TESTCLKEN_MIPI, 0x00, &ret);
		cci_write(sensor->regmap, IMX415_DIG_CLP_MODE, 0x01, &ret);
		cci_write(sensor->regmap, IMX415_WRJ_OPEN, 0x01, &ret);
	}
	return 0;
}
```

当val不等于0的时候，设置黑电平为0，打开测试图生成器，选择测试图案，设置COLORWIDTH，打开MIPI测试时钟，关闭digital clip，而当val等于0的时候恢复默认黑电平，关闭 test pattern，关闭 test clock，恢复正常输出路径。
当调camer bring up的时候，假如真实镜头没有画面，可以先打开sensor test pattern，假如test pattern能够出来，说明sensor -> CSI -> ISP的数据链路大体上是没什么问题的, 如果test pattern也出不来，优先查找MIPI / CSI / format / lane的配置。
但这里Linus将返回值直接写成0不知道为什么。

## V4L2 controls：imx415_s_ctrl

```c
static int imx415_s_ctrl(struct v4l2_ctrl *ctrl)
{
	struct imx415 *sensor = container_of(ctrl->handler, struct imx415,
					     ctrls);
	const struct v4l2_mbus_framefmt *format;
	struct v4l2_subdev_state *state;
	u32 exposure_max;
	unsigned int vmax;
	unsigned int flip;
	int ret;

	state = v4l2_subdev_get_locked_active_state(&sensor->subdev);
	format = v4l2_subdev_state_get_format(state, 0);

	if (ctrl->id == V4L2_CID_VBLANK) {
		exposure_max = format->height + ctrl->val -
			       IMX415_EXPOSURE_OFFSET;
		__v4l2_ctrl_modify_range(sensor->exposure,
					 sensor->exposure->minimum,
					 exposure_max, sensor->exposure->step,
					 sensor->exposure->default_value);
	}

	if (!pm_runtime_get_if_in_use(sensor->dev))
		return 0;

	switch (ctrl->id) {
	case V4L2_CID_VBLANK:
		ret = cci_write(sensor->regmap, IMX415_VMAX,
				format->height + ctrl->val, NULL);
		if (ret)
			return ret;
		/*
		 * Exposure is set based on VMAX which has just changed, so
		 * program exposure register as well
		 */
		ctrl = sensor->exposure;
		fallthrough;
	case V4L2_CID_EXPOSURE:
		/* clamp the exposure value to VMAX. */
		vmax = format->height + sensor->vblank->cur.val;
		ctrl->val = min_t(int, ctrl->val, vmax);
		ret = cci_write(sensor->regmap, IMX415_SHR0,
				vmax - ctrl->val, NULL);
		break;

	case V4L2_CID_ANALOGUE_GAIN:
		/* analogue gain in 0.3 dB step size */
		ret = cci_write(sensor->regmap, IMX415_GAIN_PCG_0,
				ctrl->val, NULL);
		break;

	case V4L2_CID_HFLIP:
	case V4L2_CID_VFLIP:
		flip = (sensor->hflip->val << IMX415_HREVERSE_SHIFT) |
		       (sensor->vflip->val << IMX415_VREVERSE_SHIFT);
		ret = cci_write(sensor->regmap, IMX415_REVERSE, flip, NULL);
		break;

	case V4L2_CID_TEST_PATTERN:
		ret = imx415_set_testpattern(sensor, ctrl->val);
		break;

	case V4L2_CID_HBLANK:
		ret = cci_write(sensor->regmap, IMX415_HMAX,
				(format->width + ctrl->val) /
						IMX415_HMAX_MULTIPLIER,
				NULL);
		break;

	default:
		ret = -EINVAL;
		break;
	}

	pm_runtime_put(sensor->dev);

	return ret;
}
```

这里的操作有：
```text
V4L2_CID_VBLANK
V4L2_CID_EXPOSURE
V4L2_CID_ANALOGUE_GAIN
V4L2_CID_HFLIP
V4L2_CID_VFLIP
V4L2_CID_TEST_PATTERN
V4L2_CID_HBLANK
```

## imx415_ctrls_init

```c
static int imx415_ctrls_init(struct imx415 *sensor)
{
	struct v4l2_fwnode_device_properties props;
	struct v4l2_ctrl *ctrl;
	const struct imx415_mode *cur_mode = &supported_modes[sensor->cur_mode];
	u64 lane_rate = cur_mode->lane_rate;
	u32 exposure_max = IMX415_PIXEL_ARRAY_HEIGHT +
			   IMX415_PIXEL_ARRAY_VBLANK -
			   IMX415_EXPOSURE_OFFSET;
	u32 hblank_min, hblank_max;
	unsigned int i;
	int ret;

	ret = v4l2_fwnode_device_parse(sensor->dev, &props);
	if (ret < 0)
		return ret;

	v4l2_ctrl_handler_init(&sensor->ctrls, 10);

	for (i = 0; i < ARRAY_SIZE(link_freq_menu_items); ++i) {
		if (lane_rate == link_freq_menu_items[i] * 2)
			break;
	}
	if (i == ARRAY_SIZE(link_freq_menu_items)) {
		return dev_err_probe(sensor->dev, -EINVAL,
				     "lane rate %llu not supported\n",
				     lane_rate);
	}

	ctrl = v4l2_ctrl_new_int_menu(&sensor->ctrls, &imx415_ctrl_ops,
				      V4L2_CID_LINK_FREQ,
				      ARRAY_SIZE(link_freq_menu_items) - 1, i,
				      link_freq_menu_items);

	if (ctrl)
		ctrl->flags |= V4L2_CTRL_FLAG_READ_ONLY;

	sensor->exposure = v4l2_ctrl_new_std(&sensor->ctrls, &imx415_ctrl_ops,
					     V4L2_CID_EXPOSURE, 4,
					     exposure_max, 1, exposure_max);

	v4l2_ctrl_new_std(&sensor->ctrls, &imx415_ctrl_ops,
			  V4L2_CID_ANALOGUE_GAIN, IMX415_AGAIN_MIN,
			  IMX415_AGAIN_MAX, IMX415_AGAIN_STEP,
			  IMX415_AGAIN_MIN);

	hblank_min = (cur_mode->hmax_min[sensor->num_data_lanes == 2 ? 0 : 1] *
		      IMX415_HMAX_MULTIPLIER) - IMX415_PIXEL_ARRAY_WIDTH;
	hblank_max = (IMX415_HMAX_MAX * IMX415_HMAX_MULTIPLIER) -
		     IMX415_PIXEL_ARRAY_WIDTH;
	ctrl = v4l2_ctrl_new_std(&sensor->ctrls, &imx415_ctrl_ops,
				 V4L2_CID_HBLANK, hblank_min,
				 hblank_max, IMX415_HMAX_MULTIPLIER,
				 hblank_min);

	sensor->vblank = v4l2_ctrl_new_std(&sensor->ctrls, &imx415_ctrl_ops,
					   V4L2_CID_VBLANK,
					   IMX415_PIXEL_ARRAY_VBLANK,
					   IMX415_VMAX_MAX - IMX415_PIXEL_ARRAY_HEIGHT,
					   1, IMX415_PIXEL_ARRAY_VBLANK);

	v4l2_ctrl_new_std(&sensor->ctrls, NULL, V4L2_CID_PIXEL_RATE,
			  sensor->pixel_rate, sensor->pixel_rate, 1,
			  sensor->pixel_rate);

	sensor->hflip = v4l2_ctrl_new_std(&sensor->ctrls, &imx415_ctrl_ops,
					  V4L2_CID_HFLIP, 0, 1, 1, 0);
	sensor->vflip = v4l2_ctrl_new_std(&sensor->ctrls, &imx415_ctrl_ops,
					  V4L2_CID_VFLIP, 0, 1, 1, 0);

	v4l2_ctrl_new_std_menu_items(&sensor->ctrls, &imx415_ctrl_ops,
				     V4L2_CID_TEST_PATTERN,
				     ARRAY_SIZE(imx415_test_pattern_menu) - 1,
				     0, 0, imx415_test_pattern_menu);

	v4l2_ctrl_new_fwnode_properties(&sensor->ctrls, &imx415_ctrl_ops,
					&props);

	if (sensor->ctrls.error) {
		dev_err_probe(sensor->dev, sensor->ctrls.error,
			      "failed to add controls\n");
		v4l2_ctrl_handler_free(&sensor->ctrls);
		return sensor->ctrls.error;
	}
	sensor->subdev.ctrl_handler = &sensor->ctrls;

	return 0;
}
```

该函数让用户态可以通过v4l2-ctl 查询和设置 sensor 参数。例如
```bash
v4l2-ctl -d /dev/v4l-subdevX --list-ctrls
v4l2-ctl -d /dev/v4l-subdevX --set-ctrl exposure=1000
v4l2-ctl -d /dev/v4l-subdevX --set-ctrl analogue_gain=20
v4l2-ctl -d /dev/v4l-subdevX --set-ctrl test_pattern=1
```

## 模式设置

### imx415_set_mode
```c
static int imx415_set_mode(struct imx415 *sensor, int mode)
```
该函数检查mode是否有效，写入supported_modes[mode] 对应的 MIPI 时序寄存器，写入当前 clk_params 对应的 INCK/PLL/时钟相关寄存器，根据 num_data_lanes 配置 2 lane 或 4 lane。
涉及到的关键函数有：
```c
cci_multi_reg_write(sensor->regmap,
                    supported_modes[mode].reg_list.regs,
                    supported_modes[mode].reg_list.num_of_regs,
                    &ret);

cci_multi_reg_write(sensor->regmap,
                    sensor->clk_params->regs,
                    IMX415_NUM_CLK_PARAM_REGS,
                    &ret);

cci_write(sensor->regmap, IMX415_LANEMODE,
          sensor->num_data_lanes == 2 ? IMX415_LANEMODE_2 :
                                        IMX415_LANEMODE_4,
          NULL);
```

也就是通过设备树解析出来的配置，把sensor配置到正确的输出模式

### imx415_setup
```c
static int imx415_setup(struct imx415 *sensor, struct v4l2_subdev_state *state)
```
该函数先写固定初始化表imx415_init_table，然后调用imx415_set_mode(sensor, sensor->cur_mode)

## stream on/off：开始和停止出图

### imx415_wakeup
```c
static int imx415_wakeup(struct imx415 *sensor)
```

它把 sensor 从 standby 切到 operating：
```c
cci_write(sensor->regmap, IMX415_MODE, IMX415_MODE_OPERATING, NULL);
msleep(80);
```
Linus说datasheet里面说至少等63us，但实际上30ms都可能不够，所以驱动等待80ms，该sensor从standby到可通信/可输出需要较长的时间。


### imx415_stream_on
```c
static int imx415_stream_on(struct imx415 *sensor)
{
	int ret;

	ret = imx415_wakeup(sensor);                    // 唤醒
	return cci_write(sensor->regmap, IMX415_XMSTA,  //  写 IMX415_XMSTA_START，sensor 开始输出MIPI数据流
			 IMX415_XMSTA_START, &ret);
}
```

### imx415_stream_off
```c
static int imx415_stream_off(struct imx415 *sensor)
{
	int ret;

	ret = cci_write(sensor->regmap, IMX415_XMSTA,       // 写 IMX415_XMSTA_STOP，停止输出
			IMX415_XMSTA_STOP, NULL);
	return cci_write(sensor->regmap, IMX415_MODE,       // 写 IMX415_MODE_STANDBY，进入 standby
			 IMX415_MODE_STANDBY, &ret);
}
```

### imx415_s_steam

```c
static int imx415_s_stream(struct v4l2_subdev *sd, int enable)
{
	struct imx415 *sensor = to_imx415(sd);
	struct v4l2_subdev_state *state;
	int ret;

	state = v4l2_subdev_lock_and_get_active_state(sd);

	if (!enable) {
		ret = imx415_stream_off(sensor);            //停止输出

		pm_runtime_put_autosuspend(sensor->dev);    //pm_runtime_put_autosuspend 允许自动下电

		goto unlock;
	}

	ret = pm_runtime_resume_and_get(sensor->dev);   // 上电
	if (ret < 0)
		goto unlock;

	ret = imx415_setup(sensor, state);              // 写初始化和模式寄存器
	if (ret)
		goto err_pm;

	ret = __v4l2_ctrl_handler_setup(&sensor->ctrls);    // 应用 controls
	if (ret < 0)
		goto err_pm;

	ret = imx415_stream_on(sensor);                 // 开始输出
	if (ret)
		goto err_pm;

	ret = 0;

unlock:
	v4l2_subdev_unlock_state(state);

	return ret;

err_pm:
	/*
	 * In case of error, turn the power off synchronously as the device
	 * likely has no other chance to recover.
	 */
	pm_runtime_put_sync(sensor->dev);

	goto unlock;
}
```

这是 V4L2 subdev 的 .s_stream 回调，是上游 CSI/ISP 开启或关闭 sensor 数据流的入口。如果 stream on 过程中出错，它会 pm_runtime_put_sync() 同步下电，避免设备处于半初始化状态。

## V4L2 format / pad 操作

这部分决定 sensor 向外声明自己输出什么格式、什么分辨率。
```c
code->code = MEDIA_BUS_FMT_SGBRG10_1X10;
```

说明 sensor 输出：RAW Bayer 10-bit\Bayer 排列：SGBRG\每像素 10 bit。关于RAW Bayer数据，可以参考先前的文章。

imx415_set_format

```c
format->code = MEDIA_BUS_FMT_SGBRG10_1X10;
format->field = V4L2_FIELD_NONE;
format->colorspace = V4L2_COLORSPACE_RAW;
```

## subdev 操作表
代码定义了几组 ops：
```c
static const struct v4l2_subdev_video_ops imx415_subdev_video_ops = {
    .s_stream = imx415_s_stream,
};

static const struct v4l2_subdev_pad_ops imx415_subdev_pad_ops = {
    .enum_mbus_code = imx415_enum_mbus_code,
    .enum_frame_size = imx415_enum_frame_size,
    .get_fmt = v4l2_subdev_get_fmt,
    .set_fmt = imx415_set_format,
    .get_selection = imx415_get_selection,
};

static const struct v4l2_subdev_ops imx415_subdev_ops = {
    .video = &imx415_subdev_video_ops,
    .pad = &imx415_subdev_pad_ops,
};
```
它告诉 V4L2 框架视频流控制走 imx415_s_stream，格式枚举、设置、裁剪信息走 pad ops。这就是上游 CSI/ISP 驱动能和这个 sensor subdev 协商格式、开启流的原因。

## subdev 初始化：imx415_subdev_init

这个函数把 struct imx415 注册成 V4L2 subdev。

```c
static int imx415_subdev_init(struct imx415 *sensor)
{
	struct i2c_client *client = to_i2c_client(sensor->dev);
	int ret;

	v4l2_i2c_subdev_init(&sensor->subdev, client, &imx415_subdev_ops);      // v4l2_i2c_subdev_init 初始化 I2C subdev
	sensor->subdev.internal_ops = &imx415_internal_ops;                     // 设置 internal_ops

	ret = imx415_ctrls_init(sensor);                                        // 初始化 V4L2 controls
	if (ret)
		return ret;

	sensor->subdev.flags |= V4L2_SUBDEV_FL_HAS_DEVNODE;                     // 设置 V4L2_SUBDEV_FL_HAS_DEVNODE
	sensor->pad.flags = MEDIA_PAD_FL_SOURCE;                                // 配置 media pad 为 source pad
	sensor->subdev.entity.function = MEDIA_ENT_F_CAM_SENSOR;                // 设置 entity function 为 MEDIA_ENT_F_CAM_SENSOR
	ret = media_entity_pads_init(&sensor->subdev.entity, 1, &sensor->pad);  // media_entity_pads_init 初始化 media entity
	if (ret < 0) {
		v4l2_ctrl_handler_free(&sensor->ctrls);
		return ret;
	}

	sensor->subdev.state_lock = sensor->subdev.ctrl_handler->lock;
	v4l2_subdev_init_finalize(&sensor->subdev);                             // v4l2_subdev_init_finalize 完成 subdev state 初始化

	return 0;
}
```

其中
```c
sensor->pad.flags = MEDIA_PAD_FL_SOURCE;
sensor->subdev.entity.function = MEDIA_ENT_F_CAM_SENSOR;
```
这说明 IMX415 是 camera sensor entity，并且它只有一个 source pad，向外输出图像数据。它不是 /dev/videoX capture node。它通常出现在 media graph 里，可能对应：/dev/v4l-subdevX。真正的 /dev/videoX 通常由 CSI receiver 或 ISP capture driver 创建。

## 上电和下电：imx415_power_on / power_off

```c
static int imx415_power_on(struct imx415 *sensor)
{
	int ret;

	ret = regulator_bulk_enable(ARRAY_SIZE(sensor->supplies),
				    sensor->supplies);
	if (ret < 0)
		return ret;

	gpiod_set_value_cansleep(sensor->reset, 0);

	udelay(1);

	ret = clk_prepare_enable(sensor->clk);
	if (ret < 0)
		goto err_reset;

	/*
	 * Data sheet states that 20 us are required before communication start,
	 * but this doesn't work in all cases. Use 100 us to be on the safe
	 * side.
	 */
	usleep_range(100, 200);

	return 0;

err_reset:
	gpiod_set_value_cansleep(sensor->reset, 1);
	regulator_bulk_disable(ARRAY_SIZE(sensor->supplies), sensor->supplies);
	return ret;
}
``` 

上电顺序：

1. regulator_bulk_enable 打开 dvdd/ovdd/avdd
2. reset GPIO 拉到非复位状态
3. 等待 1 us
4. clk_prepare_enable 打开输入时钟
5. 等待 100~200 us

如果时钟打开失败，会回滚：重新拉 reset，关闭 regulators。

```c
static void imx415_power_off(struct imx415 *sensor)
{
	clk_disable_unprepare(sensor->clk);
	gpiod_set_value_cansleep(sensor->reset, 1);
	regulator_bulk_disable(ARRAY_SIZE(sensor->supplies), sensor->supplies);
}
```

下电顺序：

1. 关闭输入时钟
2. 拉 reset
3. 关闭电源 regulator

## 芯片识别

```c
static int imx415_identify_model(struct imx415 *sensor)
{
	int model, ret;
	u64 chip_id;

	/*
	 * While most registers can be read when the sensor is in standby, this
	 * is not the case of the sensor info register :-(
	 */
	ret = imx415_wakeup(sensor);
	if (ret)
		return dev_err_probe(sensor->dev, ret,
				     "failed to get sensor out of standby\n");

	ret = cci_read(sensor->regmap, IMX415_SENSOR_INFO, &chip_id, NULL);
	if (ret < 0) {
		dev_err_probe(sensor->dev, ret,
			      "failed to read sensor information\n");
		goto done;
	}

	model = chip_id & IMX415_SENSOR_INFO_MASK;

	switch (model) {
	case IMX415_CHIP_ID:
		dev_info(sensor->dev, "Detected IMX415 image sensor\n");
		break;
	default:
		ret = dev_err_probe(sensor->dev, -ENODEV,
				    "invalid device model 0x%04x\n", model);
		goto done;
	}

	ret = 0;

done:
	cci_write(sensor->regmap, IMX415_MODE, IMX415_MODE_STANDBY, &ret);
	return ret;
}
```

完成了以下流程：

1. 先 wakeup sensor
2. 读取 IMX415_SENSOR_INFO 寄存器
3. 用 mask 提取 chip id
4. 判断是否等于 IMX415_CHIP_ID，也就是 0x514
5. 识别完成后重新进入 standby

Linus注释了一个细节：大多数寄存器 standby 下可以读，但 sensor info register 不行，所以要先 wakeup。这就是 camera sensor probe 阶段最关键的验证：I2C 通了不代表就是正确 sensor，读取 chip ID 成功才说明驱动和硬件匹配。

## 设备树解析：

```c
static int imx415_parse_hw_config(struct imx415 *sensor)
{
	struct v4l2_fwnode_endpoint bus_cfg = {
		.bus_type = V4L2_MBUS_CSI2_DPHY,
	};
	struct fwnode_handle *ep;
	u64 lane_rate;
	unsigned long inck;
	unsigned int i, j;
	int ret;

	for (i = 0; i < ARRAY_SIZE(sensor->supplies); ++i)
		sensor->supplies[i].supply = imx415_supply_names[i];

	ret = devm_regulator_bulk_get(sensor->dev, ARRAY_SIZE(sensor->supplies),
				      sensor->supplies);
	if (ret)
		return dev_err_probe(sensor->dev, ret,
				     "failed to get supplies\n");

	sensor->reset = devm_gpiod_get_optional(sensor->dev, "reset",
						GPIOD_OUT_HIGH);
	if (IS_ERR(sensor->reset))
		return dev_err_probe(sensor->dev, PTR_ERR(sensor->reset),
				     "failed to get reset GPIO\n");

	sensor->clk = devm_v4l2_sensor_clk_get(sensor->dev, NULL);
	if (IS_ERR(sensor->clk))
		return dev_err_probe(sensor->dev, PTR_ERR(sensor->clk),
				     "failed to get clock\n");

	ep = fwnode_graph_get_next_endpoint(dev_fwnode(sensor->dev), NULL);
	if (!ep)
		return -ENXIO;

	ret = v4l2_fwnode_endpoint_alloc_parse(ep, &bus_cfg);
	fwnode_handle_put(ep);
	if (ret)
		return ret;

	switch (bus_cfg.bus.mipi_csi2.num_data_lanes) {
	case 2:
	case 4:
		sensor->num_data_lanes = bus_cfg.bus.mipi_csi2.num_data_lanes;
		break;
	default:
		ret = dev_err_probe(sensor->dev, -EINVAL,
				    "invalid number of CSI2 data lanes %d\n",
				    bus_cfg.bus.mipi_csi2.num_data_lanes);
		goto done_endpoint_free;
	}

	if (!bus_cfg.nr_of_link_frequencies) {
		ret = dev_err_probe(sensor->dev, -EINVAL,
				    "no link frequencies defined");
		goto done_endpoint_free;
	}

	/*
	 * Check if there exists a sensor mode defined for current INCK,
	 * number of lanes and given lane rates.
	 */
	inck = clk_get_rate(sensor->clk);
	for (i = 0; i < bus_cfg.nr_of_link_frequencies; ++i) {
		if (imx415_check_inck(inck, bus_cfg.link_frequencies[i])) {
			dev_dbg(sensor->dev,
				"INCK %lu Hz not supported for this link freq",
				inck);
			continue;
		}

		for (j = 0; j < ARRAY_SIZE(supported_modes); ++j) {
			if (bus_cfg.link_frequencies[i] * 2 !=
			    supported_modes[j].lane_rate)
				continue;
			sensor->cur_mode = j;
			break;
		}
		if (j < ARRAY_SIZE(supported_modes))
			break;
	}
	if (i == bus_cfg.nr_of_link_frequencies) {
		ret = dev_err_probe(sensor->dev, -EINVAL,
				    "no valid sensor mode defined\n");
		goto done_endpoint_free;
	}
	switch (inck) {
	case 27000000:
	case 37125000:
	case 74250000:
		sensor->pixel_rate = IMX415_PIXEL_RATE_74_25MHZ;
		break;
	case 24000000:
	case 72000000:
		sensor->pixel_rate = IMX415_PIXEL_RATE_72MHZ;
		break;
	}

	lane_rate = supported_modes[sensor->cur_mode].lane_rate;
	for (i = 0; i < ARRAY_SIZE(imx415_clk_params); ++i) {
		if (lane_rate == imx415_clk_params[i].lane_rate &&
		    inck == imx415_clk_params[i].inck) {
			sensor->clk_params = &imx415_clk_params[i];
			break;
		}
	}
	if (i == ARRAY_SIZE(imx415_clk_params)) {
		ret = dev_err_probe(sensor->dev, -EINVAL,
				    "Mode %d not supported\n",
				    sensor->cur_mode);
		goto done_endpoint_free;
	}

	ret = 0;
	dev_dbg(sensor->dev, "clock: %lu Hz, lane_rate: %llu bps, lanes: %d\n",
		inck, lane_rate, sensor->num_data_lanes);

done_endpoint_free:
	v4l2_fwnode_endpoint_free(&bus_cfg);

	return ret;
}
```

它从设备树里获取：

1. regulator supplies
2. reset GPIO
3. sensor input clock
4. endpoint
5. MIPI CSI-2 lane 数量
6. link-frequencies

它只接受：2或者4 lane，如果设备树里 lane 数量不是 2 或 4，会报错。

然后它检查设备树里的 link-frequencies 是否存在，没有 link frequencies 就报 no link frequencies defined

接下来根据：

sensor input clock = clk_get_rate(sensor->clk)
link_frequencies[i]
supported_modes[j]

寻找一个合法组合。匹配逻辑大致是：link_frequency × 2 == lane_rate，并且当前输入时钟 inck 在 imx415_clk_params 中有对应配置。匹配成功后设置：
```text
sensor->cur_mode
sensor->pixel_rate
sensor->clk_params
sensor->num_data_lanes
```
这说明设备树中的 link-frequencies、data-lanes 和 sensor clock 必须和驱动支持表一致，否则 probe 会失败。

## probe：整个驱动初始化入口

```c
static int imx415_probe(struct i2c_client *client)
{
	struct imx415 *sensor;
	int ret;

	sensor = devm_kzalloc(&client->dev, sizeof(*sensor), GFP_KERNEL);       // devm_kzalloc 分配 struct imx415
	if (!sensor)
		return -ENOMEM;

	sensor->dev = &client->dev;                                             // 保存 sensor->dev

	ret = imx415_parse_hw_config(sensor);                                   // imx415_parse_hw_config 解析设备树硬件信息
	if (ret)
		return ret;

	sensor->regmap = devm_cci_regmap_init_i2c(client, 16);                  // devm_cci_regmap_init_i2c 初始化 I2C regmap
	if (IS_ERR(sensor->regmap))
		return PTR_ERR(sensor->regmap);

	/*
	 * Enable power management. The driver supports runtime PM, but needs to
	 * work when runtime PM is disabled in the kernel. To that end, power
	 * the sensor on manually here, identify it, and fully initialize it.
	 */
	ret = imx415_power_on(sensor);                                          // imx415_power_on 手动上电
	if (ret)
		return ret;

	ret = imx415_identify_model(sensor);                                    // imx415_identify_model 读取 chip ID
	if (ret)
		goto err_power;

	ret = imx415_subdev_init(sensor);                                       // imx415_subdev_init 初始化 V4L2 subdev 和 controls
	if (ret)
		goto err_power;

	/*
	 * Enable runtime PM. As the device has been powered manually, mark it
	 * as active, and increase the usage count without resuming the device.
	 */
	pm_runtime_set_active(sensor->dev);                                     // 设置 runtime PM active
	pm_runtime_get_noresume(sensor->dev);                                   
	pm_runtime_enable(sensor->dev);                                         // pm_runtime_enable

	ret = v4l2_async_register_subdev_sensor(&sensor->subdev);               // v4l2_async_register_subdev_sensor 注册 sensor subdev
	if (ret < 0)
		goto err_pm;

	/*
	 * Finally, enable autosuspend and decrease the usage count. The device
	 * will get suspended after the autosuspend delay, turning the power
	 * off.
	 */
	pm_runtime_set_autosuspend_delay(sensor->dev, 1000);                    // 设置 autosuspend
	pm_runtime_use_autosuspend(sensor->dev);
	pm_runtime_put_autosuspend(sensor->dev);

	return 0;

err_pm:
	pm_runtime_disable(sensor->dev);
	pm_runtime_put_noidle(sensor->dev);
	imx415_subdev_cleanup(sensor);
err_power:
	imx415_power_off(sensor);
	return ret;
}

```

Linus 注释了驱动支持 runtime PM；但为了兼容 kernel 没开 runtime PM 的情况，probe 阶段先手动上电并完成芯片识别和初始化。
注册成功后，这个 sensor 会等待上游 CSI/ISP 驱动通过 V4L2 async framework 与它绑定成完整 media graph。

## remove
```c
static void imx415_remove(struct i2c_client *client)
```

卸载流程：

1. v4l2_async_unregister_subdev
2. 清理 media entity 和 controls
3. 关闭 runtime PM
4. 如果当前还没 suspend，就手动 power off
5. 设置 suspended 状态

## of_match 和 i2c_driver 注册


匹配表：
```c
static const struct of_device_id imx415_of_match[] = {
    { .compatible = "sony,imx415" },
    { /* sentinel */ }
};
```

这意味着设备树中应该有类似节点：
```dts
camera@1a {
    compatible = "sony,imx415";
    reg = <0x1a>;
    ...
};
```

I2C driver：
```c
static struct i2c_driver imx415_driver = {
    .probe = imx415_probe,
    .remove = imx415_remove,
    .driver = {
        .name = "imx415",
        .of_match_table = imx415_of_match,
        .pm = pm_ptr(&imx415_pm_ops),
    },
};

module_i2c_driver(imx415_driver);
```

这说明它是一个标准 Linux I2C driver。

module_i2c_driver() 会生成模块加载/卸载入口。

# 这份驱动在 camera pipeline 里的位置

这份驱动只负责 IMX415 sensor 本身。完整链路应该是：
```text
IMX415 sensor driver
    |
    | V4L2 subdev source pad
    v
MIPI CSI-2 receiver driver
    |
    v
ISP driver / capture driver
    |
    v
/dev/videoX
    |
    v
用户态 v4l2-ctl / GStreamer / OpenCV / 自己的采集程序
```

它自己通常不直接提供 /dev/video0。它提供的是：
```text
sensor subdev
media entity
source pad
RAW10 Bayer 格式
stream on/off 能力
曝光/增益/blanking/flip/test pattern controls
```

# 常见调试问题
probe 不成功

优先查：

- compatible 是否是 sony,imx415
- I2C 地址是否正确
- regulator 名称是否匹配 dvdd/ovdd/avdd
- reset GPIO 是否正确
- clock 是否提供
- endpoint 是否存在
- data-lanes 是否是 2 或 4
- link-frequencies 是否和驱动支持表匹配

chip ID 读不到，优先查：

- sensor 电源
- reset 时序
- 输入时钟
- I2C 地址
- I2C 波形
- sensor 是否真的被 wakeup

probe 成功但不出图，优先查：

- media-ctl -p 看 media graph
- MIPI data lane 数量是否正确
- link-frequency 是否正确
- CSI receiver 是否支持当前 lane rate
- RAW10 Bayer code 是否匹配
- stream on 是否真的执行
- 是否有 CSI ECC/CRC error
- 可以先打开 test pattern 验证链路

曝光或增益设置无效, 查：

- v4l2-ctl --list-ctrls
- runtime PM 下设备是否正在使用
- __v4l2_ctrl_handler_setup 是否执行
- 寄存器写入是否成功
- 当前 VMAX 是否限制了曝光最大值