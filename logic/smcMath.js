const MATH_CONFIG = {
    MIN_CANDLE_SIZE: 1.5,       // กรอง Micro-wicks ขนาดแท่ง M5 ต้องกว้างไม่ต่ำกว่า 1.5 USD (150 จุด)
    BOS_CONFIRM_WINDOW: 25      // [Fix#3] เพิ่มจาก 10 → 25 แท่ง H1 รองรับ inter-session gap สูงสุด ~20h บน Gold
};

function findFVG(candles, m5Candles = []) {
    let fvgs = [];
    const H1_MIN_ZONE_SIZE = 1.5;
    const H1_MIN_DISPLACEMENT = 3.0;

    for (let i = 2; i < candles.length; i++) {
        const c1 = candles[i - 2];
        const c2 = candles[i - 1];
        const c3 = candles[i];

        const c2Body = Math.abs(c2.open - c2.close);
        const hasDisplacement = c2Body >= H1_MIN_DISPLACEMENT;

        // Bullish FVG (Gap ขาขึ้น / โซน Buy)
        if (c3.low > c1.high && (c3.low - c1.high) >= H1_MIN_ZONE_SIZE && hasDisplacement && c2.close > c2.open) {
            // [CE Mitigation] โซนถูกใช้ไปแล้วถ้าราคา (Body) ปิดทะลุ 50% ของช่องว่าง
            let isMitigated = false;
            const midpoint = (c1.high + c3.low) / 2;
            for (let j = i + 1; j < candles.length; j++) {
                if (Math.min(candles[j].open, candles[j].close) <= midpoint) {
                    isMitigated = true;
                    break;
                }
            }

            // เช็กการทำลายโซนด้วยแท่ง M5 ล่าสุดที่เพิ่งเกิดขึ้น
            if (!isMitigated && m5Candles.length > 0) {
                for (let k = 0; k < m5Candles.length; k++) {
                    if (m5Candles[k].time >= c3.time && Math.min(m5Candles[k].open, m5Candles[k].close) <= midpoint) {
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
                    bottom: c1.high, // ขอบล่างของโซน
                    time: c1.time
                });
            }
        }
        // Bearish FVG (Gap ขาลง / โซน Sell)
        else if (c3.high < c1.low && (c1.low - c3.high) >= H1_MIN_ZONE_SIZE && hasDisplacement && c2.close < c2.open) {
            // [CE Mitigation] โซนถูกใช้ไปแล้วถ้าราคา (Body) ปิดทะลุ 50% ของช่องว่าง
            let isMitigated = false;
            const midpoint = (c1.low + c3.high) / 2;
            for (let j = i + 1; j < candles.length; j++) {
                if (Math.max(candles[j].open, candles[j].close) >= midpoint) {
                    isMitigated = true;
                    break;
                }
            }

            // เช็กการทำลายโซนด้วยแท่ง M5 ล่าสุดที่เพิ่งเกิดขึ้น
            if (!isMitigated && m5Candles.length > 0) {
                for (let k = 0; k < m5Candles.length; k++) {
                    if (m5Candles[k].time >= c3.time && Math.max(m5Candles[k].open, m5Candles[k].close) >= midpoint) {
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
                    bottom: c3.high,
                    time: c1.time
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

        // Bullish OB (โซน Buy): แท่งแดงสุดท้าย ก่อนแท่งเขียว (Impulse)
        if (isPrevBearish && isCurrBullish) {
            // [BOS Check] หา 3-point Fractal High ก่อนหน้า OB
            let fractalHigh = null;
            for (let b = i - 2; b >= Math.max(1, i - 25); b--) {
                if (candles[b].high > candles[b - 1].high && candles[b].high > candles[b + 1].high) {
                    fractalHigh = candles[b].high;
                    break;
                }
            }

            if (fractalHigh === null) continue;

            // เช็คว่ามีแท่งไหนหลังจาก OB ที่ปิดสูงกว่า fractalHigh ไหม
            // [Fix#3] ขยาย window เป็น BOS_CONFIRM_WINDOW (25 H1) รองรับ inter-session gap บน Gold
            let hasBOS = false;
            for (let k = i; k < Math.min(candles.length, i + MATH_CONFIG.BOS_CONFIRM_WINDOW); k++) {
                if (candles[k].close > fractalHigh) {
                    hasBOS = true;
                    break;
                }
            }

            if (hasBOS) {
                // [Body-based Mitigation] โซนตายเมื่อแท่งเทียน "ปิดทะลุ (Body Close)" ขอบล่าง
                let isMitigated = false;
                for (let j = i + 1; j < candles.length; j++) {
                    if (Math.min(candles[j].open, candles[j].close) < prev.low) {
                        isMitigated = true;
                        break;
                    }
                }

                // เช็กการทำลายโซนด้วยแท่ง M5 ล่าสุดที่เพิ่งเกิดขึ้น
                if (!isMitigated && m5Candles.length > 0) {
                    for (let k = 0; k < m5Candles.length; k++) {
                        if (m5Candles[k].time > curr.time && Math.min(m5Candles[k].open, m5Candles[k].close) < prev.low) {
                            isMitigated = true;
                            break;
                        }
                    }
                }

                if (!isMitigated) {
                    orderBlocks.push({
                        type: 'BUY_ZONE',
                        name: 'BULLISH_OB',
                        top: Math.max(prev.open, prev.close),
                        bottom: Math.min(prev.open, prev.close),
                        time: prev.time
                    });
                }
            }
        }

        // Bearish OB (โซน Sell): แท่งเขียวสุดท้าย ก่อนแท่งแดง (Impulse)
        else if (isPrevBullish && isCurrBearish) {
            // [BOS Check] หา 3-point Fractal Low ก่อนหน้า OB
            let fractalLow = null;
            for (let b = i - 2; b >= Math.max(1, i - 25); b--) {
                if (candles[b].low < candles[b - 1].low && candles[b].low < candles[b + 1].low) {
                    fractalLow = candles[b].low;
                    break;
                }
            }

            if (fractalLow === null) continue;

            // เช็คว่ามีแท่งไหนหลังจาก OB ที่ปิดต่ำกว่า fractalLow ไหม
            // [Fix#3] ขยาย window เป็น BOS_CONFIRM_WINDOW (25 H1) รองรับ inter-session gap บน Gold
            let hasBOS = false;
            for (let k = i; k < Math.min(candles.length, i + MATH_CONFIG.BOS_CONFIRM_WINDOW); k++) {
                if (candles[k].close < fractalLow) {
                    hasBOS = true;
                    break;
                }
            }

            if (hasBOS) {
                // [Body-based Mitigation] โซนตายเมื่อแท่งเทียน "ปิดทะลุ (Body Close)" ขอบบน
                let isMitigated = false;
                for (let j = i + 1; j < candles.length; j++) {
                    if (Math.max(candles[j].open, candles[j].close) > prev.high) {
                        isMitigated = true;
                        break;
                    }
                }

                // เช็กการทำลายโซนด้วยแท่ง M5 ล่าสุดที่เพิ่งเกิดขึ้น
                if (!isMitigated && m5Candles.length > 0) {
                    for (let k = 0; k < m5Candles.length; k++) {
                        if (m5Candles[k].time > curr.time && Math.max(m5Candles[k].open, m5Candles[k].close) > prev.high) {
                            isMitigated = true;
                            break;
                        }
                    }
                }

                if (!isMitigated) {
                    orderBlocks.push({
                        type: 'SELL_ZONE',
                        name: 'BEARISH_OB',
                        top: Math.max(prev.open, prev.close),
                        bottom: Math.min(prev.open, prev.close),
                        time: prev.time
                    });
                }
            }
        }
    }
    return orderBlocks;
}



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

    if (direction === 'BUY') {
        let targetHigh = null;
        if (paIndex !== null && paIndex > 1) {
            // [SMC True ChoCh] หา Fractal High สุดท้าย "ก่อน" เกิด PA
            for (let i = paIndex - 1; i >= 1; i--) {
                const c = m5Candles[i];
                if (c.high > m5Candles[i - 1].high && c.high > m5Candles[i + 1].high) {
                    targetHigh = c.high; // ใช้ Wick High
                    break;
                }
            }
        }

        // Fallback: ถ้าหา Fractal ไม่เจอ ให้เอาราคาไส้เทียนสูงสุดในช่วง 20 แท่งก่อน PA
        if (targetHigh === null) {
            const searchEnd = paIndex !== null ? paIndex : m5Candles.length - 1;
            const searchStart = Math.max(0, searchEnd - 20);
            const prevCandles = m5Candles.slice(searchStart, searchEnd);
            if (prevCandles.length === 0) return { isValid: false };
            targetHigh = Math.max(...prevCandles.map(c => c.high));
        }

        const breakMargin = 1.5; // เพิ่มจาก 0.3 → 1.5 pts (Gold spread เฉลี่ย 0.3-0.5 pts → 0.3 คือ noise)

        // [Fresh Break Fix] ค้นหาการเบรคในช่วง Valid Window (10 แท่งหลังเกิด PA)
        let isFreshBreak = false;
        let breakPrice = null;
        const startIndex = paIndex !== null ? paIndex : m5Candles.length - 2;

        for (let i = startIndex + 1; i < Math.min(m5Candles.length, startIndex + 10); i++) {
            if (m5Candles[i - 1].close <= (targetHigh + breakMargin) && m5Candles[i].close > (targetHigh + breakMargin)) {
                isFreshBreak = true;
                breakPrice = m5Candles[i].close;
                break;
            }
        }

        if (!isFreshBreak) return { isValid: false, targetPrice: targetHigh, margin: breakMargin };

        return { isValid: true, targetPrice: targetHigh, breakPrice: breakPrice, margin: breakMargin };
    }

    if (direction === 'SELL') {
        let targetLow = null;
        if (paIndex !== null && paIndex > 1) {
            // [SMC True ChoCh] หา Fractal Low สุดท้าย "ก่อน" เกิด PA
            for (let i = paIndex - 1; i >= 1; i--) {
                const c = m5Candles[i];
                if (c.low < m5Candles[i - 1].low && c.low < m5Candles[i + 1].low) {
                    targetLow = c.low; // ใช้ Wick Low
                    break;
                }
            }
        }

        // Fallback: ถ้าหา Fractal ไม่เจอ ให้เอาราคาไส้เทียนต่ำสุดในช่วง 20 แท่งก่อน PA
        if (targetLow === null) {
            const searchEnd = paIndex !== null ? paIndex : m5Candles.length - 1;
            const searchStart = Math.max(0, searchEnd - 20);
            const prevCandles = m5Candles.slice(searchStart, searchEnd);
            if (prevCandles.length === 0) return { isValid: false };
            targetLow = Math.min(...prevCandles.map(c => c.low));
        }

        const breakMargin = 1.5; // เพิ่มจาก 0.3 → 1.5 pts (Gold spread เฉลี่ย 0.3-0.5 pts → 0.3 คือ noise)

        // [Fresh Break Fix] ค้นหาการเบรคในช่วง Valid Window (10 แท่งหลังเกิด PA)
        let isFreshBreak = false;
        let breakPrice = null;
        const startIndex = paIndex !== null ? paIndex : m5Candles.length - 2;

        for (let i = startIndex + 1; i < Math.min(m5Candles.length, startIndex + 10); i++) {
            if (m5Candles[i - 1].close >= (targetLow - breakMargin) && m5Candles[i].close < (targetLow - breakMargin)) {
                isFreshBreak = true;
                breakPrice = m5Candles[i].close;
                break;
            }
        }

        if (!isFreshBreak) return { isValid: false, targetPrice: targetLow, margin: breakMargin };

        return { isValid: true, targetPrice: targetLow, breakPrice: breakPrice, margin: breakMargin };
    }

    return { isValid: false };
}

// ─── HTF Trend Filter ─────────────────────────────────────────────────────────
// วิเคราะห์แนวโน้ม H4 จากข้อมูล H1 ที่มีอยู่แล้ว (ไม่ใช้ API เพิ่มแม้แต่ครั้งเดียว)
// เปรียบเทียบโครงสร้าง HH/HL (Bullish) กับ LH/LL (Bearish) ใน 3 กลุ่ม H4
function getHTFTrend(h1Candles) {
    // ต้องการ 20 แท่ง H1 ขึ้นไป (≈ 5 แท่ง H4) เพื่อประเมินแนวโน้ม
    if (h1Candles.length < 20) return 'NEUTRAL';

    const last20 = h1Candles.slice(-20);

    // จำลองแท่ง H4 จาก H1 (กลุ่มละ 4 แท่ง)
    const groups = [];
    for (let i = 0; i < 5; i++) {
        groups.push(last20.slice(i * 4, (i + 1) * 4));
    }

    const highs = groups.map(g => Math.max(...g.map(c => c.high)));
    const lows = groups.map(g => Math.min(...g.map(c => c.low)));

    // Bullish: High ล่าสุดสูงกว่ากลุ่มก่อนหน้า และ Low ยกสูงขึ้น
    const isBullish = highs[4] > highs[3] && highs[3] > highs[2] && lows[4] > lows[3];
    // Bearish: High ล่าสุดต่ำกว่ากลุ่มก่อนหน้า และ Low ทำนิวโลว์
    const isBearish = lows[4] < lows[3] && lows[3] < lows[2] && highs[4] < highs[3];

    if (isBullish) return 'BULLISH';
    if (isBearish) return 'BEARISH';
    return 'NEUTRAL';
}

// ─── H1 Premium / Discount Zone Finder ─────────────────────────────────────────
function getTradingRange(h1Candles, lookback = 24) {
    if (h1Candles.length === 0) return null;
    const rangeCandles = h1Candles.slice(-Math.min(lookback, h1Candles.length));
    const bodyHighs = rangeCandles.map(c => Math.max(c.open, c.close));
    const bodyLows = rangeCandles.map(c => Math.min(c.open, c.close));
    const swingHigh = Math.max(...bodyHighs);
    const swingLow = Math.min(...bodyLows);

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
function checkIDMSweep(m5Candles, direction, paIndex = null) {
    if (m5Candles.length < 15) return false;

    // [IDM Sync Fix] ถ้ามี paIndex ให้ใช้แท่ง PA เป็นจุดอ้างอิง
    // มองหา Sweep เฉพาะช่วงก่อนหรือที่ตำแหน่ง PA เท่านั้น
    // ป้องกันบอทไปยึด Noise จากแท่งล่าสุดที่ไม่เกี่ยวกับ Setup ปัจจุบัน
    const currentIndex = paIndex !== null ? paIndex : m5Candles.length - 1;

    if (direction === 'BUY') {
        let currentSwingLow = m5Candles[currentIndex].low;
        let currentSwingIndex = currentIndex;

        for (let i = currentIndex; i >= Math.max(0, currentIndex - 10); i--) {
            if (m5Candles[i].low < currentSwingLow) {
                currentSwingLow = m5Candles[i].low;
                currentSwingIndex = i;
            }
        }

        let idmLow = null;
        for (let i = currentSwingIndex - 1; i >= Math.max(1, currentSwingIndex - 30); i--) {
            const c = m5Candles[i];
            if (c.low < m5Candles[i - 1].low && c.low < m5Candles[i + 1].low) {
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
            if (m5Candles[i].high > currentSwingHigh) {
                currentSwingHigh = m5Candles[i].high;
                currentSwingIndex = i;
            }
        }

        let idmHigh = null;
        for (let i = currentSwingIndex - 1; i >= Math.max(1, currentSwingIndex - 30); i--) {
            const c = m5Candles[i];
            if (c.high > m5Candles[i - 1].high && c.high > m5Candles[i + 1].high) {
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