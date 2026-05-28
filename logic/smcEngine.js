const { sendSignal } = require('../services/telegram');
const { findFVG, findOrderBlock, checkPriceActionInZone, checkChoCh, getHTFTrend } = require('./smcMath');
const { getCandles } = require('../services/twelveData');
const dashboardState = require('../services/dashboardState');
const sheets = require('../services/sheets');

const STATES = {
    SCANNING: 'SCANNING',
    WAITING_WICK_BREAK: 'WAITING_WICK_BREAK',
    TRIGGERED: 'TRIGGERED'
};

const ENGINE_CONFIG = {
    SL_MODE: 'PA_WICK',          // 'PA_WICK' (อิงระดับ M5) หรือ 'ZONE_EDGE' (ขอบโซน H1 แบบเดิม)
    SL_BUFFER: 2.0,              // ระยะเผื่อสะบัดปลายไส้ (2.0 USD หรือ 200 จุด)
    MAX_SL_POINTS: 12.0,         // จำกัดระยะ SL สูงสุดไม่เกิน 12.0 USD (1,200 จุด)
    MIN_TP_POINTS: 10.0,         // จำกัดระยะ TP ขั้นต่ำไม่น้อยกว่า 10.0 USD (1,000 จุด)
    ENTRY_MODE: 'CANDLE_CLOSE',  // [Fix#2] สลับเป็น CANDLE_CLOSE เพื่อเข้าที่ราคาปิดแท่ง PA (ไม่ใช่ยอด High ที่เป็น Resistance)
    MAX_ZONE_AGE_HOURS: 48       // กรองโซน H1 ย้อนหลังไม่เกิน 48 ชั่วโมง
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
            cachedH1Candles = await getCandles('60', 75);
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

        // กรองหาเฉพาะโซนที่สดใหม่ย้อนหลังไม่เกินอายุที่กำหนด (เช่น MAX_ZONE_AGE_HOURS = 24)
        const candlesToScan = closedH1Candles.slice(-ENGINE_CONFIG.MAX_ZONE_AGE_HOURS);
        const fvgs = findFVG(candlesToScan);
        const obs = findOrderBlock(candlesToScan);
        const allZones = [...fvgs, ...obs];

        // [HTF Filter] คำนวณทิศทาง H4 จาก H1 ที่มีอยู่แล้ว ไม่ใช้ API เพิ่ม
        const htfTrend = getHTFTrend(closedH1Candles);

        const closedM5Candle = m5Candles[m5Candles.length - 2];
        const closedM5Array = m5Candles.slice(0, -1);
        // ─── DEBUG: สรุปผลการสแกนรอบนี้ ───────────────────────────────
        const now = new Date().toLocaleTimeString('th-TH');
        console.log(`\n─────────────────────────────────────────`);
        console.log(`🔍 [SCAN] ${now} | State: ${currentState}`);
        console.log(`   📊 H1 Zones พบทั้งหมด: ${allZones.length} โซน (FVG: ${fvgs.length}, OB: ${obs.length})`);
        console.log(`   📈 [HTF Trend H4]: ${htfTrend} → รับสัญญาณ: ${htfTrend === 'BULLISH' ? 'BUY เท่านั้น' : htfTrend === 'BEARISH' ? 'SELL เท่านั้น' : 'ทั้ง BUY และ SELL (Neutral)'}`);
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
        let foundValidSignal = false;
        for (let zone of allZones) {
            // [HTF Filter] ข้ามโซนที่สวนทางกับ HTF Trend
            if (htfTrend === 'BEARISH' && zone.type === 'BUY_ZONE') {
                console.log(`   🚫 [HTF] ข้าม ${zone.name} เพราะ H4 Bearish → ห้าม BUY`);
                continue;
            }
            if (htfTrend === 'BULLISH' && zone.type === 'SELL_ZONE') {
                console.log(`   🚫 [HTF] ข้าม ${zone.name} เพราะ H4 Bullish → ห้าม SELL`);
                continue;
            }

            const paResult = checkPriceActionInZone(closedM5Candle, zone);

            if (paResult.isValid) {
                foundPA = true;
                console.log(`   ✨ พบ PA ในโซน [${zone.name}] (${zone.bottom.toFixed(2)} - ${zone.top.toFixed(2)}) | Direction: ${paResult.direction}`);

                const hasChoCh = checkChoCh(closedM5Array, paResult.direction);
                if (!hasChoCh) {
                    console.log(`   ⏭️  [Bug#4 Fix] พบ PA แต่ยังไม่เกิด ChoCh ใน M5 → ข้ามโซนนี้ไปก่อน`);
                    continue; // ข้ามโซนนี้ รอโซนถัดไป
                }
                foundValidSignal = true;
                
                signalDirection = paResult.direction;

                // 🌟 โหมด ENTRY_MODE === 'CANDLE_CLOSE' (เข้าทันทีที่ปิดแท่ง PA M5 ยืนยันสัญญาณ)
                if (ENGINE_CONFIG.ENTRY_MODE === 'CANDLE_CLOSE') {
                    referenceWickPrice = closedM5Candle.close; // ใช้ราคาปิดเป็นจุดเข้า

                    // [Bug#3 Fix] CANDLE_CLOSE mode ต้องใช้ PA_WICK เสมอ
                    // เพราะ entry คือ candle.close (กลางแท่ง) ถ้าใช้ Zone Edge SL จะกว้างเกิน R:R บิดเบือน
                    cancelPrice = signalDirection === 'BUY' 
                        ? paResult.paCandleLow - ENGINE_CONFIG.SL_BUFFER 
                        : paResult.paCandleHigh + ENGINE_CONFIG.SL_BUFFER;

                    let risk = Math.abs(referenceWickPrice - cancelPrice);
                    if (risk > ENGINE_CONFIG.MAX_SL_POINTS) {
                        risk = ENGINE_CONFIG.MAX_SL_POINTS;
                        cancelPrice = signalDirection === 'BUY' ? referenceWickPrice - risk : referenceWickPrice + risk;
                    }
                    
                    const minRisk = ENGINE_CONFIG.MIN_TP_POINTS / 2;
                    if (risk < minRisk) {
                        risk = minRisk;
                    }

                    const tp1Price = signalDirection === 'BUY' ? referenceWickPrice + (risk * 2) : referenceWickPrice - (risk * 2);
                    const tp2Price = signalDirection === 'BUY' ? referenceWickPrice + (risk * 3) : referenceWickPrice - (risk * 3);

                    currentState = STATES.TRIGGERED;
                    dashboardState.update({ botState: currentState });

                    // TRIGGERED: ส่งสัญญาณอัปเดตและบันทึก
                    dashboardState.addSignal({
                        type: 'TRIGGERED',
                        direction: signalDirection,
                        entry: referenceWickPrice,
                        sl: cancelPrice,
                        tp1: tp1Price,
                        tp2: tp2Price,
                        currentPrice: referenceWickPrice,
                        time: new Date().toISOString()
                    });
                    sheets.appendSignal({
                        type: 'TRIGGERED',
                        direction: signalDirection,
                        entry: referenceWickPrice,
                        sl: cancelPrice,
                        tp1: tp1Price,
                        tp2: tp2Price,
                        currentPrice: referenceWickPrice
                    });

                    const msg = `🔥 <b>WickHunter XAU | SIGNAL TRIGGERED (CANDLE CLOSE)</b> 🔥\n\n` +
                        `✅ <b>Direction:</b> ${signalDirection}\n` +
                        `✅ <b>Action:</b> สัญญาณกลับตัวยืนยันที่ราคาปิดแท่ง!\n\n` +
                        `📍 <b>Entry Price:</b> ${referenceWickPrice.toFixed(2)}\n` +
                        `🛑 <b>Stop Loss:</b> ${cancelPrice.toFixed(2)}\n` +
                        `🎯 <b>TP 1 (RR 1:2):</b> ${tp1Price.toFixed(2)}\n` +
                        `🎯 <b>TP 2 (RR 1:3):</b> ${tp2Price.toFixed(2)}\n\n` +
                        `🚀 <b>Current Price:</b> ${referenceWickPrice.toFixed(2)}`;

                    await sendSignal(msg);
                    console.log(`🟢 [SMC Engine]: สัญญาณถูกส่งแล้ว! รีเซ็ตระบบกลับสู่โหมดสแกนใน 5 นาที...`);

                    setTimeout(() => {
                        currentState = STATES.SCANNING;
                        console.log("🔄 [SMC Engine]: กลับสู่โหมด SCANNING รอโซนถัดไป");
                        dashboardState.update({ botState: currentState });
                    }, 300000);

                    break; // ออกจาก loop
                }

                // 🌟 โหมด ENTRY_MODE === 'WICK_BREAKOUT' (แบบเดิม - รอราคาเบรกปลายไส้)
                referenceWickPrice = paResult.triggerWickPrice;
                
                if (ENGINE_CONFIG.SL_MODE === 'PA_WICK') {
                    cancelPrice = signalDirection === 'BUY' 
                        ? paResult.paCandleLow - ENGINE_CONFIG.SL_BUFFER 
                        : paResult.paCandleHigh + ENGINE_CONFIG.SL_BUFFER;
                } else {
                    cancelPrice = paResult.cancelPrice;
                }

                let risk = Math.abs(referenceWickPrice - cancelPrice);
                if (risk > ENGINE_CONFIG.MAX_SL_POINTS) {
                    risk = ENGINE_CONFIG.MAX_SL_POINTS;
                    cancelPrice = signalDirection === 'BUY' ? referenceWickPrice - risk : referenceWickPrice + risk;
                }
                
                const minRisk = ENGINE_CONFIG.MIN_TP_POINTS / 2;
                let tpRisk = risk;
                if (tpRisk < minRisk) {
                    tpRisk = minRisk;
                }

                const tp1 = signalDirection === 'BUY' ? referenceWickPrice + (tpRisk * 2) : referenceWickPrice - (tpRisk * 2);

                waitingStartedAt = Date.now();
                lastTickAt = Date.now();
                lastFallbackCheckAt = 0;
                currentState = STATES.WAITING_WICK_BREAK;
                dashboardState.update({ botState: currentState });
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
                    `🛑 <b>SL (${ENGINE_CONFIG.SL_MODE === 'PA_WICK' ? 'PA Wick' : 'Zone Edge'}):</b> ${cancelPrice.toFixed(2)}\n` +
                    `🎯 <b>TP (1:2):</b> ${tp1.toFixed(2)}`;

                await sendSignal(previewMsg);
                break;
            }
        }

        if (!foundPA) {
            console.log(`   😴 ไม่พบ PA ในโซนไหนเลย → รอรอบหน้า (2 นาที)`);
        } else if (!foundValidSignal) {
            console.log(`   ⏳ พบ PA แต่ยังไม่มีโซนผ่าน ChoCh → รอรอบหน้า (2 นาที)`);
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
            // [Bug#1 Fix] เรียก clearActiveSignal() เพื่อล้างค่าตัวแปรทุกตัวให้สะอาดก่อนกลับ SCANNING
            const invalidDir = signalDirection;
            const invalidEntry = referenceWickPrice;
            const invalidSL = cancelPrice;

            currentState = STATES.SCANNING;
            clearActiveSignal();
            console.log(`❌ [SMC Engine]: กราฟผิดทาง! ราคาทะลุขอบโซน (${invalidSL.toFixed(2)}) ระบบกลับไป SCANNING`);
            dashboardState.update({ botState: currentState });

            // INVALIDATED: อัปเดต Dashboard State และ Sheets
            dashboardState.addSignal({
                type: 'INVALIDATED',
                direction: invalidDir,
                entry: invalidEntry,
                sl: invalidSL,
                currentPrice: price,
                time: new Date().toISOString()
            });
            sheets.appendSignal({
                type: 'INVALIDATED',
                direction: invalidDir,
                entry: invalidEntry,
                sl: invalidSL,
                currentPrice: price
            });

            await sendSignal(`❌ <b>ยกเลิกสัญญาณ ${invalidDir}</b>\n\nกราฟผิดทาง ทะลุจุด SL ที่ <b>${invalidSL.toFixed(2)}</b> ก่อนการเบรก ระบบกลับสู่โหมดสแกนหาโซนใหม่...${sourceNote}`);
            return;
        }


        if (isBreakout) {
            currentState = STATES.TRIGGERED;
            waitingStartedAt = null;
            dashboardState.update({ botState: currentState });
            const slPrice = cancelPrice;
            let risk = Math.abs(referenceWickPrice - slPrice);
            const minRisk = ENGINE_CONFIG.MIN_TP_POINTS / 2;
            if (risk < minRisk) {
                risk = minRisk;
            }
            
            let tp1Price = 0;
            let tp2Price = 0;

            if (signalDirection === 'BUY') {
                tp1Price = referenceWickPrice + (risk * 2);
                tp2Price = referenceWickPrice + (risk * 3);
            } else if (signalDirection === 'SELL') {
                tp1Price = referenceWickPrice - (risk * 2);
                tp2Price = referenceWickPrice - (risk * 3);
            }

            // TRIGGERED: อัปเดต Dashboard State
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
