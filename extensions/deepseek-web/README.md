# deepseek-web

Web search and page fetch for Pi, backed by DeepSeek's tools API.

`web_search` returns ranked results with summaries. `web_fetch` reads a page in full as Markdown. Both use the `deepseek` provider credentials already configured in Pi.

## What the model sees

### `web_search`

**Tool definition** (request payload):

```json
{
  "name": "web_search",
  "description": "Search the web and return ranked results with title, URL, date, and summary. The query supports site:, -site:, \"exact phrase\", lang:, after:, and before: operators.",
  "parameters": {
    "type": "object",
    "required": ["query"],
    "properties": {
      "query": {
        "type": "string"
      }
    },
    "additionalProperties": false
  }
}
```

### `web_fetch`

**Tool definition** (request payload):

```json
{
  "name": "web_fetch",
  "description": "Fetch a web page and return its title and readable content as Markdown.",
  "parameters": {
    "type": "object",
    "required": ["url"],
    "properties": {
      "url": {
        "type": "string"
      }
    },
    "additionalProperties": false
  }
}
```

**System prompt guidance.** This extension's contribution, alongside the other tools in the session:

```
Available tools:
- web_search: Search the web and return ranked results with summaries
- web_fetch: Fetch a web page and return its readable Markdown content
```

Fetched pages are capped at 2000 lines or 50 KB. When a page is longer, the complete Markdown is saved to a temp file and the result includes the path.

## Install

```bash
pi install npm:@zjie-wang/pi-deepseek-web
```

Requires a DeepSeek API key, via the `deepseek` provider or `DEEPSEEK_API_KEY`.
