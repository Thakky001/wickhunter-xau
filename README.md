# 🏹 WickHunter XAU

WickHunter XAU is an advanced Algorithmic Trading System (Expert Advisor / Trading Bot) specialized for Gold (XAUUSD). It leverages **Smart Money Concepts (SMC)** combined with real-time data streaming via the Deriv WebSocket API.

The system features a multi-timeframe engine, dynamic risk management, and a professional web-based dashboard with custom HTML chart overlays powered by TradingView Lightweight Charts.

---

## ✨ Key Features

### 🧠 Core SMC Trading Engine (`logic/smcEngine.js`)
- **Multi-Timeframe Analysis:** Uses H4 for HTF Trend direction, H1 for High-Probability Zones (FVG & Order Blocks), M5 for Price Action (PA) rejection, and M1 for structural confirmation (ChoCh/IDM).
- **Dual Execution Modes:** 
  - **STRICT Mode (Sideways):** Requires rigorous confluence including PA Rejection, Liquidity Sweep (IDM), and Change of Character (ChoCh).
  - **TREND-FOLLOWING Mode:** Relaxes IDM requirements when trading in the direction of the H4 HTF Trend.
  - **CONTINUATION Mode:** Scans for M5 Break of Structure (BOS) and trades immediate M5 FVG pullbacks in strong trends.
- **Dynamic Risk Management (`logic/smcMath.js`):** Calculates Stop Loss and Take Profit levels dynamically using ATR (Average True Range) to adapt to current market volatility and dynamic spread buffers.

### ⚡ Real-Time Data & Execution (`services/derivWs.js`)
- **Direct WebSocket Connection:** Connects directly to the Deriv WebSocket API for ultra-low latency tick streaming.
- **Auto-Aggregation:** Seamlessly builds real-time M1 and M5 candles from incoming tick data.
- **Resilience:** Auto-reconnect mechanisms ensuring 24/5 uptime.

### 🖥️ Professional Dashboard (`public/app.js` & `server.js`)
- **Server-Sent Events (SSE):** Real-time push updates from the backend Node.js engine to the frontend dashboard.
- **TradingView Lightweight Charts:** A custom implementation featuring:
  - Real-time candle updates.
  - **Custom HTML Overlays:** Draws translucent SMC Zones (FVG/OB) that perfectly overlay the chart, automatically hiding when off-screen.
  - **Dynamic Lines:** Plots Midpoint, Active Entry, Stop Loss, Take Profit, and dashed ChoCh target lines during `WAITING_CHOCH` state.
- **Live Settings Panel (`public/settings.html`):** Dynamically adjust engine configuration (Risk %, R:R Ratio, Timeouts) on the fly without restarting the server.

### 📡 Notifications & Logging (`services/`)
- **Telegram Integration:** Sends rich-text real-time alerts for Setups, Triggers, TP/SL hits, and Timeouts.
- **Google Sheets API:** Automatically logs every trade execution and outcome into a cloud spreadsheet for track-record keeping.

### 🧪 Backtesting Framework (`backtest/`)
- A Python-based backtesting environment using `pandas` and `vectorbt` to simulate SMC logic against historical tick/candle data for optimization.

---

## 🛠️ Tech Stack
- **Backend:** Node.js, Express, WebSocket (`ws`)
- **Frontend:** HTML5, Vanilla JavaScript, CSS3 (Glassmorphism UI), TradingView Lightweight Charts (v4.1.3)
- **APIs:** Deriv API, Telegram Bot API, Google Sheets API
- **Data Science:** Python, Pandas, VectorBT

---

## 🚀 Getting Started

### Prerequisites
1. **Node.js** (v18 or higher recommended)
2. **Deriv API Token:** An active Deriv account with a valid API token (Read & Trade access).
3. **Telegram Bot Token:** Create a bot via BotFather on Telegram.
4. **Google Cloud Credentials:** Service Account JSON file for Google Sheets integration.

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/Thakky001/wickhunter-xau.git
   cd wickhunter-xau
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Configure Environment Variables:
   Create a `.env` file in the root directory based on `.env.example`:
   ```env
   # Deriv WebSocket
   DERIV_APP_ID=YOUR_APP_ID
   DERIV_API_TOKEN=YOUR_API_TOKEN

   # Telegram
   TELEGRAM_BOT_TOKEN=YOUR_BOT_TOKEN
   TELEGRAM_CHAT_ID=YOUR_CHAT_ID

   # Google Sheets
   GOOGLE_SHEET_ID=YOUR_SHEET_ID
   # Ensure your Service Account JSON is properly linked in logic/sheets.js
   ```

4. Run the Server:
   ```bash
   npm start
   ```

5. Access the Dashboard:
   Open your browser and navigate to: `http://localhost:8080`

---

## 📊 System States Workflow

The engine operates on a finite state machine:
1. `SCANNING`: Constantly evaluating M5 candles against valid H1 FVG/OB zones.
2. `WAITING_WICK_BREAK`: Price has rejected a zone; waiting for the next M5 candle to break the rejection wick.
3. `WAITING_CHOCH`: Price action confirmed; waiting for M1 timeframe to break structure (Change of Character).
4. `TRIGGERED`: Conditions met. Order is executed.
5. `MONITORING_TRADE`: Managing active trade, tracking SL, TP1, and TP2.

---

## 📄 License
This project is proprietary and intended for private algorithmic trading.

---
*Developed with 🩵 by the WickHunter Team.*
