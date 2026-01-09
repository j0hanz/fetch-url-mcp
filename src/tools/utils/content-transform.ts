import type {
  ExtractedArticle,
  ExtractedMetadata,
  MarkdownTransformResult,
  TransformOptions,
} from '../../config/types/content.js';

import { extractContent } from '../../services/extractor.js';
import { logDebug } from '../../services/logger.js';

import { isRawTextContentUrl } from '../../utils/url-transformer.js';

import { htmlToMarkdown } from '../../transformers/markdown.transformer.js';

import {
  createContentMetadataBlock,
  determineContentExtractionSource,
  isExtractionSufficient,
} from './content-shaping.js';
import {
  addSourceToMarkdown,
  extractTitleFromRawMarkdown,
  hasFrontmatter,
} from './frontmatter.js';
import { looksLikeMarkdown } from './markdown-heuristics.js';

interface ContentSource {
  readonly sourceHtml: string;
  readonly title: string | undefined;
  readonly metadata: ReturnType<typeof createContentMetadataBlock>;
}

function buildArticleContentSource(
  url: string,
  article: ExtractedArticle,
  extractedMeta: ExtractedMetadata,
  includeMetadata: boolean
): ContentSource {
  const metadata = createContentMetadataBlock(
    url,
    article,
    extractedMeta,
    true,
    includeMetadata
  );

  return {
    sourceHtml: article.content,
    title: article.title,
    metadata,
  };
}

function buildFullHtmlContentSource(
  html: string,
  url: string,
  article: ExtractedArticle | null,
  extractedMeta: ExtractedMetadata,
  includeMetadata: boolean
): ContentSource {
  const metadata = createContentMetadataBlock(
    url,
    article,
    extractedMeta,
    false,
    includeMetadata
  );

  return {
    sourceHtml: html,
    title: extractedMeta.title,
    metadata,
  };
}

function logQualityGateFallback(
  url: string,
  article: { textContent: string }
): void {
  logDebug(
    'Quality gate: Readability extraction below threshold, using full HTML',
    {
      url: url.substring(0, 80),
      articleLength: article.textContent.length,
    }
  );
}

function tryBuildExtractedArticleContentSource(
  html: string,
  url: string,
  article: ExtractedArticle | null,
  extractedMeta: ExtractedMetadata,
  options: TransformOptions
): ContentSource | null {
  if (!article) return null;

  const shouldExtractFromArticle = determineContentExtractionSource(article);
  if (shouldExtractFromArticle && isExtractionSufficient(article, html)) {
    return buildArticleContentSource(
      url,
      article,
      extractedMeta,
      options.includeMetadata
    );
  }

  if (shouldExtractFromArticle) {
    logQualityGateFallback(url, article);
  }

  return null;
}

function resolveContentSource(
  html: string,
  url: string,
  options: TransformOptions
): ContentSource {
  const { article, metadata: extractedMeta } = extractContent(html, url, {
    extractArticle: true,
  });

  const extracted = tryBuildExtractedArticleContentSource(
    html,
    url,
    article,
    extractedMeta,
    options
  );
  if (extracted) return extracted;

  return buildFullHtmlContentSource(
    html,
    url,
    article,
    extractedMeta,
    options.includeMetadata
  );
}

function buildMarkdownPayload(context: ContentSource): string {
  return htmlToMarkdown(context.sourceHtml, context.metadata);
}

function buildRawMarkdownPayload(
  rawContent: string,
  url: string,
  includeMetadata: boolean
): { content: string; title: string | undefined } {
  const title = extractTitleFromRawMarkdown(rawContent);
  const content = includeMetadata
    ? addSourceToMarkdown(rawContent, url)
    : rawContent;

  return { content, title };
}

const HTML_DOCUMENT_PATTERN = /^(<!doctype|<html)/i;

function looksLikeHtmlDocument(trimmed: string): boolean {
  return HTML_DOCUMENT_PATTERN.test(trimmed);
}

function countCommonHtmlTags(content: string): number {
  const matches =
    content.match(/<(html|head|body|div|span|script|style|meta|link)\b/gi) ??
    [];
  return matches.length;
}

function isRawTextContent(content: string): boolean {
  const trimmed = content.trim();
  const isHtmlDocument = looksLikeHtmlDocument(trimmed);
  const hasMarkdownFrontmatter = hasFrontmatter(trimmed);
  const hasTooManyHtmlTags = countCommonHtmlTags(content) > 2;
  const isMarkdown = looksLikeMarkdown(content);

  return (
    !isHtmlDocument &&
    (hasMarkdownFrontmatter || (!hasTooManyHtmlTags && isMarkdown))
  );
}

function tryTransformRawContent(
  html: string,
  url: string,
  options: TransformOptions
): MarkdownTransformResult | null {
  if (!isRawTextContentUrl(url) && !isRawTextContent(html)) {
    return null;
  }

  logDebug('Preserving raw markdown content', { url: url.substring(0, 80) });
  const { content, title } = buildRawMarkdownPayload(
    html,
    url,
    options.includeMetadata
  );
  return {
    markdown: content,
    title,
    truncated: false,
  };
}

export function transformHtmlToMarkdown(
  html: string,
  url: string,
  options: TransformOptions
): MarkdownTransformResult {
  const raw = tryTransformRawContent(html, url, options);
  if (raw) return raw;

  const context = resolveContentSource(html, url, options);
  const content = buildMarkdownPayload(context);

  return {
    markdown: content,
    title: context.title,
    truncated: false,
  };
}
