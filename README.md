# Datagrunt Studio

[![CI](https://github.com/pmgraham/datagrunt-studio/actions/workflows/ci.yml/badge.svg)](https://github.com/pmgraham/datagrunt-studio/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

A web UI for exploring, cleaning, and joining CSV/Excel files, powered by the Datagrunt Python library and DuckDB.

## Run Locally

**Prerequisites:** Node.js 22+, [uv](https://docs.astral.sh/uv/) (manages Python 3.10+ for you)

1. Backend (Datagrunt + DuckDB sidecar):
   ```
   cd backend
   uv sync --extra dev
   uv run uvicorn app.main:app --reload
   ```
2. Frontend (in a second terminal):
   ```
   npm ci
   npm run dev
   ```
3. Open http://localhost:3000 (the UI proxies to the backend at `BACKEND_URL`, default `http://127.0.0.1:8000`).

## Run with Containers

Prod-like runs of the built app. For day-to-day development, use "Run
Locally" above.

`make up` works on any machine: it uses [Apple
Container](https://github.com/apple/container) when its `container` CLI is
installed (macOS), otherwise Docker Compose.

    make up      # build images as needed (slow the first time; cached after),
                 # stage credentials, start backend & frontend; UI at http://localhost:3000
    make logs    # print logs
    make down    # stop and remove
    make status  # list containers
    make build   # build the images without starting anything

Optional config: `cp .env.example .env` and fill in `GEMINI_API_KEY` (AI
PDF parsing). GCS import needs no configuration — if you have run `gcloud
auth application-default login`, `make up` automatically stages a
container-readable copy of your credentials in `.container-secrets/`
(gitignored; refreshed on every `make up`). Set `GOOGLE_ADC_FILE` in
`.env` only if your ADC file lives somewhere non-standard.

**Local Ollama** (the AI PDF Extractor's "Use local LLM" option): `make up`
points the backend container at the host's Ollama daemon automatically —
but from a container, `localhost` is the container itself, so the *host*
daemon must listen on a non-loopback interface for the container to reach
it: start it with `OLLAMA_HOST=0.0.0.0 ollama serve` (native runs need no
such step). Set `OLLAMA_HOST` in `.env` only if your daemon lives at a
non-default address.

**macOS / Apple Container one-time setup:** `container system start` (add
`--enable-kernel-install` if it reports no kernel is configured). Startup
after the first build takes only a few seconds — the images boot as
lightweight VMs. Backend data persists in `.container-data/` between runs.

**Docker hosts:** prefer `make up` over raw `docker compose up` so
credentials get staged — a raw `docker compose up` mounts an empty
`/secrets` and GCS import stays disabled until you run `make up` (or
`make stage-adc`). The same `docker-compose.yml` doubles as the deploy config for a
generic Docker host. Images are standard OCI: `backend/Dockerfile`
(FastAPI, port 8000) and `Dockerfile` (Next.js standalone, port 3000,
expects `BACKEND_URL`).

## Test
    npm test                          # frontend
    cd backend && uv run pytest -q    # backend

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow and test gates, and [SECURITY.md](SECURITY.md) for reporting vulnerabilities.
