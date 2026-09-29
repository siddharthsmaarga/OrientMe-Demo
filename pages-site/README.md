# OrientMe static demo

This is the public, static frontend demo served from GitHub Pages:

This site is published from the repository's GitHub Pages configuration.

## Run locally

```powershell
npm ci
npm run dev
```

## Deployment

The `Deploy OrientMe static demo to GitHub Pages` workflow builds this app and deploys it only after changes reach the repository's `main` branch. The build exports static files to `out/` under the `/OrientMe-Demo/` base path.

## Static demo behavior and limits

- The frontend uses the supplied fictional sample records. Tasks, commitments, decisions, and risks can be changed during a session; those fixture edits reset on refresh.
- Projects created with the manual form are stored in this browser only. They do not sync to other people or devices. Use fictional information in this public demo.
- Folder scanning, file imports, recordings-folder watching, audio/video transcription, external transcription tools, account services, and backend workflows require the Django service and are not connected on GitHub Pages. Their controls show demo behavior; files are not uploaded or transcribed, and no business systems are contacted.
- The provider/model settings, protected API-key handling, server-side Ask generation, and backend exports in the full application are not available on Pages. Ask/Orient uses only the browser model described below; no provider key is shipped to the public site.
- Ask/Orient on the supplied sample projects runs SmolLM2-360M-Instruct in the visitor's browser using Transformers.js. Its first use downloads model files from Hugging Face; the browser caches them. The question and generated answer are processed on the device. Do not enter private or real customer information into this public demo.
- Browser-created projects have no source material, so the model is not called for those projects. They remain usable as project records and can be deleted locally.
- The model is intentionally small and can produce inaccurate answers. Treat responses as experimental and verify important details.
