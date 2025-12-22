import { config } from '../../config/index.js';
import type {
  FetchMarkdownInput,
  MarkdownTransformResult,
  TocEntry,
  ToolResponseBase,
  TransformOptions,
} from '../../config/types.js';

import * as cache from '../../services/cache.js';
import { extractContent } from '../../services/extractor.js';
import { logDebug, logError } from '../../services/logger.js';

import { stripMarkdownLinks } from '../../utils/content-cleaner.js';
import {
  createToolErrorResponse,
  handleToolError,
} from '../../utils/tool-error-handler.js';
import {
  createContentMetadataBlock,
  determineContentExtractionSource,
} from '../utils/common.js';
import { executeFetchPipeline } from '../utils/fetch-pipeline.js';

import { htmlToMarkdown } from '../../transformers/markdown.transformer.js';

export const FETCH_MARKDOWN_TOOL_NAME = 'fetch-markdown';
export const FETCH_MARKDOWN_TOOL_DESCRIPTION =
  'Fetches a webpage and converts it to clean Markdown format with optional frontmatter, table of contents, and content length limits';

function slugify(text: string): string {
  const cleanText = stripMarkdownLinks(text);

  return cleanText
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/--+/g, '-')
    .trim();
}

function extractToc(markdown: string): TocEntry[] {
  const headingRegex = /^(#{1,6})\s+(.+)$/gm;
  const toc: TocEntry[] = [];
  let match;

  while ((match = headingRegex.exec(markdown)) !== null) {
    const hashMarks = match[1];
    const rawText = match[2];

    if (!hashMarks || !rawText) continue;

    const text = stripMarkdownLinks(rawText.trim());
    toc.push({
      level: hashMarks.length,
      text,
      slug: slugify(rawText),
    });
  }

  return toc;
}

function transformToMarkdown(
  html: string,
  url: string,
  options: TransformOptions
): MarkdownTransformResult {
  const { article, metadata: extractedMeta } = extractContent(html, url, {
    extractArticle: options.extractMainContent,
  });

  const shouldExtractFromArticle = determineContentExtractionSource(
    options.extractMainContent,
    article
  );

  const metadata = createContentMetadataBlock(
    url,
    article,
    extractedMeta,
    shouldExtractFromArticle,
    options.includeMetadata
  );

  const sourceHtml = shouldExtractFromArticle ? article.content : html;
  const title = shouldExtractFromArticle ? article.title : extractedMeta.title;

  let markdown = htmlToMarkdown(sourceHtml, metadata);
  const toc = options.generateToc ? extractToc(markdown) : undefined;

  let truncated = false;
  if (options.maxContentLength && markdown.length > options.maxContentLength) {
    markdown = `${markdown.substring(0, options.maxContentLength)}\n\n...[truncated]`;
    truncated = true;
  }

  return { markdown, title, toc, truncated };
}

export async function fetchMarkdownToolHandler(
  input: FetchMarkdownInput
): Promise<ToolResponseBase> {
  if (!input.url) {
    return createToolErrorResponse('URL is required', '', 'VALIDATION_ERROR');
  }

  const options: TransformOptions = {
    extractMainContent: input.extractMainContent ?? true,
    includeMetadata: input.includeMetadata ?? true,
    generateToc: input.generateToc ?? false,
    maxContentLength: input.maxContentLength,
  };

  logDebug('Fetching markdown', { url: input.url, ...options });

  try {
    const result = await executeFetchPipeline<MarkdownTransformResult>({
      url: input.url,
      cacheNamespace: 'markdown',
      customHeaders: input.customHeaders,
      retries: input.retries,
      cacheVary: {
        extractMainContent: options.extractMainContent,
        includeMetadata: options.includeMetadata,
        generateToc: options.generateToc,
        maxContentLength: options.maxContentLength,
      },
      transform: (html, url) => transformToMarkdown(html, url, options),
    });

    const inlineLimit = config.constants.maxInlineContentChars;
    const contentSize = result.data.markdown.length;
    const shouldInline = contentSize <= inlineLimit;
    const resourceMimeType = 'text/markdown';
    const resourceUri =
      !shouldInline && config.cache.enabled && result.cacheKey
        ? cache.toResourceUri(result.cacheKey)
        : undefined;

    if (!shouldInline && !resourceUri) {
      return createToolErrorResponse(
        `Content exceeds inline limit (${inlineLimit} chars) and cannot be cached`,
        input.url,
        'INTERNAL_ERROR'
      );
    }

    const structuredContent = {
      url: result.url,
      title: result.data.title,
      fetchedAt: result.fetchedAt,
      contentSize,
      ...(result.data.toc && { toc: result.data.toc }),
      cached: result.fromCache,
      ...(result.data.truncated && { truncated: result.data.truncated }),
      ...(shouldInline ? { markdown: result.data.markdown } : {}),
      ...(resourceUri && {
        resourceUri,
        resourceMimeType,
      }),
    };

    const jsonOutput = JSON.stringify(
      structuredContent,
      result.fromCache ? undefined : null,
      result.fromCache ? undefined : 2
    );

    return {
      content: [
        { type: 'text' as const, text: jsonOutput },
        ...(resourceUri
          ? [
              {
                type: 'resource_link' as const,
                uri: resourceUri,
                name: 'Fetched markdown',
                mimeType: resourceMimeType,
                description: `Content exceeds inline limit (${inlineLimit} chars)`,
              },
            ]
          : []),
      ],
      structuredContent,
    };
  } catch (error) {
    logError(
      'fetch-markdown tool error',
      error instanceof Error ? error : undefined
    );
    return handleToolError(error, input.url, 'Failed to fetch markdown');
  }
}
