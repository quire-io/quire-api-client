/**
 * Quire's fixed icon-color palette.
 *
 * Quire stores tag / status / avatar colors as a 2-digit code: the first
 * digit is a row (0–5), the second is a column (0–7) — 48 palette slots
 * total. The server validates via `isValidIconColor` in
 * boeneo/common/lib/src/util/name.dart and rejects everything else with
 * "Invalid color for `color`: …". The hex values below mirror the
 * client-side `colorTable` in workspace.dart so callers can accept
 * human-friendly names and translate to the code Quire expects.
 *
 * `"99"` is NOT a valid tag color (server rejects it); it's reserved for
 * workspace-level icons. Keep it out of `NAMED_COLORS`.
 */
export const COLOR_TABLE: Readonly<Record<string, string>> = Object.freeze({
  "00": "#FBCA03", "01": "#FFB20F", "02": "#FF8610", "03": "#FA6C00",
  "04": "#FF725C", "05": "#F54D45", "06": "#D81F1E", "07": "#BC1312",
  "10": "#F88992", "11": "#F5707F", "12": "#F0596E", "13": "#EB425E",
  "14": "#F06CB2", "15": "#DE5283", "16": "#BF3263", "17": "#880E4F",
  "20": "#959AF1", "21": "#7F80EC", "22": "#6F6AE6", "23": "#6155E0",
  "24": "#BA72DB", "25": "#9F53C2", "26": "#843DB9", "27": "#631C99",
  "30": "#6AD5D9", "31": "#3EC8DA", "32": "#1AB4D6", "33": "#009BD4",
  "34": "#6696FF", "35": "#5082EB", "36": "#2A5DC9", "37": "#1F2EA1",
  "40": "#98D62E", "41": "#74C81F", "42": "#53B919", "43": "#36A816",
  "44": "#23BA8F", "45": "#0A966F", "46": "#006E5F", "47": "#005247",
  "50": "#BDBDBD", "51": "#ADADAD", "52": "#949494", "53": "#828282",
  "54": "#7792A6", "55": "#5E7B8F", "56": "#3E5D73", "57": "#2D4454",
});

/**
 * Friendly names that map to a palette code. Picked so a user saying
 * "make it red" lands on an obviously-red swatch rather than a pinkish
 * neighbor. All codes are within the tag-legal range (00–57).
 */
export const NAMED_COLORS: Readonly<Record<string, string>> = Object.freeze({
  yellow:  "00",
  gold:    "01",
  orange:  "03",
  coral:   "04",
  red:     "06",
  crimson: "07",
  pink:    "14",
  magenta: "16",
  violet:  "22",
  indigo:  "23",
  purple:  "25",
  cyan:    "32",
  sky:     "33",
  blue:    "34",
  navy:    "37",
  lime:    "40",
  green:   "42",
  emerald: "43",
  teal:    "44",
  gray:    "52",
  grey:    "52",
  slate:   "54",
  black:   "57",
});

const PALETTE_RE = /^[0-5][0-7]$/;

/**
 * Normalize a user-supplied color to Quire's 2-digit palette code.
 *   resolveColor("red")   → "06"
 *   resolveColor("BLUE")  → "34"
 *   resolveColor("34")    → "34"
 *   resolveColor("#f00")  → undefined   (hex is not supported by Quire)
 *   resolveColor("99")    → undefined   (not a valid tag color)
 *   resolveColor("")      → undefined
 */
export function resolveColor(input: string | undefined): string | undefined {
  if (!input) return undefined;
  const trimmed = input.trim();
  if (PALETTE_RE.test(trimmed)) return trimmed;
  return NAMED_COLORS[trimmed.toLowerCase()];
}
