import test from 'node:test';
import assert from 'node:assert/strict';
import {
  areAllPlayersSubmitted,
  buildAnswersMapFromDocs,
  computeSubmittedPlayerIds,
  createRoomPlayerId,
  generateRoomCode,
  isPermissionDeniedError,
  isValidRoomCode,
  MAX_ANSWER_LENGTH,
  MAX_PLAYER_NAME_LENGTH,
  normalizeRoomCode,
  orderRoomPlayers,
  PLAYER_ID_REGEX,
  sanitizeAnswerText,
  sanitizePlayerName,
} from './roomHelpers.ts';

test('generateRoomCode produces valid 6-character uppercase alphanumeric codes', () => {
  for (let i = 0; i < 20; i++) {
    const code = generateRoomCode();
    assert.equal(code.length, 6);
    assert.equal(isValidRoomCode(code), true);
  }
});

test('normalizeRoomCode strips non-alphanumeric chars and uppercases', () => {
  assert.equal(normalizeRoomCode(' ab-12cd '), 'AB12CD');
  assert.equal(normalizeRoomCode('x9y8z7w6'), 'X9Y8Z7');
});

test('sanitizers enforce blueprint length and whitespace constraints', () => {
  assert.equal(sanitizePlayerName('  Ali   Veli  '), 'Ali Veli');
  assert.equal(
    sanitizePlayerName('a'.repeat(50)).length,
    MAX_PLAYER_NAME_LENGTH
  );
  assert.equal(sanitizeAnswerText('  Mars   yüzeyinde  '), 'Mars yüzeyinde');
  assert.equal(sanitizeAnswerText('b'.repeat(250)).length, MAX_ANSWER_LENGTH);
});

test('createRoomPlayerId matches security rules regex', () => {
  const id = createRoomPlayerId();
  assert.equal(PLAYER_ID_REGEX.test(id), true);
});

test('orderRoomPlayers preserves playerOrder and computes host flag', () => {
  const ordered = orderRoomPlayers(
    ['p2-abcdef', 'p1-abcdef'],
    [
      { id: 'p1-abcdef', name: 'Ali', isHost: true, submittedStepIndex: 0 },
      { id: 'p2-abcdef', name: 'Ayşe', isHost: false, submittedStepIndex: -1 },
    ],
    'p1-abcdef'
  );

  assert.deepEqual(
    ordered.map((p) => ({ id: p.id, isHost: p.isHost })),
    [
      { id: 'p2-abcdef', isHost: false },
      { id: 'p1-abcdef', isHost: true },
    ]
  );
});

test('computeSubmittedPlayerIds and areAllPlayersSubmitted track step progress', () => {
  const docs = [
    { id: 'p1-abcdef', name: 'Ali', isHost: true, submittedStepIndex: 1 },
    { id: 'p2-abcdef', name: 'Ayşe', isHost: false, submittedStepIndex: 0 },
  ];

  assert.deepEqual(
    computeSubmittedPlayerIds(['p1-abcdef', 'p2-abcdef'], docs, 1),
    ['p1-abcdef']
  );
  assert.equal(
    areAllPlayersSubmitted(['p1-abcdef', 'p2-abcdef'], docs, 1),
    false
  );
  assert.equal(
    areAllPlayersSubmitted(
      ['p1-abcdef', 'p2-abcdef'],
      [
        { id: 'p1-abcdef', name: 'Ali', isHost: true, submittedStepIndex: 1 },
        { id: 'p2-abcdef', name: 'Ayşe', isHost: false, submittedStepIndex: 1 },
      ],
      1
    ),
    true
  );
});

test('buildAnswersMapFromDocs maps answers into AnswersMap cleanly', () => {
  const map = buildAnswersMapFromDocs([
    { stepKey: 'KIM', playerId: 'p1-abcdef', text: 'Kedi' },
    { stepKey: 'NEREDE', playerId: 'p2-abcdef', text: 'Ayda' },
  ]);

  assert.equal(map.KIM['p1-abcdef'], 'Kedi');
  assert.equal(map.NEREDE['p2-abcdef'], 'Ayda');
});

test('isPermissionDeniedError detects Firestore permission errors', () => {
  assert.equal(
    isPermissionDeniedError({ code: 'permission-denied', message: 'denied' }),
    true
  );
  assert.equal(
    isPermissionDeniedError(new Error('Missing or insufficient permissions.')),
    true
  );
  assert.equal(isPermissionDeniedError(new Error('Oda bulunamadı.')), false);
});
