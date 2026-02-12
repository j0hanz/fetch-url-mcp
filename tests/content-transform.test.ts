import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { FetchError } from '../dist/errors.js';
import { cleanupMarkdownArtifacts } from '../dist/markdown-cleanup.js';
import {
  shutdownTransformWorkerPool,
  transformHtmlToMarkdown,
} from '../dist/transform.js';

after(async () => {
  await shutdownTransformWorkerPool();
});

async function withWorkerPoolDisabled<T>(fn: () => Promise<T>): Promise<T> {
  const { config } = await import('../dist/config.js');
  const original = config.transform.maxWorkerScale;
  config.transform.maxWorkerScale = 0;
  await shutdownTransformWorkerPool();
  try {
    return await fn();
  } finally {
    await shutdownTransformWorkerPool();
    config.transform.maxWorkerScale = original;
  }
}

async function withWorkerPoolEnabled<T>(fn: () => Promise<T>): Promise<T> {
  const { config } = await import('../dist/config.js');
  const original = config.transform.maxWorkerScale;
  config.transform.maxWorkerScale = 1;
  await shutdownTransformWorkerPool();
  try {
    return await fn();
  } finally {
    await shutdownTransformWorkerPool();
    config.transform.maxWorkerScale = original;
  }
}

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

  it('treats HTML fragments as HTML even with markdown patterns', () => {
    return runRawContentCase({
      input: '<div>one</div><span>two</span>\n# Heading',
      url: 'https://example.com/raw',
      includeMetadata: true,
      assert: (result) => {
        assert.ok(!result.markdown.includes('<div>one</div>'));
        assert.ok(!result.markdown.includes('<span>two</span>'));
        assert.ok(result.markdown.includes('one'));
        assert.ok(result.markdown.includes('two'));
        assert.ok(
          result.markdown.includes(
            '[_Original Source_](https://example.com/raw)'
          )
        );
      },
    });
  });

  it('resolves relative links in raw markdown content', async () => {
    const input = '# Title\n\n[Doc](./doc.md)';
    const result = await transformHtmlToMarkdown(
      input,
      'https://example.com/base/page',
      {
        includeMetadata: false,
      }
    );

    assert.ok(
      result.markdown.includes('[Doc](https://example.com/base/doc.md)')
    );
  });

  it('treats >5 common HTML tags as HTML even if markdown patterns exist', () => {
    return runRawContentCase({
      input:
        '<div>one</div><span>two</span><meta name="x" content="y"><link rel="stylesheet"><style></style><script></script>\n# Heading',
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

  it('rejects quickly when cancelled after starting', async () => {
    const controller = new AbortController();

    const html = `<html><body><div>${'x'.repeat(2_000_000)}</div></body></html>`;
    const promise = transformHtmlToMarkdown(html, 'https://example.com', {
      includeMetadata: false,
      signal: controller.signal,
    });

    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    controller.abort();

    const result = await Promise.race([
      promise.then(
        () => ({ type: 'resolved' as const }),
        (error) => ({ type: 'rejected' as const, error })
      ),
      new Promise<{ type: 'timeout' }>((resolve) => {
        setTimeout(() => resolve({ type: 'timeout' }), 250).unref();
      }),
    ]);

    assert.notEqual(result.type, 'timeout');
    assert.equal(result.type, 'rejected');
    assert.ok(result.error instanceof FetchError);
    assert.equal(result.error.statusCode, 499);
  });

  it('worker stops processing when task is cancelled', async () => {
    await withWorkerPoolEnabled(async () => {
      const controller = new AbortController();

      const html = `<html><body>${'<p>hello</p>'.repeat(100000)}</body></html>`;
      const promise = transformHtmlToMarkdown(html, 'https://example.com', {
        includeMetadata: false,
        signal: controller.signal,
      });

      await new Promise<void>((resolve) => {
        setTimeout(resolve, 50).unref();
      });
      controller.abort();

      const result = await Promise.race([
        promise.then(
          () => ({ type: 'resolved' as const }),
          (error) => ({ type: 'rejected' as const, error })
        ),
        new Promise<{ type: 'timeout' }>((resolve) => {
          setTimeout(() => resolve({ type: 'timeout' }), 200).unref();
        }),
      ]);

      assert.notEqual(result.type, 'timeout');
      assert.equal(result.type, 'rejected');
      assert.ok(result.error instanceof FetchError);
      assert.equal(result.error.statusCode, 499);
    });
  });

  it('aborts during cleanup stage when signal fires', () => {
    const controller = new AbortController();
    controller.abort();

    assert.throws(
      () =>
        cleanupMarkdownArtifacts('Some cleanup text', {
          signal: controller.signal,
          url: 'https://example.com',
        }),
      (error: unknown) =>
        error instanceof FetchError && error.statusCode === 499
    );
  });

  it('removes dangling tag fragments when input is already truncated', async () => {
    await withWorkerPoolDisabled(async () => {
      const result = await transformHtmlToMarkdown(
        '<html><body><p>Hello</p><',
        'https://example.com/truncated',
        {
          includeMetadata: false,
          inputTruncated: true,
        }
      );

      assert.equal(result.truncated, true);
      assert.ok(result.markdown.includes('Hello'));
      assert.equal(result.markdown.includes('\n\n<'), false);
      assert.equal(result.markdown.endsWith('<'), false);
    });
  });

  it('rejects content with high replacement character ratio (binary indicator)', async () => {
    // Simulate binary content that was decoded as UTF-8 with many replacement chars
    const replacementChar = '\ufffd';
    const binaryGarbage =
      replacementChar.repeat(300) + 'some text' + replacementChar.repeat(300);

    await withWorkerPoolDisabled(() =>
      assert.rejects(
        () =>
          transformHtmlToMarkdown(binaryGarbage, 'https://example.com/binary', {
            includeMetadata: false,
          }),
        (error: unknown) =>
          error instanceof FetchError &&
          error.statusCode === 415 &&
          error.message.includes('binary')
      )
    );
  });

  it('rejects content with null bytes (binary indicator)', async () => {
    // Content with null bytes should trigger binary detection
    const contentWithNull = '<html><body>\x00binary\x00data</body></html>';

    await withWorkerPoolDisabled(() =>
      assert.rejects(
        () =>
          transformHtmlToMarkdown(
            contentWithNull,
            'https://example.com/binary',
            {
              includeMetadata: false,
            }
          ),
        (error: unknown) =>
          error instanceof FetchError &&
          error.statusCode === 415 &&
          error.message.includes('binary')
      )
    );
  });
});

describe('transformHtmlToMarkdown favicon rendering', () => {
  it('renders 32x32 favicon before title when declared', async () => {
    const html = `
      <html>
        <head>
          <title>Example Page</title>
          <link rel="icon" sizes="32x32" href="/favicon-32x32.png" />
        </head>
        <body>
          <p>Content here</p>
        </body>
      </html>
    `;

    const result = await withWorkerPoolDisabled(() =>
      transformHtmlToMarkdown(html, 'https://example.com', {
        includeMetadata: false,
      })
    );

    assert.ok(
      result.markdown.includes(
        '![example.com](https://example.com/favicon-32x32.png)'
      ),
      'Expected 32x32 favicon img tag in markdown'
    );
    assert.ok(result.markdown.includes('Example Page'));
  });

  it('renders title without favicon when no icon links present', async () => {
    const html = `
      <html>
        <head>
          <title>No Favicon Page</title>
        </head>
        <body>
          <p>Content here</p>
        </body>
      </html>
    `;

    const result = await withWorkerPoolDisabled(() =>
      transformHtmlToMarkdown(html, 'https://example.com', {
        includeMetadata: false,
      })
    );

    // Title should be present without favicon
    assert.ok(result.markdown.includes('# '));
    assert.ok(result.markdown.includes('No Favicon Page'));
    assert.ok(!result.markdown.includes('<img'));
  });
});
