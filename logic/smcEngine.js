const { sendSignal } = require('../services/telegram');
const { findFVG, findOrderBlock, checkPriceActionInZone, checkRecentPA, checkChoCh, getHTFTrend, getTradingRange, checkIDMSweep, checkM1ChochBreak, checkM5BOS, findM5FVG } = require('./smcMath');
const { getCandles } = require('../services/twelveData');
const dashboardState = require('../services/dashboardState');
const sheets = require('../services/sheets');

const STATES = {
    SCANNING: 'SCANNING',
    WAITING_WICK_BREAK: 'WAITING_WICK_BREAK',
    TRIGGERED: 'TRIGGERED',
    WAITING_CHOCH: 'WAITING_CHOCH',
    MONITORING_TRADE: 'MONITORING_TRADE',
    SCANNING_CONTINUATION: 'SCANNING_CONTINUATION'  // [NEW] รอ pullback มาที่ M5 FVG หลัง BOS
};

let activeTrade = null; // เก็บข้อมูลไม้ที่กำลังทำงานอยู่

const ENGINE_CONFIG = {
    SL_MODE: 'SWING_HIGH_LOW',   // 'SWING_HIGH_LOW' (อิงจุดสูงสุด/ต่ำสุดย้อนหลัง), 'PA_WICK' (อิงระดับ M5) หรือ 'ZONE_EDGE'
    SL_BUFFER: 2.0,              // ระยะเผื่อสะบัดปลายไส้ (2.0 USD หรือ 200 จุด)
    SPREAD_BUFFER: 0.5,          // [NEW] ระยะเผื่อสเปรดสเปรดสำหรับไม้ SELL (0.5 USD หรือ 50 จุด)
    SWING_LOOKBACK_CANDLES: 10,  // จำนวนแท่ง M5 ย้อนหลังที่ใช้หา Swing High/Low
    MAX_SL_POINTS: 18.0,         // [Fix#1] ขยายจาก 15.0 → 18.0 เพราะ SL อิง zone edge มักกว้างกว่า swing SL
    MIN_TP_POINTS: 8.0,          // จำกัดระยะ TP ขั้นต่ำไม่น้อยกว่า 8.0 USD (800 จุด) เพื่อให้ SL กว้างพอที่จะรอดจากการสะบัด
    ENTRY_MODE: 'CANDLE_CLOSE',  // [Fix#2] สลับเป็น CANDLE_CLOSE เพื่อเข้าที่ราคาปิดแท่ง PA (ไม่ใช่ยอด High ที่เป็น Resistance)
    MAX_ZONE_AGE_HOURS: 48,      // กรองโซน H1 ย้อนหลังไม่เกิน 48 ชั่วโมง (2 วัน)
    CHOCH_M1_MARGIN: 2.0,        // [M1 ChoCh] margin สำหรับยืนยัน ChoCh ผ่านแท่ง M1 (สูงกว่า M5 1.5 เพราะ M1 มี noise มากกว่า)
    CHOCH_WAIT_TIMEOUT_MS: 15 * 60 * 1000,  // [M1 ChoCh] หมดเวลารอ ChoCh break จาก M1 (15 นาที)
    CONT_MAX_SL_POINTS: 10.0,             // [Continuation] SL cap สำหรับ Continuation (แคบกว่า Reversal เพราะ M5 FVG เล็กกว่า H1 Zone)
    CONT_FVG_TIMEOUT_MS: 30 * 60 * 1000,  // [Continuation] 30 นาที timeout รอ pullback มาที่ FVG
    CONT_TP1_RR: 2,                        // [Continuation] TP1 R:R ratio
    CONT_TP2_RR: 4                         // [Continuation] TP2 R:R ratio (สูงกว่า Reversal เพราะ trend มี momentum)
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
let lastTradedCandleTime = null; // เก็บบันทึกเวลาของแท่ง M5 ที่เคยส่งสัญญาณไปแล้ว
let isProcessingTick = false; // ล็อกป้องกัน tick หลายตัวประมวลผลพร้อมกัน (ป้องกันแจ้งเตือนซ้ำ)
let pendingChoch = null;      // [M1 ChoCh] เก็บข้อมูล setup ที่รอ ChoCh break จาก M1
let pendingContinuation = null; // [Continuation] เก็บข้อมูล BOS+FVG ที่รอ pullback

function clearActiveSignal() {
    referenceWickPrice = 0;
    cancelPrice = 0;
    signalDirection = '';
    waitingStartedAt = null;
    lastFallbackCheckAt = 0;
    activeTrade = null;
    pendingChoch = null;
    pendingContinuation = null;
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
            const currentMinute = new Date().getUTCMinutes();

            // [API Fix] หน่วงเวลา 2 นาที เพื่อให้ Server อัปเดตแท่ง H1 ล่าสุดจนเสร็จสมบูรณ์ก่อนดึง
            if (cachedH1Candles.length === 0) {
                cachedH1Candles = await getCandles('60', 100); // ดึง 100 แท่ง H1 = ~4 วัน (รองรับ MAX_ZONE_AGE_HOURS: 72)
                lastH1FetchHour = currentMinute < 2 ? -1 : currentHour; // ถ้าดึงตอนต้นชั่วโมง ให้บังคับดึงซ้ำอีกทีตอนนาทีที่ 2
                if (cachedH1Candles.length > 0) {
                    console.log(`🔄 [SMC Engine]: โหลดข้อมูลแท่งเทียน H1 เริ่มต้นสำเร็จ`);
                }
            } else if (currentHour !== lastH1FetchHour && currentMinute >= 2) {
                cachedH1Candles = await getCandles('60', 100);
                lastH1FetchHour = currentHour;
                if (cachedH1Candles.length > 0) {
                    console.log(`🔄 [SMC Engine]: อัปเดตข้อมูลแท่งเทียน H1 ใหม่ (ชั่วโมงที่ ${currentHour} นาทีที่ ${currentMinute})`);
                }
            }

            const m5Candles = await getCandles('5', 50);

            if (cachedH1Candles.length === 0 || m5Candles.length < 2) {
                console.log(`⚠️  [DEBUG]: ดึงข้อมูลแท่งเทียนไม่สำเร็จหรือได้มาไม่ครบ → ข้ามรอบนี้`);
                return;
            }

            const closedH1Candles = cachedH1Candles.slice(0, -1);

            // ค้นหาโซนทั้งหมดก่อน
            const fvgs = findFVG(closedH1Candles, m5Candles);
            const obs = findOrderBlock(closedH1Candles, m5Candles);
            const allFoundZones = [...fvgs, ...obs];

            // กรองหาเฉพาะโซนที่สดใหม่ย้อนหลังไม่เกินอายุที่กำหนด (ใช้ Timestamp จริง อิงจากแท่งล่าสุดแก้ปัญหาเสาร์อาทิตย์)
            const latestH1TimeMs = new Date(closedH1Candles[closedH1Candles.length - 1].time).getTime();
            const maxAgeMs = ENGINE_CONFIG.MAX_ZONE_AGE_HOURS * 60 * 60 * 1000;
            const allZones = allFoundZones.filter(z => {
                if (!z.time) return true;
                const zoneTimeMs = new Date(z.time).getTime();
                return (latestH1TimeMs - zoneTimeMs) <= maxAgeMs;
            });

            // [HTF Filter] คำนวณทิศทาง H4 จาก H1 ที่มีอยู่แล้ว ไม่ใช้ API เพิ่ม
            const htfTrend = getHTFTrend(closedH1Candles);
            const tradingRange = getTradingRange(closedH1Candles);

            // ─── Dynamic Filter: กำหนด Mode ตาม HTF Trend ──────────────────────────
            const isTrending = (htfTrend === 'BULLISH' || htfTrend === 'BEARISH');
            const depthPct   = isTrending ? 0.7 : 0.3;   // [Fix#2] TREND=70% (เพิ่มจาก 50%), STRICT=30%
            const filterMode = isTrending ? 'TREND_FOLLOWING' : 'STRICT';
            // ────────────────────────────────────────────────────────────────────────

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
            console.log(`   📈 [HTF Trend H4]: ${htfTrend} → [${filterMode}] depth: ${depthPct*100}%, IDM: ${isTrending ? 'ไม่บังคับ' : 'บังคับ'}`);
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

            if (lastTradedCandleTime && closedM5Candle.time === lastTradedCandleTime) {
                console.log(`   ⏭️  [Duplicate] ข้ามการสแกน PA เพราะแท่ง M5 เดิม (เวลา ${lastTradedCandleTime}) เคยประมวลผลและส่งสัญญาณไปแล้ว`);
            } else {
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

                    // [NEW] เช็คหา PA ที่เกิดขึ้นในช่วง 30 แท่งล่าสุดในโซน (เพื่อไม่ให้พลาดจังหวะการสะสมกำลังก่อนเบรค ChoCh)
                    const paResult = checkRecentPA(closedM5Array, zone, 30, depthPct);

                    if (paResult.isValid) {
                        // [Zone Violation Check] ตรวจสอบว่าโซนถูกทำลายไปแล้วหรือยัง (ราคาปิดทะลุโซน)
                        let zoneViolated = false;
                        for (let i = paResult.candleIndex; i < closedM5Array.length; i++) {
                            const c = closedM5Array[i];
                            if (paResult.direction === 'BUY' && c.close < zone.bottom) {
                                console.log(`   💥 โซน [${zone.name}] ถูกทำลายแล้ว (ราคาปิดทะลุขอบล่าง ${zone.bottom.toFixed(2)}) → ยกเลิกการรอ ChoCh`);
                                zoneViolated = true;
                                break;
                            }
                            if (paResult.direction === 'SELL' && c.close > zone.top) {
                                console.log(`   💥 โซน [${zone.name}] ถูกทำลายแล้ว (ราคาปิดทะลุขอบบน ${zone.top.toFixed(2)}) → ยกเลิกการรอ ChoCh`);
                                zoneViolated = true;
                                break;
                            }
                        }
                        if (zoneViolated) continue;

                        foundPA = true;
                        console.log(`   ✨ พบ PA (ย้อนหลังไม่เกิน 10 แท่ง) ในโซน [${zone.name}] (${zone.bottom.toFixed(2)} - ${zone.top.toFixed(2)}) | Direction: ${paResult.direction}`);

                        const hasIDM = checkIDMSweep(closedM5Array, paResult.direction, paResult.candleIndex);
                        const chochResult = checkChoCh(closedM5Array, paResult.direction, paResult.candleIndex);
                        const hasChoCh = chochResult.isValid;

                        // [Fix] ตรวจสอบว่าเป็น Fresh Break ที่เพิ่งเกิดในแท่งล่าสุดหรือไม่ ป้องกัน Late Entry
                        const isFreshBreakout = hasChoCh && (chochResult.breakIndex === closedM5Array.length - 1);

                        console.log(`   🔎 [IDM]: ${hasIDM ? '✅ พบ Liquidity Sweep' : '❌ ไม่พบ'} | [ChoCh]: ${hasChoCh ? '✅ โครงสร้างเสียทรง' : '❌ ยังไม่เสียทรง'}`);
                        if (chochResult.targetPrice) {
                            if (hasChoCh) {
                                console.log(`      ↳ 📈 [ChoCh Detail]: ทะลุเป้า ${chochResult.targetPrice.toFixed(2)} ด้วยราคาปิด ${chochResult.breakPrice.toFixed(2)} (ที่แท่ง Index: ${chochResult.breakIndex})`);
                                if (!isFreshBreakout) {
                                    console.log(`      ↳ ⚠️ [Late Entry]: สัญญาณ ChoCh เกิดขึ้นไปแล้วก่อนหน้านี้ (ไม่ใช่แท่งปัจจุบัน) → ข้ามเพื่อป้องกันการเข้าช้า`);
                                }
                            } else {
                                const requiredPrice = paResult.direction === 'BUY' ? chochResult.targetPrice + chochResult.margin : chochResult.targetPrice - chochResult.margin;
                                console.log(`      ↳ ⏳ [Waiting ChoCh]: รอกราฟเบรคเป้าหมาย ${chochResult.targetPrice.toFixed(2)} (ต้องทะลุ ${requiredPrice.toFixed(2)})`);
                            }
                        }

                        // ─── [M1 ChoCh] ตรวจสอบเงื่อนไขเข้าเทรด หรือเข้า WAITING_CHOCH ───
                        let shouldTrigger = false;
                        let shouldWaitChoch = false;

                        if (filterMode === 'STRICT') {
                            // 🛡️ STRICT MODE: ต้องผ่านครบ 3 ด่าน (PA + IDM + ChoCh)
                            if (hasIDM && hasChoCh && isFreshBreakout) {
                                console.log(`   ✅ [STRICT] PA+IDM+ChoCh ผ่านครบ (Fresh Breakout) → เข้าเทรดได้`);
                                shouldTrigger = true;
                            } else if (hasIDM && hasChoCh && !isFreshBreakout) {
                                console.log(`   ⏭️  [STRICT] สัญญาณช้าไป (Late Entry) โครงสร้างเบรคไปแล้วตั้งแต่อดีต → รอรอบถัดไป`);
                            } else if (!hasIDM && hasChoCh) {
                                console.log(`   ⏭️  [STRICT] ChoCh ✅ แต่ขาด IDM → ตลาดไซด์เวย์ต้องเข้มงวด ไม่เข้าเทรด`);
                            } else if (hasIDM && !hasChoCh && chochResult.targetPrice) {
                                console.log(`   ⏳ [STRICT] IDM ✅ + ChoCh Target พบแล้ว (${chochResult.targetPrice.toFixed(2)}) → เข้า WAITING_CHOCH รอ M1 ยืนยัน Break`);
                                shouldWaitChoch = true;
                            } else if (hasIDM && !hasChoCh) {
                                console.log(`   ⏭️  [STRICT] IDM ✅ แต่หา ChoCh Target ไม่เจอ → รอรอบถัดไป`);
                            } else {
                                console.log(`   ⏭️  [STRICT] ขาดทั้ง IDM และ ChoCh → รอรอบถัดไป`);
                            }
                        } else {
                            // 🚀 TREND FOLLOWING MODE: ต้องการแค่ ChoCh (H4 trend = IDM ตัวใหญ่แล้ว)
                            if (hasChoCh && isFreshBreakout) {
                                console.log(`   ✅ [TREND] PA+ChoCh ผ่าน! (Fresh Breakout) H4 ${htfTrend} เป็น confluence แทน IDM → เข้าเทรดได้`);
                                shouldTrigger = true;
                            } else if (hasChoCh && !isFreshBreakout) {
                                console.log(`   ⏭️  [TREND] สัญญาณช้าไป (Late Entry) โครงสร้างเบรคไปแล้วตั้งแต่อดีต → รอรอบถัดไป`);
                            } else if (!hasChoCh && chochResult.targetPrice) {
                                console.log(`   ⏳ [TREND] ChoCh Target พบแล้ว (${chochResult.targetPrice.toFixed(2)}) → เข้า WAITING_CHOCH รอ M1 ยืนยัน Break`);
                                shouldWaitChoch = true;
                            } else {
                                console.log(`   ⏭️  [TREND] หา ChoCh Target ไม่เจอ → รอรอบถัดไป`);
                            }
                        }

                        // ─── [M1 ChoCh] เข้า WAITING_CHOCH: รอแท่ง M1 ยืนยัน ChoCh Break ──────
                        if (shouldWaitChoch) {
                            // Pre-calculate SL จาก M5 data ปัจจุบัน
                            let preCalcSL;
                            if (ENGINE_CONFIG.SL_MODE === 'SWING_HIGH_LOW') {
                                const pIndex = paResult.candleIndex;
                                const entryIndex = closedM5Array.length - 1;
                                const recentCandles = closedM5Array.slice(pIndex, entryIndex + 1);
                                if (paResult.direction === 'BUY') {
                                    const swingLow = Math.min(...recentCandles.map(c => c.low));
                                    const zoneEdgeSL = paResult.cancelPrice - ENGINE_CONFIG.SL_BUFFER; // zone.bottom - buffer
                                    // [Fix#1 Hybrid] ใช้ตัวที่ไกลกว่า (ปลอดภัยกว่า) ระหว่าง swing กับ zone edge
                                    preCalcSL = Math.min(swingLow - ENGINE_CONFIG.SL_BUFFER, zoneEdgeSL);
                                } else {
                                    const swingHigh = Math.max(...recentCandles.map(c => c.high));
                                    const zoneEdgeSL = paResult.cancelPrice + ENGINE_CONFIG.SL_BUFFER + ENGINE_CONFIG.SPREAD_BUFFER; // zone.top + buffer
                                    // [Fix#1 Hybrid] ใช้ตัวที่ไกลกว่า (ปลอดภัยกว่า) ระหว่าง swing กับ zone edge
                                    preCalcSL = Math.max(swingHigh + ENGINE_CONFIG.SL_BUFFER + ENGINE_CONFIG.SPREAD_BUFFER, zoneEdgeSL);
                                }
                            } else {
                                preCalcSL = paResult.direction === 'BUY'
                                    ? paResult.paCandleLow - ENGINE_CONFIG.SL_BUFFER
                                    : paResult.paCandleHigh + ENGINE_CONFIG.SL_BUFFER + ENGINE_CONFIG.SPREAD_BUFFER;
                            }

                            pendingChoch = {
                                direction: paResult.direction,
                                chochTargetPrice: chochResult.targetPrice,
                                chochMargin: ENGINE_CONFIG.CHOCH_M1_MARGIN,
                                preCalcSL: preCalcSL,
                                zoneName: zone.name,
                                filterMode: filterMode,
                                m5CandleTime: closedM5Candle.time
                            };

                            signalDirection = paResult.direction;
                            waitingStartedAt = Date.now();
                            lastTickAt = Date.now();
                            lastTradedCandleTime = closedM5Candle.time;
                            currentState = STATES.WAITING_CHOCH;
                            dashboardState.update({ botState: currentState });

                            const requiredBreakPrice = paResult.direction === 'BUY'
                                ? chochResult.targetPrice + ENGINE_CONFIG.CHOCH_M1_MARGIN
                                : chochResult.targetPrice - ENGINE_CONFIG.CHOCH_M1_MARGIN;

                            const preAlertMsg = `⏳ <b>เตรียมตัว! พบ PA${filterMode === 'STRICT' ? ' + IDM' : ''} ในโซน ${zone.name} H1</b>\n\n` +
                                `📊 รอยืนยัน ChoCh จากแท่ง <b>M1 Real-time</b> (Finnhub)\n` +
                                `🎯 เป้า ChoCh: ${chochResult.targetPrice.toFixed(2)} (ต้อง${paResult.direction === 'BUY' ? 'ปิดเหนือ' : 'ปิดใต้'} ${requiredBreakPrice.toFixed(2)})\n\n` +
                                `📍 SL โดยประมาณ: ${preCalcSL.toFixed(2)}\n` +
                                `⏱️ หมดเวลาใน: ${ENGINE_CONFIG.CHOCH_WAIT_TIMEOUT_MS / 60000} นาที`;

                            await sendSignal(preAlertMsg);

                            dashboardState.addSignal({
                                type: 'PRE_ALERT',
                                zone: zone.name,
                                direction: paResult.direction,
                                chochTarget: chochResult.targetPrice,
                                sl: preCalcSL,
                                time: new Date().toISOString()
                            });
                            sheets.appendSignal({
                                type: 'PRE_ALERT',
                                zone: zone.name,
                                direction: paResult.direction,
                                chochTarget: chochResult.targetPrice,
                                sl: preCalcSL
                            });

                            break; // ออกจาก zone loop
                        }

                        if (!shouldTrigger) continue;
                        foundValidSignal = true;

                        signalDirection = paResult.direction;
                        lastTradedCandleTime = closedM5Candle.time; // บันทึกเวลาแท่งเทียนที่ส่งสัญญาณไปแล้ว เพื่อป้องกันการส่งซ้ำ

                        // 🌟 โหมด ENTRY_MODE === 'CANDLE_CLOSE' (เข้าทันทีที่ปิดแท่ง PA M5 ยืนยันสัญญาณ)
                        if (ENGINE_CONFIG.ENTRY_MODE === 'CANDLE_CLOSE') {
                            referenceWickPrice = closedM5Candle.close; // ใช้ราคาปิดเป็นจุดเข้า

                            if (ENGINE_CONFIG.SL_MODE === 'SWING_HIGH_LOW') {
                                const pIndex = paResult.candleIndex;
                                const entryIndex = closedM5Array.length - 1; // แท่งที่เกิด ChoCh (ปัจจุบัน)
                                const recentCandles = closedM5Array.slice(pIndex, entryIndex + 1);
                                if (signalDirection === 'BUY') {
                                    const swingLow = Math.min(...recentCandles.map(c => c.low));
                                    const zoneEdgeSL = paResult.cancelPrice - ENGINE_CONFIG.SL_BUFFER; // zone.bottom - buffer
                                    // [Fix#1 Hybrid] ใช้ตัวที่ไกลกว่า (ปลอดภัยกว่า) ระหว่าง swing กับ zone edge
                                    cancelPrice = Math.min(swingLow - ENGINE_CONFIG.SL_BUFFER, zoneEdgeSL);
                                } else {
                                    const swingHigh = Math.max(...recentCandles.map(c => c.high));
                                    const zoneEdgeSL = paResult.cancelPrice + ENGINE_CONFIG.SL_BUFFER + ENGINE_CONFIG.SPREAD_BUFFER; // zone.top + buffer
                                    // [Fix#1 Hybrid] ใช้ตัวที่ไกลกว่า (ปลอดภัยกว่า) ระหว่าง swing กับ zone edge
                                    cancelPrice = Math.max(swingHigh + ENGINE_CONFIG.SL_BUFFER + ENGINE_CONFIG.SPREAD_BUFFER, zoneEdgeSL);
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
                                // [SL Fix] ไม่บีบ SL ดื้อๆ → ข้ามสัญญาณนี้ไปเลย
                                // เพราะ SL ที่บีบโดยไม่มีโครงสร้างรองรับ = เหยื่อ SL Hunt ฟรี
                                console.log(`   🚫 ข้ามสัญญาณ! เพราะระยะ SL กว้างเกินไป (${risk.toFixed(2)} pts > MAX ${ENGINE_CONFIG.MAX_SL_POINTS} pts) → รอโซนถัดไป`);
                                continue;
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
                            const pIndex = paResult.candleIndex;
                            const entryIndex = closedM5Array.length - 1; // แท่งปัจจุบัน (ที่รอเบรค)
                            const recentCandles = closedM5Array.slice(pIndex, entryIndex + 1);
                            if (signalDirection === 'BUY') {
                                const swingLow = Math.min(...recentCandles.map(c => c.low));
                                const zoneEdgeSL = paResult.cancelPrice - ENGINE_CONFIG.SL_BUFFER; // zone.bottom - buffer
                                // [Fix#1 Hybrid] ใช้ตัวที่ไกลกว่า (ปลอดภัยกว่า) ระหว่าง swing กับ zone edge
                                cancelPrice = Math.min(swingLow - ENGINE_CONFIG.SL_BUFFER, zoneEdgeSL);
                            } else {
                                const swingHigh = Math.max(...recentCandles.map(c => c.high));
                                const zoneEdgeSL = paResult.cancelPrice + ENGINE_CONFIG.SL_BUFFER + ENGINE_CONFIG.SPREAD_BUFFER; // zone.top + buffer
                                // [Fix#1 Hybrid] ใช้ตัวที่ไกลกว่า (ปลอดภัยกว่า) ระหว่าง swing กับ zone edge
                                cancelPrice = Math.max(swingHigh + ENGINE_CONFIG.SL_BUFFER + ENGINE_CONFIG.SPREAD_BUFFER, zoneEdgeSL);
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
                            // [SL Fix] ไม่บีบ SL ดื้อๆ → ข้ามสัญญาณนี้ไปเลย
                            console.log(`   🚫 ข้ามสัญญาณ! เพราะระยะ SL กว้างเกินไป (${risk.toFixed(2)} pts > MAX ${ENGINE_CONFIG.MAX_SL_POINTS} pts) → รอโซนถัดไป`);
                            continue;
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
                } // End of for loop
            } // End of if (!duplicate) check

            if (lastTradedCandleTime && closedM5Candle.time === lastTradedCandleTime) {
                // ไม่ต้อง log อะไรเพิ่มถ้าเป็น duplicate
            } else if (!foundPA) {
                console.log(`   😴 ไม่พบ PA ในโซนไหนเลย → รอรอบหน้า (2 นาที)`);
            } else if (!foundValidSignal) {
                console.log(`   ⏳ พบ PA แต่ยังไม่มีโซนผ่าน ChoCh → รอรอบหน้า (2 นาที)`);
            }

            // ─── Continuation Scan: M5 BOS + FVG (เฉพาะ TREND mode เท่านั้น) ───────────────
            if (!foundValidSignal && isTrending && currentState === STATES.SCANNING &&
                !(lastTradedCandleTime && closedM5Candle.time === lastTradedCandleTime)) {

                const bosDirection = htfTrend === 'BULLISH' ? 'BUY' : 'SELL';
                const bosResult = checkM5BOS(closedM5Array, bosDirection);

                if (bosResult.isValid) {
                    console.log(`   🔄 [Continuation] พบ M5 BOS (${bosDirection}) | Fractal: ${bosResult.fractalPrice.toFixed(2)} → Break: ${bosResult.breakPrice.toFixed(2)}`);

                    const fvgResult = findM5FVG(closedM5Array, bosResult.fractalIndex, bosResult.bosIndex, bosDirection);

                    if (fvgResult.isValid) {
                        const fvg = fvgResult.fvg;
                        console.log(`   📦 [Continuation] พบ M5 FVG | ${fvg.bottom.toFixed(2)} - ${fvg.top.toFixed(2)}`);

                        const fvgZone = {
                            type: bosDirection === 'BUY' ? 'BUY_ZONE' : 'SELL_ZONE',
                            top: fvg.top,
                            bottom: fvg.bottom
                        };
                        // เช็ค PA rejection ใน FVG จากแท่ง M5 ปิดล่าสุด (pullback มา และ reject แล้ว)
                        const paInFVG = checkPriceActionInZone(closedM5Candle, fvgZone, 0.7);

                        if (paInFVG.isValid) {
                            console.log(`   ✅ [Continuation] PA rejection ใน FVG ยืนยันทันที! คำนวณ Entry/SL/TP...`);
                            const entryPrice = closedM5Candle.close;
                            const sl = bosDirection === 'BUY'
                                ? fvg.bottom - ENGINE_CONFIG.SL_BUFFER
                                : fvg.top + ENGINE_CONFIG.SL_BUFFER + ENGINE_CONFIG.SPREAD_BUFFER;
                            let risk = Math.abs(entryPrice - sl);

                            if (risk > ENGINE_CONFIG.CONT_MAX_SL_POINTS) {
                                console.log(`   🚫 [Continuation] SL กว้างเกินไป (${risk.toFixed(2)} pts > MAX ${ENGINE_CONFIG.CONT_MAX_SL_POINTS}) → skip`);
                            } else {
                                const minRisk = ENGINE_CONFIG.MIN_TP_POINTS / 2;
                                if (risk < minRisk) risk = minRisk;

                                const tp1Price = bosDirection === 'BUY' ? entryPrice + risk * ENGINE_CONFIG.CONT_TP1_RR : entryPrice - risk * ENGINE_CONFIG.CONT_TP1_RR;
                                const tp2Price = bosDirection === 'BUY' ? entryPrice + risk * ENGINE_CONFIG.CONT_TP2_RR : entryPrice - risk * ENGINE_CONFIG.CONT_TP2_RR;

                                signalDirection = bosDirection;
                                referenceWickPrice = entryPrice;
                                cancelPrice = sl;
                                lastTradedCandleTime = closedM5Candle.time;
                                currentState = STATES.TRIGGERED;
                                waitingStartedAt = null;
                                dashboardState.update({ botState: currentState });

                                dashboardState.addSignal({ type: 'TRIGGERED', direction: bosDirection, entry: entryPrice, sl, tp1: tp1Price, tp2: tp2Price, currentPrice: entryPrice, time: new Date().toISOString() });
                                sheets.appendSignal({ type: 'TRIGGERED', direction: bosDirection, entry: entryPrice, sl, tp1: tp1Price, tp2: tp2Price, currentPrice: entryPrice });

                                const contMsg = `🚀 <b>WickHunter XAU | CONTINUATION SIGNAL</b> 🚀\n\n` +
                                    `✅ <b>Direction:</b> ${bosDirection}\n` +
                                    `✅ <b>Setup:</b> M5 BOS + FVG Retest (H4 ${htfTrend})\n\n` +
                                    `📍 <b>Entry Price:</b> ${entryPrice.toFixed(2)}\n` +
                                    `🛑 <b>Stop Loss:</b> ${sl.toFixed(2)} (${bosDirection === 'BUY' ? 'ใต้ FVG bottom' : 'เหนือ FVG top'})\n` +
                                    `🎯 <b>TP 1 (RR 1:${ENGINE_CONFIG.CONT_TP1_RR}):</b> ${tp1Price.toFixed(2)}\n` +
                                    `🎯 <b>TP 2 (RR 1:${ENGINE_CONFIG.CONT_TP2_RR}):</b> ${tp2Price.toFixed(2)}\n\n` +
                                    `🚀 <b>Current Price:</b> ${entryPrice.toFixed(2)}`;

                                await sendSignal(contMsg);
                                activeTrade = { direction: bosDirection, entry: entryPrice, sl, tp1: tp1Price, tp2: tp2Price, isTp1Hit: false, time: new Date().toISOString() };
                                currentState = STATES.MONITORING_TRADE;
                                dashboardState.update({ botState: currentState, activeTrade });
                                console.log(`🟢 [Continuation]: สัญญาณถูกส่งแล้ว! → MONITORING_TRADE`);
                            }
                        } else {
                            // ยังไม่ pullback → เข้า SCANNING_CONTINUATION รอ
                            pendingContinuation = { direction: bosDirection, fvg, bosIndex: bosResult.bosIndex, fractalPrice: bosResult.fractalPrice, startedAt: Date.now() };
                            currentState = STATES.SCANNING_CONTINUATION;
                            dashboardState.update({ botState: currentState });
                            console.log(`   ⏳ [Continuation] BOS+FVG พบแล้ว แต่ราคายังไม่ pullback มาที่ FVG → SCANNING_CONTINUATION`);

                            const preAlertMsg = `⏳ <b>เตรียมตัว! พบ M5 BOS + FVG (Continuation Setup)</b>\n\n` +
                                `📊 ทิศทาง: <b>${bosDirection}</b> (ตาม H4 ${htfTrend})\n` +
                                `📦 M5 FVG Zone: ${fvg.bottom.toFixed(2)} - ${fvg.top.toFixed(2)}\n\n` +
                                `⏳ รอราคา pullback มาที่ FVG แล้วมี PA rejection\n` +
                                `⏱️ หมดเวลาใน: ${ENGINE_CONFIG.CONT_FVG_TIMEOUT_MS / 60000} นาที`;
                            await sendSignal(preAlertMsg);
                        }
                    } else {
                        console.log(`   ❌ [Continuation] ไม่พบ M5 FVG ระหว่าง BOS impulse`);
                    }
                }
            }
            // ────────────────────────────────────────────────────────────────────
        }

        // ─── SCANNING_CONTINUATION: ตรวจสอบ PA rejection ใน M5 FVG ทุก 5 นาที ────────────────
        else if (currentState === STATES.SCANNING_CONTINUATION && pendingContinuation) {
            const m5ContCandles = await getCandles('5', 15);
            if (!m5ContCandles || m5ContCandles.length < 2) {
                console.log(`⚠️ [Continuation] ดึงข้อมูล M5 ไม่ได้ → ข้าม`);
                return;
            }

            const closedM5Cont = m5ContCandles.slice(0, -1);
            const latestContCandle = closedM5Cont[closedM5Cont.length - 1];
            const { direction: contDir, fvg: contFvg } = pendingContinuation;
            const fvgZone = { type: contDir === 'BUY' ? 'BUY_ZONE' : 'SELL_ZONE', top: contFvg.top, bottom: contFvg.bottom };

            const nowTime = new Date().toLocaleTimeString('th-TH');
            console.log(`\n─────────────────────────────────────────`);
            console.log(`🔍 [CONT SCAN] ${nowTime} | State: SCANNING_CONTINUATION`);
            console.log(`   📦 FVG Zone: ${contFvg.bottom.toFixed(2)} - ${contFvg.top.toFixed(2)} | Direction: ${contDir}`);
            console.log(`   📓 M5 ล่าสุด | H:${latestContCandle.high.toFixed(2)} L:${latestContCandle.low.toFixed(2)} C:${latestContCandle.close.toFixed(2)}`);

            const paInFVG = checkPriceActionInZone(latestContCandle, fvgZone, 0.7);

            if (paInFVG.isValid) {
                console.log(`   ✅ [Continuation] PA Rejection ใน FVG ยืนยัน! → คำนวณ Entry...`);
                const entryPrice = latestContCandle.close;
                const sl = contDir === 'BUY'
                    ? contFvg.bottom - ENGINE_CONFIG.SL_BUFFER
                    : contFvg.top + ENGINE_CONFIG.SL_BUFFER + ENGINE_CONFIG.SPREAD_BUFFER;
                let risk = Math.abs(entryPrice - sl);

                if (risk > ENGINE_CONFIG.CONT_MAX_SL_POINTS) {
                    console.log(`   🚫 [Continuation] SL กว้างเกินไป (${risk.toFixed(2)} pts) → กลับ SCANNING`);
                    currentState = STATES.SCANNING;
                    clearActiveSignal();
                    dashboardState.update({ botState: currentState });
                } else {
                    const minRisk = ENGINE_CONFIG.MIN_TP_POINTS / 2;
                    if (risk < minRisk) risk = minRisk;

                    const tp1Price = contDir === 'BUY' ? entryPrice + risk * ENGINE_CONFIG.CONT_TP1_RR : entryPrice - risk * ENGINE_CONFIG.CONT_TP1_RR;
                    const tp2Price = contDir === 'BUY' ? entryPrice + risk * ENGINE_CONFIG.CONT_TP2_RR : entryPrice - risk * ENGINE_CONFIG.CONT_TP2_RR;

                    signalDirection = contDir;
                    referenceWickPrice = entryPrice;
                    cancelPrice = sl;
                    lastTradedCandleTime = latestContCandle.time;
                    currentState = STATES.TRIGGERED;
                    waitingStartedAt = null;
                    dashboardState.update({ botState: currentState });

                    dashboardState.addSignal({ type: 'TRIGGERED', direction: contDir, entry: entryPrice, sl, tp1: tp1Price, tp2: tp2Price, currentPrice: entryPrice, time: new Date().toISOString() });
                    sheets.appendSignal({ type: 'TRIGGERED', direction: contDir, entry: entryPrice, sl, tp1: tp1Price, tp2: tp2Price, currentPrice: entryPrice });

                    const contMsg = `🚀 <b>WickHunter XAU | CONTINUATION SIGNAL</b> 🚀\n\n` +
                        `✅ <b>Direction:</b> ${contDir}\n` +
                        `✅ <b>Setup:</b> M5 BOS + FVG Retest ยืนยัน!\n\n` +
                        `📍 <b>Entry Price:</b> ${entryPrice.toFixed(2)}\n` +
                        `🛑 <b>Stop Loss:</b> ${sl.toFixed(2)} (${contDir === 'BUY' ? 'ใต้ FVG bottom' : 'เหนือ FVG top'})\n` +
                        `🎯 <b>TP 1 (RR 1:${ENGINE_CONFIG.CONT_TP1_RR}):</b> ${tp1Price.toFixed(2)}\n` +
                        `🎯 <b>TP 2 (RR 1:${ENGINE_CONFIG.CONT_TP2_RR}):</b> ${tp2Price.toFixed(2)}\n\n` +
                        `🚀 <b>Current Price:</b> ${entryPrice.toFixed(2)}`;

                    await sendSignal(contMsg);
                    activeTrade = { direction: contDir, entry: entryPrice, sl, tp1: tp1Price, tp2: tp2Price, isTp1Hit: false, time: new Date().toISOString() };
                    pendingContinuation = null;
                    currentState = STATES.MONITORING_TRADE;
                    dashboardState.update({ botState: currentState, activeTrade });
                    console.log(`🟢 [Continuation]: TRIGGERED! → MONITORING_TRADE`);
                }
            } else {
                console.log(`   ⏳ [Continuation] ยังไม่มี PA rejection ใน FVG → รอ M5 ถัดไป`);
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

// ─── [M1 ChoCh] หมดเวลารอ ChoCh break จาก M1 ────────────────────────────
async function expireWaitingChoch() {
    if (currentState !== STATES.WAITING_CHOCH) return;

    const direction = pendingChoch ? pendingChoch.direction : signalDirection;
    const target = pendingChoch ? pendingChoch.chochTargetPrice : 0;

    currentState = STATES.SCANNING;
    console.log(`⌛ [SMC Engine]: WAITING_CHOCH ${direction} หมดอายุ ระบบกลับไป SCANNING`);
    dashboardState.update({ botState: currentState });

    dashboardState.addSignal({
        type: 'EXPIRED',
        direction,
        chochTarget: target,
        time: new Date().toISOString()
    });
    sheets.appendSignal({
        type: 'EXPIRED',
        direction,
        chochTarget: target
    });
    clearActiveSignal();

    await sendSignal(`⌛ <b>หมดอายุ WAITING_CHOCH ${direction}</b>\n\nรอ M1 ยืนยัน ChoCh นานเกิน ${ENGINE_CONFIG.CHOCH_WAIT_TIMEOUT_MS / 60000} นาที แต่ราคาไม่ทะลุเป้า ${target > 0 ? target.toFixed(2) : '-'}\nระบบกลับสู่โหมดสแกนหาโซนใหม่...`);
}

async function checkWaitingGuard() {
    if ((currentState !== STATES.WAITING_WICK_BREAK && currentState !== STATES.WAITING_CHOCH &&
         currentState !== STATES.MONITORING_TRADE && currentState !== STATES.SCANNING_CONTINUATION) || isCheckingWaitingGuard) return;

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

    // [M1 ChoCh] ตรวจสอบ timeout สำหรับ WAITING_CHOCH
    if (currentState === STATES.WAITING_CHOCH && waitingStartedAt && now - waitingStartedAt >= ENGINE_CONFIG.CHOCH_WAIT_TIMEOUT_MS) {
        isCheckingWaitingGuard = true;
        try {
            await expireWaitingChoch();
        } catch (error) {
            console.error("❌ [SMC Engine Error] expireWaitingChoch failed:", error);
        } finally {
            isCheckingWaitingGuard = false;
        }
        return;
    }

    // [Continuation] Timeout สำหรับ SCANNING_CONTINUATION
    if (currentState === STATES.SCANNING_CONTINUATION && pendingContinuation &&
        now - pendingContinuation.startedAt >= ENGINE_CONFIG.CONT_FVG_TIMEOUT_MS) {
        isCheckingWaitingGuard = true;
        try {
            const contDir = pendingContinuation.direction;
            const contFvg = pendingContinuation.fvg;
            currentState = STATES.SCANNING;
            clearActiveSignal();
            dashboardState.update({ botState: currentState });
            console.log(`⌛ [Continuation] FVG Retest timeout (${ENGINE_CONFIG.CONT_FVG_TIMEOUT_MS / 60000} นาที) → กลับ SCANNING`);
            await sendSignal(`⌛ <b>หมดเวลา Continuation ${contDir}</b>\n\nรอ pullback มาที่ FVG (${contFvg.bottom.toFixed(2)}-${contFvg.top.toFixed(2)}) นานเกิน ${ENGINE_CONFIG.CONT_FVG_TIMEOUT_MS / 60000} นาที\nระบบกลับสู่โหมดสแกนใหม่...`);
        } catch (error) {
            console.error("❌ [SMC Engine Error] expireContinuation failed:", error);
        } finally {
            isCheckingWaitingGuard = false;
        }
        return;
    }

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
        } else if (currentState === STATES.WAITING_CHOCH && pendingChoch) {
            // [M1 ChoCh Fallback] ตรวจสอบ SL กวาดกิน (Invalidated) ก่อน
            if (pendingChoch.direction === 'BUY' && latestCandle.low <= pendingChoch.preCalcSL) {
                console.log(`   🛰️ [Fallback] ราคาต่ำสุด (${latestCandle.low.toFixed(2)}) กวาดโดน SL → Invalidate WAITING_CHOCH`);
                await processTickData(latestCandle.low, 'fallback');
            } else if (pendingChoch.direction === 'SELL' && latestCandle.high >= pendingChoch.preCalcSL) {
                console.log(`   🛰️ [Fallback] ราคาสูงสุด (${latestCandle.high.toFixed(2)}) กวาดโดน SL → Invalidate WAITING_CHOCH`);
                await processTickData(latestCandle.high, 'fallback');
            } else {
                // ถ้าไม่โดน SL ให้ใช้ M5 close ล่าสุดเป็น M1 close สำรอง
                const syntheticM1 = {
                    open: latestCandle.open,
                    high: latestCandle.high,
                    low: latestCandle.low,
                    close: latestCandle.close,
                    time: latestCandle.time || new Date().toISOString(),
                    tickCount: 999
                };
                console.log(`   🛰️ [Fallback] ใช้ M5 close (${latestCandle.close.toFixed(2)}) เป็น fallback สำหรับ M1 ChoCh check`);
                await processM1Close(syntheticM1);
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

    // ล็อกป้องกัน tick หลายตัวเข้ามาประมวลผลพร้อมกัน (แก้บั๊กส่ง SL HIT ซ้ำ 3-4 ครั้ง)
    if (isProcessingTick) return;
    isProcessingTick = true;

    try {

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
                const tp1Val = activeTrade.tp1;
                const tp2Val = activeTrade.tp2;

                // เปลี่ยนสถานะทันทีก่อน await เพื่อป้องกัน tick ถัดไปเข้ามาซ้ำ
                currentState = STATES.SCANNING;
                clearActiveSignal();
                dashboardState.update({ botState: currentState });

                const logMsg = `❌ <b>[SL HIT] ออเดอร์ ${invalidDir} ชน Stop Loss</b>\n\n` +
                    `📍 Entry: ${invalidEntry.toFixed(2)}\n` +
                    `🛑 SL: ${invalidSL.toFixed(2)}\n` +
                    `🎯 TP1: ${tp1Val.toFixed(2)}\n` +
                    `🎯 TP2: ${tp2Val.toFixed(2)}\n\n` +
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
                return;
            }

            if (isTp1Hit) {
                const tp1Entry = activeTrade.entry;
                const tp1Val = activeTrade.tp1;
                const tp1Sl = activeTrade.sl;

                // เปลี่ยนสถานะทันทีก่อน await เพื่อป้องกัน tick ถัดไปเข้ามาซ้ำ
                currentState = STATES.SCANNING;
                clearActiveSignal();
                dashboardState.update({ botState: currentState });

                const logMsg = `🎯 <b>[TP1 HIT] ออเดอร์ ${direction} ชน Take Profit 1 (RR 1:2)</b>\n\n` +
                    `📍 Entry: ${tp1Entry.toFixed(2)}\n` +
                    `🎯 TP1: ${tp1Val.toFixed(2)}\n\n` +
                    `📈 ชนที่ราคา: ${price.toFixed(2)} (เก็บกำไร RR 1:2 ✅)\n` +
                    `🔄 ระบบกลับไปสแกนหาโอกาสใหม่แล้ว...${sourceNote}`;

                await sendSignal(logMsg);

                dashboardState.addSignal({
                    type: 'TP1_HIT',
                    direction,
                    entry: tp1Entry,
                    sl: tp1Sl,
                    currentPrice: price,
                    time: new Date().toISOString()
                });
                sheets.appendSignal({
                    type: 'TP1_HIT',
                    direction,
                    entry: tp1Entry,
                    sl: tp1Sl,
                    currentPrice: price
                });
                return;
            }

            if (isTp2Hit) {
                const tp2Entry = activeTrade.entry;
                const tp2Val = activeTrade.tp2;
                const tp2Sl = activeTrade.sl;

                // เปลี่ยนสถานะทันทีก่อน await เพื่อป้องกัน tick ถัดไปเข้ามาซ้ำ
                currentState = STATES.SCANNING;
                clearActiveSignal();
                dashboardState.update({ botState: currentState });

                const logMsg = `🔥 <b>[TP2 HIT] ออเดอร์ ${direction} ชน Take Profit 2 (RR 1:3)</b>\n\n` +
                    `📍 Entry: ${tp2Entry.toFixed(2)}\n` +
                    `🎯 TP2: ${tp2Val.toFixed(2)}\n\n` +
                    `📈 ชนที่ราคา: ${price.toFixed(2)} (ปิดออเดอร์ทำกำไรสูงสุด)${sourceNote}`;

                await sendSignal(logMsg);

                dashboardState.addSignal({
                    type: 'TP2_HIT',
                    direction,
                    entry: tp2Entry,
                    sl: tp2Sl,
                    currentPrice: price,
                    time: new Date().toISOString()
                });
                sheets.appendSignal({
                    type: 'TP2_HIT',
                    direction,
                    entry: tp2Entry,
                    sl: tp2Sl,
                    currentPrice: price
                });
                return;
            }
        }

        // [M1 ChoCh] ตรวจสอบว่าราคาเหวี่ยงไปชน SL ก่อนที่จะมีแท่ง M1 ปิดทะลุแนว ChoCh หรือไม่
        if (currentState === STATES.WAITING_CHOCH && pendingChoch) {
            const { direction, preCalcSL } = pendingChoch;
            let isInvalidated = false;

            if (direction === 'BUY' && price <= preCalcSL) isInvalidated = true;
            if (direction === 'SELL' && price >= preCalcSL) isInvalidated = true;

            if (isInvalidated) {
                const invalidDir = direction;
                const invalidSL = preCalcSL;

                currentState = STATES.SCANNING;
                clearActiveSignal();
                console.log(`❌ [SMC Engine]: กราฟผิดทาง! ราคาเหวี่ยงชน SL (${invalidSL.toFixed(2)}) ก่อนเบรก ChoCh ระบบกลับไป SCANNING`);
                dashboardState.update({ botState: currentState });

                dashboardState.addSignal({
                    type: 'INVALIDATED',
                    direction: invalidDir,
                    sl: invalidSL,
                    currentPrice: price,
                    time: new Date().toISOString()
                });
                sheets.appendSignal({
                    type: 'INVALIDATED',
                    direction: invalidDir,
                    sl: invalidSL,
                    currentPrice: price
                });

                const sourceNote = source === 'fallback' ? '\n\n⚠️ ตรวจพบจาก TwelveData fallback' : '';
                await sendSignal(`❌ <b>ยกเลิกการรอ ChoCh ${invalidDir}</b>\n\nกราฟผิดทาง ทะลุจุด SL ที่ <b>${invalidSL.toFixed(2)}</b> ก่อนการทำลายโครงสร้าง ChoCh ระบบกลับสู่โหมดสแกนหาโซนใหม่...${sourceNote}`);
                return;
            }
        }

        // [Continuation] ตรวจสอบ FVG Invalidation จาก tick ระหว่างรอ M5 scan
        if (currentState === STATES.SCANNING_CONTINUATION && pendingContinuation) {
            const { direction: contDir, fvg: contFvg } = pendingContinuation;
            const FVG_BREACH_BUFFER = 0.5; // ยอม spike เล็กน้อย แต่ถ้าทะลุ 0.5+ USD = invalidate

            if (contDir === 'BUY' && price < (contFvg.bottom - FVG_BREACH_BUFFER)) {
                console.log(`❌ [Continuation] ราคาทะลุ FVG bottom (${contFvg.bottom.toFixed(2)}) → Invalidate`);
                currentState = STATES.SCANNING;
                clearActiveSignal();
                dashboardState.update({ botState: currentState });
                await sendSignal(`❌ <b>ยกเลิก Continuation BUY</b>\n\nราคาทะลุ FVG bottom ที่ ${contFvg.bottom.toFixed(2)}\nระบบกลับไปสแกนใหม่...`);
                return;
            }
            if (contDir === 'SELL' && price > (contFvg.top + FVG_BREACH_BUFFER)) {
                console.log(`❌ [Continuation] ราคาทะลุ FVG top (${contFvg.top.toFixed(2)}) → Invalidate`);
                currentState = STATES.SCANNING;
                clearActiveSignal();
                dashboardState.update({ botState: currentState });
                await sendSignal(`❌ <b>ยกเลิก Continuation SELL</b>\n\nราคาทะลุ FVG top ที่ ${contFvg.top.toFixed(2)}\nระบบกลับไปสแกนใหม่...`);
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

    } finally {
        isProcessingTick = false;
    }
}

// ─── [M1 ChoCh] ประมวลผลแท่ง M1 ที่ปิดแล้ว ────────────────────────────────
// เรียกจาก Finnhub M1 Candle Builder เมื่อแท่ง M1 ปิด (ทุก 1 นาที)
// ใช้สำหรับยืนยัน ChoCh break แบบ real-time
async function processM1Close(m1Candle) {
    if (currentState !== STATES.WAITING_CHOCH || !pendingChoch) return;

    const { direction, chochTargetPrice, chochMargin, preCalcSL, zoneName, filterMode } = pendingChoch;

    // เช็คว่า M1 close ทะลุ ChoCh target หรือยัง
    const isBreak = checkM1ChochBreak(m1Candle.close, direction, chochTargetPrice, chochMargin);

    const requiredPrice = direction === 'BUY'
        ? chochTargetPrice + chochMargin
        : chochTargetPrice - chochMargin;

    console.log(`   🕐 [M1 Close] ราคาปิด: ${m1Candle.close.toFixed(2)} | เป้า: ${requiredPrice.toFixed(2)} | Break: ${isBreak ? '✅' : '❌'} | Ticks: ${m1Candle.tickCount}`);

    if (!isBreak) return;

    // 🎉 M1 ยืนยัน ChoCh Break!
    console.log(`\n🔥🔥🔥 [M1 ChoCh CONFIRMED] แท่ง M1 ปิดทะลุ ChoCh Target! Direction: ${direction} | Zone: ${zoneName} 🔥🔥🔥`);

    const entryPrice = m1Candle.close;
    let sl = preCalcSL;
    let risk = Math.abs(entryPrice - sl);

    // เช็ค MAX SL
    if (risk > ENGINE_CONFIG.MAX_SL_POINTS) {
        console.log(`   🚫 ข้ามสัญญาณ! ระยะ SL กว้างเกินไป (${risk.toFixed(2)} pts > MAX ${ENGINE_CONFIG.MAX_SL_POINTS} pts) → กลับไป SCANNING`);
        currentState = STATES.SCANNING;
        clearActiveSignal();
        dashboardState.update({ botState: currentState });
        return;
    }

    // MIN risk adjustment
    const minRisk = ENGINE_CONFIG.MIN_TP_POINTS / 2;
    if (risk < minRisk) {
        risk = minRisk;
        sl = direction === 'BUY' ? entryPrice - risk : entryPrice + risk;
    }

    const tp1Price = direction === 'BUY' ? entryPrice + (risk * 2) : entryPrice - (risk * 2);
    const tp2Price = direction === 'BUY' ? entryPrice + (risk * 3) : entryPrice - (risk * 3);

    // Transition: WAITING_CHOCH → TRIGGERED → MONITORING_TRADE
    referenceWickPrice = entryPrice;
    cancelPrice = sl;
    signalDirection = direction;
    currentState = STATES.TRIGGERED;
    waitingStartedAt = null;
    dashboardState.update({ botState: currentState });

    dashboardState.addSignal({
        type: 'TRIGGERED',
        direction: direction,
        entry: entryPrice,
        sl: sl,
        tp1: tp1Price,
        tp2: tp2Price,
        currentPrice: entryPrice,
        time: new Date().toISOString()
    });
    sheets.appendSignal({
        type: 'TRIGGERED',
        direction: direction,
        entry: entryPrice,
        sl: sl,
        tp1: tp1Price,
        tp2: tp2Price,
        currentPrice: entryPrice
    });

    const msg = `🔥 <b>WickHunter XAU | SIGNAL TRIGGERED (M1 ChoCh)</b> 🔥\n\n` +
        `✅ <b>Direction:</b> ${direction}\n` +
        `✅ <b>Action:</b> M1 ยืนยัน ChoCh Break! โครงสร้างเสียทรงจริง\n` +
        `📊 <b>Mode:</b> ${filterMode}\n\n` +
        `📍 <b>Entry Price:</b> ${entryPrice.toFixed(2)}\n` +
        `🛑 <b>Stop Loss:</b> ${sl.toFixed(2)}\n` +
        `🎯 <b>TP 1 (RR 1:2):</b> ${tp1Price.toFixed(2)}\n` +
        `🎯 <b>TP 2 (RR 1:3):</b> ${tp2Price.toFixed(2)}\n\n` +
        `🚀 <b>Current Price:</b> ${entryPrice.toFixed(2)}`;

    await sendSignal(msg);

    activeTrade = {
        direction: direction,
        entry: entryPrice,
        sl: sl,
        tp1: tp1Price,
        tp2: tp2Price,
        isTp1Hit: false,
        time: new Date().toISOString()
    };

    currentState = STATES.MONITORING_TRADE;
    console.log(`🟢 [SMC Engine]: M1 ChoCh สัญญาณถูกส่งแล้ว! เปลี่ยนสถานะบอทเป็น MONITORING_TRADE`);
    dashboardState.update({ botState: currentState, activeTrade });
    pendingChoch = null;
}

function startSmartSyncLoop() {
    checkMarketLogic(); // รันครั้งแรกทันที

    setInterval(() => {
        const now = new Date();
        const minutes = now.getMinutes();
        const seconds = now.getSeconds();

        // รันเฉพาะเมื่อนาทีหาร 5 ลงตัว และอยู่ที่วินาทีที่ 2
        if (minutes % 5 === 0 && seconds === 2) {
            checkMarketLogic();
        }
    }, 1000);
}

startSmartSyncLoop();
setInterval(checkWaitingGuard, WAITING_GUARD_INTERVAL_MS);

module.exports = { processTickData, processM1Close, forceScanNow };