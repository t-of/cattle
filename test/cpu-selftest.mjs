// cattle の自己検査。ブラウザなしで node だけで動く。
//   node test/cpu-selftest.mjs
//
// 確かめること:
//  1. ルールの基本（初期配置・手の生成）が既存の仕様どおりであること
//  2. CPU がランダムな相手に、飛行物体側・羊側どちらでも大きく勝ち越すこと
//  3. 1 手で勝てる局面では、その勝ちの手を選ぶこと

import assert from 'node:assert/strict';
import { buildGraph, createInitialState, genMoves, applyMove } from '../rules.mjs';
import { findBestMove } from '../search.mjs';

const graph = buildGraph();

// ---- 1. ルールの基本 ----

{
  const s = createInitialState(graph);
  assert.equal(s.sheepInHand, 10, '羊は 10 匹から始まる');
  assert.equal(s.ufos.length, 3, '飛行物体は 3 機');
  assert.equal(s.phase, 'sheep', '最初は羊の番');
  assert.equal(s.winner, null);
  for (const u of s.ufos) assert.equal(s.board.get(u.pos).type, 'ufo', '飛行物体は盤に置かれている');

  const moves = genMoves(graph, s);
  assert.equal(moves.length, graph.verts.length - 3, '空いている点の数だけ置ける');
  assert.ok(moves.every((m) => m.kind === 'place'));
}

console.log('ok: ルールの基本');

// ---- 2. ランダムな相手に大きく勝ち越す ----

function randomMove(state) {
  const moves = genMoves(graph, state);
  return moves[Math.floor(Math.random() * moves.length)];
}

/** cpuSide（'sheep' か 'ufo'）を CPU が担当し、もう一方はランダムに指す。勝者 or null（手数切れ）を返す。 */
function playGame(cpuSide, cpuTimeMs, maxPlies) {
  let state = createInitialState(graph);
  for (let ply = 0; ply < maxPlies; ply++) {
    if (state.winner) return state.winner;
    const move = state.phase === cpuSide ? findBestMove(graph, state, cpuTimeMs) : randomMove(state);
    state = applyMove(graph, state, move);
  }
  return state.winner; // null なら決着がつかなかった
}

function runMatch(cpuSide, games, cpuTimeMs, maxPlies) {
  let cpuWins = 0, opponentWins = 0, undecided = 0;
  for (let i = 0; i < games; i++) {
    const w = playGame(cpuSide, cpuTimeMs, maxPlies);
    if (w === cpuSide) cpuWins++;
    else if (w == null) undecided++;
    else opponentWins++;
  }
  return { cpuWins, opponentWins, undecided };
}

const GAMES = 8;
const CPU_TIME_MS = 40; // 自己検査は短い時間制限でよい
const MAX_PLIES = 800; // 羊が飛行物体を取り囲んで詰ますには手数がかかることがある

for (const cpuSide of ['ufo', 'sheep']) {
  const r = runMatch(cpuSide, GAMES, CPU_TIME_MS, MAX_PLIES);
  console.log(`CPU=${cpuSide}: ${JSON.stringify(r)}`);
  const decided = GAMES - r.undecided;
  assert.ok(decided >= GAMES * 0.6, `${cpuSide}: 決着がついた対局が少なすぎる`);
  assert.ok(r.cpuWins / decided >= 0.75, `${cpuSide}: ランダムな相手への勝率が低すぎる`);
}

console.log('ok: ランダムな相手に大きく勝ち越す');

// ---- 3. 1 手で勝てる局面では勝ちの手を選ぶ ----

{
  // 飛行物体 2 機はすでに羊を連れ去り済み。残り 1 機が隣の羊を誘拐すれば 3 機とも連れ去り完了で勝ち。
  const s = createInitialState(graph);
  const [u0, u1, u2] = s.ufos;
  u0.loaded = true;
  u1.loaded = true;
  s.phase = 'ufo';
  // u2 の隣に羊を 1 匹置く
  const neighbor = [...graph.edges.get(u2.pos)][0];
  s.board.set(neighbor, { type: 'sheep' });

  const move = findBestMove(graph, s, 200);
  assert.equal(move.kind, 'ufoAbduct', '勝てる誘拐を選ぶはず');
  assert.equal(move.id, u2.id);
  const next = applyMove(graph, s, move);
  assert.equal(next.winner, 'ufo', 'この一手で飛行物体の勝ちになるはず');
}

console.log('ok: 1 手詰みを見逃さない');

console.log('全部 OK');
