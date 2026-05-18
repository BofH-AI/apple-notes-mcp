  # apple-notes-mcp

  An MCP server that gives Claude (and any MCP-compatible AI) full read/write
  access to Apple Notes from **Windows** — via Playwright automation of
  [iCloud.com/notes](https://www.icloud.com/notes/).

  Built entirely with [Claude Code](https://claude.ai/code).

  ---
  
  ## Why this exists                                                                                                              

  Apple Notes has no official API and no Windows app. On macOS, AppleScript
  gives direct access — but on Windows there's nothing. This server bridges
  that gap by automating a headless Chromium browser pointed at iCloud.com,
  using Playwright to interact with the Notes web app.

  ## How it works

  iCloud Notes renders note content on a **canvas** (not in the DOM), which
  makes scraping unusually difficult. The key breakthroughs that make it work:

  - **URL-as-signal** — after clicking a note or creating one, the outer page
    URL changes to include the note ID. This is a reliable signal that the
    canvas editor has loaded the correct note, sidestepping timing guesswork.
  - **Trusted mouse clicks at absolute coordinates** — iCloud's SPA ignores
    programmatic `.click()` and `.focus()` calls (`isTrusted=false`). Instead,
    `page.mouse.click()` at bounding-box-derived coordinates is used throughout,
    generating events the app actually responds to.
  - **iframe coordinate translation** — the Notes UI lives inside an iframe.
    All frame-relative coordinates are translated to page space by adding the
    iframe's bounding box offset before calling `page.mouse.click()`.
  - **Clipboard as content channel** — reading uses `Ctrl+A` / `Ctrl+C` then
    `navigator.clipboard.readText()`; writing uses
    `navigator.clipboard.writeText()` then `Ctrl+V`. Direct keyboard typing
    into the canvas editor is unreliable; clipboard paste is not.
  - **Virtual list scroll harvesting** — the Notes list is virtualised (DOM
    nodes are recycled as you scroll). `list_notes` dispatches wheel events and
    harvests visible titles at each scroll position to build the full list.

  ## Requirements

  - Windows (or any platform with a browser — but macOS users should use
    AppleScript instead)
  - Node.js 18+
  - An iCloud account with Notes enabled

  ## Installation
                                                                                                                                  
  ```bash
  git clone https://github.com/BofH-AI/apple-notes-mcp
  cd apple-notes-mcp
  npm install
  npm run install-browser   # downloads Playwright's Chromium                                                                     
  npm run build

  First run — sign in to iCloud
  
  The browser uses a persistent profile, so you only sign in once:

  node dist/index.js
  
  Or call the open_browser tool from Claude — it opens the browser window so
  you can sign in. Once signed in, the session is remembered across restarts.

  Claude Desktop configuration

  Add to claude_desktop_config.json:
                                                                                                                                  
  {
    "mcpServers": {
      "apple-notes": {
        "command": "node",
        "args": ["C:/path/to/apple-notes-mcp/dist/index.js"]
      }
    }                                                                                                                             
  }
  
  Tools                                                                                                                           

  ┌──────────────┬──────────────────────────────────────────────────────────────────────┐
  │     Tool     │                             Description                              │
  ├──────────────┼──────────────────────────────────────────────────────────────────────┤
  │ open_browser │ Open / bring to front the iCloud.com browser. Call first to sign in. │
  ├──────────────┼──────────────────────────────────────────────────────────────────────┤
  │ list_folders │ List all Notes folders                                               │
  ├──────────────┼──────────────────────────────────────────────────────────────────────┤
  │ list_notes   │ List notes (optionally filtered by folder, up to max items)          │
  ├──────────────┼──────────────────────────────────────────────────────────────────────┤
  │ get_note     │ Get full content of a note by title or index                         │
  ├──────────────┼──────────────────────────────────────────────────────────────────────┤
  │ create_note  │ Create a new note (first line becomes the title)                     │
  ├──────────────┼──────────────────────────────────────────────────────────────────────┤
  │ update_note  │ Append, prepend, or replace a note's content                         │
  ├──────────────┼──────────────────────────────────────────────────────────────────────┤
  │ search_notes │ Search notes by keyword                                              │
  └──────────────┴──────────────────────────────────────────────────────────────────────┘
  
  Known limitations                                                                                                               

  - Login required once — if iCloud session expires, call open_browser
  to re-authenticate.
  - Canvas rendering delay — note content takes ~4 seconds to render after
  selection. get_note waits for this automatically.
  - iCloud UI changes — the selectors and interaction patterns are tied to
  iCloud's current frontend. Apple may update it without notice.
  - Not for macOS — use AppleScript / osascript on Mac; it's faster, more
  reliable, and doesn't require a browser.

  Built with Claude Code
  
  This project was written collaboratively using
  Claude Code (https://claude.ai/code). The core architecture, Playwright
  interaction patterns, and canvas-editor workarounds were developed through
  iterative debugging sessions between the author and Claude Code on Windows.
