# Architecture harness

The `qc` command checks architecture rules and compares application screens.
See the [repository README](https://github.com/shawrylk/architecture-kit#readme) for the architecture gates.

## Compare screen pairs

`qc screens` captures two applications with Playwright and compares their pixels with `pixelmatch`.
Install Google Chrome before the first capture.

```sh
npx qc screens --map screens.json --targets legacy,mono --out captures
npx qc screens --map screens.json --targets legacy,mono --out captures --only projects
npx qc screens --map screens.json --targets legacy,mono --out captures --changed mono
```

The map names each target's origin, authentication mode, and selector for a signed-in page.
Each screen names a path and optional selectors for navigation, masks, and readiness.

```json
{
  "widths": [2514, 390],
  "targets": {
    "legacy": {
      "baseUrl": "https://legacy.example.com",
      "auth": {
        "mode": "browser-session",
        "domain": "tenant.auth0.com",
        "path": "/login",
        "signedIn": "[data-testid=account-menu]"
      }
    },
    "mono": {
      "baseUrl": "https://mono.example.com",
      "auth": {
        "mode": "browser-session",
        "domain": "tenant.auth0.com",
        "path": "/bff/login",
        "signedIn": "[data-testid=account-menu]"
      }
    }
  },
  "screens": [{
    "name": "projects",
    "targets": {
      "legacy": { "path": "/projects", "ready": "main", "masks": [".timestamp"] },
      "mono": { "path": "/projects", "ready": "main", "masks": [".timestamp"] }
    }
  }]
}
```

For each screen target, `clicks` is an ordered list of selectors for navigation controls.
Use `{ "selector": "[data-guide-skip]", "optional": true }` for an onboarding control that can be absent.
Capture navigation refuses mutation controls.
Capture, discovery, and `open` block write requests unless you pass `--allow-writes`, which permits writes to localhost only.
The guard also permits the Auth0 requests needed for sign-in. Service workers stay blocked in every browser context.
Use `ready` to identify loaded content, and `masks` to cover data that differs between environments.
A page that polls never reaches network idle. Set `"idle": false` on its target, or `idle: { legacy: false }` on a catalog entry, and the capture waits for `ready` only.
Captures use a fixed viewport, disabled animations, and a hidden caret.
The default height is 900 pixels; `--height` changes it.

`qc screens auth <target> --map screens.json --headed` tries saved state, a copy of Chrome's active profile, and a headed sign-in.
Unattended commands use saved state and silent refresh.
Chrome decrypts its own cookies. The tool excludes the password store from the copy.
State lives at `~/.qc/screens/state/<auth0-domain>.json`.
The copied profile lives at `~/.qc/screens/profile-<pid>-<time>/profile`. The tool deletes the copy on close.
Saved state contains cookies and origins for the target host and `auth.domain` only.
These files stay outside repositories. Targets on one tenant share the state file.
The tool leaves password entry on hosted sites to you.
Use `--timeout` for page operations and `--sign-in-timeout` for the headed sign-in, both in milliseconds.

For localhost, `seed-login` reads the fields named by `userField` and `passwordField` from `seedFile`.
JSON supports dotted field paths. A source file supports named fields with literal string values, without evaluating code.
The file path is relative to the map. Credentials stay in memory.
This mode also requires `userSelector`, `passwordSelector`, `submitSelector`, and `signedIn`.
It refuses other hosts and blocks requests that leave localhost during sign-in.

The output contains `<screen>/<target>@<width>.png`, red differences in `<screen>/pair@<width>.png`, and a static `index.html` gallery.
`report.json` sorts the percentage of changed pixels from greatest to smallest.
`--only` preserves other report rows. `--changed <target>` reuses the other target's captures.
The cache refuses images whose origin, navigation, masks, or viewport differ from the map.

## Use the screen commands

Each command accepts `--map <json>`. Use `--timeout <milliseconds>` for page operations.

| Command | What it does | Main flags |
| --- | --- | --- |
| `open <name>` | Opens a mapped screen in Chrome and waits until you close the window. | `--target <name>`, `--height <pixels>`, `--out <dir>`, `--allow-writes` |
| `discover` | Explores routes and navigation states, and saves inventories and screenshots. | `--target <name>`, `--out <dir>`, `--depth <levels>`, `--max-states <count>`, `--allow-writes` |
| `pair` | Matches states from two saved discoveries and writes `pairs.json`. | `--targets <left,right>`, `--out <dir>` |
| `coverage` | Checks discovered states against catalog entries and exclusions, and writes `coverage.json`. | `--target <name>` (optional), `--out <dir>` |
| `scaffold` | Writes catalog modules for discovered states and preserves existing files. | `--target <name>` (optional), `--out <dir>`, `--catalog-out <dir>` |

`--out` selects the directory for discovery artifacts and the input directory for `pair`, `coverage`, and `scaffold`.
For `open`, it selects the directory for screenshots of failed catalog steps.
`scaffold` uses `<out>/catalog` unless you set `--catalog-out`.
`coverage` checks all discoveries unless you set `--target`.
`scaffold` reads all discoveries unless you set `--target`.

## Run the tests

Run `npm test` for the unit tests.
Run `npm run test:browser` for the browser tests with installed Google Chrome.
