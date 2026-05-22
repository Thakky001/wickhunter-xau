const WebSocket = require('ws');
const keys = require('../config/keys');
const { processTickData } = require('../logic/smcEngine');
const dashboardState = require('./dashboardState');

// Exponential Backoff: เริ่มที่ 5 วิ → 10 → 20 → 40 → สูงสุด 120 วิ
const INITIAL_DELAY = 5000;
const MAX_DELAY = 120000;
let currentDelay = INITIAL_DELAY;
let activeWs = null;
let heartbeatTimer = null;
let reconnectTimer = null;

function isSocketActive(ws) {
    return ws && ws.readyState !== WebSocket.CLOSED;
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
        startPriceStream();
    }, delay);

    currentDelay = Math.min(currentDelay * 2, MAX_DELAY);
}

function startPriceStream() {
    if (!keys.FINNHUB_API_KEY) {
        console.error("❌ ขาด Finnhub API Key");
        return;
    }

    if (isSocketActive(activeWs)) {
        console.log("ℹ️ Finnhub WebSocket ยังเชื่อมต่ออยู่ ข้ามการเปิด connection ซ้ำ");
        return;
    }

    const ws = new WebSocket(`wss://ws.finnhub.io?token=${keys.FINNHUB_API_KEY}`);
    activeWs = ws;

    ws.on('open', function open() {
        // ✅ Connect สำเร็จ → รีเซ็ต delay กลับเป็นค่าเริ่มต้น
        currentDelay = INITIAL_DELAY;
        if (reconnectTimer) {
            clearTimeout(reconnectTimer);
            reconnectTimer = null;
        }
        console.log('🔗 WebSocket Connected: WickHunter กำลังดักซุ่มราคา OANDA:XAU_USD...');
        dashboardState.updateWsStatus('CONNECTED');
        ws.send(JSON.stringify({ 'type': 'subscribe', 'symbol': 'OANDA:XAU_USD' }));

        // Heartbeat ทุก 20 วิ ป้องกัน Connection หลุดจาก Idle
        heartbeatTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.ping();
            }
        }, 20000);
    });

    ws.on('message', function incoming(data) {
        let response;
        try {
            response = JSON.parse(data);
        } catch (error) {
            console.error('❌ WebSocket JSON parse failed:', error.message);
            return;
        }

        if (response.type === 'trade') {
            const currentPrice = response?.data?.[0]?.p;
            if (!currentPrice) return;
            processTickData(currentPrice).catch((error) => {
                console.error('❌ Process tick failed:', error.message);
            });
        }
    });

    ws.on('close', function close() {
        clearHeartbeat();

        if (activeWs === ws) {
            activeWs = null;
        }

        console.log(`⚠️ WebSocket Disconnected → รอ ${currentDelay / 1000} วินาทีก่อน Reconnect...`);
        dashboardState.updateWsStatus('DISCONNECTED');
        scheduleReconnect();
    });

    ws.on('error', function error(err) {
        // ดักจับ 429 แยกออกมา เพื่อแจ้งผู้ใช้ชัดเจน
        if (err.message && err.message.includes('429')) {
            currentDelay = Math.max(currentDelay, 60000);
            console.error(`🚫 Finnhub Rate Limit (429) → รอ ${currentDelay / 1000} วินาที...`);
        } else {
            console.error('❌ WebSocket Error:', err.message);
        }
        // ปล่อยให้ 'close' event จัดการ Reconnect ต่อเอง
    });
}

module.exports = { startPriceStream };
