import { describe, expect, it } from 'vitest';
import { encodePhpSerialized, parsePhpSerialized } from '../php-compat/serialize';
import { createRuntime } from '../php-compat';
import { PhpArray } from '../php-compat/values';
import { Db } from '../src/core/db';
import { loadOptionValues, SiteOptions } from '../src/core/options';
import { buildRequestContext } from '../src/core/request';

const serializedRoutes = String.raw`a:1:{s:5:"index";a:3:{s:3:"url";s:1:"/";s:6:"widget";s:15:"\Widget\Archive";s:6:"action";s:6:"render";}}`;

describe('bounded PHP serialized option compatibility', () => {
  it('reads UTF-8 byte lengths, nested associative arrays, indexed arrays and scalars', () => {
    expect(parsePhpSerialized('s:6:"分类";')).toBe('分类');
    expect(parsePhpSerialized('a:3:{i:0;s:6:"分类";i:1;b:0;i:2;N;}')).toEqual(['分类', false, null]);
    expect(parsePhpSerialized('i:-12;')).toBe(-12);
    expect(parsePhpSerialized('d:1.25;')).toBe(1.25);
    const routes = parsePhpSerialized(serializedRoutes) as Record<string, Record<string, unknown>>;
    expect(routes.index).toEqual({ url: '/', widget: '\\Widget\\Archive', action: 'render' });
  });

  it('encodes PHP arrays using byte lengths and preserves integer keys', () => {
    const array = new PhpArray([[0, '分类'], ['name', 'Typecho']]);
    const encoded = encodePhpSerialized(array);
    expect(encoded).toBe('a:2:{i:0;s:6:"分类";s:4:"name";s:7:"Typecho";}');
    expect(parsePhpSerialized(encoded)).toEqual({ 0: '分类', name: 'Typecho' });
  });

  it('exposes safe serialize/unserialize builtins to PHP templates', () => {
    const runtime = createRuntime();
    const serialize = runtime.functions.get('serialize');
    const unserialize = runtime.functions.get('unserialize');
    expect(serialize?.kind).toBe('host');
    expect(unserialize?.kind).toBe('host');
    if (serialize?.kind !== 'host' || unserialize?.kind !== 'host') throw new Error('Missing PHP serialization builtins');
    const encoded = serialize.fn(new PhpArray([[0, '分类'], [1, false]]));
    expect(encoded).toBe('a:2:{i:0;s:6:"分类";i:1;b:0;}');
    expect(unserialize.fn(encoded)).toBeInstanceOf(PhpArray);
    expect((unserialize.fn(encoded) as PhpArray).values()).toEqual(['分类', false]);
    expect(unserialize.fn('O:1:"X":0:{}')).toBe(false);
  });

  it('rejects wrong byte lengths, unsupported objects, unsafe keys and trailing data', () => {
    expect(() => parsePhpSerialized('s:2:"分类";')).toThrow();
    expect(() => parsePhpSerialized('O:1:"X":0:{}')).toThrow();
    expect(() => parsePhpSerialized('a:1:{s:9:"__proto__";b:1;}')).toThrow();
    expect(() => parsePhpSerialized('b:0;garbage')).toThrow();
    expect(() => parsePhpSerialized('a:10001:{}')).toThrow();
  });

  it('loads legacy routing and theme options into the existing D1 option layer', async () => {
    const rows = [
      { name: 'theme', value: 'default' },
      { name: 'routingTable', value: serializedRoutes },
      { name: 'plugins', value: 'a:0:{}' },
      { name: 'theme:default', value: String.raw`a:2:{s:12:"sidebarBlock";a:1:{i:0;s:15:"ShowRecentPosts";}s:14:"phpPluginHooks";a:1:{i:0;s:10:"HelloWorld";}}` },
    ];
    const db = { all: async () => rows } as unknown as Db;
    const values = await loadOptionValues(db);
    expect(values.sidebarBlock).toEqual(['ShowRecentPosts']);
    expect(values.plugins).toEqual([]);
    expect(values.phpPluginHooks).toBeNull();
    const request = buildRequestContext(new Request('https://example.test/'));
    const site = new SiteOptions({ values, request, echo: () => undefined });
    expect(site.router.match('/')?.route.name).toBe('index');
  });
});
