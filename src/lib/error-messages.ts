import {
  EBADREDIRECT,
  EBLOCKED,
  EINVAL,
  ENODATA,
  ETIMEOUT,
  EUNSUPPORTEDPROTOCOL,
} from './error-codes.js';
import { CodedError } from './utils.js';

// ── DNS / Network ──────────────────────────────────────────────────

export function blockedIpError(
  target: string,
  reason: 'cloud-metadata' | 'private'
): CodedError {
  const detail =
    reason === 'cloud-metadata'
      ? 'Cloud metadata endpoints are not allowed'
      : 'Private IPs are not allowed';
  const error = new CodedError(
    `Blocked IP range: ${target}. ${detail}`,
    EBLOCKED
  );
  return error;
}

export function blockedHostError(hostname: string): CodedError {
  const error = new CodedError(
    `Blocked host: ${hostname}. Internal hosts are not allowed`,
    EBLOCKED
  );
  return error;
}

export function blockedCnameError(hostname: string, cname: string): CodedError {
  const error = new CodedError(
    `Blocked DNS CNAME detected for ${hostname}: ${cname}`,
    EBLOCKED
  );
  return error;
}

export function dnsTimeoutError(hostname: string): CodedError {
  const error = new CodedError(
    `DNS lookup timed out for ${hostname}`,
    ETIMEOUT
  );
  return error;
}

export function dnsNoResultsError(hostname: string): CodedError {
  const error = new CodedError(
    `No DNS results returned for ${hostname}`,
    ENODATA
  );
  return error;
}

export function invalidAddressFamilyError(hostname: string): CodedError {
  const error = new CodedError(
    `Invalid address family returned for ${hostname}`,
    EINVAL
  );
  return error;
}

export function invalidHostnameError(): CodedError {
  const error = new CodedError('Invalid hostname provided', EINVAL);
  return error;
}

export function invalidUrlError(): CodedError {
  const error = new CodedError('Invalid URL', EINVAL);
  return error;
}

// ── HTTP Redirect ──────────────────────────────────────────────────

export function invalidRedirectError(): CodedError {
  const error = new CodedError('Invalid redirect target', EBADREDIRECT);
  return error;
}

export function redirectCredentialsError(): CodedError {
  const error = new CodedError(
    'Redirect target includes credentials',
    EBADREDIRECT
  );
  return error;
}

export function unsupportedProtocolError(protocol: string): CodedError {
  const error = new CodedError(
    `Unsupported redirect protocol: ${protocol}`,
    EUNSUPPORTEDPROTOCOL
  );
  return error;
}
