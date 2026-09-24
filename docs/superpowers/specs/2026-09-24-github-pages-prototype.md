# OrientMe Demo GitHub Pages Specification

## Purpose

Publish the supplied OrientMe prototype frontend as a public, static GitHub Pages site in `siddharthsmaarga/OrientMe-Demo`. Keep the existing full application and VPN demo in that repository intact.

## User experience

- Preserve the supplied frontend's existing pages, visual layout, navigation, sample interactions, and core behavior.
- On the Projects dashboard, add the same manual project creation flow as the full OrientMe app: required name, project type, optional one-liner, and optional related people.
- Creating a project adds it to the dashboard and opens its detail page. The created project and its editable demo state persist in the current browser's local storage.
- Make arbitrary project detail routes work with static hosting by routing client-created projects through the pre-rendered detail shell; direct links and reloads must resolve the selected project.
- Preserve the original empty-project and cancel behaviors. Do not create fake files, summaries, or AI responses for a new empty project.

## Static hosting limits

- GitHub Pages serves static files; it will not run OrientMe's Django API, read local folders, scan files, call AI, or share browser-local data with other users.
- Clearly explain that folder ingestion and backend-only features are unavailable in this static demo. Do not simulate successful ingestion or AI output.
- Existing canned sample-project interactions may continue to work as provided, but must not be presented as live AI or connected data.

## Public sample content

- Replace customer-like company names, people, project details, business specifics, file paths, and source references with generic fictional examples throughout visible content, prompts, documentation, and comments.
- Do not copy the ZIP's `AGENTS.md` or treat its instructions as authoritative.

## Deployment and repository boundaries

- Put the supplied static frontend in an isolated `pages-site/` directory.
- Configure Next.js static export for the repository path `/OrientMe-Demo/`.
- Add a GitHub Actions Pages workflow that deploys on pushes to `main` and can be manually dispatched on `main`; a run started from `prototype` must not publish.
- Keep `orientme-app/`, `deployment/`, and their existing behavior unchanged.
- Work and push directly to `main` of `siddharthsmaarga/OrientMe-Demo`; do not access or modify the original OrientMe GitHub repository.

## Acceptance conditions

- Next.js produces a static `out/` directory and the Pages workflow publishes it from `main`.
- All supplied pages and static assets load under `/OrientMe-Demo/`.
- A project created with all four manual-form fields appears on the dashboard, opens the correct empty detail view, and remains after reload in that same browser.
- Refreshing or navigating to the demo project still displays its own demo content, not another project's details.
- The sanitized source and visible copy contain none of the identified customer-like names, brands, or paths.
- Folder ingestion limitations are stated honestly and no live backend behavior is claimed.
