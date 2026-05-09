import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "vocab-pwa",
        short_name: "vocab-pwa",
        description: "Multi-section vocabulary review with FSRS scheduling.",
        theme_color: "#f7f4ed",
        background_color: "#f7f4ed",
        display: "standalone",
        icons: [
          {
            src: "/favicon.svg",
            sizes: "64x64",
            type: "image/svg+xml"
          }
        ]
      },
      workbox: {
        navigateFallbackDenylist: [/^\/api\//]
      }
    })
  ],
  server: {
    port: 5173
  }
});
