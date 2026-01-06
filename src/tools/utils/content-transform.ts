import type {
  ContentBlockUnion,
  JsonlTransformResult,
  MarkdownTransformResult,
} from '../../config/types/content.js';

import { extractContent } from '../../services/extractor.js';
import { parseHtml, parseHtmlWithMetadata } from '../../services/parser.js';

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

export function transformHtmlToJsonl(
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
  options: MarkdownWithBlocksOptions
): JsonlTransformResult {
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
