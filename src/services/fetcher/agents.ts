import dns from 'node:dns';
import os from 'node:os';

import { Agent, type Dispatcher } from 'undici';

import { createErrorWithCode } from '../../utils/error-utils.js';
import { isRecord } from '../../utils/guards.js';

import { handleLookupResult } from './dns-selection.js';

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

  const timeout = createLookupTimeout(hostname, callback);
  const safeCallback = wrapLookupCallback(callback, timeout);

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

function createLookupTimeout(
  hostname: string,
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number
  ) => void
): {
  isDone: () => boolean;
  markDone: () => void;
} {
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

  return {
    isDone: (): boolean => done,
    markDone: (): void => {
      done = true;
      clearTimeout(timer);
    },
  };
}

function wrapLookupCallback(
  callback: (
    err: NodeJS.ErrnoException | null,
    address: string | dns.LookupAddress[],
    family?: number
  ) => void,
  timeout: {
    isDone: () => boolean;
    markDone: () => void;
  }
): (
  err: NodeJS.ErrnoException | null,
  address: string | dns.LookupAddress[],
  family?: number
) => void {
  return (err, address, family): void => {
    if (timeout.isDone()) return;
    timeout.markDone();
    callback(err, address, family);
  };
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
