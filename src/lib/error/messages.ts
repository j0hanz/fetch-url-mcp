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
  return new CodedError(
    `Blocked IP range: ${target}. ${detail}`,
    SystemErrors.EBLOCKED
  );
}

export function blockedHostError(hostname: string): CodedError {
  return new CodedError(
    `Blocked host: ${hostname}. Internal hosts are not allowed`,
    SystemErrors.EBLOCKED
  );
}

export function blockedCnameError(hostname: string, cname: string): CodedError {
  return new CodedError(
    `Blocked DNS CNAME detected for ${hostname}: ${cname}`,
    SystemErrors.EBLOCKED
  );
}

export function dnsTimeoutError(hostname: string): CodedError {
  return new CodedError(
    `DNS lookup timed out for ${hostname}`,
    SystemErrors.ETIMEOUT
  );
}

export function dnsNoResultsError(hostname: string): CodedError {
  return new CodedError(
    `No DNS results returned for ${hostname}`,
    SystemErrors.ENODATA
  );
}

export function invalidAddressFamilyError(hostname: string): CodedError {
  return new CodedError(
    `Invalid address family returned for ${hostname}`,
    SystemErrors.EINVAL
  );
}

export function invalidHostnameError(): CodedError {
  return new CodedError('Invalid hostname provided', SystemErrors.EINVAL);
}

export function invalidUrlError(): CodedError {
  return new CodedError('Invalid URL', SystemErrors.EINVAL);
}

// ── HTTP Redirect ──────────────────────────────────────────────────

export function invalidRedirectError(): CodedError {
  return new CodedError('Invalid redirect target', SystemErrors.EBADREDIRECT);
}

export function redirectCredentialsError(): CodedError {
  return new CodedError(
    'Redirect target includes credentials',
    SystemErrors.EBADREDIRECT
  );
}

export function unsupportedProtocolError(protocol: string): CodedError {
  return new CodedError(
    `Unsupported redirect protocol: ${protocol}`,
    SystemErrors.EUNSUPPORTEDPROTOCOL
  );
}
