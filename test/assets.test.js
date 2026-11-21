// 檢查模型檔和程式對得起來:npm test
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ROOT, startServer, join } = require('./helpers');

const game = fs.readFileSync(path.join(ROOT, 'public/game.js'), 'utf8');
const studio = path.join(ROOT, 'public/assets/studio');
// 前端的家具對照表(種類 → 模型檔名),從 game.js 裡的 ITEMS 讀出來
const itemsSrc = game.slice(game.indexOf('const ITEMS = {'), game.indexOf('const SFILES'));
const modelOf = (type) => new RegExp(`\\b${type}: \\{ m: '(\\w+)'`).exec(itemsSrc)?.[1];
const glbJson = (file) => { const b = fs.readFileSync(file); return JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8')); };

test('前端用到的模型檔都在,而且都壓縮過', () => {
  const names = new Set([...itemsSrc.matchAll(/\bm: '(\w+)'/g)].map((m) => m[1]).concat(['door', 'cat_walk', 'pendant']));
  assert.ok(names.size > 40);
  for (const n of names) assert.ok(fs.existsSync(path.join(studio, n + '.glb')), `缺少模型 ${n}.glb`);
  for (const f of fs.readdirSync(studio).filter((x) => x.endsWith('.glb'))) {
    assert.ok((glbJson(path.join(studio, f)).extensionsUsed || []).includes('EXT_meshopt_compression'), `${f} 還沒壓縮:重新產生模型後要執行 tools/pack-models.mjs`);
  }
});

test('型錄裡每種家具前端都畫得出來', async () => {
  const srv = await startServer();
  try {
    const a = await join(srv);
    const drawn = /const RUGS = \{([\s\S]*?)\};/.exec(game)[1]; // 地毯和霓虹燈是程式畫的,沒有模型檔
    for (const type of Object.keys(a.init.catalog)) {
      assert.ok(modelOf(type) || new RegExp(`\\b${type}: \\{`).test(drawn) || type === 'neon', `前端不認得家具 ${type}`);
    }
    // 首頁會提早下載預設書房用到的模型,那份清單要和實際的房間一致
    const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
    const first = /var first = \[([^\]]+)\]/.exec(html)[1].split(',').map((s) => s.trim().replace(/'/g, ''));
    const need = new Set(['door', 'pendant']);
    for (const it of a.init.room.items) { const m = modelOf(it.type); if (m) need.add(m); if (it.type === 'cat') need.add('cat_walk'); }
    assert.deepEqual([...first].sort(), [...need].sort(), 'public/index.html 裡的 first 清單要跟著預設房間更新');
    await a.close();
  } finally { await srv.stop(); }
});

test('首頁要預先載入的模組都存在', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  const pre = [...html.matchAll(/rel="modulepreload" href="\/vendor\/addons\/([^"]+)"/g)].map((m) => m[1]);
  assert.ok(pre.length >= 10);
  for (const f of pre) assert.ok(fs.existsSync(path.join(ROOT, 'node_modules/three/examples/jsm', f)), f);
  for (const m of game.matchAll(/from 'three\/addons\/([^']+)'/g)) assert.ok(pre.includes(m[1]), `${m[1]} 沒有列在首頁的 modulepreload`);
});
