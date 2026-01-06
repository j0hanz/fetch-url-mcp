interface NormalizeOptions {
  readonly trimValues?: boolean;
}

export function normalizeHeaderRecord(
  headers: Record<string, string> | undefined,
  blockedHeaders: Set<string>,
  options: NormalizeOptions = {}
): Record<string, string> | undefined {
  if (!headers || Object.keys(headers).length === 0) return undefined;

  const normalized = normalizeHeaderEntries(headers, blockedHeaders, options);
  if (!hasHeaderEntries(normalized)) return undefined;

  return headersToRecord(normalized);
}

function normalizeHeaderEntries(
  headers: Record<string, string>,
  blockedHeaders: Set<string>,
  options: NormalizeOptions = {}
): Headers {
  const normalized = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (blockedHeaders.has(key.toLowerCase())) continue;
    setHeaderValue(normalized, key, value, options.trimValues === true);
  }
  return normalized;
}

function hasHeaderEntries(headers: Headers): boolean {
  return !headers.keys().next().done;
}

function headersToRecord(headers: Headers): Record<string, string> {
  return Object.fromEntries(headers.entries());
}

function setHeaderValue(
  headers: Headers,
  key: string,
  value: string,
  trimValue: boolean
): void {
  try {
    headers.set(key, trimValue ? value.trim() : value);
  } catch {
    // Ignore invalid header values
  }
}
