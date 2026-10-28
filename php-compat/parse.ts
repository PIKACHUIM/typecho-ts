import PhpParser from 'php-parser';
import { PhpError } from './errors';

export interface AstNode {
  kind: string;
  loc?: { start: { line: number; column: number }; end: { line: number; column: number } };
  [key: string]: any;
}

const engine = new (PhpParser as any)({
  parser: { extractDoc: true, php7: true, suppressErrors: false },
  ast: { withPositions: true },
  lexer: { all_tokens: false, comment_tokens: false, mode: 'short_tags' },
});

const cache = new Map<string, AstNode>();
const CACHE_LIMIT = 256;

/** Parses PHP source into an AST. Results are cached per isolate. */
export function parsePhp(code: string, filename = 'template.php'): AstNode {
  const cached = cache.get(code);
  if (cached) return cached;

  let ast: AstNode;
  try {
    ast = engine.parseCode(code, filename) as AstNode;
  } catch (e) {
    throw new PhpError(`Parse error: ${(e as Error).message}`, 'fatal', filename);
  }

  if (ast.errors && ast.errors.length > 0) {
    const first = ast.errors[0];
    throw new PhpError(`Parse error: ${first.message}`, 'fatal', filename, first.line);
  }

  if (cache.size >= CACHE_LIMIT) {
    const oldest = cache.keys().next().value;
    if (oldest !== undefined) cache.delete(oldest);
  }
  cache.set(code, ast);
  return ast;
}

export function clearParseCache(): void {
  cache.clear();
}
