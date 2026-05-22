const express = require('express');
const keys = require('./config/keys');
const { startPriceStream } = require('./services/finnhubWs');
const { forceScanNow } = require('./logic/smcEngine');
const dashboardState = require('./services/dashboardState');
const sheets = require('./services/sheets');

const app = express();

// Serve static files from 'public' directory
app.use(express.static('public'));

// SSE clients array
const sseClients = [];

// Route สำหรับให้ UptimeRobot ยิง Ping กันเซิร์ฟเวอร์หลับ (Keep-Alive)
app.get('/', (req, res) => {
    res.send('🟢 WickHunter XAU is Active and Hunting!');
});

// SSE endpoint for real-time dashboard updates
app.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    // Send current state immediately on connect
    res.write(`data: ${JSON.stringify(dashboardState.state)}\n\n`);

    sseClients.push(res);

    req.on('close', () => {
        const idx = sseClients.indexOf(res);
        if (idx !== -1) sseClients.splice(idx, 1);
    });
});

// Debug status endpoint
app.get('/status', (req, res) => {
    res.json(dashboardState.state);
});

// Force the bot back to SCANNING and run one scan immediately.
app.post('/force-scan', async (req, res) => {
    try {
        const result = await forceScanNow('dashboard');
        res.json(result);
    } catch (error) {
        console.error('❌ Force scan failed:', error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// Broadcast state updates to all SSE clients
dashboardState.emitter.on('stateUpdate', (state) => {
    const payload = `data: ${JSON.stringify(state)}\n\n`;
    for (const client of sseClients) {
        client.write(payload);
    }
});

// เปิด Express Server
app.listen(keys.PORT, async () => {
    console.log(`\n======================================`);
    console.log(`🚀 WickHunter XAU Server Run on Port ${keys.PORT}`);
    console.log(`======================================\n`);

    // Initialize Google Sheets
    await sheets.init();

    // สั่งให้เปิดท่อ WebSocket รับราคาทองคำทันทีที่รันเซิร์ฟเวอร์เสร็จ
    startPriceStream();
});
