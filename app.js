/* Runs local search and evidence previews over four fictional notes. Ask and Orient content is static and clearly presented as an example, with no network calls. */
const sources = [
  {
    id: "planning-brief",
    title: "Launch planning brief",
    group: "planning",
    groupLabel: "Planning",
    updated: "Updated recently",
    type: "Brief",
    excerpt: "The first review is planned for Thursday. Keep the wider release date open until the accessibility pass is complete. The team will review onboarding flow, keyboard behavior, and the revised setup notes.",
    full: "The first review is planned for Thursday. Keep the wider release date open until the accessibility pass is complete. The team will review onboarding flow, keyboard behavior, and the revised setup notes. The release date should be revisited after the review, once the remaining readiness items are visible."
  },
  {
    id: "decision-log",
    title: "Open decisions",
    group: "decisions",
    groupLabel: "Decisions",
    updated: "Updated recently",
    type: "Meeting note",
    excerpt: "The accessibility pass is still open. No owner is named in this note. Confirm the owner before changing the release date or sharing a firm commitment.",
    full: "The accessibility pass is still open. No owner is named in this note. Confirm the owner before changing the release date or sharing a firm commitment. The group agreed to return to the question after the first review."
  },
  {
    id: "research-notes",
    title: "Search research notes",
    group: "research",
    groupLabel: "Research",
    updated: "Edited this week",
    type: "Research note",
    excerpt: "People want to see the passage that supports an answer. Search should stay useful even when answer generation is unavailable.",
    full: "People want to see the passage that supports an answer. Search should stay useful even when answer generation is unavailable. In the example review, participants used source titles and short excerpts to decide which note to open."
  },
  {
    id: "weekly-plan",
    title: "Weekly work plan",
    group: "planning",
    groupLabel: "Planning",
    updated: "Edited this week",
    type: "Work plan",
    excerpt: "This week: prepare the review, check the keyboard flow, and gather feedback on the setup notes. The next checkpoint is Thursday.",
    full: "This week: prepare the review, check the keyboard flow, and gather feedback on the setup notes. The next checkpoint is Thursday. Follow-up items should stay marked as open until someone confirms their owner and status."
  }
];

const resultList = document.querySelector("#results");
const searchInput = document.querySelector("#search-input");
const resultCount = document.querySelector("#result-count");
const emptyState = document.querySelector("#empty-state");
const sourceDialog = document.querySelector("#source-dialog");
let selectedGroup = "all";

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
}

function highlight(text, query) {
  const safeText = escapeHtml(text);
  const terms = query.trim().split(/\s+/).filter((term) => term.length > 1);
  if (!terms.length) return safeText;
  const expression = new RegExp(`(${terms.map((term) => term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`, "ig");
  return safeText.replace(expression, "<mark>$1</mark>");
}

function renderResults() {
  const query = searchInput.value.trim();
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = sources.filter((source) => {
    const groupMatches = selectedGroup === "all" || source.group === selectedGroup;
    const content = `${source.title} ${source.groupLabel} ${source.type} ${source.excerpt}`.toLowerCase();
    return groupMatches && words.every((word) => content.includes(word));
  });

  resultCount.textContent = `${matches.length} ${matches.length === 1 ? "note" : "notes"} ${query ? "match your search" : "in the example library"}`;
  emptyState.hidden = matches.length > 0;
  resultList.hidden = matches.length === 0;
  resultList.innerHTML = matches.map((source) => `
    <article class="result-card">
      <div class="result-topline"><span class="file-icon" aria-hidden="true">${source.type === "Brief" ? "B" : source.type === "Work plan" ? "P" : "N"}</span><span>${source.type}</span><span aria-hidden="true">·</span><span>${source.updated}</span></div>
      <div class="result-tags"><span class="tag">${source.groupLabel}</span></div>
      <h2 class="result-title">${escapeHtml(source.title)}</h2>
      <p class="result-excerpt">${highlight(source.excerpt, query)}</p>
      <button class="open-source" type="button" data-source="${source.id}">Open example note <span aria-hidden="true">↗</span></button>
    </article>`).join("");
}

function openSource(sourceId) {
  const source = sources.find((item) => item.id === sourceId);
  if (!source) return;
  document.querySelector("#dialog-category").textContent = `${source.groupLabel} / ${source.type}`;
  document.querySelector("#dialog-title").textContent = source.title;
  document.querySelector("#dialog-meta").textContent = `${source.updated} · Example source`;
  document.querySelector("#dialog-excerpt").textContent = source.full;
  sourceDialog.showModal();
}

document.querySelector("#search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  renderResults();
});
searchInput.addEventListener("input", renderResults);
document.querySelectorAll(".source-filter").forEach((button) => {
  button.addEventListener("click", () => {
    selectedGroup = button.dataset.filter;
    document.querySelectorAll(".source-filter").forEach((item) => {
      const selected = item === button;
      item.classList.toggle("is-selected", selected);
      item.setAttribute("aria-pressed", String(selected));
    });
    renderResults();
  });
});

document.querySelectorAll(".mode-tab").forEach((button) => {
  button.addEventListener("click", () => {
    const mode = button.dataset.mode;
    document.querySelectorAll(".mode-tab").forEach((tab) => {
      const selected = tab === button;
      tab.classList.toggle("is-active", selected);
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    document.querySelectorAll(".mode-panel").forEach((panel) => { panel.hidden = panel.dataset.panel !== mode; });
    history.replaceState(null, "", `#${mode}`);
  });
});

document.querySelector("#clear-search").addEventListener("click", () => {
  searchInput.value = "";
  selectedGroup = "all";
  document.querySelectorAll(".source-filter").forEach((item, index) => {
    item.classList.toggle("is-selected", index === 0);
    item.setAttribute("aria-pressed", String(index === 0));
  });
  renderResults();
  searchInput.focus();
});
document.querySelector("#show-answer").addEventListener("click", () => {
  document.querySelector("#sample-answer").hidden = false;
  document.querySelector("#sample-answer").scrollIntoView({ behavior: "smooth", block: "nearest" });
});
document.addEventListener("click", (event) => {
  const sourceButton = event.target.closest("[data-source]");
  if (sourceButton) openSource(sourceButton.dataset.source);
});
document.querySelector("[data-open-about]").addEventListener("click", () => document.querySelector("#about-dialog").showModal());
document.querySelectorAll(".mode-tab").forEach((button) => {
  button.addEventListener("keydown", (event) => {
    if (!["ArrowRight", "ArrowLeft"].includes(event.key)) return;
    event.preventDefault();
    const tabs = [...document.querySelectorAll(".mode-tab")];
    const currentIndex = tabs.indexOf(button);
    const delta = event.key === "ArrowRight" ? 1 : -1;
    tabs[(currentIndex + delta + tabs.length) % tabs.length].focus();
  });
});

const requestedMode = location.hash.slice(1);
if (["search", "ask", "orient"].includes(requestedMode) && requestedMode !== "search") {
  document.querySelector(`[data-mode="${requestedMode}"]`).click();
}
renderResults();
