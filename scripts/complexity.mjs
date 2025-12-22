import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

import ts from 'typescript';

const ROOT_DIR = process.argv[2]
  ? path.resolve(process.argv[2])
  : process.cwd();
const TARGET_DIR = process.argv[3] ? process.argv[3] : 'src';

const SKIP_DIRS = new Set(['dist', 'node_modules', '.git', 'logs', 'docs']);

function collectTsFiles(rootDir, relDir) {
  const startDir = path.join(rootDir, relDir);
  const results = [];
  if (!fs.existsSync(startDir)) return results;

  const entries = fs.readdirSync(startDir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      results.push(...collectTsFiles(rootDir, path.join(relDir, entry.name)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.ts')) {
      results.push(path.join(startDir, entry.name));
    }
  }
  return results;
}

function isDecisionNode(node) {
  if (
    ts.isIfStatement(node) ||
    ts.isForStatement(node) ||
    ts.isForInStatement(node) ||
    ts.isForOfStatement(node) ||
    ts.isWhileStatement(node) ||
    ts.isDoStatement(node) ||
    ts.isConditionalExpression(node) ||
    ts.isCatchClause(node)
  ) {
    return true;
  }

  if (ts.isCaseClause(node)) {
    return node.expression !== undefined;
  }

  if (ts.isBinaryExpression(node)) {
    return (
      node.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken ||
      node.operatorToken.kind === ts.SyntaxKind.BarBarToken
    );
  }

  return false;
}

function getFunctionName(node) {
  if (node.name && ts.isIdentifier(node.name)) {
    return node.name.text;
  }

  const parent = node.parent;
  if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (ts.isPropertyAssignment(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (ts.isPropertyDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (ts.isMethodDeclaration(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }
  if (ts.isPropertyAccessExpression(parent) && ts.isIdentifier(parent.name)) {
    return parent.name.text;
  }

  return '<anonymous>';
}

function computeFunctionComplexity(sourceFile, node) {
  if (!node.body) return null;

  let complexity = 1;
  const visit = (child) => {
    if (child !== node && ts.isFunctionLike(child)) {
      return;
    }

    if (isDecisionNode(child)) {
      complexity += 1;
    }

    ts.forEachChild(child, visit);
  };

  ts.forEachChild(node, visit);

  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());

  return {
    name: getFunctionName(node),
    complexity,
    lines: end.line - start.line + 1,
    startLine: start.line + 1,
    endLine: end.line + 1,
  };
}

function analyzeFile(filePath) {
  const content = fs.readFileSync(filePath, 'utf8');
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true
  );

  const functions = [];
  const visit = (node) => {
    if (ts.isFunctionLike(node) && node.body) {
      const stats = computeFunctionComplexity(sourceFile, node);
      if (stats) functions.push(stats);
    }

    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);

  return functions;
}

function summarize(files) {
  const summaries = [];
  let totalFunctions = 0;
  let totalComplexity = 0;
  let globalMax = 0;
  let globalMaxEntry = null;

  for (const filePath of files) {
    const functions = analyzeFile(filePath);
    const relPath = path.relative(ROOT_DIR, filePath);
    const counts = functions.length;
    const maxComplexity = counts
      ? Math.max(...functions.map((fn) => fn.complexity))
      : 0;
    const avgComplexity = counts
      ? Number(
          (
            functions.reduce((sum, fn) => sum + fn.complexity, 0) / counts
          ).toFixed(2)
        )
      : 0;

    for (const fn of functions) {
      if (fn.complexity > globalMax) {
        globalMax = fn.complexity;
        globalMaxEntry = { ...fn, file: relPath };
      }
    }

    totalFunctions += counts;
    totalComplexity += functions.reduce((sum, fn) => sum + fn.complexity, 0);

    summaries.push({
      file: relPath,
      functionCount: counts,
      avgComplexity,
      maxComplexity,
    });
  }

  const globalAvg =
    totalFunctions === 0
      ? 0
      : Number((totalComplexity / totalFunctions).toFixed(2));

  return {
    root: ROOT_DIR,
    targetDir: TARGET_DIR,
    summary: summaries.sort((a, b) => b.maxComplexity - a.maxComplexity),
    totals: {
      functionCount: totalFunctions,
      avgComplexity: globalAvg,
      maxComplexity: globalMax,
      maxComplexityFunction: globalMaxEntry,
    },
  };
}

const files = collectTsFiles(ROOT_DIR, TARGET_DIR);
const report = summarize(files);
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
