import { homedir } from "node:os";
import { join } from "node:path";
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
