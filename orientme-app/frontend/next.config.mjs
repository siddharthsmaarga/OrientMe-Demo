/** @type {import('next').NextConfig} */
const nextConfig = {
  // Raycast/Edge open this app via a 127.0.0.1-based URL - without this,
  // Next dev's own cross-origin guard silently blocks HMR/RSC requests from
  // that host and the page hangs on "Loading..." forever (see frontend_err.log).
  allowedDevOrigins: ["127.0.0.1", "localhost"],
};

export default nextConfig;
