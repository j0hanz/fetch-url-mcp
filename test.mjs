/* global console */
import { spawn } from 'child_process';

// Simple MCP test - change URL and run: node test.mjs
const URL = 'https://www.chakra-ui.com/docs/get-started/installation';
const TOOL = 'fetch-markdown'; // or 'fetch-url' for JSONL

const init = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '1.0' },
  },
});

const call = JSON.stringify({
  jsonrpc: '2.0',
  id: 2,
  method: 'tools/call',
  params: { name: TOOL, arguments: { url: URL } },
});

const proc = spawn('node', ['dist/index.js', '--stdio'], {
  stdio: ['pipe', 'pipe', 'ignore'],
});

proc.stdin.write(init + '\n');
proc.stdin.write(call + '\n');
proc.stdin.end();

let output = '';
proc.stdout.on('data', (d) => (output += d));
proc.on('close', () => {
  const lines = output.trim().split('\n');
  const result = JSON.parse(lines[lines.length - 1]);

  if (result.error) {
    console.error('Error:', result.error.message);
  } else {
    const data = result.result.structuredContent;
    console.log(`\\n=== ${data.title} ===\\n`);
    console.log(data.markdown || JSON.stringify(data.content, null, 2));
  }
});
