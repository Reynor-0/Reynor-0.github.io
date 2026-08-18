---
title: 'UDS 诊断协议：从报文格式到刷写流程'
description: '从客户端/服务器模型、SID 与 NRC、诊断会话和定时参数出发，梳理 UDS on CAN、常用诊断服务及 ECU 刷写流程。'
category: '协议'
series: { id: 'uds-diagnostics', order: 1 }
tags: ['UDS', 'ISO 14229', 'ISO-TP', 'CAN', '汽车诊断']
pubDate: 'Aug 11 2026'
---

UDS（Unified Diagnostic Services，统一诊断服务）是一套面向车辆 ECU 的应用层诊断协议。诊断仪可以通过它读取车辆信息和实时数据、读取和清除故障码、控制执行器、执行例程，以及完成软件刷写。

UDS 定义的是“诊断双方如何对话”，并不限定底层总线。它可以运行在 CAN、CAN FD 和 DoIP 等不同传输通道上。本文先建立 UDS 的通用模型，再以最常见的 UDS on CAN 为例分析报文和流程。

> 本文中的服务和参数是协议层通用示例。具体 ECU 支持哪些服务、DID、例程、安全等级和会话，仍由项目诊断规范决定。

## UDS 位于协议栈的哪一层

以 CAN 总线为例，一次诊断通信通常涉及以下层次：

```text
诊断应用：读取 VIN、清除 DTC、刷写软件
        │
UDS 应用层：ISO 14229-1
        │
UDS 会话层：ISO 14229-2
        │
UDS on CAN：ISO 14229-3
        │
ISO-TP 传输层：ISO 15765-2
        │
CAN / CAN FD
```

UDS 负责定义服务语义，ISO-TP 则负责把可能超过一帧容量的 UDS 消息拆分、传输和重组。换成以太网后，UDS 的核心服务语义基本不变，但传输通道会改为 DoIP。

通信双方采用客户端/服务器模型：

- **客户端（Client）**：通常是诊断仪、刷写工具或车内诊断主控，主动发送请求。
- **服务器（Server）**：通常是 ECU，检查请求并执行服务，然后返回响应。

## 一条 UDS 消息如何表达

### SID：服务标识符

请求的第一个字节是 SID（Service Identifier），用于表示客户端请求的服务。例如：

| SID | 服务 | 用途 |
| --- | --- | --- |
| `0x10` | DiagnosticSessionControl | 切换诊断会话 |
| `0x11` | ECUReset | 复位 ECU |
| `0x14` | ClearDiagnosticInformation | 清除 DTC 信息 |
| `0x19` | ReadDTCInformation | 读取 DTC 信息 |
| `0x22` | ReadDataByIdentifier | 按 DID 读取数据 |
| `0x27` | SecurityAccess | 传统 Seed/Key 安全访问 |
| `0x28` | CommunicationControl | 控制通信报文收发 |
| `0x29` | Authentication | 基于认证机制获取访问权限 |
| `0x2E` | WriteDataByIdentifier | 按 DID 写入数据 |
| `0x31` | RoutineControl | 启动、停止或查询例程 |
| `0x34` | RequestDownload | 请求下载数据到 ECU |
| `0x36` | TransferData | 传输数据块 |
| `0x37` | RequestTransferExit | 结束数据传输 |
| `0x3E` | TesterPresent | 保持非默认会话 |

ECU 不需要支持全部服务。即使支持同一个 SID，不同会话、安全等级和寻址方式下允许执行的范围也可能不同。

### 肯定响应

大多数服务的肯定响应 SID 等于请求 SID 加 `0x40`：

```text
请求 SID：0x22
响应 SID：0x22 + 0x40 = 0x62
```

例如读取 VIN 常用 DID `0xF190`：

```text
请求：22 F1 90
响应：62 F1 90 <17 字节 VIN>
```

响应会回显 DID，客户端因此能把返回的数据和请求对象对应起来。

部分带子功能参数的服务允许客户端设置 `suppressPosRspMsgIndicationBit`，请求 ECU 执行服务但不发送肯定响应。该位通常是子功能字节的 bit 7。它只抑制肯定响应；执行失败时，ECU仍应按照服务规则返回否定响应。

### 否定响应与 NRC

否定响应采用统一格式：

```text
7F <请求 SID> <NRC>
```

例如：

```text
请求：22 F1 90
响应：7F 22 31
```

这里的 `0x31` 是 NRC（Negative Response Code）`requestOutOfRange`，表示请求参数超出 ECU 支持的范围。常见 NRC 包括：

| NRC | 名称 | 常见原因 |
| --- | --- | --- |
| `0x11` | serviceNotSupported | ECU 不支持该服务 |
| `0x12` | subFunctionNotSupported | 不支持该子功能 |
| `0x13` | incorrectMessageLengthOrInvalidFormat | 长度或格式错误 |
| `0x22` | conditionsNotCorrect | 当前条件不允许执行 |
| `0x24` | requestSequenceError | 服务调用顺序错误 |
| `0x31` | requestOutOfRange | DID、RID 或参数不支持 |
| `0x33` | securityAccessDenied | 尚未获得所需安全权限 |
| `0x35` | invalidKey | SecurityAccess 密钥错误 |
| `0x36` | exceedNumberOfAttempts | 错误尝试次数超限 |
| `0x37` | requiredTimeDelayNotExpired | 安全访问延时尚未结束 |
| `0x73` | wrongBlockSequenceCounter | 数据块序号不符合预期 |
| `0x78` | requestCorrectlyReceived-ResponsePending | 请求已接收，处理尚未完成 |
| `0x7E` | subFunctionNotSupportedInActiveSession | 当前会话不支持该子功能 |
| `0x7F` | serviceNotSupportedInActiveSession | 当前会话不支持该服务 |

`0x78` 很重要：它不是最终失败。ECU 用它告诉客户端“请求合法，但处理时间超过当前 P2 响应时间”。客户端收到后应继续等待最终响应，并按 P2* 约束管理超时。

## 物理寻址与功能寻址

UDS 请求通常分为两种寻址方式：

- **物理寻址**：明确发送给某一个 ECU，适合读取专属数据、执行控制和刷写。
- **功能寻址**：发送给满足某类功能的一组 ECU，常用于广播式查询或会话控制。

功能寻址可能让多个 ECU 同时处理请求，因此并非所有服务都适合通过功能寻址执行。下载、写数据和安全访问一类会改变 ECU 状态的操作通常采用物理寻址。寻址方式在 CAN 上往往体现为不同的 CAN ID，在 DoIP 中则由逻辑地址表达。

## 诊断会话与定时参数

### 为什么需要会话

ECU 不会在任何时候都开放所有诊断能力。DiagnosticSessionControl（`0x10`）用来切换服务集合和权限环境。常见会话包括：

| 子功能 | 会话 | 典型用途 |
| --- | --- | --- |
| `0x01` | defaultSession | 日常诊断与基础数据读取 |
| `0x02` | programmingSession | 软件刷写 |
| `0x03` | extendedDiagnosticSession | 执行增强诊断、标定或维护操作 |

具体会话及其允许的服务由 ECU 配置决定，不能只依据这个通用表硬编码客户端行为。

切换到非默认会话后，如果长时间没有诊断活动，ECU 通常会在 S3Server 超时后退回默认会话。客户端可以周期性发送 TesterPresent（`0x3E`）保持当前会话：

```text
请求：3E 00
响应：7E 00
```

### P2、P2* 与 S3

- **P2Server**：ECU 正常返回响应前允许的处理时间。
- **P2*Server**：ECU 发出 NRC `0x78` 后，返回下一条响应前允许的扩展处理时间。
- **S3Server**：非默认会话无诊断活动时的保持时间。

客户端的等待时间还要考虑网络传输和调度开销，不能把服务端定时值直接当成绝对超时值。进入新会话时，ECU 的肯定响应可以携带 P2 与 P2* 相关参数，客户端应按目标 ECU 的实际参数更新定时器。

## 三类常见诊断操作

### 读取 DID

DID（Data Identifier）是两个字节的数据标识符。ReadDataByIdentifier（`0x22`）可以在一个请求中携带一个或多个 DID：

```text
22 <DID_H> <DID_L> [<DID_H> <DID_L> ...]
```

ECU 的肯定响应为：

```text
62 <DID_H> <DID_L> <dataRecord> [...]
```

协议定义了报文结构，但 DID 对应的数据布局、长度、缩放和字节序通常来自项目诊断数据库。解析客户端不能仅凭 `0xF190` 以外的 DID 数值猜测数据类型。

### 读取 DTC

DTC（Diagnostic Trouble Code）记录 ECU 检测到的故障。ReadDTCInformation（`0x19`）通过子功能选择查询方式，例如按状态掩码读取 DTC、读取快照记录或扩展数据。

DTC 状态字节中的每一位表示一种状态，例如当前测试是否失败、本监控周期是否失败、故障是否已确认、请求点亮警告灯等。客户端应使用 ECU 返回的 `DTCStatusAvailabilityMask` 判断哪些状态位有效，而不是假定八个位全部受支持。

清除 DTC 使用 ClearDiagnosticInformation（`0x14`）。清除操作可能影响故障存储、快照和扩展数据，而且通常受会话、权限及车辆条件限制，因此不应在诊断工具启动时自动执行。

### 执行 Routine

RoutineControl（`0x31`）用于触发 ECU 内部的特定过程，例如擦除 Flash、校验镜像或执行执行器测试。请求由控制类型和 RID（Routine Identifier）组成：

```text
31 01 <RID_H> <RID_L> [optionRecord]  // startRoutine
31 02 <RID_H> <RID_L> [optionRecord]  // stopRoutine
31 03 <RID_H> <RID_L> [optionRecord]  // requestRoutineResults
```

例程可能是异步操作。耗时较长时，ECU 可以先返回 NRC `0x78`，随后给出最终响应；也可能要求客户端使用 `requestRoutineResults` 查询结果。两种行为需要以 ECU 诊断规范为准。

## SecurityAccess 的 Seed/Key 过程

受保护的写入、例程或刷写服务通常不能仅靠切换会话开放。传统的 SecurityAccess（`0x27`）采用 Seed/Key 交互：

```text
客户端 -> ECU：27 01                 // 请求 seed
ECU -> 客户端：67 01 <seed>

客户端 -> ECU：27 02 <key>           // 发送计算出的 key
ECU -> 客户端：67 02
```

通常奇数子功能请求 seed，紧随其后的偶数子功能发送 key，但具体安全等级、算法和数据长度由项目定义。实现时应特别注意：

- Key 算法本身不是 UDS 标准统一规定的。
- 连续发送错误 Key 会触发尝试次数限制和延时。
- ECU 复位后也可能保留失败计数或强制等待时间。
- “全零 seed”在部分实现中表示该安全等级已经解锁，但客户端必须依据项目规则解释。

对于新系统，还应评估 Authentication（`0x29`）等基于凭据的访问控制机制，不能把简单 Seed/Key 当作现代车辆安全边界的全部。

## UDS on CAN 为什么需要 ISO-TP

经典 CAN 单帧只有很小的数据空间，而一条 UDS 响应可能包含几十、几百甚至更多字节。ISO-TP 通过四种 PCI 帧完成分段传输：

- **Single Frame（SF）**：消息可以在一帧中发送完。
- **First Frame（FF）**：多帧消息的首帧，携带总长度和第一段数据。
- **Flow Control（FC）**：接收方通知发送方继续、等待或溢出，并给出块大小 BS 和最小帧间隔 STmin。
- **Consecutive Frame（CF）**：后续数据帧，携带循环递增的序号 SN。

一个多帧响应的交互大致如下：

```text
诊断仪                         ECU
   │                            │
   │  22 F1 90                  │
   │ ─────────────────────────> │
   │                            │
   │  First Frame               │
   │ <───────────────────────── │
   │                            │
   │  Flow Control (CTS)        │
   │ ─────────────────────────> │
   │                            │
   │  Consecutive Frame #1      │
   │ <───────────────────────── │
   │  Consecutive Frame #2 ...  │
   │ <───────────────────────── │
```

UDS 的 P2/P2* 和 ISO-TP 的 N_As、N_Ar、N_Bs、N_Br、N_Cs、N_Cr 属于不同层次的定时约束。实现中应分别维护，避免用一个“总超时”掩盖究竟是 ECU 服务处理超时，还是传输层流控超时。

## 一次典型刷写流程

不同 OEM 的刷写前置条件、例程编号和内存布局各不相同，但主流程通常可以抽象为：

```text
进入扩展会话（如果项目要求）
        │
检查电压、车速等刷写条件
        │
进入编程会话：10 02
        │
安全访问或身份认证：27 / 29
        │
执行擦除例程：31 01 <Erase RID>
        │
请求下载：34 ...
        │
循环发送数据块：36 <BSC> <data>
        │
结束传输：37 ...
        │
执行完整性校验例程：31 01 <Verify RID>
        │
ECU 复位：11 ...
```

RequestDownload（`0x34`）协商地址、长度以及数据格式后，ECU 会在肯定响应中给出可接受的数据块长度信息。TransferData（`0x36`）使用 BlockSequenceCounter 识别块顺序；计数器通常递增并在一个字节范围内回绕。客户端不能假定所有 ECU 都接受固定大小的数据块，也不能在超时后盲目递增块序号重发。

一个可靠的刷写器还应处理：

- ECU 对每个服务的会话和安全权限要求；
- `0x78` 带来的长耗时等待；
- 传输中断后的恢复或安全退出；
- 擦除、下载和校验例程的失败清理；
- 多 ECU 并行刷写时的总线负载和电源状态；
- 复位后软件版本、指纹和 DTC 的检查。

## ECU 端实现可以怎样分层

ECU 端不应把所有 SID 都塞进一个巨大的 `switch`。更容易维护的设计通常分为三层：

```text
传输与连接管理
  - 接收完整 UDS 请求
  - 管理物理/功能寻址和连接上下文
  - 管理 P2、P2*、S3 及发送

服务分发与权限检查
  - 查找 SID 和子功能处理器
  - 检查长度、会话、安全等级和寻址方式
  - 生成统一的肯定/否定响应

服务处理
  - 读取 DID、访问 DTC、执行 Routine
  - 调用存储、Bootloader、应用软件等后端
  - 支持异步完成和取消
```

AUTOSAR Classic 的 Dcm 也体现了类似职责划分：DSL 处理诊断通信和定时，DSD 负责服务分发与检查，DSP 执行具体诊断服务。即使项目不使用 AUTOSAR，这种边界仍值得参考。

对于多连接系统，还需要为每条诊断连接维护独立上下文，避免一个客户端切换会话或解锁安全等级后，意外把权限泄露给另一条连接。

## 调试时先检查什么

遇到“诊断不通”时，可以按层次排查：

1. **链路层**：CAN ID、波特率、扩展帧格式和收发方向是否正确。
2. **ISO-TP**：寻址格式、padding、STmin、BS、帧长和连续帧序号是否匹配。
3. **UDS 格式**：SID、子功能、DID/RID、报文长度是否正确。
4. **状态条件**：当前会话、安全等级、电压、车速和应用状态是否满足要求。
5. **定时**：客户端是否正确处理 `0x78`、P2* 和 S3，而不是过早超时或让会话回退。
6. **项目定义**：诊断数据库中的字节序、缩放、有效会话和 NRC 是否与 ECU 软件版本一致。

抓包时最好同时保留 CAN 原始帧和重组后的 UDS 消息。只看重组结果会遗漏流控问题，只看 CAN 帧又很难快速判断服务语义。

## 小结

理解 UDS 可以抓住四条主线：

- SID、肯定响应和 NRC 构成请求/响应语义；
- 会话、安全状态和车辆条件共同决定服务是否允许执行；
- P2、P2*、S3 管理诊断会话定时，ISO-TP 定时管理分段传输；
- DID、RID、安全算法和刷写细节最终都要落到具体项目诊断规范。

先把这些通用机制理顺，再去看某个 ECU 的诊断数据库或 Bootloader 代码，复杂的 UDS 报文就会从一串十六进制数字变成可追踪的状态机。

## 参考资料

- [ISO 14229-1:2026 — Unified diagnostic services, Part 1: Application layer](https://www.iso.org/standard/87962.html)
- [ISO 车载诊断、维护和测试设备标准目录](https://www.iso.org/ics/43.180/x/)
- [AUTOSAR Classic Platform — Specification of Diagnostic Communication Manager](https://www.autosar.org/fileadmin/standards/R23-11/CP/AUTOSAR_CP_SWS_DiagnosticCommunicationManager.pdf)
