export type MarkdownPart = Readonly<{ kind: "markdown" | "html"; text: string; offset: number }>;

const HTML_FENCE_HINT = /^ {0,3}(?:`{3,}|~{3,})[ \t]*html\b/im;

/** Split closed, top-level ```html fences out of Markdown. An unclosed fence
 * (still streaming) stays an ordinary code block, so no preview runs until the
 * whole document has arrived; earlier part offsets are stable as text appends. */
export function splitHtmlFences(markdown: string): readonly MarkdownPart[] {
  if (!HTML_FENCE_HINT.test(markdown)) return [{ kind: "markdown", text: markdown, offset: 0 }];
  const parts: MarkdownPart[] = [];
  let fence: { marker: string; length: number; start: number; content: number; html: boolean } | undefined;
  let cursor = 0;
  let offset = 0;
  for (const line of markdown.match(/[^\n]*\n|[^\n]+$/g) ?? []) {
    const clean = line.replace(/\r?\n$/, "");
    if (fence) {
      const close = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(clean);
      if (close && close[1]![0] === fence.marker && close[1]!.length >= fence.length) {
        if (fence.html && /\S/.test(markdown.slice(fence.content, offset))) {
          if (fence.start > cursor) parts.push({ kind: "markdown", text: markdown.slice(cursor, fence.start), offset: cursor });
          parts.push({ kind: "html", text: markdown.slice(fence.content, offset).replace(/\r?\n$/, ""), offset: fence.start });
          cursor = offset + line.length;
        }
        fence = undefined;
      }
    } else {
      const open = /^ {0,3}(`{3,}|~{3,})([^\r\n]*)$/.exec(clean);
      if (open && !(open[1]![0] === "`" && open[2]!.includes("`"))) {
        const info = open[2]!.trim().split(/\s+/, 1)[0]!.toLowerCase();
        fence = { marker: open[1]![0]!, length: open[1]!.length, start: offset, content: offset + line.length, html: info === "html" };
      }
    }
    offset += line.length;
  }
  if (cursor < markdown.length || parts.length === 0) parts.push({ kind: "markdown", text: markdown.slice(cursor), offset: cursor });
  return parts;
}

/** No network, frames, forms or base rewriting: the preview can compute and
 * draw, but cannot load or send anything. Policies only ever add restrictions,
 * so author markup cannot relax it. */
export const HTML_PREVIEW_CSP = [
  "default-src 'none'", "script-src 'unsafe-inline'", "style-src 'unsafe-inline'",
  "img-src data: blob:", "font-src data:", "media-src data: blob:", "connect-src 'none'",
  "frame-src 'none'", "worker-src 'none'", "object-src 'none'", "base-uri 'none'", "form-action 'none'",
].join("; ");

/** Bridge installed before author scripts. It reports content height and
 * forwards link activation to the host using MCP Apps-style JSON-RPC
 * notifications; it never receives anything from the host. */
const BRIDGE = `(()=>{const post=(method,params)=>parent.postMessage({jsonrpc:"2.0",method,params},"*");let last=-1,queued=false;const measure=()=>{queued=false;const b=document.body;if(!b)return;const s=getComputedStyle(b);const h=Math.ceil(b.getBoundingClientRect().height+parseFloat(s.marginTop||"0")+parseFloat(s.marginBottom||"0"));if(h!==last){last=h;post("ui/notifications/size-changed",{height:h})}};const schedule=()=>{if(!queued){queued=true;requestAnimationFrame(measure)}};addEventListener("DOMContentLoaded",()=>{try{new ResizeObserver(schedule).observe(document.body)}catch{}schedule()});addEventListener("load",schedule);addEventListener("click",e=>{const a=e.target instanceof Element&&e.target.closest("a[href]");if(!a)return;const href=a.getAttribute("href")||"";if(href.startsWith("#"))return;e.preventDefault();post("ui/open-link",{url:a.href})},true);addEventListener("submit",e=>e.preventDefault(),true);addEventListener("keydown",e=>{if(e.key==="Escape")post("ui/notifications/escape",{})})})()`;

/** Reparse author HTML in an inert document, drop markup that could precede or
 * redirect the enforced policy, then serialize a fresh preview document. */
export function htmlPreviewDocument(html: string): string {
  const parsed = new DOMParser().parseFromString(html, "text/html");
  parsed.querySelectorAll("base, meta[http-equiv], iframe, frame, object, embed, portal").forEach(node => node.remove());
  const lang = parsed.documentElement.getAttribute("lang");
  return `<!doctype html><html${lang ? ` lang="${lang.replace(/[^A-Za-z0-9-]/g, "")}"` : ""}><head>`
    + `<meta http-equiv="Content-Security-Policy" content="${HTML_PREVIEW_CSP}">`
    + `<meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light dark">`
    + `<script>${BRIDGE}</script>`
    + `<style>html{height:auto}body{margin:8px;display:flow-root;font-family:system-ui,sans-serif;overflow-wrap:anywhere}</style>`
    + `${parsed.head.innerHTML}</head><body${attributes(parsed.body)}>${parsed.body.innerHTML}</body></html>`;
}

function attributes(element: HTMLElement): string {
  let result = "";
  for (const attribute of Array.from(element.attributes)) {
    if (!/^[a-z][a-z0-9-]*$/i.test(attribute.name)) continue;
    result += ` ${attribute.name}="${attribute.value.replace(/&/g, "&amp;").replace(/"/g, "&quot;")}"`;
  }
  return result;
}

const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

/** Decode an inline text/html generated file; remote files are never fetched. */
export function inlineHtmlFromDataUrl(url: string): string | undefined {
  const match = /^data:text\/html(?:;charset=([a-z0-9-]+))?(;base64)?,([\s\S]*)$/i.exec(url);
  if (!match || match[3]!.length > MAX_PREVIEW_BYTES * 2) return undefined;
  try {
    if (match[2]) {
      const binary = atob(match[3]!);
      const bytes = Uint8Array.from(binary, character => character.charCodeAt(0));
      return new TextDecoder(match[1] || "utf-8").decode(bytes);
    }
    return decodeURIComponent(match[3]!);
  } catch { return undefined; }
}
