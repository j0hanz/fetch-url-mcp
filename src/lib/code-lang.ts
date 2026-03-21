class DetectionContext {
  private _lower?: string;
  private _lines?: readonly string[];
  private _trimmedStart?: string;

  constructor(readonly code: string) {}

  get lower(): string {
    return (this._lower ??= this.code.toLowerCase());
  }

  get lines(): readonly string[] {
    return (this._lines ??= this.code.split(/\r?\n/));
  }

  get trimmedStart(): string {
    return (this._trimmedStart ??= this.code.trimStart());
  }
}
const BASH_COMMANDS = new Set([
  'sudo',
  'chmod',
  'mkdir',
  'cd',
  'ls',
  'cat',
  'echo',
]);
const BASH_PACKAGE_MANAGERS = [
  'npm',
  'yarn',
  'pnpm',
  'npx',
  'brew',
  'apt',
  'pip',
  'cargo',
  'go',
] as const;
const TYPESCRIPT_HINTS = [
  ': string',
  ':string',
  ': number',
  ':number',
  ': boolean',
  ':boolean',
  ': void',
  ':void',
  ': any',
  ':any',
  ': unknown',
  ':unknown',
  ': never',
  ':never',
];
const HTML_TAGS = [
  '<!doctype',
  '<html',
  '<head',
  '<body',
  '<div',
  '<span',
  '<p',
  '<a',
  '<script',
  '<style',
];
const RUST_REGEX = /\b(?:fn|impl|struct|enum)\b/;
const JS_REGEX =
  /\b(?:const|let|var|function|class|async|await|export|import)\b/;
const PYTHON_UNIQUE_REGEX =
  /\b(?:def |elif |except |finally:|yield |lambda |raise |pass$)/m;
const JS_SIGNAL_REGEX =
  /\b(?:const |let |var |function |require\(|=>|===|!==|console\.)/;
const CSS_REGEX =
  /@media|@import|@keyframes|@theme\b|@utility\b|@layer\b|@apply\b|@variant\b|@custom-variant\b|@reference\b|@source\b/;
const CSS_PROPERTY_REGEX = /^\s*[a-z][\w-]*\s*:/;
const PYTHON_REPL_PROMPT_REGEX = /^\s*(?:>>>|\.\.\.)\s/m;
const PYTHON_OUTPUT_HINT_REGEX =
  /<(?:QuerySet|[A-Z][A-Za-z0-9_]*:\s)|\bdatetime\.datetime\(|\bDoesNotExist:/;
const WINDOWS_SHELL_PROMPT_REGEX = /^\s*\.\.\.\\?>\s+\S/m;
const JSX_TAG_REGEX =
  /<\/?[A-Z][A-Za-z0-9]*(?:\s+[A-Za-z_:][\w:.-]*(?:\s*=\s*(?:"[^"]*"|'[^']*'|\{[^}]*\}))?)*\s*\/?>/m;

function containsJsxTag(code: string): boolean {
  return JSX_TAG_REGEX.test(code);
}
function isBashLine(line: string): boolean {
  const trimmed = line.trimStart();
  if (!trimmed) return false;

  if (
    trimmed.startsWith('#!') ||
    trimmed.startsWith('$ ') ||
    WINDOWS_SHELL_PROMPT_REGEX.test(trimmed)
  ) {
    return true;
  }

  const spaceIdx = trimmed.indexOf(' ');
  const firstWord = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);

  if (BASH_COMMANDS.has(firstWord)) return true;

  return (
    spaceIdx !== -1 &&
    BASH_PACKAGE_MANAGERS.includes(
      firstWord as (typeof BASH_PACKAGE_MANAGERS)[number]
    )
  );
}
function detectBashIndicators(lines: readonly string[]): boolean {
  return lines.some(isBashLine);
}
function detectCssStructure(lines: readonly string[]): boolean {
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!trimmed || trimmed.startsWith('# ') || trimmed.startsWith('//')) {
      continue;
    }

    if (/^[.#][A-Za-z_-][\w-]*\s*\{/.test(trimmed)) return true;

    if (
      trimmed.includes(';') &&
      CSS_PROPERTY_REGEX.test(trimmed) &&
      !trimmed.includes('(')
    ) {
      return true;
    }
  }
  return false;
}
function detectYamlStructure(lines: readonly string[]): boolean {
  for (const line of lines) {
    const trimmed = line.trim();
    const colonIdx = trimmed.indexOf(':');
    if (colonIdx > 0) {
      const after = trimmed[colonIdx + 1];
      if (after === ' ' || after === '\t') return true;
    }
  }
  return false;
}
type Matcher = (ctx: DetectionContext) => boolean;
interface LanguageDef {
  lang: string;
  weight: number;
  match: Matcher;
}
function matchRust(ctx: DetectionContext): boolean {
  if (ctx.lower.includes('let mut')) return true;
  if (RUST_REGEX.test(ctx.lower)) return true;
  return ctx.lower.includes('use ') && ctx.lower.includes('::');
}
function matchGo(ctx: DetectionContext): boolean {
  if (ctx.lower.includes('import "')) return true;
  return /\b(?:package|func)\b/.test(ctx.lower);
}
function matchJsx(ctx: DetectionContext): boolean {
  const l = ctx.lower;
  if (
    l.includes('classname=') ||
    l.includes('jsx:') ||
    l.includes("from 'react'") ||
    l.includes('from "react"')
  ) {
    return true;
  }
  return containsJsxTag(ctx.code);
}
function matchTypeScript(ctx: DetectionContext): boolean {
  return (
    /\b(?:interface|type)\b/.test(ctx.lower) ||
    TYPESCRIPT_HINTS.some((hint) => ctx.lower.includes(hint))
  );
}
function matchSql(ctx: DetectionContext): boolean {
  return /\b(?:select\s+(?:.+?\s+from|[\d*@])|insert\s+into|update\s+.+?\s+set|delete\s+from|create\s+(?:table|database|index|view|function|procedure|trigger|user|role)|alter\s+(?:table|database|index|view))\b/.test(
    ctx.lower
  );
}
function hasJsSignals(lowerCode: string): boolean {
  return (
    JS_SIGNAL_REGEX.test(lowerCode) ||
    lowerCode.includes('{') ||
    lowerCode.includes("from '")
  );
}

function matchPython(ctx: DetectionContext): boolean {
  if (matchHtml(ctx)) return false;

  const l = ctx.lower;
  const c = ctx.code;

  if (
    PYTHON_REPL_PROMPT_REGEX.test(c) ||
    PYTHON_OUTPUT_HINT_REGEX.test(c) ||
    /^\s*[A-Za-z_][\w.]*\s*=\s*[A-Z][\w.]*\(/m.test(c) ||
    /^\s*[A-Za-z_][\w.]*\.[A-Za-z_][\w]*\s*$/m.test(c) ||
    c.includes('None') ||
    c.includes('True') ||
    c.includes('False') ||
    l.includes('print(') ||
    l.includes('__name__') ||
    l.includes('self.') ||
    l.includes('elif ') ||
    PYTHON_UNIQUE_REGEX.test(l)
  ) {
    return true;
  }

  // Shared keywords (import, from, class) — only match if no JS signals present
  return /\b(?:import|from|class)\b/.test(l) && !hasJsSignals(l);
}
function matchHtml(ctx: DetectionContext): boolean {
  return HTML_TAGS.some((tag) => ctx.lower.includes(tag));
}

// Pre-sorted by weight descending — first match wins in detectLanguageFromCode
const LANGUAGES: LanguageDef[] = [
  { lang: 'rust', weight: 25, match: matchRust },
  { lang: 'go', weight: 22, match: matchGo },
  { lang: 'jsx', weight: 22, match: matchJsx },
  { lang: 'typescript', weight: 20, match: matchTypeScript },
  { lang: 'sql', weight: 20, match: matchSql },
  { lang: 'html', weight: 19, match: matchHtml },
  { lang: 'python', weight: 18, match: matchPython },
  {
    lang: 'css',
    weight: 18,
    match: (ctx) => CSS_REGEX.test(ctx.lower) || detectCssStructure(ctx.lines),
  },
  { lang: 'bash', weight: 15, match: (ctx) => detectBashIndicators(ctx.lines) },
  { lang: 'yaml', weight: 15, match: (ctx) => detectYamlStructure(ctx.lines) },
  { lang: 'javascript', weight: 15, match: (ctx) => JS_REGEX.test(ctx.lower) },
  {
    lang: 'json',
    weight: 10,
    match: (ctx) =>
      ctx.trimmedStart.startsWith('{') || ctx.trimmedStart.startsWith('['),
  },
];
export function extractLanguageFromClassName(
  className: string
): string | undefined {
  if (!className) return undefined;

  // Split by whitespace and check for language indicators
  const tokens = className.match(/\S+/g);
  if (!tokens) return undefined;

  // Fast path: check for prefixes
  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower.startsWith('language-')) return token.slice(9);
    if (lower.startsWith('lang-')) return token.slice(5);
    if (lower.startsWith('highlight-')) return token.slice(10);
  }

  // Fallback: check for hljs context
  if (!tokens.includes('hljs')) return undefined;

  const langClass = tokens.find((t) => {
    const l = t.toLowerCase();
    return l !== 'hljs' && !l.startsWith('hljs-');
  });
  return langClass;
}
function resolveLanguageFromDataAttribute(
  dataLang: string
): string | undefined {
  const trimmed = dataLang.trim();
  return /^\w+$/.test(trimmed) ? trimmed : undefined;
}
export function resolveLanguageFromAttributes(
  className: string,
  dataLang: string
): string | undefined {
  return (
    extractLanguageFromClassName(className) ??
    resolveLanguageFromDataAttribute(dataLang)
  );
}
export function detectLanguageFromCode(code: string): string | undefined {
  if (!code || !/\S/.test(code)) return undefined;

  const ctx = new DetectionContext(code);
  return LANGUAGES.find((def) => def.match(ctx))?.lang;
}
