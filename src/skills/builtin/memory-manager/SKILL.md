---
id: memory-manager
name: Memory Manager
description: Store, search, and prune persistent agent memory. Supports semantic search, namespace isolation, and selective pruning to keep memory lean and relevant across sessions.
tags: [memory, persistence, search]
apiKeyRequired: false
commands:
  - name: search
    description: Semantic search over stored memories
    args: [query, limit]
  - name: store
    description: Persist a new memory entry
    args: [content, namespace]
  - name: prune
    description: Remove outdated or low-relevance memories
    args: [namespace, before_date]
---

# Memory Manager

Persistent cross-session memory for an agent. Entries survive restarts and session clears.

## Available Tools

| Tool | Purpose |
|---|---|
| `memory_store` | Save a new memory entry with optional namespace tag |
| `memory_search` | Full-text + semantic search across stored memories |
| `memory_list` | List memories in a namespace |
| `memory_delete` | Remove a specific memory by id |

## Usage Patterns

### Saving a Key Fact
```
Use memory_store to save:
  content: "User prefers reports in Markdown with H2 section headers."
  namespace: "preferences"
```

### Recalling Context Before a Task
```
Before starting a long task, call memory_search with the task topic
to surface relevant prior context.
```

### Post-task Cleanup
```
After completing a project, use memory_delete or memory_list + memory_delete
to remove stale entries that are no longer relevant.
```

## Namespace Conventions

- `preferences` — user preferences and style rules
- `facts` — domain facts learned during interactions
- `tasks` — task state that should survive session boundaries
- `<project-id>` — project-scoped memories

## Notes

- Memory is stored in SQLite under `~/.agentflyer/` — no external service required.
- `memory_search` uses BM25 full-text search; no vector embedding is needed.
- Memory entries are private per gateway instance.
