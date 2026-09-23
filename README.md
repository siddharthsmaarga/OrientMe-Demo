# OrientMe demo

This repository hosts a static, fictional-data preview of OrientMe Search, Ask, and Orient. It lets colleagues view the proposed interface in a browser. It is not the planned Search V0 application and it does not connect to company files, an account system, or an AI service.

## How it works

```text
GitHub Pages -> browser -> bundled fictional example notes
```

`index.html`, `styles.css`, and `app.js` are byte-for-byte copies of the OrientMe `prototype` branch app. Search filters four bundled example notes in the browser. Ask and Orient show fixed example responses.

## Deployment

This repository has one branch, `prototype`. GitHub Pages serves the branch root directly. In **Settings > Pages**, select **Deploy from a branch**, `prototype`, and `/ (root)`, then save. The public site uses GitHub's `github.io` address.

To update the demo, push changes directly to `prototype`. Do not open a pull request or merge the demo into the original OrientMe repository.

## Limits

- Publicly visible. Do not add private source files or real company data.
- No login, backend, model calls, or live document ingestion.
- The examples illustrate the interface and evidence presentation; they do not prove Search V0 acceptance criteria.
