import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Type, type Static } from "typebox";
import { StringEnum } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

// Extension package root — this repo. Realpath so symlinked copies
// (~/.pi/agent/extensions/...) still resolve skills/ and scripts/.
const ROOT = realpathSync(dirname(fileURLToPath(import.meta.url)));
const CONTROLLER = join(ROOT, "scripts", "jspace.py");
const VERIFIER = join(ROOT, "scripts", "verify_suite.py");
const SKILL = join(ROOT, "skills", "j-space", "SKILL.md");

// ── Schema (source of truth) ───────────────────────────────────────────────
const noteSchema = {
  goal: Type.Optional(
    Type.String({ description: "Set what done means (one line)" }),
  ),
  core: Type.Optional(
    Type.String({ description: 'Add a hub entry "name — one fact"' }),
  ),
  core_slot: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 2,
      description: "Swap a live hub entry slot",
    }),
  ),
  next: Type.Optional(
    Type.String({ description: "Set the single next action (one line)" }),
  ),
  check: Type.Optional(
    Type.String({ description: "Record a verified checkpoint" }),
  ),
  by: Type.Optional(
    Type.String({
      description:
        "What verified the checkpoint + stated coverage (required with check)",
    }),
  ),
  open: Type.Optional(Type.String({ description: "Add an open question" })),
  settled_by: Type.Optional(
    Type.String({
      description: "The cheapest test that could settle the open question",
    }),
  ),
  close: Type.Optional(
    Type.Integer({
      description:
        "Resolve open question number N (requires a checkpoint in the same call)",
    }),
  ),
};

const jspaceSchema = Type.Object({
  action: StringEnum(["seam", "resume", "note", "ship"] as const, {
    description: "What the controller should do",
  }),
  ...noteSchema,
  file: Type.Optional(
    Type.String({
      description:
        "ship: path of the outgoing file (relative to the workspace)",
    }),
  ),
  text: Type.Optional(
    Type.String({
      description:
        "ship: outgoing text directly, when there is no file yet (like ship -)",
    }),
  ),
});

type JspaceParams = Static<typeof jspaceSchema>;

// python flag name -> tool parameter name (1:1 with jspace.py note flags)
const NOTE_FLAGS = [
  ["--goal", "goal"],
  ["--core", "core"],
  ["--core-slot", "core_slot"],
  ["--next", "next"],
  ["--check", "check"],
  ["--by", "by"],
  ["--open", "open"],
  ["--settled-by", "settled_by"],
  ["--close", "close"],
] as const satisfies ReadonlyArray<[string, keyof JspaceParams]>;

// Strip single leading @ injected by pi's file-mention UX (@path). A real
// file starting with @ is vanishingly rare and can be passed as ./@file.
function cleanShipPath(raw: string): string {
  return raw.trim().replace(/^@/, "");
}

function pushNoteFlags(args: string[], params: JspaceParams): void {
  for (const [flag, key] of NOTE_FLAGS) {
    const value = params[key];
    if (value !== undefined) args.push(flag, String(value));
  }
}

function shipError(text: string) {
  return {
    content: [{ type: "text" as const, text }],
    details: { exitCode: 2 },
  };
}

async function withTempFile<T>(
  content: string,
  fn: (path: string) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "jspace-"));
  const tmpFile = join(dir, "outgoing.txt");
  try {
    await writeFile(tmpFile, content, "utf8");
    return await fn(tmpFile);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function execPython(opts: {
  pi: ExtensionAPI;
  args: string[];
  cwd: string;
  signal?: AbortSignal;
  timeout?: number;
}) {
  const { pi, args, cwd, signal, timeout } = opts;
  const bins = ["python3", "python"] as const;
  let lastError: unknown;
  for (const bin of bins) {
    try {
      const res = await pi.exec(bin, args, { cwd, signal, timeout });
      if (
        res.code === 127 &&
        /not found|No such file/i.test(`${res.stderr} ${res.stdout}`)
      ) {
        lastError = new Error(`${bin} not found (exit 127)`);
        continue;
      }
      return res;
    } catch (err) {
      lastError = err;
      const msg = String((err as Error)?.message ?? err);
      if (/ENOENT|not found|spawn/i.test(msg) && bin === "python3") continue;
      throw err;
    }
  }
  throw lastError ?? new Error("python3/python not found in PATH");
}

async function runController(opts: {
  pi: ExtensionAPI;
  args: string[];
  ctx: ExtensionContext;
  signal?: AbortSignal;
}) {
  const { pi, args, ctx, signal } = opts;
  try {
    const res = await execPython({
      pi,
      args,
      cwd: ctx.cwd,
      signal,
      timeout: 30_000,
    });
    const out = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
    return {
      content: [
        { type: "text" as const, text: out || `(exit ${res.code}, no output)` },
      ],
      details: { exitCode: res.code },
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const hint = /python|ENOENT/i.test(msg)
      ? " — python3/python not found in PATH"
      : "";
    return {
      content: [
        {
          type: "text" as const,
          text: `CANNOT: ${msg}${hint}. Install python3 or ensure it is in PATH.`,
        },
      ],
      details: { exitCode: 2 },
    };
  }
}

export default function (pi: ExtensionAPI) {
  pi.on("resources_discover", () => ({
    skillPaths: [SKILL],
  }));

  pi.registerTool({
    name: "jspace",
    label: "J-Space",
    description:
      "The J-Space workspace ledger controller. Records and reports state in .jspace/ " +
      "of the task workspace (the current directory) so the model can carry goal, core " +
      "hubs, verified checkpoints, open questions, and next action across seams. " +
      "Actions: seam (show the ledger and what has moved since last time), note (record " +
      "goal/core/next/check/open/close), ship (scan a file for inner-register leakage " +
      "before it leaves), resume (full premise + ledger + invariants after a long gap). " +
      "Exit 0 = done; exit 2 = could not do what was asked (the refusal text says why). " +
      "Needs python3 (or python) at runtime.",
    promptSnippet:
      "Record or report the J-Space ledger (goal, core hubs, verified, open, next, ship checks)",
    promptGuidelines: [
      "Use jspace with action seam at every seam in the loop pass, and jspace note to record goal/core/check/open/next exactly as the skill modules specify.",
      "Use jspace ship with a file path (or text) to register-check anything about to leave for a person.",
    ],
    parameters: jspaceSchema,
    async execute(
      _toolCallId: string,
      params: JspaceParams,
      signal: AbortSignal | undefined,
      _onUpdate,
      ctx: ExtensionContext,
    ) {
      if (params.file !== undefined && params.text !== undefined) {
        return shipError(
          "NOT RECORDED: ship takes file OR text, not both. Use file for a path or text for inline content.",
        );
      }

      const args = [CONTROLLER, params.action];

      if (params.action === "note") pushNoteFlags(args, params);

      if (params.action === "ship" && params.text !== undefined) {
        return withTempFile(params.text, async (tmpFile) =>
          runController({ pi, args: [...args, tmpFile], ctx, signal }),
        );
      }

      if (params.action === "ship" && params.file !== undefined) {
        const cleaned = cleanShipPath(params.file);
        if (!cleaned)
          return shipError("NOT RECORDED: ship file must not be empty");
        args.push(cleaned);
      }

      return runController({ pi, args, ctx, signal });
    },
  });

  pi.registerCommand("jspace-verify", {
    description:
      "Run the suite's authoring-time integrity checks (one entry, one premise, nine modules, no version talk)",
    handler: async (_args, ctx) => {
      try {
        const res = await execPython({ pi, args: [VERIFIER], cwd: ROOT });
        const out = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
        if (res.code !== 0) {
          ctx.ui.notify("verify_suite found issues", "error");
          ctx.ui.setWidget("jspace-verify", out.split("\n").slice(0, 12));
          return;
        }
        ctx.ui.notify("verify_suite clean", "info");
        ctx.ui.setWidget("jspace-verify", undefined);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        ctx.ui.notify(`verify_suite: python not found — ${msg}`, "error");
        ctx.ui.setWidget("jspace-verify", [
          `CANNOT: ${msg}`,
          "Install python3/python and ensure it is in PATH.",
        ]);
      }
    },
  });
}
