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

function checkPriceActionInZone(candle, zone) {
    const totalLength = candle.high - candle.low;
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
                cancelPrice: zone.bottom // 🔥 ข้อ 4: ใช้ขอบล่างของโซน H1 เป็นจุด Stop Loss
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
                cancelPrice: zone.top // 🔥 ข้อ 4: ใช้ขอบบนของโซน H1 เป็นจุด Stop Loss
            };
        }
    }

    return { isValid: false };
}

function checkChoCh(m5Candles, direction) {
    // 🔥 แก้ตรงนี้: เปลี่ยนจาก < 4 เป็น < 6 เพื่อป้องกันการแครชเมื่อเรียก recent[5]
    if (m5Candles.length < 6) return false; 

    const recent = m5Candles.slice(-6); // 6 แท่งล่าสุด
    const priorCandles = recent.slice(0, 5); // 5 แท่งก่อน PA candle
    
    if (direction === 'BUY') {
        const prevHigh = Math.max(...priorCandles.map(c => c.high));
        return recent[5].close > prevHigh;
    }

    if (direction === 'SELL') {
        const prevLow = Math.min(...priorCandles.map(c => c.low));
        return recent[5].close < prevLow;
    }

    return false;
}

module.exports = { findFVG, findOrderBlock, checkPriceActionInZone, checkChoCh };