// Inline SVG icons (24px grid, 1.75 stroke, drawn with currentColor). `icon(name)` builds one;
// `hydrateIcons(root)` swaps every `<span data-icon="name">` placeholder in static HTML.

// ---------- constants ----------
const SVG_NS = "http://www.w3.org/2000/svg";

/** Path data per icon. Several paths are joined with "|". */
const PATHS = {
  chat: "M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z|M12 7v5l3 2",
  memory:
    "M12 5a3 3 0 0 0-5.8-1A3 3 0 0 0 4 8a3 3 0 0 0 .5 5.5A3 3 0 0 0 7 19a3 3 0 0 0 5 1|M12 5a3 3 0 0 1 5.8-1A3 3 0 0 1 20 8a3 3 0 0 1-.5 5.5A3 3 0 0 1 17 19a3 3 0 0 1-5 1|M12 5v15",
  plug: "M9 7V3|M15 7V3|M6 7h12v4a6 6 0 0 1-12 0V7z|M12 17v4",
  settings:
    "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z|M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z",
  plus: "M12 5v14|M5 12h14",
  search: "M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14z|M20 20l-3.5-3.5",
  send: "M12 19V5|M6 11l6-6 6 6",
  stop: "M7 7h10v10H7z",
  menu: "M4 7h16|M4 12h16|M4 17h16",
  more: "M5 12h.01|M12 12h.01|M19 12h.01",
  moon: "M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z",
  sun: "M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z|M12 2v2|M12 20v2|M4.9 4.9l1.4 1.4|M17.7 17.7l1.4 1.4|M2 12h2|M20 12h2|M4.9 19.1l1.4-1.4|M17.7 6.3l1.4-1.4",
  trash: "M4 7h16|M10 11v6|M14 11v6|M6 7l1 13h10l1-13|M9 7V4h6v3",
  edit: "M4 20h4L19 9l-4-4L4 16v4z|M14 6l4 4",
  play: "M8 5v14l11-7z",
  check: "M5 12.5l4.5 4.5L19 7.5",
  x: "M6 6l12 12|M18 6L6 18",
  chevron: "M9 6l6 6-6 6",
  copy: "M9 9h11v11H9z|M5 15H4V4h11v1",
  terminal: "M5 7l5 5-5 5|M12 18h7",
  alert:
    "M12 9v4|M12 17h.01|M10.3 3.9L2 18a2 2 0 0 0 1.7 3h16.6a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z",
  globe:
    "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18z|M3 12h18|M12 3a14 14 0 0 1 0 18|M12 3a14 14 0 0 0 0 18",
  pen: "M12 20h9|M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z",
  list: "M9 6h11|M9 12h11|M9 18h11|M4 6h.01|M4 12h.01|M4 18h.01",
  logout: "M9 21H5V3h4|M16 17l5-5-5-5|M21 12H9",
};

// ---------- icons ----------
/** An inline SVG icon; pass "sm" as `size` for the 15px version. */
export function icon(name, size = "") {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", size ? `icon ${size}` : "icon");
  for (const d of (PATHS[name] ?? "").split("|")) {
    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}

/** Replace `<span data-icon="…">` placeholders under `root` with real icons. */
export function hydrateIcons(root = document) {
  for (const slot of root.querySelectorAll("span[data-icon]")) {
    slot.replaceWith(icon(slot.dataset.icon));
  }
}
