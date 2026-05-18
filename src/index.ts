import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  Tool,
} from "@modelcontextprotocol/sdk/types.js";
import { browser } from "./browser.js";
import {
  listFolders,
  listNotes,
  getNote,
  createNote,
  updateNote,
  searchNotes,
  deleteNote,
  debugPage,
} from "./notes.js";

const TOOLS: Tool[] = [
  {
    name: "open_browser",
    description:
      "Open (or bring to front) the iCloud.com/notes browser window. " +
      "Call this first to sign in to iCloud — login is remembered between sessions.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_folders",
    description: "List all Apple Notes folders (e.g. 'All iCloud', 'Notes', custom folders).",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_notes",
    description: "List Apple Notes. Without a folder, clicks the first folder (usually 'All iCloud') to show everything.",
    inputSchema: {
      type: "object",
      properties: {
        max: {
          type: "number",
          description: "Maximum number of notes to return (default 50).",
        },
        folder: {
          type: "string",
          description: "Folder name to list notes from (partial match). Omit for all notes.",
        },
      },
    },
  },
  {
    name: "get_note",
    description: "Get the full text content of a specific Apple Note.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Note title (partial match, case-insensitive). Use this OR index.",
        },
        index: {
          type: "number",
          description: "Zero-based position in the notes list. Use this OR title.",
        },
      },
    },
  },
  {
    name: "create_note",
    description:
      "Create a new Apple Note. The first line of content becomes the note title.",
    inputSchema: {
      type: "object",
      properties: {
        content: {
          type: "string",
          description: "Note content. First line is the title.",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "update_note",
    description: "Update an existing Apple Note by appending, prepending, or replacing its content.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Note title (partial match). Use this OR index.",
        },
        index: {
          type: "number",
          description: "Zero-based position in the notes list. Use this OR title.",
        },
        content: {
          type: "string",
          description: "Text to add or replace.",
        },
        mode: {
          type: "string",
          enum: ["append", "prepend", "replace"],
          description: "How to update: append (default), prepend, or replace all content.",
        },
      },
      required: ["content"],
    },
  },
  {
    name: "search_notes",
    description: "Search Apple Notes by keyword. Returns matching note titles and previews.",
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Search query.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "debug_page",
    description:
      "Dump the current page URL, title, and DOM class names to help diagnose selector issues. " +
      "Use this when other tools fail to find notes.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "delete_note",
    description: "Delete (move to trash) an Apple Note.",
    inputSchema: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Note title (partial match). Use this OR index.",
        },
        index: {
          type: "number",
          description: "Zero-based position in the notes list. Use this OR title.",
        },
      },
    },
  },
];

const server = new Server(
  { name: "apple-notes-pwa", version: "1.0.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  return browser.withLock(async () => {
  try {
    let result: string;

    switch (name) {
      case "open_browser": {
        process.stderr.write("[apple-notes] launching browser...\n");
        await browser.show();
        process.stderr.write("[apple-notes] browser launched, navigating...\n");
        const { needsLogin } = await browser.navigateToNotes();
        process.stderr.write(`[apple-notes] navigation done, needsLogin=${needsLogin}\n`);
        result = needsLogin
          ? "Browser opened. Please sign in to iCloud.com/notes, then call list_notes or another tool."
          : "Browser is open and showing iCloud Notes.";
        break;
      }

      case "list_folders": {
        const folders = await listFolders();
        result = folders.length > 0 ? folders.join("\n") : "No folders found.";
        break;
      }

      case "list_notes": {
        const max = typeof args.max === "number" ? args.max : 50;
        const folder = typeof args.folder === "string" ? args.folder : undefined;
        const notes = await listNotes(max, folder);
        if (notes.length === 0) {
          result = "No notes found (or notes list failed to load).";
        } else {
          result = notes
            .map(
              (n) =>
                `[${n.index}] ${n.title}` +
                (n.preview ? `\n    ${n.preview}` : "") +
                (n.date ? `\n    ${n.date}` : "")
            )
            .join("\n\n");
        }
        break;
      }

      case "get_note": {
        const titleOrIndex = args.title ?? args.index;
        if (titleOrIndex == null) {
          throw new Error("Provide either 'title' (string) or 'index' (number).");
        }
        result = await getNote(titleOrIndex as string | number);
        if (!result) result = "(Note is empty)";
        break;
      }

      case "create_note": {
        if (typeof args.content !== "string") {
          throw new Error("'content' (string) is required.");
        }
        result = await createNote(args.content);
        break;
      }

      case "update_note": {
        const titleOrIndex = args.title ?? args.index;
        if (titleOrIndex == null) {
          throw new Error("Provide either 'title' (string) or 'index' (number).");
        }
        if (typeof args.content !== "string") {
          throw new Error("'content' (string) is required.");
        }
        const mode = (args.mode as "append" | "prepend" | "replace") ?? "append";
        result = await updateNote(titleOrIndex as string | number, args.content, mode);
        break;
      }

      case "search_notes": {
        if (typeof args.query !== "string") {
          throw new Error("'query' (string) is required.");
        }
        const notes = await searchNotes(args.query);
        if (notes.length === 0) {
          result = `No notes found matching "${args.query}".`;
        } else {
          result = `Found ${notes.length} note(s):\n\n` +
            notes
              .map((n) => `[${n.index}] ${n.title}` + (n.preview ? ` — ${n.preview}` : ""))
              .join("\n");
        }
        break;
      }

      case "debug_page": {
        result = await debugPage();
        break;
      }

      case "delete_note": {
        const titleOrIndex = args.title ?? args.index;
        if (titleOrIndex == null) {
          throw new Error("Provide either 'title' (string) or 'index' (number).");
        }
        result = await deleteNote(titleOrIndex as string | number);
        break;
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }

    return { content: [{ type: "text", text: result }] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      content: [{ type: "text", text: `Error: ${msg}` }],
      isError: true,
    };
  }
  }); // withLock
});

// Gracefully close the browser when the server exits
process.on("SIGINT", () => browser.close().finally(() => process.exit(0)));
process.on("SIGTERM", () => browser.close().finally(() => process.exit(0)));

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  process.stderr.write(`Fatal: ${err}\n`);
  process.exit(1);
});
