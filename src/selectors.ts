/**
 * CSS selectors for the iCloud.com Notes iframe.
 * Confirmed via debug_page against the live DOM.
 */
export const SEL = {
  // Container for each note row in the list (parent of title/snippet/date)
  noteItem: [
    "div.note-list-item",
    "li.note-list-item",
    // fallback: any element that directly contains a note-list-item-title
    "div:has(> div.note-list-item-title)",
  ],

  noteTitleInList: [
    "div.note-list-item-title",
  ],

  noteSnippetInList: [
    "div.note-list-item-snippet",
  ],

  noteDateInList: [
    "div.note-list-item-date",
  ],

  // The editor pane container — contenteditable appears inside once a note is opened
  editor: [
    "div.notes-note-editor-view-controller [contenteditable='true']",
    "div.notes-note-editor-view-controller [contenteditable]",
    "div.notes-note-editor-view-controller",
    "[contenteditable='true']",
  ],

  newNoteBtn: [
    'button[aria-label*="New Note"]',
    'button[title*="New Note"]',
    '[class*="new-note"]',
    'button[aria-label*="new"]',
  ],

  searchInput: [
    'input[type="search"]',
    'input[placeholder*="earch"]',
    'input[aria-label*="earch"]',
  ],

  deleteNoteBtn: [
    'button[aria-label*="Delete"]',
    'button[title*="Delete"]',
    '[class*="delete"]',
  ],
};

export async function firstFoundInFrame(
  frame: import("playwright").Frame,
  selectors: string[],
  timeout = 5000
): Promise<import("playwright").Locator | null> {
  for (const sel of selectors) {
    try {
      const loc = frame.locator(sel).first();
      await loc.waitFor({ state: "visible", timeout });
      return loc;
    } catch {
      // try next
    }
  }
  return null;
}

/** @deprecated Use firstFoundInFrame */
export async function firstFound(
  page: import("playwright").Page,
  selectors: string[],
  timeout = 5000
): Promise<import("playwright").Locator | null> {
  for (const sel of selectors) {
    try {
      const loc = page.locator(sel).first();
      await loc.waitFor({ state: "visible", timeout });
      return loc;
    } catch {
      // try next
    }
  }
  return null;
}
