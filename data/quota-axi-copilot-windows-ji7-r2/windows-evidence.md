# Windows Copilot secure-store evidence

Date: 2026-09-20. Owned host: JI7, Windows x64. This records one selected public account in an existing interactive console session. It does not establish every Windows version, architecture, account, custom home, enterprise host, or session type.

## Observed binding

The official Copilot CLI **1.0.86** default profile selected `lastLoggedInUser.host = https://github.com` and a valid GitHub login. After vendor browser authorization completed, that profile had no plaintext `copilotTokens` property. Metadata-only inspection found exactly one matching Copilot credential:

| Field                   | Observed value or relationship                                                                            |
| ----------------------- | --------------------------------------------------------------------------------------------------------- |
| Native type             | Generic (`CRED_TYPE_GENERIC`, 1)                                                                          |
| Native TargetName       | `https://github.com:<selected login>.copilot-cli`                                                         |
| Native UserName         | `https://github.com:<selected login>`                                                                     |
| cmdkey display notation | `LegacyGeneric:target=` followed by the native TargetName                                                 |
| Value                   | Bounded UTF-16 literal supported GitHub token; established by the successful reader and quota probe below |

The reader does not use `LegacyGeneric:target=` as part of its API lookup. It checks the returned type, target, and username exactly and never enumerates or substitutes another native item. The metadata diagnostic captured `cmdkey` output in memory and retained only the selected binding's sanitized shape/booleans. Unrecognized target segments were represented only by their lengths, never their contents. No credential blobs were read by that diagnostic. An early diagnostic incorrectly grouped indented blank lines; splitting on Target headings corrected it before any value read.

[GitHub's authentication documentation](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli) establishes the service and backend but does not promise the exact mapping. Static inspection of the official Windows binary's embedded compressed runtime identified `windows-native-keyring-store` **1.1.0**. Its [published default mapping](https://docs.rs/windows-native-keyring-store/1.1.0/windows_native_keyring_store/) is corroborating evidence, not a substitute for the selected live metadata observation. No library source was copied into this implementation.

## Live one-shot proof

The built task package was exercised through its actual `copilot.fetchQuota` adapter in the qualified console user's session. The probe redirected the legacy apps and gh file selectors to absent task-local paths, isolating the selected native source. Child-process and HTTP wrappers enforced a maximum of one native reader invocation and one GET to `https://api.github.com/copilot_internal/user`, with redirects rejected. A non-secret exclusive-create lock prevented rerunning the probe. The wrappers did not substitute the native result, HTTP response, or normalizer.

| Sanitized observation      | Result                                        |
| -------------------------- | --------------------------------------------- |
| Native read attempts       | 1                                             |
| Quota requests             | 1                                             |
| Unexpected process/request | false / false                                 |
| HTTP status                | 200                                           |
| Answering source           | `cli`; native attempt succeeded               |
| Provider state             | fresh                                         |
| Numeric quota windows      | 3                                             |
| Known window IDs           | `chat`, `completions`, `premium_interactions` |

The successful call proves the exact reader decoded a supported literal token and that this account could read the endpoint at that moment. No retry, additional quota call, token refresh, or top-up was performed. The native secret and raw response stayed in memory. Output retained only the table's non-secret facts: no token, token length, account identity, raw quota response, headers, or usage figures. The adapter wrote only its normal non-secret consent marker to a task-isolated cache directory; the probe did not invoke the CLI's quota-cache persistence. JavaScript/CLR strings and OS pipe buffers cannot be guaranteed zeroized.

The tested npm package was produced from this task worktree (`quota-axi-0.1.47.tgz`, SHA-256 `443d7c627b0eefebbcf2c6657a7e39f0fdb04211f17d93aabc443e95a48c2441`). Its production dependency tree was prepared locally with scripts disabled and copied to JI7 after remote npm setup failed. This tested the compiled adapter, not a new published npm release. Later deterministic validation and any pipeline revisions are separate evidence; this single authorized native proof must not be silently repeated.

## Implementation and deterministic checks

- `src/lib/windows-credential.ts` owns the bounded `CredReadW` transport. It has no vendor selector discovery, enumeration, write, login, refresh, or fallback. It checks returned type/target/username, caps the blob at 2560 bytes, strictly decodes UTF-16, clears its temporary byte array and frees the native buffer. Captured child stdout is an in-memory pipe. Errors and unexpected output become fixed non-secret outcomes. Windows PowerShell runs without a profile, noninteractively, with a 10-second timeout and bounded output.
- `src/providers/copilot-cli-credential.ts` binds that transport to the empirically observed selected public/default profile. It shares consent, account-switch revalidation, literal-token validation and non-secret grant machinery with the macOS path. Windows plain calls and ordinary auth inspect only config metadata; `CredReadW` is never used as a presence probe.
- Synthetic tests cover pre-consent refusal, account-bound grant reuse, selection changes, exact lookup, malformed/oversized output, missing item versus missing logon session, binding mismatch, denial, timeout, source handover and sanitization. Tests mock OS and HTTP boundaries; they do not access the developer's credential stores. The cross-provider credential invariant table includes Windows native-source failures superseded by gh.
- Before the real credential proof, the compiled helper ran once on JI7 with a unique synthetic nonexistent target and returned `credential_not_found`. That separately qualified PowerShell compilation and native absent-item handling in the session.
- Before pipeline validation: `pnpm test` passed all 1,492 tests in 60 files; build, lint, formatting and generated-skill consistency checks passed. These deterministic checks do not enlarge the native validation matrix. No-mistakes outcomes are recorded with delivery.

## Host and consent boundary

Management SSH uses the supplied management account. All Credential Manager work ran in the existing console user's session (session 1, `UserInteractive: true`) through temporary tasks with `LogonType Interactive`. The correct principal was AzureAD-backed; treating its short name as a local-machine account caused `0x80070534`. Non-secret `Win32_ComputerSystem.UserName` and Explorer owner/SID metadata resolved that setup error. No CI service identity was used for Copilot auth.

The console user initially had no available Node, Copilot CLI, gh CLI, or default Copilot config. Portable Node **22.23.2** and official npm `@github/copilot-win32-x64` **1.0.86** were installed in a task-specific LocalAppData directory without changing the system PATH. Node's archive checksum matched the vendor's published SHA-256, `1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97`.

The first browser authorization expired before completion; a non-secret recheck found no config and no remaining login process. The explicitly requested second web-flow login completed, and metadata established the selected native entry before the approved read. Plaintext fallback was not accepted. Login and installation were separately authorized host preparation, not product behavior: quota-axi still never launches Copilot, logs in, or migrates storage.

The Windows APIs' [logon-session contract](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw) and [credential structure](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw) underpin the helper. A missing or inaccessible service/SSH credential set cannot prove the desktop user's absence. Linux remains unsupported for native Copilot secure storage; no libsecret adapter was added. No broad credential dump, refresh-token exchange, plaintext backend, upstream pull request, or merge is part of this task.

Task-created scheduled-task registrations, diagnostic files, downloaded archives, the live proof script/lock and its isolated consent-marker cache were removed after verification. The requested Node/Copilot installations and the built quota-axi runtime remain in the interactive user's task-specific LocalAppData directory. No credential was deleted or migrated.
