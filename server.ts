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

function notifyKickedSockets(roomCode: string, targetId: string) {
  const set = roomSockets.get(roomCode);
  if (!set) return;
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
        notifyKickedSockets(sess.roomCode, targetId);

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

function sendHttpError(res: express.Response, err: unknown) {
  if (err instanceof RoomError) {
    const status =
      err.code === 'ROOM_NOT_FOUND'
        ? 404
        : err.code === 'FORBIDDEN'
          ? 403
          : err.code === 'SESSION_EXPIRED'
            ? 401
            : 400;
    return res.status(status).json({ code: err.code, message: err.message });
  }
  console.error('HTTP room API error:', err);
  return res
    .status(500)
    .json({ code: 'INTERNAL_ERROR', message: 'Beklenmeyen bir hata oluştu.' });
}

async function startServer() {
  const app = express();
  const httpServer = http.createServer(app);

  app.use('/api', (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use('/api', express.json());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, rooms: roomManager.getRoomCount() });
  });

  app.post('/api/rooms', (req, res) => {
    try {
      const playerName =
        typeof req.body?.playerName === 'string' ? req.body.playerName : '';
      const { room, player } = roomManager.createRoom(playerName);
      res.json({
        room: roomManager.toSnapshot(room),
        playerId: player.id,
        playerToken: player.token,
      });
    } catch (err) {
      sendHttpError(res, err);
    }
  });

  app.post('/api/rooms/join', (req, res) => {
    try {
      const roomCode =
        typeof req.body?.roomCode === 'string' ? req.body.roomCode : '';
      const playerName =
        typeof req.body?.playerName === 'string' ? req.body.playerName : '';
      const playerToken =
        typeof req.body?.playerToken === 'string'
          ? req.body.playerToken
          : undefined;
      const { room, player } = roomManager.joinRoom(
        roomCode,
        playerName,
        playerToken
      );
      broadcastRoomState(room.code);
      res.json({
        room: roomManager.toSnapshot(room),
        playerId: player.id,
        playerToken: player.token,
      });
    } catch (err) {
      sendHttpError(res, err);
    }
  });

  app.post('/api/rooms/:code/reconnect', (req, res) => {
    try {
      const playerToken =
        typeof req.body?.playerToken === 'string' ? req.body.playerToken : '';
      const { room, player } = roomManager.reconnectRoom(
        req.params.code,
        playerToken
      );
      broadcastRoomState(room.code);
      res.json({
        room: roomManager.toSnapshot(room),
        playerId: player.id,
        playerToken: player.token,
      });
    } catch (err) {
      sendHttpError(res, err);
    }
  });

  app.get('/api/rooms/:code/state', (req, res) => {
    try {
      const token = typeof req.query.token === 'string' ? req.query.token : '';
      const room = roomManager.getRoom(req.params.code);
      if (!room) {
        throw new RoomError('ROOM_NOT_FOUND', 'Oda artık mevcut değil.');
      }
      const player = room.players.find((p) => p.token === token);
      if (!player) {
        throw new RoomError('SESSION_EXPIRED', 'Oturumun sona ermiş.');
      }
      if (!player.connected) {
        player.connected = true;
        room.updatedAt = Date.now();
        broadcastRoomState(room.code);
      }
      res.json({
        room: roomManager.toSnapshot(room),
        playerId: player.id,
      });
    } catch (err) {
      sendHttpError(res, err);
    }
  });

  app.post('/api/rooms/:code/action', (req, res) => {
    try {
      const token =
        typeof req.body?.playerToken === 'string' ? req.body.playerToken : '';
      const msg = req.body?.action as ClientMessage | undefined;
      const room = roomManager.getRoom(req.params.code);
      if (!room) {
        throw new RoomError('ROOM_NOT_FOUND', 'Oda bulunamadı.');
      }
      const player = room.players.find((p) => p.token === token);
      if (!player) {
        throw new RoomError('SESSION_EXPIRED', 'Oturumun sona ermiş.');
      }
      if (!msg || typeof msg.type !== 'string') {
        throw new RoomError('BAD_PAYLOAD', 'Geçersiz istek.');
      }

      switch (msg.type) {
        case 'room:leave': {
          const { room: updated, becameReadyToShuffle } = roomManager.leaveRoom(
            room.code,
            player.id
          );
          if (!updated) {
            clearShuffleTimer(room.code);
          } else {
            if (updated.screen === 'LOBBY') clearShuffleTimer(updated.code);
            if (becameReadyToShuffle) scheduleShuffleAdvance(updated.code);
            broadcastRoomState(updated.code);
          }
          res.json({ left: true });
          return;
        }
        case 'player:rename': {
          const updated = roomManager.renamePlayer(
            room.code,
            player.id,
            msg.name ?? ''
          );
          broadcastRoomState(updated.code);
          res.json({ room: roomManager.toSnapshot(updated) });
          return;
        }
        case 'player:kick': {
          const targetId = msg.targetPlayerId;
          const { room: updated, becameReadyToShuffle } =
            roomManager.kickPlayer(room.code, player.id, targetId);
          notifyKickedSockets(room.code, targetId);
          if (!updated) {
            clearShuffleTimer(room.code);
            res.json({ room: null });
            return;
          }
          if (updated.screen === 'LOBBY') clearShuffleTimer(updated.code);
          if (becameReadyToShuffle) scheduleShuffleAdvance(updated.code);
          broadcastRoomState(updated.code);
          res.json({ room: roomManager.toSnapshot(updated) });
          return;
        }
        case 'game:start': {
          const updated = roomManager.startGame(room.code, player.id);
          clearShuffleTimer(updated.code);
          broadcastRoomState(updated.code);
          res.json({ room: roomManager.toSnapshot(updated) });
          return;
        }
        case 'answer:submit': {
          const { room: updated, allSubmitted } = roomManager.submitAnswer(
            room.code,
            player.id,
            msg.text ?? ''
          );
          broadcastRoomState(updated.code);
          if (allSubmitted) {
            scheduleShuffleAdvance(updated.code);
          }
          res.json({ room: roomManager.toSnapshot(updated) });
          return;
        }
        case 'game:reshuffle': {
          const updated = roomManager.reshuffleResults(room.code, player.id);
          broadcastRoomState(updated.code);
          res.json({ room: roomManager.toSnapshot(updated) });
          return;
        }
        case 'game:reset': {
          const updated = roomManager.resetToLobby(room.code, player.id);
          clearShuffleTimer(updated.code);
          broadcastRoomState(updated.code);
          res.json({ room: roomManager.toSnapshot(updated) });
          return;
        }
        default:
          throw new RoomError('BAD_PAYLOAD', 'Desteklenmeyen işlem.');
      }
    } catch (err) {
      sendHttpError(res, err);
    }
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
