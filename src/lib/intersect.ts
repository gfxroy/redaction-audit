import { coverage, joinGlyphs, splitGlyphs, type Glyph } from "./geometry";
import type { Cover, Leak, TextRun } from "./types";

/** A fill has to hide more than half the glyph. Annotations count any overlap. */
export const COVER_FRACTION = 0.5;

function topCover(glyph: Glyph, covers: Cover[]): Cover | null {
  let best: Cover | null = null;
  for (const cover of covers) {
    const ratio = coverage(glyph.poly, cover.polygon);
    const hit =
      cover.kind === "annotation" ? ratio > 0 : cover.paintIndex > glyph.paintIndex && ratio > COVER_FRACTION;
    if (!hit) continue;
    if (!best || cover.paintIndex >= best.paintIndex) best = cover;
  }
  return best;
}

/** Group characters hidden by each cover into a string. One character is reported once, under the topmost cover. */
export function findLeaks(runs: TextRun[], covers: Cover[], page: number): Leak[] {
  if (!runs.length || !covers.length) return [];
  const glyphs = runs.flatMap(splitGlyphs);
  const groups = new Map<Cover, Glyph[]>();
  for (const glyph of glyphs) {
    if (!glyph.ch.trim() && glyph.ch !== " ") continue;
    const cover = topCover(glyph, covers);
    if (!cover) continue;
    const list = groups.get(cover);
    if (list) list.push(glyph);
    else groups.set(cover, [glyph]);
  }
  const leaks: Leak[] = [];
  for (const [cover, group] of groups) {
    const text = joinGlyphs(group);
    if (!text.trim()) continue;
    leaks.push({
      page,
      text,
      kind: cover.kind,
      rect: cover.rect,
      polygon: cover.polygon,
    });
  }
  leaks.sort((a, b) => b.rect.y - a.rect.y || a.rect.x - b.rect.x);
  return leaks;
}
