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
        // ดึงรายชื่อชีต (tabs) ทั้งหมดที่มีในไฟล์ปัจจุบัน
        const metadata = await sheetsClient.spreadsheets.get({ spreadsheetId });
        const sheetNames = metadata.data.sheets.map(s => s.properties.title);

        const requests = [];
        if (!sheetNames.includes('Signals')) {
            requests.push({ addSheet: { properties: { title: 'Signals' } } });
        }
        if (!sheetNames.includes('BotStatus')) {
            requests.push({ addSheet: { properties: { title: 'BotStatus' } } });
        }

        if (requests.length > 0) {
            console.log('📝 [Sheets]: กำลังสร้างแท็บที่ขาดหายไป...', requests.map(r => r.addSheet.properties.title).join(', '));
            await sheetsClient.spreadsheets.batchUpdate({
                spreadsheetId,
                requestBody: { requests }
            });
        }

        await ensureSheetHeader('Signals', 'A1:I1', SIGNALS_HEADERS);
        await ensureSheetHeader('BotStatus', 'A1:E1', BOT_STATUS_HEADERS);
        console.log('✅ [Sheets]: ตรวจสอบและสร้างหัวตารางเรียบร้อย');
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

async function loadTradesFromSheet() {
    if (!sheetsClient) return [];
    try {
        const res = await sheetsClient.spreadsheets.values.get({
            spreadsheetId,
            range: 'Signals!A:I'
        });
        const rows = res.data.values;
        if (!rows || rows.length <= 1) return [];

        const dataRows = rows.slice(1);
        const tradeGroups = {};

        for (let row of dataRows) {
            const timestamp = row[0];
            const direction = row[2];
            const entry = row[3];
            const type = row[8]; // คอลัมน์ที่ 9: ประเภท

            if (!entry || !type) continue;

            const key = `${direction}_${entry}`;
            if (!tradeGroups[key]) {
                tradeGroups[key] = {
                    timestamp,
                    direction,
                    entry: parseFloat(entry),
                    events: []
                };
            }
            tradeGroups[key].events.push(type);
        }

        const trades = [];
        for (let key in tradeGroups) {
            const group = tradeGroups[key];
            let outcome = 'PENDING';

            if (group.events.includes('TP2_HIT') || group.events.includes('TP1_HIT')) {
                outcome = 'WIN';
            } else if (group.events.includes('SL_HIT')) {
                outcome = 'LOSS';
            } else if (group.events.includes('TRIGGERED')) {
                outcome = 'PENDING';
            } else {
                continue; // ละเว้น PRE_ALERT, EXPIRED, INVALIDATED
            }

            trades.push({
                timestamp: group.timestamp,
                direction: group.direction,
                entry: group.entry,
                outcome
            });
        }
        return trades;
    } catch (err) {
        console.warn('⚠️  [Sheets]: loadTradesFromSheet() ล้มเหลว →', err.message);
        return [];
    }
}

async function getRecentSignals(limit = 20) {
    if (!sheetsClient) return [];
    try {
        const res = await sheetsClient.spreadsheets.values.get({
            spreadsheetId,
            range: 'Signals!A:I'
        });
        const rows = res.data.values;
        if (!rows || rows.length <= 1) return [];

        const dataRows = rows.slice(1).slice(-limit); // เอาแค่ N แถวล่าสุด
        return dataRows.map(row => ({
            time: row[0],
            zone: row[1],
            direction: row[2],
            entry: row[3] ? parseFloat(row[3]) : null,
            sl: row[4] ? parseFloat(row[4]) : null,
            tp1: row[5] ? parseFloat(row[5]) : null,
            tp2: row[6] ? parseFloat(row[6]) : null,
            currentPrice: row[7] ? parseFloat(row[7]) : null,
            type: row[8]
        }));
    } catch (err) {
        console.warn('⚠️  [Sheets]: getRecentSignals() ล้มเหลว →', err.message);
        return [];
    }
}

module.exports = { init, appendSignal, updateBotStatus, loadTradesFromSheet, getRecentSignals };
