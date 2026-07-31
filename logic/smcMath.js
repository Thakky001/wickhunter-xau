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
            // [Full Fill Mitigation] โซนถูกใช้ไปแล้วถ้าราคา (Body) ปิดหลุดขอบล่างของ FVG (100%)
            let isMitigated = false;
            const bottomEdge = c1.high;
            for (let j = i + 1; j < candles.length; j++) {
                if (Math.min(candles[j].open, candles[j].close) <= bottomEdge) {
                    isMitigated = true;
                    break;
                }
            }

            // เช็กการทำลายโซนด้วยแท่ง M5 ล่าสุดที่เพิ่งเกิดขึ้น
            if (!isMitigated && m5Candles.length > 0) {
                for (let k = 0; k < m5Candles.length; k++) {
                    if (m5Candles[k].time >= c3.time && Math.min(m5Candles[k].open, m5Candles[k].close) <= bottomEdge) {
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
                    time: c1.time,
                    candleIndex: i
                });
            }
        }
        // Bearish FVG (Gap ขาลง / โซน Sell)
        else if (c3.high < c1.low && (c1.low - c3.high) >= H1_MIN_ZONE_SIZE && hasDisplacement && c2.close < c2.open) {
            // [Full Fill Mitigation] โซนถูกใช้ไปแล้วถ้าราคา (Body) ปิดทะลุขอบบนของ FVG (100%)
            let isMitigated = false;
            const topEdge = c1.low;
            for (let j = i + 1; j < candles.length; j++) {
                if (Math.max(candles[j].open, candles[j].close) >= topEdge) {
                    isMitigated = true;
                    break;
                }
            }

            // เช็กการทำลายโซนด้วยแท่ง M5 ล่าสุดที่เพิ่งเกิดขึ้น
            if (!isMitigated && m5Candles.length > 0) {
                for (let k = 0; k < m5Candles.length; k++) {
                    if (m5Candles[k].time >= c3.time && Math.max(m5Candles[k].open, m5Candles[k].close) >= topEdge) {
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
                    time: c1.time,
                    candleIndex: i
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
                const obBottom = Math.min(prev.open, prev.close);
                for (let j = i + 1; j < candles.length; j++) {
                    if (Math.min(candles[j].open, candles[j].close) < obBottom) {
                        isMitigated = true;
                        break;
                    }
                }

                // เช็กการทำลายโซนด้วยแท่ง M5 ล่าสุดที่เพิ่งเกิดขึ้น
                if (!isMitigated && m5Candles.length > 0) {
                    for (let k = 0; k < m5Candles.length; k++) {
                        if (m5Candles[k].time > curr.time && Math.min(m5Candles[k].open, m5Candles[k].close) < obBottom) {
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
                        time: prev.time,
                        candleIndex: i - 1
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
                const obTop = Math.max(prev.open, prev.close);
                for (let j = i + 1; j < candles.length; j++) {
                    if (Math.max(candles[j].open, candles[j].close) > obTop) {
                        isMitigated = true;
                        break;
                    }
                }

                // เช็กการทำลายโซนด้วยแท่ง M5 ล่าสุดที่เพิ่งเกิดขึ้น
                if (!isMitigated && m5Candles.length > 0) {
                    for (let k = 0; k < m5Candles.length; k++) {
                        if (m5Candles[k].time > curr.time && Math.max(m5Candles[k].open, m5Candles[k].close) > obTop) {
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
                        time: prev.time,
                        candleIndex: i - 1
                    });
                }
            }
        }
    }
    return orderBlocks;
}



function checkPriceActionInZone(candle, zone, depthPct = 0.3) {
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
        const bottomThreshold = zone.bottom + (zoneHeight * depthPct);
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
        const topThreshold = zone.top - (zoneHeight * depthPct);
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
            // จำกัด window 15 แท่ง M5 (= 75 นาที) — ถ้าไกลกว่านี้ = คนละ swing แล้ว
            const FRACTAL_WINDOW = 15;
            for (let i = paIndex - 1; i >= Math.max(1, paIndex - FRACTAL_WINDOW); i--) {
                const c = m5Candles[i];
                if (c.high > m5Candles[i - 1].high && c.high > m5Candles[i + 1].high) {
                    targetHigh = c.high; // ใช้ Wick High
                    break;
                }
            }
        }

        // ❌ ไม่มี fallback → ถ้าหา Fractal ไม่เจอ = ไม่มีโครงสร้างให้เล่น → skip setup นี้
        if (targetHigh === null) return { isValid: false };

        const breakMargin = 1.5; // เพิ่มจาก 0.3 → 1.5 pts (Gold spread เฉลี่ย 0.3-0.5 pts → 0.3 คือ noise)

        // [Fresh Break Fix] ค้นหาการเบรคในช่วง Valid Window (10 แท่งหลังเกิด PA)
        let isFreshBreak = false;
        let breakPrice = null;
        let breakIndex = null;
        const startIndex = paIndex !== null ? paIndex : m5Candles.length - 2;

        for (let i = startIndex + 1; i < m5Candles.length; i++) {
            if (m5Candles[i - 1].close <= (targetHigh + breakMargin) && m5Candles[i].close > (targetHigh + breakMargin)) {
                isFreshBreak = true;
                breakPrice = m5Candles[i].close;
                breakIndex = i;
                break;
            }
        }

        if (!isFreshBreak) return { isValid: false, targetPrice: targetHigh, margin: breakMargin };

        return { isValid: true, targetPrice: targetHigh, breakPrice: breakPrice, margin: breakMargin, breakIndex: breakIndex };
    }

    if (direction === 'SELL') {
        let targetLow = null;
        if (paIndex !== null && paIndex > 1) {
            // [SMC True ChoCh] หา Fractal Low สุดท้าย "ก่อน" เกิด PA
            // จำกัด window 15 แท่ง M5 (= 75 นาที) — ถ้าไกลกว่านี้ = คนละ swing แล้ว
            const FRACTAL_WINDOW = 15;
            for (let i = paIndex - 1; i >= Math.max(1, paIndex - FRACTAL_WINDOW); i--) {
                const c = m5Candles[i];
                if (c.low < m5Candles[i - 1].low && c.low < m5Candles[i + 1].low) {
                    targetLow = c.low; // ใช้ Wick Low
                    break;
                }
            }
        }

        // ❌ ไม่มี fallback → ถ้าหา Fractal ไม่เจอ = ไม่มีโครงสร้างให้เล่น → skip setup นี้
        if (targetLow === null) return { isValid: false };

        const breakMargin = 1.5; // เพิ่มจาก 0.3 → 1.5 pts (Gold spread เฉลี่ย 0.3-0.5 pts → 0.3 คือ noise)

        // [Fresh Break Fix] ค้นหาการเบรคในช่วง Valid Window (10 แท่งหลังเกิด PA)
        let isFreshBreak = false;
        let breakPrice = null;
        let breakIndex = null;
        const startIndex = paIndex !== null ? paIndex : m5Candles.length - 2;

        for (let i = startIndex + 1; i < m5Candles.length; i++) {
            if (m5Candles[i - 1].close >= (targetLow - breakMargin) && m5Candles[i].close < (targetLow - breakMargin)) {
                isFreshBreak = true;
                breakPrice = m5Candles[i].close;
                breakIndex = i;
                break;
            }
        }

        if (!isFreshBreak) return { isValid: false, targetPrice: targetLow, margin: breakMargin };

        return { isValid: true, targetPrice: targetLow, breakPrice: breakPrice, margin: breakMargin, breakIndex: breakIndex };
    }

    return { isValid: false };
}

// ─── HTF Trend Filter ─────────────────────────────────────────────────────────
// วิเคราะห์แนวโน้ม H4 จากข้อมูล H4 Candles ที่จัดกลุ่มแล้ว
// เปรียบเทียบโครงสร้าง HH/HL (Bullish) กับ LH/LL (Bearish) จาก 5 แท่ง H4 ล่าสุด
function getHTFTrend(h4Candles) {
    // ต้องการ 5 แท่ง H4 ขึ้นไป เพื่อประเมินแนวโน้ม
    if (!h4Candles || h4Candles.length < 5) return 'NEUTRAL';

    const last5 = h4Candles.slice(-5);

    const highs = last5.map(c => c.high);
    const lows = last5.map(c => c.low);

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
function checkRecentPA(m5Candles, zone, lookback = 10, depthPct = 0.3) {
    // ลูปย้อนหลังจากแท่งล่าสุดลงไปในอดีต (ไม่เกิน lookback แท่ง)
    for (let i = m5Candles.length - 1; i >= Math.max(0, m5Candles.length - lookback); i--) {
        const paResult = checkPriceActionInZone(m5Candles[i], zone, depthPct);
        if (paResult.isValid) {
            // คืน candleIndex ไปด้วยเพื่อให้ checkChoCh ใช้เป็น anchor
            // (ป้องกัน ChoCh ยืนยันด้วย candle จาก swing อื่นที่ไม่เกี่ยวกับ PA นี้)
            return { ...paResult, candleIndex: i };
        }
    }
    return { isValid: false };
}

// ─── M1 ChoCh Break Confirmation ──────────────────────────────────────────────
// ยืนยัน ChoCh break จากราคาปิดแท่ง M1 (Deriv real-time)
// แยกจาก checkChoCh เพราะใช้ TF ต่างกัน: Target จาก M5 Fractal, Break จาก M1 Close
function checkM1ChochBreak(m1Close, direction, targetPrice, margin = 2.0) {
    if (direction === 'BUY') {
        return m1Close > (targetPrice + margin);
    }
    if (direction === 'SELL') {
        return m1Close < (targetPrice - margin);
    }
    return false;
}

// ─── M5 BOS Detection (Continuation Setup) ───────────────────────────────────
// ตรวจหา Break of Structure (BOS) บน M5 ตาม trend — ใช้สำหรับ Continuation Setup
// ต่างจาก ChoCh: BOS = ทะลุ swing ตาม trend (ไม่ใช่สวนทาง)
function checkM5BOS(m5Candles, direction, lookback = 20) {
    if (m5Candles.length < 10) return { isValid: false };

    const BOS_MARGIN = 0.3; // margin ป้องกัน noise (0.3 USD = 30 จุด)

    if (direction === 'BUY') {
        let fractalHigh = null;
        let fractalIndex = null;
        const searchStart = Math.max(1, m5Candles.length - lookback);
        for (let i = m5Candles.length - 3; i >= searchStart; i--) {
            const c = m5Candles[i];
            if (c.high > m5Candles[i - 1].high && c.high > m5Candles[i + 1].high) {
                fractalHigh = c.high;
                fractalIndex = i;
                break;
            }
        }
        if (fractalHigh === null) return { isValid: false };

        // หาแท่งที่ปิดเหนือ fractalHigh (BOS) — ต้องสด (ไม่เกิน 5 แท่งจากล่าสุด)
        for (let i = fractalIndex + 2; i < m5Candles.length; i++) {
            if (m5Candles[i].close > (fractalHigh + BOS_MARGIN)) {
                if (i >= m5Candles.length - 5) {
                    return { isValid: true, bosIndex: i, fractalIndex, fractalPrice: fractalHigh, breakPrice: m5Candles[i].close, direction: 'BUY' };
                }
                return { isValid: false }; // BOS เกิดนานแล้ว (stale)
            }
        }
        return { isValid: false };
    }

    if (direction === 'SELL') {
        let fractalLow = null;
        let fractalIndex = null;
        const searchStart = Math.max(1, m5Candles.length - lookback);
        for (let i = m5Candles.length - 3; i >= searchStart; i--) {
            const c = m5Candles[i];
            if (c.low < m5Candles[i - 1].low && c.low < m5Candles[i + 1].low) {
                fractalLow = c.low;
                fractalIndex = i;
                break;
            }
        }
        if (fractalLow === null) return { isValid: false };

        for (let i = fractalIndex + 2; i < m5Candles.length; i++) {
            if (m5Candles[i].close < (fractalLow - BOS_MARGIN)) {
                if (i >= m5Candles.length - 5) {
                    return { isValid: true, bosIndex: i, fractalIndex, fractalPrice: fractalLow, breakPrice: m5Candles[i].close, direction: 'SELL' };
                }
                return { isValid: false };
            }
        }
        return { isValid: false };
    }

    return { isValid: false };
}

// ─── M5 FVG Finder (ระหว่าง BOS Impulse Move) ─────────────────────────────────
// หา FVG ที่เกิดขึ้นระหว่าง BOS impulse (scanStart → scanEnd)
// ต่างจาก findFVG (H1): ไม่บังคับ displacement, ขนาดเล็กกว่า (0.8 USD)
const MIN_M5_FVG_SIZE = 0.8; // 0.8 USD = 80 จุด

function findM5FVG(m5Candles, scanStart, scanEnd, direction) {
    const fvgs = [];
    const start = Math.max(2, scanStart);
    const end = Math.min(scanEnd, m5Candles.length - 1);

    for (let i = start; i <= end; i++) {
        const c1 = m5Candles[i - 2];
        const c3 = m5Candles[i];

        if (direction === 'BUY') {
            // Bullish FVG: gap ระหว่าง c1.high กับ c3.low (gap ขาขึ้น)
            if (c3.low > c1.high && (c3.low - c1.high) >= MIN_M5_FVG_SIZE) {
                const midpoint = (c1.high + c3.low) / 2;
                let mitigated = false;
                for (let j = i + 1; j < m5Candles.length; j++) {
                    if (Math.min(m5Candles[j].open, m5Candles[j].close) <= midpoint) { mitigated = true; break; }
                }
                if (!mitigated) fvgs.push({ top: c3.low, bottom: c1.high, index: i, midpoint });
            }
        } else {
            // Bearish FVG: gap ระหว่าง c1.low กับ c3.high (gap ขาลง)
            if (c3.high < c1.low && (c1.low - c3.high) >= MIN_M5_FVG_SIZE) {
                const midpoint = (c1.low + c3.high) / 2;
                let mitigated = false;
                for (let j = i + 1; j < m5Candles.length; j++) {
                    if (Math.max(m5Candles[j].open, m5Candles[j].close) >= midpoint) { mitigated = true; break; }
                }
                if (!mitigated) fvgs.push({ top: c1.low, bottom: c3.high, index: i, midpoint });
            }
        }
    }

    if (fvgs.length === 0) return { isValid: false };

    // เลือก FVG ที่ใกล้ราคาปัจจุบันที่สุด (มีโอกาส retest สูงสุด)
    const lastPrice = m5Candles[m5Candles.length - 1].close;
    fvgs.sort((a, b) => Math.abs(lastPrice - a.midpoint) - Math.abs(lastPrice - b.midpoint));
    return { isValid: true, fvg: fvgs[0] };
}

/**
 * Calculates Average True Range (ATR)
 * @param {Array} candles Array of candles {high, low, close}
 * @param {number} period Lookback period
 * @returns {Object} { atr, trValues }
 */
function calculateATR(candles, period = 14) {
    if (!candles || candles.length < period + 1) return { atr: null, trValues: [] };

    // [Fix] คำนวณเฉพาะ period+1 แท่งสุดท้าย เพื่อประหยัด RAM ไม่สะสม trValues ทั้งหมด
    const startIdx = Math.max(1, candles.length - period);
    const trValues = [];
    for (let i = startIdx; i < candles.length; i++) {
        const c = candles[i];
        const pc = candles[i - 1];
        
        const hl = c.high - c.low;
        const hpc = Math.abs(c.high - pc.close);
        const lpc = Math.abs(c.low - pc.close);
        
        const tr = Math.max(hl, hpc, lpc);
        trValues.push(tr);
    }

    if (trValues.length < period) return { atr: null, trValues };

    const sumTr = trValues.reduce((sum, tr) => sum + tr, 0);
    const atr = sumTr / period;

    return { atr, trValues };
}

/**
 * Calculates Dynamic Spread and SL Buffers based on ATR
 * @param {Array} m5Candles M5 candles array
 * @param {Object} config ENGINE_CONFIG subset
 * @returns {Object} dynamic buffers and stats
 */
function calculateDynamicBuffers(m5Candles, config) {
    if (!config.USE_ATR_BUFFER) {
        return {
            dynamicSpreadBuffer: config.SPREAD_BUFFER,
            dynamicSLBuffer: config.SL_BUFFER,
            atr14: null,
            atrBaseline: null,
            volatilityRatio: 1.0
        };
    }

    const { atr: atr14 } = calculateATR(m5Candles, config.ATR_PERIOD || 14);
    const { atr: atrBaseline } = calculateATR(m5Candles, config.ATR_BASELINE_PERIOD || 50);

    if (atr14 === null || atrBaseline === null) {
         return {
            dynamicSpreadBuffer: config.SPREAD_BUFFER,
            dynamicSLBuffer: config.SL_BUFFER,
            atr14: null,
            atrBaseline: null,
            volatilityRatio: 1.0
        };
    }

    // Volatility Ratio tells us if the market is currently more/less volatile than baseline
    let volatilityRatio = atr14 / (atrBaseline || 1); 
    // Clamp extreme ratios to avoid wild buffers
    volatilityRatio = Math.max(0.5, Math.min(volatilityRatio, 3.0));

    // Calculate Spread Buffer (approx 25% of ATR)
    let dynamicSpreadBuffer = atr14 * (config.SPREAD_ATR_MULT || 0.25);
    dynamicSpreadBuffer = Math.max(config.MIN_SPREAD_BUFFER || 0.3, Math.min(dynamicSpreadBuffer, config.MAX_SPREAD_BUFFER || 3.0));

    // Calculate SL Buffer (scale base by volatility)
    let dynamicSLBuffer = (config.SL_BUFFER_BASE || 2.0) * volatilityRatio;
    dynamicSLBuffer = Math.max(config.MIN_SL_BUFFER || 1.5, Math.min(dynamicSLBuffer, config.MAX_SL_BUFFER || 5.0));

    // Rounding to 2 decimal places for cleaner math later
    return {
        dynamicSpreadBuffer: Math.round(dynamicSpreadBuffer * 100) / 100,
        dynamicSLBuffer: Math.round(dynamicSLBuffer * 100) / 100,
        atr14: Math.round(atr14 * 100) / 100,
        atrBaseline: Math.round(atrBaseline * 100) / 100,
        volatilityRatio: Math.round(volatilityRatio * 100) / 100
    };
}

// [Fix] Dynamic DST Offset (Daylight Saving Time) for US/European brokers
function getBrokerOffset(date) {
    const year = date.getUTCFullYear();
    // US DST: 2nd Sunday in March to 1st Sunday in November
    let dstStart = new Date(Date.UTC(year, 2, 1)); // March 1st
    dstStart.setUTCDate(dstStart.getUTCDate() + (7 - dstStart.getUTCDay()) % 7 + 7); // 2nd Sunday
    
    let dstEnd = new Date(Date.UTC(year, 10, 1)); // Nov 1st
    dstEnd.setUTCDate(dstEnd.getUTCDate() + (7 - dstEnd.getUTCDay()) % 7); // 1st Sunday

    const isDST = date >= dstStart && date < dstEnd;
    return isDST ? 3 : 2; // Exness/ICMarkets is UTC+3 in Summer, UTC+2 in Winter
}

module.exports = { findFVG, findOrderBlock, checkPriceActionInZone, checkRecentPA, checkChoCh, getHTFTrend, getTradingRange, checkIDMSweep, checkM1ChochBreak, checkM5BOS, findM5FVG, calculateATR, calculateDynamicBuffers, getBrokerOffset };