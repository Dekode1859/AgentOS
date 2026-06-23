# Job Search OS (scaffold)

A future AgentOS application. **This is an empty scaffold only** — no agents,
tools, schemas, or logic are implemented yet (per the agreed scope of this
extraction pass).

It exists to prove the AgentOS Core boundary: a second app will consume the
*same* unmodified Core via the same `AppConfig` contract that Learning OS uses.

## Planned shape (not built)

```
jobsearch-os/
├── main.py            # constructs AppConfig + agentos.run()  (TODO)
├── opencode.json      # profile-agent, matching-agent, ...     (TODO)
├── agents/            # domain agent prompts                    (TODO)
├── tools/             # domain tools: parse_resume, ...         (TODO)
├── schemas/           # profile / job / application JSON        (TODO)
├── prompts/           # job-specific prompts                    (TODO)
├── ui/                # any app-specific view overrides         (TODO)
└── workspace/         # jobs/ profiles/ applications/           (TODO)
```

## Roadmap (from the spec, future work)

- **V0** — Profile workspace: upload résumé, extract to the profile schema,
  edit + persist.
- **V1** — Manual job import: paste a job description, normalize to the job
  schema, store locally.
- **V2** — Matching: score a profile against a job, surface strengths / gaps /
  résumé suggestions.

When built, `main.py` will mirror `apps/learning-os/main.py`: add `core/` to the
path, declare an `AppConfig` (different folders, agents, branding), and call
`agentos.run()`. **Core will not change.**
