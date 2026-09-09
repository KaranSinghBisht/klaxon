/**
 * A 5x4 block font, just large enough to read a stolen private key from across a room.
 *
 * Each glyph is five hex digits; each digit is one row of four columns, high bit leftmost.
 * `A` is `69F99` — `0110 1001 1111 1001 1001`. Twenty bits per glyph keeps the whole font
 * a single object literal instead of a dependency, which matters here: the collector is the
 * attacker's machine in the demo, and an attacker's tool that pulls half of npm to draw
 * letters would be making KLAXON's own argument for it.
 */

const ROWS = 5;
const COLS = 4;

/** Uppercase only — `normalize()` folds case before lookup. */
const GLYPHS: Record<string, string> = {
  "0": "69996",
  "1": "26227",
  "2": "6924F",
  "3": "E161E",
  "4": "99F11",
  "5": "F8E1E",
  "6": "68E96",
  "7": "F1244",
  "8": "69696",
  "9": "69716",
  A: "69F99",
  B: "E9E9E",
  C: "68886",
  D: "E999E",
  E: "F8E8F",
  F: "F8E88",
  G: "68B96",
  H: "99F99",
  I: "72227",
  J: "11196",
  K: "9ACA9",
  L: "8888F",
  M: "9FF99",
  N: "9DB99",
  O: "69996",
  P: "E9E88",
  Q: "699B7",
  R: "E9EA9",
  S: "7861E",
  T: "F2222",
  U: "99996",
  V: "99966",
  W: "99FF9",
  X: "99699",
  Y: "99622",
  Z: "F124F",
  " ": "00000",
  _: "0000F",
  "-": "00F00",
  "=": "0F0F0",
  ".": "00066",
  ",": "00062",
  ":": "06060",
  "/": "12248",
  "+": "02720",
  "*": "0A4A0",
  "!": "22202",
  "?": "69202",
  "@": "6BBB6",
  "#": "AFAFA",
  "%": "91249",
  "(": "24442",
  ")": "42224",
  "[": "62226",
  "]": "64446",
  "{": "34443",
  "}": "C222C",
  "<": "12421",
  ">": "84248",
  "'": "22000",
  '"': "AA000",
  ";": "06062",
  $: "6C6C6",
  "&": "6A6A7",
  "|": "22222",
  "\\": "84212",
  "^": "69000",
  "~": "005A0",
  "`": "42000",
};

/** Anything the font has no glyph for still occupies a cell, so columns stay aligned. */
const FALLBACK = "F999F";

const ON = "█";
const OFF = " ";

function glyphRows(ch: string): string[] {
  const bits = GLYPHS[ch] ?? FALLBACK;
  const out: string[] = [];
  for (let r = 0; r < ROWS; r += 1) {
    const nibble = Number.parseInt(bits[r] ?? "0", 16);
    let row = "";
    for (let c = 0; c < COLS; c += 1) {
      row += (nibble >> (COLS - 1 - c)) & 1 ? ON : OFF;
    }
    out.push(row);
  }
  return out;
}

/** Columns one glyph occupies, including the single-column gap that follows it. */
export const CELL_WIDTH = COLS + 1;

/** How many characters fit on one line at a given terminal width. */
export function charsPerLine(terminalWidth: number): number {
  return Math.max(1, Math.floor(terminalWidth / CELL_WIDTH));
}

function normalize(text: string): string {
  return text.toUpperCase();
}

/**
 * Renders one line of text. The caller is responsible for wrapping — see `bigBlock`, which
 * wraps at the terminal width rather than letting a 64-hex key run off the side of the frame.
 */
export function bigLine(text: string): string[] {
  const chars = [...normalize(text)];
  const rows: string[] = Array.from({ length: ROWS }, () => "");
  for (const ch of chars) {
    const g = glyphRows(ch);
    for (let r = 0; r < ROWS; r += 1) {
      rows[r] = `${rows[r] ?? ""}${g[r] ?? ""}${OFF}`;
    }
  }
  return rows.map((r) => r.replace(/\s+$/, ""));
}

/** Renders text as block type, hard-wrapped to `width` columns, blank line between wraps. */
export function bigBlock(text: string, width: number): string[] {
  const per = charsPerLine(width);
  const chars = [...normalize(text)];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += per) {
    if (i > 0) out.push("");
    out.push(...bigLine(chars.slice(i, i + per).join("")));
  }
  return out;
}
