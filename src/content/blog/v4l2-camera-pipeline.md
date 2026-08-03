---
title: 'V4L2 Camera Pipeline Demo'
description: '从采集、缓冲、ISP 处理到虚拟摄像头输出的端到端实验。'
category: '项目'
tags: ['V4L2', 'Camera', 'Linux']
pubDate: 'Jun 24 2026'
---

## 项目目标

验证一个简化 Camera Pipeline 的完整链路：Producer 采集帧，Pipeline 做基础处理，Consumer 通过 V4L2 或显示端读取。

## 架构草图

```text
Sensor/File Input
  -> Capture Queue
  -> ISP Pipeline
  -> V4L2 Loopback
  -> ffplay / browser / app
```

## 代码片段

```cpp
while (running) {
    auto frame = capture.dequeue();
    auto output = pipeline.process(frame);
    videoDevice.queue(output);
}
```

## 相关链接

- [GitHub Profile](https://github.com/Reynor-0)
- [生产者-消费者速率不匹配](/blog/producer-consumer-rate-mismatch/)
