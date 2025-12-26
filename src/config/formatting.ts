export const LINE_BREAK = '\n';

export const EXCESSIVE_NEWLINES_PATTERN = /\n{2,}/g;

export const TRUNCATION_MARKER = '...[truncated]';

export const CODE_BLOCK = {
  fence: '```',
  format: (code: string, language = ''): string => {
    const trimmedCode = code.replace(/\n$/, '');
    return `\`\`\`${language}\n${trimmedCode}\n\`\`\``;
  },
} as const;

export const FRONTMATTER_DELIMITER = '---';

export const normalizeNewlines = (content: string): string =>
  content.replace(EXCESSIVE_NEWLINES_PATTERN, LINE_BREAK).trim();

export const splitLines = (content: string): string[] =>
  content.split(LINE_BREAK);

export const joinLines = (lines: string[]): string => lines.join(LINE_BREAK);
