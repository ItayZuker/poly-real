/** Simulator UI — phase overlay, markers, tooltips (logic runs on server). */
(function () {
  const UP_COLOR = "#3fb950";
  const DOWN_COLOR = "#f85149";
  const LINE_COLOR = "#6e7681";
  const LINE_COLOR_HOVER = "#58a6ff";
  const MIN_PHASE_SECONDS = 10;
  const DEFAULT_WINDOW_DURATION_SEC = 300;
  const LINE_HIT_PX = 14;
  const MARKER_HIT_PX = 10;
  const PHASE_COLOR = "rgba(110, 118, 129, 0.08)";
  const PHASE_HOVER_COLOR = "rgba(88, 166, 255, 0.16)";

  let chartLayout = null;
  let dragLine = null;
  let dragMoved = false;
  let activePhaseModal = null;
  let tooltipEl = null;
  let phaseHoverEl = null;
  let hoveredMarker = null;
  let lastHoverCanvasX = null;
  let localSetup = null;
  let localSetupDirty = false;
  let suppressScheduleTitle = false;
  let scheduleTitleContextKey = null;
  let hoveredPhaseLine = null;
  let serverMarkers = [];
  let externalPhaseContext = null;

  function scheduleContextKey(state) {
    const trading = state?.trading;
    if (!trading?.config?.useSchedule) return null;
    return trading.scheduleSetupId || trading.scheduleTitle || null;
  }

  function syncScheduleTitleContext(state) {
    const key = scheduleContextKey(state);
    if (key !== scheduleTitleContextKey) {
      scheduleTitleContextKey = key;
      suppressScheduleTitle = false;
    }
  }

  function phaseModalTitle(phaseIdx) {
    const trading = window.windowState?.trading;
    const scheduleTitle =
      !suppressScheduleTitle && trading?.config?.useSchedule ? trading.scheduleTitle : null;
    return scheduleTitle
      ? `Phase ${phaseIdx + 1} — ${scheduleTitle}`
      : `Phase ${phaseIdx + 1} setup`;
  }

  function setupFromPhaseSetup(phaseSetup, latencyMs) {
    return {
      phaseSplit: [...phaseSetup.phaseSplit],
      phases: Array.isArray(phaseSetup.phases)
        ? phaseSetup.phases.map((p) => normalizePhase(p))
        : [defaultPhase(), defaultPhase(), defaultPhase()],
      latencyMs: latencyMs ?? 150,
    };
  }

  function phaseSplitsClose(a, b) {
    if (!a || !b || a.length < 2 || b.length < 2) return false;
    return Math.abs(a[0] - b[0]) < 1e-6 && Math.abs(a[1] - b[1]) < 1e-6;
  }

  function phaseSetupFingerprint(setup) {
    if (!setup?.phaseSplit || !Array.isArray(setup.phases)) return "";
    return JSON.stringify({
      phaseSplit: setup.phaseSplit,
      phases: setup.phases,
    });
  }

  function remotePhaseSetup(state) {
    const trading = state?.trading;
    if (trading?.config?.useSchedule && trading.phaseSetup) return trading.phaseSetup;
    const sim = state?.sim?.setup;
    if (!sim) return null;
    return { phaseSplit: sim.phaseSplit, phases: sim.phases };
  }

  function mirrorLocalSetupToWindowState() {
    if (!localSetup || !window.windowState) return;
    const state = window.windowState;
    if (state.trading) {
      state.trading.phaseSetup = {
        phaseSplit: [...localSetup.phaseSplit],
        phases: localSetup.phases.map((p) => ({ ...p })),
      };
    }
    if (state.sim) {
      state.sim.setup = {
        ...state.sim.setup,
        phaseSplit: [...localSetup.phaseSplit],
        phases: localSetup.phases.map((p) => ({ ...p })),
        latencyMs: localSetup.latencyMs ?? state.sim.setup?.latencyMs ?? 150,
      };
    }
  }

  function markLocalSetupDirty(setup) {
    localSetup = setup;
    localSetupDirty = true;
    // Bars / phase edits diverge from the named schedule card — drop its title on all phases.
    if (window.windowState?.trading?.config?.useSchedule) {
      suppressScheduleTitle = true;
    }
    mirrorLocalSetupToWindowState();
  }

  function getSetup(state) {
    if (localSetup) return localSetup;
    const trading = state?.trading;
    if (trading?.phaseSetup) {
      return setupFromPhaseSetup(
        trading.phaseSetup,
        state?.sim?.setup?.latencyMs ?? 150,
      );
    }
    return state?.sim?.setup || defaultSetup();
  }

  function resolveBuyOrderType(buyOptimize) {
    return buyOptimize ? "FAK" : "GTD";
  }

  function defaultPhase() {
    return {
      buyEnabled: true,
      buyShares: 10,
      buyTrigger: 40,
      buyOptimize: false,
      buyOrderType: "GTD",
      minGap: 0,
      maxGap: 0,
      gapVsPtb: "opposite",
      sellProfitCents: 20,
    };
  }

  function normalizePhase(raw) {
    const base = defaultPhase();
    if (!raw || typeof raw !== "object") return base;
    let buyOptimize = false;
    if (typeof raw.buyOptimize === "boolean") buyOptimize = raw.buyOptimize;
    else if (typeof raw.buyOptimize === "number") buyOptimize = raw.buyOptimize > 0;
    const minGap = Number(raw.minGap);
    const maxGap = Number(raw.maxGap);
    return {
      buyEnabled: Boolean(raw.buyEnabled ?? base.buyEnabled),
      buyShares: Math.max(1, Math.floor(Number(raw.buyShares)) || base.buyShares),
      buyTrigger: Math.max(1, Math.min(99, Math.floor(Number(raw.buyTrigger)) || base.buyTrigger)),
      buyOptimize,
      buyOrderType: resolveBuyOrderType(buyOptimize),
      minGap: Number.isFinite(minGap) && minGap > 0 ? Math.round(minGap * 100) / 100 : 0,
      maxGap: Number.isFinite(maxGap) && maxGap > 0 ? Math.round(maxGap * 100) / 100 : 0,
      gapVsPtb: raw.gapVsPtb === "with" ? "with" : "opposite",
      sellProfitCents: Math.max(
        1,
        Math.min(99, Math.floor(Number(raw.sellProfitCents)) || base.sellProfitCents),
      ),
    };
  }

  function syncTriggerOrderTypeLabel() {
    const text = document.getElementById("phase-buy-trigger-text");
    if (!text) return;
    const optimize = Boolean(document.getElementById("phase-buy-optimize")?.checked);
    text.textContent = `Trigger (¢) ${resolveBuyOrderType(optimize)}`;
  }

  function defaultSetup() {
    return {
      phaseSplit: [1 / 3, 2 / 3],
      phases: [defaultPhase(), defaultPhase(), defaultPhase()],
      latencyMs: 150,
    };
  }

  function syncGapLabel(kind) {
    const input = document.getElementById(`phase-${kind}-gap`);
    const text = document.getElementById(`phase-${kind}-gap-text`);
    const label = document.getElementById(`phase-${kind}-gap-label`);
    if (!input || !text || !label) return;
    const n = Number(input.value);
    const isNone = !Number.isFinite(n) || n <= 0;
    text.textContent = isNone
      ? `${kind === "max" ? "Max" : "Min"} gap ($) None`
      : `${kind === "max" ? "Max" : "Min"} gap ($)`;
    label.classList.toggle("is-none", isNone);
  }

  function gapValuesInactive() {
    const maxGap = Number(document.getElementById("phase-max-gap")?.value);
    const minGap = Number(document.getElementById("phase-min-gap")?.value);
    const maxNone = !Number.isFinite(maxGap) || maxGap <= 0;
    const minNone = !Number.isFinite(minGap) || minGap <= 0;
    return maxNone && minNone;
  }

  function rememberGapVsPtbValue(select) {
    if (!select) return;
    if (select.value === "opposite" || select.value === "with") {
      select.dataset.lastValue = select.value;
    }
  }

  function resolvedGapVsPtb(select) {
    if (!select) return "opposite";
    if (select.value === "with" || select.value === "opposite") return select.value;
    const last = select.dataset.lastValue;
    return last === "with" ? "with" : "opposite";
  }

  function syncGapVsPtbControl(formLocked = false) {
    const select = document.getElementById("phase-gap-vs-ptb");
    const label = document.getElementById("phase-gap-vs-ptb-label");
    const buyEnabled = Boolean(document.getElementById("phase-buy-enabled")?.checked);
    if (!select || !label) return;

    rememberGapVsPtbValue(select);
    const gapsInactive = gapValuesInactive();
    const disabled = formLocked || !buyEnabled || gapsInactive;
    const noneOpt = select.querySelector('option[value="none"]');

    if (gapsInactive) {
      if (noneOpt) noneOpt.hidden = false;
      select.value = "none";
      label.classList.add("is-none");
    } else {
      if (noneOpt) noneOpt.hidden = true;
      if (select.value === "none" || select.value === "") {
        select.value = select.dataset.lastValue === "with" ? "with" : "opposite";
      }
      rememberGapVsPtbValue(select);
      label.classList.remove("is-none");
    }

    select.disabled = disabled;
  }

  function syncGapLabels(formLocked = false) {
    syncGapLabel("max");
    syncGapLabel("min");
    syncGapVsPtbControl(formLocked === true || isPhaseModalReadOnly());
  }

  function syncFromState(state) {
    syncScheduleTitleContext(state);
    if (Array.isArray(state?.trading?.markers)) serverMarkers = state.trading.markers;
    else if (Array.isArray(state?.sim?.markers)) serverMarkers = state.sim.markers;

    // While dragging or waiting for save ack, keep the local bar position — otherwise SSE
    // with the pre-drag setup snaps the line back before the write lands.
    if (dragLine != null || localSetupDirty) {
      if (localSetupDirty) {
        const remote = remotePhaseSetup(state);
        if (
          remote &&
          phaseSetupFingerprint(remote) === phaseSetupFingerprint(localSetup)
        ) {
          localSetupDirty = false;
        } else {
          mirrorLocalSetupToWindowState();
        }
      }
      return;
    }

    const trading = state?.trading;
    const useSchedule = Boolean(trading?.config?.useSchedule);
    // Keep the in-graph draft aligned with whatever setup is drawn (schedule or sim).
    if (useSchedule && trading?.phaseSetup) {
      localSetup = setupFromPhaseSetup(
        trading.phaseSetup,
        state?.sim?.setup?.latencyMs ?? localSetup?.latencyMs ?? 150,
      );
    } else if (state?.sim?.setup) {
      localSetup = JSON.parse(JSON.stringify(state.sim.setup));
      if (Array.isArray(localSetup?.phases)) {
        localSetup.phases = localSetup.phases.map((p) => normalizePhase(p));
      }
    }
  }

  function forceSyncSetupFromState(state) {
    localSetupDirty = false;
    dragLine = null;
    syncScheduleTitleContext(state);
    // Applying a fresh setup from the card restores the named title until edited again.
    if (scheduleContextKey(state)) suppressScheduleTitle = false;
    const trading = state?.trading;
    const useSchedule = Boolean(trading?.config?.useSchedule);
    if (useSchedule && trading?.phaseSetup) {
      localSetup = setupFromPhaseSetup(
        trading.phaseSetup,
        state?.sim?.setup?.latencyMs ?? 150,
      );
    } else if (state?.sim?.setup) {
      localSetup = JSON.parse(JSON.stringify(state.sim.setup));
      if (Array.isArray(localSetup?.phases)) {
        localSetup.phases = localSetup.phases.map((p) => normalizePhase(p));
      }
    }
    if (Array.isArray(state?.trading?.markers)) serverMarkers = state.trading.markers;
    else if (Array.isArray(state?.sim?.markers)) serverMarkers = state.sim.markers;
  }

  /** Keep graph bars where they are and treat them as the editable sim setup. */
  function keepDisplayedSetupAsEditable(state) {
    const trading = state?.trading;
    const source = trading?.phaseSetup || localSetup || state?.sim?.setup;
    if (!source) return;
    dragLine = null;
    suppressScheduleTitle = false;
    localSetup = setupFromPhaseSetup(
      source,
      source.latencyMs ?? state?.sim?.setup?.latencyMs ?? localSetup?.latencyMs ?? 150,
    );
    localSetupDirty = true;
    mirrorLocalSetupToWindowState();
  }

  function phasesEditable(state) {
    const trading = state?.trading;
    if (trading) return Boolean(trading.phasesEditable);
    return true;
  }

  function phasesVisible(state, options = {}) {
    if (options.phasesVisible === false) return false;
    if (options.phasesVisible === true) return true;
    const trading = state?.trading;
    if (!trading) return options.phasesVisible !== false;
    if (trading.phasesVisible) return true;
    const cfg = trading.config;
    // Auto Trade without schedule should always keep phases on the graph
    if (cfg?.autoTrade && !cfg.useSchedule) return true;
    if (cfg?.autoTrade && trading.phaseSetup) return true;
    return false;
  }

  function isDraggingPhaseLine() {
    return dragLine != null;
  }

  async function pushSetupToServer() {
    if (!localSetup) return;
    const trading = window.windowState?.trading;
    const scheduleSetupId = trading?.scheduleSetupId;
    mirrorLocalSetupToWindowState();
    try {
      if (trading?.config?.useSchedule && scheduleSetupId) {
        const res = await fetch(`/api/trading-setups/${encodeURIComponent(scheduleSetupId)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            setup: {
              phaseSplit: localSetup.phaseSplit,
              phases: localSetup.phases,
            },
          }),
        });
        if (res.ok) {
          const doc = await res.json();
          if (doc?.setup) {
            localSetup = setupFromPhaseSetup(doc.setup, localSetup.latencyMs);
            mirrorLocalSetupToWindowState();
          }
          // Keep dirty until a sync's remote splits match — avoids a stale SSE snap-back.
        }
        return;
      }
      const res = await fetch("/api/sim/setup", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(localSetup),
      });
      if (res.ok) {
        localSetup = await res.json();
        mirrorLocalSetupToWindowState();
        // Keep dirty until remote state matches (see syncFromState).
      }
    } catch {
      // keep local dirty copy until a later sync matches
    }
  }

  function sessionKeyFor(state) {
    return `${state?.series || ""}:${state?.windowStart || ""}`;
  }

  function phaseIndexForFrac(frac, setup) {
    if (frac < setup.phaseSplit[0]) return 0;
    if (frac < setup.phaseSplit[1]) return 1;
    return 2;
  }

  function fracToX(frac, layout) {
    return layout.padding.left + frac * layout.plotW;
  }

  function formatWindowTimeFromFrac(frac, layout) {
    const duration = layout?.duration;
    if (!duration || !Number.isFinite(duration)) return "";
    const totalSec = Math.max(0, Math.min(duration, Math.round(frac * duration)));
    const mins = Math.floor(totalSec / 60);
    const secs = totalSec % 60;
    return `${mins}:${String(secs).padStart(2, "0")}`;
  }

  function xToFrac(x, layout) {
    return Math.min(1, Math.max(0, (x - layout.padding.left) / layout.plotW));
  }

  function fmtUsd(amount) {
    return `$${amount.toFixed(2)}`;
  }

  function fmtPriceCents(price) {
    const cents = price * 100;
    return Number.isInteger(cents) ? `${cents}¢` : `${cents.toFixed(1)}¢`;
  }

  function markerCanvasPos(marker, layout) {
    const x = layout.xAt(marker.t);
    let y = layout.padding.top + layout.plotH / 2;
    if (marker.y != null && Number.isFinite(marker.y) && layout.yAt) {
      y = layout.yAt(marker.y);
    }
    return { x, y };
  }

  function markerAt(canvasX, canvasY, layout) {
    if (!layout?.xAt) return null;
    for (let i = serverMarkers.length - 1; i >= 0; i -= 1) {
      const marker = serverMarkers[i];
      const pos = markerCanvasPos(marker, layout);
      const dx = canvasX - pos.x;
      const dy = canvasY - pos.y;
      if (Math.hypot(dx, dy) <= MARKER_HIT_PX) return marker;
    }
    return null;
  }

  function tooltipRow(label, value) {
    return `<div class="sim-marker-tooltip-row"><span class="sim-marker-tooltip-label">${label}</span><span class="sim-marker-tooltip-value">${value}</span></div>`;
  }

  function markerTotal(marker) {
    if (marker.total != null && Number.isFinite(marker.total)) return marker.total;
    if (marker.type === "buy") {
      return (marker.cost ?? 0) + (marker.fees ?? 0);
    }
    return marker.proceeds ?? 0;
  }

  function buyPositionCost(marker) {
    if (marker.type === "buy") return markerTotal(marker);
    const buy = serverMarkers.find((m) => m.type === "buy" && m.windowKey === marker.windowKey);
    return buy ? markerTotal(buy) : null;
  }

  function renderMarkerTooltip(marker) {
    const sideLabel = marker.side === "up" ? "UP" : "DOWN";
    const total = marker.type === "buy" ? markerTotal(marker) : buyPositionCost(marker);
    const totalRow = total != null && Number.isFinite(total)
      ? tooltipRow("Total", fmtUsd(total))
      : "";
    if (marker.type === "buy") {
      return [
        `<div class="sim-marker-tooltip-title">Buy ${sideLabel}</div>`,
        tooltipRow("Shares", String(marker.shares)),
        tooltipRow("Price", fmtPriceCents(marker.price)),
        tooltipRow("Cost", fmtUsd(marker.cost)),
        tooltipRow("Fees", fmtUsd(marker.fees)),
        totalRow,
      ].join("");
    }
    return [
      `<div class="sim-marker-tooltip-title">Sell ${sideLabel}</div>`,
      tooltipRow("Shares", String(marker.shares)),
      tooltipRow("Price", fmtPriceCents(marker.price)),
      tooltipRow("Proceeds", fmtUsd(marker.proceeds)),
      marker.fees != null && marker.fees > 0 ? tooltipRow("Fees", fmtUsd(marker.fees)) : "",
      tooltipRow("Profit", fmtUsd(marker.profit)),
      totalRow,
    ].join("");
  }

  function showMarkerTooltip(marker, canvas, clientX, clientY) {
    if (!tooltipEl || !marker) return;
    tooltipEl.innerHTML = renderMarkerTooltip(marker);
    tooltipEl.hidden = false;

    const wrap = canvas.parentElement;
    const wrapRect = wrap.getBoundingClientRect();
    const tipRect = tooltipEl.getBoundingClientRect();
    let left = clientX - wrapRect.left + 12;
    let top = clientY - wrapRect.top - tipRect.height - 12;

    if (left + tipRect.width > wrapRect.width - 4) {
      left = clientX - wrapRect.left - tipRect.width - 12;
    }
    if (top < 4) top = clientY - wrapRect.top + 12;
    if (left < 4) left = 4;

    tooltipEl.style.left = `${left}px`;
    tooltipEl.style.top = `${top}px`;
  }

  function hideMarkerTooltip() {
    if (!tooltipEl) return;
    tooltipEl.hidden = true;
    hoveredMarker = null;
  }

  function hidePhaseHover() {
    if (!phaseHoverEl) return;
    phaseHoverEl.hidden = true;
    lastHoverCanvasX = null;
  }

  function updatePhaseHover(canvasX, layout) {
    if (!phaseHoverEl || !layout) return;
    const state = window.windowState;
    if (!phasesVisible(state)) {
      hidePhaseHover();
      return;
    }
    const setup = getSetup(state);
    if (canvasX == null || !Number.isFinite(canvasX)) {
      hidePhaseHover();
      return;
    }

    const onLine = nearLine(canvasX, layout, 0, setup) || nearLine(canvasX, layout, 1, setup);
    if (onLine) {
      hidePhaseHover();
      return;
    }

    const frac = xToFrac(canvasX, layout);
    const phaseIdx = phaseIndexForFrac(frac, setup);
    const bounds = [0, setup.phaseSplit[0], setup.phaseSplit[1], 1];
    const x0 = fracToX(bounds[phaseIdx], layout);
    const x1 = fracToX(bounds[phaseIdx + 1], layout);

    phaseHoverEl.style.left = `${x0}px`;
    phaseHoverEl.style.top = `${layout.padding.top}px`;
    phaseHoverEl.style.width = `${Math.max(0, x1 - x0)}px`;
    phaseHoverEl.style.height = `${layout.plotH}px`;
    phaseHoverEl.style.background = PHASE_HOVER_COLOR;
    phaseHoverEl.hidden = false;
    lastHoverCanvasX = canvasX;
  }

  function updateMarkerHover(canvas, clientX, clientY) {
    if (!chartLayout) {
      hideMarkerTooltip();
      return;
    }
    const rect = canvas.getBoundingClientRect();
    const x = clientX - rect.left;
    const y = clientY - rect.top;
    const marker = markerAt(x, y, chartLayout);
    if (!marker) {
      hideMarkerTooltip();
      return;
    }
    if (hoveredMarker !== marker) hoveredMarker = marker;
    showMarkerTooltip(marker, canvas, clientX, clientY);
  }

  function sideColor(side) {
    return side === "up" ? UP_COLOR : DOWN_COLOR;
  }

  function drawPhaseSplitLine(ctx, x, layout, frac, lineIndex, lineState = {}) {
    const { padding, plotH } = layout;
    const centerY = padding.top + plotH / 2;
    const isActive =
      lineState.hoverLine === lineIndex || lineState.dragLine === lineIndex;
    const color = isActive ? LINE_COLOR_HOVER : LINE_COLOR;

    ctx.strokeStyle = color;
    ctx.lineWidth = 2;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(x, padding.top);
    ctx.lineTo(x, padding.top + plotH);
    ctx.stroke();

    const timeLabel = formatWindowTimeFromFrac(frac, layout);
    if (timeLabel) {
      ctx.fillStyle = color;
      ctx.font = "10px sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "top";
      ctx.fillText(timeLabel, x, padding.top + plotH + 4);
    }

    const triH = 6;
    const triW = 5;
    const gap = 3;
    ctx.fillStyle = color;

    ctx.beginPath();
    ctx.moveTo(x - gap - triW, centerY);
    ctx.lineTo(x - gap, centerY - triH / 2);
    ctx.lineTo(x - gap, centerY + triH / 2);
    ctx.closePath();
    ctx.fill();

    ctx.beginPath();
    ctx.moveTo(x + gap + triW, centerY);
    ctx.lineTo(x + gap, centerY - triH / 2);
    ctx.lineTo(x + gap, centerY + triH / 2);
    ctx.closePath();
    ctx.fill();
  }

  function drawPhasesAndMarkers(ctx, layout, state, options = {}) {
    const { padding, plotH, yAt, xAt } = layout;
    const setup = options.setupOverride ?? getSetup(state);
    const key = sessionKeyFor(state);
    const markerList = options.markersOverride ?? serverMarkers;
    const showPhases = phasesVisible(state, options);
    let splits = null;
    let lineState = null;

    if (showPhases) {
      splits = Array.isArray(setup?.phaseSplit) ? setup.phaseSplit : [1 / 3, 2 / 3];
      const bounds = [0, splits[0], splits[1], 1];
      const hoverLine = options.hoverLine !== undefined ? options.hoverLine : hoveredPhaseLine;
      const activeDragLine = options.dragLine !== undefined ? options.dragLine : dragLine;
      lineState = { hoverLine, dragLine: activeDragLine };

      // Bands sit behind markers; split lines are drawn last so they stay grabable.
      for (let i = 0; i < 3; i += 1) {
        const x0 = fracToX(bounds[i], layout);
        const x1 = fracToX(bounds[i + 1], layout);
        ctx.fillStyle = PHASE_COLOR;
        ctx.fillRect(x0, padding.top, x1 - x0, plotH);
        ctx.fillStyle = "#6e7681";
        ctx.font = "10px sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.fillText(`P${i + 1}`, (x0 + x1) / 2, padding.top + 4);
      }
    }

    if (options.markers !== false) {
      for (const m of markerList) {
        if (!state?.windowStart) continue;
        if (m.windowKey && m.windowKey !== key) continue;
        const x = xAt(m.t);
        let y = padding.top + plotH / 2;
        if (m.y != null && Number.isFinite(m.y) && layout.yAt) {
          y = layout.yAt(m.y);
        }
        const color = sideColor(m.side);
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        if (m.type === "buy") {
          ctx.fillStyle = color;
          ctx.fill();
        } else {
          ctx.fillStyle = "rgba(13, 17, 23, 0.85)";
          ctx.fill();
          ctx.strokeStyle = color;
          ctx.lineWidth = 2;
          ctx.stroke();
        }
      }
    }

    if (showPhases && splits && lineState) {
      for (let i = 0; i < 2; i += 1) {
        drawPhaseSplitLine(ctx, fracToX(splits[i], layout), layout, splits[i], i, lineState);
      }
    }
  }

  function hoveredLineAt(x, layout, setup) {
    if (nearLine(x, layout, 0, setup)) return 0;
    if (nearLine(x, layout, 1, setup)) return 1;
    return null;
  }

  function setHoveredPhaseLine(lineIndex) {
    if (hoveredPhaseLine === lineIndex) return false;
    hoveredPhaseLine = lineIndex;
    return true;
  }

  function nearLine(x, layout, lineIndex, setup) {
    const lineX = fracToX(setup.phaseSplit[lineIndex], layout);
    return Math.abs(x - lineX) <= LINE_HIT_PX;
  }

  function phaseFromClick(x, layout, setup) {
    const frac = xToFrac(x, layout);
    return phaseIndexForFrac(frac, setup);
  }

  function minPhaseFrac(durationSec) {
    const duration = Math.max(1, durationSec ?? DEFAULT_WINDOW_DURATION_SEC);
    return Math.min(1 / 3, MIN_PHASE_SECONDS / duration);
  }

  function clampSplits(s0, s1, durationSec) {
    const minF = minPhaseFrac(durationSec);
    let a = Math.min(s0, s1);
    let b = Math.max(s0, s1);
    a = Math.max(minF, Math.min(1 - minF * 2, a));
    b = Math.max(a + minF, Math.min(1 - minF, b));
    return [a, b];
  }

  function readPhaseFormIntoSetup(setup, phaseIdx) {
    const cfg = setup.phases[phaseIdx];
    cfg.buyEnabled = document.getElementById("phase-buy-enabled").checked;
    cfg.buyShares = Math.max(1, Number(document.getElementById("phase-buy-shares").value) || 10);
    cfg.buyTrigger = Number(document.getElementById("phase-buy-trigger").value) || 40;
    cfg.buyOptimize = document.getElementById("phase-buy-optimize").checked;
    cfg.buyOrderType = resolveBuyOrderType(cfg.buyOptimize);
    const maxGap = Number(document.getElementById("phase-max-gap").value);
    const minGap = Number(document.getElementById("phase-min-gap").value);
    cfg.maxGap = Number.isFinite(maxGap) && maxGap > 0 ? Math.round(maxGap * 100) / 100 : 0;
    cfg.minGap = Number.isFinite(minGap) && minGap > 0 ? Math.round(minGap * 100) / 100 : 0;
    cfg.gapVsPtb = resolvedGapVsPtb(document.getElementById("phase-gap-vs-ptb"));
    cfg.sellProfitCents = Number(document.getElementById("phase-sell-profit").value) || 20;
    delete cfg.sellOptimize;
    setup.phases[phaseIdx] = normalizePhase(cfg);
  }

  function syncPhaseModalFooter() {
    const footer = document.querySelector("#phase-modal .modal-footer");
    const saveBtn = document.getElementById("phase-modal-save");
    const hint = document.getElementById("phase-modal-schedule-hint");
    const modal = document.getElementById("phase-modal");
    const external = !!externalPhaseContext;
    const readOnly = isPhaseModalReadOnly();
    if (saveBtn) saveBtn.hidden = external || readOnly;
    if (hint) {
      hint.hidden = !readOnly;
      if (readOnly) {
        hint.textContent = external
          ? "This setup is on the schedule. Remove its placements to edit."
          : 'To change settings turn off "Use Schedule"';
      }
    }
    // Hide the whole footer when neither Save nor the schedule hint is shown.
    const saveVisible = Boolean(saveBtn && !saveBtn.hidden);
    const hintVisible = Boolean(hint && !hint.hidden);
    if (footer) footer.hidden = !saveVisible && !hintVisible;
    if (modal) modal.classList.toggle("is-view-only", readOnly);
  }

  function isPhaseModalReadOnly() {
    if (externalPhaseContext) return Boolean(externalPhaseContext.readOnly);
    return window.windowState?.trading?.phasesEditable === false;
  }

  function openPhaseModal(phaseIdx) {
    const trading = window.windowState?.trading;
    const setup = externalPhaseContext?.setup
      ?? (trading?.phaseSetup
        ? { phaseSplit: trading.phaseSetup.phaseSplit, phases: trading.phaseSetup.phases, latencyMs: 150 }
        : getSetup(window.windowState));
    activePhaseModal = phaseIdx;
    const modal = document.getElementById("phase-modal");
    const cfg = normalizePhase(setup.phases[phaseIdx]);
    setup.phases[phaseIdx] = cfg;
    const readOnly = isPhaseModalReadOnly();
    document.getElementById("phase-modal-title").textContent = phaseModalTitle(phaseIdx);
    document.getElementById("phase-buy-enabled").checked = cfg.buyEnabled;
    document.getElementById("phase-buy-shares").value = cfg.buyShares;
    document.getElementById("phase-buy-trigger").value = cfg.buyTrigger;
    document.getElementById("phase-buy-optimize").checked = Boolean(cfg.buyOptimize);
    syncTriggerOrderTypeLabel();
    document.getElementById("phase-max-gap").value = cfg.maxGap ?? 0;
    document.getElementById("phase-min-gap").value = cfg.minGap ?? 0;
    const gapSelect = document.getElementById("phase-gap-vs-ptb");
    gapSelect.value = cfg.gapVsPtb === "with" ? "with" : "opposite";
    gapSelect.dataset.lastValue = gapSelect.value;
    document.getElementById("phase-sell-profit").value = cfg.sellProfitCents;
    syncPhaseFormDisabled(readOnly);
    if (externalPhaseContext) modal.classList.add("modal-overlay-stacked");
    else modal.classList.remove("modal-overlay-stacked");
    syncPhaseModalFooter();
    modal.hidden = false;
  }

  function closePhaseModal() {
    if (externalPhaseContext && !externalPhaseContext.readOnly && activePhaseModal != null) {
      readPhaseFormIntoSetup(externalPhaseContext.setup, activePhaseModal);
      const onChange = externalPhaseContext.onChange;
      if (onChange) onChange();
    }
    const modal = document.getElementById("phase-modal");
    if (modal) {
      modal.hidden = true;
      modal.classList.remove("modal-overlay-stacked");
    }
    activePhaseModal = null;
    syncPhaseModalFooter();
  }

  function syncPhaseFormDisabled(readOnly = false) {
    const enabled = document.getElementById("phase-buy-enabled").checked;
    // Coerce: event listeners may pass an Event (truthy) — only treat strict true as read-only.
    const forceReadOnly = readOnly === true || isPhaseModalReadOnly();
    const locked = forceReadOnly;
    document.getElementById("phase-buy-enabled").disabled = locked;
    document.getElementById("phase-buy-shares").disabled = locked || !enabled;
    document.getElementById("phase-buy-trigger").disabled = locked || !enabled;
    document.getElementById("phase-buy-optimize").disabled = locked || !enabled;
    document.getElementById("phase-max-gap").disabled = locked || !enabled;
    document.getElementById("phase-min-gap").disabled = locked || !enabled;
    document.getElementById("phase-sell-profit").disabled = locked;
    const buySection = document.getElementById("phase-buy-section");
    if (buySection) buySection.classList.toggle("is-buy-disabled", !enabled);
    syncTriggerOrderTypeLabel();
    syncGapLabels(locked || !enabled);
  }

  async function savePhaseModal() {
    if (activePhaseModal == null || externalPhaseContext) return;
    if (window.windowState?.trading?.phasesEditable === false) return;
    const setup = getSetup(window.windowState);
    readPhaseFormIntoSetup(setup, activePhaseModal);
    markLocalSetupDirty(setup);
    closePhaseModal();
    await pushSetupToServer();
  }

  function bindChartInteraction(canvas) {
    async function endPhaseDrag(options = {}) {
      const { openPhase = false, clientX = null } = options;
      const state = window.windowState;
      const setup = getSetup(state);
      const editable = phasesEditable(state);
      const showPhases = phasesVisible(state);
      const wasDragging = dragLine != null;
      const moved = dragMoved;

      dragLine = null;
      dragMoved = false;
      setHoveredPhaseLine(null);
      hideMarkerTooltip();
      hidePhaseHover();
      canvas.style.cursor = "pointer";
      if (window.drawPriceChart && window.windowState) window.drawPriceChart(window.windowState);

      if (wasDragging && moved && editable) {
        await pushSetupToServer();
        return;
      }

      if (
        openPhase &&
        !wasDragging &&
        !moved &&
        chartLayout &&
        showPhases &&
        clientX != null
      ) {
        const rect = canvas.getBoundingClientRect();
        const x = clientX - rect.left;
        if (!nearLine(x, chartLayout, 0, setup) && !nearLine(x, chartLayout, 1, setup)) {
          openPhaseModal(phaseFromClick(x, chartLayout, setup));
        }
      }
    }

    function onWindowMouseMove(e) {
      if (dragLine == null || !chartLayout) return;
      const state = window.windowState;
      if (!phasesEditable(state)) return;
      const setup = getSetup(state);
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      dragMoved = true;
      hideMarkerTooltip();
      hidePhaseHover();
      const frac = xToFrac(x, chartLayout);
      const splits = [...setup.phaseSplit];
      splits[dragLine] = frac;
      setup.phaseSplit = clampSplits(splits[0], splits[1], chartLayout.duration);
      markLocalSetupDirty(setup);
      canvas.style.cursor = "col-resize";
      if (window.drawPriceChart && window.windowState) window.drawPriceChart(window.windowState);
    }

    function onWindowMouseUp(e) {
      window.removeEventListener("mousemove", onWindowMouseMove);
      window.removeEventListener("mouseup", onWindowMouseUp);
      void endPhaseDrag({ openPhase: true, clientX: e.clientX });
    }

    canvas.addEventListener("mousedown", (e) => {
      if (!chartLayout) return;
      const state = window.windowState;
      if (!phasesEditable(state)) return;
      const setup = getSetup(state);
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      dragMoved = false;
      if (nearLine(x, chartLayout, 0, setup)) dragLine = 0;
      else if (nearLine(x, chartLayout, 1, setup)) dragLine = 1;
      else dragLine = null;
      if (dragLine != null) {
        canvas.style.cursor = "col-resize";
        window.addEventListener("mousemove", onWindowMouseMove);
        window.addEventListener("mouseup", onWindowMouseUp);
      }
    });

    canvas.addEventListener("mousemove", (e) => {
      if (!chartLayout || dragLine != null) return;
      const state = window.windowState;
      const setup = getSetup(state);
      const editable = phasesEditable(state);
      const showPhases = phasesVisible(state);
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const onLine = editable && (nearLine(x, chartLayout, 0, setup) || nearLine(x, chartLayout, 1, setup));
      const y = e.clientY - rect.top;
      const marker = !onLine ? markerAt(x, y, chartLayout) : null;

      if (showPhases && !onLine) {
        if (setHoveredPhaseLine(null) && window.drawPriceChart && window.windowState) {
          window.drawPriceChart(window.windowState);
        }
        updatePhaseHover(x, chartLayout);
      } else {
        hidePhaseHover();
        if (editable) {
          const hoverLine = hoveredLineAt(x, chartLayout, setup);
          if (setHoveredPhaseLine(hoverLine) && window.drawPriceChart && window.windowState) {
            window.drawPriceChart(window.windowState);
          }
        }
      }

      // Phase bars win over markers so drag stays available where they overlap.
      if (onLine) {
        hideMarkerTooltip();
        canvas.style.cursor = "col-resize";
        return;
      }
      if (marker) {
        canvas.style.cursor = "pointer";
        updateMarkerHover(canvas, e.clientX, e.clientY);
        return;
      }
      hideMarkerTooltip();
      canvas.style.cursor = "pointer";
    });

    canvas.addEventListener("mouseup", (e) => {
      // Non-drag clicks (open phase modal) when no window listener was armed.
      if (dragLine != null) return;
      void endPhaseDrag({ openPhase: true, clientX: e.clientX });
    });

    canvas.addEventListener("mouseleave", () => {
      if (dragLine != null) return;
      setHoveredPhaseLine(null);
      hideMarkerTooltip();
      hidePhaseHover();
      if (window.drawPriceChart && window.windowState) window.drawPriceChart(window.windowState);
      canvas.style.cursor = "default";
    });
  }

  function bindModal() {
    document.getElementById("phase-buy-enabled").addEventListener("change", () => {
      syncPhaseFormDisabled(isPhaseModalReadOnly());
    });
    document.getElementById("phase-buy-optimize").addEventListener("change", () => {
      syncTriggerOrderTypeLabel();
    });
    document.getElementById("phase-max-gap").addEventListener("input", () => {
      syncGapLabels(isPhaseModalReadOnly() || !document.getElementById("phase-buy-enabled").checked);
    });
    document.getElementById("phase-min-gap").addEventListener("input", () => {
      syncGapLabels(isPhaseModalReadOnly() || !document.getElementById("phase-buy-enabled").checked);
    });
    document.getElementById("phase-gap-vs-ptb").addEventListener("change", (e) => {
      rememberGapVsPtbValue(e.currentTarget);
    });
    document.getElementById("phase-modal-close").addEventListener("click", closePhaseModal);
    document.getElementById("phase-modal-save").addEventListener("click", () => void savePhaseModal());
    document.getElementById("phase-modal").addEventListener("click", (e) => {
      if (e.target.id === "phase-modal") closePhaseModal();
    });
  }

  window.Simulator = {
    syncFromState(state) {
      syncFromState(state);
    },
    forceSyncSetupFromState(state) {
      forceSyncSetupFromState(state);
    },
    keepDisplayedSetupAsEditable(state) {
      keepDisplayedSetupAsEditable(state);
    },
    getLocalSetup() {
      return localSetup;
    },
    async pushSetupToServer() {
      await pushSetupToServer();
    },
    setChartLayout(layout) {
      chartLayout = layout;
      if (lastHoverCanvasX != null) updatePhaseHover(lastHoverCanvasX, layout);
    },
    drawOverlay(ctx, layout, state, options = {}) {
      drawPhasesAndMarkers(ctx, layout, state, options);
    },
    clampPhaseSplits: clampSplits,
    minPhaseSeconds: MIN_PHASE_SECONDS,
    isDraggingPhaseLine,
    init(canvas) {
      tooltipEl = document.getElementById("sim-marker-tooltip");
      phaseHoverEl = document.getElementById("sim-phase-hover");
      bindChartInteraction(canvas);
      bindModal();
      canvas.style.cursor = "pointer";
    },
    beginExternalPhaseEdit(setup, onChange, options = {}) {
      externalPhaseContext = {
        setup,
        onChange,
        readOnly: Boolean(options.readOnly),
      };
    },
    endExternalPhaseEdit() {
      externalPhaseContext = null;
    },
    openPhaseModalExternal(phaseIdx) {
      openPhaseModal(phaseIdx);
    },
    isExternalPhaseReadOnly() {
      return Boolean(externalPhaseContext?.readOnly);
    },
  };
})();
