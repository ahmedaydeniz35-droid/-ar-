import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSentences, createEmptyAnswers } from './shuffler.ts';

test('buildSentences guarantees no player receives their own kiminle/nerede/neYapiyor when >= 2 players', () => {
  const players = [
    { id: 'p1', name: 'Ali' },
    { id: 'p2', name: 'Veli' },
    { id: 'p3', name: 'Ayşe' },
  ];
  const answers = createEmptyAnswers();
  for (const p of players) {
    answers.KIM[p.id] = `kim-${p.id}`;
    answers.KIMINLE[p.id] = `kiminle-${p.id}`;
    answers.NEREDE[p.id] = `nerede-${p.id}`;
    answers.NE_YAPIYOR[p.id] = `neyapiyor-${p.id}`;
  }

  for (let round = 0; round < 20; round++) {
    const results = buildSentences(players, answers);
    assert.equal(results.length, 3);
    results.forEach((res, idx) => {
      const pid = players[idx].id;
      assert.equal(res.readerName, players[idx].name);
      assert.equal(res.kim, `kim-${pid}`);
      assert.notEqual(res.kiminle, `kiminle-${pid}`);
      assert.notEqual(res.nerede, `nerede-${pid}`);
      assert.notEqual(res.neYapiyor, `neyapiyor-${pid}`);
      assert.ok(res.fullText.includes(res.kim));
    });
  }
});
