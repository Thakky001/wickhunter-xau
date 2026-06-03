# WickHunter XAU — คู่มือติดตั้งและใช้งาน

บอทสแกนทองคำ (XAU/USD) ด้วยแนวคิด SMC (Smart Money Concepts) ส่งแจ้งเตือนผ่าน Telegram มี Dashboard แบบ Real-time และบันทึกลง Google Sheets (ถ้าตั้งค่า)

> **ระบบ Hybrid API:** Twelve Data ดึงแท่งเทียนย้อนหลัง (H1 / M5) + Finnhub WebSocket ดักราคา Real-time  
> **รันบน Cloud ฟรีได้:** Render + UptimeRobot — ไม่ต้องเปิดคอมทิ้งไว้ ไม่ต้องเช่า VPS

---

## สารบัญ

1. [ภาพรวมระบบ](#ภาพรวมระบบ)
2. [สิ่งที่ต้องเตรียม](#สิ่งที่ต้องเตรียม)
3. [Phase 1 — หา API Keys และ Token](#phase-1--หา-api-keys-และ-token)
4. [Phase 2 — ติดตั้งบนเครื่องตัวเอง](#phase-2--ติดตั้งบนเครื่องตัวเอง)
5. [Phase 3 — ตั้งค่า Google Sheets (ไม่บังคับ)](#phase-3--ตั้งค่า-google-sheets-ไม่บังคับ)
6. [Phase 4 — ทดสอบรันบนเครื่อง](#phase-4--ทดสอบรันบนเครื่อง)
7. [Phase 5 — Deploy บน Render](#phase-5--deploy-บน-render)
8. [Phase 6 — Keep-Alive ด้วย UptimeRobot](#phase-6--keep-alive-ด้วย-uptimerobot)
9. [การใช้งานหลังติดตั้ง](#การใช้งานหลังติดตั้ง)
10. [แก้ปัญหาเบื้องต้น](#แก้ปัญหาเบื้องต้น)

---

## ภาพรวมระบบ

```
wickhunter-xau/
├── server.js                 # Express + Dashboard (SSE) + เริ่มบอท
├── package.json
├── .env                      # กุญแจทั้งหมด (ห้ามอัปขึ้น Git)
├── config/
│   └── keys.js               # อ่านค่าจาก process.env
├── public/
│   └── index.html            # Live Dashboard (เปิดผ่านเบราว์เซอร์)
├── services/
│   ├── finnhubWs.js          # WebSocket ราคา Real-time
│   ├── twelveData.js         # REST API แท่งเทียน H1 / M5
│   ├── telegram.js           # ส่งข้อความแจ้งเตือน
│   ├── sheets.js             # บันทึก Google Sheets + ใส่หัวตารางอัตโนมัติ
│   └── dashboardState.js     # สถานะสำหรับ Dashboard
└── logic/
    ├── smcMath.js            # คำนวณ FVG, OB, PA, ChoCh
    └── smcEngine.js          # State machine + สแกนทุก 2 นาที
```

**ลำดับการทำงานเมื่อสตาร์ทเซิร์ฟเวอร์**

1. เปิดพอร์ต Express → เสิร์ฟ Dashboard ที่ `public/`
2. เชื่อม Google Sheets (ถ้ามี `GOOGLE_SHEET_ID` + `GOOGLE_CREDENTIALS`) → ใส่หัวตารางแถว 1 ถ้ายังว่าง
3. เปิด Finnhub WebSocket สมัครรับ `OANDA:XAU_USD`
4. ทุก **2 นาที** สแกนโซน H1 + แท่ง M5 → อัปเดต Sheets / Dashboard
5. ทุก **Tick ราคา** ตรวจเบรกไส้ / ยกเลิกสัญญาณ → ส่ง Telegram + บันทึก Sheets

**ประเภทสัญญาณที่บันทึก**

| ประเภท | ความหมาย |
|--------|----------|
| `PRE_ALERT` | พบ PA + ChoCh ในโซน รอเบรกปลายไส้ |
| `INVALIDATED` | ราคาทะลุ SL ขอบโซนก่อนเบรก |
| `TRIGGERED` | เบรกปลายไส้สำเร็จ (หรือปิดแท่ง PA ยืนยัน) เริ่มเข้าเทรด |
| `TP1_HIT` | ชนเป้าหมายแรก TP1 (ขยับ SL ไปบังหน้าทุน Breakeven) |
| `TP2_HIT` | ชนเป้าหมายสอง TP2 (ปิดไม้ทำกำไรสูงสุด กลับไป SCANNING) |
| `SL_HIT` | ชน Stop Loss (หรือชนเท่าทุนถ้าเลื่อน SL บังทุนแล้ว กลับไป SCANNING) |
| `EXPIRED` | สัญญาณหมดอายุเพราะรอเบรกนานเกิน 15 นาที |

---

## สิ่งที่ต้องเตรียม

| บริการ | จำเป็น | ใช้ทำอะไร |
|--------|--------|-----------|
| [Node.js](https://nodejs.org) (LTS) | ใช่ | รันโปรเจกต์บนเครื่อง / Render ใช้ Node |
| [Finnhub](https://finnhub.io) | ใช่ | ราคา Real-time (WebSocket) |
| [Twelve Data](https://twelvedata.com) | ใช่ | แท่งเทียน H1 / M5 (ฟรี ~800 ครั้ง/วัน) |
| Telegram | ใช่ | แจ้งเตือนสัญญาณ |
| [Google Cloud](https://console.cloud.google.com) + Google Sheets | ไม่บังคับ | บันทึกสัญญาณและสถานะบอท |
| [GitHub](https://github.com) | สำหรับ Deploy | เก็บโค้ด |
| [Render](https://render.com) | สำหรับ Cloud | รัน 24 ชม. แบบฟรี |
| [UptimeRobot](https://uptimerobot.com) | แนะนำมาก | กันเซิร์ฟเวอร์ Render หลับ |

---

## Phase 1 — หา API Keys และ Token

### 1.1 Telegram Bot Token และ Chat ID

1. เปิด Telegram ค้นหา **@BotFather**
2. ส่ง `/newbot` แล้วตั้งชื่อบอทตามที่ BotFather ถาม
3. คัดลอก **Token** ที่ได้ (รูปแบบ `123456789:ABCdef...`) → ใส่ใน `.env` เป็น `TELEGRAM_BOT_TOKEN`
4. ค้นหา **@userinfobot** (หรือบอท GetIDs) กด **Start**
5. คัดลอก **Id** ตัวเลขของคุณ → ใส่เป็น `TELEGRAM_CHAT_ID`
6. เปิดแชทกับบอทที่สร้างแล้วกด **Start** อย่างน้อย 1 ครั้ง (ไม่งั้นบอทส่งข้อความหาคุณไม่ได้)

### 1.2 Finnhub API Key

1. สมัครที่ [finnhub.io](https://finnhub.io) → **Get free API Key**
2. ในหน้า Dashboard คัดลอก API Key → ใส่เป็น `FINNHUB_API_KEY`

### 1.3 Twelve Data API Key

1. สมัครที่ [twelvedata.com](https://twelvedata.com)
2. เมนู **API Keys** → คัดลอก Key → ใส่เป็น `TWELVEDATA_API_KEY`

> **หมายเหตุ:** แผนฟรี Twelve Data มีโควต้าต่อวัน บอทสแกนทุก 2 นาที + ดึง H1 รายชั่วโมง — ถ้าโควต้าหมด Log จะขึ้นว่าดึงแท่งเทียนไม่สำเร็จ

---

## Phase 2 — ติดตั้งบนเครื่องตัวเอง

### 2.1 ติดตั้ง Node.js

1. ดาวน์โหลด **LTS** จาก [nodejs.org](https://nodejs.org)
2. ติดตั้งตาม Wizard (ติ๊ก Add to PATH)
3. เปิด Terminal / PowerShell แล้วตรวจสอบ:

```bash
node -v
npm -v
```

ต้องเห็นเลขเวอร์ชัน (เช่น `v20.x.x`) ถ้าไม่ขึ้น ให้ปิดเปิด Terminal ใหม่

### 2.2 ดาวน์โหลดโปรเจกต์

**แบบ A — Clone จาก GitHub**

```bash
git clone https://github.com/ชื่อผู้ใช้/wickhunter-xau.git
cd wickhunter-xau
```

**แบบ B — มีโฟลเดอร์อยู่แล้ว**

```bash
cd path/to/wickhunter-xau
```

### 2.3 ติดตั้ง Dependencies

รันคำสั่งเดียวในโฟลเดอร์โปรเจกต์ (ระดับเดียวกับ `server.js`):

```bash
npm install
```

คำสั่งนี้จะติดตั้งตาม `package.json` ได้แก่ `express`, `ws`, `axios`, `dotenv`, `googleapis` เป็นต้น

### 2.4 สร้างไฟล์ `.env`

สร้างไฟล์ชื่อ `.env` ที่**โฟลเดอร์ราก** (ข้าง `server.js`) แล้วใส่ค่าตามนี้:

```env
# พอร์ตเซิร์ฟเวอร์ (บน Render ไม่ต้องใส่ก็ได้ — Render กำหนดให้)
PORT=8080

# บังคับ — บอททำงานไม่ได้ถ้าขาด
FINNHUB_API_KEY=ใส่คีย์_Finnhub
TWELVEDATA_API_KEY=ใส่คีย์_TwelveData
TELEGRAM_BOT_TOKEN=ใส่_Token_บอท
TELEGRAM_CHAT_ID=ใส่_Chat_ID

# ไม่บังคับ — ถ้าไม่ใส่ ระบบข้าม Google Sheets
GOOGLE_SHEET_ID=
GOOGLE_CREDENTIALS=
```

| ตัวแปร | บังคับ | คำอธิบาย |
|--------|--------|----------|
| `PORT` | ไม่ (ค่าเริ่มต้น 8080) | พอร์ต Express |
| `FINNHUB_API_KEY` | ใช่ | WebSocket ราคาทอง |
| `TWELVEDATA_API_KEY` | ใช่ | แท่งเทียน XAU/USD |
| `TELEGRAM_BOT_TOKEN` | ใช่ | Token จาก BotFather |
| `TELEGRAM_CHAT_ID` | ใช่ | ID ผู้รับข้อความ |
| `GOOGLE_SHEET_ID` | ไม่ | ID ของ Spreadsheet |
| `GOOGLE_CREDENTIALS` | ไม่ | JSON ของ Service Account (หรือ Base64) |

### 2.5 สร้างไฟล์ `.gitignore`

สร้างไฟล์ `.gitignore` ที่รากโปรเจกต์:

```
node_modules
.env
```

> **สำคัญ:** ห้าม commit ไฟล์ `.env` หรือ JSON ของ Google Service Account ขึ้น GitHub

---

## Phase 3 — ตั้งค่า Google Sheets (ไม่บังคับ)

ถ้าไม่ต้องการบันทึกลง Sheet ให้**ข้าม Phase นี้ทั้งหมด** — บอทยังส่ง Telegram และ Dashboard ได้ตามปกติ

### 3.1 สร้าง Google Spreadsheet

1. เปิด [Google Sheets](https://sheets.google.com) → สร้างสเปรดชีตใหม่
2. ตั้งชื่อแท็บ (ชีตด้านล่าง) ให้ตรงเป๊ะ **2 แท็บ**:
   - `Signals` — เก็บประวัติสัญญาณ (เพิ่มแถวเรื่อยๆ)
   - `BotStatus` — สถานะบอทล่าสุด (อัปเดตแถว 2 ซ้ำ)
3. คัดลอก **Spreadsheet ID** จาก URL  
   รูปแบบ: `https://docs.google.com/spreadsheets/d/XXXXXXXXXX/edit`  
   ส่วน `XXXXXXXXXX` คือ `GOOGLE_SHEET_ID`

> **หัวตารางและแท็บ (Tab):** ไม่ต้องสร้างหรือพิมพ์หัวตารางเองเลยครับ — บอทจะทำการตรวจสอบตอนสตาร์ทเซิร์ฟเวอร์ หากยังไม่มีแท็บ Signals หรือ BotStatus บอทจะสั่งสร้างแท็บใหม่พร้อมใส่แถวหัวตารางให้อัตโนมัติทันที

| แท็บ | แถวหัว (อัตโนมัติ) | ข้อมูลเขียนที่ |
|------|-------------------|----------------|
| `Signals` | เวลา, โซน, ทิศทาง, Entry, SL, TP1, TP2, ราคาปัจจุบัน, ประเภท | แถวถัดไป (append) |
| `BotStatus` | เวลา, สถานะบอท, จำนวนโซน, ปิด M5 ล่าสุด, WebSocket | แถว 2 (ทับค่าเดิม) |

### 3.2 สร้าง Service Account บน Google Cloud

1. เปิด [Google Cloud Console](https://console.cloud.google.com)
2. สร้างโปรเจกต์ใหม่ (หรือใช้โปรเจกต์เดิม)
3. เมนู **APIs & Services** → **Library** → ค้นหา **Google Sheets API** → กด **Enable**
4. **APIs & Services** → **Credentials** → **Create Credentials** → **Service account**
5. ตั้งชื่อ → กด **Done** (ข้าม Role ได้)
6. คลิก Service Account ที่สร้าง → แท็บ **Keys** → **Add key** → **Create new key** → **JSON** → ดาวน์โหลดไฟล์ `.json`

### 3.3 แชร์ Spreadsheet ให้ Service Account

1. เปิดไฟล์ JSON ที่ดาวน์โหลด หาค่า `"client_email"` (อีเมลลงท้าย `@...iam.gserviceaccount.com`)
2. กลับไปที่ Google Spreadsheet → ปุ่ม **Share**
3. วางอีเมล Service Account → สิทธิ์ **Editor** → ส่งคำเชิญ

ถ้าไม่แชร์ บอทจะเชื่อมต่อได้แต่เขียนข้อมูลไม่ได้

### 3.4 ใส่ค่าใน `.env` (เครื่องตัวเอง)

**วิธีที่ 1 — JSON บรรทัดเดียว (เหมาะกับเครื่องตัวเอง)**

เปิดไฟล์ JSON ทั้งไฟล์ ย่อเป็นบรรทัดเดียว (ลบขึ้นบรรทัดใหม่) แล้วใส่ใน `.env`:

```env
GOOGLE_SHEET_ID=XXXXXXXXXXXXXXXX
GOOGLE_CREDENTIALS={"type":"service_account","project_id":"..."}
```

**วิธีที่ 2 — Base64 (เหมาะกับ Render)**

บน PowerShell (Windows):

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("path\to\service-account.json"))
```

นำสตริงที่ได้ไปใส่:

```env
GOOGLE_CREDENTIALS=สตริง_Base64_ยาวๆ
```

โค้ดจะลอง decode Base64 ก่อน ถ้าไม่ได้จึง parse เป็น JSON ตรงๆ

---

## Phase 4 — ทดสอบรันบนเครื่อง

### 4.1 สตาร์ทเซิร์ฟเวอร์

```bash
node server.js
```

### 4.2 Log ที่ควรเห็น (ปกติ)

```
======================================
🚀 WickHunter XAU Server Run on Port 8080
======================================

✅ [Sheets]: เชื่อมต่อ Google Sheets สำเร็จ    ← มีเฉพาะตั้ง Sheets แล้ว
✅ [Sheets]: ตรวจสอบหัวตารางเรียบร้อย
🔗 WebSocket Connected: WickHunter กำลังดักซุ่มราคา OANDA:XAU_USD...
```

ถ้า**ไม่ได้ตั้ง Sheets** จะเห็น:

```
⚠️  [Sheets]: GOOGLE_CREDENTIALS หรือ GOOGLE_SHEET_ID ไม่ได้ตั้งค่า → ข้าม Google Sheets
```

### 4.3 เปิด Dashboard

เปิดเบราว์เซอร์:

- หน้าหลัก / Keep-Alive: `http://localhost:8080/`
- **Live Dashboard:** `http://localhost:8080/index.html`
- สถานะ JSON: `http://localhost:8080/status`
- Real-time (SSE): `http://localhost:8080/events`

Dashboard อัปเดตผ่าน Server-Sent Events ไม่ต้องรีเฟรชเอง

### 4.4 ทดสอบ Telegram

รอให้บอทสแกนหรือเกิดสัญญาณ — ถ้า Token / Chat ID ถูกต้อง ข้อความจะเข้า Telegram  
ถ้าไม่เข้า: ตรวจว่ากด Start กับบอทแล้ว และ `TELEGRAM_CHAT_ID` เป็นตัวเลขของคุณจริง

---

## Phase 5 — Deploy บน Render

### 5.1 อัปโหลดโค้ดขึ้น GitHub

1. สร้าง Repository บน GitHub (Private หรือ Public)
2. Push โค้ดทั้งโฟลเดอร์ **ยกเว้น** `node_modules` และ `.env`

```bash
git init
git add .
git commit -m "Initial commit"
git remote add origin https://github.com/ชื่อผู้ใช้/wickhunter-xau.git
git push -u origin main
```

### 5.2 สร้าง Web Service บน Render

1. ล็อกอิน [render.com](https://render.com) → **New +** → **Web Service**
2. เชื่อม GitHub Repo ของโปรเจกต์
3. ตั้งค่า:

| ฟิลด์ | ค่า |
|-------|-----|
| Name | `wickhunter-xau` (หรือชื่ออื่น) |
| Environment | `Node` |
| Build Command | `npm install` |
| Start Command | `node server.js` |
| Instance Type | `Free` |

### 5.3 Environment Variables บน Render

กด **Environment** → **Add Environment Variable** — ใส่ทีละตัว (ชื่อต้องตรง):

| Key | จำเป็น | หมายเหตุ |
|-----|--------|----------|
| `FINNHUB_API_KEY` | ใช่ | |
| `TWELVEDATA_API_KEY` | ใช่ | |
| `TELEGRAM_BOT_TOKEN` | ใช่ | |
| `TELEGRAM_CHAT_ID` | ใช่ | |
| `GOOGLE_SHEET_ID` | ไม่ | ถ้าใช้ Sheets |
| `GOOGLE_CREDENTIALS` | ไม่ | แนะนำใส่เป็น **Base64** ของไฟล์ JSON |

> **อย่าอัปไฟล์ `.env` ขึ้น Git** — ใส่กุญแจเฉพาะใน Render Environment Variables

### 5.4 Deploy และตรวจ Log

1. กด **Create Web Service**
2. รอ Build ประมาณ 2–5 นาที
3. ใน **Logs** ต้องมี `WebSocket Connected` และสถานะ **Live** (สีเขียว)
4. คัดลอก URL เช่น `https://wickhunter-xau-xxxx.onrender.com`

**ทดสอบหลัง Deploy**

| URL | ผลที่คาดหวัง |
|-----|----------------|
| `https://your-app.onrender.com/` | ข้อความ WickHunter is Active |
| `https://your-app.onrender.com/index.html` | Dashboard |
| `https://your-app.onrender.com/status` | JSON สถานะบอท |

---

## Phase 6 — Keep-Alive ด้วย UptimeRobot

> **ทำไมต้องทำ:** แผน Free ของ Render จะ **Spin down** ถ้าไม่มี HTTP request ~15 นาที → WebSocket หยุด → บอทไม่ดักราคา

1. สมัคร [uptimerobot.com](https://uptimerobot.com)
2. **Add New Monitor**

| ฟิลด์ | ค่า |
|-------|-----|
| Monitor Type | `HTTP(s)` |
| Friendly Name | `WickHunter Ping` |
| URL | URL ของ Render (เช่น `https://wickhunter-xau-xxxx.onrender.com/`) |
| Monitoring Interval | `5 minutes` |

3. บันทึก Monitor

UptimeRobot จะยิง GET มาที่ `/` ทุก 5 นาที ทำให้เซิร์ฟเวอร์ตื่นอยู่เกือบตลอด

---

## การใช้งานหลังติดตั้ง

### Endpoint สำคัญ

| Path | การใช้งาน |
|------|-----------|
| `/` | Health check / UptimeRobot ping |
| `/index.html` | Dashboard แบบ Real-time |
| `/events` | SSE สำหรับ Dashboard (ไม่ต้องเปิดเอง) |
| `/status` | ดู state เป็น JSON |

### สถานะบอท (State)

| State | ความหมาย |
|-------|----------|
| `SCANNING` | กำลังหาโซน FVG/OB บน H1 |
| `WAITING_WICK_BREAK` | พบสัญญาณ รอเบรกปลายไส้ M5 |
| `TRIGGERED` | เบรกปลายไส้สำเร็จหรือยืนยันสัญญาณจากราคาปิดแท่ง |
| `MONITORING_TRADE` | อยู่ในระหว่างเข้าเทรดและเฝ้าติดตามสถานะชน TP1/TP2/SL |

### ตลาดปิด

บอทตรวจเวลา UTC — วันเสาร์ปิด, วันอาทิตย์เปิด ~22:00 UTC, วันศุกร์ปิด ~22:00 UTC — Log จะขึ้นโหมดพักผ่อน

---

## แก้ปัญหาเบื้องต้น

| อาการ | สาเหตุที่พบบ่อย | แนวทางแก้ |
|-------|------------------|-----------|
| ไม่มีข้อความ Telegram | ไม่กด Start บอท / Chat ID ผิด | กด Start, ตรวจ `TELEGRAM_CHAT_ID` |
| WebSocket ไม่ Connect | Finnhub Key ผิดหรือหมดอายุ | ตรวจ `FINNHUB_API_KEY` ใน Log |
| สแกนแล้วไม่มีโซน | ตลาดปิด / Twelve Data error | ดู Log `[DEBUG]` / โควต้า API |
| Sheets ไม่เขียน | ไม่แชร์ Sheet ให้ Service Account | แชร์ Editor ให้ `client_email` |
| Sheets หัวตารางซ้ำ | แถว 1 มีข้อมูลอยู่แล้ว | ลบแถว 1 ว่างแล้วรีสตาร์ท (ระบบใส่หัวเมื่อแถวว่างเท่านั้น) |
| Render หลับบ่อย | ไม่มี UptimeRobot | ตั้ง Monitor 5 นาที |
| Dashboard ไม่อัปเดต | เซิร์ฟเวอร์หลับ / SSE ขาด | Ping `/` ให้ตื่น แล้วรีเฟรชหน้า |

---

## สรุป Checklist ก่อนใช้งานจริง

- [ ] ติดตั้ง Node.js และรัน `npm install`
- [ ] สร้าง `.env` ครบ 4 ตัวบังคับ (Finnhub, Twelve Data, Telegram x2)
- [ ] ทดสอบ `node server.js` เห็น WebSocket Connected
- [ ] Telegram รับข้อความได้
- [ ] (ถ้าต้องการ) ตั้ง Google Sheets + แชร์ให้ Service Account
- [ ] Push ขึ้น GitHub (ไม่มี `.env`)
- [ ] Deploy Render + ใส่ Environment Variables
- [ ] ตั้ง UptimeRobot ชี้ URL ของ Render

---

**WickHunter XAU** — สแกนทองด้วย SMC, แจ้งเตือน Telegram, Dashboard Real-time, บันทึก Google Sheets (ถ้าเปิดใช้)
