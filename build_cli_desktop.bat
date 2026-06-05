@echo off
cd /d "%~dp0AutoRun-CLI-Extension"

echo ====================================================
echo * BAT DAU DONG GOI CLI DESKTOP ANTIGRAVITY AUTO-RUN*
echo ====================================================
echo.

if not exist "package.json" (
    echo [ERROR] Khong tim thay file package.json trong thu muc: %CD%
    pause
    exit /b 1
)

:: Kiem tra va cai dat dependencies neu chua co
if not exist "node_modules" (
    echo [1/4] Dang tai va cai dat cac thu vien can thiet - npm install...
    call npm install
) else (
    echo [1/4] Cac thu vien da duoc cai dat tu truoc, bo qua buoc npm install.
)

if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Cai dat cac thu vien that bai. Vui long kiem tra npm va ket noi mang.
    pause
    exit /b 1
)

echo.
echo [2/4] Dang dong goi ung dung CLI Desktop cho Windows...
call npm run build:win

if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Qua trinh dong goi Windows that bai.
    pause
    exit /b 1
)

echo.
echo [3/4] Dang dong goi ung dung CLI Desktop cho Linux (zip)...
call npm run build:linux

if %ERRORLEVEL% neq 0 (
    echo.
    echo [ERROR] Qua trinh dong goi Linux that bai.
    pause
    exit /b 1
)

echo.
echo [4/4] Dang kiem tra dong goi cho macOS...
echo [INFO] Electron-builder chi ho tro dong goi ung dung macOS tren may macOS.
echo [INFO] Bo qua buoc dong goi macOS tren moi truong Windows hien tai.
echo [INFO] De build ban Mac, hay mang thu muc 'AutoRun-CLI-Extension' sang may Mac va chay lenh: npm run build:mac

echo.
echo ====================================================
echo * HOAN THANH DONG GOI CLI DESKTOP APP THANH CONG!  *
echo ====================================================
echo File cai dat cho Windows va Linux da duoc tao va chuyen vao thu muc output o root.
echo.
pause
