import type { MachineRow } from '../machine-routing.js';

/**
 * Actionable failure copy for remote-dispatch errors (design D8).
 *
 * Every remote-dispatch failure surfaces the machine name, its last-seen time,
 * and the `npx` command to start the daemon, so the user can self-remediate from
 * the Feishu failure card without leaving the chat.
 */

const DAEMON_START_HINT =
  'npx @open-tag/daemon@latest start --background';

function formatLastSeen(lastSeenAt: Date | null | undefined): string {
  if (!lastSeenAt) return 'never';
  return lastSeenAt.toISOString();
}

/** Failure copy for a machine that has no live connection at dispatch time. */
export function machineOfflineMessage(machine: Pick<MachineRow, 'name' | 'lastSeenAt'>): string {
  return (
    `Machine "${machine.name}" is offline (last seen ${formatLastSeen(machine.lastSeenAt)}). ` +
    `Start your daemon to run this task: ${DAEMON_START_HINT}`
  );
}

/** Failure copy when the daemon does not accept a dispatch within the timeout. */
export function dispatchTimeoutMessage(
  machine: Pick<MachineRow, 'name' | 'lastSeenAt'>,
  timeoutMs: number,
): string {
  return (
    `Machine "${machine.name}" did not accept the task within ${Math.round(timeoutMs / 1000)}s ` +
    `(last seen ${formatLastSeen(machine.lastSeenAt)}). ` +
    `Make sure your daemon is running: ${DAEMON_START_HINT}`
  );
}

/** Failure copy when the daemon explicitly rejects a dispatch (e.g. busy). */
export function dispatchRejectedMessage(
  machine: Pick<MachineRow, 'name'>,
  reason: string,
): string {
  return `Machine "${machine.name}" rejected the task: ${reason}.`;
}

/** Failure copy when a daemon restarts and loses an in-flight dispatch (D12). */
export function taskLostMessage(machine: Pick<MachineRow, 'name'>): string {
  return (
    `Machine "${machine.name}" restarted and lost the in-flight task. ` +
    `Re-send the request to run it again.`
  );
}

/** Failure copy when a disconnected machine exhausts the 120 s grace window (D12). */
export function machineDisconnectedMessage(
  machine: Pick<MachineRow, 'name' | 'lastSeenAt'>,
): string {
  return (
    `Machine "${machine.name}" disconnected mid-task and did not return ` +
    `(last seen ${formatLastSeen(machine.lastSeenAt)}). The task was abandoned. ` +
    `Start your daemon and re-send the request: ${DAEMON_START_HINT}`
  );
}

/**
 * Failure copy when a task is bound to a machine that is no longer valid
 * (revoked / not found / owned by another user). The binding was an explicit
 * user choice, so we fail fast rather than silently rerouting to server-local
 * execution (design D8) — that could run repo-editing work on the wrong
 * substrate. The reason is named so the user knows exactly what to fix.
 */
export function invalidMachineBindingMessage(
  reason: 'not_found' | 'revoked' | 'owner_mismatch',
): string {
  const detail =
    reason === 'revoked'
      ? 'the bound machine has been revoked'
      : reason === 'not_found'
        ? 'the bound machine no longer exists'
        : 'the bound machine is not owned by this user/tenant';
  return (
    `This chat/session is bound to a machine, but ${detail} (${reason}). ` +
    'The task was NOT run server-local to avoid executing on the wrong machine. ' +
    'Fix the binding in the admin console, or rebind the agent/chat to a valid machine.'
  );
}

/** Failure copy when the resolved runtime is not supported by the machine. */
export function unsupportedRuntimeMessage(
  machine: Pick<MachineRow, 'name'>,
  runtime: string,
  supported: string[],
): string {
  const list = supported.length > 0 ? supported.join(', ') : 'none';
  return (
    `Machine "${machine.name}" cannot run the "${runtime}" runtime ` +
    `(supported: ${list}). Choose a supported runtime or another machine.`
  );
}

/** Failure copy when an older daemon cannot receive per-agent runtime env. */
export function unsupportedRuntimeEnvMessage(machine: Pick<MachineRow, 'name'>): string {
  return (
    `Machine "${machine.name}" is running a daemon that does not advertise runtime env support. ` +
    `Upgrade and restart the daemon before running agents with configured env: ${DAEMON_START_HINT}`
  );
}
