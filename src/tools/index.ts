import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  fetchUrlToolHandler,
  FETCH_URL_TOOL_NAME,
  FETCH_URL_TOOL_DESCRIPTION,
} from './handlers/fetch-url.tool.js';
import {
  fetchLinksToolHandler,
  FETCH_LINKS_TOOL_NAME,
  FETCH_LINKS_TOOL_DESCRIPTION,
} from './handlers/fetch-links.tool.js';
import {
  fetchMarkdownToolHandler,
  FETCH_MARKDOWN_TOOL_NAME,
  FETCH_MARKDOWN_TOOL_DESCRIPTION,
} from './handlers/fetch-markdown.tool.js';
import {
  fetchUrlsToolHandler,
  FETCH_URLS_TOOL_NAME,
  FETCH_URLS_TOOL_DESCRIPTION,
} from './handlers/fetch-urls.tool.js';

// Zod schemas for runtime validation - single source of truth

// Common request options shared across tools
const RequestOptionsSchema = {
  customHeaders: z
    .record(z.string())
    .optional()
    .describe('Custom HTTP headers for the request'),
  timeout: z
    .number()
    .min(1000)
    .max(60000)
    .optional()
    .describe('Request timeout in milliseconds (1000-60000)'),
  retries: z
    .number()
    .min(1)
    .max(10)
    .optional()
    .describe('Number of retry attempts (1-10)'),
};

// Input schemas
const FetchUrlInputSchema = {
  url: z.string().min(1).describe('The URL to fetch'),
  extractMainContent: z
    .boolean()
    .optional()
    .default(true)
    .describe('Use Readability to extract main article content'),
  includeMetadata: z
    .boolean()
    .optional()
    .default(true)
    .describe('Include page metadata (title, description, etc.)'),
  maxContentLength: z
    .number()
    .positive()
    .optional()
    .describe('Maximum content length in characters'),
  format: z
    .enum(['jsonl', 'markdown'])
    .optional()
    .default('jsonl')
    .describe('Output format'),
  ...RequestOptionsSchema,
};

const FetchLinksInputSchema = {
  url: z.string().min(1).describe('The URL to extract links from'),
  includeExternal: z
    .boolean()
    .optional()
    .default(true)
    .describe('Include external links'),
  includeInternal: z
    .boolean()
    .optional()
    .default(true)
    .describe('Include internal links'),
  maxLinks: z
    .number()
    .positive()
    .max(1000)
    .optional()
    .describe('Maximum number of links to return (1-1000)'),
  filterPattern: z
    .string()
    .optional()
    .describe('Regex pattern to filter links (matches against href)'),
  includeImages: z
    .boolean()
    .optional()
    .default(false)
    .describe('Include image links (img src attributes)'),
  ...RequestOptionsSchema,
};

const FetchMarkdownInputSchema = {
  url: z.string().min(1).describe('The URL to fetch'),
  extractMainContent: z
    .boolean()
    .optional()
    .default(true)
    .describe('Extract main article content using Readability'),
  includeMetadata: z
    .boolean()
    .optional()
    .default(true)
    .describe('Include YAML frontmatter metadata'),
  maxContentLength: z
    .number()
    .positive()
    .optional()
    .describe('Maximum content length in characters'),
  generateToc: z
    .boolean()
    .optional()
    .default(false)
    .describe('Generate table of contents from headings'),
  ...RequestOptionsSchema,
};

const FetchUrlsInputSchema = {
  urls: z
    .array(z.string().min(1))
    .min(1)
    .max(10)
    .describe('Array of URLs to fetch (1-10 URLs)'),
  extractMainContent: z
    .boolean()
    .optional()
    .default(true)
    .describe('Use Readability to extract main article content'),
  includeMetadata: z
    .boolean()
    .optional()
    .default(true)
    .describe('Include page metadata (title, description, etc.)'),
  maxContentLength: z
    .number()
    .positive()
    .optional()
    .describe('Maximum content length per URL in characters'),
  format: z
    .enum(['jsonl', 'markdown'])
    .optional()
    .default('jsonl')
    .describe('Output format for all URLs'),
  concurrency: z
    .number()
    .min(1)
    .max(5)
    .optional()
    .default(3)
    .describe('Maximum concurrent requests (1-5)'),
  continueOnError: z
    .boolean()
    .optional()
    .default(true)
    .describe('Continue processing if some URLs fail'),
  ...RequestOptionsSchema,
};

// Output schemas for structured content validation
const FetchUrlOutputSchema = {
  url: z.string().describe('The fetched URL'),
  title: z.string().optional().describe('Page title'),
  contentBlocks: z.number().describe('Number of content blocks extracted'),
  fetchedAt: z
    .string()
    .describe('ISO timestamp of when the content was fetched'),
  format: z.enum(['jsonl', 'markdown']).describe('Output format used'),
  content: z.string().describe('The extracted content in JSONL format'),
  cached: z.boolean().describe('Whether the result was served from cache'),
  error: z.string().optional().describe('Error message if the request failed'),
  errorCode: z.string().optional().describe('Error code if the request failed'),
};

const FetchLinksOutputSchema = {
  url: z.string().describe('The source URL'),
  linkCount: z.number().describe('Total number of links extracted'),
  links: z
    .array(
      z.object({
        href: z.string().describe('The link URL'),
        text: z.string().describe('The link anchor text'),
        type: z.enum(['internal', 'external', 'image']).describe('Link type'),
      })
    )
    .describe('Array of extracted links'),
  filtered: z
    .number()
    .optional()
    .describe('Number of links filtered out by pattern'),
  truncated: z
    .boolean()
    .optional()
    .describe('Whether results were truncated by maxLinks'),
  error: z.string().optional().describe('Error message if the request failed'),
  errorCode: z.string().optional().describe('Error code if the request failed'),
};

const FetchMarkdownOutputSchema = {
  url: z.string().describe('The fetched URL'),
  title: z.string().optional().describe('Page title'),
  fetchedAt: z
    .string()
    .describe('ISO timestamp of when the content was fetched'),
  markdown: z.string().describe('The extracted content in Markdown format'),
  toc: z
    .array(
      z.object({
        level: z.number().describe('Heading level (1-6)'),
        text: z.string().describe('Heading text'),
        slug: z.string().describe('URL-friendly anchor slug'),
      })
    )
    .optional()
    .describe('Table of contents (if generateToc is true)'),
  cached: z.boolean().describe('Whether the result was served from cache'),
  truncated: z
    .boolean()
    .optional()
    .describe('Whether content was truncated by maxContentLength'),
  error: z.string().optional().describe('Error message if the request failed'),
  errorCode: z.string().optional().describe('Error code if the request failed'),
};

const FetchUrlsOutputSchema = {
  results: z
    .array(
      z.object({
        url: z.string().describe('The fetched URL'),
        success: z.boolean().describe('Whether the fetch was successful'),
        title: z.string().optional().describe('Page title'),
        content: z.string().optional().describe('The extracted content'),
        contentBlocks: z
          .number()
          .optional()
          .describe('Number of content blocks (JSONL only)'),
        cached: z.boolean().optional().describe('Whether served from cache'),
        error: z.string().optional().describe('Error message if failed'),
        errorCode: z.string().optional().describe('Error code if failed'),
      })
    )
    .describe('Array of results for each URL'),
  summary: z
    .object({
      total: z.number().describe('Total URLs processed'),
      successful: z.number().describe('Number of successful fetches'),
      failed: z.number().describe('Number of failed fetches'),
      cached: z.number().describe('Number served from cache'),
      totalContentBlocks: z.number().describe('Total content blocks extracted'),
    })
    .describe('Summary statistics'),
  fetchedAt: z.string().describe('ISO timestamp of batch completion'),
};

export function registerTools(server: McpServer): void {
  server.registerTool(
    FETCH_URL_TOOL_NAME,
    {
      title: 'Fetch URL',
      description: FETCH_URL_TOOL_DESCRIPTION,
      inputSchema: FetchUrlInputSchema,
      outputSchema: FetchUrlOutputSchema,
    },
    async (args) => fetchUrlToolHandler(args)
  );

  server.registerTool(
    FETCH_LINKS_TOOL_NAME,
    {
      title: 'Fetch Links',
      description: FETCH_LINKS_TOOL_DESCRIPTION,
      inputSchema: FetchLinksInputSchema,
      outputSchema: FetchLinksOutputSchema,
    },
    async (args) => fetchLinksToolHandler(args)
  );

  server.registerTool(
    FETCH_MARKDOWN_TOOL_NAME,
    {
      title: 'Fetch Markdown',
      description: FETCH_MARKDOWN_TOOL_DESCRIPTION,
      inputSchema: FetchMarkdownInputSchema,
      outputSchema: FetchMarkdownOutputSchema,
    },
    async (args) => fetchMarkdownToolHandler(args)
  );

  server.registerTool(
    FETCH_URLS_TOOL_NAME,
    {
      title: 'Fetch URLs (Batch)',
      description: FETCH_URLS_TOOL_DESCRIPTION,
      inputSchema: FetchUrlsInputSchema,
      outputSchema: FetchUrlsOutputSchema,
    },
    async (args) => fetchUrlsToolHandler(args)
  );
}
