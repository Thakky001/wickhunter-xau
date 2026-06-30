const express = require('express');
const cors = require('cors');
const keys = require('./config/keys');
const { startDerivStream } = require('./services/derivWs');
const smcEngine = require('./logic/smcEngine');
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
        const result = await smcEngine.forceScanNow('dashboard');
        res.json(result);
    } catch (error) {
        console.error('❌ Force scan failed:', error.message);
        res.status(500).json({ ok: false, error: error.message });
    }
});

// Get current engine configuration
app.get('/api/config', (req, res) => {
    const { ENGINE_CONFIG } = require('./logic/smcEngine');
    res.json({
        USE_H4_FILTER: ENGINE_CONFIG.USE_H4_FILTER,
        USE_TRAILING_STOP: ENGINE_CONFIG.USE_TRAILING_STOP,
        USE_CE_ENTRY: ENGINE_CONFIG.USE_CE_ENTRY
    });
});

// Fetch historical candles for the chart
app.get('/api/candles', async (req, res) => {
    try {
        const { getCandles } = require('./services/derivWs');
        const candles = await getCandles('M5', 200); // Get last 200 M5 candles
        res.json(candles);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Update engine configuration
app.post('/api/config', express.json(), (req, res) => {
    const { updateConfig } = require('./logic/smcEngine');
    try {
        updateConfig(req.body);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
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
    const sheetsConnected = await sheets.init();
    if (sheetsConnected) {
        console.log('🔄 [Sheets]: กำลังเริ่มดึงประวัติจากชีตเพื่อคำนวณ Win Rate...');
        const pastTrades = await sheets.loadTradesFromSheet();
        dashboardState.initTrades(pastTrades);
        console.log(`📊 [Sheets]: Sync ประวัติการเทรดย้อนหลังสำเร็จ พบทั้งหมด ${pastTrades.length} ไม้`);

        console.log('🔄 [Sheets]: กำลังดึงประวัติ Signal ล่าสุดเพื่อกู้คืนสถานะ...');
        const recentSignals = await sheets.getRecentSignals(20);
        if (recentSignals.length > 0) {
            dashboardState.loadSignalHistory(recentSignals);
            smcEngine.resumeStateFromHistory(recentSignals);
        }
    }

    // สั่งให้เปิดท่อ WebSocket รับราคาทองคำทันทีที่รันเซิร์ฟเวอร์เสร็จ
    startDerivStream();
});
