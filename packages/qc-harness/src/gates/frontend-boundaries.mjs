// Platform remains a thin substrate and never holds feature domain logic or junk drawer directories.
// docs/architecture.md, docs/ui.md.

const DEFAULT_MAX_FOLDER_FILES = 10;
const DEFAULT_EXEMPT_DIRS = [
  "platform/ui/primitives",
  "platform/ui/patterns",
  "platform/ui/layout",
  "platform/ui/domain",
  "platform/i18n/dictionaries",
];

const DOMAIN_LEAK_PATTERNS = [
  {
    pattern: /(?:^|\/)platform\/shell\/(?:chrome\/)?(photo-viewer[^/]*\.[cm]?[jt]sx?)/,
    domain: "photos",
    suggestion: "Relocate photo-viewer components to features/photos/components/photo-viewer",
  },
  {
    pattern: /(?:^|\/)platform\/shell\/(drawing-viewer(?:\/.*)?)/,
    domain: "blueprints",
    suggestion: "Relocate drawing-viewer components to features/blueprints/components/drawing-viewer",
  },
  {
    pattern: /(?:^|\/)platform\/shell\/(inspections(?:\/.*)?)/,
    domain: "inspections",
    suggestion: "Relocate inspections panels and modals to features/inspections/components/",
  },
];

const INVERTED_IMPORT_PATTERNS = [
  {
    pattern: /from\s+["'].*\/platform\/shell\/chrome\/photo-viewer(?:\.js)?["']/,
    domain: "photo-viewer",
    suggestion: "Import photo-viewer from features/photos/components/photo-viewer",
  },
  {
    pattern: /from\s+["'].*\/platform\/shell\/drawing-viewer\/[^"']+["']/,
    domain: "drawing-viewer",
    suggestion: "Import drawing-viewer from features/blueprints/components/drawing-viewer",
  },
  {
    pattern: /from\s+["'].*\/platform\/shell\/inspections\/[^"']+["']/,
    domain: "inspections",
    suggestion: "Import inspection components from features/inspections/components/",
  },
];

function classifyStemDomain(basename) {
  const stem = basename.replace(/\.test\.[cm]?[jt]sx?$/, "").replace(/\.[cm]?[jt]sx?$/, "");
  if (/^(?:use-)?session|auth-gate/.test(stem)) return "auth";
  if (/^theme-/.test(stem)) return "theme";
  if (/^language-/.test(stem)) return "i18n";
  if (/preference/.test(stem)) return "preferences";
  if (/^photo-viewer/.test(stem)) return "photos";
  if (/^account-|personal-settings|ai-quota|settings-menu/.test(stem)) return "account";
  if (/^app-|project-.*-chrome|error-boundary|home-screen/.test(stem)) return "chrome";
  return "other";
}

/**
 * @param {{path: string, contents?: string}[]} platformFiles
 * @param {{path: string, contents: string}[]} featureFiles
 * @param {{maxFolderFiles?: number, exemptDirs?: string[]}} [options]
 * @returns {{path: string, rule: string, detail: string}[]}
 */
export function checkFrontendBoundaries(platformFiles, featureFiles = [], options = {}) {
  // Only platformFiles' paths are ever split on "/" below — featureFiles' paths are matched
  // by content and only ever displayed, so an absolute OS path there is not this bug. A
  // backslash in a platformFiles path means a caller's path helper broke cross-platform
  // normalization — fail loud rather than silently bucket every file under one fake
  // directory, the way the junk-drawer-folder gate once did on Windows.
  for (const file of platformFiles) {
    if (file.path.includes("\\")) {
      throw new Error(`frontend-boundaries: "${file.path}" carries a backslash — pass forward-slash paths`);
    }
  }

  const problems = [];
  const maxFiles = options.maxFolderFiles ?? DEFAULT_MAX_FOLDER_FILES;
  const exemptDirs = new Set(options.exemptDirs ?? DEFAULT_EXEMPT_DIRS);

  // 1. Check for domain leaks into platform/
  const reportedLeakDirs = new Set();
  for (const file of platformFiles) {
    for (const { pattern, domain, suggestion } of DOMAIN_LEAK_PATTERNS) {
      const match = pattern.exec(file.path);
      if (match) {
        // Group by directory if it's a folder leak, or report specific file
        const leakKey = file.path.includes("platform/shell/drawing-viewer")
          ? "platform/shell/drawing-viewer"
          : file.path.includes("platform/shell/inspections")
          ? "platform/shell/inspections"
          : file.path;

        if (!reportedLeakDirs.has(leakKey)) {
          reportedLeakDirs.add(leakKey);
          problems.push({
            path: leakKey,
            rule: "domain-in-platform",
            detail: `Feature domain logic '${domain}' found in platform substrate. Suggestion: ${suggestion}`,
          });
        }
        break;
      }
    }
  }

  // 2. Check for junk drawer folders in platform/
  const filesByDir = new Map();
  for (const file of platformFiles) {
    const parts = file.path.split("/");
    const dir = parts.slice(0, -1).join("/");
    const filename = parts[parts.length - 1];
    if (!filesByDir.has(dir)) filesByDir.set(dir, []);
    filesByDir.get(dir).push(filename);
  }

  for (const [dir, files] of filesByDir) {
    if ([...exemptDirs].some((exempt) => dir.includes(exempt))) continue;
    // Only count source files (exclude tests from raw count threshold)
    const sourceFiles = files.filter((f) => /\.[cm]?[jt]sx?$/.test(f) && !f.includes(".test."));
    if (sourceFiles.length > maxFiles) {
      const domains = new Set();
      for (const f of sourceFiles) {
        domains.add(classifyStemDomain(f));
      }
      domains.delete("other");
      if (domains.size >= 3) {
        problems.push({
          path: dir,
          rule: "junk-drawer-folder",
          detail: `Folder contains ${sourceFiles.length} files mixing ${domains.size} unrelated domains (${[...domains].join(", ")}). Suggestion: decompose into focused platform modules (platform/auth, platform/preferences, platform/account) and move feature components to features/.`,
        });
      }
    }
  }

  // 3. Check for inverted feature imports
  for (const file of featureFiles) {
    if (!file.contents) continue;
    for (const { pattern, domain, suggestion } of INVERTED_IMPORT_PATTERNS) {
      if (pattern.test(file.contents)) {
        problems.push({
          path: file.path,
          rule: "inverted-feature-import",
          detail: `Feature imports '${domain}' from platform shell. Suggestion: ${suggestion}`,
        });
      }
    }
  }

  return problems;
}
