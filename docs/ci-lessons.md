# CI lessons

Each entry names a failed test and preserves its symptom, cause, and rule.
Add resolved failures before the merge. Keep the fields on separate lines.
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
