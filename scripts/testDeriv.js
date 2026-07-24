const WebSocket = require('ws');
const ws = new WebSocket('wss://ws.binaryws.com/websockets/v3?app_id=1089');

ws.on('open', () => {
    console.log('Connected to Deriv, sending tick request for frxXAUUSD');
    ws.send(JSON.stringify({ ticks: "frxXAUUSD", subscribe: 1 }));
});

ws.on('message', (data) => {
    console.log('Received:', JSON.parse(data));
    setTimeout(() => {
        ws.close();
        process.exit(0);
    }, 2000);
});

ws.on('error', (err) => {
    console.error('Error:', err);
});
