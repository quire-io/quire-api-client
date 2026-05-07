// Generates COVERAGE.md from src/client.ts by walking the TypeScript AST.
// Run via `npm run gen-coverage`. The CI workflow runs the same script and
// fails if the working tree is dirty afterwards — that's the drift guard.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const clientPath = resolve(repoRoot, "src/client.ts");
const outPath = resolve(repoRoot, "COVERAGE.md");

const src = readFileSync(clientPath, "utf8");
const sf = ts.createSourceFile(
  "client.ts",
  src,
  ts.ScriptTarget.Latest,
  /* setParentNodes */ true,
);

const DIVIDER_RE = /^\/\/\s*-{5,}\s*$/;

// Section headers in client.ts look like:
//   // -----------------------------------------------------------------------
//   // Section Name
//   // (optional prose lines)
//   // -----------------------------------------------------------------------
// Walk the trivia line-by-line so multi-line preambles still parse.
function extractSection(trivia) {
  const lines = trivia.split(/\r?\n/).map((l) => l.trim());
  let last = null;
  for (let i = 0; i < lines.length; i++) {
    if (!DIVIDER_RE.test(lines[i])) continue;
    let title = null;
    let j = i + 1;
    while (j < lines.length && !DIVIDER_RE.test(lines[j])) {
      if (title === null) {
        const m = lines[j].match(/^\/\/\s?(.*)$/);
        if (m && m[1].trim().length > 0) title = m[1].trim();
      }
      j++;
    }
    if (title) last = title;
    i = j;
  }
  return last;
}

const methods = [];
let currentSection = "Other";

function visit(node) {
  if (ts.isClassDeclaration(node) && node.name?.text === "QuireClient") {
    for (const member of node.members) {
      const trivia = src.slice(member.getFullStart(), member.getStart(sf));
      const section = extractSection(trivia);
      if (section) currentSection = section;

      if (!ts.isMethodDeclaration(member)) continue;
      if (!member.name || !ts.isIdentifier(member.name)) continue;
      if (hasModifier(member, ts.SyntaxKind.PrivateKeyword)) continue;
      const name = member.name.text;
      if (!member.body) continue;

      const endpoints = collectEndpoints(member.body);
      if (endpoints.length === 0) continue;

      methods.push({ name, section: currentSection, endpoints });
    }
  }
  ts.forEachChild(node, visit);
}

function hasModifier(node, kind) {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
  return !!mods?.some((m) => m.kind === kind);
}

function collectEndpoints(body) {
  // Track local variables holding string/template values so we can resolve
  // `this.fetch(path, ...)` when path is a `const path = looksLikeOid(...) ? ... : ...` ternary.
  const locals = new Map();
  const out = [];

  function walk(node) {
    if (ts.isVariableDeclaration(node) && node.initializer && node.name && ts.isIdentifier(node.name)) {
      locals.set(node.name.text, node.initializer);
    }
    if (ts.isCallExpression(node) && isThisFetch(node.expression)) {
      const [pathArg, optsArg] = node.arguments;
      const paths = resolvePaths(pathArg, locals);
      const httpMethod = extractMethod(optsArg);
      for (const p of paths) out.push({ method: httpMethod, path: p });
    }
    ts.forEachChild(node, walk);
  }
  walk(body);
  return out;
}

function isThisFetch(expr) {
  return (
    ts.isPropertyAccessExpression(expr) &&
    expr.expression.kind === ts.SyntaxKind.ThisKeyword &&
    expr.name.text === "fetch"
  );
}

function extractMethod(optsArg) {
  if (!optsArg || !ts.isObjectLiteralExpression(optsArg)) return "GET";
  for (const prop of optsArg.properties) {
    if (
      ts.isPropertyAssignment(prop) &&
      ts.isIdentifier(prop.name) &&
      prop.name.text === "method" &&
      ts.isStringLiteral(prop.initializer)
    ) {
      return prop.initializer.text;
    }
  }
  return "GET";
}

function resolvePaths(node, locals) {
  if (!node) return ["<unknown>"];
  // Direct template / string literal.
  const direct = literalPath(node);
  if (direct !== null) return [direct];
  // Identifier — unwrap one level via local-variable map.
  if (ts.isIdentifier(node)) {
    const init = locals.get(node.text);
    if (init) return resolvePaths(init, locals);
    return [`<${node.text}>`];
  }
  // Ternary — emit both branches so e.g. listStatuses gets two rows.
  if (ts.isConditionalExpression(node)) {
    return [
      ...resolvePaths(node.whenTrue, locals),
      ...resolvePaths(node.whenFalse, locals),
    ];
  }
  return [`<${truncate(node.getText(sf), 40)}>`];
}

function literalPath(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return node.text;
  }
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      out += renderSubstitution(span.expression);
      out += span.literal.text;
    }
    return out;
  }
  return null;
}

// Turn `${expr}` into a readable placeholder. Identifiers become `{name}`;
// well-known query-builder calls collapse to a short tag; everything else
// keeps its source text inside braces.
function renderSubstitution(expr) {
  // Strip wrappers that don't affect the path shape.
  let e = expr;
  while (
    ts.isCallExpression(e) &&
    ts.isIdentifier(e.expression) &&
    (e.expression.text === "encodeURIComponent" || e.expression.text === "String") &&
    e.arguments.length === 1
  ) {
    e = e.arguments[0];
  }
  if (ts.isIdentifier(e)) {
    // Conventional names for accumulated query-string suffixes — render as
    // an optional query-string indicator instead of `{qs}` / `{suffix}`.
    if (/^(qs|suffix|query|qsString)$/.test(e.text)) return "[?…]";
    return `{${e.text}}`;
  }
  // qs.toString() / qs.join("&") — URLSearchParams or array flush.
  if (
    ts.isCallExpression(e) &&
    ts.isPropertyAccessExpression(e.expression) &&
    (e.expression.name.text === "toString" || e.expression.name.text === "join")
  ) {
    return "…";
  }
  // Helper functions that build query strings.
  if (ts.isCallExpression(e) && ts.isIdentifier(e.expression)) {
    const name = e.expression.text;
    if (name === "toSearchQueryString") return "[?…]";
    if (name === "listPagingQuery") return "[?limit&cursor]";
  }
  // Ternary like `before ? \`?before=${...}\` : ""` — render both branches.
  if (ts.isConditionalExpression(e)) {
    const t = literalPath(e.whenTrue);
    const f = literalPath(e.whenFalse);
    if (t !== null && f !== null) return f === "" ? `[${t}]` : `[${t}|${f}]`;
  }
  return `{${truncate(e.getText(sf), 30)}}`;
}

function truncate(s, n) {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

function paramSummary(method) {
  // Just the method name + arity for the table — full signatures bloat the doc.
  return `\`${method.name}\``;
}

function formatTable(rows) {
  const lines = ["| Method | HTTP | Endpoint |", "|---|---|---|"];
  for (const r of rows) {
    lines.push(
      `| ${paramSummary(r.method)} | \`${r.endpoint.method}\` | \`/api${r.endpoint.path}\` |`,
    );
  }
  return lines.join("\n");
}

visit(sf);

const sections = new Map();
for (const m of methods) {
  if (!sections.has(m.section)) sections.set(m.section, []);
  for (const e of m.endpoints) {
    sections.get(m.section).push({ method: m, endpoint: e });
  }
}

const out = [
  "<!-- Generated by scripts/gen-coverage.mjs from src/client.ts. Run `npm run gen-coverage` to refresh. -->",
  "",
  "# API Coverage",
  "",
  "Endpoints wrapped by [`QuireClient`](src/client.ts). Compare against the [Quire REST API docs](https://quire.io/dev/api/) to spot gaps.",
  "",
  `Generated from ${methods.length} client methods covering ${[...sections.values()].reduce((n, rows) => n + rows.length, 0)} endpoints across ${sections.size} sections.`,
  "",
];

for (const [section, rows] of sections) {
  out.push(`## ${section}`, "", formatTable(rows), "");
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, out.join("\n"));
console.log(
  `wrote ${outPath} — ${methods.length} methods, ${sections.size} sections`,
);
