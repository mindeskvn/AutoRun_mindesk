const { app, BrowserWindow, ipcMain, Tray, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const http = require('http');
const WebSocket = require('ws');

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
    ide: 'Antigravity',
    isBackgroundMode: false,
    bannedCommands: [
        "rm -rf /", "rm -rf ~", "rm -rf *", "format c:",
        "del /f /s /q", "rmdir /s /q", ":(){:|:&};:",
        "dd if=", "mkfs.", "> /dev/sda", "chmod -R 777 /"
    ],
    autoActions: {
        autoRun: true,
        autoAccept: true,
        autoAllow: true,
        autoContinue: true,
        autoAltEnter: true,
        autoRetry: true,
        autoSubmit: true
    }
};

// Script MutationObserver chạy trực tiếp trong DOM của IDE (Webview / Tab)
const AUTO_ACCEPT_SCRIPT = `
(function() {
    'use strict';
    if (typeof window === 'undefined') return;
    if (window.__autoAcceptFreeLoaded && window.__autoAcceptVersion === 'v2.8') return;
    if (window.__autoAcceptStop) { try { window.__autoAcceptStop(); } catch(e){} }
    window.__autoAcceptFreeLoaded = true;
    window.__autoAcceptVersion = 'v2.8';

    const log = (msg) => console.log('[AutoRun-Desktop] ' + msg);
    log('Script loaded inside target DOM — MutationObserver active');

    window.__autoAcceptFreeState = window.__autoAcceptFreeState || {
        isRunning: false, clicks: 0, permissions: 0, blocked: 0,
        fileEdits: 0, terminalCommands: 0, lastAction: '', lastActionLabel: '',
        lastRunShortcutAt: 0, lastRunPromptSig: '', lastRunPromptApproveAt: 0,
        lastPermissionClickAt: 0, pendingRunSig: '', pendingRunFirstSeen: 0,
        observerTriggers: 0, fallbackPolls: 0,
    };

    let pollTimer = null, observer = null, throttleTimer = null;
    let config = { ide: 'Antigravity', isBackgroundMode: false, bannedCommands: [],
        autoActions: { autoRun: true, autoAccept: true, autoAllow: true, autoContinue: true, autoAltEnter: true, autoRetry: true, autoSubmit: true } };

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
    const isRunActionText = (t) => {
        t = String(t||'').toLowerCase().replace(/\\s+/g,' ').trim(); if (!t) return false;
        if (/\\balways\\s+run\\b/i.test(t)||/\\brun\\s+in\\s+terminal\\b/i.test(t)||/\\brunning\\b/i.test(t)) return false;
        return /^\\s*run/i.test(t)||/\\brun\\b/i.test(t)||/runalt\\+/i.test(t);
    };
    const isAgentPanel = () => { try { return !!document.querySelector('.react-app-container, .antigravity-agent-side-panel, [class*=\"agent-panel\"], .interactive-session, .chat-widget, [class*=\"copilot\"]'); } catch(e){ return true; } };
    const isExcludedControl = (el, at) => {
        if (!el) return true; const t = at || getActionText(el);
        if (['auto accept','auto run','background','toggle on/off','setup cdp'].some(k=>t.includes(k))) return true;
        if (el.closest && el.closest('#workbench\\\\.parts\\\\.statusbar, .statusbar, .part.statusbar')) return true;
        const iW = el.closest && el.closest('.titlebar, .menubar, .activitybar, .sidebar, .composite.title, .tabs-container, .editor-actions, .action-bar');
        const iP = el.closest && el.closest('[role=\"dialog\"], .notification-toast, .notification-list-item, .monaco-dialog-box, .interactive-session, .chat-tool-call, .chat-tool-response, [class*=\"tool-call\"], .antigravity-agent-side-panel, [class*=\"agent-side\"]');
        return !!(iW && !iP);
    };
    const isBannedCommand = (text) => {
        if (!config.bannedCommands || !config.bannedCommands.length) return false;
        const l = String(text||'').toLowerCase();
        return config.bannedCommands.some(c => l.includes(c.toLowerCase()));
    };
    const PERM_MARKERS = ['opening url in browser','needs permission to act on','needs permission to execute','needs permission to','permission to act on','requires permission','grant permission','requesting permission','allow this','requires your approval','approval required','permission to access file','access this file','allow for this conversation','needs permission','agent needs permission'];
    const isPermBlock = (t) => /\\ballowlist\\b|\\bdeny\\b|\\breject\\b|\\bcancel\\b|\\bconfigure\\b|\\bsettings?\\b/i.test(t);
    const isPermAllow = (t) => { if (!t || isPermBlock(t)) return false; return /\\ballow|\\bapprove\\b|\\bgrant\\b|^always\\b/i.test(t); };
    const SEL = 'button, [role=\"button\"], a[role=\"button\"]';

    const clickEl = (el, reason) => {
        if (!el) return false; reason = reason||'generic';
        try {
            if (!['run-prompt', 'permission', 'retry', 'submit', 'submit-option'].includes(reason) && isExcludedControl(el)) return false;
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
            if (typeof el.click==='function') el.click();
            el.dispatchEvent(new MouseEvent('click',{view:window,bubbles:true,cancelable:true}));
            try{el.setAttribute('data-aar-clicked-at',String(now));}catch(e){}
            const s=window.__autoAcceptFreeState||{}; s.clicks=(s.clicks||0)+1; s.lastAction=reason; s.lastActionLabel=at.slice(0,180);
            if (reason==='permission') { s.permissions=(s.permissions||0)+1; s.lastPermissionClickAt=now; }
            if (reason==='run-prompt') s.terminalCommands=(s.terminalCommands||0)+1;
            window.__autoAcceptFreeState=s; log('CLICKED ['+reason+']: '+at.slice(0,80)); return true;
        } catch(e){ return false; }
    };

    const runCycle = (src) => {
        try {
            if (!isAgentPanel()) return;
            const containers = queryAll('[role=\"dialog\"], .notification-toast, .notification-list-item, .monaco-dialog-box, .monaco-dialog-modal-block, .chat-tool-call, .chat-tool-response, [class*=\"tool-call\"], [data-testid*=\"tool-call\"], .antigravity-agent-side-panel, [class*=\"tool-confirm\"], [class*=\"run-confirm\"], .interactive-input-widget, .chat-run-confirmation, [class*=\"confirmation\"], [class*=\"ask-first\"], [class*=\"permission\"], [class*=\"interactive-input\"], .chat-widget-item, [class*=\"chat-confirmation\"]');
            const btns = [], seen = new Set();
            for (const c of containers) { try { for (const b of c.querySelectorAll(SEL)) { if (!seen.has(b)){seen.add(b);btns.push(b);} } } catch(e){} }

            if (config.autoActions.autoAltEnter) {
                const hsi=(()=>{for(const d of getDocuments()){try{const bt=((d.body&&d.body.textContent)||'').toLowerCase();if(bt.includes('step requires input')||bt.includes('ask every time')||bt.includes('reject | run')||bt.includes('runalt+')||bt.includes('run alt+enter')||bt.includes('allow alt+enter')||bt.includes('needs permission'))return true;}catch(e){}}return false;})();
                const now=Date.now(),st=window.__autoAcceptFreeState||{};
                if(hsi&&!(st.lastRunPromptApproveAt&&(now-st.lastRunPromptApproveAt)<1500)&&(now-(st.lastRunShortcutAt||0))>1500){
                    const a=document.activeElement,tg=a&&(a.tagName||'').toLowerCase();
                    if(!(tg==='textarea'||(tg==='input'&&!['button','submit','checkbox','radio'].includes((a.type||'').toLowerCase()))||(a&&a.isContentEditable))){
                        for(const target of [document.activeElement,document.body,document.documentElement].filter(Boolean)){
                            const o={key:'Enter',code:'Enter',keyCode:13,which:13,bubbles:true,cancelable:true,altKey:true};
                            target.dispatchEvent(new KeyboardEvent('keydown',o));target.dispatchEvent(new KeyboardEvent('keypress',o));target.dispatchEvent(new KeyboardEvent('keyup',o));
                        }
                        st.lastRunShortcutAt=now;st.terminalCommands=(st.terminalCommands||0)+1;window.__autoAcceptFreeState=st;log('Alt+Enter sent');
                    }
                }
            }
            if (!btns.length) return;

            if (config.autoActions.autoAllow) {
                const permSources = [...containers];
                const bodyTxt = (document.body&&document.body.textContent||'').toLowerCase();
                const pageHasPerm = PERM_MARKERS.some(m=>bodyTxt.includes(m));
                if (pageHasPerm) permSources.push(document.body);
                for (const c of permSources) {
                    const ct=getActionText(c), bs=Array.from(c.querySelectorAll ? c.querySelectorAll(SEL) : []);
                    const hasM=PERM_MARKERS.some(m=>ct.includes(m)||bodyTxt.includes(m)), hasP=/\\bpermission\\b|\\baccess\\b|\\bapproval\\b/i.test(ct);
                    const hasA=bs.some(b=>isPermAllow(getActionText(b))), hasB=bs.some(b=>/\\bdeny\\b|\\breject\\b|\\bcancel\\b/i.test(getActionText(b)));
                    if (hasM||(hasP&&hasA&&hasB)) {
                        const ac=bs.find(b=>/\\ballow(\\s+for)?\\s+this\\s+conversation\\b/i.test(getActionText(b)));
                        if (ac&&clickEl(ac,'permission')) return;
                        const ao=bs.find(b=>/\\ballow\\s+once\\b/i.test(getActionText(b)));
                        if (ao&&clickEl(ao,'permission')) return;
                        const aa=bs.find(b=>{const t=getActionText(b);return !isPermBlock(t)&&/\\balways\\s+allow\\b/i.test(t);});
                        if (aa&&clickEl(aa,'permission')) return;
                        const ad=bs.find(b=>/^allow/i.test((b.textContent||'').trim()));
                        if (ad&&clickEl(ad,'permission')) return;
                        const ax=bs.find(b=>isPermAllow(getActionText(b)));
                        if (ax&&clickEl(ax,'permission')) return;
                    }
                }
            }
            if (config.autoActions.autoContinue) { for (const b of btns) { const t=getActionText(b); if (t.includes('continue generating')||/^continue(\\b|\\s)/i.test(t)) { if (clickEl(b,'recovery')) return; } } }
            if (config.autoActions.autoRun) {
                const st=window.__autoAcceptFreeState||{}, now=Date.now(), CD=1500, DL=200;
                if (!(st.lastRunPromptApproveAt&&(now-st.lastRunPromptApproveAt)<CD)) {
                    const cands=[];
                    for (const b of btns) {
                        const t=getActionText(b); if (!isRunActionText(t)) continue;
                        let co = b.closest && b.closest('[role=\"dialog\"], .notification-toast, .notification-list-item, .monaco-dialog-box, .chat-tool-call, .chat-tool-response, [class*=\"tool-call\"]');
                        if (!co) {
                            let n=b.parentElement, d=0;
                            while(n && d<15) {
                                const nb=Array.from(n.querySelectorAll ? n.querySelectorAll(SEL) : []);
                                if(nb.some(e=>/\\breject\\b|\\bcancel\\b/i.test(getActionText(e)))) { co=n; break; }
                                n=n.parentElement; d++;
                            }
                        }
                        if (!co) {
                            co = b.closest('.antigravity-agent-side-panel, .interactive-session, .chat-widget, [class*=\"agent\"], [class*=\"chat\"]');
                            if (!co) {
                                let n=b.parentElement, d=0;
                                while(n && d<5) { co=n; n=n.parentElement; d++; }
                            }
                        }
                        if (!co) continue;
                        const sig=(t+'||'+getActionText(co).slice(0,260)).slice(0,320);
                        if (st.lastRunPromptSig===sig&&(now-(st.lastRunPromptApproveAt||0))<8000) continue;
                        const ct=getActionText(co), nb=Array.from(co.querySelectorAll ? co.querySelectorAll(SEL) : []);
                        let sc=0;
                        if(nb.some(e=>/\\breject\\b/i.test(getActionText(e)))) sc+=4;
                        if(nb.some(e=>/\\bcancel\\b/i.test(getActionText(e)))) sc+=2;
                        if(ct.includes('step requires input')) sc+=5;
                        if(ct.includes('ask every time')) sc+=3;
                        if(ct.includes('run alt')||ct.includes('runalt')) sc+=2;
                        if(/\\brun\\s*alt/i.test(t)||/runalt/i.test(t)) sc+=2;
                        if(sc===0 && /^\\s*run\\s*$/i.test(t)) sc=1;
                        if(sc>0) cands.push({btn:b,text:t,score:sc,sig});
                    }
                    if (cands.length) { cands.sort((a,b)=>b.score-a.score); const best=cands[0];
                        if (st.pendingRunSig!==best.sig) { st.pendingRunSig=best.sig; st.pendingRunFirstSeen=now; window.__autoAcceptFreeState=st; log('Run prompt detected — waiting...'); }
                        else if ((now-(st.pendingRunFirstSeen||0))>=DL) { if (clickEl(best.btn,'run-prompt')) { st.lastRunPromptSig=best.sig; st.lastRunPromptApproveAt=now; st.terminalCommands=(st.terminalCommands||0)+1; st.pendingRunSig=''; st.pendingRunFirstSeen=0; window.__autoAcceptFreeState=st; return; } }
                    }
                }
            }
            if (config.autoActions.autoRetry) { const allBtns = queryAll('button, [role="button"], a[role="button"]'); for (const b of allBtns) { const t=getActionText(b); if(!t)continue; if(t==='retry'||t.includes('retry')){if(clickEl(b,'retry'))return;} } }
            if (config.autoActions.autoSubmit) {
                const allLabels = queryAll('label');
                for (const l of allLabels) {
                    const txt = (l.textContent || '').toLowerCase();
                    if (txt.includes('yes, allow this time') || txt.includes('allow this time')) {
                        const input = l.querySelector('input[type="radio"]');
                        if (input && !input.checked) { if (clickEl(l, 'submit-option')) return; }
                    }
                }
                const allBtns = queryAll('button, [role="button"], a[role="button"]');
                for (const b of allBtns) {
                    const t = getActionText(b);
                    if (t === 'submit' || t.includes('submit')) { if (clickEl(b, 'submit')) return; }
                }
            }
            if (config.autoActions.autoAccept) { for (const b of btns) { const t=getActionText(b); if(!t)continue; if(!/\\baccept\\b|\\bkeep\\b|\\bapply\\b/i.test(t))continue; if(/\\breject\\b|\\bdeny\\b|\\bcancel\\b/i.test(t))continue; if(clickEl(b,'accept')){const s=window.__autoAcceptFreeState||{};s.fileEdits=(s.fileEdits||0)+1;window.__autoAcceptFreeState=s;return;} } }
        } catch(e){ log('Cycle error: '+(e&&e.message||String(e))); }
    };

    let lastRT=0; const TH=100;
    const throttledRC = () => { const now=Date.now(); if((now-lastRT)<TH){if(!throttleTimer){throttleTimer=setTimeout(()=>{throttleTimer=null;lastRT=Date.now();const s=window.__autoAcceptFreeState||{};s.observerTriggers=(s.observerTriggers||0)+1;window.__autoAcceptFreeState=s;runCycle('observer-delayed');},TH);}return;} lastRT=now;const s=window.__autoAcceptFreeState||{};s.observerTriggers=(s.observerTriggers||0)+1;window.__autoAcceptFreeState=s;runCycle('observer'); };

    window.__autoAcceptStart = (cfg) => {
        config=cfg||config; const s=window.__autoAcceptFreeState||{};s.isRunning=true;window.__autoAcceptFreeState=s;
        if(observer){try{observer.disconnect();}catch(e){}observer=null;} if(pollTimer){clearInterval(pollTimer);pollTimer=null;} if(throttleTimer){clearTimeout(throttleTimer);throttleTimer=null;}
        try{observer=new MutationObserver(throttledRC);observer.observe(document.body||document.documentElement,{childList:true,subtree:true});log('MutationObserver started');}catch(e){log('MutationObserver failed: '+e);}
        const fi=config.isBackgroundMode?600:800;
        pollTimer=setInterval(()=>{const s=window.__autoAcceptFreeState||{};s.fallbackPolls=(s.fallbackPolls||0)+1;window.__autoAcceptFreeState=s;runCycle('fallback');},fi);
        runCycle('init'); log('Started');
    };
    window.__autoAcceptStop = () => { if(observer){try{observer.disconnect();}catch(e){}observer=null;} if(pollTimer){clearInterval(pollTimer);pollTimer=null;} if(throttleTimer){clearTimeout(throttleTimer);throttleTimer=null;} const s=window.__autoAcceptFreeState||{};s.isRunning=false;window.__autoAcceptFreeState=s;log('Stopped'); };
    window.__autoAcceptGetStats = () => (window.__autoAcceptFreeState||{});
    window.__autoAcceptIsAlive = () => !!(observer&&window.__autoAcceptFreeState&&window.__autoAcceptFreeState.isRunning);
})();
`;

// Gửi Log hoạt động lên giao diện
function sendLogToUI(type, message) {
    try {
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

// Xác định đường dẫn file main.js của Antigravity IDE
function getIDEPath() {
    try {
        if (process.platform === 'win32') {
            const localAppData = process.env.LOCALAPPDATA;
            if (localAppData) {
                return path.join(localAppData, 'Programs', 'Antigravity IDE', 'resources', 'app', 'out', 'main.js');
            }
        } else if (process.platform === 'darwin') {
            return '/Applications/Antigravity IDE.app/Contents/Resources/app/out/main.js';
        } else if (process.platform === 'linux') {
            return '/usr/share/antigravity-ide/resources/app/out/main.js';
        }
    } catch (e) {
        console.error("[Error in getIDEPath]: Lỗi xác định đường dẫn IDE. Chi tiết:", e.message);
    }
    return null;
}

// Tự động kiểm tra và vá file main.js của IDE để mở cổng CDP 9000
function patchIDE() {
    try {
        const mainJsPath = getIDEPath();
        if (!mainJsPath) {
            sendLogToUI('warning', 'Không xác định được đường dẫn Antigravity IDE trên hệ điều hành này.');
            return false;
        }

        if (!fs.existsSync(mainJsPath)) {
            sendLogToUI('info', `Không tìm thấy file main.js của IDE tại: ${mainJsPath} (Bỏ qua nếu IDE chạy dev mode)`);
            return false;
        }

        let content = fs.readFileSync(mainJsPath, 'utf8');
        const marker = '/*__autoRunBuiltinRemoteDebug9000*/';

        if (content.includes(marker)) {
            sendLogToUI('info', 'Cấu hình kết nối IDE đã được thiết lập trước đó.');
            return true;
        }

        sendLogToUI('warning', 'Đang tiến hành cấu hình thiết lập kết nối cho IDE...');
        const patchCode = `${marker}import { app } from 'electron'; if (app) { app.commandLine.appendSwitch('remote-debugging-port', '9000'); }\n`;
        const newContent = patchCode + content;

        fs.writeFileSync(mainJsPath, newContent, 'utf8');
        sendLogToUI('success', 'Cấu hình kết nối cho Antigravity IDE thành công! Vui lòng khởi động lại IDE.');
        return true;
    } catch (e) {
        sendLogToUI('danger', `Lỗi thiết lập cấu hình IDE: ${e.message}`);
        console.error("[Error in patchIDE]: Lỗi vá IDE. Chi tiết:", e.message, e.stack);
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
                        const filtered = targets.filter(t =>
                            t.webSocketDebuggerUrl &&
                            (t.type === 'page' || t.type === 'webview') &&
                            !t.url.toLowerCase().startsWith('devtools://')
                        );
                        resolve(filtered);
                    } catch (e) {
                        console.error("[Error in discoverTargets (parse)]: Lỗi parse JSON targets. Chi tiết:", e.message);
                        resolve([]);
                    }
                });
            }).on('error', () => {
                // Thất bại lặng lẽ khi IDE chưa mở
                resolve([]);
            });
        } catch (e) {
            console.error("[Error in discoverTargets]: Lỗi khám phá targets. Chi tiết:", e.message);
            resolve([]);
        }
    });
}

// Kết nối đến Target WebSocket của IDE
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

        const checkResult = await conn.evaluate('window.__autoAcceptVersion === "v2.5" && typeof window.__autoAcceptStart === "function"');
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
                if (conn.injected) {
                    const statsResult = await conn.evaluate('JSON.stringify(window.__autoAcceptGetStats ? window.__autoAcceptGetStats() : {})');
                    if (statsResult && statsResult.value) {
                        const stats = JSON.parse(statsResult.value);
                        clicks += (stats.clicks || 0);
                        commands += (stats.terminalCommands || 0);
                        
                        // Nếu có thông tin bị block lệnh cấm
                        if (stats.lastAction === 'blocked' && stats.lastActionLabel) {
                            sendLogToUI('danger', `NGĂN CHẶN LỆNH CẤM: ${stats.lastActionLabel}`);
                        }
                    }
                }
            } catch (e) {
                console.error(`[Error in queryStats (loop)]: Lỗi lấy stats target ${conn.title}. Chi tiết:`, e.message);
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
            // Kích hoạt vá IDE và bắt đầu vòng lặp khi giao diện sẵn sàng
            setTimeout(() => {
                patchIDE();
                startAutoRunLoop();
            }, 1000);
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
        // Sử dụng một icon mặc định hoặc tạo icon trống
        const iconPath = path.join(__dirname, 'tray_icon.png');
        
        // Nếu file icon chưa tồn tại, tạo file icon giả lập đơn giản từ main.js
        if (!fs.existsSync(iconPath)) {
            // Chúng ta có thể tạo file icon trống bằng cách ghi file (ở đây để an toàn ta ghi file png dung lượng cực nhỏ)
            // Hoặc sử dụng nativeImage từ electron. Ở đây để sạch sẽ ta dùng text hoặc cứ dùng tray mà không cần icon (sử dụng icon mặc định của electron nếu có)
        }

        tray = new Tray(fs.existsSync(iconPath) ? iconPath : path.join(__dirname, 'package.json')); // Fallback to package.json nếu không có icon
        tray.setToolTip('Antigravity Auto-Run Controller');

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
        createMainWindow();
        createTray();

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
                targets.forEach(connectTarget);
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

ipcMain.on('request-patch', () => {
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
                                message: `Đã tìm thấy bản cập nhật mới v${latestVersion} cho Antigravity Auto-Run Desktop App. Bạn có muốn tải về và cài đặt tự động không?`
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
