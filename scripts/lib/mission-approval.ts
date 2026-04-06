/**
 * mission-approval.ts — 人工审批节点辅助函数
 *
 * 提供 task 审批状态检查、批量查询、审批结果处理等功能。
 * 所有函数为纯函数，不修改输入参数，返回新对象。
 *
 * TODO(Phase 4): 将 needsApproval 集成到 mission-dispatch.ts，dispatch 时拦截未审批的 task
 */

import type { Mission, Task } from './types.ts';

/** 检查 task 是否需要审批且未获批 */
export function needsApproval(task: Task): boolean {
  return task.requiresApproval === true && task.approvalStatus !== 'APPROVED';
}

/** 获取 mission 中所有待审批的 task */
export function getTasksPendingApproval(mission: Mission): Task[] {
  return (mission.tasks ?? []).filter(
    (t) => t.requiresApproval === true &&
           (t.approvalStatus === 'PENDING_APPROVAL' || t.approvalStatus === undefined) &&
           t.status === 'READY'
  );
}

/** 检查 mission 是否有任何 task 因等待审批而阻塞 */
export function hasPendingApprovals(mission: Mission): boolean {
  return getTasksPendingApproval(mission).length > 0;
}

/** 处理审批结果，返回更新后的 mission */
export function processApproval(
  mission: Mission,
  taskId: string,
  approved: boolean,
  note?: string
): { mission: Mission; changed: boolean; error?: string } {
  const tasks = [...(mission.tasks ?? [])];
  const idx = tasks.findIndex((t) => t.taskId === taskId);

  if (idx === -1) {
    return { mission, changed: false, error: `Task not found: ${taskId}` };
  }

  const task = tasks[idx];

  if (!task.requiresApproval) {
    return { mission, changed: false, error: `Task ${taskId} does not require approval` };
  }

  if (task.approvalStatus === 'APPROVED' || task.approvalStatus === 'REJECTED') {
    return { mission, changed: false, error: `Task ${taskId} already ${task.approvalStatus}` };
  }

  if (approved) {
    tasks[idx] = {
      ...task,
      approvalStatus: 'APPROVED',
      approvalNote: note ?? null,
    };
  } else {
    tasks[idx] = {
      ...task,
      approvalStatus: 'REJECTED',
      approvalNote: note ?? null,
      status: 'SKIPPED',
    };
  }

  const updatedMission: Mission = {
    ...mission,
    tasks,
    updatedAt: new Date().toISOString(),
  };

  return { mission: updatedMission, changed: true };
}
