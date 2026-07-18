const $ = (id) => document.getElementById(id);

let markets = [];
let selectedSeries = "btc-5m";
let windowState = null;
let countdownTimer = null;
let chartCanvas = null;
let chartCtx = null;
let chartWindowStart = null;
let chainlinkChartFrame = null;
let pendingChainlinkTicks = [];

const MAX_LOG_LINES = 500;

function shortAddress(addr) {
  if (!addr || addr.length < 10) return addr || "—";
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

function formatUsdcBalance(raw) {
  const value = Number(raw);
  if (!Number.isFinite(value)) return "—";
  return `$${(value / 1_000_000).toFixed(2)}`;
}

function setSettingsWalletError(message) {
  const el = $("settings-wallet-error");
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = message;
}

function setSettingsUserStatus(message, isError = false) {
  const el = $("settings-user-status");
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = "";
    el.classList.remove("settings-inline-status--error");
    return;
  }
  el.hidden = false;
  el.textContent = message;
  el.classList.toggle("settings-inline-status--error", Boolean(isError));
}

function setSettingsSessionStatus(message, isError = false) {
  const el = $("settings-session-status");
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = "";
    el.classList.remove("settings-inline-status--error");
    return;
  }
  el.hidden = false;
  el.textContent = message;
  el.classList.toggle("settings-inline-status--error", Boolean(isError));
}

function setAuthError(message) {
  const el = $("auth-error");
  if (!el) return;
  if (!message) {
    el.hidden = true;
    el.textContent = "";
    return;
  }
  el.hidden = false;
  el.textContent = message;
}

function showAuthScreen() {
  const auth = $("auth-screen");
  const app = $("app-shell");
  if (auth) auth.hidden = false;
  if (app) app.hidden = true;
  document.body.style.overflow = "hidden";
}

function showAppShell() {
  const auth = $("auth-screen");
  const app = $("app-shell");
  if (auth) auth.hidden = true;
  if (app) app.hidden = false;
  document.body.style.overflow = "";
}

async function fetchAuthMe() {
  const res = await fetch("/api/auth/me", { credentials: "same-origin" });
  if (!res.ok) return null;
  const payload = await res.json().catch(() => ({}));
  return payload?.user ?? null;
}

async function loginWithCredentials(email, password) {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
  return payload.user;
}

async function logoutSession() {
  const res = await fetch("/api/auth/logout", {
    method: "POST",
    credentials: "same-origin",
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
}

async function deleteAccount() {
  const res = await fetch("/api/auth/account", {
    method: "DELETE",
    credentials: "same-origin",
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
}

function bindAuthForm(onLoggedIn) {
  const form = $("auth-login-form");
  if (!form || form.dataset.bound === "1") return;
  form.dataset.bound = "1";
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    setAuthError("");
    const email = $("auth-email")?.value?.trim() ?? "";
    const password = $("auth-password")?.value ?? "";
    const btn = $("auth-login-btn");
    if (btn) btn.disabled = true;
    try {
      const user = await loginWithCredentials(email, password);
      if ($("auth-password")) $("auth-password").value = "";
      await onLoggedIn(user);
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : String(err));
    } finally {
      if (btn) btn.disabled = false;
    }
  });
}

function renderWalletAccount(data) {
  const statusEl = $("wallet-status");
  const balanceEl = $("wallet-balance");
  if (!statusEl || !balanceEl) return;

  if (!data?.connected) {
    statusEl.textContent = "No Connection";
    statusEl.className = "wallet-header-status wallet-header-status--error";
    statusEl.title = data?.error || "No Connection";
    balanceEl.textContent = "—";
  } else {
    statusEl.textContent = "Connected";
    statusEl.className = "wallet-header-status wallet-header-status--ok";
    statusEl.title = "";
    balanceEl.textContent = formatUsdcBalance(data.collateralBalance);
  }

  renderSettingsWalletAccount(data);
}

function renderSettingsWalletAccount(data) {
  const funderInput = $("settings-funder-input");
  const signerEl = $("settings-signer");
  const statusEl = $("settings-wallet-status");

  if (funderInput && document.activeElement !== funderInput) {
    funderInput.value = data?.funderAddress || "";
    // Avoid leaking the address via hover tooltip while masked.
    funderInput.title = funderInput.type === "text" ? data?.funderAddress || "" : "";
  }

  if (signerEl) {
    signerEl.textContent = data?.signerAddress ? shortAddress(data.signerAddress) : "—";
    signerEl.title = data?.signerAddress || "";
    signerEl.className = "settings-label-signer settings-field-mono";
  }

  if (statusEl) {
    if (!data?.connected) {
      statusEl.textContent = "Not connected";
      statusEl.className = "settings-label-status settings-conn--error";
      statusEl.title = data?.error || "Not connected";
    } else {
      statusEl.textContent = "Connected";
      statusEl.className = "settings-label-status settings-conn--ok";
      statusEl.title = "";
    }
  }
}

function userNameInitial(name) {
  const trimmed = String(name || "").trim();
  if (!trimmed) return "?";
  const letter = trimmed[0];
  return letter.toLocaleUpperCase();
}

function renderHeaderUserInitial(name) {
  const el = $("settings-page-initial");
  const btn = $("settings-page-btn");
  const initial = userNameInitial(name);
  if (el) el.textContent = initial;
  if (btn) {
    const label = String(name || "").trim() || "Settings";
    btn.title = label;
    btn.setAttribute("aria-label", `Settings — ${label}`);
  }
}

function renderSettingsUser(user) {
  const nameEl = $("settings-user-name");
  const emailEl = $("settings-user-email");
  if (nameEl && document.activeElement !== nameEl) nameEl.value = user?.name || "";
  if (emailEl && document.activeElement !== emailEl) emailEl.value = user?.email || "";
  renderHeaderUserInitial(user?.name);
}

async function loadWalletAccount() {
  try {
    const res = await fetch("/api/account", { credentials: "same-origin" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    renderWalletAccount(data);
    applyWalletGate(isWalletReadyFromAccount(data));
  } catch {
    renderWalletAccount({ connected: false, error: "Failed to load" });
  }
}

async function loadSettingsUser() {
  try {
    const res = await fetch("/api/user", { credentials: "same-origin" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const user = await res.json();
    renderSettingsUser(user);
    applyWalletGate(isWalletReadyFromUser(user));
  } catch (err) {
    setSettingsUserStatus(err instanceof Error ? err.message : String(err), true);
  }
}

async function saveWalletField(body) {
  setSettingsWalletError("");
  const res = await fetch("/api/account/wallet", {
    method: "PATCH",
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const payload = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (payload?.account) renderWalletAccount(payload.account);
    throw new Error(payload?.error || `HTTP ${res.status}`);
  }
  if (payload?.account) {
    renderWalletAccount(payload.account);
    applyWalletGate(isWalletReadyFromAccount(payload.account));
  } else {
    await loadWalletAccount();
  }
  if (payload?.user) {
    renderSettingsUser(payload.user);
    applyWalletGate(isWalletReadyFromUser(payload.user));
  } else {
    void loadSettingsUser();
  }
  return payload;
}

let walletReady = false;
let showAppPage = null;

function isWalletReadyFromUser(user) {
  if (!user) return false;
  if (typeof user.walletReady === "boolean") return user.walletReady;
  return Boolean(user.wallet?.hasPrivateKey && user.wallet?.funderAddress);
}

function isWalletReadyFromAccount(account) {
  if (!account) return false;
  return Boolean(account.hasPrivateKey && account.funderAddress);
}

function applyWalletGate(ready) {
  walletReady = Boolean(ready);
  const buttons = document.querySelectorAll(".page-toggle-btn");
  for (const btn of buttons) {
    const page = btn.dataset.page;
    const locked = !walletReady && (page === "simulator" || page === "schedule");
    btn.disabled = locked;
    btn.classList.toggle("is-wallet-locked", locked);
    btn.title = locked
      ? "Add funder address and private key in Settings first"
      : "";
  }
  if (!walletReady && typeof showAppPage === "function") {
    showAppPage("settings", { persist: false });
  }
}

function setSettingsInfoPanelOpen(panel, open) {
  if (!panel) return;
  panel.classList.toggle("is-open", open);
  panel.setAttribute("aria-hidden", open ? "false" : "true");
}

function closeSettingsInfoPanels(exceptKey = null) {
  document.querySelectorAll(".settings-info-panel").forEach((panel) => {
    const key = panel.getAttribute("data-settings-info-panel");
    if (exceptKey != null && key === exceptKey) return;
    setSettingsInfoPanelOpen(panel, false);
  });
  document.querySelectorAll(".settings-info-toggle").forEach((btn) => {
    const key = btn.getAttribute("data-settings-info");
    if (exceptKey != null && key === exceptKey) return;
    btn.setAttribute("aria-expanded", "false");
  });
}

function bindSettingsInfoTips() {
  const page = $("page-settings");
  if (!page || page.dataset.infoBound === "1") return;
  page.dataset.infoBound = "1";

  page.addEventListener("click", (event) => {
    const btn = event.target.closest?.(".settings-info-toggle");
    if (btn && page.contains(btn)) {
      event.preventDefault();
      event.stopPropagation();
      const key = btn.getAttribute("data-settings-info");
      const panel = page.querySelector(`[data-settings-info-panel="${key}"]`);
      if (!panel) return;
      const willOpen = !panel.classList.contains("is-open");
      closeSettingsInfoPanels(willOpen ? key : null);
      setSettingsInfoPanelOpen(panel, willOpen);
      btn.setAttribute("aria-expanded", willOpen ? "true" : "false");
      return;
    }

    if (!event.target.closest?.(".settings-info-panel")) {
      closeSettingsInfoPanels();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeSettingsInfoPanels();
  });
}

function bindSettingsFunderReveal() {
  const funderInput = $("settings-funder-input");
  const toggle = $("settings-funder-toggle");
  if (!funderInput || !toggle || toggle.dataset.bound === "1") return;
  toggle.dataset.bound = "1";
  toggle.addEventListener("click", () => {
    const showing = funderInput.type === "text";
    funderInput.type = showing ? "password" : "text";
    toggle.textContent = showing ? "Show" : "Hide";
    toggle.setAttribute("aria-pressed", showing ? "false" : "true");
    funderInput.title = funderInput.type === "text" ? funderInput.value : "";
  });
}

function bindSettingsEditors() {
  bindSettingsInfoTips();
  bindSettingsFunderReveal();

  const userSave = $("settings-user-save");
  const funderInput = $("settings-funder-input");
  const funderSave = $("settings-funder-save");
  const keyInput = $("settings-key-input");
  const keySave = $("settings-key-save");

  if (userSave && userSave.dataset.bound !== "1") {
    userSave.dataset.bound = "1";
    userSave.addEventListener("click", async () => {
      setSettingsUserStatus("");
      userSave.disabled = true;
      try {
        const res = await fetch("/api/user", {
          method: "PATCH",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: $("settings-user-name")?.value ?? "",
            email: $("settings-user-email")?.value ?? "",
          }),
        });
        const payload = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(payload?.error || `HTTP ${res.status}`);
        renderSettingsUser(payload);
        setSettingsUserStatus("Saved");
      } catch (err) {
        setSettingsUserStatus(err instanceof Error ? err.message : String(err), true);
      } finally {
        userSave.disabled = false;
      }
    });
  }

  const logoutBtn = $("settings-logout-btn");
  if (logoutBtn && logoutBtn.dataset.bound !== "1") {
    logoutBtn.dataset.bound = "1";
    logoutBtn.addEventListener("click", async () => {
      setSettingsSessionStatus("");
      logoutBtn.disabled = true;
      try {
        await logoutSession();
        // Live trading keeps running server-side; only the UI session ends.
        window.location.reload();
      } catch (err) {
        setSettingsSessionStatus(err instanceof Error ? err.message : String(err), true);
        logoutBtn.disabled = false;
      }
    });
  }

  const deleteBtn = $("settings-delete-account-btn");
  if (deleteBtn && deleteBtn.dataset.bound !== "1") {
    deleteBtn.dataset.bound = "1";
    deleteBtn.addEventListener("click", async () => {
      const ok = window.confirm(
        "Delete this account permanently? This cannot be undone.",
      );
      if (!ok) return;
      setSettingsSessionStatus("");
      deleteBtn.disabled = true;
      try {
        await deleteAccount();
        window.location.reload();
      } catch (err) {
        setSettingsSessionStatus(err instanceof Error ? err.message : String(err), true);
        deleteBtn.disabled = false;
      }
    });
  }

  if (funderSave && funderInput && funderSave.dataset.bound !== "1") {
    funderSave.dataset.bound = "1";
    funderSave.addEventListener("click", async () => {
      const funderAddress = funderInput.value.trim();
      if (!funderAddress) {
        setSettingsWalletError("Enter a funder address");
        return;
      }
      funderSave.disabled = true;
      try {
        await saveWalletField({ funderAddress });
      } catch (err) {
        setSettingsWalletError(err instanceof Error ? err.message : String(err));
      } finally {
        funderSave.disabled = false;
      }
    });
  }

  if (keySave && keyInput && keySave.dataset.bound !== "1") {
    keySave.dataset.bound = "1";
    keySave.addEventListener("click", async () => {
      const privateKey = keyInput.value.trim();
      if (!privateKey) {
        setSettingsWalletError("Paste a private key to save");
        return;
      }
      keySave.disabled = true;
      try {
        await saveWalletField({ privateKey });
        keyInput.value = "";
      } catch (err) {
        setSettingsWalletError(err instanceof Error ? err.message : String(err));
      } finally {
        keySave.disabled = false;
      }
    });
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

const MIN_COLUMN_PCT = 0;
const MAX_COLUMN_PCT = 100;
const LEFT_COVERED_PCT = 0.5;
const RIGHT_COVERED_PCT = 99.5;

/** Row-split helpers filled by initLeftRowSplitter. */
let leftColumnLayout = null;

function setColumnSplit(pct) {
  const page = $("page-simulator");
  const splitter = $("column-splitter");
  if (!page) return;
  const clamped = Math.max(MIN_COLUMN_PCT, Math.min(MAX_COLUMN_PCT, pct));
  page.style.setProperty("--split-left-pct", String(clamped));
  if (splitter) splitter.setAttribute("aria-valuenow", String(Math.round(clamped)));
  syncLeftColumnRail();
  syncMarketColumnRail();
}

function parseSplitPct(raw) {
  const text = String(raw ?? "").trim();
  // Number("") === 0 — treat blank as missing, not 0% covered.
  if (!text) return null;
  const pct = Number(text);
  return Number.isFinite(pct) ? pct : null;
}

function getColumnSplitPct() {
  const page = $("page-simulator");
  if (!page) return 50;
  const inline = parseSplitPct(page.style.getPropertyValue("--split-left-pct"));
  if (inline != null) return inline;
  const fromCss = parseSplitPct(getComputedStyle(page).getPropertyValue("--split-left-pct"));
  return fromCss != null ? fromCss : 50;
}

function syncLeftColumnRail() {
  const page = $("page-simulator");
  const rail = $("left-column-rail");
  if (!page || !rail) return;
  // Use split % only — measuring width during first paint can be ~0 and falsely show the rail.
  const covered = getColumnSplitPct() <= LEFT_COVERED_PCT;
  rail.hidden = !covered;
  rail.classList.toggle("is-visible", covered);
  page.classList.toggle("is-left-covered", covered);
  if (covered) clampLeftColumnRailTop();
}

function syncMarketColumnRail() {
  const page = $("page-simulator");
  const rail = $("market-column-rail");
  if (!page || !rail) return;
  const covered = getColumnSplitPct() >= RIGHT_COVERED_PCT;
  rail.hidden = !covered;
  rail.classList.toggle("is-visible", covered);
  page.classList.toggle("is-market-covered", covered);
  syncMarketRailLivePulse();
  if (covered) clampMarketColumnRailTop();
}

function syncMarketRailLivePulse() {
  const rail = $("market-column-rail");
  if (!rail) return;
  const live = Boolean($("start-trading")?.checked);
  rail.classList.toggle("is-live-trading", live);
}

const LEFT_RAIL_TOP_KEY = "poly-real:left-rail-top";

function loadLeftColumnRailTop() {
  try {
    const raw = localStorage.getItem(LEFT_RAIL_TOP_KEY);
    const n = raw != null ? Number(raw) : Number.NaN;
    return Number.isFinite(n) ? n : 72;
  } catch {
    return 72;
  }
}

function saveLeftColumnRailTop(top) {
  try {
    localStorage.setItem(LEFT_RAIL_TOP_KEY, String(Math.round(top)));
  } catch {
    // ignore
  }
}

function clampLeftColumnRailTop(preferredTop) {
  const page = $("page-simulator");
  const rail = $("left-column-rail");
  if (!page || !rail || rail.hidden) return;
  const pageRect = page.getBoundingClientRect();
  const railH = rail.offsetHeight || 0;
  const pad = 8;
  const maxTop = Math.max(pad, pageRect.height - railH - pad);
  const base =
    preferredTop != null && Number.isFinite(preferredTop)
      ? preferredTop
      : rail.offsetTop || loadLeftColumnRailTop();
  const next = Math.max(pad, Math.min(maxTop, base));
  page.style.setProperty("--left-rail-top", `${Math.round(next)}px`);
  rail.style.top = `${Math.round(next)}px`;
  return next;
}

function openLeftSection(section) {
  setColumnSplit(50);
  // Two frames so --split-left-pct layout is settled before measuring.
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      leftColumnLayout?.maximizeSection?.(section);
      syncLeftColumnRail();
    });
  });
}

function bindLeftColumnRail() {
  const rail = $("left-column-rail");
  const page = $("page-simulator");
  if (!rail || !page || rail.dataset.bound === "1") return;
  rail.dataset.bound = "1";

  clampLeftColumnRailTop(loadLeftColumnRailTop());

  rail.querySelectorAll("[data-left-section]").forEach((btn) => {
    btn.addEventListener("click", () => {
      openLeftSection(btn.dataset.leftSection);
    });
  });

  let dragging = false;
  let startY = 0;
  let startTop = 0;
  const handle = rail.querySelector(".left-column-rail-handle");

  const onPointerMove = (e) => {
    if (!dragging) return;
    clampLeftColumnRailTop(startTop + (e.clientY - startY));
  };

  const onPointerUp = (e) => {
    if (!dragging) return;
    dragging = false;
    rail.classList.remove("is-dragging");
    try {
      (handle || rail).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    const top = clampLeftColumnRailTop(rail.offsetTop);
    if (top != null) saveLeftColumnRailTop(top);
  };

  const onHandleDown = (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startY = e.clientY;
    startTop = rail.offsetTop;
    rail.classList.add("is-dragging");
    try {
      (handle || rail).setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    e.preventDefault();
  };

  if (handle) handle.addEventListener("pointerdown", onHandleDown);

  window.addEventListener("resize", () => {
    clampLeftColumnRailTop();
  });
}

const MARKET_RAIL_TOP_KEY = "poly-real:market-rail-top";

function loadMarketColumnRailTop() {
  try {
    const raw = localStorage.getItem(MARKET_RAIL_TOP_KEY);
    const n = raw != null ? Number(raw) : Number.NaN;
    return Number.isFinite(n) ? n : 72;
  } catch {
    return 72;
  }
}

function saveMarketColumnRailTop(top) {
  try {
    localStorage.setItem(MARKET_RAIL_TOP_KEY, String(Math.round(top)));
  } catch {
    // ignore
  }
}

function clampMarketColumnRailTop(preferredTop) {
  const page = $("page-simulator");
  const rail = $("market-column-rail");
  if (!page || !rail || rail.hidden) return;
  const pageRect = page.getBoundingClientRect();
  const railH = rail.offsetHeight || 0;
  const pad = 8;
  const maxTop = Math.max(pad, pageRect.height - railH - pad);
  const base =
    preferredTop != null && Number.isFinite(preferredTop)
      ? preferredTop
      : rail.offsetTop || loadMarketColumnRailTop();
  const next = Math.max(pad, Math.min(maxTop, base));
  page.style.setProperty("--market-rail-top", `${Math.round(next)}px`);
  rail.style.top = `${Math.round(next)}px`;
  return next;
}

function openMarketColumn() {
  setColumnSplit(50);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      syncMarketColumnRail();
      syncLeftColumnRail();
    });
  });
}

function bindMarketColumnRail() {
  const rail = $("market-column-rail");
  const page = $("page-simulator");
  if (!rail || !page || rail.dataset.bound === "1") return;
  rail.dataset.bound = "1";

  clampMarketColumnRailTop(loadMarketColumnRailTop());

  const openBtn = $("market-rail-open");
  if (openBtn) {
    openBtn.addEventListener("click", () => {
      openMarketColumn();
    });
  }

  let dragging = false;
  let startY = 0;
  let startTop = 0;
  const handle = rail.querySelector(".left-column-rail-handle");

  const onPointerMove = (e) => {
    if (!dragging) return;
    clampMarketColumnRailTop(startTop + (e.clientY - startY));
  };

  const onPointerUp = (e) => {
    if (!dragging) return;
    dragging = false;
    rail.classList.remove("is-dragging");
    try {
      (handle || rail).releasePointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    window.removeEventListener("pointercancel", onPointerUp);
    const top = clampMarketColumnRailTop(rail.offsetTop);
    if (top != null) saveMarketColumnRailTop(top);
  };

  const onHandleDown = (e) => {
    if (e.button !== 0) return;
    dragging = true;
    startY = e.clientY;
    startTop = rail.offsetTop;
    rail.classList.add("is-dragging");
    try {
      (handle || rail).setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    e.preventDefault();
  };

  if (handle) handle.addEventListener("pointerdown", onHandleDown);

  window.addEventListener("resize", () => {
    clampMarketColumnRailTop();
  });
}

function initLeftRowSplitter() {
  const leftColumn = document.querySelector(".left-column");
  const walletHeader = document.querySelector(".wallet-panel-header") || document.querySelector(".settings-panel-header");
  const tradeHeader = document.querySelector(".trade-panel-header");
  const tradeBody = document.querySelector(".trade-panel-body");
  const prevHeader = document.querySelector(".positions-panel-header");
  const logHeader = document.querySelector(".log-panel-header");
  const prevBody = document.querySelector(".positions-body");
  const logBody = document.querySelector(".log-output");
  const prevDragHandle = document.querySelector('[data-drag-edge="prev"]');
  const logDragHandle = document.querySelector('[data-drag-edge="log"]');
  if (
    !leftColumn ||
    !walletHeader ||
    !tradeHeader ||
    !tradeBody ||
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
  let anchorTradeContent = 0;
  let activeHandle = null;

  const parseHeight = (name, fallback) => {
    const raw = getComputedStyle(leftColumn).getPropertyValue(name);
    const value = raw ? parseFloat(raw) : Number.NaN;
    return Number.isFinite(value) ? value : fallback;
  };

  const getMetrics = () => {
    const colRect = leftColumn.getBoundingClientRect();
    const walletHeaderH = walletHeader.offsetHeight;
    const tradeHeaderH = tradeHeader.offsetHeight;
    const prevHeaderH = prevHeader.offsetHeight;
    const logHeaderH = logHeader.offsetHeight;
    const chrome = walletHeaderH + tradeHeaderH + prevHeaderH + logHeaderH;
    const maxContent = Math.max(0, colRect.height - chrome);
    return {
      colRect,
      walletHeaderH,
      tradeHeaderH,
      prevHeaderH,
      logHeaderH,
      chrome,
      maxContent,
    };
  };

  const readHeights = () => ({
    trade: parseHeight("--trade-content-height", 140),
    prev: parseHeight("--prev-content-height", 0),
    log: parseHeight("--log-content-height", 0),
  });

  const applyHeights = (trade, prev, log) => {
    const { colRect, chrome } = getMetrics();
    const t = Math.max(0, trade);
    const p = Math.max(0, prev);
    let l = Math.max(0, log);

    leftColumn.style.setProperty("--trade-content-height", `${t}px`);
    leftColumn.style.setProperty("--prev-content-height", `${p}px`);
    leftColumn.style.setProperty("--log-content-height", `${l}px`);

    const stackHeight = chrome + t + p + l;
    const margin = l <= 0 ? Math.max(0, colRect.height - stackHeight) : 0;
    leftColumn.style.setProperty("--log-margin-top", `${margin}px`);

    tradeBody.classList.toggle("is-collapsed", t <= 0);
    prevBody.classList.toggle("is-collapsed", p <= 0);
    logBody.classList.toggle("is-collapsed", l <= 0);
    const hasPositionCards = Boolean(prevBody.querySelector(".position-card"));
    prevBody.classList.toggle("is-scrollable", p > 0 && hasPositionCards);
    logBody.classList.toggle("is-scrollable", l > 0);
  };

  const maximizeSection = (section) => {
    const { maxContent } = getMetrics();
    if (section === "positions") {
      applyHeights(0, maxContent, 0);
      return;
    }
    if (section === "log") {
      applyHeights(0, 0, maxContent);
      return;
    }
    // trade / wallet / default — expand Trade content
    applyHeights(maxContent, 0, 0);
  };

  leftColumnLayout = { applyHeights, maximizeSection, readHeights, getMetrics };

  const initDefaultHeights = () => {
    const { maxContent } = getMetrics();
    applyHeights(maxContent, 0, 0);
  };

  const clampPrevDrag = (clientY) => {
    const { colRect, walletHeaderH, tradeHeaderH, prevHeaderH } = getMetrics();
    // Positions can cover Trade content, but not Wallet or Trade headers.
    const tradeHeaderBottom = colRect.top + walletHeaderH + tradeHeaderH;
    const logTop = anchorLogHeaderTop;
    const minPrevTop = tradeHeaderBottom;
    const maxPrevTop = logTop - prevHeaderH;
    const prevTop = Math.max(minPrevTop, Math.min(clientY, maxPrevTop));
    const trade = prevTop - tradeHeaderBottom;
    const prev = logTop - prevTop - prevHeaderH;
    applyHeights(trade, prev, anchorLogContent);
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
    applyHeights(anchorTradeContent, prev, log);
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
    try {
      prevDragHandle.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    clampPrevDrag(e.clientY);
    e.preventDefault();
  };

  const startLogDrag = (e) => {
    if (e.button !== 0) return;
    dragging = true;
    dragKind = "log";
    activeHandle = logDragHandle;
    anchorTradeContent = readHeights().trade;
    activeHandle.classList.add("is-dragging");
    document.body.classList.add("is-row-resizing");
    try {
      logDragHandle.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
    clampLogDrag(e.clientY);
    e.preventDefault();
  };

  initDefaultHeights();
  window.addEventListener("resize", () => {
    const heights = readHeights();
    applyHeights(heights.trade, heights.prev, heights.log);
    syncLeftColumnRail();
    syncMarketColumnRail();
  });

  const onPointerMove = (e) => {
    if (!dragging) return;
    if (dragKind === "prev") clampPrevDrag(e.clientY);
    else if (dragKind === "log") clampLogDrag(e.clientY);
  };

  prevDragHandle.addEventListener("pointerdown", startPrevDrag);
  logDragHandle.addEventListener("pointerdown", startLogDrag);
  prevDragHandle.addEventListener("pointermove", onPointerMove);
  logDragHandle.addEventListener("pointermove", onPointerMove);
  prevDragHandle.addEventListener("pointerup", stopDragging);
  logDragHandle.addEventListener("pointerup", stopDragging);
  prevDragHandle.addEventListener("pointercancel", stopDragging);
  logDragHandle.addEventListener("pointercancel", stopDragging);
  prevDragHandle.addEventListener("lostpointercapture", stopDragging);
  logDragHandle.addEventListener("lostpointercapture", stopDragging);
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
  const isDemo = card.demo === true || String(card.id || "").startsWith("demo:");
  const settled = status === "sold" || status === "win" || status === "loss";
  const plPending = settled && !isDemo && card.confirmed !== true;
  // Open and waiting-for-settlement cards render the same skeleton:
  // all labels present, all values empty, so the card height never changes.
  const isLoading = !isDemo && (status === "open" || plPending);

  let detailHtml = `<div class="position-card-row"><span>Buy</span><strong>${isLoading ? "" : `${card.shares} @ ${fmtPriceCents(card.buyPrice)}`}</strong></div>`;

  if (status === "sold") {
    detailHtml += `<div class="position-card-row"><span>Sell</span><strong>${isLoading ? "" : `${card.shares} @ ${fmtPriceCents(card.sellPrice)}`}</strong></div>`;
  } else {
    detailHtml += `<div class="position-card-row"><span>Settlement</span><strong>${isLoading ? "" : (card.outcome || "—").toUpperCase()}</strong></div>`;
  }

  if (isLoading) {
    detailHtml += `<div class="position-card-row"><span>P/L</span><strong class="position-card-pl"></strong></div>`;
  } else {
    const hasPl = card.pl != null && Number.isFinite(card.pl);
    const plClass = hasPl ? (card.pl > 0 ? "is-positive" : card.pl < 0 ? "is-negative" : "") : "";
    detailHtml += `<div class="position-card-row"><span>P/L</span><strong class="position-card-pl ${plClass}">${hasPl ? fmtUsdSigned(card.pl) : ""}</strong></div>`;
  }

  const statusLabel = plPending && (status === "win" || status === "loss")
    ? "Waiting"
    : positionStatusLabel(status);
  const sourceNote = isDemo ? "Demo" : isLoading ? "Pending…" : "Confirmed";
  return `<article class="position-card is-${status}${isDemo ? " is-demo" : ""}${isLoading ? " is-loading" : ""}" data-position-id="${card.id}">
    <div class="position-card-top">
      <span class="position-card-side ${sideClass}">${(card.side || "").toUpperCase()}</span>
      <span class="position-card-status">${statusLabel}</span>
    </div>
    ${detailHtml}
    <div class="position-card-row"><span>Source</span><strong>${sourceNote}</strong></div>
  </article>`;
}

const DEMO_POSITION_CARDS_KEY = "poly-real:demo-position-cards";
const POSITIONS_VIEW_KEY = "poly-real:positions-view";
const APP_PAGE_KEY = "poly-real:app-page";
const SCHEDULE_VIEW_KEY = "poly-real:schedule-view";

let positionsView = "live";
let demoPositionCards = [];
let lastPositionsFingerprint = "";
let lastDemoLastWindowKey = null;

function loadPositionsViewPref() {
  try {
    const saved = localStorage.getItem(POSITIONS_VIEW_KEY);
    if (saved === "live" || saved === "demo") positionsView = saved;
  } catch {
    // ignore
  }
}

function savePositionsViewPref() {
  try {
    localStorage.setItem(POSITIONS_VIEW_KEY, positionsView);
  } catch {
    // ignore
  }
}

function loadAppPagePref() {
  try {
    const saved = localStorage.getItem(APP_PAGE_KEY);
    if (saved === "simulator" || saved === "schedule" || saved === "settings") return saved;
  } catch {
    // ignore
  }
  return "simulator";
}

function saveAppPagePref(page) {
  try {
    if (page === "simulator" || page === "schedule" || page === "settings") {
      localStorage.setItem(APP_PAGE_KEY, page);
    }
  } catch {
    // ignore
  }
}

function loadScheduleViewPref() {
  try {
    const saved = localStorage.getItem(SCHEDULE_VIEW_KEY);
    if (saved === "schedule" || saved === "heatmap") return saved;
  } catch {
    // ignore
  }
  return "schedule";
}

function saveScheduleViewPref(view) {
  try {
    if (view === "schedule" || view === "heatmap") {
      localStorage.setItem(SCHEDULE_VIEW_KEY, view);
    }
  } catch {
    // ignore
  }
}

function loadDemoPositionCards() {
  try {
    const raw = localStorage.getItem(DEMO_POSITION_CARDS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function persistDemoPositionCards() {
  try {
    localStorage.setItem(DEMO_POSITION_CARDS_KEY, JSON.stringify(demoPositionCards.slice(0, 100)));
  } catch {
    // ignore
  }
}

function clearDemoPositionCards() {
  demoPositionCards = [];
  lastDemoLastWindowKey = null;
  try {
    localStorage.removeItem(DEMO_POSITION_CARDS_KEY);
  } catch {
    // ignore
  }
  lastPositionsFingerprint = "";
  if (positionsView === "demo") updatePositionsPanel(windowState);
}

window.clearDemoPositionCards = clearDemoPositionCards;

function demoCardId(windowKey, side) {
  return `demo:${windowKey}:${side}`;
}

function shouldUpdateDemoPositionCards(trading) {
  const cfg = trading?.config;
  return Boolean(cfg?.autoTrade && !cfg.startTrading);
}

function upsertDemoPositionCard(card) {
  if (!card?.id) return;
  const idx = demoPositionCards.findIndex((c) => c.id === card.id);
  if (idx >= 0) {
    demoPositionCards[idx] = { ...demoPositionCards[idx], ...card, demo: true };
  } else {
    demoPositionCards.unshift({ ...card, demo: true });
  }
  if (demoPositionCards.length > 100) demoPositionCards.length = 100;
  persistDemoPositionCards();
}

function syncDemoCardsFromMarkers(trading, state) {
  if (!shouldUpdateDemoPositionCards(trading)) return;
  const markers = Array.isArray(trading?.markers) ? trading.markers : [];
  const buys = markers.filter((m) => m.type === "buy");
  if (buys.length === 0) return;

  for (const buy of buys) {
    const windowKey = buy.windowKey || `${state?.series || ""}:${state?.windowStart || ""}`;
    if (!windowKey || !buy.side) continue;
    const id = demoCardId(windowKey, buy.side);
    const existing = demoPositionCards.find((c) => c.id === id);
    if (existing && existing.status !== "open") continue;

    const sell = markers.find((m) => m.type === "sell" && m.side === buy.side);
    if (sell) {
      upsertDemoPositionCard({
        id,
        windowKey,
        series: state?.series,
        side: buy.side,
        shares: sell.shares ?? buy.shares,
        buyPrice: buy.price,
        buyCost: buy.cost ?? (buy.shares || 0) * (buy.price || 0),
        buyFees: buy.fees ?? 0,
        buyAt: buy.t,
        status: "sold",
        sellPrice: sell.price,
        sellProceeds: sell.proceeds ?? (sell.shares || 0) * (sell.price || 0),
        sellFees: sell.fees ?? 0,
        soldAt: sell.t,
        pl: sell.profit ?? null,
        confirmed: true,
        demo: true,
      });
    } else {
      upsertDemoPositionCard({
        id,
        windowKey,
        series: state?.series,
        side: buy.side,
        shares: buy.shares,
        buyPrice: buy.price,
        buyCost: buy.cost ?? (buy.shares || 0) * (buy.price || 0),
        buyFees: buy.fees ?? 0,
        buyAt: buy.t,
        status: "open",
        confirmed: true,
        demo: true,
      });
    }
  }
}

function syncDemoCardsFromLastWindow(lastWindow) {
  if (!lastWindow?.windowKey || lastWindow.plLabel === "No trade") return;
  if (!lastWindow.side) return;
  if (lastDemoLastWindowKey === lastWindow.windowKey) {
    // Still refresh fields if card exists (P/L corrections)
  }
  lastDemoLastWindowKey = lastWindow.windowKey;

  const id = demoCardId(lastWindow.windowKey, lastWindow.side);
  let status = "sold";
  if (!lastWindow.sold) {
    status = lastWindow.positionWon === true ? "win" : "loss";
  }

  upsertDemoPositionCard({
    id,
    windowKey: lastWindow.windowKey,
    series: String(lastWindow.windowKey).split(":")[0],
    side: lastWindow.side,
    shares: lastWindow.shares,
    buyPrice: lastWindow.buyPrice,
    buyCost: lastWindow.buyCost,
    buyFees: lastWindow.buyFees ?? 0,
    buyAt: lastWindow.windowStart,
    status,
    sellPrice: lastWindow.sellPrice,
    sellProceeds: lastWindow.sellProceeds,
    soldAt: lastWindow.sold ? lastWindow.windowEnd : undefined,
    outcome: lastWindow.outcome,
    pl: lastWindow.pl,
    confirmed: true,
    demo: true,
  });
}

function ingestDemoPositionCards(state) {
  const trading = state?.trading;
  if (!trading) return;
  syncDemoCardsFromMarkers(trading, state);
  if (shouldUpdateDemoPositionCards(trading) && trading.demoLastWindow) {
    syncDemoCardsFromLastWindow(trading.demoLastWindow);
  }
}

function positionsFingerprint(cards) {
  if (!Array.isArray(cards) || cards.length === 0) return `${positionsView}:`;
  return `${positionsView}:` + cards
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

  ingestDemoPositionCards(state);

  const cards =
    positionsView === "demo"
      ? demoPositionCards
      : state?.trading?.positionCards;

  const fingerprint = positionsFingerprint(cards);
  if (fingerprint === lastPositionsFingerprint) return;
  lastPositionsFingerprint = fingerprint;

  if (!Array.isArray(cards) || cards.length === 0) {
    list.innerHTML = "";
    empty.hidden = false;
    empty.textContent = positionsView === "demo" ? "No demo positions yet" : "No positions yet";
    syncPositionsScrollable();
    return;
  }

  empty.hidden = true;
  list.innerHTML = cards.map(renderPositionCard).join("");
  syncPositionsScrollable();
}

function syncPositionsViewControls() {
  document.querySelectorAll(".positions-view-toggle-btn").forEach((btn) => {
    btn.classList.toggle("is-active", btn.dataset.positionsView === positionsView);
  });
}

function bindPositionsViewSelect() {
  const buttons = document.querySelectorAll(".positions-view-toggle-btn");
  if (buttons.length === 0) return;
  if (buttons[0].dataset.bound === "1") return;
  buttons.forEach((btn) => {
    btn.dataset.bound = "1";
    btn.addEventListener("click", () => {
      const next = btn.dataset.positionsView === "demo" ? "demo" : "live";
      if (next === positionsView) return;
      positionsView = next;
      savePositionsViewPref();
      syncPositionsViewControls();
      lastPositionsFingerprint = "";
      updatePositionsPanel(windowState);
    });
  });
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

  if (pendingChainlinkTicks.length > 0) {
    const queued = pendingChainlinkTicks;
    pendingChainlinkTicks = [];
    for (const tick of queued) appendChainlinkTick(tick, false);
  }

  if (window.Simulator) window.Simulator.syncFromState(state);

  syncLatencyDisplay(state);
  syncGraphSaveBtn(state);
  updatePositionsPanel(state);
  updateQuoteBoxes(state);
  updateCountdown(state);
  updateGraphPanel(state);

  if (state?.trading && window.SchedulePlacements?.applyLivePlacementStats) {
    window.SchedulePlacements.applyLivePlacementStats(
      state.trading.placementStats,
      state.trading.sessionTotals,
      state.trading.demoLastWindow,
      state.trading,
    );
  }
}

function selectedAsset() {
  return String(selectedSeries || "").split("-")[0].toLowerCase();
}

function appendChainlinkTick(tick, redraw = true) {
  if (!tick || tick.asset !== selectedAsset()) return;

  const price = Number(tick.price);
  const timestampMs = Number(tick.timestampMs);
  if (!Number.isFinite(price) || !Number.isFinite(timestampMs)) return;

  if (!windowState?.windowStart || !windowState?.windowEnd) {
    pendingChainlinkTicks.push(tick);
    pendingChainlinkTicks = pendingChainlinkTicks.slice(-100);
    return;
  }

  const t = timestampMs / 1000;
  if (t < windowState.windowStart || t >= windowState.windowEnd) {
    // Keep boundary ticks briefly until the next full snapshot switches the UI
    // to the new market window.
    if (t >= windowState.windowEnd) {
      pendingChainlinkTicks.push(tick);
      pendingChainlinkTicks = pendingChainlinkTicks.slice(-100);
    }
    return;
  }

  const history = Array.isArray(windowState.priceHistory)
    ? windowState.priceHistory
    : (windowState.priceHistory = []);
  const last = history[history.length - 1];
  if (!last || last.t !== t || last.price !== price) {
    history.push({ t, price });
    if (history.length > 2000) history.splice(0, history.length - 2000);
  }

  windowState.assetPrice = price;
  windowState.lastTickMs = timestampMs;
  if (Number.isFinite(windowState.prevCloseAsset)) {
    windowState.assetGap = price - windowState.prevCloseAsset;
  }
  window.windowState = windowState;

  if (!redraw || chainlinkChartFrame != null) return;
  chainlinkChartFrame = requestAnimationFrame(() => {
    chainlinkChartFrame = null;
    if (windowState) updateGraphPanel(windowState);
  });
}

/** Tick-live quote fields for clickable up/down buttons — merge without redrawing the full chart. */
function applyQuotesUpdate(quotes) {
  if (!quotes) return;
  if (quotes.series && selectedSeries && quotes.series !== selectedSeries) return;

  if (!windowState) {
    windowState = { priceHistory: [], ...(quotes || {}) };
  } else {
    Object.assign(windowState, quotes);
  }
  window.windowState = windowState;

  updateQuoteBoxes(windowState);
  syncLatencyDisplay(windowState);
  if (quotes.windowEnd != null) updateCountdown(windowState);
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
    } else if (state.trading && window.SchedulePlacements?.applyLivePlacementStats) {
      // Keep header/placement stats current even when viewing another series.
      window.SchedulePlacements.applyLivePlacementStats(
        state.trading.placementStats,
        state.trading.sessionTotals,
        state.trading.demoLastWindow,
        state.trading,
      );
    }
  });

  es.addEventListener("quotes", (e) => {
    applyQuotesUpdate(JSON.parse(e.data));
  });

  es.addEventListener("chainlink-tick", (e) => {
    appendChainlinkTick(JSON.parse(e.data));
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
  const placementCount = getSetupPlacementCounts()[setup?._id] ?? 0;
  const confirmed = window.confirm(
    placementCount > 0
      ? `Delete "${setup.title}"?\n\nIt has ${placementCount} placement${placementCount === 1 ? "" : "s"} on the schedule. Those schedule cards will be removed and this cannot be undone.`
      : `Delete "${setup.title}"? This cannot be undone.`,
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
  if (page === "settings") {
    const settingsBtn = $("settings-page-btn");
    if (settingsBtn && !settingsBtn.classList.contains("is-active")) settingsBtn.click();
    return;
  }
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

      const deleteBtn = document.createElement("button");
      deleteBtn.type = "button";
      deleteBtn.className = "schedule-setup-menu-item schedule-setup-menu-item-danger";
      deleteBtn.setAttribute("role", "menuitem");
      deleteBtn.textContent = "Delete";
      deleteBtn.addEventListener("click", (ev) => {
        ev.stopPropagation();
        void deleteTradingSetup(setup);
      });

      menu.append(editBtn, duplicateBtn, applyBtn, deleteBtn);
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

  const showView = (view, options = {}) => {
    const next = view === "heatmap" ? "heatmap" : "schedule";
    const isSchedule = next === "schedule";
    const page = $("page-schedule-heatmap");
    page?.classList.toggle("is-heatmap-view", !isSchedule);
    list.hidden = !isSchedule;
    heatmapPanel.hidden = isSchedule;
    for (const btn of buttons) {
      btn.classList.toggle("is-active", btn.dataset.scheduleView === next);
    }
    if (options.persist !== false) saveScheduleViewPref(next);
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

  showView(loadScheduleViewPref(), { persist: false });
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
  window.SchedulePlacements?.syncHeaderSummaryControls?.({
    allowTrade: Boolean(config?.startTrading),
  });
  syncMarketRailLivePulse();
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
    const turningOff = !useScheduleInput.checked;
    // Snapshot schedule bars before config flips — otherwise SSE reloads the old sim setup.
    if (turningOff && windowState && window.Simulator?.keepDisplayedSetupAsEditable) {
      window.Simulator.keepDisplayedSetupAsEditable(windowState);
    }
    const config = await pushTradingConfig(buildTradingConfigPatch());
    applyConfig(config ?? buildTradingConfigPatch());
    if (useScheduleInput.checked && windowState && window.Simulator?.forceSyncSetupFromState) {
      window.Simulator.forceSyncSetupFromState(windowState);
    } else if (turningOff && window.Simulator?.pushSetupToServer) {
      await window.Simulator.pushSetupToServer();
    }
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
  const settingsPage = $("page-settings");
  const buttons = document.querySelectorAll(".page-toggle-btn");
  const settingsBtn = $("settings-page-btn");
  if (!simulatorPage || !schedulePage || !settingsPage || !buttons.length) return;

  const showPage = (page, options = {}) => {
    let next = page;
    if (!walletReady && (next === "simulator" || next === "schedule")) {
      next = "settings";
    } else if (options.persist !== false) {
      saveAppPagePref(next);
    }
    const isSimulator = next === "simulator";
    const isSchedule = next === "schedule";
    const isSettings = next === "settings";
    simulatorPage.hidden = !isSimulator;
    schedulePage.hidden = !isSchedule;
    settingsPage.hidden = !isSettings;
    for (const btn of buttons) {
      btn.classList.toggle("is-active", btn.dataset.page === next);
    }
    if (settingsBtn) settingsBtn.classList.toggle("is-active", isSettings);

    if (isSimulator && windowState) {
      resizeChartCanvas();
      drawPriceChart(windowState);
    } else if (isSchedule) {
      void loadScheduleSetups();
      if (lastHeatmapState) renderHeatmap(lastHeatmapState);
      else void loadHeatmap();
      // Ensure cards are present after the page becomes visible (boot may have
      // loaded placements while this page was still hidden).
      if (window.SchedulePlacements) {
        void window.SchedulePlacements.loadPlacements({ reloadStats: false });
      }
    } else if (isSettings) {
      void loadSettingsUser();
      void loadWalletAccount();
    }

    if (window.SchedulePlacements) {
      window.SchedulePlacements.onViewChange();
      if (isSimulator) {
        const allowTrade = Boolean($("start-trading")?.checked);
        window.SchedulePlacements.setHeaderSummaryRange?.(allowTrade ? "live" : "demo");
      } else if (isSchedule) {
        window.SchedulePlacements.setHeaderSummaryRange?.("schedule");
      }
    }
  };
  showAppPage = showPage;

  for (const btn of buttons) {
    btn.addEventListener("click", () => {
      const page = btn.dataset.page;
      if (!page || btn.disabled || btn.classList.contains("is-active")) return;
      showPage(page);
    });
  }

  if (settingsBtn && settingsBtn.dataset.bound !== "1") {
    settingsBtn.dataset.bound = "1";
    settingsBtn.addEventListener("click", () => {
      if (settingsBtn.classList.contains("is-active")) return;
      showPage("settings");
    });
  }

  applyWalletGate(walletReady);
  showPage(loadAppPagePref(), { persist: false });
  delete document.documentElement.dataset.initialPage;
  delete document.documentElement.dataset.initialScheduleView;
}

async function init() {
  loadPositionsViewPref();
  demoPositionCards = loadDemoPositionCards();
  bindPositionsViewSelect();
  syncPositionsViewControls();
  initSimulatorBoxScrollbars();
  initChart();
  initColumnSplitter();
  initLeftRowSplitter();
  bindLeftColumnRail();
  bindMarketColumnRail();
  // Keep collapsed rails hidden until layout + split % are known (avoids flash on refresh).
  syncLeftColumnRail();
  syncMarketColumnRail();
  requestAnimationFrame(() => {
    syncLeftColumnRail();
    syncMarketColumnRail();
  });
  void loadWalletAccount();
  void loadSettingsUser();
  bindWalletBalanceRefresh();
  bindSettingsEditors();
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
  const res = await fetch(`/api/window?series=${encodeURIComponent(selectedSeries)}`, {
    credentials: "same-origin",
  });
  if (res.ok) updateWindowUI(await res.json());
  connectSSE();

  countdownTimer = setInterval(() => {
    if (windowState) {
      updateCountdown(windowState);
      drawPriceChart(windowState);
    }
  }, 1000);
}

let appInitialized = false;

async function enterApp(user) {
  showAppShell();
  if (user) {
    renderSettingsUser(user);
    applyWalletGate(isWalletReadyFromUser(user));
  }
  if (appInitialized) {
    void loadWalletAccount();
    void loadSettingsUser();
    return;
  }
  appInitialized = true;
  await init();
  if (!walletReady && typeof showAppPage === "function") {
    showAppPage("settings", { persist: false });
  }
}

async function boot() {
  bindAuthForm(enterApp);
  try {
    const user = await fetchAuthMe();
    if (user) {
      await enterApp(user);
      return;
    }
  } catch {
    // fall through to auth screen
  }
  showAuthScreen();
  $("auth-email")?.focus();
}

boot();
