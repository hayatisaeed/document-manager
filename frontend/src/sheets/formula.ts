/**
 * A small spreadsheet formula evaluator, so formulas show live results while editing.
 *
 * Covers arithmetic, comparisons, text joining (&), cell references and ranges
 * (also on other sheets: Sheet2!A1, 'My sheet'!A1:B3) and common functions.
 * Unknown functions raise Unsupported; the grid then shows the value Excel saved.
 */

export type Scalar = number | string | boolean | null;
type Value = Scalar | Scalar[];

export class FormulaError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
export class Unsupported extends Error {}

// ---------------------------------------------------------------- addresses

export function colName(c: number): string {
  let s = "";
  for (c += 1; c > 0; c = Math.floor((c - 1) / 26)) s = String.fromCharCode(65 + ((c - 1) % 26)) + s;
  return s;
}

export function colIndex(name: string): number {
  let n = 0;
  for (const ch of name.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
}

export function cellName(r: number, c: number): string {
  return `${colName(c)}${r + 1}`;
}

export function parseCell(ref: string): { r: number; c: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d+)$/.exec(ref);
  return m ? { r: Number(m[2]) - 1, c: colIndex(m[1]) } : null;
}

// ---------------------------------------------------------------- tokens

type Tok =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "ref"; sheet: string | null; a: string; b?: string }
  | { t: "fn"; v: string }
  | { t: "op"; v: string }
  | { t: "bool"; v: boolean };

const REF = String.raw`\$?[A-Za-z]{1,3}\$?\d+`;
const SHEET = String.raw`(?:'((?:[^']|'')+)'|([A-Za-z_][\w.]*))!`;
const TOKEN = new RegExp(
  [
    String.raw`(?<ws>\s+)`,
    String.raw`(?<num>\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|\.\d+)`,
    String.raw`(?<str>"(?:[^"]|"")*")`,
    String.raw`(?<ref>(?:${SHEET})?(${REF})(?::(${REF}))?)(?![\w(])`,
    String.raw`(?<fn>[A-Za-z_][\w.]*)\s*(?=\()`,
    String.raw`(?<bool>TRUE|FALSE)(?![\w(])`,
    String.raw`(?<op><>|<=|>=|[-+*/^&=<>(),;%:])`,
  ].join("|"),
  "iy",
);

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < src.length) {
    const start = TOKEN.lastIndex;
    const m = TOKEN.exec(src);
    if (!m || m.index !== start) throw new FormulaError("#ERROR!");
    const g = m.groups!;
    if (g.ws) continue;
    if (g.num) out.push({ t: "num", v: Number(g.num) });
    else if (g.str) out.push({ t: "str", v: g.str.slice(1, -1).replace(/""/g, '"') });
    else if (g.ref) {
      const sheet = m[5] ? m[5].replace(/''/g, "'") : m[6] ?? null;
      out.push({ t: "ref", sheet, a: m[7], b: m[8] });
    } else if (g.fn) out.push({ t: "fn", v: g.fn.toUpperCase() });
    else if (g.bool) out.push({ t: "bool", v: g.bool.toUpperCase() === "TRUE" });
    else out.push({ t: "op", v: g.op === ";" ? "," : g.op });
  }
  return out;
}

// ---------------------------------------------------------------- parser (precedence climbing)

type Node =
  | { k: "lit"; v: Scalar }
  | { k: "ref"; sheet: string | null; a: string; b?: string }
  | { k: "call"; name: string; args: Node[] }
  | { k: "un"; op: string; x: Node }
  | { k: "bin"; op: string; l: Node; r: Node }
  | { k: "pct"; x: Node };

const BINARY: Record<string, number> = { "=": 1, "<>": 1, "<": 1, ">": 1, "<=": 1, ">=": 1, "&": 2, "+": 3, "-": 3, "*": 4, "/": 4, "^": 5 };

function parse(tokens: Tok[]): Node {
  let i = 0;
  const peek = () => tokens[i];
  const isOp = (v: string) => peek()?.t === "op" && (peek() as { v: string }).v === v;
  const expect = (v: string) => {
    if (!isOp(v)) throw new FormulaError("#ERROR!");
    i++;
  };

  function primary(): Node {
    const tok = tokens[i++];
    if (!tok) throw new FormulaError("#ERROR!");
    switch (tok.t) {
      case "num":
      case "str":
      case "bool":
        return { k: "lit", v: tok.v };
      case "ref":
        return { k: "ref", sheet: tok.sheet, a: tok.a, b: tok.b };
      case "fn": {
        expect("(");
        const args: Node[] = [];
        if (!isOp(")")) {
          for (;;) {
            args.push(isOp(",") || isOp(")") ? { k: "lit", v: null } : expr(0));
            if (isOp(",")) i++;
            else break;
          }
        }
        expect(")");
        return { k: "call", name: tok.v, args };
      }
      case "op":
        if (tok.v === "(") {
          const e = expr(0);
          expect(")");
          return e;
        }
        if (tok.v === "-" || tok.v === "+") return { k: "un", op: tok.v, x: unary() };
    }
    throw new FormulaError("#ERROR!");
  }

  function unary(): Node {
    let node = primary();
    while (isOp("%")) {
      i++;
      node = { k: "pct", x: node };
    }
    return node;
  }

  function expr(minPrec: number): Node {
    let left = unary();
    for (;;) {
      const tok = peek();
      if (tok?.t !== "op" || !(tok.v in BINARY) || BINARY[tok.v] < minPrec) return left;
      i++;
      const prec = BINARY[tok.v];
      const right = expr(tok.v === "^" ? prec : prec + 1);
      left = { k: "bin", op: tok.v, l: left, r: right };
    }
  }

  const node = expr(0);
  if (i !== tokens.length) throw new FormulaError("#ERROR!");
  return node;
}

// ---------------------------------------------------------------- evaluation

export interface SheetSource {
  /** Cell text as typed, or undefined when the sheet doesn't exist. */
  raw(sheet: string, r: number, c: number): string | undefined;
  sheetExists(sheet: string): boolean;
  /** Value Excel saved for a formula cell, used when a function isn't supported here. */
  cached(sheet: string, r: number, c: number): string | undefined;
}

/** Value of typed cell text that isn't a formula. */
export function literal(text: string): Scalar {
  if (text === "") return null;
  if (text.startsWith("'")) return text.slice(1);
  const trimmed = text.trim();
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(trimmed)) return Number(trimmed);
  const pct = /^([+-]?(\d+\.?\d*|\.\d+))%$/.exec(trimmed);
  if (pct) return Number(pct[1]) / 100;
  if (/^(true|false)$/i.test(trimmed)) return trimmed.toUpperCase() === "TRUE";
  return text;
}

function num(v: Scalar): number {
  if (v === null || v === "") return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  const n = Number(v.trim());
  if (v.trim() === "" || Number.isNaN(n)) throw new FormulaError("#VALUE!");
  return n;
}

function str(v: Scalar): string {
  if (v === null) return "";
  if (typeof v === "boolean") return v ? "TRUE" : "FALSE";
  if (typeof v === "number") return formatNumber(v);
  return v;
}

function bool(v: Scalar): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") {
    if (/^true$/i.test(v)) return true;
    if (/^false$/i.test(v)) return false;
    throw new FormulaError("#VALUE!");
  }
  return num(v) !== 0;
}

export function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return "#NUM!";
  return String(Number.isInteger(n) ? n : Number(n.toPrecision(15)));
}

const scalar = (v: Value): Scalar => (Array.isArray(v) ? (v.length === 1 ? v[0] : (() => { throw new FormulaError("#VALUE!"); })()) : v);
const flat = (vals: Value[]): Scalar[] => vals.flatMap((v) => (Array.isArray(v) ? v : [v]));
const numbers = (vals: Value[]) =>
  vals.flatMap((v) => (Array.isArray(v) ? v.filter((x): x is number => typeof x === "number") : [num(v)]));

function compare(a: Scalar, b: Scalar): number {
  if (typeof a === "string" || typeof b === "string") {
    const x = str(a).toLowerCase();
    const y = str(b).toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return num(a) - num(b);
}

/** COUNTIF-style criteria: 5, ">5", "<>x", "=abc", "ab*". */
function criterion(c: Scalar): (v: Scalar) => boolean {
  if (typeof c !== "string") return (v) => v !== null && compare(v, c) === 0;
  const m = /^(<=|>=|<>|<|>|=)?(.*)$/.exec(c)!;
  const op = m[1] ?? "=";
  const target = literal(m[2]);
  const wildcard = typeof target === "string" && /[*?]/.test(target);
  const re = wildcard ? new RegExp("^" + (target as string).replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$", "i") : null;
  return (v) => {
    if (re) return op === "<>" ? !re.test(str(v)) : re.test(str(v));
    if (v === null) return op === "<>" ? target !== null : target === null || target === "";
    if (typeof target === "number" && typeof v !== "number" && op !== "<>" && op !== "=") return false;
    const d = compare(v, target);
    return { "=": d === 0, "<>": d !== 0, "<": d < 0, ">": d > 0, "<=": d <= 0, ">=": d >= 0 }[op]!;
  };
}

function roundTo(x: number, digits: number, mode: "round" | "up" | "down") {
  const f = 10 ** digits;
  const v = Math.abs(x) * f;
  const r = mode === "round" ? Math.round(v + 1e-9) : mode === "up" ? Math.ceil(v - 1e-9) : Math.floor(v + 1e-9);
  return (Math.sign(x) * r) / f;
}

type Fn = (args: Value[], lazy: { node: Node[]; ev: (n: Node) => Value }) => Value;

const FUNCTIONS: Record<string, Fn> = {
  SUM: (a) => numbers(a).reduce((s, x) => s + x, 0),
  PRODUCT: (a) => numbers(a).reduce((s, x) => s * x, 1),
  AVERAGE: (a) => {
    const n = numbers(a);
    if (!n.length) throw new FormulaError("#DIV/0!");
    return n.reduce((s, x) => s + x, 0) / n.length;
  },
  MIN: (a) => (numbers(a).length ? Math.min(...numbers(a)) : 0),
  MAX: (a) => (numbers(a).length ? Math.max(...numbers(a)) : 0),
  MEDIAN: (a) => {
    const n = numbers(a).sort((x, y) => x - y);
    if (!n.length) throw new FormulaError("#NUM!");
    const m = n.length >> 1;
    return n.length % 2 ? n[m] : (n[m - 1] + n[m]) / 2;
  },
  COUNT: (a) => flat(a).filter((x) => typeof x === "number").length,
  COUNTA: (a) => flat(a).filter((x) => x !== null && x !== "").length,
  COUNTBLANK: (a) => flat(a).filter((x) => x === null || x === "").length,
  COUNTIF: ([range, c]) => flat([range]).filter(criterion(scalar(c))).length,
  SUMIF: ([range, c, sumRange]) => {
    const r = flat([range]);
    const s = sumRange === undefined ? r : flat([sumRange]);
    const test = criterion(scalar(c));
    return r.reduce<number>((acc, v, i) => (test(v) && typeof s[i] === "number" ? acc + (s[i] as number) : acc), 0);
  },
  AVERAGEIF: ([range, c, avgRange]) => {
    const r = flat([range]);
    const s = avgRange === undefined ? r : flat([avgRange]);
    const test = criterion(scalar(c));
    const vals = r.map((v, i) => (test(v) ? s[i] : null)).filter((x): x is number => typeof x === "number");
    if (!vals.length) throw new FormulaError("#DIV/0!");
    return vals.reduce((x, y) => x + y, 0) / vals.length;
  },
  IF: (_a, { node, ev }) => {
    const cond = bool(scalar(ev(node[0])));
    const branch = cond ? node[1] : node[2];
    return branch ? ev(branch) : cond;
  },
  IFERROR: (_a, { node, ev }) => {
    try {
      return scalar(ev(node[0]));
    } catch (e) {
      if (e instanceof FormulaError) return ev(node[1]);
      throw e;
    }
  },
  AND: (a) => flat(a).filter((x) => x !== null).every((x) => bool(x)),
  OR: (a) => flat(a).filter((x) => x !== null).some((x) => bool(x)),
  NOT: ([x]) => !bool(scalar(x)),
  ABS: ([x]) => Math.abs(num(scalar(x))),
  SQRT: ([x]) => {
    const n = num(scalar(x));
    if (n < 0) throw new FormulaError("#NUM!");
    return Math.sqrt(n);
  },
  POWER: ([x, y]) => num(scalar(x)) ** num(scalar(y)),
  MOD: ([x, y]) => {
    const d = num(scalar(y));
    if (d === 0) throw new FormulaError("#DIV/0!");
    const n = num(scalar(x));
    return n - d * Math.floor(n / d);
  },
  INT: ([x]) => Math.floor(num(scalar(x))),
  ROUND: ([x, d]) => roundTo(num(scalar(x)), d === undefined ? 0 : num(scalar(d)), "round"),
  ROUNDUP: ([x, d]) => roundTo(num(scalar(x)), d === undefined ? 0 : num(scalar(d)), "up"),
  ROUNDDOWN: ([x, d]) => roundTo(num(scalar(x)), d === undefined ? 0 : num(scalar(d)), "down"),
  PI: () => Math.PI,
  TRUE: () => true,
  FALSE: () => false,
  LEN: ([x]) => str(scalar(x)).length,
  UPPER: ([x]) => str(scalar(x)).toUpperCase(),
  LOWER: ([x]) => str(scalar(x)).toLowerCase(),
  TRIM: ([x]) => str(scalar(x)).trim().replace(/\s+/g, " "),
  LEFT: ([x, n]) => str(scalar(x)).slice(0, n === undefined ? 1 : num(scalar(n))),
  RIGHT: ([x, n]) => {
    const s = str(scalar(x));
    const k = n === undefined ? 1 : num(scalar(n));
    return k <= 0 ? "" : s.slice(-k);
  },
  MID: ([x, start, n]) => str(scalar(x)).substr(num(scalar(start)) - 1, num(scalar(n))),
  CONCAT: (a) => flat(a).map(str).join(""),
  CONCATENATE: (a) => flat(a).map(str).join(""),
  TEXTJOIN: ([sep, skip, ...rest]) =>
    flat(rest)
      .filter((x) => !(bool(scalar(skip)) && (x === null || x === "")))
      .map(str)
      .join(str(scalar(sep))),
  TODAY: () => new Date().toISOString().slice(0, 10),
  NOW: () => new Date().toISOString().slice(0, 16).replace("T", " "),
};

export function evaluateSheet(source: SheetSource) {
  const memo = new Map<string, Scalar>();
  const active = new Set<string>();

  function cellValue(sheet: string, r: number, c: number): Scalar {
    const key = `${sheet}\u0000${r}:${c}`;
    if (memo.has(key)) return memo.get(key)!;
    const text = source.raw(sheet, r, c) ?? "";
    let value: Scalar;
    if (text.startsWith("=") && text.length > 1) {
      if (active.has(key)) throw new FormulaError("#CYCLE!");
      active.add(key);
      try {
        value = formula(sheet, r, c, text.slice(1));
      } finally {
        active.delete(key);
      }
    } else {
      value = literal(text);
    }
    memo.set(key, value);
    return value;
  }

  function formula(sheet: string, r: number, c: number, src: string): Scalar {
    try {
      return scalar(ev(parse(tokenize(src)), sheet));
    } catch (e) {
      if (e instanceof Unsupported) {
        const cached = source.cached(sheet, r, c);
        if (cached !== undefined) return literal(cached);
        throw new FormulaError("#NAME?");
      }
      throw e;
    }
  }

  function ev(node: Node, sheet: string): Value {
    switch (node.k) {
      case "lit":
        return node.v;
      case "ref": {
        const target = node.sheet ?? sheet;
        if (!source.sheetExists(target)) throw new FormulaError("#REF!");
        const a = parseCell(node.a)!;
        if (!node.b) return cellValue(target, a.r, a.c);
        const b = parseCell(node.b)!;
        const out: Scalar[] = [];
        for (let r = Math.min(a.r, b.r); r <= Math.max(a.r, b.r); r++)
          for (let c = Math.min(a.c, b.c); c <= Math.max(a.c, b.c); c++) out.push(cellValue(target, r, c));
        return out;
      }
      case "un": {
        const v = num(scalar(ev(node.x, sheet)));
        return node.op === "-" ? -v : v;
      }
      case "pct":
        return num(scalar(ev(node.x, sheet))) / 100;
      case "bin": {
        const l = scalar(ev(node.l, sheet));
        const r = scalar(ev(node.r, sheet));
        switch (node.op) {
          case "+": return num(l) + num(r);
          case "-": return num(l) - num(r);
          case "*": return num(l) * num(r);
          case "/": {
            const d = num(r);
            if (d === 0) throw new FormulaError("#DIV/0!");
            return num(l) / d;
          }
          case "^": return num(l) ** num(r);
          case "&": return str(l) + str(r);
          case "=": return compare(l, r) === 0;
          case "<>": return compare(l, r) !== 0;
          case "<": return compare(l, r) < 0;
          case ">": return compare(l, r) > 0;
          case "<=": return compare(l, r) <= 0;
          case ">=": return compare(l, r) >= 0;
        }
        throw new FormulaError("#ERROR!");
      }
      case "call": {
        const fn = FUNCTIONS[node.name.replace(/^_xlfn\./, "")];
        if (!fn) throw new Unsupported(node.name);
        const lazy = node.name === "IF" || node.name === "IFERROR";
        const args = lazy ? [] : node.args.map((a) => ev(a, sheet));
        return fn(args, { node: node.args, ev: (n) => ev(n, sheet) });
      }
    }
  }

  /** Display text of a cell: the computed result for formulas, the value otherwise. */
  return function display(sheet: string, r: number, c: number): { text: string; error?: boolean; number?: boolean } {
    try {
      const v = cellValue(sheet, r, c);
      return { text: str(v), number: typeof v === "number" };
    } catch (e) {
      if (e instanceof FormulaError) return { text: e.code, error: true };
      throw e;
    }
  };
}
