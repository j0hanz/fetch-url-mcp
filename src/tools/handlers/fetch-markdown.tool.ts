import type {
  FetchMarkdownInput,
  MarkdownTransformResult,
  TocEntry,
  TransformOptions,
} from '../../config/types.js';

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

/**
 * Generate URL-friendly slug from text
 * Strips markdown link syntax before slugifying
 */
function slugify(text: string): string {
  // First strip markdown links: [Text](#anchor) -> Text
  const cleanText = stripMarkdownLinks(text);

  return cleanText
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/--+/g, '-')
    .trim();
}

/**
 * Extract table of contents from markdown headings
 * Returns clean text without markdown link syntax
 */
function extractToc(markdown: string): TocEntry[] {
  const headingRegex = /^(#{1,6})\s+(.+)$/gm;
  const toc: TocEntry[] = [];
  let match;

  while ((match = headingRegex.exec(markdown)) !== null) {
    if (!match[1] || !match[2]) continue;
    const rawText = match[2].trim();
    // Clean markdown links from TOC text: [Usage](#usage) -> Usage
    const text = stripMarkdownLinks(rawText);
    toc.push({ level: match[1].length, text, slug: slugify(rawText) });
  }

  return toc;
}

function transformToMarkdown(
  html: string,
  url: string,
  options: TransformOptions
): MarkdownTransformResult {
  // Only invoke JSDOM when extractMainContent is true (lazy loading optimization)
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
): Promise<{
  content: { type: 'text'; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}> {
  if (!input.url) {
    return createToolErrorResponse('URL is required', '', 'VALIDATION_ERROR');
  }

  try {
    const options: TransformOptions = {
      extractMainContent: input.extractMainContent ?? true,
      includeMetadata: input.includeMetadata ?? true,
      generateToc: input.generateToc ?? false,
      maxContentLength: input.maxContentLength,
    };

    logDebug('Fetching markdown', { url: input.url, ...options });

    const result = await executeFetchPipeline<MarkdownTransformResult>({
      url: input.url,
      cacheNamespace: 'markdown',
      customHeaders: input.customHeaders,
      retries: input.retries,
      transform: (html, url) => transformToMarkdown(html, url, options),
      serialize: (data) => data.markdown,
      deserialize: (cached) => ({
        markdown: cached,
        title: undefined,
        toc: undefined,
        truncated: false,
      }),
    });

    const structuredContent = {
      url: result.url,
      title: result.data.title,
      fetchedAt: result.fetchedAt,
      markdown: result.data.markdown,
      ...(result.data.toc && { toc: result.data.toc }),
      cached: result.fromCache,
      ...(result.data.truncated && { truncated: result.data.truncated }),
    };

    return {
      content: [
        {
          type: 'text' as const,
          text: JSON.stringify(
            structuredContent,
            result.fromCache ? undefined : null,
            result.fromCache ? undefined : 2
          ),
        },
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
