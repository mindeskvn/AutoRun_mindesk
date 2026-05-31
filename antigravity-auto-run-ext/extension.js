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

// Cấu hình hoạt động của Auto-Run
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
        autoAltEnter: true
    }
};

// Script MutationObserver chạy trực tiếp trong DOM của IDE (Webview / Tab)
const AUTO_ACCEPT_SCRIPT = `
(function() {
    'use strict';
    if (typeof window === 'undefined') return;
    if (window.__autoAcceptFreeLoaded && window.__autoAcceptVersion === 'v2.5') return;
    if (window.__autoAcceptStop) { try { window.__autoAcceptStop(); } catch(e){} }
    window.__autoAcceptFreeLoaded = true;
    window.__autoAcceptVersion = 'v2.5';

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
        autoActions: { autoRun: true, autoAccept: true, autoAllow: true, autoContinue: true, autoAltEnter: true } };

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
            if (reason !== 'run-prompt' && reason !== 'permission' && isExcludedControl(el)) return false;
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

// Tự động kiểm tra và vá file main.js của Antigravity IDE để tự động mở cổng CDP 9000
function patchMainJs() {
    try {
        const localAppData = process.env.LOCALAPPDATA;
        if (!localAppData) {
            console.error("[Error in patchMainJs]: Khong tim thay bien moi truong LOCALAPPDATA");
            return;
        }
        
        const mainJsPath = path.join(localAppData, 'Programs', 'Antigravity IDE', 'resources', 'app', 'out', 'main.js');
        
        if (!fs.existsSync(mainJsPath)) {
            console.log(`[Auto-Run Ext] File main.js cua IDE khong ton tai tai: ${mainJsPath} (Co the dang chay trong moi truong development)`);
            return;
        }

        let content = fs.readFileSync(mainJsPath, 'utf8');
        const marker = '/*__autoRunBuiltinRemoteDebug9000*/';
        
        if (content.includes(marker)) {
            console.log("[Auto-Run Ext] File main.js cua IDE da duoc va truoc do, khong can va lai.");
            return;
        }

        console.log("[Auto-Run Ext] Dang tien hanh va file main.js de mo cong CDP 9000...");
        
        // Đoạn code vá sử dụng ES Module import electron
        const patchCode = `${marker}import { app } from 'electron'; if (app) { app.commandLine.appendSwitch('remote-debugging-port', '9000'); }\n`;
        const newContent = patchCode + content;

        fs.writeFileSync(mainJsPath, newContent, 'utf8');
        console.log("[Auto-Run Ext] Va file main.js thanh cong!");
        
        vscode.window.showInformationMessage('⚡ Đã tự động cấu hình cổng CDP 9000 cho Antigravity IDE. Vui lòng khởi động lại IDE để tính năng Auto-Run hoạt động!');
    } catch (e) {
        console.error("[Error in patchMainJs]: Khong the va file main.js cua IDE. Chi tiet:", e.message, e.stack);
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
            console.log(`[Auto-Run Ext] Connection closed for: ${target.title}`);
            connections.delete(id);
            pendingEvaluates.clear();
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
                    }
                }
            } catch (e) {
                console.error(`[Error in queryStats (loop)]: Lỗi lấy stats từ target ${conn.title}. Chi tiết:`, e);
            }
        }

        totalClicks = clicks;
        totalCommands = commands;
        updateStatusBar(true);
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
            statusBarItem.tooltip = `Antigravity Auto-Run: Đang hoạt động\n- Clicks: ${totalClicks}\n- Commands: ${totalCommands}\n- Targets: ${connections.size}\n\nClick để TẮT`;
        } else {
            statusBarItem.text = `$(circle-slash) Auto-Run: OFF`;
            statusBarItem.backgroundColor = undefined;
            statusBarItem.color = new vscode.ThemeColor('statusBarItem.prominentForeground');
            statusBarItem.tooltip = `Antigravity Auto-Run: Đã tắt\n\nClick để BẬT`;
        }
    } catch (e) {
        console.error("[Error in updateStatusBar]: Lỗi xảy ra tại hàm 'updateStatusBar'. Chi tiết:", e);
    }
}

// Hàm kích hoạt Extension
function activate(context) {
    try {
        // Tự động vá file main.js để mở cổng CDP 9000
        patchMainJs();

        console.log(`[Auto-Run Ext] Antigravity Auto-Run Extension v${pkg.version} is activated!`);

        // Tạo StatusBar Item
        statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
        statusBarItem.command = 'antigravity-auto-run.toggle';
        statusBarItem.show();
        context.subscriptions.push(statusBarItem);
        updateStatusBar(isEnabled);

        // Đăng ký command toggle
        const toggleCommand = vscode.commands.registerCommand('antigravity-auto-run.toggle', () => {
            try {
                isEnabled = !isEnabled;
                updateStatusBar(isEnabled);
                
                if (isEnabled) {
                    vscode.window.showInformationMessage('⚡ Antigravity Auto-Run đã BẬT!');
                    // Quét và kích hoạt lại ngay lập tức
                    discoverTargets().then(targets => {
                        targets.forEach(connectTarget);
                    });
                } else {
                    vscode.window.showInformationMessage('🚫 Antigravity Auto-Run đã TẮT!');
                    // Gửi stop tới tất cả targets
                    for (const conn of connections.values()) {
                        conn.evaluate('if(window.__autoAcceptStop) window.__autoAcceptStop()');
                    }
                }
            } catch (cmdErr) {
                console.error("[Error in toggleCommand]: Lỗi khi chạy lệnh toggle. Chi tiết:", cmdErr);
            }
        });
        context.subscriptions.push(toggleCommand);

        // Bắt đầu vòng lặp quét target (giống auto_run.py)
        scanInterval = setInterval(() => {
            try {
                if (!isEnabled) return;
                discoverTargets().then(targets => {
                    targets.forEach(connectTarget);
                });
            } catch (err) {
                console.error("[Error in scanInterval]: Lỗi quét targets định kỳ. Chi tiết:", err);
            }
        }, 2000);

        // Bắt đầu vòng lặp thu thập thống kê mỗi 3s
        statsInterval = setInterval(() => {
            try {
                queryStats();
            } catch (err) {
                console.error("[Error in statsInterval]: Lỗi lấy stats định kỳ. Chi tiết:", err);
            }
        }, 3000);

    } catch (e) {
        console.error("[Error in activate]: Lỗi xảy ra tại hàm 'activate'. Chi tiết:", e);
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
    } catch (e) {
        console.error("[Error in deactivate]: Lỗi xảy ra tại hàm 'deactivate'. Chi tiết:", e);
    }
}

module.exports = {
    activate,
    deactivate
};
