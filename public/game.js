/* 悠悠自習室 — 前端(three.js 等角 3D 房間) */
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { VRMLoaderPlugin, VRMUtils } from '@pixiv/three-vrm';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
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
const LOOK_NAMES = ['女生 A', '男生 A', '女生 B', '男生 B', '女生 C', '女生 D', '積木男 A', '積木女 A', '積木男 B', '積木女 B', '積木男 C', '積木光頭'];
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

// 切到別的分頁工作時,用系統通知提醒時間到了(第一次開始專注時會詢問是否允許)
function notify(text) {
  try { if (document.hidden && 'Notification' in window && Notification.permission === 'granted') new Notification('悠悠自習室', { body: text, tag: 'yoyo-focus' }); } catch {}
}
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
    netReady = false;
    if (kicked) return;
    $('#overlay').hidden = false;
    $('#overlayText').textContent = '連線中斷,重新連線中…';
    setTimeout(connect, 2000);
  };
}

// ---------- 本機備份:伺服器的資料不見時(例如免費主機重啟)自動還原 ----------
// 進度一有變動就在這個瀏覽器存一份;連上線發現伺服器不認得這個存檔碼時,把備份送回去。
let restoring = false, backupTimer = 0;
function loadBackup() {
  try { const b = JSON.parse(store.get('yoyo_backup')); return b && b.tk === token && b.data ? b : null; } catch { return null; }
}
function saveBackup() {
  clearTimeout(backupTimer);
  backupTimer = setTimeout(() => {
    if (restoring || !profile || !room) return;
    const data = {
      name: profile.name, avatar: profile.avatar, totalMinutes: profile.totalMinutes, sessions: profile.sessions, days: profile.days,
      status: $('#statusInput').value, pose: players.get(me)?.pose || 0, todos, habits,
      // 在朋友的房間時,沿用上次存的自己房間
      room: room.mine ? { code: room.code, wall: room.wall, floor: room.floor, guestsEdit: room.guestsEdit, items: room.items } : loadBackup()?.data.room,
    };
    store.set('yoyo_backup', JSON.stringify({ tk: token, at: Date.now(), data }));
  }, 800);
}
// 載入畫面:連上線、家具模型也都載完才收起來,過程中顯示進度
let netReady = false, loadedN = 0;
function refreshOverlay() {
  if (kicked) return;
  const done = netReady && modelsLoaded;
  $('#overlay').hidden = done;
  if (restoring) { $('#overlay').hidden = false; $('#overlayText').textContent = '正在還原你的進度…'; return; }
  if (!done) $('#overlayText').textContent = netReady ? `正在佈置房間… ${Math.round((loadedN / SFILES.length) * 100)}%` : '連線中…';
}
function addPlayer(p) {
  const old = players.get(p.id);
  const o = old || { x: p.x, y: p.y };
  const now = performance.now();
  Object.assign(o, { id: p.id, name: p.name, avatar: p.avatar, tx: p.x, ty: p.y, totalMinutes: p.totalMinutes, status: p.status, pose: p.pose });
  // 伺服器給的是「還剩多久 / 已經過多久」,換算成本機時間軸
  if (p.focus?.phase === 'break' && o.focus?.phase === 'focus') o.stretchPending = true; // 剛進入休息:離開座位站定之後伸個懶腰
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
    const backup = m.fresh && loadBackup();
    if (backup) { restoring = true; send({ t: 'restore', data: backup.data }); } // 伺服器不認得我們:把備份送回去,還原後重新載入
    netReady = true; refreshOverlay();
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
    saveBackup();
    if (!backup && !store.get('yoyo_tips')) $('#tips').hidden = false; // 第一次來:顯示操作提示
  },
  restored() { location.href = room?.mine ? location.pathname : location.href; },
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
  emote(m) {
    const p = players.get(m.id);
    if (!p) return;
    showEmote(p, m.e);
    p.happyUntil = performance.now() + 1800; // 發表情時角色會笑一下;👋 會揮手
    if (m.e === '👋') p.waveUntil = performance.now() + 1800;
  },
  room(m) {
    Object.assign(room, m.room);
    if (holding?.fromId && !room.items.some((i) => i.id === holding.fromId)) setHolding(null);
    if (!canEdit()) setHolding(null);
    rebuildRoom();
    refreshRoomUI();
    saveBackup();
  },
  profile(m) { setProfile(m.profile); saveBackup(); },
  party(m) { setParty(m.party); },
  party_done(m) {
    const now = performance.now();
    for (const d of m.done) { const p = players.get(d.id); if (p) p.cheerUntil = now + 7000; }
    if (!m.done.length) return;
    sysLog(`共同專注 ${m.minutes} 分鐘完成:${m.done.map((d) => d.name).join('、')}`);
    if (m.done.some((d) => d.id === me)) takeGroupPhoto(m); else toast(`${m.done.length} 人完成了共同專注 ${m.minutes} 分鐘`);
  },
  focus_done(m) {
    const msg = m.stopped ? (m.minutes ? `已記錄 ${m.minutes} 分鐘專注` : '')
      : m.party ? `共同專注 ${m.minutes} 分鐘完成!`
      : m.phase === 'break' ? (m.next ? '休息結束,開始下一輪專注' : '休息結束')
      : m.next === 'break' ? `專注 ${m.minutes} 分鐘完成!休息 ${m.breakMin} 分鐘` : `專注 ${m.minutes} 分鐘完成!`;
    if (msg) toast(msg);
    if (!m.stopped) { chime(); notify(msg); }
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
renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1)); // 實際的解析度由畫質等級決定(見 applyQuality)
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
    sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03; sun.shadow.radius = 1.6; // 半徑太大陰影會出現顆粒
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
  // lamp 燈具、glow 螢幕、neon 霓虹燈、beam 從窗戶照進來的光(顏色與強度)、wallE/floorE/ceilE 牆面、地板、天花板的自發光
  day:   { sky: 0xffeedd, ground: 0x8f7fc0, hemi: 0.9,  sun: 0xffdcb4, sunI: 2.2,  lamp: 0.3,  room: 0,   exp: 1.04, bloomT: 1.5,  bloomS: 0.1,
           glow: 0.06, neon: 1.0, beam: [0xfff0d0, 2.5], wallE: 0.22, floorE: 0.1,  ceilE: 0.25, vig: 0.12, pend: '#efe7d6' },
  dusk:  { sky: 0xffd2b4, ground: 0x7a659e, hemi: 0.78, sun: 0xff9a62, sunI: 1.5,  lamp: 0.7,  room: 3,   exp: 1.05, bloomT: 1.3,  bloomS: 0.16,
           glow: 0.16, neon: 1.6, beam: [0xffb07a, 5],   wallE: 0.16, floorE: 0.08, ceilE: 0.16, vig: 0.25, pend: '#fff0c4' },
  // 夜晚:大燈關掉,環境光壓暗偏藍,靠檯燈、螢幕、霓虹燈和月光照明
  night: { sky: 0x7486d8, ground: 0x1e1c3c, hemi: 0.36, sun: 0x8fa4ff, sunI: 0.22, lamp: 1.5,  room: 0.5, exp: 1.0,  bloomT: 1.1,  bloomS: 0.26,
           glow: 0.26, neon: 1.5, beam: [0x9fb6ff, 9],   wallE: 0.05, floorE: 0.03, ceilE: 0.03, vig: 0.6, pend: '#5c607f' },
};
let moodPref = store.get('yoyo_mood') || 'auto', mood = 'day';
const autoMood = () => { const h = new Date().getHours() + new Date().getMinutes() / 60; return h < 6 || h >= 19 ? 'night' : h >= 17 || h < 7.5 ? 'dusk' : 'day'; };
let lampLights = [], glowLights = [], neonLights = [], beamLights = [], ceilMesh = null, pendantMat = null;
// 每盞燈的亮度:燈越多,每盞越暗,整間房才不會被照得像白天
const lampLevel = () => MOODS[mood].lamp / Math.max(1, lampLights.length * 0.62);
function applyMood() {
  const next = MOODS[moodPref] ? moodPref : autoMood(), changed = next !== mood;
  mood = next;
  const m = MOODS[mood];
  LIGHTS.hemi.color.set(m.sky); LIGHTS.hemi.groundColor.set(m.ground); LIGHTS.hemi.intensity = m.hemi;
  LIGHTS.sun.color.set(m.sun); LIGHTS.sun.intensity = m.sunI;
  LIGHTS.roomLight.intensity = m.room;
  renderer.toneMappingExposure = m.exp;
  if (bloom) { bloom.threshold = m.bloomT; bloom.strength = m.bloomS; }
  for (const l of lampLights) l.intensity = lampLevel() * l.userData.k;
  for (const l of glowLights) l.intensity = m.glow;
  for (const l of neonLights) l.intensity = m.neon;
  for (const l of beamLights) { l.color.set(m.beam[0]); l.intensity = m.beam[1]; }
  for (const w of wallPlanes) w.material.emissiveIntensity = m.wallE;
  if (floorMesh) floorMesh.material.emissiveIntensity = m.floorE;
  if (ceilMesh) ceilMesh.material.emissiveIntensity = m.ceilE;
  pendantMat?.color.set(m.pend);
  document.documentElement.style.setProperty('--vig', m.vig);
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

const WOOD = '#d7a26c', WOOD_D = '#b98352', WOOD_DD = '#9a6a40', CREAM = '#fbf6ec', INK = '#56506e';
const BOOKS = ['#ee8a8f', '#ffc98a', '#7cc3d6', '#9ed59a', '#c09ae0', '#fbf6ec', '#8c9cea'];

// ---------- 家具:全部是本專案用 Blender 做的原創模型(tools/blender/furniture.py),卡通打光 + 描邊 ----------
// 模型原點在佔地中心、底部貼地,正面朝 +z(房間這一側);牆面掛飾的背面在 z = 0。
// 規格:m 模型檔名、back 靠佔地後緣(適合靠牆)、seat 座面高度、pull 坐下時椅子往桌子拉近多少、
//       surf 檯面高度(可放小物)、lamp 燈光位置(數字 = 高度)、glow 螢幕的光
const ITEMS = {
  kdesk: { m: 'desk', surf: 0.74 }, dining: { m: 'table', surf: 0.74 }, coffee: { m: 'coffee', surf: 0.4 }, side: { m: 'side', surf: 0.52, back: 1 },
  kchair: { m: 'chair', seat: 0.5, pull: 0.27 }, cchair: { m: 'dchair', seat: 0.49, pull: 0.2 }, stool: { m: 'stool', seat: 0.46, pull: 0.2 },
  kcase: { m: 'bookcase', back: 1 }, doorcase: { m: 'cabinet', back: 1 }, widecase: { m: 'sideboard', back: 1, surf: 0.95 }, lowcase: { m: 'lowcase', back: 1, surf: 0.75 },
  rack: { m: 'rack' }, box: { m: 'box' },
  bed: { m: 'bed', surf: 0.53 }, dbed: { m: 'bed_double', surf: 0.53 }, ksofa: { m: 'sofa', back: 1 }, lchair: { m: 'armchair', seat: 0.42 }, ottoman: { m: 'ottoman', seat: 0.4 },
  tv2: { m: 'tv', back: 1, glow: [1, 0.9, 1.0] }, fridge: { m: 'fridge', back: 1 }, spk: { m: 'speaker' }, arcade: { m: 'arcade', glow: [0.5, 1.2, 1.0] }, vending: { m: 'vending', back: 1 },
  flamp: { m: 'floorlamp', lamp: 1.75 }, bigplant: { m: 'plant_big' }, plant: { m: 'plant' }, bin: { m: 'bin' }, cat: { m: 'cat' },
  monitor: { m: 'monitor', glow: [0.5, 0.55, 1.0] }, tlaptop: { m: 'laptop', glow: [0.5, 0.5, 0.95] }, tlamp: { m: 'lamp', lamp: 0.62 }, tbooks: { m: 'books' }, tplant: { m: 'plant_small' }, tplant2: { m: 'succulent' },
  radio: { m: 'radio' }, brew: { m: 'teaset' },
  window: { m: 'window' }, painting: { m: 'frame' }, poster: { m: 'poster' }, clock: { m: 'clock' }, shelf: { m: 'wallshelf' }, wlamp: { m: 'walllamp', lamp: 1.95 }, mirror: { m: 'mirror' },
};
// 角色配件:掛在頭部骨架上。top = 以頭頂(含頭髮)為基準往上放
// 頭飾:fit = 模型原本的頭帶高度,會依角色的頭髮高度等比例放大,耳機才套得在頭髮外面;top = 以頭頂(含頭髮)為基準
const ACCS = [null, { m: 'acc_headphones', name: '耳機', fit: 0.183 }, { m: 'acc_catears', name: '貓耳', top: -0.07, scale: 1.4 }, { m: 'acc_beret', name: '貝雷帽', top: -0.032, scale: 1.08 }];
const GLASSES = { m: 'acc_glasses' };
const SFILES = [...new Set(Object.values(ITEMS).map((k) => k.m)), 'door', 'cat_walk', 'pendant', ...ACCS.filter(Boolean).map((k) => k.m), GLASSES.m];
const MODEL = {}, SBB = {}, STINT = {}; // 模型、外框、可否換色
let modelsLoaded = false;
// 換色:有布料的家具換布料顏色,其餘換木頭顏色(0 = 原色)
const FABRICS = [null, '#e7a3b4', '#f0c987', '#9fc7a3', '#8fb8d8', '#a9a0dc', '#f3ede2', '#5b5870'];
const WOODS = [null, '#f1e2c8', '#b88758', '#7a5236', '#f4f1ea', '#4a4652', '#e7b7b0', '#a9c9b4'];

// 遊戲端畫的圖:螢幕畫面、窗外風景、掛畫、海報
const screenTex = () => canvasTex('pcscreen', 256, 144, (c, w, h) => {
  const gr = c.createLinearGradient(0, 0, w, h); gr.addColorStop(0, '#2c3a78'); gr.addColorStop(1, '#7a4f9a'); c.fillStyle = gr; c.fillRect(0, 0, w, h);
  c.fillStyle = 'rgba(255,255,255,.92)'; c.fillRect(18, 16, 132, 96); c.fillStyle = '#8c9cea'; c.fillRect(18, 16, 132, 12);
  c.fillStyle = '#c9cfe8'; for (let i = 0; i < 6; i++) c.fillRect(28, 38 + i * 11, 60 + ((i * 37) % 50), 5);
  c.fillStyle = 'rgba(255,255,255,.85)'; c.fillRect(162, 30, 78, 60); c.fillStyle = '#ffc98a'; c.beginPath(); c.arc(201, 60, 18, 0, 7); c.fill();
});
let raining = false; // 開著雨聲時,窗外也下雨
const skyTex = (mode) => canvasTex('sky' + mode + (raining ? 'rain' : ''), 384, 256, (c, w, h) => {
  const gr = c.createLinearGradient(0, 0, 0, h);
  const cols = { night: ['#1b2452', '#4a5596'], dusk: ['#6a7cc8', '#ffbe95'], day: ['#8fd0f5', '#e3f5fd'] }[mode];
  gr.addColorStop(0, cols[0]); gr.addColorStop(1, cols[1]); c.fillStyle = gr; c.fillRect(0, 0, w, h);
  if (mode === 'night') {
    c.fillStyle = '#fff';
    for (let i = 0; i < 40; i++) { c.globalAlpha = 0.4 + ((i * 37) % 60) / 100; c.beginPath(); c.arc((i * 97) % w, (i * 53) % (h * 0.75), 1 + (i % 3) * 0.5, 0, 7); c.fill(); }
    c.globalAlpha = 1; c.fillStyle = '#fff5cf'; c.beginPath(); c.arc(290, 78, 24, 0, 7); c.fill();
    c.fillStyle = cols[0]; c.beginPath(); c.arc(278, 70, 21, 0, 7); c.fill();
  } else {
    c.fillStyle = mode === 'dusk' ? '#ffe0a0' : '#fff7c4'; c.beginPath(); c.arc(290, mode === 'dusk' ? 160 : 78, 24, 0, 7); c.fill();
    c.fillStyle = 'rgba(255,255,255,.9)';
    for (const [x, y, r] of [[70, 78, 20], [96, 70, 26], [124, 80, 18], [216, 112, 12], [232, 108, 15]]) { c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); }
  }
  const land = { night: ['#232a55', '#161b3a'], dusk: ['#7d5a8c', '#4b3a66'], day: ['#8fcf8a', '#5fae6a'] }[mode];
  c.fillStyle = land[0]; c.beginPath(); c.moveTo(0, h); c.lineTo(0, h * 0.72); c.quadraticCurveTo(w * 0.25, h * 0.58, w * 0.5, h * 0.7); c.quadraticCurveTo(w * 0.78, h * 0.82, w, h * 0.64); c.lineTo(w, h); c.fill();
  c.fillStyle = land[1]; c.beginPath(); c.moveTo(0, h); c.lineTo(0, h * 0.84);
  for (let i = 0; i <= 10; i++) c.quadraticCurveTo((i + 0.5) * w / 10 - w / 20, h * (0.76 + (i % 3) * 0.02), (i + 1) * w / 10, h * 0.86);
  c.lineTo(w, h); c.fill();
  if (raining) { // 陰天:整片罩上一層灰藍,再加幾朵壓得低低的烏雲
    c.fillStyle = mode === 'night' ? 'rgba(24,28,52,.6)' : mode === 'dusk' ? 'rgba(92,90,120,.6)' : 'rgba(128,142,164,.62)'; c.fillRect(0, 0, w, h);
    c.fillStyle = mode === 'night' ? 'rgba(52,58,92,.8)' : 'rgba(150,160,180,.85)';
    for (const [x, y, r] of [[40, 18, 46], [110, 8, 54], [190, 22, 50], [270, 6, 58], [350, 20, 48]]) { c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); }
  }
});
const posterTex = () => canvasTex('poster', 256, 352, (c, w, h) => {
  const gr = c.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, '#2b2f66'); gr.addColorStop(0.55, '#c45c8a'); gr.addColorStop(1, '#ffb27a'); c.fillStyle = gr; c.fillRect(0, 0, w, h);
  c.fillStyle = '#ffe3b0'; c.beginPath(); c.arc(w / 2, h * 0.52, 46, 0, 7); c.fill();
  c.fillStyle = '#3a2a5c'; c.beginPath(); c.moveTo(0, h); c.lineTo(0, h * 0.72); c.lineTo(70, h * 0.56); c.lineTo(130, h * 0.7); c.lineTo(190, h * 0.6); c.lineTo(w, h * 0.74); c.lineTo(w, h); c.fill();
  c.fillStyle = '#241a40'; c.beginPath(); c.moveTo(0, h); c.lineTo(0, h * 0.86); c.lineTo(90, h * 0.76); c.lineTo(170, h * 0.88); c.lineTo(w, h * 0.8); c.lineTo(w, h); c.fill();
  c.fillStyle = '#fff'; for (let i = 0; i < 18; i++) { c.globalAlpha = 0.5 + (i % 4) * 0.12; c.fillRect((i * 67) % w, (i * 41) % (h * 0.4), 2, 2); } c.globalAlpha = 1;
});
const artTex = () => canvasTex('art', 256, 344, (c, w, h) => { // 掛畫:海邊的小屋
  c.fillStyle = '#fbe9cf'; c.fillRect(0, 0, w, h);
  c.fillStyle = '#f7c9a0'; c.beginPath(); c.arc(w * 0.68, h * 0.3, 40, 0, 7); c.fill();
  c.fillStyle = '#9fd3d6'; c.fillRect(0, h * 0.5, w, h * 0.5);
  c.fillStyle = '#7fbfc6'; for (let i = 0; i < 5; i++) c.fillRect(20 + i * 40, h * (0.58 + i * 0.07), 90, 4);
  c.fillStyle = '#e9b98c'; c.beginPath(); c.moveTo(0, h); c.lineTo(0, h * 0.74); c.quadraticCurveTo(w * 0.3, h * 0.66, w * 0.62, h * 0.86); c.lineTo(w * 0.7, h); c.fill();
  c.fillStyle = '#fff8ee'; c.fillRect(40, h * 0.6, 62, 46); c.fillStyle = '#e58a7c'; c.beginPath(); c.moveTo(32, h * 0.6); c.lineTo(71, h * 0.5); c.lineTo(110, h * 0.6); c.fill();
  c.fillStyle = '#6fa3b8'; c.fillRect(62, h * 0.66, 18, 26);
});
const rainTex = () => { // 雨絲:透明底上的斜線,往下捲動
  const t = canvasTex('rainStreaks', 128, 256, (c, w, h) => {
    c.clearRect(0, 0, w, h); c.strokeStyle = '#eaf2ff'; c.lineCap = 'round';
    for (let i = 0; i < 46; i++) {
      const x = rnd01(i + 400) * w, y = rnd01(i + 430) * h, len = 14 + rnd01(i + 460) * 26;
      c.globalAlpha = 0.25 + rnd01(i + 490) * 0.45; c.lineWidth = 1 + rnd01(i + 520) * 1.2;
      for (const dy of [-h, 0, h]) { c.beginPath(); c.moveTo(x, y + dy); c.lineTo(x - len * 0.16, y + dy + len); c.stroke(); }
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(3, 1.1);
  return t;
};
const TEX = { screen: screenTex, poster: posterTex, art: artTex, sky: () => skyTex(mood) };

// 木紋與布紋:可以無限重複的淡色花紋,會和家具本身的顏色相乘,所以換色之後紋路還在
// 模型的貼圖座標單位是公尺,repeat 決定一張圖鋪多大
const rnd01 = (n) => { const v = Math.sin(n * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); };
function tileTex(key, draw, repU, repV) {
  const t = canvasTex(key, 256, 256, draw);
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(repU, repV); t.anisotropy = 8;
  return t;
}
const woodTex = () => tileTex('grainWood', (c, w, h) => { // 一張 = 長 0.9 公尺 × 寬 0.36 公尺,紋路順著 u 方向
  c.fillStyle = '#ffffff'; c.fillRect(0, 0, w, h);
  for (let i = 0; i < 34; i++) {
    const y0 = rnd01(i) * h, amp = 1.5 + rnd01(i + 50) * 3.5, ph = rnd01(i + 90) * 7, per = 1 + Math.floor(rnd01(i + 20) * 2);
    c.strokeStyle = '#8a5a34'; c.globalAlpha = 0.07 + rnd01(i + 70) * 0.13; c.lineWidth = 1 + rnd01(i + 30) * 2.2;
    for (const dy of [-h, 0, h]) { // 上下各多畫一次,接縫才接得起來
      c.beginPath();
      for (let x = 0; x <= w; x += 8) { const y = y0 + dy + Math.sin((x / w) * Math.PI * 2 * per + ph) * amp; if (x) c.lineTo(x, y); else c.moveTo(x, y); }
      c.stroke();
    }
  }
  c.globalAlpha = 0.05; c.fillStyle = '#8a5a34'; // 幾條寬一點的色帶,像不同深淺的年輪
  for (let i = 0; i < 5; i++) { const y = rnd01(i + 200) * h, hh = 10 + rnd01(i + 210) * 22; for (const dy of [-h, 0, h]) c.fillRect(0, y + dy, w, hh); }
  c.globalAlpha = 1;
}, 1 / 0.9, 1 / 0.36);
const fabricTex = () => tileTex('grainFabric', (c, w, h) => { // 一張 = 0.14 公尺見方的平織布紋
  c.fillStyle = '#ffffff'; c.fillRect(0, 0, w, h);
  const n = 32, s = w / n;
  for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) {
    const over = (i + j) % 2 === 0;
    c.globalAlpha = (over ? 0.1 : 0.03) + rnd01(i * 37 + j) * 0.05; c.fillStyle = '#4a4660';
    if (over) c.fillRect(i * s + 1, j * s, s - 2, s); else c.fillRect(i * s, j * s + 1, s, s - 2);
  }
  c.globalAlpha = 1;
}, 1 / 0.14, 1 / 0.14);
const GRAIN = { wood: woodTex, woodDark: woodTex, fabric: fabricTex, fabric2: fabricTex, cream: fabricTex };

// 卡通材質:三階明暗;描邊、螢幕、窗景等用不受光的材質
const toonRamp = new THREE.DataTexture(new Uint8Array([150, 200, 236]), 3, 1, THREE.RedFormat);
toonRamp.minFilter = toonRamp.magFilter = THREE.NearestFilter; toonRamp.needsUpdate = true;
const toonCache = new Map();
function toonMat(name, hex) {
  const key = TEX[name] ? name + TEX[name]().uuid : name + hex;
  if (!toonCache.has(key)) {
    let m;
    if (name === 'outline') m = new THREE.MeshBasicMaterial({ color: '#5b4638' });
    else if (TEX[name]) { const t = TEX[name]().clone(); t.flipY = false; t.needsUpdate = true; m = new THREE.MeshBasicMaterial({ map: t, toneMapped: false }); }
    else if (name === 'mirror') m = new THREE.MeshBasicMaterial({ color: '#dbeef6' });
    else {
      // 燈罩自己發亮但不受其他燈影響,亮度固定,晚上才會有一點光暈
      m = name === 'shade' ? new THREE.MeshBasicMaterial({ color: new THREE.Color('#fff0d0').multiplyScalar(1.22) })
        : new THREE.MeshToonMaterial({ color: hex, gradientMap: toonRamp, map: GRAIN[name] ? GRAIN[name]() : null });
    }
    m.name = name;
    toonCache.set(key, m);
  }
  return toonCache.get(key);
}
const flat = (name) => name === 'outline' || name === 'mirror' || name === 'shade' || !!TEX[name]; // 不受光、也不投影的材質
const modelsReady = Promise.all(SFILES.map((n) => new GLTFLoader().loadAsync(`/assets/studio/${n}.glb`).then((g) => {
  g.scene.traverse((o) => {
    if (!o.isMesh) return;
    const nm = o.material.name;
    o.userData.hex = '#' + o.material.color.getHexString();
    o.material = toonMat(nm, o.userData.hex);
    o.castShadow = o.receiveShadow = !flat(nm);
    if (nm === 'fabric' || nm === 'wood') STINT[n] = true;
  });
  MODEL[n] = g.scene;
  SBB[n] = new THREE.Box3().setFromObject(g.scene);
  loadedN++; refreshOverlay();
}))).then(() => { modelsLoaded = true; refreshOverlay(); });
// 放一個模型。c = 換色(有布料換布料,否則換木頭)
function sput(g, n, o = {}) {
  const m = MODEL[n].clone();
  let fabric = false;
  m.traverse((ch) => { if (ch.isMesh && ch.material.name === 'fabric') fabric = true; });
  m.traverse((ch) => {
    if (!ch.isMesh) return;
    const nm = ch.material.name;
    if (nm === 'sky') ch.material = toonMat('sky'); // 窗景跟著目前的光線(白天/黃昏/夜晚)
    if (!o.c) return;
    if (fabric && nm === 'fabric') ch.material = toonMat(nm, FABRICS[o.c]);
    else if (!fabric && nm === 'wood') ch.material = toonMat(nm, WOODS[o.c]);
    else if (!fabric && nm === 'woodDark') ch.material = toonMat(nm, '#' + new THREE.Color(WOODS[o.c]).multiplyScalar(0.72).getHexString());
  });
  m.position.set(o.x || 0, o.y || 0, o.z || 0); m.rotation.y = o.ry || 0;
  g.add(m);
  return m;
}

// 地毯:平面 + 畫出來的花樣(條紋、同心圓、邊框),c 可換底色
const RUGS = {
  rug: { col: '#f0c987', shape: 'rect', pat: 'stripes' }, rug2: { col: '#e7a3b4', shape: 'oval', pat: 'rings' },
  rround: { col: '#f3ede2', shape: 'oval', pat: 'rings' }, rsquare: { col: '#9fc7a3', shape: 'rect', pat: 'diamond' },
  rbig: { col: '#f3ede2', shape: 'rect', pat: 'border' }, mat: { col: '#d9b38a', shape: 'rect', pat: 'mat' },
};
function buildRug(g, type, o = {}) {
  const d = CATALOG[type], k = RUGS[type], W = d.w - 0.12, H = d.h - (type === 'mat' ? 0.45 : 0.12), base = new THREE.Color(FABRICS[o.c] || k.col);
  const tex = canvasTex(`rug${type}${o.c || 0}`, 256, Math.round(256 * H / W), (c, w, h) => {
    const hex = (m) => '#' + base.clone().multiplyScalar(m).getHexString(), lite = '#' + base.clone().lerp(new THREE.Color('#ffffff'), 0.55).getHexString();
    const path = (inset) => { c.beginPath(); if (k.shape === 'oval') c.ellipse(w / 2, h / 2, w / 2 - inset, h / 2 - inset, 0, 0, 7); else c.roundRect(inset, inset, w - inset * 2, h - inset * 2, 14); };
    c.clearRect(0, 0, w, h);
    path(1); c.fillStyle = hex(1); c.fill(); c.save(); c.clip();
    if (k.pat === 'stripes') { c.fillStyle = lite; for (let x = 18; x < w; x += 44) c.fillRect(x, 0, 16, h); c.fillStyle = hex(0.82); for (let x = 40; x < w; x += 44) c.fillRect(x, 0, 4, h); }
    if (k.pat === 'diamond') { c.strokeStyle = lite; c.lineWidth = 6; for (let i = -4; i < 8; i++) { c.beginPath(); c.moveTo(i * 48, 0); c.lineTo(i * 48 + h, h); c.moveTo(i * 48 + h, 0); c.lineTo(i * 48, h); c.stroke(); } }
    c.restore();
    if (k.pat === 'rings') for (const [ins, col, lw] of [[14, lite, 8], [38, hex(0.84), 4], [60, lite, 5]]) { path(ins); c.strokeStyle = col; c.lineWidth = lw; c.stroke(); }
    if (k.pat === 'border') { for (const [ins, col, lw] of [[12, hex(0.8), 6], [26, lite, 4]]) { path(ins); c.strokeStyle = col; c.lineWidth = lw; c.stroke(); } }
    if (k.pat === 'mat') { path(10); c.strokeStyle = hex(0.7); c.lineWidth = 5; c.stroke(); c.fillStyle = hex(0.62); c.font = '700 44px system-ui, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('HELLO', w / 2, h / 2 + 3); }
    path(2); c.strokeStyle = '#5b4638'; c.lineWidth = 3; c.stroke(); // 外圈描邊
  });
  const m = new THREE.Mesh(geo(`rugp${W},${H}`, () => new THREE.PlaneGeometry(W, H)), geo('rugm' + tex.uuid, () => new THREE.MeshToonMaterial({ map: tex, gradientMap: toonRamp, transparent: true, alphaTest: 0.5 })));
  m.rotation.x = -Math.PI / 2; m.position.set(d.w / 2, 0.012 + (type === 'mat' ? 0.004 : 0), d.h / 2); m.receiveShadow = true;
  g.add(m);
}

const BUILD = {
  neon(g) {
    const pink = mat('#ff7fb0', glow('#ff4f98', 2.6)), blue = mat('#9fe6ff', glow('#5fd0ff', 2.6));
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
};
for (const type of Object.keys(RUGS)) BUILD[type] = (g, o) => buildRug(g, type, o);
for (const [type, k] of Object.entries(ITEMS)) BUILD[type] = (g, o = {}) => {
  const d = CATALOG[type], bb = SBB[k.m], wall = d.kind === 'wall';
  const z = wall ? 0 : k.back ? (bb.max.z - bb.min.z) / 2 + 0.03 : d.h / 2;
  const model = sput(g, k.m, { x: d.w / 2, z, c: o.c, ry: o.side === -1 ? Math.PI : 0 });
  if (type === 'cat') { g.userData.cat = { rest: model, walk: sput(g, 'cat_walk', { x: d.w / 2, z }) }; g.userData.cat.walk.visible = false; }
  if (k.lamp) g.userData.lampAt = new THREE.Vector3(d.w / 2, k.lamp, wall ? 0.3 : z);
  if (k.glow) g.userData.glowAt = new THREE.Vector3(...k.glow);
  if (type === 'window' && raining) { // 玻璃後面往下流的雨絲
    const tex = rainTex(), m = new THREE.Mesh(geo('rainPlane', () => new THREE.PlaneGeometry(1.64, 1.19)), geo('rainMat', () => new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false, toneMapped: false })));
    m.position.set(d.w / 2, 1.625, 0.02); g.add(m);
    g.userData.anim = (t) => { tex.offset.y = (t / 520) % 1; tex.offset.x = (t / 5200) % 1; };
  }
  if (type === 'clock') { // 指針依現在時間轉動
    const hand = (w, len, col) => {
      const h = new THREE.Mesh(geo(`hand${w},${len}`, () => new THREE.BoxGeometry(w, len, 0.004).translate(0, len / 2 - 0.012, 0)), toonMat('hand', col));
      h.position.set(d.w / 2, 2.15, 0.064); g.add(h); return h;
    };
    const hh = hand(0.016, 0.085, '#4d4c60'), mm = hand(0.011, 0.125, '#4d4c60'), ss = hand(0.005, 0.135, '#e2726f');
    g.userData.anim = () => {
      const now = new Date(), sec = now.getSeconds(), min = now.getMinutes() + sec / 60, hr = (now.getHours() % 12) + min / 60;
      hh.rotation.z = -(hr / 12) * Math.PI * 2; mm.rotation.z = -(min / 60) * Math.PI * 2; ss.rotation.z = -(sec / 60) * Math.PI * 2;
    };
  }
};
function buildItem(type, opt) {
  const g = new THREE.Group();
  BUILD[type]?.(g, opt);
  return g;
}
// 可以放小物的檯面高度(沒有就是 0 = 地板)
const surfTop = (it) => ITEMS[it.type]?.surf || 0;
// 家具檯面在房間裡實際佔的範圍(照模型的外框算,不是整格),小物的中心落在裡面才算放在上面
function surfaceRect(it) {
  const k = ITEMS[it.type], d = CATALOG[it.type], bb = SBB[k.m], th = rotOf(it.r) * Math.PI / 2, [W, H] = dimsOf(it.type, it.r);
  const zOff = (k.back ? (bb.max.z - bb.min.z) / 2 + 0.03 : d.h / 2) - d.h / 2;
  const pt = (mx, mz) => [it.x + W / 2 + mx * Math.cos(th) + (zOff + mz) * Math.sin(th), it.y + H / 2 - mx * Math.sin(th) + (zOff + mz) * Math.cos(th)];
  const [ax, az] = pt(bb.min.x, bb.min.z), [bx, bz] = pt(bb.max.x, bb.max.z);
  return [Math.min(ax, bx), Math.max(ax, bx), Math.min(az, bz), Math.max(az, bz)];
}
function surfAt(cx, cz) {
  let top = 0;
  for (const it of room.items) {
    if (!surfTop(it) || CATALOG[it.type]?.kind !== 'floor') continue;
    const [x0, x1, z0, z1] = surfaceRect(it);
    if (cx >= x0 && cx <= x1 && cz >= z0 && cz <= z1) top = Math.max(top, surfTop(it));
  }
  return top;
}

// ---------- 座位:椅子自動朝向最近的桌子,專注時角色會走過去坐下 ----------
const SEAT_TYPES = Object.fromEntries(Object.entries(ITEMS).filter(([, k]) => k.seat).map(([t, k]) => [t, k.seat])); // 座面高度
const DESK_TYPES = ['kdesk', 'dining'];
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
    return { id: i.id, x, z, face, h: SEAT_TYPES[i.type], desk: best?.id, fwd: best ? SIT_FWD : 0.08 };
  });
  // 沙發可以坐兩個人(面向沙發的正面)
  for (const i of room.items.filter((q) => q.type === 'ksofa')) {
    const [W, H] = dimsOf(i.type, i.r), th = rotOf(i.r) * Math.PI / 2, cx = i.x + W / 2, cz = i.y + H / 2;
    for (const k of [-0.42, 0.42]) seats.push({ id: i.id, x: cx + Math.cos(th) * k, z: cz - Math.sin(th) * k, face: th, h: 0.42, desk: null, fwd: 0.02, sofa: true });
  }
  seats.sort((a, b) => (a.desk != null ? 0 : 1) - (b.desk != null ? 0 : 1)); // 先坐滿書桌前的椅子,再坐其他座位
}
// ---------- 貓:在家附近閒晃,走一走就趴下休息 ----------
// 位置記在 catState 裡,房間重建時貓不會瞬間跳回原位。目的地用時間和編號算出來,
// 所以同一個房間裡每個人看到的貓大致會走到同一個地方。
const catState = new Map(); // item id -> { x, y, path, bucket, heading }
function catAnim(it, parts) {
  let st = catState.get(it.id);
  if (!st) catState.set(it.id, (st = { x: it.x + 0.5, y: it.y + 0.5, path: [], bucket: -1, heading: 0, home: [it.x, it.y] }));
  if (st.home[0] !== it.x || st.home[1] !== it.y) Object.assign(st, { x: it.x + 0.5, y: it.y + 0.5, path: [], home: [it.x, it.y] }); // 被搬到新位置
  let last = 0;
  return (t) => {
    const dt = Math.min(0.1, last ? (t - last) / 1000 : 0); last = t;
    const bucket = Math.floor(Date.now() / 14000);
    if (bucket !== st.bucket && !st.path.length) { // 每隔一陣子決定要不要換個地方
      st.bucket = bucket;
      const r = rnd01(bucket * 7.13 + it.id * 3.7);
      if (r < 0.6) {
        const spots = [];
        for (let x = 0; x < COLS; x++) for (let y = 0; y < ROWS; y++) if (!blocked.has(tkey(x, y)) && Math.hypot(x - it.x, y - it.y) <= 3.2) spots.push([x + 0.5, y + 0.5]);
        if (spots.length) { const [gx, gy] = spots[Math.floor(rnd01(bucket * 1.31 + it.id) * spots.length)]; st.path = findPath(st.x, st.y, gx, gy); }
      }
    }
    const walking = st.path.length > 0;
    if (walking) {
      const [wx, wy] = st.path[0], dx = wx - st.x, dy = wy - st.y, d = Math.hypot(dx, dy), step = 0.75 * dt;
      if (d <= step) { st.x = wx; st.y = wy; st.path.shift(); } else { st.x += (dx / d) * step; st.y += (dy / d) * step; st.heading = Math.atan2(dx, dy); }
    }
    for (const m of [parts.rest, parts.walk]) { m.position.x = st.x - it.x; m.position.z = st.y - it.y; m.rotation.y = st.heading; }
    parts.rest.visible = !walking; parts.walk.visible = walking;
    parts.walk.position.y = Math.abs(Math.sin(t / 95)) * 0.035;                                     // 小跳步
    parts.walk.rotation.z = Math.sin(t / 95) * 0.05;
    parts.rest.scale.set(1 - Math.sin(t / 900) * 0.012, 1 + Math.sin(t / 900) * 0.035, 1);          // 趴著時緩緩呼吸
  };
}

// ---------- 走路:繞過家具,不再直接穿過去 ----------
let blocked = new Set(); // 被家具佔住的地板格
const tkey = (x, y) => x + ',' + y;
function computeBlocked() {
  blocked = new Set();
  for (const it of room.items) {
    if (CATALOG[it.type]?.kind !== 'floor' || it.type === 'cat') continue; // 貓會自己走開,不算障礙
    const [w, h] = dimsOf(it.type, it.r);
    for (let x = it.x; x < it.x + w; x++) for (let y = it.y; y < it.y + h; y++) blocked.add(tkey(x, y));
  }
  for (const p of players.values()) p.dest = null; // 房間變了,走到一半的人重新找路
}
// 從 (ax, ay) 直走到 (bx, by) 會不會撞到家具(allow = 起點與終點所在的格子,例外放行)
function clearLine(ax, ay, bx, by, allow) {
  const n = Math.ceil(Math.hypot(bx - ax, by - ay) / 0.12);
  for (let i = 1; i < n; i++) {
    const x = ax + ((bx - ax) * i) / n, y = ay + ((by - ay) * i) / n;
    for (const [ox, oy] of [[0.2, 0], [-0.2, 0], [0, 0.2], [0, -0.2]]) { const k = tkey(Math.floor(x + ox), Math.floor(y + oy)); if (blocked.has(k) && !allow.has(k)) return false; }
  }
  return true;
}
function findPath(sx, sy, gx, gy) {
  const tile = (v, n) => Math.min(n - 1, Math.max(0, Math.floor(v)));
  const st = [tile(sx, COLS), tile(sy, ROWS)], gt = [tile(gx, COLS), tile(gy, ROWS)], allow = new Set([tkey(...st), tkey(...gt)]);
  if (clearLine(sx, sy, gx, gy, allow)) return [[gx, gy]];
  const open = (x, y) => x >= 0 && y >= 0 && x < COLS && y < ROWS && (!blocked.has(tkey(x, y)) || allow.has(tkey(x, y)));
  const dist = new Map([[tkey(...st), 0]]), prev = new Map(), todo = [st];
  while (todo.length) { // 房間很小,簡單的最短路徑搜尋就夠了
    todo.sort((a, b) => dist.get(tkey(...a)) - dist.get(tkey(...b)));
    const [x, y] = todo.shift(), d0 = dist.get(tkey(x, y));
    if (x === gt[0] && y === gt[1]) break;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
      const nx = x + dx, ny = y + dy;
      // 斜走不能切過家具的角;但起點或終點本身被家具圍住時(例如塞在桌子後面的椅子)放寬,總比直接穿過桌子好
      const squeeze = allow.has(tkey(x, y)) || allow.has(tkey(nx, ny));
      if (!open(nx, ny) || (dx && dy && !squeeze && (!open(x + dx, y) || !open(x, y + dy)))) continue;
      const nd = d0 + (dx && dy ? 1.414 : 1), k = tkey(nx, ny);
      if (nd < (dist.get(k) ?? 1e9)) { dist.set(k, nd); prev.set(k, [x, y]); todo.push([nx, ny]); }
    }
  }
  if (!prev.has(tkey(...gt))) return [[gx, gy]]; // 被家具圍住了:只好直走
  const pts = [[gx, gy]];
  for (let c = prev.get(tkey(...gt)); c && !(c[0] === st[0] && c[1] === st[1]); c = prev.get(tkey(...c))) pts.unshift([c[0] + 0.5, c[1] + 0.5]);
  const out = []; // 能直走的就略過中間的轉折點,路線才不會一格一格地折
  let cx = sx, cy = sy, i = 0;
  while (i < pts.length) {
    let j = pts.length - 1;
    while (j > i && !clearLine(cx, cy, pts[j][0], pts[j][1], allow)) j--;
    out.push(pts[j]); [cx, cy] = pts[j]; i = j + 1;
  }
  return out;
}
// 點到家具上時,改走到最近的空地
function nearestFree(x, y) {
  if (!blocked.has(tkey(Math.floor(x), Math.floor(y)))) return [x, y];
  let best = [x, y], bd = 1e9;
  for (let tx = 0; tx < COLS; tx++) for (let ty = 0; ty < ROWS; ty++) {
    if (blocked.has(tkey(tx, ty))) continue;
    const d = Math.hypot(tx + 0.5 - x, ty + 0.5 - y);
    if (d < bd) { bd = d; best = [tx + 0.5, ty + 0.5]; }
  }
  return best;
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
      // 自己挑的顏色優先,沒有的話用舊版的色票編號
      const tint = skin ? SKIN[a.skin] : /HAIR/.test(n) ? (a.hairHex || HAIRC[a.hairColor]) : /EyeIris/.test(n) ? a.eyeHex
        : /Tops|Onepiece/.test(n) ? (a.topHex || SHIRT[a.shirt]) : /Bottoms/.test(n) ? a.bottomHex : null;
      if (!tint) continue;
      const old = m.map, oldShade = m.shadeMultiplyTexture;
      m.map = swap(old, tint, skin);
      m.shadeMultiplyTexture = oldShade === old ? m.map : swap(oldShade, tint, skin);
      if (m.uniforms?.map) m.uniforms.map.value = m.map;
      if (m.uniforms?.shadeMultiplyTexture) m.uniforms.shadeMultiplyTexture.value = m.shadeMultiplyTexture;
      // 原本的顏色有一部分是另外乘在材質上的(例如深色頭髮配淺灰貼圖),換色時要歸零,選的顏色才準
      if (!skin) { m.color?.set('#ffffff'); m.shadeColorFactor?.set(tint).multiplyScalar(0.72); }
    }
  });
}

// 立刻回傳一個空群組,模型載入後再填入
// ---------- 早期的積木風角色(Quaternius Ultimate Animated Character Pack,CC0),用模型內附的動作 ----------
const CLASSIC_FILES = ['Casual_Male', 'Casual_Female', 'Casual2_Male', 'Casual2_Female', 'Casual3_Male', 'Casual_Bald'];
const CLASSIC_SKIN = ['#ffe3d0', '#f8cdaa', '#e6ad84', '#bd8158', '#85573a'];
const CLASSIC_HAIR = ['#3a3040', '#6b4630', '#b0733c', '#f0c466', '#ee8aa0', '#7f96e8', '#eeeaf4'];
const CLASSIC_SHIRT = ['#f08d94', '#ffc98a', '#9ed59a', '#7cc3d6', '#8c9cea', '#c09ae0', '#fbf6ec', '#56506e'];
const CLASSIC_H = 1.62, VROID_TOP = 0.215; // 身高;VROID_TOP = 動漫角色頭頂比頭部骨架高多少(配件是照這個尺寸做的)
const classicCache = new Map();
function loadClassic(i) {
  if (!classicCache.has(i)) classicCache.set(i, new GLTFLoader().loadAsync(`/assets/characters/${CLASSIC_FILES[i]}.glb`).then((gl) => {
    gl.scene.updateMatrixWorld(true);
    const bb = new THREE.Box3();
    gl.scene.traverse((o) => { if (o.isSkinnedMesh) { o.computeBoundingBox(); bb.union(o.boundingBox.clone().applyMatrix4(o.matrixWorld)); } });
    return { scene: gl.scene, clips: gl.animations, h: bb.max.y - bb.min.y || 1, minY: bb.min.y };
  }));
  return classicCache.get(i);
}
function buildClassic(a, onReady) {
  const g = new THREE.Group();
  g.userData = { ready: false, dead: false };
  loadClassic(a.hair - 6).then((c) => {
    if (g.userData.dead) return;
    const m = cloneSkinned(c.scene), scale = (CLASSIC_H / c.h) * (0.9 + (a.height ?? 4) * 0.025), headK = 1 + (a.headSize || 0) * 0.06;
    m.scale.setScalar(scale); m.position.y = -c.minY * scale;
    const tints = { Skin: CLASSIC_SKIN[a.skin] || CLASSIC_SKIN[0], Hair: a.hairHex || CLASSIC_HAIR[a.hairColor] || CLASSIC_HAIR[0], Shirt: a.topHex || CLASSIC_SHIRT[a.shirt] || CLASSIC_SHIRT[0],
      Pants: a.bottomHex || '#5d5f86', Belt: '#3b3a4a', Face: a.eyeHex || '#3a2f3c' };
    m.traverse((o) => {
      if (!o.isMesh) return;
      o.castShadow = true; o.receiveShadow = false; o.frustumCulled = false;
      o.material = new THREE.MeshToonMaterial({ color: tints[o.material.name] || o.material.color, gradientMap: toonRamp }); // 和家具同一種卡通打光
    });
    g.add(m);
    g.updateMatrixWorld(true);
    // 以角色自己為基準算頭的位置(角色這時可能已經站在房間裡、轉了方向,不能直接用世界座標)
    const head = m.getObjectByName('Head'), headMat = g.matrixWorld.clone().invert().multiply(head.matrixWorld);
    const headPos = new THREE.Vector3().setFromMatrixPosition(headMat);
    const topWorld = c.h * scale - headPos.y; // 頭頂比頭部骨架高多少
    // 配件:在頭部骨架下面放一個「擺正」的掛點(朝前、不歪),大小照頭的高度換算,就能沿用動漫角色的配件
    const worn = [ACCS[a.acc], a.glasses ? GLASSES : null].filter(Boolean);
    if (worn.length) {
      const anchor = new THREE.Object3D(), S = (topWorld / VROID_TOP) * 0.8;
      anchor.applyMatrix4(new THREE.Matrix4().compose(headPos, new THREE.Quaternion(), new THREE.Vector3(S, S, S)).premultiply(headMat.clone().invert()));
      head.add(anchor);
      const wear = () => {
        if (g.userData.dead) return;
        for (const acc of worn) {
          const am = sput(anchor, acc.m, { y: acc.top != null ? VROID_TOP / 0.8 + acc.top : acc === GLASSES ? 0.055 : 0.03, z: acc === GLASSES ? 0.035 : 0, c: a.accColor });
          am.scale.setScalar(acc.fit ? (VROID_TOP / 0.8 + 0.015) / acc.fit : (acc.scale || 1) * (acc === GLASSES ? 1.45 : 1.05));
        }
      };
      if (modelsLoaded) wear(); else modelsReady.then(wear);
    }
    const mixer = new THREE.AnimationMixer(m), act = {};
    for (const n of ['Idle', 'Walk', 'SitDown', 'Victory']) { const clip = c.clips.find((k) => k.name === n); if (clip) act[n] = mixer.clipAction(clip); }
    if (act.SitDown) { act.SitDown.loop = THREE.LoopOnce; act.SitDown.clampWhenFinished = true; }
    act.Idle?.play(); mixer.update(0);
    g.userData = { ...g.userData, ready: true, classic: true, mixer, act, cur: 'Idle', head, headK, scale, headY: headPos.y, tall: headPos.y + topWorld * headK, sitFwd: 0.12, seat: null };
    head.scale.setScalar(headK);
    onReady?.(g);
  }).catch((e) => console.error('classic avatar load failed', e));
  return g;
}
function poseClassic(g, dt, st) {
  const u = g.userData;
  const want = st.walking ? 'Walk' : (st.cheering || st.stretching || st.waving) && u.act.Victory ? 'Victory' : st.sitting && u.act.SitDown ? 'SitDown' : 'Idle';
  if (want !== u.cur && u.act[want]) { u.act[want].reset().fadeIn(0.2).play(); u.act[u.cur]?.fadeOut(0.2); u.cur = want; }
  u.mixer.update(dt);
  u.head.scale.setScalar(u.headK); // 動作會把骨頭的大小寫回去,每格重新套用
  if (!u.seat && modelsLoaded) u.seat = sput(g, 'stool');
  if (u.seat) u.seat.visible = u.cur === 'SitDown' && !!st.ownStool;
}

function buildAvatar(a, onReady) {
  if (a.hair >= 6) return buildClassic(a, onReady);
  const g = new THREE.Group();
  g.userData = { ready: false, dead: false };
  loadChar(a.hair % CHAR_FILES.length).then((buf) => vrmLoader.parseAsync(buf.slice(0), '')).then((gltf) => {
    const vrm = gltf.userData.vrm;
    if (g.userData.dead) return VRMUtils.deepDispose(vrm.scene);
    VRMUtils.removeUnnecessaryVertices(vrm.scene);
    VRMUtils.rotateVRM0(vrm); // 舊版 VRM 面向 -z,轉成面向 +z
    tintAvatar(vrm, a);
    // 身高(0.9–1.1 倍)與頭的大小(1–1.48 倍,越大越接近 Q 版)
    const scale = AV_SCALE * (0.9 + (a.height ?? 4) * 0.025), headK = 1 + (a.headSize || 0) * 0.06;
    vrm.scene.scale.setScalar(scale);
    g.add(vrm.scene);
    const H = vrm.humanoid, bone = {};
    for (const n of BONES) bone[n] = H.getNormalizedBoneNode(n);
    // 量出頭頂(含頭髮)比頭部骨架高多少,帽子和貓耳才不會埋在頭髮裡
    vrm.scene.updateMatrixWorld(true);
    const headY = bone.head.getWorldPosition(new THREE.Vector3()).y, top = (new THREE.Box3().setFromObject(vrm.scene).max.y - headY) / scale;
    const rawHead = H.getRawBoneNode('head'); // 放大的是實際帶動模型的那根骨頭,頭髮和配件會跟著一起變大
    rawHead.scale.setScalar(headK);
    vrm.springBoneManager?.reset();
    const worn = [ACCS[a.acc], a.glasses ? GLASSES : null].filter(Boolean);
    if (worn.length) {
      const wear = () => {
        if (g.userData.dead) return;
        for (const acc of worn) {
          const m = sput(rawHead, acc.m, { y: acc.top != null ? top + acc.top : 0, ry: Math.PI, c: a.accColor });
          m.scale.setScalar(acc.fit ? Math.max(1, (top + 0.015) / acc.fit) : acc.scale || 1);
        }
      };
      if (modelsLoaded) wear(); else modelsReady.then(wear);
    }
    const gaze = new THREE.Object3D(); scene.add(gaze);
    if (vrm.lookAt) vrm.lookAt.target = gaze;
    g.userData = { ...g.userData, ready: true, vrm, bone, gaze, headY, scale, tall: headY + top * headK * scale, face: a.face || 0, hipsY: bone.hips.position.y, flip: vrm.meta?.metaVersion === '0' ? -1 : 1, blinkAt: 2, blink: 0, ph: Math.random() * 6, seat: null, book: null };
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
  if (u.classic) return poseClassic(g, dt, st);
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
    hipsY = (st.seatH || 0.42) / u.scale + 0.09;
    P.leftUpperLeg = [-1.5, 0, 0.06]; P.rightUpperLeg = [-1.5, 0, -0.06];
    P.leftLowerLeg = [1.45, 0, 0]; P.rightLowerLeg = [1.45, 0, 0];
    P.spine = [0.1 + breathe, 0, 0]; P.chest = [0.05, 0, 0];
    if (st.pose === 2) { // 看書:雙手把書舉在胸前
      arms(1.2, 0.4, 1.55, 0.3, -0.2);
      P.neck = [0.22, 0, 0]; P.head = [0.18 + sin(t * 0.5) * 0.03, sin(t * 0.23) * 0.05, 0];
    } else if (st.noDesk) { // 面前沒有桌子(坐沙發或自備小凳子):雙手放在腿上,偶爾看看四周
      arms(1.22, 0.28, 0.95, 0.9);
      P.spine = [0.02 + breathe, 0, 0]; P.chest = [0, 0, 0];
      P.neck = [0.05, 0, 0]; P.head = [0.04 + sin(t * 0.4) * 0.03, sin(t * 0.21) * 0.25, 0];
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
  if (st.stretching && mode === 'idle') { // 伸懶腰:雙手高舉、身體微微後仰、閉眼
    const k2 = sin(t * 2.2) * 0.06;
    P.leftUpperArm = [0, 0, 1.28 + k2]; P.rightUpperArm = [0, 0, -1.28 - k2];
    P.leftLowerArm = [0, -0.25, 0]; P.rightLowerArm = [0, 0.25, 0];
    P.spine = [-0.1, 0, 0]; P.chest = [-0.08, 0, 0]; P.head = [-0.18, 0, 0];
  }
  if (st.waving && mode !== 'walk' && mode !== 'cheer') { // 舉起右手左右揮
    P.rightUpperArm = [0, 0, -0.95]; P.rightLowerArm = [0, 0.75 + sin(t * 11) * 0.45, 0]; P.rightHand = [0, 0, 0];
    P.head = [(P.head?.[0] || 0) - 0.05, P.head?.[1] || 0, -0.08];
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
    em.setValue('blink', st.stretching && mode === 'idle' ? 1 : u.blink > 0 ? 1 - Math.abs(u.blink - 0.07) / 0.07 : 0);
    em.setValue('happy', mode === 'cheer' || st.happy ? 1 : u.face === 1 ? 0.4 : 0); // 平常的表情:自然 / 微笑 / 放鬆
    em.setValue('relaxed', u.face === 2 && mode !== 'cheer' && !st.happy ? 0.75 : 0);
  }
  // 視線:站著時看鏡頭,坐著時看桌面
  if (mode === 'sit') g.localToWorld(tmpV2.set(0, 0.8, 0.55)); else tmpV2.copy(camera.position);
  u.gaze.position.lerp(tmpV2, dt ? Math.min(1, dt * 4) : 1);
  // 沒有空椅子時自備的小凳子、看書時手上的書
  if (!u.seat && modelsLoaded) u.seat = sput(g, 'stool');
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
let anims = [], wallPlanes = [], floorMesh = null, gridLines = null, wallLines = null;

// 牆面與地板:畫出來的壁紙、腰牆、踢腳板、木地板,線條和家具的描邊同色
const LINE = '#5b4638'; // 線條顏色,和家具描邊相同
const mix = (a, b, t) => '#' + new THREE.Color(a).lerp(new THREE.Color(b), t).getHexString();
const frac = (n) => { const v = Math.sin(n * 12.9898) * 43758.5453; return v - Math.floor(v); }; // 固定的偽亂數
const wallTexCache = new Map();
function wallTex(i, width) {
  const [wc, wt] = WALLS[i] || WALLS[0], PX = 256, PY = 252, H = Math.round(WALLH * PY); // 一張圖 = 寬 2 公尺 × 整面牆高
  const base = canvasTex('wall' + i, 512, H, (c, w, h) => {
    const y = (m) => (WALLH - m) * PY, line = (m, a = 0.55, lw = 2.5) => { c.globalAlpha = a; c.fillStyle = LINE; c.fillRect(0, y(m) - lw / 2, w, lw); c.globalAlpha = 1; };
    c.fillStyle = wc; c.fillRect(0, 0, w, h);
    const lite = mix(wc, '#ffffff', 0.35), deep = mix(wc, LINE, 0.1);
    if (i % 3 === 0) { c.fillStyle = lite; for (let r = 0; r < 12; r++) for (let k = 0; k < 8; k++) { c.beginPath(); c.arc(k * 64 + (r % 2) * 32 + 16, r * 46 + 20, 4, 0, 7); c.fill(); } }          // 小圓點
    if (i % 3 === 1) { c.fillStyle = lite; for (let k = 0; k < 8; k++) c.fillRect(k * 64 + 8, 0, 22, h); c.fillStyle = deep; for (let k = 0; k < 8; k++) c.fillRect(k * 64 + 44, 0, 3, h); } // 直條紋
    if (i % 3 === 2) { c.strokeStyle = lite; c.lineWidth = 3; for (let r = 0; r < 10; r++) for (let k = 0; k < 4; k++) { const cx = k * 128 + (r % 2) * 64 + 32, cy = r * 58 + 26; c.beginPath(); c.moveTo(cx - 8, cy); c.lineTo(cx + 8, cy); c.moveTo(cx, cy - 8); c.lineTo(cx, cy + 8); c.stroke(); } } // 小十字
    // 腰牆(直板)、腰線、踢腳板、天花板線板
    c.fillStyle = wt; c.fillRect(0, y(0.98), w, h);
    c.globalAlpha = 0.16; c.fillStyle = LINE; for (let k = 0; k < 8; k++) c.fillRect(k * 64 + 31, y(0.9), 2.5, y(0.14) - y(0.9)); c.globalAlpha = 1;
    c.fillStyle = mix(wt, '#ffffff', 0.5); c.fillRect(0, y(1.04), w, y(0.96) - y(1.04)); line(1.04); line(0.96, 0.4);
    c.fillStyle = mix(wt, '#ffffff', 0.5); c.fillRect(0, y(0.14), w, h); line(0.14, 0.5); line(0.008, 0.7, 4);
    c.fillStyle = mix(wt, '#ffffff', 0.5); c.fillRect(0, 0, w, y(WALLH - 0.09)); line(WALLH - 0.09, 0.45); line(WALLH - 0.008, 0.6, 4);
  });
  const key = i + ':' + width;
  if (!wallTexCache.has(key)) { const t = base.clone(); t.wrapS = THREE.RepeatWrapping; t.repeat.set(width / 2, 1); t.needsUpdate = true; wallTexCache.set(key, t); }
  return wallTexCache.get(key);
}
function floorTex(i) {
  const [a, b] = FLOORS[i] || FLOORS[0];
  const t = canvasTex('floor' + i, 512, 512, (c, w, h) => { // 一張圖 = 2 × 2 公尺
    c.fillStyle = a; c.fillRect(0, 0, w, h);
    if (i <= 2) {                         // 木地板:一條條長木板,深淺略有不同,接縫錯開
      for (let r = 0; r < 8; r++) {
        const off = Math.round(frac(r + i * 9) * 200);
        for (let k = -1; k < 3; k++) {
          const x = off + k * 256, tone = frac(r * 7 + k * 13 + i);
          c.fillStyle = mix(a, b, tone); c.fillRect(x, r * 64, 256, 64);
          c.globalAlpha = 0.1; c.fillStyle = LINE; for (let g = 0; g < 3; g++) c.fillRect(x + 20 + frac(r * 3 + k * 5 + g) * 150, r * 64 + 14 + g * 17, 50 + frac(g + r) * 60, 1.5); c.globalAlpha = 1;
          c.globalAlpha = 0.4; c.fillStyle = LINE; c.fillRect(x, r * 64, 2.5, 64); c.globalAlpha = 1;
        }
        c.globalAlpha = 0.4; c.fillStyle = LINE; c.fillRect(0, r * 64, w, 2.5); c.globalAlpha = 1;
      }
    } else if (i === 3) {                 // 方磚:兩色交錯
      for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) { c.fillStyle = (r + k) % 2 ? a : b; c.fillRect(k * 128, r * 128, 128, 128); }
      c.globalAlpha = 0.3; c.fillStyle = LINE; for (let k = 0; k < 4; k++) { c.fillRect(k * 128, 0, 2.5, h); c.fillRect(0, k * 128, w, 2.5); } c.globalAlpha = 1;
    } else {                              // 地毯:細小的織紋
      for (let n = 0; n < 1400; n++) { c.fillStyle = frac(n) > 0.5 ? b : mix(a, '#ffffff', 0.3); c.globalAlpha = 0.5; c.fillRect(frac(n * 1.7) * w, frac(n * 2.3) * h, 5, 2); }
      c.globalAlpha = 1;
    }
  });
  t.wrapS = t.wrapT = THREE.RepeatWrapping; t.repeat.set(COLS / 2, ROWS / 2);
  return t;
}
function buildShell() {
  roomGroup.clear(); wallPlanes = [];
  // 房間是封閉的,鏡頭在室內:四面牆各是一片朝內的平面,不擋陽光,室內才不會全黑
  const wall = (width, x, z, ry) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(width, WALLH), new THREE.MeshLambertMaterial({ emissive: '#ffffff', emissiveIntensity: 0.22 }));
    m.position.set(x, WALLH / 2, z); m.rotation.y = ry; m.receiveShadow = true; m.userData.width = width;
    roomGroup.add(m); wallPlanes.push(m);
  };
  wall(COLS, COLS / 2, 0, 0); wall(ROWS, 0, ROWS / 2, Math.PI / 2); wall(COLS, COLS / 2, ROWS, Math.PI); wall(ROWS, COLS, ROWS / 2, -Math.PI / 2);
  const ink = new THREE.MeshBasicMaterial({ color: LINE });
  for (const [x, z] of [[0, 0], [COLS, 0], [0, ROWS], [COLS, ROWS]]) { // 牆角的線
    const l = new THREE.Mesh(geo('cornerLine', () => new THREE.BoxGeometry(0.02, WALLH, 0.02)), ink);
    l.position.set(x, WALLH / 2, z); roomGroup.add(l);
  }
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(COLS, ROWS), new THREE.MeshLambertMaterial({ color: '#fbf6ec', emissive: '#fbf6ec', emissiveIntensity: 0.25 }));
  ceil.rotation.x = Math.PI / 2; ceil.position.set(COLS / 2, WALLH, ROWS / 2);
  roomGroup.add(ceil); ceilMesh = ceil;
  sput(roomGroup, 'door', { x: COLS - 1.3, z: ROWS, ry: Math.PI }); // 房門(在前牆上,純裝飾)
  // 天花板吊燈:燈罩的亮度跟著時段變(白天沒開、黃昏亮起、深夜關掉)
  pendantMat = new THREE.MeshBasicMaterial({ color: MOODS[mood].pend });
  sput(roomGroup, 'pendant', { x: COLS / 2, y: WALLH, z: ROWS / 2 + 0.3 }).traverse((o) => { if (o.isMesh && o.material.name === 'shade') { o.material = pendantMat; o.castShadow = false; } });
  floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(COLS, ROWS), new THREE.MeshLambertMaterial({ emissive: '#ffffff', emissiveIntensity: 0.1 }));
  floorMesh.rotation.x = -Math.PI / 2; floorMesh.position.set(COLS / 2, 0, ROWS / 2); floorMesh.receiveShadow = true;
  roomGroup.add(floorMesh);
  const pts = [];
  for (let q = 0; q <= COLS; q++) pts.push(q, 0.02, 0, q, 0.02, ROWS);
  for (let r = 0; r <= ROWS; r++) pts.push(0, 0.02, r, COLS, 0.02, r);
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
  if (!room || !modelsLoaded) return;
  if (!floorMesh) buildShell();
  // 牆和地板帶一點自發光,背光的那幾面才不會灰暗
  for (const w of wallPlanes) { w.material.map = w.material.emissiveMap = wallTex(room.wall, w.userData.width); w.material.needsUpdate = true; }
  floorMesh.material.map = floorMesh.material.emissiveMap = floorTex(room.floor); floorMesh.material.needsUpdate = true;
  itemsGroup.clear(); anims = [];
  computeSeats(); assignSeats(); computeBlocked();
  let lamps = 0;
  lampLights = []; glowLights = []; neonLights = []; beamLights = [];
  for (const it of room.items) {
    if (!CATALOG[it.type]) continue;
    let opt, face = rotOf(it.r) * Math.PI / 2;
    if (it.type === 'kdesk') { // 工作桌的抽屜面朝向椅子
      const st = seats.find((q) => q.desk === it.id);
      if (st) opt = { side: toLocal(it, st.x, st.z)[1] > 0.5 ? 1 : -1 };
    }
    if (it.c) opt = { ...opt, c: it.c };
    const inner = buildItem(it.type, opt);
    const st = seats.find((q) => q.id === it.id && !q.sofa);
    if (st) { face = st.face; if (st.desk != null) inner.position.z += ITEMS[it.type].pull || CHAIR_FWD; } // 椅子自動轉向它面對的桌子,並往桌子拉近
    if (inner.userData.lampAt && lamps++ < [5, 5, 3, 2][qLevel]) { // 畫質越低,會發光的燈越少(燈是最吃效能的東西)
      // 衰減放緩,燈旁邊才不會整片過曝
      const l = new THREE.PointLight(0xffb866, MOODS[mood].lamp, 4.2, 1.0);
      l.position.copy(inner.userData.lampAt); inner.add(l);
      l.userData.k = CATALOG[it.type].kind === 'top' ? 0.5 : 1; // 檯燈離桌面和人很近,亮度減半
      lampLights.push(l);
    }
    if (inner.userData.neonAt && neonLights.length < [2, 2, 1, 0][qLevel]) { const l = new THREE.PointLight(0xff6fa8, MOODS[mood].neon, 4, 1.4); l.position.copy(inner.userData.neonAt); inner.add(l); neonLights.push(l); }
    if (inner.userData.glowAt && glowLights.length < [3, 3, 1, 0][qLevel]) { // 螢幕的藍光
      const l = new THREE.PointLight(0x8fc0ff, MOODS[mood].glow, 3.2, 1.2); l.position.copy(inner.userData.glowAt); inner.add(l);
      glowLights.push(l);
    }
    if (it.type === 'window' && beamLights.length < 1) { // 從窗戶斜照進來的光:白天是陽光,夜晚是月光
      const l = new THREE.SpotLight(MOODS[mood].beam[0], MOODS[mood].beam[1], 7, 0.62, 0.75, 1.0);
      l.position.set(1, 2.1, 0.15); l.target.position.set(1.5, 0, 3.0);
      inner.add(l, l.target); beamLights.push(l);
    }
    if (inner.userData.anim) anims.push(inner.userData.anim);
    if (inner.userData.cat) { anims.push(catAnim(it, inner.userData.cat)); face = 0; } // 貓自己決定面向
    const g = wrapItem(inner, it.type, face);
    itemPos(g, it.type, it.x, it.y);
    if (CATALOG[it.type].kind === 'top') { const [tw, th2] = dimsOf(it.type, it.r); g.position.y = surfAt(it.x + tw / 2, it.y + th2 / 2); }
    g.userData.itemId = it.id;
    itemsGroup.add(g);
  }
  for (const l of lampLights) l.intensity = lampLevel() * l.userData.k;
  for (const id of catState.keys()) if (!room.items.some((q) => q.id === id && q.type === 'cat')) catState.delete(id);
  itemsGroup.updateMatrixWorld(true);
  camBlocks = itemsGroup.children.filter((g) => { const it = room.items.find((q) => q.id === g.userData.itemId); return it && CATALOG[it.type].kind === 'floor' && it.type !== 'cat'; })
    .map((g) => new THREE.Box3().setFromObject(g)).filter((bx) => bx.max.y > 0.9); // 矮的家具鏡頭看得過去,不用管
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
// ---------- 畫質:自動模式會量每秒幾格,太卡就一級一級往下降 ----------
// 0 全開 → 1 解析度降一點 → 2 再降並關掉柔光 → 3 連陰影也關掉
let qPref = ['auto', 'high', 'low'].includes(store.get('yoyo_quality')) ? store.get('yoyo_quality') : 'auto';
let qLevel = qPref === 'low' ? 2 : 0, fpsN = 0, fpsT0 = 0, slowRuns = 0, qTold = false;
function applyQuality() {
  const dpr = window.devicePixelRatio || 1, sh = LIGHTS.sun.shadow, size = qLevel === 0 ? 2048 : 1024;
  renderer.setPixelRatio(Math.min([2, 1.5, 1, 1][qLevel], dpr));
  LIGHTS.sun.castShadow = qLevel < 3;
  if (sh.mapSize.x !== size) { sh.mapSize.set(size, size); sh.map?.dispose(); sh.map = null; }
  if (composer) { composer.dispose?.(); composer = null; }
  fitCamera();
  if (room && modelsLoaded) rebuildRoom(); // 燈的數量跟著畫質調整
}
function measureFps(t) {
  if (qPref !== 'auto' || qLevel >= 3 || document.hidden || !modelsLoaded) { fpsT0 = 0; return; }
  if (!fpsT0) { fpsT0 = t + 4000; fpsN = 0; return; } // 剛載入或剛調整完,先等幾秒再量
  if (t < fpsT0) return;
  fpsN++;
  if (t - fpsT0 < 3000) return;
  const fps = (fpsN * 1000) / (t - fpsT0);
  fpsT0 = t; fpsN = 0;
  slowRuns = fps < 22 ? slowRuns + 1 : 0;
  if (slowRuns < 2) return; // 連續兩次都慢才降,避免偶爾卡一下就降畫質
  slowRuns = 0; qLevel++; fpsT0 = 0;
  applyQuality();
  if (!qTold) { qTold = true; toast('畫面有點卡,已自動調低畫質(可在設定調整)'); }
}
let fxOn = store.get('yoyo_fx') !== '0', composer = null, bloom = null;
function setupFx() {
  if (composer) { composer.dispose?.(); composer = null; }
  if (!fxOn || qLevel >= 2) return;
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
const camDir = new THREE.Vector3(), camRay = new THREE.Ray(), camHit = new THREE.Vector3();
let camBlocks = []; // 會擋住鏡頭的家具外框(每次重建房間時更新)
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
  // 角色和鏡頭之間有家具(書櫃、立燈、冰箱…)時,把鏡頭拉到家具前面,才不會鑽進家具裡或被擋住
  camRay.origin.copy(T); camRay.direction.copy(camDir);
  for (const bx of camBlocks) {
    if (bx.containsPoint(T)) continue; // 目標本身就在這件家具的範圍裡(例如坐著的椅子)
    if (camRay.intersectBox(bx, camHit)) { const hd = camHit.distanceTo(T); if (hd < d) d = Math.max(0.9, hd - 0.15); }
  }
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
thumb.setSize(512, 512, false);
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
let previewSeq = 0, previewTimer = 0;
function renderAvatarPreview() {
  if (!draft) return;
  const seq = ++previewSeq; // 只畫最後一次選擇
  buildAvatar(draft.avatar, (g) => {
    if (seq === previewSeq) {
      const cv = $('#avatarPreview'), c2 = cv.getContext('2d');
      thumbScene.add(g);
      // 半身:臉和配件看得清楚,上衣顏色也看得到
      const cy = g.userData.tall - 0.45; // 以頭頂的高度為準,高矮、頭大頭小都框得到臉
      thumbCam.position.set(0, cy, 0).addScaledVector(FRONT_DIR, 20); thumbCam.lookAt(0, cy, 0);
      Object.assign(thumbCam, { left: -0.62, right: 0.62, top: 0.62, bottom: -0.62 }); thumbCam.updateProjectionMatrix();
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
// 省電:沒有在操作時每秒只畫約 30 格(專注時畫面會開好幾個小時);拖曳、點擊、打字的時候恢復全速
let activeUntil = 0;
const poke = () => { activeUntil = performance.now() + 2500; };
for (const ev of ['pointerdown', 'pointermove', 'wheel', 'keydown', 'touchstart']) window.addEventListener(ev, poke, { passive: true });
function frame(t) {
  requestAnimationFrame(frame);
  if (t >= activeUntil && t - lastT < 31) return;
  const dt = Math.min(0.1, (t - lastT) / 1000); lastT = t;
  if (!room || !floorMesh) return;
  for (const a of anims) a(t);
  updateCamera(dt, t);
  const sw = stage.clientWidth, sh = stage.clientHeight;
  for (const p of players.values()) {
    if (!p.obj) continue;
    // 專注時走向分配到的椅子;沒有空椅子就在原地坐自己的小凳子
    const gx = p.seat ? p.seat.x : p.tx, gy = p.seat ? p.seat.z : p.ty;
    if (!p.dest || p.dest[0] !== gx || p.dest[1] !== gy) { // 目的地變了:找一條繞過家具的路
      p.dest = [gx, gy];
      p.path = Math.hypot(gx - p.x, gy - p.y) > 0.02 ? findPath(p.x, p.y, gx, gy) : [];
    }
    let walking = false, dx = 0, dy = 0;
    if (p.path.length) {
      const [wx, wy] = p.path[0], step = 2.1 * dt;
      dx = wx - p.x; dy = wy - p.y;
      const d = Math.hypot(dx, dy);
      if (d <= step) { p.x = wx; p.y = wy; p.path.shift(); } else { p.x += (dx / d) * step; p.y += (dy / d) * step; }
      walking = true;
    }
    const f = p.focus && (p.focus.mode === 'up' || p.focus.endAt > t) ? p.focus : null;
    const sitting = !!f && f.phase === 'focus' && p.pose !== 1 && !walking;
    const want = walking ? (Math.hypot(dx, dy) > 1e-4 ? Math.atan2(dx, dy) : p.obj.rotation.y) : sitting && p.seat ? p.seat.face : p.id === me && activeView === 'desk' ? camGoal.yaw : 0.35; // 桌前視角下,站著時轉向鏡頭
    let diff = want - p.obj.rotation.y;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    p.obj.rotation.y += diff * Math.min(1, dt * 12);
    p.heading = p.obj.rotation.y;
    if (p.stretchPending && !walking && !sitting) { p.stretchPending = false; p.stretchUntil = t + 4200; }
    const fwd = sitting && p.seat ? p.seat.fwd + (p.obj.userData.sitFwd || 0) : 0;
    p.sit = (p.sit || 0) + (fwd - (p.sit || 0)) * Math.min(1, dt * 8);
    p.obj.position.set(p.x + Math.sin(p.obj.rotation.y) * p.sit, 0, p.y + Math.cos(p.obj.rotation.y) * p.sit);
    poseAvatar(p.obj, dt, { walking, sitting, pose: p.pose, waving: p.waveUntil > t, happy: p.happyUntil > t, stretching: p.stretchUntil > t, noDesk: !p.seat || p.seat.desk == null, cheering: p.cheerUntil > t, seatH: p.seat?.h, ownStool: !p.seat, t });
    const tall = p.obj.userData.tall || AVATAR_H; // 名字標籤跟著角色的實際高度
    p.labelY = (p.labelY || tall) + ((sitting ? tall - 0.36 : tall) - (p.labelY || tall)) * Math.min(1, dt * 6);
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
      if (d.kind === 'top') { const [tw, th2] = dimsOf(holding.type, holding.r); ghost.position.y = surfAt(hover.x + tw / 2, hover.y + th2 / 2); }
      const ok = canPlace(holding.type, hover.x, hover.y, holding.r, holding.fromId), [gw, gh] = dimsOf(holding.type, holding.r);
      ghostPad.material.color.set(ok ? '#8fe08a' : '#ff7d88');
      if (d.kind === 'wall') { ghostPad.rotation.set(0, 0, 0); ghostPad.scale.set(d.w, WALLH - 0.25, 1); ghostPad.position.set(hover.x + d.w / 2, WALLH / 2 + 0.125, 0.015); }
      else { ghostPad.rotation.set(-Math.PI / 2, 0, 0); ghostPad.scale.set(gw, gh, 1); ghostPad.position.set(hover.x + gw / 2, 0.05, hover.y + gh / 2); }
    }
  }
  if (composer) composer.render(); else renderer.render(scene, camera);
  if (photoJob && t >= photoJob.at) { const j = photoJob; photoJob = null; composePhoto(j); }
  tickTimer(t);
  measureFps(t);
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
  if (d.kind === 'top') { // 小物:以四分之一格為單位,可以擺得很近
    const q = (v, size, max) => Math.min(max - size, Math.max(0, Math.round((v - size / 2) * 4) / 4));
    return { x: q(pt.x, w, COLS), y: q(pt.z, h, ROWS) };
  }
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
  [p.tx, p.ty] = nearestFree(Math.min(COLS - 0.3, Math.max(0.3, pt.x)), Math.min(ROWS - 0.25, Math.max(0.25, pt.z)));
  send({ t: 'move', x: p.tx, y: p.ty });
});
window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') { // 依序關掉:手上的家具 → 照片 → 面板
    if (holding) setHolding(null); else if (!$('#photo').hidden) $('#photo').hidden = true; else if (currentTab) openTab(null);
  }
  const typing = /INPUT|TEXTAREA/.test(document.activeElement?.tagName || '');
  if ((ev.key === 'r' || ev.key === 'R') && holding && !typing) rotateHolding();
  if ((ev.key === 'c' || ev.key === 'C') && holding && !typing) tintHolding();
});
const canTint = (type) => !!RUGS[type] || !!(ITEMS[type] && STINT[ITEMS[type].m]);
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
// 分頁在背景時畫面不會更新,另外每秒跑一次,分頁標題上的時間才會繼續走
setInterval(() => { if (document.hidden) tickTimer(performance.now()); }, 1000);
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
  try { if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission(); } catch {}
  send({ t: 'focus_start', mode: timerMode, minutes: timerMode === 'pomo' ? num('#pomoFocus', 1, 180, 25) : selectedMin, breakMin: num('#pomoBreak', 1, 60, 5) });
});
// 狀態文字與專注姿勢
let statusTimer = 0;
$('#statusInput').addEventListener('input', (ev) => {
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => { send({ t: 'status', text: ev.target.value }); saveBackup(); }, 400);
});
$('#poses').addEventListener('click', (ev) => { const b = ev.target.closest('button'); if (b) { setPose(+b.dataset.pose); send({ t: 'status', pose: +b.dataset.pose }); saveBackup(); } });
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
function saveTodos() { renderTodos(); send({ t: 'todos', list: todos }); saveBackup(); }
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
function saveHabits() { renderHabits(); send({ t: 'habits', list: habits }); saveBackup(); }
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
  photoJob = { at: performance.now() + 2600, ids: m.done.map((d) => d.id), title: '共同專注完成,來張合照!', caption: `${m.done.length} 人共同專注 ${m.minutes} 分鐘` };
}
// 隨時拍一張:照目前的鏡頭角度,把房間和大家的名字存成圖片
$('#snapBtn').addEventListener('click', () => {
  if (!room || photoJob) return;
  const f = myFocus(), n = players.size;
  photoJob = { at: performance.now(), ids: [...players.keys()], keepView: true, title: '拍好了',
    caption: f && f.phase === 'focus' ? (n > 1 ? `${n} 人一起專注中` : '專注中') : n > 1 ? `${n} 人的自習室` : '我的自習室' };
});
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
      tmpV.set(p.x, (p.obj?.userData.tall || AVATAR_H) + 0.22, p.y).project(camera);
      const x = ((tmpV.x + 1) / 2) * W, y = ((1 - tmpV.y) / 2) * H, w = c.measureText(p.name).width + 20 * k, h = 22 * k;
      c.fillStyle = 'rgba(23,26,51,.72)'; c.beginPath(); c.roundRect(x - w / 2, y - h / 2, w, h, h / 2); c.fill();
      c.fillStyle = '#fff'; c.fillText(p.name, x, y + k);
    }
    const d = new Date();
    c.textAlign = 'left'; c.font = `700 ${22 * k}px system-ui, "PingFang TC", "Noto Sans TC", sans-serif`;
    c.fillStyle = '#ffc98a'; c.fillText('☾ 悠悠自習室', 24 * k, H - 56 * k);
    c.font = `${16 * k}px system-ui, "PingFang TC", "Noto Sans TC", sans-serif`; c.fillStyle = '#f6efe6';
    c.fillText(`${job.caption} · ${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`, 24 * k, H - 26 * k);
    $('#photoTitle').textContent = job.title;
    const url = cv.toDataURL('image/jpeg', 0.9);
    $('#photoImg').src = url; $('#photoSave').href = url;
    $('#photo').hidden = false;
  } catch (e) { console.error(e); }
  if (!job.keepView) setView(view); // 合照時鏡頭拉到全景,拍完回到原本的視角
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
// 角色選項。三種列:色票(固定選項)、hex(預設色 + 自己挑顏色)、range(滑桿)
const HAIR_PRESETS = ['#3a3040', '#7a5238', '#c58a4a', '#f2cf7a', '#f29ab0', '#8ea4ee', '#eeeaf4'];
const EYE_PRESETS = ['#6a4630', '#3f6fb5', '#3f9d6b', '#8a5fc9', '#d0586a', '#e0a23a', '#7f8794'];
const TOP_PRESETS = ['#f08d94', '#ffc98a', '#9ed59a', '#7cc3d6', '#8c9cea', '#c09ae0', '#fbf6ec', '#56506e'];
const BOTTOM_PRESETS = ['#3b3a4a', '#5d5f86', '#8a6f5a', '#f3ede2', '#7fa2e6', '#e7a3b4', '#9fc7a3'];
function buildAvatarOptions() {
  const a = draft.avatar, set = (patch) => { Object.assign(a, patch); buildAvatarOptions(); pushProfile(); };
  const pick = (title, key, opts) => [el('h3', { textContent: title }), el('div', { className: 'swatches' }, ...opts.map((o, i) => {
    const b = el('button', { type: 'button', className: (a[key] || 0) === i ? 'on' : '', textContent: o.text || '', title: o.text || `${title} ${i + 1}` });
    if (o.color) b.style.background = o.color; else b.classList.add('txt');
    b.onclick = () => set({ [key]: i });
    return b;
  }))];
  const hex = (title, key, legacy, presets) => {
    const cur = a[key] || '', custom = cur && !presets.includes(cur);
    const none = el('button', { type: 'button', className: 'txt' + (!cur && !(legacy && a[legacy]) ? ' on' : ''), textContent: '原色' });
    none.onclick = () => set({ [key]: '', ...(legacy ? { [legacy]: 0 } : {}) });
    const inp = el('input', { type: 'color', value: cur || presets[0], title: '自己挑顏色', ariaLabel: `${title}:自己挑顏色`, className: custom ? 'on' : '' });
    inp.onchange = () => set({ [key]: inp.value.toLowerCase(), ...(legacy ? { [legacy]: 0 } : {}) });
    return [el('h3', { textContent: title }), el('div', { className: 'swatches' }, none, ...presets.map((c) => {
      const b = el('button', { type: 'button', className: cur === c ? 'on' : '', title: c });
      b.style.background = c;
      b.onclick = () => set({ [key]: c, ...(legacy ? { [legacy]: 0 } : {}) });
      return b;
    }), inp)];
  };
  const range = (title, key, def, fmt) => {
    const val = a[key] ?? def, out = el('span', { textContent: fmt(val) });
    const inp = el('input', { type: 'range', min: 0, max: 8, step: 1, value: val, ariaLabel: title });
    inp.oninput = () => { out.textContent = fmt(+inp.value); };
    inp.onchange = () => set({ [key]: +inp.value });
    return [el('h3', { textContent: title }), el('div', { className: 'slider' }, inp, out)];
  };
  $('#avatarOptions').replaceChildren(
    ...pick('造型', 'hair', LOOK_NAMES.map((n) => ({ text: n }))),
    ...range('頭的大小', 'headSize', 0, (v) => (v ? `${100 + v * 6}%` : '原本')),
    ...range('身高', 'height', 4, (v) => (v === 4 ? '原本' : `${Math.round((0.9 + v * 0.025) * 100)}%`)),
    ...pick('表情', 'face', [{ text: '自然' }, { text: '微笑' }, { text: '放鬆' }]),
    ...pick('膚色', 'skin', SKIN.map((c, i) => (i ? { color: c } : { text: '原色' }))),
    ...hex('髮色', 'hairHex', 'hairColor', HAIR_PRESETS),
    ...hex('瞳色', 'eyeHex', null, EYE_PRESETS),
    ...hex('上衣', 'topHex', 'shirt', TOP_PRESETS),
    ...hex('下身(褲子或裙子)', 'bottomHex', null, BOTTOM_PRESETS),
    ...pick('頭飾', 'acc', ACCS.map((k) => ({ text: k ? k.name : '無' }))),
    ...pick('眼鏡', 'glasses', [{ text: '不戴' }, { text: '戴上' }]),
    ...pick('頭飾顏色', 'accColor', FABRICS.map((c) => (c ? { color: c } : { text: '原色' }))),
  );
  clearTimeout(previewTimer); previewTimer = setTimeout(renderAvatarPreview, 220); // 連續調整時只重建一次
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
function refreshQualityUI() { document.querySelectorAll('#quality button').forEach((x) => x.classList.toggle('on', x.dataset.q === qPref)); }
$('#quality').addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  qPref = b.dataset.q; store.set('yoyo_quality', qPref);
  qLevel = qPref === 'low' ? 2 : 0; fpsT0 = 0; slowRuns = 0;
  refreshQualityUI(); applyQuality();
});
refreshQualityUI();
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
    if (stop) { stop(); gain.disconnect(); stop = null; btn.classList.remove('on'); if (key === 'rain') setRain(false); return; }
    ac = ac || new AudioContext();
    ac.resume();
    gain = ac.createGain(); gain.gain.value = vol.value / 100; gain.connect(ac.destination);
    stop = s.make(gain);
    if (key === 'rain') setRain(true);
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
].map(([f, t, al, sec]) => ({ t, al, sec, url: `/assets/music/${f}.mp3` }));
const audio = new Audio();
audio.preload = 'none';
let trackIdx = Math.min(TRACKS.length - 1, Math.max(0, +store.get('yoyo_track') || 0)), shuffle = store.get('yoyo_shuffle') === '1', seeking = false, loaded = -1;
audio.volume = Math.min(1, Math.max(0, (+(store.get('yoyo_mvol') ?? 60)) / 100));
$('#mVol').value = Math.round(audio.volume * 100);
function refreshPlayer() {
  const tr = TRACKS[trackIdx], on = !audio.paused;
  $('#npTitle').textContent = loaded < 0 ? '選一首開始播放' : tr.t;
  $('#npSub').textContent = loaded < 0 ? `lo-fi 音樂 · ${TRACKS.length} 首` : tr.mine ? '我的音樂' : `HoliznaCC0 · ${tr.al}`;
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
  if (loaded !== trackIdx) { audio.src = TRACKS[trackIdx].url; loaded = trackIdx; $('#mSeek').value = 0; }
  audio.play().catch(() => toast('這首歌暫時無法播放,請再按一次播放'));
  if ('mediaSession' in navigator) navigator.mediaSession.metadata = new MediaMetadata({ title: TRACKS[trackIdx].t, artist: TRACKS[trackIdx].mine ? '我的音樂' : 'HoliznaCC0', album: TRACKS[trackIdx].al });
  refreshPlayer();
}
const nextTrack = () => playTrack(shuffle && TRACKS.length > 1 ? (trackIdx + 1 + Math.floor(Math.random() * (TRACKS.length - 1))) % TRACKS.length : trackIdx + 1);
const prevTrack = () => (audio.currentTime > 4 ? ((audio.currentTime = 0), audio.play()) : playTrack(trackIdx - 1));
const togglePlay = () => (loaded < 0 || audio.paused ? playTrack(trackIdx) : audio.pause());
function renderTracks() {
  $('#trackList').replaceChildren(...TRACKS.map((tr, i) => {
    const li = el('li', { tabIndex: 0, role: 'button' }, el('span', { textContent: tr.t }), el('span', { textContent: tr.sec ? mmss(tr.sec) : '我的' }));
    li.onclick = () => playTrack(i);
    li.onkeydown = (ev) => { if (ev.key === 'Enter' || ev.key === ' ') { ev.preventDefault(); playTrack(i); } };
    return li;
  }));
  refreshPlayer();
}
// 加入自己的音樂:檔案只在這台裝置上播放,不會上傳;重新整理後要再加一次
$('#addMusic').addEventListener('click', () => $('#musicFile').click());
$('#musicFile').addEventListener('change', (ev) => {
  const files = [...ev.target.files].filter((f) => f.type.startsWith('audio/') || /\.(mp3|m4a|aac|ogg|oga|opus|wav|flac)$/i.test(f.name));
  if (!files.length) return toast('沒有可以播放的音樂檔');
  const first = TRACKS.length;
  for (const f of files.slice(0, 50)) TRACKS.push({ t: f.name.replace(/\.[^.]+$/, '').slice(0, 60), al: '', sec: 0, url: URL.createObjectURL(f), mine: true });
  ev.target.value = '';
  renderTracks();
  toast(`加入了 ${Math.min(50, files.length)} 首`);
  playTrack(first);
});
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
renderTracks();

function setRain(v) { raining = v; if (room && modelsLoaded) rebuildRoom(); }
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

applyQuality();
$('#tipsOk').addEventListener('click', () => { $('#tips').hidden = true; store.set('yoyo_tips', '1'); });
window.__booted = true;
connect();
tickClock();
requestAnimationFrame(frame);
})();
