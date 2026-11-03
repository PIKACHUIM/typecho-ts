# 本地快速预览

几分钟即可用本地演示数据看一下首页。此流程不会连接你的 Cloudflare 账号。

## 准备环境

安装 Node.js 20 或更新版本；如果还要运行 `npm test`，请使用 Node.js 24（测试使用内置的 `node:sqlite`）。然后克隆仓库：

```bash
git clone https://github.com/PIKACHUIM/typecho-ts.git
cd typecho-ts
npm install
```

## 创建演示站点

依次运行：

```bash
npm run db:migrate:local
npm run db:seed:local
npm run dev
```

浏览器打开 `http://localhost:8787/`。演示数据库包含一篇文章、一个页面和一条评论；站点 URL 会跟随本地请求地址。

## 重要说明

`npm run db:seed:local` 会清空并重建本地演示表里的数据。它只适合本地 D1，**不要对远程或已有数据的数据库执行**。

演示数据包含本地登录账号：用户名 `admin`，密码 `typecho-local`。打开 `/admin/login.php` 登录后，可在 `/admin/manage-posts.php` 和 `/admin/manage-pages.php` 管理内容，在 `/admin/options-general.php` 修改站点信息，在 `/admin/themes.php` 切换前台主题、三种后台配色、深色模式和简体中文/English，在 `/admin/options-reading.php`、`/admin/options-discussion.php` 调整阅读和评论规则，在 `/admin/manage-comments.php` 审核评论，在 `/admin/manage-users.php` 管理用户，在 `/admin/manage-medias.php` 上传图片。`/admin/options-media.php` 用于查看 R2 绑定状态并设置附件公开 URL 前缀；Bucket 本身仍在 Cloudflare/Wrangler 配置。图片附件目前仅接受 JPG、PNG、GIF、WebP，单张上限 5 MB。`/admin/plugins.php` 可启用内置 `HelloWorld` 示例；插件 Hook 受限，不代表任意第三方插件兼容。

Workers 不能像传统 PHP 主机那样在线上传 PHP 主题/插件并立即执行。自定义主题放在 `themes/<名称>/` 和 `public/usr/themes/<名称>/`，插件源码放在 `plugins/<名称>/` 并加入 `scripts/gen-themes.mjs` 的受控清单；运行 `npm run gen`、完成测试后重新部署，后台才会识别新的构建产物。当前插件仅支持受限的 PHP 子集与已接入 Hook。

想测试首次安装，可不运行 `npm run db:seed:local`：空白本地 D1 即使没有应用迁移也可以，Worker 会在首次请求时自动创建表结构并显示初始化向导，设置站点标题、地址、时区和管理员。删除 `.wrangler/` 目录后重新 `npm run dev` 也会回到这一步。首页 `/feed/` 提供 RSS，`/feed/atom/` 提供 Atom。现阶段请勿导入重要数据。

结束预览时，在运行 `npm run dev` 的终端按 `Ctrl+C` 即可。
