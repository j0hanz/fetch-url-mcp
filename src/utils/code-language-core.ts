import {
  containsJsxTag,
  containsWord,
  extractLanguageFromClassName,
  resolveLanguageFromDataAttribute,
  splitLines,
} from './code-language-helpers.js';

interface CodeDetector {
  language: string;
  detect: (code: string) => boolean;
}

const CODE_DETECTORS: readonly CodeDetector[] = [
  { language: 'jsx', detect: detectJsx },
  { language: 'typescript', detect: detectTypescript },
  { language: 'rust', detect: detectRust },
  { language: 'javascript', detect: detectJavascript },
  { language: 'python', detect: detectPython },
  { language: 'bash', detect: detectBash },
  { language: 'css', detect: detectCss },
  { language: 'html', detect: detectHtml },
  { language: 'json', detect: detectJson },
  { language: 'yaml', detect: detectYaml },
  { language: 'sql', detect: detectSql },
  { language: 'go', detect: detectGo },
];

const TYPE_HINTS = [
  'string',
  'number',
  'boolean',
  'void',
  'any',
  'unknown',
  'never',
];

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
];

const BASH_VERBS = ['install', 'add', 'run', 'build', 'start'];
const BASH_COMMANDS = ['sudo', 'chmod', 'mkdir', 'cd', 'ls', 'cat', 'echo'];
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
const SQL_KEYWORDS = [
  'select',
  'insert',
  'update',
  'delete',
  'create',
  'alter',
  'drop',
];

export function detectLanguageFromCode(code: string): string | undefined {
  for (const { language, detect } of CODE_DETECTORS) {
    if (detect(code)) return language;
  }
  return undefined;
}

export function resolveLanguageFromAttributes(
  className: string,
  dataLang: string
): string | undefined {
  const classMatch = extractLanguageFromClassName(className);
  return classMatch ?? resolveLanguageFromDataAttribute(dataLang);
}

function detectJsx(code: string): boolean {
  const lower = code.toLowerCase();
  if (lower.includes('classname=')) return true;
  if (lower.includes('jsx:')) return true;
  if (lower.includes("from 'react'") || lower.includes('from "react"')) {
    return true;
  }
  return containsJsxTag(code);
}

function detectTypescript(code: string): boolean {
  const lower = code.toLowerCase();
  if (containsWord(lower, 'interface')) return true;
  if (containsWord(lower, 'type')) return true;
  return TYPE_HINTS.some(
    (hint) => lower.includes(`: ${hint}`) || lower.includes(`:${hint}`)
  );
}

function detectRust(code: string): boolean {
  const lower = code.toLowerCase();
  if (containsWord(lower, 'fn')) return true;
  if (lower.includes('let mut')) return true;
  if (containsWord(lower, 'impl')) return true;
  if (containsWord(lower, 'struct')) return true;
  if (containsWord(lower, 'enum')) return true;
  return lower.includes('use ') && lower.includes('::');
}

function detectJavascript(code: string): boolean {
  const lower = code.toLowerCase();
  return (
    containsWord(lower, 'const') ||
    containsWord(lower, 'let') ||
    containsWord(lower, 'var') ||
    containsWord(lower, 'function') ||
    containsWord(lower, 'class') ||
    containsWord(lower, 'async') ||
    containsWord(lower, 'await') ||
    containsWord(lower, 'export') ||
    containsWord(lower, 'import')
  );
}

function detectPython(code: string): boolean {
  const lower = code.toLowerCase();
  return (
    containsWord(lower, 'def') ||
    containsWord(lower, 'class') ||
    containsWord(lower, 'import') ||
    containsWord(lower, 'from') ||
    lower.includes('print(') ||
    lower.includes('__name__')
  );
}

function detectBash(code: string): boolean {
  const lines = splitLines(code);
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!trimmed) continue;
    if (trimmed.startsWith('#!')) return true;
    if (trimmed.startsWith('$ ') || trimmed.startsWith('# ')) return true;

    if (startsWithCommand(trimmed, BASH_COMMANDS)) return true;
    if (startsWithPackageManagerCommand(trimmed)) return true;
  }
  return false;
}

function detectCss(code: string): boolean {
  const lower = code.toLowerCase();
  if (
    lower.includes('@media') ||
    lower.includes('@import') ||
    lower.includes('@keyframes')
  ) {
    return true;
  }
  const lines = splitLines(code);
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (trimmed.startsWith('.') || trimmed.startsWith('#')) {
      if (trimmed.includes('{')) return true;
    }
    if (trimmed.includes(':') && trimmed.includes(';')) return true;
  }
  return false;
}

function detectHtml(code: string): boolean {
  const lower = code.toLowerCase();
  return HTML_TAGS.some((tag) => lower.includes(tag));
}

function detectJson(code: string): boolean {
  const trimmed = code.trimStart();
  if (!trimmed) return false;
  return trimmed.startsWith('{') || trimmed.startsWith('[');
}

function detectYaml(code: string): boolean {
  const lines = splitLines(code);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex <= 0) continue;
    const after = trimmed[colonIndex + 1];
    if (after === ' ' || after === '\t') return true;
  }
  return false;
}

function detectSql(code: string): boolean {
  const lower = code.toLowerCase();
  return SQL_KEYWORDS.some((keyword) => containsWord(lower, keyword));
}

function detectGo(code: string): boolean {
  const lower = code.toLowerCase();
  return (
    containsWord(lower, 'package') ||
    containsWord(lower, 'func') ||
    lower.includes('import "')
  );
}

function startsWithCommand(line: string, commands: readonly string[]): boolean {
  return commands.some(
    (command) => line === command || line.startsWith(`${command} `)
  );
}

function startsWithPackageManagerCommand(line: string): boolean {
  return BASH_PACKAGE_MANAGERS.some((manager) => {
    if (!line.startsWith(`${manager} `)) return false;
    const rest = line.slice(manager.length + 1);
    return BASH_VERBS.some(
      (verb) => rest === verb || rest.startsWith(`${verb} `)
    );
  });
}
