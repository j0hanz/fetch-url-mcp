import type { Express, NextFunction, Request, Response } from 'express';

import { config } from '../config/index.js';
import type { CacheEntry } from '../config/types/content.js';

import * as cache from '../services/cache.js';
import { logDebug } from '../services/logger.js';

import { generateSafeFilename } from '../utils/filename-generator.js';

const HASH_PATTERN = /^[a-f0-9.]+$/i;

interface DownloadParams {
  namespace: string;
  hash: string;
}

interface CachedPayload {
  content?: string;
  markdown?: string;
  title?: string;
}

interface DownloadPayload {
  content: string;
  contentType: string;
  fileName: string;
}

function validateNamespace(namespace: string): boolean {
  return namespace === 'markdown';
}

function validateHash(hash: string): boolean {
  return HASH_PATTERN.test(hash) && hash.length >= 8 && hash.length <= 64;
}

function parseDownloadParams(req: Request): DownloadParams | null {
  const { namespace, hash } = req.params;

  if (!namespace || !hash) return null;
  if (!validateNamespace(namespace)) return null;
  if (!validateHash(hash)) return null;

  return { namespace, hash };
}

function buildCacheKeyFromParams(params: DownloadParams): string {
  return `${params.namespace}:${params.hash}`;
}

function respondBadRequest(res: Response, message: string): void {
  res.status(400).json({
    error: message,
    code: 'BAD_REQUEST',
  });
}

function respondNotFound(res: Response): void {
  res.status(404).json({
    error: 'Content not found or expired',
    code: 'NOT_FOUND',
  });
}

function respondServiceUnavailable(res: Response): void {
  res.status(503).json({
    error: 'Download service is disabled',
    code: 'SERVICE_UNAVAILABLE',
  });
}

function parseCachedPayload(raw: string): CachedPayload | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    return isCachedPayload(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCachedPayload(value: unknown): value is CachedPayload {
  if (!isRecord(value)) return false;
  return (
    (value.content === undefined || typeof value.content === 'string') &&
    (value.markdown === undefined || typeof value.markdown === 'string') &&
    (value.title === undefined || typeof value.title === 'string')
  );
}

function resolvePayloadContent(payload: CachedPayload): string | null {
  if (typeof payload.markdown === 'string') {
    return payload.markdown;
  }
  if (typeof payload.content === 'string') {
    return payload.content;
  }
  return null;
}

function resolveDownloadPayload(
  params: DownloadParams,
  cacheEntry: CacheEntry
): DownloadPayload | null {
  const payload = parseCachedPayload(cacheEntry.content);
  if (!payload) return null;

  const content = resolvePayloadContent(payload);
  if (!content) return null;

  const safeTitle =
    typeof payload.title === 'string' ? payload.title : undefined;
  const fileName = generateSafeFilename(
    cacheEntry.url,
    cacheEntry.title ?? safeTitle,
    params.hash,
    '.md'
  );

  return {
    content,
    contentType: 'text/markdown; charset=utf-8',
    fileName,
  };
}

function buildContentDisposition(fileName: string): string {
  const encodedName = encodeURIComponent(fileName).replace(/'/g, '%27');
  return `attachment; filename="${fileName}"; filename*=UTF-8''${encodedName}`;
}

function handleDownload(req: Request, res: Response): Promise<void> {
  if (!config.cache.enabled) {
    respondServiceUnavailable(res);
    return Promise.resolve();
  }

  const params = parseDownloadParams(req);
  if (!params) {
    respondBadRequest(res, 'Invalid namespace or hash format');
    return Promise.resolve();
  }

  const cacheKey = buildCacheKeyFromParams(params);
  const cacheEntry = cache.get(cacheKey);

  if (!cacheEntry) {
    logDebug('Download request for missing cache key', { cacheKey });
    respondNotFound(res);
    return Promise.resolve();
  }

  const payload = resolveDownloadPayload(params, cacheEntry);
  if (!payload) {
    logDebug('Download payload unavailable', { cacheKey });
    respondNotFound(res);
    return Promise.resolve();
  }

  const disposition = buildContentDisposition(payload.fileName);

  res.setHeader('Content-Type', payload.contentType);
  res.setHeader('Content-Disposition', disposition);
  res.setHeader('Cache-Control', `private, max-age=${config.cache.ttl}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');

  logDebug('Serving download', { cacheKey, fileName: payload.fileName });
  res.send(payload.content);
  return Promise.resolve();
}

export function registerDownloadRoutes(app: Express): void {
  const asyncHandler =
    (fn: (req: Request, res: Response) => Promise<void>) =>
    (req: Request, res: Response, next: NextFunction) => {
      Promise.resolve(fn(req, res)).catch(next);
    };

  app.get('/mcp/downloads/:namespace/:hash', asyncHandler(handleDownload));
}
