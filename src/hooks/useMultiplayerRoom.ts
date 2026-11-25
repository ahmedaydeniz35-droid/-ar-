import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  collection,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  where,
  writeBatch,
} from 'firebase/firestore';
import { db, handleFirestoreError, OperationType } from '../firebase.ts';
import { GAME_STEPS } from '../types/game.ts';
import type { RoomSnapshot } from '../types/game.ts';
import { buildSentences } from '../utils/shuffler.ts';
import {
  areAllPlayersSubmitted,
  buildAnswersMapFromDocs,
  computeSubmittedPlayerIds,
  createRoomPlayerId,
  generateRoomCode,
  isPermissionDeniedError,
  isValidRoomCode,
  MAX_ROOM_PLAYERS,
  normalizeRoomCode,
  orderRoomPlayers,
  sanitizeAnswerText,
  sanitizePlayerName,
} from '../utils/roomHelpers.ts';
import type {
  FirestoreAnswerDoc,
  FirestorePlayerDoc,
  FirestoreRoomDoc,
} from '../utils/roomHelpers.ts';

interface StoredSession {
  roomCode: string;
  playerId: string;
  playerName: string;
}

class RoomDomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RoomDomainError';
  }
}

const SESSION_STORAGE_KEY = 'kkn_multiplayer_session';

function readStoredSession(): StoredSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredSession>;
    if (
      parsed.roomCode &&
      isValidRoomCode(parsed.roomCode) &&
      parsed.playerId
    ) {
      return {
        roomCode: parsed.roomCode,
        playerId: parsed.playerId,
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
  const [activeSession, setActiveSession] = useState<{
    roomCode: string;
    playerId: string;
  } | null>(null);
  const [roomDoc, setRoomDoc] = useState<FirestoreRoomDoc | null>(null);
  const [playerDocs, setPlayerDocs] = useState<FirestorePlayerDoc[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(false);
  const [fatalError, setFatalError] = useState<Error | null>(null);

  if (fatalError) {
    throw fatalError;
  }

  const unmountedRef = useRef(false);
  const hasLoadedRoomRef = useRef(false);
  const restoringRef = useRef(false);

  const applySession = useCallback(
    (roomCode: string, playerId: string, playerName: string) => {
      hasLoadedRoomRef.current = false;
      setError(null);
      setRoomDoc(null);
      setPlayerDocs([]);
      setActiveSession({ roomCode, playerId });
      writeStoredSession({ roomCode, playerId, playerName });
      updateUrlRoomParam(roomCode);
    },
    []
  );

  const clearRoomSession = useCallback(() => {
    hasLoadedRoomRef.current = false;
    setActiveSession(null);
    setRoomDoc(null);
    setPlayerDocs([]);
    writeStoredSession(null);
    updateUrlRoomParam(null);
  }, []);

  const reportError = useCallback(
    (err: unknown, op: OperationType, path: string, fallbackMessage: string) => {
      if (err instanceof RoomDomainError) {
        setError(err.message);
        return;
      }
      if (isPermissionDeniedError(err)) {
        try {
          handleFirestoreError(err, op, path);
        } catch (wrapped) {
          setFatalError(
            wrapped instanceof Error ? wrapped : new Error(String(wrapped))
          );
        }
        return;
      }
      try {
        handleFirestoreError(err, op, path);
      } catch {
        // Logged via handleFirestoreError; surface friendly message to player
      }
      setError(fallbackMessage);
    },
    []
  );

  // Restore stored session on mount when ONLINE mode is active
  useEffect(() => {
    unmountedRef.current = false;
    if (!enabled || activeSession || restoringRef.current) {
      return;
    }

    const stored = readStoredSession();
    const urlRoom = normalizeRoomCode(
      new URLSearchParams(window.location.search).get('room') ?? ''
    );
    if (!stored || (urlRoom && urlRoom !== stored.roomCode)) {
      return;
    }

    restoringRef.current = true;
    const roomPath = `rooms/${stored.roomCode}`;
    const playerPath = `rooms/${stored.roomCode}/players/${stored.playerId}`;

    (async () => {
      try {
        const [roomSnap, playerSnap] = await Promise.all([
          getDoc(doc(db, 'rooms', stored.roomCode)),
          getDoc(doc(db, 'rooms', stored.roomCode, 'players', stored.playerId)),
        ]);

        if (unmountedRef.current) return;

        if (roomSnap.exists() && playerSnap.exists()) {
          applySession(stored.roomCode, stored.playerId, stored.playerName);
        } else {
          writeStoredSession(null);
        }
      } catch (err) {
        if (isPermissionDeniedError(err)) {
          reportError(err, OperationType.GET, `${roomPath} | ${playerPath}`, '');
        }
      } finally {
        restoringRef.current = false;
      }
    })();

    return () => {
      unmountedRef.current = true;
    };
  }, [enabled, activeSession, applySession, reportError]);

  // Attach real-time Firestore listeners for active room and players
  useEffect(() => {
    if (!enabled || !activeSession) {
      return;
    }

    const { roomCode, playerId } = activeSession;
    const roomPath = `rooms/${roomCode}`;
    const playersPath = `rooms/${roomCode}/players`;

    const unsubRoom = onSnapshot(
      doc(db, 'rooms', roomCode),
      (snapshot) => {
        if (!snapshot.exists()) {
          if (hasLoadedRoomRef.current) {
            clearRoomSession();
            setError('Oda kapatıldı.');
          }
          return;
        }
        hasLoadedRoomRef.current = true;
        const data = snapshot.data() as FirestoreRoomDoc;
        setRoomDoc(data);

        if (
          Array.isArray(data.playerOrder) &&
          !data.playerOrder.includes(playerId)
        ) {
          clearRoomSession();
          setError('Odadan çıkarıldın.');
        }
      },
      (err) => {
        try {
          handleFirestoreError(err, OperationType.GET, roomPath);
        } catch (wrapped) {
          setFatalError(
            wrapped instanceof Error ? wrapped : new Error(String(wrapped))
          );
        }
      }
    );

    const unsubPlayers = onSnapshot(
      query(
        collection(db, 'rooms', roomCode, 'players'),
        where('roomCode', '==', roomCode)
      ),
      (snapshot) => {
        const list = snapshot.docs.map(
          (d) => d.data() as FirestorePlayerDoc
        );
        setPlayerDocs(list);
      },
      (err) => {
        try {
          handleFirestoreError(err, OperationType.LIST, playersPath);
        } catch (wrapped) {
          setFatalError(
            wrapped instanceof Error ? wrapped : new Error(String(wrapped))
          );
        }
      }
    );

    return () => {
      unsubRoom();
      unsubPlayers();
    };
  }, [enabled, activeSession, clearRoomSession]);

  // Host transitions SHUFFLING -> next step or RESULTS after 1400ms
  useEffect(() => {
    if (
      !enabled ||
      !activeSession ||
      !roomDoc ||
      roomDoc.screen !== 'SHUFFLING' ||
      roomDoc.hostId !== activeSession.playerId
    ) {
      return;
    }

    const roomCode = roomDoc.code;
    const stepIndex = roomDoc.currentStepIndex;
    const currentDocs = playerDocs;

    const timer = window.setTimeout(async () => {
      const roomRef = doc(db, 'rooms', roomCode);
      const roomPath = `rooms/${roomCode}`;

      try {
        if (stepIndex + 1 < GAME_STEPS.length) {
          await runTransaction(db, async (tx) => {
            const snap = await tx.get(roomRef);
            if (!snap.exists()) return;
            const latest = snap.data() as FirestoreRoomDoc;
            if (
              latest.screen !== 'SHUFFLING' ||
              latest.currentStepIndex !== stepIndex
            ) {
              return;
            }
            tx.update(roomRef, {
              screen: 'PLAYING',
              currentStepIndex: stepIndex + 1,
              updatedAt: serverTimestamp(),
            });
          });
        } else {
          const answersPath = `rooms/${roomCode}/answers`;
          const answersSnap = await getDocs(
            query(
              collection(db, 'rooms', roomCode, 'answers'),
              where('roomCode', '==', roomCode)
            )
          );
          const answerDocs = answersSnap.docs.map(
            (d) => d.data() as FirestoreAnswerDoc
          );
          const orderedPlayers = orderRoomPlayers(
            roomDoc.playerOrder,
            currentDocs,
            roomDoc.hostId
          );
          if (orderedPlayers.length < 2) {
            return;
          }
          const answersMap = buildAnswersMapFromDocs(answerDocs);
          const builtResults = buildSentences(orderedPlayers, answersMap);

          await runTransaction(db, async (tx) => {
            const snap = await tx.get(roomRef);
            if (!snap.exists()) return;
            const latest = snap.data() as FirestoreRoomDoc;
            if (
              latest.screen !== 'SHUFFLING' ||
              latest.currentStepIndex !== 3
            ) {
              return;
            }
            tx.update(roomRef, {
              screen: 'RESULTS',
              results: builtResults,
              updatedAt: serverTimestamp(),
            });
          });
          void answersPath;
        }
      } catch (err) {
        reportError(
          err,
          OperationType.UPDATE,
          roomPath,
          'Sonraki aşamaya geçilirken bir sorun oluştu.'
        );
      }
    }, 1400);

    return () => window.clearTimeout(timer);
  }, [enabled, activeSession, roomDoc, playerDocs, reportError]);

  const room: RoomSnapshot | null = useMemo(() => {
    if (!roomDoc) return null;
    const players = orderRoomPlayers(
      roomDoc.playerOrder ?? [],
      playerDocs,
      roomDoc.hostId
    );
    const submittedPlayerIds = computeSubmittedPlayerIds(
      roomDoc.playerOrder ?? [],
      playerDocs,
      roomDoc.currentStepIndex
    );

    return {
      code: roomDoc.code,
      hostId: roomDoc.hostId,
      screen: roomDoc.screen,
      players,
      currentStepIndex: roomDoc.currentStepIndex,
      submittedPlayerIds,
      results: roomDoc.results ?? [],
    };
  }, [roomDoc, playerDocs]);

  const clearError = useCallback(() => setError(null), []);

  const maybeAdvanceToShuffling = useCallback(
    async (roomCode: string, expectedStepIndex: number) => {
      const roomRef = doc(db, 'rooms', roomCode);
      await runTransaction(db, async (tx) => {
        const roomSnap = await tx.get(roomRef);
        if (!roomSnap.exists()) return;
        const latestRoom = roomSnap.data() as FirestoreRoomDoc;
        if (
          latestRoom.screen !== 'PLAYING' ||
          latestRoom.currentStepIndex !== expectedStepIndex
        ) {
          return;
        }

        const pSnaps = await Promise.all(
          latestRoom.playerOrder.map((pid) =>
            tx.get(doc(db, 'rooms', roomCode, 'players', pid))
          )
        );
        const latestDocs = pSnaps
          .filter((s) => s.exists())
          .map((s) => s.data() as FirestorePlayerDoc);

        if (
          areAllPlayersSubmitted(
            latestRoom.playerOrder,
            latestDocs,
            expectedStepIndex
          )
        ) {
          tx.update(roomRef, {
            screen: 'SHUFFLING',
            updatedAt: serverTimestamp(),
          });
        }
      });
    },
    []
  );

  const createRoom = useCallback(
    async (rawName: string) => {
      const cleanName = sanitizePlayerName(rawName);
      if (!cleanName) {
        setError('Lütfen önce oyuncu adını yaz.');
        return;
      }

      setError(null);
      setIsBusy(true);
      const playerId = createRoomPlayerId();

      try {
        let createdCode = '';
        for (let attempt = 0; attempt < 5; attempt++) {
          const candidate = generateRoomCode();
          const roomRef = doc(db, 'rooms', candidate);
          const existing = await getDoc(roomRef);
          if (!existing.exists()) {
            const batch = writeBatch(db);
            batch.set(roomRef, {
              code: candidate,
              hostId: playerId,
              screen: 'LOBBY',
              currentStepIndex: 0,
              playerOrder: [playerId],
              results: [],
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
            batch.set(doc(db, 'rooms', candidate, 'players', playerId), {
              id: playerId,
              roomCode: candidate,
              name: cleanName,
              isHost: true,
              submittedStepIndex: -1,
              joinedAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
            await batch.commit();
            createdCode = candidate;
            break;
          }
        }

        if (!createdCode) {
          throw new RoomDomainError(
            'Oda kodu oluşturulamadı, lütfen tekrar dene.'
          );
        }

        applySession(createdCode, playerId, cleanName);
      } catch (err) {
        reportError(
          err,
          OperationType.CREATE,
          'rooms',
          'Oda kurulurken bir sorun oluştu. İnternet bağlantını kontrol edip tekrar dene.'
        );
      } finally {
        setIsBusy(false);
      }
    },
    [applySession, reportError]
  );

  const joinRoom = useCallback(
    async (rawCode: string, rawName: string) => {
      const cleanName = sanitizePlayerName(rawName);
      const code = normalizeRoomCode(rawCode);

      if (!cleanName) {
        setError('Katılmak için önce oyuncu adını yaz.');
        return;
      }
      if (!isValidRoomCode(code)) {
        setError('Lütfen 6 karakterli geçerli bir oda kodu yaz.');
        return;
      }

      setError(null);
      setIsBusy(true);
      const roomPath = `rooms/${code}`;

      try {
        const stored = readStoredSession();
        if (stored && stored.roomCode === code) {
          const existingPlayerRef = doc(
            db,
            'rooms',
            code,
            'players',
            stored.playerId
          );
          const [roomSnap, playerSnap] = await Promise.all([
            getDoc(doc(db, 'rooms', code)),
            getDoc(existingPlayerRef),
          ]);
          if (roomSnap.exists() && playerSnap.exists()) {
            const pData = playerSnap.data() as FirestorePlayerDoc;
            if (pData.name !== cleanName) {
              await runTransaction(db, async (tx) => {
                tx.update(existingPlayerRef, {
                  name: cleanName,
                  updatedAt: serverTimestamp(),
                });
              });
            }
            applySession(code, stored.playerId, cleanName);
            return;
          }
        }

        const newPlayerId = createRoomPlayerId();
        const roomRef = doc(db, 'rooms', code);
        const playerRef = doc(db, 'rooms', code, 'players', newPlayerId);

        await runTransaction(db, async (tx) => {
          const roomSnap = await tx.get(roomRef);
          if (!roomSnap.exists()) {
            throw new RoomDomainError('Oda bulunamadı. Kodu kontrol et.');
          }

          const latest = roomSnap.data() as FirestoreRoomDoc;
          if (latest.screen !== 'LOBBY') {
            throw new RoomDomainError(
              'Oyun zaten başladı. Yeni turda katılabilirsin.'
            );
          }
          if (latest.playerOrder.length >= MAX_ROOM_PLAYERS) {
            throw new RoomDomainError(
              `Oda dolu (en fazla ${MAX_ROOM_PLAYERS} kişi).`
            );
          }

          tx.set(playerRef, {
            id: newPlayerId,
            roomCode: code,
            name: cleanName,
            isHost: false,
            submittedStepIndex: -1,
            joinedAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          tx.update(roomRef, {
            playerOrder: [...latest.playerOrder, newPlayerId],
            updatedAt: serverTimestamp(),
          });
        });

        applySession(code, newPlayerId, cleanName);
      } catch (err) {
        reportError(
          err,
          OperationType.WRITE,
          roomPath,
          'Odaya katılırken bir sorun oluştu. Lütfen tekrar dene.'
        );
      } finally {
        setIsBusy(false);
      }
    },
    [applySession, reportError]
  );

  const leaveRoom = useCallback(async () => {
    if (!activeSession) {
      clearRoomSession();
      return;
    }

    const { roomCode, playerId } = activeSession;
    const roomPath = `rooms/${roomCode}`;
    clearRoomSession();

    try {
      const roomRef = doc(db, 'rooms', roomCode);
      const roomSnap = await getDoc(roomRef);
      if (!roomSnap.exists()) return;

      const latest = roomSnap.data() as FirestoreRoomDoc;
      if (latest.playerOrder.length <= 1 && latest.playerOrder.includes(playerId)) {
        const answersSnap = await getDocs(
          query(
            collection(db, 'rooms', roomCode, 'answers'),
            where('roomCode', '==', roomCode)
          )
        );
        const batch = writeBatch(db);
        for (const ans of answersSnap.docs) {
          batch.delete(ans.ref);
        }
        batch.delete(doc(db, 'rooms', roomCode, 'players', playerId));
        batch.delete(roomRef);
        await batch.commit();
        return;
      }

      await runTransaction(db, async (tx) => {
        const snap = await tx.get(roomRef);
        if (!snap.exists()) return;
        const curr = snap.data() as FirestoreRoomDoc;
        const nextOrder = curr.playerOrder.filter((id) => id !== playerId);
        if (nextOrder.length === 0) return;

        const nextHostId =
          curr.hostId === playerId ? nextOrder[0] : curr.hostId;

        if (nextHostId !== curr.hostId) {
          tx.update(doc(db, 'rooms', roomCode, 'players', nextHostId), {
            isHost: true,
            updatedAt: serverTimestamp(),
          });
        }

        tx.delete(doc(db, 'rooms', roomCode, 'players', playerId));
        tx.update(roomRef, {
          playerOrder: nextOrder,
          hostId: nextHostId,
          updatedAt: serverTimestamp(),
        });
      });
    } catch (err) {
      reportError(
        err,
        OperationType.DELETE,
        roomPath,
        'Odadan ayrılırken bir sorun oluştu.'
      );
    }
  }, [activeSession, clearRoomSession, reportError]);

  const renamePlayer = useCallback(
    async (rawName: string) => {
      if (!activeSession) return;
      const cleanName = sanitizePlayerName(rawName);
      if (!cleanName) return;

      const { roomCode, playerId } = activeSession;
      const playerPath = `rooms/${roomCode}/players/${playerId}`;
      setError(null);

      try {
        await runTransaction(db, async (tx) => {
          tx.update(doc(db, 'rooms', roomCode, 'players', playerId), {
            name: cleanName,
            updatedAt: serverTimestamp(),
          });
        });
        writeStoredSession({ roomCode, playerId, playerName: cleanName });
      } catch (err) {
        reportError(
          err,
          OperationType.UPDATE,
          playerPath,
          'Oyuncu adı güncellenemedi.'
        );
      }
    },
    [activeSession, reportError]
  );

  const kickPlayer = useCallback(
    async (targetPlayerId: string) => {
      if (!activeSession || !roomDoc) return;
      if (roomDoc.hostId !== activeSession.playerId) return;
      if (targetPlayerId === activeSession.playerId) return;

      const roomCode = activeSession.roomCode;
      const roomPath = `rooms/${roomCode}`;
      setError(null);

      try {
        let shouldCheckAdvance = false;
        let activeStep = roomDoc.currentStepIndex;

        await runTransaction(db, async (tx) => {
          const roomRef = doc(db, 'rooms', roomCode);
          const snap = await tx.get(roomRef);
          if (!snap.exists()) return;
          const latest = snap.data() as FirestoreRoomDoc;
          const nextOrder = latest.playerOrder.filter(
            (id) => id !== targetPlayerId
          );
          if (nextOrder.length === 0) return;

          tx.delete(doc(db, 'rooms', roomCode, 'players', targetPlayerId));
          tx.update(roomRef, {
            playerOrder: nextOrder,
            updatedAt: serverTimestamp(),
          });
          shouldCheckAdvance = latest.screen === 'PLAYING';
          activeStep = latest.currentStepIndex;
        });

        if (shouldCheckAdvance) {
          await maybeAdvanceToShuffling(roomCode, activeStep);
        }
      } catch (err) {
        reportError(
          err,
          OperationType.DELETE,
          roomPath,
          'Oyuncu çıkarılamadı.'
        );
      }
    },
    [activeSession, roomDoc, maybeAdvanceToShuffling, reportError]
  );

  const startGame = useCallback(async () => {
    if (!activeSession || !roomDoc) return;
    if (roomDoc.hostId !== activeSession.playerId) return;
    if (roomDoc.playerOrder.length < 2) {
      setError('Başlamak için en az 2 oyuncu gerekli.');
      return;
    }

    const roomCode = activeSession.roomCode;
    const roomPath = `rooms/${roomCode}`;
    setError(null);

    try {
      const answersSnap = await getDocs(
        query(
          collection(db, 'rooms', roomCode, 'answers'),
          where('roomCode', '==', roomCode)
        )
      );
      const batch = writeBatch(db);
      for (const ans of answersSnap.docs) {
        batch.delete(ans.ref);
      }
      for (const pid of roomDoc.playerOrder) {
        batch.update(doc(db, 'rooms', roomCode, 'players', pid), {
          submittedStepIndex: -1,
          updatedAt: serverTimestamp(),
        });
      }
      batch.update(doc(db, 'rooms', roomCode), {
        screen: 'PLAYING',
        currentStepIndex: 0,
        results: [],
        updatedAt: serverTimestamp(),
      });
      await batch.commit();
    } catch (err) {
      reportError(
        err,
        OperationType.UPDATE,
        roomPath,
        'Oyun başlatılamadı. Lütfen tekrar dene.'
      );
    }
  }, [activeSession, roomDoc, reportError]);

  const submitAnswer = useCallback(
    async (rawText: string) => {
      if (!activeSession || !roomDoc) return;
      if (roomDoc.screen !== 'PLAYING') return;

      const cleanText = sanitizeAnswerText(rawText);
      if (!cleanText) return;

      const { roomCode, playerId } = activeSession;
      const stepIndex = roomDoc.currentStepIndex;
      const step = GAME_STEPS[stepIndex];
      if (!step) return;

      const answerId = `${step.key}_${playerId}`;
      const answerPath = `rooms/${roomCode}/answers/${answerId}`;
      setError(null);

      try {
        const batch = writeBatch(db);
        batch.set(doc(db, 'rooms', roomCode, 'answers', answerId), {
          roomCode,
          stepKey: step.key,
          playerId,
          text: cleanText,
          updatedAt: serverTimestamp(),
        });
        batch.update(doc(db, 'rooms', roomCode, 'players', playerId), {
          submittedStepIndex: stepIndex,
          updatedAt: serverTimestamp(),
        });
        await batch.commit();

        await maybeAdvanceToShuffling(roomCode, stepIndex);
      } catch (err) {
        reportError(
          err,
          OperationType.WRITE,
          answerPath,
          'Cevap gönderilemedi. Lütfen tekrar dene.'
        );
      }
    },
    [activeSession, roomDoc, maybeAdvanceToShuffling, reportError]
  );

  const reshuffle = useCallback(async () => {
    if (!activeSession || !roomDoc) return;
    if (roomDoc.hostId !== activeSession.playerId) return;
    if (roomDoc.screen !== 'RESULTS') return;

    const roomCode = activeSession.roomCode;
    const roomPath = `rooms/${roomCode}`;
    setError(null);

    try {
      const answersSnap = await getDocs(
        query(
          collection(db, 'rooms', roomCode, 'answers'),
          where('roomCode', '==', roomCode)
        )
      );
      const answerDocs = answersSnap.docs.map(
        (d) => d.data() as FirestoreAnswerDoc
      );
      const orderedPlayers = orderRoomPlayers(
        roomDoc.playerOrder,
        playerDocs,
        roomDoc.hostId
      );
      if (orderedPlayers.length < 2) return;

      const builtResults = buildSentences(
        orderedPlayers,
        buildAnswersMapFromDocs(answerDocs)
      );

      await runTransaction(db, async (tx) => {
        const roomRef = doc(db, 'rooms', roomCode);
        const snap = await tx.get(roomRef);
        if (!snap.exists()) return;
        const latest = snap.data() as FirestoreRoomDoc;
        if (latest.screen !== 'RESULTS') return;

        tx.update(roomRef, {
          results: builtResults,
          updatedAt: serverTimestamp(),
        });
      });
    } catch (err) {
      reportError(
        err,
        OperationType.UPDATE,
        roomPath,
        'Cümleler karıştırılamadı.'
      );
    }
  }, [activeSession, roomDoc, playerDocs, reportError]);

  const resetToLobby = useCallback(async () => {
    if (!activeSession || !roomDoc) return;
    if (roomDoc.hostId !== activeSession.playerId) return;

    const roomCode = activeSession.roomCode;
    const roomPath = `rooms/${roomCode}`;
    setError(null);

    try {
      const answersSnap = await getDocs(
        query(
          collection(db, 'rooms', roomCode, 'answers'),
          where('roomCode', '==', roomCode)
        )
      );
      const batch = writeBatch(db);
      for (const ans of answersSnap.docs) {
        batch.delete(ans.ref);
      }
      for (const pid of roomDoc.playerOrder) {
        batch.update(doc(db, 'rooms', roomCode, 'players', pid), {
          submittedStepIndex: -1,
          updatedAt: serverTimestamp(),
        });
      }
      batch.update(doc(db, 'rooms', roomCode), {
        screen: 'LOBBY',
        currentStepIndex: 0,
        results: [],
        updatedAt: serverTimestamp(),
      });
      await batch.commit();
    } catch (err) {
      reportError(
        err,
        OperationType.UPDATE,
        roomPath,
        'Lobiye dönülemedi.'
      );
    }
  }, [activeSession, roomDoc, reportError]);

  return {
    room,
    myPlayerId: activeSession?.playerId ?? null,
    isBusy,
    error,
    clearError,
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
