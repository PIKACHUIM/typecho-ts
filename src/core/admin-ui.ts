import { escapeHtml } from './common';
import type { RequestContext } from './request';

const navigation = [
  { label: '后台首页', href: '/admin/' },
  { label: '文章管理', href: '/admin/manage-posts.php' },
  { label: '页面管理', href: '/admin/manage-pages.php' },
  { label: '分类管理', href: '/admin/manage-categories.php' },
  { label: '标签管理', href: '/admin/manage-tags.php' },
  { label: '评论管理', href: '/admin/manage-comments.php' },
  { label: '用户管理', href: '/admin/manage-users.php' },
  { label: '媒体管理', href: '/admin/manage-medias.php' },
  { label: '基本设置', href: '/admin/options-general.php' },
  { label: '阅读设置', href: '/admin/options-reading.php' },
  { label: '评论设置', href: '/admin/options-discussion.php' },
  { label: '主题管理', href: '/admin/themes.php' },
  { label: '插件管理', href: '/admin/plugins.php' },
  { label: '附件设置', href: '/admin/options-media.php' },
] as const;

export function renderAdminShell(title: string, request: RequestContext, body: string): string {
  const root = escapeHtml(request.rootUrl);
  const currentPath = request.pathInfo.replace(/\/+$/, '') || '/';
  const links = navigation.map(({ label, href }) => {
    const path = href.replace(/\/+$/, '') || '/';
    const current = currentPath === path || (path === '/admin' && currentPath === '/admin');
    return `<a href="${root}${href}"${current ? ' aria-current="page"' : ''}>${label}</a>`;
  }).join('');

  return `<!doctype html><html lang="zh-CN" data-admin-theme="official" data-admin-mode="light"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(title)} · Typecho</title><link rel="stylesheet" href="${root}/admin/css/style.css"><link rel="stylesheet" href="${root}/admin/css/typecho-work.css"></head><body><header class="admin-topbar"><a class="admin-brand" href="${root}/admin/">Typecho</a><span class="admin-page-title">${escapeHtml(title)}</span><div class="admin-toolbar"><a class="admin-appearance-link" href="${root}/admin/themes.php">外观设置</a><a class="admin-site-link" href="${root}/">查看站点</a></div></header><div class="admin-layout"><aside class="admin-sidebar"><nav aria-label="后台导航">${links}</nav></aside><main class="admin-content">${body}</main></div></body></html>`;
}
