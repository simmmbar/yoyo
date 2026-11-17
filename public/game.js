/* 悠悠自習室 — 前端 */
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
const W = 720, H = 560, WALL = 140, T = 60;
let COLS = 12, ROWS = 7, CATALOG = {};
const SKIN = ['#fde0c8', '#f5c9a6', '#e0a67c', '#b97a50', '#7d4f33'];
const HAIRC = ['#2b2320', '#5a3a22', '#a8672e', '#e3b54b', '#c44d6a', '#5b7bd6', '#e9e9ef'];
const SHIRT = ['#e2727b', '#f4b860', '#8fcf8a', '#62b6cb', '#7d8ce0', '#b784d6', '#f2f0ea', '#4a4660'];
const HAIR_NAMES = ['短髮', '鮑伯', '長髮', '丸子', '刺蝟'];
const ACC_NAMES = ['無', '眼鏡', '耳機', '毛帽', '貓耳'];
const WALLS = [['#e9d8c4', '#b89a7c'], ['#cfe0d8', '#8fb0a2'], ['#d9d3ea', '#a297c4'], ['#f1cfc9', '#c98f8a'], ['#cddcec', '#8aa5c2'], ['#4a4660', '#2f2c40']];
const FLOORS = [['#c79a6b', '#b98b5d'], ['#a8794f', '#996c44'], ['#d9c7a8', '#cbb894'], ['#8f9bb0', '#828ea4'], ['#b7c9a4', '#a9bc95'], ['#6b5a6e', '#5e4e61']];

// ---------- 狀態 ----------
let ws, me = null, profile = null, room = null, kicked = false;
const players = new Map();
let holding = null; // 佈置中手上拿的家具 {type, fromId?}
let hover = null;   // 滑鼠所在格
let localFocusEnd = 0, selectedMin = 25;
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
  const o = old || { x: p.x, y: p.y, bubble: null, emote: null, face: 1 };
  Object.assign(o, { id: p.id, name: p.name, avatar: p.avatar, tx: p.x, ty: p.y, totalMinutes: p.totalMinutes });
  o.focusEnd = p.focusLeft != null ? performance.now() + p.focusLeft : 0;
  players.set(p.id, o);
  if (p.id === me) localFocusEnd = o.focusEnd;
}

const on = {
  init(m) {
    me = m.me; CATALOG = m.catalog; COLS = m.cols; ROWS = m.rows;
    room = m.room;
    players.clear();
    m.players.forEach(addPlayer);
    setProfile(m.profile, true);
    $('#overlay').hidden = true;
    $('#roomCode').textContent = room.code;
    $('#goHome').hidden = room.mine;
    if (!new URLSearchParams(location.search).get('room') || m.notice) {
      history.replaceState(null, '', '?room=' + room.code);
    }
    buildEmotes(m.emotes);
    buildCatalog();
    refreshRoomUI();
    refreshMembers();
    sysLog(room.mine ? '歡迎回到你的房間 ✨' : `你來到了 ${room.ownerName || '朋友'} 的房間`);
    if (m.notice) toast(m.notice);
  },
  join(m) { addPlayer(m.p); sysLog(`${m.p.name} 進來了`); refreshMembers(); },
  leave(m) {
    const p = players.get(m.id);
    if (p) sysLog(`${p.name} 離開了`);
    players.delete(m.id);
    refreshMembers();
  },
  move(m) { const p = players.get(m.id); if (p) { p.tx = m.x; p.ty = m.y; } },
  pupdate(m) { addPlayer(m.p); refreshMembers(); refreshTimer(); },
  chat(m) {
    const p = players.get(m.id);
    if (p) p.bubble = { text: m.text, until: performance.now() + 5500 };
    const log = $('#chatLog');
    log.append(el('div', {}, el('b', { textContent: m.name + ' ' }), m.text));
    log.scrollTop = log.scrollHeight;
  },
  emote(m) { const p = players.get(m.id); if (p) p.emote = { e: m.e, start: performance.now() }; },
  room(m) {
    Object.assign(room, m.room);
    if (holding?.fromId && !room.items.some((i) => i.id === holding.fromId)) setHolding(null);
    if (!canEdit()) setHolding(null);
    refreshRoomUI();
  },
  profile(m) { setProfile(m.profile); },
  focus_done(m) {
    toast(`🎉 專注 ${m.minutes} 分鐘完成!+${m.coins} 🪙`);
    chime();
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
const owns = (type) => CATALOG[type].price === 0 || profile.owned.includes(type);

// ---------- 繪圖工具 ----------
const canvas = $('#game');
const ctx = canvas.getContext('2d');
const dpr = Math.min(2, window.devicePixelRatio || 1);
canvas.width = W * dpr; canvas.height = H * dpr;

function rr(c, x, y, w, h, r, fill, stroke) {
  c.beginPath();
  c.roundRect(x, y, w, h, r);
  if (fill) { c.fillStyle = fill; c.fill(); }
  if (stroke) { c.strokeStyle = stroke; c.lineWidth = 2; c.stroke(); }
}
function circ(c, x, y, r, fill) { c.beginPath(); c.arc(x, y, r, 0, 7); c.fillStyle = fill; c.fill(); }
function oval(c, x, y, rx, ry, fill) { c.beginPath(); c.ellipse(x, y, rx, ry, 0, 0, 7); c.fillStyle = fill; c.fill(); }
function shadow(c, x, y, rx, ry) { oval(c, x, y, rx, ry, 'rgba(40,25,30,.18)'); }

// 家具繪製:(x, y) 為佔地左上角像素;牆面物件的 y 為牆頂
const DRAW = {
  desk(c, x, y) {
    shadow(c, x + 60, y + 54, 56, 7);
    rr(c, x + 10, y + 30, 7, 24, 2, '#8a5a34'); rr(c, x + 103, y + 30, 7, 24, 2, '#8a5a34');
    rr(c, x + 4, y + 24, 112, 12, 4, '#a9713f');
    rr(c, x + 4, y - 14, 112, 42, 6, '#cf9a63');
    rr(c, x + 44, y - 26, 34, 24, 3, '#3b3a4a'); rr(c, x + 47, y - 23, 28, 18, 2, '#9fd3e6');
    rr(c, x + 40, y + 2, 42, 14, 3, '#d9d6e2');
    circ(c, x + 98, y + 6, 7, '#f2f0ea'); circ(c, x + 98, y + 6, 4.5, '#7a4b2a');
    rr(c, x + 12, y - 4, 20, 26, 2, '#f7f3e8'); rr(c, x + 15, y, 14, 2, 1, '#c8c2b4'); rr(c, x + 15, y + 5, 14, 2, 1, '#c8c2b4');
  },
  chair(c, x, y) {
    shadow(c, x + 30, y + 52, 20, 5);
    rr(c, x + 16, y + 36, 5, 16, 2, '#7a5233'); rr(c, x + 39, y + 36, 5, 16, 2, '#7a5233');
    rr(c, x + 13, y + 20, 34, 20, 6, '#e08e6d');
    rr(c, x + 13, y - 8, 34, 32, 8, '#c9744f');
  },
  plant(c, x, y) {
    shadow(c, x + 30, y + 52, 18, 5);
    for (const [dx, dy, r] of [[-12, 4, 13], [12, 2, 13], [0, -10, 15], [-6, 12, 11], [8, 14, 11]]) circ(c, x + 30 + dx, y + 8 + dy, r, dy < 0 ? '#6fb56a' : '#5aa457');
    c.beginPath(); c.moveTo(x + 16, y + 28); c.lineTo(x + 44, y + 28); c.lineTo(x + 40, y + 52); c.lineTo(x + 20, y + 52); c.closePath();
    c.fillStyle = '#d98c5f'; c.fill();
    rr(c, x + 14, y + 25, 32, 7, 3, '#e7a074');
  },
  tree(c, x, y) {
    shadow(c, x + 30, y + 52, 20, 5);
    rr(c, x + 27, y - 20, 6, 54, 3, '#7a5233');
    for (const [dx, dy, r] of [[-16, -24, 17], [16, -26, 17], [0, -44, 20], [-10, -8, 13], [12, -6, 13]]) circ(c, x + 30 + dx, y + dy, r, dy < -30 ? '#4f9d6a' : '#3f8a5a');
    rr(c, x + 16, y + 30, 28, 22, 5, '#ece6da'); rr(c, x + 16, y + 30, 28, 6, 3, '#d6cfc0');
  },
  rug(c, x, y) {
    rr(c, x + 6, y + 6, 168, 108, 16, '#d9818a');
    rr(c, x + 16, y + 16, 148, 88, 10, null, '#f6d7c4');
    rr(c, x + 30, y + 30, 120, 60, 8, '#e59aa0');
  },
  lamp(c, x, y, t) {
    const g = c.createRadialGradient(x + 30, y - 24, 4, x + 30, y - 24, 70);
    g.addColorStop(0, 'rgba(255,225,150,.38)'); g.addColorStop(1, 'rgba(255,225,150,0)');
    c.fillStyle = g; c.fillRect(x - 40, y - 94, 140, 140);
    shadow(c, x + 30, y + 52, 14, 4);
    oval(c, x + 30, y + 50, 12, 4, '#5b5670');
    rr(c, x + 28, y - 18, 4, 68, 2, '#5b5670');
    c.beginPath(); c.moveTo(x + 18, y - 40); c.lineTo(x + 42, y - 40); c.lineTo(x + 50, y - 12); c.lineTo(x + 10, y - 12); c.closePath();
    c.fillStyle = '#ffd98a'; c.fill();
  },
  table(c, x, y) {
    shadow(c, x + 30, y + 50, 22, 6);
    rr(c, x + 27, y + 24, 6, 24, 2, '#8a5a34');
    oval(c, x + 30, y + 26, 25, 12, '#a9713f'); oval(c, x + 30, y + 22, 25, 12, '#cf9a63');
    rr(c, x + 22, y + 12, 14, 11, 3, '#f2f0ea'); oval(c, x + 29, y + 13, 6, 2, '#b3763c');
  },
  bookshelf(c, x, y) {
    shadow(c, x + 60, y + 54, 56, 6);
    rr(c, x + 6, y - 64, 108, 118, 5, '#9a6a40');
    const cols = ['#e2727b', '#f4b860', '#62b6cb', '#8fcf8a', '#b784d6', '#f2f0ea', '#7d8ce0'];
    for (let r = 0; r < 3; r++) {
      const sy = y - 56 + r * 36;
      rr(c, x + 12, sy, 96, 30, 2, '#6f4a2b');
      let bx = x + 15, i = r * 3;
      while (bx < x + 96) {
        const bw = 7 + ((i * 5) % 6), bh = 20 + ((i * 7) % 8);
        rr(c, bx, sy + 30 - bh, bw, bh, 1, cols[i % cols.length]);
        bx += bw + 2; i++;
      }
    }
  },
  sofa(c, x, y) {
    shadow(c, x + 60, y + 52, 58, 6);
    rr(c, x + 6, y - 20, 108, 44, 12, '#6f86c9');
    rr(c, x + 2, y + 2, 20, 46, 9, '#7d95d8'); rr(c, x + 98, y + 2, 20, 46, 9, '#7d95d8');
    rr(c, x + 18, y + 10, 84, 38, 8, '#8ea5e4');
    rr(c, x + 58, y + 10, 2, 30, 1, '#6f86c9');
    rr(c, x + 24, y - 6, 22, 22, 6, '#f4b860');
  },
  bed(c, x, y) {
    shadow(c, x + 30, y + 114, 30, 5);
    rr(c, x + 3, y - 4, 54, 118, 7, '#9a6a40');
    rr(c, x + 1, y - 22, 58, 26, 7, '#8a5a34');
    rr(c, x + 6, y, 48, 110, 6, '#f7f3e8');
    rr(c, x + 12, y + 4, 36, 22, 8, '#ffffff', '#e4dfd2');
    rr(c, x + 6, y + 34, 48, 76, 6, '#8fb7d9');
    rr(c, x + 6, y + 34, 48, 12, 5, '#b4d2ea');
  },
  aquarium(c, x, y, t) {
    shadow(c, x + 30, y + 52, 24, 5);
    rr(c, x + 6, y + 22, 48, 30, 4, '#5b5670');
    rr(c, x + 5, y - 22, 50, 46, 6, '#8fd3e8');
    rr(c, x + 5, y + 14, 50, 10, 4, '#e6d3a3');
    for (let i = 0; i < 2; i++) {
      const fx = x + 30 + Math.sin(t / 900 + i * 2.4) * 15, fy = y - 8 + i * 12;
      const dir = Math.cos(t / 900 + i * 2.4) > 0 ? 1 : -1;
      oval(c, fx, fy, 6, 3.5, i ? '#f4b860' : '#e2727b');
      c.beginPath(); c.moveTo(fx - dir * 5, fy); c.lineTo(fx - dir * 10, fy - 4); c.lineTo(fx - dir * 10, fy + 4); c.fill();
    }
    circ(c, x + 14, y + 8 - ((t / 40) % 26), 2, 'rgba(255,255,255,.7)');
    rr(c, x + 5, y - 22, 50, 46, 6, null, '#e8f6fb');
  },
  cat(c, x, y, t) {
    shadow(c, x + 30, y + 50, 20, 5);
    c.strokeStyle = '#e8a35c'; c.lineWidth = 6; c.lineCap = 'round';
    c.beginPath(); c.moveTo(x + 44, y + 42); c.quadraticCurveTo(x + 58, y + 40, x + 54 + Math.sin(t / 500) * 4, y + 24); c.stroke();
    oval(c, x + 30, y + 38, 17, 13, '#f0b06a');
    circ(c, x + 26, y + 20, 13, '#f0b06a');
    for (const s of [-1, 1]) {
      c.beginPath(); c.moveTo(x + 26 + s * 12, y + 14); c.lineTo(x + 26 + s * 10, y + 2); c.lineTo(x + 26 + s * 3, y + 10); c.closePath();
      c.fillStyle = '#e8a35c'; c.fill();
    }
    const blink = (t % 4000) < 150;
    c.fillStyle = '#3b2f2a';
    if (blink) { c.fillRect(x + 19, y + 20, 5, 1.5); c.fillRect(x + 28, y + 20, 5, 1.5); }
    else { circ(c, x + 21.5, y + 20, 2, '#3b2f2a'); circ(c, x + 30.5, y + 20, 2, '#3b2f2a'); }
    circ(c, x + 26, y + 25, 1.5, '#d9737a');
    oval(c, x + 30, y + 42, 9, 6, '#fbe3c4');
  },
  window(c, x, y, t) {
    rr(c, x + 10, y + 22, 100, 84, 8, '#fbf7ef');
    const h = new Date().getHours() + new Date().getMinutes() / 60;
    const night = h < 6 || h >= 19, dusk = (h >= 17 && h < 19) || (h >= 6 && h < 7.5);
    const g = c.createLinearGradient(0, y + 28, 0, y + 100);
    if (night) { g.addColorStop(0, '#1d2550'); g.addColorStop(1, '#3c4a86'); }
    else if (dusk) { g.addColorStop(0, '#6b7fc4'); g.addColorStop(1, '#f6b38a'); }
    else { g.addColorStop(0, '#8fd0f2'); g.addColorStop(1, '#d6f0fb'); }
    rr(c, x + 16, y + 28, 88, 72, 4, g);
    if (night) {
      for (const [sx, sy] of [[28, 40], [52, 34], [80, 44], [66, 60], [34, 66], [92, 72]]) {
        c.globalAlpha = .5 + .5 * Math.sin(t / 700 + sx);
        circ(c, x + sx, y + sy, 1.3, '#fff');
      }
      c.globalAlpha = 1;
      circ(c, x + 84, y + 46, 8, '#fdf3c4');
    } else {
      circ(c, x + 82, y + 48, 9, dusk ? '#ffd27a' : '#fff3b0');
      oval(c, x + 40, y + 50, 14, 6, 'rgba(255,255,255,.85)'); oval(c, x + 52, y + 46, 10, 6, 'rgba(255,255,255,.85)');
    }
    rr(c, x + 58, y + 28, 4, 72, 0, '#fbf7ef'); rr(c, x + 16, y + 62, 88, 4, 0, '#fbf7ef');
    rr(c, x + 6, y + 102, 108, 8, 3, '#e9e1d2');
  },
  painting(c, x, y) {
    rr(c, x + 8, y + 32, 44, 54, 4, '#d8a94f');
    rr(c, x + 13, y + 37, 34, 44, 2, '#f6dcae');
    circ(c, x + 37, y + 50, 6, '#f08a5d');
    c.beginPath(); c.moveTo(x + 13, y + 81); c.lineTo(x + 13, y + 68); c.quadraticCurveTo(x + 24, y + 56, x + 34, y + 68); c.quadraticCurveTo(x + 41, y + 62, x + 47, y + 70); c.lineTo(x + 47, y + 81); c.closePath();
    c.fillStyle = '#7fae82'; c.fill();
  },
  clock(c, x, y) {
    circ(c, x + 30, y + 58, 21, '#5b5670'); circ(c, x + 30, y + 58, 17, '#fbf7ef');
    const d = new Date(), hm = d.getHours() % 12 + d.getMinutes() / 60, mm = d.getMinutes() + d.getSeconds() / 60;
    c.strokeStyle = '#3b3a4a'; c.lineCap = 'round';
    for (const [a, len, lw] of [[hm / 12, 8, 3], [mm / 60, 13, 2]]) {
      const ang = a * Math.PI * 2 - Math.PI / 2;
      c.lineWidth = lw; c.beginPath(); c.moveTo(x + 30, y + 58); c.lineTo(x + 30 + Math.cos(ang) * len, y + 58 + Math.sin(ang) * len); c.stroke();
    }
    circ(c, x + 30, y + 58, 2, '#e2727b');
  },
};

function drawAvatar(c, cx, fy, a, opt = {}) {
  const { walking = 0, face = 1, t = 0, focusing = false } = opt;
  const bob = walking ? Math.abs(Math.sin(t / 110)) * 3 : Math.sin(t / 900) * .8;
  const y = fy - bob;
  shadow(c, cx, fy, 15, 5);
  const step = walking ? Math.sin(t / 110) * 4 : 0;
  rr(c, cx - 9, y - 12 + Math.max(0, step) * .5, 7, 12, 3, '#3b3a4a'); rr(c, cx + 2, y - 12 + Math.max(0, -step) * .5, 7, 12, 3, '#3b3a4a');
  rr(c, cx - 13, y - 34, 26, 26, 9, SHIRT[a.shirt]);
  const hy = y - 47, skin = SKIN[a.skin], hc = HAIRC[a.hairColor];
  // 後層頭髮
  if (a.hair === 2) rr(c, cx - 17, hy - 12, 34, 40, 12, hc);
  if (a.hair === 1) rr(c, cx - 17, hy - 12, 34, 30, 12, hc);
  if (a.hair === 3) { circ(c, cx - 14, hy - 15, 7, hc); circ(c, cx + 14, hy - 15, 7, hc); }
  if (a.acc === 4) for (const s of [-1, 1]) {
    c.beginPath(); c.moveTo(cx + s * 14, hy - 8); c.lineTo(cx + s * 12, hy - 24); c.lineTo(cx + s * 3, hy - 14); c.closePath();
    c.fillStyle = hc; c.fill();
  }
  circ(c, cx, hy, 15, skin);
  // 前層頭髮
  c.fillStyle = hc; c.beginPath();
  if (a.hair === 4) {
    c.moveTo(cx - 15, hy - 3);
    for (let i = 0; i <= 5; i++) { c.lineTo(cx - 15 + i * 6 - 3, hy - 22 + (i % 2) * 4); c.lineTo(cx - 15 + i * 6 + 2, hy - 10); }
    c.lineTo(cx + 15, hy - 3); c.arc(cx, hy, 15, -0.2, Math.PI + 0.2, true);
  } else {
    c.arc(cx, hy, 15.5, Math.PI * 1.02, Math.PI * 1.98); c.quadraticCurveTo(cx + 4 * face, hy - 7, cx - 15.5, hy - 1);
  }
  c.fill();
  if (a.acc === 3) { rr(c, cx - 16, hy - 18, 32, 14, 7, '#e2727b'); rr(c, cx - 17, hy - 8, 34, 6, 3, '#f2f0ea'); circ(c, cx, hy - 20, 4, '#f2f0ea'); }
  // 臉
  const ex = face * 2;
  if (focusing && (t % 5000) > 4700) { c.fillStyle = '#3b2f2a'; c.fillRect(cx - 8 + ex, hy + 2, 5, 1.5); c.fillRect(cx + 3 + ex, hy + 2, 5, 1.5); }
  else { circ(c, cx - 5.5 + ex, hy + 2, 2, '#3b2f2a'); circ(c, cx + 5.5 + ex, hy + 2, 2, '#3b2f2a'); }
  circ(c, cx - 9 + ex, hy + 7, 2.5, 'rgba(230,110,120,.35)'); circ(c, cx + 9 + ex, hy + 7, 2.5, 'rgba(230,110,120,.35)');
  if (a.acc === 1) {
    c.strokeStyle = '#3b3a4a'; c.lineWidth = 1.5;
    for (const s of [-1, 1]) { c.beginPath(); c.arc(cx + s * 5.5 + ex, hy + 2, 4.5, 0, 7); c.stroke(); }
    c.beginPath(); c.moveTo(cx - 1 + ex, hy + 2); c.lineTo(cx + 1 + ex, hy + 2); c.stroke();
  }
  if (a.acc === 2) {
    c.strokeStyle = '#3b3a4a'; c.lineWidth = 3; c.beginPath(); c.arc(cx, hy, 16.5, Math.PI * 1.08, Math.PI * 1.92); c.stroke();
    rr(c, cx - 19, hy - 5, 6, 12, 3, '#62b6cb'); rr(c, cx + 13, hy - 5, 6, 12, 3, '#62b6cb');
  }
  if (focusing) { // 手上的書
    rr(c, cx - 12, y - 24, 24, 14, 2, '#f7f3e8', '#8a5a34');
    c.fillStyle = '#8a5a34'; c.fillRect(cx - .75, y - 24, 1.5, 14);
  }
}

function label(c, text, cx, y, bg, fg, bold) {
  c.font = `${bold ? '600 ' : ''}12px system-ui, "PingFang TC", "Noto Sans TC", sans-serif`;
  const w = c.measureText(text).width + 12;
  rr(c, cx - w / 2, y - 9, w, 18, 9, bg);
  c.fillStyle = fg; c.textAlign = 'center'; c.textBaseline = 'middle';
  c.fillText(text, cx, y + .5);
}
const fmt = (ms) => {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
};

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
const itemPx = (it) => {
  const d = CATALOG[it.type];
  return d.kind === 'wall' ? [it.x * T, 0] : [it.x * T, WALL + it.y * T];
};

// ---------- 主迴圈 ----------
let lastT = performance.now();
function frame(t) {
  const dt = Math.min(.1, (t - lastT) / 1000); lastT = t;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!room) { ctx.fillStyle = '#282439'; ctx.fillRect(0, 0, W, H); return requestAnimationFrame(frame); }

  // 牆與地板
  const [wc, wt] = WALLS[room.wall] || WALLS[0], [fa, fb] = FLOORS[room.floor] || FLOORS[0];
  ctx.fillStyle = wc; ctx.fillRect(0, 0, W, WALL);
  ctx.fillStyle = 'rgba(255,255,255,.08)';
  for (let x = 0; x < W; x += 40) ctx.fillRect(x, 0, 20, WALL - 14);
  ctx.fillStyle = wt; ctx.fillRect(0, WALL - 14, W, 14);
  for (let r = 0; r < ROWS; r++) for (let q = 0; q < COLS; q++) {
    ctx.fillStyle = (r + q) % 2 ? fa : fb;
    ctx.fillRect(q * T, WALL + r * T, T, T);
  }
  const sg = ctx.createLinearGradient(0, WALL, 0, WALL + 26);
  sg.addColorStop(0, 'rgba(40,25,30,.22)'); sg.addColorStop(1, 'rgba(40,25,30,0)');
  ctx.fillStyle = sg; ctx.fillRect(0, WALL, W, 26);

  if (holding) { // 佈置格線
    ctx.strokeStyle = 'rgba(255,255,255,.28)'; ctx.lineWidth = 1; ctx.beginPath();
    for (let q = 0; q <= COLS; q++) { ctx.moveTo(q * T, CATALOG[holding.type].kind === 'wall' ? 0 : WALL); ctx.lineTo(q * T, H); }
    for (let r = 0; r <= ROWS; r++) { ctx.moveTo(0, WALL + r * T); ctx.lineTo(W, WALL + r * T); }
    ctx.stroke();
  }

  const drawItem = (it) => {
    const [px, py] = itemPx(it);
    ctx.globalAlpha = holding?.fromId === it.id ? .35 : 1;
    DRAW[it.type]?.(ctx, px, py, t);
    ctx.globalAlpha = 1;
  };
  const kindOf = (it) => CATALOG[it.type]?.kind;
  room.items.filter((i) => kindOf(i) === 'wall').forEach(drawItem);
  room.items.filter((i) => kindOf(i) === 'rug').forEach(drawItem);

  // 移動
  for (const p of players.values()) {
    const dx = p.tx - p.x, dy = p.ty - p.y, d = Math.hypot(dx, dy);
    p.walking = d > .02;
    if (p.walking) {
      const s = Math.min(d, 3.4 * dt);
      p.x += (dx / d) * s; p.y += (dy / d) * s;
      if (Math.abs(dx) > .05) p.face = dx > 0 ? 1 : -1;
    }
  }

  // 依 y 排序繪製家具與角色
  const list = [];
  for (const it of room.items) if (kindOf(it) === 'floor') list.push({ k: it.y + CATALOG[it.type].h - .1, it });
  for (const p of players.values()) list.push({ k: p.y, p });
  list.sort((a, b) => a.k - b.k);
  for (const o of list) {
    if (o.it) { drawItem(o.it); continue; }
    const p = o.p, cx = p.x * T, fy = WALL + p.y * T;
    const focusing = p.focusEnd > t;
    drawAvatar(ctx, cx, fy, p.avatar, { walking: p.walking, face: p.face, t: t + p.x * 500, focusing });
  }
  // 名牌、專注狀態、對話泡泡(畫在最上層)
  for (const p of players.values()) {
    const cx = p.x * T, fy = WALL + p.y * T;
    let ty = fy - 76;
    label(ctx, p.name, cx, fy + 12, p.id === me ? 'rgba(244,184,96,.95)' : 'rgba(27,24,40,.7)', p.id === me ? '#3a2710' : '#fff', p.id === me);
    if (p.focusEnd > t) { label(ctx, '📖 ' + fmt(p.focusEnd - t), cx, ty, 'rgba(27,24,40,.85)', '#f4b860', true); ty -= 22; }
    if (p.bubble && p.bubble.until > t) {
      const txt = p.bubble.text.length > 28 ? p.bubble.text.slice(0, 27) + '…' : p.bubble.text;
      label(ctx, txt, Math.min(W - 100, Math.max(100, cx)), ty, '#fff', '#2b2320');
      ty -= 22;
    }
    if (p.emote) {
      const k = (t - p.emote.start) / 1800;
      if (k >= 1) p.emote = null;
      else {
        ctx.globalAlpha = 1 - k * k; ctx.font = '26px system-ui'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
        ctx.fillText(p.emote.e, cx, ty - 6 - k * 26); ctx.globalAlpha = 1;
      }
    }
  }

  // 佈置預覽
  if (holding && hover) {
    const d = CATALOG[holding.type];
    const hy = d.kind === 'wall' ? 0 : hover.y;
    const ok = canPlace(holding.type, hover.x, hy, holding.fromId);
    const px = hover.x * T, py = d.kind === 'wall' ? 0 : WALL + hy * T;
    ctx.fillStyle = ok ? 'rgba(143,207,138,.4)' : 'rgba(226,114,123,.45)';
    if (d.kind === 'wall') ctx.fillRect(px, 0, d.w * T, WALL - 14); else ctx.fillRect(px, py, d.w * T, d.h * T);
    ctx.globalAlpha = .75; DRAW[holding.type](ctx, px, py, t); ctx.globalAlpha = 1;
  }

  tickTimer(t);
  requestAnimationFrame(frame);
}

// ---------- 畫布操作 ----------
function pointerPos(ev) {
  const r = canvas.getBoundingClientRect();
  return { x: ((ev.clientX - r.left) / r.width) * W, y: ((ev.clientY - r.top) / r.height) * H };
}
function tileAt(pos) {
  const d = holding && CATALOG[holding.type];
  // 拿著家具時,讓家具以游標為中心
  const ox = d ? (d.w - 1) / 2 : 0, oy = d && d.kind !== 'wall' ? (d.h - 1) / 2 : 0;
  return { x: Math.floor(pos.x / T - ox), y: Math.floor((pos.y - WALL) / T - oy), wall: pos.y < WALL };
}
canvas.addEventListener('pointermove', (ev) => { hover = tileAt(pointerPos(ev)); });
canvas.addEventListener('pointerleave', () => { hover = null; });
canvas.addEventListener('pointerdown', (ev) => {
  if (!room) return;
  const pos = pointerPos(ev);
  if (holding) {
    const tl = tileAt(pos), d = CATALOG[holding.type], y = d.kind === 'wall' ? 0 : tl.y;
    if (!canPlace(holding.type, tl.x, y, holding.fromId)) return toast('這裡放不下');
    if (holding.fromId) { send({ t: 'move_item', id: holding.fromId, x: tl.x, y }); setHolding(null); }
    else send({ t: 'place', type: holding.type, x: tl.x, y });
    return;
  }
  if (editing()) { // 佈置分頁開著:點家具可拿起
    const tx = Math.floor(pos.x / T), ty = Math.floor((pos.y - WALL) / T), wall = pos.y < WALL;
    const hit = (kinds) => room.items.findLast((it) => {
      const d = CATALOG[it.type];
      if (!d || !kinds.includes(d.kind)) return false;
      return tx >= it.x && tx < it.x + d.w && (d.kind === 'wall' || (ty >= it.y && ty < it.y + d.h));
    });
    const it = wall ? hit(['wall']) : hit(['floor']) || hit(['rug']);
    if (it) return setHolding({ type: it.type, fromId: it.id });
  }
  if (pos.y < WALL) return;
  const p = players.get(me);
  if (!p) return;
  p.tx = Math.min(COLS - .3, Math.max(.3, pos.x / T));
  p.ty = Math.min(ROWS - .15, Math.max(.2, (pos.y - WALL) / T));
  send({ t: 'move', x: p.tx, y: p.ty });
});
window.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') setHolding(null); });

// ---------- 分頁 ----------
let currentTab = 'focus';
const editing = () => currentTab === 'decor' && canEdit();
$('#tabs').addEventListener('click', (ev) => {
  const b = ev.target.closest('button');
  if (!b) return;
  currentTab = b.dataset.tab;
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('on', x === b));
  document.querySelectorAll('.tab').forEach((x) => x.classList.toggle('on', x.id === 'tab-' + currentTab));
  if (currentTab !== 'decor') setHolding(null);
});

// ---------- 專注 ----------
function tickTimer(t) {
  const focusing = localFocusEnd > t;
  const text = focusing ? fmt(localFocusEnd - t) : fmt(selectedMin * 60000);
  if ($('#timerText').textContent !== text) {
    $('#timerText').textContent = text;
    document.title = focusing ? `${text} 專注中 — 悠悠自習室` : '悠悠自習室';
    if (focusing) refreshMembers();
  }
}
function refreshTimer() {
  const focusing = localFocusEnd > performance.now();
  $('#timerLabel').textContent = focusing ? '專注中…加油!' : '準備好就開始吧';
  $('#focusBtn').textContent = focusing ? '放棄這次專注' : '開始專注';
  $('#focusBtn').className = focusing ? 'danger' : 'primary';
  $('#presets').hidden = focusing;
}
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
  if (localFocusEnd > performance.now()) {
    if (confirm('確定要放棄嗎?這次專注不會獲得金幣。')) send({ t: 'focus_stop' });
  } else send({ t: 'focus_start', minutes: selectedMin });
});

function refreshMembers() {
  const ul = $('#members'), now = performance.now();
  ul.replaceChildren(...[...players.values()].map((p) => {
    const focusing = p.focusEnd > now;
    return el('li', {},
      el('span', { textContent: p.name + (p.id === me ? '(你)' : '') }),
      el('span', { className: 'st' + (focusing ? ' focus' : ''), textContent: focusing ? '專注中 ' + fmt(p.focusEnd - now) : `累計 ${p.totalMinutes} 分` }));
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
  holding = h;
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
    const cv = el('canvas', { width: 128, height: 128 });
    const c = cv.getContext('2d');
    const top = d.kind === 'wall' ? 0 : d.kind === 'rug' ? 0 : 70;
    const bw = d.w * T, bh = (d.kind === 'wall' ? WALL - 20 : d.h * T) + top;
    const s = Math.min(120 / bw, 120 / bh);
    c.translate((128 - bw * s) / 2, (128 - bh * s) / 2); c.scale(s, s);
    DRAW[type](c, 0, d.kind === 'wall' ? -10 : top, 1000);
    const card = el('div', { className: 'item' }, cv, el('span', { textContent: d.name }), el('span', { className: 'price' }));
    card.dataset.type = type;
    card.addEventListener('click', () => {
      if (!canEdit()) return;
      if (!owns(type)) {
        if (profile.coins < d.price) return toast(`還差 ${d.price - profile.coins} 🪙,再專注一下吧!`);
        if (confirm(`用 ${d.price} 金幣解鎖「${d.name}」?`)) send({ t: 'buy', type });
        return;
      }
      setHolding(holding && !holding.fromId && holding.type === type ? null : { type });
    });
    return card;
  }));
  refreshCatalog();
}
function refreshCatalog() {
  document.querySelectorAll('.item').forEach((card) => {
    const d = CATALOG[card.dataset.type], own = owns(card.dataset.type);
    card.classList.toggle('locked', !own);
    card.querySelector('.price').textContent = own ? (d.price ? '已解鎖' : '免費') : `🔒 ${d.price} 🪙`;
  });
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
  $('#coins').textContent = p.coins;
  $('#statMin').textContent = p.totalMinutes;
  $('#statSes').textContent = p.sessions;
  if (first || !draft) {
    draft = { name: p.name, avatar: { ...p.avatar } };
    $('#nameInput').value = p.name;
    buildAvatarOptions();
  }
  if (Object.keys(CATALOG).length) refreshCatalog();
  refreshTimer();
}
function pushProfile() {
  clearTimeout(profileTimer);
  profileTimer = setTimeout(() => send({ t: 'profile', name: draft.name, avatar: draft.avatar }), 350);
}
function buildAvatarOptions() {
  const rows = [
    ['膚色', 'skin', SKIN.map((c) => ({ color: c }))],
    ['髮型', 'hair', HAIR_NAMES.map((n) => ({ text: n }))],
    ['髮色', 'hairColor', HAIRC.map((c) => ({ color: c }))],
    ['上衣', 'shirt', SHIRT.map((c) => ({ color: c }))],
    ['配件', 'acc', ACC_NAMES.map((n) => ({ text: n }))],
  ];
  $('#avatarOptions').replaceChildren(...rows.flatMap(([title, key, opts]) => [
    el('h3', { textContent: title }),
    el('div', { className: 'swatches' }, ...opts.map((o, i) => {
      const b = el('button', { type: 'button', className: draft.avatar[key] === i ? 'on' : '', textContent: o.text || '', title: o.text || `${title} ${i + 1}` });
      if (o.color) b.style.background = o.color;
      else Object.assign(b.style, { width: 'auto', borderRadius: '10px', padding: '0 10px' });
      b.onclick = () => { draft.avatar[key] = i; buildAvatarOptions(); pushProfile(); };
      return b;
    })),
  ]));
}
$('#nameInput').addEventListener('input', (ev) => {
  const v = ev.target.value.trim();
  if (v) { draft.name = v; pushProfile(); }
});
const pv = $('#avatarPreview').getContext('2d');
setInterval(() => {
  if (!draft || currentTab !== 'avatar') return;
  pv.setTransform(1, 0, 0, 1, 0, 0); pv.clearRect(0, 0, 160, 150);
  pv.translate(80, 132); pv.scale(1.9, 1.9);
  drawAvatar(pv, 0, 0, draft.avatar, { t: performance.now() });
}, 50);

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
  rain: { name: '🌧 雨聲', make(out) {
    const src = noise(false), hp = ac.createBiquadFilter(), lp = ac.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 900; lp.type = 'lowpass'; lp.frequency.value = 7000;
    src.connect(hp).connect(lp).connect(out); src.start();
    return () => src.stop();
  } },
  wind: { name: '🍃 白噪音', make(out) {
    const src = noise(true), lp = ac.createBiquadFilter();
    lp.type = 'lowpass'; lp.frequency.value = 500;
    src.connect(lp).connect(out); src.start();
    return () => src.stop();
  } },
  music: { name: '🎹 輕音樂', make(out) {
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

connect();
requestAnimationFrame(frame);
})();
