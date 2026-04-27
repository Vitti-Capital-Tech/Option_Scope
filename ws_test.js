import WebSocket from 'ws';

const ws = new WebSocket('wss://socket.delta.exchange');

ws.on('open', () => {
  ws.send(JSON.stringify({
    type: 'subscribe',
    payload: {
      channels: [
        {
          name: 'candlestick_1h',
          symbols: ['C-BTC-77800-230426']
        }
      ]
    }
  }));
});

ws.on('message', (data) => {
  console.log(data.toString());
});

setTimeout(() => process.exit(0), 10000);
