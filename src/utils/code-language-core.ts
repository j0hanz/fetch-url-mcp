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
const JS_WORD_REGEX =
  /\b(?:const|let|var|function|class|async|await|export|import)\b/;
const PYTHON_WORD_REGEX = /\b(?:def|class|import|from)\b/;
const RUST_WORD_REGEX = /\b(?:fn|impl|struct|enum)\b/;
const CSS_DIRECTIVE_REGEX = /@media|@import|@keyframes/;

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
  return (
    RUST_WORD_REGEX.test(lower) ||
    lower.includes('let mut') ||
    (lower.includes('use ') && lower.includes('::'))
  );
}

function detectJavascript(code: string): boolean {
  const lower = code.toLowerCase();
  return JS_WORD_REGEX.test(lower);
}

function detectPython(code: string): boolean {
  const lower = code.toLowerCase();
  return (
    PYTHON_WORD_REGEX.test(lower) ||
    lower.includes('print(') ||
    lower.includes('__name__')
  );
}

function detectBash(code: string): boolean {
  const lines = splitLines(code);
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!trimmed) continue;
    if (isBashIndicator(trimmed)) return true;
  }
  return false;
}

function detectCss(code: string): boolean {
  const lower = code.toLowerCase();
  if (CSS_DIRECTIVE_REGEX.test(lower)) return true;

  const lines = splitLines(code);
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!trimmed) continue;
    if (isCssSelectorLine(trimmed) || isCssPropertyLine(trimmed)) return true;
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

function isCssSelectorLine(line: string): boolean {
  if (!line.startsWith('.') && !line.startsWith('#')) return false;
  return line.includes('{');
}

function isCssPropertyLine(line: string): boolean {
  return line.includes(':') && line.includes(';');
}

function isBashIndicator(line: string): boolean {
  return (
    isShebang(line) ||
    isPromptLine(line) ||
    startsWithCommand(line, BASH_COMMANDS) ||
    startsWithPackageManagerCommand(line)
  );
}

function isShebang(line: string): boolean {
  return line.startsWith('#!');
}

function isPromptLine(line: string): boolean {
  return line.startsWith('$ ') || line.startsWith('# ');
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
