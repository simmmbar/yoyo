# 🌙 悠悠自習室

線上多人的「專注小屋」:整個畫面就是一間立體的溫馨房間,角色坐在書桌前陪你專注。佈置房間、換角色造型、開番茄鐘,朋友可以用邀請連結進來一起自習。

## 功能

- **全螢幕房間與視角**:桌前、全景、側面三種視角與自動運鏡;拖曳可轉動鏡頭,滾輪或雙指縮放
- **專注計時**:番茄鐘(專注與休息自動循環)、倒數、正計時;開始後角色會走到椅子坐下,休息時站起來。計時在伺服器端,中途斷線回來仍會結算
- **狀態與待辦**:頭上顯示「正在做什麼」;待辦清單跟著雲端存檔
- **每日習慣**:每天打卡,顯示近 7 天紀錄與連續天數
- **專注統計**:今天、本週、連續天數、累計,以及近 7 天/近 30 天的每日專注分鐘圖表(依你當地的日期計算)
- **共同專注**:房主發起後,房間裡的人可以加入,大家同時開始、同時結束,完成後自動拍一張合照
- **多人同房間**:每個人有自己的房間與 6 碼房號,分享邀請連結即可即時看到彼此(每房最多 12 人)
- **房間佈置**:20 種家具(含牆面掛飾)全部直接可用,6 種牆面與地板;椅子會自動朝向旁邊的桌子;房主可開放朋友一起佈置
- **角色自訂**:6 種造型,可換膚色、髮色、上衣
- **表情與聊天**:表情符號為主,另有文字對話
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

倉庫附有 Render 的設定檔 `render.yaml`:在 Render 選「New > Blueprint」接上這個倉庫就能部署(免費方案閒置後會休眠,且存檔不會保留)。

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
