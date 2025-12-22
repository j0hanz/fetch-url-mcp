import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { config } from '../config/index.js';

import * as cache from '../services/cache.js';

import { registerCachedContentResource } from './cached-content.js';

interface JsonResourceDefinition {
  name: string;
  uri: string;
  title: string;
  description: string;
  buildPayload: () => Record<string, unknown>;
}

function registerJsonResource(
  server: McpServer,
  definition: JsonResourceDefinition
): void {
  server.registerResource(
    definition.name,
    definition.uri,
    {
      title: definition.title,
      description: definition.description,
      mimeType: 'application/json',
    },
    (uri) => ({
      contents: [
        {
          uri: uri.href,
          mimeType: 'application/json',
          text: JSON.stringify(definition.buildPayload(), null, 2),
        },
      ],
    })
  );
}

function buildHealthPayload(): Record<string, unknown> {
  const memUsage = process.memoryUsage();
  const heapUsedMB = Math.round(memUsage.heapUsed / 1024 / 1024);
  const heapTotalMB = Math.round(memUsage.heapTotal / 1024 / 1024);

  return {
    status: 'healthy',
    uptime: process.uptime(),
    checks: {
      cache: config.cache.enabled,
      memory: {
        heapUsed: heapUsedMB,
        heapTotal: heapTotalMB,
        percentage: Math.round((heapUsedMB / heapTotalMB) * 100),
        healthy: heapUsedMB < 400,
      },
    },
    timestamp: new Date().toISOString(),
  };
}

function buildStatsPayload(): Record<string, unknown> {
  return {
    server: {
      name: config.server.name,
      version: config.server.version,
      uptime: process.uptime(),
      nodeVersion: process.version,
      memoryUsage: process.memoryUsage(),
    },
    cache: {
      enabled: config.cache.enabled,
      ttl: config.cache.ttl,
      maxKeys: config.cache.maxKeys,
      totalKeys: cache.keys().length,
    },
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
}

export function registerResources(server: McpServer): void {
  registerCachedContentResource(server);

  const resources: JsonResourceDefinition[] = [
    {
      name: 'health',
      uri: 'superfetch://health',
      title: 'Server Health',
      description: 'Real-time server health and dependency status',
      buildPayload: buildHealthPayload,
    },
    {
      name: 'stats',
      uri: 'superfetch://stats',
      title: 'Server Statistics',
      description: 'Fetch statistics and cache performance metrics',
      buildPayload: buildStatsPayload,
    },
  ];

  for (const resource of resources) {
    registerJsonResource(server, resource);
  }
}
