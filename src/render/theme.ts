// Futurist design tokens for ASL's rendered surfaces (asl-ec7 slice A).
// Single home for the palette and the per-status color mapping; html.ts and
// digest.ts adopt these in later slices — importing this file changes nothing.
//
// The upstream system (futurist-design-system) publishes colors as oklch only
// (tokens/colors.css); email clients need hex, so COLORS_HEX carries sRGB
// conversions of every color token, light and dark (§8 Q7: this table is the
// one owner of the conversion and lands upstream as tokens/colors.hex.json).
// Values follow the asl-ec7 proposal §1/§3 and are re-derived executably:
// tests/helpers/futurist-oklch.ts vendors the upstream oklch source values and
// tests/theme.test.ts asserts every hex here equals its oklch→sRGB conversion.
// One proposal typo corrected in place: dark --bg-3 is #272a30, not #26292f.

import type { Status } from "../types";

export interface HexPair {
  readonly light: string;
  readonly dark: string;
}

// Every color token in tokens/colors.css, keyed by its upstream custom-property
// name. 8-digit entries carry the token's alpha (ring/scrim/overlay).
// Semantic aliases (--surface-card etc.) are var() indirections upstream, not
// colors, so they are deliberately absent.
export const COLORS_HEX = {
  "--bg-0": { light: "#f9fafb", dark: "#0f1114" },
  "--bg-1": { light: "#ffffff", dark: "#15171c" },
  "--bg-2": { light: "#f4f6f8", dark: "#1e2126" },
  "--bg-3": { light: "#edeff1", dark: "#272a30" },
  "--bg-inverse": { light: "#171b20", dark: "#f0f2f4" },
  "--surface-overlay": { light: "#ffffffd1", dark: "#15171cd1" },
  "--scrim": { light: "#11161f73", dark: "#06070b99" },
  "--border-1": { light: "#e2e4e7", dark: "#2b2e34" },
  "--border-2": { light: "#d0d3d7", dark: "#3d4149" },
  "--border-3": { light: "#babec4", dark: "#50555e" },
  "--stroke-inverse": { light: "#ffffff14", dark: "#0000001a" },
  "--fg-1": { light: "#1b1e24", dark: "#f2f3f5" },
  "--fg-2": { light: "#4e5157", dark: "#bbbec3" },
  "--fg-3": { light: "#6d7075", dark: "#8d9197" },
  "--fg-4": { light: "#a1a3a7", dark: "#65696f" },
  "--fg-inverse": { light: "#f4f5f7", dark: "#171b20" },
  "--accent": { light: "#33d58e", dark: "#36de95" },
  "--accent-hover": { light: "#00c57e", dark: "#5aeba6" },
  "--accent-active": { light: "#00b56f", dark: "#11cd85" },
  "--accent-fg": { light: "#042113", dark: "#001d0d" },
  "--accent-subtle": { light: "#d2fce3", dark: "#004126" },
  "--accent-subtle-fg": { light: "#00703f", dark: "#7be8af" },
  "--accent-ring": { light: "#33d58e66", dark: "#36de9573" },
  "--success": { light: "#00805a", dark: "#23b189" },
  "--success-fg": { light: "#fafcfe", dark: "#05100c" },
  "--success-subtle": { light: "#dbf8ec", dark: "#083c2d" },
  "--success-subtle-fg": { light: "#006646", dark: "#6fd5b0" },
  "--warning": { light: "#da950b", dark: "#ebaa2d" },
  // --warning-fg is dark ink, not white: white-on-amber fails AA (colors.css:45).
  "--warning-fg": { light: "#2a2011", dark: "#1d1406" },
  "--warning-subtle": { light: "#ffefd1", dark: "#4c3211" },
  "--warning-subtle-fg": { light: "#934f00", dark: "#efba64" },
  "--danger": { light: "#d23934", dark: "#e95048" },
  "--danger-fg": { light: "#fafcfe", dark: "#150a09" },
  "--danger-subtle": { light: "#ffeae6", dark: "#57221e" },
  "--danger-subtle-fg": { light: "#b02b27", dark: "#ff988c" },
  "--info": { light: "#0079b5", dark: "#3ca2e0" },
  "--info-fg": { light: "#fafcfe", dark: "#060e15" },
  "--info-subtle": { light: "#dcf4ff", dark: "#10364e" },
  "--info-subtle-fg": { light: "#005e93", dark: "#78c7fd" },
  "--viz-1": { light: "#3076da", dark: "#5598f9" },
  "--viz-2": { light: "#00a887", dark: "#00c0a0" },
  "--viz-3": { light: "#909c00", dark: "#abb836" },
  "--viz-4": { light: "#b051c5", dark: "#c571d8" },
  "--viz-5": { light: "#c8387e", dark: "#e25a98" },
  "--viz-6": { light: "#00a2b7", dark: "#1db8ce" },
  "--control-knob": { light: "#ffffff", dark: "#f0f2f4" },
} as const satisfies Record<string, HexPair>;

// ── Typography / spacing / radius (tokens/typography.css, spacing.css, radius.css) ──

export const FONT_SANS =
  '"Atkinson Hyperlegible Next", "Atkinson Hyperlegible", -apple-system, BlinkMacSystemFont, system-ui, "Segoe UI", sans-serif';
export const FONT_MONO = '"IBM Plex Mono", ui-monospace, "SF Mono", Menlo, monospace';

export const TEXT_SCALE = {
  "--text-2xs": "0.6875rem", // 11px — badges, mono eyebrows
  "--text-xs": "0.75rem",
  "--text-sm": "0.8125rem", // 13px — tables/controls
  "--text-base": "0.875rem", // 14px — default UI/body
  "--text-md": "0.9375rem",
  "--text-lg": "1.0625rem", // 17px — title role
  "--text-xl": "1.25rem",
  "--text-2xl": "1.5rem", // 24px — headline role
} as const satisfies Record<string, string>;

export const WEIGHT = {
  "--weight-regular": 400,
  "--weight-medium": 500,
  "--weight-semibold": 600,
} as const satisfies Record<string, number>;
export const LEADING = {
  "--leading-tight": 1.15,
  "--leading-snug": 1.3,
  "--leading-normal": 1.5,
} as const satisfies Record<string, number>;
export const TRACKING = {
  "--tracking-tight": "-0.011em", // headings
  "--tracking-caps": "0.08em", // mono eyebrows / labels
} as const satisfies Record<string, string>;

export const SPACING = {
  "--space-1": "4px",
  "--space-2": "8px",
  "--space-3": "12px",
  "--space-4": "16px",
  "--space-5": "20px",
  "--space-6": "24px",
  "--space-8": "32px",
  "--gutter": "24px",
  "--card-pad": "20px",
  "--max-content": "1200px",
  "--max-prose": "680px",
} as const satisfies Record<string, string>;

export const RADIUS = {
  "--radius-sm": "3px", // badges
  "--radius-md": "5px", // controls
  "--radius-lg": "8px", // cards
  "--radius-full": "999px",
} as const satisfies Record<string, string>;

// ── Per-status color mapping (proposal §3 as amended by §8) ──
//
// Statuses map to token NAMES, not colors: html.ts emits `var(--token)` from
// the same names the digest resolves to hex (statusCssVars / statusHex below),
// so the two surfaces cannot diverge — the drift the upstream Token Contract
// Rule (DESIGN.md §2) names.

export type ColorRole = "danger" | "warning" | "success" | "info" | "neutral" | "accent";
export type DotStyle = "filled" | "hollow";
export type ColorToken = keyof typeof COLORS_HEX;
/** Badge background: a palette token, or none at all. */
export type BgToken = ColorToken | "transparent";

export interface StatusColor {
  readonly role: ColorRole;
  readonly dot: DotStyle;
  readonly bgToken: BgToken;
  readonly fgToken: ColorToken;
  /** Dot / non-text graphic token. Not for text: solid hues fail AA as ink. */
  readonly dotToken: ColorToken;
}

// Semantic roles use their `-subtle` pair with the solid hue as dot.
function fromRole(role: "danger" | "warning" | "success" | "info") {
  return {
    bgToken: `--${role}-subtle`,
    fgToken: `--${role}-subtle-fg`,
    dotToken: `--${role}`,
  } as const;
}

export const STATUS_COLORS: Record<Status, StatusColor> = {
  failed: { role: "danger", dot: "filled", ...fromRole("danger") },
  // §8 Q2: silent reads as caution (may or may not be an issue) — warning
  // amber with a hollow dot (absence of signal), not danger red. Display hue
  // only: STATUS_SEVERITY.silent stays "urgent" and the exception partition
  // is unchanged.
  silent: { role: "warning", dot: "hollow", ...fromRole("warning") },
  blocked: { role: "warning", dot: "filled", ...fromRole("warning") },
  // §8 Q3: warning amber, no semantic drift toward info blue.
  needs_human: { role: "warning", dot: "filled", ...fromRole("warning") },
  // One Signal Rule (DESIGN.md §2): Signal Green marks live state via the dot
  // only, never a filled badge — the word is body ink on a TRANSPARENT bg
  // ("a small colored dot plus a word, not a filled pill", DESIGN.md §5).
  active: { role: "accent", dot: "filled", bgToken: "transparent", fgToken: "--fg-2", dotToken: "--accent" },
  idle: { role: "neutral", dot: "filled", bgToken: "--bg-3", fgToken: "--fg-2", dotToken: "--fg-3" },
  completed: { role: "success", dot: "filled", ...fromRole("success") },
};

export interface ResolvedStatusColor {
  readonly bg: string;
  readonly fg: string;
  readonly dot: string;
}

/** `var(--token)` emission for surfaces with a stylesheet (src/render/html.ts). */
export function statusCssVars(c: StatusColor): ResolvedStatusColor {
  const bg = c.bgToken === "transparent" ? "transparent" : `var(${c.bgToken})`;
  return { bg, fg: `var(${c.fgToken})`, dot: `var(${c.dotToken})` };
}

/**
 * `light-dark()` emission for chrome without a stylesheet of tokens — the
 * third emission mode alongside statusCssVars (var() references) and
 * statusHex (concrete single-theme hex).
 */
export function hexLightDark(token: ColorToken): string {
  return `light-dark(${COLORS_HEX[token].light}, ${COLORS_HEX[token].dark})`;
}

/** Concrete hex for inline-style surfaces — the email digest ships light only (§8 Q8). */
export function statusHex(c: StatusColor, theme: "light" | "dark" = "light"): ResolvedStatusColor {
  const bg = c.bgToken === "transparent" ? "transparent" : COLORS_HEX[c.bgToken][theme];
  return { bg, fg: COLORS_HEX[c.fgToken][theme], dot: COLORS_HEX[c.dotToken][theme] };
}
