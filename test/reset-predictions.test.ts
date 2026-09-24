import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { readResetPredictionSources } from "../src/lib/user-config.js";
import { renderQuotaToon } from "../src/render.js";
import {
  aggregateResetPredictions,
  fetchResetPredictions,
  parseResetPrediction,
  resetPredictionWording,
  RESET_PREDICTION_SOURCES,
} from "../src/reset-predictions.js";
import { renderQuotaTui } from "../src/tui.js";
import { fixtureResponse } from "./fixtures/tui-response.js";

const CAPTURE = "docs/evidence/codex-reset-prediction-2026-09-25";
const CAPTURED_AT = Date.parse("2026-09-24T14:59:15.000Z");

describe("third-party Codex reset forecasts", () => {
  it("parses the five captured public JSON shapes as 24h forecasts", () => {
    const expected = [20, 31.3, 22, 35.71999636201681, 48.86328902590806];
    RESET_PREDICTION_SOURCES.forEach((source, index) => {
      const payload = JSON.parse(
        readFileSync(`${CAPTURE}/${source}.json`, "utf8"),
      );
      expect(parseResetPrediction(source, payload, CAPTURED_AT)).toBeCloseTo(
        expected[index],
        4,
      );
    });
  });

  it("treats missing, changed, expired, and out-of-range figures as unavailable", () => {
    expect(
      parseResetPrediction(
        "codex-reset",
        { probabilities: { rounded_24h: 0 } },
        CAPTURED_AT,
      ),
    ).toBeUndefined();
    expect(
      parseResetPrediction(
        "lunarwerx",
        {
          apiVersion: "2",
          generatedAt: new Date(CAPTURED_AT).toISOString(),
          next24Hours: { probability: 1 },
        },
        CAPTURED_AT,
      ),
    ).toBeUndefined();
    expect(
      parseResetPrediction(
        "resetbeacon",
        {
          displayMode: "probability",
          publicationState: "stale",
          validUntil: new Date(CAPTURED_AT + 1000).toISOString(),
          probabilities: { h24: { display: 80 } },
        },
        CAPTURED_AT,
      ),
    ).toBeUndefined();
    expect(
      parseResetPrediction(
        "gussuri",
        {
          schemaVersion: "public-v1",
          checkedAt: new Date(CAPTURED_AT).toISOString(),
          dataHealth: { overall: "ok", stale: true },
          viewModel: { probability24h: 0.8 },
        },
        CAPTURED_AT,
      ),
    ).toBeUndefined();
    expect(
      parseResetPrediction(
        "recodex",
        { version: "1.0.1", computed_at: CAPTURED_AT, p24: -0.1 },
        CAPTURED_AT,
      ),
    ).toBeUndefined();
  });

  it("counts only answering sources and says unavailable when none answers", () => {
    const aggregate = aggregateResetPredictions([
      { source: "codex-reset", verdict: "reset", probabilityPercent: 51 },
      { source: "lunarwerx", verdict: "none", probabilityPercent: 49 },
      { source: "resetbeacon", verdict: "reset", probabilityPercent: 50 },
      { source: "gussuri", verdict: "unavailable" },
    ]);
    expect(aggregate).toMatchObject({
      predicting: 2,
      answered: 3,
      unavailable: 1,
      percent: 67,
    });
    expect(resetPredictionWording(aggregate)).toContain(
      "2 of 3 answering sources predict a reset (67%); 1 unavailable",
    );
    const none = aggregateResetPredictions([
      { source: "gussuri", verdict: "unavailable" },
    ]);
    expect(none.percent).toBeUndefined();
    expect(resetPredictionWording(none)).toContain(
      "unavailable (0 of 1 sources answered)",
    );
  });

  it("makes no request with no selected source and makes failed reads unavailable", async () => {
    const fetcher = vi.fn(async () => new Response("{bad", { status: 200 }));
    expect((await fetchResetPredictions([], fetcher)).readings).toEqual([]);
    expect(fetcher).not.toHaveBeenCalled();
    const result = await fetchResetPredictions(
      ["codex-reset"],
      fetcher,
      CAPTURED_AT,
    );
    expect(result).toMatchObject({ answered: 0, unavailable: 1 });
  });

  it("fetches only selected sources and applies the 50% vote threshold", async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (url: string | URL | Request) => {
      urls.push(String(url));
      if (String(url).includes("gussuriworks"))
        throw new Error("synthetic network failure");
      return new Response(
        JSON.stringify(
          String(url).includes("lunarwerx")
            ? {
                apiVersion: "1",
                generatedAt: new Date(CAPTURED_AT).toISOString(),
                next24Hours: { probability: 0.49 },
              }
            : {
                updated_at: new Date(CAPTURED_AT).toISOString(),
                probabilities: { rounded_24h: 50 },
              },
        ),
        { status: 200 },
      );
    });
    const result = await fetchResetPredictions(
      ["lunarwerx", "codex-reset", "gussuri"],
      fetcher,
      CAPTURED_AT,
    );
    expect(urls).toEqual([
      "https://codex.lunarwerx.com/api/v1/forecast",
      "https://codex-reset.com/api/forecast",
      "https://codex.gussuriworks.com/api/current?locale=en",
    ]);
    expect(result).toMatchObject({
      predicting: 1,
      answered: 2,
      unavailable: 1,
      percent: 50,
    });
  });

  it("requires an explicit, valid selection in the existing config file", () => {
    const dir = mkdtempSync(join(tmpdir(), "quota-axi-reset-prediction-"));
    const file = join(dir, "config.json");
    try {
      expect(readResetPredictionSources(file)).toEqual([]);
      writeFileSync(
        file,
        JSON.stringify({
          codex: { resetPredictionSources: ["gussuri", "recodex"] },
        }),
      );
      expect(readResetPredictionSources(file)).toEqual(["gussuri", "recodex"]);
      for (const value of [["unknown"], ["gussuri", "gussuri"], "all", null]) {
        writeFileSync(
          file,
          JSON.stringify({ codex: { resetPredictionSources: value } }),
        );
        expect(() => readResetPredictionSources(file)).toThrow(
          "Invalid codex.resetPredictionSources",
        );
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves off-by-default TOON and TUI unchanged and shows the same opt-in vote", () => {
    const response = fixtureResponse();
    const result = aggregateResetPredictions([
      { source: "codex-reset", verdict: "reset", probabilityPercent: 60 },
      { source: "recodex", verdict: "none", probabilityPercent: 20 },
      { source: "gussuri", verdict: "unavailable" },
    ]);
    const plain = renderQuotaToon(response, "quota-axi", false);
    const human = renderQuotaTui(response, { columns: 80 });
    expect(plain).not.toContain("reset_prediction");
    expect(human).not.toContain("third-party reset");
    expect(plain).toBe(
      renderQuotaToon(response, "quota-axi", false, [], undefined),
    );
    expect(human).toBe(
      renderQuotaTui(response, { columns: 80, resetPrediction: undefined }),
    );
    const optedIn = renderQuotaToon(response, "quota-axi", false, [], result);
    expect(optedIn).toContain(
      "1 of 2 answering sources predict a reset (50%); 1 unavailable",
    );
    expect(optedIn).toContain(
      "selected third parties contacted from your machine",
    );
    expect(optedIn).toContain("https://codex-reset.com/");
    const card = renderQuotaTui(response, {
      columns: 80,
      resetPrediction: result,
    });
    expect(card).toContain("1/2 yes (50%)");
    expect(card).toContain("1 unavailable");
    expect(card).toContain("https://codex-reset.com/");
    const codexOnly = {
      ...response,
      providers: response.providers.filter(
        (provider) => provider.provider === "codex",
      ),
    };
    expect(
      renderQuotaToon(codexOnly, "quota-axi", false, ["codex"], result),
    ).toContain("reset_prediction");
    expect(
      renderQuotaTui(codexOnly, {
        columns: 80,
        presence: ["absent"],
        resetPrediction: result,
      }),
    ).toContain("1/2 yes (50%)");
  });
});
