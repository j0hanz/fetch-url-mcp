import { isIP, SocketAddress } from 'node:net';
import { domainToASCII } from 'node:url';

export function normalizeHost(value: string): string | null {
  const trimmedLower = trimToNull(value)?.toLowerCase();
  if (!trimmedLower) return null;

  const first = takeFirstHostValue(trimmedLower);
  if (!first) return null;

  const normalizedSocketAddress = normalizeSocketAddress(first);
  if (normalizedSocketAddress) return normalizedSocketAddress;

  const parsed = parseHostWithUrl(first);
  if (parsed) return parsed;

  const normalizedBracketedIpv6 = normalizeBracketedIpv6(first);
  if (normalizedBracketedIpv6) return normalizedBracketedIpv6;

  if (isIpV6Literal(first)) {
    return normalizeHostname(first);
  }

  return normalizeHostname(stripPortIfPresent(first));
}

function takeFirstHostValue(value: string): string | null {
  // Faster than split(',') for large forwarded headers; preserves behavior.
  const commaIndex = value.indexOf(',');
  const first = commaIndex === -1 ? value : value.slice(0, commaIndex);
  return first ? trimToNull(first) : null;
}

function stripIpv6Brackets(value: string): string | null {
  if (!value.startsWith('[')) return null;
  const end = value.indexOf(']');
  if (end === -1) return null;
  return value.slice(1, end);
}

function stripPortIfPresent(value: string): string {
  const colonIndex = value.indexOf(':');
  if (colonIndex === -1) return value;
  return value.slice(0, colonIndex);
}

function isIpV6Literal(value: string): boolean {
  return isIP(value) === 6;
}

function normalizeSocketAddress(value: string): string | null {
  const socketAddress = SocketAddress.parse(value);
  if (!socketAddress) return null;
  return normalizeHostname(socketAddress.address);
}

function normalizeBracketedIpv6(value: string): string | null {
  const ipv6 = stripIpv6Brackets(value);
  if (!ipv6) return null;
  return normalizeHostname(ipv6);
}

function normalizeHostname(value: string): string | null {
  const trimmed = trimToNull(value)?.toLowerCase();
  if (!trimmed) return null;

  if (isIP(trimmed)) return stripTrailingDots(trimmed);

  const ascii = domainToASCII(trimmed);
  return ascii ? stripTrailingDots(ascii) : null;
}

function parseHostWithUrl(value: string): string | null {
  const candidateUrl = `http://${value}`;
  if (!URL.canParse(candidateUrl)) return null;

  try {
    const parsed = new URL(candidateUrl);
    return normalizeHostname(parsed.hostname);
  } catch {
    return null;
  }
}

function trimToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function stripTrailingDots(value: string): string {
  // Keep loop (rather than regex) to preserve exact behavior and avoid hidden allocations.
  let result = value;
  while (result.endsWith('.')) result = result.slice(0, -1);
  return result;
}
