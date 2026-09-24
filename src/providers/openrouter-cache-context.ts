import { createHash } from "node:crypto";

let readingContextId: string | undefined;

export function publishOpenRouterReadingContextId(contextId: string): void {
  readingContextId = contextId;
}

export function clearOpenRouterReadingContextId(): void {
  readingContextId = undefined;
}

export function openRouterReadingContextId(): string | undefined {
  return readingContextId;
}

/** The key is hashed only to keep a changed credential from reusing old data. */
export function openRouterCacheContextId(
  source: string,
  credential: string,
): string {
  const keyDigest = createHash("sha256")
    .update(`openrouter-key-v1\0${credential}`)
    .digest("hex");
  return createHash("sha256")
    .update(`openrouter\0${source}\0${keyDigest}`)
    .digest("hex");
}
