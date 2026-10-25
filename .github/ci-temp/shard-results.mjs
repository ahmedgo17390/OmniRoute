// TEMPORARY CI helper. Turns one shard job's raw output into out/results.json:
// per-stage runner summary vs JUnit consistency, accepted exception attempts (exact identity and
// status match only), and every problem that makes the shard's result incomplete.
// Usage: node shard-results.mjs <lib-dir> <exceptions-expected.json>
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const { checkNodeRun, parseTap, readSummary, rel } = await import(`${process.argv[2]}/parse.mjs`);
const expected = JSON.parse(readFileSync(process.argv[3], "utf8"));
const root = process.cwd() + "/";
const STAGES = ["main", "dashboard", "serial"];
const problems = [];
const stages = [];

for (const [i, rc, secs] of readFileSync("out/stages.tsv", "utf8")
  .trim()
  .split("\n")
  .map((l) => l.split("\t"))) {
  const summary = readSummary(`out/stage${i}.summary`);
  const r = checkNodeRun({ rc: Number(rc), summary, junit: `out/stage${i}.junit.xml`, root });
  const log = readFileSync(`out/stage${i}.log`, "utf8");
  // On SIGTERM the runner lists the files it was still waiting for.
  const lines = log.split("\n");
  const at = lines.findIndex((l) => /Interrupted while running:/.test(l));
  const interrupted =
    at < 0
      ? []
      : [lines[at].split("Interrupted while running:")[1], ...lines.slice(at + 1, at + 40)]
          .map((l) => (l ?? "").replace(/^\W*ℹ?\s*/, "").trim())
          .filter((l) => /tests\/unit\//.test(l));
  for (const p of r.problems) problems.push(`stage ${STAGES[i - 1]}: ${p}`);
  if (interrupted.length) problems.push(`stage ${STAGES[i - 1]}: interrupted while running ${interrupted.join(", ")}`);
  const tests = r.tests.map((t) => ({ ...t, file: rel(t.file) }));
  stages.push({ stage: STAGES[i - 1], rc: Number(rc), secs: Number(secs), summary, parentTests: r.parentTests, interrupted, tests });
}

const exceptions = [];
const lst = existsSync("out/exceptions.lst") ? readFileSync("out/exceptions.lst", "utf8").split("\n").filter(Boolean) : [];
for (const [k, file] of lst.entries()) {
  const exp = expected[file];
  const attempts = [];
  let accepted = null;
  for (let a = 1; a <= 5; a++) {
    const tap = `out/exception-${k}-${a}.tap`;
    if (!existsSync(tap)) break;
    const got = parseTap(tap);
    const same =
      !!got.summary &&
      got.tests.length === exp.length &&
      exp.every((e, n) => got.tests[n]?.id === e.id && got.tests[n]?.status === e.status);
    attempts.push({ attempt: a, reported: got.tests.length, summary: got.summary, exact: same });
    if (same) {
      accepted = { attempt: a, tests: got.tests.map((t) => ({ file, id: t.id, status: t.status, err: t.err })) };
      break;
    }
  }
  if (!accepted) problems.push(`exception ${file}: no attempt matched the expected identities and statuses exactly`);
  exceptions.push({ file, expected: exp.length, attempts, accepted: accepted?.attempt ?? null, tests: accepted?.tests ?? [] });
}

const out = {
  shard: Number(process.env.SHARD),
  side: process.env.SIDE,
  sha: process.env.SIDE_SHA,
  stages,
  exceptions,
  problems,
};
writeFileSync("out/results.json", JSON.stringify(out));
for (const s of stages)
  console.log(
    `${s.stage}: rc=${s.rc} ${s.secs}s ${JSON.stringify(s.summary)} junit=${s.tests.length} parentTests=${s.parentTests} files=${new Set(s.tests.map((t) => t.file)).size}`
  );
for (const e of exceptions) console.log(`exception ${e.file}: accepted attempt ${e.accepted} of ${e.attempts.length}`);
console.log(`problems: ${JSON.stringify(problems)}`);
process.exit(problems.length ? 1 : 0);
