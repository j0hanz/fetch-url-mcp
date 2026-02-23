import { BlockList, isIP } from 'node:net';

type IpFamily = 'ipv4' | 'ipv6';
type IpSegment = number | string;

function buildIpv4(parts: readonly [number, number, number, number]): string {
  return parts.join('.');
}

function buildIpv6(parts: readonly IpSegment[]): string {
  return parts.map(String).join(':');
}

const IPV6_ZERO = buildIpv6([0, 0, 0, 0, 0, 0, 0, 0]);
const IPV6_LOOPBACK = buildIpv6([0, 0, 0, 0, 0, 0, 0, 1]);
const IPV6_64_FF9B = buildIpv6(['64', 'ff9b', 0, 0, 0, 0, 0, 0]);
const IPV6_64_FF9B_1 = buildIpv6(['64', 'ff9b', 1, 0, 0, 0, 0, 0]);
const IPV6_2001 = buildIpv6(['2001', 0, 0, 0, 0, 0, 0, 0]);
const IPV6_2002 = buildIpv6(['2002', 0, 0, 0, 0, 0, 0, 0]);
const IPV6_FC00 = buildIpv6(['fc00', 0, 0, 0, 0, 0, 0, 0]);
const IPV6_FE80 = buildIpv6(['fe80', 0, 0, 0, 0, 0, 0, 0]);
const IPV6_FF00 = buildIpv6(['ff00', 0, 0, 0, 0, 0, 0, 0]);
const IPV6_MAPPED_PREFIX = '::ffff:';

type BlockedSubnet = Readonly<{
  subnet: string;
  prefix: number;
  family: IpFamily;
}>;

const BLOCKED_SUBNETS: readonly BlockedSubnet[] = [
  { subnet: buildIpv4([0, 0, 0, 0]), prefix: 8, family: 'ipv4' },
  { subnet: buildIpv4([10, 0, 0, 0]), prefix: 8, family: 'ipv4' },
  { subnet: buildIpv4([100, 64, 0, 0]), prefix: 10, family: 'ipv4' },
  { subnet: buildIpv4([127, 0, 0, 0]), prefix: 8, family: 'ipv4' },
  { subnet: buildIpv4([169, 254, 0, 0]), prefix: 16, family: 'ipv4' },
  { subnet: buildIpv4([172, 16, 0, 0]), prefix: 12, family: 'ipv4' },
  { subnet: buildIpv4([192, 168, 0, 0]), prefix: 16, family: 'ipv4' },
  { subnet: buildIpv4([224, 0, 0, 0]), prefix: 4, family: 'ipv4' },
  { subnet: buildIpv4([240, 0, 0, 0]), prefix: 4, family: 'ipv4' },
  { subnet: IPV6_ZERO, prefix: 128, family: 'ipv6' },
  { subnet: IPV6_LOOPBACK, prefix: 128, family: 'ipv6' },
  { subnet: IPV6_64_FF9B, prefix: 96, family: 'ipv6' },
  { subnet: IPV6_64_FF9B_1, prefix: 48, family: 'ipv6' },
  { subnet: IPV6_2001, prefix: 32, family: 'ipv6' },
  { subnet: IPV6_2002, prefix: 16, family: 'ipv6' },
  { subnet: IPV6_FC00, prefix: 7, family: 'ipv6' },
  { subnet: IPV6_FE80, prefix: 10, family: 'ipv6' },
  { subnet: IPV6_FF00, prefix: 8, family: 'ipv6' },
  { subnet: '::', prefix: 96, family: 'ipv6' },
];

export function createDefaultBlockList(): BlockList {
  const list = new BlockList();
  for (const entry of BLOCKED_SUBNETS) {
    list.addSubnet(entry.subnet, entry.prefix, entry.family);
  }
  return list;
}

function extractMappedIpv4(ip: string): string | null {
  if (!ip.startsWith(IPV6_MAPPED_PREFIX)) return null;
  const mapped = ip.slice(IPV6_MAPPED_PREFIX.length);
  return isIP(mapped) === 4 ? mapped : null;
}

function stripIpv6ZoneId(ip: string): string {
  const zoneIndex = ip.indexOf('%');
  if (zoneIndex <= 0) return ip;
  return ip.slice(0, zoneIndex);
}

export function normalizeIpForBlockList(
  input: string
): { ip: string; family: IpFamily } | null {
  const lowered = input.trim().toLowerCase();
  if (!lowered) return null;
  const normalizedInput = stripIpv6ZoneId(lowered);
  if (!normalizedInput) return null;

  const ipType = isIP(normalizedInput);
  if (ipType === 4) return { ip: normalizedInput, family: 'ipv4' };
  if (ipType === 6) {
    const mapped = extractMappedIpv4(normalizedInput);
    if (mapped) return { ip: mapped, family: 'ipv4' };
    return { ip: normalizedInput, family: 'ipv6' };
  }

  return null;
}
