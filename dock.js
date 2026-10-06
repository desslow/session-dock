// ==UserScript==
// @name         Ozon Sessions Dock
// @namespace    http://tampermonkey.net/
// @version      2.1
// @description  Переработанный док сессий выдач.
// @author       desslow
// @match        https://*.ozon.ru/orders*
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function() {
    'use strict';

    const COLUMN_WIDTH = 205;
    const sessionsMap = new Map();
    let lastRenderedHash = '';
    let lastZeroWatchdogTime = 0;
    window._ozonAuthHeaders = null;

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
        this.addEventListener('load', function() {
            try {
                if (this._sUrl.includes('/api2/giveout/Sessions')) {
                    const data = JSON.parse(this.responseText);
                    updateSessionsData(data);
                }
            } catch (e) {}
        });
        return origSend.apply(this, arguments);
    };

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
            }
        }

        data.sessions.forEach(s => {
            const existing = sessionsMap.get(s.sessionId);
            const ts = getExactSessionTimestamp(s.sessionId, s.foundAt);

            if (!existing) {
                sessionsMap.set(s.sessionId, {
                    id: s.sessionId,
                    name: s.clientShortName,
                    foundAt: ts,
                    allPrepaid: s.allPrepaid === true,
                    operator: (s.userName || '').replace('PVZ_', ''),
                    shelves: '',
                    itemsCount: 0
                });
                fetchSessionDetails(s.sessionId);
            } else {
                existing.foundAt = ts;
                existing.allPrepaid = s.allPrepaid === true;
                existing.operator = (s.userName || '').replace('PVZ_', '');
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
                        navigateSpa('/orders');
                    } else {
                        renderDock(true);
                    }
                }, 260);
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
                return;
            }
        } catch (e) {}

        try {
            const nApp = window.useNuxtApp ? window.useNuxtApp() : (window.__nuxt_app__ || window.$nuxt);
            if (nApp?.vueApp?.config?.globalProperties?.$router) {
                nApp.vueApp.config.globalProperties.$router.push(url);
                return;
            }
            if (window.$nuxt?.$router) {
                window.$nuxt.$router.push(url);
                return;
            }
        } catch (e) {}

        try {
            window.history.pushState({}, '', url);
            window.dispatchEvent(new PopStateEvent('popstate'));
        } catch (e) {}

        setTimeout(() => {
            if (!window.location.pathname.includes(url.replace('/orders/session-new/', ''))) {
                window.location.href = url;
            }
        }, 120);
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
            border-left: 1px solid #293c57 !important;
            border-right: 1px solid #203148 !important;
            box-shadow: 4px 2 2 2px rgba(0, 0, 0, 0.35) !important;
            display: flex !important;
            flex-direction: column !important;
            gap: 6px !important;
            padding: 10px 8px !important;
            box-sizing: border-box !important;
            overflow-y: auto !important;
            overscroll-behavior: contain !important;
            z-index: 7000 !important;
            font-family: -apple-system, BlinkMacSystemFont, "SF Pro Display", "SF Pro Text", sans-serif !important;
            transition: left 0.2s cubic-bezier(0.16, 1, 0.3, 1) !important;
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
        #apple-sessions-column::-webkit-scrollbar-thumb:hover {
            background: rgba(255, 255, 255, 0.32) !important;
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
            border-bottom: 1px solid #203148;
            margin-bottom: 2px;
        }
        .apple-col-badge {
            background: rgba(255, 255, 255, 0.1);
            color: rgba(235, 235, 245, 0.85);
            padding: 1px 6px;
            border-radius: 10px;
            font-size: 10px;
            font-weight: 600;
        }

        #apple-sessions-column:hover .apple-session-card { opacity: 0.45; }

        @keyframes cardAppear {
            0% {
                opacity: 0;
                transform: translateY(-6px) scale(0.97);
            }
            100% {
                opacity: 1;
                transform: translateY(0) scale(1);
            }
        }

        .apple-session-card {
            background: rgba(255, 255, 255, 0.04) !important;
            border: 1px solid rgba(255, 255, 255, 0.07) !important;
            box-shadow: inset 0 1px 0 0 rgba(255, 255, 255, 0.05) !important;
            border-radius: 10px !important;
            padding: 8px 10px !important;
            display: flex !important;
            flex-direction: column !important;
            gap: 5px !important;
            cursor: pointer !important;
            user-select: none !important;
            box-sizing: border-box !important;
            transition: opacity 0.22s ease, background 0.15s ease, transform 0.25s cubic-bezier(0.16, 1, 0.3, 1), max-height 0.25s ease, margin 0.25s ease, padding 0.25s ease !important;
            position: relative !important;
            flex-shrink: 0 !important;
            animation: cardAppear 0.25s cubic-bezier(0.16, 1, 0.3, 1) forwards !important;
            max-height: 120px;
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
            background: rgba(255, 255, 255, 0.09) !important;
            border-color: rgba(255, 255, 255, 0.16) !important;
        }

        .apple-session-card.active-session {
            background: rgba(10, 132, 255, 0.12) !important;
            border-color: rgba(10, 132, 255, 0.4) !important;
            box-shadow: inset 3px 0 0 0 #0a84ff, inset 0 1px 0 0 rgba(255, 255, 255, 0.1) !important;
        }

        .apple-row-top {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 4px;
        }
        .apple-client-name {
            font-size: 13px;
            font-weight: 600;
            color: #ffffff;
            letter-spacing: -0.2px;
            white-space: nowrap;
            overflow: hidden;
            text-overflow: ellipsis;
            max-width: 105px;
        }
        .apple-top-right {
            position: relative !important;
            display: flex !important;
            align-items: center !important;
            justify-content: flex-end !important;
        }
        .apple-timer {
            font-size: 11px !important;
            font-weight: 500 !important;
            color: rgba(235, 235, 245, 0.6) !important;
            font-variant-numeric: tabular-nums !important;
            white-space: nowrap !important;
            transition: transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), color 0.2s ease !important;
        }

        .apple-session-card:hover .apple-timer {
            transform: translateX(-18px) !important;
            color: rgba(235, 235, 245, 0.45) !important;
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
            transition: opacity 0.2s ease, transform 0.22s cubic-bezier(0.16, 1, 0.3, 1), background 0.15s, color 0.15s !important;
        }

        .apple-session-card:hover .apple-close-btn {
            opacity: 1 !important;
            pointer-events: auto !important;
            transform: translateY(-50%) scale(1) !important;
        }

        .apple-close-btn:hover {
            color: #ff453a !important;
            background: rgba(255, 69, 58, 0.18) !important;
        }

        .apple-shelves-wrap {
            display: flex;
            align-items: center;
            gap: 4px;
            flex-wrap: wrap;
        }
        .apple-shelf-pill {
            font-size: 10px;
            font-weight: 700;
            padding: 1px 5px;
            border-radius: 5px;
            white-space: nowrap;
            letter-spacing: -0.1px;
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

        .apple-row-mid {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 4px;
        }
        .apple-items-count {
            font-size: 11px;
            color: rgba(235, 235, 245, 0.5);
            white-space: nowrap;
        }

        .apple-row-bottom {
            display: flex;
            align-items: center;
            justify-content: space-between;
            margin-top: 1px;
        }
        .apple-tag {
            font-size: 10px;
            font-weight: 600;
            padding: 1px 5px;
            border-radius: 4px;
        }
        .tag-unpaid { color: #ff453a; background: rgba(255, 69, 58, 0.12); }
        .tag-paid { color: #30d158; background: rgba(48, 209, 88, 0.12); }
        .tag-you { color: #0a84ff; background: rgba(10, 132, 255, 0.14); font-weight: 700; }
        .tag-colleague { color: rgba(235, 235, 245, 0.45); }
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

        if (!window.location.pathname.startsWith('/orders')) {
            const col = document.getElementById('apple-sessions-column');
            if (col) col.remove();
            document.body.classList.remove('has-apple-column');
            return;
        }

        if (sessionsMap.size === 0) {
            const col = document.getElementById('apple-sessions-column');
            if (col) col.remove();
            document.body.classList.remove('has-apple-column');
            lastRenderedHash = '';
            return;
        }

        const currentOpenSessionId = (window.location.pathname.match(/\/orders\/session(?:-new)?\/(\d+)/) || [])[1];

        const currentHash = Array.from(sessionsMap.values())
            .map(s => `${s.id}-${s.shelves}-${s.itemsCount}-${s.id === currentOpenSessionId}`)
            .join('|');

        if (!force && currentHash === lastRenderedHash) {
            updateTimersInPlace();
            return;
        }
        lastRenderedHash = currentHash;

        let col = document.getElementById('apple-sessions-column');
        if (!col) {
            col = document.createElement('div');
            col.id = 'apple-sessions-column';
            document.body.appendChild(col);
        }

        document.body.classList.add('has-apple-column');

        const myLoginEl = document.querySelector('[class*="_rightAvatarMenuLogin_"]');
        const myLogin = myLoginEl ? myLoginEl.textContent.trim().replace('PVZ_', '') : '';

        let html = `
            <div class="apple-col-header">
                <span>Очередь</span>
                <span class="apple-col-badge">${sessionsMap.size}</span>
            </div>
        `;

        sessionsMap.forEach(s => {
            const isMySession = myLogin && s.operator && (s.operator === myLogin || s.operator.includes(myLogin));
            const isActiveCurrent = currentOpenSessionId && String(s.id) === String(currentOpenSessionId);

            const timeStr = formatTime(s.foundAt);
            const pillsHtml = buildShelfPillsHtml(s.shelves);
            const countInfo = s.itemsCount > 0 ? `${s.itemsCount} шт.` : '';

            html += `
                <div class="apple-session-card ${isActiveCurrent ? 'active-session' : ''}" data-session-id="${s.id}" data-found-at="${s.foundAt}">
                    <div class="apple-row-top">
                        <span class="apple-client-name" title="${s.name}">${s.name}</span>
                        <div class="apple-top-right">
                            <span class="apple-timer" id="timer-${s.id}">${timeStr}</span>
                            <span class="apple-close-btn" data-close-id="${s.id}" title="Закрыть сессию">✕</span>
                        </div>
                    </div>

                    <div class="apple-row-mid">
                        <div class="apple-shelves-wrap">${pillsHtml}</div>
                        <span class="apple-items-count">${countInfo}</span>
                    </div>

                    <div class="apple-row-bottom">
                        <span class="apple-tag ${s.allPrepaid ? 'tag-paid' : 'tag-unpaid'}">
                            ${s.allPrepaid ? '✓ Оплачено' : '● Оплата'}
                        </span>
                        <span class="apple-tag ${isMySession ? 'tag-you' : 'tag-colleague'}">
                            ${isMySession ? 'Вы' : s.operator || 'Коллега'}
                        </span>
                    </div>
                </div>
            `;
        });

        col.innerHTML = html;

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
                if (e.target.closest('.apple-close-btn')) return;
                const sId = card.dataset.sessionId;
                if (sId) navigateSpa(`/orders/session-new/${sId}`);
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

    document.addEventListener('visibilitychange', () => {
        if (!document.hidden) {
            updateTimersInPlace();
            syncSessionsBackground();
        }
    });

    setInterval(syncSessionsBackground, 3000);
    setInterval(() => renderDock(), 1000);
})();
