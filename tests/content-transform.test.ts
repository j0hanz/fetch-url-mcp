import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { FetchError } from '../dist/errors.js';
import { shutdownTransformWorkerPool } from '../dist/transform.js';
import { transformHtmlToMarkdown } from '../dist/transform.js';

after(async () => {
  await shutdownTransformWorkerPool();
});

type TransformResult = Awaited<ReturnType<typeof transformHtmlToMarkdown>>;

type RawContentCase = {
  input: string;
  url: string;
  includeMetadata: boolean;
  assert: (result: TransformResult) => void;
};

async function runRawContentCase(testCase: RawContentCase) {
  const result = await transformHtmlToMarkdown(testCase.input, testCase.url, {
    includeMetadata: testCase.includeMetadata,
  });

  testCase.assert(result);
}

describe('transformHtmlToMarkdown raw content detection', () => {
  it('preserves markdown with frontmatter and adds source when missing', () => {
    return runRawContentCase({
      input: `---\ntitle: "Hello"\n---\n\n# Heading`,
      url: 'https://example.com/file.md',
      includeMetadata: true,
      assert: (result) => {
        assert.ok(result.markdown.includes('# Heading'));
        assert.ok(
          result.markdown.includes('source: "https://example.com/file.md"')
        );
      },
    });
  });

  it('treats doctype/html documents as HTML (not raw)', () => {
    return runRawContentCase({
      input: '<!DOCTYPE html><html><body><p>Hello</p></body></html>',
      url: 'https://example.com',
      includeMetadata: false,
      assert: (result) => {
        assert.ok(result.markdown.includes('Hello'));
        assert.ok(!result.markdown.includes('<!DOCTYPE'));
      },
    });
  });

  it('treats <=2 common HTML tags + markdown patterns as raw', () => {
    return runRawContentCase({
      input: '<div>one</div><span>two</span>\n# Heading',
      url: 'https://example.com/raw',
      includeMetadata: true,
      assert: (result) => {
        assert.ok(result.markdown.includes('<div>one</div>'));
        assert.ok(result.markdown.includes('# Heading'));
        assert.ok(
          result.markdown.includes('source: "https://example.com/raw"')
        );
      },
    });
  });

  it('treats >2 common HTML tags as HTML even if markdown patterns exist', () => {
    return runRawContentCase({
      input:
        '<div>one</div><span>two</span><meta name="x" content="y">\n# Heading',
      url: 'https://example.com/html',
      includeMetadata: false,
      assert: (result) => {
        assert.ok(!result.markdown.includes('<div>'));
      },
    });
  });

  it('throws when cancelled via AbortSignal', async () => {
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () =>
        transformHtmlToMarkdown('<p>Hello</p>', 'https://example.com', {
          includeMetadata: false,
          signal: controller.signal,
        }),
      (error: unknown) =>
        error instanceof FetchError &&
        error.statusCode === 499 &&
        error.message.includes('canceled')
    );
  });
});
