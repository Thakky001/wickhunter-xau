const { EventEmitter } = require('events');

const emitter = new EventEmitter();

const state = {
    botState: 'SCANNING',
    wsStatus: 'DISCONNECTED',
    zonesFound: { fvg: 0, ob: 0, total: 0 },
    lastM5: { open: 0, high: 0, low: 0, close: 0 },
    lastSignal: null,
    lastScanTime: null,
    signalHistory: []
};

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
    emitter.emit('stateUpdate', state);
}

module.exports = { state, update, updateWsStatus, addSignal, emitter };
