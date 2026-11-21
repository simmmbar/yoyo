// 悠悠自習室 — 即時伺服器:靜態檔案 + WebSocket + JSON 檔案存檔
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const zlib = require('zlib');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const COLS = 6, ROWS = 5, MAX_ITEMS = 110, MAX_ROOM_PLAYERS = 12;

// kind: floor(佔地板格) / rug(鋪在地上,可被踩與疊放) / wall(掛在牆上) / top(小物:放在桌面、櫃子上,或直接放地上)
// g: 佈置面板的分類。小物只佔半格見方,位置以四分之一格為單位,同一張桌子可以擺好幾件
const CATALOG = {
  kdesk:    { name: '工作桌',   w: 2, h: 1, g: 'desk', kind: 'floor' },
  dining:   { name: '長桌',     w: 2, h: 1, g: 'desk', kind: 'floor' },
  coffee:   { name: '茶几',     w: 2, h: 1, g: 'desk', kind: 'floor' },
  side:     { name: '邊桌',     w: 1, h: 1, g: 'desk', kind: 'floor' },
  kchair:   { name: '電腦椅',   w: 1, h: 1, g: 'desk', kind: 'floor' },
  cchair:   { name: '木椅',     w: 1, h: 1, g: 'desk', kind: 'floor' },
  stool:    { name: '圓凳',     w: 1, h: 1, g: 'desk', kind: 'floor' },
  kcase:    { name: '開放書櫃', w: 1, h: 1, g: 'store', kind: 'floor' },
  doorcase: { name: '門片書櫃', w: 1, h: 1, g: 'store', kind: 'floor' },
  widecase: { name: '寬矮櫃',   w: 2, h: 1, g: 'store', kind: 'floor' },
  lowcase:  { name: '矮櫃',     w: 1, h: 1, g: 'store', kind: 'floor' },
  rack:     { name: '衣帽架',   w: 1, h: 1, g: 'store', kind: 'floor' },
  box:      { name: '紙箱',     w: 1, h: 1, g: 'store', kind: 'floor' },
  bed:      { name: '單人床',   w: 1, h: 2, g: 'rest', kind: 'floor' },
  dbed:     { name: '雙人床',   w: 2, h: 2, g: 'rest', kind: 'floor' },
  ksofa:    { name: '沙發',     w: 2, h: 1, g: 'rest', kind: 'floor' },
  lchair:   { name: '單人沙發', w: 1, h: 1, g: 'rest', kind: 'floor' },
  ottoman:  { name: '腳凳',     w: 1, h: 1, g: 'rest', kind: 'floor' },
  tv2:      { name: '電視',     w: 2, h: 1, g: 'elec', kind: 'floor' },
  fridge:   { name: '冰箱',     w: 1, h: 1, g: 'elec', kind: 'floor' },
  spk:      { name: '落地喇叭', w: 1, h: 1, g: 'elec', kind: 'floor' },
  arcade:   { name: '大型電玩', w: 1, h: 1, g: 'elec', kind: 'floor' },
  vending:  { name: '販賣機',   w: 1, h: 1, g: 'elec', kind: 'floor' },
  flamp:    { name: '立燈',     w: 1, h: 1, g: 'deco', kind: 'floor' },
  bigplant: { name: '大盆栽',   w: 1, h: 1, g: 'deco', kind: 'floor' },
  plant:    { name: '盆栽',     w: 1, h: 1, g: 'deco', kind: 'floor' },
  bin:      { name: '垃圾桶',   w: 1, h: 1, g: 'deco', kind: 'floor' },
  cat:      { name: '貓咪',     w: 1, h: 1, g: 'deco', kind: 'floor' },
  monitor:  { name: '螢幕鍵盤', w: 1, h: 1, g: 'top', kind: 'top' },
  tlaptop:  { name: '筆電',     w: 0.5, h: 0.5, g: 'top', kind: 'top' },
  tlamp:    { name: '檯燈',     w: 0.5, h: 0.5, g: 'top', kind: 'top' },
  tbooks:   { name: '書堆',     w: 0.5, h: 0.5, g: 'top', kind: 'top' },
  tplant:   { name: '小盆栽',   w: 0.5, h: 0.5, g: 'top', kind: 'top' },
  tplant2:  { name: '多肉盆栽', w: 0.5, h: 0.5, g: 'top', kind: 'top' },
  radio:    { name: '收音機',   w: 0.5, h: 0.5, g: 'top', kind: 'top' },
  brew:     { name: '茶具組',   w: 0.5, h: 0.5, g: 'top', kind: 'top' },
  window:   { name: '窗戶',     w: 2, h: 1, g: 'wall', kind: 'wall' },
  painting: { name: '掛畫',     w: 1, h: 1, g: 'wall', kind: 'wall' },
  poster:   { name: '海報',     w: 1, h: 1, g: 'wall', kind: 'wall' },
  clock:    { name: '時鐘',     w: 1, h: 1, g: 'wall', kind: 'wall' },
  shelf:    { name: '壁掛層板', w: 2, h: 1, g: 'wall', kind: 'wall' },
  neon:     { name: '霓虹燈',   w: 1, h: 1, g: 'wall', kind: 'wall' },
  wlamp:    { name: '壁燈',     w: 1, h: 1, g: 'wall', kind: 'wall' },
  mirror:   { name: '鏡子',     w: 1, h: 1, g: 'wall', kind: 'wall' },
  rug:      { name: '條紋地毯', w: 3, h: 2, g: 'rug', kind: 'rug' },
  rug2:     { name: '橢圓地毯', w: 3, h: 2, g: 'rug', kind: 'rug' },
  rround:   { name: '圓形地毯', w: 2, h: 2, g: 'rug', kind: 'rug' },
  rsquare:  { name: '菱紋地毯', w: 2, h: 2, g: 'rug', kind: 'rug' },
  rbig:     { name: '大地毯',   w: 3, h: 2, g: 'rug', kind: 'rug' },
  mat:      { name: '門墊',     w: 1, h: 1, g: 'rug', kind: 'rug' },
};
// 舊版家具換成現在對應的款式(舊存檔載入時轉換)
const ALIAS = {
  desk: 'kdesk', pc: 'kdesk', chair: 'cchair', mchair: 'cchair', bench: 'cchair', barstool: 'stool', table: 'side', cabinet: 'side',
  bookshelf: 'widecase', sofa: 'ksofa', dsofa: 'ksofa', armchair: 'lchair', bunk: 'bed', tv: 'tv2', claw: 'arcade', pinball: 'arcade',
  lamp: 'flamp', flamp2: 'flamp', tree: 'bigplant', tspk: 'radio', obox: 'box', wcab: 'painting', aquarium: 'tv2', bear: 'tplant',
};
// acc 頭飾(0 無、1 耳機、2 貓耳、3 貝雷帽、4 蝴蝶結、5 小皇冠、6 花)、glasses 眼鏡、accColor 配件顏色
// headSize 頭的大小(0–8)、height 身高(0–8,4 = 原本)、face 平常的表情
const AVATAR_RANGES = { skin: 5, hair: 12, hairColor: 7, shirt: 8, acc: 7, glasses: 2, accColor: 8, headSize: 9, height: 9, face: 3 };
// 自己挑的顏色(#rrggbb,空字串 = 用原本的顏色)
const AVATAR_HEX = ['hairHex', 'eyeHex', 'topHex', 'bottomHex'];
function applyAvatar(dst, src) {
  if (!src || typeof src !== 'object') return;
  for (const [k, n] of Object.entries(AVATAR_RANGES)) if (Number.isInteger(src[k]) && src[k] >= 0 && src[k] < n) dst[k] = src[k];
  for (const k of AVATAR_HEX) if (src[k] === '' || (typeof src[k] === 'string' && /^#[0-9a-f]{6}$/i.test(src[k]))) dst[k] = src[k].toLowerCase();
}
const POSES = 4; // 專注姿勢:0 打字、1 站著、2 看書、3 寫字
const MAX_FOCUS_MIN = 180, MAX_TODOS = 30, MAX_HABITS = 8, KEEP_DAYS = 70;
const PARTY_COUNTDOWN = 20000; // 共同專注發起後,等大家加入的時間
const THEME_COUNT = 6, COLOR_COUNT = 8; // 家具可換 8 種顏色(0 = 原色)
const colOf = (c) => (Number.isInteger(c) && c > 0 && c < COLOR_COUNT ? c : 0);
const EMOTES = ['👋', '❤️', '😂', '👍', '🔥', '☕', '💤', '✨'];

// ---------- 存檔 ----------
fs.mkdirSync(DATA_DIR, { recursive: true });
const loadJson = (f) => {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), 'utf8')); } catch { return {}; }
};
const profiles = loadJson('profiles.json'); // key(sha256 of token) -> profile
const rooms = loadJson('rooms.json');       // code -> room
// 舊存檔相容:魚缸已改為電視
for (const r of Object.values(rooms)) for (const it of r.items || []) if (ALIAS[it.type]) { it.type = ALIAS[it.type]; delete it.c; }
// 舊存檔相容:房間從 8×6 縮成 6×5,放不下的舊房間換成預設書房(在 PRESETS 定義之後執行)
const migrateRooms = () => { for (const r of Object.values(rooms)) if ((r.items || []).some((it) => !CATALOG[it.type] || it.x + dims(it.type, it.r)[0] > COLS || (CATALOG[it.type].kind !== 'wall' && it.y + dims(it.type, it.r)[1] > ROWS))) { r.items = presetItems('study'); r.nextId = r.items.length + 1; markDirty(); } };
// 舊存檔相容:小物原本佔一整格、擺在格子正中央;改成半格之後往右下移四分之一格,看起來才會在原位
for (const r of Object.values(rooms)) if (r.v !== 2) { for (const it of r.items || []) if (CATALOG[it.type]?.kind === 'top' && CATALOG[it.type].w < 1) { it.x += 0.25; it.y += 0.25; } r.v = 2; }
// 舊存檔相容:眼鏡原本是頭飾的其中一個選項(2),現在獨立出來,可以和頭飾一起戴
for (const p of Object.values(profiles)) if (p.avatar && p.avatar.glasses === undefined) { const a = p.avatar; a.glasses = a.acc === 2 ? 1 : 0; a.acc = { 1: 1, 3: 2, 4: 3 }[a.acc] || 0; a.accColor = 0; }
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
  if (!d || typeof x !== 'number' || typeof y !== 'number') return false;
  const step = d.kind === 'top' ? 4 : 1; // 小物可以放在四分之一格上
  if (!Number.isInteger(x * step) || !Number.isInteger(y * step)) return false;
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
  // 每筆:[家具, x, y, 旋轉(0–3), 顏色(0–7)]
  study: { name: '書房', wall: 0, floor: 0, items: [
    ['kcase', 0, 0], ['bigplant', 1, 0], ['kchair', 3, 0], ['lowcase', 4, 0], ['doorcase', 5, 0],
    ['kdesk', 2, 1], ['flamp', 5, 1], ['ksofa', 0, 2, 1, 4], ['coffee', 1, 3], ['widecase', 5, 2, 3], ['side', 0, 4], ['cat', 2, 4],
    ['tlaptop', 3.25, 1, 2], ['tlamp', 2, 1, 2], ['tbooks', 2.5, 1.5, 1], ['brew', 3.25, 1.5], ['radio', 4.25, 0],
    ['tbooks', 1.25, 3.25], ['tplant2', 2.25, 3.25], ['tplant', 0.25, 4],
    ['rbig', 1, 2, 0, 6], ['mat', 4, 4],
    ['window', 2, 0], ['poster', 0, 0], ['painting', 1, 0], ['wlamp', 4, 0], ['clock', 5, 0],
  ] },
  bedroom: { name: '臥室', wall: 2, floor: 2, items: [
    ['dbed', 0, 0, 0, 5], ['side', 2, 0], ['kdesk', 3, 0, 0, 4], ['kcase', 5, 0, 0, 4], ['kchair', 3, 1], ['plant', 4, 1],
    ['lowcase', 5, 2, 3, 4], ['arcade', 5, 3, 3], ['lchair', 0, 2, 1, 5], ['ottoman', 1, 2, 0, 5], ['box', 0, 4], ['bigplant', 5, 4],
    ['monitor', 3, 0], ['tbooks', 4, 0], ['tplant2', 4.25, 0.5], ['tlamp', 2.25, 0], ['radio', 5.5, 2.25, 3], ['tplant', 5.5, 2.75], ['bin', 1, 4],
    ['rround', 1, 2, 0, 6], ['mat', 4, 4],
    ['window', 0, 0], ['neon', 2, 0], ['shelf', 3, 0], ['clock', 5, 0],
  ] },
  lounge: { name: '客廳', wall: 4, floor: 1, items: [
    ['bigplant', 0, 0], ['kcase', 1, 0, 0, 3], ['kdesk', 2, 0, 0, 3], ['fridge', 4, 0], ['vending', 5, 0], ['kchair', 2, 1], ['flamp', 0, 1],
    ['ksofa', 0, 2, 1, 2], ['coffee', 2, 2, 1, 3], ['tv2', 5, 2, 3, 3], ['arcade', 5, 1, 3], ['side', 0, 4, 0, 3], ['cat', 3, 4], ['spk', 5, 4],
    ['monitor', 2, 0], ['tbooks', 3, 0.25], ['tplant2', 2.25, 2.25], ['tbooks', 2.25, 2.75, 1], ['radio', 2.25, 3.25, 1], ['tplant', 0.25, 4],
    ['rbig', 1, 2, 0, 4], ['mat', 4, 4],
    ['window', 2, 0], ['neon', 0, 0], ['clock', 4, 0], ['wlamp', 5, 0], ['painting', 1, 0],
  ] },
};
const presetItems = (key) => PRESETS[key].items.map(([type, x, y, r, c], i) => ({ id: i + 1, type, x, y, ...(r ? { r } : {}), ...(c ? { c } : {}) }));
migrateRooms();

function newRoom(ownerKey) {
  let code;
  do { code = randCode(6); } while (rooms[code]);
  rooms[code] = {
    code, ownerKey, wall: 0, floor: 0, guestsEdit: false, v: 2,
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
      avatar: { skin: 0, hair: Math.floor(Math.random() * 6), hairColor: 0, shirt: 0, acc: 0, glasses: 0, accColor: 0 },
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

// 進房間時站在沒有家具的地板上(優先選靠房門那半邊)
function freeSpot(room) {
  const used = new Set();
  for (const it of room.items) {
    if (CATALOG[it.type]?.kind !== 'floor') continue;
    const [w, h] = dims(it.type, it.r);
    for (let x = it.x; x < it.x + w; x++) for (let y = it.y; y < it.y + h; y++) used.add(x + ',' + y);
  }
  const free = [];
  for (let x = 0; x < COLS; x++) for (let y = 0; y < ROWS; y++) if (!used.has(x + ',' + y)) free.push([x, y]);
  const front = free.filter(([, y]) => y >= 2 && y <= ROWS - 2), pool = front.length ? front : free;
  if (!pool.length) return [COLS / 2, ROWS / 2];
  const [x, y] = pool[Math.floor(Math.random() * pool.length)];
  return [x + 0.35 + Math.random() * 0.3, y + 0.35 + Math.random() * 0.3];
}

// 待辦與習慣:收到的清單一律重新整理成乾淨的格式
const cleanTodos = (list) => (Array.isArray(list) ? list : []).slice(0, MAX_TODOS)
  .map((x) => ({ text: cleanText(x && x.text, 60), done: !!(x && x.done) })).filter((x) => x.text);
const cleanHabits = (list) => (Array.isArray(list) ? list : []).slice(0, MAX_HABITS).map((x) => ({
  name: cleanText(x && x.name, 20),
  days: [...new Set(Array.isArray(x && x.days) ? x.days.filter((d) => typeof d === 'string' && DATE_RE.test(d)) : [])].sort().slice(-KEEP_DAYS),
})).filter((x) => x.name);

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
// 海報與掛畫可以換成自己的圖片:圖檔另外存在房間的 imgs 裡(用內容雜湊當檔名),物品只記雜湊,
// 瀏覽器再用 /roomimg/房號/雜湊.jpg 讀取,所以搬家具時不必把圖片重傳給每個人
const IMG_TYPES = ['poster', 'painting'], MAX_IMGS = 6, MAX_IMG_CHARS = 48000;
const IMG_RE = /^data:image\/jpeg;base64,([A-Za-z0-9+/]+={0,2})$/;
function gcImgs(room) {
  if (!room.imgs) return;
  const used = new Set(room.items.map((i) => i.img).filter(Boolean));
  for (const h of Object.keys(room.imgs)) if (!used.has(h)) delete room.imgs[h];
  if (!Object.keys(room.imgs).length) delete room.imgs;
}

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
    c.fresh = !profiles[c.key]; // 這個存檔碼伺服器沒看過(新玩家,或伺服器的資料被清掉了)
    const p = (c.profile = getProfile(c.key));
    if (Number.isInteger(m.tz) && Math.abs(m.tz) <= 840) p.tz = m.tz;
    p.seen = Date.now();
    byKey.set(c.key, c);

    let notice = null;
    let code = typeof m.room === 'string' ? m.room.toUpperCase() : '';
    if (code && !rooms[code]) { notice = `找不到房間 ${cleanText(code, 8)},已回到你的房間`; code = ''; }
    if (code && code !== p.room && (live.get(code)?.size || 0) >= MAX_ROOM_PLAYERS) { notice = '那個房間客滿了,已回到你的房間'; code = ''; }
    const room = rooms[code || p.room];
    c.room = room.code;
    [c.x, c.y] = freeSpot(room);
    const reward = settleFocus(p, false);

    if (!live.has(room.code)) live.set(room.code, new Set());
    const set = live.get(room.code);
    send(c, {
      t: 'init', me: p.pid, profile: selfProfile(p),
      room: { ...roomView(room), mine: room.ownerKey === c.key, ownerName: profiles[room.ownerKey]?.name || '' },
      players: [...set].map(pub).concat(pub(c)),
      catalog: CATALOG, cols: COLS, rows: ROWS, emotes: EMOTES, notice, fresh: c.fresh,
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
    applyAvatar(p.avatar, m.avatar);
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
    c.profile.habits = cleanHabits(m.list);
    markDirty();
  },

  // 待辦清單:整份覆蓋
  todos(c, m) {
    if (!Array.isArray(m.list)) return;
    c.profile.todos = cleanTodos(m.list);
    markDirty();
  },

  place(c, m) {
    const room = editable(c);
    if (!room) return;
    const d = CATALOG[m.type], r = rotOf(m.r);
    if (!d) return;
    if (room.items.length >= MAX_ITEMS) return send(c, { t: 'toast', text: '房間放不下更多東西了' });
    if (!canPlace(room.items, m.type, m.x, m.y, r)) return;
    room.items.push({ id: room.nextId++, type: m.type, x: m.x, y: m.y, ...(r && d.kind !== 'wall' ? { r } : {}), ...(colOf(m.c) ? { c: colOf(m.c) } : {}) });
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
    if (m.c !== undefined) { if (colOf(m.c)) it.c = colOf(m.c); else delete it.c; }
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

  // 換上自己的圖片(瀏覽器已經先縮成小張 JPEG);img 給空字串就是換回原本的圖案
  item_image(c, m) {
    const room = editable(c);
    const it = room?.items.find((i) => i.id === m.id);
    if (!it || !IMG_TYPES.includes(it.type) || typeof m.img !== 'string') return;
    if (m.img === '') { if (!it.img) return; delete it.img; return roomChanged(room); }
    const now = Date.now();
    if (now - (c.imgAt || 0) < 800) return;
    c.imgAt = now;
    const hit = m.img.length <= MAX_IMG_CHARS && IMG_RE.exec(m.img);
    const buf = hit && Buffer.from(hit[1], 'base64');
    if (!buf || buf.length < 100 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff) return send(c, { t: 'toast', text: '這張圖片沒辦法使用,換一張試試' });
    if (!it.img && room.items.filter((i) => i.img).length >= MAX_IMGS) return send(c, { t: 'toast', text: `一個房間最多可以放 ${MAX_IMGS} 張自己的圖片` });
    const hash = crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16);
    (room.imgs ||= {})[hash] = hit[1];
    it.img = hash;
    roomChanged(room);
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

  // 還原:伺服器的資料不見時(例如免費主機重啟),瀏覽器把自己留的備份送回來。
  // 只有這次連線才剛建立的全新存檔可以還原一次,所有內容都重新檢查過才寫入。
  restore(c, m) {
    if (!c.fresh) return;
    c.fresh = false;
    const p = c.profile, b = m.data;
    if (!b || typeof b !== 'object') return;
    const int = (v, max) => clamp(Math.floor(Number(v)) || 0, 0, max);
    p.name = cleanText(b.name, 16) || p.name;
    applyAvatar(p.avatar, b.avatar);
    p.totalMinutes = int(b.totalMinutes, 5e6); p.sessions = int(b.sessions, 5e5);
    p.status = cleanText(b.status, 24); p.pose = Number.isInteger(b.pose) && b.pose >= 0 && b.pose < POSES ? b.pose : 0;
    p.todos = cleanTodos(b.todos); p.habits = cleanHabits(b.habits);
    p.days = {};
    if (b.days && typeof b.days === 'object') for (const [k, v] of Object.entries(b.days).slice(-KEEP_DAYS)) if (DATE_RE.test(k) && int(v, 1440)) p.days[k] = int(v, 1440);
    const r = rooms[p.room], rb = b.room;
    if (r && rb && typeof rb === 'object') {
      const items = [];
      for (const raw of (Array.isArray(rb.items) ? rb.items : []).slice(0, MAX_ITEMS)) {
        if (!raw || typeof raw !== 'object') continue;
        const type = ALIAS[raw.type] || raw.type, rot = rotOf(raw.r);
        if (typeof type !== 'string' || !Object.hasOwn(CATALOG, type) || !canPlace(items, type, raw.x, raw.y, rot)) continue;
        items.push({ id: items.length + 1, type, x: raw.x, y: raw.y, ...(rot && CATALOG[type].kind !== 'wall' ? { r: rot } : {}), ...(colOf(raw.c) ? { c: colOf(raw.c) } : {}) });
      }
      if (items.length) { r.items = items; r.nextId = items.length + 1; r.v = 2; }
      for (const k of ['wall', 'floor']) if (Number.isInteger(rb[k]) && rb[k] >= 0 && rb[k] < THEME_COUNT) r[k] = rb[k];
      r.guestsEdit = !!rb.guestsEdit;
      // 房號也換回原本的,之前發出去的邀請連結才不會失效(那個房號要還沒被別人用掉)
      const old = r.code, others = [...(live.get(old) || [])].some((x) => x !== c);
      if (typeof rb.code === 'string' && /^[A-Z0-9]{6}$/.test(rb.code) && !rooms[rb.code] && !others) {
        delete rooms[old]; r.code = rb.code; rooms[r.code] = r; p.room = r.code;
        const set = live.get(old);
        if (set) { live.delete(old); live.set(r.code, set); for (const x of set) x.room = r.code; }
      }
    }
    markDirty();
    send(c, { t: 'restored' });
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
  gcImgs(room);
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

// 清理:半年沒回來的存檔連同房間一起刪掉,資料才不會無限長大。
// (玩家的瀏覽器裡還有備份,回來時會自動還原。)
const STALE_MS = 180 * 86400000;
function prune() {
  const now = Date.now();
  let n = 0;
  for (const [key, p] of Object.entries(profiles)) {
    if (!p.seen) { p.seen = now; markDirty(); continue; } // 舊存檔沒有這個欄位:從現在開始算
    if (now - p.seen < STALE_MS || byKey.has(key)) continue;
    const r = rooms[p.room];
    if (r && r.ownerKey === key && !live.get(r.code)?.size) delete rooms[r.code];
    delete profiles[key]; n++;
  }
  for (const [code, r] of Object.entries(rooms)) if (!profiles[r.ownerKey] && !live.get(code)?.size) { delete rooms[code]; n++; } // 沒有主人的房間
  if (n) { markDirty(); console.log(`pruned ${n} stale saves/rooms`); }
}
prune();
setInterval(prune, 12 * 3600000);

// ---------- HTTP ----------
const PUBLIC = path.join(__dirname, 'public');
const STATIC = {
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
  '/game.js': ['game.js', 'text/javascript; charset=utf-8'],
  '/manifest.webmanifest': ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
};
const ICONS = /^\/icons\/([\w-]+\.png)$/;
const THREE_DIR = path.join(__dirname, 'node_modules', 'three');
const VRM_DIR = path.join(__dirname, 'node_modules', '@pixiv', 'three-vrm');
const pkgVer = (dir) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version; } catch { return '0'; } };
const THREE_VER = pkgVer(THREE_DIR), VRM_VER = pkgVer(VRM_DIR);
const sha = (buf, n = 10) => crypto.createHash('sha1').update(buf).digest('hex').slice(0, n);
// 模型檔的版本:啟動時算出每個檔案的內容雜湊寫進首頁,瀏覽器用「?v=雜湊」讀取。
// 內容不變網址就不變,可以永久快取;檔案一改網址跟著變,不會讀到舊的
const ASSET_VER = {};
for (const dir of ['studio', 'avatars', 'characters']) {
  let names = [];
  try { names = fs.readdirSync(path.join(PUBLIC, 'assets', dir)); } catch {}
  for (const f of names) if (/^[\w-]+\.(glb|vrm)$/.test(f)) ASSET_VER[`${dir}/${f}`] = sha(fs.readFileSync(path.join(PUBLIC, 'assets', dir, f)));
}
const IMMUTABLE = 'public, max-age=31536000, immutable';
// 首頁:把 three.js、主程式、樣式的網址都加上版本,並附上模型檔的版本表(主程式和樣式一改就重新產生)
let indexCache = null;
function renderIndex() {
  const files = ['index.html', 'game.js', 'style.css'].map((f) => path.join(PUBLIC, f));
  const key = files.map((f) => { const st = fs.statSync(f); return `${st.size}-${st.mtimeMs}`; }).join('|');
  if (indexCache?.key === key) return indexCache;
  const ver = { '/style.css': sha(fs.readFileSync(files[2]), 8), '/game.js': sha(fs.readFileSync(files[1]), 8) };
  const html = fs.readFileSync(files[0], 'utf8')
    .replaceAll('/vendor/three/', `/vendor/three@${THREE_VER}/`).replaceAll('/vendor/addons/', `/vendor/addons@${THREE_VER}/`)
    .replaceAll('/vendor/three-vrm.js', `/vendor/three-vrm@${VRM_VER}.js`)
    .replace('href="style.css"', `href="style.css?v=${ver['/style.css']}"`).replace('src="game.js"', `src="game.js?v=${ver['/game.js']}"`)
    .replace('<!--ASSETS-->', `<script>window.__ASSETS=${JSON.stringify(ASSET_VER)}</script>`);
  const buf = Buffer.from(html);
  return (indexCache = { key, ver, buf, gz: zlib.gzipSync(buf), etag: `"${sha(buf, 16)}"` });
}
const GZ = new Map(); // 壓縮結果快取(檔案有改就重新壓)
const server = http.createServer((req, res) => {
  const [url, query = ''] = req.url.split('?');
  if (url === '/healthz') return res.writeHead(200).end('ok');
  const wantGz = /gzip/.test(req.headers['accept-encoding'] || '');
  if (url === '/' || url === '/index.html') {
    let page;
    try { page = renderIndex(); } catch { return res.writeHead(500).end('error'); }
    const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache', ETag: page.etag, Vary: 'Accept-Encoding' };
    if (req.headers['if-none-match'] === page.etag) return res.writeHead(304, headers).end();
    return wantGz ? res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' }).end(page.gz) : res.writeHead(200, headers).end(page.buf);
  }
  // 房間裡自己上傳的海報/掛畫圖片(內容不會變,檔名就是內容雜湊,可以長期快取)
  const ri = /^\/roomimg\/([A-Z0-9]{6})\/([0-9a-f]{16})\.jpg$/.exec(url);
  if (ri) {
    const data = rooms[ri[1]]?.imgs?.[ri[2]];
    if (!data) return res.writeHead(404).end('Not found');
    const buf = Buffer.from(data, 'base64');
    return res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Content-Length': buf.length, 'Cache-Control': IMMUTABLE, 'X-Content-Type-Options': 'nosniff' }).end(buf);
  }
  // type:內容類型;file:檔案位置;fixed:網址帶著正確的版本,內容永遠不會變
  let type, file, fixed = false;
  const qv = /(?:^|&)v=([\w.-]+)/.exec(query)?.[1];
  if (STATIC[url]) { [file, type] = STATIC[url]; file = path.join(PUBLIC, file); try { fixed = !!qv && qv === renderIndex().ver[url]; } catch {} }
  const ic = ICONS.exec(url);
  if (ic) { type = 'image/png'; file = path.join(PUBLIC, 'icons', ic[1]); }
  // three.js 由 node_modules 提供(只開放白名單內的檔案);網址裡的 @版本 只是用來讓快取跟著版本走
  const v = /^\/vendor\/three(?:@([\w.-]+))?\/(three\.(?:module|core)\.js)$/.exec(url);
  if (v) { type = 'text/javascript; charset=utf-8'; file = path.join(THREE_DIR, 'build', v[2]); fixed = v[1] === THREE_VER; }
  const ad = /^\/vendor\/addons(?:@([\w.-]+))?\/((?:[\w-]+\/)*[\w-]+(?:\.[\w-]+)*\.js)$/.exec(url);
  if (ad) { type = 'text/javascript; charset=utf-8'; file = path.join(THREE_DIR, 'examples/jsm', ad[2]); fixed = ad[1] === THREE_VER; }
  const vr = /^\/vendor\/three-vrm(?:@([\w.-]+))?\.js$/.exec(url);
  if (vr) { type = 'text/javascript; charset=utf-8'; file = path.join(VRM_DIR, 'lib/three-vrm.module.min.js'); fixed = vr[1] === VRM_VER; }
  // 家具(原創)、角色模型(VRoid 範例角色,CC0)、音樂(CC0)
  const as = /^\/assets\/(studio|avatars|characters|music)\/([\w-]+\.(glb|vrm|txt|mp3))$/.exec(url);
  if (as) {
    const types = { glb: 'model/gltf-binary', vrm: 'application/octet-stream', txt: 'text/plain; charset=utf-8', mp3: 'audio/mpeg' };
    type = types[as[3]]; file = path.join(PUBLIC, 'assets', as[1], as[2]);
    fixed = !!qv && qv === ASSET_VER[`${as[1]}/${as[2]}`];
  }
  if (!file) return res.writeHead(404).end('Not found');
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) return res.writeHead(404).end('Not found');
    // 帶版本的網址永久快取;其他的讓瀏覽器每次問一下有沒有變(沒變就回 304,不必重新下載)
    const etag = `"${st.size.toString(36)}-${Math.floor(st.mtimeMs).toString(36)}"`;
    const headers = { 'Content-Type': type, 'Cache-Control': fixed ? IMMUTABLE : 'no-cache', ETag: etag };
    // 音樂:支援分段讀取(Range)。Safari 和 iOS 沒有這個就不肯播放,也才能拖曳進度
    if (type === 'audio/mpeg') {
      const base = { ...headers, 'Cache-Control': 'public, max-age=86400', 'Accept-Ranges': 'bytes' };
      const m = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
      if (!m || (!m[1] && !m[2])) { res.writeHead(200, { ...base, 'Content-Length': st.size }); return fs.createReadStream(file).pipe(res); }
      const start = m[1] ? +m[1] : Math.max(0, st.size - +m[2]), end = m[1] && m[2] ? Math.min(+m[2], st.size - 1) : st.size - 1;
      if (start > end || start >= st.size) return res.writeHead(416, { 'Content-Range': `bytes */${st.size}` }).end();
      res.writeHead(206, { ...base, 'Content-Range': `bytes ${start}-${end}/${st.size}`, 'Content-Length': end - start + 1 });
      return fs.createReadStream(file, { start, end }).pipe(res);
    }
    const gz = wantGz && /javascript|html|css|json|octet-stream|gltf-binary|plain/.test(type);
    if (gz) headers.Vary = 'Accept-Encoding';
    if (req.headers['if-none-match'] === etag) return res.writeHead(304, headers).end();
    const hit = gz && GZ.get(file);
    if (hit && hit.etag === etag) return res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' }).end(hit.out);
    fs.readFile(file, (e1, buf) => {
      if (e1) return res.writeHead(500).end('error');
      if (!gz) return res.writeHead(200, headers).end(buf);
      zlib.gzip(buf, (e2, out) => {
        if (e2) return res.writeHead(200, headers).end(buf);
        GZ.set(file, { etag, out });
        res.writeHead(200, { ...headers, 'Content-Encoding': 'gzip' }).end(out);
      });
    });
  });
});

const wss = new WebSocketServer({ server, maxPayload: 65536 }); // 還原備份時一次會送整份存檔
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
