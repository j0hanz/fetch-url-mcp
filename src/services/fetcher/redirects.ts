import { validateAndNormalizeUrl } from '../../utils/url-validator.js';

export interface RedirectOptions {
  protocol?: string;
  hostname?: string;
  host?: string;
  href?: string;
  path?: string;
  port?: string | number;
  auth?: string;
}

function buildRedirectUrl(options: RedirectOptions): string | null {
  if (typeof options.href === 'string' && options.href.length > 0) {
    return options.href;
  }

  const protocol = options.protocol ?? 'http:';
  const hostname = options.hostname ?? options.host;
  if (!hostname) return null;

  const port = options.port ? `:${options.port}` : '';
  const path = options.path ?? '/';

  return `${protocol}//${hostname}${port}${path}`;
}

export function validateRedirectTarget(options: RedirectOptions): void {
  if (options.auth) {
    const error = new Error(
      'Redirect target includes credentials'
    ) as NodeJS.ErrnoException;
    error.code = 'EBADREDIRECT';
    throw error;
  }

  const targetUrl = buildRedirectUrl(options);
  if (!targetUrl) {
    const error = new Error('Invalid redirect target') as NodeJS.ErrnoException;
    error.code = 'EBADREDIRECT';
    throw error;
  }

  validateAndNormalizeUrl(targetUrl);
}
