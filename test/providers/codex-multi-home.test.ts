import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchAccountQuotas,
  inspectAccountAuth,
} from "../../src/providers/accounts.js";
import { quotaJsonReport, renderQuotaToon } from "../../src/render.js";
import { renderQuotaTui } from "../../src/tui.js";
import type { ProviderOptions } from "../../src/types.js";

const original = {
  HOME: process.env.HOME,
  CODEX_HOME: process.env.CODEX_HOME,
  QUOTA_AXI_CODEX_HOMES: process.env.QUOTA_AXI_CODEX_HOMES,
  PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
  QUOTA_AXI_CODEX_BINARY: process.env.QUOTA_AXI_CODEX_BINARY,
  XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
};
const options: ProviderOptions = {
  allowKeychainPrompt: false,
  refreshCredentials: false,
};
let root: string;

beforeEach(() => {
  vi.resetModules();
  root = mkdtempSync(join(tmpdir(), "quota-axi-codex-homes-"));
  process.env.HOME = root;
  process.env.CODEX_HOME = join(root, "selected");
  process.env.PI_CODING_AGENT_DIR = join(root, "missing-pi");
  process.env.QUOTA_AXI_CODEX_BINARY = join(root, "missing-codex");
  process.env.XDG_CACHE_HOME = join(root, "cache");
  delete process.env.QUOTA_AXI_CODEX_HOMES;
  vi.doMock("../../src/lib/process.js", async (importOriginal) => ({
    ...(await importOriginal<typeof import("../../src/lib/process.js")>()),
    findCommandPath: vi.fn(async () => undefined),
  }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.doUnmock("../../src/lib/process.js");
  vi.resetModules();
  for (const [key, value] of Object.entries(original)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(root, { recursive: true, force: true });
});

function home(name: string, accountId: string): string {
  const path = join(root, name);
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, "auth.json"),
    JSON.stringify({
      tokens: { access_token: `token-${accountId}`, account_id: accountId },
    }),
  );
  return path;
}

function stubUsage(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string, init: RequestInit) => {
      const token = String(
        (init.headers as Record<string, string>).authorization,
      );
      const used = token.includes("luna")
        ? 13
        : token.includes("extra")
          ? 50
          : 100;
      return new Response(
        JSON.stringify({
          account_id: token.slice("Bearer token-".length),
          rate_limit: {
            primary_window: {
              used_percent: used,
              limit_window_seconds: 604_800,
              reset_after_seconds: 1_000,
            },
          },
        }),
        { status: 200 },
      );
    }),
  );
}

describe("Codex native home discovery", () => {
  it("keeps the single selected home in the legacy one-row shape", async () => {
    const selected = home("selected", "acct-main");
    stubUsage();
    const adapter = (
      await import("../../src/providers/codex.js")
    ).createCodexAdapter();
    const rows = await fetchAccountQuotas(adapter, options);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.accountKey).toBeUndefined();
    expect(rows[0]).toMatchObject({
      accountLocator: {
        kind: "codex-home",
        path: selected,
        delegateEligible: true,
      },
      windows: [{ percentUsed: 100 }],
    });
  });

  it("reads selected, default, Luna, and configured homes without changing CODEX_HOME", async () => {
    home("selected", "acct-main");
    home(".codex", "acct-default");
    const luna = home(".codex-luna", "acct-luna");
    const extra = home("extra", "acct-extra");
    process.env.QUOTA_AXI_CODEX_HOMES = JSON.stringify([luna, extra, extra]);
    stubUsage();
    const adapter = (
      await import("../../src/providers/codex.js")
    ).createCodexAdapter();
    const rows = await fetchAccountQuotas(adapter, options);
    expect(rows).toHaveLength(4);
    expect(
      rows.map((row) => [
        row.accountKey,
        row.accountLocator,
        row.windows[0]?.percentUsed,
      ]),
    ).toEqual([
      [
        "codex-home",
        {
          kind: "codex-home",
          path: join(root, "selected"),
          delegateEligible: true,
        },
        100,
      ],
      [
        "codex-default",
        {
          kind: "codex-home",
          path: join(root, ".codex"),
          delegateEligible: false,
        },
        100,
      ],
      [
        "codex-luna",
        { kind: "codex-home", path: luna, delegateEligible: false },
        13,
      ],
      [
        expect.stringMatching(/^codex-[a-f0-9]{16}$/),
        { kind: "codex-home", path: extra, delegateEligible: false },
        50,
      ],
    ]);
    expect(process.env.CODEX_HOME).toBe(join(root, "selected"));
    expect(rows[2]?.account?.credentialHome).toBe(join(luna, "auth.json"));
    expect(rows[3]?.account?.credentialHome).toBe(join(extra, "auth.json"));
    const toon = renderQuotaToon(
      {
        schemaVersion: 6,
        generatedAt: new Date().toISOString(),
        providers: rows,
      },
      "quota-axi",
      false,
    );
    expect(toon).toContain("codex-luna");
    expect(toon).toContain("~/.codex-luna/auth.json");
    const tui = renderQuotaTui({
      schemaVersion: 6,
      generatedAt: new Date().toISOString(),
      providers: rows,
    });
    expect(tui).toContain("account codex-luna");
    expect(tui).not.toContain("selected account");
    const lean = quotaJsonReport(
      {
        schemaVersion: 6,
        generatedAt: new Date().toISOString(),
        providers: rows,
      },
      false,
    );
    expect(
      lean.providers.every((row) => row.accountLocator === undefined),
    ).toBe(true);
    expect(lean.providers[2]?.account?.credentialHome).toBe(
      "~/.codex-luna/auth.json",
    );
    const full = quotaJsonReport(
      {
        schemaVersion: 6,
        generatedAt: new Date().toISOString(),
        providers: rows,
      },
      true,
    );
    expect(full.providers[2]?.accountLocator?.path).toBe(luna);
    expect(
      renderQuotaToon(
        {
          schemaVersion: 6,
          generatedAt: new Date().toISOString(),
          providers: rows,
        },
        "quota-axi",
        true,
      ),
    ).toContain(luna);
  });

  it("shows missing and unreadable configured homes without hiding a healthy seat", async () => {
    home("selected", "acct-main");
    const missing = join(root, "missing");
    const unreadable = join(root, "unreadable");
    mkdirSync(join(unreadable, "auth.json"), { recursive: true });
    process.env.QUOTA_AXI_CODEX_HOMES = JSON.stringify([missing, unreadable]);
    stubUsage();
    const adapter = (
      await import("../../src/providers/codex.js")
    ).createCodexAdapter();
    const rows = await fetchAccountQuotas(adapter, options);
    expect(rows).toHaveLength(3);
    expect(rows[0]?.state.status).toBe("fresh");
    expect(rows.slice(1).map((row) => row.accountLocator?.path)).toEqual([
      missing,
      unreadable,
    ]);
    expect(
      rows
        .slice(1)
        .every(
          (row) => row.state.status !== "fresh" && row.windows.length === 0,
        ),
    ).toBe(true);
  });

  it("reports malformed home configuration through shared discovery failure", async () => {
    home("selected", "acct-main");
    process.env.QUOTA_AXI_CODEX_HOMES = '["relative-home"]';
    stubUsage();
    const adapter = (
      await import("../../src/providers/codex.js")
    ).createCodexAdapter();
    const rows = await fetchAccountQuotas(adapter, options);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      state: {
        status: "fresh",
        degradedSources: [
          { source: "account-discovery", error: "invalid_home_configuration" },
        ],
      },
    });
    expect(rows[0]?.attempts).toContainEqual({
      source: "account-discovery",
      status: "failed",
      error: "invalid_home_configuration",
    });
    const auth = await inspectAccountAuth(adapter, options);
    expect(auth[0]?.sources).toContainEqual({
      source: "account-discovery",
      status: "error",
      error: "invalid_home_configuration",
    });
  });

  it("leaves a rejected expired sibling refreshable and unmeasured", async () => {
    home("selected", "acct-main");
    const sibling = home(".codex-luna", "acct-luna");
    const expired = `header.${Buffer.from(JSON.stringify({ exp: 1 })).toString("base64url")}.signature`;
    writeFileSync(
      join(sibling, "auth.json"),
      JSON.stringify({
        tokens: {
          access_token: expired,
          account_id: "acct-luna",
          refresh_token: "do-not-read",
        },
      }),
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) =>
        String((init.headers as Record<string, string>).authorization).includes(
          expired,
        )
          ? new Response("", { status: 401 })
          : new Response(
              JSON.stringify({
                account_id: "acct-main",
                rate_limit: {
                  primary_window: {
                    used_percent: 20,
                    limit_window_seconds: 604_800,
                    reset_after_seconds: 1_000,
                  },
                },
              }),
              { status: 200 },
            ),
      ),
    );
    const adapter = (
      await import("../../src/providers/codex.js")
    ).createCodexAdapter();
    const rows = await fetchAccountQuotas(adapter, options);
    expect(rows).toHaveLength(2);
    expect(rows[1]).toMatchObject({
      accountKey: "codex-luna",
      windows: [],
      state: { status: "unavailable", authStatus: "expired_refreshable" },
      accountLocator: { path: sibling, delegateEligible: false },
    });
  });
});
