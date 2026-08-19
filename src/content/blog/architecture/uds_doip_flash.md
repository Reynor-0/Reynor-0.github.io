---
title: 'UDS（二）：DoIP 刷写请求如何从以太网走到 Flash'
description: '沿着 Ethernet DMA、lwIP、SoAd、DoIP、UDS、更新状态机和 Flash 驱动，追踪一条刷写请求在 ECU 内部的完整数据路径。'
series: { id: 'uds-diagnostics', order: 2 }
tags: ['UDS', 'DoIP', 'Ethernet', 'lwIP', 'Flash', 'Bootloader']
pubDate: 'Aug 11 2026'
---

上一篇介绍了 UDS 的请求/响应、诊断会话、常用服务和基本刷写流程。这一篇继续向 ECU 内部走，研究一条 `TransferData (0x36)` 请求通过 DoIP 到达 ECU 后，究竟怎样从网卡接收缓冲区一路走到 Flash。

实际项目通常会包含专用模块名、生成代码、内存地址和硬件配置。本文保留其中通用的架构和数据流，模块名统一替换为职责名称，代码使用伪代码，地址和配置值也使用符号表示。

## 先看完整路径

从诊断仪到 Flash，可以把链路分成两段：

```text
第一段：把 UDS 报文送到诊断服务

Tester
  │ Ethernet Frame
  ▼
Ethernet MAC / DMA
  │ pbuf
  ▼
lwIP：Ethernet → IPv4 → TCP
  │ socket data
  ▼
SoAd
  │ DoIP message
  ▼
DoIP
  │ diagnostic PDU
  ▼
PduR / UDS Dispatcher


第二段：把刷写数据安全地写入 Flash

UDS 0x34 / 0x36 / 0x37
  │ transfer request
  ▼
Update Manager
  │ authorized storage request
  ▼
Storage Gateway / NvM
  │ erase / write / read
  ▼
Flash Abstraction
  │ hardware operation
  ▼
Flash Driver / MCAL
  │
  ▼
PFlash / DFlash
```

第一段解决的是协议问题：这帧数据属于哪个 TCP 连接、哪个 DoIP 逻辑地址、哪个 UDS 服务。

第二段解决的是刷写问题：当前状态能不能写、写到哪个分区、是否越界、如何排队、怎样校验，以及失败后怎样恢复。

这两段之间有一个很重要的边界：**收到 `0x36` 不等于已经写入 Flash**。UDS 层只知道收到了一块诊断数据，真正的写入通常由更新业务层和存储层协作完成。

## 四层拆信封

一条 DoIP 诊断消息到达 ECU 时，可以把它理解为四层信封：

```text
Ethernet
└── IPv4
    └── TCP
        └── DoIP
            └── UDS
```

每一层只做三类事情：

1. 拆掉自己认识的头；
2. 检查本层的合法性和状态；
3. 根据一个关键字段决定交给谁。

| 层次 | 主要检查 | 决定下一跳的字段 |
|---|---|---|
| Ethernet MAC/DMA | 描述符状态、帧状态、长度 | EtherType / VLAN |
| IPv4/TCP | IP 校验、连接状态、端口 | Protocol、目的端口 |
| DoIP | 通用头、连接、逻辑地址、路由激活 | Payload Type、Target Address |
| UDS | SID、长度、会话、安全权限 | SID、Sub-function、DID/RID |

例如，一条诊断消息在线上可以抽象为：

```text
[Ethernet Header]
[IPv4 Header]
[TCP Header: destination port = 13400]
[DoIP Header: payload type = 0x8001]
[Source Address]
[Target Address = <ECU_LOGICAL_ADDRESS>]
[UDS: 36 <BSC> <Transfer Data>]
```

下面从最外层开始逐层拆开。

## 第一层：Ethernet MAC 与 DMA 描述符环

### 为什么需要 DMA Ring

如果每收到几个字节都让 CPU 读取网卡寄存器，CPU 会把大量时间浪费在搬运数据上。常见 Ethernet MAC 使用 DMA 和描述符环：

```text
RX Descriptor Ring

desc[0] ──> buffer[0]
desc[1] ──> buffer[1]
desc[2] ──> buffer[2]
   ...
desc[N-1] -> buffer[N-1]
    ▲                 │
    └─────────────────┘
```

描述符记录缓冲区地址、长度和接收状态。硬件 DMA 把 Ethernet 帧写入 buffer，软件读取描述符并把数据交给协议栈。

硬件和软件必须约定当前谁可以访问一个描述符。不同 MAC 的位定义不同，但通常都有类似 OWN 的所有权位：

```text
OWN = HARDWARE：DMA 可以写，软件不能读
OWN = SOFTWARE：DMA 已完成，软件可以处理
```

它解决了环形队列中最核心的并发问题：硬件不能覆盖软件仍在使用的 buffer，软件也不能读取硬件尚未填完的 buffer。

### 零拷贝为什么要求延迟释放

在零拷贝接收模式下，驱动不会再申请一块内存复制帧，而是让 lwIP 的 `pbuf.payload` 直接指向 DMA buffer：

```c
/* 伪代码：从当前 RX 描述符取得一帧 */
pbuf_t *ethernet_rx_poll(rx_ring_t *ring)
{
    rx_desc_t *desc = ring->software_cursor;

    if (desc->owner == OWNER_HARDWARE) {
        return NULL;                    /* DMA 还没有交付新数据 */
    }

    if (desc->has_error) {
        recycle_rx_desc(ring, desc);
        return NULL;
    }

    /* payload 直接引用 DMA buffer，没有 memcpy */
    return pbuf_wrap_external(
        desc->buffer,
        desc->received_length,
        release_callback,
        desc
    );
}
```

这里不能在 `ethernet_rx_poll()` 返回前立刻把描述符还给 DMA。lwIP 仍然通过 `pbuf` 引用这个 buffer，如果硬件重新写入同一地址，上层看到的数据会在解析过程中被篡改。

正确的释放时机是 `pbuf` 的最后一个使用者释放它以后：

```c
/* 伪代码：pbuf 生命周期结束后归还 DMA 描述符 */
static void release_callback(void *context)
{
    rx_desc_t *desc = context;

    desc->owner = OWNER_HARDWARE;
    advance_software_cursor();
    update_dma_tail_pointer();
}
```

所以零拷贝的本质不仅是“少一次 memcpy”，还是一套跨驱动和协议栈的 buffer 所有权协议。

### 一帧可能跨多个描述符

当单个 DMA buffer 小于 Ethernet 帧时，一帧会被拆到多个描述符。驱动需要一直读取到 Last Descriptor 标志，再用 `pbuf` 链把各段连起来：

```text
pbuf A              pbuf B              pbuf C
payload -> buffer0  payload -> buffer1  payload -> buffer2
len = part0         len = part1         len = part2
next ─────────────> next ─────────────> NULL
tot_len = 完整帧长  tot_len = 剩余长度  tot_len = part2
```

上层看到的是一条逻辑完整的报文，不需要知道它占了几个 DMA 描述符。但这也意味着，协议栈长时间持有一个大包时，可能同时占用多个 RX 描述符。

## 第二层：lwIP 怎样拆 IP 和 TCP

### 收包线程和协议栈线程分开

驱动拿到 `pbuf` 后，常见做法不是在当前线程中一直解析到 TCP，而是调用 `tcpip_input()` 把报文投递给 lwIP 的消息队列：

```c
/* 伪代码：Ethernet 输入任务 */
void ethernet_input_task(void)
{
    for (;;) {
        pbuf_t *p = ethernet_rx_poll(&rx_ring);
        if (p != NULL) {
            tcpip_input(p, &netif);      /* 投递给 tcpip_thread */
        }
    }
}
```

`tcpip_input()` 的重点是入队，不是在调用者线程里完成全部 IP 解析。随后 `tcpip_thread` 从消息队列取出 `pbuf`：

```text
Ethernet RX task
      │ tcpip_input(pbuf)
      ▼
lwIP mailbox
      │
      ▼
tcpip_thread
      │
      ├── ethernet_input：判断 IPv4 / ARP / IPv6
      ├── ip4_input：检查 IPv4 头和 Protocol
      └── tcp_input：查找 TCP PCB 和目的端口
```

这样做的好处是把快速收包和复杂协议处理拆开。驱动任务可以尽快回到 RX Ring，TCP/IP 状态机则集中在 lwIP 的核心线程中运行。

### 端口 13400 把数据交给 DoIP

DoIP 使用 TCP/UDP 端口 13400。TCP 层完成序号、重传、乱序重组和连接状态处理后，把连续字节流放入对应 socket 的接收队列。

需要注意：TCP 提供的是字节流，不保留 `send()` 的消息边界。一次 `recv()` 可能只拿到半个 DoIP 报文，也可能同时拿到多个 DoIP 报文：

```text
第一次 recv： [DoIP Header][一部分 Payload]
第二次 recv： [剩余 Payload][下一个 DoIP Header][下一个 Payload]
```

因此 DoIP 层不能假定“一次 socket 接收就是一条完整 DoIP 消息”，必须使用通用头中的 Payload Length 做缓存和组帧。

## 第三层：SoAd 与 DoIP

### SoAd 为什么存在

SoAd（Socket Adaptor）位于 TCP/IP 栈与上层协议之间。它的作用不是再次实现 TCP，而是统一 socket 的创建、绑定、连接、收发和事件分发，使 DoIP 等上层模块不直接依赖某一个 TCP/IP 栈的 API。

在一种基于 BSD socket 的实现中，SoAd 的接收线程大致如下：

```c
/* 伪代码：SoAd TCP 接收循环 */
void socket_rx_task(connection_t *conn)
{
    uint8_t buffer[SOCKET_RX_SIZE];

    for (;;) {
        int len = socket_recv(conn->fd, buffer, sizeof(buffer));
        if (len > 0) {
            conn->upper_layer.on_tcp_data(conn->id, buffer, len);
        } else if (len == 0) {
            notify_connection_closed(conn);
            break;
        } else {
            handle_socket_error(conn);
        }
    }
}
```

有些实现采用回调或零拷贝接口，数据流方向会不同。重要的不是“必须主动拉还是被动推”，而是 SoAd 要把 TCP/IP 栈的连接语义转换成 DoIP 能使用的统一接口。

### UDP 发现与 TCP 诊断不要混在一起

DoIP 同时使用 UDP 和 TCP，但职责不同：

| 通道 | 典型用途 | 典型 Payload Type |
|---|---|---|
| UDP | 车辆发现、车辆公告、实体状态查询 | `0x0001`、`0x0002`、`0x0003` 等 |
| TCP | 路由激活、诊断消息、存活检查 | `0x0005`、`0x8001` 等 |

一次典型建链过程是：

```text
Tester                              DoIP ECU
  │                                    │
  │ UDP Vehicle Identification         │
  │ ─────────────────────────────────> │
  │ <───────────────────────────────── │
  │ UDP Vehicle Identification Response│
  │                                    │
  │ TCP Connect :13400                 │
  │ ─────────────────────────────────> │
  │                                    │
  │ Routing Activation Request 0x0005  │
  │ ─────────────────────────────────> │
  │ <───────────────────────────────── │
  │ Routing Activation Response 0x0006 │
  │                                    │
  │ Diagnostic Message 0x8001          │
  │ ─────────────────────────────────> │
```

车辆发现可以根据项目场景省略，例如诊断仪已经通过配置知道 ECU 的 IP 地址。但 TCP 连接上的路由激活是后续诊断路由的重要门槛，不能把它当成 UDP 发现的一部分。

### DoIP 通用头

DoIP 消息以前 8 字节作为通用头：

```text
Byte 0      Protocol Version
Byte 1      Inverse Protocol Version
Byte 2..3   Payload Type
Byte 4..7   Payload Length
Byte 8..    Payload
```

解析器至少需要完成以下检查：

```c
/* 伪代码：DoIP 通用头解析 */
doip_result_t parse_doip_message(const uint8_t *data, size_t len)
{
    if (len < DOIP_HEADER_SIZE) {
        return NEED_MORE_DATA;
    }

    doip_header_t h = {
        .version         = data[0],
        .inverse_version = data[1],
        .payload_type    = read_be16(&data[2]),
        .payload_length  = read_be32(&data[4]),
    };

    if ((h.version ^ h.inverse_version) != 0xFFu) {
        return INVALID_PROTOCOL_VERSION;
    }

    if (h.payload_length > DOIP_MAX_PAYLOAD) {
        return MESSAGE_TOO_LARGE;
    }

    if (len < DOIP_HEADER_SIZE + h.payload_length) {
        return NEED_MORE_DATA;
    }

    return dispatch_by_payload_type(&h, &data[8]);
}
```

Payload Length 一定要在做指针偏移和内存复制之前验证，否则一个伪造长度就可能造成越界读取、超大内存申请或连接长期占用。

### 诊断消息怎样找到目标 ECU

DoIP Diagnostic Message 的 Payload Type 是 `0x8001`，其负载从源逻辑地址和目标逻辑地址开始：

```text
[Source Address, 2B]
[Target Address, 2B]
[User Data = UDS Request]
```

处理流程可以抽象为：

```c
/* 伪代码：处理 DoIP 诊断消息 */
doip_result_t process_diagnostic_message(
    tcp_connection_t *conn,
    const uint8_t *payload,
    size_t payload_len)
{
    if (payload_len < 4u) {
        return DOIP_INVALID_PAYLOAD_LENGTH;
    }

    uint16_t source = read_be16(&payload[0]);
    uint16_t target = read_be16(&payload[2]);

    if (!conn->routing_active) {
        return DOIP_ROUTING_NOT_ACTIVE;
    }

    if (conn->registered_source != source) {
        return DOIP_INVALID_SOURCE_ADDRESS;
    }

    route_t *route = find_diagnostic_route(source, target);
    if (route == NULL) {
        return DOIP_UNKNOWN_TARGET_ADDRESS;
    }

    pdu_t uds_request = {
        .data = &payload[4],
        .length = payload_len - 4u,
    };

    return pdur_receive(route->rx_pdu_id, &uds_request);
}
```

这里有三道不同的门：

1. 当前 TCP 连接是否完成路由激活；
2. 报文中的 Source Address 是否属于这条连接；
3. Source/Target 组合是否存在有效路由。

通过这些检查以后，DoIP 才把 UDS 数据交给 PduR 或项目中的等价路由模块。

### DoIP ACK 不等于刷写成功

DoIP 可以对 Diagnostic Message 返回 Positive Acknowledgement（Payload Type `0x8002`）或 Negative Acknowledgement（`0x8003`）。它们表达的是 DoIP 层是否接受并路由这条诊断消息。

```text
DoIP Positive ACK：这条 DoIP 诊断消息被本层接受
UDS Positive Response：这个 UDS 服务执行成功
Flash 写入完成：底层存储操作已经成功结束
```

这三个时刻可能相差很远。诊断仪收到 DoIP Positive ACK 后，仍然必须等待 UDS 响应，不能把它当作当前数据块已经写入 Flash。

## 第四层：UDS 服务分发

PduR 根据 Rx PDU ID 把数据交给对应诊断连接。UDS 分发器取第一个字节作为 SID，然后检查长度、寻址方式、当前会话和安全状态。

```c
/* 伪代码：UDS 服务分发 */
uds_response_t uds_dispatch(connection_t *conn, const pdu_t *request)
{
    if (request->length == 0u) {
        return negative_response(0x00, NRC_INCORRECT_LENGTH);
    }

    uint8_t sid = request->data[0];
    const service_config_t *service = find_service(sid);

    if (service == NULL) {
        return negative_response(sid, NRC_SERVICE_NOT_SUPPORTED);
    }
    if (!service->addressing_mask.allows(conn->addressing_type)) {
        return apply_functional_addressing_rule(sid);
    }
    if (!service->session_mask.allows(conn->session)) {
        return negative_response(sid, NRC_SERVICE_NOT_SUPPORTED_IN_SESSION);
    }
    if (!service->security_mask.allows(conn->security_level)) {
        return negative_response(sid, NRC_SECURITY_ACCESS_DENIED);
    }

    return service->handler(conn, request);
}
```

量产项目经常从诊断配置生成服务表和分发代码。这样做的价值不是省掉一个 `switch`，而是让“服务—会话—安全等级—寻址方式”的约束有统一数据源。

刷写相关服务通常具有类似关系：

| SID | 服务 | 常见约束 |
|---|---|---|
| `0x10` | DiagnosticSessionControl | 用于进入扩展或编程会话 |
| `0x27` / `0x29` | SecurityAccess / Authentication | 解锁受保护的刷写能力 |
| `0x31` | RoutineControl | 检查条件、擦除、校验 |
| `0x34` | RequestDownload | 通常只在编程会话开放 |
| `0x36` | TransferData | 必须已经成功执行 `0x34` |
| `0x37` | RequestTransferExit | 必须存在进行中的下载序列 |
| `0x11` | ECUReset | 刷写和激活完成后复位 |

具体权限以 ECU 诊断规范为准，不能把某个项目生成的 session mask 直接复制到另一个 ECU。

## 0x34、0x36、0x37 是一套状态机

### RequestDownload 建立传输上下文

RequestDownload（`0x34`）不是开始发送固件本身，而是协商接下来要传什么：

```text
[0x34]
[Data Format Identifier]
[Address And Length Format Identifier]
[Memory Address]
[Memory Size]
```

ECU 需要解析地址和长度，然后检查：

- 当前会话和安全权限是否允许下载；
- 目标地址是否落在允许更新的逻辑分区；
- 地址加长度是否溢出或越界；
- 目标分区是否与当前运行区冲突；
- 是否已经存在另一个未结束的下载；
- 数据格式、压缩或加密方式是否受支持。

成功后，ECU 创建一个传输上下文，并在响应中告诉诊断仪允许的最大块长度。

```c
/* 伪代码：建立下载上下文 */
uds_response_t handle_request_download(const download_request_t *req)
{
    if (!is_supported_data_format(req->data_format)) {
        return nrc(NRC_REQUEST_OUT_OF_RANGE);
    }

    logical_partition_t *part = map_logical_address(
        req->memory_address,
        req->memory_size
    );
    if (part == NULL || !part->download_allowed) {
        return nrc(NRC_REQUEST_OUT_OF_RANGE);
    }

    if (!programming_conditions_are_valid()) {
        return nrc(NRC_CONDITIONS_NOT_CORRECT);
    }

    transfer_context = (transfer_context_t) {
        .state = TRANSFER_READY,
        .partition = part,
        .total_size = req->memory_size,
        .received_size = 0u,
        .expected_bsc = 1u,
    };

    return positive_request_download(MAX_TRANSFER_BLOCK_LENGTH);
}
```

外部诊断地址最好先映射为“逻辑分区 + 分区内偏移”，不要让未经验证的外部地址直接进入 Flash 驱动。

### TransferData 接收数据块

TransferData（`0x36`）请求由块序号 BSC（BlockSequenceCounter）和数据组成：

```text
[0x36][BSC][Transfer Data]
```

BSC 用来发现丢块、乱序和重复请求。服务处理需要验证状态、序号、长度和累计偏移：

```c
/* 伪代码：处理一个 TransferData 数据块 */
uds_response_t handle_transfer_data(const uint8_t *req, size_t len)
{
    if (transfer_context.state != TRANSFER_READY &&
        transfer_context.state != TRANSFER_IN_PROGRESS) {
        return nrc(NRC_REQUEST_SEQUENCE_ERROR);
    }

    if (len < TRANSFER_DATA_MIN_LENGTH) {
        return nrc(NRC_INCORRECT_LENGTH);
    }

    uint8_t bsc = req[1];
    const uint8_t *data = &req[2];
    size_t data_len = len - 2u;

    if (bsc != transfer_context.expected_bsc) {
        return nrc(NRC_WRONG_BLOCK_SEQUENCE_COUNTER);
    }

    if (data_len > remaining_download_size(&transfer_context)) {
        return nrc(NRC_REQUEST_OUT_OF_RANGE);
    }

    update_result_t result = update_submit_block(
        transfer_context.partition,
        transfer_context.received_size,
        data,
        data_len
    );

    if (result == UPDATE_PENDING) {
        return response_pending();      /* NRC 0x78，最终仍要响应 */
    }
    if (result != UPDATE_OK) {
        return nrc(NRC_GENERAL_PROGRAMMING_FAILURE);
    }

    transfer_context.received_size += data_len;
    transfer_context.expected_bsc++;
    transfer_context.state = TRANSFER_IN_PROGRESS;

    return positive_transfer_data(bsc); /* 0x76 + BSC */
}
```

真实实现还要定义重复块的处理策略。例如肯定响应在网络上丢失后，诊断仪可能重发相同 BSC；ECU 需要区分“合法重试”和“真正乱序”，避免同一块被重复写入错误位置。

### 什么时候可以回复 0x76

这是整条链路最值得明确的语义边界。常见选择有两种：

1. 数据已经成功写入目标存储后，再返回 `0x76`；
2. 数据已经被可靠复制到 ECU 自有队列，后续失败有完整状态和错误上报机制时，提前返回 `0x76`。

第一种语义简单，但 Flash 写入较慢时容易超过 P2。此时可以先发 NRC `0x78`，等待异步写入完成后再返回最终响应。

第二种吞吐更高，但必须保证队列中的数据不会因原始网络 buffer 释放、任务复位或并发覆盖而丢失。不能只保存一个指向 `pbuf.payload` 的裸指针，然后立即释放 `pbuf`。

### RequestTransferExit 收口

RequestTransferExit（`0x37`）表示诊断仪不再发送新的数据块。ECU 至少要确认：

- 已接收长度是否与 `0x34` 声明的长度一致；
- 所有异步写请求是否完成；
- 尾部缓存是否已经 flush；
- 是否满足项目定义的完整性检查条件。

完整镜像校验也可以由后续 `RoutineControl (0x31)` 执行。关键是把“传输结束”和“镜像验证通过”定义为两个清晰状态，不要因为收到 `0x37` 就直接把新镜像标记为可启动。

## 最后一公里：为什么还要经过更新层和存储层

UDS 层直接调用 Flash 驱动在技术上并非做不到，但复杂 ECU 通常会继续分层：

| 层次 | 主要职责 | 不应承担的职责 |
|---|---|---|
| UDS Service | 检查 SID、长度、BSC、会话和响应语义 | 决定物理 Flash 扇区布局 |
| Update Manager | 管理下载状态机、分区、擦写顺序、校验和激活 | 解析 Ethernet/DoIP 报文 |
| Storage Gateway | 排队、互斥、授权和多客户端协调 | 理解 UDS SID |
| Flash Abstraction | 为不同存储介质提供统一操作 | 决定诊断会话 |
| Flash Driver / MCAL | 执行寄存器级擦写并报告硬件结果 | 决定软件镜像是否可信 |

这不是 ISO 14229 强制规定的唯一架构，而是一种常见的职责分离方式。它带来三个实际收益：

1. OTA、诊断刷写和本地维护可以复用同一套更新与存储能力；
2. 所有 Flash 写入经过统一的分区检查、互斥和授权；
3. UDS、更新策略与具体 Flash 芯片可以独立演进。

### Update Manager 是业务状态机

更新层通常维护比 UDS 更完整的状态：

```text
IDLE
  │ 检查刷写前置条件
  ▼
PRECONDITION_OK
  │ 擦除目标分区
  ▼
DOWNLOAD_READY
  │ 接收并写入数据块
  ▼
TRANSFERRING
  │ 收到全部数据
  ▼
VERIFYING
  │ 签名/哈希/完整性验证通过
  ▼
ACTIVATION_PENDING
  │ 更新启动元数据
  ▼
READY_TO_RESET
```

UDS 只触发状态转换。真正决定“当前能否擦除”“写哪个槽位”“校验失败后回滚到哪里”的是更新状态机。

### Storage Gateway 统一 Flash 写入口

当多个应用都可能写非易失性存储时，需要统一入口解决并发：

```c
/* 伪代码：提交带授权上下文的存储请求 */
storage_result_t submit_flash_write(
    update_session_t session,
    partition_id_t partition,
    uint32_t offset,
    const uint8_t *owned_data,
    size_t length)
{
    if (!session_is_authorized(session, partition)) {
        return STORAGE_ACCESS_DENIED;
    }
    if (!range_is_inside_partition(partition, offset, length)) {
        return STORAGE_OUT_OF_RANGE;
    }
    if (!request_queue_has_capacity()) {
        return STORAGE_BUSY;
    }

    return enqueue_storage_request(session, partition, offset,
                                   owned_data, length);
}
```

授权句柄只表达“哪个已验证的更新会话可以访问哪个逻辑分区”，不应包含可复用的固定密钥，也不应直接暴露物理地址给网络侧。

### 函数指针隔离不同 Flash 后端

底层经常使用操作表适配 Code Flash、Data Flash、外部 NOR Flash 或测试替身：

```c
/* 伪代码：Flash 后端接口 */
typedef struct {
    flash_result_t (*erase)(uint32_t offset, size_t length);
    flash_result_t (*write)(uint32_t offset,
                            const uint8_t *data,
                            size_t length);
    flash_result_t (*read)(uint32_t offset,
                           uint8_t *data,
                           size_t length);
} flash_backend_ops_t;

typedef struct {
    const flash_backend_ops_t *ops;
    partition_layout_t layout;
    void *driver_context;
} flash_backend_t;
```

上层只依赖 `erase/write/read` 语义，具体寄存器时序、对齐粒度和扇区大小留在对应后端中。单元测试还可以注册 RAM 后端，验证更新状态机而不需要真实 Flash。

## 一块 0x36 数据的完整闭环

把前面的层次串起来，一块数据的执行顺序如下：

```text
Tester
  │ 0x36 + BSC + Data
  ▼
Ethernet DMA
  │ DMA 完成，描述符所有权交给软件
  ▼
Driver / pbuf
  │ 组帧并投递 tcpip_input
  ▼
lwIP tcpip_thread
  │ 解析 IPv4/TCP，交付端口 13400 的字节流
  ▼
SoAd
  │ 完成 DoIP 消息组帧
  ▼
DoIP
  │ 校验通用头、路由激活、Source/Target Address
  ▼
PduR / UDS Dispatcher
  │ 校验 SID、会话、安全权限、BSC 和长度
  ▼
Update Manager
  │ 校验状态和逻辑分区，获得数据所有权
  ▼
Storage Gateway
  │ 排队、授权、范围检查
  ▼
Flash Backend
  │ 擦写对齐、硬件操作、完成回调
  ▼
Update Manager
  │ 更新偏移和状态
  ▼
UDS
  │ 76 + BSC
  ▼
DoIP / TCP / IP / Ethernet
  │
  ▼
Tester
```

这里的响应方向与请求方向正好相反。底层错误也要逐层翻译，例如 Flash 写失败先变成更新层错误，再映射为 UDS 的 `generalProgrammingFailure (0x72)` 或项目规定的其他响应。

## Buffer 所有权贯穿整条链路

这条路径上至少存在三种不同生命周期的 buffer：

| Buffer | 所有者 | 生命周期 |
|---|---|---|
| DMA RX buffer | Ethernet Driver / DMA | 从硬件交付到 pbuf 释放 |
| TCP/DoIP receive buffer | lwIP / SoAd | 从字节流组帧到上层处理完成 |
| Update block buffer | Update Manager / Storage | 从接收数据块到 Flash 写完成 |

如果更新写入是异步的，UDS 层必须完成一次受控的所有权转移：

```text
错误做法：保存 data 指针 → 返回 → pbuf 被释放 → 异步任务继续使用悬空指针

正确做法 A：复制到更新层自有 buffer，再释放网络 buffer
正确做法 B：增加引用计数，把原 buffer 生命周期延长到写完成
```

工程中更常见的是 A，因为 DMA buffer 数量有限。让一次耗时 Flash 写长期占用 RX Ring，会让网络接收端很快失去描述符，最终形成丢包或连接停顿。

这也解释了为什么“网络零拷贝”不等于“从网卡到 Flash 全程零拷贝”。在跨越异步任务和不同生命周期边界时，一次明确的复制往往更安全。

## 背压怎样从 Flash 传回 Tester

Flash 写入速度可能低于 Ethernet 接收速度。如果诊断仪持续高速发送数据，而 ECU 不限制在途数据量，就会依次填满：

```text
Flash request queue
        ↑
Update block buffers
        ↑
SoAd / TCP receive buffers
        ↑
lwIP TCP receive window
        ↑
Tester send window
```

一个稳健实现会组合使用：

- UDS 层一次只接受允许数量的未完成 `0x36` 请求；
- ECU 在 `0x34` 响应中给出适合自身 RAM 和 Flash 能力的块长度；
- 更新队列满时不再无界复制数据；
- TCP 接收窗口自然收缩，限制发送端速率；
- 长耗时服务使用 `0x78` 延长等待，但最终必须返回肯定或否定响应。

硬件 RX Descriptor Tail Pointer 也属于最底层背压机制：只有软件归还描述符后，DMA 才能继续使用对应 buffer。但它是最后防线，不应依赖耗尽 DMA Ring 来调节正常刷写流量。

## 一次完整刷写不只有 0x36

从业务角度看，完整流程通常是：

```text
建立 TCP 连接并完成 DoIP Routing Activation
        │
        ▼
0x10：进入扩展/编程会话
        │
        ▼
0x27 或 0x29：获得刷写权限
        │
        ▼
0x31：检查前置条件、擦除目标分区
        │
        ▼
0x34：声明下载地址、长度和数据格式
        │
        ▼
0x36：循环传输数据块
        │
        ▼
0x37：结束传输并清空尾部数据
        │
        ▼
0x31：执行完整性/真实性校验并准备激活
        │
        ▼
0x11：复位 ECU，进入新软件或 Bootloader 决策流程
```

项目还可能在刷写期间关闭部分普通通信或 DTC 记录，并周期性发送 TesterPresent。具体顺序、服务参数、超时和恢复策略必须来自项目刷写规范。

## 分层错误怎样定位

当诊断仪报告“刷写失败”时，不要直接从 Flash 驱动开始猜。不同层的失败有不同表现：

| 层次 | 典型现象 | 优先检查 |
|---|---|---|
| Ethernet/DMA | 没有帧、RX error、描述符耗尽 | MAC 统计、OWN、Tail Pointer、VLAN |
| IPv4/TCP | 连接超时、RST、窗口长期为零 | IP、端口、PCB、TCP 抓包 |
| SoAd | socket 已关闭、消息组帧停滞 | recv 长度、连接状态、缓存游标 |
| DoIP | Generic NACK、Diagnostic NACK、连接被关闭 | Payload Length、路由激活、逻辑地址 |
| UDS | `7F <SID> <NRC>` | 会话、安全等级、顺序、BSC |
| Update Manager | 长期 `0x78` 或最终编程失败 | 更新状态、分区、累计长度、队列 |
| Flash | 擦写失败、校验不一致 | 对齐、供电、扇区保护、驱动返回值 |

建议给一次下载建立内部 Trace ID，并把以下字段串起来：

```text
TCP Connection ID
DoIP Source / Target Address
UDS SID
Download Session ID
Block Sequence Counter
Logical Partition + Offset
Storage Request ID
Flash Driver Result
```

这样既可以端到端定位，又不需要在对外博客或普通日志中暴露物理地址、密钥、私有路径和生成代码细节。

## 这条链路体现的架构模式

### 每层只拆自己的信封

Ethernet 驱动不理解 SID，DoIP 不关心 Flash 扇区，Flash 驱动也不判断诊断会话。边界清楚以后，每一层都可以单独测试。

### 协议状态和业务状态分开

UDS 的编程会话与 Update Manager 的下载状态相关，但不是同一个状态机。会话回答“当前允许哪些服务”，更新状态回答“镜像已经执行到哪一步”。

### 快路径与慢路径分开

Ethernet 接收、TCP 解析属于快路径，Flash 擦写属于慢路径。队列、异步完成和 buffer 所有权把两者隔开，避免 Flash 操作阻塞网络线程。

### 配置生成与运行时分发结合

诊断服务表、PDU 路由和逻辑地址适合由配置生成；运行时仍由统一分发器检查当前连接、会话和权限。生成代码不应绕过边界检查。

### 接口加操作表隔离硬件

更新层面向逻辑分区和通用存储接口，具体 PFlash/DFlash 差异由操作表和驱动后端处理。这种方式也方便使用 RAM 后端做自动化测试。

## 小结

一条 DoIP 刷写请求并不是从 socket 直接跳到 Flash。它先经过 Ethernet DMA、pbuf、lwIP、SoAd 和 DoIP，完成网络层与诊断路由；进入 UDS 后，再由更新状态机、存储入口和 Flash 抽象逐步落盘。

理解这条链路时，最重要的是抓住五个问题：

1. 当前数据在哪一层，它的外层头是否已经被拆掉；
2. 谁拥有当前 buffer，什么时候可以释放；
3. 当前通过的是 DoIP 连接状态、UDS 会话状态，还是更新业务状态；
4. 当前响应表示消息被路由、服务仍在处理，还是 Flash 已经写完；
5. 慢速 Flash 如何通过队列、UDS 流程和 TCP 窗口向 Tester 形成背压。

把每个问题落到对应模块后，几百个函数组成的刷写链路就不再是一条混乱的调用栈，而是一组边界清楚、可以逐层验证的状态机。

## 参考资料

- [ISO 13400-2:2025 — Diagnostic communication over Internet Protocol](https://www.iso.org/standard/13400-2)
- [ISO 14229-1:2026 — Unified diagnostic services, Part 1](https://www.iso.org/standard/87962.html)
- [AUTOSAR Classic Platform — Specification of Diagnostic over IP](https://www.autosar.org/fileadmin/standards/R24-11/CP/AUTOSAR_CP_SWS_DiagnosticOverIP.pdf)
- [AUTOSAR Classic Platform — Specification of Diagnostic Communication Manager](https://www.autosar.org/fileadmin/standards/R23-11/CP/AUTOSAR_CP_SWS_DiagnosticCommunicationManager.pdf)
