# 🌙 悠悠自習室

線上多人的「專注小屋」:立體等角視角的溫馨房間,佈置自己的房間、捏一個角色、開番茄鐘專注,朋友可以用邀請連結進來一起自習。

## 功能

- **多人同房間**:每個人有自己的房間與 6 碼房號,分享邀請連結即可即時看到彼此(每房最多 12 人)
- **專注計時**:15 / 25 / 45 / 60 分鐘或自訂;每專注 1 分鐘得 1 金幣,計時在伺服器端,中途斷線回來仍會結算
- **房間佈置**:20 種家具(含牆面掛飾)、6 種牆面與地板;金幣可解鎖新家具;房主可開放朋友一起佈置
- **角色自訂**:6 種造型,可換膚色、髮色、上衣;有走路、待機、坐下專注的動畫
- **聊天與表情**:文字對話泡泡、表情符號
- **雲端存檔**:進度存在伺服器,用「存檔碼」可在其他裝置接續
- **環境音**:雨聲、白噪音、輕音樂(瀏覽器即時合成,不需音檔)

## 執行

需要 Node.js 18 以上,以及支援 WebGL 的瀏覽器。

```bash
npm install
npm start
# 打開 http://localhost:3000
```

環境變數:

| 變數 | 預設 | 說明 |
| --- | --- | --- |
| `PORT` | `3000` | 監聽埠 |
| `DATA_DIR` | `./data` | 存檔位置(`profiles.json`、`rooms.json`) |

## 部署

這是一個單一 Node 行程(HTTP + WebSocket),可部署到任何支援 WebSocket 的平台(Render、Railway、Fly.io、自己的 VPS 等),啟動指令為 `npm start`。

存檔寫在 `DATA_DIR` 的 JSON 檔裡,部署時請把它指到**持久化磁碟**,否則重新部署後存檔會消失。純靜態主機(如 GitHub Pages)無法執行,因為需要伺服器。

## 結構

```
server.js          伺服器:靜態檔案、WebSocket 協定、驗證與存檔
public/index.html  頁面
public/style.css   樣式
public/game.js     3D 場景(three.js)、連線、計時、佈置、聊天、環境音
```

## 素材授權

- 家具模型:[KayKit Furniture Bits](https://github.com/KayKit-Game-Assets/KayKit-Furniture-Bits-1.0)(作者 Kay Lousberg,www.kaylousberg.com),CC0。檔案在 `public/assets/kaykit/`。
- 角色模型與動畫:Ultimate Animated Character Pack(作者 Quaternius,quaternius.com),CC0。檔案在 `public/assets/characters/`。
- 窗戶、電視與電視櫃:Furniture Kit 2.0(作者 Kenney,kenney.nl),CC0。
- 貓咪:Quaternius 的動物模型,CC0。
- 時鐘:Poly Haven 的「Wall Clock」(作者 PierreB3D),CC0。以上幾項在 `public/assets/extra/`。
- 各資料夾內有 `LICENSE.txt`。
