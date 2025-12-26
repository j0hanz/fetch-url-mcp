import { TRUNCATION_MARKER } from '../../config/formatting.js';
import type {
  JsonlTransformResult,
  MarkdownTransformResult,
} from '../../config/types.js';

import { extractContent } from '../../services/extractor.js';
import { parseHtml } from '../../services/parser.js';

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

interface MarkdownOptions extends ExtractionOptions, ContentLengthOptions {
  readonly generateToc?: boolean;
}

function resolveContentSource(
  html: string,
  url: string,
  options: ExtractionOptions
): ContentSource {
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

export function transformHtmlToJsonl(
  html: string,
  url: string,
  options: ExtractionOptions & ContentLengthOptions
): JsonlTransformResult {
  const { sourceHtml, title, metadata } = resolveContentSource(
    html,
    url,
    options
  );
  const contentBlocks = parseHtml(sourceHtml);

  const { content, truncated } = truncateContent(
    toJsonl(contentBlocks, metadata),
    options.maxContentLength
  );

  return {
    content,
    contentBlocks: contentBlocks.length,
    title,
    ...(truncated && { truncated }),
  };
}

export function transformHtmlToMarkdown(
  html: string,
  url: string,
  options: MarkdownOptions
): MarkdownTransformResult {
  const { sourceHtml, title, metadata } = resolveContentSource(
    html,
    url,
    options
  );

  const markdown = htmlToMarkdown(sourceHtml, metadata);
  const { content, truncated } = truncateContent(
    markdown,
    options.maxContentLength,
    TRUNCATION_MARKER
  );

  return {
    markdown: content,
    title,
    truncated,
  };
}

export function transformHtmlToMarkdownWithBlocks(
  html: string,
  url: string,
  options: ExtractionOptions & ContentLengthOptions
): JsonlTransformResult {
  const { sourceHtml, title, metadata } = resolveContentSource(
    html,
    url,
    options
  );
  const contentBlocks = parseHtml(sourceHtml);
  const { content, truncated } = truncateContent(
    htmlToMarkdown(sourceHtml, metadata),
    options.maxContentLength,
    TRUNCATION_MARKER
  );

  return {
    content,
    contentBlocks: contentBlocks.length,
    title,
    ...(truncated && { truncated }),
  };
}
