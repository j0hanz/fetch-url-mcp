1. Runtime & Build Snapshot

- Target: Node.js (TypeScript)
- Module System: ESM
- Concurrency Model: Worker threads (transform-worker)
- Limits: `MAX_HTML_BYTES` (10MB), `MAX_INLINE_CONTENT_CHARS`

1. Baseline Measurement Plan

- Metrics: CPU proxy (time spent in `cleanupMarkdownArtifacts` and `removeNoiseFromHtml`), allocation churn (objects created per line).
- Measurement points: `cleanupMarkdownArtifacts` loop, `removeNoiseFromHtml` DOM traversal.
- Acceptance gates: Reduced object allocations in hot loops, no behavior change in tests.

1. Hot Path Map (Ranked)
1. `cleanupMarkdownArtifacts` (src/markdown-cleanup.ts): Called for every markdown string. `findNextLine` and `handleUnfencedLine` allocate objects `{ line, nextIndex }` and `{ fenceMarker, buffer }` for _every single line_ of the document. This causes massive GC churn on large documents.
1. `removeNoiseFromHtml` (src/dom-noise-removal.ts): `document.querySelectorAll` creates NodeLists, and `Array.from` creates arrays. `isNoiseElement` is called for many nodes.

1. Cost Model

- `findNextLine`: Allocates 1 object per line. For a 10,000 line document, that's 10,000 objects.
- `handleUnfencedLine`: Allocates 1 object per line. Another 10,000 objects.
- Total: 20,000+ short-lived objects per document just for line iteration.

1. Optimization Strategy (Tickets + Rejected Optimizations)

- Ticket 1: Inline `findNextLine` and `handleUnfencedLine` in `cleanupMarkdownArtifacts` to eliminate per-line object allocations.
- Ticket 2: Optimize `removeNodes` in `src/dom-noise-removal.ts` to avoid unnecessary array conversions if possible (though `querySelectorAll` returns a NodeList which is ArrayLike, so `Array.from` is sometimes needed, but we can iterate it directly).

1. Refactored Code
   (See changes in `src/markdown-cleanup.ts` and `src/dom-noise-removal.ts`)

2. Performance Rationale

- Eliminating per-line object allocations in `cleanupMarkdownArtifacts` directly reduces GC pressure and improves throughput for large markdown files.

1. Validation Checklist (Ship Gate)

- [x] `npm run test` passes.
- [x] No behavior changes.
