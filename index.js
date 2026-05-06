import express from "express";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

const BASE_URL = "https://api.twelvedata.com";

const DEFAULT_ACCOUNT_SIZE = 5000;
const DEFAULT_RISK_PERCENT = 1;
const DEFAULT_INTERVAL = "15min";

const OUTPUT_SIZE = 200;
const MIN_CANDLES = 75;
const RECENT_LEVEL_CANDLES = 30;

app.get("/", (req, res) => {
  res.send("Stock backend is running");
});

function safeNumber(value) {
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function round(value, decimals = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  return Number(num.toFixed(decimals));
}

function hasApiError(data) {
  return (
    data?.status === "error" ||
    data?.code ||
    typeof data?.message === "string"
  );
}

function getApiErrorMessage(data) {
  if (!data) return "No data returned";
  return data.message || data.status || data.code || "Unknown API error";
}

async function fetchJson(url) {
  const response = await fetch(url);
  const data = await response.json();

  return {
    ok: response.ok && !hasApiError(data),
    status: response.status,
    data
  };
}

function normaliseCandles(rawCandles) {
  if (!Array.isArray(rawCandles)) return [];

  return rawCandles
    .map(candle => ({
      datetime: candle.datetime,
      open: safeNumber(candle.open),
      high: safeNumber(candle.high),
      low: safeNumber(candle.low),
      close: safeNumber(candle.close),
      volume: safeNumber(candle.volume)
    }))
    .filter(candle =>
      candle.open !== null &&
      candle.high !== null &&
      candle.low !== null &&
      candle.close !== null
    );
}

// Twelve Data usually returns newest first.
// Most indicator calculations need oldest first.
function oldestFirst(candles) {
  return [...candles].reverse();
}

function newestFirst(candles) {
  return [...candles];
}

function calculateEMAValues(values, period) {
  if (!Array.isArray(values) || values.length < period) return [];

  const multiplier = 2 / (period + 1);
  const emaValues = [];

  const firstSMA =
    values.slice(0, period).reduce((sum, value) => sum + value, 0) / period;

  let previousEMA = firstSMA;

  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) {
      emaValues.push(null);
    } else if (i === period - 1) {
      emaValues.push(previousEMA);
    } else {
      const ema = (values[i] - previousEMA) * multiplier + previousEMA;
      emaValues.push(ema);
      previousEMA = ema;
    }
  }

  return emaValues;
}

function calculateLatestEMA(candlesOldestFirst, period) {
  const closes = candlesOldestFirst.map(c => c.close);
  const emaValues = calculateEMAValues(closes, period);
  const latest = emaValues[emaValues.length - 1];

  return round(latest, 5);
}

function calculateRSI(candlesOldestFirst, period = 14) {
  const closes = candlesOldestFirst.map(c => c.close);

  if (closes.length < period + 1) return null;

  let gains = 0;
  let losses = 0;

  for (let i = 1; i <= period; i++) {
    const change = closes[i] - closes[i - 1];

    if (change >= 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }

  let averageGain = gains / period;
  let averageLoss = losses / period;

  for (let i = period + 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? Math.abs(change) : 0;

    averageGain =
      (averageGain * (period - 1) + gain) / period;

    averageLoss =
      (averageLoss * (period - 1) + loss) / period;
  }

  if (averageLoss === 0) return 100;

  const rs = averageGain / averageLoss;
  const rsi = 100 - 100 / (1 + rs);

  return round(rsi, 5);
}

function calculateMACD(candlesOldestFirst) {
  const closes = candlesOldestFirst.map(c => c.close);

  if (closes.length < 35) {
    return {
      macd: null,
      macdSignal: null,
      histogram: null
    };
  }

  const ema12 = calculateEMAValues(closes, 12);
  const ema26 = calculateEMAValues(closes, 26);

  const macdLine = closes.map((_, index) => {
    if (ema12[index] === null || ema26[index] === null) return null;
    return ema12[index] - ema26[index];
  });

  const validMacdValues = macdLine.filter(value => value !== null);

  if (validMacdValues.length < 9) {
    return {
      macd: null,
      macdSignal: null,
      histogram: null
    };
  }

  const signalValues = calculateEMAValues(validMacdValues, 9);

  const latestMacd = validMacdValues[validMacdValues.length - 1];
  const latestSignal = signalValues[signalValues.length - 1];

  if (latestSignal === null || latestSignal === undefined) {
    return {
      macd: null,
      macdSignal: null,
      histogram: null
    };
  }

  return {
    macd: round(latestMacd, 8),
    macdSignal: round(latestSignal, 8),
    histogram: round(latestMacd - latestSignal, 8)
  };
}

function calculateATR(candlesOldestFirst, period = 14) {
  if (candlesOldestFirst.length < period + 1) return null;

  const trueRanges = [];

  for (let i = 1; i < candlesOldestFirst.length; i++) {
    const current = candlesOldestFirst[i];
    const previous = candlesOldestFirst[i - 1];

    const highLow = current.high - current.low;
    const highClose = Math.abs(current.high - previous.close);
    const lowClose = Math.abs(current.low - previous.close);

    trueRanges.push(Math.max(highLow, highClose, lowClose));
  }

  if (trueRanges.length < period) return null;

  let atr =
    trueRanges.slice(0, period).reduce((sum, value) => sum + value, 0) / period;

  for (let i = period; i < trueRanges.length; i++) {
    atr = (atr * (period - 1) + trueRanges[i]) / period;
  }

  return round(atr, 5);
}

function calculateVWAP(candlesNewestFirst) {
  let cumulativeTPV = 0;
  let cumulativeVolume = 0;

  for (const candle of candlesNewestFirst) {
    if (candle.volume === null || candle.volume <= 0) continue;

    const typicalPrice =
      (candle.high + candle.low + candle.close) / 3;

    cumulativeTPV += typicalPrice * candle.volume;
    cumulativeVolume += candle.volume;
  }

  if (cumulativeVolume <= 0) return null;

  return round(cumulativeTPV / cumulativeVolume, 2);
}

function calculateSupportResistance(candlesNewestFirst) {
  const lows = candlesNewestFirst
    .map(candle => candle.low)
    .filter(value => value !== null);

  const highs = candlesNewestFirst
    .map(candle => candle.high)
    .filter(value => value !== null);

  if (!lows.length || !highs.length) {
    return {
      support: null,
      resistance: null
    };
  }

  return {
    support: round(Math.min(...lows), 2),
    resistance: round(Math.max(...highs), 2)
  };
}

function calculateVolume(candlesNewestFirst) {
  const volumes = candlesNewestFirst
    .map(candle => candle.volume)
    .filter(value => value !== null && value >= 0);

  if (!volumes.length) {
    return {
      currentVolume: null,
      averageVolume: null,
      relativeVolume: null,
      volumeTrend: "Unknown"
    };
  }

  const currentVolume = volumes[0];

  const averageVolume = round(
    volumes.reduce((sum, value) => sum + value, 0) / volumes.length,
    0
  );

  const relativeVolume =
    averageVolume && averageVolume > 0
      ? round(currentVolume / averageVolume, 2)
      : null;

  let volumeTrend = "Normal";

  if (relativeVolume === null) {
    volumeTrend = "Unknown";
  } else if (relativeVolume >= 1.5) {
    volumeTrend = "High";
  } else if (relativeVolume <= 0.7) {
    volumeTrend = "Low";
  }

  return {
    currentVolume,
    averageVolume,
    relativeVolume,
    volumeTrend
  };
}

function calculateTrend({ livePrice, ema20, ema50, vwap }) {
  if (
    livePrice === null ||
    ema20 === null ||
    ema50 === null ||
    vwap === null
  ) {
    return "Neutral";
  }

  if (livePrice > ema20 && ema20 > ema50 && livePrice > vwap) {
    return "Bullish";
  }

  if (livePrice < ema20 && ema20 < ema50 && livePrice < vwap) {
    return "Bearish";
  }

  return "Neutral";
}

function calculateSignal({ trend, rsi, histogram, relativeVolume }) {
  if (
    rsi === null ||
    histogram === null ||
    relativeVolume === null
  ) {
    return "Hold";
  }

  if (
    trend === "Bullish" &&
    rsi > 55 &&
    histogram > 0 &&
    relativeVolume >= 1
  ) {
    return "Buy";
  }

  if (
    trend === "Bearish" &&
    rsi < 45 &&
    histogram < 0 &&
    relativeVolume >= 1
  ) {
    return "Sell";
  }

  return "Hold";
}

function buildLongTradePlan({
  livePrice,
  atr,
  nearSupport,
  nearResistance,
  accountSize,
  riskPercent
}) {
  if (
    livePrice === null ||
    atr === null ||
    nearSupport === null ||
    nearResistance === null ||
    atr <= 0
  ) {
    return null;
  }

  const entryLow = round(livePrice - atr * 0.5, 2);
  const entryHigh = round(livePrice + atr * 0.25, 2);

  const atrStop = livePrice - atr * 1.5;
  const stopLossCandidate = Math.max(nearSupport, atrStop);

  const stopLoss =
    stopLossCandidate < livePrice
      ? round(stopLossCandidate, 2)
      : null;

  if (stopLoss === null) return null;

  const atrTarget = livePrice + atr * 3;

  const targetCandidate =
    nearResistance > livePrice
      ? Math.min(atrTarget, nearResistance)
      : atrTarget;

  const target = round(targetCandidate, 2);

  const riskPerUnit = round(livePrice - stopLoss, 2);
  const rewardPerUnit = round(target - livePrice, 2);

  if (
    riskPerUnit === null ||
    rewardPerUnit === null ||
    riskPerUnit <= 0 ||
    rewardPerUnit <= 0
  ) {
    return null;
  }

  const riskRewardRatio = round(rewardPerUnit / riskPerUnit, 2);

  const maxRiskAmount = round(accountSize * (riskPercent / 100), 2);
  const suggestedUnits = Math.floor(maxRiskAmount / riskPerUnit);
  const estimatedMaxLoss = round(suggestedUnits * riskPerUnit, 2);

  return {
    direction: "long",
    entryZone: {
      low: entryLow,
      high: entryHigh
    },
    stopLoss,
    target,
    riskPerUnit,
    rewardPerUnit,
    riskRewardRatio,
    suggestedUnits,
    estimatedMaxLoss,
    invalidationLevel: stopLoss,
    levelBasis: "nearSupport / nearResistance"
  };
}

function buildShortTradePlan({
  livePrice,
  atr,
  nearSupport,
  nearResistance,
  accountSize,
  riskPercent
}) {
  if (
    livePrice === null ||
    atr === null ||
    nearSupport === null ||
    nearResistance === null ||
    atr <= 0
  ) {
    return null;
  }

  const entryLow = round(livePrice - atr * 0.25, 2);
  const entryHigh = round(livePrice + atr * 0.5, 2);

  const atrStop = livePrice + atr * 1.5;
  const stopLossCandidate = Math.min(nearResistance, atrStop);

  const stopLoss =
    stopLossCandidate > livePrice
      ? round(stopLossCandidate, 2)
      : null;

  if (stopLoss === null) return null;

  const atrTarget = livePrice - atr * 3;

  const targetCandidate =
    nearSupport < livePrice
      ? Math.max(atrTarget, nearSupport)
      : atrTarget;

  const target = round(targetCandidate, 2);

  const riskPerUnit = round(stopLoss - livePrice, 2);
  const rewardPerUnit = round(livePrice - target, 2);

  if (
    riskPerUnit === null ||
    rewardPerUnit === null ||
    riskPerUnit <= 0 ||
    rewardPerUnit <= 0
  ) {
    return null;
  }

  const riskRewardRatio = round(rewardPerUnit / riskPerUnit, 2);

  const maxRiskAmount = round(accountSize * (riskPercent / 100), 2);
  const suggestedUnits = Math.floor(maxRiskAmount / riskPerUnit);
  const estimatedMaxLoss = round(suggestedUnits * riskPerUnit, 2);

  return {
    direction: "short",
    entryZone: {
      low: entryLow,
      high: entryHigh
    },
    stopLoss,
    target,
    riskPerUnit,
    rewardPerUnit,
    riskRewardRatio,
    suggestedUnits,
    estimatedMaxLoss,
    invalidationLevel: stopLoss,
    levelBasis: "nearSupport / nearResistance"
  };
}

function classifyTradeQuality({
  signal,
  trend,
  longPlan,
  shortPlan,
  relativeVolume,
  maxRiskAmount
}) {
  if (relativeVolume === null) {
    return "Avoid";
  }

  if (
    signal === "Buy" &&
    trend === "Bullish" &&
    longPlan &&
    longPlan.riskRewardRatio >= 2 &&
    longPlan.estimatedMaxLoss <= maxRiskAmount &&
    longPlan.suggestedUnits > 0 &&
    relativeVolume >= 1
  ) {
    return "Valid long setup";
  }

  if (
    signal === "Sell" &&
    trend === "Bearish" &&
    shortPlan &&
    shortPlan.riskRewardRatio >= 2 &&
    shortPlan.estimatedMaxLoss <= maxRiskAmount &&
    shortPlan.suggestedUnits > 0 &&
    relativeVolume >= 1
  ) {
    return "Valid short setup";
  }

  if (trend === "Bullish" || trend === "Bearish") {
    return "Watchlist only";
  }

  return "Avoid";
}

function buildRejectionReasons({
  trend,
  signal,
  longPlan,
  shortPlan,
  relativeVolume,
  maxRiskAmount
}) {
  const long = [];
  const short = [];

  if (!longPlan) {
    long.push("Long trade plan unavailable");
  } else {
    if (longPlan.riskRewardRatio < 2) {
      long.push("Long risk/reward is below 1:2");
    }

    if (longPlan.suggestedUnits <= 0) {
      long.push("Long position size is too small for account risk settings");
    }

    if (longPlan.estimatedMaxLoss > maxRiskAmount) {
      long.push("Long estimated max loss exceeds allowed risk");
    }

    if (trend !== "Bullish") {
      long.push("Long rejected because trend is not bullish");
    }

    if (signal !== "Buy") {
      long.push("Long rejected because signal is not Buy");
    }

    if (relativeVolume === null) {
      long.push("Long rejected because relative volume is unavailable");
    } else if (relativeVolume < 1) {
      long.push("Long rejected because volume confirmation is weak");
    }
  }

  if (!shortPlan) {
    short.push("Short trade plan unavailable");
  } else {
    if (shortPlan.riskRewardRatio < 2) {
      short.push("Short risk/reward is below 1:2");
    }

    if (shortPlan.suggestedUnits <= 0) {
      short.push("Short position size is too small for account risk settings");
    }

    if (shortPlan.estimatedMaxLoss > maxRiskAmount) {
      short.push("Short estimated max loss exceeds allowed risk");
    }

    if (trend !== "Bearish") {
      short.push("Short rejected because trend is not bearish");
    }

    if (signal !== "Sell") {
      short.push("Short rejected because signal is not Sell");
    }

    if (relativeVolume === null) {
      short.push("Short rejected because relative volume is unavailable");
    } else if (relativeVolume < 1) {
      short.push("Short rejected because volume confirmation is weak");
    }
  }

  return {
    long,
    short
  };
}

async function analyseTimeframe({
  ticker,
  interval,
  accountSize,
  riskPercent
}) {
  const apiKey = process.env.TWELVE_DATA_API_KEY;

  if (!apiKey) {
    return {
      ticker,
      interval,
      status: "incomplete",
      reason: "Missing TWELVE_DATA_API_KEY environment variable",
      tradeQuality: "Avoid"
    };
  }

  const candlesUrl =
    `${BASE_URL}/time_series?symbol=${encodeURIComponent(ticker)}&interval=${encodeURIComponent(interval)}&outputsize=${OUTPUT_SIZE}&apikey=${apiKey}`;

  const candlesResult = await fetchJson(candlesUrl);

  if (!candlesResult.ok) {
    return {
      ticker,
      interval,
      status: "incomplete",
      reason: getApiErrorMessage(candlesResult.data),
      dataQuality: {
        status: "incomplete",
        candlesReceived: 0,
        candlesRequired: MIN_CANDLES,
        requestedOutputSize: OUTPUT_SIZE,
        recentLevelCandlesUsed: 0,
        apiErrors: [
          {
            endpoint: "time_series",
            status: candlesResult.status,
            message: getApiErrorMessage(candlesResult.data)
          }
        ],
        missingFields: ["candles"],
        canGenerateTradePlan: false
      },
      livePrice: null,
      indicators: {
        rsi: null,
        ema20: null,
        ema50: null,
        macd: null,
        macdSignal: null,
        histogram: null,
        atr: null,
        vwap: null
      },
      volume: {
        currentVolume: null,
        averageVolume: null,
        relativeVolume: null,
        volumeTrend: "Unknown"
      },
      levels: {
        sessionSupport: null,
        sessionResistance: null,
        nearSupport: null,
        nearResistance: null
      },
      tradePlan: null,
      rejectionReasons: {
        long: ["Trade plan unavailable because required data is incomplete"],
        short: ["Trade plan unavailable because required data is incomplete"]
      },
      positionSizing: {
        accountSize,
        riskPercent,
        maxRiskAmount: round(accountSize * (riskPercent / 100), 2),
        suggestedUnits: null
      },
      tradeQuality: "Avoid",
      source: "Twelve Data time_series"
    };
  }

  const candlesNewest = newestFirst(
    normaliseCandles(candlesResult.data.values)
  );

  const candlesOldest = oldestFirst(candlesNewest);

  const recentCandles = candlesNewest.slice(0, RECENT_LEVEL_CANDLES);

  const missingFields = [];

  if (candlesNewest.length < MIN_CANDLES) {
    missingFields.push("sufficientCandles");
  }

  const latestCandle = candlesNewest[0] || null;
  const livePrice = latestCandle ? round(latestCandle.close, 5) : null;

  if (livePrice === null) missingFields.push("livePrice");

  const rsi = calculateRSI(candlesOldest, 14);
  const ema20 = calculateLatestEMA(candlesOldest, 20);
  const ema50 = calculateLatestEMA(candlesOldest, 50);
  const macdData = calculateMACD(candlesOldest);
  const atr = calculateATR(candlesOldest, 14);

  const vwap =
    candlesNewest.length >= MIN_CANDLES
      ? calculateVWAP(candlesNewest)
      : null;

  const volume =
    candlesNewest.length >= MIN_CANDLES
      ? calculateVolume(candlesNewest)
      : {
          currentVolume: null,
          averageVolume: null,
          relativeVolume: null,
          volumeTrend: "Unknown"
        };

  const sessionLevels =
    candlesNewest.length >= MIN_CANDLES
      ? calculateSupportResistance(candlesNewest)
      : { support: null, resistance: null };

  const nearLevels =
    recentCandles.length >= 10
      ? calculateSupportResistance(recentCandles)
      : { support: null, resistance: null };

  if (rsi === null) missingFields.push("rsi");
  if (ema20 === null) missingFields.push("ema20");
  if (ema50 === null) missingFields.push("ema50");
  if (macdData.macd === null) missingFields.push("macd");
  if (macdData.macdSignal === null) missingFields.push("macdSignal");
  if (macdData.histogram === null) missingFields.push("macdHistogram");
  if (atr === null) missingFields.push("atr");
  if (vwap === null) missingFields.push("vwap");
  if (volume.relativeVolume === null) missingFields.push("relativeVolume");
  if (sessionLevels.support === null) missingFields.push("sessionSupport");
  if (sessionLevels.resistance === null) missingFields.push("sessionResistance");
  if (nearLevels.support === null) missingFields.push("nearSupport");
  if (nearLevels.resistance === null) missingFields.push("nearResistance");

  const uniqueMissingFields = [...new Set(missingFields)];

  const dataQuality = {
    status: uniqueMissingFields.length ? "incomplete" : "complete",
    candlesReceived: candlesNewest.length,
    candlesRequired: MIN_CANDLES,
    requestedOutputSize: OUTPUT_SIZE,
    recentLevelCandlesUsed: recentCandles.length,
    apiErrors: [],
    missingFields: uniqueMissingFields,
    canGenerateTradePlan: uniqueMissingFields.length === 0
  };

  if (!dataQuality.canGenerateTradePlan) {
    return {
      ticker,
      interval,
      status: "incomplete",
      reason: "Missing required live technical data",
      dataQuality,
      livePrice,
      indicators: {
        rsi,
        ema20,
        ema50,
        macd: macdData.macd,
        macdSignal: macdData.macdSignal,
        histogram: macdData.histogram,
        atr,
        vwap
      },
      volume,
      levels: {
        sessionSupport: sessionLevels.support,
        sessionResistance: sessionLevels.resistance,
        nearSupport: nearLevels.support,
        nearResistance: nearLevels.resistance
      },
      tradePlan: null,
      rejectionReasons: {
        long: ["Trade plan unavailable because required data is incomplete"],
        short: ["Trade plan unavailable because required data is incomplete"]
      },
      positionSizing: {
        accountSize,
        riskPercent,
        maxRiskAmount: round(accountSize * (riskPercent / 100), 2),
        suggestedUnits: null
      },
      tradeQuality: "Avoid",
      source: "Twelve Data time_series"
    };
  }

  const trend = calculateTrend({
    livePrice,
    ema20,
    ema50,
    vwap
  });

  const signal = calculateSignal({
    trend,
    rsi,
    histogram: macdData.histogram,
    relativeVolume: volume.relativeVolume
  });

  const maxRiskAmount = round(accountSize * (riskPercent / 100), 2);

  const longPlan = buildLongTradePlan({
    livePrice,
    atr,
    nearSupport: nearLevels.support,
    nearResistance: nearLevels.resistance,
    accountSize,
    riskPercent
  });

  const shortPlan = buildShortTradePlan({
    livePrice,
    atr,
    nearSupport: nearLevels.support,
    nearResistance: nearLevels.resistance,
    accountSize,
    riskPercent
  });

  const tradeQuality = classifyTradeQuality({
    signal,
    trend,
    longPlan,
    shortPlan,
    relativeVolume: volume.relativeVolume,
    maxRiskAmount
  });

  const rejectionReasons = buildRejectionReasons({
    trend,
    signal,
    longPlan,
    shortPlan,
    relativeVolume: volume.relativeVolume,
    maxRiskAmount
  });

  let preferredPlan = null;

  if (tradeQuality === "Valid long setup") {
    preferredPlan = longPlan;
  }

  if (tradeQuality === "Valid short setup") {
    preferredPlan = shortPlan;
  }

  return {
    ticker,
    interval,
    status: "success",
    livePrice,

    trend,
    signal,
    tradeQuality,

    indicators: {
      rsi,
      ema20,
      ema50,
      macd: macdData.macd,
      macdSignal: macdData.macdSignal,
      histogram: macdData.histogram,
      atr,
      vwap,
      vwapNote:
        "VWAP is calculated from returned candles. For best day-trading accuracy, anchor VWAP to the current US regular session."
    },

    volume,

    levels: {
      sessionSupport: sessionLevels.support,
      sessionResistance: sessionLevels.resistance,
      nearSupport: nearLevels.support,
      nearResistance: nearLevels.resistance
    },

    tradePlan: {
      preferred: preferredPlan,
      long: longPlan,
      short: shortPlan
    },

    rejectionReasons,

    positionSizing: {
      accountSize,
      riskPercent,
      maxRiskAmount,
      suggestedUnits:
        preferredPlan?.suggestedUnits ?? null
    },

    dataQuality,

    riskRules: {
      minimumRiskReward: 2,
      maxTradeRiskPercent: riskPercent,
      maxRiskAmount,
      capitalProtectionRule:
        "Reject trade if risk/reward is below 1:2, data is incomplete, volume is weak, or position size exceeds max risk."
    },

    source: "Twelve Data time_series with internal indicator calculations"
  };
}

app.get("/technical-analysis", async (req, res) => {
  try {
    const ticker = String(req.query.ticker || "").toUpperCase().trim();
    const interval = String(req.query.interval || DEFAULT_INTERVAL).trim();

    const accountSize =
      safeNumber(req.query.accountSize) || DEFAULT_ACCOUNT_SIZE;

    const riskPercent =
      safeNumber(req.query.riskPercent) || DEFAULT_RISK_PERCENT;

    if (!ticker) {
      return res.status(400).json({
        error: "Ticker is required"
      });
    }

    const result = await analyseTimeframe({
      ticker,
      interval,
      accountSize,
      riskPercent
    });

    const statusCode =
      result.status === "incomplete" ? 422 : 200;

    res.status(statusCode).json(result);

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Failed to fetch live data",
      details: error.message
    });
  }
});

app.get("/multi-timeframe-analysis", async (req, res) => {
  try {
    const ticker = String(req.query.ticker || "").toUpperCase().trim();

    const accountSize =
      safeNumber(req.query.accountSize) || DEFAULT_ACCOUNT_SIZE;

    const riskPercent =
      safeNumber(req.query.riskPercent) || DEFAULT_RISK_PERCENT;

    if (!ticker) {
      return res.status(400).json({
        error: "Ticker is required"
      });
    }

    const intervals = ["5min", "15min", "30min"];

    const results = await Promise.all(
      intervals.map(interval =>
        analyseTimeframe({
          ticker,
          interval,
          accountSize,
          riskPercent
        })
      )
    );

    const timeframeData = {};

    for (const result of results) {
      timeframeData[result.interval] = result;
    }

    const fiveMin = timeframeData["5min"];
    const fifteenMin = timeframeData["15min"];
    const thirtyMin = timeframeData["30min"];

    const allDataComplete = results.every(result => {
      return (
        result.dataQuality?.status === "complete" &&
        result.dataQuality?.canGenerateTradePlan === true
      );
    });

    const trends = {
      "5min": fiveMin?.trend || "Unknown",
      "15min": fifteenMin?.trend || "Unknown",
      "30min": thirtyMin?.trend || "Unknown"
    };

    const signals = {
      "5min": fiveMin?.signal || "Unknown",
      "15min": fifteenMin?.signal || "Unknown",
      "30min": thirtyMin?.signal || "Unknown"
    };

    const tradeQualities = {
      "5min": fiveMin?.tradeQuality || "Unknown",
      "15min": fifteenMin?.tradeQuality || "Unknown",
      "30min": thirtyMin?.tradeQuality || "Unknown"
    };

    const longPlans = {
      "5min": fiveMin?.tradePlan?.long || null,
      "15min": fifteenMin?.tradePlan?.long || null,
      "30min": thirtyMin?.tradePlan?.long || null
    };

    const shortPlans = {
      "5min": fiveMin?.tradePlan?.short || null,
      "15min": fifteenMin?.tradePlan?.short || null,
      "30min": thirtyMin?.tradePlan?.short || null
    };

    const longRiskRewards = {
      "5min": longPlans["5min"]?.riskRewardRatio ?? null,
      "15min": longPlans["15min"]?.riskRewardRatio ?? null,
      "30min": longPlans["30min"]?.riskRewardRatio ?? null
    };

    const shortRiskRewards = {
      "5min": shortPlans["5min"]?.riskRewardRatio ?? null,
      "15min": shortPlans["15min"]?.riskRewardRatio ?? null,
      "30min": shortPlans["30min"]?.riskRewardRatio ?? null
    };

    const longTrendAligned =
      trends["5min"] === "Bullish" &&
      trends["15min"] === "Bullish" &&
      trends["30min"] === "Bullish";

    const shortTrendAligned =
      trends["5min"] === "Bearish" &&
      trends["15min"] === "Bearish" &&
      trends["30min"] === "Bearish";

    const longSignalConfirmed =
      signals["5min"] === "Buy" &&
      signals["15min"] === "Buy";

    const shortSignalConfirmed =
      signals["5min"] === "Sell" &&
      signals["15min"] === "Sell";

    const longRiskRewardValid =
      longRiskRewards["5min"] >= 2 &&
      longRiskRewards["15min"] >= 2 &&
      longRiskRewards["30min"] >= 2;

    const shortRiskRewardValid =
      shortRiskRewards["5min"] >= 2 &&
      shortRiskRewards["15min"] >= 2 &&
      shortRiskRewards["30min"] >= 2;

    const longVolumeConfirmed =
      fiveMin?.volume?.relativeVolume >= 1 &&
      fifteenMin?.volume?.relativeVolume >= 1;

    const shortVolumeConfirmed =
      fiveMin?.volume?.relativeVolume >= 1 &&
      fifteenMin?.volume?.relativeVolume >= 1;

    const maxRiskAmount = round(accountSize * (riskPercent / 100), 2);

    const rejectionReasons = [];

    if (!allDataComplete) {
      rejectionReasons.push("One or more timeframes have incomplete data");
    }

    if (!longTrendAligned) {
      rejectionReasons.push("Long rejected because 5min, 15min, and 30min trends are not all bullish");
    }

    if (!longSignalConfirmed) {
      rejectionReasons.push("Long rejected because 5min and 15min signals are not both Buy");
    }

    if (!longRiskRewardValid) {
      rejectionReasons.push("Long rejected because risk/reward is not at least 1:2 across all timeframes");
    }

    if (!longVolumeConfirmed) {
      rejectionReasons.push("Long rejected because volume confirmation is weak");
    }

    if (!shortTrendAligned) {
      rejectionReasons.push("Short rejected because 5min, 15min, and 30min trends are not all bearish");
    }

    if (!shortSignalConfirmed) {
      rejectionReasons.push("Short rejected because 5min and 15min signals are not both Sell");
    }

    if (!shortRiskRewardValid) {
      rejectionReasons.push("Short rejected because risk/reward is not at least 1:2 across all timeframes");
    }

    if (!shortVolumeConfirmed) {
      rejectionReasons.push("Short rejected because volume confirmation is weak");
    }

    let finalDecision = "Avoid";
    let preferredDirection = null;
    let preferredPlan = null;
    let finalReason = "";

    if (
      allDataComplete &&
      longTrendAligned &&
      longSignalConfirmed &&
      longRiskRewardValid &&
      longVolumeConfirmed
    ) {
      finalDecision = "Buy";
      preferredDirection = "long";
      preferredPlan = longPlans["5min"];
      finalReason =
        "Valid long setup: all timeframes are bullish, 5min and 15min signals confirm Buy, volume is acceptable, and risk/reward is at least 1:2.";
    }

    else if (
      allDataComplete &&
      shortTrendAligned &&
      shortSignalConfirmed &&
      shortRiskRewardValid &&
      shortVolumeConfirmed
    ) {
      finalDecision = "Sell";
      preferredDirection = "short";
      preferredPlan = shortPlans["5min"];
      finalReason =
        "Valid short setup: all timeframes are bearish, 5min and 15min signals confirm Sell, volume is acceptable, and risk/reward is at least 1:2.";
    }

    else if (
      allDataComplete &&
      (
        trends["5min"] === "Bullish" ||
        trends["15min"] === "Bullish" ||
        trends["30min"] === "Bullish" ||
        trends["5min"] === "Bearish" ||
        trends["15min"] === "Bearish" ||
        trends["30min"] === "Bearish"
      )
    ) {
      finalDecision = "Watchlist only";
      finalReason =
        "Some structure exists, but the setup does not meet full multi-timeframe confirmation and capital-protection rules.";
    }

    else {
      finalDecision = "Avoid";
      finalReason =
        "No high-quality multi-timeframe setup exists.";
    }

    res.json({
      ticker,
      status: "success",

      account: {
        accountSize,
        riskPercent,
        maxRiskAmount
      },

      finalDecision,
      preferredDirection,
      preferredPlan,

      finalReason,

      multiTimeframeSummary: {
        trends,
        signals,
        tradeQualities,
        longRiskRewards,
        shortRiskRewards,
        allDataComplete,
        longTrendAligned,
        shortTrendAligned,
        longSignalConfirmed,
        shortSignalConfirmed,
        longRiskRewardValid,
        shortRiskRewardValid,
        longVolumeConfirmed,
        shortVolumeConfirmed
      },

      rejectionReasons,

      timeframes: {
        "5min": fiveMin,
        "15min": fifteenMin,
        "30min": thirtyMin
      },

      capitalProtection: {
        maxRiskPerTrade: maxRiskAmount,
        minimumRiskReward: 2,
        rule:
          "Reject trade unless data is complete, trend is aligned, signal is confirmed, volume is acceptable, and risk/reward is at least 1:2."
      },

      source: "Twelve Data time_series with internal indicator calculations"
    });

  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: "Failed to run multi-timeframe analysis",
      details: error.message
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});