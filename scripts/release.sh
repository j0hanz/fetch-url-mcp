#!/bin/bash
# Quick release script for Unix-based systems (macOS, Linux)
# Usage: ./scripts/release.sh [patch|minor|major|version]

set -e

VERSION_TYPE="${1:-patch}"

echo ""
echo "🚀 superFetch Release Automation"
echo ""

# Check for uncommitted changes
if [[ -n $(git status -s) ]]; then
    echo "⚠️  You have uncommitted changes. Please commit or stash them first."
    git status -s
    exit 1
fi

echo "📦 Bumping version ($VERSION_TYPE)..."
npm version "$VERSION_TYPE" --no-git-tag-version

NEW_VERSION=$(node -p "require('./package.json').version")
echo "✅ Version bumped to: $NEW_VERSION"

echo ""
echo "📝 Updating server.json..."
node -e "const fs=require('fs');const s=JSON.parse(fs.readFileSync('server.json','utf8'));s.version='$NEW_VERSION';s.packages[0].version='$NEW_VERSION';fs.writeFileSync('server.json',JSON.stringify(s,null,2)+'\n');"
echo "✅ server.json updated"

echo ""
echo "🔍 Running quality checks..."
npm run lint
npm run type-check
npm run build
echo "✅ All checks passed"

echo ""
echo "📌 Creating git commit and tag..."
git add package.json server.json package-lock.json
git commit -m "chore: release v$NEW_VERSION"
git tag -a "v$NEW_VERSION" -m "Release v$NEW_VERSION"
echo "✅ Created tag v$NEW_VERSION"

echo ""
echo "🌐 Ready to push to GitHub..."
echo "This will trigger automated publishing to npm and MCP Registry"
echo ""
read -p "Push to GitHub? (y/N): " -n 1 -r
echo

if [[ $REPLY =~ ^[Yy]$ ]]; then
    BRANCH=$(git rev-parse --abbrev-ref HEAD)
    git push origin "$BRANCH"
    git push origin "v$NEW_VERSION"
    
    echo ""
    echo "✨ Release v$NEW_VERSION completed successfully!"
    echo ""
    echo "📋 Next steps:"
    echo "  1. GitHub Actions will automatically publish to npm"
    echo "  2. MCP Registry will be updated"
    echo "  3. GitHub Release will be created with notes"
    echo "  4. Monitor: https://github.com/j0hanz/super-fetch-mcp-server/actions"
else
    echo ""
    echo "⏸️  Release prepared but not pushed"
    echo "To push manually, run:"
    echo "  git push origin $(git rev-parse --abbrev-ref HEAD)"
    echo "  git push origin v$NEW_VERSION"
fi
