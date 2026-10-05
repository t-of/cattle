// CPU の思考を別スレッドで行う Worker。main.js を固めないために使う。
// 受け取る: { board (Map), ufos, sheepInHand, phase, timeMs }
// 返す: { move }（rules.mjs の genMoves が返す形の 1 つ、または手がなければ null）

import { buildGraph, genMoves } from './rules.mjs';
import { findBestMove } from './search.mjs';

const graph = buildGraph();

self.onmessage = (e) => {
  const { board, ufos, sheepInHand, phase, timeMs } = e.data;
  const state = { board, ufos, sheepInHand, phase, winner: null };
  const moves = genMoves(graph, state);
  const move = moves.length ? findBestMove(graph, state, timeMs || 1500) : null;
  self.postMessage({ move });
};
