# Typecho Work / typecho-ts

把 [Typecho](https://typecho.org) 从 PHP 移植到 **Hono + Cloudflare Workers**：数据放 **D1**，文件放 **R2**，
站点 URL 与页面输出保持与 PHP 版一致，主题与插件按**原 PHP 源码**运行。

> 上游 PHP 代码已从工作树移除（历史仍保留在 git 中）。当前仓库只包含 TypeScript Worker 实现。

## 当前进度

| 模块 | 状态 |
| --- | --- |
| Hono 入口、D1 schema、路由表（含分页路由）、options 派生 URL | ✅ |
| PHP 子集解释器（`php-parser` + tree-walking evaluator） | ✅ 常用语法 |
| 前台主题渲染：`default` / `classic-22` 的首页、文章页、页面、分类、搜索、404 | ✅ |
| Archive / Comments / Contents / Metas / Users 等主题 API | ✅ 主要方法 |
| 后台 25 个页面与 `/action/*`（登录、发文、设置、附件、插件管理） | 🚧 待实现 |
| 插件 hook 运行时、R2 主题/插件文件存储、在线编辑 | 🚧 待实现 |
| Feed、XML-RPC、评论提交、上传、安装向导、备份 | 🚧 待实现 |
| 与 PHP 版逐字节对比的基线测试 | 🚧 待实现 |

当前版本只能通过 `scripts/seed-local.sql` 之类的数据完成**只读站点**演示，
后台与安装向导尚未实现，请勿用于生产环境。

## 为什么不是 node-php

Workers 里没有 Node 运行时、没有子进程、没有磁盘，并且**禁止** `eval` / `new Function` /
`WebAssembly.compile` / `instantiate(buffer)`。因此：

- `node-php`、`php-wasm` 的 Node 绑定跑不了；
- "PHP 编译成 JS 再执行" 也跑不了（需要 `eval`）；
- 静态内置 PHP-WASM 可行但体积 8–12 MB、冷启动接近 1s 上限，PHP 侧还拿不到网络/GD。

本项目改为：**用 `php-parser` 解析出 AST，自己遍历执行**。不生成代码，所以：

- 解释器可以直接执行内置包或 R2 中的 PHP 源文件，**后台上传或编辑主题、插件后即时生效**；
- 无需重新部署，也不需要 PHP 运行时。

## 架构

```
浏览器
  ├─ /admin/css|js|img, /usr/themes/*/**.css|js|img  → Static Assets（不经过 Worker）
  ├─ /usr/uploads/*                                  → R2 + Cache-Control: immutable
  └─ 其余全部                                        → Worker (Hono)
        ├─ options 加载与派生 URL（siteUrl/themeUrl/feedUrl…）
        ├─ routingTable 编译与匹配（永久链接可改）
        ├─ Archive → 选主题模板 → PHP 解释器渲染 → HTML
        └─ （待实现）/action/*、/admin/*、/install、Feed
```

一次请求内：加载 `typecho_options`（1 次查询）→ 匹配路由 → 按需查询
`contents/comments/metas/fields/users` → 执行主题模板 → 返回 HTML。

## 目录结构

```
src/
  index.ts              Hono 入口
  app.ts                请求编排、widget 注册、错误页
  core/                 db(D1) / options / router / request / common / theme / markdown
  repo/content.ts       contents、comments、metas、users、fields 查询
  widgets/              Archive、Comments、Rows（主题可见的 PHP 宿主对象）
  generated/themes.ts   构建期生成：主题 PHP 源码打包为字符串
php-compat/
  parse.ts              php-parser 封装 + AST 缓存
  interpreter.ts        语句/表达式求值（全异步）、类、命名空间、include
  runtime.ts            Runtime / Scope / ClassDef
  values.ts             PhpArray、类型转换、松散比较
  builtins.ts           约 150 个内置函数
  host.ts               PHP ↔ TypeScript 宿主对象桥
  date.ts / md5.ts      日期与哈希
themes/                 主题 PHP 模板（default、classic-22）
plugins/                插件 PHP（HelloWorld 示例）
public/                 静态资源（admin css/js/img、主题 css/img、robots.txt）
migrations/             D1 schema
scripts/                gen-themes.mjs（打包主题）、seed-local.sql（本地演示数据）
tests/                  解释器 / 路由 / 主题渲染测试
```

主题与插件的 **PHP 源文件不在 `public/` 中**，不会被公开下载。

## 快速开始

```bash
npm install
npm run gen                       # 把 themes/ 下的模板打包进 Worker
npm run db:migrate:local          # 创建本地 D1 表
npm run db:seed:local             # 可选：写入演示站点（1 篇文章、1 个页面、1 条评论）
npm run dev                       # http://127.0.0.1:8787
```

其他命令：

```bash
npm test          # 解释器、路由、真实主题渲染
npm run typecheck
npm run deploy    # 需要先在 wrangler.toml 填真实 database_id
```

## 部署

1. 建库与桶：

```bash
npx wrangler d1 create typecho
npx wrangler r2 bucket create typecho-files
```

2. 把 `wrangler.toml` 里的 `database_id` 换成上一步返回的 ID。

3. 初始化远程表结构并部署：

```bash
npm run db:migrate:remote
npm run deploy
```

4. 绑定自定义域名后访问站点根路径；`siteUrl` 选项需与域名一致，否则永久链接会指向旧地址。

### 上传目录

`/usr/uploads/YYYY/MM/<file>` 由 Worker 从 R2 的 `uploads/YYYY/MM/<file>` 读取。
数据库里依旧保存 `/usr/uploads/...` 形式的相对路径，主题无需修改。

## 主题与插件

- 内置主题放在 `themes/<name>/*.php`，执行 `npm run gen` 生成打包内容。
- 主题静态资源放在 `public/usr/themes/<name>/`，按原 URL 提供。
- 模板里可用：`$this->options`、`$this->need()`、`$this->next()` / `have()` / `is()`、`content()`、
  `excerpt()`、`permalink()`、`date()`、`category()`、`tags()`、`commentsNum()`、`comments()`、`pageNav()`、
  `thePrev()` / `theNext()`、`archiveTitle()`、`header()` / `footer()`、`remember()`、`fields`，以及
  `\Widget\Contents\Page\Rows`、`\Widget\Contents\Post\Recent`、`\Widget\Comments\Recent`、
  `\Widget\Metas\Category\Rows` 的 `alloc()`。
- 插件宿主（`Typecho\Plugin`、`Typecho\Db`、`Helper\Form` 等）与 hook 注册表尚未接入。

## PHP 兼容层

已支持：`<?php ?>` / `<?=`、字符串插值与 heredoc、全部运算符与优先级、`if/elseif/else`（含 `endif` 语法）、
`while/do/for/foreach`（含 `endwhile`）、`switch`、函数、闭包与箭头函数、类/接口/trait、`static` 成员与常量、
`namespace/use`、`try/catch/finally`、`include/require`、`list()` 解构、`match`、`??` / `?->`。

不支持（会抛出可读错误）：

| 能力 | 原因 |
| --- | --- |
| `eval`、可变变量、`extract`、`goto`、生成器 | 解释器不实现，Workers 也不允许动态代码 |
| 引用返回、全局引用 | 仅支持局部 `&` 赋值 |
| GD / Imagick、curl、intl、iconv、`exec`、`proc_open` | Workers 无原生扩展、无子进程 |
| `$_SESSION` | 无 PHP 会话；登录态走 Cookie |
| 真实文件系统 API | 上传在 R2，模板/插件文件走 FileStore 抽象 |

## 数据层约定（D1）

- 表名、列名、类型与 Typecho `install/SQLite.sql` 一致，默认前缀 `typecho_`（`DB_PREFIX` 可改）。
- 单查询最多 **100 个绑定参数**：`relationships` / `fields` 批量写入需分片。
- `LIKE` 模式最长 **50 字节**：站内搜索使用 `instr(lower(col), lower(?))`。
- 没有交互式事务：多条写入统一走 `db.batch()`（原子）；失败按退避重试 `SQLITE_BUSY`。
- 计数（`commentsNum`、`metas.count`）与主记录在同一次 batch 内更新。

## 测试

```bash
npm test
```

- `tests/php-interpreter.spec.ts`：语法覆盖、宿主对象桥、异常与退出。
- `tests/router.spec.ts`：路由表编译/匹配/反解、`Common::url`、截断与 HTML 修复。
- `tests/theme-default.spec.ts`：用真实 `themes/default` 模板渲染首页与文章页，断言关键 HTML。

## 路线图

1. M4：后台 25 个页面 + `/action/*`（登录、发文、评论审核、设置、用户、附件）。
2. M5：插件 hook 运行时、`Typecho\Db`/`Form` shim、R2 FileStore、在线编辑主题。
3. M6：Feed、评论提交、上传、`/install` 安装向导、XML-RPC、备份。
4. M7：与 PHP 版的 HTML 基线对比、HyperDown 输出对齐、主题兼容矩阵。

## 许可证

GPL-2.0，与上游 Typecho 一致。原始 PHP 实现版权归 Typecho Team。
