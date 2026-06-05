const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');

function logError(funcName, error) {
  console.error(`[ERROR] Lỗi tại test-unpack.js > ${funcName}:`, error);
}

try {
  // 1. Đọc phiên bản electron từ node_modules/electron/package.json
  const electronPkgPath = path.join(__dirname, 'node_modules', 'electron', 'package.json');
  if (!fs.existsSync(electronPkgPath)) {
    throw new Error('Không tìm thấy thư mục node_modules/electron. Vui lòng chạy npm install trước.');
  }
  const electronPkg = JSON.parse(fs.readFileSync(electronPkgPath, 'utf8'));
  const electronVersion = electronPkg.version;
  console.log(`[*] Phát hiện phiên bản Electron đang sử dụng: ${electronVersion}`);

  // 2. Định nghĩa các đường dẫn
  const appBuilderPath = path.join(__dirname, 'node_modules', 'app-builder-bin', 'win', 'x64', 'app-builder.exe');
  const outputDir = path.join(__dirname, '..', 'output', 'linux-unpacked');
  
  // Tạo thư mục output nếu chưa có
  const parentOutputDir = path.join(__dirname, '..', 'output');
  if (!fs.existsSync(parentOutputDir)) {
    fs.mkdirSync(parentOutputDir, { recursive: true });
  }

  // 3. Tự động kiểm tra và tải file zip của Electron Linux về cache nếu chưa có
  const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE, 'AppData', 'Local');
  const cacheDir = path.join(localAppData, 'electron', 'Cache');
  const zipFileName = `electron-v${electronVersion}-linux-x64.zip`;
  const zipFilePath = path.join(cacheDir, zipFileName);

  if (!fs.existsSync(zipFilePath)) {
    console.log(`[*] Không tìm thấy ${zipFileName} trong cache. Đang tải tự động...`);
    const url = `https://github.com/electron/electron/releases/download/v${electronVersion}/${zipFileName}`;
    
    // Tạo thư mục cache nếu chưa có
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    
    // Sử dụng PowerShell để tải file zip để không cần thêm thư viện ngoài (như axios hay request)
    // Điều này giúp script chạy cực kỳ gọn nhẹ và tương thích tốt trên Windows.
    const downloadCmd = `Invoke-WebRequest -Uri "${url}" -OutFile "${zipFilePath}"`;
    const downloadRes = spawnSync('powershell.exe', ['-Command', downloadCmd], { stdio: 'inherit' });
    
    if (downloadRes.status !== 0) {
      throw new Error(`Tải file zip Electron Linux thất bại từ: ${url}`);
    }
    console.log(`[OK] Đã tải thành công và lưu vào cache: ${zipFilePath}`);
  } else {
    console.log(`[*] Đã tìm thấy file zip Electron Linux trong cache: ${zipFilePath}`);
  }

  // 4. Chạy app-builder.exe unpack-electron
  const config = JSON.stringify([{ platform: 'linux', arch: 'x64', version: electronVersion }]);
  console.log('[*] Đang chạy app-builder unpack-electron để giải nén nhân Electron Linux...');
  
  const result = spawnSync(appBuilderPath, [
    'unpack-electron',
    '--configuration', config,
    '--output', outputDir
  ], { encoding: 'utf8' });

  if (result.status !== 0) {
    throw new Error(`app-builder unpack-electron thất bại. Stderr: ${result.stderr}`);
  }
  console.log('[OK] Giải nén nhân Electron Linux thành công!');
} catch (err) {
  logError('main', err.message);
  process.exit(1);
}
