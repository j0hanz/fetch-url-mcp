import { validateAndNormalizeUrl } from '../../utils/url-validator.js';

export function resolveRedirectTarget(
  baseUrl: string,
  location: string
): string {
  if (!URL.canParse(location, baseUrl)) {
    const error = new Error('Invalid redirect target') as NodeJS.ErrnoException;
    error.code = 'EBADREDIRECT';
    throw error;
  }

  const resolved = new URL(location, baseUrl);
  if (resolved.username || resolved.password) {
    const error = new Error(
      'Redirect target includes credentials'
    ) as NodeJS.ErrnoException;
    error.code = 'EBADREDIRECT';
    throw error;
  }

  return validateAndNormalizeUrl(resolved.href);
}
