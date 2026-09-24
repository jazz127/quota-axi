import type {
  AuthProviderReport,
  ProviderAccount,
  ProviderAdapter,
  ProviderOptions,
  ProviderQuota,
} from "../types.js";

/** A provider could not enumerate its configured account routes reliably. */
export class AccountDiscoveryError extends Error {
  constructor(readonly reason: string) {
    super(reason);
    this.name = "AccountDiscoveryError";
  }
}

type Discovery = { accounts?: ProviderAccount[]; failure?: string };

/**
 * Discovery belongs to the adapter; collection never interprets credentials.
 *
 * A key is user-editable configuration, so a malformed or repeated one - which
 * would land in cache slots and output join columns - costs only its own lane:
 * the rest still expand, because one unusable entry must not hide the accounts
 * beside it. Discovery exceptions are different: enumeration cannot be
 * trusted, so the selected reader is used and the failure is published as
 * `account-discovery` evidence.
 */
async function accountsFor(
  adapter: ProviderAdapter,
  options: ProviderOptions,
): Promise<Discovery> {
  if (options.credentialMode === "profile-only") return {};
  let accounts: ProviderAccount[] | undefined;
  try {
    accounts = await adapter.discoverAccounts?.();
  } catch (error) {
    return {
      failure:
        error instanceof Error && error.name === "AccountDiscoveryError"
          ? "reason" in error && typeof error.reason === "string"
            ? error.reason
            : "account_discovery_failed"
          : "account_discovery_failed",
    };
  }
  if (!accounts?.length) return {};
  const keys = new Set<string>();
  const usable = accounts.filter((account) => {
    if (
      !/^[a-z0-9][a-z0-9:_-]{0,95}$/.test(account.accountKey) ||
      keys.has(account.accountKey)
    )
      return false;
    keys.add(account.accountKey);
    return true;
  });
  return usable.length > 0 ? { accounts: usable } : {};
}

export async function fetchAccountQuotas(
  adapter: ProviderAdapter,
  options: ProviderOptions,
): Promise<ProviderQuota[]> {
  const { accounts, failure } = await accountsFor(adapter, options);
  if (!accounts) {
    const report = await adapter.fetchQuota(options);
    if (failure) {
      const attempt = {
        source: "account-discovery",
        status: "failed" as const,
        error: failure,
      };
      report.attempts = [...(report.attempts ?? []), attempt];
      report.state.sourcesTried = [
        ...new Set([...(report.state.sourcesTried ?? []), attempt.source]),
      ];
      if (report.state.status === "fresh")
        report.state.degradedSources = [
          ...(report.state.degradedSources ?? []),
          { source: attempt.source, error: failure },
        ];
    }
    return [report];
  }
  // Keep each adapter's declaration order, including failed accounts. Readers
  // return their own structured failure; no account selects a sibling's token.
  const readings: { account: ProviderAccount; report: ProviderQuota }[] = [];
  for (const account of accounts) {
    let report: ProviderQuota | undefined;
    try {
      report = await account.fetchQuota(options);
    } catch {
      // Never serialize an unexpected error: it may contain a path or token.
      report = {
        provider: adapter.id,
        label: adapter.label,
        source: "unavailable",
        windows: [],
        state: {
          status: "error",
          stale: false,
          error: "account_read_failed",
          sourcesTried: [],
        },
      };
    }
    if (report) readings.push({ account, report });
  }
  for (const { account, report } of readings) {
    if (accounts.length > 1) report.accountKey = account.accountKey;
    report.accountKeys = coveredAccountKeys(
      account.accountKey,
      report.accountKeys,
    );
    report.accountLocator ??= account.locator;
  }
  return readings.map(({ report }) => report);
}

/**
 * Credential keys one account row covers.
 *
 * The lane's own key is first. A provider that folded other credentials into
 * the lane lists them after it, in the order it recorded them. Callers that
 * hold a credential key match the row by membership, not by `accountKey` alone.
 */
export function coveredAccountKeys(
  accountKey: string,
  covered: readonly string[] | undefined,
): string[] {
  const keys = [accountKey];
  for (const key of covered ?? []) {
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

export async function inspectAccountAuth(
  adapter: ProviderAdapter,
  options: ProviderOptions,
): Promise<AuthProviderReport[]> {
  const { accounts, failure } = await accountsFor(adapter, options);
  if (!accounts) {
    const report = await adapter.inspectAuth(options);
    if (failure)
      report.sources.push({
        source: "account-discovery",
        status: "error",
        error: failure,
      });
    return [report];
  }
  const reports: AuthProviderReport[] = [];
  for (const account of accounts) {
    let report: AuthProviderReport;
    try {
      report = await account.inspectAuth(options);
    } catch {
      report = {
        provider: adapter.id,
        sources: [
          { source: "account", status: "error", error: "account_read_failed" },
        ],
      };
    }
    reports.push(
      accounts.length === 1
        ? report
        : {
            ...report,
            accountKey: account.accountKey,
          },
    );
  }
  return reports;
}

/**
 * One spelling for the join columns in every flat output block.
 *
 * Expansion is already decided upstream: each command fills every report's
 * `accountKey` with the `default` filler as soon as one report carries a real
 * key (`annotateQuotaAdvice`, `inspectAuth`, `createModelsResponse`). So a key
 * here means the response expanded, and the renderer only copies it across.
 */
export function accountColumns(report: {
  provider: string;
  accountKey?: string;
}): { accountKey?: string } {
  return report.accountKey ? { accountKey: report.accountKey } : {};
}
