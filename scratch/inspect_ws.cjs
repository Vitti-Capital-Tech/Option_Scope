const WebSocket = require('ws');
const ws = new WebSocket('wss://socket.delta.exchange');

ws.on('open', () => {
  console.log('Connected to Delta WS');
  ws.send(JSON.stringify({
    type: 'subscribe',
    payload: {
      channels: [
        {
          name: 'v2/ticker',
          symbols: ['C-BTC-77800-230426'],
        },
      ],
    },
  }));
});

ws.on('message', (data) => {
  const msg = JSON.parse(data);
  if (msg.type === 'v2/ticker') {
    console.log(JSON.stringify(msg, null, 2));
    process.exit(0);
  }
});

setTimeout(() => {
  console.log('Timeout - no ticker received');
  process.exit(1);
}, 10000);
