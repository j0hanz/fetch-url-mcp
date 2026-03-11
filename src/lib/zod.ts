import { z } from 'zod';

function formatPathSegment(segment: string | number | symbol): string {
  if (typeof segment === 'number') return `[${segment}]`;
  if (typeof segment === 'string') return segment;
  return segment.description ?? '<symbol>';
}

function formatIssuePath(path: readonly (string | number | symbol)[]): string {
  if (path.length === 0) return '';

  let result = '';
  for (const segment of path) {
    if (typeof segment === 'number') {
      result += formatPathSegment(segment);
      continue;
    }

    const normalized = formatPathSegment(segment);
    result += result ? `.${normalized}` : normalized;
  }

  return result;
}

export function formatZodError(error: z.ZodError): string {
  const parts = error.issues.map((issue) => {
    const path = formatIssuePath(issue.path);
    return path ? `${path}: ${issue.message}` : issue.message;
  });

  const unique = [...new Set(parts.filter((value) => value.trim().length > 0))];
  if (unique.length > 0) return unique.join('; ');

  const pretty = z.prettifyError(error).replace(/\s+/g, ' ').trim();
  return pretty || 'Invalid input';
}
