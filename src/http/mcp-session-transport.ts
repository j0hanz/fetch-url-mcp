import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';

export function createTimeoutController(): {
  clear: () => void;
  set: (timeout: NodeJS.Timeout | null) => void;
} {
  let initTimeout: NodeJS.Timeout | null = null;
  return {
    clear: (): void => {
      if (!initTimeout) return;
      clearTimeout(initTimeout);
      initTimeout = null;
    },
    set: (timeout: NodeJS.Timeout | null): void => {
      initTimeout = timeout;
    },
  };
}

export function createTransportAdapter(
  transport: StreamableHTTPServerTransport
): Transport {
  const adapter = buildTransportAdapter(transport);
  attachTransportAccessors(adapter, transport);
  return adapter;
}

function buildTransportAdapter(
  transport: StreamableHTTPServerTransport
): Transport {
  return {
    start: () => transport.start(),
    send: (message, options) => transport.send(message, options),
    close: () => transport.close(),
  };
}

function attachTransportAccessors(
  adapter: Transport,
  transport: StreamableHTTPServerTransport
): void {
  Object.defineProperties(adapter, {
    onclose: {
      get: () => transport.onclose,
      set: (handler: (() => void) | undefined) => {
        transport.onclose = handler;
      },
      enumerable: true,
      configurable: true,
    },
    onerror: {
      get: () => transport.onerror,
      set: (handler: ((error: Error) => void) | undefined) => {
        transport.onerror = handler;
      },
      enumerable: true,
      configurable: true,
    },
    onmessage: {
      get: () => transport.onmessage,
      set: (handler: Transport['onmessage']) => {
        transport.onmessage = handler;
      },
      enumerable: true,
      configurable: true,
    },
    sessionId: {
      get: () => transport.sessionId,
      enumerable: true,
      configurable: true,
    },
  });
}
