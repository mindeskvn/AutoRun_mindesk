# Antigravity Auto-Run (Phiên bản Đa nền tảng)

Dự án tiện ích tự động hóa và bảo vệ hệ thống thông minh, giúp tối ưu hóa tối đa hiệu suất và mang lại sự an tâm tuyệt đối khi lập trình trên ứng dụng **Antigravity IDE** và **Antigravity CLI**.

---

## 1. Giới thiệu tính năng (Ứng dụng có thể làm gì)

*   **Tự động click chấp nhận thông báo:** Tự động phát hiện và bấm các nút xác nhận như "Run", "Accept", "Allow", "Continue" trên IDE. Bạn sẽ không còn bị làm phiền bởi các hộp thoại yêu cầu click thủ công liên tục.
*   **Chặn câu lệnh phá hoại hệ thống:** Tự động phát hiện, ngăn chặn và cảnh báo ngay lập tức nếu có bất kỳ câu lệnh nguy hiểm nào (như xóa dữ liệu, format ổ đĩa,...) chuẩn bị được thực thi trên máy tính của bạn.
*   **Tự động cấu hình môi trường:** Tự thiết lập các cài đặt cần thiết ngay khi khởi chạy để đảm bảo tính năng tự động hóa hoạt động ngay lập tức mà không yêu cầu bạn phải cài đặt phức tạp.
*   **Hoạt động linh hoạt song song:** Hỗ trợ hiển thị và điều khiển nhanh dưới dạng một thanh trạng thái nhỏ gọn nằm ngay góc dưới của IDE, hoặc giao diện quản lý chuyên sâu trên Desktop.
*   **Chạy ẩn thông minh:** Ứng dụng Desktop có thể thu nhỏ xuống góc màn hình và chạy ẩn dưới nền để không gây vướng víu trong quá trình bạn viết code.

---

## 2. Giới thiệu giao diện

Ứng dụng Desktop mang phong cách thiết kế sang trọng, hiện đại với giao diện tối và hiệu ứng kính mờ (Glassmorphism):
*   **Bảng thông tin Dashboard:** Hiển thị trực quan trạng thái đang hoạt động, tổng số lượt click đã tự động thực hiện và số câu lệnh đã được quét an toàn.
*   **Biểu đồ theo dõi trực quan:** Cung cấp biểu đồ động ghi nhận hoạt động tự động hóa theo thời gian thực để bạn nắm bắt hiệu suất làm việc.
*   **Trình quản lý thiết lập:** Giao diện cho phép bạn tự thêm/bớt các từ khóa câu lệnh muốn chặn, bật/tắt nhanh các tính năng tự động click theo nhu cầu.
*   **Bảng nhật ký hoạt động (Live Logs):** Hiển thị danh sách các hành động ứng dụng đã thực hiện một cách minh bạch, rõ ràng và mượt mà.
*   **Biểu tượng khay hệ thống:** Icon nhỏ gọn nằm ở góc phải màn hình máy tính giúp bạn mở nhanh, tạm dừng hoặc thoát ứng dụng chỉ với một cú click chuột phải.

---

## 3. Phân loại các phiên bản và Cách sử dụng

Dự án được phát triển song song hai nhánh ứng dụng chuyên biệt để phục vụ tối đa nhu cầu của lập trình viên:

### 3.1. Dành cho Antigravity IDE (File thực thi: `Antigravity IDE.exe`)

Nhánh này giúp tự động click các thông báo (Run/Accept/Allow/Continue) và chặn lệnh nguy hiểm ngay trên giao diện soạn thảo IDE.

#### 🔧 Cách cài đặt và sử dụng:
1. **Extension cho IDE:**
   * Tải file `antigravity-auto-run-ext-v2.5.5.vsix` tại trang [Releases](https://github.com/mindeskvn/AutoRun_mindesk/releases).
   * Mở IDE, nhấn `Ctrl + Shift + P` -> chọn **`Extensions: Install from VSIX...`**.
   * Chọn file `.vsix` vừa tải để cài đặt. Công cụ điều khiển nhanh sẽ hiển thị ở StatusBar của IDE.
2. **Desktop App điều khiển:**
   * **Windows:** Tải và chạy trực tiếp file cài đặt `Auto-Run-Desktop-windows-setup-v2.5.5.exe`.
   * **Linux:** Tải file `Auto-Run-Desktop-linux-v2.5.5.zip`, giải nén và chạy file thực thi để điều khiển.

---

### 3.2. Dành cho Antigravity CLI (File thực thi: `Antigravity.exe`)

Nhánh này giúp tự động trả lời Yes/Allow các xác nhận cấp quyền và tự động gửi lệnh chạy trên Terminal của Antigravity CLI.

#### 🔧 Cách cài đặt và sử dụng:
* **Windows:** Tải và chạy trực tiếp file cài đặt `CLI-Auto-Run-Desktop-windows-setup-v2.5.5.exe`.
* **Linux:** Tải file `CLI-Auto-Run-Desktop-linux-v2.5.5.zip`, giải nén và chạy file thực thi để sử dụng.

---

## 4. Giới thiệu về tác giả "mindeskvn"

Dự án được phát triển và tối ưu hóa bởi **mindeskvn** – Nhà phát triển/Đội ngũ chuyên nghiệp tận tâm hướng đến việc xây dựng các công cụ lập trình chất lượng cao, mã nguồn sạch và tối ưu hiệu suất.

Với triết lý kiến tạo những giải pháp tự động hóa giúp giảm thiểu tối đa các thao tác lặp lại vô nghĩa của lập trình viên, **mindeskvn** không ngừng nghiên cứu và cập nhật các công cụ thông minh, thân thiện và an toàn nhất cho cộng đồng công nghệ Việt Nam nói riêng và thế giới nói chung.

*   **GitHub:** [https://github.com/mindeskvn](https://github.com/mindeskvn)
*   **Repository chính:** [https://github.com/mindeskvn/AutoRun_mindesk](https://github.com/mindeskvn/AutoRun_mindesk)
*   **Liên hệ hỗ trợ:** Qua các kênh issue trên repository chính thức.
