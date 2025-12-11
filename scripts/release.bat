@echo off
setlocal enabledelayedexpansion

echo.
echo 🚀 superFetch Release Automation
echo.

REM Check for version argument
set VERSION_TYPE=%1
if "%VERSION_TYPE%"=="" set VERSION_TYPE=patch

REM Check for uncommitted changes
git status --porcelain > nul 2>&1
if errorlevel 1 (
    echo ❌ Not a git repository
    exit /b 1
)

for /f "delims=" %%i in ('git status --porcelain') do set CHANGES=%%i
if not "!CHANGES!"=="" (
    echo ⚠️  You have uncommitted changes. Please commit or stash them first.
    git status --short
    exit /b 1
)

echo 📦 Bumping version ^(%VERSION_TYPE%^)...
call npm version %VERSION_TYPE% --no-git-tag-version
if errorlevel 1 exit /b 1

REM Read new version
for /f "tokens=*" %%a in ('node -p "require('./package.json').version"') do set NEW_VERSION=%%a
echo ✅ Version bumped to: %NEW_VERSION%

echo.
echo 📝 Updating server.json...
node -e "const fs=require('fs');const s=JSON.parse(fs.readFileSync('server.json','utf8'));s.version='%NEW_VERSION%';s.packages[0].version='%NEW_VERSION%';fs.writeFileSync('server.json',JSON.stringify(s,null,2)+'\n');"
if errorlevel 1 exit /b 1
echo ✅ server.json updated

echo.
echo 🔍 Running quality checks...
call npm run lint
if errorlevel 1 exit /b 1
call npm run type-check
if errorlevel 1 exit /b 1
call npm run build
if errorlevel 1 exit /b 1
echo ✅ All checks passed

echo.
echo 📌 Creating git commit and tag...
git add package.json server.json package-lock.json
git commit -m "chore: release v%NEW_VERSION%"
git tag -a v%NEW_VERSION% -m "Release v%NEW_VERSION%"
echo ✅ Created tag v%NEW_VERSION%

echo.
echo 🌐 Ready to push to GitHub...
echo This will trigger automated publishing to npm and MCP Registry
echo.
set /p CONFIRM="Push to GitHub? (y/N): "
if /i "%CONFIRM%"=="y" (
    for /f "tokens=*" %%b in ('git rev-parse --abbrev-ref HEAD') do set BRANCH=%%b
    git push origin !BRANCH!
    git push origin v%NEW_VERSION%
    
    echo.
    echo ✨ Release v%NEW_VERSION% completed successfully!
    echo.
    echo 📋 Next steps:
    echo   1. GitHub Actions will automatically publish to npm
    echo   2. MCP Registry will be updated
    echo   3. GitHub Release will be created with notes
    echo   4. Monitor: https://github.com/j0hanz/super-fetch-mcp-server/actions
) else (
    echo.
    echo ⏸️  Release prepared but not pushed
    echo To push manually, run:
    for /f "tokens=*" %%c in ('git rev-parse --abbrev-ref HEAD') do (
        echo   git push origin %%c
        echo   git push origin v%NEW_VERSION%
    )
)
