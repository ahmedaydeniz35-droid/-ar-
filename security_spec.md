# Security Specification — Kim, Kiminle, Nerede?

## 1. Data Invariants

1. **Room Code Isolation**: `rooms/{roomCode}` must always use a 6-character uppercase alphanumeric ID (`^[A-Z0-9]{6}$`) matching `data.code`. Collection-wide `list` queries on `/rooms` are strictly denied (`allow list: if false`) so rooms cannot be scraped or enumerated.
2. **Master Gate**: No `players/{playerId}` or `answers/{answerId}` document can exist unless its parent `rooms/{roomCode}` exists (`exists(...)` or atomic `existsAfter(...)` during batch room creation).
3. **Secret Answer Isolation**: Secret answer text lives exclusively in `/rooms/{roomCode}/answers/{answerId}`, never inside `rooms/{roomCode}` or `players/{playerId}`. Answers can only be written while `room.screen == 'PLAYING'` and cannot be read while `room.screen == 'LOBBY'`.
4. **State Machine Integrity**:
   - Rooms must be created in `screen == 'LOBBY'`, `currentStepIndex == 0`, `playerOrder.size() == 1`, `results.size() == 0`.
   - `LOBBY -> PLAYING` requires at least 2 players (`playerOrder.size() >= 2`).
   - `PLAYING -> SHUFFLING` preserves `currentStepIndex`.
   - `SHUFFLING -> PLAYING` increments `currentStepIndex` by exactly `1` (only when `currentStepIndex < 3`).
   - `SHUFFLING -> RESULTS` requires `currentStepIndex == 3` and populated `results` (`2..16`).
5. **Bounded Payloads & Temporal Integrity**:
   - Every string (`code`, `hostId`, `playerId`, `name`, `text`) has strict min/max `.size()` bounds matching `firebase-blueprint.json`.
   - `playerOrder` and `results` are strictly bounded to `<= 16` items.
   - `createdAt`, `joinedAt`, and `updatedAt` must equal `request.time`; `code`, `createdAt`, `player.id`, `player.joinedAt`, `answer.stepKey`, `answer.playerId` are immutable once created.

## 2. The "Dirty Dozen" Attack Payloads (All Must Fail with `PERMISSION_DENIED`)

1. **Room Enumeration**: `getDocs(collection(db, 'rooms'))` -> Denied by `allow list: if false`.
2. **Invalid Room Code ID Poisoning**: `setDoc(doc(db, 'rooms', 'x'.repeat(300)), ...)` -> Denied by `isValidRoomCode(roomCode)`.
3. **Shadow Field Injection on Room Create**: `{ code: 'ABCDEF', hostId: 'player-1234', ..., isAdmin: true }` -> Denied by `keys().hasOnly(...)`.
4. **Room State Shortcutting on Create**: Creating a room directly in `screen: 'RESULTS'` with pre-filled `results` -> Denied by `incoming().screen == 'LOBBY'`.
5. **Solo Game Start Bypass**: Updating `screen: 'PLAYING'` when `playerOrder.size() == 1` -> Denied by `existing().playerOrder.size() >= 2`.
6. **Step Skip Attack**: Updating `SHUFFLING` (`currentStepIndex: 0`) directly to `PLAYING` with `currentStepIndex: 3` -> Denied by `incoming().currentStepIndex == existing().currentStepIndex + 1`.
7. **Client Timestamp Forgery**: Setting `updatedAt: new Date(0)` instead of `serverTimestamp()` -> Denied by `incoming().updatedAt == request.time`.
8. **Immutable Field Mutation**: Updating `rooms/ABCDEF` to change `code` or `createdAt` -> Denied by immutability guards + `affectedKeys().hasOnly(...)`.
9. **Oversized Player Name (Denial of Wallet)**: Setting `players/{id}.name` to a 5,000-char string -> Denied by `data.name.size() <= 32`.
10. **Orphaned Player Creation**: Creating `/rooms/NOPE99/players/player-1234` when `/rooms/NOPE99` does not exist -> Denied by `existsAfter(...)`.
11. **Answer Text Injection Outside Playing Phase**: Writing `/rooms/ABCDEF/answers/KIM_player-1234` when `screen == 'LOBBY'` -> Denied by `getRoom(roomCode).data.screen == 'PLAYING'`.
12. **Answer Shadow Key / Oversized Text**: Writing `answers/KIM_player-1234` with `text` > 160 chars or extra field `cheated: true` -> Denied by `isValidRoomAnswer(...)`.
