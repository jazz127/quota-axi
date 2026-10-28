import { providerFetch } from "./lib/http.js";

/** Unofficial forecasts of an extra Codex reset event in the next 24 hours. */
export const RESET_PREDICTION_SOURCES = [
  "codex-reset",
  "lunarwerx",
  "resetbeacon",
  "gussuri",
  "recodex",
] as const;
export type ResetPredictionSource = (typeof RESET_PREDICTION_SOURCES)[number];
export type ResetPredictionReading = {
  source: ResetPredictionSource;
  verdict: "reset" | "none" | "unavailable";
  probabilityPercent?: number;
};
export type ResetPredictionAggregate = {
  readings: ResetPredictionReading[];
  predicting: number;
  answered: number;
  unavailable: number;
  percent?: number;
};

const ENDPOINTS: Record<ResetPredictionSource, string> = {
  "codex-reset": "https://codex-reset.com/api/forecast",
  lunarwerx: "https://codex.lunarwerx.com/api/v1/forecast",
  resetbeacon: "https://resetbeacon.com/api/forecast",
  gussuri: "https://codex.gussuriworks.com/api/current?locale=en",
  recodex: "https://recodex.lol/api/index",
};
const MIN_POLL_MS: Record<ResetPredictionSource, number> = {
  "codex-reset": 60_000,
  lunarwerx: 300_000,
  resetbeacon: 60_000,
  gussuri: 600_000,
  recodex: 300_000,
};
const recentReads = new Map<
  ResetPredictionSource,
  { at: number; reading: ResetPredictionReading; expiresAt?: number }
>();

type ParsedForecast = { probabilityPercent: number; expiresAt: number };

/** A source votes yes only at 50% or more; missing evidence never votes no. */
export function aggregateResetPredictions(
  readings: ResetPredictionReading[],
): ResetPredictionAggregate {
  const answered = readings.filter(
    (reading) => reading.verdict !== "unavailable",
  ).length;
  const predicting = readings.filter(
    (reading) => reading.verdict === "reset",
  ).length;
  return {
    readings,
    predicting,
    answered,
    unavailable: readings.length - answered,
    ...(answered > 0
      ? { percent: Math.round((predicting / answered) * 100) }
      : {}),
  };
}

export function resetPredictionWording(
  result: ResetPredictionAggregate,
): string {
  const count = result.readings.length;
  const unavailable = result.unavailable
    ? `; ${result.unavailable} unavailable`
    : "";
  return result.answered === 0
    ? `Third-party extra Codex reset prediction unavailable (0 of ${count} sources answered)`
    : `Third-party extra Codex reset predictions (next 24h): ${result.predicting} of ${result.answered} answering sources predict a reset (${result.percent}%)${unavailable}`;
}

export async function fetchResetPredictions(
  selected: readonly ResetPredictionSource[],
  fetcher: typeof providerFetch = providerFetch,
  now: number = Date.now(),
): Promise<ResetPredictionAggregate> {
  const readings = await Promise.all(
    selected.map(async (source): Promise<ResetPredictionReading> => {
      const unavailable: ResetPredictionReading = {
        source,
        verdict: "unavailable",
      };
      const recent =
        fetcher === providerFetch ? recentReads.get(source) : undefined;
      if (
        recent &&
        now - recent.at >= 0 &&
        now - recent.at < MIN_POLL_MS[source]
      ) {
        // The polling interval bounds requests, not the forecast's lifetime.
        // Preserve the parser's inclusive age limit and exclusive validUntil.
        if (
          recent.expiresAt !== undefined &&
          (source === "resetbeacon"
            ? now >= recent.expiresAt
            : now > recent.expiresAt)
        )
          return unavailable;
        return recent.reading;
      }
      // Record the attempt before I/O so failures and in-flight reads also
      // respect the minimum polling interval. Keep only normalized data.
      if (fetcher === providerFetch)
        recentReads.set(source, { at: now, reading: unavailable });
      try {
        const response = await fetcher(ENDPOINTS[source], {
          headers: {
            Accept: "application/json",
            "User-Agent":
              "quota-axi/house (+https://github.com/kunchenguid/quota-axi)",
          },
          signal: AbortSignal.timeout(8_000),
        });
        if (!response.ok) return unavailable;
        const body = await response.text();
        if (body.length > 262_144) return unavailable;
        const forecast = parseForecast(source, JSON.parse(body), now);
        if (forecast === undefined) return unavailable;
        const reading: ResetPredictionReading = {
          source,
          verdict: forecast.probabilityPercent >= 50 ? "reset" : "none",
          probabilityPercent: forecast.probabilityPercent,
        };
        if (fetcher === providerFetch)
          recentReads.set(source, {
            at: now,
            reading,
            expiresAt: forecast.expiresAt,
          });
        return reading;
      } catch {
        return unavailable;
      }
    }),
  );
  return aggregateResetPredictions(readings);
}

/** Only documented, observed fields; a changed or expired shape is unavailable. */
export function parseResetPrediction(
  source: ResetPredictionSource,
  payload: unknown,
  now: number,
): number | undefined {
  return parseForecast(source, payload, now)?.probabilityPercent;
}

function parseForecast(
  source: ResetPredictionSource,
  payload: unknown,
  now: number,
): ParsedForecast | undefined {
  const root = object(payload);
  if (!root) return undefined;
  switch (source) {
    case "codex-reset": {
      return datedForecast(
        percentage(object(root.probabilities)?.model_24h),
        root.updated_at,
        now,
        15 * 60_000,
      );
    }
    case "lunarwerx": {
      if (root.apiVersion !== "1") return undefined;
      return datedForecast(
        fraction(object(root.next24Hours)?.probability),
        root.generatedAt,
        now,
        15 * 60_000,
      );
    }
    case "resetbeacon": {
      if (
        root.displayMode !== "probability" ||
        typeof root.publicationState !== "string" ||
        root.publicationState === "stale" ||
        root.publicationState === "unavailable"
      )
        return undefined;
      const validUntil = instant(root.validUntil);
      if (validUntil === undefined || validUntil <= now) return undefined;
      const probabilityPercent = percentage(
        object(object(root.probabilities)?.h24)?.display,
      );
      return probabilityPercent === undefined
        ? undefined
        : { probabilityPercent, expiresAt: validUntil };
    }
    case "gussuri": {
      const health = object(root.dataHealth);
      if (
        root.schemaVersion !== "public-v1" ||
        health?.overall !== "ok" ||
        health.stale !== false
      )
        return undefined;
      return datedForecast(
        fraction(object(root.viewModel)?.probability24h),
        root.checkedAt,
        now,
        15 * 60_000,
      );
    }
    case "recodex": {
      if (typeof root.version !== "string" || !root.version.startsWith("1."))
        return undefined;
      return datedForecast(
        fraction(root.p24),
        root.computed_at,
        now,
        2 * 60 * 60_000,
      );
    }
  }
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function percentage(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 100
    ? value
    : undefined;
}

function fraction(value: unknown): number | undefined {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= 0 &&
    value <= 1
    ? value * 100
    : undefined;
}

function instant(value: unknown): number | undefined {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Date.parse(value)
        : NaN;
  return Number.isFinite(parsed) ? parsed : undefined;
}

function datedForecast(
  probabilityPercent: number | undefined,
  value: unknown,
  now: number,
  maxAge: number,
): ParsedForecast | undefined {
  const timestamp = instant(value);
  return probabilityPercent !== undefined &&
    timestamp !== undefined &&
    timestamp <= now + 60_000 &&
    now - timestamp <= maxAge
    ? { probabilityPercent, expiresAt: timestamp + maxAge }
    : undefined;
}
