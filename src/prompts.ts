import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { FETCH_URL_TOOL_NAME } from './tools.js';

export function registerPrompts(server: McpServer, instructions: string): void {
  // Get Help Prompt
  server.registerPrompt(
    'get-help',
    {
      title: 'Get Help',
      description: 'Returns usage guidance for the superFetch MCP server.',
    },
    () => ({
      description: 'superFetch MCP usage guidance',
      messages: [
        {
          role: 'assistant',
          content: {
            type: 'text',
            text: instructions,
          },
        },
      ],
    })
  );

  // Summarize Page Prompt
  server.registerPrompt(
    'summarize-page',
    {
      title: 'Summarize Page',
      description: 'Creates a prompt to fetch and summarize a webpage.',
      argsSchema: {
        url: z.url().describe('The URL of the webpage to summarize'),
      },
    },
    (args) => {
      const { url } = args;
      return {
        description: `Summarize content from ${url}`,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Please fetch the content from ${url} using the ${FETCH_URL_TOOL_NAME} tool and provide a concise summary of the main points.`,
            },
          },
        ],
      };
    }
  );

  // Extract Data Prompt
  server.registerPrompt(
    'extract-data',
    {
      title: 'Extract Data',
      description:
        'Creates a prompt to fetch a webpage and extract specific data.',
      argsSchema: {
        url: z.url().describe('The URL of the webpage to extract data from'),
        instruction: z
          .string()
          .describe(
            'Description of the data to extract (e.g., "all pricing tiers")'
          ),
      },
    },
    (args) => {
      const { url, instruction } = args;
      return {
        description: `Extract data from ${url}`,
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Please fetch the content from ${url} using the ${FETCH_URL_TOOL_NAME} tool and extract the following information: ${instruction}.`,
            },
          },
        ],
      };
    }
  );
}
