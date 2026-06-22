import { defineConfig } from "astro/config";

// Static site — fetches/computes at build time, deploys anywhere (Vercel, Netlify, GH Pages).
export default defineConfig({
  site: "https://regular-normal-guys.vercel.app",
  build: { format: "directory" },
});
