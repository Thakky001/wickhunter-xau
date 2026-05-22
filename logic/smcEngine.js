const { sendSignal } = require('../services/telegram');
const { findFVG, findOrderBlock, checkPriceActionInZone, checkChoCh } = require('./smcMath');
const { getCandles } = require('../services/twelveData');
const dashboardState = require('../services/dashboardState');
const sheets = require('../services/sheets');

const STATES = {
    SCANNING: 'SCANNING',
    WAITING_WICK_BREAK: 'WAITING_WICK_BREAK',
    TRIGGERED: 'TRIGGERED'
};

const PRE_ALERT_TIMEOUT_MS = 15 * 60 * 1000;
const TICK_STALE_MS = 60 * 1000;
const WAITING_GUARD_INTERVAL_MS = 30 * 1000;
const FALLBACK_CHECK_COOLDOWN_MS = 60 * 1000;

let currentState = STATES.SCANNING;
let referenceWickPrice = 0;
let cancelPrice = 0; // เปลี่ยนชื่อตัวแปรให้ตรงกับความหมาย (ขอบโซน)
let signalDirection = '';

let cachedH1Candles = [];
let lastH1FetchHour = -1;
let isCheckingMarket = false;
let waitingStartedAt = null;
let lastTickAt = Date.now();
let lastFallbackCheckAt = 0;
let isCheckingWaitingGuard = false;

function clearActiveSignal() {
    referenceWickPrice = 0;
    cancelPrice = 0;
    signalDirection = '';
    waitingStartedAt = null;
    lastFallbackCheckAt = 0;
}

function isMarketOpen() {
    const now = new Date();
    const day = now.getUTCDay();
    const hour = now.getUTCHours();

    if (day === 6) {
        return false;
    }
    if (day === 0) {
        return hour >= 22;
    }
    if (day === 5) {
        return hour < 22;
    }

    return true;
}

async function checkMarketLogic() {
    if (isCheckingMarket) {
        console.log("⏳ [SMC Engine]: รอบสแกนก่อนหน้ายังทำงานอยู่ ข้ามรอบนี้ก่อน");
        return;
    }

    isCheckingMarket = true;

    try {
    if (!isMarketOpen()) {
        console.log("💤 ตลาดทองคำปิดทำการ บอทเข้าสู่โหมดพักผ่อน...");
        return;
    }

    if (currentState === STATES.SCANNING) {
        const currentHour = new Date().getHours();
        if (cachedH1Candles.length === 0 || currentHour !== lastH1FetchHour) {
            cachedH1Candles = await getCandles('60', 50);
            lastH1FetchHour = currentHour;
            if (cachedH1Candles.length > 0) {
                console.log(`🔄 [SMC Engine]: อัปเดตข้อมูลแท่งเทียน H1 ใหม่ (ชั่วโมงที่ ${currentHour})`);
            }
        }

        const m5Candles = await getCandles('5', 15);

        if (cachedH1Candles.length === 0 || m5Candles.length < 2) {
            console.log(`⚠️  [DEBUG]: ดึงข้อมูลแท่งเทียนไม่สำเร็จหรือได้มาไม่ครบ → ข้ามรอบนี้`);
            return;
        }

        const closedH1Candles = cachedH1Candles.slice(0, -1);

        const fvgs = findFVG(closedH1Candles);
        const obs = findOrderBlock(closedH1Candles);
        const allZones = [...fvgs, ...obs];

        const closedM5Candle = m5Candles[m5Candles.length - 2];
        const closedM5Array = m5Candles.slice(0, -1); 

        // ─── DEBUG: สรุปผลการสแกนรอบนี้ ───────────────────────────────
        const now = new Date().toLocaleTimeString('th-TH');
        console.log(`\n─────────────────────────────────────────`);
        console.log(`🔍 [SCAN] ${now} | State: ${currentState}`);
        console.log(`   📊 H1 Zones พบทั้งหมด: ${allZones.length} โซน (FVG: ${fvgs.length}, OB: ${obs.length})`);
        console.log(`   🕯️  M5 แท่งปิดล่าสุด | O:${closedM5Candle.open.toFixed(2)} H:${closedM5Candle.high.toFixed(2)} L:${closedM5Candle.low.toFixed(2)} C:${closedM5Candle.close.toFixed(2)}`);
        // ───────────────────────────────────────────────────────────────

        // อัปเดต Dashboard State และ Google Sheets หลังสแกนเสร็จ
        dashboardState.update({
            botState: currentState,
            zonesFound: { fvg: fvgs.length, ob: obs.length, total: allZones.length },
            lastM5: {
                open: closedM5Candle.open,
                high: closedM5Candle.high,
                low: closedM5Candle.low,
                close: closedM5Candle.close
            }
        });
        sheets.updateBotStatus({
            state: currentState,
            zonesFound: allZones.length,
            lastM5Close: closedM5Candle.close,
            wsStatus: 'CONNECTED'
        });

        let foundPA = false;
        for (let zone of allZones) {
            const paResult = checkPriceActionInZone(closedM5Candle, zone);

            if (paResult.isValid) {
                foundPA = true;
                console.log(`   ✨ พบ PA ในโซน [${zone.name}] (${zone.bottom.toFixed(2)} - ${zone.top.toFixed(2)}) | Direction: ${paResult.direction}`);

                const hasChoCh = checkChoCh(closedM5Array, paResult.direction);
                if (!hasChoCh) {
                    console.log(`   ⏭️  ยังไม่เกิด ChoCh ใน M5 → ข้ามโซนนี้ไปก่อน`);
                    continue; // ข้ามโซนนี้ รอโซนถัดไป
                }
                
                referenceWickPrice = paResult.triggerWickPrice;
                cancelPrice = paResult.cancelPrice;
                signalDirection = paResult.direction;
                waitingStartedAt = Date.now();
                lastTickAt = Date.now();
                lastFallbackCheckAt = 0;
                currentState = STATES.WAITING_WICK_BREAK;
                dashboardState.update({ botState: currentState });

                // คำนวณระยะความเสี่ยง (Risk) และเป้าหมาย TP (Reward) 
                const risk = Math.abs(referenceWickPrice - cancelPrice);
                const tp1 = signalDirection === 'BUY' ? referenceWickPrice + (risk * 2) : referenceWickPrice - (risk * 2);

                console.log(`\n🔥 [SMC Engine]: ผ่านทุกเงื่อนไข! เข้าสถานะ WAITING_WICK_BREAK`);
                console.log(`   🎯 รอเบรกปลายไส้ที่: ${referenceWickPrice.toFixed(2)} | SL: ${cancelPrice.toFixed(2)}`);

                // PRE_ALERT: อัปเดต Dashboard State และ Sheets
                dashboardState.addSignal({
                    type: 'PRE_ALERT',
                    zone: zone.name,
                    direction: signalDirection,
                    entry: referenceWickPrice,
                    sl: cancelPrice,
                    tp1: tp1,
                    time: new Date().toISOString()
                });
                sheets.appendSignal({
                    type: 'PRE_ALERT',
                    zone: zone.name,
                    direction: signalDirection,
                    entry: referenceWickPrice,
                    sl: cancelPrice,
                    tp1: tp1,
                    tp2: null,
                    currentPrice: closedM5Candle.close
                });

                const previewMsg = `⏳ <b>เตรียมตัว! พบการกลับตัวในโซน ${zone.name} H1</b>\n\n` +
                    `ดักรอการ <b>เบรกปลายไส้ (M5)</b> ฝั่ง ${signalDirection}\n\n` +
                    `📍 <b>Entry:</b> ${referenceWickPrice.toFixed(2)}\n` +
                    `🛑 <b>SL (Zone Edge):</b> ${cancelPrice.toFixed(2)}\n` +
                    `🎯 <b>TP (1:2):</b> ${tp1.toFixed(2)}`;

                await sendSignal(previewMsg);
                break;
            }
        }

        if (!foundPA) {
            console.log(`   😴 ยังไม่พบ PA ที่ผ่านเงื่อนไขในโซนไหนเลย → รอรอบหน้า (2 นาที)`);
        }
        console.log(`─────────────────────────────────────────`);
    }
    } finally {
        isCheckingMarket = false;
    }
}

async function forceScanNow(reason = 'manual') {
    const previousState = currentState;

    currentState = STATES.SCANNING;
    clearActiveSignal();

    console.log(`🔄 [SMC Engine]: Force scan requested (${reason}) | Previous state: ${previousState}`);
    dashboardState.update({ botState: currentState });

    await checkMarketLogic();

    return {
        ok: true,
        previousState,
        currentState
    };
}

async function expireWaitingSignal() {
    if (currentState !== STATES.WAITING_WICK_BREAK) return;

    const direction = signalDirection;
    const entry = referenceWickPrice;
    const sl = cancelPrice;

    currentState = STATES.SCANNING;
    console.log(`⌛ [SMC Engine]: PRE_ALERT ${direction} หมดอายุ ระบบกลับไป SCANNING`);
    dashboardState.update({ botState: currentState });
    dashboardState.addSignal({
        type: 'EXPIRED',
        direction,
        entry,
        sl,
        time: new Date().toISOString()
    });
    sheets.appendSignal({
        type: 'EXPIRED',
        direction,
        entry,
        sl
    });
    clearActiveSignal();

    await sendSignal(`⌛ <b>หมดอายุสัญญาณ ${direction}</b>\n\nรอเบรกนานเกิน 15 นาที แต่ราคาไม่ถึง Entry/SL ระบบกลับไปสแกนหาโซนใหม่แล้ว`);
}

async function checkWaitingGuard() {
    if (currentState !== STATES.WAITING_WICK_BREAK || isCheckingWaitingGuard) return;

    const now = Date.now();
    if (waitingStartedAt && now - waitingStartedAt >= PRE_ALERT_TIMEOUT_MS) {
        isCheckingWaitingGuard = true;
        try {
            await expireWaitingSignal();
        } finally {
            isCheckingWaitingGuard = false;
        }
        return;
    }

    if (now - lastTickAt < TICK_STALE_MS) return;
    if (now - lastFallbackCheckAt < FALLBACK_CHECK_COOLDOWN_MS) return;

    isCheckingWaitingGuard = true;
    lastFallbackCheckAt = now;
    try {
        console.log("🛰️ [SMC Engine]: Finnhub tick ขาดช่วง → เช็ก M5 จาก TwelveData fallback");
        const m5Candles = await getCandles('5', 2);
        const latestCandle = m5Candles[m5Candles.length - 1];

        if (!latestCandle) {
            console.log("⚠️ [SMC Engine]: fallback ไม่พบแท่ง M5 ล่าสุด");
            return;
        }

        if (signalDirection === 'BUY') {
            if (latestCandle.low <= cancelPrice) {
                await processTickData(latestCandle.low, 'fallback');
            } else if (latestCandle.high >= referenceWickPrice) {
                await processTickData(latestCandle.high, 'fallback');
            }
        } else if (signalDirection === 'SELL') {
            if (latestCandle.high >= cancelPrice) {
                await processTickData(latestCandle.high, 'fallback');
            } else if (latestCandle.low <= referenceWickPrice) {
                await processTickData(latestCandle.low, 'fallback');
            }
        }
    } finally {
        isCheckingWaitingGuard = false;
    }
}

async function processTickData(currentPrice, source = 'tick') {
    const price = Number(currentPrice);
    if (!Number.isFinite(price)) return;

    if (source === 'tick') {
        lastTickAt = Date.now();
    }

    if (currentState === STATES.WAITING_WICK_BREAK) {
        const sourceLabel = source === 'fallback' ? 'FALLBACK' : 'TICK';
        const sourceNote = source === 'fallback'
            ? '\n\n⚠️ ตรวจพบจาก TwelveData fallback เพราะ Finnhub tick ขาดช่วง'
            : '';
        console.log(`📡 [${sourceLabel}] ราคาปัจจุบัน: ${price.toFixed(2)} (รอเบรก: ${referenceWickPrice.toFixed(2)})`);
        let isBreakout = false;
        let isInvalidated = false;

        if (signalDirection === 'BUY') {
            if (price >= referenceWickPrice) isBreakout = true;
            if (price <= cancelPrice) isInvalidated = true; // ถ้าราคาร่วงหลุดขอบโซนล่าง
        } else if (signalDirection === 'SELL') {
            if (price <= referenceWickPrice) isBreakout = true;
            if (price >= cancelPrice) isInvalidated = true; // ถ้าราคาพุ่งทะลุขอบโซนบน
        }

        if (isInvalidated) {
            currentState = STATES.SCANNING;
            waitingStartedAt = null;
            console.log(`❌ [SMC Engine]: กราฟผิดทาง! ราคาทะลุขอบโซน (${cancelPrice}) ระบบกลับไป SCANNING`);
            dashboardState.update({ botState: currentState });

            // INVALIDATED: อัปเดต Dashboard State และ Sheets
            dashboardState.addSignal({
                type: 'INVALIDATED',
                direction: signalDirection,
                entry: referenceWickPrice,
                sl: cancelPrice,
                currentPrice: price,
                time: new Date().toISOString()
            });
            sheets.appendSignal({
                type: 'INVALIDATED',
                direction: signalDirection,
                entry: referenceWickPrice,
                sl: cancelPrice,
                currentPrice: price
            });

            await sendSignal(`❌ <b>ยกเลิกสัญญาณ ${signalDirection}</b>\n\nกราฟผิดทาง ทะลุจุด SL ขอบโซนที่ <b>${cancelPrice.toFixed(2)}</b> ก่อนการเบรก ระบบกลับสู่โหมดสแกนหาโซนใหม่...${sourceNote}`);
            return;
        }

        if (isBreakout) {
            currentState = STATES.TRIGGERED;
            waitingStartedAt = null;
            dashboardState.update({ botState: currentState });

            const slPrice = cancelPrice;
            const risk = Math.abs(referenceWickPrice - slPrice);
            let tp1Price = 0;
            let tp2Price = 0;

            if (signalDirection === 'BUY') {
                tp1Price = referenceWickPrice + (risk * 2);
                tp2Price = referenceWickPrice + (risk * 3);
            } else if (signalDirection === 'SELL') {
                tp1Price = referenceWickPrice - (risk * 2);
                tp2Price = referenceWickPrice - (risk * 3);
            }

            // TRIGGERED: อัปเดต Dashboard State และ Sheets
            dashboardState.addSignal({
                type: 'TRIGGERED',
                direction: signalDirection,
                entry: referenceWickPrice,
                sl: slPrice,
                tp1: tp1Price,
                tp2: tp2Price,
                currentPrice: price,
                time: new Date().toISOString()
            });
            sheets.appendSignal({
                type: 'TRIGGERED',
                direction: signalDirection,
                entry: referenceWickPrice,
                sl: slPrice,
                tp1: tp1Price,
                tp2: tp2Price,
                currentPrice: price
            });

            const msg = `🔥 <b>WickHunter XAU | SIGNAL TRIGGERED</b> 🔥\n\n` +
                `✅ <b>Direction:</b> ${signalDirection}\n` +
                `✅ <b>Action:</b> เคลียร์ไส้เทียนสำเร็จ!\n\n` +
                `📍 <b>Entry Price:</b> ${referenceWickPrice.toFixed(2)}\n` +
                `🛑 <b>Stop Loss:</b> ${slPrice.toFixed(2)}\n` +
                `🎯 <b>TP 1 (RR 1:2):</b> ${tp1Price.toFixed(2)}\n` +
                `🎯 <b>TP 2 (RR 1:3):</b> ${tp2Price.toFixed(2)}\n\n` +
                `🚀 <b>Current Price:</b> ${price.toFixed(2)}${sourceNote}`;

            await sendSignal(msg);
            console.log(`🟢 [SMC Engine]: สัญญาณถูกส่งแล้ว! รีเซ็ตระบบกลับสู่โหมดสแกนใน 5 นาที...`);

            setTimeout(() => {
                currentState = STATES.SCANNING;
                console.log("🔄 [SMC Engine]: กลับสู่โหมด SCANNING รอโซนถัดไป");
                dashboardState.update({ botState: currentState });
            }, 300000);
        }
    }
}

setInterval(checkMarketLogic, 120000);
setInterval(checkWaitingGuard, WAITING_GUARD_INTERVAL_MS);

checkMarketLogic();

module.exports = { processTickData, forceScanNow };
