# Changelog

All notable changes to Datagrunt Studio are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Release tags use bare semver (`0.1.0`, no `v` prefix).

## [Unreleased]

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
