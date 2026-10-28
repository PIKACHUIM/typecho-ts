Contributing
=======================

本仓库是 Typecho 的 Hono + Cloudflare Workers 移植版。上游 PHP 实现已从工作树移除，
但仍保留在 git 历史中，可作为行为基准。

## 报告问题

请在本仓库提交 issue，并附上：

- 复现步骤与期望输出
- `npm run typecheck` / `npm test` 的结果
- 若与 PHP 版行为不一致，附上 PHP 版本的输出片段

## 提交代码

- 一次提交只做一件事，提交信息说明"为什么"而不只是"改了什么"。
- 改动涉及主题渲染或路由时，请同时补测试（`tests/`）。
- 不要引入 `eval` / `new Function` / 动态 `WebAssembly.compile`：Workers 运行时会直接拒绝。
- 新增 PHP 语法支持时，请在 `php-compat/` 内实现并在 `tests/php-interpreter.spec.ts` 补用例。

## 本地检查

```bash
npm install
npm run gen        # 生成 src/generated/themes.ts
npm run typecheck
npm test
npx wrangler deploy --dry-run --outdir=.wrangler/dist
```

CI 会执行同样的四步（见 `.github/workflows/ci.yml`）。

## 本地调试站点

```bash
npm run db:migrate:local
npm run db:seed:local
npm run dev
```

`scripts/seed-local.sql` 只用于本地演示，会先清空相关表。

## 主题开发

目录：`themes/<name>/*.php`；静态资源：`public/usr/themes/<name>/`。
模板可用的 `$this` API 见 README 的「主题与插件」一节。

## 许可

贡献的代码以 GPL-2.0 授权，与上游 Typecho 一致。
