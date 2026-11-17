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
const POSES = 4; // 專注姿勢:0 打字、1 站著、2 看書、3 寫字
const MAX_FOCUS_MIN = 180, MAX_TODOS = 30, MAX_HABITS = 8, KEEP_DAYS = 70;
const PARTY_COUNTDOWN = 20000; // 共同專注發起後,等大家加入的時間
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

// 家具可轉 90 度(r = 0–3);轉成橫向時佔地的寬與深對調。牆面掛飾不能轉
const rotOf = (r) => (Number.isInteger(r) ? ((r % 4) + 4) % 4 : 0);
const dims = (type, r) => { const d = CATALOG[type]; return d.kind !== 'wall' && rotOf(r) % 2 ? [d.h, d.w] : [d.w, d.h]; };
function canPlace(items, type, x, y, r, ignoreId) {
  const d = CATALOG[type];
  if (!d || !Number.isInteger(x) || !Number.isInteger(y)) return false;
  const [w, h] = dims(type, r);
  if (x < 0 || x + w > COLS) return false;
  if (d.kind === 'wall') { if (y !== 0) return false; }
  else if (y < 0 || y + h > ROWS) return false;
  return !items.some((it) => {
    if (it.id === ignoreId) return false;
    const o = CATALOG[it.type];
    if (!o || o.kind !== d.kind) return false;
    const [ow, oh] = dims(it.type, it.r);
    return x < it.x + ow && it.x < x + w && y < it.y + oh && it.y < y + h;
  });
}

// 成品房間:一鍵套用整套擺設(wall / floor 是牆面與地板的樣式編號)
const PRESETS = {
  study: { name: '書房', wall: 0, floor: 0, items: [
    ['desk', 3, 2], ['chair', 4, 1], ['plant', 0, 0], ['lamp', 2, 1], ['bookshelf', 6, 0], ['plant', 7, 5],
    ['rug', 3, 3], ['window', 3, 0], ['painting', 1, 0], ['shelf', 6, 0], ['plant', 0, 5],
  ] },
  bedroom: { name: '臥室', wall: 2, floor: 2, items: [
    ['bed', 0, 0], ['cabinet', 1, 0], ['desk', 4, 2], ['chair', 5, 1], ['lamp', 3, 1], ['bookshelf', 6, 0],
    ['rug2', 1, 3], ['armchair', 0, 4, 1], ['plant', 7, 5], ['tree', 3, 0],
    ['window', 4, 0], ['painting', 2, 0], ['clock', 7, 0],
  ] },
  lounge: { name: '客廳', wall: 4, floor: 1, items: [
    ['sofa', 0, 2, 1], ['table', 2, 3], ['tv', 6, 3, 3], ['rug', 2, 2], ['desk', 3, 1], ['chair', 4, 0],
    ['bookshelf', 0, 0], ['lamp', 0, 4], ['plant', 7, 0], ['tree', 7, 5], ['cat', 3, 4], ['stool', 2, 0],
    ['window', 3, 0], ['shelf', 0, 0], ['painting', 6, 0],
  ] },
};
const presetItems = (key) => PRESETS[key].items.map(([type, x, y, r], i) => ({ id: i + 1, type, x, y, ...(r ? { r } : {}) }));

function newRoom(ownerKey) {
  let code;
  do { code = randCode(6); } while (rooms[code]);
  rooms[code] = {
    code, ownerKey, wall: 0, floor: 0, guestsEdit: false,
    // 新房間附一組基本佈置(之後可自由移動、收回,或換成別的成品房間)
    items: presetItems('study'), nextId: PRESETS.study.items.length + 1,
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
      avatar: { skin: 0, hair: Math.floor(Math.random() * 6), hairColor: 0, shirt: 0, acc: 0 },
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
// 每日統計以玩家當地日期為準(tz = 與 UTC 相差的分鐘數,由前端回報)
const dayKey = (p, at = Date.now()) => new Date(at + (p.tz || 0) * 60000).toISOString().slice(0, 10);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function credit(p, minutes, done) {
  p.totalMinutes += minutes;
  if (done) p.sessions += 1;
  if (minutes > 0) {
    const days = (p.days = p.days || {}), k = dayKey(p);
    days[k] = (days[k] || 0) + minutes;
    const keep = dayKey(p, Date.now() - KEEP_DAYS * 86400000);
    for (const d of Object.keys(days)) if (d < keep) delete days[d];
  }
  markDirty();
}
// 手動結束目前的計時:已經專注的整數分鐘照樣計入。回傳被結束的計時與計入分鐘
function stopFocus(p) {
  const f = p.focus;
  if (!f) return null;
  p.focus = null;
  let minutes = 0;
  if (f.phase === 'focus') {
    minutes = clamp(Math.floor((Date.now() - f.start) / 60000), 0, f.minutes);
    credit(p, minutes, f.mode === 'up' && minutes >= 1);
  }
  markDirty();
  return { f, minutes };
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
  habits: p.habits || [], days: p.days || {}, today: dayKey(p),
});

// ---------- 共同專注:房主發起,倒數結束後所有加入的人同時開始、同時結束 ----------
const parties = new Map(); // room code -> { by, byName, minutes, startAt, endAt, joined:Set<key>, started, done:[{id,name}] }
const partyView = (pt, c) => pt && {
  by: pt.by, byName: pt.byName, minutes: pt.minutes, started: pt.started,
  startIn: Math.max(0, pt.startAt - Date.now()), left: Math.max(0, pt.endAt - Date.now()),
  count: pt.joined.size, joined: pt.joined.has(c.key),
};
function sendParty(code) {
  const pt = parties.get(code) || null;
  for (const c of live.get(code) || []) send(c, { t: 'party', party: partyView(pt, c) });
}
function partyFocus(c, pt) { // 讓這位玩家進入共同專注(中途加入的人只算剩下的時間)
  const p = c.profile, now = Date.now(), minutes = Math.floor((pt.endAt - now + 999) / 60000);
  if (minutes < 1) return false;
  if (p.focus) stopFocus(p);
  p.focus = { mode: 'party', phase: 'focus', start: now, end: pt.endAt, minutes, breakMin: 0, round: 1 };
  markDirty();
  send(c, { t: 'profile', profile: selfProfile(p) });
  broadcast(c.room, { t: 'pupdate', p: pub(c) });
  return true;
}
function tickParties() {
  const now = Date.now();
  for (const [code, pt] of parties) {
    const set = live.get(code) || new Set();
    if (!pt.started && now >= pt.startAt) {
      pt.started = true;
      for (const c of set) if (pt.joined.has(c.key)) partyFocus(c, pt);
      sendParty(code);
    } else if (pt.started && now >= pt.endAt) {
      parties.delete(code);
      broadcast(code, { t: 'party_done', minutes: pt.minutes, done: pt.done });
      sendParty(code);
    } else if (pt.started && ![...set].some((c) => c.profile.focus?.mode === 'party')) {
      parties.delete(code); // 大家都離開了
      sendParty(code);
    }
  }
}
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
    if (Number.isInteger(m.tz) && Math.abs(m.tz) <= 840) p.tz = m.tz;
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
      presets: Object.entries(PRESETS).map(([key, p]) => ({ key, name: p.name })),
    });
    if (reward) send(c, { t: 'focus_done', ...reward, offline: true });
    if (parties.has(room.code)) send(c, { t: 'party', party: partyView(parties.get(room.code), c) });
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

  focus_stop(c) {
    const r = stopFocus(c.profile);
    if (!r) return;
    send(c, { t: 'focus_done', phase: r.f.phase, minutes: r.minutes, stopped: true, next: null });
    send(c, { t: 'profile', profile: selfProfile(c.profile) });
    broadcast(c.room, { t: 'pupdate', p: pub(c) });
    if (r.f.mode === 'party') { parties.get(c.room)?.joined.delete(c.key); sendParty(c.room); }
  },

  party_start(c, m) {
    const room = rooms[c.room], minutes = Math.floor(Number(m.minutes));
    if (!room || room.ownerKey !== c.key) return send(c, { t: 'toast', text: '只有房主可以發起共同專注' });
    if (parties.has(c.room) || !(minutes >= 1 && minutes <= MAX_FOCUS_MIN)) return;
    const startAt = Date.now() + PARTY_COUNTDOWN;
    parties.set(c.room, { by: c.profile.pid, byName: c.profile.name, minutes, startAt, endAt: startAt + minutes * 60000, joined: new Set([c.key]), started: false, done: [] });
    sendParty(c.room);
  },
  party_join(c) {
    const pt = parties.get(c.room);
    if (!pt || pt.joined.has(c.key)) return;
    if (pt.started && !partyFocus(c, pt)) return send(c, { t: 'toast', text: '這一輪快結束了,下次再一起吧' });
    pt.joined.add(c.key);
    sendParty(c.room);
  },
  // 倒數中:房主取消整場、其他人退出;開始後要離開請直接結束計時
  party_leave(c) {
    const pt = parties.get(c.room);
    if (!pt || pt.started) return;
    if (pt.by === c.profile.pid) parties.delete(c.room); else pt.joined.delete(c.key);
    sendParty(c.room);
  },

  // 頭上的「正在做什麼」與專注姿勢
  status(c, m) {
    const p = c.profile;
    if (typeof m.text === 'string') p.status = cleanText(m.text, 24);
    if (Number.isInteger(m.pose) && m.pose >= 0 && m.pose < POSES) p.pose = m.pose;
    markDirty();
    broadcast(c.room, { t: 'pupdate', p: pub(c) });
  },

  // 每日習慣:整份覆蓋;days 是打勾過的日期
  habits(c, m) {
    if (!Array.isArray(m.list)) return;
    c.profile.habits = m.list.slice(0, MAX_HABITS).map((x) => ({
      name: cleanText(x && x.name, 20),
      days: [...new Set(Array.isArray(x && x.days) ? x.days.filter((d) => typeof d === 'string' && DATE_RE.test(d)) : [])].sort().slice(-KEEP_DAYS),
    })).filter((x) => x.name);
    markDirty();
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
    const d = CATALOG[m.type], r = rotOf(m.r);
    if (!d) return;
    if (room.items.length >= MAX_ITEMS) return send(c, { t: 'toast', text: '房間放不下更多東西了' });
    if (!canPlace(room.items, m.type, m.x, m.y, r)) return;
    room.items.push({ id: room.nextId++, type: m.type, x: m.x, y: m.y, ...(r && d.kind !== 'wall' ? { r } : {}) });
    roomChanged(room);
  },

  move_item(c, m) {
    const room = editable(c);
    const it = room?.items.find((i) => i.id === m.id);
    if (!it) return;
    const r = m.r === undefined ? rotOf(it.r) : rotOf(m.r);
    if (!canPlace(room.items, it.type, m.x, m.y, r, it.id)) return;
    it.x = m.x; it.y = m.y;
    if (r && CATALOG[it.type].kind !== 'wall') it.r = r; else delete it.r;
    roomChanged(room);
  },

  // 套用成品房間(只有房主可以,會取代目前的擺設)
  preset(c, m) {
    const room = rooms[c.room];
    if (!room || room.ownerKey !== c.key || !Object.hasOwn(PRESETS, m.key)) return;
    const p = PRESETS[m.key];
    room.items = presetItems(m.key); room.nextId = p.items.length + 1;
    room.wall = p.wall; room.floor = p.floor;
    roomChanged(room);
    send(c, { t: 'toast', text: `已換成「${p.name}」` });
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
    const mode = c.profile.focus?.mode;
    const reward = settleFocus(c.profile, true);
    if (!reward) continue;
    if (mode === 'party' && reward.phase === 'focus') parties.get(c.room)?.done.push({ id: c.profile.pid, name: c.profile.name });
    send(c, { t: 'focus_done', ...reward, party: mode === 'party' });
    send(c, { t: 'profile', profile: selfProfile(c.profile) });
    broadcast(c.room, { t: 'pupdate', p: pub(c) });
  }
  tickParties();
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
  if (url === '/vendor/three-vrm.js') { hit = [null, 'text/javascript; charset=utf-8']; file = path.join(__dirname, 'node_modules/@pixiv/three-vrm/lib/three-vrm.module.min.js'); }
  // 家具與角色模型(KayKit、VRoid 範例角色等,皆為 CC0)
  const as = /^\/assets\/(kaykit|avatars|extra)\/((?:textures\/)?[\w-]+\.(gltf|glb|vrm|bin|png|jpg|txt))$/.exec(url);
  if (as) {
    const types = { gltf: 'model/gltf+json', glb: 'model/gltf-binary', vrm: 'application/octet-stream', bin: 'application/octet-stream', png: 'image/png', jpg: 'image/jpeg', txt: 'text/plain; charset=utf-8' };
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
