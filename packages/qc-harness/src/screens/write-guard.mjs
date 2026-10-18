import { requireLocalhost } from "./map.mjs";

const mutationName = /save|delete|submit|send|complete|upload|confirm|保存|削除|登録|送信|確定|竣工|アップロード|完了|取消|解除/i;

/** Branch: all navigation shares one list of mutation controls. */
export function safeControl(control) {
  return control.type !== "submit" && !mutationName.test(control.text ?? control.name ?? "");
}

/** Branch: only explicit local opt-in and Auth0 sign-in permit writes. */
export function permitsRequest(method, value, target, allowWrites = false) {
  const url = new URL(value);
  if (["GET", "HEAD", "OPTIONS"].includes(method)) return ["http:", "https:"].includes(url.protocol);
  if (target.auth?.domain === url.hostname && url.protocol === "https:" && /^\/(?:u\/login(?:\/|$)|oauth\/token$|usernamepassword\/login$|co\/authenticate$)/.test(url.pathname)) return true;
  if (!allowWrites) return false;
  try { requireLocalhost(target.baseUrl); requireLocalhost(url.href); return true; } catch { return false; }
}

/** Resource: the browser aborts requests before they reach a write endpoint. */
export async function installWriteGuard(context, target, { allowWrites = false, onBlocked = () => {} } = {}) {
  await context.route("**/*", async route => {
    const request = route.request();
    if (permitsRequest(request.method(), request.url(), target, allowWrites)) await route.fallback();
    else { onBlocked(); await route.abort("blockedbyclient"); }
  });
}
