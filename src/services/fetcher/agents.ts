import dns from 'node:dns';
import os from 'node:os';

import { Agent } from 'undici';

import { isBlockedIp } from '../../utils/url-validator.js';

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
  dns.lookup(
    hostname,
    { ...normalizedOptions, all: true },
    createLookupCallback(hostname, resolvedFamily, useAll, callback)
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

    const error = new Error(
      `Blocked IP detected for ${hostname}`
    ) as NodeJS.ErrnoException;
    error.code = 'EBLOCKED';
    return error;
  }

  return null;
}

function createNoDnsResultsError(hostname: string): NodeJS.ErrnoException {
  const error = new Error(
    `No DNS results returned for ${hostname}`
  ) as NodeJS.ErrnoException;
  error.code = 'ENODATA';
  return error;
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

export const dispatcher = new Agent(getAgentOptions());

export function destroyAgents(): void {
  void dispatcher.close();
}
