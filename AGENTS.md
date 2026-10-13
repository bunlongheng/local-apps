# AGENTS.md - Local Apps contributor and automation guidance

Follow existing CLAUDE.md, tests, and repo conventions. This file adds requirements for the planned Voice Command Center extension. See docs/VOICE_COMMAND_CENTER_PLAN.md for decisions.

## Safety and scope
- Never deploy or expose remote APIs without authentication and authorization. Fail closed when auth is missing.
- Preserve the existing Local Apps dashboard, monitor, recovery ladder, SQLite data and APIs. Favor minimal, isolated changes over rewrites.
- Read-only reporting is not permission to launch commands. Use distinct scopes for system status versus mutation. Require explicit user approval for shell commands, destructive actions, repository changes, and deployments.
- Never place credentials, full transcripts, private code, real client names, raw filesystem paths, or sensitive logs in a public repository or published feed. Test with synthetic fixtures.
- This public repo contains documentation and code only. Runtime snapshots must go to a separate, explicitly configured PRIVATE destination and use a least-privilege token. No publisher should run unless a secure destination is configured.
- Never infer a Claude session is crashed solely due to inactivity, or retry a finished/approved-stopped job.

## Planned status publisher contracts
Implement as an opt-in feature, not automatically on documentation merge. Use structured, sanitized records from the existing monitor and future Claude session registry.
- `status.json`: every 5 min when enabled; overall machine health, app/session counts, alerts, `generated_at` UTC, `stale_after`.
- `sessions/index.json`: every 5 min and on important session events; redacted session key, project alias, lifecycle state and last activity.
- `sessions/{session-id}.json`: meaningful transitions and periodic reconciliation; activity, current task, verified achievements, blockers, source evidence; NEVER full transcripts.
- `projects/{project-id}.json`: event-driven plus periodic project rollup.
- `briefings/morning.md`: daily at configured local time (default 08:00), with timestamp and evidence.
- `briefings/hourly.md`: hourly change summary; skip no-change publication.
Use timezone-aware scheduling (configurable, default America/New_York). Mac must be awake; missed schedules should be handled deterministically without duplicate summaries. Content should identify stale/unavailable data.
Publisher requirements: validate schema; redact before persistence; atomic local writes; publish only when changed; batch/coalesce Git commits; bounded retries and backoff; no overlapping runs; observability and tests. Define retention/history implications before enabling publication.

## Engineering implementation sequence
1. Threat model + authenticate all sensitive reads and mutations, including proxied localhost requests.
2. Add synthetic fixtures and tests for status schema, redaction, stale timestamps, and private-publishing configuration.
3. Add opt-in snapshot publisher without disrupting `/api/status`.
4. Add Claude Code session discovery and evidence-based progress tracking.
5. Verify reading status via connected GitHub within a real ChatGPT Voice conversation before treating that route as supported.
6. Add optional standalone WebRTC voice adapter, protected tool API, then SwiftUI client with generated contracts.
7. Add bounded session recovery and external heartbeat integrations.

## Coding standards and tests
Keep code small, readable, safe, well-tested and without duplicated business logic. Reuse `lib/monitor.js`, `lib/auth-gate.js`, `lib/tick.js`, and existing routes where appropriate; preserve the circuit breaker. Extend Node tests for auth, malformed inputs, session state transitions, timing, and read-only guarantees. Do not run destructive e2e tests against the live hub. Preserve the repo's current MIT license.

## Agent workflow for implementing the publisher
An agent asked to generate status data must FIRST verify the authorized destination is private and configured, and that its source data is available. If not, generate only synthetic sample files in a scratch directory, not in this repository as purported live status. Do not fabricate results or pretend this documentation schedules anything by itself. Report test outcomes and unresolved integration constraints accurately.
