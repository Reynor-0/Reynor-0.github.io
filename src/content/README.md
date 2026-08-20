# 内容目录使用说明

博客分类由各文章目录的 `_category.json` 配置，技术专栏统一由 `series.json` 配置，不需要修改 TypeScript 枚举或页面代码。界面名称只读取 JSON 的 `title`。

## 新增博客分类

例如新增“旅游”分类：

```text
src/content/blog/
└─ travel/
   ├─ _category.json
   └─ my-first-trip.md
```

`_category.json`：

```json
{
  "title": "旅游",
  "description": "旅行记录、路线与见闻。",
  "order": 70
}
```

配置字段：

- `title`：侧栏显示名称，必填。
- `description`：分类说明，可省略。
- `order`：侧栏排序，数字越小越靠前，可省略，默认 `100`。
- `homeSection`：是否把该分类的最近文章展示到首页项目区域，默认 `false`，通常只设置一个分类。

只创建目录和 `_category.json`、还没有文章时，文章侧栏也会显示这个分类，并标记为 `0` 篇。

文章属于哪个分类只由 Markdown 所在的第一层目录决定。因此文章不写 `category`：

```yaml
---
title: "第一次旅行"
description: "记录路线与途中见闻。"
tags: ["旅行"]
pubDate: "Aug 19 2026"
---
```

如果文章目录缺少 `_category.json`，构建会直接报错；系统不会把目录名临时转换成界面名称。

## 新增专栏

所有专栏都集中维护在一个文件中：

```text
src/content/series.json
```

在 `series.json` 数组中增加一项：

```json
[
  {
    "id": "camera",
    "title": "Camera 开发",
    "description": "从采集到显示的 Camera 开发记录。",
    "order": 70
  }
]
```

配置字段：

- `id`：专栏唯一标识，必填；供文章关联并用于 `/series/<id>/` 路由，不依赖任何目录名称。
- `title`：专栏名称，必填。
- `description`：专栏列表和页面摘要，可省略。
- `order`：专栏列表排序，数字越小越靠前，可省略，默认 `100`。

然后在任意博客文章的 frontmatter 中加入：

```yaml
series:
  id: camera
  order: 1
```

其中 `id` 必须与 `series.json` 中某一项的 `id` 一致。以后继续增加 `order: 2`、`order: 3` 的文章，专栏数量、专栏目录、上一篇和下一篇会自动更新。

文章分类与专栏彼此独立：分类只由 Markdown 所在的第一层目录决定，同一专栏的文章可以分散在不同分类。普通文章页面的左栏始终按“分类 → 文章”展示；从专栏页面进入阅读时，左栏才展示该专栏的章节目录。

只在 `series.json` 中增加配置、还没有任何文章时，专栏列表也会显示该专栏；进入后会看到“专栏已经建立”的空状态。

如果文章引用了尚未配置的专栏 ID，构建会直接报错；系统不会使用 ID 生成兜底标题。

## `order` 的完整规则

- `_category.json` 的 `order`：决定博客侧栏中一级分类的顺序，数字越小越靠前。
- `series.json` 中专栏项的 `order`：决定专栏总览中的专栏顺序，数字越小越靠前。
- 文章 frontmatter 中 `series.order`：决定文章在专栏内部的章节顺序，`1` 是第一篇；同一专栏内不能重复。
- JSON 中省略 `order` 时默认为 `100`；数值相同时，再按界面标题排序。

## 文件与 URL 规则

- 博客公开地址仍由 Markdown 文件名决定，与所在目录无关。
- `src/content/blog/projects/demo.md` 的地址仍是 `/blog/demo/`。
- 不同分类目录下不要使用相同的 Markdown 文件名。
- 分类目录和专栏 `id` 建议只使用小写字母、数字、连字符与下划线。
- 同一专栏内的 `order` 不能重复，否则构建会明确报错。
