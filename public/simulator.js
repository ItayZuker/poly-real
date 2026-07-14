/** Simulator UI — phase overlay, markers, tooltips (logic runs on server). */
(function () {
  const UP_COLOR = "#3fb950";
  const DOWN_COLOR = "#f85149";
  const LINE_COLOR = "#6e7681";
  const LINE_COLOR_HOVER = "#58a6ff";
  const MIN_PHASE_SECONDS = 10;
  const DEFAULT_WINDOW_DURATION_SEC = 300;
  const LINE_HIT_PX = 10;
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
  let hoveredPhaseLine = null;
  let serverMarkers = [];
  let externalPhaseContext = null;

  function getSetup(state) {
    return localSetup || state?.sim?.setup || defaultSetup();
  }

  function defaultSetup() {
    return {
      phaseSplit: [1 / 3, 2 / 3],
      phases: [
        { buyEnabled: true, buyShares: 10, buyTrigger: 40, buyOptimize: 5, sellProfitCents: 20, sellOptimize: 5 },
        { buyEnabled: true, buyShares: 10, buyTrigger: 40, buyOptimize: 5, sellProfitCents: 20, sellOptimize: 5 },
        { buyEnabled: true, buyShares: 10, buyTrigger: 40, buyOptimize: 5, sellProfitCents: 20, sellOptimize: 5 },
      ],
      latencyMs: 150,
    };
  }

  function syncFromState(state) {
    if (dragLine != null) {
      if (Array.isArray(state?.trading?.markers)) serverMarkers = state.trading.markers;
      else if (Array.isArray(state?.sim?.markers)) serverMarkers = state.sim.markers;
      return;
    }
    if (state?.sim?.setup && state?.trading?.phasesEditable !== false) {
      localSetup = JSON.parse(JSON.stringify(state.sim.setup));
    }
    if (Array.isArray(state?.trading?.markers)) serverMarkers = state.trading.markers;
    else if (Array.isArray(state?.sim?.markers)) serverMarkers = state.sim.markers;
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
    try {
      const res = await fetch("/api/sim/setup", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(localSetup),
      });
      if (res.ok) localSetup = await res.json();
    } catch {
      // keep local copy
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

    if (phasesVisible(state, options)) {
      const splits = Array.isArray(setup?.phaseSplit) ? setup.phaseSplit : [1 / 3, 2 / 3];
      const bounds = [0, splits[0], splits[1], 1];
      const hoverLine = options.hoverLine !== undefined ? options.hoverLine : hoveredPhaseLine;
      const activeDragLine = options.dragLine !== undefined ? options.dragLine : dragLine;
      const lineState = { hoverLine, dragLine: activeDragLine };

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

      for (let i = 0; i < 2; i += 1) {
        drawPhaseSplitLine(ctx, fracToX(splits[i], layout), layout, splits[i], i, lineState);
      }
    }

    if (options.markers === false) return;

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
    cfg.buyOptimize = Number(document.getElementById("phase-buy-optimize").value) || 0;
    cfg.sellProfitCents = Number(document.getElementById("phase-sell-profit").value) || 20;
    cfg.sellOptimize = Number(document.getElementById("phase-sell-optimize").value) || 0;
  }

  function syncPhaseModalFooter() {
    const footer = document.querySelector("#phase-modal .modal-footer");
    const saveBtn = document.getElementById("phase-modal-save");
    const external = !!externalPhaseContext;
    const readOnly = window.windowState?.trading?.phasesEditable === false;
    if (saveBtn) saveBtn.hidden = external || readOnly;
    if (footer) footer.hidden = external || readOnly;
  }

  function openPhaseModal(phaseIdx) {
    const trading = window.windowState?.trading;
    const setup = externalPhaseContext?.setup
      ?? (trading?.phaseSetup
        ? { phaseSplit: trading.phaseSetup.phaseSplit, phases: trading.phaseSetup.phases, latencyMs: 150 }
        : getSetup(window.windowState));
    activePhaseModal = phaseIdx;
    const modal = document.getElementById("phase-modal");
    const cfg = setup.phases[phaseIdx];
    const readOnly = window.windowState?.trading?.phasesEditable === false;
    const scheduleTitle = window.windowState?.trading?.scheduleTitle;
    document.getElementById("phase-modal-title").textContent = readOnly && scheduleTitle
      ? `Phase ${phaseIdx + 1} — ${scheduleTitle}`
      : `Phase ${phaseIdx + 1} setup`;
    document.getElementById("phase-buy-enabled").checked = cfg.buyEnabled;
    document.getElementById("phase-buy-shares").value = cfg.buyShares;
    document.getElementById("phase-buy-trigger").value = cfg.buyTrigger;
    document.getElementById("phase-buy-optimize").value = cfg.buyOptimize;
    document.getElementById("phase-sell-profit").value = cfg.sellProfitCents;
    document.getElementById("phase-sell-optimize").value = cfg.sellOptimize;
    syncPhaseFormDisabled(readOnly);
    if (externalPhaseContext) modal.classList.add("modal-overlay-stacked");
    else modal.classList.remove("modal-overlay-stacked");
    syncPhaseModalFooter();
    modal.hidden = false;
  }

  function closePhaseModal() {
    if (externalPhaseContext && activePhaseModal != null) {
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
    const locked = readOnly || window.windowState?.trading?.phasesEditable === false;
    document.getElementById("phase-buy-enabled").disabled = locked;
    document.getElementById("phase-buy-shares").disabled = locked || !enabled;
    document.getElementById("phase-buy-trigger").disabled = locked || !enabled;
    document.getElementById("phase-buy-optimize").disabled = locked || !enabled;
    document.getElementById("phase-sell-profit").disabled = locked;
    document.getElementById("phase-sell-optimize").disabled = locked;
  }

  async function savePhaseModal() {
    if (activePhaseModal == null || externalPhaseContext) return;
    const setup = getSetup(window.windowState);
    readPhaseFormIntoSetup(setup, activePhaseModal);
    localSetup = setup;
    closePhaseModal();
    await pushSetupToServer();
  }

  function bindChartInteraction(canvas) {
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
      if (dragLine != null) canvas.style.cursor = "col-resize";
    });

    canvas.addEventListener("mousemove", (e) => {
      if (!chartLayout) return;
      const state = window.windowState;
      const setup = getSetup(state);
      const editable = phasesEditable(state);
      const showPhases = phasesVisible(state);
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (dragLine != null) {
        if (!editable) return;
        dragMoved = true;
        hideMarkerTooltip();
        hidePhaseHover();
        const frac = xToFrac(x, chartLayout);
        const splits = [...setup.phaseSplit];
        splits[dragLine] = frac;
        setup.phaseSplit = clampSplits(splits[0], splits[1], chartLayout.duration);
        localSetup = setup;
        if (window.drawPriceChart && window.windowState) window.drawPriceChart(window.windowState);
        return;
      }
      const onLine = editable && (nearLine(x, chartLayout, 0, setup) || nearLine(x, chartLayout, 1, setup));
      const y = e.clientY - rect.top;
      const marker = markerAt(x, y, chartLayout);

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

      if (marker) {
        canvas.style.cursor = "pointer";
        updateMarkerHover(canvas, e.clientX, e.clientY);
        return;
      }
      hideMarkerTooltip();
      canvas.style.cursor = onLine ? "col-resize" : "pointer";
    });

    canvas.addEventListener("mouseup", async (e) => {
      const state = window.windowState;
      const setup = getSetup(state);
      const editable = phasesEditable(state);
      const showPhases = phasesVisible(state);
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (dragLine != null) {
        if (editable) await pushSetupToServer();
      } else if (!dragMoved && chartLayout && showPhases) {
        const idx = phaseFromClick(x, chartLayout, setup);
        if (!nearLine(x, chartLayout, 0, setup) && !nearLine(x, chartLayout, 1, setup)) {
          openPhaseModal(idx);
        }
      }
      dragLine = null;
      canvas.style.cursor = "pointer";
    });

    canvas.addEventListener("mouseleave", () => {
      if (dragLine != null && dragMoved) {
        void pushSetupToServer();
      }
      dragLine = null;
      dragMoved = false;
      setHoveredPhaseLine(null);
      hideMarkerTooltip();
      hidePhaseHover();
      if (window.drawPriceChart && window.windowState) window.drawPriceChart(window.windowState);
      canvas.style.cursor = "default";
    });
  }

  function bindModal() {
    document.getElementById("phase-buy-enabled").addEventListener("change", syncPhaseFormDisabled);
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
    beginExternalPhaseEdit(setup, onChange) {
      externalPhaseContext = { setup, onChange };
    },
    endExternalPhaseEdit() {
      externalPhaseContext = null;
    },
    openPhaseModalExternal(phaseIdx) {
      openPhaseModal(phaseIdx);
    },
  };
})();
