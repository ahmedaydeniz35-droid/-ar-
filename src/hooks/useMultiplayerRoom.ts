import { useCallback, useEffect, useRef, useState } from 'react';
import type { ClientMessage, RoomSnapshot, ServerMessage } from '../types/game.ts';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

interface StoredSession {
  roomCode: string;
  playerToken: string;
  playerName: string;
}

const SESSION_STORAGE_KEY = 'kkn_multiplayer_session';
const CUSTOM_SERVER_STORAGE_KEY = 'kkn_server_url';

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

function isValidServerUrl(value: string | undefined): value is string {
  if (!value) return false;
  return /^https?:\/\/[a-zA-Z0-9.-]+(:\d+)?(\/.*)?$/.test(value.trim());
}

export function getConfiguredServerUrl(): string {
  const envUrl = import.meta.env.VITE_SERVER_URL as string | undefined;
  if (isValidServerUrl(envUrl)) {
    return envUrl.trim().replace(/\/+$/, '');
  }
  try {
    const saved = localStorage.getItem(CUSTOM_SERVER_STORAGE_KEY);
    if (saved && isValidServerUrl(saved)) {
      return saved.trim().replace(/\/+$/, '');
    }
  } catch {
    // Ignore storage errors
  }
  return '';
}

export function saveCustomServerUrl(url: string) {
  try {
    const clean = url.trim().replace(/\/+$/, '');
    if (!clean || !isValidServerUrl(clean)) {
      localStorage.removeItem(CUSTOM_SERVER_STORAGE_KEY);
    } else {
      localStorage.setItem(CUSTOM_SERVER_STORAGE_KEY, clean);
    }
  } catch {
    // Ignore storage errors
  }
}

function resolveApiBase(): string {
  return getConfiguredServerUrl();
}

function resolveWebSocketUrl(): string {
  const base = getConfiguredServerUrl();
  if (base) {
    if (base.startsWith('https://')) return `${base.replace('https://', 'wss://')}/ws`;
    if (base.startsWith('http://')) return `${base.replace('http://', 'ws://')}/ws`;
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

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    throw new Error('Sunucudan geçersiz yanıt alındı.');
  }
  if (!res.ok) {
    const errMsg =
      data &&
      typeof data === 'object' &&
      'message' in data &&
      typeof (data as { message: unknown }).message === 'string'
        ? (data as { message: string }).message
        : 'İşlem başarısız oldu.';
    const errCode =
      data &&
      typeof data === 'object' &&
      'code' in data &&
      typeof (data as { code: unknown }).code === 'string'
        ? (data as { code: string }).code
        : 'HTTP_ERROR';
    const err = new Error(errMsg) as Error & { code?: string };
    err.code = errCode;
    throw err;
  }
  return data as T;
}

export function useMultiplayerRoom(enabled: boolean) {
  const [connectionStatus, setConnectionStatus] =
    useState<ConnectionStatus>('connecting');
  const [connectionFailed, setConnectionFailed] = useState(false);
  const [room, setRoom] = useState<RoomSnapshot | null>(null);
  const [myPlayerId, setMyPlayerId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const reconnectAttemptRef = useRef(0);
  const unmountedRef = useRef(false);
  const playerNameRef = useRef('');
  const playerTokenRef = useRef<string | null>(null);
  const roomCodeRef = useRef<string | null>(null);
  const httpReachableRef = useRef(false);
  const connectFnRef = useRef<(() => void) | null>(null);

  const applyJoinedRoom = useCallback(
    (joinedRoom: RoomSnapshot, playerId: string, playerToken: string) => {
      setError(null);
      setConnectionFailed(false);
      setConnectionStatus('connected');
      setRoom(joinedRoom);
      setMyPlayerId(playerId);
      roomCodeRef.current = joinedRoom.code;
      playerTokenRef.current = playerToken;
      writeStoredSession({
        roomCode: joinedRoom.code,
        playerToken,
        playerName: playerNameRef.current,
      });
      updateUrlRoomParam(joinedRoom.code);
    },
    []
  );

  const clearRoomSession = useCallback(() => {
    setRoom(null);
    setMyPlayerId(null);
    roomCodeRef.current = null;
    playerTokenRef.current = null;
    writeStoredSession(null);
    updateUrlRoomParam(null);
  }, []);

  const probeHealth = useCallback(async (): Promise<boolean> => {
    try {
      const res = await fetch(`${resolveApiBase()}/api/health`);
      if (!res.ok) return false;
      const data = (await res.json()) as { ok?: boolean };
      if (data?.ok) {
        httpReachableRef.current = true;
        setConnectionFailed(false);
        setConnectionStatus('connected');
        return true;
      }
    } catch {
      // Unreachable
    }
    httpReachableRef.current = false;
    return false;
  }, []);

  useEffect(() => {
    unmountedRef.current = false;
    if (!enabled) {
      return;
    }

    let pingInterval: number | null = null;
    let pollInterval: number | null = null;

    const tryHttpReconnect = async () => {
      const stored = readStoredSession();
      const urlRoom = new URLSearchParams(window.location.search)
        .get('room')
        ?.trim()
        .toUpperCase();

      if (stored && (!urlRoom || urlRoom === stored.roomCode)) {
        try {
          const data = await postJson<{
            room: RoomSnapshot;
            playerId: string;
            playerToken: string;
          }>(
            `${resolveApiBase()}/api/rooms/${encodeURIComponent(
              stored.roomCode
            )}/reconnect`,
            { playerToken: stored.playerToken }
          );
          if (!unmountedRef.current) {
            applyJoinedRoom(data.room, data.playerId, data.playerToken);
          }
        } catch (err) {
          const code = (err as { code?: string })?.code;
          if (code === 'ROOM_NOT_FOUND' || code === 'SESSION_EXPIRED') {
            writeStoredSession(null);
          }
        }
      }
    };

    const connect = () => {
      if (unmountedRef.current) return;
      if (
        wsRef.current &&
        (wsRef.current.readyState === WebSocket.OPEN ||
          wsRef.current.readyState === WebSocket.CONNECTING)
      ) {
        return;
      }

      if (!httpReachableRef.current) {
        setConnectionStatus('connecting');
      }

      let ws: WebSocket;
      try {
        ws = new WebSocket(resolveWebSocketUrl());
      } catch {
        if (!httpReachableRef.current) {
          setConnectionStatus('disconnected');
          setConnectionFailed(true);
        }
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

        const activeCode = roomCodeRef.current;
        const activeToken = playerTokenRef.current;
        if (activeCode && activeToken) {
          ws.send(
            JSON.stringify({
              type: 'room:reconnect',
              roomCode: activeCode,
              playerToken: activeToken,
            } satisfies ClientMessage)
          );
          return;
        }

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
            applyJoinedRoom(msg.room, msg.playerId, msg.playerToken);
            break;
          }
          case 'room:state': {
            setRoom(msg.room);
            break;
          }
          case 'room:left': {
            clearRoomSession();
            break;
          }
          case 'room:error': {
            setError(msg.message);
            if (
              msg.code === 'ROOM_NOT_FOUND' ||
              msg.code === 'SESSION_EXPIRED'
            ) {
              clearRoomSession();
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

        if (!httpReachableRef.current) {
          probeHealth().then((ok) => {
            if (!unmountedRef.current && !ok) {
              setConnectionStatus('disconnected');
              if (reconnectAttemptRef.current >= 1) {
                setConnectionFailed(true);
              }
            }
          });
        }

        const delay = Math.min(1500 * 2 ** reconnectAttemptRef.current, 10000);
        reconnectAttemptRef.current += 1;
        reconnectTimerRef.current = window.setTimeout(connect, delay);
      };

      ws.onerror = () => {
        // onclose handles fallback & reconnection
      };
    };

    connectFnRef.current = connect;
    probeHealth().then((ok) => {
      if (ok && !unmountedRef.current && !roomCodeRef.current) {
        tryHttpReconnect();
      }
    });
    connect();

    pingInterval = window.setInterval(() => {
      if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(JSON.stringify({ type: 'ping' }));
      }
    }, 25000);

    // HTTP polling fallback whenever WS is not OPEN and user is inside a room
    pollInterval = window.setInterval(async () => {
      if (unmountedRef.current) return;
      if (wsRef.current?.readyState === WebSocket.OPEN) return;
      const code = roomCodeRef.current;
      const token = playerTokenRef.current;
      if (!code || !token) return;

      try {
        const res = await fetch(
          `${resolveApiBase()}/api/rooms/${encodeURIComponent(
            code
          )}/state?token=${encodeURIComponent(token)}`
        );
        if (res.status === 404 || res.status === 401) {
          const data = (await res.json().catch(() => null)) as {
            message?: string;
          } | null;
          clearRoomSession();
          if (data?.message) setError(data.message);
          return;
        }
        if (res.ok) {
          const data = (await res.json()) as {
            room: RoomSnapshot;
            playerId: string;
          };
          if (!unmountedRef.current && data.room) {
            httpReachableRef.current = true;
            setConnectionStatus('connected');
            setConnectionFailed(false);
            setRoom(data.room);
          }
        }
      } catch {
        // Transient network hiccup
      }
    }, 900);

    return () => {
      unmountedRef.current = true;
      connectFnRef.current = null;
      if (reconnectTimerRef.current !== null) {
        window.clearTimeout(reconnectTimerRef.current);
      }
      if (pingInterval !== null) {
        window.clearInterval(pingInterval);
      }
      if (pollInterval !== null) {
        window.clearInterval(pollInterval);
      }
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
    };
  }, [enabled, applyJoinedRoom, clearRoomSession, probeHealth]);

  const reconnectNow = useCallback(() => {
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    reconnectAttemptRef.current = 0;
    setConnectionFailed(false);
    probeHealth();
    connectFnRef.current?.();
  }, [probeHealth]);

  const clearError = useCallback(() => setError(null), []);

  const sendRoomAction = useCallback(
    async (action: ClientMessage) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(action));
        return;
      }

      const code = roomCodeRef.current;
      const token = playerTokenRef.current;
      if (!code || !token) return;

      try {
        const data = await postJson<{
          room?: RoomSnapshot | null;
          left?: boolean;
        }>(
          `${resolveApiBase()}/api/rooms/${encodeURIComponent(code)}/action`,
          { playerToken: token, action }
        );
        httpReachableRef.current = true;
        setConnectionFailed(false);
        setConnectionStatus('connected');
        if (data.left) {
          clearRoomSession();
        } else if (data.room) {
          setRoom(data.room);
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : 'Sunucuyla bağlantı kurulamadı.';
        setError(message);
        const errCode = (err as { code?: string })?.code;
        if (errCode === 'ROOM_NOT_FOUND' || errCode === 'SESSION_EXPIRED') {
          clearRoomSession();
        }
      }
    },
    [clearRoomSession]
  );

  const createRoom = useCallback(
    async (playerName: string) => {
      setError(null);
      playerNameRef.current = playerName.trim();

      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'room:create',
            playerName,
          } satisfies ClientMessage)
        );
        return;
      }

      try {
        const data = await postJson<{
          room: RoomSnapshot;
          playerId: string;
          playerToken: string;
        }>(`${resolveApiBase()}/api/rooms`, { playerName });
        httpReachableRef.current = true;
        applyJoinedRoom(data.room, data.playerId, data.playerToken);
      } catch (err) {
        const isRoomError = Boolean((err as { code?: string })?.code);
        if (!isRoomError) {
          setConnectionFailed(true);
          setError(
            'Sunucuya bağlanılamadı. Tek cihaz modunu kullanabilir veya internet bağlantını kontrol edebilirsin.'
          );
        } else {
          setError(err instanceof Error ? err.message : 'Oda kurulamadı.');
        }
      }
    },
    [applyJoinedRoom]
  );

  const joinRoom = useCallback(
    async (roomCode: string, playerName: string) => {
      setError(null);
      const normalized = roomCode.trim().toUpperCase();
      playerNameRef.current = playerName.trim();
      const stored = readStoredSession();
      const token =
        stored && stored.roomCode === normalized
          ? stored.playerToken
          : undefined;

      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: 'room:join',
            roomCode: normalized,
            playerName,
            playerToken: token,
          } satisfies ClientMessage)
        );
        return;
      }

      try {
        const data = await postJson<{
          room: RoomSnapshot;
          playerId: string;
          playerToken: string;
        }>(`${resolveApiBase()}/api/rooms/join`, {
          roomCode: normalized,
          playerName,
          playerToken: token,
        });
        httpReachableRef.current = true;
        applyJoinedRoom(data.room, data.playerId, data.playerToken);
      } catch (err) {
        const isRoomError = Boolean((err as { code?: string })?.code);
        if (!isRoomError) {
          setConnectionFailed(true);
          setError(
            'Sunucuya bağlanılamadı. Tek cihaz modunu kullanabilir veya internet bağlantını kontrol edebilirsin.'
          );
        } else {
          setError(err instanceof Error ? err.message : 'Odaya katılınamadı.');
        }
      }
    },
    [applyJoinedRoom]
  );

  const leaveRoom = useCallback(() => {
    setError(null);
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'room:leave' } satisfies ClientMessage));
      clearRoomSession();
      return;
    }
    const code = roomCodeRef.current;
    const token = playerTokenRef.current;
    clearRoomSession();
    if (code && token) {
      postJson(`${resolveApiBase()}/api/rooms/${encodeURIComponent(code)}/action`, {
        playerToken: token,
        action: { type: 'room:leave' },
      }).catch(() => {});
    }
  }, [clearRoomSession]);

  const renamePlayer = useCallback(
    (name: string) => {
      setError(null);
      playerNameRef.current = name.trim();
      sendRoomAction({ type: 'player:rename', name });
    },
    [sendRoomAction]
  );

  const kickPlayer = useCallback(
    (targetPlayerId: string) => {
      setError(null);
      sendRoomAction({ type: 'player:kick', targetPlayerId });
    },
    [sendRoomAction]
  );

  const startGame = useCallback(() => {
    setError(null);
    sendRoomAction({ type: 'game:start' });
  }, [sendRoomAction]);

  const submitAnswer = useCallback(
    (text: string) => {
      setError(null);
      sendRoomAction({ type: 'answer:submit', text });
    },
    [sendRoomAction]
  );

  const reshuffle = useCallback(() => {
    setError(null);
    sendRoomAction({ type: 'game:reshuffle' });
  }, [sendRoomAction]);

  const resetToLobby = useCallback(() => {
    setError(null);
    sendRoomAction({ type: 'game:reset' });
  }, [sendRoomAction]);

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
