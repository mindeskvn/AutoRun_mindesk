const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
    // Gửi yêu cầu bật/tắt Auto-Run
    toggleAutoRun: (active) => {
        try {
            ipcRenderer.send('toggle-autorun', active);
        } catch (e) {
            console.error("[Error in preload.toggleAutoRun]:", e.message);
        }
    },
    
    // Gửi cấu hình mới xuống Main
    updateConfig: (config) => {
        try {
            ipcRenderer.send('update-config', config);
        } catch (e) {
            console.error("[Error in preload.updateConfig]:", e.message);
        }
    },
    
    // Yêu cầu vá CLI thủ công
    requestPatch: () => {
        try {
            ipcRenderer.send('request-patch');
        } catch (e) {
            console.error("[Error in preload.requestPatch]:", e.message);
        }
    },
    
    // Lắng nghe thống kê định kỳ từ Main
    onStats: (callback) => {
        try {
            ipcRenderer.on('app-stats', (event, stats) => {
                try {
                    callback(stats);
                } catch (cbErr) {
                    console.error("[Error in onStats callback]:", cbErr.message);
                }
            });
        } catch (e) {
            console.error("[Error in preload.onStats]:", e.message);
        }
    },
    
    // Lắng nghe log hoạt động từ Main
    onLog: (callback) => {
        try {
            ipcRenderer.on('app-log', (event, log) => {
                try {
                    callback(log);
                } catch (cbErr) {
                    console.error("[Error in onLog callback]:", cbErr.message);
                }
            });
        } catch (e) {
            console.error("[Error in preload.onLog]:", e.message);
        }
    }
});
