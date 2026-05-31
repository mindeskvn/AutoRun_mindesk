# ============================================================
# publish_release.py — Tự động đóng gói và tạo Release trên GitHub
# Version: 1.2.0 (Chạy tại root workspace)
# Mục đích: Tự động đóng gói và tải các sản phẩm cài đặt lẻ (.exe, .zip, .vsix) lên GitHub Releases
# ============================================================
import os
import sys
import json
import zipfile
import requests

# Thiet lap encoding UTF-8 cho console output tren Windows de tranh loi charmap codec
try:
    if sys.stdout.encoding != 'utf-8':
        sys.stdout.reconfigure(encoding='utf-8')
    if sys.stderr.encoding != 'utf-8':
        sys.stderr.reconfigure(encoding='utf-8')
except Exception as _e:
    pass

# Xác định thư mục gốc của dự án
ROOT_DIR = os.path.dirname(os.path.abspath(__file__))

TOKEN_FILE = os.path.join(ROOT_DIR, "github_token.txt")
VERSION_FILE = os.path.join(ROOT_DIR, "version.json")
OUTPUT_DIR = os.path.join(ROOT_DIR, "output")

def print_error(func_name, message):
    print(f"[ERROR] Lỗi tại publish_release.py > {func_name}: {message}", file=sys.stderr)

def get_github_repo():
    """
    Xác định repository GitHub (dạng owner/repo) từ cấu hình Git remote hoặc file cấu hình lưu tạm github_remote.txt.
    """
    try:
        remote_url = ""
        # 1. Thử đọc từ file github_remote.txt trước
        remote_file = os.path.join(ROOT_DIR, "github_remote.txt")
        if os.path.exists(remote_file):
            with open(remote_file, "r", encoding="utf-8") as f:
                remote_url = f.read().strip()
        
        # 2. Nếu không tìm thấy, thử chạy lệnh git remote get-url origin
        if not remote_url:
            import subprocess
            res = subprocess.run(["git", "remote", "get-url", "origin"], 
                                 capture_output=True, text=True, cwd=ROOT_DIR)
            if res.returncode == 0:
                remote_url = res.stdout.strip()
                
        if remote_url:
            url = remote_url.replace("\\", "/")
            if "github.com/" in url:
                parts = url.split("github.com/")[-1].split("/")
                if len(parts) >= 2:
                    owner = parts[0]
                    repo = parts[1]
                    if repo.endswith(".git"):
                        repo = repo[:-4]
                    return f"{owner}/{repo}"
            elif "github.com:" in url:
                parts = url.split("github.com:")[-1].split("/")
                if len(parts) >= 2:
                    owner = parts[0]
                    repo = parts[1]
                    if repo.endswith(".git"):
                        repo = repo[:-4]
                    return f"{owner}/{repo}"
        
        return "mindeskvn/AutoRun_mindesk"
    except Exception as e:
        print_error("get_github_repo", f"Lỗi xác định repository: {str(e)}")
        return "mindeskvn/AutoRun_mindesk"

def zip_output_directory(output_dir, zip_file_path):
    """
    Nén thư mục output thành tệp ZIP và loại bỏ các file tạm, file cấu hình bảo mật.
    """
    try:
        print(f"[*] Đang thực hiện quét và lọc tệp tin từ: {output_dir}")
        with zipfile.ZipFile(zip_file_path, 'w', zipfile.ZIP_DEFLATED) as zipf:
            count = 0
            for root, dirs, files in os.walk(output_dir):
                for file in files:
                    file_path = os.path.join(root, file)
                    rel_path = os.path.relpath(file_path, output_dir)
                    
                    normalized_path = rel_path.replace("\\", "/")
                    path_parts = normalized_path.split("/")
                    
                    # Quy tắc lọc bỏ dữ liệu cá nhân & file phát triển thừa:
                    if "Data" in path_parts:
                        continue
                    if "github_token" in normalized_path or "publish_release" in normalized_path:
                        continue
                    if "__pycache__" in path_parts or rel_path.endswith(".pyc") or rel_path.endswith(".pyo"):
                        continue
                    if ".git" in path_parts or rel_path == ".gitignore":
                        continue
                    
                    zipf.write(file_path, rel_path)
                    count += 1
            print(f"[OK] Đã lọc và đóng gói thành công {count} tệp tin vào {os.path.basename(zip_file_path)}.")
            return True
    except Exception as e:
        print_error("zip_output_directory", f"Lỗi nén tệp tin: {str(e)}")
        return False

def main():
    try:
        is_non_interactive = "--yes" in sys.argv or "--non-interactive" in sys.argv
        # 1. Đọc thông tin từ version.json
        if not os.path.exists(VERSION_FILE):
            print_error("main", f"Không tìm thấy file {VERSION_FILE} tại {ROOT_DIR}!")
            return False
            
        with open(VERSION_FILE, "r", encoding="utf-8") as f:
            version_data = json.load(f)
            
        version = version_data.get("version")
        changelog_list = version_data.get("changelog", [])
        changelog = "\n".join([f"- {item}" for item in changelog_list])
        
        if not version:
            print_error("main", "Không tìm thấy trường 'version' trong version.json!")
            return False
            
        tag_name = f"v{version}"
        repo = get_github_repo()
        print(f"[*] Đang chuẩn bị tạo Release cho phiên bản: {tag_name} trên repository GitHub: {repo}")

        # 2. Lấy GitHub Personal Access Token
        token = ""
        if os.path.exists(TOKEN_FILE):
            with open(TOKEN_FILE, "r", encoding="utf-8") as f:
                token = f.read().strip()
                
        if not token:
            if is_non_interactive:
                print_error("main", "GitHub Token không được cung cấp trong file github_token.txt và chương trình đang chạy dưới chế độ tự động (non-interactive)!")
                return False
            print("=" * 60)
            print(" YÊU CẦU CẤP QUYỀN GITHUB PERSONAL ACCESS TOKEN (PAT)")
            print("=" * 60)
            print("Để tự động tạo Release và tải bản cài đặt lên GitHub, bạn cần cung cấp một Token.")
            try:
                token = input("Nhập GitHub Personal Access Token của bạn: ").strip()
            except Exception as e:
                print_error("main", f"Không thể đọc token từ thiết bị nhập chuẩn: {str(e)}")
                return False
            if not token:
                print_error("main", "Token không được để trống!")
                return False
            with open(TOKEN_FILE, "w", encoding="utf-8") as f:
                f.write(token)
            print(f"[OK] Đã lưu Token vào: {TOKEN_FILE}")

        headers = {
            "Authorization": f"token {token}",
            "Accept": "application/vnd.github.v3+json"
        }

        # 3. Kiểm tra tính hợp lệ của Token
        print("[*] Đang xác thực Token với GitHub...")
        user_res = requests.get("https://api.github.com/user", headers=headers)
        if user_res.status_code != 200:
            print_error("main", f"Token không hợp lệ hoặc đã hết hạn! (HTTP {user_res.status_code})")
            if os.path.exists(TOKEN_FILE):
                os.remove(TOKEN_FILE)
            return False
        user_name = user_res.json().get("login")
        print(f"[OK] Xác thực thành công tài khoản: {user_name}")

        # 4. Định nghĩa file ZIP tổng hợp động theo version và thực hiện nén
        zip_file_name = f"AutoRun_Mindesk_v{version}.zip"
        zip_file_path = os.path.join(ROOT_DIR, zip_file_name)
        
        if not os.path.exists(OUTPUT_DIR):
            print_error("main", f"Không tìm thấy thư mục 'output' tại {ROOT_DIR}!")
            return False
            
        # Nếu có file ZIP cũ trùng tên thì xóa đi
        if os.path.exists(zip_file_path):
            os.remove(zip_file_path)
            
        # Thực hiện nén lọc tệp tin
        zip_success = zip_output_directory(OUTPUT_DIR, zip_file_path)
        if not zip_success:
            print_error("main", "Quá trình đóng gói tệp ZIP bị lỗi!")
            return False

        # 5. Kiểm tra xem Release đã tồn tại chưa
        print(f"[*] Đang kiểm tra Release {tag_name} trên GitHub...")
        check_release_res = requests.get(f"https://api.github.com/repos/{repo}/releases/tags/{tag_name}", headers=headers)
        
        release_id = None
        if check_release_res.status_code == 200:
            release_id = check_release_res.json().get("id")
            print(f"[!] Phát hiện Release {tag_name} đã tồn tại trên GitHub.")
            
            overwrite = "Y"
            if not is_non_interactive:
                try:
                    overwrite = input(f"[?] Bạn có muốn xóa bản Release cũ này để tạo lại không? (Y/N, Mặc định Y): ").strip().upper()
                except Exception:
                    overwrite = "Y"
            
            if overwrite != "N":
                print(f"[*] Đang xóa bản Release cũ (ID: {release_id})...")
                del_res = requests.delete(f"https://api.github.com/repos/{repo}/releases/{release_id}", headers=headers)
                if del_res.status_code == 204:
                    print("[OK] Đã xóa bản Release cũ.")
                    requests.delete(f"https://api.github.com/repos/{repo}/git/refs/tags/{tag_name}", headers=headers)
                    release_id = None
                else:
                    print_error("main", f"Không thể xóa bản Release cũ! (HTTP {del_res.status_code})")
                    return False
            else:
                print("[*] Giữ nguyên Release cũ. Kết thúc.")
                return True
 
        # 6. Tạo Release mới
        if release_id is None:
            print(f"[*] Đang tạo Release mới: {tag_name}...")
            
            instructions = (
                f"\n\n### 📦 Hướng dẫn tải và cài đặt các phiên bản:\n"
                f"- **Bản Windows (.exe):** Tải và chạy trực tiếp file `antigravity-auto-run-desktop-windows-v{version}.exe` (Bản Portable không cần cài đặt).\n"
                f"- **Bản Linux (.zip):** Tải file `antigravity-auto-run-desktop-linux-v{version}.zip`, giải nén và chạy file thực thi để sử dụng.\n"
                f"- **Extension cho IDE (.vsix):** Tải file `antigravity-auto-run-ext-v{version}.vsix`. Trong IDE (Cursor / VS Code), nhấn `Ctrl+Shift+P` -> chọn `Extensions: Install from VSIX...` -> chọn file vừa tải để cài đặt.\n"
                f"- **Gói tổng hợp (.zip):** Tải file `AutoRun_Mindesk_v{version}.zip` nếu muốn sở hữu toàn bộ các bản cài đặt trên."
            )
            
            release_payload = {
                "tag_name": tag_name,
                "target_commitish": "main",
                "name": f"{tag_name} - AutoRun Mindesk Release",
                "body": f"### 📝 Nhật ký cập nhật phiên bản {tag_name}:\n{changelog}{instructions}",
                "draft": False,
                "prerelease": False
            }
            
            create_res = requests.post(f"https://api.github.com/repos/{repo}/releases", headers=headers, json=release_payload)
            if create_res.status_code != 201:
                print_error("main", f"Không thể tạo Release mới! Chi tiết: {create_res.text}")
                return False
                
            release_id = create_res.json().get("id")
            print(f"[OK] Đã tạo Release mới thành công! (ID: {release_id})")
        
        # 7. Upload tất cả các file trong thư mục output và file ZIP tổng hợp
        assets_to_upload = []
        
        # Thêm file ZIP tổng hợp (nếu tồn tại)
        if os.path.exists(zip_file_path):
            assets_to_upload.append((zip_file_path, zip_file_name))
        
        # Thêm các file lẻ trong thư mục output
        if os.path.exists(OUTPUT_DIR):
            for file in os.listdir(OUTPUT_DIR):
                full_path = os.path.join(OUTPUT_DIR, file)
                if os.path.isfile(full_path):
                    if file.endswith(('.exe', '.zip', '.vsix', '.tar.gz', '.dmg', '.pkg', '.deb', '.AppImage')):
                        assets_to_upload.append((full_path, file))
        
        print(f"[*] Danh sách asset chuẩn bị upload lên Release:")
        for _, name in assets_to_upload:
            print(f"  - {name}")

        upload_success = True
        for path_file, name_file in assets_to_upload:
            try:
                with open(path_file, "rb") as f_asset:
                    file_data = f_asset.read()
                
                content_type = "application/octet-stream"
                if name_file.endswith(".zip"):
                    content_type = "application/zip"
                elif name_file.endswith(".exe"):
                    content_type = "application/x-msdownload"
                elif name_file.endswith(".vsix"):
                    content_type = "application/vsix"
                
                upload_headers = {
                    "Authorization": f"token {token}",
                    "Content-Type": content_type,
                    "Content-Length": str(len(file_data))
                }
                
                print(f"[*] Đang tải tệp {name_file} ({round(len(file_data)/1024/1024, 2)} MB) lên Release...")
                upload_res = requests.post(
                    f"https://uploads.github.com/repos/{repo}/releases/{release_id}/assets?name={name_file}",
                    headers=upload_headers,
                    data=file_data
                )
                
                if upload_res.status_code == 201:
                    print(f"[OK] Đã tải thành công tệp: {name_file}")
                else:
                    print_error("upload_assets", f"Tải tệp {name_file} thất bại! (HTTP {upload_res.status_code}): {upload_res.text}")
                    upload_success = False
            except Exception as e:
                print_error("upload_assets", f"Lỗi khi tải tệp {name_file}: {str(e)}")
                upload_success = False

        # Dọn dẹp tệp zip tổng hợp ở root sau khi tải lên xong
        if os.path.exists(zip_file_path):
            try:
                os.remove(zip_file_path)
                print(f"[OK] Đã dọn dẹp file ZIP tổng hợp tạm thời: {zip_file_name}")
            except Exception as e:
                print(f"[WARNING] Không thể dọn dẹp file ZIP tạm thời: {str(e)}")

        if upload_success:
            print("=" * 60)
            print(f"[OK] ĐÃ TỰ ĐỘNG TẠO RELEASE {tag_name} VÀ UPLOAD TẤT CẢ CÁC BẢN CÀI ĐẶT THÀNH CÔNG!")
            print("=" * 60)
        else:
            print_error("main", "Có lỗi xảy ra trong quá trình tải một hoặc nhiều tệp tin lên GitHub Release!")
            return False
            
        return True

    except Exception as e:
        print_error("main", f"Xảy ra ngoại lệ hệ thống: {str(e)}")
        return False

if __name__ == "__main__":
    success = main()
    os.system("pause")
    sys.exit(0 if success else 1)
