/**
 * Minimal Markdown → HTML for product docs.
 * Doc links: [Market](doc:market)
 * Fenced `flow` blocks render simple container → arrow diagrams.
 * `##` headings get stable ids for the docs sidebar sub-nav.
 */
(function (global) {
  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function inlineFormat(text) {
    let s = escapeHtml(text);
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(
      /\[([^\]]+)\]\(doc:([a-z0-9-]+)\)/gi,
      '<a href="#doc:$2" data-doc-link="$2">$1</a>',
    );
    s = s.replace(
      /\[([^\]]+)\]\((https?:[^)\s]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>',
    );
    return s;
  }

  function renderTable(rows) {
    if (!rows.length) return "";
    const header = rows[0];
    const body = rows.slice(1).filter((r) => !r.every((c) => /^:?-+:?$/.test(c.trim())));
    let html = "<table><thead><tr>";
    for (const cell of header) html += `<th>${inlineFormat(cell.trim())}</th>`;
    html += "</tr></thead><tbody>";
    for (const row of body) {
      html += "<tr>";
      for (const cell of row) html += `<td>${inlineFormat(cell.trim())}</td>`;
      html += "</tr>";
    }
    html += "</tbody></table>";
    return html;
  }

  function parseTableRow(line) {
    const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
    return trimmed.split("|").map((c) => c.trim());
  }

  function renderFlowBlock(lines) {
    const rows = [];
    let title = "";
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("# ")) {
        title = line.slice(2).trim();
        continue;
      }
      const parts = line
        .split(/\s*(?:->|→|>)\s*/)
        .map((p) => p.trim())
        .filter(Boolean);
      if (parts.length < 2) continue;
      const cells = [];
      parts.forEach((part, idx) => {
        if (idx > 0) {
          cells.push('<span class="docs-flow-arrow" aria-hidden="true">→</span>');
        }
        const kind = /sse|rest|ws|web ?socket/i.test(part)
          ? "docs-flow-box docs-flow-box--channel"
          : "docs-flow-box";
        cells.push(`<div class="${kind}">${escapeHtml(part)}</div>`);
      });
      rows.push(`<div class="docs-flow-row">${cells.join("")}</div>`);
    }
    if (!rows.length) return "";
    const caption = title
      ? `<figcaption class="docs-flow-title">${escapeHtml(title)}</figcaption>`
      : "";
    return `<figure class="docs-flow">${caption}<div class="docs-flow-body">${rows.join("")}</div></figure>`;
  }

  function slugifyHeading(text) {
    return String(text || "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "section";
  }

  function markdownToHtml(md) {
    const lines = String(md || "").replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let i = 0;
    let inCode = false;
    let codeLang = "";
    let codeLines = [];
    let listType = null;
    let listItems = [];
    let inSection = false;
    const usedIds = Object.create(null);

    function uniqueHeadingId(title) {
      const base = slugifyHeading(title);
      if (!usedIds[base]) {
        usedIds[base] = 1;
        return base;
      }
      usedIds[base] += 1;
      return `${base}-${usedIds[base]}`;
    }

    function closeSection() {
      if (!inSection) return;
      out.push("</div></section>");
      inSection = false;
    }

    function openSection(id, titleHtml) {
      closeSection();
      out.push(
        `<section class="auth-docs-section">` +
          `<h2 id="${id}">${titleHtml}</h2>` +
          `<div class="auth-docs-section-body">`,
      );
      inSection = true;
    }

    function flushList() {
      if (!listType) return;
      const tag = listType;
      out.push(`<${tag}>${listItems.map((item) => `<li>${inlineFormat(item)}</li>`).join("")}</${tag}>`);
      listType = null;
      listItems = [];
    }

    function flushCode() {
      if (!inCode) return;
      if (codeLang === "flow") {
        out.push(renderFlowBlock(codeLines));
      } else {
        out.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
      }
      inCode = false;
      codeLang = "";
      codeLines = [];
    }

    while (i < lines.length) {
      const line = lines[i];

      if (line.startsWith("```")) {
        if (inCode) {
          flushCode();
        } else {
          flushList();
          inCode = true;
          codeLang = line.slice(3).trim().toLowerCase();
          codeLines = [];
        }
        i += 1;
        continue;
      }

      if (inCode) {
        codeLines.push(line);
        i += 1;
        continue;
      }

      if (/^\|.+\|/.test(line.trim()) && i + 1 < lines.length && /^\|?\s*:?-+:?\s*\|/.test(lines[i + 1].trim())) {
        flushList();
        const rows = [];
        while (i < lines.length && /^\|.+\|/.test(lines[i].trim())) {
          rows.push(parseTableRow(lines[i]));
          i += 1;
        }
        out.push(renderTable(rows));
        continue;
      }

      if (/^---+$/.test(line.trim())) {
        flushList();
        out.push("<hr />");
        i += 1;
        continue;
      }

      const heading = /^(#{1,3})\s+(.+)$/.exec(line);
      if (heading) {
        flushList();
        const level = heading[1].length;
        const title = heading[2].trim();
        const titleHtml = inlineFormat(title);
        if (level === 1) {
          closeSection();
          out.push(`<h1>${titleHtml}</h1>`);
        } else if (level === 2) {
          // ## sections wrap body content for sidebar hover + visual separation.
          openSection(uniqueHeadingId(title), titleHtml);
        } else {
          out.push(`<h${level}>${titleHtml}</h${level}>`);
        }
        i += 1;
        continue;
      }

      const ul = /^[-*]\s+(.+)$/.exec(line);
      if (ul) {
        if (listType && listType !== "ul") flushList();
        listType = "ul";
        listItems.push(ul[1]);
        i += 1;
        continue;
      }

      const ol = /^(\d+)\.\s+(.+)$/.exec(line);
      if (ol) {
        if (listType && listType !== "ol") flushList();
        listType = "ol";
        listItems.push(ol[2]);
        i += 1;
        continue;
      }

      if (!line.trim()) {
        flushList();
        i += 1;
        continue;
      }

      flushList();
      out.push(`<p>${inlineFormat(line.trim())}</p>`);
      i += 1;
    }

    flushList();
    flushCode();
    closeSection();
    return out.join("\n");
  }

  global.markdownToHtml = markdownToHtml;
  global.slugifyDocHeading = slugifyHeading;
})(typeof window !== "undefined" ? window : globalThis);
