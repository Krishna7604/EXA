// localStorage wrapper that never throws (private windows and blocked storage fall back to null).

// ---------- storage ----------
export const TOKEN_KEY = "exa.token";
export const THEME_KEY = "exa.theme";

export const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  /** `null` removes the key. */
  set(k, v) {
    try {
      if (v === null) localStorage.removeItem(k);
      else localStorage.setItem(k, v);
    } catch {
      // storage unavailable: the value just won't survive a reload
    }
  },
};
