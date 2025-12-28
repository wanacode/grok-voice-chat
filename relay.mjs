// relay.mjs (Ensure it matches the queuing logic)
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const app = express();
const server = app.listen(8080, () => console.log(`🚀 Relay: ws://localhost:8080`));
const wss = new WebSocketServer({ server });

wss.on('connection', (clientSocket) => {
  const xaiSocket = new WebSocket('wss://api.x.ai/v1/realtime', {
    headers: { 'Authorization': `Bearer ${process.env.XAI_API_KEY}` }
  });

  let messageQueue = [];

  xaiSocket.on('open', () => {
    while (messageQueue.length > 0) {
      xaiSocket.send(messageQueue.shift());
    }
  });

  clientSocket.on('message', (data) => {
    const msg = data.toString();
    if (xaiSocket.readyState === WebSocket.OPEN) {
      xaiSocket.send(msg);
    } else {
      messageQueue.push(msg);
    }
  });

  xaiSocket.on('message', (data) => {
    clientSocket.send(data.toString());
  });

  xaiSocket.on('error', (e) => console.error('xAI Error:', e));
  clientSocket.on('close', () => xaiSocket.close());
  xaiSocket.on('close', () => clientSocket.close());
});