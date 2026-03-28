#!/usr/bin/env tsx

import type { Mission, Task, TaskStatus } from './types.ts';

export interface DashboardEmbed {
  title: string;
  description: string;
  color: number;
  fields: Array<{ name: string; value: string; inline?: boolean }>;
  footer?: { text: string };
  timestamp?: string;
}

const STATUS_EMOJIS: Record<TaskStatus, string> = {
  PENDING: '⏳',
  READY: '📋',
  RUNNING: '🔄',
  WAITING_BACKGROUND: '⚙️',
  COMPLETED: '✅',
  FAILED: '❌',
  BLOCKED: '🚫',
  SKIPPED: '⏭️',
};

const CONTENT_LIMIT = 2000;
const PROGRESS_BAR_WIDTH = 8;

function getTaskPhase(task: Task): string | null {
  const configPhase = task.config?.phase;
  if (typeof configPhase === 'string' && configPhase.trim()) {
    return configPhase.trim();
  }

  if (typeof task.phase === 'string' && task.phase.trim()) {
    return task.phase.trim();
  }

  return null;
}

function repeat(char: string, count: number): string {
  return count > 0 ? char.repeat(count) : '';
}

function formatElapsed(task: Task): string {
  const base = task.startedAt ?? task.createdAt ?? null;
  if (!base) {
    return '';
  }

  const startedMs = new Date(base).getTime();
  if (Number.isNaN(startedMs)) {
    return '';
  }

  const elapsedMs = Math.max(0, Date.now() - startedMs);
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 60) {
    return `${Math.max(1, minutes)}min ago`;
  }

  const hours = Math.floor(minutes / 60);
  return `${Math.max(1, hours)}h ago`;
}

function truncate(text: string, width: number): string {
  if (text.length <= width) {
    return text;
  }

  if (width <= 1) {
    return text.slice(0, width);
  }

  return `${text.slice(0, width - 1)}…`;
}

function pad(text: string, width: number): string {
  return truncate(text, width).padEnd(width, ' ');
}

function getAgentLabel(task: Task): string {
  return task.agent?.trim() || '—';
}

function getTaskSummary(task: Task): string {
  if (task.status === 'RUNNING') {
    const elapsed = formatElapsed(task);
    if (elapsed) {
      return `${task.title} (${getAgentLabel(task)}, ${elapsed.replace(' ago', '')})`;
    }
  }

  if (task.status === 'WAITING_BACKGROUND') {
    return task.backgroundProcessId
      ? `${task.title} (${task.backgroundProcessId})`
      : `${task.title} (后台处理中)`;
  }

  if ((task.status === 'PENDING' || task.status === 'READY') && (task.dependsOn?.length ?? 0) > 0) {
    return `等待 ${task.dependsOn!.join(', ')}`;
  }

  if (task.resultSummary?.trim()) {
    return task.resultSummary.trim();
  }

  if (task.lastError?.trim()) {
    return task.lastError.trim();
  }

  return task.title;
}

function renderProgressBar(done: number, total: number): string {
  if (total <= 0) {
    return repeat('░', PROGRESS_BAR_WIDTH);
  }

  const filled = Math.max(
    0,
    Math.min(PROGRESS_BAR_WIDTH, Math.round((done / total) * PROGRESS_BAR_WIDTH))
  );
  return `${repeat('█', filled)}${repeat('░', PROGRESS_BAR_WIDTH - filled)}`;
}

function renderPhaseStatus(progress: ReturnType<typeof getPhaseProgress>): string {
  if (progress.total > 0 && progress.done === progress.total) {
    return '完成';
  }

  if (progress.active) {
    return getTaskSummary(progress.active);
  }

  return `等待 ${progress.done}/${progress.total}`;
}

export function getPhaseProgress(tasks: Task[], phase: string): { done: number; total: number; active: Task | null } {
  const scopedTasks = tasks.filter((task) => getTaskPhase(task) === phase);
  const done = scopedTasks.filter((task) => ['COMPLETED', 'SKIPPED'].includes(task.status)).length;
  const active = scopedTasks.find((task) => ['RUNNING', 'WAITING_BACKGROUND', 'BLOCKED', 'FAILED', 'READY'].includes(task.status)) ?? null;
  return {
    done,
    total: scopedTasks.length,
    active,
  };
}

function formatFlatTasks(tasks: Task[]): string {
  if (tasks.length === 0) {
    return '暂无任务';
  }

  return tasks
    .map((task) => {
      const time = formatElapsed(task);
      const summary = task.status === 'PENDING' && (task.dependsOn?.length ?? 0) > 0
        ? `等待 ${task.dependsOn!.join(', ')}`
        : task.title;
      const line = [
        pad(task.taskId, 4),
        STATUS_EMOJIS[task.status],
        pad(getAgentLabel(task), 12),
        pad(summary, 12),
        time,
      ].filter(Boolean).join(' ');
      return line.trimEnd();
    })
    .join('\n');
}

export function formatMissionPhases(mission: Mission): string {
  const tasks = mission.tasks ?? [];
  if (tasks.length === 0) {
    return `${mission.missionId} | ${mission.title}\n暂无任务`;
  }

  const phases = tasks.reduce<string[]>((acc, task) => {
    const phase = getTaskPhase(task);
    if (phase && !acc.includes(phase)) {
      acc.push(phase);
    }
    return acc;
  }, []);

  if (phases.length === 0) {
    return `${mission.missionId} | ${mission.title}\n${formatFlatTasks(tasks)}`;
  }

  const phaseLines = phases.map((phase, index) => {
    const progress = getPhaseProgress(tasks, phase);
    const icon = progress.done === progress.total && progress.total > 0
      ? STATUS_EMOJIS.COMPLETED
      : progress.active
        ? STATUS_EMOJIS[progress.active.status]
        : STATUS_EMOJIS.PENDING;
    const label = `Phase ${index + 1}: ${phase}`;
    return `${pad(label, 22)} ${icon}${renderProgressBar(progress.done, progress.total)} ${progress.done}/${progress.total}  ${renderPhaseStatus(progress)}`;
  });

  return `${mission.missionId} | ${mission.title}\n${phaseLines.join('\n')}`;
}

function wrapCodeBlock(text: string): string {
  return `\`\`\`\n${text}\n\`\`\``;
}

export function formatDashboard(missions: Mission[]): string {
  const body = missions.length === 0
    ? '暂无活跃 mission'
    : missions
      .map((mission) => formatMissionPhases(mission))
      .join('\n\n');

  const wrapped = wrapCodeBlock(body);
  if (wrapped.length <= CONTENT_LIMIT) {
    return wrapped;
  }

  return wrapCodeBlock('内容过长，请分 phase 查看');
}
