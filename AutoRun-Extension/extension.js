const vscode = require('vscode');
const http = require('http');
const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const pkg = require('./package.json');

let isEnabled = true;
let totalClicks = 0;
let totalCommands = 0;
let statusBarItem = null;
const connections = new Map(); // targetId -> connection info
let scanInterval = null;
let statsInterval = null;

let dashboardPanel = null;
const activityLogs = [];

// Ham ghi nhat ky he thong va thong bao cho Webview Dashboard
function addActivityLog(message, type = 'info') {
    try {
        const time = new Date().toLocaleTimeString();
        activityLogs.unshift({ time, message, type });
        if (activityLogs.length > 100) {
            activityLogs.pop();
        }
        sendStateToWebview();
    } catch (e) {
        console.error("[Error in addActivityLog]: Loi xay ra khi ghi log he thong. Chi tiet:", e.message, e.stack);
    }
}

// Cấu hình hoạt động của Auto-Run
let CONFIG = {
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

    const log = (msg) => console.log('[AutoRun-Ext] ' + msg);
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

// Xác định đường dẫn file main.js của Antigravity IDE
function getIDEPath() {
    try {
        if (process.platform === 'win32') {
            const localAppData = process.env.LOCALAPPDATA;
            if (localAppData) {
                const pathIDE = path.join(localAppData, 'Programs', 'Antigravity IDE');
                const pathNormal = path.join(localAppData, 'Programs', 'Antigravity');

                // 1. Kiem tra thu muc Antigravity IDE truoc (Uu tien so 1)
                const mainJsIDE = path.join(pathIDE, 'resources', 'app', 'out', 'main.js');
                if (fs.existsSync(mainJsIDE)) {
                    return mainJsIDE;
                }

                // 2. Kiem tra thu muc Antigravity (Fallback danh cho ban IDE cu < 2.0)
                const mainJsNormal = path.join(pathNormal, 'resources', 'app', 'out', 'main.js');
                if (fs.existsSync(mainJsNormal)) {
                    const pkgPath = path.join(pathNormal, 'resources', 'app', 'package.json');
                    if (fs.existsSync(pkgPath)) {
                        try {
                            const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
                            const version = pkg.version || "";
                            // Neu version tu 2.0 tro len tai Programs/Antigravity thi day la ban CLI, khong phai IDE
                            if (version.startsWith('2.')) {
                                console.log(`[Auto-Run Ext] Phat hien Antigravity phien ban ${version} >= 2.0 tai Programs/Antigravity, day la ban CLI, khong phai IDE.`);
                                return null;
                            }
                        } catch (err) {
                            console.error("[Error in getIDEPath - Read package.json]: Loi kiem tra version IDE. Chi tiet:", err.message);
                        }
                    }
                    return mainJsNormal;
                }
            }
        } else if (process.platform === 'darwin') {
            return '/Applications/Antigravity IDE.app/Contents/Resources/app/out/main.js';
        } else if (process.platform === 'linux') {
            return '/usr/share/antigravity-ide/resources/app/out/main.js';
        }
    } catch (e) {
        console.error("[Error in getIDEPath]: Loi xac dinh duong dan IDE. Chi tiet:", e.message);
    }
    return null;
}

// Tự động kiểm tra và vá file main.js của Antigravity IDE để tự động mở cổng CDP 9000
function patchMainJs() {
    try {
        const localAppData = process.env.LOCALAPPDATA;
        if (!localAppData) {
            console.error("[Error in patchMainJs]: Khong tim thay bien moi truong LOCALAPPDATA tai extension.js của Extension");
            return;
        }
        
        const mainJsPath = getIDEPath();
        
        if (!mainJsPath || !fs.existsSync(mainJsPath)) {
            console.log(`[Auto-Run Ext] File main.js cua IDE khong ton tai tai: ${mainJsPath} (Co the dang chay trong moi truong development)`);
            return;
        }

        // Đọc package.json của IDE để phát hiện xem nó có phải là ES Module không
        let isESM = false;
        try {
            const packageJsonPath = path.join(path.dirname(mainJsPath), '..', 'package.json');
            if (fs.existsSync(packageJsonPath)) {
                const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
                if (pkg && pkg.type === 'module') {
                    isESM = true;
                }
            }
        } catch (pkgErr) {
            console.error("[Error in patchMainJs - Read package.json]: Không thể đọc hoặc parse package.json của IDE. Chi tiết:", pkgErr.message, pkgErr);
        }

        let content = fs.readFileSync(mainJsPath, 'utf8');
        const marker = '/*__autoRunBuiltinRemoteDebug9000*/';
        
        // Tạo bản vá thích hợp cho ESM hoặc CommonJS
        const patchCode = isESM
            ? `${marker}import { app } from 'electron'; if (app) { app.commandLine.appendSwitch('remote-debugging-port', '9000'); }\n`
            : `${marker}const { app } = require('electron'); if (app) { app.commandLine.appendSwitch('remote-debugging-port', '9000'); }\n`;
        
        if (content.includes(patchCode)) {
            console.log("[Auto-Run Ext] File main.js cua IDE da duoc va truoc do voi ban va moi, khong can va lai.");
            return;
        }

        console.log(`[Auto-Run Ext] Dang tien hanh va file main.js de mo cong CDP 9000 (${isESM ? 'ES Module' : 'CommonJS'})...`);
        
        // Loại bỏ các bản vá cũ hoặc lỗi (kể cả bản vá sử dụng import/require cũ)
        if (content.includes(marker)) {
            content = content.replace(/\/\*__autoRunBuiltinRemoteDebug9000\*\/.*?\n/g, '');
        }

        const newContent = patchCode + content;

        fs.writeFileSync(mainJsPath, newContent, 'utf8');
        console.log("[Auto-Run Ext] Va file main.js thanh cong!");
        
        vscode.window.showInformationMessage('⚡ Đã tự động cấu hình kết nối cho Antigravity IDE. Vui lòng khởi động lại IDE để tính năng Auto-Run hoạt động!');
    } catch (e) {
        console.error("[Error in patchMainJs]: Khong the va file main.js cua IDE tai extension.js của Extension. Chi tiet loi: " + e.message, e);
    }
}

// Lấy danh sách targets từ cổng debug 9000
function discoverTargets() {
    return new Promise((resolve) => {
        try {
            http.get('http://127.0.0.1:9000/json/list', { timeout: 1000 }, (res) => {
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
                        console.error("[Error in discoverTargets (parse)]: Lỗi parse JSON targets. Chi tiết:", e);
                        resolve([]);
                    }
                });
            }).on('error', () => {
                // Không in lỗi để tránh rác console khi IDE đang đóng hoặc chưa mở cổng debug
                resolve([]);
            });
        } catch (e) {
            console.error("[Error in discoverTargets]: Lỗi xảy ra tại hàm 'discoverTargets'. Chi tiết:", e);
            resolve([]);
        }
    });
}

// Kết nối đến Target WebSocket
function connectTarget(target) {
    try {
        const url = target.webSocketDebuggerUrl;
        const id = target.id;
        if (connections.has(id)) {
            return;
        }

        console.log(`[Auto-Run Ext] Connecting to target: ${target.title} (${id})`);
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
                    console.error(`[Error in connInfo.send]: Lỗi gửi gói tin CDP. Chi tiết:`, e);
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
                        console.error(`[Error in connInfo.evaluate]: Lỗi evaluate JS. Chi tiết:`, e);
                        resolve(null);
                    }
                });
            }
        };

        connections.set(id, connInfo);

        ws.on('open', async () => {
            try {
                console.log(`[Auto-Run Ext] Connected to: ${target.title}`);
                addActivityLog(`Đã kết nối thành công tới Target: "${target.title}"`, 'success');
                await injectScript(connInfo);
            } catch (e) {
                console.error(`[Error in ws.on('open')]: Lỗi xử lý sau khi kết nối. Chi tiết:`, e);
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
                console.error(`[Error in ws.on('message')]: Lỗi xử lý message từ WebSocket. Chi tiết:`, e);
            }
        });

        ws.on('close', () => {
            try {
                console.log(`[Auto-Run Ext] Connection closed for: ${target.title}`);
                addActivityLog(`Đã ngắt kết nối khỏi Target: "${target.title}"`, 'warn');
                connections.delete(id);
                pendingEvaluates.clear();
                sendStateToWebview();
            } catch (closeErr) {
                console.error(`[Error in ws.on('close')]: Lỗi xử lý đóng kết nối. Chi tiết:`, closeErr);
            }
        });

        ws.on('error', (err) => {
            console.error(`[Error in ws.on('error')]: WebSocket lỗi cho target ${target.title}. Chi tiết:`, err);
            ws.close();
        });

    } catch (e) {
        console.error("[Error in connectTarget]: Lỗi xảy ra tại hàm 'connectTarget'. Chi tiết:", e);
    }
}

// Chèn Script vào Target
async function injectScript(conn) {
    try {
        if (!isEnabled) return;
        
        const checkResult = await conn.evaluate('window.__autoAcceptVersion === "v2.5" && typeof window.__autoAcceptStart === "function"');
        const isLoaded = checkResult && checkResult.value;

        if (!isLoaded) {
            await conn.evaluate(AUTO_ACCEPT_SCRIPT);
            conn.injected = true;
            console.log(`[Auto-Run Ext] Injected Auto accept script to target: ${conn.title}`);
        }

        const configJson = JSON.stringify(CONFIG);
        await conn.evaluate(`if(window.__autoAcceptStart) window.__autoAcceptStart(${configJson})`);
        
    } catch (e) {
        console.error("[Error in injectScript]: Lỗi xảy ra tại hàm 'injectScript'. Chi tiết:", e);
    }
}

// Thu thập thống kê clicks từ các targets
async function queryStats() {
    try {
        if (!isEnabled) {
            updateStatusBar(false);
            return;
        }

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

                        // So sánh dữ liệu thống kê cũ để ghi nhận sự kiện mới
                        if (!conn.lastStats) {
                            conn.lastStats = { clicks: 0, terminalCommands: 0, blocked: 0, permissions: 0 };
                        }

                        if (stats.clicks > conn.lastStats.clicks) {
                            addActivityLog(`[${conn.title}] Tự động Click thành công: "${stats.lastActionLabel || 'Không rõ'}" (${stats.lastAction || 'generic'})`, 'success');
                        }
                        if (stats.blocked > conn.lastStats.blocked) {
                            addActivityLog(`[${conn.title}] ĐÃ CHẶN lệnh nguy hiểm: "${stats.lastActionLabel || 'Không rõ'}"`, 'error');
                        }
                        if (stats.permissions > conn.lastStats.permissions) {
                            addActivityLog(`[${conn.title}] Tự động cấp quyền thành công: "${stats.lastActionLabel || 'Không rõ'}"`, 'info');
                        }

                        conn.lastStats = stats;
                    }
                }
            } catch (e) {
                console.error(`[Error in queryStats (loop)]: Lỗi lấy stats từ target ${conn.title}. Chi tiết:`, e);
            }
        }

        totalClicks = clicks;
        totalCommands = commands;
        updateStatusBar(true);
        sendStateToWebview();
    } catch (e) {
        console.error("[Error in queryStats]: Lỗi xảy ra tại hàm 'queryStats'. Chi tiết:", e);
    }
}

// Cập nhật giao diện Status Bar Item
function updateStatusBar(active) {
    try {
        if (!statusBarItem) return;
        
        if (active) {
            statusBarItem.text = `$(zap) Auto-Run: ON (${totalClicks} Clicks)`;
            statusBarItem.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
            statusBarItem.color = '#ffffff';
            statusBarItem.tooltip = `Antigravity Auto-Run: Đang hoạt động\n- Clicks: ${totalClicks}\n- Commands: ${totalCommands}\n- Targets: ${connections.size}\n\nClick để mở Bảng Điều Khiển`;
        } else {
            statusBarItem.text = `$(circle-slash) Auto-Run: OFF`;
            statusBarItem.backgroundColor = undefined;
            statusBarItem.color = new vscode.ThemeColor('statusBarItem.prominentForeground');
            statusBarItem.tooltip = `Antigravity Auto-Run: Đã tắt\n\nClick để mở Bảng Điều Khiển`;
        }
    } catch (e) {
        console.error("[Error in updateStatusBar]: Lỗi xảy ra tại hàm 'updateStatusBar'. Chi tiết:", e.message, e.stack);
    }
}

// Hiển thị Dashboard Webview
function showDashboard(context) {
    try {
        if (dashboardPanel) {
            dashboardPanel.reveal(vscode.ViewColumn.One);
            sendStateToWebview();
            return;
        }

        dashboardPanel = vscode.window.createWebviewPanel(
            'antigravityAutoRunDashboard',
            '⚡ Antigravity Auto-Run Dashboard',
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true
            }
        );

        const logoUri = dashboardPanel.webview.asWebviewUri(vscode.Uri.file(path.join(context.extensionPath, 'logo.jpeg')));
        dashboardPanel.webview.html = getWebviewContent(logoUri);

        dashboardPanel.webview.onDidReceiveMessage(
            message => {
                try {
                    handleWebviewMessage(message, context);
                } catch (msgErr) {
                    console.error("[Error in showDashboard - onDidReceiveMessage]: Lỗi xử lý tin nhắn nhận được từ Webview. Chi tiết:", msgErr.message, msgErr.stack);
                }
            },
            undefined,
            context.subscriptions
        );

        dashboardPanel.onDidDispose(
            () => {
                try {
                    dashboardPanel = null;
                } catch (disposeErr) {
                    console.error("[Error in showDashboard - onDidDispose]: Lỗi xử lý khi giải phóng Dashboard Webview. Chi tiết:", disposeErr.message, disposeErr.stack);
                }
            },
            null,
            context.subscriptions
        );

        setTimeout(() => {
            try {
                sendStateToWebview();
            } catch (tErr) {
                console.error("[Error in showDashboard - timeoutState]: Lỗi gửi trạng thái khởi tạo. Chi tiết:", tErr.message, tErr.stack);
            }
        }, 500);

        addActivityLog("Đã mở Bảng Điều Khiển (Dashboard)", "info");
    } catch (e) {
        console.error("[Error in showDashboard]: Lỗi khởi tạo Dashboard Webview. Chi tiết:", e.message, e.stack);
    }
}

// Xử lý tin nhắn từ Webview gửi lên
function handleWebviewMessage(message, context) {
    try {
        if (!message) return;
        switch (message.command) {
            case 'toggle':
                try {
                    isEnabled = !isEnabled;
                    updateStatusBar(isEnabled);
                    addActivityLog(`Trạng thái Auto-Run được thay đổi thành: ${isEnabled ? 'BẬT' : 'TẮT'}`, isEnabled ? 'success' : 'warn');
                    if (isEnabled) {
                        discoverTargets().then(targets => {
                            targets.forEach(connectTarget);
                        });
                    } else {
                        for (const conn of connections.values()) {
                            conn.evaluate('if(window.__autoAcceptStop) window.__autoAcceptStop()');
                        }
                    }
                    sendStateToWebview();
                } catch (toggleErr) {
                    console.error("[Error in handleWebviewMessage - toggle]: Lỗi thay đổi trạng thái Auto-Run. Chi tiết:", toggleErr.message, toggleErr.stack);
                }
                break;
            case 'updateConfig':
                try {
                    if (message.config) {
                        CONFIG = Object.assign({}, CONFIG, message.config);
                        context.globalState.update('antigravity_autorun_config', CONFIG);
                        addActivityLog("Đã cập nhật cấu hình hoạt động mới.", "success");
                        // Gửi cấu hình mới tới các targets đang kết nối
                        for (const conn of connections.values()) {
                            if (conn.injected) {
                                conn.evaluate(`if(window.__autoAcceptStart) window.__autoAcceptStart(${JSON.stringify(CONFIG)})`);
                            }
                        }
                    }
                    sendStateToWebview();
                } catch (configErr) {
                    console.error("[Error in handleWebviewMessage - updateConfig]: Lỗi cập nhật cấu hình hoạt động. Chi tiết:", configErr.message, configErr.stack);
                }
                break;
            case 'requestState':
                try {
                    sendStateToWebview();
                } catch (stateErr) {
                    console.error("[Error in handleWebviewMessage - requestState]: Lỗi phản hồi yêu cầu trạng thái. Chi tiết:", stateErr.message, stateErr.stack);
                }
                break;
        }
    } catch (e) {
        console.error("[Error in handleWebviewMessage]: Lỗi xử lý tin nhắn từ Webview. Chi tiết:", e.message, e.stack);
    }
}

// Đồng bộ trạng thái hiện tại sang Webview
function sendStateToWebview() {
    try {
        if (!dashboardPanel) return;
        
        const targetsList = [];
        for (const [id, conn] of connections.entries()) {
            targetsList.push({
                id,
                title: conn.title,
                injected: conn.injected,
                stats: conn.lastStats || { clicks: 0, terminalCommands: 0, blocked: 0 }
            });
        }
        
        dashboardPanel.webview.postMessage({
            command: 'updateState',
            state: {
                isEnabled,
                totalClicks,
                totalCommands,
                config: CONFIG,
                targets: targetsList,
                logs: activityLogs
            }
        });
    } catch (e) {
        console.error("[Error in sendStateToWebview]: Lỗi đồng bộ trạng thái sang Webview. Chi tiết:", e.message, e.stack);
    }
}

// HTML, CSS, JS Premium Dashboard View cho Webview
function getWebviewContent(logoUri = '') {
    try {
        return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Antigravity Auto-Run Dashboard</title>
    <link rel="preconnect" href="https://fonts.googleapis.com">
    <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
    <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
    <style>
        :root {
            --bg-dark: #090514;
            --bg-card: rgba(22, 15, 41, 0.6);
            --bg-glass: rgba(255, 255, 255, 0.03);
            --border-glass: rgba(255, 255, 255, 0.08);
            --border-glow: rgba(139, 92, 246, 0.25);
            --text-primary: #f8fafc;
            --text-secondary: #94a3b8;
            --text-muted: #64748b;
            --color-purple: #8b5cf6;
            --color-purple-glow: rgba(139, 92, 246, 0.4);
            --color-neon: #10b981;
            --color-neon-glow: rgba(16, 185, 129, 0.4);
            --color-red: #f43f5e;
            --color-red-glow: rgba(244, 63, 94, 0.4);
            --font-main: 'Outfit', sans-serif;
            --font-mono: 'JetBrains Mono', monospace;
        }

        * {
            box-sizing: border-box;
            margin: 0;
            padding: 0;
            user-select: none;
        }

        body {
            font-family: var(--font-main);
            background-color: var(--bg-dark);
            color: var(--text-primary);
            min-height: 100vh;
            padding: 8px;
            overflow-x: hidden;
            background-image: 
                radial-gradient(circle at 10% 20%, rgba(139, 92, 246, 0.1) 0%, transparent 40%),
                radial-gradient(circle at 90% 80%, rgba(16, 185, 129, 0.08) 0%, transparent 40%);
            background-attachment: fixed;
            font-size: 11px;
        }

        /* Scrollbar styling */
        ::-webkit-scrollbar {
            width: 4px;
            height: 4px;
        }
        ::-webkit-scrollbar-track {
            background: rgba(255, 255, 255, 0.01);
        }
        ::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.1);
            border-radius: 2px;
        }
        ::-webkit-scrollbar-thumb:hover {
            background: rgba(139, 92, 246, 0.3);
        }

        .container {
            max-width: 1000px;
            margin: 0 auto;
            display: flex;
            flex-direction: column;
            gap: 8px;
        }

        /* Glassmorphism Card Style */
        .glass-card {
            background: var(--bg-card);
            backdrop-filter: blur(8px);
            -webkit-backdrop-filter: blur(8px);
            border: 1px solid var(--border-glass);
            border-radius: 6px;
            padding: 10px 12px;
            box-shadow: 0 4px 15px 0 rgba(0, 0, 0, 0.4);
            transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
        }

        .glass-card:hover {
            border-color: var(--border-glow);
            box-shadow: 0 4px 15px 0 rgba(139, 92, 246, 0.1);
        }

        /* Header Style */
        header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding-bottom: 2px;
        }

        .brand {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .logo-container {
            position: relative;
            display: flex;
            align-items: center;
            justify-content: center;
            width: 26px;
            height: 26px;
            border-radius: 5px;
            box-shadow: 0 0 8px var(--color-purple-glow);
            animation: pulse-glow 2s infinite alternate;
            overflow: hidden;
        }

        .brand-text h1 {
            font-size: 13px;
            font-weight: 800;
            letter-spacing: 0.5px;
            background: linear-gradient(to right, #fff, var(--text-secondary));
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
        }

        .brand-text p {
            font-size: 9px;
            color: var(--text-muted);
            margin-top: 0px;
        }

        /* Status Badge */
        .status-panel {
            display: flex;
            align-items: center;
            gap: 8px;
        }

        .status-badge {
            display: flex;
            align-items: center;
            gap: 4px;
            padding: 3px 6px;
            border-radius: 9999px;
            font-size: 9px;
            font-weight: 600;
            text-transform: uppercase;
            letter-spacing: 0.5px;
            border: 1px solid transparent;
        }

        .status-badge.active {
            background: rgba(16, 185, 129, 0.1);
            color: var(--color-neon);
            border-color: rgba(16, 185, 129, 0.2);
            box-shadow: 0 0 6px rgba(16, 185, 129, 0.1);
        }

        .status-badge.inactive {
            background: rgba(244, 63, 94, 0.1);
            color: var(--color-red);
            border-color: rgba(244, 63, 94, 0.2);
            box-shadow: 0 0 6px rgba(244, 63, 94, 0.1);
        }

        .status-dot {
            width: 4px;
            height: 4px;
            border-radius: 50%;
            background-color: currentColor;
        }

        .status-dot.ping {
            animation: ping 1.5s cubic-bezier(0, 0, 0.2, 1) infinite;
        }

        /* Master Switch Button */
        .btn-toggle {
            cursor: pointer;
            padding: 4px 10px;
            border-radius: 5px;
            font-family: var(--font-main);
            font-size: 10px;
            font-weight: 700;
            border: 1px solid var(--border-glass);
            color: #fff;
            background: linear-gradient(135deg, rgba(139, 92, 246, 0.6), rgba(99, 102, 241, 0.6));
            box-shadow: 0 2px 6px rgba(139, 92, 246, 0.15);
            transition: all 0.2s ease;
            display: flex;
            align-items: center;
            gap: 4px;
        }

        .btn-toggle:hover {
            transform: translateY(-0.5px);
            box-shadow: 0 3px 10px rgba(139, 92, 246, 0.3);
            border-color: rgba(255, 255, 255, 0.2);
        }

        .btn-toggle.active-btn {
            background: linear-gradient(135deg, rgba(244, 63, 94, 0.6), rgba(225, 29, 72, 0.6));
            box-shadow: 0 2px 6px rgba(244, 63, 94, 0.15);
        }

        .btn-toggle.active-btn:hover {
            box-shadow: 0 3px 10px rgba(244, 63, 94, 0.3);
        }

        /* Statistics Grid */
        .stats-grid {
            display: grid;
            grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
            gap: 8px;
        }

        .stat-card {
            position: relative;
            display: flex;
            align-items: center;
            gap: 8px;
            overflow: hidden;
            padding: 8px 12px;
        }

        .stat-card::before {
            content: '';
            position: absolute;
            top: 0;
            left: 0;
            width: 2px;
            height: 100%;
            background-color: var(--color-purple);
        }

        .stat-card.neon-bar::before {
            background-color: var(--color-neon);
        }

        .stat-card.red-bar::before {
            background-color: var(--color-red);
        }

        .stat-icon {
            display: flex;
            align-items: center;
            justify-content: center;
            width: 26px;
            height: 26px;
            background: rgba(255, 255, 255, 0.03);
            border: 1px solid var(--border-glass);
            border-radius: 5px;
            font-size: 13px;
        }

        .stat-card.neon-bar .stat-icon {
            color: var(--color-neon);
            border-color: rgba(16, 185, 129, 0.15);
            background: rgba(16, 185, 129, 0.03);
        }

        .stat-card:not(.neon-bar):not(.red-bar) .stat-icon {
            color: var(--color-purple);
            border-color: rgba(139, 92, 246, 0.15);
            background: rgba(139, 92, 246, 0.03);
        }

        .stat-card.red-bar .stat-icon {
            color: var(--color-red);
            border-color: rgba(244, 63, 94, 0.15);
            background: rgba(244, 63, 94, 0.03);
        }

        .stat-info {
            display: flex;
            flex-direction: column;
        }

        .stat-label {
            font-size: 9px;
            color: var(--text-secondary);
            font-weight: 500;
        }

        .stat-value {
            font-size: 16px;
            font-weight: 800;
            letter-spacing: -0.5px;
            margin-top: 1px;
            line-height: 1;
        }

        /* Config Grid */
        .config-grid {
            display: grid;
            grid-template-columns: 1.1fr 1.9fr;
            gap: 8px;
        }

        @media (max-width: 900px) {
            .config-grid {
                grid-template-columns: 1fr;
            }
        }

        .section-title {
            font-size: 10px;
            font-weight: 700;
            margin-bottom: 8px;
            display: flex;
            align-items: center;
            gap: 4px;
            border-bottom: 1px solid var(--border-glass);
            padding-bottom: 4px;
            letter-spacing: 0.5px;
        }

        .section-title span.title-icon {
            color: var(--color-purple);
        }

        /* Switch list */
        .switch-list {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }

        .switch-item {
            display: flex;
            align-items: center;
            justify-content: space-between;
            background: rgba(255, 255, 255, 0.01);
            border: 1px solid rgba(255, 255, 255, 0.03);
            padding: 4px 8px;
            border-radius: 6px;
            transition: all 0.2s ease;
        }

        .switch-item:hover {
            background: rgba(255, 255, 255, 0.03);
            border-color: rgba(255, 255, 255, 0.05);
        }

        .switch-details {
            display: flex;
            flex-direction: column;
            gap: 0px;
        }

        .switch-title {
            font-size: 10px;
            font-weight: 600;
        }

        .switch-desc {
            font-size: 8px;
            color: var(--text-muted);
        }

        /* Modern Toggle Switch */
        .switch {
            position: relative;
            display: inline-block;
            width: 24px;
            height: 14px;
        }

        .switch input {
            opacity: 0;
            width: 0;
            height: 0;
        }

        .slider {
            position: absolute;
            cursor: pointer;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: rgba(255, 255, 255, 0.1);
            border: 1px solid var(--border-glass);
            transition: .3s cubic-bezier(0.4, 0, 0.2, 1);
            border-radius: 34px;
        }

        .slider:before {
            position: absolute;
            content: "";
            height: 10px;
            width: 10px;
            left: 1px;
            bottom: 1px;
            background-color: #fff;
            transition: .3s cubic-bezier(0.4, 0, 0.2, 1);
            border-radius: 50%;
            box-shadow: 0 1px 2px rgba(0, 0, 0, 0.2);
        }

        input:checked + .slider {
            background-color: var(--color-purple);
            border-color: rgba(139, 92, 246, 0.3);
            box-shadow: 0 0 4px rgba(139, 92, 246, 0.2);
        }

        input:checked + .slider:before {
            transform: translateX(10px);
        }

        /* Banned Commands UI */
        .banned-commands-container {
            display: flex;
            flex-direction: column;
            gap: 6px;
            height: 100%;
        }

        .banned-input-group {
            display: flex;
            gap: 6px;
        }

        .banned-input {
            flex: 1;
            background: rgba(0, 0, 0, 0.2);
            border: 1px solid var(--border-glass);
            border-radius: 5px;
            padding: 4px 8px;
            color: #fff;
            font-family: var(--font-mono);
            font-size: 10px;
            outline: none;
            transition: all 0.2s ease;
        }

        .banned-input:focus {
            border-color: var(--color-purple);
            box-shadow: 0 0 4px var(--color-purple-glow);
        }

        .btn-add {
            cursor: pointer;
            padding: 0 8px;
            border-radius: 5px;
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid var(--border-glass);
            color: #fff;
            font-family: var(--font-main);
            font-weight: 600;
            font-size: 10px;
            transition: all 0.2s ease;
        }

        .btn-add:hover {
            background: var(--color-purple);
            border-color: var(--color-purple);
            box-shadow: 0 0 6px var(--color-purple-glow);
        }

        .banned-list {
            display: flex;
            flex-wrap: wrap;
            gap: 4px;
            max-height: 90px;
            overflow-y: auto;
            padding: 4px;
            background: rgba(0, 0, 0, 0.15);
            border: 1px solid rgba(255, 255, 255, 0.02);
            border-radius: 6px;
        }

        .banned-tag {
            background: rgba(244, 63, 94, 0.08);
            border: 1px solid rgba(244, 63, 94, 0.2);
            border-radius: 3px;
            padding: 2px 4px;
            font-family: var(--font-mono);
            font-size: 9px;
            color: #fda4af;
            display: flex;
            align-items: center;
            gap: 3px;
            transition: all 0.2s ease;
        }

        .banned-tag:hover {
            border-color: rgba(244, 63, 94, 0.4);
            background: rgba(244, 63, 94, 0.12);
        }

        .banned-tag-remove {
            cursor: pointer;
            color: var(--text-muted);
            font-weight: 700;
            font-size: 9px;
            transition: color 0.15s ease;
        }

        .banned-tag-remove:hover {
            color: var(--color-red);
        }

        /* Connection Targets list */
        .targets-section {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }

        .targets-list {
            display: grid;
            grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
            gap: 8px;
        }

        .target-card {
            background: rgba(255, 255, 255, 0.02);
            border: 1px solid var(--border-glass);
            border-radius: 6px;
            padding: 6px 8px;
            display: flex;
            flex-direction: column;
            gap: 4px;
            position: relative;
        }

        .target-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
        }

        .target-title {
            font-size: 10px;
            font-weight: 600;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 120px;
        }

        .target-badge {
            font-size: 8px;
            font-weight: 700;
            padding: 1px 4px;
            border-radius: 3px;
            text-transform: uppercase;
        }

        .target-badge.connected {
            background: rgba(16, 185, 129, 0.1);
            color: var(--color-neon);
            border: 1px solid rgba(16, 185, 129, 0.2);
        }

        .target-badge.injected {
            background: rgba(139, 92, 246, 0.1);
            color: var(--color-purple);
            border: 1px solid rgba(139, 92, 246, 0.2);
        }

        .target-details {
            display: flex;
            flex-direction: column;
            gap: 2px;
            font-size: 9px;
            color: var(--text-secondary);
        }

        .target-stat {
            display: flex;
            justify-content: space-between;
            border-bottom: 1px solid rgba(255, 255, 255, 0.03);
            padding-bottom: 1px;
        }

        .target-stat:last-child {
            border: none;
            padding-bottom: 0;
        }

        .target-stat span.val {
            font-family: var(--font-mono);
            font-weight: 500;
            color: #fff;
        }

        .no-targets {
            grid-column: 1 / -1;
            padding: 16px;
            text-align: center;
            color: var(--text-muted);
            font-size: 10px;
            border: 1px dashed var(--border-glass);
            border-radius: 6px;
            background: rgba(0,0,0,0.1);
        }

        /* Activity Logs Section */
        .logs-container {
            display: flex;
            flex-direction: column;
            gap: 6px;
        }

        .logs-console {
            background: #04020a;
            border: 1px solid var(--border-glass);
            border-radius: 6px;
            padding: 6px 10px;
            height: 110px;
            overflow-y: auto;
            font-family: var(--font-mono);
            font-size: 9px;
            display: flex;
            flex-direction: column;
            gap: 3px;
            box-shadow: inset 0 0 8px rgba(0,0,0,0.8);
        }

        .log-line {
            display: flex;
            gap: 8px;
            line-height: 1.3;
            padding: 1px 2px;
            border-radius: 2px;
            transition: background-color 0.15s ease;
        }

        .log-line:hover {
            background: rgba(255, 255, 255, 0.02);
        }

        .log-time {
            color: var(--text-muted);
            flex-shrink: 0;
        }

        .log-msg {
            color: var(--text-primary);
            word-break: break-all;
        }

        .log-line.success .log-msg {
            color: #34d399;
        }

        .log-line.error .log-msg {
            color: #fb7185;
        }

        .log-line.warn .log-msg {
            color: #fbbf24;
        }

        .log-line.info .log-msg {
            color: #60a5fa;
        }

        /* Animations */
        @keyframes pulse-glow {
            from {
                box-shadow: 0 0 12px rgba(139, 92, 246, 0.4);
            }
            to {
                box-shadow: 0 0 24px rgba(139, 92, 246, 0.7);
            }
        }

        @keyframes ping {
            75%, 100% {
                transform: scale(2);
                opacity: 0;
            }
        }
    </style>
</head>
<body>
    <div class="container">
        <!-- Header -->
        <header class="glass-card">
            <div class="brand">
                <div class="logo-container">
                    <img src="${logoUri}" alt="Logo" style="width: 100%; height: 100%; object-fit: cover;">
                </div>
                <div class="brand-text">
                    <h1>Auto-Run Dashboard</h1>
                    <p>Hệ thống tự động hóa điều khiển Antigravity IDE</p>
                </div>
            </div>
            
            <div class="status-panel">
                <div id="status-badge" class="status-badge inactive">
                    <span class="status-dot"></span>
                    <span class="status-dot ping" style="position: absolute; margin-left: -8px;"></span>
                    <span id="status-text">OFFLINE</span>
                </div>
                <button id="master-btn" class="btn-toggle">
                    <span>Khởi động Auto-Run</span>
                </button>
            </div>
        </header>

        <!-- Stats Grid -->
        <div class="stats-grid">
            <div class="glass-card stat-card">
                <div class="stat-icon">🖱️</div>
                <div class="stat-info">
                    <span class="stat-label">Tổng số Clicks tự động</span>
                    <span id="stat-clicks" class="stat-value">0</span>
                </div>
            </div>
            <div class="glass-card stat-card neon-bar">
                <div class="stat-icon">🖥️</div>
                <div class="stat-info">
                    <span class="stat-label">Lệnh Terminal tự duyệt</span>
                    <span id="stat-commands" class="stat-value">0</span>
                </div>
            </div>
            <div class="glass-card stat-card red-bar">
                <div class="stat-icon">🔗</div>
                <div class="stat-info">
                    <span class="stat-label">Các phiên làm việc đang kiểm soát</span>
                    <span id="stat-targets" class="stat-value">0</span>
                </div>
            </div>
        </div>

        <!-- Configuration Settings -->
        <div class="config-grid">
            <!-- Action Toggles -->
            <div class="glass-card">
                <h2 class="section-title">
                    <span class="title-icon">⚙️</span> Cấu hình hoạt động
                </h2>
                <div class="switch-list">
                    <div class="switch-item">
                        <div class="switch-details">
                            <span class="switch-title">Auto Accept</span>
                            <span class="switch-desc">Tự động nhấn các nút "Accept/Apply/Keep"</span>
                        </div>
                        <label class="switch">
                            <input type="checkbox" id="cfg-autoAccept" class="config-checkbox">
                            <span class="slider"></span>
                        </label>
                    </div>
                    <div class="switch-item">
                        <div class="switch-details">
                            <span class="switch-title">Auto Run</span>
                            <span class="switch-desc">Tự động nhấn các nút chạy lệnh Terminal</span>
                        </div>
                        <label class="switch">
                            <input type="checkbox" id="cfg-autoRun" class="config-checkbox">
                            <span class="slider"></span>
                        </label>
                    </div>
                    <div class="switch-item">
                        <div class="switch-details">
                            <span class="switch-title">Auto Allow (Permissions)</span>
                            <span class="switch-desc">Tự động nhấn "Allow/Approve/Grant"</span>
                        </div>
                        <label class="switch">
                            <input type="checkbox" id="cfg-autoAllow" class="config-checkbox">
                            <span class="slider"></span>
                        </label>
                    </div>
                    <div class="switch-item">
                        <div class="switch-details">
                            <span class="switch-title">Auto Continue</span>
                            <span class="switch-desc">Tự động nhấn nút tạo tiếp tục (Continue)</span>
                        </div>
                        <label class="switch">
                            <input type="checkbox" id="cfg-autoContinue" class="config-checkbox">
                            <span class="slider"></span>
                        </label>
                    </div>
                    <div class="switch-item">
                        <div class="switch-details">
                            <span class="switch-title">Auto Retry</span>
                            <span class="switch-desc">Tự động nhấn nút thử lại (Retry) khi Agent lỗi</span>
                        </div>
                        <label class="switch">
                            <input type="checkbox" id="cfg-autoRetry" class="config-checkbox">
                            <span class="slider"></span>
                        </label>
                    </div>
                    <div class="switch-item">
                        <div class="switch-details">
                            <span class="switch-title">Auto Submit</span>
                            <span class="switch-desc">Tự động nhấn nút gửi đi (Submit) trên IDE</span>
                        </div>
                        <label class="switch">
                            <input type="checkbox" id="cfg-autoSubmit" class="config-checkbox">
                            <span class="slider"></span>
                        </label>
                    </div>
                    <div class="switch-item">
                        <div class="switch-details">
                            <span class="switch-title">Auto Alt+Enter Shortcut</span>
                            <span class="switch-desc">Gửi phím tắt Alt+Enter khi có lệnh chờ duyệt</span>
                        </div>
                        <label class="switch">
                            <input type="checkbox" id="cfg-autoAltEnter" class="config-checkbox">
                            <span class="slider"></span>
                        </label>
                    </div>
                </div>
            </div>

            <!-- Banned Commands -->
            <div class="glass-card">
                <h2 class="section-title">
                    <span class="title-icon">🚫</span> Danh sách Lệnh cấm (Banned Commands)
                </h2>
                <div class="banned-commands-container">
                    <div class="banned-input-group">
                        <input type="text" id="banned-input" class="banned-input" placeholder="Nhập lệnh nguy hiểm cần cấm (VD: rm -rf)...">
                        <button id="banned-add-btn" class="btn-add">Thêm</button>
                    </div>
                    <div id="banned-list" class="banned-list">
                        <!-- Banned tags will be generated here -->
                    </div>
                </div>
            </div>
        </div>

        <!-- Connection Targets -->
        <div class="glass-card targets-section">
            <h2 class="section-title">
                <span class="title-icon">🌐</span> Các phiên đang hoạt động (IDE DOM Tabs)
            </h2>
            <div id="targets-list" class="targets-list">
                <div class="no-targets">Không phát hiện target hoạt động. Vui lòng kiểm tra xem Antigravity IDE đã được khởi động chưa.</div>
            </div>
        </div>

        <!-- Activity Logs Console -->
        <div class="glass-card logs-container">
            <h2 class="section-title">
                <span class="title-icon">💻</span> Nhật ký hoạt động (System Console Logs)
            </h2>
            <div id="logs-console" class="logs-console">
                <div class="log-line info">
                    <span class="log-time">[00:00:00]</span>
                    <span class="log-msg">Hệ thống đang sẵn sàng. Hãy bật Auto-Run...</span>
                </div>
            </div>
        </div>
    </div>

    <script>
        (function() {
            const vscode = acquireVsCodeApi();
            let currentConfig = null;

            // DOM Elements
            const statusBadge = document.getElementById('status-badge');
            const statusText = document.getElementById('status-text');
            const masterBtn = document.getElementById('master-btn');
            
            const statClicks = document.getElementById('stat-clicks');
            const statCommands = document.getElementById('stat-commands');
            const statTargets = document.getElementById('stat-targets');
            
            const checkboxAutoAccept = document.getElementById('cfg-autoAccept');
            const checkboxAutoRun = document.getElementById('cfg-autoRun');
            const checkboxAutoAllow = document.getElementById('cfg-autoAllow');
            const checkboxAutoContinue = document.getElementById('cfg-autoContinue');
            const checkboxAutoRetry = document.getElementById('cfg-autoRetry');
            const checkboxAutoSubmit = document.getElementById('cfg-autoSubmit');
            const checkboxAutoAltEnter = document.getElementById('cfg-autoAltEnter');

            const bannedInput = document.getElementById('banned-input');
            const bannedAddBtn = document.getElementById('banned-add-btn');
            const bannedList = document.getElementById('banned-list');
            
            const targetsListContainer = document.getElementById('targets-list');
            const logsConsole = document.getElementById('logs-console');

            // Request initial state on load
            vscode.postMessage({ command: 'requestState' });

            // Master switch click
            masterBtn.addEventListener('click', () => {
                vscode.postMessage({ command: 'toggle' });
            });

            // Handle config checkbox changes
            const configCheckboxes = document.querySelectorAll('.config-checkbox');
            configCheckboxes.forEach(cb => {
                cb.addEventListener('change', () => {
                    if (!currentConfig) return;
                    
                    const actionKey = cb.id.replace('cfg-', '');
                    const updatedActions = { ...currentConfig.autoActions };
                    updatedActions[actionKey] = cb.checked;
                    
                    vscode.postMessage({
                        command: 'updateConfig',
                        config: {
                            autoActions: updatedActions
                        }
                    });
                });
            });

            // Add banned command
            bannedAddBtn.addEventListener('click', addBannedCmd);
            bannedInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') addBannedCmd();
            });

            function addBannedCmd() {
                const val = bannedInput.value.trim();
                if (!val) return;
                if (!currentConfig) return;

                if (currentConfig.bannedCommands.includes(val)) {
                    bannedInput.value = '';
                    return;
                }

                const updatedBanned = [...currentConfig.bannedCommands, val];
                vscode.postMessage({
                    command: 'updateConfig',
                    config: {
                        bannedCommands: updatedBanned
                    }
                });
                bannedInput.value = '';
            }

            // Remove banned command
            window.removeBannedCommand = function(cmd) {
                if (!currentConfig) return;
                const updatedBanned = currentConfig.bannedCommands.filter(c => c !== cmd);
                vscode.postMessage({
                    command: 'updateConfig',
                    config: {
                        bannedCommands: updatedBanned
                    }
                });
            };

            // Listen for messages from extension
            window.addEventListener('message', event => {
                const message = event.data;
                switch (message.command) {
                    case 'updateState':
                        renderState(message.state);
                        break;
                }
            });

            // Render Dashboard View
            function renderState(state) {
                currentConfig = state.config;

                // 1. Render Status
                if (state.isEnabled) {
                    statusBadge.className = 'status-badge active';
                    statusText.textContent = 'RUNNING';
                    masterBtn.className = 'btn-toggle active-btn';
                    masterBtn.querySelector('span').textContent = 'Tắt Auto-Run';
                } else {
                    statusBadge.className = 'status-badge inactive';
                    statusText.textContent = 'STOPPED';
                    masterBtn.className = 'btn-toggle';
                    masterBtn.querySelector('span').textContent = 'Bật Auto-Run';
                }

                // 2. Render Statistics
                statClicks.textContent = state.totalClicks;
                statCommands.textContent = state.totalCommands;
                statTargets.textContent = state.targets.length;

                // 3. Render Config switches
                checkboxAutoAccept.checked = !!currentConfig.autoActions.autoAccept;
                checkboxAutoRun.checked = !!currentConfig.autoActions.autoRun;
                checkboxAutoAllow.checked = !!currentConfig.autoActions.autoAllow;
                checkboxAutoContinue.checked = !!currentConfig.autoActions.autoContinue;
                checkboxAutoRetry.checked = !!currentConfig.autoActions.autoRetry;
                checkboxAutoSubmit.checked = !!currentConfig.autoActions.autoSubmit;
                checkboxAutoAltEnter.checked = !!currentConfig.autoActions.autoAltEnter;

                // 4. Render Banned Commands
                bannedList.innerHTML = '';
                if (currentConfig.bannedCommands && currentConfig.bannedCommands.length > 0) {
                    currentConfig.bannedCommands.forEach(cmd => {
                        const tag = document.createElement('div');
                        tag.className = 'banned-tag';
                        tag.innerHTML = \`
                            <span>\${escapeHtml(cmd)}</span>
                            <span class="banned-tag-remove" onclick="removeBannedCommand('\${escapeJsString(cmd)}')">&times;</span>
                        \`;
                        bannedList.appendChild(tag);
                    });
                } else {
                    bannedList.innerHTML = '<div style="color: var(--text-muted); font-size: 13px; width: 100%; text-align: center; padding: 10px;">Chưa cấu hình lệnh cấm nào.</div>';
                }

                // 5. Render Targets
                renderTargets(state.targets);

                // 6. Render Activity Logs
                renderLogs(state.logs);
            }

            function renderTargets(targets) {
                targetsListContainer.innerHTML = '';
                if (targets && targets.length > 0) {
                    targets.forEach(t => {
                        const card = document.createElement('div');
                        card.className = 'target-card';
                        
                        let badgeClass = 'target-badge connected';
                        let badgeText = 'CONNECTED';
                        if (t.injected) {
                            badgeClass = 'target-badge injected';
                            badgeText = 'INJECTED';
                        }
                        
                        card.innerHTML = \`
                            <div class="target-header">
                                <span class="target-title" title="\${escapeHtml(t.title)}">\${escapeHtml(t.title)}</span>
                                <span class="\${badgeClass}">\${badgeText}</span>
                            </div>
                            <div class="target-details">
                                <div class="target-stat">
                                    <span>ID Target</span>
                                    <span class="val" style="font-size: 11px;">\${t.id.slice(0, 16)}...</span>
                                </div>
                                <div class="target-stat">
                                    <span>Clicks cục bộ</span>
                                    <span class="val">\${t.stats.clicks || 0}</span>
                                </div>
                                <div class="target-stat">
                                    <span>Lệnh tự duyệt</span>
                                    <span class="val">\${t.stats.terminalCommands || 0}</span>
                                </div>
                                <div class="target-stat">
                                    <span>Lệnh bị chặn</span>
                                    <span class="val" style="color: var(--color-red);">\${t.stats.blocked || 0}</span>
                                </div>
                            </div>
                        \`;
                        targetsListContainer.appendChild(card);
                    });
                } else {
                    targetsListContainer.innerHTML = '<div class="no-targets">Không phát hiện phiên hoạt động. Vui lòng khởi động lại Antigravity IDE.</div>';
                }
            }

            function renderLogs(logs) {
                logsConsole.innerHTML = '';
                if (logs && logs.length > 0) {
                    logs.forEach(log => {
                        const line = document.createElement('div');
                        line.className = 'log-line ' + (log.type || 'info');
                        line.innerHTML = \`
                            <span class="log-time">[\${escapeHtml(log.time)}]</span>
                            <span class="log-msg">\${escapeHtml(log.message)}</span>
                        \`;
                        logsConsole.appendChild(line);
                    });
                } else {
                    logsConsole.innerHTML = '<div style="color: var(--text-muted); padding: 10px;">Chưa có lịch sử nhật ký.</div>';
                }
            }

            function escapeHtml(str) {
                if (!str) return '';
                return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");
            }

            function escapeJsString(str) {
                if (!str) return '';
                return str.replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'").replace(/"/g, '\\\\"');
            }
        })();
    </script>
</body>
</html>`;
    } catch (e) {
        console.error("[Error in getWebviewContent]: Lỗi tạo giao diện HTML cho Webview. Chi tiết:", e);
        return `<html><body><h3>Lỗi khởi tạo Dashboard</h3><p>${e.message}</p></body></html>`;
    }
}

// Hàm kích hoạt Extension
function activate(context) {
    try {
        // Tự động tải cấu hình đã lưu nếu có
        try {
            const savedConfig = context.globalState.get('antigravity_autorun_config');
            if (savedConfig) {
                CONFIG = Object.assign({}, CONFIG, savedConfig);
            }
        } catch (configLoadErr) {
            console.error("[Error in activate - Load Config]: Lỗi tải cấu hình đã lưu. Chi tiết:", configLoadErr.message, configLoadErr.stack);
        }

        // Tự động vá file main.js để mở cổng CDP 9000
        patchMainJs();

        console.log(`[Auto-Run Ext] Antigravity Auto-Run Extension v${pkg.version} is activated!`);

        // Tạo StatusBar Item
        statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        statusBarItem.command = 'antigravity-auto-run.toggle';
        statusBarItem.show();
        context.subscriptions.push(statusBarItem);
        updateStatusBar(isEnabled);

        // Đăng ký command toggle (Mở trực tiếp Dashboard Webview để cấu hình bên trong IDE)
        const toggleCommand = vscode.commands.registerCommand('antigravity-auto-run.toggle', () => {
            try {
                showDashboard(context);
            } catch (cmdErr) {
                console.error("[Error in toggleCommand]: Lỗi xử lý khi chạy lệnh toggle. Chi tiết:", cmdErr.message, cmdErr.stack);
            }
        });
        context.subscriptions.push(toggleCommand);

        // Đăng ký command mở Dashboard trực tiếp
        const openDashboardCommand = vscode.commands.registerCommand('antigravity-auto-run.openDashboard', () => {
            try {
                showDashboard(context);
            } catch (err) {
                console.error("[Error in openDashboardCommand]: Lỗi khi mở Dashboard. Chi tiết:", err.message, err.stack);
            }
        });
        context.subscriptions.push(openDashboardCommand);

        // Bắt đầu vòng lặp quét target (giống auto_run.py)
        scanInterval = setInterval(() => {
            try {
                if (!isEnabled) return;
                discoverTargets().then(targets => {
                    targets.forEach(connectTarget);
                });
            } catch (err) {
                console.error("[Error in scanInterval]: Lỗi quét targets định kỳ. Chi tiết:", err.message, err.stack);
            }
        }, 2000);

        // Bắt đầu vòng lặp thu thập thống kê mỗi 3s
        statsInterval = setInterval(() => {
            try {
                queryStats();
            } catch (err) {
                console.error("[Error in statsInterval]: Lỗi lấy stats định kỳ. Chi tiết:", err.message, err.stack);
            }
        }, 3000);

        addActivityLog(`Extension Antigravity Auto-Run v${pkg.version} đã được kích hoạt!`, 'success');
        
        // Tự động kiểm tra bản cập nhật mới từ GitHub khi kích hoạt
        try {
            checkExtensionUpdate(context);
        } catch (updateErr) {
            console.error("[Error in activate - Update Check]: Lỗi gọi kiểm tra cập nhật. Chi tiết:", updateErr.message, updateErr.stack);
        }
    } catch (e) {
        console.error("[Error in activate]: Lỗi xảy ra tại hàm 'activate'. Chi tiết:", e.message, e.stack);
    }
}

// Hàm hủy kích hoạt Extension
function deactivate() {
    try {
        console.log('[Auto-Run Ext] Deactivating extension...');
        if (scanInterval) clearInterval(scanInterval);
        if (statsInterval) clearInterval(statsInterval);
        
        for (const conn of connections.values()) {
            try {
                conn.evaluate('if(window.__autoAcceptStop) window.__autoAcceptStop()');
                conn.ws.close();
            } catch (e) {}
        }
        connections.clear();

        if (dashboardPanel) {
            dashboardPanel.dispose();
            dashboardPanel = null;
        }
    } catch (e) {
        console.error("[Error in deactivate]: Lỗi xảy ra tại hàm 'deactivate'. Chi tiết:", e.message, e.stack);
    }
}

// Tự động kiểm tra bản cập nhật mới của Extension từ GitHub Releases
function checkExtensionUpdate(context) {
    try {
        const https = require('https');
        const cp = require('child_process');
        
        const repo = 'mindeskvn/AutoRun_mindesk';
        const options = {
            hostname: 'api.github.com',
            path: `/repos/${repo}/releases/latest`,
            headers: {
                'User-Agent': 'Antigravity-AutoRun-Extension-Updater'
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
                        console.error(`[Error in checkExtensionUpdate - API]: GitHub API trả về status code ${res.statusCode}`);
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
                        const vsixAsset = release.assets.find(asset => asset.name.endsWith('.vsix'));
                        if (!vsixAsset) {
                            console.log(`[Auto-Run Ext Update] Phát hiện phiên bản mới v${latestVersion} nhưng không tìm thấy file .vsix trong release assets.`);
                            return;
                        }
                        
                        const downloadUrl = vsixAsset.browser_download_url;
                        
                        vscode.window.showInformationMessage(
                            `Có bản cập nhật mới v${latestVersion} cho Antigravity Auto-Run Extension. Bạn có muốn cập nhật tự động không?`,
                            'Cập nhật ngay',
                            'Bỏ qua'
                        ).then(choice => {
                            if (choice === 'Cập nhật ngay') {
                                downloadAndInstallVsix(downloadUrl, latestVersion);
                            }
                        });
                    }
                } catch (err) {
                    console.error("[Error in checkExtensionUpdate - Parse]: Lỗi xử lý JSON từ API. Chi tiết:", err.message, err.stack);
                }
            });
        }).on('error', (err) => {
            console.error("[Error in checkExtensionUpdate - Network]: Lỗi kết nối GitHub API. Chi tiết:", err.message, err.stack);
        });
    } catch (e) {
        console.error("[Error in checkExtensionUpdate]: Lỗi kiểm tra cập nhật. Chi tiết:", e.message, e.stack);
    }
}

// Tải xuống file .vsix và tự cài đặt đè
function downloadAndInstallVsix(downloadUrl, version) {
    vscode.window.withProgress({
        location: vscode.ProgressLocation.Notification,
        title: `Đang tải và cập nhật Extension v${version}...`,
        cancellable: false
    }, (progress) => {
        return new Promise((resolve, reject) => {
            try {
                const https = require('https');
                const fs = require('fs');
                const path = require('path');
                const os = require('os');
                const cp = require('child_process');
                const url = require('url');

                const tempVsixPath = path.join(os.tmpdir(), `antigravity-auto-run-ext-${version}.vsix`);
                const fileStream = fs.createWriteStream(tempVsixPath);

                const download = (fileUrl) => {
                    const parsedUrl = url.parse(fileUrl);
                    const options = {
                        hostname: parsedUrl.hostname,
                        path: parsedUrl.path,
                        headers: {
                            'User-Agent': 'Antigravity-AutoRun-Extension-Updater'
                        }
                    };

                    https.get(options, (response) => {
                        if (response.statusCode === 301 || response.statusCode === 302) {
                            download(response.headers.location);
                            return;
                        }

                        if (response.statusCode !== 200) {
                            fileStream.close();
                            reject(new Error(`Tải xuống thất bại: Status code ${response.statusCode}`));
                            return;
                        }

                        response.pipe(fileStream);

                        fileStream.on('finish', () => {
                            fileStream.close();
                            
                            progress.report({ message: 'Đang cài đặt file .vsix...' });
                            
                            const cmd = `"${process.execPath}" --install-extension "${tempVsixPath}"`;
                            cp.exec(cmd, (err, stdout, stderr) => {
                                if (err) {
                                    console.error('[Error in downloadAndInstallVsix - CLI]: Lỗi cài đặt qua CLI. Chi tiết:', err.message, err.stack);
                                    vscode.commands.executeCommand('workbench.extensions.action.installVSIX', [vscode.Uri.file(tempVsixPath)])
                                        .then(() => {
                                            vscode.window.showInformationMessage('Đang mở hộp thoại cài đặt. Vui lòng chọn tệp .vsix vừa tải để hoàn thành.');
                                            resolve();
                                        }, (cmdErr) => {
                                            reject(cmdErr);
                                        });
                                } else {
                                    vscode.window.showInformationMessage('Cập nhật Extension thành công! Vui lòng reload cửa sổ để áp dụng.', 'Reload').then(choice => {
                                        if (choice === 'Reload') {
                                            vscode.commands.executeCommand('workbench.action.reloadWindow');
                                        }
                                    });
                                    resolve();
                                }
                                
                                try {
                                    if (fs.existsSync(tempVsixPath)) {
                                        fs.unlinkSync(tempVsixPath);
                                    }
                                } catch (e) {}
                            });
                        });
                    }).on('error', (err) => {
                        fileStream.close();
                        reject(err);
                    });
                };

                download(downloadUrl);

            } catch (e) {
                reject(e);
            }
        }).catch(err => {
            vscode.window.showErrorMessage(`Cập nhật thất bại: ${err.message}`);
            console.error('[Error in downloadAndInstallVsix]: Lỗi tải và cài đặt cập nhật. Chi tiết:', err.message, err.stack);
        });
    });
}

module.exports = {
    activate,
    deactivate
};
