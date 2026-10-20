// Isolated component fixture. This is never imported by the production entry.
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import CallPanel from '../src/CallPanel.jsx';
import { getT } from '../src/i18n.js';

class RoomFixture {
  connected = true;
  status = 'connected';
  events = new Map();
  calls = [];
  user = { id: 'alice', nickname: 'Alice', language: 'en', inCall: false, audio: false, video: false };
  users = [this.user, { id: 'bob', nickname: 'Bob', language: 'it', inCall: true, audio: true, video: false }];
  on(name, listener) {
    if (!this.events.has(name)) this.events.set(name, new Set());
    this.events.get(name).add(listener);
    return () => this.off(name, listener);
  }
  off(name, listener) { this.events.get(name)?.delete(listener); }
  emit(name, payload) { for (const listener of this.events.get(name) || []) listener(payload); }
  async setCallState(state) {
    if (!this.connected) throw new Error('offline');
    this.calls.push({ method: 'setCallState', ...state });
    this.user = { ...this.user, ...state };
    this.users = this.users.map((person) => person.id === this.user.id ? this.user : person);
    this.emit('presence', { users: this.users });
  }
  async addStream(stream, peerId) { this.calls.push({ method: 'addStream', stream, peerId }); }
  async removeStream(stream, peerId) { this.calls.push({ method: 'removeStream', stream, peerId }); }
  async addTrack(track, stream, peerId) { this.calls.push({ method: 'addTrack', track, stream, peerId }); }
  async removeTrack(track, peerId) { this.calls.push({ method: 'removeTrack', track, peerId }); }
  setPeer(peerId, state) {
    this.users = this.users.map((person) => person.id === peerId ? { ...person, ...state } : person);
    this.emit('presence', { users: this.users });
  }
  removePeer(peerId) {
    this.users = this.users.filter((person) => person.id !== peerId);
    this.emit('peer-left', { peerId });
    this.emit('presence', { users: this.users });
  }
  sendRemoteStream(peerId) {
    const stream = new MediaStream();
    this.emit('stream', { stream, peerId });
    return stream.id;
  }
  setConnection(connected) {
    this.connected = connected;
    this.status = connected ? 'connected' : 'offline';
    this.emit('status', this.status);
  }
}

const client = new RoomFixture();
window.__callFixture = client;
function Harness() {
  const [users, setUsers] = useState(client.users);
  const [, setStatus] = useState(client.status);
  useEffect(() => {
    const disposePresence = client.on('presence', ({ users: next }) => setUsers(next));
    const disposeStatus = client.on('status', setStatus);
    return () => { disposePresence(); disposeStatus(); };
  }, []);
  return <main style={{ maxWidth: 900, margin: '35px auto', fontFamily: 'system-ui,sans-serif' }}><CallPanel roomClient={client} user={client.user} users={users} t={getT('en')} /></main>;
}
createRoot(document.getElementById('root')).render(<Harness />);
