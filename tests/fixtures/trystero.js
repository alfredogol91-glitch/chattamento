// Deterministic transport ONLY used by the browser-test Vite alias.
// Production builds import the actual Trystero package, never this fixture.
export const selfId = crypto.randomUUID();

export function joinRoom(config, roomId) {
  const actions = new Map();
  const peers = new Map();
  let joined, left;
  let closed = false;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}/__testtransport`);
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'join', id: selfId, roomId, password: config.password }));
      resolve();
    });
    ws.addEventListener('error', reject, { once: true });
  });
  const room = {
    makeAction(name, configuration = {}) {
      if (actions.has(name)) return actions.get(name);
      const action = {
        ...configuration,
        async send(data, options = {}) {
          await ready;
          if (closed) throw new Error('closed');
          const value = data instanceof ArrayBuffer || ArrayBuffer.isView(data)
            ? { __bytes: Array.from(new Uint8Array(data.buffer || data, data.byteOffset || 0, data.byteLength)) } : data;
          ws.send(JSON.stringify({ type: 'action', name, data: value, target: options.target, metadata: options.metadata }));
        },
      };
      actions.set(name, action);
      return action;
    },
    getPeers: () => Object.fromEntries([...peers.keys()].map(id => [id, { connectionState: 'connected' }])),
    leave() { closed = true; ws.close(); peers.clear(); },
    addStream: () => [], removeStream: () => {}, addTrack: () => [], removeTrack: () => {}, replaceTrack: () => [],
  };
  Object.defineProperties(room, {
    onPeerJoin: { get: () => joined, set: fn => { joined = fn; if (fn) for (const id of peers.keys()) fn(id); } },
    onPeerLeave: { get: () => left, set: fn => { left = fn; } },
  });
  ws.addEventListener('message', async ({ data }) => {
    const message = JSON.parse(data);
    if (message.type === 'peer-joined') { peers.set(message.id, true); joined?.(message.id); }
    if (message.type === 'peer-left') { peers.delete(message.id); left?.(message.id); }
    if (message.type === 'action') {
      const action = actions.get(message.name);
      if (!action) return;
      const value = message.data?.__bytes ? new Uint8Array(message.data.__bytes).buffer : message.data;
      const context = { peerId: message.from, metadata: message.metadata };
      const byteLength = value instanceof ArrayBuffer ? value.byteLength : new TextEncoder().encode(JSON.stringify(value)).byteLength;
      if (action.onReceive && !await action.onReceive({ ...context, byteLength, kind: 'message', signal: new AbortController().signal })) return;
      action.onMessage?.(value, context);
    }
  });
  return room;
}
