/** @type {import('next').NextConfig} */
const isGitHubPagesBuild = process.env.GITHUB_PAGES === "true";

const nextConfig = {
  // GitHub Pages serves static files under the repository name. Local runs
  // keep the root path; the deploy workflow sets GITHUB_PAGES during export.
  ...(isGitHubPagesBuild ? { basePath: "/OrientMe-Demo" } : {}),
  env: {
    NEXT_PUBLIC_BASE_PATH: isGitHubPagesBuild ? "/OrientMe-Demo" : "",
  },
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
};

export default nextConfig;
