from __future__ import annotations

import os

# Vote threshold: when a book title gets this many upvotes, auto-create & learn
VOTE_THRESHOLD = int(os.getenv("VOTE_THRESHOLD", "3"))

# Scheduled discovery interval in seconds (default 6 hours, 0 to disable)
DISCOVERY_INTERVAL = int(os.getenv("DISCOVERY_INTERVAL", str(6 * 3600)))

# Max books to discover per scheduled run
DISCOVERY_BATCH_SIZE = int(os.getenv("DISCOVERY_BATCH_SIZE", "5"))

# ─── Topic tags for interest-driven discovery ───
TOPIC_TAGS = [
    "Psychology", "Philosophy", "Economics", "Physics",
    "Computer Science", "Biology", "History", "Mathematics",
    "Business & Strategy", "Neuroscience", "Literature",
    "Political Science", "Sociology", "Art & Design", "Self-Development",
    # 2026-06-12 expansion — the ONLY two candidates that passed the data gate
    # (>=8 minds match via is_mind_topic_relevant against real domain strings;
    # 37 other candidates audited and rejected: most match <5 minds because
    # mind.domain uses this same coarse vocabulary, and high scorers like
    # "Political Philosophy" are stem-overlap duplicates of existing hubs).
    # AI also tracks verified GSC demand (lecun/hinton/hassabis queries) and
    # grows with every tech-minds batch.
    "Artificial Intelligence", "Ethics",
    # 2026-06-15 — Investing hub (Steve-requested). In-library greats
    # Buffett/Munger/Graham/Dalio (domain contains "investing"), plus the built
    # Duan Yongping / Li Lu for the Chinese value-investing side.
    "Investing",
]

# Number of books to discover per topic
TOPIC_DISCOVER_COUNT = int(os.getenv("TOPIC_DISCOVER_COUNT", "5"))
