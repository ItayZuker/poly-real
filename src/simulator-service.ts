import { SimulatorEngine } from "./simulator-engine.js";
import { clampPhaseSplits } from "./phase-split.js";
import { DEFAULT_CRYPTO_TAKER_FEE_PARAMS } from "./taker-fee.js";
import type { LiveWindowState, SimPhaseConfig, SimPublicState, SimSetup, TradingPhaseSetup } from "./types.js";

export function defaultPhaseConfig(): SimPhaseConfig {
  return {
    buyEnabled: true,
    buyShares: 10,
    buyTrigger: 40,
    buyOptimize: 5,
    sellProfitCents: 20,
    sellOptimize: 5,
  };
}

export function defaultSimSetup(): SimSetup {
  return {
    phaseSplit: [1 / 3, 2 / 3],
    phases: [defaultPhaseConfig(), defaultPhaseConfig(), defaultPhaseConfig()],
    latencyMs: 150,
    feeParams: { ...DEFAULT_CRYPTO_TAKER_FEE_PARAMS },
  };
}

function normalizeSetup(input: SimSetup, durationSec?: number): SimSetup {
  const phases = input.phases.map((p) => ({
    buyEnabled: Boolean(p.buyEnabled),
    buyShares: Math.max(1, Math.floor(p.buyShares) || 10),
    buyTrigger: Math.max(1, Math.min(99, Math.floor(p.buyTrigger) || 40)),
    buyOptimize: Math.max(0, Math.min(50, Math.floor(p.buyOptimize) || 0)),
    sellProfitCents: Math.max(1, Math.min(99, Math.floor(p.sellProfitCents) || 20)),
    sellOptimize: Math.max(0, Math.min(50, Math.floor(p.sellOptimize) || 0)),
  })) as [SimPhaseConfig, SimPhaseConfig, SimPhaseConfig];

  const split = clampPhaseSplits(input.phaseSplit[0], input.phaseSplit[1], durationSec);
  const latencyMs = Math.max(0, Math.min(2000, Math.floor(input.latencyMs ?? 150)));
  const feeParams = input.feeParams ?? DEFAULT_CRYPTO_TAKER_FEE_PARAMS;
  return {
    phaseSplit: split,
    phases,
    latencyMs,
    feeParams: {
      feeRate: feeParams.feeRate,
      feeExponent: feeParams.feeExponent,
    },
  };
}

export function phaseSetupToSimSetup(
  setup: TradingPhaseSetup,
  latencyMs: number,
  durationSec?: number,
): SimSetup {
  return normalizeSetup(
    {
      phaseSplit: setup.phaseSplit,
      phases: setup.phases,
      latencyMs,
    },
    durationSec,
  );
}

/** Singleton simulator — ticks on every live quote update. */
export class SimulatorService {
  private setup: SimSetup = defaultSimSetup();
  private readonly engine = new SimulatorEngine();

  getSetup(): SimSetup {
    return {
      phaseSplit: [...this.setup.phaseSplit] as [number, number],
      phases: this.setup.phases.map((p) => ({ ...p })) as SimSetup["phases"],
      latencyMs: this.setup.latencyMs,
      feeParams: this.setup.feeParams ? { ...this.setup.feeParams } : undefined,
    };
  }

  setFeeParams(feeParams: SimSetup["feeParams"]): void {
    if (!feeParams) return;
    this.setup.feeParams = {
      feeRate: feeParams.feeRate,
      feeExponent: feeParams.feeExponent,
    };
  }

  getPhaseSetup(): TradingPhaseSetup {
    const setup = this.getSetup();
    return {
      phaseSplit: setup.phaseSplit,
      phases: setup.phases,
    };
  }

  setSetup(setup: SimSetup, durationSec?: number): SimSetup {
    this.setup = normalizeSetup(setup, durationSec);
    return this.getSetup();
  }

  patchSetup(patch: Partial<SimSetup>, durationSec?: number): SimSetup {
    const next: SimSetup = {
      phaseSplit: patch.phaseSplit
        ? clampPhaseSplits(patch.phaseSplit[0], patch.phaseSplit[1], durationSec)
        : [...this.setup.phaseSplit] as [number, number],
      phases: (patch.phases
        ? patch.phases.map((p, i) => ({ ...this.setup.phases[i], ...p }))
        : this.setup.phases) as SimSetup["phases"],
      latencyMs: patch.latencyMs ?? this.setup.latencyMs,
      feeParams: patch.feeParams ?? this.setup.feeParams,
    };
    return this.setSetup(next, durationSec);
  }

  tick(state: LiveWindowState, nowMs?: number): void {
    this.engine.tick(state, this.setup, nowMs);
  }

  getPublicState(): SimPublicState {
    return {
      setup: this.getSetup(),
      markers: this.engine.getMarkers(),
      quoteLocks: this.engine.getQuoteLocks(),
      lastWindow: this.engine.getLastWindow(),
    };
  }
}

export const simulatorService = new SimulatorService();
