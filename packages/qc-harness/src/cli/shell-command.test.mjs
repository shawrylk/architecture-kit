import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkoutDirs, commandEnv, commandWords, gitCall, isReadOnly, mayWrite, segmentsOf } from "./shell-command.mjs";

const wordsOf = (command) => segmentsOf(command).map((segment) => segment.words);

test("a command splits on unquoted separators, and a quoted separator stays in its word", () => {
  assert.deepEqual(wordsOf(`git add -A && git commit -m "a; b && c" | cat; echo x || true`), [
    ["git", "add", "-A"],
    ["git", "commit", "-m", "a; b && c"],
    ["cat"],
    ["echo", "x"],
    ["true"],
  ]);
});

test("a heredoc body belongs to its command, not to new segments", () => {
  const command = "git commit -F - <<'EOF'\nsubject; with && tokens | here\n\nbody line\nEOF\ngit push";
  assert.deepEqual(wordsOf(command), [["git", "commit", "-F", "-"], ["git", "push"]]);
});

test("a heredoc inside a quoted command substitution stays one word", () => {
  const command = `git commit -m "$(cat <<'EOF'\nsubject; don't split\nEOF\n)"`;
  assert.equal(segmentsOf(command).length, 1);
});

test("a redirect target is recorded apart from the words, and a descriptor copy is not a target", () => {
  const [segment] = segmentsOf("echo x > out.txt 2>/dev/null");
  assert.deepEqual(segment.words, ["echo", "x"]);
  assert.deepEqual(segment.redirects, ["out.txt", "/dev/null"]);
  assert.deepEqual(segmentsOf("npm test 2>&1")[0].redirects, []);
  assert.deepEqual(segmentsOf("cat log >> all.log")[0].redirects, ["all.log"]);
});

test("a git call flags an explicit git dir or work tree, and does not resolve it", () => {
  const explicitOf = (command) => gitCall(segmentsOf(command)[0]).explicitDir;
  for (const command of [
    "git --git-dir=/r/.git status",
    "git --git-dir /r/.git status",
    "GIT_DIR=/r/.git git status",
    "env GIT_DIR=/r/.git git status",
    "git -C /a --git-dir=/r/.git status",
    "git --work-tree=/r status",
    "git --work-tree /r status",
    "GIT_WORK_TREE=/r git status",
  ]) {
    assert.equal(explicitOf(command), true, command);
  }
  for (const command of ["git status", "git -C /a status", "git -c core.x=y status"]) assert.equal(explicitOf(command), false, command);
  assert.deepEqual(gitCall(segmentsOf("git -C /a --git-dir /r/.git status")[0]).dirs, ["/a"], "the git dir is no checkout directory");
  assert.equal(gitCall(segmentsOf("git --git-dir /r/.git status")[0]).sub, "status", "the value is not the subcommand");
});

test("a git call names its subcommand and every -C directory", () => {
  const [segment] = segmentsOf(`GIT_PAGER=cat git -C "C:/a b" -c core.x=y --no-pager commit -m x`);
  assert.deepEqual(gitCall(segment), { sub: "commit", dirs: ["C:/a b"], explicitDir: false, configs: ["core.x=y"], args: ["-m", "x"] });
  assert.equal(gitCall(segmentsOf("gitk --all")[0]), null);
});

test("a backslash inside double quotes stays, unless it escapes a quote, a dollar, or itself", () => {
  const [segment] = segmentsOf(String.raw`git -C "C:\Users\me\wt" commit -m "say \"hi\" for \$5"`);
  assert.deepEqual(segment.words.slice(2), [String.raw`C:\Users\me\wt`, "commit", "-m", 'say "hi" for $5']);
});

test("a read-only command is one whose every segment reads", () => {
  for (const command of [
    "ls -la",
    "cat a.txt | grep b",
    "git status --porcelain",
    "git diff HEAD~1 -- src",
    "rg foo src",
    "sed -n '1,5p' file.ts",
    "head -5 f 2>/dev/null",
    "cd /repo && git log --oneline 2>&1 | tail -3",
  ]) {
    assert.equal(mayWrite(command), false, command);
  }
});

test("any segment that can write makes the command a possible write", () => {
  for (const command of [
    "sed -i 's/a/b/' f.ts",
    "sed -ni.bak 's/a/b/p' f.ts",
    "echo x > f.ts",
    "node scripts/codemod.mjs",
    "python x.py",
    "mv a b",
    "cp a b",
    "rm a",
    "git checkout main -- src",
    "pnpm codegen",
    "npx prettier --write .",
    "ls && tee out.txt",
    "touch f",
    "sort -o out.txt in.txt",
    "uniq in.txt out.txt",
  ]) {
    assert.equal(mayWrite(command), true, command);
  }
});

test("isReadOnly judges one segment", () => {
  assert.equal(isReadOnly(segmentsOf("grep -rn x src")[0]), true);
  assert.equal(isReadOnly(segmentsOf("grep -rn x src > hits.txt")[0]), false);
});

test("the checkout directories are every cd target and every git -C directory, in order", () => {
  assert.deepEqual(checkoutDirs(`cd /repo/a && git -C "../b c" status; git -C /repo/d commit -m x`), [
    "/repo/a",
    "../b c",
    "/repo/d",
  ]);
  assert.deepEqual(checkoutDirs("ls"), []);
  assert.deepEqual(checkoutDirs("echo x > f; git -C"), []);
});

test("a git call carries each -c setting and the words after its subcommand", () => {
  const [segment] = segmentsOf(`git -c core.hooksPath=/dev/null -C repo commit -m "a b" --no-verify`);
  assert.deepEqual(gitCall(segment), {
    sub: "commit",
    dirs: ["repo"],
    explicitDir: false,
    configs: ["core.hooksPath=/dev/null"],
    args: ["-m", "a b", "--no-verify"],
  });
  assert.deepEqual(gitCall(segmentsOf("git --version")[0]), { sub: null, dirs: [], explicitDir: false, configs: [], args: [] });
});

test("the PowerShell escape keeps a backslash literal and escapes with a backtick", () => {
  const powershell = { escape: "`" };
  assert.deepEqual(
    segmentsOf('Set-Content C:\\a\\b.txt "x`"y" ; Get-Item `$HOME', powershell).map((segment) => segment.words),
    [
      ["Set-Content", "C:\\a\\b.txt", 'x"y'],
      ["Get-Item", "$HOME"],
    ],
  );
  assert.deepEqual(segmentsOf("Get-Date > C:\\out\\d.txt", powershell)[0].redirects, ["C:\\out\\d.txt"]);
});

const unwrapped = (command) => commandWords(segmentsOf(command)[0]);

test("env, sudo, command, time, nohup, and timeout are unwrapped by commandWords", () => {
  const GH = ["gh", "pr", "merge", "60"];
  for (const command of [
    "env gh pr merge 60",
    "env -i gh pr merge 60",
    "env -u HOME GH_HOST=x gh pr merge 60",
    "env -- gh pr merge 60",
    "FOO=1 env BAR=2 gh pr merge 60",
    "sudo gh pr merge 60",
    "sudo -E -u root gh pr merge 60",
    "sudo -Hu root GH_HOST=x gh pr merge 60",
    "sudo --user root gh pr merge 60",
    "command gh pr merge 60",
    "command -p gh pr merge 60",
    "time gh pr merge 60",
    "time -p gh pr merge 60",
    "nohup gh pr merge 60",
    "timeout 30 gh pr merge 60",
    "timeout -k 5 -s KILL 30s gh pr merge 60",
    "sudo env command timeout 5 nohup gh pr merge 60",
    "/usr/bin/env gh pr merge 60",
  ]) {
    assert.deepEqual(unwrapped(command), GH, command);
  }
});

test("a wrapper with no command has no words, and one that only looks a program up is left as written", () => {
  assert.deepEqual(unwrapped("command -v gh"), ["command", "-v", "gh"]);
  assert.deepEqual(unwrapped("env"), []);
  assert.deepEqual(unwrapped("sudo -l"), []);
  assert.deepEqual(unwrapped("timeout"), []);
});

test("a git call inside a wrapper is a git call, and a wrapped write is still a write", () => {
  assert.equal(gitCall(segmentsOf("env git commit -n")[0]).sub, "commit");
  assert.equal(gitCall(segmentsOf("sudo -u ci git -C repo push")[0]).dirs[0], "repo");
  assert.equal(mayWrite("env ls -l"), false);
  assert.equal(mayWrite("env rm -rf x"), true);
});

test("the settings a wrapper makes are read with the assignments before it", () => {
  assert.deepEqual(commandEnv(segmentsOf("A=1 env B=2 -u C gh pr merge 60")[0]), { A: "1", B: "2" });
  assert.deepEqual(commandEnv(segmentsOf("sudo GH_HOST=x gh pr view")[0]), { GH_HOST: "x" });
  assert.deepEqual(commandEnv(segmentsOf("gh pr merge GH_HOST=x")[0]), {});
});

test("the keyword that starts a compound command's line is dropped, so the command after it is read", () => {
  const words = (command) => segmentsOf(command).map((segment) => segment.words);
  assert.deepEqual(words("if gh pr merge 60; then echo ok; else echo no; fi"), [
    ["gh", "pr", "merge", "60"],
    ["echo", "ok"],
    ["echo", "no"],
    ["fi"],
  ]);
  assert.deepEqual(words("if true\nthen\n  gh pr merge 60\nfi"), [["true"], ["gh", "pr", "merge", "60"], ["fi"]]);
  assert.deepEqual(words("while true; do gh pr merge 60; done"), [["true"], ["gh", "pr", "merge", "60"], ["done"]]);
  assert.deepEqual(words("until gh pr merge 60; do sleep 1; done")[0], ["gh", "pr", "merge", "60"]);
  assert.deepEqual(words("{ gh pr merge 60; }"), [["gh", "pr", "merge", "60"], ["}"]]);
  assert.deepEqual(words("true; elif gh pr merge 60; then x"), [["true"], ["gh", "pr", "merge", "60"], ["x"]]);
  // A keyword in a later word is an argument.
  assert.deepEqual(words("echo if then"), [["echo", "if", "then"]]);
});

test("exec, nice, ionice, stdbuf, setsid, doas, and builtin are unwrapped by commandWords", () => {
  const GH = ["gh", "pr", "merge", "5"];
  for (const command of [
    "exec gh pr merge 5",
    "exec -c gh pr merge 5",
    "exec -l -a name gh pr merge 5",
    "nice gh pr merge 5",
    "nice -n 5 gh pr merge 5",
    "nice -n5 gh pr merge 5",
    "nice -5 gh pr merge 5",
    "nice --adjustment=5 gh pr merge 5",
    "nice --adjustment 5 gh pr merge 5",
    "ionice gh pr merge 5",
    "ionice -c 3 gh pr merge 5",
    "ionice -c2 -n 7 -t gh pr merge 5",
    "stdbuf -o0 gh pr merge 5",
    "stdbuf -i L -o L -e 0 gh pr merge 5",
    "stdbuf --output=L gh pr merge 5",
    "setsid gh pr merge 5",
    "setsid -f gh pr merge 5",
    "doas gh pr merge 5",
    "doas -u ci gh pr merge 5",
    "builtin exec gh pr merge 5",
    "sudo nice -n 5 ionice -c 3 stdbuf -o0 setsid exec gh pr merge 5",
  ]) {
    assert.deepEqual(unwrapped(command), GH, command);
  }
});

test("a leading ! is dropped, so the negated command is read", () => {
  assert.deepEqual(segmentsOf("! gh pr merge 5").map((segment) => segment.words), [["gh", "pr", "merge", "5"]]);
  assert.deepEqual(segmentsOf("if ! git diff --quiet; then x; fi").map((segment) => segment.words)[0], ["git", "diff", "--quiet"]);
  assert.deepEqual(segmentsOf("echo !").map((segment) => segment.words), [["echo", "!"]]);
});
