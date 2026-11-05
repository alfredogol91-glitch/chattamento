// The ordinary UI suite isolates external services; test:network uses the real transport.
import { joinRoom } from './trystero.js';

export async function createHybridRoom(config, roomId, callbacks) {
  const room = joinRoom(config, roomId, callbacks);
  return { room, selfId: room.selfId };
}
