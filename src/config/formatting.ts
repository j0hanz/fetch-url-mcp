export const TRUNCATION_MARKER = '...[truncated]';

export const CODE_BLOCK = {
  fence: '```',
  format: (code: string, language = ''): string => {
    return `\`\`\`${language}\n${code}\n\`\`\``;
  },
} as const;

export const FRONTMATTER_DELIMITER = '---';

export const joinLines = (lines: readonly string[]): string => lines.join('\n');
