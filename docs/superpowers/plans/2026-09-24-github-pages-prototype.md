# OrientMe Demo GitHub Pages Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deploy the supplied OrientMe frontend at `https://siddharthsmaarga.github.io/OrientMe-Demo/` with a browser-local manual project creation flow.

**Architecture:** Keep the supplied Next.js static app in `pages-site/` beside the existing full-stack app. Export it to static HTML with the repository `basePath`; store user-created project records in local storage and load their details through the one pre-rendered topic route using a URL hash selector.

**Tech Stack:** Next.js App Router, React, npm, GitHub Actions Pages deployment.

**Spec:** `docs/superpowers/specs/2026-09-24-github-pages-prototype.md`

## Global Constraints

- Work only in `siddharthsmaarga/OrientMe-Demo` and push directly to its `main` branch.
- Preserve `orientme-app/` and `deployment/` behavior.
- Publish only static output from `pages-site/out` on `main`; do not deploy from `prototype`.
- Keep the existing frontend pages and styling; replace customer-like sample details with generic fictional content.
- Save created projects in the visitor's local storage; do not claim cross-device sharing, folder scanning, backend access, or AI generation.
- The manual project form has required `name`, required `topic_type`, optional `one_liner`, and optional `related_people` fields.
- Do not add or run automated tests; verify the static production build and inspect the final diff.

## Review Focus

- Browser storage unavailable or malformed: creation reports a clear error and existing demo content still opens.
- Empty or whitespace-only project name: form validation prevents creation.
- Custom project URL opened directly or refreshed: hash-selected project loads from local storage without displaying the canned demo project's content.
- Existing demo project opened normally: retains its own canned data and interactions.
- Repository base path and public assets: every page and asset resolves below `/OrientMe-Demo/`.

---

### Task 1: Add the isolated static site and Pages workflow

**Files:**
- Create: `pages-site/` from the supplied ZIP, excluding `AGENTS.md`, `CLAUDE.md`, `README.md`, logs, and the archive `.gitignore`; add a project-specific README.
- Modify: `pages-site/next.config.mjs`
- Create: `.github/workflows/deploy-pages.yml`
- Modify: root `README.md`
- Modify: root `.gitignore`

**Interfaces:**
- Build command: `GITHUB_PAGES=true npm run build` from `pages-site/`.
- Build output: `pages-site/out/`.
- Workflow trigger: push to `main` when Pages source or workflow changes, plus manual dispatch; the deploy job checks that the selected ref is `main`.

- [ ] Copy the application, public assets, package manifest/lock, and build configuration into `pages-site/`; exclude instruction files, logs, the archive README, and archive `.gitignore`.
- [ ] Configure static export, `trailingSlash: true`, unoptimized images, and `basePath: "/OrientMe-Demo"` only when `GITHUB_PAGES=true`.
- [ ] Add the official configure-pages, upload-pages-artifact, and deploy-pages Actions with least required permissions and the `github-pages` environment.
- [ ] Document the public URL, local start command, deployment branch, and static-demo limits in `README.md` and `pages-site/README.md`.
- [ ] Ignore `pages-site/out/` so locally generated deployment artifacts are not committed.

### Task 2: Replace identifying sample content

**Files:**
- Modify: `pages-site/app/lib/dummyData.js`
- Modify: `pages-site/app/page.js`
- Modify: `pages-site/app/dashboard/page.js`
- Modify: `pages-site/app/components/Sidebar.js`
- Modify: `pages-site/app/topics/[id]/TopicDetailClient.js`
- Modify: any other copied text or comments containing the identified names, customer, project, or local filesystem paths.

**Interfaces:**
- Preserve the current demo data object shapes consumed by the dashboard, topic detail, board, calendar, and canned Q&A.
- All visible names, source labels, project details, and example paths become generic fictional content.

- [ ] Replace customer and person names, project-specific business details, and local Windows paths in the demo data with generic fictional logistics-planning examples and role labels.
- [ ] Replace named examples in placeholder prompts and user-facing copy with generic examples.
- [ ] Remove unrelated internal names from source comments while retaining useful technical explanations.
- [ ] Search all copied text and source for the original names, brand-specific customer references, and `C:/Projects` paths; resolve every match outside package integrity hashes.

### Task 3: Add browser-local project persistence

**Files:**
- Modify: `pages-site/app/lib/api.js`
- Modify: `pages-site/app/lib/dummyData.js` only if a shared neutral project shape is needed.

**Interfaces:**
- `api.createTopic(data)` returns the created topic with a stable generated `id`.
- `api.listTopics()` returns the canned demo topic plus user-created topics.
- `api.getTopic(id)` returns the selected topic's details.
- Search, counts, task, calendar, meeting metadata, and summary access for a newly created empty topic must not leak the canned demo topic's contents.

- [ ] Add guarded local-storage read/write helpers using one versioned key for user-created projects.
- [ ] Validate and normalize the four form fields; generate IDs with `crypto.randomUUID()` and preserve creation time.
- [ ] Return empty files, folders, messages, meetings, summaries, and tasks for a new project; retain the canned demo state for its original ID.
- [ ] Extend list, lookup, search, and stats API methods to include locally stored projects while preserving their existing call signatures.
- [ ] Return an explicit static-demo error when browser storage cannot be read or written.

### Task 4: Match the existing manual creation UX and support static detail links

**Files:**
- Modify: `pages-site/app/dashboard/page.js`
- Modify: `pages-site/app/topics/[id]/TopicDetailClient.js`
- Modify: `pages-site/app/topics/[id]/page.js` only if the static shell needs a Suspense boundary or route adjustment.

**Interfaces:**
- Dashboard form fields and labels match `orientme-app/frontend/app/dashboard/page.js`.
- New project links use the pre-rendered `/topics/demo/` page plus `#project=<id>` so GitHub Pages never needs to serve an unbuilt dynamic path.
- Topic-detail API calls use the selected hash ID after client initialization and on hash changes.

- [ ] Add the full app's “Add empty project manually” action, required name/type fields, optional one-liner/related people, submit validation, save state, and cancel behavior in the Pages dashboard.
- [ ] Refresh the project list after creation and link the new card to the static detail shell with its project ID in the hash.
- [ ] Add client-side selection initialization before loading topic data; listen for hash changes and load the matching locally stored project.
- [ ] Ensure a new project shows honest empty states and backend-only actions report that static hosting cannot scan folders or generate briefs.
- [ ] Keep the existing canned project page and its existing sample interactions distinct from custom empty projects.

### Task 5: Build, review, and publish on `main`

**Files:**
- Review: all files changed in Tasks 1–4.

**Interfaces:**
- Successful static build creates `pages-site/out/index.html` and generated assets.
- Pages workflow publishes only the artifact built from `main`.

- [ ] Install the exact locked dependencies with `npm ci` in `pages-site/`.
- [ ] Run `GITHUB_PAGES=true npm run build` from `pages-site/`; resolve all export errors and missing static routes.
- [ ] Search the built export for incorrect root paths and the public source for the identifying sample references.
- [ ] Run `git diff --check` and inspect `git diff --stat` plus the full diff; confirm `orientme-app/` and `deployment/` are unchanged.
- [ ] Commit the reviewed site and workflow changes on `main`, push to `origin/main`, then inspect that Pages Actions deploy succeeded and report the published URL.
