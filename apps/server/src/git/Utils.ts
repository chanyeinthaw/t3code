// @effect-diagnostics nodeBuiltinImport:off
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export function findGitRepositoryRoot(cwd: string): string | undefined {
  let current = resolve(cwd);
  while (true) {
    if (existsSync(join(current, ".git"))) {
      return current;
    }
    const parent = dirname(current);
    if (parent === current) {
      return undefined;
    }
    current = parent;
  }
}

export function isGitRepository(cwd: string): boolean {
  return findGitRepositoryRoot(cwd) !== undefined;
}
