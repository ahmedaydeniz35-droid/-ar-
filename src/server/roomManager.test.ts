import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomError, RoomManager } from './roomManager.ts';

test('full multiplayer round flow from room creation to results and reset', () => {
  const manager = new RoomManager();

  const { room: created, player: host } = manager.createRoom('Ahmet');
  assert.equal(created.players.length, 1);
  assert.equal(host.isHost, true);

  const { player: guest } = manager.joinRoom(created.code, 'Zeynep');
  assert.equal(created.players.length, 2);
  assert.equal(guest.isHost, false);

  // Non-host cannot start
  assert.throws(
    () => manager.startGame(created.code, guest.id),
    (err: unknown) => err instanceof RoomError && err.code === 'FORBIDDEN'
  );

  // Host starts game
  manager.startGame(created.code, host.id);
  assert.equal(created.screen, 'PLAYING');
  assert.equal(created.currentStepIndex, 0);

  // Snapshot during PLAYING hides answers and only exposes submittedPlayerIds
  let snap = manager.toSnapshot(created);
  assert.deepEqual(snap.submittedPlayerIds, []);
  assert.deepEqual(snap.results, []);
  assert.equal('token' in snap.players[0], false);

  // Play all 4 steps
  for (let step = 0; step < 4; step++) {
    const r1 = manager.submitAnswer(created.code, host.id, `H-${step}`);
    assert.equal(r1.allSubmitted, false);
    assert.equal(created.screen, 'PLAYING');

    snap = manager.toSnapshot(created);
    assert.deepEqual(snap.submittedPlayerIds, [host.id]);

    const r2 = manager.submitAnswer(created.code, guest.id, `Z-${step}`);
    assert.equal(r2.allSubmitted, true);
    assert.equal(created.screen, 'SHUFFLING');

    manager.advanceAfterShuffle(created.code);
    if (step < 3) {
      assert.equal(created.screen, 'PLAYING');
      assert.equal(created.currentStepIndex, step + 1);
    } else {
      assert.equal(created.screen, 'RESULTS');
    }
  }

  snap = manager.toSnapshot(created);
  assert.equal(snap.results.length, 2);

  // Host reshuffles and resets
  manager.reshuffleResults(created.code, host.id);
  assert.equal(created.results.length, 2);

  manager.resetToLobby(created.code, host.id);
  assert.equal(created.screen, 'LOBBY');
  assert.equal(created.results.length, 0);
});

test('reconnection preserves player seat and host transfers on leave', () => {
  const manager = new RoomManager();
  const { room, player: host } = manager.createRoom('Ahmet');
  const { player: guest } = manager.joinRoom(room.code, 'Zeynep');

  manager.setPlayerConnected(room.code, guest.id, false);
  assert.equal(room.players[1].connected, false);

  const reconnected = manager.reconnectRoom(room.code, guest.token);
  assert.equal(reconnected.player.id, guest.id);
  assert.equal(reconnected.player.connected, true);

  // Host leaves -> Zeynep becomes host
  manager.leaveRoom(room.code, host.id);
  assert.equal(room.players.length, 1);
  assert.equal(room.hostId, guest.id);
  assert.equal(room.players[0].isHost, true);

  // Last player leaves -> room deleted
  manager.leaveRoom(room.code, guest.id);
  assert.equal(manager.getRoomCount(), 0);
});

test('leaving mid-step triggers shuffle if remaining players have all submitted', () => {
  const manager = new RoomManager();
  const { room, player: p1 } = manager.createRoom('Ali');
  const { player: p2 } = manager.joinRoom(room.code, 'Veli');
  const { player: p3 } = manager.joinRoom(room.code, 'Can');

  manager.startGame(room.code, p1.id);
  manager.submitAnswer(room.code, p1.id, 'Kedi');
  manager.submitAnswer(room.code, p2.id, 'Kuş');

  const outcome = manager.leaveRoom(room.code, p3.id);
  assert.equal(outcome.becameReadyToShuffle, true);
  assert.equal(room.screen, 'SHUFFLING');
});
