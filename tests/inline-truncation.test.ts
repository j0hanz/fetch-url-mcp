import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

// Note: We need to import the internal function for testing.
// Since it's not exported, we'll test through the public API by creating
// markdown with code fences that exceed the inline limit.
import { config } from '../dist/lib/config.js';
import { fetchUrlToolHandler } from '../dist/tools/fetch-url.js';
import { shutdownTransformWorkerPool } from '../dist/transform/transform.js';

after(async () => {
  await shutdownTransformWorkerPool();
});

describe('Inline content truncation', () => {
  it('does not produce malformed markdown when truncating mid-code-fence', async (t) => {
    const originalInlineLimit = config.constants.maxInlineContentChars;
    config.constants.maxInlineContentChars = 20000;
    // Create a mock fetch that returns markdown with a code fence
    // that gets truncated in the middle
    const longCode = 'a'.repeat(20100); // Exceeds 20000 char limit
    const markdownWithCodeFence = `
# Example

Some text before the fence.

\`\`\`javascript
${longCode}
\`\`\`

Text after fence.
`;

    // Mock fetch to return our test content
    const mockFetch = async (_url: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(markdownWithCodeFence, {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    };

    t.mock.method(globalThis, 'fetch', mockFetch);

    try {
      const result = await fetchUrlToolHandler(
        { url: 'https://example.com/test.md' },
        {}
      );

      // Check if result has content
      assert.ok(result.content, 'Result should have content');

      const textBlock = result.content.find((b) => b.type === 'text');
      assert.ok(textBlock, 'Result should have text block');

      if (textBlock?.type === 'text') {
        const content = JSON.parse(textBlock.text) as {
          markdown?: string;
          truncated?: boolean;
        };

        // Should be marked as truncated
        assert.equal(
          content.truncated,
          true,
          'Content should be marked as truncated'
        );

        const markdown = content.markdown ?? '';

        // Check if truncated content has unclosed code fence
        const openFences = (markdown.match(/^```/gm) || []).length;
        const closeFences = openFences; // Should be equal if properly closed

        // If we have an odd number of fence markers, we have an unclosed fence
        const hasUnclosedFence = openFences % 2 !== 0;

        // This test should PASS after fix, demonstrating the issue is resolved
        // Before fix: hasUnclosedFence would be true (FAIL)
        // After fix: hasUnclosedFence should be false (PASS)
        assert.equal(
          hasUnclosedFence,
          false,
          'Truncated markdown should not have unclosed code fences'
        );

        // Verify truncation marker is present
        assert.ok(
          markdown.includes('...[truncated]'),
          'Should include truncation marker'
        );
      }
    } finally {
      config.constants.maxInlineContentChars = originalInlineLimit;
    }
  });

  it('handles truncation of nested code fences correctly', async (t) => {
    const originalInlineLimit = config.constants.maxInlineContentChars;
    config.constants.maxInlineContentChars = 20000;
    // Test with markdown containing nested fences (e.g., in documentation)
    const longContent = 'b'.repeat(20100);
    const nestedFenceMarkdown = `
# Documentation

Example of a code block:

\`\`\`markdown
# Inner document
\`\`\`javascript
${longContent}
\`\`\`
\`\`\`

End of example.
`;

    const mockFetch = async (_url: RequestInfo | URL, _init?: RequestInit) => {
      return new Response(nestedFenceMarkdown, {
        status: 200,
        headers: { 'content-type': 'text/plain' },
      });
    };

    t.mock.method(globalThis, 'fetch', mockFetch);

    try {
      const result = await fetchUrlToolHandler(
        { url: 'https://example.com/nested.md' },
        {}
      );

      const textBlock = result.content?.find((b) => b.type === 'text');
      if (textBlock?.type === 'text') {
        const content = JSON.parse(textBlock.text) as {
          markdown?: string;
          truncated?: boolean;
        };

        const markdown = content.markdown ?? '';

        // All opened fences should be closed
        const lines = markdown.split('\n');
        let openCount = 0;

        for (const line of lines) {
          if (line.trim().startsWith('```')) {
            openCount++;
          }
        }

        // Even number means all fences are closed
        assert.equal(
          openCount % 2,
          0,
          'All code fences should be properly closed'
        );
      }
    } finally {
      config.constants.maxInlineContentChars = originalInlineLimit;
    }
  });
});
