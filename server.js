// 悠悠自習室 — 即時伺服器:靜態檔案 + WebSocket + JSON 檔案存檔
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const COLS = 8, ROWS = 6, MAX_ITEMS = 60, MAX_ROOM_PLAYERS = 12;

// kind: floor(佔地板格) / rug(鋪在地上,可被踩與疊放) / wall(掛在牆上)
const CATALOG = {
  desk:      { name: '書桌',     w: 2, h: 1, kind: 'floor' },
  chair:     { name: '椅子',     w: 1, h: 1, kind: 'floor' },
  plant:     { name: '盆栽',     w: 1, h: 1, kind: 'floor' },
  rug:       { name: '條紋地毯', w: 3, h: 2, kind: 'rug' },
  clock:     { name: '時鐘',     w: 1, h: 1, kind: 'wall' },
  lamp:      { name: '立燈',     w: 1, h: 1, kind: 'floor' },
  rug2:      { name: '圓地毯',   w: 3, h: 2, kind: 'rug' },
  stool:     { name: '小凳子',   w: 1, h: 1, kind: 'floor' },
  window:    { name: '窗戶',     w: 2, h: 1, kind: 'wall' },
  table:     { name: '小桌',     w: 1, h: 1, kind: 'floor' },
  shelf:     { name: '壁掛書架', w: 2, h: 1, kind: 'wall' },
  painting:  { name: '掛畫',     w: 1, h: 1, kind: 'wall' },
  cabinet:   { name: '床頭櫃',   w: 1, h: 1, kind: 'floor' },
  bookshelf: { name: '置物櫃',   w: 2, h: 1, kind: 'floor' },
  tree:      { name: '仙人掌',   w: 1, h: 1, kind: 'floor' },
  armchair:  { name: '單人沙發', w: 1, h: 1, kind: 'floor' },
  sofa:      { name: '沙發',     w: 2, h: 1, kind: 'floor' },
  bed:       { name: '床',       w: 1, h: 2, kind: 'floor' },
  tv:        { name: '電視',     w: 1, h: 1, kind: 'floor' },
  cat:       { name: '貓咪',     w: 1, h: 1, kind: 'floor' },
};
const AVATAR_RANGES = { skin: 5, hair: 6, hairColor: 7, shirt: 8, acc: 5 };
const POSES = 2; // 專注姿勢:0 坐著、1 站著
const MAX_FOCUS_MIN = 180, MAX_TODOS = 30;
const THEME_COUNT = 6;
const EMOTES = ['👋', '❤️', '😂', '👍', '🔥', '☕', '💤', '✨'];

// ---------- 存檔 ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const loadJson = (f) => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch { return {}; }
};
const profiles = loadJson('profiles.json'); // key(sha256 of token) -> profile
const rooms = loadJson('rooms.json');       // code -> room
// 舊存檔相容:魚缸已改為電視
for (const r of Object.values(rooms)) for (const it of r.items || []) if (it.type === 'aquarium') it.type = 'tv';
// 舊存檔相容:舊版的專注紀錄沒有模式欄位,直接清掉
for (const p of Object.values(profiles)) if (p.focus && !p.focus.mode) p.focus = null;
let dirty = false;
const markDirty = () => { dirty = true; };
function flush() {
  if (!dirty) return;
  dirty = false;
  for (const [f, obj] of [['profiles.json', profiles], ['rooms.json', rooms]]) {
    const p = path.join(DATA_DIR, f);
    fs.writeFileSync(p + '.tmp', JSON.stringify(obj));
    fs.renameSync(p + '.tmp', p);
  }
}
setInterval(flush, 5000);
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { flush(); process.exit(0); });

// ---------- 工具 ----------
const hashToken = (t) => crypto.createHash('sha256').update(t).digest('hex');
const validToken = (t) => typeof t === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(t);
const randCode = (n) => {
  const abc = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(n), (b) => abc[b % abc.length]).join('');
};
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const cleanText = (s, max) =>
  String(s ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, max);

function canPlace(items, type, x, y, ignoreId) {
  const d = CATALOG[type];
  if (!d || !Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (x < 0 || x + d.w > COLS) return false;
  if (d.kind === 'wall') { if (y !== 0) return false; }
  else if (y < 0 || y + d.h > ROWS) return false;
  return !items.some((it) => {
    if (it.id === ignoreId) return false;
    const o = CATALOG[it.type];
    if (!o || o.kind !== d.kind) return false;
    return x < it.x + o.w && it.x < x + d.w && y < it.y + o.h && it.y < y + d.h;
  });
}

function newRoom(ownerKey) {
  let code;
  do { code = randCode(6); } while (rooms[code]);
  rooms[code] = {
    code, ownerKey, wall: 0, floor: 0, guestsEdit: false, nextId: 12,
    // 新房間附一組基本佈置(之後可自由移動或收回)
    // 椅子在書桌後面、面向房間,窗戶在背後
    items: [
      { id: 1, type: 'desk', x: 3, y: 2 },
      { id: 2, type: 'chair', x: 4, y: 1 },
      { id: 3, type: 'plant', x: 0, y: 0 },
      { id: 4, type: 'lamp', x: 2, y: 1 },
      { id: 5, type: 'bookshelf', x: 6, y: 0 },
      { id: 6, type: 'plant', x: 7, y: 5 },
      { id: 7, type: 'rug', x: 3, y: 3 },
      { id: 8, type: 'window', x: 3, y: 0 },
      { id: 9, type: 'painting', x: 1, y: 0 },
      { id: 11, type: 'shelf', x: 6, y: 0 },
      { id: 10, type: 'plant', x: 0, y: 5 },
    ],
  };
  markDirty();
  return rooms[code];
}

function getProfile(key) {
  let p = profiles[key];
  if (!p) {
    p = profiles[key] = {
      pid: randCode(8),
      name: '旅人' + Math.floor(1000 + Math.random() * 9000),
      avatar: { skin: 0, hair: Math.floor(Math.random() * 5), hairColor: Math.floor(Math.random() * 7), shirt: Math.floor(Math.random() * 8), acc: 0 },
      totalMinutes: 0, sessions: 0, focus: null, room: null, status: '', pose: 0, todos: [],
    };
    markDirty();
  }
  if (!p.room || !rooms[p.room]) { p.room = newRoom(key).code; markDirty(); }
  return p;
}

// 專注計時(都在伺服器端):
//   pomo 番茄鐘:專注 → 休息 → 專注…自動循環;down 倒數;up 正計時(最多 180 分鐘)
// focus = { mode, phase: 'focus'|'break', start, end, minutes, breakMin, round }
function credit(p, minutes, done) {
  p.totalMinutes += minutes;
  if (done) p.sessions += 1;
  markDirty();
}
// 一個階段時間到 → 結算並決定下一階段。online=false(斷線期間到期)時不自動接續
function settleFocus(p, online) {
  const f = p.focus, now = Date.now();
  if (!f || now < f.end) return null;
  if (f.phase === 'break') {
    p.focus = online ? { ...f, phase: 'focus', start: now, end: now + f.minutes * 60000, round: f.round + 1 } : null;
    markDirty();
    return { phase: 'break', minutes: 0, next: p.focus ? 'focus' : null };
  }
  credit(p, f.minutes, true);
  p.focus = online && f.mode === 'pomo' ? { ...f, phase: 'break', start: now, end: now + f.breakMin * 60000 } : null;
  return { phase: 'focus', minutes: f.minutes, next: p.focus ? 'break' : null, breakMin: f.breakMin };
}
const focusView = (f) => f && {
  mode: f.mode, phase: f.phase, round: f.round,
  left: Math.max(0, f.end - Date.now()), elapsed: Date.now() - f.start,
};

// ---------- 連線狀態 ----------
const live = new Map(); // room code -> Set<client>
const byKey = new Map(); // profile key -> client

const send = (c, msg) => { if (c.ws.readyState === 1) c.ws.send(JSON.stringify(msg)); };
const broadcast = (code, msg, except) => {
  const set = live.get(code);
  if (!set) return;
  const s = JSON.stringify(msg);
  for (const c of set) if (c !== except && c.ws.readyState === 1) c.ws.send(s);
};
const pub = (c) => ({
  id: c.profile.pid, name: c.profile.name, avatar: c.profile.avatar,
  x: c.x, y: c.y, totalMinutes: c.profile.totalMinutes,
  focus: focusView(c.profile.focus), status: c.profile.status || '', pose: c.profile.pose || 0,
});
const selfProfile = (p) => ({
  name: p.name, avatar: p.avatar, totalMinutes: p.totalMinutes, sessions: p.sessions,
  room: p.room, status: p.status || '', pose: p.pose || 0, todos: p.todos || [],
});
const roomView = (r) => ({ code: r.code, items: r.items, wall: r.wall, floor: r.floor, guestsEdit: r.guestsEdit });

function leave(c) {
  if (!c.room) return;
  const set = live.get(c.room);
  if (set) {
    set.delete(c);
    if (!set.size) live.delete(c.room);
  }
  broadcast(c.room, { t: 'leave', id: c.profile.pid });
  if (byKey.get(c.key) === c) byKey.delete(c.key);
  c.room = null;
}

const handlers = {
  hello(c, m) {
    if (c.profile || !validToken(m.token)) return send(c, { t: 'error', text: '存檔碼格式不正確' });
    c.key = hashToken(m.token);
    const old = byKey.get(c.key);
    if (old) { send(old, { t: 'kicked' }); leave(old); old.ws.close(); }
    const p = (c.profile = getProfile(c.key));
    byKey.set(c.key, c);

    let notice = null;
    let code = typeof m.room === 'string' ? m.room.toUpperCase() : '';
    if (code && !rooms[code]) { notice = `找不到房間 ${cleanText(code, 8)},已回到你的房間`; code = ''; }
    if (code && code !== p.room && (live.get(code)?.size || 0) >= MAX_ROOM_PLAYERS) { notice = '那個房間客滿了,已回到你的房間'; code = ''; }
    const room = rooms[code || p.room];
    c.room = room.code;
    c.x = 2.5 + Math.random() * 3;
    c.y = 2.5 + Math.random() * 2.5;
    const reward = settleFocus(p, false);

    if (!live.has(room.code)) live.set(room.code, new Set());
    const set = live.get(room.code);
    send(c, {
      t: 'init', me: p.pid, profile: selfProfile(p),
      room: { ...roomView(room), mine: room.ownerKey === c.key, ownerName: profiles[room.ownerKey]?.name || '' },
      players: [...set].map(pub).concat(pub(c)),
      catalog: CATALOG, cols: COLS, rows: ROWS, emotes: EMOTES, notice,
    });
    if (reward) send(c, { t: 'focus_done', ...reward, offline: true });
    set.add(c);
    broadcast(room.code, { t: 'join', p: pub(c) }, c);
  },

  move(c, m) {
    if (typeof m.x !== 'number' || typeof m.y !== 'number' || !isFinite(m.x + m.y)) return;
    c.x = clamp(m.x, 0.3, COLS - 0.3);
    c.y = clamp(m.y, 0.2, ROWS - 0.15);
    broadcast(c.room, { t: 'move', id: c.profile.pid, x: c.x, y: c.y }, c);
  },

  chat(c, m) {
    const text = cleanText(m.text, 200);
    if (text) broadcast(c.room, { t: 'chat', id: c.profile.pid, name: c.profile.name, text });
  },

  emote(c, m) {
    if (EMOTES.includes(m.e)) broadcast(c.room, { t: 'emote', id: c.profile.pid, e: m.e });
  },

  profile(c, m) {
    const p = c.profile;
    const name = cleanText(m.name, 16);
    if (name) p.name = name;
    if (m.avatar && typeof m.avatar === 'object') {
      for (const [k, n] of Object.entries(AVATAR_RANGES)) {
        const v = m.avatar[k];
        if (Number.isInteger(v) && v >= 0 && v < n) p.avatar[k] = v;
      }
    }
    markDirty();
    send(c, { t: 'profile', profile: selfProfile(p) });
    broadcast(c.room, { t: 'pupdate', p: pub(c) });
  },

  focus_start(c, m) {
    const p = c.profile;
    if (p.focus || !['pomo', 'down', 'up'].includes(m.mode)) return;
    const minutes = m.mode === 'up' ? MAX_FOCUS_MIN : Math.floor(Number(m.minutes));
    const breakMin = m.mode === 'pomo' ? Math.floor(Number(m.breakMin)) : 0;
    if (!(minutes >= 1 && minutes <= MAX_FOCUS_MIN)) return;
    if (m.mode === 'pomo' && !(breakMin >= 1 && breakMin <= 60)) return;
    const now = Date.now();
    p.focus = { mode: m.mode, phase: 'focus', start: now, end: now + minutes * 60000, minutes, breakMin, round: 1 };
    markDirty();
    broadcast(c.room, { t: 'pupdate', p: pub(c) });
  },

  // 手動結束:已經專注的整數分鐘照樣計入統計
  focus_stop(c) {
    const p = c.profile, f = p.focus;
    if (!f) return;
    p.focus = null;
    let minutes = 0;
    if (f.phase === 'focus') {
      minutes = clamp(Math.floor((Date.now() - f.start) / 60000), 0, f.minutes);
      credit(p, minutes, f.mode === 'up' && minutes >= 1);
    }
    markDirty();
    send(c, { t: 'focus_done', phase: f.phase, minutes, stopped: true, next: null });
    send(c, { t: 'profile', profile: selfProfile(p) });
    broadcast(c.room, { t: 'pupdate', p: pub(c) });
  },

  // 頭上的「正在做什麼」與專注姿勢
  status(c, m) {
    const p = c.profile;
    if (typeof m.text === 'string') p.status = cleanText(m.text, 24);
    if (Number.isInteger(m.pose) && m.pose >= 0 && m.pose < POSES) p.pose = m.pose;
    markDirty();
    broadcast(c.room, { t: 'pupdate', p: pub(c) });
  },

  // 待辦清單:整份覆蓋
  todos(c, m) {
    if (!Array.isArray(m.list)) return;
    c.profile.todos = m.list.slice(0, MAX_TODOS)
      .map((x) => ({ text: cleanText(x && x.text, 60), done: !!(x && x.done) }))
      .filter((x) => x.text);
    markDirty();
  },

  place(c, m) {
    const room = editable(c);
    if (!room) return;
    const d = CATALOG[m.type];
    if (!d) return;
    if (room.items.length >= MAX_ITEMS) return send(c, { t: 'toast', text: '房間放不下更多東西了' });
    if (!canPlace(room.items, m.type, m.x, m.y)) return;
    room.items.push({ id: room.nextId++, type: m.type, x: m.x, y: m.y });
    roomChanged(room);
  },

  move_item(c, m) {
    const room = editable(c);
    const it = room?.items.find((i) => i.id === m.id);
    if (!it || !canPlace(room.items, it.type, m.x, m.y, it.id)) return;
    it.x = m.x; it.y = m.y;
    roomChanged(room);
  },

  remove_item(c, m) {
    const room = editable(c);
    if (!room) return;
    const n = room.items.length;
    room.items = room.items.filter((i) => i.id !== m.id);
    if (room.items.length !== n) roomChanged(room);
  },

  theme(c, m) {
    const room = editable(c);
    if (!room) return;
    for (const k of ['wall', 'floor']) {
      if (Number.isInteger(m[k]) && m[k] >= 0 && m[k] < THEME_COUNT) room[k] = m[k];
    }
    roomChanged(room);
  },

  room_settings(c, m) {
    const room = rooms[c.room];
    if (!room || room.ownerKey !== c.key) return;
    room.guestsEdit = !!m.guestsEdit;
    roomChanged(room);
  },

  // 檢查存檔碼是否存在(換裝置時用)
  check(c, m) {
    send(c, { t: 'check', ok: validToken(m.token) && !!profiles[hashToken(m.token)] });
  },
};

function editable(c) {
  const room = rooms[c.room];
  return room && (room.ownerKey === c.key || room.guestsEdit) ? room : null;
}
function roomChanged(room) {
  markDirty();
  broadcast(room.code, { t: 'room', room: roomView(room) });
}

// 每秒檢查線上玩家的計時階段是否到期
setInterval(() => {
  for (const c of byKey.values()) {
    const reward = settleFocus(c.profile, true);
    if (!reward) continue;
    send(c, { t: 'focus_done', ...reward });
    send(c, { t: 'profile', profile: selfProfile(c.profile) });
    broadcast(c.room, { t: 'pupdate', p: pub(c) });
  }
}, 1000);

// ---------- HTTP ----------
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/index.html': ['index.html', 'text/html; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/game.js': ['game.js', 'text/javascript; charset=utf-8'],
};
const THREE_DIR = path.join(__dirname, 'node_modules', 'three');
const server = http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/healthz') return res.writeHead(200).end('ok');
  let hit = STATIC[url], file;
  // three.js 由 node_modules 提供(只開放白名單內的檔案)
  const v = /^\/vendor\/three\/(three\.(?:module|core)(?:\.min)?\.js)$/.exec(url);
  if (v) { hit = [null, 'text/javascript; charset=utf-8']; file = path.join(THREE_DIR, 'build', v[1]); }
  const ad = /^\/vendor\/addons\/((?:[\w-]+\/)*[\w-]+\.js)$/.exec(url);
  if (ad) { hit = [null, 'text/javascript; charset=utf-8']; file = path.join(THREE_DIR, 'examples/jsm', ad[1]); }
  // 家具與角色模型(KayKit、Quaternius,皆為 CC0)
  const as = /^\/assets\/(kaykit|characters|extra)\/((?:textures\/)?[\w-]+\.(gltf|glb|bin|png|jpg|txt))$/.exec(url);
  if (as) {
    const types = { gltf: 'model/gltf+json', glb: 'model/gltf-binary', bin: 'application/octet-stream', png: 'image/png', jpg: 'image/jpeg', txt: 'text/plain; charset=utf-8' };
    hit = [null, types[as[3]]]; file = path.join(__dirname, 'public/assets', as[1], as[2]);
  }
  if (!hit) return res.writeHead(404).end('Not found');
  // 模型與 three.js 內容不常變動,讓瀏覽器快取一天;文字類檔案用 gzip 壓縮後再送
  const full = file || path.join(__dirname, 'public', hit[0]);
  const headers = { 'Content-Type': hit[1], 'Cache-Control': file ? 'public, max-age=86400' : 'no-cache' };
  const gz = /gzip/.test(req.headers['accept-encoding'] || '') && /javascript|html|css|json|octet-stream|plain/.test(hit[1]);
  if (gz && GZ.has(full)) return res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' }).end(GZ.get(full));
  fs.readFile(full, (err, buf) => {
    if (err) return res.writeHead(err.code === 'ENOENT' ? 404 : 500).end('error');
    if (!gz) return res.writeHead(200, headers).end(buf);
    zlib.gzip(buf, (e, out) => {
      if (e) return res.writeHead(200, headers).end(buf);
      if (file) GZ.set(full, out);
      res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip', Vary: 'Accept-Encoding' }).end(out);
    });
  });
});
const GZ = new Map(); // 壓縮結果快取(只快取不會變動的 vendor / assets 檔案)

const wss = new WebSocketServer({ server, maxPayload: 4096 });
wss.on('connection', (ws) => {
  const c = { ws, key: null, profile: null, room: null, x: 0, y: 0, tokens: 20, last: Date.now(), alive: true };
  ws.on('pong', () => { c.alive = true; });
  ws.on('message', (raw) => {
    // 流量限制:每秒補 10 次,最多累積 20 次
    const now = Date.now();
    c.tokens = Math.min(20, c.tokens + ((now - c.last) / 1000) * 10);
    c.last = now;
    if (c.tokens < 1) return;
    c.tokens -= 1;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== 'object' || !Object.hasOwn(handlers, m.t)) return;
    if (m.t !== 'hello' && !c.profile) return;
    try { handlers[m.t](c, m); } catch (e) { console.error('handler error', m.t, e); }
  });
  ws.on('close', () => leave(c));
  ws.on('error', () => {});
  c.ping = setInterval(() => {
    if (!c.alive) return ws.terminate();
    c.alive = false;
    ws.ping();
  }, 30000);
  ws.on('close', () => clearInterval(c.ping));
});

server.listen(PORT, () => console.log(`悠悠自習室 running → http://localhost:${PORT}`));
