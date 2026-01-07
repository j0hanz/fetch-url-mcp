export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown error';
}

export function createErrorWithCode(
  message: string,
  code: string
): NodeJS.ErrnoException {
  const error = new Error(message);
  return Object.assign(error, { code });
}

export function isSystemError(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    'code' in error &&
    typeof Reflect.get(error, 'code') === 'string'
  );
}
