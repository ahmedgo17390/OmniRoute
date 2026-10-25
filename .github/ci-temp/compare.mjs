// TEMPORARY CI helper. Paired candidate-vs-base comparison by test identity.
//
// Identity = "<repo-relative file> :: <suite path > test name>", kept as a multiset (a title may
// legitimately repeat). The candidate adds exactly one test file, so file sharding differs by
// side and the comparison is done over the whole suite, not per shard.
//
//   node compare.mjs gate <cand gate.json> <base gate.json>
//   node compare.mjs final <downloaded artifacts dir>
import { appendFileSync, existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

const NEW_FILE = "tests/unit/malformed-tool-call-arguments-classification.test.ts";
const BAD = new Set(["fail", "timeout", "cancelled"]);

function index(records) {
  const m = new Map();
  for (const t of records) {
    const k = `${t.file} :: ${t.id}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(t);
  }
  for (const v of m.values()) v.sort((a, b) => (a.status < b.status ? -1 : a.status > b.status ? 1 : 0));
  return m;
}

/** Compare one scope (e.g. "unit" or "vitest-ui") across the two sides. */
export function compareScope(scope, cand, base, { newFile = null } = {}) {
  const C = index(cand);
  const B = index(base);
  const problems = [];
  const candidateSpecific = [];
  const baseline = [];
  const baseOnlyFailures = [];
  const added = [];
  for (const [k, cs] of C) {
    const bs = B.get(k);
    if (!bs) {
      if (newFile && cs[0].file === newFile) {
        added.push(...cs);
        continue;
      }
      problems.push(`${scope}: identity only in candidate: ${k} ×${cs.length}`);
      continue;
    }
    if (cs.length !== bs.length) problems.push(`${scope}: count differs for ${k}: candidate ${cs.length}, base ${bs.length}`);
    const baseFails = bs.some((t) => BAD.has(t.status));
    for (const t of cs.filter((t) => BAD.has(t.status)))
      (baseFails ? baseline : candidateSpecific).push({ key: k, status: t.status, err: t.err });
    if (baseFails && !cs.some((t) => BAD.has(t.status)))
      baseOnlyFailures.push({ key: k, base: bs.map((t) => t.status) });
  }
  for (const [k, bs] of B) if (!C.has(k)) problems.push(`${scope}: identity missing from candidate: ${k} ×${bs.length}`);
  const tally = (rs) => {
    const t = { records: rs.length, pass: 0, fail: 0, timeout: 0, cancelled: 0, skip: 0, todo: 0 };
    for (const r of rs) t[r.status] = (t[r.status] ?? 0) + 1;
    return t;
  };
  const skipDiff = [...C].filter(([k, cs]) => {
    const bs = B.get(k);
    return bs && cs.filter((t) => t.status === "skip").length !== bs.filter((t) => t.status === "skip").length;
  });
  for (const [k] of skipDiff) problems.push(`${scope}: skip count differs for ${k}`);
  return {
    scope,
    candidate: tally(cand),
    base: tally(base),
    files: { candidate: new Set(cand.map((t) => t.file)).size, base: new Set(base.map((t) => t.file)).size },
    added: { count: added.length, notPassing: added.filter((t) => t.status !== "pass").map((t) => `${t.id}: ${t.status}`) },
    candidateSpecific,
    baseline,
    baseOnlyFailures,
    problems,
  };
}

function verdictOf(scopes, infra) {
  const problems = [...infra, ...scopes.flatMap((s) => s.problems)];
  for (const s of scopes) if (s.added.notPassing.length) problems.push(`${s.scope}: new regression tests not passing: ${s.added.notPassing.join("; ")}`);
  const regress = scopes.flatMap((s) => s.candidateSpecific.map((f) => ({ scope: s.scope, ...f })));
  const verdict = problems.length
    ? "INCONCLUSIVE"
    : regress.length
      ? "FAIL (candidate-specific failures)"
      : scopes.some((s) => s.baseline.length)
        ? "PASS WITH BASELINE FAILURES"
        : "PASS";
  return { verdict, problems, regress };
}

function render(title, scopes, v, extra = []) {
  const md = [`## ${title}: ${v.verdict}`, ""];
  md.push("| scope | side | records | pass | fail | timeout | cancelled | skip | todo | files |", "|---|---|---|---|---|---|---|---|---|---|");
  for (const s of scopes)
    for (const side of ["candidate", "base"]) {
      const t = s[side];
      md.push(`| ${s.scope} | ${side} | ${t.records} | ${t.pass} | ${t.fail} | ${t.timeout} | ${t.cancelled} | ${t.skip} | ${t.todo} | ${s.files[side]} |`);
    }
  md.push("", ...extra);
  for (const s of scopes) {
    md.push("", `### ${s.scope}`, `- new regression identities (candidate only): ${s.added.count}`);
    md.push(`- candidate-specific failures (${s.candidateSpecific.length}):`, ...s.candidateSpecific.map((f) => `  - ${f.key} — ${f.status} — ${f.err}`));
    md.push(`- baseline failures, failing on base too (${s.baseline.length}):`, ...s.baseline.map((f) => `  - ${f.key} — ${f.status} — ${f.err}`));
    md.push(`- failing on base only (${s.baseOnlyFailures.length}):`, ...s.baseOnlyFailures.map((f) => `  - ${f.key} — base ${f.base.join(",")}`));
  }
  md.push("", `### Problems (${v.problems.length})`, ...v.problems.map((p) => `- ${p}`));
  return md.join("\n");
}

function emit(name, title, scopes, v, extra) {
  const md = render(title, scopes, v, extra);
  writeFileSync(`${name}.md`, md);
  writeFileSync(`${name}.json`, JSON.stringify({ verdict: v.verdict, problems: v.problems, regress: v.regress, scopes }, null, 1));
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, md + "\n");
  console.log(md);
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === "gate") {
  const [c, b] = rest.map((f) => JSON.parse(readFileSync(f, "utf8")));
  const infra = [...c.problems.map((p) => `candidate ${p}`), ...b.problems.map((p) => `base ${p}`)];
  const scope = compareScope("related", c.related.tests, b.related.tests);
  const v = verdictOf([scope], infra);
  emit("gate-compare", "Focused gate (regression + related, candidate vs base)", [scope], v, [
    `- regression file: candidate ${JSON.stringify(c.regression.summary)} exact=${c.regression.exact}; base ${JSON.stringify(b.regression.summary)} exact=${b.regression.exact} (red proof)`,
  ]);
  process.exit(v.verdict.startsWith("PASS") ? 0 : 1);
}

if (mode === "final") {
  const dir = rest[0];
  const infra = [];
  const unit = { candidate: [], base: [] };
  const vitest = {};
  const rows = [];
  for (const side of ["candidate", "base"]) {
    for (let s = 1; s <= 8; s++) {
      const p = `${dir}/unit-${side}-${s}/results.json`;
      if (!existsSync(p)) {
        infra.push(`unit ${side} shard ${s}: no results (job did not complete)`);
        continue;
      }
      const r = JSON.parse(readFileSync(p, "utf8"));
      for (const pr of r.problems) infra.push(`unit ${side} shard ${s}: ${pr}`);
      for (const st of r.stages) {
        unit[side].push(...st.tests);
        rows.push(`| ${side} | ${s} | ${st.stage} | ${st.rc} | ${st.secs}s | ${st.summary.tests ?? "—"} | ${st.summary.pass ?? "—"} | ${st.summary.fail ?? "—"} | ${st.summary.skipped ?? "—"} | ${st.tests.length} |`);
      }
      for (const e of r.exceptions) {
        unit[side].push(...e.tests);
        rows.push(`| ${side} | ${s} | exception ${e.file.replace("tests/unit/", "")} | accepted ${e.accepted ?? "NO"}/${e.attempts.length} | — | ${e.expected} | ${e.tests.filter((t) => t.status === "pass").length} | ${e.tests.filter((t) => BAD.has(t.status)).length} | ${e.tests.filter((t) => t.status === "skip").length} | ${e.tests.length} |`);
      }
    }
    for (const suite of ["mcp", "ui"]) {
      const p = `${dir}/vitest-${side}-${suite}/vitest.json`;
      if (!existsSync(p)) {
        infra.push(`vitest ${suite} ${side}: no results (job did not complete)`);
        continue;
      }
      const r = JSON.parse(readFileSync(p, "utf8"));
      for (const pr of r.problems) infra.push(`vitest ${suite} ${side}: ${pr}`);
      (vitest[suite] ??= { candidate: [], base: [] })[side] = r.tests;
    }
  }
  const scopes = [compareScope("unit", unit.candidate, unit.base, { newFile: NEW_FILE })];
  for (const suite of ["mcp", "ui"]) if (vitest[suite]) scopes.push(compareScope(`vitest-${suite}`, vitest[suite].candidate, vitest[suite].base));
  const added = scopes[0].added.count;
  if (added !== 28) infra.push(`unit: expected the 28 new regression identities in the candidate, found ${added}`);
  const v = verdictOf(scopes, infra);
  emit("final-summary", "Linux validation verdict (candidate vs untouched base)", scopes, v, [
    "| side | shard | stage | rc / accepted | time | tests | pass | fail | skipped | records |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...rows,
  ]);
  process.exit(0);
}
console.error("usage: compare.mjs gate|final ...");
process.exit(2);
