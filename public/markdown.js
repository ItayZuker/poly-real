/**
 * Minimal Markdown → HTML for product docs.
 * Doc links: [Market](doc:market)
 *
 * Visual demos reuse real app classes (non-interactive via .docs-demo).
 * Fenced language `demo`, one control per line:
 *   trade-toggle|Allow trade|on
 *   trade-size|10|shares
 *   modal-toggle|Optimize|off
 *   modal-input|Shares to buy|10
 *   modal-select|Gap vs PTB|with|None=none,Opposite=opposite,With=with
 *   modal-stack|Title|My setup
 *   modal-stack|Description|Notes|textarea
 *   page-toggle|Schedule|Heatmap|Schedule
 *   auth-buttons|Log in|Sign up
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

  function switchHtml(checked) {
    return (
      `<span class="switch">` +
      `<input type="checkbox" tabindex="-1"${checked ? " checked" : ""} />` +
      `<span class="switch-slider"></span>` +
      `</span>`
    );
  }

  function renderTradeToggle(label, on) {
    return (
      `<label class="wallet-control-field wallet-control-field--toggle">` +
      `<span class="wallet-control-label">${escapeHtml(label)}</span>` +
      switchHtml(on) +
      `</label>`
    );
  }

  function renderTradeSize(amount, unit) {
    const u = String(unit || "shares").toLowerCase() === "usdc" ? "usdc" : "shares";
    return (
      `<div class="wallet-control-field wallet-control-field--shares">` +
      `<span class="wallet-control-label">Size</span>` +
      `<div class="wallet-size-controls">` +
      `<select class="wallet-order-unit" tabindex="-1" aria-hidden="true">` +
      `<option value="shares"${u === "shares" ? " selected" : ""}>Shares</option>` +
      `<option value="usdc"${u === "usdc" ? " selected" : ""}>USDC</option>` +
      `</select>` +
      `<input type="number" class="wallet-shares-input" value="${escapeHtml(amount)}" tabindex="-1" readonly />` +
      `</div></div>`
    );
  }

  function renderModalToggle(label, on) {
    return (
      `<label class="modal-toggle">` +
      `<span>${escapeHtml(label)}</span>` +
      switchHtml(on) +
      `</label>`
    );
  }

  function renderModalInput(label, value) {
    const noneLike =
      /\bnone\b/i.test(label) ||
      /\boff\b/i.test(label) ||
      (String(value) === "0" && /gap|abort/i.test(label));
    const cls = noneLike ? "modal-field is-none" : "modal-field";
    return (
      `<label class="${cls}">` +
      `<span>${escapeHtml(label)}</span>` +
      `<input type="number" value="${escapeHtml(value)}" tabindex="-1" readonly />` +
      `</label>`
    );
  }

  function renderModalSelect(label, selected, optionsSpec) {
    const options = [];
    for (const raw of String(optionsSpec || "").split(",")) {
      const part = raw.trim();
      if (!part) continue;
      const eq = part.indexOf("=");
      if (eq > 0) {
        options.push({ label: part.slice(0, eq).trim(), value: part.slice(eq + 1).trim() });
      } else {
        options.push({ label: part, value: part.toLowerCase() });
      }
    }
    const sel = String(selected || "").toLowerCase();
    const opts = options
      .map((o) => {
        const isSel = o.value.toLowerCase() === sel || o.label.toLowerCase() === sel;
        return `<option value="${escapeHtml(o.value)}"${isSel ? " selected" : ""}>${escapeHtml(o.label)}</option>`;
      })
      .join("");
    return (
      `<label class="modal-field">` +
      `<span>${escapeHtml(label)}</span>` +
      `<select class="modal-select" tabindex="-1">${opts}</select>` +
      `</label>`
    );
  }

  function renderModalStack(label, value, kind) {
    const control =
      kind === "textarea"
        ? `<textarea rows="3" tabindex="-1" readonly>${escapeHtml(value)}</textarea>`
        : `<input type="text" value="${escapeHtml(value)}" tabindex="-1" readonly />`;
    return (
      `<label class="modal-field modal-field-stack">` +
      `<span>${escapeHtml(label)}</span>` +
      control +
      `</label>`
    );
  }

  function renderPageToggle(left, right, active) {
    const a = String(active || left);
    return (
      `<div class="page-toggle" role="group">` +
      `<button type="button" class="page-toggle-btn${a === left ? " is-active" : ""}" tabindex="-1">${escapeHtml(left)}</button>` +
      `<button type="button" class="page-toggle-btn${a === right ? " is-active" : ""}" tabindex="-1">${escapeHtml(right)}</button>` +
      `</div>`
    );
  }

  function renderSettingsField(label, value, mono) {
    const inputCls = mono
      ? "settings-field-input settings-field-mono"
      : "settings-field-input";
    return (
      `<div class="settings-field settings-field--wide">` +
      `<div class="settings-field-label-row">` +
      `<span class="settings-field-label">${escapeHtml(label)}</span>` +
      `</div>` +
      `<input type="text" class="${inputCls}" value="${escapeHtml(value)}" tabindex="-1" readonly />` +
      `</div>`
    );
  }

  function renderAuthButtons(primary, secondary) {
    return (
      `<div class="auth-cta-row">` +
      `<button type="button" class="auth-primary-btn" tabindex="-1">${escapeHtml(primary)}</button>` +
      (secondary
        ? `<button type="button" class="auth-secondary-btn" tabindex="-1">${escapeHtml(secondary)}</button>`
        : "") +
      `</div>`
    );
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

  function renderDemoBlock(lines) {
    const trade = [];
    const modal = [];
    const settings = [];
    const other = [];

    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const parts = line.split("|").map((p) => p.trim());
      const type = (parts[0] || "").toLowerCase();
      const on = String(parts[2] || "").toLowerCase() === "on";

      if (type === "trade-toggle" || type === "toggle") {
        trade.push(renderTradeToggle(parts[1] || "Toggle", on));
      } else if (type === "trade-size") {
        trade.push(renderTradeSize(parts[1] || "10", parts[2] || "shares"));
      } else if (type === "modal-toggle") {
        modal.push(renderModalToggle(parts[1] || "Toggle", on));
      } else if (type === "modal-input" || type === "input") {
        modal.push(renderModalInput(parts[1] || "Field", parts[2] || ""));
      } else if (type === "modal-select" || type === "select") {
        modal.push(renderModalSelect(parts[1] || "Select", parts[2], parts[3] || parts[2]));
      } else if (type === "modal-stack") {
        modal.push(renderModalStack(parts[1] || "Field", parts[2] || "", (parts[3] || "").toLowerCase()));
      } else if (type === "settings-field") {
        settings.push(
          renderSettingsField(parts[1] || "Field", parts[2] || "", String(parts[3] || "").toLowerCase() === "mono"),
        );
      } else if (type === "page-toggle") {
        other.push(renderPageToggle(parts[1] || "A", parts[2] || "B", parts[3] || parts[1]));
      } else if (type === "auth-buttons" || type === "button") {
        if (type === "auth-buttons") {
          other.push(renderAuthButtons(parts[1] || "Log in", parts[2] || ""));
        } else if (parts[2] === "secondary" || parts[2] === "primary") {
          other.push(
            parts[2] === "secondary"
              ? `<div class="auth-cta-row"><button type="button" class="auth-secondary-btn" tabindex="-1">${escapeHtml(parts[1] || "Button")}</button></div>`
              : `<div class="auth-cta-row"><button type="button" class="auth-primary-btn" tabindex="-1">${escapeHtml(parts[1] || "Button")}</button></div>`,
          );
        } else {
          other.push(renderAuthButtons(parts[1] || "Log in", parts[2] || "Sign up"));
        }
      }
    }

    const chunks = [];
    if (trade.length) {
      chunks.push(`<div class="wallet-control-fields docs-demo-trade">${trade.join("")}</div>`);
    }
    if (modal.length) {
      chunks.push(`<div class="modal-section docs-demo-modal">${modal.join("")}</div>`);
    }
    if (settings.length) {
      chunks.push(`<div class="settings-form-grid docs-demo-settings">${settings.join("")}</div>`);
    }
    chunks.push(...other);
    if (!chunks.length) return "";

    return (
      `<figure class="docs-demo" aria-label="Non-interactive example">` +
      `<figcaption class="docs-demo-caption">Example (not interactive)</figcaption>` +
      `<div class="docs-demo-body">${chunks.join("")}</div>` +
      `</figure>`
    );
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
      if (codeLang === "demo") {
        out.push(renderDemoBlock(codeLines));
      } else if (codeLang === "flow") {
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
