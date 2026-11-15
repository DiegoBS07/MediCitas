# Declaration of AI use

## 1. Tool

| Item | Value |
|---|---|
| Tool | Claude Code (Anthropic), agentic coding assistant running in the team's terminal with access to the repository and the local Docker stack |
| Model | Claude Opus (Anthropic) |
| Period | The whole project (November 2026) |
| Access granted | Read/write in the working copy; run commands (npm, Docker Compose, psql inside the containers); **NO** Git commits, pushes or pull requests (explicit team rule: the team versions and pushes every change themselves.). **NO** design decisions. **NO** code generation without explicit approval.|

## 2. How the work was organized

1. **The team wrote the master prompt:** The master prompt included: architecture planes, required technologies, phased work with approval gates, rules (ESM, English artifacts, never ask for or write secrets, never print tokens, manual actions requested and confirmed).
2. **Approval gates:** The work was split into phases. At the end of each phase the assistant delivered a report (files, risks, commands, results) and stopped until a team member explicitly authorized the next one.
3. **Commits:** Every commit in the history was made by a team member after reviewing the work. The assistant only proposed lists of commits.
4. **Manual actions:** (starting Docker Desktop, approvals, commits) were requested from the team and confirmed before continuing.

## 3. What the assistant produced

* Source code of the shared plane (kernel, observability, identity, messaging, cache, runtime) and of the eight services; database bootstrap, migrations and seeds; the Keycloak realm generator.
* Tests: unit, and integration against the running containers.
* Documentation: the README, the data model and dictionary, seed data, index justification, multi-tenancy comparison, cache report, the DBML sources of the ER diagrams, the demo script, and part of this declaration's factual sections.
* Evidence tools and the measurements they produced.

## 4. What the team produced or decided

* The master prompt and its rules (It contains the whole context, design, infrostructures, modules, services, and the development process); the system architecture diagram (`docs/architecture/System Architecture MediCitas.excalidraw` / `.png`); the initial repository structure and the first placeholder Dockerfiles.
* Approval of every phase, every Design Processing decision, and of the deviations reported by the assistant.
* Dockerfiles with images corresponding each of the services, the gateway and the database; the `docker-compose.yml` file to run the whole project.
* All Git history (commit granularity and messages).
* Refactoring of the overall docuementation, the README, the data model and dictionary, the seed data, the index justification, the multi-tenancy comparison, the cache report, and the demo script.
* Verification of compliance with functional requirements, non-functional requirements, and the acceptance criteria of the project.


