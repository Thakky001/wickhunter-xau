const WebSocket = require('ws');
const ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

ws.on('open', () => {
    console.log('Connected, sending ticks_history for frxXAUUSD');
    ws.send(JSON.stringify({
        ticks_history: 'frxXAUUSD',
        end: 'latest',
        count: 100,
        style: 'candles',
        granularity: 3600 // H1
    }));
});

ws.on('message', (data) => {
    const res = JSON.parse(data);
    if (res.candles && res.candles.length > 0) {
        console.log(`Received ${res.candles.length} candles.`);
        const lastCandle = res.candles[res.candles.length - 1];
        const lastDate = new Date(lastCandle.epoch * 1000);
        console.log(`Latest Candle Time: ${lastDate.toISOString()}`);
        console.log(`Price: O:${lastCandle.open} H:${lastCandle.high} L:${lastCandle.low} C:${lastCandle.close}`);
    } else {
        console.log('Received:', res);
    }
    ws.close();
});
