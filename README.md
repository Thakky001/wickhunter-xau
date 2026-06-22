# 🏹 WickHunter XAU

**WickHunter XAU** คือระบบเทรดอัตโนมัติ (Algorithmic Trading System / Expert Advisor) ที่ถูกออกแบบมาสำหรับเทรดทองคำ (XAUUSD) โดยเฉพาะ ระบบนี้ใช้หลักการ **Smart Money Concepts (SMC)** ผสมผสานกับการดึงข้อมูลราคาแบบ Real-time ผ่าน Deriv WebSocket API 

ระบบประกอบด้วย Engine วิเคราะห์หลายกรอบเวลา (Multi-timeframe), ระบบบริหารความเสี่ยงแบบแปรผันตามความผันผวน, และหน้าเว็บ Dashboard ระดับมืออาชีพที่ใช้ TradingView Lightweight Charts พร้อมระบบวาดกราฟ Overlay โปรงแสง

---

## ✨ ฟีเจอร์หลัก

### 🧠 Core SMC Trading Engine (`logic/smcEngine.js`)
- **การวิเคราะห์ Multi-Timeframe:** ใช้ H4 สำหรับดูแนวโน้มหลัก (HTF Trend), ใช้ H1 สำหรับหาโซนที่มีความน่าจะเป็นสูง (FVG & Order Blocks), ใช้ M5 เพื่อดูพฤติกรรมราคา (Price Action Rejection), และ M1 เพื่อยืนยันโครงสร้าง (ChoCh/IDM)
- **โหมดการเข้าเทรดที่ยืดหยุ่น:**
  - **โหมด STRICT (ช่วงไซด์เวย์):** ต้องการเงื่อนไขครบถ้วน ได้แก่ PA Rejection, การกวาดสภาพคล่อง (IDM Sweep) และการเสียทรง (ChoCh)
  - **โหมด TREND-FOLLOWING (ตามเทรนด์):** ผ่อนปรนเงื่อนไข IDM หากสัญญาณเกิดในทิศทางเดียวกับเทรนด์ H4 เพื่อไม่ให้ตกรถ
  - **โหมด CONTINUATION:** สแกนหาการเบรกของโครงสร้างย่อย (M5 BOS) และเข้าเทรดเมื่อราคากลับมาทดสอบ M5 FVG ทันทีในช่วงที่เทรนด์วิ่งแรง
- **ระบบบริหารความเสี่ยงอัจฉริยะ (`logic/smcMath.js`):** คำนวณระยะ Stop Loss และ Take Profit แบบไดนามิกโดยอิงจากค่า ATR (Average True Range) เพื่อปรับตัวให้เข้ากับความผันผวนของตลาดในแต่ละช่วงเวลา และมีการบวกเผื่อ Spread ทันที

### ⚡ ระบบข้อมูลเรียลไทม์ (`services/derivWs.js`)
- **Direct WebSocket Connection:** เชื่อมต่อตรงกับ Deriv WebSocket API เพื่อรับข้อมูล Tick-by-Tick แบบ Ultra-low latency
- **Auto-Aggregation:** สร้างแท่งเทียน M1 และ M5 จาก Tick ที่เข้ามาใหม่แบบวินาทีต่อวินาที
- **ระบบกู้คืนอัตโนมัติ (Resilience):** มีระบบ Auto-reconnect หากการเชื่อมต่อหลุด เพื่อให้บอทรันได้ต่อเนื่อง 24/5

### 🖥️ Dashboard ระดับมืออาชีพ (`public/app.js` & `server.js`)
- **Server-Sent Events (SSE):** ยิงข้อมูลอัปเดตแบบเรียลไทม์จาก Backend (Node.js) ไปยัง Frontend ทันทีโดยไม่ต้องให้ผู้ใช้กดรีเฟรชหน้าเว็บ
- **Custom TradingView Lightweight Charts:** กราฟแบบกำหนดเองที่มีฟีเจอร์:
  - วาดแท่งเทียนใหม่ทันทีตามข้อมูล Tick
  - **HTML Overlays:** สร้างกล่องแสดงโซน FVG/OB แบบโปร่งแสงซ้อนทับบนกราฟอย่างแม่นยำ และระบบซ่อนอัตโนมัติเมื่อเลื่อนกราฟออกนอกหน้าจอ
  - **Dynamic Lines:** ตีเส้น Midpoint, ราคาเข้าเทรด, Stop Loss, Take Profit รวมถึงเส้นประเป้าหมาย ChoCh (ChoCh Target) ในจังหวะที่บอทกำลังซุ่มรอ
- **Live Settings Panel (`public/settings.html`):** ผู้ใช้สามารถปรับการตั้งค่าของ Engine (เช่น ความเสี่ยง %, อัตราส่วน R:R, หรือเวลา Timeout) ได้ทันทีโดยไม่ต้องสั่งรีสตาร์ทเซิร์ฟเวอร์

### 📡 การแจ้งเตือนและการเก็บสถิติ (`services/`)
- **Telegram Integration:** ส่งข้อความแจ้งเตือนสถานะต่างๆ เข้ามือถือทันที เช่น เมื่อเจอโซน, เมื่อเข้าเทรด, เมื่อชน TP/SL
- **Google Sheets API:** บันทึกข้อมูลการเทรดทุกไม้ลงบน Google Spreadsheet อัตโนมัติ เพื่อทำเป็น Trade Journal (Log book)

### 🧪 โครงสร้างระบบ Backtest (`backtest/`)
- ระบบ Backtesting ที่เขียนด้วย Python โดยใช้ไลบรารี `pandas` และ `vectorbt` เพื่อจำลองการเทรดด้วยตรรกะ SMC จากข้อมูล Tick และแท่งเทียนย้อนหลัง เพื่อนำไป Optimize หาทีมและตั้งค่าที่ดีที่สุด

---

## 🛠️ เทคโนโลยีที่ใช้ (Tech Stack)
- **Backend:** Node.js, Express, WebSocket (`ws`)
- **Frontend:** HTML5, Vanilla JavaScript, CSS3 (Glassmorphism UI), TradingView Lightweight Charts (v4.1.3)
- **APIs:** Deriv API, Telegram Bot API, Google Sheets API
- **Data Science:** Python, Pandas, VectorBT

---

## 🚀 วิธีการติดตั้งและรันระบบ

### สิ่งที่ต้องเตรียม (Prerequisites)
1. **Node.js** (แนะนำเวอร์ชัน 18 ขึ้นไป) ติดตั้งได้จาก [nodejs.org](https://nodejs.org/)
2. **Deriv API Token:** บัญชี Deriv และ Token ที่มีสิทธิ์ใช้งาน Read & Trade
3. **Telegram Bot Token:** สร้างบอทผ่าน @BotFather ในแอป Telegram
4. **Google Cloud Credentials:** ไฟล์ Service Account JSON สำหรับใช้เชื่อมต่อ Google Sheets API (ถ้าต้องการบันทึกสถิติ)

### ขั้นตอนการติดตั้ง

1. **โคลนโปรเจค (Clone the repository):**
   เปิด Command Prompt หรือ Terminal แล้วพิมพ์:
   ```bash
   git clone https://github.com/Thakky001/wickhunter-xau.git
   cd wickhunter-xau
   ```

2. **ติดตั้งไลบรารีที่จำเป็น (Install dependencies):**
   ```bash
   npm install
   ```

3. **ตั้งค่าตัวแปรระบบ (Environment Variables):**
   สร้างไฟล์ชื่อ `.env` ไว้ในโฟลเดอร์นอกสุดของโปรเจค โดยก๊อปปี้ข้อมูลจาก `.env.example` (ถ้ามี) หรือพิมพ์ตามนี้:
   ```env
   # Deriv WebSocket
   DERIV_APP_ID=เลขแอปไอดีของคุณ
   DERIV_API_TOKEN=โทเค็นAPIของคุณ

   # Telegram
   TELEGRAM_BOT_TOKEN=โทเค็นจาก_BotFather
   TELEGRAM_CHAT_ID=ไอดีห้องแชทของคุณ

   # Google Sheets (ไม่บังคับ)
   GOOGLE_SHEET_ID=ไอดีของไฟล์_Google_Sheets
   # นำไฟล์ JSON ของ Service Account ไปวางทับไฟล์เดิมที่ logic/sheets.js เรียกใช้
   ```

4. **รันเซิร์ฟเวอร์ (Start the server):**
   ```bash
   node server.js
   ```
   *(หากต้องการให้เซิร์ฟเวอร์รันทำงานพื้นหลังต่อเนื่อง แนะนำให้ใช้ `pm2 start server.js`)*

5. **เปิดดูหน้า Dashboard:**
   เปิดเบราว์เซอร์แล้วเข้าไปที่ URL: `http://localhost:8080`

---

## 📊 Workflow ของบอทในแต่ละสถานะ (System States)

กลไกหลักของบอททำงานผ่านระบบ State Machine ดังนี้:
1. `SCANNING`: สแกนกราฟ M5 ไปเรื่อยๆ เพื่อหาจังหวะที่ราคาเข้าใกล้หรือชนโซน H1 (FVG/OB) ที่ยังไม่ถูกทำลาย
2. `WAITING_WICK_BREAK`: ราคามาชนโซนแล้วและเกิดแท่งเทียนกลับตัว บอทจะรอให้แท่งถัดไปทะลุปลายไส้ของแท่งกลับตัวเพื่อยืนยันทิศทาง
3. `WAITING_CHOCH`: มีการยืนยันแล้ว บอทจะซุ่มรอให้กราฟไทม์เฟรม M1 เบรกโครงสร้าง (Change of Character) เพื่อยืนยันว่าการกลับตัวเริ่มเกิดขึ้นจริง
4. `TRIGGERED`: เงื่อนไขครบถ้วน บอททำการออกออเดอร์เข้าเทรด
5. `MONITORING_TRADE`: สถานะหลังออกออเดอร์ บอทจะคอยจับตาดูเพื่อเลื่อน Stop Loss ป้องกันทุน หรือปิดทำกำไร (TP1, TP2)

---

## 📄 License
โปรเจคนี้สงวนลิขสิทธิ์ (Proprietary) สำหรับใช้ในการเทรดส่วนตัว (Private Algorithmic Trading) 

---
*Developed with 🩵 by the WickHunter Team.*
