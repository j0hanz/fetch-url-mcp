import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import * as cache from '../services/cache.js';
import { config } from '../config/index.js';

export function registerResources(server: McpServer): void {
  // Register server statistics resource
  server.registerResource(
    'stats',
    'superfetch://stats',
    {
      title: 'Server Statistics',
      description: 'Fetch statistics and cache performance metrics',
      mimeType: 'application/json',
    },
    async (uri) => {
      const stats = {
        server: {
          name: config.server.name,
          version: config.server.version,
          uptime: process.uptime(),
          nodeVersion: process.version,
          memoryUsage: process.memoryUsage(),
        },
        cache: cache.getStats(),
        config: {
          fetcher: {
            timeout: config.fetcher.timeout,
            maxRedirects: config.fetcher.maxRedirects,
          },
          extraction: {
            extractMainContent: config.extraction.extractMainContent,
            includeMetadata: config.extraction.includeMetadata,
          },
        },
      };

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(stats, null, 2),
          },
        ],
      };
    }
  );
}
