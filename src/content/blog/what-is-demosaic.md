---
title: '什么是 Demosaic：从 Bayer RAW 到 RGB'
description: '介绍 Bayer 阵列、颜色插值和 Demosaic 的基本原理。'
pubDate: 'Jun 25 2026'
heroImage: '../../assets/blog-placeholder-3.jpg'
---

## Demosaic 是什么

图像传感器采用 Bayer 阵列时，每个感光像素通常只能采集
红、绿、蓝中的一种颜色。

以 RGGB 为例：

```text
R  Gr
Gb B
```

Demosaic 的作用是根据周围像素，估算当前位置缺失的颜色分量，
最终将单通道 Bayer RAW 数据转换为完整的 RGB 图像。

## 为什么绿色像素更多

标准 Bayer 阵列中，红、绿、蓝像素数量比例通常是：

```text
R : G : B = 1 : 2 : 1
```

## 常见算法

- 双线性插值
- 边缘感知插值
- AHD
- 深度学习 Demosaic
