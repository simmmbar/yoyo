/* 悠悠自習室 — 前端(three.js 等角 3D 房間) */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

(() => {
'use strict';
const $ = (s) => document.querySelector(s);
const el = (tag, props = {}, ...kids) => {
  const e = Object.assign(document.createElement(tag), props);
  e.append(...kids);
  return e;
};
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

// ---------- 常數 ----------
const WALLH = 4;
let COLS = 8, ROWS = 6, CATALOG = {};
const SKIN = ['#ffe3d0', '#f8cdaa', '#e6ad84', '#bd8158', '#85573a'];
const HAIRC = ['#3a3040', '#6b4630', '#b0733c', '#f0c466', '#ee8aa0', '#7f96e8', '#eeeaf4'];
const SHIRT = ['#f08d94', '#ffc98a', '#9ed59a', '#7cc3d6', '#8c9cea', '#c09ae0', '#fbf6ec', '#56506e'];
const LOOK_NAMES = ['男生 A', '女生 A', '男生 B', '女生 B', '男生 C', '光頭'];
const WALLS = [['#f6e6d2', '#fffaf0'], ['#d3e3d3', '#f7fbf2'], ['#ddd6f0', '#f8f5ff'], ['#f7d6d2', '#fff6f2'], ['#d2e3f2', '#f5faff'], ['#6a6c9a', '#8f90bd']];
const FLOORS = [['#e0b081', '#cf9a68'], ['#a9744e', '#96623f'], ['#ecd9bd', '#dfc8a6'], ['#b9bfcc', '#a8aebd'], ['#c6d9c3', '#b3c9b0'], ['#85708a', '#745f79']];

// ---------- 狀態 ----------
let ws, me = null, profile = null, room = null, kicked = false;
const players = new Map();
let holding = null; // 佈置中手上拿的家具 {type, fromId?}
let hover = null;   // 滑鼠所在格
let selectedMin = 25, timerMode = 'pomo';
let pendingRestore = null;

function newToken() {
  const a = crypto.getRandomValues(new Uint8Array(18));
  return btoa(String.fromCharCode(...a)).replace(/\+/g, '-').replace(/\//g, '_');
}
let token = store.get('yoyo_token');
if (!token) { token = newToken(); store.set('yoyo_token', token); }

function toast(text) {
  const t = el('div', { className: 'toast', textContent: text });
  $('#toasts').append(t);
  setTimeout(() => t.remove(), 3200);
}

// ---------- 連線 ----------
const send = (m) => { if (ws && ws.readyState === 1) ws.send(JSON.stringify(m)); };
function connect() {
  $('#overlay').hidden = false;
  $('#overlayText').textContent = '連線中…';
  ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host);
  ws.onopen = () => send({ t: 'hello', token, room: new URLSearchParams(location.search).get('room') || '' });
  ws.onmessage = (ev) => { const m = JSON.parse(ev.data); on[m.t]?.(m); };
  ws.onclose = () => {
    if (kicked) return;
    $('#overlay').hidden = false;
    $('#overlayText').textContent = '連線中斷,重新連線中…';
    setTimeout(connect, 2000);
  };
}

function addPlayer(p) {
  const old = players.get(p.id);
  const o = old || { x: p.x, y: p.y };
  const now = performance.now();
  Object.assign(o, { id: p.id, name: p.name, avatar: p.avatar, tx: p.x, ty: p.y, totalMinutes: p.totalMinutes, status: p.status, pose: p.pose });
  // 伺服器給的是「還剩多久 / 已經過多久」,換算成本機時間軸
  o.focus = p.focus ? { ...p.focus, endAt: now + p.focus.left, startAt: now - p.focus.elapsed } : null;
  players.set(p.id, o);
  syncPlayerObj(o);
  assignSeats();
}
const myFocus = () => players.get(me)?.focus || null;
// 顯示用的時間:正計時顯示已過時間,其餘顯示剩餘時間
const focusClock = (f, now) => (f.mode === 'up' ? fmtUp(now - f.startAt) : fmt(f.endAt - now));

const on = {
  init(m) {
    me = m.me; CATALOG = m.catalog; COLS = m.cols; ROWS = m.rows;
    room = m.room;
    clearPlayers();
    m.players.forEach(addPlayer);
    setProfile(m.profile, true);
    $('#overlay').hidden = true;
    $('#roomCode').textContent = room.code;
    $('#goHome').hidden = room.mine;
    if (!new URLSearchParams(location.search).get('room') || m.notice) {
      history.replaceState(null, '', '?room=' + room.code);
    }
    buildEmotes(m.emotes);
    modelsReady.then(() => { rebuildRoom(); buildCatalog(); });
    refreshRoomUI();
    refreshMembers();
    setView(view);
    sysLog(room.mine ? '歡迎回到你的房間 ✨' : `你來到了 ${room.ownerName || '朋友'} 的房間`);
    if (m.notice) toast(m.notice);
  },
  join(m) { addPlayer(m.p); sysLog(`${m.p.name} 進來了`); toast(`${m.p.name} 進來了`); refreshMembers(); },
  leave(m) {
    const p = players.get(m.id);
    if (p) sysLog(`${p.name} 離開了`);
    removePlayer(m.id);
    assignSeats();
    refreshMembers();
  },
  move(m) { const p = players.get(m.id); if (p) { p.tx = m.x; p.ty = m.y; } },
  pupdate(m) { addPlayer(m.p); refreshMembers(); refreshTimer(); },
  chat(m) {
    const p = players.get(m.id);
    if (p) showBubble(p, m.text);
    if (currentTab !== 'chat' && m.id !== me) $('#tabs [data-tab=chat]').classList.add('dot');
    const log = $('#chatLog');
    log.append(el('div', {}, el('b', { textContent: m.name + ' ' }), m.text));
    log.scrollTop = log.scrollHeight;
  },
  emote(m) { const p = players.get(m.id); if (p) showEmote(p, m.e); },
  room(m) {
    Object.assign(room, m.room);
    if (holding?.fromId && !room.items.some((i) => i.id === holding.fromId)) setHolding(null);
    if (!canEdit()) setHolding(null);
    rebuildRoom();
    refreshRoomUI();
  },
  profile(m) { setProfile(m.profile); },
  focus_done(m) {
    if (m.stopped) { if (m.minutes) toast(`已記錄 ${m.minutes} 分鐘專注`); }
    else if (m.phase === 'break') toast(m.next ? '休息結束,開始下一輪專注' : '休息結束');
    else toast(m.next === 'break' ? `專注 ${m.minutes} 分鐘完成!休息 ${m.breakMin} 分鐘` : `專注 ${m.minutes} 分鐘完成!`);
    if (!m.stopped) chime();
    refreshTimer();
  },
  toast(m) { toast(m.text); },
  error(m) { toast(m.text); },
  check(m) {
    if (m.ok && pendingRestore) { store.set('yoyo_token', pendingRestore); location.href = location.pathname; }
    else toast('找不到這個存檔碼');
    pendingRestore = null;
  },
  kicked() {
    kicked = true;
    $('#overlay').hidden = false;
    $('#overlayText').textContent = '你已在其他分頁或裝置登入,這裡已暫停。';
  },
};

function sysLog(text) {
  const log = $('#chatLog');
  log.append(el('div', { className: 'sys', textContent: text }));
  log.scrollTop = log.scrollHeight;
}
const canEdit = () => room && (room.mine || room.guestsEdit);

// ---------- 3D 場景 ----------
const stage = $('#stage'), canvas = $('#game'), labels = $('#labels');
let renderer;
try { renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true }); }
catch (e) { throw new Error('WebGL unavailable: ' + e.message); }
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
renderer.shadowMap.enabled = true;
renderer.localClippingEnabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.12;

const scene = new THREE.Scene();
const VIEW_DIR = new THREE.Vector3(1, 0.82, 1).normalize();
const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 200);

function addLights(sc, shadows) {
  sc.add(new THREE.HemisphereLight(0xffeedd, 0x8f7fc0, 0.95));
  const sun = new THREE.DirectionalLight(0xffdcb4, 2.7);
  sun.position.set(COLS / 2 + 7, 13, ROWS + 5);
  sun.target.position.set(COLS / 2 - 1, 0, ROWS / 2 - 1);
  if (shadows) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -11, right: 11, top: 11, bottom: -11, near: 1, far: 40 });
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03; sun.shadow.radius = 5;
  }
  sc.add(sun, sun.target);
}
addLights(scene, true);

// 幾何與材質快取(重建房間時不會洩漏)
const geos = new Map(), mats = new Map();
const geo = (key, make) => { let g = geos.get(key); if (!g) geos.set(key, (g = make())); return g; };
function mat(color, o = {}) {
  const key = color + JSON.stringify(o);
  let m = mats.get(key);
  if (!m) mats.set(key, (m = new THREE.MeshStandardMaterial({ color, roughness: 0.82, metalness: 0, ...o })));
  return m;
}
const glow = (color, k = 1) => ({ emissive: color, emissiveIntensity: k });
function mesh(g, m, x, y, z, shadow = true) {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z);
  o.castShadow = shadow && !m.transparent; o.receiveShadow = true;
  return o;
}
// box:x、z 為中心,y 為底部高度
function box(w, h, d, color, x, y, z, r = 0.04, o) {
  r = Math.max(0.001, Math.min(r, Math.min(w, h, d) / 2 - 0.001));
  const g = geo(`b${w},${h},${d},${r}`, () => new RoundedBoxGeometry(w, h, d, 3, r));
  return mesh(g, typeof color === 'string' ? mat(color, o) : color, x, y + h / 2, z);
}
function cyl(rt, rb, h, color, x, y, z, o) {
  return mesh(geo(`c${rt},${rb},${h}`, () => new THREE.CylinderGeometry(rt, rb, h, 28)), mat(color, o), x, y + h / 2, z);
}
function sph(r, color, x, y, z, sx = 1, sy = 1, sz = 1, o) {
  const m = mesh(geo(`s${r}`, () => new THREE.SphereGeometry(r, 28, 20)), mat(color, o), x, y, z);
  m.scale.set(sx, sy, sz);
  return m;
}
function cone(r, h, color, x, y, z, o) {
  return mesh(geo(`k${r},${h}`, () => new THREE.ConeGeometry(r, h, 16)), mat(color, o), x, y + h / 2, z);
}
function canvasTex(key, w, h, draw) {
  return geo('t' + key, () => {
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    draw(cv.getContext('2d'), w, h);
    const t = new THREE.CanvasTexture(cv);
    t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    return t;
  });
}
function picture(w, h, tex, x, y, z) {
  const m = new THREE.Mesh(geo(`p${w},${h}`, () => new THREE.PlaneGeometry(w, h)), geo('pm' + tex.uuid, () => new THREE.MeshBasicMaterial({ map: tex, toneMapped: false })));
  m.position.set(x, y, z);
  return m;
}

const WOOD = '#d7a26c', WOOD_D = '#b98352', WOOD_DD = '#9a6a40', CREAM = '#fbf6ec', INK = '#56506e';
const BOOKS = ['#ee8a8f', '#ffc98a', '#7cc3d6', '#9ed59a', '#c09ae0', '#fbf6ec', '#8c9cea'];

// 家具:原點在佔地的左後角(x、z 最小處);牆面物件原點在牆腳,+z 為朝房間方向
// 專業模型:KayKit Furniture Bits(Kay Lousberg,CC0)
const MODEL_NAMES = ['table_medium_long', 'chair_A', 'chair_stool', 'cactus_medium_A', 'cactus_medium_B', 'rug_rectangle_stripes_A', 'rug_oval_A',
  'lamp_standing', 'table_small', 'cabinet_medium_decorated', 'cabinet_small_decorated', 'couch_pillows', 'armchair_pillows', 'bed_single_A',
  'pictureframe_large_A', 'shelf_B_large_decorated', 'lamp_table'];
const MODEL = {};
const modelsReady = Promise.all(MODEL_NAMES.map((n) => new GLTFLoader().loadAsync(`/assets/kaykit/${n}.gltf`).then((g) => {
  g.scene.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = !n.startsWith('rug'); o.receiveShadow = true;
    o.material.roughness = 0.85; o.material.metalness = 0;
  });
  MODEL[n] = g.scene;
})).concat(Object.entries({ window: 'wallWindow.glb', clock: 'wall_clock.gltf', cat: 'cat.glb', tv: 'televisionVintage.glb', tvCabinet: 'cabinetTelevision.glb' }).map(([n, f]) =>
  new GLTFLoader().loadAsync('/assets/extra/' + f).then((g) => {
    g.scene.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = o.receiveShadow = true;
      if (o.material.name === '_defaultMat') o.visible = false; // 窗戶模型附帶的牆板,用我們自己的牆
      if (n.startsWith('tv') && o.material.name === 'wood') o.material.color.set('#c9794a');
      if (n === 'tv' && o.material.name === 'metal') { // 螢幕:自發光
        o.material.color.set('#6fa8e8'); o.material.emissive.set('#4f8ff0'); o.material.emissiveIntensity = 0.6;
        MODEL.tvScreen = o.material;
      }
      if (n === 'window') {
        // 只留窗框那一段高度(裁掉牆板上下的飾條);窗戶固定掛在同一高度,所以用水平裁切面即可
        o.material.clippingPlanes = [new THREE.Plane(new THREE.Vector3(0, 1, 0), -1.2), new THREE.Plane(new THREE.Vector3(0, -1, 0), 2.93)];
        if (o.material.name === 'wood') o.material.color.set('#c9794a');
        if (o.material.name === 'glass') { o.material.opacity = 0.12; o.castShadow = false; }
      }
      if (n !== 'clock') { o.material.roughness = 0.85; o.material.metalness = 0; }
      if (o.isSkinnedMesh) o.frustumCulled = false;
    });
    MODEL[n] = g.scene; MODEL[n + 'Clips'] = g.animations;
  }))));
function put(g, name, s, x, y, z, ry = 0) {
  const o = MODEL[name].clone();
  if (Array.isArray(s)) o.scale.set(...s); else o.scale.setScalar(s);
  o.position.set(x, y, z); o.rotation.y = ry;
  g.add(o); return o;
}

const BUILD = {
  chair(g) { put(g, 'chair_A', 0.68, 0.5, 0, 0.5); },
  stool(g) { put(g, 'chair_stool', 0.68, 0.5, 0, 0.5); },
  plant(g) { put(g, 'cactus_medium_A', 0.95, 0.5, 0, 0.5); },
  tree(g) { put(g, 'cactus_medium_B', 1.1, 0.5, 0, 0.5); },
  rug(g) { put(g, 'rug_rectangle_stripes_A', [0.95, 0.5, 0.94], 1.5, 0, 1); },
  rug2(g) { put(g, 'rug_oval_A', [0.95, 0.5, 0.94], 1.5, 0, 1); },
  table(g) { put(g, 'table_small', 0.85, 0.5, 0, 0.5); put(g, 'lamp_table', 0.6, 0.5, 0.85, 0.5); },
  bookshelf(g) { put(g, 'cabinet_medium_decorated', [0.94, 0.94, 0.86], 1, 0, 0.47); },
  cabinet(g) { put(g, 'cabinet_small_decorated', 0.86, 0.5, 0, 0.47); },
  sofa(g) { put(g, 'couch_pillows', [0.65, 0.68, 0.6], 1, 0, 0.5); },
  armchair(g) { put(g, 'armchair_pillows', [0.54, 0.64, 0.58], 0.5, 0, 0.5); },
  bed(g) { put(g, 'bed_single_A', [0.6, 0.64, 0.65], 0.5, 0, 1); },
  painting(g) { put(g, 'pictureframe_large_A', 0.85, 0.5, 2.3, 0); },
  shelf(g) { put(g, 'shelf_B_large_decorated', 0.9, 1, 2.35, 0); },
  // o.side:椅子在書桌的哪一側(+1 靠房間這側、-1 靠牆那側);o.sx:椅子對著書桌的哪個位置
  desk(g, o = {}) {
    const side = o.side || 1, sx = o.sx ?? 0.95, ox = sx > 1 ? 0.4 : 1.6; // 雜物放在筆電的另一頭
    put(g, 'table_medium_long', [0.64, 0.82, 0.42], 1, 0, 0.5);
    const lap = new THREE.Group();
    lap.add(box(0.46, 0.025, 0.32, '#d9dce6', 0, 0, 0.06, 0.01));
    const scr = box(0.46, 0.3, 0.02, '#4a4d68', 0, 0.02, -0.1, 0.008); scr.rotation.x = -0.18; lap.add(scr);
    const lit = box(0.4, 0.24, 0.006, '#bfe6f5', 0, 0.05, -0.087, 0.002, glow('#9fd8f0', 0.9)); lit.rotation.x = -0.18; lap.add(lit);
    lap.position.set(sx, 0.82, 0.5); lap.rotation.y = side > 0 ? 0 : Math.PI;
    g.add(lap);
    g.add(cyl(0.055, 0.045, 0.11, CREAM, sx + (sx > 1 ? -0.42 : 0.42), 0.82, 0.5 - side * 0.12), cyl(0.045, 0.045, 0.01, '#8a5a3c', sx + (sx > 1 ? -0.42 : 0.42), 0.925, 0.5 - side * 0.12));
    g.add(box(0.32, 0.05, 0.24, BOOKS[0], ox, 0.82, 0.5, 0.01));
    const b2 = box(0.28, 0.05, 0.22, BOOKS[2], ox, 0.87, 0.5, 0.01); b2.rotation.y = 0.25; g.add(b2);
    g.add(cyl(0.05, 0.04, 0.12, '#8c9cea', ox + (sx > 1 ? -0.22 : 0.22), 0.82, 0.5 - side * 0.2), cyl(0.008, 0.008, 0.16, '#ffc98a', ox + (sx > 1 ? -0.23 : 0.21), 0.86, 0.5 - side * 0.2), cyl(0.008, 0.008, 0.17, '#ee8a8f', ox + (sx > 1 ? -0.2 : 0.24), 0.86, 0.5 - side * 0.19));
  },
  lamp(g) {
    put(g, 'lamp_standing', 0.68, 0.5, 0, 0.5);
    g.userData.lampAt = new THREE.Vector3(0.5, 1.35, 0.5);
  },
  tv(g) {
    put(g, 'tvCabinet', 1.2, 0.02, 0, 0.62);
    put(g, 'tv', 1.6, 0.17, 0.372, 0.68);
    // 像在播節目一樣,亮度與色調緩慢變化
    g.userData.anim = (t) => {
      const m = MODEL.tvScreen;
      if (!m) return;
      const k = 1 + Math.sin(t / 900) * 0.14 + Math.sin(t / 233) * 0.09, hue = 0.6 + Math.sin(t / 4000) * 0.04;
      m.emissiveIntensity = 0.6 * k;
      m.emissive.setHSL(hue, 0.85, 0.55);
      const l = g.userData.glow; // 螢幕前方的光,跟著螢幕一起閃動
      if (l) { l.intensity = 16 * k; l.color.setHSL(hue, 1, 0.5); }
    };
    g.userData.glowAt = new THREE.Vector3(0.5, 0.62, 1.05);
  },

  cat(g) {
    const m = cloneSkinned(MODEL.cat);
    const bb = new THREE.Box3();
    m.updateMatrixWorld(true);
    m.traverse((o) => { if (o.isSkinnedMesh) { o.computeBoundingBox(); bb.union(o.boundingBox.clone().applyMatrix4(o.matrixWorld)); } });
    const k = 0.8 / (bb.max.y - bb.min.y || 1);
    m.scale.setScalar(k); m.position.set(0.5, -bb.min.y * k, 0.45); m.rotation.y = 0.5;
    g.add(m);
    const clip = MODEL.catClips.find((c) => /Idle$/.test(c.name));
    if (clip) {
      const mixer = new THREE.AnimationMixer(m);
      mixer.clipAction(clip).play();
      g.userData.anim = (t) => mixer.setTime(t / 1000);
    }
  },

  window(g) {
    const hr = new Date().getHours() + new Date().getMinutes() / 60;
    const mode = hr < 6 || hr >= 19 ? 'night' : (hr >= 17 || hr < 7.5) ? 'dusk' : 'day';
    const sky = canvasTex('sky' + mode, 256, 224, (c, w, h) => {
      const gr = c.createLinearGradient(0, 0, 0, h);
      const cols = { night: ['#1b2452', '#4a5596'], dusk: ['#6a7cc8', '#ffbe95'], day: ['#8fd0f5', '#e3f5fd'] }[mode];
      gr.addColorStop(0, cols[0]); gr.addColorStop(1, cols[1]); c.fillStyle = gr; c.fillRect(0, 0, w, h);
      if (mode === 'night') {
        c.fillStyle = '#fff';
        for (let i = 0; i < 26; i++) { c.globalAlpha = 0.4 + ((i * 37) % 60) / 100; c.beginPath(); c.arc((i * 97) % w, (i * 53) % (h * 0.8), 1 + (i % 3) * 0.5, 0, 7); c.fill(); }
        c.globalAlpha = 1; c.fillStyle = '#fff5cf'; c.beginPath(); c.arc(190, 60, 24, 0, 7); c.fill();
        c.fillStyle = cols[0]; c.beginPath(); c.arc(178, 52, 21, 0, 7); c.fill();
      } else {
        c.fillStyle = mode === 'dusk' ? '#ffe0a0' : '#fff7c4'; c.beginPath(); c.arc(190, mode === 'dusk' ? 150 : 60, 24, 0, 7); c.fill();
        c.fillStyle = 'rgba(255,255,255,.9)';
        for (const [x, y, r] of [[60, 80, 22], [88, 70, 28], [118, 82, 20], [150, 150, 16], [172, 144, 20]]) { c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); }
      }
    });
    // Kenney 的窗框(直立窗),左右各一扇,後面襯一片天空
    const S = 2.3;
    for (const cx of [0.55, 1.45]) {
      put(g, 'window', S, cx - 0.4977 * S, 1.3 - 0.3927 * S, 0.04 * S);
      g.add(picture(0.37 * S, 0.66 * S, sky, cx, 1.3 + 0.33 * S, 0.012));
    }
  },

  clock(g) {
    const m = put(g, 'clock', 1.9, 0.5, 2.5, 0.01);
    const hand = (name) => m.getObjectByName(name);
    const mm = hand('wall_clock_minute_hand'), hh = hand('wall_clock_hours_hand'), ss = hand('wall_clock_second_hand');
    // 模型裡指針的原始指向(從 12 點順時針的弧度),轉到現在時間
    const M0 = 1.01, H0 = -1.05, S0 = 3.0;
    g.userData.anim = () => {
      const d = new Date(), sec = d.getSeconds(), min = d.getMinutes() + sec / 60, hr = (d.getHours() % 12) + min / 60;
      if (mm) mm.rotation.z = -((min / 60) * Math.PI * 2 - M0);
      if (hh) hh.rotation.z = -((hr / 12) * Math.PI * 2 - H0);
      if (ss) ss.rotation.z = -((sec / 60) * Math.PI * 2 - S0);
    };
  },

};
function buildItem(type, opt) {
  const g = new THREE.Group();
  BUILD[type]?.(g, opt);
  return g;
}

// ---------- 座位:椅子自動朝向最近的桌子,專注時角色會走過去坐下 ----------
const SEAT_TYPES = { chair: 0.44, stool: 0.42, armchair: 0.4 }; // 座面高度
const DESK_TYPES = ['desk', 'table'];
let seats = []; // {id, x, z, face, h}
const SIT_FWD = 0.3;
function computeSeats() {
  const desks = room.items.filter((i) => DESK_TYPES.includes(i.type)).map((i) => ({ it: i, cx: i.x + CATALOG[i.type].w / 2, cz: i.y + 0.5 }));
  seats = room.items.filter((i) => SEAT_TYPES[i.type] != null).sort((a, b) => a.id - b.id).map((i) => {
    const x = i.x + 0.5, z = i.y + 0.5;
    let best = null, bd = 2.6;
    for (const d of desks) { const k = Math.hypot(Math.min(Math.max(x, d.it.x + 0.5), d.it.x + CATALOG[d.it.type].w - 0.5) - x, d.cz - z); if (k < bd) { bd = k; best = d; } }
    // 面向桌子(只取前後左右四個方向);附近沒有桌子就面向房間
    let face = 0;
    if (best) { const dx = best.cx - x, dz = best.cz - z; face = Math.abs(dz) >= 0.5 ? (dz > 0 ? 0 : Math.PI) : (dx > 0 ? Math.PI / 2 : -Math.PI / 2); }
    return { id: i.id, x, z, face, h: SEAT_TYPES[i.type], desk: best?.it.id };
  });
}
function assignSeats() {
  if (!room) return;
  const sitters = [...players.values()].filter((p) => p.focus && p.focus.phase === 'focus' && !p.pose).sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const p of players.values()) p.seat = null;
  sitters.forEach((p, i) => { p.seat = seats[i] || null; });
}

// ---------- 角色:Quaternius Ultimate Animated Character Pack(CC0) ----------
const CHAR_FILES = ['Casual_Male', 'Casual_Female', 'Casual2_Male', 'Casual2_Female', 'Casual3_Male', 'Casual_Bald'];
const AVATAR_H = 1.5;
const charCache = new Map();
function loadChar(i) {
  if (!charCache.has(i)) charCache.set(i, new GLTFLoader().loadAsync(`/assets/characters/${CHAR_FILES[i]}.glb`).then((g) => {
    g.scene.updateMatrixWorld(true);
    const bb = new THREE.Box3();
    g.scene.traverse((o) => {
      if (!o.isSkinnedMesh) return;
      o.computeBoundingBox(); bb.union(o.boundingBox.clone().applyMatrix4(o.matrixWorld));
    });
    return { scene: g.scene, clips: g.animations, scale: AVATAR_H / (bb.max.y - bb.min.y || 1), minY: bb.min.y };
  }));
  return charCache.get(i);
}
// 立刻回傳一個空群組,模型載入後再填入;皮膚、頭髮、上衣依材質名稱換色
function buildAvatar(a, onReady) {
  const g = new THREE.Group();
  g.userData = { ready: false };
  loadChar(a.hair % CHAR_FILES.length).then((c) => {
    const m = cloneSkinned(c.scene);
    m.scale.setScalar(c.scale); m.position.y = -c.minY * c.scale;
    const tints = { Skin: SKIN[a.skin], Hair: HAIRC[a.hairColor], Shirt: SHIRT[a.shirt], Pants: '#5d5f86', Belt: '#3b3a4a', Face: '#3a2f3c' };
    m.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = o.receiveShadow = true; o.frustumCulled = false;
      o.material = o.material.clone();
      if (tints[o.material.name]) o.material.color.set(tints[o.material.name]);
      o.material.roughness = 0.8; o.material.metalness = 0;
    });
    const mixer = new THREE.AnimationMixer(m), act = {};
    for (const n of ['Idle', 'Walk', 'SitDown', 'Victory']) {
      const clip = c.clips.find((k) => k.name === n);
      if (clip) act[n] = mixer.clipAction(clip);
    }
    if (act.SitDown) { act.SitDown.loop = THREE.LoopOnce; act.SitDown.clampWhenFinished = true; }
    act.Idle?.play(); mixer.update(0);
    g.add(m);
    // 專注坐下時,屁股底下的小凳子
    const seat = MODEL.chair_stool ? put(g, 'chair_stool', 0.62, 0, 0, -0.12) : null;
    if (seat) seat.visible = false;
    g.userData = { ready: true, mixer, act, cur: 'Idle', seat };
    onReady?.(g);
  });
  return g;
}
function poseAvatar(g, dt, walking, sitting, ownStool) {
  const u = g.userData;
  if (!u.ready) return;
  const want = walking ? 'Walk' : sitting && u.act.SitDown ? 'SitDown' : 'Idle';
  if (want !== u.cur && u.act[want]) {
    u.act[want].reset().fadeIn(0.2).play();
    u.act[u.cur]?.fadeOut(0.2);
    u.cur = want;
  }
  if (!u.seat && MODEL.chair_stool) u.seat = put(g, 'chair_stool', 0.62, 0, 0, -0.12); // 家具模型可能比角色晚載入
  if (u.seat) u.seat.visible = u.cur === 'SitDown' && ownStool;
  u.mixer.update(dt);
}

// ---------- 房間 ----------
const roomGroup = new THREE.Group(), itemsGroup = new THREE.Group(), playersGroup = new THREE.Group();
scene.add(roomGroup, itemsGroup, playersGroup);
let anims = [], wallMats = null, floorMesh = null, gridLines = null, wallLines = null;

function floorTex(i) {
  const [a, b] = FLOORS[i] || FLOORS[0];
  const t = canvasTex('floor' + i, 512, 512, (c) => {
    c.fillStyle = a; c.fillRect(0, 0, 512, 512);
    for (let r = 0; r < 8; r++) {
      const off = (r % 2) * 128 + ((r * 53) % 40);
      for (let k = -1; k < 3; k++) {
        c.globalAlpha = 0.25 + ((r * 7 + k * 3 + 9) % 5) * 0.12;
        c.fillStyle = b; c.fillRect(off + k * 256 + 2, r * 64 + 2, 252, 60);
      }
    }
    c.globalAlpha = 0.16; c.fillStyle = '#3a2218';
    for (let r = 0; r < 8; r++) { c.fillRect(0, r * 64, 512, 2); for (let k = -1; k < 3; k++) c.fillRect((r % 2) * 128 + ((r * 53) % 40) + k * 256, r * 64, 2, 64); }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(COLS / 3, ROWS / 3);
  return t;
}
function buildShell() {
  roomGroup.clear();
  const wm = new THREE.MeshStandardMaterial({ roughness: 0.95 }), tm = new THREE.MeshStandardMaterial({ roughness: 0.9 });
  wallMats = [wm, tm];
  const th = 0.28;
  const add = (o, cast = false) => { o.castShadow = cast; roomGroup.add(o); return o; };
  add(box(COLS + th, WALLH, th, wm, COLS / 2 - th / 2, 0, -th / 2, 0.03));
  add(box(th, WALLH, ROWS, wm, -th / 2, 0, ROWS / 2, 0.03));
  add(box(COLS, 0.22, 0.05, tm, COLS / 2, 0, 0.025, 0.01));
  add(box(0.05, 0.22, ROWS, tm, 0.025, 0, ROWS / 2, 0.01));
  add(box(COLS + th, 0.07, th + 0.06, tm, COLS / 2 - th / 2, WALLH, -th / 2 + 0.03, 0.02));
  add(box(th + 0.06, 0.07, ROWS, tm, -th / 2 + 0.03, WALLH, ROWS / 2, 0.02));
  add(box(COLS + th, 0.45, ROWS + th, tm, COLS / 2 - th / 2, -0.451, ROWS / 2 - th / 2, 0.06));
  floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(COLS, ROWS), new THREE.MeshStandardMaterial({ roughness: 0.75 }));
  floorMesh.rotation.x = -Math.PI / 2; floorMesh.position.set(COLS / 2, 0, ROWS / 2); floorMesh.receiveShadow = true;
  roomGroup.add(floorMesh);
  const pts = [];
  for (let q = 0; q <= COLS; q++) pts.push(q, 0.012, 0, q, 0.012, ROWS);
  for (let r = 0; r <= ROWS; r++) pts.push(0, 0.012, r, COLS, 0.012, r);
  const wpts = [];
  for (let q = 0; q <= COLS; q++) wpts.push(q, 0.25, 0.012, q, WALLH, 0.012);
  const lines = (arr) => {
    const l = new THREE.LineSegments(new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(arr, 3)), new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35 }));
    l.visible = false; roomGroup.add(l); return l;
  };
  gridLines = lines(pts); wallLines = lines(wpts);
  fitCamera();
}
const itemPos = (g, type, x, y) => g.position.set(x, 0, CATALOG[type].kind === 'wall' ? 0 : y);
function rebuildRoom() {
  if (!room || !MODEL[MODEL_NAMES[0]]) return;
  if (!floorMesh) buildShell();
  const [wc, wt] = WALLS[room.wall] || WALLS[0];
  wallMats[0].color.set(wc); wallMats[1].color.set(wt);
  floorMesh.material.map = floorTex(room.floor); floorMesh.material.needsUpdate = true;
  itemsGroup.clear(); anims = [];
  computeSeats(); assignSeats();
  let lamps = 0, glows = 0;
  for (const it of room.items) {
    if (!CATALOG[it.type]) continue;
    let opt;
    if (it.type === 'desk') { // 筆電擺在有椅子的那一側
      const st = seats.find((q) => q.desk === it.id);
      if (st) opt = { side: st.z > it.y + 0.5 ? 1 : -1, sx: Math.min(1.6, Math.max(0.4, st.x - it.x)) };
    }
    const g = buildItem(it.type, opt);
    const st = seats.find((q) => q.id === it.id);
    if (st) { // 椅子模型預設朝向 +z,轉向它面對的桌子
      const piv = new THREE.Group();
      piv.position.set(0.5, 0, 0.5); piv.rotation.y = st.face;
      for (const c of [...g.children]) { c.position.x -= 0.5; c.position.z -= 0.5; piv.add(c); }
      g.add(piv);
    }
    itemPos(g, it.type, it.x, it.y);
    g.userData.itemId = it.id;
    if (g.userData.anim) anims.push(g.userData.anim);
    if (g.userData.lampAt && lamps++ < 4) {
      const l = new THREE.PointLight(0xffc27a, 9, 5.5, 1.8); l.position.copy(g.userData.lampAt); g.add(l);
    }
    if (g.userData.glowAt && glows++ < 2) { // 最多兩台電視會照亮房間
      const l = new THREE.PointLight(0x7fc4f0, 6, 4.5, 1.6); l.position.copy(g.userData.glowAt); g.add(l);
      g.userData.glow = l;
    }
    itemsGroup.add(g);
  }
  syncGhost();
}

// 佈置預覽
let ghost = null;
const ghostPad = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ transparent: true, opacity: 0.45, depthWrite: false }));
ghostPad.visible = false; scene.add(ghostPad);
function syncGhost() {
  if (ghost) { scene.remove(ghost); ghost = null; }
  const hk = holding && CATALOG[holding.type].kind;
  if (gridLines) { gridLines.visible = !!hk && hk !== 'wall'; wallLines.visible = hk === 'wall'; }
  for (const g of itemsGroup.children) g.visible = !(holding?.fromId && g.userData.itemId === holding.fromId);
  if (holding) { ghost = buildItem(holding.type); ghost.visible = false; scene.add(ghost); }
  ghostPad.visible = false;
}


// ---------- 風格化後製(?style=ink|riso|bit|psx) ----------
const STYLE = new URLSearchParams(location.search).get('style');
const MODES = { ink: 1, riso: 2, bit: 3, psx: 4 };
let post = null;
if (MODES[STYLE]) {
  const mk = (depth) => {
    const rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType });
    if (STYLE === 'psx') rt.texture.minFilter = rt.texture.magFilter = THREE.NearestFilter;
    if (depth) rt.depthTexture = new THREE.DepthTexture(4, 4);
    return rt;
  };
  const rtC = mk(false), rtN = mk(true);
  const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.ShaderMaterial({
    uniforms: { tC: { value: rtC.texture }, tN: { value: rtN.texture }, tD: { value: rtN.depthTexture }, res: { value: new THREE.Vector2() }, mode: { value: MODES[STYLE] } },
    vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position.xy, 0., 1.); }',
    fragmentShader: `
      precision highp float;
      uniform sampler2D tC, tN, tD; uniform vec2 res; uniform int mode; varying vec2 vUv;
      vec3 srgb(vec3 c){ return pow(clamp(c, 0., 1.), vec3(1. / 2.2)); }
      float lum(vec3 c){ return dot(c, vec3(.299, .587, .114)); }
      float b2(vec2 a){ a = floor(a); return fract(a.x / 2. + a.y * a.y * .75); }
      float bayer(vec2 a){ return b2(.5 * a) * .25 + b2(a); }
      float hash(vec2 p){ return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453); }
      float edge(float w){
        vec2 d = w / res; float e = 0.;
        vec4 n0 = texture2D(tN, vUv); float z0 = texture2D(tD, vUv).r;
        for (int i = 0; i < 4; i++) {
          vec2 o = i == 0 ? vec2(d.x, 0.) : i == 1 ? vec2(-d.x, 0.) : i == 2 ? vec2(0., d.y) : vec2(0., -d.y);
          vec4 n = texture2D(tN, vUv + o);
          e = max(e, length(n - n0) * 1.4);
          e = max(e, abs(texture2D(tD, vUv + o).r - z0) * 260.);
        }
        return smoothstep(.35, .7, e);
      }
      float dots(vec2 p, float ang, float size, float cov){
        float c = cos(ang), s = sin(ang); p = mat2(c, -s, s, c) * p / size;
        return smoothstep(.06, -.06, length(fract(p) - .5) - sqrt(clamp(cov, 0., 1.)) * .72);
      }
      void main(){
        vec4 t = texture2D(tC, vUv); float a = t.a; vec3 c = srgb(t.rgb * 1.05);
        vec2 fc = gl_FragCoord.xy; float scale = res.y / 780.;
        if (mode == 1) {            // 墨線:平塗色塊 + 黑描邊
          float l = lum(c), q = (floor(l * 3.5 + .6)) / 3.5;
          vec3 fl = clamp(c * (q / max(l, .001)), 0., 1.);
          fl = mix(vec3(lum(fl)), fl, 1.15) * vec3(1., .97, .9);
          vec3 paper = vec3(.953, .918, .835) - hash(floor(fc / scale)) * .03;
          vec3 o = mix(paper, fl, a);
          o = mix(o, vec3(.14, .12, .17), edge(1.6 * scale));
          gl_FragColor = vec4(o, 1.);
        } else if (mode == 2) {     // 孔版印刷:三色網點疊印 + 錯位
          vec3 c2 = srgb(texture2D(tC, vUv + vec2(3., -2.) * scale / res).rgb * 1.05);
          float a2 = texture2D(tC, vUv + vec2(3., -2.) * scale / res).a;
          float blue = mix(.0, 1. - lum(c), a) * 1.15;
          float pink = mix(.0, clamp((c2.r - c2.b) * 1.6 + (1. - lum(c2)) * .15, 0., 1.), a2);
          float yel = mix(.0, clamp((min(c.r, c.g) - c.b) * 2.2, 0., 1.), a);
          vec2 p = fc / scale;
          vec3 o = vec3(.965, .94, .88);
          o *= mix(vec3(1.), vec3(1., .91, .0), dots(p, .26, 5., yel) * .9);
          o *= mix(vec3(1.), vec3(1., .28, .69), dots(p, 1.3, 5., pink) * .92);
          o *= mix(vec3(1.), vec3(.2, .33, .64), dots(p, .78, 5., blue * blue) * .95);
          o *= mix(vec3(1.), vec3(.2, .33, .64), edge(1.4 * scale) * .9);
          o += (hash(p) - .5) * .07;
          gl_FragColor = vec4(o, 1.);
        } else if (mode == 3) {     // 1-bit 抖色
          float l = mix(.06 + step(.992, hash(floor(fc / (2. * scale)))) , lum(c) * 1.1 - .08, a);
          float on = step(bayer(floor(fc / (2. * scale))), l);
          on *= 1. - edge(1.6 * scale);
          gl_FragColor = vec4(mix(vec3(.12, .13, .22), vec3(.94, .9, .8), on), 1.);
        } else {                    // PS1:低解析度 + 色彩量化
          c += (bayer(floor(vUv * res)) - .5) / 14.;
          c = floor(c * 16. + .5) / 16.;
          gl_FragColor = vec4(c * a, a);
        }
      }`,
  }));
  quad.frustumCulled = false;
  const qScene = new THREE.Scene(); qScene.add(quad);
  const qCam = new THREE.Camera(), normalMat = new THREE.MeshNormalMaterial();
  post = {
    resize(w, h) {
      const k = STYLE === 'psx' ? 300 / h : renderer.getPixelRatio();
      const W = Math.max(2, Math.round(w * k)), H = Math.max(2, Math.round(h * k));
      rtC.setSize(W, H); rtN.setSize(W, H);
      quad.material.uniforms.res.value.set(W, H);
    },
    render() {
      renderer.setRenderTarget(rtC); renderer.setClearColor(0x000000, 0); renderer.clear(); renderer.render(scene, camera);
      scene.overrideMaterial = normalMat;
      renderer.setRenderTarget(rtN); renderer.clear(); renderer.render(scene, camera);
      scene.overrideMaterial = null;
      renderer.setRenderTarget(null); renderer.render(qScene, qCam);
    },
  };
}

// ---------- 相機:繞著目標旋轉的透視鏡頭,可拖曳、滾輪縮放、切換視角 ----------
// 房間只有後牆(z=0)和左牆(x=0),所以鏡頭只待在房間開口這一側
const D2R = Math.PI / 180;
const cam = { yaw: 45 * D2R, pitch: 30 * D2R, dist: 24, target: new THREE.Vector3(4, 1, 3) };
const camGoal = { yaw: cam.yaw, pitch: cam.pitch, dist: cam.dist, target: cam.target.clone() };
let view = store.get('yoyo_view') || 'desk', autoIdx = 0, autoAt = 0, activeView = 'room';
const myPos = () => { const p = players.get(me); return p ? new THREE.Vector3(p.x, 0, p.y) : new THREE.Vector3(COLS / 2, 0, ROWS / 2); };
const VIEWS = {
  room: { yaw: 45, pitch: 27, dist: () => roomDist, target: () => new THREE.Vector3(COLS / 2 - 0.3, 1.2, ROWS / 2 - 0.3) },
  desk: { yaw: 24, pitch: 13, dist: () => 8.5 * Math.max(1, 1.25 / camera.aspect), target: () => myPos().add(new THREE.Vector3(camera.aspect < 1 ? -0.3 : 0, camera.aspect < 1 ? 0.4 : 1.05, 0.2)) },
  side: { yaw: 68, pitch: 18, dist: () => 11, target: () => myPos().add(new THREE.Vector3(-0.4, 0.95, 0)) },
};
const AUTO = ['desk', 'room', 'side'];
let roomDist = 24;
function applyView(name) {
  activeView = name;
  const v = VIEWS[name];
  Object.assign(camGoal, { yaw: v.yaw * D2R, pitch: v.pitch * D2R, dist: v.dist() });
}
function setView(name) {
  view = VIEWS[name] || name === 'auto' ? name : 'desk';
  store.set('yoyo_view', view);
  document.querySelectorAll('#views button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  autoAt = performance.now();
  applyView(view === 'auto' ? AUTO[autoIdx % AUTO.length] : view);
}
$('#views').addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (b) setView(b.dataset.view); });
function updateCamera(dt, t) {
  if (view === 'auto' && t - autoAt > 14000) { autoAt = t; applyView(AUTO[++autoIdx % AUTO.length]); }
  camGoal.target.copy(VIEWS[activeView].target());
  const k = 1 - Math.exp(-dt * 3.2);
  cam.yaw += (camGoal.yaw - cam.yaw) * k; cam.pitch += (camGoal.pitch - cam.pitch) * k; cam.dist += (camGoal.dist - cam.dist) * k;
  cam.target.lerp(camGoal.target, k);
  const cp = Math.cos(cam.pitch);
  camera.position.set(cam.target.x + Math.sin(cam.yaw) * cp * cam.dist, cam.target.y + Math.sin(cam.pitch) * cam.dist, cam.target.z + Math.cos(cam.yaw) * cp * cam.dist);
  camera.lookAt(cam.target);
  camera.updateMatrixWorld();
}
function orbit(dx, dy) {
  camGoal.yaw = Math.min(86 * D2R, Math.max(4 * D2R, camGoal.yaw - dx * 0.006));
  camGoal.pitch = Math.min(62 * D2R, Math.max(5 * D2R, camGoal.pitch + dy * 0.005));
}
function zoom(f) { camGoal.dist = Math.min(roomDist * 1.25, Math.max(4.5, camGoal.dist * f)); }
function fitCamera() {
  const w = stage.clientWidth || 1, h = stage.clientHeight || 1;
  renderer.setSize(w, h, false);
  post?.resize(w, h);
  camera.aspect = w / h; camera.updateProjectionMatrix();
  // 全景視角:找出剛好看得到整個房間的距離
  const tv = Math.tan((camera.fov / 2) * D2R), r = Math.hypot(COLS, ROWS, WALLH) / 2;
  roomDist = (r / Math.min(tv, tv * camera.aspect)) * 0.86;
  if (activeView === 'room') camGoal.dist = roomDist;
}
new ResizeObserver(fitCamera).observe(stage);

// 縮圖(家具卡片、角色預覽)
const thumb = new THREE.WebGLRenderer({ antialias: true, alpha: true });
thumb.setSize(256, 256, false);
thumb.localClippingEnabled = true;
thumb.toneMapping = THREE.ACESFilmicToneMapping; thumb.toneMappingExposure = 1.12;
const thumbScene = new THREE.Scene(), thumbCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
addLights(thumbScene, false);
function snapshot(obj, cv, dir = VIEW_DIR, zoom = 1) {
  thumbScene.add(obj);
  const bb = new THREE.Box3().setFromObject(obj), c = bb.getCenter(new THREE.Vector3());
  const r = bb.getSize(new THREE.Vector3()).length() / 2 / zoom;
  thumbCam.position.copy(c).addScaledVector(dir, 20); thumbCam.lookAt(c);
  Object.assign(thumbCam, { left: -r, right: r, top: r, bottom: -r }); thumbCam.updateProjectionMatrix();
  thumb.render(thumbScene, thumbCam);
  thumbScene.remove(obj);
  const c2 = cv.getContext('2d');
  c2.clearRect(0, 0, cv.width, cv.height); c2.drawImage(thumb.domElement, 0, 0, cv.width, cv.height);
}
const FRONT_DIR = new THREE.Vector3(0.35, 0.25, 1).normalize();
let previewSeq = 0;
function renderAvatarPreview() {
  if (!draft) return;
  const seq = ++previewSeq; // 只畫最後一次選擇
  buildAvatar(draft.avatar, (g) => {
    if (seq !== previewSeq) return;
    const cv = $('#avatarPreview'), c2 = cv.getContext('2d');
    thumbScene.add(g);
    thumbCam.position.set(0, AVATAR_H * 0.52, 0).addScaledVector(FRONT_DIR, 20); thumbCam.lookAt(0, AVATAR_H * 0.52, 0);
    Object.assign(thumbCam, { left: -0.95, right: 0.95, top: 0.95, bottom: -0.95 }); thumbCam.updateProjectionMatrix();
    thumb.render(thumbScene, thumbCam); thumbScene.remove(g);
    c2.clearRect(0, 0, cv.width, cv.height); c2.drawImage(thumb.domElement, 0, 0, cv.width, cv.height);
  });
}

// ---------- 玩家物件與標籤 ----------
function syncPlayerObj(p) {
  const key = JSON.stringify(p.avatar);
  if (p.key !== key) {
    if (p.obj) playersGroup.remove(p.obj);
    p.obj = buildAvatar(p.avatar); p.key = key;
    p.obj.rotation.y = p.heading ?? Math.PI / 4;
    playersGroup.add(p.obj);
  }
  if (!p.el) {
    p.el = el('div', { className: 'plabel' + (p.id === me ? ' me' : '') },
      (p.elBubble = el('div', { className: 'bubble', hidden: true })),
      (p.elStatus = el('div', { className: 'pstatus', hidden: true })),
      (p.elTimer = el('div', { className: 'ptimer', hidden: true })),
      (p.elName = el('div', { className: 'pname' })));
    labels.append(p.el);
  }
  p.elName.textContent = p.name;
  p.elStatus.textContent = p.status || ''; p.elStatus.hidden = !p.status;
}
function removePlayer(id) {
  const p = players.get(id);
  if (!p) return;
  if (p.obj) playersGroup.remove(p.obj);
  p.el?.remove();
  players.delete(id);
}
function clearPlayers() { for (const id of [...players.keys()]) removePlayer(id); }
function showBubble(p, text) {
  p.elBubble.textContent = text; p.elBubble.hidden = false;
  clearTimeout(p.bubbleTimer);
  p.bubbleTimer = setTimeout(() => { p.elBubble.hidden = true; }, 5500);
}
function showEmote(p, e) {
  const d = el('div', { className: 'emo', textContent: e });
  p.el.prepend(d);
  setTimeout(() => d.remove(), 1800);
}

const mmss = (s) => String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
const fmt = (ms) => mmss(Math.max(0, Math.ceil(ms / 1000)));
const fmtUp = (ms) => mmss(Math.max(0, Math.floor(ms / 1000)));
function canPlace(type, x, y, ignoreId) {
  const d = CATALOG[type];
  if (!d || x < 0 || x + d.w > COLS) return false;
  if (d.kind === 'wall') { if (y !== 0) return false; }
  else if (y < 0 || y + d.h > ROWS) return false;
  return !room.items.some((it) => {
    if (it.id === ignoreId) return false;
    const o = CATALOG[it.type];
    return o && o.kind === d.kind && x < it.x + o.w && it.x < x + d.w && y < it.y + o.h && it.y < y + d.h;
  });
}

// ---------- 主迴圈 ----------
let lastT = performance.now();
const tmpV = new THREE.Vector3();
function frame(t) {
  requestAnimationFrame(frame);
  const dt = Math.min(0.1, (t - lastT) / 1000); lastT = t;
  if (!room || !floorMesh) return;
  for (const a of anims) a(t);
  updateCamera(dt, t);
  const sw = stage.clientWidth, sh = stage.clientHeight;
  for (const p of players.values()) {
    if (!p.obj) continue;
    // 專注時走向分配到的椅子;沒有空椅子就在原地坐自己的小凳子
    const gx = p.seat ? p.seat.x : p.tx, gy = p.seat ? p.seat.z : p.ty;
    const dx = gx - p.x, dy = gy - p.y, d = Math.hypot(dx, dy);
    const walking = d > 0.02;
    if (walking) {
      const s = Math.min(d, 3.2 * dt);
      p.x += (dx / d) * s; p.y += (dy / d) * s;
    }
    const f = p.focus && (p.focus.mode === 'up' || p.focus.endAt > t) ? p.focus : null;
    const sitting = !!f && f.phase === 'focus' && !p.pose && !walking;
    const want = walking ? Math.atan2(dx, dy) : sitting && p.seat ? p.seat.face : 0.35;
    let diff = want - p.obj.rotation.y;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    p.obj.rotation.y += diff * Math.min(1, dt * 12);
    p.heading = p.obj.rotation.y;
    // 坐下的動作會把身體往後移,坐在椅子上時往前補回來,屁股才會落在椅面上
    const fwd = sitting && p.seat ? SIT_FWD : 0;
    p.sit = (p.sit || 0) + (fwd - (p.sit || 0)) * Math.min(1, dt * 8);
    p.obj.position.set(p.x + Math.sin(p.obj.rotation.y) * p.sit, 0, p.y + Math.cos(p.obj.rotation.y) * p.sit);
    poseAvatar(p.obj, dt, walking, sitting, !p.seat);
    // 標籤
    tmpV.set(p.x, AVATAR_H + 0.12, p.y).project(camera);
    p.el.style.transform = `translate(${((tmpV.x + 1) / 2) * sw}px, ${((1 - tmpV.y) / 2) * sh}px) translate(-50%, -100%)`;
    if (f) {
      const txt = (f.phase === 'break' ? '休息 ' : '') + focusClock(f, t);
      if (p.elTimer.textContent !== txt) { p.elTimer.textContent = txt; p.elTimer.classList.toggle('break', f.phase === 'break'); }
    }
    if (p.elTimer.hidden === !!f) p.elTimer.hidden = !f;
  }
  if (ghost) {
    const d = CATALOG[holding.type];
    ghost.visible = ghostPad.visible = !!hover;
    if (hover) {
      itemPos(ghost, holding.type, hover.x, hover.y);
      const ok = canPlace(holding.type, hover.x, hover.y, holding.fromId);
      ghostPad.material.color.set(ok ? '#8fe08a' : '#ff7d88');
      if (d.kind === 'wall') { ghostPad.rotation.set(0, 0, 0); ghostPad.scale.set(d.w, WALLH - 0.25, 1); ghostPad.position.set(hover.x + d.w / 2, WALLH / 2 + 0.125, 0.015); }
      else { ghostPad.rotation.set(-Math.PI / 2, 0, 0); ghostPad.scale.set(d.w, d.h, 1); ghostPad.position.set(hover.x + d.w / 2, 0.05, hover.y + d.h / 2); }
    }
  }
  if (post) post.render(); else renderer.render(scene, camera);
  tickTimer(t);
}

// ---------- 畫布操作 ----------
const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
const FLOOR_PLANE = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0), WALL_PLANE = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);
function pick(ev) { // → {wall, x, z}:地板座標,或牆面上的 x
  const r = canvas.getBoundingClientRect();
  ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  const f = ray.ray.intersectPlane(FLOOR_PLANE, new THREE.Vector3());
  if (f && f.x >= 0 && f.z >= 0) return { wall: false, x: f.x, z: f.z };
  const w = ray.ray.intersectPlane(WALL_PLANE, new THREE.Vector3());
  if (w && w.x >= 0 && w.x <= COLS && w.y >= 0 && w.y <= WALLH + 0.3) return { wall: true, x: w.x, z: 0 };
  return null;
}
function tileAt(pt) { // 拿著家具時,讓家具以游標為中心
  if (!pt || !holding) return null;
  const d = CATALOG[holding.type];
  if (d.kind === 'wall') return { x: Math.floor(pt.x - (d.w - 1) / 2), y: 0 };
  if (pt.wall) return null;
  return { x: Math.floor(pt.x - (d.w - 1) / 2), y: Math.floor(pt.z - (d.h - 1) / 2) };
}
// 拖曳 = 轉動鏡頭;沒有移動的點擊 = 走路 / 放家具;滾輪或雙指 = 縮放
const ptrs = new Map();
let dragMoved = false, pinch = 0;
canvas.addEventListener('pointermove', (ev) => {
  const q = ptrs.get(ev.pointerId);
  if (!q) { hover = tileAt(pick(ev)); return; }
  const dx = ev.clientX - q.x, dy = ev.clientY - q.y;
  q.x = ev.clientX; q.y = ev.clientY;
  if (ptrs.size === 2) {
    const [a, b] = [...ptrs.values()], dist = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinch) zoom(pinch / dist);
    pinch = dist; dragMoved = true;
    return;
  }
  if (!dragMoved && Math.hypot(ev.clientX - q.x0, ev.clientY - q.y0) < 6) return;
  dragMoved = true; canvas.classList.add('drag');
  if (holding) hover = tileAt(pick(ev)); else orbit(dx, dy);
});
canvas.addEventListener('pointerleave', () => { hover = null; });
canvas.addEventListener('wheel', (ev) => { ev.preventDefault(); zoom(Math.exp(ev.deltaY * 0.0012)); }, { passive: false });
canvas.addEventListener('pointerdown', (ev) => {
  if (!ptrs.size) dragMoved = false;
  ptrs.set(ev.pointerId, { x: ev.clientX, y: ev.clientY, x0: ev.clientX, y0: ev.clientY });
  canvas.setPointerCapture(ev.pointerId);
});
const endPtr = (ev) => { ptrs.delete(ev.pointerId); pinch = 0; canvas.classList.remove('drag'); };
canvas.addEventListener('pointercancel', endPtr);
canvas.addEventListener('pointerup', (ev) => {
  const wasDrag = dragMoved;
  endPtr(ev);
  if (wasDrag || !room) return;
  const pt = pick(ev);
  if (holding) {
    const tl = (hover = tileAt(pt));
    if (!tl || !canPlace(holding.type, tl.x, tl.y, holding.fromId)) return toast('這裡放不下');
    if (holding.fromId) { send({ t: 'move_item', id: holding.fromId, x: tl.x, y: tl.y }); setHolding(null); }
    else send({ t: 'place', type: holding.type, x: tl.x, y: tl.y });
    return;
  }
  if (editing()) { // 佈置面板開著:點家具可拿起
    let o = ray.intersectObjects(itemsGroup.children, true)[0]?.object;
    while (o && o.userData.itemId == null) o = o.parent;
    const it = o && room.items.find((i) => i.id === o.userData.itemId);
    if (it) return setHolding({ type: it.type, fromId: it.id });
  }
  const p = players.get(me);
  if (!p || !pt || pt.wall) return;
  p.tx = Math.min(COLS - 0.3, Math.max(0.3, pt.x));
  p.ty = Math.min(ROWS - 0.15, Math.max(0.2, pt.z));
  send({ t: 'move', x: p.tx, y: p.ty });
});
window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') setHolding(null); });

// ---------- 面板(底部工具列開關右側抽屜) ----------
let currentTab = null;
const TAB_TITLES = { decor: '佈置房間', avatar: '角色', chat: '聊天', people: '房間成員', settings: '設定' };
const editing = () => currentTab === 'decor' && canEdit();
function openTab(name) {
  currentTab = name;
  $('#drawer').hidden = !name;
  $('#drawerTitle').textContent = TAB_TITLES[name] || '';
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x.id === 'tab-' + name));
  if (name !== 'decor') setHolding(null);
  if (name === 'avatar') renderAvatarPreview();
  if (name === 'chat') { $('#tabs [data-tab=chat]').classList.remove('dot'); $('#chatLog').scrollTop = 1e9; }
}
$('#tabs').addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (b) openTab(currentTab === b.dataset.tab ? null : b.dataset.tab);
});
$('#drawerClose').addEventListener('click', () => openTab(null));

// ---------- 專注計時 ----------
const num = (id, lo, hi, def) => { const v = Math.floor(+$(id).value); return v >= lo && v <= hi ? v : def; };
const idleMs = () => (timerMode === 'up' ? 0 : (timerMode === 'pomo' ? num('#pomoFocus', 1, 180, 25) : selectedMin) * 60000);
function tickTimer(t) {
  let f = myFocus();
  if (f && f.mode !== 'up' && f.endAt <= t - 1500) f = null; // 等伺服器送下一階段
  const text = f ? focusClock(f, t) : fmt(idleMs());
  if ($('#timerText').textContent !== text) {
    $('#timerText').textContent = text;
    document.title = f ? `${text} ${f.phase === 'break' ? '休息中' : '專注中'} — 悠悠自習室` : '悠悠自習室';
    if (f && currentTab === 'people') refreshMembers();
  }
}
function refreshTimer() {
  const f = myFocus();
  document.body.classList.toggle('focusing', !!f);
  const lab = $('#timerLabel');
  lab.classList.toggle('break', f?.phase === 'break');
  lab.textContent = !f ? '準備好就開始吧'
    : f.phase === 'break' ? `休息一下 · 第 ${f.round} 輪結束`
    : f.mode === 'pomo' ? `專注中 · 第 ${f.round} 輪` : '專注中';
  $('#focusBtn').textContent = f ? '結束' : '開始專注';
  $('#focusBtn').className = f ? 'danger' : 'primary';
  if (f) setMode(f.mode, true);
}
function setMode(m, silent) {
  timerMode = m;
  document.querySelectorAll('#modes button').forEach((x) => x.classList.toggle('on', x.dataset.mode === m));
  document.querySelectorAll('#timerSetup .setup').forEach((x) => { x.hidden = x.dataset.for !== m; });
  if (!silent) store.set('yoyo_mode', m);
}
$('#modes').addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (b && !myFocus()) setMode(b.dataset.mode); });
setMode(['pomo', 'down', 'up'].includes(store.get('yoyo_mode')) ? store.get('yoyo_mode') : 'pomo', true);
$('#presets').addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  selectedMin = +b.dataset.min;
  $('#customMin').value = '';
  document.querySelectorAll('#presets button').forEach((x) => x.classList.toggle('on', x === b));
});
$('#customMin').addEventListener('input', (ev) => {
  const v = Math.floor(+ev.target.value);
  if (v >= 1 && v <= 180) {
    selectedMin = v;
    document.querySelectorAll('#presets button').forEach((x) => x.classList.remove('on'));
  }
});
$('#focusBtn').addEventListener('click', () => {
  if (myFocus()) return send({ t: 'focus_stop' });
  send({ t: 'focus_start', mode: timerMode, minutes: timerMode === 'pomo' ? num('#pomoFocus', 1, 180, 25) : selectedMin, breakMin: num('#pomoBreak', 1, 60, 5) });
});
// 狀態文字與專注姿勢
let statusTimer = 0;
$('#statusInput').addEventListener('input', (ev) => {
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => send({ t: 'status', text: ev.target.value }), 400);
});
$('#poses').addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (b) { setPose(+b.dataset.pose); send({ t: 'status', pose: +b.dataset.pose }); } });
function setPose(i) { document.querySelectorAll('#poses button').forEach((x) => x.classList.toggle('on', +x.dataset.pose === i)); }

// ---------- 待辦清單(存在伺服器的個人存檔裡) ----------
let todos = [];
function renderTodos() {
  $('#todoList').replaceChildren(...todos.map((td, i) => {
    const cb = el('input', { type: 'checkbox', checked: td.done, ariaLabel: '完成' });
    cb.onchange = () => { td.done = cb.checked; saveTodos(); };
    const del = el('button', { type: 'button', textContent: '✕', ariaLabel: '刪除' });
    del.onclick = () => { todos.splice(i, 1); saveTodos(); };
    return el('li', { className: td.done ? 'done' : '' }, cb, el('span', { textContent: td.text }), del);
  }));
  const left = todos.filter((x) => !x.done).length;
  $('#todoCount').textContent = todos.length ? `${left} 件未完成` : '';
}
function saveTodos() { renderTodos(); send({ t: 'todos', list: todos }); }
$('#todoForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const v = $('#todoInput').value.trim();
  if (!v) return;
  if (todos.length >= 30) return toast('待辦最多 30 件');
  todos.push({ text: v.slice(0, 60), done: false });
  $('#todoInput').value = '';
  saveTodos();
});
$('#todoToggle').addEventListener('click', (ev) => {
  const open = $('#todoBody').hidden;
  $('#todoBody').hidden = !open;
  ev.currentTarget.setAttribute('aria-expanded', open);
});

function refreshMembers() {
  const ul = $('#members'), now = performance.now();
  ul.replaceChildren(...[...players.values()].map((p) => {
    const f = p.focus;
    return el('li', {},
      el('span', { textContent: p.name + (p.id === me ? '(你)' : '') + (p.status ? ` · ${p.status}` : '') }),
      el('span', { className: 'st' + (f ? ' focus' : ''), textContent: f ? (f.phase === 'break' ? '休息中 ' : '專注中 ') + focusClock(f, now) : `累計 ${p.totalMinutes} 分` }));
  }));
  $('#online').textContent = players.size;
}

// ---------- 聊天 ----------
$('#chatForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const v = $('#chatInput').value.trim();
  if (v) send({ t: 'chat', text: v });
  $('#chatInput').value = '';
});
function buildEmotes(list) {
  $('#emotes').replaceChildren(...list.map((e) => el('button', { type: 'button', textContent: e, onclick: () => send({ t: 'emote', e }) })));
}

// ---------- 佈置 ----------
function setHolding(h) {
  holding = h; hover = null;
  syncGhost();
  $('#editBar').hidden = !h;
  if (h) {
    $('#editHint').textContent = h.fromId ? `移動「${CATALOG[h.type].name}」:點選新的位置` : `放置「${CATALOG[h.type].name}」:點選位置(可連續放)`;
    $('#editRemove').hidden = !h.fromId;
  }
  document.querySelectorAll('.item').forEach((x) => x.classList.toggle('on', !!h && !h.fromId && x.dataset.type === h.type));
}
$('#editCancel').addEventListener('click', () => setHolding(null));
$('#editRemove').addEventListener('click', () => { if (holding?.fromId) send({ t: 'remove_item', id: holding.fromId }); setHolding(null); });

function buildCatalog() {
  $('#catalog').replaceChildren(...Object.entries(CATALOG).map(([type, d]) => {
    const cv = el('canvas', { width: 160, height: 160 });
    snapshot(buildItem(type), cv, d.kind === 'wall' ? FRONT_DIR : VIEW_DIR);
    const card = el('div', { className: 'item' }, cv, el('span', { textContent: d.name }));
    card.dataset.type = type;
    card.addEventListener('click', () => {
      if (!canEdit()) return;
      setHolding(holding && !holding.fromId && holding.type === type ? null : { type });
    });
    return card;
  }));
}
function swatches(box, palettes, key) {
  box.replaceChildren(...palettes.map((p, i) => {
    const b = el('button', { type: 'button', title: `樣式 ${i + 1}`, className: room[key] === i ? 'on' : '' });
    b.style.background = p[0];
    b.onclick = () => send({ t: 'theme', [key]: i });
    return b;
  }));
}
function refreshRoomUI() {
  const ok = canEdit();
  $('#decorBody').hidden = !ok;
  $('#decorHint').textContent = ok
    ? '選一件家具後點房間放置;直接點房間裡的家具可以移動或收回。'
    : '這是朋友的房間,主人沒有開放佈置。回到自己的房間就能自由佈置。';
  swatches($('#wallSwatches'), WALLS, 'wall');
  swatches($('#floorSwatches'), FLOORS, 'floor');
  $('#guestsEditRow').hidden = !room.mine;
  $('#guestsEdit').checked = room.guestsEdit;
}
$('#guestsEdit').addEventListener('change', (ev) => send({ t: 'room_settings', guestsEdit: ev.target.checked }));

// ---------- 角色 ----------
let draft = null, profileTimer = 0;
function setProfile(p, first) {
  profile = p;
  $('#statMin').textContent = p.totalMinutes;
  $('#statSes').textContent = p.sessions;
  if (first || !draft) {
    draft = { name: p.name, avatar: { ...p.avatar } };
    $('#nameInput').value = p.name;
    buildAvatarOptions();
  }
  if (first) {
    todos = (p.todos || []).map((x) => ({ ...x })); renderTodos();
    $('#statusInput').value = p.status || '';
    setPose(p.pose || 0);
  }
  refreshTimer();
}
function pushProfile() {
  clearTimeout(profileTimer);
  profileTimer = setTimeout(() => send({ t: 'profile', name: draft.name, avatar: draft.avatar }), 350);
}
function buildAvatarOptions() {
  const rows = [
    ['膚色', 'skin', SKIN.map((c) => ({ color: c }))],
    ['造型', 'hair', LOOK_NAMES.map((n) => ({ text: n }))],
    ['髮色', 'hairColor', HAIRC.map((c) => ({ color: c }))],
    ['上衣', 'shirt', SHIRT.map((c) => ({ color: c }))],
  ];
  $('#avatarOptions').replaceChildren(...rows.flatMap(([title, key, opts]) => [
    el('h3', { textContent: title }),
    el('div', { className: 'swatches' }, ...opts.map((o, i) => {
      const b = el('button', { type: 'button', className: draft.avatar[key] === i ? 'on' : '', textContent: o.text || '', title: o.text || `${title} ${i + 1}` });
      if (o.color) b.style.background = o.color; else b.classList.add('txt');
      b.onclick = () => { draft.avatar[key] = i; buildAvatarOptions(); pushProfile(); };
      return b;
    })),
  ]));
  renderAvatarPreview();
}
$('#nameInput').addEventListener('input', (ev) => {
  const v = ev.target.value.trim();
  if (v) { draft.name = v; pushProfile(); }
});

// ---------- 設定:存檔、房間 ----------
$('#saveCode').value = token;
$('#showCode').addEventListener('click', (ev) => {
  const inp = $('#saveCode'), show = inp.type === 'password';
  inp.type = show ? 'text' : 'password';
  ev.target.textContent = show ? '隱藏' : '顯示';
});
async function copy(text, okMsg) {
  try { await navigator.clipboard.writeText(text); toast(okMsg); }
  catch { prompt('請手動複製:', text); }
}
$('#copyCode').addEventListener('click', () => copy(token, '存檔碼已複製,請妥善保管'));
$('#copyLink').addEventListener('click', () => copy(`${location.origin}${location.pathname}?room=${room.code}`, '邀請連結已複製,傳給朋友吧!'));
$('#restoreBtn').addEventListener('click', () => {
  const v = $('#restoreInput').value.trim();
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(v)) return toast('存檔碼格式不正確');
  if (v === token) return toast('這就是目前的存檔');
  if (!confirm('載入後,這個裝置會改用該存檔。目前的存檔碼請先自行備份,確定嗎?')) return;
  pendingRestore = v;
  send({ t: 'check', token: v });
});
const gotoRoom = (code) => { location.href = location.pathname + (code ? '?room=' + encodeURIComponent(code) : ''); };
$('#goHome').addEventListener('click', () => gotoRoom(profile.room));
$('#joinBtn').addEventListener('click', () => {
  const v = $('#joinInput').value.trim().toUpperCase();
  if (/^[A-Z0-9]{6}$/.test(v)) gotoRoom(v); else toast('房號是 6 個英數字');
});

// ---------- 環境音(Web Audio 即時合成,不需音檔) ----------
let ac = null;
const SOUNDS = {
  rain: { name: '雨聲', make(out) {
    const src = noise(false), hp = ac.createBiquadFilter(), lp = ac.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 900; lp.type = 'lowpass'; lp.frequency.value = 7000;
    src.connect(hp).connect(lp).connect(out); src.start();
    return () => src.stop();
  } },
  wind: { name: '白噪音', make(out) {
    const src = noise(true), lp = ac.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 500;
    src.connect(lp).connect(out); src.start();
    return () => src.stop();
  } },
  music: { name: '輕音樂', make(out) {
    const lp = ac.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 1100; lp.connect(out);
    const chords = [[220, 261.6, 329.6, 392], [174.6, 220, 261.6, 329.6], [196, 246.9, 293.7, 370], [164.8, 207.7, 246.9, 311.1]];
    const penta = [440, 523.3, 587.3, 659.3, 784];
    let i = 0, next = ac.currentTime + .1;
    const tone = (f, at, dur, vol, type) => {
      const o = ac.createOscillator(), g = ac.createGain();
      o.type = type; o.frequency.value = f;
      g.gain.setValueAtTime(0, at); g.gain.linearRampToValueAtTime(vol, at + Math.min(.6, dur / 3)); g.gain.exponentialRampToValueAtTime(.0001, at + dur);
      o.connect(g).connect(lp); o.start(at); o.stop(at + dur + .05);
    };
    const id = setInterval(() => {
      while (next < ac.currentTime + 1) {
        chords[i++ % chords.length].forEach((f) => tone(f, next, 4.2, .09, 'triangle'));
        for (let k = 0; k < 4; k++) if (Math.random() < .6) tone(penta[Math.floor(Math.random() * penta.length)], next + k + Math.random() * .2, 1.4, .06, 'sine');
        next += 4;
      }
    }, 300);
    return () => clearInterval(id);
  } },
};
function noise(brown) {
  const buf = ac.createBuffer(1, ac.sampleRate * 3, ac.sampleRate), d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1;
    d[i] = brown ? (last = (last + .02 * w) / 1.02) * 3.5 : w * .25;
  }
  const src = ac.createBufferSource(); src.buffer = buf; src.loop = true;
  return src;
}
$('#sounds').replaceChildren(...Object.entries(SOUNDS).map(([key, s]) => {
  const btn = el('button', { type: 'button', textContent: s.name });
  const vol = el('input', { type: 'range', min: 0, max: 100, value: 50, ariaLabel: s.name + ' 音量' });
  let stop = null, gain = null;
  btn.onclick = () => {
    if (stop) { stop(); gain.disconnect(); stop = null; btn.classList.remove('on'); return; }
    ac = ac || new AudioContext();
    ac.resume();
    gain = ac.createGain(); gain.gain.value = vol.value / 100; gain.connect(ac.destination);
    stop = s.make(gain);
    btn.classList.add('on');
  };
  vol.oninput = () => { if (gain) gain.gain.value = vol.value / 100; };
  return el('div', { className: 'sound' }, btn, vol);
}));
function chime() {
  try {
    ac = ac || new AudioContext(); ac.resume();
    [659.3, 784, 1046.5].forEach((f, i) => {
      const o = ac.createOscillator(), g = ac.createGain(), at = ac.currentTime + i * .18;
      o.frequency.value = f; g.gain.setValueAtTime(.18, at); g.gain.exponentialRampToValueAtTime(.0001, at + .8);
      o.connect(g).connect(ac.destination); o.start(at); o.stop(at + .85);
    });
  } catch {}
}

window.__booted = true;
connect();
requestAnimationFrame(frame);
})();
