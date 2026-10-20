import json
import os
import yfinance as yf
import pandas as pd
from datetime import datetime

# Curated assets for training different market regimes (Trending, Mean-Reverting, Volatile)
ASSETS = {
    "NIFTY_50": {"ticker": "^NSEI", "interval": "1d", "period": "2y", "name": "NIFTY 50 Index (NSE)"},
    "RELIANCE_NS": {"ticker": "RELIANCE.NS", "interval": "1d", "period": "2y", "name": "Reliance Industries (NSE)"},
    "HDFCBANK_NS": {"ticker": "HDFCBANK.NS", "interval": "1d", "period": "2y", "name": "HDFC Bank (NSE)"},
    "BTC_USD": {"ticker": "BTC-USD", "interval": "1d", "period": "2y", "name": "Bitcoin / USD"},
    "NVDA_US": {"ticker": "NVDA", "interval": "1d", "period": "2y", "name": "NVIDIA Corp (NASDAQ)"},
    "GOLD_FUT": {"ticker": "GC=F", "interval": "1d", "period": "2y", "name": "Gold Futures"}
}

def fetch_and_process():
    os.makedirs("data", exist_ok=True)
    market_packs = {
        "last_updated": datetime.utcnow().strftime("%Y-%m-%d %H:%M UTC"),
        "assets": {}
    }

    for key, cfg in ASSETS.items():
        print(f"Fetching {cfg['name']} ({cfg['ticker']})...")
        df = yf.download(cfg["ticker"], period=cfg["period"], interval=cfg["interval"], progress=False)
        
        if df.empty:
            print(f"Warning: No data for {key}")
            continue

        # Handle multi-index columns from newer yfinance versions
        if isinstance(df.columns, pd.MultiIndex):
            df.columns = df.columns.get_level_values(0)

        df = df.dropna()
        df["EMA20"] = df["Close"].ewm(span=20, adjust=False).mean()
        df["EMA50"] = df["Close"].ewm(span=50, adjust=False).mean()

        candles = []
        for idx, row in df.iterrows():
            candles.append({
                "time": idx.strftime("%Y-%m-%d"),
                "open": round(float(row["Open"]), 2),
                "high": round(float(row["High"]), 2),
                "low": round(float(row["Low"]), 2),
                "close": round(float(row["Close"]), 2),
                "volume": int(row["Volume"]) if "Volume" in row else 0,
                "ema20": round(float(row["EMA20"]), 2),
                "ema50": round(float(row["EMA50"]), 2)
            })

        market_packs["assets"][key] = {
            "name": cfg["name"],
            "ticker": cfg["ticker"],
            "candles": candles
        }

    output_path = os.path.join("data", "market_packs.json")
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(market_packs, f, indent=2)
    print(f"Successfully generated {output_path} with {len(market_packs['assets'])} assets.")

if __name__ == "__main__":
    fetch_and_process()
