import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { GetPromptResult } from '@modelcontextprotocol/sdk/types.js';

interface IconInfo {
  src: string;
  mimeType: string;
}

function buildOptionalPromptIcons(
  iconInfo?: IconInfo
): { icons: IconInfo[] } | Record<string, never> {
  if (!iconInfo) return {};
  return {
    icons: [
      {
        src: iconInfo.src,
        mimeType: iconInfo.mimeType,
      },
    ],
  };
}

export function registerGetHelpPrompt(
  server: McpServer,
  instructions: string,
  iconInfo?: IconInfo
): void {
  const description =
    'Return Fetch URL server instructions: how to fetch URLs, handle truncated content, recover full content via cacheResourceUri, use task mode for long pages, and route errors by code.';

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
          role: 'user',
          content: {
            type: 'text',
            text: instructions,
          },
        },
      ],
    })
  );
}
