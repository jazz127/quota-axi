import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const PI_TOKEN = "pi-anthropic-token";
const OAUTH_TOKEN = "claude-oauth-token";
let home: string;

beforeEach(() => {
  vi.resetModules();
  home = mkdtempSync(join(tmpdir(), "quota-axi-claude-pi-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("USERPROFILE", home);
  vi.stubEnv("XDG_CACHE_HOME", join(home, "cache"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(home, ".pi", "agent"));
  vi.stubEnv("CLAUDE_CONFIG_DIR", undefined);
  vi.stubEnv("CLAUDE_CODE_OAUTH_TOKEN", undefined);
  Object.defineProperty(process, "platform", { value: "linux" });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  rmSync(home, { recursive: true, force: true });
});

describe("Claude Pi Anthropic adapter", () => {
  it("uses a healthy Pi Anthropic OAuth entry as the quota source", async () => {
    writePi({
      type: "oauth",
      access: PI_TOKEN,
      expires: Date.now() + 3_600_000,
    });
    mockAnthropic({ token: PI_TOKEN });

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota({ refreshCredentials: false });

    expect(report.source).toBe("oauth");
    expect(report.state.status).toBe("fresh");
    expect(report.attempts).toEqual(
      expect.arrayContaining([{ source: "pi:anthropic", status: "success" }]),
    );
  });

  it("does not use a Pi cache snapshot when an earlier OAuth failure wins", async () => {
    writeClaude({
      accessToken: OAUTH_TOKEN,
      expiresAt: Date.now() + 3_600_000,
    });
    writePi({
      type: "oauth",
      access: PI_TOKEN,
      expires: Date.now() + 3_600_000,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 401 })),
    );

    const { stampClaudePiContext } =
      await import("../../src/providers/claude-cache-context.js");
    const { writeCachedProviders } = await import("../../src/cache.js");
    const cached = {
      provider: "claude" as const,
      label: "Claude",
      source: "oauth" as const,
      windows: [
        {
          id: "five_hour",
          label: "session",
          kind: "session" as const,
          percentUsed: 12,
          resetsAt: new Date(Date.now() + 3_600_000).toISOString(),
        },
      ],
      state: {
        status: "fresh" as const,
        stale: false,
        refreshedAt: new Date(Date.now() - 60_000).toISOString(),
        sourcesTried: ["pi:anthropic"],
      },
    };
    stampClaudePiContext(cached, PI_TOKEN);
    writeCachedProviders([cached]);

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota({ refreshCredentials: false });

    expect(report.state.status).not.toBe("stale");
    expect(report.state.status).toBe("auth_required");
  });

  it("does not hand over a transient stored-source failure to Pi", async () => {
    writeClaude({
      accessToken: OAUTH_TOKEN,
      expiresAt: Date.now() + 3_600_000,
    });
    writePi({
      type: "oauth",
      access: PI_TOKEN,
      expires: Date.now() + 3_600_000,
    });
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
        const authorization = new Headers(init?.headers).get("authorization");
        expect(authorization).toBe(`Bearer ${OAUTH_TOKEN}`);
        return new Response(null, { status: 503 });
      },
    );
    vi.stubGlobal("fetch", fetchMock);

    const { fetchQuota } = await import("../../src/providers/claude.js");
    const report = await fetchQuota({ refreshCredentials: false });

    expect(report.state.status).toBe("error");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

function writePi(value: unknown): void {
  const directory = join(home, ".pi", "agent");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, "auth.json"),
    JSON.stringify({ anthropic: value }),
  );
}

function writeClaude(value: unknown): void {
  const directory = join(home, ".claude");
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    join(directory, ".credentials.json"),
    JSON.stringify({ claudeAiOauth: value }),
  );
}

function mockAnthropic({ token }: { token: string }): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get("authorization");
      expect(authorization).toBe(`Bearer ${token}`);
      const url = String(_input);
      if (url.endsWith("/usage"))
        return new Response(JSON.stringify({ five_hour: { utilization: 2 } }));
      return new Response(JSON.stringify({ account: { uuid: "pi-account" } }));
    }),
  );
}
