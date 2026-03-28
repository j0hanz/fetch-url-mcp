import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseHTML } from 'linkedom';

import { normalizeTabContent } from '../src/transform/index.js';

function normalize(bodyHtml: string): string {
  const { document } = parseHTML(`<html><body>${bodyHtml}</body></html>`);
  normalizeTabContent(document);
  return document.body.innerHTML;
}

describe('normalizeTabContent — surface hidden panels', () => {
  it('removes display:none from tabpanel style', () => {
    const result = normalize(
      '<div role="tabpanel" style="display: none;">Panel content</div>'
    );
    assert.ok(
      result.includes('Panel content'),
      'Panel content must be present'
    );
    assert.ok(
      !result.includes('display: none') && !result.includes('display:none'),
      'display:none must be stripped from tabpanel'
    );
  });

  it('removes [hidden] attribute from tabpanel', () => {
    const result = normalize('<div role="tabpanel" hidden>Hidden panel</div>');
    assert.ok(result.includes('Hidden panel'), 'Panel content must be present');
    assert.ok(
      !result.includes(' hidden'),
      '[hidden] attribute must be removed from tabpanel'
    );
  });

  it('surfaces data-slot="tabContent" panels with display:none', () => {
    const result = normalize(
      '<div data-slot="tabContent" style="display:none;">Tab content</div>'
    );
    assert.ok(result.includes('Tab content'), 'Tab content must be present');
    assert.ok(
      !result.includes('display:none'),
      'display:none must be stripped'
    );
  });
});

describe('normalizeTabContent — tab trigger stripping', () => {
  it('removes unselected tab triggers', () => {
    const result = normalize(`
      <div role="tablist">
        <button role="tab">Preview</button>
        <button role="tab" aria-selected="true">Code</button>
      </div>
      <div role="tabpanel">Code panel content</div>
    `);
    assert.ok(
      !result.includes('Preview'),
      'Unselected tab trigger must be removed'
    );
    assert.ok(result.includes('Code panel content'), 'Panel content preserved');
  });

  it('preserves selected tab trigger (aria-selected="true")', () => {
    const result = normalize(`
      <div role="tablist">
        <button role="tab" aria-selected="true">Active Tab</button>
        <button role="tab">Inactive Tab</button>
      </div>
    `);
    assert.ok(
      result.includes('Active Tab'),
      'Selected tab trigger must be preserved'
    );
    assert.ok(
      !result.includes('Inactive Tab'),
      'Inactive tab trigger must be removed'
    );
  });

  it('preserves tab trigger with data-state="active"', () => {
    const result = normalize(`
      <div role="tablist">
        <button role="tab" data-state="active">Active</button>
        <button role="tab" data-state="inactive">Inactive</button>
      </div>
    `);
    assert.ok(result.includes('Active'), 'data-state=active tab preserved');
    assert.ok(!result.includes('Inactive'), 'data-state=inactive tab removed');
  });
});
