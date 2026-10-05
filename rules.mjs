// cattle のルール（DOM なし・純粋関数）。main.js・CPU の Worker・自己検査テストが共有する。
// 盤はハニカムの頂点・辺のグラフ。駒は board: Map<vertexId, {type:'sheep'} | {type:'ufo', ufo}>。

const HEX = 36; // 六角形の外接半径（px）。座標の見た目だけに使い、ルールには影響しない。

/** ハニカム 19 枚分の頂点・辺・中心を作る。 */
export function buildGraph() {
  /** @type {{id:number, x:number, y:number}[]} */
  const verts = [];
  /** @type {Map<number, Set<number>>} */
  const edges = new Map();
  /** @type {{x:number, y:number}[]} */
  const cells = [];
  const key2id = new Map();
  function vid(x, y) {
    const key = `${Math.round(x * 10)},${Math.round(y * 10)}`;
    let id = key2id.get(key);
    if (id == null) {
      id = verts.length;
      verts.push({ id, x, y });
      edges.set(id, new Set());
      key2id.set(key, id);
    }
    return id;
  }
  function link(a, b) { edges.get(a).add(b); edges.get(b).add(a); }

  for (let q = -2; q <= 2; q++) {
    for (let r = -2; r <= 2; r++) {
      if (Math.abs(q + r) > 2) continue;
      const cx = HEX * Math.sqrt(3) * (q + r / 2);
      const cy = HEX * 1.5 * r;
      cells.push({ x: cx, y: cy });
      const corners = [];
      for (let i = 0; i < 6; i++) {
        const ang = (Math.PI / 180) * (60 * i - 30);
        corners.push(vid(cx + HEX * Math.cos(ang), cy + HEX * Math.sin(ang)));
      }
      for (let i = 0; i < 6; i++) link(corners[i], corners[(i + 1) % 6]);
    }
  }
  return { verts, edges, cells, hex: HEX };
}

/** 飛行物体 1 機が今できること（移動・誘拐・牽引光線）。 */
export function ufoActions(graph, board, pos, loaded) {
  const moves = new Set();
  const abducts = new Set();
  const beams = new Map(); // 羊の点 -> 引き寄せ先（空いた中間点）

  for (const n of graph.edges.get(pos)) {
    const occ = board.get(n);
    if (!occ) {
      moves.add(n);
      for (const s of graph.edges.get(n)) {
        if (s === pos) continue;
        const occS = board.get(s);
        if (occS && occS.type === 'sheep' && !beams.has(s)) beams.set(s, n);
      }
    } else if (occ.type === 'sheep') {
      if (!loaded) abducts.add(n);
      for (const land of graph.edges.get(n)) {
        if (land !== pos && !board.get(land)) moves.add(land);
      }
    }
  }
  for (const k of beams.keys()) if (abducts.has(k)) beams.delete(k);
  return { moves, abducts, beams };
}

export function ufoIsStuck(graph, board, u) {
  const a = ufoActions(graph, board, u.pos, u.loaded);
  return a.moves.size === 0 && a.abducts.size === 0 && a.beams.size === 0;
}

export function sheepMovableFrom(graph, board, pos) {
  return [...graph.edges.get(pos)].filter((n) => !board.get(n));
}

export function sheepHasAnyLegalAction(graph, state) {
  if (state.sheepInHand > 0) return [...graph.verts].some((v) => !state.board.get(v.id));
  for (const [vid, occ] of state.board) {
    if (occ.type === 'sheep' && sheepMovableFrom(graph, state.board, vid).length > 0) return true;
  }
  return false;
}

/** 初期配置（飛行物体 3 機は外周に離して置く）。 */
export function createInitialState(graph) {
  const board = new Map();
  const verts = graph.verts;
  const cx = verts.reduce((s, v) => s + v.x, 0) / verts.length;
  const cy = verts.reduce((s, v) => s + v.y, 0) / verts.length;
  const sorted = verts.map((v) => ({ v, d: Math.hypot(v.x - cx, v.y - cy) })).sort((a, b) => b.d - a.d);
  const outer = sorted.slice(0, Math.max(6, Math.floor(sorted.length * 0.3)))
    .sort((a, b) => Math.atan2(a.v.y - cy, a.v.x - cx) - Math.atan2(b.v.y - cy, b.v.x - cx));
  const pick = [0, 1, 2].map((i) => outer[Math.floor((outer.length * i) / 3)].v.id);

  const ufos = pick.map((pos, i) => ({ id: i, pos, loaded: false }));
  for (const u of ufos) board.set(u.pos, { type: 'ufo', ufo: u });

  const state = { board, ufos, sheepInHand: 10, phase: 'sheep', winner: null };
  return resolveTurnStart(graph, state);
}

/** 手番の初めに、羊が動かせないときの自動パスと、勝敗の確定をまとめて処理する。 */
export function resolveTurnStart(graph, state) {
  if (state.winner) return state;
  if (state.phase === 'sheep' && !sheepHasAnyLegalAction(graph, state)) {
    return endSheepTurn(graph, state);
  }
  return state;
}

function endSheepTurn(graph, state) {
  if (state.ufos.some((u) => ufoIsStuck(graph, state.board, u))) {
    return { ...state, winner: 'sheep' };
  }
  return resolveTurnStart(graph, { ...state, phase: 'ufo' });
}

function endUfoTurn(graph, state) {
  if (state.ufos.every((u) => u.loaded)) {
    return { ...state, winner: 'ufo' };
  }
  return resolveTurnStart(graph, { ...state, phase: 'sheep' });
}

/** state を複製する（board の ufo エントリは複製した ufos を指すよう張り直す）。 */
export function cloneState(state) {
  const ufos = state.ufos.map((u) => ({ ...u }));
  const board = new Map();
  for (const [k, v] of state.board) {
    board.set(k, v.type === 'ufo' ? { type: 'ufo', ufo: ufos[v.ufo.id] } : v);
  }
  return { board, ufos, sheepInHand: state.sheepInHand, phase: state.phase, winner: state.winner };
}

/** 今の手番で選べる手の一覧。state は非終局で、手は必ず 1 つ以上ある。 */
export function genMoves(graph, state) {
  const moves = [];
  if (state.phase === 'sheep') {
    if (state.sheepInHand > 0) {
      for (const v of graph.verts) if (!state.board.get(v.id)) moves.push({ kind: 'place', to: v.id });
    } else {
      for (const [vid, occ] of state.board) {
        if (occ.type !== 'sheep') continue;
        for (const to of sheepMovableFrom(graph, state.board, vid)) moves.push({ kind: 'move', from: vid, to });
      }
    }
  } else {
    for (const u of state.ufos) {
      const a = ufoActions(graph, state.board, u.pos, u.loaded);
      for (const to of a.moves) moves.push({ kind: 'ufoMove', id: u.id, to });
      for (const to of a.abducts) moves.push({ kind: 'ufoAbduct', id: u.id, to });
      for (const [to, mid] of a.beams) moves.push({ kind: 'ufoBeam', id: u.id, to, mid });
    }
  }
  return moves;
}

/** 手を指す。新しい state を返す（手番の進行・自動パス・勝敗判定まで含む）。 */
export function applyMove(graph, state, move) {
  const s = cloneState(state);
  switch (move.kind) {
    case 'place':
      s.board.set(move.to, { type: 'sheep' });
      s.sheepInHand--;
      return endSheepTurn(graph, s);
    case 'move':
      s.board.delete(move.from);
      s.board.set(move.to, { type: 'sheep' });
      return endSheepTurn(graph, s);
    case 'ufoMove': {
      const u = s.ufos[move.id];
      s.board.delete(u.pos);
      u.pos = move.to;
      s.board.set(move.to, { type: 'ufo', ufo: u });
      return endUfoTurn(graph, s);
    }
    case 'ufoAbduct': {
      const u = s.ufos[move.id];
      s.board.delete(move.to);
      s.board.delete(u.pos);
      u.pos = move.to;
      u.loaded = true;
      s.board.set(move.to, { type: 'ufo', ufo: u });
      return endUfoTurn(graph, s);
    }
    case 'ufoBeam':
      s.board.delete(move.to);
      s.board.set(move.mid, { type: 'sheep' });
      return endUfoTurn(graph, s);
    default:
      throw new Error(`unknown move kind: ${move.kind}`);
  }
}
