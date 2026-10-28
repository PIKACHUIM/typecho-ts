import { defineConfig } from 'vitepress';

// GitHub Pages 项目站点需要子路径前缀，本地开发与根域名部署保持 '/'。
const base = globalThis.process?.env?.DOCS_BASE || '/';

export default defineConfig({
  base,
  lang: 'zh-CN',
  title: 'Typecho on Workers',
  description: '在 Cloudflare Workers 上运行的 Typecho 移植项目使用指南',
  cleanUrls: true,
  vite: {
    resolve: { preserveSymlinks: true },
  },
  themeConfig: {
    nav: [
      { text: '首页', link: '/' },
      { text: '快速预览', link: '/guide/quick-start' },
      { text: '部署指南', link: '/guide/deploy' },
      { text: 'GitHub', link: 'https://github.com/PIKACHUIM/typecho-ts' },
    ],
    sidebar: [
      {
        text: '开始使用',
        items: [
          { text: '项目简介', link: '/' },
          { text: '本地快速预览', link: '/guide/quick-start' },
          { text: '部署到 Cloudflare', link: '/guide/deploy' },
        ],
      },
    ],
    socialLinks: [{ icon: 'github', link: 'https://github.com/PIKACHUIM/typecho-ts' }],
    footer: {
      message: '以 GNU GPL v2 授权发布',
      copyright: '基于 Typecho 开源项目构建',
    },
  },
});
