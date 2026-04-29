(() => {
  if (window.__macroRecorderInjected) return;
  window.__macroRecorderInjected = true;

  let isRecording = false;
  let isPaused = false;
  let hoveredElement = null;
  let selectedElement = null;
  let skipNextClick = false;
  let stepCount = 0;

  // --- "Select all similar" mode ---
  let selectSimilarMode = false;
  let similarElements = [];
  let similarHighlights = [];

  chrome.storage.local.get(['mrRecording', 'mrPaused', 'mrStepCount'], (data) => {
    if (data.mrRecording) {
      isRecording = true;
      isPaused = !!data.mrPaused;
      stepCount = data.mrStepCount || 0;
      showStatusBar();
      updateStatusBar();
    }
  });

  chrome.storage.onChanged.addListener((changes) => {
    if (changes.mrRecording) {
      isRecording = changes.mrRecording.newValue;
      if (isRecording) showStatusBar();
      else hideAll();
    }
    if (changes.mrPaused) {
      isPaused = changes.mrPaused.newValue;
      updateStatusBar();
    }
  });

  // --- UI Elements ---
  const highlight = document.createElement('div');
  highlight.id = 'macro-recorder-highlight';
  document.body.appendChild(highlight);

  const menu = document.createElement('div');
  menu.id = 'macro-recorder-menu';
  menu.innerHTML = `
    <button class="mr-menu-item" data-action="click">
      <span class="mr-icon">📌</span> Клик
    </button>
    <button class="mr-menu-item" data-action="type">
      <span class="mr-icon">✍️</span> Ввести текст
    </button>
    <div class="mr-text-input" id="mr-type-input">
      <input type="text" placeholder="Введите текст..." id="mr-type-value">
      <label style="display:flex;align-items:center;gap:4px;font-size:11px;margin-top:4px;color:#aaa"><input type="checkbox" id="mr-type-enter"> + Enter</label>
    </div>
    <button class="mr-menu-item" data-action="read">
      <span class="mr-icon">👁</span> Прочитать текст
    </button>
    <div class="mr-text-input" id="mr-read-input">
      <input type="text" placeholder="Имя переменной..." id="mr-read-varname">
    </div>
    <button class="mr-menu-item" data-action="wait">
      <span class="mr-icon">⏳</span> Ждать элемент
    </button>
    <button class="mr-menu-item" data-action="get-sms-code">
      <span class="mr-icon">📱</span> Получить SMS-код
    </button>
    <button class="mr-menu-item" data-action="user-input">
      <span class="mr-icon">💬</span> Запросить ввод
    </button>
    <div class="mr-menu-divider"></div>
    <button class="mr-menu-item mr-similar-btn" data-action="select-similar">
      <span class="mr-icon">🔁</span> Выбрать все похожие
    </button>
    <button class="mr-menu-item mr-real-click" data-action="real-click">
      <span class="mr-icon">👆</span> Настоящий клик (без записи)
    </button>
  `;
  document.body.appendChild(menu);

  // --- Similar elements confirmation panel ---
  const similarPanel = document.createElement('div');
  similarPanel.id = 'macro-recorder-similar-panel';
  similarPanel.innerHTML = `
    <div class="mr-similar-header">
      <span class="mr-similar-icon">🔁</span>
      <span id="mr-similar-count">0 похожих элементов</span>
    </div>
    <div class="mr-similar-selector" id="mr-similar-selector"></div>
    <div class="mr-similar-varname">
      <input type="text" placeholder="Переменная (опц.)" id="mr-similar-varname-input">
    </div>
    <div class="mr-similar-buttons">
      <button class="mr-similar-confirm" id="mr-similar-confirm">✅ Записать цикл</button>
      <button class="mr-similar-cancel" id="mr-similar-cancel">❌ Отмена</button>
    </div>
  `;
  similarPanel.style.display = 'none';
  document.body.appendChild(similarPanel);

  const statusBar = document.createElement('div');
  statusBar.id = 'macro-recorder-status';
  statusBar.innerHTML = `
    <div class="mr-status-dot"></div>
    <span id="mr-status-text">🔴 Запись</span>
    <span id="mr-step-count">0 шагов</span>
    <button class="mr-status-btn" id="mr-pause-btn">⏸ Пауза</button>
    <button class="mr-status-btn" id="mr-stop-btn">⏹ Стоп</button>
  `;
  document.body.appendChild(statusBar);

  // --- Styles for similar elements ---
  const styleEl = document.createElement('style');
  styleEl.textContent = `
    .mr-similar-highlight {
      position: fixed;
      pointer-events: none;
      border: 2px solid #a6e3a1;
      background: rgba(166, 227, 161, 0.15);
      border-radius: 4px;
      z-index: 2147483643;
      transition: all 0.15s;
    }
    #macro-recorder-similar-panel {
      position: fixed;
      bottom: 80px;
      right: 20px;
      background: #1e1e2e;
      border: 2px solid #a6e3a1;
      border-radius: 12px;
      padding: 16px;
      z-index: 2147483646;
      font-family: -apple-system, BlinkMacSystemFont, sans-serif;
      color: #cdd6f4;
      min-width: 280px;
      box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    }
    .mr-similar-header { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }
    .mr-similar-icon { font-size: 24px; }
    #mr-similar-count { font-size: 16px; font-weight: 700; }
    .mr-similar-selector {
      font-family: monospace; font-size: 11px; color: #a6adc8;
      background: #313244; padding: 6px 10px; border-radius: 6px;
      margin-bottom: 10px; word-break: break-all;
    }
    .mr-similar-varname { margin-bottom: 10px; }
    .mr-similar-varname input {
      width: 100%; padding: 6px 10px; background: #313244; border: 1px solid #45475a;
      color: #cdd6f4; border-radius: 6px; font-size: 13px; outline: none;
    }
    .mr-similar-buttons { display: flex; gap: 8px; }
    .mr-similar-confirm, .mr-similar-cancel {
      flex: 1; padding: 8px; border: none; border-radius: 8px;
      font-size: 13px; font-weight: 700; cursor: pointer;
    }
    .mr-similar-confirm { background: #a6e3a1; color: #1e1e2e; }
    .mr-similar-cancel { background: #45475a; color: #cdd6f4; }
    .mr-similar-confirm:hover { opacity: 0.85; }
    .mr-similar-cancel:hover { background: #6c7086; }
    .mr-menu-item.mr-similar-btn { border-top: 1px solid #45475a; color: #a6e3a1; }
  `;
  document.head.appendChild(styleEl);

  function showStatusBar() { statusBar.style.display = 'flex'; }

  function hideAll() {
    statusBar.style.display = 'none';
    highlight.style.display = 'none';
    hideMenu();
    hideSimilarMode();
  }

  function updateStatusBar() {
    const btn = document.getElementById('mr-pause-btn');
    const dot = statusBar.querySelector('.mr-status-dot');
    const text = document.getElementById('mr-status-text');
    const countEl = document.getElementById('mr-step-count');
    if (isPaused) {
      btn.textContent = '▶ Продолжить';
      dot.classList.add('paused');
      text.textContent = '⏸ Пауза';
      highlight.style.display = 'none';
    } else {
      btn.textContent = '⏸ Пауза';
      dot.classList.remove('paused');
      text.textContent = '🔴 Запись';
    }
    countEl.textContent = `${stepCount} шагов`;
  }

  // --- Drag status bar ---
  let isDragging = false, dragOffsetX, dragOffsetY;
  statusBar.addEventListener('mousedown', (e) => {
    if (e.target.classList.contains('mr-status-btn')) return;
    isDragging = true;
    dragOffsetX = e.clientX - statusBar.offsetLeft;
    dragOffsetY = e.clientY - statusBar.offsetTop;
  });
  document.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    statusBar.style.left = (e.clientX - dragOffsetX) + 'px';
    statusBar.style.top = (e.clientY - dragOffsetY) + 'px';
    statusBar.style.right = 'auto';
  });
  document.addEventListener('mouseup', () => isDragging = false);

  // --- Selectors ---
  function getSelector(el) {
    if (el.id) return `#${CSS.escape(el.id)}`;
    const attrs = ['data-testid', 'data-id', 'name', 'aria-label'];
    for (const attr of attrs) {
      const val = el.getAttribute(attr);
      if (val) return `[${attr}="${CSS.escape(val)}"]`;
    }
    const path = [];
    let current = el;
    while (current && current !== document.body) {
      let seg = current.tagName.toLowerCase();
      if (current.id) { seg = `#${CSS.escape(current.id)}`; path.unshift(seg); break; }
      const parent = current.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children).filter(c => c.tagName === current.tagName);
        if (siblings.length > 1) {
          const idx = siblings.indexOf(current) + 1;
          seg += `:nth-of-type(${idx})`;
        }
      }
      path.unshift(seg);
      current = current.parentElement;
    }
    return path.join(' > ');
  }

  // Generate a GENERAL selector that matches ALL similar elements
  // within the SAME section/container as the clicked element.
  // Key idea: find the nearest ancestor that acts as a "section boundary"
  // (scopes down the results vs global), then use its UNIQUE selector + descendant pattern.
  function getGeneralSelector(el) {
    if (!el.parentElement) return getSelector(el);

    const tag = el.tagName.toLowerCase();
    const classes = Array.from(el.classList).filter(c =>
      !c.startsWith('macro-recorder') && !c.startsWith('mr-')
    );
    const role = el.getAttribute('role');

    // Build element "signature" (tag + classes or tag + role) — no nth-child
    function buildElSelector() {
      if (classes.length > 0) {
        return tag + classes.map(c => `.${CSS.escape(c)}`).join('');
      }
      if (role) {
        return `${tag}[role="${role}"]`;
      }
      return tag;
    }
    const elSig = buildElSelector();

    // Count how many elements globally match this signature
    let globalCount = 0;
    try { globalCount = document.querySelectorAll(elSig).length; } catch(e) {}

    // Get a UNIQUE selector for an ancestor (with nth-of-type if needed)
    // This ensures we scope to exactly ONE container
    function getUniqueAncestorSelector(anc) {
      // ID is always unique
      if (anc.id) return `#${CSS.escape(anc.id)}`;
      // data attributes
      const attrs = ['data-testid', 'data-id', 'data-peer-id', 'name'];
      for (const attr of attrs) {
        const val = anc.getAttribute(attr);
        if (val) return `${anc.tagName.toLowerCase()}[${attr}="${CSS.escape(val)}"]`;
      }
      // Build tag+classes selector
      const ancTag = anc.tagName.toLowerCase();
      const ancClasses = Array.from(anc.classList).filter(c =>
        !c.startsWith('macro-recorder') && !c.startsWith('mr-')
      );
      let ancSig = ancTag;
      if (ancClasses.length > 0) {
        ancSig = ancTag + ancClasses.map(c => `.${CSS.escape(c)}`).join('');
      }
      // Check if this selector is unique on the page
      try {
        const ancMatches = document.querySelectorAll(ancSig);
        if (ancMatches.length === 1) return ancSig;
        // Not unique → add nth-child to make it unique
        // NOTE: nth-of-type counts by TAG NAME, not by class!
        // So div.search-section:nth-of-type(2) = 2nd <div>, NOT 2nd .search-section
        // Use nth-child instead which counts ALL siblings regardless of tag
        if (ancMatches.length > 1 && anc.parentElement) {
          const allChildren = Array.from(anc.parentElement.children);
          const childIdx = allChildren.indexOf(anc) + 1;
          return `${ancSig}:nth-child(${childIdx})`;
        }
      } catch(e) {}
      return ancSig;
    }

    // Also get a NON-unique (generic) selector for an ancestor
    function getGenericAncestorSelector(anc) {
      if (anc.id) return `#${CSS.escape(anc.id)}`;
      const ancTag = anc.tagName.toLowerCase();
      const ancClasses = Array.from(anc.classList).filter(c =>
        !c.startsWith('macro-recorder') && !c.startsWith('mr-')
      );
      if (ancClasses.length > 0) {
        return ancTag + ancClasses.map(c => `.${CSS.escape(c)}`).join('');
      }
      return ancTag;
    }

    // Walk up the DOM to find the best scoping container
    // STRATEGY: find the SMALLEST ancestor that contains >1 match but FEWER than global
    // This ensures we stay within the correct section (e.g., "Global Search" not "Chats & Contacts")
    let best = null;
    let current = el.parentElement;
    let prevCount = 1;
    for (let depth = 0; depth < 15 && current && current !== document.body; depth++) {
      // Count how many elSig elements are INSIDE this ancestor
      let localCount = 0;
      try {
        localCount = current.querySelectorAll(elSig).length;
      } catch(e) {}

      if (localCount > 1) {
        // Check if this ancestor is a section boundary:
        // - Contains multiple matches (localCount > 1)
        // - BUT fewer than the NEXT ancestor up (scoping down)
        // - OR fewer than global count
        const isSection = localCount < globalCount;

        // AGGRESSIVE SCOPING: prefer the SMALLEST container that has >1 match
        // This is the key fix for Telegram — the first ancestor with >1 match
        // at depth 0-3 is likely the correct section
        if (isSection || depth <= 3) {
          const uniqueAncSel = getUniqueAncestorSelector(current);
          const candidate = `${uniqueAncSel} ${elSig}`;
          try {
            const matches = document.querySelectorAll(candidate);
            if (matches.length > 1 && matches.length === localCount) {
              // If we already have a result and this one is BIGGER, prefer the smaller one
              if (!best || (isSection && !best.scoped) || (isSection && matches.length < best.count)) {
                best = { selector: candidate, count: matches.length, scoped: isSection };
              }
              // If this is a scoped section, stop — don't go wider
              if (isSection) break;
            }
          } catch(e) {}
        }

        // Also try generic (non-unique) selector — useful when there's only one section
        if (!best || !best.scoped) {
          const genAncSel = getGenericAncestorSelector(current);
          const candidateGen = `${genAncSel} ${elSig}`;
          try {
            const matchesGen = document.querySelectorAll(candidateGen);
            // Only use generic if it matches the same count as local (no extra elements)
            if (matchesGen.length === localCount && matchesGen.length > 1) {
              if (!best) {
                best = { selector: candidateGen, count: matchesGen.length, scoped: false };
              }
            }
          } catch(e) {}
        }
      }

      // If the element itself (elSig) has siblings at this level, also try direct child
      if (localCount <= 1 && depth === 0) {
        // Element is unique under direct parent — try parent's sibling pattern
        const parentClasses = Array.from(current.classList).filter(c =>
          !c.startsWith('macro-recorder') && !c.startsWith('mr-')
        );
        if (parentClasses.length > 0) {
          const parentSig = current.tagName.toLowerCase() +
            parentClasses.map(c => `.${CSS.escape(c)}`).join('');
          try {
            const parentMatches = document.querySelectorAll(parentSig);
            if (parentMatches.length > 1) {
              // The PARENT is the repeated element (e.g., ListItem is repeated)
              // Check if we need to scope to a section
              const grandParent = current.parentElement;
              if (grandParent && grandParent !== document.body) {
                const gpLocal = grandParent.querySelectorAll(parentSig).length;
                if (gpLocal < parentMatches.length) {
                  // Scope to grandparent
                  const gpSel = getUniqueAncestorSelector(grandParent);
                  const candidate = `${gpSel} ${parentSig}`;
                  try {
                    const cm = document.querySelectorAll(candidate);
                    if (cm.length > 1 && cm.length === gpLocal) {
                      best = { selector: candidate, count: cm.length, scoped: true };
                    }
                  } catch(e) {}
                }
                if (!best) {
                  best = { selector: parentSig, count: parentMatches.length, scoped: false };
                }
              } else {
                best = { selector: parentSig, count: parentMatches.length, scoped: false };
              }
            }
          } catch(e) {}
        }
      }

      current = current.parentElement;
    }

    if (best) return best.selector;

    // Last resort: try element signature globally if count is reasonable
    if (globalCount > 1 && globalCount <= 50) return elSig;

    // Fallback: specific selector
    return getSelector(el);
  }

  function getXPath(el) {
    const parts = [];
    let current = el;
    while (current && current.nodeType === 1) {
      let idx = 0;
      let sibling = current.previousSibling;
      while (sibling) {
        if (sibling.nodeType === 1 && sibling.tagName === current.tagName) idx++;
        sibling = sibling.previousSibling;
      }
      parts.unshift(idx > 0 ? `${current.tagName.toLowerCase()}[${idx + 1}]` : current.tagName.toLowerCase());
      current = current.parentElement;
    }
    return '/' + parts.join('/');
  }

  function getElementInfo(el) {
    const rect = el.getBoundingClientRect();
    return {
      cssSelector: getSelector(el),
      xpath: getXPath(el),
      tagName: el.tagName.toLowerCase(),
      textContent: (el.textContent || '').trim().substring(0, 200),
      innerText: (el.innerText || '').trim().substring(0, 200),
      placeholder: el.getAttribute('placeholder') || '',
      className: el.className || '',
      rect: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      url: window.location.href,
      timestamp: Date.now()
    };
  }

  function highlightEl(el) {
    if (!el || el.id?.startsWith('macro-recorder')) return;
    const rect = el.getBoundingClientRect();
    highlight.style.display = 'block';
    highlight.style.left = rect.left + 'px';
    highlight.style.top = rect.top + 'px';
    highlight.style.width = rect.width + 'px';
    highlight.style.height = rect.height + 'px';
  }

  function showMenu(el, x, y) {
    selectedElement = el;
    menu.style.display = 'block';
    let left = x + 10, top = y + 10;
    if (left + 220 > window.innerWidth) left = x - 220;
    if (top + 350 > window.innerHeight) top = y - 350;
    menu.style.left = Math.max(5, left) + 'px';
    menu.style.top = Math.max(5, top) + 'px';
    document.getElementById('mr-type-input').style.display = 'none';
    document.getElementById('mr-type-value').value = '';
    document.getElementById('mr-type-enter').checked = false;
    document.getElementById('mr-read-input').style.display = 'none';
    document.getElementById('mr-read-varname').value = '';
  }

  function hideMenu() {
    menu.style.display = 'none';
    document.getElementById('mr-type-input').style.display = 'none';
    document.getElementById('mr-read-input').style.display = 'none';
    selectedElement = null;
    // Reset highlight when menu closes without action
    highlight.style.display = 'none';
  }

  // Convert relative URL to absolute based on current page
  function toAbsoluteUrl(url) {
    if (!url || url.startsWith('data:') || url.startsWith('blob:')) return url;
    try { return new URL(url, window.location.href).href; } catch (e) { return url; }
  }

  // Capture page HTML snapshot (cleaned, max ~500KB)
  function captureSnapshot() {
    try {
      const clone = document.documentElement.cloneNode(true);
      // Remove heavy elements
      clone.querySelectorAll('script, iframe, video, audio, canvas, svg[width], noscript').forEach(el => el.remove());

      // Fix CSS: convert <link rel="stylesheet"> href to absolute URLs
      clone.querySelectorAll('link[rel="stylesheet"], link[rel="preload"][as="style"]').forEach(link => {
        const href = link.getAttribute('href');
        if (href) link.setAttribute('href', toAbsoluteUrl(href));
      });

      // Fix images: convert src to absolute URLs
      clone.querySelectorAll('img[src]').forEach(img => {
        const src = img.getAttribute('src');
        if (src && src.startsWith('data:') && src.length > 1024) {
          img.setAttribute('src', '');
        } else if (src && !src.startsWith('data:')) {
          img.setAttribute('src', toAbsoluteUrl(src));
        }
      });
      // Fix srcset
      clone.querySelectorAll('[srcset]').forEach(el => {
        const srcset = el.getAttribute('srcset');
        if (srcset) {
          const fixed = srcset.split(',').map(part => {
            const [url, ...rest] = part.trim().split(/\s+/);
            return [toAbsoluteUrl(url), ...rest].join(' ');
          }).join(', ');
          el.setAttribute('srcset', fixed);
        }
      });

      // Fix background images in inline styles
      clone.querySelectorAll('[style]').forEach(el => {
        const style = el.getAttribute('style');
        if (style && style.includes('url(')) {
          el.setAttribute('style', style.replace(/url\((['"]?)([^)'"]+)\1\)/g, (match, quote, url) => {
            return `url(${quote}${toAbsoluteUrl(url)}${quote})`;
          }));
        }
      });

      // Fix other link-like attributes (favicons, etc.)
      clone.querySelectorAll('link[href]').forEach(link => {
        const href = link.getAttribute('href');
        if (href) link.setAttribute('href', toAbsoluteUrl(href));
      });

      // Add <base> tag so any remaining relative URLs resolve correctly
      const existingBase = clone.querySelector('base');
      if (!existingBase) {
        const base = document.createElement('base');
        base.setAttribute('href', window.location.origin + window.location.pathname);
        const head = clone.querySelector('head');
        if (head) head.insertBefore(base, head.firstChild);
      }

      // Remove style tags with very long content
      clone.querySelectorAll('style').forEach(s => {
        if (s.textContent.length > 50000) s.textContent = '/* trimmed */';
      });

      // Capture computed styles from CSSStyleSheet objects (CSS-in-JS, adoptedStyleSheets)
      // Many sites (Telegram, React apps) inject styles via JS, not <link> tags
      try {
        let extraCSS = '';
        // 1. Capture all document.styleSheets rules (includes JS-injected <style> tags)
        for (const sheet of document.styleSheets) {
          try {
            // Skip already-included <link> stylesheets (they're in the clone)
            if (sheet.href) continue;
            // Skip if ownerNode is already in clone
            if (sheet.ownerNode && sheet.ownerNode.tagName === 'STYLE') continue;
            const rules = sheet.cssRules || sheet.rules;
            if (rules) {
              for (const rule of rules) {
                extraCSS += rule.cssText + '\n';
              }
            }
          } catch (e) { /* cross-origin stylesheet, skip */ }
        }
        // 2. Capture adoptedStyleSheets (modern CSS-in-JS)
        if (document.adoptedStyleSheets?.length > 0) {
          for (const sheet of document.adoptedStyleSheets) {
            try {
              const rules = sheet.cssRules || sheet.rules;
              if (rules) {
                for (const rule of rules) {
                  extraCSS += rule.cssText + '\n';
                }
              }
            } catch (e) {}
          }
        }
        // 3. Capture inline computed styles for key elements (background, color, fonts)
        // Focus on visible elements to keep size manageable
        const visibleEls = document.querySelectorAll('body *:not(script):not(style):not(link):not(meta)');
        let inlineOverrides = '';
        let inlineCount = 0;
        for (const el of visibleEls) {
          if (inlineCount > 500) break; // Limit for performance
          const computed = window.getComputedStyle(el);
          const bg = computed.backgroundColor;
          const color = computed.color;
          const bgImage = computed.backgroundImage;
          // Only capture non-default styles
          if ((bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') ||
              (bgImage && bgImage !== 'none') ||
              (color && color !== 'rgb(0, 0, 0)')) {
            const sel = getSelector(el);
            try {
              // Quick check selector validity
              document.querySelector(sel);
              let rules = '';
              if (bg && bg !== 'rgba(0, 0, 0, 0)' && bg !== 'transparent') rules += `background-color:${bg};`;
              if (bgImage && bgImage !== 'none') {
                rules += `background-image:${bgImage.replace(/url\((['"]?)([^)'"]+)\1\)/g, (m, q, u) => `url(${q}${toAbsoluteUrl(u)}${q})`)};`;
              }
              if (color && color !== 'rgb(0, 0, 0)') rules += `color:${color};`;
              rules += `font-family:${computed.fontFamily};font-size:${computed.fontSize};`;
              inlineOverrides += `${sel}{${rules}}\n`;
              inlineCount++;
            } catch (e) {}
          }
        }
        if (extraCSS || inlineOverrides) {
          const styleTag = document.createElement('style');
          styleTag.textContent = extraCSS + '\n' + inlineOverrides;
          const head = clone.querySelector('head');
          if (head) head.appendChild(styleTag);
        }
      } catch (e) { /* best effort */ }

      let html = clone.outerHTML;
      // Trim to 800KB (increased for extra CSS)
      if (html.length > 800000) html = html.substring(0, 800000) + '<!-- trimmed -->';
      return html;
    } catch (e) {
      return '<html><body>Snapshot capture failed</body></html>';
    }
  }

  function recordStep(action, el, extra = {}) {
    const info = getElementInfo(el);
    const snapshot = captureSnapshot();
    const step = { action, ...info, ...extra };
    stepCount++;
    document.getElementById('mr-step-count').textContent = `${stepCount} шагов`;
    chrome.storage.local.set({ mrStepCount: stepCount });
    chrome.runtime.sendMessage({ type: 'record-step', step, snapshot });

    highlight.style.borderColor = '#a6e3a1';
    highlight.style.background = 'rgba(166, 227, 161, 0.2)';
    setTimeout(() => {
      highlight.style.borderColor = '#4a90d9';
      highlight.style.background = 'rgba(74, 144, 217, 0.1)';
    }, 300);
  }

  // --- "Select all similar" functions ---
  function enterSimilarMode(el) {
    selectSimilarMode = true;
    hideMenu();

    const generalSelector = getGeneralSelector(el);
    similarElements = Array.from(document.querySelectorAll(generalSelector));

    // Highlight all found elements in green
    clearSimilarHighlights();
    similarElements.forEach(e => {
      const rect = e.getBoundingClientRect();
      const h = document.createElement('div');
      h.className = 'mr-similar-highlight';
      h.style.left = rect.left + 'px';
      h.style.top = rect.top + 'px';
      h.style.width = rect.width + 'px';
      h.style.height = rect.height + 'px';
      document.body.appendChild(h);
      similarHighlights.push(h);
    });

    // Show confirmation panel
    document.getElementById('mr-similar-count').textContent = `${similarElements.length} похожих элементов`;
    document.getElementById('mr-similar-selector').textContent = generalSelector;
    document.getElementById('mr-similar-varname-input').value = '';
    similarPanel.style.display = 'block';
    similarPanel._selector = generalSelector;
  }

  function clearSimilarHighlights() {
    similarHighlights.forEach(h => h.remove());
    similarHighlights = [];
  }

  function hideSimilarMode() {
    selectSimilarMode = false;
    similarElements = [];
    clearSimilarHighlights();
    similarPanel.style.display = 'none';
  }

  // Confirm: record a loop-elements block
  document.getElementById('mr-similar-confirm').addEventListener('click', () => {
    const selector = similarPanel._selector;
    const varName = document.getElementById('mr-similar-varname-input').value.trim();
    const count = similarElements.length;

    // Record as a loop-elements block
    const step = {
      action: 'loop-elements',
      cssSelector: selector,
      varName: varName || '',
      maxElements: 0,
      delayMin: '1',
      delayMax: '3',
      children: [],
      url: window.location.href,
      timestamp: Date.now(),
      _similarCount: count
    };

    stepCount++;
    document.getElementById('mr-step-count').textContent = `${stepCount} шагов`;
    chrome.storage.local.set({ mrStepCount: stepCount });
    chrome.runtime.sendMessage({ type: 'record-step', step });

    hideSimilarMode();
  });

  document.getElementById('mr-similar-cancel').addEventListener('click', () => {
    hideSimilarMode();
  });

  // --- Menu actions ---
  menu.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn || !selectedElement) return;
    const action = btn.dataset.action;

    if (action === 'select-similar') {
      enterSimilarMode(selectedElement);
      return;
    }

    if (action === 'real-click') {
      const el = selectedElement;
      hideMenu();
      highlight.style.display = 'none';
      skipNextClick = true;
      el.click();
      return;
    }

    if (action === 'type') {
      const typeInput = document.getElementById('mr-type-input');
      if (typeInput.style.display === 'none') {
        typeInput.style.display = 'block';
        const input = document.getElementById('mr-type-value');
        input.focus();
        input.addEventListener('keydown', function handler(e) {
          if (e.key === 'Enter') {
            e.preventDefault();
            const pressEnter = document.getElementById('mr-type-enter').checked;
            recordStep('type', selectedElement, { value: input.value, pressEnter });
            input.removeEventListener('keydown', handler);
            hideMenu();
          }
          if (e.key === 'Escape') { input.removeEventListener('keydown', handler); hideMenu(); }
        });
        return;
      }
    }

    if (action === 'read') {
      const readInput = document.getElementById('mr-read-input');
      if (readInput.style.display === 'none') {
        readInput.style.display = 'block';
        const input = document.getElementById('mr-read-varname');
        input.focus();
        input.addEventListener('keydown', function handler(e) {
          if (e.key === 'Enter') {
            e.preventDefault();
            const varName = input.value.trim().replace(/^\{\{|\}\}$/g, '');
            recordStep('read', selectedElement, { saveAs: varName || '' });
            input.removeEventListener('keydown', handler);
            hideMenu();
          }
          if (e.key === 'Escape') { input.removeEventListener('keydown', handler); hideMenu(); }
        });
        return;
      }
    }

    if (action === 'get-sms-code') {
      recordStep('get-sms-code', selectedElement, { description: 'SMS-код' });
      hideMenu();
      return;
    }

    if (action === 'user-input') {
      recordStep('user-input', selectedElement, { promptTitle: 'Введите значение', saveAs: 'user_input' });
      hideMenu();
      return;
    }

    recordStep(action, selectedElement);
    hideMenu();
  });

  // --- Mouse events ---
  function isMenuOpen() {
    return menu.style.display === 'block';
  }

  document.addEventListener('mousemove', (e) => {
    if (!isRecording || isPaused || selectSimilarMode) return;
    // Don't update highlight while menu is open — selection is locked
    if (isMenuOpen()) return;
    // Use composed path for Shadow DOM support
    let el = e.composedPath ? e.composedPath()[0] : document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el.nodeType !== 1) el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el.id?.startsWith('macro-recorder') || el.closest?.('#macro-recorder-menu') || el.closest?.('#macro-recorder-status') || el.closest?.('#macro-recorder-similar-panel')) return;
    hoveredElement = el;
    highlightEl(el);
  }, true);

  // Block ALL click-related events at capture phase to prevent passthrough on Telegram etc.
  function blockEvent(e) {
    if (!isRecording || isPaused) return;
    if (selectSimilarMode) return;
    if (e.target.closest('#macro-recorder-menu') || e.target.closest('#macro-recorder-status') || e.target.closest('#macro-recorder-similar-panel')) return;
    if (skipNextClick && e.type === 'click') { skipNextClick = false; return; }
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  // Aggressively intercept mousedown/mouseup to prevent sites from receiving clicks
  document.addEventListener('mousedown', (e) => {
    if (!isRecording || isPaused) return;
    if (selectSimilarMode) return;
    if (e.target.closest('#macro-recorder-menu') || e.target.closest('#macro-recorder-status') || e.target.closest('#macro-recorder-similar-panel')) return;
    // Don't block right-click (for browser context menu)
    if (e.button === 2) return;
    if (skipNextClick) return;
    // Close menu if clicking outside it
    if (menu.style.display === 'block' && !e.target.closest('#macro-recorder-menu')) {
      hideMenu();
      // Allow re-selection: don't return, let user pick new element
    }
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }, true);

  document.addEventListener('mouseup', (e) => {
    blockEvent(e);
  }, true);

  document.addEventListener('click', (e) => {
    if (!isRecording || isPaused) return;
    if (selectSimilarMode) return;
    if (e.target.closest('#macro-recorder-menu') || e.target.closest('#macro-recorder-status') || e.target.closest('#macro-recorder-similar-panel')) return;
    if (skipNextClick) { skipNextClick = false; return; }
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const el = document.elementFromPoint(e.clientX, e.clientY);
    if (!el || el.id?.startsWith('macro-recorder')) return;
    // Lock highlight on this element
    highlightEl(el);
    showMenu(el, e.clientX, e.clientY);
  }, true);

  // Also block pointerdown/pointerup for sites using Pointer Events API
  document.addEventListener('pointerdown', (e) => {
    if (!isRecording || isPaused) return;
    if (selectSimilarMode) return;
    if (e.target.closest('#macro-recorder-menu') || e.target.closest('#macro-recorder-status') || e.target.closest('#macro-recorder-similar-panel')) return;
    if (e.button === 2) return;
    if (skipNextClick) return;
    e.preventDefault(); // ADD preventDefault for better interception
    e.stopPropagation();
    e.stopImmediatePropagation();
  }, true);

  document.addEventListener('pointerup', (e) => {
    if (!isRecording || isPaused) return;
    if (selectSimilarMode) return;
    if (e.target.closest('#macro-recorder-menu') || e.target.closest('#macro-recorder-status') || e.target.closest('#macro-recorder-similar-panel')) return;
    if (skipNextClick) return;
    e.preventDefault(); // ADD preventDefault for better interception
    e.stopPropagation();
    e.stopImmediatePropagation();
  }, true);

  // Add touchstart/touchend/contextmenu interception for better Telegram Web support
  document.addEventListener('touchstart', (e) => {
    if (!isRecording || isPaused) return;
    if (selectSimilarMode) return;
    if (e.target.closest('#macro-recorder-menu') || e.target.closest('#macro-recorder-status') || e.target.closest('#macro-recorder-similar-panel')) return;
    if (skipNextClick) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }, true);

  document.addEventListener('touchend', (e) => {
    if (!isRecording || isPaused) return;
    if (selectSimilarMode) return;
    if (e.target.closest('#macro-recorder-menu') || e.target.closest('#macro-recorder-status') || e.target.closest('#macro-recorder-similar-panel')) return;
    if (skipNextClick) return;
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }, true);

  document.addEventListener('contextmenu', (e) => {
    if (!isRecording || isPaused) return;
    if (selectSimilarMode) return;
    if (e.target.closest('#macro-recorder-menu') || e.target.closest('#macro-recorder-status') || e.target.closest('#macro-recorder-similar-panel')) return;
    // Allow right-click context menu for macro recorder elements
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }, true);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (selectSimilarMode) hideSimilarMode();
      else hideMenu();
    }
  });

  // Old mousedown handler removed — now handled in capture-phase handler above

  // --- Pause/Resume ---
  document.getElementById('mr-pause-btn').addEventListener('click', () => {
    isPaused = !isPaused;
    chrome.storage.local.set({ mrPaused: isPaused });
    updateStatusBar();
    chrome.runtime.sendMessage({ type: 'recording-status', isPaused, isRecording });
  });

  // --- Stop ---
  document.getElementById('mr-stop-btn').addEventListener('click', () => {
    isRecording = false;
    chrome.storage.local.set({ mrRecording: false, mrPaused: false, mrStepCount: 0 });
    hideAll();
    chrome.runtime.sendMessage({ type: 'stop-recording' });
  });

  // --- Messages ---
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'start-recording') {
      isRecording = true; isPaused = false; stepCount = 0;
      chrome.storage.local.set({ mrRecording: true, mrPaused: false, mrStepCount: 0 });
      showStatusBar(); updateStatusBar();
      sendResponse({ ok: true });
    }
    if (msg.type === 'stop-recording') {
      isRecording = false;
      chrome.storage.local.set({ mrRecording: false, mrPaused: false, mrStepCount: 0 });
      hideAll();
      sendResponse({ ok: true });
    }
    if (msg.type === 'get-status') {
      sendResponse({ isRecording, isPaused, stepCount });
    }
  });
})();
