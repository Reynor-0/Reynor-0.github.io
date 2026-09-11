---
title: '随笔(三)：C/C++'
description: '随手记录看到的一些知识点'
tags: ['C/C++']
series: { id: 'essay', order: 3 }
pubDate: 'Aug 19 2026'
---

## const

最基本的用法很简单，就是定义一个只读的变量：
```c
const int a = 10;
```
以后便不能再通过`a = 20`来修改它了。

### const和指针

这里只需要记住一个原则，const 修饰谁，谁就是不可变的。举个例子：
```c
// 指向const 对象的指针
int a = 10;
const int *p = &a;
// 也可以写成
int const* p = &a; 
```
也就是代表p可以改变朝向，但是没法通过p来修改它指向的值。也就是pointer to const。而
```c
int a = 10;
int* const p = &a;
```
这里const是修饰的p。意思就是指针p自己不能修改，但可以修改它指向的对象。例如：
```c
int a = 10;
int b = 20;
int* const p = &a;

*p = 30; // 可以
p = &b; //不允许
```
也就叫做const pointer。

当然也可以把指向的数据和指针本身都const了
```c
const int* const p = &a;
```
这样不管是指针本身还是指向的数据都是不能修改的。

### const引用

现代C++中常常可以看到:
```cpp
void print(const std::string& s) 
{
    std::cout << s << std::endl;
}
```
这里`const std::string& s`表示s是对外部对象的引用，但是该函数承诺不会通过s修改该对象。

### 成员函数后面的const

我们来看以下的代码:
```cpp
class A {
public:
    int getValue() const;
};
```
这个const既不是用来修饰返回值，又不是用来修饰参数的，那么用来干嘛？是用来修饰这个成员函数的`this`指针，表示该函数不会修改对象的状态。

C++的成员函数其实都有一个`this`指针，例如:
```cpp
class Person{
private:
    int age;
public:
    int getAge() {
        return age;
    }
};


Person p;
p.getAge(); // 可以理解为编译器偷偷的传递进去getAge(&p)
```
也就是成员函数内部存在`this`指针。

**普通成员函数中的this**
```cpp
class A {
private:
    int value;

public:
    void setValue(int v) {
        value = v;
    }
};
```

假设普通成员函数中可以粗略的理解为:
```cpp
A* const this;
```
这里其实就是我们提到的const pointer，也就是指针本身不能变，但是指向的对象可以修改。所以；
```text
value = v; =========> this->value = v;
```

**const 成员函数的this**

假如上面的是:
```cpp
int getValue() const
{
    return value;
}
```
就可以简单的理解为以下的形式:
```cpp
const A* const this;
```
也就是：
```
this 自己不能变
↓
const A* const

this 指向的对象也不能通过 this 修改
```
编译器会报错，因为这就相当于向编译器承诺了：调用这个函数不会修改当前对象的普通成员状态。

### const 对象只能调用 const 成员函数

假如:
```cpp
class A {
public:
    void foo(){

    }

    void bar() const {

    }
};


//创建对象
const A a;
a.var();  // 没问题
a.foo();  // 报错
```

因为foo()没有承诺不修改对象，所以编译器会禁止调用，发出报错。

### 两个特例:

**mutable**
例如：
```cpp
class A {
private:
    int value_;
    mutable int access_count_;

public:
    int value() const
    {
        ++access_count_;   // ✅
        return value_;
    }
};
```
尽管value()方法是const修饰的，但是access_count_声明为mutable,也就是即使对象是 const，这个成员也允许修改。

**static**
例如：
```cpp
class A {
private:
    static int count_;

public:
    void foo() const
    {
        ++count_;    // 可以
    }
};
```

static修饰的成员是不属于对象的，而是属于这个类本身，const限制的是this指针。

## constexpr

constexpr是C++11引入的关键字，用于声明常量表达式。它允许在编译时计算常量的值，从而提高程序的性能。

```cpp
constexpr int square(int x) {
    return x * x;
}

int main() {
    constexpr int a = 5;
    constexpr int b = square(a);  // 在编译时计算
    return 0;
}
```

## static

static 的核心作用主要围绕两件事:
1. 改变对象的生命周期；
2. 改变名字的归属/链接属性。

它出现在不同作用于的时候，具体意义完全不同。

例如:
```cpp
static int a;              // 全局/命名空间作用域
void func() {
    static int b = 0;      // 局部作用域
}

class A {
    static int count;      // 静态数据成员
    static void foo();     // 静态成员函数
};
```

### 作用域和生命周期

作用域： scope，生命周期： lifetime，这二者不是一个意思。例如一般的函数:
```cpp
void func()
{
    int a = 10;
}
```
这时候a作用域就是func的花括号内。生命周期从进入func时创建到离开func时销毁。但是用static修饰的时候，尽管作用域仍在func的括号内，但是生命周期则延续到整个程序运行期间，也就是static 最典型的效果，不扩大作用域，但是延长生命周期。

### 局部变量中的static

刚刚介绍到了局部变量中的static修饰符的使用方法和效果。我们来看一个实例：
```cpp
void tick()
{
    static uint32_t counter = 0;
    counter++;
    std::cout << counter << std::endl;
}

tick();
tick();
tick();
```

这里我们可以看到输出的counter值从1增长到了3，说明尽管counter的生命周期得到了延长，假如去掉static，那么三次调用都会输出1.
此外，局部static函数只初始化一次，当程序运行到这条语句的时候第一次进行初始化，而不是程序启动的时候就一定构造。所以，当该条语句一次都没运行到的时候，对象就根本不会构造，这种模式叫function-local static。

**C++ 11后局部static 初始化是线程安全的**

假设：
```cpp
MyClass& instance()
{
    static Myclass obj;
    return obj;
}
```

多个线程第一次同时调用`instance()`的时候，C++ 11开始，保证obj的初始化只会正确发生一次。因此也有了以下的单例写法：
```cpp
class Signleton()
{
public:
    static Signleton& instance()
    {
        static Signleton obj;
        return obj;
    }

private:
    Singleton() = default;
}
```

### 全局作用域中的static

现在看：
```cpp
static uint32_t g_value = 10;
```

这里全局变量的static和局部的static意思就完全不同了，本身全局变量就是又静态存储期的，本来就从程序开始活到程序结束。这里主要的功能为：

> 限制这个名字只在当前源文件（translation unit）中可见。

**什么叫当前源文件可见？**

例如在a.cpp中:
```cpp
static uint32_t g_value = 0;
```
而在b.cpp中
```cpp
extern g_value;
void func()
{
    std::cout << g_value;
}
```
一般会链接失败，因为a.cpp中的g_value通常拥有internal linkage，叫做内部链接，意思是g_value 只属于 a.cpp 这个翻译单元。

### 全局static函数

函数也是一样，用static修饰的函数对于别的cpp文件来说就是无法连接的。但是在现代C++中更推荐匿名namespace。

### 类中的static成员


**static 成员变量**
```cpp
class Camera {
public:
    static int count;
};
```

static 成员只属于类，不属于某个具体对象。不管创建多少个对象，所有对象共享同一个该成员，因此常被用来统计对象的数量。


**static 成员函数**
```cpp
class Camera {
public:
    static void printInfo()
    {
    }
};
```
这种函数最大的特点：它没有 this 指针。而这里可以直接用Camera::printInfo()来调用，因为他是属于类的，根本不需要对象，所以他没有this。

**static 成员函数不能直接访问普通成员**，但如果拿到了对象static 函数还是可以访问普通成员。

### static 成员函数典型的用途

**工厂函数**:
```cpp
class Camera{
public:
    static Camera createDefault()
    {
        Camera camera;
        retuurn camera;
    }
};

Camera camera = Camera::createDefault();
```

**类级工具函数**

**单例接口**
```cpp
class DeviceManager {
public:
    static DeviceManager& instance()
    {
        static DeviceManager obj;
        return obj;
    }
};
```

### static和栈/数据段

普通的局部变量通常位于栈上，而static变量则位于数据段(.data .bss)中，具体看初始化情况。






















