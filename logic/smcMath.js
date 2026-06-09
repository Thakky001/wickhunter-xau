function findFVG(candles, m5Candles = []) {
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

            // เช็กการทำลายโซนด้วยแท่ง M5 ล่าสุดที่เพิ่งเกิดขึ้น
            if (!isMitigated && m5Candles.length > 0) {
                for (let k = 0; k < m5Candles.length; k++) {
                    if (m5Candles[k].time >= c3.time && m5Candles[k].low <= c3.low) {
                        isMitigated = true;
                        break;
                    }
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

            // เช็กการทำลายโซนด้วยแท่ง M5 ล่าสุดที่เพิ่งเกิดขึ้น
            if (!isMitigated && m5Candles.length > 0) {
                for (let k = 0; k < m5Candles.length; k++) {
                    if (m5Candles[k].time >= c3.time && m5Candles[k].high >= c1.low) {
                        isMitigated = true;
                        break;
                    }
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

function findOrderBlock(candles, m5Candles = []) {
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

            // เช็กการทำลายโซนด้วยแท่ง M5 ล่าสุดที่เพิ่งเกิดขึ้น
            if (!isMitigated && m5Candles.length > 0) {
                for (let k = 0; k < m5Candles.length; k++) {
                    if (m5Candles[k].time >= curr.time && m5Candles[k].low <= prev.low) {
                        isMitigated = true;
                        break;
                    }
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

            // เช็กการทำลายโซนด้วยแท่ง M5 ล่าสุดที่เพิ่งเกิดขึ้น
            if (!isMitigated && m5Candles.length > 0) {
                for (let k = 0; k < m5Candles.length; k++) {
                    if (m5Candles[k].time >= curr.time && m5Candles[k].high >= prev.high) {
                        isMitigated = true;
                        break;
                    }
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

        // [Zone Depth Filter] PA ต้องแตะใน BOTTOM 30% ของโซนเท่านั้น
        // แรงซื้อจริงอยู่ที่ก้นโซน ไม่ใช่แค่เพิ่งเข้ามาในโซนด้านบน
        const zoneHeight = zone.top - zone.bottom;
        const bottomThreshold = zone.bottom + (zoneHeight * 0.3);
        const isInDepthZone = candle.low <= bottomThreshold;

        if (isTouchOrSweepZone && isCloseInsideOrAbove && isBullishPA && isInDepthZone) {
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

        // [Zone Depth Filter] PA ต้องแตะใน TOP 30% ของโซนเท่านั้น
        // แรงขายจริงอยู่ที่ยอดโซน ก้นโซนยังมีแรงดูดขึ้นไปเติม gap อีกมาก
        const zoneHeight = zone.top - zone.bottom;
        const topThreshold = zone.top - (zoneHeight * 0.3);
        const isInDepthZone = candle.high >= topThreshold;

        if (isTouchOrSweepZone && isCloseInsideOrBelow && isBearishPA && isInDepthZone) {
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

function checkChoCh(m5Candles, direction, paIndex = null) {
    if (m5Candles.length < 5) return { isValid: false };

    const paCandle = m5Candles[m5Candles.length - 1];

    // [Timing Fix] จำกัดการค้นหา fractal เฉพาะช่วงหลัง PA candle
    // ป้องกัน ChoCh ไปยืนยัน swing ที่ไม่เกี่ยวข้องกับ PA ปัจจุบัน
    // paIndex + 1 = candle ที่เก่าสุดที่ยังอยู่ใน "swing context" เดียวกับ PA
    const fractalFloor = paIndex !== null ? paIndex + 1 : 1;

    if (direction === 'BUY') {
        // หา Swing High (Fractal High) ล่าสุด → ใช้ Close ของแท่ง Fractal (Body-based BOS)
        let targetHigh = null;
        for (let i = m5Candles.length - 2; i >= fractalFloor; i--) {
            const c = m5Candles[i];
            if (c.high > m5Candles[i - 1].high &&
                c.high > m5Candles[i + 1].high) {
                targetHigh = Math.max(c.open, c.close); // ใช้ Close/Open (ขอบบนของ Body) แทน High (ปลายไส้)
                break;
            }
        }
        // Fallback: หากไม่พบ Fractal High → ใช้ body สูงสุดในช่วงหลัง PA
        if (targetHigh === null) {
            const startIdx = paIndex !== null ? paIndex + 1 : 0;
            const prevCandles = m5Candles.slice(startIdx, -1);
            if (prevCandles.length === 0) return { isValid: false };
            targetHigh = Math.max(...prevCandles.map(c => Math.max(c.open, c.close)));
        }

        const breakMargin = 1.5; // เพิ่มจาก 0.3 → 1.5 pts (Gold spread เฉลี่ย 0.3-0.5 pts → 0.3 คือ noise)
        const isValid = paCandle.close > (targetHigh + breakMargin);
        return { isValid, targetPrice: targetHigh, breakPrice: paCandle.close, margin: breakMargin };
    }

    if (direction === 'SELL') {
        // หา Swing Low (Fractal Low) ล่าสุด → ใช้ Close ของแท่ง Fractal (Body-based BOS)
        let targetLow = null;
        for (let i = m5Candles.length - 2; i >= fractalFloor; i--) {
            const c = m5Candles[i];
            if (c.low < m5Candles[i - 1].low &&
                c.low < m5Candles[i + 1].low) {
                targetLow = Math.min(c.open, c.close); // ใช้ Close/Open (ขอบล่างของ Body) แทน Low (ปลายไส้)
                break;
            }
        }
        // Fallback: หากไม่พบ Fractal Low → ใช้ body ต่ำสุดในช่วงหลัง PA
        if (targetLow === null) {
            const startIdx = paIndex !== null ? paIndex + 1 : 0;
            const prevCandles = m5Candles.slice(startIdx, -1);
            if (prevCandles.length === 0) return { isValid: false };
            targetLow = Math.min(...prevCandles.map(c => Math.min(c.open, c.close)));
        }

        const breakMargin = 1.5; // เพิ่มจาก 0.3 → 1.5 pts (Gold spread เฉลี่ย 0.3-0.5 pts → 0.3 คือ noise)
        const isValid = paCandle.close < (targetLow - breakMargin);
        return { isValid, targetPrice: targetLow, breakPrice: paCandle.close, margin: breakMargin };
    }

    return { isValid: false };
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
    const low1 = Math.min(...group1.map(c => c.low));
    const high2 = Math.max(...group2.map(c => c.high));
    const low2 = Math.min(...group2.map(c => c.low));
    const high3 = Math.max(...group3.map(c => c.high));
    const low3 = Math.min(...group3.map(c => c.low));

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

        for (let i = currentIndex; i >= Math.max(0, currentIndex - 10); i--) {
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

        for (let i = currentIndex; i >= Math.max(0, currentIndex - 10); i--) {
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

// ─── Recent Price Action Lookback ──────────────────────────────────────────────
function checkRecentPA(m5Candles, zone, lookback = 10) {
    // ลูปย้อนหลังจากแท่งล่าสุดลงไปในอดีต (ไม่เกิน lookback แท่ง)
    for (let i = m5Candles.length - 1; i >= Math.max(0, m5Candles.length - lookback); i--) {
        const paResult = checkPriceActionInZone(m5Candles[i], zone);
        if (paResult.isValid) {
            // คืน candleIndex ไปด้วยเพื่อให้ checkChoCh ใช้เป็น anchor
            // (ป้องกัน ChoCh ยืนยันด้วย candle จาก swing อื่นที่ไม่เกี่ยวกับ PA นี้)
            return { ...paResult, candleIndex: i };
        }
    }
    return { isValid: false };
}

module.exports = { findFVG, findOrderBlock, checkPriceActionInZone, checkRecentPA, checkChoCh, getHTFTrend, getTradingRange, checkIDMSweep };