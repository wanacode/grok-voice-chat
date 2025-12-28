// server.js
import { createServer } from 'http';
import { parse } from 'url';
import next from 'next';
import { WebSocketServer, WebSocket } from 'ws';
import dotenv from 'dotenv';

dotenv.config({ path: '.env.local' });

const dev = process.env.NODE_ENV !== 'production';
const app = next({ dev });
const handle = app.getRequestHandler();
const port = process.env.PORT || 3000;

app.prepare().then(() => {
  const server = createServer((req, res) => {
    const parsedUrl = parse(req.url, true);
    handle(req, res, parsedUrl);
  });

  // Attach WS to the same server
  const wss = new WebSocketServer({ noServer: true });

  server.on('upgrade', (request, socket, head) => {
    const { pathname } = parse(request.url);
    
    // Only handle our specific realtime path
    if (pathname === '/realtime') {
      wss.handleUpgrade(request, socket, head, (ws) => {
        wss.emit('connection', ws, request);
      });
    } else {
      socket.destroy();
    }
  });

  wss.on('connection', (clientSocket) => {
    console.log('🔗 Browser connected to /realtime');

    const xaiSocket = new WebSocket('wss://api.x.ai/v1/realtime', {
      headers: { 'Authorization': `Bearer ${process.env.XAI_API_KEY}` }
    });

    let messageQueue = [];

    xaiSocket.on('open', () => {
      console.log('🚀 xAI Connection Open');
      while (messageQueue.length > 0) {
        if (xaiSocket.readyState === WebSocket.OPEN) xaiSocket.send(messageQueue.shift());
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
      if (clientSocket.readyState === WebSocket.OPEN) {
        clientSocket.send(data.toString());
      }
    });

    xaiSocket.on('error', (err) => console.error('❌ xAI Error:', err.message));
    
    xaiSocket.on('close', (code) => {
      console.log('🔌 xAI closed connection');
      clientSocket.close();
    });

    clientSocket.on('close', () => {
      if (xaiSocket.readyState === WebSocket.OPEN) xaiSocket.close();
    });
  });

  server.listen(port, () => {
    console.log(`🚀 Server ready on http://localhost:${port}`);
  });
});