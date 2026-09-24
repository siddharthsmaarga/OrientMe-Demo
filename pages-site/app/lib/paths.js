// Return an exported topic route. User-created IDs are selected in the hash
// so GitHub Pages can serve the single pre-rendered topic detail page.
export function topicHref(topicId) {
  const id = String(topicId);
  if (id === "demo") return "/topics/demo/";
  return `/topics/demo/#project=${encodeURIComponent(id)}`;
}
