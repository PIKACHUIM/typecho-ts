-- Local development seed: a minimal installed Typecho site.
-- Demo login: admin / typecho-local. Never use this seed on a public site.
-- siteUrl is intentionally not seeded: the app falls back to the request root,
-- so the demo works on any local port. Set it in production.
--   npx wrangler d1 execute typecho --local --file=scripts/seed-local.sql
DELETE FROM typecho_options;
DELETE FROM typecho_contents;
DELETE FROM typecho_comments;
DELETE FROM typecho_metas;
DELETE FROM typecho_relationships;
DELETE FROM typecho_fields;
DELETE FROM typecho_users;

INSERT INTO typecho_users (uid, name, password, mail, screenName, created, activated, logged, "group", authCode)
VALUES (1, 'admin', '$2b$10$qBOt7yIGcz0XpZYoDygc8.E718fFa5QhcUnbuaEqbVCRr56ZrMwK6', 'admin@example.com', 'Admin', 1700000000, 1700000000, 1700000000, 'administrator', '');

INSERT INTO typecho_contents (cid, title, slug, created, modified, text, "order", authorId, template, type, status, password, commentsNum, allowComment, allowPing, allowFeed, parent)
VALUES
 (1, 'Hello World', 'hello-world', 1700000000, 1700000000, '<!--markdown-->This is **Typecho** running on Cloudflare Workers.', 0, 1, NULL, 'post', 'publish', NULL, 1, '1', '1', '1', 0),
 (2, 'About', 'about', 1700000100, 1700000100, '<!--markdown-->About page.', 0, 1, NULL, 'page', 'publish', NULL, 0, '1', '1', '1', 0);

INSERT INTO typecho_metas (mid, name, slug, type, description, count, "order", parent)
VALUES (1, 'Default', 'default', 'category', NULL, 1, 1, 0);

INSERT INTO typecho_relationships (cid, mid) VALUES (1, 1);

INSERT INTO typecho_comments (coid, cid, created, author, authorId, ownerId, mail, url, ip, agent, text, type, status, parent)
VALUES (1, 1, 1700000500, 'Alice', 0, 0, 'alice@example.com', NULL, '127.0.0.1', 'seed', 'Nice post!', 'comment', 'approved', 0);

INSERT INTO typecho_options (name, "user", value) VALUES
 ('installed', 0, '1'),
 ('theme', 0, 'default'),
 ('title', 0, 'Typecho Work'),
 ('description', 0, 'Typecho on Cloudflare Workers'),
 ('rewrite', 0, '1'),
 ('pageSize', 0, '5'),
 ('postsListSize', 0, '5'),
 ('commentsListSize', 0, '5'),
 ('commentsShowCommentOnly', 0, '1'),
 ('commentsThreaded', 0, '1'),
 ('timezone', 0, '0'),
 ('charset', 0, 'UTF-8'),
 ('contentType', 0, 'text/html'),
 ('version', 0, '1.3.1'),
 ('generator', 0, 'Typecho 1.3.1'),
 ('allowXmlRpc', 0, '0'),
 ('frontPage', 0, 'recent'),
 ('postDateFormat', 0, 'F j, Y'),
 ('commentDateFormat', 0, 'F jS, Y \a\t h:ia'),
 ('secret', 0, 'local-dev-secret'),
 ('plugins', 0, '{"activated":{},"handles":{}}'),
 ('actionTable', 0, '{}'),
 ('panelTable', 0, '{}'),
 ('routingTable', 0, '{"index":{"url":"/","widget":"\\\\Widget\\\\Archive","action":"render"},"archive":{"url":"/blog/","widget":"\\\\Widget\\\\Archive","action":"render"},"do":{"url":"/action/[action:alpha]","widget":"\\\\Widget\\\\Action","action":"action"},"post":{"url":"/archives/[cid:digital]/","widget":"\\\\Widget\\\\Archive","action":"render"},"attachment":{"url":"/attachment/[cid:digital]/","widget":"\\\\Widget\\\\Archive","action":"render"},"category":{"url":"/category/[slug]/","widget":"\\\\Widget\\\\Archive","action":"render"},"tag":{"url":"/tag/[slug]/","widget":"\\\\Widget\\\\Archive","action":"render"},"author":{"url":"/author/[uid:digital]/","widget":"\\\\Widget\\\\Archive","action":"render"},"search":{"url":"/search/[keywords]/","widget":"\\\\Widget\\\\Archive","action":"render"},"index_page":{"url":"/page/[page:digital]/","widget":"\\\\Widget\\\\Archive","action":"render"},"category_page":{"url":"/category/[slug]/[page:digital]/","widget":"\\\\Widget\\\\Archive","action":"render"},"tag_page":{"url":"/tag/[slug]/[page:digital]/","widget":"\\\\Widget\\\\Archive","action":"render"},"author_page":{"url":"/author/[uid:digital]/[page:digital]/","widget":"\\\\Widget\\\\Archive","action":"render"},"search_page":{"url":"/search/[keywords]/[page:digital]/","widget":"\\\\Widget\\\\Archive","action":"render"},"feed":{"url":"/feed[feed:string:0]","widget":"\\\\Widget\\\\Feed","action":"render"},"page":{"url":"/[slug].html","widget":"\\\\Widget\\\\Archive","action":"render"}}'),
 ('theme:default', 0, '{"sidebarBlock":["ShowRecentPosts","ShowRecentComments","ShowCategory","ShowOther"]}');
