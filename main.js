import { createBoard3D } from './board3d.js';
import { buildGraph, createInitialState, applyMove, ufoActions, sheepMovableFrom } from './rules.mjs';

// cattle: ハニカムの頂点を点・辺とする盤での非対称 2 人対戦。
// 2 人で同じ端末を交互に操作するほか、CPU（飛行物体側 or 羊側）とも対戦できる。
// ルールの中身（合法手・手の適用・勝敗）は rules.mjs に持たせ、CPU の Worker（cpu.js）・
// 自己検査テスト（test/cpu-selftest.mjs）と共有する。main.js はここでは盤と手番の UI だけを持つ。

WebAppKit.init({ title: 'cattle', text: 'ハニカムの盤で羊10匹と飛行物体3機が対戦する2人用ボードゲーム。CPU 対戦あり。' });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

const graph = buildGraph();

// ---- 対戦方式 ----

function loadMode() {
  try {
    const v = localStorage.getItem('cattle.mode');
    if (v === 'pvp' || v === 'cpu-ufo' || v === 'cpu-sheep') return v;
  } catch { /* 読めなくても既定を使う */ }
  return 'cpu-ufo';
}
function saveMode(v) {
  try { localStorage.setItem('cattle.mode', v); } catch { /* 容量超過・プライベートモードなどは諦める */ }
}

let mode = loadMode(); // 'pvp' | 'cpu-ufo'（CPU が飛行物体） | 'cpu-sheep'（CPU が羊）
function cpuControls(phase) {
  return (mode === 'cpu-ufo' && phase === 'ufo') || (mode === 'cpu-sheep' && phase === 'sheep');
}

// ---- ゲームの状態 ----

/** @type {{board:Map, ufos:object[], sheepInHand:number, phase:'sheep'|'ufo', winner:string|null}} */
let state;
let selected; // null | {kind:'sheep', id} | {kind:'ufo', id}
let notice;
let cpuThinking = false;
let cpuWorker = null;

function newGame() {
  state = createInitialState(graph);
  selected = null;
  notice = '';
  cpuThinking = false;
  render();
  maybeRunCpu();
}

function getWorker() {
  if (!cpuWorker) cpuWorker = new Worker('./cpu.js', { type: 'module' });
  return cpuWorker;
}

const CPU_TIME_MS = 1500;
const CPU_MIN_DELAY_MS = 400; // CPU の手が一瞬で決まっても、少し間をおいて見せる

function maybeRunCpu() {
  if (state.winner || !cpuControls(state.phase)) return;
  cpuThinking = true;
  render();
  const startedAt = Date.now();
  const worker = getWorker();
  worker.onmessage = (e) => {
    const move = e.data.move;
    const wait = Math.max(0, CPU_MIN_DELAY_MS - (Date.now() - startedAt));
    setTimeout(() => {
      cpuThinking = false;
      if (move) {
        state = applyMove(graph, state, move);
        notice = '';
      }
      render();
      maybeRunCpu();
    }, wait);
  };
  worker.postMessage({
    board: state.board,
    ufos: state.ufos,
    sheepInHand: state.sheepInHand,
    phase: state.phase,
    timeMs: CPU_TIME_MS,
  });
}

// ---- 操作 ----

function onVertexTap(v) {
  if (state.winner || cpuThinking || cpuControls(state.phase)) return;
  const occ = state.board.get(v);

  if (state.phase === 'sheep') {
    if (state.sheepInHand > 0) {
      if (!occ) { commit({ kind: 'place', to: v }); }
      return;
    }
    if (selected && selected.kind === 'sheep') {
      if (sheepMovableFrom(graph, state.board, selected.id).includes(v)) {
        commit({ kind: 'move', from: selected.id, to: v });
        return;
      }
    }
    if (occ && occ.type === 'sheep' && sheepMovableFrom(graph, state.board, v).length > 0) {
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
    const u = state.ufos[selected.id];
    const a = ufoActions(graph, state.board, u.pos, u.loaded);
    if (a.moves.has(v)) { commit({ kind: 'ufoMove', id: u.id, to: v }); return; }
    if (a.abducts.has(v)) { commit({ kind: 'ufoAbduct', id: u.id, to: v }); return; }
    if (a.beams.has(v)) { commit({ kind: 'ufoBeam', id: u.id, to: v, mid: a.beams.get(v) }); return; }
  }
  if (occ && occ.type === 'ufo') {
    selected = { kind: 'ufo', id: occ.ufo.id };
    render();
    return;
  }
  selected = null;
  render();
}

function commit(move) {
  state = applyMove(graph, state, move);
  selected = null;
  notice = '';
  render();
  maybeRunCpu();
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
    <div class="win-overlay" id="modeOverlay" hidden>
      <p class="win-text">対戦あいてを選ぶ</p>
      <button class="pill pill--accent" data-mode="cpu-ufo">CPU が飛行物体（あなたが羊）</button>
      <button class="pill pill--accent" data-mode="cpu-sheep">CPU が羊（あなたが飛行物体）</button>
      <button class="pill" data-mode="pvp">2 人で</button>
    </div>
  </div>
`;
const turnLabel = document.getElementById('turnLabel');
const subLabel = document.getElementById('subLabel');
const noticeEl = document.getElementById('notice');
const winOverlay = document.getElementById('winOverlay');
const winText = document.getElementById('winText');
const modeOverlay = document.getElementById('modeOverlay');

document.getElementById('again').addEventListener('click', () => { winOverlay.hidden = true; modeOverlay.hidden = false; });
modeOverlay.querySelectorAll('[data-mode]').forEach((btn) => {
  btn.addEventListener('click', () => {
    mode = btn.dataset.mode;
    saveMode(mode);
    modeOverlay.hidden = true;
    newGame();
  });
});

const draw3D = createBoard3D(document.getElementById('board3d'), { verts: graph.verts, edges: graph.edges, cells: graph.cells, hex: graph.hex }, onVertexTap);

function render() {
  const a = selected && selected.kind === 'ufo' ? ufoActions(graph, state.board, state.ufos[selected.id].pos, state.ufos[selected.id].loaded) : null;
  const moveSet = a ? a.moves : new Set();
  const abductSet = a ? a.abducts : new Set();
  const beamSet = a ? new Set(a.beams.keys()) : new Set();
  const sheepMoveSet = selected && selected.kind === 'sheep' ? new Set(sheepMovableFrom(graph, state.board, selected.id)) : new Set();

  draw3D({ board: state.board, selected, moveSet: new Set([...moveSet, ...sheepMoveSet]), abductSet, beamSet });

  const abducted = state.ufos.filter((u) => u.loaded).length;
  if (state.winner) {
    turnLabel.textContent = state.winner === 'sheep' ? '羊の勝ち' : '飛行物体の勝ち';
    subLabel.textContent = '';
    winText.textContent = state.winner === 'sheep' ? '飛行物体が動けなくなりました。羊の勝ち！' : '飛行物体が羊を 3 匹連れ去りました。飛行物体の勝ち！';
    winOverlay.hidden = false;
  } else {
    winOverlay.hidden = true;
    const who = cpuThinking ? 'CPU' : (state.phase === 'sheep' ? '羊' : '飛行物体');
    turnLabel.textContent = cpuThinking ? '考え中…' : `${who}の番`;
    subLabel.textContent = `手元の羊 ${state.sheepInHand} 匹 ・ 連れ去られた羊 ${abducted}/3`;
  }
  noticeEl.textContent = notice;
}

newGame();
modeOverlay.hidden = false; // 開始時にも対戦方式を選べるようにする
