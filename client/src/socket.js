import { io } from 'socket.io-client';

export const socket = io({
  autoConnect: true,
  reconnection: true,
  reconnectionAttempts: Infinity,
  reconnectionDelay: 700,
  reconnectionDelayMax: 5000,
  timeout: 10000,
});

export function request(event, payload = {}) {
  return new Promise((resolve) => {
    if (!socket.connected) socket.connect();
    socket.timeout(12000).emit(event, payload, (timeoutError, response) => {
      if (timeoutError) {
        resolve({ ok: false, error: 'The server did not respond. Check your connection and try again.' });
        return;
      }
      resolve(response ?? { ok: false, error: 'No response received from the game server.' });
    });
  });
}
