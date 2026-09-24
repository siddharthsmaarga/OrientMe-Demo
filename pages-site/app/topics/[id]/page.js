// Server component wrapper - generateStaticParams must run at build time on
// the server, which means it can't live in the same file as the "use
// client" page it's paired with (TopicDetailClient.js, everything this
// page actually renders). This file is deliberately thin.

import TopicDetailClient from "./TopicDetailClient";

// Static export needs to know every dynamic route to pre-render at build
// time - this demo has exactly one topic (see app/lib/dummyData.js).
export function generateStaticParams() {
  return [{ id: "demo" }];
}

export default function Page({ params }) {
  return <TopicDetailClient params={params} />;
}
