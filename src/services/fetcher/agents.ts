import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';

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
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) {
      callback(err, address, family);
      return;
    }

    const addresses = Array.isArray(address) ? address : [{ address, family }];

    for (const addr of addresses) {
      const ip = typeof addr === 'string' ? addr : addr.address;
      if (isBlockedIp(ip)) {
        const error = new Error(
          `Blocked IP detected for ${hostname}`
        ) as NodeJS.ErrnoException;
        error.code = 'EBLOCKED';
        callback(error, address, family);
        return;
      }
    }

    callback(null, address, family);
  });
}

function getAgentOptions(): http.AgentOptions {
  const cpuCount = os.cpus().length;
  return {
    keepAlive: true,
    maxSockets: Math.max(cpuCount * 2, 25),
    maxFreeSockets: Math.max(Math.floor(cpuCount * 0.5), 10),
    timeout: 60000,
    scheduling: 'fifo',
    lookup: resolveDns,
  };
}

export const httpAgent = new http.Agent(getAgentOptions());
export const httpsAgent = new https.Agent(getAgentOptions());

export function destroyAgents(): void {
  httpAgent.destroy();
  httpsAgent.destroy();
}
