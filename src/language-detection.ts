// This module provides a heuristic-based language detection mechanism for code snippets.
class DetectionContext {
  private _lower: string | undefined;
  private _lines: readonly string[] | undefined;
  private _trimmedStart: string | undefined;

  constructor(readonly code: string) {}

  get lower(): string {
    this._lower ??= this.code.toLowerCase();
    return this._lower;
  }

  get lines(): readonly string[] {
    this._lines ??= this.code.split(/\r?\n/);
    return this._lines;
  }

  get trimmedStart(): string {
    this._trimmedStart ??= this.code.trimStart();
    return this._trimmedStart;
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

const BASH_VERBS = new Set(['install', 'add', 'run', 'build', 'start']);

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
const CSS_REGEX = /@media|@import|@keyframes/;
const CSS_PROPERTY_REGEX = /^\s*[a-z][\w-]*\s*:/;

function containsJsxTag(code: string): boolean {
  const len = code.length;
  for (let i = 0; i < len - 1; i++) {
    if (code.charCodeAt(i) === 60 /* < */) {
      const next = code.charCodeAt(i + 1);
      if (next >= 65 && next <= 90) return true; // A-Z
    }
  }
  return false;
}

function isBashLine(line: string): boolean {
  const trimmed = line.trimStart();
  if (trimmed.length === 0) return false;

  // Shell Prefix
  if (
    trimmed.startsWith('#!') ||
    trimmed.startsWith('$ ') ||
    trimmed.startsWith('# ')
  ) {
    return true;
  }

  const spaceIdx = trimmed.indexOf(' ');
  const firstWord = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);

  if (BASH_COMMANDS.has(firstWord)) return true;

  // Package Managers
  let isPkgMgr = false;
  for (const mgr of BASH_PACKAGE_MANAGERS) {
    if (firstWord === mgr) {
      isPkgMgr = true;
      break;
    }
  }

  if (isPkgMgr && spaceIdx !== -1) {
    const rest = trimmed.slice(spaceIdx + 1);
    const secondSpaceIdx = rest.indexOf(' ');
    const secondWord =
      secondSpaceIdx === -1 ? rest : rest.slice(0, secondSpaceIdx);
    if (BASH_VERBS.has(secondWord)) return true;
  }

  return false;
}

function detectBashIndicators(lines: readonly string[]): boolean {
  for (const line of lines) {
    if (isBashLine(line)) return true;
  }
  return false;
}

function detectCssStructure(lines: readonly string[]): boolean {
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.length === 0) continue;

    const hasSelector =
      (trimmed.startsWith('.') || trimmed.startsWith('#')) &&
      trimmed.includes('{');

    if (hasSelector) return true;
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
    if (trimmed.length === 0) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx <= 0) continue;

    const after = trimmed.charCodeAt(colonIdx + 1);
    // space (32) or tab (9)
    if (after === 32 || after === 9) return true;
  }
  return false;
}

// Matcher type: returns true if matches.
type Matcher = (ctx: DetectionContext) => boolean;

interface LanguageDef {
  lang: string;
  weight: number;
  match: Matcher;
}

const LANGUAGES: LanguageDef[] = [
  {
    lang: 'rust',
    weight: 25,
    match: (ctx) => {
      if (ctx.lower.includes('let mut')) return true;
      if (RUST_REGEX.test(ctx.lower)) return true;
      return ctx.lower.includes('use ') && ctx.lower.includes('::');
    },
  },
  {
    lang: 'go',
    weight: 22,
    match: (ctx) => {
      if (ctx.lower.includes('import "')) return true;
      return /\b(?:package|func)\b/.test(ctx.lower);
    },
  },
  {
    lang: 'jsx',
    weight: 22,
    match: (ctx) => {
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
    },
  },
  {
    lang: 'typescript',
    weight: 20,
    match: (ctx) => {
      if (/\b(?:interface|type)\b/.test(ctx.lower)) return true;
      const l = ctx.lower;
      for (const hint of TYPESCRIPT_HINTS) {
        if (l.includes(hint)) return true;
      }
      return false;
    },
  },
  {
    lang: 'sql',
    weight: 20,
    match: (ctx) => {
      const l = ctx.lower;
      return /\b(?:select|insert|update|delete|create|alter|drop)\b/.test(l);
    },
  },
  {
    lang: 'python',
    weight: 18,
    match: (ctx) => {
      const l = ctx.lower;
      if (l.includes('print(') || l.includes('__name__')) return true;
      if (l.includes('self.') || l.includes('elif ')) return true;
      // Check for Python's None/True/False using original case (they are capitalized in Python)
      if (
        ctx.code.includes('None') ||
        ctx.code.includes('True') ||
        ctx.code.includes('False')
      ) {
        return true;
      }
      // Python-unique keywords that JS doesn't have
      if (PYTHON_UNIQUE_REGEX.test(l)) return true;
      // Shared keywords (import, from, class) — only match if no JS signals present
      if (
        /\b(?:import|from|class)\b/.test(l) &&
        !JS_SIGNAL_REGEX.test(l) &&
        !l.includes('{') &&
        !l.includes("from '")
      ) {
        return true;
      }
      return false;
    },
  },
  {
    lang: 'css',
    weight: 18,
    match: (ctx) => {
      if (CSS_REGEX.test(ctx.lower)) return true;
      return detectCssStructure(ctx.lines);
    },
  },
  {
    lang: 'bash',
    weight: 15,
    match: (ctx) => detectBashIndicators(ctx.lines),
  },
  {
    lang: 'yaml',
    weight: 15,
    match: (ctx) => detectYamlStructure(ctx.lines),
  },
  {
    lang: 'javascript',
    weight: 15,
    match: (ctx) => JS_REGEX.test(ctx.lower),
  },
  {
    lang: 'html',
    weight: 12,
    match: (ctx) => {
      const l = ctx.lower;
      for (const tag of HTML_TAGS) {
        if (l.includes(tag)) return true;
      }
      return false;
    },
  },
  {
    lang: 'json',
    weight: 10,
    match: (ctx) => {
      const s = ctx.trimmedStart;
      return s.startsWith('{') || s.startsWith('[');
    },
  },
];

function extractLanguageFromClassName(className: string): string | undefined {
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
  if (!trimmed) return undefined;

  // Check if \w+
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed.charCodeAt(i);
    // valid: A-Z, a-z, 0-9, _
    const isUpper = c >= 65 && c <= 90;
    const isLower = c >= 97 && c <= 122;
    const isDigit = c >= 48 && c <= 57;
    const isUnder = c === 95;

    if (!isUpper && !isLower && !isDigit && !isUnder) {
      return undefined;
    }
  }
  return trimmed;
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
  if (!code) return undefined;

  // Fast path for empty/whitespace only
  let empty = true;
  for (let i = 0; i < code.length; i++) {
    if (code.charCodeAt(i) > 32) {
      empty = false;
      break;
    }
  }
  if (empty) return undefined;

  const ctx = new DetectionContext(code);

  let bestLang: string | undefined;
  let bestScore = -1;

  for (const def of LANGUAGES) {
    if (def.match(ctx)) {
      if (def.weight > bestScore) {
        bestScore = def.weight;
        bestLang = def.lang;
        if (bestScore >= 25) break;
      }
    }
  }

  return bestLang;
}
