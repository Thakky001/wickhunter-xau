const WebSocket = require('ws');
const keys = require('../config/keys');
const { processTickData } = require('../logic/smcEngine');

function startPriceStream() {
    if (!keys.FINNHUB_API_KEY) {
        console.error("❌ ขาด Finnhub API Key");
        return;
    }

    const ws = new WebSocket(`wss://ws.finnhub.io?token=${keys.FINNHUB_API_KEY}`);

    // ─── Heartbeat: ส่ง Ping ทุก 20 วินาที เพื่อป้องกัน Connection หลุด ───
    let heartbeatTimer = null;

    ws.on('open', function open() {
        console.log('🔗 WebSocket Connected: WickHunter กำลังดักซุ่มราคา OANDA:XAU_USD...');
        ws.send(JSON.stringify({ 'type': 'subscribe', 'symbol': 'OANDA:XAU_USD' }));

        // เริ่ม Heartbeat หลังจาก Connect สำเร็จ
        heartbeatTimer = setInterval(() => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.ping(); // ส่ง Ping ไปหา Finnhub เพื่อบอกว่ายังอยู่
            }
        }, 20000); // ทุก 20 วินาที
    });

    ws.on('message', function incoming(data) {
        const response = JSON.parse(data);
        if (response.type === 'trade') {
            const currentPrice = response?.data?.[0]?.p;
            if (!currentPrice) return;
            processTickData(currentPrice);
        }
    });

    ws.on('close', function close() {
        console.log('⚠️ WebSocket Disconnected กำลังพยายามเชื่อมต่อใหม่...');
        // หยุด Heartbeat ก่อนเพื่อป้องกัน Memory Leak
        if (heartbeatTimer) {
            clearInterval(heartbeatTimer);
            heartbeatTimer = null;
        }
        setTimeout(startPriceStream, 5000);
    });

    ws.on('error', function error(err) {
        console.error('❌ WebSocket Error:', err.message);
        // ปล่อยให้ 'close' event จัดการ Reconnect ต่อเอง
    });
}

module.exports = { startPriceStream };