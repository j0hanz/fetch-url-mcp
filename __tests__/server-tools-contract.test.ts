import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { createMcpServerForHttpSession } from '../src/server.js';
import { buildFetchUrlContentBlocks } from '../src/tools/index.js';

type UnknownRequestHandler = (
  request: unknown,
  extra?: unknown
) => Promise<unknown> | unknown;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function getRequestHandler(
  server: McpServer,
  method: string
): UnknownRequestHandler {
  const handlers: unknown = Reflect.get(server.server, '_requestHandlers');
  assert.ok(handlers instanceof Map, '_requestHandlers should be a Map');
  const handler = handlers.get(method);
  assert.equal(typeof handler, 'function', `${method} handler should exist`);
  return handler as UnknownRequestHandler;
}

describe('server tool contract', () => {
  const servers: McpServer[] = [];

  afterEach(async () => {
    await Promise.allSettled(servers.splice(0).map((server) => server.close()));
  });

  async function createServer(): Promise<McpServer> {
    const server = await createMcpServerForHttpSession();
    servers.push(server);
    return server;
  }

  it('advertises fetch-url with output schema, task support, annotations, and icons', async () => {
    const server = await createServer();
    const listTools = getRequestHandler(server, 'tools/list');

    const result = (await listTools({
      method: 'tools/list',
      params: {},
    })) as {
      tools: Array<Record<string, unknown>>;
    };

    const tool = result.tools.find((entry) => entry['name'] === 'fetch-url');
    assert.ok(tool, 'fetch-url should be listed');
    assert.equal(tool['title'], 'Fetch URL');
    const execution = asRecord(tool['execution']);
    assert.equal(execution?.['taskSupport'], 'optional');
    assert.deepEqual(tool['annotations'], {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    });

    const icons = Array.isArray(tool['icons']) ? tool['icons'] : [];
    assert.equal(icons.length, 1);
    assert.equal(icons[0]?.mimeType, 'image/svg+xml');
    assert.match(String(icons[0]?.src), /^data:image\/svg\+xml;base64,/);

    const outputSchema =
      tool['outputSchema'] && typeof tool['outputSchema'] === 'object'
        ? (tool['outputSchema'] as {
            required?: string[];
            properties?: Record<string, unknown>;
          })
        : undefined;
    assert.ok(outputSchema, 'outputSchema should be present');
    assert.deepEqual(outputSchema.required, [
      'url',
      'inputUrl',
      'resolvedUrl',
      'markdown',
      'fetchedAt',
      'contentSize',
    ]);
    assert.ok(outputSchema.properties?.['markdown']);
    assert.ok(outputSchema.properties?.['contentSize']);
  });

  it('emits markdown as the first content block and JSON as the compatibility block', () => {
    const blocks = buildFetchUrlContentBlocks({
      url: 'https://example.com',
      inputUrl: 'https://example.com',
      resolvedUrl: 'https://example.com',
      markdown: '# Example',
      fetchedAt: '2026-03-27T12:00:00.000Z',
      contentSize: 9,
    });

    assert.equal(blocks.length, 2);
    assert.deepEqual(blocks[0], { type: 'text', text: '# Example' });
    assert.equal(blocks[1]?.type, 'text');
    const compatibilityBlock = asRecord(blocks[1]);
    assert.equal(typeof compatibilityBlock?.['text'], 'string');
    assert.deepEqual(JSON.parse(String(compatibilityBlock?.['text'])), {
      url: 'https://example.com',
      inputUrl: 'https://example.com',
      resolvedUrl: 'https://example.com',
      markdown: '# Example',
      fetchedAt: '2026-03-27T12:00:00.000Z',
      contentSize: 9,
    });
  });
});
