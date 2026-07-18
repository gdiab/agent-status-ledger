// HTML attribute/text escaper shared by the HTML-emitting renderers
// (html.ts, digest.ts, icons.ts). Own module so leaf helpers like icons.ts
// don't import the whole html renderer just to escape a label.
export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
