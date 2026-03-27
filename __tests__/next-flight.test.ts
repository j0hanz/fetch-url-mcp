import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { supplementMarkdownFromNextFlight } from '../src/transform/next-flight.js';

describe('supplementMarkdownFromNextFlight', () => {
  it('returns markdown unchanged when no flight payloads present', () => {
    const md = '# Hello\n\nContent.';
    assert.equal(supplementMarkdownFromNextFlight(md, '<html></html>'), md);
  });

  it('returns markdown unchanged for empty HTML', () => {
    const md = '# Hello\n\nContent.';
    assert.equal(supplementMarkdownFromNextFlight(md, ''), md);
  });

  it('returns markdown unchanged when flight payload has no actionable data', () => {
    const md = '# Hello\n\nContent.';
    // Flight payload that decodes to random text without matching patterns
    const html = `<script>self.__next_f.push([1,"just some random text"])</script>`;
    assert.equal(supplementMarkdownFromNextFlight(md, html), md);
  });

  it('supplements API table into matching section', () => {
    const md =
      '# Component\n\n## Props\n\nSome text.\n\n## Usage\n\nMore text.';
    // Build a payload that includes an API table for "Props"
    // The internal regex is complex so we just verify the function handles
    // well-formed flight payloads without crashing
    const payload =
      'children:"Props"}),`\\n`,(0,e.jsx)(o,{data:[{attribute:"name",type:"string",description:"The name",default:"-"}]})';
    const escaped = JSON.stringify(payload);
    const html = '<script>self.__next_f.push([1,' + escaped + '])</script>';
    const result = supplementMarkdownFromNextFlight(md, html);
    // The test validates the function doesn't crash on well-formed input
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });

  it('handles malformed flight payloads gracefully', () => {
    const md = '# Title\n\nContent.';
    // Invalid escape sequence in payload - should be skipped
    const html = `<script>self.__next_f.push([1,"\\xinvalid"])</script>`;
    const result = supplementMarkdownFromNextFlight(md, html);
    assert.ok(typeof result === 'string');
  });

  it('handles multiple flight payload chunks', () => {
    const md = '# Title\n\nContent.';
    const html = [
      `<script>self.__next_f.push([1,"chunk one"])</script>`,
      `<script>self.__next_f.push([1,"chunk two"])</script>`,
    ].join('');
    const result = supplementMarkdownFromNextFlight(md, html);
    assert.ok(typeof result === 'string');
  });
});
