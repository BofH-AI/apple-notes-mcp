import { Frame } from "playwright";
import { browser } from "./browser.js";
import { SEL, firstFoundInFrame } from "./selectors.js";
import { log, logError } from "./log.js";

export interface NoteListItem {
  title: string;
  preview: string;
  date: string;
  index: number;
}

async function requireFrame(): Promise<Frame> {
  const { needsLogin } = await browser.navigateToNotes();
  if (needsLogin) {
    await browser.show();
    throw new Error(
      "Not logged in to iCloud. The browser window has been opened — " +
        "please sign in to iCloud.com/notes, then retry."
    );
  }
  return browser.getNotesFrame();
}

// ---------------------------------------------------------------------------
// Debug
// ---------------------------------------------------------------------------

export async function debugPage(): Promise<string> {
  const page = await browser.getPage();
  const url = page.url();
  const title = await page.title();

  const outerInfo = await page.evaluate(() => {
    const iframes = Array.from(document.querySelectorAll("iframe")).map(
      (f) => `<iframe src="${f.src}" id="${f.id}" class="${f.className}">`
    );
    return { iframes };
  });

  let frameInfo = "(frame not yet loaded)";
  try {
    const frame = await browser.getNotesFrame(5000);
    frameInfo = await frame.evaluate(() => {
      const all = Array.from(document.querySelectorAll("*"));
      const noteClasses = new Set<string>();
      const listClasses = new Set<string>();
      const editableClasses = new Set<string>();

      for (const el of all) {
        for (const c of Array.from(el.classList)) {
          if (/note|Note/i.test(c)) noteClasses.add(`${el.tagName.toLowerCase()}.${c}`);
          if (/list|List|item|Item|row|Row/i.test(c)) listClasses.add(`${el.tagName.toLowerCase()}.${c}`);
        }
        if ((el as HTMLElement).contentEditable === "true") {
          editableClasses.add(`${el.tagName.toLowerCase()}.${Array.from(el.classList).join(".")}`);
        }
      }

      return [
        "=== FRAME: elements with 'note' in class ===",
        Array.from(noteClasses).slice(0, 40).join("\n") || "(none)",
        "\n=== FRAME: elements with 'list/item/row' in class ===",
        Array.from(listClasses).slice(0, 40).join("\n") || "(none)",
        "\n=== FRAME: contenteditable elements ===",
        Array.from(editableClasses).slice(0, 10).join("\n") || "(none)",
        "\n=== FRAME: body HTML (first 4000 chars) ===",
        document.body.innerHTML.slice(0, 4000),
      ].join("\n");
    });
  } catch (e) {
    frameInfo = `Could not read frame: ${e}`;
  }

  return [
    `URL: ${url}`,
    `Title: ${title}`,
    `\n=== Outer page iframes ===`,
    outerInfo.iframes.join("\n") || "(none)",
    `\n${frameInfo}`,
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Public operations
// ---------------------------------------------------------------------------

export async function listFolders(): Promise<string[]> {
  const frame = await requireFrame();
  return frame.evaluate(() => {
    return Array.from(document.querySelectorAll("div.folder-list-item-row"))
      .map((el) => el.textContent?.trim() ?? "")
      .filter(Boolean);
  });
}

export async function listNotes(maxItems = 50, folder?: string): Promise<NoteListItem[]> {
  log(`listNotes() start maxItems=${maxItems} folder=${folder}`);
  const frame = await requireFrame();
  log(`listNotes() got frame url=${frame.url()} isDetached=${frame.isDetached()}`);

  // Always click the target folder — defaults to first row ("All iCloud") so we see everything
  const folderTarget = folder ?? "All iCloud";
  log(`listNotes() clicking folder "${folderTarget}"`);
  try {
    const folderLocator = folder
      ? frame.locator("div.folder-list-item-row").filter({ hasText: new RegExp(folder, "i") }).first()
      : frame.locator("div.folder-list-item-row").first();
    await folderLocator.waitFor({ state: "visible", timeout: 8_000 });
    await folderLocator.click();
    log(`listNotes() folder clicked, waiting for list to update`);
    await frame.waitForTimeout(1500);
  } catch (e) {
    log(`listNotes() folder click failed: ${e} — proceeding anyway`);
  }

  log(`listNotes() waiting for div.note-list-item-title...`);
  try {
    await frame.waitForSelector("div.note-list-item-title", { timeout: 15_000 });
    log(`listNotes() note titles found in DOM`);
  } catch (e) {
    logError("listNotes() waitForSelector timed out", e);
    // Log DOM snapshot to understand what IS there
    const bodySnip = await frame.evaluate(() => document.body?.innerHTML?.slice(0, 2000) ?? "empty").catch(() => "evaluate failed");
    log(`listNotes() frame body snapshot: ${bodySnip}`);
    return [];
  }

  log(`listNotes() starting scroll harvest`);
  // iCloud Notes uses a virtual list — DOM nodes are recycled as you scroll,
  // so we must harvest visible items at each scroll position.
  const { notes: results, dbg } = await frame.evaluate(async ({ maxItems }) => {
    // Use the title element as anchor — div.note-list-item container may not exist
    const anchor = document.querySelector("div.note-list-item-title");
    if (!anchor) return { notes: [], dbg: "no anchor found" };

    // Walk the full ancestor chain and pick the element with the most scrollable content.
    // The "first scrollable ancestor" picks the wrong (tiny) element; we want the notes list pane.
    let scrollable: HTMLElement | null = null;
    let maxScrollable = 0;
    let el: HTMLElement | null = anchor.parentElement;
    while (el && el !== document.body) {
      const diff = el.scrollHeight - el.clientHeight;
      if (diff > maxScrollable) {
        maxScrollable = diff;
        scrollable = el;
      }
      el = el.parentElement;
    }

    const seen = new Map<string, { title: string; preview: string; date: string; index: number }>();

    const harvest = () => {
      document.querySelectorAll("div.note-list-item-title").forEach((titleEl) => {
        const title = titleEl.textContent?.trim() ?? "";
        if (!title || seen.has(title)) return;
        let container: Element | null = titleEl.parentElement;
        for (let i = 0; i < 6; i++) {
          if (container?.querySelector("div.note-list-item-snippet")) break;
          container = container?.parentElement ?? null;
        }
        const preview = container?.querySelector("div.note-list-item-snippet")?.textContent?.trim() ?? "";
        const date = container?.querySelector("div.note-list-item-date")?.textContent?.trim() ?? "";
        seen.set(title, { title, preview, date, index: seen.size });
      });
    };

    if (scrollable) scrollable.scrollTop = 0;
    await new Promise((r) => setTimeout(r, 600));
    harvest();

    let iterations = 0;
    let stopReason = "maxItems";
    if (scrollable) {
      for (let i = 0; i < 100; i++) {
        iterations = i;
        const before = seen.size;
        const prevScrollH = scrollable.scrollHeight;

        // Dispatch wheel event — more reliably triggers SPA lazy-load than scrollTop
        scrollable.dispatchEvent(new WheelEvent("wheel", { deltaY: 600, bubbles: true, cancelable: true }));
        scrollable.scrollTop += 600;

        await new Promise((r) => setTimeout(r, 400));
        harvest();

        const atBottom = scrollable.scrollTop + scrollable.clientHeight >= scrollable.scrollHeight - 10;
        const noNewContent = seen.size === before && scrollable.scrollHeight === prevScrollH;
        if (atBottom && noNewContent) { stopReason = `atBottom(iter=${i} scrollTop=${scrollable.scrollTop} scrollH=${scrollable.scrollHeight} clientH=${scrollable.clientHeight})`; break; }
        if (seen.size >= maxItems) { stopReason = "maxItems"; break; }
      }
      scrollable.scrollTop = 0;
    }

    const dbg = `scrollable=${scrollable?.tagName}.${scrollable?.className?.slice(0,60)} scrollH=${scrollable?.scrollHeight} clientH=${scrollable?.clientHeight} iters=${iterations} stop=${stopReason} found=${seen.size}`;
    return { notes: Array.from(seen.values()).slice(0, maxItems), dbg };
  }, { maxItems });

  log(`listNotes() done, found ${results.length} notes. debug: ${dbg}`);
  return results;
}

export async function getNote(titleOrIndex: string | number): Promise<string> {
  log(`getNote() start titleOrIndex=${titleOrIndex}`);
  const frame = await requireFrame();

  // Ensure full note list is visible by clicking "All iCloud" first
  log(`getNote() clicking All iCloud folder`);
  try {
    const folderLocator = frame.locator("div.folder-list-item-row").first();
    await folderLocator.waitFor({ state: "visible", timeout: 8_000 });
    await folderLocator.click();
    await frame.waitForTimeout(1500);
  } catch (e) {
    log(`getNote() folder click failed: ${e}`);
  }

  const page = frame.page();

  // Clear clipboard now so we can tell if Ctrl+C actually fires
  await page.evaluate(async () => { try { await navigator.clipboard.writeText(""); } catch {} });

  // Capture URL before clicking so we can detect the change
  const prevUrl = page.url();

  log(`getNote() calling clickNoteEval`);
  const clicked = await clickNoteEval(frame, titleOrIndex);
  log(`getNote() clickNoteEval result: ${JSON.stringify(clicked)}`);
  if (!clicked.ok) throw new Error(clicked.error);

  // Wait for the outer page URL to change — reliable signal the note is opening in the canvas
  await page.waitForFunction(
    (prev: string) => window.location.href !== prev,
    prevUrl,
    { timeout: 10_000 }
  ).catch(() => log("getNote() URL didn't change, proceeding anyway"));
  log(`getNote() outer page URL after note open: ${page.url()}`);

  // Give the canvas time to finish rendering the note content
  await page.waitForTimeout(4000);

  // Confirm list selection
  const selected = await frame.evaluate(() => {
    const sel = document.querySelector(".cw-selected, .is-selected");
    return sel ? `${sel.tagName}.${Array.from(sel.classList).slice(0, 4).join(".")}` : "none";
  });
  log(`getNote() selected element: ${selected}`);

  // Physically click the center of the editor pane to focus the canvas (not the off-screen input manager)
  const editorBBox = await frame.locator("div.notes-note-editor-view-controller").boundingBox();
  if (editorBBox && editorBBox.width > 0 && editorBBox.height > 0) {
    const cx = editorBBox.x + editorBBox.width / 2;
    const cy = editorBBox.y + editorBBox.height / 2;
    log(`getNote() clicking editor center (${cx.toFixed(0)}, ${cy.toFixed(0)})`);
    await page.mouse.click(cx, cy);
  } else {
    log(`getNote() editor bbox: ${JSON.stringify(editorBBox)} — falling back to JS focus`);
    await frame.evaluate(() => {
      const el = document.querySelector("div.ct-input-manager div[tabindex='0']") as HTMLElement | null;
      el?.focus();
    });
  }

  await page.waitForTimeout(500);
  await page.keyboard.press("Control+a");
  await page.waitForTimeout(300);
  await page.keyboard.press("Control+c");
  await page.waitForTimeout(500);

  // Read clipboard
  const clipboardContent = await page.evaluate(async () => {
    try {
      return await navigator.clipboard.readText();
    } catch (e) {
      return `clipboard-error: ${String(e)}`;
    }
  });
  log(`getNote() clipboard content length=${clipboardContent.length} preview="${clipboardContent.slice(0, 80).replace(/\n/g, "↵")}"`);

  if (clipboardContent && !clipboardContent.startsWith("clipboard-error") && clipboardContent.trim().length > 0) {
    log(`getNote() returning ${clipboardContent.length} chars`);
    return clipboardContent.trim();
  }

  log("getNote() clipboard empty or failed, returning empty");
  return "";
}

export async function createNote(content: string): Promise<string> {
  const frame = await requireFrame();
  const page = frame.page();

  // Try trusted click on the compose/new-note button (class confirmed: "compose cw-button")
  const newNoteBtn = frame.locator(
    '[class*="compose"][class*="cw-button"], button[title*="Create a note"], button[aria-label*="New Note"], [class*="new-note"]'
  ).first();
  const btnVisible = await newNoteBtn.isVisible().catch(() => false);

  if (btnVisible) {
    log("createNote() clicking New Note button");
    await newNoteBtn.click();
  } else {
    // Fallback: click note list area then Ctrl+N
    log("createNote() button not found, clicking note list then Ctrl+N");
    await frame.locator("div.note-list-item-title").first().click().catch(() => {});
    await page.waitForTimeout(500);
    await page.keyboard.press("Control+n");
  }

  // Wait for a new empty note to open (URL changes to new note)
  const prevUrl = page.url();
  await page.waitForFunction(
    (prev: string) => window.location.href !== prev,
    prevUrl,
    { timeout: 8_000 }
  ).catch(() => log("createNote() URL didn't change after new note trigger"));
  log(`createNote() URL after new note: ${page.url()}`);

  // Give the canvas editor time to initialize for the new note
  await page.waitForTimeout(2000);

  // Focus the editor via trusted click on its center
  const editorBBox = await frame.locator("div.notes-note-editor-view-controller").boundingBox();
  if (editorBBox && editorBBox.width > 0) {
    const cx = editorBBox.x + editorBBox.width / 2;
    const cy = editorBBox.y + editorBBox.height * 0.25; // click upper portion for title area
    log(`createNote() clicking editor at (${cx.toFixed(0)}, ${cy.toFixed(0)})`);
    await page.mouse.click(cx, cy);
  }

  // Write content to clipboard then paste — instant regardless of content length
  await page.evaluate(async (text) => { await navigator.clipboard.writeText(text); }, content);
  await page.waitForTimeout(300);
  await page.keyboard.press("Control+v");
  await page.waitForTimeout(1500);

  return `Note created: "${content.split("\n")[0].trim()}"`;
}

export async function updateNote(
  titleOrIndex: string | number,
  newContent: string,
  mode: "replace" | "append" | "prepend" = "append"
): Promise<string> {
  const frame = await requireFrame();

  // Click All iCloud folder so the full list is visible
  log(`updateNote() clicking All iCloud folder`);
  try {
    const folderLocator = frame.locator("div.folder-list-item-row").first();
    await folderLocator.waitFor({ state: "visible", timeout: 8_000 });
    await folderLocator.click();
    await frame.waitForTimeout(1500);
  } catch (e) {
    log(`updateNote() folder click failed: ${e}`);
  }

  const page = frame.page();
  const prevUrl = page.url();

  const clicked = await clickNoteEval(frame, titleOrIndex);
  if (!clicked.ok) throw new Error(clicked.error);

  // Wait for the outer page URL to change — confirms the note opened in the canvas
  await page.waitForFunction(
    (prev: string) => window.location.href !== prev,
    prevUrl,
    { timeout: 10_000 }
  ).catch(() => log("updateNote() URL didn't change, proceeding anyway"));
  log(`updateNote() outer page URL after note open: ${page.url()}`);

  // Give the canvas time to finish rendering
  await page.waitForTimeout(4000);

  // Physically click the editor center to focus the canvas (same approach as getNote)
  const editorBBox = await frame.locator("div.notes-note-editor-view-controller").boundingBox();
  if (editorBBox && editorBBox.width > 0 && editorBBox.height > 0) {
    const cx = editorBBox.x + editorBBox.width / 2;
    const cy = editorBBox.y + editorBBox.height / 2;
    log(`updateNote() clicking editor center (${cx.toFixed(0)}, ${cy.toFixed(0)})`);
    await page.mouse.click(cx, cy);
  } else {
    log(`updateNote() editor bbox not found, falling back to JS focus`);
    await frame.evaluate(() => {
      const el = document.querySelector("div.ct-input-manager div[tabindex='0']") as HTMLElement | null;
      el?.focus();
    });
  }

  await page.waitForTimeout(500);

  const kb = page.keyboard;
  // Write to clipboard for instant paste regardless of content length
  await page.evaluate(async (text) => { await navigator.clipboard.writeText(text); }, newContent);

  if (mode === "append") {
    await kb.press("Control+End");
    await kb.press("Enter");
    await kb.press("Control+v");
  } else if (mode === "prepend") {
    await kb.press("Control+Home");
    await kb.press("Control+v");
    await kb.press("Enter");
  } else {
    await kb.press("Control+a");
    await kb.press("Delete");
    await kb.press("Control+v");
  }

  await page.waitForTimeout(1500);
  return `Note updated (mode: ${mode}).`;
}

export async function searchNotes(query: string): Promise<NoteListItem[]> {
  const frame = await requireFrame();

  const focused = await frame.evaluate((q) => {
    const input = document.querySelector(
      'input[type="search"], input[placeholder*="earch"], input[aria-label*="earch"]'
    ) as HTMLInputElement | null;
    if (!input) return false;
    input.focus();
    input.value = q;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    return true;
  }, query);

  if (!focused) throw new Error("Search input not found. Run debug_page to inspect selectors.");

  await frame.waitForTimeout(2000);
  const results = await listNotes(30);

  // Clear search
  await frame.evaluate(() => {
    const input = document.querySelector(
      'input[type="search"], input[placeholder*="earch"]'
    ) as HTMLInputElement | null;
    if (input) { input.value = ""; input.dispatchEvent(new Event("input", { bubbles: true })); }
  });

  return results;
}

export async function deleteNote(titleOrIndex: string | number): Promise<string> {
  const frame = await requireFrame();

  const clicked = await clickNoteEval(frame, titleOrIndex);
  if (!clicked.ok) throw new Error(clicked.error);

  await frame.waitForTimeout(800);

  const deleted = await frame.evaluate(() => {
    const btn = document.querySelector(
      'button[aria-label*="Delete"], button[title*="Delete"], [class*="delete"]'
    ) as HTMLElement | null;
    if (!btn) return false;
    btn.click();
    return true;
  });

  if (!deleted) throw new Error("Delete button not found. Delete manually in the browser.");

  // Confirm dialog if it appears
  try {
    const confirmBtn = frame.locator('button:has-text("Delete"), button:has-text("Move to Trash")').first();
    await confirmBtn.waitFor({ timeout: 3000 });
    await confirmBtn.click();
  } catch {
    // no dialog
  }

  await frame.waitForTimeout(1000);
  return "Note deleted.";
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Click a note by index or title using Playwright's locator.click() so the
 * event is trusted (isTrusted=true) — iCloud's SPA ignores programmatic clicks.
 */
async function clickNoteEval(
  frame: Frame,
  titleOrIndex: string | number
): Promise<{ ok: true } | { ok: false; error: string }> {
  // Wait for titles to be present first
  try {
    await frame.locator("div.note-list-item-title").first().waitFor({ state: "visible", timeout: 10_000 });
  } catch {
    return { ok: false, error: "Note list didn't load in time." };
  }

  if (typeof titleOrIndex === "number") {
    // For index-based, scroll until we have enough items then click
    const needed = titleOrIndex + 1;
    for (let i = 0; i < 100; i++) {
      const count = await frame.locator("div.note-list-item-title").count();
      log(`clickNoteEval() index scroll pass ${i}: count=${count} needed=${needed}`);
      if (count >= needed) break;
      const scrolled = await frame.evaluate(() => {
        const anchor = document.querySelector("div.note-list-item-title");
        let el = anchor?.parentElement ?? null;
        let best: HTMLElement | null = null, max = 0;
        while (el && el !== document.body) {
          const d = el.scrollHeight - el.clientHeight;
          if (d > max) { max = d; best = el; }
          el = el.parentElement;
        }
        if (!best) return false;
        const atBottom = best.scrollTop + best.clientHeight >= best.scrollHeight - 10;
        best.scrollTop += 600;
        best.dispatchEvent(new WheelEvent("wheel", { deltaY: 600, bubbles: true }));
        return !atBottom;
      });
      await frame.waitForTimeout(400);
      if (!scrolled) { log(`clickNoteEval() at bottom after ${i} passes`); break; }
    }
    try {
      await frame.locator("div.list-item").nth(titleOrIndex).click({ timeout: 8_000, force: true });
      return { ok: true };
    } catch {
      const count = await frame.locator("div.list-item").count();
      return { ok: false, error: `No note at index ${titleOrIndex} (found ${count} list items).` };
    }
  }

  // Match by title — scroll through the list until found
  const lower = titleOrIndex.toLowerCase();
  log(`clickNoteEval() searching for "${lower}" by scrolling`);
  for (let pass = 0; pass < 80; pass++) {
    const titleEls = await frame.locator("div.note-list-item-title").all();
    for (const titleEl of titleEls) {
      const text = (await titleEl.textContent()) ?? "";
      if (text.toLowerCase().includes(lower)) {
        log(`clickNoteEval() found match "${text}" on pass ${pass}`);
        // Click the list-item container (not just the title) — iCloud's handler is on the parent
        const listItem = frame.locator("div.list-item").filter({
          has: frame.locator("div.note-list-item-title").filter({ hasText: text.trim() })
        }).first();
        const target = (await listItem.count()) > 0 ? listItem : titleEl;
        log(`clickNoteEval() clicking ${(await listItem.count()) > 0 ? "div.list-item" : "div.note-list-item-title"}`);
        await target.click({ timeout: 8_000, force: true });
        return { ok: true };
      }
    }
    // Scroll to load more
    const scrolled = await frame.evaluate(() => {
      const anchor = document.querySelector("div.note-list-item-title");
      let el = anchor?.parentElement ?? null;
      let best: HTMLElement | null = null, max = 0;
      while (el && el !== document.body) {
        const d = el.scrollHeight - el.clientHeight;
        if (d > max) { max = d; best = el; }
        el = el.parentElement;
      }
      if (!best) return false;
      const atBottom = best.scrollTop + best.clientHeight >= best.scrollHeight - 10;
      best.scrollTop += 600;
      best.dispatchEvent(new WheelEvent("wheel", { deltaY: 600, bubbles: true }));
      return !atBottom;
    });
    await frame.waitForTimeout(350);
    if (!scrolled) break;
  }

  return { ok: false, error: `No note found matching "${titleOrIndex}". Try list_notes to see available titles.` };
}
