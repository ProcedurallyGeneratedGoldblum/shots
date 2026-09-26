# Security Policy

Shots is a small personal project, but security reports are welcome and taken seriously.

## Reporting a vulnerability

**Please don't open a public issue for security problems.**

Use GitHub's private reporting instead: go to the **Security** tab of this repository and
click **Report a vulnerability**. Only the maintainer can see the report.

Include what you found, how to reproduce it, and what an attacker could do with it.
You can expect an acknowledgement within a week.

## Supported versions

Only the latest commit on `main` is supported. That's what is deployed.

## Scope

In scope:
- The gallery page (`public/`) and its security headers
- The Pages Functions (`functions/api/`), especially the Cloudflare Access token check in `_middleware.js`
- Anything that would let someone list, read the index of, or delete files without being authorized

Out of scope:
- **Individual image URLs being publicly viewable.** That's intentional: it's how share links work.
  File names are random so they can't be guessed.
- Rate limits or availability of Cloudflare's `r2.dev` development URL
- Issues in Cloudflare, ShareX or GitHub themselves (report those to the vendor)

## Security design, in short

- **No credentials in the code or the repo.** The Functions reach the bucket through an R2 binding.
  The ShareX upload token lives only on the uploading PC and is scoped to one bucket.
- **Two layers of auth.** Cloudflare Access gates the site, and the API independently verifies the
  Access JWT (RS256 signature, `aud`, `iss`, `exp`, `nbf`) against Access's published keys.
  It fails closed if not configured.
- **CSRF protection.** State-changing requests must come from the site's own origin and be `application/json`.
- **Strict Content-Security-Policy** with no inline scripts or styles, plus `frame-ancestors 'none'`,
  `nosniff` and `no-referrer`.
- **No runtime dependencies.** No npm packages are shipped, so there's no supply chain to compromise.
  GitHub Actions are pinned to commit SHAs and kept current by Dependabot, and CodeQL scans every push.
