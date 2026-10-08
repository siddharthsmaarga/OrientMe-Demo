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
  // Partial edit - used for the optional Stage / Customer name fields.
  updateTopic: (id, fields) =>
    request(`/topics/${id}/`, { method: "PATCH", body: JSON.stringify(fields) }),
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
  // Thumbs up/down on one assistant answer - the "orientation run" capture
  // Venki asked for directly (30 Sep AI Adoption Sprint Meeting): "I should
  // be able to say thumbs up or thumbs down... it should be unobtrusive".
  // kind is "topic" (per-project ask) or "global" (the common chatbox).
  // value is "up", "down", or "" to clear it (clicking the same one again).
  setMessageFeedback: (kind, messageId, value) =>
    request(`/messages/${kind}/${messageId}/feedback/`, {
      method: "POST",
      body: JSON.stringify({ feedback: value }),
    }),
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
  // Work items (Kanban board) - manually adding/editing one directly
  // (source_file stays null, distinguishing it from an AI-extracted task).
  createTask: (topicId, { title, assignee }) =>
    request("/tasks/", {
      method: "POST",
      body: JSON.stringify({ topic: topicId, title, assignee: assignee || "" }),
    }),
  updateTask: (taskId, fields) =>
    request(`/tasks/${taskId}/`, { method: "PATCH", body: JSON.stringify(fields) }),
  deleteTask: (taskId) => request(`/tasks/${taskId}/`, { method: "DELETE" }),
  // Commitments - a person's promise/obligation, deliberately separate from
  // Task (see models.Commitment) - optionally points at a linked_task.
  getCommitments: (topicId) => request(topicId ? `/commitments/?topic=${topicId}` : "/commitments/"),
  createCommitment: (topicId, { person, commitment, date_made, due_date, linked_task }) =>
    request("/commitments/", {
      method: "POST",
      body: JSON.stringify({
        topic: topicId,
        person,
        commitment,
        date_made: date_made || null,
        due_date: due_date || null,
        linked_task: linked_task || null,
      }),
    }),
  updateCommitment: (commitmentId, fields) =>
    request(`/commitments/${commitmentId}/`, { method: "PATCH", body: JSON.stringify(fields) }),
  deleteCommitment: (commitmentId) => request(`/commitments/${commitmentId}/`, { method: "DELETE" }),
  // Risks - structured, tracked risks/blockers (see models.Risk), distinct
  // from the AI's own free-text risks_and_gaps read.
  getRisks: (topicId) => request(topicId ? `/risks/?topic=${topicId}` : "/risks/"),
  createRisk: (topicId, { description, impact, owner }) =>
    request("/risks/", {
      method: "POST",
      body: JSON.stringify({ topic: topicId, description, impact: impact || "", owner: owner || "" }),
    }),
  updateRisk: (riskId, fields) =>
    request(`/risks/${riskId}/`, { method: "PATCH", body: JSON.stringify(fields) }),
  deleteRisk: (riskId) => request(`/risks/${riskId}/`, { method: "DELETE" }),
  // Decisions - structured, persistent decision records (see models.Decision).
  getDecisions: (topicId) => request(topicId ? `/decisions/?topic=${topicId}` : "/decisions/"),
  createDecision: (topicId, { decision, context, participants, decided_date }) =>
    request("/decisions/", {
      method: "POST",
      body: JSON.stringify({
        topic: topicId,
        decision,
        context: context || "",
        participants: participants || "",
        decided_date: decided_date || null,
      }),
    }),
  updateDecision: (decisionId, fields) =>
    request(`/decisions/${decisionId}/`, { method: "PATCH", body: JSON.stringify(fields) }),
  deleteDecision: (decisionId) => request(`/decisions/${decisionId}/`, { method: "DELETE" }),
  // Project Intelligence - the explicit, always-current "Current Position"
  // editor (models.ProjectState), distinct from the AI-regenerated brief.
  getProjectState: (topicId) => request(`/topics/${topicId}/state/`),
  updateProjectState: (topicId, currentPosition) =>
    request(`/topics/${topicId}/state/`, {
      method: "PATCH",
      body: JSON.stringify({ current_position: currentPosition }),
    }),
  getStats: () => request("/stats/"),
  getGlobalChat: () => request("/chat/global/"),
  askGlobal: (question) =>
    request("/chat/global/", { method: "POST", body: JSON.stringify({ question }) }),
  clearGlobalChat: () => request("/chat/global/", { method: "DELETE" }),
  // Where an action item came from: its file (template name + real name) and
  // the closest-matching passage of it. Fetched when the item is clicked.
  getTaskSource: (taskId) => request(`/tasks/${taskId}/source/`),
  deleteTopic: (topicId) => request(`/topics/${topicId}/`, { method: "DELETE" }),
  getSettings: () => request("/settings/"),
  // Every save carries the settings password - the backend checks it each time
  // (being signed in is not enough to change a setting).
  saveSettings: (data, settingsPassword) =>
    request("/settings/", { method: "POST", body: JSON.stringify({ ...data, settings_password: settingsPassword }) }),
  // Checks the password without saving anything (unlocks the Settings page).
  unlockSettings: (settingsPassword) =>
    request("/settings/unlock/", { method: "POST", body: JSON.stringify({ settings_password: settingsPassword }) }),
  // Transcripts page - the central Recordings-folder auto-watch pipeline's
  // activity feed (core/recordings.py).
  getRecordingEvents: () => request("/recording_events/"),
  // Real in-browser drag-and-drop upload (dashboard + Transcripts page) -
  // same raw-fetch/FormData pattern as uploadFolder above, since this also
  // needs multipart, not JSON. A project (topicId) is required - every
  // uploaded file is filed straight into it.
  uploadRecordings: async (fileList, topicId) => {
    const formData = new FormData();
    formData.append("topic_id", String(topicId));
    Array.from(fileList).forEach((file) => formData.append("files", file));
    const res = await fetch(`${API_BASE}/recording_events/upload/`, {
      method: "POST",
      credentials: "include",
      headers: { "X-CSRFToken": getCsrfToken() },
      body: formData,
    });
    if (!res.ok) {
      const body = await res.text();
      let msg = `${res.status} ${res.statusText}: ${body}`;
      try {
        const parsed = JSON.parse(body);
        if (parsed && parsed.error) msg = parsed.error;
      } catch (_) {}
      throw new Error(msg);
    }
    return res.json();
  },
  assignRecordingEvent: (eventId, topicId) =>
    request(`/recording_events/${eventId}/assign_topic/`, {
      method: "POST",
      body: JSON.stringify({ topic_id: topicId }),
    }),
  // The corner "x" on a pending transcript card - Ayush's own ask, 30 Sep:
  // "add a cross option in the corner to not assign and remove this card".
  // Never deletes the row server-side (status='dismissed' instead), so it
  // just stops showing up in any "needs review" list, same honest-record
  // convention as every other outcome this pipeline logs.
  dismissRecordingEvent: (eventId) =>
    request(`/recording_events/${eventId}/dismiss/`, { method: "POST" }),
  bulkDismissRecordingEvents: (eventIds) =>
    request(`/recording_events/bulk_dismiss/`, {
      method: "POST",
      body: JSON.stringify({ event_ids: eventIds }),
    }),
  // The human-in-the-loop gate on new-project creation - name/one_liner/
  // topic_type are optional overrides on top of the LLM's own suggestion.
  confirmNewProject: (eventId, overrides) =>
    request(`/recording_events/${eventId}/confirm_new_project/`, {
      method: "POST",
      body: JSON.stringify(overrides || {}),
    }),
  rejectNewProject: (eventId) =>
    request(`/recording_events/${eventId}/reject_new_project/`, { method: "POST" }),
  // The manual counterpart - a person choosing to create a project from a
  // recording the pipeline never suggested one for (needs_review or an
  // unprocessed pre_existing recording), not just reacting to the LLM's
  // own suggestion. Re-transcribes on demand if the text isn't cached yet.
  createProjectFromRecording: (eventId, fields) =>
    request(`/recording_events/${eventId}/create_project/`, {
      method: "POST",
      body: JSON.stringify(fields || {}),
    }),
  // Transcript detail page - raw text, on-demand summary, re-diarize, and
  // saving the summary out to the project's real folder.
  getRecordingEvent: (eventId) => request(`/recording_events/${eventId}/`),
  getRecordingEventText: (eventId) => request(`/recording_events/${eventId}/text/`),
  generateRecordingSummary: (eventId) => request(`/recording_events/${eventId}/generate_summary/`, { method: "POST" }),
  diarizeRecording: (eventId) => request(`/recording_events/${eventId}/diarize/`, { method: "POST" }),
  generateSpeakerTranscript: (eventId) =>
    request(`/recording_events/${eventId}/generate_transcript/`, { method: "POST" }),
  saveRecordingSummary: (eventId) => request(`/recording_events/${eventId}/save_summary/`, { method: "POST" }),
  // "Who spoke what" - renames one speaker label across every turn.
  renameRecordingSpeaker: (eventId, oldName, newName) =>
    request(`/recording_events/${eventId}/rename_speaker/`, {
      method: "POST",
      body: JSON.stringify({ old: oldName, new: newName }),
    }),
  // File metadata (document type, tags, signal, state) - edit and confirm.
  updateFileMetadata: (fileId, fields) =>
    request(`/files/${fileId}/metadata/`, { method: "PATCH", body: JSON.stringify(fields) }),
  confirmFileMetadata: (fileId) => request(`/files/${fileId}/confirm/`, { method: "POST" }),
  // Meeting type / sequence, per-meeting human notes, timeline business events.
  updateMeeting: (metaId, fields) =>
    request(`/meetings/${metaId}/`, { method: "PATCH", body: JSON.stringify(fields) }),
  getNotes: (topicId) => request(`/topics/${topicId}/notes/`),
  addNote: (topicId, text, metaId) =>
    request(`/topics/${topicId}/notes/`, {
      method: "POST",
      body: JSON.stringify(metaId ? { text, meta: metaId } : { text }),
    }),
  deleteNote: (topicId, noteId) => request(`/topics/${topicId}/notes/${noteId}/`, { method: "DELETE" }),
  getTimelineEvents: (topicId) => request(`/topics/${topicId}/timeline_events/`),
  // Plain download link (the browser sends the session cookie itself).
  metadataCsvUrl: (topicId) => `${API_BASE}/topics/${topicId}/metadata_csv/`,
  // AI Context Brief (CaseSummary) - the persisted "current state / next
  // step" panel on a topic's own page.
  getLatestSummary: (topicId) => request(`/topics/${topicId}/latest_summary/`),
  // question is optional - lets the Smart Suggestions preset buttons
  // ("Catch me up", "What's changed?", "Prepare me for next meeting")
  // regenerate the same on-page brief with a differently-focused question,
  // falling back to the backend's own fixed CONTEXT_BRIEF_QUESTION when absent.
  refreshSummary: (topicId, question) =>
    request(`/topics/${topicId}/refresh_summary/`, {
      method: "POST",
      body: JSON.stringify(question ? { question } : {}),
    }),
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
  // Both need the settings password, like any other change to Settings.
  requestConnector: (slug, settingsPassword) =>
    request(`/connectors/${slug}/request/`, { method: "POST", body: JSON.stringify({ settings_password: settingsPassword }) }),
  resetConnector: (slug, settingsPassword) =>
    request(`/connectors/${slug}/reset/`, { method: "POST", body: JSON.stringify({ settings_password: settingsPassword }) }),
  // Universal search (Ctrl/Cmd+K).
  search: (q) => request(`/search/?q=${encodeURIComponent(q)}`),
  // Fire-and-forget: records one search outcome (a pick, or "gave up with
  // no pick") for later review in Django admin - see SearchLog/SearchLogView.
  // Never awaited by the caller for its result; a logging failure must
  // never block or break the search UI itself.
  logSearchOutcome: (payload) =>
    request(`/search/log/`, { method: "POST", body: JSON.stringify(payload) }),
  // Cross-project library/feed - every ingested file, and a merged activity
  // feed (meetings/status updates/tasks), across every project at once.
  getAllSources: (topicId) => request(`/sources/${topicId ? `?topic_id=${topicId}` : ""}`),
  getGlobalTimeline: (topicId) => request(`/timeline/${topicId ? `?topic_id=${topicId}` : ""}`),
  // Auth - real Django sessions, one shared login (sign-up and email password
  // reset are switched off on the backend). primeCsrf() must be
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
