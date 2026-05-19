# ADR-023: Slock-style A2A Message Routing

Date: 2026-05-17
Status: Proposed
Task: #79

## Context

Clowder is being moved toward a Slock-like collaboration model: a thread should feel like a group chat where humans and agents are members, and agent-to-agent handoff should happen through visible messages rather than hidden call-stack continuation.

The current codebase is more advanced than the old course note describes. It already has `InvocationQueue`, slot-aware `InvocationTracker`, callback enqueue, ping-pong guards, and delivery cursors. That means this migration must be incremental. A direct rewrite would risk creating a third routing path instead of simplifying the system.

## Current Routing Paths

### 1. User message dispatch

Entry point: `packages/api/src/routes/messages.ts`

Current flow:

```text
POST /api/messages
  -> router.resolveTargetsAndIntent(...)
  -> InvocationRecord.create(...)
  -> messageStore.append(user message)
  -> router.routeExecution(...)
  -> routeSerial(...) or routeParallel(...)
```

Evidence:
- `messages.ts:435-443` resolves target cats and intent from message text.
- `messages.ts:459-491` decides queue vs immediate execution based on active slots.
- `messages.ts:493-503` enqueues busy-thread messages.
- `messages.ts:604-681` uses `tryStartThreadAll` to register slots before execution.
- `messages.ts:842-875` starts `routeExecution` with one shared controller for the resolved target cats.

### 2. `routeSerial` worklist text scan

Entry point: `packages/api/src/domains/cats/services/agents/routing/route-serial.ts`

Current flow:

```text
routeSerial(targetCats)
  -> registerWorklist(threadId, worklist)
  -> run cat A
  -> parseA2AMentions(cat A final text)
  -> worklist.push(cat B)
  -> run cat B in same serial chain
```

Evidence:
- `route-serial.ts:253-258` creates and registers a mutable worklist.
- `route-serial.ts:1012-1014` scans final stored agent text with `parseA2AMentions`.
- `route-serial.ts:1457-1531` pushes mentioned cats into the same worklist.
- `route-serial.ts:1547-1583` and `1771-1809` emit `a2a_handoff` for newly appended targets.

This is the "telephone transfer" path. It preserves shared context and `isFinal` semantics, but it is not Slock-like because the handoff is hidden inside the current invocation chain.

### 3. Callback `post_message` A2A enqueue

Entry point: `packages/api/src/routes/callbacks.ts`

Current flow:

```text
agent calls callback post_message(...)
  -> messageStore.append(agent callback message)
  -> analyzeA2AMentions + explicit targetCats
  -> enqueueA2ATargets(...)
  -> InvocationQueue agent entry, or legacy worklist/fallback
```

Evidence:
- `callbacks.ts:650-696` parses line-start mentions and explicit `targetCats`.
- `callbacks.ts:755-780` persists the callback message as a timeline message.
- `callbacks.ts:785-810` invokes `enqueueA2ATargets`.
- `callback-a2a-trigger.ts:93-213` prefers `InvocationQueue` when available.
- `callback-a2a-trigger.ts:216-220` still has a legacy worklist branch when queue deps are absent.
- `callback-a2a-trigger.ts:354-455` still has standalone fire-and-forget fallback.

This path is closer to Slock because the agent produces a real message first, then routing follows that message. The risk is that legacy fallbacks still exist.

### 4. Special callback dispatchers

Some callback flows bypass normal message sending but still use A2A dispatch.

Evidence:
- `callbacks.ts:1678-1710` vote notification uses `enqueueA2ATargets`, then falls back to `triggerA2AInvocation` if queue capacity overflows.

These special paths must be included in Phase 4 regression tests. Removing worklist text scan without checking these paths can break voting / multi-agent workflow features.

## Risk Points

### Risk 1: Hidden routing remains after visible routing is added

If Phase 3 adds "thread member broadcast" while `routeSerial` still scans final text, a single visible `@agent` can produce two routes:

```text
visible message dispatch
  + hidden final-text scan
  = duplicate invocation risk
```

Risk lines:
- `route-serial.ts:1012-1014`
- `route-serial.ts:1457-1531`
- `callbacks.ts:785-810`

### Risk 2: `participants` is not the same as Slock channel membership

`Thread.participants` currently means "cats that have participated / activity history", not "configured members who should receive thread messages".

Evidence:
- `ThreadStore.ts:105` has `participants: CatId[]`.
- `ThreadStore.ts:120-121` has `preferredCats?: CatId[]` for default routing.

Decision: do not overload `participants`. Add a separate `participatingCats` or `memberCats` field for Slock-style configured channel members.

### Risk 3: Broadcasting every message to every member can create noise

Slock-like does not have to mean "every agent replies to every message". Safer semantics:

1. Explicit `@agent` always dispatches to that agent.
2. Thread member list controls who is selectable / eligible / visible.
3. Optional later toggle can enable "all members auto-receive" for selected channels.

Default should be mention-driven to avoid cost explosion and multi-agent noise.

### Risk 4: Input locking is tied to thread-level execution state

Current `POST /api/messages` may return queued / busy states for whole-thread execution. Slock-style UX wants the human to keep typing even while agents work.

This should be handled as part of explicit message dispatch: user messages are always stored immediately, and agent execution is queued per target cat.

## Migration Plan

### Phase 0: ADR and boundary map

Task: #79

Deliverable: this ADR.

Acceptance:
- Current A2A paths are listed.
- Double-trigger risk points are identified by file and line.
- Next phases have clear boundaries.

### Phase 1: Thread member configuration

Task: #80

Goal: add Slock-like channel membership without changing routing behavior yet.

Scope:
- Add `participatingCats` or `memberCats` to thread storage.
- Add API to read/update thread members.
- Add UI to add/remove agents in channel settings.
- Show member avatars in thread header.

Non-goal:
- Do not broadcast messages to all members yet.
- Do not remove worklist yet.

### Phase 2: Visible message dispatch

Task: #81

Goal: make agent-to-agent collaboration visible and message-driven.

Scope:
- Keep callback `post_message` as the canonical A2A handoff surface.
- Ensure callback messages are timeline-visible with agent sender identity.
- For explicit `targetCats` / `@agent`, enqueue target cat through `InvocationQueue`.
- Move user input semantics toward "message accepted first, agent work queued separately".

This phase includes the UX intent of the old task #82: the user should be able to keep sending messages while agent work is in progress.

Non-goal:
- Do not delete `routeSerial` text scan yet. Gate it behind a feature flag / routing mode first.

### Phase 3: Retire hidden worklist routing

Task: #83

Goal: remove the hidden route where final agent text automatically appends cats into the same `routeSerial` worklist.

Scope:
- Introduce routing mode, defaulting to legacy until Phase 2 is proven.
- In Slock mode, disable `parseA2AMentions` -> `worklist.push`.
- Keep explicit callback `targetCats` and visible `post_message` routing.
- Remove or quarantine standalone fallback only after regression passes.

Required regression:
- User `@agent` dispatch.
- Agent callback `post_message("@agent ...")` dispatch.
- Vote notification dispatch.
- Queue busy/dequeue path.
- Stop/cancel per active cat.
- No duplicate invocation when the same `@agent` appears in callback message and final CLI output.

## Decision

Proceed with the 4-node plan:

```text
#79 ADR
  -> #80 Thread members
  -> #81 Visible message dispatch + continuous input
  -> #83 Retire hidden worklist + regression
```

Close / merge the original task #82 into #81. It is a required UX outcome, but not a separate architecture phase.

## Open Questions

1. Should default thread behavior dispatch only explicit `@agent`, or should some channels auto-dispatch to all `participatingCats`?
   - Recommendation: explicit `@agent` first. Add auto-dispatch as opt-in later.

2. Should `preferredCats` be replaced by `participatingCats`?
   - Recommendation: no. Keep `preferredCats` as routing preference; add `participatingCats` as membership.

3. Should legacy worklist be removed or feature-flagged?
   - Recommendation: feature-flag first, remove after regression and user validation.
