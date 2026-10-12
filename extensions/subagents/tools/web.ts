import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { StringEnum } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { capOutput } from "../core.ts";

const TVLY_OPTIONS = {
  search: {
    flags: ["--json", "--help", "--include-images", "--include-image-descriptions"],
    values: [
      "--depth", "--max-results", "--topic", "--time-range", "--start-date",
      "--end-date", "--include-domains", "--exclude-domains", "--country",
      "--include-answer", "--include-raw-content", "--chunks-per-source",
    ],
  },
  extract: {
    flags: ["--json", "--help", "--include-images"],
    values: ["--query", "--chunks-per-source", "--extract-depth", "--format", "--timeout"],
  },
  map: {
    flags: ["--json", "--help", "--allow-external", "--no-external"],
    values: [
      "--max-depth", "--max-breadth", "--limit", "--instructions",
      "--select-paths", "--exclude-paths", "--select-domains", "--exclude-domains",
      "--timeout",
    ],
  },
  run: {
    flags: ["--json", "--help", "--no-wait", "--stream"],
    values: ["--model", "--citation-format", "--poll-interval", "--timeout"],
  },
  status: { flags: ["--json", "--help"], values: [] },
  poll: {
    flags: ["--json", "--help"],
    values: ["--poll-interval", "--timeout"],
  },
} satisfies Record<string, { flags: string[]; values: string[] }>;
const CURL_FLAGS = new Set([
  "-L",
  "--location",
  "-s",
  "--silent",
  "-S",
  "--show-error",
  "-I",
  "--head",
  "--compressed",
  "--fail",
  "--fail-with-body",
]);
const CURL_VALUE_FLAGS = new Set([
  "--max-time",
  "--connect-timeout",
  "-A",
  "--user-agent",
  "-H",
  "--header",
  "--url",
]);

function requireHttpUrl(value: string): void {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Expected an HTTP(S) URL, got: ${value}`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(`Only HTTP(S) URLs are allowed: ${value}`);
  if (url.username || url.password)
    throw new Error("URLs containing credentials are not allowed");
}

export function validateWebInvocation(
  program: string,
  args: readonly string[],
): void {
  if (program === "tvly") return validateTvly(args);
  if (program === "curl") return validateCurl(args);
  if (program === "date") {
    if (args.length) throw new Error("date does not accept arguments");
    return;
  }
  throw new Error('program must be "tvly", "curl", or "date"');
}

export function validateTvly(args: readonly string[]): void {
  let index = 0;
  if (args[index] === "--json") index++;
  const command = args[index++];
  if (command === "--status" || command === "--help" || command === "--version") {
    if (args[index] === "--json" && index === args.length - 1) index++;
    if (index !== args.length)
      throw new Error(`tvly ${command} does not accept further arguments`);
    return;
  }
  let operation: keyof typeof TVLY_OPTIONS;
  if (command === "research") {
    const subcommand = args[index];
    if (subcommand === "--help" && index === args.length - 1) return;
    if (subcommand === "run" || subcommand === "status" || subcommand === "poll") {
      operation = subcommand;
      index++;
      if (operation !== "run" && args[index] !== "--help" &&
          (!args[index] || args[index].startsWith("-")))
        throw new Error(`tvly research ${operation} requires a request ID immediately after the subcommand`);
    } else {
      if (!subcommand || subcommand.startsWith("-") || subcommand === "help" || subcommand === "get")
        throw new Error("tvly research requires run, status, poll, or a query");
      operation = "run";
    }
  } else if (command === "search" || command === "extract" || command === "map") {
    operation = command;
  } else {
    throw new Error("tvly requires search, extract, map, research, --status, --version, or --help");
  }

  const options: { flags: readonly string[]; values: readonly string[] } = TVLY_OPTIONS[operation];
  const positional: string[] = [];
  let endOfOptions = false;
  let help = false;
  for (; index < args.length; index++) {
    const arg = args[index];
    if (!endOfOptions && arg === "--") {
      endOfOptions = true;
      continue;
    }
    if (endOfOptions || !arg.startsWith("-") || arg === "-") {
      if (!arg || arg === "-") throw new Error("Tavily requires nonempty arguments; stdin is unavailable");
      positional.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const flag = equals < 0 ? arg : arg.slice(0, equals);
    if (options.flags.includes(flag)) {
      if (equals >= 0) throw new Error(`Tavily flag does not take a value: ${flag}`);
      if (flag === "--help") help = true;
    } else if (options.values.includes(flag)) {
      const value = equals < 0 ? args[++index] : arg.slice(equals + 1);
      if (value === undefined || value === "")
        throw new Error(`Tavily option requires a value: ${flag}`);
    } else {
      throw new Error(`Tavily option is not allowed: ${flag}`);
    }
  }
  const maximum = operation === "extract" ? 20 : 1;
  if (positional.length > maximum || (!help && positional.length === 0))
    throw new Error(`tvly ${operation} requires ${maximum === 1 ? "one positional argument" : "1-20 URLs"}`);
  if (operation === "extract" || operation === "map") positional.forEach(requireHttpUrl);
}

export function validateCurl(args: readonly string[]): void {
  if (!args.length) throw new Error("curl requires at least one HTTP(S) URL");
  let urls = 0;
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (!arg.startsWith("-") || arg === "-") {
      requireHttpUrl(arg);
      urls++;
      continue;
    }
    if (arg.startsWith("--url=")) {
      requireHttpUrl(arg.slice("--url=".length));
      urls++;
      continue;
    }
    const equalsIndex = arg.indexOf("=");
    const flag = equalsIndex >= 0 ? arg.slice(0, equalsIndex) : arg;
    if (CURL_FLAGS.has(flag)) {
      if (equalsIndex >= 0)
        throw new Error(`Curl flag does not take a value: ${flag}`);
      continue;
    }
    if (CURL_VALUE_FLAGS.has(flag)) {
      const value =
        equalsIndex >= 0 ? arg.slice(equalsIndex + 1) : args[++index];
      if (!value) throw new Error(`Curl flag requires a value: ${flag}`);
      if (flag === "--url") {
        requireHttpUrl(value);
        urls++;
      } else if (
        (flag === "-H" || flag === "--header") &&
        (value.startsWith("@") || /[\r\n]/.test(value))
      ) {
        throw new Error(
          "Curl headers cannot be loaded from files or contain newlines",
        );
      } else if (
        (flag === "--max-time" || flag === "--connect-timeout") &&
        !/^\d+(?:\.\d+)?$/.test(value)
      ) {
        throw new Error(`${flag} must be numeric`);
      }
      continue;
    }
    if (/^-[LsSI]{2,}$/.test(arg)) continue;
    throw new Error(
      `Curl option is not allowed for read-only retrieval: ${flag}`,
    );
  }
  if (!urls) throw new Error("curl requires at least one HTTP(S) URL");
}

const WebParams = Type.Object({
  program: StringEnum(["tvly", "curl", "date"] as const, {
    description: "Read-oriented CLI to execute",
  }),
  args: Type.Array(Type.String(), {
    description: "Argument vector",
    maxItems: 80,
  }),
  timeout: Type.Optional(Type.Integer({
    description: "Timeout in seconds (default 120, maximum 120)",
    minimum: 1,
    maximum: 120,
  })),
}, { additionalProperties: false });

function boundedOutput() {
  const limit = 100 * 1024;
  const decoder = new StringDecoder("utf8");
  let bytes = 0;
  let text = "";
  return {
    append(chunk: Buffer) {
      if (bytes === limit) return false;
      const retained = chunk.subarray(0, limit - bytes);
      bytes += retained.length;
      text += decoder.write(retained);
      return retained.length > 0;
    },
    end() {
      if (bytes < limit) text += decoder.end();
    },
    text: () => text,
  };
}

export interface WebDetails {
  program: string;
  args: string[];
  exitCode: number | null;
  durationMs: number;
}

export default function createTool(
  cwd: string,
): ToolDefinition<typeof WebParams, WebDetails> {
  return {
    name: "web",
    label: "Web",
    description:
      "Run guarded read-oriented Tavily or curl retrieval, or check the system date.",
    parameters: WebParams,
    async execute(_toolCallId, params, signal, onUpdate) {
      validateWebInvocation(params.program, params.args);
      if (signal?.aborted) throw new Error("Web command aborted");
      const startedAt = Date.now();
      const timeoutMs = (params.timeout ?? 120) * 1_000;
      const commandArgs =
        params.program === "curl"
          ? [
              "-q",
              "--proto",
              "=http,https",
              "--proto-redir",
              "=http,https",
              ...params.args,
            ]
          : params.args;
      const stdout = boundedOutput();
      const stderr = boundedOutput();

      const result = await new Promise<{
        exitCode: number | null;
        aborted: boolean;
        timedOut: boolean;
      }>((resolve, reject) => {
        const child = spawn(params.program, commandArgs, {
          cwd,
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
        let timedOut = false;
        let aborted = false;
        let killTimer: ReturnType<typeof setTimeout> | undefined;
        const cleanup = () => {
          clearTimeout(timer);
          clearTimeout(killTimer);
          signal?.removeEventListener("abort", abort);
        };
        const stop = () => {
          if (killTimer) return;
          child.kill("SIGTERM");
          killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
        };
        const abort = () => {
          aborted = true;
          stop();
        };
        const timer = setTimeout(() => {
          timedOut = true;
          stop();
        }, timeoutMs);
        timer.unref();
        child.stdout.on("data", (data) => {
          if (!stdout.append(data)) return;
          onUpdate?.({
            content: [{ type: "text", text: capOutput(stdout.text()) }],
            details: {
              program: params.program,
              args: params.args,
              exitCode: null,
              durationMs: Date.now() - startedAt,
            },
          });
        });
        child.stderr.on("data", (data) => {
          stderr.append(data);
        });
        child.once("error", (error) => { cleanup(); reject(error); });
        child.once("close", (exitCode) => { cleanup(); resolve({ exitCode, aborted, timedOut }); });
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });

      stdout.end();
      stderr.end();
      const details: WebDetails = {
        program: params.program,
        args: [...params.args],
        exitCode: result.exitCode,
        durationMs: Date.now() - startedAt,
      };
      const combined = capOutput(
        [stdout.text().trim(), stderr.text().trim()].filter(Boolean).join("\n\n"),
      );
      if (result.aborted) throw new Error("Web command aborted");
      if (result.timedOut)
        throw new Error(
          `Web command timed out after ${params.timeout ?? 120}s${combined ? `\n${combined}` : ""}`,
        );
      if (result.exitCode !== 0)
        throw new Error(
          `${params.program} exited with code ${result.exitCode}${combined ? `\n${combined}` : ""}`,
        );
      return {
        content: [
          {
            type: "text",
            text: combined || "(command completed with no output)",
          },
        ],
        details,
      };
    },
  };
}
