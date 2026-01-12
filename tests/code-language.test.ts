import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  detectLanguageFromCode,
  resolveLanguageFromAttributes,
} from '../dist/transform.js';

describe('detectLanguageFromCode', () => {
  it('detects JavaScript snippets', () => {
    assert.equal(detectLanguageFromCode('const x = 1;'), 'javascript');
  });

  it('detects Python snippets', () => {
    assert.equal(
      detectLanguageFromCode('def run():\n  print(\"ok\")'),
      'python'
    );
  });

  it('returns undefined for unknown snippets', () => {
    assert.equal(detectLanguageFromCode('this is not code'), undefined);
  });

  it('detects TypeScript snippets', () => {
    assert.equal(
      detectLanguageFromCode('interface User { id: string; }'),
      'typescript'
    );
  });

  it('detects Rust snippets', () => {
    assert.equal(
      detectLanguageFromCode('fn main() { let mut x = 1; }'),
      'rust'
    );
  });

  it('detects Bash snippets', () => {
    assert.equal(
      detectLanguageFromCode('#!/usr/bin/env bash\nnpm run build'),
      'bash'
    );
  });

  it('detects CSS snippets', () => {
    assert.equal(
      detectLanguageFromCode('.container { display: flex; }'),
      'css'
    );
  });

  it('detects HTML snippets', () => {
    assert.equal(
      detectLanguageFromCode('<!doctype html><html><body></body></html>'),
      'html'
    );
  });

  it('detects JSON snippets', () => {
    assert.equal(detectLanguageFromCode('{"name":"superfetch"}'), 'json');
  });

  it('detects YAML snippets', () => {
    assert.equal(
      detectLanguageFromCode('name: superfetch\nversion: 1'),
      'yaml'
    );
  });

  it('detects SQL snippets', () => {
    assert.equal(detectLanguageFromCode('SELECT 1;'), 'sql');
  });

  it('detects Go snippets', () => {
    assert.equal(detectLanguageFromCode('package main\nfunc main() {}'), 'go');
  });

  it('detects JSX snippets', () => {
    assert.equal(
      detectLanguageFromCode(
        'export const App = () => <div className=\"x\" />;'
      ),
      'jsx'
    );
  });

  it('extracts language from class names', () => {
    assert.equal(
      resolveLanguageFromAttributes('language-typescript', ''),
      'typescript'
    );
  });

  it('extracts language from data-language', () => {
    assert.equal(resolveLanguageFromAttributes('', 'python'), 'python');
  });
});
