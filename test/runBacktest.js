const fs = require('fs');
const path = require('path');
const { findFVG, findOrderBlock, checkRecentPA, getHTFTrend, calculateDynamicBuffers } = require('../logic/smcMath');

// === CONFIGURATION ===
const RR_TARGET = 3.0;
const MAX_DAILY_LOSS = 3;

const testDataDir = path.join(__dirname, 'data');
const h1File = path.join(testDataDir, 'twelvedata_xau_5y_h1.json');
const m5File = path.join(testDataDir, 'twelvedata_xau_5y_m5.json');

if (!fs.existsSync(h1File) || !fs.existsSync(m5File)) {
    console.error('❌ Data files not found.');
    process.exit(1);
}

let h1Data = JSON.parse(fs.readFileSync(h1File, 'utf-8'));
let m5Data = JSON.parse(fs.readFileSync(m5File, 'utf-8'));

h1Data = h1Data.map(c => ({ ...c, time: c.time || c.epoch }));
m5Data = m5Data.map(c => ({ ...c, time: c.time || c.epoch }));

const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const lastCandle = m5Data[m5Data.length - 1];
const nowMs = (lastCandle.time || lastCandle.epoch) * 1000;

function getPeriodName(timeMs) {
    const d = new Date(timeMs);
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, '0');
    return `${year}-${month}`;
}

let currentState = 'SCANNING'; 
let activeTrade = null;
let pendingSetup = null;
let holdingTimeStats = [];
let tradeStats = [];
let dualTpStats = { fullSl: 0, tp1Only: 0, fullTp2: 0 };
let currentBalance = 0;
let peakBalance = 0;
let maxDrawdown = 0;

let currentDay = -1;
let dailyLossCount = 0;

let results = {};

// Fixed Lot Size for Gold (1 lot = 100 oz). 0.02 lot = 2 oz. 
// So 1 point of movement (e.g., 2000.00 to 2001.00) = $2 PnL
const FIXED_LOT_SIZE = 0.02;
const DOLLARS_PER_POINT = FIXED_LOT_SIZE * 100;

let h1Index = 0;

for (let i = 50; i < m5Data.length; i++) {
    const currentM5 = m5Data[i];
    const currentTimeMs = currentM5.time * 1000;
    const period = getPeriodName(currentTimeMs);

    const dateObj = new Date(currentTimeMs);
    const dayOfMonth = dateObj.getUTCDate();
    if (dayOfMonth !== currentDay) {
        currentDay = dayOfMonth;
        dailyLossCount = 0;
    }

    while (h1Index < h1Data.length - 1 && h1Data[h1Index + 1].time <= currentM5.time) {
        h1Index++;
    }

    if (h1Index < 50) continue;

    const h1Slice = h1Data.slice(Math.max(0, h1Index - 100), h1Index + 1);
    const m5Slice = m5Data.slice(i - 20, i + 1);

    if (currentState === 'IN_TRADE') {
        let closed = false;
        let pnl = 0;
        let isWin = false;

        if (activeTrade.direction === 'BUY') {
            if (!activeTrade.isTp1Hit) {
                if (currentM5.low <= activeTrade.sl) {
                    pnl = (activeTrade.sl - activeTrade.entry) * DOLLARS_PER_POINT * 2;
                    closed = true;
                    dualTpStats.fullSl++;
                    dailyLossCount++;
                } else if (currentM5.high >= activeTrade.tp1) {
                    activeTrade.accumulatedPnl = (activeTrade.tp1 - activeTrade.entry) * DOLLARS_PER_POINT;
                    activeTrade.isTp1Hit = true;
                    activeTrade.sl = activeTrade.entry;
                    if (currentM5.high >= activeTrade.tp2) {
                        pnl = activeTrade.accumulatedPnl + ((activeTrade.tp2 - activeTrade.entry) * DOLLARS_PER_POINT);
                        closed = true;
                        isWin = true;
                        dualTpStats.fullTp2++;
                    }
                }
            } else {
                if (currentM5.low <= activeTrade.sl) {
                    pnl = activeTrade.accumulatedPnl;
                    closed = true;
                    isWin = true;
                    dualTpStats.tp1Only++;
                } else if (currentM5.high >= activeTrade.tp2) {
                    pnl = activeTrade.accumulatedPnl + ((activeTrade.tp2 - activeTrade.entry) * DOLLARS_PER_POINT);
                    closed = true;
                    isWin = true;
                    dualTpStats.fullTp2++;
                }
            }
        } else {
            if (!activeTrade.isTp1Hit) {
                if (currentM5.high >= activeTrade.sl) {
                    pnl = (activeTrade.entry - activeTrade.sl) * DOLLARS_PER_POINT * 2;
                    closed = true;
                    dualTpStats.fullSl++;
                    dailyLossCount++;
                } else if (currentM5.low <= activeTrade.tp1) {
                    activeTrade.accumulatedPnl = (activeTrade.entry - activeTrade.tp1) * DOLLARS_PER_POINT;
                    activeTrade.isTp1Hit = true;
                    activeTrade.sl = activeTrade.entry;
                    if (currentM5.low <= activeTrade.tp2) {
                        pnl = activeTrade.accumulatedPnl + ((activeTrade.entry - activeTrade.tp2) * DOLLARS_PER_POINT);
                        closed = true;
                        isWin = true;
                        dualTpStats.fullTp2++;
                    }
                }
            } else {
                if (currentM5.high >= activeTrade.sl) {
                    pnl = activeTrade.accumulatedPnl;
                    closed = true;
                    isWin = true;
                    dualTpStats.tp1Only++;
                } else if (currentM5.low <= activeTrade.tp2) {
                    pnl = activeTrade.accumulatedPnl + ((activeTrade.entry - activeTrade.tp2) * DOLLARS_PER_POINT);
                    closed = true;
                    isWin = true;
                    dualTpStats.fullTp2++;
                }
            }
        }

        if (closed) {
            updateStats(period, isWin, pnl);
            
            currentBalance += pnl;
            if (currentBalance > peakBalance) peakBalance = currentBalance;
            const drawdown = peakBalance - currentBalance;
            if (drawdown > maxDrawdown) maxDrawdown = drawdown;
            
            holdingTimeStats.push(i - activeTrade.entryIndex);
            currentState = 'SCANNING';
            activeTrade = null;
        }
    } 
    else if (currentState === 'WAITING_CHOCH') {
        let broken = false;
        if (pendingSetup.direction === 'BUY' && currentM5.close > pendingSetup.chochTarget) {
            broken = true;
        } else if (pendingSetup.direction === 'SELL' && currentM5.close < pendingSetup.chochTarget) {
            broken = true;
        }

        let invalid = false;
        if (pendingSetup.direction === 'BUY' && currentM5.low <= pendingSetup.sl) invalid = true;
        if (pendingSetup.direction === 'SELL' && currentM5.high >= pendingSetup.sl) invalid = true;

        if (invalid) {
            currentState = 'SCANNING';
            pendingSetup = null;
        } else if (broken) {
            const entry = currentM5.close; 
            const sl = pendingSetup.sl;
            const risk = Math.abs(entry - sl);
            const tp1 = pendingSetup.direction === 'BUY' ? entry + (risk * 3) : entry - (risk * 3);
            const tp2 = pendingSetup.direction === 'BUY' ? entry + (risk * 4) : entry - (risk * 4);
            tradeStats.push({ risk, tpDistance: Math.abs(entry - tp2) });

            activeTrade = {
                direction: pendingSetup.direction,
                entry,
                sl,
                tp1,
                tp2,
                originalSl: sl,
                isTp1Hit: false,
                accumulatedPnl: 0,
                entryIndex: i
            };
            currentState = 'IN_TRADE';
            pendingSetup = null;
        } else if (i - pendingSetup.startIndex > 12) {
            currentState = 'SCANNING';
            pendingSetup = null;
        }
    }
    else if (currentState === 'SCANNING') {
        // --- [FILTER 1] Session Filter ---
        // เทรดเฉพาะตลาดยุโรป-อเมริกา (07:00 UTC - 16:00 UTC)
        const currentHour = new Date(currentTimeMs).getUTCHours();
        if (currentHour < 7 || currentHour > 16) continue;

        // --- [FILTER 2] Circuit Breaker (Max 3 Loss/Day) ---
        const d = new Date(currentTimeMs);
        const dayString = `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}-${d.getUTCDate()}`;
        if (dayString !== currentDay) {
            currentDay = dayString;
            dailyLossCount = 0;
        }

        if (dailyLossCount >= 3) {
            continue; // โดนไป 3 ไม้แล้ว วันนี้พอแค่นี้
        }

        const htfTrend = getHTFTrend(h1Slice);
        const fvgs = findFVG(h1Slice, m5Slice);
        const obs = findOrderBlock(h1Slice);
        const allZones = fvgs.concat(obs);

        const isTrending = (htfTrend === 'BULLISH' || htfTrend === 'BEARISH');
        
        for (const zone of allZones) {
            if (isTrending) {
                if (htfTrend === 'BULLISH' && zone.type !== 'BUY_ZONE') continue;
                if (htfTrend === 'BEARISH' && zone.type !== 'SELL_ZONE') continue;
            }

            const paResult = checkRecentPA(m5Slice, zone, 10);
            if (paResult.isValid) {
                const direction = zone.type === 'BUY_ZONE' ? 'BUY' : 'SELL';
                const recentSlice = m5Slice.slice(-5);
                let chochTarget = 0;
                let sl = 0;

                const config = { USE_ATR_BUFFER: true, ATR_SL_MULTIPLIER: 0.5, SL_BUFFER: 0.5, SPREAD_BUFFER: 0.2 };
                const atr = calculateDynamicBuffers(m5Slice, config).dynamicSLBuffer || 0.5;

                if (direction === 'BUY') {
                    chochTarget = Math.max(...recentSlice.map(c => c.high));
                    sl = Math.min(...recentSlice.map(c => c.low)) - atr;
                } else {
                    chochTarget = Math.min(...recentSlice.map(c => c.low));
                    sl = Math.max(...recentSlice.map(c => c.high)) + atr;
                }

                pendingSetup = {
                    direction,
                    chochTarget,
                    sl,
                    startIndex: i
                };
                currentState = 'WAITING_CHOCH';
                break;
            }
        }
    }
}

function updateStats(period, isWin, pnl) {
    if (!results[period]) {
        results[period] = { trades: 0, wins: 0, losses: 0, pnl: 0 };
    }
    results[period].trades++;
    if (isWin) results[period].wins++;
    else results[period].losses++;
    results[period].pnl += pnl;
}

console.log('\n📊 === BACKTEST RESULTS WITH CIRCUIT BREAKER (Max Loss: 3/day) ===');

    let cumulativePnL = 0;
    let simulatedBalance = 1000;
    
    // Sort the periods chronologically (e.g., 2021-06, 2021-07...)
    const periods = Object.keys(results).sort();

    console.log(`\n### 📊 สรุปผล Backtest รายเดือน (ทุนเริ่มต้น $1,000 | Lot Size คงที่: 0.02 Lot)\n`);
    console.log(`| เดือน/ปี | จำนวนเทรด | ชนะ | แพ้ | Win Rate | PnL ประจำเดือน | ยอดเงินคงเหลือ (Balance) |`);
    console.log(`| :--- | :---: | :---: | :---: | :---: | :---: | :---: |`);

    for (const period of periods) {
        const stat = results[period];
        if (stat.trades === 0) continue;
        
        cumulativePnL += stat.pnl;
        simulatedBalance += stat.pnl;
        
        const winRate = ((stat.wins / stat.trades) * 100).toFixed(2);
        const pnlStr = stat.pnl >= 0 ? `+` + stat.pnl.toFixed(2) : stat.pnl.toFixed(2);
        
        console.log(`| **${period}** | ${stat.trades} | ${stat.wins} | ${stat.losses} | ${winRate}% | $${pnlStr} | **$${simulatedBalance.toFixed(2)}** |`);
    }

    console.log('\n💰 === TOTAL PROFIT (5 Years, 0.02 Lot fixed) ===');
    console.log(`   💵 PnL รวมทั้งหมด: $${cumulativePnL.toFixed(2)}`);

console.log('\n✅ Backtest สำเร็จ!');
console.log('\n📊 === สถิติแยกตามการปิดกำไร (Dual TP) ===');
console.log(`🔸 โดนกิน SL เต็ม (เสีย 2 เท่า): ${dualTpStats.fullSl} ไม้`);
console.log(`🔸 ชน TP1 แล้วโดนหน้าทุน (ได้แค่ 3 เท่า): ${dualTpStats.tp1Only} ไม้`);
console.log(`🔸 ชน TP2 ทะลุเป้า (ได้เต็ม 7 เท่า): ${dualTpStats.fullTp2} ไม้`);
console.log(`\n📉 === ความเสี่ยง (Risk & Drawdown) ===`);
console.log(`🔸 Max Drawdown (ยอดเงินที่ลบลงไปลึกสุด): -$${maxDrawdown.toFixed(2)}`);

if (holdingTimeStats.length > 0) {
    const avgCandles = holdingTimeStats.reduce((a, b) => a + b, 0) / holdingTimeStats.length;
    console.log(`\n⏳ ถือออเดอร์เฉลี่ย: ${(avgCandles * 5).toFixed(0)} นาที (${(avgCandles * 5 / 60).toFixed(1)} ชั่วโมง) ต่อ 1 ออเดอร์`);
}
