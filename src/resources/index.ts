import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { config } from '../config/index.js';

import * as cache from '../services/cache.js';

import {
  registerCachedContentResource,
  setupCacheSubscriptions,
} from './cached-content.js';

export function registerResources(server: McpServer): void {
  // Register dynamic cached content resources
  registerCachedContentResource(server);

  // Setup cache update subscriptions
  setupCacheSubscriptions();

  // Register health check resource
  server.registerResource(
    'health',
    'superfetch://health',
    {
      title: 'Server Health',
      description: 'Real-time server health and dependency status',
      mimeType: 'application/json',
    },
    (uri) => {
      const memUsage = process.memoryUsage();
      const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
      const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);

      const health = {
        status: 'healthy',
        uptime: process.uptime(),
        checks: {
          cache: config.cache.enabled,
          memory: {
            heapUsed: heapUsedMB,
            heapTotal: heapTotalMB,
            percentage: Math.round((heapUsedMB / heapTotalMB) * 100),
            healthy: heapUsedMB < 400, // Flag if using > 400MB
          },
        },
        timestamp: new Date().toISOString(),
      };

      return {
        contents: [
          {
            uri: uri.href,
            mimeType: 'application/json',
            text: JSON.stringify(health, null, 2),
          },
        ],
      };
    }
  );

  // Register server statistics resource
  server.registerResource(
    'stats',
    'superfetch://stats',
    {
      title: 'Server Statistics',
      description: 'Fetch statistics and cache performance metrics',
      mimeType: 'application/json',
    },
    (uri) => {
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
