/* 悠悠自習室 — 前端(three.js 等角 3D 房間) */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

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
const WALLH = 3.3;
let COLS = 6, ROWS = 5, CATALOG = {};
// 膚色是疊在原貼圖上的色調(第一個 = 原色);髮色與上衣的第一個選項也是「原色」
const SKIN = ['#ffffff', '#ffeadb', '#f4cfb2', '#d6a27c', '#a8704e'];
const HAIRC = [null, '#4a3f52', '#7a5238', '#c58a4a', '#f2cf7a', '#f29ab0', '#8ea4ee'];
const SHIRT = [null, '#f08d94', '#ffc98a', '#9ed59a', '#7cc3d6', '#8c9cea', '#c09ae0', '#56506e'];
const LOOK_NAMES = ['女生 A', '男生 A', '女生 B', '男生 B', '女生 C', '女生 D'];
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
  ws.onopen = () => send({ t: 'hello', token, tz: -new Date().getTimezoneOffset(), room: new URLSearchParams(location.search).get('room') || '' });
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
    setParty(null);
    m.players.forEach(addPlayer);
    setProfile(m.profile, true);
    $('#overlay').hidden = true;
    $('#roomCode').textContent = room.code;
    $('#goHome').hidden = room.mine;
    if (!new URLSearchParams(location.search).get('room') || m.notice) {
      history.replaceState(null, '', '?room=' + room.code);
    }
    buildEmotes(m.emotes);
    buildPresets(m.presets || []);
    applyMood();
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
  party(m) { setParty(m.party); },
  party_done(m) {
    const now = performance.now();
    for (const d of m.done) { const p = players.get(d.id); if (p) p.cheerUntil = now + 7000; }
    if (!m.done.length) return;
    sysLog(`共同專注 ${m.minutes} 分鐘完成:${m.done.map((d) => d.name).join('、')}`);
    if (m.done.some((d) => d.id === me)) takeGroupPhoto(m); else toast(`${m.done.length} 人完成了共同專注 ${m.minutes} 分鐘`);
  },
  focus_done(m) {
    if (m.stopped) { if (m.minutes) toast(`已記錄 ${m.minutes} 分鐘專注`); }
    else if (m.party) toast(`共同專注 ${m.minutes} 分鐘完成!`);
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
const camera = new THREE.PerspectiveCamera(50, 1, 0.08, 120);

function addLights(sc, shadows) {
  const hemi = new THREE.HemisphereLight(0xffeedd, 0x8f7fc0, 0.95);
  const sun = new THREE.DirectionalLight(0xffdcb4, 2.7);
  sun.position.set(COLS / 2 + 7, 13, ROWS + 5);
  sun.target.position.set(COLS / 2 - 1, 0, ROWS / 2 - 1);
  if (shadows) {
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -11, right: 11, top: 11, bottom: -11, near: 1, far: 40 });
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03; sun.shadow.radius = 5;
  }
  // 室內的暖色主燈:白天關著,黃昏和夜晚才亮
  const roomLight = new THREE.PointLight(0xffc48a, 0, 16, 1.5);
  roomLight.position.set(COLS / 2, WALLH - 0.35, ROWS / 2 + 0.3);
  sc.add(hemi, sun, sun.target, roomLight);
  return { hemi, sun, roomLight };
}
const LIGHTS = addLights(scene, true);

// 光線氛圍:白天 / 黃昏 / 夜晚(自動 = 依你當地的時間)
const MOODS = {
  day:   { sky: 0xffeedd, ground: 0x8f7fc0, hemi: 0.95, sun: 0xffdcb4, sunI: 2.7,  lamp: 1.4, room: 0, exp: 1.12, bloomT: 1.7, bloomS: 0.2 },
  dusk:  { sky: 0xffd2b4, ground: 0x7a659e, hemi: 0.8,  sun: 0xff9a62, sunI: 1.6,  lamp: 2.4, room: 4, exp: 1.08, bloomT: 1.7, bloomS: 0.24 },
  night: { sky: 0xd8d2ee, ground: 0x554a70, hemi: 0.72, sun: 0xb4c0f4, sunI: 0.35, lamp: 3.2, room: 9, exp: 1.04, bloomT: 1.7, bloomS: 0.28 },
};
let moodPref = store.get('yoyo_mood') || 'auto', mood = 'day';
const autoMood = () => { const h = new Date().getHours() + new Date().getMinutes() / 60; return h < 6 || h >= 19 ? 'night' : h >= 17 || h < 7.5 ? 'dusk' : 'day'; };
let lampLights = [];
function applyMood() {
  const next = MOODS[moodPref] ? moodPref : autoMood(), changed = next !== mood;
  mood = next;
  const m = MOODS[mood];
  LIGHTS.hemi.color.set(m.sky); LIGHTS.hemi.groundColor.set(m.ground); LIGHTS.hemi.intensity = m.hemi;
  LIGHTS.sun.color.set(m.sun); LIGHTS.sun.intensity = m.sunI;
  LIGHTS.roomLight.intensity = m.room;
  renderer.toneMappingExposure = m.exp;
  if (bloom) { bloom.threshold = m.bloomT; bloom.strength = m.bloomS; }
  for (const l of lampLights) l.intensity = m.lamp;
  document.body.dataset.mood = mood;
  return changed;
}
setInterval(() => { if (applyMood()) rebuildRoom(); }, 60000);

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
const modelsReady0 = Promise.all(MODEL_NAMES.map((n) => new GLTFLoader().loadAsync(`/assets/kaykit/${n}.gltf`).then((g) => {
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
// Kenney Furniture Kit / Mini Arcade(CC0):比例較修長,放大 2 倍就是真實尺寸
const KFILES = ['desk', 'chairDesk', 'chairCushion', 'chairModernCushion', 'stoolBar', 'bookcaseOpen', 'bookcaseClosedWide', 'bookcaseOpenLow', 'bookcaseClosed',
  'bedDouble', 'bedBunk', 'loungeSofa', 'loungeDesignSofa', 'loungeChair', 'loungeSofaOttoman', 'benchCushion', 'tableCoffee', 'table', 'sideTableDrawers',
  'kitchenFridge', 'cabinetTelevision', 'televisionModern', 'speaker', 'lampRoundFloor', 'lampSquareFloor', 'pottedPlant', 'coatRackStanding', 'trashcan',
  'cardboardBoxClosed', 'cardboardBoxOpen', 'laptop', 'computerScreen', 'computerKeyboard', 'computerMouse', 'books', 'plantSmall1', 'plantSmall2',
  'lampRoundTable', 'radio', 'speakerSmall', 'kitchenCoffeeMachine', 'lampWall', 'bathroomMirror', 'kitchenCabinetUpper',
  'rugRound', 'rugSquare', 'rugRectangle', 'rugDoormat', 'arcade-machine', 'vending-machine', 'claw-machine', 'pinball'];
const KS = 2, KBB = {}; // KBB:每個模型的外框(原始尺寸)
// 原始配色偏橘偏紅,換成柔和一點的預設色
const KBASE = { wood: '#d9b38a', woodDark: '#a67c56', carpet: '#dd8f84', carpetDarker: '#b96f66', carpetBlue: '#7d9fd6', plant: '#62b97c', fur: '#b98a62' };
const kitReady = Promise.all(KFILES.map((n) => new GLTFLoader().loadAsync(`/assets/kenney/${n}.glb`).then((g) => {
  g.scene.traverse((o) => {
    if (!o.isMesh) return;
    const m = o.material, nm = m.name;
    o.castShadow = !n.startsWith('rug') && nm !== 'glass'; o.receiveShadow = true;
    m.roughness = 0.88; m.metalness = 0;
    if (KBASE[nm]) m.color.set(KBASE[nm]);
    if (nm === 'lamp') { m.color.set('#fff1c9'); m.emissive.set('#ffd98a'); m.emissiveIntensity = 1.3; }
    if (nm === 'glass') { m.transparent = true; m.opacity = 0.35; m.depthWrite = false; }
  });
  MODEL['k:' + n] = g.scene;
  KBB[n] = new THREE.Box3().setFromObject(g.scene);
})));
// 換色:有布料的家具換布料顏色,其餘換木頭顏色(0 = 原色)
const FABRICS = [null, '#e7a3b4', '#f0c987', '#9fc7a3', '#8fb8d8', '#a9a0dc', '#f3ede2', '#5b5870'];
const WOODS = [null, '#ecd8b8', '#b88758', '#7a5236', '#f4f1ea', '#4a4652', '#e7b7b0', '#a9c9b4'];
const tintCache = new Map();
function tinted(m, c, fabric) {
  const nm = m.name, col = fabric ? (/^carpet(Blue)?$/.test(nm) ? FABRICS[c] : nm === 'carpetDarker' ? FABRICS[c] + '|d' : null) : (nm === 'wood' ? WOODS[c] : nm === 'woodDark' ? WOODS[c] + '|d' : null);
  if (!col) return m;
  const key = m.uuid + col;
  if (!tintCache.has(key)) { const t = m.clone(); t.color.set(col.split('|')[0]); if (col.endsWith('|d')) t.color.multiplyScalar(0.72); tintCache.set(key, t); }
  return tintCache.get(key);
}
// 放一個 Kenney 模型:以外框中心對齊 (x, z),底部貼在 y;fit = [寬, 深] 時超過會等比例縮小
function kput(g, n, o = {}) {
  const bb = KBB[n], m = MODEL['k:' + n].clone();
  let s = o.s || KS;
  if (o.fit) s = Math.min(s, o.fit[0] / (bb.max.x - bb.min.x), o.fit[1] / (bb.max.z - bb.min.z));
  if (o.c) { let fabric = false; m.traverse((ch) => { if (ch.isMesh && /^carpet(Blue)?$/.test(ch.material.name)) fabric = true; }); m.traverse((ch) => { if (ch.isMesh) ch.material = tinted(ch.material, o.c, fabric); }); }
  m.scale.setScalar(s);
  m.position.set(-(bb.min.x + bb.max.x) / 2 * s, -bb.min.y * s, -(bb.min.z + bb.max.z) / 2 * s);
  const piv = new THREE.Group();
  piv.add(m); piv.position.set(o.x || 0, o.y || 0, o.z || 0); piv.rotation.y = o.ry || 0;
  g.add(piv);
  return { piv, s, w: (bb.max.x - bb.min.x) * s, h: (bb.max.y - bb.min.y) * s, d: (bb.max.z - bb.min.z) * s };
}
// 新家具的規格:m 模型、s 縮放、back 靠佔地後緣(適合靠牆)、seat 座面高度、surf 桌面可放小物、lamp 會發光、y 牆面掛飾的高度
const KIT = {
  kdesk: { m: 'desk', surf: 1 }, dining: { m: 'table', surf: 1 }, coffee: { m: 'tableCoffee', surf: 1 }, side: { m: 'sideTableDrawers', surf: 1, back: 1 },
  kchair: { m: 'chairDesk', seat: 0.5 }, cchair: { m: 'chairCushion', seat: 0.46 }, mchair: { m: 'chairModernCushion', seat: 0.46 }, barstool: { m: 'stoolBar' },
  kcase: { m: 'bookcaseOpen', back: 1 }, doorcase: { m: 'bookcaseClosed', back: 1 }, widecase: { m: 'bookcaseClosedWide', back: 1 }, lowcase: { m: 'bookcaseOpenLow', back: 1, surf: 1 },
  rack: { m: 'coatRackStanding' }, box: { m: 'cardboardBoxClosed' },
  dbed: { m: 'bedDouble', surf: 0.46 }, bunk: { m: 'bedBunk' }, ksofa: { m: 'loungeSofa', back: 1 }, dsofa: { m: 'loungeDesignSofa', back: 1 },
  lchair: { m: 'loungeChair', seat: 0.4, back: 1 }, ottoman: { m: 'loungeSofaOttoman' }, bench: { m: 'benchCushion', seat: 0.46, back: 1 },
  fridge: { m: 'kitchenFridge', back: 1 }, spk: { m: 'speaker' },
  arcade: { m: 'arcade-machine', s: 2 }, vending: { m: 'vending-machine', s: 1.9, back: 1 }, claw: { m: 'claw-machine', s: 1.4 }, pinball: { m: 'pinball', s: 2 },
  flamp: { m: 'lampRoundFloor', lamp: 1 }, flamp2: { m: 'lampSquareFloor', lamp: 1 }, bigplant: { m: 'pottedPlant' }, bin: { m: 'trashcan', s: 1.3 },
  tlaptop: { m: 'laptop' }, tbooks: { m: 'books', s: 2.4 }, tplant: { m: 'plantSmall1', s: 2.4 }, tplant2: { m: 'plantSmall2', s: 2.4 }, tlamp: { m: 'lampRoundTable', lamp: 1 },
  radio: { m: 'radio', s: 1.5 }, tspk: { m: 'speakerSmall', s: 1.6 }, brew: { m: 'kitchenCoffeeMachine' }, obox: { m: 'cardboardBoxOpen', s: 1.6 },
  wlamp: { m: 'lampWall', y: 2.1, lamp: 1 }, mirror: { m: 'bathroomMirror', y: 1.25, s: 2.4 }, wcab: { m: 'kitchenCabinetUpper', y: 1.7 },
  rround: { m: 'rugRound' }, rsquare: { m: 'rugSquare' }, rbig: { m: 'rugRectangle' }, mat: { m: 'rugDoormat' },
};
const kScale = (type) => { const k = KIT[type], d = CATALOG[type], bb = KBB[k.m]; return Math.min(k.s || KS, (d.w - 0.06) / (bb.max.x - bb.min.x), (d.h - 0.04) / (bb.max.z - bb.min.z)); };
function buildKit(g, type, o = {}) {
  const k = KIT[type], d = CATALOG[type];
  if (d.kind === 'wall') {
    const bb = KBB[k.m], s = k.s || KS, info = kput(g, k.m, { s, x: d.w / 2, y: k.y, z: (bb.max.z - bb.min.z) * s / 2 + 0.01, c: o.c });
    if (k.lamp) g.userData.lampAt = new THREE.Vector3(d.w / 2, k.y, 0.35);
    return info;
  }
  const info = kput(g, k.m, { s: k.s, fit: [d.w - 0.06, d.h - 0.04], x: d.w / 2, z: d.h / 2, c: o.c });
  if (k.back) info.piv.position.z = info.d / 2 + 0.04;
  if (k.lamp) g.userData.lampAt = new THREE.Vector3(d.w / 2, info.h * 0.86, d.h / 2);
  return info;
}
// 發亮的螢幕畫面(電腦螢幕、筆電、電視共用)
const screenTex = () => canvasTex('pcscreen', 256, 144, (c, w, h) => {
  const gr = c.createLinearGradient(0, 0, w, h); gr.addColorStop(0, '#2c3a78'); gr.addColorStop(1, '#7a4f9a'); c.fillStyle = gr; c.fillRect(0, 0, w, h);
  c.fillStyle = 'rgba(255,255,255,.92)'; c.fillRect(18, 16, 132, 96); c.fillStyle = '#8c9cea'; c.fillRect(18, 16, 132, 12);
  c.fillStyle = '#c9cfe8'; for (let i = 0; i < 6; i++) c.fillRect(28, 38 + i * 11, 60 + ((i * 37) % 50), 5);
  c.fillStyle = 'rgba(255,255,255,.85)'; c.fillRect(162, 30, 78, 60); c.fillStyle = '#ffc98a'; c.beginPath(); c.arc(201, 60, 18, 0, 7); c.fill();
});

const modelsReady = Promise.all([modelsReady0, kitReady]);
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
    const lit = box(0.4, 0.24, 0.006, '#bfe6f5', 0, 0.05, -0.087, 0.002, glow('#9fd8f0', 1.3)); lit.rotation.x = -0.18; lap.add(lit);
    lap.position.set(sx, 0.82, 0.5); lap.rotation.y = side > 0 ? 0 : Math.PI;
    g.add(lap);
    if (o.clear) return; // 桌上已經擺了別的小物,就不放內建的杯子和書
    g.add(cyl(0.055, 0.045, 0.11, CREAM, sx + (sx > 1 ? -0.42 : 0.42), 0.82, 0.5 - side * 0.12), cyl(0.045, 0.045, 0.01, '#8a5a3c', sx + (sx > 1 ? -0.42 : 0.42), 0.925, 0.5 - side * 0.12));
    g.add(box(0.32, 0.05, 0.24, BOOKS[0], ox, 0.82, 0.5, 0.01));
    const b2 = box(0.28, 0.05, 0.22, BOOKS[2], ox, 0.87, 0.5, 0.01); b2.rotation.y = 0.25; g.add(b2);
    g.add(cyl(0.05, 0.04, 0.12, '#8c9cea', ox + (sx > 1 ? -0.22 : 0.22), 0.82, 0.5 - side * 0.2), cyl(0.008, 0.008, 0.16, '#ffc98a', ox + (sx > 1 ? -0.23 : 0.21), 0.86, 0.5 - side * 0.2), cyl(0.008, 0.008, 0.17, '#ee8a8f', ox + (sx > 1 ? -0.2 : 0.24), 0.86, 0.5 - side * 0.19));
  },
  // 電腦桌:螢幕、鍵盤、滑鼠朝向有椅子的那一側
  pc(g, o = {}) {
    const side = o.side || 1, sx = o.sx ?? 0.95, ox = sx > 1 ? 0.38 : 1.62;
    put(g, 'table_medium_long', [0.64, 0.82, 0.42], 1, 0, 0.5);
    const set = new THREE.Group();
    set.add(box(0.2, 0.02, 0.14, '#3b3d52', 0, 0, -0.16, 0.006), box(0.04, 0.16, 0.03, '#3b3d52', 0, 0.02, -0.17, 0.006));
    set.add(box(0.72, 0.42, 0.03, '#2b2d40', 0, 0.16, -0.15, 0.012));
    const scr = picture(0.67, 0.37, canvasTex('pcscreen', 256, 144, (c, w, h) => {
      const gr = c.createLinearGradient(0, 0, w, h); gr.addColorStop(0, '#2c3a78'); gr.addColorStop(1, '#7a4f9a'); c.fillStyle = gr; c.fillRect(0, 0, w, h);
      c.fillStyle = 'rgba(255,255,255,.92)'; c.fillRect(18, 16, 132, 96); c.fillStyle = '#8c9cea'; c.fillRect(18, 16, 132, 12);
      c.fillStyle = '#c9cfe8'; for (let i = 0; i < 6; i++) c.fillRect(28, 38 + i * 11, 60 + ((i * 37) % 50), 5);
      c.fillStyle = 'rgba(255,255,255,.85)'; c.fillRect(162, 30, 78, 60); c.fillStyle = '#ffc98a'; c.beginPath(); c.arc(201, 60, 18, 0, 7); c.fill();
    }), 0, 0.37, -0.133);
    set.add(scr);
    set.add(box(0.46, 0.02, 0.15, '#e6e8f0', 0, 0, 0.1, 0.006), box(0.07, 0.022, 0.1, '#e6e8f0', 0.36, 0, 0.1, 0.01), box(0.2, 0.004, 0.18, '#56506e', 0.36, 0, 0.1, 0.002));
    set.position.set(sx, 0.82, 0.5); set.rotation.y = side > 0 ? 0 : Math.PI;
    g.add(set);
    if (o.clear) return;
    g.add(cyl(0.055, 0.045, 0.11, CREAM, ox, 0.82, 0.5 + side * 0.08), cyl(0.045, 0.045, 0.01, '#8a5a3c', ox, 0.925, 0.5 + side * 0.08));
    g.add(box(0.26, 0.04, 0.2, BOOKS[4], ox, 0.82, 0.5 - side * 0.16, 0.01));
    g.userData.glowAt = null;
  },
  poster(g) {
    const tex = canvasTex('poster', 256, 352, (c, w, h) => {
      const gr = c.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#2b2f66'); gr.addColorStop(0.55, '#c45c8a'); gr.addColorStop(1, '#ffb27a'); c.fillStyle = gr; c.fillRect(0, 0, w, h);
      c.fillStyle = '#ffe3b0'; c.beginPath(); c.arc(w / 2, h * 0.52, 46, 0, 7); c.fill();
      c.fillStyle = '#3a2a5c'; c.beginPath(); c.moveTo(0, h); c.lineTo(0, h * 0.72); c.lineTo(70, h * 0.56); c.lineTo(130, h * 0.7); c.lineTo(190, h * 0.6); c.lineTo(w, h * 0.74); c.lineTo(w, h); c.fill();
      c.fillStyle = '#241a40'; c.beginPath(); c.moveTo(0, h); c.lineTo(0, h * 0.86); c.lineTo(90, h * 0.76); c.lineTo(170, h * 0.88); c.lineTo(w, h * 0.8); c.lineTo(w, h); c.fill();
      c.fillStyle = '#fff'; for (let i = 0; i < 18; i++) { c.globalAlpha = 0.5 + (i % 4) * 0.12; c.fillRect((i * 67) % w, (i * 41) % (h * 0.4), 2, 2); } c.globalAlpha = 1;
    });
    g.add(box(0.74, 1.02, 0.03, '#fbf6ec', 0.5, 1.42, 0.02, 0.008), picture(0.68, 0.96, tex, 0.5, 1.93, 0.037));
  },
  neon(g) {
    const pink = mat('#ff7fb0', glow('#ff4f98', 5)), blue = mat('#9fe6ff', glow('#5fd0ff', 5));
    const arc = new THREE.Mesh(geo('neonArc', () => new THREE.TorusGeometry(0.3, 0.022, 10, 48, Math.PI * 1.25)), pink);
    arc.position.set(0.46, 2.05, 0.05); arc.rotation.z = Math.PI * 0.42;
    const arc2 = new THREE.Mesh(geo('neonArc2', () => new THREE.TorusGeometry(0.24, 0.02, 10, 40, Math.PI * 0.95)), pink);
    arc2.position.set(0.56, 2.08, 0.05); arc2.rotation.z = Math.PI * 0.56;
    const star = new THREE.Group();
    for (const a of [0, Math.PI / 2, Math.PI / 4, -Math.PI / 4]) { const b = new THREE.Mesh(geo('neonBar', () => new THREE.CapsuleGeometry(0.016, 0.2, 4, 8)), blue); b.rotation.z = a; b.scale.y = a % (Math.PI / 2) ? 0.6 : 1; star.add(b); }
    star.position.set(0.72, 2.3, 0.05);
    g.add(arc, arc2, star, box(0.6, 0.02, 0.02, '#3b3a4a', 0.5, 1.7, 0.02, 0.005));
    g.userData.neonAt = new THREE.Vector3(0.5, 2.1, 0.5);
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
      if (l) { l.intensity = 4 * k; l.color.setHSL(hue, 1, 0.5); }
    };
    g.userData.glowAt = new THREE.Vector3(0.5, 0.62, 1.05);
  },

  cat(g) {
    const m = cloneSkinned(MODEL.cat);
    const bb = new THREE.Box3();
    m.updateMatrixWorld(true);
    m.traverse((o) => { if (o.isSkinnedMesh) { o.computeBoundingBox(); bb.union(o.boundingBox.clone().applyMatrix4(o.matrixWorld)); } });
    const k = 0.42 / (bb.max.y - bb.min.y || 1); // 貓咪大約到小腿高
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
    const mode = mood;
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
        for (const [x, y, r] of [[60, 60, 20], [86, 52, 26], [114, 62, 18], [176, 96, 12], [192, 92, 15]]) { c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); }
      }
      // 遠山與近處的樹叢,窗外才不會只有天空
      const land = { night: ['#232a55', '#161b3a'], dusk: ['#7d5a8c', '#4b3a66'], day: ['#8fcf8a', '#5fae6a'] }[mode];
      c.fillStyle = land[0]; c.beginPath(); c.moveTo(0, h); c.lineTo(0, h * 0.74); c.quadraticCurveTo(w * 0.25, h * 0.58, w * 0.5, h * 0.72); c.quadraticCurveTo(w * 0.78, h * 0.86, w, h * 0.66); c.lineTo(w, h); c.fill();
      c.fillStyle = land[1]; c.beginPath(); c.moveTo(0, h); c.lineTo(0, h * 0.88);
      for (let i = 0; i <= 8; i++) c.quadraticCurveTo((i + 0.5) * w / 8 - w / 16, h * (0.8 + (i % 3) * 0.02), (i + 1) * w / 8, h * 0.9);
      c.lineTo(w, h); c.fill();
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
// 螢幕 + 鍵盤 + 滑鼠(放在桌面上的小物)
BUILD.monitor = (g) => {
  const sc = kput(g, 'computerScreen', { x: 0.5, z: 0.3 });
  g.add(picture(sc.w * 0.86, sc.h * 0.62, screenTex(), 0.5, sc.h * 0.6, 0.3 + sc.d / 2 - 0.085));
  kput(g, 'computerKeyboard', { x: 0.44, z: 0.66 }); kput(g, 'computerMouse', { x: 0.84, z: 0.66 });
};
// 電視櫃 + 液晶電視
BUILD.tv2 = (g, o = {}) => {
  const cab = kput(g, 'cabinetTelevision', { x: 1, z: 0, c: o.c, fit: [1.9, 0.9] }); cab.piv.position.z = cab.d / 2 + 0.04;
  const tv = kput(g, 'televisionModern', { x: 1, y: cab.h, z: cab.d / 2 + 0.04 });
  const scr = picture(tv.w * 0.93, tv.h * 0.74, screenTex(), 1, cab.h + tv.h * 0.56, cab.d / 2 + 0.04 + 0.062);
  g.add(scr);
  g.userData.glowAt = new THREE.Vector3(1, cab.h + 0.4, 0.9);
};
for (const type of Object.keys(KIT)) BUILD[type] = (g, o) => buildKit(g, type, o);
function buildItem(type, opt) {
  const g = new THREE.Group();
  BUILD[type]?.(g, opt);
  return g;
}
// 可以放小物的檯面高度(沒有就是 0 = 地板)
function surfTop(it) {
  if (it.type === 'desk' || it.type === 'pc') return 0.82;
  if (it.type === 'tv2') return 0;
  const k = KIT[it.type];
  return !k?.surf ? 0 : k.surf !== 1 ? k.surf : (KBB[k.m].max.y - KBB[k.m].min.y) * kScale(it.type); // surf 是數字時直接當檯面高度(例如床墊)
}
function surfAt(x, y) {
  let top = 0;
  for (const it of room.items) {
    const d = CATALOG[it.type];
    if (!d || d.kind !== 'floor') continue;
    const [w, h] = dimsOf(it.type, it.r);
    if (x >= it.x && x < it.x + w && y >= it.y && y < it.y + h) top = Math.max(top, surfTop(it));
  }
  return top;
}

// ---------- 座位:椅子自動朝向最近的桌子,專注時角色會走過去坐下 ----------
const SEAT_TYPES = { chair: 0.44, stool: 0.42, armchair: 0.4, kchair: 0.5, cchair: 0.46, mchair: 0.46, lchair: 0.4, bench: 0.46 }; // 座面高度
const DESK_TYPES = ['desk', 'pc', 'table', 'kdesk', 'dining'];
let seats = []; // {id, x, z, face, h}
// 家具的旋轉(r = 0–3,每格 90 度)與旋轉後的佔地
const rotOf = (r) => (((r | 0) % 4) + 4) % 4;
const dimsOf = (type, r) => { const d = CATALOG[type]; return d.kind !== 'wall' && rotOf(r) % 2 ? [d.h, d.w] : [d.w, d.h]; };
// 世界座標 → 這件家具未旋轉時的本地座標(原點在佔地左後角)
function toLocal(it, wx, wz) {
  const d = CATALOG[it.type], [W, H] = dimsOf(it.type, it.r), th = rotOf(it.r) * Math.PI / 2;
  const dx = wx - (it.x + W / 2), dz = wz - (it.y + H / 2);
  return [dx * Math.cos(th) - dz * Math.sin(th) + d.w / 2, dx * Math.sin(th) + dz * Math.cos(th) + d.h / 2];
}
function computeSeats() {
  const desks = room.items.filter((i) => DESK_TYPES.includes(i.type));
  seats = room.items.filter((i) => SEAT_TYPES[i.type] != null).sort((a, b) => a.id - b.id).map((i) => {
    const x = i.x + 0.5, z = i.y + 0.5;
    let best = null, bd = 2.2, bx = 0, bz = 0;
    for (const d of desks) { // 找最近的桌子(算到桌面範圍內最近的那一點)
      const [W, H] = dimsOf(d.type, d.r);
      const nx = Math.min(Math.max(x, d.x + 0.5), d.x + W - 0.5), nz = Math.min(Math.max(z, d.y + 0.5), d.y + H - 0.5), k = Math.hypot(nx - x, nz - z);
      if (k < bd) { bd = k; best = d; bx = nx - x; bz = nz - z; }
    }
    // 面向桌子(只取前後左右四個方向);附近沒有桌子就照擺放時的方向
    const face = best ? (Math.abs(bz) >= Math.abs(bx) ? (bz > 0 ? 0 : Math.PI) : (bx > 0 ? Math.PI / 2 : -Math.PI / 2)) : rotOf(i.r) * Math.PI / 2;
    return { id: i.id, x, z, face, h: SEAT_TYPES[i.type], desk: best?.id };
  });
}
function assignSeats() {
  if (!room) return;
  const sitters = [...players.values()].filter((p) => p.focus && p.focus.phase === 'focus' && p.pose !== 1).sort((a, b) => (a.id < b.id ? -1 : 1));
  for (const p of players.values()) p.seat = null;
  sitters.forEach((p, i) => { p.seat = seats[i] || null; });
}

// ---------- 角色:VRoid 範例角色(VRM,CC0),動作全部用程式擺骨架 ----------
const CHAR_FILES = ['Sendagaya_Shino', 'Sendagaya_Shibu', 'Vita', 'Sakurada_Fumiriya', 'Vivi', 'Victoria_Rubin'];
const AV_SCALE = 1.15; // 家具模型偏大,角色放大一點比例才協調
const AVATAR_H = 1.55 * AV_SCALE, SIT_FWD = 0.3, CHAIR_FWD = 0.14; // 椅子往桌子拉近一點 // 坐下時往桌子靠近一點,手才搆得到鍵盤
const charCache = new Map(); // 同一個檔案只下載一次;每位玩家各自解析出一份
const loadChar = (i) => {
  if (!charCache.has(i)) charCache.set(i, fetch(`/assets/avatars/${CHAR_FILES[i]}.vrm`).then((r) => { if (!r.ok) throw new Error('avatar ' + r.status); return r.arrayBuffer(); }));
  return charCache.get(i);
};
const vrmLoader = new GLTFLoader();
vrmLoader.register((parser) => new VRMLoaderPlugin(parser));

// 把貼圖改成指定顏色:保留明暗,色相換成 tint;mul = true 時改成直接疊色(膚色用,保留腮紅等細節)
function recolor(tex, tint, mul) {
  const img = tex.image, cv = document.createElement('canvas');
  cv.width = img.width; cv.height = img.height;
  const c = cv.getContext('2d', { willReadFrequently: true });
  c.drawImage(img, 0, 0);
  const d = c.getImageData(0, 0, cv.width, cv.height), px = d.data, col = new THREE.Color(tint);
  let sum = 0, n = 0;
  for (let i = 0; i < px.length; i += 16) if (px[i + 3] > 40) { sum += px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11; n++; }
  const avg = sum / (n || 1) || 128, r = col.r * 255, g = col.g * 255, b = col.b * 255;
  const sr = (v) => Math.pow(v, 1 / 2.2); // tint 是線性色,轉回 sRGB 再乘
  const R = sr(col.r) * 255, G = sr(col.g) * 255, B = sr(col.b) * 255;
  if (mul) for (let i = 0; i < px.length; i += 4) { px[i] *= sr(col.r); px[i + 1] *= sr(col.g); px[i + 2] *= sr(col.b); }
  else for (let i = 0; i < px.length; i += 4) {
    const k = Math.min(1.7, (px[i] * 0.3 + px[i + 1] * 0.59 + px[i + 2] * 0.11) / avg);
    px[i] = Math.min(255, R * k); px[i + 1] = Math.min(255, G * k); px[i + 2] = Math.min(255, B * k);
  }
  c.putImageData(d, 0, 0);
  const t = tex.clone(); t.image = cv; t.needsUpdate = true;
  return t;
}
function tintAvatar(vrm, a) {
  const done = new Map();
  const swap = (tex, tint, mul) => { if (!tex?.image) return tex; const k = tex.uuid + tint; if (!done.has(k)) done.set(k, recolor(tex, tint, mul)); return done.get(k); };
  vrm.scene.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = true; o.receiveShadow = false; o.frustumCulled = false;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      const n = m.name || '';
      const skin = /SKIN/.test(n) && a.skin > 0;
      const tint = skin ? SKIN[a.skin] : /HAIR/.test(n) ? HAIRC[a.hairColor] : /Tops|Onepiece/.test(n) ? SHIRT[a.shirt] : null;
      if (!tint) continue;
      const old = m.map, oldShade = m.shadeMultiplyTexture;
      m.map = swap(old, tint, skin);
      m.shadeMultiplyTexture = oldShade === old ? m.map : swap(oldShade, tint, skin);
      if (m.uniforms?.map) m.uniforms.map.value = m.map;
      if (m.uniforms?.shadeMultiplyTexture) m.uniforms.shadeMultiplyTexture.value = m.shadeMultiplyTexture;
      if (!skin) m.shadeColorFactor?.set(tint).multiplyScalar(0.72);
    }
  });
}

// 立刻回傳一個空群組,模型載入後再填入
function buildAvatar(a, onReady) {
  const g = new THREE.Group();
  g.userData = { ready: false, dead: false };
  loadChar(a.hair % CHAR_FILES.length).then((buf) => vrmLoader.parseAsync(buf.slice(0), '')).then((gltf) => {
    const vrm = gltf.userData.vrm;
    if (g.userData.dead) return VRMUtils.deepDispose(vrm.scene);
    VRMUtils.removeUnnecessaryVertices(vrm.scene);
    VRMUtils.rotateVRM0(vrm); // 舊版 VRM 面向 -z,轉成面向 +z
    tintAvatar(vrm, a);
    vrm.scene.scale.setScalar(AV_SCALE);
    g.add(vrm.scene);
    const H = vrm.humanoid, bone = {};
    for (const n of BONES) bone[n] = H.getNormalizedBoneNode(n);
    const gaze = new THREE.Object3D(); scene.add(gaze);
    if (vrm.lookAt) vrm.lookAt.target = gaze;
    g.userData = { ...g.userData, ready: true, vrm, bone, gaze, hipsY: bone.hips.position.y, flip: vrm.meta?.metaVersion === '0' ? -1 : 1, blinkAt: 2, blink: 0, ph: Math.random() * 6, seat: null, book: null };
    poseAvatar(g, 0, {});
    onReady?.(g);
  }).catch((e) => console.error('avatar load failed', e));
  return g;
}
function disposeAvatar(g) {
  const u = g.userData;
  u.dead = true;
  if (u.gaze) scene.remove(u.gaze);
  if (u.vrm) VRMUtils.deepDispose(u.vrm.scene);
}

// 骨架姿勢:角度以「角色面向 +z、左手在 +x」為準,[x, y, z] 弧度
const BONES = ['hips', 'spine', 'chest', 'neck', 'head', 'leftUpperArm', 'rightUpperArm', 'leftLowerArm', 'rightLowerArm', 'leftHand', 'rightHand', 'leftUpperLeg', 'rightUpperLeg', 'leftLowerLeg', 'rightLowerLeg', 'leftFoot', 'rightFoot'];
const ORDER = { leftLowerArm: 'YXZ', rightLowerArm: 'YXZ' }; // 前臂:先轉手腕朝向,再彎手肘
const tmpE = new THREE.Euler(), tmpQ = new THREE.Quaternion();
// st: { walking, sitting, pose(0 打字 / 1 站 / 2 看書 / 3 寫字), cheering, seatH, ownStool, t }
function poseAvatar(g, dt, st) {
  const u = g.userData;
  if (!u.ready) return;
  const t = (st.t || 0) / 1000 + u.ph, P = {}, sin = Math.sin;
  const arms = (down, fwd, elbow, twist, spread = 0) => {
    P.leftUpperArm = [-fwd, 0, -down]; P.rightUpperArm = [-fwd, 0, down];
    P.leftLowerArm = [twist, -elbow - spread, 0]; P.rightLowerArm = [twist, elbow + spread, 0];
  };
  const breathe = sin(t * 1.6) * 0.012;
  let hipsY = u.hipsY, mode = 'idle';
  if (st.walking) {
    mode = 'walk';
    const w = t * 9, a = sin(w);
    P.leftUpperLeg = [-a * 0.42, 0, 0]; P.rightUpperLeg = [a * 0.42, 0, 0];
    P.leftLowerLeg = [Math.max(0, -Math.cos(w)) * 0.7, 0, 0]; P.rightLowerLeg = [Math.max(0, Math.cos(w)) * 0.7, 0, 0];
    P.leftUpperArm = [a * 0.35, 0, -1.27]; P.rightUpperArm = [-a * 0.35, 0, 1.27];
    P.leftLowerArm = [0, -0.35, 0]; P.rightLowerArm = [0, 0.35, 0];
    P.spine = [0.03, -a * 0.04, 0]; hipsY += Math.abs(Math.cos(w)) * 0.025 - 0.02;
  } else if (st.cheering) {
    mode = 'cheer';
    const b = Math.abs(sin(t * 7));
    P.leftUpperArm = [0, 0, 1.0 + b * 0.25]; P.rightUpperArm = [0, 0, -1.0 - b * 0.25];
    P.leftLowerArm = [0, -0.5, 0]; P.rightLowerArm = [0, 0.5, 0];
    P.leftUpperLeg = [-b * 0.25, 0, 0]; P.rightUpperLeg = [-b * 0.25, 0, 0]; P.leftLowerLeg = [b * 0.5, 0, 0]; P.rightLowerLeg = [b * 0.5, 0, 0];
    P.head = [-0.15, 0, 0]; hipsY += b * 0.05 - 0.03;
  } else if (st.sitting) {
    mode = 'sit';
    hipsY = (st.seatH || 0.42) / AV_SCALE + 0.09;
    P.leftUpperLeg = [-1.5, 0, 0.06]; P.rightUpperLeg = [-1.5, 0, -0.06];
    P.leftLowerLeg = [1.45, 0, 0]; P.rightLowerLeg = [1.45, 0, 0];
    P.spine = [0.1 + breathe, 0, 0]; P.chest = [0.05, 0, 0];
    if (st.pose === 2) { // 看書:雙手把書舉在胸前
      arms(1.2, 0.4, 1.55, 0.3, -0.2);
      P.neck = [0.22, 0, 0]; P.head = [0.18 + sin(t * 0.5) * 0.03, sin(t * 0.23) * 0.05, 0];
    } else if (st.pose === 3) { // 寫字:左手壓著紙,右手小幅移動
      arms(1.15, 0.5, 1.38, 1.3);
      const k = sin(t * 7) * 0.05, k2 = sin(t * 1.3) * 0.1;
      P.rightLowerArm = [1.3, 1.38 + k2 + k, 0]; P.rightHand = [0, 0, k * 2];
      P.neck = [0.3, 0, 0]; P.head = [0.22, -0.12 + k2 * 0.3, 0];
    } else { // 打字:雙手放在鍵盤上,手指輕敲
      arms(1.15, 0.5, 1.38, 1.3);
      P.leftHand = [0, 0, -0.12 + sin(t * 13) * 0.07]; P.rightHand = [0, 0, 0.12 + sin(t * 11 + 1) * 0.07];
      P.neck = [0.14, 0, 0]; P.head = [0.1 + sin(t * 0.4) * 0.03, sin(t * 0.27) * 0.06, 0];
    }
  } else { // 站著:雙手自然垂下,輕微晃動
    arms(1.27, 0.03, 0.18, 0.2);
    P.spine = [breathe, 0, sin(t * 0.7) * 0.015]; P.head = [0, sin(t * 0.31) * 0.08, 0];
    P.leftUpperLeg = [0, 0, 0.03]; P.rightUpperLeg = [0, 0, -0.03];
  }
  const k = dt ? 1 - Math.exp(-dt * (mode === 'walk' ? 18 : 9)) : 1, f = u.flip;
  for (const n of BONES) {
    const b = u.bone[n]; if (!b || n === 'hips') continue;
    const r = P[n] || [0, 0, 0];
    tmpQ.setFromEuler(tmpE.set(r[0] * f, r[1], r[2] * f, ORDER[n] || 'XYZ'));
    b.quaternion.slerp(tmpQ, k);
  }
  u.bone.hips.position.y += (hipsY - u.bone.hips.position.y) * k;
  // 眨眼與表情
  const em = u.vrm.expressionManager;
  if (em) {
    u.blinkAt -= dt;
    if (u.blinkAt < 0) { u.blink = 0.14; u.blinkAt = 2 + Math.random() * 4; }
    u.blink = Math.max(0, u.blink - dt);
    em.setValue('blink', u.blink > 0 ? 1 - Math.abs(u.blink - 0.07) / 0.07 : 0);
    em.setValue('happy', mode === 'cheer' ? 1 : 0);
  }
  // 視線:站著時看鏡頭,坐著時看桌面
  if (mode === 'sit') g.localToWorld(tmpV2.set(0, 0.8, 0.55)); else tmpV2.copy(camera.position);
  u.gaze.position.lerp(tmpV2, dt ? Math.min(1, dt * 4) : 1);
  // 沒有空椅子時自備的小凳子、看書時手上的書
  if (!u.seat && MODEL.chair_stool) u.seat = put(g, 'chair_stool', 0.62, 0, 0, 0);
  if (u.seat) u.seat.visible = mode === 'sit' && !!st.ownStool;
  if (!u.book) {
    u.book = new THREE.Group();
    u.book.add(box(0.34, 0.02, 0.24, BOOKS[3], 0, 0, 0, 0.006), box(0.31, 0.012, 0.22, CREAM, 0, 0.016, 0, 0.004));
    u.book.rotation.x = 0.7; g.add(u.book);
  }
  u.book.visible = mode === 'sit' && st.pose === 2;
  u.book.position.set(0, (st.seatH || 0.42) + 0.5, 0.42);
  u.vrm.update(dt);
}
const tmpV2 = new THREE.Vector3();

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
  // 房間是封閉的:前牆、右牆和天花板(鏡頭在室內,所以看不到外側)。它們不擋陽光,室內才不會全黑
  add(box(COLS + th * 2, WALLH, th, wm, COLS / 2, 0, ROWS + th / 2, 0.03));
  add(box(th, WALLH, ROWS, wm, COLS + th / 2, 0, ROWS / 2, 0.03));
  add(box(COLS, 0.22, 0.05, tm, COLS / 2, 0, ROWS - 0.025, 0.01));
  add(box(0.05, 0.22, ROWS, tm, COLS - 0.025, 0, ROWS / 2, 0.01));
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(COLS + th * 2, ROWS + th * 2), new THREE.MeshStandardMaterial({ color: '#fbf6ec', roughness: 1, emissive: '#fbf6ec', emissiveIntensity: 0.22 }));
  ceil.rotation.x = Math.PI / 2; ceil.position.set(COLS / 2, WALLH, ROWS / 2);
  roomGroup.add(ceil);
  // 房門(在前牆上,純裝飾)
  const door = new THREE.Group();
  door.add(box(1.0, 2.25, 0.06, '#b98352', 0, 0, 0, 0.02), box(1.16, 2.33, 0.04, tm, 0, 0, 0.02, 0.01), sph(0.045, '#e9c46a', -0.36, 1.08, -0.05));
  door.position.set(COLS - 1.3, 0, ROWS - 0.03);
  roomGroup.add(door);
  add(box(COLS + th * 2, 0.45, ROWS + th * 2, tm, COLS / 2, -0.451, ROWS / 2, 0.06));
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
// 把家具包一層,繞著佔地中心轉到指定方向(face 弧度,0 = 朝 +z)
function wrapItem(inner, type, face) {
  const d = CATALOG[type], g = new THREE.Group();
  if (d.kind === 'wall' || !face) { g.add(inner); return g; }
  const odd = Math.round(face / (Math.PI / 2)) % 2 !== 0, W = odd ? d.h : d.w, H = odd ? d.w : d.h;
  const piv = new THREE.Group();
  piv.position.set(W / 2, 0, H / 2); piv.rotation.y = face;
  inner.position.x -= d.w / 2; inner.position.z -= d.h / 2;
  piv.add(inner); g.add(piv);
  return g;
}
function rebuildRoom() {
  if (!room || !MODEL[MODEL_NAMES[0]]) return;
  if (!floorMesh) buildShell();
  const [wc, wt] = WALLS[room.wall] || WALLS[0];
  wallMats[0].color.set(wc); wallMats[1].color.set(wt);
  floorMesh.material.map = floorTex(room.floor); floorMesh.material.needsUpdate = true;
  itemsGroup.clear(); anims = [];
  computeSeats(); assignSeats();
  let lamps = 0, glows = 0;
  lampLights = [];
  for (const it of room.items) {
    if (!CATALOG[it.type]) continue;
    let opt, face = rotOf(it.r) * Math.PI / 2;
    if (it.type === 'desk' || it.type === 'pc') { // 筆電或螢幕擺在有椅子的那一側
      const st = seats.find((q) => q.desk === it.id);
      if (st) { const [lx, lz] = toLocal(it, st.x, st.z); opt = { side: lz > 0.5 ? 1 : -1, sx: Math.min(1.6, Math.max(0.4, lx)) }; }
    }
    if (it.type === 'desk' || it.type === 'pc') { // 桌上擺了小物就清掉內建的雜物
      const [W, H] = dimsOf(it.type, it.r);
      if (room.items.some((q) => CATALOG[q.type]?.kind === 'top' && q.x >= it.x && q.x < it.x + W && q.y >= it.y && q.y < it.y + H)) opt = { ...opt, clear: true };
    }
    if (it.c) opt = { ...opt, c: it.c };
    const inner = buildItem(it.type, opt);
    const st = seats.find((q) => q.id === it.id);
    if (st) { face = st.face; if (st.desk != null) inner.position.z += CHAIR_FWD; } // 椅子自動轉向它面對的桌子,並往桌子拉近
    if (inner.userData.lampAt && lamps++ < 5) {
      const l = new THREE.PointLight(0xffc27a, MOODS[mood].lamp, 4.5, 1.6); l.position.copy(inner.userData.lampAt); inner.add(l);
      lampLights.push(l);
    }
    if (inner.userData.neonAt && glows++ < 3) { const l = new THREE.PointLight(0xff6fa8, 1.6, 3.5, 1.8); l.position.copy(inner.userData.neonAt); inner.add(l); }
    if (inner.userData.glowAt && glows++ < 3) { // 最多兩台電視會照亮房間
      const l = new THREE.PointLight(0x7fc4f0, 2.5, 4.5, 1.6); l.position.copy(inner.userData.glowAt); inner.add(l);
      inner.userData.glow = l;
    }
    if (inner.userData.anim) anims.push(inner.userData.anim);
    const g = wrapItem(inner, it.type, face);
    itemPos(g, it.type, it.x, it.y);
    if (CATALOG[it.type].kind === 'top') g.position.y = surfAt(it.x, it.y);
    g.userData.itemId = it.id;
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
  if (holding) { ghost = wrapItem(buildItem(holding.type, holding.c ? { c: holding.c } : undefined), holding.type, rotOf(holding.r) * Math.PI / 2); ghost.visible = false; scene.add(ghost); }
  ghostPad.visible = false;
}


// ---------- 柔光後製(可在設定關閉,比較省電) ----------
let fxOn = store.get('yoyo_fx') !== '0', composer = null, bloom = null;
function setupFx() {
  if (composer) { composer.dispose?.(); composer = null; }
  if (!fxOn) return;
  const pr = renderer.getPixelRatio(), w = stage.clientWidth || 1, h = stage.clientHeight || 1;
  composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(w * pr, h * pr, { type: THREE.HalfFloatType, samples: 4 }));
  composer.addPass(new RenderPass(scene, camera));
  bloom = new UnrealBloomPass(new THREE.Vector2(w, h), MOODS[mood].bloomS, 0.55, MOODS[mood].bloomT);
  composer.addPass(bloom);
  composer.addPass(new OutputPass());
}

// ---------- 相機:繞著目標旋轉的透視鏡頭,可拖曳、滾輪縮放、切換視角 ----------
// 房間只有後牆(z=0)和左牆(x=0),所以鏡頭只待在房間開口這一側
// 房間是封閉的,鏡頭待在室內:目標點往外退 dist 的距離,碰到牆就停在牆內
const D2R = Math.PI / 180;
const cam = { yaw: 30 * D2R, pitch: 15 * D2R, dist: 4, target: new THREE.Vector3(4, 1, 3) };
const camGoal = { yaw: cam.yaw, pitch: cam.pitch, dist: cam.dist, target: cam.target.clone() };
let view = store.get('yoyo_view') || 'desk', autoIdx = 0, autoAt = 0, activeView = 'room';
const myPos = () => { const p = players.get(me); return p ? new THREE.Vector3(p.x, 0, p.y) : new THREE.Vector3(COLS / 2, 0, ROWS / 2); };
const VIEWS = {
  room: { yaw: 50, pitch: 20, dist: () => 20, target: () => new THREE.Vector3(COLS * 0.4, 1.0, ROWS * 0.36) },
  // 坐著時從正前方看;站著時人靠近房門那側,改從側邊看才退得夠遠
  desk: { yaw: () => (players.get(me)?.seat ? 20 : roomiestYaw(myPos().add(new THREE.Vector3(0, 1.08, 0.15)), [20, 64, -64, 110, -110, 150, -150], 8, 2.3)), pitch: 8, dist: () => 3.3, target: () => myPos().add(new THREE.Vector3(0, 1.08, 0.15)) },
  side: { yaw: 66, pitch: 12, dist: () => 3.8, target: () => myPos().add(new THREE.Vector3(-0.2, 1.0, 0)) },
};
// 從目標點往某個方向最多能退多遠(不穿牆);站著時挑退得夠遠的那一側來看角色
function roomAlong(T, yawDeg, pitchDeg) {
  const cp = Math.cos(pitchDeg * D2R), v = [Math.sin(yawDeg * D2R) * cp, Math.sin(pitchDeg * D2R), Math.cos(yawDeg * D2R) * cp];
  const m = 0.28, lims = [[T.x, v[0], m, COLS - m], [T.y, v[1], 0.25, WALLH - 0.2], [T.z, v[2], m, ROWS - m]];
  let d = 99;
  for (const [p, q, lo, hi] of lims) { if (q > 1e-4) d = Math.min(d, (hi - p) / q); else if (q < -1e-4) d = Math.min(d, (lo - p) / q); }
  return d;
}
function roomiestYaw(T, yaws, pitch, want) {
  let best = yaws[0], bd = -1;
  for (const y of yaws) { const d = roomAlong(T, y, pitch); if (d >= want) return y; if (d > bd) { bd = d; best = y; } }
  return best;
}
const AUTO = ['desk', 'room', 'side'];
function applyView(name) {
  activeView = name;
  const v = VIEWS[name];
  Object.assign(camGoal, { yaw: (typeof v.yaw === 'function' ? v.yaw() : v.yaw) * D2R, pitch: v.pitch * D2R, dist: v.dist() });
  cam.yaw = ((cam.yaw - camGoal.yaw + Math.PI) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2) - Math.PI + camGoal.yaw; // 走最短的方向轉過去
}
function setView(name) {
  view = VIEWS[name] || name === 'auto' ? name : 'desk';
  store.set('yoyo_view', view);
  document.querySelectorAll('#views button').forEach((b) => b.classList.toggle('on', b.dataset.view === view));
  autoAt = performance.now();
  applyView(view === 'auto' ? AUTO[autoIdx % AUTO.length] : view);
}
$('#views').addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (b) setView(b.dataset.view); });
const camDir = new THREE.Vector3();
let wasSeated = false;
function updateCamera(dt, t) {
  if (view === 'auto' && t - autoAt > 14000) { autoAt = t; applyView(AUTO[++autoIdx % AUTO.length]); }
  const seated = !!players.get(me)?.seat;
  if (seated !== wasSeated) { wasSeated = seated; if (activeView === 'desk') applyView('desk'); } // 坐下或站起來時鏡頭跟著換位置
  camGoal.target.copy(VIEWS[activeView].target());
  const k = 1 - Math.exp(-dt * 3.2);
  cam.yaw += (camGoal.yaw - cam.yaw) * k; cam.pitch += (camGoal.pitch - cam.pitch) * k; cam.dist += (camGoal.dist - cam.dist) * k;
  cam.target.lerp(camGoal.target, k);
  const cp = Math.cos(cam.pitch);
  camDir.set(Math.sin(cam.yaw) * cp, Math.sin(cam.pitch), Math.cos(cam.yaw) * cp);
  // 沿著視線往後退,最遠退到離牆、地板、天花板一小段距離
  const m = 0.28, T = cam.target;
  let d = cam.dist;
  const lim = (p, v, lo, hi) => { if (v > 1e-4) d = Math.min(d, (hi - p) / v); else if (v < -1e-4) d = Math.min(d, (lo - p) / v); };
  lim(T.x, camDir.x, m, COLS - m); lim(T.y, camDir.y, 0.25, WALLH - 0.2); lim(T.z, camDir.z, m, ROWS - m);
  camera.position.copy(T).addScaledVector(camDir, Math.max(0.4, d));
  camera.lookAt(T);
  camera.updateMatrixWorld();
}
function orbit(dx, dy) {
  camGoal.yaw -= dx * 0.006;
  camGoal.pitch = Math.min(70 * D2R, Math.max(-12 * D2R, camGoal.pitch + dy * 0.005));
}
function zoom(f) { camGoal.dist = Math.min(20, Math.max(1.4, camGoal.dist * f)); }
function fitCamera() {
  const w = stage.clientWidth || 1, h = stage.clientHeight || 1;
  renderer.setSize(w, h, false);
  camera.aspect = w / h; camera.fov = camera.aspect < 1 ? 68 : 50; // 直式螢幕用廣一點的視角
  camera.updateProjectionMatrix();
  if (composer) { composer.setSize(w, h); bloom.resolution.set(w, h); } else setupFx();
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
    if (seq === previewSeq) {
      const cv = $('#avatarPreview'), c2 = cv.getContext('2d');
      thumbScene.add(g);
      thumbCam.position.set(0, 0.95, 0).addScaledVector(FRONT_DIR, 20); thumbCam.lookAt(0, 0.95, 0);
      Object.assign(thumbCam, { left: -1, right: 1, top: 1, bottom: -1 }); thumbCam.updateProjectionMatrix();
      thumb.render(thumbScene, thumbCam); thumbScene.remove(g);
      c2.clearRect(0, 0, cv.width, cv.height); c2.drawImage(thumb.domElement, 0, 0, cv.width, cv.height);
    }
    disposeAvatar(g);
  });
}

// ---------- 玩家物件與標籤 ----------
function syncPlayerObj(p) {
  const key = JSON.stringify(p.avatar);
  if (p.key !== key) {
    if (p.obj) { playersGroup.remove(p.obj); disposeAvatar(p.obj); }
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
  if (p.obj) { playersGroup.remove(p.obj); disposeAvatar(p.obj); }
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
function canPlace(type, x, y, r, ignoreId) {
  const d = CATALOG[type];
  if (!d) return false;
  const [w, h] = dimsOf(type, r);
  if (x < 0 || x + w > COLS) return false;
  if (d.kind === 'wall') { if (y !== 0) return false; }
  else if (y < 0 || y + h > ROWS) return false;
  return !room.items.some((it) => {
    if (it.id === ignoreId) return false;
    const o = CATALOG[it.type];
    if (!o || o.kind !== d.kind) return false;
    const [ow, oh] = dimsOf(it.type, it.r);
    return x < it.x + ow && it.x < x + w && y < it.y + oh && it.y < y + h;
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
      const s = Math.min(d, 2.1 * dt);
      p.x += (dx / d) * s; p.y += (dy / d) * s;
    }
    const f = p.focus && (p.focus.mode === 'up' || p.focus.endAt > t) ? p.focus : null;
    const sitting = !!f && f.phase === 'focus' && p.pose !== 1 && !walking;
    const want = walking ? Math.atan2(dx, dy) : sitting && p.seat ? p.seat.face : p.id === me && activeView === 'desk' ? camGoal.yaw : 0.35; // 桌前視角下,站著時轉向鏡頭
    let diff = want - p.obj.rotation.y;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    p.obj.rotation.y += diff * Math.min(1, dt * 12);
    p.heading = p.obj.rotation.y;
    const fwd = sitting && p.seat ? SIT_FWD : 0;
    p.sit = (p.sit || 0) + (fwd - (p.sit || 0)) * Math.min(1, dt * 8);
    p.obj.position.set(p.x + Math.sin(p.obj.rotation.y) * p.sit, 0, p.y + Math.cos(p.obj.rotation.y) * p.sit);
    poseAvatar(p.obj, dt, { walking, sitting, pose: p.pose, cheering: p.cheerUntil > t, seatH: p.seat?.h, ownStool: !p.seat, t });
    p.labelY = (p.labelY || AVATAR_H) + ((sitting ? 1.42 : AVATAR_H) - (p.labelY || AVATAR_H)) * Math.min(1, dt * 6);
    // 標籤
    tmpV.set(p.x, p.labelY + 0.14, p.y).project(camera);
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
      if (d.kind === 'top') ghost.position.y = surfAt(hover.x, hover.y);
      const ok = canPlace(holding.type, hover.x, hover.y, holding.r, holding.fromId), [gw, gh] = dimsOf(holding.type, holding.r);
      ghostPad.material.color.set(ok ? '#8fe08a' : '#ff7d88');
      if (d.kind === 'wall') { ghostPad.rotation.set(0, 0, 0); ghostPad.scale.set(d.w, WALLH - 0.25, 1); ghostPad.position.set(hover.x + d.w / 2, WALLH / 2 + 0.125, 0.015); }
      else { ghostPad.rotation.set(-Math.PI / 2, 0, 0); ghostPad.scale.set(gw, gh, 1); ghostPad.position.set(hover.x + gw / 2, 0.05, hover.y + gh / 2); }
    }
  }
  if (composer) composer.render(); else renderer.render(scene, camera);
  if (photoJob && t >= photoJob.at) { const j = photoJob; photoJob = null; composePhoto(j); }
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
  if (f && f.x >= 0 && f.z >= 0 && f.x <= COLS && f.z <= ROWS) return { wall: false, x: f.x, z: f.z };
  const w = ray.ray.intersectPlane(WALL_PLANE, new THREE.Vector3());
  if (w && w.x >= 0 && w.x <= COLS && w.y >= 0 && w.y <= WALLH + 0.3) return { wall: true, x: w.x, z: 0 };
  return null;
}
function tileAt(pt) { // 拿著家具時,讓家具以游標為中心
  if (!pt || !holding) return null;
  const d = CATALOG[holding.type], [w, h] = dimsOf(holding.type, holding.r);
  if (d.kind === 'wall') return { x: Math.floor(pt.x - (w - 1) / 2), y: 0 };
  if (pt.wall) return null;
  return { x: Math.floor(pt.x - (w - 1) / 2), y: Math.floor(pt.z - (h - 1) / 2) };
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
    if (!tl || !canPlace(holding.type, tl.x, tl.y, holding.r, holding.fromId)) return toast('這裡放不下');
    if (holding.fromId) { send({ t: 'move_item', id: holding.fromId, x: tl.x, y: tl.y, r: rotOf(holding.r), c: holding.c || 0 }); setHolding(null); }
    else send({ t: 'place', type: holding.type, x: tl.x, y: tl.y, r: rotOf(holding.r), c: holding.c || 0 });
    return;
  }
  if (editing()) { // 佈置面板開著:點家具可拿起
    let o = ray.intersectObjects(itemsGroup.children, true)[0]?.object;
    while (o && o.userData.itemId == null) o = o.parent;
    const it = o && room.items.find((i) => i.id === o.userData.itemId);
    if (it) return setHolding({ type: it.type, fromId: it.id, r: rotOf(it.r), c: it.c || 0 });
  }
  const p = players.get(me);
  if (!p || !pt || pt.wall) return;
  p.tx = Math.min(COLS - 0.3, Math.max(0.3, pt.x));
  p.ty = Math.min(ROWS - 0.15, Math.max(0.2, pt.z));
  send({ t: 'move', x: p.tx, y: p.ty });
});
window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') setHolding(null);
  const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName || '');
  if ((ev.key === 'r' || ev.key === 'R') && holding && !typing) rotateHolding();
  if ((ev.key === 'c' || ev.key === 'C') && holding && !typing) tintHolding();
});
const canTint = (type) => type === 'tv2' || (!!KIT[type] && !/machine|pinball/.test(KIT[type].m));
function tintHolding() {
  if (!holding || !canTint(holding.type)) return;
  const keep = hover;
  setHolding({ ...holding, c: ((holding.c || 0) + 1) % 8 });
  hover = keep;
}
function rotateHolding() {
  if (!holding || CATALOG[holding.type].kind === 'wall') return;
  const keep = hover;
  setHolding({ ...holding, r: rotOf((holding.r || 0) + 1) });
  hover = keep;
}

// ---------- 面板(底部工具列開關右側抽屜) ----------
let currentTab = null;
const TAB_TITLES = { decor: '佈置房間', avatar: '角色', chat: '聊天', people: '房間成員', stats: '專注統計', settings: '設定' };
const editing = () => currentTab === 'decor' && canEdit();
function openTab(name) {
  currentTab = name;
  $('#drawer').hidden = !name;
  $('#drawerTitle').textContent = TAB_TITLES[name] || '';
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x.dataset.tab === name));
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x.id === 'tab-' + name));
  if (name !== 'decor') setHolding(null);
  if (name === 'avatar') renderAvatarPreview();
  if (name === 'stats') renderStats();
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
let lastSec = -1;
function tickTimer(t) {
  let f = myFocus();
  if (f && f.mode !== 'up' && f.endAt <= t - 1500) f = null; // 等伺服器送下一階段
  const text = f ? focusClock(f, t) : fmt(idleMs());
  if ($('#timerText').textContent !== text) {
    $('#timerText').textContent = text;
    document.title = f ? `${text} ${f.phase === 'break' ? '休息中' : '專注中'} — 悠悠自習室` : '悠悠自習室';
    if (f && currentTab === 'people') refreshMembers();
  }
  const sec = Math.floor(t / 1000);
  if (party && sec !== lastSec) { lastSec = sec; refreshParty(); }
}
function refreshTimer() {
  const f = myFocus();
  if (!!f !== document.body.classList.contains('focusing')) setMin($('#timerCard'), !!f); // 開始專注時自動收小,結束時展開
  document.body.classList.toggle('focusing', !!f);
  const lab = $('#timerLabel');
  lab.classList.toggle('break', f?.phase === 'break');
  lab.textContent = !f ? '準備好就開始吧'
    : f.phase === 'break' ? `休息一下 · 第 ${f.round} 輪結束`
    : f.mode === 'party' ? `共同專注中${party ? ` · ${party.count} 人` : ''}`
    : f.mode === 'pomo' ? `專注中 · 第 ${f.round} 輪` : '專注中';
  $('#focusBtn').textContent = f ? '結束' : '開始專注';
  $('#focusBtn').className = f ? 'danger' : 'primary';
  if (f && f.mode !== 'party') setMode(f.mode, true);
  refreshParty();
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

// ---------- 小卡片收合:專注時只留時間,房間才是主角 ----------
function setMin(card, on, remember) {
  card.classList.toggle('min', on);
  card.querySelector('.cardTog')?.setAttribute('aria-expanded', String(!on));
  if (remember) store.set('yoyo_min_' + card.id, on ? '1' : '0');
}
for (const card of document.querySelectorAll('.card')) {
  const saved = store.get('yoyo_min_' + card.id);
  setMin(card, saved ? saved === '1' : card.id !== 'timerCard' || innerWidth < 860); // 待辦和環境音預設收起來;手機上計時器也先收小
  card.querySelector('.cardTog').addEventListener('click', () => setMin(card, !card.classList.contains('min'), true));
}
// 左下角的日期與時間
function tickClock() {
  const d = new Date();
  $('#clockDate').textContent = `${d.getMonth() + 1} 月 ${d.getDate()} 日 週${WEEKDAYS[d.getDay()]}`;
  $('#clockTime').textContent = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
setInterval(tickClock, 5000);

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
  $('#todoCount').textContent = left ? left : '';
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
$('#listTabs').addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  document.querySelectorAll('#listTabs button').forEach((x) => x.classList.toggle('on', x === b));
  $('#todoBody').hidden = b.dataset.list !== 'todo';
  $('#habitBody').hidden = b.dataset.list !== 'habit';
});

// ---------- 日期工具(一律用玩家當地日期) ----------
const pad2 = (n) => String(n).padStart(2, '0');
const dayStr = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const dayAgo = (n) => { const d = new Date(); d.setHours(12, 0, 0, 0); d.setDate(d.getDate() - n); return d; };
const WEEKDAYS = ['日', '一', '二', '三', '四', '五', '六'];
// 連續天數:從今天往回數;今天還沒達成時從昨天算起,不會因為今天還沒做就歸零
function streakOf(has) {
  let n = 0, i = has(dayStr(dayAgo(0))) ? 0 : 1;
  while (has(dayStr(dayAgo(i)))) { n++; i++; }
  return n;
}

// ---------- 每日習慣 ----------
let habits = [];
function renderHabits() {
  const today = dayStr(dayAgo(0));
  $('#habitList').replaceChildren(...habits.map((h, i) => {
    const set = new Set(h.days);
    const cb = el('input', { type: 'checkbox', checked: set.has(today), ariaLabel: `今天完成 ${h.name}` });
    cb.onchange = () => {
      if (cb.checked) set.add(today); else set.delete(today);
      h.days = [...set].sort(); saveHabits();
    };
    const del = el('button', { type: 'button', textContent: '✕', ariaLabel: '刪除' });
    del.onclick = () => { if (confirm(`刪除習慣「${h.name}」和它的打卡紀錄?`)) { habits.splice(i, 1); saveHabits(); } };
    const dots = [6, 5, 4, 3, 2, 1, 0].map((n) => {
      const d = dayAgo(n);
      return el('i', { className: set.has(dayStr(d)) ? 'on' : '', title: `${d.getMonth() + 1}/${d.getDate()}(${WEEKDAYS[d.getDay()]})${set.has(dayStr(d)) ? ' 已完成' : ''}` });
    });
    const st = streakOf((k) => set.has(k));
    return el('li', {},
      el('div', { className: 'top' }, cb, el('span', { textContent: h.name }), del),
      el('div', { className: 'week' }, ...dots, el('em', { textContent: st ? `連續 ${st} 天` : '近 7 天' })));
  }));
  const left = habits.filter((h) => !h.days.includes(today)).length;
  $('#habitCount').textContent = left ? left : '';
}
function saveHabits() { renderHabits(); send({ t: 'habits', list: habits }); }
$('#habitForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const v = $('#habitInput').value.trim();
  if (!v) return;
  if (habits.length >= 8) return toast('習慣最多 8 個');
  habits.push({ name: v.slice(0, 20), days: [] });
  $('#habitInput').value = '';
  saveHabits();
});

// ---------- 專注統計 ----------
let chartDays = 7;
function renderStats() {
  if (!profile) return;
  const days = profile.days || {}, get = (n) => days[dayStr(dayAgo(n))] || 0;
  const dow = (new Date().getDay() + 6) % 7; // 週一為一週的開始
  let week = 0;
  for (let i = 0; i <= dow; i++) week += get(i);
  const tile = (v, unit, label) => el('div', {}, el('b', {}, String(v), el('small', { textContent: unit })), el('span', { textContent: label }));
  $('#statTiles').replaceChildren(
    tile(get(0), '分', '今天'), tile(week, '分', '本週(週一起)'),
    tile(streakOf((k) => days[k] > 0), '天', '連續專注'), tile(profile.totalMinutes, '分', `累計 · 完成 ${profile.sessions} 次`));

  const rows = [];
  for (let n = chartDays - 1; n >= 0; n--) { const d = dayAgo(n); rows.push({ d, n, v: get(n) }); }
  const max = Math.max(...rows.map((r) => r.v)), top = Math.max(10, Math.ceil(max / 10) * 10);
  const chart = $('#chart');
  const tip = el('div', { className: 'tip', hidden: true });
  const label = (r) => `${r.d.getMonth() + 1}/${r.d.getDate()}(${WEEKDAYS[r.d.getDay()]})`;
  chart.replaceChildren(el('div', { className: 'max' }, el('span', { textContent: `${top} 分` })), ...rows.map((r) => {
    const col = el('div', { className: 'col', tabIndex: 0, ariaLabel: `${label(r)} ${r.v} 分鐘` });
    // 數值標籤只在 7 天檢視顯示;30 天檢視只標最高的一天,其餘看提示或表格
    const bar = el('div', { className: 'bar' }); bar.style.height = `${(r.v / top) * 100}%`;
    if (r.v && (chartDays === 7 || r.v === max)) bar.append(el('div', { className: 'val', textContent: r.v }));
    col.append(bar);
    if (chartDays === 7 || r.n % 7 === 0) col.append(el('div', { className: 'x' + (r.n === 0 ? ' today' : ''), textContent: chartDays === 7 ? (r.n === 0 ? '今天' : WEEKDAYS[r.d.getDay()]) : (r.n === 0 ? '今天' : `${r.d.getMonth() + 1}/${r.d.getDate()}`) }));
    const show = () => {
      tip.replaceChildren(el('b', { textContent: `${r.v} 分鐘` }), label(r));
      tip.hidden = false;
      tip.style.left = `${Math.min(chart.clientWidth - 60, Math.max(60, col.offsetLeft + col.offsetWidth / 2))}px`;
      tip.style.top = `${Math.max(14, bar.offsetTop - 6)}px`;
    };
    col.addEventListener('pointerenter', show); col.addEventListener('focus', show);
    col.addEventListener('pointerleave', () => { tip.hidden = true; }); col.addEventListener('blur', () => { tip.hidden = true; });
    return col;
  }), tip);
  chart.ariaLabel = `近 ${chartDays} 天每日專注分鐘,共 ${rows.reduce((a, r) => a + r.v, 0)} 分鐘`;
  $('#chartTable tbody').replaceChildren(...rows.slice().reverse().map((r) => el('tr', {}, el('td', { textContent: label(r) }), el('td', { textContent: r.v }))));
}
$('#chartRange').addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  chartDays = +b.dataset.days;
  document.querySelectorAll('#chartRange button').forEach((x) => x.classList.toggle('on', x === b));
  renderStats();
});

// ---------- 共同專注(房主發起,大家同時開始、同時結束) ----------
let party = null;
function setParty(pt) {
  const now = performance.now();
  party = pt ? { ...pt, startAt: now + pt.startIn, endAt: now + pt.left } : null;
  refreshTimer();
}
function refreshParty() {
  const f = myFocus(), now = performance.now(), bar = $('#partyBar'), act = $('#partyAct');
  $('#partyBtn').hidden = !(room?.mine && !f && !party);
  const mineParty = f?.mode === 'party';
  bar.hidden = !party || mineParty;
  if (!party || mineParty) return;
  const host = party.by === me;
  if (!party.started) {
    const sec = Math.max(0, Math.ceil((party.startAt - now) / 1000));
    $('#partyText').textContent = `${host ? '你' : party.byName} 發起共同專注 ${party.minutes} 分鐘 · ${sec} 秒後開始 · 已加入 ${party.count} 人`;
    act.textContent = host ? '取消' : party.joined ? '退出' : '加入';
    act.className = party.joined ? '' : 'primary';
    act.onclick = () => send({ t: party.joined ? 'party_leave' : 'party_join' });
  } else {
    $('#partyText').textContent = `共同專注進行中 · ${party.count} 人 · 剩 ${fmt(party.endAt - now)}`;
    act.textContent = '中途加入'; act.className = 'primary';
    act.onclick = () => send({ t: 'party_join' });
  }
}
$('#partyBtn').addEventListener('click', () => {
  const minutes = timerMode === 'pomo' ? num('#pomoFocus', 1, 180, 25) : timerMode === 'down' ? selectedMin : 25;
  send({ t: 'party_start', minutes });
});

// 合照:切到全景、等大家歡呼,再把畫面連同名字合成一張圖
let photoJob = null;
function takeGroupPhoto(m) {
  chime();
  applyView('room');
  photoJob = { at: performance.now() + 2600, minutes: m.minutes, ids: m.done.map((d) => d.id) };
}
function composePhoto(job) {
  try {
    const W = canvas.width, H = canvas.height, k = W / (stage.clientWidth || W);
    const cv = el('canvas', { width: W, height: H }), c = cv.getContext('2d');
    const g = c.createLinearGradient(0, 0, W * 0.18, H);
    g.addColorStop(0, '#171a33'); g.addColorStop(0.48, '#2c2548'); g.addColorStop(1, '#5b3f5e');
    c.fillStyle = g; c.fillRect(0, 0, W, H);
    c.drawImage(canvas, 0, 0);
    c.textAlign = 'center'; c.textBaseline = 'middle'; c.font = `${13 * k}px system-ui, "PingFang TC", "Noto Sans TC", sans-serif`;
    for (const id of job.ids) {
      const p = players.get(id);
      if (!p) continue;
      tmpV.set(p.x, AVATAR_H + 0.22, p.y).project(camera);
      const x = ((tmpV.x + 1) / 2) * W, y = ((1 - tmpV.y) / 2) * H, w = c.measureText(p.name).width + 20 * k, h = 22 * k;
      c.fillStyle = 'rgba(23,26,51,.72)'; c.beginPath(); c.roundRect(x - w / 2, y - h / 2, w, h, h / 2); c.fill();
      c.fillStyle = '#fff'; c.fillText(p.name, x, y + k);
    }
    const d = new Date();
    c.textAlign = 'left'; c.font = `700 ${22 * k}px system-ui, "PingFang TC", "Noto Sans TC", sans-serif`;
    c.fillStyle = '#ffc98a'; c.fillText('☾ 悠悠自習室', 24 * k, H - 56 * k);
    c.font = `${16 * k}px system-ui, "PingFang TC", "Noto Sans TC", sans-serif`; c.fillStyle = '#f6efe6';
    c.fillText(`${job.ids.length} 人共同專注 ${job.minutes} 分鐘 · ${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`, 24 * k, H - 26 * k);
    const url = cv.toDataURL('image/jpeg', 0.9);
    $('#photoImg').src = url; $('#photoSave').href = url;
    $('#photo').hidden = false;
  } catch (e) { console.error(e); }
  setView(view); // 鏡頭回到原本的視角
}
$('#photoClose').addEventListener('click', () => { $('#photo').hidden = true; });

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
    $('#editHint').textContent = h.fromId ? `移動「${CATALOG[h.type].name}」:點選新的位置` : `放置「${CATALOG[h.type].name}」:點選位置`;
    $('#editRemove').hidden = !h.fromId;
    $('#editRotate').hidden = CATALOG[h.type].kind === 'wall';
    $('#editTint').hidden = !canTint(h.type);
  }
  document.querySelectorAll('.item').forEach((x) => x.classList.toggle('on', !!h && !h.fromId && x.dataset.type === h.type));
}
$('#editCancel').addEventListener('click', () => setHolding(null));
$('#editRotate').addEventListener('click', rotateHolding);
$('#editTint').addEventListener('click', tintHolding);
$('#editRemove').addEventListener('click', () => { if (holding?.fromId) send({ t: 'remove_item', id: holding.fromId }); setHolding(null); });

const GROUPS = [['desk', '桌椅'], ['store', '收納'], ['rest', '床與沙發'], ['elec', '電器'], ['deco', '植物燈飾'], ['top', '桌上小物'], ['wall', '牆面'], ['rug', '地毯']];
let catGroup = 'desk';
function showGroup(gk) {
  catGroup = gk;
  document.querySelectorAll('#catTabs button').forEach((b) => b.classList.toggle('on', b.dataset.g === gk));
  document.querySelectorAll('#catalog .item').forEach((c) => { c.hidden = c.dataset.g !== gk; });
}
function buildCatalog() {
  $('#catTabs').replaceChildren(...GROUPS.map(([gk, name]) => { const b = el('button', { type: 'button', textContent: name }); b.dataset.g = gk; b.onclick = () => showGroup(gk); return b; }));
  $('#catalog').replaceChildren(...Object.entries(CATALOG).map(([type, d]) => {
    const cv = el('canvas', { width: 160, height: 160 });
    snapshot(buildItem(type), cv, d.kind === 'wall' ? FRONT_DIR : VIEW_DIR);
    const card = el('div', { className: 'item' }, cv, el('span', { textContent: d.name }));
    card.dataset.type = type; card.dataset.g = d.g || 'deco';
    card.addEventListener('click', () => {
      if (!canEdit()) return;
      setHolding(holding && !holding.fromId && holding.type === type ? null : { type });
    });
    return card;
  }));
  showGroup(catGroup);
}
function buildPresets(list) {
  $('#presets2').replaceChildren(...list.map((p) => {
    const b = el('button', { type: 'button', textContent: p.name });
    b.onclick = () => { if (confirm(`換成成品房間「${p.name}」?目前房間裡的擺設會被取代。`)) { setHolding(null); send({ t: 'preset', key: p.key }); } };
    return b;
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
    ? '選一件家具後點房間放置;點房間裡的家具可以移動、旋轉、換色或收回。「桌上小物」可以放在桌面和矮櫃上。'
    : '這是朋友的房間,主人沒有開放佈置。回到自己的房間就能自由佈置。';
  swatches($('#wallSwatches'), WALLS, 'wall');
  swatches($('#floorSwatches'), FLOORS, 'floor');
  $('#guestsEditRow').hidden = !room.mine;
  $('#presetRow').hidden = !room.mine;
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
    habits = (p.habits || []).map((x) => ({ name: x.name, days: [...x.days] })); renderHabits();
    $('#statusInput').value = p.status || '';
    setPose(p.pose || 0);
  }
  if (currentTab === 'stats') renderStats();
  refreshTimer();
}
function pushProfile() {
  clearTimeout(profileTimer);
  profileTimer = setTimeout(() => send({ t: 'profile', name: draft.name, avatar: draft.avatar }), 350);
}
function buildAvatarOptions() {
  const rows = [
    ['膚色', 'skin', SKIN.map((c, i) => (i ? { color: c } : { text: '原色' }))],
    ['造型', 'hair', LOOK_NAMES.map((n) => ({ text: n }))],
    ['髮色', 'hairColor', HAIRC.map((c) => (c ? { color: c } : { text: '原色' }))],
    ['上衣', 'shirt', SHIRT.map((c) => (c ? { color: c } : { text: '原色' }))],
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

// ---------- 設定:光線、存檔、房間 ----------
function refreshMoodUI() { document.querySelectorAll('#moods button').forEach((x) => x.classList.toggle('on', x.dataset.mood === moodPref)); }
$('#moods').addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  moodPref = b.dataset.mood; store.set('yoyo_mood', moodPref);
  refreshMoodUI();
  if (applyMood()) rebuildRoom();
});
refreshMoodUI();
$('#fxToggle').checked = fxOn;
$('#fxToggle').addEventListener('change', (ev) => { fxOn = ev.target.checked; store.set('yoyo_fx', fxOn ? '1' : '0'); setupFx(); });

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
// ---------- 音樂播放器:HoliznaCC0 的 lo-fi 曲目(CC0),每個人各自播放 ----------
const TRACKS = [
  ['first-snow', 'First Snow', 'Winter Lofi', 174], ['snow-drift', 'Snow Drift', 'Winter Lofi', 174], ['fire-place', 'Fire Place', 'Winter Lofi', 170],
  ['tokyo-sunset', 'Tokyo Sunset', 'Public Domain Lofi', 139], ['calm-currents', 'Calm Currents', 'Public Domain Lofi', 148], ['still-life', 'Still Life', 'Public Domain Lofi', 135],
  ['peaceful-drift', 'Peaceful Drift', 'Public Domain Lofi', 128], ['ease-into-night', 'Ease into Night', 'Public Domain Lofi', 152],
  ['roof-tops', 'Roof Tops', 'Summer Air', 214], ['faded-in-the-sunlight', 'Faded in the Sunlight', 'Summer Air', 178],
].map(([f, t, al, sec]) => ({ f, t, al, sec }));
const audio = new Audio();
audio.preload = 'none';
let trackIdx = Math.min(TRACKS.length - 1, Math.max(0, +store.get('yoyo_track') || 0)), shuffle = store.get('yoyo_shuffle') === '1', seeking = false, loaded = -1;
audio.volume = Math.min(1, Math.max(0, (+(store.get('yoyo_mvol') ?? 60)) / 100));
$('#mVol').value = Math.round(audio.volume * 100);
function refreshPlayer() {
  const tr = TRACKS[trackIdx], on = !audio.paused;
  $('#npTitle').textContent = loaded < 0 ? '選一首開始播放' : tr.t;
  $('#npSub').textContent = loaded < 0 ? `lo-fi 音樂 · ${TRACKS.length} 首` : `HoliznaCC0 · ${tr.al}`;
  $('#musicNow').textContent = on ? `♪ ${tr.t}` : '';
  $('#musicCard').classList.toggle('playing', on); // 收起來時,膠囊上顯示正在播的歌
  $('#mPlayIcon').setAttribute('d', on ? 'M6 4h4v16H6zM14 4h4v16h-4z' : 'M7 4l13 8-13 8z');
  $('#mPlay').ariaLabel = on ? '暫停' : '播放';
  $('#mShuffle').setAttribute('aria-pressed', String(shuffle));
  document.querySelectorAll('#trackList li').forEach((li, i) => li.classList.toggle('on', loaded >= 0 && i === trackIdx));
}
function playTrack(i) {
  trackIdx = ((i % TRACKS.length) + TRACKS.length) % TRACKS.length;
  store.set('yoyo_track', trackIdx);
  if (loaded !== trackIdx) { audio.src = `/assets/music/${TRACKS[trackIdx].f}.mp3`; loaded = trackIdx; $('#mSeek').value = 0; }
  audio.play().catch(() => toast('這首歌暫時無法播放,請再按一次播放'));
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: TRACKS[trackIdx].t, artist: 'HoliznaCC0', album: TRACKS[trackIdx].al });
  refreshPlayer();
}
const nextTrack = () => playTrack(shuffle && TRACKS.length > 1 ? (trackIdx + 1 + Math.floor(Math.random() * (TRACKS.length - 1))) % TRACKS.length : trackIdx + 1);
const prevTrack = () => (audio.currentTime > 4 ? ((audio.currentTime = 0), audio.play()) : playTrack(trackIdx - 1));
const togglePlay = () => (loaded < 0 || audio.paused ? playTrack(trackIdx) : audio.pause());
$('#trackList').replaceChildren(...TRACKS.map((tr, i) => {
  const li = el('li', { tabIndex: 0, role: 'button' }, el('span', { textContent: tr.t }), el('span', { textContent: mmss(tr.sec) }));
  li.onclick = () => playTrack(i);
  li.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); playTrack(i); } };
  return li;
}));
$('#mPlay').addEventListener('click', togglePlay);
$('#mNext').addEventListener('click', nextTrack);
$('#mPrev').addEventListener('click', prevTrack);
$('#mShuffle').addEventListener('click', () => { shuffle = !shuffle; store.set('yoyo_shuffle', shuffle ? '1' : '0'); refreshPlayer(); });
$('#mVol').addEventListener('input', (ev) => { audio.volume = ev.target.value / 100; store.set('yoyo_mvol', ev.target.value); });
$('#mSeek').addEventListener('input', () => { seeking = true; });
$('#mSeek').addEventListener('change', (ev) => { if (audio.duration) audio.currentTime = (ev.target.value / 1000) * audio.duration; seeking = false; });
audio.addEventListener('timeupdate', () => { if (!seeking && audio.duration) $('#mSeek').value = Math.round((audio.currentTime / audio.duration) * 1000); });
audio.addEventListener('ended', nextTrack);
for (const ev of ['play', 'pause']) audio.addEventListener(ev, refreshPlayer);
audio.addEventListener('error', () => { if (loaded >= 0) toast('音樂載入失敗,請檢查網路'); });
if ('mediaSession' in navigator) {
  navigator.mediaSession.setActionHandler('play', togglePlay); navigator.mediaSession.setActionHandler('pause', togglePlay);
  navigator.mediaSession.setActionHandler('nexttrack', nextTrack); navigator.mediaSession.setActionHandler('previoustrack', prevTrack);
}
refreshPlayer();

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
tickClock();
requestAnimationFrame(frame);
})();
