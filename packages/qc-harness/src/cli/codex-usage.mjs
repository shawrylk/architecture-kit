// Verified wire: rust-v0.172.0 app-server-protocol/schema/json/{ServerNotification,v2/ThreadTokenUsageUpdatedNotification}.json.
const whole = value => Number.isSafeInteger(value) && value >= 0;
const identity = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

/** Accept only app-server usage, never a rollout or Claude transcript. Cached/reasoning tokens are subsets. */
export function normalizeUsage(event) {
  if (event?.method !== "thread/tokenUsage/updated") return null;
  const params = event.params;
  if (!identity(params?.threadId) || !identity(params?.turnId)) return null;
  const usage = params.tokenUsage;
  for (const part of [usage?.last, usage?.total]) {
    if (!part || !["inputTokens", "cachedInputTokens", "outputTokens", "reasoningOutputTokens", "totalTokens"]
      .every(key => whole(part[key]))) return null;
    if (part.cacheWriteInputTokens !== undefined && !whole(part.cacheWriteInputTokens)) return null;
    if (part.cachedInputTokens > part.inputTokens || part.reasoningOutputTokens > part.outputTokens) return null;
  }
  if (usage.modelContextWindow != null && !whole(usage.modelContextWindow)) return null;
  return { sessionId: params.threadId, turnId: params.turnId, tokens: usage.last.totalTokens };
}
