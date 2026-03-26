---
id: web-researcher
name: Web Researcher
description: Search the web, fetch page content, and synthesize structured research reports from multiple sources. Ideal for fact-finding, competitive analysis, and gathering background context.
tags: [web, search, research, fetch]
apiKeyRequired: false
commands:
  - name: search
    description: Web search using configured search provider
    args: [query, num_results]
  - name: fetch
    description: Fetch and clean a web page as readable text
    args: [url]
  - name: summarize
    description: Summarize a set of fetched pages into a research brief
    args: [topic, urls]
---

# Web Researcher

Structured web research: search → fetch → synthesize.

## Available Tools

| Tool | Purpose |
|---|---|
| `web_search` | Query the configured search provider (DuckDuckGo / SerpAPI) |
| `web_fetch` | Fetch a URL and return clean Markdown text |

## Research Workflow

1. **Identify** the research question and break it into sub-questions if complex.
2. **Search** each sub-question: `web_search(query)` → collect top-N URLs.
3. **Fetch** promising pages: `web_fetch(url)` → extract relevant excerpts.
4. **Synthesize**: combine excerpts into a structured answer with citations.

## Output Template

```markdown
## Research Brief: <topic>

### Summary
<3-5 sentence summary of findings>

### Key Findings
1. …
2. …

### Sources
- [Title](url) — one-line description
```

## Tips

- Prefer 3–5 sources minimum before synthesizing to reduce hallucination risk.
- When fetching, skim for headers and bolded text first to locate relevant sections quickly.
- Add inline citations `[Source N]` when quoting or paraphrasing specific text.
- If search results are thin, broaden the query or use alternative phrasing.
