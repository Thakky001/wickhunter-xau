function findFVG(candles) {
    let fvgs = [];
    for (let i = 2; i < candles.length; i++) {
        const c1 = candles[i - 2]; 
        const c3 = candles[i];     

        // Bullish FVG (Gap ขาขึ้น / โซน Buy)
        if (c3.low > c1.high) {
            // 🔥 ข้อ 3: ตรวจสอบว่าโซนนี้ถูกใช้ (Mitigate) ไปแล้วหรือยัง
            let isMitigated = false;
            for (let j = i + 1; j < candles.length; j++) {
                if (candles[j].low <= c3.low) { // ถ้าราคาลงมาแตะขอบบนโซน = ถูกใช้แล้ว
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
            // 🔥 ข้อ 3: ตรวจสอบว่าโซนนี้ถูกใช้ (Mitigate) ไปแล้วหรือยัง
            let isMitigated = false;
            for (let j = i + 1; j < candles.length; j++) {
                if (candles[j].high >= c3.high) { // ถ้าราคาขึ้นไปแตะขอบล่างโซน = ถูกใช้แล้ว
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
            // 🔥 ข้อ 3: ตรวจสอบว่าโซนนี้ถูกใช้ (Mitigate) ไปแล้วหรือยัง
            let isMitigated = false;
            for (let j = i + 1; j < candles.length; j++) {
                if (candles[j].low <= prev.high) {
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
            // 🔥 ข้อ 3: ตรวจสอบว่าโซนนี้ถูกใช้ (Mitigate) ไปแล้วหรือยัง
            let isMitigated = false;
            for (let j = i + 1; j < candles.length; j++) {
                if (candles[j].high >= prev.low) {
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
                cancelPrice: zone.bottom, // ขอบล่างของโซน H1
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
                cancelPrice: zone.top, // ขอบบนของโซน H1
                paCandleLow: candle.low,
                paCandleHigh: candle.high
            };
        }
    }

    return { isValid: false };
}

function checkChoCh(m5Candles, direction) {
    const lookback = MATH_CONFIG.CHOCH_LOOKBACK;
    // ต้องมีอย่างน้อยจำนวนแท่งเทียนที่ระบุ + แท่ง PA ล่าสุด
    if (m5Candles.length < (lookback + 1)) return false;

    const paCandle = m5Candles[m5Candles.length - 1];
    const prevCandles = m5Candles.slice(m5Candles.length - 1 - lookback, m5Candles.length - 1);

    if (direction === 'BUY') {
        // [Bug#2 Fix] เปลี่ยนจากเทียบ max(High) → max(Close) ของ 3 แท่งก่อนหน้า
        // เหตุผล: แท่ง Pin Bar มี close อยู่ในเนื้อเทียน (ไม่ใช่ที่ยอด High)
        // การเทียบกับ max(High) ทำให้ CHOCH ผ่านได้ยากเกินจริง
        // การเทียบกับ max(Close) = วัดว่า momentum กลับทิศจริงหรือไม่
        const maxClose = Math.max(...prevCandles.map(c => c.close));
        return paCandle.close > maxClose;
    }

    if (direction === 'SELL') {
        // [Bug#2 Fix] เปลี่ยนจากเทียบ min(Low) → min(Close) ของ 3 แท่งก่อนหน้า
        const minClose = Math.min(...prevCandles.map(c => c.close));
        return paCandle.close < minClose;
    }

    return false;
}

module.exports = { findFVG, findOrderBlock, checkPriceActionInZone, checkChoCh };