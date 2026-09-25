# OrientMe static demo

This is the public, static frontend demo served from GitHub Pages:

<https://siddharthsmaarga.github.io/OrientMe-Demo/>

## Run locally

```powershell
npm ci
npm run dev
```

## Deployment

The `Deploy OrientMe static demo to GitHub Pages` workflow builds this app and deploys it only after changes reach the repository's `main` branch. The build exports static files to `out/` under the `/OrientMe-Demo/` base path.

## Static demo limits

- Projects created with the manual form are stored in this browser only. They do not sync to other people or devices; use fictional information in this public demo.
- Folder scanning, file imports, backend APIs, account management, and AI-generated briefs are unavailable on GitHub Pages.
- Questions about the included fictional sample project run with SmolLM2-360M-Instruct in the visitor's browser using Transformers.js. Its first use downloads about 273 MB of GPU weights or 388 MB for the CPU fallback from Hugging Face; model files are cached by the browser. The question and generated answer stay on the device. Do not enter private or real customer information into this public demo.
- The model is intentionally small and can produce inaccurate answers. Treat responses as experimental and verify important details. The model sees only the fictional sample project, not projects created in the browser.
