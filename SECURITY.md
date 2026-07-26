# Security Policy

## Supported versions

Datagrunt Studio is pre-1.0; only the latest release (and `main`) receives security fixes.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Report privately via GitHub's private vulnerability reporting: go to the repository's **Security** tab → **Report a vulnerability**. You'll get an acknowledgment quickly, and a fix will be developed and released before any public disclosure.

## Scope notes

Datagrunt Studio's backend is a **single-user local sidecar** by design: it binds to loopback, has no authentication, and assumes a trusted local machine. Reports that amount to "the backend has no auth" are working as intended; reports about the backend being reachable from *outside* loopback, path traversal, server filesystem paths leaking into API responses, or injection via crafted data files are very much in scope and appreciated.

### Data is carried through losslessly, not sanitized

Studio moves your data without rewriting it. Cell values are stored and exported exactly as they arrived, and neither Studio nor the datagrunt library inspects or alters their *content* to defend the applications you open the results in.

The practical consequence worth knowing: spreadsheet applications evaluate a CSV cell beginning with `=`, `+`, `-`, or `@` as a formula rather than text. A value like `=HYPERLINK(...)` or `=WEBSERVICE(...)` present in a source file will still be there in an exported CSV, and will be evaluated by whoever opens it. **Treat an exported file with the same caution as the data that went into it**, particularly before forwarding one to someone else.

This is deliberate. A parsing layer that silently rewrites values destroys the caller's ability to trust that what it received is what was there, and it makes escaping decisions at the point in the stack with the least context about where the data is headed. Escaping belongs at the boundary where output is rendered for a specific consumer, which is a decision only you can make.

So: reports that Studio does not neutralize formula-leading values on export are working as intended. Reports about **Studio's own attack surface** — its endpoints, its trust boundaries, its file handling, its process privileges — remain firmly in scope.
