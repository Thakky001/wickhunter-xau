function findFVG(candles) {
    let fvgs = [];
    for (let i = 2; i < candles.length; i++) {
        const c1 = candles[i - 2]; 
        const c3 = candles[i];     

        // Bullish FVG (Gap ขาขึ้น / โซน Buy)
        if (c3.low > c1.high) {
            // [Strict Mitigation] โซนถูกใช้ไปแล้วถ้าราคากลับลงมาแตะ (low <= top)
            let isMitigated = false;
            for (let j = i + 1; j < candles.length; j++) {
                if (candles[j].low <= c3.low) {
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
            // [Strict Mitigation] โซนถูกใช้ไปแล้วถ้าราคากลับขึ้นมาแตะ top (c1.low)
            let isMitigated = false;
            for (let j = i + 1; j < candles.length; j++) {
                if (candles[j].high >= c1.low) {
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
            // [Strict Mitigation] โซนถูกใช้ไปแล้วถ้าราคาทะลุลงต่ำกว่า bottom (prev.low)
            let isMitigated = false;
            for (let j = i + 1; j < candles.length; j++) {
                if (candles[j].low <= prev.low) {
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
            // [Strict Mitigation] โซนถูกใช้ไปแล้วถ้าราคากลับขึ้นมาทะลุ top (prev.high)
            let isMitigated = false;
            for (let j = i + 1; j < candles.length; j++) {
                if (candles[j].high >= prev.high) {
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
    MIN_CANDLE_SIZE: 1.5 // กรอง Micro-wicks ขนาดแท่ง M5 ต้องกว้างไม่ต่ำกว่า 1.5 USD (150 จุด)
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
    if (m5Candles.length < 5) return false;

    const paCandle = m5Candles[m5Candles.length - 1];

    if (direction === 'BUY') {
        // หา Swing High (Fractal High) ล่าสุด → ใช้ Close ของแท่ง Fractal (Body-based BOS)
        let targetHigh = null;
        for (let i = m5Candles.length - 3; i >= 2; i--) {
            const c = m5Candles[i];
            if (c.high > m5Candles[i - 1].high && c.high > m5Candles[i - 2].high &&
                c.high > m5Candles[i + 1].high && c.high > m5Candles[i + 2].high) {
                targetHigh = Math.max(c.open, c.close); // ใช้ Close/Open (ขอบบนของ Body) แทน High (ปลายไส้)
                break;
            }
        }
        // Fallback: หากไม่พบ Fractal High → ใช้ค่า Close สูงสุดย้อนหลัง 10 แท่ง
        if (targetHigh === null) {
            const prevCandles = m5Candles.slice(-Math.min(11, m5Candles.length), -1);
            targetHigh = Math.max(...prevCandles.map(c => Math.max(c.open, c.close)));
        }
        
        return paCandle.close > targetHigh;
    }

    if (direction === 'SELL') {
        // หา Swing Low (Fractal Low) ล่าสุด → ใช้ Close ของแท่ง Fractal (Body-based BOS)
        let targetLow = null;
        for (let i = m5Candles.length - 3; i >= 2; i--) {
            const c = m5Candles[i];
            if (c.low < m5Candles[i - 1].low && c.low < m5Candles[i - 2].low &&
                c.low < m5Candles[i + 1].low && c.low < m5Candles[i + 2].low) {
                targetLow = Math.min(c.open, c.close); // ใช้ Close/Open (ขอบล่างของ Body) แทน Low (ปลายไส้)
                break;
            }
        }
        // Fallback: หากไม่พบ Fractal Low → ใช้ค่า Close ต่ำสุดย้อนหลัง 10 แท่ง
        if (targetLow === null) {
            const prevCandles = m5Candles.slice(-Math.min(11, m5Candles.length), -1);
            targetLow = Math.min(...prevCandles.map(c => Math.min(c.open, c.close)));
        }

        return paCandle.close < targetLow;
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

// ─── H1 Premium / Discount Zone Finder ─────────────────────────────────────────
function getTradingRange(h1Candles, lookback = 24) {
    if (h1Candles.length === 0) return null;
    const rangeCandles = h1Candles.slice(-Math.min(lookback, h1Candles.length));
    const highs = rangeCandles.map(c => c.high);
    const lows = rangeCandles.map(c => c.low);
    const swingHigh = Math.max(...highs);
    const swingLow = Math.min(...lows);
    
    // คำนวณหาค่ามัธยฐาน (Median) ของราคาปิด เพื่อป้องกันสัญญาณหลอกจากการสะบัดของราคา (Spike)
    const closes = rangeCandles.map(c => c.close).sort((a, b) => a - b);
    const midpoint = closes[Math.floor(closes.length / 2)];
    
    return {
        high: swingHigh,
        low: swingLow,
        midpoint: midpoint
    };
}

// ─── IDM (Inducement / Liquidity Sweep) ────────────────────────────────────────
function checkIDMSweep(m5Candles, direction) {
    if (m5Candles.length < 15) return false;

    const currentIndex = m5Candles.length - 1;

    if (direction === 'BUY') {
        let currentSwingLow = m5Candles[currentIndex].low;
        let currentSwingIndex = currentIndex;
        
        for (let i = currentIndex; i >= Math.max(0, currentIndex - 3); i--) {
            if (m5Candles[i].low <= currentSwingLow) {
                currentSwingLow = m5Candles[i].low;
                currentSwingIndex = i;
            }
        }

        let idmLow = null;
        for (let i = currentSwingIndex - 2; i >= Math.max(2, currentSwingIndex - 30); i--) {
            const c = m5Candles[i];
            if (c.low < m5Candles[i - 1].low && c.low < m5Candles[i - 2].low &&
                c.low < m5Candles[i + 1].low && c.low < m5Candles[i + 2].low) {
                idmLow = c.low;
                break;
            }
        }

        if (idmLow !== null && currentSwingLow < idmLow) {
            return true;
        }
        return false;
    }

    if (direction === 'SELL') {
        let currentSwingHigh = m5Candles[currentIndex].high;
        let currentSwingIndex = currentIndex;
        
        for (let i = currentIndex; i >= Math.max(0, currentIndex - 3); i--) {
            if (m5Candles[i].high >= currentSwingHigh) {
                currentSwingHigh = m5Candles[i].high;
                currentSwingIndex = i;
            }
        }

        let idmHigh = null;
        for (let i = currentSwingIndex - 2; i >= Math.max(2, currentSwingIndex - 30); i--) {
            const c = m5Candles[i];
            if (c.high > m5Candles[i - 1].high && c.high > m5Candles[i - 2].high &&
                c.high > m5Candles[i + 1].high && c.high > m5Candles[i + 2].high) {
                idmHigh = c.high;
                break;
            }
        }

        if (idmHigh !== null && currentSwingHigh > idmHigh) {
            return true;
        }
        return false;
    }

    return false;
}

module.exports = { findFVG, findOrderBlock, checkPriceActionInZone, checkChoCh, getHTFTrend, getTradingRange, checkIDMSweep };