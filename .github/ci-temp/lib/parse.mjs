// TEMPORARY CI helper (test/malformed-tool-args-linux-20261025 only).
// TAP and JUnit parsers carried over from the identity-verified nonstream-tool-args workflows.
import { readFileSync } from "node:fs";

const unesc = (s) => s.replace(/\\#/g, "#").replace(/\\\\/g, "\\");

/** TAP -> one record per test (suites excluded) plus the runner summary. */
export function parseTap(file) {
  const lines = readFileSync(file, "utf8").split("\n");
  const stack = [];
  const tests = [];
  const summary = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const sub = line.match(/^( *)# Subtest: (.*)$/);
    if (sub) {
      const lvl = sub[1].length / 4;
      stack.length = lvl;
      stack[lvl] = unesc(sub[2]);
      continue;
    }
    const sm = line.match(/^# (tests|suites|pass|fail|cancelled|skipped|todo|duration_ms) ([\d.]+)$/);
    if (sm) {
      summary[sm[1]] = Number(sm[2]);
      continue;
    }
    const r = line.match(/^( *)(ok|not ok) \d+ - (.*?)(?: # (SKIP|TODO)\b.*)?$/);
    if (!r) continue;
    const lvl = r[1].length / 4;
    const name = unesc(r[3]);
    const meta = {};
    if ((lines[i + 1] ?? "").trim() === "---") {
      const pad = r[1] + "  ";
      let j = i + 2;
      for (; j < lines.length && lines[j] !== pad + "..."; j++) {
        const kv = lines[j].match(/^ *(type|failureType|error|code): ?(.*)$/);
        if (!kv || !lines[j].startsWith(pad) || lines[j].startsWith(pad + " ")) continue;
        let v = kv[2];
        if (v === "|-" || v === "|" || v === ">-") {
          const body = [];
          while (j + 1 < lines.length && lines[j + 1].startsWith(pad + "  ")) body.push(lines[++j].trim());
          v = body.join("\n");
        } else v = v.replace(/^'(.*)'$/, "$1").replace(/''/g, "'");
        meta[kv[1]] = v;
      }
      i = j;
    }
    if (meta.type === "suite") continue;
    let status = r[2] === "ok" ? (r[4] ? r[4].toLowerCase() : "pass") : "fail";
    if (status === "fail" && meta.failureType === "testTimeoutFailure") status = "timeout";
    if (status === "fail" && meta.failureType === "cancelledByParent") status = "cancelled";
    tests.push({
      id: [...stack.slice(0, lvl), name].join(" > "),
      status,
      err: (meta.error ?? "").split("\n")[0].slice(0, 200),
    });
  }
  return { tests, summary: Object.keys(summary).length ? summary : null };
}

const unx = (s) =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&amp;/g, "&");

/**
 * JUnit -> per-test records. Quoted attribute values may contain ">", and a node test with
 * subtests is written as a <testsuite>. Vitest puts the file in `classname`.
 */
export function parseJunit(file, root) {
  const xml = readFileSync(file, "utf8");
  const tests = [];
  const stack = [];
  let suites = 0;
  let cur = null;
  const re = /<(\/?)(testsuites|testsuite|testcase|failure|skipped|error)\b((?:[^>"]|"[^"]*")*?)(\/?)>/g;
  for (const m of xml.matchAll(re)) {
    const [, close, tag, attrStr, selfClose] = m;
    const attrs = {};
    for (const a of attrStr.matchAll(/([\w:-]+)="([^"]*)"/g)) attrs[a[1]] = unx(a[2]);
    if (tag === "testsuite") {
      if (!close) suites++;
      if (close) stack.pop();
      else if (!selfClose) stack.push(attrs.name ?? "");
      continue;
    }
    if (tag === "testcase") {
      if (close) {
        cur = null;
        continue;
      }
      const f = attrs.file ?? attrs.classname ?? "";
      cur = {
        file: f.split(root).pop().replace(/^\/+/, ""),
        id: [...stack, attrs.name ?? ""].join(" > "),
        status: "pass",
        err: "",
      };
      tests.push(cur);
      if (selfClose) cur = null;
      continue;
    }
    if (!cur || close) continue;
    if (tag === "skipped") cur.status = attrs.type === "todo" ? "todo" : "skip";
    if (tag === "failure" || tag === "error") {
      const t = attrs.type ?? "";
      cur.status = /testTimeoutFailure/.test(t) ? "timeout" : /cancelledByParent/.test(t) ? "cancelled" : "fail";
      cur.err = (attrs.message ?? "").split("\n")[0].slice(0, 200);
    }
  }
  return { tests, suites };
}

export function readSummary(file) {
  const summary = {};
  for (const l of readFileSync(file, "utf8").split("\n")) {
    const m = l.match(/^ℹ (\w+) ([\d.]+)$/);
    if (m) summary[m[1]] = Number(m[2]);
  }
  return summary;
}

/**
 * Consistency of one node --test run: runner summary vs JUnit records. Tests with subtests
 * appear as extra JUnit testsuites: testcases + (JUnit suites - runner suites) must equal
 * runner tests, and the per-status gaps must be >= 0 and add up to it.
 */
export function checkNodeRun({ rc, summary, junit, root }) {
  const problems = [];
  if (rc === 124 || rc === 137) problems.push("TIMEOUT (did not terminate within its limit)");
  if (!("tests" in summary)) problems.push("missing runner summary");
  let tests = [];
  let jsuites = 0;
  try {
    ({ tests, suites: jsuites } = parseJunit(junit, root));
  } catch (e) {
    problems.push("missing or malformed JUnit: " + e.message);
  }
  const c = (s) => tests.filter((t) => t.status === s).length;
  let parentTests = null;
  if ("tests" in summary) {
    parentTests = jsuites - summary.suites;
    const gaps = {
      pass: summary.pass - c("pass"),
      fail: summary.fail - c("fail") - c("timeout"),
      cancelled: summary.cancelled - c("cancelled"),
      skipped: summary.skipped - c("skip"),
      todo: summary.todo - c("todo"),
    };
    const gapSum = Object.values(gaps).reduce((a, b) => a + b, 0);
    if (parentTests < 0 || tests.length + parentTests !== summary.tests)
      problems.push(`JUnit testcases ${tests.length} + parent tests ${parentTests} != summary tests ${summary.tests}`);
    if (Object.values(gaps).some((g) => g < 0) || gapSum !== parentTests)
      problems.push(`per-status JUnit/summary mismatch ${JSON.stringify(gaps)} vs parent tests ${parentTests}`);
  }
  if (tests.some((t) => !t.file)) problems.push(`${tests.filter((t) => !t.file).length} testcases without a file`);
  return { tests, jsuites, parentTests, problems };
}

export const rel = (f) => f.replace(/^.*?(tests\/unit\/)/, "$1");
