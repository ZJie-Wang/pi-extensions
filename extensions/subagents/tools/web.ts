import { spawn } from "node:child_process";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { capOutput } from "../core.ts";

const TVLY_COMMANDS = new Set([
  "search",
  "extract",
  "map",
  "research",
  "--status",
]);
const TVLY_BLOCKED = new Set([
  "auth",
  "login",
  "logout",
  "--api-key",
  "-o",
  "--output",
]);
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
const SAFE_SHORT_FLAGS = new Set(["L", "s", "S", "I"]);

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
  if (!args.length || !TVLY_COMMANDS.has(args[0])) {
    throw new Error(
      "tvly requires one of: search, extract, map, research, --status",
    );
  }
  for (const arg of args) {
    const normalized = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
    if (TVLY_BLOCKED.has(normalized))
      throw new Error(`Tavily option is not allowed: ${normalized}`);
  }
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
    if (
      /^-[LsSI]{2,}$/.test(arg) &&
      [...arg.slice(1)].every((letter) => SAFE_SHORT_FLAGS.has(letter))
    )
      continue;
    throw new Error(
      `Curl option is not allowed for read-only retrieval: ${flag}`,
    );
  }
  if (!urls) throw new Error("curl requires at least one HTTP(S) URL");
}

interface WebInput {
  program: "tvly" | "curl" | "date";
  args: string[];
  timeout?: number;
}

const WebParams = {
  type: "object",
  properties: {
    program: {
      anyOf: [
        { const: "tvly", type: "string" },
        { const: "curl", type: "string" },
        { const: "date", type: "string" },
      ],
      description: "Read-oriented CLI to execute",
    },
    args: {
      type: "array",
      items: { type: "string" },
      description:
        "Argument vector. Each item is passed directly; no shell parsing occurs.",
      maxItems: 80,
    },
    timeout: {
      type: "integer",
      description: "Timeout in seconds (default 120, maximum 120)",
      minimum: 1,
      maximum: 120,
    },
  },
  required: ["program", "args"],
  additionalProperties: false,
} as any;

export interface WebDetails {
  program: string;
  args: string[];
  exitCode: number | null;
  durationMs: number;
}

export default function createTool(
  cwd: string,
): ToolDefinition<any, WebDetails> {
  return {
    name: "web",
    label: "Web",
    description:
      "Run guarded read-oriented Tavily or curl retrieval, or check the system date.",
    promptSnippet:
      "Retrieve external information with guarded Tavily and curl commands, or check the system date",
    parameters: WebParams,
    async execute(_toolCallId, rawParams, signal, onUpdate) {
      const params = rawParams as WebInput;
      validateWebInvocation(params.program, params.args);
      const startedAt = Date.now();
      const timeoutMs = (params.timeout ?? 120) * 1_000;
      const commandArgs =
        params.program === "curl"
          ? [
              "--proto",
              "=http,https",
              "--proto-redir",
              "=http,https",
              ...params.args,
            ]
          : params.args;
      let stdout = "";
      let stderr = "";
      let settled = false;
      const appendBounded = (current: string, chunk: string) => {
        if (Buffer.byteLength(current, "utf8") >= 100 * 1024) return current;
        return current + chunk;
      };

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
        const cleanup = () => {
          clearTimeout(timer);
          signal?.removeEventListener("abort", abort);
        };
        const finish = (exitCode: number | null) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve({ exitCode, aborted, timedOut });
        };
        const fail = (error: Error) => {
          if (settled) return;
          settled = true;
          cleanup();
          reject(error);
        };
        const stop = () => {
          try {
            child.kill("SIGTERM");
          } catch {}
          setTimeout(() => {
            if (!settled)
              try {
                child.kill("SIGKILL");
              } catch {}
          }, 1_000).unref();
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
          stdout = appendBounded(stdout, data.toString());
          onUpdate?.({
            content: [{ type: "text", text: capOutput(stdout) }],
            details: {
              program: params.program,
              args: params.args,
              exitCode: null,
              durationMs: Date.now() - startedAt,
            },
          });
        });
        child.stderr.on("data", (data) => {
          stderr = appendBounded(stderr, data.toString());
        });
        child.once("error", fail);
        child.once("close", finish);
        if (signal?.aborted) abort();
        else signal?.addEventListener("abort", abort, { once: true });
      });

      const details: WebDetails = {
        program: params.program,
        args: [...params.args],
        exitCode: result.exitCode,
        durationMs: Date.now() - startedAt,
      };
      const combined = capOutput(
        [stdout.trim(), stderr.trim()].filter(Boolean).join("\n\n"),
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
