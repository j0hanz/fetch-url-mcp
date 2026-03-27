import { z } from 'zod';

function formatPathSegment(segment: string | number | symbol): string {
  if (typeof segment === 'number') return `[${segment}]`;
  if (typeof segment === 'string') return segment;
  return segment.description ?? '<symbol>';
}

function formatIssuePath(path: readonly (string | number | symbol)[]): string {
  return path.reduce((acc: string, segment) => {
    const isNum = typeof segment === 'number';
    const formatted = formatPathSegment(segment);
    return acc ? `${acc}${isNum ? '' : '.'}${formatted}` : formatted;
  }, '');
}

export function formatZodError(error: z.ZodError): string {
  const parts = error.issues.map((issue) => {
    const path = formatIssuePath(issue.path);
    return path ? `${path}: ${issue.message}` : issue.message;
  });

  const uniqueParts = [
    ...new Set(parts.filter((val) => val.trim().length > 0)),
  ];
  if (uniqueParts.length > 0) return uniqueParts.join('; ');

  return z.prettifyError(error).replace(/\s+/g, ' ').trim() || 'Invalid input';
}
