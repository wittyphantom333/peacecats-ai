# VIVUS.md

Guidance for Vivus (AI coding agent) working in this repository.

## Project Overview

WARDOGS Artillery Calculator — a static, no-framework vanilla JavaScript web app for L81 Mortar / SPH-2 artillery calculations in the game WARDOGS. Deployed via GitHub Pages to wardogs-artillery.com with desktop (`/`) and mobile (`/mobile/`) interfaces sharing all core logic. Node.js (>=22) is used only for build/dev scripts; the runtime is classic ordered browser scripts, no bundler.

Three components live in this repo:

- Site root — the app itself (HTML, CSS, `js/`, `maps/`, `config/`, `locales/`, `data/`)
- `sync/` — Cloudflare Worker ("wardogs-economy-lobbies") for collaborative lobbies + anonymous feedback; own package.json and tests
- `assets-gateway/` — Cloudflare Worker gating R2 asset access via Turnstile preclearance; own package.json and tests

## Commands

```bash
npm run dev          # dev server at http://localhost:8000 (must serve over HTTP; fetch() everywhere)
npm run build        # build-pages.mjs → sync-locales.mjs → version-assets.mjs → dist/
npm test             # node --test scripts/lib/*.test.mjs (main test suite)
npm run check        # full gate: script tests + gateway tests + build + verify-build + sync tests
```

Run `npm ci` inside `sync/` once before the first full `npm run check`.

Local map tiles: `node generate-local-tiles.mjs` creates placeholders; dev server auto-repoints config at `maps/tiles/`. Real pre-S2 Bakurani/Ozeti pyramids are recoverable via `git archive 96ae6cda8^ -- maps/tiles | tar -x`. A local pyramid under `maps/tiles/<map-id>/revisions/<rev>/` is preferred when it matches the production tile path. Terrain chunks for all three maps are recoverable via `git archive 6989c96b1^ -- data/terrain/<map>/chunks | tar -x` (Bakurani's are pre-S2: pair with `manifest.local.json` from the same commit); dev server auto-repoints the terrain registry at local manifests. There is no CDN fetch path: the user does not own the Cloudflare account, so never build R2/CDN download tooling.

## Critical Rules

1. **Never edit `dist/`** — fully regenerated each build. Edit sources, then build.
2. **Never edit generated locale routes** — edit `src/pages/` templates and `locales/*.json` instead; `sync-locales.mjs` generates the rest.
3. **Script load order is a runtime contract.** `js/` files are ordered classic scripts sharing browser globals. Add/reorder via `scripts/lib/application-assets.mjs` (single manifest reused by bundler + tests), then update page templates.
4. **Map tiles and Terrain3D binaries are NOT in the repo or `dist/`** — served from Cloudflare R2 via `assets.wardogs-artillery.com`. Registry URLs point at versioned R2 manifests; finish tile/terrain uploads before deploying registry URLs referencing them.
5. **Security model: the repo is public.** Treat every URL, limit, and client check as attacker-known. Security comes from server-side validation (Workers), Turnstile, HMAC-signed invites, rate-limit bindings, build-time CSP — never from obscurity. Never put secrets (ROOM_SECRET, TURNSTILE_SECRET, R2 tokens) in site code or CI logs.
6. **Terrain3D safety contract** (`docs/terrain.md`): SAFE → apply certified command; extended estimates → label as estimate; pending → withhold MIL; indeterminate → withhold affected arc; worker unavailable → labelled firing-table fallback. Terrain-unavailable must never break the calculator.
7. **Localization invariants** (`docs/localization.md`): canonical URL, hreflang set, `og:locale`, and `lang` must match `locales/index.json`. Cat locale stays `noindex`, excluded from sitemap/hreflang.
8. **CSP is restrictive and build-generated.** Allowlist: site, R2 asset host, lobby endpoint, GoatCounter (`gc.zgo.at` + `wardogs-artillery.goatcounter.com/count`), Turnstile. New network destinations require CSP changes in the build.

## Architecture Map

- `js/core/` — config load (`config/app.json`), asset-access (R2 session/preclearance), analytics, mobile redirect
- `js/map/` — map view, tiles, contours, overlays, control zones, grid, renderer; `js/map/tools/` (state/controls/interactions/rendering) and `js/ui/layout/` (sidebar/menu/coordinator) are grouped modules sharing global scope per manifest order
- `js/features/` — weapons, coordinates, fire adjustment, reload trainer, saved targets, MOTD, results
- `js/collab/`, `js/workers/` — lobby client, terrain worker
- `config/app.json` — feature flags (SPH platform correction + high-arc calibration), asset gateway, collab limits, map-tool keyboard shortcuts, site metadata/version
- `maps/index.json` — map registry; per-map JSON defines `bounds` (playable grid) vs `tileBounds` (pyramid extent, independent) and `coordinateMetersPerUnit`
- `scripts/` — build/verify/dev tooling; tests live in `scripts/lib/*.test.mjs` as flat node:test files (e.g. `ballistics.test.mjs`, `registry-security.test.mjs`, `sph-field-calibration.test.mjs`)
- `src/pages/maps/template.html` — shared map landing page template; content in `scripts/map-landing-pages.mjs` (EN) and `scripts/map-landing-locales.mjs` (translations)

## Testing Notes

- Tests are plain `node:test` files — no test framework config. Run one with `node --test scripts/lib/<name>.test.mjs`.
- `npm run test:build` (`scripts/verify-build.mjs`) enforces the production contract: security headers/CSP, SEO metadata, localized routes, lightweight landing pages.
- Localized routes must be validated from a production build (source dev server serves legacy shells for some routes).
- After `npm run build`, spot-check `<locale>/`, `mobile/<locale>/`, `<locale>/maps/<map-id>/` routes.

## Workflow

Edit source → `npm run dev` live-reloads for normal routes (restart server after editing `map-landing-*.mjs`) → `npm run build` → validate generated routes → `npm run check` before commit/deploy.

Commits follow conventional style: `feat:`, `fix:`, etc.