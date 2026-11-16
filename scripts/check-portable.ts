#!/usr/bin/env bun
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

const IMPORT = /(?:\bfrom|\bimport\s*\(|\bimport|\brequire\s*\()\s*["'](\.{1,2}\/[^"']*)["']/g;

function resolveImport(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec);
  for (const candidate of [base, `${base}.ts`, join(base, "index.ts")]) {
    if (candidate.endsWith(".ts") && existsSync(candidate)) return candidate;
  }
  return null;
}

/** Every file that imports a path inside `personal/`, with the chain from a root bin entry that reaches it. */
export function personalImports(root: string, entries: string[]): string[][] {
  const personal = join(root, "personal") + sep;
  const seen = new Set<string>();
  const chains: string[][] = [];
  const walk = (file: string, chain: string[]): void => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(IMPORT)) {
      const target = resolveImport(file, match[1] ?? "");
      if (!target) continue;
      const next = [...chain, relative(root, target)];
      if (target.startsWith(personal)) chains.push(next);
      else walk(target, next);
    }
  };
  for (const entry of entries) {
    const file = resolve(root, entry);
    walk(file, [relative(root, file)]);
  }
  return chains;
}

export function rootBinEntries(root: string): string[] {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { bin?: Record<string, string> };
  return Object.values(pkg.bin ?? {});
}

if (import.meta.main) {
  const root = resolve(import.meta.dir, "..");
  const chains = personalImports(root, rootBinEntries(root));
  if (chains.length > 0) {
    for (const chain of chains) console.error(`portable code imports personal code: ${chain.join(" -> ")}`);
    process.exit(1);
  }
  console.log("portable: no root bin entry reaches personal/");
}
