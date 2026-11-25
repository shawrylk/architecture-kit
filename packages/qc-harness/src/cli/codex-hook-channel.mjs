import { codexWorkerRestricted } from "./codex-runtime.mjs";

// One configured event producer: codex-hook composes context/actions and fixed worker handback.
// Aliases must not independently route the same event or enter legacy root policy.
export function codexHookChannel(env = process.env, canonical = false) {
  const configured = env.QC_CODEX_REPORT_PORT !== undefined || env.QC_CODEX_REPORT_TOKEN !== undefined;
  if (configured && !canonical) throw new Error("configured events require qc codex-hook");
  if (!configured && codexWorkerRestricted(env)) throw new Error("worker report channel required");
  return configured;
}

/** Bound raw bytes before decoding; replacement UTF-8 must never repair native input. */
export async function readCodexNativeInput(stdin) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 65536) throw new Error("native input exceeds 64 KiB");
    chunks.push(buffer);
  }
  return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks));
}
