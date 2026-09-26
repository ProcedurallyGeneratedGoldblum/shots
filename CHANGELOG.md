# Changelog

All notable changes to Shots are listed here, newest first.
The format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [0.3.0] - 2026-09-27

### Added
- **Image annotation.** Open any uploaded image in the gallery and click **Annotate** to draw on it:
  arrows, boxes, freehand pen, text, highlight and pixelate, in six colours and three line widths.
- **Save as copy** stores the annotated image next to the original under a new random name and copies its link.
- **Replace original** overwrites the image in place, so links you've already shared show the annotated version.
- Undo/redo (Ctrl+Z / Ctrl+Y), single-key tool shortcuts (A, B, P, T, H, X) and Esc to cancel.
  Exports at the image's full resolution and works with touch.
- `GET /api/raw` and `POST /api/upload` endpoints behind the existing Cloudflare Access check.
- 15 new security tests for the endpoints (42 in total).

### Security
- Uploads must be real PNG, JPEG or WebP images (checked by their first bytes), at most 25 MB,
  from the site's own origin, and can only be saved next to or over an image that already exists.
  Replacing keeps the original's file type.
- Files read back through the API are served as sandboxed downloads, so they can never run as a page.

## [0.2.0] - 2026-09-26

### Added
- Security test suite: 27 tests for the login check, CSRF protection and API handlers.
- GitHub Actions: tests and CodeQL scanning on every push, CodeQL weekly. Actions pinned to commit SHAs and kept current by Dependabot.
- `SECURITY.md` with private vulnerability reporting, plus `CODEOWNERS` and `.gitignore`.

### Changed
- `PUBLIC_BASE`, `ACCESS_TEAM_DOMAIN` and `ACCESS_AUD` moved out of `wrangler.toml` into encrypted Cloudflare Pages secrets.
- The gallery's scripts and styles moved into separate files so the Content-Security-Policy can forbid inline code.

### Security
- Stricter Access token check: requires RS256, a valid `exp`, honours `nbf`, and refreshes Cloudflare's signing keys when they rotate.
- State-changing requests must come from the site's own origin (CSRF protection).
- The local-development auth bypass only works on localhost.
- Security headers on every page: Content-Security-Policy, `frame-ancestors 'none'`, `nosniff`, `no-referrer`, HSTS.

## [0.1.0] - 2026-09-26

### Added
- First release: a self-hosted Gyazo replacement. ShareX uploads screenshots to a Cloudflare R2 bucket.
- The Shots gallery on Cloudflare Pages: every upload newest first, grouped by month, with a name filter,
  a full-size viewer, copy link, open and delete. Videos play inline, with light and dark mode.
- Cloudflare Access login in front of the gallery, with the API verifying the Access token itself.
