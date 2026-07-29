@echo off
setlocal
cd /d "%~dp0"
set "GIT_TERMINAL_PROMPT=1"
set "GIT_HTTP_LOW_SPEED_LIMIT=1000"
set "GIT_HTTP_LOW_SPEED_TIME=30"

set "GIT_CMD="
where git >nul 2>nul && set "GIT_CMD=git"
if not defined GIT_CMD if exist "%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\cmd\git.exe" set "GIT_CMD=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\git\cmd\git.exe"
if not defined GIT_CMD (
  echo Git was not found. Send a screenshot of this window to me.
  pause
  exit /b 1
)

"%GIT_CMD%" rev-parse --is-inside-work-tree >nul 2>nul
if errorlevel 1 (
  echo Preparing the local Git repository...
  "%GIT_CMD%" init
  if errorlevel 1 goto :failed
)
"%GIT_CMD%" branch -M main

"%GIT_CMD%" remote get-url origin >nul 2>nul
if errorlevel 1 "%GIT_CMD%" remote add origin https://github.com/chacha-stella/kol-radar.git
echo Checking GitHub connection...
"%GIT_CMD%" -c http.lowSpeedLimit=1000 -c http.lowSpeedTime=30 fetch origin main
if errorlevel 1 (
  echo GitHub connection failed. Check that the internet is working, then run this file again.
  goto :failed
)
"%GIT_CMD%" show-ref --verify --quiet refs/remotes/origin/main
if not errorlevel 1 "%GIT_CMD%" reset --mixed origin/main

"%GIT_CMD%" config user.name "chacha-stella"
"%GIT_CMD%" config user.email "stella.zhuang@chessnutech.com"
"%GIT_CMD%" add index.html server.js digest-sync.js package.json pnpm-lock.yaml railway.toml .gitignore data scripts .github *.bat requirements-local.txt config\creator-search.json
"%GIT_CMD%" commit -m "Update real KOL collector and dashboard"
if errorlevel 1 echo No new changes to commit, or the commit needs attention.
echo Uploading to GitHub...
"%GIT_CMD%" push -u origin main
if errorlevel 1 goto :failed

echo.
echo Upload complete. GitHub Pages will update in a few minutes.
pause
exit /b 0

:failed
echo.
echo Upload failed. Read the error above. If it asks for login, finish GitHub login and run this file again.
pause
exit /b 1
