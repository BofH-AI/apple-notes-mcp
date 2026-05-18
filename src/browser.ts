import { chromium, BrowserContext, Page, Frame } from "playwright";
import { join } from "path";
import { mkdirSync } from "fs";
import { log, logError } from "./log.js";

const PROFILE_DIR = join(
  process.env.APPDATA ?? join(process.env.USERPROFILE ?? "C:\\Users\\Default", "AppData", "Roaming"),
  "apple-notes-mcp",
  "browser-profile"
);

const ICLOUD_NOTES_URL = "https://www.icloud.com/notes/";

export class BrowserManager {
  private ctx: BrowserContext | null = null;
  private page: Page | null = null;
  private _lockChain: Promise<void> = Promise.resolve();

  /** Serialize all browser operations — prevents concurrent tool calls from racing. */
  async withLock<T>(fn: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((res) => { release = res; });
    const prev = this._lockChain;
    this._lockChain = next;
    await prev;
    log("withLock() acquired");
    try {
      return await fn();
    } finally {
      log("withLock() released");
      release();
    }
  }

  async getPage(): Promise<Page> {
    if (this.page && !this.page.isClosed()) {
      return this.page;
    }

    if (!this.ctx) {
      log("Launching Chromium persistent context...");
      mkdirSync(PROFILE_DIR, { recursive: true });
      this.ctx = await chromium.launchPersistentContext(PROFILE_DIR, {
        headless: false,
        timeout: 30_000,
        viewport: { width: 1280, height: 900 },
        args: ["--no-sandbox"],
      });
      // Grant clipboard access so we can read text copied via Ctrl+C in the canvas editor
      await this.ctx.grantPermissions(["clipboard-read", "clipboard-write"], {
        origin: "https://www.icloud.com",
      });
      log("Chromium launched.");
    }

    const pages = this.ctx.pages();
    this.page = pages.length > 0 ? pages[0] : await this.ctx.newPage();
    log(`getPage() → url=${this.page.url()}`);
    return this.page;
  }

  async navigateToNotes(): Promise<{ page: Page; needsLogin: boolean }> {
    const page = await this.getPage();
    const url = page.url();
    log(`navigateToNotes() current url=${url}`);

    if (!url.startsWith("https://www.icloud.com/notes")) {
      log("Navigating to iCloud Notes...");
      await page.goto(ICLOUD_NOTES_URL, { waitUntil: "domcontentloaded", timeout: 30_000 });
    }

    await page.waitForTimeout(2000);

    const finalUrl = page.url();
    const needsLogin =
      finalUrl.includes("appleid.apple.com") ||
      finalUrl.includes("idmsa.apple.com") ||
      finalUrl.includes("signin") ||
      finalUrl.includes("login");

    log(`navigateToNotes() finalUrl=${finalUrl} needsLogin=${needsLogin}`);
    return { page, needsLogin };
  }

  /** Return the notes iframe Frame, waiting up to `timeout` ms for it to appear. */
  async getNotesFrame(timeout = 20_000): Promise<Frame> {
    const page = await this.getPage();
    log("getNotesFrame() waiting for iframe...");

    await page.waitForSelector("iframe", { timeout });

    const allFrames = page.frames();
    log(`getNotesFrame() page.frames() count=${allFrames.length}: ${allFrames.map(f => f.url()).join(" | ")}`);

    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const frame = page.frames().find(
        (f) => f !== page.mainFrame() && f.url().length > 0
      );
      if (frame) {
        log(`getNotesFrame() found frame url=${frame.url()}`);
        await frame.waitForLoadState("domcontentloaded").catch((e) => log(`waitForLoadState error: ${e}`));
        log(`getNotesFrame() frame load state done`);
        return frame;
      }
      await page.waitForTimeout(300);
    }

    throw new Error("Notes iframe not found. Make sure iCloud.com/notes is open and loaded.");
  }

  async show(): Promise<void> {
    const page = await this.getPage();
    await page.bringToFront();
  }

  async close(): Promise<void> {
    try {
      await this.ctx?.close();
    } catch {
      // ignore
    }
    this.ctx = null;
    this.page = null;
  }

  get profileDir(): string {
    return PROFILE_DIR;
  }

  /** True only if the browser is already running — doesn't launch it. */
  get isRunning(): boolean {
    return this.ctx !== null && this.page !== null && !this.page.isClosed();
  }
}

export const browser = new BrowserManager();
