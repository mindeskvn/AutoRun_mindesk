---
name: antigravity-version-sync
description: >-
  Hướng dẫn các AI agent quy trình đồng bộ phiên bản và đóng gói tự động cho Extension và Desktop App của dự án Antigravity Auto-Run.
---

# Antigravity Version Sync

## Overview
Skill này hướng dẫn quy trình đồng bộ phiên bản (version) khi có bất kỳ sửa đổi hoặc cập nhật tính năng nào trong dự án Antigravity Auto-Run. Quy trình này đảm bảo tất cả các file cấu hình và log hiển thị thống nhất một phiên bản duy nhất được cấu hình từ `version.txt`.

## Quick Start
Khi bạn (AI agent) cập nhật bất kỳ dòng code nào và cần tăng phiên bản dự án:
1. Xác định phiên bản mới (ví dụ: `2.0.4`).
2. Ghi đè phiên bản mới này vào file [version.txt](file:///c:/Users/desktop/Desktop/antigravity-auto-run%202.4.0/antigravity-auto-run-ext/version.txt).
3. Cập nhật thủ công hoặc tự động các file `package.json` của cả Extension và Desktop App.
4. Chạy các file đóng gói `.bat` tương ứng ở thư mục root.

## Workflow

### 1. Cập nhật tệp nguồn phiên bản (version.txt)
*   Mở tệp [version.txt](file:///c:/Users/desktop/Desktop/antigravity-auto-run%202.4.0/antigravity-auto-run-ext/version.txt) (đây là Single Source of Truth).
*   Thay đổi chuỗi phiên bản thành phiên bản mới nhất bạn mong muốn.

### 2. Đồng bộ sang các file cấu hình dự án
Bạn phải thực hiện đồng bộ phiên bản mới này sang các tệp tin sau:
1.  **Extension package.json**: Trường `"version"` trong [antigravity-auto-run-ext/package.json](file:///c:/Users/desktop/Desktop/antigravity-auto-run%202.4.0/antigravity-auto-run-ext/package.json).
2.  **Desktop App package.json**: Trường `"version"` trong [antigravity-auto-run-desktop/package.json](file:///c:/Users/desktop/Desktop/antigravity-auto-run%202.4.0/antigravity-auto-run-desktop/package.json).

### 3. Đóng gói Extension
*   Chạy tệp tin [build_extension.bat](file:///c:/Users/desktop/Desktop/antigravity-auto-run%202.4.0/build_extension.bat) ở root bằng lệnh terminal:
    `cmd.exe /c build_extension.bat`
*   Lệnh này sẽ tự động đọc `version.txt`, kiểm tra đồng bộ, đóng gói thành file `.vsix` và di chuyển nó sang thư mục `/output/` ở root.

### 4. Đóng gói Desktop App
*   Chạy tệp tin [build_desktop.bat](file:///c:/Users/desktop/Desktop/antigravity-auto-run%202.4.0/build_desktop.bat) ở root bằng lệnh terminal:
    `cmd.exe /c build_desktop.bat`
*   Lệnh này sẽ cài đặt dependencies nếu thiếu, lần lượt đóng gói file di động Windows `.exe`, file nén Linux `tar.gz` và chuyển tất cả vào thư mục `/output/` ở root (riêng macOS sẽ được tự động bỏ qua kèm thông báo hướng dẫn trên Windows).

## Common Mistakes
1.  **Không đóng các tiến trình cũ:** File build Windows có thể báo lỗi `Access is denied` do các tiến trình `Antigravity Auto-Run.exe` cũ đang chạy ngầm trong khay hệ thống (System Tray). Hãy nhớ kill toàn bộ chúng bằng lệnh `taskkill /f /im "Antigravity Auto-Run.exe"` trước khi build.
2.  **Sử dụng ký tự Unicode trong tệp .bat:** Tuyệt đối không dùng emoji hoặc tiếng Việt có dấu lạ trong file batch vì nó sẽ gây lỗi parse của CMD trên Windows.
