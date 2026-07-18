import { describe, expect, test } from "bun:test";
import { STATUS_SEVERITY } from "../src/status";
import type { Status } from "../src/types";
import {
  COLORS_HEX,
  LEADING,
  RADIUS,
  SPACING,
  STATUS_COLORS,
  statusCssVars,
  statusHex,
  TEXT_SCALE,
  WEIGHT,
} from "../src/render/theme";
import { COLORS_OKLCH, oklchToHex } from "./helpers/futurist-oklch";

const STATUSES = Object.keys(STATUS_SEVERITY) as Status[];
const HEX6 = /^#[0-9a-f]{6}$/; // opaque sRGB, lowercase
const HEX = /^#[0-9a-f]{6}(?:[0-9a-f]{2})?$/; // 8-digit allowed only in the raw token table (ring/scrim alphas)

describe("COLORS_HEX token table", () => {
  test("every token has valid light and dark hex", () => {
    const names = Object.keys(COLORS_HEX);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) {
      const pair = COLORS_HEX[name as keyof typeof COLORS_HEX];
      expect(pair.light).toMatch(HEX);
      expect(pair.dark).toMatch(HEX);
    }
  });

  test("token names are exactly the upstream custom-property set", () => {
    for (const name of Object.keys(COLORS_HEX)) expect(name).toMatch(/^--[a-z0-9-]+$/);
    // The vendored oklch map mirrors upstream tokens/colors.css token for
    // token — a missing, extra, or renamed token fails here.
    expect(Object.keys(COLORS_HEX).sort()).toEqual(Object.keys(COLORS_OKLCH).sort());
  });

  test("every hex value re-derives from the vendored upstream oklch source", () => {
    // 46 tokens × 2 themes = 92 values, alpha bytes included. Exact equality:
    // upstream drift or a fat-fingered hex fails loudly.
    for (const name of Object.keys(COLORS_OKLCH) as (keyof typeof COLORS_OKLCH)[]) {
      const pair = COLORS_HEX[name];
      expect(`${name} light ${pair.light}`).toBe(`${name} light ${oklchToHex(COLORS_OKLCH[name].light)}`);
      expect(`${name} dark ${pair.dark}`).toBe(`${name} dark ${oklchToHex(COLORS_OKLCH[name].dark)}`);
    }
  });

  test("exactly the ring/scrim/overlay tokens carry alpha bytes", () => {
    const ALPHA_TOKENS = ["--surface-overlay", "--scrim", "--stroke-inverse", "--accent-ring"];
    const HEX8 = /^#[0-9a-f]{8}$/;
    for (const [name, pair] of Object.entries(COLORS_HEX)) {
      const expected = ALPHA_TOKENS.includes(name) ? HEX8 : HEX6;
      expect(pair.light).toMatch(expected);
      expect(pair.dark).toMatch(expected);
    }
  });

  test("anchor values pin the oklch-to-sRGB derivation", () => {
    // Spot values from the asl-ec7 proposal (§1/§3), cross-checked against culori.
    expect(COLORS_HEX["--accent"].light).toBe("#33d58e");
    expect(COLORS_HEX["--danger"]).toEqual({ light: "#d23934", dark: "#e95048" });
    expect(COLORS_HEX["--warning"].light).toBe("#da950b");
    expect(COLORS_HEX["--success"].light).toBe("#00805a");
    expect(COLORS_HEX["--info"].light).toBe("#0079b5");
    expect(COLORS_HEX["--bg-0"]).toEqual({ light: "#f9fafb", dark: "#0f1114" });
    expect(COLORS_HEX["--danger-subtle-fg"]).toEqual({ light: "#b02b27", dark: "#ff988c" });
  });
});

describe("STATUS_COLORS", () => {
  test("is exhaustive over Status at runtime", () => {
    expect(Object.keys(STATUS_COLORS).sort()).toEqual([...STATUSES].sort());
  });

  test("every status carries palette token names (bg may opt out as transparent)", () => {
    const tokens = Object.keys(COLORS_HEX);
    for (const status of STATUSES) {
      const c = STATUS_COLORS[status];
      expect(c.bgToken === "transparent" || tokens.includes(c.bgToken)).toBe(true);
      expect(tokens).toContain(c.fgToken);
      expect(tokens).toContain(c.dotToken);
    }
  });

  test("statusHex resolves every status to opaque hex (or transparent bg) in both themes", () => {
    for (const status of STATUSES) {
      const c = STATUS_COLORS[status];
      for (const theme of ["light", "dark"] as const) {
        const r = statusHex(c, theme);
        if (c.bgToken !== "transparent") expect(r.bg).toMatch(HEX6);
        else expect(r.bg).toBe("transparent");
        expect(r.fg).toMatch(HEX6);
        expect(r.dot).toMatch(HEX6);
      }
    }
  });

  test("statusHex defaults to the light theme (the digest's, §8 Q8)", () => {
    expect(statusHex(STATUS_COLORS.failed)).toEqual(statusHex(STATUS_COLORS.failed, "light"));
    expect(statusHex(STATUS_COLORS.failed).dot).toBe(COLORS_HEX["--danger"].light);
  });

  test("statusCssVars emits var() of the SAME token names statusHex resolves — one mapping, two surfaces", () => {
    for (const status of STATUSES) {
      const c = STATUS_COLORS[status];
      const v = statusCssVars(c);
      expect(v.bg).toBe(c.bgToken === "transparent" ? "transparent" : `var(${c.bgToken})`);
      expect(v.fg).toBe(`var(${c.fgToken})`);
      expect(v.dot).toBe(`var(${c.dotToken})`);
      for (const theme of ["light", "dark"] as const) {
        const h = statusHex(c, theme);
        if (c.bgToken !== "transparent") expect(h.bg).toBe(COLORS_HEX[c.bgToken][theme]);
        expect(h.fg).toBe(COLORS_HEX[c.fgToken][theme]);
        expect(h.dot).toBe(COLORS_HEX[c.dotToken][theme]);
      }
    }
  });

  test("silent is a hollow warning dot, not danger (§8 Q2)", () => {
    expect(STATUS_COLORS.silent.role).toBe("warning");
    expect(STATUS_COLORS.silent.dot).toBe("hollow");
    // Display hue only: the severity partition is untouched.
    expect(STATUS_SEVERITY.silent).toBe("urgent");
  });

  test("failed is a filled danger dot (§8 Q2)", () => {
    expect(STATUS_COLORS.failed.role).toBe("danger");
    expect(STATUS_COLORS.failed.dot).toBe("filled");
  });

  test("remaining roles match §3 as amended by §8", () => {
    expect(STATUS_COLORS.blocked).toMatchObject({ role: "warning", dot: "filled" });
    expect(STATUS_COLORS.needs_human).toMatchObject({ role: "warning", dot: "filled" });
    expect(STATUS_COLORS.active).toMatchObject({ role: "accent", dot: "filled" });
    expect(STATUS_COLORS.idle).toMatchObject({ role: "neutral", dot: "filled" });
    expect(STATUS_COLORS.completed).toMatchObject({ role: "success", dot: "filled" });
  });

  test("silent is the only hollow dot", () => {
    const hollow = STATUSES.filter((s) => STATUS_COLORS[s].dot === "hollow");
    expect(hollow).toEqual(["silent"]);
  });

  test("semantic roles name their token trio, not private hexes", () => {
    for (const status of STATUSES) {
      const c = STATUS_COLORS[status];
      if (c.role === "neutral" || c.role === "accent") continue; // composed trios, checked below
      expect(c.bgToken).toBe(`--${c.role}-subtle`);
      expect(c.fgToken).toBe(`--${c.role}-subtle-fg`);
      expect(c.dotToken).toBe(`--${c.role}`);
    }
  });

  test("active keeps Signal Green to the dot only (One Signal Rule)", () => {
    // The word is body ink on a transparent bg — never a filled green badge,
    // "a small colored dot plus a word, not a filled pill" (DESIGN.md §5).
    expect(STATUS_COLORS.active).toMatchObject({
      bgToken: "transparent",
      fgToken: "--fg-2",
      dotToken: "--accent",
    });
  });

  test("idle composes from the neutral ladder", () => {
    expect(STATUS_COLORS.idle).toMatchObject({ bgToken: "--bg-3", fgToken: "--fg-2", dotToken: "--fg-3" });
  });

  test("active is the only transparent badge background", () => {
    const transparent = STATUSES.filter((s) => STATUS_COLORS[s].bgToken === "transparent");
    expect(transparent).toEqual(["active"]);
  });
});

describe("non-color tokens", () => {
  test("spacing, radius, and type scale carry px/rem strings", () => {
    expect(SPACING["--card-pad"]).toBe("20px");
    expect(SPACING["--gutter"]).toBe("24px");
    expect(SPACING["--max-content"]).toBe("1200px");
    expect(RADIUS["--radius-lg"]).toBe("8px");
    expect(RADIUS["--radius-sm"]).toBe("3px");
    expect(TEXT_SCALE["--text-base"]).toBe("0.875rem");
    expect(TEXT_SCALE["--text-2xs"]).toBe("0.6875rem");
  });

  test("weight and leading keys mirror upstream typography.css", () => {
    expect(WEIGHT["--weight-regular"]).toBe(400);
    expect(WEIGHT["--weight-semibold"]).toBe(600);
    expect(LEADING["--leading-tight"]).toBe(1.15);
    expect(LEADING["--leading-normal"]).toBe(1.5);
    for (const key of [...Object.keys(WEIGHT), ...Object.keys(LEADING)])
      expect(key).toMatch(/^--(weight|leading)-[a-z]+$/);
  });
});
