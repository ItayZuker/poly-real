const $ = (id) => document.getElementById(id);

let markets = [];
let selectedSeries = "btc-5m";
let windowState = null;
let countdownTimer = null;
let chartCanvas = null;
let chartCtx = null;
let chartWindowStart = null;

const MAX_LOG_LINES = 500;

const SIGNATURE_TYPE_LABELS = {
  0: "EOA",
  1: "Proxy",
  2: "Gnosis Safe",
  3: "Deposit",
};

function shortAddress(addr) {
  if (!addr || addr.length < 10) return addr || "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatUsdcBalance(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return "—";
  return `$${(value / 1_000_000).toFixed(2)}`;
}

function renderWalletAccount(data) {
  const statusEl = $("wallet-status");
  const balanceEl = $("wallet-balance");
  const signerEl = $("wallet-signer");
  const funderEl = $("wallet-funder");
  const sigTypeEl = $("wallet-sig-type");
  if (!statusEl || !balanceEl || !signerEl || !funderEl || !sigTypeEl) return;

  if (!data?.connected) {
    statusEl.textContent = data?.error ? "Error" : "Not connected";
    statusEl.className = "wallet-summary-value wallet-summary-value-negative";
    balanceEl.textContent = "—";
    signerEl.textContent = "—";
    signerEl.title = "";
    funderEl.textContent = "—";
    funderEl.title = "";
    sigTypeEl.textContent = "—";
    return;
  }

  statusEl.textContent = "Connected";
  statusEl.className = "wallet-summary-value wallet-summary-value-positive";
  balanceEl.textContent = formatUsdcBalance(data.collateralBalance);
  signerEl.textContent = shortAddress(data.signerAddress);
  signerEl.title = data.signerAddress || "";
  funderEl.textContent = shortAddress(data.funderAddress);
  funderEl.title = data.funderAddress || "";
  const sigLabel = SIGNATURE_TYPE_LABELS[data.signatureType] ?? `Type ${data.signatureType}`;
  sigTypeEl.textContent = `${sigLabel} (${data.signatureType})`;
}

async function loadWalletAccount() {
  try {
    const res = await fetch("/api/account");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderWalletAccount(await res.json());
  } catch {
    renderWalletAccount({ connected: false, error: "Failed to load" });
  }
}

function bindWalletBalanceRefresh() {
  const btn = $("wallet-balance-refresh");
  if (!btn || btn.dataset.bound === "1") return;
  btn.dataset.bound = "1";
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    btn.classList.add("is-loading");
    try {
      await loadWalletAccount();
    } finally {
      btn.disabled = false;
      btn.classList.remove("is-loading");
    }
  });
}

const HEATMAP_METRICS = [
  {
    key: "crossings",
    label: "Crossings",
    tip: "Average times price crossed the price-to-beat in that hour.",
    rgb: "88, 166, 255",
  },
  {
    key: "range",
    label: "Range",
    tip: "Average max up plus max down distance from price-to-beat.",
    rgb: "63, 185, 80",
  },
  {
    key: "wallets",
    label: "Wallets",
    tip: "Average unique traders across windows in that hour.",
    rgb: "201, 209, 217",
  },
  {
    key: "newWallets",
    label: "New wallets",
    tip: "Average wallets new to the registry in that hour.",
    rgb: "188, 140, 255",
  },
];

let heatmapCellEls = new Map();
let lastHeatmapState = null;

function formatLogTime(date = new Date()) {
  return date.toLocaleTimeString("en-GB", { hour12: false });
}

function isLogAtBottom(output, threshold = 12) {
  return output.scrollHeight - output.scrollTop - output.clientHeight <= threshold;
}

function appendLogEntry(entry) {
  const output = $("log-output");
  if (!output) return;

  const { message, level = "info", source, tMs } = entry ?? {};
  if (!message) return;

  const stickToBottom = isLogAtBottom(output);

  const line = document.createElement("div");
  line.className = `log-line log-line-${level}`;

  const time = document.createElement("span");
  time.className = "log-line-time";
  time.textContent = formatLogTime(tMs ? new Date(tMs) : new Date());

  const sourceEl = document.createElement("span");
  sourceEl.className = "log-line-source";
  if (source) sourceEl.textContent = `[${source}] `;

  const text = document.createElement("span");
  text.textContent = String(message);

  line.append(time, sourceEl, text);
  output.appendChild(line);

  while (output.children.length > MAX_LOG_LINES) {
    output.removeChild(output.firstChild);
  }

  if (stickToBottom) {
    output.scrollTop = output.scrollHeight;
  }
}

function appendLog(message) {
  appendLogEntry({ message, level: "info" });
}

function clearLog() {
  const output = $("log-output");
  if (output) output.replaceChildren();
}

function scrollLogToBottom() {
  const output = $("log-output");
  if (!output) return;
  output.scrollTop = output.scrollHeight;
}

function scrollPositionsToBottom() {
  const body = $("positions-list");
  if (!body) return;
  body.scrollTop = body.scrollHeight;
}

async function clearPositions() {
  try {
    const res = await fetch("/api/trading/positions/clear", { method: "POST" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || `Clear failed (${res.status})`);
    }
  } catch (err) {
    appendLog(`Positions clear failed: ${err.message || err}`);
  }
}

function fmtPrice(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  if (v >= 1000) return `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  return `$${v.toFixed(2)}`;
}

function fmtGap(value) {
  if (value == null || !Number.isFinite(value)) return "—";
  const sign = value >= 0 ? "+" : "-";
  return sign + fmtPrice(Math.abs(value));
}

function fmtQuote(v) {
  if (v == null || !Number.isFinite(v)) return "—";
  return (v * 100).toFixed(1) + "¢";
}

const QUOTE_BOXES = [
  {
    boxId: "quote-up-buy-box",
    lockedId: "up-buy-locked",
    liveId: "up-buy",
    lockKey: "upBuy",
    side: "up",
    leg: "buy",
    livePrice: (state) => state.yesAsk,
    tone: "up",
  },
  {
    boxId: "quote-up-sell-box",
    lockedId: "up-sell-locked",
    liveId: "up-sell",
    lockKey: "upSell",
    side: "up",
    leg: "sell",
    livePrice: (state) => state.yesBid,
    tone: "up",
  },
  {
    boxId: "quote-down-buy-box",
    lockedId: "down-buy-locked",
    liveId: "down-buy",
    lockKey: "downBuy",
    side: "down",
    leg: "buy",
    livePrice: (state) => state.noAsk,
    tone: "down",
  },
  {
    boxId: "quote-down-sell-box",
    lockedId: "down-sell-locked",
    liveId: "down-sell",
    lockKey: "downSell",
    side: "down",
    leg: "sell",
    livePrice: (state) => state.noBid,
    tone: "down",
  },
];

function tradingState(state) {
  return state?.trading ?? null;
}

function canQuoteAction(trading, side, leg) {
  if (trading && trading.quotesEnabled === false) return false;
  if (!trading) return true;
  const pos = trading.positions?.[side];
  if (leg === "buy") return !pos;
  return Boolean(pos);
}

function updateQuoteBoxes(state) {
  const trading = tradingState(state);
  const locks = trading?.quoteLocks ?? state?.sim?.quoteLocks ?? {};
  for (const cfg of QUOTE_BOXES) {
    const box = $(cfg.boxId);
    const locked = $(cfg.lockedId);
    const live = $(cfg.liveId);
    const values = locked?.parentElement;
    if (!box || !locked || !live || !values) continue;

    live.textContent = fmtQuote(cfg.livePrice(state));

    const allowed = canQuoteAction(trading, cfg.side, cfg.leg);
    box.classList.toggle("quote-box-disabled", !allowed);

    const lockedPrice = locks[cfg.lockKey];
    if (lockedPrice != null && Number.isFinite(lockedPrice)) {
      locked.hidden = false;
      locked.textContent = fmtQuote(lockedPrice);
      values.classList.add("quote-has-locked");
      box.classList.add(cfg.tone === "up" ? "quote-triggered-up" : "quote-triggered-down");
      box.classList.add("quote-box-latched");
      box.classList.remove("quote-box-pressing");
    } else {
      locked.hidden = true;
      locked.textContent = "";
      values.classList.remove("quote-has-locked");
      box.classList.remove("quote-triggered-up", "quote-triggered-down", "quote-box-latched");
    }
  }
}

let quoteOrderInFlight = false;

const ORDER_RETRY_BASE_MS = 500;
const ORDER_RETRY_MAX_MS = 3000;

function sleepMs(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isNonRetriableOrderError(message) {
  const msg = String(message || "").toLowerCase();
  if (!msg) return false;
  return (
    msg.includes("not configured") ||
    msg.includes("start trading") ||
    msg.includes("already holding") ||
    msg.includes("no position") ||
    msg.includes("already in progress") ||
    msg.includes("invalid share")
  );
}

async function postTradingOrder(side, leg) {
  const res = await fetch("/api/trading/order", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ side, leg }),
  });
  const body = await res.json().catch(() => ({}));
  return { ok: res.ok, status: res.status, body };
}

async function clickQuoteBox(side, leg) {
  if (quoteOrderInFlight) return;
  const trading = tradingState(windowState);
  if (trading && !canQuoteAction(trading, side, leg)) return;

  quoteOrderInFlight = true;
  const boxId = QUOTE_BOXES.find((b) => b.side === side && b.leg === leg)?.boxId;
  const box = boxId ? $(boxId) : null;
  if (box) box.classList.add("quote-box-pending");

  let attempt = 0;
  try {
    while (true) {
      attempt += 1;
      try {
        const { ok, status, body } = await postTradingOrder(side, leg);
        if (ok) {
          if (attempt > 1) {
            appendLogEntry({
              level: "info",
              source: "trading",
              message: `${leg.toUpperCase()} ${side.toUpperCase()} filled after ${attempt} attempts`,
            });
          }
          const winRes = await fetch(`/api/window?series=${encodeURIComponent(selectedSeries)}`);
          if (winRes.ok) updateWindowUI(await winRes.json());
          void loadWalletAccount();
          return;
        }

        const errMsg = body.error || `Order failed (${status})`;
        if (isNonRetriableOrderError(errMsg)) {
          appendLogEntry({
            level: "error",
            source: "trading",
            message: errMsg,
          });
          if (box) box.classList.remove("quote-box-pressing");
          return;
        }

        appendLogEntry({
          level: "warn",
          source: "trading",
          message: `${errMsg} — retrying ${leg} ${side} (attempt ${attempt})…`,
        });
      } catch (err) {
        appendLogEntry({
          level: "warn",
          source: "trading",
          message: `Order error: ${err.message || err} — retrying ${leg} ${side} (attempt ${attempt})…`,
        });
      }

      const delay = Math.min(ORDER_RETRY_MAX_MS, ORDER_RETRY_BASE_MS * attempt);
      await sleepMs(delay);
    }
  } finally {
    quoteOrderInFlight = false;
    if (box) box.classList.remove("quote-box-pending");
  }
}

function bindQuoteBoxes() {
  for (const cfg of QUOTE_BOXES) {
    const box = $(cfg.boxId);
    if (!box || box.dataset.bound === "1") continue;
    box.dataset.bound = "1";

    box.addEventListener("mousedown", (e) => {
      if (e.button !== 0 || box.classList.contains("quote-box-disabled")) return;
      box.classList.add("quote-box-pressing");
    });

    const releasePress = () => {
      if (!box.classList.contains("quote-box-latched")) {
        box.classList.remove("quote-box-pressing");
      }
    };

    box.addEventListener("mouseup", releasePress);
    box.addEventListener("mouseleave", releasePress);

    box.addEventListener("click", () => {
      void clickQuoteBox(cfg.side, cfg.leg);
    });
  }
}

function fmtTickDelta(delta) {
  if (delta == null || !Number.isFinite(delta)) return "—";
  const sign = delta >= 0 ? "+" : "-";
  const abs = Math.abs(delta);
  if (abs >= 1000) {
    return `${sign}$${abs.toLocaleString("en-US", { maximumFractionDigits: 2 })}`;
  }
  if (abs >= 1) return `${sign}$${abs.toFixed(2)}`;
  return `${sign}$${abs.toFixed(4)}`;
}

function setSignedValue(el, text, sign) {
  el.textContent = text;
  el.className = "sim-value";
  if (sign > 0) el.classList.add("gap-positive");
  else if (sign < 0) el.classList.add("gap-negative");
}

function windowPricePoints(state) {
  const history = state?.priceHistory || [];
  const windowStart = state?.windowStart;
  const windowEnd = state?.windowEnd;
  if (!windowStart || !windowEnd) return [];

  const points = history.filter((p) => p.t >= windowStart && p.t < windowEnd);
  if (
    state.assetPrice != null &&
    Number.isFinite(state.assetPrice) &&
    !points.some((p) => p.price === state.assetPrice)
  ) {
    const nowSec = Math.floor(Date.now() / 1000);
    if (nowSec >= windowStart && nowSec < windowEnd) {
      points.push({ t: nowSec, price: state.assetPrice });
    }
  }
  points.sort((a, b) => a.t - b.t);
  return points;
}

function initSimulatorBoxScrollbars() {
  const MIN_THUMB_PX = 32;
  document.querySelectorAll(".simulator-box-scroll").forEach((scrollEl) => {
    if (scrollEl.dataset.customScrollbar) return;
    scrollEl.dataset.customScrollbar = "1";

    const wrap = document.createElement("div");
    wrap.className = "simulator-box-scroll-wrap";
    scrollEl.parentNode.insertBefore(wrap, scrollEl);
    wrap.appendChild(scrollEl);

    const track = document.createElement("div");
    track.className = "simulator-box-scrollbar-track";
    track.setAttribute("aria-hidden", "true");
    const thumb = document.createElement("div");
    thumb.className = "simulator-box-scrollbar-thumb";
    track.appendChild(thumb);
    wrap.appendChild(track);

    const update = () => {
      const { scrollWidth, clientWidth, scrollLeft } = scrollEl;
      const overflow = scrollWidth - clientWidth;
      if (overflow <= 1) {
        track.hidden = true;
        return;
      }
      track.hidden = false;
      const thumbWidth = Math.max(MIN_THUMB_PX, (clientWidth / scrollWidth) * clientWidth);
      const travel = Math.max(0, clientWidth - thumbWidth);
      const ratio = scrollLeft / overflow;
      thumb.style.width = `${thumbWidth}px`;
      thumb.style.transform = `translateX(${ratio * travel}px)`;
    };

    scrollEl.addEventListener("scroll", update, { passive: true });
    if (window.ResizeObserver) {
      new ResizeObserver(update).observe(scrollEl);
      new ResizeObserver(update).observe(wrap);
    }
    window.addEventListener("resize", update);
    update();
  });
}

function initChart() {
  chartCanvas = $("price-chart");
  if (!chartCanvas) return;
  chartCtx = chartCanvas.getContext("2d");
  const wrap = chartCanvas.parentElement;
  if (window.ResizeObserver) {
    new ResizeObserver(() => drawPriceChart(windowState)).observe(wrap);
  }
  window.addEventListener("resize", () => drawPriceChart(windowState));
  if (window.Simulator) window.Simulator.init(chartCanvas);
  resizeChartCanvas();
}

window.drawPriceChart = drawPriceChart;

const MIN_COLUMN_PCT = 25;
const MAX_COLUMN_PCT = 75;

function setColumnSplit(pct) {
  const page = $("page-simulator");
  const splitter = $("column-splitter");
  if (!page) return;
  const clamped = Math.max(MIN_COLUMN_PCT, Math.min(MAX_COLUMN_PCT, pct));
  page.style.setProperty("--split-left-pct", String(clamped));
  if (splitter) splitter.setAttribute("aria-valuenow", String(Math.round(clamped)));
}

function initLeftRowSplitter() {
  const leftColumn = document.querySelector(".left-column");
  const settingsHeader = document.querySelector(".settings-panel-header");
  const prevHeader = document.querySelector(".positions-panel-header");
  const logHeader = document.querySelector(".log-panel-header");
  const prevBody = document.querySelector(".positions-body");
  const logBody = document.querySelector(".log-output");
  const prevDragHandle = document.querySelector('[data-drag-edge="prev"]');
  const logDragHandle = document.querySelector('[data-drag-edge="log"]');
  if (
    !leftColumn ||
    !settingsHeader ||
    !prevHeader ||
    !logHeader ||
    !prevDragHandle ||
    !logDragHandle ||
    !prevBody ||
    !logBody
  ) {
    return;
  }

  let dragging = false;
  let dragKind = null;
  let anchorLogHeaderTop = 0;
  let anchorLogContent = 0;
  let anchorSettingsContent = 0;
  let activeHandle = null;

  const parseHeight = (name, fallback) => {
    const raw = getComputedStyle(leftColumn).getPropertyValue(name);
    const value = raw ? parseFloat(raw) : Number.NaN;
    return Number.isFinite(value) ? value : fallback;
  };

  const getMetrics = () => {
    const colRect = leftColumn.getBoundingClientRect();
    const settingsHeaderH = settingsHeader.offsetHeight;
    const prevHeaderH = prevHeader.offsetHeight;
    const logHeaderH = logHeader.offsetHeight;
    const chrome = settingsHeaderH + prevHeaderH + logHeaderH;
    const maxContent = Math.max(0, colRect.height - chrome);
    return { colRect, settingsHeaderH, prevHeaderH, logHeaderH, chrome, maxContent };
  };

  const readHeights = () => ({
    settings: parseHeight("--settings-content-height", 140),
    prev: parseHeight("--prev-content-height", 0),
    log: parseHeight("--log-content-height", 0),
  });

  const applyHeights = (settings, prev, log) => {
    const { colRect, chrome } = getMetrics();
    const s = Math.max(0, settings);
    const p = Math.max(0, prev);
    let l = Math.max(0, log);

    leftColumn.style.setProperty("--settings-content-height", `${s}px`);
    leftColumn.style.setProperty("--prev-content-height", `${p}px`);
    leftColumn.style.setProperty("--log-content-height", `${l}px`);

    const stackHeight = chrome + s + p + l;
    const margin = l <= 0 ? Math.max(0, colRect.height - stackHeight) : 0;
    leftColumn.style.setProperty("--log-margin-top", `${margin}px`);

    prevBody.classList.toggle("is-collapsed", p <= 0);
    logBody.classList.toggle("is-collapsed", l <= 0);
    const hasPositionCards = Boolean(prevBody.querySelector(".position-card"));
    prevBody.classList.toggle("is-scrollable", p > 0 && hasPositionCards);
    logBody.classList.toggle("is-scrollable", l > 0);
  };

  const initDefaultHeights = () => {
    const { maxContent } = getMetrics();
    applyHeights(maxContent, 0, 0);
  };

  const clampPrevDrag = (clientY) => {
    const { colRect, settingsHeaderH, prevHeaderH } = getMetrics();
    const settingsBottom = colRect.top + settingsHeaderH;
    const logTop = anchorLogHeaderTop;
    const minPrevTop = settingsBottom;
    const maxPrevTop = logTop - prevHeaderH;
    const prevTop = Math.max(minPrevTop, Math.min(clientY, maxPrevTop));
    const settings = prevTop - settingsBottom;
    const prev = logTop - prevTop - prevHeaderH;
    applyHeights(settings, prev, anchorLogContent);
  };

  const clampLogDrag = (clientY) => {
    const { colRect, logHeaderH } = getMetrics();
    const prevBottom = prevHeader.getBoundingClientRect().bottom;
    const maxLogTop = colRect.bottom - logHeaderH;
    let logTop = Math.max(prevBottom, Math.min(clientY, maxLogTop));
    let prev = logTop - prevBottom;
    if (prev < 1) {
      prev = 0;
      logTop = prevBottom;
    }
    const logTopCol = logTop - colRect.top;
    const log = Math.max(0, colRect.height - logTopCol - logHeaderH);
    applyHeights(anchorSettingsContent, prev, log);
  };

  const stopDragging = () => {
    if (!dragging) return;
    dragging = false;
    dragKind = null;
    activeHandle?.classList.remove("is-dragging");
    activeHandle = null;
    document.body.classList.remove("is-row-resizing");
  };

  const startPrevDrag = (e) => {
    if (e.button !== 0) return;
    dragging = true;
    dragKind = "prev";
    activeHandle = prevDragHandle;
    anchorLogHeaderTop = logHeader.getBoundingClientRect().top;
    anchorLogContent = readHeights().log;
    activeHandle.classList.add("is-dragging");
    document.body.classList.add("is-row-resizing");
    clampPrevDrag(e.clientY);
    e.preventDefault();
  };

  const startLogDrag = (e) => {
    if (e.button !== 0) return;
    dragging = true;
    dragKind = "log";
    activeHandle = logDragHandle;
    anchorSettingsContent = readHeights().settings;
    activeHandle.classList.add("is-dragging");
    document.body.classList.add("is-row-resizing");
    clampLogDrag(e.clientY);
    e.preventDefault();
  };

  initDefaultHeights();
  window.addEventListener("resize", () => {
    const heights = readHeights();
    applyHeights(heights.settings, heights.prev, heights.log);
  });

  prevDragHandle.addEventListener("mousedown", startPrevDrag);
  logDragHandle.addEventListener("mousedown", startLogDrag);

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    if (dragKind === "prev") clampPrevDrag(e.clientY);
    else if (dragKind === "log") clampLogDrag(e.clientY);
  });

  window.addEventListener("mouseup", stopDragging);
  window.addEventListener("blur", stopDragging);
}

function initColumnSplitter() {
  const page = $("page-simulator");
  const splitter = $("column-splitter");
  if (!page || !splitter) return;

  let dragging = false;

  const updateFromClientX = (clientX) => {
    const rect = page.getBoundingClientRect();
    const pct = ((clientX - rect.left) / rect.width) * 100;
    setColumnSplit(pct);
  };

  const stopDragging = () => {
    if (!dragging) return;
    dragging = false;
    splitter.classList.remove("is-dragging");
    document.body.classList.remove("is-column-resizing");
  };

  splitter.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    dragging = true;
    splitter.classList.add("is-dragging");
    document.body.classList.add("is-column-resizing");
    updateFromClientX(e.clientX);
    e.preventDefault();
  });

  window.addEventListener("mousemove", (e) => {
    if (!dragging) return;
    updateFromClientX(e.clientX);
  });

  window.addEventListener("mouseup", stopDragging);
  window.addEventListener("blur", stopDragging);

  splitter.addEventListener("keydown", (e) => {
    const current = Number(page.style.getPropertyValue("--split-left-pct")) || 50;
    if (e.key === "ArrowLeft") {
      setColumnSplit(current - 2);
      e.preventDefault();
    } else if (e.key === "ArrowRight") {
      setColumnSplit(current + 2);
      e.preventDefault();
    }
  });
}

function resizeChartCanvasFor(canvas) {
  const wrap = canvas.parentElement;
  const dpr = window.devicePixelRatio || 1;
  const width = wrap?.clientWidth ?? canvas.clientWidth;
  const height = wrap?.clientHeight ?? canvas.clientHeight;
  canvas.width = Math.max(1, Math.floor(width * dpr));
  canvas.height = Math.max(1, Math.floor(height * dpr));
  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;
  const ctx = canvas.getContext("2d");
  if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, width, height };
}

function resizeChartCanvas() {
  if (!chartCanvas) return;
  const { ctx } = resizeChartCanvasFor(chartCanvas);
  if (ctx) chartCtx = ctx;
}

function chartXToFrac(x, layout) {
  return Math.min(1, Math.max(0, (x - layout.padding.left) / layout.plotW));
}

function buildChartLayout(state, width, height) {
  const padding = { top: 10, right: 10, bottom: 22, left: 10 };
  const plotW = width - padding.left - padding.right;
  const plotH = height - padding.top - padding.bottom;
  const windowStart = state?.windowStart;
  const windowEnd = state?.windowEnd;
  const duration =
    windowStart && windowEnd ? windowEnd - windowStart : 300;

  let minP = 0;
  let maxP = 1;
  const points = windowPricePoints(state);
  const ptb = state?.prevCloseAsset;

  if (points.length > 0) {
    const prices = points.map((p) => p.price);
    if (ptb != null && Number.isFinite(ptb)) prices.push(ptb);
    minP = Math.min(...prices);
    maxP = Math.max(...prices);
    const spread = maxP - minP || Math.max(minP * 0.001, 1);
    const margin = spread * 0.1;
    minP -= margin;
    maxP += margin;
  } else if (ptb != null && Number.isFinite(ptb)) {
    minP = ptb * 0.999;
    maxP = ptb * 1.001;
  } else if (state?.assetPrice != null) {
    minP = state.assetPrice * 0.999;
    maxP = state.assetPrice * 1.001;
  }

  const xAt = (t) =>
    windowStart
      ? padding.left + ((t - windowStart) / duration) * plotW
      : padding.left;
  const yAt = (price) =>
    padding.top + plotH - ((price - minP) / (maxP - minP)) * plotH;

  return {
    padding,
    plotW,
    plotH,
    width,
    height,
    windowStart,
    windowEnd,
    duration,
    minP,
    maxP,
    points,
    ptb,
    xAt,
    yAt,
  };
}

function drawPriceChart(state, options = {}) {
  const canvas = options.canvas ?? chartCanvas;
  if (!canvas) return null;

  let ctx;
  let width;
  let height;
  if (options.canvas) {
    const resized = resizeChartCanvasFor(canvas);
    ctx = resized.ctx;
    width = resized.width;
    height = resized.height;
  } else {
    if (!chartCtx) return null;
    resizeChartCanvas();
    ctx = chartCtx;
    width = chartCanvas.clientWidth;
    height = chartCanvas.clientHeight;
  }

  ctx.clearRect(0, 0, width, height);

  const layout = buildChartLayout(state, width, height);
  const { padding, plotW, plotH, points, ptb, xAt, yAt } = layout;

  if (plotW <= 0 || plotH <= 0) return layout;

  if (!options.canvas && window.Simulator) {
    window.Simulator.setChartLayout(layout);
  }

  const overlayOpts = {};
  if (options.setupOverride) overlayOpts.setupOverride = options.setupOverride;
  if (options.markers === false) overlayOpts.markers = false;
  if (options.hoverLine !== undefined) overlayOpts.hoverLine = options.hoverLine;
  if (options.dragLine !== undefined) overlayOpts.dragLine = options.dragLine;
  const trading = state?.trading;
  if (trading) {
    const cfg = trading.config;
    let phasesOn = Boolean(trading.phasesVisible);
    if (!phasesOn && cfg?.autoTrade && !cfg.useSchedule) phasesOn = true;
    if (!phasesOn && cfg?.autoTrade && trading.phaseSetup) phasesOn = true;
    // Setup editor passes its own override + canvas; force phases on there.
    if (options.setupOverride && options.canvas) phasesOn = true;
    overlayOpts.phasesVisible = phasesOn;
    overlayOpts.phasesEditable = trading.phasesEditable;
    if (!options.setupOverride) {
      // Prefer the editable local draft while phases can be dragged; otherwise the
      // same trading.phaseSetup used for schedule/active setup overlay.
      const editable = trading.phasesEditable !== false;
      const localDraft =
        editable && window.Simulator?.getLocalSetup ? window.Simulator.getLocalSetup() : null;
      const setup =
        localDraft ||
        trading.phaseSetup ||
        (cfg?.autoTrade && !cfg.useSchedule ? state.sim?.setup : null);
      if (setup) overlayOpts.setupOverride = setup;
    }
    if (Array.isArray(trading.markers)) overlayOpts.markersOverride = trading.markers;
  }

  ctx.strokeStyle = "#21262d";
  ctx.lineWidth = 1;
  for (let i = 0; i <= 4; i += 1) {
    const y = padding.top + (plotH * i) / 4;
    ctx.beginPath();
    ctx.moveTo(padding.left, y);
    ctx.lineTo(width - padding.right, y);
    ctx.stroke();
  }

  if (layout.windowStart && layout.windowEnd) {
    ctx.fillStyle = "#6e7681";
    ctx.font = "10px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.fillText("0:00", padding.left, height - padding.bottom + 4);
    ctx.fillText(
      `${Math.floor(layout.duration / 60)}:${String(layout.duration % 60).padStart(2, "0")}`,
      width - padding.right,
      height - padding.bottom + 4,
    );
  }

  if (!layout.windowStart || !layout.windowEnd) {
    ctx.fillStyle = "#8b949e";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Waiting for window…", width / 2, height / 2);
    if (window.Simulator) window.Simulator.drawOverlay(ctx, layout, state, overlayOpts);
    return layout;
  }

  if (points.length === 0) {
    ctx.fillStyle = "#8b949e";
    ctx.font = "11px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Waiting for price data…", width / 2, height / 2);
    if (window.Simulator) window.Simulator.drawOverlay(ctx, layout, state, overlayOpts);
    return layout;
  }

  if (ptb != null && Number.isFinite(ptb)) {
    const ptbY = yAt(ptb);
    ctx.strokeStyle = "#d29922";
    ctx.setLineDash([5, 4]);
    ctx.beginPath();
    ctx.moveTo(padding.left, ptbY);
    ctx.lineTo(width - padding.right, ptbY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = "#d29922";
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillText("PTB", padding.left + 4, ptbY - 2);
  }

  const last = points[points.length - 1];
  const lineColor =
    ptb != null && last.price >= ptb ? "#3fb950" : "#f85149";

  ctx.strokeStyle = lineColor;
  ctx.lineWidth = 2;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  points.forEach((point, index) => {
    const x = xAt(point.t);
    const y = yAt(point.price);
    if (index === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  const endX = xAt(last.t);
  const endY = yAt(last.price);
  ctx.fillStyle = lineColor;
  ctx.beginPath();
  ctx.arc(endX, endY, 3.5, 0, Math.PI * 2);
  ctx.fill();

  if (window.Simulator) {
    window.Simulator.drawOverlay(ctx, layout, state, overlayOpts);
  }

  return layout;
}

function updateGraphPanel(state) {
  $("graph-ptb").textContent = fmtPrice(state.prevCloseAsset);
  $("graph-current").textContent = fmtPrice(state.assetPrice);

  const gapEl = $("graph-gap");
  if (state.assetGap != null && Number.isFinite(state.assetGap)) {
    setSignedValue(gapEl, fmtGap(state.assetGap), state.assetGap);
  } else {
    gapEl.textContent = "—";
    gapEl.className = "sim-value";
  }

  const history = state.priceHistory || [];
  let tickDelta = null;
  if (history.length >= 2) {
    tickDelta = history[history.length - 1].price - history[history.length - 2].price;
  }
  const tickEl = $("graph-tick");
  if (tickDelta != null && Number.isFinite(tickDelta)) {
    setSignedValue(tickEl, fmtTickDelta(tickDelta), tickDelta);
  } else {
    tickEl.textContent = "—";
    tickEl.className = "sim-value";
  }

  if (chartWindowStart !== state.windowStart) {
    chartWindowStart = state.windowStart;
  }

  if (!window.Simulator?.isDraggingPhaseLine?.()) {
    drawPriceChart(state);
    if (window.SetupEditor?.refreshChart) window.SetupEditor.refreshChart();
  }
}

function fmtUsdSigned(amount) {
  if (amount == null || !Number.isFinite(amount)) return "—";
  const sign = amount >= 0 ? "+" : "-";
  return sign + fmtUsdAmount(Math.abs(amount));
}

function fmtUsdAmount(amount) {
  if (amount == null || !Number.isFinite(amount)) return "—";
  return `$${amount.toFixed(2)}`;
}

function fmtPriceCents(price) {
  if (price == null || !Number.isFinite(price)) return "—";
  const cents = price * 100;
  return Number.isInteger(cents) ? `${cents}¢` : `${cents.toFixed(1)}¢`;
}

function fmtTradeLeg(side, shares, price) {
  if (!side || shares == null || price == null) return "—";
  const label = side === "up" ? "UP" : "DOWN";
  return `${label} ${shares} @ ${fmtPriceCents(price)}`;
}

function positionStatusLabel(status) {
  if (status === "open") return "Open";
  if (status === "sold") return "Sold";
  if (status === "win") return "Win";
  if (status === "loss") return "Loss";
  return status || "—";
}

function renderPositionCard(card) {
  const sideClass = card.side === "up" ? "is-up" : "is-down";
  const status = card.status || "open";
  const buyText = `${card.shares} @ ${fmtPriceCents(card.buyPrice)}`;
  let detailHtml = `<div class="position-card-row"><span>Buy</span><strong>${buyText}</strong></div>`;

  if (status === "sold") {
    detailHtml += `<div class="position-card-row"><span>Sell</span><strong>${card.shares} @ ${fmtPriceCents(card.sellPrice)}</strong></div>`;
  } else if (status === "win" || status === "loss") {
    detailHtml += `<div class="position-card-row"><span>Settlement</span><strong>${(card.outcome || "—").toUpperCase()}</strong></div>`;
  }

  if (card.pl != null && Number.isFinite(card.pl)) {
    const plClass = card.pl > 0 ? "is-positive" : card.pl < 0 ? "is-negative" : "";
    detailHtml += `<div class="position-card-row"><span>P/L</span><strong class="position-card-pl ${plClass}">${fmtUsdSigned(card.pl)}</strong></div>`;
  }

  const sourceNote = card.confirmed ? "Confirmed" : "Pending confirm";
  return `<article class="position-card is-${status}" data-position-id="${card.id}">
    <div class="position-card-top">
      <span class="position-card-side ${sideClass}">${(card.side || "").toUpperCase()}</span>
      <span class="position-card-status">${positionStatusLabel(status)}</span>
    </div>
    ${detailHtml}
    <div class="position-card-row"><span>Source</span><strong>${sourceNote}</strong></div>
  </article>`;
}

let lastPositionsFingerprint = "";

function positionsFingerprint(cards) {
  if (!Array.isArray(cards) || cards.length === 0) return "";
  return cards
    .map((c) => `${c.id}:${c.status}:${c.shares}:${c.buyPrice}:${c.buyCost}:${c.sellPrice ?? ""}:${c.pl ?? ""}:${c.confirmed ? 1 : 0}`)
    .join("|");
}

function syncPositionsScrollable() {
  const body = $("positions-list") || document.querySelector(".positions-body");
  if (!body) return;
  const height = parseFloat(getComputedStyle(body).flexBasis) || body.clientHeight;
  const hasCards = Boolean(body.querySelector(".position-card"));
  body.classList.toggle("is-scrollable", height > 0 && hasCards);
}

function updatePositionsPanel(state) {
  const list = $("positions-cards");
  const empty = $("positions-empty");
  if (!list || !empty) return;

  const cards = state?.trading?.positionCards;
  const fingerprint = positionsFingerprint(cards);
  if (fingerprint === lastPositionsFingerprint) return;
  lastPositionsFingerprint = fingerprint;

  if (!Array.isArray(cards) || cards.length === 0) {
    list.innerHTML = "";
    empty.hidden = false;
    syncPositionsScrollable();
    return;
  }

  empty.hidden = true;
  list.innerHTML = cards.map(renderPositionCard).join("");
  syncPositionsScrollable();
}

function syncGraphSaveBtn(state = windowState) {
  const btn = $("graph-save-btn");
  if (!btn) return;
  const visible = Boolean(state?.trading?.phasesEditable);
  btn.hidden = !visible;
  btn.setAttribute("aria-hidden", visible ? "false" : "true");
}

function updateWindowUI(state) {
  windowState = state;
  window.windowState = state;

  if (window.Simulator) window.Simulator.syncFromState(state);

  syncLatencyDisplay(state);
  syncGraphSaveBtn(state);
  updatePositionsPanel(state);
  updateQuoteBoxes(state);
  updateCountdown(state);
  updateGraphPanel(state);
}

function syncLatencyDisplay(state) {
  const el = $("feed-latency-ms");
  if (!el) return;
  const ms = state?.feedLatencyMs;
  el.textContent = Number.isFinite(ms) ? String(Math.round(ms)) : "—";
}

function updateCountdown(state) {
  if (!state?.windowEnd) return;
  const remaining = Math.max(0, state.windowEnd - Math.floor(Date.now() / 1000));
  const m = Math.floor(remaining / 60);
  const s = remaining % 60;
  $("countdown").textContent = `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function populateMarketSelect() {
  const sel = $("market-select");
  sel.innerHTML = "";
  for (const m of markets) {
    const opt = document.createElement("option");
    opt.value = m._id;
    opt.textContent = m.label;
    if (m._id === selectedSeries) opt.selected = true;
    sel.appendChild(opt);
  }
}

async function loadMarkets() {
  const res = await fetch("/api/markets");
  markets = await res.json();
  populateMarketSelect();
}

function connectSSE() {
  const es = new EventSource("/api/stream");

  es.addEventListener("markets", (e) => {
    markets = JSON.parse(e.data);
    populateMarketSelect();
  });

  es.addEventListener("window", (e) => {
    const state = JSON.parse(e.data);
    if (state.series === selectedSeries || !state.series) {
      updateWindowUI(state);
    }
    if (state.trading?.placementStats && window.SchedulePlacements?.applyLivePlacementStats) {
      window.SchedulePlacements.applyLivePlacementStats(state.trading.placementStats);
    }
  });

  es.addEventListener("account", (e) => {
    renderWalletAccount(JSON.parse(e.data));
  });

  es.addEventListener("log-history", (e) => {
    clearLog();
    const entries = JSON.parse(e.data);
    if (Array.isArray(entries)) {
      for (const entry of entries) appendLogEntry(entry);
    }
  });

  es.addEventListener("log", (e) => {
    appendLogEntry(JSON.parse(e.data));
  });

  es.addEventListener("heatmap", (e) => {
    const state = JSON.parse(e.data);
    renderHeatmap(state);
    window.SchedulePlacements?.onHeatmapUpdated?.(state);
  });

  es.addEventListener("schedule-placements", (e) => {
    if (window.SchedulePlacements) {
      window.SchedulePlacements.setPlacements(JSON.parse(e.data));
    }
  });

  es.onerror = () => {
    appendLogEntry({ level: "warn", source: "client", message: "Stream disconnected, reconnecting…" });
    es.close();
    setTimeout(connectSSE, 2000);
  };
}

$("market-select").addEventListener("change", async (e) => {
  selectedSeries = e.target.value;
  const res = await fetch(`/api/window?series=${encodeURIComponent(selectedSeries)}`);
  if (res.ok) updateWindowUI(await res.json());
  if (window.SchedulePlacements?.refreshAllPlacementStats) {
    void window.SchedulePlacements.refreshAllPlacementStats();
  }
});

$("log-clear").addEventListener("click", () => {
  clearLog();
});

$("log-scroll-bottom").addEventListener("click", () => {
  scrollLogToBottom();
});

$("positions-clear")?.addEventListener("click", () => {
  void clearPositions();
});

$("positions-scroll-bottom")?.addEventListener("click", () => {
  scrollPositionsToBottom();
});

function syncSetupSaveSubmitState() {
  const title = $("setup-save-title")?.value?.trim() ?? "";
  const btn = $("setup-save-submit");
  if (btn) btn.disabled = !title;
}

function openSetupSaveModal() {
  const modal = $("setup-save-modal");
  const titleInput = $("setup-save-title");
  const descInput = $("setup-save-description");
  if (!modal || !titleInput) return;
  titleInput.value = "";
  if (descInput) descInput.value = "";
  syncSetupSaveSubmitState();
  modal.hidden = false;
  titleInput.focus();
}

function closeSetupSaveModal() {
  const modal = $("setup-save-modal");
  if (modal) modal.hidden = true;
}

async function saveTradingSetup() {
  const titleInput = $("setup-save-title");
  const descInput = $("setup-save-description");
  if (!titleInput) return;

  const title = titleInput.value.trim();
  if (!title) return;

  const description = descInput?.value?.trim() ?? "";
  closeSetupSaveModal();

  try {
    if (window.Simulator?.pushSetupToServer) {
      await window.Simulator.pushSetupToServer();
    }

    const res = await fetch("/api/trading-setups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title,
        description: description || undefined,
      }),
    });

    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Save failed (${res.status})`);
    }

    appendLogEntry({
      level: "success",
      source: "sim",
      message: `Trading setup saved: "${title}"`,
    });
    if (!$("page-schedule-heatmap")?.hidden) {
      void loadScheduleSetups();
    }
  } catch (err) {
    appendLogEntry({
      level: "error",
      source: "sim",
      message: `Failed to save trading setup: ${err.message || err}`,
    });
  }
}

let scheduleSetupsCache = [];
let openSetupMenuId = null;

function formatSetupListTitle(title, count) {
  return `(${count}) ${title}`;
}

function getSetupPlacementCounts() {
  return window.SchedulePlacements?.getPlacementCountsBySetup?.() ?? {};
}

function updateSetupListPlacementCounts() {
  const counts = getSetupPlacementCounts();
  document.querySelectorAll(".schedule-setup-item").forEach((item) => {
    const setupId = item.dataset.setupId;
    const setup = scheduleSetupsCache.find((s) => s._id === setupId);
    if (!setup) return;
    const titleEl = item.querySelector(".schedule-setup-item-title");
    if (titleEl) {
      titleEl.textContent = formatSetupListTitle(setup.title, counts[setupId] ?? 0);
    }
  });
}

window.updateSetupListPlacementCounts = updateSetupListPlacementCounts;

function applySetupColorStyle(el, color) {
  if (!el || !color) return;
  el.style.setProperty("--setup-color", color);
}

function getSetupColorById(setupId) {
  const setup = scheduleSetupsCache.find((s) => s._id === setupId);
  return setup?.color || "#58a6ff";
}

function applySetupColorUpdate(setupId, color) {
  if (!setupId || !color) return;
  const idx = scheduleSetupsCache.findIndex((s) => s._id === setupId);
  if (idx >= 0) {
    scheduleSetupsCache[idx] = { ...scheduleSetupsCache[idx], color };
  }
  const listItem = document.querySelector(`.schedule-setup-item[data-setup-id="${setupId}"]`);
  applySetupColorStyle(listItem, color);
  document.querySelectorAll(`.schedule-placement-card[data-setup-id="${setupId}"]`).forEach((card) => {
    applySetupColorStyle(card, color);
  });
}

window.applySetupColorUpdate = applySetupColorUpdate;
window.getSetupColorById = getSetupColorById;
window.getSelectedSeries = () => selectedSeries;
window.getScheduleSetupById = (setupId) => scheduleSetupsCache.find((s) => s._id === setupId) ?? null;
window.getSimLatencyMs = () => {
  const ms = window.windowState?.feedLatencyMs;
  if (Number.isFinite(ms)) return Math.max(0, Math.round(ms));
  const setupMs = window.windowState?.sim?.setup?.latencyMs;
  return Number.isFinite(setupMs) ? setupMs : 150;
};

function closeSetupMenus() {
  openSetupMenuId = null;
  document.querySelectorAll(".schedule-setup-menu").forEach((m) => m.remove());
}

function positionSetupMenu(menu, anchor) {
  const rect = anchor.getBoundingClientRect();
  const gap = 4;
  const menuHeight = menu.offsetHeight;
  const spaceBelow = window.innerHeight - rect.bottom - gap;
  const spaceAbove = rect.top - gap;
  const openDown = spaceBelow >= menuHeight || spaceBelow >= spaceAbove;
  let top = openDown ? rect.bottom + gap : rect.top - menuHeight - gap;
  top = Math.max(gap, Math.min(top, window.innerHeight - menuHeight - gap));
  menu.style.top = `${top}px`;
  menu.style.left = `${rect.right}px`;
  menu.style.transform = "translateX(-100%)";
}

async function afterTradingSetupChange(updatedSetup) {
  if (updatedSetup?._id) {
    const idx = scheduleSetupsCache.findIndex((s) => s._id === updatedSetup._id);
    if (idx >= 0) {
      scheduleSetupsCache[idx] = updatedSetup;
    } else {
      scheduleSetupsCache.unshift(updatedSetup);
    }
    renderScheduleSetupsList(scheduleSetupsCache);
    if (updatedSetup.color && window.applySetupColorUpdate) {
      window.applySetupColorUpdate(updatedSetup._id, updatedSetup.color);
    }
  } else {
    await loadScheduleSetups();
  }
  if (window.SchedulePlacements) {
    await window.SchedulePlacements.loadPlacements({ reloadStats: false });
  }
  if (updatedSetup?._id && window.SchedulePlacements?.refreshSetupPlacementStats) {
    void window.SchedulePlacements.refreshSetupPlacementStats(updatedSetup._id, { force: true });
  } else if (!updatedSetup?._id && window.SchedulePlacements?.refreshAllPlacementStats) {
    void window.SchedulePlacements.refreshAllPlacementStats();
  }
}

window.onTradingSetupUpdated = afterTradingSetupChange;
window.refreshScheduleSetupsList = () => loadScheduleSetups();

async function deleteTradingSetup(setup) {
  closeSetupMenus();
  if (setup?.simScheduleInUse === true) {
    appendLogEntry({
      level: "warn",
      source: "sim",
      message: `Cannot delete "${setup.title}": it is in use on the sim schedule`,
    });
    return;
  }
  const inLive = setup?.liveScheduleInUse === true;
  const confirmed = window.confirm(
    inLive
      ? `Delete "${setup.title}"?\n\nIt is currently placed on the live schedule. This will remove those schedule cards and cannot be undone.`
      : `Delete "${setup.title}"? This will remove it from the schedule and cannot be undone.`,
  );
  if (!confirmed) return;

  try {
    const res = await fetch(`/api/trading-setups/${encodeURIComponent(setup._id)}`, {
      method: "DELETE",
    });
    if (!res.ok && res.status !== 204) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Delete failed (${res.status})`);
    }
    await afterTradingSetupChange();
  } catch (err) {
    appendLogEntry({
      level: "error",
      source: "sim",
      message: `Failed to delete trading setup: ${err.message || err}`,
    });
  }
}

function openSetupEditor(setup) {
  closeSetupMenus();
  if (window.SetupEditor) window.SetupEditor.open(setup);
}

function switchToPage(page) {
  const btn = document.querySelector(`.page-toggle-btn[data-page="${page}"]`);
  if (btn && !btn.classList.contains("is-active")) btn.click();
}

async function duplicateTradingSetup(setup) {
  closeSetupMenus();
  if (!setup?.setup) return;
  try {
    const res = await fetch("/api/trading-setups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: `${setup.title} (Duplicated)`,
        description: setup.description || undefined,
        setup: JSON.parse(JSON.stringify(setup.setup)),
      }),
    });
    const saved = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(saved.error || `Duplicate failed (${res.status})`);
    }
    await afterTradingSetupChange(saved);
    appendLogEntry({
      level: "success",
      source: "sim",
      message: `Duplicated setup: "${saved.title}"`,
    });
  } catch (err) {
    appendLogEntry({
      level: "error",
      source: "sim",
      message: `Failed to duplicate setup: ${err.message || err}`,
    });
  }
}

async function applySetupToSimulator(setup) {
  closeSetupMenus();
  if (!setup?.setup) return;
  try {
    const useScheduleInput = $("use-schedule");
    if (useScheduleInput?.checked) {
      useScheduleInput.checked = false;
      const config = await pushTradingConfig(buildTradingConfigPatch());
      if (config) syncWalletControls(config);
    }
    const currentRes = await fetch("/api/sim/setup");
    const current = currentRes.ok ? await currentRes.json() : {};
    const latencyMs = window.getSimLatencyMs?.() ?? current.latencyMs ?? 150;
    const res = await fetch("/api/sim/setup", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        phaseSplit: setup.setup.phaseSplit,
        phases: setup.setup.phases,
        latencyMs,
        feeParams: current.feeParams,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body.error || `Apply failed (${res.status})`);
    }
    if (windowState?.sim) {
      windowState.sim.setup = body;
      if (window.Simulator?.forceSyncSetupFromState) {
        window.Simulator.forceSyncSetupFromState(windowState);
      } else if (window.Simulator) {
        window.Simulator.syncFromState(windowState);
      }
    }
    syncLatencyDisplay(windowState);
    switchToPage("simulator");
    if (windowState) {
      resizeChartCanvas();
      drawPriceChart(windowState);
    }
    appendLogEntry({
      level: "success",
      source: "sim",
      message: `Applied "${setup.title}" to simulator`,
    });
  } catch (err) {
    appendLogEntry({
      level: "error",
      source: "sim",
      message: `Failed to apply setup to simulator: ${err.message || err}`,
    });
  }
}

async function applySetupToSchedule(setup) {
  closeSetupMenus();
  if (!setup?._id) return;

  let existing = [];
  try {
    const listRes = await fetch("/api/schedule-placements");
    if (listRes.ok) existing = await listRes.json();
  } catch {
    // ignore
  }
  if (!existing.length) {
    appendLogEntry({
      level: "warn",
      source: "sim",
      message: "No placements on the schedule",
    });
    return;
  }

  const confirmed = window.confirm(
    `Apply "${setup.title}" to all schedule placements? Times will stay the same; only the setup will change.`,
  );
  if (!confirmed) return;

  try {
    const res = await fetch("/api/schedule-placements/apply-setup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        setupId: setup._id,
        title: setup.title,
      }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body.error || `Apply failed (${res.status})`);
    }
    if (window.SchedulePlacements?.setPlacements) {
      window.SchedulePlacements.setPlacements(body);
    }
    if (window.SchedulePlacements?.refreshAllPlacementStats) {
      void window.SchedulePlacements.refreshAllPlacementStats();
    }
    window.updateSetupListPlacementCounts?.();
    void loadScheduleSetups();
    appendLogEntry({
      level: "success",
      source: "sim",
      message: `Applied "${setup.title}" to all schedule placements`,
    });
  } catch (err) {
    appendLogEntry({
      level: "error",
      source: "sim",
      message: `Failed to apply setup to schedule: ${err.message || err}`,
    });
  }
}

function bindSetupListMenus() {
  document.addEventListener("click", (e) => {
    if (
      !e.target.closest(".schedule-setup-menu-btn") &&
      !e.target.closest(".schedule-setup-menu")
    ) {
      closeSetupMenus();
    }
  });
}

function bindSetupSaveModal() {
  $("graph-save-btn")?.addEventListener("click", () => {
    if ($("graph-save-btn")?.hidden) return;
    openSetupSaveModal();
  });
  $("setup-save-modal-close")?.addEventListener("click", closeSetupSaveModal);
  $("setup-save-cancel")?.addEventListener("click", closeSetupSaveModal);
  $("setup-save-submit")?.addEventListener("click", () => void saveTradingSetup());
  $("setup-save-title")?.addEventListener("input", syncSetupSaveSubmitState);
  $("setup-save-modal")?.addEventListener("click", (e) => {
    if (e.target.id === "setup-save-modal") closeSetupSaveModal();
  });
}

function renderScheduleSetupsList(setups, errorMessage) {
  const list = $("schedule-setups-list");
  if (!list) return;
  list.innerHTML = "";

  if (errorMessage) {
    const err = document.createElement("div");
    err.className = "schedule-setups-error";
    err.textContent = errorMessage;
    list.appendChild(err);
    return;
  }

  if (!setups?.length) {
    const empty = document.createElement("div");
    empty.className = "schedule-setups-empty";
    empty.textContent = "No saved setups";
    list.appendChild(empty);
    return;
  }

  for (const setup of setups) {
    const item = document.createElement("div");
    item.className = "schedule-setup-item";
    item.dataset.setupId = setup._id;
    applySetupColorStyle(item, setup.color);

    const handle = document.createElement("div");
    handle.className = "schedule-setup-drag-handle";
    handle.setAttribute("aria-label", "Drag to schedule");
    handle.title = "Drag to schedule";
    handle.innerHTML =
      '<svg viewBox="0 0 8 14" aria-hidden="true"><circle cx="2" cy="2" r="1.2" fill="currentColor"/><circle cx="6" cy="2" r="1.2" fill="currentColor"/><circle cx="2" cy="7" r="1.2" fill="currentColor"/><circle cx="6" cy="7" r="1.2" fill="currentColor"/><circle cx="2" cy="12" r="1.2" fill="currentColor"/><circle cx="6" cy="12" r="1.2" fill="currentColor"/></svg>';

    const body = document.createElement("div");
    body.className = "schedule-setup-item-body";

    const header = document.createElement("div");
    header.className = "schedule-setup-item-header";

    const main = document.createElement("div");
    main.className = "schedule-setup-item-main";

    const title = document.createElement("div");
    title.className = "schedule-setup-item-title";
    const placementCounts = getSetupPlacementCounts();
    title.textContent = formatSetupListTitle(setup.title, placementCounts[setup._id] ?? 0);
    main.appendChild(title);

    if (setup.description) {
      const desc = document.createElement("div");
      desc.className = "schedule-setup-item-desc";
      desc.textContent = setup.description;
      main.appendChild(desc);
    }

    const menuWrap = document.createElement("div");
    menuWrap.className = "schedule-setup-menu-wrap";
    const menuBtn = document.createElement("button");
    menuBtn.type = "button";
    menuBtn.className = "schedule-setup-menu-btn";
    menuBtn.setAttribute("aria-label", "Setup options");
    menuBtn.setAttribute("aria-haspopup", "menu");
    menuBtn.innerHTML = "&#8942;";
    menuBtn.addEventListener("mousedown", (e) => e.stopPropagation());
    menuBtn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (openSetupMenuId === setup._id) {
        closeSetupMenus();
        return;
      }
      closeSetupMenus();
      openSetupMenuId = setup._id;
      const menu = document.createElement("div");
      menu.className = "schedule-setup-menu schedule-setup-menu-floating";
      menu.setAttribute("role", "menu");

      const editBtn = document.createElement("button");
      editBtn.type = "button";
      editBtn.className = "schedule-setup-menu-item";
      editBtn.setAttribute("role", "menuitem");
      editBtn.textContent = "Edit";
      editBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        openSetupEditor(setup);
      });

      const duplicateBtn = document.createElement("button");
      duplicateBtn.type = "button";
      duplicateBtn.className = "schedule-setup-menu-item";
      duplicateBtn.setAttribute("role", "menuitem");
      duplicateBtn.textContent = "Duplicate";
      duplicateBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void duplicateTradingSetup(setup);
      });

      const applyBtn = document.createElement("button");
      applyBtn.type = "button";
      applyBtn.className = "schedule-setup-menu-item";
      applyBtn.setAttribute("role", "menuitem");
      applyBtn.textContent = "Apply to Simulator";
      applyBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void applySetupToSimulator(setup);
      });

      const applyScheduleBtn = document.createElement("button");
      applyScheduleBtn.type = "button";
      applyScheduleBtn.className = "schedule-setup-menu-item";
      applyScheduleBtn.setAttribute("role", "menuitem");
      applyScheduleBtn.textContent = "Apply to Schedule";
      applyScheduleBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void applySetupToSchedule(setup);
      });

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "schedule-setup-menu-item schedule-setup-menu-item-danger";
      deleteBtn.setAttribute("role", "menuitem");
      deleteBtn.textContent = "Delete";
      if (setup.simScheduleInUse === true) {
        deleteBtn.disabled = true;
        deleteBtn.classList.add("is-disabled");
        deleteBtn.title = "In use on the sim schedule — remove it there first";
      } else {
        deleteBtn.addEventListener("click", (ev) => {
          ev.stopPropagation();
          void deleteTradingSetup(setup);
        });
      }

      menu.append(editBtn, duplicateBtn, applyBtn, applyScheduleBtn, deleteBtn);
      document.body.appendChild(menu);
      positionSetupMenu(menu, menuBtn);
    });
    menuWrap.appendChild(menuBtn);

    header.append(main, menuWrap);
    body.appendChild(header);
    item.append(handle, body);
    list.appendChild(item);
  }

  if (window.SchedulePlacements) {
    window.SchedulePlacements.onSetupsRendered(setups);
  }
}

async function loadScheduleSetups() {
  const list = $("schedule-setups-list");
  if (!list) return;

  list.innerHTML = '<div class="schedule-setups-empty">Loading…</div>';

  try {
    const res = await fetch("/api/trading-setups");
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `Failed to load setups (${res.status})`);
    }
    const setups = await res.json();
    scheduleSetupsCache = setups;
    renderScheduleSetupsList(setups);
  } catch (err) {
    renderScheduleSetupsList([], err.message || "Failed to load setups");
  }
}

function initScheduleUtcColumn() {
  const body = document.querySelector(".schedule-utc-body");
  if (!body || body.children.length > 0) return;
  for (let hour = 0; hour < 24; hour++) {
    const slot = document.createElement("div");
    slot.className = "schedule-utc-hour";
    slot.dataset.hour = String(hour);
    slot.textContent = `${String(hour).padStart(2, "0")}:00`;
    body.appendChild(slot);
  }
}

function initScheduleDaySlots() {
  const bodies = document.querySelectorAll(".schedule-day-body");
  for (const body of bodies) {
    const firstSlot = body.querySelector(".schedule-hour-slot");
    if (firstSlot && !firstSlot.querySelector(".schedule-heatmap-row")) {
      body.replaceChildren();
    }
    if (body.children.length > 0) continue;
    for (let hour = 0; hour < 24; hour++) {
      const slot = document.createElement("div");
      slot.className = "schedule-hour-slot";
      slot.dataset.hour = String(hour);

      const row = document.createElement("div");
      row.className = "schedule-heatmap-row";
      for (const metric of HEATMAP_METRICS) {
        const cell = document.createElement("div");
        cell.className = "schedule-heatmap-cell";
        cell.dataset.metric = metric.key;
        const valueEl = document.createElement("span");
        valueEl.className = "schedule-heatmap-value";
        cell.appendChild(valueEl);
        row.appendChild(cell);
      }
      slot.appendChild(row);
      body.appendChild(slot);
    }
  }
  initHeatmapCellIndex();
}

function isHeatmapViewActive() {
  return $("page-schedule-heatmap")?.classList.contains("is-heatmap-view") ?? false;
}

function formatHeatmapValue(value, hasData) {
  if (!hasData || !Number.isFinite(value)) return "—";
  if (value === 0) return "0";
  if (Math.abs(value - Math.round(value)) < 0.05) return String(Math.round(value));
  return value.toFixed(1);
}

function clearHeatmapDisplay() {
  for (const cell of heatmapCellEls.values()) {
    cell.style.backgroundColor = "transparent";
    const valueEl = cell.querySelector(".schedule-heatmap-value");
    if (valueEl) {
      valueEl.textContent = "";
      valueEl.classList.remove("is-empty");
    }
  }
}

function initHeatmapCellIndex() {
  heatmapCellEls = new Map();
  document.querySelectorAll(".schedule-day-column").forEach((col) => {
    const day = col.dataset.day;
    if (!day) return;
    col.querySelectorAll(".schedule-hour-slot").forEach((slot) => {
      const hour = slot.dataset.hour;
      if (hour == null) return;
      slot.querySelectorAll(".schedule-heatmap-cell").forEach((cell) => {
        const metric = cell.dataset.metric;
        if (!metric) return;
        heatmapCellEls.set(`${day}:${hour}:${metric}`, cell);
      });
    });
  });
}

function heatmapOpacity(value, max) {
  if (!Number.isFinite(value) || value <= 0 || !Number.isFinite(max) || max <= 0) return 0;
  return Math.min(1, value / max);
}

function renderHeatmap(state) {
  if (!state?.cells || !state?.max) return;
  lastHeatmapState = state;

  for (const metric of HEATMAP_METRICS) {
    const max = state.max[metric.key] ?? 0;
    const rgb = metric.rgb;

    document.querySelectorAll(".schedule-day-column").forEach((col) => {
      const day = col.dataset.day;
      if (!day) return;
      for (let hour = 0; hour < 24; hour++) {
        const cell = heatmapCellEls.get(`${day}:${hour}:${metric.key}`);
        if (!cell) continue;
        const bucket = state.cells[`${day}:${hour}`];
        const hasData = Boolean(bucket);
        const value = bucket?.[metric.key] ?? 0;
        const alpha = hasData ? heatmapOpacity(value, max) : 0;
        cell.style.backgroundColor = alpha > 0 ? `rgba(${rgb}, ${alpha})` : "transparent";
        const valueEl = cell.querySelector(".schedule-heatmap-value");
        if (valueEl) {
          valueEl.textContent = formatHeatmapValue(value, hasData);
          valueEl.classList.toggle("is-empty", !hasData);
        }
      }
    });
  }
}

async function loadHeatmap() {
  try {
    const res = await fetch("/api/heatmap");
    if (!res.ok) return;
    const state = await res.json();
    renderHeatmap(state);
    window.SchedulePlacements?.onHeatmapUpdated?.(state);
  } catch {
    // ignore
  }
}

function initHeatmapLegend() {
  const panel = $("schedule-heatmap-panel");
  if (!panel) return;
  panel.replaceChildren();

  const legend = document.createElement("div");
  legend.className = "heatmap-legend";
  legend.setAttribute("aria-label", "Heatmap color index");

  for (const metric of HEATMAP_METRICS) {
    const item = document.createElement("div");
    item.className = "heatmap-legend-item";

    const head = document.createElement("div");
    head.className = "heatmap-legend-head";

    const swatch = document.createElement("span");
    swatch.className = "heatmap-legend-swatch";
    swatch.style.backgroundColor = `rgba(${metric.rgb}, 0.85)`;
    swatch.setAttribute("aria-hidden", "true");

    const label = document.createElement("span");
    label.className = "heatmap-legend-label";
    label.textContent = metric.label;

    const desc = document.createElement("p");
    desc.className = "heatmap-legend-desc";
    desc.textContent = metric.tip;

    head.append(swatch, label);
    item.append(head, desc);
    legend.appendChild(item);
  }

  panel.appendChild(legend);
}

function bindScheduleViewToggle() {
  const list = $("schedule-setups-list");
  const heatmapPanel = $("schedule-heatmap-panel");
  const buttons = document.querySelectorAll(".schedule-view-toggle-btn");
  if (!list || !heatmapPanel || !buttons.length) return;

  const showView = (view) => {
    const isSchedule = view === "schedule";
    const page = $("page-schedule-heatmap");
    page?.classList.toggle("is-heatmap-view", !isSchedule);
    list.hidden = !isSchedule;
    heatmapPanel.hidden = isSchedule;
    for (const btn of buttons) {
      btn.classList.toggle("is-active", btn.dataset.scheduleView === view);
    }
    // Keep both UIs mounted. Only load heatmap the first time if not yet available.
    if (!isSchedule && !lastHeatmapState) {
      void loadHeatmap();
    }
    if (window.SchedulePlacements) window.SchedulePlacements.onViewChange();
  };

  for (const btn of buttons) {
    btn.addEventListener("click", () => {
      const view = btn.dataset.scheduleView;
      if (!view || btn.classList.contains("is-active")) return;
      showView(view);
    });
  }
}

function syncWalletControls(config) {
  const autoTradeOn = Boolean(config?.autoTrade);
  const sharesField = $("wallet-shares-field");
  const useScheduleField = $("wallet-use-schedule-field");
  const startTradingField = $("wallet-start-trading-field");
  const sharesInput = $("manual-shares");
  const unitSelect = $("manual-order-unit");

  if (sharesField) sharesField.hidden = autoTradeOn;
  if (useScheduleField) useScheduleField.hidden = !autoTradeOn;
  if (startTradingField) startTradingField.hidden = !autoTradeOn;
  if (unitSelect) {
    unitSelect.value = config?.manualOrderUnit === "usdc" ? "usdc" : "shares";
    syncManualAmountInputAttrs(unitSelect.value);
  }
  if (sharesInput && Number.isFinite(config?.manualShares)) {
    sharesInput.value = String(config.manualShares);
  }
}

function syncManualAmountInputAttrs(unit) {
  const sharesInput = $("manual-shares");
  if (!sharesInput) return;
  if (unit === "usdc") {
    sharesInput.min = "0.01";
    sharesInput.step = "0.01";
  } else {
    sharesInput.min = "1";
    sharesInput.step = "1";
  }
}

function normalizeManualAmount(value, unit) {
  const n = Number(value);
  if (unit === "usdc") {
    return Math.max(0.01, Math.min(100000, Math.round((Number.isFinite(n) ? n : 10) * 100) / 100));
  }
  return Math.max(1, Math.min(100000, Math.floor(Number.isFinite(n) ? n : 10) || 10));
}

const TRADING_CONFIG_STORAGE_KEY = "poly-trading-config";

function readLocalTradingConfig() {
  try {
    const raw = localStorage.getItem(TRADING_CONFIG_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return null;
    const autoTrade = Boolean(parsed.autoTrade);
    const manualOrderUnit = parsed.manualOrderUnit === "usdc" ? "usdc" : "shares";
    return {
      autoTrade,
      useSchedule: autoTrade && Boolean(parsed.useSchedule),
      startTrading: autoTrade && Boolean(parsed.startTrading),
      manualOrderUnit,
      manualShares: normalizeManualAmount(parsed.manualShares, manualOrderUnit),
    };
  } catch {
    return null;
  }
}

function writeLocalTradingConfig(config) {
  if (!config) return;
  try {
    const manualOrderUnit = config.manualOrderUnit === "usdc" ? "usdc" : "shares";
    localStorage.setItem(
      TRADING_CONFIG_STORAGE_KEY,
      JSON.stringify({
        autoTrade: Boolean(config.autoTrade),
        useSchedule: Boolean(config.useSchedule),
        startTrading: Boolean(config.startTrading),
        manualOrderUnit,
        manualShares: normalizeManualAmount(config.manualShares, manualOrderUnit),
      }),
    );
  } catch {
    // ignore quota / private mode
  }
}

async function pushTradingConfig(patch) {
  try {
    const res = await fetch("/api/trading/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    });
    if (!res.ok) return null;
    const config = await res.json();
    writeLocalTradingConfig(config);
    return config;
  } catch {
    return null;
  }
}

async function loadTradingConfig() {
  try {
    const res = await fetch("/api/trading/config");
    if (!res.ok) return null;
    const config = await res.json();
    writeLocalTradingConfig(config);
    return config;
  } catch {
    return null;
  }
}

function buildTradingConfigPatch(overrides = {}) {
  const autoTradeInput = $("auto-trade");
  const useScheduleInput = $("use-schedule");
  const startTradingInput = $("start-trading");
  const sharesInput = $("manual-shares");
  const unitSelect = $("manual-order-unit");
  const manualOrderUnit = unitSelect?.value === "usdc" ? "usdc" : "shares";
  return {
    autoTrade: Boolean(autoTradeInput?.checked),
    useSchedule: Boolean(useScheduleInput?.checked),
    startTrading: Boolean(startTradingInput?.checked),
    manualOrderUnit,
    manualShares: normalizeManualAmount(sharesInput?.value, manualOrderUnit),
    ...overrides,
  };
}

function bindTradeToggles() {
  const autoTradeInput = $("auto-trade");
  const useScheduleInput = $("use-schedule");
  const startTradingInput = $("start-trading");
  const sharesInput = $("manual-shares");
  const unitSelect = $("manual-order-unit");
  if (!autoTradeInput || !useScheduleInput || !startTradingInput) return;

  const applyConfig = (config) => {
    if (!config) return;
    autoTradeInput.checked = Boolean(config.autoTrade);
    useScheduleInput.checked = Boolean(config.useSchedule);
    startTradingInput.checked = Boolean(config.startTrading);
    syncWalletControls(config);
  };

  // Restore immediately from localStorage, then sync from server
  applyConfig(readLocalTradingConfig());
  void loadTradingConfig().then((config) => {
    applyConfig(config);
    syncGraphSaveBtn(windowState);
    if (windowState) drawPriceChart(windowState);
  });

  autoTradeInput.addEventListener("change", async () => {
    if (!autoTradeInput.checked) {
      useScheduleInput.checked = false;
      startTradingInput.checked = false;
    }
    writeLocalTradingConfig(buildTradingConfigPatch());
    const config = await pushTradingConfig(buildTradingConfigPatch());
    applyConfig(config ?? buildTradingConfigPatch());
    syncGraphSaveBtn(windowState);
    if (windowState) drawPriceChart(windowState);
    appendLogEntry({
      level: "info",
      source: "client",
      message: autoTradeInput.checked ? "Auto Trade enabled" : "Auto Trade disabled",
    });
  });

  useScheduleInput.addEventListener("change", async () => {
    writeLocalTradingConfig(buildTradingConfigPatch());
    const config = await pushTradingConfig(buildTradingConfigPatch());
    applyConfig(config ?? buildTradingConfigPatch());
    syncGraphSaveBtn(windowState);
    if (windowState) drawPriceChart(windowState);
    appendLogEntry({
      level: "info",
      source: "client",
      message: useScheduleInput.checked ? "Use Schedule enabled" : "Use Schedule disabled",
    });
  });

  startTradingInput.addEventListener("change", async () => {
    writeLocalTradingConfig(buildTradingConfigPatch());
    const config = await pushTradingConfig(buildTradingConfigPatch());
    applyConfig(config ?? buildTradingConfigPatch());
    if (windowState) drawPriceChart(windowState);
    appendLogEntry({
      level: "info",
      source: "client",
      message: startTradingInput.checked ? "Allow trade enabled" : "Allow trade disabled (preview mode)",
    });
  });

  unitSelect?.addEventListener("change", async () => {
    if (autoTradeInput.checked) return;
    const manualOrderUnit = unitSelect.value === "usdc" ? "usdc" : "shares";
    syncManualAmountInputAttrs(manualOrderUnit);
    const manualShares = normalizeManualAmount(sharesInput?.value, manualOrderUnit);
    if (sharesInput) sharesInput.value = String(manualShares);
    writeLocalTradingConfig(buildTradingConfigPatch({ manualOrderUnit, manualShares }));
    await pushTradingConfig(buildTradingConfigPatch({ manualOrderUnit, manualShares }));
  });

  sharesInput?.addEventListener("change", async () => {
    if (autoTradeInput.checked) return;
    const manualOrderUnit = unitSelect?.value === "usdc" ? "usdc" : "shares";
    const manualShares = normalizeManualAmount(sharesInput.value, manualOrderUnit);
    sharesInput.value = String(manualShares);
    writeLocalTradingConfig(buildTradingConfigPatch({ manualShares, manualOrderUnit }));
    await pushTradingConfig(buildTradingConfigPatch({ manualShares, manualOrderUnit }));
  });
}

window.getAutoTrade = () => Boolean($("auto-trade")?.checked);
window.getStartTrading = () => {
  if (!window.getAutoTrade()) return false;
  return Boolean($("start-trading")?.checked);
};
window.getUseSchedule = () => {
  if (!window.getAutoTrade()) return false;
  return Boolean($("use-schedule")?.checked);
};
window.getTradingUiState = () => windowState?.trading ?? null;

function bindPageToggle() {
  const simulatorPage = $("page-simulator");
  const schedulePage = $("page-schedule-heatmap");
  const buttons = document.querySelectorAll(".page-toggle-btn");
  if (!simulatorPage || !schedulePage || !buttons.length) return;

  const showPage = (page) => {
    const isSimulator = page === "simulator";
    simulatorPage.hidden = !isSimulator;
    schedulePage.hidden = isSimulator;
    for (const btn of buttons) {
      btn.classList.toggle("is-active", btn.dataset.page === page);
    }
    if (isSimulator && windowState) {
      resizeChartCanvas();
      drawPriceChart(windowState);
    } else if (!isSimulator) {
      void loadScheduleSetups();
      if (lastHeatmapState) renderHeatmap(lastHeatmapState);
      else void loadHeatmap();
      // Ensure cards are present after the page becomes visible (boot may have
      // loaded placements while this page was still hidden).
      if (window.SchedulePlacements) {
        void window.SchedulePlacements.loadPlacements({ reloadStats: false });
      }
    }
    if (window.SchedulePlacements) window.SchedulePlacements.onViewChange();
  };

  for (const btn of buttons) {
    btn.addEventListener("click", () => {
      const page = btn.dataset.page;
      if (!page || btn.classList.contains("is-active")) return;
      showPage(page);
    });
  }
}

async function init() {
  initSimulatorBoxScrollbars();
  initChart();
  initColumnSplitter();
  initLeftRowSplitter();
  void loadWalletAccount();
  bindWalletBalanceRefresh();
  initScheduleDaySlots();
  initScheduleUtcColumn();
  initHeatmapLegend();
  if (window.SchedulePlacements) window.SchedulePlacements.init();
  if (window.SetupEditor) window.SetupEditor.init();
  bindPageToggle();
  bindTradeToggles();
  bindQuoteBoxes();
  bindScheduleViewToggle();
  bindSetupSaveModal();
  bindSetupListMenus();
  void loadHeatmap();
  await loadScheduleSetups();
  if (window.SchedulePlacements) void window.SchedulePlacements.loadPlacements();
  await loadMarkets();
  const res = await fetch(`/api/window?series=${encodeURIComponent(selectedSeries)}`);
  if (res.ok) updateWindowUI(await res.json());
  connectSSE();

  countdownTimer = setInterval(() => {
    if (windowState) {
      updateCountdown(windowState);
      drawPriceChart(windowState);
    }
  }, 1000);
}

init();
