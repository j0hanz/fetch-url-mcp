import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';

export { isIP };

export function buildIpv4(
  parts: readonly [number, number, number, number]
): string {
  return parts.join('.');
}

export function stripTrailingDots(value: string): string {
  let result = value;
  while (result.endsWith('.')) result = result.slice(0, -1);
  return result;
}

export function normalizeHostname(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;

  const lowered = trimmed.toLowerCase();
  if (isIP(lowered)) return stripTrailingDots(lowered);

  const ascii = domainToASCII(lowered);
  return ascii ? stripTrailingDots(ascii) : null;
}
