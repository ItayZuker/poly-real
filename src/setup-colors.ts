export const SETUP_COLOR_PALETTE = [
  "#58a6ff",
  "#3fb950",
  "#f85149",
  "#d29922",
  "#bc8cff",
  "#39d353",
  "#ff7b72",
  "#79c0ff",
  "#e3b341",
  "#56d364",
  "#ffa657",
  "#a371f7",
  "#7ee787",
  "#ff9492",
  "#6cb6ff",
  "#f0883e",
  "#d2a8ff",
  "#4ac26b",
  "#ffb77c",
  "#db61a2",
];

export function normalizeSetupColor(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const s = value.trim();
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase();
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    const r = s[1];
    const g = s[2];
    const b = s[3];
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  return null;
}

function hslToHex(h: number, s: number, l: number): string {
  const sat = s / 100;
  const lit = l / 100;
  const k = (n: number) => (n + h / 30) % 12;
  const a = sat * Math.min(lit, 1 - lit);
  const f = (n: number) => lit - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  const r = Math.round(255 * f(0));
  const g = Math.round(255 * f(8));
  const b = Math.round(255 * f(4));
  return `#${[r, g, b].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
}

export function colorFromId(id: string): string {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
  }
  return hslToHex(hash % 360, 62, 52);
}

export function pickUniqueSetupColor(usedColors: Set<string>, index: number): string {
  for (const color of SETUP_COLOR_PALETTE) {
    const normalized = color.toLowerCase();
    if (!usedColors.has(normalized)) return normalized;
  }
  return hslToHex((index * 137.508) % 360, 62, 52);
}
