function findFVG(candles) {
    let fvgs = [];
    for (let i = 2; i < candles.length; i++) {
        const c1 = candles[i - 2]; 
        const c3 = candles[i];     

        // Bullish FVG (Gap ขาขึ้น / โซน Buy)
        if (c3.low > c1.high) {
            // [Fix Mitigation] โซนถูกทำลายเมื่อราคา "ปิดต่ำกว่าขอบล่างโซน"
            // (ไม่ใช่แค่ไส้แตะขอบบน ซึ่งทำให้โซนหายเร็วเกินจริง)
            let isMitigated = false;
            for (let j = i + 1; j < candles.length; j++) {
                if (candles[j].close < c1.high) {
                    isMitigated = true;
                    break;
                }
            }

            if (!isMitigated) {
                fvgs.push({
                    type: 'BUY_ZONE',
                    name: 'BULLISH_FVG',
                    top: c3.low,
                    bottom: c1.high
                });
            }
        }
        // Bearish FVG (Gap ขาลง / โซน Sell)
        else if (c3.high < c1.low) {
            // [Fix Mitigation] โซนถูกทำลายเมื่อราคา "ปิดสูงกว่าขอบบนโซน"
            let isMitigated = false;
            for (let j = i + 1; j < candles.length; j++) {
                if (candles[j].close > c1.low) {
                    isMitigated = true;
                    break;
                }
            }

            if (!isMitigated) {
                fvgs.push({
                    type: 'SELL_ZONE',
                    name: 'BEARISH_FVG',
                    top: c1.low,
                    bottom: c3.high
                });
            }
        }
    }
    return fvgs;
}

function findOrderBlock(candles) {
    let orderBlocks = [];
    for (let i = 1; i < candles.length; i++) {
        const prev = candles[i - 1];
        const curr = candles[i];

        const isPrevBearish = prev.close < prev.open;
        const isCurrBullish = curr.close > curr.open;

        const isPrevBullish = prev.close > prev.open;
        const isCurrBearish = curr.close < curr.open;

        // Bullish OB (โซน Buy): แท่งแดงสุดท้าย ก่อนแท่งเขียวพุ่งทะลุ High เดิม
        if (isPrevBearish && isCurrBullish && curr.close > prev.high) {
            // [Fix Mitigation] โซนถูกทำลายเมื่อราคา "ปิดต่ำกว่าขอบล่าง OB"
            let isMitigated = false;
            for (let j = i + 1; j < candles.length; j++) {
                if (candles[j].close < prev.low) {
                    isMitigated = true;
                    break;
                }
            }

            if (!isMitigated) {
                orderBlocks.push({
                    type: 'BUY_ZONE',
                    name: 'BULLISH_OB',
                    top: prev.high,
                    bottom: prev.low,
                });
            }
        }
        // Bearish OB (โซน Sell): แท่งเขียวสุดท้าย ก่อนแท่งแดงเทขายรุนแรง
        else if (isPrevBullish && isCurrBearish && curr.close < prev.low) {
            // [Fix Mitigation] โซนถูกทำลายเมื่อราคา "ปิดสูงกว่าขอบบน OB"
            let isMitigated = false;
            for (let j = i + 1; j < candles.length; j++) {
                if (candles[j].close > prev.high) {
                    isMitigated = true;
                    break;
                }
            }

            if (!isMitigated) {
                orderBlocks.push({
                    type: 'SELL_ZONE',
                    name: 'BEARISH_OB',
                    top: prev.high,
                    bottom: prev.low,
                });
            }
        }
    }
    return orderBlocks;
}

const MATH_CONFIG = {
    MIN_CANDLE_SIZE: 1.5, // กรอง Micro-wicks ขนาดแท่ง M5 ต้องกว้างไม่ต่ำกว่า 1.5 USD (150 จุด)
    CHOCH_LOOKBACK: 3     // เช็กราคาปิดชนะจุดสูงสุด/ต่ำสุดของ 3 แท่งเทียนก่อนหน้า
};

function checkPriceActionInZone(candle, zone) {
    const totalLength = candle.high - candle.low;
    
    // กรองแท่งเทียนที่ไม่มีปริมาณการซื้อขาย (Micro-Wicks) ช่วงตลาดเงียบ
    if (totalLength < MATH_CONFIG.MIN_CANDLE_SIZE) {
        return { isValid: false };
    }

    const bodyLength = Math.abs(candle.open - candle.close);
    
    const lowerWick = Math.min(candle.open, candle.close) - candle.low;
    const upperWick = candle.high - Math.max(candle.open, candle.close);

    const lowerWickPct = lowerWick / totalLength;
    const upperWickPct = upperWick / totalLength;

    const isBullishPA = lowerWickPct > 0.5 && bodyLength < (totalLength * 0.35);
    const isBearishPA = upperWickPct > 0.5 && bodyLength < (totalLength * 0.35);

    if (zone.type === 'BUY_ZONE') {
        const isTouchOrSweepZone = candle.low <= zone.top; 
        const isCloseInsideOrAbove = candle.close >= zone.bottom;

        if (isTouchOrSweepZone && isCloseInsideOrAbove && isBullishPA) {
            return { 
                isValid: true, 
                direction: 'BUY', 
                triggerWickPrice: candle.high,
                cancelPrice: zone.bottom,
                paCandleLow: candle.low,
                paCandleHigh: candle.high
            };
        }
    }

    if (zone.type === 'SELL_ZONE') {
        const isTouchOrSweepZone = candle.high >= zone.bottom;
        const isCloseInsideOrBelow = candle.close <= zone.top;

        if (isTouchOrSweepZone && isCloseInsideOrBelow && isBearishPA) {
            return { 
                isValid: true, 
                direction: 'SELL', 
                triggerWickPrice: candle.low,
                cancelPrice: zone.top,
                paCandleLow: candle.low,
                paCandleHigh: candle.high
            };
        }
    }

    return { isValid: false };
}

function checkChoCh(m5Candles, direction) {
    const lookback = MATH_CONFIG.CHOCH_LOOKBACK;
    if (m5Candles.length < (lookback + 1)) return false;

    const paCandle = m5Candles[m5Candles.length - 1];
    const prevCandles = m5Candles.slice(m5Candles.length - 1 - lookback, m5Candles.length - 1);

    if (direction === 'BUY') {
        // เปรียบเทียบกับ max(Close) ของ 3 แท่งก่อนหน้า (ไม่ใช่ High)
        const maxClose = Math.max(...prevCandles.map(c => c.close));
        return paCandle.close > maxClose;
    }

    if (direction === 'SELL') {
        // เปรียบเทียบกับ min(Close) ของ 3 แท่งก่อนหน้า (ไม่ใช่ Low)
        const minClose = Math.min(...prevCandles.map(c => c.close));
        return paCandle.close < minClose;
    }

    return false;
}

// ─── HTF Trend Filter ─────────────────────────────────────────────────────────
// วิเคราะห์แนวโน้ม H4 จากข้อมูล H1 ที่มีอยู่แล้ว (ไม่ใช้ API เพิ่มแม้แต่ครั้งเดียว)
// เปรียบเทียบโครงสร้าง HH/HL (Bullish) กับ LH/LL (Bearish) ใน 3 กลุ่ม H4
function getHTFTrend(h1Candles) {
    // ต้องการ 12 แท่ง H1 ขึ้นไป (≈ 3 แท่ง H4) เพื่อประเมินแนวโน้ม
    if (h1Candles.length < 12) return 'NEUTRAL';

    const last12 = h1Candles.slice(-12);

    // จำลองแท่ง H4 จาก H1 (กลุ่มละ 4 แท่ง)
    const group1 = last12.slice(0, 4);   // 12-8 ชม.ก่อน (H4 เก่าสุด)
    const group2 = last12.slice(4, 8);   // 8-4 ชม.ก่อน  (H4 กลาง)
    const group3 = last12.slice(8, 12);  // 4 ชม.ล่าสุด  (H4 ใหม่สุด)

    const high1 = Math.max(...group1.map(c => c.high));
    const low1  = Math.min(...group1.map(c => c.low));
    const high2 = Math.max(...group2.map(c => c.high));
    const low2  = Math.min(...group2.map(c => c.low));
    const high3 = Math.max(...group3.map(c => c.high));
    const low3  = Math.min(...group3.map(c => c.low));

    // Bullish: High และ Low ใหม่กว่าเดิมทุกช่วง (HH + HL)
    const isBullish = high3 > high2 && high2 > high1 && low3 > low2;
    // Bearish: High และ Low ต่ำกว่าเดิมทุกช่วง (LH + LL)
    const isBearish = high3 < high2 && high2 < high1 && low3 < low2;

    if (isBullish) return 'BULLISH';
    if (isBearish) return 'BEARISH';
    return 'NEUTRAL';
}

module.exports = { findFVG, findOrderBlock, checkPriceActionInZone, checkChoCh, getHTFTrend };