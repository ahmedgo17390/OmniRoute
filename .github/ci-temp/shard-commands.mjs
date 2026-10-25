// TEMPORARY CI helper. Builds the three stage commands of `test:unit:ci:shard` for one shard,
// changing only what result accounting needs:
//   stage 1 (main): the shard's files are selected exactly as node --test does (bash expansion
//     of the package.json arguments, internal glob excluding node_modules, sort, index % 8 —
//     the method that matched Gate 3R shards file for file). Every file except the known
//     hanging ones runs in ONE invocation with --test-force-exit removed; each known hanging
//     file present in the shard runs alone with the original flags and is accepted later only
//     on an exact identity-and-status match.
//   stages 2 and 3 (dashboard, serial): --test-force-exit removed, otherwise unchanged.
// Usage: node shard-commands.mjs <shard> <exceptions-expected.json>
import { execFileSync } from "node:child_process";
import { globSync, readFileSync, writeFileSync } from "node:fs";

const shard = Number(process.argv[2]);
const known = Object.keys(JSON.parse(readFileSync(process.argv[3], "utf8")));
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};

const parts = JSON.parse(readFileSync("package.json", "utf8")).scripts["test:unit:ci:shard"].split(" && ");
if (parts.length !== 3) fail(`expected 3 stages, got ${parts.length}`);
const reporters = (n) =>
  ` --test-reporter=spec --test-reporter-destination=stdout --test-reporter=junit --test-reporter-destination=out/stage${n}.junit.xml`;

parts.forEach((orig, i) => {
  const n = i + 1;
  if (orig.split(" --test-force-exit").length !== 2) fail(`stage ${n}: expected exactly one --test-force-exit`);
  writeFileSync(`out/stage${n}.original.cmd`, orig);
});

// Stage 1: explicit file list.
const s1 = parts[0];
const [prefix, args] = s1.split(" --test-shard=$TEST_SHARD ");
if (args === undefined || s1.split(" --test-shard=$TEST_SHARD ").length !== 2) fail("stage 1: expected one --test-shard");
const expanded = execFileSync("bash", ["-c", `printf '%s\\n' ${args}`], { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);
const files = [];
for (const a of expanded) {
  if (/[*?{}[\]]/.test(a)) files.push(...globSync(a, { cwd: process.cwd(), exclude: (name) => name === "node_modules" }));
  else files.push(a);
}
files.sort();
const mine = files.filter((_, idx) => idx % 8 === shard - 1);
const unsafe = mine.filter((f) => /[*?{}[\]'"\\]/.test(f));
if (unsafe.length) fail("file names unsafe as literal patterns: " + unsafe.join(", "));
const exceptions = mine.filter((f) => known.includes(f));
const main = mine.filter((f) => !known.includes(f));
writeFileSync("out/shard.lst", mine.join("\n") + "\n");
writeFileSync("out/main.lst", main.join("\n") + "\n");
writeFileSync("out/exceptions.lst", exceptions.join("\n") + (exceptions.length ? "\n" : ""));
const mainCmd = prefix.replace(" --test-force-exit", reporters(1));
if (mainCmd.includes("--test-force-exit") || mainCmd === prefix) fail("stage 1: could not remove --test-force-exit");
writeFileSync("out/stage1.cmd", mainCmd + " " + main.map((f) => `'${f}'`).join(" "));
const exc = prefix.replace(" --test ", " --test --test-reporter=tap --test-reporter-destination=stdout ");
if (exc === prefix || !exc.includes("--test-force-exit")) fail("exception command must keep the original flags");
writeFileSync("out/exception.prefix", exc);
console.log(
  `discovered ${files.length} files; shard ${shard}: ${mine.length}; main ${main.length}; exceptions ${JSON.stringify(exceptions)}`
);

// Stages 2 and 3: unchanged except --test-force-exit.
for (const n of [2, 3]) {
  const cmd = parts[n - 1].replace(" --test-force-exit", reporters(n));
  if (cmd.includes("--test-force-exit")) fail(`stage ${n}: could not remove --test-force-exit`);
  writeFileSync(`out/stage${n}.cmd`, cmd);
}
