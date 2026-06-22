const WebSocket = require('ws');
const keys = require('../config/keys');
// smcEngine will be required dynamically at call site to avoid circular dependency
const dashboardState = require('./dashboardState');

// Exponential Backoff: เริ่มที่ 5 วิ → 10 → 20 → 40 → สูงสุด 120 วิ
const INITIAL_DELAY = 5000;
const MAX_DELAY = 120000;
let currentDelay = INITIAL_DELAY;

let activeWs = null;
let heartbeatTimer = null;
let reconnectTimer = null;

// ─── Promise-based Request Management ────────────────────────────────────
let reqIdCounter = 1;
const pendingRequests = new Map();

// ─── M1 Candle Builder ───────────────────────────────────────────────────
const M1_BUFFER_SIZE = 15;
const M1_MIN_TICK_COUNT = 1; 

let currentM1 = null;
let m1Buffer = [];

function getMinuteKey(timestampMs) {
    const d = timestampMs ? new Date(timestampMs) : new Date();
    return d.getUTCHours() * 60 + d.getUTCMinutes();
}

function aggregateM1Tick(price, timestampMs) {
    const minuteKey = getMinuteKey(timestampMs);
    const tickTime = timestampMs ? new Date(timestampMs).toISOString() : new Date().toISOString();

    if (!currentM1 || currentM1.minuteKey !== minuteKey) {
        if (currentM1 && currentM1.tickCount > 0) {
            const completedCandle = {
                open: currentM1.open,
                high: currentM1.high,
                low: currentM1.low,
                close: currentM1.close,
                time: currentM1.openTime,
                tickCount: currentM1.tickCount
            };

            m1Buffer.push(completedCandle);
            if (m1Buffer.length > M1_BUFFER_SIZE) m1Buffer.shift();

            if (completedCandle.tickCount >= M1_MIN_TICK_COUNT) {
                require('../logic/smcEngine').processM1Close(completedCandle).catch(err => {
                    console.error('❌ processM1Close failed:', err.message);
                });
            }
        }

        currentM1 = {
            open: price, high: price, low: price, close: price,
            openTime: tickTime, minuteKey: minuteKey, tickCount: 1
        };
    } else {
        currentM1.high = Math.max(currentM1.high, price);
        currentM1.low = Math.min(currentM1.low, price);
        currentM1.close = price;
        currentM1.tickCount++;
    }
}

function resetM1Builder() {
    currentM1 = null;
    console.log('🔄 [M1 Builder]: รีเซ็ตแท่ง M1 ที่ค้างอยู่ (WebSocket reconnect)');
}

function isSocketActive(ws) {
    return ws && ws.readyState === WebSocket.OPEN;
}

function clearHeartbeat() {
    if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }
}

function scheduleReconnect() {
    if (reconnectTimer) return;
    const delay = currentDelay;
    reconnectTimer = setTimeout(() => {
        reconnectTimer = null;
        startDerivStream();
    }, delay);
    currentDelay = Math.min(currentDelay * 2, MAX_DELAY);
}

// ─── API Methods ─────────────────────────────────────────────────────────

function sendRequest(payload) {
    return new Promise((resolve, reject) => {
        if (!isSocketActive(activeWs)) {
            return reject(new Error('Deriv WebSocket is not connected'));
        }
        
        const req_id = reqIdCounter++;
        payload.req_id = req_id;
        
        const timeoutMs = 15000; // 15 seconds timeout
        const timer = setTimeout(() => {
            pendingRequests.delete(req_id);
            reject(new Error(`Request ${req_id} timed out after ${timeoutMs}ms`));
        }, timeoutMs);

        pendingRequests.set(req_id, { resolve, reject, timer });
        activeWs.send(JSON.stringify(payload));
    });
}

/**
 * ดึงแท่งเทียนย้อนหลัง (เหมือน twelveData.getCandles)
 * @param {string|number} resolution - '60' สำหรับ H1, '5' สำหรับ M5
 * @param {number} limit - จำนวนแท่ง
 * @returns {Promise<Array>} Array of candles [{open, high, low, close, time}, ...]
 */
async function getCandles(resolution, limit = 100) {
    try {
        const granularity = String(resolution) === '60' ? 3600 : 300;
        
        const response = await sendRequest({
            ticks_history: 'frxXAUUSD',
            adjust_start_time: 1,
            count: limit,
            end: 'latest',
            style: 'candles',
            granularity: granularity
        });

        if (response.error) {
            throw new Error(response.error.message);
        }

        if (response.candles && response.candles.length > 0) {
            // Deriv ส่ง candles จากเก่าไปใหม่ (Oldest to Newest) ตรงตามคณิตศาสตร์ SMC ของเราอยู่แล้ว ไม่ต้อง .reverse()
            const formatted = response.candles.map(c => ({
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                time: c.epoch // epoch = timestamp เป็นวินาที
            }));
            return formatted;
        }
        return [];
    } catch (error) {
        console.error(`❌ [Deriv] getCandles failed: ${error.message}`);
        throw error;
    }
}

// ─── WebSocket Connection ────────────────────────────────────────────────

function startDerivStream() {
    if (!keys.DERIV_APP_ID) {
        console.error("❌ ขาด DERIV_APP_ID ใน config (ใช้ default 1089 ไปก่อนได้)");
    }
    const appId = keys.DERIV_APP_ID || "1089";

    if (activeWs && activeWs.readyState !== WebSocket.CLOSED) {
        console.log("ℹ️ Deriv WebSocket ยังเชื่อมต่ออยู่");
        return;
    }

    const wsUrl = `wss://ws.binaryws.com/websockets/v3?app_id=${appId}`;
    const ws = new WebSocket(wsUrl);
    activeWs = ws;

    ws.on('open', function open() {
        currentDelay = INITIAL_DELAY;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        
        console.log('🔗 Deriv WebSocket Connected: กำลังดักซุ่มราคา frxXAUUSD...');
        dashboardState.updateWsStatus('CONNECTED');
        
        // สมัครรับ Tick Real-time
        ws.send(JSON.stringify({ ticks: "frxXAUUSD", subscribe: 1 }));

        // [Fix] เริ่มรัน Engine (ดึง H1/M5) ทันทีที่เชื่อมต่อสำเร็จ
        require('../logic/smcEngine').startSmartSyncLoop();

        // Heartbeat ทุก 30 วิ (Ping)
        heartbeatTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ ping: 1 }));
            }
        }, 30000);
    });

    ws.on('message', function incoming(data) {
        let response;
        try {
            response = JSON.parse(data);
        } catch (error) {
            console.error('❌ Deriv JSON parse failed:', error.message);
            return;
        }

        // 1. จัดการ Response จาก Promise-based Requests
        if (response.req_id && pendingRequests.has(response.req_id)) {
            const { resolve, timer } = pendingRequests.get(response.req_id);
            clearTimeout(timer);
            pendingRequests.delete(response.req_id);
            resolve(response);
            return; // ถ้าเป็น Response ของ Request ไม่ต้องทำอย่างอื่นต่อ
        }

        // 2. จัดการ Real-time Tick
        if (response.msg_type === 'tick' && response.tick) {
            const currentPrice = response.tick.quote;
            const tickTimeMs = response.tick.epoch * 1000; // Deriv epoch เป็นวินาที ต้องคูณ 1000 เป็น Ms
            
            require('../logic/smcEngine').processTickData(currentPrice).catch(error => {
                console.error('❌ Process tick failed:', error.message);
            });
            aggregateM1Tick(currentPrice, tickTimeMs);

            // [Fix] Update live M5 candle state directly for the frontend TradingView chart
            const epoch = response.tick.epoch;
            const m5Epoch = epoch - (epoch % 300); // Floor to nearest 5 mins
            const state = dashboardState.state;
            
            if (!state.lastM5 || state.lastM5.time !== m5Epoch) {
                // New M5 candle started
                dashboardState.update({
                    lastM5: {
                        time: m5Epoch,
                        open: currentPrice,
                        high: currentPrice,
                        low: currentPrice,
                        close: currentPrice
                    }
                });
            } else {
                // Update existing M5 candle
                dashboardState.update({
                    lastM5: {
                        time: m5Epoch,
                        open: state.lastM5.open,
                        high: Math.max(state.lastM5.high, currentPrice),
                        low: Math.min(state.lastM5.low, currentPrice),
                        close: currentPrice
                    }
                });
            }
        }

        // 3. จัดการ Error แบบ Global (ถ้าไม่ได้ผูกกับ req_id)
        if (response.error && !response.req_id) {
            console.error('❌ Deriv Error:', response.error.message);
        }
    });

    ws.on('close', function close() {
        clearHeartbeat();
        resetM1Builder();
        
        // เคลียร์ Pending Requests ทั้งหมดให้ Reject ทันทีที่เน็ตหลุด
        for (const [req_id, { reject, timer }] of pendingRequests.entries()) {
            clearTimeout(timer);
            reject(new Error('WebSocket disconnected before response'));
        }
        pendingRequests.clear();

        if (activeWs === ws) activeWs = null;

        console.log(`⚠️ Deriv WebSocket Disconnected → รอ ${currentDelay / 1000} วินาทีก่อน Reconnect...`);
        dashboardState.updateWsStatus('DISCONNECTED');
        scheduleReconnect();
    });

    ws.on('error', function error(err) {
        console.error('❌ Deriv WebSocket Error:', err.message);
    });
}

module.exports = { startDerivStream, getCandles };
