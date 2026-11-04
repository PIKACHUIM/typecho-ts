# 部署到 Cloudflare

部署流程会创建 Worker、D1、R2 并应用表结构。空数据库首次访问 `/install.php` 会显示可选中文或英文的初始化向导；完成后可在 `/admin/login.php` 登录。后台已提供文章/页面编辑（Markdown 分屏编辑器）、分类标签、评论审核、用户、站点设置、三种外观/暗色模式/中英文、媒体附件及 ZIP 主题和插件管理。运行时安装支持受限 PHP 解释器可执行的主题文件，以及只实现 `admin/menu.php` 菜单 Hook 的插件，不代表兼容任意 Typecho 主题或插件；安装代码包是对管理员信任的 PHP 代码执行操作。其余 Typecho 后台页面、XML-RPC 及数据导入尚未实现，**不建议承载正式站点或重要数据**。

## 一键部署

点击按钮后，Cloudflare 会读取项目的 `wrangler.toml`，准备 D1 和 R2 绑定，并按仓库中的 `deploy` 脚本构建与发布：

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/PIKACHUIM/typecho-ts)

按钮会部署应用与数据表结构。首次访问 Worker 地址后，在初始化向导里创建站点管理员；部署按钮不会导入已有文章。要了解 Cloudflare 部署按钮的行为，可参阅 [Cloudflare 官方说明](https://developers.cloudflare.com/workers/tutorials/deploy-button/)。

## 使用 Wrangler 手动部署

需要 Node.js 20 或更新版本、Cloudflare 账号和 Wrangler 登录权限。

### 1. 安装并登录

```bash
git clone https://github.com/PIKACHUIM/typecho-ts.git
cd typecho-ts
npm install
npx wrangler login
```

### 2. 创建 Cloudflare 资源

```bash
npx wrangler d1 create typecho
npx wrangler r2 bucket create typecho-files
```

将 D1 创建结果里的 ID 填入 `wrangler.toml` 的 `database_id`。数据库名和 bucket 名需分别保持为 `typecho` 与 `typecho-files`，以匹配当前配置。

### 3. 构建并发布

```bash
npm run deploy
```

该命令会生成内置主题模板、将尚未应用的 D1 迁移写入远程数据库，然后部署 Worker。之后可在 Cloudflare 控制台给 Worker 绑定域名。

R2 通过 Worker 的 `BUCKET` 绑定连接，默认 bucket 名为 `typecho-files`。本地配置见 `wrangler.toml`；线上在 Worker 的 Settings → Bindings 中添加同名变量绑定到 R2 Bucket。管理员可在 `/admin/options-media.php` 留空使用 Worker 代理，或设置已指向该 Bucket 的 HTTPS 自定义域名/URL 前缀。保存 URL 前缀不会创建 R2 公共域名，也不会验证外部域名映射。

主题/插件 ZIP 在 `/admin/packages.php` 由管理员上传后存入 R2 的版本化前缀，并立即加入 D1 扩展目录，无需重部署 Worker。每包压缩文件上限 1 MB、解压后 8 MB、100 个文件，单个 PHP 文件最多 1 MB；拒绝路径穿越、链接、加密压缩包和不支持的文件类型。主题 ZIP 的根目录必须含 `index.php`，其余 PHP include 与主题资源目录按原有相对结构打包；插件 ZIP 当前只允许根目录单文件 `Plugin.php`，命名空间须为 `TypechoPlugin\\<标识符>`，并只支持 `admin/menu.php` 的后台导航 Hook。安装后可在后台切换主题、启停或卸载扩展；卸载会删除该扩展对应的 R2 版本前缀。**只安装可信来源的 PHP 包**；受限解释器并不意味着任意第三方代码兼容。普通图片附件仍在 `/admin/manage-medias.php` 上传。

## 部署后会看到什么

表结构已经创建，但没有站点数据。首次访问空数据库会进入初始化向导，完成后可在 `/admin/login.php` 登录。主题与后台外观可在 `/admin/themes.php` 分别切换；其他 Typecho 功能仍未完全实现，初始化成功不等于已具备完整的 Typecho 功能。

本地演示脚本 `scripts/seed-local.sql` 会先删除相关表中的数据，只能在本地使用。不要将它改成远程执行，也不要把演示账号或演示密钥当作生产凭据。
