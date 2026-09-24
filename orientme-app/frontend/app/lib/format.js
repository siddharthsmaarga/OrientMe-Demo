// Shared date-formatting helpers - pulled out of topics/[id]/page.js so the
// global Tasks/Statistics pages can format the same way without duplicating
// this logic (the sprint transcript's "extensible at every level... refactor
// the code" instruction, applied the first time a second page needed it).

export function formatAdded(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function formatMeetingDate(iso) {
  if (!iso) return "";
  const d = new Date(String(iso) + "T00:00:00");
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

// Automatic urgency for one task, derived purely from its own due_date vs
// today - never a status a person sets by hand. "red" = overdue, "yellow" =
// due within 3 days, "green" = has a due date and isn't urgent yet, null =
// no due date to judge urgency from (done tasks are never urgent).
export function taskUrgency(task) {
  if (!task || task.status === "done" || !task.due_date) return null;
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const due = new Date(String(task.due_date) + "T00:00:00");
  if (isNaN(due.getTime())) return null;
  const diffDays = (due - today) / 86400000;
  if (diffDays < 0) return "red";
  if (diffDays <= 3) return "yellow";
  return "green";
}

// A project's overall urgency is the worst urgency among its own open
// tasks - one overdue task makes the whole project read red, same idea as
// a build going red if any single check fails.
export function projectUrgency(tasks) {
  let worst = null;
  for (const t of tasks) {
    const u = taskUrgency(t);
    if (u === "red") return "red";
    if (u === "yellow") worst = "yellow";
    else if (u === "green" && worst !== "yellow") worst = "green";
  }
  return worst;
}

export const TYPE_STYLES = {
  project: "bg-cyan-100 text-cyan-800",
  area: "bg-slate-100 text-slate-800",
  process: "bg-amber-100 text-amber-800",
  person: "bg-emerald-100 text-emerald-800",
  customer: "bg-purple-100 text-purple-800",
  opportunity: "bg-orange-100 text-orange-800",
};

export const TYPE_LABELS = {
  project: "Project",
  area: "Area",
  process: "Process",
  person: "Person",
  customer: "Customer",
  opportunity: "Opportunity",
};

export const URGENCY_STYLES = {
  red: { dot: "bg-red-500", text: "text-red-700", bg: "bg-red-50", border: "border-red-200", label: "Due" },
  yellow: {
    dot: "bg-amber-500",
    text: "text-amber-700",
    bg: "bg-amber-50",
    border: "border-amber-200",
    label: "Due soon",
  },
  green: {
    dot: "bg-emerald-500",
    text: "text-emerald-700",
    bg: "bg-emerald-50",
    border: "border-emerald-200",
    label: "On time",
  },
};
