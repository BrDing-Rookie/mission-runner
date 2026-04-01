import { definePluginEntry } from "openclaw/plugin-sdk/core";
import type { AnyAgentTool } from "openclaw/plugin-sdk/plugin-runtime";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCRIPTS_DIR = join(__dirname, "scripts");
const LOCAL_TSX = join(__dirname, "node_modules", ".bin", "tsx");

/**
 * Execute a mission-runner script via tsx and return the result.
 * Uses execFileSync (no shell) to avoid shell-injection risks from user-supplied args.
 */
function runScript(scriptName: string, args: string[]): { exitCode: number; output: string } {
  const tsxBin = existsSync(LOCAL_TSX) ? LOCAL_TSX : "tsx";
  try {
    const output = execFileSync(tsxBin, [join(SCRIPTS_DIR, scriptName), ...args], {
      cwd: __dirname,
      encoding: "utf-8",
      timeout: 120_000,
      env: { ...process.env, MISSION_NOTIFICATION_ADAPTER: process.env.MISSION_NOTIFICATION_ADAPTER || "console" },
    });
    return { exitCode: 0, output: output.trim() };
  } catch (err: unknown) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return {
      exitCode: e.status ?? 1,
      output: (e.stdout || "") + (e.stderr || ""),
    };
  }
}

function createMissionTool(opts: {
  name: string;
  label: string;
  description: string;
  script: string;
  buildArgs: (params: Record<string, unknown>, missionsDir: string) => string[];
}): AnyAgentTool {
  return {
    name: opts.name,
    label: opts.label,
    description: opts.description,
    parameters: {
      type: "object",
      properties: {
        missions_dir: {
          type: "string",
          description: "Missions storage directory path. Defaults to ./missions in the workspace.",
        },
        args: {
          type: "object",
          description: "Script-specific arguments.",
          additionalProperties: true,
        },
      },
    },
    execute: async (_toolCallId: string, rawArgs: Record<string, unknown>) => {
      const params = (rawArgs.args ?? rawArgs) as Record<string, unknown>;
      const defaultMissionsDir = typeof params.__default_missions_dir === "string" ? params.__default_missions_dir : "./missions";
      const missionsDir = typeof rawArgs.missions_dir === "string" ? rawArgs.missions_dir : defaultMissionsDir;
      const scriptArgs = opts.buildArgs(params, missionsDir);
      const result = runScript(opts.script, scriptArgs);
      return {
        type: "text" as const,
        text: JSON.stringify(result),
        details: result,
      };
    },
  } as AnyAgentTool;
}

// --- Tool definitions ---

const missionStart = createMissionTool({
  name: "mission_start",
  label: "Mission Start",
  description: "Create and start a new mission (create → plan → dispatch). Provide a title and goal.",
  script: "mission-start.ts",
  buildArgs: (p, dir) => [
    "--missions-dir", dir,
    ...(typeof p.title === "string" ? ["--title", p.title] : []),
    ...(typeof p.goal === "string" ? ["--goal", p.goal] : []),
  ],
});

const missionOrchestrate = createMissionTool({
  name: "mission_orchestrate",
  label: "Mission Orchestrate",
  description: "Run the orchestration loop: watchdog evaluates → dispatch/run-action → repeat. Drives a mission forward up to max-steps.",
  script: "mission-orchestrate.ts",
  buildArgs: (p, dir) => [
    "--missions-dir", dir,
    ...(typeof p.mission_id === "string" ? ["--mission-id", p.mission_id] : []),
    ...(typeof p.max_steps === "number" ? ["--max-steps", String(p.max_steps)] : []),
  ],
});

const missionVerify = createMissionTool({
  name: "mission_verify",
  label: "Mission Verify",
  description: "Verify whether a mission meets its completion criteria.",
  script: "mission-verify.ts",
  buildArgs: (p, dir) => [
    "--missions-dir", dir,
    ...(typeof p.mission_id === "string" ? ["--mission-id", p.mission_id] : []),
  ],
});

const missionWatchdog = createMissionTool({
  name: "mission_watchdog",
  label: "Mission Watchdog",
  description: "Scan all missions and output recommended next actions. Use --dry-run to preview without changes.",
  script: "mission-watchdog.ts",
  buildArgs: (p, dir) => [
    "--missions-dir", dir,
    ...(p.dry_run === true ? ["--dry-run"] : []),
  ],
});

const missionRunAction = createMissionTool({
  name: "mission_run_action",
  label: "Mission Run Action",
  description: "Execute a specific watchdog-recommended action on a mission.",
  script: "mission-run-action.ts",
  buildArgs: (p, dir) => [
    "--missions-dir", dir,
    ...(typeof p.mission_id === "string" ? ["--mission-id", p.mission_id] : []),
    ...(typeof p.action === "string" ? ["--action", p.action] : []),
  ],
});

const missionDispatch = createMissionTool({
  name: "mission_dispatch",
  label: "Mission Dispatch",
  description: "Dispatch READY tasks in a mission to execution. Uses three-level fallback strategy: L1 (mention in chat) → L2 (create session + mention) → L3 (spawn fallback). Returns dispatch summary with level breakdown.",
  script: "mission-dispatch.ts",
  buildArgs: (p, dir) => [
    "--missions-dir", dir,
    ...(typeof p.mission_id === "string" ? ["--mission-id", p.mission_id] : []),
  ],
});

const taskUpdate = createMissionTool({
  name: "mission_task_update",
  label: "Task Update",
  description: "Update a task's status (e.g., mark COMPLETED with summary and artifact path).",
  script: "task-update.ts",
  buildArgs: (p, dir) => [
    "--missions-dir", dir,
    ...(typeof p.mission_id === "string" ? ["--mission-id", p.mission_id] : []),
    ...(typeof p.task_id === "string" ? ["--task-id", p.task_id] : []),
    ...(typeof p.status === "string" ? ["--status", p.status] : []),
    ...(typeof p.summary === "string" ? ["--summary", p.summary] : []),
    ...(typeof p.artifact === "string" ? ["--artifact", p.artifact] : []),
  ],
});

const taskAdd = createMissionTool({
  name: "mission_task_add",
  label: "Task Add",
  description: "Dynamically add a new task to a running mission.",
  script: "task-add.ts",
  buildArgs: (p, dir) => [
    "--missions-dir", dir,
    ...(typeof p.mission_id === "string" ? ["--mission-id", p.mission_id] : []),
    ...(typeof p.task_id === "string" ? ["--task-id", p.task_id] : []),
    ...(typeof p.title === "string" ? ["--title", p.title] : []),
    ...(typeof p.type === "string" ? ["--type", p.type] : []),
    ...(typeof p.depends_on === "string" ? ["--depends-on", p.depends_on] : []),
  ],
});

// --- Plugin Entry ---

export default definePluginEntry({
  id: "mission-runner",
  name: "Mission Runner",
  description: "Autonomous mission orchestration for OpenClaw agents — plan, dispatch, verify, recover.",
  register(api) {
    const defaultMissionsDir = typeof api.pluginConfig?.missionsDir === "string" && api.pluginConfig.missionsDir.trim()
      ? api.pluginConfig.missionsDir
      : "./missions";

    const withDefaultMissionsDir = (tool: AnyAgentTool): AnyAgentTool => ({
      ...tool,
      execute: async (toolCallId: string, rawArgs: Record<string, unknown>) => {
        const baseArgs = rawArgs ?? {};
        const argsWithDefault = {
          ...baseArgs,
          args: {
            ...((baseArgs.args ?? baseArgs) as Record<string, unknown>),
            __default_missions_dir: defaultMissionsDir,
          },
        };
        return tool.execute(toolCallId, argsWithDefault);
      },
    });

    // Register mission tools
    api.registerTool(withDefaultMissionsDir(missionStart));
    api.registerTool(withDefaultMissionsDir(missionOrchestrate));
    api.registerTool(withDefaultMissionsDir(missionVerify));
    api.registerTool(withDefaultMissionsDir(missionWatchdog));
    api.registerTool(withDefaultMissionsDir(missionRunAction));
    api.registerTool(withDefaultMissionsDir(missionDispatch));
    api.registerTool(withDefaultMissionsDir(taskUpdate));
    api.registerTool(withDefaultMissionsDir(taskAdd));
  },
});
