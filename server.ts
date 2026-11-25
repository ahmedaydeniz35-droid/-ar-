import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { WebSocket, WebSocketServer } from 'ws';
import { RoomError, RoomManager } from './src/server/roomManager.ts';
import type { ClientMessage, ServerMessage } from './src/types/game.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const PORT = Number(process.env.PORT || 3000);
const HOST = '0.0.0.0';
const SHUFFLE_DURATION_MS = 1400;
const STALE_ROOM_MAX_IDLE_MS = 2 * 60 * 60 * 1000;

interface SocketSession {
  roomCode: string | null;
  playerId: string | null;
}

const roomManager = new RoomManager();
const roomSockets = new Map<string, Set<WebSocket>>();
const sessions = new WeakMap<WebSocket, SocketSession>();
const shuffleTimers = new Map<string, NodeJS.Timeout>();

function sendToSocket(ws: WebSocket, message: ServerMessage) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function broadcastRoomState(roomCode: string) {
  const room = roomManager.getRoom(roomCode);
  if (!room) return;

  const sockets = roomSockets.get(room.code);
  if (!sockets || sockets.size === 0) return;

  const snapshot = roomManager.toSnapshot(room);
  const payload = JSON.stringify({
    type: 'room:state',
    room: snapshot,
  } satisfies ServerMessage);

  for (const client of sockets) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function clearShuffleTimer(roomCode: string) {
  const existing = shuffleTimers.get(roomCode);
  if (existing) {
    clearTimeout(existing);
    shuffleTimers.delete(roomCode);
  }
}

function scheduleShuffleAdvance(roomCode: string) {
  clearShuffleTimer(roomCode);
  const timer = setTimeout(() => {
    shuffleTimers.delete(roomCode);
    const updated = roomManager.advanceAfterShuffle(roomCode);
    if (updated) {
      broadcastRoomState(updated.code);
    }
  }, SHUFFLE_DURATION_MS);
  shuffleTimers.set(roomCode, timer);
}

function attachSocketToRoom(ws: WebSocket, roomCode: string, playerId: string) {
  const prev = sessions.get(ws);
  if (prev?.roomCode && prev.roomCode !== roomCode) {
    detachSocketFromRoom(ws, prev.roomCode, prev.playerId, true);
  }

  sessions.set(ws, { roomCode, playerId });
  let set = roomSockets.get(roomCode);
  if (!set) {
    set = new Set();
    roomSockets.set(roomCode, set);
  }
  set.add(ws);
}

function hasOtherActiveSocket(
  roomCode: string,
  playerId: string,
  excludingWs?: WebSocket
): boolean {
  const set = roomSockets.get(roomCode);
  if (!set) return false;
  for (const client of set) {
    if (client === excludingWs) continue;
    if (client.readyState !== WebSocket.OPEN) continue;
    const sess = sessions.get(client);
    if (sess?.playerId === playerId) return true;
  }
  return false;
}

function detachSocketFromRoom(
  ws: WebSocket,
  roomCode: string,
  playerId: string | null,
  explicitLeave: boolean
) {
  const set = roomSockets.get(roomCode);
  if (set) {
    set.delete(ws);
    if (set.size === 0) {
      roomSockets.delete(roomCode);
    }
  }
  sessions.set(ws, { roomCode: null, playerId: null });

  if (!playerId) return;

  if (explicitLeave) {
    const { room, becameReadyToShuffle } = roomManager.leaveRoom(
      roomCode,
      playerId
    );
    if (!room) {
      clearShuffleTimer(roomCode);
      return;
    }
    if (room.screen === 'LOBBY') {
      clearShuffleTimer(room.code);
    }
    if (becameReadyToShuffle) {
      scheduleShuffleAdvance(room.code);
    }
    broadcastRoomState(room.code);
  } else if (!hasOtherActiveSocket(roomCode, playerId, ws)) {
    const room = roomManager.setPlayerConnected(roomCode, playerId, false);
    if (room) {
      broadcastRoomState(room.code);
    }
  }
}

function handleClientMessage(ws: WebSocket, raw: string) {
  let msg: ClientMessage;
  try {
    msg = JSON.parse(raw) as ClientMessage;
  } catch {
    sendToSocket(ws, {
      type: 'room:error',
      code: 'BAD_PAYLOAD',
      message: 'Geçersiz istek formatı.',
    });
    return;
  }

  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'ping') {
    sendToSocket(ws, { type: 'pong' });
    return;
  }

  const sess = sessions.get(ws) ?? { roomCode: null, playerId: null };

  try {
    switch (msg.type) {
      case 'room:create': {
        if (sess.roomCode && sess.playerId) {
          detachSocketFromRoom(ws, sess.roomCode, sess.playerId, true);
        }
        const { room, player } = roomManager.createRoom(msg.playerName ?? '');
        attachSocketToRoom(ws, room.code, player.id);
        sendToSocket(ws, {
          type: 'room:joined',
          room: roomManager.toSnapshot(room),
          playerId: player.id,
          playerToken: player.token,
        });
        break;
      }

      case 'room:join': {
        if (sess.roomCode && sess.playerId) {
          detachSocketFromRoom(ws, sess.roomCode, sess.playerId, true);
        }
        const { room, player } = roomManager.joinRoom(
          msg.roomCode ?? '',
          msg.playerName ?? '',
          msg.playerToken
        );
        attachSocketToRoom(ws, room.code, player.id);
        sendToSocket(ws, {
          type: 'room:joined',
          room: roomManager.toSnapshot(room),
          playerId: player.id,
          playerToken: player.token,
        });
        broadcastRoomState(room.code);
        break;
      }

      case 'room:reconnect': {
        if (sess.roomCode && sess.playerId) {
          detachSocketFromRoom(ws, sess.roomCode, sess.playerId, false);
        }
        const { room, player } = roomManager.reconnectRoom(
          msg.roomCode ?? '',
          msg.playerToken ?? ''
        );
        attachSocketToRoom(ws, room.code, player.id);
        sendToSocket(ws, {
          type: 'room:joined',
          room: roomManager.toSnapshot(room),
          playerId: player.id,
          playerToken: player.token,
        });
        broadcastRoomState(room.code);
        break;
      }

      case 'room:leave': {
        if (sess.roomCode && sess.playerId) {
          detachSocketFromRoom(ws, sess.roomCode, sess.playerId, true);
        }
        sendToSocket(ws, { type: 'room:left' });
        break;
      }

      case 'player:rename': {
        if (!sess.roomCode || !sess.playerId) return;
        const room = roomManager.renamePlayer(
          sess.roomCode,
          sess.playerId,
          msg.name ?? ''
        );
        broadcastRoomState(room.code);
        break;
      }

      case 'player:kick': {
        if (!sess.roomCode || !sess.playerId) return;
        const targetId = msg.targetPlayerId;
        const { room, becameReadyToShuffle } = roomManager.kickPlayer(
          sess.roomCode,
          sess.playerId,
          targetId
        );

        const set = roomSockets.get(sess.roomCode);
        if (set) {
          for (const client of Array.from(set)) {
            const clientSess = sessions.get(client);
            if (clientSess?.playerId === targetId) {
              set.delete(client);
              sessions.set(client, { roomCode: null, playerId: null });
              sendToSocket(client, { type: 'room:left' });
              sendToSocket(client, {
                type: 'room:error',
                code: 'KICKED',
                message: 'Oda yöneticisi tarafından odadan çıkarıldın.',
              });
            }
          }
        }

        if (!room) {
          clearShuffleTimer(sess.roomCode);
          return;
        }
        if (room.screen === 'LOBBY') {
          clearShuffleTimer(room.code);
        }
        if (becameReadyToShuffle) {
          scheduleShuffleAdvance(room.code);
        }
        broadcastRoomState(room.code);
        break;
      }

      case 'game:start': {
        if (!sess.roomCode || !sess.playerId) return;
        const room = roomManager.startGame(sess.roomCode, sess.playerId);
        clearShuffleTimer(room.code);
        broadcastRoomState(room.code);
        break;
      }

      case 'answer:submit': {
        if (!sess.roomCode || !sess.playerId) return;
        const { room, allSubmitted } = roomManager.submitAnswer(
          sess.roomCode,
          sess.playerId,
          msg.text ?? ''
        );
        broadcastRoomState(room.code);
        if (allSubmitted) {
          scheduleShuffleAdvance(room.code);
        }
        break;
      }

      case 'game:reshuffle': {
        if (!sess.roomCode || !sess.playerId) return;
        const room = roomManager.reshuffleResults(sess.roomCode, sess.playerId);
        broadcastRoomState(room.code);
        break;
      }

      case 'game:reset': {
        if (!sess.roomCode || !sess.playerId) return;
        const room = roomManager.resetToLobby(sess.roomCode, sess.playerId);
        clearShuffleTimer(room.code);
        broadcastRoomState(room.code);
        break;
      }
    }
  } catch (err) {
    if (err instanceof RoomError) {
      sendToSocket(ws, {
        type: 'room:error',
        code: err.code,
        message: err.message,
      });
    } else {
      console.error('WebSocket message error:', err);
      sendToSocket(ws, {
        type: 'room:error',
        code: 'INTERNAL_ERROR',
        message: 'Beklenmeyen bir hata oluştu.',
      });
    }
  }
}

async function startServer() {
  const app = express();
  const httpServer = http.createServer(app);

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, rooms: roomManager.getRoomCount() });
  });

  const wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', (ws) => {
    sessions.set(ws, { roomCode: null, playerId: null });

    ws.on('message', (data) => {
      handleClientMessage(ws, data.toString());
    });

    ws.on('close', () => {
      const sess = sessions.get(ws);
      if (sess?.roomCode) {
        detachSocketFromRoom(ws, sess.roomCode, sess.playerId, false);
      }
    });
  });

  const pruneInterval = setInterval(() => {
    roomManager.pruneStaleRooms(STALE_ROOM_MAX_IDLE_MS);
  }, 5 * 60 * 1000);
  pruneInterval.unref();

  if (process.env.NODE_ENV !== 'production') {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: process.env.DISABLE_HMR !== 'true',
      },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(__dirname, 'dist');
    app.use(express.static(distDir));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  httpServer.listen(PORT, HOST, () => {
    console.log(`Server listening on http://${HOST}:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error('Failed to start server:', err);
  process.exit(1);
});
