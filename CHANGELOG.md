# Changelog

All notable changes to Datagrunt Studio are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
Release tags use bare semver (`0.1.0`, no `v` prefix).

## [Unreleased]

- **Added:** `STUDIO_GCS_ALLOWED_PROJECTS` (comma-separated) pins GCS export
  destinations to a set of projects you choose. The export request names the
  project it is writing to, so without this the set of legal destinations was
  steerable by the request; configuring it makes that set yours alone. Unset
  means no project restriction, so nothing changes unless you set it.
  `STUDIO_GCS_ALLOWED_BUCKETS` still takes precedence for a specific bucket —
  it exists for one granted outside your own projects.

## [0.2.0] - 2026-07-26

A security release. Studio's backend is a single-user local sidecar with no
authentication by design, which is safe only while it is genuinely reachable from
loopback alone and while the code around it holds up its end. Several shipped
launch paths broke the first assumption and the proxy layer never enforced the
second. Everything below closes that gap.

Two changes are behavioural and worth reading before upgrading: session SQL can
no longer touch files outside the session data directory, and that directory has
moved out of `/tmp`.

### Security

- **Changed:** every launch path now binds to loopback instead of all interfaces —
  `docker-compose.yml`, the Apple Container path in `make up`, and the `dev` and
  `start` npm scripts. The frontend proxies unauthenticated to the backend, so
  publishing on `0.0.0.0` handed the whole API to anyone on the network.
  Container-internal binds are deliberately unchanged; a process bound to loopback
  inside a container namespace is unreachable from the host publish.
- **Added:** cross-site state-changing requests are now rejected at both API
  layers — Next.js middleware over `/api/*`, and FastAPI middleware on the backend,
  which is reachable without the proxy. Next.js route handlers get no CSRF
  protection by default, so any page you visited could previously drive the local
  API. Requests carrying neither `Sec-Fetch-Site` nor `Origin` are still allowed:
  those are the proxy's own server-side calls and non-browser clients, and a
  browser cannot be made to suppress both on a real cross-origin request.
- **Changed (breaking for direct API callers):** `POST /gcs/export` now requires a
  `project` field, and refuses any destination bucket that is not listable in that
  project. Set `STUDIO_GCS_ALLOWED_BUCKETS` (comma-separated) to permit a bucket
  granted outside your own projects. The export dialog sends the project it already
  asks for, so the UI is unaffected. Export signs uploads with your ambient Google
  credentials, so an unconstrained destination let a forged request write your data
  to a bucket an attacker owned.
- **Changed:** the session DuckDB connection is now confined to the session data
  directory. External file access is disabled and the allow-list is locked, so
  session SQL can no longer reach paths outside it — a query that reads or writes
  an arbitrary location (`read_csv`, `COPY … TO`) now fails. Studio's own ingest
  and export paths are unaffected; they already live under the data directory.
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
- **Fixed:** the backend refused to start under `make up` on macOS. The
  container bind-mounts `.container-data` (created on the host, owned by the
  host user) into the backend container, which runs as a dedicated `studio`
  user — so the data directory's owner never matches the running process,
  and the ownership check added above hard-failed. That check now only
  hard-fails for the *default* per-user data directory, which it exists to
  protect from a symlink hijack; when `STUDIO_DATA_DIR` is set explicitly,
  foreign ownership is expected (it is how bind mounts work) and is now
  logged as a warning instead, with permission-tightening attempted
  best-effort. The Docker Compose path was unaffected — it uses a named
  volume that Docker initializes owned by the container user.
- **Fixed:** the inline markdown renderer used for AI-extracted PDF text no longer
  degrades to quadratic time on hostile input. That text comes from whatever
  document you were sent, and a crafted run of bracket sequences could freeze the
  browser tab and take the unsaved SQL editor buffer with it. The patterns are now
  a linear scanner, and the tests assert scaling rather than a wall-clock threshold.

### Known limitation

`POST /gcs/export` derives its allowed destinations from the project named in the
request, so an attacker who has already arranged for your Google identity to hold
list access on a project they control could still satisfy the check. This requires
targeting you specifically and preparing cloud infrastructure, and both the
same-origin guard and the loopback binding above have to fail first. Tracked in
[#36](https://github.com/pmgraham/datagrunt-studio/issues/36).

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
