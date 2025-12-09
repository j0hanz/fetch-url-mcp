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

// Zod schemas for runtime validation - single source of truth
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
  customHeaders: z
    .record(z.string())
    .optional()
    .describe('Custom HTTP headers for the request'),
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
};

/**
 * Registers all tools with the MCP server using the modern McpServer API
 * Tools are registered with Zod schemas for automatic validation
 */
export function registerTools(server: McpServer): void {
  // Register fetch-url tool
  server.registerTool(
    FETCH_URL_TOOL_NAME,
    {
      title: 'Fetch URL',
      description: FETCH_URL_TOOL_DESCRIPTION,
      inputSchema: FetchUrlInputSchema,
    },
    async (args) => fetchUrlToolHandler(args)
  );

  // Register fetch-links tool
  server.registerTool(
    FETCH_LINKS_TOOL_NAME,
    {
      title: 'Fetch Links',
      description: FETCH_LINKS_TOOL_DESCRIPTION,
      inputSchema: FetchLinksInputSchema,
    },
    async (args) => fetchLinksToolHandler(args)
  );

  // Register fetch-markdown tool
  server.registerTool(
    FETCH_MARKDOWN_TOOL_NAME,
    {
      title: 'Fetch Markdown',
      description: FETCH_MARKDOWN_TOOL_DESCRIPTION,
      inputSchema: FetchMarkdownInputSchema,
    },
    async (args) => fetchMarkdownToolHandler(args)
  );
}
