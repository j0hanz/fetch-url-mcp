export const LINE_BREAK = '\n';

export const BLOCK_SEPARATOR = '\n\n';

export const EXCESSIVE_NEWLINES_PATTERN = /\n{3,}/g;

export const TRUNCATION_SUFFIX = {
  default: '\n\n...[truncated]',
  inline: '\n...[truncated]',
} as const;

export const CODE_BLOCK = {
  fence: '```',
  format: (code: string, language = ''): string => {
    const trimmedCode = code.replace(/\n$/, '');
    return `${BLOCK_SEPARATOR}\`\`\`${language}\n${trimmedCode}\n\`\`\`${BLOCK_SEPARATOR}`;
  },
} as const;

export const FRONTMATTER = {
  delimiter: '---',
  join: (lines: string[]): string => lines.join(LINE_BREAK),
  suffix: BLOCK_SEPARATOR,
} as const;

export const JSONL = {
  join: (lines: string[]): string => lines.join(LINE_BREAK),
} as const;

export const normalizeNewlines = (content: string): string =>
  content.replace(EXCESSIVE_NEWLINES_PATTERN, BLOCK_SEPARATOR).trim();

export const splitLines = (content: string): string[] =>
  content.split(LINE_BREAK);

export const joinLines = (lines: string[]): string => lines.join(LINE_BREAK);
