/** The fragment that normalizes a promotion branch from the config or PR metadata. */
export const promotionBranchName = (branch) => branch?.replace(/^origin\//, "");
