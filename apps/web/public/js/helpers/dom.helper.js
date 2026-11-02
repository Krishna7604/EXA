// DOM helpers: a querySelector shorthand and a tiny element builder.

// ---------- dom ----------
/** First element matching `sel`. */
export const $ = (sel) => document.querySelector(sel);

/**
 * Create an element. `class` sets className, `on*` attributes add listeners, `true` renders an
 * empty attribute and null/undefined/false skip it. Children may be nodes, strings or arrays.
 */
export function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) setAttr(n, k, v);
  for (const k of kids.flat()) {
    if (k === null || k === undefined || k === false) continue;
    n.append(k instanceof Node ? k : document.createTextNode(String(k)));
  }
  return n;
}

// ---------- helpers ----------
function setAttr(n, k, v) {
  if (k === "class") n.className = v;
  else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
  else if (v !== undefined && v !== null && v !== false) n.setAttribute(k, v === true ? "" : v);
}
