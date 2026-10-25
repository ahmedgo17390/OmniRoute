// TEMPORARY CI helper. Focused gate for one side (candidate or base):
//   - the regression file must report exactly the recorded identities and statuses for that
//     side (candidate: 28/28 pass; base: the recorded red set), in order;
//   - the related-test run must terminate and its JUnit records must reconcile with the runner
//     summary. Failures are compared across sides later, not judged here.
// Usage: node gate-results.mjs <lib-dir> <regression-expected.json>
import { readFileSync, writeFileSync } from "node:fs";

const { checkNodeRun, parseTap, readSummary, rel } = await import(`${process.argv[2]}/parse.mjs`);
const side = process.env.SIDE;
const expected = JSON.parse(readFileSync(process.argv[3], "utf8"))[side];
const problems = [];
const rcOf = (name) =>
  Number(
    readFileSync("out/gate.rc.tsv", "utf8")
      .trim()
      .split("\n")
      .map((l) => l.split("\t"))
      .find(([n]) => n === name)[1]
  );

const reg = parseTap("out/regression.tap");
const regRc = rcOf("regression");
if (regRc === 124 || regRc === 137) problems.push("regression: TIMEOUT");
const regExact =
  !!reg.summary &&
  reg.tests.length === expected.length &&
  expected.every((e, n) => reg.tests[n]?.id === e.id && reg.tests[n]?.status === e.status);
if (!regExact)
  problems.push(
    `regression: reported ${reg.tests.length} records ${JSON.stringify(reg.summary)}, expected the exact ${side} set of ${expected.length}`
  );
const mismatches = expected
  .map((e, n) => ({ e, g: reg.tests[n] }))
  .filter(({ e, g }) => !g || g.id !== e.id || g.status !== e.status)
  .map(({ e, g }) => ({ expected: e, got: g ?? null }));

const relRc = rcOf("related");
const relSummary = readSummary("out/related.summary");
const related = checkNodeRun({ rc: relRc, summary: relSummary, junit: "out/related.junit.xml", root: process.cwd() + "/" });
for (const p of related.problems) problems.push(`related: ${p}`);
const relTests = related.tests.map((t) => ({ ...t, file: rel(t.file) }));
const lst = readFileSync(process.env.RELATED_LIST, "utf8").split("\n").filter(Boolean);
const reporting = new Set(relTests.map((t) => t.file));
const silent = lst.filter((f) => !reporting.has(f));
if (silent.length) problems.push(`related: ${silent.length} listed files reported no test: ${silent.slice(0, 10).join(", ")}`);

const out = {
  side,
  sha: process.env.SIDE_SHA,
  regression: { rc: regRc, summary: reg.summary, exact: regExact, mismatches, tests: reg.tests },
  related: { rc: relRc, summary: relSummary, parentTests: related.parentTests, files: reporting.size, tests: relTests },
  problems,
};
writeFileSync("out/gate.json", JSON.stringify(out));
console.log(
  `${side}: regression ${JSON.stringify(reg.summary)} exact=${regExact}; related rc=${relRc} ${JSON.stringify(relSummary)} junit=${relTests.length} files=${reporting.size}/${lst.length}; problems=${JSON.stringify(problems)}`
);
process.exit(problems.length ? 1 : 0);
