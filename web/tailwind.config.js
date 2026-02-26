/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        water:  "#38bdf8",
        fire:   "#f97316",
        earth:  "#eab308",
        metal:  "#a8a29e",
        wood:   "#4ade80",
      },
    },
  },
  plugins: [],
};
