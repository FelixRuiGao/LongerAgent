// The upstream worker had a broken wasm import path. Our vendored copy
// already carries the fix, so this is a no-op retained for call-site compat.
export function ensureOpenTuiWorkerPatch(): void {}
