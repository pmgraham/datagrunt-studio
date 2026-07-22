# Local container runs. `make up` works anywhere: it drives Apple Container
# (https://github.com/apple/container) when the `container` CLI is present,
# otherwise Docker via docker compose.

BACKEND_IMAGE  := datagrunt-studio-backend
FRONTEND_IMAGE := datagrunt-studio-frontend
BACKEND_NAME   := datagrunt-backend
FRONTEND_NAME  := datagrunt-frontend
DATA_DIR       := $(CURDIR)/.container-data
# Secrets are staged OUTSIDE $(DATA_DIR): the Apple path mounts DATA_DIR
# read-write at /data, and the staged credential must not be reachable
# through that mount. See scripts/stage_adc.sh.
SECRETS_DIR    := $(CURDIR)/.container-secrets/mount

# Optional runtime config; see .env.example.
-include .env

RUNTIME := $(shell if command -v container >/dev/null 2>&1; then echo apple; \
  elif command -v docker >/dev/null 2>&1; then echo docker; fi)

.PHONY: build up down logs status check-cli stage-adc

check-cli:
	@test -n "$(RUNTIME)" || { \
	  echo "error: no container runtime found - install Apple Container (https://github.com/apple/container) or Docker (https://docs.docker.com/get-started/get-docker/)"; exit 1; }

# GOOGLE_ADC_FILE comes from .env via -include; make variables are not
# exported to recipes automatically, so pass it explicitly.
stage-adc: check-cli
	@GOOGLE_ADC_FILE="$(GOOGLE_ADC_FILE)" ./scripts/stage_adc.sh

ifeq ($(RUNTIME),docker)

build: check-cli
	docker compose build

up: stage-adc
	docker compose up --detach --build
	@echo "Datagrunt Studio: http://localhost:3000"

down: check-cli
	docker compose down

logs: check-cli
	docker compose logs --follow

status: check-cli
	docker compose ps

else

build: check-cli
	container build -t $(BACKEND_IMAGE) backend
	container build -t $(FRONTEND_IMAGE) .

# Apple Container 1.1.0's --mount only accepts a directory as source (a
# file path errors with "is not a directory"), so we mount the staged
# secrets dir and point GOOGLE_APPLICATION_CREDENTIALS at adc.json inside.
up: stage-adc
	@mkdir -p $(DATA_DIR)
	container run --detach --name $(BACKEND_NAME) \
	  --volume $(DATA_DIR):/data \
	  $(if $(GEMINI_API_KEY),--env GEMINI_API_KEY=$(GEMINI_API_KEY)) \
	  --mount type=bind,source=$(SECRETS_DIR),target=/secrets,readonly \
	  --env GOOGLE_APPLICATION_CREDENTIALS=/secrets/adc.json \
	  $(BACKEND_IMAGE)
	@backend_ip=$$(container inspect $(BACKEND_NAME) | jq -r '.[0].status.networks[0].ipv4Address' | cut -d/ -f1); \
	echo "backend at $$backend_ip:8000 - waiting for health..."; \
	for i in $$(seq 1 30); do \
	  curl -sf "http://$$backend_ip:8000/health" >/dev/null && break; \
	  [ $$i -eq 30 ] && { echo "error: backend never became healthy; run 'make down' to clean up"; exit 1; }; \
	  sleep 1; \
	done; \
	container run --detach --name $(FRONTEND_NAME) \
	  --publish 3000:3000 \
	  --env BACKEND_URL=http://$$backend_ip:8000 \
	  $(FRONTEND_IMAGE)
	@echo "Datagrunt Studio: http://localhost:3000"

down: check-cli
	-container stop $(FRONTEND_NAME) && container delete $(FRONTEND_NAME)
	-container stop $(BACKEND_NAME) && container delete $(BACKEND_NAME)

logs: check-cli
	container logs $(BACKEND_NAME)
	container logs $(FRONTEND_NAME)

status: check-cli
	container list --all

endif
