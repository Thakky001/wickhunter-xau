const WebSocket = require('ws');
const keys = require('../config/keys');
const { processTickData } = require('../logic/smcEngine');

function startPriceStream() {
    if (!keys.FINNHUB_API_KEY) {
        console.error("❌ ขาด Finnhub API Key");
        return;
    }

    const ws = new WebSocket(`wss://ws.finnhub.io?token=${keys.FINNHUB_API_KEY}`);

    ws.on('open', function open() {
        console.log('🔗 WebSocket Connected: WickHunter กำลังดักซุ่มราคา OANDA:XAU_USD...');
        ws.send(JSON.stringify({ 'type': 'subscribe', 'symbol': 'OANDA:XAU_USD' }));
    });

    ws.on('message', function incoming(data) {
        const response = JSON.parse(data);
        if (response.type === 'trade') {
            // 🔥 Bug 4 Fix: Defensive Programming ป้องกันเซิร์ฟเวอร์แครช
            // ตรวจสอบว่ามีข้อมูล p (price) ส่งมาครบถ้วนก่อนดึงไปใช้งาน
            const currentPrice = response?.data?.[0]?.p;
            if (!currentPrice) return; 

            processTickData(currentPrice);
        }
    });

    ws.on('close', function close() {
        console.log('⚠️ WebSocket Disconnected กำลังพยายามเชื่อมต่อใหม่...');
        setTimeout(startPriceStream, 5000); 
    });
}

module.exports = { startPriceStream };