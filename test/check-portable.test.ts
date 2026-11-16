import { describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { personalImports, rootBinEntries } from "../scripts/check-portable";

const ROOT = resolve(import.meta.dir, "..");

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "portable-"));
  for (const [name, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, name)), { recursive: true });
    writeFileSync(join(dir, name), text);
  }
  return dir;
}

describe("check-portable", () => {
  it("finds no personal import behind any root bin entry", () => {
    expect(personalImports(ROOT, rootBinEntries(ROOT))).toEqual([]);
  });

  it("names the import chain when a portable command reaches a personal module", () => {
    const dir = tree({
      "bin/a.ts": 'import { x } from "../src/a";\n',
      "src/a.ts": 'import { y } from "./b";\n',
      "src/b.ts": 'import { z } from "../personal/src/z";\n',
      "personal/src/z.ts": "export const z = 1;\n",
    });
    const chains = personalImports(dir, ["bin/a.ts"]);
    expect(chains.map((c) => c.join(" -> "))).toEqual(["bin/a.ts -> src/a.ts -> src/b.ts -> personal/src/z.ts"]);
  });

  it("accepts a portable tree", () => {
    const dir = tree({ "bin/a.ts": 'import "../src/a";\n', "src/a.ts": "export {};\n", "personal/src/z.ts": "export {};\n" });
    expect(personalImports(dir, ["bin/a.ts"])).toEqual([]);
  });
});
