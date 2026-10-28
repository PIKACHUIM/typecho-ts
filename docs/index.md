---
layout: home
hero:
  name: Typecho on Workers
  text: 把熟悉的前台，带到 Cloudflare
  tagline: Hono · Workers · D1 · R2
  actions:
    - theme: brand
      text: 本地快速预览
      link: /guide/quick-start
    - theme: alt
      text: 部署指南
      link: /guide/deploy
features:
  - title: 继续使用 PHP 模板
    details: 内置主题模板保留 PHP 源码，由项目解释器渲染为页面。
  - title: Cloudflare 原生存储
    details: 页面请求由 Worker 处理，站点数据放在 D1，附件对象映射到 R2。
  - title: 先预览，再决定
    details: 空库首次访问可初始化站点并创建管理员；完整管理功能仍在迁移中。
---

## 项目简介

把 Typecho 前台放到 Cloudflare Workers 上运行：Hono 接收请求，D1 保存文章与站点数据，R2 负责附件对象存储。页面仍由 PHP 风格的主题模板生成，熟悉的主题结构没有被改成另一套模板语言。

## 适合做什么

这是一个把 Typecho 前台迁移到 Cloudflare 的实验性项目。目前仓库内的 `default` 和 `classic-22` 主题可以用演示数据渲染，适合想了解 Workers 上如何运行 Typecho 模板、或想在本地看看效果的开发者和站长。

空白 D1 数据库首次访问会进入初始化向导，可以设置站点信息并创建管理员账户；登录入口为 `/admin/login.php`。文章、页面、评论、设置和图片附件的基础操作已接入，但第三方插件运行时、完整后台及数据导入仍未实现。请先把它当作预览版，不要承载正式站点或重要数据。

## 请求如何经过项目

```text
浏览器请求
    │
    ├── 页面 ──> Hono Worker ──> D1 读取站点数据
    │                    └────> PHP 模板解释器 ──> HTML
    ├── 主题静态文件 ──> Cloudflare Assets
    └── /usr/uploads/* ──> Worker ──> R2
```

模板保留 PHP 源码，由 `php-parser` 解析成语法树，再由项目内的解释器执行。文章和设置从 D1 读取；`/usr/uploads/` 下的附件请求映射到 R2。

## 文档导航

- [本地快速预览](/guide/quick-start)：准备环境、初始化本地 D1，并查看演示首页。
- [部署到 Cloudflare](/guide/deploy)：通过部署按钮或 Wrangler 创建并发布 Worker。

部署后首次打开 Worker 地址会显示初始化向导。初始化后可以登录，但完整管理后台仍在迁移中；部署成功不代表已经具备完整的 Typecho 运营能力。
