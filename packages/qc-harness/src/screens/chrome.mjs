// The screen commands launch Google Chrome as the `chrome` channel, and a machine may not have it.

const MISSING = /is not found at|Executable doesn't exist|not installed/i;

/**
 * Why a test that launches Chrome cannot run here, or false when it can. `QC_REQUIRE_CHROME=1` makes a missing
 * Chrome a failure, so CI never passes by skipping.
 * @param {{launch: (options: object) => Promise<{close: () => Promise<void>}>}} chromium the Playwright browser type
 * @returns {Promise<string | false>}
 */
export async function chromeMissing(chromium) {
  if (process.env.QC_REQUIRE_CHROME === "1") return false;
  try {
    const browser = await chromium.launch({ channel: "chrome" });
    await browser.close();
    return false;
  } catch (error) {
    if (!MISSING.test(error?.message ?? "")) return false;
    return "Google Chrome is not installed. Set QC_REQUIRE_CHROME=1 to fail instead of skip.";
  }
}
