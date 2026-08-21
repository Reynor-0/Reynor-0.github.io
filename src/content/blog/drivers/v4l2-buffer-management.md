---
title: 'V4L2 Buffer Management'
description: 'Linux Media API 中 buffer 队列、ownership 和阻塞语义的阅读摘记。'
tags: ['V4L2', 'Buffer', 'Linux 驱动']
pubDate: 'Jun 18 2026'
---

## 核心问题

理解 V4L2 中 buffer 什么时候属于驱动、什么时候属于应用，以及 `DQBUF` / `QBUF` 如何表达所有权转移。

## 摘记

- 不要覆盖消费者仍持有的 buffer。
- 非阻塞只改变等待语义，不定义丢帧策略。
- `poll` / `select` 适合等待多个 fd，而不是忙轮询。

## 关联文章

[生产者-消费者速率不匹配](/blog/producer-consumer-rate-mismatch/)
