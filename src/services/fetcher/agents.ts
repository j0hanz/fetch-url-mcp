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
  const normalizedOptions =
    typeof options === 'number' ? { family: options } : options;
  const useAll = Boolean(normalizedOptions.all);
  const resolvedFamily =
    normalizedOptions.family === 'IPv4'
      ? 4
      : normalizedOptions.family === 'IPv6'
        ? 6
        : normalizedOptions.family;

  dns.lookup(
    hostname,
    { ...normalizedOptions, all: true },
    (err, addresses) => {
      if (err) {
        callback(err, addresses as unknown as string | dns.LookupAddress[]);
        return;
      }

      const list = Array.isArray(addresses)
        ? addresses
        : [{ address: addresses, family: resolvedFamily ?? 4 }];

      for (const addr of list) {
        const ip = typeof addr === 'string' ? addr : addr.address;
        if (isBlockedIp(ip)) {
          const error = new Error(
            `Blocked IP detected for ${hostname}`
          ) as NodeJS.ErrnoException;
          error.code = 'EBLOCKED';
          callback(error, list);
          return;
        }
      }

      if (list.length === 0) {
        const error = new Error(
          `No DNS results returned for ${hostname}`
        ) as NodeJS.ErrnoException;
        error.code = 'ENODATA';
        callback(error, []);
        return;
      }

      if (useAll) {
        callback(null, list);
        return;
      }

      const first = list.at(0);
      if (!first) {
        const error = new Error(
          `No DNS results returned for ${hostname}`
        ) as NodeJS.ErrnoException;
        error.code = 'ENODATA';
        callback(error, []);
        return;
      }

      callback(null, first.address, first.family);
    }
  );
}

function getAgentOptions(): ConstructorParameters<typeof Agent>[0] {
  const cpuCount = os.cpus().length;
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
