// ── Utility helpers ──────────────────────────────────────────────
        const $ = id => document.getElementById(id);

        function fmt(num, dec = 2) {
            if (num == null || num === '' || isNaN(+num)) return '—';
            return (+num).toFixed(dec);
        }

        function fmtTime(iso) {
            if (!iso) return '—';
            try {
                return new Date(iso).toLocaleTimeString('th-TH', {
                    timeZone: 'Asia/Bangkok',
                    hour: '2-digit', minute: '2-digit', second: '2-digit'
                });
            } catch { return iso; }
        }

        function fmtDateTime(iso) {
            if (!iso) return '—';
            try {
                return new Date(iso).toLocaleString('th-TH', {
                    timeZone: 'Asia/Bangkok',
                    day: '2-digit', month: '2-digit', year: '2-digit',
                    hour: '2-digit', minute: '2-digit', second: '2-digit'
                });
            } catch { return iso; }
        }

        // ── Badge helpers ─────────────────────────────────────────────────
        function stateBadgeClass(state) {
            switch (state) {
                case 'SCANNING': return 'badge-blue';
                case 'WAITING_WICK_BREAK': return 'badge-yellow';
                case 'TRIGGERED': return 'badge-green';
                case 'MONITORING_TRADE': return 'badge-yellow';
                default: return 'badge-gray';
            }
        }

        function signalBadgeClass(type) {
            switch ((type || '').toUpperCase()) {
                case 'PRE_ALERT': return 'pre-alert';
                case 'TRIGGERED': return 'triggered';
                case 'INVALIDATED': return 'invalidated';
                case 'TP1_HIT': return 'triggered';
                case 'TP2_HIT': return 'triggered';
                case 'SL_HIT': return 'invalidated';
                default: return '';
            }
        }

        function signalBadgeLabel(type) {
            switch ((type || '').toUpperCase()) {
                case 'PRE_ALERT': return '⏳ PRE ALERT';
                case 'TRIGGERED': return '🔥 TRIGGERED';
                case 'INVALIDATED': return '❌ INVALIDATED';
                case 'TP1_HIT': return '🎯 TP1 HIT';
                case 'TP2_HIT': return '🔥 TP2 HIT';
                case 'SL_HIT': return '❌ SL HIT';
                default: return type;
            }
        }

        // ── Render ────────────────────────────────────────────────────────
        function render(state) {
            // Bot State card
            const stateClass = stateBadgeClass(state.botState);
            $('val-bot-state').innerHTML = `<span class="badge ${stateClass}">${state.botState || '—'}</span>`;
            $('sub-bot-state').textContent = state.botState === 'SCANNING'
                ? 'Scanning for SMC zones…'
                : state.botState === 'WAITING_WICK_BREAK'
                ? 'Waiting for wick breakout…'
                : state.botState === 'TRIGGERED'
                ? 'Signal triggered!'
                : state.botState === 'MONITORING_TRADE'
                ? 'Monitoring active trade live…'
                : '';

            // WebSocket card
            const wsClass = state.wsStatus === 'CONNECTED' ? 'badge-green' : 'badge-red';
            $('val-ws').innerHTML = `<span class="badge ${wsClass}">${state.wsStatus || 'UNKNOWN'}</span>`;

            // Zones card
            const z = state.zonesFound || {};
            $('val-zones-total').textContent = z.total != null ? z.total : '—';
            $('val-zones-fvg').textContent = z.fvg != null ? z.fvg : '—';
            $('val-zones-ob').textContent = z.ob != null ? z.ob : '—';

            // Scan time card
            if (state.lastScanTime) {
                $('val-scan-time').textContent = fmtTime(state.lastScanTime);
                $('sub-scan-time').textContent = fmtDateTime(state.lastScanTime);
            }

            // Win Rates (Today & Monthly)
            const wr = state.winRate || { daily: { win: 0, loss: 0, rate: 0 }, monthly: { win: 0, loss: 0, rate: 0 } };
            $('val-daily-win-rate').textContent = `${fmt(wr.daily.rate, 1)}%`;
            $('sub-daily-win-loss').textContent = `${wr.daily.win} W / ${wr.daily.loss} L`;
            $('val-monthly-win-rate').textContent = `${fmt(wr.monthly.rate, 1)}%`;
            $('sub-monthly-win-loss').textContent = `${wr.monthly.win} W / ${wr.monthly.loss} L`;

            // M5 Candle
            const m5 = state.lastM5 || {};
            const isBull = m5.close > m5.open;
            const isBear = m5.close < m5.open;
            const candleClass = isBull ? 'bullish' : isBear ? 'bearish' : 'neutral';
            const candleEmoji = isBull ? '🟢 Bullish' : isBear ? '🔴 Bearish' : '⬛ Doji';

            if (m5.open || m5.close) {
                $('m5-candle-badge').innerHTML = `<span class="badge ${isBull ? 'badge-green' : isBear ? 'badge-red' : 'badge-gray'}">${candleEmoji}</span>`;
            }
            $('val-m5-open').textContent = fmt(m5.open);
            $('val-m5-high').textContent = fmt(m5.high);
            $('val-m5-low').textContent = fmt(m5.low);
            $('val-m5-close').className = `ohlc-value ${candleClass}`;
            $('val-m5-close').textContent = fmt(m5.close);

            // Midpoint card
            const tr = state.tradingRange;
            if (tr && tr.midpoint != null) {
                $('val-midpoint').textContent = fmt(tr.midpoint);
                $('sub-midpoint').textContent = `Range: ${fmt(tr.low)} - ${fmt(tr.high)}`;
            } else {
                $('val-midpoint').textContent = '—';
                $('sub-midpoint').textContent = 'Range: —';
            }

            // Active Trade Section
            const atSection = $('active-trade-section');
            const at = state.activeTrade;
            if (at && state.botState === 'MONITORING_TRADE') {
                atSection.style.display = 'block';
                const card = $('active-trade-card');
                const badge = $('active-direction-badge');
                
                // Set direction class
                if (at.direction === 'BUY') {
                    card.className = 'card active-trade-card buy-mode';
                    badge.textContent = 'BUY';
                    badge.className = 'active-badge buy';
                } else {
                    card.className = 'card active-trade-card sell-mode';
                    badge.textContent = 'SELL';
                    badge.className = 'active-badge sell';
                }
                
                $('active-trade-time').textContent = fmtDateTime(at.time);
                $('active-entry').textContent = fmt(at.entry);
                $('active-current').textContent = fmt(state.lastM5 ? state.lastM5.close : null);
                $('active-sl').textContent = fmt(at.sl);
                $('active-tp1').textContent = fmt(at.tp1);
                $('active-tp2').textContent = fmt(at.tp2);
                
                // Status label
                let statusText = at.isTp1Hit ? '🎯 TP1 Hit (SL at Entry)' : '⚡ Active';
                $('active-status').textContent = statusText;
                $('active-status').style.color = at.isTp1Hit ? 'var(--yellow)' : 'var(--text)';
            } else {
                atSection.style.display = 'none';
            }

            // Last Signal
            renderLastSignal(state.lastSignal);

            // Signal History (top 10)
            renderHistory(state.signalHistory || []);
        }

        function renderLastSignal(sig) {
            const card = $('last-signal-content');
            if (!sig) {
                card.innerHTML = `<p class="no-signal">No signal yet</p>`;
                return;
            }
            const cls = signalBadgeClass(sig.type);
            const label = signalBadgeLabel(sig.type);
            const dirColor = sig.direction === 'BUY' ? 'var(--green)' : sig.direction === 'SELL' ? 'var(--red)' : 'var(--text)';

            card.innerHTML = `
                <div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">
                    <span class="history-badge ${cls}">${label}</span>
                    <span style="font-size:14px;font-weight:700;color:${dirColor}">${sig.direction || ''}</span>
                    <span style="font-size:11px;color:var(--text-muted);margin-left:auto;">${fmtTime(sig.time)}</span>
                </div>
                <div class="signal-detail-grid">
                    <div class="signal-item">
                        <div class="signal-label">Entry</div>
                        <div class="signal-value">${fmt(sig.entry)}</div>
                    </div>
                    <div class="signal-item">
                        <div class="signal-label">Stop Loss</div>
                        <div class="signal-value" style="color:var(--red)">${fmt(sig.sl)}</div>
                    </div>
                    <div class="signal-item">
                        <div class="signal-label">TP1 (1:2)</div>
                        <div class="signal-value" style="color:var(--green)">${fmt(sig.tp1)}</div>
                    </div>
                    <div class="signal-item">
                        <div class="signal-label">TP2 (1:3)</div>
                        <div class="signal-value" style="color:var(--green)">${fmt(sig.tp2)}</div>
                    </div>
                </div>
                ${sig.zone ? `<div style="margin-top:8px;font-size:11px;color:var(--text-muted);">Zone: <strong style="color:var(--gold)">${sig.zone}</strong></div>` : ''}
            `;
        }

        function renderHistory(history) {
            const list = $('history-list');
            const items = history.slice(0, 10);
            if (items.length === 0) {
                list.innerHTML = `<p class="no-history">No signals recorded yet</p>`;
                return;
            }

            list.innerHTML = items.map((sig, i) => {
                const cls = signalBadgeClass(sig.type);
                const label = signalBadgeLabel(sig.type);
                const dirColor = sig.direction === 'BUY' ? 'var(--green)' : sig.direction === 'SELL' ? 'var(--red)' : 'var(--text)';
                return `
                    <div class="history-item ${cls}" id="hist-${i}">
                        <span class="history-badge ${cls}">${label}</span>
                        <div class="history-meta">
                            <div class="history-dir" style="color:${dirColor}">${sig.direction || '—'}</div>
                            <div class="history-time">${fmtDateTime(sig.time)}</div>
                        </div>
                        <div class="history-entry">Entry: ${fmt(sig.entry)}</div>
                    </div>
                `;
            }).join('');
        }

        // ── SSE Connection ────────────────────────────────────────────────
        const sseDot = $('sse-dot');
        const sseLabel = $('sse-label');
        const reconnectBanner = $('reconnect-banner');
        const forceScanBtn = $('force-scan-btn');
        const forceScanStatus = $('force-scan-status');

        let reconnectDelay = 3000;

        async function forceScan() {
            forceScanBtn.disabled = true;
            forceScanStatus.textContent = 'Scanning...';

            try {
                const response = await fetch('/force-scan', { method: 'POST' });
                const result = await response.json();

                if (!response.ok || !result.ok) {
                    throw new Error(result.error || 'Force scan failed');
                }

                forceScanStatus.textContent = 'Done';
                setTimeout(() => { forceScanStatus.textContent = ''; }, 3000);
            } catch (err) {
                console.error('Force scan error:', err);
                forceScanStatus.textContent = 'Failed';
                setTimeout(() => { forceScanStatus.textContent = ''; }, 5000);
            } finally {
                forceScanBtn.disabled = false;
            }
        }

        forceScanBtn.addEventListener('click', forceScan);

        // ── Config Panel ────────────────────────────────────────────────
        const toggleH4 = document.getElementById('toggle-h4-filter');
        const toggleTrailing = document.getElementById('toggle-trailing-stop');
        const toggleCE = document.getElementById('toggle-ce-entry');

        async function fetchConfig() {
            try {
                const res = await fetch('/api/config');
                const config = await res.json();
                toggleH4.checked = config.USE_H4_FILTER;
                toggleTrailing.checked = config.USE_TRAILING_STOP;
                toggleCE.checked = config.USE_CE_ENTRY;
            } catch(e) {
                console.error('Failed to load config', e);
            }
        }

        async function updateConfig(key, value) {
            try {
                await fetch('/api/config', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ [key]: value })
                });
            } catch(e) {
                console.error('Failed to update config', e);
            }
        }

        toggleH4.addEventListener('change', (e) => {
            updateConfig('USE_H4_FILTER', e.target.checked);
        });

        toggleTrailing.addEventListener('change', (e) => {
            updateConfig('USE_TRAILING_STOP', e.target.checked);
        });

        toggleCE.addEventListener('change', (e) => {
            updateConfig('USE_CE_ENTRY', e.target.checked);
        });

        fetchConfig();

        function connectSSE() {
            const evtSource = new EventSource('/events');

            evtSource.onopen = () => {
                console.log('✅ SSE Connected');
                sseDot.className = 'live';
                sseLabel.textContent = 'Live Updates';
                reconnectBanner.classList.remove('visible');
                reconnectDelay = 3000;
            };

            evtSource.onmessage = (event) => {
                try {
                    const data = JSON.parse(event.data);
                    render(data);
                } catch (e) {
                    console.error('❌ SSE JSON Parse Error:', e);
                }
            };

            evtSource.onerror = (err) => {
                console.warn('⚠️ SSE Connection Error, reconnecting...');
                sseDot.className = '';
                sseLabel.textContent = 'Disconnected';
                reconnectBanner.classList.add('visible');
                evtSource.close();

                setTimeout(connectSSE, reconnectDelay);
                reconnectDelay = Math.min(reconnectDelay * 2, 30000);
            };
        }

        connectSSE();
