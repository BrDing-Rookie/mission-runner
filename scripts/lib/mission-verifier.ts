/**
 * mission-verifier.ts — Core verification logic
 *
 * Extracted from mission-verify.ts: plan criteria extraction, artifact
 * file listing, criterion evaluation, and verification result computation.
 * Includes structuralVerify for automated checks (tests, artifacts, file existence).
 * Includes LLM-powered criterion evaluation via evaluateCriterionWithLlm.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CompletionCriterion, Mission, MissionStatus, VerificationStatus } from './types.ts';
import { loadTextIfExists, missionPath, setMissionStatus, setVerification, upsertArtifact } from './mission-helpers.ts';
import type { LlmClient } from './llm-client.ts';

// ── Types ──────────────────────────────────────────────────────────────────────

export type CriterionResult = {
  criterionId: string;
  passed: boolean;
  reason: string;
};

export interface VerifyResult {
  missionId: string;
  verificationStatus: VerificationStatus;
  missionStatus: MissionStatus;
  gaps: string[];
  criteriaResults: CriterionResult[];
  structuralChecks?: StructuralCheck[];
  success: boolean;
  changed: boolean;
  dryRun: boolean;
}

// ── Plan Criteria Extraction ───────────────────────────────────────────────────

/**
 * Extract custom completion criteria from plan.md.
 * Looks for numbered list items under "## Completion Criteria" or "## 完成标准".
 */
export function extractPlanCriteria(planText: string): string[] {
  const criteria: string[] = [];
  const lines = planText.split('\n');
  let inCriteriaSection = false;

  for (const line of lines) {
    const headingMatch = line.match(/^##\s+(.*)$/);
    if (headingMatch) {
      const heading = headingMatch[1].toLowerCase().trim();
      inCriteriaSection = heading.includes('completion criteria') || heading.includes('完成标准') || heading.includes('验收标准');
      continue;
    }

    if (inCriteriaSection) {
      const itemMatch = line.match(/^\s*(?:\d+\.|\-|\*)\s*(?:\[.\]\s*)?(.+)/);
      if (itemMatch) {
        criteria.push(itemMatch[1].trim());
      }
    }
  }

  return criteria;
}

// ── Artifact File Listing ──────────────────────────────────────────────────────

/**
 * List artifact files in the mission artifacts directory.
 */
export function listArtifactFiles(missionsDir: string, missionId: string): string[] {
  const artifactsDir = join(missionsDir, missionId, 'artifacts');
  if (!existsSync(artifactsDir)) return [];

  const files: string[] = [];
  try {
    const entries = readdirSync(artifactsDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(artifactsDir, entry.name);
      if (entry.isFile()) {
        files.push(fullPath);
      } else if (entry.isDirectory()) {
        try {
          const subEntries = readdirSync(fullPath, { recursive: true });
          for (const sub of subEntries) {
            files.push(join(fullPath, String(sub)));
          }
        } catch { /* ignore unreadable dirs */ }
      }
    }
  } catch { /* ignore */ }
  return files;
}

// ── Artifact Existence Check ───────────────────────────────────────────────────

function artifactFileExists(missionsDir: string, missionId: string, artifactPath: string): boolean {
  if (existsSync(artifactPath)) return true;

  const missionPrefix = `missions/${missionId}/`;
  const stripped = artifactPath.startsWith(missionPrefix)
    ? artifactPath.slice(missionPrefix.length)
    : artifactPath;

  const missionDir = join(missionsDir, missionId);
  if (existsSync(join(missionDir, stripped))) return true;
  if (existsSync(join(missionsDir, artifactPath))) return true;
  if (existsSync(join(missionsDir, '..', artifactPath))) return true;

  return false;
}

// ── Criterion Evaluation ───────────────────────────────────────────────────────

export function evaluateCriterion(criterion: CompletionCriterion, context: {
  hasPlan: boolean;
  hasArtifacts: boolean;
  hasPendingTasks: boolean;
  hasFailedTasks: boolean;
  planCriteria: string[];
  artifactFiles: string[];
  missionArtifacts: string[];
  missionsDir: string;
  missionId: string;
}): CriterionResult {
  if (criterion.verified === true) {
    return { criterionId: criterion.id, passed: true, reason: 'Criterion already explicitly marked verified=true.' };
  }

  const expected = `${criterion.id} ${criterion.description}`.toLowerCase();
  const mentionsPlan = expected.includes('plan');
  const mentionsArtifact = ['artifact', 'deliverable', 'output', '交付物', '产出'].some((token) => expected.includes(token));
  const mentionsFile = ['file', '文件', 'exists', 'exist', 'present', '生成'].some((token) => expected.includes(token));
  const needsTerminalTasks = (criterion.required ?? false) || !mentionsPlan;

  const reasons: string[] = [];
  if (mentionsPlan && !context.hasPlan) reasons.push('plan.md artifact is missing');
  if (mentionsArtifact && !context.hasArtifacts) reasons.push('mission artifacts are missing deliverables beyond plan.md/verification.md');
  if (needsTerminalTasks && context.hasPendingTasks) reasons.push('not all tasks are in terminal states');
  if (context.hasFailedTasks) reasons.push('failed tasks are present');

  if (mentionsFile || mentionsArtifact) {
    const referencedFiles = context.missionArtifacts;
    if (referencedFiles.length === 0 && context.artifactFiles.length === 0) {
      reasons.push('no artifact files found on disk');
    } else {
      for (const artPath of referencedFiles) {
        if (!artifactFileExists(context.missionsDir, context.missionId, artPath)) {
          reasons.push(`referenced artifact not found on disk: ${artPath}`);
        }
      }
    }
  }

  return {
    criterionId: criterion.id,
    passed: reasons.length === 0,
    reason: reasons.length === 0 ? 'Satisfied by current mission state under enhanced verification rules.' : reasons.join('; '),
  };
}

// ── LLM-Powered Criterion Evaluation ─────────────────────────────────────────

/**
 * Build a compact mission context summary for LLM consumption.
 * Only includes key facts — not the full mission JSON.
 */
function buildMissionContextSummary(context: {
  hasPlan: boolean;
  hasArtifacts: boolean;
  hasPendingTasks: boolean;
  hasFailedTasks: boolean;
  planCriteria: string[];
  artifactFiles: string[];
  missionArtifacts: string[];
  missionId: string;
  taskSummary?: string;
}): string {
  const lines: string[] = [
    `Mission ID: ${context.missionId}`,
    `Plan present: ${context.hasPlan}`,
    `Has artifacts (non-meta): ${context.hasArtifacts}`,
    `Has pending (non-terminal) tasks: ${context.hasPendingTasks}`,
    `Has failed tasks: ${context.hasFailedTasks}`,
  ];

  if (context.planCriteria.length > 0) {
    lines.push(`Plan-defined criteria (${context.planCriteria.length}): ${context.planCriteria.slice(0, 5).join(' | ')}`);
  }

  if (context.missionArtifacts.length > 0) {
    lines.push(`Registered artifacts: ${context.missionArtifacts.slice(0, 10).join(', ')}`);
  }

  if (context.artifactFiles.length > 0) {
    lines.push(`Artifact files on disk (${context.artifactFiles.length}): ${context.artifactFiles.slice(0, 5).join(', ')}`);
  }

  if (context.taskSummary) {
    lines.push(`Task summary: ${context.taskSummary}`);
  }

  return lines.join('\n');
}

/**
 * Evaluate a single completion criterion using an LLM.
 * Falls back to heuristic evaluateCriterion on LLM failure or invalid response.
 */
export async function evaluateCriterionWithLlm(
  criterion: CompletionCriterion,
  context: {
    hasPlan: boolean;
    hasArtifacts: boolean;
    hasPendingTasks: boolean;
    hasFailedTasks: boolean;
    planCriteria: string[];
    artifactFiles: string[];
    missionArtifacts: string[];
    missionsDir: string;
    missionId: string;
    taskSummary?: string;
  },
  llmClient: LlmClient,
): Promise<CriterionResult> {
  // Short-circuit: already verified
  if (criterion.verified === true) {
    return { criterionId: criterion.id, passed: true, reason: 'Criterion already explicitly marked verified=true.' };
  }

  const systemPrompt = `You are a mission completion evaluator. Given a completion criterion and the current mission state, determine if the criterion is satisfied.

Respond with ONLY a JSON object (no markdown, no code fences) in this exact format:
{"passed": true, "reason": "brief explanation"}
or
{"passed": false, "reason": "brief explanation of what is missing"}

Be concise. The reason should be 1-2 sentences maximum.`;

  const missionContext = buildMissionContextSummary(context);

  const userPrompt = `Criterion ID: ${criterion.id}
Criterion description: ${criterion.description}
Required: ${criterion.required ?? true}

Current mission state:
${missionContext}

Evaluate whether this criterion is satisfied based on the mission state above. Respond with JSON only.`;

  try {
    const response = await llmClient.complete(systemPrompt, userPrompt);
    const content = response.content.trim()
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/, '')
      .trim();

    // Parse JSON response
    let parsed: { passed?: unknown; reason?: unknown };
    try {
      parsed = JSON.parse(content) as { passed?: unknown; reason?: unknown };
    } catch {
      // Invalid JSON — fall back to heuristic
      console.warn(`[evaluateCriterionWithLlm] Invalid JSON response for criterion ${criterion.id}, falling back to heuristic`);
      return evaluateCriterion(criterion, context);
    }

    // Validate response shape
    if (typeof parsed.passed !== 'boolean' || typeof parsed.reason !== 'string') {
      console.warn(`[evaluateCriterionWithLlm] Unexpected response shape for criterion ${criterion.id}, falling back to heuristic`);
      return evaluateCriterion(criterion, context);
    }

    return {
      criterionId: criterion.id,
      passed: parsed.passed,
      reason: `[LLM] ${parsed.reason}`,
    };
  } catch (err) {
    // LLM call failed — graceful fallback
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[evaluateCriterionWithLlm] LLM call failed for criterion ${criterion.id}: ${message}, falling back to heuristic`);
    return evaluateCriterion(criterion, context);
  }
}

// ── Verification Markdown ──────────────────────────────────────────────────────

export function buildVerificationMarkdown(
  mission: Mission,
  verificationStatus: VerificationStatus,
  verificationSummary: string,
  criterionResults: CriterionResult[],
  completionCriteria: CompletionCriterion[],
  planCriteria: string[],
  artifactFiles: string[],
  gaps: string[],
  currentIteration: number,
  maxIterations: number,
  completedTasks: number,
  totalTasks: number,
  structuralChecks?: StructuralCheck[],
): string {
  const lines = [
    `# Verification for ${mission.missionId}`,
    '',
    `- status: ${verificationStatus}`,
    `- completedTasks: ${completedTasks}/${totalTasks}`,
    `- completionCriteriaSatisfied: ${criterionResults.filter((r) => r.passed).length}/${completionCriteria.length}`,
    `- iteration: ${currentIteration}/${maxIterations === Number.MAX_SAFE_INTEGER ? '∞' : maxIterations}`,
    `- artifactFiles: ${artifactFiles.length}`,
    `- planCriteriaFound: ${planCriteria.length}`,
    '',
    '## Summary',
    verificationSummary,
    '',
    '## Completion Criteria',
    ...(criterionResults.length === 0
      ? ['- none declared']
      : criterionResults.map((result) => {
          const criterion = completionCriteria.find((item) => item.id === result.criterionId);
          const required = criterion?.required === false ? 'optional' : 'required';
          const state = result.passed ? 'PASS' : 'GAP';
          const autoTag = criterion ? `[${classifyCriterion(criterion.description)}]` : '[MANUAL]';
          return `- [${state}] ${autoTag} ${result.criterionId} (${required}): ${criterion?.description ?? 'Unknown criterion'} — ${result.reason}`;
        })),
    '',
  ];

  // Structural verification section
  if (structuralChecks && structuralChecks.length > 0) {
    lines.push('## Structural Verification');
    for (const check of structuralChecks) {
      const icon = check.passed === true ? '✅' : check.passed === false ? '❌' : '⏸️';
      lines.push(`- ${icon} [${check.type}] ${check.criterion} — ${check.reason}`);
    }
    lines.push('');
  }

  lines.push(
    '## Plan-Defined Criteria',
    ...(planCriteria.length === 0
      ? ['- none found in plan.md']
      : planCriteria.map((c, i) => `${i + 1}. ${c}`)),
    '',
    '## Artifact Files',
    ...(artifactFiles.length === 0
      ? ['- no artifact files found']
      : artifactFiles.map((f) => `- ${f}`)),
    '',
    '## Gaps',
    ...(gaps.length === 0 ? ['- none'] : gaps.map((gap) => `- ${gap}`)),
    '',
  );

  return lines.join('\n');
}

// ── Structural (Automated) Verification ────────────────────────────────────────

/** Keywords that indicate a criterion can be auto-verified */
const AUTO_VERIFY_KEYWORDS = [
  '测试通过', '测试全通过', 'tests pass', 'test pass', 'npm test',
  '文件存在', 'file exist', 'files exist',
  '目录', 'directory', 'folder',
  '已删除', 'deleted', 'removed',
  '不超过', '≤', '<=', 'at most', 'no more than',
];

export interface StructuralCheck {
  criterion: string;
  type: 'AUTO' | 'MANUAL';
  passed: boolean | null;  // null = not checked (MANUAL)
  reason: string;
}

/**
 * Classify a completion criterion as AUTO or MANUAL based on keyword matching.
 */
export function classifyCriterion(description: string): 'AUTO' | 'MANUAL' {
  const lower = description.toLowerCase();
  return AUTO_VERIFY_KEYWORDS.some((kw) => lower.includes(kw)) ? 'AUTO' : 'MANUAL';
}

/**
 * Shell metacharacters that could enable injection attacks.
 * Presence of any of these in a test command causes immediate rejection.
 */
const SHELL_META_CHARS = /[;|&$`><]/;

/**
 * Whitelist pattern for safe test commands.
 * Only allows: npm test, npm run <script>, npx <pkg>, node <file>
 */
const SAFE_COMMAND_PATTERN = /^(npm\s+(test|run\s+[\w:.-]+)|npx\s+[\w@/.:-]+|node\s+[\w/.:-]+)/;

/**
 * Run structural (automated) verification checks.
 *
 * 1. If mission dir has `test-command.txt`, read and execute it → check exit code
 * 2. If tasks have artifacts, check files exist on disk
 * 3. For completion criteria with auto-verifiable keywords, attempt verification
 */
export function structuralVerify(missionsDir: string, mission: Mission): StructuralCheck[] {
  const results: StructuralCheck[] = [];
  const missionDir = join(missionsDir, mission.missionId);

  // ── 1. Test command ──────────────────────────────────────────────────────
  const testCommandFile = join(missionDir, 'test-command.txt');
  if (existsSync(testCommandFile)) {
    const testCommand = readFileSync(testCommandFile, 'utf-8').trim();
    if (testCommand) {
      // Security: reject commands containing shell metacharacters
      if (SHELL_META_CHARS.test(testCommand)) {
        results.push({
          criterion: `Test: ${testCommand}`,
          type: 'AUTO',
          passed: false,
          reason: `Blocked: test command contains shell metacharacters (;|&$\`><) which are not permitted`,
        });
      } else if (!SAFE_COMMAND_PATTERN.test(testCommand)) {
        // Security: reject commands that don't match the safe whitelist
        results.push({
          criterion: `Test: ${testCommand}`,
          type: 'AUTO',
          passed: false,
          reason: `Blocked: test command does not match allowed patterns (npm test/run, npx, node)`,
        });
      } else {
        let passed = false;
        let reason = '';
        try {
          execFileSync('bash', ['-c', testCommand], {
            timeout: 120_000,
            encoding: 'utf-8',
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: join(missionsDir, '..'),  // project root
          });
          passed = true;
          reason = `Test command succeeded: \`${testCommand}\``;
        } catch (err) {
          const e = err as { status?: number; stderr?: string };
          reason = `Test command failed (exit ${e.status ?? 'unknown'}): \`${testCommand}\``;
        }
        results.push({ criterion: `Test: ${testCommand}`, type: 'AUTO', passed, reason });
      }
    }
  }

  // ── 2. Task artifact existence ───────────────────────────────────────────
  const tasks = mission.tasks ?? [];
  for (const task of tasks) {
    const taskArtifacts = task.artifacts ?? [];
    for (const artifact of taskArtifacts) {
      const artPath = artifact.path;
      const exists = existsSync(artPath)
        || existsSync(join(missionDir, artPath))
        || existsSync(join(missionsDir, '..', artPath));
      results.push({
        criterion: `Artifact exists: ${artPath} (task ${task.taskId})`,
        type: 'AUTO',
        passed: exists,
        reason: exists ? `File found: ${artPath}` : `File NOT found: ${artPath}`,
      });
    }
  }

  // ── 3. Auto-verifiable completion criteria ───────────────────────────────
  const completionCriteria = mission.completionCriteria ?? [];
  for (const criterion of completionCriteria) {
    const kind = classifyCriterion(criterion.description);
    if (kind === 'MANUAL') {
      results.push({
        criterion: criterion.description,
        type: 'MANUAL',
        passed: criterion.verified === true ? true : null,
        reason: criterion.verified === true ? 'Manually marked verified' : 'Requires manual verification',
      });
    } else {
      // Auto criterion — attempt basic checks
      const lower = criterion.description.toLowerCase();
      let passed: boolean | null = null;
      let reason = 'Auto-check inconclusive';

      if (lower.includes('测试通过') || lower.includes('tests pass') || lower.includes('test pass') || lower.includes('npm test')) {
        // Try running npm test if test-command.txt wasn't present
        if (!existsSync(testCommandFile)) {
          try {
            execFileSync('npm', ['test'], {
              timeout: 120_000,
              encoding: 'utf-8',
              stdio: ['pipe', 'pipe', 'pipe'],
              cwd: join(missionsDir, '..'),
            });
            passed = true;
            reason = 'npm test passed';
          } catch (err) {
            const e = err as { status?: number };
            passed = false;
            reason = `npm test failed (exit ${e.status ?? 'unknown'})`;
          }
        } else {
          // Already checked via test-command.txt
          const testResult = results.find((r) => r.criterion.startsWith('Test:'));
          if (testResult) {
            passed = testResult.passed;
            reason = `Covered by test-command.txt: ${testResult.reason}`;
          }
        }
      } else if (lower.includes('已删除') || lower.includes('deleted') || lower.includes('removed')) {
        // Can't auto-verify deletion without knowing what was deleted
        passed = null;
        reason = 'Deletion check requires specific path — mark manually';
      } else if (lower.includes('文件存在') || lower.includes('file exist')) {
        // Already covered by artifact checks above
        passed = null;
        reason = 'File existence checked via artifact listing';
      }

      results.push({
        criterion: criterion.description,
        type: 'AUTO',
        passed,
        reason,
      });
    }
  }

  return results;
}

// ── Core Verify Logic ──────────────────────────────────────────────────────────

export interface VerifyInput {
  missionsDir: string;
  missionId: string;
  dryRun: boolean;
  /** Only run automated structural checks, skip full verification */
  autoOnly?: boolean;
}

export interface VerifyComputed {
  mission: Mission;
  verificationStatus: VerificationStatus;
  missionStatus: MissionStatus;
  gaps: string[];
  criteriaResults: CriterionResult[];
  structuralChecks: StructuralCheck[];
  verificationMarkdown: string;
  verificationFile: string;
  updatedMission: Mission;
}

// ── Shared Verification Context ───────────────────────────────────────────────

interface VerifyContext {
  tasks: Mission['tasks'] extends undefined ? never[] : NonNullable<Mission['tasks']>;
  completedTasks: number;
  failedTasks: NonNullable<Mission['tasks']>;
  pendingTasks: NonNullable<Mission['tasks']>;
  planText: string | null;
  completionCriteria: NonNullable<Mission['completionCriteria']>;
  missionArtifacts: NonNullable<Mission['artifacts']>;
  nonMetaArtifacts: NonNullable<Mission['artifacts']>;
  planCriteria: string[];
  artifactFiles: string[];
  gaps: string[];
  criterionContext: {
    hasPlan: boolean;
    hasArtifacts: boolean;
    hasPendingTasks: boolean;
    hasFailedTasks: boolean;
    planCriteria: string[];
    artifactFiles: string[];
    missionArtifacts: string[];
    missionsDir: string;
    missionId: string;
    taskSummary: string;
  };
}

/**
 * Gather and compute all shared verification inputs.
 * Called by both computeVerification and computeVerificationWithLlm before
 * their respective criterion evaluation strategies.
 */
function buildVerifyContext(args: VerifyInput, mission: Mission): VerifyContext {
  const tasks = mission.tasks ?? [];
  const completedTasks = tasks.filter((task) => task.status === 'COMPLETED').length;
  const failedTasks = tasks.filter((task) => task.status === 'FAILED');
  const pendingTasks = tasks.filter((task) => !['COMPLETED', 'FAILED', 'SKIPPED'].includes(task.status));
  const planText = loadTextIfExists(missionPath(args.missionsDir, mission.missionId, 'plan.md'));
  const completionCriteria = mission.completionCriteria ?? [];
  const missionArtifacts = mission.artifacts ?? [];
  const nonMetaArtifacts = missionArtifacts.filter((a) => !a.path.endsWith('/plan.md') && a.path !== 'plan.md' && !a.path.endsWith('/verification.md') && a.path !== 'verification.md');

  const planCriteria = planText ? extractPlanCriteria(planText) : [];
  const artifactFiles = listArtifactFiles(args.missionsDir, mission.missionId);

  const gaps: string[] = [];
  if (!planText) gaps.push('Missing plan.md artifact.');
  if (tasks.length === 0) gaps.push('Mission has no planned tasks.');
  if (pendingTasks.length > 0) gaps.push(`Pending non-terminal tasks: ${pendingTasks.map((task) => `${task.taskId}:${task.status}`).join(', ')}`);
  if (failedTasks.length > 0) gaps.push(`Failed tasks present: ${failedTasks.map((task) => task.taskId).join(', ')}`);

  const taskSummary = tasks.length > 0
    ? tasks.map((t) => `${t.taskId}:${t.status}`).join(', ')
    : 'no tasks';

  const criterionContext = {
    hasPlan: Boolean(planText),
    hasArtifacts: nonMetaArtifacts.length > 0,
    hasPendingTasks: pendingTasks.length > 0,
    hasFailedTasks: failedTasks.length > 0,
    planCriteria,
    artifactFiles,
    missionArtifacts: missionArtifacts.map((a) => a.path),
    missionsDir: args.missionsDir,
    missionId: mission.missionId,
    taskSummary,
  };

  return {
    tasks,
    completedTasks,
    failedTasks,
    pendingTasks,
    planText,
    completionCriteria,
    missionArtifacts,
    nonMetaArtifacts,
    planCriteria,
    artifactFiles,
    gaps,
    criterionContext,
  };
}

/**
 * Finalize verification after criterion evaluation is complete.
 * Shared by computeVerification and computeVerificationWithLlm.
 */
function finalizeVerification(
  args: VerifyInput,
  mission: Mission,
  criterionResults: CriterionResult[],
  ctx: VerifyContext,
  summaryLlmSuffix = '',
): VerifyComputed {
  const { completedTasks, completionCriteria, planCriteria, artifactFiles, gaps } = ctx;
  const tasks = ctx.tasks;

  // Append criterion-level gaps
  for (const criterion of completionCriteria) {
    if (criterion.required === false) continue;
    const result = criterionResults.find((item) => item.criterionId === criterion.id);
    if (result && !result.passed) {
      gaps.push(`Completion criterion ${criterion.id} not satisfied: ${result.reason}`);
    }
  }

  if (planCriteria.length > completionCriteria.length) {
    gaps.push(`Plan.md defines ${planCriteria.length} completion criteria but mission has only ${completionCriteria.length}; consider updating mission completionCriteria.`);
  }

  const currentIteration = mission.currentIteration ?? 0;
  const maxIterations = mission.maxIterations ?? Number.MAX_SAFE_INTEGER;
  const iterationLimitReached = gaps.length > 0 && currentIteration >= maxIterations;

  const verificationStatus: VerificationStatus = gaps.length === 0
    ? 'PASS'
    : iterationLimitReached
      ? 'NONRETRYABLE_FAILURE'
      : 'RETRYABLE_GAP';

  if (iterationLimitReached) {
    gaps.push(`Max iterations reached (${currentIteration}/${maxIterations}); mission cannot retry further.`);
  }

  const criteriaPassed = criterionResults.filter((r) => r.passed).length;
  const llmTag = summaryLlmSuffix ? ` ${summaryLlmSuffix}` : '';
  const verificationSummary = gaps.length === 0
    ? `Verification passed with ${completedTasks}/${tasks.length} tasks completed and ${criteriaPassed}/${completionCriteria.length} completion criteria satisfied${llmTag}.`
    : iterationLimitReached
      ? `Verification failed permanently: iteration limit ${maxIterations} reached with ${gaps.length} unresolved gap(s).`
      : `Verification found ${gaps.length} gap(s); completed ${completedTasks}/${tasks.length} tasks and satisfied ${criteriaPassed}/${completionCriteria.length} completion criteria${llmTag}.`;

  // ── Structural verification ───────────────────────────────────────────────
  const structuralChecks = structuralVerify(args.missionsDir, mission);

  const now = new Date().toISOString();
  const verificationFile = missionPath(args.missionsDir, mission.missionId, 'verification.md');

  const verificationMarkdown = buildVerificationMarkdown(
    mission, verificationStatus, verificationSummary,
    criterionResults, completionCriteria, planCriteria, artifactFiles, gaps,
    currentIteration, maxIterations, completedTasks, tasks.length,
    structuralChecks,
  );

  // In auto-only mode, don't change mission status
  if (args.autoOnly) {
    return {
      mission,
      verificationStatus,
      missionStatus: mission.status,
      gaps,
      criteriaResults: criterionResults,
      structuralChecks,
      verificationMarkdown,
      verificationFile,
      updatedMission: mission,
    };
  }

  const newMissionStatus: MissionStatus = verificationStatus === 'PASS'
    ? 'COMPLETED'
    : verificationStatus === 'NONRETRYABLE_FAILURE'
      ? 'FAILED'
      : 'ITERATING';

  const verifiedMission = setVerification(mission, { status: verificationStatus, summary: verificationSummary, gaps, criteriaResults: criterionResults });
  const updatedMission = {
    ...setMissionStatus(verifiedMission, newMissionStatus),
    artifacts: upsertArtifact(verifiedMission.artifacts, { path: `missions/${mission.missionId}/verification.md`, type: 'summary' as const, description: 'Verification result summary', generatedAt: now }),
    nextWakeAt: verificationStatus === 'PASS' || verificationStatus === 'NONRETRYABLE_FAILURE' ? null : now,
    currentIteration: verificationStatus === 'RETRYABLE_GAP' ? currentIteration + 1 : currentIteration,
  };

  return {
    mission,
    verificationStatus,
    missionStatus: newMissionStatus,
    gaps,
    criteriaResults: criterionResults,
    structuralChecks,
    verificationMarkdown,
    verificationFile,
    updatedMission,
  };
}

export function computeVerification(args: VerifyInput, mission: Mission): VerifyComputed {
  const ctx = buildVerifyContext(args, mission);
  const criterionResults = ctx.completionCriteria.map((criterion) => evaluateCriterion(criterion, ctx.criterionContext));
  return finalizeVerification(args, mission, criterionResults, ctx);
}

// ── LLM-Powered Compute Verification ─────────────────────────────────────────

/**
 * Like computeVerification but evaluates each criterion using the LLM.
 * Runs criterion evaluations serially to avoid concurrency complexity.
 * Returns Promise<VerifyComputed>.
 */
export async function computeVerificationWithLlm(
  args: VerifyInput,
  mission: Mission,
  llmClient: LlmClient,
): Promise<VerifyComputed> {
  const ctx = buildVerifyContext(args, mission);

  // Evaluate criteria serially with LLM
  const criterionResults: CriterionResult[] = [];
  for (const criterion of ctx.completionCriteria) {
    const result = await evaluateCriterionWithLlm(criterion, ctx.criterionContext, llmClient);
    criterionResults.push(result);
  }

  return finalizeVerification(args, mission, criterionResults, ctx, '(LLM-evaluated)');
}
