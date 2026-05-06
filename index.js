import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.send("Stock backend is running");
});

app.get("/technical-analysis", async (req, res) => {
  try {

    const ticker = req.query.ticker;
    const interval = req.query.interval || "15min";

    const accountSize =
      Number(req.query.accountSize) || 5000;

    const riskPercent =
      Number(req.query.riskPercent) || 1;

    if (!ticker) {
      return res.status(400).json({
        error: "Ticker is required"
      });
    }

    const apiKey = process.env.TWELVE_DATA_API_KEY;
    const baseUrl = "https://api.twelvedata.com";

    const priceUrl =
      `${baseUrl}/price?symbol=${ticker}&apikey=${apiKey}`;

    const rsiUrl =
      `${baseUrl}/rsi?symbol=${ticker}&interval=${interval}&time_period=14&apikey=${apiKey}`;

    const ema20Url =
      `${baseUrl}/ema?symbol=${ticker}&interval=${interval}&time_period=20&apikey=${apiKey}`;

    const ema50Url =
      `${baseUrl}/ema?symbol=${ticker}&interval=${interval}&time_period=50&apikey=${apiKey}`;

    const macdUrl =
      `${baseUrl}/macd?symbol=${ticker}&interval=${interval}&apikey=${apiKey}`;

    const atrUrl =
      `${baseUrl}/atr?symbol=${ticker}&interval=${interval}&time_period=14&apikey=${apiKey}`;

    const candlesUrl =
      `${baseUrl}/time_series?symbol=${ticker}&interval=${interval}&outputsize=30&apikey=${apiKey}`;

    const [
      priceResponse,
      rsiResponse,
      ema20Response,
      ema50Response,
      macdResponse,
      atrResponse,
      candlesResponse
    ] = await Promise.all([
      fetch(priceUrl),
      fetch(rsiUrl),
      fetch(ema20Url),
      fetch(ema50Url),
      fetch(macdUrl),
      fetch(atrUrl),
      fetch(candlesUrl)
    ]);

    const priceData = await priceResponse.json();
    const rsiData = await rsiResponse.json();
    const ema20Data = await ema20Response.json();
    const ema50Data = await ema50Response.json();
    const macdData = await macdResponse.json();
    const atrData = await atrResponse.json();
    const candlesData = await candlesResponse.json();

    const livePrice = Number(priceData.price);

    const rsi =
      Number(rsiData.values?.[0]?.rsi);

    const ema20 =
      Number(ema20Data.values?.[0]?.ema);

    const ema50 =
      Number(ema50Data.values?.[0]?.ema);

    const macd =
      Number(macdData.values?.[0]?.macd);

    const macdSignal =
      Number(macdData.values?.[0]?.macd_signal);

    const histogram =
      Number(macdData.values?.[0]?.macd_hist);

    const atr =
      Number(atrData.values?.[0]?.atr);

    const candles = candlesData.values || [];

    // Support & Resistance
    const lows =
      candles.map(c => Number(c.low));

    const highs =
      candles.map(c => Number(c.high));

    const support =
      Number(Math.min(...lows).toFixed(2));

    const resistance =
      Number(Math.max(...highs).toFixed(2));

    // VWAP Calculation
    let cumulativeTPV = 0;
    let cumulativeVolume = 0;

    candles.forEach(candle => {

      const high = Number(candle.high);
      const low = Number(candle.low);
      const close = Number(candle.close);
      const volume = Number(candle.volume);

      const typicalPrice =
        (high + low + close) / 3;

      cumulativeTPV +=
        typicalPrice * volume;

      cumulativeVolume += volume;
    });

    const vwap =
      Number((cumulativeTPV / cumulativeVolume).toFixed(2));

    // Volume Analysis
    const volumes =
      candles.map(c => Number(c.volume));

    const currentVolume = volumes[0];

    const averageVolume =
      Number(
        (
          volumes.reduce((a, b) => a + b, 0)
          / volumes.length
        ).toFixed(0)
      );

    const relativeVolume =
      Number(
        (currentVolume / averageVolume).toFixed(2)
      );

    let volumeTrend = "Normal";

    if (relativeVolume >= 1.5) {
      volumeTrend = "High";
    }

    if (relativeVolume <= 0.7) {
      volumeTrend = "Low";
    }

    // Trend Logic
    let trend = "Neutral";

    if (
      livePrice > ema20 &&
      ema20 > ema50 &&
      livePrice > vwap
    ) {
      trend = "Bullish";
    }

    else if (
      livePrice < ema20 &&
      ema20 < ema50 &&
      livePrice < vwap
    ) {
      trend = "Bearish";
    }

    // Signal Logic
    let signal = "Hold";

    if (
      trend === "Bullish" &&
      rsi > 55 &&
      histogram > 0 &&
      relativeVolume >= 1
    ) {
      signal = "Buy";
    }

    if (
      trend === "Bearish" &&
      rsi < 45 &&
      histogram < 0 &&
      relativeVolume >= 1
    ) {
      signal = "Sell";
    }

    // Trade Plan
    const buyZoneLow =
      Number((livePrice - atr * 0.5).toFixed(2));

    const buyZoneHigh =
      Number((livePrice + atr * 0.25).toFixed(2));

    const stopLoss =
      Number(
        Math.min(
          support,
          livePrice - atr * 1.5
        ).toFixed(2)
      );

    const target =
      Number((livePrice + atr * 3).toFixed(2));

    const riskPerShare =
      Number((livePrice - stopLoss).toFixed(2));

    const rewardPerShare =
      Number((target - livePrice).toFixed(2));

    const riskRewardRatio =
      Number(
        (rewardPerShare / riskPerShare).toFixed(2)
      );

    // Position Sizing
    const maxRiskAmount =
      Number(
        (
          accountSize *
          (riskPercent / 100)
        ).toFixed(2)
      );

    const suggestedShares =
      Math.floor(maxRiskAmount / riskPerShare);

    // Trade Quality
    let tradeQuality = "Avoid";

    if (
      signal === "Buy" &&
      riskRewardRatio >= 2 &&
      relativeVolume >= 1
    ) {
      tradeQuality = "Valid long setup";
    }

    else if (
      trend === "Bullish"
    ) {
      tradeQuality = "Watchlist only";
    }

    res.json({
      ticker,
      interval,
      livePrice,

      trend,
      signal,
      tradeQuality,

      indicators: {
        rsi,
        ema20,
        ema50,
        macd,
        macdSignal,
        histogram,
        atr,
        vwap
      },

      volume: {
        currentVolume,
        averageVolume,
        relativeVolume,
        volumeTrend
      },

      levels: {
        support,
        resistance
      },

      tradePlan: {

        buyZone: {
          low: buyZoneLow,
          high: buyZoneHigh
        },

        stopLoss,
        target,

        riskPerShare,
        rewardPerShare,
        riskRewardRatio
      },

      positionSizing: {
        accountSize,
        riskPercent,
        maxRiskAmount,
        suggestedShares
      },

      source: "Twelve Data"
    });

  }

  catch (error) {

    console.error(error);

    res.status(500).json({
      error: "Failed to fetch live data"
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});