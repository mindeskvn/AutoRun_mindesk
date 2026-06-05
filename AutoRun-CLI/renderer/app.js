// Quản lý trạng thái và tương tác giao diện (Vanilla JS)
document.addEventListener('DOMContentLoaded', () => {
    try {
        console.log("Antigravity Auto-Run UI loaded successfully.");

        // Các biến giao diện chính
        const navDashboard = document.getElementById('nav-dashboard');
        const navConfig = document.getElementById('nav-config');
        const navLogs = document.getElementById('nav-logs');

        const sectionDashboard = document.getElementById('section-dashboard');
        const sectionConfig = document.getElementById('section-config');
        const sectionLogs = document.getElementById('section-logs');

        const sectionTitle = document.getElementById('current-section-title');
        const sectionDesc = document.getElementById('current-section-desc');

        const autorunToggle = document.getElementById('autorun-toggle');
        const statClicks = document.getElementById('stat-clicks');
        const statCommands = document.getElementById('stat-commands');
        const statTargets = document.getElementById('stat-targets');

        const btnPatchIde = document.getElementById('btn-patch-ide');
        const btnSaveConfig = document.getElementById('btn-save-config');
        const btnClearLogs = document.getElementById('btn-clear-logs');
        const consoleLogs = document.getElementById('console-logs');

        // Checkboxes Cấu hình
        const cfgAutoRetry = document.getElementById('cfg-auto-retry');
        const cfgAutoSubmit = document.getElementById('cfg-auto-submit');
        const cfgBannedCommands = document.getElementById('cfg-banned-commands');

        // Thông tin chung
        const infoOs = document.getElementById('info-os');
        const infoPatched = document.getElementById('info-patched');

        // Cập nhật thông tin hệ điều hành hiển thị
        try {
            const platform = navigator.platform.toLowerCase();
            if (platform.includes('win')) {
                infoOs.textContent = 'Windows';
            } else if (platform.includes('mac')) {
                infoOs.textContent = 'macOS';
            } else if (platform.includes('linux')) {
                infoOs.textContent = 'Linux';
            } else {
                infoOs.textContent = navigator.platform;
            }
        } catch (osErr) {
            console.error("[Error in os_detection]: Khong the nhan dien OS. Chi tiet:", osErr.message);
        }

        // Cấu hình danh sách lệnh cấm mặc định
        const defaultBanned = [
            "rm -rf /", "rm -rf ~", "rm -rf *", "format c:",
            "del /f /s /q", "rmdir /s /q", ":(){:|:&};:",
            "dd if=", "mkfs.", "> /dev/sda", "chmod -R 777 /"
        ];
        cfgBannedCommands.value = defaultBanned.join('\n');

        // --- 1. XỬ LÝ CHUYỂN TAB NAVIGATION ---
        const switchTab = (tabName) => {
            try {
                // Remove active class
                [navDashboard, navConfig, navLogs].forEach(item => item.classList.remove('active'));
                [sectionDashboard, sectionConfig, sectionLogs].forEach(sec => sec.classList.remove('active'));

                if (tabName === 'dashboard') {
                    navDashboard.classList.add('active');
                    sectionDashboard.classList.add('active');
                    sectionTitle.textContent = 'Bảng điều khiển';
                    sectionDesc.textContent = 'Theo dõi thống kê click và kết nối thời gian thực.';
                } else if (tabName === 'config') {
                    navConfig.classList.add('active');
                    sectionConfig.classList.add('active');
                    sectionTitle.textContent = 'Cấu hình hoạt động';
                    sectionDesc.textContent = 'Tinh chỉnh các chế độ tự động click và danh sách lệnh cấm.';
                } else if (tabName === 'logs') {
                    navLogs.classList.add('active');
                    sectionLogs.classList.add('active');
                    sectionTitle.textContent = 'Console Log trực tiếp';
                    sectionDesc.textContent = 'Lịch sử tự động click và ghi nhận hoạt động từ CLI.';
                    
                    // Tự động cuộn xuống dưới cùng khi mở log
                    setTimeout(() => {
                        consoleLogs.scrollTop = consoleLogs.scrollHeight;
                    }, 50);
                }
            } catch (tabErr) {
                console.error("[Error in switchTab]: Loi khi chuyen tab. Chi tiet:", tabErr.message);
            }
        };

        navDashboard.addEventListener('click', (e) => { e.preventDefault(); switchTab('dashboard'); });
        navConfig.addEventListener('click', (e) => { e.preventDefault(); switchTab('config'); });
        navLogs.addEventListener('click', (e) => { e.preventDefault(); switchTab('logs'); });

        // --- 2. GIAO TIẾP VỚI MAIN PROCESS BẰNG IPC ---

        // Bật/tắt Auto-Run từ toggle button
        autorunToggle.addEventListener('change', (e) => {
            try {
                if (e && !e.isTrusted) {
                    console.log("[UI-LOG] Bỏ qua sự kiện change không phải do người dùng click (isTrusted = false)");
                    return;
                }
                const active = autorunToggle.checked;
                window.api.toggleAutoRun(active);
            } catch (toggleErr) {
                console.error("[Error in toggle_handler at renderer/app.js]: Lỗi gửi yêu cầu bật/tắt Auto-Run. Chi tiết: " + toggleErr.message, toggleErr);
            }
        });

        // Click vá cấu hình CLI
        btnPatchIde.addEventListener('click', () => {
            try {
                window.api.requestPatch();
            } catch (patchErr) {
                console.error("[Error in patch_btn_handler]: Loi gui yeu cau va CLI. Chi tiet:", patchErr.message);
            }
        });

        // Click Lưu cấu hình hoạt động
        btnSaveConfig.addEventListener('click', () => {
            try {
                const bannedList = cfgBannedCommands.value
                    .split('\n')
                    .map(cmd => cmd.trim())
                    .filter(cmd => cmd.length > 0);

                const configData = {
                    autoActions: {
                        autoRetry: cfgAutoRetry.checked,
                        autoSubmit: cfgAutoSubmit.checked
                    },
                    bannedCommands: bannedList
                };

                window.api.updateConfig(configData);
            } catch (saveErr) {
                console.error("[Error in save_config_handler at renderer/app.js]: Lỗi gửi cấu hình mới. Chi tiết: " + saveErr.message, saveErr);
            }
        });

        // Click Xóa logs màn hình
        btnClearLogs.addEventListener('click', () => {
            try {
                consoleLogs.innerHTML = `
                    <div class="log-line system">
                        <span class="time">[${new Date().toLocaleTimeString()}]</span>
                        <span class="tag tag-system">[HỆ THỐNG]</span>
                        <span class="msg">Đã xóa sạch console logs.</span>
                    </div>
                `;
            } catch (clearErr) {
                console.error("[Error in clear_logs_handler]: Loi xoa log. Chi tiet:", clearErr.message);
            }
        });

        // --- 3. LẮNG NGHE SỰ KIỆN TỪ MAIN PROCESS ---

        // Nhận dữ liệu thống kê
        window.api.onStats((stats) => {
            try {
                if (stats) {
                    autorunToggle.checked = stats.isEnabled;
                    statClicks.textContent = stats.totalClicks;
                    statCommands.textContent = stats.totalCommands;
                    statTargets.textContent = `${stats.connectedTargets} Targets`;
                }
            } catch (statsErr) {
                console.error("[Error in stats_listener]: Loi cap nhat thong ke. Chi tiet:", statsErr.message);
            }
        });

        // Nhận dòng log trực tiếp
        window.api.onLog((logData) => {
            try {
                if (logData) {
                    const logLine = document.createElement('div');
                    logLine.className = `log-line ${logData.type}`;
                    
                    const timeSpan = document.createElement('span');
                    timeSpan.className = 'time';
                    timeSpan.textContent = `[${logData.timestamp}]`;
                    
                    const tagSpan = document.createElement('span');
                    tagSpan.className = `tag tag-${logData.type}`;
                    
                    let tagText = '[INFO]';
                    if (logData.type === 'system') tagText = '[HỆ THỐNG]';
                    else if (logData.type === 'success') tagText = '[THÀNH CÔNG]';
                    else if (logData.type === 'warning') tagText = '[CẢNH BÁO]';
                    else if (logData.type === 'danger') tagText = '[CHẶN CẤM]';
                    
                    tagSpan.textContent = tagText;
                    
                    const msgSpan = document.createElement('span');
                    msgSpan.className = 'msg';
                    msgSpan.textContent = logData.message;
                    
                    logLine.appendChild(timeSpan);
                    logLine.appendChild(tagSpan);
                    logLine.appendChild(msgSpan);
                    
                    consoleLogs.appendChild(logLine);
                    
                    // Nếu số lượng log dòng quá 200, xóa các dòng cũ để giữ bộ nhớ sạch sẽ
                    if (consoleLogs.childElementCount > 200) {
                        consoleLogs.removeChild(consoleLogs.firstChild);
                    }
                    
                    // Tự động cuộn xuống dưới nếu log đang mở
                    if (sectionLogs.classList.contains('active')) {
                        consoleLogs.scrollTop = consoleLogs.scrollHeight;
                    }
                }
            } catch (logErr) {
                console.error("[Error in log_listener]: Loi ghi nhan dong log moi. Chi tiet:", logErr.message);
            }
        });

    } catch (e) {
        console.error("[Error in app_init]: Loi khoi tao toan cuc. Chi tiet:", e.message);
    }
});
