#!/usr/bin/env node
/* eslint-disable */
/**
 * Reusable URL Fetch Validation Script
 *
 * Usage:
 *   node scripts/validate-fetch.mjs <url> [options]
 *   node scripts/validate-fetch.mjs --config <config.json>
 *
 * Options:
 *   --config <file>         Load test config from JSON file
 *   --expect-text <text>    Comma-separated texts that must be present
 *   --expect-code-blocks    Require at least one code block
 *   --min-code-blocks <n>   Minimum number of code blocks required
 *   --min-length <n>        Minimum markdown length in characters
 *   --reference <file>      Compare against reference markdown file
 *   --save-output <file>    Save markdown output to file
 *   --verbose               Show detailed output
 *   --help                  Show this help
 *
 * Config file format (JSON):
 * {
 *   "tests": [
 *     {
 *       "name": "Test MCP Architecture Docs",
 *       "url": "https://modelcontextprotocol.io/docs/learn/architecture",
 *       "validations": {
 *         "expectText": ["Initialize Request", "jsonrpc", "tools/list"],
 *         "minCodeBlocks": 10,
 *         "minLength": 15000,
 *         "expectStructure": ["headings", "code-blocks", "links"]
 *       },
 *       "saveOutput": ".github/test-outputs/mcp-architecture.md"
 *     }
 *   ]
 * }
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const projectRoot = resolve(__dirname, '..');

// Import the transform function from built dist
const distPath = join(projectRoot, 'dist', 'transform.js');
let transformHtmlToMarkdown;
let fetchNormalizedUrl;

async function loadDistModules() {
  try {
    await access(distPath);
  } catch {
    throw new Error('dist/transform.js not found. Run `npm run build` first.');
  }

  ({ transformHtmlToMarkdown } = await import(pathToFileURL(distPath).href));
  ({ fetchNormalizedUrl } = await import(
    pathToFileURL(join(projectRoot, 'dist', 'fetch.js')).href
  ));
}

// ============================================================================
// Validators
// ============================================================================

const validators = {
  /**
   * Check if markdown contains expected text patterns
   * Supports: array of strings, object with {patterns, caseInsensitive}, regex /pattern/flags
   */
  expectText: {
    name: 'Expected Text Presence',
    validate: (markdown, expected) => {
      // Normalize input: support both array and object format
      const patterns = Array.isArray(expected) ? expected : expected.patterns;
      const caseInsensitive =
        !Array.isArray(expected) && expected.caseInsensitive;

      const missing = [];
      const found = [];

      for (const pattern of patterns) {
        // Detect regex patterns: /pattern/flags
        const regexMatch = pattern.match(/^\/(.+)\/([gimsuvy]*)$/);

        let isMatch = false;
        if (regexMatch) {
          // Regex mode
          try {
            const [, regexPattern, flags] = regexMatch;
            const regex = new RegExp(regexPattern, flags);
            isMatch = regex.test(markdown);
          } catch (error) {
            // Invalid regex, treat as literal
            isMatch = markdown.includes(pattern);
          }
        } else {
          // Literal mode with optional case-insensitive
          const searchIn = caseInsensitive ? markdown.toLowerCase() : markdown;
          const searchFor = caseInsensitive ? pattern.toLowerCase() : pattern;
          isMatch = searchIn.includes(searchFor);
        }

        if (isMatch) {
          found.push(pattern);
        } else {
          missing.push(pattern);
        }
      }

      return {
        passed: missing.length === 0,
        message:
          missing.length === 0
            ? `✓ All ${patterns.length} expected texts found`
            : `✗ Missing ${missing.length}/${patterns.length} expected texts`,
        details: {
          found: found.length,
          missing: missing.length,
          missingTexts: missing,
          foundTexts: found,
        },
      };
    },
  },

  /**
   * Check minimum number of code blocks
   */
  minCodeBlocks: {
    name: 'Minimum Code Blocks',
    validate: (markdown, minCount) => {
      const codeBlockRegex = /```[\s\S]*?```/g;
      const matches = markdown.match(codeBlockRegex) || [];
      const count = matches.length;

      return {
        passed: count >= minCount,
        message:
          count >= minCount
            ? `✓ Found ${count} code blocks (required: ${minCount})`
            : `✗ Found ${count} code blocks (required: ${minCount})`,
        details: {
          count,
          required: minCount,
          blocks: matches.slice(0, 3).map((block) => ({
            preview:
              block.substring(0, 100) + (block.length > 100 ? '...' : ''),
            language: block.match(/```(\w+)/)?.[1] || 'none',
          })),
        },
      };
    },
  },

  /**
   * Check minimum markdown length
   */
  minLength: {
    name: 'Minimum Content Length',
    validate: (markdown, minLength) => {
      const length = markdown.length;

      return {
        passed: length >= minLength,
        message:
          length >= minLength
            ? `✓ Content length ${length} chars (required: ${minLength})`
            : `✗ Content length ${length} chars (required: ${minLength})`,
        details: {
          length,
          required: minLength,
          percentage: Math.round((length / minLength) * 100),
        },
      };
    },
  },

  /**
   * Check for expected structural elements
   */
  expectStructure: {
    name: 'Content Structure',
    validate: (markdown, elements) => {
      const checks = {
        headings: /^#{1,6}\s+/m,
        'code-blocks': /```/,
        links: /\[.+?\]\([^)]+\)/,
        lists: /^[-*+]\s+/m,
        'numbered-lists': /^\d+\.\s+/m,
        images: /!\[.*?\]\([^)]+\)/,
        tables: /\|/,
        blockquotes: /^>\s+/m,
      };

      const results = {};
      const missing = [];
      const found = [];

      for (const element of elements) {
        const regex = checks[element];
        if (!regex) {
          results[element] = { found: false, error: 'Unknown element type' };
          continue;
        }

        const hasElement = regex.test(markdown);
        results[element] = { found: hasElement };

        if (hasElement) {
          found.push(element);
        } else {
          missing.push(element);
        }
      }

      return {
        passed: missing.length === 0,
        message:
          missing.length === 0
            ? `✓ All ${elements.length} structural elements found`
            : `✗ Missing ${missing.length}/${elements.length} structural elements`,
        details: {
          results,
          found,
          missing,
        },
      };
    },
  },

  /**
   * Compare against reference markdown file
   */
  reference: {
    name: 'Reference Comparison',
    validate: async (markdown, referencePath) => {
      try {
        const refPath = resolve(projectRoot, referencePath);
        const reference = await readFile(refPath, 'utf-8');

        const currentLength = markdown.length;
        const referenceLength = reference.length;
        const lengthDiff = currentLength - referenceLength;
        const lengthDiffPercent = Math.round(
          (lengthDiff / referenceLength) * 100
        );

        // Simple similarity check: count common lines
        const currentLines = new Set(
          markdown
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
        );
        const referenceLines = new Set(
          reference
            .split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
        );

        let commonLines = 0;
        for (const line of currentLines) {
          if (referenceLines.has(line)) {
            commonLines++;
          }
        }

        const similarity = Math.round(
          (commonLines / referenceLines.size) * 100
        );

        return {
          passed: similarity >= 70, // 70% similarity threshold
          message:
            similarity >= 70
              ? `✓ Output matches reference (${similarity}% similar)`
              : `✗ Output differs from reference (${similarity}% similar)`,
          details: {
            similarity,
            lengthDiff,
            lengthDiffPercent,
            currentLength,
            referenceLength,
            commonLines,
            totalLines: referenceLines.size,
          },
        };
      } catch (error) {
        return {
          passed: false,
          message: `✗ Reference file error: ${error.message}`,
          details: { error: error.message },
        };
      }
    },
  },
};

// ============================================================================
// Core Testing Logic
// ============================================================================

/**
 * Fetch and transform a URL
 */
async function fetchAndTransform(url, options = {}) {
  const startTime = Date.now();

  if (!fetchNormalizedUrl || !transformHtmlToMarkdown) {
    throw new Error('Dist modules not loaded. Run `npm run build` first.');
  }

  try {
    // Fetch HTML
    console.log(`\n🌐 Fetching: ${url}`);
    const html = await fetchNormalizedUrl(url, {
      maxBytes: 10 * 1024 * 1024, // 10MB
      signal: options.signal,
    });
    const fetchTime = Date.now() - startTime;
    console.log(`✓ Fetched ${html.length} bytes in ${fetchTime}ms`);

    // Transform to markdown
    console.log(`\n🔄 Transforming to markdown...`);
    const transformStart = Date.now();
    const result = await transformHtmlToMarkdown(html, url, {
      includeMetadata: true,
      signal: options.signal,
    });
    const transformTime = Date.now() - transformStart;
    console.log(`✓ Transformed in ${transformTime}ms`);

    const totalTime = Date.now() - startTime;

    return {
      success: true,
      markdown: result.markdown,
      title: result.title,
      url: result.url,
      truncated: result.truncated,
      timing: {
        fetch: fetchTime,
        transform: transformTime,
        total: totalTime,
      },
      stats: {
        htmlLength: html.length,
        markdownLength: result.markdown.length,
      },
    };
  } catch (error) {
    return {
      success: false,
      error: error.message,
      timing: {
        total: Date.now() - startTime,
      },
    };
  }
}

/**
 * Run validations on markdown output
 */
async function runValidations(markdown, validations, options = {}) {
  const results = [];

  for (const [key, value] of Object.entries(validations)) {
    const validator = validators[key];
    if (!validator) {
      console.warn(`⚠️  Unknown validator: ${key}`);
      continue;
    }

    console.log(`\n📋 Running: ${validator.name}`);
    const result = await validator.validate(markdown, value);

    results.push({
      validator: key,
      name: validator.name,
      ...result,
    });

    console.log(`   ${result.message}`);
    if (options.verbose && result.details) {
      console.log(`   Details:`, JSON.stringify(result.details, null, 2));
    }
  }

  return results;
}

/**
 * Run a single test
 */
async function runTest(test, options = {}) {
  console.log(`\n${'='.repeat(80)}`);
  console.log(`📝 Test: ${test.name || test.url}`);
  console.log(`${'='.repeat(80)}`);

  // Fetch and transform
  const fetchResult = await fetchAndTransform(test.url, options);

  if (!fetchResult.success) {
    console.error(`\n❌ Fetch failed: ${fetchResult.error}`);
    return {
      testName: test.name || test.url,
      passed: false,
      error: fetchResult.error,
    };
  }

  // Display basic info
  console.log(`\n📊 Output Summary:`);
  console.log(`   Title: ${fetchResult.title || '(none)'}`);
  console.log(`   Length: ${fetchResult.stats.markdownLength} chars`);
  console.log(`   Truncated: ${fetchResult.truncated ? 'Yes' : 'No'}`);
  console.log(`   Timing: ${fetchResult.timing.total}ms total`);

  // Save output if requested
  if (test.saveOutput) {
    const outputPath = resolve(projectRoot, test.saveOutput);
    await mkdir(dirname(outputPath), { recursive: true });
    await writeFile(outputPath, fetchResult.markdown, 'utf-8');
    console.log(`\n💾 Saved output to: ${test.saveOutput}`);
  }

  // Run validations
  let validationResults = [];
  if (test.validations && Object.keys(test.validations).length > 0) {
    console.log(`\n🔍 Validations:`);
    validationResults = await runValidations(
      fetchResult.markdown,
      test.validations,
      options
    );
  }

  const allPassed = validationResults.every((r) => r.passed);

  // Summary
  console.log(`\n${'─'.repeat(80)}`);
  if (allPassed) {
    console.log(`✅ Test PASSED: ${test.name || test.url}`);
  } else {
    console.log(`❌ Test FAILED: ${test.name || test.url}`);
    const failedValidations = validationResults.filter((r) => !r.passed);
    console.log(
      `   Failed validations: ${failedValidations.map((v) => v.name).join(', ')}`
    );
  }
  console.log(`${'─'.repeat(80)}`);

  return {
    testName: test.name || test.url,
    passed: allPassed,
    fetchResult,
    validationResults,
  };
}

// ============================================================================
// CLI Interface
// ============================================================================

function printHelp() {
  console.log(`
Reusable URL Fetch Validation Script

Usage:
  node scripts/validate-fetch.mjs <url> [options]
  node scripts/validate-fetch.mjs --config <config.json>

Options:
  --config <file>         Load test config from JSON file
  --expect-text <text>    Comma-separated texts that must be present
  --expect-code-blocks    Require at least one code block (same as --min-code-blocks 1)
  --min-code-blocks <n>   Minimum number of code blocks required
  --min-length <n>        Minimum markdown length in characters
  --reference <file>      Compare against reference markdown file
  --save-output <file>    Save markdown output to file
  --verbose               Show detailed output
  --help                  Show this help

Examples:
  # Quick test with text expectations
  node scripts/validate-fetch.mjs https://example.com --expect-text "Hello,World"
  
  # Comprehensive validation
  node scripts/validate-fetch.mjs https://example.com \\
    --expect-text "Hello,World" \\
    --min-code-blocks 5 \\
    --min-length 10000 \\
    --save-output .github/test-output.md
  
  # Run multiple tests from config
  node scripts/validate-fetch.mjs --config test-config.json

Config file format (JSON):
{
  "tests": [
    {
      "name": "Test Name",
      "url": "https://example.com",
      "validations": {
        "expectText": ["text1", "text2"],
        "minCodeBlocks": 10,
        "minLength": 15000,
        "expectStructure": ["headings", "code-blocks", "links"]
      },
      "saveOutput": "path/to/output.md"
    }
  ]
}
`);
}

function parseCliArgs(args) {
  const parsed = {
    url: null,
    config: null,
    validations: {},
    saveOutput: null,
    verbose: false,
    help: false,
  };

  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    strict: false,
    options: {
      help: { type: 'boolean' },
      config: { type: 'string' },
      'expect-text': { type: 'string' },
      'expect-code-blocks': { type: 'boolean' },
      'min-code-blocks': { type: 'string' },
      'min-length': { type: 'string' },
      reference: { type: 'string' },
      'save-output': { type: 'string' },
      verbose: { type: 'boolean' },
    },
  });

  if (values.help) parsed.help = true;
  if (values.config) parsed.config = values.config;
  if (values['save-output']) parsed.saveOutput = values['save-output'];
  if (values.verbose) parsed.verbose = true;

  const url = positionals[0];
  if (typeof url === 'string' && url.length > 0) {
    parsed.url = url;
  }

  const expectText = values['expect-text'];
  if (typeof expectText === 'string' && expectText.length > 0) {
    parsed.validations.expectText = expectText
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  }

  if (values['expect-code-blocks']) {
    parsed.validations.minCodeBlocks = 1;
  }

  const minCodeBlocks = Number.parseInt(values['min-code-blocks'] ?? '', 10);
  if (Number.isFinite(minCodeBlocks)) {
    parsed.validations.minCodeBlocks = minCodeBlocks;
  }

  const minLength = Number.parseInt(values['min-length'] ?? '', 10);
  if (Number.isFinite(minLength)) {
    parsed.validations.minLength = minLength;
  }

  if (values.reference) parsed.validations.reference = values.reference;

  return parsed;
}

async function main() {
  const args = process.argv.slice(2);

  const parsed = parseCliArgs(args);

  if (args.length === 0 || parsed.help) {
    printHelp();
    return 0;
  }

  let tests = [];

  // Load from config file
  if (parsed.config) {
    const configPath = resolve(projectRoot, parsed.config);
    const configContent = await readFile(configPath, 'utf-8');
    const config = JSON.parse(configContent);
    tests = config.tests || [];
    console.log(
      `📁 Loaded ${tests.length} tests from config: ${parsed.config}`
    );
  }
  // Create test from CLI args
  else if (parsed.url) {
    tests = [
      {
        name: parsed.url,
        url: parsed.url,
        validations: parsed.validations,
        saveOutput: parsed.saveOutput,
      },
    ];
  } else {
    console.error('❌ Error: No URL or config file provided');
    printHelp();
    return 1;
  }

  try {
    await loadDistModules();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`❌ Error: ${message}`);
    return 1;
  }

  // Run tests
  const results = [];
  for (const test of tests) {
    const result = await runTest(test, { verbose: parsed.verbose });
    results.push(result);
  }

  // Final summary
  console.log(`\n${'='.repeat(80)}`);
  console.log(`📊 Final Summary`);
  console.log(`${'='.repeat(80)}`);
  console.log(`Total tests: ${results.length}`);
  console.log(`Passed: ${results.filter((r) => r.passed).length}`);
  console.log(`Failed: ${results.filter((r) => !r.passed).length}`);

  if (results.some((r) => !r.passed)) {
    console.log(`\n❌ Failed tests:`);
    results
      .filter((r) => !r.passed)
      .forEach((r) => {
        console.log(`   - ${r.testName}`);
        if (r.error) {
          console.log(`     Error: ${r.error}`);
        }
      });
    return 1;
  }

  console.log(`\n✅ All tests passed!`);
  return 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error) => {
    console.error('❌ Fatal error:', error);
    process.exitCode = 1;
  });
