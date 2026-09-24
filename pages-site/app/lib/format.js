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

// "2h ago" / "5m ago" / "3d ago" - the Context Node header's "Updated ..."
// stamp, matching the reference mockup exactly ("Updated 2h ago").
export function formatTimeAgo(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  const diffMs = Date.now() - d.getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 14) return `${days}d ago`;
  return formatMeetingDate(iso.slice(0, 10));
}

// "Today" / "Yesterday" / "23 Sep" - the Context Node's Recent Activity list
// wants this relative style (matches the reference mockup exactly), not a
// full date+time - the day is what matters at a glance, not the minute.
export function formatRelativeDay(timestampMs) {
  const d = new Date(timestampMs);
  if (isNaN(d.getTime())) return "";
  const startOfDay = (date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
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
