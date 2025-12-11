import { z } from 'zod';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

export function registerPrompts(server: McpServer): void {
  // Register analyze-web-content prompt
  server.registerPrompt(
    'analyze-web-content',
    {
      title: 'Analyze Web Content',
      description: 'Analyze fetched web content with optional focus area',
      argsSchema: {
        url: z.string().min(1).describe('URL of the content to analyze'),
        focus: z
          .string()
          .optional()
          .describe(
            'Specific aspect to focus on (e.g., "technical details", "pricing")'
          ),
      },
    },
    ({ url, focus }) => {
      const focusText = focus ? ` with focus on ${focus}` : '';

      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Please fetch and analyze the content from ${url}${focusText}. Use the fetch-url tool to retrieve the content first, then provide your analysis.`,
            },
          },
        ],
      };
    }
  );

  // Register summarize-page prompt
  server.registerPrompt(
    'summarize-page',
    {
      title: 'Summarize Page',
      description: 'Fetch and summarize a web page concisely',
      argsSchema: {
        url: z.string().min(1).describe('URL of the page to summarize'),
        maxLength: z
          .number()
          .positive()
          .optional()
          .describe('Maximum summary length in words'),
      },
    },
    ({ url, maxLength }) => {
      const lengthConstraint = maxLength
        ? ` Keep the summary under ${maxLength} words.`
        : '';

      return {
        messages: [
          {
            role: 'user',
            content: {
              type: 'text',
              text: `Please fetch the content from ${url} using the fetch-url tool, then provide a concise summary of the main points.${lengthConstraint}`,
            },
          },
        ],
      };
    }
  );

  // Register extract-data prompt
  server.registerPrompt(
    'extract-data',
    {
      title: 'Extract Structured Data',
      description: 'Extract specific structured data from a web page',
      argsSchema: {
        url: z.string().min(1).describe('URL of the page to extract data from'),
        dataType: z
          .string()
          .describe(
            'Type of data to extract (e.g., "contact info", "product details", "article metadata")'
          ),
      },
    },
    ({ url, dataType }) => ({
      messages: [
        {
          role: 'user',
          content: {
            type: 'text',
            text: `Please fetch the content from ${url} using the fetch-url tool, then extract and structure the ${dataType} found on the page. Present the extracted data in a clear, organized format.`,
          },
        },
      ],
    })
  );
}
