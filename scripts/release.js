#!/usr/bin/env node

/**
 * Release automation script for superFetch
 * Usage: npm run release [patch|minor|major|<version>]
 * 
 * This script:
 * 1. Bumps version in package.json
 * 2. Updates server.json to match
 * 3. Commits changes
 * 4. Creates git tag
 * 5. Pushes to GitHub (triggers automated publish)
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');

// Color output helpers
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function exec(command, options = {}) {
  try {
    return execSync(command, { 
      cwd: rootDir,
      stdio: 'inherit',
      ...options 
    });
  } catch {
    log(`Failed to execute: ${command}`, 'red');
    process.exit(1);
  }
}

function execSilent(command) {
  try {
    return execSync(command, { 
      cwd: rootDir,
      encoding: 'utf8',
      stdio: 'pipe'
    }).trim();
  } catch {
    log(`Failed to execute: ${command}`, 'red');
    process.exit(1);
  }
}

function readJson(filePath) {
  const fullPath = path.join(rootDir, filePath);
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
}

function writeJson(filePath, data) {
  const fullPath = path.join(rootDir, filePath);
  fs.writeFileSync(fullPath, JSON.stringify(data, null, 2) + '\n');
}

// Main release process
async function main() {
  const releaseType = process.argv[2] || 'patch';
  
  log('\n🚀 superFetch Release Automation\n', 'cyan');

  // Check for uncommitted changes
  const status = execSilent('git status --porcelain');
  if (status) {
    log('⚠️  You have uncommitted changes. Please commit or stash them first.', 'yellow');
    console.log(status);
    process.exit(1);
  }

  // Check if on correct branch
  const currentBranch = execSilent('git rev-parse --abbrev-ref HEAD');
  log(`Current branch: ${currentBranch}`, 'blue');

  // Bump version using npm
  log(`\n📦 Bumping version (${releaseType})...`, 'blue');
  exec(`npm version ${releaseType} --no-git-tag-version`);

  // Read new version from package.json
  const packageJson = readJson('package.json');
  const newVersion = packageJson.version;
  
  log(`✅ Version bumped to: ${newVersion}`, 'green');

  // Update server.json
  log('\n📝 Updating server.json...', 'blue');
  const serverJson = readJson('server.json');
  serverJson.version = newVersion;
  serverJson.packages[0].version = newVersion;
  writeJson('server.json', serverJson);
  log('✅ server.json updated', 'green');

  // Run quality checks
  log('\n🔍 Running quality checks...', 'blue');
  exec('npm run lint');
  exec('npm run type-check');
  exec('npm run build');
  log('✅ All checks passed', 'green');

  // Git commit and tag
  log('\n📌 Creating git commit and tag...', 'blue');
  exec('git add package.json server.json package-lock.json');
  exec(`git commit -m "chore: release v${newVersion}"`);
  exec(`git tag -a v${newVersion} -m "Release v${newVersion}"`);
  log(`✅ Created tag v${newVersion}`, 'green');

  // Push to remote
  log('\n🌐 Pushing to GitHub...', 'blue');
  log('This will trigger automated publishing to npm and MCP Registry', 'yellow');
  
  const push = execSilent('read -p "Push to GitHub? (y/N): " answer && echo $answer');
  
  if (push.toLowerCase() === 'y') {
    exec(`git push origin ${currentBranch}`);
    exec(`git push origin v${newVersion}`);
    
    log('\n✨ Release v' + newVersion + ' completed successfully!', 'green');
    log('\n📋 Next steps:', 'cyan');
    log('  1. GitHub Actions will automatically publish to npm', 'blue');
    log('  2. MCP Registry will be updated', 'blue');
    log('  3. GitHub Release will be created with notes', 'blue');
    log(`  4. Monitor: https://github.com/j0hanz/super-fetch-mcp-server/actions`, 'blue');
  } else {
    log('\n⏸️  Release prepared but not pushed', 'yellow');
    log('To push manually, run:', 'blue');
    log(`  git push origin ${currentBranch}`, 'cyan');
    log(`  git push origin v${newVersion}`, 'cyan');
  }
}

main().catch(error => {
  log(`\n❌ Release failed: ${error.message}`, 'red');
  process.exit(1);
});
