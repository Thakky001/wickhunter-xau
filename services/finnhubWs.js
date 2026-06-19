const WebSocket = require('ws');
const keys = require('../config/keys');
const { processTickData, processM1Close } = require('../logic/smcEngine');
const dashboardState = require('./dashboardState');

// Exponential Backoff: เริ่มที่ 5 วิ → 10 → 20 → 40 → สูงสุด 120 วิ
const INITIAL_DELAY = 5000;
const MAX_DELAY = 120000;
let currentDelay = INITIAL_DELAY;
let activeWs = null;
let heartbeatTimer = null;
let reconnectTimer = null;

// ─── M1 Candle Builder ──────────────────────────────────────────────────────────────────
// สร้างแท่งเทียน M1 จาก tick data ของ Finnhub แบบ real-time
// ใช้สำหรับยืนยัน ChoCh break แทนการรอ M5 close (เร็วกว่า 5 เท่า)
const M1_BUFFER_SIZE = 15;
const M1_MIN_TICK_COUNT = 1;  // [Fix] ลดจาก 5 → 1 เพราะ Finnhub Free Tier ส่ง tick น้อย ถ้าตั้ง 5 แท่ง M1 จะไม่ถูกสร้างเลย

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
        // นาทีเปลี่ยน → แท่ง M1 ก่อนหน้าปิดแล้ว
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
            if (m1Buffer.length > M1_BUFFER_SIZE) {
                m1Buffer.shift();
            }

            // แจ้ง Engine ว่าแท่ง M1 ปิดแล้ว (เฉพาะแท่งที่มี tick เพียงพอ)
            if (completedCandle.tickCount >= M1_MIN_TICK_COUNT) {
                processM1Close(completedCandle).catch(err => {
                    console.error('❌ processM1Close failed:', err.message);
                });
            } else {
                console.log(`   ⚠️ [M1 Builder]: แท่ง M1 ปิดแล้ว แต่มี tick แค่ ${completedCandle.tickCount} (ต่ำกว่าขั้นต่ำ ${M1_MIN_TICK_COUNT}) → ข้าม`);
            }
        }

        // เริ่มแท่งใหม่
        currentM1 = {
            open: price,
            high: price,
            low: price,
            close: price,
            openTime: tickTime,
            minuteKey: minuteKey,
            tickCount: 1
        };
    } else {
        // อัปเดตแท่งปัจจุบัน
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

        if (response.type === 'trade' && Array.isArray(response.data)) {
            // [Bug Fix] Finnhub มักจะส่งข้อมูลมาเป็น batch (หลาย tick ใน array เดียว)
            // เดิมทีอ่านแค่ data[0] ทำให้เสีย tick ไปจำนวนมาก และ tickCount ไม่ถึงขั้นต่ำ
            response.data.forEach(tick => {
                const currentPrice = tick.p;
                const tickTimeMs = tick.t;
                if (!currentPrice) return;

                processTickData(currentPrice).catch((error) => {
                    console.error('❌ Process tick failed:', error.message);
                });

                // [M1 ChoCh] สร้างแท่ง M1 จาก tick data โดยใช้ timestamp จริงจาก Finnhub
                aggregateM1Tick(currentPrice, tickTimeMs);
            });
        }
    });

    ws.on('close', function close() {
        clearHeartbeat();
        resetM1Builder(); // [M1 ChoCh] รีเซ็ตแท่ง M1 ที่ค้าง

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
