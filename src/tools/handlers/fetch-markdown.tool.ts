import { extractContent } from '../../services/extractor.js';
import { htmlToMarkdown } from '../../transformers/markdown.transformer.js';
import { config } from '../../config/index.js';
import { logDebug, logError } from '../../services/logger.js';
import {
  createToolErrorResponse,
  handleToolError,
} from '../../utils/tool-error-handler.js';
import { executeFetchPipeline } from '../utils/fetch-pipeline.js';
import type { FetchMarkdownInput } from '../../types/index.js';

export const FETCH_MARKDOWN_TOOL_NAME = 'fetch-markdown';
export const FETCH_MARKDOWN_TOOL_DESCRIPTION =
  'Fetches a webpage and converts it to clean Markdown format with optional frontmatter, table of contents, and content length limits';

interface TocEntry {
  level: number;
  text: string;
  slug: string;
}

interface MarkdownTransformResult {
  markdown: string;
  title: string | undefined;
  toc: TocEntry[] | undefined;
  truncated: boolean;
}

interface TransformOptions {
  extractMainContent: boolean;
  includeMetadata: boolean;
  generateToc: boolean;
  maxContentLength?: number | undefined;
}

/**
 * Generates a URL-friendly slug from text
 */
function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/--+/g, '-')
    .trim();
}

/**
 * Extracts table of contents from markdown
 */
function extractToc(markdown: string): TocEntry[] {
  const toc: TocEntry[] = [];
  const headingRegex = /^(#{1,6})\s+(.+)$/gm;
  let match;

  while ((match = headingRegex.exec(markdown)) !== null) {
    const levelMatch = match[1];
    const textMatch = match[2];
    if (!levelMatch || !textMatch) continue;
    const level = levelMatch.length;
    const text = textMatch.trim();
    toc.push({
      level,
      text,
      slug: slugify(text),
    });
  }

  return toc;
}

/**
 * Transforms HTML to clean Markdown with optional frontmatter
 */
function transformToMarkdown(
  html: string,
  url: string,
  options: TransformOptions
): MarkdownTransformResult {
  const { article, metadata: extractedMeta } = extractContent(html, url);

  let markdown: string;
  let title: string | undefined;

  if (
    options.extractMainContent &&
    config.extraction.extractMainContent &&
    article
  ) {
    const metadata =
      options.includeMetadata && config.extraction.includeMetadata
        ? {
            type: 'metadata' as const,
            title: article.title,
            author: article.byline,
            url,
            fetchedAt: new Date().toISOString(),
          }
        : undefined;

    markdown = htmlToMarkdown(article.content, metadata);
    title = article.title;
  } else {
    const metadata =
      options.includeMetadata && config.extraction.includeMetadata
        ? {
            type: 'metadata' as const,
            title: extractedMeta.title,
            description: extractedMeta.description,
            author: extractedMeta.author,
            url,
            fetchedAt: new Date().toISOString(),
          }
        : undefined;

    markdown = htmlToMarkdown(html, metadata);
    title = extractedMeta.title;
  }

  // Generate TOC if requested
  const toc = options.generateToc ? extractToc(markdown) : undefined;

  // Apply max content length truncation
  let truncated = false;
  if (options.maxContentLength && markdown.length > options.maxContentLength) {
    markdown =
      markdown.substring(0, options.maxContentLength) + '\n\n...[truncated]';
    truncated = true;
  }

  return {
    markdown,
    title,
    toc,
    truncated,
  };
}

export async function fetchMarkdownToolHandler(input: FetchMarkdownInput) {
  try {
    if (!input.url) {
      return createToolErrorResponse('URL is required', '', 'VALIDATION_ERROR');
    }

    const extractMainContent = input.extractMainContent ?? true;
    const includeMetadata = input.includeMetadata ?? true;
    const generateToc = input.generateToc ?? false;
    const maxContentLength = input.maxContentLength;

    logDebug('Fetching markdown', {
      url: input.url,
      extractMainContent,
      includeMetadata,
      generateToc,
      maxContentLength,
    });

    const result = await executeFetchPipeline<MarkdownTransformResult>({
      url: input.url,
      cacheNamespace: 'markdown',
      customHeaders: input.customHeaders,
      retries: input.retries,
      transform: (html, url) =>
        transformToMarkdown(html, url, {
          extractMainContent,
          includeMetadata,
          generateToc,
          maxContentLength,
        }),
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
          text: result.fromCache
            ? JSON.stringify(structuredContent)
            : JSON.stringify(structuredContent, null, 2),
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
