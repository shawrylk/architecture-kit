---
name: architecture-security
description: The security model of this architecture — tenant isolation, presigned URLs, secrets, audit log, and what never gets logged. Use when touching repositories, storage access, authentication, secrets, or anything that crosses a tenant boundary.
---

# Security

- **Tenant isolation is the security model**: scoped repository predicate, row-level-security
  backstop, and a two-tenant test asserting zero cross-reads. A new repository without that test
  fails review.
- The predicate is also checked structurally, across every feature at once — a statement on a
  business table that names no tenant fails the build, including the one nobody wrote a test for.
  An exemption is a marked comment carrying its reason, and it is printed on every run.
- Presigned URLs are bearer credentials: never logged, never persisted, tenant-prefixed keys, and a
  lifetime from the closed set.
- Secrets come from the secret store into the task definition's secrets block. Never in the
  environment block, never in the image.
- Metadata stripped from uploads is reduced to a documented allow list; location is coarsened and
  hidden from users who should not have it.
- AI prompts and raw responses are never stored and never logged.
- The audit log is append-only: no update or delete path exists in any repository.
- The browser holds a session cookie and never an access token — ADR-0037. The API is bearer-only.
- A public route declares itself a trust boundary, gets no principal, and has no write path. The
  edge forwards it with no `Authorization` header at all.
