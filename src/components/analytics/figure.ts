// ─────────────────────────────────────────────────────────────────────────────
// Figure sizing, shared by every panel that draws a headline number.
//
// Kept in its own module so the landing page's census section can size its tiles
// from the same rule without importing the panel primitives (and, with them,
// recharts).
// ─────────────────────────────────────────────────────────────────────────────

import type { CSSProperties } from "react";

/**
 * Size a figure from the width of the box it is drawn in, not from a guess.
 *
 * The same tile is one of four across the whole page on a wide desktop, one of
 * two inside a half-width panel, and full-width on a phone — so its inner width
 * ranges from about 90px to about 300px, and no fixed text size is right at both
 * ends. Getting it wrong is not cosmetic: "14,000" at `text-2xl` measured 89px
 * inside the 78px box a four-up row gave it, so the digits crossed the tile's own
 * border and landed on the neighbouring column. `cqw` is one per cent of the
 * nearest query container's content box — the element carrying Tailwind's
 * `@container`, i.e. `container-type: inline-size` — so the figure is derived
 * from the space available rather than from a character-count lookup table.
 *
 * Two rules come with it:
 *  - the `@container` must be the tile itself and the figure a child of it (a
 *    container's own styles resolve `cqw` against its *ancestor* container, to
 *    avoid a circular dependency);
 *  - the container needs a definite inline size — a grid item, or a block that
 *    fills its parent. An element inside a flex row sizes to its content, so a
 *    container there would measure itself rather than the room it has been given.
 *
 * Browsers without container query units drop the declaration entirely, which
 * leaves the inherited size: small, but still inside the border.
 *
 * `chars` is the length of the rendered text, unit included. A display digit is
 * about 0.8em wide in this typeface, so dividing 110 by the character count
 * leaves the figure at roughly 88% of its box: wide enough to read as the
 * headline, never wide enough to touch the border.
 */
export function figureStyle(chars: number, maxRem = 2.4): CSSProperties {
  const width = 110 / Math.max(1, chars);
  return { fontSize: `clamp(0.95rem, ${width.toFixed(1)}cqw, ${maxRem}rem)` };
}
