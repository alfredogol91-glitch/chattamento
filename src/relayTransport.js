// An invitation-scoped, encrypted data transport. Public MQTT brokers only see
// an opaque topic, ephemeral public keys, packet sizes and encrypted bytes.
export const RELAY_BROKERS = Object.freeze([
  'wss://broker.hivemq.com:8884/mqtt',
  'wss://broker.emqx.io:8084/mqtt',
]);

const encoder = new TextEncoder();
const decoder = new TextDecoder('utf-8', { fatal: true });
const MAX_FILE = 25 * 1024 * 1024;
const MAX_BUFFER = 64 * 1024 * 1024;
const MAX_PACKET = 64 * 1024;
const CHUNK = 48 * 1024;
const TRANSFER_TIMEOUT = 20_000;
const PRESENCE_TIMEOUT = 35_000;
const MAX_CONTROL = 24 * 1024;
const MAX_PEERS = 128;
const HEADER_LENGTH = 94; // version, raw P-256 key, sequence, time, 96-bit nonce
const errorOf = code => Object.assign(new Error(code), { code });
const validId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(value);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const timer = (callback, delay) => { const value = setTimeout(callback, delay); value.unref?.(); return value; };
const interval = (callback, delay) => { const value = setInterval(callback, delay); value.unref?.(); return value; };
const concat = (...parts) => {
  const result = new Uint8Array(parts.reduce((size, part) => size + part.byteLength, 0));
  let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.byteLength; }
  return result;
};
const binary = value => value instanceof ArrayBuffer ? new Uint8Array(value)
  : ArrayBuffer.isView(value) ? new Uint8Array(value.buffer, value.byteOffset, value.byteLength) : null;
const base64 = bytes => {
  let value = '';
  for (let offset = 0; offset < bytes.length; offset += 4096) value += String.fromCharCode(...bytes.subarray(offset, offset + 4096));
  return btoa(value).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};
const unbase64 = value => {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]+$/.test(value)) throw errorOf('invalid_packet');
  const decoded = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(decoded, char => char.charCodeAt(0));
};
const hash = async bytes => new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
const textField = value => {
  const bytes = encoder.encode(value);
  if (bytes.length > 65535) throw errorOf('invalid_packet');
  return concat(new Uint8Array([bytes.length >>> 8, bytes.length & 255]), bytes);
};

/** MQTT framing is independent of WebSocket message boundaries. */
export function encodeMqttPacket(header, body = new Uint8Array()) {
  if (body.length > MAX_PACKET) throw errorOf('packet_too_large');
  const length = [];
  let remaining = body.length;
  do {
    let digit = remaining % 128;
    remaining = Math.floor(remaining / 128);
    if (remaining) digit |= 128;
    length.push(digit);
  } while (remaining);
  return concat(new Uint8Array([header, ...length]), body);
}

export function createMqttDecoder(onPacket, maxPacket = MAX_PACKET) {
  let pending = new Uint8Array();
  return {
    push(value) {
      const bytes = binary(value);
      if (!bytes) throw errorOf('invalid_packet');
      // A WebSocket frame may contain many complete MQTT packets. Only the
      // unfinished suffix is retained between calls, with an explicit bound.
      let input = pending.length ? concat(pending, bytes) : bytes;
      pending = new Uint8Array();
      let offset = 0;
      while (offset < input.length) {
        const start = offset;
        if (input.length - offset < 2) { pending = input.slice(offset); break; }
        const header = input[offset++];
        let length = 0, multiplier = 1, digits = 0, complete = false;
        while (offset < input.length && digits < 4) {
          const digit = input[offset++];
          length += (digit & 127) * multiplier;
          digits++;
          if (!(digit & 128)) { complete = true; break; }
          multiplier *= 128;
        }
        if (length > maxPacket || (!complete && digits === 4)) throw errorOf('packet_too_large');
        if (!complete || input.length - offset < length) { pending = input.slice(start); break; }
        onPacket({ header, body: input.subarray(offset, offset + length) });
        offset += length;
      }
      if (pending.length > maxPacket + 5) throw errorOf('packet_too_large');
    },
    reset() { pending = new Uint8Array(); },
  };
}

function packControl(control, bytes = new Uint8Array()) {
  const json = encoder.encode(JSON.stringify(control));
  if (json.length > MAX_CONTROL || bytes.length > CHUNK || json.length + bytes.length + 4 > MAX_PACKET - 256) throw errorOf('invalid_packet');
  const prefix = new Uint8Array(4);
  new DataView(prefix.buffer).setUint32(0, json.length);
  return concat(prefix, json, bytes);
}

function unpackControl(bytes) {
  if (bytes.length < 6) throw errorOf('invalid_packet');
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(0);
  if (length > MAX_CONTROL || length > bytes.length - 4 || bytes.length - 4 - length > CHUNK) throw errorOf('invalid_packet');
  const control = JSON.parse(decoder.decode(bytes.subarray(4, 4 + length)));
  if (!object(control) || typeof control.t !== 'string') throw errorOf('invalid_packet');
  return { control, bytes: bytes.subarray(4 + length) };
}

function connectBroker({ url, topic, publishReceived, onReady, onUnavailable, webSocketFactory, isClosed }) {
  let socket, subscribed = false, stopped = false, attempts = 0;
  let retryTimer, connectTimer, pingTimer;
  let generation = 0, lastResponse = 0, queuedBytes = 0;
  let inputTail = Promise.resolve();
  const topicBytes = textField(topic);
  const stopTimers = () => { clearTimeout(connectTimer); clearInterval(pingTimer); };
  const disconnected = (current, retry = true) => {
    if (current !== generation) return;
    generation++;
    stopTimers();
    const wasReady = subscribed;
    subscribed = false;
    try { socket?.close(); } catch { /* Already closed. */ }
    socket = null;
    if (wasReady) onUnavailable();
    if (retry && !stopped && !isClosed()) {
      const delay = Math.min(15_000, 1000 * 2 ** Math.min(attempts++, 4)) + Math.floor(Math.random() * 250);
      retryTimer = timer(open, delay);
    }
  };
  const open = () => {
    if (stopped || isClosed()) return;
    const current = ++generation;
    let connection;
    try {
      connection = webSocketFactory(url, ['mqtt']);
      socket = connection;
      connection.binaryType = 'arraybuffer';
    } catch { disconnected(current); return; }
    const send = bytes => {
      if (current !== generation || connection.readyState !== 1) throw errorOf('offline');
      connection.send(bytes);
    };
    const parser = createMqttDecoder(({ header, body }) => {
      lastResponse = Date.now();
      const type = header >>> 4;
      if (type === 2) {
        if (header !== 0x20 || body.length !== 2 || body[1] !== 0 || body[0] !== 0) throw errorOf('relay_rejected');
        send(encodeMqttPacket(0x82, concat(new Uint8Array([0, 1]), topicBytes, new Uint8Array([0]))));
      } else if (type === 9) {
        if (header !== 0x90 || body.length !== 3 || body[0] !== 0 || body[1] !== 1 || body[2] > 2) throw errorOf('relay_rejected');
        if (!subscribed) {
          subscribed = true;
          attempts = 0;
          clearTimeout(connectTimer);
          onReady();
          pingTimer = interval(() => {
            if (Date.now() - lastResponse > 40_000) { disconnected(current); return; }
            try { send(encodeMqttPacket(0xc0)); } catch { disconnected(current); }
          }, 15_000);
        }
      } else if (type === 3 && subscribed) {
        if (body.length < 2 || (header & 1)) return; // Never accept retained room history.
        const length = (body[0] << 8) | body[1];
        const qos = (header >>> 1) & 3;
        if (qos > 1 || body.length < 2 + length + (qos ? 2 : 0)) throw errorOf('invalid_packet');
        if (decoder.decode(body.subarray(2, 2 + length)) !== topic) return;
        let offset = 2 + length;
        if (qos === 1) { send(encodeMqttPacket(0x40, body.subarray(offset, offset + 2))); offset += 2; }
        publishReceived(body.subarray(offset));
      } else if (type !== 13) {
        // PUBACKs are harmless, other unsolicited protocol packets are ignored.
      }
    });
    connection.onopen = () => {
      if (current !== generation) return;
      lastResponse = Date.now();
      const clientId = `ct-${base64(crypto.getRandomValues(new Uint8Array(12)))}`;
      try {
        send(encodeMqttPacket(0x10, concat(textField('MQTT'), new Uint8Array([4, 2, 0, 30]), textField(clientId))));
      } catch { disconnected(current); }
    };
    connection.onmessage = event => {
      const size = event.data?.byteLength ?? event.data?.size ?? 0;
      if (typeof event.data === 'string' || !Number.isSafeInteger(size) || size > 2 * 1024 * 1024 || queuedBytes + size > 2 * 1024 * 1024) { disconnected(current); return; }
      queuedBytes += size;
      inputTail = inputTail.then(async () => {
        try {
          if (current !== generation) return;
          const data = event.data instanceof Blob ? await event.data.arrayBuffer() : event.data;
          if (current === generation) parser.push(data);
        } catch { disconnected(current); }
        finally { queuedBytes -= size; }
      });
    };
    connection.onerror = () => disconnected(current);
    connection.onclose = () => disconnected(current);
    connectTimer = timer(() => disconnected(current), 8000);
  };
  open();
  return {
    get ready() { return subscribed && socket?.readyState === 1; },
    async publish(payload, signal, deadline = Date.now() + TRANSFER_TIMEOUT) {
      const current = generation;
      if (signal?.aborted) throw errorOf('aborted');
      if (!subscribed || !socket || socket.readyState !== 1 || current !== generation) throw errorOf('offline');
      if (Date.now() > deadline) throw errorOf('transfer_timeout');
      // A congested optional broker must not stall the healthy one or retain
      // another whole file in pending per-broker publish promises.
      if (socket.bufferedAmount > 512 * 1024) throw errorOf('relay_busy');
      socket.send(encodeMqttPacket(0x30, concat(topicBytes, payload)));
    },
    close() {
      stopped = true;
      clearTimeout(retryTimer);
      stopTimers();
      generation++;
      subscribed = false;
      try { if (socket?.readyState === 1) socket.send(encodeMqttPacket(0xe0)); } catch { /* Best effort. */ }
      try { socket?.close(); } catch { /* Already closed. */ }
      socket = null;
    },
  };
}

/** Native MQTT-over-WSS; no accounts, durable messages, or plaintext room data. */
export async function createRelayTransport({
  appId, roomId: configuredRoomId, password, maxReceiveBytes = MAX_FILE, onStatus = () => {},
  brokers = RELAY_BROKERS, webSocketFactory = (url, protocols) => new WebSocket(url, protocols),
} = {}, invitedRoomId) {
  const roomId = configuredRoomId ?? invitedRoomId;
  if (![appId, roomId, password].every(value => typeof value === 'string' && value.length > 0 && value.length <= 256)
    || !Number.isSafeInteger(maxReceiveBytes) || maxReceiveBytes < 1 || maxReceiveBytes > MAX_FILE
    || !Array.isArray(brokers) || brokers.length < 1 || brokers.length > 4 || brokers.some(url => typeof url !== 'string' || !url.startsWith('wss://'))) throw errorOf('invalid_invite');
  const context = encoder.encode(JSON.stringify(['chattamento-relay-v1', appId, roomId, password]));
  const scopeBytes = await hash(concat(encoder.encode('topic:'), context));
  const scope = base64(scopeBytes);
  const topic = `chattamento/v1/${scope}`;
  const key = await crypto.subtle.importKey('raw', await hash(concat(encoder.encode('encryption:'), context)), 'AES-GCM', false, ['encrypt', 'decrypt']);
  const identity = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign', 'verify']);
  const publicBytes = new Uint8Array(await crypto.subtle.exportKey('raw', identity.publicKey));
  const selfId = base64(await hash(publicBytes));
  const peers = new Map(), actions = new Map(), replay = new Map(), publicKeys = new Map();
  const incoming = new Map(), approvals = new Map(), outgoing = new Map(), completed = new Map();
  let sequence = 0, closed = false, closing = false, leaving, receivedTail = Promise.resolve(), queuedEncrypted = 0, queuedPackets = 0, pendingControls = 0;
  let reservedBytes = 0, receiveReserved = 0, reservedSlots = 0, joinHandler = null, leaveHandler = null;
  let currentStatus = 'connecting', connectionHandler = null, initialTimer, presenceTimer;
  let resolveReady, rejectReady;
  const readyPromise = new Promise((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const connections = [];
  const status = value => {
    if (value === currentStatus && value !== 'connecting') return;
    currentStatus = value;
    try { onStatus(value); } catch { /* Consumer errors cannot break transport. */ }
    try { connectionHandler?.(value === 'connected' ? 'waiting' : 'offline'); } catch { /* Isolate consumer callbacks. */ }
  };
  const notify = (handler, peerId) => { try { handler?.(peerId); } catch { /* Isolate consumer callbacks. */ } };
  const failOutgoing = (record, reason) => {
    if (record.error) return;
    record.error = errorOf(reason);
    record.controller.abort();
    for (const waiter of record.waiters.values()) waiter(record.error);
    record.waiters.clear();
  };
  const removeIncoming = record => {
    if (incoming.get(record.key) !== record) return;
    incoming.delete(record.key);
    receiveReserved -= record.size;
    clearTimeout(record.timer);
    record.controller.abort();
    record.data = null;
  };
  const removePeer = peerId => {
    if (!peers.delete(peerId)) return;
    for (const record of [...incoming.values()]) if (record.peerId === peerId) removeIncoming(record);
    for (const record of outgoing.values()) if (record.target === peerId) failOutgoing(record, 'offline');
    for (const record of approvals.values()) if (record.peerId === peerId) record.controller.abort();
    notify(leaveHandler, peerId);
  };
  const touchPeer = peerId => {
    if (closed || closing || peerId === selfId) return false;
    const existing = peers.get(peerId);
    if (existing) { existing.lastSeen = Date.now(); return false; }
    if (peers.size >= MAX_PEERS) return false;
    peers.set(peerId, { lastSeen: Date.now() });
    notify(joinHandler, peerId);
    return true;
  };
  const encodePacket = async (control, bytes) => {
    if (closed || (closing && control.t !== 'leave')) throw errorOf('offline');
    const header = new Uint8Array(HEADER_LENGTH);
    header[0] = 1;
    header.set(publicBytes, 1);
    const view = new DataView(header.buffer);
    view.setBigUint64(66, BigInt(++sequence));
    view.setBigUint64(74, BigInt(Date.now()));
    header.set(crypto.getRandomValues(new Uint8Array(12)), 82);
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: header.subarray(82), additionalData: concat(scopeBytes, header) }, key, packControl(control, bytes)));
    const signed = concat(header, encrypted);
    const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.privateKey, concat(scopeBytes, signed)));
    return concat(signed, signature);
  };
  const publish = async (control, bytes, signal, deadline) => {
    if (closed || (closing && control.t !== 'leave')) throw errorOf('offline');
    if (signal?.aborted) throw errorOf('aborted');
    const packet = await encodePacket(control, bytes);
    if (closed || (closing && control.t !== 'leave')) throw errorOf('offline');
    if (signal?.aborted) throw errorOf('aborted');
    const limit = deadline ?? Date.now() + TRANSFER_TIMEOUT;
    while (true) {
      if (signal?.aborted) throw errorOf('aborted');
      if (closed || (closing && control.t !== 'leave')) throw errorOf('offline');
      const available = connections.filter(connection => connection.ready);
      if (!available.length) throw errorOf('offline');
      const results = await Promise.allSettled(available.map(connection => connection.publish(packet, signal, limit)));
      if (results.some(result => result.status === 'fulfilled')) return;
      if (!results.some(result => result.status === 'rejected' && result.reason?.code === 'relay_busy')) throw errorOf(signal?.aborted ? 'aborted' : 'offline');
      if (Date.now() >= limit) throw errorOf('transfer_timeout');
      await new Promise(resolve => timer(resolve, 10));
    }
  };
  const safePublish = (control, bytes) => {
    if (closed || closing || pendingControls >= 128) return;
    pendingControls++;
    void publish(control, bytes).catch(() => {}).finally(() => { pendingControls--; });
  };
  const receipt = (target, id, phase, extra = {}) => safePublish({ t: 'receipt', target, id, phase, ...extra });
  const transferKey = (peerId, id) => `${peerId}:${id}`;
  const validTransferId = value => typeof value === 'string' && /^[a-zA-Z0-9_-]{16,80}$/.test(value);
  const validOffer = control => validTransferId(control.id) && validId(control.action)
    && ['binary', 'json'].includes(control.kind) && Number.isSafeInteger(control.size) && control.size >= 0 && control.size <= maxReceiveBytes
    && control.chunkSize === CHUNK && control.count === Math.max(1, Math.ceil(control.size / CHUNK));

  const acceptOffer = async (control, peerId) => {
    const recordKey = transferKey(peerId, control.id);
    if (completed.has(recordKey)) { receipt(peerId, control.id, 'done'); return; }
    const previous = incoming.get(recordKey);
    if (previous) {
      if (previous.action !== control.action || previous.size !== control.size || previous.kind !== control.kind) return;
      receipt(peerId, control.id, 'ready'); return;
    }
    if (approvals.has(recordKey)) return;
    const action = actions.get(control.action);
    if (!validOffer(control) || !action || approvals.size >= 32 || incoming.size >= 16 || receiveReserved + reservedBytes + control.size > MAX_BUFFER) {
      receipt(peerId, control.id, 'reject', { reason: 'receive_rejected' }); return;
    }
    const controller = new AbortController();
    const approval = { peerId, controller };
    approvals.set(recordKey, approval);
    const timeout = timer(() => controller.abort(), TRANSFER_TIMEOUT);
    const context = { peerId, metadata: control.metadata, byteLength: control.size, kind: 'message', signal: controller.signal };
    try {
      const accepted = action.onReceive ? await Promise.race([
        Promise.resolve().then(() => action.onReceive(context)),
        new Promise(resolve => controller.signal.addEventListener('abort', () => resolve(false), { once: true })),
      ]) : true;
      if (!accepted || closed || controller.signal.aborted || !peers.has(peerId)
        || incoming.size >= 16 || receiveReserved + reservedBytes + control.size > MAX_BUFFER) {
        receipt(peerId, control.id, 'reject', { reason: 'receive_rejected' }); return;
      }
      // The application has approved sender, size and metadata before this allocation.
      const record = {
        key: recordKey, id: control.id, peerId, action: control.action, kind: control.kind,
        size: control.size, count: control.count, metadata: control.metadata, context, controller,
        data: new Uint8Array(control.size), chunks: new Uint8Array(control.count), received: 0,
      };
      receiveReserved += record.size;
      incoming.set(recordKey, record);
      record.timer = timer(() => { removeIncoming(record); receipt(peerId, control.id, 'reject', { reason: 'transfer_timeout' }); }, TRANSFER_TIMEOUT);
      receipt(peerId, control.id, 'ready');
    } catch { receipt(peerId, control.id, 'reject', { reason: 'receive_rejected' }); }
    finally { clearTimeout(timeout); if (approvals.get(recordKey) === approval) approvals.delete(recordKey); }
  };
  const deliver = async record => {
    const action = actions.get(record.action);
    let data = record.data;
    // Keep the reservation until application delivery has finished. Cancellation
    // aborts the same context signal supplied to onReceive and onMessage.
    try {
      if (record.kind === 'json') data = JSON.parse(decoder.decode(data));
      if (closed || record.controller.signal.aborted || !peers.has(record.peerId) || !action) return;
      await action.onMessage?.(data, record.context);
      if (closed || record.controller.signal.aborted || !peers.has(record.peerId)) return;
      completed.set(record.key, Date.now());
      if (completed.size > 2048) completed.delete(completed.keys().next().value);
      receipt(record.peerId, record.id, 'done');
    } catch { receipt(record.peerId, record.id, 'reject', { reason: 'receive_failed' }); }
    finally { removeIncoming(record); }
  };
  const processControl = (control, bytes, peerId) => {
    if (control.target !== undefined && control.target !== selfId) return;
    if (control.t === 'leave') { removePeer(peerId); return; }
    // Identity discovery requires an authenticated presence packet. An action
    // cannot fabricate a join before the sender's explicit room announcement.
    const joined = control.t === 'hello' ? touchPeer(peerId) : false;
    if (!peers.has(peerId)) return;
    peers.get(peerId).lastSeen = Date.now();
    if (joined) safePublish({ t: 'hello', target: peerId });
    if (control.t === 'hello') return;
    if (!validTransferId(control.id)) return;
    if (control.t === 'offer') { void acceptOffer(control, peerId); return; }
    if (control.t === 'receipt') {
      const record = outgoing.get(control.id);
      if (!record || record.target !== peerId) return;
      if (control.phase === 'reject') { failOutgoing(record, ['receive_rejected', 'receive_failed', 'transfer_timeout'].includes(control.reason) ? control.reason : 'receive_rejected'); return; }
      const receiptKey = control.phase === 'chunk' && Number.isSafeInteger(control.index) ? `chunk:${control.index}` : control.phase;
      if (!['ready', 'done'].includes(receiptKey) && !(typeof receiptKey === 'string' && /^chunk:\d+$/.test(receiptKey) && control.index < record.count)) return;
      record.receipts.add(receiptKey);
      record.waiters.get(receiptKey)?.();
      record.waiters.delete(receiptKey);
      return;
    }
    const recordKey = transferKey(peerId, control.id);
    const record = incoming.get(recordKey);
    if (control.t === 'cancel') {
      if (record) removeIncoming(record);
      approvals.get(recordKey)?.controller.abort();
      return;
    }
    if (control.t === 'chunk') {
      if (completed.has(recordKey)) { receipt(peerId, control.id, 'done'); return; }
      if (!record || !Number.isSafeInteger(control.index) || control.index < 0 || control.index >= record.count) return;
      const offset = control.index * CHUNK;
      const expected = Math.min(CHUNK, record.size - offset);
      if (bytes.length !== expected) return;
      if (!record.chunks[control.index]) {
        record.data.set(bytes, offset);
        record.chunks[control.index] = 1;
        record.received++;
      }
      receipt(peerId, control.id, 'chunk', { index: control.index });
      if (record.received === record.count && !record.delivering) { record.delivering = true; void deliver(record); }
    }
  };
  const decodePacket = async packet => {
    if (closed || packet.length < HEADER_LENGTH + 16 + 6 + 64 || packet.length > MAX_PACKET - 256 || packet[0] !== 1) return;
    const header = packet.subarray(0, HEADER_LENGTH);
    const rawKey = header.subarray(1, 66);
    const peerId = base64(await hash(rawKey));
    if (peerId === selfId) return;
    const view = new DataView(header.buffer, header.byteOffset, header.byteLength);
    const seq = Number(view.getBigUint64(66));
    const sentAt = Number(view.getBigUint64(74));
    if (!Number.isSafeInteger(seq) || seq < 1 || !Number.isSafeInteger(sentAt) || Math.abs(Date.now() - sentAt) > 60_000) return;
    const previous = replay.get(peerId);
    if (previous && (seq <= previous.max - 4096 || previous.seen.has(seq))) return;
    let publicKey = publicKeys.get(peerId);
    if (!publicKey) publicKey = await crypto.subtle.importKey('raw', rawKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const signed = packet.subarray(0, -64);
    if (!await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, publicKey, packet.subarray(-64), concat(scopeBytes, signed))) return;
    const plaintext = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: header.subarray(82), additionalData: concat(scopeBytes, header) }, key, packet.subarray(HEADER_LENGTH, -64)));
    const decoded = unpackControl(plaintext);
    if (!publicKeys.has(peerId)) {
      if (publicKeys.size >= 256) publicKeys.delete(publicKeys.keys().next().value);
      publicKeys.set(peerId, publicKey);
    }
    let state = replay.get(peerId);
    if (!state) {
      // Never evict a live replay window to admit another identity. Expiration
      // exceeds packet clock tolerance, so an expired packet cannot return.
      if (replay.size >= 256) return;
      replay.set(peerId, state = { max: 0, seen: new Set(), lastSeen: 0 });
    }
    state.max = Math.max(state.max, seq);
    state.seen.add(seq);
    state.lastSeen = Date.now();
    for (const seenSequence of state.seen) if (seenSequence <= state.max - 4096) state.seen.delete(seenSequence);
    processControl(decoded.control, decoded.bytes, peerId);
  };
  const receive = payload => {
    if (closed || closing || payload.length < HEADER_LENGTH + 16 + 6 + 64 || payload.length > MAX_PACKET || payload[0] !== 1
      || queuedPackets >= 256 || queuedEncrypted + payload.length > 2 * 1024 * 1024) return;
    const packet = payload.slice();
    queuedEncrypted += packet.length;
    queuedPackets++;
    receivedTail = receivedTail.then(() => decodePacket(packet)).catch(() => {}).finally(() => { queuedEncrypted -= packet.length; queuedPackets--; });
  };

  const waitForReceipt = (record, receiptKey, milliseconds) => new Promise((resolve, reject) => {
    if (record.error) { reject(record.error); return; }
    if (record.receipts.has(receiptKey)) { resolve(true); return; }
    let timeout;
    const complete = error => {
      clearTimeout(timeout);
      if (record.waiters.get(receiptKey) === complete) record.waiters.delete(receiptKey);
      if (error) reject(error); else resolve(record.receipts.has(receiptKey));
    };
    record.waiters.set(receiptKey, complete);
    timeout = timer(() => complete(), milliseconds);
  });
  const requestReceipt = async (record, control, bytes, receiptKey) => {
    for (let attempt = 0; attempt < 4; attempt++) {
      if (record.error) throw record.error;
      if (record.controller.signal.aborted) throw errorOf('aborted');
      if (Date.now() >= record.deadline) throw errorOf('transfer_timeout');
      if (record.receipts.has(receiptKey) || record.receipts.has('done')) return;
      await publish(control, bytes, record.controller.signal, record.deadline);
      if (await waitForReceipt(record, receiptKey, Math.min(1500, record.deadline - Date.now()))) return;
    }
    throw errorOf('transfer_timeout');
  };
  const sendTo = async (action, bytes, kind, metadata, target, signal) => {
    const id = base64(crypto.getRandomValues(new Uint8Array(18)));
    const count = Math.max(1, Math.ceil(bytes.length / CHUNK));
    const record = { id, target, count, deadline: Date.now() + TRANSFER_TIMEOUT, controller: new AbortController(), receipts: new Set(), waiters: new Map(), error: null };
    const abort = () => failOutgoing(record, 'aborted');
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    outgoing.set(id, record);
    const timeout = timer(() => failOutgoing(record, 'transfer_timeout'), TRANSFER_TIMEOUT);
    try {
      await requestReceipt(record, { t: 'offer', target, id, action, kind, size: bytes.length, metadata, chunkSize: CHUNK, count }, undefined, 'ready');
      // Small windows limit memory and WebSocket buffering and make abort stop
      // subsequent chunks, rather than queueing an entire file in the socket.
      for (let start = 0; start < count; start += 16) {
        await Promise.all(Array.from({ length: Math.min(16, count - start) }, (_, offset) => {
          const index = start + offset;
          return requestReceipt(record, { t: 'chunk', target, id, index }, bytes.subarray(index * CHUNK, Math.min(bytes.length, (index + 1) * CHUNK)), `chunk:${index}`);
        }));
      }
      // Repeating the last chunk also recovers a lost final delivery receipt.
      await requestReceipt(record, { t: 'chunk', target, id, index: count - 1 }, bytes.subarray((count - 1) * CHUNK), 'done');
    } catch (error) {
      failOutgoing(record, error?.code || 'transfer_failed');
      safePublish({ t: 'cancel', target, id });
      throw record.error;
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener('abort', abort);
      outgoing.delete(id);
      for (const waiter of record.waiters.values()) waiter(record.error || errorOf('aborted'));
      record.waiters.clear();
    }
  };
  const send = async (action, data, options = {}) => {
    if (closed || closing || !connections.some(connection => connection.ready)) throw errorOf('offline');
    if (!object(options) || (options.signal && typeof options.signal.addEventListener !== 'function')) throw errorOf('invalid_request');
    if (options.signal?.aborted) throw errorOf('aborted');
    const targets = options.target === undefined ? [...peers.keys()] : Array.isArray(options.target) ? [...new Set(options.target)] : [options.target];
    if (targets.some(target => !validId(target) || target === selfId || !peers.has(target))) throw errorOf('offline');
    if (!targets.length) return;
    if (reservedSlots + targets.length > 16) throw errorOf('transfer_busy');
    const metadataJson = JSON.stringify(options.metadata ?? null);
    if (encoder.encode(metadataJson).length > MAX_CONTROL - 2048) throw errorOf('invalid_request');
    const metadata = JSON.parse(metadataJson);
    let bytes, size, kind;
    const isBlob = data instanceof Blob;
    const original = binary(data);
    if (isBlob || original) { size = isBlob ? data.size : original.length; kind = 'binary'; }
    else {
      const json = JSON.stringify(data);
      if (json === undefined) throw errorOf('invalid_request');
      bytes = encoder.encode(json); size = bytes.length; kind = 'json';
    }
    if (size > maxReceiveBytes) throw errorOf('file_too_large');
    if (reservedBytes + receiveReserved + size > MAX_BUFFER) throw errorOf('transfer_busy');
    reservedBytes += size;
    reservedSlots += targets.length;
    try {
      if (isBlob) bytes = new Uint8Array(await data.arrayBuffer());
      else if (original) bytes = original.slice();
      if (bytes.length !== size) throw errorOf('invalid_request');
      if (options.signal?.aborted) throw errorOf('aborted');
      if (closed || closing || !connections.some(connection => connection.ready) || targets.some(target => !peers.has(target))) throw errorOf('offline');
      // A shared byte buffer is reused for all recipients; each transfer has its
      // own approval and receipt state and remains bound to its signed sender.
      const results = await Promise.allSettled(targets.map(target => sendTo(action, bytes, kind, metadata, target, options.signal)));
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
    } finally { reservedBytes -= size; reservedSlots -= targets.length; }
  };

  const validFingerprints = value => Array.isArray(value) && value.length > 0 && value.length <= 8
    && value.every(item => typeof item === 'string' && /^sha-256 (?:[0-9A-F]{2}:){31}[0-9A-F]{2}$/iu.test(item))
    && new Set(value).size === value.length;
  const bindingFields = proof => ({ v: proof.v, purpose: proof.purpose, scope: proof.scope, relayId: proof.relayId, rtcId: proof.rtcId,
    peerRtcId: proof.peerRtcId, localFingerprints: proof.localFingerprints, remoteFingerprints: proof.remoteFingerprints,
    issuedAt: proof.issuedAt, nonce: proof.nonce, publicKey: proof.publicKey });
  const createMediaBinding = async (rtcId, {
    nonce = base64(crypto.getRandomValues(new Uint8Array(24))), peerRtcId, localFingerprints, remoteFingerprints,
  } = {}) => {
    if (closed || closing) throw errorOf('offline');
    if (!validId(rtcId) || !validId(peerRtcId) || typeof nonce !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(nonce)
      || !validFingerprints(localFingerprints) || !validFingerprints(remoteFingerprints)) throw errorOf('invalid_request');
    const proof = { v: 1, purpose: 'chattamento-media-binding-v1', scope, relayId: selfId, rtcId, peerRtcId,
      localFingerprints: [...localFingerprints].sort(), remoteFingerprints: [...remoteFingerprints].sort(),
      issuedAt: Date.now(), nonce, publicKey: base64(publicBytes) };
    const signature = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, identity.privateKey, encoder.encode(JSON.stringify(bindingFields(proof))));
    return { ...proof, signature: base64(new Uint8Array(signature)) };
  };
  const verifyMediaBinding = async (proof, expectedRtcId) => {
    try {
      if (!object(proof) || proof.v !== 1 || proof.purpose !== 'chattamento-media-binding-v1' || proof.scope !== scope
        || !validId(proof.relayId) || !validId(expectedRtcId) || proof.rtcId !== expectedRtcId
        || !validId(proof.peerRtcId) || !validFingerprints(proof.localFingerprints) || !validFingerprints(proof.remoteFingerprints)
        || !Number.isSafeInteger(proof.issuedAt) || Math.abs(Date.now() - proof.issuedAt) > 5 * 60_000
        || typeof proof.nonce !== 'string' || !/^[a-zA-Z0-9_-]{16,128}$/.test(proof.nonce)
        || typeof proof.publicKey !== 'string' || proof.publicKey.length !== 87 || typeof proof.signature !== 'string' || proof.signature.length !== 86) return null;
      const rawKey = unbase64(proof.publicKey);
      if (base64(await hash(rawKey)) !== proof.relayId) return null;
      const pub = await crypto.subtle.importKey('raw', rawKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      return await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, pub, unbase64(proof.signature), encoder.encode(JSON.stringify(bindingFields(proof)))) ? proof.relayId : null;
    } catch { return null; }
  };
  const room = {
    selfId,
    makeAction(name, initial = {}) {
      if (!validId(name)) throw errorOf('invalid_request');
      if (!actions.has(name)) actions.set(name, { ...initial, send: (data, options) => send(name, data, options) });
      return actions.get(name);
    },
    getPeers() { return Object.fromEntries([...peers.keys()].map(peerId => [peerId, {}])); },
    set onPeerJoin(handler) {
      joinHandler = typeof handler === 'function' ? handler : null;
      if (joinHandler) for (const peerId of peers.keys()) queueMicrotask(() => { if (joinHandler === handler && peers.has(peerId) && !closed) notify(handler, peerId); });
    },
    get onPeerJoin() { return joinHandler; },
    set onPeerLeave(handler) { leaveHandler = typeof handler === 'function' ? handler : null; },
    get onPeerLeave() { return leaveHandler; },
    set onConnectionState(handler) {
      connectionHandler = typeof handler === 'function' ? handler : null;
      if (connectionHandler) queueMicrotask(() => {
        if (connectionHandler === handler && !closed) {
          try { handler(connections.some(connection => connection.ready) ? 'waiting' : 'offline'); } catch { /* Consumer callback. */ }
        }
      });
    },
    get onConnectionState() { return connectionHandler; },
    createMediaBinding, verifyMediaBinding,
    async leave() {
      if (closed) return;
      if (closing) return leaving;
      closing = true;
      // Revocation is synchronous: no pending file/approval may outlive leave,
      // including when a congested socket cannot send the departure packet.
      clearTimeout(initialTimer); clearInterval(presenceTimer);
      for (const record of outgoing.values()) failOutgoing(record, 'offline');
      for (const record of [...incoming.values()]) removeIncoming(record);
      for (const record of approvals.values()) record.controller.abort();
      approvals.clear(); peers.clear(); replay.clear(); publicKeys.clear(); completed.clear();
      joinHandler = null; leaveHandler = null;
      for (const action of actions.values()) { action.onMessage = null; action.onReceive = null; }
      actions.clear();
      status('offline');
      connectionHandler = null;
      leaving = (async () => {
        try { await Promise.race([publish({ t: 'leave' }), new Promise(resolve => timer(resolve, 250))]); } catch { /* Heartbeat expiry covers abrupt loss. */ }
        closed = true;
        for (const connection of connections) connection.close();
      })();
      return leaving;
    },
  };
  status('connecting');
  for (const url of brokers) connections.push(connectBroker({
    url, topic, webSocketFactory, isClosed: () => closed || closing, publishReceived: receive,
    onReady() {
      if (closed || closing) return;
      clearTimeout(initialTimer);
      status('connected');
      resolveReady();
      safePublish({ t: 'hello' });
    },
    onUnavailable() {
      if (!closed && !closing && !connections.some(connection => connection.ready)) {
        status('offline');
        for (const peerId of [...peers.keys()]) removePeer(peerId);
      }
    },
  }));
  presenceTimer = interval(() => {
    if (closed) return;
    if (connections.some(connection => connection.ready)) safePublish({ t: 'hello' });
    const now = Date.now();
    for (const [peerId, peer] of peers) if (now - peer.lastSeen > PRESENCE_TIMEOUT) removePeer(peerId);
    for (const [id, completedAt] of completed) if (now - completedAt > 60_000) completed.delete(id);
    for (const [id, state] of replay) if (now - state.lastSeen > 2 * 60_000) { replay.delete(id); publicKeys.delete(id); }
  }, 10_000);
  initialTimer = timer(() => rejectReady(errorOf('connection_failed')), 12_000);
  try { await readyPromise; }
  catch (error) { await room.leave(); throw error; }
  return { selfId, room, createMediaBinding, verifyMediaBinding };
}
