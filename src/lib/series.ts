import type { CollectionEntry } from 'astro:content';

export const SERIES_DEFINITIONS = [
	{
		id: 'vehicle-ethernet',
		title: '车载以太网',
		description: '从二层帧、管理接口和 T1 PHY，逐步走到交换、DMA 与整车时间同步。',
		intro:
			'这组文章按一条真实车载以太网链路的理解顺序组织：先认识线上传输的帧，再进入 PHY 管理、链路状态、低功耗、交换转发、DMA 收发，最后讨论跨节点时间同步。',
		category: '协议',
	},
	{
		id: 'camera-development',
		title: 'Camera 应用开发',
		description: '在 RK3568 上把 V4L2、DMA-BUF、RGA 与 DRM/KMS 串成可长期运行的 Camera 应用。',
		intro:
			'这是一条从设备探测到稳定运行的用户态实践路径。每一篇只推进一个可验证目标，逐步解决采集、跨设备缓冲区、图像处理、显示和确定性退出。',
		category: '项目',
	},
	{
		id: 'linux-camera',
		title: 'Linux Camera 驱动与链路',
		description: '理解 Sensor、MIPI CSI-2、V4L2 Buffer、驱动注册与端到端采集链路。',
		intro:
			'这组文章面向 Linux Camera 内核与驱动开发：从一帧图像如何进入 SoC 开始，理解 V4L2 Buffer，再进入 IMX415 驱动结构、从零实现过程和完整 Pipeline 验证。',
		category: '驱动',
	},
	{
		id: 'uds-diagnostics',
		title: 'UDS 诊断与刷写',
		description: '先建立 UDS 服务模型，再追踪一条 DoIP 刷写请求如何穿过协议栈并写入 Flash。',
		intro:
			'第一篇解释 SID、NRC、会话、定时和刷写服务；第二篇沿 Ethernet、DoIP、UDS、更新状态机与 Flash 驱动追踪数据所有权和响应语义。',
		category: '协议',
	},
	{
		id: 'demosaic',
		title: 'Demosaic：从原理到实践',
		description: '从 Bayer RAW 的基本问题出发，理解 AHD 边缘感知插值并进入算法实验。',
		intro:
			'这组文章先回答为什么 RAW 需要插值，再单独拆解 AHD 的方向判断与颜色恢复，最后把理论放回可比较、可评估的算法实验。',
		category: '方法',
	},
] as const;

export type SeriesId = (typeof SERIES_DEFINITIONS)[number]['id'];
export type SeriesDefinition = (typeof SERIES_DEFINITIONS)[number];
export type BlogPost = CollectionEntry<'blog'>;

export function getSeriesDefinition(id: string | undefined) {
	return SERIES_DEFINITIONS.find((series) => series.id === id);
}

export function getSeriesPosts(posts: BlogPost[], seriesId: string) {
	const seriesPosts = posts
		.filter((post) => post.data.series?.id === seriesId)
		.sort((a, b) => (a.data.series?.order ?? 0) - (b.data.series?.order ?? 0));

	const seenOrders = new Set<number>();
	for (const post of seriesPosts) {
		const order = post.data.series?.order;
		if (order === undefined) continue;
		if (seenOrders.has(order)) {
			throw new Error(`Duplicate order ${order} in blog series "${seriesId}".`);
		}
		seenOrders.add(order);
	}

	return seriesPosts;
}

export function getSeriesContext(posts: BlogPost[], currentId: string | undefined) {
	if (!currentId) return undefined;
	const current = posts.find((post) => post.id === currentId);
	const seriesId = current?.data.series?.id;
	if (!current || !seriesId) return undefined;

	const definition = getSeriesDefinition(seriesId);
	if (!definition) return undefined;
	const seriesPosts = getSeriesPosts(posts, seriesId);
	const index = seriesPosts.findIndex((post) => post.id === currentId);
	if (index < 0) return undefined;

	return {
		definition,
		posts: seriesPosts,
		position: index + 1,
		previous: index > 0 ? seriesPosts[index - 1] : undefined,
		next: index < seriesPosts.length - 1 ? seriesPosts[index + 1] : undefined,
	};
}
