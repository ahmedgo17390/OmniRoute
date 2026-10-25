// TEMPORARY CI helper. One Vitest suite on one side -> out/vitest.json. The JUnit records must
// add up to the report's own <testsuites> totals, and the run must have terminated.
// Usage: node vitest-results.mjs <lib-dir> <rc>
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const { parseJunit } = await import(`${process.argv[2]}/parse.mjs`);
const rc = Number(process.argv[3]);
const problems = [];
if (rc === 124 || rc === 137) problems.push("TIMEOUT (did not terminate within its limit)");
let tests = [];
let totals = null;
const junit = "out/vitest.junit.xml";
if (!existsSync(junit)) problems.push("missing JUnit file");
else {
  const xml = readFileSync(junit, "utf8");
  const head = xml.match(/<testsuites\b((?:[^>"]|"[^"]*")*?)>/);
  const attr = (k) => Number((head?.[1].match(new RegExp(`\\b${k}="(\\d+)"`)) ?? [])[1] ?? NaN);
  totals = { tests: attr("tests"), failures: attr("failures"), errors: attr("errors"), skipped: attr("skipped") };
  ({ tests } = parseJunit(junit, process.cwd() + "/"));
  const fails = tests.filter((t) => t.status === "fail").length;
  if (!(tests.length === totals.tests)) problems.push(`JUnit testcases ${tests.length} != reported tests ${totals.tests}`);
  if (Number.isFinite(totals.failures) && fails !== totals.failures + (totals.errors || 0))
    problems.push(`JUnit failures ${fails} != reported ${totals.failures}+${totals.errors}`);
  if (Number.isFinite(totals.errors) && totals.errors > 0) problems.push(`report lists ${totals.errors} suite-level errors`);
  if (rc !== 0 && fails === 0 && !problems.length) problems.push(`exit code ${rc} without any failing test`);
}
writeFileSync("out/vitest.json", JSON.stringify({ side: process.env.SIDE, suite: process.env.SUITE, rc, totals, tests, problems }));
console.log(`${process.env.SUITE} ${process.env.SIDE}: rc=${rc} totals=${JSON.stringify(totals)} records=${tests.length} problems=${JSON.stringify(problems)}`);
process.exit(problems.length ? 1 : 0);
