import { detectLanguageFromCode } from './html-translators.js';

interface FlightApiRow {
  readonly attribute: string;
  readonly type: string;
  readonly description: string;
  readonly defaultValue: string;
}

interface NextFlightSupplement {
  readonly installationCommands?: string[];
  readonly importCommands?: string[];
  readonly apiTables: Map<string, string>;
  readonly demoCodeBlocks: Map<string, string>;
  readonly mermaidDiagrams: Map<string, string>;
}

const NEXT_FLIGHT_PAYLOAD_RE =
  /self\.__next_f\.push\(\[1,"((?:\\.|[^"\\])*)"\]\)<\/script>/gs;
const TEMPLATE_ASSIGNMENT_RE = /([A-Za-z_$][\w$]*)=`([\s\S]*?)`;/g;
const OBJECT_ASSIGNMENT_RE = /([A-Za-z_$][\w$]*)=\{([^{}]+)\}/g;
const FLIGHT_INSTALL_RE =
  /commands:\{cli:"([^"]+)",npm:"([^"]+)",yarn:"([^"]+)",pnpm:"([^"]+)",bun:"([^"]+)"\}/;
const FLIGHT_IMPORT_RE = /commands:\{main:'([^']+)',individual:'([^']+)'\}/;
const FLIGHT_DEMO_RE =
  /title:"([^"]+)",files:([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)/g;
const FLIGHT_API_RE =
  /children:"([^"]+)"\}\),`\\n`,\(0,e\.jsx\)\(o,\{data:\[([\s\S]*?)\]\}\)/g;
const FLIGHT_API_ROW_RE =
  /attribute:"([^"]+)",type:"([^"]+)",description:"([^"]*)",default:"([^"]*)"/g;
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

function decodeFlightStringValue(value: string): string {
  try {
    return JSON.parse(`"${value}"`) as string;
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
      payloads.push(JSON.parse(`"${rawPayload}"`) as string);
    } catch {
      // Ignore malformed payload fragments and continue with the rest.
    }
  }

  return payloads;
}

function parseObjectEntries(body: string): Map<string, string> {
  const entries = new Map<string, string>();
  for (const part of body.split(',')) {
    const entryMatch =
      /(?:"([^"]+)"|([A-Za-z_$][\w$]*)):([A-Za-z_$][\w$]*)$/.exec(part.trim());
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

  for (const match of text.matchAll(OBJECT_ASSIGNMENT_RE)) {
    const objectName = match[1];
    const body = match[2]?.trim() ?? '';
    if (!objectName || !body) continue;

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
  const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line.trim());
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

function replaceMarkdownSection(
  lines: string[],
  title: string,
  body: string
): boolean {
  const section = findMarkdownSection(lines, title);
  if (!section) return false;

  const replacement =
    body.trim().length > 0 ? ['', ...body.trim().split('\n'), ''] : [''];
  lines.splice(
    section.start + 1,
    section.end - section.start - 1,
    ...replacement
  );
  return true;
}

function appendMarkdownSection(
  lines: string[],
  title: string,
  body: string
): boolean {
  const section = findMarkdownSection(lines, title);
  if (!section) return false;

  const bodyText = getSectionBody(lines, section);
  if (bodyText.includes('```')) return false;

  const nextBody = bodyText ? `${bodyText}\n\n${body.trim()}` : body.trim();
  return replaceMarkdownSection(lines, title, nextBody);
}

function conditionallyAppendMarkdownSection(
  lines: string[],
  title: string,
  content: string,
  exclusionPattern?: RegExp
): void {
  const section = findMarkdownSection(lines, title);
  if (!section) return;

  const bodyText = getSectionBody(lines, section);
  if (exclusionPattern?.test(bodyText)) return;

  appendMarkdownSection(lines, title, content);
}

function mergeMermaidDiagramSection(
  lines: string[],
  title: string,
  mermaidBlock: string
): void {
  const section = findMarkdownSection(lines, title);
  if (!section) return;

  const sectionBody = getSectionBody(lines, section);
  if (sectionBody.includes('```mermaid')) return;

  const nextBody = sectionBody
    ? `${sectionBody}\n\n${mermaidBlock}`
    : mermaidBlock;
  replaceMarkdownSection(lines, title, nextBody);
}

function extractFlightApiTables(text: string): Map<string, string> {
  const apiTables = new Map<string, string>();
  for (const match of text.matchAll(FLIGHT_API_RE)) {
    const title = match[1];
    const rawRows = match[2] ?? '';
    if (!title) continue;

    const rows: FlightApiRow[] = [];
    for (const rowMatch of rawRows.matchAll(FLIGHT_API_ROW_RE)) {
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
        continue;
      }
      rows.push({ attribute, type, description, defaultValue });
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
): NextFlightSupplement | null {
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
  const supplement = extractNextFlightSupplement(originalHtml);
  if (!supplement) return markdown;

  const lines = markdown.split('\n');

  if (supplement.installationCommands?.length) {
    conditionallyAppendMarkdownSection(
      lines,
      'Installation',
      buildCodeBlock(supplement.installationCommands.join('\n')),
      /(npm|pnpm|yarn|bun|npx)\s+(install|add)/
    );
  }

  if (supplement.importCommands?.length) {
    conditionallyAppendMarkdownSection(
      lines,
      'Import',
      buildCodeBlock(supplement.importCommands.join('\n\n')),
      /import\s+\{/
    );
  }

  for (const [title, table] of supplement.apiTables) {
    replaceMarkdownSection(lines, title, table);
  }

  for (const [title, mermaidBlock] of supplement.mermaidDiagrams) {
    mergeMermaidDiagramSection(lines, title, mermaidBlock);
  }

  for (const [title, codeBlock] of supplement.demoCodeBlocks) {
    appendMarkdownSection(lines, title, codeBlock);
  }

  return lines.join('\n');
}
