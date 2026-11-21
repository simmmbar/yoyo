// 測試用的小工具:開一個真的伺服器(隨機連接埠、暫存資料夾),再用 WebSocket 假裝成玩家連上去
'use strict';
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');

const ROOT = path.join(__dirname, '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yoyo-test-'));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
}

// 啟動伺服器,等到 /healthz 有回應才算好。stop() 會送 SIGTERM(伺服器收到會先存檔)
async function startServer(dataDir = tmpDir()) {
  const port = await freePort();
  const proc = spawn(process.execPath, [path.join(ROOT, 'server.js')], { env: { ...process.env, PORT: String(port), DATA_DIR: dataDir }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  proc.stdout.on('data', (d) => { log += d; });
  proc.stderr.on('data', (d) => { log += d; });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; ; i++) {
    try { if ((await fetch(url + '/healthz')).ok) break; } catch {}
    if (proc.exitCode != null || i > 100) throw new Error('server did not start:\n' + log);
    await sleep(100);
  }
  return {
    port, url, dataDir, log: () => log,
    stop: () => new Promise((resolve) => { if (proc.exitCode != null) return resolve(); proc.once('exit', resolve); proc.kill('SIGTERM'); }),
  };
}

let seq = 0;
const newToken = (tag = 'test') => `${tag}_${Date.now().toString(36)}_${(seq++).toString(36)}_${'x'.repeat(16)}`;

// 一個玩家連線。伺服器限制每秒 10 則訊息(最多累積 20 則),send 會自己放慢速度不去撞到限制
function connect(srv, token = newToken(), room = '') {
  const ws = new WebSocket(`ws://127.0.0.1:${srv.port}`);
  const c = { ws, token, msgs: [], room: null, init: null, closed: false };
  const waiters = [];
  let read = 0, tokens = 16, last = Date.now();
  ws.on('message', (raw) => {
    const m = JSON.parse(raw);
    if (m.t === 'init') { c.init = m; c.room = m.room; }
    if (m.t === 'room' && c.room) Object.assign(c.room, m.room);
    c.msgs.push(m);
    for (const w of waiters.splice(0)) w();
  });
  ws.on('close', () => { c.closed = true; for (const w of waiters.splice(0)) w(); });
  ws.on('error', () => {});
  c.send = async (m) => {
    const now = Date.now();
    tokens = Math.min(16, tokens + ((now - last) / 1000) * 8); last = now;
    if (tokens < 1) { await sleep(((1 - tokens) / 8) * 1000); tokens = 1; last = Date.now(); }
    tokens -= 1;
    ws.send(JSON.stringify(m));
  };
  // 等下一則還沒讀過的指定類型訊息
  c.next = async (type, ms = 3000) => {
    const end = Date.now() + ms;
    for (;;) {
      for (; read < c.msgs.length; read++) if (c.msgs[read].t === type) return c.msgs[read++];
      if (c.closed || Date.now() > end) throw new Error(`no "${type}" message within ${ms} ms`);
      await Promise.race([new Promise((r) => waiters.push(r)), sleep(Math.max(1, end - Date.now()))]);
    }
  };
  // 伺服器照順序處理訊息:送一則一定會回覆的查詢,收到回覆就代表前面送的都處理完了
  c.sync = async () => {
    const mark = c.msgs.length;
    await c.send({ t: 'check', token: 'sync' });
    const end = Date.now() + 3000;
    for (;;) {
      if (c.msgs.slice(mark).some((m) => m.t === 'check')) return c.msgs.slice(mark).filter((m) => m.t !== 'check');
      if (c.closed || Date.now() > end) throw new Error('sync timed out');
      await Promise.race([new Promise((r) => waiters.push(r)), sleep(50)]);
    }
  };
  // 送出一則訊息,回傳伺服器處理完之前送來的所有訊息
  c.act = async (m) => { const mark = c.msgs.length; await c.send(m); await c.sync(); return c.msgs.slice(mark).filter((x) => x.t !== 'check'); };
  c.item = (type) => c.room.items.find((i) => i.type === type);
  c.close = () => new Promise((resolve) => { if (c.closed) return resolve(); ws.once('close', resolve); ws.close(); });
  c.ready = new Promise((resolve, reject) => {
    ws.once('error', reject);
    ws.once('open', async () => {
      try { await c.send({ t: 'hello', token, tz: 480, room }); await c.next('init'); resolve(c); } catch (e) { reject(e); }
    });
  });
  return c;
}
const join = (srv, token, room) => connect(srv, token, room).ready;

module.exports = { ROOT, sleep, tmpDir, startServer, connect, join, newToken };
