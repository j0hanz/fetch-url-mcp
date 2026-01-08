const MAX_FILENAME_LENGTH = 200;

const UNSAFE_CHARS_REGEX = /[<>:"/\\|?*]|\p{C}/gu;
const WHITESPACE_REGEX = /\s+/g;
const DEFAULT_EXTENSION = '.md';

function trimHyphens(value: string): string {
  let start = 0;
  let end = value.length;

  while (start < end && value[start] === '-') {
    start += 1;
  }
  while (end > start && value[end - 1] === '-') {
    end -= 1;
  }

  return value.slice(start, end);
}

export function generateSafeFilename(
  url: string,
  title?: string,
  hashFallback?: string,
  extension: string = DEFAULT_EXTENSION
): string {
  const fromUrl = extractFilenameFromUrl(url);
  if (fromUrl) return sanitizeFilename(fromUrl, extension);

  if (title) {
    const fromTitle = slugifyTitle(title);
    if (fromTitle) return sanitizeFilename(fromTitle, extension);
  }

  if (hashFallback) {
    return `${hashFallback.substring(0, 16)}${extension}`;
  }

  return `download-${Date.now()}${extension}`;
}

function getLastPathSegment(url: URL): string | null {
  const segments = url.pathname.split('/').filter(Boolean);
  if (segments.length === 0) return null;
  const lastSegment = segments[segments.length - 1];
  return lastSegment ?? null;
}

function stripCommonPageExtension(segment: string): string {
  return segment.replace(/\.(html?|php|aspx?|jsp)$/i, '');
}

function normalizeUrlFilenameSegment(segment: string): string | null {
  const cleaned = stripCommonPageExtension(segment);
  if (!cleaned) return null;
  if (cleaned === 'index') return null;
  return cleaned;
}

function extractFilenameFromUrl(url: string): string | null {
  try {
    const urlObj = new URL(url);
    const lastSegment = getLastPathSegment(urlObj);
    if (!lastSegment) return null;
    return normalizeUrlFilenameSegment(lastSegment);
  } catch {
    return null;
  }
}

function slugifyTitle(title: string): string | null {
  const slug = title
    .toLowerCase()
    .trim()
    .replace(UNSAFE_CHARS_REGEX, '')
    .replace(WHITESPACE_REGEX, '-')
    .replace(/-+/g, '-');
  const trimmed = trimHyphens(slug);

  return trimmed || null;
}

function sanitizeFilename(name: string, extension: string): string {
  let sanitized = name
    .replace(UNSAFE_CHARS_REGEX, '')
    .replace(WHITESPACE_REGEX, '-')
    .trim();

  // Truncate if too long
  const maxBase = MAX_FILENAME_LENGTH - extension.length;
  if (sanitized.length > maxBase) {
    sanitized = sanitized.substring(0, maxBase);
  }

  return `${sanitized}${extension}`;
}
