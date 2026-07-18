import type { Platform } from "../types";
import { esc } from "./esc";

// Vendored product marks (asl-9j3): single-path 24×24 SVGs from Simple
// Icons — icon data is CC0; the trademarks remain their owners' (nominative
// use: the mark names the product that produced the session). Vendoring
// keeps the report self-contained — no dependency, no network. Rendered
// monochrome via currentColor (Token Contract Rule: no hardcoded color).

// Anthropic's Claude starburst (Simple Icons `claude`).
const CLAUDE_PATH = "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z";

// OpenAI blossom (Simple Icons `openai`, pinned from the v15.0.0 release —
// the icon was removed from simple-icons after 15.0.0 at the brand's
// request). Codex has no distinct product mark, so the OpenAI mark stands in.
const OPENAI_PATH = "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z";

// Google Gemini spark (Simple Icons `googlegemini`) — UNUSED: vendored
// ready for the gemini connector (asl-alg); wire it into PLATFORM_MARKS
// when the Platform union gains "gemini".
// const GOOGLE_GEMINI_PATH = "M11.04 19.32Q12 21.51 12 24q0-2.49.93-4.68.96-2.19 2.58-3.81t3.81-2.55Q21.51 12 24 12q-2.49 0-4.68-.93a12.3 12.3 0 0 1-3.81-2.58 12.3 12.3 0 0 1-2.58-3.81Q12 2.49 12 0q0 2.49-.96 4.68-.93 2.19-2.55 3.81a12.3 12.3 0 0 1-3.81 2.58Q2.49 12 0 12q2.49 0 4.68.96 2.19.93 3.81 2.55t2.55 3.81";

// Neutral fallback for platform ids outside the union: a ring with a
// centered dot — "an agent, brand unknown". Pure path (no <text>, no font
// dependence). Rendered with fill-rule="evenodd" so the ring cut-out is
// winding-independent: under the default nonzero rule the hole only appears
// if the inner circle happens to wind opposite the outer, and evenodd makes
// the intent explicit instead of leaning on arc sweep flags.
const FALLBACK_PATH = "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 1.5a8.5 8.5 0 1 1 0 17 8.5 8.5 0 0 1 0-17Zm0 6a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5Z";

interface PlatformMark {
  path: string;   // svg path data, 24×24 viewBox
  label: string;  // human name for aria-label/title when the icon is labeled
  // Optional per-mark fill rule; only the fallback needs evenodd (above).
  fillRule?: "evenodd";
}

// satisfies Record<Platform, …>: compile-time exhaustive in both directions,
// so widening the union (e.g. gemini) breaks the build until an icon
// decision is made here, and a stray key breaks it too.
export const PLATFORM_MARKS = {
  "claude-code": { path: CLAUDE_PATH, label: "Claude Code" },
  codex: { path: OPENAI_PATH, label: "Codex" },
} satisfies Record<Platform, PlatformMark>;

// Single string-boundary widening: render call sites may carry future
// config-driven platform ids, which degrade to the neutral fallback (raw id
// as label — callers rely on platformIcon's escaping) instead of crashing.
function platformMark(platform: string): PlatformMark {
  return (PLATFORM_MARKS as Record<string, PlatformMark>)[platform]
    ?? { path: FALLBACK_PATH, label: platform, fillRule: "evenodd" };
}

// Human label for a platform id; unknown ids pass through raw.
export function platformLabel(platform: string): string {
  return platformMark(platform).label;
}

// Complete inline <svg> for a platform's mark: 14px, currentColor. Alignment
// comes from the stylesheet's .platform-icon class (html.ts), not inline
// style. Decorative by default (aria-hidden, no name): every card/thread
// call site puts the icon next to text that already names the platform (the
// "(platform)" displayName suffix), and a labeled icon there would make AT
// announce the platform twice. Pass labeled: true only where the icon alone
// carries the meaning (the rollup's per-platform count segments) — that
// variant gets role="img" + aria-label for AT and <title> for hover.
export function platformIcon(platform: string, opts: { labeled?: boolean } = {}): string {
  const mark = platformMark(platform);
  const fillRule = mark.fillRule ? ` fill-rule="${mark.fillRule}"` : "";
  const label = esc(mark.label);
  const a11y = opts.labeled ? ` role="img" aria-label="${label}"` : ` aria-hidden="true"`;
  const title = opts.labeled ? `<title>${label}</title>` : "";
  return `<svg class="platform-icon" width="14" height="14" viewBox="0 0 24 24" fill="currentColor"${a11y}>${title}<path${fillRule} d="${mark.path}"/></svg>`;
}
