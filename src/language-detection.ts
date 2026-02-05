interface LanguagePattern {
  keywords?: readonly string[];
  wordBoundary?: readonly string[];
  regex?: RegExp;
  startsWith?: readonly string[];
  custom?: (sample: CodeSample) => boolean;
}

interface CodeSample {
  code: string;
  lower: string;
  lines: string[];
  trimmedStart: string;
}

type SamplePredicate = (sample: CodeSample) => boolean;

function createCodeSample(code: string): CodeSample {
  return {
    code,
    lower: code.toLowerCase(),
    lines: code.split(/\r?\n/),
    trimmedStart: code.trimStart(),
  };
}

function escapeRegExpLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeTest(regex: RegExp, input: string): boolean {
  // Reset stateful regexes to avoid cross-call false negatives.
  if (regex.global || regex.sticky) regex.lastIndex = 0;
  return regex.test(input);
}

function compileWordBoundaryRegex(word: string): RegExp {
  return new RegExp(`\\b${escapeRegExpLiteral(word)}\\b`);
}

const Heuristics = {
  containsJsxTag(code: string): boolean {
    for (let i = 0; i < code.length - 1; i += 1) {
      if (code[i] !== '<') continue;
      const next = code[i + 1];
      if (next && next >= 'A' && next <= 'Z') return true;
    }
    return false;
  },

  bash: (() => {
    const commands = [
      'sudo',
      'chmod',
      'mkdir',
      'cd',
      'ls',
      'cat',
      'echo',
    ] as const;
    const pkgManagers = [
      'npm',
      'yarn',
      'pnpm',
      'npx',
      'brew',
      'apt',
      'pip',
      'cargo',
      'go',
    ] as const;
    const verbs = ['install', 'add', 'run', 'build', 'start'] as const;

    function isShellPrefix(line: string): boolean {
      return (
        line.startsWith('#!') || line.startsWith('$ ') || line.startsWith('# ')
      );
    }

    function matchesCommand(line: string): boolean {
      return commands.some((cmd) => line === cmd || line.startsWith(`${cmd} `));
    }

    function matchesPackageManagerVerb(line: string): boolean {
      for (const mgr of pkgManagers) {
        if (!line.startsWith(`${mgr} `)) continue;

        const rest = line.slice(mgr.length + 1);
        if (verbs.some((v) => rest === v || rest.startsWith(`${v} `)))
          return true;
      }
      return false;
    }

    function detectIndicators(lines: string[]): boolean {
      for (const line of lines) {
        const trimmed = line.trimStart();
        if (!trimmed) continue;
        if (
          isShellPrefix(trimmed) ||
          matchesCommand(trimmed) ||
          matchesPackageManagerVerb(trimmed)
        ) {
          return true;
        }
      }
      return false;
    }

    return { detectIndicators } as const;
  })(),

  css: {
    detectStructure(lines: string[]): boolean {
      for (const line of lines) {
        const trimmed = line.trimStart();
        if (!trimmed) continue;

        const hasSelector =
          (trimmed.startsWith('.') || trimmed.startsWith('#')) &&
          trimmed.includes('{');

        if (hasSelector || (trimmed.includes(':') && trimmed.includes(';')))
          return true;
      }
      return false;
    },
  },

  yaml: {
    detectStructure(lines: string[]): boolean {
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;

        const colonIdx = trimmed.indexOf(':');
        if (colonIdx <= 0) continue;

        const after = trimmed[colonIdx + 1];
        if (after === ' ' || after === '\t') return true;
      }
      return false;
    },
  },
} as const;

const LANGUAGE_PATTERNS: readonly {
  language: string;
  weight: number;
  pattern: LanguagePattern;
}[] = [
  {
    language: 'jsx',
    weight: 22,
    pattern: {
      keywords: ['classname=', 'jsx:', "from 'react'", 'from "react"'],
      custom: (sample) => Heuristics.containsJsxTag(sample.code),
    },
  },
  {
    language: 'typescript',
    weight: 20,
    pattern: {
      wordBoundary: ['interface', 'type'],
      custom: (sample) =>
        [
          ': string',
          ':string',
          ': number',
          ':number',
          ': boolean',
          ':boolean',
          ': void',
          ':void',
          ': any',
          ':any',
          ': unknown',
          ':unknown',
          ': never',
          ':never',
        ].some((hint) => sample.lower.includes(hint)),
    },
  },
  {
    language: 'rust',
    weight: 25,
    pattern: {
      regex: /\b(?:fn|impl|struct|enum)\b/,
      keywords: ['let mut'],
      custom: (sample) =>
        sample.lower.includes('use ') && sample.lower.includes('::'),
    },
  },
  {
    language: 'javascript',
    weight: 12,
    pattern: {
      regex: /\b(?:const|let|var|function|class|async|await|export|import)\b/,
    },
  },
  {
    language: 'python',
    weight: 18,
    pattern: {
      regex: /\b(?:def|class|import|from)\b/,
      keywords: ['print(', '__name__'],
    },
  },
  {
    language: 'bash',
    weight: 15,
    pattern: {
      custom: (sample) => Heuristics.bash.detectIndicators(sample.lines),
    },
  },
  {
    language: 'css',
    weight: 18,
    pattern: {
      regex: /@media|@import|@keyframes/,
      custom: (sample) => Heuristics.css.detectStructure(sample.lines),
    },
  },
  {
    language: 'html',
    weight: 12,
    pattern: {
      keywords: [
        '<!doctype',
        '<html',
        '<head',
        '<body',
        '<div',
        '<span',
        '<p',
        '<a',
        '<script',
        '<style',
      ],
    },
  },
  {
    language: 'json',
    weight: 10,
    pattern: {
      startsWith: ['{', '['],
    },
  },
  {
    language: 'yaml',
    weight: 15,
    pattern: {
      custom: (sample) => Heuristics.yaml.detectStructure(sample.lines),
    },
  },
  {
    language: 'sql',
    weight: 20,
    pattern: {
      wordBoundary: [
        'select',
        'insert',
        'update',
        'delete',
        'create',
        'alter',
        'drop',
      ],
    },
  },
  {
    language: 'go',
    weight: 22,
    pattern: {
      wordBoundary: ['package', 'func'],
      keywords: ['import "'],
    },
  },
];

function compilePattern(pattern: LanguagePattern): SamplePredicate {
  const {
    keywords: rawKeywords,
    wordBoundary,
    startsWith,
    regex,
    custom,
  } = pattern;
  const keywords = rawKeywords?.map((k) => k.toLowerCase()) ?? [];
  const boundaryRegexes =
    wordBoundary
      ?.map((w) => w.toLowerCase())
      .map((w) => compileWordBoundaryRegex(w)) ?? [];
  const startsWithList = startsWith ?? [];

  const hasKeywords = keywords.length > 0;
  const hasBoundaries = boundaryRegexes.length > 0;
  const hasStartsWith = startsWithList.length > 0;

  return (sample: CodeSample): boolean => {
    if (hasKeywords && keywords.some((kw) => sample.lower.includes(kw)))
      return true;
    if (
      hasBoundaries &&
      boundaryRegexes.some((re) => safeTest(re, sample.lower))
    )
      return true;
    if (regex && safeTest(regex, sample.lower)) return true;
    if (
      hasStartsWith &&
      startsWithList.some((p) => sample.trimmedStart.startsWith(p))
    )
      return true;
    if (custom?.(sample)) return true;

    return false;
  };
}

const COMPILED_PATTERNS: readonly {
  language: string;
  weight: number;
  matches: SamplePredicate;
}[] = LANGUAGE_PATTERNS.map(({ language, weight, pattern }) => ({
  language,
  weight,
  matches: compilePattern(pattern),
}));

function extractLanguageFromClassName(className: string): string | undefined {
  const tokens = className.match(/\S+/g);
  if (!tokens) return undefined;

  for (const token of tokens) {
    const lower = token.toLowerCase();
    if (lower.startsWith('language-')) return token.slice('language-'.length);
    if (lower.startsWith('lang-')) return token.slice('lang-'.length);
    if (lower.startsWith('highlight-')) return token.slice('highlight-'.length);
  }

  if (!tokens.includes('hljs')) return undefined;

  const langClass = tokens.find((t) => t !== 'hljs' && !t.startsWith('hljs-'));
  return langClass ?? undefined;
}

function resolveLanguageFromDataAttribute(
  dataLang: string
): string | undefined {
  const trimmed = dataLang.trim();
  if (!trimmed) return undefined;
  return /^\w+$/.test(trimmed) ? trimmed : undefined;
}

function resolveLanguage(
  className: string,
  dataLang: string
): string | undefined {
  return (
    extractLanguageFromClassName(className) ??
    resolveLanguageFromDataAttribute(dataLang)
  );
}

function detectLanguage(code: string): string | undefined {
  const sample = createCodeSample(code);
  const scores = new Map<string, number>();

  let bestLang: string | undefined;
  let bestScore = -1;

  for (const { language, weight, matches } of COMPILED_PATTERNS) {
    if (!matches(sample)) continue;

    const nextScore = (scores.get(language) ?? 0) + weight;
    scores.set(language, nextScore);

    if (nextScore > bestScore) {
      bestScore = nextScore;
      bestLang = language;
    }
  }

  return bestLang;
}

export function detectLanguageFromCode(code: string): string | undefined {
  if (!code || code.trim().length === 0) return undefined;
  return detectLanguage(code);
}

export function resolveLanguageFromAttributes(
  className: string,
  dataLang: string
): string | undefined {
  return resolveLanguage(className, dataLang);
}
