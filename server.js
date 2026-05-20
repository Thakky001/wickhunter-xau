const express = require('express');
const keys = require('./config/keys');
const { startPriceStream } = require('./services/finnhubWs');

const app = express();

// Route สำหรับให้ UptimeRobot ยิง Ping กันเซิร์ฟเวอร์หลับ (Keep-Alive)
app.get('/', (req, res) => {
    res.send('🟢 WickHunter XAU is Active and Hunting!');
});

// เปิด Express Server
app.listen(keys.PORT, () => {
    console.log(`\n======================================`);
    console.log(`🚀 WickHunter XAU Server Run on Port ${keys.PORT}`);
    console.log(`======================================\n`);
    
    // สั่งให้เปิดท่อ WebSocket รับราคาทองคำทันทีที่รันเซิร์ฟเวอร์เสร็จ
    startPriceStream();
});