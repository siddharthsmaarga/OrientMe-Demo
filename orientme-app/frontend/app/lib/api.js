// Thin fetch wrapper around the Django API. Real login now exists (session
// cookies) - every request sends credentials, and every mutating one sends
// Django's CSRF header back, read from the cookie the backend's own
// /auth/csrf/ priming call sets.

// Must share a "site" with wherever the frontend itself is served from -
// the login session is a real cookie, and SameSite=Lax cookies don't travel
// between what browsers treat as different sites even when both just mean
// "this machine" (localhost vs 127.0.0.1 are different sites for this
// purpose). A real bug this caused: opening the app via a
// 127.0.0.1-based URL (e.g. a Raycast/Wox quicklink) while this was
// hardcoded to "localhost" left the dashboard stuck on "Loading..."
// forever - derive the backend host from wherever THIS page was actually
// loaded from instead of hardcoding one, so it's always correct.
function resolveApiBase() {
  if (process.env.NEXT_PUBLIC_API_BASE) return process.env.NEXT_PUBLIC_API_BASE;
  if (typeof window !== "undefined" && window.location?.hostname) {
    return `${window.location.protocol}//${window.location.hostname}:8010/api`;
  }
  return "http://localhost:8010/api"; // server-side render fallback only
}
export const API_BASE = resolveApiBase();

export function getCsrfToken() {
  if (typeof document === "undefined") return "";
  const match = document.cookie.match(/(?:^|; )csrftoken=([^;]*)/);
  return match ? decodeURIComponent(match[1]) : "";
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);

async function request(path, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const headers = { "Content-Type": "application/json", ...options.headers };
  if (UNSAFE_METHODS.has(method)) headers["X-CSRFToken"] = getCsrfToken();
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: "include",
    cache: "no-store",
    ...options,
    headers,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`${res.status} ${res.statusText}: ${text}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export const api = {
  listTopics: () => request("/topics/"),
  orient: (requestText, topicId) =>
    request("/orient/", {
      method: "POST",
      body: JSON.stringify(topicId ? { request: requestText, topic_id: topicId } : { request: requestText }),
    }),
  getTopic: (id) => request(`/topics/${id}/`),
  createTopic: (data) =>
    request("/topics/", { method: "POST", body: JSON.stringify(data) }),
  // One or more folder paths in, a fully set-up (scanned + first brief
  // generated) topic out - no manual "add folder" + "scan" + "refresh
  // brief" steps. name is optional - falls back to the first folder's own
  // name server-side, same as the original single-folder behavior.
  autoCreateTopic: (folderPaths, name) =>
    request("/topics/auto_create/", {
      method: "POST",
      body: JSON.stringify({ folder_paths: folderPaths, name: name || "" }),
    }),
  addFolder: (topicId, path) =>
    request(`/topics/${topicId}/add_folder/`, {
      method: "POST",
      body: JSON.stringify({ path }),
    }),
  ingest: (topicId) => request(`/topics/${topicId}/ingest/`, { method: "POST" }),
  getScanStatus: (topicId) => request(`/topics/${topicId}/scan_status/`),
  // Venki's own stated editing preference - CSV round-trips for real
  // (Markdown export is one-way; see export_brief_md's own docstring).
  importTasksCsv: async (topicId, file) => {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch(`${API_BASE}/topics/${topicId}/import_tasks_csv/`, {
      method: "POST",
      credentials: "include",
      headers: { "X-CSRFToken": getCsrfToken() },
      body: formData,
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
    return res.json();
  },
  // The CSV half of brief editing - same "AI creates, I edit on top of it
  // with standard tools" split, applied to the brief itself, not just tasks.
  importSummaryCsv: async (topicId, file) => {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch(`${API_BASE}/topics/${topicId}/import_summary_csv/`, {
      method: "POST",
      credentials: "include",
      headers: { "X-CSRFToken": getCsrfToken() },
      body: formData,
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
    return res.json();
  },
  uploadFile: async (topicId, file) => {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch(`${API_BASE}/topics/${topicId}/upload_file/`, {
      method: "POST",
      credentials: "include",
      headers: { "X-CSRFToken": getCsrfToken() },
      body: formData,
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
    return res.json();
  },
  importMbox: async (topicId, file) => {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch(`${API_BASE}/topics/${topicId}/import_mbox/`, {
      method: "POST",
      credentials: "include",
      headers: { "X-CSRFToken": getCsrfToken() },
      body: formData,
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
    return res.json();
  },
  importIcs: async (topicId, file) => {
    const formData = new FormData();
    formData.append("file", file);
    const res = await fetch(`${API_BASE}/topics/${topicId}/import_ics/`, {
      method: "POST",
      credentials: "include",
      headers: { "X-CSRFToken": getCsrfToken() },
      body: formData,
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
    return res.json();
  },
  pasteText: (topicId, text, label) =>
    request(`/topics/${topicId}/paste_text/`, {
      method: "POST",
      body: JSON.stringify({ text, label }),
    }),
  ask: (topicId, question) =>
    request(`/topics/${topicId}/ask/`, {
      method: "POST",
      body: JSON.stringify({ question }),
    }),
  clearTopicChat: (topicId) => request(`/topics/${topicId}/clear_chat/`, { method: "DELETE" }),
  uploadFolder: async (topicId, fileList) => {
    const formData = new FormData();
    Array.from(fileList).forEach((file) => {
      formData.append("files", file);
      formData.append("paths", file.webkitRelativePath || file.name);
    });
    const res = await fetch(`${API_BASE}/topics/${topicId}/upload_folder/`, {
      method: "POST",
      credentials: "include",
      headers: { "X-CSRFToken": getCsrfToken() },
      body: formData,
    });
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}: ${await res.text()}`);
    return res.json();
  },
  getMeetingMetadata: (topicId) => request(`/topics/${topicId}/meeting_metadata/`),
  computePayroll: (topicId) =>
    request(`/topics/${topicId}/compute_payroll/`, { method: "POST" }),
  approvePayroll: (topicId, workflowId) =>
    request(`/topics/${topicId}/workflows/${workflowId}/approve/`, { method: "POST" }),
  getCalendar: (topicId) =>
    request(`/calendar/${topicId ? `?topic_id=${topicId}` : ""}`),
  getTasks: (topicId) => request(topicId ? `/tasks/?topic=${topicId}` : "/tasks/"),
  getStats: () => request("/stats/"),
  getGlobalChat: () => request("/chat/global/"),
  askGlobal: (question) =>
    request("/chat/global/", { method: "POST", body: JSON.stringify({ question }) }),
  clearGlobalChat: () => request("/chat/global/", { method: "DELETE" }),
  updateTaskStatus: (taskId, status) =>
    request(`/tasks/${taskId}/`, { method: "PATCH", body: JSON.stringify({ status }) }),
  updateTaskDueDate: (taskId, dueDate) =>
    request(`/tasks/${taskId}/`, { method: "PATCH", body: JSON.stringify({ due_date: dueDate || null }) }),
  deleteTopic: (topicId) => request(`/topics/${topicId}/`, { method: "DELETE" }),
  getSettings: () => request("/settings/"),
  saveSettings: (data) =>
    request("/settings/", { method: "POST", body: JSON.stringify(data) }),
  // AI Context Brief (CaseSummary) - the persisted "current state / next
  // step" panel on a topic's own page.
  getLatestSummary: (topicId) => request(`/topics/${topicId}/latest_summary/`),
  refreshSummary: (topicId) => request(`/topics/${topicId}/refresh_summary/`, { method: "POST" }),
  // Full history (not just the latest) - used by the Project Timeline to
  // show status updates and payroll runs over time, not just documents.
  getSummaryHistory: (topicId) => request(`/topics/${topicId}/summary_history/`),
  getWorkflowHistory: (topicId) => request(`/topics/${topicId}/workflow_history/`),
  // Action Center - "AI Execute" a ready-to-edit draft for one task.
  aiExecuteTask: (taskId) => request(`/tasks/${taskId}/ai_execute/`, { method: "POST" }),
  // Saved "Ask OrientMe" prompts ("Save this prompt as a Loop").
  listLoops: () => request("/loops/"),
  createLoop: (question) =>
    request("/loops/", { method: "POST", body: JSON.stringify({ question }) }),
  runLoop: (loopId) => request(`/loops/${loopId}/run/`, { method: "POST" }),
  deleteLoop: (loopId) => request(`/loops/${loopId}/`, { method: "DELETE" }),
  // Connectors - only ever records that access was REQUESTED, never
  // actually grants it (see backend ConnectorStatus's own docstring).
  getConnectorStatuses: () => request("/connectors/"),
  requestConnector: (slug) => request(`/connectors/${slug}/request/`, { method: "POST" }),
  resetConnector: (slug) => request(`/connectors/${slug}/reset/`, { method: "POST" }),
  // Universal search (Ctrl/Cmd+K).
  search: (q) => request(`/search/?q=${encodeURIComponent(q)}`),
  // Auth - real Django sessions, 2 roles (admin/user). primeCsrf() must be
  // called once before any login attempt so Django has actually set the
  // csrftoken cookie the login POST needs to send back.
  primeCsrf: () => request("/auth/csrf/"),
  login: (username, password) =>
    request("/auth/login/", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => request("/auth/logout/", { method: "POST" }),
  me: () => request("/auth/me/"),
  changePassword: (oldPassword, newPassword) =>
    request("/auth/change_password/", {
      method: "POST",
      body: JSON.stringify({ old_password: oldPassword, new_password: newPassword }),
    }),
  updateProfile: (displayName) =>
    request("/auth/update_profile/", {
      method: "POST",
      body: JSON.stringify({ display_name: displayName }),
    }),
};
