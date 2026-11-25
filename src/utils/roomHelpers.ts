import { createEmptyAnswers } from './shuffler.ts';
import type {
  AnswersMap,
  GameStepKey,
  RoomPlayer,
  ScreenState,
  SentenceResult,
} from '../types/game.ts';

export const ROOM_CODE_LENGTH = 6;
export const ROOM_CODE_REGEX = /^[A-Z0-9]{6}$/;
export const PLAYER_ID_REGEX = /^[a-zA-Z0-9_-]{8,64}$/;
export const MAX_PLAYER_NAME_LENGTH = 32;
export const MAX_ANSWER_LENGTH = 160;
export const MAX_ROOM_PLAYERS = 16;

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export interface FirestoreRoomDoc {
  code: string;
  hostId: string;
  screen: ScreenState;
  currentStepIndex: number;
  playerOrder: string[];
  results: SentenceResult[];
}

export interface FirestorePlayerDoc {
  id: string;
  roomCode?: string;
  name: string;
  isHost: boolean;
  submittedStepIndex: number;
}

export interface FirestoreAnswerDoc {
  roomCode?: string;
  stepKey: GameStepKey;
  playerId: string;
  text: string;
}

export function generateRoomCode(): string {
  let code = '';
  for (let i = 0; i < ROOM_CODE_LENGTH; i++) {
    const idx = Math.floor(Math.random() * CODE_ALPHABET.length);
    code += CODE_ALPHABET[idx];
  }
  return code;
}

export function normalizeRoomCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, ROOM_CODE_LENGTH);
}

export function isValidRoomCode(code: string): boolean {
  return ROOM_CODE_REGEX.test(code);
}

export function sanitizePlayerName(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').slice(0, MAX_PLAYER_NAME_LENGTH);
}

export function sanitizeAnswerText(raw: string): string {
  return raw.trim().replace(/\s+/g, ' ').slice(0, MAX_ANSWER_LENGTH);
}

export function createRoomPlayerId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID().replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 36);
  }
  const randomPart = Math.random().toString(36).slice(2, 10);
  return `p_${Date.now().toString(36)}_${randomPart}`;
}

export function orderRoomPlayers(
  playerOrder: string[],
  docs: FirestorePlayerDoc[],
  hostId: string
): RoomPlayer[] {
  const byId = new Map<string, FirestorePlayerDoc>();
  for (const doc of docs) {
    byId.set(doc.id, doc);
  }

  const ordered: RoomPlayer[] = [];
  for (const id of playerOrder) {
    const doc = byId.get(id);
    if (doc) {
      ordered.push({
        id: doc.id,
        name: doc.name,
        isHost: doc.id === hostId,
        connected: true,
      });
    }
  }
  return ordered;
}

export function computeSubmittedPlayerIds(
  playerOrder: string[],
  docs: FirestorePlayerDoc[],
  currentStepIndex: number
): string[] {
  const orderSet = new Set(playerOrder);
  return docs
    .filter((doc) => orderSet.has(doc.id) && doc.submittedStepIndex >= currentStepIndex)
    .map((doc) => doc.id);
}

export function areAllPlayersSubmitted(
  playerOrder: string[],
  docs: FirestorePlayerDoc[],
  currentStepIndex: number
): boolean {
  if (playerOrder.length < 2) return false;
  const submittedById = new Map<string, number>();
  for (const doc of docs) {
    submittedById.set(doc.id, doc.submittedStepIndex);
  }
  return playerOrder.every(
    (id) => (submittedById.get(id) ?? -1) >= currentStepIndex
  );
}

export function buildAnswersMapFromDocs(
  docs: FirestoreAnswerDoc[]
): AnswersMap {
  const map = createEmptyAnswers();
  for (const doc of docs) {
    if (doc.stepKey in map && doc.playerId && doc.text) {
      map[doc.stepKey][doc.playerId] = doc.text;
    }
  }
  return map;
}

export function isPermissionDeniedError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const code = 'code' in err ? (err as { code?: unknown }).code : undefined;
  const message =
    'message' in err ? String((err as { message?: unknown }).message) : '';
  return (
    code === 'permission-denied' ||
    message.includes('Missing or insufficient permissions') ||
    message.includes('PERMISSION_DENIED')
  );
}
