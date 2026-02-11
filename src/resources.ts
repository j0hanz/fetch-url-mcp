import { readFile } from 'node:fs/promises';

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';

import { config } from './config.js';
import { stableStringify } from './json.js';

/* -------------------------------------------------------------------------------------------------
 * Configuration Resource
 * ------------------------------------------------------------------------------------------------- */

const REDACTED = '<REDACTED>' as const;
const CONFIG_RESOURCE_NAME = 'config' as const;
const CONFIG_RESOURCE_URI = 'internal://config' as const;
const JSON_MIME = 'application/json' as const;

function scrubConfig(source: typeof config): typeof config {
  return {
    ...source,
    auth: {
      ...source.auth,
      clientSecret: source.auth.clientSecret ? REDACTED : undefined,
      staticTokens: source.auth.staticTokens.map(() => REDACTED),
    },
    security: {
      ...source.security,
      apiKey: source.security.apiKey ? REDACTED : undefined,
    },
  };
}

export function registerConfigResource(server: McpServer): void {
  server.registerResource(
    CONFIG_RESOURCE_NAME,
    new ResourceTemplate(CONFIG_RESOURCE_URI, { list: undefined }),
    {
      title: 'Server Configuration',
      description: 'Current runtime configuration (secrets redacted)',
      mimeType: JSON_MIME,
    },
    (uri) => {
      const scrubbed = scrubConfig(config);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: JSON_MIME,
            text: stableStringify(scrubbed),
          },
        ],
      };
    }
  );
}

export function registerAgentsResource(server: McpServer): void {
  server.registerResource(
    'agents',
    new ResourceTemplate('internal://agents', { list: undefined }),
    {
      title: 'Agent Instructions',
      description: 'Project context and guidelines for AI agents.',
      mimeType: 'text/markdown',
    },
    async (uri) => {
      try {
        const text = await readFile(
          new URL('./AGENTS.md', import.meta.url),
          'utf-8'
        );
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'text/markdown',
              text,
            },
          ],
        };
      } catch {
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'text/markdown',
              text: 'AGENTS.md unavailable',
            },
          ],
        };
      }
    }
  );
}
