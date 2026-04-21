# New App Onboarding Checklist

When creating a new app, follow every step in order. Do not skip any step. Run the onboard script first, then verify each item manually.

---

## Quick Start

```bash
cd /Users/bheng/Sites/local-apps
./scripts/onboard-app.sh <app-id> "<App Name>" /Users/bheng/Sites/<app-id> --color R,G,B
```

---

## Phase 1: Scaffold

- [ ] Create project: `npx create-next-app@latest` (App Router, TypeScript, Tailwind)
- [ ] Verify `npm run dev` works on assigned port
- [ ] Add `"dev": "next dev -p PORT"` to package.json scripts
- [ ] Add `"test": "vitest"` or `"test": "jest"` to package.json scripts
- [ ] Add `"typecheck": "tsc --noEmit"` to package.json scripts
- [ ] Add `"lint": "next lint"` to package.json scripts

## Phase 2: Git + GitHub

- [ ] `git init && git add -A && git commit -m "feat: initial commit"`
- [ ] `gh repo create bunlongheng/<app-id> --private --source=. --push`
- [ ] Add repo description via `gh repo edit --description "..."`
- [ ] Add topics: `gh repo edit --add-topic nextjs --add-topic react --add-topic typescript`
- [ ] Delete `.github/dependabot.yml` if it exists (each merged PR = 1 Vercel deploy)
- [ ] Close any open Dependabot PRs

## Phase 3: Local Apps Monitor

- [ ] Register app:
  ```bash
  curl -X POST http://localhost:9876/api/apps \
    -H "Content-Type: application/json" \
    -d '{"id":"<app-id>","name":"<App Name>","localPath":"/Users/bheng/Sites/<app-id>"}'
  ```
- [ ] Verify auto-assigned port (3000-9875 range)
- [ ] Verify Caddy proxy works: `http://<app-id>.localhost`
- [ ] Verify LaunchAgent created: `ls ~/Library/LaunchAgents/com.bheng.<app-id>.plist`
- [ ] Verify health check shows green dot on dashboard
- [ ] Generate favicon: `curl -X POST http://localhost:9876/api/generate-icons/<app-id>`
- [ ] Write Gemini logo prompt in `public/logos.html` PROMPTS object (desc + prompt for the new app)
- [ ] Generate logo with Gemini using the prompt (1024x1024, dark bg, rounded iOS corners, no text)
- [ ] Process logo with sharp: resize to 256x256 PNG, keep rounded iOS corners, alpha channel
- [ ] Save to `public/favicons/<app-id>.png`
- [ ] Add FAVICONS entry in `public/logos.html`
- [ ] Add FAVICONS entry in `public/index.html`
- [ ] Start the app: `launchctl load ~/Library/LaunchAgents/com.bheng.<app-id>.plist`
- [ ] Verify app is running: `curl -s -o /dev/null -w '%{http_code}' http://localhost:<port>`
- [ ] Take first screenshot: `curl -X POST http://localhost:9876/api/screenshots/<app-id>`

## Phase 4: Vercel Deployment

- [ ] `cd /Users/bheng/Sites/<app-id> && vercel link --yes`
- [ ] Push to deploy: `git push`
- [ ] Verify live at `https://<app-id>-bheng.vercel.app`
- [ ] Set homepage URL: `gh repo edit --homepage "https://<app-id>-bheng.vercel.app"`
- [ ] Create `vercel.json` with ignoreCommand:
  ```json
  {
    "ignoreCommand": "git log -1 --format=%s | grep -qE '^(chore|ci|test|docs):'"
  }
  ```

## Phase 5: Shell Alias

- [ ] Add entry to `~/.claude-tabs.sh`:
  ```bash
  _<appname>()    { _tab "<app-id>"  "<APP NAME>"  R  G  B; }
  ```
- [ ] `source ~/.zshrc` to reload
- [ ] Test: type `_<appname>` to verify tab color + Claude session launch

## Phase 6: Security

- [ ] Add security headers to `next.config.ts`:
  ```ts
  headers: async () => [{
    source: '/(.*)',
    headers: [
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
      { key: 'Strict-Transport-Security', value: 'max-age=63072000; includeSubDomains; preload' },
    ],
  }]
  ```
- [ ] Run `npm audit` - must be 0 vulnerabilities
- [ ] Never expose `SUPABASE_SERVICE_ROLE_KEY` to client bundle
- [ ] Use `NEXT_PUBLIC_` prefix only for safe-to-expose env vars
- [ ] Create `.env.example` with placeholder values (never commit `.env`)

## Phase 7: Auth (if needed)

- [ ] Implement auth for production routes
- [ ] Bypass auth for localhost/LAN access (match existing pattern)
- [ ] Validate JWT on every protected API route

## Phase 8: Performance

- [ ] Use `next/image` for all images (no raw `<img>` tags)
- [ ] Use `Promise.all` for parallel server-side fetches
- [ ] Add `outputFileTracingExcludes` for `*.md` files in next.config.ts
- [ ] Lighthouse desktop 99+, mobile 90+
- [ ] No CSS modules or styled-components - Tailwind only
- [ ] Inline `style={{}}` only for dynamic runtime values

## Phase 9: Pre-push Hook

- [ ] Create `.husky/pre-push`:
  ```bash
  #!/bin/sh
  npm run typecheck
  ```
- [ ] Install husky: `npx husky init`
- [ ] Never use `npm run build` in pre-push (causes lock conflicts)

## Phase 10: Commit Conventions

- [ ] Commit prefixes that trigger Vercel deploy: `feat:`, `fix:`, `refactor:`, `perf:`
- [ ] Commit prefixes that skip deploy: `chore:`, `ci:`, `test:`, `docs:`
- [ ] Never `git push` without explicit approval
- [ ] Always `git stash && git pull --rebase && git stash pop && git push`
- [ ] Never force push

## Phase 11: Final Verification

- [ ] App shows UP on local-apps dashboard
- [ ] Caddy URL works: `http://<app-id>.localhost`
- [ ] LAN URL works: `http://10.0.0.218:<port>`
- [ ] Prod URL works: `https://<app-id>-bheng.vercel.app`
- [ ] Shell alias works: `_<appname>`
- [ ] Screenshots captured (desktop + mobile)
- [ ] Favicon generated and showing on dashboard
- [ ] `npm test` passes
- [ ] `npm audit` clean
- [ ] Lighthouse 99+ desktop
- [ ] Added to nightly test pipeline (auto via local-apps registration)

---

## Post-Onboard Maintenance

These happen automatically via existing crons:

| What | When | Cron |
|------|------|------|
| Health check | Every 30s | auto-restart |
| Quick fix + Claude agents | Every 5min | health-check-fix |
| Git sync | 12 AM | git-pull-all |
| Unit + E2E tests | 1 AM | nightly-tests |
| Link crawl | 1:30 AM | nightly-crawler |
| Screenshots | 2 AM | nightly-screenshots |
| GIF recordings | 3 AM | nightly-gifs |
| Deep audit | 4 AM | deep-audit |
| Security scan | 5 AM | nightly-scan |
| Summary to Stickies | 6 AM | nightly-summary |
| Health reminders | Every 45min (8AM-8PM) | health-reminder |
