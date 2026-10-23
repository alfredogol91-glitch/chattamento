const MAX_ENTRIES = 1000;
const MAX_SELECTED_FILES = 5000;
const MAX_INDEXED_NODES = 5001;
const MAX_DEPTH = 32;
const error = code => Object.assign(new Error(code), { code });
const safeSegment = value => typeof value === 'string' && value.length > 0 && value.length <= 255
  && !['.', '..'].includes(value) && !/[\x00-\x1f\x7f/\\]/u.test(value);

function browserError(cause) {
  if (cause?.code?.startsWith('folder_')) return cause;
  if (['NotAllowedError', 'SecurityError'].includes(cause?.name)) return error('folder_permission_denied');
  if (cause?.name === 'NotFoundError') return error('folder_file_unavailable');
  return error('folder_file_unavailable');
}

/** Only a handle explicitly returned by the owner's directory picker is used.
 * No OS path is accepted, and choosing a handle does not enumerate its files. */
export async function createDirectoryShareFromHandle(handle) {
  if (!handle || handle.kind !== 'directory' || !safeSegment(handle.name) || typeof handle.entries !== 'function') throw error('folder_selection_invalid');
  let active = true;
  let root = handle;
  let listingQueue = Promise.resolve();
  const nodes = new Map([['root', { handle, kind: 'directory', name: handle.name }]]);
  const children = new Map();
  const assertActive = () => { if (!active) throw error('folder_revoked'); };
  const checkedNode = async (id, kind) => {
    assertActive();
    const node = typeof id === 'string' ? nodes.get(id) : null;
    if (!node || node.kind !== kind) throw error('folder_not_found');
    if (typeof root.queryPermission === 'function' && await root.queryPermission({ mode: 'read' }) !== 'granted') throw error('folder_permission_denied');
    assertActive();
    if (id !== 'root' && typeof root.resolve === 'function') {
      const relative = await root.resolve(node.handle);
      if (!Array.isArray(relative) || !relative.length || relative.length > MAX_DEPTH || !relative.every(safeSegment)) throw error('folder_not_found');
    }
    assertActive();
    if (nodes.get(id) !== node) throw error('folder_not_found');
    return node;
  };
  return {
    id: crypto.randomUUID(), name: handle.name, kind: 'handle',
    list(nodeId = 'root') {
      // Scans and their commits share one queue so concurrent peer requests
      // cannot reuse a stale node budget or restore a removed subtree.
      const operation = listingQueue.then(async () => {
      try {
        const node = await checkedNode(nodeId, 'directory');
        const discovered = new Map();
        for await (const [name, child] of node.handle.entries()) {
          assertActive();
          if (!safeSegment(name) || !child || !['file', 'directory'].includes(child.kind)) continue;
          if (discovered.size >= MAX_ENTRIES) throw error('folder_too_large');
          discovered.set(name, child);
        }
        assertActive();
        const previous = children.get(nodeId) || new Map();
        const removed = new Set();
        const markRemoved = id => {
          if (removed.has(id)) return;
          removed.add(id);
          for (const descendant of children.get(id)?.values() || []) markRemoved(descendant);
        };
        for (const [name, id] of previous) {
          const replacement = discovered.get(name);
          const old = nodes.get(id);
          let unchanged = replacement && old?.kind === replacement.kind;
          if (unchanged && typeof old.handle.isSameEntry === 'function') unchanged = await old.handle.isSameEntry(replacement);
          assertActive();
          if (!unchanged) markRemoved(id);
        }
        const index = new Map();
        const entries = [];
        let additions = 0;
        for (const [name, child] of discovered) {
          const oldId = previous.get(name);
          const id = oldId && !removed.has(oldId) ? oldId : crypto.randomUUID();
          if (id !== oldId) additions++;
          index.set(name, id);
          entries.push({ id, name, kind: child.kind });
        }
        if (nodes.size - removed.size + additions > MAX_INDEXED_NODES) throw error('folder_too_large');
        // Commit only a bounded, complete listing; removed subtrees lose authority.
        for (const id of removed) { children.delete(id); nodes.delete(id); }
        children.set(nodeId, index);
        for (const [name, child] of discovered) {
          const id = index.get(name);
          const record = nodes.get(id) || {};
          Object.assign(record, { handle: child, kind: child.kind, name });
          nodes.set(id, record);
        }
        entries.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'directory' ? -1 : 1) || a.name.localeCompare(b.name));
        return { id: nodeId, name: node.name, entries };
      } catch (cause) { throw browserError(cause); }
      });
      listingQueue = operation.catch(() => {});
      return operation;
    },
    async getFile(fileId) {
      try {
        const node = await checkedNode(fileId, 'file');
        if (typeof node.handle.getFile !== 'function') throw error('folder_file_unavailable');
        const file = await node.handle.getFile();
        assertActive();
        if (nodes.get(fileId) !== node) throw error('folder_not_found');
        return file;
      } catch (cause) { throw browserError(cause); }
    },
    dispose() { active = false; root = null; nodes.clear(); children.clear(); },
  };
}

/** Compatibility path: browser-selected File objects, with no disk-path API.
 * It is a snapshot of files, so empty directories are not represented. */
export async function createDirectoryShareFromFiles(fileList) {
  const files = Array.from(fileList || []);
  if (!files.length || files.length > MAX_SELECTED_FILES) throw error(files.length > MAX_SELECTED_FILES ? 'folder_too_large' : 'folder_selection_invalid');
  let active = true;
  let rootName;
  const nodes = new Map();
  const byPath = new Map();
  for (const file of files) {
    if (!file || typeof file.arrayBuffer !== 'function' || typeof file.webkitRelativePath !== 'string' || file.webkitRelativePath.length > 4096) throw error('folder_selection_invalid');
    const segments = file.webkitRelativePath.split('/');
    if (segments.length < 2 || segments.length > MAX_DEPTH || !segments.every(safeSegment)) throw error('folder_selection_invalid');
    rootName ??= segments[0];
    if (segments[0] !== rootName) throw error('folder_selection_invalid');
    if (!nodes.has('root')) nodes.set('root', { id: 'root', name: rootName, kind: 'directory', entries: new Map() });
    let parent = nodes.get('root');
    let path = '';
    for (let index = 1; index < segments.length; index++) {
      const name = segments[index];
      path += `/${name}`;
      const kind = index === segments.length - 1 ? 'file' : 'directory';
      let id = byPath.get(path);
      let node = id ? nodes.get(id) : null;
      if (node && (node.kind !== kind || kind === 'file')) throw error('folder_selection_invalid');
      if (!node) {
        if (parent.entries.size >= MAX_ENTRIES) throw error('folder_too_large');
        if (nodes.size >= MAX_INDEXED_NODES) throw error('folder_too_large');
        id = crypto.randomUUID();
        node = kind === 'directory' ? { id, name, kind, entries: new Map() }
          : { id, name, kind, file, size: file.size, lastModified: file.lastModified };
        nodes.set(id, node); byPath.set(path, id); parent.entries.set(name, id);
      }
      parent = node;
    }
  }
  const getNode = (id, kind) => {
    if (!active) throw error('folder_revoked');
    const node = typeof id === 'string' ? nodes.get(id) : null;
    if (!node || node.kind !== kind) throw error('folder_not_found');
    return node;
  };
  return {
    id: crypto.randomUUID(), name: rootName, kind: 'files',
    async list(nodeId = 'root') {
      const node = getNode(nodeId, 'directory');
      const entries = [...node.entries.values()].map(id => {
        const child = nodes.get(id);
        return { id, name: child.name, kind: child.kind, ...(child.kind === 'file' ? { size: child.size, lastModified: child.lastModified } : {}) };
      });
      entries.sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'directory' ? -1 : 1) || a.name.localeCompare(b.name));
      return { id: nodeId, name: node.name, entries };
    },
    async getFile(fileId) { return getNode(fileId, 'file').file; },
    dispose() { active = false; nodes.clear(); byPath.clear(); },
  };
}
