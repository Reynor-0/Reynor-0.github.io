---
title: '静态库与动态库：从原理、制作到问题排查'
description: '系统整理 C/C++ 项目中静态库和动态库的概念、制作方式、使用注意事项以及常见链接和运行问题的排查方法。'
pubDate: 'Jul 08 2026'
---

## 1. 为什么需要库

在大型 C/C++ 项目中，代码通常不会全部写在一个 `.c` 文件里，也不会每次都把所有源文件直接编译成一个可执行程序。

随着项目变大，常常会把一些通用功能封装起来，例如：

```text
日志模块
数学工具模块
通信协议模块
驱动模块
平台抽象层
算法模块
```

这些模块可以被编译成“库”，供其他程序复用。

库的本质可以简单理解为：

```text
库 = 一组已经编译好的目标文件的集合
```

假设有如下源文件：

```text
add.c
sub.c
log.c
```

它们可以先被编译成：

```text
add.o
sub.o
log.o
```

然后再打包或链接成库：

```text
libcalc.a    静态库
libcalc.so   动态库
```

其他程序只需要包含对应头文件，并在链接时链接这个库，就可以使用库中提供的函数。

---

## 2. 头文件和库文件的关系

理解库之前，必须先分清楚头文件和库文件的作用。

头文件通常提供：

```text
函数声明
类型定义
宏定义
结构体定义
枚举定义
对外 API 说明
```

库文件提供：

```text
函数的真实机器码实现
全局变量定义
模块内部逻辑
```

例如头文件 `calc.h`：

```c
#ifndef CALC_H
#define CALC_H

int add(int a, int b);
int sub(int a, int b);

#endif
```

它只是告诉编译器：

```text
有 add 和 sub 这两个函数，它们的参数和返回值是这样的。
```

但是函数真正的实现是在源文件中：

```c
int add(int a, int b)
{
    return a + b;
}
```

当源文件被编译后，函数实现会进入 `.o` 文件，再进一步进入静态库或动态库。

所以可以这样理解：

```text
头文件解决“编译阶段认识函数”的问题；
库文件解决“链接阶段找到函数实现”的问题。
```

如果只有头文件，没有库文件，编译可能通过，但链接会失败。

如果只有库文件，没有头文件，链接时库是存在的，但写代码时编译器不知道函数如何调用，也容易出错。

---

## 3. 静态库是什么

静态库通常以 `.a` 结尾，例如：

```text
libcalc.a
libdriver.a
libutils.a
```

它本质上是多个 `.o` 文件的归档包。

例如：

```text
libcalc.a
├── add.o
├── sub.o
└── mul.o
```

静态库的特点是：

```text
程序链接时，链接器会把静态库中用到的目标代码复制进最终可执行文件。
```

例如：

```bash
gcc main.o -L. -lcalc -o app
```

如果 `main.o` 使用了 `libcalc.a` 中的 `add()` 函数，那么链接器会把 `add()` 对应的机器码放进最终的 `app` 里。

最终生成的 `app` 已经包含了所需代码，运行时不再依赖 `libcalc.a`。

### 静态库的优点

静态库的优点包括：

```text
部署简单，最终可执行文件通常可以单独运行
运行时不需要额外查找库文件
适合嵌入式、裸机、单文件部署场景
版本依赖较少
```

### 静态库的缺点

静态库的缺点包括：

```text
可执行文件体积可能变大
多个程序使用同一个静态库时，每个程序都会各自包含一份代码
库更新后，通常需要重新链接可执行程序
不适合频繁独立升级的模块
```

---

## 4. 动态库是什么

动态库通常以 `.so` 结尾，例如：

```text
libcalc.so
libpthread.so
libc.so
```

动态库不会在链接时完整复制进可执行文件。程序中只会记录自己依赖某个动态库，运行时再由动态链接器加载这个 `.so` 文件。

例如：

```bash
gcc main.o -L. -lcalc -o app
```

如果链接的是 `libcalc.so`，那么最终的 `app` 中会记录：

```text
我运行时需要 libcalc.so
```

程序启动时，系统动态链接器会查找并加载这个动态库。

### 动态库的优点

动态库的优点包括：

```text
可执行文件体积较小
多个进程可以共享同一个动态库的代码段
库可以单独升级
适合插件化、系统库、公共模块
```

### 动态库的缺点

动态库的缺点包括：

```text
运行时必须能找到对应 .so 文件
部署相对复杂
容易出现动态库版本不匹配
容易出现运行时链接错误
ABI 不兼容时可能导致程序崩溃
```

---

## 5. 静态库和动态库的对比

| 对比项 | 静态库 `.a` | 动态库 `.so` |
| --- | --- | --- |
| 链接方式 | 链接时拷贝代码进可执行文件 | 运行时加载 |
| 可执行文件体积 | 较大 | 较小 |
| 运行时是否依赖库文件 | 不依赖 `.a` | 依赖 `.so` |
| 更新库是否需要重新链接程序 | 通常需要 | ABI 兼容时可以只替换 `.so` |
| 部署复杂度 | 较低 | 较高 |
| 多进程共享代码 | 不方便 | 可以共享 |
| 常见场景 | 嵌入式、单文件部署、工具程序 | Linux 系统库、插件、公共组件 |

一句话总结：

```text
静态库是在链接时被打包进程序；
动态库是在运行时被加载进进程。
```

---

## 6. 示例项目结构

下面用一个简单的 `calc` 库作为例子。

项目结构：

```text
calc_project/
├── include/
│   └── calc.h
├── src/
│   ├── add.c
│   └── sub.c
└── main.c
```

头文件 `include/calc.h`：

```c
#ifndef CALC_H
#define CALC_H

int add(int a, int b);
int sub(int a, int b);

#endif
```

源文件 `src/add.c`：

```c
#include "calc.h"

int add(int a, int b)
{
    return a + b;
}
```

源文件 `src/sub.c`：

```c
#include "calc.h"

int sub(int a, int b)
{
    return a - b;
}
```

测试程序 `main.c`：

```c
#include <stdio.h>
#include "calc.h"

int main(void)
{
    printf("add = %d\n", add(3, 2));
    printf("sub = %d\n", sub(3, 2));
    return 0;
}
```

---

## 7. 如何制作静态库

### 7.1 编译源文件为目标文件

先把 `.c` 文件编译成 `.o` 文件：

```bash
gcc -Iinclude -c src/add.c -o add.o
gcc -Iinclude -c src/sub.c -o sub.o
```

参数说明：

```text
-Iinclude   指定头文件搜索路径
-c          只编译，不链接
-o          指定输出文件
```

执行后得到：

```text
add.o
sub.o
```

---

### 7.2 使用 ar 打包静态库

使用 `ar` 命令生成静态库：

```bash
ar rcs libcalc.a add.o sub.o
```

参数含义：

```text
ar    静态库归档工具
r     replace，将目标文件加入库中，如果已存在则替换
c     create，如果库不存在则创建
s     symbol index，生成符号索引
```

生成结果：

```text
libcalc.a
```

静态库命名通常遵循规则：

```text
lib + 库名 + .a
```

例如：

```text
libcalc.a
libutils.a
libdriver.a
```

使用 `-l` 链接时：

```bash
-lcalc
```

对应查找的是：

```text
libcalc.a
libcalc.so
```

---

### 7.3 查看静态库内容

查看静态库中包含哪些目标文件：

```bash
ar t libcalc.a
```

可能输出：

```text
add.o
sub.o
```

查看静态库中的符号：

```bash
nm libcalc.a
```

可能看到：

```text
add.o:
0000000000000000 T add

sub.o:
0000000000000000 T sub
```

其中：

```text
T 表示该符号在代码段中定义，通常是函数定义
U 表示该符号未定义，需要其他目标文件或库提供
D 表示已初始化全局变量
B 表示未初始化全局变量
```

---

### 7.4 使用静态库

方式一：直接指定静态库文件：

```bash
gcc main.c -Iinclude libcalc.a -o app
```

方式二：使用 `-L` 和 `-l`：

```bash
gcc main.c -Iinclude -L. -lcalc -o app
```

参数说明：

```text
-L.       在当前目录查找库
-lcalc    查找 libcalc.a 或 libcalc.so
```

运行：

```bash
./app
```

输出：

```text
add = 5
sub = 1
```

---

## 8. 如何制作动态库

动态库制作和静态库类似，但有两个关键点：

```text
编译目标文件时通常需要 -fPIC
生成动态库时需要 -shared
```

---

### 8.1 使用 -fPIC 编译目标文件

```bash
gcc -Iinclude -fPIC -c src/add.c -o add.o
gcc -Iinclude -fPIC -c src/sub.c -o sub.o
```

`-fPIC` 的含义是：

```text
Position Independent Code
位置无关代码
```

动态库可能被加载到不同进程的不同虚拟地址中，所以动态库中的代码不能依赖固定地址。使用 `-fPIC` 可以生成适合动态库的目标文件。

---

### 8.2 使用 -shared 生成动态库

```bash
gcc -shared add.o sub.o -o libcalc.so
```

生成结果：

```text
libcalc.so
```

也可以一步完成：

```bash
gcc -Iinclude -fPIC -shared src/add.c src/sub.c -o libcalc.so
```

但是在大型项目中，更常见的是：

```text
.c -> .o -> .so
```

这样更便于增量编译和模块管理。

---

### 8.3 使用动态库

编译测试程序：

```bash
gcc main.c -Iinclude -L. -lcalc -o app
```

如果当前目录同时存在：

```text
libcalc.a
libcalc.so
```

默认情况下，链接器通常会优先选择动态库 `libcalc.so`。

运行：

```bash
./app
```

此时可能出现错误：

```text
./app: error while loading shared libraries: libcalc.so: cannot open shared object file: No such file or directory
```

这是因为：

```text
链接时找到了 libcalc.so；
运行时动态链接器没有找到 libcalc.so。
```

---

## 9. 动态库运行时查找路径

动态库有两个查找阶段：

```text
链接时查找
运行时查找
```

编译命令中的：

```bash
-L.
```

只影响链接阶段，表示链接器在当前目录查找库。

但是程序运行时，动态链接器不一定会去当前目录查找 `.so`。

解决方式通常有三种。

---

### 9.1 使用 LD_LIBRARY_PATH

临时运行：

```bash
LD_LIBRARY_PATH=. ./app
```

或者导出环境变量：

```bash
export LD_LIBRARY_PATH=$PWD:$LD_LIBRARY_PATH
./app
```

这种方式适合临时测试。

---

### 9.2 安装到系统库路径

例如：

```bash
sudo cp libcalc.so /usr/local/lib/
sudo ldconfig
```

然后运行：

```bash
./app
```

这种方式适合系统级安装，但需要管理员权限。

---

### 9.3 使用 rpath

编译时写入运行时搜索路径：

```bash
gcc main.c -Iinclude -L. -lcalc -Wl,-rpath,'$ORIGIN' -o app
```

其中：

```text
-Wl,xxx    把 xxx 传给链接器
-rpath     写入运行时库搜索路径
$ORIGIN    表示可执行文件所在目录
```

这样 `app` 运行时会在自身所在目录查找 `libcalc.so`。

查看是否写入成功：

```bash
readelf -d app | grep -i rpath
readelf -d app | grep -i runpath
```

---

## 10. 制作库时需要注意的点

### 10.1 头文件要设计清楚

库对外暴露的函数应该放在头文件中。

例如：

```c
int add(int a, int b);
int sub(int a, int b);
```

不希望外部使用的内部函数，不应该写进公共头文件。

公共头文件要尽量保持稳定，因为它代表库的 API。

---

### 10.2 内部函数尽量使用 static

如果某个函数只在当前 `.c` 文件内部使用，建议加 `static`。

例如：

```c
static int helper(int x)
{
    return x * 2;
}
```

这样这个函数不会暴露给其他目标文件，也不容易产生符号冲突。

如果不加 `static`：

```c
int helper(int x)
{
    return x * 2;
}
```

它可能成为全局符号，在大型项目中容易和其他模块的同名函数冲突。

---

### 10.3 动态库目标文件要使用 -fPIC

制作动态库时，目标文件建议都用 `-fPIC` 编译。

否则可能出现类似错误：

```text
relocation R_X86_64_PC32 against symbol `xxx' can not be used when making a shared object; recompile with -fPIC
```

解决方式：

```bash
gcc -fPIC -c foo.c -o foo.o
gcc -shared foo.o -o libfoo.so
```

---

### 10.4 静态库和动态库最好分开生成目标文件

如果一个项目同时生成静态库和动态库，建议使用两套目标文件：

```text
普通 .o       用于静态库
PIC .pic.o    用于动态库
```

例如：

```bash
gcc -Iinclude -c src/add.c -o add.o
gcc -Iinclude -fPIC -c src/add.c -o add.pic.o
```

这样更清晰，也能避免动态库因为缺少 `-fPIC` 出错。

---

### 10.5 库名要符合规范

如果希望通过：

```bash
-lcalc
```

链接库，那么库文件必须叫：

```text
libcalc.a
libcalc.so
```

链接器不会根据 `-lcalc` 去找：

```text
calc.a
calc.so
```

所以库命名要遵循：

```text
lib + name + .a
lib + name + .so
```

---

### 10.6 库和头文件版本要匹配

库文件和头文件应该来自同一个版本。

如果头文件声明的是：

```c
int add(int a, int b, int c);
```

但库中真实实现是：

```c
int add(int a, int b);
```

就可能导致：

```text
链接失败
运行异常
参数传递错误
ABI 不兼容
```

发布库时，通常应该同时发布：

```text
include/   头文件
lib/       库文件
README     使用说明
```

不要只替换 `.so`，却忘记同步对应头文件。

---

### 10.7 注意 ABI 兼容性

动态库可以单独升级，但前提是 ABI 兼容。

ABI 包括：

```text
函数名
参数类型
返回值类型
结构体布局
枚举值
全局变量
调用约定
符号可见性
```

例如结构体原来是：

```c
typedef struct {
    int a;
    int b;
} Config;
```

后来改成：

```c
typedef struct {
    int a;
    int b;
    int c;
} Config;
```

如果旧程序没有重新编译，却加载了新动态库，就可能出现结构体布局不一致的问题。

动态库升级时要特别注意：

```text
不要随意修改对外结构体布局
不要随意修改函数参数
不要随意删除已导出的符号
必要时使用版本号管理
```

---

### 10.8 C 和 C++ 混编要使用 extern "C"

如果 C 库要给 C++ 使用，头文件中建议写：

```c
#ifndef CALC_H
#define CALC_H

#ifdef __cplusplus
extern "C" {
#endif

int add(int a, int b);
int sub(int a, int b);

#ifdef __cplusplus
}
#endif

#endif
```

因为 C++ 会进行 name mangling，导致符号名和 C 不一致。

如果没有 `extern "C"`，可能出现：

```text
undefined reference to `add(int, int)'
```

---

## 11. 静态库 Makefile 示例

```makefile
CC := gcc
AR := ar

CFLAGS := -Wall -Wextra -g -Iinclude

STATIC_LIB := libcalc.a
OBJS := add.o sub.o

.PHONY: all clean

all: $(STATIC_LIB) app

$(STATIC_LIB): $(OBJS)
	$(AR) rcs $@ $^

add.o: src/add.c include/calc.h
	$(CC) $(CFLAGS) -c $< -o $@

sub.o: src/sub.c include/calc.h
	$(CC) $(CFLAGS) -c $< -o $@

app: main.c $(STATIC_LIB)
	$(CC) $(CFLAGS) main.c -L. -lcalc -o $@

clean:
	rm -f *.o *.a app
```

---

## 12. 动态库 Makefile 示例

```makefile
CC := gcc

CFLAGS := -Wall -Wextra -g -Iinclude -fPIC
SHARED_LIB := libcalc.so
OBJS := add.o sub.o

.PHONY: all clean

all: $(SHARED_LIB) app

$(SHARED_LIB): $(OBJS)
	$(CC) -shared $^ -o $@

add.o: src/add.c include/calc.h
	$(CC) $(CFLAGS) -c $< -o $@

sub.o: src/sub.c include/calc.h
	$(CC) $(CFLAGS) -c $< -o $@

app: main.c $(SHARED_LIB)
	$(CC) -Wall -Wextra -g -Iinclude main.c -L. -lcalc -Wl,-rpath,'$$ORIGIN' -o $@

clean:
	rm -f *.o *.so app
```

注意，在 Makefile 中如果要传递 `$ORIGIN`，需要写成：

```makefile
'$$ORIGIN'
```

因为 Makefile 中 `$` 有特殊含义。

---

## 13. 常见问题与排查方式

### 13.1 undefined reference to xxx

错误示例：

```text
undefined reference to `add'
```

含义是：

```text
编译器知道 add 这个函数声明；
但是链接器找不到 add 的函数实现。
```

常见原因：

```text
对应 .c 文件没有编译
对应 .o 文件没有参与链接
静态库或动态库没有链接
库路径 -L 写错
库名 -l 写错
静态库链接顺序错误
函数被条件编译裁掉
C/C++ 混编缺少 extern "C"
```

排查命令：

```bash
nm main.o | grep add
nm libcalc.a | grep add
nm -D libcalc.so | grep add
```

如果在 `main.o` 中看到：

```text
U add
```

说明 `main.o` 需要外部提供 `add`。

如果在库中看到：

```text
T add
```

说明库中定义了 `add`。

如果库中没有 `T add`，说明库里根本没有这个函数实现。

---

### 13.2 multiple definition of xxx

错误示例：

```text
multiple definition of `global_value'
```

含义是：

```text
同一个全局符号被定义了多次。
```

常见错误是在头文件中定义全局变量。

错误写法：

```c
// config.h
int global_value = 10;
```

如果多个 `.c` 文件都包含这个头文件，每个 `.c` 都会定义一个 `global_value`，链接时就会报多重定义。

正确写法：

```c
// config.h
extern int global_value;
```

然后在一个 `.c` 文件中定义：

```c
// config.c
int global_value = 10;
```

排查命令：

```bash
nm *.o | grep global_value
```

如果多个 `.o` 都有：

```text
D global_value
```

说明多个目标文件都定义了这个全局变量。

---

### 13.3 动态库运行时找不到

错误示例：

```text
error while loading shared libraries: libcalc.so: cannot open shared object file: No such file or directory
```

含义是：

```text
程序链接时找到了 libcalc.so；
但是运行时动态链接器找不到 libcalc.so。
```

排查命令：

```bash
ldd ./app
```

如果看到：

```text
libcalc.so => not found
```

说明运行时库路径有问题。

解决方式：

```bash
LD_LIBRARY_PATH=. ./app
```

或者使用 rpath：

```bash
gcc main.c -Iinclude -L. -lcalc -Wl,-rpath,'$ORIGIN' -o app
```

---

### 13.4 找到了错误版本的动态库

如果系统中有多个同名动态库，例如：

```text
/usr/lib/libcalc.so
/home/user/project/libcalc.so
```

程序可能加载了错误版本。

排查：

```bash
ldd ./app
```

查看实际加载的是哪个库。

更详细的排查方式：

```bash
LD_DEBUG=libs ./app
```

这个命令会打印动态链接器查找库的详细过程。

---

### 13.5 静态库链接顺序错误

错误示例：

```text
undefined reference to `add'
```

但你确认 `libcalc.a` 中有 `add`。

错误写法：

```bash
gcc -L. -lcalc main.o -o app
```

正确写法：

```bash
gcc main.o -L. -lcalc -o app
```

原因是传统链接器通常从左到右扫描：

```text
先看到 main.o，发现需要 add；
再看到 -lcalc，从库中取出 add。
```

如果顺序反了，链接器先看到库，但此时还不知道后面需要哪些符号，可能不会从库中取出对应目标文件。

原则是：

```text
使用者放前面；
被依赖库放后面。
```

如果多个静态库互相依赖，可以使用：

```bash
gcc main.o -Wl,--start-group -lA -lB -Wl,--end-group -o app
```

---

### 13.6 动态库制作时没有使用 -fPIC

错误示例：

```text
relocation R_X86_64_PC32 against symbol `xxx' can not be used when making a shared object; recompile with -fPIC
```

原因是：

```text
用于生成动态库的目标文件不是位置无关代码。
```

解决：

```bash
gcc -fPIC -c src/add.c -o add.o
gcc -fPIC -c src/sub.c -o sub.o
gcc -shared add.o sub.o -o libcalc.so
```

---

### 13.7 C 和 C++ 混编符号不匹配

错误示例：

```text
undefined reference to `add(int, int)'
```

如果库是 C 编译的，而调用方是 C++，可能是 name mangling 导致的。

排查：

```bash
nm libcalc.a | grep add
nm main.o | grep add
```

如果 C++ 目标文件中看到类似：

```text
_Z3addii
```

说明符号被 C++ 改名了。

解决方法是在头文件中加入：

```c
#ifdef __cplusplus
extern "C" {
#endif

int add(int a, int b);

#ifdef __cplusplus
}
#endif
```

---

### 13.8 交叉编译时库架构不匹配

错误示例：

```text
file format not recognized
```

或者：

```text
wrong ELF class
```

常见原因是：

```text
目标程序是 ARM 架构；
库却是 x86 架构。
```

排查：

```bash
file libcalc.a
file libcalc.so
readelf -h add.o
```

如果目标是 ARM，应该看到类似：

```text
Machine: ARM
```

如果看到：

```text
Machine: Advanced Micro Devices X86-64
```

说明库是 x86 平台编译出来的，不能用于 ARM 目标。

解决方式是使用同一套交叉编译工具链重新编译库：

```bash
arm-none-eabi-gcc -Iinclude -c src/add.c -o add.o
arm-none-eabi-ar rcs libcalc.a add.o
```

---

## 14. 常用排查命令总结

### 查看静态库中有哪些目标文件

```bash
ar t libcalc.a
```

### 查看符号表

```bash
nm libcalc.a
nm add.o
nm -D libcalc.so
```

### 查看动态库依赖

```bash
ldd ./app
ldd ./libcalc.so
```

### 查看 ELF 信息

```bash
readelf -h app
readelf -d app
readelf -Ws libcalc.so
```

### 查看库或目标文件架构

```bash
file app
file libcalc.so
file libcalc.a
file add.o
```

### 查看动态链接器查找过程

```bash
LD_DEBUG=libs ./app
```

### 查看完整编译或链接命令

```bash
gcc -v main.o -L. -lcalc -o app
```

如果是 Makefile 项目，有些项目支持：

```bash
make V=1
```

或者：

```bash
make VERBOSE=1
```

---

## 15. 推荐的制作流程

如果要制作自己的库，可以按照下面流程：

```text
1. 设计公共头文件
   include/calc.h

2. 编写源文件
   src/add.c
   src/sub.c

3. 确认哪些函数是对外 API
   对外函数写入头文件
   内部函数使用 static

4. 制作静态库
   gcc -Iinclude -c src/add.c -o add.o
   gcc -Iinclude -c src/sub.c -o sub.o
   ar rcs libcalc.a add.o sub.o

5. 制作动态库
   gcc -Iinclude -fPIC -c src/add.c -o add.pic.o
   gcc -Iinclude -fPIC -c src/sub.c -o sub.pic.o
   gcc -shared add.pic.o sub.pic.o -o libcalc.so

6. 编写测试程序
   main.c

7. 链接测试
   gcc main.c -Iinclude -L. -lcalc -o app

8. 如果使用动态库，确认运行时路径
   ldd ./app
   LD_LIBRARY_PATH=. ./app

9. 使用 nm / readelf / file 检查符号和架构
```

---

## 16. 最终总结

静态库：

```text
文件后缀通常是 .a
本质是多个 .o 文件的打包集合
链接时把用到的代码复制进可执行程序
运行时不依赖 .a 文件
适合嵌入式、单文件部署、稳定模块
```

制作方式：

```bash
gcc -c foo.c -o foo.o
ar rcs libfoo.a foo.o
```

动态库：

```text
文件后缀通常是 .so
运行时由动态链接器加载
可执行程序运行时依赖 .so 文件
适合系统库、插件、可独立升级模块
```

制作方式：

```bash
gcc -fPIC -c foo.c -o foo.o
gcc -shared foo.o -o libfoo.so
```

最常见问题包括：

```text
undefined reference        链接阶段找不到符号定义
multiple definition        全局符号重复定义
cannot open shared object  运行时找不到动态库
recompile with -fPIC       动态库目标文件没有使用 -fPIC
wrong ELF class            架构或 32/64 位不匹配
C++ name mangling          C/C++ 混编缺少 extern "C"
```

最重要的理解是：

```text
头文件负责声明；
源文件负责编译出目标文件；
静态库是目标文件的打包；
动态库是可被运行时加载的共享目标文件；
编译阶段看头文件；
链接阶段找库；
动态库还需要额外处理运行时查找路径。
```