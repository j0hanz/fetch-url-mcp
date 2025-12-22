import TurndownService from 'turndown';

import type { MetadataBlock } from '../config/types.js';

function detectLanguageFromCode(code: string): string | undefined {
  const patterns: readonly [RegExp, string][] = [
    [
      /^\s*import\s+.*\s+from\s+['"]react['"]|<[A-Z][a-zA-Z]*[\s/>]|jsx\s*:|className=/m,
      'jsx',
    ],
    [
      /:\s*(string|number|boolean|void|any|unknown|never)\b|interface\s+\w+|type\s+\w+\s*=/m,
      'typescript',
    ],
    [/^\s*(fn|let\s+mut|impl|struct|enum|use\s+\w+::)/m, 'rust'],
    [
      /^\s*(export|const|let|var|function|class|async|await)\b|^\s*import\s+.*['"]]/m,
      'javascript',
    ],
    [/^\s*(def|class|import|from|if __name__|print\()/m, 'python'],
    [/^\s*(npm|yarn|pnpm|npx)\s+(install|add|run|build|start)/m, 'bash'],
    [/^\s*[.#@]?[\w-]+\s*\{[^}]*\}|@media|@import/m, 'css'],
    [/^\s*<(!DOCTYPE|html|head|body|div)\b/im, 'html'],
    [/^\s*\{\s*"|^\s*\[\s*(")/m, 'json'],
    [/^\s*(SELECT|INSERT|UPDATE|DELETE|CREATE)\s+/im, 'sql'],
  ];
  return patterns.find(([pattern]) => pattern.test(code))?.[1];
}

const NOISE_LINE_PATTERNS: readonly RegExp[] = [
  // Single letters or panel labels (common in code examples)
  /^[A-Z]$/,
  /^Panel\s+[A-Z]$/i,

  // Empty structural elements that survive HTML->Markdown conversion
  /^[•·→←↑↓►▼▲◄▶◀■□●○★☆✓✗✔✘×]+$/,
  /^[,;:\-–—]+$/,
  /^\[\d+\]$/,
  /^\(\d+\)$/,
] as const;

const MULTIPLE_NEWLINES = /\n{3,}/g;

function isNoiseLine(line: string): boolean {
  const trimmed = line.trim();

  if (!trimmed) return false;

  const markdownPrefixes = ['#', '-', '*', '`', '>', '|'];
  if (markdownPrefixes.some((prefix) => trimmed.startsWith(prefix))) {
    return false;
  }

  return NOISE_LINE_PATTERNS.some((pattern) => pattern.test(trimmed));
}

const CODE_FENCE = '```';

function cleanMarkdownContent(markdown: string): string {
  const lines = markdown.split('\n');
  const cleanedLines: string[] = [];
  let insideCodeBlock = false;

  for (const line of lines) {
    if (line.trim().startsWith(CODE_FENCE)) {
      insideCodeBlock = !insideCodeBlock;
      cleanedLines.push(line);
      continue;
    }

    if (insideCodeBlock) {
      cleanedLines.push(line);
      continue;
    }

    if (!isNoiseLine(line)) {
      cleanedLines.push(line);
    }
  }

  return cleanedLines.join('\n');
}

const turndown = new TurndownService({
  headingStyle: 'atx',
  codeBlockStyle: 'fenced',
  emDelimiter: '_',
  bulletListMarker: '-',
});

turndown.addRule('removeNoise', {
  filter: ['script', 'style', 'noscript', 'nav', 'footer', 'aside', 'iframe'],
  replacement: () => '',
});

turndown.addRule('fencedCodeBlockWithLanguage', {
  filter: (node, options) => {
    return (
      options.codeBlockStyle === 'fenced' &&
      node.nodeName === 'PRE' &&
      node.firstChild !== null &&
      node.firstChild.nodeName === 'CODE'
    );
  },
  replacement: (_content, node) => {
    const codeNode = node.firstChild as HTMLElement;
    const code = codeNode.textContent || '';

    const className = codeNode.getAttribute('class') ?? '';
    const dataLang = codeNode.getAttribute('data-language') ?? '';

    const languageMatch =
      /language-(\w+)/.exec(className) ??
      /lang-(\w+)/.exec(className) ??
      /highlight-(\w+)/.exec(className) ??
      /^(\w+)$/.exec(dataLang);

    const language = languageMatch?.[1] ?? detectLanguageFromCode(code) ?? '';

    return `\n\n\`\`\`${language}\n${code.replace(/\n$/, '')}\n\`\`\`\n\n`;
  },
});

const YAML_SPECIAL_CHARS = /[:[\]{}"\n\r\t'|>&*!?,#]/;
const YAML_NUMERIC = /^[\d.]+$/;
const YAML_RESERVED_WORDS = /^(true|false|null|yes|no|on|off)$/i;

const ESCAPE_PATTERNS = {
  backslash: /\\/g,
  quote: /"/g,
  newline: /\n/g,
  tab: /\t/g,
} as const;

function needsYamlQuotes(value: string): boolean {
  return (
    YAML_SPECIAL_CHARS.test(value) ||
    value.startsWith(' ') ||
    value.endsWith(' ') ||
    value === '' ||
    YAML_NUMERIC.test(value) ||
    YAML_RESERVED_WORDS.test(value)
  );
}

function escapeYamlValue(value: string): string {
  if (!needsYamlQuotes(value)) {
    return value;
  }

  const escaped = value
    .replace(ESCAPE_PATTERNS.backslash, '\\\\')
    .replace(ESCAPE_PATTERNS.quote, '\\"')
    .replace(ESCAPE_PATTERNS.newline, '\\n')
    .replace(ESCAPE_PATTERNS.tab, '\\t');

  return `"${escaped}"`;
}

function createFrontmatter(metadata: MetadataBlock): string {
  const lines = ['---'];

  if (metadata.title) {
    lines.push(`title: ${escapeYamlValue(metadata.title)}`);
  }
  if (metadata.url) {
    lines.push(`source: ${escapeYamlValue(metadata.url)}`);
  }

  lines.push('---');
  return lines.join('\n');
}

function convertHtmlToMarkdown(html: string): string {
  let content = turndown.turndown(html);
  content = content.replace(MULTIPLE_NEWLINES, '\n\n').trim();
  content = cleanMarkdownContent(content);
  content = content.replace(MULTIPLE_NEWLINES, '\n\n').trim();
  return content;
}

function buildFrontmatterBlock(metadata?: MetadataBlock): string {
  return metadata ? createFrontmatter(metadata) : '';
}

export function htmlToMarkdown(html: string, metadata?: MetadataBlock): string {
  const frontmatter = buildFrontmatterBlock(metadata);

  if (!html || typeof html !== 'string') {
    return frontmatter ? `${frontmatter}\n\n` : '';
  }

  try {
    const content = convertHtmlToMarkdown(html);
    return frontmatter ? `${frontmatter}\n\n${content}` : content;
  } catch {
    return frontmatter ? `${frontmatter}\n\n` : '';
  }
}
