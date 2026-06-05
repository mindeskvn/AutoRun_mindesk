const { app, BrowserWindow, ipcMain, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');

console.log('[MAIN] Main process file loaded!');

let mainWindow = null;
let tray = null;
let isQuitting = false;

// Trạng thái hoạt động Auto-Run
let isEnabled = true;
let totalClicks = 0;
let totalCommands = 0;
const connections = new Map(); // targetId -> connection info
let scanInterval = null;
let statsInterval = null;

// Cấu hình hoạt động
const CONFIG = {
    ide: 'CLI',
    isBackgroundMode: false,
    bannedCommands: [
        "rm -rf /", "rm -rf ~", "rm -rf *", "format c:",
        "del /f /s /q", "rmdir /s /q", ":(){:|:&};:",
        "dd if=", "mkfs.", "> /dev/sda", "chmod -R 777 /"
    ],
    autoActions: {
        autoRetry: true,
        autoSubmit: true
    }
};

// Script MutationObserver chạy trực tiếp trong DOM của CLI (Webview / Tab)
const AUTO_ACCEPT_SCRIPT = `
(function() {
    'use strict';
    if (typeof window === 'undefined') return;
    if (window.__autoAcceptFreeLoaded && window.__autoAcceptVersion === 'v2.21') return;
    if (window.__autoAcceptStop) { try { window.__autoAcceptStop(); } catch(e){} }
    window.__autoAcceptFreeLoaded = true;
    window.__autoAcceptVersion = 'v2.21';

    const log = (msg) => console.log('[AutoRun-Desktop] ' + msg);
    log('Script loaded inside target DOM — MutationObserver active');

    window.__autoAcceptFreeState = window.__autoAcceptFreeState || {
        isRunning: false, clicks: 0, permissions: 0, blocked: 0,
        fileEdits: 0, terminalCommands: 0, lastAction: '', lastActionLabel: '',
        lastRunShortcutAt: 0, lastRunPromptSig: '', lastRunPromptApproveAt: 0,
        lastPermissionClickAt: 0, pendingRunSig: '', pendingRunFirstSeen: 0,
        observerTriggers: 0, fallbackPolls: 0, retryClicks: [],
    };

    let pollTimer = null, observer = null, throttleTimer = null;
    let config = { ide: 'Antigravity', isBackgroundMode: false, bannedCommands: [],
        autoActions: { autoRetry: true, autoSubmit: true } };

    const getDocuments = (root) => {
        root = root || document; let docs = [root];
        try { for (const iframe of root.querySelectorAll('iframe, frame')) {
            try { const d = iframe.contentDocument || (iframe.contentWindow && iframe.contentWindow.document);
                if (d) docs.push(...getDocuments(d)); } catch(e){} } } catch(e){}
        return docs;
    };
    const getQueryRoots = (root, roots) => {
        roots = roots || []; if (!root) return roots; roots.push(root);
        try { for (const node of (root.querySelectorAll ? root.querySelectorAll('*') : [])) {
            if (node && node.shadowRoot) getQueryRoots(node.shadowRoot, roots); } } catch(e){}
        return roots;
    };
    const queryAll = (sel) => {
        const results = [], seen = new Set();
        getDocuments().forEach(doc => { getQueryRoots(doc).forEach(root => {
            try { for (const n of root.querySelectorAll(sel)) { if (!seen.has(n)) { seen.add(n); results.push(n); } } } catch(e){} }); });
        return results;
    };
    const getActionText = (el) => {
        const t = (el && el.textContent || '').trim(), ti = (el && el.title || '').trim(),
              a = (el && el.getAttribute && el.getAttribute('aria-label') || '').trim();
        return (t+' '+ti+' '+a).toLowerCase().replace(/\\s+/g,' ').trim();
    };
    const isAgentPanel = () => { try { return !!document.querySelector('#root, .react-app-container, .antigravity-agent-side-panel, [class*="agent-panel"], .interactive-session, .chat-widget, [class*="copilot"], body.theme-standalone'); } catch(e){ return true; } };
    const isBannedCommand = (text) => {
        if (!config.bannedCommands || !config.bannedCommands.length) return false;
        const l = String(text||'').toLowerCase();
        return config.bannedCommands.some(c => l.includes(c.toLowerCase()));
    };
    const isOptionSelected = (el) => {
        try {
            if (!el) return false;
            if (el.checked) return true;
            if (el.getAttribute('aria-checked') === 'true') return true;
            if (el.getAttribute('aria-selected') === 'true') return true;
            if (el.getAttribute('data-state') === 'checked' || el.getAttribute('data-state') === 'on') return true;
            if (el.getAttribute('aria-current') === 'true') return true;
            let input = el.querySelector('input[type="radio"], input[type="checkbox"]');
            if (!input && el.closest) {
                const label = el.closest('label');
                if (label) {
                    const labelFor = label.getAttribute('for');
                    if (labelFor) {
                        const doc = el.ownerDocument || document;
                        input = doc.getElementById(labelFor);
                    }
                    if (!input) {
                        input = label.querySelector('input[type="radio"], input[type="checkbox"]');
                    }
                }
            }
            if (input && input.checked) return true;
            const klass = typeof (el.className || '') === 'string' ? el.className : '';
            if (klass.includes('selected') || klass.includes('checked')) return true;
            if (klass.includes('bg-accent') || klass.includes('border-accent') || klass.includes('bg-primary')) return true;
            return false;
        } catch (e) {
            console.error('[Error in isOptionSelected]: Loi kiem tra trang thai chon option. Chi tiet:', e.message);
            return false;
        }
    };

    const clickEl = (el, reason) => {
        if (!el) return false; reason = reason||'generic';
        try {
            const now = Date.now(), last = Number(el.getAttribute && el.getAttribute('data-aar-clicked-at')||0);
            if (last > 0 && (now-last) < 300) return false;
            const r = el.getBoundingClientRect(); if (r.width===0||r.height===0) return false;
            try {
                const scrollToEl = (el) => {
                    if (el.scrollIntoView) el.scrollIntoView({block:'nearest', behavior:'instant'});
                    let parent = el.parentElement;
                    let depth = 0;
                    while (parent && depth < 10) {
                        const style = window.getComputedStyle(parent);
                        const overflow = style.overflow + style.overflowY;
                        if (/scroll|auto/.test(overflow) && parent.scrollHeight > parent.clientHeight) {
                            const eRect = el.getBoundingClientRect();
                            const pRect = parent.getBoundingClientRect();
                            const offset = eRect.top - pRect.top + parent.scrollTop - pRect.height / 2 + eRect.height / 2;
                            parent.scrollTo({top: offset, behavior: 'instant'});
                            break;
                        }
                        parent = parent.parentElement;
                        depth++;
                    }
                };
                const inView = r.top >= 0 && r.bottom <= (window.innerHeight || document.documentElement.clientHeight);
                if (!inView) scrollToEl(el);
            } catch(e) {}
            const at = getActionText(el);
            if (isBannedCommand(at)) { const s=window.__autoAcceptFreeState||{}; s.blocked=(s.blocked||0)+1; s.lastAction='blocked'; s.lastActionLabel=at.slice(0,180); window.__autoAcceptFreeState=s; log('BLOCKED: '+at.slice(0,100)); return false; }
            const mOpts = { view: window, bubbles: true, cancelable: true, buttons: 1 };
            el.dispatchEvent(new MouseEvent('mousedown', mOpts));
            el.dispatchEvent(new MouseEvent('mouseup', mOpts));
            if (typeof el.click==='function') el.click();
            el.dispatchEvent(new MouseEvent('click', mOpts));
            try{el.setAttribute('data-aar-clicked-at',String(now));}catch(e){}
            const s=window.__autoAcceptFreeState||{}; s.clicks=(s.clicks||0)+1; s.lastAction=reason; s.lastActionLabel=at.slice(0,180);
            window.__autoAcceptFreeState=s; log('CLICKED ['+reason+']: '+at.slice(0,80)); return true;
        } catch(e){ return false; }
    };

    const runCycle = (src) => {
        try {
            if (!isAgentPanel()) return;

            if (config.autoActions.autoSubmit) {
                try {
                    /* Buoc 1: Tim va click option "Yes, allow this time" neu chua duoc chon */
                    const optSelectors = 'label, [role="radio"], [role="option"], li, div, span';
                    const options = queryAll(optSelectors).filter(el => {
                        const txt = (el.textContent || '').toLowerCase();
                        return txt.includes('allow this time') || txt.includes('yes, allow this time');
                    });
                    let bestOpt = null;
                    for (const opt of options) {
                        const children = Array.from(opt.querySelectorAll ? opt.querySelectorAll(optSelectors) : []);
                        const hasChildWithText = children.some(c => {
                            const cText = (c.textContent || '').toLowerCase();
                            return cText.includes('allow this time') || cText.includes('yes, allow this time');
                        });
                        if (!hasChildWithText) { bestOpt = opt; break; }
                    }
                    let optionClicked = false;
                    if (bestOpt) {
                        const actualOpt = bestOpt.closest ? (bestOpt.closest('label') || bestOpt.closest('[role="radio"]') || bestOpt.closest('[role="option"]') || bestOpt.closest('li') || bestOpt) : bestOpt;
                        const hasClickedOptKey = 'data-aar-opt-clicked';
                        const alreadyClickedThisSession = actualOpt.getAttribute(hasClickedOptKey) === 'true';
                        
                        if (!alreadyClickedThisSession) {
                            try {
                                actualOpt.setAttribute(hasClickedOptKey, 'true');
                                const innerInput = actualOpt.querySelector('input[type="radio"], input[type="checkbox"]');
                                if (innerInput) {
                                    innerInput.click();
                                    log('FORCE CLICKED [submit-option-input]: radio/checkbox inside option to trigger React state');
                                } else {
                                    clickEl(actualOpt, 'submit-option');
                                }
                                optionClicked = true;
                            } catch (optErr) {
                                console.error('[Error in autoSubmit option click]: Loi click option. Chi tiet:', optErr.message);
                            }
                        }
                    }
                    if (optionClicked) return;

                    /* Buoc 2: Tim va click nut Submit */
                    const submitBtns = queryAll('button, [role="button"], a[role="button"]').filter(b => {
                        const raw = (b.textContent || '').trim().replace(/[\\n\\r\\u21b5\\u23ce]/g, '').trim().toLowerCase();
                        if (raw === 'submit') return true;
                        if (raw === 'yes, allow') return true;
                        const t = getActionText(b);
                        return t.includes('submit') && !t.includes('skip') && !t.includes('submit-option');
                    });
                    if (submitBtns.length > 0) {
                        if (clickEl(submitBtns[0], 'submit')) return;
                    }
                } catch(e) {
                    log('AutoSubmit error: ' + (e && e.message || String(e)));
                }
            }
            if (config.autoActions.autoRetry) {
                try {
                    const allBtns = queryAll('button, [role="button"], a[role="button"]');
                    for (const b of allBtns) {
                        const t = getActionText(b);
                        if (!t) continue;
                        if (t === 'retry' || t === 'thử lại' || t === 'retry now') {
                            if (clickEl(b, 'retry')) {
                                try {
                                    const now = Date.now();
                                    const s = window.__autoAcceptFreeState || {};
                                    s.retryClicks = s.retryClicks || [];
                                    s.retryClicks.push(now);
                                    s.retryClicks = s.retryClicks.filter(timestamp => (now - timestamp) <= 3000);
                                    window.__autoAcceptFreeState = s;
                                    if (s.retryClicks.length >= 5) {
                                        log('CRITICAL: Quá 5 lần retry trong 3 giây. Dừng hoàn toàn!');
                                        s.lastAction = 'retry-failed';
                                        s.lastActionLabel = 'Quá 5 lần retry trong 3 giây';
                                        window.__autoAcceptFreeState = s;
                                        window.__autoAcceptStop();
                                    }
                                } catch (retryTrackErr) {
                                    console.error('[Error in autoRetry tracking]: Chi tiet:', retryTrackErr.message);
                                }
                                return;
                            }
                        }
                    }
                } catch (retryErr) {
                    log('AutoRetry error: ' + (retryErr && retryErr.message || String(retryErr)));
                }
            }
        } catch(e){ log('Cycle error: '+(e&&e.message||String(e))); }
    };

    let lastRT=0; const TH=100;
    const throttledRC = () => { const now=Date.now(); if((now-lastRT)<TH){if(!throttleTimer){throttleTimer=setTimeout(()=>{throttleTimer=null;lastRT=Date.now();const s=window.__autoAcceptFreeState||{};s.observerTriggers=(s.observerTriggers||0)+1;window.__autoAcceptFreeState=s;runCycle('observer-delayed');},TH);}return;} lastRT=now;const s=window.__autoAcceptFreeState||{};s.observerTriggers=(s.observerTriggers||0)+1;window.__autoAcceptFreeState=s;runCycle('observer'); };

    window.__autoAcceptStart = (cfg) => {
        config=cfg||config;
        try {
            const s=window.__autoAcceptFreeState||{};
            s.isRunning=true;
            if (s.lastAction === 'retry-failed') {
                s.lastAction = '';
                s.lastActionLabel = '';
            }
            s.retryClicks = [];
            window.__autoAcceptFreeState=s;
        } catch (startErr) {
            console.error('[Error in window.__autoAcceptStart]: Chi tiet:', startErr.message);
        }
        if(observer){try{observer.disconnect();}catch(e){}observer=null;} if(pollTimer){clearInterval(pollTimer);pollTimer=null;} if(throttleTimer){clearTimeout(throttleTimer);throttleTimer=null;}
        try{observer=new MutationObserver(throttledRC);observer.observe(document.body||document.documentElement,{childList:true,subtree:true});log('MutationObserver started');}catch(e){log('MutationObserver failed: '+e);}
        const fi=config.isBackgroundMode?600:800;
        pollTimer=setInterval(()=>{const s=window.__autoAcceptFreeState||{};s.fallbackPolls=(s.fallbackPolls||0)+1;window.__autoAcceptFreeState=s;runCycle('fallback');},fi);
        runCycle('init'); log('Started');
    };
    window.__autoAcceptStop = () => { if(observer){try{observer.disconnect();}catch(e){}observer=null;} if(pollTimer){clearInterval(pollTimer);pollTimer=null;} if(throttleTimer){clearTimeout(throttleTimer);throttleTimer=null;} const s=window.__autoAcceptFreeState||{};s.isRunning=false;window.__autoAcceptFreeState=s;log('Stopped'); };
    window.__autoAcceptGetStats = () => (window.__autoAcceptFreeState||{});
    window.__autoAcceptIsAlive = () => !!(window.__autoAcceptFreeLoaded && window.__autoAcceptVersion === 'v2.21');
})();
`;

// Gửi Log hoạt động lên giao diện
function sendLogToUI(type, message) {
    try {
        console.log(`[UI-LOG] [${type.toUpperCase()}] ${message}`);
        if (mainWindow) {
            mainWindow.webContents.send('app-log', {
                timestamp: new Date().toLocaleTimeString(),
                type,
                message
            });
        }
    } catch (e) {
        console.error("[Error in sendLogToUI]: Lỗi gửi log lên giao diện. Chi tiết:", e.message);
    }
}

// Xác định đường dẫn file app.asar của Antigravity CLI
function getIDEPath() {
    try {
        if (process.platform === 'win32') {
            const localAppData = process.env.LOCALAPPDATA;
            if (localAppData) {
                const pathNormal = path.join(localAppData, 'Programs', 'Antigravity');
                const cliAsarPath = path.join(pathNormal, 'resources', 'app.asar');
                
                if (fs.existsSync(cliAsarPath)) {
                    // Kiem tra xem co phai ban IDE cu < 2.0 cung cài tai Programs/Antigravity khong
                    const mainJsIDE = path.join(pathNormal, 'resources', 'app', 'out', 'main.js');
                    if (fs.existsSync(mainJsIDE)) {
                        // Neu co file main.js cua IDE, kiem tra version trong package.json
                        const pkgPath = path.join(pathNormal, 'resources', 'app', 'package.json');
                        if (fs.existsSync(pkgPath)) {
                            try {
                                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                                const version = pkg.version || "";
                                // Neu version nho hon 2.0 thi day la IDE cu, khong phai CLI
                                if (version && !version.startsWith('2.')) {
                                    console.log(`[AutoRun-CLI] Phat hien Antigravity phien ban ${version} < 2.0 tai Programs/Antigravity, day la ban IDE cu (khong phai CLI).`);
                                    return null;
                                }
                            } catch (err) {
                                console.error("[Error in getIDEPath - CLI check]: Loi doc package.json. Chi tiet:", err.message);
                            }
                        }
                    } else {
                        // Neu khong co file main.js cua IDE, thu doc package.json trong app.asar
                        try {
                            const asarPkgPath = path.join(cliAsarPath, 'package.json');
                            if (fs.existsSync(asarPkgPath)) {
                                const pkg = JSON.parse(fs.readFileSync(asarPkgPath, 'utf8'));
                                const version = pkg.version || "";
                                if (version && !version.startsWith('2.')) {
                                    console.log(`[AutoRun-CLI] Phat hien version trong asar ${version} < 2.0, khong phai CLI.`);
                                    return null;
                                }
                            }
                        } catch (err) {
                            // Neu loi doc asar, ta van chap nhan vi khong co main.js cua IDE
                        }
                    }
                    return { type: 'asar', path: cliAsarPath };
                }
            }
        } else if (process.platform === 'darwin') {
            const macCli = '/Applications/Antigravity.app/Contents/Resources/app.asar';
            if (fs.existsSync(macCli)) return { type: 'asar', path: macCli };
        } else if (process.platform === 'linux') {
            const linuxCli = '/usr/share/antigravity/resources/app.asar';
            if (fs.existsSync(linuxCli)) return { type: 'asar', path: linuxCli };
        }
    } catch (e) {
        console.error("[Error in getIDEPath]: Lỗi xác định đường dẫn CLI app.asar. Chi tiết:", e.message);
    }
    return null;
}

// Tự động kiểm tra và vá file app.asar của CLI để mở cổng CDP 9000
function patchIDE() {
    try {
        const ideInfo = getIDEPath();
        if (!ideInfo) {
            sendLogToUI('warning', 'Không xác định được đường dẫn Antigravity CLI trên hệ điều hành này.');
            return false;
        }

        const marker = '/*__autoRunBuiltinRemoteDebug9000*/';
        const patchCode = `${marker}const { app } = require('electron'); if (app) { app.commandLine.appendSwitch('remote-debugging-port', '9000'); }\n`;

        if (ideInfo.type === 'asar') {
            const asarPath = ideInfo.path;
            if (!fs.existsSync(asarPath)) {
                sendLogToUI('info', `Không tìm thấy file app.asar tại: ${asarPath}`);
                return false;
            }

            const cp = require('child_process');
            const tempExtractDir = path.join(path.dirname(asarPath), 'app-extracted');

            sendLogToUI('warning', 'Đang giải nén app.asar của CLI để thiết lập cấu hình...');
            
            if (fs.existsSync(tempExtractDir)) {
                try {
                    fs.rmSync(tempExtractDir, { recursive: true, force: true });
                } catch (rmErr) {
                    console.error("[Error in patchIDE (clean temp before)]: Lỗi dọn dẹp thư mục tạm trước khi giải nén. Chi tiết:", rmErr.message);
                }
            }

            try {
                cp.execSync(`npx asar extract "${asarPath}" "${tempExtractDir}"`);
            } catch (extractErr) {
                sendLogToUI('danger', `Lỗi giải nén app.asar: ${extractErr.message}`);
                console.error("[Error in patchIDE (extract asar)]: Lỗi chạy npx asar extract. Chi tiết:", extractErr.message);
                return false;
            }

            const pkgPath = path.join(tempExtractDir, 'package.json');
            let entryFile = 'dist/main.js';
            if (fs.existsSync(pkgPath)) {
                try {
                    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                    if (pkg.main) {
                        entryFile = pkg.main;
                    }
                } catch (pkgErr) {
                    console.error("[Error in patchIDE (parse package.json)]: Chi tiết:", pkgErr.message);
                }
            }

            const mainJsPath = path.join(tempExtractDir, entryFile);
            if (!fs.existsSync(mainJsPath)) {
                sendLogToUI('danger', `Không tìm thấy file entry script ${entryFile} trong app.asar.`);
                try {
                    fs.rmSync(tempExtractDir, { recursive: true, force: true });
                } catch (e) {
                    console.error("[Error in patchIDE (cleanup entry missing)]: Chi tiết:", e.message);
                }
                return false;
            }

            let content = fs.readFileSync(mainJsPath, 'utf8');
            if (content.includes(patchCode)) {
                sendLogToUI('info', 'Cấu hình kết nối CLI đã được thiết lập trước đó.');
                try {
                    fs.rmSync(tempExtractDir, { recursive: true, force: true });
                } catch (e) {
                    console.error("[Error in patchIDE (cleanup already patched)]: Chi tiết:", e.message);
                }
                return true;
            }

            sendLogToUI('warning', 'Đang tiến hành vá file entry script của CLI...');

            if (content.includes(marker)) {
                content = content.replace(/\/\*__autoRunBuiltinRemoteDebug9000\*\/.*?\n/g, '');
            }

            const newContent = patchCode + content;
            fs.writeFileSync(mainJsPath, newContent, 'utf8');

            sendLogToUI('warning', 'Đang đóng gói lại app.asar của CLI...');
            try {
                cp.execSync(`npx asar pack "${tempExtractDir}" "${asarPath}"`);
            } catch (packErr) {
                sendLogToUI('danger', `Lỗi đóng gói lại app.asar: ${packErr.message}`);
                console.error("[Error in patchIDE (pack asar)]: Lỗi chạy npx asar pack. Chi tiết:", packErr.message);
                return false;
            }

            try {
                fs.rmSync(tempExtractDir, { recursive: true, force: true });
            } catch (cleanupErr) {
                console.error("[Error in patchIDE (cleanup temp)]: Lỗi dọn dẹp thư mục tạm. Chi tiết:", cleanupErr.message);
            }

            sendLogToUI('success', 'Cấu hình kết nối cho Antigravity CLI thành công! Vui lòng khởi động lại ứng dụng CLI.');
            return true;
        }
    } catch (e) {
        sendLogToUI('danger', `Lỗi thiết lập cấu hình CLI: ${e.message}`);
        console.error("[Error in patchIDE]: Lỗi vá CLI tại main.js của Desktop App. Chi tiết lỗi: " + e.message, e);
        return false;
    }
}

// Quét cổng debug 9000 để lấy targets
function discoverTargets() {
    return new Promise((resolve) => {
        try {
            http.get('http://127.0.0.1:9000/json/list', { timeout: 800 }, (res) => {
                if (res.statusCode !== 200) {
                    resolve([]);
                    return;
                }
                let rawData = '';
                res.on('data', (chunk) => { rawData += chunk; });
                res.on('end', () => {
                    try {
                        const targets = JSON.parse(rawData);
                        const filtered = targets.filter(t => {
                            if (!t.webSocketDebuggerUrl) return false;
                            if (t.type !== 'page' && t.type !== 'webview') return false;
                            if (t.url.toLowerCase().startsWith('devtools://')) return false;
                            if (t.url === 'about:blank') return false;
                            // Chấp nhận mọi page target trên cổng 9000 (title CLI thay đổi theo conversation)
                            return true;
                        });
                        resolve(filtered);
                    } catch (e) {
                        console.error("[Error in discoverTargets (parse)]: Lỗi parse JSON targets. Chi tiết:", e.message);
                        resolve([]);
                    }
                });
            }).on('error', (err) => {
                // Thất bại lặng lẽ khi CLI chưa mở
                console.error("[Error in discoverTargets - Connection]: Không thể kết nối tới cổng 9000. Chi tiết:", err.message);
                resolve([]);
            });
        } catch (e) {
            console.error("[Error in discoverTargets]: Lỗi khám phá targets. Chi tiết:", e.message);
            resolve([]);
        }
    });
}

// Kết nối đến Target WebSocket của CLI
function connectTarget(target) {
    try {
        const url = target.webSocketDebuggerUrl;
        const id = target.id;
        if (connections.has(id)) {
            return;
        }

        sendLogToUI('info', `Kết nối với Target: ${target.title} (${id})`);
        const ws = new WebSocket(url);
        let msgId = 1;
        const pendingEvaluates = new Map();

        const connInfo = {
            ws,
            title: target.title,
            injected: false,
            send(method, params) {
                try {
                    const cid = msgId++;
                    ws.send(JSON.stringify({ id: cid, method, params }));
                    return cid;
                } catch (e) {
                    console.error(`[Error in connInfo.send]: Lỗi gửi gói CDP. Chi tiết:`, e.message);
                    return null;
                }
            },
            evaluate(expression) {
                return new Promise((resolve) => {
                    try {
                        const cid = msgId++;
                        pendingEvaluates.set(cid, resolve);
                        ws.send(JSON.stringify({
                            id: cid,
                            method: "Runtime.evaluate",
                            params: { expression, userGesture: true, awaitPromise: true }
                        }));
                        setTimeout(() => {
                            if (pendingEvaluates.has(cid)) {
                                pendingEvaluates.delete(cid);
                                resolve(null);
                            }
                        }, 3000);
                    } catch (e) {
                        console.error(`[Error in connInfo.evaluate]: Lỗi evaluate. Chi tiết:`, e.message);
                        resolve(null);
                    }
                });
            }
        };

        connections.set(id, connInfo);

        ws.on('open', async () => {
            try {
                sendLogToUI('success', `Đã kết nối thành công tới Target: ${target.title}`);
                await injectScript(connInfo);
            } catch (e) {
                console.error(`[Error in ws.on('open')]: Lỗi sau khi mở kết nối. Chi tiết:`, e.message);
            }
        });

        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                const mid = msg.id;
                if (mid && pendingEvaluates.has(mid)) {
                    const outer = msg.result || {};
                    const inner = outer.result || outer;
                    pendingEvaluates.get(mid)(inner);
                    pendingEvaluates.delete(mid);
                }
            } catch (e) {
                console.error(`[Error in ws.on('message')]: Lỗi message. Chi tiết:`, e.message);
            }
        });

        ws.on('close', () => {
            sendLogToUI('warning', `Đã mất kết nối tới Target: ${target.title}`);
            connections.delete(id);
            pendingEvaluates.clear();
        });

        ws.on('error', (err) => {
            console.error(`[Error in ws.on('error')]: Lỗi WebSocket. Chi tiết:`, err.message);
            ws.close();
        });

    } catch (e) {
        console.error("[Error in connectTarget]: Lỗi kết nối Target. Chi tiết:", e.message);
    }
}

// Chèn Script Auto click vào target
async function injectScript(conn) {
    try {
        if (!isEnabled) return;

        const checkResult = await conn.evaluate('window.__autoAcceptVersion === "v2.21" && typeof window.__autoAcceptStart === "function"');
        const isLoaded = checkResult && checkResult.value;

        if (!isLoaded) {
            await conn.evaluate(AUTO_ACCEPT_SCRIPT);
            conn.injected = true;
            sendLogToUI('info', `Đã chèn Script click vào Target: ${conn.title}`);
        }

        const configJson = JSON.stringify(CONFIG);
        await conn.evaluate(`if(window.__autoAcceptStart) window.__autoAcceptStart(${configJson})`);

    } catch (e) {
        console.error("[Error in injectScript]: Lỗi chèn script. Chi tiết:", e.message);
    }
}

// Lấy thống kê click thời gian thực từ các Targets
async function queryStats() {
    try {
        if (!isEnabled) return;

        let clicks = 0;
        let commands = 0;

        for (const conn of connections.values()) {
            try {
                // Kiểm tra xem mã tự động click còn sống và đúng phiên bản v2.20 không (để tự động cập nhật đè bản cũ)
                const aliveResult = await conn.evaluate('typeof window.__autoAcceptIsAlive === "function" && window.__autoAcceptIsAlive() && window.__autoAcceptVersion === "v2.21"');
                const isAlive = aliveResult && aliveResult.value;

                if (!isAlive) {
                    conn.injected = false;
                    await injectScript(conn);
                } else {
                    const statsResult = await conn.evaluate('JSON.stringify(window.__autoAcceptGetStats ? window.__autoAcceptGetStats() : {})');
                    if (statsResult && statsResult.value) {
                        const stats = JSON.parse(statsResult.value);
                        clicks += (stats.clicks || 0);
                        commands += (stats.terminalCommands || 0);
                        
                        // Nếu có thông tin bị block lệnh cấm
                        if (stats.lastAction === 'blocked' && stats.lastActionLabel) {
                            sendLogToUI('danger', `NGĂN CHẶN LỆNH CẤM: ${stats.lastActionLabel}`);
                        }

                        // Nếu phát hiện script tự động dừng do lỗi lặp Retry liên tục
                        if (stats.lastAction === 'retry-failed') {
                            try {
                                isEnabled = false;
                                sendLogToUI('danger', `DỪNG HOÀN TOÀN: Phát hiện lỗi lặp lại liên tục, đã bấm Retry quá 5 lần trong 3 giây.`);
                                for (const otherConn of connections.values()) {
                                    otherConn.evaluate('if(window.__autoAcceptStop) window.__autoAcceptStop()');
                                }
                                if (mainWindow) {
                                    mainWindow.webContents.send('app-stats', {
                                        isEnabled,
                                        totalClicks: clicks,
                                        totalCommands: commands,
                                        connectedTargets: connections.size
                                    });
                                }
                            } catch (stopErr) {
                                console.error('[Error in queryStats stop handle]: Lỗi xử lý khi phát hiện retry-failed. Chi tiết:', stopErr.message);
                            }
                        } else if (!stats.isRunning && isEnabled) {
                            // Nếu script đã được chèn nhưng chưa chạy, và Auto-Run đang bật, thì kích hoạt chạy lại
                            try {
                                const configJson = JSON.stringify(CONFIG);
                                await conn.evaluate(`if(window.__autoAcceptStart) window.__autoAcceptStart(${configJson})`);
                            } catch (startErr) {
                                console.error('[Error in queryStats restart script at main.js]: Chi tiết:', startErr.message);
                            }
                        }
                    }
                }
            } catch (e) {
                console.error(`[Error in queryStats (loop)]: Lỗi lấy stats/chèn script target ${conn.title}. Chi tiết:`, e.message);
            }
        }

        totalClicks = clicks;
        totalCommands = commands;

        // Đồng bộ lên UI
        if (mainWindow) {
            mainWindow.webContents.send('app-stats', {
                isEnabled,
                totalClicks,
                totalCommands,
                connectedTargets: connections.size
            });
        }
    } catch (e) {
        console.error("[Error in queryStats]: Lỗi thống kê. Chi tiết:", e.message);
    }
}

// Vòng lặp chính duy trì Auto-Run
function startAutoRunLoop() {
    try {
        if (scanInterval) clearInterval(scanInterval);
        if (statsInterval) clearInterval(statsInterval);

        scanInterval = setInterval(() => {
            try {
                if (!isEnabled) return;
                discoverTargets().then(targets => {
                    targets.forEach(connectTarget);
                });
            } catch (err) {
                console.error("[Error in scanInterval]: Lỗi quét target. Chi tiết:", err.message);
            }
        }, 1500);

        statsInterval = setInterval(() => {
            try {
                queryStats();
            } catch (err) {
                console.error("[Error in statsInterval]: Lỗi truy vấn stats. Chi tiết:", err.message);
            }
        }, 2000);

        sendLogToUI('success', 'Bắt đầu vòng lặp Auto-Run Client.');
    } catch (e) {
        console.error("[Error in startAutoRunLoop]: Lỗi khởi chạy vòng lặp. Chi tiết:", e.message);
    }
}

// Khởi tạo giao diện Desktop Window
function createMainWindow() {
    try {
        mainWindow = new BrowserWindow({
            width: 1000,
            height: 700,
            minWidth: 800,
            minHeight: 600,
            show: false,
            icon: path.join(__dirname, 'renderer', 'logo.jpeg'),
            webPreferences: {
                preload: path.join(__dirname, 'preload.js'),
                contextIsolation: true,
                nodeIntegration: false
            }
        });

        mainWindow.removeMenu();
        mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

        mainWindow.once('ready-to-show', () => {
            mainWindow.show();
        });

        mainWindow.on('close', (event) => {
            if (!isQuitting) {
                event.preventDefault();
                mainWindow.hide();
                sendLogToUI('info', 'Ứng dụng đã được thu nhỏ xuống khay hệ thống.');
            }
        });

        mainWindow.on('closed', () => {
            mainWindow = null;
        });

    } catch (e) {
        console.error("[Error in createMainWindow]: Lỗi khởi tạo BrowserWindow. Chi tiết:", e.message);
    }
}

// Tạo Khay Hệ Thống (System Tray Icon)
function createTray() {
    try {
        const { nativeImage } = require('electron');
        const iconPath = path.join(__dirname, 'tray_icon.png');
        let trayIcon;
        
        if (fs.existsSync(iconPath) && fs.statSync(iconPath).size > 500) {
            try {
                trayIcon = nativeImage.createFromPath(iconPath);
            } catch (err) {
                console.error("[Error in createTray - nativeImage]: Không thể tải tray_icon.png. Chi tiết:", err.message);
                trayIcon = nativeImage.createEmpty();
            }
        } else {
            const logoPath = path.join(__dirname, 'logo.png');
            if (fs.existsSync(logoPath)) {
                try {
                    trayIcon = nativeImage.createFromPath(logoPath).resize({ width: 16, height: 16 });
                } catch (logoErr) {
                    console.error("[Error in createTray - logo fallback]: Không thể tải logo.png. Chi tiết:", logoErr.message);
                    trayIcon = nativeImage.createEmpty();
                }
            } else {
                trayIcon = nativeImage.createEmpty();
            }
        }

        tray = new Tray(trayIcon);
        tray.setToolTip('Antigravity CLI Auto-Run Controller');

        const contextMenu = Menu.buildFromTemplate([
            {
                label: 'Hiển thị giao diện',
                click: () => {
                    if (mainWindow) {
                        mainWindow.show();
                    }
                }
            },
            {
                label: 'Bật / Tắt Auto-Run',
                type: 'checkbox',
                checked: isEnabled,
                click: (item) => {
                    isEnabled = item.checked;
                    sendLogToUI(isEnabled ? 'success' : 'warning', `Trạng thái Auto-Run chuyển sang: ${isEnabled ? 'BẬT' : 'TẮT'}`);
                }
            },
            { type: 'separator' },
            {
                label: 'Thoát hoàn toàn',
                click: () => {
                    isQuitting = true;
                    app.quit();
                }
            }
        ]);

        tray.setContextMenu(contextMenu);

        tray.on('double-click', () => {
            if (mainWindow) {
                mainWindow.show();
            }
        });
    } catch (e) {
        console.error("[Error in createTray]: Lỗi khởi tạo khay hệ thống. Chi tiết:", e.message);
    }
}

// Đăng ký các sự kiện vòng đời ứng dụng
app.whenReady().then(() => {
    try {
        console.log('[MAIN] app.whenReady triggered');
        createMainWindow();
        createTray();

        // Kích hoạt vá CLI và bắt đầu vòng lặp khi ứng dụng sẵn sàng
        setTimeout(() => {
            try {
                console.log('[MAIN] Starting patchIDE and startAutoRunLoop...');
                patchIDE();
                startAutoRunLoop();
            } catch (err) {
                console.error("[Error in app.whenReady - AutoRun]: Lỗi khi vá IDE hoặc chạy vòng lặp Auto-Run. Chi tiết:", err.message);
            }
        }, 1000);

        // Tự động kiểm tra bản cập nhật Desktop App từ GitHub khi khởi động
        setTimeout(() => {
            try {
                checkDesktopUpdate();
            } catch (updateErr) {
                console.error("[Error in app.whenReady - Update Check]: Lỗi gọi kiểm tra cập nhật. Chi tiết:", updateErr.message, updateErr.stack);
            }
        }, 3000); // Đợi 3 giây sau khi khởi động để giao diện sẵn sàng

        app.on('activate', () => {
            if (BrowserWindow.getAllWindows().length === 0) {
                createMainWindow();
            }
        });
    } catch (e) {
        console.error("[Error in app.whenReady]: Lỗi khởi chạy ứng dụng. Chi tiết:", e.message);
    }
});

app.on('window-all-closed', () => {
    try {
        if (process.platform !== 'darwin') {
            app.quit();
        }
    } catch (e) {
        console.error("[Error in app.on('window-all-closed')]: Chi tiết:", e.message);
    }
});

// Xử lý sự kiện IPC từ Renderer (giao diện) gửi xuống
ipcMain.on('toggle-autorun', (event, active) => {
    try {
        isEnabled = active;
        sendLogToUI(isEnabled ? 'success' : 'warning', `Auto-Run đã được ${isEnabled ? 'BẬT' : 'TẮT'} từ bảng điều khiển.`);
        
        // Cập nhật lại khay hệ thống
        if (tray) {
            const contextMenu = Menu.buildFromTemplate([
                {
                    label: 'Hiển thị giao diện',
                    click: () => { mainWindow.show(); }
                },
                {
                    label: 'Bật / Tắt Auto-Run',
                    type: 'checkbox',
                    checked: isEnabled,
                    click: (item) => {
                        isEnabled = item.checked;
                        sendLogToUI(isEnabled ? 'success' : 'warning', `Trạng thái Auto-Run chuyển sang: ${isEnabled ? 'BẬT' : 'TẮT'}`);
                    }
                },
                { type: 'separator' },
                {
                    label: 'Thoát hoàn toàn',
                    click: () => {
                        isQuitting = true;
                        app.quit();
                    }
                }
            ]);
            tray.setContextMenu(contextMenu);
        }

        // Nếu tắt, gửi stop tới các targets
        if (!isEnabled) {
            for (const conn of connections.values()) {
                conn.evaluate('if(window.__autoAcceptStop) window.__autoAcceptStop()');
            }
        } else {
            discoverTargets().then(targets => {
                try {
                    targets.forEach(connectTarget);
                } catch (loopErr) {
                    console.error("[Error in ipcMain.toggle-autorun loops]: Chi tiết:", loopErr.message);
                }
            }).catch(err => {
                console.error("[Error in ipcMain.toggle-autorun discoverTargets]: Chi tiết:", err.message);
            });
        }
    } catch (e) {
        console.error("[Error in ipcMain.toggle-autorun]: Chi tiết:", e.message);
    }
});

ipcMain.on('update-config', (event, newConfig) => {
    try {
        if (newConfig) {
            Object.assign(CONFIG, newConfig);
            // Gửi cấu hình mới tới tất cả các kết nối đang hoạt động
            const configJson = JSON.stringify(CONFIG);
            for (const conn of connections.values()) {
                conn.evaluate(`if(window.__autoAcceptStart) window.__autoAcceptStart(${configJson})`);
            }
            sendLogToUI('success', 'Đã lưu và đồng bộ cấu hình mới xuống toàn bộ Targets.');
        }
    } catch (e) {
        console.error("[Error in ipcMain.update-config]: Chi tiết:", e.message);
    }
});

ipcMain.on('request-patch', (event) => {
    try {
        const success = patchIDE();
        if (success) {
            event.reply('patch-response', true);
        }
    } catch (e) {
        console.error("[Error in ipcMain.request-patch]: Chi tiết:", e.message);
    }
});

// Tự động kiểm tra cập nhật phiên bản mới của Desktop App từ GitHub
function checkDesktopUpdate() {
    try {
        const https = require('https');
        const { dialog } = require('electron');
        const pkg = require('./package.json');
        
        const repo = 'mindeskvn/AutoRun_mindesk';
        const options = {
            hostname: 'api.github.com',
            path: `/repos/${repo}/releases/latest`,
            headers: {
                'User-Agent': 'Antigravity-AutoRun-Desktop-Updater'
            }
        };

        https.get(options, (res) => {
            let data = '';
            res.on('data', (chunk) => {
                data += chunk;
            });
            res.on('end', () => {
                try {
                    if (res.statusCode !== 200) {
                        console.error(`[Error in checkDesktopUpdate - API]: GitHub API trả về status code ${res.statusCode}`);
                        return;
                    }
                    const release = JSON.parse(data);
                    const latestVersion = release.tag_name ? release.tag_name.replace(/^v/, '') : '';
                    if (!latestVersion) return;

                    const currentVersion = pkg.version;
                    
                    const isNewer = (current, latest) => {
                        const cParts = current.split('.').map(Number);
                        const lParts = latest.split('.').map(Number);
                        for (let i = 0; i < 3; i++) {
                            if (lParts[i] > cParts[i]) return true;
                            if (lParts[i] < cParts[i]) return false;
                        }
                        return false;
                    };

                    if (isNewer(currentVersion, latestVersion)) {
                        const setupAsset = release.assets.find(asset => asset.name.includes('setup') && asset.name.endsWith('.exe'));
                        if (!setupAsset) {
                            console.log(`[Auto-Run Desktop Update] Phát hiện phiên bản mới v${latestVersion} nhưng không tìm thấy file setup .exe trong release assets.`);
                            return;
                        }
                        
                        const downloadUrl = setupAsset.browser_download_url;
                        
                        if (mainWindow) {
                            dialog.showMessageBox(mainWindow, {
                                type: 'question',
                                buttons: ['Cập nhật ngay', 'Bỏ qua'],
                                defaultId: 0,
                                title: 'Cập nhật phiên bản mới',
                                message: `Đã tìm thấy bản cập nhật mới v${latestVersion} cho Antigravity CLI Auto-Run Desktop App. Bạn có muốn tải về và cài đặt tự động không?`
                            }).then(result => {
                                if (result.response === 0) {
                                    downloadAndInstallDesktop(downloadUrl, latestVersion);
                                }
                            }).catch(err => {
                                console.error('[Error in checkDesktopUpdate - Dialog]: Lỗi hiển thị dialog. Chi tiết:', err.message);
                            });
                        }
                    }
                } catch (err) {
                    console.error("[Error in checkDesktopUpdate - Parse]: Lỗi xử lý JSON từ API. Chi tiết:", err.message, err.stack);
                }
            });
        }).on('error', (err) => {
            console.error("[Error in checkDesktopUpdate - Network]: Lỗi kết nối GitHub API. Chi tiết:", err.message, err.stack);
        });
    } catch (e) {
        console.error("[Error in checkDesktopUpdate]: Lỗi kiểm tra cập nhật. Chi tiết:", e.message, e.stack);
    }
}

// Tải xuống file setup .exe và chạy cài đặt đè
function downloadAndInstallDesktop(downloadUrl, version) {
    try {
        const https = require('https');
        const fs = require('fs');
        const path = require('path');
        const os = require('os');
        const cp = require('child_process');
        const url = require('url');

        sendLogToUI('info', `Bắt đầu tải bản cập nhật Desktop App v${version}...`);

        const tempExePath = path.join(os.tmpdir(), `Auto-Run-Desktop-setup-${version}.exe`);
        const fileStream = fs.createWriteStream(tempExePath);

        const download = (fileUrl) => {
            const parsedUrl = url.parse(fileUrl);
            const options = {
                hostname: parsedUrl.hostname,
                path: parsedUrl.path,
                headers: {
                    'User-Agent': 'Antigravity-AutoRun-Desktop-Updater'
                }
            };

            https.get(options, (response) => {
                if (response.statusCode === 301 || response.statusCode === 302) {
                    download(response.headers.location);
                    return;
                }

                if (response.statusCode !== 200) {
                    fileStream.close();
                    sendLogToUI('danger', `Tải cập nhật thất bại: Status code ${response.statusCode}`);
                    return;
                }

                response.pipe(fileStream);

                fileStream.on('finish', () => {
                    fileStream.close();
                    sendLogToUI('success', 'Tải bản cập nhật thành công! Đang tiến hành cài đặt đè...');
                    
                    setTimeout(() => {
                        try {
                            const installer = cp.spawn(tempExePath, [], {
                                detached: true,
                                stdio: 'ignore'
                            });
                            installer.unref();
                            app.quit();
                        } catch (spawnErr) {
                            console.error('[Error in downloadAndInstallDesktop - Spawn]: Lỗi khởi chạy file cài đặt. Chi tiết:', spawnErr.message, spawnErr.stack);
                            sendLogToUI('danger', `Lỗi chạy file cài đặt: ${spawnErr.message}`);
                        }
                    }, 1000);
                });
            }).on('error', (err) => {
                fileStream.close();
                sendLogToUI('danger', `Lỗi tải file cập nhật: ${err.message}`);
                console.error('[Error in downloadAndInstallDesktop - Network]: Chi tiết:', err.message, err.stack);
            });
        };

        download(downloadUrl);

    } catch (e) {
        sendLogToUI('danger', `Lỗi chuẩn bị tải cập nhật: ${e.message}`);
        console.error('[Error in downloadAndInstallDesktop]: Chi tiết:', e.message, e.stack);
    }
}
