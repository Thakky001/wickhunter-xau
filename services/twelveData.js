const axios = require('axios');
const keys = require('../config/keys');

/**
 * ดึงข้อมูลแท่งเทียนจริงจาก Twelve Data (ฟรี 800 ครั้ง/วัน)
 * @param {string} resolution '60' สำหรับ H1, '5' สำหรับ M5
 * @param {number} limit จำนวนแท่งเทียนย้อนหลังที่ต้องการ
 */
async function getCandles(resolution, limit) {
    let interval = '1h'; // ค่าเริ่มต้นเป็น H1

    if (resolution === '5') {
        interval = '5min'; // รูปแบบของ Twelve Data ใช้คำว่า '5min'
    }

    // Ticker ของทองคำใน Twelve Data คือ XAU/USD
    const url = `https://api.twelvedata.com/time_series?symbol=XAU/USD&interval=${interval}&outputsize=${limit}&apikey=${keys.TWELVEDATA_API_KEY}`;

    try {
        const response = await axios.get(url);
        const data = response.data;

        // ตรวจสอบว่าดึงข้อมูลสำเร็จ (Twelve Data ส่งสถานะ 'ok')
        if (data.status === 'ok' && data.values) {
            
            // สำคัญ: Twelve Data ส่งข้อมูลจาก "ใหม่ไปเก่า" 
            // เราต้องใช้ .reverse() พลิกกลับให้เป็น "เก่าไปใหม่" เพื่อให้คณิตศาสตร์ SMC คำนวณถูก
            const rawValues = data.values.reverse();
            let candles = [];

            for (let i = 0; i < rawValues.length; i++) {
                const q = rawValues[i];
                
                candles.push({
                    open: parseFloat(q.open),
                    high: parseFloat(q.high),
                    low: parseFloat(q.low),
                    close: parseFloat(q.close),
                    time: new Date(q.datetime).getTime() / 1000
                });
            }
            return candles;
            
        } else {
            console.log(`⚠️ Twelve Data Error: ${data.message || 'ไม่พบข้อมูล'}`);
            return [];
        }
    } catch (error) {
        console.error(`❌ ดึงข้อมูล Twelve Data ล้มเหลว:`, error.message);
        return [];
    }
}

module.exports = { getCandles };
