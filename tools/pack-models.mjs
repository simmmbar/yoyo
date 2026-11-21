// 把 Blender 匯出的家具模型壓小(頂點量化 + meshopt 壓縮),檔案大約剩三分之一。
// 用法:cd tools && npm install && node pack-models.mjs [資料夾] [模型名稱…]
// 預設處理 public/assets/studio 裡全部的 .glb;已經壓過的會跳過,所以可以重複執行。
// 重新跑 tools/blender/furniture.py 產生模型之後,記得再跑一次這支程式。
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { NodeIO } from '@gltf-transform/core';
import { EXTMeshoptCompression, KHRMeshQuantization } from '@gltf-transform/extensions';
import { meshopt } from '@gltf-transform/functions';
import { MeshoptEncoder, MeshoptDecoder } from 'meshoptimizer';

const here = path.dirname(fileURLToPath(import.meta.url));
const [dir = path.join(here, '../public/assets/studio'), ...only] = process.argv.slice(2);
await MeshoptEncoder.ready;
await MeshoptDecoder.ready;
const io = new NodeIO().registerExtensions([EXTMeshoptCompression, KHRMeshQuantization])
  .registerDependencies({ 'meshopt.encoder': MeshoptEncoder, 'meshopt.decoder': MeshoptDecoder });

// GLB 開頭的 JSON 區塊裡有沒有寫著已經用了 meshopt
function packed(buf) {
  const n = buf.readUInt32LE(12);
  return (JSON.parse(buf.subarray(20, 20 + n).toString('utf8')).extensionsUsed || []).includes('EXT_meshopt_compression');
}

let before = 0, after = 0, done = 0, skipped = 0;
for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.glb')).sort()) {
  if (only.length && !only.includes(f.replace(/\.glb$/, ''))) continue;
  const file = path.join(dir, f), src = fs.readFileSync(file);
  if (packed(src)) { skipped++; continue; }
  const doc = await io.readBinary(new Uint8Array(src));
  // 貼圖座標是以公尺為單位、會超出 0~1,量化會被略過(保留原本的精度),這個警告不用顯示
  doc.setLogger({ debug() {}, info() {}, warn(m) { if (!/TEXCOORD/.test(m)) console.warn(f, m); }, error(m) { console.error(f, m); } });
  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'high' }));
  const out = await io.writeBinary(doc);
  fs.writeFileSync(file, out);
  before += src.length; after += out.length; done++;
}
console.log(`packed ${done} file(s), skipped ${skipped} already packed` + (done ? `: ${(before / 1e6).toFixed(2)} MB -> ${(after / 1e6).toFixed(2)} MB` : ''));
