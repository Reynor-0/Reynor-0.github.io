---
title: '车载以太网（一）：以太网帧与 VLAN'
description: '从 Ethernet II 帧、802.1Q、Q-in-Q 到 lwIP VLAN 收发路径，建立车载以太网二层帧与 VLAN 基础。'
series: { id: 'vehicle-ethernet', order: 1 }
tags: ['Ethernet', 'VLAN', 'lwIP', '汽车电子']
pubDate: 'Jun 08 2026'
updatedDate: 'Aug 05 2026'
---

这一篇从线上真实传输的 Ethernet II 帧开始，逐步说明 802.1Q VLAN、Q-in-Q，以及这些字段在 lwIP 收发路径中如何落到代码。

## 标准的 Ethernet II 帧

标准 Ethernet II 帧是目前以太网中最常见的二层帧格式。它通过 EtherType 字段标识上层协议，例如 IPv4、ARP、IPv6。例如以下的形式：
```
| 前导码 | SFD | 目的MAC | 源MAC | EtherType |       数据载荷       | FCS |
|  7B   | 1B  |   6B   |  6B   |    2B     |      46~1500B       | 4B  |
```
### 各字段含义

**前导码 Preamble 7B**

七个字节，用于发送端和接收端进行时钟同步。它属于物理层的传输内容，很多资料在计算“以太网帧长度”的时候，不会把前导码计算在内。

**帧起始定界符 SFD  1B**

SFD 即 Start Frame Delimiter，表示前导码结束，真正的 MAC 帧即将开始。

**目的MAC地址 6B**

表示该帧要发送给哪个设备，例如：
```
00:11:22:33:44:55
```

目的 MAC 可以是单播地址、组播地址、广播地址，分别对应发送给一个设备，发送给一组设备，发送给局域网内所有设备。广播MAC地址为：
```
FF:FF:FF:FF:FF:FF
```

**源MAC地址 6B**

表示该帧由哪个设备发送，例如：
```
AA:BB:CC:DD:EE:FF
```

通常源MAC地址必须是单播地址，不能使用广播地址

**EtherType 2B**

EtherType 用于表示数据载荷中封装的上层协议。常见的取值有：

| EtherType | 上层协议          |
| --------- | ------------- |
| `0x0800`  | IPv4          |
| `0x0806`  | ARP           |
| `0x86DD`  | IPv6          |
| `0x8100`  | 802.1Q VLAN   |
| `0x88CC`  | LLDP          |
| `0x88F7`  | IEEE 1588 PTP |

例如 08 00就表示后面的数据是一个IPv4的数据包。需要注意的是，以太网在线上传输多字节数据时采用网络字节序，也就是高字节在前面，因此`0x0800`在线上的表现为08 00。

**数据载荷 Payload 46~1500B**

这里通常封装这网络层协议的具体数据，例如：
```
Ethernet II
└── IPv4
    └── UDP
        └── 应用层数据
```

标准以太网的MTU通常是1500B，也就是说，Ethernet II帧数据字段最大通常为1500B。如果上层数据不足46B，MAC层需要添加Padding，以保证帧达到最小长度要求。

**FCS 4B**

FCS， Frame Check Sequence，它使用CRC-32对以下的内容进行校验：
```
目的 MAC
+ 源 MAC
+ EtherType
+ 数据和填充
```

接收端重新计算 CRC，如果结果不一致，则说明帧在传输过程中发生了错误，通常会直接丢弃。FCS 不覆盖前导码和 SFD。在使用 Wireshark 抓包时，经常看不到 FCS，因为很多网卡会在硬件层完成 CRC 校验，然后在将数据交给操作系统之前去掉 FCS。

### Ethernet II 帧长度

通常所说的 Ethernet II 帧长度，是从目的 MAC 到 FCS：
```
目的MAC 6
+ 源MAC 6
+ EtherType 2
+ 数据 46~1500
+ FCS 4
```
因此：
```
最小帧长度 = 6 + 6 + 2 + 46 + 4 = 64 字节
最大帧长度 = 6 + 6 + 2 + 1500 + 4 = 1518 字节
```

### 帧间间隔 IFG

Inter-Frame Gap，帧间间隔。两个以太网帧之间还需要保留帧间间隔，标准 IFG 对应 96 bit time，也就是 12 字节传输时间。它不是帧的一部分，但计算链路实际带宽占用时需要考虑。

## 带 VLAN 的 Ethernet II 帧

如果使用 IEEE 802.1Q VLAN，源 MAC 后面会插入 4 字节 VLAN Tag：
```
| 目的MAC | 源MAC | TPID | TCI | EtherType | 数据 | FCS |
|   6B   |  6B   | 2B   | 2B  |    2B     | ...  | 4B  |
```

其中：

- TPID 通常为 0x8100
- TCI 包含 VLAN ID、优先级等信息
- 后面的 EtherType 才表示真正的上层协议

该VLAN Tag的整体布局可以参考以下的形式：
```
字节偏移：       Byte 0       Byte 1       Byte 2       Byte 3
              +------------+------------+------------+------------+
内容：        |    TPID 高字节    |    TPID 低字节    |      TCI       |
              +------------+------------+------------+------------+

位布局：
              31                         16 15                    0
              +----------------------------+----------------------+
              |        TPID 16 bit         |      TCI 16 bit      |
              +----------------------------+----------------------+

TCI：
              15          13 12          12 11                   0
              +-------------+--------------+----------------------+
              | PCP 3 bit   | DEI 1 bit    | VID 12 bit           |
              +-------------+--------------+----------------------+
```

**TPID: Tag Protocol Identifier**
TPID长度为16bit，通常是0x8100。她出现在原本EtherType所在的位置，用于让接收端判断，该以太网帧包含一个IEEE 802.1Q VLAN 标签。
例如，原始 IPv4 Ethernet II 帧：

```
目的 MAC
源 MAC
08 00        // EtherType = IPv4
IPv4 数据
```

添加了VLAN之后：

```
目的 MAC
源 MAC
81 00        // TPID，表示存在 VLAN Tag
TCI
08 00        // 原来的 EtherType，仍然表示 IPv4
IPv4 数据
```

所以看到 0x8100 后，不能马上把后面的数据当成 IPv4。必须先读取后面的 2 字节 TCI，再读取真正的 EtherType。

**TCI: Tag Control Information**

TCI 是 16 bit，内部结构为：

```
15          13 12       12 11                            0
+-------------+-----------+--------------------------------+
| PCP 3 bit   | DEI 1 bit | VID 12 bit                     |
+-------------+-----------+--------------------------------+
```

在C语言中可以这样写：
```c
tci = (pcp << 13) | (dei << 12) | vid;

pcp = (tci >> 13) & 0x07;
dei = (tci >> 12) & 0x01;
vid = tci & 0x0FFF;
```

**PCP：Priority Code Point**

PCP占了3 bit，取值范围为0~7，用于表示以太网帧的二层优先级。PCP 本身并不直接决定数据一定先发送，而是由交换机根据 PCP 值，将帧映射到不同的发送队列或流量类别。常见理解如下：
| PCP | 典型含义                     | 常见场景      |
| --: | ------------------------ | --------- |
|   0 | Best Effort              | 普通数据      |
|   1 | Background               | 后台低优先级流量  |
|   2 | Spare / Excellent Effort | 具体由网络配置决定 |
|   3 | Critical Applications    | 关键业务      |
|   4 | Video                    | 视频、受控延迟流量 |
|   5 | Voice                    | 语音、低延迟流量  |
|   6 | Internetwork Control     | 网络控制      |
|   7 | Network Control          | 最高级网络控制   |

这张表只是常见推荐映射，不代表所有交换机都严格这样配置。实际系统中，PCP 到硬件队列的映射通常可以配置。

例如车载以太网中，可能将：
```
PCP 0 → 普通诊断或非关键数据
PCP 3 → Camera 数据
PCP 5 → 控制类低延迟数据
PCP 6/7 → 网络管理、时间同步相关数据
```

**DEI：Drop Eligible Indicator**

DEI 占 1 bit，是一个二元数据，表示该帧在网络拥塞时是否更容易被丢弃。例如交换机端口发生拥塞，发送队列积压时，交换机可能优先丢弃DEI等于1的帧。不过，DEI 并不意味着DEI = 1 的帧一定会被丢弃。它只是为网络设备提供一个拥塞管理提示。是否真正使用该字段，取决于交换机和网络 QoS 配置。

**VID：VLAN Identifier**

VID 占 12 bit，理论取值范围为：0～4095，但其中部分值有特殊含义：
|              VID | 含义                                  |
| ---------------: | ----------------------------------- |
|              `0` | Priority Tag，只携带 PCP/DEI，不属于普通 VLAN |
|              `1` | 通常是交换机默认 VLAN，但标准并未禁止用户使用           |
|         `2～4094` | 可使用的 VLAN ID                        |
| `4095` / `0xFFF` | 保留，不能作为普通 VLAN ID                   |

举个例子：
```
PCP = 5
DEI = 0
VID = 0
```

表示这个帧需要携带二层优先级 5，但不希望通过该标签指定一个具体 VLAN。此时交换机通常根据端口的默认 VLAN，也就是 PVID，决定该帧所属的 VLAN。

## 802.1ad Q-in-Q

Q-in-Q 可以理解为：在原有的 802.1Q VLAN Tag 外面，再套一层 VLAN Tag。
因此一个帧会携带两个VLAN标签：

```
外层 Service VLAN Tag, S-VID
内层 Customer VLAN Tag, C-VID
```

**Q-in-Q 帧结构**

普通的单VLAN帧：
```
| DMAC | SMAC | 0x8100 | C-TCI | EtherType | Payload | FCS |
```

Q-in-Q 双标签帧：
```
+------------------+
| Destination MAC  | 6B
+------------------+
| Source MAC       | 6B
+------------------+
| S-TPID = 0x88A8  | 2B
+------------------+
| S-TCI            | 2B
| PCP DEI S-VID    |
+------------------+
| C-TPID = 0x8100  | 2B
+------------------+
| C-TCI            | 2B
| PCP DEI C-VID    |
+------------------+
| EtherType        | 2B
+------------------+
| Payload          |
+------------------+
| FCS              | 4B
+------------------+
```

### S-VID 和 C-VID 分别表示什么

**C-VID：Customer VLAN ID**
C-VID 是客户网络内部使用的 VLAN。例如，客户自己划分：
```
C-VID 10：办公网络
C-VID 20：摄像头网络
C-VID 30：服务器网络
```

该编号由客户自己管理。

***

**S-VID：Service VLAN ID**
S-VID 是运营商或上层承载网络使用的 VLAN。一般用于区分不同客户、不同业务、不同接入区域等等。

## 项目代码实证：在 lwIP 中 VLAN 是怎么收发的

前面讲了 802.1Q 帧结构和 TCI 的位布局：

```
TCI = (PCP << 13) | (DEI << 12) | VID
pcp = (tci >> 13) & 0x07;
dei = (tci >> 12) & 0x01;
vid =  tci & 0x0FFF;
```

这些都是抽象公式。下面看在量产代码里，这些位运算是怎么真正落地到收发路径上的。本节基于一个基于 lwIP 2.1.2 的车载 MCU 以太网协议栈适配层，所有代码用伪代码形式呈现，重点在讲清楚逻辑而不是抄源码。

### VLAN 配置结构：一条逻辑网络 = 一个 VLAN ID + 一组允许的 peer MAC

在 lwIP 标准里，VLAN 是 netif 上的一个可选属性。一个常见的做法是在 lwIP 之上加一层配置抽象，把"某个网络接口属于哪个 VLAN、允许和哪些 peer 通信"做成静态配置表。

```c
/* 一个 peer = 一个对端 ECU 的 (MAC, IP)，是 VLAN 接入白名单的条目 */
struct vlan_peer_config {
    uint8_t  peer_mac[6];
    char     peer_ip[16];
};

/* 一个 VLAN 的配置：VID + 允许的 peer 列表 */
struct vlan_config {
    uint16_t vid;                                /* 12-bit VLAN ID */
    uint8_t  peer_count;
    const struct vlan_peer_config *peers;
};

/* 一个网络接口的配置：IP/网关/本接口归属的所有 VLAN */
struct netif_config {
    const char               *assigned_ip;
    const char               *assigned_netmask;
    const char               *assigned_gateway;
    const struct vlan_config *vlan_configs;     /* 本接口的 VLAN 配置数组 */
    uint8_t                   vlan_count;       /* 本接口共有几个 VLAN */
    bool                      cb_enabled;       /* 是否启用 802.1CB（FRER 帧复制/消除） */
    uint8_t                   assigned_mac[6];
    /* ... */
};
```

注意：**这里 VLAN 不是软件转发的，而是"接收白名单"**。lwIP 不会自己查 MAC 表转发，它只判断"这个带着某个 VLAN ID 进来的包，源 MAC 是不是我配置里允许的 peer"。真正的 VLAN 转发表在 switch 芯片内部，CPU 这层只做接入控制。

### 发包路径：组装 TCI，把 VLAN Tag 插到以太网帧里

当 lwIP 协议栈要往外发包时，会调用一个名为 `lwip_hook_vlan_set` 的钩子（这是 lwIP 标准的扩展点，宏 `LWIP_HOOK_VLAN_SET`），由这个钩子决定"这个包要不要带 VLAN、带哪个 VLAN ID、PCP 是多少"。


```c
/* 伪代码：发包时组装 TCI（含 PCP + VID） */
int vlan_set_hook(struct netif *netif, struct pbuf *pbuf,
                  const struct eth_addr *src, const struct eth_addr *dest,
                  uint16_t eth_type)
{
    /* pbuf->priority 是协议栈上层（如 socket SO_PRIORITY）赋的优先级，0~7 */
    if (pbuf->priority > 7) {
        pbuf->priority = 0;   /* 越界归零，对应 PCP 0 = Best Effort */
    }

    struct netif_config *cfg = get_netif_config(netif);
    if (cfg == NULL) {
        return -1;           /* 让 lwIP 走普通以太网帧（不带 VLAN tag） */
    }

    /* Case 1：本接口根本没配 VLAN → 不打 tag */
    if (cfg->vlan_configs == NULL) {
        return -1;
    }

    /* Case 2：本接口只有一个 VLAN，且不启用 802.1CB 帧复制 → 用第一个 VLAN */
    if (!cfg->cb_enabled) {
        /* ↓↓↓ 关键这一行：组装 TCI = (PCP << 13) | VID ↓↓↓ */
        return (pbuf->priority << 13) | cfg->vlan_configs[0].vid;
    }

    /* Case 3：启用 802.1CB → 根据目的 MAC 查 peer 表，决定走哪个 VLAN */
    for (int vi = 0; vi < cfg->vlan_count; vi++) {
        const struct vlan_config *v = &cfg->vlan_configs[vi];
        for (int pi = 0; pi < v->peer_count; pi++) {
            if (mac_equals(v->peers[pi].peer_mac, dest->bytes)) {
                /* 同样是 (PCP << 13) | VID，只是 VID 来自匹配到的 vlan */
                return (pbuf->priority << 13) | v->vid;
            }
        }
    }

    return -1;   /* 找不到匹配的 peer，让 lwIP 走默认路径 */
}
```

### 收包路径 1：lwIP 内核解析 VLAN Tag、提取 PCP 写回 pbuf


收到一个带 VLAN 的以太网帧后，lwIP 内核先看 EtherType 是不是 0x8100（`ETHTYPE_VLAN`），是的话跳过 4 字节 VLAN tag 才能拿到真正的上层协议类型。同时把 PCP 字段提取出来写回 `pbuf->priority`，让后续 QoS 调度能用到。

这段代码在 lwIP 2.1.2 内核 `lib/lwip/src/netif/ethernet.c` 里，**是开源代码**，可以直接对照官方源码看：

```c
/* lwIP 2.1.2 内核：lib/lwip/src/netif/ethernet.c（开源代码） */
#if ETHARP_SUPPORT_VLAN
  if (type == PP_HTONS(ETHTYPE_VLAN)) {                /* EtherType == 0x8100？ */
    struct eth_vlan_hdr *vlan = (struct eth_vlan_hdr *)(((char *)ethhdr) + SIZEOF_ETH_HDR);
    next_hdr_offset = SIZEOF_ETH_HDR + SIZEOF_VLAN_HDR; /* 跳过 4 字节 VLAN tag */
    if (p->len <= SIZEOF_ETH_HDR + SIZEOF_VLAN_HDR) {
      /* 包太短，连 VLAN 头都装不下，直接丢 */
      ETHARP_STATS_INC(etharp.proterr);
      ETHARP_STATS_INC(etharp.drop);
      MIB2_STATS_NETIF_INC(netif, ifinerrors);
      goto free_and_return;
    }
#if defined(LWIP_HOOK_VLAN_CHECK) || defined(ETHARP_VLAN_CHECK) || defined(ETHARP_VLAN_CHECK_FN)
#ifdef LWIP_HOOK_VLAN_CHECK
    if (!LWIP_HOOK_VLAN_CHECK(netif, ethhdr, vlan)) {     /* 调用我们自己实现的 vlan_check 钩子 */
#elif defined(ETHARP_VLAN_CHECK_FN)
    if (!ETHARP_VLAN_CHECK_FN(ethhdr, vlan)) {
#elif defined(ETHARP_VLAN_CHECK)
    if (VLAN_ID(vlan) != ETHARP_VLAN_CHECK) {
#endif
      /* 不属于我们的 VLAN，静默丢弃 */
      pbuf_free(p);
      return ERR_OK;
    }
#endif /* LWIP_HOOK_VLAN_CHECK ... */
    type = vlan->tpid;            /* 真正的上层协议类型（0x0800 IPv4 等） */

    /* 把 VLAN tag 里的 PCP 提取出来，写回 pbuf->priority，
     * 让下游 QoS 调度能根据 PCP 选 DMA channel。
     * RX 方向 priority 字段不影响接收本身，QoS 在 RX 侧由 task priority 处理。
     */
    p->priority = PP_HTONS(vlan->prio_vid) >> 13;     /* ← 关键这一行 */
  }
#endif /* ETHARP_SUPPORT_VLAN */
```

**逐行拆解 `p->priority = PP_HTONS(vlan->prio_vid) >> 13`：**

`vlan->prio_vid` 是 lwIP 内核里 `eth_vlan_hdr` 结构的 TCI 字段（16 bit，含 PCP 3 + DEI 1 + VID 12）。`PP_HTONS()` 是字节序转换宏（host → network，大端）。右移 13 位正好把低 13 位（DEI + VID）丢掉，保留高 3 位 PCP。这正好是 `pcp = (tci >> 13) & 0x07` 的简化形式（移到最低 3 位后自然就是 0~7，不需要再 `& 0x07`）。

**这行代码 = "从 VLAN tag 解析 PCP 优先级，写到 pbuf 里供 QoS 用"。** 后续 lwIP ethernetif 适配层会拿这个 `pbuf->priority` 查"优先级 → DMA channel 映射表"，决定走哪个硬件发送队列。

### 收包路径 2：hook 校验 VLAN ID + 源 MAC 白名单

`LWIP_HOOK_VLAN_CHECK` 宏对应一个我们自己实现的钩子函数。lwIP 内核在判断完 EtherType 是 0x8100 后，会调这个钩子决定"这个包要不要收"。

```c
/* 伪代码：收包时校验 VLAN ID + 源 MAC 白名单 */
bool vlan_check_hook(struct netif *netif, struct eth_hdr *ethhdr,
                     struct eth_vlan_hdr *vlan_hdr)
{
    bool allow = false;
    struct netif_config *cfg = get_netif_config(netif);

    if (vlan_hdr != NULL && cfg != NULL) {
        /* 遍历本接口的所有 VLAN 配置，找 VID 匹配的 */
        for (int vi = 0; vi < cfg->vlan_count; vi++) {
            const struct vlan_config *v = &cfg->vlan_configs[vi];

            if (v->vid == VLAN_ID(vlan_hdr)) {   /* VID 匹配 */
                /* 在这个 VLAN 里，再遍历允许的 peer，看源 MAC 在不在白名单 */
                for (int pi = 0; pi < v->peer_count; pi++) {
                    if (mac_equals(v->peers[pi].peer_mac, ethhdr->src.addr)) {
                        return true;   /* 收 */
                    }
                }
            }
        }
    }
    /* 不带 tag 的包：根据需要单独处理（这里伪代码省略） */

    return false;   /* 不匹配 → lwIP 内核 pbuf_free 丢包 */
}
```

**两层校验的语义：**

1. **VLAN ID 必须匹配**：包带的 VID 必须在本接口配置的 `vlan_configs[]` 列表里。VID 不对的包直接丢，相当于"虽然物理上收到了，但逻辑上不属于我的网络"。
2. **源 MAC 必须在白名单**：即使 VID 对了，源 MAC 不在 `peers[]` 列表里也丢。这是更严格的接入控制——防止任意设备随便接入某个 VLAN。

`VLAN_ID(vlan_hdr)` 是 lwIP 提供的宏，展开就是 `(vlan_hdr->prio_vid & 0x0FFF)`，对应 `vid = tci & 0x0FFF`。

### 收包路径 3：多 netif 场景下，根据 VLAN 选正确的 netif

一台 ECU 上可能有多个网络接口（一个连中心交换机、一个连级联交换机），lwIP 收到包后要决定交给哪个 netif 处理。这里通过一个 ARP filter 钩子完成。

```c
/* 伪代码：根据目的 IP 选正确的 netif（支持 VLAN 和非 VLAN 包） */
struct netif *arp_filter_netif(struct pbuf *p, struct netif *netif_in)
{
    struct netif *result = NULL;
    struct eth_hdr *ethhdr = (struct eth_hdr *)p->payload;
    uint16_t type;
    struct eth_vlan_hdr *vlan = NULL;

    /* Step 1：判断是否带 VLAN tag，并取出真正的 EtherType */
    if (ethhdr->type == PP_HTONS(ETHTYPE_VLAN)) {     /* 0x8100 */
        /* 带 tag：VLAN 头紧跟在 14 字节以太网头之后 */
        vlan = (struct eth_vlan_hdr *)((char *)ethhdr + SIZEOF_ETH_HDR);
        type = lwip_ntohs(vlan->tpid);                /* 跳过 tag 取真正 EtherType */
    } else {
        /* 不带 tag：直接用以太网头里的 EtherType */
        type = lwip_ntohs(ethhdr->type);
    }

    /* Step 2：根据 EtherType 分发 */
    switch (type) {
        case 0x0806:   /* ARP */
            /* ARP 头的偏移：带 VLAN 时多 4 字节，不带时紧跟以太网头 */
            arp_hdr = vlan
                ? (struct etharp_hdr *)((char *)p->payload + SIZEOF_ETH_HDR + SIZEOF_VLAN_HDR)
                : (struct etharp_hdr *)((char *)p->payload + SIZEOF_ETH_HDR);
            /* 遍历所有 netif，找目的 IP 匹配的 */
            NETIF_FOREACH(netif) {
                if (netif_is_up(netif) && ip_equals(arp_hdr->dipaddr, netif->ip_addr)) {
                    result = netif;
                    break;
                }
            }
            break;

        case 0x0800:   /* IPv4 */
            ip_hdr = vlan
                ? (struct ip_hdr *)((char *)p->payload + SIZEOF_ETH_HDR + SIZEOF_VLAN_HDR)
                : (struct ip_hdr *)((char *)p->payload + SIZEOF_ETH_HDR);
            NETIF_FOREACH(netif) {
                if (netif_is_up(netif)) {
                    if (ip_equals(ip_hdr->dest, netif->ip_addr)) {
                        result = netif;
                        break;
                    }
                    /* 组播包还要校验 VLAN 是否允许 */
                    if (ip4_addr_ismulticast(&ip_hdr->dest)
                        && igmp_lookfor_group(netif, &ip_hdr->dest)
                        && vlan_check_hook(netif, ethhdr, vlan)) {
                        result = netif;
                        break;
                    }
                }
            }
            break;

        default:
            result = netif_in;   /* 非标准协议，原样返回 */
            break;
    }
    return result;
}
```

注意 Step 1 那段 `vlan = (struct eth_vlan_hdr *)((char *)ethhdr + SIZEOF_ETH_HDR)`：这是在算 VLAN tag 在 pbuf 里的偏移——以太网头是 14 字节（DMAC 6 + SMAC 6 + EtherType 2），所以 VLAN tag 紧跟在 14 字节之后。`SIZEOF_ETH_HDR = 14`、`SIZEOF_VLAN_HDR = 4`。


### 完整数据流图

把上面三段代码连起来，一个带 VLAN 的以太网帧的完整 RX 路径如下：

```
Wire 上的帧
  [DMAC][SMAC][0x8100][TCI][EtherType][Payload][FCS]
                    │
                    ▼
MAC 控制器驱动（硬件层）
  - DMA 描述符收到帧
  - FCS 校验
  - 把帧写到 pbuf，调 EthIf_RxIndication
                    │
                    ▼
lwIP 内核 ethernet_input()  [开源代码]
  - 检查 EtherType == 0x8100
  - 跳过 4 字节 VLAN tag
  - 调 LWIP_HOOK_VLAN_CHECK
        │
        ▼
vlan_check_hook()  [协议栈适配层]
  - VLAN_ID(vlan_hdr) 匹配本接口的 vlan_configs[]
  - 源 MAC 匹配 peers[] 白名单
  - 不匹配 → 返回 false → pbuf_free 丢包
                    │
                    ▼
arp_filter_netif()  [协议栈适配层]
  - 多 netif 场景下根据目的 IP 选正确 netif
                    │
                    ▼
lwIP 内核 ethernet.c
  p->priority = vlan->prio_vid >> 13    ← 提取 PCP 写回 pbuf
                    │
                    ▼
交给 IP 层 / ARP 层处理
                    │
                    ▼
后续 TX 时：
  vlan_set_hook()  [协议栈适配层]
    返回 (pbuf->priority << 13) | vid
    重新组装 TCI 插回以太网帧
```
