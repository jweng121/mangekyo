import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: ["@mangekyo/finance-core", "@mangekyo/contracts"],
};
export default nextConfig;
