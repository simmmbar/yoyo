// 伺服器的自動測試:npm test
// 會開一個真的伺服器(隨機連接埠、暫存資料夾),用 WebSocket 走過主要功能。不需要瀏覽器。
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, startServer, connect, join, newToken } = require('./helpers');

let srv;
before(async () => { srv = await startServer(); });
after(async () => { await srv.stop(); });

const get = (p, headers) => fetch(srv.url + p, { headers });
const types = (msgs) => msgs.map((m) => m.t);
// 一張很小但合法的 JPEG(只有檔頭,伺服器只檢查大小和開頭)
const jpeg = (seed) => 'data:image/jpeg;base64,' + Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(200, seed)]).toString('base64');

// ---------- 網頁與檔案 ----------
test('首頁:模組、樣式、模型都帶著版本', async () => {
  const res = await get('/');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('cache-control'), 'no-cache');
  const html = await res.text();
  assert.match(html, /src="game\.js\?v=[0-9a-f]{8}"/);
  assert.match(html, /href="style\.css\?v=[0-9a-f]{8}"/);
  assert.match(html, /\/vendor\/three@[\d.]+\/three\.module\.js/);
  assert.ok(!html.includes('<!--ASSETS-->'), '版本表沒有寫進去');
  const assets = JSON.parse(/window\.__ASSETS=(\{.*?\})<\/script>/.exec(html)[1]);
  assert.ok(Object.keys(assets).length > 50);
  // 內容沒變就回 304
  assert.equal((await get('/', { 'If-None-Match': res.headers.get('etag') })).status, 304);
  // 首頁提到的每個檔案都讀得到
  for (const m of html.matchAll(/(?:href|src)="(\/vendor\/[^"]+|game\.js[^"]*|style\.css[^"]*|manifest\.webmanifest|icons\/[^"]+)"/g)) {
    const r = await get('/' + m[1].replace(/^\//, ''));
    assert.equal(r.status, 200, m[1]);
    await r.arrayBuffer();
  }
});

test('檔案快取:版本正確才永久快取,其餘每次確認;路徑不能跳出資料夾', async () => {
  const html = await (await get('/')).text();
  const assets = JSON.parse(/window\.__ASSETS=(\{.*?\})<\/script>/.exec(html)[1]);
  const v = assets['studio/desk.glb'];
  const good = await get(`/assets/studio/desk.glb?v=${v}`);
  assert.match(good.headers.get('cache-control'), /immutable/);
  await good.arrayBuffer();
  const stale = await get('/assets/studio/desk.glb?v=0000000000');
  assert.equal(stale.headers.get('cache-control'), 'no-cache');
  await stale.arrayBuffer();
  const plain = await get('/assets/studio/desk.glb');
  assert.equal(plain.headers.get('cache-control'), 'no-cache');
  await plain.arrayBuffer();
  assert.equal((await get('/assets/studio/desk.glb', { 'If-None-Match': plain.headers.get('etag') })).status, 304);
  const gameV = /src="(game\.js\?v=[0-9a-f]+)"/.exec(html)[1];
  const game = await get('/' + gameV);
  assert.match(game.headers.get('cache-control'), /immutable/);
  await game.arrayBuffer();
  const old = await get('/game.js?v=deadbeef');
  assert.equal(old.headers.get('cache-control'), 'no-cache');
  await old.arrayBuffer();
  for (const p of ['/server.js', '/package.json', '/assets/studio/../../server.js', '/assets/studio/%2e%2e/%2e%2e/server.js', '/vendor/addons/../../package.json', '/icons/..%2f..%2fserver.js', '/roomimg/AAAAAA/0000000000000000.jpg', '/data/profiles.json']) {
    assert.equal((await get(p)).status, 404, p);
  }
});

test('音樂支援分段讀取', async () => {
  const mp3 = fs.readdirSync(path.join(ROOT, 'public/assets/music')).find((f) => f.endsWith('.mp3'));
  const res = await get(`/assets/music/${mp3}`, { Range: 'bytes=100-199' });
  assert.equal(res.status, 206);
  assert.equal((await res.arrayBuffer()).byteLength, 100);
  assert.match(res.headers.get('content-range'), /^bytes 100-199\/\d+$/);
});

// ---------- 連線與房間 ----------
test('第一次連線:拿到新的存檔和一間佈置好的房間', async () => {
  const a = await join(srv);
  const m = a.init;
  assert.equal(m.fresh, true);
  assert.equal(m.room.mine, true);
  assert.match(m.room.code, /^[A-Z0-9]{6}$/);
  assert.ok(m.room.items.length > 10);
  assert.ok(Object.keys(m.catalog).length >= 50);
  assert.equal(m.players.length, 1);
  assert.equal(m.profile.totalMinutes, 0);
  assert.ok(!('imgs' in m.room), '圖片內容不該跟著房間資料送出');
  for (const it of m.room.items) assert.ok(m.catalog[it.type], `房間裡有型錄沒有的東西:${it.type}`);
  // 同一個存檔碼再連一次:不再是新存檔,舊的連線被請出去
  const again = await join(srv, a.token);
  assert.equal(again.init.fresh, false);
  assert.equal(again.init.room.code, m.room.code);
  await a.next('kicked');
  await again.close();
});

test('存檔碼格式不對會被拒絕', async () => {
  for (const token of ['short', 'has spaces in the token!!', 12345, '']) {
    const c = connect(srv, token);
    c.ready.catch(() => {});
    assert.equal((await c.next('error')).t, 'error');
    await c.close();
  }
});

test('擺放家具:合法的才會成功', async () => {
  const a = await join(srv);
  const count = () => a.room.items.length;
  const n0 = count(), plant = a.item('bigplant');
  assert.ok(plant, '預設房間應該有大盆栽');
  // 不合法的全部沒有反應
  for (const bad of [
    { type: 'nope', x: 0, y: 0 }, { type: 'bigplant', x: plant.x, y: plant.y }, // 不存在的種類、和原本那盆重疊
    { type: 'bigplant', x: a.init.cols, y: 0 }, { type: 'bigplant', x: -1, y: 0 }, { type: 'bigplant', x: 0, y: a.init.rows },
    { type: 'bigplant', x: '1', y: 0 }, { type: 'bigplant', x: 0.5, y: 0 }, { type: 'bigplant', x: null, y: 0 }, { type: 'bigplant' },
  ]) {
    assert.deepEqual(types(await a.act({ t: 'place', ...bad })), [], JSON.stringify(bad));
  }
  assert.equal(count(), n0);
  // 收回再放回原位
  await a.act({ t: 'remove_item', id: plant.id });
  assert.equal(count(), n0 - 1);
  await a.act({ t: 'place', type: 'bigplant', x: plant.x, y: plant.y, r: 1, c: 3 });
  assert.equal(count(), n0);
  const p2 = a.item('bigplant');
  assert.notEqual(p2.id, plant.id);
  assert.equal(p2.r, 1); assert.equal(p2.c, 3);
  // 移動:換色、轉向;超出範圍的顏色當成原色
  await a.act({ t: 'move_item', id: p2.id, x: p2.x, y: p2.y, r: 0, c: 99 });
  assert.equal(a.item('bigplant').r, undefined); assert.equal(a.item('bigplant').c, undefined);
  assert.deepEqual(types(await a.act({ t: 'move_item', id: 999999, x: 0, y: 0 })), []);
  // 桌上小物可以放在四分之一格,其他位置不行
  const small = a.item('tplant');
  await a.act({ t: 'remove_item', id: small.id });
  assert.deepEqual(types(await a.act({ t: 'place', type: 'tplant', x: small.x + 0.1, y: small.y })), []);
  assert.deepEqual(types(await a.act({ t: 'place', type: 'tplant', x: small.x, y: small.y })), ['room']);
  // 牆面掛飾只能掛在後面那面牆(y = 0)
  const poster = a.item('poster');
  assert.deepEqual(types(await a.act({ t: 'move_item', id: poster.id, x: poster.x, y: 1 })), []);
  // 壁紙與地板
  await a.act({ t: 'theme', wall: 3, floor: 2 });
  assert.equal(a.room.wall, 3); assert.equal(a.room.floor, 2);
  await a.act({ t: 'theme', wall: 99, floor: -1 });
  assert.equal(a.room.wall, 3); assert.equal(a.room.floor, 2);
  await a.close();
});

test('訪客:看得到房間,房主允許才能佈置', async () => {
  const a = await join(srv);
  const b = await join(srv, newToken(), a.room.code);
  assert.equal(b.init.room.mine, false);
  assert.equal(b.init.room.code, a.room.code);
  assert.equal(b.init.players.length, 2);
  assert.equal((await a.next('join')).p.id, b.init.me);
  const lamp = a.item('flamp');
  assert.deepEqual(types(await b.act({ t: 'remove_item', id: lamp.id })), []);
  assert.deepEqual(types(await b.act({ t: 'theme', wall: 4 })), []);
  assert.deepEqual(types(await b.act({ t: 'room_settings', guestsEdit: true })), []);
  assert.deepEqual(types(await b.act({ t: 'preset', key: 'bedroom' })), []);
  await a.act({ t: 'room_settings', guestsEdit: true });
  await b.sync();
  assert.equal(b.room.guestsEdit, true);
  await b.act({ t: 'remove_item', id: lamp.id });
  await a.sync();
  assert.ok(!a.room.items.some((i) => i.id === lamp.id), '房主應該看到訪客收回了立燈');
  assert.deepEqual(types(await b.act({ t: 'preset', key: 'bedroom' })), [], '成品房間只有房主能套用');
  // 找不到的房號會回到自己的房間並說明原因
  const c = await join(srv, newToken(), 'ZZZZZZ');
  assert.equal(c.init.room.mine, true);
  assert.match(c.init.notice, /找不到房間/);
  // 離開時其他人會收到通知
  await b.close();
  assert.equal((await a.next('leave')).id, b.init.me);
  await a.close(); await c.close();
});

test('房間最多 12 人,滿了會回到自己的房間', async () => {
  const a = await join(srv);
  const guests = [];
  for (let i = 0; i < 11; i++) guests.push(await join(srv, newToken(), a.room.code));
  const late = await join(srv, newToken(), a.room.code);
  assert.equal(late.init.room.mine, true);
  assert.match(late.init.notice, /客滿/);
  await Promise.all([a, late, ...guests].map((c) => c.close()));
});

// ---------- 個人資料 ----------
test('名字和造型:不合法的值會被忽略', async () => {
  const a = await join(srv);
  const before = a.init.profile.avatar;
  const [reply] = (await a.act({ t: 'profile', name: '  小\u0007明  ', avatar: { skin: 99, hair: 3, hairHex: '#AABBCC', eyeHex: 'red', headSize: 8, height: -1, acc: 2.5, nope: 1 } })).filter((m) => m.t === 'profile');
  assert.equal(reply.profile.name, '小 明');
  const av = reply.profile.avatar;
  assert.equal(av.hair, 3); assert.equal(av.hairHex, '#aabbcc'); assert.equal(av.headSize, 8);
  assert.equal(av.skin, before.skin); assert.equal(av.acc, before.acc);
  assert.equal(av.eyeHex, undefined); assert.equal(av.height, undefined); assert.equal(av.nope, undefined);
  const [long] = (await a.act({ t: 'profile', name: '很'.repeat(40) })).filter((m) => m.t === 'profile');
  assert.equal(long.profile.name.length, 16);
  const [empty] = (await a.act({ t: 'profile', name: '   ' })).filter((m) => m.t === 'profile');
  assert.equal(empty.profile.name.length, 16, '空白名字不會蓋掉原本的');
  await a.close();
});

test('狀態、聊天、表情、待辦、習慣', async () => {
  const a = await join(srv);
  const b = await join(srv, newToken(), a.room.code);
  await a.act({ t: 'status', text: 'x'.repeat(40), pose: 2 });
  let up = await b.next('pupdate');
  assert.equal(up.p.status.length, 24); assert.equal(up.p.pose, 2);
  await a.act({ t: 'status', pose: 9 });
  up = await b.next('pupdate');
  assert.equal(up.p.pose, 2);
  await a.act({ t: 'chat', text: '哈囉' + '!'.repeat(300) });
  const chat = await b.next('chat');
  assert.equal(chat.text.length, 200); assert.equal(chat.id, a.init.me);
  assert.deepEqual(types(await a.act({ t: 'chat', text: '   ' })), []);
  assert.deepEqual(types(await a.act({ t: 'emote', e: '👋' })), ['emote']);
  assert.deepEqual(types(await a.act({ t: 'emote', e: '🙂' })), []);
  // 待辦最多 30 筆、每筆 60 字;習慣最多 8 個,日期格式不對的會被丟掉
  await a.act({ t: 'todos', list: Array.from({ length: 40 }, (_, i) => ({ text: `事情 ${i} ` + '字'.repeat(80), done: i % 2 === 0 })).concat([{ text: '' }, null]) });
  await a.act({ t: 'habits', list: Array.from({ length: 12 }, (_, i) => ({ name: `習慣 ${i}`, days: ['2026-01-02', '2026-01-02', 'bad', 20260103, '2026-01-01'] })) });
  const [me] = (await a.act({ t: 'profile' })).filter((m) => m.t === 'profile');
  assert.equal(me.profile.todos.length, 30);
  assert.equal(me.profile.todos[0].text.length, 60); assert.equal(me.profile.todos[0].done, true);
  assert.equal(me.profile.habits.length, 8);
  assert.deepEqual(me.profile.habits[0].days, ['2026-01-01', '2026-01-02']);
  await a.close(); await b.close();
});

// ---------- 專注 ----------
test('專注計時:開始、結束、不合法的設定', async () => {
  const a = await join(srv);
  const b = await join(srv, newToken(), a.room.code);
  await a.next('join');
  for (const bad of [{ mode: 'pomo', minutes: 0, breakMin: 5 }, { mode: 'pomo', minutes: 25, breakMin: 0 }, { mode: 'down', minutes: 999 }, { mode: 'down', minutes: 'abc' }, { mode: 'nap', minutes: 10 }, {}]) {
    assert.deepEqual(types(await a.act({ t: 'focus_start', ...bad })), [], JSON.stringify(bad));
  }
  await a.act({ t: 'focus_start', mode: 'pomo', minutes: 25, breakMin: 5 });
  const up = await b.next('pupdate');
  assert.equal(up.p.focus.mode, 'pomo'); assert.equal(up.p.focus.phase, 'focus'); assert.equal(up.p.focus.round, 1);
  assert.ok(up.p.focus.left > 24 * 60000 && up.p.focus.left <= 25 * 60000);
  assert.deepEqual(types(await a.act({ t: 'focus_start', mode: 'down', minutes: 10 })), [], '已經在專注就不能再開始一次');
  const stop = await a.act({ t: 'focus_stop' });
  const done = stop.find((m) => m.t === 'focus_done');
  assert.equal(done.stopped, true); assert.equal(done.minutes, 0);
  assert.equal(stop.find((m) => m.t === 'pupdate').p.focus, null);
  assert.equal((await b.next('pupdate')).p.focus, null);
  assert.deepEqual(types(await a.act({ t: 'focus_stop' })), []);
  // 正計時
  await a.act({ t: 'focus_start', mode: 'up' });
  assert.equal((await b.next('pupdate')).p.focus.mode, 'up');
  await a.act({ t: 'focus_stop' });
  // 共同專注只有房主能發起;訪客可以加入,倒數中房主離開就是取消
  assert.ok((await b.act({ t: 'party_start', minutes: 25 })).some((m) => m.t === 'toast'));
  await a.act({ t: 'party_start', minutes: 25 });
  assert.equal((await b.next('party')).party.minutes, 25);
  const joined = (await b.act({ t: 'party_join' })).filter((m) => m.t === 'party').pop();
  assert.equal(joined.party.count, 2);
  await a.act({ t: 'party_leave' });
  await b.sync();
  assert.equal(b.msgs.filter((m) => m.t === 'party').pop().party, null);
  await a.close(); await b.close();
});

// ---------- 自己的海報與掛畫 ----------
test('海報換成自己的圖片', async () => {
  const a = await join(srv);
  const poster = a.item('poster'), painting = a.item('painting'), desk = a.item('kdesk');
  const img1 = jpeg(1);
  await a.act({ t: 'item_image', id: poster.id, img: img1 });
  const hash = a.item('poster').img;
  assert.match(hash, /^[0-9a-f]{16}$/);
  const res = await get(`/roomimg/${a.room.code}/${hash}.jpg`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'image/jpeg');
  assert.match(res.headers.get('cache-control'), /immutable/);
  assert.equal(Buffer.from(await res.arrayBuffer()).toString('base64'), img1.split(',')[1]);
  // 不能用的:不是海報或掛畫、不是 JPEG、內容不是圖片、太大、型別不對
  const wait = () => new Promise((r) => setTimeout(r, 850)); // 伺服器限制連續上傳的間隔
  for (const [id, img] of [
    [desk.id, img1], [painting.id, 'data:image/png;base64,iVBORw0KGgo='],
    [painting.id, 'data:image/jpeg;base64,' + Buffer.from('<script>alert(1)</script>'.repeat(10)).toString('base64')],
    [painting.id, 'data:image/jpeg;base64,' + 'A'.repeat(50000)], [painting.id, 123], [999999, img1],
  ]) {
    await wait();
    await a.act({ t: 'item_image', id, img });
    assert.equal(a.item('painting').img, undefined); assert.equal(a.item('kdesk').img, undefined);
  }
  // 沒有佈置權限的訪客不能換
  const b = await join(srv, newToken(), a.room.code);
  assert.equal(b.item('poster').img, hash, '訪客看得到房主換的圖');
  await b.act({ t: 'item_image', id: painting.id, img: jpeg(2) });
  await a.sync();
  assert.equal(a.item('painting').img, undefined);
  // 換一張:舊圖刪掉;還原:圖也刪掉
  await wait();
  await a.act({ t: 'item_image', id: poster.id, img: jpeg(3) });
  const hash2 = a.item('poster').img;
  assert.notEqual(hash2, hash);
  assert.equal((await get(`/roomimg/${a.room.code}/${hash}.jpg`)).status, 404);
  assert.equal((await get(`/roomimg/${a.room.code}/${hash2}.jpg`)).status, 200);
  await a.act({ t: 'item_image', id: poster.id, img: '' });
  assert.equal(a.item('poster').img, undefined);
  assert.equal((await get(`/roomimg/${a.room.code}/${hash2}.jpg`)).status, 404);
  // 收回家具:圖跟著刪掉
  await wait();
  await a.act({ t: 'item_image', id: painting.id, img: jpeg(4) });
  const hash3 = a.item('painting').img;
  await a.act({ t: 'remove_item', id: painting.id });
  assert.equal((await get(`/roomimg/${a.room.code}/${hash3}.jpg`)).status, 404);
  await a.close(); await b.close();
});

// ---------- 成品房間與備份還原 ----------
test('三組成品房間都擺得下,備份還原後一件不少', async () => {
  const a = await join(srv);
  for (const { key } of a.init.presets) {
    await a.act({ t: 'preset', key });
    const items = a.room.items.map(({ type, x, y, r, c }) => ({ type, x, y, r, c }));
    assert.ok(items.length > 10, key);
    // 還原時伺服器會把每一件重新檢查一次,擺不下的會被丟掉:數量一樣就代表整組都合法
    const fresh = await join(srv);
    await fresh.send({ t: 'restore', data: { name: '還原測試', totalMinutes: 90, sessions: 3, days: { '2026-01-05': 45, bad: 9 }, room: { code: 'TEST' + key.slice(0, 2).toUpperCase(), wall: a.room.wall, floor: a.room.floor, items } } });
    await fresh.next('restored');
    await fresh.close();
    const back = await join(srv, fresh.token);
    assert.equal(back.init.fresh, false);
    assert.equal(back.init.profile.name, '還原測試');
    assert.equal(back.init.profile.totalMinutes, 90);
    assert.deepEqual(back.init.profile.days, { '2026-01-05': 45 });
    assert.deepEqual(back.room.items.map(({ type, x, y, r, c }) => ({ type, x, y, r, c })), items, key);
    assert.equal(back.room.wall, a.room.wall);
    assert.match(back.room.code, /^TEST[A-Z]{2}$/, '房號應該換回備份裡的');
    await back.close();
  }
  await a.close();
});

test('還原只對全新的存檔有效一次', async () => {
  const a = await join(srv);
  await a.close();
  const again = await join(srv, a.token);
  await again.send({ t: 'restore', data: { name: '偷改', totalMinutes: 99999 } });
  const [me] = (await again.act({ t: 'profile' })).filter((m) => m.t === 'profile');
  assert.notEqual(me.profile.name, '偷改');
  assert.equal(me.profile.totalMinutes, 0);
  assert.ok(!again.msgs.some((m) => m.t === 'restored'));
  // 全新的存檔:第一次有效,第二次沒有反應;不合法的家具和數值會被丟掉
  const f = await join(srv);
  await f.send({ t: 'restore', data: { name: '第一次', totalMinutes: -5, room: { items: [{ type: 'nope', x: 0, y: 0 }, { type: 'kdesk', x: 99, y: 0 }, { type: 'kdesk', x: 1, y: 1 }, { type: 'kcase', x: 1, y: 1 }, null, 'x'] } } });
  await f.next('restored');
  await f.send({ t: 'restore', data: { name: '第二次' } });
  const [me2] = (await f.act({ t: 'profile' })).filter((m) => m.t === 'profile');
  assert.equal(me2.profile.name, '第一次');
  assert.equal(me2.profile.totalMinutes, 0);
  await f.close();
  const back = await join(srv, f.token);
  assert.deepEqual(back.room.items.map((i) => i.type), ['kdesk']);
  await back.close(); await again.close();
});

test('亂七八糟的訊息不會讓伺服器當掉', async () => {
  const a = await join(srv);
  for (const raw of ['', 'not json', '[]', 'null', '{"t":"__proto__"}', '{"t":"constructor"}', '{"t":"toString"}', '{"t":"place"}', '{"t":"move"}', '{"t":"move","x":"a","y":{}}', '{"t":"status","text":{"a":1}}', '{"t":"todos","list":"x"}', '{"t":"habits","list":[1,2,null]}', '{"t":"restore"}', '{"t":"item_image"}', '{"t":"party_join"}', '{"t":"hello","token":"another_token_1234567890"}']) a.ws.send(raw);
  await new Promise((r) => setTimeout(r, 2200)); // 等流量限制補回來
  const [me] = (await a.act({ t: 'profile' })).filter((m) => m.t === 'profile');
  assert.ok(me.profile.name);
  assert.equal((await get('/healthz')).status, 200);
  assert.ok(!/handler error/.test(srv.log()), srv.log());
  await a.close();
});

// ---------- 存檔 ----------
test('重新啟動後進度還在', async () => {
  const s1 = await startServer();
  const a = await join(s1);
  await a.act({ t: 'profile', name: '存檔測試' });
  await a.act({ t: 'theme', wall: 4 });
  await a.act({ t: 'remove_item', id: a.item('flamp').id });
  await a.act({ t: 'todos', list: [{ text: '寫測試', done: true }] });
  await a.act({ t: 'item_image', id: a.item('poster').id, img: jpeg(7) });
  const hash = a.item('poster').img, code = a.room.code, n = a.room.items.length;
  await a.close();
  await s1.stop();
  const s2 = await startServer(s1.dataDir);
  try {
    const b = await join(s2, a.token);
    assert.equal(b.init.fresh, false);
    assert.equal(b.init.profile.name, '存檔測試');
    assert.deepEqual(b.init.profile.todos, [{ text: '寫測試', done: true }]);
    assert.equal(b.room.code, code); assert.equal(b.room.wall, 4); assert.equal(b.room.items.length, n);
    assert.ok(!b.item('flamp'));
    assert.equal(b.item('poster').img, hash);
    assert.equal((await fetch(`${s2.url}/roomimg/${code}/${hash}.jpg`)).status, 200);
    await b.close();
  } finally { await s2.stop(); }
});
