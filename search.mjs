// cattle の CPU の思考（DOM なし・純粋関数）。rules.mjs の上に立つ。
// 反復深化 + アルファベータ + 置換表（Zobrist ハッシュ）。手番中の同一局面の繰り返しは引き分け扱いにして無限に潜らない。

import { genMoves, applyMove, ufoActions } from './rules.mjs';

const WIN_SCORE = 100000;
const MAX_DEPTH = 8;
const TIME_UP = Symbol('time-up');

// 評価の重み（飛行物体から見て正）。自己検査（node test/cpu-selftest.mjs）で、
// ランダムな相手に両陣営とも大きく勝ち越すことと、1 手詰みを見逃さないことを確かめている。
const W_LOADED = 400; // 連れ去り済みの羊 1 匹
const W_FREE = 20; // 飛行物体の隣の、何も置かれていない点の数（取り囲まれるほど減り、詰みに向かう勾配になる）
const W_MOBILITY = 2; // 飛行物体 1 機の今できる手の数（誘拐・牽引光線も含む、戦術的な補助）
const W_STUCK = 60; // 身動きできない飛行物体がいることの罰（本来は free=0 と重なるが保険として）
const W_HAND = 1; // 羊の手持ち（多いほど羊に展開の余地がある）

// 飛行物体の隣 6 マスのうち、空いているマスの数。取り囲みがどれだけ進んだかの指標。
// moves/abducts/beams の合計（mobility）だけだと「空きマスが羊に変わって誘拐先が増える」ことが
// 相殺してしまい、浅い探索では取り囲みの進み具合が見えない。free はそれを直接数える。
function countFreeNeighbors(graph, board, pos) {
  let free = 0;
  for (const n of graph.edges.get(pos)) if (!board.get(n)) free++;
  return free;
}

function baseEvalForUfo(graph, state) {
  let score = state.ufos.filter((u) => u.loaded).length * W_LOADED;
  for (const u of state.ufos) {
    const a = ufoActionsOf(graph, state, u);
    const mobility = a.moves.size + a.abducts.size * 2 + a.beams.size;
    score += countFreeNeighbors(graph, state.board, u.pos) * W_FREE;
    score += mobility * W_MOBILITY;
    if (mobility === 0) score -= W_STUCK;
  }
  score -= state.sheepInHand * W_HAND;
  return score;
}

function ufoActionsOf(graph, state, u) { return ufoActions(graph, state.board, u.pos, u.loaded); }

function evaluate(graph, state) {
  const forUfo = baseEvalForUfo(graph, state);
  return state.phase === 'ufo' ? forUfo : -forUfo;
}

// ---- Zobrist ハッシュ（置換表・千日手の検出に使う） ----

let zobrist = null;
function rand32() { return (Math.random() * 0x100000000) >>> 0; }
function getZobrist(graph) {
  if (zobrist && zobrist.n === graph.verts.length) return zobrist;
  const n = graph.verts.length;
  const sheep = new Array(n).fill(0).map(rand32);
  const ufo = new Array(n).fill(0).map(() => [rand32(), rand32(), rand32()]);
  const loaded = [rand32(), rand32(), rand32()];
  const hand = new Array(11).fill(0).map(rand32);
  const side = rand32();
  zobrist = { n, sheep, ufo, loaded, hand, side };
  return zobrist;
}

function hashState(graph, state) {
  const z = getZobrist(graph);
  let h = 0;
  for (const [vid, occ] of state.board) {
    h ^= occ.type === 'sheep' ? z.sheep[vid] : z.ufo[vid][occ.ufo.id];
  }
  for (const u of state.ufos) if (u.loaded) h ^= z.loaded[u.id];
  h ^= z.hand[state.sheepInHand];
  if (state.phase === 'ufo') h ^= z.side;
  return h >>> 0;
}

// 誘拐・牽引光線・移動の順に並べる（枝刈りが効きやすいよう、進展の大きい手を先に試す）。置換表の最善手があれば先頭へ。
function orderMoves(moves, hintMove) {
  const rank = { ufoAbduct: 0, ufoBeam: 1, place: 2, move: 2, ufoMove: 3 };
  moves.sort((a, b) => (rank[a.kind] ?? 2) - (rank[b.kind] ?? 2));
  if (hintMove) {
    const i = moves.findIndex((m) => sameMove(m, hintMove));
    if (i > 0) { const [m] = moves.splice(i, 1); moves.unshift(m); }
  }
  return moves;
}
function sameMove(a, b) {
  return a.kind === b.kind && a.to === b.to && a.id === b.id && a.from === b.from;
}

function negamax(graph, state, depth, alpha, beta, ply, deadline, path, tt) {
  if (Date.now() > deadline) throw TIME_UP;

  const key = hashState(graph, state);
  if (path.includes(key)) return 0; // 探索中に同じ局面へ戻ってきたら引き分け扱い（無限に潜らない）

  const entry = tt.get(key);
  if (entry && entry.depth >= depth) return entry.value;

  if (depth === 0) {
    const v = evaluate(graph, state);
    tt.set(key, { depth, value: v, move: null });
    return v;
  }

  const moves = orderMoves(genMoves(graph, state), entry && entry.move);
  path.push(key);
  let best = -Infinity;
  let bestMove = null;
  for (const m of moves) {
    const child = applyMove(graph, state, m);
    const val = child.winner
      ? (child.winner === state.phase ? WIN_SCORE - ply - 1 : -(WIN_SCORE - ply - 1))
      : -negamax(graph, child, depth - 1, -beta, -alpha, ply + 1, deadline, path, tt);
    if (val > best) { best = val; bestMove = m; }
    if (best > alpha) alpha = best;
    if (alpha >= beta) break;
  }
  path.pop();
  tt.set(key, { depth, value: best, move: bestMove });
  return best;
}

/**
 * 今の state での最善手を返す。timeMs をおおよその時間制限にして反復深化する。
 * state.phase 側の手を 1 つ返す（genMoves(graph, state) の要素のどれか）。
 */
export function findBestMove(graph, state, timeMs) {
  const moves = genMoves(graph, state);
  if (moves.length === 1) return moves[0];

  const deadline = Date.now() + Math.max(10, timeMs);
  const tt = new Map();
  let bestMove = moves[0];

  for (let depth = 1; depth <= MAX_DEPTH; depth++) {
    const path = [hashState(graph, state)];
    let alpha = -Infinity;
    const beta = Infinity;
    let depthBest = null;
    let depthBestVal = -Infinity;
    try {
      const ordered = orderMoves(moves.slice(), bestMove);
      for (const m of ordered) {
        const child = applyMove(graph, state, m);
        const val = child.winner
          ? (child.winner === state.phase ? WIN_SCORE - 1 : -(WIN_SCORE - 1))
          : -negamax(graph, child, depth - 1, -beta, -alpha, 1, deadline, path, tt);
        if (val > depthBestVal) { depthBestVal = val; depthBest = m; }
        if (depthBestVal > alpha) alpha = depthBestVal;
      }
    } catch (e) {
      if (e !== TIME_UP) throw e;
      break; // この深さは最後まで調べられなかった。1 つ前の深さの結果を使う
    }
    bestMove = depthBest;
    if (Math.abs(depthBestVal) >= WIN_SCORE - 1000) break; // 勝ち負けが確定したので十分
    if (Date.now() > deadline) break;
  }
  return bestMove;
}
