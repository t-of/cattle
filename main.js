import { createBoard3D } from './board3d.js';

// cattle: ハニカムの頂点を点・辺とする盤での非対称 2 人対戦（同じ端末で交互に操作）。
// localStorage は使わない（記録を残さない試作のため）。

WebAppKit.init({ title: 'cattle', text: 'ハニカムの盤で羊10匹と飛行物体3機が対戦する2人用ボードゲーム。' });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

// ---- 盤（ハニカムの頂点・辺）を作る ----

const HEX = 36; // 六角形の外接半径（px）

/** @type {{id:number, x:number, y:number}[]} */
const verts = [];
/** @type {Map<number, Set<number>>} */
const edges = new Map();
/** @type {{x:number, y:number}[]} 六角形の中心（3D の地面用） */
const cells = [];

(function buildBoard() {
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

  // 六角形 19 枚（中心 1 + 周り 6 + 外周 12）を軸座標 q,r（|q|,|r|,|q+r| <= 2）で並べる。
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
})();

const CX = verts.reduce((s, v) => s + v.x, 0) / verts.length;
const CY = verts.reduce((s, v) => s + v.y, 0) / verts.length;

// ---- ゲームの状態 ----

/** @type {Map<number, {type:'sheep'} | {type:'ufo', ufo:object}>} */
let board;
let ufos; // [{id,pos,loaded}]
let sheepInHand;
let phase; // 'sheep' | 'ufo'
let selected; // null | {kind:'sheep', id} | {kind:'ufo', id}
let winner; // null | 'sheep' | 'ufo'
let notice;

function newGame() {
  board = new Map();
  sheepInHand = 10;
  winner = null;
  selected = null;
  notice = '';

  // 外周に近い点を 3 つ、できるだけ離して飛行物体の初期位置にする。
  const sorted = verts.map((v) => ({ v, d: Math.hypot(v.x - CX, v.y - CY) })).sort((a, b) => b.d - a.d);
  const outer = sorted.slice(0, Math.max(6, Math.floor(sorted.length * 0.3)))
    .sort((a, b) => Math.atan2(a.v.y - CY, a.v.x - CX) - Math.atan2(b.v.y - CY, b.v.x - CX));
  const pick = [0, 1, 2].map((i) => outer[Math.floor((outer.length * i) / 3)].v.id);

  ufos = pick.map((pos, i) => ({ id: i, pos, loaded: false }));
  for (const u of ufos) board.set(u.pos, { type: 'ufo', ufo: u });

  startSheepTurn();
}

// ---- 飛行物体 1 機が今できること ----

// 六角格子なので「直線」は続かない（隣り合う辺は 120° ずつ向きが変わる）。
// 仕様の「その先」「2 歩先」は、辺でたどれる隣接関係として扱う。
function ufoActions(pos, loaded) {
  const moves = new Set();
  const abducts = new Set();
  const beams = new Map(); // 羊の点 -> 引き寄せ先（空いた中間点）

  for (const n of edges.get(pos)) {
    const occ = board.get(n);
    if (!occ) {
      moves.add(n); // ふつうの移動
      for (const s of edges.get(n)) { // 牽引光線: 空いた隣の、さらに隣の羊
        if (s === pos) continue;
        const occS = board.get(s);
        if (occS && occS.type === 'sheep' && !beams.has(s)) beams.set(s, n);
      }
    } else if (occ.type === 'sheep') {
      if (!loaded) abducts.add(n); // 誘拐
      for (const land of edges.get(n)) { // ジャンプの着地点（羊の隣で元の点ではない）
        if (land !== pos && !board.get(land)) moves.add(land);
      }
    }
  }
  for (const k of beams.keys()) if (abducts.has(k)) beams.delete(k); // 隣の羊は誘拐を優先
  return { moves, abducts, beams };
}

function ufoIsStuck(u) {
  const a = ufoActions(u.pos, u.loaded);
  return a.moves.size === 0 && a.abducts.size === 0 && a.beams.size === 0;
}

function sheepMovableFrom(pos) {
  return [...edges.get(pos)].filter((n) => !board.get(n));
}

function sheepHasAnyLegalAction() {
  if (sheepInHand > 0) return [...verts].some((v) => !board.get(v.id)); // 置ける空きがある
  for (const [vidKey, occ] of board) {
    if (occ.type === 'sheep' && sheepMovableFrom(vidKey).length > 0) return true;
  }
  return false;
}

// ---- 手番の進行 ----

function startSheepTurn() {
  phase = 'sheep';
  selected = null;
  if (!sheepHasAnyLegalAction()) {
    notice = '羊は動かせないのでパス。';
    endSheepTurn();
    return;
  }
  render();
}
function endSheepTurn() {
  if (ufos.some(ufoIsStuck)) { winner = 'sheep'; render(); return; }
  phase = 'ufo';
  selected = null;
  render();
}
function endUfoTurn() {
  if (ufos.every((u) => u.loaded)) { winner = 'ufo'; render(); return; }
  startSheepTurn();
}

// ---- 操作 ----

function onVertexTap(v) {
  if (winner) return;
  const occ = board.get(v);

  if (phase === 'sheep') {
    if (sheepInHand > 0) {
      if (!occ) {
        board.set(v, { type: 'sheep' });
        sheepInHand--;
        notice = '';
        endSheepTurn();
      }
      return;
    }
    if (selected && selected.kind === 'sheep') {
      if (sheepMovableFrom(selected.id).includes(v)) {
        board.delete(selected.id);
        board.set(v, { type: 'sheep' });
        notice = '';
        endSheepTurn();
        return;
      }
    }
    if (occ && occ.type === 'sheep' && sheepMovableFrom(v).length > 0) {
      selected = { kind: 'sheep', id: v };
      render();
      return;
    }
    selected = null;
    render();
    return;
  }

  // phase === 'ufo'
  if (selected && selected.kind === 'ufo') {
    const u = ufos[selected.id];
    const a = ufoActions(u.pos, u.loaded);
    if (a.moves.has(v)) {
      board.delete(u.pos);
      u.pos = v;
      board.set(v, { type: 'ufo', ufo: u });
      notice = '';
      selected = null;
      endUfoTurn();
      return;
    }
    if (a.abducts.has(v)) {
      board.delete(v);
      board.delete(u.pos);
      u.pos = v;
      u.loaded = true;
      board.set(v, { type: 'ufo', ufo: u });
      notice = '';
      selected = null;
      endUfoTurn();
      return;
    }
    if (a.beams.has(v)) {
      const mid = a.beams.get(v);
      board.delete(v);
      board.set(mid, { type: 'sheep' });
      notice = '';
      selected = null;
      endUfoTurn();
      return;
    }
  }
  if (occ && occ.type === 'ufo') {
    selected = { kind: 'ufo', id: occ.ufo.id };
    render();
    return;
  }
  selected = null;
  render();
}

// ---- 画面 ----

const stage = document.getElementById('stage');
stage.innerHTML = `
  <div class="board-wrap">
    <div class="hud">
      <p class="hud__turn" id="turnLabel"></p>
      <p class="hud__sub" id="subLabel"></p>
    </div>
    <div id="board3d" class="board"></div>
    <p class="notice" id="notice"></p>
    <div class="win-overlay" id="winOverlay" hidden>
      <p class="win-text" id="winText"></p>
      <button class="pill pill--accent" id="again">もう一度</button>
    </div>
  </div>
`;
const turnLabel = document.getElementById('turnLabel');
const subLabel = document.getElementById('subLabel');
const noticeEl = document.getElementById('notice');
const winOverlay = document.getElementById('winOverlay');
const winText = document.getElementById('winText');
document.getElementById('again').addEventListener('click', newGame);

const draw3D = createBoard3D(document.getElementById('board3d'), { verts, edges, cells, hex: HEX }, onVertexTap);

function render() {
  const a = selected && selected.kind === 'ufo' ? ufoActions(ufos[selected.id].pos, ufos[selected.id].loaded) : null;
  const moveSet = a ? a.moves : new Set();
  const abductSet = a ? a.abducts : new Set();
  const beamSet = a ? new Set(a.beams.keys()) : new Set();
  const sheepMoveSet = selected && selected.kind === 'sheep' ? new Set(sheepMovableFrom(selected.id)) : new Set();

  draw3D({ board, selected, moveSet: new Set([...moveSet, ...sheepMoveSet]), abductSet, beamSet });

  const abducted = ufos.filter((u) => u.loaded).length;
  if (winner) {
    turnLabel.textContent = winner === 'sheep' ? '羊の勝ち' : '飛行物体の勝ち';
    subLabel.textContent = '';
    winText.textContent = winner === 'sheep' ? '飛行物体が動けなくなりました。羊の勝ち！' : '飛行物体が羊を 3 匹連れ去りました。飛行物体の勝ち！';
    winOverlay.hidden = false;
  } else {
    winOverlay.hidden = true;
    turnLabel.textContent = phase === 'sheep' ? '羊の番' : '飛行物体の番';
    subLabel.textContent = `手元の羊 ${sheepInHand} 匹 ・ 連れ去られた羊 ${abducted}/3`;
  }
  noticeEl.textContent = notice;
}

newGame();
