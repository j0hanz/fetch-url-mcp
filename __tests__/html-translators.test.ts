import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  detectLanguageFromCode,
  extractLanguageFromClassName,
  resolveLanguageFromAttributes,
} from '../dist/transform/html-translators.js';

// ── extractLanguageFromClassName ────────────────────────────────────

describe('extractLanguageFromClassName', () => {
  it('extracts from language- prefix', () => {
    assert.equal(
      extractLanguageFromClassName('language-javascript'),
      'javascript'
    );
  });

  it('extracts from lang- prefix', () => {
    assert.equal(extractLanguageFromClassName('lang-python'), 'python');
  });

  it('extracts from highlight- prefix', () => {
    assert.equal(
      extractLanguageFromClassName('highlight-typescript'),
      'typescript'
    );
  });

  it('handles hljs with separate language class', () => {
    assert.equal(extractLanguageFromClassName('hljs ruby'), 'ruby');
  });

  it('detects known language prefix followed by dash', () => {
    assert.equal(extractLanguageFromClassName('css-module'), 'css');
  });

  it('returns undefined for empty string', () => {
    assert.equal(extractLanguageFromClassName(''), undefined);
  });

  it('returns undefined for unrecognized class', () => {
    assert.equal(extractLanguageFromClassName('my-custom-class'), undefined);
  });

  it('handles multiple classes with language prefix', () => {
    assert.equal(
      extractLanguageFromClassName('some-class language-go other'),
      'go'
    );
  });
});

// ── resolveLanguageFromAttributes ──────────────────────────────────

describe('resolveLanguageFromAttributes', () => {
  it('prefers className over data-language', () => {
    assert.equal(
      resolveLanguageFromAttributes('language-python', 'javascript'),
      'python'
    );
  });

  it('falls back to data-language', () => {
    assert.equal(
      resolveLanguageFromAttributes('no-match', 'typescript'),
      'typescript'
    );
  });

  it('returns undefined when neither matches', () => {
    assert.equal(
      resolveLanguageFromAttributes('no-match', 'not valid!'),
      undefined
    );
  });

  it('returns undefined for empty inputs', () => {
    assert.equal(resolveLanguageFromAttributes('', ''), undefined);
  });
});

// ── detectLanguageFromCode ─────────────────────────────────────────

describe('detectLanguageFromCode', () => {
  it('detects JavaScript', () => {
    const code = 'const x = 42;\nexport default x;';
    assert.equal(detectLanguageFromCode(code), 'javascript');
  });

  it('detects TypeScript', () => {
    const code = 'interface User { name: string; age: number; }';
    assert.equal(detectLanguageFromCode(code), 'typescript');
  });

  it('detects Python', () => {
    const code = 'def hello():\n    print("Hello")\n    self.value = True';
    assert.equal(detectLanguageFromCode(code), 'python');
  });

  it('detects Bash', () => {
    const code = '#!/bin/bash\necho "Hello"\nnpm install express';
    assert.equal(detectLanguageFromCode(code), 'bash');
  });

  it('detects HTML', () => {
    const code = '<!doctype html>\n<html>\n<body>Hello</body>\n</html>';
    assert.equal(detectLanguageFromCode(code), 'html');
  });

  it('detects CSS', () => {
    const code =
      '@media (max-width: 768px) {\n  .container { display: flex; }\n}';
    assert.equal(detectLanguageFromCode(code), 'css');
  });

  it('detects SQL', () => {
    const code = 'SELECT id, name FROM users WHERE active = 1;';
    assert.equal(detectLanguageFromCode(code), 'sql');
  });

  it('detects Rust', () => {
    const code = 'fn main() {\n    let mut x = 5;\n    println!("{}", x);\n}';
    assert.equal(detectLanguageFromCode(code), 'rust');
  });

  it('detects Go', () => {
    const code = 'package main\nfunc main() {}';
    assert.equal(detectLanguageFromCode(code), 'go');
  });

  it('detects JSON for bracket-only payloads', () => {
    // Pure JSON without key: value patterns that would trigger YAML detection
    const code = '[1, 2, 3]';
    assert.equal(detectLanguageFromCode(code), 'json');
  });

  it('detects YAML', () => {
    const code = 'name: my-app\nversion: 1.0\ndependencies:\n  express: ^4.0';
    assert.equal(detectLanguageFromCode(code), 'yaml');
  });

  it('detects JSX', () => {
    const code =
      'import React from "react";\nfunction App() { return <Component className="test" />; }';
    assert.equal(detectLanguageFromCode(code), 'jsx');
  });

  it('returns undefined for empty/whitespace input', () => {
    assert.equal(detectLanguageFromCode(''), undefined);
    assert.equal(detectLanguageFromCode('   \n  '), undefined);
  });
});
