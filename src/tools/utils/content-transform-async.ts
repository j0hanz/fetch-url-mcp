import type {
  JsonlTransformResult,
  MarkdownTransformResult,
  TransformOptions,
} from '../../config/types/content.js';

import { logWarn } from '../../services/logger.js';
import {
  runTransformInWorker,
  type TransformJob,
} from '../../services/transform-worker-pool.js';

import {
  transformHtmlToJsonl,
  transformHtmlToMarkdown,
  transformHtmlToMarkdownWithBlocks,
} from './content-transform.js';

async function runOrFallback(
  job: TransformJob,
  fallback: () => JsonlTransformResult | MarkdownTransformResult
): Promise<JsonlTransformResult | MarkdownTransformResult> {
  try {
    const result = await runTransformInWorker(job);
    if (result) return result;
  } catch (error) {
    logWarn('Transform worker unavailable; using main thread', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return fallback();
}

export async function transformHtmlToJsonlAsync(
  html: string,
  url: string,
  options: TransformOptions
): Promise<JsonlTransformResult> {
  const result = await runOrFallback(
    { mode: 'jsonl', html, url, options },
    () => transformHtmlToJsonl(html, url, options)
  );
  return result as JsonlTransformResult;
}

export async function transformHtmlToMarkdownAsync(
  html: string,
  url: string,
  options: TransformOptions
): Promise<MarkdownTransformResult> {
  const result = await runOrFallback(
    { mode: 'markdown', html, url, options },
    () => transformHtmlToMarkdown(html, url, options)
  );
  return result as MarkdownTransformResult;
}

export async function transformHtmlToMarkdownWithBlocksAsync(
  html: string,
  url: string,
  options: TransformOptions & { includeContentBlocks?: boolean }
): Promise<JsonlTransformResult> {
  const result = await runOrFallback(
    {
      mode: 'markdown-blocks',
      html,
      url,
      options,
    },
    () => transformHtmlToMarkdownWithBlocks(html, url, options)
  );
  return result as JsonlTransformResult;
}
