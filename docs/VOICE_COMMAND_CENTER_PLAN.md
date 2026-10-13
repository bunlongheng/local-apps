# Local Apps Voice Command Center - Project Plan
Date: 2026-10-13
Status: Agreed direction and phased implementation plan; not yet implemented

## Objective
Extend the existing open-source Local Apps project so its owner can monitor local development servers, Claude Code sessions, repositories, and multiple client projects from a mobile-friendly dashboard and natural spoken conversations. Avoid duplicating the existing monitoring/recovery engine. Preserve client confidentiality and require authentication for any remote access.

## Existing foundation verified in the repository
- Node.js 22 single-process API and vanilla-JS dashboard, port 9875.
- SQLite via better-sqlite3.
- Server-Sent Events for live updates.
- 30-second health checks, launchd LaunchAgents, Caddy proxies, LAN/Tailscale links, multi-machine hub/agent mode.
- Five recovery stages: kickstart, reload, log-driven remediation, optional Claude CLI help, circuit breaker.
- Existing API routes include /api/status, /api/apps, /api/events, and app controls.
- Existing off-box token gate and localhost trust are NOT sufficient on their own for a remotely exposed voice-command product.

## Decisions
1. **Build on Local Apps**, not a new competing supervisor or a wholesale rewrite.
2. **Keep one primary open-source repository** for the product. If native iOS is added, put it under an app directory in the same repository; release/build pipelines may remain separate. The existing Local Apps Launcher Chrome extension is a distinct project.
3. **Keep the existing Node.js/JavaScript implementation initially.** Introduce TypeScript for new modules if it can be done incrementally without gratuitous migration. Do not introduce Rust simply for eight monitored sessions.
4. **Two complementary voice paths**, not a forced choice:
   - Route A (first, cheapest experiment): Existing ChatGPT Voice reads sanitized, read-only status snapshots via an authorized GitHub connection from a dedicated private feed repository. Availability of that connection inside Voice must be validated end-to-end.
   - Route B (standalone): Add a responsive web/PWA voice UI using a configurable realtime voice model (start by testing the lower-cost Realtime Mini; benchmark quality, latency, and actual API billing). A native SwiftUI iOS client is desired and should share the API; its precise launch phase follows the read-only proof of concept.
5. **No new mandatory subscription.** Keep Claude Code for coding; voice and monitoring do not replace it. API voice charges, if used, are separate from ChatGPT subscription voice usage.
6. **Secure remote access**: Cloudflare Tunnel + Cloudflare Access (email PIN or Google/OIDC) as a convenient option; Tailscale Serve remains an option. Knowing a URL is never authentication. Provider choice should remain flexible for open-source users.
7. **Server-side authorization is mandatory**, including on localhost/proxied requests that can lead to code execution. Read-only status and mutating agent commands must have separate scopes. Dangerous actions require explicit approval. Never auto-replay deploys or other non-idempotent tasks after a crash.
8. **Monitoring**: Keep external heartbeat monitoring optional (e.g. Healthchecks.io), distinct from local session health. launchd restarts the supervisor; use bounded retries/circuit breakers for agents. A Mac that loses power cannot send its own outage alert.
9. **Open source**: preserve existing project's license (currently MIT) unless explicitly changed later. Provide redacted examples, documentation and tests. Never publish private client info or credentials.

## Status feed schema and cadence (proposal, to implement)
Use a separate **private repository** for snapshots because Git history retains prior versions. Do NOT commit real client status, local filesystem paths, full Claude transcripts or credentials to the public local-apps repo.
- status.json - every 5 minutes; snapshot timestamp, machine overall health, aggregate counts, alert IDs. Include stale-after semantics.
- sessions/index.json - every 5 minutes or on important events; minimal session IDs, project aliases, state, last activity.
- sessions/{session-id}.json - on meaningful change and periodic reconciliation; active task, verified accomplishments, blockers, PR/commit evidence, last update. Sanitize all output.
- projects/{project-id}.json - event-driven and periodic rollup of sessions, work, blockers, and repo CI/PR state.
- briefings/morning.md - once every morning, initially 8:00 AM local time (configurable).
- briefings/hourly.md - hourly delta, with generation skipped if nothing meaningful changed.
Each artifact must carry generated_at, source freshness, and evidence/citations where available. Separate observable facts from agent self-reports. Write atomically, publish only changed content, and coalesce commits to avoid excessive GitHub history/API calls. Scheduled work needs the Mac to be running. For time-sensitive alerts use events/notifications instead of waiting for a GitHub refresh.

## Proposed implementation phases
Phase 0: Audit auth and current status schemas; define threat model; confirm what Claude CLI session metadata and resume support are available. Define sanitized data contracts and test with synthetic data.
Phase 1: Implement read-only snapshot publisher on top of existing Local Apps monitor, with a separate private feed destination and scoped GitHub token. Test reading the snapshot via ChatGPT's connected GitHub integration in an actual Voice conversation; do not assume support without a real test.
Phase 2: Add Claude session discovery/registry and per-project mapping, progress summaries grounded in commits/PRs and bounded event logs. Distinguish completed, idle, waiting approval, disconnected, crashed, recovering.
Phase 3: Add mobile-first voice experience via separate UI module using WebRTC and an authenticated orchestration API; use voice provider adapters. Keep audio direct to the voice provider where appropriate, but do not expose long-lived API secrets to clients.
Phase 4: Add managed Claude Code sessions for reliable start/resume/task dispatch, authorization checks and non-idempotent action approval. Terminal tabs launched independently may not be safely controllable without registration.
Phase 5: Add SwiftUI native client sharing OpenAPI contracts and authentication. Build and signing require Xcode; a repo clone alone is not an installed iOS app.
Phase 6: Improve reliability, alert delivery, installation, documentation, cross-platform support and open-source onboarding.

## Suggested API boundary
Read-only: GET /api/voice/system, /api/voice/sessions, /api/voice/sessions/:id, /api/voice/projects/:id.
Mutations (future, approval gated): POST /api/voice/sessions/:id/resume, /api/voice/sessions/:id/instructions.
Do not publish raw sensitive logs as general read endpoints; use least-privilege and audit logs.

## Validation and acceptance
- Can answer: "How are my sessions doing?", "What did session X achieve today?", "What is blocked on project Y?", and "Give me my morning briefing" using timestamped evidence.
- Session feed explicitly says stale/unavailable rather than inventing live status.
- Off-box unauthenticated status and commands cannot reveal private data or execute anything. All proxy paths are tested.
- Repeated session exits cannot cause infinite relaunch or a repeated deployment.
- Existing dev-server self-healing behavior, tests, and workflows remain functional.

## Open questions, not final decisions
- Preferred future Swift app release/distribution mechanism.
- Choice of OIDC/passkey providers and optional local-password setup.
- Whether ChatGPT Voice can access the private feed in this exact account after the connector test.
- Default external alert service and realtime voice provider after measured trials.

This is a planning artifact summarizing the discussion. It is not a claim that any voice, session-control, or status publishing feature has shipped.
