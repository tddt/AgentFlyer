---
id: skill-creator
name: Skill Creator
description: Create new SKILL.md skill definition files from scratch. Guides you through the frontmatter schema (id, name, description, tags, commands, apiKeyRequired) and content body best-practices so the generated skill integrates cleanly into the AgentFlyer registry.
tags: [skill, authoring, meta]
apiKeyRequired: false
---

# Skill Creator

Use this guide to create a new SKILL.md file that will be auto-discovered by the AgentFlyer skill registry.

## SKILL.md Structure

```markdown
---
id: my-skill-id          # kebab-case, unique across the registry
name: My Skill Name      # Human-readable display name
description: |
  One or two sentences describing what the skill enables.
  Keep under 200 chars for the short-desc truncation.
tags: [category, tool]  # Used for filtering and search
apiKeyRequired: false    # true if the skill needs an external API key
commands:                # Optional: list named sub-commands
  - name: do-thing
    description: Executes the primary action
    args: [input, options]
---

# My Skill Name

## Overview
Explain what the skill does and when to use it.

## Usage
Step-by-step instructions for the agent.

## Examples
Concrete prompt → action → result examples.

## Notes
Limitations, prerequisites, or caveats.
```

## Placement Rules

| Location | Scope |
|---|---|
| `~/.agentflyer/skills/<id>/SKILL.md` | User-global — available to all agents |
| `<workspace>/skills/<id>/SKILL.md` | Workspace-local — auto-merged for the owning agent |
| Config `skills.dirs[]` | Extra pool — available to all agents whose config references it |
| `<package>/src/skills/builtin/<id>/SKILL.md` | Built-in — always available, no config required |

## Steps to Create a Skill

1. Decide the skill **id** (kebab-case, globally unique).
2. Choose the placement directory from the table above.
3. Create the directory: `mkdir -p <dir>/<id>`.
4. Write `SKILL.md` following the structure above.
5. Restart the gateway or use the console **Reload** button — the skill appears in the pool immediately.
