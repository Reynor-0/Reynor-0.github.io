---
title: 'Sherlock-ai agent项目总结'
description: ''
tags: ['Sherlock-ai', 'AI', '内存分析', 'Infineon', 'e3650']
series: { id: 'intern', order: 3 }
pubDate: 'Aug 13 2026'
---

> **注：** 本文为实习期间的项目总结，内容仅供参考。

# 一、项目背景

Sherlock-ai 是我实习部门的一个内部项目，旨在通过 AI 技术提供对以下场景的分析和诊断能力：

- 版本迭代时，进行潜在的风险解析以及兼容性检查
- 接入集成部门的 CI/CD 流程，不同版本分析 RAM/ROM 的占用情况
- 测试部门进行 Daily Build 时，如果有相关风险（例如 CPU 负载提升超过 2% 的情况），Sherlock-ai 可以进行分析并给出可能的原因和解决方案
- 提供一个可交互的 AI 聊天式窗口，让用户快速了解指定版本的功能配置、风险点以及相关问题解答

从嵌入式工程师的角度看，这个项目本质上做的是把过去"资深工程师靠经验 + 半天人工翻 map 文件 + 手算 RAM/ROM 占用 + 写评审报告"的流程，工程化为一个自动化平台。核心难点不在 AI 本身，而在于**如何把嵌入式工具链产物（.map / .map.xml / .lsl 链接脚本）准确解析成结构化数据**——这部分的正确性直接决定了后续 AI 报告的可信度。

# 二、项目具体功能

## 1. 对于集成部门的单版本静态内存分析

目前支持 NIO 以下区域的静态内存分析：

- **Zone**（HighTec 工具链，TC39B）
- **VDF**（Diab 工具链，e3650）
- **VDF2**（HighTec 工具链，TC399XP）

分别对应 e3650 芯片以及 Infineon 的 TC3xx 家族芯片。结合工程最后的 MAP 文件以及相关的链接脚本，输出不同物理区域的占用情况，例如 RAM（TCM、DSPR、PSPR、DLMU、LMURAM、DAM 等）以及 ROM（PFLASH、XCP_Calibration 等）的占用情况，以及不同功能域模块和符号的占用明细。

### 1.1 多核 MCU 的物理内存布局推导——为什么不能直接信 map 文件的 region 名

TriCore TC3xx 是多核 MCU（典型 6 核 CPU0-5），每核有自己的 DSPR（Data Scratch-Pad SRAM）、PSPR（Program Scratch-Pad SRAM）、DLMU（Data Local Memory Unit），同时还有全局共享的 LMURAM、DAM、PFLASH。但 HighTec 工具链生成的 `.map` / `.map.xml` 里，region 名是**逻辑视图**，不是物理视图——同一个物理区域可能被映射成多个不同地址的 region（mirror/alias），如果直接按 region 名求和会严重重复统计。

我实现的 `zone_memory_layout.py` 从 LSL 链接脚本解析 `REGION_MIRROR` 和 `REGION_ALIAS` 关系，把逻辑 region 归并到物理 memory：

| 关系类型 | 例子（vdf2 LSL） | 含义 | 统计策略 |
|---|---|---|---|
| `REGION_MIRROR` | `REGION_MIRROR("pfls0", "pfls0_nc")` | cached/non-cached 两个地址视图指向**同一物理区间** | canonical 地址归一后**只计一次** |
| `REGION_ALIAS` | `REGION_ALIAS("default_rom", "pfls0")` | 别名指向已存在的 region，不新增容量 | **不增加容量** |

canonical 地址归一是关键——TC3xx 的 non-cached 视图地址在 `0xA0000000-0xC0000000` 段，物理地址在 `0x80000000-0xA0000000` 段，两者相差固定的 `0x20000000`（`CACHED_VIEW_DELTA`）。代码里 `canonical_address()` 把所有 non-cached 地址减去这个 delta，归一到物理地址后再做区间并集，避免 PFLASH 被算两次。

### 1.2 TCM Alias 与 DSPR Local 窗口——多核场景下的漏统计陷阱

TCM（Tightly Coupled Memory）Alias 问题，我在 e3650（VDF）和 TC3xx（Zone/VDF2）上分别遇到了两个变种：

**变种 A：e3650 TCM Alias（VDF）**

e3650 的 TCM 区域有两个地址：local 地址（每个核私有，如 `CORE0_TCM_A` 在 `0x11000000`）和 Alias 地址（公共窗口，如 `TCM_CODE` 在 `0x00040000`）。Alias 地址通过硬件路由到 local 地址的物理区域——**两个地址对应同一块物理 SRAM**。

配置里用 `tcm_alias_groups` 描述这个映射：`logical_start`（Alias 起点）+ 4 个 `targets`（CORE0-3 的 local 物理起点）。解析器把 Alias 区间按 offset 映射到 4 个物理 TCM，如果某个 input section 落在 Alias 区间内，它的占用会按映射目标数 × size 放大——因为同一份代码可能被链接器放到所有核的 TCM 里（每个核各跑一份副本）。

这里容易踩的坑：**Component Summary 按符号归属统计时，如果 input section 落在 Alias 源 region，必须按 alias 映射目标数放大 RAM 占用**，否则会少算 `N × S`（N = 核数，S = section 大小）。代码里 `component_alias_mapped_size()` 做的就是这件事。

**变种 B：TC3xx DSPR/PSPR Local 窗口（Zone/VDF2）**

TC3xx 的 DSPR/PSPR 也有类似机制——每核 DSPR 有全局地址（如 `dsram0` 在 `0x70000000`）和 local 窗口地址（`0xD0000000` 起的 1MB 窗口，`DSPR_LOCAL_BASE`）。同一个 DSPR 物理区可以通过两种地址访问，但访问语义不同：local 窗口是核私有的低延迟访问路径。

更复杂的是 `per_core_data_dsram`、`sbst_reserved_data_dsram` 这种 **local region**——它在 map.xml 里只出现一次，但物理上**每个核都有一份副本**。如果只按 region 容量算，会严重少算。`_build_local_memories()` 的处理是：对每个有效 CPU，把 local region 投影到该核的物理 bank 上，普通 local section 大小为 S、有效 CPU 数为 N 时，**每个 CPU 行各计 S，RAM TOTAL used 增加 N × S**。

但反过来，`.CPUx_local_address_space_` 这种带核号的 section 是**核专属**的（只属于指定 CPU），不投影到其他核——解析器用正则 `.CPU(\d+)\..*_local_address_space_` 提取核号，只归入对应 CPU 的物理 memory，used 只加 1 × S。

这个"按核投影 vs 按核归属"的区分是关键——少算会让 RAM TOTAL 偏小（误导内存预算决策），多算会让单个核的占用虚高（误导任务分配决策）。

### 1.3 XCP 标定段的 ROM/RAM 真实归属

XCP（Universal Measurement and Calibration Protocol）是车载标定协议，标定段分两类：

- **静态标定段**：编译时固化在 ROM（PFLASH）里，如 `xcp_calibration_segment_0/1`，运行时只读
- **动态标定段**：运行时可写的 RAM overlay 区，如 `lmuram_xcp`（在 LMURAM 区域），用于在线标定

如果按 region 名匹配 `xcp` 关键字，会把 `lmuram_xcp` 误归 ROM——但它物理上是 RAM。我的处理是：`xcp_region_keyword` 用 `"xcp_calibration"`（只匹配 ROM 静态标定段），`lmuram_xcp` 不含这个子串，自然被 LMURAM 分组逻辑归到 RAM。

进了 XCP 表的标定段还要判断是否计入 ROM TOTAL——`_xcp_relations()` 按标定段与 PFLASH 物理区间的重叠量判定：

| 重叠情况 | 判定 | 是否计入 ROM TOTAL | 原因 |
|---|---|---|---|
| 完全在 PFLASH 内 | `INSIDE` | ❌ 不计 | PFLASH 已包含，再计会重复 |
| 完全在 PFLASH 外 | `OUTSIDE` | ✅ 计入 | 独立 ROM 标定区，PFLASH 没覆盖 |
| 部分重叠 | 抛 `PartialXcpOverlapError` | — | 链接布局错误，整个分析失败 |

这个"INSIDE 不加、OUTSIDE 才加"的反向逻辑容易写反——直觉是"在 ROM 里就该加"，但实际上 PFLASH 的 `physical_intervals` 已经把整个 PFLASH 区间算进去了，标定段作为 PFLASH 的一部分再加一次就是重复。

### 1.4 产物

每个版本生成一份 HTML 主报告 + 一份全量符号 XLSX：

- **HTML 主报告**：总体 RAM/ROM 摘要 + 区域表（每个物理 memory 的 capacity/used/free/holes/usage%）+ XCP 标定段表 + Component Summary（18 个功能域的 RAM/ROM 占用）+ Top N Symbols
- **全量符号 XLSX**：每个符号的 Section / InputSection / Symbol / Size / ROM_Addr / RAM_Addr / File，典型 12000+ 行，供人工筛查

## 2. 两个版本的对比分析

对于两个版本，Sherlock-ai 可以进行对比分析，输出不同版本之间的差异情况，例如 RAM/ROM 的占用变化情况，版本迭代的功能点改动以及相应的代码分析。

### 2.1 任务链编排与四级缓存

整个对比分析是 Celery 异步任务链：

```
sync_project（并行 A/B，从 GitLab 同步代码）
  → compile_zone（并行 A/B，Docker 编译出 .map.xml + .map）
  → diff_ai（差异生成 + AI 归因分析）
  → 保存报告
```

关键工程优化是**四级缓存策略**，避免每次都从头跑全流程（45 分钟）：

| 缓存级 | 命中条件 | 耗时 | 跳过的步骤 |
|---|---|---|---|
| L1 | 同 project+vehicle+zone+versionA+versionB 已有完成 Task | < 1s | 全部 |
| L2 | 同 CodeProject+zone 已有完成 ZoneBuild（编译产物） | < 10min | 跳过 sync + compile |
| L3 | 同 project+vehicle+version 已有完成 CodeProject（代码同步） | 跳过 sync | 仍需 compile |
| L4 | 全未命中 | ~45min | 全流程 |

缓存用引用计数管理（`_atomic_increment_ref_count`），多任务共享同一份 CodeProject/ZoneBuild 时原子递增，任务结束递减，零引用后由 `scheduler/cleanup.py` 定时清理。重启恢复（`restart_recovery.py`）保证服务重启后引用计数一致。

### 2.2 代码索引驱动的 AI 归因

编译完成后，用 `scip-clang` + `scip-cli` 构建 LSIF（Language Server Index Format）代码索引。这个索引是后续 AI 分析的关键——AI 不能只看 git diff 的文本，要能回答"这个改动影响了哪些调用方""这个符号在哪里被引用"这类问题。

具体来说，AI 报告分多个 subreport：

- **Overview**：变更概述、RAM/ROM 总量变化
- **Memory**：内存增长点 Top N、区域迁移（如某符号从 RAM 迁到 ROM）
- **Risk**：兼容性风险（API 签名变化、中断处理函数改动等）、功能风险
- **Residual**：残留问题、已知未修复项
- **Code Impact**：代码变动的影响范围（通过 LSIF 索引追溯调用链）
- **Evidence**：证据回溯（每个结论附 git diff 片段 / map 符号 / 编译日志作为证据）

每个 subreport 用 Pydantic schema 校验 AI 输出，确保结构化字段（如 `RamRomTotal`、`ObjectChange`、`CompatibilityRisk`）符合预期，避免 AI 自由发挥导致报告不可解析。`EvidenceLookup` 还会反向校验 AI 引用的证据是否真实存在——防止 AI 编造 git diff 行号或符号名（所谓的"幻觉"问题）。

### 2.3 templated vs legacy 两种报告生成模式

`REPORT_GENERATION_MODE` 支持两种模式：

- **templated**（新链路）：从编译日志推断变更（编译日志里有 warning/error/changed file 列表），更精准
- **legacy**（旧链路）：从 git diff 推断变更，依赖 git log 完整性

templated 模式更适合 CI/CD 场景——Daily Build 时编译日志一定有，但 git 历史可能因为各种原因（force push、rebase）不完整。






