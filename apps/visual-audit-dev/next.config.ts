import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  distDir: process.env.MANGEKYO_NEXT_DIST_DIR ?? ".next",
  transpilePackages: ["@mangekyo/visual-audit", "@mangekyo/contracts"],
};

export default nextConfig;
