import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, RoomSnapshot, ServerMessage } from '../types/game.ts';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

interface StoredSession {
  roomCode: string;
  playerToken: string;
  playerName: string;
}

const SESSION_STORAGE_KEY = 'kkn_multiplayer_session';

function readStoredSession(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (parsed.roomCode && parsed.playerToken) {
      return {
        roomCode: parsed.roomCode,
        playerToken: parsed.playerToken,
        playerName: parsed.playerName ?? '',
      };
    }
  } catch {
    // Ignore storage errors
  }
  return null;
}

function writeStoredSession(session: StoredSession | null) {
  try {
    if (!session) {
      sessionStorage.removeItem(SESSION_STORAGE_KEY);
    } else {
      sessionStorage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
    }
  } catch {
    // Ignore storage errors
  }
}

function resolveWebSocketUrl(): string {
  const configured = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (configured && configured.trim()) {
    const base = configured.trim().replace(/\/+$/, '');
    if (base.startsWith('https://')) return `${base.replace('https://', 'wss://')}/ws`;
    if (base.startsWith('http://')) return `${base.replace('http://', 'ws://')}/ws`;
    if (base.startsWith('wss://') || base.startsWith('ws://')) return `${base}/ws`;
  }
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/ws`;
}

function updateUrlRoomParam(roomCode: string | null) {
  try {
    const url = new URL(window.location.href);
    if (roomCode) {
      url.searchParams.set('room', roomCode);
    } else {
      url.searchParams.delete('room');
    }
    window.history.replaceState({}, '', url.toString());
  } catch {
    // Ignore history errors in restricted frames
  }
}

export function useMultiplayerRoom(enabled: boolean) {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>('disconnected');
  const [connectionFailed, setConnectionFailed] = useState(false);
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [myPlayerId, setMyPlayerId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const pendingQueueRef = useRef<ClientMessage[]>([]);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const unmountedRef = useRef(false);
  const playerNameRef = useRef('');
  const connectFnRef = useRef<(() => void) | null>(null);

  const sendMessage = useCallback((msg: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(msg));
    } else {
      pendingQueueRef.current.push(msg);
      if (
        !ws ||
        ws.readyState === WebSocket.CLOSED ||
        ws.readyState === WebSocket.CLOSING
      ) {
        if (reconnectTimerRef.current !== null) {
          window.clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = null;
        }
        reconnectAttemptRef.current = 0;
        connectFnRef.current?.();
      }
    }
  }, []);

  useEffect(() => {
    unmountedRef.current = false;
    if (!enabled) {
      return;
    }

    let pingInterval: number | null = null;

    const connect = () => {
      if (unmountedRef.current) return;
      if (
        wsRef.current &&
        (wsRef.current.readyState === WebSocket.OPEN ||
          wsRef.current.readyState === WebSocket.CONNECTING)
      ) {
        return;
      }

      setConnectionStatus('connecting');
      let ws: WebSocket;
      try {
        ws = new WebSocket(resolveWebSocketUrl());
      } catch {
        setConnectionStatus('disconnected');
        setConnectionFailed(true);
        return;
      }
      wsRef.current = ws;

      ws.onopen = () => {
        if (unmountedRef.current) {
          ws.close();
          return;
        }
        reconnectAttemptRef.current = 0;
        setConnectionStatus('connected');
        setConnectionFailed(false);

        const hasPendingRoomAction = pendingQueueRef.current.some(
          (m) => m.type === 'room:create' || m.type === 'room:join'
        );
        if (!hasPendingRoomAction) {
          const stored = readStoredSession();
          const urlRoom = new URLSearchParams(window.location.search)
            .get('room')
            ?.trim()
            .toUpperCase();

          if (stored && (!urlRoom || urlRoom === stored.roomCode)) {
            ws.send(
              JSON.stringify({
                type: 'room:reconnect',
                roomCode: stored.roomCode,
                playerToken: stored.playerToken,
              } satisfies ClientMessage)
            );
          }
        }

        while (pendingQueueRef.current.length > 0) {
          const next = pendingQueueRef.current.shift();
          if (next) {
            ws.send(JSON.stringify(next));
          }
        }
      };

      ws.onmessage = (event) => {
        let msg: ServerMessage;
        try {
          msg = JSON.parse(event.data as string) as ServerMessage;
        } catch {
          return;
        }

        switch (msg.type) {
          case 'room:joined': {
            setError(null);
            setRoom(msg.room);
            setMyPlayerId(msg.playerId);
            writeStoredSession({
              roomCode: msg.room.code,
              playerToken: msg.playerToken,
              playerName: playerNameRef.current,
            });
            updateUrlRoomParam(msg.room.code);
            break;
          }
          case 'room:state': {
            setRoom(msg.room);
            break;
          }
          case 'room:left': {
            setRoom(null);
            setMyPlayerId(null);
            writeStoredSession(null);
            updateUrlRoomParam(null);
            break;
          }
          case 'room:error': {
            setError(msg.message);
            if (
              msg.code === 'ROOM_NOT_FOUND' ||
              msg.code === 'SESSION_EXPIRED'
            ) {
              const stored = readStoredSession();
              if (stored) {
                writeStoredSession(null);
                setRoom(null);
                setMyPlayerId(null);
              }
            }
            break;
          }
          case 'pong':
            break;
        }
      };

      ws.onclose = () => {
        wsRef.current = null;
        if (unmountedRef.current) return;
        setConnectionStatus('disconnected');

        if (reconnectAttemptRef.current >= 1) {
          setConnectionFailed(true);
        }

        const delay = Math.min(1000 * 2 ** reconnectAttemptRef.current, 5000);
        reconnectAttemptRef.current += 1;
        reconnectTimerRef.current = window.setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // onclose handles reconnection
      };
    };

    connectFnRef.current = connect;
    connect();
    pingInterval = window.setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'ping' }));
      }
    }, 25000);

    return () => {
      unmountedRef.current = true;
      connectFnRef.current = null;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      if (pingInterval !== null) {
        window.clearInterval(pingInterval);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [enabled]);

  const reconnectNow = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectAttemptRef.current = 0;
    setConnectionFailed(false);
    connectFnRef.current?.();
  }, []);

  const clearError = useCallback(() => setError(null), []);

  const createRoom = useCallback(
    (playerName: string) => {
      setError(null);
      playerNameRef.current = playerName.trim();
      sendMessage({ type: 'room:create', playerName });
    },
    [sendMessage]
  );

  const joinRoom = useCallback(
    (roomCode: string, playerName: string) => {
      setError(null);
      const normalized = roomCode.trim().toUpperCase();
      playerNameRef.current = playerName.trim();
      const stored = readStoredSession();
      sendMessage({
        type: 'room:join',
        roomCode: normalized,
        playerName,
        playerToken:
          stored && stored.roomCode === normalized
            ? stored.playerToken
            : undefined,
      });
    },
    [sendMessage]
  );

  const leaveRoom = useCallback(() => {
    setError(null);
    writeStoredSession(null);
    updateUrlRoomParam(null);
    setRoom(null);
    setMyPlayerId(null);
    sendMessage({ type: 'room:leave' });
  }, [sendMessage]);

  const renamePlayer = useCallback(
    (name: string) => {
      setError(null);
      playerNameRef.current = name.trim();
      sendMessage({ type: 'player:rename', name });
    },
    [sendMessage]
  );

  const kickPlayer = useCallback(
    (targetPlayerId: string) => {
      setError(null);
      sendMessage({ type: 'player:kick', targetPlayerId });
    },
    [sendMessage]
  );

  const startGame = useCallback(() => {
    setError(null);
    sendMessage({ type: 'game:start' });
  }, [sendMessage]);

  const submitAnswer = useCallback(
    (text: string) => {
      setError(null);
      sendMessage({ type: 'answer:submit', text });
    },
    [sendMessage]
  );

  const reshuffle = useCallback(() => {
    setError(null);
    sendMessage({ type: 'game:reshuffle' });
  }, [sendMessage]);

  const resetToLobby = useCallback(() => {
    setError(null);
    sendMessage({ type: 'game:reset' });
  }, [sendMessage]);

  return {
    connectionStatus,
    connectionFailed,
    room,
    myPlayerId,
    error,
    clearError,
    reconnectNow,
    createRoom,
    joinRoom,
    leaveRoom,
    renamePlayer,
    kickPlayer,
    startGame,
    submitAnswer,
    reshuffle,
    resetToLobby,
  };
}
