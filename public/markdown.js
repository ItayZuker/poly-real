/**
 * Minimal Markdown → HTML for product docs (headings, lists, code, links, tables).
 * Not a full CommonMark implementation — enough for public/docs/*.md.
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
    s = s.replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
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

  function markdownToHtml(md) {
    const lines = String(md || "").replace(/\r\n/g, "\n").split("\n");
    const out = [];
    let i = 0;
    let inCode = false;
    let codeLang = "";
    let codeLines = [];
    let listType = null;
    let listItems = [];

    function flushList() {
      if (!listType) return;
      const tag = listType;
      out.push(`<${tag}>${listItems.map((item) => `<li>${inlineFormat(item)}</li>`).join("")}</${tag}>`);
      listType = null;
      listItems = [];
    }

    function flushCode() {
      if (!inCode) return;
      out.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
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
          codeLang = line.slice(3).trim();
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
        out.push(`<h${level}>${inlineFormat(heading[2].trim())}</h${level}>`);
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
    return out.join("\n");
  }

  global.markdownToHtml = markdownToHtml;
})(typeof window !== "undefined" ? window : globalThis);
