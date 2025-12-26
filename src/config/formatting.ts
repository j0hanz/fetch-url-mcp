export const LINE_BREAK = '\n';

export const TRUNCATION_MARKER = '...[truncated]';

export const CODE_BLOCK = {
  fence: '```',
  format: (code: string, language = ''): string => {
    return `\`\`\`${language}\n${code}\n\`\`\``;
  },
} as const;

export const FRONTMATTER_DELIMITER = '---';

export const joinLines = (lines: string[]): string => lines.join(LINE_BREAK);
