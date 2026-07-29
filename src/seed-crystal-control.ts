import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { seedCrystalControlPath } from "./paths.js";

export type SeedCrystalControlState = {
  injectionOverride?: boolean;
  omitNext?: {
    crystalId: string;
    requestedAt: string;
    freshThreadOnly: true;
  };
};

export function readSeedCrystalControl(installRoot: string): SeedCrystalControlState {
  const path = seedCrystalControlPath(installRoot);
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf8")) as SeedCrystalControlState;
  } catch {
    return {};
  }
}

export function setSeedCrystalInjectionOverride(installRoot: string, enabled: boolean): SeedCrystalControlState {
  const next = { ...readSeedCrystalControl(installRoot), injectionOverride: enabled };
  writeControl(installRoot, next);
  return next;
}

export function scheduleSeedCrystalOmission(installRoot: string, crystalId: string): SeedCrystalControlState {
  const next: SeedCrystalControlState = {
    ...readSeedCrystalControl(installRoot),
    omitNext: { crystalId, requestedAt: new Date().toISOString(), freshThreadOnly: true },
  };
  writeControl(installRoot, next);
  return next;
}

export function consumeSeedCrystalOmission(installRoot: string): SeedCrystalControlState["omitNext"] {
  const current = readSeedCrystalControl(installRoot);
  if (!current.omitNext) return undefined;
  const omission = current.omitNext;
  const { omitNext: _removed, ...next } = current;
  writeControl(installRoot, next);
  return omission;
}

function writeControl(installRoot: string, state: SeedCrystalControlState): void {
  const path = seedCrystalControlPath(installRoot);
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  renameSync(temporary, path);
}
