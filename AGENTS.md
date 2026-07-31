# AGENTS.md — Repository Guidance for AI Agents

## Git & Branch Management Rules
- **Never commit or adjust code directly on the `main` branch.**
- Always create a dedicated feature branch using standard naming (`<type>/<kebab-case>`, e.g., `feature/...`, `chore/...`, `fix/...`).
- Push feature branches to remote and submit changes via Pull Requests for review and CI verification.

## Execution Strategy Rule
- **Always default to Subagent-Driven Development (`superpowers:subagent-driven-development`)** when executing implementation plans. Automatically proceed with Subagent-Driven execution without pausing to prompt the user for execution options.

