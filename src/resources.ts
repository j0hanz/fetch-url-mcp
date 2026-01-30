import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';

import { config } from './config.js';
import { stableStringify } from './json.js';

/* -------------------------------------------------------------------------------------------------
 * Configuration Resource
 * ------------------------------------------------------------------------------------------------- */

function scrubAuth(auth: typeof config.auth): typeof config.auth {
  return {
    ...auth,
    clientSecret: auth.clientSecret ? '<REDACTED>' : undefined,
    staticTokens: auth.staticTokens.map(() => '<REDACTED>'),
  };
}

function scrubSecurity(
  security: typeof config.security
): typeof config.security {
  return {
    ...security,
    apiKey: security.apiKey ? '<REDACTED>' : undefined,
  };
}

function scrubConfig(source: typeof config): typeof config {
  return {
    ...source,
    auth: scrubAuth(source.auth),
    security: scrubSecurity(source.security),
  };
}

export function registerConfigResource(server: McpServer): void {
  server.registerResource(
    'config',
    new ResourceTemplate('internal://config', { list: undefined }),
    {
      title: 'Server Configuration',
      description: 'Current runtime configuration (secrets redacted)',
      mimeType: 'application/json',
    },
    (uri) => {
      const scrubbed = scrubConfig(config);
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: stableStringify(scrubbed),
          },
        ],
      };
    }
  );
}
