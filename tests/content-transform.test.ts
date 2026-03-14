import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

import { cleanupMarkdownArtifacts } from '../dist/lib/content.js';
import { FetchError } from '../dist/lib/utils.js';
import {
  shutdownTransformWorkerPool,
  transformHtmlToMarkdown,
  transformHtmlToMarkdownInProcess,
} from '../dist/transform/transform.js';

after(async () => {
  await shutdownTransformWorkerPool();
});

async function withWorkerPoolDisabled<T>(fn: () => Promise<T>): Promise<T> {
  const { config } = await import('../dist/lib/core.js');
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
  const { config } = await import('../dist/lib/core.js');
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

  it('normalizes synthetic GitHub repository titles at the top of repo pages', async () => {
    const html = `
      <html>
        <head>
          <title>GitHub - owner/repo: Project description</title>
        </head>
        <body>
          <article class="markdown-body entry-content container-lg" itemprop="text">
            <div class="markdown-heading" dir="auto">
              <h1 tabindex="-1" class="heading-element" dir="auto">Fetch URL MCP Server</h1>
            </div>
            <p><a href="https://example.com/badge"><img src="https://example.com/badge.svg" alt="badge" /></a></p>
            <p>This project fetches content and converts it to markdown with enough body text to keep article extraction active for this regression fixture.</p>
          </article>
        </body>
      </html>
    `;

    const result = await withWorkerPoolDisabled(() =>
      transformHtmlToMarkdown(html, 'https://github.com/owner/repo', {
        includeMetadata: false,
      })
    );

    assert.ok(result.markdown.startsWith('# Fetch URL MCP Server\n\n'));
    assert.ok(!result.markdown.includes('\n## Fetch URL MCP Server\n'));
    assert.ok(!result.markdown.startsWith('# GitHub - owner/repo:'));
    assert.equal(result.title, 'Fetch URL MCP Server');
  });
});

describe('transformHtmlToMarkdown next flight supplements', () => {
  it('supplements missing commands, demo code, and API tables from flight payloads', () => {
    const demoCode = [
      'import {Card, Image} from "@example/react";',
      '',
      'export default function App() {',
      '  return <Card><Image alt="Hero" src="/hero.png" /></Card>;',
      '}',
    ].join('\n');

    const payload = [
      `var W=\`${demoCode}\`;`,
      'var s={image:W};',
      'commands:{cli:"npx example add card",npm:"npm install @example/card",yarn:"yarn add @example/card",pnpm:"pnpm add @example/card",bun:"bun add @example/card"}',
      'commands:{main:\'import {Card} from "@example/react";\',individual:\'import {Card} from "@example/card";\'}',
      'children:"Card Props"}),`\\n`,(0,e.jsx)(o,{data:[{attribute:"classNames",type:"Partial<Record<\'base\' | \'body\' | \'footer\', string>>",description:"Slot classes",default:"-"}]})',
      'title:"With Image",files:s.image',
    ].join('');

    const html = `
      <!doctype html>
      <html>
        <body>
          <main>
            <article>
              <h1><a href="#card">Card</a></h1>
              <p>Card docs.</p>
              <h2><a href="#installation">Installation</a></h2>
              <p>Install note.</p>
              <h2><a href="#import">Import</a></h2>
              <p>Import note.</p>
              <h2><a href="#usage">Usage</a></h2>
              <h3><a href="#with-image">With Image</a></h3>
              <h2><a href="#api">API</a></h2>
              <h3><a href="#card-props">Card Props</a></h3>
              <p>Legacy props output.</p>
            </article>
          </main>
          <script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>
        </body>
      </html>
    `;

    const result = transformHtmlToMarkdownInProcess(
      html,
      'https://example.com/docs/card',
      { includeMetadata: false }
    );

    assert.ok(result.markdown.includes('## Installation'));
    assert.ok(result.markdown.includes('npm install @example/card'));
    assert.ok(result.markdown.includes('## Import'));
    assert.ok(result.markdown.includes('import {Card} from "@example/react";'));
    assert.ok(result.markdown.includes('### With Image'));
    assert.ok(result.markdown.includes('src="/hero.png"'));
    assert.ok(
      result.markdown.includes(
        "| classNames | Partial<Record<'base' \\| 'body' \\| 'footer', string>> | Slot classes | - |"
      )
    );
    assert.ok(!result.markdown.includes('## [Installation](#installation)'));
  });
});

describe('transformHtmlToMarkdown mandatory noise removal', () => {
  it('always strips nav and footer elements from output', async () => {
    const html = `
      <html>
        <body>
          <nav><ul><li>Menu link 1</li><li>Menu link 2</li></ul></nav>
          <main><p>Main article content</p></main>
          <footer><p>Site footer info</p></footer>
        </body>
      </html>
    `;

    const result = await withWorkerPoolDisabled(() =>
      transformHtmlToMarkdown(html, 'https://example.com/noise-test', {
        includeMetadata: false,
      })
    );

    assert.ok(
      result.markdown.includes('Main article content'),
      'Main content should be preserved'
    );
    assert.ok(
      !result.markdown.includes('Menu link 1'),
      'Nav content should be stripped'
    );
    assert.ok(
      !result.markdown.includes('Site footer info'),
      'Footer content should be stripped'
    );
  });
});
