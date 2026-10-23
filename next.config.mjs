/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep the dev watcher and production build from writing the same cache.
  // next dev runs with NODE_ENV=development, build/start with production.
  distDir: process.env.NEXT_DIST_DIR || (process.env.NODE_ENV === "development" ? ".next-dev" : ".next-build")
};

export default nextConfig;
