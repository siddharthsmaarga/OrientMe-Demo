import { store } from "../../lib/fixtures";
import TranscriptDetailClient from "./TranscriptDetailClient";

// This is a static export (output: "export", see next.config.mjs) - there's
// no server to resolve /transcripts/<id> on demand, so every dynamic id
// must be known at build time. The rest of this demo works around dynamic
// segments entirely by using /topics/?id=... query params instead (see
// topics/page.js); this route needs a real path segment, so it pre-renders
// one page per fixture recordingEvents entry via generateStaticParams
// instead. All interactive logic lives in the client component below -
// generateStaticParams can only be exported from a (non-"use client")
// Server Component.
export function generateStaticParams() {
  return store.recordingEvents.map((ev) => ({ id: String(ev.id) }));
}

export default async function TranscriptDetailPage({ params }) {
  const { id } = await params;
  return <TranscriptDetailClient id={id} />;
}
