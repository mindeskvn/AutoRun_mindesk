@echo off
cd /d "%~dp0AutoRun-Extension"

echo ====================================================
echo * BAT DAU DONG GOI EXTENSION ANTIGRAVITY AUTO-RUN *
echo ====================================================
echo.

if not exist "package.json" (
    echo [ERROR] Khong tim thay file package.json trong thu muc: %CD%
    pause
    exit /b 1
)

echo [1/2] Dang cap nhat phien ban tu version.txt...
node -e "try{const fs=require('fs');const v=fs.readFileSync('version.txt','utf8').trim();const p=JSON.parse(fs.readFileSync('package.json','utf8'));p.version=v;fs.writeFileSync('package.json',JSON.stringify(p,null,2)+'\n','utf8');console.log('Synchronized version to:',v);}catch(err){console.error('[Error in build_script]: Version sync failed. Detail:',err.message);process.exit(1);}"

if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Dong bo phien ban that bai.
    pause
    exit /b 1
)

echo.
echo [2/2] Dang dong goi extension thanh file .vsix...
if not exist "node_modules" (
    echo [*] Dang cai dat dependencies cho Extension...
    call npm install
)
call npx -y @vscode/vsce package --allow-missing-repository

if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Qua trinh dong goi that bai. Vui long kiem tra console log.
    pause
    exit /b 1
)

:: Tao thu muc output o root neu chua ton tai
if not exist "%~dp0output" (
    mkdir "%~dp0output"
)

:: Di chuyen tat ca cac file .vsix vua tao ve thu muc output
move /y *.vsix "%~dp0output\" > nul

echo.
echo ====================================================
echo * HOAN THANH DONG GOI EXTENSION THANH CONG! *
echo ====================================================
echo File cai dat .vsix da duoc dua vao thu muc output: %~dp0output
echo.
pause
