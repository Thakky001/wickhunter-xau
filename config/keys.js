require('dotenv').config();

module.exports = {
    PORT: process.env.PORT || 8080,
    TG_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TG_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
    GOOGLE_SHEET_ID: process.env.GOOGLE_SHEET_ID,
    GOOGLE_CREDENTIALS: process.env.GOOGLE_CREDENTIALS,
    DERIV_APP_ID: process.env.DERIV_APP_ID || "1089" // ค่า Default 1089 (Deriv standard app id) สำหรับใช้ทดสอบเบื้องต้นได้
};