export function looksLikeMarkdown(content: string): boolean {
  return (
    containsMarkdownHeading(content) ||
    containsMarkdownList(content) ||
    containsFencedCodeBlock(content)
  );
}

function containsMarkdownHeading(content: string): boolean {
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (!trimmed.startsWith('#')) continue;
    let count = 0;
    while (count < trimmed.length && trimmed[count] === '#') {
      count += 1;
    }
    if (count >= 1 && count <= 6 && trimmed[count] === ' ') {
      return true;
    }
  }
  return false;
}

function containsMarkdownList(content: string): boolean {
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trimStart();
    if (
      trimmed.startsWith('- ') ||
      trimmed.startsWith('* ') ||
      trimmed.startsWith('+ ')
    ) {
      return true;
    }
  }
  return false;
}

function containsFencedCodeBlock(content: string): boolean {
  const first = content.indexOf('```');
  if (first === -1) return false;
  return content.includes('```', first + 3);
}
