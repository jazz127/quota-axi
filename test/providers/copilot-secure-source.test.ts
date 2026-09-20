import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchQuota, inspectAuth } from "../../src/providers/copilot.js";
import {
  resolveCopilotCliCredential,
  COPILOT_CLI_SOURCE,
} from "../../src/providers/copilot-cli-credential.js";
import { resolveGhCliCredential } from "../../src/providers/gh-cli-credential.js";
import { readJsonFileResult } from "../../src/lib/fs.js";
import { providerFetch } from "../../src/lib/http.js";
import { readCachedProvider } from "../../src/cache.js";
import { renderAuthToon } from "../../src/render.js";
vi.mock("node:fs/promises", () => ({ lstat: vi.fn() }));
vi.mock("../../src/providers/copilot-cli-credential.js", async (actual) => ({
  ...(await actual<
    typeof import("../../src/providers/copilot-cli-credential.js")
  >()),
  COPILOT_CLI_SOURCE: "copilot-cli:keychain",
  resolveCopilotCliCredential: vi.fn(),
}));
vi.mock("../../src/providers/gh-cli-credential.js", () => ({
  GH_CLI_CREDENTIAL_SOURCE: "gh:hosts.yml",
  resolveGhCliCredential: vi.fn(),
}));
vi.mock("../../src/lib/http.js", () => ({ providerFetch: vi.fn() }));
vi.mock("../../src/cache.js", () => ({ readCachedProvider: vi.fn() }));
vi.mock("../../src/lib/fs.js", async (actual) => ({
  ...(await actual<typeof import("../../src/lib/fs.js")>()),
  readJsonFileResult: vi.fn(),
}));
const options = { allowKeychainPrompt: false, refreshCredentials: false };
const nativeToken = "gho_native_synthetic";
const body = {
  copilot_plan: "individual",
  quota_snapshots: { chat: { percent_remaining: 80 } },
};
function response(status = 200, headers?: HeadersInit) {
  return new Response(JSON.stringify(body), { status, headers });
}
function nativeUnavailable(error: string) {
  vi.mocked(resolveCopilotCliCredential).mockResolvedValue({
    status: "unsupported",
    report: {
      source: COPILOT_CLI_SOURCE,
      status: "skipped",
      error,
      credentialPresent: true,
    },
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("COPILOT_HOME", "/synthetic/copilot");
  vi.mocked(lstat).mockRejectedValue(
    Object.assign(new Error(), { code: "ENOENT" }),
  );
  vi.mocked(readJsonFileResult).mockReturnValue({ status: "missing" });
  vi.mocked(resolveCopilotCliCredential).mockResolvedValue({
    status: "resolved",
    token: nativeToken,
    report: { source: COPILOT_CLI_SOURCE, status: "available" },
  });
  vi.mocked(resolveGhCliCredential).mockResolvedValue({
    status: "resolved",
    path: "/synthetic/gh/hosts.yml",
    token: "gho_gh_synthetic",
  });
  vi.mocked(providerFetch).mockImplementation(async () => response());
  vi.mocked(readCachedProvider).mockReturnValue(undefined);
});
afterEach(() => vi.unstubAllEnvs());
describe("Copilot secure-source integration", () => {
  it.each([
    ["present", false],
    ["absent", true],
    ["unreadable", false],
  ] as const)(
    "allows legacy cache after apps transport failure only for confirmed native absence: %s",
    async (metadata, stale) => {
      vi.mocked(readJsonFileResult).mockReturnValue({
        status: "success",
        value: { "github.com": { oauth_token: "gho_apps_synthetic" } },
      });
      const cached = await fetchQuota(options);
      vi.mocked(readCachedProvider).mockReturnValue(cached);
      if (metadata === "present")
        vi.mocked(lstat).mockResolvedValue(
          {} as Awaited<ReturnType<typeof lstat>>,
        );
      else
        vi.mocked(lstat).mockRejectedValue(
          Object.assign(new Error(), {
            code: metadata === "absent" ? "ENOENT" : "EACCES",
          }),
        );
      vi.mocked(providerFetch)
        .mockClear()
        .mockRejectedValue(new Error("network failed"));
      const result = await fetchQuota(options);
      expect(result.state.stale).toBe(stale);
      expect(result.windows).toEqual(stale ? cached.windows : []);
      expect(lstat).toHaveBeenCalledExactlyOnceWith(
        join("/synthetic/copilot", "config.json"),
      );
      expect(providerFetch).toHaveBeenCalledOnce();
      expect(resolveCopilotCliCredential).not.toHaveBeenCalled();
      expect(resolveGhCliCredential).not.toHaveBeenCalled();
    },
  );

  it("keeps apps precedence and never even resolves the secure source when apps works", async () => {
    vi.mocked(readJsonFileResult).mockReturnValue({
      status: "success",
      value: { "github.com": { oauth_token: "gho_apps_synthetic" } },
    });
    expect((await fetchQuota(options)).state.status).toBe("fresh");
    expect(resolveCopilotCliCredential).not.toHaveBeenCalled();
    expect(resolveGhCliCredential).not.toHaveBeenCalled();
  });
  it("hands rejected apps to native and rejected native to gh in order", async () => {
    vi.mocked(readJsonFileResult).mockReturnValue({
      status: "success",
      value: { "github.com": { oauth_token: "gho_apps_synthetic" } },
    });
    vi.mocked(providerFetch)
      .mockResolvedValueOnce(response(401))
      .mockResolvedValueOnce(response(403))
      .mockResolvedValueOnce(response());
    const result = await fetchQuota(options);
    expect(result.state.status).toBe("fresh");
    expect(result.attempts?.map((a) => a.source)).toEqual([
      "api",
      COPILOT_CLI_SOURCE,
      "gh:hosts.yml",
    ]);
    expect(
      vi
        .mocked(providerFetch)
        .mock.calls.map((c) => new Headers(c[1]?.headers).get("authorization")),
    ).toEqual([
      "Bearer gho_apps_synthetic",
      `Bearer ${nativeToken}`,
      "Bearer gho_gh_synthetic",
    ]);
    expect(JSON.stringify(result)).not.toContain(nativeToken);
  });
  it("reports native provenance and numeric quota, with no redirects", async () => {
    const result = await fetchQuota(options);
    expect(result).toMatchObject({
      source: "cli",
      windows: [{ id: "chat", percentRemaining: 80 }],
    });
    expect(providerFetch).toHaveBeenCalledWith(
      "https://api.github.com/copilot_internal/user",
      expect.objectContaining({ redirect: "error" }),
    );
    expect(resolveGhCliCredential).not.toHaveBeenCalled();
  });
  it("keeps entitlement without numeric quota distinct from source failure", async () => {
    vi.mocked(providerFetch).mockResolvedValue(
      new Response(JSON.stringify({ copilot_plan: "individual" })),
    );
    expect(await fetchQuota(options)).toMatchObject({
      windows: [],
      state: { status: "fresh" },
    });
  });
  it.each([
    [401, undefined],
    [403, undefined],
  ] as const)(
    "hands native HTTP %s rejection to gh without assuming entitlement",
    async (status) => {
      vi.mocked(providerFetch).mockResolvedValueOnce(response(status));
      expect((await fetchQuota(options)).state.status).toBe("fresh");
      expect(resolveGhCliCredential).toHaveBeenCalledOnce();
    },
  );
  it.each([
    [403, { "x-ratelimit-remaining": "0" }, "rate_limited"],
    [429, {}, "rate_limited"],
    [500, {}, "error"],
  ] as const)("stops on native HTTP %s", async (status, headers, expected) => {
    vi.mocked(providerFetch).mockResolvedValueOnce(response(status, headers));
    expect((await fetchQuota(options)).state.status).toBe(expected);
    expect(resolveGhCliCredential).not.toHaveBeenCalled();
  });
  it.each(["network", "decode"])(
    "sanitizes %s failure and stops handover",
    async (kind) => {
      if (kind === "network")
        vi.mocked(providerFetch).mockRejectedValueOnce(new Error(nativeToken));
      else
        vi.mocked(providerFetch).mockResolvedValueOnce(
          new Response(nativeToken),
        );
      const result = await fetchQuota(options);
      expect(result.state.status).toBe("error");
      expect(JSON.stringify(result)).not.toContain(nativeToken);
      expect(resolveGhCliCredential).not.toHaveBeenCalled();
    },
  );
  it.each([
    "secure_store_unsupported",
    "copilot_home_unsupported",
    "keychain_access_denied",
    "keychain_prompt_timeout",
    "keychain_item_unavailable",
    "credential_not_found",
    "credential_logon_session_unavailable",
    "credential_access_denied",
    "credential_binding_mismatch",
    "credential_format_unsupported",
    "credential_read_timeout",
    "credential_read_failed",
  ])("does not call an unmeasured source a sign-out: %s", async (reason) => {
    nativeUnavailable(reason);
    vi.mocked(resolveGhCliCredential).mockResolvedValue({
      status: "absent",
      path: "/synthetic/gh",
    });
    const result = await fetchQuota(options);
    expect(result.state).toMatchObject({
      status: "unavailable",
      error: reason,
    });
    expect(result.state.remedyCommand).toBeUndefined();
    expect(providerFetch).not.toHaveBeenCalled();
    expect(
      renderAuthToon([await inspectAuth(options)], "/bin/quota-axi"),
    ).not.toContain("--allow-keychain-prompt");
  });
  it("offers a prompt remedy only for a prompt-gated item", async () => {
    nativeUnavailable("keychain_prompt_required");
    vi.mocked(resolveGhCliCredential).mockResolvedValue({
      status: "absent",
      path: "/synthetic/gh",
    });
    expect((await fetchQuota(options)).state).toMatchObject({
      status: "unavailable",
      reason: "keychain_access_required",
    });
    const auth = await inspectAuth(options);
    expect(resolveCopilotCliCredential).toHaveBeenLastCalledWith(options, true);
    expect(renderAuthToon([auth], "/bin/quota-axi")).toContain(
      "--allow-keychain-prompt",
    );
  });
  it("does not reuse a native account's cache after source or account change", async () => {
    const cached = await fetchQuota(options);
    vi.mocked(readCachedProvider).mockReturnValue(cached);
    vi.mocked(resolveCopilotCliCredential).mockResolvedValue({
      status: "absent",
      report: { source: COPILOT_CLI_SOURCE, status: "missing" },
    });
    vi.mocked(resolveGhCliCredential).mockResolvedValue({
      status: "absent",
      path: "/synthetic/gh",
    });
    expect((await fetchQuota(options)).state.stale).toBe(false);
    nativeUnavailable("selected_account_changed");
    expect((await fetchQuota(options)).state.status).toBe("unavailable");
  });
});
