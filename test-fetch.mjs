#!/usr/bin/env node
/**
 * Test script for superFetch MCP server
 * Tests the fetch-url tool with web documentation
 */

// ============================================================================
// Configuration
// ============================================================================

const CONFIG = {
  serverUrl: process.env.SERVER_URL || 'http://127.0.0.1:3000',
  testUrl: process.env.TEST_URL || 'https://flyonui.com/docs/getting-started/quick-start/',
  timeout: parseInt(process.env.TEST_TIMEOUT || '30000', 10),
  verbose: process.env.VERBOSE === 'true',
};

// ============================================================================
// Utilities
// ============================================================================

const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};

const log = {
  info: (msg) => console.log(msg),
  success: (msg) => console.log(`${colors.green}✅ ${msg}${colors.reset}`),
  error: (msg) => console.log(`${colors.red}❌ ${msg}${colors.reset}`),
  warn: (msg) => console.log(`${colors.yellow}⚠️  ${msg}${colors.reset}`),
  step: (msg) => console.log(`${colors.cyan}🔹 ${msg}${colors.reset}`),
  debug: (msg) => CONFIG.verbose && console.log(`${colors.dim}   ${msg}${colors.reset}`),
  header: (msg) => console.log(`\n${'═'.repeat(60)}\n${msg}\n${'═'.repeat(60)}`),
  subheader: (msg) => console.log(`\n${colors.cyan}▸ ${msg}${colors.reset}`),
};

/**
 * Parse SSE (Server-Sent Events) response and extract JSON data
 */
async function parseSSEResponse(response) {
  const text = await response.text();

  // If it's already JSON, parse directly
  if (text.startsWith('{') || text.startsWith('[')) {
    return JSON.parse(text);
  }

  // Parse SSE format: "event: message\ndata: {...}\n\n"
  const lines = text.split('\n');

  for (const line of lines) {
    if (line.startsWith('data: ')) {
      try {
        return JSON.parse(line.slice(6));
      } catch {
        // Not JSON data, continue
      }
    }
  }

  throw new Error(`Failed to parse SSE response: ${text.substring(0, 200)}`);
}

/**
 * Make an MCP request with proper headers
 */
async function mcpRequest(endpoint, body, sessionId = null) {
  const headers = {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  };

  if (sessionId) {
    headers['mcp-session-id'] = sessionId;
  }

  const response = await fetch(`${CONFIG.serverUrl}${endpoint}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  });

  return { response, sessionId: response.headers.get('mcp-session-id') };
}

/**
 * Create a JSON-RPC request object
 */
function rpcRequest(id, method, params = {}) {
  return {
    jsonrpc: '2.0',
    id,
    method,
    params,
  };
}

/**
 * Create a JSON-RPC notification object (no id)
 */
function rpcNotification(method, params = {}) {
  return {
    jsonrpc: '2.0',
    method,
    params,
  };
}

/**
 * Delay execution for specified milliseconds
 */
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ============================================================================
// Test Result Tracking
// ============================================================================

class TestRunner {
  constructor() {
    this.results = [];
    this.startTime = Date.now();
  }

  async runTest(name, testFn) {
    log.subheader(name);
    const testStart = Date.now();

    try {
      const result = await testFn();
      const duration = Date.now() - testStart;
      this.results.push({ name, passed: true, duration });
      log.success(`${name} (${duration}ms)`);
      return result;
    } catch (error) {
      const duration = Date.now() - testStart;
      this.results.push({ name, passed: false, duration, error: error.message });
      log.error(`${name}: ${error.message}`);
      throw error;
    }
  }

  printSummary() {
    const totalDuration = Date.now() - this.startTime;
    const passed = this.results.filter((r) => r.passed).length;
    const failed = this.results.filter((r) => !r.passed).length;

    log.header('Test Summary');
    console.log(`Total: ${this.results.length} | Passed: ${passed} | Failed: ${failed}`);
    console.log(`Duration: ${totalDuration}ms\n`);

    if (failed > 0) {
      console.log('Failed tests:');
      this.results
        .filter((r) => !r.passed)
        .forEach((r) => console.log(`  - ${r.name}: ${r.error}`));
    }

    return failed === 0;
  }
}

// ============================================================================
// MCP Session Management
// ============================================================================

class MCPSession {
  constructor(serverUrl) {
    this.serverUrl = serverUrl;
    this.sessionId = null;
    this.requestId = 0;
  }

  nextId() {
    return ++this.requestId;
  }

  async initialize() {
    const { response, sessionId } = await mcpRequest(
      '/mcp',
      rpcRequest(this.nextId(), 'initialize', {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: { name: 'test-client', version: '1.0.0' },
      }),
    );

    if (!sessionId) {
      throw new Error('No session ID received from server');
    }

    this.sessionId = sessionId;
    const result = await parseSSEResponse(response);

    if (result.error) {
      throw new Error(`Initialize failed: ${JSON.stringify(result.error)}`);
    }

    return result.result;
  }

  async sendInitializedNotification() {
    await mcpRequest('/mcp', rpcNotification('notifications/initialized'), this.sessionId);
    // Allow state propagation
    await delay(300);
  }

  async listTools() {
    const { response } = await mcpRequest(
      '/mcp',
      rpcRequest(this.nextId(), 'tools/list', {}),
      this.sessionId,
    );

    const result = await parseSSEResponse(response);

    if (result.error) {
      throw new Error(`List tools failed: ${JSON.stringify(result.error)}`);
    }

    return result.result?.tools || [];
  }

  async callTool(name, args) {
    const { response } = await mcpRequest(
      '/mcp',
      rpcRequest(this.nextId(), 'tools/call', { name, arguments: args }),
      this.sessionId,
    );

    const result = await parseSSEResponse(response);

    if (result.error) {
      throw new Error(`Tool call failed: ${JSON.stringify(result.error)}`);
    }

    return result.result;
  }

  async readResource(uri) {
    const { response } = await mcpRequest(
      '/mcp',
      rpcRequest(this.nextId(), 'resources/read', { uri }),
      this.sessionId,
    );

    const result = await parseSSEResponse(response);

    if (result.error) {
      throw new Error(`Resource read failed: ${JSON.stringify(result.error)}`);
    }

    return result.result;
  }

  async close() {
    if (!this.sessionId) return;

    await fetch(`${this.serverUrl}/mcp`, {
      method: 'DELETE',
      headers: { 'mcp-session-id': this.sessionId },
    });

    this.sessionId = null;
  }
}

// ============================================================================
// Test Cases
// ============================================================================

async function testHealthCheck() {
  const response = await fetch(`${CONFIG.serverUrl}/health`);

  if (!response.ok) {
    throw new Error(`Health check returned ${response.status}`);
  }

  const data = await response.json();
  log.debug(`Server: ${data.name} v${data.version}, uptime: ${data.uptime?.toFixed(1)}s`);

  if (data.status !== 'healthy') {
    throw new Error(`Server status is ${data.status}, expected healthy`);
  }

  return data;
}

async function testSessionInitialization(session) {
  const serverInfo = await session.initialize();

  log.debug(`Protocol: ${serverInfo.protocolVersion}`);
  log.debug(`Server: ${serverInfo.serverInfo?.name} v${serverInfo.serverInfo?.version}`);

  await session.sendInitializedNotification();

  return serverInfo;
}

async function testListTools(session) {
  const tools = await session.listTools();

  if (!tools || tools.length === 0) {
    throw new Error('No tools returned from server');
  }

  tools.forEach((tool) => log.debug(`Tool: ${tool.name} - ${tool.description}`));

  const hasFetchUrl = tools.some((t) => t.name === 'fetch-url');
  if (!hasFetchUrl) {
    throw new Error('fetch-url tool not found');
  }

  return tools;
}

async function testFetchUrl(session, url) {
  log.debug(`Fetching: ${url}`);

  const result = await session.callTool('fetch-url', {
    url,
    extractMainContent: true,
    includeMetadata: true,
    format: 'jsonl',
  });

  if (!result.content || result.content.length === 0) {
    throw new Error('No content returned from fetch-url');
  }

  const content = result.content[0];
  const lines = content.text.split('\n').filter((line) => line.trim());

  log.debug(`Response type: ${content.type}`);
  log.debug(`Content lines: ${lines.length}`);

  // Parse first line as metadata if JSONL
  if (lines[0]?.startsWith('{')) {
    try {
      const metadata = JSON.parse(lines[0]);
      if (metadata.type === 'metadata') {
        log.debug(`Page title: ${metadata.title || 'N/A'}`);
      }
    } catch {
      // Not JSON metadata
    }
  }

  return { content, lineCount: lines.length };
}

async function testCaching(session, url) {
  // First fetch (should miss cache)
  const start1 = Date.now();
  await session.callTool('fetch-url', {
    url,
    extractMainContent: true,
    includeMetadata: true,
    format: 'jsonl',
  });
  const duration1 = Date.now() - start1;

  // Second fetch (should hit cache)
  const start2 = Date.now();
  await session.callTool('fetch-url', {
    url,
    extractMainContent: true,
    includeMetadata: true,
    format: 'jsonl',
  });
  const duration2 = Date.now() - start2;

  log.debug(`First fetch: ${duration1}ms, Second fetch: ${duration2}ms`);

  // Cache should make second request faster (at least 2x)
  const speedup = duration1 / Math.max(duration2, 1);
  log.debug(`Cache speedup: ${speedup.toFixed(1)}x`);

  return { duration1, duration2, speedup };
}

async function testServerStats(session) {
  const result = await session.readResource('superfetch://stats');

  if (!result.contents?.[0]?.text) {
    throw new Error('No stats content returned');
  }

  const stats = JSON.parse(result.contents[0].text);

  log.debug(`Uptime: ${Math.floor(stats.server.uptime)}s`);
  log.debug(`Cache size: ${stats.cache.size}, hits: ${stats.cache.hits}, misses: ${stats.cache.misses}`);
  log.debug(`Hit rate: ${stats.cache.hitRate}`);

  return stats;
}

// ============================================================================
// Main Entry Point
// ============================================================================

async function main() {
  log.header('🧪 superFetch MCP Server Tests');
  console.log(`Server: ${CONFIG.serverUrl}`);
  console.log(`Test URL: ${CONFIG.testUrl}`);

  const runner = new TestRunner();
  let session = null;

  try {
    // Test 1: Health Check
    await runner.runTest('Health Check', testHealthCheck);

    // Test 2: Session Initialization
    session = new MCPSession(CONFIG.serverUrl);
    await runner.runTest('Session Initialization', () => testSessionInitialization(session));

    // Test 3: List Tools
    await runner.runTest('List Tools', () => testListTools(session));

    // Test 4: Fetch URL
    await runner.runTest('Fetch URL', () => testFetchUrl(session, CONFIG.testUrl));

    // Test 5: Caching
    await runner.runTest('Cache Behavior', () => testCaching(session, CONFIG.testUrl));

    // Test 6: Server Stats
    await runner.runTest('Server Stats Resource', () => testServerStats(session));
  } finally {
    // Cleanup
    if (session?.sessionId) {
      log.step('Cleaning up session...');
      await session.close();
    }
  }

  // Print summary and exit
  const success = runner.printSummary();
  process.exit(success ? 0 : 1);
}

// Run tests
main().catch((error) => {
  log.error(`Unhandled error: ${error.message}`);
  if (CONFIG.verbose) {
    console.error(error.stack);
  }
  process.exit(1);
});
