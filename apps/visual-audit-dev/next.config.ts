import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@mangekyo/visual-audit", "@mangekyo/contracts"],
};

export default nextConfig;
