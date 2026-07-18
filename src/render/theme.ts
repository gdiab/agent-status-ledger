// Futurist design tokens for ASL's rendered surfaces (asl-ec7 slice A).
// Single home for the palette and the per-status color mapping; html.ts and
// digest.ts adopt these in later slices — importing this file changes nothing.
//
// The upstream system (futurist-design-system) publishes colors as oklch only
// (tokens/colors.css); email clients need hex, so COLORS_HEX carries sRGB
// conversions of every color token, light and dark (§8 Q7: this table is the
// one owner of the conversion and lands upstream as tokens/colors.hex.json).
// Values follow the asl-ec7 proposal §1/§3, cross-checked with an independent
// oklch→sRGB implementation (culori). One proposal typo corrected: dark
// --bg-3 is #272a30, not #26292f.

import type { Severity, Status } from "../types";
import { STATUS_RANK, STATUS_SEVERITY } from "../status";

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

export const WEIGHT = { regular: 400, medium: 500, semibold: 600 } as const;
export const LEADING = { tight: 1.15, snug: 1.3, normal: 1.5 } as const;
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

export type ColorRole = "danger" | "warning" | "success" | "info" | "neutral" | "accent";
export type DotStyle = "filled" | "hollow";

export interface ThemedPair {
  readonly bg: string;
  readonly fg: string;
}

export interface StatusColor {
  readonly role: ColorRole;
  readonly dot: DotStyle;
  /** Dot / non-text graphic color. Not for text: solid hues fail AA as ink. */
  readonly solid: HexPair;
  /** Badge tint pair (`-subtle` bg + `-subtle-fg` text) — AA in both themes. */
  readonly subtle: { readonly light: ThemedPair; readonly dark: ThemedPair };
}

// Roles resolve through COLORS_HEX so the palette has one source; a drifted
// hex here would be the "hardcoded values are drift" failure the upstream
// Token Contract Rule (DESIGN.md §2) names.
function fromRole(role: "danger" | "warning" | "success" | "info") {
  const subtle = COLORS_HEX[`--${role}-subtle`];
  const subtleFg = COLORS_HEX[`--${role}-subtle-fg`];
  return {
    solid: COLORS_HEX[`--${role}`],
    subtle: {
      light: { bg: subtle.light, fg: subtleFg.light },
      dark: { bg: subtle.dark, fg: subtleFg.dark },
    },
  };
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
  // only, never a filled badge — the word is body ink on the card surface.
  active: {
    role: "accent",
    dot: "filled",
    solid: COLORS_HEX["--accent"],
    subtle: {
      light: { bg: COLORS_HEX["--bg-1"].light, fg: COLORS_HEX["--fg-2"].light },
      dark: { bg: COLORS_HEX["--bg-1"].dark, fg: COLORS_HEX["--fg-2"].dark },
    },
  },
  idle: {
    role: "neutral",
    dot: "filled",
    solid: COLORS_HEX["--fg-3"],
    subtle: {
      light: { bg: COLORS_HEX["--bg-3"].light, fg: COLORS_HEX["--fg-2"].light },
      dark: { bg: COLORS_HEX["--bg-3"].dark, fg: COLORS_HEX["--fg-2"].dark },
    },
  },
  completed: { role: "success", dot: "filled", ...fromRole("success") },
};

// Severity fallback for surfaces that only know severity: each severity shows
// its worst-ranked status's colors. Derived from STATUS_SEVERITY + STATUS_RANK
// (the EXCEPTION_STATUSES idiom in src/status.ts) — iterating best-first so
// the worst rank writes last; a new Status folds in without edits here.
export const SEVERITY_COLORS: Record<Severity, StatusColor> = (
  Object.keys(STATUS_SEVERITY) as Status[]
)
  .sort((a, b) => STATUS_RANK[b] - STATUS_RANK[a])
  .reduce(
    (acc, s) => {
      acc[STATUS_SEVERITY[s]] = STATUS_COLORS[s];
      return acc;
    },
    {} as Record<Severity, StatusColor>,
  );
