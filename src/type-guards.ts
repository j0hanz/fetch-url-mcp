export function isObject(
  value: unknown
): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isError(value: unknown): value is Error {
  const ErrorConstructor = Error as unknown as {
    isError(err: unknown): err is Error;
  };
  if (typeof ErrorConstructor.isError === 'function') {
    return ErrorConstructor.isError(value);
  }
  return value instanceof Error;
}

export interface LikeNode {
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
