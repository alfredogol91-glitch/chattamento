// Serves the REAL app and peerRoom protocol, substituting only the external
// peer discovery/data transport. This local fixture is not in the static build.
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { WebSocketServer } from 'ws';
import { fileURLToPath } from 'node:url';

const vite = await createServer({
  configFile: false,
  plugins: [react()],
  resolve: { alias: [{ find: '@trystero-p2p/torrent', replacement: fileURLToPath(new URL('./fixtures/trystero.js', import.meta.url)) }] },
  server: { host: '127.0.0.1', port: 3100, strictPort: true },
});
const wss = new WebSocketServer({ noServer: true });
vite.httpServer.on('upgrade', (req, socket, head) => {
  if (req.url === '/__testtransport') wss.handleUpgrade(req, socket, head, client => wss.emit('connection', client));
});
wss.on('connection', client => {
  client.on('message', bytes => {
    const message = JSON.parse(bytes.toString());
    if (message.type === 'join') {
      client.peerId = message.id;
      client.room = `${message.roomId}:${message.password}`;
      for (const peer of wss.clients) {
        if (peer !== client && peer.room === client.room && peer.readyState === 1) {
          peer.send(JSON.stringify({ type: 'peer-joined', id: client.peerId }));
          client.send(JSON.stringify({ type: 'peer-joined', id: peer.peerId }));
        }
      }
    } else if (message.type === 'action' && client.room) {
      for (const peer of wss.clients) {
        if (peer === client || peer.room !== client.room || peer.readyState !== 1) continue;
        if (message.target && !(Array.isArray(message.target) ? message.target : [message.target]).includes(peer.peerId)) continue;
        peer.send(JSON.stringify({ ...message, from: client.peerId }));
      }
    }
  });
  client.on('close', () => {
    for (const peer of wss.clients) if (peer.room === client.room && peer.readyState === 1) peer.send(JSON.stringify({ type: 'peer-left', id: client.peerId }));
  });
});
await vite.listen();
for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, async () => {
  for (const peer of wss.clients) peer.terminate();
  wss.close();
  await vite.close();
  process.exit(0);
});
