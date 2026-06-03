const { EventEmitter } = require('events');

const emitter = new EventEmitter();

const state = {
    botState: 'SCANNING',
    wsStatus: 'DISCONNECTED',
    zonesFound: { fvg: 0, ob: 0, total: 0 },
    lastM5: { open: 0, high: 0, low: 0, close: 0 },
    lastSignal: null,
    lastScanTime: null,
    signalHistory: [],
    winRate: {
        daily: { win: 0, loss: 0, rate: 0 },
        monthly: { win: 0, loss: 0, rate: 0 }
    }
};

let localTrades = []; // เก็บประวัติออเดอร์ในหน่วยความจำ

function parseSheetsDate(dateStr) {
    if (!dateStr) return new Date();
    if (dateStr.includes('T') && dateStr.includes('Z')) {
        return new Date(dateStr);
    }
    
    try {
        const parts = dateStr.split(' ');
        const dateParts = parts[0].split('/');
        const timeParts = parts[1] ? parts[1].split(':') : [0,0,0];
        
        let day = parseInt(dateParts[0]);
        let month = parseInt(dateParts[1]) - 1;
        let year = parseInt(dateParts[2]);
        
        if (year > 2400) {
            year = year - 543;
        }
        
        let hour = parseInt(timeParts[0]);
        let minute = parseInt(timeParts[1]);
        let second = parseInt(timeParts[2]);
        
        return new Date(year, month, day, hour, minute, second);
    } catch (e) {
        return new Date(dateStr);
    }
}

function recalculateWinRates() {
    const now = new Date();
    
    const isTodayBangkok = (d) => {
        const dStr = d.toLocaleDateString('en-US', { timeZone: 'Asia/Bangkok' });
        const nowStr = now.toLocaleDateString('en-US', { timeZone: 'Asia/Bangkok' });
        return dStr === nowStr;
    };
    
    const isThisMonthBangkok = (d) => {
        const dMonthStr = d.toLocaleDateString('en-US', { timeZone: 'Asia/Bangkok', month: '2-digit', year: 'numeric' });
        const nowMonthStr = now.toLocaleDateString('en-US', { timeZone: 'Asia/Bangkok', month: '2-digit', year: 'numeric' });
        return dMonthStr === nowMonthStr;
    };

    let dailyWins = 0;
    let dailyLosses = 0;
    let monthlyWins = 0;
    let monthlyLosses = 0;

    for (let trade of localTrades) {
        if (trade.outcome === 'PENDING') continue;
        
        const tradeDate = parseSheetsDate(trade.timestamp);
        const isWin = trade.outcome === 'WIN';
        
        if (isTodayBangkok(tradeDate)) {
            if (isWin) dailyWins++;
            else dailyLosses++;
        }
        
        if (isThisMonthBangkok(tradeDate)) {
            if (isWin) monthlyWins++;
            else monthlyLosses++;
        }
    }

    const calcRate = (w, l) => {
        const total = w + l;
        return total === 0 ? 0 : parseFloat(((w / total) * 100).toFixed(1));
    };

    state.winRate = {
        daily: { win: dailyWins, loss: dailyLosses, rate: calcRate(dailyWins, dailyLosses) },
        monthly: { win: monthlyWins, loss: monthlyLosses, rate: calcRate(monthlyWins, monthlyLosses) }
    };
}

function recordTradeOutcome(type, direction, entry, timestamp) {
    if (!entry) return;
    const entryVal = parseFloat(entry);

    if (type === 'TRIGGERED') {
        localTrades.push({
            timestamp,
            direction,
            entry: entryVal,
            outcome: 'PENDING'
        });
    } else if (type === 'TP1_HIT' || type === 'TP2_HIT') {
        const trade = localTrades.find(t => t.direction === direction && Math.abs(t.entry - entryVal) < 0.05);
        if (trade) {
            trade.outcome = 'WIN';
        } else {
            localTrades.push({
                timestamp,
                direction,
                entry: entryVal,
                outcome: 'WIN'
            });
        }
    } else if (type === 'SL_HIT') {
        const trade = localTrades.find(t => t.direction === direction && Math.abs(t.entry - entryVal) < 0.05);
        if (trade) {
            trade.outcome = 'LOSS';
        } else {
            localTrades.push({
                timestamp,
                direction,
                entry: entryVal,
                outcome: 'LOSS'
            });
        }
    }

    recalculateWinRates();
}

function initTrades(trades) {
    localTrades = trades;
    recalculateWinRates();
    emitter.emit('stateUpdate', state);
}

function update(data) {
    Object.assign(state, data);
    state.lastScanTime = new Date().toISOString();
    emitter.emit('stateUpdate', state);
}

function updateWsStatus(status) {
    state.wsStatus = status;
    emitter.emit('stateUpdate', state);
}

function addSignal(signal) {
    const signalWithTime = { ...signal, time: signal.time || new Date().toISOString() };
    state.lastSignal = signalWithTime;
    state.signalHistory.unshift(signalWithTime);
    if (state.signalHistory.length > 20) {
        state.signalHistory = state.signalHistory.slice(0, 20);
    }
    
    recordTradeOutcome(signal.type, signal.direction, signal.entry, signalWithTime.time);
    
    emitter.emit('stateUpdate', state);
}

module.exports = { state, update, updateWsStatus, addSignal, initTrades, emitter };
