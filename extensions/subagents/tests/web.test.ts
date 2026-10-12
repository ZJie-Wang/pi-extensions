import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import createTool, { validateCurl, validateTvly, validateWebInvocation } from "../tools/web.ts";

const accepted = [
  ["search", "query", "--json"],
  ["--json", "search", "query", "--depth=advanced"],
  ["search", "query", "--include-domains", "example.com"],
  ["extract", "https://example.com", "--query", "--output", "--json"],
  ["extract", "https://example.com", "https://example.org", "--format", "text"],
  ["map", "https://example.com", "--instructions", "Find --output documentation"],
  ["research", "run", "complex query", "--json"],
  ["research", "complex query", "--json"],
  ["research", "status", "request-id", "--json"],
  ["research", "poll", "request-id", "--poll-interval", "2"],
  ["--status"],
  ["--json", "--status"],
  ["search", "--", "--output"],
];

const rejected = [
  ["search", "query", "-o/tmp/result"],
  ["search", "query", "-o", "/tmp/result"],
  ["search", "query", "--output=/tmp/result"],
  ["search", "query", "--api-key", "secret"],
  ["auth"],
  ["login"],
  ["search", "query", "--unknown"],
  ["search", "query", "--json=yes"],
  ["search", "query", "--depth"],
  ["search", "-"],
  ["extract", "file:///etc/passwd"],
  ["map", "https://user:password@example.com"],
  ["research", "run", "query", "--output-schema", "{}"],
  ["research", "get", "request-id"],
  ["research", "status", "--json", "request-id"],
  ["--status", "--output", "file"],
];

test("Tavily accepts supported retrieval arguments and explicit option values", () => {
  for (const args of accepted) assert.doesNotThrow(() => validateTvly(args), JSON.stringify(args));
});

test("Tavily rejects output, authentication, unknown options, and stdin", () => {
  for (const args of rejected) assert.throws(() => validateTvly(args), JSON.stringify(args));
});

test("curl accepts retrieval only and rejects file/header/request options", () => {
  assert.doesNotThrow(() => validateCurl(["-LsS", "--max-time", "10", "https://example.com"]));
  assert.doesNotThrow(() => validateCurl(["--url=https://example.com", "-H", "Accept: text/plain"]));
  const cases = [
    ["file:///etc/passwd"],
    ["https://user:pass@example.com"],
    ["-o/tmp/result", "https://example.com"],
    ["--config", "/tmp/config", "https://example.com"],
    ["-H", "@/tmp/headers", "https://example.com"],
    ["-H", "Name: value\nOther: value", "https://example.com"],
    ["-X", "DELETE", "https://example.com"],
    ["--data", "payload", "https://example.com"],
    ["--upload-file", "/tmp/file", "https://example.com"],
    ["--max-time", "forever", "https://example.com"],
  ];
  for (const args of cases) assert.throws(() => validateCurl(args), JSON.stringify(args));
});

test("date takes no arguments and an aborted invocation does not spawn", async () => {
  assert.doesNotThrow(() => validateWebInvocation("date", []));
  assert.throws(() => validateWebInvocation("date", ["-s", "tomorrow"]));
  assert.throws(() => validateWebInvocation("bash", ["command"]));
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(createTool(tmpdir()).execute("test", { program: "date", args: [] }, controller.signal, undefined, undefined as any), /aborted/);
});

test("curl ignores automatic config, handles split UTF-8, and remains bounded", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-test-"));
  const forbidden = join(directory, "unexpected-output.txt");
  const originalHome = process.env.CURL_HOME;
  const server = createServer((request, res) => {
    if (request.url === "/large") {
      res.end("界".repeat(60_000));
    } else {
      const bytes = Buffer.from("LOCAL 界 CONTENT");
      res.write(bytes.subarray(0, 7));
      setImmediate(() => res.end(bytes.subarray(7)));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await writeFile(join(directory, ".curlrc"), `output = "${forbidden}"\n`);
    process.env.CURL_HOME = directory;
    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}`;
    const tool = createTool(directory);
    const result = await tool.execute("test", { program: "curl", args: ["-s", url] }, undefined, undefined, undefined as any);
    assert.equal(result.content[0].type === "text" && result.content[0].text, "LOCAL 界 CONTENT");
    await assert.rejects(readFile(forbidden), { code: "ENOENT" });
    const large = await tool.execute("test", { program: "curl", args: ["-s", `${url}/large`] }, undefined, undefined, undefined as any);
    const text = large.content[0].type === "text" ? large.content[0].text : "";
    assert.ok(Buffer.byteLength(text) <= 50 * 1024);
    assert.ok(text.includes("truncated"));
    assert.ok(!text.includes("�"));
  } finally {
    if (originalHome === undefined) delete process.env.CURL_HOME;
    else process.env.CURL_HOME = originalHome;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("web processes report spawn failure, cancellation, timeout, and HTTP failure", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-web-lifecycle-"));
  const controller = new AbortController();
  const server = createServer((request, res) => {
    if (request.url === "/abort") controller.abort();
    if (request.url === "/error") res.writeHead(503).end("unavailable");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const execute = (cwd: string, route: string, signal?: AbortSignal) => createTool(cwd).execute(
      "test", { program: "curl", args: ["-s", "--fail-with-body", `${url}/${route}`], timeout: 1 },
      signal, undefined, undefined as any,
    );
    await assert.rejects(execute(join(directory, "missing"), ""), /ENOENT/);
    await assert.rejects(execute(directory, "abort", controller.signal), /Web command aborted/);
    await assert.rejects(execute(directory, "timeout"), /Web command timed out after 1s/);
    await assert.rejects(execute(directory, "error"), /curl exited with code 22\nunavailable/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});

export default function () {}
