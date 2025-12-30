import { TRUNCATION_MARKER } from '../../config/formatting.js';
import type {
  JsonlTransformResult,
  MarkdownTransformResult,
} from '../../config/types/content.js';

import { extractContent } from '../../services/extractor.js';
import { parseHtml } from '../../services/parser.js';

import { sanitizeText } from '../../utils/sanitizer.js';

import { toJsonl } from '../../transformers/jsonl.transformer.js';
import { htmlToMarkdown } from '../../transformers/markdown.transformer.js';

import {
  createContentMetadataBlock,
  determineContentExtractionSource,
  truncateContent,
} from './common.js';

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

const TITLE_PATTERN = /<title[^>]*>([\s\S]*?)<\/title>/i;

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

function extractTitleFromHtml(html: string): string | undefined {
  const match = TITLE_PATTERN.exec(html);
  if (!match?.[1]) return undefined;
  const decoded = decodeHtmlEntities(match[1]);
  const text = sanitizeText(decoded);
  return text || undefined;
}

function decodeHtmlEntities(value: string): string {
  if (!value.includes('&')) return value;

  const basicDecoded = value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");

  return basicDecoded
    .replace(/&#(\d+);/g, (match: string, code: string) => {
      const parsed = Number.parseInt(code, 10);
      return Number.isFinite(parsed) ? String.fromCharCode(parsed) : match;
    })
    .replace(/&#x([0-9a-fA-F]+);/g, (match: string, code: string) => {
      const parsed = Number.parseInt(code, 16);
      return Number.isFinite(parsed) ? String.fromCharCode(parsed) : match;
    });
}

function buildJsonlPayload(
  context: ContentSource,
  maxContentLength?: number
): { content: string; contentBlocks: number; truncated: boolean } {
  const contentBlocks = parseHtml(context.sourceHtml);
  const { content, truncated } = truncateContent(
    toJsonl(contentBlocks, context.metadata),
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
  const { content, truncated } = truncateContent(
    markdown,
    maxContentLength,
    TRUNCATION_MARKER
  );

  return { content, truncated };
}

export function transformHtmlToJsonl(
  html: string,
  url: string,
  options: ExtractionOptions & ContentLengthOptions
): JsonlTransformResult {
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

export function transformHtmlToMarkdown(
  html: string,
  url: string,
  options: MarkdownOptions
): MarkdownTransformResult {
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

export function transformHtmlToMarkdownWithBlocks(
  html: string,
  url: string,
  options: ExtractionOptions & ContentLengthOptions
): JsonlTransformResult {
  const context = resolveContentSource(html, url, options);
  const contentBlocks = parseHtml(context.sourceHtml);
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
