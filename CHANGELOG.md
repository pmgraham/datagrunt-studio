# Changelog

All notable changes to Datagrunt Studio are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Release tags use bare semver (`0.1.0`, no `v` prefix).

## [Unreleased]

- **Changed:** the default session data directory moved from `/tmp/datagrunt-studio`
  to `$XDG_DATA_HOME/datagrunt-studio` (falling back to `~/.local/share/datagrunt-studio`)
  and is now created mode `0700`. `/tmp` was readable by every local account.
  Set `STUDIO_DATA_DIR` to override. Existing `/tmp` sessions are not migrated.
- **Fixed:** the AI PDF extraction preview cache (uploaded PDFs, extracted page
  images, and rationalized schemas) moved from the shared `/tmp/aipx_preview`
  into the private per-user session data directory. The old location was both
  world-readable and, after the DuckDB sandbox change above, outside the
  connection's allowed directories — which broke PDF extraction and
  rationalization outright. Existing `/tmp` preview files are not migrated.

## [0.1.0] - 2026-07-22

Initial public release.

### Added
- Explore, clean, join, and export CSV and Excel data in the browser — no SQL
  required, powered by DuckDB and the [datagrunt](https://github.com/pmgraham/datagrunt)
  library
- AI-assisted PDF extraction to structured tables (Gemini/Vertex or local Ollama)
- Import from upload or Google Cloud Storage (ADC), with staged previews and
  per-file read options (skip rows, header, sheet selection)
- Local-first FastAPI + DuckDB backend sidecar; Next.js frontend
- Container workflow (`make up`) via Apple Container or Docker Compose
- CI (pytest + ruff, eslint + vitest + build, advisory dependency audits),
  committed lock files for reproducible builds, and full repository security
  configuration
