// 瀏覽器實測(選用):npm run test:browser
// 需要另外安裝 Playwright(npm i --no-save playwright && npx playwright install chromium);沒裝的話這些測試會自動跳過。
// 用真的瀏覽器開遊戲:載入、把每種家具擺一遍、每個面板和按鈕都按過,只要畫面上出現任何錯誤就算失敗。
// 沒有顯示卡的機器是用軟體算 3D,整套跑完要幾分鐘。
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, connect, newToken, sleep } = require('./helpers');

let playwright = null;
try { playwright = require('playwright'); } catch {}
const skip = playwright ? false : '沒有安裝 Playwright';
const opts = { skip, timeout: 900000 };

let srv, browser;
before(async () => {
  if (skip) return;
  srv = await startServer();
  browser = await playwright.chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--autoplay-policy=no-user-gesture-required'] });
});
after(async () => { await browser?.close(); await srv?.stop(); });

// 開一個分頁進遊戲,等房間出現。errors 會收集頁面上所有的錯誤
async function openGame(context, { query = '', token = newToken('browser') } = {}) {
  await context.addInitScript((t) => { localStorage.setItem('yoyo_token', t); localStorage.setItem('yoyo_quality', 'low'); localStorage.setItem('yoyo_tips', '1'); }, token);
  const page = await context.newPage(), errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text().slice(0, 300)); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message.slice(0, 300)));
  page.on('dialog', (d) => d.accept());
  await page.goto(srv.url + '/' + query);
  await page.waitForFunction(() => document.querySelector('#overlay').hidden, null, { timeout: 180000 });
  // 軟體算圖時畫面更新很慢,直接呼叫 click() 比模擬滑鼠可靠
  const click = (sel) => page.evaluate((s) => { const e = document.querySelector(s); if (!e) throw new Error('找不到 ' + s); e.click(); }, sel);
  return { page, errors, click, token };
}

test('載入:房間出現、沒有錯誤;第二次開啟全部走快取', opts, async () => {
  const context = await browser.newContext({ viewport: { width: 800, height: 520 } });
  const transfers = (page) => {
    const list = [];
    page.on('response', async (r) => {
      const u = new URL(r.url());
      if (/^\/(assets|vendor)\//.test(u.pathname)) list.push({ path: u.pathname, versioned: u.search.includes('v=') || u.pathname.includes('@'), cached: r.fromCache?.() ?? false, status: r.status() });
    });
    return list;
  };
  const first = await openGame(context);
  const got = transfers(first.page);
  await first.page.reload();
  await first.page.waitForFunction(() => document.querySelector('#overlay').hidden, null, { timeout: 180000 });
  await first.page.waitForTimeout(8000); // 其餘的家具在背景載完
  assert.deepEqual(first.errors, []);
  assert.ok(got.length > 30, `只看到 ${got.length} 個檔案`);
  for (const r of got) {
    assert.ok(r.status === 200 || r.status === 304, `${r.path} → ${r.status}`);
    assert.ok(r.versioned, `${r.path} 沒有帶版本,沒辦法長期快取`);
  }
  // 型錄在背景準備好:50 種家具都有卡片
  await first.click('#tabs [data-tab=decor]');
  await first.page.waitForFunction(() => document.querySelectorAll('#catalog .item').length >= 50, null, { timeout: 120000 });
  const blank = await first.page.evaluate(() => [...document.querySelectorAll('#catalog .item')].filter((card) => {
    const cv = card.querySelector('canvas'), d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data;
    for (let i = 3; i < d.length; i += 4) if (d[i]) return false;
    return true;
  }).map((card) => card.dataset.type));
  assert.deepEqual(blank, [], '這些家具的縮圖是空白的');
  assert.deepEqual(first.errors, []);
  await context.close();
});

test('每種家具、每個面板和按鈕都試過,沒有任何錯誤', opts, async () => {
  const context = await browser.newContext({ viewport: { width: 900, height: 560 } });
  const { page, errors, click } = await openGame(context);
  // 開放訪客佈置,另外用一個訪客連線把每種家具放進房間(比在畫面上一格一格點快得多)
  await click('#tabs [data-tab=decor]');
  await page.evaluate(() => { const c = document.querySelector('#guestsEdit'); if (!c.checked) c.click(); });
  const code = (await page.textContent('#roomCode')).trim();
  const guest = await connect(srv, newToken('guest'), code).ready;
  const { catalog, cols, rows } = guest.init;
  const placed = new Set();
  for (let round = 0; round < 4; round++) { // 四個方向各一輪,顏色輪流換
    for (const it of [...guest.room.items]) await guest.send({ t: 'remove_item', id: it.id });
    await guest.sync();
    for (const kind of ['floor', 'top', 'wall', 'rug']) {
      let x = 0, y = 0;
      for (const type of Object.keys(catalog).filter((t) => catalog[t].kind === kind)) {
        const d = catalog[type], r = kind === 'wall' ? 0 : round, w = r % 2 ? d.h : d.w, h = r % 2 ? d.w : d.h;
        for (let tries = 0; tries < 40; tries++) {
          if (x + w > cols) { x = 0; y += 1; }
          if (kind !== 'wall' && y + h > rows) break;
          const n = guest.room.items.length;
          await guest.act({ t: 'place', type, x, y: kind === 'wall' ? 0 : y, r, c: (round * 2 + x) % 8 });
          if (guest.room.items.length > n) { placed.add(type); x += w; break; }
          x += 1;
        }
      }
    }
    await page.waitForTimeout(2500); // 讓畫面把這一輪畫出來
    assert.deepEqual(errors, [], `第 ${round + 1} 輪擺放之後`);
  }
  assert.ok(placed.size >= 24, `只擺了 ${placed.size} 種`);
  // 把上面沒擺到的種類(地板擺滿了)再各擺一次
  for (const type of Object.keys(catalog).filter((t) => !placed.has(t))) {
    for (const it of guest.room.items.filter((i) => catalog[i.type].kind === catalog[type].kind)) await guest.send({ t: 'remove_item', id: it.id });
    await guest.act({ t: 'place', type, x: 0, y: 0 });
    if (guest.item(type)) placed.add(type);
    await page.waitForTimeout(400);
  }
  assert.equal(placed.size, Object.keys(catalog).length, '有家具擺不進空房間');
  await page.waitForTimeout(1500);
  assert.deepEqual(errors, [], '補擺之後');

  // 成品房間、分類、壁紙地板
  for (const i of [1, 2, 3]) { await click(`#presets2 button:nth-child(${i})`); await page.waitForTimeout(1200); }
  const groups = await page.$$eval('#catTabs button', (bs) => bs.length);
  for (let i = 0; i < groups; i++) await page.evaluate((n) => document.querySelectorAll('#catTabs button')[n].click(), i);
  for (const sw of ['#wallSwatches', '#floorSwatches']) for (let i = 0; i < 6; i++) { await page.evaluate(([s, n]) => document.querySelectorAll(s + ' button')[n].click(), [sw, i]); await page.waitForTimeout(300); }
  // 從型錄拿一件家具,在畫面上找位置放下去
  const before = guest.room.items.length;
  await click('#catTabs [data-g=rug]'); await click('.item[data-type=mat]');
  assert.equal(await page.evaluate(() => document.querySelector('#editBar').hidden), false);
  for (const [x, y] of [[300, 380], [380, 330], [450, 400], [250, 300], [350, 430]]) {
    await page.mouse.move(x, y); await page.waitForTimeout(250); await page.mouse.down(); await page.waitForTimeout(60); await page.mouse.up(); await page.waitForTimeout(600);
    await guest.sync();
    if (guest.room.items.length > before) break;
  }
  assert.ok(guest.room.items.length > before, '在畫面上點了五個位置都沒把踏墊放下去');
  await click('#editCancel');

  // 設定:光線、畫質、開關
  await click('#tabs [data-tab=settings]');
  for (const m of ['day', 'dusk', 'night', 'auto']) { await click(`#moods [data-mood=${m}]`); await page.waitForTimeout(600); }
  for (const q of ['high', 'low', 'auto']) { await click(`#quality [data-q=${q}]`); await page.waitForTimeout(600); }
  for (const s of ['#fxToggle', '#fxToggle', '#sfxToggle', '#sfxToggle', '#showCode']) await click(s);
  for (const t of ['avatar', 'chat', 'people', 'stats', 'settings', 'decor', 'avatar']) { await click(`#tabs [data-tab=${t}]`); await page.waitForTimeout(400); }
  // 角色:每一頁的每個選項、每條滑桿
  for (let tab = 0; tab < 3; tab++) {
    await page.evaluate((i) => document.querySelectorAll('#avatarTabs button')[i].click(), tab);
    const rowSizes = await page.evaluate(() => [...document.querySelectorAll('#avatarOptions .swatches')].map((r) => r.children.length));
    for (let row = 0; row < rowSizes.length; row++) for (let i = 0; i < rowSizes[row]; i++) {
      await page.evaluate(([t, r, n]) => {
        document.querySelectorAll('#avatarTabs button')[t].click();
        const e = document.querySelectorAll('#avatarOptions .swatches')[r].children[n];
        if (e.type === 'color') { e.value = '#3366cc'; e.dispatchEvent(new Event('change')); } else e.click();
      }, [tab, row, i]);
      await page.waitForTimeout(tab === 0 && row === 0 ? 2200 : 300); // 換造型要載入新的角色模型
    }
    const sliders = await page.evaluate(() => document.querySelectorAll('#avatarOptions .slider input').length);
    for (let n = 0; n < sliders; n++) for (const v of [8, 0, 4]) {
      await page.evaluate(([t, k, val]) => { document.querySelectorAll('#avatarTabs button')[t].click(); const e = document.querySelectorAll('#avatarOptions .slider input')[k]; e.value = val; e.dispatchEvent(new Event('change')); }, [tab, n, v]);
      await page.waitForTimeout(400);
    }
  }
  await page.waitForTimeout(3000);
  assert.deepEqual(errors, [], '換造型之後');
  await click('#drawerClose');

  // 視角、環境音、音樂、拍照
  for (const v of ['room', 'side', 'auto', 'desk']) { await click(`#views [data-view=${v}]`); await page.waitForTimeout(600); }
  await page.evaluate(() => document.querySelectorAll('#sounds button').forEach((x) => x.click())); await page.waitForTimeout(1200);
  await page.evaluate(() => document.querySelectorAll('#sounds button').forEach((x) => x.click()));
  for (const s of ['#mPlay', '#mNext', '#mPrev', '#mShuffle', '#mPlay', '#snapBtn']) { await click(s); await page.waitForTimeout(500); }
  await page.waitForFunction(() => !document.querySelector('#photo').hidden, null, { timeout: 60000 });
  await click('#photoClose');

  // 專注:三種模式、四種姿勢;訪客要看得到狀態
  for (const mode of ['down', 'up', 'pomo']) {
    await click(`#modes [data-mode=${mode}]`); await click('#focusBtn');
    await page.waitForFunction(() => document.querySelector('#focusBtn').textContent.includes('結束'), null, { timeout: 30000 });
    await guest.sync();
    const me = guest.msgs.filter((m) => m.t === 'pupdate').pop();
    assert.equal(me?.p.focus?.mode, mode, '訪客沒有看到專注狀態');
    for (const pose of [2, 3, 1, 0]) { await click(`#poses [data-pose="${pose}"]`); await page.waitForTimeout(500); }
    await click('#focusBtn');
    await page.waitForFunction(() => document.querySelector('#focusBtn').textContent.includes('開始'), null, { timeout: 30000 });
  }
  // 表情、聊天、統計、拖曳鏡頭、點地板走路
  await page.evaluate(() => document.querySelectorAll('#emotes button').forEach((x) => x.click()));
  await guest.send({ t: 'chat', text: '嗨,我是訪客' });
  await page.waitForFunction(() => document.querySelector('#chatLog')?.textContent.includes('我是訪客'), null, { timeout: 30000 });
  await click('#tabs [data-tab=stats]'); await click('#chartRange [data-days="30"]'); await click('#drawerClose'); await click('#listTabs [data-list=habit]');
  await page.mouse.move(450, 300); await page.mouse.down(); await page.mouse.move(200, 350, { steps: 5 }); await page.mouse.up(); await page.mouse.wheel(0, 400); await page.mouse.click(500, 420);
  await page.waitForTimeout(2500);
  assert.deepEqual(errors, []);
  await guest.close();
  await context.close();
});

test('手機尺寸:載入、打開面板、開始專注都正常', opts, async () => {
  const context = await browser.newContext({ ...playwright.devices['iPhone 13'] });
  const { page, errors, click } = await openGame(context);
  await page.waitForTimeout(4000);
  for (const t of ['decor', 'avatar', 'settings']) { await click(`#tabs [data-tab=${t}]`); await page.waitForTimeout(600); }
  // 佈置面板開著時,編輯列要在面板上方、完整留在畫面裡
  await click('#tabs [data-tab=decor]'); await click('#catTabs [data-g=wall]'); await click('.item[data-type=poster]');
  const box = await page.evaluate(() => {
    const r = document.querySelector('#editBar').getBoundingClientRect(), d = document.querySelector('#drawer').getBoundingClientRect();
    return { left: r.left, right: r.right, bottom: r.bottom, drawerTop: d.top, width: innerWidth };
  });
  assert.ok(box.bottom <= box.drawerTop + 1 && box.left >= 0 && box.right <= box.width, JSON.stringify(box));
  await click('#editCancel'); await click('#drawerClose');
  await click('#focusBtn');
  await page.waitForFunction(() => document.querySelector('#focusBtn').textContent.includes('結束'), null, { timeout: 30000 });
  await sleep(3000);
  await click('#focusBtn');
  assert.deepEqual(errors, []);
  await context.close();
});
