---
title: '随笔(九)：Ring Buffer'
description: '随手记录看到的一些知识点'
tags: ['C/C++']
series: { id: 'essay', order: 9 }
pubDate: 'Sep 6 2026'
---

## 普通Ringbuffer和无锁Ringbuffer

普通Ring Buffer最简单的状态通常只有
```c
buffer[N];
read_index;
write_index;
```
单线程下读写控制非常简单。但是多线程同时访问时。例如一个生产者正在写`write_index`为5的数据，与此同时另一个生产者也进行相同位置的写。那么这两个线程可能都认为这个位置是自己的，也就发生了数据竞争。最简单的方法就是加入锁：
```cpp
std::mutex mutex;
void push(const T& value)
{
    std::lock_guard<std::mutex> lock(mutex);
    // 检查 full
    // 写入 buffer
    // 更新 write_index
}
```
消费这同样通过这个互斥锁来保护共享状态。这个结构仍然是RingBuffer，只不过额外引入了mutex来保证并发的正确性。而无锁Ringbuffer则使用了`atomic\CAS\memory_order`等机制来协调生产者和消费者。二者最本质的区别就是共享状态的同步方式不同。

## SPSC下的RingBuffer

单消费者单生产者场景下，例如:
- UART ISR → Task
- Camera Capture Thread → Image Processing Thread
- Audio Capture → Audio Processing
- 网络接收线程 → 协议解析线程
因为只有一个 Producer，所以只有它会修改 tail；只有一个 Consumer，所以只有它会修改 head。它意味着：Producer 和 Consumer 根本不需要竞争同一个 Index。

### 实现
```cpp
#include <array>
#include <atomic>
#include <cstddef>
#include <utility>

template <typename T, std::size_t N>
class SPSCRingBuffer{
public:
    bool push(const T& value)
    {
        const std::size_t tail = tail_.load(std::memory_order_relaxed);
        const std::size_t next = (tail + 1) % N;

        if(next == head_.load(std::memory_order_acquire))
        {
            return false;
        }

        buffer_[tail] = value;
        tail_.store(next, std::memory_order_release);
        return true;
    }

    bool pop(T& value)
    {
        const std::size_t head = head_.load(std::memory_order_relaxed);
        // Check if the buffer is empty
        if(head == tail_.load(std::memory_order_acquire))
        {
            return false;
        }

        value = std::move(buffer_[head]);
        head_.store((head + 1) % N, std::memory_order_release);
        return true;
    }

private:
    std::array<T, N> buffer_;
    alignas(64)
    std::atomic<std::size_t> head_{0};
    alignas(64)
    std::atomic<std::size_t> tail_{0};
};
```

### producer的push操作

假设当前`head=0,tail=2`说明buffer中已经有2个元素，分别是`buffer[0]`和`buffer[1]`。此时如果要插入新的元素，需要将新元素写入`buffer[2]`，并将tail更新为3。
```
        head
          ↓
+-----+-----+-----+-----+-----+-----+-----+-----+
|  A  |  B  |     |     |     |     |     |     |
+-----+-----+-----+-----+-----+-----+-----+-----+
              ↑
             tail
```
producer第一步是
```cpp
const std::size_t tail = tail_.load(std::memory_order_relaxed);
```
得到`tail=2`。为什么这里的内存序是relaxed？因为只有producer自己会修改tail_，不存在另一个 Producer 同时把 tail_ 改掉，所以这里不用 CAS。然后计算next得到`next=3`，接着检查next是否等于head，如果相等，说明再写就会追上消费者所以RingBuffer满了。

接下来`buffer_[tail] = value;`可以观察到tail根本不是`atomic<T>`，这里是因为在SPSC下，我们通过head/tail，保证一个Slot只属于一个线程。Producer 在写 Slot 2 时，Consumer 不会读取 Slot 2，因为 Consumer 看到的 tail 还没有变。写完之后
```cpp
tail_.store(next, std::memory_order_release);
```
说明：
> 在发布 tail = 3 之前发生的 Buffer 写入，必须先完成并对获得这个 Release 的 Consumer 可见。

## MPSC下的RingBuffer

SPSC 中只有一个 Producer，因此 `tail_` 永远只有一个线程修改，不存在两个 Producer 同时获取相同 Slot 的问题。但是当场景变成 MPSC，也就是 Multiple Producer Single Consumer 时，情况就不同了。例如多个业务线程同时向一个日志线程发送日志，或者多个网络接收线程将数据提交给同一个处理线程，都属于典型的 MPSC 场景。

假设当前：

```text
tail = 5
```

此时 Producer A 和 Producer B 同时执行：

```cpp
const std::size_t tail =
    tail_.load(std::memory_order_relaxed);
```

那么两个线程都有可能读取到 `5`。如果继续按照 SPSC 的写法直接执行：

```cpp
buffer_[tail] = value;
```

Producer A 和 Producer B 就会同时写入 `buffer_[5]`，因此 MPSC 首先需要解决的问题并不是数据什么时候对 Consumer 可见，而是：

> 多个 Producer 如何保证每个人拿到不同的 Slot。

最直观的方法是把 `tail` 看成一个 Ticket Counter，每个 Producer 在真正写数据之前先通过 Atomic 操作抢一个 Position。例如可以使用 `fetch_add()`：

```cpp
const std::size_t pos =
    enqueue_pos_.fetch_add(
        1,
        std::memory_order_relaxed);
```

假设初始 `enqueue_pos_ = 10`，三个 Producer 同时执行后可能分别得到：

```text
Producer A -> pos = 10
Producer B -> pos = 11
Producer C -> pos = 12
```

这样它们就不会写入同一个逻辑 Position。但是仅仅解决 Position Reservation 仍然不够，因为“Producer 已经抢到一个 Position”和“Producer 已经把这个 Position 对应的数据写完”是两件不同的事情。

例如 Producer A 获得 Position 10 后被操作系统调度出去，而 Producer B 获得 Position 11 后很快完成写入。如果 Consumer 只看到全局 `tail = 12`，它可能会认为 Position 10 和 Position 11 都已经完成，但实际上 Position 10 还没有写好。因此 MPSC 不能再只通过一个全局 Tail 表示队列状态，而需要给每一个 Slot 增加独立状态。

### Sequence Number

一种常见实现方式是给每个 Slot 增加一个 `sequence`：

```cpp
struct Cell {
    std::atomic<std::size_t> sequence;
    T data;
};
```

这里的 `sequence` 同时承担两个职责：首先表示当前 Slot 是否已经可以读或者可以写，其次表示这个 Slot 当前属于 Ring Buffer 的哪一轮。

假设 Ring Buffer 容量为 4，那么逻辑 Position 与实际 Slot 的关系为：

```text
Position 0 -> Slot 0
Position 1 -> Slot 1
Position 2 -> Slot 2
Position 3 -> Slot 3

Position 4 -> Slot 0
Position 5 -> Slot 1
Position 6 -> Slot 2
Position 7 -> Slot 3
```

可以看到 Slot 0 会被 Position 0、4、8、12 不断重复使用。如果只使用一个：

```cpp
bool ready;
```

我们只能知道这个 Slot 当前是 Ready 还是 Empty，却无法知道它到底属于 Position 0 这一轮，还是 Position 4、8 之后的新一轮。因此这里需要使用不断增长的 Sequence Number，而不是简单的 Boolean State。

初始化时，如果容量 `N = 4`，可以让：

```text
Slot 0 sequence = 0
Slot 1 sequence = 1
Slot 2 sequence = 2
Slot 3 sequence = 3
```

当 Producer 获得：

```text
pos = 0
```

时，它对应的 Slot 是：

```cpp
index = pos % N;
```

也就是 Slot 0。此时如果：

```text
slot.sequence == 0
```

说明这个 Slot 正处于 Position 0 对应的可写状态。

Producer 写完数据以后，将：

```text
sequence = pos + 1
```

也就是：

```text
Slot 0 sequence:
0 -> 1
```

这里的 `sequence = 1` 表示 Position 0 的数据已经准备完成，可以交给 Consumer。

Consumer 读完 Position 0 后，再将：

```text
sequence = pos + N
```

因此：

```text
Slot 0 sequence:
1 -> 4
```

以后当 Producer 获得 Position 4 时，它看到：

```text
slot[0].sequence == 4
```

就知道 Slot 0 已经进入下一轮，可以重新使用。

所以 Slot 0 的完整生命周期可以表示成：

```text
sequence = 0
Producer Position 0 可以写
        ↓
sequence = 1
Consumer Position 0 可以读
        ↓
sequence = 4
Producer Position 4 可以写
        ↓
sequence = 5
Consumer Position 4 可以读
        ↓
sequence = 8
Producer Position 8 可以写
        ↓
...
```

Sequence Number 的意义就在于：即使物理 Slot 一直是同一个，我们仍然能够通过 Sequence 区分不同 Generation。

### 实现

一个简化的 MPSC Ring Buffer 可以写成：

```cpp
#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <utility>

template <typename T, std::size_t N>
class MPSCRingBuffer {
public:
    MPSCRingBuffer()
    {
        for (std::size_t i = 0; i < N; ++i) {
            buffer_[i].sequence.store(
                i,
                std::memory_order_relaxed);
        }
    }

    bool push(const T& value)
    {
        Cell* cell;

        std::size_t pos =
            enqueue_pos_.load(
                std::memory_order_relaxed);

        for (;;) {
            cell = &buffer_[pos % N];

            const std::size_t seq =
                cell->sequence.load(
                    std::memory_order_acquire);

            const std::intptr_t diff =
                static_cast<std::intptr_t>(seq) -
                static_cast<std::intptr_t>(pos);

            if (diff == 0) {
                if (enqueue_pos_.compare_exchange_weak(
                        pos,
                        pos + 1,
                        std::memory_order_relaxed)) {
                    break;
                }
            } else if (diff < 0) {
                return false;
            } else {
                pos = enqueue_pos_.load(
                    std::memory_order_relaxed);
            }
        }

        cell->data = value;

        cell->sequence.store(
            pos + 1,
            std::memory_order_release);

        return true;
    }

    bool pop(T& value)
    {
        const std::size_t pos = dequeue_pos_;

        Cell& cell = buffer_[pos % N];

        const std::size_t seq =
            cell.sequence.load(
                std::memory_order_acquire);

        if (seq != pos + 1) {
            return false;
        }

        value = std::move(cell.data);

        cell.sequence.store(
            pos + N,
            std::memory_order_release);

        ++dequeue_pos_;

        return true;
    }

private:
    struct Cell {
        std::atomic<std::size_t> sequence{0};
        T data{};
    };

    std::array<Cell, N> buffer_;

    alignas(64)
    std::atomic<std::size_t> enqueue_pos_{0};

    alignas(64)
    std::size_t dequeue_pos_{0};
};
```

这里为了突出 Ring Buffer 的同步机制，代码假设 `T` 可以默认构造并进行赋值。真正的泛型容器通常会使用 Raw Storage、Placement New 或 `std::construct_at()` 来精确控制 `T` 的生命周期，这属于另外一个层面的对象管理问题。

### Producer如何抢占Position

MPSC 中多个 Producer 会同时修改：

```cpp
enqueue_pos_
```

因此不能再像 SPSC 一样简单：

```cpp
tail_.store(next);
```

这里采用：

```cpp
enqueue_pos_.compare_exchange_weak(
    pos,
    pos + 1,
    std::memory_order_relaxed);
```

假设：

```text
enqueue_pos_ = 10
```

Producer A 和 Producer B 同时读取：

```text
A: pos = 10
B: pos = 10
```

两者都尝试：

```text
CAS:
10 -> 11
```

但这个操作是 Atomic Read-Modify-Write，因此最终只能有一个线程成功。假设 Producer A 成功，那么它获得 Position 10，并且 `enqueue_pos_` 变为 11。Producer B 的 CAS 会失败，同时 `pos` 会被更新为新的值 11，于是 Producer B 下一轮尝试的就是 Position 11。

所以 CAS 在这里解决的是：

> 多个 Producer 对逻辑 Position 的所有权竞争。

它还没有负责 Data Publication，真正的数据发布仍然依靠每一个 Cell 的 `sequence`。

### Producer为什么先CAS再写数据

当某个 Producer 成功：

```cpp
CAS enqueue_pos_: pos -> pos + 1
```

以后，只能说明：

> 这个 Producer 已经获得了 Position `pos` 的所有权。

此时 Consumer 还不能读取这个 Slot。

Producer 接下来先写：

```cpp
cell->data = value;
```

然后执行：

```cpp
cell->sequence.store(
    pos + 1,
    std::memory_order_release);
```

这一步才表示：

> Position `pos` 的数据已经真正准备完成。

因此在 MPSC 中要明确区分：

```text
enqueue_pos CAS
    ↓
Reservation
Producer 抢到了这个 Position


sequence.store(release)
    ↓
Publication
Producer 真正写完了这个 Position
```

这也是为什么不能只使用一个全局 Tail 来管理 MPSC Ring Buffer。

### Consumer如何读取

MPSC 只有一个 Consumer，因此 `dequeue_pos_` 只有 Consumer 自己会修改，不需要 CAS，也不一定需要做成 Atomic。

Consumer 当前准备读取：

```text
pos = dequeue_pos_
```

然后检查：

```cpp
cell.sequence.load(
    std::memory_order_acquire);
```

如果：

```text
sequence == pos + 1
```

说明对应 Producer 已经执行过：

```cpp
cell->data = value;

cell->sequence.store(
    pos + 1,
    std::memory_order_release);
```

因此 Consumer 的 Acquire 能够与 Producer 的 Release 配对，保证看到 Producer 写入的完整 `data`。

读取完成以后：

```cpp
cell.sequence.store(
    pos + N,
    std::memory_order_release);
```

表示：

> 这个 Slot 已经消费完成，下一轮 Producer 可以重新使用。

然后 Consumer 将：

```cpp
++dequeue_pos_;
```

继续读取下一个逻辑 Position。

需要注意的是，如果 Producer A 已经抢到了 Position 10，但是还没有写完，而 Producer B 已经完成 Position 11，那么 Consumer 仍然不能跳过 Position 10 直接消费 Position 11。因为这是一个 FIFO Queue，Position 10 必须先完成，Position 11 才能按照顺序被消费。

这也是 MPSC 中非常重要的一个现象：

> 多个 Producer 可以并行写不同 Slot，但 FIFO Consumer 最终仍然按照 Position 顺序消费。

## MPMC下的RingBuffer

MPMC 是 Multiple Producer Multiple Consumer，相比 MPSC，它不仅有多个 Producer 同时竞争 `enqueue_pos_`，还有多个 Consumer 同时竞争 `dequeue_pos_`。

例如一个通用 Thread Pool：

```text
Producer A ─┐
Producer B ─┼──> Ring Buffer ─┬──> Consumer A
Producer C ─┘                 ├──> Consumer B
                             └──> Consumer C
```

Producer 侧的问题和 MPSC 完全相同，因此仍然需要通过 CAS 抢占不同的 Enqueue Position，并通过 `sequence` 表示数据什么时候真正 Ready。

区别在于 Consumer 侧也不能再简单：

```cpp
++dequeue_pos_;
```

因为多个 Consumer 可能同时读取到同一个 `dequeue_pos_`，进而认为同一个 Slot 属于自己。因此 `dequeue_pos_` 也必须成为 Atomic，并通过 CAS 分配唯一的消费 Position。

### 实现

下面是一个典型的 Bounded MPMC Ring Buffer：

```cpp
#include <array>
#include <atomic>
#include <cstddef>
#include <cstdint>
#include <utility>

template <typename T, std::size_t N>
class MPMCRingBuffer {
public:
    MPMCRingBuffer()
    {
        for (std::size_t i = 0; i < N; ++i) {
            buffer_[i].sequence.store(
                i,
                std::memory_order_relaxed);
        }
    }

    bool push(const T& value)
    {
        Cell* cell;

        std::size_t pos =
            enqueue_pos_.load(
                std::memory_order_relaxed);

        for (;;) {
            cell = &buffer_[pos % N];

            const std::size_t seq =
                cell->sequence.load(
                    std::memory_order_acquire);

            const std::intptr_t diff =
                static_cast<std::intptr_t>(seq) -
                static_cast<std::intptr_t>(pos);

            if (diff == 0) {
                if (enqueue_pos_.compare_exchange_weak(
                        pos,
                        pos + 1,
                        std::memory_order_relaxed)) {
                    break;
                }
            } else if (diff < 0) {
                return false;
            } else {
                pos = enqueue_pos_.load(
                    std::memory_order_relaxed);
            }
        }

        cell->data = value;

        cell->sequence.store(
            pos + 1,
            std::memory_order_release);

        return true;
    }

    bool pop(T& value)
    {
        Cell* cell;

        std::size_t pos =
            dequeue_pos_.load(
                std::memory_order_relaxed);

        for (;;) {
            cell = &buffer_[pos % N];

            const std::size_t seq =
                cell->sequence.load(
                    std::memory_order_acquire);

            const std::intptr_t diff =
                static_cast<std::intptr_t>(seq) -
                static_cast<std::intptr_t>(pos + 1);

            if (diff == 0) {
                if (dequeue_pos_.compare_exchange_weak(
                        pos,
                        pos + 1,
                        std::memory_order_relaxed)) {
                    break;
                }
            } else if (diff < 0) {
                return false;
            } else {
                pos = dequeue_pos_.load(
                    std::memory_order_relaxed);
            }
        }

        value = std::move(cell->data);

        cell->sequence.store(
            pos + N,
            std::memory_order_release);

        return true;
    }

private:
    struct Cell {
        std::atomic<std::size_t> sequence{0};
        T data{};
    };

    std::array<Cell, N> buffer_;

    alignas(64)
    std::atomic<std::size_t> enqueue_pos_{0};

    alignas(64)
    std::atomic<std::size_t> dequeue_pos_{0};
};
```

可以看到 MPMC 的 Producer 逻辑与 MPSC 几乎没有变化，最大的区别出现在 Consumer。

### 多个Consumer如何竞争

假设：

```text
dequeue_pos_ = 20
```

Consumer A 和 Consumer B 同时读取：

```text
A: pos = 20
B: pos = 20
```

如果像 MPSC 一样直接读取 `buffer_[20 % N]`，两个 Consumer 就可能同时消费同一个元素。

所以它们都必须执行：

```cpp
dequeue_pos_.compare_exchange_weak(
    pos,
    pos + 1,
    std::memory_order_relaxed);
```

假设 Consumer A 成功：

```text
dequeue_pos:
20 -> 21
```

那么 Position 20 就正式属于 Consumer A。

Consumer B 的 CAS 会失败，并且重新得到：

```text
pos = 21
```

下一轮再尝试抢 Position 21。

所以在 MPMC 中存在两套完全对称的 Reservation：

```text
Producer:
CAS enqueue_pos
    ↓
获得一个 Write Position


Consumer:
CAS dequeue_pos
    ↓
获得一个 Read Position
```

而每个 Slot 的 `sequence` 则负责两者之间真正的数据交接。

### 一个Slot完整的生命周期

假设：

```text
N = 4
```

我们跟踪 Slot 0。

初始化时：

```text
Slot 0
sequence = 0
```

Producer 获得：

```text
Position 0
```

发现：

```text
sequence == pos
0 == 0
```

说明可以写。

Producer 写完以后：

```text
sequence = pos + 1
         = 1
```

Consumer 获得 Position 0，发现：

```text
sequence == pos + 1
1 == 1
```

说明可以读。

Consumer 读完以后：

```text
sequence = pos + N
         = 4
```

下一轮 Producer 获得：

```text
Position 4
```

它再次来到 Slot 0，并检查：

```text
sequence == pos
4 == 4
```

因此这个 Slot 又重新进入可写状态。

整个过程为：

```text
Slot 0

sequence = 0
    ↓
Producer Position 0 获得写权限
    ↓
写 data
    ↓
sequence = 1
    ↓
Consumer Position 0 获得读权限
    ↓
读 data
    ↓
sequence = 4
    ↓
Producer Position 4 获得写权限
    ↓
写 data
    ↓
sequence = 5
    ↓
Consumer Position 4 获得读权限
    ↓
sequence = 8
    ↓
...
```

这里其实可以看到，`sequence` 已经把三个信息合并在一起：

```text
这个 Slot 属于哪一轮
+
当前能不能写
+
当前能不能读
```

这就是 Per-Slot Sequence Number 相比简单 `ready` Flag 更强的地方。

## 为什么CAS使用relaxed，而sequence使用Acquire/Release

代码里一个很容易产生疑问的地方是：

```cpp
enqueue_pos_.compare_exchange_weak(
    pos,
    pos + 1,
    std::memory_order_relaxed);
```

为什么 CAS 反而只使用 `relaxed`，而：

```cpp
cell->sequence.store(
    pos + 1,
    std::memory_order_release);
```

却使用 `release`？原因在于二者承担的职责完全不同。

`enqueue_pos_` 和 `dequeue_pos_` 主要解决的是：

> 谁获得哪个逻辑 Position。

它们只需要保证 Position 分配本身是 Atomic 的，不负责发布 `cell->data`。

真正建立 Producer 和 Consumer 数据可见性关系的是：

```text
Producer:
写 cell.data
        ↓
sequence.store(release)


Consumer:
sequence.load(acquire)
        ↓
读 cell.data
```

因此核心同步关系建立在每个 Slot 的 `sequence` 上，而不是全局 `enqueue_pos_` 或 `dequeue_pos_` 上。

同理，Consumer 读完：

```cpp
cell->sequence.store(
    pos + N,
    std::memory_order_release);
```

Producer 下一轮通过：

```cpp
cell->sequence.load(
    std::memory_order_acquire);
```

看到这个 Slot 已经释放以后，才允许重新覆盖它。

所以整个 Ring Buffer 实际存在两条 Slot Ownership Transfer：

```text
Producer
写 data
↓
release sequence
↓
Consumer acquire sequence
↓
Consumer 获得 Slot


Consumer
读 data
↓
release sequence
↓
Producer acquire sequence
↓
Producer 重新获得 Slot
```

## MPSC和MPMC的本质区别

SPSC、MPSC、MPMC 可以放在一起看：

| 模型   | Producer侧                        | Consumer侧                        | Slot状态              |
| ---- | -------------------------------- | -------------------------------- | ------------------- |
| SPSC | Producer独占Tail，不需要CAS            | Consumer独占Head，不需要CAS            | Head/Tail即可         |
| MPSC | 多Producer通过CAS竞争Enqueue Position | 单Consumer独占Dequeue Position      | 通常需要Sequence        |
| MPMC | 多Producer通过CAS竞争Enqueue Position | 多Consumer通过CAS竞争Dequeue Position | 需要Per-Slot Sequence |

SPSC 最大的优势就是 Ownership 天然明确，因此只需要通过 Head/Tail 完成 Producer 和 Consumer 之间的所有权交接。MPSC 增加了 Producer 之间的竞争，所以必须增加 Position Reservation。MPMC 又增加了 Consumer 之间的竞争，因此 Enqueue 和 Dequeue 两侧都需要 Reservation。

可以把三者的复杂度理解为：

```text
SPSC

Producer owns tail
Consumer owns head
        ↓
没有Index竞争


MPSC

Producers compete for enqueue_pos
Consumer owns dequeue_pos
        ↓
Producer侧需要CAS


MPMC

Producers compete for enqueue_pos
Consumers compete for dequeue_pos
        ↓
两侧都需要CAS
```

## 无锁并不等于一定不会等待

这里还需要区分一个容易混淆的概念。上面的实现没有使用 `std::mutex`，因此工程中经常会把这一类结构称为 Lock-Free Ring Buffer 或 Lock-Free Queue，但严格来说，“代码里没有 Mutex”和“算法满足严格的 Lock-Free Progress Guarantee”并不完全等价。

例如某个 Producer 成功抢到了 Position 10：

```text
enqueue_pos:
10 -> 11
```

但它在执行：

```cpp
cell->sequence.store(
    11,
    std::memory_order_release);
```

之前被长期挂起，那么 Position 10 仍然没有真正 Ready。即使 Position 11、12 后面的 Producer 已经完成写入，FIFO Consumer 仍然不能跳过 Position 10。

因此一个真正严格意义上的 Lock-Free 算法，还需要证明：

> 即使某个线程暂停，系统中的其他线程仍然能够持续完成操作。

所以在工程描述中，可以把这里理解成一种典型的 Mutex-Free / CAS-based Bounded Ring Queue，而不要仅仅因为没有 `std::mutex` 就默认它满足所有严格的 Lock-Free 理论性质。

## 总结

从 SPSC 到 MPSC 再到 MPMC，Ring Buffer 本身仍然只是一块循环复用的固定数组，真正逐渐复杂的是 Slot Ownership 的管理。

SPSC 中 Producer 独占 Tail，Consumer 独占 Head，因此不需要 CAS，只需要通过 Acquire / Release 保证数据发布顺序。MPSC 中多个 Producer 会竞争同一个 Enqueue Position，因此需要 CAS 进行 Position Reservation，并通过 Per-Slot Sequence 将“抢到 Slot”和“数据已经写完”区分开。MPMC 又进一步增加多个 Consumer 对 Dequeue Position 的竞争，因此 Producer 和 Consumer 两侧都需要 CAS，而 Sequence Number 则负责管理 Slot 在不同 Generation 中的可读、可写状态。

所以可以把无锁 Ring Buffer 的实现核心概括成：

```text
SPSC:
Index Ownership
+
Acquire / Release


MPSC:
Position Reservation
+
Per-Slot Sequence
+
Acquire / Release


MPMC:
Producer Reservation
+
Consumer Reservation
+
Per-Slot Sequence
+
Acquire / Release
```

Ring Buffer 真正难的地方并不是 `(index + 1) % N`，而是在多个线程同时运行时，如何保证每一个 Slot 在任何时刻都只有唯一的 Owner，并且资源所有权从 Producer 转交给 Consumer、再从 Consumer 归还给 Producer的整个过程中都不存在数据竞争。
