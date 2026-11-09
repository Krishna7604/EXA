// A small popover menu anchored to a button. Closes on outside click, Escape or a choice.

import { el } from "../helpers/dom.helper.js";
import { icon } from "../helpers/icons.helper.js";

// ---------- constants ----------
const GAP_PX = 6;

let open = null;

// ---------- menu ----------
/**
 * `items`: `{ label, icon?, danger?, onSelect }`, `"-"` for a divider, or `{ meta: text }`.
 */
export function openMenu(anchor, items) {
  closeMenu();
  const menu = el("div", { class: "menu", role: "menu" }, ...items.map(menuItem));
  document.body.append(menu);
  place(menu, anchor);
  open = { menu, anchor };
  setTimeout(() => {
    document.addEventListener("click", onOutside);
    document.addEventListener("keydown", onKey);
  });
  menu.querySelector("button")?.focus();
}

export function closeMenu() {
  if (!open) return;
  open.menu.remove();
  open = null;
  document.removeEventListener("click", onOutside);
  document.removeEventListener("keydown", onKey);
}

// ---------- helpers ----------
function menuItem(item) {
  if (item === "-") return el("hr");
  if (item.meta) return el("div", { class: "menu-meta" }, item.meta);
  const onclick = () => {
    closeMenu();
    item.onSelect();
  };
  const cls = item.danger ? "danger" : "";
  return el(
    "button",
    { type: "button", role: "menuitem", class: cls, onclick },
    item.icon ? icon(item.icon, "sm") : null,
    item.label,
  );
}

/** Below the anchor, right-aligned to it, kept inside the viewport. */
function place(menu, anchor) {
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth;
  const left = Math.max(8, Math.min(r.right - w, innerWidth - w - 8));
  const below = r.bottom + GAP_PX + menu.offsetHeight < innerHeight;
  const top = below ? r.bottom + GAP_PX : r.top - GAP_PX - menu.offsetHeight;
  menu.style.left = `${left + scrollX}px`;
  menu.style.top = `${Math.max(8, top) + scrollY}px`;
}

function onOutside(e) {
  if (open && !open.menu.contains(e.target)) closeMenu();
}

function onKey(e) {
  if (e.key === "Escape") closeMenu();
}
