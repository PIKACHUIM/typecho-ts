# Typecho on Cloudflare Workers

[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com/)
[![Hono](https://img.shields.io/badge/Framework-Hono-E36002)](https://hono.dev/)
[![D1](https://img.shields.io/badge/Database-D1-2463EB)](https://developers.cloudflare.com/d1/)
[![R2](https://img.shields.io/badge/Storage-R2-2463EB)](https://developers.cloudflare.com/r2/)
[![GPL-2.0](https://img.shields.io/badge/License-GPL--2.0-blue.svg)](LICENSE.txt)

## 简介

把熟悉的 Typecho 前台带到 Cloudflare Workers：Hono 负责接收请求，D1 保存站点数据，R2 用来放附件。现在仓库里有 `default` 和 `classic-22` 两套主题模板，页面由 Worker 渲染，不需要单独维护 PHP 主机。

空白 D1 数据库首次访问会进入初始化向导，可以设置站点信息并创建管理员账户；`/admin/login.php` 提供登录与会话。后台目前提供基础文章和页面管理、分类标签、评论审核、用户资料与站点设置，以及图片附件管理；前台提供搜索、评论提交和 RSS/Atom。内置 `HelloWorld` 插件可在 `/admin/plugins.php` 按需启用，PHP Hook 目前仅覆盖后台菜单；任意第三方插件、主题语法和扩展 API、其他后台页面、XML-RPC 与数据导入仍未对齐。**请先用于体验和验证，不要承载重要数据。**

[使用文档与教程](docs/index.md) · [查看源码](https://github.com/PIKACHUIM/typecho-ts)

## 它是怎么工作的

Worker 收到请求后，用 D1 读取文章、分类和站点设置，再按路由挑选主题模板。模板仍然是 PHP 文件；项目用 `php-parser` 读取它们，并由自己的解释器执行，最后返回 HTML。主题静态资源由 Cloudflare Assets 提供，附件路径则映射到 R2。

这样做的目标是尽量保留 Typecho 模板熟悉的写法，同时把运行环境换成 Cloudflare 的边缘服务。当前解释器只覆盖内置主题和受控示例插件用到的 PHP 子集。示例插件默认关闭，启用后会在后台执行打包的 `Plugin.php`；任意第三方插件无法直接上传运行，第三方主题也需要先核对语法与 Typecho API 支持情况。

## 架构

```text
浏览器
  ├─ 页面请求 ───────────────> Hono Worker ──> D1
  │                                  └────────> PHP 模板解释器 ──> HTML
  ├─ 主题与后台静态资源 ──────> Cloudflare Assets
  └─ /usr/uploads/* ──────────> Hono Worker ──> R2
```

## 一键部署

<a href="https://deploy.workers.cloudflare.com/?url=https://github.com/PIKACHUIM/typecho-ts"><img src="https://deploy.workers.cloudflare.com/button" alt="Deploy to Cloudflare"></a>

Cloudflare 会根据 `wrangler.toml` 创建并绑定 Worker 所需的 D1、R2 资源；部署脚本会生成主题模板、应用 D1 表结构并发布 Worker。

部署完成后，打开 Worker 地址即可设置站点标题、管理员账户等信息；之后通过 `/admin/login.php` 登录。后台已接入基础写作、评论、站点设置和图片上传，但尚不具备原版 Typecho 的全部管理与插件能力，不适合直接承载正式站点。不要把本地演示数据导入生产环境。

## 手动部署

需要 Node.js 20 或更新版本、一个 Cloudflare 账号，以及 Wrangler 登录权限。

1. 获取代码并安装依赖：

   ```bash
   git clone https://github.com/PIKACHUIM/typecho-ts.git
   cd typecho-ts
   npm install
   npx wrangler login
   ```

2. 创建 D1 数据库与 R2 bucket：

   ```bash
   npx wrangler d1 create typecho
   npx wrangler r2 bucket create typecho-files
   ```

3. 把 `wrangler.toml` 中 `database_id` 的占位值替换为 D1 创建命令返回的 ID。数据库名和 bucket 名分别保持为 `typecho`、`typecho-files`。

4. 生成主题、应用远程 D1 迁移并部署：

   ```bash
   npm run deploy
   ```

`npm run deploy` 会先运行 `npm run gen`，然后应用 D1 迁移并发布 Worker。部署后可在 Cloudflare 控制台为 Worker 绑定域名；首次访问会进入初始化向导。部署和初始化已经打通，但管理功能仍在迁移中。

本地演示请看[快速预览教程](docs/guide/quick-start.md)。`scripts/seed-local.sql` 会清空并重建本地演示数据，**只供本地开发使用**，不要对远程数据库执行。

## 目录结构

```text
src/                 Worker 入口、D1 查询、路由和页面渲染
php-compat/          PHP 模板解释器
themes/              内置主题模板
public/              主题与管理界面的静态资源
migrations/          D1 表结构迁移
scripts/             主题生成和本地演示数据
plugins/             受控打包的插件示例（仅开放有限 Hook）
docs/                面向站点使用者的 VitePress 文档
```

主题 PHP 源文件不会放在 `public/` 中。文档站可在本地运行：

```bash
npm run docs:dev
```

## 许可证

本项目采用 [GNU GPL v2](LICENSE.txt)。Typecho 相关内容遵循上游项目的授权与版权声明。

## 致谢

感谢 [Typecho](https://typecho.org/) 团队与社区打下的基础，感谢 [Hono](https://hono.dev/)、[Cloudflare Workers](https://workers.cloudflare.com/) 及其 D1、R2 服务，以及 [php-parser](https://github.com/glayzzle/php-parser) 项目提供的工具。