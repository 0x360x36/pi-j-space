import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { realpathSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { Type } from "typebox";
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

type JspaceParams = {
  action: "seam" | "resume" | "note" | "ship";
  goal?: string;
  core?: string;
  core_slot?: number;
  next?: string;
  check?: string;
  by?: string;
  open?: string;
  settled_by?: string;
  close?: number;
  file?: string;
  text?: string;
};

// python flag name -> tool parameter name (1:1 with jspace.py note flags)
const NOTE_FLAGS: Array<[string, keyof JspaceParams]> = [
  ["--goal", "goal"],
  ["--core", "core"],
  ["--core-slot", "core_slot"],
  ["--next", "next"],
  ["--check", "check"],
  ["--by", "by"],
  ["--open", "open"],
  ["--settled-by", "settled_by"],
  ["--close", "close"],
];

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
      "Needs python3 at runtime.",
    promptSnippet:
      "Record or report the J-Space ledger (goal, core hubs, verified, open, next, ship checks)",
    promptGuidelines: [
      "Use jspace with action seam at every seam in the loop pass, and jspace note to record goal/core/check/open/next exactly as the skill modules specify.",
      "Use jspace ship with a file path (or text) to register-check anything about to leave for a person.",
    ],
    parameters: Type.Object({
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
    }),
    async execute(
      _toolCallId: string,
      params: JspaceParams,
      signal: AbortSignal | undefined,
      _onUpdate,
      ctx: ExtensionContext,
    ) {
      const args = [CONTROLLER, params.action];

      if (params.action === "note") {
        for (const [flag, key] of NOTE_FLAGS) {
          const value = params[key];
          if (value !== undefined) args.push(flag, String(value));
        }
      } else if (
        params.action === "ship" &&
        params.text !== undefined &&
        params.file === undefined
      ) {
        // Equivalent of `ship -` (stdin): hand the exact text to the controller
        // through a throwaway file so no workspace pollution is needed. The temp
        // file must outlive the python run — await before cleaning up.
        const dir = await mkdtemp(join(tmpdir(), "jspace-"));
        const tmpFile = join(dir, "outgoing.txt");
        await writeFile(tmpFile, params.text, "utf8");
        args.push(tmpFile);
        try {
          const result = await runController(pi, args, ctx, signal);
          return result;
        } finally {
          await rm(dir, { recursive: true, force: true });
        }
      } else if (params.action === "ship" && params.file !== undefined) {
        args.push(params.file.trim().replace(/^@/, ""));
      }

      return runController(pi, args, ctx, signal);
    },
  });

  pi.registerCommand("jspace-verify", {
    description:
      "Run the suite's authoring-time integrity checks (one entry, one premise, nine modules, no version talk)",
    handler: async (_args, ctx) => {
      const res = await pi.exec("python3", [VERIFIER], { cwd: ROOT });
      const out = [res.stdout, res.stderr].filter(Boolean).join("\n").trim();
      if (res.code !== 0) {
        ctx.ui.notify("verify_suite found issues", "error");
        ctx.ui.setWidget("jspace-verify", out.split("\n").slice(0, 12));
        return;
      }
      ctx.ui.notify("verify_suite clean", "info");
    },
  });
}

async function runController(
  pi: ExtensionAPI,
  args: string[],
  ctx: ExtensionContext,
  signal: AbortSignal | undefined,
) {
  const res = await pi.exec("python3", args, {
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
}
