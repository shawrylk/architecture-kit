import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkoutDirs, mayWrite } from "./powershell-command.mjs";

test("a PowerShell command that only reads skips the check, in any letter case", () => {
  for (const command of [
    "Get-ChildItem -Recurse src",
    "get-content a.txt | select-string foo",
    "Test-Path C:\\repo\\a.txt",
    "Get-Content a.txt | Measure-Object -Line",
    "Get-Process | Format-Table Name",
    "Write-Output done",
    'git status; git diff --stat; git log --oneline -5',
    "Get-Date > $null",
    "Get-Item x 2>$null",
    "Set-Location C:\\repo; Get-Location",
    "ls; cat a.txt; pwd",
  ]) {
    assert.equal(mayWrite(command), false, command);
  }
});

test("a PowerShell write, an unknown command and a script block are never skipped", () => {
  for (const command of [
    "Set-Content a.txt x",
    "Add-Content a.txt x",
    "Get-Content a.txt | Out-File b.txt",
    "Get-Date > C:\\repo\\d.txt",
    "Write-Output x >> log.txt",
    "New-Item -ItemType File a.txt",
    "Copy-Item a b",
    "Move-Item a b",
    "Remove-Item -Recurse -Force build",
    "Rename-Item a b",
    'git commit -m "x"',
    "git checkout main -- src",
    "node scripts/codemod.mjs",
    "Get-ChildItem | Where-Object { Remove-Item $_ }",
    "Get-ChildItem | ForEach-Object Name",
    "& C:\\tools\\fix.ps1",
  ]) {
    assert.equal(mayWrite(command), true, command);
  }
});

test("the checkout directories are each location change and each git -C directory, with backslashes kept", () => {
  assert.deepEqual(
    checkoutDirs('Set-Location C:\\repo\\a; git -C "C:\\b c" status; cd ..\\d; Push-Location -Path C:\\e; popd'),
    ["C:\\repo\\a", "C:\\b c", "..\\d", "C:\\e"],
  );
  assert.deepEqual(checkoutDirs("Get-ChildItem"), []);
});
