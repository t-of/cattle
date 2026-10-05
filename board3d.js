// 盤の 3D 表示（three.js）。ゲームの決まりは知らず、main.js から渡された盤の形と状態を描くだけ。
//
//   const update = createBoard3D(container, { verts, edges, cells, hex }, onTap)
//   update({ board, selected, moveSet, abductSet, beamSet }) … 盤が変わるたびに呼ぶ
//   onTap(vertexId) … 点（またはその上の駒）をタップしたとき

import * as THREE from './vendor/three.module.min.js';
import { OrbitControls } from './vendor/OrbitControls.js';

const COLOR = { move: 0xffd35c, abduct: 0xff7a6b, beam: 0x7ac2ff };
const TILE_TOP = 3;
const UFO_Y = 30;
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

export function createBoard3D(container, { verts, edges, cells, hex }, onTap) {
  const cx = verts.reduce((s, v) => s + v.x, 0) / verts.length;
  const cz = verts.reduce((s, v) => s + v.y, 0) / verts.length;
  const P = (v) => new THREE.Vector3(v.x - cx, 0, v.y - cz);
  const radius = Math.max(...verts.map((v) => P(v).length())) + hex * 0.5;

  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(38, 1, 1, 5000);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enablePan = false;
  controls.enableDamping = true;
  controls.minPolarAngle = 0.15;
  controls.maxPolarAngle = 1.2;

  scene.add(new THREE.HemisphereLight(0xc8d4ff, 0x2b2320, 1.4));
  const sun = new THREE.DirectionalLight(0xfff1dd, 2.2);
  sun.position.set(-radius, radius * 2, radius * 0.8);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  Object.assign(sun.shadow.camera, { left: -radius, right: radius, top: radius, bottom: -radius, near: 1, far: radius * 5 });
  scene.add(sun);

  // ---- 動かないもの（地面・道・点・当たり判定）は 1 回だけ作る ----
  const tileGeo = new THREE.CylinderGeometry(hex * 0.97, hex * 0.97, TILE_TOP * 2, 6);
  cells.forEach((c, i) => {
    const mat = new THREE.MeshStandardMaterial({ color: i % 3 ? 0x4f8a3c : 0x5c9746, roughness: 0.95 });
    const m = new THREE.Mesh(tileGeo, mat);
    m.position.copy(P(c));
    m.receiveShadow = true;
    scene.add(m);
  });

  const roadMat = new THREE.MeshStandardMaterial({ color: 0xd9c9a3, roughness: 1 });
  for (const [a, set] of edges) {
    for (const b of set) {
      if (b < a) continue;
      const pa = P(verts[a]), pb = P(verts[b]);
      const road = new THREE.Mesh(new THREE.BoxGeometry(pa.distanceTo(pb), 0.8, 2.4), roadMat);
      road.position.copy(pa).lerp(pb, 0.5).setY(TILE_TOP + 0.3);
      road.rotation.y = -Math.atan2(pb.z - pa.z, pb.x - pa.x);
      road.receiveShadow = true;
      scene.add(road);
    }
  }

  const dotGeo = new THREE.CylinderGeometry(3.6, 3.6, 1.2, 16);
  // 当たり判定: 点ごとに地面の円盤、駒のある点には駒の高さに球（update で足す）。いちばん手前に当たったものを取る
  const hitGeo = new THREE.CylinderGeometry(hex * 0.42, hex * 0.42, 2, 12);
  const hitBall = new THREE.SphereGeometry(13, 8, 6);
  const hitMat = new THREE.MeshBasicMaterial({ transparent: true, opacity: 0, depthWrite: false });
  const hits = [];
  for (const v of verts) {
    const dot = new THREE.Mesh(dotGeo, roadMat);
    dot.position.copy(P(v)).setY(TILE_TOP + 0.5);
    scene.add(dot);
    const hit = new THREE.Mesh(hitGeo, hitMat);
    hit.position.copy(P(v)).setY(TILE_TOP + 1);
    hit.userData.vid = v.id;
    hits.push(hit);
    scene.add(hit);
  }

  // ---- 駒（毎回作り直す） ----
  const wool = new THREE.MeshStandardMaterial({ color: 0xf5f3ee, roughness: 0.9 });
  const woolTarget = new THREE.MeshStandardMaterial({ color: COLOR.beam, roughness: 0.9, emissive: COLOR.beam, emissiveIntensity: 0.25 });
  const face = new THREE.MeshStandardMaterial({ color: 0x2a2624, roughness: 0.7 });
  const hull = new THREE.MeshStandardMaterial({ color: 0x9aa0ab, metalness: 0.7, roughness: 0.3 });
  const hullSel = new THREE.MeshStandardMaterial({ color: COLOR.move, metalness: 0.5, roughness: 0.3, emissive: COLOR.move, emissiveIntensity: 0.3 });
  const glass = new THREE.MeshStandardMaterial({ color: 0x9fe8ff, transparent: true, opacity: 0.45, roughness: 0.1 });
  const light = new THREE.MeshBasicMaterial({ color: 0xffe9a0 });
  const beamMat = new THREE.MeshBasicMaterial({ color: 0xc8ffb0, transparent: true, opacity: 0.14, depthWrite: false });
  const ringMats = Object.fromEntries(Object.entries(COLOR).map(([k, c]) =>
    [k, new THREE.MeshBasicMaterial({ color: c, transparent: true, opacity: 0.9, depthWrite: false })]));
  const ball = new THREE.SphereGeometry(1, 20, 14);
  const ringGeo = new THREE.TorusGeometry(8, 1.4, 8, 32).rotateX(Math.PI / 2);

  function sheep(mat, s = 1) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(ball, mat);
    body.scale.set(8, 6.5, 9.5);
    const head = new THREE.Mesh(ball, face);
    head.scale.set(3.6, 3.6, 4);
    head.position.set(0, 2, 9);
    for (const m of [body, head]) { m.castShadow = true; g.add(m); }
    g.scale.setScalar(s);
    return g;
  }

  function ufo(sel, loaded) {
    const g = new THREE.Group();
    const disc = new THREE.Mesh(ball, sel ? hullSel : hull);
    disc.scale.set(16, 4, 16);
    disc.castShadow = true;
    const dome = new THREE.Mesh(new THREE.SphereGeometry(8, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), glass);
    dome.position.y = 2;
    g.add(disc, dome);
    for (let i = 0; i < 8; i++) {
      const l = new THREE.Mesh(ball, light);
      const a = (i / 8) * Math.PI * 2;
      l.scale.setScalar(1.3);
      l.position.set(Math.cos(a) * 13.5, -0.5, Math.sin(a) * 13.5);
      g.add(l);
    }
    if (loaded) {
      const s = sheep(wool, 0.4);
      s.position.y = 4;
      g.add(s);
    }
    const beam = new THREE.Mesh(new THREE.ConeGeometry(11, UFO_Y - TILE_TOP, 24, 1, true), beamMat);
    beam.position.y = -(UFO_Y - TILE_TOP) / 2;
    g.add(beam);
    return g;
  }

  let pieces = new THREE.Group();
  let ufoGroups = [];
  let pieceHits = [];
  scene.add(pieces);
  function addPieceHit(vid, at, y) {
    const h = new THREE.Mesh(hitBall, hitMat);
    h.position.copy(at).setY(y);
    h.userData.vid = vid;
    pieceHits.push(h);
    pieces.add(h);
  }

  function update({ board, selected, moveSet, abductSet, beamSet }) {
    scene.remove(pieces);
    pieces = new THREE.Group();
    ufoGroups = [];
    pieceHits = [];
    for (const v of verts) {
      const at = P(v);
      const kind = moveSet.has(v.id) ? 'move' : abductSet.has(v.id) ? 'abduct' : beamSet.has(v.id) ? 'beam' : null;
      if (kind) {
        const ring = new THREE.Mesh(ringGeo, ringMats[kind]);
        ring.position.copy(at).setY(TILE_TOP + 1);
        pieces.add(ring);
      }
      const occ = board.get(v.id);
      if (occ?.type === 'sheep') {
        const s = sheep(beamSet.has(v.id) ? woolTarget : wool);
        s.position.copy(at).setY(TILE_TOP + 5.5);
        s.rotation.y = (v.id * 2.399) % (Math.PI * 2); // 点ごとに向きを散らす
        pieces.add(s);
        addPieceHit(v.id, at, TILE_TOP + 6);
      } else if (occ?.type === 'ufo') {
        const u = occ.ufo;
        const g = ufo(selected?.kind === 'ufo' && selected.id === u.id, u.loaded);
        g.position.copy(at).setY(UFO_Y);
        g.userData.phase = u.id * 2;
        ufoGroups.push(g);
        pieces.add(g);
        addPieceHit(v.id, at, UFO_Y);
      }
    }
    scene.add(pieces);
  }

  // ---- 大きさ合わせ ----
  function resize() {
    const w = container.clientWidth || 1, h = container.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    const fit = radius / Math.sin(THREE.MathUtils.degToRad(camera.fov / 2)) * Math.max(1, 1 / camera.aspect) * 0.95;
    controls.minDistance = fit * 0.6;
    controls.maxDistance = fit * 1.8;
    if (!resize.done) { camera.position.set(0, fit * 0.82, fit * 0.58); resize.done = true; }
    controls.update();
  }
  new ResizeObserver(resize).observe(container);
  resize();

  // ---- タップ（動かしたら回転として扱い、タップにしない） ----
  const ray = new THREE.Raycaster();
  let down = null;
  renderer.domElement.addEventListener('pointerdown', (e) => { down = { x: e.clientX, y: e.clientY }; });
  renderer.domElement.addEventListener('pointerup', (e) => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 8) { down = null; return; }
    down = null;
    const r = renderer.domElement.getBoundingClientRect();
    ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
    const hit = ray.intersectObjects([...hits, ...pieceHits], false)[0];
    if (hit) onTap(hit.object.userData.vid);
  });

  const clock = new THREE.Clock();
  renderer.setAnimationLoop(() => {
    const t = clock.getElapsedTime();
    if (!REDUCED) {
      for (const g of ufoGroups) {
        g.position.y = UFO_Y + Math.sin(t * 2 + g.userData.phase) * 1.5;
        g.rotation.y = t * 0.6;
      }
    }
    controls.update();
    renderer.render(scene, camera);
  });

  return update;
}
