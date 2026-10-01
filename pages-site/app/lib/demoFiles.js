// Client-side stand-ins for the real app's backend-served files and
// OS-level launchers (CSV/Markdown export endpoints, "open this file in its
// own application", the shareable index.html brief). The static demo has no
// server, so each one is generated in the browser from the fictional fixture
// data - nothing is uploaded and nothing leaves the device.

export function downloadText(filename, mime, content) {
  const blob = new Blob([content], { type: `${mime};charset=utf-8` });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// Opens generated HTML/text in a new tab via a Blob URL (revoked after a
// minute so the tab has time to load it).
export function openInNewTab(content, mime = "text/html") {
  const url = URL.createObjectURL(new Blob([content], { type: `${mime};charset=utf-8` }));
  window.open(url, "_blank", "noopener");
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function csvCell(value) {
  const s = value == null ? "" : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsv(rows) {
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
}

// Same field/label pairs the real backend's export_brief_md and
// export_summary_csv use (core/views.py SUMMARY_CSV_FIELDS).
const SUMMARY_FIELDS = [
  ["why_now", "Why now"],
  ["current_state", "Current state"],
  ["history", "History"],
  ["customer_thoughts", "Customer perspective"],
  ["promises_made", "Commitments and open loops"],
  ["next_step", "Next step"],
  ["risks_and_gaps", "Risks and gaps"],
];

export function briefMarkdown(topic, summary) {
  const lines = [`# ${topic.name}`, ""];
  if (summary && summary.generated_at) {
    for (const [field, label] of SUMMARY_FIELDS) {
      if (summary[field]) lines.push(`## ${label}`, summary[field], "");
    }
  } else {
    lines.push("_No AI Context Brief generated yet._");
  }
  return lines.join("\n");
}

export function summaryCsv(summary) {
  return toCsv([["field", "label", "value"], ...SUMMARY_FIELDS.map(([f, l]) => [f, l, summary?.[f] || ""])]);
}

export function tasksCsv(tasks) {
  return toCsv([
    ["id", "title", "assignee", "due_date", "status"],
    ...tasks.map((t) => [t.id, t.title, t.assignee || "", t.due_date || "", t.status]),
  ]);
}

// Stand-in for the backend's shareable brief_html page (what Wox/Raycast
// open) - a small self-contained page built from the same brief fields.
export function briefHtmlPage(topic, summary) {
  const sections =
    summary && summary.generated_at
      ? SUMMARY_FIELDS.filter(([f]) => summary[f])
          .map(([f, l]) => `<h2>${escapeHtml(l)}</h2><p>${escapeHtml(summary[f]).replace(/\n/g, "<br>")}</p>`)
          .join("")
      : "<p><em>No AI Context Brief generated yet.</em></p>";
  return `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(topic.name)} - brief</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:46rem;margin:2rem auto;padding:0 1rem;color:#1a1a1a}h1{color:#4b2e83}h2{font-size:1rem;margin:1.4rem 0 .2rem;color:#555}.note{background:#f3f2ec;border-radius:6px;padding:.5rem .75rem;font-size:13px;color:#555}</style></head>
<body><h1>${escapeHtml(topic.name)}</h1><p>${escapeHtml(topic.one_liner || "")}</p>${sections}
<p class="note">Demo mode - generated in this browser from fictional sample data.</p></body></html>`;
}

// "Open in its own application" for a source file: the demo has no real file
// on disk, so this shows the fixture's extracted text in a read-only tab.
export function openSourceFile(file) {
  const name = file.display_name || file.path;
  const body = file.extracted_text || "(No extracted text is stored for this sample file.)";
  openInNewTab(
    `<!doctype html><html><head><meta charset="utf-8"><title>${escapeHtml(name)}</title>
<style>body{font:14px/1.6 ui-monospace,Consolas,monospace;max-width:50rem;margin:2rem auto;padding:0 1rem;white-space:pre-wrap}.note{font:13px system-ui,sans-serif;background:#f3f2ec;border-radius:6px;padding:.5rem .75rem;margin-bottom:1rem;white-space:normal}</style></head>
<body><div class="note">Demo mode - the full app opens this file in its own application. Here is the sample file's extracted text, read-only.</div>${escapeHtml(body)}</body></html>`
  );
}
