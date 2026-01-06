import { isMainThread } from 'node:worker_threads';

import type {
  ContentBlockUnion,
  JsonlTransformResult,
  MarkdownTransformResult,
  TransformOptions,
} from '../../config/types/content.js';

import { extractContent } from '../../services/extractor.js';
import { logDebug, logWarn } from '../../services/logger.js';
import { parseHtml, parseHtmlWithMetadata } from '../../services/parser.js';
import { transformInWorker } from '../../services/transform-worker-pool.js';

import { getErrorMessage } from '../../utils/error-utils.js';
import { isRawTextContentUrl } from '../../utils/url-transformer.js';

import { toJsonl } from '../../transformers/jsonl.transformer.js';
import { htmlToMarkdown } from '../../transformers/markdown.transformer.js';

import {
  createContentMetadataBlock,
  determineContentExtractionSource,
  extractTitleFromHtml,
  truncateContent,
} from './content-shaping.js';

interface ExtractionOptions {
  readonly extractMainContent: boolean;
  readonly includeMetadata: boolean;
}

interface ContentSource {
  readonly sourceHtml: string;
  readonly title: string | undefined;
  readonly metadata: ReturnType<typeof createContentMetadataBlock>;
}

interface ContentLengthOptions {
  readonly maxContentLength?: number;
}

interface MarkdownOptions extends ExtractionOptions, ContentLengthOptions {}
interface MarkdownWithBlocksOptions
  extends ExtractionOptions, ContentLengthOptions {
  readonly includeContentBlocks?: boolean;
}

async function tryWorkerTransform<T>(
  kind: Parameters<typeof transformInWorker>[0]['kind'],
  html: string,
  url: string,
  options: TransformOptions & { includeContentBlocks?: boolean }
): Promise<T | null> {
  // Don't use workers from within a worker thread
  if (!isMainThread) return null;

  try {
    return (await transformInWorker({
      kind,
      html,
      url,
      options,
    })) as T;
  } catch (error) {
    logWarn('Worker transform failed, falling back to inline', {
      error: getErrorMessage(error),
    });
    return null;
  }
}

function resolveContentSource(
  html: string,
  url: string,
  options: ExtractionOptions
): ContentSource {
  if (!options.extractMainContent && !options.includeMetadata) {
    return {
      sourceHtml: html,
      title: extractTitleFromHtml(html),
      metadata: undefined,
    };
  }

  const { article, metadata: extractedMeta } = extractContent(html, url, {
    extractArticle: options.extractMainContent,
  });

  const shouldExtractFromArticle = determineContentExtractionSource(
    options.extractMainContent,
    article
  );

  const sourceHtml = shouldExtractFromArticle ? article.content : html;
  const metadata = createContentMetadataBlock(
    url,
    article,
    extractedMeta,
    shouldExtractFromArticle,
    options.includeMetadata
  );
  const title = shouldExtractFromArticle ? article.title : extractedMeta.title;

  return { sourceHtml, title, metadata };
}

function buildJsonlPayload(
  context: ContentSource,
  maxContentLength?: number
): { content: string; contentBlocks: number; truncated: boolean } {
  const contentBlocks = parseHtml(context.sourceHtml);
  return buildJsonlPayloadFromBlocks(
    contentBlocks,
    context.metadata,
    maxContentLength
  );
}

function buildJsonlPayloadFromBlocks(
  contentBlocks: ContentBlockUnion[],
  metadata: ReturnType<typeof createContentMetadataBlock>,
  maxContentLength?: number
): { content: string; contentBlocks: number; truncated: boolean } {
  const { content, truncated } = truncateContent(
    toJsonl(contentBlocks, metadata),
    maxContentLength
  );

  return {
    content,
    contentBlocks: contentBlocks.length,
    truncated,
  };
}

function buildMarkdownPayload(
  context: ContentSource,
  maxContentLength?: number
): { content: string; truncated: boolean } {
  const markdown = htmlToMarkdown(context.sourceHtml, context.metadata);
  const { content, truncated } = truncateContent(markdown, maxContentLength);

  return { content, truncated };
}

function buildRawMarkdownPayload(
  rawContent: string,
  url: string,
  includeMetadata: boolean,
  maxContentLength?: number
): { content: string; truncated: boolean; title: string | undefined } {
  const title = extractTitleFromRawMarkdown(rawContent);
  let content: string;
  if (includeMetadata) {
    content = addSourceToMarkdown(rawContent, url);
  } else {
    content = rawContent;
  }

  const truncateResult = truncateContent(content, maxContentLength);
  return {
    content: truncateResult.content,
    truncated: truncateResult.truncated,
    title,
  };
}

function extractTitleFromRawMarkdown(content: string): string | undefined {
  const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);
  if (!frontmatterMatch) return undefined;

  const frontmatter = frontmatterMatch[1] ?? '';

  const titleMatch = /^(?:title|name):\s*["']?(.+?)["']?\s*$/im.exec(
    frontmatter
  );
  return titleMatch?.[1]?.trim();
}

function addSourceToMarkdown(content: string, url: string): string {
  const frontmatterMatch = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(content);

  if (frontmatterMatch) {
    const start = frontmatterMatch[1] ?? '---\n';
    const existingFields = frontmatterMatch[2] ?? '';
    const end = frontmatterMatch[3] ?? '\n---';
    const rest = content.slice(frontmatterMatch[0].length);

    if (/^source:/im.test(existingFields)) {
      return content;
    }

    return `${start}${existingFields}\nsource: "${url}"${end}${rest}`;
  }

  return `---\nsource: "${url}"\n---\n\n${content}`;
}

function isRawTextContent(content: string): boolean {
  const trimmed = content.trim();

  // Check for common HTML indicators
  if (trimmed.startsWith('<!DOCTYPE') || trimmed.startsWith('<!doctype')) {
    return false;
  }
  if (trimmed.startsWith('<html') || trimmed.startsWith('<HTML')) {
    return false;
  }

  if (/^---\r?\n/.test(trimmed)) {
    return true;
  }
  const htmlTagCount = (
    content.match(/<(html|head|body|div|span|script|style|meta|link)\b/gi) ?? []
  ).length;
  if (htmlTagCount > 2) {
    return false;
  }
  const hasMarkdownHeadings = /^#{1,6}\s+/m.test(content);
  const hasMarkdownLists = /^[\s]*[-*+]\s+/m.test(content);
  const hasMarkdownCodeBlocks = /```[\s\S]*?```/.test(content);
  if (hasMarkdownHeadings || hasMarkdownLists || hasMarkdownCodeBlocks) {
    return true;
  }

  return false;
}

export function transformHtmlToJsonlSync(
  html: string,
  url: string,
  options: ExtractionOptions & ContentLengthOptions
): JsonlTransformResult {
  if (!options.extractMainContent && options.includeMetadata) {
    const parsed = parseHtmlWithMetadata(html);
    const metadataBlock = createContentMetadataBlock(
      url,
      null,
      parsed.metadata,
      false,
      true
    );
    const { content, contentBlocks, truncated } = buildJsonlPayloadFromBlocks(
      parsed.blocks,
      metadataBlock,
      options.maxContentLength
    );

    return {
      content,
      contentBlocks,
      title: parsed.metadata.title,
      ...(truncated && { truncated }),
    };
  }

  const context = resolveContentSource(html, url, options);
  const { content, contentBlocks, truncated } = buildJsonlPayload(
    context,
    options.maxContentLength
  );

  return {
    content,
    contentBlocks,
    title: context.title,
    ...(truncated && { truncated }),
  };
}

export function transformHtmlToMarkdownSync(
  html: string,
  url: string,
  options: MarkdownOptions
): MarkdownTransformResult {
  if (isRawTextContentUrl(url) || isRawTextContent(html)) {
    logDebug('Preserving raw markdown content', { url: url.substring(0, 80) });
    const { content, truncated, title } = buildRawMarkdownPayload(
      html,
      url,
      options.includeMetadata,
      options.maxContentLength
    );
    return {
      markdown: content,
      title,
      truncated,
    };
  }

  const context = resolveContentSource(html, url, options);
  const { content, truncated } = buildMarkdownPayload(
    context,
    options.maxContentLength
  );

  return {
    markdown: content,
    title: context.title,
    truncated,
  };
}

export function transformHtmlToMarkdownWithBlocksSync(
  html: string,
  url: string,
  options: MarkdownWithBlocksOptions
): JsonlTransformResult {
  if (isRawTextContentUrl(url) || isRawTextContent(html)) {
    logDebug('Preserving raw markdown content (with blocks)', {
      url: url.substring(0, 80),
    });
    const { content, truncated, title } = buildRawMarkdownPayload(
      html,
      url,
      options.includeMetadata,
      options.maxContentLength
    );
    return {
      content,
      contentBlocks: 0,
      title,
      ...(truncated && { truncated }),
    };
  }

  const includeContentBlocks = options.includeContentBlocks ?? true;

  if (
    includeContentBlocks &&
    !options.extractMainContent &&
    options.includeMetadata
  ) {
    const parsed = parseHtmlWithMetadata(html);
    const context: ContentSource = {
      sourceHtml: html,
      title: parsed.metadata.title,
      metadata: createContentMetadataBlock(
        url,
        null,
        parsed.metadata,
        false,
        true
      ),
    };
    const { content, truncated } = buildMarkdownPayload(
      context,
      options.maxContentLength
    );

    return {
      content,
      contentBlocks: parsed.blocks.length,
      title: context.title,
      ...(truncated && { truncated }),
    };
  }

  const context = resolveContentSource(html, url, options);
  const contentBlocks = includeContentBlocks
    ? parseHtml(context.sourceHtml)
    : [];
  const { content, truncated } = buildMarkdownPayload(
    context,
    options.maxContentLength
  );

  return {
    content,
    contentBlocks: contentBlocks.length,
    title: context.title,
    ...(truncated && { truncated }),
  };
}

export async function transformHtmlToJsonl(
  html: string,
  url: string,
  options: ExtractionOptions & ContentLengthOptions
): Promise<JsonlTransformResult> {
  const workerResult = await tryWorkerTransform<JsonlTransformResult>(
    'jsonl',
    html,
    url,
    options
  );
  if (workerResult) return workerResult;
  return transformHtmlToJsonlSync(html, url, options);
}

export async function transformHtmlToMarkdown(
  html: string,
  url: string,
  options: MarkdownOptions
): Promise<MarkdownTransformResult> {
  const workerResult = await tryWorkerTransform<MarkdownTransformResult>(
    'markdown',
    html,
    url,
    options
  );
  if (workerResult) return workerResult;
  return transformHtmlToMarkdownSync(html, url, options);
}

export async function transformHtmlToMarkdownWithBlocks(
  html: string,
  url: string,
  options: MarkdownWithBlocksOptions
): Promise<JsonlTransformResult> {
  const workerResult = await tryWorkerTransform<JsonlTransformResult>(
    'markdown-with-blocks',
    html,
    url,
    {
      ...options,
      ...(options.includeContentBlocks !== undefined && {
        includeContentBlocks: options.includeContentBlocks,
      }),
    }
  );
  if (workerResult) return workerResult;
  return transformHtmlToMarkdownWithBlocksSync(html, url, options);
}
