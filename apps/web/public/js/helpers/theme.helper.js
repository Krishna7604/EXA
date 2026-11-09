// Light / dark / system theme: stored per browser, applied as `data-theme` on <html> (the CSS
// tokens follow the OS preference when no explicit theme is set).

import { store, THEME_KEY } from "./storage.helper.js";

// ---------- constants ----------
const THEMES = ["system", "light", "dark"];
const DARK_QUERY = "(prefers-color-scheme: dark)";

// ---------- theme ----------
export function savedTheme() {
  const t = store.get(THEME_KEY);
  return THEMES.includes(t) ? t : "system";
}

export function applyTheme(theme = savedTheme()) {
  const root = document.documentElement;
  if (theme === "system") delete root.dataset.theme;
  else root.dataset.theme = theme;
  store.set(THEME_KEY, theme === "system" ? null : theme);
}

/** The theme actually showing ("light" or "dark"). */
export function effectiveTheme() {
  const t = savedTheme();
  if (t !== "system") return t;
  return matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

/** Flip between light and dark from whatever is showing now. */
export function toggleTheme() {
  applyTheme(effectiveTheme() === "dark" ? "light" : "dark");
}
