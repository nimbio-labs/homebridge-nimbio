// Repo and packaging invariants — each one is a problem this project has
// already hit once, pinned so it cannot quietly come back.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PLATFORM_NAME, PLUGIN_NAME } from "../src/settings.js";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const pkg = JSON.parse(read("package.json"));

/** "^22.12.0 || ^24.0.0 || >=26.0.0" → lowest accepted [major, minor, patch] per major. */
function floors(range: string): Map<number, number[]> {
  const out = new Map<number, number[]>();
  for (const clause of range.split("||").map((c) => c.trim())) {
    const m = clause.match(/^(\^|>=)?(\d+)(?:\.(\d+))?(?:\.(\d+))?$/);
    if (!m) throw new Error(`unparsed engines clause: ${clause}`);
    out.set(Number(m[2]), [Number(m[2]), Number(m[3] ?? 0), Number(m[4] ?? 0)]);
  }
  return out;
}
const lt = (a: number[], b: number[]) => a[0]! - b[0]! || a[1]! - b[1]! || a[2]! - b[2]!;

describe("plugin identity", () => {
  // An unofficial third-party `homebridge-nimbio` registers the alias "Nimbio";
  // sharing it would force users to fully qualify the platform name.
  it("uses its own platform alias, consistently", () => {
    expect(PLATFORM_NAME).not.toBe("Nimbio");
    expect(JSON.parse(read("config.schema.json")).pluginAlias).toBe(PLATFORM_NAME);
    expect(pkg.name).toBe(PLUGIN_NAME);
    expect(pkg.name).toMatch(/^@nimbio\/homebridge-/);
    expect(pkg.keywords).toContain("homebridge-plugin");
  });
});

describe("engines", () => {
  // Review finding #10: engines allowed Node 22.10 while vitest 5 needs 22.12.
  it("does not admit a Node the test runner cannot run on", () => {
    const ours = floors(pkg.engines.node);
    const vitest = floors(JSON.parse(read("node_modules/vitest/package.json")).engines.node);
    for (const [major, floor] of ours) {
      const theirs = vitest.get(major);
      expect(theirs, `vitest does not support Node ${major}`).toBeDefined();
      expect(lt(floor, theirs!) >= 0, `engines Node ${floor.join(".")} < vitest's ${theirs!.join(".")}`).toBe(true);
    }
  });

  it("CI tests every Node major that engines admits", () => {
    const ci = read(".github/workflows/ci.yml");
    for (const major of floors(pkg.engines.node).keys()) expect(ci).toContain(`"${major}"`);
  });
});

describe("npm version", () => {
  // npm 10 crashes resolving vite 8's optional devtools peer chain; CI and the
  // publish job must use the same, newer npm.
  it("CI and publish pin the same npm 11+", () => {
    const pin = (f: string) => read(f).match(/npm install -g npm@(\d+)\.(\d+)\.(\d+)/);
    const ci = pin(".github/workflows/ci.yml");
    const publish = pin(".github/workflows/publish.yml");
    expect(ci).not.toBeNull();
    expect(publish).not.toBeNull();
    expect(ci![0]).toBe(publish![0]);
    expect(Number(ci![1])).toBeGreaterThanOrEqual(11);
  });
});

describe("what gets published and committed", () => {
  // .hb-dev/ holds the dev smoke's Homebridge config — with an API key in it.
  it("keeps the dev-smoke directory out of git", () => {
    expect(read(".gitignore").split("\n")).toContain(".hb-dev/");
  });

  it("publishes only the built plugin and its docs", () => {
    expect([...pkg.files].sort()).toEqual(["CHANGELOG.md", "LICENSE", "README.md", "config.schema.json", "dist"]);
  });
});
