import type { ServerResponse } from 'node:http';
import { posix as pathPosix } from 'node:path';

import { z } from 'zod';

import {
  get as cacheGet,
  parseCachedPayload,
  resolveCachedPayloadContent,
} from './cache.js';
import { config } from './config.js';

/* -------------------------------------------------------------------------------------------------
 * Utils: Filename Logic
 * ------------------------------------------------------------------------------------------------- */

const FILENAME_RULES = {
  MAX_LEN: 200,
  UNSAFE_CHARS: /[<>:"/\\|?*\p{C}]/gu,
  WHITESPACE: /\s+/g,
  EXTENSIONS: /\.(html?|php|aspx?|jsp)$/i,
} as const;

function sanitizeString(input: string): string {
  return input
    .toLowerCase()
    .replace(FILENAME_RULES.UNSAFE_CHARS, '')
    .replace(FILENAME_RULES.WHITESPACE, '-')
    .replace(/-+/g, '-')
    .replace(/(?:^-|-$)/g, '');
}

function resolveUrlFilenameCandidate(url: string): string | null {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;

  const basename = pathPosix.basename(parsed.pathname);
  if (!basename || basename === 'index') return null;

  const cleaned = basename.replace(FILENAME_RULES.EXTENSIONS, '');
  const sanitized = sanitizeString(cleaned);

  if (sanitized === 'index') return null;
  return sanitized || null;
}

function truncateFilenameBase(name: string, extension: string): string {
  const maxBase = FILENAME_RULES.MAX_LEN - extension.length;
  return name.length > maxBase ? name.substring(0, maxBase) : name;
}

function resolveTitleFilenameCandidate(title?: string): string | null {
  if (!title) return null;
  return sanitizeString(title) || null;
}

function resolveFilenameBase(
  url: string,
  title?: string,
  hashFallback?: string
): string {
  try {
    const fromUrl = resolveUrlFilenameCandidate(url);
    if (fromUrl) return fromUrl;
  } catch {
    // Ignore URL parsing errors and continue fallbacks.
  }

  const fromTitle = resolveTitleFilenameCandidate(title);
  if (fromTitle) return fromTitle;

  if (hashFallback) return hashFallback.substring(0, 16);
  return `download-${Date.now()}`;
}

export function generateSafeFilename(
  url: string,
  title?: string,
  hashFallback?: string,
  extension = '.md'
): string {
  const name = resolveFilenameBase(url, title, hashFallback);

  return `${truncateFilenameBase(name, extension)}${extension}`;
}

/* -------------------------------------------------------------------------------------------------
 * Adapter: Download Handler
 * ------------------------------------------------------------------------------------------------- */

const DownloadParamsSchema = z.strictObject({
  namespace: z.literal('markdown'),
  hash: z
    .string()
    .regex(/^[a-f0-9.]+$/i)
    .min(8)
    .max(64),
});

export function handleDownload(
  res: ServerResponse,
  namespace: string,
  hash: string
): void {
  const respond = (status: number, msg: string, code: string): void => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: msg, code }));
  };

  const parsed = DownloadParamsSchema.safeParse({ namespace, hash });
  if (!parsed.success) {
    respond(400, 'Invalid namespace or hash', 'BAD_REQUEST');
    return;
  }

  const cacheKey = `${parsed.data.namespace}:${parsed.data.hash}`;
  const entry = cacheGet(cacheKey, { force: true });

  if (!entry) {
    respond(404, 'Not found or expired', 'NOT_FOUND');
    return;
  }

  const payload = parseCachedPayload(entry.content);
  const content = payload ? resolveCachedPayloadContent(payload) : null;

  if (!content) {
    respond(404, 'Content missing', 'NOT_FOUND');
    return;
  }

  const fileName = generateSafeFilename(
    entry.url,
    payload?.title,
    parsed.data.hash
  );

  // Safe header generation — RFC 5987 encoding for non-ASCII filenames
  const encoded = encodeURIComponent(fileName).replace(/'/g, '%27');

  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${fileName}"; filename*=UTF-8''${encoded}`
  );
  res.setHeader('Cache-Control', `private, max-age=${config.cache.ttl}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.end(content);
}
