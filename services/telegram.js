const axios = require('axios');
const keys = require('../config/keys');

async function sendSignal(message) {
    if (!keys.TG_BOT_TOKEN || !keys.TG_CHAT_ID) {
        console.log("⚠️ ขาด Telegram Token หรือ Chat ID");
        return;
    }

    const url = `https://api.telegram.org/bot${keys.TG_BOT_TOKEN}/sendMessage`;
    try {
        await axios.post(url, {
            chat_id: keys.TG_CHAT_ID,
            text: message,
            parse_mode: 'HTML' // รองรับการทำตัวหนา <b>...</b>
        });
        console.log("✈️ ส่งแจ้งเตือนไปยัง Telegram สำเร็จ");
    } catch (error) {
        console.error("❌ ส่ง Telegram ล้มเหลว:", error.message);
    }
}

module.exports = { sendSignal };