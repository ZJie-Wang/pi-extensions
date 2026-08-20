/**
 * Pure helpers for the plan-mode extension.
 *
 * Two concerns live here:
 *   - command safety: a small token-based shell classifier that decides whether
 *     a bash command is safe to run while planning (read-only inspection only).
 *   - plan detection: lightweight heuristics that nudge the model toward
 *     `present_plan` when it dumps a plan into chat instead of saving it.
 *
 * The safety layer parses the command the way a shell would (quotes, escapes,
 * separators) and then classifies each segment by its first token. This is far
 * more robust than a pile of regexes: it cannot be fooled by quoted arguments,
 * env-assignment prefixes, or `time`/`command` wrappers.
 */

export interface PlanItem {
	step: number;
	text: string;
}

// ---------------------------------------------------------------------------
// Command safety
// ---------------------------------------------------------------------------

/** Commands that mutate state and are never allowed while planning. */
const MUTATING_COMMANDS = new Set([
	"rm", "rmdir", "mv", "cp", "mkdir", "touch", "chmod", "chown", "chgrp", "ln",
	"tee", "truncate", "dd", "shred", "sudo", "su", "kill", "pkill", "killall",
	"reboot", "shutdown", "systemctl", "service", "vim", "vi", "nano", "emacs",
	"code", "subl",
]);

/** Read-only inspection commands allowed with any (safe) arguments. */
const READ_ONLY_COMMANDS = new Set([
	"cat", "head", "tail", "grep", "egrep", "fgrep", "rg", "find",
	"fd", "ls", "pwd", "tree", "echo", "printf", "wc", "sort", "uniq", "cut",
	"tr", "diff", "cmp", "file", "stat", "du", "df", "which", "whereis", "type",
	"printenv", "uname", "whoami", "id", "date", "cal", "uptime", "ps",
	"free", "jq", "bat", "eza",
]);

/**
 * git subcommands permitted while planning. Note these are only read-only when
 * further restricted by argument checks in isSafeGit: `branch`, `remote`, and
 * `config` all have mutating forms.
 */
const SAFE_GIT_SUBCOMMANDS = new Set([
	"status", "log", "diff", "show", "branch", "remote", "ls-files", "ls-tree",
	"grep", "blame", "rev-parse", "describe", "merge-base", "cat-file", "config",
]);

/** git config flags that write to a config file (everything else with <= 1 key arg is a read). */
const GIT_CONFIG_WRITE_FLAGS = [
	"--unset", "--unset-all", "--add", "--replace-all", "--rename-section",
	"--remove-section", "--edit", "-e", "--fix-up",
];

/**
 * Split a command into shell segments on `;`, `|`, `&&`, `||`, and newlines,
 * respecting quotes and escapes. Returns `undefined` when the command uses any
 * construct that is unsafe to evaluate without execution: command substitution
 * (`` ` `` or `$(`), process substitution (`<(` / `>(`), redirection (`<`/`>`),
 * subshells (`(` / `)`), or background execution (a bare `&`).
 */
function splitShellSegments(command: string): string[] | undefined {
	const trimmed = command.trim();
	if (!trimmed || trimmed.includes("`")) return undefined;

	const segments: string[] = [];
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let start = 0;

	const flush = (end: number): boolean => {
		const segment = trimmed.slice(start, end).trim();
		if (!segment) return false;
		segments.push(segment);
		return true;
	};

	for (let i = 0; i < trimmed.length; i++) {
		const ch = trimmed[i] as string;
		if (escaped) {
			escaped = false;
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (ch === quote) {
				quote = undefined;
			} else if (ch === "$" && quote === '"' && trimmed[i + 1] === "(") {
				return undefined;
			}
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			continue;
		}
		if (ch === "$" && trimmed[i + 1] === "(") return undefined;
		if (ch === "<" || ch === ">" || ch === "(" || ch === ")") return undefined;
		if (ch === "&" && trimmed[i + 1] !== "&") return undefined;

		const next = trimmed[i + 1];
		let sepLen = 0;
		if (ch === ";" || ch === "\n") sepLen = 1;
		else if (ch === "|") sepLen = next === "|" ? 2 : 1;
		else if (ch === "&") sepLen = 2; // only reachable for "&&"

		if (sepLen === 0) continue;
		if (!flush(i)) return undefined;
		i += sepLen - 1;
		start = i + 1;
	}

	if (quote || escaped) return undefined;
	const tail = trimmed.slice(start).trim();
	if (!tail) return segments.length > 0 ? segments : undefined;
	segments.push(tail);
	return segments;
}

/** Tokenize a single segment into words, honoring quotes and escapes. */
function shellWords(segment: string): string[] | undefined {
	const words: string[] = [];
	let word = "";
	let quote: "'" | '"' | undefined;
	let escaped = false;
	let hasWord = false;

	for (const ch of segment) {
		if (escaped) {
			word += ch;
			escaped = false;
			continue;
		}
		if (ch === "\\" && quote !== "'") {
			escaped = true;
			continue;
		}
		if (quote) {
			if (ch === quote) quote = undefined;
			else word += ch;
			continue;
		}
		if (ch === "'" || ch === '"') {
			quote = ch;
			hasWord = true;
			continue;
		}
		if (/\s/.test(ch)) {
			if (hasWord) {
				words.push(word);
				word = "";
				hasWord = false;
			}
			continue;
		}
		word += ch;
		hasWord = true;
	}

	if (quote || escaped) return undefined;
	if (hasWord) words.push(word);
	return words;
}

/** Strip leading `time`, `command`, and `VAR=value` assignments from a segment. */
function stripPrefixes(segment: string): string {
	let next = segment.trim();
	next = next.replace(/^(?:time|command)\s+/, "");
	next = next.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S+)\s+)*/, "");
	return next.trim();
}

/** Command-specific argument checks. Returns a reason when an arg is unsafe. */
function unsafeArgumentReason(command: string, args: string[]): string | undefined {
	switch (command) {
		case "sed":
			if (args.some((a) => a === "-i" || a === "--in-place" || a.startsWith("--in-place=") || /^-[^-]*i/.test(a)))
				return "sed -i is not allowed";
			break;
		case "find":
			if (args.some((a) => ["-delete", "-exec", "-execdir", "-ok", "-okdir", "-fprint", "-fprint0", "-fprintf", "-fls"].includes(a)))
				return "find mutating actions are not allowed";
			break;
		case "sort":
		case "tree":
			if (args.some((a) => a === "-o" || a.startsWith("-o") || a.startsWith("--output")))
				return `${command} -o/--output is not allowed`;
			if (args.some((a) => a === "-T" || a.startsWith("-T") || a.startsWith("--temporary-directory") || a.startsWith("--compress-program")))
				return `${command} temp/compress options are not allowed`;
			break;
		case "diff":
			if (args.some((a) => a === "--output" || a.startsWith("--output=")))
				return "diff --output is not allowed";
			break;
		case "uniq":
			if (args.filter((a) => !a.startsWith("-")).length > 1) return "uniq with multiple file arguments is not allowed";
			break;
		case "fd":
			if (args.some((a) => ["-x", "-X", "--exec", "--exec-batch"].some((f) => a === f || a.startsWith(f + "="))))
				return "fd -x/-X is not allowed";
			break;
		case "rg":
			if (args.some((a) => a === "--pre" || a.startsWith("--pre="))) return "rg --pre is not allowed";
			break;
		case "bat":
			if (args.some((a) => a === "--pager" || a.startsWith("--pager="))) return "bat --pager is not allowed";
			break;
		case "date":
			if (args.some((a) => a === "-s" || a.startsWith("--set"))) return "date -s/--set is not allowed";
			break;
		case "curl": {
			const writeFlags = ["-o", "--output", "-O", "--remote-name", "-d", "--data", "--data-raw", "--data-binary", "--data-ascii", "-F", "--form", "-T", "--upload-file", "-K", "--config", "-c", "--cookie-jar", "-D", "--dump-header", "--trace", "--trace-ascii", "--stderr"];
			if (args.some((a) => writeFlags.some((f) => a === f || a.startsWith(f))))
				return "curl write/upload/config flags are not allowed";
			const methodIdx = args.findIndex((a) => a === "-X" || a === "--request");
			if (methodIdx >= 0 && /post|put|patch|delete/i.test(args[methodIdx + 1] ?? "")) return "curl mutating HTTP methods are not allowed";
			break;
		}
		case "wget":
			if (args.some((a) => a === "--output-document" || a.startsWith("--output-document="))) return "wget --output-document is not allowed";
			if (args.some((a, i) => (a === "-O") && args[i + 1] !== "-")) return "wget -O <file> is not allowed";
			break;
	}
	return undefined;
}

/** Structured commands (git/npm/node/tsc/...) that need subcommand inspection. */
function isSafeStructuredCommand(command: string, args: string[]): boolean {
	if (command === "git") return isSafeGit(args);
	if (command === "env") return args.length === 0;
	if (command === "curl") return true; // arg checks above already rejected write/upload/config flags
	if (command === "wget") {
		// Only stdout output (-O -) is read-only; default wget writes a file.
		const oIdx = args.findIndex((a) => a === "-O");
		return oIdx >= 0 && args[oIdx + 1] === "-";
	}
	if (command === "npm" || command === "yarn" || command === "pnpm") return isSafePackageManager(command, args);
	if (command === "node" || command === "python" || command === "python3" || command === "pip" || command === "pip3")
		return args.includes("--version") || args.includes("-v") || args.includes("-V");
	if (command === "tsc") return args.includes("--noEmit") && !args.some((a) => a === "--incremental" || a.startsWith("--incremental") || a.startsWith("--tsBuildInfoFile") || a.startsWith("--generateTrace"));
	if (command === "cargo") return ["test", "check", "metadata", "tree", "search"].includes(args[0] ?? "");
	if (command === "go") return ["test", "list", "version", "env"].includes(args[0] ?? "");
	if (["pytest", "vitest", "jest"].includes(command)) return true;
	if (command === "tvly") return ["search", "extract", "crawl", "map", "deep-research"].includes(args[0] ?? "");
	return false;
}

function isSafeGit(args: string[]): boolean {
	let i = 0;
	while (args[i] === "--no-pager") i++;
	const sub = args[i]?.toLowerCase();
	if (!sub || sub.startsWith("-")) return false;
	if (!SAFE_GIT_SUBCOMMANDS.has(sub)) return false;
	const rest = args.slice(i + 1);
	if (rest.some((a) => a.startsWith("--output") || a === "--ext-diff" || a.startsWith("--ext-diff") || a === "--textconv" || a.startsWith("--textconv") || a === "--paginate" || a.startsWith("--open-files-in-pager")))
		return false;
	if (sub === "branch" && rest.some((a) => !a.startsWith("-"))) return false; // branch names only with flags
	if (sub === "branch" && rest.some((a) => /^-[^-]*[dDmMcCuU]/.test(a) || a.startsWith("--delete") || a.startsWith("--move") || a.startsWith("--copy") || a.startsWith("--set-upstream-to") || a === "--unset-upstream" || a.startsWith("--edit-description") || a.startsWith("--create-reflog"))) return false;
	if (sub === "config") {
		// Reads: `git config <key>`, `git config --get/--list ...`. Writes take a
		// value (second non-flag arg) or an explicit write flag.
		if (rest.filter((a) => !a.startsWith("-")).length > 1) return false;
		if (rest.some((a) => GIT_CONFIG_WRITE_FLAGS.some((f) => a === f || a.startsWith(f + "=")))) return false;
	}
	if (sub === "remote" && rest.some((a) => !a.startsWith("-"))) {
		// allow `remote get-url <name>` and `remote show <name>`
		const action = rest[0];
		return action === "get-url" || action === "show";
	}
	return true;
}

function isSafePackageManager(command: string, args: string[]): boolean {
	const sub = args.find((a) => !a.startsWith("-"))?.toLowerCase();
	const subArgs = args.slice(args.findIndex((a) => !a.startsWith("-")) + 1);
	if (sub === undefined) return false;
	if (["list", "ls", "view", "info", "why", "search", "outdated", "audit"].includes(sub)) {
		if (sub === "audit" && subArgs.includes("fix")) return false;
		return true;
	}
	if (sub === "run") return ["test", "check", "typecheck", "lint"].includes(subArgs[0] ?? "");
	return false;
}

function unsafeSegmentReason(rawSegment: string): string | undefined {
	const segment = stripPrefixes(rawSegment);
	if (!segment) return "empty command segment";
	if (/\$(?=\()/.test(segment)) return "command substitution is blocked in plan mode";

	const tokens = shellWords(segment);
	if (!tokens || tokens.length === 0) return `could not parse command segment: ${preview(segment)}`;

	const command = (tokens[0] ?? "").toLowerCase();
	if (!command) return "empty command";
	if (MUTATING_COMMANDS.has(command)) return `${command} is not allowed in plan mode`;

	const args = tokens.slice(1);
	const argReason = unsafeArgumentReason(command, args);
	if (argReason) return argReason;

	if (READ_ONLY_COMMANDS.has(command)) return undefined;
	if (isSafeStructuredCommand(command, args)) return undefined;
	return `command is not allowlisted in plan mode: ${preview(segment)}`;
}

function preview(value: string): string {
	const flat = value.replace(/\s+/g, " ").trim();
	return flat.length > 80 ? `${flat.slice(0, 77)}...` : flat;
}

/** Returns a human-readable reason when a bash command is unsafe in plan mode. */
export function getUnsafeCommandReason(command: string): string | undefined {
	const trimmed = command.trim();
	if (!trimmed) return "empty command";
	const segments = splitShellSegments(trimmed);
	if (!segments) {
		return "command substitution, redirection, subshells, or background execution are blocked in plan mode";
	}
	for (const segment of segments) {
		const reason = unsafeSegmentReason(segment);
		if (reason) return reason;
	}
	return undefined;
}

// ---------------------------------------------------------------------------
// Plan detection (nudges the model toward `present_plan`)
// ---------------------------------------------------------------------------

function linesOutsideCodeFences(markdown: string): string[] {
	const result: string[] = [];
	let inFence = false;
	for (const line of markdown.split(/\r?\n/)) {
		if (/^\s*```/.test(line)) {
			inFence = !inFence;
			continue;
		}
		if (!inFence) result.push(line);
	}
	return result;
}

function isPlanHeader(line: string): boolean {
	const plain = line.replace(/[*_`]/g, "").trim();
	return /^(?:(?:proposed|implementation|recommended|updated|final|approved)\s+)?plan\s*[:：]?$/i.test(plain);
}

function isSectionHeader(line: string): boolean {
	return /^\s*#{1,6}\s+\S/.test(line);
}

function cleanStepText(text: string): string {
	return text
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\*{1,3}([^*]+)\*{1,3}/g, "$1")
		.replace(/_{1,3}([^_]+)_{1,3}/g, "$1")
		.replace(/<[^>]+>/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

export function extractPlanItems(message: string): PlanItem[] {
	const lines = linesOutsideCodeFences(message);
	const headerIndex = lines.findIndex(isPlanHeader);
	if (headerIndex < 0) return [];

	const items: PlanItem[] = [];
	const seenSteps = new Set<number>();

	for (let i = headerIndex + 1; i < lines.length; i++) {
		const line = lines[i] ?? "";
		if (items.length > 0 && isSectionHeader(line)) break;

		const match = line.match(/^\s*(?:[-*]\s*)?(\d{1,3})[.)]\s+(.+)$/);
		if (!match) continue;

		const step = Number(match[1]);
		const text = cleanStepText(match[2] ?? "");
		if (!Number.isFinite(step) || step <= 0 || seenSteps.has(step) || text.length < 3) continue;

		seenSteps.add(step);
		items.push({ step, text });
	}

	return items;
}

export function containsPlanHeader(message: string): boolean {
	return linesOutsideCodeFences(message).some(isPlanHeader);
}
