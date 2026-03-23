import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  detectLanguageFromCode,
  resolveLanguageFromAttributes,
} from '../dist/transform/html-translators.js';

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

  it('detects HTML fragments before shared Python keywords', () => {
    assert.equal(
      detectLanguageFromCode('<div class="h-screen">  <!-- ... --></div>'),
      'html'
    );
  });

  it('detects JSON snippets', () => {
    assert.equal(detectLanguageFromCode('{"name":"fetch-url-mcp"}'), 'json');
  });

  it('detects YAML snippets', () => {
    assert.equal(
      detectLanguageFromCode('name: fetch-url-mcp\nversion: 1'),
      'yaml'
    );
  });

  it('detects Tailwind theme directives as CSS', () => {
    assert.equal(
      detectLanguageFromCode('@theme {\n  --spacing: 1px;\n}'),
      'css'
    );
  });

  it('detects SQL snippets', () => {
    assert.equal(detectLanguageFromCode('SELECT 1;'), 'sql');
  });

  it('detects SQL CREATE TABLE', () => {
    assert.equal(
      detectLanguageFromCode('CREATE TABLE users (id INT PRIMARY KEY);'),
      'sql'
    );
  });

  it('detects bash for npm install commands', () => {
    assert.equal(detectLanguageFromCode('npm install react'), 'bash');
  });

  it('detects bash for yarn add commands', () => {
    assert.equal(detectLanguageFromCode('yarn add next'), 'bash');
  });

  it('detects bash for pnpm add commands', () => {
    assert.equal(detectLanguageFromCode('pnpm add tailwindcss'), 'bash');
  });

  it('detects bash for npm i shorthand', () => {
    assert.equal(detectLanguageFromCode('npm i react'), 'bash');
  });

  it('detects bash for npx commands', () => {
    assert.equal(detectLanguageFromCode('npx create-next-app'), 'bash');
  });

  it('does not detect yaml for JS import statements', () => {
    const result = detectLanguageFromCode("import { useState } from 'react'");
    assert.notEqual(
      result,
      'yaml',
      'JS imports should not be detected as yaml'
    );
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

  it('detects Python REPL transcripts', () => {
    assert.equal(
      detectLanguageFromCode(
        '>>> Question.objects.all()\n<QuerySet []>\n>>> q.was_published_recently()\nTrue'
      ),
      'python'
    );
  });

  it('detects Windows shell prompts as shell transcripts', () => {
    assert.equal(detectLanguageFromCode('...\\> py manage.py shell'), 'bash');
  });

  it('does not misclassify QuerySet output as JSX', () => {
    assert.notEqual(detectLanguageFromCode('<QuerySet []>'), 'jsx');
  });

  it('does not misclassify comment-prefixed mapping output as CSS', () => {
    assert.notEqual(
      detectLanguageFromCode(
        "# {'email': 'leila@example.com', 'content': 'foo bar'}"
      ),
      'css'
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
