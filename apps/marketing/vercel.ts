import type { VercelConfig } from "@vercel/config/v1";

export const config: VercelConfig = {
  installCommand: "npm install -g vite-plus && vp install --filter '@pulse/marketing'",
  buildCommand: "vp run --filter @pulse/marketing build",
  outputDirectory: "dist",
};
