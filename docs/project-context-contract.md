---
doc_kind: reference
topics: [project-context, handoff, project-workflow, clowder]
created: "2026-07-03"
updated: "2026-07-03"
---

# Project Context Contract

> Last updated: 2026-07-03
> Scope: Clowder project fact source under `.cat-cafe/projects/<projectId>/`

## Purpose

Clowder agents must not rely on the current chat window as the only source of project truth.
Each long-running project keeps a small, durable fact source that any agent can read before taking over work.

This contract defines the minimum files, read order, and write rules for that fact source.

## Directory Shape

```text
.cat-cafe/projects/<projectId>/
  brief.md
  progress.md
  decisions.md
  handoff-index.md
  handoff-log.md
  handoffs/
    session-YYYY-MM-DD-topic.md
  security.md            # optional
```

Only `brief.md`, `progress.md`, `decisions.md`, `handoff-index.md`, and `handoff-log.md` are required for the P0 workflow.
`handoffs/` is optional and should be added when a project has durable handoff documents.
`security.md` is optional and should be created when the project touches credentials, permissions, production data, deletion, or external write operations.

## File Responsibilities

### `brief.md`

Defines what the project is.

Must contain:
- one-sentence description
- goals
- acceptance criteria
- constraints
- involved roles / agents

Use it when:
- a new agent joins
- a task references the project but lacks enough context
- project scope feels ambiguous

### `progress.md`

Defines where the project currently stands.

Must contain:
- last updated timestamp
- current phase
- completed work
- in-progress work
- todo items
- current acceptance status

Use it when:
- continuing work
- planning next steps
- reporting status

### `decisions.md`

Defines what has already been decided.

Must contain:
- date
- decision
- rationale
- impact area
- evidence anchor such as task, thread, commit, or doc

Use it when:
- a question may reopen a previous decision
- a new agent needs to understand constraints
- review depends on prior tradeoffs

Do not use it for:
- speculative ideas
- unfinished debate
- low-level implementation notes

### `handoff-index.md`

Defines which handoff file to read, not the full handoff content.

Must contain:
- current takeover entry points
- handoff list with topic, scenario, status
- latest takeover summary

Use it when:
- taking over a long task
- context has been compressed
- switching agent owner

Important rule:
Read the index first. Open a concrete handoff only when the current task matches its module, date, keyword, risk, or explicit pointer.

### `handoff-log.md`

Append-only operational handoff log.

Use it when:
- A2A handoff event appends a short summary
- automated systems need a durable trail

Do not use it as the first file for human or agent takeover. It can grow noisy. Prefer `handoff-index.md`.

### `security.md`

Defines permission and data boundaries.

Create it when the project touches:
- credentials
- production APIs
- file deletion or migration
- external write actions
- sensitive documents or customer data

## Agent Takeover Read Order

```text
1. brief.md
2. progress.md
3. decisions.md
4. handoff-index.md
5. only then: relevant handoff or task thread
```

The agent should produce a short takeover summary before changing files:

```markdown
我接手到的项目状态：
- 当前目标：
- 最近完成：
- 当前阻塞：
- 下一步建议：
- 需要先确认：
```

## Write Rules

### When to update `progress.md`

Update when:
- task moves from planning to implementation
- milestone completes
- next step changes
- acceptance status changes

Do not update for:
- minor comments
- one-off command output
- every small commit

### When to update `decisions.md`

Update when:
- the user or reviewer makes a durable choice
- a previous direction is rejected
- a technical or product constraint is settled

### When to update `handoff-index.md`

Update when:
- a new durable handoff file is added
- current takeover entry point changes
- a handoff becomes stale or superseded

### When to append `handoff-log.md`

Append when:
- an agent hands work to another agent
- an invocation produces an A2A handoff summary

## Prompt Budget Rule

Default prompt injection may include only:
- `brief.md`
- `progress.md`
- `decisions.md`
- `handoff-index.md`

Do not inject:
- all `handoffs/`
- all `handoff-log.md`
- full task history
- full chat history

Open those only through search or explicit task relevance.

## Relationship to Existing Clowder Systems

- `project-init` creates the scaffold.
- `project-workflow` tells agents how to use the scaffold while working.
- Task thread stores execution discussion.
- Task events store state changes and evidence.
- Skill Router decides when to load project workflow instructions.

## Acceptance Criteria

- A new agent can understand project status without reading the full channel history.
- A compressed session can recover by reading the project fact source.
- A review agent can cite durable decisions and current progress.
- Project context stays small enough for prompt injection.
