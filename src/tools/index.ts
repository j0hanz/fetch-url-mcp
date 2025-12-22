import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  FETCH_LINKS_TOOL_DESCRIPTION,
  FETCH_LINKS_TOOL_NAME,
  fetchLinksToolHandler,
} from './handlers/fetch-links.tool.js';
import {
  FETCH_MARKDOWN_TOOL_DESCRIPTION,
  FETCH_MARKDOWN_TOOL_NAME,
  fetchMarkdownToolHandler,
} from './handlers/fetch-markdown.tool.js';
import {
  FETCH_URL_TOOL_DESCRIPTION,
  FETCH_URL_TOOL_NAME,
  fetchUrlToolHandler,
} from './handlers/fetch-url.tool.js';
import {
  FETCH_URLS_TOOL_DESCRIPTION,
  FETCH_URLS_TOOL_NAME,
  fetchUrlsToolHandler,
} from './handlers/fetch-urls.tool.js';
import {
  fetchLinksInputSchema,
  fetchLinksOutputSchema,
  fetchMarkdownInputSchema,
  fetchMarkdownOutputSchema,
  fetchUrlInputSchema,
  fetchUrlOutputSchema,
  fetchUrlsInputSchema,
  fetchUrlsOutputSchema,
} from './schemas.js';

const TOOL_DEFINITIONS = [
  {
    name: FETCH_URL_TOOL_NAME,
    title: 'Fetch URL',
    description: FETCH_URL_TOOL_DESCRIPTION,
    inputSchema: fetchUrlInputSchema,
    outputSchema: fetchUrlOutputSchema,
    handler: fetchUrlToolHandler,
  },
  {
    name: FETCH_LINKS_TOOL_NAME,
    title: 'Fetch Links',
    description: FETCH_LINKS_TOOL_DESCRIPTION,
    inputSchema: fetchLinksInputSchema,
    outputSchema: fetchLinksOutputSchema,
    handler: fetchLinksToolHandler,
  },
  {
    name: FETCH_MARKDOWN_TOOL_NAME,
    title: 'Fetch Markdown',
    description: FETCH_MARKDOWN_TOOL_DESCRIPTION,
    inputSchema: fetchMarkdownInputSchema,
    outputSchema: fetchMarkdownOutputSchema,
    handler: fetchMarkdownToolHandler,
  },
  {
    name: FETCH_URLS_TOOL_NAME,
    title: 'Fetch URLs (Batch)',
    description: FETCH_URLS_TOOL_DESCRIPTION,
    inputSchema: fetchUrlsInputSchema,
    outputSchema: fetchUrlsOutputSchema,
    handler: fetchUrlsToolHandler,
  },
] as const;

export function registerTools(server: McpServer): void {
  for (const tool of TOOL_DEFINITIONS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
      },
      tool.handler
    );
  }
}
