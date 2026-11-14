<!-- Tracked copy of the subagent-driven-development ledger for this plan.
The working copy lives in the git-ignored `.superpowers/sdd/2026-11-14-peak-order-from-line/progress.md` on the Mac.
Whoever continues the plan appends here (and to the working copy when it exists) after every task. -->

## How to resume without the superpowers plugin scripts (cloud / iPad)

1. Read the spec, the plan header (Global Constraints + Review Focus), and this ledger's "Rulings" — rulings override the plan where they differ.
2. Find the first task without a `complete` line below. Record `BASE=$(git rev-parse HEAD)`.
3. Implementer: one fresh subagent per task (Agent tool, explicit model — sonnet for mechanical tasks, opus for Tasks 3, 10, 12, 13). Give it: the task's section of the plan (`### Task N` … next `###`), the Global Constraints, any ruling below that names the task, and a report-file path. It must follow the task's TDD steps, commit once green, and never spawn subagents.
4. Reviewer: a different fresh subagent per task (sonnet; opus for Tasks 3, 10, 13). Give it the same task text, the Global Constraints, the implementer's report, and a diff file made with `git log --oneline BASE..HEAD; git diff --stat BASE..HEAD; git diff -U10 BASE..HEAD > <file>`. It returns two verdicts: spec compliance (✅/❌/⚠️) and task quality (Approved / Needs fixes) with Critical/Important/Minor findings. Never tell it what to ignore.
5. Critical/Important findings → send them back to the same implementer (max 5 fix rounds, each followed by a re-review scoped to the fix diff). Minor findings → list them here as `minor (deferred)`. ⚠️ "cannot verify" items → the controller checks them itself.
6. Append `Task N: complete (commits <base7>..<head7>, review clean)` here, **commit this ledger and `git push origin feat/peak-order-line` after every task**, then go on. Do not stop between tasks to ask.
7. After Task 15: one whole-branch review on the most capable model against the spec's anti-goals + every `minor (deferred)` line here; one fix wave; then stop and report. **Never merge or push to `main`, never run db-migrate, never set Vercel env vars** — those are คุณนุ๊ก's.

---

# SDD ledger — plan: docs/superpowers/plans/2026-11-14-peak-order-from-line.md

Spec: docs/superpowers/specs/2026-11-14-peak-order-from-line-design.md (approved by คุณนุ๊ก 2026-11-14)
Branch: feat/peak-order-line (in-place checkout, not a linked worktree) · plan commit 052038b · baseline 950 tests green
Execution mode: subagent-driven (user chose "แบบ 1"). Controller model: fable. Implementers: sonnet (mechanical) / opus (T3, T10, T12, T13). Reviewers: sonnet / opus (T3, T10, T13). Final review: fable.

## Rulings before execution

- Ruling: work in place on feat/peak-order-line instead of a linked worktree — branch already isolates main (no deploy), node_modules + env are here, user was told commits go to this branch — cost if wrong: another session using this checkout would find it on the feature branch; recover with `git switch main`.
- Ruling: pure modules (peak-order/command.ts, postback.ts, mapper.ts, flex.ts, order-constants.ts) omit `import 'server-only'`; modules touching DB/network/secrets keep it — the plan's Global Constraint says "server modules", and webhook-router/line.ts/client form import the pure ones — cost if wrong: none (tests alias server-only anyway).
- Ruling: Task 6 connect/callback must also catch `PeakConfigError` (missing/invalid PEAK_TOKEN_ENC_KEY) → redirect `/peak?error=config`; page shows a "ยังไม่ได้ตั้งค่า PEAK_TOKEN_ENC_KEY" banner — plan lists only Auth/Unavailable errors; spec §6.7 requires safe-off when env missing — cost if wrong: an unhandled 500 on the admin connect page.
- Ruling: Task 11 `FLEX_LABEL_MAX = 40` — verified by controller from LINE Messaging API reference ("Specifications of the label": Flex Message → Button → 40; postback `data` max 300; datetimepicker mode `date` format `YYYY-MM-DD`, value arrives in `postback.params.date`). The full label `📝 บันทึกเป็นใบร่างในแดชบอร์ด` fits; no shortening needed. Tests assert both `label.length` and code-point length ≤ 40.
- Ruling (plan-mandated, rubric-sensitive): Task 10 tests pin SQL *text* (gate predicates, ON CONFLICT clause) through a mocked `sql` — a reviewer may call this "asserting on mocks". Accepted: no DB is available in tests and new deps are forbidden; behaviour is covered by the in-memory fake in Tasks 12–13 (with two mutation checks) plus the manual double-tap smoke in Task 15. If flagged, park as plan-mandated with this ruling.
- Ruling: Task 13 recovery — an `ok`/`dup` tap while `step === 'creating'` is evaluated by the Recovery paragraph BEFORE the generic "action must belong to d.step" rejection (the two plan sentences overlap; Recovery is the specific rule).

## Pre-flight scan

| Tasks | Produces → Consumes | Finding |
|---|---|---|
| T1 → T8/T12/T13/T14 | `createOrderFromForm(body, actor)`, `CreateOrderBody` (index signature), `ORDERERS`, `QTY_UNITS` | consistent; T8 `buildOrderBody` adds `peak`, `status`, `force` keys allowed by the index signature |
| T2 → T3/T6 | `PeakTokenSet`, `refreshPeakTokens`, `registerPeakClient`, `newPkce`, `buildAuthorizeUrl`, `exchangeCode`, error classes | consistent |
| T3 → T4/T6/T7 | `getPeakAccessToken(opts?)` matches T4 `getToken?: (o?) => Promise<string>`; status/record fns | consistent; T6 missing PeakConfigError path → ruling above |
| T3 + T10 | both append DDL to `app/api/admin/db-migrate/route.ts` | sequential appends before the row-count block; no conflict |
| T4 → T5/T12 | `PeakClient.call`, `PeakToolError` | consistent |
| T5 → T6/T7/T8 | `newestQuotations(q, n)`, `listQuotations({…, page})`, `getQuotation`, `getContactName` | consistent (`page` required everywhere it is called) |
| T6 + T14 | both touch `app/peak/page.tsx`, `peak-client.tsx`, `tests/peak-admin-routes.test.ts` | T14 extends T6's files; sequential |
| T8 → T9 | `isOrderCommand` imported by webhook-router | consistent; command.ts must stay pure (ruling above) |
| T8 → T12/T13 | `resolveOrderCommand` deps, `planUnits`, `buildOrderBody`, `bangkokISODate`, `addDaysISO`, `firstLine`, `formatQty` | consistent after plan self-review patch |
| T9 → T11/T13/T14 | `encodePostback`/`decodePostback`/`OrderPostback`, `PeakOrderArm`, `InboundMessage.postbackParams` | consistent; `date` value `'+1'` = "พรุ่งนี้" |
| T10 → T11/T12/T13 | `DraftRow`, `DraftUnit`, `LiveLink`, `PeakOrderDb` | consistent; `createDraft` omits `creatingKind` (defaults null) |
| T11 → T12/T13/T14 | `Card`, card builders, `TEXT.*`, `DASHBOARD_BASE` | consistent; skip-of-last-unit replies `statusCard` |
| T12 + T13 | same file `lib/peak-order/handler.ts`, shared `tests/helpers/peak-order-fakes.ts` | sequential; T13 adds `handlePeakOrderPostback` |

| Task | Self-consistency (tests vs code, files) |
|---|---|
| T1 | characterization cases match current route behaviour read by controller (snapshot = {...body,pin,orderType}; draft key undefined on success; dedupe failure non-fatal) — ok |
| T2 | ok |
| T3 | algorithm steps ↔ tests agree; ok |
| T4 | ok (second 401 → PeakAuthError) |
| T5 | fixtures shapes verified by probe 2026-11-14 (not-found = empty array, limit 50 works, SSE responses) — ok |
| T6 | missing PeakConfigError path → ruling |
| T7 | ok |
| T8 | `planUnits('single')` with ≠1 line unspecified → implementer may throw; ok |
| T9 | route expectations for non-allowed contexts equal today's routes — ok |
| T10 | SQL-text pins → ruling (plan-mandated) |
| T11 | label limit → ruling (40) |
| T12 | ok |
| T13 | recovery vs generic step check overlap → ruling |
| T14 | ok |
| T15 | docs only; ok |

## Progress
- Task 1: implementer (sonnet, agent a9fe3b16c9b2cf340) DONE — commit b6403a4 (base 052038b); 971 tests green; review dispatched (sonnet, agent a78d4d748886c305f), package review-052038b..b6403a4.diff
- Task 1: review ✅ spec compliant, Approved. ⚠️ "type-check not verifiable from diff" resolved by controller: pre-commit hook (type-check + lint + full suite) passed on commit b6403a4.
- Task 1: minor (deferred): tests/orders-create.test.ts:3 redundant `vi.mock('server-only')` (config already aliases it)
- Task 1: minor (deferred): lib/orders-create.ts no-op casts `502 as 500 | 502` / `500 as 500 | 502`
- Task 1: minor (deferred): tests/orders-create.test.ts duplicate-hit fixture not a full DuplicateOrderHit; `message` assertion weak (contains '1') — assert full Thai message
- Task 1: complete (commits 052038b..b6403a4, review clean)
- Task 2: BASE b6403a4 — dispatching implementer (sonnet)
- Task 2: implementer (sonnet, agent afd5f00acae9a48f1) DONE — commit bd7d419 (base b6403a4); 985 tests green
- Task 2: review (sonnet) ✅ spec compliant, Approved. ⚠️ commit trailer/hook: verified by controller (trailer present; hook passed on commit).
- Task 2: minor (deferred): tests do not assert `signal` is passed to fetch; registration 4xx → PeakAuthError path untested; error classes do not set `name`
- Task 2: Ruling (carry into Task 3 dispatch): `expiresInSec <= 0` (missing/invalid `expires_in`) must not make the store refresh on every call — token-store treats a non-positive value as 3600 s (Peak's observed lifetime) — cost if wrong: one 401, which the MCP client already answers with a forced refresh.
- Task 2: Ruling (carry into Task 3 dispatch, small amendment to lib/peak/oauth.ts + test): HTTP 429 and 408 from Peak's token/register endpoints map to `PeakUnavailableError`, not `PeakAuthError` — a rate-limited refresh must not look like "reconnect needed" or raise the daily alert — cost if wrong: a genuinely revoked client answering 429 forever would surface as "Peak ไม่ตอบ" instead of "เชื่อมต่อใหม่".
- Task 2: complete (commits b6403a4..bd7d419, review clean)
- SESSION PAUSE 2026-11-14 (user left; asked for /session-end and offered "continue next session or cloud"). Next: Task 3 (BASE = HEAD of feat/peak-order-line after the session-end docs commit). Task briefs live in the git-ignored workspace on the Mac; in any other environment take each task's text straight from the plan file section `### Task N`.
- 2026-11-14: branch pushed to origin; draft PR https://github.com/witsarutnook/penprinting-dashboard/pull/29 (WIP checklist in the PR body — tick tasks there as they complete). Session-end docs commit b05a562.
- ☁️ CLOUD SESSION RESUME 2026-11-14 (session_019aTaZetvcRcc5sXCVPS88a): branch at 4a2c921, 985 tests green before any change. Subagents are available here — same loop as on the Mac (one implementer + one independent reviewer per task; briefs cut straight from the plan's `### Task N` sections; rule/brief/report/diff files live in the session scratchpad, not in the repo). The implementer's commit is pushed as soon as it lands (before review) so no work can be lost; review fixes are new commits. Commit messages on this branch end with `Claude-Session: <url>` then `Co-Authored-By: Claude Fable 5.2 <noreply@anthropic.com>`.
- Task 3: BASE 4a2c921 — implementer (opus) DONE — commit 8477af3; 1019 tests green (controller re-ran the full suite). Rulings R1 (non-positive/non-finite expiresInSec → 3600 s) and R2 (429/408 → PeakUnavailableError, tested on refresh + register) applied.
- Task 3: review (opus) — code ✅ spec compliant, quality Approved. Sole finding above Minor is commit metadata: 8477af3 ends with `Co-Authored-By: Claude Opus 5.5` (the implementer subagent followed its own attribution default) instead of the required Fable 5.2 trailer.
- Ruling: the trailer on 8477af3 is NOT rewritten — the commit was already pushed when the deviation was seen, and rewriting pushed history for a metadata line needs a force-push that คุณนุ๊ก did not authorise — cost if wrong: one commit on the branch carries an Opus trailer (a squash-merge drops it; otherwise คุณนุ๊ก can ask for a message-only rewrite). From Task 4 on the controller checks the trailer BEFORE pushing and amends the message locally if needed.
- Task 3: accepted deviations (reviewer agreed): lock-lost poll only accepts a token that is fresh AND different from the one first read (so a forceRefresh after a 401 never hands back the rejected token); `savePeakClient` drops stored tokens when the client_id changes; `savePeakTokens` throws when no `peak_oauth` row exists.
- Task 3: ⚠️ "cannot verify" resolved by controller: full suite re-run = 1019 green; SQL statements read by controller (valid Postgres). Real-database behaviour (lease UPDATE, CASE upsert, ISO string → TIMESTAMPTZ, DDL) is untestable here — parked for the manual smoke (first `/peak` connect + `/api/admin/db-migrate` applied list).
- Task 3: minor (deferred): lib/peak/token-store.ts lease UPDATE does not re-check freshness on the non-force path — an instance that read an expiring row just before another finished may refresh once more (harmless, rotation stays consistent); optional `AND access_expires_at < NOW() + INTERVAL '5 minutes'`
- Task 3: minor (deferred): lib/peak/token-store.ts persist-failure branch leaves the 30 s lease in place — concurrent callers get PeakUnavailableError until it lapses
- Task 3: minor (deferred): tests/peak-token-store.test.ts does not assert the `CASE WHEN peak_oauth.client_id = EXCLUDED.client_id` text of savePeakClient
- Task 3: minor (deferred): when the lock winner fails with PeakAuthError the waiting callers surface PeakUnavailableError ("retry later"), not the auth error — callers must not read it as "connection healthy"
- Task 3: complete (commits 4a2c921..8477af3, review clean — trailer deviation parked by the ruling above)
- Task 4: BASE 3ea87c8 — implementer (sonnet) DONE — commit 342108b; 1030 tests green; trailer verified by controller before push.
- Task 4: review (sonnet) ✅ spec compliant, Approved; no Critical/Important.
- Ruling: Task 4 maps HTTP 403 from the MCP endpoint to `PeakAuthError` (outside the task text; reviewer asked the controller to confirm) — accepted: a 403 with a valid bearer means the grant/scope is not accepted, which a retry cannot fix, so "reconnect at /peak" is the right message — cost if wrong: a transient 403 would tell staff to reconnect when a retry would have worked.
- Task 4: ⚠️ "cannot verify": real-wire behaviour against mcp.peakaccount.com (SSE framing, session header, 404 body) — untestable here by rule (never call Peak); parked for the manual smoke (the "ทดสอบ" button on /peak is the first real call).
- Task 4: minor (deferred): tests/peak-mcp-client.test.ts "404 three times" asserts `inits() <= 3` — tighten to `toBe(3)` + 3 tools/call requests
- Task 4: minor (deferred): no test for a 401 during `initialize`, nor for a body read that fails after the headers arrived (both paths exist in code)
- Task 4: minor (deferred): `isError` / JSON-RPC error messages carry only the tool name + code (safe, but thin for debugging)
- Task 4: minor (deferred): the 10 s timeout is per HTTP request, not per `call()` — a 404 re-init sequence can take up to ~3 × 3 requests × 10 s worst case; callers inside the 60 s `after()` budget should know
- Task 4: complete (commits 3ea87c8..342108b, review clean)
