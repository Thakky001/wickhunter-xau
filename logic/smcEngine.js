const { sendSignal } = require('../services/telegram');
const { findFVG, findOrderBlock, checkPriceActionInZone, checkRecentPA, checkChoCh, getHTFTrend, getTradingRange, checkIDMSweep, checkM1ChochBreak, checkM5BOS, findM5FVG, calculateDynamicBuffers, getBrokerOffset } = require('./smcMath');
const { getCandles } = require('../services/derivWs');
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
let currentBuffers = null; // [ATR] เก็บค่า dynamic buffers ล่าสุด

function getActiveBuffers() {
    return {
        slBuf: currentBuffers ? currentBuffers.dynamicSLBuffer : ENGINE_CONFIG.SL_BUFFER,
        spreadBuf: currentBuffers ? currentBuffers.dynamicSpreadBuffer : ENGINE_CONFIG.SPREAD_BUFFER
    };
}

function getAtrStatsMsg() {
    if (!ENGINE_CONFIG.USE_ATR_BUFFER || !currentBuffers || !currentBuffers.atr14) return '';
    return `\n\n📊 <b>ATR(14):</b> ${currentBuffers.atr14} | <b>Vol Ratio:</b> ${currentBuffers.volatilityRatio}x\n` +
           `🛡️ <b>Buffers:</b> Spread=${currentBuffers.dynamicSpreadBuffer} | SL=${currentBuffers.dynamicSLBuffer}`;
}

// [Fix] ปัดทศนิยม 2 ตำแหน่ง สำหรับค่าราคาที่เก็บเข้า State/ส่งโบรคเกอร์
function roundPrice(v) { return Math.round(v * 100) / 100; }

const ENGINE_CONFIG = {
    SL_MODE: 'SWING_HIGH_LOW',   // 'SWING_HIGH_LOW' (อิงจุดสูงสุด/ต่ำสุดย้อนหลัง), 'PA_WICK' (อิงระดับ M5) หรือ 'ZONE_EDGE'
    SL_BUFFER: 2.0,              // ระยะเผื่อสะบัดปลายไส้ (2.0 USD หรือ 200 จุด)
    SPREAD_BUFFER: 0.5,          // [NEW] ระยะเผื่อสเปรดสเปรดสำหรับไม้ SELL (0.5 USD หรือ 50 จุด)
    USE_ATR_BUFFER: true,        // [ATR] Toggle เปิด/ปิด Dynamic Buffers
    ATR_PERIOD: 14,              // [ATR] ATR period
    ATR_BASELINE_PERIOD: 50,     // [ATR] Baseline period for volatility ratio
    SPREAD_ATR_MULT: 0.25,       // [ATR] Multiplier for spread buffer
    MIN_SPREAD_BUFFER: 0.3,      // [ATR] Minimum spread buffer
    MAX_SPREAD_BUFFER: 3.0,      // [ATR] Maximum spread buffer
    SL_BUFFER_BASE: 2.0,         // [ATR] Base SL buffer
    MIN_SL_BUFFER: 1.5,          // [ATR] Minimum SL buffer
    MAX_SL_BUFFER: 5.0,          // [ATR] Maximum SL buffer
    SWING_LOOKBACK_CANDLES: 10,  // จำนวนแท่ง M5 ย้อนหลังที่ใช้หา Swing High/Low
    MAX_SL_POINTS: 18.0,         // [Fix#1] ขยายจาก 15.0 → 18.0 เพราะ SL อิง zone edge มักกว้างกว่า swing SL
    MIN_TP_POINTS: 8.0,          // จำกัดระยะ TP ขั้นต่ำไม่น้อยกว่า 8.0 USD (800 จุด) เพื่อให้ SL กว้างพอที่จะรอดจากการสะบัด
    ENTRY_MODE: 'CANDLE_CLOSE',  // [Fix#2] สลับเป็น CANDLE_CLOSE เพื่อเข้าที่ราคาปิดแท่ง PA (ไม่ใช่ยอด High ที่เป็น Resistance)
    MAX_ZONE_AGE_HOURS: 48,      // กรองโซน H1 ย้อนหลังไม่เกิน 48 ชั่วโมง (2 วัน)
    CHOCH_M1_MARGIN: 2.0,        // [M1 ChoCh] margin สำหรับยืนยัน ChoCh ผ่านแท่ง M1 (สูงกว่า M5 1.5 เพราะ M1 มี noise มากกว่า)
    CHOCH_WAIT_TIMEOUT_MS: 45 * 60 * 1000,  // [M1 ChoCh] หมดเวลารอ ChoCh break จาก M1 (45 นาที)
    CONT_MAX_SL_POINTS: 10.0,             // [Continuation] SL cap สำหรับ Continuation (แคบกว่า Reversal เพราะ M5 FVG เล็กกว่า H1 Zone)
    CONT_FVG_TIMEOUT_MS: 30 * 60 * 1000,  // [Continuation] 30 นาที timeout รอ pullback มาที่ FVG
    CONT_TP1_RR: 3,                        // [Continuation] TP1 R:R ratio
    CONT_TP2_RR: 5,                        // [Continuation] TP2 R:R ratio (สูงกว่า Reversal เพราะ trend มี momentum)
    USE_H4_FILTER: true,                   // [NEW] Toggle for H4 Trend Alignment (โหมดเทรดกองทุน)
    USE_TRAILING_STOP: true,               // [NEW] Toggle for Partial TP 50% & Trailing Stop
    USE_CE_ENTRY: true,                    // [NEW] Toggle for Consequent Encroachment (50% deep entry)
    BROKER_UTC_OFFSET: 2,                  // [Fix] H4 Timezone: Offset ชั่วโมงจาก UTC ตาม Server โบรคเกอร์ (Exness/ICMarkets = 2, DST = 3)
    MAX_DAILY_LOSS_COUNT: 3                // [NEW] Circuit Breaker: Max Full SL per day
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

let currentDayStr = null;      // [Circuit Breaker] เก็บวันที่ปัจจุบัน
let dailyFullSlCount = 0;      // [Circuit Breaker] นับจำนวน Full SL ในวันนี้

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
        const marketOpen = isMarketOpen();
        
        if (!marketOpen && cachedH1Candles.length > 0) {
            console.log("💤 ตลาดทองคำปิดทำการ บอทเข้าสู่โหมดพักผ่อน...");
            isCheckingMarket = false;
            return;
        }

        // [Circuit Breaker] เช็คจำกัดความเสียหายรายวัน
        const nowStr = new Date().toISOString().split('T')[0];
        if (nowStr !== currentDayStr) {
            currentDayStr = nowStr;
            dailyFullSlCount = 0; // Reset every day at UTC 00:00
        }

        if (dailyFullSlCount >= ENGINE_CONFIG.MAX_DAILY_LOSS_COUNT) {
            console.log(`🛡️ [Circuit Breaker Active] วันนี้โดน Full SL ครบ ${dailyFullSlCount} ไม้แล้ว หยุดเทรดชั่วคราว`);
            isCheckingMarket = false;
            return;
        }

        // [Fix] Always fetch background data regardless of state so dashboard is populated
            const currentHour = new Date().getUTCHours();
            const currentMinute = new Date().getUTCMinutes();

            // [API Fix] หน่วงเวลา 2 นาที เพื่อให้ Server อัปเดตแท่ง H1 ล่าสุดจนเสร็จสมบูรณ์ก่อนดึง
            // [Fix] ใช้ตัวแปรชั่วคราว ป้องกัน cache หายถ้า API ล้มเหลว
            if (cachedH1Candles.length === 0) {
                const newH1 = await getCandles('60', 100); // ดึง 100 แท่ง H1 = ~4 วัน (รองรับ MAX_ZONE_AGE_HOURS: 72)
                if (newH1.length > 0) cachedH1Candles = newH1;
                lastH1FetchHour = currentMinute < 2 ? -1 : currentHour; // ถ้าดึงตอนต้นชั่วโมง ให้บังคับดึงซ้ำอีกทีตอนนาทีที่ 2
                if (cachedH1Candles.length > 0) {
                    console.log(`🔄 [SMC Engine]: โหลดข้อมูลแท่งเทียน H1 เริ่มต้นสำเร็จ`);
                }
            } else if (currentHour !== lastH1FetchHour && currentMinute >= 2) {
                const newH1 = await getCandles('60', 100);
                if (newH1.length > 0) cachedH1Candles = newH1;
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

            // [ATR] คำนวณ Dynamic Buffers จาก M5
            currentBuffers = calculateDynamicBuffers(m5Candles, ENGINE_CONFIG);
            
            // Log ATR status
            if (ENGINE_CONFIG.USE_ATR_BUFFER && currentBuffers.atr14) {
                console.log(`📊 [ATR]: M5 ATR(14)=${currentBuffers.atr14} | Vol Ratio=${currentBuffers.volatilityRatio}x | SpreadBuf=${currentBuffers.dynamicSpreadBuffer} | SLBuf=${currentBuffers.dynamicSLBuffer}`);
                dashboardState.update({ atrStats: currentBuffers });
            }

            const closedH1Candles = cachedH1Candles.slice(0, -1);

            // ค้นหาโซนทั้งหมดก่อน
            const fvgs = findFVG(closedH1Candles, m5Candles);
            const obs = findOrderBlock(closedH1Candles, m5Candles);
            const allFoundZones = [...fvgs, ...obs];

            // กรองหาเฉพาะโซนที่สดใหม่ย้อนหลังไม่เกินอายุที่กำหนด (ใช้จำนวนแท่งเทียน H1 แทนเวลา เพื่อแก้ปัญหาเสาร์อาทิตย์ที่เวลาเดินแต่ไม่มีแท่งเทียน)
            const latestH1Index = closedH1Candles.length - 1;
            const allZones = allFoundZones.filter(z => {
                if (z.candleIndex === undefined) return true;
                return (latestH1Index - z.candleIndex) <= ENGINE_CONFIG.MAX_ZONE_AGE_HOURS;
            });

            let h4Candles = [];
            let currentH4 = null;
            for (let h1 of closedH1Candles) {
                if (!h1.time) continue;
                const d = new Date(h1.time * 1000);
                // [Fix] ปรับเวลาให้ตรงกับ Broker Server อัตโนมัติตามฤดูกาล (DST)
                const currentOffset = getBrokerOffset(d);
                const brokerHour = (d.getUTCHours() + currentOffset) % 24;
                const brokerDate = new Date(d.getTime() + currentOffset * 3600000);
                const h4Block = Math.floor(brokerHour / 4) * 4;
                const key = `${brokerDate.getUTCDate()}-${h4Block}`;

                if (!currentH4 || currentH4.key !== key) {
                    if (currentH4) h4Candles.push(currentH4);
                    currentH4 = {
                        key: key,
                        time: new Date(Date.UTC(brokerDate.getUTCFullYear(), brokerDate.getUTCMonth(), brokerDate.getUTCDate(), h4Block, 0, 0)).toISOString(),
                        open: h1.open,
                        high: h1.high,
                        low: h1.low,
                        close: h1.close
                    };
                } else {
                    currentH4.high = Math.max(currentH4.high, h1.high);
                    currentH4.low = Math.min(currentH4.low, h1.low);
                    currentH4.close = h1.close;
                }
            }
            if (currentH4) h4Candles.push(currentH4);

            // [HTF Filter] คำนวณทิศทาง H4 จาก H4 Candles ที่จัดกลุ่มแล้ว
            const htfTrend = getHTFTrend(h4Candles);
            const h4Trend = ENGINE_CONFIG.USE_H4_FILTER ? htfTrend : null;

            const tradingRange = getTradingRange(closedH1Candles);

            // ─── Dynamic Filter: กำหนด Mode ตาม HTF Trend ──────────────────────────
            const isTrending = (htfTrend === 'BULLISH' || htfTrend === 'BEARISH');
            const depthPct = isTrending ? (ENGINE_CONFIG.USE_CE_ENTRY ? 0.5 : 0.7) : 0.3;
            const filterMode = isTrending ? 'TREND_FOLLOWING' : 'STRICT';
            // ────────────────────────────────────────────────────────────────────────

            const closedM5Candle = m5Candles[m5Candles.length - 2];
            const closedM5Array = m5Candles.slice(0, -1);

            // เช็คสถานะตลาดและเวลาเพื่อส่งไปแสดงบน Dashboard ให้ตรงความจริง
            let displayState = currentState;
            const currentFilterHour = new Date().getUTCHours();
            
            if (!isMarketOpen()) {
                displayState = 'SLEEPING (Weekend)';
            } else if (currentFilterHour < 7 || currentFilterHour > 16) {
                displayState = 'SLEEPING (Out of Session)';
            }

            const filteredFvgs = allZones.filter(z => z.name.includes('FVG'));
            const filteredObs = allZones.filter(z => z.name.includes('OB'));

            // อัปเดต Dashboard State และ Google Sheets หลังสแกนเสร็จ
            dashboardState.update({
                botState: displayState, // ใช้ displayState แทน currentState เพื่อให้ UI รู้ว่ากำลังหลับ
                zonesFound: { fvg: filteredFvgs.length, ob: filteredObs.length, total: allZones.length },
                zones: allZones, // ส่งพิกัดกล่องโซนทั้งหมดให้ Frontend
                tradingRange: tradingRange,
                activeTrade: activeTrade
            });
            sheets.updateBotStatus({
                state: displayState,
                zonesFound: allZones.length,
                lastM5Close: closedM5Candle.close,
                wsStatus: 'CONNECTED'
            });

            // ─── DEBUG: สรุปผลการสแกนรอบนี้ ───────────────────────────────
            const now = new Date().toLocaleTimeString('th-TH');
            console.log(`\n─────────────────────────────────────────`);
            console.log(`🔍 [SCAN] ${now} | State: ${currentState}`);
            console.log(`   📊 H1 Zones พบทั้งหมด: ${allZones.length} โซน (FVG: ${filteredFvgs.length}, OB: ${filteredObs.length})`);
            if (tradingRange) {
                console.log(`   📐 [Midpoint] Median Close 24H: ${tradingRange.midpoint.toFixed(2)} | Range: ${tradingRange.low.toFixed(2)} - ${tradingRange.high.toFixed(2)}`);
            }
            console.log(`   📈 [HTF Trend H4]: ${htfTrend} → [${filterMode}] depth: ${depthPct * 100}%, IDM: ${isTrending ? 'ไม่บังคับ' : 'บังคับ'}`);
            console.log(`   🕯️  M5 แท่งปิดล่าสุด | O:${closedM5Candle.open.toFixed(2)} H:${closedM5Candle.high.toFixed(2)} L:${closedM5Candle.low.toFixed(2)} C:${closedM5Candle.close.toFixed(2)}`);
            if (allZones.length > 0) {
                allZones.forEach((z, idx) => {
                    const dir = z.type === 'BUY_ZONE' ? '🟢 BUY' : '🔴 SELL';
                    console.log(`   📌 [${idx + 1}] ${z.name} (${dir}) | ${z.bottom.toFixed(2)} - ${z.top.toFixed(2)}`);
                });
            }
            // ───────────────────────────────────────────────────────────────

        if (currentState === STATES.SCANNING) {
            if (!isMarketOpen()) {
                console.log(`💤 อัปเดตข้อมูลย้อนหลัง 48 ชม. ลง Dashboard เรียบร้อยแล้ว เข้าสู่โหมดพักผ่อนช่วงสุดสัปดาห์...`);
                isCheckingMarket = false;
                return;
            }

            if (currentFilterHour < 7 || currentFilterHour > 16) {
                console.log(`⏳ อยู่นอกเวลาเทรดยุโรป-อเมริกา (07:00-16:00 UTC) ข้ามการสแกนหาจุดเข้า...`);
                isCheckingMarket = false;
                return;
            }

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
                    if (ENGINE_CONFIG.USE_H4_FILTER && h4Trend) {
                        if (h4Trend === 'BEARISH' && zone.type === 'BUY_ZONE') {
                            console.log(`   🚫 [H4] ข้าม ${zone.name} เพราะ H4 Bearish → ห้าม BUY`);
                            continue;
                        }
                        if (h4Trend === 'BULLISH' && zone.type === 'SELL_ZONE') {
                            console.log(`   🚫 [H4] ข้าม ${zone.name} เพราะ H4 Bullish → ห้าม SELL`);
                            continue;
                        }
                    }

                    if (htfTrend === 'BEARISH' && zone.type === 'BUY_ZONE') {
                        console.log(`   🚫 [H1] ข้าม ${zone.name} เพราะ H1 Bearish → ห้าม BUY`);
                        continue;
                    }
                    if (htfTrend === 'BULLISH' && zone.type === 'SELL_ZONE') {
                        console.log(`   🚫 [H1] ข้าม ${zone.name} เพราะ H1 Bullish → ห้าม SELL`);
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
                            // 🛡️ STRICT MODE: ตัด IDM ออก (ให้ตรงกับ Backtest) เหลือแค่ด่าน PA + ChoCh
                            if (hasChoCh && isFreshBreakout) {
                                console.log(`   ✅ [STRICT] PA+ChoCh ผ่านครบ (Fresh Breakout) → เข้าเทรดได้`);
                                shouldTrigger = true;
                            } else if (hasChoCh && !isFreshBreakout) {
                                console.log(`   ⏭️  [STRICT] สัญญาณช้าไป (Late Entry) โครงสร้างเบรคไปแล้วตั้งแต่อดีต → รอรอบถัดไป`);
                            } else if (!hasChoCh && chochResult.targetPrice) {
                                console.log(`   ⏳ [STRICT] ChoCh Target พบแล้ว (${chochResult.targetPrice.toFixed(2)}) → เข้า WAITING_CHOCH รอ M1 ยืนยัน Break`);
                                shouldWaitChoch = true;
                            } else {
                                console.log(`   ⏭️  [STRICT] หา ChoCh Target ไม่เจอ หรือยังไม่เบรค → รอรอบถัดไป`);
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
                                    const zoneEdgeSL = paResult.cancelPrice - getActiveBuffers().slBuf; // zone.bottom - buffer
                                    // [Fix#1 Hybrid] ใช้ตัวที่ไกลกว่า (ปลอดภัยกว่า) ระหว่าง swing กับ zone edge
                                    preCalcSL = Math.min(swingLow - getActiveBuffers().slBuf, zoneEdgeSL);
                                } else {
                                    const swingHigh = Math.max(...recentCandles.map(c => c.high));
                                    const zoneEdgeSL = paResult.cancelPrice + getActiveBuffers().slBuf + getActiveBuffers().spreadBuf; // zone.top + buffer
                                    // [Fix#1 Hybrid] ใช้ตัวที่ไกลกว่า (ปลอดภัยกว่า) ระหว่าง swing กับ zone edge
                                    preCalcSL = Math.max(swingHigh + getActiveBuffers().slBuf + getActiveBuffers().spreadBuf, zoneEdgeSL);
                                }
                            } else {
                                preCalcSL = paResult.direction === 'BUY'
                                    ? paResult.paCandleLow - getActiveBuffers().slBuf
                                    : paResult.paCandleHigh + getActiveBuffers().slBuf + getActiveBuffers().spreadBuf;
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
                            dashboardState.update({ botState: currentState, pendingChoch: pendingChoch });

                            const requiredBreakPrice = paResult.direction === 'BUY'
                                ? chochResult.targetPrice + ENGINE_CONFIG.CHOCH_M1_MARGIN
                                : chochResult.targetPrice - ENGINE_CONFIG.CHOCH_M1_MARGIN;

                            const preAlertMsg = `⏳ <b>เตรียมตัว! พบ PA${filterMode === 'STRICT' ? ' + IDM' : ''} ในโซน ${zone.name} H1</b>\n\n` +
                                `📊 รอยืนยัน ChoCh จากแท่ง <b>M1 Real-time</b> (Deriv WebSocket)\n` +
                                `🎯 เป้า ChoCh: ${chochResult.targetPrice.toFixed(2)} (ต้อง${paResult.direction === 'BUY' ? 'ปิดเหนือ' : 'ปิดใต้'} ${requiredBreakPrice.toFixed(2)})\n\n` +
                                `📍 SL โดยประมาณ: ${preCalcSL.toFixed(2)}\n` +
                                `⏱️ หมดเวลาใน: ${ENGINE_CONFIG.CHOCH_WAIT_TIMEOUT_MS / 60000} นาที`;

                            // [User Request: ซ่อน Alert จุดเตรียมเข้า เพื่อลดความรำคาญ]
                            // await sendSignal(preAlertMsg);

                            break; // ออกจาก zone loop
                        }

                        if (!shouldTrigger) continue;
                        foundValidSignal = true;

                        signalDirection = paResult.direction;
                        lastTradedCandleTime = closedM5Candle.time; // บันทึกเวลาแท่งเทียนที่ส่งสัญญาณไปแล้ว เพื่อป้องกันการส่งซ้ำ

                        // 🌟 โหมด ENTRY_MODE === 'CANDLE_CLOSE' (เข้าทันทีที่ปิดแท่ง PA M5 ยืนยันสัญญาณ)
                        if (ENGINE_CONFIG.ENTRY_MODE === 'CANDLE_CLOSE') {
                            // [Fix] รวมค่า Spread เข้าไปในจุดเข้า เพื่อให้สะท้อนต้นทุนจริงเวลา Market Execution
                            referenceWickPrice = signalDirection === 'BUY' 
                                ? closedM5Candle.close + getActiveBuffers().spreadBuf 
                                : closedM5Candle.close - getActiveBuffers().spreadBuf;

                            if (ENGINE_CONFIG.SL_MODE === 'SWING_HIGH_LOW') {
                                const pIndex = paResult.candleIndex;
                                const entryIndex = closedM5Array.length - 1; // แท่งที่เกิด ChoCh (ปัจจุบัน)
                                const recentCandles = closedM5Array.slice(pIndex, entryIndex + 1);
                                if (signalDirection === 'BUY') {
                                    const swingLow = Math.min(...recentCandles.map(c => c.low));
                                    const zoneEdgeSL = paResult.cancelPrice - getActiveBuffers().slBuf; // zone.bottom - buffer
                                    // [Fix#1 Hybrid] ใช้ตัวที่ไกลกว่า (ปลอดภัยกว่า) ระหว่าง swing กับ zone edge
                                    cancelPrice = Math.min(swingLow - getActiveBuffers().slBuf, zoneEdgeSL);
                                } else {
                                    const swingHigh = Math.max(...recentCandles.map(c => c.high));
                                    const zoneEdgeSL = paResult.cancelPrice + getActiveBuffers().slBuf + getActiveBuffers().spreadBuf; // zone.top + buffer
                                    // [Fix#1 Hybrid] ใช้ตัวที่ไกลกว่า (ปลอดภัยกว่า) ระหว่าง swing กับ zone edge
                                    cancelPrice = Math.max(swingHigh + getActiveBuffers().slBuf + getActiveBuffers().spreadBuf, zoneEdgeSL);
                                }
                            } else {
                                // [Bug#3 Fix] CANDLE_CLOSE mode ต้องใช้ PA_WICK เสมอ
                                // เพราะ entry คือ candle.close (กลางแท่ง) ถ้าใช้ Zone Edge SL จะกว้างเกิน R:R บิดเบือน
                                cancelPrice = signalDirection === 'BUY'
                                    ? paResult.paCandleLow - getActiveBuffers().slBuf
                                    : paResult.paCandleHigh + getActiveBuffers().slBuf + getActiveBuffers().spreadBuf;
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

                            const tp1Price = signalDirection === 'BUY' ? referenceWickPrice + (risk * 3) : referenceWickPrice - (risk * 3);
                            const tp2Price = signalDirection === 'BUY' ? referenceWickPrice + (risk * 4) : referenceWickPrice - (risk * 4);

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

                            let msg = `🔥 <b>WickHunter XAU | SIGNAL TRIGGERED (CANDLE CLOSE)</b> 🔥\n\n` +
                                `✅ <b>Direction:</b> ${signalDirection}\n` +
                                `✅ <b>Action:</b> สัญญาณกลับตัวยืนยันที่ราคาปิดแท่ง!\n\n` +
                                `📍 <b>Entry Price:</b> ${referenceWickPrice.toFixed(2)}\n` +
                                `🛑 <b>Stop Loss:</b> ${cancelPrice.toFixed(2)}\n`;

                            if (ENGINE_CONFIG.USE_TRAILING_STOP) {
                                msg += `\n🎯 <b>Action Plan (Trailing Mode):</b>\n` +
                                       `1️⃣ เปิด 2 ไม้พร้อมกัน (แบ่ง Lot ครึ่งนึง)\n` +
                                       `2️⃣ ไม้แรก: ตั้ง TP = ${tp1Price.toFixed(2)} (ปิดล็อกกำไร 50%)\n` +
                                       `3️⃣ ไม้สอง: ปล่อย TP ว่างไว้ + รอเลื่อน SL บังหน้าทุนเมื่อไม้แรกชน TP\n\n`;
                            } else {
                                msg += `🎯 <b>TP 1 (RR 1:3):</b> ${tp1Price.toFixed(2)}\n` +
                                       `🎯 <b>TP 2 (RR 1:4):</b> ${tp2Price.toFixed(2)}\n\n`;
                            }

                            msg += `🚀 <b>Current Price:</b> ${referenceWickPrice.toFixed(2)}`;

                            await sendSignal(msg + getAtrStatsMsg());
                            activeTrade = {
                                direction: signalDirection,
                                entry: roundPrice(referenceWickPrice),
                                sl: roundPrice(cancelPrice),
                                tp1: roundPrice(tp1Price),
                                tp2: roundPrice(tp2Price),
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
                                const zoneEdgeSL = paResult.cancelPrice - getActiveBuffers().slBuf; // zone.bottom - buffer
                                // [Fix#1 Hybrid] ใช้ตัวที่ไกลกว่า (ปลอดภัยกว่า) ระหว่าง swing กับ zone edge
                                cancelPrice = Math.min(swingLow - getActiveBuffers().slBuf, zoneEdgeSL);
                            } else {
                                const swingHigh = Math.max(...recentCandles.map(c => c.high));
                                const zoneEdgeSL = paResult.cancelPrice + getActiveBuffers().slBuf + getActiveBuffers().spreadBuf; // zone.top + buffer
                                // [Fix#1 Hybrid] ใช้ตัวที่ไกลกว่า (ปลอดภัยกว่า) ระหว่าง swing กับ zone edge
                                cancelPrice = Math.max(swingHigh + getActiveBuffers().slBuf + getActiveBuffers().spreadBuf, zoneEdgeSL);
                            }
                        } else if (ENGINE_CONFIG.SL_MODE === 'PA_WICK') {
                            cancelPrice = signalDirection === 'BUY'
                                ? paResult.paCandleLow - getActiveBuffers().slBuf
                                : paResult.paCandleHigh + getActiveBuffers().slBuf + getActiveBuffers().spreadBuf;
                        } else {
                            cancelPrice = signalDirection === 'BUY'
                                ? paResult.cancelPrice
                                : paResult.cancelPrice + getActiveBuffers().spreadBuf;
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

                        const previewMsg = `⏳ <b>เตรียมตัว! พบการกลับตัวในโซน ${zone.name} H1</b>\n\n` +
                            `ดักรอการ <b>เบรกปลายไส้ (M5)</b> ฝั่ง ${signalDirection}\n\n` +
                            `📍 <b>Entry:</b> ${referenceWickPrice.toFixed(2)}\n` +
                            `🛑 <b>SL (${ENGINE_CONFIG.SL_MODE === 'PA_WICK' ? 'PA Wick' : ENGINE_CONFIG.SL_MODE === 'SWING_HIGH_LOW' ? 'Swing H/L' : 'Zone Edge'}):</b> ${cancelPrice.toFixed(2)}\n` +
                            `🎯 <b>TP1 (1:2):</b> ${tp1.toFixed(2)}\n` +
                            `🎯 <b>TP2 (1:3):</b> ${tp2.toFixed(2)}`; // [Bug#2 Fix] แสดง TP2 ด้วย

                        // await sendSignal(previewMsg);
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
                            // [Fix] รวมค่า Spread เข้าไปในจุดเข้า
                            const entryPrice = bosDirection === 'BUY'
                                ? closedM5Candle.close + getActiveBuffers().spreadBuf
                                : closedM5Candle.close - getActiveBuffers().spreadBuf;
                            const sl = bosDirection === 'BUY'
                                ? fvg.bottom - getActiveBuffers().slBuf
                                : fvg.top + getActiveBuffers().slBuf + getActiveBuffers().spreadBuf;
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

                                await sendSignal(contMsg + getAtrStatsMsg());
                                activeTrade = { direction: bosDirection, entry: roundPrice(entryPrice), sl: roundPrice(sl), tp1: roundPrice(tp1Price), tp2: roundPrice(tp2Price), isTp1Hit: false, time: new Date().toISOString() };
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
                            // await sendSignal(preAlertMsg);
                        }
                    } else {
                        console.log(`   ❌ [Continuation] ไม่พบ M5 FVG ระหว่าง BOS impulse`);
                    }
                } else {
                    console.log(`   ❌ [Continuation] ไม่พบ M5 BOS หรือโครงสร้างยังไม่เบรกตามเทรนด์ (${bosDirection})`);
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
                // [Fix] รวมค่า Spread เข้าไปในจุดเข้า
                const entryPrice = contDir === 'BUY'
                    ? latestContCandle.close + getActiveBuffers().spreadBuf
                    : latestContCandle.close - getActiveBuffers().spreadBuf;
                const sl = contDir === 'BUY'
                    ? contFvg.bottom - getActiveBuffers().slBuf
                    : contFvg.top + getActiveBuffers().slBuf + getActiveBuffers().spreadBuf;
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

                    await sendSignal(contMsg + getAtrStatsMsg());
                    activeTrade = { direction: contDir, entry: roundPrice(entryPrice), sl: roundPrice(sl), tp1: roundPrice(tp1Price), tp2: roundPrice(tp2Price), isTp1Hit: false, time: new Date().toISOString() };
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
    clearActiveSignal();
}

// ─── [M1 ChoCh] หมดเวลารอ ChoCh break จาก M1 ────────────────────────────
async function expireWaitingChoch() {
    if (currentState !== STATES.WAITING_CHOCH) return;

    const direction = pendingChoch ? pendingChoch.direction : signalDirection;

    currentState = STATES.SCANNING;
    console.log(`⌛ [SMC Engine]: WAITING_CHOCH ${direction} หมดอายุ ระบบกลับไป SCANNING`);
    dashboardState.update({ botState: currentState });
    clearActiveSignal();

    // await sendSignal(`⌛ <b>หมดอายุ WAITING_CHOCH ${direction}</b>\n\nรอ M1 ยืนยัน ChoCh นานเกิน ${ENGINE_CONFIG.CHOCH_WAIT_TIMEOUT_MS / 60000} นาที แต่ราคาไม่ทะลุเป้า ${target > 0 ? target.toFixed(2) : '-'}\nระบบกลับสู่โหมดสแกนหาโซนใหม่...`);
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
            // await sendSignal(`⌛ <b>หมดเวลา Continuation ${contDir}</b>\n\nรอ pullback มาที่ FVG (${contFvg.bottom.toFixed(2)}-${contFvg.top.toFixed(2)}) นานเกิน ${ENGINE_CONFIG.CONT_FVG_TIMEOUT_MS / 60000} นาที\nระบบกลับสู่โหมดสแกนใหม่...`);
        } catch (error) {
            console.error("❌ [SMC Engine Error] expireContinuation failed:", error);
        } finally {
            isCheckingWaitingGuard = false;
        }
        return;
    }

    if (now - lastFallbackCheckAt < FALLBACK_CHECK_COOLDOWN_MS) return;

    // [Fix] เช็กว่ามี tick จริงไหม ไม่ใช่แค่ ws connected
    // ถ้า tick ล่าสุดยังไม่เกิน TICK_STALE_MS (60s) ถือว่า data ไหลปกติ ไม่ต้อง fallback
    if ((now - lastTickAt) < TICK_STALE_MS) return;

    isCheckingWaitingGuard = true;
    lastFallbackCheckAt = now;
    try {
        console.log("🛰️ [SMC Engine]: Deriv tick ขาดช่วง → เช็ก M5 จาก Deriv API (Fallback)");
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
                ? '\n\n⚠️ ตรวจพบจาก Deriv API (Fallback)'
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

                let circuitBreakerMsg = '';
                const nowStr = new Date().toISOString().split('T')[0];
                if (nowStr !== currentDayStr) {
                    currentDayStr = nowStr;
                    dailyFullSlCount = 1;
                } else {
                    dailyFullSlCount++;
                }
                
                if (dailyFullSlCount >= ENGINE_CONFIG.MAX_DAILY_LOSS_COUNT) {
                    circuitBreakerMsg = `\n\n🛡️ <b>[CIRCUIT BREAKER ACTIVE]</b>\nโดนกิน Full SL ครบ ${dailyFullSlCount} ไม้ในวันนี้ ระบบหยุดสแกนชั่วคราว เริ่มสแกนใหม่พรุ่งนี้เช้าเพื่อป้องกันพอร์ตครับ`;
                }

                const logMsg = `❌ <b>[SL HIT] ออเดอร์ ${invalidDir} ชน Stop Loss</b>\n\n` +
                    `📍 Entry: ${invalidEntry.toFixed(2)}\n` +
                    `🛑 SL: ${invalidSL.toFixed(2)}\n` +
                    `🎯 TP1: ${tp1Val.toFixed(2)}\n` +
                    `🎯 TP2: ${tp2Val.toFixed(2)}\n\n` +
                    `📉 ชนที่ราคา: ${price.toFixed(2)} (ขาดทุน)${sourceNote}${circuitBreakerMsg}`;

                await sendSignal(logMsg);

                dashboardState.addSignal({
                    type: 'SL_HIT',
                    direction: invalidDir,
                    entry: invalidEntry,
                    sl: invalidSL,
                    tp1: activeTrade.tp1,
                    tp2: activeTrade.tp2,
                    currentPrice: price,
                    time: new Date().toISOString()
                });
                sheets.appendSignal({
                    type: 'SL_HIT',
                    direction: invalidDir,
                    entry: invalidEntry,
                    sl: invalidSL,
                    tp1: activeTrade.tp1,
                    tp2: activeTrade.tp2,
                    currentPrice: price
                });
                return;
            }

            if (isTp1Hit) {
                const tp1Entry = activeTrade.entry;
                const tp1Val = activeTrade.tp1;
                const tp1Sl = activeTrade.sl;

                let logMsg = '';
                
                if (ENGINE_CONFIG.USE_TRAILING_STOP) {
                    // Trailing Mode: ล็อกกำไร 50% เลื่อน SL บังทุน และรอ TP2
                    activeTrade.isTp1Hit = true;
                    activeTrade.sl = activeTrade.entry; // เลื่อน SL บังหน้าทุน
                    dashboardState.update({ activeTrade }); // คงสถานะ MONITORING_TRADE ไว้
                    
                    logMsg = `🎯 <b>[TP1 HIT - Trailing Active] ออเดอร์ ${direction} ชน TP1 (RR 1:3)</b>\n\n` +
                        `📍 Entry: ${tp1Entry.toFixed(2)}\n` +
                        `🎯 TP1: ${tp1Val.toFixed(2)}\n\n` +
                        `✅ ปิดล็อกกำไรไม้แรกแล้ว!\n` +
                        `🛡️ ระบบเลื่อน SL บังทุนที่ ${activeTrade.sl.toFixed(2)}\n` +
                        `🚀 ลุ้นปล่อยรันไม้สองไปที่ TP2 (${activeTrade.tp2.toFixed(2)})${sourceNote}`;
                } else {
                    // Normal Mode: ปิดออเดอร์ทั้งหมด
                    currentState = STATES.SCANNING;
                    clearActiveSignal();
                    dashboardState.update({ botState: currentState });

                    logMsg = `🎯 <b>[TP1 HIT] ออเดอร์ ${direction} ชน Take Profit 1 (RR 1:3)</b>\n\n` +
                        `📍 Entry: ${tp1Entry.toFixed(2)}\n` +
                        `🎯 TP1: ${tp1Val.toFixed(2)}\n\n` +
                        `📈 ชนที่ราคา: ${price.toFixed(2)} (เก็บกำไร RR 1:3 ✅)\n` +
                        `🔄 ระบบกลับไปสแกนหาโอกาสใหม่แล้ว...${sourceNote}`;
                }

                await sendSignal(logMsg);

                dashboardState.addSignal({
                    type: 'TP1_HIT',
                    direction,
                    entry: tp1Entry,
                    sl: tp1Sl,
                    tp1: tp1Val,
                    tp2: activeTrade.tp2,
                    currentPrice: price,
                    time: new Date().toISOString()
                });
                sheets.appendSignal({
                    type: 'TP1_HIT',
                    direction,
                    entry: tp1Entry,
                    sl: tp1Sl,
                    tp1: tp1Val,
                    tp2: activeTrade.tp2,
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

                const logMsg = `🔥 <b>[TP2 HIT] ออเดอร์ ${direction} ชน Take Profit 2 (RR 1:4)</b>\n\n` +
                    `📍 Entry: ${tp2Entry.toFixed(2)}\n` +
                    `🎯 TP2: ${tp2Val.toFixed(2)}\n\n` +
                    `📈 ชนที่ราคา: ${price.toFixed(2)} (ปิดออเดอร์ทำกำไรสูงสุด)${sourceNote}`;

                await sendSignal(logMsg);

                dashboardState.addSignal({
                    type: 'TP2_HIT',
                    direction,
                    entry: tp2Entry,
                    sl: tp2Sl,
                    tp1: activeTrade.tp1,
                    tp2: tp2Val,
                    currentPrice: price,
                    time: new Date().toISOString()
                });
                sheets.appendSignal({
                    type: 'TP2_HIT',
                    direction,
                    entry: tp2Entry,
                    sl: tp2Sl,
                    tp1: activeTrade.tp1,
                    tp2: tp2Val,
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
                // sheets.appendSignal({
                //     type: 'INVALIDATED',
                //     direction: invalidDir,
                //     sl: invalidSL,
                //     currentPrice: price
                // });

                const sourceNote = source === 'fallback' ? '\n\n⚠️ ตรวจพบจาก Deriv API (Fallback)' : '';
                // await sendSignal(`❌ <b>ยกเลิกการรอ ChoCh ${invalidDir}</b>\n\nกราฟผิดทาง ทะลุจุด SL ที่ <b>${invalidSL.toFixed(2)}</b> ก่อนการทำลายโครงสร้าง ChoCh ระบบกลับสู่โหมดสแกนหาโซนใหม่...${sourceNote}`);
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
                // await sendSignal(`❌ <b>ยกเลิก Continuation BUY</b>\n\nราคาทะลุ FVG bottom ที่ ${contFvg.bottom.toFixed(2)}\nระบบกลับไปสแกนใหม่...`);
                return;
            }
            if (contDir === 'SELL' && price > (contFvg.top + FVG_BREACH_BUFFER)) {
                console.log(`❌ [Continuation] ราคาทะลุ FVG top (${contFvg.top.toFixed(2)}) → Invalidate`);
                currentState = STATES.SCANNING;
                clearActiveSignal();
                dashboardState.update({ botState: currentState });
                // await sendSignal(`❌ <b>ยกเลิก Continuation SELL</b>\n\nราคาทะลุ FVG top ที่ ${contFvg.top.toFixed(2)}\nระบบกลับไปสแกนใหม่...`);
                return;
            }
        }

        if (currentState === STATES.WAITING_WICK_BREAK) {
            const sourceLabel = source === 'fallback' ? 'FALLBACK' : 'TICK';
            const sourceNote = source === 'fallback'
                ? '\n\n⚠️ ตรวจพบจาก Fallback (Deriv API) เพราะ WebSocket tick ขาดช่วง'
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
                // sheets.appendSignal({
                //     type: 'INVALIDATED',
                //     direction: invalidDir,
                //     entry: invalidEntry,
                //     sl: invalidSL,
                //     currentPrice: price
                // });

                // await sendSignal(`❌ <b>ยกเลิกสัญญาณ ${invalidDir}</b>\n\nกราฟผิดทาง ทะลุจุด SL ที่ <b>${invalidSL.toFixed(2)}</b> ก่อนการเบรก ระบบกลับสู่โหมดสแกนหาโซนใหม่...${sourceNote}`);
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
                    tp1Price = referenceWickPrice + (risk * 3);
                    tp2Price = referenceWickPrice + (risk * 4);
                } else if (signalDirection === 'SELL') {
                    tp1Price = referenceWickPrice - (risk * 3);
                    tp2Price = referenceWickPrice - (risk * 4);
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
                    `🎯 <b>TP 1 (RR 1:3):</b> ${tp1Price.toFixed(2)}\n` +
                    `🎯 <b>TP 2 (RR 1:4):</b> ${tp2Price.toFixed(2)}\n\n` +
                    `🚀 <b>Current Price:</b> ${price.toFixed(2)}${sourceNote}`;

                await sendSignal(msg + getAtrStatsMsg());
                activeTrade = {
                    direction: signalDirection,
                    entry: roundPrice(referenceWickPrice),
                    sl: roundPrice(slPrice),
                    tp1: roundPrice(tp1Price),
                    tp2: roundPrice(tp2Price),
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
// เรียกจาก Deriv M1 Candle Builder เมื่อแท่ง M1 ปิด (ทุก 1 นาที)
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

    // [Fix] รวมค่า Spread เข้าไปในจุดเข้า
    const entryPrice = direction === 'BUY'
        ? m1Candle.close + getActiveBuffers().spreadBuf
        : m1Candle.close - getActiveBuffers().spreadBuf;
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

    const tp1Price = direction === 'BUY' ? entryPrice + (risk * 3) : entryPrice - (risk * 3);
    const tp2Price = direction === 'BUY' ? entryPrice + (risk * 4) : entryPrice - (risk * 4);

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
        `🎯 <b>TP 1 (RR 1:3):</b> ${tp1Price.toFixed(2)}\n` +
        `🎯 <b>TP 2 (RR 1:4):</b> ${tp2Price.toFixed(2)}\n\n` +
        `🚀 <b>Current Price:</b> ${entryPrice.toFixed(2)}`;

    await sendSignal(msg + getAtrStatsMsg());

    activeTrade = {
        direction: direction,
        entry: roundPrice(entryPrice),
        sl: roundPrice(sl),
        tp1: roundPrice(tp1Price),
        tp2: roundPrice(tp2Price),
        isTp1Hit: false,
        time: new Date().toISOString()
    };

    currentState = STATES.MONITORING_TRADE;
    console.log(`🟢 [SMC Engine]: M1 ChoCh สัญญาณถูกส่งแล้ว! เปลี่ยนสถานะบอทเป็น MONITORING_TRADE`);
    dashboardState.update({ botState: currentState, activeTrade });
    pendingChoch = null;
}

let isLoopStarted = false;
function startSmartSyncLoop() {
    if (isLoopStarted) return;
    isLoopStarted = true;
    checkMarketLogic(); // รันครั้งแรกทันที
    scheduleNextScan();
}

// [Fix] คำนวณเวลาที่เหลือถึงนาทีถัดไปที่หาร 5 ลงตัว (วินาทีที่ 2) แล้วตั้ง setTimeout ยิงทีเดียว
function scheduleNextScan() {
    const now = new Date();
    const mins = now.getMinutes();
    const secs = now.getSeconds();
    const ms = now.getMilliseconds();

    // หานาทีถัดไปที่หาร 5 ลงตัว
    const nextMin5 = Math.ceil((mins + 1) / 5) * 5;
    const target = new Date(now);
    target.setMinutes(nextMin5, 2, 0); // วินาทีที่ 2, มิลลิวินาทีที่ 0

    let delay = target.getTime() - now.getTime();
    if (delay <= 0) delay += 5 * 60 * 1000; // ถ้าเลยเวลาไปแล้ว ข้ามไป 5 นาทีถัดไป

    setTimeout(() => {
        checkMarketLogic();
        scheduleNextScan(); // ตั้งรอบถัดไป
    }, delay);
}

// startSmartSyncLoop(); // [Fix] ถูกย้ายไปเรียกจาก derivWs.js ตอนที่ WebSocket Connect สำเร็จแล้ว
setInterval(checkWaitingGuard, WAITING_GUARD_INTERVAL_MS);

function updateConfig(newConfig) {
    if (newConfig.hasOwnProperty('USE_H4_FILTER')) {
        ENGINE_CONFIG.USE_H4_FILTER = newConfig.USE_H4_FILTER;
    }
    if (newConfig.hasOwnProperty('USE_TRAILING_STOP')) {
        ENGINE_CONFIG.USE_TRAILING_STOP = newConfig.USE_TRAILING_STOP;
    }
    if (newConfig.hasOwnProperty('USE_CE_ENTRY')) {
        ENGINE_CONFIG.USE_CE_ENTRY = newConfig.USE_CE_ENTRY;
    }
    console.log(`\n⚙️ [Config Updated]: H4=${ENGINE_CONFIG.USE_H4_FILTER}, Trailing=${ENGINE_CONFIG.USE_TRAILING_STOP}, CE_Entry=${ENGINE_CONFIG.USE_CE_ENTRY}`);
}

function resumeStateFromHistory(signals) {
    if (!signals || signals.length === 0) return;

    // หา order ที่เป็น TRIGGERED ล่าสุด (หรือ TP1_HIT ล่าสุด)
    // โดยตรวจสอบว่า order นั้นยังไม่ได้ถูกปิดด้วย TP2_HIT หรือ SL_HIT
    let activeSignal = null;
    let hasClosed = false;

    for (let i = signals.length - 1; i >= 0; i--) {
        const sig = signals[i];
        if (sig.type === 'TP2_HIT' || sig.type === 'SL_HIT' || sig.type === 'EXPIRED') {
            hasClosed = true;
            break; // ถ้าเจอปิด order ไปแล้ว แสดงว่าไม่มี active order
        }
        if (sig.type === 'TRIGGERED' || sig.type === 'TP1_HIT') {
            activeSignal = sig;
            break;
        }
    }

    if (activeSignal && !hasClosed) {
        // ฟื้นคืนชีพ activeTrade
        activeTrade = {
            direction: activeSignal.direction,
            entry: activeSignal.entry,
            sl: activeSignal.sl,
            tp1: activeSignal.tp1,
            tp2: activeSignal.tp2,
            isTp1Hit: activeSignal.type === 'TP1_HIT'
        };
        currentState = STATES.MONITORING_TRADE;
        dashboardState.update({ botState: currentState, activeTrade });
        console.log(`\n🔄 [SMC Engine]: ฟื้นคืนชีพ Order เก่าที่ค้างอยู่ (${activeSignal.type} ${activeTrade.direction} @ ${activeTrade.entry}) -> เข้าสู่สถานะ MONITORING_TRADE`);
    }
}

module.exports = { processTickData, processM1Close, forceScanNow, ENGINE_CONFIG, updateConfig, startSmartSyncLoop, resumeStateFromHistory };