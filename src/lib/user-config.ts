import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { AxiError } from "axi-sdk-js";
import type { TuiShow } from "../tui.js";
import {
  RESET_PREDICTION_SOURCES,
  type ResetPredictionSource,
} from "../reset-predictions.js";
import { readJsonFile } from "./fs.js";

/**
 * The user-level quota-axi configuration file:
 * `$XDG_CONFIG_HOME/quota-axi/config.json`, or `~/.config/quota-axi/config.json`
 * when `XDG_CONFIG_HOME` is unset. Optional Codex reset forecasts are also
 * selected here; absent selection causes no third-party request.
 */
export function userConfigFilePath(
  environment: Record<string, string | undefined> = process.env,
): string {
  const base = environment.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "quota-axi", "config.json");
}

/**
 * The `--tui` direction preference, `tui.show` in the user config file. Only
 * the exact values `used` and `remaining` are recognized; an absent,
 * unreadable, or malformed file, and any other value, keep the default
 * remaining view.
 */
export function readTuiShowPreference(
  file: string = userConfigFilePath(),
): TuiShow {
  const config = readJsonFile(file);
  const tui = isRecord(config) ? config.tui : undefined;
  const show = isRecord(tui) ? tui.show : undefined;
  return show === "used" ? "used" : "remaining";
}

/** Explicit selection only. A present but invalid selection is an error. */
export function readResetPredictionSources(
  file: string = userConfigFilePath(),
): ResetPredictionSource[] {
  const config = readJsonFile(file);
  if (!isRecord(config) || !Object.hasOwn(config, "codex")) return [];
  if (!isRecord(config.codex)) return invalidSelection();
  if (!Object.hasOwn(config.codex, "resetPredictionSources")) return [];
  const selected = config.codex.resetPredictionSources;
  if (
    !Array.isArray(selected) ||
    selected.some(
      (source) =>
        typeof source !== "string" ||
        !RESET_PREDICTION_SOURCES.includes(source as ResetPredictionSource),
    ) ||
    new Set(selected).size !== selected.length
  )
    return invalidSelection();
  return selected as ResetPredictionSource[];
}

function invalidSelection(): never {
  throw new AxiError(
    "Invalid codex.resetPredictionSources in quota-axi config.json",
    "VALIDATION_ERROR",
    [`Choose unique source names from: ${RESET_PREDICTION_SOURCES.join(", ")}`],
  );
}

/** Resolves a lane's `accountLocator.path` to the label its card shows. */
export type TuiAccountLabels = (locatorPath: string) => string | undefined;

/**
 * The `--tui` lane names, `tui.accountLabels` in the user config file: an
 * object from a lane's locator path (absolute, or `~/`-relative) to the name
 * its card shows. Paths are compared after `~` expansion and symlink
 * resolution, so a trailing slash or a linked directory names the same lane.
 * An absent, unreadable, or malformed file or setting names nothing; a
 * relative path, a non-string label, or a blank label skips only that entry.
 */
export function readTuiAccountLabels(
  file: string = userConfigFilePath(),
): TuiAccountLabels {
  const config = readJsonFile(file);
  const tui = isRecord(config) ? config.tui : undefined;
  const entries = isRecord(tui) ? tui.accountLabels : undefined;
  const labels = new Map<string, string>();
  if (isRecord(entries)) {
    for (const [path, label] of Object.entries(entries)) {
      const expanded = expandHome(path);
      if (!isAbsolute(expanded) || typeof label !== "string") continue;
      const trimmed = label.trim();
      if (trimmed) labels.set(canonicalPath(expanded), trimmed);
    }
  }
  return (locatorPath) =>
    labels.size === 0 ? undefined : labels.get(canonicalPath(locatorPath));
}

function expandHome(path: string): string {
  return path.startsWith("~/") ? join(homedir(), path.slice(2)) : path;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
