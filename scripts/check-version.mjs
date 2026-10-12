#!/usr/bin/env node
/**
 * Release guard: assert the version is consistent across the places that must
 * agree before a publish, so a bumped package.json can never drift from the
 * embedded VERSION or ship without a changelog entry.
 *
 *   - package.json "version"
 *   - src/version.ts   VERSION = "..."
 *   - CHANGELOG.md     has a heading mentioning that version
 *
 * Runs as part of `npm run check` (CI) and before publish. Exits non-zero on
 * any mismatch.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const versionTs = readFileSync(join(root, "src/version.ts"), "utf8");
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");

const pkgVersion = pkg.version;
const tsMatch = versionTs.match(/VERSION\s*=\s*["'`]([^"'`]+)["'`]/);
const tsVersion = tsMatch?.[1];

const problems = [];
if (!tsVersion) {
  problems.push("could not find `VERSION = \"...\"` in src/version.ts");
} else if (tsVersion !== pkgVersion) {
  problems.push(
    `src/version.ts VERSION (${tsVersion}) != package.json version (${pkgVersion})`,
  );
}

const changelogHasVersion = changelog
  .split("\n")
  .some((line) => line.startsWith("## ") && line.includes(pkgVersion));
if (!changelogHasVersion) {
  problems.push(`CHANGELOG.md has no "## ..." heading mentioning ${pkgVersion}`);
}

if (problems.length > 0) {
  console.error("Version check FAILED:");
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

console.log(
  `Version check OK: ${pkgVersion} (package.json == src/version.ts, CHANGELOG entry present)`,
);
