# Session Work Log

## 2026-11-21 — Database activity alert and catalog egress

### Request and checklist

Steve supplied the November 17 egress-watch email and asked whether there were problems to solve. Continue from diagnosis through implementation, checks, merge, deployment and production verification. Preserve the existing uncommitted changes in `web/app/symposiums/page.tsx` and `web/styles/liquid.css` in the original checkout.

- [x] Diagnose production counters and distinguish rows from actual transferred GB.
- [x] Fix the stale 500 MB capacity text and label the configured denominator consistently.
- [x] Attribute query activity to the check interval, scoped to the current database and top-level statements.
- [x] Handle first-run migration, statistics resets and individual counter eviction/restarts without reporting historical totals as a new spike.
- [x] Filter and limit topic/related-book results in SQL; preserve recommendation priority and eligibility.
- [x] Add regression tests and run the complete Python suite: 309 passed.
- [x] Validate both new query paths and statement snapshot collection against production in a read-only transaction.
- [ ] Open PR, pass CI and required deployment checks, and merge.
- [ ] Confirm the merged commit is serving in production; verify authenticated diagnostics without sending email.
- [ ] Initialize the new statement baseline and verify interval comparison after release.
- [ ] Check actual Supabase egress GB; access to the Usage dashboard is not yet confirmed.

### Evidence and measurement limits

- Production at 2026-11-21 11:40 UTC: 2,826,120,339 database bytes, about 32.9% of the configured 8 GiB denominator. The email's `/ 500 MB` text was stale.
- The November 21 08:00 UTC baseline to 11:40 UTC grew by 276,842 rows across the original monitor's statistics scope. This does not establish monthly egress usage or exclude earlier spikes.
- The email's top query list is cumulative, so it cannot attribute the November 17 interval by itself.
- A production read-only preflight compared the old 2,000-row catalog read with the new SQL paths for an actual Artificial Intelligence book: 1 related row and 2 topic rows returned. This is one sample, not a claim about total billed GB saved.
- New monitoring uses per-statement deltas for the current database and top-level statements. The previous aggregate-only state intentionally requires a new baseline. Rows include rows returned or affected; actual egress remains a separate measurement.
- Development uses an isolated Python-only worktree at `/private/tmp/feynman-egress-watch-20261121`. No Node dependencies were prepared or installed.

### Release status

Implementation and local verification are complete. CI, merge, deployment, production endpoint verification, the new baseline, and actual Usage verification remain pending.
