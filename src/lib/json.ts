const MAX_DEPTH = 20;
const MAX_DEPTH_ERROR = `stableStringify: Max depth (${MAX_DEPTH}) exceeded`;
const CIRCULAR_ERROR = 'stableStringify: Circular reference detected';

function compareObjectKeys(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function getSortedObjectKeys(obj: object): string[] {
  return Object.keys(obj).sort(compareObjectKeys);
}

function processValue(
  obj: unknown,
  depth: number,
  seen: WeakSet<object>
): unknown {
  if (typeof obj !== 'object' || obj === null) {
    return obj;
  }

  // Depth guard
  if (depth > MAX_DEPTH) {
    throw new Error(MAX_DEPTH_ERROR);
  }

  // Cycle detection (track active recursion stack only).
  if (seen.has(obj)) {
    throw new Error(CIRCULAR_ERROR);
  }
  seen.add(obj);

  try {
    if (Array.isArray(obj)) {
      return obj.map((item) => processValue(item, depth + 1, seen));
    }

    const keys = getSortedObjectKeys(obj);
    const record = obj as Record<string, unknown>;
    const sortedObj: Record<string, unknown> = {};

    for (const key of keys) {
      sortedObj[key] = processValue(record[key], depth + 1, seen);
    }

    return sortedObj;
  } finally {
    seen.delete(obj);
  }
}

export function stableStringify(
  obj: unknown,
  depth = 0,
  seen = new WeakSet()
): string {
  const processed = processValue(obj, depth, seen);
  return JSON.stringify(processed);
}
