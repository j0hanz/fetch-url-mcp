import dns from 'node:dns';
import os from 'node:os';

import { Agent, type Dispatcher } from 'undici';

import { createErrorWithCode } from '../../utils/error-utils.js';
import { isRecord } from '../../utils/guards.js';
import { isBlockedIp } from '../../utils/url-validator.js';

const DNS_LOOKUP_TIMEOUT_MS = 5000;

function resolveDns(
  hostname: string,
  options: dns.LookupOptions,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number
  ) => void
): void {
  const { normalizedOptions, useAll, resolvedFamily } =
    buildLookupContext(options);
  const lookupOptions = buildLookupOptions(normalizedOptions);

  let done = false;
  const timer = setTimeout(() => {
    if (done) return;
    done = true;
    callback(
      createErrorWithCode(`DNS lookup timed out for ${hostname}`, 'ETIMEOUT'),
      []
    );
  }, DNS_LOOKUP_TIMEOUT_MS);
  timer.unref();

  const safeCallback = (
    err: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number
  ): void => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    callback(err, address, family);
  };

  dns.lookup(
    hostname,
    lookupOptions,
    createLookupCallback(hostname, resolvedFamily, useAll, safeCallback)
  );
}

function normalizeLookupOptions(
  options: dns.LookupOptions | number
): dns.LookupOptions {
  return typeof options === 'number' ? { family: options } : options;
}

function buildLookupContext(options: dns.LookupOptions | number): {
  normalizedOptions: dns.LookupOptions;
  useAll: boolean;
  resolvedFamily: number | undefined;
} {
  const normalizedOptions = normalizeLookupOptions(options);
  return {
    normalizedOptions,
    useAll: Boolean(normalizedOptions.all),
    resolvedFamily: resolveFamily(normalizedOptions.family),
  };
}

const DEFAULT_DNS_ORDER: dns.LookupOptions['order'] = 'verbatim';

function resolveResultOrder(
  options: dns.LookupOptions
): dns.LookupOptions['order'] {
  if (options.order) return options.order;
  const legacyVerbatim = getLegacyVerbatim(options);
  if (legacyVerbatim !== undefined) {
    return legacyVerbatim ? 'verbatim' : 'ipv4first';
  }
  return DEFAULT_DNS_ORDER;
}

function getLegacyVerbatim(options: dns.LookupOptions): boolean | undefined {
  if (isRecord(options)) {
    // eslint-disable-next-line @typescript-eslint/dot-notation
    const legacy = options['verbatim'];
    return typeof legacy === 'boolean' ? legacy : undefined;
  }
  return undefined;
}

function buildLookupOptions(
  normalizedOptions: dns.LookupOptions
): dns.LookupOptions {
  return {
    family: normalizedOptions.family,
    hints: normalizedOptions.hints,
    all: true,
    order: resolveResultOrder(normalizedOptions),
  };
}

function createLookupCallback(
  hostname: string,
  resolvedFamily: number | undefined,
  useAll: boolean,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number
  ) => void
): (
  err: NodeJS.ErrnoException | null,
  addresses: string | dns.LookupAddress[]
) => void {
  return (err, addresses) => {
    handleLookupResult(
      err,
      addresses,
      hostname,
      resolvedFamily,
      useAll,
      callback
    );
  };
}

function resolveFamily(
  family: dns.LookupOptions['family']
): number | undefined {
  if (family === 'IPv4') return 4;
  if (family === 'IPv6') return 6;
  return family;
}

function normalizeLookupResults(
  addresses: string | dns.LookupAddress[],
  family: number | undefined
): dns.LookupAddress[] {
  if (Array.isArray(addresses)) {
    return addresses;
  }

  return [{ address: addresses, family: family ?? 4 }];
}

function handleLookupResult(
  error: NodeJS.ErrnoException | null,
  addresses: string | dns.LookupAddress[],
  hostname: string,
  resolvedFamily: number | undefined,
  useAll: boolean,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number
  ) => void
): void {
  if (error) {
    callback(error, addresses);
    return;
  }

  const list = normalizeLookupResults(addresses, resolvedFamily);
  const invalidFamilyError = findInvalidFamilyError(list, hostname);
  if (invalidFamilyError) {
    callback(invalidFamilyError, list);
    return;
  }

  const blockedError = findBlockedIpError(list, hostname);
  if (blockedError) {
    callback(blockedError, list);
    return;
  }

  const selection = selectLookupResult(list, useAll, hostname);
  if (selection.error) {
    callback(selection.error, selection.fallback);
    return;
  }

  callback(null, selection.address, selection.family);
}

function selectLookupResult(
  list: dns.LookupAddress[],
  useAll: boolean,
  hostname: string
): {
  address: string | dns.LookupAddress[];
  family?: number;
  error?: NodeJS.ErrnoException;
  fallback: dns.LookupAddress[];
} {
  if (list.length === 0) {
    return {
      error: createNoDnsResultsError(hostname),
      fallback: [],
      address: [],
    };
  }

  if (useAll) {
    return { address: list, fallback: list };
  }

  const first = list.at(0);
  if (!first) {
    return {
      error: createNoDnsResultsError(hostname),
      fallback: [],
      address: [],
    };
  }

  return {
    address: first.address,
    family: first.family,
    fallback: list,
  };
}

function findBlockedIpError(
  list: dns.LookupAddress[],
  hostname: string
): NodeJS.ErrnoException | null {
  for (const addr of list) {
    const ip = typeof addr === 'string' ? addr : addr.address;
    if (!isBlockedIp(ip)) {
      continue;
    }

    return createErrorWithCode(
      `Blocked IP detected for ${hostname}`,
      'EBLOCKED'
    );
  }

  return null;
}

function findInvalidFamilyError(
  list: dns.LookupAddress[],
  hostname: string
): NodeJS.ErrnoException | null {
  for (const addr of list) {
    const family = typeof addr === 'string' ? 0 : addr.family;
    if (family === 4 || family === 6) continue;
    return createErrorWithCode(
      `Invalid address family returned for ${hostname}`,
      'EINVAL'
    );
  }

  return null;
}

function createNoDnsResultsError(hostname: string): NodeJS.ErrnoException {
  return createErrorWithCode(
    `No DNS results returned for ${hostname}`,
    'ENODATA'
  );
}

function getAgentOptions(): ConstructorParameters<typeof Agent>[0] {
  const cpuCount = os.availableParallelism();
  return {
    keepAliveTimeout: 60000,
    connections: Math.max(cpuCount * 2, 25),
    pipelining: 1,
    connect: { lookup: resolveDns },
  };
}

export const dispatcher: Dispatcher = new Agent(getAgentOptions());

export function destroyAgents(): void {
  void dispatcher.close();
}
