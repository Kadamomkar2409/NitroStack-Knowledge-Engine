# Rules for this project

- Source of truth: "PRD NitroStack Knowledge Engine.md". Work one milestone at a
  time and do not start the next until the user says so.
- NO mocks, fake data, fake embeddings or hardcoded answers. Use the real Atlas
  cluster, the real Voyage API and real docs.nitrostack content. If something
  real is missing, stop and ask.
- Secrets live in .env.local and .env.tenant-nitrostack in the project root.
  Application and test code may load them through dotenv at runtime. Never open,
  print, log, copy or commit these files or any value from them from tool calls.
  When checking configuration, report each variable only as "set" or "missing".
- Never commit .env files. Only .env.example (names, no values) is committed.
- Before using Atlas, Voyage, NitroStack or OpenRouter APIs, read their current
  official documentation. Do not rely on memory.
- Commit locally with clear messages. Never run git push; ask first.
- Never run npm audit fix --force or upgrade packages without asking.
- Free-tier limits: Atlas M0 allows 3 search/vector indexes (all 3 are in use,
  including sample_mflix). Voyage is limited to 3 requests/minute and 10K
  tokens/minute. Space Voyage requests at least 22 seconds apart and back off on 429.
- After each task report: what works, what was measured, what failed, what is next.