import { describe, expect, test } from "bun:test";
import { STATUS_RANK, STATUS_SEVERITY } from "../src/status";
import type { Severity, Status } from "../src/types";
import {
  COLORS_HEX,
  RADIUS,
  SEVERITY_COLORS,
  SPACING,
  STATUS_COLORS,
  TEXT_SCALE,
} from "../src/render/theme";

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

  test("token names mirror the upstream custom properties", () => {
    for (const name of Object.keys(COLORS_HEX)) expect(name).toMatch(/^--[a-z0-9-]+$/);
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

  test("every status has opaque solid and subtle pairs in both themes", () => {
    for (const status of STATUSES) {
      const c = STATUS_COLORS[status];
      expect(c.solid.light).toMatch(HEX6);
      expect(c.solid.dark).toMatch(HEX6);
      for (const theme of ["light", "dark"] as const) {
        expect(c.subtle[theme].bg).toMatch(HEX6);
        expect(c.subtle[theme].fg).toMatch(HEX6);
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

  test("semantic roles resolve from the token table, not private hexes", () => {
    for (const status of STATUSES) {
      const c = STATUS_COLORS[status];
      if (c.role === "neutral" || c.role === "accent") continue; // composed pairs, checked below
      expect(c.solid).toEqual(COLORS_HEX[`--${c.role}`]);
      for (const theme of ["light", "dark"] as const) {
        expect(c.subtle[theme].bg).toBe(COLORS_HEX[`--${c.role}-subtle`][theme]);
        expect(c.subtle[theme].fg).toBe(COLORS_HEX[`--${c.role}-subtle-fg`][theme]);
      }
    }
  });

  test("active keeps Signal Green to the dot only (One Signal Rule)", () => {
    expect(STATUS_COLORS.active.solid).toEqual(COLORS_HEX["--accent"]);
    for (const theme of ["light", "dark"] as const) {
      // The word is body ink on the card surface — never a filled green badge.
      expect(STATUS_COLORS.active.subtle[theme].bg).toBe(COLORS_HEX["--bg-1"][theme]);
      expect(STATUS_COLORS.active.subtle[theme].fg).toBe(COLORS_HEX["--fg-2"][theme]);
    }
  });

  test("idle composes from the neutral ladder", () => {
    expect(STATUS_COLORS.idle.solid).toEqual(COLORS_HEX["--fg-3"]);
    for (const theme of ["light", "dark"] as const) {
      expect(STATUS_COLORS.idle.subtle[theme].bg).toBe(COLORS_HEX["--bg-3"][theme]);
      expect(STATUS_COLORS.idle.subtle[theme].fg).toBe(COLORS_HEX["--fg-2"][theme]);
    }
  });
});

describe("SEVERITY_COLORS alias", () => {
  test("derives from STATUS_SEVERITY: each severity shows its worst-ranked status", () => {
    const severities = [...new Set(Object.values(STATUS_SEVERITY))] as Severity[];
    expect(Object.keys(SEVERITY_COLORS).sort()).toEqual([...severities].sort());
    for (const sev of severities) {
      const worst = STATUSES.filter((s) => STATUS_SEVERITY[s] === sev).sort(
        (a, b) => STATUS_RANK[a] - STATUS_RANK[b],
      )[0]!;
      expect(SEVERITY_COLORS[sev]).toBe(STATUS_COLORS[worst]);
    }
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
});
