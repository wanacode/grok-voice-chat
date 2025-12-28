// relay.mjs
import express from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const app = express();
const server = app.listen(8080, () => console.log(`🚀 Relay: ws://localhost:8080`));
const wss = new WebSocketServer({ server });

wss.on('connection', (clientSocket) => {
  console.log('🔗 Browser connected');
  
  const xaiSocket = new WebSocket('wss://api.x.ai/v1/realtime', {
    headers: { 'Authorization': `Bearer ${process.env.XAI_API_KEY}` }
  });

  let messageQueue = []; // Queue to hold messages until xAI is ready

  xaiSocket.on('open', () => {
    console.log('🚀 Connected to xAI');
    // Flush the queue!
    while (messageQueue.length > 0) {
      xaiSocket.send(messageQueue.shift());
    }
  });

  clientSocket.on('message', (data) => {
    const msg = data.toString();
    if (xaiSocket.readyState === WebSocket.OPEN) {
      xaiSocket.send(msg);
    } else {
      console.log('⏳ xAI not ready, queuing message...');
      messageQueue.push(msg);
    }
  });

  xaiSocket.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    // Only log important events to keep the terminal clean
    if (msg.type !== 'ping') console.log(`xAI -> Browser: ${msg.type}`);
    clientSocket.send(data.toString());
  });

  xaiSocket.on('error', (e) => console.error('❌ xAI Error:', e));
  clientSocket.on('close', () => clientSocket.close());
  clientSocket.on('close', () => xaiSocket.close());
});