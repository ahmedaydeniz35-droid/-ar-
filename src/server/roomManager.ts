import { randomBytes, randomUUID } from 'node:crypto';
import { GAME_STEPS } from '../types/game.ts';
import type {
  AnswersMap,
  RoomPlayer,
  RoomSnapshot,
  ScreenState,
  SentenceResult,
} from '../types/game.ts';
import { buildSentences, createEmptyAnswers } from '../utils/shuffler.ts';

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_PLAYERS_PER_ROOM = 16;
const MAX_NAME_LENGTH = 32;
const MAX_ANSWER_LENGTH = 160;

export interface ServerPlayer extends RoomPlayer {
  token: string;
}

export interface ServerRoom {
  code: string;
  hostId: string;
  screen: ScreenState;
  players: ServerPlayer[];
  currentStepIndex: number;
  answers: AnswersMap;
  results: SentenceResult[];
  createdAt: number;
  updatedAt: number;
}

export class RoomError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

function generateRoomCode(existingCodes: Set<string>): string {
  for (let attempt = 0; attempt < 100; attempt++) {
    const bytes = randomBytes(6);
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += ROOM_CODE_ALPHABET[bytes[i] % ROOM_CODE_ALPHABET.length];
    }
    if (!existingCodes.has(code)) {
      return code;
    }
  }
  return randomBytes(3).toString('hex').toUpperCase();
}

function sanitizeName(rawName: string): string {
  return rawName.trim().slice(0, MAX_NAME_LENGTH);
}

function sanitizeAnswer(rawAnswer: string): string {
  return rawAnswer.trim().slice(0, MAX_ANSWER_LENGTH);
}

export class RoomManager {
  private rooms = new Map<string, ServerRoom>();

  getRoom(roomCode: string): ServerRoom | undefined {
    return this.rooms.get(roomCode.trim().toUpperCase());
  }

  getRoomCount(): number {
    return this.rooms.size;
  }

  createRoom(playerName: string): { room: ServerRoom; player: ServerPlayer } {
    const cleanName = sanitizeName(playerName);
    if (!cleanName) {
      throw new RoomError('INVALID_NAME', 'Lütfen adını yaz.');
    }

    const code = generateRoomCode(new Set(this.rooms.keys()));
    const hostPlayer: ServerPlayer = {
      id: randomUUID(),
      token: randomBytes(16).toString('hex'),
      name: cleanName,
      isHost: true,
      connected: true,
    };

    const now = Date.now();
    const room: ServerRoom = {
      code,
      hostId: hostPlayer.id,
      screen: 'LOBBY',
      players: [hostPlayer],
      currentStepIndex: 0,
      answers: createEmptyAnswers(),
      results: [],
      createdAt: now,
      updatedAt: now,
    };

    this.rooms.set(code, room);
    return { room, player: hostPlayer };
  }

  joinRoom(
    roomCode: string,
    playerName: string,
    playerToken?: string
  ): { room: ServerRoom; player: ServerPlayer; reconnected: boolean } {
    const normalizedCode = roomCode.trim().toUpperCase();
    const room = this.rooms.get(normalizedCode);
    if (!room) {
      throw new RoomError('ROOM_NOT_FOUND', 'Oda bulunamadı. Kodu kontrol et.');
    }

    if (playerToken) {
      const existing = room.players.find((p) => p.token === playerToken);
      if (existing) {
        existing.connected = true;
        const cleanName = sanitizeName(playerName);
        if (cleanName && room.screen === 'LOBBY') {
          existing.name = cleanName;
        }
        room.updatedAt = Date.now();
        return { room, player: existing, reconnected: true };
      }
    }

    if (room.screen !== 'LOBBY') {
      throw new RoomError(
        'ROOM_IN_PROGRESS',
        'Oyun şu anda devam ediyor. Yeni turda katılabilirsin.'
      );
    }

    if (room.players.length >= MAX_PLAYERS_PER_ROOM) {
      throw new RoomError(
        'ROOM_FULL',
        `Oda dolu (en fazla ${MAX_PLAYERS_PER_ROOM} kişi).`
      );
    }

    const cleanName = sanitizeName(playerName);
    if (!cleanName) {
      throw new RoomError('INVALID_NAME', 'Lütfen adını yaz.');
    }

    const player: ServerPlayer = {
      id: randomUUID(),
      token: randomBytes(16).toString('hex'),
      name: cleanName,
      isHost: false,
      connected: true,
    };

    room.players.push(player);
    room.updatedAt = Date.now();
    return { room, player, reconnected: false };
  }

  reconnectRoom(
    roomCode: string,
    playerToken: string
  ): { room: ServerRoom; player: ServerPlayer } {
    const normalizedCode = roomCode.trim().toUpperCase();
    const room = this.rooms.get(normalizedCode);
    if (!room) {
      throw new RoomError('ROOM_NOT_FOUND', 'Oda artık mevcut değil.');
    }

    const existing = room.players.find((p) => p.token === playerToken);
    if (!existing) {
      throw new RoomError('SESSION_EXPIRED', 'Oturumun sona ermiş.');
    }

    existing.connected = true;
    room.updatedAt = Date.now();
    return { room, player: existing };
  }

  setPlayerConnected(
    roomCode: string,
    playerId: string,
    connected: boolean
  ): ServerRoom | undefined {
    const room = this.getRoom(roomCode);
    if (!room) return undefined;
    const player = room.players.find((p) => p.id === playerId);
    if (!player) return undefined;
    player.connected = connected;
    room.updatedAt = Date.now();
    return room;
  }

  leaveRoom(
    roomCode: string,
    playerId: string
  ): { room?: ServerRoom; becameReadyToShuffle: boolean } {
    const room = this.getRoom(roomCode);
    if (!room) return { room: undefined, becameReadyToShuffle: false };

    const index = room.players.findIndex((p) => p.id === playerId);
    if (index === -1) return { room, becameReadyToShuffle: false };

    room.players.splice(index, 1);

    for (const step of GAME_STEPS) {
      delete room.answers[step.key][playerId];
    }

    if (room.players.length === 0) {
      this.rooms.delete(room.code);
      return { room: undefined, becameReadyToShuffle: false };
    }

    if (room.hostId === playerId) {
      const nextHost =
        room.players.find((p) => p.connected) ?? room.players[0];
      room.hostId = nextHost.id;
      for (const p of room.players) {
        p.isHost = p.id === room.hostId;
      }
    }

    let becameReadyToShuffle = false;

    if (
      (room.screen === 'PLAYING' || room.screen === 'SHUFFLING') &&
      room.players.length < 2
    ) {
      room.screen = 'LOBBY';
      room.currentStepIndex = 0;
      room.answers = createEmptyAnswers();
      room.results = [];
    } else if (room.screen === 'PLAYING' && this.haveAllPlayersSubmitted(room)) {
      room.screen = 'SHUFFLING';
      becameReadyToShuffle = true;
    }

    room.updatedAt = Date.now();
    return { room, becameReadyToShuffle };
  }

  renamePlayer(roomCode: string, playerId: string, rawName: string): ServerRoom {
    const room = this.getRoom(roomCode);
    if (!room) {
      throw new RoomError('ROOM_NOT_FOUND', 'Oda bulunamadı.');
    }
    if (room.screen !== 'LOBBY') {
      throw new RoomError(
        'INVALID_STATE',
        'Oyun başladıktan sonra isim değiştirilemez.'
      );
    }

    const cleanName = sanitizeName(rawName);
    if (!cleanName) {
      throw new RoomError('INVALID_NAME', 'İsim boş bırakılamaz.');
    }

    const player = room.players.find((p) => p.id === playerId);
    if (!player) {
      throw new RoomError('PLAYER_NOT_FOUND', 'Oyuncu bulunamadı.');
    }

    player.name = cleanName;
    room.updatedAt = Date.now();
    return room;
  }

  kickPlayer(
    roomCode: string,
    actorId: string,
    targetPlayerId: string
  ): { room?: ServerRoom; becameReadyToShuffle: boolean } {
    const room = this.getRoom(roomCode);
    if (!room) {
      throw new RoomError('ROOM_NOT_FOUND', 'Oda bulunamadı.');
    }
    if (room.hostId !== actorId) {
      throw new RoomError(
        'FORBIDDEN',
        'Sadece oda yöneticisi oyuncu çıkarabilir.'
      );
    }
    if (actorId === targetPlayerId) {
      throw new RoomError('INVALID_ACTION', 'Kendini odadan çıkaramazsın.');
    }
    return this.leaveRoom(room.code, targetPlayerId);
  }

  startGame(roomCode: string, actorId: string): ServerRoom {
    const room = this.getRoom(roomCode);
    if (!room) {
      throw new RoomError('ROOM_NOT_FOUND', 'Oda bulunamadı.');
    }
    if (room.hostId !== actorId) {
      throw new RoomError(
        'FORBIDDEN',
        'Sadece oda yöneticisi oyunu başlatabilir.'
      );
    }
    if (room.screen !== 'LOBBY') {
      throw new RoomError('INVALID_STATE', 'Oyun zaten devam ediyor.');
    }
    if (room.players.length < 2) {
      throw new RoomError(
        'NOT_ENOUGH_PLAYERS',
        'Başlamak için en az 2 oyuncu gerekir.'
      );
    }

    room.answers = createEmptyAnswers();
    room.results = [];
    room.currentStepIndex = 0;
    room.screen = 'PLAYING';
    room.updatedAt = Date.now();
    return room;
  }

  submitAnswer(
    roomCode: string,
    playerId: string,
    rawText: string
  ): { room: ServerRoom; allSubmitted: boolean } {
    const room = this.getRoom(roomCode);
    if (!room) {
      throw new RoomError('ROOM_NOT_FOUND', 'Oda bulunamadı.');
    }
    if (room.screen !== 'PLAYING') {
      throw new RoomError('INVALID_STATE', 'Şu anda cevap beklenmiyor.');
    }

    const player = room.players.find((p) => p.id === playerId);
    if (!player) {
      throw new RoomError('PLAYER_NOT_FOUND', 'Bu odada değilsin.');
    }

    const cleanText = sanitizeAnswer(rawText);
    if (!cleanText) {
      throw new RoomError('INVALID_ANSWER', 'Lütfen boş olmayan bir cevap yaz.');
    }

    const activeStep = GAME_STEPS[room.currentStepIndex];
    if (!activeStep) {
      throw new RoomError('INVALID_STATE', 'Geçersiz oyun aşaması.');
    }

    room.answers[activeStep.key][player.id] = cleanText;
    room.updatedAt = Date.now();

    const allSubmitted = this.haveAllPlayersSubmitted(room);
    if (allSubmitted) {
      room.screen = 'SHUFFLING';
    }

    return { room, allSubmitted };
  }

  advanceAfterShuffle(roomCode: string): ServerRoom | undefined {
    const room = this.getRoom(roomCode);
    if (!room || room.screen !== 'SHUFFLING') return undefined;

    if (room.currentStepIndex + 1 < GAME_STEPS.length) {
      room.currentStepIndex += 1;
      room.screen = 'PLAYING';
    } else {
      room.results = buildSentences(room.players, room.answers);
      room.screen = 'RESULTS';
    }
    room.updatedAt = Date.now();
    return room;
  }

  reshuffleResults(roomCode: string, actorId: string): ServerRoom {
    const room = this.getRoom(roomCode);
    if (!room) {
      throw new RoomError('ROOM_NOT_FOUND', 'Oda bulunamadı.');
    }
    if (room.hostId !== actorId) {
      throw new RoomError(
        'FORBIDDEN',
        'Sadece oda yöneticisi yeniden karıştırabilir.'
      );
    }
    if (room.screen !== 'RESULTS') {
      throw new RoomError('INVALID_STATE', 'Henüz sonuç aşamasında değiliz.');
    }

    room.results = buildSentences(room.players, room.answers);
    room.updatedAt = Date.now();
    return room;
  }

  resetToLobby(roomCode: string, actorId: string): ServerRoom {
    const room = this.getRoom(roomCode);
    if (!room) {
      throw new RoomError('ROOM_NOT_FOUND', 'Oda bulunamadı.');
    }
    if (room.hostId !== actorId) {
      throw new RoomError(
        'FORBIDDEN',
        'Sadece oda yöneticisi yeni tur başlatabilir.'
      );
    }

    room.screen = 'LOBBY';
    room.currentStepIndex = 0;
    room.answers = createEmptyAnswers();
    room.results = [];
    room.updatedAt = Date.now();
    return room;
  }

  pruneStaleRooms(maxIdleMs: number, now = Date.now()): number {
    let removed = 0;
    for (const [code, room] of this.rooms.entries()) {
      const anyConnected = room.players.some((p) => p.connected);
      const idle = now - room.updatedAt;
      if ((!anyConnected && idle > 5 * 60 * 1000) || idle > maxIdleMs) {
        this.rooms.delete(code);
        removed++;
      }
    }
    return removed;
  }

  toSnapshot(room: ServerRoom): RoomSnapshot {
    const activeStep = GAME_STEPS[room.currentStepIndex];
    const stepAnswers = activeStep ? room.answers[activeStep.key] : {};
    const submittedPlayerIds = room.players
      .filter((p) => Boolean(stepAnswers[p.id]))
      .map((p) => p.id);

    return {
      code: room.code,
      hostId: room.hostId,
      screen: room.screen,
      players: room.players.map(({ id, name, isHost, connected }) => ({
        id,
        name,
        isHost,
        connected,
      })),
      currentStepIndex: room.currentStepIndex,
      submittedPlayerIds,
      results: room.screen === 'RESULTS' ? room.results : [],
    };
  }

  private haveAllPlayersSubmitted(room: ServerRoom): boolean {
    const activeStep = GAME_STEPS[room.currentStepIndex];
    if (!activeStep || room.players.length === 0) return false;
    const stepAnswers = room.answers[activeStep.key];
    return room.players.every((p) => Boolean(stepAnswers[p.id]));
  }
}
