const { google } = require('googleapis');
const keys = require('../config/keys');

let sheetsClient = null;
let spreadsheetId = null;

const SIGNALS_HEADERS = ['เวลา', 'โซน', 'ทิศทาง', 'Entry', 'SL', 'TP1', 'TP2', 'ราคาปัจจุบัน', 'ประเภท'];
const BOT_STATUS_HEADERS = ['เวลา', 'สถานะบอท', 'จำนวนโซน', 'ปิด M5 ล่าสุด', 'WebSocket'];

function isRowEmpty(row) {
    return !row || row.length === 0 || row.every((cell) => cell == null || String(cell).trim() === '');
}

async function ensureSheetHeader(sheetName, range, headers) {
    const res = await sheetsClient.spreadsheets.values.get({
        spreadsheetId,
        range: `${sheetName}!${range}`
    });
    if (!isRowEmpty(res.data.values?.[0])) return;

    await sheetsClient.spreadsheets.values.update({
        spreadsheetId,
        range: `${sheetName}!${range}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: [headers] }
    });
}

async function ensureHeaders() {
    if (!sheetsClient) return;
    try {
        await ensureSheetHeader('Signals', 'A1:I1', SIGNALS_HEADERS);
        await ensureSheetHeader('BotStatus', 'A1:E1', BOT_STATUS_HEADERS);
        console.log('✅ [Sheets]: ตรวจสอบหัวตารางเรียบร้อย');
    } catch (err) {
        console.warn('⚠️  [Sheets]: ensureHeaders() ล้มเหลว →', err.message);
    }
}

async function init() {
    try {
        const rawCreds = keys.GOOGLE_CREDENTIALS;
        spreadsheetId = keys.GOOGLE_SHEET_ID;

        if (!rawCreds || !spreadsheetId) {
            console.warn('⚠️  [Sheets]: GOOGLE_CREDENTIALS หรือ GOOGLE_SHEET_ID ไม่ได้ตั้งค่า → ข้าม Google Sheets');
            return false;
        }

        let credentials;
        try {
            // ลอง base64 decode ก่อน
            const decoded = Buffer.from(rawCreds, 'base64').toString('utf-8');
            credentials = JSON.parse(decoded);
        } catch (e) {
            // fallback: plain JSON parse
            credentials = JSON.parse(rawCreds);
        }

        const auth = new google.auth.GoogleAuth({
            credentials,
            scopes: ['https://www.googleapis.com/auth/spreadsheets']
        });

        sheetsClient = google.sheets({ version: 'v4', auth });
        console.log('✅ [Sheets]: เชื่อมต่อ Google Sheets สำเร็จ');
        await ensureHeaders();
        return true;
    } catch (err) {
        console.warn('⚠️  [Sheets]: init() ล้มเหลว →', err.message);
        return false;
    }
}

async function appendSignal(data) {
    if (!sheetsClient) return;
    try {
        const timestamp = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
        const row = [
            timestamp,
            data.zone || '',
            data.direction || '',
            data.entry != null ? data.entry : '',
            data.sl != null ? data.sl : '',
            data.tp1 != null ? data.tp1 : '',
            data.tp2 != null ? data.tp2 : '',
            data.currentPrice != null ? data.currentPrice : '',
            data.type || ''
        ];

        await sheetsClient.spreadsheets.values.append({
            spreadsheetId,
            range: 'Signals!A:I',
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [row] }
        });
    } catch (err) {
        console.warn('⚠️  [Sheets]: appendSignal() ล้มเหลว →', err.message);
    }
}

async function updateBotStatus(data) {
    if (!sheetsClient) return;
    try {
        const timestamp = new Date().toLocaleString('th-TH', { timeZone: 'Asia/Bangkok' });
        const row = [
            timestamp,
            data.state || '',
            data.zonesFound != null ? data.zonesFound : '',
            data.lastM5Close != null ? data.lastM5Close : '',
            data.wsStatus || ''
        ];

        await sheetsClient.spreadsheets.values.update({
            spreadsheetId,
            range: 'BotStatus!A2:E2',
            valueInputOption: 'USER_ENTERED',
            requestBody: { values: [row] }
        });
    } catch (err) {
        console.warn('⚠️  [Sheets]: updateBotStatus() ล้มเหลว →', err.message);
    }
}

module.exports = { init, appendSignal, updateBotStatus };
