import type { Config } from "tailwindcss";

const v = (name: string) => `rgb(var(--${name}) / <alpha-value>)`;

export default {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg: v("bg"),
        surface: v("surface"),
        surface2: v("surface-2"),
        line: v("line"),
        ink: v("ink"),
        muted: v("muted"),
        faint: v("faint"),
        accent: v("accent"),
        stable: v("stable"), // blue = sUSD
        "stable-soft": v("stable-soft"),
        lever: v("lever"), // amber = xSTOCK
        "lever-soft": v("lever-soft"),
        good: v("good"), // price up
        warn: v("warn"),
        bad: v("bad"), // price down
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "sans-serif"],
        mono: ['"IBM Plex Mono"', "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
      borderRadius: { card: "6px" },
      fontSize: { "2xs": ["10px", "14px"] },
    },
  },
  plugins: [],
} satisfies Config;
