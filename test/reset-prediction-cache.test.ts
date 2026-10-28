import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ResetPredictionSource } from "../src/reset-predictions.js";

const NOW = Date.parse("2026-10-28T00:00:00.000Z");
const EXPIRES_IN_MS = 30_000;

// Synthetic source responses with only 30 seconds of validity left. All
// transport calls are mocked, but use the default fetch path so caching runs.
const forecasts: Array<{
  source: ResetPredictionSource;
  interval: number;
  payload: Record<string, unknown>;
}> = [
  {
    source: "codex-reset",
    interval: 60_000,
    payload: {
      updated_at: NOW - 15 * 60_000 + EXPIRES_IN_MS,
      probabilities: { model_24h: 80 },
    },
  },
  {
    source: "lunarwerx",
    interval: 300_000,
    payload: {
      apiVersion: "1",
      generatedAt: NOW - 15 * 60_000 + EXPIRES_IN_MS,
      next24Hours: { probability: 0.8 },
    },
  },
  {
    source: "resetbeacon",
    interval: 60_000,
    payload: {
      displayMode: "probability",
      publicationState: "published",
      validUntil: NOW + EXPIRES_IN_MS,
      probabilities: { h24: { display: 80 } },
    },
  },
  {
    source: "gussuri",
    interval: 600_000,
    payload: {
      schemaVersion: "public-v1",
      checkedAt: NOW - 15 * 60_000 + EXPIRES_IN_MS,
      dataHealth: { overall: "ok", stale: false },
      viewModel: { probability24h: 0.8 },
    },
  },
  {
    source: "recodex",
    interval: 300_000,
    payload: {
      version: "1.0.0",
      computed_at: NOW - 2 * 60 * 60_000 + EXPIRES_IN_MS,
      p24: 0.8,
    },
  },
];

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  vi.stubGlobal("fetch", vi.fn());
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("reset prediction cache", () => {
  describe.each(["cached", "fresh", "injected"] as const)(
    "%s reads",
    (path) => {
      it.each(
        forecasts.flatMap((forecast) => [
          { ...forecast, offset: -1, answered: 1 },
          {
            ...forecast,
            offset: 0,
            answered: forecast.source === "resetbeacon" ? 0 : 1,
          },
          { ...forecast, offset: 1, answered: 0 },
        ]),
      )(
        "checks $source expiry after a sibling settles at deadline $offset ms",
        async ({ source, payload, offset, answered }) => {
          const { fetchResetPredictions } =
            await import("../src/reset-predictions.js");
          if (path === "cached") {
            vi.mocked(fetch).mockResolvedValueOnce(Response.json(payload));
            expect(await fetchResetPredictions([source])).toMatchObject({
              answered: 1,
            });
          }
          vi.mocked(fetch).mockReset();
          let finishSlowRead!: (response: Response) => void;
          const slowResponse = new Promise<Response>((resolve) => {
            finishSlowRead = resolve;
          });
          const transport = vi.fn((input: string | URL | Request) =>
            String(input).includes(source)
              ? Promise.resolve(Response.json(payload))
              : slowResponse,
          );
          vi.mocked(fetch).mockImplementation(transport);
          const sibling = source === "recodex" ? "lunarwerx" : "recodex";
          vi.setSystemTime(NOW + EXPIRES_IN_MS - 1_000);
          const pending = fetchResetPredictions(
            [source, sibling],
            path === "injected" ? transport : undefined,
          );
          vi.setSystemTime(NOW + EXPIRES_IN_MS + offset);
          finishSlowRead(new Response("busy", { status: 503 }));

          expect(await pending).toEqual({
            readings: [
              answered
                ? { source, verdict: "reset", probabilityPercent: 80 }
                : { source, verdict: "unavailable" },
              { source: sibling, verdict: "unavailable" },
            ],
            predicting: answered,
            answered,
            unavailable: 2 - answered,
            ...(answered ? { percent: 100 } : {}),
          });
          expect(transport).toHaveBeenCalledTimes(path === "cached" ? 1 : 2);
        },
      );
    },
  );

  it.each([
    { elapsed: EXPIRES_IN_MS - 1, answered: 1 },
    { elapsed: EXPIRES_IN_MS, answered: 0 },
    { elapsed: EXPIRES_IN_MS + 1, answered: 0 },
  ])(
    "advances explicit now by the response's $elapsed ms duration",
    async ({ elapsed, answered }) => {
      const { fetchResetPredictions } =
        await import("../src/reset-predictions.js");
      const wallTime = NOW + 86_400_000;
      vi.setSystemTime(wallTime);
      const fetcher = vi.fn(async () => {
        vi.setSystemTime(wallTime + elapsed);
        return Response.json({
          displayMode: "probability",
          publicationState: "published",
          validUntil: NOW + EXPIRES_IN_MS,
          probabilities: { h24: { display: 80 } },
        });
      });

      expect(
        await fetchResetPredictions(["resetbeacon"], fetcher, NOW),
      ).toMatchObject({ answered, unavailable: 1 - answered });
    },
  );

  it.each(forecasts)(
    "expires a cached $source vote without polling before its interval",
    async ({ source, interval, payload }) => {
      const { fetchResetPredictions, resetPredictionWording } =
        await import("../src/reset-predictions.js");
      vi.mocked(fetch).mockImplementation(async () => Response.json(payload));

      const initial = await fetchResetPredictions([source]);
      expect(initial).toMatchObject({
        predicting: 1,
        answered: 1,
        percent: 100,
      });
      vi.setSystemTime(NOW + EXPIRES_IN_MS - 1);
      expect(await fetchResetPredictions([source])).toEqual(initial);

      // Reset Beacon's explicit deadline is exclusive; maximum-age cutoffs
      // for timestamped sources retain their existing inclusive boundary.
      vi.setSystemTime(NOW + EXPIRES_IN_MS);
      expect((await fetchResetPredictions([source])).answered).toBe(
        source === "resetbeacon" ? 0 : 1,
      );
      vi.setSystemTime(NOW + EXPIRES_IN_MS + 1);
      const expired = await fetchResetPredictions([source]);
      expect(expired).toEqual({
        readings: [{ source, verdict: "unavailable" }],
        predicting: 0,
        answered: 0,
        unavailable: 1,
      });
      expect(resetPredictionWording(expired)).toContain(
        "unavailable (0 of 1 sources answered)",
      );
      expect(fetch).toHaveBeenCalledTimes(1);

      vi.setSystemTime(NOW + interval);
      await fetchResetPredictions([source]);
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );

  it.each([
    {
      failure: "network error",
      respond: async () => {
        throw new Error("synthetic failure");
      },
    },
    {
      failure: "HTTP rejection",
      respond: async () => new Response("busy", { status: 503 }),
    },
    { failure: "malformed JSON", respond: async () => new Response("{bad") },
    {
      failure: "oversized body",
      respond: async () => new Response(" ".repeat(262_145)),
    },
    { failure: "invalid forecast", respond: async () => Response.json({}) },
  ])(
    "throttles a $failure and retries when the interval ends",
    async ({ respond }) => {
      const { fetchResetPredictions } =
        await import("../src/reset-predictions.js");
      vi.mocked(fetch).mockImplementationOnce(respond);
      const unavailable = await fetchResetPredictions(["codex-reset"]);
      expect(unavailable).toMatchObject({ answered: 0, unavailable: 1 });

      vi.mocked(fetch).mockImplementation(async () =>
        Response.json({
          updated_at: NOW,
          probabilities: { model_24h: 80 },
        }),
      );
      vi.setSystemTime(NOW + 59_999);
      expect(await fetchResetPredictions(["codex-reset"])).toEqual(unavailable);
      expect(fetch).toHaveBeenCalledTimes(1);

      vi.setSystemTime(NOW + 60_000);
      expect(await fetchResetPredictions(["codex-reset"])).toMatchObject({
        predicting: 1,
        answered: 1,
        percent: 100,
      });
      expect(fetch).toHaveBeenCalledTimes(2);
    },
  );
});
