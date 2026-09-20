# Windows secure-store qualification (in progress)

Date: 2026-09-20. This is a partial implementation checkpoint, not a Windows support claim.

## Implemented and checked

`src/lib/windows-credential.ts` implements a bounded, exact `CredReadW` transport for an explicitly supplied generic credential target and username. It has no vendor selector discovery, enumeration, write, login, refresh, or fallback. The caller must establish the binding and consent before invoking it. It checks the returned target, username and type, bounds the blob to the Windows 2560-byte maximum, accepts only a strictly decoded UTF-16 printable ASCII password, frees the native result and clears its temporary byte array. JavaScript/CLR strings and OS pipe buffers cannot be guaranteed zeroized. The subprocess stdout is captured in memory; errors and unexpected output become fixed non-secret outcomes.

The helper is **not wired into Copilot discovery**. Windows continues to report `secure_store_unsupported` until the Copilot-specific binding is confirmed and integration is tested. It does not yet constitute an opt-in Windows Copilot adapter.

- 26 synthetic transport tests pass (`pnpm exec vitest run test/windows-credential.test.ts`). These cover bounded invocation, native outcome classifications, child failures/timeouts, invalid selectors, malformed/oversized output and sanitization. They mock the child-process boundary and do not prove native successful-value decoding.
- TypeScript build and targeted ESLint pass.
- The compiled helper ran once on JI7 in the existing console user's interactive session, using a unique **synthetic nonexistent target**, and returned `credential_not_found` as expected. This proves PowerShell compilation, native API loading and the absent-item path in that session, not a real Copilot read or successful blob decoding.

## Owned-host setup

Management SSH runs as the supplied management user. Credential Manager qualification runs through a temporary scheduled task with `LogonType Interactive`, bound to the actual console user. JI7's console account is AzureAD-backed; treating the displayed short name as a local-machine account caused `0x80070534`. `Win32_ComputerSystem.UserName` and Explorer's `GetOwner`/`GetOwnerSid` established the correct principal. Its successful qualification reported session 1 and `UserInteractive: true`.

That user's initial state had no available Node, Copilot CLI, gh CLI, or default Copilot config. A metadata-only `cmdkey` listing was captured in memory and filtered for `copilot-cli`; it reported zero matching entries. No unrelated credential metadata was printed or retained, and no credential values were read by that check.

Portable Node **22.23.2** and the official npm `@github/copilot-win32-x64` **1.0.86** binary were installed in a task-specific directory under the interactive user's LocalAppData. Node's archive SHA-256 was checked against the vendor's published checksum: `1177b4137ba5adaa56354ae40f1080c7450e8ae09cecb47da459d1c52ac99f97`. This is test setup, not a new quota-axi installer or persistent system PATH change.

## Binding evidence and remaining gap

- [GitHub authentication documentation](https://docs.github.com/en/copilot/how-tos/copilot-cli/set-up-copilot-cli/authenticate-copilot-cli) establishes the `copilot-cli` service and Windows Credential Manager backend, but not the exact target or encoding.
- Static inspection of the official 1.0.86 Windows binary's embedded compressed runtime identifies `windows-native-keyring-store` **1.1.0**. No third-party code was copied into this implementation. The bundled CLI login implementation asks before plaintext storage, with default rejection; plaintext storage is not authorized for this task.
- The [keyring library's published mapping](https://docs.rs/windows-native-keyring-store/1.1.0/windows_native_keyring_store/) defaults to `user.service` and permits overrides. That library fact alone does **not** establish Copilot's configured mapping or how its selected account reaches the library. No guessed target is enabled in the product.
- Microsoft documents [exact target/type lookup and logon-session errors](https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw) and the [credential structure and size bound](https://learn.microsoft.com/en-us/windows/win32/api/wincred/ns-wincred-credentialw).

A Copilot login is still required in the qualified console session. The vendor's `copilot login --web-flow` was launched there for browser authorization. Do not accept a plaintext fallback. Once authenticated, confirm the selected config → exact target/type/username and value shape, integrate the opt-in reader, then run the approved one-shot credential read plus one quota request. Do not print or persist tokens, raw blobs, headers, authentication codes or raw quota responses.

No real Copilot credential read, quota call, full-suite validation, no-mistakes run, push, or pull request has occurred in this Windows task. The final change must document the actual live proof limits; one account on one host cannot establish all versions, accounts, custom homes, enterprise hosts, session types, Windows architectures, or Linux support.

## Sign-in recheck

After firstmate relayed confirmation of browser sign-in, the same AzureAD console session was checked again. Both Windows `USERPROFILE` and Node `os.homedir()` resolved to `C:\Users\JaradSmith`; no `COPILOT_HOME`, `HOME`, or GitHub-token environment override was present. The default `.copilot/config.json` remained absent. The launched login process (PID 21292) had exited, and no process from the installed task Copilot binary remained in session 1. This does not prove successful CLI authorization or establish a selected credential binding. No credential value or quota endpoint was accessed during the recheck.

Firstmate must obtain completed Copilot CLI authorization in this same account, or identify another explicitly approved authenticated interactive account. The installed command is `& "$env:LOCALAPPDATA\quota-axi-windows-ji7-r2\package\copilot.exe" login --web-flow` in that user's PowerShell. Complete the vendor's GitHub Copilot CLI authorization page; decline any plaintext-storage fallback. The task-specific Node/Copilot installations remain available. Temporary diagnostic files and scheduled-task registrations were removed.
