// ==UserScript==
// @name         Ozon Sessions Dock
// @namespace    http://tampermonkey.net/
// @version      2.6
// @description  Переработанный док сессий клиентов.
// @author       desslow
// @match        https://*.ozon.ru/orders*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const COLUMN_WIDTH = 205;
    const sessionsMap = new Map();
    let visitedSessionHistory = [];
    let lastRenderedHash = '';
    let lastZeroWatchdogTime = 0;
    let scanBuffer = '';
    let lastKeyTime = Date.now();
    let isAutoRedirecting = false;
    window._ozonAuthHeaders = null;

    function isAutoSwitchEnabled() {
        return localStorage.getItem('smart_auto_switch_enabled') !== 'false';
    }

    function toggleAutoSwitch() {
        const nextState = !isAutoSwitchEnabled();
        localStorage.setItem('smart_auto_switch_enabled', String(nextState));
        renderDock(true);
    }

    function getMyOperatorLogin() {
        const myLoginEl = document.querySelector('[class*="_rightAvatarMenuLogin_"]');
        return myLoginEl ? myLoginEl.textContent.trim().replace('PVZ_', '') : '';
    }

    function isMySession(s) {
        if (!s) return false;
        const myLogin = getMyOperatorLogin();
        return Boolean(myLogin && s.operator && (s.operator === myLogin || s.operator.includes(myLogin)));
    }

    function recordSessionVisit(sessionId) {
        if (!sessionId) return;
        const sId = String(sessionId);
        visitedSessionHistory = visitedSessionHistory.filter(id => id !== sId);
        visitedSessionHistory.push(sId);
    }

    function getTargetPreviousSessionId(closedSessionId) {
        if (!isAutoSwitchEnabled()) return null;

        const closedIdStr = String(closedSessionId || '');

        const parentId = sessionStorage.getItem('parent_of_' + closedIdStr);
        sessionStorage.removeItem('parent_of_' + closedIdStr);

        if (parentId && parentId !== closedIdStr) {
            const parentSession = sessionsMap.get(Number(parentId)) || sessionsMap.get(String(parentId));
            if (parentSession && isMySession(parentSession)) {
                return parentId;
            }
        }

        const myActiveRemaining = Array.from(sessionsMap.values()).filter(s => String(s.id) !== closedIdStr && isMySession(s));

        if (myActiveRemaining.length === 0) return null;

        for (let i = visitedSessionHistory.length - 1; i >= 0; i--) {
            const histId = visitedSessionHistory[i];
            if (histId !== closedIdStr && myActiveRemaining.some(s => String(s.id) === histId)) {
                return histId;
            }
        }

        return myActiveRemaining[myActiveRemaining.length - 1].id;
    }

    function checkPostCompletionRedirect() {
        if (isAutoRedirecting) return;
        const currentPath = window.location.pathname;

        if (currentPath.startsWith('/orders/session')) {
            const curId = (currentPath.match(/\/orders\/session(?:-new)?\/(\d+)/) || [])[1];
            if (curId) {
                sessionStorage.setItem('active_session_tracker', curId);
                sessionStorage.removeItem('manual_back_navigation');
                recordSessionVisit(curId);
            }
        } else if (currentPath === '/orders') {
            const lastSessionId = sessionStorage.getItem('active_session_tracker');
            const manualBack = sessionStorage.getItem('manual_back_navigation');

            if (lastSessionId && !manualBack) {
                isAutoRedirecting = true;
                sessionStorage.removeItem('active_session_tracker');

                setTimeout(() => {
                    sessionsMap.delete(Number(lastSessionId));
                    sessionsMap.delete(String(lastSessionId));

                    const nextTargetId = getTargetPreviousSessionId(lastSessionId);
                    if (nextTargetId) {
                        navigateSpa(`/orders/session-new/${nextTargetId}`);
                    }
                    setTimeout(() => { isAutoRedirecting = false; }, 300);
                }, 100);
            }
        }
    }

    function getExactSessionTimestamp(sessionId, rawFoundAt) {
        const sharedKey = `ozon_found_at_${sessionId}`;
        let saved = localStorage.getItem(sharedKey);
        if (saved) {
            const p = parseInt(saved, 10);
            if (!isNaN(p) && p > 1000000000000) return p;
        }

        if (rawFoundAt) {
            const parsed = new Date(rawFoundAt).getTime();
            if (!isNaN(parsed) && parsed > 1000000000000) {
                const finalTs = (parsed > Date.now()) ? Date.now() : parsed;
                localStorage.setItem(sharedKey, String(finalTs));
                return finalTs;
            }
        }

        const now = Date.now();
        localStorage.setItem(sharedKey, String(now));
        return now;
    }

    function updateSidebarGeometry() {
        const sidebar = document.querySelector('ul[class*="_menu_"]')?.parentElement || document.querySelector('ul[class*="_menu_"]');
        const header = document.querySelector('[class*="_header_"]');

        if (sidebar) {
            const w = Math.round(sidebar.getBoundingClientRect().width);
            if (w > 0) document.documentElement.style.setProperty('--sidebar-width', `${w}px`);
        }
        if (header) {
            const h = Math.round(header.getBoundingClientRect().height);
            if (h > 0) document.documentElement.style.setProperty('--header-height', `${h}px`);
        }
    }

    function attachResizeObserver() {
        const sidebar = document.querySelector('ul[class*="_menu_"]')?.parentElement;
        if (sidebar && !sidebar._hasSmartObserver) {
            sidebar._hasSmartObserver = true;
            const ro = new ResizeObserver(() => updateSidebarGeometry());
            ro.observe(sidebar);
        }
    }

    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;
    const origSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

    XMLHttpRequest.prototype.open = function(method, url) {
        this._sUrl = typeof url === 'string' ? url : '';
        this._sHeaders = {};
        return origOpen.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
        if (this._sHeaders) this._sHeaders[name.toLowerCase()] = value;
        return origSetRequestHeader.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function() {
        if (this._sHeaders && this._sHeaders['authorization']) {
            window._ozonAuthHeaders = {
                'authorization': this._sHeaders['authorization'],
                'x-o3-app-name': this._sHeaders['x-o3-app-name'] || 'turbo-pvz-ui',
                'x-o3-app-version': this._sHeaders['x-o3-app-version'] || '',
                'x-o3-version-name': this._sHeaders['x-o3-version-name'] || ''
            };
        }

        const requestBody = arguments[0];
        this.addEventListener('load', function() {
            try {
                if (this._sUrl.includes('/api2/giveout/Sessions/close')) {
                    let closedId = null;
                    if (typeof requestBody === 'string') {
                        try { closedId = JSON.parse(requestBody).sessionId; } catch (e) {}
                    }
                    if (closedId) handleNativeCloseRedirect(closedId);
                }

                if (this._sUrl.includes('/api2/giveout/Sessions') && !this._sUrl.includes('/close')) {
                    const data = JSON.parse(this.responseText);
                    updateSessionsData(data);
                }
            } catch (e) {}
        });
        return origSend.apply(this, arguments);
    };

    function handleNativeCloseRedirect(closedId) {
        const currentOpenId = (window.location.pathname.match(/\/orders\/session(?:-new)?\/(\d+)/) || [])[1];
        if (currentOpenId && String(currentOpenId) === String(closedId)) {
            sessionsMap.delete(Number(closedId));
            sessionsMap.delete(String(closedId));
            const prevId = getTargetPreviousSessionId(closedId);
            if (prevId) {
                navigateSpa(`/orders/session-new/${prevId}`);
            } else {
                navigateSpa('/orders');
            }
        }
    }

    async function syncSessionsBackground() {
        if (!window._ozonAuthHeaders) return;
        try {
            const res = await fetch('https://turbo-pvz.ozon.ru/api2/giveout/Sessions?filterByCurrentUser=false', {
                headers: window._ozonAuthHeaders,
                credentials: 'same-origin'
            });
            if (res.ok) {
                const data = await res.json();
                updateSessionsData(data);
            }
        } catch (e) {}
    }

    function triggerZeroWatchdog() {
        const now = Date.now();
        if (now - lastZeroWatchdogTime > 3000) {
            lastZeroWatchdogTime = now;
            syncSessionsBackground();
        }
    }

    function updateSessionsData(data) {
        if (!data || !Array.isArray(data.sessions)) return;

        const activeIds = new Set(data.sessions.map(s => s.sessionId));
        for (let k of sessionsMap.keys()) {
            if (!activeIds.has(k)) {
                sessionsMap.delete(k);
                localStorage.removeItem(`ozon_found_at_${k}`);
                localStorage.removeItem(`ozon_session_timer_${k}`);
            }
        }

        data.sessions.forEach(s => {
            const existing = sessionsMap.get(s.sessionId);
            const ts = getExactSessionTimestamp(s.sessionId, s.foundAt);

            const specFlags = {
                passport: s.hasCheckPassport === true,
                jewelry: s.hasJewelry === true,
                atm: s.isAtmPayment === true,
                bank: s.hasOzonBankProduct === true,
                global: s.hasGlobal === true,
                tips: s.tipsEnabled === true,
                legal: s.hasLegal === true
            };

            if (!existing) {
                sessionsMap.set(s.sessionId, {
                    id: s.sessionId,
                    name: s.clientShortName,
                    foundAt: ts,
                    allPrepaid: s.allPrepaid === true,
                    operator: (s.userName || '').replace('PVZ_', ''),
                    shelves: '',
                    itemsCount: 0,
                    flags: specFlags
                });
                fetchSessionDetails(s.sessionId);
            } else {
                existing.foundAt = ts;
                existing.allPrepaid = s.allPrepaid === true;
                existing.operator = (s.userName || '').replace('PVZ_', '');
                existing.flags = specFlags;
            }
        });

        renderDock();
    }

    async function fetchSessionDetails(sessionId) {
        if (!window._ozonAuthHeaders) return;
        try {
            const res = await fetch(`https://turbo-pvz.ozon.ru/api2/giveout/Postings?sessionId=${sessionId}&imageSize=800`, {
                headers: window._ozonAuthHeaders,
                credentials: 'same-origin'
            });
            if (res.ok) {
                const data = await res.json();
                const cached = sessionsMap.get(sessionId);
                if (cached && data) {
                    const readyPostings = Array.isArray(data.postings) 
                        ? data.postings.filter(p => p.pvzState && p.pvzState.toLowerCase() === 'readytogiveout') 
                        : [];
                    cached.itemsCount = readyPostings.length;
                    cached.shelves = data.postingsShelves ? data.postingsShelves.join(', ') : '';
                    renderDock(true);
                }
            }
        } catch (e) {}
    }

    async function closeSessionApi(sessionId, cardElement) {
        if (!window._ozonAuthHeaders) return;
        if (cardElement) {
            cardElement.classList.add('closing');
        }

        try {
            const headers = { 'Content-Type': 'application/json' };
            Object.assign(headers, window._ozonAuthHeaders);

            const res = await fetch('https://turbo-pvz.ozon.ru/api2/giveout/Sessions/close', {
                method: 'POST',
                headers: headers,
                body: JSON.stringify({ sessionId: Number(sessionId) }),
                credentials: 'same-origin'
            });

            if (res.ok) {
                setTimeout(() => {
                    sessionsMap.delete(Number(sessionId));
                    sessionsMap.delete(String(sessionId));
                    localStorage.removeItem(`ozon_found_at_${sessionId}`);
                    localStorage.removeItem(`ozon_session_timer_${sessionId}`);

                    const currentOpenSessionId = (window.location.pathname.match(/\/orders\/session(?:-new)?\/(\d+)/) || [])[1];
                    if (currentOpenSessionId && String(currentOpenSessionId) === String(sessionId)) {
                        const prevId = getTargetPreviousSessionId(sessionId);
                        if (prevId) {
                            navigateSpa(`/orders/session-new/${prevId}`);
                        } else {
                            navigateSpa('/orders');
                        }
                    } else {
                        renderDock(true);
                    }
                }, 240);
            } else {
                if (cardElement) cardElement.classList.remove('closing');
            }
        } catch (e) {
            if (cardElement) cardElement.classList.remove('closing');
        }
    }

    function navigateSpa(url) {
        try {
            const app = document.querySelector('#__nuxt')?.__vue_app__ || document.querySelector('[data-v-app]')?.__vue_app__;
            const router = app?.config?.globalProperties?.$router;
            if (router) {
                router.push(url);
                setTimeout(syncActiveCardInstant, 50);
                return;
            }
        } catch (e) {}

        try {
            const nApp = window.useNuxtApp ? window.useNuxtApp() : (window.__nuxt_app__ || window.$nuxt);
            if (nApp?.vueApp?.config?.globalProperties?.$router) {
                nApp.vueApp.config.globalProperties.$router.push(url);
                setTimeout(syncActiveCardInstant, 50);
                return;
            }
            if (window.$nuxt?.$router) {
                window.$nuxt.$router.push(url);
                setTimeout(syncActiveCardInstant, 50);
                return;
            }
        } catch (e) {}

        try {
            window.history.pushState({}, '', url);
            window.dispatchEvent(new PopStateEvent('popstate'));
            setTimeout(syncActiveCardInstant, 50);
        } catch (e) {}

        setTimeout(() => {
            if (!window.location.pathname.includes(url.replace('/orders/session-new/', ''))) {
                window.location.href = url;
            }
        }, 120);
    }

    function checkAndProcessPendingScan() {
        const pendingBarcode = sessionStorage.getItem('pending_client_scan');
        if (!pendingBarcode) return;

        const input = document.querySelector('[data-testid="searchInput"]');
        const btn = document.querySelector('[data-testid="searchButton"]');

        if (input && btn) {
            sessionStorage.removeItem('pending_client_scan');
            input.value = pendingBarcode;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            setTimeout(() => {
                btn.click();
            }, 80);
        }
    }

    function syncActiveCardInstant() {
        const path = window.location.pathname;
        const currentId = (path.match(/\/orders\/session(?:-new)?\/(\d+)/) || [])[1];
        if (currentId) {
            recordSessionVisit(currentId);

            const pendingParent = sessionStorage.getItem('pending_parent_session');
            if (pendingParent && pendingParent !== currentId) {
                sessionStorage.setItem('parent_of_' + currentId, pendingParent);
                sessionStorage.removeItem('pending_parent_session');
            }
        }

        const domClientName = (document.querySelector('._clientName_sq209_35, [class*="_clientName_"]')?.textContent || '').trim().toLowerCase();

        document.querySelectorAll('.apple-session-card').forEach(card => {
            const sId = card.dataset.sessionId;
            const cardName = (card.querySelector('.apple-client-name')?.textContent || '').trim().toLowerCase();

            let isActive = false;
            if (currentId && sId && String(currentId) === String(sId)) {
                isActive = true;
            } else if (domClientName && cardName && (domClientName.includes(cardName) || cardName.includes(domClientName))) {
                isActive = true;
            }

            card.classList.toggle('active-session', isActive);
        });
    }

    const style = document.createElement('style');
    style.innerHTML = `
        :root {
            --sidebar-width: 80px;
            --header-height: 60px;
        }

        ._sessions_1b089_1 { display: none !important; }

        #apple-sessions-column {
            position: fixed !important;
            left: var(--sidebar-width, 80px) !important;
            top: var(--header-height, 60px) !important;
            height: calc(100vh - var(--header-height, 60px)) !important;
            width: ${COLUMN_WIDTH}px !important;
            background: #203148 !important;
            border-right: 1px solid #2b4260 !important;
            box-shadow: 4px 0 14px rgba(0, 0, 0, 0.25) !important;
            display: flex !important;
            flex-direction: column !important;
            gap: 6px !important;
            padding: 10px 8px !important;
            box-sizing: border-box !important;
            overflow-y: auto !important;
            overscroll-behavior: contain !important;
            z-index: 7000 !important;
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", sans-serif !important;
            transition: left 0.2s cubic-bezier(0.16, 1, 0.3, 1), transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), opacity 0.25s ease !important;
            transform: translateX(0);
            opacity: 1;
        }

        #apple-sessions-column.dock-hidden {
            transform: translateX(-100%) !important;
            opacity: 0 !important;
            pointer-events: none !important;
        }

        #apple-sessions-column::-webkit-scrollbar {
            width: 3px !important;
            display: block !important;
        }
        #apple-sessions-column::-webkit-scrollbar-track {
            background: transparent !important;
        }
        #apple-sessions-column::-webkit-scrollbar-thumb {
            background: rgba(255, 255, 255, 0.16) !important;
            border-radius: 10px !important;
        }

        body.has-apple-column ._content_jbnnr_28 {
            margin-left: ${COLUMN_WIDTH}px !important;
            transition: margin-left 0.2s ease !important;
        }

        .apple-col-header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            padding: 2px 6px 8px 6px;
            font-size: 11px;
            font-weight: 600;
            color: rgba(235, 235, 245, 0.5);
            letter-spacing: 0.2px;
            border-bottom: 1px solid #2b4260;
            margin-bottom: 2px;
        }

        .apple-header-right {
            display: flex;
            align-items: center;
            gap: 6px;
        }

        .apple-toggle-btn {
            font-size: 9px;
            font-weight: 700;
            padding: 1px 5px;
            border-radius: 4px;
            cursor: pointer;
            transition: all 0.15s ease;
            user-select: none;
        }
        .apple-toggle-btn.on {
            color: #38bdf8;
            background: rgba(56, 189, 248, 0.15);
            border: 1px solid rgba(56, 189, 248, 0.3);
        }
        .apple-toggle-btn.off {
            color: rgba(235, 235, 245, 0.4);
            background: rgba(255, 255, 255, 0.05);
            border: 1px solid rgba(255, 255, 255, 0.1);
        }

        .apple-col-badge {
            background: rgba(255, 255, 255, 0.1);
            color: rgba(235, 235, 245, 0.85);
            padding: 1px 6px;
            border-radius: 10px;
            font-size: 10px;
            font-weight: 600;
        }

        #apple-sessions-column:hover .apple-session-card {
            opacity: 0.45 !important;
        }

        @keyframes cardAppear {
            0% {
                opacity: 0;
                transform: translateY(-8px) scale(0.96);
            }
            100% {
                opacity: 1;
                transform: translateY(0) scale(1);
            }
        }

        .apple-session-card {
            background: #172435 !important;
            border: 1px solid #2b4260 !important;
            box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, 0.05) !important;
            border-radius: 10px !important;
            padding: 8px 9px !important;
            display: flex !important;
            flex-direction: column !important;
            gap: 4px !important;
            cursor: pointer !important;
            user-select: none !important;
            box-sizing: border-box !important;
            transition: opacity 0.2s ease, background 0.15s ease, border-color 0.15s ease, transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), max-height 0.24s ease, margin 0.24s ease, padding 0.24s ease !important;
            position: relative !important;
            flex-shrink: 0 !important;
            animation: cardAppear 0.24s cubic-bezier(0.16, 1, 0.3, 1) forwards !important;
            max-height: 160px;
            overflow: hidden !important;
            opacity: 0.6;
        }

        .apple-session-card.mine {
            background: #1b293d !important;
            border-color: #354f73 !important;
            opacity: 1 !important;
        }

        .apple-session-card.active-session {
            background: #1c3557 !important;
            border: 1px solid #007aff !important;
            box-shadow: 0 0 16px rgba(0, 122, 255, 0.4), inset 3px 0 0 0 #007aff !important;
            opacity: 1 !important;
        }

        .apple-session-card.active-session .apple-client-name {
            color: #38bdf8 !important;
        }

        .apple-session-card.closing {
            opacity: 0 !important;
            transform: scale(0.9) translateY(-6px) !important;
            max-height: 0 !important;
            padding-top: 0 !important;
            padding-bottom: 0 !important;
            margin-top: -3px !important;
            margin-bottom: -3px !important;
            border-color: transparent !important;
            pointer-events: none !important;
            overflow: hidden !important;
        }

        #apple-sessions-column .apple-session-card:hover {
            opacity: 1 !important;
            background: #22344d !important;
            border-color: rgba(255, 255, 255, 0.22) !important;
        }

        .apple-row-top {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 4px;
            width: 100%;
            overflow: hidden;
        }

        .apple-name-group {
            display: flex;
            align-items: center;
            gap: 4px;
            max-width: 110px;
            overflow: hidden;
            flex-shrink: 1;
        }

        .apple-index-pill {
            font-size: 9px;
            font-weight: 700;
            color: rgba(235, 235, 245, 0.5);
            background: rgba(255, 255, 255, 0.08);
            padding: 1px 3px;
            border-radius: 4px;
            font-family: monospace;
            flex-shrink: 0;
            line-height: 1;
        }

        .apple-client-name {
            font-size: 13px;
            font-weight: 600;
            color: #ffffff;
            letter-spacing: -0.2px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
        }

        .apple-top-right {
            position: relative !important;
            display: flex !important;
            align-items: center !important;
            justify-content: flex-end !important;
            flex-shrink: 0;
        }

        .apple-timer {
            font-size: 11px !important;
            font-weight: 500 !important;
            color: rgba(235, 235, 245, 0.6) !important;
            font-variant-numeric: tabular-nums !important;
            white-space: nowrap !important;
            transition: transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), color 0.2s ease !important;
        }

        .apple-session-card:hover .apple-timer {
            transform: translateX(-18px) !important;
            color: rgba(235, 235, 245, 0.4) !important;
        }

        .apple-close-btn {
            position: absolute !important;
            right: 0 !important;
            top: 50% !important;
            transform: translateY(-50%) scale(0.8) !important;
            opacity: 0 !important;
            pointer-events: none !important;
            color: rgba(235, 235, 245, 0.4) !important;
            width: 15px !important;
            height: 15px !important;
            border-radius: 50% !important;
            display: flex !important;
            align-items: center !important;
            justify-content: center !important;
            font-size: 9px !important;
            line-height: 1 !important;
            transition: opacity 0.2s ease, transform 0.2s cubic-bezier(0.16, 1, 0.3, 1), background 0.15s, color 0.15s !important;
        }

        .apple-session-card:hover .apple-close-btn {
            opacity: 1 !important;
            pointer-events: auto !important;
            transform: translateY(-50%) scale(1) !important;
        }

        .apple-close-btn:hover {
            color: #ff453a !important;
            background: rgba(255, 69, 58, 0.25) !important;
        }

        .apple-row-mid {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 4px;
            width: 100%;
        }

        .apple-shelves-wrap {
            display: flex;
            align-items: center;
            gap: 3px;
            flex-wrap: wrap;
            max-width: 135px;
            overflow: hidden;
        }

        .apple-shelf-pill {
            font-size: 10px;
            font-weight: 700;
            padding: 1px 4px;
            border-radius: 4px;
            white-space: nowrap;
            letter-spacing: -0.1px;
            line-height: 1.1;
        }
        .pill-regular {
            color: #38bdf8;
            background: rgba(56, 189, 248, 0.12);
            border: 1px solid rgba(56, 189, 248, 0.25);
        }
        .pill-kgt {
            color: #fbbf24;
            background: rgba(245, 158, 11, 0.16);
            border: 1px solid rgba(245, 158, 11, 0.35);
        }

        .apple-items-count {
            font-size: 11px;
            color: rgba(235, 235, 245, 0.5);
            white-space: nowrap;
            flex-shrink: 0;
        }

        .apple-tags-row {
            display: flex;
            align-items: center;
            gap: 3px;
            flex-wrap: wrap;
            width: 100%;
        }

        .apple-row-bottom {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-top: 1px;
            width: 100%;
            gap: 4px;
        }

        .apple-tag {
            font-size: 10px;
            font-weight: 600;
            padding: 1px 4px;
            border-radius: 4px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            line-height: 1.2;
        }
        .tag-unpaid { color: #ff453a; background: rgba(255, 69, 58, 0.12); flex-shrink: 0; }
        .tag-paid { color: #30d158; background: rgba(48, 209, 88, 0.12); flex-shrink: 0; }
        .tag-you { color: #0a84ff; background: rgba(10, 132, 255, 0.14); font-weight: 700; flex-shrink: 0; }
        .tag-colleague { color: rgba(235, 235, 245, 0.45); max-width: 80px; }
        .tag-spec { color: #f59e0b; background: rgba(245, 158, 11, 0.14); border: 1px solid rgba(245, 158, 11, 0.25); }
    `;
    document.head.appendChild(style);

    function buildShelfPillsHtml(shelvesStr) {
        if (!shelvesStr) return `<span class="apple-shelf-pill pill-regular">...</span>`;
        const clean = shelvesStr.replace(/Яч\.?\s*/gi, '').trim();
        const parts = clean.split(',').map(s => s.trim()).filter(Boolean);

        return parts.map(shelf => {
            const isKgt = shelf.toUpperCase().includes('КГТ');
            return `<span class="apple-shelf-pill ${isKgt ? 'pill-kgt' : 'pill-regular'}">${shelf}</span>`;
        }).join('');
    }

    function buildSpecialFlagsHtml(flags) {
        if (!flags) return '';
        let badges = [];
        if (flags.passport) badges.push('<span class="apple-tag tag-spec">🪪 Паспорт</span>');
        if (flags.jewelry) badges.push('<span class="apple-tag tag-spec">💎 Ювелирка</span>');
        if (flags.tips) badges.push('<span class="apple-tag tag-spec">☕ Чаевые</span>');
        if (flags.atm) badges.push('<span class="apple-tag tag-spec">🏧 Банкомат</span>');
        if (flags.bank) badges.push('<span class="apple-tag tag-spec">💳 Ozon Банк</span>');
        if (flags.global) badges.push('<span class="apple-tag tag-spec">🌐 Global</span>');
        if (flags.legal) badges.push('<span class="apple-tag tag-spec">🏢 Юрлицо</span>');
        return badges.join('');
    }

    function formatTime(foundAtTs) {
        if (!foundAtTs) return '00:00';
        let elapsed = Math.floor((Date.now() - foundAtTs) / 1000);
        if (isNaN(elapsed) || elapsed < 0) elapsed = 0;

        const hours = Math.floor(elapsed / 3600);
        const mins = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
        const secs = String(elapsed % 60).padStart(2, '0');

        if (hours > 0) return `${hours}:${mins}:${secs}`;
        return `${mins}:${secs}`;
    }

    function renderDock(force = false) {
        attachResizeObserver();
        updateSidebarGeometry();

        let col = document.getElementById('apple-sessions-column');

        if (!window.location.pathname.startsWith('/orders') || sessionsMap.size === 0) {
            if (col && !col.classList.contains('dock-hidden')) {
                col.classList.add('dock-hidden');
                document.body.classList.remove('has-apple-column');
                setTimeout(() => {
                    if (sessionsMap.size === 0 || !window.location.pathname.startsWith('/orders')) {
                        col.remove();
                    }
                }, 260);
            }
            lastRenderedHash = '';
            return;
        }

        const currentOpenSessionId = (window.location.pathname.match(/\/orders\/session(?:-new)?\/(\d+)/) || [])[1];
        const domClientName = (document.querySelector('._clientName_sq209_35, [class*="_clientName_"]')?.textContent || '').trim().toLowerCase();

        const sortedSessions = Array.from(sessionsMap.values()).sort((a, b) => a.foundAt - b.foundAt);

        const currentHash = sortedSessions
            .map(s => `${s.id}-${s.shelves}-${s.itemsCount}-${String(s.id) === String(currentOpenSessionId)}-${JSON.stringify(s.flags || {})}-${isAutoSwitchEnabled()}`)
            .join('|');

        if (!force && currentHash === lastRenderedHash) {
            updateTimersInPlace();
            syncActiveCardInstant();
            return;
        }
        lastRenderedHash = currentHash;

        if (!col) {
            col = document.createElement('div');
            col.id = 'apple-sessions-column';
            document.body.appendChild(col);
        }

        col.classList.remove('dock-hidden');
        document.body.classList.add('has-apple-column');

        const myLogin = getMyOperatorLogin();
        const autoActive = isAutoSwitchEnabled();

        let html = `
            <div class="apple-col-header">
                <span>Очередь</span>
                <div class="apple-header-right">
                    <span id="auto-switch-toggle" class="apple-toggle-btn ${autoActive ? 'on' : 'off'}" title="Автопереключение после выдачи">
                        ${autoActive ? '⚡ Авто' : '⏸ Ручной'}
                    </span>
                    <span class="apple-col-badge">${sortedSessions.length}</span>
                </div>
            </div>
        `;

        sortedSessions.forEach((s, idx) => {
            const isMine = isMySession(s);
            const cardNameLower = (s.name || '').trim().toLowerCase();
            const isActiveCurrent = (currentOpenSessionId && String(s.id) === String(currentOpenSessionId)) ||
                                    (domClientName && cardNameLower && (domClientName.includes(cardNameLower) || cardNameLower.includes(domClientName)));

            const timeStr = formatTime(s.foundAt);
            const pillsHtml = buildShelfPillsHtml(s.shelves);
            const countInfo = s.itemsCount > 0 ? `${s.itemsCount} шт.` : '';
            const specBadgesHtml = buildSpecialFlagsHtml(s.flags);

            let cardClasses = ['apple-session-card'];
            if (isMine) cardClasses.push('mine');
            if (isActiveCurrent) cardClasses.push('active-session');

            html += `
                <div class="${cardClasses.join(' ')}" data-session-id="${s.id}" data-found-at="${s.foundAt}">
                    <div class="apple-row-top">
                        <div class="apple-name-group">
                            <span class="apple-index-pill" title="Alt+${idx + 1}">⌥${idx + 1}</span>
                            <span class="apple-client-name" title="${s.name}">${s.name}</span>
                        </div>
                        <div class="apple-top-right">
                            <span class="apple-timer" id="timer-${s.id}">${timeStr}</span>
                            <span class="apple-close-btn" data-close-id="${s.id}" title="Закрыть сессию">✕</span>
                        </div>
                    </div>

                    <div class="apple-row-mid">
                        <div class="apple-shelves-wrap">${pillsHtml}</div>
                        <span class="apple-items-count">${countInfo}</span>
                    </div>

                    ${specBadgesHtml ? `<div class="apple-tags-row">${specBadgesHtml}</div>` : ''}

                    <div class="apple-row-bottom">
                        <span class="apple-tag ${s.allPrepaid ? 'tag-paid' : 'tag-unpaid'}">
                            ${s.allPrepaid ? '✓ Оплачено' : '● Оплата'}
                        </span>
                        <span class="apple-tag ${isMine ? 'tag-you' : 'tag-colleague'}" title="${s.operator}">
                            ${isMine ? 'Вы' : s.operator || 'Коллега'}
                        </span>
                    </div>
                </div>
            `;
        });

        col.innerHTML = html;

        const toggleBtn = col.querySelector('#auto-switch-toggle');
        if (toggleBtn) {
            toggleBtn.onclick = (e) => {
                e.stopPropagation();
                toggleAutoSwitch();
            };
        }

        col.querySelectorAll('.apple-close-btn').forEach(btn => {
            btn.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                const sId = btn.dataset.closeId;
                const card = btn.closest('.apple-session-card');
                if (sId) closeSessionApi(sId, card);
            };
        });

        col.querySelectorAll('.apple-session-card').forEach(card => {
            card.onclick = (e) => {
                if (e.target.closest('.apple-close-btn') || e.target.closest('#auto-switch-toggle')) return;
                const sId = card.dataset.sessionId;
                if (sId) {
                    document.querySelectorAll('.apple-session-card').forEach(c => c.classList.remove('active-session'));
                    card.classList.add('active-session');
                    navigateSpa(`/orders/session-new/${sId}`);
                }
            };
        });
    }

    function updateTimersInPlace() {
        document.querySelectorAll('.apple-session-card').forEach(card => {
            const foundAt = parseInt(card.dataset.foundAt, 10);
            const timerEl = card.querySelector('.apple-timer');
            if (timerEl && foundAt) {
                let elapsed = Math.floor((Date.now() - foundAt) / 1000);
                if (elapsed <= 3) triggerZeroWatchdog();
                timerEl.textContent = formatTime(foundAt);
            }
        });
    }

    document.addEventListener('click', (e) => {
        const btn = e.target.closest('button');
        if (btn && btn.querySelector('path[d^="M6.293 2.293"]')) {
            sessionStorage.setItem('manual_back_navigation', 'true');
            sessionStorage.removeItem('active_session_tracker');
        }
    }, true);

    window.addEventListener('keydown', function(e) {
        if (!window.location.pathname.startsWith('/orders')) return;

        if (e.altKey && !e.ctrlKey && !e.shiftKey && !e.metaKey) {
            const digitMatch = e.code.match(/^(?:Digit|Numpad)([1-9])$/);
            if (digitMatch) {
                const requestedIdx = parseInt(digitMatch[1], 10) - 1;
                const sortedSessions = Array.from(sessionsMap.values()).sort((a, b) => a.foundAt - b.foundAt);
                if (sortedSessions[requestedIdx]) {
                    e.preventDefault();
                    e.stopPropagation();
                    const targetId = sortedSessions[requestedIdx].id;
                    document.querySelectorAll('.apple-session-card').forEach(c => {
                        c.classList.toggle('active-session', String(c.dataset.sessionId) === String(targetId));
                    });
                    navigateSpa(`/orders/session-new/${targetId}`);
                    return;
                }
            }
        }

        const now = Date.now();
        if (now - lastKeyTime > 350) scanBuffer = '';
        lastKeyTime = now;

        if (e.key === 'Enter') {
            const barcode = scanBuffer.trim();
            scanBuffer = '';

            const isClientCode = /^\d{6,12}\*\d{4}$/.test(barcode) || /^\d{10,14}$/.test(barcode);
            if (isClientCode) {
                e.preventDefault();
                e.stopPropagation();

                const curSessionId = (window.location.pathname.match(/\/orders\/session(?:-new)?\/(\d+)/) || [])[1];
                if (curSessionId) {
                    sessionStorage.setItem('pending_parent_session', curSessionId);
                }

                sessionStorage.setItem('pending_client_scan', barcode);

                if (window.location.pathname === '/orders') {
                    checkAndProcessPendingScan();
                } else {
                    navigateSpa('/orders');
                }
                return;
            }
        } else if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
            scanBuffer += e.key;
        }
    }, true);

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            updateTimersInPlace();
            syncSessionsBackground();
            syncActiveCardInstant();
            checkPostCompletionRedirect();
        }
    });

    setInterval(syncSessionsBackground, 2500);
    setInterval(() => {
        renderDock();
        syncActiveCardInstant();
        checkPostCompletionRedirect();
        if (window.location.pathname === '/orders') {
            checkAndProcessPendingScan();
        }
    }, 200);
})();
