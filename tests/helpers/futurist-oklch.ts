// Vendored oklch source values for every color token in the upstream Futurist
// design system (futurist-design-system/tokens/colors.css — :root light block
// and the [data-theme="dark"] override block), plus a dependency-free
// oklch→sRGB converter. tests/theme.test.ts re-derives all 92 hex values in
// src/render/theme.ts COLORS_HEX from this map and asserts exact equality, so
// upstream drift or a fat-fingered hex fails loudly. Test-only: nothing in src
// imports this.

export type Oklch = readonly [l: number, c: number, h: number, alpha?: number];

export const COLORS_OKLCH = {
  "--bg-0": { light: [0.985, 0.002, 255], dark: [0.175, 0.008, 262] },
  "--bg-1": { light: [1, 0, 0], dark: [0.205, 0.01, 262] },
  "--bg-2": { light: [0.972, 0.003, 255], dark: [0.245, 0.011, 262] },
  "--bg-3": { light: [0.951, 0.004, 255], dark: [0.285, 0.012, 262] },
  "--bg-inverse": { light: [0.22, 0.012, 260], dark: [0.96, 0.004, 255] },
  "--surface-overlay": { light: [1, 0, 0, 0.82], dark: [0.205, 0.01, 262, 0.82] },
  "--scrim": { light: [0.2, 0.02, 262, 0.45], dark: [0.13, 0.01, 262, 0.6] },
  "--border-1": { light: [0.918, 0.005, 255], dark: [0.3, 0.012, 262] },
  "--border-2": { light: [0.865, 0.007, 255], dark: [0.375, 0.014, 262] },
  "--border-3": { light: [0.8, 0.009, 255], dark: [0.45, 0.016, 262] },
  "--stroke-inverse": { light: [1, 0, 0, 0.08], dark: [0, 0, 0, 0.1] },
  "--fg-1": { light: [0.235, 0.012, 262], dark: [0.965, 0.003, 258] },
  "--fg-2": { light: [0.435, 0.011, 262], dark: [0.8, 0.008, 258] },
  "--fg-3": { light: [0.545, 0.009, 262], dark: [0.655, 0.01, 260] },
  "--fg-4": { light: [0.715, 0.007, 262], dark: [0.52, 0.011, 260] },
  "--fg-inverse": { light: [0.97, 0.003, 255], dark: [0.22, 0.012, 260] },
  "--accent": { light: [0.775, 0.165, 159], dark: [0.8, 0.17, 159] },
  "--accent-hover": { light: [0.725, 0.17, 159], dark: [0.845, 0.16, 159] },
  "--accent-active": { light: [0.675, 0.17, 159], dark: [0.75, 0.17, 159] },
  "--accent-fg": { light: [0.22, 0.045, 159], dark: [0.2, 0.05, 159] },
  "--accent-subtle": { light: [0.955, 0.055, 159], dark: [0.33, 0.08, 159] },
  "--accent-subtle-fg": { light: [0.47, 0.13, 159], dark: [0.85, 0.13, 159] },
  "--accent-ring": { light: [0.775, 0.165, 159, 0.4], dark: [0.8, 0.17, 159, 0.45] },
  "--success": { light: [0.52, 0.13, 168], dark: [0.68, 0.13, 168] },
  "--success-fg": { light: [0.99, 0.003, 255], dark: [0.16, 0.02, 168] },
  "--success-subtle": { light: [0.955, 0.035, 168], dark: [0.32, 0.06, 168] },
  "--success-subtle-fg": { light: [0.44, 0.115, 168], dark: [0.8, 0.11, 168] },
  "--warning": { light: [0.72, 0.15, 75], dark: [0.78, 0.15, 78] },
  "--warning-fg": { light: [0.25, 0.03, 75], dark: [0.2, 0.03, 78] },
  "--warning-subtle": { light: [0.96, 0.045, 78], dark: [0.34, 0.06, 70] },
  "--warning-subtle-fg": { light: [0.5, 0.12, 60], dark: [0.82, 0.12, 78] },
  "--danger": { light: [0.575, 0.19, 27], dark: [0.64, 0.19, 27] },
  "--danger-fg": { light: [0.99, 0.003, 255], dark: [0.16, 0.02, 27] },
  "--danger-subtle": { light: [0.958, 0.03, 27], dark: [0.33, 0.08, 27] },
  "--danger-subtle-fg": { light: [0.5, 0.17, 27], dark: [0.8, 0.14, 27] },
  "--info": { light: [0.55, 0.13, 240], dark: [0.68, 0.13, 240] },
  "--info-fg": { light: [0.99, 0.003, 255], dark: [0.16, 0.02, 240] },
  "--info-subtle": { light: [0.955, 0.035, 240], dark: [0.32, 0.06, 240] },
  "--info-subtle-fg": { light: [0.46, 0.12, 240], dark: [0.8, 0.11, 240] },
  "--viz-1": { light: [0.575, 0.168, 258], dark: [0.68, 0.16, 258] },
  "--viz-2": { light: [0.64, 0.15, 175], dark: [0.72, 0.14, 175] },
  "--viz-3": { light: [0.66, 0.15, 115], dark: [0.75, 0.15, 115] },
  "--viz-4": { light: [0.6, 0.19, 320], dark: [0.68, 0.17, 320] },
  "--viz-5": { light: [0.575, 0.19, 355], dark: [0.66, 0.18, 355] },
  "--viz-6": { light: [0.65, 0.12, 210], dark: [0.72, 0.12, 210] },
  "--control-knob": { light: [1, 0, 0], dark: [0.96, 0.004, 255] },
} as const satisfies Record<string, { light: Oklch; dark: Oklch }>;

// oklch → sRGB hex. Pipeline: polar→oklab, oklab→LMS→linear sRGB (matrices
// from Björn Ottosson's oklab reference implementation), clip each linear
// channel to [0,1] (gamut clip), sRGB gamma encode, round to a byte. An alpha
// component becomes a trailing rounded alpha byte (8-digit hex).
export function oklchToHex([L, C, H, alpha]: Oklch): string {
  const a = C * Math.cos((H * Math.PI) / 180);
  const b = C * Math.sin((H * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const bytes = [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ].map((lin) => {
    const clipped = Math.min(1, Math.max(0, lin));
    const srgb = clipped <= 0.0031308 ? 12.92 * clipped : 1.055 * clipped ** (1 / 2.4) - 0.055;
    return Math.round(srgb * 255);
  });
  if (alpha !== undefined) bytes.push(Math.round(alpha * 255));
  return `#${bytes.map((v) => v.toString(16).padStart(2, "0")).join("")}`;
}
