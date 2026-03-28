import { CodedError } from './classes.js';
import { SystemErrors } from './codes.js';

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
    SystemErrors.EBLOCKED
  );
  return error;
}

export function blockedHostError(hostname: string): CodedError {
  const error = new CodedError(
    `Blocked host: ${hostname}. Internal hosts are not allowed`,
    SystemErrors.EBLOCKED
  );
  return error;
}

export function blockedCnameError(hostname: string, cname: string): CodedError {
  const error = new CodedError(
    `Blocked DNS CNAME detected for ${hostname}: ${cname}`,
    SystemErrors.EBLOCKED
  );
  return error;
}

export function dnsTimeoutError(hostname: string): CodedError {
  const error = new CodedError(
    `DNS lookup timed out for ${hostname}`,
    SystemErrors.ETIMEOUT
  );
  return error;
}

export function dnsNoResultsError(hostname: string): CodedError {
  const error = new CodedError(
    `No DNS results returned for ${hostname}`,
    SystemErrors.ENODATA
  );
  return error;
}

export function invalidAddressFamilyError(hostname: string): CodedError {
  const error = new CodedError(
    `Invalid address family returned for ${hostname}`,
    SystemErrors.EINVAL
  );
  return error;
}

export function invalidHostnameError(): CodedError {
  const error = new CodedError(
    'Invalid hostname provided',
    SystemErrors.EINVAL
  );
  return error;
}

export function invalidUrlError(): CodedError {
  const error = new CodedError('Invalid URL', SystemErrors.EINVAL);
  return error;
}

// ── HTTP Redirect ──────────────────────────────────────────────────

export function invalidRedirectError(): CodedError {
  const error = new CodedError(
    'Invalid redirect target',
    SystemErrors.EBADREDIRECT
  );
  return error;
}

export function redirectCredentialsError(): CodedError {
  const error = new CodedError(
    'Redirect target includes credentials',
    SystemErrors.EBADREDIRECT
  );
  return error;
}

export function unsupportedProtocolError(protocol: string): CodedError {
  const error = new CodedError(
    `Unsupported redirect protocol: ${protocol}`,
    SystemErrors.EUNSUPPORTEDPROTOCOL
  );
  return error;
}
