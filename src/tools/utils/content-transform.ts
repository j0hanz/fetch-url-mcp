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

function looksLikeHtmlDocument(trimmed: string): boolean {
  return (
    trimmed.startsWith('<!DOCTYPE') ||
    trimmed.startsWith('<!doctype') ||
    trimmed.startsWith('<html') ||
    trimmed.startsWith('<HTML')
  );
}

function hasFrontmatter(trimmed: string): boolean {
  return /^---\r?\n/.test(trimmed);
}

function countCommonHtmlTags(content: string): number {
  const matches =
    content.match(/<(html|head|body|div|span|script|style|meta|link)\b/gi) ??
    [];
  return matches.length;
}

function looksLikeMarkdown(content: string): boolean {
  const hasMarkdownHeadings = /^#{1,6}\s+/m.test(content);
  const hasMarkdownLists = /^[\s]*[-*+]\s+/m.test(content);
  const hasMarkdownCodeBlocks = /```[\s\S]*?```/.test(content);
  return hasMarkdownHeadings || hasMarkdownLists || hasMarkdownCodeBlocks;
}

function isRawTextContent(content: string): boolean {
  const trimmed = content.trim();

  if (looksLikeHtmlDocument(trimmed)) {
    return false;
  }

  if (hasFrontmatter(trimmed)) {
    return true;
  }
  if (countCommonHtmlTags(content) > 2) {
    return false;
  }
  if (looksLikeMarkdown(content)) {
    return true;
  }

  return false;
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
