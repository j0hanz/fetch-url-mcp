import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { acceptsEventStream, ensurePostAcceptHeader } from '../dist/http.js';

type AcceptCase = {
  header?: string;
  expected: string;
};

type EventStreamCase = {
  header?: string;
  expected: boolean;
};

function runPostAcceptCase(testCase: AcceptCase) {
  const req = {
    headers: testCase.header ? { accept: testCase.header } : {},
  } as never;

  ensurePostAcceptHeader(req);

  assert.equal(req.headers.accept, testCase.expected);
}

function runEventStreamCase(testCase: EventStreamCase) {
  const req = {
    headers: testCase.header ? { accept: testCase.header } : {},
  } as never;

  assert.equal(acceptsEventStream(req), testCase.expected);
}

describe('accept-policy', () => {
  it('defaults POST Accept when missing', () => {
    runPostAcceptCase({ expected: 'application/json, text/event-stream' });
  });

  it('defaults POST Accept when */*', () => {
    runPostAcceptCase({
      header: '*/*',
      expected: 'application/json, text/event-stream',
    });
  });

  it('defaults POST Accept when incomplete', () => {
    runPostAcceptCase({
      header: 'application/json',
      expected: 'application/json, text/event-stream',
    });
  });

  it('preserves POST Accept when already includes JSON and SSE', () => {
    runPostAcceptCase({
      header: 'application/json, text/event-stream',
      expected: 'application/json, text/event-stream',
    });
  });

  it('acceptsEventStream returns false when Accept is missing', () => {
    runEventStreamCase({ expected: false });
  });

  it('acceptsEventStream returns true when Accept includes SSE', () => {
    runEventStreamCase({ header: 'text/event-stream', expected: true });
  });
});
