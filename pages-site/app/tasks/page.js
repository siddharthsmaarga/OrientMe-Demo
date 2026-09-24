"use client";

import { useEffect, useState } from "react";
import { api } from "../lib/api";
import TaskBoard from "../components/TaskBoard";
import CalendarWidget from "../components/CalendarWidget";

// "Board" in the sidebar - a project picker filters the same Kanban board +
// calendar down to one project at a time, or "All projects" for the merged
// view across every project. Board and calendar only - no chatbox anywhere
// in this app (removed per direct product feedback - see app/page.js).
export default function TasksPage() {
  const [topics, setTopics] = useState([]);
  const [selectedTopicId, setSelectedTopicId] = useState("");
  const [tasks, setTasks] = useState([]);
  const [calendarEvents, setCalendarEvents] = useState([]);
  const [error, setError] = useState(null);
  const [refreshing, setRefreshing] = useState(false);

  async function handleRefresh() {
    setRefreshing(true);
    await Promise.all([loadTasks(selectedTopicId), loadCalendar(selectedTopicId)]);
    setRefreshing(false);
  }

  async function loadTasks(topicId) {
    try {
      setTasks(await api.getTasks(topicId || undefined));
      setError(null);
    } catch (e) {
      setError(e.message);
    }
  }

  async function loadCalendar(topicId) {
    try {
      setCalendarEvents(await api.getCalendar(topicId || undefined));
    } catch (e) {
      console.error("Could not load calendar:", e.message);
    }
  }

  useEffect(() => {
    api.listTopics().then(setTopics).catch(() => setTopics([]));
  }, []);

  useEffect(() => {
    loadTasks(selectedTopicId);
    loadCalendar(selectedTopicId);
    // Keep this page live while it's open - a scan/upload/import started
    // from a project's own page (or another tab) writes new tasks straight
    // to the database, but this page has no other way to know that unless
    // it asks again. Polling here closes that gap without needing a
    // websocket for something this infrequent.
    const interval = setInterval(() => {
      loadTasks(selectedTopicId);
      loadCalendar(selectedTopicId);
    }, 5000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTopicId]);

  async function handleStatusChange(taskId, status) {
    setTasks((ts) => ts.map((t) => (t.id === taskId ? { ...t, status } : t)));
    try {
      await api.updateTaskStatus(taskId, status);
      loadCalendar(selectedTopicId);
    } catch (e) {
      setError(e.message);
      loadTasks(selectedTopicId);
    }
  }

  async function handleDueDateChange(taskId, dueDate) {
    setTasks((ts) => ts.map((t) => (t.id === taskId ? { ...t, due_date: dueDate || null } : t)));
    try {
      await api.updateTaskDueDate(taskId, dueDate);
      loadCalendar(selectedTopicId);
    } catch (e) {
      setError(e.message);
      loadTasks(selectedTopicId);
    }
  }

  return (
    <div className="max-w-6xl 2xl:max-w-[96rem] mx-auto px-6 py-10 w-full">
      <header className="mb-8 flex items-center justify-between flex-wrap gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Board</h1>
          <p className="text-slate-500 mt-1">
            Action items pulled automatically from meeting transcripts.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={selectedTopicId}
            onChange={(e) => setSelectedTopicId(e.target.value)}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm bg-white"
          >
            <option value="">All projects</option>
            {topics.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={handleRefresh}
            disabled={refreshing}
            title="Refresh now"
            className="px-3 py-2 text-sm rounded-md border border-slate-300 bg-white text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            {refreshing ? "Refreshing…" : "↻ Refresh"}
          </button>
        </div>
      </header>

      {error && <p className="text-red-600 text-sm mb-4">Error: {error}</p>}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start">
        <div className="lg:col-span-2">
          <section className="rounded-lg border border-slate-200 bg-white p-4">
            <TaskBoard
              tasks={tasks}
              onStatusChange={handleStatusChange}
              onDueDateChange={handleDueDateChange}
              showTopic={!selectedTopicId}
              emptyMessage={
                selectedTopicId
                  ? "No action items for this project yet — they're pulled automatically from meeting transcripts once ingested."
                  : "No action items anywhere yet — they're pulled automatically from meeting transcripts once ingested into a project."
              }
            />
          </section>
        </div>
        <CalendarWidget events={calendarEvents} />
      </div>
    </div>
  );
}
