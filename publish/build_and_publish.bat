@echo off
title Quy trinh tu dong hoa Build va Publish - AutoRun Mindesk
:: Chuyen thu muc lam viec hien tai len thu muc cha (root workspace cua du an)
cd /d "%~dp0.."

echo ====================================================
echo * BUOC 1: DONG BO PHIEN BAN (VERSION SYNC) *
====================================================
set "GUI_VERSION="
if not exist "antigravity-auto-run-ext\version.txt" (
    echo [ERROR] Khong tim thay file version.txt trong antigravity-auto-run-ext!
    pause
    exit /b 1
)
set /p GUI_VERSION=<"antigravity-auto-run-ext\version.txt"
set GUI_VERSION=%GUI_VERSION: =%
echo [*] Phat hien phien ban: %GUI_VERSION%

:: Don dep thu muc output truoc khi build bat ky thanh phan nao
if exist "output" rmdir /s /q "output" >nul 2>&1
mkdir "output"

:: Cap nhat package.json cua Extension
echo [*] Dang cap nhat package.json cua Extension...
node -e "try{const fs=require('fs');const v=fs.readFileSync('antigravity-auto-run-ext/version.txt','utf8').trim();const p=JSON.parse(fs.readFileSync('antigravity-auto-run-ext/package.json','utf8'));p.version=v;fs.writeFileSync('antigravity-auto-run-ext/package.json',JSON.stringify(p,null,2)+'\n','utf8');console.log('[OK] Extension version updated.');}catch(err){console.error('[Error]:',err.message);process.exit(1);}"
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Cap nhat Extension package.json that bai!
    pause
    exit /b 1
)

:: Cap nhat package.json cua Desktop App
echo [*] Dang cap nhat package.json cua Desktop App...
node -e "try{const fs=require('fs');const v=fs.readFileSync('antigravity-auto-run-ext/version.txt','utf8').trim();const p=JSON.parse(fs.readFileSync('antigravity-auto-run-desktop/package.json','utf8'));p.version=v;fs.writeFileSync('antigravity-auto-run-desktop/package.json',JSON.stringify(p,null,2)+'\n','utf8');console.log('[OK] Desktop App version updated.');}catch(err){console.error('[Error]:',err.message);process.exit(1);}"
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Cap nhat Desktop package.json that bai!
    pause
    exit /b 1
)

:: Cap nhat version.json cua Github Release trong thu muc publish
if exist "publish\version.json" (
    echo [*] Dang cap nhat version.json...
    python -c "import json; f=open('publish/version.json', 'r+', encoding='utf-8'); d=json.load(f); d['version']='%GUI_VERSION%'; d['download_url']='https://github.com/mindeskvn/AutoRun_mindesk/releases/download/v%GUI_VERSION%/Auto-Run-Desktop-windows-v%GUI_VERSION%.exe'; f.seek(0); json.dump(d, f, indent=2, ensure_ascii=False); f.truncate(); f.close()" >nul 2>&1
)

echo.
echo ====================================================
echo * BUOC 2: DONG GOI EXTENSION (.vsix) *
===================================================
:: Xoa file .vsix cu truoc khi build de tranh rac
if exist "antigravity-auto-run-ext\*.vsix" del /q "antigravity-auto-run-ext\*.vsix"
if exist "output\*.vsix" del /q "output\*.vsix"

cd antigravity-auto-run-ext
call npx -y @vscode/vsce package --no-dependencies --allow-missing-repository
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Dong goi Extension that bai!
    pause
    exit /b 1
)
cd ..

:: Di chuyen sang output
if not exist "output" mkdir "output"
move /y antigravity-auto-run-ext\*.vsix output\ > nul
ren "output\antigravity-auto-run-ext-%GUI_VERSION%.vsix" "antigravity-auto-run-ext-v%GUI_VERSION%.vsix" > nul 2>&1

echo.
echo ====================================================
echo * BUOC 3: DONG GOI DESKTOP APP (.exe va .tar.gz) *
====================================================
:: Tat cac tien trinh electron/desktop app dang chay ngam de tranh lock file
taskkill /f /im "Antigravity Auto-Run.exe" >nul 2>&1

cd antigravity-auto-run-desktop
if not exist "node_modules" (
    echo [*] Dang cai dat dependencies cho Desktop App...
    call npm install
)
echo [*] Dang dong goi cho Windows...
call npm run build:win
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Build Windows that bai!
    pause
    exit /b 1
)
echo [*] Dang dong goi cho Linux...
call npm run build:linux
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Build Linux that bai!
    pause
    exit /b 1
)
echo [INFO] Bo qua build macOS tren Windows.
cd ..

echo.
echo ====================================================
echo * BUOC 4: PUSH CODE LEN GITHUB REPOSITORY *
====================================================

:: Khoi tao git neu chua co
if not exist ".git" (
    git init >nul 2>&1
)

:: Reset va thiet lap remote origin tu file/default de tranh loi URL rong hoac sai
set "REMOTE_URL=https://github.com/mindeskvn/AutoRun_mindesk.git"
if exist "publish\github_remote.txt" (
    set /p REMOTE_URL=<publish\github_remote.txt
)
git remote remove origin >nul 2>&1
git remote add origin "%REMOTE_URL%" >nul 2>&1

git add .
set "commit_time=%date% %time%"
git commit -m "Auto update version %GUI_VERSION% - %commit_time%" >nul 2>&1
git branch -M main >nul 2>&1
echo [*] Dang push thong tin len GitHub...
git push -f -u origin main
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Push code len GitHub that bai!
    pause
    exit /b 1
)

echo.
echo ====================================================
echo * BUOC 5: TAO RELEASE VA UPLOAD ASSETS *
====================================================
python -u publish\publish_release.py --yes
if %ERRORLEVEL% neq 0 (
    echo [ERROR] Tao Release tren GitHub that bai!
    pause
    exit /b 1
)

echo.
echo ====================================================
echo * HOAN THANH TOAN BO QUY TRINH TU DONG HOA! *
====================================================
echo Tat ca cac file build da duoc day len GitHub Releases thanh cong!
echo.
ping 127.0.0.1 -n 6 >nul
