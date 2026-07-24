const smcEngine = require('../logic/smcEngine');
const dashboardState = require('../services/dashboardState');

const testCases = [
    {
        name: "Case 1: Empty Signals",
        signals: [],
        expectedState: "SCANNING",
        expectedActiveTrade: null
    },
    {
        name: "Case 2: Last trade is fully closed (TP2_HIT)",
        signals: [
            { type: 'TRIGGERED', direction: 'BUY', entry: 4000, sl: 3990, tp1: 4010, tp2: 4020 },
            { type: 'TP1_HIT', direction: 'BUY', entry: 4000, sl: 4000, tp1: 4010, tp2: 4020 },
            { type: 'TP2_HIT', direction: 'BUY', entry: 4000, sl: 4000, tp1: 4010, tp2: 4020 }
        ],
        expectedState: "SCANNING",
        expectedActiveTrade: null
    },
    {
        name: "Case 3: Last trade is fully closed (SL_HIT)",
        signals: [
            { type: 'TRIGGERED', direction: 'SELL', entry: 4050, sl: 4060, tp1: 4030, tp2: 4010 },
            { type: 'SL_HIT', direction: 'SELL', entry: 4050, sl: 4060, tp1: 4030, tp2: 4010 }
        ],
        expectedState: "SCANNING",
        expectedActiveTrade: null
    },
    {
        name: "Case 4: Last trade is active (TRIGGERED)",
        signals: [
            { type: 'TRIGGERED', direction: 'BUY', entry: 4020, sl: 4010, tp1: 4040, tp2: 4050 }
        ],
        expectedState: "MONITORING_TRADE",
        expectedActiveTrade: {
            direction: 'BUY', entry: 4020, sl: 4010, tp1: 4040, tp2: 4050, isTp1Hit: false
        }
    },
    {
        name: "Case 5: Last trade hit TP1 (Trailing Stop Active)",
        signals: [
            { type: 'TRIGGERED', direction: 'SELL', entry: 4055.77, sl: 4072.89, tp1: 4004.41, tp2: 3987.29 },
            { type: 'TP1_HIT', direction: 'SELL', entry: 4055.77, sl: 4055.77, tp1: 4004.41, tp2: 3987.29 }
        ],
        expectedState: "MONITORING_TRADE",
        expectedActiveTrade: {
            direction: 'SELL', entry: 4055.77, sl: 4055.77, tp1: 4004.41, tp2: 3987.29, isTp1Hit: true
        }
    },
    {
        name: "Case 6: Multiple trades in history, newest is active",
        signals: [
            { type: 'TRIGGERED', direction: 'BUY', entry: 4000, sl: 3990, tp1: 4010, tp2: 4020 },
            { type: 'SL_HIT', direction: 'BUY', entry: 4000, sl: 3990, tp1: 4010, tp2: 4020 },
            { type: 'TRIGGERED', direction: 'SELL', entry: 4025, sl: 4035, tp1: 4015, tp2: 4005 }
        ],
        expectedState: "MONITORING_TRADE",
        expectedActiveTrade: {
            direction: 'SELL', entry: 4025, sl: 4035, tp1: 4015, tp2: 4005, isTp1Hit: false
        }
    }
];

async function runTests() {
    let passed = 0;
    
    for (const test of testCases) {
        console.log(`\n======================================`);
        console.log(`🧪 Running: ${test.name}`);
        
        // Reset state by mocking it
        dashboardState.update({ botState: 'SCANNING', activeTrade: null });
        
        // Call resume
        smcEngine.resumeStateFromHistory(test.signals);
        
        // Check state
        const state = dashboardState.state;
        const botState = state.botState;
        const activeTrade = state.activeTrade;

        let pass = true;
        
        if (botState !== test.expectedState) {
            console.log(`❌ FAILED: Expected state '${test.expectedState}', but got '${botState}'`);
            pass = false;
        }
        
        if (JSON.stringify(activeTrade) !== JSON.stringify(test.expectedActiveTrade)) {
            console.log(`❌ FAILED: Expected activeTrade:`);
            console.log(test.expectedActiveTrade);
            console.log(`But got:`);
            console.log(activeTrade);
            pass = false;
        }

        if (pass) {
            console.log(`✅ PASSED`);
            passed++;
        }
    }
    
    console.log(`\n======================================`);
    console.log(`🎉 TEST SUMMARY: ${passed} / ${testCases.length} Passed`);
    process.exit(passed === testCases.length ? 0 : 1);
}

runTests();
