import { describe, it, expect } from 'vitest';
import { UserRole } from '@open-tag/core-types';
import { hasPermission, assertPermission, getUserRole, Permission } from '../rbac.js';

describe('RBAC permissions', () => {
  describe('owner role', () => {
    it('has all permissions', () => {
      const allPerms = Object.values(Permission);
      for (const perm of allPerms) {
        expect(hasPermission(UserRole.OWNER, perm)).toBe(true);
      }
    });
  });

  describe('admin role', () => {
    it('can approve changes', () => {
      expect(hasPermission(UserRole.ADMIN, Permission.APPROVE_CHANGE)).toBe(true);
    });

    it('can reject changes', () => {
      expect(hasPermission(UserRole.ADMIN, Permission.REJECT_CHANGE)).toBe(true);
    });

    it('can manage agents', () => {
      expect(hasPermission(UserRole.ADMIN, Permission.MANAGE_AGENTS)).toBe(true);
    });

    it('cannot manage admins', () => {
      expect(hasPermission(UserRole.ADMIN, Permission.MANAGE_ADMINS)).toBe(false);
    });

    it('can view audit', () => {
      expect(hasPermission(UserRole.ADMIN, Permission.VIEW_AUDIT)).toBe(true);
    });
  });

  describe('user role', () => {
    it('can create tasks', () => {
      expect(hasPermission(UserRole.USER, Permission.CREATE_TASK)).toBe(true);
    });

    it('can view tasks', () => {
      expect(hasPermission(UserRole.USER, Permission.VIEW_TASK)).toBe(true);
    });

    it('cannot approve changes', () => {
      expect(hasPermission(UserRole.USER, Permission.APPROVE_CHANGE)).toBe(false);
    });

    it('cannot reject changes', () => {
      expect(hasPermission(UserRole.USER, Permission.REJECT_CHANGE)).toBe(false);
    });

    it('cannot manage agents', () => {
      expect(hasPermission(UserRole.USER, Permission.MANAGE_AGENTS)).toBe(false);
    });
  });

  describe('observer role', () => {
    it('can view tasks', () => {
      expect(hasPermission(UserRole.OBSERVER, Permission.VIEW_TASK)).toBe(true);
    });

    it('can view sessions', () => {
      expect(hasPermission(UserRole.OBSERVER, Permission.VIEW_SESSION)).toBe(true);
    });

    it('cannot create tasks', () => {
      expect(hasPermission(UserRole.OBSERVER, Permission.CREATE_TASK)).toBe(false);
    });

    it('cannot approve changes', () => {
      expect(hasPermission(UserRole.OBSERVER, Permission.APPROVE_CHANGE)).toBe(false);
    });

    it('cannot write memory', () => {
      expect(hasPermission(UserRole.OBSERVER, Permission.WRITE_MEMORY)).toBe(false);
    });
  });

  describe('assertPermission', () => {
    it('does not throw for allowed permission', () => {
      expect(() => assertPermission(UserRole.ADMIN, Permission.APPROVE_CHANGE)).not.toThrow();
    });

    it('throws for denied permission', () => {
      expect(() => assertPermission(UserRole.USER, Permission.APPROVE_CHANGE)).toThrow(
        'Permission denied',
      );
    });
  });

  describe('getUserRole', () => {
    function mockDb(rows: Array<{ role: string }>) {
      return {
        select: () => ({
          from: () => ({
            where: () => ({
              limit: () => Promise.resolve(rows),
            }),
          }),
        }),
      } as any;
    }

    it('returns OWNER for a user with owner role', async () => {
      const db = mockDb([{ role: 'owner' }]);
      const result = await getUserRole(db, 'ou_owner_123');
      expect(result).toBe(UserRole.OWNER);
    });

    it('returns ADMIN for a user with admin role', async () => {
      const db = mockDb([{ role: 'admin' }]);
      const result = await getUserRole(db, 'ou_admin_123');
      expect(result).toBe(UserRole.ADMIN);
    });

    it('returns USER for a user with user role', async () => {
      const db = mockDb([{ role: 'user' }]);
      const result = await getUserRole(db, 'ou_user_123');
      expect(result).toBe(UserRole.USER);
    });

    it('returns null for unknown user', async () => {
      const db = mockDb([]);
      const result = await getUserRole(db, 'ou_unknown');
      expect(result).toBeNull();
    });

    it('returns null for unrecognized role string', async () => {
      const db = mockDb([{ role: 'superuser' }]);
      const result = await getUserRole(db, 'ou_weird');
      expect(result).toBeNull();
    });
  });
});
