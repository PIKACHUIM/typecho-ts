# 部署到 Cloudflare

部署流程会创建 Worker、D1、R2 并应用表结构。空数据库首次访问会显示初始化向导，可设置站点信息并创建管理员账户；登录入口为 `/admin/login.php`。后台已提供基础文章、页面、分类标签、评论审核、用户、站点设置、主题/后台外观切换、媒体附件和 R2 附件 URL 设置，并使用统一后台导航布局。内置插件 Hook 仅支持示例后台菜单；任意第三方插件、完整主题兼容、其余后台页面、XML-RPC 及数据导入尚未实现，**不建议承载正式站点或重要数据**。

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

主题和插件 PHP 源码在 Worker 构建时打包，**不是后台 ZIP 在线安装**。添加代码后运行 `npm run gen`、测试并重新部署，主题才会出现在 `/admin/themes.php`；普通附件仍在 `/admin/manage-medias.php` 上传。

## 部署后会看到什么

表结构已经创建，但没有站点数据。首次访问空数据库会进入初始化向导，完成后可在 `/admin/login.php` 登录。主题与后台外观可在 `/admin/themes.php` 分别切换；其他 Typecho 功能仍未完全实现，初始化成功不等于已具备完整的 Typecho 功能。

本地演示脚本 `scripts/seed-local.sql` 会先删除相关表中的数据，只能在本地使用。不要将它改成远程执行，也不要把演示账号或演示密钥当作生产凭据。
