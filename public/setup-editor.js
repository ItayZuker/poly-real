/** Edit saved trading setup templates — live price chart + phase bars. */
(function () {
  const LINE_HIT_PX = 10;
  const PHASE_HOVER_COLOR = "rgba(88, 166, 255, 0.16)";
  const CHART_REFRESH_MS = 1000;

  let modal = null;
  let titleInput = null;
  let descInput = null;
  let colorInput = null;
  let saveBtn = null;
  let canvas = null;
  let chartWrap = null;
  let phaseHoverEl = null;
  let chartLayout = null;
  let dragLine = null;
  let dragMoved = false;
  let hoveredPhaseLine = null;
  let editingId = null;
  let draft = null;
  let baseline = null;
  let refreshTimer = null;
  let resizeObserver = null;
  let persisting = false;

  function $(id) {
    return document.getElementById(id);
  }

  function deepClone(value) {
    return JSON.parse(JSON.stringify(value));
  }

  function defaultSetup() {
    return {
      phaseSplit: [1 / 3, 2 / 3],
      phases: [
        { buyEnabled: true, buyShares: 10, buyTrigger: 40, buyOptimize: 5, sellProfitCents: 20, sellOptimize: 5 },
        { buyEnabled: true, buyShares: 10, buyTrigger: 40, buyOptimize: 5, sellProfitCents: 20, sellOptimize: 5 },
        { buyEnabled: true, buyShares: 10, buyTrigger: 40, buyOptimize: 5, sellProfitCents: 20, sellOptimize: 5 },
      ],
    };
  }

  function fracToX(frac, layout) {
    return layout.padding.left + frac * layout.plotW;
  }

  function xToFrac(x, layout) {
    return Math.min(1, Math.max(0, (x - layout.padding.left) / layout.plotW));
  }

  function phaseIndexForFrac(frac, setup) {
    if (frac < setup.phaseSplit[0]) return 0;
    if (frac < setup.phaseSplit[1]) return 1;
    return 2;
  }

  function clampSplits(s0, s1, durationSec) {
    if (window.Simulator?.clampPhaseSplits) {
      return window.Simulator.clampPhaseSplits(s0, s1, durationSec);
    }
    const duration = Math.max(1, durationSec ?? 300);
    const minF = Math.min(1 / 3, 10 / duration);
    let a = Math.min(s0, s1);
    let b = Math.max(s0, s1);
    a = Math.max(minF, Math.min(1 - minF * 2, a));
    b = Math.max(a + minF, Math.min(1 - minF, b));
    return [a, b];
  }

  function drawChart() {
    if (!canvas || !draft?.setup || modal?.hidden) return;
    chartLayout = window.drawPriceChart(window.windowState ?? {}, {
      canvas,
      setupOverride: draft.setup,
      markers: false,
      hoverLine: hoveredPhaseLine,
      dragLine,
    });
  }

  function startRefresh() {
    stopRefresh();
    refreshTimer = setInterval(drawChart, CHART_REFRESH_MS);
  }

  function stopRefresh() {
    if (refreshTimer != null) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  function nearLine(x, layout, lineIndex, setup) {
    const lineX = fracToX(setup.phaseSplit[lineIndex], layout);
    return Math.abs(x - lineX) <= LINE_HIT_PX;
  }

  function hidePhaseHover() {
    if (phaseHoverEl) phaseHoverEl.hidden = true;
  }

  function updatePhaseHover(canvasX) {
    if (!phaseHoverEl || !chartLayout || !draft?.setup) return;
    const setup = draft.setup;
    if (!Number.isFinite(canvasX) || nearLine(canvasX, chartLayout, 0, setup) || nearLine(canvasX, chartLayout, 1, setup)) {
      hidePhaseHover();
      return;
    }
    const frac = xToFrac(canvasX, chartLayout);
    const phaseIdx = phaseIndexForFrac(frac, setup);
    const bounds = [0, setup.phaseSplit[0], setup.phaseSplit[1], 1];
    const x0 = fracToX(bounds[phaseIdx], chartLayout);
    const x1 = fracToX(bounds[phaseIdx + 1], chartLayout);
    phaseHoverEl.style.left = `${x0}px`;
    phaseHoverEl.style.top = `${chartLayout.padding.top}px`;
    phaseHoverEl.style.width = `${Math.max(0, x1 - x0)}px`;
    phaseHoverEl.style.height = `${chartLayout.plotH}px`;
    phaseHoverEl.style.background = PHASE_HOVER_COLOR;
    phaseHoverEl.hidden = false;
  }

  function snapshotDraft() {
    return {
      title: titleInput?.value?.trim() ?? "",
      description: descInput?.value?.trim() ?? "",
      color: colorInput?.value ?? draft?.color ?? "#58a6ff",
      setup: deepClone(draft.setup),
    };
  }

  function isDirty() {
    if (!draft || !baseline) return false;
    return JSON.stringify(snapshotDraft()) !== JSON.stringify(baseline);
  }

  function syncSaveState() {
    if (!saveBtn || !titleInput) return;
    const dirty = isDirty() && !!titleInput.value.trim();
    saveBtn.disabled = !dirty;
    saveBtn.setAttribute("aria-disabled", dirty ? "false" : "true");
  }

  function onDraftChange() {
    drawChart();
    syncSaveState();
  }

  async function persistDraftToMongo() {
    if (!editingId || !draft || persisting) return false;
    const title = titleInput?.value?.trim();
    if (!title) return false;

    persisting = true;
    try {
      const payload = snapshotDraft();
      const res = await fetch(`/api/trading-setups/${encodeURIComponent(editingId)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          title: payload.title,
          description: payload.description || null,
          color: payload.color,
          setup: payload.setup,
        }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(body.error || `Update failed (${res.status})`);
      }
      draft.title = body.title;
      draft.description = body.description ?? "";
      draft.color = body.color;
      draft.setup = deepClone(body.setup);
      titleInput.value = draft.title;
      descInput.value = draft.description;
      if (colorInput) colorInput.value = draft.color;
      baseline = deepClone(snapshotDraft());
      syncSaveState();

      if (window.onTradingSetupUpdated) {
        void window.onTradingSetupUpdated(body);
      }
      return true;
    } catch (err) {
      console.error(err);
      alert(err.message || "Failed to save setup");
      return false;
    } finally {
      persisting = false;
    }
  }

  function onColorInput() {
    if (!draft || !colorInput || !editingId) return;
    const color = colorInput.value;
    draft.color = color;
    if (window.applySetupColorUpdate) window.applySetupColorUpdate(editingId, color);
    syncSaveState();
  }

  function beginExternalEditing() {
    if (!window.Simulator?.beginExternalPhaseEdit || !draft?.setup) return;
    window.Simulator.beginExternalPhaseEdit(draft.setup, onDraftChange);
  }

  function bindCanvas() {
    if (!canvas) return;
    canvas.addEventListener("mousedown", (e) => {
      if (!chartLayout || !draft?.setup) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      dragMoved = false;
      if (nearLine(x, chartLayout, 0, draft.setup)) dragLine = 0;
      else if (nearLine(x, chartLayout, 1, draft.setup)) dragLine = 1;
      else dragLine = null;
      if (dragLine != null) canvas.style.cursor = "col-resize";
    });

    canvas.addEventListener("mousemove", (e) => {
      if (!chartLayout || !draft?.setup) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (dragLine != null) {
        dragMoved = true;
        hidePhaseHover();
        const frac = xToFrac(x, chartLayout);
        const splits = [...draft.setup.phaseSplit];
        splits[dragLine] = frac;
        draft.setup.phaseSplit = clampSplits(splits[0], splits[1], chartLayout.duration);
        onDraftChange();
        return;
      }
      const onLine = nearLine(x, chartLayout, 0, draft.setup) || nearLine(x, chartLayout, 1, draft.setup);
      let nextHover = null;
      if (onLine) {
        if (nearLine(x, chartLayout, 0, draft.setup)) nextHover = 0;
        else if (nearLine(x, chartLayout, 1, draft.setup)) nextHover = 1;
      }
      if (onLine) hidePhaseHover();
      else updatePhaseHover(x);
      if (nextHover !== hoveredPhaseLine) {
        hoveredPhaseLine = nextHover;
        drawChart();
      }
      canvas.style.cursor = onLine ? "col-resize" : "pointer";
    });

    canvas.addEventListener("mouseup", (e) => {
      if (!chartLayout || !draft?.setup) return;
      const rect = canvas.getBoundingClientRect();
      const x = e.clientX - rect.left;
      if (dragLine == null && !dragMoved) {
        if (!nearLine(x, chartLayout, 0, draft.setup) && !nearLine(x, chartLayout, 1, draft.setup)) {
          const idx = phaseIndexForFrac(xToFrac(x, chartLayout), draft.setup);
          if (window.Simulator?.openPhaseModalExternal) {
            window.Simulator.openPhaseModalExternal(idx);
          }
        }
      }
      dragLine = null;
      canvas.style.cursor = "pointer";
    });

    canvas.addEventListener("mouseleave", () => {
      dragLine = null;
      hoveredPhaseLine = null;
      hidePhaseHover();
      drawChart();
      canvas.style.cursor = "default";
    });
  }

  function open(setup) {
    if (!modal || !titleInput || !descInput) return;
    editingId = setup._id;
    draft = {
      title: setup.title,
      description: setup.description ?? "",
      color: setup.color || "#58a6ff",
      setup: deepClone(setup.setup ?? defaultSetup()),
    };
    titleInput.value = draft.title;
    descInput.value = draft.description;
    if (colorInput) colorInput.value = draft.color;
    baseline = deepClone(snapshotDraft());
    modal.hidden = false;
    saveBtn.disabled = true;
    saveBtn.setAttribute("aria-disabled", "true");
    beginExternalEditing();
    startRefresh();
    requestAnimationFrame(() => {
      drawChart();
      syncSaveState();
    });
  }

  function close() {
    stopRefresh();
    if (editingId && baseline?.color && window.applySetupColorUpdate) {
      const current = colorInput?.value ?? draft?.color;
      if (current !== baseline.color) {
        window.applySetupColorUpdate(editingId, baseline.color);
      }
    }
    if (window.Simulator?.endExternalPhaseEdit) window.Simulator.endExternalPhaseEdit();
    const phaseModal = document.getElementById("phase-modal");
    if (phaseModal) {
      phaseModal.hidden = true;
      phaseModal.setAttribute("hidden", "");
    }
    if (modal) {
      modal.hidden = true;
      modal.setAttribute("hidden", "");
    }
    editingId = null;
    draft = null;
    baseline = null;
    chartLayout = null;
    hidePhaseHover();
  }

  function refreshChart() {
    if (!modal?.hidden) drawChart();
  }

  async function save() {
    if (!editingId || !isDirty() || !titleInput?.value.trim()) return;
    const ok = await persistDraftToMongo();
    if (ok) close();
  }

  function init() {
    modal = $("setup-edit-modal");
    titleInput = $("setup-edit-title");
    descInput = $("setup-edit-description");
    colorInput = $("setup-edit-color");
    saveBtn = $("setup-edit-save");
    canvas = $("setup-edit-chart");
    chartWrap = canvas?.parentElement ?? null;
    phaseHoverEl = $("setup-edit-phase-hover");

    $("setup-edit-modal-close")?.addEventListener("click", close);
    $("setup-edit-cancel")?.addEventListener("click", close);
    saveBtn?.addEventListener("click", () => void save());
    titleInput?.addEventListener("input", syncSaveState);
    descInput?.addEventListener("input", syncSaveState);
    colorInput?.addEventListener("input", onColorInput);
    colorInput?.addEventListener("change", onColorInput);
    modal?.addEventListener("click", (e) => {
      if (e.target.id === "setup-edit-modal") close();
    });
    window.addEventListener("resize", refreshChart);

    if (chartWrap && window.ResizeObserver) {
      resizeObserver = new ResizeObserver(() => refreshChart());
      resizeObserver.observe(chartWrap);
    }

    bindCanvas();
  }

  window.SetupEditor = {
    init,
    open,
    close,
    isDirty,
    refreshChart,
  };
})();
