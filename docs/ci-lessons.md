# CI lessons

Each entry names a failed test and preserves its symptom, cause, and rule.
Add resolved failures before the merge, and lessons for open records whose branch merges into `worktree.base`.
Keep the fields on separate lines.
CI records identify their repository as `owner/name`; holds apply only to records that match the local `origin` repository.
The prompt reads `Rule:` lines from the bottom of this file, at most 20 rules and 2,000 characters.

## headed auth accepts the named target and saves a valid session

Symptom: The headed authentication test fails in CI; the recorded evidence does not name the OS.
Cause: The test depends on a headed browser, the named target, and a writable session destination.
Rule: Verify the named target and the saved session with the headed browser environment that CI uses.

## integrate uses GIT_AUTHOR_EMAIL with absent local user.email

Symptom: Integration fails when local Git email configuration is absent; the recorded evidence does not name the OS.
Cause: Git can obtain the author email from the environment instead of local configuration.
Rule: Honor GIT_AUTHOR_EMAIL when local user.email is absent.

## redaction replaces every shared secret shape

Symptom: A redaction assertion fails in CI; the recorded evidence does not name the OS.
Cause: Shared secrets have several shapes that need the same redaction policy.
Rule: Cover every shared secret shape in the redaction tests.

## listen EADDRINUSE 127.0.0.1:39821

Symptom: A test fails with EADDRINUSE on port 39821; the recorded evidence does not name the OS.
Cause: Parallel tests compete for a fixed port.
Rule: Bind test servers to port zero and read the assigned port.

## Windows EBUSY cleanup

Symptom: Temporary folder cleanup fails with EBUSY on Windows.
Cause: A process or filesystem handle can retain a file briefly after the test ends.
Rule: Use rmSync with recursive, force, maxRetries, and retryDelay for temporary folder cleanup on Windows.

## --affected with one changed gate file runs that gate's test file and not an unrelated one

Symptom: cmd.exe reports that the Node command is not recognized on Windows.
Cause: The fixture wraps inline JavaScript in single quotes, which cmd.exe does not treat as shell quoting.
Rule: A package.json script in a fixture holds no quotes, because npm runs it through cmd.exe on Windows.

## scope covers committed, index, tracked and untracked files including an unborn HEAD

Symptom: writeFileSync fails with ENOENT for the quoted old path on Windows.
Cause: Windows forbids double quotes in file names.
Rule: Use a quote-free fixture path on Windows and retain quoted-path coverage on other systems.

## overview prints at most 60 lines on a repo with 200 files

Symptom: writeFileSync fails with ENOENT for the newline path on Windows.
Cause: Windows forbids newlines in file names.
Rule: Create newline-named fixture files and run their associated assertions only outside Windows.

## merge guard names unseen PR and linked issue comments until a prompt acknowledges them

Symptom: the guard denies with "gh returned no base commit" on ubuntu-latest.
Cause: the fake `gh` in `comment-watch.test.mjs` had no answer for the new `git/ref/heads` call. The affected test selection missed this file, because it runs the guard in a child process.
Rule: When a change adds a `gh` call, search every test file for a fake `gh` and give it an answer.

## a stalled Windows remote loses its transport process at the deadline

Symptom: "the remote transport kept its socket open" on windows-latest, after 10 seconds.
Cause: a flake. The milestone did not change `commit-guard.mjs`, and the same test passed on main and on the next head.
Rule: none: a flake that passed on a rerun

## run lines share the git common directory, append, and count malformed records

Symptom: "Missing expected exception." at `run-log.test.mjs:30` on windows-latest.
Cause: on Windows, a read of `<file>/child` fails with `ENOENT`, and `readRuns` returns an empty log for `ENOENT`. Linux gives `ENOTDIR`.
Rule: To prove a read error on every OS, read a folder and match `EISDIR|EPERM|EACCES`.
