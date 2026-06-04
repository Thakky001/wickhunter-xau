const { sendSignal } = require('../services/telegram');
const { findFVG, findOrderBlock, checkPriceActionInZone, checkChoCh, getHTFTrend, getTradingRange, checkIDMSweep } = require('./smcMath');
const { getCandles } = require('../services/twelveData');
const dashboardState = require('../services/dashboardState');
const sheets = require('../services/sheets');

const STATES = {
    SCANNING: 'SCANNING',
    WAITING_WICK_BREAK: 'WAITING_WICK_BREAK',
    TRIGGERED: 'TRIGGERED',
    MONITORING_TRADE: 'MONITORING_TRADE'
};

let activeTrade = null; // เก็บข้อมูลไม้ที่กำลังทำงานอยู่

const ENGINE_CONFIG = {
    SL_MODE: 'SWING_HIGH_LOW',   // 'SWING_HIGH_LOW' (อิงจุดสูงสุด/ต่ำสุดย้อนหลัง), 'PA_WICK' (อิงระดับ M5) หรือ 'ZONE_EDGE'
    SL_BUFFER: 2.0,              // ระยะเผื่อสะบัดปลายไส้ (2.0 USD หรือ 200 จุด)
    SPREAD_BUFFER: 0.5,          // [NEW] ระยะเผื่อสเปรดสเปรดสำหรับไม้ SELL (0.5 USD หรือ 50 จุด)
    SWING_LOOKBACK_CANDLES: 10,  // จำนวนแท่ง M5 ย้อนหลังที่ใช้หา Swing High/Low
    MAX_SL_POINTS: 15.0,         // จำกัดระยะ SL สูงสุดไม่เกิน 15.0 USD (1,500 จุด)
    MIN_TP_POINTS: 12.0,         // จำกัดระยะ TP ขั้นต่ำไม่น้อยกว่า 12.0 USD (1,200 จุด)
    ENTRY_MODE: 'CANDLE_CLOSE',  // [Fix#2] สลับเป็น CANDLE_CLOSE เพื่อเข้าที่ราคาปิดแท่ง PA (ไม่ใช่ยอด High ที่เป็น Resistance)
    MAX_ZONE_AGE_HOURS: 48       // กรองโซน H1 ย้อนหลังไม่เกิน 48 ชั่วโมง (2 วัน)
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
    activeTrade = null;
    dashboardState.update({ activeTrade: null });
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
        const currentHour = new Date().getUTCHours();
        if (cachedH1Candles.length === 0 || currentHour !== lastH1FetchHour) {
            cachedH1Candles = await getCandles('60', 100); // ดึง 100 แท่ง H1 = ~4 วัน (รองรับ MAX_ZONE_AGE_HOURS: 72)
            lastH1FetchHour = currentHour;
            if (cachedH1Candles.length > 0) {
                console.log(`🔄 [SMC Engine]: อัปเดตข้อมูลแท่งเทียน H1 ใหม่ (ชั่วโมงที่ ${currentHour})`);
            }
        }

        const m5Candles = await getCandles('5', 50);

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
        const tradingRange = getTradingRange(closedH1Candles);

        const closedM5Candle = m5Candles[m5Candles.length - 2];
        const closedM5Array = m5Candles.slice(0, -1);
        // ─── DEBUG: สรุปผลการสแกนรอบนี้ ───────────────────────────────
        const now = new Date().toLocaleTimeString('th-TH');
        console.log(`\n─────────────────────────────────────────`);
        console.log(`🔍 [SCAN] ${now} | State: ${currentState}`);
        console.log(`   📊 H1 Zones พบทั้งหมด: ${allZones.length} โซน (FVG: ${fvgs.length}, OB: ${obs.length})`);
        if (tradingRange) {
            console.log(`   📐 [Midpoint] Median Close 24H: ${tradingRange.midpoint.toFixed(2)} | Range: ${tradingRange.low.toFixed(2)} - ${tradingRange.high.toFixed(2)}`);
        }
        console.log(`   📈 [HTF Trend H4]: ${htfTrend} → รับสัญญาณ: ${htfTrend === 'BULLISH' ? 'BUY เท่านั้น' : htfTrend === 'BEARISH' ? 'SELL เท่านั้น' : 'ทั้ง BUY และ SELL (Neutral)'}`);
        console.log(`   🕯️  M5 แท่งปิดล่าสุด | O:${closedM5Candle.open.toFixed(2)} H:${closedM5Candle.high.toFixed(2)} L:${closedM5Candle.low.toFixed(2)} C:${closedM5Candle.close.toFixed(2)}`);
        if (allZones.length > 0) {
            allZones.forEach((z, idx) => {
                const dir = z.type === 'BUY_ZONE' ? '🟢 BUY' : '🔴 SELL';
                console.log(`   📌 [${idx + 1}] ${z.name} (${dir}) | ${z.bottom.toFixed(2)} - ${z.top.toFixed(2)}`);
            });
        }
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
            },
            tradingRange: tradingRange,
            activeTrade: activeTrade
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
            // [Premium/Discount Filter] - ปิดชั่วคราวเพื่อให้บอท Follow Trend ได้ดีขึ้น
            /*
            if (tradingRange) {
                if (zone.type === 'BUY_ZONE' && zone.top > tradingRange.midpoint) {
                    console.log(`   🚫 [Premium/Discount] ข้าม BUY zone [${zone.name}] (${zone.top.toFixed(2)}) เพราะอยู่สูงกว่า Midpoint H1 (${tradingRange.midpoint.toFixed(2)}) (โซน Premium แพงเกินไป)`);
                    continue;
                }
                if (zone.type === 'SELL_ZONE' && zone.bottom < tradingRange.midpoint) {
                    console.log(`   🚫 [Premium/Discount] ข้าม SELL zone [${zone.name}] (${zone.bottom.toFixed(2)}) เพราะอยู่ต่ำกว่า Midpoint H1 (${tradingRange.midpoint.toFixed(2)}) (โซน Discount ถูกเกินไป)`);
                    continue;
                }
            }
            */

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

                // [IDM หรือ ChoCh] ต้องผ่านอย่างใดอย่างหนึ่ง
                const hasIDM = checkIDMSweep(closedM5Array, paResult.direction);
                const hasChoCh = checkChoCh(closedM5Array, paResult.direction);

                if (hasIDM) {
                    console.log(`   ✅ [IDM] พบการกวาด Liquidity Sweep ก่อนหน้า → ผ่าน (ข้าม ChoCh)`);
                } else if (hasChoCh) {
                    console.log(`   ✅ [ChoCh] ไม่มี IDM แต่โครงสร้าง M5 เสียทรงแล้ว (Body-based BOS) → ผ่าน`);
                } else {
                    console.log(`   ⏭️  [IDM+ChoCh] พบ PA แต่ไม่ผ่านทั้ง IDM และ ChoCh → ข้ามโซนนี้`);
                    continue;
                }
                foundValidSignal = true;
                
                signalDirection = paResult.direction;

                // 🌟 โหมด ENTRY_MODE === 'CANDLE_CLOSE' (เข้าทันทีที่ปิดแท่ง PA M5 ยืนยันสัญญาณ)
                if (ENGINE_CONFIG.ENTRY_MODE === 'CANDLE_CLOSE') {
                    referenceWickPrice = closedM5Candle.close; // ใช้ราคาปิดเป็นจุดเข้า

                    if (ENGINE_CONFIG.SL_MODE === 'SWING_HIGH_LOW') {
                        const recentCandles = m5Candles.slice(-ENGINE_CONFIG.SWING_LOOKBACK_CANDLES - 1, -1);
                        if (signalDirection === 'BUY') {
                            const swingLow = Math.min(...recentCandles.map(c => c.low));
                            cancelPrice = swingLow - ENGINE_CONFIG.SL_BUFFER;
                        } else {
                            const swingHigh = Math.max(...recentCandles.map(c => c.high));
                            cancelPrice = swingHigh + ENGINE_CONFIG.SL_BUFFER + ENGINE_CONFIG.SPREAD_BUFFER;
                        }
                    } else {
                        // [Bug#3 Fix] CANDLE_CLOSE mode ต้องใช้ PA_WICK เสมอ
                        // เพราะ entry คือ candle.close (กลางแท่ง) ถ้าใช้ Zone Edge SL จะกว้างเกิน R:R บิดเบือน
                        cancelPrice = signalDirection === 'BUY' 
                            ? paResult.paCandleLow - ENGINE_CONFIG.SL_BUFFER 
                            : paResult.paCandleHigh + ENGINE_CONFIG.SL_BUFFER + ENGINE_CONFIG.SPREAD_BUFFER;
                    }

                    let risk = Math.abs(referenceWickPrice - cancelPrice);
                    if (risk > ENGINE_CONFIG.MAX_SL_POINTS) {
                        risk = ENGINE_CONFIG.MAX_SL_POINTS;
                        cancelPrice = signalDirection === 'BUY' ? referenceWickPrice - risk : referenceWickPrice + risk;
                    }

                    const minRisk = ENGINE_CONFIG.MIN_TP_POINTS / 2;
                    if (risk < minRisk) {
                        risk = minRisk;
                        // [Bug#1 Fix] อัปเดต cancelPrice ให้สอดคล้องกับ risk ใหม่ → R:R ถูกต้องแน่นอน
                        cancelPrice = signalDirection === 'BUY' ? referenceWickPrice - risk : referenceWickPrice + risk;
                    }

                    const tp1Price = signalDirection === 'BUY' ? referenceWickPrice + (risk * 2) : referenceWickPrice - (risk * 2);
                    const tp2Price = signalDirection === 'BUY' ? referenceWickPrice + (risk * 3) : referenceWickPrice - (risk * 3);

                    currentState = STATES.TRIGGERED;
                    waitingStartedAt = null; // [Bug#3 Fix] ล้างค่าให้สะอาดเสมอหลัง TRIGGERED
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
                    activeTrade = {
                        direction: signalDirection,
                        entry: referenceWickPrice,
                        sl: cancelPrice,
                        tp1: tp1Price,
                        tp2: tp2Price,
                        isTp1Hit: false,
                        time: new Date().toISOString()
                    };
                    currentState = STATES.MONITORING_TRADE;
                    console.log(`🟢 [SMC Engine]: สัญญาณถูกส่งแล้ว! เปลี่ยนสถานะบอทเป็น MONITORING_TRADE`);
                    dashboardState.update({ botState: currentState, activeTrade });

                    break; // ออกจาก loop
                }

                // 🌟 โหมด ENTRY_MODE === 'WICK_BREAKOUT' (แบบเดิม - รอราคาเบรกปลายไส้)
                referenceWickPrice = paResult.triggerWickPrice;
                
                if (ENGINE_CONFIG.SL_MODE === 'SWING_HIGH_LOW') {
                    const recentCandles = m5Candles.slice(-ENGINE_CONFIG.SWING_LOOKBACK_CANDLES - 1, -1);
                    if (signalDirection === 'BUY') {
                        const swingLow = Math.min(...recentCandles.map(c => c.low));
                        cancelPrice = swingLow - ENGINE_CONFIG.SL_BUFFER;
                    } else {
                        const swingHigh = Math.max(...recentCandles.map(c => c.high));
                        cancelPrice = swingHigh + ENGINE_CONFIG.SL_BUFFER + ENGINE_CONFIG.SPREAD_BUFFER;
                    }
                } else if (ENGINE_CONFIG.SL_MODE === 'PA_WICK') {
                    cancelPrice = signalDirection === 'BUY' 
                        ? paResult.paCandleLow - ENGINE_CONFIG.SL_BUFFER 
                        : paResult.paCandleHigh + ENGINE_CONFIG.SL_BUFFER + ENGINE_CONFIG.SPREAD_BUFFER;
                } else {
                    cancelPrice = signalDirection === 'BUY'
                        ? paResult.cancelPrice
                        : paResult.cancelPrice + ENGINE_CONFIG.SPREAD_BUFFER;
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
                    // [Bug#1 Fix] อัปเดต cancelPrice ให้สอดคล้องกับ tpRisk → R:R แม่นยำ
                    cancelPrice = signalDirection === 'BUY' ? referenceWickPrice - tpRisk : referenceWickPrice + tpRisk;
                }

                const tp1 = signalDirection === 'BUY' ? referenceWickPrice + (tpRisk * 2) : referenceWickPrice - (tpRisk * 2);
                const tp2 = signalDirection === 'BUY' ? referenceWickPrice + (tpRisk * 3) : referenceWickPrice - (tpRisk * 3);

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
                    tp2: tp2,
                    time: new Date().toISOString()
                });
                sheets.appendSignal({
                    type: 'PRE_ALERT',
                    zone: zone.name,
                    direction: signalDirection,
                    entry: referenceWickPrice,
                    sl: cancelPrice,
                    tp1: tp1,
                    tp2: tp2, // [Bug#2 Fix] เพิ่ม TP2 ใน PRE_ALERT
                    currentPrice: closedM5Candle.close
                });

                const previewMsg = `⏳ <b>เตรียมตัว! พบการกลับตัวในโซน ${zone.name} H1</b>\n\n` +
                    `ดักรอการ <b>เบรกปลายไส้ (M5)</b> ฝั่ง ${signalDirection}\n\n` +
                    `📍 <b>Entry:</b> ${referenceWickPrice.toFixed(2)}\n` +
                    `🛑 <b>SL (${ENGINE_CONFIG.SL_MODE === 'PA_WICK' ? 'PA Wick' : ENGINE_CONFIG.SL_MODE === 'SWING_HIGH_LOW' ? 'Swing H/L' : 'Zone Edge'}):</b> ${cancelPrice.toFixed(2)}\n` +
                    `🎯 <b>TP1 (1:2):</b> ${tp1.toFixed(2)}\n` +
                    `🎯 <b>TP2 (1:3):</b> ${tp2.toFixed(2)}`; // [Bug#2 Fix] แสดง TP2 ด้วย

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
    } catch (error) {
        console.error("❌ [SMC Engine Error] checkMarketLogic failed:", error);
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
    if ((currentState !== STATES.WAITING_WICK_BREAK && currentState !== STATES.MONITORING_TRADE) || isCheckingWaitingGuard) return;

    const now = Date.now();
    if (currentState === STATES.WAITING_WICK_BREAK && waitingStartedAt && now - waitingStartedAt >= PRE_ALERT_TIMEOUT_MS) {
        isCheckingWaitingGuard = true;
        try {
            await expireWaitingSignal();
        } catch (error) {
            console.error("❌ [SMC Engine Error] expireWaitingSignal failed:", error);
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
        if (!m5Candles || m5Candles.length === 0) {
            console.log("⚠️ [SMC Engine]: fallback ไม่สามารถดึงแท่ง M5 ได้");
            return;
        }
        const latestCandle = m5Candles[m5Candles.length - 1];

        if (!latestCandle) {
            console.log("⚠️ [SMC Engine]: fallback ไม่พบแท่ง M5 ล่าสุด");
            return;
        }

        if (currentState === STATES.WAITING_WICK_BREAK) {
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
        } else if (currentState === STATES.MONITORING_TRADE && activeTrade) {
            if (activeTrade.direction === 'BUY') {
                if (latestCandle.low <= activeTrade.sl) {
                    await processTickData(latestCandle.low, 'fallback');
                } else if (latestCandle.high >= activeTrade.tp1) {
                    await processTickData(latestCandle.high, 'fallback');
                }
            } else if (activeTrade.direction === 'SELL') {
                if (latestCandle.high >= activeTrade.sl) {
                    await processTickData(latestCandle.high, 'fallback');
                } else if (latestCandle.low <= activeTrade.tp1) {
                    await processTickData(latestCandle.low, 'fallback');
                }
            }
        }
    } catch (error) {
        console.error("❌ [SMC Engine Error] checkWaitingGuard fallback failed:", error);
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

    if (currentState === STATES.MONITORING_TRADE && activeTrade) {
        const direction = activeTrade.direction;
        let isSlHit = false;
        let isTp1Hit = false;
        let isTp2Hit = false;

        if (direction === 'BUY') {
            if (price <= activeTrade.sl) isSlHit = true;
            if (!activeTrade.isTp1Hit && price >= activeTrade.tp1) isTp1Hit = true;
            if (price >= activeTrade.tp2) isTp2Hit = true;
        } else if (direction === 'SELL') {
            if (price >= activeTrade.sl) isSlHit = true;
            if (!activeTrade.isTp1Hit && price <= activeTrade.tp1) isTp1Hit = true;
            if (price <= activeTrade.tp2) isTp2Hit = true;
        }

        const sourceNote = source === 'fallback'
            ? '\n\n⚠️ ตรวจพบจาก TwelveData fallback'
            : '';

        if (isSlHit) {
            const invalidDir = direction;
            const invalidEntry = activeTrade.entry;
            const invalidSL = activeTrade.sl;

            const logMsg = `❌ <b>[SL HIT] ออเดอร์ ${invalidDir} ชน Stop Loss</b>\n\n` +
                `📍 Entry: ${invalidEntry.toFixed(2)}\n` +
                `🛑 SL: ${invalidSL.toFixed(2)}\n` +
                `🎯 TP1: ${activeTrade.tp1.toFixed(2)}\n` +
                `🎯 TP2: ${activeTrade.tp2.toFixed(2)}\n\n` +
                `📉 ชนที่ราคา: ${price.toFixed(2)} (ขาดทุน)${sourceNote}`;
            
            await sendSignal(logMsg);
            
            dashboardState.addSignal({
                type: 'SL_HIT',
                direction: invalidDir,
                entry: invalidEntry,
                sl: invalidSL,
                currentPrice: price,
                time: new Date().toISOString()
            });
            sheets.appendSignal({
                type: 'SL_HIT',
                direction: invalidDir,
                entry: invalidEntry,
                sl: invalidSL,
                currentPrice: price
            });

            currentState = STATES.SCANNING;
            clearActiveSignal();
            dashboardState.update({ botState: currentState });
            return;
        }

        if (isTp1Hit && !isTp2Hit) {
            activeTrade.isTp1Hit = true;
            activeTrade.sl = activeTrade.entry; // ขยับ SL มาบังทุน (Breakeven)

            const logMsg = `🎯 <b>[TP1 HIT] ออเดอร์ ${direction} ชน Take Profit 1 (RR 1:2)</b>\n\n` +
                `📍 Entry: ${activeTrade.entry.toFixed(2)}\n` +
                `🎯 TP1: ${activeTrade.tp1.toFixed(2)}\n` +
                `🛡️ ระบบปรับ SL มาบังทุน (Breakeven) ที่: ${activeTrade.entry.toFixed(2)} เรียบร้อย\n\n` +
                `📈 ชนที่ราคา: ${price.toFixed(2)} (เก็บกำไรครึ่งแรก)${sourceNote}`;
            
            await sendSignal(logMsg);

            dashboardState.addSignal({
                type: 'TP1_HIT',
                direction,
                entry: activeTrade.entry,
                sl: activeTrade.sl,
                currentPrice: price,
                time: new Date().toISOString()
            });
            sheets.appendSignal({
                type: 'TP1_HIT',
                direction,
                entry: activeTrade.entry,
                sl: activeTrade.sl,
                currentPrice: price
            });
            dashboardState.update({ activeTrade });
        }

        if (isTp2Hit) {
            const logMsg = `🔥 <b>[TP2 HIT] ออเดอร์ ${direction} ชน Take Profit 2 (RR 1:3)</b>\n\n` +
                `📍 Entry: ${activeTrade.entry.toFixed(2)}\n` +
                `🎯 TP2: ${activeTrade.tp2.toFixed(2)}\n\n` +
                `📈 ชนที่ราคา: ${price.toFixed(2)} (ปิดออเดอร์ทำกำไรสูงสุด)${sourceNote}`;
            
            await sendSignal(logMsg);

            dashboardState.addSignal({
                type: 'TP2_HIT',
                direction,
                entry: activeTrade.entry,
                sl: activeTrade.sl,
                currentPrice: price,
                time: new Date().toISOString()
            });
            sheets.appendSignal({
                type: 'TP2_HIT',
                direction,
                entry: activeTrade.entry,
                sl: activeTrade.sl,
                currentPrice: price
            });

            currentState = STATES.SCANNING;
            clearActiveSignal();
            dashboardState.update({ botState: currentState });
            return;
        }
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
            activeTrade = {
                direction: signalDirection,
                entry: referenceWickPrice,
                sl: slPrice,
                tp1: tp1Price,
                tp2: tp2Price,
                isTp1Hit: false,
                time: new Date().toISOString()
            };
            currentState = STATES.MONITORING_TRADE;
            console.log(`🟢 [SMC Engine]: สัญญาณถูกส่งแล้ว! เปลี่ยนสถานะบอทเป็น MONITORING_TRADE`);
            dashboardState.update({ botState: currentState, activeTrade });
        }
    }
}

setInterval(checkMarketLogic, 120000);
setInterval(checkWaitingGuard, WAITING_GUARD_INTERVAL_MS);

checkMarketLogic();

module.exports = { processTickData, forceScanNow };
