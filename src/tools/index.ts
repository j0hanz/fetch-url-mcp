import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';

import {
  createFetchMarkdownToolHandler,
  FETCH_MARKDOWN_TOOL_DESCRIPTION,
  FETCH_MARKDOWN_TOOL_NAME,
} from './handlers/fetch-markdown.tool.js';
import {
  FETCH_URL_TOOL_DESCRIPTION,
  FETCH_URL_TOOL_NAME,
  fetchUrlToolHandler,
} from './handlers/fetch-url.tool.js';
import {
  fetchMarkdownInputSchema,
  fetchMarkdownOutputSchema,
  fetchUrlInputSchema,
  fetchUrlOutputSchema,
} from './schemas.js';

const fetchMarkdownToolHandler = createFetchMarkdownToolHandler();

const TOOL_DEFINITIONS: readonly {
  name: string;
  title: string;
  description: string;
  inputSchema: typeof fetchUrlInputSchema | typeof fetchMarkdownInputSchema;
  outputSchema: typeof fetchUrlOutputSchema | typeof fetchMarkdownOutputSchema;
  handler: typeof fetchUrlToolHandler | typeof fetchMarkdownToolHandler;
  annotations: ToolAnnotations;
}[] = [
  {
    name: FETCH_URL_TOOL_NAME,
    title: 'Fetch URL',
    description: FETCH_URL_TOOL_DESCRIPTION,
    inputSchema: fetchUrlInputSchema,
    outputSchema: fetchUrlOutputSchema,
    handler: fetchUrlToolHandler,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
  {
    name: FETCH_MARKDOWN_TOOL_NAME,
    title: 'Fetch Markdown',
    description: FETCH_MARKDOWN_TOOL_DESCRIPTION,
    inputSchema: fetchMarkdownInputSchema,
    outputSchema: fetchMarkdownOutputSchema,
    handler: fetchMarkdownToolHandler,
    annotations: {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    },
  },
];

export function registerTools(server: McpServer): void {
  for (const tool of TOOL_DEFINITIONS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: tool.annotations,
      },
      tool.handler
    );
  }
}
