# Security Policy

## Supported versions

Datagrunt Studio is pre-1.0; only the latest release (and `main`) receives security fixes.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via GitHub's private vulnerability reporting: go to the repository's **Security** tab → **Report a vulnerability**. You'll get an acknowledgment quickly, and a fix will be developed and released before any public disclosure.

## Scope notes

Datagrunt Studio's backend is a **single-user local sidecar** by design: it binds to loopback, has no authentication, and assumes a trusted local machine. Reports that amount to "the backend has no auth" are working as intended; reports about the backend being reachable from *outside* loopback, path traversal, server filesystem paths leaking into API responses, or injection via crafted data files are very much in scope and appreciated.
