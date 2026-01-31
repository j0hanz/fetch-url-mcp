import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createMcpServer } from '../dist/mcp.js';

describe('Prompt functionality', () => {
  it('prompts/list should return summarize-webpage', async () => {
    const server = await createMcpServer();

    // Access the internal prompts registry
    // @ts-ignore - accessing private property for testing
    const prompts = server._registeredPrompts;
    const promptNames = Object.keys(prompts);

    console.log('Registered prompts:', promptNames);
    console.log('Prompt details:', JSON.stringify(prompts, null, 2));

    assert.ok(
      promptNames.includes('summarize-webpage'),
      'summarize-webpage should be in registered prompts'
    );
  });

  it('prompts/get should return properly formatted messages', async () => {
    const server = await createMcpServer();

    // @ts-ignore
    const prompts = server._registeredPrompts;
    const prompt = prompts['summarize-webpage'];

    assert.ok(prompt, 'Prompt should be registered');

    // Test calling the prompt
    const result = await prompt.callback({ url: 'https://example.com' });

    console.log('Prompt result:', JSON.stringify(result, null, 2));

    assert.ok(result.messages, 'Result should have messages array');
    assert.strictEqual(result.messages.length, 1, 'Should have one message');
    assert.strictEqual(
      result.messages[0].role,
      'user',
      'Message role should be user'
    );
    assert.strictEqual(
      result.messages[0].content.type,
      'text',
      'Content type should be text'
    );
    assert.ok(
      result.messages[0].content.text.includes('https://example.com'),
      'Message should contain the URL'
    );
    assert.ok(
      result.messages[0].content.text.includes('summarize'),
      'Message should mention summarize'
    );
  });

  it('prompt should have proper title, description and schema', async () => {
    const server = await createMcpServer();

    // @ts-ignore
    const prompts = server._registeredPrompts;
    const prompt = prompts['summarize-webpage'];

    console.log('Prompt metadata:', {
      title: prompt.title,
      description: prompt.description,
      argsSchema: prompt.argsSchema,
    });

    assert.ok(prompt.title, 'Prompt should have a title');
    assert.strictEqual(
      prompt.title,
      'Summarize Webpage',
      'Title should match expected value'
    );
    assert.ok(prompt.description, 'Prompt should have a description');
    assert.ok(prompt.argsSchema, 'Prompt should have args schema');
  });
});
