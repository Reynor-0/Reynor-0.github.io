---
title: '从零编写 IMX415 驱动：从最小出图到完整 Controls 与 Runtime PM'
description: '参照 Linus 项目中的 IMX415 驱动，从 I2C 读写和最小出图开始，逐步加入 V4L2 Controls 与 Runtime PM。'
pubDate: 'Jul 10 2026'
updatedDate: 'Jul 13 2026'
heroImage: '../../assets/blog-placeholder-4.jpg'
---

## 前言

这篇文章记录的是我自己拆 IMX415 驱动时的思路。参照对象是 Linus 项目里的 `drivers/media/i2c/imx415.c`，本地对应文件是 `tmp/imx415ByLinus.c`。

我没有原样照搬这份驱动。Linus 项目中的 IMX415 驱动使用 `v4l2-cci` 和 `regmap` 访问寄存器；我想先弄明 I2C 上究竟发生了什么，所以读写寄存器这一层改成了手写 `i2c_msg`。其余部分仍然沿着那份驱动的思路，把 V4L2、Media Controller、设备树和 Runtime PM 一层层接起来。

这篇笔记只围绕一个目标展开：应用或者下游 CSI receiver 调用 `s_stream(1)` 后，IMX415 能不能开始从 MIPI CSI-2 输出 RAW10 图像数据。

## 最小出图链路

一开始我把 `probe()` 成功当成了驱动已经工作，后来才发现这只能说明内核找到了设备，还不能说明 sensor 正在吐图像。对 IMX415 来说，从设备树到一帧 RAW10 数据，中间至少要走完下面这条路：

```text
设备树创建 I2C device
  -> I2C driver probe
  -> 解析 clock / regulator / reset GPIO
  -> 上电并释放 reset
  -> 通过 I2C 读取 sensor info
  -> 解析 MIPI CSI-2 endpoint
  -> 选择 lane rate、INCK、D-PHY timing
  -> 注册 V4L2 subdev 和 media entity
  -> stream on 时写初始化表和当前 mode
  -> MODE = operating
  -> XMSTA = start
  -> IMX415 在 CSI-2 lane 上输出 RAW10
```

我把这条链路分成了五段，每一段验证的事情都不一样。

**1. 设备树和 probe：先让内核知道板子上有这颗 sensor。**

设备树提供 I2C 地址、输入时钟、三路供电、reset GPIO，以及 IMX415 和哪个 CSI receiver 相连。I2C core 根据 `compatible = "sony,imx415"` 匹配到驱动后调用 `probe()`。到这一步，内核只是为驱动建立了一个 `i2c_client`，硬件甚至可能还没上电。

**2. 上电和 I2C 识别：确认硬件真的在那里。**

打开 regulator 和输入时钟、释放 reset 之后，驱动才去读 `SENSOR_INFO`。能读到正确型号，说明电源、时钟、reset、I2C 地址和 I2C 引脚至少是通的。这一步仍然和图像数据无关。

**3. CSI-2 参数匹配：让发送端和接收端说同一种“语言”。**

CSI 是 Camera Serial Interface，`MIPI CSI-2` 是 camera sensor 常用的串行图像协议。IMX415 把一行行 RAW 像素组成 CSI-2 packet，再从 2 条或 4 条 data lane 发出。lane 是高速差分数据通道；`D-PHY` 则规定这些 lane 上的电气状态和高速切换时序。驱动要根据 endpoint 中的 lane 数和 link frequency 选择对应的 INCK、lane mode 和 D-PHY timing。参数不匹配时，I2C 仍然可以正常，但 SoC 侧可能收不到包，或者不断报 CRC、ECC 和 lane sync 错误。

**4. V4L2 subdev 和 media graph：把 sensor 放进 Linux camera pipeline。**

IMX415 不直接提供用来取帧的 `/dev/video0`，它在 V4L2 里是一个 `subdev`，也就是整条视频链路中的子设备。sensor 的 source pad 连到 CSI receiver 的 sink pad，再经过 ISP 或 DMA 到达 video node。注册 subdev 和 pad 后，下游才能查询 sensor 输出的 Bayer 顺序、位宽和尺寸。

**5. stream on：最后才真正开始发图像。**

`imx415_setup()` 先写固定初始化表、时钟和 D-PHY 参数，再下发曝光等 controls；最后让 sensor 退出 standby，启动 MIPI master。到此，图像数据才会从 IMX415 的 CSI-2 lane 进入 SoC。I2C 只负责配置寄存器，不承载图像数据。

## 私有数据结构

Linus 项目中的 IMX415 驱动把一颗 sensor 需要的资源和状态收在 `struct imx415` 里。我的版本额外保存了 `i2c_client`，因为我没有使用 `regmap`，每次读写都要自己找到 I2C adapter 和 slave address。

```c
struct imx415 {
	struct device *dev;                 /* Linux device core 对象，设备树资源、PM、日志都从这里进来 */
	struct i2c_client *client;          /* 这颗 sensor 对应的 I2C 从设备，用于 i2c_transfer() */

	struct clk *xvclk;                  /* 外部输入时钟，也就是 IMX415 文档里的 INCK */
	struct regulator *avdd;             /* 模拟电源，供给像素阵列和模拟前端 */
	struct regulator *dvdd;             /* 数字内核电源 */
	struct regulator *dovdd;            /* IO 电源，影响 I2C/MIPI 侧的 IO 电平域 */
	struct gpio_desc *reset_gpio;        /* reset 管脚，控制 sensor 是否保持复位 */

	struct v4l2_subdev sd;              /* V4L2 sub-device，供下游通过 V4L2 调用本驱动 */
	struct media_pad pads[1];           /* media graph 连接点；sensor 只有一个 source pad */

	struct v4l2_ctrl_handler ctrl_handler; /* V4L2 control 集合，例如曝光、增益、翻转 */
	struct v4l2_ctrl *vblank;           /* 垂直 blanking，影响 VMAX 和帧率 */
	struct v4l2_ctrl *hblank;           /* 水平 blanking，影响 HMAX 和行时间 */
	struct v4l2_ctrl *hflip;            /* 水平翻转 control */
	struct v4l2_ctrl *vflip;            /* 垂直翻转 control */
	struct v4l2_ctrl *exposure;         /* 曝光行数 control */
	struct v4l2_ctrl *analogue_gain;    /* 模拟增益 control */
	struct v4l2_ctrl *test_pattern;     /* sensor 内部测试图样菜单 */
	struct v4l2_ctrl *link_freq;        /* 只读 CSI-2 link frequency */
	struct v4l2_ctrl *pixel_rate_ctrl;  /* 只读像素速率 */

	const struct imx415_clk_params *clk_params; /* 当前 INCK 和 lane rate 对应的时钟寄存器表 */
	unsigned int cur_mode;              /* 当前选中的 MIPI timing mode，不是分辨率 mode */
	unsigned int num_data_lanes;         /* 设备树 endpoint 声明的 CSI-2 data lane 数 */
	unsigned long pixel_rate;            /* V4L2_CID_PIXEL_RATE 返回给用户空间的像素速率 */

	bool streaming;                      /* 软件缓存状态，用来避免重复 start/stop */
};
```

代码中的注释说明了每个成员是什么，但还需要把它们之间的关系说清楚。

`dev` 和 `client` 是整个结构的根。`client` 由 I2C core 创建，里面保存从设备树 `reg` 属性得到的 I2C 地址，以及这个 sensor 挂在哪个 I2C adapter 上。`dev` 实际上就是 `&client->dev`，它和设备树节点关联，所以 clock、regulator、GPIO、Runtime PM 和日志 API 都把它当成入口。

`xvclk`、`avdd/dvdd/dovdd` 和 `reset_gpio` 是可操作硬件的句柄，不是设备树中的数值副本。例如 `avdd` 指向 regulator framework 中的电源对象，后面通过 `regulator_enable(imx415->avdd)` 才会真正请求开启这路电源。

`sd`、`pads` 和 `ctrl_handler` 是驱动交给 V4L2 的三类信息。`sd` 保存 stream 和 pad 回调；`pads[0]` 表示 IMX415 的唯一图像输出口；`ctrl_handler` 管理曝光、增益、翻转等参数。它们一起决定了上层能在 `/dev/v4l-subdevX` 上看到什么、设置什么。

几个 `struct v4l2_ctrl *` 之所以单独保存，是因为寄存器计算需要同时查看其他 control 的当前值。例如 HFLIP 和 VFLIP 共用一个 `REVERSE` 寄存器，写任意一个时都要读另一个；VBLANK 变化后要修改 exposure 的上限，并用新 VMAX 重新计算 SHR0。`link_freq` 指针则用来在创建后追加只读 flag。如果一个 control 创建后再也不需要被驱动直接引用，也可以只让 handler 持有它，不必额外保存指针。

`clk_params`、`cur_mode`、`num_data_lanes` 和 `pixel_rate` 是 endpoint 解析后留下的选择结果。比如设备树声明 4 lane 和某个 link frequency，驱动就据此找到一组 mode 和时钟寄存器。到 stream on 时直接使用这些结果，不必再解析一遍设备树。

`streaming` 是驱动自己记录的软件状态。它不会自动跟随硬件寄存器；只有当 stream on 的所有步骤成功后才设为 `true`，stream off 或启动失败时要恢复为 `false`。

V4L2 回调里经常只能拿到 `struct v4l2_subdev *`，所以需要下面这个 helper 找回自己的私有数据：

```c
static inline struct imx415 *to_imx415(struct v4l2_subdev *sd)
{
	return container_of(sd, struct imx415, sd);
}
```

这里不是把一块内存转换成另一块内存。`sd` 本来就是 `struct imx415` 的一个成员，`container_of()` 根据 `sd` 在整个结构中的偏移，算回外层 `struct imx415` 的首地址。V4L2 在调用 pad 或 stream 回调时只传入 `v4l2_subdev *`，驱动靠这个 helper 找回 I2C、电源和当前状态。

## 手写 I2C 读写

IMX415 的寄存器地址是 16 bit，寄存器值有 8/16/24 bit 几种。读取一个 8 bit 寄存器时，我用两条 `i2c_msg`：

```c
static int imx415_read_reg(struct imx415 *imx415, u16 reg, u8 *val)
{
	struct i2c_client *client = imx415->client;
	u8 reg_buf[2] = { reg >> 8, reg & 0xff };
	struct i2c_msg msgs[] = {
		{
			.addr = client->addr,
			.flags = 0,
			.len = sizeof(reg_buf),
			.buf = reg_buf,
		},
		{
			.addr = client->addr,
			.flags = I2C_M_RD,
			.len = 1,
			.buf = val,
		},
	};
	int ret;

	ret = i2c_transfer(client->adapter, msgs, ARRAY_SIZE(msgs));
	if (ret != ARRAY_SIZE(msgs)) {
		if (ret >= 0)
			ret = -EIO;
		return ret;
	}

	return 0;
}
```

理解这段代码时，需要先把“字节”、“message”和“transfer”分开。

`i2c_msg` 描述的是一个方向不变的 I2C 阶段，里面有从设备地址、读写方向、buffer 和 buffer 长度。`i2c_transfer()` 则可以一次提交多条 message，adapter 会把它们作为一个组合事务发到总线上。

```text
msg 0: Write, payload 是两个字节：寄存器地址高字节、低字节
msg 1: Read, payload 是一个字节：寄存器值
```

所以，`msg 0` 中确实发送了两个数据字节，每个字节后面也都有自己的 ACK 时钟位；但它不是两次完整的 I2C 写操作。两个字节共享同一个 START、同一次 `slave address + Write`，中间没有 STOP，也没有再次发送从设备地址。它们只是一条 write message 里长度为 2 的 payload。

总线上的动作是：

```text
START
  -> slave address + Write
  -> reg[15:8]
  -> reg[7:0]
  -> repeated START
  -> slave address + Read
  -> data
  -> STOP
```

第一段 write 的作用不是改变寄存器内容，而是把 IMX415 内部的寄存器地址指针指到 `reg`。紧接着的 repeated START 保留了这个组合事务，同一个 slave 改成 Read 方向后，才把指定寄存器的数据读回 `val`。因此这里是两条 message，不是三条：寄存器地址的高、低字节只占用 `msg 0` 的两个 buffer 元素。

`i2c_transfer()` 返回的也不是字节数，而是成功完成的 message 数。这里完整成功应该返回 2；只完成第一条却没读到数据时，返回 1 也不能算成功。

写寄存器则简单一些，地址两个字节在前，寄存器值在后：

```c
static int imx415_write_reg_le(struct imx415 *imx415, u16 reg,
			       u32 val, u8 width)
{
	struct i2c_client *client = imx415->client;
	u8 buf[2 + sizeof(val)];
	unsigned int i;
	int ret;

	if (!width || width > sizeof(val))
		return -EINVAL;

	buf[0] = reg >> 8;
	buf[1] = reg & 0xff;
	for (i = 0; i < width; i++)
		buf[2 + i] = val >> (8 * i);

	ret = i2c_master_send(client, buf, width + 2);
	if (ret != width + 2) {
		if (ret >= 0)
			ret = -EIO;
		return ret;
	}

	return 0;
}
```

写寄存器时只有一个方向，所以 `i2c_master_send()` 就足够了。buffer 中同时出现了两种字节序：寄存器地址是高字节先发，寄存器值则按 IMX415 对该类寄存器的定义使用 little-endian。例如向 `0x3024` 写入 24 bit 值 `0x012345`，线上的 payload 是 `0x30 0x24 0x45 0x23 0x01`。前两个字节选中寄存器，后三个字节才是要写入的值。

后面的 `MODE`、`XMSTA` 都是 8-bit 寄存器。为了不在每个调用点都写 `width = 1`，我又包了一层小 helper：

```c
static int imx415_write_reg(struct imx415 *imx415, u16 reg, u8 val)
{
	return imx415_write_reg_le(imx415, reg, val, 1);
}
```

固定初始化表和 D-PHY timing 表中既有 8-bit 寄存器，也有 16/24-bit 寄存器，所以表项记录地址、值和宽度，再用一个循环顺序下发：

```c
struct imx415_reg_sequence {
	u16 reg;
	u32 val;
	u8 width;
};

static int imx415_write_reg_sequence(
	struct imx415 *imx415,
	const struct imx415_reg_sequence *regs,
	u32 num_regs)
{
	unsigned int i;
	int ret;

	for (i = 0; i < num_regs; i++) {
		ret = imx415_write_reg_le(imx415, regs[i].reg,
					  regs[i].val, regs[i].width);
		if (ret)
			return ret;
	}

	return 0;
}
```

`regs` 是表首地址，`num_regs` 是表项数量。函数按数组顺序写入，第一次 I2C 失败就停止并返回该错误。它不会自动回滚前面已经写成功的寄存器；stream on 会把失败视为整次 setup 失败，然后停流或下电，下次再从完整初始化表开始。

## 设备树资源是怎么进到驱动里的

我一开始对这里有一个疑问：`devm_clk_get(dev, "xvclk")` 只收到一个 `struct device *`，它怎么知道要去设备树的哪个节点里找 `xvclk`？

答案要从 `i2c_client` 是怎么产生的说起。

设备树里通常会有类似这样的节点：

```text
imx415: camera-sensor@1a {
	compatible = "sony,imx415";
	reg = <0x1a>;

	clocks = <&cam_clk>;
	clock-names = "xvclk";
	reset-gpios = <&gpio1 5 GPIO_ACTIVE_LOW>;

	avdd-supply = <&vcc2v8>;
	dvdd-supply = <&vcc1v1>;
	dovdd-supply = <&vcc1v8>;

	port {
		imx415_out: endpoint {
			remote-endpoint = <&csi_in>;
			data-lanes = <1 2 3 4>;
			link-frequencies = /bits/ 64 <720000000>;
		};
	};
};
```

内核在启动时先把 DTB 展开成内存里的设备树节点。I2C 控制器被注册后，I2C core 会遍历它的子节点，看到 `camera-sensor@1a` 后为它创建 `struct i2c_client`。其中：

- `client->addr` 来自 `reg = <0x1a>`；
- `client->adapter` 指向父节点对应的 I2C controller；
- `client->dev.of_node` 指向 `camera-sensor@1a` 这个设备树节点；
- `client->dev.fwnode` 是同一个固件节点的通用表示。

驱动的 `of_match_table` 中有 `sony,imx415`，driver core 将它和节点的 `compatible` 匹配起来，然后调用：

```c
static int imx415_probe(struct i2c_client *client)
```

`client` 不是驱动自己分配的，而是 I2C core 把已经和设备树绑定好的对象传进来。因此 `probe()` 中先保存这两个入口：

```c
imx415->dev = &client->dev;
imx415->client = client;
```

不是“把设备树拷贝到 `device` 里”，而是 `device` 保存了指向对应固件节点的关联。后面的资源 API 都先根据 `dev` 找到这个节点，再按名字查属性：

```c
imx415->xvclk = devm_clk_get(dev, "xvclk");
imx415->avdd = devm_regulator_get(dev, "avdd");
imx415->dvdd = devm_regulator_get(dev, "dvdd");
imx415->dovdd = devm_regulator_get(dev, "dovdd");
imx415->reset_gpio = devm_gpiod_get(dev, "reset", GPIOD_OUT_HIGH);
```

这些函数属于不同的内核子系统：`devm_clk_get()` 来自 common clock framework，`devm_regulator_get()` 来自 regulator framework，`devm_gpiod_get()` 来自 GPIO descriptor consumer API。它们的共同点是第一个参数都是当前设备。

属性名和 API 中的名字也有固定对应关系：

| 驱动调用 | 查找的设备树内容 |
|---|---|
| `devm_clk_get(dev, "xvclk")` | `clock-names` 中名为 `xvclk` 的 clock |
| `devm_regulator_get(dev, "avdd")` | `avdd-supply` |
| `devm_regulator_get(dev, "dvdd")` | `dvdd-supply` |
| `devm_regulator_get(dev, "dovdd")` | `dovdd-supply` |
| `devm_gpiod_get(dev, "reset", ...)` | `reset-gpios` |

Linus 项目中的 IMX415 驱动用 `devm_regulator_bulk_get()` 一次取得 `dvdd/ovdd/avdd`，我的学习版本将它们拆成三次 `devm_regulator_get()`，并把 I/O 电源命名为 `dovdd`。`ovdd` 和 `dovdd` 都可以用来表示 I/O supply，但驱动和设备树里的字符串必须一致：驱动查找 `dovdd` 时，设备树就提供 `dovdd-supply`；驱动查找 `ovdd` 时，设备树就提供 `ovdd-supply`。

`devm_` 表示这个句柄由 device-managed 机制管理：`probe()` 失败或设备解绑时，device core 会自动释放句柄。“拿到句柄”不等于“已经开电”。真正改变硬件状态的是 `clk_prepare_enable()`、`regulator_enable()` 和 `gpiod_set_value_cansleep()`。

`GPIOD_OUT_HIGH` 设置的是逻辑值 1。如果设备树把 reset 声明为 `GPIO_ACTIVE_LOW`，GPIO framework 会自动把逻辑 1 换成物理低电平，也就是让 sensor 保持在 reset 状态。驱动不需要自己根据 active-low 反转数值。

把这些调用放进一个函数后，资源解析的边界就很清楚：它只取句柄并检查 endpoint，不在这里开电。

```c
static int imx415_parse_dt(struct imx415 *imx415)
{
	struct device *dev = imx415->dev;

	imx415->xvclk = devm_clk_get(dev, "xvclk");
	if (IS_ERR(imx415->xvclk))
		return dev_err_probe(dev, PTR_ERR(imx415->xvclk),
				     "failed to get xvclk\n");

	imx415->avdd = devm_regulator_get(dev, "avdd");
	if (IS_ERR(imx415->avdd))
		return dev_err_probe(dev, PTR_ERR(imx415->avdd),
				     "failed to get avdd\n");

	imx415->dvdd = devm_regulator_get(dev, "dvdd");
	if (IS_ERR(imx415->dvdd))
		return dev_err_probe(dev, PTR_ERR(imx415->dvdd),
				     "failed to get dvdd\n");

	imx415->dovdd = devm_regulator_get(dev, "dovdd");
	if (IS_ERR(imx415->dovdd))
		return dev_err_probe(dev, PTR_ERR(imx415->dovdd),
				     "failed to get dovdd\n");

	imx415->reset_gpio = devm_gpiod_get(dev, "reset",
					     GPIOD_OUT_HIGH);
	if (IS_ERR(imx415->reset_gpio))
		return dev_err_probe(dev, PTR_ERR(imx415->reset_gpio),
				     "failed to get reset GPIO\n");

	return imx415_parse_endpoint(imx415);
}
```

这类 `devm_*_get()` API 失败时返回的不是 `NULL`，而是 error pointer。`IS_ERR()` 用来判断，`PTR_ERR()` 取出其中保存的负 errno。`dev_err_probe()` 接收 device、错误码和日志格式：它打印带设备上下文的错误，并原样返回错误码；遇到 `-EPROBE_DEFER` 时还会按延迟 probe 的语义处理日志。最后直接返回 `imx415_parse_endpoint()` 的结果，所以 `imx415_parse_dt()` 返回 0 同时表示本地资源句柄和 CSI-2 配置都已通过检查。

## 上电和读取型号

Linus 项目中的 IMX415 驱动用 bulk regulator 管理三路电源。它的上电次序是：开电源，释放 reset，等待 1 us，开启输入时钟，再等待 I2C 可通信。

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

	usleep_range(100, 200);
	return 0;

err_reset:
	gpiod_set_value_cansleep(sensor->reset, 1);
	regulator_bulk_disable(ARRAY_SIZE(sensor->supplies), sensor->supplies);
	return ret;
}
```

这里的等待不是为了“看起来稳妥”而随意加的。电源、reset 和 INCK 变化后，sensor 内部电路需要时间进入可通信状态。Linus 项目中的驱动注释中提到，数据手册给出的 20 us 在所有设备上并不都可靠，因此用了 `usleep_range(100, 200)`。

我的版本虽然分别保存 `avdd/dvdd/dovdd`，但错误回滚的原则相同：某一步失败时，只撤销前面已成功的步骤，并且按相反顺序关闭。这样不会在 `probe()` 失败后留下未关闭的电源或时钟。

上电完成后紧接着识别型号。这一步不能猜一个“看起来像 chip ID”的寄存器；我使用的地址和值直接来自 Linus 项目中的 IMX415 驱动：

```c
#define IMX415_SENSOR_INFO       CCI_REG16_LE(0x3f12)
#define IMX415_SENSOR_INFO_MASK  0x0fff
#define IMX415_CHIP_ID           0x0514
```

`CCI_REG16_LE(0x3f12)` 不只是一个地址宏，它还向 CCI 表明这是一个 16-bit little-endian 寄存器。因此 Linus 项目中的驱动可以用一次：

而且它先调用 `imx415_wakeup()`，因为 sensor info 这个寄存器在 standby 下不一定能读：

```c
ret = imx415_wakeup(sensor);
if (ret)
	return ret;

ret = cci_read(sensor->regmap, IMX415_SENSOR_INFO, &chip_id, NULL);
if (ret)
	goto enter_standby;

model = chip_id & IMX415_SENSOR_INFO_MASK;
```

`cci_read()` 由 V4L2 CCI helper 提供，第一个参数是寄存器映射，第二个参数同时编码了地址、宽度和字节序，第三个参数接收读回的值。成功返回 0，失败返回负的 errno。

我写的 `imx415_read_reg()` 一次只读 8 bit，也没有 CCI 寄存器宏里的宽度信息，所以要把 16-bit little-endian 值拆成两次读取：`0x3f12` 读低字节，`0x3f13` 读高字节。注意，这里的两次 `imx415_read_reg()` 是两个完整 I2C transfer；每个 transfer 内部又各自包含一条 Write message 和一条 Read message。

```c
#define IMX415_REG_MODE          0x3000
#define IMX415_MODE_OPERATING    0x00
#define IMX415_MODE_STANDBY      0x01
#define IMX415_REG_SENSOR_INFO   0x3f12
#define IMX415_SENSOR_INFO_MASK  0x0fff
#define IMX415_CHIP_ID           0x0514

static int imx415_identify_model(struct imx415 *imx415)
{
	u8 low, high;
	u16 sensor_info;
	u16 model;
	int standby_ret;
	int ret;

	ret = imx415_wakeup(imx415);
	if (ret)
		return ret;

	ret = imx415_read_reg(imx415, IMX415_REG_SENSOR_INFO, &low);
	if (ret)
		goto standby;

	ret = imx415_read_reg(imx415, IMX415_REG_SENSOR_INFO + 1, &high);
	if (ret)
		goto standby;

	sensor_info = low | ((u16)high << 8);
	model = sensor_info & IMX415_SENSOR_INFO_MASK;
	if (model != IMX415_CHIP_ID)
		ret = -ENODEV;

standby:
	standby_ret = imx415_write_reg(imx415, IMX415_REG_MODE,
					IMX415_MODE_STANDBY);
	if (!ret)
		ret = standby_ret;

	return ret;
}
```

`imx415_wakeup()` 把 `MODE` 写为 operating 并等待 80 ms。这是因为 Linus 项目中的驱动明确记录：大多数寄存器可以在 standby 下读，但 `SENSOR_INFO` 不行。读完之后，无论匹配成功还是失败，都让 sensor 回到 standby，不在 `probe()` 阶段就开始输出数据。

`sensor_info` 是 little-endian，所以组合方式是 `low | (high << 8)`。寄存器中还包含了型号以外的 bit，因此先用 `0x0fff` 取低 12 bit，再和 `0x0514` 比较。不匹配时返回 `-ENODEV`，告诉 driver core：I2C 地址上的设备不是这份驱动支持的 IMX415。

这一步成功，只能说明电源、时钟、reset、I2C 和 sensor 本体是通的。它还没有证明 MIPI lane 上有数据，也没有证明 CSI receiver 能正确解包。

## 解析 CSI endpoint

endpoint 是设备树里描述两个硬件端口如何相连的节点。它不是 IMX415 的寄存器配置，而是 PCB 连线和板级选型的描述。完整的 graph 通常会在 sensor 和 CSI receiver 两边各写一个 endpoint：

```text
imx415: camera-sensor@1a {
	port {
		imx415_out: endpoint {
			remote-endpoint = <&csi_in>;
			data-lanes = <1 2 3 4>;
			link-frequencies = /bits/ 64 <720000000>;
		};
	};
};

csi_receiver {
	port {
		csi_in: endpoint {
			remote-endpoint = <&imx415_out>;
			data-lanes = <1 2 3 4>;
		};
	};
};
```

`remote-endpoint` 把两个 endpoint 双向关联，media framework 可以据此建立 IMX415 到 CSI receiver 的图连接。`data-lanes` 表示实际布线使用的 data lane 编号；上面的 `<1 2 3 4>` 代表四条 data lane。`link-frequencies` 是 CSI-2 DDR 时钟频率，使用 64-bit 数值表示。例子中的 720 MHz 对应每条 lane 1.44 Gbit/s 的 lane rate：

```text
lane_rate = link_frequency * 2
          = 720 MHz * 2
          = 1.44 Gbit/s
```

乘 2 是因为 D-PHY 在时钟的上升沿和下降沿都传输数据。设备树可以给出多个 `link-frequencies`，驱动遍历它们，选出第一个同时满足输入时钟表和 mode 表的组合。

我在 `imx415_parse_dt()` 的最后调用 `imx415_parse_endpoint()`。核心的查找和解析如下：

```c
struct v4l2_fwnode_endpoint bus_cfg = {
	.bus_type = V4L2_MBUS_CSI2_DPHY,
};
struct fwnode_handle *ep;

ep = fwnode_graph_get_next_endpoint(dev_fwnode(sensor->dev), NULL);
ret = v4l2_fwnode_endpoint_alloc_parse(ep, &bus_cfg);
fwnode_handle_put(ep);
```

这几个函数属于 firmware-node graph API 和 V4L2 fwnode helper，它们的参数、返回值和职责分别是：

| 函数 | 接收什么 | 返回什么 | 在这里做什么 |
|---|---|---|---|
| `dev_fwnode(dev)` | `struct device *` | `struct fwnode_handle *` | 取得当前 sensor 的 firmware node；在 DT 系统上对应 `camera-sensor@1a` |
| `fwnode_graph_get_next_endpoint(parent, prev)` | 父 fwnode 和上一个 endpoint | 下一个 endpoint 的带引用指针，找不到返回 `NULL` | 取得 sensor 下的第一个 `endpoint` |
| `v4l2_fwnode_endpoint_alloc_parse(ep, bus_cfg)` | endpoint 和待填充的 V4L2 endpoint | 成功返回 0，失败返回负 errno | 把 `data-lanes`、`link-frequencies` 等 DT 属性转成 C 结构 |
| `fwnode_handle_put(ep)` | endpoint 指针 | 无 | 释放 `get_next_endpoint()` 取得的节点引用 |
| `v4l2_fwnode_endpoint_free(bus_cfg)` | 已解析的 endpoint 结构 | 无 | 释放 parser 为 link-frequency 等可变数组分配的内存 |

`fwnode_handle_put()` 和 `v4l2_fwnode_endpoint_free()` 不是一回事。前者管理 endpoint 节点的引用，后者释放解析到 `bus_cfg` 里的动态数组，成功 parse 之后两者都要处理。

通用 parser 只负责把属性变成结构，它不知道 IMX415 支持哪些组合。因此驱动还要自己做三轮检查。

**第一轮：lane 数。**

```c
switch (bus_cfg.bus.mipi_csi2.num_data_lanes) {
case 2:
case 4:
	imx415->num_data_lanes = bus_cfg.bus.mipi_csi2.num_data_lanes;
	break;
default:
	ret = -EINVAL;
	goto free_endpoint;
}
```

Linus 项目中的 IMX415 驱动只准备了 2-lane 和 4-lane 的 `LANEMODE`、HMAX 和 timing 配置，所以即使通用 parser 能读出 1 lane，驱动也必须拒绝。

**第二轮：link frequency 和输入时钟。**

```c
inck = clk_get_rate(imx415->xvclk);

for (i = 0; i < bus_cfg.nr_of_link_frequencies; i++) {
	if (imx415_check_inck(inck, bus_cfg.link_frequencies[i]))
		continue;

	/* 继续查找对应的 supported_modes[] */
}
```

`clk_get_rate()` 从 clock framework 查询当前 clock 句柄的频率，返回 `unsigned long` Hz。`imx415_check_inck()` 是驱动自己写的表查询函数，输入实际 INCK 和 endpoint link frequency，只有 `imx415_clk_params[]` 中存在对应组合时返回 0，否则返回 `-EINVAL`。

**第三轮：mode 和寄存器参数。**

```c
if (bus_cfg.link_frequencies[i] * 2 ==
    supported_modes[j].lane_rate)
	imx415->cur_mode = j;

if (imx415_clk_params[k].lane_rate == lane_rate &&
    imx415_clk_params[k].inck == inck)
	imx415->clk_params = &imx415_clk_params[k];
```

`supported_modes[]` 提供某个 lane rate 对应的 D-PHY timing 和最小 HMAX，`imx415_clk_params[]` 提供同一 lane rate 在当前 INCK 下需要写入的时钟寄存器。只有两张表都能找到匹配项，`imx415_parse_endpoint()` 才返回 0。

所以整个选择过程可以收敛为：

```text
设备树给出的 data-lanes 是 2 或 4
设备树给出了 link-frequencies
当前输入时钟 INCK 和这个 link frequency 有合法组合
supported_modes[] 里有对应 lane rate 的 D-PHY timing
imx415_clk_params[] 里有对应 INCK/lane rate 的时钟配置
```

这里的 `cur_mode` 不是常见的“4K mode”或“1080p mode”。当前文章里的输出始终是 `3864x2192 SGBRG10`，不同 mode 主要区分 lane rate、D-PHY timing 和 HMAX。endpoint 决定的不是图像尺寸，而是这帧图像以什么物理速率送出去。

## V4L2 pad 和格式协商

刚接触 V4L2 subdev 时，我把 pad format 和 exposure control 混在了一起。它们都可以从用户空间设置，但描述的是两类完全不同的事情。

`media entity` 表示 pipeline 中能处理或产生数据的部件，例如 sensor、CSI receiver 和 ISP。`pad` 是 entity 的连接点：数据从 source pad 流出，从 sink pad 流入。IMX415 只产生一路图像，因此只需要一个 source pad；CSI receiver 至少有一个连 sensor 的 sink pad，以及一个把解包数据向后传的 source pad。

```text
IMX415 source pad
  -> CSI receiver sink pad
CSI receiver source pad
  -> ISP sink pad
ISP source pad
  -> video node
```

pad format 描述的是 pad 之间传输的“总线上的像素”，不是 PNG、JPEG 这种文件格式。当前 IMX415 驱动使用：

```text
code   = MEDIA_BUS_FMT_SGBRG10_1X10
width  = 3864
height = 2192
field  = V4L2_FIELD_NONE
colorspace = V4L2_COLORSPACE_RAW
```

`SGBRG10` 表示 Bayer 阵列的空间顺序是 GB/RG，每个像素保存 10 bit 原始采样值。`1X10` 表示 media bus 上的一个 sample 宽度是 10 bit。CSI-2 在线上会再将 RAW10 打包，media-bus code 描述的是解包后的像素含义。

要让 V4L2 知道 sensor 的 pad 支持什么，我先实现下面这组 pad operations：

```c
static const struct v4l2_subdev_pad_ops imx415_subdev_pad_ops = {
	.enum_mbus_code = imx415_enum_mbus_code,
	.enum_frame_size = imx415_enum_frame_size,
	.get_fmt = v4l2_subdev_get_fmt,
	.set_fmt = imx415_set_format,
	.get_selection = imx415_get_selection,
};
```

这些函数不是一次全部调用，而是在格式枚举和设置过程中各司其职：

| 回调 | 主要输入 | 成功时填充的内容 | 意义 |
|---|---|---|---|
| `imx415_enum_mbus_code()` | `code->index` 和 pad 编号 | `code->code` | 按 index 枚举支持的 media-bus code；当前只有 index 0 |
| `imx415_enum_frame_size()` | index、pad 和 code | min/max width/height | 枚举指定 code 下的尺寸；离散尺寸用 `min == max` 表示 |
| `v4l2_subdev_get_fmt()` | subdev state 和 pad | 当前 `v4l2_mbus_framefmt` | 读取已保存的 pad format，直接复用 V4L2 通用实现 |
| `imx415_set_format()` | 用户请求的 `v4l2_subdev_format` | 驱动接受后的 format | 把最终格式写入 subdev state，返回 0 或负 errno |
| `imx415_get_selection()` | `V4L2_SEL_TGT_*` | sensor 的 crop rectangle | 返回像素阵列边界或当前 crop |

`v4l2_subdev_state` 是 V4L2 保存 pad 状态的对象。`imx415_set_format()` 通过 `v4l2_subdev_state_get_format(state, fmt->pad)` 取得指定 pad 的格式存储位置，然后填写 code、field 和 colorspace。这个回调只改软件中的格式状态，不会立即通过 I2C 修改 sensor。

Linus 项目中的这份驱动在 `enum_frame_size()` 中只枚举 `3864x2192`，但 `set_format()` 保留了请求的 width 和 height，并强制 code 为 `SGBRG10_1X10`。我在做最小出图时并不打算实现缩放或多种 window，因此硬件 setup 仍按固定像素阵列配置。如果希望接口更严格，也可以在学习版的 `set_format()` 中直接把 width/height 收敛到 `3864x2192`，但这是额外的策略选择，不是 pad API 自动做的。

`imx415_init_state()` 则在新建 subdev state 时调用 `imx415_set_format()`，把 `3864x2192` 作为默认尺寸。它通过 `v4l2_subdev_internal_ops.init_state` 挂到 subdev，不是由用户空间直接调用。

### 把 pad operations 注册进 V4L2

光定义一个 `imx415_subdev_pad_ops` 还不够，还需要把它沿着 `subdev_ops -> subdev -> media entity` 连起来：

```c
static const struct v4l2_subdev_ops imx415_subdev_ops = {
	.video = &imx415_subdev_video_ops,
	.pad = &imx415_subdev_pad_ops,
};

v4l2_i2c_subdev_init(&imx415->sd, imx415->client,
			      &imx415_subdev_ops);
imx415->sd.internal_ops = &imx415_internal_ops;
imx415->sd.flags |= V4L2_SUBDEV_FL_HAS_DEVNODE;

imx415->pads[0].flags = MEDIA_PAD_FL_SOURCE;
imx415->sd.entity.function = MEDIA_ENT_F_CAM_SENSOR;
ret = media_entity_pads_init(&imx415->sd.entity, 1, imx415->pads);
```

`v4l2_i2c_subdev_init()` 将 `v4l2_subdev`、`i2c_client` 和回调表绑定在一起。`V4L2_SUBDEV_FL_HAS_DEVNODE` 表示这个 subdev 希望暴露 `/dev/v4l-subdevX`；`MEDIA_PAD_FL_SOURCE` 标记数据方向；`MEDIA_ENT_F_CAM_SENSOR` 告诉 media controller 这个 entity 是 camera sensor；`media_entity_pads_init()` 把一个 pad 正式挂到 entity。最后，`v4l2_async_register_subdev_sensor()` 完成异步注册，等待 CSI receiver 这类 bridge driver 建立完整 pipeline。

### 用户空间如何进行格式协商

格式协商并不是 sensor 和 receiver 在硬件线上互相对话，而是用户空间程序或 camera framework 通过 V4L2 API 查询和设置每个 pad。典型次序是：

```text
枚举 sensor source pad 的 media-bus code
  -> 枚举该 code 支持的 frame size
  -> 向 sensor source pad 设置格式
  -> 向 CSI receiver sink pad 设置相同格式
  -> 检查整条 media pipeline 上的 pad 是否兼容
```

如果 subdev devnode 已经创建，可以用 `v4l2-ctl` 直接查询或设置 sensor pad：

这类 subdev pad format 可以通过 media 相关工具查看或设置，例如：

```bash
media-ctl -p
v4l2-ctl -d /dev/v4l-subdevX --get-subdev-fmt pad=0
v4l2-ctl -d /dev/v4l-subdevX --set-subdev-fmt pad=0,width=3864,height=2192,code=SGBRG10_1X10
```

实际连调时 `media-ctl` 更常用于查看拓扑和配置多个 entity 的 pad，libcamera 也会根据 pipeline handler 完成这些工作。只设 sensor source pad 并不保证 receiver sink pad 自动跟着改，整条链路上的格式需要一致。

format 不是 V4L2 control。`--set-subdev-fmt` 走 `.set_fmt` pad operation，用来描述数据类型和尺寸；`--set-ctrl exposure=...` 走 `.s_ctrl` control operation，用来改变曝光等参数。pad format 通过 `v4l2_subdev_pad_ops` 注册，不使用 `v4l2_ctrl_new_std()`。

control 则要先初始化 handler，再创建具体对象，最后挂到 subdev 上：

```c
v4l2_ctrl_handler_init(&sensor->ctrl_handler, 10);

sensor->exposure = v4l2_ctrl_new_std(&sensor->ctrl_handler,
				     &imx415_ctrl_ops,
				     V4L2_CID_EXPOSURE,
				     min, max, step, def);

sensor->sd.ctrl_handler = &sensor->ctrl_handler;
```

用户空间、libcamera 或其他 camera service 设置 control 时，V4L2 control core 先检查范围和步进，保存新值，然后调用驱动注册的 `.s_ctrl()`。驱动在该回调中把标准 V4L2 control ID 翻译成 IMX415 寄存器写入。后文添加的所有 controls 都使用这条路径。

## 写入初始化表和 mode

设备树的 endpoint 只是让驱动选出了 `cur_mode`、`clk_params` 和 lane 数，这些结果此时还在内存里，IMX415 寄存器并没有随之改变。真正开流前，`imx415_setup()` 负责把选择结果写入硬件。

第一部分是 `imx415_init_table[]`。这张表保存与 lane rate 和 INCK 无关的固定配置，包括 window mode、bit depth、输出路径以及 Linus 项目中的 IMX415 驱动设置的其他固定寄存器。这些值不是根据 endpoint 现算的，在学习驱动里我直接保留参考实现中与当前 RAW10 输出相关的表项。

第二部分是 mode 和 clock 参数：

```c
static int imx415_set_mode(struct imx415 *imx415, unsigned int mode)
{
	int ret;

	if (mode >= ARRAY_SIZE(supported_modes))
		return -EINVAL;

	ret = imx415_write_reg_sequence(
		imx415,
		supported_modes[mode].reg_list.regs,
		supported_modes[mode].reg_list.num_of_regs);
	if (ret)
		return ret;

	ret = imx415_write_reg_sequence(
		imx415, imx415->clk_params->regs,
		IMX415_NUM_CLK_PARAM_REGS);
	if (ret)
		return ret;

	return imx415_write_reg_le(
		imx415, IMX415_REG_LANEMODE,
		imx415->num_data_lanes == 2 ?
			IMX415_LANEMODE_2 : IMX415_LANEMODE_4,
		2);
}
```

`mode` 是 `supported_modes[]` 的下标，越界返回 `-EINVAL`。第一张序列表写当前 lane rate 的 D-PHY timing，第二张表写同一 lane rate 和实际 INCK 组合下的 sensor 时钟寄存器，最后再把 `LANEMODE` 设成 2-lane 或 4-lane。三部分中任何一次 I2C 写失败，函数都立即返回该错误。

`imx415_setup()` 将固定配置和可变 mode 配置按顺序连起来：

```c
static int imx415_setup(struct imx415 *imx415)
{
	int ret;

	ret = imx415_write_reg_sequence(imx415, imx415_init_table,
					ARRAY_SIZE(imx415_init_table));
	if (ret)
		return ret;

	return imx415_set_mode(imx415, imx415->cur_mode);
}
```

它每次 stream on 都从固定初始化表开始，而不是只补写上一次变过的寄存器。这对后面的 Runtime PM 很重要：断电后不需要猜哪些寄存器仍然保留，而是按一条已知序列完整恢复。

## 启动和停止 MIPI

从驱动的角度看，启动 MIPI 最终确实是写寄存器。但 `XMSTA = START` 只是最后一步，它不会替我们补齐前面缺少的时钟、lane 或 D-PHY 配置。完整的启动顺序是：

```text
设备上电
初始化固定寄存器表
写入 D-PHY timing
写入 INCK 相关寄存器
写入 lane mode
下发当前 controls
退出 standby
启动 MIPI master
```

Linus 项目里的关键寄存器是：

```c
#define IMX415_MODE              CCI_REG8(0x3000)
#define IMX415_MODE_OPERATING    0
#define IMX415_MODE_STANDBY      BIT(0)

#define IMX415_XMSTA             CCI_REG8(0x3002)
#define IMX415_XMSTA_START       0
#define IMX415_XMSTA_STOP        BIT(0)
```

`MODE = STANDBY` 表示 sensor 处在待机态，内部主数据路径不输出图像。I2C 通常仍可访问，但部分寄存器，例如 sensor info，不一定能在这个状态读。

`MODE = OPERATING` 表示退出 standby，sensor 内部开始进入工作状态。Linus 项目里的驱动写完这个值后等待 80 ms。

`XMSTA = START` 表示启动 MIPI master，开始通过 CSI-2 lane 发数据包。`XMSTA = STOP` 则停止 MIPI 输出。

这两个寄存器组合出了驱动关心的几种状态：

| 状态 | 电源/reset | MODE | XMSTA | 物理含义 |
|---|---|---|---|---|
| Power off/reset | 电源或 INCK 关闭，reset asserted | 无法依赖 | 无法依赖 | sensor 内部不工作，寄存器状态可能丢失 |
| Standby | 已上电并释放 reset | 1 | 通常为 1 | 主图像路径停止，大多数 I2C 寄存器仍可访问 |
| Operating, MIPI stopped | 已上电 | 0 | 1 | sensor 已退出 standby，但还没命令 MIPI master 发帧 |
| Streaming | 已上电 | 0 | 0 | MIPI master 运行，CSI-2 lane 应开始输出 packet |

`MODE` 和 `XMSTA` 都是 active-low 含义：写 0 分别表示 operating 和 start。不能看到 0 就当成“关闭”。

对应代码是：

```c
static int imx415_stream_on(struct imx415 *imx415)
{
	int ret;

	ret = imx415_write_reg(imx415, IMX415_REG_MODE, IMX415_MODE_OPERATING);
	if (ret)
		return ret;

	msleep(80);

	return imx415_write_reg(imx415, IMX415_REG_XMSTA, IMX415_XMSTA_START);
}

static int imx415_stream_off(struct imx415 *imx415)
{
	int ret;
	int standby_ret;

	ret = imx415_write_reg(imx415, IMX415_REG_XMSTA, IMX415_XMSTA_STOP);
	standby_ret = imx415_write_reg(imx415, IMX415_REG_MODE,
				       IMX415_MODE_STANDBY);

	return ret ? ret : standby_ret;
}
```

`imx415_stream_on()` 只处理最后两个状态转换：先写 `MODE = 0`，等 80 ms，再写 `XMSTA = 0`。它的输入是包含 I2C client 的 `struct imx415 *`，成功返回 0，任何寄存器写失败都返回对应负 errno。`imx415_stream_off()` 反过来先停 MIPI master，再进入 standby；它会尝试执行两次写入，但优先保留第一个错误。

那么我怎么知道当前是否真在 streaming？驱动里有三个层次的答案：

1. `imx415->streaming` 记录驱动上一次成功完成的 start/stop 操作，用来防止重复启停。
2. 在 sensor 已上电且寄存器允许读的情况下，可以读 `MODE` 和 `XMSTA` 检查驱动写入的控制值。
3. 要证明线上真的有正确图像，还需要看 CSI receiver 的 frame counter、错误状态或实际捕获帧。

第 2 层不一定等于第 3 层。把 `XMSTA` 成功写成 0，只能说 sensor 接受了 start 配置；如果 D-PHY timing、lane 连线或 receiver 配置错了，仍然可能没有可用画面。Linus 项目中的 IMX415 驱动没有在每次 `s_stream()` 里回读这两个寄存器，而是依赖严格的调用顺序和软件状态。

## 最小 s_stream

前面的函数分别完成了资源解析、寄存器配置和 MIPI 启停，`s_stream()` 要把它们组成一次完整的出流操作。我先不考虑 Runtime PM，假定 sensor 在 `probe()` 之后一直保持上电：

```c
static int imx415_s_stream(struct v4l2_subdev *sd, int enable)
{
	struct imx415 *imx415 = to_imx415(sd);
	int ret;

	enable = !!enable;
	if (enable == imx415->streaming)
		return 0;

	if (!enable) {
		ret = imx415_stream_off(imx415);
		imx415->streaming = false;
		return ret;
	}

	ret = imx415_setup(imx415);
	if (ret)
		return ret;

	ret = v4l2_ctrl_handler_setup(&imx415->ctrl_handler);
	if (ret)
		return ret;

	ret = imx415_stream_on(imx415);
	if (ret) {
		imx415_stream_off(imx415);
		return ret;
	}

	imx415->streaming = true;
	return 0;
}
```

这段代码中的每一步都有自己的边界：

- `enable = !!enable` 把任意非零值归一成 1，便于和 `bool streaming` 比较。
- `enable == streaming` 说明驱动已处在目标状态，重复调用直接返回。
- `imx415_setup()` 先写 `imx415_init_table[]`，再调用 `imx415_set_mode()` 写 D-PHY timing、INCK 参数和 `LANEMODE`。它只完成配置，还没有启动 MIPI master。
- `v4l2_ctrl_handler_setup()` 遍历 handler 中的 controls，用当前缓存值调用 `.s_ctrl()`。这保证用户提前设置的曝光、增益和翻转值会在开流前写进 sensor。
- `imx415_stream_on()` 是最后一步，让 sensor 退出 standby 并启动 MIPI master。
- 只有上面所有步骤都成功，`streaming` 才变成 `true`。启动失败时尝试调用 `imx415_stream_off()`，把 sensor 收回已知的 stop/standby 状态。

V4L2 通过 video operations 找到这个函数：

```c
static const struct v4l2_subdev_video_ops imx415_subdev_video_ops = {
	.s_stream = imx415_s_stream,
};
```

用户空间在最终 video node 上开始采集，或 libcamera 启动一条 pipeline 时，SoC 侧的 bridge/receiver driver 会沿 media pipeline 启动各个 subdev，最后调到 IMX415 的 `.s_stream(1)`。上层不需要知道 `XMSTA`、`LANEMODE` 或 D-PHY timing 寄存器；它们是 sensor driver 内部实现。

走到这里，最小出图驱动的主链路已经齐了：能识别 sensor，能描述 CSI-2 连接和 RAW10 格式，也能在 stream on 时完成硬件配置并启动输出。后面的功能都建立在这条主链路上。

## 功能添加：通过 V4L2 controls 暴露能力

曝光、增益和翻转对 IMX415 来说都是寄存器功能，但用户空间不应该直接传入寄存器地址。V4L2 controls 在中间做了一层稳定接口：上层使用 `V4L2_CID_EXPOSURE` 这类标准 ID，驱动再把 ID 和值翻译成 IMX415 的寄存器写入。

这条路径在内核中是：

```text
v4l2-ctl / libcamera / camera service
  -> V4L2 control ioctl
  -> control core 检查 min/max/step 并保存新值
  -> imx415_s_ctrl(struct v4l2_ctrl *ctrl)
  -> 根据 ctrl->id 调用对应 helper
  -> imx415_write_reg[_le]()
  -> I2C
```

每加一个 control，都要做三件事：在 `struct imx415` 中保存必要的 control 指针，在 `imx415_init_controls()` 中注册它，在 `imx415_s_ctrl()` 中处理它的 ID。

```c
static const struct v4l2_ctrl_ops imx415_ctrl_ops = {
	.s_ctrl = imx415_s_ctrl,
};

v4l2_ctrl_handler_init(&imx415->ctrl_handler, 10);
/* 各个 v4l2_ctrl_new_*() 调用写在这里 */

if (imx415->ctrl_handler.error)
	return imx415->ctrl_handler.error;

imx415->sd.ctrl_handler = &imx415->ctrl_handler;
```

`v4l2_ctrl_handler_init()` 的第二个参数是预估的 control 数量，用于减少内部分配，它不是一个不能超过的硬限制。`v4l2_ctrl_new_*()` 失败时通常把错误记在 `handler->error` 里，因此创建完所有 controls 后统一检查即可。

`imx415_init_controls()` 是所有注册代码的容器。后面每加一项功能，就把对应的 `v4l2_ctrl_new_*()` 放到中间：

```c
static int imx415_init_controls(struct imx415 *imx415)
{
	struct v4l2_ctrl_handler *handler = &imx415->ctrl_handler;
	int ret;

	v4l2_ctrl_handler_init(handler, 10);

	/* 下文的 flip、exposure、gain、blanking 等在这里创建 */

	if (handler->error) {
		ret = handler->error;
		v4l2_ctrl_handler_free(handler);
		return ret;
	}

	imx415->sd.ctrl_handler = handler;
	return 0;
}
```

`.s_ctrl()` 是另一个不断扩展的入口。V4L2 只传入当前 `struct v4l2_ctrl *`，回调通过 `ctrl->handler` 找回这组 controls 所属的 `struct imx415`：

```c
static int imx415_s_ctrl(struct v4l2_ctrl *ctrl)
{
	struct imx415 *imx415 = container_of(ctrl->handler,
					    struct imx415, ctrl_handler);
	int ret;

	switch (ctrl->id) {
	/* 下文每加一个 control，在这里增加一个 case */
	default:
		ret = -EINVAL;
		break;
	}

	return ret;
}
```

`ctrl->val` 是 V4L2 control core 已经检查过范围和步进的当前值，`ctrl->id` 则决定该调哪个寄存器 helper。回调返回 0 表示设置成功，返回负 errno 时，错误会通过 V4L2 ioctl 传回调用者。

### 功能一：HFLIP 和 VFLIP

翻转是最容易看到效果的 control，但 IMX415 的水平和垂直翻转不是两个独立寄存器，而是 `REVERSE(0x3030)` 中的两个 bit：

```c
#define IMX415_REG_REVERSE     0x3030
#define IMX415_HREVERSE_SHIFT  0
#define IMX415_VREVERSE_SHIFT  1
```

首先创建两个标准布尔 controls。`v4l2_ctrl_new_std()` 的后四个数字依次是 minimum、maximum、step 和 default，因此 `0, 1, 1, 0` 表示只允许关和开，默认不翻转。

```c
imx415->hflip = v4l2_ctrl_new_std(
	handler, &imx415_ctrl_ops, V4L2_CID_HFLIP,
	0, 1, 1, 0);
imx415->vflip = v4l2_ctrl_new_std(
	handler, &imx415_ctrl_ops, V4L2_CID_VFLIP,
	0, 1, 1, 0);
```

因为两个 control 共用寄存器，不能在设置 HFLIP 时只写 bit 0，否则会顺手把已经开启的 VFLIP 清掉。写入前要同时取两个 control 当前值：

```c
static int imx415_set_flip(struct imx415 *imx415)
{
	u8 flip = (imx415->hflip->val << IMX415_HREVERSE_SHIFT) |
		  (imx415->vflip->val << IMX415_VREVERSE_SHIFT);

	return imx415_write_reg(imx415, IMX415_REG_REVERSE, flip);
}
```

`.s_ctrl()` 中的两个 ID 共用这个 helper：

```c
case V4L2_CID_HFLIP:
case V4L2_CID_VFLIP:
	ret = imx415_set_flip(imx415);
	break;
```

用户空间看到的是标准 control 名称：

```bash
v4l2-ctl -d /dev/v4l-subdevX --set-ctrl horizontal_flip=1
v4l2-ctl -d /dev/v4l-subdevX --set-ctrl vertical_flip=1
```

翻转会改变 Bayer 阵列的空间顺序。当前实现和 Linus 项目中的驱动一样，pad 仍报告 `SGBRG10_1X10`。如果 ISP 依赖严格的 Bayer 相位，camera 配置和标定需要知道当前 flip 状态，不能只把它当成显示层的镜像。

### 功能二：Exposure

IMX415 不是把“曝光 1000 行”直接写到一个 exposure 寄存器。它用每帧总行数 `VMAX` 和开始读出位置 `SHR0` 表示积分行数：

```text
exposure = VMAX - SHR0
SHR0 = VMAX - exposure
```

最小出图时使用固定 `VMAX = 2192 + 58 = 2250`，并且给帧边界留出 8 行 offset，所以初始 exposure 范围是 4 到 2242 行：

```c
#define IMX415_EXPOSURE_MIN     4
#define IMX415_EXPOSURE_OFFSET  8
#define IMX415_VMAX_DEFAULT     (2192 + 58)
#define IMX415_EXPOSURE_MAX     (IMX415_VMAX_DEFAULT - 8)

imx415->exposure = v4l2_ctrl_new_std(
	handler, &imx415_ctrl_ops, V4L2_CID_EXPOSURE,
	IMX415_EXPOSURE_MIN, IMX415_EXPOSURE_MAX,
	1, IMX415_EXPOSURE_MAX);
```

刚加入 exposure，还没有 VBLANK control 时，helper 可以直接使用固定 VMAX：

```c
static int imx415_set_exposure(struct imx415 *imx415, u32 exposure)
{
	u32 vmax = IMX415_VMAX_DEFAULT;

	return imx415_write_reg_le(imx415, IMX415_REG_SHR0,
				   vmax - exposure, 3);
}
```

`SHR0` 是 24-bit little-endian 寄存器，所以 `width` 传 3。例如 exposure 设为 1000 行，写入值是 `2250 - 1000 = 1250`，然后由 `imx415_write_reg_le()` 拆成三个低字节优先的数据字节。

`.s_ctrl()` 的分发只需要加一个 case：

```c
case V4L2_CID_EXPOSURE:
	ret = imx415_set_exposure(imx415, ctrl->val);
	break;
```

用户空间可以先查范围，再设置行数：

```bash
v4l2-ctl -d /dev/v4l-subdevX --get-ctrl exposure
v4l2-ctl -d /dev/v4l-subdevX --set-ctrl exposure=1000
```

这个值的单位是 line，不是微秒。真正的积分时间还要乘以行时间：

```text
line_time = (width + HBLANK) / pixel_rate
exposure_time = exposure_lines * line_time
```

因此同样是 1000 行，HBLANK 改变后实际曝光时间也会变。

### 功能三：Analogue Gain

光靠延长曝光会受到帧率和运动模糊的限制，下一步加入模拟增益。Linus 项目中的 IMX415 驱动使用 `GAIN_PCG_0`，取值范围 0 到 100，每个整数步进约为 0.3 dB：

```text
0   -> 约 0 dB
10  -> 约 3 dB
100 -> 约 30 dB
```

注册时使用标准 `V4L2_CID_ANALOGUE_GAIN`：

```c
imx415->analogue_gain = v4l2_ctrl_new_std(
	handler, &imx415_ctrl_ops, V4L2_CID_ANALOGUE_GAIN,
	0, 100, 1, 0);
```

寄存器是 16-bit little-endian，helper 用 `width = 2`：

```c
static int imx415_set_analogue_gain(struct imx415 *imx415, u32 gain)
{
	return imx415_write_reg_le(imx415, IMX415_REG_GAIN_PCG_0,
				   gain, 2);
}

case V4L2_CID_ANALOGUE_GAIN:
	ret = imx415_set_analogue_gain(imx415, ctrl->val);
	break;
```

```bash
v4l2-ctl -d /dev/v4l-subdevX --set-ctrl analogue_gain=20
```

曝光增加的是 sensor 收集光的时间，模拟增益放大的是像素模拟信号。增益不会拉长帧周期，但信号和噪声会一起被放大。自动曝光算法通常会同时调整 exposure 和 analogue gain，而不是只使用其中一个。

### 功能四：VBLANK

VBLANK 是每帧有效图像之后的垂直消隐行数，它和 `VMAX` 的关系是：

```text
VMAX = image_height + VBLANK
```

当前图像高度为 2192，默认 VBLANK 为 58，所以默认 VMAX 是 2250。`VMAX` 有效范围上限是 `0x0fffff`，注册如下：

```c
imx415->vblank = v4l2_ctrl_new_std(
	handler, &imx415_ctrl_ops, V4L2_CID_VBLANK,
	58, IMX415_VMAX_MAX - IMX415_PIXEL_ARRAY_HEIGHT,
	1, 58);
```

加入 VBLANK 之后，前一节的 exposure helper 不能再使用固定 VMAX，要改成读取 control 的当前值：

```c
u32 vmax = IMX415_PIXEL_ARRAY_HEIGHT + imx415->vblank->val;
exposure = min(exposure, vmax - IMX415_EXPOSURE_OFFSET);
```

写 VBLANK 时不能只改 `VMAX`。因为 `SHR0 = VMAX - exposure`，VMAX 一变，上一次的 SHR0 就不再代表同样的 exposure lines。因此我先写 VMAX，再重新写一次当前 exposure：

```c
static int imx415_set_vblank(struct imx415 *imx415, u32 vblank)
{
	u32 vmax = IMX415_PIXEL_ARRAY_HEIGHT + vblank;
	int ret;

	ret = imx415_write_reg_le(imx415, IMX415_REG_VMAX, vmax, 3);
	if (ret)
		return ret;

	return imx415_set_exposure(imx415, imx415->exposure->val);
}
```

VBLANK 还决定了 exposure 的最大值。这个依赖关系要在 `.s_ctrl()` 中先更新：

```c
if (ctrl->id == V4L2_CID_VBLANK) {
	u32 exposure_max = IMX415_PIXEL_ARRAY_HEIGHT + ctrl->val -
			   IMX415_EXPOSURE_OFFSET;

	__v4l2_ctrl_modify_range(imx415->exposure,
		imx415->exposure->minimum, exposure_max,
		imx415->exposure->step,
		imx415->exposure->default_value);
}

case V4L2_CID_VBLANK:
	ret = imx415_set_vblank(imx415, ctrl->val);
	break;
```

`__v4l2_ctrl_modify_range()` 的双下划线版本假定 control handler 的锁已经持有。`.s_ctrl()` 本来就在该锁保护下执行，如果再调用内部会取同一把锁的普通版本，反而可能自己等自己。

```bash
v4l2-ctl -d /dev/v4l-subdevX --set-ctrl vertical_blanking=200
```

在 HBLANK 和 pixel rate 不变时，VBLANK 越大，一帧包含的总行数越多，帧率越低，但允许的最大曝光行数也越大。

### 功能五：HBLANK

HBLANK 是每行有效像素之外的水平消隐 pixel clocks。V4L2 使用 pixel-clock 作为单位，但 IMX415 的 `HMAX` 寄存器每个单位等于 12 个 pixel clocks：

```text
line_length = image_width + HBLANK
HMAX = line_length / 12
HBLANK = HMAX * 12 - image_width
```

所以 HBLANK control 的 step 不能写 1，而要写 12，保证每个 control 值都能无损换算成整数 HMAX。最小 HMAX 取自 endpoint 选中的 mode，并且 2-lane 和 4-lane 可能不同：

```c
const struct imx415_mode *mode = &supported_modes[imx415->cur_mode];

hblank_min = mode->hmax_min[imx415->num_data_lanes == 2 ? 0 : 1] *
		     IMX415_HMAX_MULTIPLIER - IMX415_PIXEL_ARRAY_WIDTH;
hblank_max = IMX415_HMAX_MAX * IMX415_HMAX_MULTIPLIER -
		     IMX415_PIXEL_ARRAY_WIDTH;

imx415->hblank = v4l2_ctrl_new_std(
	handler, &imx415_ctrl_ops, V4L2_CID_HBLANK,
	hblank_min, hblank_max, IMX415_HMAX_MULTIPLIER,
	hblank_min);
```

寄存器写入则是上面公式的直接翻译：

```c
static int imx415_set_hblank(struct imx415 *imx415, u32 hblank)
{
	u32 hmax = (IMX415_PIXEL_ARRAY_WIDTH + hblank) /
		   IMX415_HMAX_MULTIPLIER;

	return imx415_write_reg_le(imx415, IMX415_REG_HMAX, hmax, 2);
}

case V4L2_CID_HBLANK:
	ret = imx415_set_hblank(imx415, ctrl->val);
	break;
```

HBLANK 变大会拉长每一行，进而降低帧率。它不改变 exposure control 的“行数上限”，但会改变每行对应的真实时间，所以同样的 exposure lines 会得到不同的微秒数。

### 功能六：Test Pattern

真实画面发黑或者数据不对时，问题可能在镜头、曝光、像素阵列，也可能在 MIPI 和 CSI receiver。Test Pattern Generator 可以绕过光学输入，由 sensor 内部直接生成已知图案，因此很适合用来切分问题范围。

Linus 项目中的驱动提供了 13 个菜单项，第 0 项是 disabled，后面包括黑、白、灰、条纹和水平/垂直色条。

```c
imx415->test_pattern = v4l2_ctrl_new_std_menu_items(
	handler, &imx415_ctrl_ops, V4L2_CID_TEST_PATTERN,
	ARRAY_SIZE(imx415_test_pattern_menu) - 1,
	0, 0, imx415_test_pattern_menu);
```

`v4l2_ctrl_new_std_menu_items()` 的 maximum 是最后一个有效 index，所以用 `ARRAY_SIZE() - 1`；mask 为 0 表示没有需要跳过的菜单项；default 为 0，默认关闭图样。

启用图样不是只写一个 enable bit。参照 Linus 项目中的实现，还要调整黑电平、图样编号、test clock 和数字处理路径：

```c
static int imx415_set_test_pattern(struct imx415 *imx415, int val)
{
	const struct imx415_reg_sequence enable_regs[] = {
		{ IMX415_REG_BLACK_LEVEL,    0x00,    2 },
		{ IMX415_REG_TPG_ENABLE,     0x01,    1 },
		{ IMX415_REG_TPG_PATTERN,    val - 1, 1 },
		{ IMX415_REG_TPG_COLORWIDTH, 0x01,    1 },
		{ IMX415_REG_TESTCLKEN_MIPI, 0x20,    1 },
		{ IMX415_REG_DIG_CLP_MODE,   0x00,    1 },
		{ IMX415_REG_WRJ_OPEN,       0x00,    1 },
	};
	const struct imx415_reg_sequence disable_regs[] = {
		{ IMX415_REG_BLACK_LEVEL, IMX415_BLACK_LEVEL_DEFAULT, 2 },
		{ IMX415_REG_TPG_ENABLE,     0x00, 1 },
		{ IMX415_REG_TESTCLKEN_MIPI, 0x00, 1 },
		{ IMX415_REG_DIG_CLP_MODE,   0x01, 1 },
		{ IMX415_REG_WRJ_OPEN,       0x01, 1 },
	};

	if (val < 0 || val >= (int)ARRAY_SIZE(imx415_test_pattern_menu))
		return -EINVAL;

	if (val)
		return imx415_write_reg_sequence(imx415, enable_regs,
						  ARRAY_SIZE(enable_regs));

	return imx415_write_reg_sequence(imx415, disable_regs,
					  ARRAY_SIZE(disable_regs));
}
```

菜单 index 0 被留给 disabled，而 IMX415 寄存器中的图样编号从 0 开始，所以启用时写入 `val - 1`。关闭时必须恢复正常黑电平和数字处理路径，不能只把 `TPG_ENABLE` 清零。

```c
case V4L2_CID_TEST_PATTERN:
	ret = imx415_set_test_pattern(imx415, ctrl->val);
	break;
```

```bash
v4l2-ctl -d /dev/v4l-subdevX --list-ctrls-menu
v4l2-ctl -d /dev/v4l-subdevX --set-ctrl test_pattern=1
```

如果内部图样能稳定被捕获，说明 sensor 配置、MIPI 输出、CSI receiver 解包和后续 DMA 至少已经打通。此时真实画面仍然异常，再去重点检查镜头、光照、曝光、Bayer 顺序和 ISP 处理。

### 功能七：LINK_FREQ、PIXEL_RATE 和安装属性

前面几个 controls 都能写寄存器，`LINK_FREQ` 和 `PIXEL_RATE` 则主要用来把已经选定的硬件时序告诉上层。它们是接口信息，不是在当前驱动中随意切换 mode 的开关。

`LINK_FREQ` 使用 integer menu，菜单项来自驱动支持的链路频率。endpoint 解析已经选出 `lane_rate`，驱动先找到 `lane_rate / 2` 在菜单中的 index，再将 control 标成只读：

```c
imx415->link_freq = v4l2_ctrl_new_int_menu(
	handler, &imx415_ctrl_ops, V4L2_CID_LINK_FREQ,
	ARRAY_SIZE(imx415_link_freq_menu_items) - 1,
	i, imx415_link_freq_menu_items);

if (imx415->link_freq)
	imx415->link_freq->flags |= V4L2_CTRL_FLAG_READ_ONLY;
```

`PIXEL_RATE` 的 minimum、maximum 和 default 都使用 endpoint/INCK 选择后得到的同一个值，并且不注册 `.s_ctrl()`：

```c
imx415->pixel_rate_ctrl = v4l2_ctrl_new_std(
	handler, NULL, V4L2_CID_PIXEL_RATE,
	imx415->pixel_rate, imx415->pixel_rate,
	1, imx415->pixel_rate);
```

上层可以用这两个值配置 receiver 或计算行时间，但不能通过 `--set-ctrl` 改它们：

```bash
v4l2-ctl -d /dev/v4l-subdevX --get-ctrl link_frequency
v4l2-ctl -d /dev/v4l-subdevX --get-ctrl pixel_rate
```

设备树里还可以描述 sensor 的 `rotation` 和 `orientation`。它们不是通过 I2C 检测出来的，而是摄像头模组在产品中的安装信息。V4L2 fwnode helper 先从 `imx415->dev` 对应的节点解析，再按实际存在的属性创建标准 controls：

```c
struct v4l2_fwnode_device_properties props;

ret = v4l2_fwnode_device_parse(imx415->dev, &props);
if (ret)
	return ret;

v4l2_ctrl_new_fwnode_properties(handler, &imx415_ctrl_ops, &props);
```

`v4l2_fwnode_device_parse()` 接收当前 `device` 和待填充的 properties 结构，成功返回 0。`v4l2_ctrl_new_fwnode_properties()` 再根据这份结构创建 camera orientation/sensor rotation 等 controls。这些值让 libcamera 或应用知道模组的安装方向，不会自动去改 `REVERSE` 寄存器。

到这里，用户空间可以用一条命令看到驱动暴露的整套参数：

```bash
v4l2-ctl -d /dev/v4l-subdevX --list-ctrls-menu
```

可写 control 的值会先由 V4L2 control core 缓存。sensor 正在工作时，`.s_ctrl()` 把它立即写入寄存器；下一节加入 Runtime PM 后，sensor 已下电时只更新缓存，等下次 stream on 再用 `v4l2_ctrl_handler_setup()` 统一恢复。

## Runtime PM

最小驱动可以在 `probe()` 中上电，直到 `remove()` 才下电。这对学习出图链路很直接，但用户不采集时 sensor 仍然一直消耗电力。Runtime PM 用 usage count 记录“当前有多少使用者需要设备”：

```text
usage count > 0  -> 设备应保持 active
usage count = 0  -> 设备可以 runtime suspend
```

Runtime PM 不知道 IMX415 的 regulator、reset 和 clock 顺序，因此需要驱动提供两个 callback。

### Runtime suspend 和 resume callback

```c
static int imx415_runtime_resume(struct device *dev)
{
	struct i2c_client *client = to_i2c_client(dev);
	struct v4l2_subdev *sd = i2c_get_clientdata(client);
	struct imx415 *imx415 = to_imx415(sd);

	return imx415_power_on(imx415);
}

static int imx415_runtime_suspend(struct device *dev)
{
	struct i2c_client *client = to_i2c_client(dev);
	struct v4l2_subdev *sd = i2c_get_clientdata(client);
	struct imx415 *imx415 = to_imx415(sd);

	imx415_power_off(imx415);
	return 0;
}
```

PM core 调用 callback 时只传入 `struct device *`。`to_i2c_client()` 根据内嵌的 `client->dev` 找回 `i2c_client`；`i2c_get_clientdata()` 取回 `v4l2_i2c_subdev_init()` 之前与 client 绑定的 subdev；`to_imx415()` 再找回驱动私有结构。这个转换链看起来绕，原因是 PM、I2C 和 V4L2 三个子系统各自使用自己的对象。

resume 返回 `imx415_power_on()` 的结果：0 表示恢复成功，负 errno 表示上电失败。suspend 执行下电后返回 0。它们通过 PM operations 挂到 I2C driver：

```c
static DEFINE_RUNTIME_DEV_PM_OPS(imx415_pm_ops,
				 imx415_runtime_suspend,
				 imx415_runtime_resume,
				 NULL);

static struct i2c_driver imx415_i2c_driver = {
	.driver = {
		.name = IMX415_DRIVER_NAME,
		.of_match_table = imx415_of_match,
		.pm = pm_ptr(&imx415_pm_ops),
	},
};
```

### Probe 时的初始 PM 状态

`probe()` 在启用 Runtime PM 之前已经手动调用了 `imx415_power_on()`，因为驱动需要读型号并完成 subdev 初始化。这时硬件已经 active，但 PM core 还不知道。不能直接 `pm_runtime_enable()` 后再让它 resume 一次，那会对已上电的硬件重复执行 power-on sequence。

因此 Linus 项目中的驱动是这样交接初始状态的：

```c
pm_runtime_set_active(imx415->dev);
pm_runtime_get_noresume(imx415->dev);
pm_runtime_enable(imx415->dev);
```

- `pm_runtime_set_active()` 只把 PM core 记录的状态设为 active，不调用 resume callback。
- `pm_runtime_get_noresume()` 将 usage count 增加 1，但不执行上电，因为硬件此时本来就开着。
- `pm_runtime_enable()` 正式启用这个 device 的 Runtime PM。

完成 subdev 异步注册后，驱动配置 1 秒 autosuspend，然后释放 `probe()` 持有的那个引用：

```c
pm_runtime_set_autosuspend_delay(imx415->dev, 1000);
pm_runtime_use_autosuspend(imx415->dev);
pm_runtime_put_autosuspend(imx415->dev);
```

usage count 从 1 变为 0 后不会立即下电，而是等待 1 秒。这样可以避免应用短时间内重复开关 stream 时频繁执行完整的上下电时序。

### Stream 如何使用 usage count

Linus 项目中的 stream on 路径是：

```text
pm_runtime_resume_and_get()
  -> imx415_setup()
  -> __v4l2_ctrl_handler_setup()
  -> imx415_stream_on()
```

`pm_runtime_resume_and_get()` 先增加 usage count。如果设备正在 runtime suspend，PM core 调用 `imx415_runtime_resume()` 完成上电；如果设备还在 1 秒 autosuspend 窗口内，它只需要取消即将发生的 suspend。返回负值表示恢复失败，此时不能继续 I2C 配置。

物理下电后，IMX415 的寄存器状态不能再信任。因此每次 stream on 都必须按下面的顺序重建状态：

1. `imx415_setup()` 重写固定初始表、mode、INCK、D-PHY 和 lane mode。
2. `__v4l2_ctrl_handler_setup()` 把当前缓存的 exposure、gain、blanking、flip 和 test pattern 重新写入。
3. `imx415_stream_on()` 退出 standby 并启动 MIPI master。

Linus 项目中的 `s_stream()` 已经持有 subdev state/control handler 共用的锁，所以它使用不再取锁的 `__v4l2_ctrl_handler_setup()`。我的学习版如果没有做同样的 state lock 整合，则使用普通 `v4l2_ctrl_handler_setup()`。两者的目的相同，区别在于调用者是否已经持锁。

stream off 先命令 sensor 停止输出，然后释放 Runtime PM 引用：

```text
imx415_stream_off()
  -> pm_runtime_put_autosuspend()
```

启动中途失败时，Linus 项目中的驱动使用 `pm_runtime_put_sync()`。它不等 autosuspend，而是同步执行 runtime suspend。此时 sensor 可能只写了一半寄存器，立即下电可以把硬件收回一个明确状态，下次再从完整 setup 开始。

### 休眠期间设置 control

用户可能在 sensor 下电时设置 exposure。为了改一个 control 而唤醒整颗 sensor，写完又下电，没有必要。`.s_ctrl()` 可以使用：

```c
if (!pm_runtime_get_if_in_use(imx415->dev))
	return 0;

/* 根据 ctrl->id 写寄存器 */

pm_runtime_put(imx415->dev);
```

`pm_runtime_get_if_in_use()` 只在设备当前已经 active 且有使用者时增加 usage count。返回 0 表示设备没在使用，回调直接返回：V4L2 control core 已经保存了 `ctrl->val`，只是还没写进硬件。下次 stream on 的 handler setup 会完成这次延后写入。

VBLANK 是个特别的例子。它会改变 exposure control 的合法范围，这个软件关系即使在 sensor 休眠时也必须立即更新。因此 `__v4l2_ctrl_modify_range()` 要放在 `pm_runtime_get_if_in_use()` 之前；只有真正的 `VMAX` 和 `SHR0` 寄存器写入才可以延后到下次 stream on。

### Remove 时收回 PM 状态

设备解绑时，驱动先注销 subdev，再关闭 Runtime PM。如果设备当时并没有处于 suspended，还要手动执行一次 power off：

```c
pm_runtime_disable(imx415->dev);
if (!pm_runtime_status_suspended(imx415->dev))
	imx415_power_off(imx415);
pm_runtime_set_suspended(imx415->dev);
```

最终的 PM 生命周期是：

```text
probe 手动上电并识别型号
  -> 告诉 PM core 当前 active，usage count = 1
  -> subdev 注册完成后 put_autosuspend
  -> 1 秒无使用者，runtime suspend 下电

stream on
  -> resume_and_get，usage count + 1
  -> runtime resume 上电
  -> setup + controls + MIPI start

stream off
  -> MIPI stop + standby
  -> put_autosuspend，usage count - 1
  -> 1 秒后 runtime suspend 下电
```

## 最终调用关系

写到最后再回头看，最小出图链路中的函数可以按职责分成下面几类。这张表也是 bring-up 时的排查顺序：

| 函数 | 输入 | 成功后得到什么 | 在出图链路中的作用 |
|---|---|---|---|
| `imx415_read_reg()` | sensor、16-bit 地址、接收字节指针 | 读回 1 byte | 建立最基础的 I2C 读能力 |
| `imx415_write_reg_le()` | sensor、地址、数值、值宽度 | 指定宽度的值已写入 | 所有 sensor 配置的最终出口 |
| `imx415_write_reg_sequence()` | sensor、寄存器表、表项数 | 整张表顺序写完 | 下发初始表、D-PHY 和时钟表 |
| `imx415_parse_dt()` | 驱动私有结构 | 资源句柄和 endpoint 配置可用 | 把板级描述转成驱动对象 |
| `imx415_parse_endpoint()` | 已关联 firmware node 的 device | lane 数、`cur_mode`、`clk_params`、pixel rate | 保证 sensor 和 CSI receiver 使用可兼容的链路参数 |
| `imx415_power_on/off()` | sensor 的 clock、regulator、reset 句柄 | 设备进入可通信状态，或完全下电 | 控制硬件生命周期 |
| `imx415_identify_model()` | 已上电的 sensor | `SENSOR_INFO` 确认为 IMX415 | 验证电源、时钟、reset 和 I2C 链路 |
| `imx415_subdev_init()` | sensor、I2C client、V4L2 ops | subdev、source pad 和 controls 完成注册前初始化 | 把 sensor 放入 media graph |
| `imx415_set_mode()` | endpoint 选中的 mode | D-PHY、INCK 和 lane mode 已写入 | 将板级 CSI 选择落到 sensor 寄存器 |
| `imx415_setup()` | sensor 当前配置 | 固定初始表和 mode 全部写完 | 每次开流前重建已知寄存器状态 |
| `imx415_s_ctrl()` | V4L2 control 对象 | 对应参数转换为寄存器操作 | 连接用户空间标准 control 和 IMX415 |
| `imx415_stream_on/off()` | 已配置的 sensor | operating/streaming 或 stop/standby | 控制 MIPI master 是否发送 CSI-2 packet |
| `imx415_s_stream()` | subdev 和 enable | 整条 setup/control/MIPI 顺序完成 | V4L2 pipeline 的开流与停流入口 |

把这些函数连起来后，`probe()` 做的事情是识别硬件，并建立一个可以被 camera pipeline 使用的 V4L2 sensor：

```text
devm_kzalloc()
  -> parse clock/regulator/reset/endpoint
  -> 保存 i2c_client，准备手写寄存器访问
  -> power on
  -> identify IMX415 by SENSOR_INFO
  -> init V4L2 subdev
  -> create controls
  -> init media source pad
  -> enable Runtime PM
  -> async register sensor subdev
  -> autosuspend
```

真正出图发生在 stream on：

```text
下游调用 s_stream(1)
  -> Runtime PM 恢复供电
  -> 写固定初始化表
  -> 写 D-PHY timing 和 INCK 参数
  -> 写 lane mode
  -> 下发曝光、增益、翻转、blanking、test pattern 等 controls
  -> MODE = operating
  -> XMSTA = start
  -> CSI-2 RAW10 数据进入 SoC
```

停止采集时：

```text
下游调用 s_stream(0)
  -> XMSTA = stop
  -> MODE = standby
  -> Runtime PM autosuspend
  -> 关闭 clock/regulator，assert reset
```

所以驱动层面添加的能力，最终都是通过 V4L2 暴露给上层。上层不需要知道 `SHR0`、`VMAX`、`XMSTA` 这些寄存器，只需要设置标准 controls、配置 media pipeline、启动 stream。寄存器和硬件时序细节留在 sensor driver 里，这也是 V4L2 sensor driver 最重要的边界。

## 小结

这次写 IMX415，我觉得最有用的不是背下每个寄存器，而是把边界分清：

I2C 是控制面，MIPI CSI-2 是数据面。

设备树描述硬件连接，`struct device` 把这些描述带进 probe。

V4L2 subdev 和 pad 描述 sensor 在 media graph 里的位置和输出格式。

Controls 把曝光、增益、翻转、blanking 这些寄存器能力变成上层可用的接口。

Runtime PM 负责在“不采集”的时候把硬件关掉，并在下一次出流前恢复所有必要寄存器。

按这个顺序写，bring-up 时每一步都知道自己验证了什么；出问题时，也更容易判断是 I2C、电源、设备树、MIPI timing，还是 V4L2 pipeline 的问题。
