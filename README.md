# 📖 คู่มือการติดตั้งและใช้งาน WickHunter XAU (ฉบับสมบูรณ์)

> 🚀 **ระบบ Hybrid API:** ใช้ Twelve Data ดึงข้อมูลแท่งเทียนอดีต + Finnhub ดักราคา Real-time
> ☁️ **ฉบับ Cloud ฟรี:** ไม่ต้องเปิดคอม ไม่ต้องเช่า VPS ไม่เสียเงินเลยแม้แต่บาทเดียว

---

## 🛠️ สิ่งที่ต้องเตรียม (Prerequisites)

ก่อนเริ่มลงมือ ให้สมัครบัญชีของบริการเหล่านี้เตรียมไว้ (ฟรีทั้งหมด):

| บริการ                                     | วัตถุประสงค์                                           |
| ------------------------------------------ | ------------------------------------------------------ |
| [GitHub](https://github.com)               | พื้นที่เก็บ Source Code ของเรา                         |
| [Render.com](https://render.com)           | Cloud Server (PaaS) สำหรับรันบอทเทรด                   |
| [UptimeRobot.com](https://uptimerobot.com) | ระบบ Ping กระตุ้นไม่ให้เซิร์ฟเวอร์ Render หลับ         |
| [Finnhub.io](https://finnhub.io)           | ผู้ให้บริการ API สำหรับดึงราคา Real-time (WebSocket)   |
| [TwelveData.com](https://twelvedata.com)   | ผู้ให้บริการ API สำหรับดึงแท่งเทียนย้อนหลัง (REST API) |
| Telegram                                   | แอปพลิเคชันสำหรับสร้างบอทรับแจ้งเตือนจุดเข้าเทรด       |

---

## Phase 1: การหา "กุญแจ" (API Keys & Tokens)

### 1. หา Telegram Bot Token และ Chat ID

1. เปิดแอป Telegram ค้นหาช่องที่ชื่อว่า **@BotFather**
2. พิมพ์ `/newbot` จากนั้นตั้งชื่อบอทของคุณ
3. เมื่อเสร็จแล้ว BotFather จะให้ **API Token** มา (หน้าตาประมาณ `123456:ABC-DEF1234ghIkl...`) ให้ก็อปปี้เก็บไว้
4. ค้นหาบอทชื่อ **@userinfobot** (หรือบอท GetIDs) แล้วกด Start เพื่อดู **ID** ของคุณ (ตัวเลขล้วนๆ) — นี่คือ **Chat ID** สำหรับให้บอทส่งสัญญาณตรงหาคุณ

### 2. หา Finnhub API Key

1. ไปที่เว็บ [Finnhub.io](https://finnhub.io) แล้วกด **Get Free API Key**
2. สมัครสมาชิกให้เรียบร้อย ในหน้า Dashboard จะมี **API Key** ให้ก็อปปี้เก็บไว้

### 3. หา Twelve Data API Key

1. ไปที่เว็บ [TwelveData.com](https://twelvedata.com) แล้วสมัครสมาชิก (**Get Free API Key**)
2. เมื่อเข้าสู่ Dashboard ให้ไปที่เมนู **API Keys** แล้วก็อปปี้กุญแจของคุณมาเก็บไว้

---

## Phase 2: การตั้งค่าบนเครื่องตัวเอง (Local Setup)

### ขั้นที่ 1 — ติดตั้งไลบรารี

สร้างโฟลเดอร์โปรเจกต์ เปิด Terminal แล้วรันคำสั่งต่อไปนี้:

```bash
mkdir wickhunter-xau
cd wickhunter-xau
npm init -y
npm install express ws axios dotenv
```

### ขั้นที่ 2 — โครงสร้างไฟล์

เช็คให้ชัวร์ว่าคุณมีไฟล์ครบตามโครงสร้างนี้ (ถ้าไฟล์ไหนไม่มี ให้ย้อนกลับไปก็อปปี้โค้ดจากแชทก่อนหน้ามาใส่):

```
wickhunter-xau/
├── server.js
├── config/
│   └── keys.js
├── services/
│   ├── telegram.js
│   ├── finnhubWs.js       (ระบบ WebSocket เปิดท่อราคา)
│   └── twelveData.js      (ระบบดึงแท่งเทียนด้วย Twelve Data API)
└── logic/
    ├── smcMath.js         (คณิตศาสตร์คำนวณโซน FVG/OB)
    └── smcEngine.js       (สมองกลหลักจัดการ State)
```

### ขั้นที่ 3 — สร้างไฟล์ `.env`

สร้างไฟล์ `.env` ไว้ที่ชั้นนอกสุดของโปรเจกต์ (ระดับเดียวกับ `server.js`) แล้วใส่ค่ากุญแจทั้ง 4 ตัวลงไป:

```env
PORT=8080
FINNHUB_API_KEY=ใส่_API_KEY_ของ_Finnhub_ที่นี่
TWELVEDATA_API_KEY=ใส่_API_KEY_ของ_TwelveData_ที่นี่
TELEGRAM_BOT_TOKEN=ใส่_TOKEN_ของบอท_Telegram_ที่นี่
TELEGRAM_CHAT_ID=ใส่_CHAT_ID_ของคุณที่นี่
```

### ขั้นที่ 4 — สร้างไฟล์ `.gitignore` ⚠️

สร้างไฟล์ `.gitignore` (มีจุดข้างหน้า) แล้วพิมพ์ข้อความนี้ลงไป เพื่อป้องกันไม่ให้กุญแจหลุดออกสู่สาธารณะ:

```
node_modules
.env
```

---

## Phase 3: การนำขึ้น Cloud (Deployment บน Render)

ตอนนี้เราจะเอาโค้ดจากคอมพิวเตอร์ของเรา ขึ้นไปรันบนเซิร์ฟเวอร์ฟรี 24 ชม.

### 1. นำโค้ดขึ้น GitHub

1. สมัครบัญชี GitHub และสร้าง Repository ใหม่ (แบบ Private หรือ Public ก็ได้)
2. อัปโหลดไฟล์ในโฟลเดอร์ `wickhunter-xau` ทั้งหมดขึ้นไป (ยกเว้น `node_modules` และ `.env`)

### 2. ตั้งค่าบน Render.com

1. ล็อกอินเข้า Render.com กดปุ่ม **New +** ที่มุมขวาบน แล้วเลือก **Web Service**
2. เลือก **Build and deploy from a Git repository** และกด **Connect** กับ GitHub Repo ที่เพิ่งอัปโหลดขึ้นไป
3. เลื่อนลงมาตั้งค่าเซิร์ฟเวอร์ตามนี้:

   | ฟิลด์         | ค่าที่ใส่                            |
   | ------------- | ------------------------------------ |
   | Name          | `wickhunter-xau` (หรือชื่ออะไรก็ได้) |
   | Environment   | `Node`                               |
   | Build Command | `npm install`                        |
   | Start Command | `node server.js`                     |
   | Instance Type | `Free`                               |

4. เลื่อนลงมาที่หัวข้อ **Environment Variables** (สำคัญมาก เพราะเราไม่ได้อัปไฟล์ `.env` ขึ้นมา) กด **Add Environment Variable** แล้วใส่กุญแจทีละตัว:

   | Key (พิมพ์ให้เป๊ะ)   | Value (วางโค้ดของคุณ) |
   | -------------------- | --------------------- |
   | `FINNHUB_API_KEY`    | (ค่า API Key ของคุณ)  |
   | `TWELVEDATA_API_KEY` | (ค่า API Key ของคุณ)  |
   | `TELEGRAM_BOT_TOKEN` | (ค่า Token ของคุณ)    |
   | `TELEGRAM_CHAT_ID`   | (ค่า ID ของคุณ)       |

5. กดปุ่ม **Create Web Service** ด้านล่างสุด
6. รอเซิร์ฟเวอร์ติดตั้งประมาณ **2–3 นาที** รอจนกว่าจะมีข้อความใน Log ว่า:
   ```
   WebSocket Connected: WickHunter กำลังดักซุ่มราคา OANDA:XAU_USD...
   ```
   และแถบสถานะด้านบนขึ้นคำว่า **Live** (สีเขียว)
7. ก็อปปี้ **URL ของเซิร์ฟเวอร์** มาเก็บไว้ (อยู่มุมซ้ายบน ใต้ชื่อโปรเจกต์ หน้าตาคล้ายๆ `https://wickhunter-xau-abcd.onrender.com`)

---

## Phase 4: สร้างระบบกระตุ้นเซิร์ฟเวอร์ (Keep-Alive)

> ⚠️ **ปัญหา:** เซิร์ฟเวอร์ฟรีของ Render จะหลับ (Spin down) หากไม่มีคนเข้าเว็บเกิน 15 นาที ซึ่งจะทำให้บอทเทรดหยุดทำงาน
>
> 💡 **ทางแก้:** ใช้ UptimeRobot เป็นยามคอยเคาะประตูเรียกเซิร์ฟเวอร์ทุกๆ 5 นาที เพื่อให้มันตื่นตลอดเวลา

1. ล็อกอินเข้า [UptimeRobot.com](https://uptimerobot.com)
2. กดปุ่ม **Add New Monitor**
3. ตั้งค่าตามนี้:

   | ฟิลด์               | ค่าที่ใส่                                        |
   | ------------------- | ------------------------------------------------ |
   | Monitor Type        | `HTTP(s)`                                        |
   | Friendly Name       | `WickHunter Ping` (ตั้งชื่ออะไรก็ได้)            |
   | URL (or IP)         | วาง URL ของ Render ที่ก็อปปี้มาในขั้นตอนก่อนหน้า |
   | Monitoring Interval | `5 minutes`                                      |

4. กด **Create Monitor** (กด 2 ครั้งเพื่อยืนยัน)

---

## 🎉 เสร็จสมบูรณ์! เตรียมรับสัญญาณรวย

- ✅ ไม่ต้องเปิดคอมพิวเตอร์ทิ้งไว้
- ✅ ไม่ต้องเช่า VPS
- ✅ ไม่เสียเงินเลยแม้แต่บาทเดียว
