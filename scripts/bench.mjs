import { performance } from 'node:perf_hooks';
import process from 'node:process';

import { extractContent } from '../dist/services/extractor.js';
import { parseHtml } from '../dist/services/parser.js';
import { toJsonl } from '../dist/transformers/jsonl.transformer.js';
import { htmlToMarkdown } from '../dist/transformers/markdown.transformer.js';

const sampleHtml = `<!doctype html><html><head><title>Sample</title><meta name="description" content="Test page"></head><body><h1>Title</h1><p>Paragraph one with some text.</p><p>Paragraph two with a <a href="https://example.com">link</a> and more content.</p><ul><li>Item one</li><li>Item two</li><li>Item three</li></ul><pre><code>const x = 1;\nfunction f(){ return x + 1; }</code></pre><blockquote>Blockquote text here.</blockquote><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table></body></html>`;

function bench(label, fn, iterations = 500) {
  const start = performance.now();
  for (let i = 0; i < iterations; i += 1) {
    fn();
  }
  const total = performance.now() - start;
  const avg = total / iterations;
  return {
    label,
    iterations,
    totalMs: Number(total.toFixed(2)),
    avgMs: Number(avg.toFixed(4)),
  };
}

const results = [];
results.push(bench('parseHtml', () => parseHtml(sampleHtml)));
results.push(
  bench('extractContent', () =>
    extractContent(sampleHtml, 'https://example.com')
  )
);
results.push(
  bench('htmlToMarkdown', () => htmlToMarkdown(sampleHtml, undefined))
);
results.push(bench('toJsonl', () => toJsonl(parseHtml(sampleHtml), undefined)));

process.stdout.write(
  `${JSON.stringify({ sampleSize: sampleHtml.length, results }, null, 2)}\n`
);
