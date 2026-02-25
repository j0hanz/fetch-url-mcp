export function isObject(
  value: unknown
): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isError(value: unknown): value is Error {
  const { isError: isErrorFn } = Error as {
    isError?: (err: unknown) => boolean;
  };
  return typeof isErrorFn === 'function'
    ? isErrorFn(value)
    : value instanceof Error;
}

interface LikeNode {
  readonly tagName?: string | undefined;
  readonly nodeName?: string | undefined;
  readonly nodeType?: number | undefined;
  readonly textContent?: string | null | undefined;
  readonly innerHTML?: string | undefined;
  readonly parentNode?: unknown;
  readonly childNodes?: ArrayLike<unknown>;
  readonly rawTagName?: string | undefined;
  getAttribute?(name: string): string | null;
}

export function isLikeNode(value: unknown): value is LikeNode {
  return isObject(value);
}
