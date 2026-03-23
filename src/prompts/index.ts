import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js';

import { buildOptionalIcons, type IconInfo } from '../lib/utils.js';

export function registerGetHelpPrompt(
  server: McpServer,
  instructions: string,
  iconInfo?: IconInfo
): void {
  const description =
    'Return Fetch URL server instructions: workflows, cache usage, task mode, and error handling.';

  server.registerPrompt(
    'get-help',
    {
      title: 'Get Help',
      description,
      ...buildOptionalIcons(iconInfo),
    },
    (): GetPromptResult => ({
      description,
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
}
