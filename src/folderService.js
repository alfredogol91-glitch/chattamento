const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_CONTROL_BYTES = 4096;
const MAX_LIST_BYTES = 256 * 1024;
const MAX_ENTRIES = 1000;
const MAX_PENDING = 16;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const opaque = value => typeof value === 'string' && UUID.test(value);
const nameOf = value => typeof value === 'string'
  ? value.split(/[\\/]/u).pop().normalize('NFC').replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/gu, '').slice(0, 200)
  : '';
const errorOf = code => Object.assign(new Error(code), { code });
const keyOf = (ownerId, shareId) => `${ownerId}:${shareId}`;
const generationKey = (ownerId, shareId, generation) => `${ownerId}:${shareId}:${generation}`;
const ERROR_CODES = new Set(['folder_not_shared', 'folder_revoked', 'folder_unavailable', 'folder_permission_denied', 'folder_not_found', 'folder_too_large', 'folder_file_unavailable', 'file_too_large', 'invalid_request', 'folder_request_timeout', 'rate_limited', 'folder_busy']);
const benignError = error => ['NotAllowedError', 'SecurityError'].includes(error?.name) ? 'folder_permission_denied'
  : ERROR_CODES.has(error?.code) ? error.code : 'folder_file_unavailable';
const binaryOf = data => data instanceof ArrayBuffer ? new Uint8Array(data)
  : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
const validBinding = data => object(data) && opaque(data.id) && opaque(data.shareId) && opaque(data.generation)
  && ['list', 'download'].includes(data.op) && (opaque(data.nodeId) || (data.op === 'list' && data.nodeId === 'root'));
const matching = (a, b) => validBinding(a) && validBinding(b)
  && ['id', 'shareId', 'generation', 'op', 'nodeId'].every(key => a[key] === b[key]);
const bindingOf = data => ({ id: data.id, shareId: data.shareId, generation: data.generation, op: data.op, nodeId: data.nodeId });

function validListing(value, expectedId) {
  if (!object(value) || value.id !== expectedId || typeof value.name !== 'string' || !value.name || value.name.length > 255
    || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) throw errorOf('folder_too_large');
  const used = new Set();
  const entries = value.entries.map(entry => {
    if (!object(entry) || !opaque(entry.id) || used.has(entry.id) || typeof entry.name !== 'string' || !entry.name || entry.name.length > 255
      || !['file', 'directory'].includes(entry.kind)) throw errorOf('invalid_request');
    used.add(entry.id);
    const item = { id: entry.id, name: nameOf(entry.name), kind: entry.kind };
    if (!item.name) throw errorOf('invalid_request');
    if (entry.size !== undefined) {
      if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw errorOf('invalid_request');
      item.size = entry.size;
    }
    if (entry.lastModified !== undefined) {
      if (!Number.isFinite(entry.lastModified) || entry.lastModified < 0 || entry.lastModified > 8.64e15) throw errorOf('invalid_request');
      item.lastModified = entry.lastModified;
    }
    return item;
  });
  return { id: value.id, name: nameOf(value.name), entries };
}

/** Folder authority exists only after shareFolder() and only for this room session. */
export function createFolderService({ room, getUser, getPeers, canPeer, emit, maxFileSize = 25 * 1024 * 1024, requestTimeoutMs = 15_000 }) {
  const local = new Map();
  const remote = new Map();
  const pending = new Map();
  const activeDownloads = new Map();
  const activeOperations = new Map();
  const urls = new Map();
  const revoked = new Set();
  const requestRates = new Map();
  const inboundCounts = new Map();
  const peerEpochs = new Map();
  let disposed = false;
  let suspended = false;
  const announceAction = room.makeAction('fs-announce');
  const requestAction = room.makeAction('fs-request');
  const responseAction = room.makeAction('fs-response');
  const downloadAction = room.makeAction('fs-download');
  const revokeAction = room.makeAction('fs-revoke');
  const actions = [announceAction, requestAction, responseAction, downloadAction, revokeAction];
  const usable = () => !disposed && !suspended && !getUser().nicknameConflict;
  const permitted = peerId => usable() && canPeer(peerId);
  const peerList = () => [...getPeers()].filter(peer => permitted(peer.id));
  const remoteDescriptors = () => [...remote.values()].filter(share => permitted(share.ownerId)).map(share => ({
    id: share.id, ownerId: share.ownerId,
    ownerNickname: [...getPeers()].find(peer => peer.id === share.ownerId)?.nickname || '', name: share.name,
  }));
  const localDescriptors = () => [...local.values()].map(share => ({ id: share.model.id, name: share.name }));
  const changed = () => { if (!disposed) emit('folders', { folders: remoteDescriptors(), local: localDescriptors() }); };
  const cancelOperation = operation => { clearTimeout(operation.timer); operation.controller.abort(); };
  const markRevoked = (ownerId, shareId, generation) => {
    revoked.add(generationKey(ownerId, shareId, generation));
    if (revoked.size > 512) revoked.delete(revoked.values().next().value);
  };
  const finishPending = (id, result, error) => {
    const operation = pending.get(id);
    if (!operation) return;
    pending.delete(id);
    clearTimeout(operation.timer);
    if (error) { operation.controller.abort(); operation.reject(errorOf(error)); }
    else operation.resolve(result);
  };
  const revokeUrls = predicate => {
    for (const [url, record] of urls) if (predicate(record)) { URL.revokeObjectURL(url); urls.delete(url); }
  };
  const removeRemote = (share, reason = 'folder_revoked') => {
    remote.delete(keyOf(share.ownerId, share.id));
    markRevoked(share.ownerId, share.id, share.generation);
    for (const [id, operation] of pending) if (operation.ownerId === share.ownerId && operation.shareId === share.id && operation.generation === share.generation) finishPending(id, null, reason);
    revokeUrls(record => record.ownerId === share.ownerId && record.shareId === share.id && record.generation === share.generation);
    emit('folder-revoked', { ownerId: share.ownerId, shareId: share.id });
  };
  const announce = target => {
    if (!usable()) return Promise.resolve();
    const targets = target ? permitted(target) ? [target] : [] : peerList().map(peer => peer.id);
    if (!targets.length) return Promise.resolve();
    return announceAction.send({ v: 1, folders: [...local.values()].map(share => ({ id: share.model.id, name: share.name, generation: share.generation })) }, { target: targets });
  };
  const activeLocal = (binding, peerId) => {
    const share = local.get(binding.shareId);
    return permitted(peerId) && share?.generation === binding.generation ? share : null;
  };
  const pendingFor = (binding, peerId) => {
    if (!permitted(peerId) || !validBinding(binding)) return null;
    const operation = pending.get(binding.id);
    const share = remote.get(keyOf(peerId, binding.shareId));
    return operation && operation.ownerId === peerId && matching(operation, binding) && share?.generation === binding.generation ? operation : null;
  };
  const sendError = (binding, peerId, error) => responseAction.send({ ...bindingOf(binding), ok: false, error }, { target: peerId, metadata: bindingOf(binding) }).catch(() => {});
  const rateAllowed = peerId => {
    const current = Date.now();
    let rate = requestRates.get(peerId);
    if (!rate || current - rate.since >= 1000) requestRates.set(peerId, rate = { since: current, count: 0 });
    return ++rate.count <= 10;
  };

  const service = {
    get sharedFolders() { return remoteDescriptors(); },
    get localSharedFolders() { return localDescriptors(); },
    async shareFolder(model) {
      if (!usable()) throw errorOf('folder_unavailable');
      if (!model || !opaque(model.id) || !nameOf(model.name) || typeof model.list !== 'function' || typeof model.getFile !== 'function' || typeof model.dispose !== 'function') throw errorOf('invalid_request');
      if (local.size && !local.has(model.id)) throw errorOf('folder_busy');
      if (local.has(model.id)) return { id: model.id, name: local.get(model.id).name };
      const record = { model, name: nameOf(model.name), generation: crypto.randomUUID() };
      local.set(model.id, record);
      changed();
      await announce().catch(() => {});
      return { id: model.id, name: record.name };
    },
    async stopSharingFolder(id) {
      const share = local.get(id);
      if (!share) return;
      local.delete(id);
      for (const [requestId, operation] of activeOperations) if (operation.shareId === id && operation.generation === share.generation) { cancelOperation(operation); activeOperations.delete(requestId); }
      for (const [peerId, download] of activeDownloads) if (download.shareId === id && download.generation === share.generation) activeDownloads.delete(peerId);
      for (const key of inboundCounts.keys()) if (key.endsWith(`:${share.generation}`)) inboundCounts.delete(key);
      try { await share.model.dispose(); } catch { /* The model is no longer reachable even if release fails. */ }
      changed();
      if (!disposed) await revokeAction.send({ shareId: id, generation: share.generation }, { target: [...getPeers()].filter(peer => canPeer(peer.id)).map(peer => peer.id) }).catch(() => {});
    },
    async browseFolder({ ownerId, shareId, nodeId = 'root' } = {}) {
      return requestRemote(ownerId, shareId, 'list', nodeId);
    },
    async downloadSharedFile({ ownerId, shareId, fileId } = {}) {
      return requestRemote(ownerId, shareId, 'download', fileId);
    },
    releaseSharedFile(url) { if (urls.has(url)) { URL.revokeObjectURL(url); urls.delete(url); } },
    async peerJoined(peerId) { if (permitted(peerId)) await announce(peerId).catch(() => {}); },
    peerLeft(peerId) {
      peerEpochs.set(peerId, (peerEpochs.get(peerId) || 0) + 1);
      for (const share of [...remote.values()]) if (share.ownerId === peerId) removeRemote(share, 'folder_unavailable');
      for (const [id, operation] of pending) if (operation.ownerId === peerId) finishPending(id, null, 'folder_unavailable');
      for (const [requestId, operation] of activeOperations) if (operation.peerId === peerId) { cancelOperation(operation); activeOperations.delete(requestId); }
      activeDownloads.delete(peerId);
      for (const key of inboundCounts.keys()) if (key.startsWith(`${peerId}:`)) inboundCounts.delete(key);
      requestRates.delete(peerId);
      changed();
    },
    profileChanged() {
      if (getUser().nicknameConflict) { service.suspend(); return; }
      for (const share of [...remote.values()]) if (!canPeer(share.ownerId)) removeRemote(share, 'folder_unavailable');
      changed();
    },
    suspend() {
      if (disposed || suspended) return;
      suspended = true;
      for (const share of [...local.values()]) service.stopSharingFolder(share.model.id).catch(() => {});
      for (const share of [...remote.values()]) removeRemote(share, 'folder_unavailable');
      for (const [id] of pending) finishPending(id, null, 'folder_unavailable');
      for (const operation of activeOperations.values()) cancelOperation(operation);
      activeOperations.clear();
      activeDownloads.clear();
      revokeUrls(() => true);
      changed();
    },
    resume() { if (!disposed) suspended = false; },
    dispose() {
      if (disposed) return;
      service.suspend();
      disposed = true;
      for (const action of actions) { action.onMessage = null; action.onReceive = null; }
      requestRates.clear(); revoked.clear(); inboundCounts.clear(); peerEpochs.clear();
    },
  };

  async function requestRemote(ownerId, shareId, op, nodeId) {
    if (!usable() || !permitted(ownerId)) throw errorOf('folder_unavailable');
    if (!opaque(shareId) || !(opaque(nodeId) || (op === 'list' && nodeId === 'root'))) throw errorOf('invalid_request');
    const share = remote.get(keyOf(ownerId, shareId));
    if (!share) throw errorOf('folder_not_shared');
    if (pending.size >= MAX_PENDING || (op === 'download' && [...pending.values()].some(operation => operation.op === 'download' && operation.ownerId === ownerId))) throw errorOf('folder_busy');
    const binding = { id: crypto.randomUUID(), shareId, generation: share.generation, op, nodeId };
    return new Promise((resolve, reject) => {
      const controller = new AbortController();
      const timer = setTimeout(() => finishPending(binding.id, null, 'folder_request_timeout'), requestTimeoutMs);
      pending.set(binding.id, { ...binding, ownerId, resolve, reject, controller, timer });
      requestAction.send(binding, { target: ownerId, metadata: binding, signal: controller.signal }).catch(() => finishPending(binding.id, null, 'folder_unavailable'));
    });
  }

  announceAction.onReceive = ({ peerId, byteLength }) => permitted(peerId) && byteLength >= 0 && byteLength <= MAX_CONTROL_BYTES;
  announceAction.onMessage = (data, { peerId } = {}) => {
    if (!permitted(peerId) || !object(data) || data.v !== 1 || !Array.isArray(data.folders) || data.folders.length > 1) return;
    const accepted = [];
    for (const folder of data.folders) {
      if (!object(folder) || !opaque(folder.id) || !opaque(folder.generation) || typeof folder.name !== 'string' || !nameOf(folder.name) || folder.name.length > 200) return;
      if (!revoked.has(generationKey(peerId, folder.id, folder.generation))) accepted.push({ id: folder.id, name: nameOf(folder.name), ownerId: peerId, generation: folder.generation });
    }
    for (const share of [...remote.values()]) if (share.ownerId === peerId && !accepted.some(next => next.id === share.id && next.generation === share.generation)) removeRemote(share);
    for (const share of accepted) remote.set(keyOf(peerId, share.id), share);
    changed();
  };
  revokeAction.onReceive = ({ peerId, byteLength }) => permitted(peerId) && byteLength >= 0 && byteLength <= MAX_CONTROL_BYTES;
  revokeAction.onMessage = (data, { peerId } = {}) => {
    if (!permitted(peerId) || !object(data) || !opaque(data.shareId) || !opaque(data.generation)) return;
    markRevoked(peerId, data.shareId, data.generation);
    const share = remote.get(keyOf(peerId, data.shareId));
    if (share?.generation === data.generation) { removeRemote(share); changed(); }
  };
  requestAction.onReceive = ({ peerId, byteLength, metadata }) => byteLength >= 0 && byteLength <= MAX_CONTROL_BYTES
    && validBinding(metadata) && !!activeLocal(metadata, peerId);
  requestAction.onMessage = async (data, { peerId, metadata } = {}) => {
    if (!validBinding(data) || !matching(data, metadata) || !activeLocal(data, peerId)) return;
    if (!rateAllowed(peerId)) { await sendError(data, peerId, 'rate_limited'); return; }
    const epoch = peerEpochs.get(peerId) || 0;
    const countKey = `${peerId}:${epoch}:${data.generation}`;
    if ((inboundCounts.get(countKey) || 0) >= 4) { await sendError(data, peerId, 'folder_busy'); return; }
    const operationKey = `${peerId}:${data.id}`;
    if (activeOperations.has(operationKey)) { await sendError(data, peerId, 'folder_busy'); return; }
    inboundCounts.set(countKey, (inboundCounts.get(countKey) || 0) + 1);
    const share = activeLocal(data, peerId);
    const deadline = Date.now() + requestTimeoutMs;
    const operation = { peerId, shareId: data.shareId, generation: data.generation, controller: new AbortController() };
    operation.timer = setTimeout(() => operation.controller.abort(), requestTimeoutMs);
    activeOperations.set(operationKey, operation);
    const isActive = () => !operation.controller.signal.aborted && Date.now() < deadline && (peerEpochs.get(peerId) || 0) === epoch && activeLocal(data, peerId) === share;
    let download;
    try {
      if (data.op === 'list') {
        const listing = validListing(await share.model.list(data.nodeId), data.nodeId);
        if (!isActive()) return;
        const result = { ...bindingOf(data), ok: true, listing };
        if (new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_LIST_BYTES) throw errorOf('folder_too_large');
        await responseAction.send(result, { target: peerId, metadata: bindingOf(data), signal: operation.controller.signal });
      } else {
        if (activeDownloads.has(peerId)) { await sendError(data, peerId, 'folder_busy'); return; }
        download = operation;
        activeDownloads.set(peerId, download);
        const file = await share.model.getFile(data.nodeId);
        if (!isActive() || download.controller.signal.aborted) return;
        if (!file || !Number.isSafeInteger(file.size) || file.size < 0 || file.size > maxFileSize || typeof file.arrayBuffer !== 'function') throw errorOf(file?.size > maxFileSize ? 'file_too_large' : 'folder_file_unavailable');
        const bytes = await file.arrayBuffer();
        if (!isActive() || download.controller.signal.aborted) return;
        if (!(bytes instanceof ArrayBuffer) || bytes.byteLength !== file.size || bytes.byteLength > maxFileSize) throw errorOf('file_too_large');
        await downloadAction.send(bytes, { target: peerId, metadata: { ...bindingOf(data), ok: true, name: nameOf(file.name) || 'file', size: bytes.byteLength }, signal: download.controller.signal });
      }
    } catch (error) {
      const code = benignError(error);
      if (code === 'folder_permission_denied') { await service.stopSharingFolder(data.shareId); emit('error', { code }); }
      if (permitted(peerId) && !operation.controller.signal.aborted) await sendError(data, peerId, code);
    } finally {
      if (download && activeDownloads.get(peerId) === download) activeDownloads.delete(peerId);
      clearTimeout(operation.timer);
      if (activeOperations.get(operationKey) === operation) activeOperations.delete(operationKey);
      const remaining = (inboundCounts.get(countKey) || 1) - 1;
      if (remaining) inboundCounts.set(countKey, remaining);
      else inboundCounts.delete(countKey);
    }
  };
  responseAction.onReceive = ({ peerId, byteLength, metadata }) => byteLength >= 0 && byteLength <= MAX_LIST_BYTES && !!pendingFor(metadata, peerId);
  responseAction.onMessage = (data, { peerId, metadata } = {}) => {
    if (!validBinding(data) || !matching(data, metadata) || !pendingFor(data, peerId)) return;
    if (data.ok === false) { finishPending(data.id, null, ERROR_CODES.has(data.error) ? data.error : 'folder_unavailable'); return; }
    if (data.ok !== true || data.op !== 'list') return;
    try { finishPending(data.id, validListing(data.listing, data.nodeId)); }
    catch { finishPending(data.id, null, 'invalid_request'); }
  };
  downloadAction.onReceive = ({ peerId, byteLength, metadata }) => metadata?.op === 'download' && metadata.ok === true
    && Number.isSafeInteger(byteLength) && byteLength >= 0 && byteLength <= maxFileSize && metadata.size === byteLength
    && typeof metadata.name === 'string' && metadata.name.length > 0 && metadata.name.length <= 200 && !!pendingFor(metadata, peerId);
  downloadAction.onMessage = (data, { peerId, metadata } = {}) => {
    const bytes = binaryOf(data);
    if (!bytes || metadata?.op !== 'download' || metadata.ok !== true || !pendingFor(metadata, peerId) || bytes.byteLength > maxFileSize
      || bytes.byteLength !== metadata.size || typeof metadata.name !== 'string' || metadata.name.length < 1 || metadata.name.length > 200) return;
    const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
    urls.set(url, { ownerId: peerId, shareId: metadata.shareId, generation: metadata.generation });
    finishPending(metadata.id, { name: nameOf(metadata.name) || 'file', mimeType: 'application/octet-stream', size: bytes.byteLength, url });
  };
  return service;
}
