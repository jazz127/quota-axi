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

/** Resolves a lane to the label its card shows. */
export type TuiAccountLabels = (lane: {
  accountKey?: string;
  accountLocator?: { path: string };
}) => string | undefined;

/**
 * The `--tui` lane names, `tui.accountLabels` in the user config file: an
 * object from a lane's locator path (absolute, or `~/`-relative) or its
 * account key to the name its card shows. Paths are compared after `~`
 * expansion and symlink resolution, so a trailing slash or a linked directory
 * names the same lane; any other entry is matched exactly against the lane's
 * account key, so a relative path names nothing. An absent, unreadable, or
 * malformed file or setting names nothing; a non-string or blank label skips
 * only that entry.
 */
export function readTuiAccountLabels(
  file: string = userConfigFilePath(),
): TuiAccountLabels {
  const config = readJsonFile(file);
  const tui = isRecord(config) ? config.tui : undefined;
  const entries = isRecord(tui) ? tui.accountLabels : undefined;
  const paths = new Map<string, string>();
  const accountKeys = new Map<string, string>();
  if (isRecord(entries)) {
    for (const [entry, label] of Object.entries(entries)) {
      if (typeof label !== "string" || !label.trim()) continue;
      const expanded = expandHome(entry);
      if (isAbsolute(expanded))
        paths.set(canonicalPath(expanded), label.trim());
      else accountKeys.set(entry, label.trim());
    }
  }
  return ({ accountKey, accountLocator }) =>
    (accountKey && accountKeys.get(accountKey)) ||
    (accountLocator && paths.size > 0
      ? paths.get(canonicalPath(accountLocator.path))
      : undefined);
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
