const MAX_DEPTH = 20;
const MAX_DEPTH_ERROR = `stableStringify: Max depth (${MAX_DEPTH}) exceeded`;
const CIRCULAR_ERROR = 'stableStringify: Circular reference detected';

function processChildValue(
  value: unknown,
  depth: number,
  seen: WeakSet<object>
): unknown {
  return processValue(value, depth + 1, seen);
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
      return obj.map((item) => processChildValue(item, depth, seen));
    }

    const keys = Object.keys(obj).sort((a, b) => {
      if (a === b) return 0;
      return a < b ? -1 : 1;
    });
    const record = obj as Record<string, unknown>;
    const sortedObj: Record<string, unknown> = {};

    for (const key of keys) {
      sortedObj[key] = processChildValue(record[key], depth, seen);
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
