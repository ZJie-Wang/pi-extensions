import test from "node:test";
import assert from "node:assert/strict";
import { getUnsafeCommandReason } from "../lib/utils.ts";

test("safe read-only commands are allowed", () => {
	for (const command of [
		"ls -la",
		"cat README.md",
		"grep -rn 'TODO' src",
		"rg --files",
		"git status",
		"git log --oneline -5",
		"git diff",
		"git show HEAD",
		"git branch --show-current",
		"npm ls",
		"npm run test",
		"node --version",
		"tsc --noEmit",
		"echo hello",
		"find . -name '*.ts'",
		"curl -sL https://example.com",
		"jq '.name' package.json",
		"ps aux | grep node",
		"cat a && cat b",
	]) {
		assert.equal(getUnsafeCommandReason(command), undefined, `expected safe: ${command}`);
	}
});

test("mutating and unsafe commands are blocked with a reason", () => {
	const cases: Array<[string, RegExp]> = [
		["rm -rf build", /rm is not allowed/],
		["mkdir new-dir", /mkdir is not allowed/],
		["git commit -m x", /not allowlisted/],
		["git push", /not allowlisted/],
		["npm install lodash", /not allowlisted/],
		["sed -i 's/a/b/' file", /sed -i is not allowed/],
		["find . -delete", /find mutating actions/],
		["sort -o out.txt list", /sort -o/],
		["echo hi > out.txt", /redirection/],
		["cat file `whoami`", /substitution|redirection|backtick/],
		["echo $(whoami)", /substitution|redirection/],
		["sleep 10 &", /background|substitution|redirection/],
		["bash -c 'rm x'", /not allowlisted/],
		["curl -X POST https://example.com", /curl mutating HTTP methods/],
		["curl -o file https://example.com", /curl write\/upload/],
		["wget -O out https://example.com", /wget -O/],
		["vi README.md", /vi is not allowed/],
		["sudo apt install x", /sudo is not allowed/],
		["echo $HOME", undefined], // variable expansion (not substitution) is fine
	];
	for (const [command, expected] of cases) {
		const reason = getUnsafeCommandReason(command);
		if (expected === undefined) {
			assert.equal(reason, undefined, `expected safe: ${command}`);
		} else {
			assert.match(reason ?? "", expected, `expected blocked (${reason}) for: ${command}`);
		}
	}
});

test("git config is read-only only for read forms", () => {
	for (const command of [
		"git config user.name",
		"git config --get user.name",
		"git config --list",
		"git config --global user.name",
		"git config --get-regexp '^user\\.'",
	]) {
		assert.equal(getUnsafeCommandReason(command), undefined, `expected safe: ${command}`);
	}
	for (const command of [
		"git config user.name evil",
		"git config --global user.email x@y.z",
		"git config --unset user.name",
		"git config --add alias.x status",
		"git config -e",
	]) {
		assert.notEqual(getUnsafeCommandReason(command), undefined, `expected blocked: ${command}`);
	}
});

test("git branch mutating flags are blocked", () => {
	for (const command of [
		"git branch --set-upstream-to=origin/main",
		"git branch --unset-upstream",
		"git branch --edit-description",
		"git branch -u origin/main",
	]) {
		assert.notEqual(getUnsafeCommandReason(command), undefined, `expected blocked: ${command}`);
	}
	for (const command of ["git branch", "git branch -a", "git branch --show-current", "git branch -vv"]) {
		assert.equal(getUnsafeCommandReason(command), undefined, `expected safe: ${command}`);
	}
});

test("quoted arguments do not fool the parser", () => {
	// "rm" appears only inside a quoted argument to echo — must be safe.
	assert.equal(getUnsafeCommandReason("echo 'rm -rf everything'"), undefined);
	// A real rm after a semicolon is still caught.
	assert.match(getUnsafeCommandReason("echo hi; rm x") ?? "", /rm is not allowed/);
});
