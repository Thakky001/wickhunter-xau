const fs = require('fs');
const path = require('path');
const { findFVG, findOrderBlock, checkRecentPA, getHTFTrend, calculateDynamicBuffers } = require('../logic/smcMath');

// === CONFIGURATION ===
const LOT_SIZE = 0.01;
const DOLLARS_PER_POINT = 1; // 1 Lot = 100 oz. 0.01 Lot = 1 oz. So $1 move = $1.
const RR_TARGET = 2.0;

const testDataDir = path.join(__dirname, 'data');
const h1File = path.join(testDataDir, 'xau_1y_h1.json');
const m5File = path.join(testDataDir, 'xau_1y_m5.json');

if (!fs.existsSync(h1File) || !fs.existsSync(m5File)) {
    console.error('❌ Data files not found. Run scripts/downloadDerivData.js first.');
    process.exit(1);
}

console.log('⏳ Loading historical data...');
const h1Data = JSON.parse(fs.readFileSync(h1File, 'utf-8'));
const m5Data = JSON.parse(fs.readFileSync(m5File, 'utf-8'));
console.log(`✅ Loaded ${h1Data.length} H1 candles and ${m5Data.length} M5 candles.`);

// Organize data by time
const ONE_MONTH_MS = 30 * 24 * 60 * 60 * 1000;
const nowMs = m5Data[m5Data.length - 1].time * 1000;

function getPeriodName(timeMs) {
    const diff = nowMs - timeMs;
    if (diff <= ONE_MONTH_MS) return '1M';
    if (diff <= 3 * ONE_MONTH_MS) return '3M';
    if (diff <= 6 * ONE_MONTH_MS) return '6M';
    return '1Y';
}

// === SIMULATOR STATE ===
let currentState = 'SCANNING'; // SCANNING, WAITING_CHOCH, IN_TRADE
let activeTrade = null;
let pendingSetup = null;

let results = {
    '1M': { trades: 0, wins: 0, losses: 0, pnl: 0 },
    '3M': { trades: 0, wins: 0, losses: 0, pnl: 0 },
    '6M': { trades: 0, wins: 0, losses: 0, pnl: 0 },
    '1Y': { trades: 0, wins: 0, losses: 0, pnl: 0 },
};

let h1Index = 0;

// === RUN SIMULATION ===
console.log('🚀 Starting Backtest...');

for (let i = 50; i < m5Data.length; i++) {
    const currentM5 = m5Data[i];
    const currentTimeMs = currentM5.time * 1000;
    const period = getPeriodName(currentTimeMs);

    // Sync H1 index
    while (h1Index < h1Data.length - 1 && h1Data[h1Index + 1].time <= currentM5.time) {
        h1Index++;
    }

    if (h1Index < 50) continue; // Need enough history

    const h1Slice = h1Data.slice(Math.max(0, h1Index - 100), h1Index + 1);
    const m5Slice = m5Data.slice(i - 20, i + 1);

    if (currentState === 'IN_TRADE') {
        // Check SL / TP
        let closed = false;
        let pnl = 0;
        let isWin = false;

        if (activeTrade.direction === 'BUY') {
            if (currentM5.low <= activeTrade.sl) {
                pnl = (activeTrade.sl - activeTrade.entry) * DOLLARS_PER_POINT;
                closed = true;
            } else if (currentM5.high >= activeTrade.tp) {
                pnl = (activeTrade.tp - activeTrade.entry) * DOLLARS_PER_POINT;
                closed = true;
                isWin = true;
            }
        } else {
            if (currentM5.high >= activeTrade.sl) {
                pnl = (activeTrade.entry - activeTrade.sl) * DOLLARS_PER_POINT;
                closed = true;
            } else if (currentM5.low <= activeTrade.tp) {
                pnl = (activeTrade.entry - activeTrade.tp) * DOLLARS_PER_POINT;
                closed = true;
                isWin = true;
            }
        }

        if (closed) {
            // Update stats for all periods that include this time
            if (period === '1M') {
                updateStats('1M', isWin, pnl);
                updateStats('3M', isWin, pnl);
                updateStats('6M', isWin, pnl);
                updateStats('1Y', isWin, pnl);
            } else if (period === '3M') {
                updateStats('3M', isWin, pnl);
                updateStats('6M', isWin, pnl);
                updateStats('1Y', isWin, pnl);
            } else if (period === '6M') {
                updateStats('6M', isWin, pnl);
                updateStats('1Y', isWin, pnl);
            } else {
                updateStats('1Y', isWin, pnl);
            }
            
            currentState = 'SCANNING';
            activeTrade = null;
        }
    } 
    else if (currentState === 'WAITING_CHOCH') {
        // Check if current M5 breaks the ChoCh target
        let broken = false;
        if (pendingSetup.direction === 'BUY' && currentM5.close > pendingSetup.chochTarget) {
            broken = true;
        } else if (pendingSetup.direction === 'SELL' && currentM5.close < pendingSetup.chochTarget) {
            broken = true;
        }

        // Check if invalid (hit SL before ChoCh)
        let invalid = false;
        if (pendingSetup.direction === 'BUY' && currentM5.low <= pendingSetup.sl) invalid = true;
        if (pendingSetup.direction === 'SELL' && currentM5.high >= pendingSetup.sl) invalid = true;

        if (invalid) {
            currentState = 'SCANNING';
            pendingSetup = null;
        } else if (broken) {
            // ENTER TRADE
            const entry = currentM5.close; // enter at close
            const sl = pendingSetup.sl;
            const risk = Math.abs(entry - sl);
            const tp = pendingSetup.direction === 'BUY' ? entry + (risk * RR_TARGET) : entry - (risk * RR_TARGET);

            console.log(`[TRADE ENTERED] ${pendingSetup.direction} at ${entry} SL=${sl} TP=${tp}`);
            activeTrade = {
                direction: pendingSetup.direction,
                entry,
                sl,
                tp
            };
            currentState = 'IN_TRADE';
            pendingSetup = null;
        } else if (i - pendingSetup.startIndex > 12) {
            // Timeout after 1 hour (12 M5 candles)
            currentState = 'SCANNING';
            pendingSetup = null;
        }
    }
    else if (currentState === 'SCANNING') {
        const htfTrend = getHTFTrend(h1Slice);
        const fvgs = findFVG(h1Slice, m5Slice);
        const obs = findOrderBlock(h1Slice);
        const allZones = fvgs.concat(obs);

        // Filter zones by trend
        const isTrending = (htfTrend === 'BULLISH' || htfTrend === 'BEARISH');
        
        for (const zone of allZones) {
            if (isTrending) {
                if (htfTrend === 'BULLISH' && zone.type !== 'BUY_ZONE') continue;
                if (htfTrend === 'BEARISH' && zone.type !== 'SELL_ZONE') continue;
            }

            const paResult = checkRecentPA(m5Slice, zone, 10);
            if (paResult.isValid) {
                // Determine ChoCh target
                const direction = zone.type === 'BUY_ZONE' ? 'BUY' : 'SELL';
                
                // Simplified ChoCh target (highest/lowest of last 5 candles)
                const recentSlice = m5Slice.slice(-5);
                let chochTarget = 0;
                let sl = 0;

                const config = { USE_ATR_BUFFER: true, ATR_SL_MULTIPLIER: 0.5, SL_BUFFER: 0.5, SPREAD_BUFFER: 0.2 };
                const atr = calculateDynamicBuffers(m5Slice, config).dynamicSLBuffer || 0.5; // dynamic buffer

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
                console.log(`[DEBUG] Found PA in ${direction} zone. Waiting for ChoCh. Target: ${chochTarget}`);
                break; // Stop checking other zones
            }
        }
    }
}

function updateStats(period, isWin, pnl) {
    results[period].trades++;
    if (isWin) results[period].wins++;
    else results[period].losses++;
    results[period].pnl += pnl;
}

// === PRINT RESULTS ===
console.log('\n📊 === BACKTEST RESULTS (Lot 0.01 / $1 per point) ===');

for (const period of ['1M', '3M', '6M', '1Y']) {
    const stat = results[period];
    const winRate = stat.trades > 0 ? ((stat.wins / stat.trades) * 100).toFixed(2) : 0;
    
    console.log(`\n📅 ระยะเวลา: ${period} ล่าสุด`);
    console.log(`   🔸 จำนวนเทรด: ${stat.trades} ไม้`);
    console.log(`   🟢 ชนะ: ${stat.wins} | 🔴 แพ้: ${stat.losses}`);
    console.log(`   🎯 Win Rate: ${winRate}%`);
    console.log(`   💵 PnL สุทธิ: $${stat.pnl.toFixed(2)}`);
}

console.log('\n✅ Backtest สำเร็จ!');
