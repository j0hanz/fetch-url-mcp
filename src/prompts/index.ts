import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js';

interface IconInfo {
  src: string;
  mimeType: string;
}

function buildOptionalPromptIcons(
  iconInfo?: IconInfo
): { icons: IconInfo[] } | Record<string, never> {
  return iconInfo
    ? {
        icons: [
          {
            src: iconInfo.src,
            mimeType: iconInfo.mimeType,
          },
        ],
      }
    : {};
}

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
      ...buildOptionalPromptIcons(iconInfo),
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
