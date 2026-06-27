const fs = require('fs');
const path = require('path');

const API_KEY = 'f0a97593a1cc46f6996913e853387aeb';
const SYMBOL = 'XAU/USD';

const testDataDir = path.join(__dirname, '../test/data');
if (!fs.existsSync(testDataDir)) {
    fs.mkdirSync(testDataDir, { recursive: true });
}

// 5 years in ms
const FIVE_YEARS_MS = 5 * 365 * 24 * 60 * 60 * 1000;
const NOW = Date.now();
const TARGET_AGO_EPOCH = Math.floor((NOW - FIVE_YEARS_MS) / 1000);

// Helper to delay between API requests
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function fetchTwelveData(interval, name) {
    console.log(`\n📥 กำลังโหลดข้อมูล ${name} ย้อนหลัง 5 ปีจาก TwelveData (Interval: ${interval})...`);
    
    let allCandles = [];
    let currentEndDate = ''; // leave empty for first request (gets latest)
    let reachedTarget = false;

    // TwelveData limit per request for time_series is 5000 max.
    const outputsize = 5000;
    
    while (!reachedTarget) {
        try {
            let url = `https://api.twelvedata.com/time_series?symbol=${SYMBOL}&interval=${interval}&outputsize=${outputsize}&apikey=${API_KEY}&format=JSON`;
            if (currentEndDate !== '') {
                url += `&end_date=${currentEndDate}`;
            }

            const response = await fetch(url);
            const dataJson = await response.json();

            if (dataJson.status === 'error') {
                console.error(`❌ API Error: ${dataJson.message}`);
                // Rate limit or other error, wait and retry
                if (dataJson.code === 429) {
                    console.log('⏳ ติด Rate Limit รอ 1 นาทีก่อนลองใหม่...');
                    await delay(60000);
                    continue;
                } else {
                    break;
                }
            }

            const candles = dataJson.values;
            if (!candles || candles.length === 0) {
                console.log(`⚠️ ไม่พบข้อมูลเพิ่มเติมแล้ว`);
                break;
            }

            // TwelveData returns data from newest to oldest in the array
            for (let c of candles) {
                // Ensure datetime is parsed as UTC
                const epoch = Math.floor(new Date(c.datetime + ' UTC').getTime() / 1000);
                allCandles.push({
                    epoch: epoch,
                    open: parseFloat(c.open),
                    high: parseFloat(c.high),
                    low: parseFloat(c.low),
                    close: parseFloat(c.close)
                });
            }

            // The oldest candle is at the end of the array
            const oldestCandle = candles[candles.length - 1];
            const oldestEpoch = Math.floor(new Date(oldestCandle.datetime + ' UTC').getTime() / 1000);
            
            console.log(`✅ โหลดมาแล้ว ${allCandles.length} แท่ง (ย้อนไปถึง: ${oldestCandle.datetime})`);

            if (oldestEpoch <= TARGET_AGO_EPOCH) {
                reachedTarget = true;
            } else {
                // Next request should end just before the oldest datetime we just received
                currentEndDate = encodeURIComponent(oldestCandle.datetime);
                // Delay to prevent hitting rate limits (800 requests/day)
                await delay(1000); 
            }
        } catch (err) {
            console.error(`❌ Request failed: ${err.message}`);
            await delay(5000);
        }
    }

    // Sort from oldest to newest (Deriv format is oldest first)
    allCandles.sort((a, b) => a.epoch - b.epoch);

    // Filter out candles strictly within 5 years
    allCandles = allCandles.filter(c => c.epoch >= TARGET_AGO_EPOCH);

    const filePath = path.join(testDataDir, `twelvedata_xau_5y_${name.toLowerCase()}.json`);
    fs.writeFileSync(filePath, JSON.stringify(allCandles, null, 2));
    console.log(`💾 บันทึกไฟล์ ${filePath} สำเร็จ! (${allCandles.length} แท่ง)`);
}

async function main() {
    // 1h = H1, 5min = M5
    await fetchTwelveData('1h', 'H1');
    await fetchTwelveData('5min', 'M5');
    console.log('\n🎉 ดาวน์โหลดข้อมูลเสร็จสิ้นทั้งหมด!');
}

main();
