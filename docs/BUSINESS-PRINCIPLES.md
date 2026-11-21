# Business Principles

## Database usage and operational transparency

- Public book and topic pages must retrieve only the matching recommendation rows and display columns. Apply eligibility, ranking and limits in SQL rather than fetching the entire catalog and filtering in Python.
- Preserve topic-first, author-second recommendations, public book eligibility and newest-first ordering. Topic recommendations may include older matching books beyond the former 2,000-book scan cap.
- Database row counters measure rows returned or affected. They are a diagnostic proxy and must never be presented as measured network bytes or proof of a billing overage. Confirm actual transfer against Supabase Usage, including Shared Pooler Egress.
- Operational alerts must use the configured capacity, identify their UTC observation interval and rank queries by growth in that interval. Separate cumulative counters from interval changes.
- Counter resets, statement eviction and measurement migrations must be visible. A new measurement cohort starts with a baseline; it must not imply that historical activity disappeared.
- Diagnostic requests must not advance the monitoring baseline or send email.
