// ============================================================================
// TRADE//DOJO — CORE BAR-REPLAY, RPG GAMIFICATION & PERSISTENCE ENGINE
// ============================================================================

const STORAGE_KEY = "TRADE_DOJO_SAVE_V1";

const defaultState = {
  equity: 100000,
  initialEquity: 100000,
  xp: 0,
  hp: 100,
  streak: 0,
  trades: [] // { id, asset, side, entry, exit, pnl, rMultiple, setup, date }
};

let state = loadState();
let marketData = {};
let activeAssetKey = "SYNTH_TREND";
let allCandles = [];
let replayIndex = 60;
let autoPlayTimer = null;
let activePosition = null; // { side, entry, stop, target, shares, riskDollars, setup, entryDate }

// Chart references
let chart, candleSeries, ema20Series, ema50Series;
let entryLine = null, stopLine = null, targetLine = null;

// Rank Titles for the 2-4 Year Progression
const RANKS = [
  { minXp: 0, title: "LVL 1 • RETAIL NOVICE" },
  { minXp: 500, title: "LVL 2 • TAPE READER" },
  { minXp: 1500, title: "LVL 3 • RISK GUARDIAN" },
  { minXp: 3500, title: "LVL 4 • SYSTEM ARCHITECT" },
  { minXp: 7500, title: "LVL 5 • PROP SYNDICATE OPERATOR" },
  { minXp: 15000, title: "LVL 6 • MARKET SOVEREIGN" }
];

// 1. INITIALIZE CHART & DATA
window.addEventListener("DOMContentLoaded", async () => {
  initChart();
  await loadMarketPacks();
  updateUI();
  bindEvents();
});

function initChart() {
  const container = document.getElementById("tv-chart");
  chart = LightweightCharts.createChart(container, {
    layout: {
      background: { type: "solid", color: "#0d0f12" },
      textColor: "#9ba3b0",
      fontFamily: "JetBrains Mono"
    },
    grid: {
      vertLines: { color: "#1f2430" },
      horzLines: { color: "#1f2430" }
    },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
    rightPriceScale: { borderColor: "#000000" },
    timeScale: { borderColor: "#000000", timeVisible: true }
  });

  candleSeries = chart.addCandlestickSeries({
    upColor: "#22c55e",
    downColor: "#ef4444",
    borderUpColor: "#22c55e",
    borderDownColor: "#ef4444",
    wickUpColor: "#22c55e",
    wickDownColor: "#ef4444"
  });

  ema20Series = chart.addLineSeries({ color: "#facc15", lineWidth: 2, title: "EMA 20" });
  ema50Series = chart.addLineSeries({ color: "#06b6d4", lineWidth: 2, title: "EMA 50" });

  new ResizeObserver(entries => {
    if (entries.length === 0) return;
    const { width, height } = entries[0].contentRect;
    chart.applyOptions({ width, height });
  }).observe(container);
}

// 2. LOAD GITHUB DATA OR PROCEDURAL FALLBACK
async function loadMarketPacks() {
  // Always generate a procedural dataset first so offline/local testing works instantly
  marketData["SYNTH_TREND"] = {
    name: "⚡ SIMULATED REGIME (OFFLINE READY)",
    candles: generateSyntheticCandles(500)
  };

  try {
    const res = await fetch("./data/market_packs.json");
    if (res.ok) {
      const json = await res.json();
      const select = document.getElementById("asset-select");
      Object.entries(json.assets).forEach(([key, val]) => {
        marketData[key] = val;
        const opt = document.createElement("option");
        opt.value = key;
        opt.textContent = `📈 ${val.name}`;
        select.appendChild(opt);
      });
      setSenseiMessage(`Loaded live GitHub Market Packs (${Object.keys(json.assets).length} assets). Select an asset or hit [SPACE] to train!`);
    }
  } catch (e) {
    setSenseiMessage("Running in Offline Procedural Mode. Once GitHub Actions runs fetch_data.py, real NSE/US/Crypto packs will appear automatically.");
  }

  selectAsset(activeAssetKey);
}

function generateSyntheticCandles(count) {
  const candles = [];
  let price = 1000;
  let ema20 = price, ema50 = price;
  const start = new Date("2023-01-01");

  for (let i = 0; i < count; i++) {
    const d = new Date(start);
    d.setDate(start.getDate() + i);
    const dateStr = d.toISOString().split("T")[0];

    // Create realistic trending + volatility clusters
    const regimeBias = Math.sin(i / 28) * 3.5;
    const change = (Math.random() - 0.485) * 22 + regimeBias;
    const open = price;
    const close = Math.max(50, +(open + change).toFixed(2));
    const high = +(Math.max(open, close) + Math.random() * 14).toFixed(2);
    const low = +(Math.min(open, close) - Math.random() * 14).toFixed(2);

    ema20 = +(close * (2 / 21) + ema20 * (1 - 2 / 21)).toFixed(2);
    ema50 = +(close * (2 / 51) + ema50 * (1 - 2 / 51)).toFixed(2);

    candles.push({ time: dateStr, open, high, low, close, ema20, ema50 });
    price = close;
  }
  return candles;
}

function selectAsset(key) {
  if (activePosition) closePosition("Asset Switched");
  activeAssetKey = key;
  allCandles = marketData[key].candles;
  // Start at a random point with at least 60 bars of history and 100 bars ahead
  replayIndex = Math.floor(60 + Math.random() * Math.max(10, allCandles.length - 180));
  renderReplaySlice();
}

function renderReplaySlice() {
  const visible = allCandles.slice(0, replayIndex + 1);
  candleSeries.setData(visible);
  ema20Series.setData(visible.map(c => ({ time: c.time, value: c.ema20 })));
  ema50Series.setData(visible.map(c => ({ time: c.time, value: c.ema50 })));

  const current = visible[visible.length - 1];
  document.getElementById("current-date").textContent = current.time;
  document.getElementById("current-price").textContent = `$${current.close.toFixed(2)}`;
  evaluateActivePosition(current);
}

// 3. STEP FORWARD & EVALUATE STOPS / TARGETS
function stepForward() {
  if (replayIndex >= allCandles.length - 1) {
    pauseAutoPlay();
    setSenseiMessage("End of historical pack reached! Reseeded a new blind window.");
    selectAsset(activeAssetKey);
    return;
  }
  replayIndex++;
  renderReplaySlice();
}

function evaluateActivePosition(candle) {
  if (!activePosition) return;

  const { side, entry, stop, target, shares, riskDollars } = activePosition;

  // Check if Stop-Loss or Take-Profit was hit inside this candle's High-Low range
  if (side === "LONG") {
    if (candle.low <= stop) {
      executeExit(stop, "🛑 STOP-LOSS HIT (-1.00R)");
      return;
    }
    if (candle.high >= target) {
      executeExit(target, "🎯 TARGET HIT (+R WINNER!)");
      return;
    }
  } else if (side === "SHORT") {
    if (candle.high >= stop) {
      executeExit(stop, "🛑 STOP-LOSS HIT (-1.00R)");
      return;
    }
    if (candle.low <= target) {
      executeExit(target, "🎯 TARGET HIT (+R WINNER!)");
      return;
    }
  }

  // Update floating PnL
  const diff = side === "LONG" ? (candle.close - entry) : (entry - candle.close);
  const floatingPnl = diff * shares;
  const floatingR = floatingPnl / riskDollars;

  const pnlEl = document.getElementById("pos-pnl");
  pnlEl.textContent = `${floatingPnl >= 0 ? "+" : ""}$${floatingPnl.toFixed(2)} (${floatingR.toFixed(2)}R)`;
  pnlEl.style.color = floatingPnl >= 0 ? "#22c55e" : "#ef4444";
}

// 4. ORDER EXECUTION & RPG REWARD ENGINE
function openPosition(side) {
  if (activePosition) {
    setSenseiMessage("⚠️ Position already active! Flatten [X] before opening a new trade.");
    return;
  }

  const current = allCandles[replayIndex];
  const riskPct = parseFloat(document.getElementById("inp-risk-pct").value) || 1.0;
  const slPct = parseFloat(document.getElementById("inp-sl-pct").value) || 2.0;
  const tpR = parseFloat(document.getElementById("inp-tp-r").value) || 2.0;
  const setup = document.getElementById("inp-setup").value;

  const entry = current.close;
  const stopDist = entry * (slPct / 100);
  const stop = side === "LONG" ? +(entry - stopDist).toFixed(2) : +(entry + stopDist).toFixed(2);
  const target = side === "LONG" ? +(entry + stopDist * tpR).toFixed(2) : +(entry - stopDist * tpR).toFixed(2);

  const riskDollars = state.equity * (riskPct / 100);
  const shares = riskDollars / stopDist;

  // RPG Discipline Evaluation on Entry
  if (riskPct > 3.0 || setup.includes("Impulse")) {
    state.hp = Math.max(0, state.hp - 15);
    state.streak = 0;
    setSenseiMessage(`🚨 DISCIPLINE VIOLATION! Risking ${riskPct}% or trading on Impulse cost you -15 HP and reset your streak!`);
  } else {
    state.xp += 15;
    state.streak += 1;
    setSenseiMessage(`✅ Disciplined ${side} entry logged (${setup}). Risk capped at $${riskDollars.toFixed(0)} (${riskPct}%). +15 XP!`);
  }

  activePosition = { side, entry, stop, target, shares, riskDollars, setup, entryDate: current.time };

  // Draw Price Lines on Chart
  clearPriceLines();
  entryLine = candleSeries.createPriceLine({ price: entry, color: "#facc15", lineWidth: 2, title: `${side} ENTRY` });
  stopLine = candleSeries.createPriceLine({ price: stop, color: "#ef4444", lineWidth: 2, lineStyle: 2, title: "STOP LOSS" });
  targetLine = candleSeries.createPriceLine({ price: target, color: "#22c55e", lineWidth: 2, lineStyle: 2, title: "TAKE PROFIT" });

  document.getElementById("pos-side").textContent = `${side} ACTIVE (${setup})`;
  document.getElementById("pos-details").textContent = `Entry: $${entry} | SL: $${stop} | TP: $${target}`;
  document.getElementById("btn-close").disabled = false;

  saveState();
  updateUI();
}

function closePosition(reason = "Manual Exit") {
  if (!activePosition) return;
  const current = allCandles[replayIndex];
  executeExit(current.close, reason);
}

function executeExit(exitPrice, reason) {
  const { side, entry, shares, riskDollars, setup } = activePosition;
  const diff = side === "LONG" ? (exitPrice - entry) : (entry - exitPrice);
  const pnl = +(diff * shares).toFixed(2);
  const rMultiple = +(pnl / riskDollars).toFixed(2);

  state.equity = +(state.equity + pnl).toFixed(2);

  // RPG XP Rewards based on R-Multiple outcome
  if (rMultiple >= 1.5) {
    const bonusXp = Math.round(rMultiple * 25);
    state.xp += bonusXp;
    state.hp = Math.min(100, state.hp + 5);
    setSenseiMessage(`${reason} | Closed at ${rMultiple}R ($${pnl}). Monster execution! +${bonusXp} XP!`);
  } else if (rMultiple <= -0.95 && rMultiple >= -1.05) {
    // Honored stop loss cleanly -> Still get XP for taking a planned loss like a pro!
    state.xp += 20;
    setSenseiMessage(`${reason} | You honored your Stop-Loss at -1.0R without moving it. Professional loss! +20 XP.`);
  } else {
    setSenseiMessage(`${reason} | Trade closed for ${rMultiple}R ($${pnl}). Review journal to refine timing.`);
  }

  state.trades.unshift({
    id: Date.now(),
    asset: activeAssetKey,
    side,
    entry,
    exit: exitPrice,
    pnl,
    rMultiple,
    setup,
    date: allCandles[replayIndex].time
  });

  // Keep latest 200 trades in local state
  if (state.trades.length > 200) state.trades.pop();

  activePosition = null;
  clearPriceLines();
  document.getElementById("pos-side").textContent = "FLAT (NO POSITION)";
  document.getElementById("pos-pnl").textContent = "$0.00 (0.00R)";
  document.getElementById("pos-pnl").style.color = "#9ba3b0";
  document.getElementById("pos-details").textContent = "Entry: -- | Stop: -- | Target: --";
  document.getElementById("btn-close").disabled = true;

  saveState();
  updateUI();
}

function clearPriceLines() {
  if (entryLine) { candleSeries.removePriceLine(entryLine); entryLine = null; }
  if (stopLine) { candleSeries.removePriceLine(stopLine); stopLine = null; }
  if (targetLine) { candleSeries.removePriceLine(targetLine); targetLine = null; }
}

// 5. UI, TELEMETRY & PERSISTENCE
function updateUI() {
  document.getElementById("equity-val").textContent = `$${state.equity.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;
  document.getElementById("streak-val").textContent = `🔥 ${state.streak}`;

  const wins = state.trades.filter(t => t.pnl > 0).length;
  const winRate = state.trades.length ? ((wins / state.trades.length) * 100).toFixed(1) : "0.0";
  const avgR = state.trades.length
    ? (state.trades.reduce((acc, t) => acc + t.rMultiple, 0) / state.trades.length).toFixed(2)
    : "0.00";

  document.getElementById("winrate-val").textContent = `${winRate}%`;
  document.getElementById("rmult-val").textContent = `${avgR}R`;

  // RPG Rank & Progress Bars
  let currentRank = RANKS[0];
  let nextRank = RANKS[1];
  for (let i = 0; i < RANKS.length; i++) {
    if (state.xp >= RANKS[i].minXp) {
      currentRank = RANKS[i];
      nextRank = RANKS[i + 1] || { minXp: state.xp + 5000 };
    }
  }

  document.getElementById("rank-title").textContent = currentRank.title;
  document.getElementById("hp-text").textContent = `${state.hp} / 100`;
  document.getElementById("hp-fill").style.width = `${state.hp}%`;

  const xpProgress = Math.min(100, ((state.xp - currentRank.minXp) / (nextRank.minXp - currentRank.minXp)) * 100);
  document.getElementById("xp-text").textContent = `${state.xp} / ${nextRank.minXp} XP`;
  document.getElementById("xp-fill").style.width = `${xpProgress}%`;

  // Render Journal List
  const jList = document.getElementById("journal-list");
  jList.innerHTML = state.trades.slice(0, 15).map(t => `
    <div class="journal-item" style="border-left-color: ${t.pnl >= 0 ? '#22c55e' : '#ef4444'}">
      <span><strong>${t.side}</strong> ${t.asset} (${t.setup})</span>
      <span style="color: ${t.pnl >= 0 ? '#22c55e' : '#ef4444'}; font-weight:700;">
        ${t.rMultiple >= 0 ? '+' : ''}${t.rMultiple}R ($${t.pnl})
      </span>
    </div>
  `).join("");
}

function setSenseiMessage(msg) {
  document.getElementById("sensei-log").innerHTML = msg;
}

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? { ...defaultState, ...JSON.parse(raw) } : { ...defaultState };
  } catch {
    return { ...defaultState };
  }
}

function saveState() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

// 6. HOTKEYS & EVENT LISTENERS
function bindEvents() {
  document.getElementById("btn-step").addEventListener("click", stepForward);
  document.getElementById("btn-play").addEventListener("click", toggleAutoPlay);
  document.getElementById("btn-buy").addEventListener("click", () => openPosition("LONG"));
  document.getElementById("btn-sell").addEventListener("click", () => openPosition("SHORT"));
  document.getElementById("btn-close").addEventListener("click", () => closePosition("Manual Flatten"));

  document.getElementById("asset-select").addEventListener("change", e => selectAsset(e.target.value));
  document.getElementById("btn-random-seed").addEventListener("click", () => {
    selectAsset(activeAssetKey);
    setSenseiMessage("🎲 Blind Time-Machine activated! New randomized historical start date loaded.");
  });

  // Export JSON Backup
  document.getElementById("btn-export").addEventListener("click", () => {
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `trade-dojo-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  });

  // Import JSON Backup
  document.getElementById("inp-import").addEventListener("change", e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = evt => {
      try {
        state = { ...defaultState, ...JSON.parse(evt.target.result) };
        saveState();
        updateUI();
        setSenseiMessage("💾 4-Year Journal Vault successfully restored!");
      } catch {
        alert("Invalid backup JSON file.");
      }
    };
    reader.readAsText(file);
  });

  document.getElementById("btn-reset").addEventListener("click", () => {
    if (confirm("Reset account equity and XP back to Level 1?")) {
      state = { ...defaultState, trades: [] };
      saveState();
      updateUI();
    }
  });

  // Arcade Keyboard Shortcuts
  window.addEventListener("keydown", e => {
    if (["INPUT", "SELECT"].includes(document.activeElement.tagName)) return;
    if (e.code === "Space") { e.preventDefault(); stepForward(); }
    if (e.key.toLowerCase() === "p") toggleAutoPlay();
    if (e.key.toLowerCase() === "b") openPosition("LONG");
    if (e.key.toLowerCase() === "s") openPosition("SHORT");
    if (e.key.toLowerCase() === "x") closePosition("Hotkey Flatten");
  });
}

function toggleAutoPlay() {
  if (autoPlayTimer) {
    pauseAutoPlay();
  } else {
    const speed = parseInt(document.getElementById("speed-select").value, 10);
    document.getElementById("btn-play").textContent = "⏸ PAUSE [P]";
    autoPlayTimer = setInterval(stepForward, speed);
  }
}

function pauseAutoPlay() {
  clearInterval(autoPlayTimer);
  autoPlayTimer = null;
  document.getElementById("btn-play").textContent = "▶ AUTO PLAY [P]";
}
