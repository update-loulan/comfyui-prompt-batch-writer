@echo off
setlocal

REM ============================================================
REM  GitHub identity (used for commit attribution, can be anything)
REM ============================================================
set GIT_NAME=update-loulan
set GIT_EMAIL=update-loulan@users.noreply.github.com

REM ============================================================
REM  Your repository URL
REM ============================================================
set REPO_URL=https://github.com/update-loulan/comfyui-prompt-batch-writer.git

cd /d "%~dp0"

git config user.name "%GIT_NAME%"
git config user.email "%GIT_EMAIL%"

git init
git add .
git commit -m "Update Loulan-prompt"
git branch -M main
git remote remove origin 2>nul
git remote add origin %REPO_URL%
REM Force push: overwrites whatever is on the remote with the current files.
git push -u origin main --force

echo.
echo Done. If push still failed, see the error above.
pause
