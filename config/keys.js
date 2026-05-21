require('dotenv').config();

module.exports = {
    PORT: process.env.PORT || 8080,
    FINNHUB_API_KEY: process.env.FINNHUB_API_KEY,
    TWELVEDATA_API_KEY: process.env.TWELVEDATA_API_KEY, // <--- เพิ่มบรรทัดนี้
    TG_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TG_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
    GOOGLE_SHEET_ID: process.env.GOOGLE_SHEET_ID,
    GOOGLE_CREDENTIALS: process.env.GOOGLE_CREDENTIALS
};