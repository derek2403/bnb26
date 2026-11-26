"use client";
import { useEffect, useState } from "react";

export const THEME_SCRIPT = `(function(){try{var t=localStorage.getItem('splitstock.theme');var d=t?t==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;if(d)document.documentElement.classList.add('dark');}catch(e){}})();`;

export function ThemeToggle() {
  const [dark, setDark] = useState(false);
  useEffect(() => setDark(document.documentElement.classList.contains("dark")), []);
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle("dark", next);
    try {
      localStorage.setItem("splitstock.theme", next ? "dark" : "light");
    } catch {
      /* ignore */
    }
  };
  return (
    <button className="btn btn-sm" onClick={toggle} aria-label="Toggle dark mode" title="Toggle theme">
      {dark ? "☀" : "☾"}
    </button>
  );
}
