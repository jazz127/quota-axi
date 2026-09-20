import { chmodSync, existsSync, renameSync, writeFileSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
  copilotCliKeychainAccessMarkerPath,
  ensurePrivateParent,
  readBoundedFile,
} from "../lib/fs.js";
import { execFileText } from "../lib/process.js";
import { readWindowsGenericPassword } from "../lib/windows-credential.js";
import type { AuthSourceReport, ProviderOptions } from "../types.js";

export const COPILOT_CLI_SOURCE = "copilot-cli:keychain";
const SERVICE = "copilot-cli";
const FILE_LIMIT = 1024 * 1024;
const TOKEN_LIMIT = 16 * 1024;

function copilotCliConfigPath(
  home = process.env.COPILOT_HOME || join(homedir(), ".copilot"),
): string {
  return join(home, "config.json");
}

export async function copilotCliConfigAbsent(): Promise<boolean> {
  try {
    await lstat(copilotCliConfigPath());
    return false;
  } catch (error) {
    return code(error) === "ENOENT";
  }
}

type Identity = { host: string; login: string; account: string };
export type CopilotCliCredentialResolution =
  | { status: "resolved"; token: string; report: AuthSourceReport }
  | {
      status: "absent" | "structurally_invalid" | "unsupported" | "read_error";
      report: AuthSourceReport;
    };

type Dependencies = {
  environment: Readonly<Record<string, string | undefined>>;
  platform: NodeJS.Platform;
  homeDirectory: () => string;
  readFile: typeof readBoundedFile;
  run: typeof execFileText;
  readWindows: typeof readWindowsGenericPassword;
  hasGrant: (path: string, account: string) => boolean;
  recordGrant: (path: string, account: string) => void;
};

/**
 * Default-profile binding: macOS CLI 1.0.87-0 uses service copilot-cli and
 * account `${host}:${login}`. Windows CLI 1.0.86 uses a generic credential with
 * target `${account}.copilot-cli` and username `${account}`. See README for
 * the empirical validation boundary. Refuse unverified
 * selectors instead of guessing item names or trying another user's item.
 * See README's Copilot credential notes for the supported boundary.
 */
export async function resolveCopilotCliCredential(
  options: ProviderOptions,
  presenceOnly = false,
  overrides: Partial<Dependencies> = {},
): Promise<CopilotCliCredentialResolution> {
  const deps: Dependencies = {
    environment: process.env,
    platform: process.platform,
    homeDirectory: homedir,
    readFile: readBoundedFile,
    run: execFileText,
    readWindows: readWindowsGenericPassword,
    hasGrant: (path, account) =>
      existsSync(copilotCliKeychainAccessMarkerPath(path, SERVICE, account)),
    recordGrant,
    ...overrides,
  };
  const defaultHome = join(deps.homeDirectory(), ".copilot");
  const home = deps.environment.COPILOT_HOME || defaultHome;
  const path = copilotCliConfigPath(home);
  const state = (
    status: Exclude<CopilotCliCredentialResolution["status"], "resolved">,
    error?: string,
  ): CopilotCliCredentialResolution => ({
    status,
    report: {
      source: COPILOT_CLI_SOURCE,
      path,
      status:
        status === "absent"
          ? "missing"
          : status === "unsupported"
            ? "skipped"
            : status === "read_error"
              ? "error"
              : "invalid",
      ...(error ? { error } : {}),
      ...(status === "absent" ? {} : { credentialPresent: true }),
    },
  });
  let raw: Buffer;
  try {
    raw = await deps.readFile(path, FILE_LIMIT);
  } catch (error) {
    return code(error) === "ENOENT"
      ? state("absent")
      : state("read_error", "file_read_error");
  }
  if (raw.byteLength > FILE_LIMIT)
    return state("structurally_invalid", "config_too_large");
  let identity: Identity | undefined;
  try {
    identity = selectedIdentity(raw);
  } catch {
    return state("structurally_invalid", "credentials_invalid");
  }
  if (!identity) return state("unsupported", "selected_account_unconfirmed");
  if (deps.platform !== "darwin" && deps.platform !== "win32")
    return state("unsupported", "secure_store_unsupported");
  if (resolve(home) !== resolve(defaultHome))
    return state("unsupported", "copilot_home_unsupported");
  // Presence only: never inspect an environment credential's value.
  if (
    [
      "COPILOT_GITHUB_TOKEN",
      "GH_TOKEN",
      "GITHUB_TOKEN",
      "COPILOT_GH_HOST",
      "GH_HOST",
    ].some((name) => Object.hasOwn(deps.environment, name))
  ) {
    return state("unsupported", "environment_selection_unsupported");
  }
  if (identity.host !== "https://github.com")
    return state("unsupported", "selected_host_unsupported");
  const valueAllowed =
    !presenceOnly &&
    (options.allowKeychainPrompt || deps.hasGrant(path, identity.account));
  let value: string;
  if (deps.platform === "win32") {
    // CredRead returns the secret along with metadata. Until consent is
    // established, inspect only the CLI's selected identity, never the vault.
    if (!valueAllowed) return state("unsupported", "keychain_prompt_required");
    const result = await deps.readWindows(
      { target: `${identity.account}.${SERVICE}`, username: identity.account },
      { run: deps.run, systemRoot: deps.environment.SystemRoot },
    );
    if (result.status !== "resolved")
      return state(
        result.reason === "credential_format_unsupported"
          ? "structurally_invalid"
          : "read_error",
        result.reason,
      );
    value = result.value;
  } else {
    const args = [
      "find-generic-password",
      "-s",
      SERVICE,
      "-a",
      identity.account,
    ];
    try {
      value = await deps.run(
        "/usr/bin/security",
        valueAllowed ? [...args, "-w"] : args,
        valueAllowed ? 60_000 : 5_000,
        TOKEN_LIMIT,
      );
    } catch (error) {
      const failure = error as {
        killed?: boolean;
        signal?: unknown;
        code?: unknown;
      } | null;
      if (failure?.killed || failure?.signal)
        return state("read_error", "keychain_prompt_timeout");
      if (code(error) === 44)
        return state("read_error", "keychain_item_unavailable");
      return state(
        "read_error",
        valueAllowed
          ? "keychain_access_denied"
          : "keychain_presence_check_failed",
      );
    }
  }
  if (!valueAllowed) return state("unsupported", "keychain_prompt_required");
  const token = value.replace(/[\r\n]+$/, "");
  if (
    token.length > TOKEN_LIMIT ||
    !/^(?:gho_|ghu_|github_pat_)[A-Za-z0-9_]+$/.test(token)
  ) {
    return state("structurally_invalid", "credential_format_unsupported");
  }
  // A profile switch while the OS prompt was open invalidates this reading.
  try {
    const current = await deps.readFile(path, FILE_LIMIT);
    if (
      current.byteLength > FILE_LIMIT ||
      selectedIdentity(current)?.account !== identity.account
    ) {
      return state("unsupported", "selected_account_changed");
    }
  } catch {
    return state("read_error", "selected_account_unconfirmed");
  }
  deps.recordGrant(path, identity.account);
  return {
    status: "resolved",
    token,
    report: {
      source: COPILOT_CLI_SOURCE,
      path,
      status: "available",
      credentialPresent: true,
    },
  };
}

function selectedIdentity(raw: Buffer): Identity | undefined {
  // Only full-line comments are removed: an https:// host must remain intact.
  const data: unknown = JSON.parse(
    raw
      .toString("utf8")
      .split(/\r?\n/)
      .filter((line) => !line.trimStart().startsWith("//"))
      .join("\n"),
  );
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new Error();
  const selected = (data as Record<string, unknown>).lastLoggedInUser;
  if (!selected || typeof selected !== "object" || Array.isArray(selected))
    return undefined;
  const { host, login } = selected as Record<string, unknown>;
  if (
    typeof host !== "string" ||
    typeof login !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/.test(login)
  )
    return undefined;
  // No canonicalization of the lookup key: only the observed host spelling is
  // supported, even when another spelling would normalize to github.com.
  return { host, login, account: `${host}:${login}` };
}

function code(error: unknown): unknown {
  return error && typeof error === "object" && "code" in error
    ? error.code
    : undefined;
}

function recordGrant(path: string, account: string): void {
  try {
    const file = copilotCliKeychainAccessMarkerPath(path, SERVICE, account);
    ensurePrivateParent(file);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, "granted\n", { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
    chmodSync(file, 0o600);
  } catch {
    /* A marker failure cannot change the successful credential read. */
  }
}
