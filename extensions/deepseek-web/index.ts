import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatSize,
  keyHint,
  truncateHead,
  type AgentToolResult,
  type ExtensionAPI,
  type ExtensionToolContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const API_BASE = "https://api.deepseek.com/v1/tools";
const REQUEST_TIMEOUT_MS = 90_000;
const SEARCH_COUNT = 5;

const SearchParams = Type.Object(
  {
    query: Type.String(),
  },
  { additionalProperties: false },
);

const FetchParams = Type.Object(
  {
    url: Type.String(),
  },
  { additionalProperties: false },
);

interface SearchResult {
  title?: string;
  url?: string;
  site_name?: string;
  date?: string;
  summary?: string;
  snippet?: string;
}

interface SearchDetails {
  resultCount: number;
}

interface FetchDetails {
  url: string;
  title?: string;
  bytes: number;
  shownBytes?: number;
  truncated: boolean;
}

async function callDeepSeek<T>(
  ctx: ExtensionToolContext,
  endpoint: "search" | "fetch",
  body: Record<string, unknown>,
): Promise<T> {
  const apiKey = await ctx.modelRegistry.getApiKeyForProvider("deepseek");
  if (!apiKey) {
    throw new Error(
      "No DeepSeek API key configured. Set DEEPSEEK_API_KEY or configure the deepseek provider in Pi.",
    );
  }

  const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
  const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeout]) : timeout;

  let response: Response;
  let text: string;
  try {
    response = await fetch(`${API_BASE}/${endpoint}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        // DeepSeek may answer with zstd, which pi's installed fetch can fail to decode.
        "Accept-Encoding": "identity",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal,
    });
    text = await response.text();
  } catch (error) {
    if (error instanceof Error && error.name === "TimeoutError") {
      throw new Error(`DeepSeek ${endpoint} timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    }
    throw error;
  }

  const excerpt = text.slice(0, 500);
  if (!response.ok) {
    throw new Error(`DeepSeek ${endpoint} failed (HTTP ${response.status}): ${excerpt}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`DeepSeek ${endpoint} returned invalid JSON: ${excerpt}`);
  }
}

function formatResults(results: SearchResult[]): string {
  return results
    .map((result, index) => {
      const title = result.title?.trim() || result.url || "Untitled";
      const siteName = result.site_name?.trim();
      const meta = [
        siteName && siteName !== title ? siteName : undefined,
        result.date?.match(/^\d{4}-\d{2}-\d{2}/)?.[0],
      ]
        .filter(Boolean)
        .join(" · ");
      const body = (result.summary || result.snippet || "").replace(/\s+/g, " ").trim();

      return [
        `${index + 1}. ${title}${meta ? ` — ${meta}` : ""}`,
        `   ${result.url ?? ""}`,
        ...(body ? [`   ${body}`] : []),
      ].join("\n");
    })
    .join("\n\n");
}

/** DeepSeek escapes Markdown punctuation in fetched content. */
function unescapeContent(text: string): string {
  return text.replace(/\\([^a-zA-Z0-9\s])/g, "$1");
}

function normalizeUrl(url: string): string {
  const trimmed = url.trim();
  return /^[a-z][a-z\d+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

function textContent(result: AgentToolResult<unknown>): string {
  return result.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
}

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the web and return ranked results with title, URL, date, and summary. The query supports site:, -site:, \"exact phrase\", lang:, after:, and before: operators.",
    promptSnippet: "Search the web and return ranked results with summaries",
    parameters: SearchParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const query = params.query.trim();
      if (!query) throw new Error("Query must not be empty.");

      const response = await callDeepSeek<{ results?: SearchResult[] }>(ctx, "search", {
        query,
        count: SEARCH_COUNT,
        need_content: false,
      });
      const results = response.results ?? [];

      return {
        content: [
          {
            type: "text",
            text: results.length === 0 ? `No results for "${query}".` : formatResults(results),
          },
        ],
        details: { resultCount: results.length } satisfies SearchDetails,
      };
    },

    renderCall(args, theme) {
      const query = typeof args.query === "string" ? args.query : "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("web_search "))}${theme.fg("toolOutput", query)}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme, context) {
      const text = textContent(result);
      if (context.isError) return new Text(`\n${theme.fg("error", text)}`, 0, 0);
      if (expanded) return new Text(`\n${theme.fg("toolOutput", text)}`, 0, 0);

      const { resultCount } = result.details as SearchDetails;
      const summary =
        resultCount > 0
          ? theme.fg("success", `${resultCount} results`)
          : theme.fg("muted", "No results");

      return new Text(
        `\n${summary}${theme.fg("muted", " · ")}${keyHint("app.tools.expand", "to expand")}`,
        0,
        0,
      );
    },
  });

  pi.registerTool({
    name: "web_fetch",
    label: "Web Fetch",
    description:
      "Fetch a web page and return its title and readable content as Markdown.",
    promptSnippet: "Fetch a web page and return its readable Markdown content",
    parameters: FetchParams,

    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const url = normalizeUrl(params.url);
      const response = await callDeepSeek<{ title?: string; content?: string }>(ctx, "fetch", {
        url,
      });

      const title = response.title?.trim();
      const content = unescapeContent(response.content ?? "");
      if (!content.trim()) {
        return {
          content: [{ type: "text", text: `No readable content at ${url}.` }],
          details: { url, title, bytes: 0, truncated: false } satisfies FetchDetails,
        };
      }

      const truncation = truncateHead(content);
      const details: FetchDetails = {
        url,
        title,
        bytes: truncation.totalBytes,
        truncated: truncation.truncated,
      };

      let text = truncation.content;
      if (truncation.truncated) {
        const dir = await mkdtemp(join(tmpdir(), "pi-web-fetch-"));
        const fullOutputPath = join(dir, "content.md");
        await writeFile(fullOutputPath, content, "utf8");
        details.shownBytes = truncation.outputBytes;
        text += `\n\n[Truncated: showing ${truncation.outputLines} of ${truncation.totalLines} lines (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}). Full content: ${fullOutputPath}]`;
      }

      return {
        content: [{ type: "text", text: title ? `# ${title}\n\n${text}` : text }],
        details,
      };
    },

    renderCall(args, theme) {
      const url = typeof args.url === "string" ? args.url : "";
      return new Text(
        `${theme.fg("toolTitle", theme.bold("web_fetch "))}${theme.fg("toolOutput", url)}`,
        0,
        0,
      );
    },

    renderResult(result, { expanded }, theme, context) {
      const text = textContent(result);
      if (context.isError) return new Text(`\n${theme.fg("error", text)}`, 0, 0);
      if (expanded) return new Text(`\n${theme.fg("toolOutput", text)}`, 0, 0);

      const details = result.details as FetchDetails;
      let summary = theme.fg("toolOutput", details.title || details.url);
      const size =
        details.truncated && details.shownBytes !== undefined
          ? `${formatSize(details.shownBytes)} of ${formatSize(details.bytes)}`
          : formatSize(details.bytes);
      summary += theme.fg("muted", ` · ${size}`);
      if (details.truncated) summary += theme.fg("warning", " · truncated");

      return new Text(
        `\n${summary}${theme.fg("muted", " · ")}${keyHint("app.tools.expand", "to expand")}`,
        0,
        0,
      );
    },
  });
}
