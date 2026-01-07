import type {
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

function resolveContentSource(
  html: string,
  url: string,
  options: TransformOptions
): ContentSource {
  const { article, metadata: extractedMeta } = extractContent(html, url, {
    extractArticle: true,
  });

  const hasArticle = determineContentExtractionSource(article);
  const shouldExtractFromArticle =
    hasArticle && isExtractionSufficient(article, html);

  if (hasArticle && !shouldExtractFromArticle) {
    logDebug(
      'Quality gate: Readability extraction below threshold, using full HTML',
      {
        url: url.substring(0, 80),
        articleLength: article.textContent.length,
      }
    );
  }

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

function isRawTextContent(content: string): boolean {
  const trimmed = content.trim();

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

export function transformHtmlToMarkdown(
  html: string,
  url: string,
  options: TransformOptions
): MarkdownTransformResult {
  if (isRawTextContentUrl(url) || isRawTextContent(html)) {
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

  const context = resolveContentSource(html, url, options);
  const content = buildMarkdownPayload(context);

  return {
    markdown: content,
    title: context.title,
    truncated: false,
  };
}
