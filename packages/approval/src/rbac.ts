import { UserRole } from '@open-tag/core-types';
import { users } from '@open-tag/storage';
import type { Database } from '@open-tag/storage';
import { eq } from 'drizzle-orm';

/**
 * Permission actions in the system.
 */
export enum Permission {
  // Task permissions
  CREATE_TASK = 'create_task',
  VIEW_TASK = 'view_task',

  // Session permissions
  VIEW_SESSION = 'view_session',

  // Change request permissions
  APPROVE_CHANGE = 'approve_change',
  REJECT_CHANGE = 'reject_change',

  // Memory permissions
  WRITE_MEMORY = 'write_memory',

  // Admin permissions
  MANAGE_AGENTS = 'manage_agents',
  MANAGE_WORKFLOWS = 'manage_workflows',
  MANAGE_CONFIG = 'manage_config',

  // Owner permissions
  MANAGE_ADMINS = 'manage_admins',

  // Audit
  VIEW_AUDIT = 'view_audit',
}

const ROLE_PERMISSIONS: Record<UserRole, Set<Permission>> = {
  [UserRole.OWNER]: new Set(Object.values(Permission)),
  [UserRole.ADMIN]: new Set([
    Permission.CREATE_TASK,
    Permission.VIEW_TASK,
    Permission.VIEW_SESSION,
    Permission.APPROVE_CHANGE,
    Permission.REJECT_CHANGE,
    Permission.WRITE_MEMORY,
    Permission.MANAGE_AGENTS,
    Permission.MANAGE_WORKFLOWS,
    Permission.MANAGE_CONFIG,
    Permission.VIEW_AUDIT,
  ]),
  [UserRole.USER]: new Set([
    Permission.CREATE_TASK,
    Permission.VIEW_TASK,
    Permission.VIEW_SESSION,
    Permission.WRITE_MEMORY,
  ]),
  [UserRole.OBSERVER]: new Set([Permission.VIEW_TASK, Permission.VIEW_SESSION]),
};

export function hasPermission(role: UserRole, permission: Permission): boolean {
  const perms = ROLE_PERMISSIONS[role];
  return perms ? perms.has(permission) : false;
}

export function assertPermission(role: UserRole, permission: Permission): void {
  if (!hasPermission(role, permission)) {
    throw new Error(`Permission denied: role '${role}' does not have '${permission}' permission`);
  }
}

const ROLE_MAP: Record<string, UserRole> = {
  owner: UserRole.OWNER,
  admin: UserRole.ADMIN,
  user: UserRole.USER,
  observer: UserRole.OBSERVER,
};

/**
 * Look up a user's role from the database by their Feishu open_id.
 * Returns null if the user is not found.
 */
export async function getUserRole(db: Database, feishuOpenId: string): Promise<UserRole | null> {
  const rows = await db
    .select({ role: users.role })
    .from(users)
    .where(eq(users.feishuOpenId, feishuOpenId))
    .limit(1);
  if (rows.length === 0) return null;
  return ROLE_MAP[rows[0].role] ?? null;
}
