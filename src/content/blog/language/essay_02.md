---
title: '随笔(二)'
description: '随手记录看到的一些知识点'
tags: ['ARM']
series: { id: 'essay', order: 2 }
pubDate: 'Aug 19 2026'
---

## Stack

栈遵循先进后出，也叫LIFO, Last in First Out，只允许在栈顶进行插入和删除操作，基本操作包含：入栈push，出栈pop，peek/top查看栈顶元素。

一些简单的实现:

```c
// 数组实现
#define MAX_SIZE 100

typedef struct {
    int data[MAX_SIZE];
    int top;    // 栈顶index
}ArrayStack;

//初始化栈
void initStack(ArrayStack* stack) {
    stack->top = -1;
}

bool isEmpty(ArrayStack* stack) {
    return stack->top == -1;
}

// 判断栈是否已满
bool isFull(ArrayStack* stack) {
    return stack->top == MAX_SIZE - 1;
}

// 入栈
bool push(ArrayStack* stack, int value) {
    if (isFull(stack)) {
        return false;
    }
    stack->data[++stack->top] = value;
    return true;
}

// 出栈
bool pop(ArrayStack* stack, int* value) {
    if (isEmpty(stack)) {
        return false;
    }
    *value = stack->data[stack->top--];
    return true;
}

// 获取栈顶元素
bool peek(ArrayStack* stack, int* value) {
    if (isEmpty(stack)) {
        return false;
    }
    *value = stack->data[stack->top];
    return true;
}
```

```c
// 链表实现
typedef struct StackNode {
    int data;
    struct StackNode* next;
} StackNode;

typedef struct {
    StackNode* top; //栈顶指针
} LinkedStack;

//初始化栈
void initStack(LinkedStack* stack) {
    stack->top = NULL;
}

//判断栈是否是空的
bool isEmpty(LinkedStack* stack) {
    return stack->top == NULL;
}

//由于是链表实现，所以这里栈逻辑上来讲永远都不会满，但受到内存的限制，所以放到入栈里判断
bool push(LinkedStack* stack, int value) {
    StackNode* newNode = (StackNode*)malloc(sizeof(StackNode));
    if (!newNode) {
        return false;
    }
    newNode->data = value;
    newNode->next = stack->top;
    stack->top = newNode;
    return true;
}

// 出栈操作
bool pop(LinkedStack* stack, int* value) {
    if(isEmpty(stack)) {
        return false;
    }

    StackNode* temp = stack->top; //
    *value = temp->data;
    stack->top = temp->next;
    free(temp);
    return true;
}

// 获取栈顶元素
bool peek(LinkedStack* stack, int* value) {
    if (isEmpty(stack)) {
        return false;
    }

    *value = stack->top->data;
    return true;
}
```

## Queue

队列是一种遵循FIFO，First In First Out原则的线性数据结构，只允许在队尾进行插入操作，在队头进行插入操作。基本操作有enqueue、dequeue、peek/front。

以下是一些简单的实现方式：

```c
//数组实现
#define MAX_SIZE 100

typedef struct {
    int data[MAX_SIZE];
    int front;
    int rear;
    int size;
} CircularQueue;

// 初始化队列
void initQueue(CircularQueue* queue) {
    queue->front = 0;
    queue->rear = 0;
    queue->size = 0;
}

// 判断队列是否为空
bool isEmpty(CircularQueue* queue) {
    return queue->size == 0;
}

// 判断队列是否已满
bool isFull(CircularQueue* queue) {
    return queue->size == MAX_SIZE;
}

// 入队
bool enqueue(CircularQueue* queue, int value) {
    if (isFull(queue)) {
        return false;
    }

    queue->data[queue->rear] = value;
    queue->rear = (queue->rear + 1) % MAX_SIZE; //循环
    queue->size++;
    return true;
}

// 出队
bool dequeue(CircularQueue* queue, int* value) {
    if (isEmpty(queue)) {
        return false;
    }

    *value = queue->data[queue->front];
    queue->front = (queue->front + 1) % MAX_SIZE; //循环
    queue->size--;
    return true;
}

// 获取队头元素
bool peek(CircularQueue* queue, int* value) {
    if (isEmpty(queue)) {
        return false;
    }
    *value = queue->data[queue->front];
    return true;
}
```

```c
//链表实现
typedef struct QueueNode {
    int data;
    struct QueueNode* next;
} QueueNode;

typedef struct {
    QueueNode* front;
    QueueNode* rear;
} LinkedQueue;

// 初始化队列
void initQueue(LinkedQueue* queue) {
    queue->front = NULL;
    queue->rear = NULL;
}

// 判断队列是否为空
bool isEmpty(LinkedQueue* queue) {
    return queue->front == NULL;
}

// 入队
bool enqueue(LinkedQueue* queue, int value) {
    QueueNode* newNode = (QueueNode*)malloc(sizeof(QueueNode));
    if (!newNode) {
        return false;
    }

    newNode->data = value;
    newNode->next = NULL;

    if (isEmpty(queue)) {
        queue->front = newNode;
        queue->rear = newNode;
    } else {
        queue->rear->next = newNode;
        queue->rear = newNode;
    }
    return true;
}


// 出队
bool dequeue(LinkedQueue* queue, int* value) {
    if (isEmpty(queue)) {
        return false;
    }

    QueueNode* temp = queue->front;
    *value = temp->data;
    queue->front = queue->front->next;

    if(queue->front == NULL) {
        queue->rear = NULL;
    }
    free(temp);
    return true;
}

// 获取队列头元素
bool peek(LinkedQueue* queue, int* value) {
    if (isEmpty(queue)) {
        return false;
    }
    *value = queue->front->data;
    return true;
}
```