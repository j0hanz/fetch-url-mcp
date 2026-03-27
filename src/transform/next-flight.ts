import { detectLanguageFromCode } from './html-translators.js';

interface FlightApiRow {
  readonly attribute: string;
  readonly type: string;
  readonly description: string;
  readonly defaultValue: string;
}

interface FlightPayloadData {
  readonly installationCommands?: string[];
  readonly importCommands?: string[];
  readonly apiTables: Map<string, string>;
  readonly demoCodeBlocks: Map<string, string>;
  readonly mermaidDiagrams: Map<string, string>;
}

const NEXT_FLIGHT_PAYLOAD_RE =
  /self\.__next_f\.push\(\[1,"((?:\\.|[^"\\])*)"\]\)<\/script>/gs;
const TEMPLATE_ASSIGNMENT_RE = /([A-Za-z_$][\w$]*)=`([\s\S]*?)`;/g;
const FLIGHT_INSTALL_RE =
  /commands:\{cli:"([^"]+)",npm:"([^"]+)",yarn:"([^"]+)",pnpm:"([^"]+)",bun:"([^"]+)"\}/;
const FLIGHT_IMPORT_RE = /commands:\{main:'([^']+)',individual:'([^']+)'\}/;
const FLIGHT_DEMO_RE =
  /title:"((?:\\.|[^"\\])*)",files:([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g;
const FLIGHT_API_RE =
  /children:"([^"]+)"\}\),`\\n`,\(0,e\.jsx\)\(o,\{data:\[([\s\S]*?)\]\}\)/g;
const FLIGHT_API_ROW_RE =
  /attribute:"((?:\\.|[^"\\])*)",type:"((?:\\.|[^"\\])*)",description:"((?:\\.|[^"\\])*)",default:"((?:\\.|[^"\\])*)"/g;
const FLIGHT_MERMAID_SECTION_RE =
  /_jsx\(Heading,\{\s*level:"[1-6]",\s*id:"[^"]+",\s*children:"((?:\\.|[^"\\])*)"\s*\}\)(?:(?!_jsx\(Heading,\{)[\s\S]){0,12000}?_jsx\(Mermaid,\{\s*chart:"((?:\\.|[^"\\])*)"\s*\}\)/g;

function decodeHtmlEntities(value: string): string {
  return value
    .replace(/&#39;|&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function decodeJsonStringLiteral(value: string): string | undefined {
  const decoded: unknown = JSON.parse(`"${value}"`);
  return typeof decoded === 'string' ? decoded : undefined;
}

function decodeFlightStringValue(value: string): string {
  try {
    return decodeJsonStringLiteral(value) ?? decodeHtmlEntities(value);
  } catch {
    return decodeHtmlEntities(value);
  }
}

function decodeNextFlightPayloads(html: string): string[] {
  const payloads: string[] = [];

  for (const match of html.matchAll(NEXT_FLIGHT_PAYLOAD_RE)) {
    const rawPayload = match[1];
    if (!rawPayload) continue;

    try {
      const decodedPayload = decodeJsonStringLiteral(rawPayload);
      if (decodedPayload) payloads.push(decodedPayload);
    } catch {
      // Ignore malformed payload fragments and continue with the rest.
    }
  }

  return payloads;
}

function parseObjectEntries(body: string): Map<string, string> {
  const entries = new Map<string, string>();
  const segments: string[] = [];
  let currentSegment = '';
  let inString = false;
  let escapeNext = false;
  let nestLevel = 0;

  for (const char of body) {
    if (escapeNext) {
      escapeNext = false;
      currentSegment += char;
      continue;
    }
    if (char === '\\') {
      escapeNext = true;
      currentSegment += char;
      continue;
    }
    if (char === '"' || char === "'") {
      inString = !inString;
    }
    if (!inString) {
      if (char === '{' || char === '[' || char === '(') nestLevel++;
      else if (char === '}' || char === ']' || char === ')') nestLevel--;
    }
    if (char === ',' && !inString && nestLevel === 0) {
      segments.push(currentSegment);
      currentSegment = '';
    } else {
      currentSegment += char;
    }
  }
  if (currentSegment) segments.push(currentSegment);

  for (const part of segments) {
    const entryMatch =
      /(?:"((?:\\.|[^"\\])*)"|([A-Za-z_$][\w$]*)):([A-Za-z_$][\w$]*)$/.exec(
        part.trim()
      );
    const key = entryMatch?.[1] ?? entryMatch?.[2];
    const value = entryMatch?.[3];
    if (key && value) entries.set(key, value);
  }
  return entries;
}

function parseFlightObjectRefs(text: string): {
  templateMap: Map<string, string>;
  aliasMap: Map<string, string>;
  objectMaps: Map<string, Map<string, string>>;
} {
  const templateMap = new Map<string, string>();
  const aliasMap = new Map<string, string>();
  const objectMaps = new Map<string, Map<string, string>>();

  for (const match of text.matchAll(TEMPLATE_ASSIGNMENT_RE)) {
    const name = match[1];
    const code = match[2];
    if (name && code) templateMap.set(name, decodeHtmlEntities(code));
  }

  const regex = /([A-Za-z_$][\w$]*)=\{/g;
  let match;
  while ((match = regex.exec(text)) !== null) {
    const objectName = match[1];
    if (!objectName) continue;

    const start = regex.lastIndex;
    let inString = false;
    let escapeLevel = false;
    let depth = 1;
    let end = -1;

    for (let i = start; i < text.length; i++) {
      const char = text[i];
      if (escapeLevel) {
        escapeLevel = false;
        continue;
      }
      if (char === '\\') {
        escapeLevel = true;
        continue;
      }
      if (char === '"' || char === "'") {
        inString = !inString;
        continue;
      }
      if (!inString) {
        if (char === '{') depth++;
        else if (char === '}') depth--;
        if (depth === 0) {
          end = i;
          break;
        }
      }
    }

    if (end === -1) continue;

    const body = text.substring(start, end).trim();
    if (!body) continue;

    const spreadMatch = /^\.\.\.([A-Za-z_$][\w$]*)$/.exec(body);
    if (spreadMatch?.[1]) {
      aliasMap.set(objectName, spreadMatch[1]);
      continue;
    }

    const entries = parseObjectEntries(body);
    if (entries.size > 0) objectMaps.set(objectName, entries);
  }

  return { templateMap, aliasMap, objectMaps };
}

function resolveFlightCodeRef(
  name: string | undefined,
  refs: ReturnType<typeof parseFlightObjectRefs>,
  seen = new Set<string>()
): string | undefined {
  if (!name || seen.has(name)) return undefined;
  seen.add(name);

  const direct = refs.templateMap.get(name);
  if (direct) return direct;

  const alias = refs.aliasMap.get(name);
  if (alias) return resolveFlightCodeRef(alias, refs, seen);

  const objectMap = refs.objectMaps.get(name);
  if (!objectMap) return undefined;

  for (const ref of objectMap.values()) {
    const resolved = resolveFlightCodeRef(ref, refs, seen);
    if (resolved) return resolved;
  }

  return undefined;
}

function escapeMarkdownTableCell(value: string): string {
  const normalized = decodeHtmlEntities(value).replace(/\s+/g, ' ').trim();
  return (normalized || '-').replace(/\|/g, '\\|');
}

function buildMarkdownTable(rows: readonly FlightApiRow[]): string {
  if (rows.length === 0) return '';

  const lines = [
    '| Prop | Type | Description | Default |',
    '| ---- | ---- | ----------- | ------- |',
  ];

  for (const row of rows) {
    lines.push(
      `| ${escapeMarkdownTableCell(row.attribute)} | ${escapeMarkdownTableCell(row.type)} | ${escapeMarkdownTableCell(row.description)} | ${escapeMarkdownTableCell(row.defaultValue)} |`
    );
  }

  return lines.join('\n');
}

function buildCodeBlock(code: string): string {
  const trimmed = code.trim();
  if (!trimmed) return '';

  const language = detectLanguageFromCode(trimmed) ?? 'tsx';
  return `\`\`\`${language}\n${trimmed}\n\`\`\``;
}

function buildMermaidBlock(chart: string): string {
  const normalized = decodeFlightStringValue(chart).trim();
  if (!normalized) return '';

  return `\`\`\`mermaid\n${normalized}\n\`\`\``;
}

function normalizeSupplementHeadingText(value: string): string {
  return value
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function getMarkdownHeadingInfo(
  line: string
): { level: number; title: string } | null {
  const match = /^(#{1,6})\s+(.+?)(?:\s+#*)?\s*$/.exec(line.trim());
  if (!match) return null;

  return {
    level: match[1]?.length ?? 0,
    title: normalizeSupplementHeadingText(match[2] ?? ''),
  };
}

function findMarkdownSection(
  lines: string[],
  title: string
): { start: number; end: number } | null {
  const target = normalizeSupplementHeadingText(title);

  const startIndex = lines.findIndex((line) => {
    const heading = getMarkdownHeadingInfo(line);
    return heading?.title === target;
  });

  if (startIndex === -1) return null;

  const startHeading = getMarkdownHeadingInfo(lines[startIndex] ?? '');
  if (!startHeading) return null;

  let end = lines.length;
  for (let j = startIndex + 1; j < lines.length; j += 1) {
    const nextHeading = getMarkdownHeadingInfo(lines[j] ?? '');
    if (nextHeading && nextHeading.level <= startHeading.level) {
      end = j;
      break;
    }
  }

  return { start: startIndex, end };
}

function getSectionBody(
  lines: string[],
  section: { start: number; end: number }
): string {
  return lines
    .slice(section.start + 1, section.end)
    .join('\n')
    .trim();
}

function updateMarkdownSection(
  lines: string[],
  title: string,
  strategy: (sectionBody: string) => string | null
): boolean {
  const section = findMarkdownSection(lines, title);
  if (!section) return false;

  const bodyText = getSectionBody(lines, section);
  const nextBody = strategy(bodyText);
  if (nextBody === null) return false;

  const replacement =
    nextBody.trim().length > 0
      ? ['', ...nextBody.trim().split('\n'), '']
      : [''];
  lines.splice(
    section.start + 1,
    section.end - section.start - 1,
    ...replacement
  );
  return true;
}

interface UpsertOptions {
  readonly exclusionPattern?: RegExp | string;
  readonly replacement?: boolean;
}

function upsertMarkdownSection(
  lines: string[],
  title: string,
  content: string,
  options?: UpsertOptions
): boolean {
  return updateMarkdownSection(lines, title, (bodyText) => {
    if (options?.replacement) return content;

    if (options?.exclusionPattern) {
      if (options.exclusionPattern instanceof RegExp) {
        if (options.exclusionPattern.test(bodyText)) return null;
      } else if (bodyText.includes(options.exclusionPattern)) {
        return null;
      }
    }

    return bodyText ? `${bodyText}\n\n${content.trim()}` : content.trim();
  });
}

function parseFlightApiRow(rowMatch: RegExpMatchArray): FlightApiRow | null {
  const attribute = rowMatch[1];
  const type = rowMatch[2];
  const description = rowMatch[3];
  const defaultValue = rowMatch[4];
  if (
    !attribute ||
    !type ||
    description === undefined ||
    defaultValue === undefined
  ) {
    return null;
  }
  return { attribute, type, description, defaultValue };
}

function extractFlightApiTables(text: string): Map<string, string> {
  const apiTables = new Map<string, string>();
  for (const match of text.matchAll(FLIGHT_API_RE)) {
    const title = match[1];
    const rawRows = match[2] ?? '';
    if (!title) continue;

    const rows: FlightApiRow[] = [];
    for (const rowMatch of rawRows.matchAll(FLIGHT_API_ROW_RE)) {
      const row = parseFlightApiRow(rowMatch);
      if (row) rows.push(row);
    }

    const table = buildMarkdownTable(rows);
    if (table) apiTables.set(title, table);
  }
  return apiTables;
}

function extractFlightMermaidDiagrams(text: string): Map<string, string> {
  const mermaidDiagrams = new Map<string, string>();
  for (const match of text.matchAll(FLIGHT_MERMAID_SECTION_RE)) {
    const title = match[1] ? decodeFlightStringValue(match[1]).trim() : '';
    const chart = match[2] ? buildMermaidBlock(match[2]) : '';
    if (title && chart) mermaidDiagrams.set(title, chart);
  }
  return mermaidDiagrams;
}

function extractFlightDemoBlocks(
  text: string,
  refs: ReturnType<typeof parseFlightObjectRefs>
): Map<string, string> {
  const demoCodeBlocks = new Map<string, string>();
  for (const match of text.matchAll(FLIGHT_DEMO_RE)) {
    const title = match[1];
    const objectName = match[2];
    const key = match[3];
    const ref = objectName
      ? refs.objectMaps.get(objectName)?.get(key ?? '')
      : undefined;
    const code = resolveFlightCodeRef(ref, refs);
    const codeBlock = code ? buildCodeBlock(code) : '';
    if (title && codeBlock) demoCodeBlocks.set(title, codeBlock);
  }
  return demoCodeBlocks;
}

function extractNextFlightSupplement(
  originalHtml: string
): FlightPayloadData | null {
  const payloads = decodeNextFlightPayloads(originalHtml);
  if (payloads.length === 0) return null;

  const text = payloads.join('\n');
  const refs = parseFlightObjectRefs(text);

  const installMatch = FLIGHT_INSTALL_RE.exec(text);
  const importMatch = FLIGHT_IMPORT_RE.exec(text);

  return {
    ...(installMatch ? { installationCommands: installMatch.slice(1) } : {}),
    ...(importMatch ? { importCommands: importMatch.slice(1) } : {}),
    apiTables: extractFlightApiTables(text),
    demoCodeBlocks: extractFlightDemoBlocks(text, refs),
    mermaidDiagrams: extractFlightMermaidDiagrams(text),
  };
}

export function supplementMarkdownFromNextFlight(
  markdown: string,
  originalHtml: string
): string {
  const payloadData = extractNextFlightSupplement(originalHtml);
  if (!payloadData) return markdown;

  const lines = markdown.split('\n');

  if (payloadData.installationCommands?.length) {
    upsertMarkdownSection(
      lines,
      'Installation',
      buildCodeBlock(payloadData.installationCommands.join('\n')),
      { exclusionPattern: /(npm|pnpm|yarn|bun|npx)\s+(install|add)/ }
    );
  }

  if (payloadData.importCommands?.length) {
    upsertMarkdownSection(
      lines,
      'Import',
      buildCodeBlock(payloadData.importCommands.join('\n\n')),
      { exclusionPattern: /import\s+\{/ }
    );
  }

  for (const [title, table] of payloadData.apiTables) {
    upsertMarkdownSection(lines, title, table, { replacement: true });
  }

  for (const [title, mermaidBlock] of payloadData.mermaidDiagrams) {
    upsertMarkdownSection(lines, title, mermaidBlock, {
      exclusionPattern: '```mermaid',
    });
  }

  for (const [title, codeBlock] of payloadData.demoCodeBlocks) {
    upsertMarkdownSection(lines, title, codeBlock, { exclusionPattern: '```' });
  }

  return lines.join('\n');
}
