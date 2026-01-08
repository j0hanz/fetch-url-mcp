type IpSegment = number | string;

export function buildIpv4(
  parts: readonly [number, number, number, number]
): string {
  return parts.join('.');
}

export function buildIpv6(parts: readonly IpSegment[]): string {
  return parts.map(String).join(':');
}
