const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');
require('dotenv').config();

const APP_ID = process.env.DERIV_APP_ID || '1089';
const SYMBOL = 'frxXAUUSD';

// Constants for time
const ONE_YEAR_MS = 365 * 24 * 60 * 60 * 1000;
const NOW = Date.now();
const TARGET_AGO_EPOCH = Math.floor((NOW - ONE_YEAR_MS) / 1000);

const testDataDir = path.join(__dirname, '../test/data');
if (!fs.existsSync(testDataDir)) {
    fs.mkdirSync(testDataDir, { recursive: true });
}

let ws;
let reqId = 1;
const pendingRequests = new Map();

function connect() {
    return new Promise((resolve, reject) => {
        ws = new WebSocket(`wss://ws.binaryws.com/websockets/v3?app_id=${APP_ID}`);
        ws.on('open', () => resolve());
        ws.on('error', (err) => reject(err));
        ws.on('message', (data) => {
            const response = JSON.parse(data);
            if (response.req_id && pendingRequests.has(response.req_id)) {
                pendingRequests.get(response.req_id)(response);
                pendingRequests.delete(response.req_id);
            }
        });
    });
}

function requestCandles(granularity, endEpoch, count = 5000) {
    return new Promise((resolve) => {
        const id = reqId++;
        pendingRequests.set(id, resolve);
        ws.send(JSON.stringify({
            ticks_history: SYMBOL,
            adjust_start_time: 1,
            count: count,
            end: endEpoch.toString(),
            style: 'candles',
            granularity: granularity,
            req_id: id
        }));
    });
}

async function fetchAllHistory(granularity, name) {
    console.log(`\n📥 กำลังโหลดข้อมูล ${name} ย้อนหลัง 1 ปี (Granularity: ${granularity})...`);
    let allCandles = [];
    let currentEnd = 'latest';
    let reachedTarget = false;

    while (!reachedTarget) {
        const response = await requestCandles(granularity, currentEnd, 5000);
        
        if (response.error) {
            console.error(`❌ Error fetching ${name}:`, response.error.message);
            break;
        }

        const candles = response.candles;
        if (!candles || candles.length === 0) {
            console.log(`⚠️ หมดข้อมูลสำหรับ ${name} แล้ว`);
            break;
        }

        // Deriv returns candles oldest to newest. We need to prepend them.
        allCandles = candles.concat(allCandles);
        const oldestEpoch = candles[0].epoch;
        
        console.log(`✅ โหลดมาแล้ว ${allCandles.length} แท่ง (ย้อนไปถึง: ${new Date(oldestEpoch * 1000).toLocaleString()})`);

        if (oldestEpoch <= TARGET_AGO_EPOCH) {
            reachedTarget = true;
        } else {
            // Next request should end just before the oldest epoch we just received
            currentEnd = oldestEpoch - 1;
            // Rate limit protection
            await new Promise(r => setTimeout(r, 500));
        }
    }

    // Filter out candles strictly within 3 years
    allCandles = allCandles.filter(c => c.epoch >= TARGET_AGO_EPOCH);
    
    // Format to our standard format
    const formatted = allCandles.map(c => ({
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        time: c.epoch
    }));

    const filePath = path.join(testDataDir, `xau_1y_${name.toLowerCase()}.json`);
    fs.writeFileSync(filePath, JSON.stringify(formatted, null, 2));
    console.log(`💾 บันทึกไฟล์ ${filePath} สำเร็จ! (${formatted.length} แท่ง)`);
}

async function main() {
    try {
        console.log('🔄 กำลังเชื่อมต่อ Deriv WebSocket...');
        await connect();
        
        // H1 = 3600, M5 = 300
        await fetchAllHistory(3600, 'H1');
        await fetchAllHistory(300, 'M5');

        console.log('\n🎉 ดาวน์โหลดข้อมูลสำเร็จทั้งหมด! ปิดการเชื่อมต่อ...');
        ws.close();
    } catch (error) {
        console.error('❌ Critical Error:', error);
        if (ws) ws.close();
    }
}

main();
