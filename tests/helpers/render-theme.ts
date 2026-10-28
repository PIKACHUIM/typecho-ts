import { createRuntime } from '../../php-compat';
import { Interpreter } from '../../php-compat/interpreter';
import { toStr } from '../../php-compat/values';
import type { ClassDef, PhpValue } from '../../php-compat/runtime';
import { buildRequestContext } from '../../src/core/request';
import { SiteOptions, type OptionValues } from '../../src/core/options';
import { BundledThemeStore, makeIncludeResolver, normalize } from '../../src/core/theme';

export interface RenderThemeOptions {
  values: OptionValues;
  createSelf: (options: SiteOptions, echo: (value: unknown) => void) => PhpValue;
  createClasses?: (options: SiteOptions, echo: (value: unknown) => void) => ClassDef[];
  url?: string;
  theme?: string;
}

export async function renderTheme(entry: string, options: RenderThemeOptions): Promise<string> {
  const theme = options.theme ?? 'default';
  const request = buildRequestContext(new Request(options.url ?? 'http://example.com/'));
  const out: string[] = [];
  const echo = (value: unknown) => out.push(toStr(value));
  const siteOptions = new SiteOptions({ values: options.values, request, echo });
  const store = new BundledThemeStore();
  const runtime = createRuntime({
    readFile: makeIncludeResolver(store, theme),
    echo,
    timezoneOffset: Number(siteOptions.get('timezone') ?? 0),
  });
  for (const cls of options.createClasses?.(siteOptions, echo) ?? []) runtime.addClass(cls);

  const self = options.createSelf(siteOptions, echo);
  const interpreter = new Interpreter(runtime, {
    out,
    echo,
    runtime,
    file: `${theme}/${entry}`,
    self,
  });

  const selfWithInclude = self as { renderInclude?: (file: string) => Promise<void> };
  selfWithInclude.renderInclude = async (file: string) => {
    const target = normalize(file);
    const source = await store.read(theme, target);
    if (source === null) throw new Error(`Template "${target}" not found`);
    await interpreter.run(source, `${theme}/${target}`);
  };

  const guarded = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'TerminateSignal') throw error;
    }
  };

  const functions = await store.read(theme, 'functions.php');
  if (functions) await guarded(() => interpreter.run(functions, `${theme}/functions.php`));

  const source = await store.read(theme, normalize(entry));
  if (source === null) throw new Error(`Template "${entry}" not found`);
  await guarded(() => interpreter.run(source, `${theme}/${normalize(entry)}`));

  return out.join('');
}

export const DEFAULT_ROUTING_TABLE = {
  index: { url: '/', widget: '\\Widget\\Archive', action: 'render' },
  archive: { url: '/blog/', widget: '\\Widget\\Archive', action: 'render' },
  do: { url: '/action/[action:alpha]', widget: '\\Widget\\Action', action: 'action' },
  post: { url: '/archives/[cid:digital]/', widget: '\\Widget\\Archive', action: 'render' },
  attachment: { url: '/attachment/[cid:digital]/', widget: '\\Widget\\Archive', action: 'render' },
  category: { url: '/category/[slug]/', widget: '\\Widget\\Archive', action: 'render' },
  tag: { url: '/tag/[slug]/', widget: '\\Widget\\Archive', action: 'render' },
  author: { url: '/author/[uid:digital]/', widget: '\\Widget\\Archive', action: 'render' },
  search: { url: '/search/[keywords]/', widget: '\\Widget\\Archive', action: 'render' },
  index_page: { url: '/page/[page:digital]/', widget: '\\Widget\\Archive', action: 'render' },
  category_page: { url: '/category/[slug]/[page:digital]/', widget: '\\Widget\\Archive', action: 'render' },
  tag_page: { url: '/tag/[slug]/[page:digital]/', widget: '\\Widget\\Archive', action: 'render' },
  search_page: { url: '/search/[keywords]/[page:digital]/', widget: '\\Widget\\Archive', action: 'render' },
  feed: { url: '/feed[feed:string:0]', widget: '\\Widget\\Feed', action: 'render' },
  page: { url: '/[slug].html', widget: '\\Widget\\Archive', action: 'render' },
  comment_page: { url: '/archives/[cid:digital]/comment-page-[commentPage:digital]/', widget: '\\Widget\\Archive', action: 'render' },
};

export function siteValues(overrides: OptionValues = {}): OptionValues {
  return {
    installed: '1',
    theme: 'default',
    title: 'Test Site',
    description: 'Just a test',
    siteUrl: 'http://example.com',
    rewrite: '1',
    pageSize: '10',
    postsListSize: '5',
    commentsListSize: '5',
    commentsShowCommentOnly: '1',
    commentsThreaded: '1',
    timezone: '0',
    postDateFormat: 'F j, Y',
    commentDateFormat: 'F jS, Y \\a\\t h:ia',
    charset: 'UTF-8',
    contentType: 'text/html',
    version: '1.3.1',
    generator: 'Typecho 1.3.1',
    allowXmlRpc: '0',
    routingTable: DEFAULT_ROUTING_TABLE,
    sidebarBlock: ['ShowRecentPosts', 'ShowRecentComments', 'ShowCategory', 'ShowOther'],
    ...overrides,
  };
}
