---
doc_kind: reference
topics: [project-workflow, project-context, skill-routing, clowder]
created: "2026-07-03"
updated: "2026-07-03"
---

# Project Workflow Pack

> Last updated: 2026-07-03
> Source inspiration: `~/Downloads/ai-project-workflow-skill-main`

## Goal

Project Workflow Pack turns Clowder project work from chat-memory-driven execution into workspace-fact-driven execution.

It does not replace `project-init`.

- `project-init`: creates the project fact source.
- `project-workflow`: uses the fact source to continue, understand, review, and hand off work.

## Three-Layer Model

```text
Layer 1: Project Progress
Layer 2: Code Intelligence
Layer 3: Review Engine
```

Agents should load the smallest layer set that covers the task.

## Layer 1: Project Progress

Use when:
- continuing a project
- updating status
- writing a handoff
- clarifying scope
- deciding next steps

Read:
- `.cat-cafe/projects/<projectId>/brief.md`
- `.cat-cafe/projects/<projectId>/progress.md`
- `.cat-cafe/projects/<projectId>/decisions.md`
- `.cat-cafe/projects/<projectId>/handoff-index.md`

Output:
- takeover summary
- next-step plan
- progress update
- handoff entry or handoff index update when needed

Do not:
- read all handoffs by default
- rewrite history
- bury decisions in chat only

## Layer 2: Code Intelligence

Use when:
- work spans modules
- the agent is unfamiliar with the code area
- API or contract behavior may change
- the user asks how the system is organized
- review needs impact context

Durable artifacts:

```text
docs/project/system-map.md
docs/project/modules.md
docs/project/api-index/<module>.md
```

Rules:
- Read code first, infer second.
- Mark uncertainty as `To confirm`.
- Refresh only the relevant slice.
- Do not build a full code map for a local one-file change.

## Layer 3: Review Engine

Use when:
- user asks for review
- task is in `in_review`
- change touches security, billing, auth, data, migrations, or external writes
- diff spans multiple modules
- release or merge judgment is needed

Start with:

```bash
git status --short
git diff HEAD
```

Output findings first:

```markdown
## Findings

### [P0] <title>
- File: <file>:<line>
- Problem:
- Suggestion:

## Risk Score
- Total: x/10
- Reason:

## Verification
- Passed:
- Not verified:
```

Severity:
- P0: blocking
- P1: serious, should fix
- P2: improvement

## Trigger Rules

Use `project-workflow` when user says:
- “继续推进”
- “接手这个项目”
- “看下当前进度”
- “写交接”
- “项目工作流”
- “判断影响范围”
- “review 这个任务”
- “验收这个任务”

Do not use for:
- tiny one-off questions
- pure UI copy changes
- local environment startup unless it affects project status
- tasks with a fully specified local implementation and no durable project state change

## Default Takeover Flow

```text
1. Identify projectId.
2. Read project fact source.
3. Summarize takeover state.
4. Ask only blocking clarification questions.
5. Execute or plan based on task size.
6. Update progress/decisions/handoff only when durable state changed.
```

## Relationship to Task System

```text
Main channel = decision room
Task = work card
Task thread = execution room
Evidence = proof of completion
Project fact source = durable memory
```

Project Workflow Pack should not move execution logs into the main channel.
Execution details belong in task thread and evidence.

## P0 Implementation Scope

P0 includes:
- project context contract document
- project workflow pack document
- `cat-cafe-skills/project-workflow/SKILL.md`
- project-init scaffold upgrade
- one Clowder dogfood project fact source

P0 excludes:
- broad UI redesign
- Obsidian integration, except the later Phase 6 read-only collection hook
- Figma or opencli integration
- automatic skill marketplace routing
- importing every personal skill

## Phase 6: Read-Only Knowledge Collections

Clowder can mount an Obsidian vault as a read-only knowledge collection.
This is for retrieval and citation only.
See [Clowder 权限边界两层说明](./security-permission-boundaries.md) for the security boundary contract.

Configure:

```bash
OBSIDIAN_READONLY_ROOTS=domain:orbitos-knowledge=~/Documents/03 life/AI design/OrbitOS-CN/400知识库
```

Behavior:
- registers the vault as an internal `domain:*` collection
- never writes to the Obsidian vault
- writes only Clowder index cache under `~/.cat-cafe/library/`
- skips `.obsidian/`
- requires explicit rebuild before fresh content appears in search

Boundary:
- real boundary is the local OS / filesystem permission of the Clowder process
- Clowder read-only collection behavior is a safety net, not an OS-level read-only mount
- secret quarantine excludes matched files from the index; it does not delete files or rotate credentials

Rebuild locally:

```bash
POST /api/library/domain:orbitos-knowledge/rebuild
```

Search with citation source:

```bash
GET /api/evidence/search?q=<query>&dimension=collection&collections=domain:orbitos-knowledge
```

Search results include `sourcePath`, so an agent can cite the original note path in handoff or review output.

## Phase 7: Controlled External Tools

Figma MCP and opencli-style browser tools are allowed only through the capability system.
They must not be silently enabled by an agent.
The real boundary is the OS process permission, browser/Figma account permission, and remote service authorization.
Clowder provides install preview, disabled-by-default config, per-task enablement, confirmation, and audit as safety nets.

Install preview policy:
- Figma/opencli MCP entries are created with `enabled=false`
- install does not automatically probe them
- preview risks must mention task-scoped authorization
- preview risks must mention capability audit / tool usage evidence
- high-risk external writes, batch operations, or credentialed access require explicit confirmation

Expected flow:

```text
User requests Figma/opencli task
  → agent checks capability board / marketplace
  → install preview shows risks
  → owner installs but capability remains disabled
  → user enables for the task scope
  → tool usage and capability changes remain auditable
```

This phase creates the first safety gate.
It does not grant broad tool execution permission by itself, and it is not a sandbox by itself.

## Acceptance Criteria

- `project-init` creates a fact source with brief, progress, decisions, handoff-index, and handoff-log.
- `project-workflow` is listed in `cat-cafe-skills/manifest.yaml`.
- Clowder itself has a dogfood `.cat-cafe/projects/clowder/` fact source.
- Prompt project context can include decisions and handoff index without injecting full handoff logs.
