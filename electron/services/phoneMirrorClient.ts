// Mobile client served by PhoneMirrorService.
// Inlined here so it travels with the asar bundle without extra build steps.
// Edit the template below; whitespace is preserved as written.

export const PHONE_MIRROR_HTML = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
    <meta name="theme-color" content="#050706" />
    <meta name="referrer" content="no-referrer" />
    <title>Natively Mirror</title>
    <style>
      :root {
        color-scheme: dark;
        --bg: #05070a;
        --panel: #0c1117;
        --panel-2: #111821;
        --line: rgba(120, 200, 255, 0.18);
        --line-soft: rgba(255, 255, 255, 0.07);
        --text: #f1f6fb;
        --muted: #7b8896;
        --accent: #6cf0d6;
        --accent-2: #55a6ff;
        --danger: #ff5d6c;
      }
      * { box-sizing: border-box; }
      html, body { min-height: 100%; }
      body {
        margin: 0;
        background:
          radial-gradient(1200px 600px at 18% -10%, rgba(85,166,255,0.10), transparent 70%),
          radial-gradient(900px 600px at 110% 110%, rgba(108,240,214,0.08), transparent 70%),
          linear-gradient(180deg, #05070a 0%, #070a0f 100%);
        color: var(--text);
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        -webkit-font-smoothing: antialiased;
      }
      button { border: 0; color: inherit; font: inherit; cursor: pointer; }
      .app {
        display: grid;
        grid-template-rows: auto 1fr auto;
        min-height: 100dvh;
        /* Left/right safe-area insets matter once the phone is rotated: a
           notch/Dynamic Island that sits harmlessly above the status bar in
           portrait moves to the LEFT or RIGHT edge in landscape and would
           otherwise clip the top bar and card edges. Always applied (not
           landscape-gated) since it's 0 on non-notched devices in any
           orientation. */
        padding: env(safe-area-inset-top) calc(env(safe-area-inset-right) + 14px) env(safe-area-inset-bottom) calc(env(safe-area-inset-left) + 14px);
      }
      /* ── Landscape (phone rotated sideways) ─────
         A phone in landscape is short and wide: unconstrained cards would
         stretch a line of text across the full width (hurts readability) and
         the portrait-tuned vertical chrome (topbar padding, empty-state
         height) eats a much bigger share of the little height available.
         max-height caps this to actual phones in landscape, not a wide
         desktop/tablet browser window. */
      @media (orientation: landscape) and (max-height: 600px) {
        .app { max-width: 720px; margin: 0 auto; }
        .topbar { padding: 10px 4px 8px; }
        .empty { min-height: 30dvh; }
        .content .codeblock pre { max-height: 34vh; }
      }
      /* ── Top bar ─────────────────────────────── */
      .topbar {
        position: sticky; top: 0; z-index: 5;
        display: flex; align-items: center; justify-content: space-between; gap: 16px;
        padding: 18px 4px 14px;
        background: linear-gradient(180deg, rgba(5,7,10,0.96), rgba(5,7,10,0.72) 78%, transparent);
        backdrop-filter: blur(16px); -webkit-backdrop-filter: blur(16px);
      }
      h1 { margin: 0; font-size: 18px; line-height: 1.05; font-weight: 700; letter-spacing: 0.2px; }
      .subtitle { margin-top: 5px; color: var(--muted); font-size: 12px; font-variant-numeric: tabular-nums; }
      .status {
        display: inline-flex; align-items: center; gap: 8px;
        flex: 0 0 auto; min-height: 32px; padding: 0 11px;
        border: 1px solid var(--line-soft); border-radius: 999px;
        background: rgba(11,15,21,0.76); color: var(--muted); font-size: 12px;
      }
      .dot { width: 8px; height: 8px; border-radius: 999px; background: var(--danger); }
      .status.connected { color: var(--text); }
      .status.connected .dot { background: var(--accent); animation: pulse 1.8s ease-in-out infinite; }
      /* ── Feed ────────────────────────────────── */
      .feed {
        display: flex; flex-direction: column; gap: 12px; min-height: 0;
        overflow-y: auto; padding: 12px 0 24px;
        scroll-behavior: smooth; overscroll-behavior: contain;
      }
      .empty {
        display: grid; place-items: center; min-height: 50dvh;
        color: var(--muted); text-align: center; font-size: 14px; line-height: 1.55; padding: 0 16px;
      }
      /* ── Cards ───────────────────────────────── */
      .card {
        position: relative; padding: 14px 14px 16px;
        border: 1px solid var(--line-soft); border-radius: 10px;
        background: linear-gradient(180deg, rgba(17,24,33,0.92), rgba(11,16,22,0.96)), var(--panel);
        box-shadow: inset 0 1px 0 rgba(255,255,255,0.04);
        animation: rise 240ms cubic-bezier(0.16,1,0.3,1) both;
      }
      .card.live { border-color: var(--line); box-shadow: 0 0 0 1px rgba(108,240,214,0.10), inset 0 1px 0 rgba(255,255,255,0.05); }
      .card.user {
        background: linear-gradient(180deg, rgba(20,28,40,0.92), rgba(15,21,30,0.96));
        border-color: rgba(85,166,255,0.16);
      }
      .card.screenshot-card {
        background: rgba(8,12,18,0.95);
        border-color: rgba(85,166,255,0.14);
        padding: 10px 14px;
      }
      .meta {
        display: flex; align-items: center; justify-content: space-between; gap: 12px;
        margin-bottom: 8px; color: var(--muted); font-size: 11px;
        font-variant-numeric: tabular-nums; text-transform: uppercase; letter-spacing: 0.6px;
      }
      .role { display: inline-flex; align-items: center; gap: 6px; }
      .role .pip { width: 6px; height: 6px; border-radius: 999px; background: var(--accent); }
      .role.user .pip { background: var(--accent-2); }
      .label-tag {
        padding: 2px 8px;
        border: 1px solid rgba(108,240,214,0.22); border-radius: 999px;
        color: var(--accent); font-size: 10px; font-weight: 700; letter-spacing: 0.5px;
        text-transform: uppercase;
      }
      .badge {
        display: none; padding: 3px 7px;
        border: 1px solid rgba(108,240,214,0.32); border-radius: 999px;
        color: var(--accent); font-size: 10px; font-weight: 700; letter-spacing: 0.6px;
      }
      .card.live .badge { display: inline-block; }
      .content { font-size: 15.5px; line-height: 1.6; overflow-wrap: anywhere; word-break: break-word; }
      .content > :first-child { margin-top: 0; }
      .content > :last-child { margin-bottom: 0; }
      .content p { margin: 0 0 10px; }
      .content strong { font-weight: 700; color: #ffffff; }
      .content em { font-style: italic; color: rgba(255,255,255,0.92); }
      .content h1, .content h2, .content h3 {
        margin: 14px 0 8px; line-height: 1.25; letter-spacing: -0.01em;
        color: #ffffff; font-weight: 700;
      }
      .content h1 { font-size: 19px; }
      .content h2 { font-size: 17px; }
      .content h3 { font-size: 15px; }
      .content ul, .content ol { margin: 6px 0 12px; padding-left: 22px; }
      .content ul { list-style: disc; }
      .content ol { list-style: decimal; }
      .content li { margin: 3px 0; padding-left: 4px; }
      .content li::marker { color: rgba(255,255,255,0.42); }
      .content blockquote {
        margin: 8px 0; padding: 4px 12px;
        border-left: 2px solid rgba(108,240,214,0.35);
        color: rgba(255,255,255,0.82); font-style: italic;
      }
      .content a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
      .content code.inline {
        padding: 1px 6px; border-radius: 4px;
        background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.06);
        color: #d6e6ff; font: 0.92em ui-monospace, "SF Mono", Menlo, Consolas, monospace;
        word-break: break-word; white-space: pre-wrap;
      }
      .content .math {
        font: 0.95em ui-monospace, "SF Mono", Menlo, Consolas, monospace;
        color: #ffe8a8;
      }
      .content .codeblock {
        margin: 10px 0 14px; border-radius: 10px; overflow: hidden;
        background: rgba(0,0,0,0.42); border: 1px solid rgba(255,255,255,0.07);
      }
      .content .codeblock-head {
        display: flex; align-items: center; justify-content: space-between;
        padding: 6px 10px 6px 12px;
        background: rgba(255,255,255,0.03);
        border-bottom: 1px solid rgba(255,255,255,0.05);
        color: rgba(255,255,255,0.55); font-size: 11px;
        text-transform: uppercase; letter-spacing: 0.08em;
      }
      .content .codeblock-copy {
        background: transparent; color: rgba(255,255,255,0.55);
        font-size: 11px; padding: 2px 8px; border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.08);
        text-transform: none; letter-spacing: 0;
        transition: color 160ms ease, background 160ms ease, border-color 160ms ease;
      }
      .content .codeblock-copy:active { transform: scale(0.97); }
      .content .codeblock-copy.copied { color: var(--accent); border-color: rgba(108,240,214,0.32); }
      .content .codeblock pre {
        margin: 0; padding: 12px 14px; overflow-x: auto; overflow-y: auto;
        max-height: 46vh; overscroll-behavior: contain;
        font: 12.5px/1.55 ui-monospace, "SF Mono", Menlo, Consolas, monospace;
        color: #e6edf3; white-space: pre;
        scrollbar-width: thin;
      }
      .content .codeblock pre::-webkit-scrollbar { height: 6px; width: 6px; }
      .content .codeblock pre::-webkit-scrollbar-thumb { background: rgba(255,255,255,0.12); border-radius: 3px; }
      .content .codeblock.streaming { border-color: rgba(108,240,214,0.18); }
      .content .codeblock.streaming .codeblock-head { color: var(--accent); }
      /* ── Syntax tokens ─────────────────────── */
      .content pre .hl-c    { color: #6b7d99; font-style: italic; }
      .content pre .hl-s    { color: #a3e9b6; }
      .content pre .hl-k    { color: #c8a8ff; }
      .content pre .hl-n    { color: #ffd58a; }
      .content pre .hl-f    { color: #7ec8ff; }
      .content pre .hl-t    { color: #ff9bb6; }
      .content pre .hl-a    { color: #6cf0d6; }
      .content pre .hl-v    { color: #ffb482; font-style: italic; }
      .content pre .hl-o    { color: #c0d0e0; }
      .content hr {
        border: 0; height: 1px;
        background: linear-gradient(90deg, transparent, rgba(255,255,255,0.18), transparent);
        margin: 14px 0;
      }
      .content .caret {
        display: inline-block; width: 7px; height: 1em; vertical-align: -2px; margin-left: 2px;
        background: var(--accent); border-radius: 2px;
        animation: blink 1s steps(2, end) infinite;
      }
      /* ── Toast ─────────────────────────────── */
      .toast {
        position: fixed; left: 50%; top: calc(env(safe-area-inset-top) + 70px);
        transform: translateX(-50%);
        padding: 8px 12px; border-radius: 999px;
        background: rgba(8,12,17,0.92); color: var(--text);
        border: 1px solid var(--line-soft);
        font-size: 12px; opacity: 0; pointer-events: none;
        transition: opacity 160ms ease; z-index: 20;
      }
      .toast.show { opacity: 1; }
      /* ── Keyframes ─────────────────────────── */
      @keyframes pulse {
        0%,100% { box-shadow: 0 0 0 0 rgba(108,240,214,0.36); }
        50% { box-shadow: 0 0 0 7px rgba(108,240,214,0); }
      }
      @keyframes rise { from { opacity: 0; transform: translateY(8px); } to { opacity: 1; transform: translateY(0); } }
      @keyframes blink { 50% { opacity: 0; } }
    </style>
  </head>
  <body>
    <main class="app">
      <header class="topbar">
        <div class="title">
          <h1>Natively Mirror</h1>
          <div class="subtitle" id="subtitle">Connecting</div>
        </div>
        <div class="status" id="status">
          <span class="dot" aria-hidden="true"></span>
          <span id="statusText">Offline</span>
        </div>
      </header>

      <section class="feed" id="feed" aria-live="polite">
        <div class="empty" id="empty">
          Waiting for the next answer…
        </div>
      </section>

      <div class="toast" id="toast" role="status"></div>
    </main>

    <script>
      (function () {
        const feed = document.getElementById('feed');
        const empty = document.getElementById('empty');
        const status = document.getElementById('status');
        const statusText = document.getElementById('statusText');
        const subtitle = document.getElementById('subtitle');
        const toast = document.getElementById('toast');

        // ───── Markdown renderer ─────────────────────────────────────────
        const HTML_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
        function esc(str) { return String(str || '').replace(/[&<>"']/g, function (c) { return HTML_ESCAPE[c]; }); }

        // ───── Syntax highlighter ────────────────────────────────────────
        const LANG_ALIAS = {
          js: 'js', javascript: 'js', jsx: 'js',
          ts: 'js', typescript: 'js', tsx: 'js',
          py: 'py', python: 'py',
          sh: 'sh', bash: 'sh', shell: 'sh', zsh: 'sh',
          json: 'json',
          go: 'go', golang: 'go',
          rs: 'rs', rust: 'rs',
          c: 'c', cpp: 'c', 'c++': 'c', cc: 'c', h: 'c', hpp: 'c', java: 'c', cs: 'c', csharp: 'c',
          html: 'html', xml: 'html', svg: 'html',
          css: 'css', scss: 'css', sass: 'css',
          sql: 'sql',
          yaml: 'yaml', yml: 'yaml',
        };
        const HL_RULES = {
          py: [
            ['c', /^#[^\\n]*/],
            ['s', /^(?:"""[\\s\\S]*?(?:"""|$)|'''[\\s\\S]*?(?:'''|$)|"(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*')/],
            ['k', /^\\b(?:def|class|return|if|elif|else|for|while|in|is|not|and|or|import|from|as|with|try|except|finally|raise|lambda|yield|pass|break|continue|global|nonlocal|None|True|False|async|await|del|assert|match|case)\\b/],
            ['v', /^\\b(?:self|cls)\\b/],
            ['n', /^\\b(?:0x[0-9a-fA-F]+|0b[01]+|0o[0-7]+|\\d+\\.?\\d*(?:e[+-]?\\d+)?[jJ]?)\\b/],
            ['f', /^\\b[A-Za-z_]\\w*(?=\\s*\\()/],
            ['o', /^[+\\-*/%=<>!&|^~?:@]+/],
          ],
          js: [
            ['c', /^(?:\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?(?:\\*\\/|$))/],
            ['s', /^(?:\`(?:[^\`\\\\]|\\\\.)*(?:\`|$)|"(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*')/],
            ['k', /^\\b(?:const|let|var|function|return|if|else|for|while|do|break|continue|switch|case|default|new|delete|typeof|instanceof|in|of|throw|try|catch|finally|class|extends|super|null|undefined|true|false|async|await|yield|import|export|from|as|static|get|set|public|private|protected|interface|type|enum|namespace|implements|readonly|abstract|declare|void|never|any|unknown|keyof|infer|satisfies)\\b/],
            ['v', /^\\b(?:this|arguments|console|window|document|globalThis|process|require|module|exports)\\b/],
            ['n', /^\\b(?:0x[0-9a-fA-F]+|0b[01]+|\\d+\\.?\\d*(?:e[+-]?\\d+)?n?|\\.\\d+(?:e[+-]?\\d+)?)\\b/],
            ['f', /^\\b[A-Za-z_$][\\w$]*(?=\\s*\\()/],
            ['o', /^[+\\-*/%=<>!&|^~?:]+/],
          ],
          sh: [
            ['c', /^#[^\\n]*/],
            ['s', /^(?:"(?:[^"\\\\]|\\\\.)*"|'[^']*')/],
            ['v', /^\\$(?:\\{[^}]+\\}|[A-Za-z_]\\w*|[0-9!#?@*$])/],
            ['k', /^\\b(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|in|function|return|exit|echo|export|local|set|unset|test|cd|ls|cat|grep|sed|awk|cut|sort|uniq|head|tail|wc|find|chmod|chown|mkdir|rm|cp|mv|ln|ssh|scp|rsync|curl|wget|sudo|read|printf|trap|source|eval)\\b/],
            ['n', /^\\b\\d+\\b/],
            ['o', /^[|&;<>=()$]+/],
          ],
          json: [
            ['a', /^"(?:[^"\\\\]|\\\\.)*"(?=\\s*:)/],
            ['s', /^"(?:[^"\\\\]|\\\\.)*"/],
            ['n', /^-?(?:0|[1-9]\\d*)(?:\\.\\d+)?(?:[eE][+-]?\\d+)?/],
            ['k', /^\\b(?:true|false|null)\\b/],
            ['o', /^[{}\\[\\],:]/],
          ],
          go: [
            ['c', /^(?:\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?(?:\\*\\/|$))/],
            ['s', /^(?:\`[^\`]*(?:\`|$)|"(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')/],
            ['k', /^\\b(?:break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var|nil|true|false|iota)\\b/],
            ['v', /^\\b(?:append|cap|close|complex|copy|delete|imag|len|make|new|panic|print|println|real|recover|string|int|int8|int16|int32|int64|uint|uint8|uint16|uint32|uint64|byte|rune|float32|float64|bool|error)\\b/],
            ['n', /^\\b(?:0x[0-9a-fA-F]+|0b[01]+|0o[0-7]+|\\d+\\.?\\d*(?:e[+-]?\\d+)?)\\b/],
            ['f', /^\\b[A-Za-z_]\\w*(?=\\s*\\()/],
            ['o', /^[+\\-*/%=<>!&|^~?:]+/],
          ],
          rs: [
            ['c', /^(?:\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?(?:\\*\\/|$))/],
            ['s', /^(?:b?"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)')/],
            ['k', /^\\b(?:as|async|await|break|const|continue|crate|dyn|else|enum|extern|false|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|true|type|unsafe|use|where|while)\\b/],
            ['v', /^\\b(?:i8|i16|i32|i64|i128|isize|u8|u16|u32|u64|u128|usize|f32|f64|bool|char|str|String|Vec|Option|Result|Box|Rc|Arc|HashMap|HashSet|None|Some|Ok|Err)\\b/],
            ['n', /^\\b(?:0x[0-9a-fA-F_]+|0b[01_]+|0o[0-7_]+|\\d[\\d_]*\\.?\\d*(?:e[+-]?\\d+)?(?:[iuf](?:8|16|32|64|128|size))?)\\b/],
            ['f', /^\\b[A-Za-z_]\\w*(?=\\s*[(!])/],
            ['o', /^[+\\-*/%=<>!&|^~?:@#]+/],
          ],
          c: [
            ['c', /^(?:\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?(?:\\*\\/|$))/],
            ['s', /^(?:"(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')/],
            ['k', /^\\b(?:auto|break|case|char|const|continue|default|do|double|else|enum|extern|float|for|goto|if|inline|int|long|register|restrict|return|short|signed|sizeof|static|struct|switch|typedef|union|unsigned|void|volatile|while|class|public|private|protected|virtual|new|delete|this|nullptr|namespace|using|template|typename|true|false|try|catch|throw|public|private|protected|abstract|interface|implements|extends|package|import|null|var|let|val|fun|fn)\\b/],
            ['n', /^\\b(?:0x[0-9a-fA-F]+|\\d+\\.?\\d*(?:[eE][+-]?\\d+)?[fFlLuU]*)\\b/],
            ['f', /^\\b[A-Za-z_]\\w*(?=\\s*\\()/],
            ['o', /^[+\\-*/%=<>!&|^~?:]+/],
          ],
          html: [
            ['c', /^<!--[\\s\\S]*?(?:-->|$)/],
            ['t', /^<\\/?[A-Za-z][\\w-]*/],
            ['a', /^[A-Za-z_][\\w-]*(?=\\s*=)/],
            ['s', /^(?:"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')/],
            ['o', /^[<>=\\/]/],
          ],
          css: [
            ['c', /^\\/\\*[\\s\\S]*?(?:\\*\\/|$)/],
            ['s', /^(?:"(?:[^"\\\\]|\\\\.)*"|'(?:[^'\\\\]|\\\\.)*')/],
            ['a', /^[-A-Za-z]+(?=\\s*:)/],
            ['n', /^-?\\d+\\.?\\d*(?:px|em|rem|vw|vh|vmin|vmax|%|s|ms|deg|rad|turn|fr|ch|ex)?\\b/],
            ['k', /^@[A-Za-z-]+/],
            ['t', /^[#.][A-Za-z_][\\w-]*/],
            ['o', /^[{}();:,>+~]/],
          ],
          sql: [
            ['c', /^(?:--[^\\n]*|\\/\\*[\\s\\S]*?(?:\\*\\/|$))/],
            ['s', /^'(?:[^']|'')*'/],
            ['k', /^\\b(?:SELECT|FROM|WHERE|JOIN|INNER|LEFT|RIGHT|FULL|OUTER|CROSS|ON|GROUP|BY|HAVING|ORDER|LIMIT|OFFSET|INSERT|INTO|VALUES|UPDATE|SET|DELETE|CREATE|DROP|ALTER|TABLE|INDEX|VIEW|AS|AND|OR|NOT|IN|EXISTS|BETWEEN|LIKE|ILIKE|IS|NULL|TRUE|FALSE|UNION|ALL|DISTINCT|CASE|WHEN|THEN|ELSE|END|WITH|RECURSIVE|PRIMARY|FOREIGN|KEY|REFERENCES|CONSTRAINT|UNIQUE|DEFAULT|CHECK|RETURNING|GRANT|REVOKE|BEGIN|COMMIT|ROLLBACK)\\b/i],
            ['n', /^\\b\\d+\\.?\\d*\\b/],
            ['f', /^\\b[A-Za-z_]\\w*(?=\\s*\\()/],
            ['o', /^[=<>!()*,;.+\\-]/],
          ],
          yaml: [
            ['c', /^#[^\\n]*/],
            ['a', /^[A-Za-z_][\\w-]*(?=\\s*:)/],
            ['s', /^(?:"(?:[^"\\\\]|\\\\.)*"|'(?:[^']|'')*'|\\|[\\s\\S]*?$|>[\\s\\S]*?$)/],
            ['k', /^\\b(?:true|false|null|yes|no|on|off)\\b/i],
            ['n', /^-?\\d+\\.?\\d*\\b/],
            ['o', /^[:\\-?>|&*!]/],
          ],
          generic: [
            ['c', /^(?:\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?(?:\\*\\/|$)|#[^\\n]*)/],
            ['s', /^(?:"(?:[^"\\\\\\n]|\\\\.)*"|'(?:[^'\\\\\\n]|\\\\.)*'|\`(?:[^\`\\\\]|\\\\.)*(?:\`|$))/],
            ['n', /^\\b(?:0x[0-9a-fA-F]+|\\d+\\.?\\d*)\\b/],
            ['f', /^\\b[A-Za-z_]\\w*(?=\\s*\\()/],
          ],
        };
        function highlightCode(code, lang) {
          const key = LANG_ALIAS[(lang || '').toLowerCase()] || (lang ? null : null);
          const rules = (key && HL_RULES[key]) || (lang ? HL_RULES.generic : null);
          if (!rules) return esc(code);
          const out = [];
          let i = 0;
          const n = code.length;
          while (i < n) {
            const ch = code.charCodeAt(i);
            if (ch === 32 || ch === 9 || ch === 10 || ch === 13) {
              const start = i;
              do { i++; } while (i < n && (code.charCodeAt(i) === 32 || code.charCodeAt(i) === 9 || code.charCodeAt(i) === 10 || code.charCodeAt(i) === 13));
              out.push(esc(code.slice(start, i)));
              continue;
            }
            const tail = code.slice(i);
            let consumed = 0;
            for (let r = 0; r < rules.length; r++) {
              const rule = rules[r];
              const m = tail.match(rule[1]);
              if (m && m[0].length > 0) {
                out.push('<span class="hl-' + rule[0] + '">' + esc(m[0]) + '</span>');
                consumed = m[0].length;
                break;
              }
            }
            if (consumed === 0) {
              const idm = tail.match(/^[A-Za-z_$][\\w$]*/);
              if (idm) { out.push(esc(idm[0])); consumed = idm[0].length; }
              else { out.push(esc(code[i])); consumed = 1; }
            }
            i += consumed;
          }
          return out.join('');
        }

        function renderInline(text) {
          let out = esc(text);
          out = out.replace(/\`([^\`\\n]+)\`/g, function (_m, c) { return '<code class="inline">' + c + '</code>'; });
          out = out.replace(/(^|[^\\\\])\\$([^$\\n]+?)\\$/g, function (_m, pre, c) { return pre + '<span class="math">' + c + '</span>'; });
          out = out.replace(/\\*\\*([^*\\n]+?)\\*\\*/g, '<strong>$1</strong>');
          out = out.replace(/__([^_\\n]+?)__/g, '<strong>$1</strong>');
          out = out.replace(/(^|[^\\*])\\*([^*\\n]+?)\\*(?!\\*)/g, '$1<em>$2</em>');
          out = out.replace(/(^|[^_])_([^_\\n]+?)_(?!_)/g, '$1<em>$2</em>');
          out = out.replace(/\\[([^\\]\\n]+)\\]\\(([^)\\s]+)\\)/g, function (_m, label, href) {
            const safe = /^https?:\\/\\//i.test(href) ? href : '#';
            return '<a href="' + safe + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
          });
          return out;
        }

        function renderMarkdown(src) {
          if (!src) return '';
          const fences = [];
          const fenceRe = /\`\`\`([\\w-]*)?\\n?([\\s\\S]*?)\`\`\`/g;
          let placeheld = src.replace(fenceRe, function (_m, lang, code) {
            fences.push({ lang: (lang || '').toLowerCase(), code: code.replace(/\\n$/, ''), open: false });
            return '\\u0000FENCE' + (fences.length - 1) + '\\u0000';
          });
          const openFenceRe = /(^|\\n)\`\`\`([\\w-]*)?\\n?([\\s\\S]*)$/;
          const openMatch = placeheld.match(openFenceRe);
          if (openMatch) {
            const startIdx = openMatch.index + openMatch[1].length;
            fences.push({ lang: (openMatch[2] || '').toLowerCase(), code: openMatch[3], open: true });
            placeheld = placeheld.slice(0, startIdx) + '\\u0000FENCE' + (fences.length - 1) + '\\u0000';
          }

          const lines = placeheld.split(/\\n/);
          const out = [];
          let para = [];
          let list = null;
          let quote = [];

          function flushPara() {
            if (!para.length) return;
            const joined = para.join(' ').trim();
            if (joined) out.push('<p>' + renderInline(joined) + '</p>');
            para = [];
          }
          function flushList() {
            if (!list) return;
            out.push('<' + list.type + '>' + list.items.map(function (i) {
              return '<li>' + renderInline(i) + '</li>';
            }).join('') + '</' + list.type + '>');
            list = null;
          }
          function flushQuote() {
            if (!quote.length) return;
            out.push('<blockquote>' + renderInline(quote.join(' ')) + '</blockquote>');
            quote = [];
          }
          function flushAll() { flushPara(); flushList(); flushQuote(); }

          for (let i = 0; i < lines.length; i++) {
            const raw = lines[i];
            const trimmed = raw.trim();

            const fenceMatch = trimmed.match(/^\\u0000FENCE(\\d+)\\u0000$/);
            if (fenceMatch) {
              flushAll();
              const f = fences[parseInt(fenceMatch[1], 10)];
              const langLabel = f.lang ? esc(f.lang) : 'code';
              const body = f.open ? esc(f.code) : highlightCode(f.code, f.lang);
              const trailing = f.open
                ? '<span class="codeblock-copy" aria-hidden="true">Streaming…</span>'
                : '<button type="button" class="codeblock-copy">Copy</button>';
              out.push(
                '<div class="codeblock' + (f.open ? ' streaming' : '') + '" data-lang="' + esc(f.lang) + '">' +
                '<div class="codeblock-head"><span>' + langLabel + '</span>' + trailing + '</div>' +
                '<pre><code>' + body + '</code></pre>' +
                '</div>'
              );
              continue;
            }

            if (!trimmed) { flushAll(); continue; }
            if (/^(-{3,}|_{3,}|\\*{3,})$/.test(trimmed)) { flushAll(); out.push('<hr />'); continue; }
            const h = trimmed.match(/^(#{1,3})\\s+(.+)$/);
            if (h) { flushAll(); out.push('<h' + h[1].length + '>' + renderInline(h[2]) + '</h' + h[1].length + '>'); continue; }
            const q = trimmed.match(/^>\\s?(.*)$/);
            if (q) { flushPara(); flushList(); quote.push(q[1]); continue; }
            const ol = trimmed.match(/^(\\d+)[.)]\\s+(.+)$/);
            if (ol) {
              flushPara(); flushQuote();
              if (!list || list.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; }
              list.items.push(ol[2]);
              continue;
            }
            const ul = trimmed.match(/^[-*+]\\s+(.+)$/);
            if (ul) {
              flushPara(); flushQuote();
              if (!list || list.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; }
              list.items.push(ul[1]);
              continue;
            }
            if (list) { list.items[list.items.length - 1] += ' ' + trimmed; continue; }
            if (quote.length) { quote.push(trimmed); continue; }
            para.push(trimmed);
          }
          flushAll();
          return out.join('');
        }

        function bindCodeCopy(root) {
          const buttons = (root || feed).querySelectorAll('.codeblock-copy:not([data-bound])');
          buttons.forEach(function (btn) {
            btn.dataset.bound = '1';
            btn.addEventListener('click', async function (e) {
              e.stopPropagation();
              const block = btn.closest('.codeblock');
              const codeEl = block && block.querySelector('pre code');
              if (!codeEl) return;
              const text = codeEl.textContent || '';
              try {
                if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
                else throw new Error('insecure');
                btn.textContent = 'Copied'; btn.classList.add('copied');
                setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('copied'); }, 1100);
              } catch (_) { showToast('Copy blocked'); }
            });
          });
        }

        // ───── Connection ─────────────────────────────────────────────────
        const params = new URLSearchParams(window.location.search);
        const token = params.get('t') || '';

        // Plain answer-streaming view (2026-09 rework): no scrollback feed, no
        // user/question cards, no chat input or quick-action buttons — a
        // single current answer, replaced wholesale as new ones land,
        // mirroring the main overlay's teleprompter design exactly. "live"
        // holds the in-flight streaming answer; once done it becomes current
        // rather than being appended to a history array.
        let current = null;  // { content, createdAt }
        let live = null;     // { streamId, content, createdAt }
        let socket = null;
        let reconnectTimer = null;
        let reconnectDelay = 800;
        let wakeLock = null;

        function showToast(text) {
          toast.textContent = text;
          toast.classList.add('show');
          setTimeout(() => toast.classList.remove('show'), 1100);
        }

        function setConnected(isConnected) {
          status.classList.toggle('connected', isConnected);
          statusText.textContent = isConnected ? 'Connected' : 'Offline';
          subtitle.textContent = isConnected ? 'Live mirror active' : 'Reconnecting…';
        }

        function scrollToLatest() {
          feed.scrollTo({ top: feed.scrollHeight, behavior: 'smooth' });
          // A streaming code block grows its OWN scroll container (capped by
          // max-height so the page itself doesn't balloon) — follow its
          // bottom too, so the newest generated lines stay in view.
          feed.querySelectorAll('.codeblock.streaming pre').forEach((pre) => {
            pre.scrollTop = pre.scrollHeight;
          });
        }

        function buildCard(m, opts) {
          const card = document.createElement('article');
          card.className = 'card' + (opts && opts.live ? ' live' : '');
          const meta = document.createElement('div');
          meta.className = 'meta';
          const badge = document.createElement('span');
          badge.className = 'badge'; badge.textContent = 'Live';
          meta.append(badge);
          const content = document.createElement('div');
          content.className = 'content';
          content.innerHTML = renderMarkdown(m.content || '');
          if (opts && opts.live) {
            const caret = document.createElement('span');
            caret.className = 'caret';
            content.appendChild(caret);
          }
          bindCodeCopy(content);
          card.append(meta, content);
          return card;
        }

        function render() {
          const has = Boolean(current || live);
          empty.style.display = has ? 'none' : 'grid';
          feed.querySelectorAll('.card').forEach((c) => c.remove());
          if (live) feed.appendChild(buildCard(live, { live: true }));
          else if (current) feed.appendChild(buildCard(current));
          scrollToLatest();
        }

        let liveRenderRaf = 0;
        function flushLiveRender() {
          liveRenderRaf = 0;
          if (!live) return;
          let card = feed.querySelector('.card.live');
          if (!card) { render(); return; }
          const content = card.querySelector('.content');
          content.innerHTML = renderMarkdown(live.content);
          const caret = document.createElement('span');
          caret.className = 'caret';
          content.appendChild(caret);
          bindCodeCopy(content);
          empty.style.display = 'none';
          scrollToLatest();
        }
        function scheduleLiveRender() {
          if (liveRenderRaf) return;
          if (typeof requestAnimationFrame === 'function') {
            liveRenderRaf = requestAnimationFrame(flushLiveRender);
          } else {
            liveRenderRaf = setTimeout(flushLiveRender, 16);
          }
        }
        function appendLiveToken(streamId, token) {
          if (!live || live.streamId !== streamId) {
            live = { streamId, content: '', createdAt: new Date().toISOString() };
          }
          live.content += token;
          scheduleLiveRender();
        }

        function finalizeLive(streamId, content, createdAt) {
          if (liveRenderRaf) {
            if (typeof cancelAnimationFrame === 'function') cancelAnimationFrame(liveRenderRaf);
            else clearTimeout(liveRenderRaf);
            liveRenderRaf = 0;
          }
          const finalText = (live && live.streamId === streamId) ? (content || live.content) : content;
          if (!finalText) { live = null; return; }
          current = { content: finalText, createdAt: createdAt || (live && live.createdAt) || new Date().toISOString() };
          live = null;
          render();
        }

        // ───── Event handler ──────────────────────────────────────────────
        // Question/user-echo, ack, and screenshot-queued events are
        // intentionally not rendered here — this view shows only the answer
        // itself, nothing else (see the top-of-block comment).
        function handleEvent(ev) {
          if (!ev || typeof ev !== 'object') return;

          if (ev.type === 'history' && Array.isArray(ev.messages)) {
            const lastAssistant = [...ev.messages].reverse().find((m) => m && m.role === 'assistant');
            current = lastAssistant ? { content: lastAssistant.content, createdAt: lastAssistant.createdAt } : null;
            live = null;
            render();
            return;
          }
          if (ev.type === 'token') {
            appendLiveToken(String(ev.streamId), String(ev.token || ''));
            return;
          }
          if (ev.type === 'done') {
            finalizeLive(String(ev.streamId), ev.content, ev.createdAt);
            return;
          }
          if (ev.type === 'error') {
            if (live && live.streamId === String(ev.streamId)) {
              live.content += '\\n\\n[error: ' + (ev.message || 'stream failed') + ']';
              render();
              live = null;
            }
            showToast('Stream error');
            return;
          }
          // Non-streaming assistant response from shortcut-triggered actions
          if (ev.type === 'assistant') {
            current = { content: ev.content, createdAt: ev.createdAt };
            live = null;
            render();
            return;
          }
          if (ev.type === 'ack') {
            showToast(ev.message || ev.action);
            return;
          }
        }

        // ───── WebSocket ──────────────────────────────────────────────────
        function connect() {
          clearTimeout(reconnectTimer);
          const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
          const url = proto + '//' + window.location.host + '/ws?t=' + encodeURIComponent(token);
          try { socket = new WebSocket(url); } catch (e) { scheduleReconnect(); return; }

          socket.addEventListener('open', () => {
            setConnected(true);
            reconnectDelay = 800;
          });
          socket.addEventListener('close', (ev) => {
            setConnected(false);
            if (ev.code === 4401) { subtitle.textContent = 'Pairing token rejected'; return; }
            scheduleReconnect();
          });
          socket.addEventListener('error', () => {
            try { socket && socket.close(); } catch (e) {}
          });
          socket.addEventListener('message', (event) => {
            let payload;
            try { payload = JSON.parse(event.data); } catch (e) { return; }
            handleEvent(payload);
          });
        }

        function scheduleReconnect() {
          clearTimeout(reconnectTimer);
          const wait = Math.min(reconnectDelay, 8000);
          reconnectTimer = setTimeout(connect, wait);
          reconnectDelay = Math.min(reconnectDelay * 1.6, 8000);
        }

        async function requestWakeLock() {
          if (!('wakeLock' in navigator)) return;
          try {
            wakeLock = await navigator.wakeLock.request('screen');
            wakeLock.addEventListener('release', () => { wakeLock = null; });
          } catch (e) { wakeLock = null; }
        }

        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') requestWakeLock();
        });

        if (!token) {
          subtitle.textContent = 'Missing pairing token';
          status.classList.remove('connected');
          return;
        }

        requestWakeLock();
        connect();
      })();
    </script>
  </body>
</html>
`;
