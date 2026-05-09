/**
 * Quire formula evaluator.
 *
 * Parses and evaluates the Quire custom-field formula language against a task
 * and its project context. Used to compute formula fields client-side when the
 * API returns "Formula can't access \"tasks\" via API" (e.g. project.tasks
 * cross-task expressions).
 *
 * Operator precedence (lowest → highest):
 *   ?: > where > ?? > or > and > not > = != > < > <= >= in & > + - > * / % > ^ > unary > () . [] fn()
 */

import type { QuireTask, QuireTaskNode, QuireFieldDefinition } from "./types.js";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export type FormulaValue = null | boolean | number | string | Date | FormulaValue[];

export interface FormulaContext {
  /** The task the formula is being evaluated on. */
  task: QuireTask;
  /** All tasks in the project — required for project.tasks expressions. */
  projectTasks: QuireTask[];
  /** Custom field definitions keyed by display name. Used to resolve {Field Name} refs. */
  fields?: Record<string, QuireFieldDefinition>;
  /** The signed-in user (for `me` references). */
  currentUser?: { oid: string; id: string; name: string };
}

/**
 * Evaluate a Quire formula string against a task and its project context.
 * Returns null if the formula errors or references unsupported features.
 */
export function evaluateFormula(formula: string, ctx: FormulaContext): FormulaValue {
  try {
    const tokens = tokenize(formula);
    const ast = new Parser(tokens).parseExpr();
    return coerce(evalExpr(ast, { ...ctx, anyVal: undefined, evaluating: new Set() }));
  } catch {
    return null;
  }
}

/**
 * Evaluate every formula-type field on a task and return name → value.
 * Non-formula fields are skipped. Formula errors produce null.
 */
export function evaluateTaskFormulaFields(
  task: QuireTask,
  projectTasks: QuireTask[],
  fields: Record<string, QuireFieldDefinition>,
  currentUser?: { oid: string; id: string; name: string },
): Record<string, FormulaValue> {
  const ctx: FormulaContext = { task, projectTasks, fields, currentUser };
  const out: Record<string, FormulaValue> = {};
  for (const [name, def] of Object.entries(fields)) {
    if (def.type === "formula" && typeof def.formula === "string") {
      out[name] = evaluateFormula(def.formula, ctx);
    }
  }
  return out;
}

/**
 * Flatten a nested task tree (as returned by listTaskTree or the export JSON)
 * into a flat QuireTask array. The `tasks` children property is stripped.
 */
export function flattenTaskTree(nodes: QuireTaskNode[]): QuireTask[] {
  const result: QuireTask[] = [];
  function walk(items: QuireTaskNode[]): void {
    for (const node of items) {
      const { tasks: children, ...task } = node;
      result.push(task as QuireTask);
      if (children?.length) walk(children);
    }
  }
  walk(nodes);
  return result;
}

/**
 * Parse the raw string returned by QuireClient.exportProjectJson() into a flat
 * QuireTask array. Handles both array-at-root and object-with-tasks-property
 * shapes to be robust against format variations.
 */
export function parseExportJson(raw: string): QuireTask[] {
  const parsed: unknown = JSON.parse(raw);
  const nodes: QuireTaskNode[] = Array.isArray(parsed)
    ? (parsed as QuireTaskNode[])
    : (((parsed as Record<string, unknown>).tasks ?? []) as QuireTaskNode[]);
  return flattenTaskTree(nodes);
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

type TK =
  | "NUM" | "STR" | "DATE" | "ID" | "CUSTOM"
  | "LP" | "RP" | "LB" | "RB"
  | "DOT" | "COMMA" | "COLON" | "QUEST"
  | "PLUS" | "MINUS" | "STAR" | "SLASH" | "PCT" | "CARET" | "AMP"
  | "EQ" | "NEQ" | "LT" | "GT" | "LTE" | "GTE"
  | "COAL"
  | "EOF";

interface Tok { kind: TK; val: string }

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;

  while (i < src.length) {
    // Use charAt so all accesses return string, never undefined
    const ch = src.charAt(i);

    if (/\s/.test(ch)) { i++; continue; }

    // Date literal <...>: only when < is immediately followed by a non-space
    // character AND there's a matching > (so `status < 100` stays as LT).
    if (ch === "<") {
      const next = src.charAt(i + 1);
      const end = next && !/\s/.test(next) ? src.indexOf(">", i + 1) : -1;
      if (end > i) {
        out.push({ kind: "DATE", val: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
      // Fall through to two-char / single-char operator handling below
    }

    // Custom field {Name with spaces}
    if (ch === "{") {
      const end = src.indexOf("}", i + 1);
      if (end < 0) throw new Error("Unterminated custom field ref");
      out.push({ kind: "CUSTOM", val: src.slice(i + 1, end) });
      i = end + 1;
      continue;
    }

    // String literals (single or double quoted)
    if (ch === '"' || ch === "'") {
      const q = src.charAt(i++);
      let s = "";
      while (i < src.length && src.charAt(i) !== q) {
        if (src.charAt(i) === "\\") {
          i++;
          const ec = src.charAt(i);
          const esc: Record<string, string> = {
            n: "\n", t: "\t", r: "\r", v: "\v", f: "\f", b: "\b",
            "\\": "\\", "'": "'", '"': '"',
          };
          s += esc[ec] ?? ec;
        } else {
          s += src.charAt(i);
        }
        i++;
      }
      i++; // closing quote
      out.push({ kind: "STR", val: s });
      continue;
    }

    // Numbers (positive only; unary minus handled in parser)
    if (/\d/.test(ch)) {
      let n = "";
      while (i < src.length && /[\d.]/.test(src.charAt(i))) n += src.charAt(i++);
      out.push({ kind: "NUM", val: n });
      continue;
    }

    // @user or @{user}
    if (ch === "@") {
      i++;
      let id = "";
      if (src.charAt(i) === "{") {
        i++;
        while (i < src.length && src.charAt(i) !== "}") id += src.charAt(i++);
        i++; // closing }
      } else {
        while (i < src.length && /[\w.-]/.test(src.charAt(i))) id += src.charAt(i++);
      }
      out.push({ kind: "ID", val: "@" + id });
      continue;
    }

    // #task or #{task}
    if (ch === "#") {
      i++;
      let id = "";
      if (src.charAt(i) === "{") {
        i++;
        while (i < src.length && src.charAt(i) !== "}") id += src.charAt(i++);
        i++;
      } else {
        while (i < src.length && /\w/.test(src.charAt(i))) id += src.charAt(i++);
      }
      out.push({ kind: "ID", val: "#" + id });
      continue;
    }

    // Identifiers and keywords
    if (/[a-zA-Z_]/.test(ch)) {
      let id = "";
      while (i < src.length && /\w/.test(src.charAt(i))) id += src.charAt(i++);
      out.push({ kind: "ID", val: id });
      continue;
    }

    // Two-char operators
    const two = src.slice(i, i + 2);
    if (two === "??") { out.push({ kind: "COAL", val: two }); i += 2; continue; }
    if (two === "!=") { out.push({ kind: "NEQ",  val: two }); i += 2; continue; }
    if (two === "<=") { out.push({ kind: "LTE",  val: two }); i += 2; continue; }
    if (two === ">=") { out.push({ kind: "GTE",  val: two }); i += 2; continue; }

    // Single-char operators
    const ONE: Partial<Record<string, TK>> = {
      "+": "PLUS", "-": "MINUS", "*": "STAR", "/": "SLASH",
      "%": "PCT",  "^": "CARET", "&": "AMP",
      "=": "EQ",   "<": "LT",   ">": "GT",
      "(": "LP",   ")": "RP",   "[": "LB", "]": "RB",
      ".": "DOT",  ",": "COMMA", ":": "COLON", "?": "QUEST",
    };
    const kind = ONE[ch];
    if (kind) { out.push({ kind, val: src.charAt(i++) }); continue; }

    throw new Error(`Unexpected character '${ch}' at position ${i}`);
  }

  out.push({ kind: "EOF", val: "" });
  return out;
}

// ---------------------------------------------------------------------------
// AST
// ---------------------------------------------------------------------------

type Expr =
  | { t: "num";    v: number }
  | { t: "str";    v: string }
  | { t: "date";   v: string }
  | { t: "id";     n: string }
  | { t: "custom"; f: string }
  | { t: "list";   items: Expr[] }
  | { t: "call";   fn: string; args: Expr[] }
  | { t: "member"; o: Expr; p: string }
  | { t: "index";  o: Expr; i: Expr }
  | { t: "unary";  op: string; x: Expr }
  | { t: "binop";  op: string; l: Expr; r: Expr }
  | { t: "tern";   c: Expr; th: Expr; el: Expr }
  | { t: "coal";   l: Expr; r: Expr }
  | { t: "where";  list: Expr; cond: Expr }
  | { t: "map";    list: Expr; expr: Expr }
  | { t: "orderby"; list: Expr; dir: "asc" | "desc"; key: Expr }
  | { t: "limit";  list: Expr; n: Expr };

// ---------------------------------------------------------------------------
// Parser (recursive descent)
// ---------------------------------------------------------------------------

class Parser {
  private pos = 0;
  constructor(private readonly toks: Tok[]) {}

  private cur(): Tok  { return this.toks[this.pos] ?? { kind: "EOF", val: "" }; }
  private peek(n = 1): Tok { return this.toks[this.pos + n] ?? { kind: "EOF", val: "" }; }

  private eat(kind?: TK): Tok {
    const t = this.cur();
    if (kind && t.kind !== kind) throw new Error(`Expected ${kind}, got ${t.kind}('${t.val}')`);
    this.pos++;
    return t;
  }

  private is(kind: TK): boolean { return this.cur().kind === kind; }
  private isId(v: string): boolean {
    return this.cur().kind === "ID" && this.cur().val.toLowerCase() === v.toLowerCase();
  }
  private eatId(v: string): boolean {
    if (this.isId(v)) { this.pos++; return true; }
    return false;
  }

  parseExpr(): Expr { return this.parseTernary(); }

  // Ternary — right-associative, lowest precedence
  private parseTernary(): Expr {
    const c = this.parseNullCoal();
    if (!this.is("QUEST")) return c;
    this.eat("QUEST");
    const th = this.parseTernary();
    this.eat("COLON");
    const el = this.parseTernary();
    return { t: "tern", c, th, el };
  }

  // ?? — left-associative
  private parseNullCoal(): Expr {
    let l = this.parseWhere();
    while (this.is("COAL")) { this.eat(); l = { t: "coal", l, r: this.parseWhere() }; }
    return l;
  }

  // where — left-associative
  private parseWhere(): Expr {
    let list = this.parseMap();
    while (this.isId("where")) {
      this.eat(); // 'where'
      list = { t: "where", list, cond: this.parseOr() };
    }
    return list;
  }

  // map
  private parseMap(): Expr {
    const list = this.parseOrderBy();
    if (!this.isId("map")) return list;
    this.eat();
    return { t: "map", list, expr: this.parseOr() };
  }

  // order by [asc|desc]
  private parseOrderBy(): Expr {
    const list = this.parseLimit();
    if (!this.isId("order")) return list;
    this.eat();
    if (!this.isId("by")) throw new Error("Expected 'by' after 'order'");
    this.eat();
    const dir: "asc" | "desc" = this.isId("desc") ? (this.eat(), "desc") : (this.eatId("asc"), "asc");
    return { t: "orderby", list, dir, key: this.parseOr() };
  }

  // limit
  private parseLimit(): Expr {
    const list = this.parseOr();
    if (!this.isId("limit")) return list;
    this.eat();
    return { t: "limit", list, n: this.parseOr() };
  }

  private parseOr(): Expr {
    let l = this.parseAnd();
    while (this.isId("or")) { this.eat(); l = { t: "binop", op: "or", l, r: this.parseAnd() }; }
    return l;
  }

  private parseAnd(): Expr {
    let l = this.parseNot();
    while (this.isId("and")) { this.eat(); l = { t: "binop", op: "and", l, r: this.parseNot() }; }
    return l;
  }

  private parseNot(): Expr {
    if (this.isId("not")) { this.eat(); return { t: "unary", op: "not", x: this.parseNot() }; }
    return this.parseEquality();
  }

  private parseEquality(): Expr {
    let l = this.parseRelational();
    while (this.is("EQ") || this.is("NEQ")) {
      const op = this.eat().val;
      l = { t: "binop", op, l, r: this.parseRelational() };
    }
    return l;
  }

  private parseRelational(): Expr {
    let l = this.parseAdditive();
    for (;;) {
      if (this.is("LT") || this.is("GT") || this.is("LTE") || this.is("GTE")) {
        const op = this.eat().val;
        l = { t: "binop", op, l, r: this.parseAdditive() };
      } else if (this.isId("in")) {
        this.eat();
        l = { t: "binop", op: "in", l, r: this.parseAdditive() };
      } else if (this.is("AMP")) {
        this.eat();
        l = { t: "binop", op: "&", l, r: this.parseAdditive() };
      } else {
        break;
      }
    }
    return l;
  }

  private parseAdditive(): Expr {
    let l = this.parseMultiplicative();
    while (this.is("PLUS") || this.is("MINUS")) {
      const op = this.eat().val;
      l = { t: "binop", op, l, r: this.parseMultiplicative() };
    }
    return l;
  }

  private parseMultiplicative(): Expr {
    let l = this.parseExponential();
    while (this.is("STAR") || this.is("SLASH") || this.is("PCT")) {
      const op = this.eat().val;
      l = { t: "binop", op, l, r: this.parseExponential() };
    }
    return l;
  }

  private parseExponential(): Expr {
    const l = this.parseUnary();
    if (!this.is("CARET")) return l;
    this.eat();
    return { t: "binop", op: "^", l, r: this.parseExponential() }; // right-assoc
  }

  private parseUnary(): Expr {
    if (this.is("MINUS")) { this.eat(); return { t: "unary", op: "-", x: this.parsePostfix() }; }
    if (this.is("PLUS"))  { this.eat(); return { t: "unary", op: "+", x: this.parsePostfix() }; }
    return this.parsePostfix();
  }

  // Postfix: member access, indexing, function calls
  private parsePostfix(): Expr {
    let e = this.parsePrimary();
    for (;;) {
      if (this.is("DOT")) {
        this.eat();
        // accept any token as a property name (includes keywords like 'name', 'value')
        const prop = this.eat().val;
        // If followed by '(', treat as method call (not yet supported — fall through to member)
        e = { t: "member", o: e, p: prop };
      } else if (this.is("LB")) {
        this.eat("LB");
        const idx = this.parseExpr();
        this.eat("RB");
        e = { t: "index", o: e, i: idx };
      } else if (this.is("LP") && e.t === "id") {
        // Function call
        this.eat("LP");
        const args: Expr[] = [];
        while (!this.is("RP") && !this.is("EOF")) {
          args.push(this.parseExpr());
          if (this.is("COMMA")) this.eat();
        }
        this.eat("RP");
        e = { t: "call", fn: e.n, args };
      } else {
        break;
      }
    }
    return e;
  }

  private parsePrimary(): Expr {
    const t = this.cur();

    if (t.kind === "NUM")    { this.pos++; return { t: "num", v: Number(t.val) }; }
    if (t.kind === "STR") {
      this.pos++;
      let s = t.val;
      // Adjacent string literals concatenate: 'ab' 'cd' => 'abcd'
      while (this.is("STR")) { s += this.cur().val; this.pos++; }
      return { t: "str", v: s };
    }
    if (t.kind === "DATE")   { this.pos++; return { t: "date", v: t.val }; }
    if (t.kind === "CUSTOM") { this.pos++; return { t: "custom", f: t.val }; }
    if (t.kind === "ID")     { this.pos++; return { t: "id", n: t.val }; }

    if (t.kind === "LP") {
      this.eat("LP");
      const e = this.parseExpr();
      this.eat("RP");
      return e;
    }

    if (t.kind === "LB") {
      this.eat("LB");
      const items: Expr[] = [];
      while (!this.is("RB") && !this.is("EOF")) {
        items.push(this.parseExpr());
        if (this.is("COMMA")) this.eat();
      }
      this.eat("RB");
      return { t: "list", items };
    }

    // Adjacent string literals concatenate: 'ab' 'cd' => 'abcd'
    throw new Error(`Unexpected token ${t.kind}('${t.val}')`);
  }
}

// ---------------------------------------------------------------------------
// Evaluator
// ---------------------------------------------------------------------------

interface EvalCtx extends FormulaContext {
  anyVal: unknown;          // the 'any' binding inside where/map expressions
  evaluating: Set<string>;  // guard against circular custom-field refs
}

function evalExpr(e: Expr, ctx: EvalCtx): unknown {
  switch (e.t) {
    case "num":  return e.v;
    case "str":  return e.v;
    case "date": return evalDate(e.v);

    case "id": return evalId(e.n, ctx);

    case "custom": return evalCustomField(e.f, ctx);

    case "list":
      // Quire unfolds nested lists into one flat list
      return e.items.flatMap(item => {
        const v = evalExpr(item, ctx);
        return Array.isArray(v) ? v : [v];
      });

    case "call": return evalCall(e.fn, e.args, ctx);

    case "member": {
      const obj = evalExpr(e.o, ctx);
      return getMember(obj, e.p, ctx);
    }

    case "index": {
      const obj = evalExpr(e.o, ctx);
      const idx = evalExpr(e.i, ctx);
      if (!Array.isArray(obj)) return null;
      const n = asNumber(idx);
      return n !== null ? (obj[n] ?? null) : null;
    }

    case "unary": {
      const v = evalExpr(e.x, ctx);
      if (e.op === "-") { const n = asNumber(v); return n !== null ? -n : null; }
      if (e.op === "+") return asNumber(v);
      if (e.op === "not") return !isTruthy(v);
      return null;
    }

    case "binop": return evalBinop(e.op, e.l, e.r, ctx);

    case "tern": {
      const cond = evalExpr(e.c, ctx);
      // Array ternary: [true, false] ? [1, 2] : 3 => [1, 3]
      // Result length = max(cond, then-array, else-array) lengths.
      // Scalar then/else applies at every index; out-of-bounds cond element → null (#17707).
      if (Array.isArray(cond)) {
        const thRaw = evalExpr(e.th, ctx);
        const elRaw = evalExpr(e.el, ctx);
        const tha = Array.isArray(thRaw) ? thRaw : null;
        const ela = Array.isArray(elRaw) ? elRaw : null;
        const len = Math.max(cond.length, tha?.length ?? 0, ela?.length ?? 0);
        return Array.from({ length: len }, (_, i) => {
          const c = i < cond.length ? cond[i] : undefined;
          if (c === null || c === undefined) return null;
          if (isTruthy(c)) return tha ? (tha[i] ?? null) : thRaw;
          return ela ? (ela[i] ?? null) : elRaw;
        });
      }
      // null condition → null, not the else branch (#17707)
      if (cond === null || cond === undefined) return null;
      return isTruthy(cond) ? evalExpr(e.th, ctx) : evalExpr(e.el, ctx);
    }

    case "coal": {
      const l = evalExpr(e.l, ctx);
      // Array null-coalescing: [1, null] ?? [3, 5] => [1, 5]
      if (Array.isArray(l)) {
        const r = toArray(evalExpr(e.r, ctx));
        return l.map((v, i) => (v !== null && v !== undefined) ? v : (r[i] ?? null));
      }
      return (l !== null && l !== undefined) ? l : evalExpr(e.r, ctx);
    }

    case "where": {
      const listVal = evalExpr(e.list, ctx);
      // Scalar where: passes → scalar, fails → null (#17370 spec)
      if (!Array.isArray(listVal)) {
        const condVal = evalExpr(e.cond, { ...ctx, anyVal: listVal });
        return isTruthyForWhere(condVal) ? listVal : null;
      }
      // Array condition uses "at least one truthy item" (#17375)
      return listVal.filter(item => isTruthyForWhere(evalExpr(e.cond, { ...ctx, anyVal: item })));
    }

    case "map": {
      const list = toArray(evalExpr(e.list, ctx));
      return list.map(item => evalExpr(e.expr, { ...ctx, anyVal: item }));
    }

    case "orderby": {
      const list = [...toArray(evalExpr(e.list, ctx))];
      const sign = e.dir === "desc" ? -1 : 1;
      list.sort((a, b) => {
        const ka = evalExpr(e.key, { ...ctx, anyVal: a });
        const kb = evalExpr(e.key, { ...ctx, anyVal: b });
        return (compareValues(ka, kb) ?? 0) * sign;
      });
      return list;
    }

    case "limit": {
      const list = toArray(evalExpr(e.list, ctx));
      const n = asNumber(evalExpr(e.n, ctx));
      return n !== null ? list.slice(0, n) : list;
    }
  }
}

// ---------------------------------------------------------------------------
// evalId: resolve identifiers against task fields and built-ins
// ---------------------------------------------------------------------------

function evalId(name: string, ctx: EvalCtx): unknown {
  const lo = name.toLowerCase();

  // Boolean / null literals
  if (lo === "null")  return null;
  if (lo === "true")  return true;
  if (lo === "false") return false;

  // where/map iterator
  if (lo === "any") return ctx.anyVal ?? null;

  // Current user
  if (lo === "me") return ctx.currentUser ?? null;

  // Priority builtins
  const PRI: Record<string, { value: number; name: string }> = {
    low: { value: -1, name: "Low" }, medium: { value: 0, name: "Medium" },
    high: { value: 1, name: "High" }, urgent: { value: 2, name: "Urgent" },
  };
  if (lo in PRI) return PRI[lo];

  const task = ctx.task;

  // project — returns proxy object; members resolved in getMember
  if (lo === "project") return {
    __quireProjProxy: true,
    tasks: ctx.projectTasks,
    id: task.project?.id ?? null,
    name: task.project?.name ?? null,
  };

  // Traversal helpers
  if (lo === "subtasks")    return ctx.projectTasks.filter(t => t.parent?.oid === task.oid);
  if (lo === "descendants") return getDescendants(task, ctx.projectTasks);
  if (lo === "ancestors")   return getAncestors(task, ctx.projectTasks);
  if (lo === "parent")      return ctx.projectTasks.find(t => t.oid === task.parent?.oid) ?? null;

  // List fields
  if (lo === "assignees")   return task.assignees   ?? [];
  if (lo === "assignors")   return (task as Record<string, unknown>)["assignors"] ?? [];
  if (lo === "tags")        return task.tags        ?? [];
  if (lo === "followers")   return task.followers   ?? [];
  if (lo === "timelogs")    return task.timelogs    ?? [];
  if (lo === "attachments") return task.attachments ?? [];
  if (lo === "comments")    return task.comments    ?? [];
  if (lo === "sublists")    return [];

  // Scalar fields
  if (lo === "status")      return task.status   ?? null;
  if (lo === "priority")    return task.priority  ?? null;
  if (lo === "name")        return task.name      ?? null;
  if (lo === "description") return task.description ?? null;
  if (lo === "id")          return task.id        ?? null;
  if (lo === "due")         return parseIsoDate(task.due);
  if (lo === "start")       return parseIsoDate(task.start);
  if (lo === "createdat")   return parseIsoDate(task.createdAt);
  if (lo === "editedat")    return parseIsoDate(task.editedAt);

  // completedAt: Quire uses toggledAt for this when status = 100
  if (lo === "completedat") {
    const raw = (task as Record<string, unknown>)["completedAt"] ??
                (task as Record<string, unknown>)["toggledAt"];
    return raw ? new Date(raw as string) : null;
  }
  if (lo === "toggledat") return parseIsoDate((task as Record<string, unknown>)["toggledAt"] as string | undefined);

  // Custom fields passed back in the API response at top level (e.g. "KPI Point": 1)
  const direct = (task as Record<string, unknown>)[name];
  if (direct !== undefined) return direct;

  // Custom fields nested under customFields
  if (task.customFields?.[name] !== undefined) return task.customFields[name];

  return null;
}

// ---------------------------------------------------------------------------
// evalCustomField: evaluate a {Field Name} reference
// ---------------------------------------------------------------------------

function evalCustomField(fieldName: string, ctx: EvalCtx): unknown {
  if (!ctx.fields) return null;
  const def = ctx.fields[fieldName];
  if (!def) return null;

  if (def.type !== "formula" || typeof def.formula !== "string") {
    // Non-formula custom field: look up the computed value on the task
    const direct = (ctx.task as Record<string, unknown>)[fieldName];
    if (direct !== undefined) return direct;
    return ctx.task.customFields?.[fieldName] ?? null;
  }

  // Guard against circular references
  if (ctx.evaluating.has(fieldName)) return null;
  const inner: EvalCtx = { ...ctx, evaluating: new Set([...ctx.evaluating, fieldName]) };

  try {
    const ast = new Parser(tokenize(def.formula)).parseExpr();
    return evalExpr(ast, inner);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// evalCall: built-in functions
// ---------------------------------------------------------------------------

function evalCall(fn: string, argExprs: Expr[], ctx: EvalCtx): unknown {
  const up = fn.toUpperCase();
  const args = () => argExprs.map(a => evalExpr(a, ctx));

  switch (up) {
    case "COUNT": {
      // count() / count(null) → null; count([]) → 0; count non-null items across all args
      if (argExprs.length === 0) return null;
      let hasArray = false;
      const flat: unknown[] = [];
      for (const a of argExprs) {
        const v = evalExpr(a, ctx);
        if (Array.isArray(v)) { hasArray = true; flat.push(...v); }
        else flat.push(v);
      }
      const nonNull = flat.filter(v => v !== null && v !== undefined);
      if (!hasArray && nonNull.length === 0) return null;
      return nonNull.length;
    }
    case "ISEMPTY": {
      const [v] = args();
      return Array.isArray(v) ? v.length === 0 : (v === null || v === undefined);
    }
    case "ISNOTEMPTY": {
      const [v] = args();
      return Array.isArray(v) ? v.length > 0 : (v !== null && v !== undefined);
    }
    case "SUM": {
      const nums = args().flat(Infinity).filter((v): v is number => typeof v === "number");
      return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0);
    }
    case "AVG": {
      const nums = args().flat(Infinity).filter((v): v is number => typeof v === "number");
      return nums.length === 0 ? null : nums.reduce((a, b) => a + b, 0) / nums.length;
    }
    case "MAX": {
      const nums = args().flat(Infinity).filter((v): v is number => typeof v === "number");
      return nums.length === 0 ? null : Math.max(...nums);
    }
    case "MIN": {
      const nums = args().flat(Infinity).filter((v): v is number => typeof v === "number");
      return nums.length === 0 ? null : Math.min(...nums);
    }
    case "SORT": {
      // sort() / sort(null) → null; nulls removed from output
      if (argExprs.length === 0) return null;
      let hasArray = false;
      const flat: unknown[] = [];
      for (const a of argExprs) {
        const v = evalExpr(a, ctx);
        if (Array.isArray(v)) { hasArray = true; flat.push(...v); }
        else flat.push(v);
      }
      const nonNull = flat.filter(v => v !== null && v !== undefined);
      if (!hasArray && nonNull.length === 0) return null;
      return [...nonNull].sort((a, b) => compareValues(a, b) ?? 0);
    }
    case "DISTINCT": {
      // distinct() / distinct(null) → null; nulls removed; then deduplicate
      if (argExprs.length === 0) return null;
      let hasArray = false;
      const flat: unknown[] = [];
      for (const a of argExprs) {
        const v = evalExpr(a, ctx);
        if (Array.isArray(v)) { hasArray = true; flat.push(...v); }
        else flat.push(v);
      }
      const nonNull = flat.filter(v => v !== null && v !== undefined);
      if (!hasArray && nonNull.length === 0) return null;
      return nonNull.filter((v, i, arr) => arr.findIndex(x => deepEquals(x, v)) === i);
    }
    default:
      throw new Error(`Unknown function: ${fn}`);
  }
}

// ---------------------------------------------------------------------------
// evalBinop
// ---------------------------------------------------------------------------

function evalBinop(op: string, lExpr: Expr, rExpr: Expr, ctx: EvalCtx): unknown {
  // Short-circuit logical ops
  if (op === "and") {
    const l = evalExpr(lExpr, ctx);
    return isTruthy(l) ? evalExpr(rExpr, ctx) : l;
  }
  if (op === "or") {
    const l = evalExpr(lExpr, ctx);
    return isTruthy(l) ? l : evalExpr(rExpr, ctx);
  }

  const l = evalExpr(lExpr, ctx);
  const r = evalExpr(rExpr, ctx);

  // in: all items in left appear in right
  if (op === "in") {
    const right = toArray(r);
    const left  = toArray(l);
    return left.every(lv => right.some(rv => deepEquals(lv, rv)));
  }

  // & intersection
  if (op === "&") {
    const la = toArray(l);
    const ra = toArray(r);
    return la.filter(lv => ra.some(rv => deepEquals(lv, rv)));
  }

  // Array vs scalar / array vs array
  if (Array.isArray(l) || Array.isArray(r)) {
    const la = toArray(l);
    const ra = toArray(r);
    if (la.length === 0 || ra.length === 0) return [];
    if (!Array.isArray(l)) return ra.map(rv => applyOp(op, l, rv));
    if (!Array.isArray(r)) return la.map(lv => applyOp(op, lv, r));
    // zip (extend shorter with null)
    const len = Math.max(la.length, ra.length);
    return Array.from({ length: len }, (_, i) => applyOp(op, la[i] ?? null, ra[i] ?? null));
  }

  return applyOp(op, l, r);
}

function applyOp(op: string, l: unknown, r: unknown): unknown {
  switch (op) {
    case "+": {
      if (l instanceof Date && typeof r === "number") return new Date(l.getTime() + r * 1000);
      if (typeof l === "number" && r instanceof Date) return new Date(r.getTime() + l * 1000);
      // Date + null → Date; null + Date → Date (special cases, not general null arithmetic)
      if (l instanceof Date && (r === null || r === undefined)) return l;
      if ((l === null || l === undefined) && r instanceof Date) return r;
      if (typeof l === "string" || typeof r === "string")
        return String(l ?? "") + String(r ?? "");
      const ln = asNumber(l), rn = asNumber(r);
      return ln !== null && rn !== null ? ln + rn : null;
    }
    case "-": {
      if (l instanceof Date && r instanceof Date) return (l.getTime() - r.getTime()) / 1000;
      if (l instanceof Date && typeof r === "number") return new Date(l.getTime() - r * 1000);
      // String subtraction: str - null → str; str - str → remove prefix; str - N → remove last N chars
      if (typeof l === "string") {
        if (r === null || r === undefined) return l;
        if (typeof r === "string") return l.startsWith(r) ? l.slice(r.length) : l;
        const n = asNumber(r);
        return n !== null ? (n > 0 ? l.slice(0, Math.max(0, l.length - Math.floor(n))) : l) : null;
      }
      const ln = asNumber(l), rn = asNumber(r);
      return ln !== null && rn !== null ? ln - rn : null;
    }
    case "*": {
      // String repetition: str * N → repeat N times; str * null/0/neg → ''
      if (typeof l === "string") {
        if (r === null || r === undefined) return "";
        const n = asNumber(r);
        return n !== null ? (n > 0 ? l.repeat(Math.floor(n)) : "") : null;
      }
      if (typeof r === "string") {
        if (l === null || l === undefined) return null;
        const n = asNumber(l);
        return n !== null ? (n > 0 ? r.repeat(Math.floor(n)) : "") : null;
      }
      const ln = asNumber(l), rn = asNumber(r);
      return ln !== null && rn !== null ? ln * rn : null;
    }
    case "/": {
      if (typeof l === "string") return NaN; // str / anything → NaN
      const ln = asNumber(l), rn = asNumber(r);
      return ln !== null && rn !== null && rn !== 0 ? ln / rn : null;
    }
    case "%": { const ln = asNumber(l), rn = asNumber(r); return ln !== null && rn !== null ? ln % rn : null; }
    case "^": { const ln = asNumber(l), rn = asNumber(r); return ln !== null && rn !== null ? Math.pow(ln, rn) : null; }
    case "=":  return deepEquals(l, r);
    case "!=": return !deepEquals(l, r);
    case "<":  { const c = compareValues(l, r); return c !== null ? c < 0  : null; }
    case ">":  { const c = compareValues(l, r); return c !== null ? c > 0  : null; }
    case "<=": { const c = compareValues(l, r); return c !== null ? c <= 0 : null; }
    case ">=": { const c = compareValues(l, r); return c !== null ? c >= 0 : null; }
    default:   return null;
  }
}

// ---------------------------------------------------------------------------
// getMember: property access on a value
// ---------------------------------------------------------------------------

function getMember(obj: unknown, prop: string, ctx: EvalCtx): unknown {
  if (obj === null || obj === undefined) return null;
  const lo = prop.toLowerCase();

  // Array: apply member to each element (list vs property)
  if (Array.isArray(obj)) return obj.map(item => getMember(item, prop, ctx));

  // Task object
  if (isTask(obj)) return evalId(lo, { ...ctx, task: obj as QuireTask });

  // Project proxy
  if (isProjProxy(obj)) {
    const rec = obj as Record<string, unknown>;
    return rec[lo] ?? rec[prop] ?? null;
  }

  // Enum-like { value, name } (status, priority, tag)
  if (isEnumLike(obj)) {
    const rec = obj as Record<string, unknown>;
    return rec[lo] ?? rec[prop] ?? null;
  }

  // Generic object (tag, user, timelog, attachment…)
  if (typeof obj === "object") {
    const rec = obj as Record<string, unknown>;
    return rec[prop] ?? rec[lo] ?? null;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Date evaluation
// ---------------------------------------------------------------------------

function evalDate(raw: string): Date | null {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const s = raw.trim().toLowerCase();

  if (s === "today")     return today;
  if (s === "tomorrow")  { const d = new Date(today); d.setDate(d.getDate() + 1); return d; }
  if (s === "yesterday") { const d = new Date(today); d.setDate(d.getDate() - 1); return d; }

  // Relative: +N, today+N, today-N, tomorrow+3 etc.
  const rel = s.match(/^(?:today|tomorrow|yesterday)?([+-]\d+)/);
  if (rel) {
    const base = s.startsWith("tomorrow") ? new Date(today) : new Date(today);
    if (s.startsWith("tomorrow")) base.setDate(base.getDate() + 1);
    if (s.startsWith("yesterday")) base.setDate(base.getDate() - 1);
    base.setDate(base.getDate() + parseInt(rel[1] ?? "0", 10));
    return base;
  }

  // Absolute: 2022/12/25, 2022/01/23 13:10:00, 12/23, 23
  const iso = raw.trim().replace(/\//g, "-");
  const d = new Date(iso.includes("-") ? iso : `2000-01-${iso.padStart(2, "0")}`);
  return isNaN(d.getTime()) ? null : d;
}

function parseIsoDate(raw: string | undefined | null): Date | null {
  if (!raw) return null;
  const d = new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

function isTask(v: unknown): v is QuireTask {
  return typeof v === "object" && v !== null &&
    "oid" in v && "id" in v && typeof (v as QuireTask).id === "number";
}

function isProjProxy(v: unknown): boolean {
  return typeof v === "object" && v !== null && "__quireProjProxy" in v;
}

function isEnumLike(v: unknown): boolean {
  // { value: number, name: string } — status, priority, tag color etc.
  return typeof v === "object" && v !== null &&
    ("value" in v || "name" in v || "color" in v);
}

function isTruthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false) return false;
  if (Array.isArray(v)) return v.length > 0; // empty list is false per Quire spec
  if (typeof v === "number") return v !== 0;
  return true;
}

function asNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "number") return v;
  if (v instanceof Date) return v.getTime() / 1000;
  if (isEnumLike(v) && typeof (v as Record<string, unknown>)["value"] === "number")
    return (v as { value: number }).value;
  const n = Number(v);
  return isNaN(n) ? null : n;
}

function toArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === null || v === undefined) return [];
  return [v];
}

function compareValues(a: unknown, b: unknown): number | null {
  // null on either side → null for ordering comparisons (#17707)
  if (a === null || a === undefined || b === null || b === undefined) return null;
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  const an = asNumber(a), bn = asNumber(b);
  if (an !== null && bn !== null) return an - bn;
  if (typeof a === "string" && typeof b === "string") return a.localeCompare(b);
  return null;
}

// For `where` conditions: array condition is true if ANY element is truthy (#17375)
function isTruthyForWhere(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(item => isTruthy(item));
  return isTruthy(v);
}

function deepEquals(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  // Entity comparison by OID (tasks, tags, users…)
  if (hasOid(a) && hasOid(b)) return (a as { oid: string }).oid === (b as { oid: string }).oid;
  // Enum comparison by value
  const an = asNumber(a), bn = asNumber(b);
  if (an !== null && bn !== null) return an === bn;
  if (a instanceof Date && b instanceof Date) return a.getTime() === b.getTime();
  return false;
}

function hasOid(v: unknown): v is { oid: string } {
  return typeof v === "object" && v !== null && "oid" in v;
}

function getDescendants(root: QuireTask, all: QuireTask[]): QuireTask[] {
  const out: QuireTask[] = [];
  const queue = [root.oid];
  while (queue.length) {
    const oid = queue.shift()!;
    const children = all.filter(t => t.parent?.oid === oid);
    out.push(...children);
    queue.push(...children.map(c => c.oid));
  }
  return out;
}

function getAncestors(task: QuireTask, all: QuireTask[]): QuireTask[] {
  const out: QuireTask[] = [];
  let cur = task;
  while (cur.parent?.oid) {
    const p = all.find(t => t.oid === cur.parent!.oid);
    if (!p) break;
    out.push(p);
    cur = p;
  }
  return out.reverse();
}

// Coerce internal value to public FormulaValue (strips internal proxies, converts unknown objects to strings)
function coerce(v: unknown): FormulaValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v;
  if (typeof v === "number")  return v;
  if (typeof v === "string")  return v;
  if (v instanceof Date)      return v;
  if (Array.isArray(v))       return v.map(coerce);
  // Objects that leaked out (e.g. tag {oid, name}) — caller can cast [key: string]
  return v as FormulaValue;
}
