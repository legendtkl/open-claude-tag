import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  agentBotBindings,
  agentProfiles,
  agentSessionStates,
  agents,
  DEFAULT_CHAT_MEMORY_SUMMARY_TIME,
  DEFAULT_CHAT_MEMORY_SUMMARY_TIMEZONE,
  chatConfigs,
  createDb,
  feishuApps,
  feishuTaskTrackingSpaces,
  hashPairingToken,
  machinePairingTokens,
  machines,
  platformUsers,
  sessions,
  slackInstallations,
  tasks,
} from '@open-tag/storage';
import type { Database } from '@open-tag/storage';
import { createDrizzleAdminApiStore, type OwnerScope } from '../admin-api.js';

// Ownership-matrix integration test (design D-A2/D-A3). Exercises the REAL Drizzle
// store against Postgres so the owner-filter SQL is actually evaluated. Gated on
// DATABASE_URL — runs under the isolated runner (which exports it), skips in pure
// unit runs. Under the test:integration gate (OPEN_TAG_API_PG_INTEGRATION=1) a
// missing DATABASE_URL is a loud failure instead of a silent skip.
const describePg =
  process.env.DATABASE_URL || process.env.OPEN_TAG_API_PG_INTEGRATION === '1'
    ? describe
    : describe.skip;

describePg('admin api store ownership matrix', () => {
  let db: Database;

  // Two SSO owners + a NULL-owner (legacy/ops) row per resource.
  const aliceId = randomUUID();
  const bobId = randomUUID();
  const aliceTenant = `t_alice_${randomUUID().slice(0, 8)}`;
  const bobTenant = `t_bob_${randomUUID().slice(0, 8)}`;
  const legacyTenant = `t_legacy_${randomUUID().slice(0, 8)}`;

  // A SHARED Feishu tenant where BOTH Alice and Bob registered an app. This is the
  // R2-1 regression surface: two colleagues in the same tenant must NOT see each
  // other's chats/boards (the tenant-grant model D-A2 rejected).
  const sharedTenant = `t_shared_${randomUUID().slice(0, 8)}`;

  const aliceAppId = randomUUID();
  const bobAppId = randomUUID();
  const legacyAppId = randomUUID();
  const aliceSharedAppId = randomUUID();
  const bobSharedAppId = randomUUID();
  // Slack installations (ADR-0013): one each for Alice / Bob / a legacy NULL-owner.
  const aliceSlackId = randomUUID();
  const bobSlackId = randomUUID();
  const legacySlackId = randomUUID();
  const aliceSlackTeam = `TS_alice_${randomUUID().slice(0, 8)}`;
  const bobSlackTeam = `TS_bob_${randomUUID().slice(0, 8)}`;
  const legacySlackTeam = `TS_legacy_${randomUUID().slice(0, 8)}`;
  const aliceAgentId = randomUUID();
  const bobAgentId = randomUUID();
  const legacyAgentId = randomUUID();
  // Agents that act inside the shared tenant's chats (R2-1 active-in/bound-to).
  const aliceSharedAgentId = randomUUID();
  const bobSharedAgentId = randomUUID();
  // Sessions + tasks giving the shared agents activity in their respective chats.
  const aliceSharedSessionId = randomUUID();
  const bobSharedSessionId = randomUUID();
  const aliceSharedTaskId = randomUUID();
  const bobSharedTaskId = randomUUID();
  const sharedProfileId = randomUUID();
  // R2-6 profile ownership: a profile owned by Alice and a builtin/shared (NULL) one.
  const aliceProfileId = randomUUID();
  const builtinProfileId = randomUUID();

  const aliceMachineId = randomUUID();
  const bobMachineId = randomUUID();
  const legacyMachineId = randomUUID();
  // A revoked machine owned by Alice, for the D-A8 binding-validation tests.
  const aliceRevokedMachineId = randomUUID();

  const aliceScope: OwnerScope = {
    isSuperadmin: false,
    platformUserId: aliceId,
    computerAccessEnabled: true,
  };
  const bobScope: OwnerScope = {
    isSuperadmin: false,
    platformUserId: bobId,
    computerAccessEnabled: true,
  };
  const aliceNoComputerScope: OwnerScope = {
    isSuperadmin: false,
    platformUserId: aliceId,
    computerAccessEnabled: false,
  };
  const superScope: OwnerScope = {
    isSuperadmin: true,
    platformUserId: null,
    computerAccessEnabled: true,
  };

  function store() {
    return createDrizzleAdminApiStore(db);
  }

  beforeAll(async () => {
    if (!process.env.DATABASE_URL) {
      throw new Error('DATABASE_URL is required for admin API Postgres integration tests');
    }
    db = createDb(process.env.DATABASE_URL);

    await db.insert(platformUsers).values([
      { id: aliceId, ssoSub: `sso-alice-${aliceId}`, email: 'alice@example.com', role: 'user' },
      { id: bobId, ssoSub: `sso-bob-${bobId}`, email: 'bob@example.com', role: 'user' },
    ]);
    await db.insert(agentProfiles).values([
      { id: sharedProfileId, name: `prof-${sharedProfileId}`, displayName: 'Shared' },
      // R2-6: a profile Alice owns, and a builtin/shared (NULL owner) profile.
      { id: aliceProfileId, name: `prof-alice-${aliceProfileId.slice(0, 8)}`, displayName: 'Alice Profile', platformOwnerId: aliceId },
      { id: builtinProfileId, name: `prof-builtin-${builtinProfileId.slice(0, 8)}`, displayName: 'Builtin Profile', platformOwnerId: null },
    ]);
    await db.insert(feishuApps).values([
      { id: aliceAppId, tenantKey: aliceTenant, appId: `cli_a_${aliceAppId}`, appSecretRef: 'env:A', platformOwnerId: aliceId },
      { id: bobAppId, tenantKey: bobTenant, appId: `cli_b_${bobAppId}`, appSecretRef: 'env:B', platformOwnerId: bobId },
      { id: legacyAppId, tenantKey: legacyTenant, appId: `cli_l_${legacyAppId}`, appSecretRef: 'env:L', platformOwnerId: null },
      // Both Alice and Bob own an app in the SAME (shared) tenant (R2-1).
      { id: aliceSharedAppId, tenantKey: sharedTenant, appId: `cli_sa_${aliceSharedAppId}`, appSecretRef: 'env:SA', platformOwnerId: aliceId },
      { id: bobSharedAppId, tenantKey: sharedTenant, appId: `cli_sb_${bobSharedAppId}`, appSecretRef: 'env:SB', platformOwnerId: bobId },
    ]);
    await db.insert(slackInstallations).values([
      { id: aliceSlackId, teamId: aliceSlackTeam, botTokenRef: 'stored', botToken: 'xoxb-alice', botUserId: 'U_alice', platformOwnerId: aliceId },
      { id: bobSlackId, teamId: bobSlackTeam, botTokenRef: 'stored', botToken: 'xoxb-bob', botUserId: 'U_bob', platformOwnerId: bobId },
      { id: legacySlackId, teamId: legacySlackTeam, botTokenRef: 'env:SLACK_LEGACY', botToken: null, botUserId: 'U_legacy', platformOwnerId: null },
    ]);
    await db.insert(agents).values([
      { id: aliceAgentId, tenantKey: aliceTenant, handle: `a_${aliceAgentId.slice(0, 8)}`, displayName: 'Alice Agent', profileId: sharedProfileId, platformOwnerId: aliceId },
      { id: bobAgentId, tenantKey: bobTenant, handle: `b_${bobAgentId.slice(0, 8)}`, displayName: 'Bob Agent', profileId: sharedProfileId, platformOwnerId: bobId },
      { id: legacyAgentId, tenantKey: legacyTenant, handle: `l_${legacyAgentId.slice(0, 8)}`, displayName: 'Legacy Agent', profileId: sharedProfileId, platformOwnerId: null },
      // Shared-tenant agents, owned by Alice / Bob respectively (R2-1).
      { id: aliceSharedAgentId, tenantKey: sharedTenant, handle: `sa_${aliceSharedAgentId.slice(0, 8)}`, displayName: 'Alice Shared Agent', profileId: sharedProfileId, platformOwnerId: aliceId },
      { id: bobSharedAgentId, tenantKey: sharedTenant, handle: `sb_${bobSharedAgentId.slice(0, 8)}`, displayName: 'Bob Shared Agent', profileId: sharedProfileId, platformOwnerId: bobId },
    ]);
    await db.insert(chatConfigs).values([
      // oc_alice / oc_bob: bound-to via defaultAgentId (R2-1 bound-to predicate).
      { tenantKey: aliceTenant, chatId: 'oc_alice', displayName: 'Alice Chat', defaultAgentId: aliceAgentId },
      { tenantKey: bobTenant, chatId: 'oc_bob', displayName: 'Bob Chat', defaultAgentId: bobAgentId },
      { tenantKey: legacyTenant, chatId: 'oc_legacy', displayName: 'Legacy Chat' },
      // Two chats in the SAME shared tenant: one each for Alice and Bob (R2-1).
      { tenantKey: sharedTenant, chatId: 'oc_shared_alice', displayName: 'Shared Alice Chat' },
      { tenantKey: sharedTenant, chatId: 'oc_shared_bob', displayName: 'Shared Bob Chat' },
    ]);
    // Activity (active-in predicate, R2-1): Alice's shared agent ran a task in
    // oc_shared_alice; Bob's in oc_shared_bob. Same tenant, different chats.
    await db.insert(sessions).values([
      { id: aliceSharedSessionId, sessionKey: `sk-${aliceSharedSessionId}`, chatId: 'oc_shared_alice', scope: 'chat' },
      { id: bobSharedSessionId, sessionKey: `sk-${bobSharedSessionId}`, chatId: 'oc_shared_bob', scope: 'chat' },
    ]);
    await db.insert(tasks).values([
      { id: aliceSharedTaskId, sessionId: aliceSharedSessionId, agentId: aliceSharedAgentId, taskType: 'one_shot', goal: 'alice work' },
      { id: bobSharedTaskId, sessionId: bobSharedSessionId, agentId: bobSharedAgentId, taskType: 'one_shot', goal: 'bob work' },
    ]);
    // Machines: two console-owned (Alice, Bob) and one legacy openId-owned (D-A7).
    await db.insert(machines).values([
      { id: aliceMachineId, tenantKey: aliceTenant, name: 'alice-mbp', secretHash: 'h-a', platformOwnerId: aliceId, ownerOpenId: null, status: 'online' },
      { id: bobMachineId, tenantKey: bobTenant, name: 'bob-mbp', secretHash: 'h-b', platformOwnerId: bobId, ownerOpenId: null },
      { id: legacyMachineId, tenantKey: legacyTenant, name: 'legacy-box', secretHash: 'h-l', platformOwnerId: null, ownerOpenId: 'ou_legacy' },
      { id: aliceRevokedMachineId, tenantKey: aliceTenant, name: 'alice-old', secretHash: 'h-ar', platformOwnerId: aliceId, ownerOpenId: null, status: 'revoked' },
    ]);
  });

  afterAll(async () => {
    await db.delete(machinePairingTokens).where(inArray(machinePairingTokens.platformIssuerId, [aliceId, bobId]));
    await db.delete(tasks).where(inArray(tasks.id, [aliceSharedTaskId, bobSharedTaskId]));
    await db.delete(sessions).where(inArray(sessions.id, [aliceSharedSessionId, bobSharedSessionId]));
    const allAgentIds = [aliceAgentId, bobAgentId, legacyAgentId, aliceSharedAgentId, bobSharedAgentId];
    await db.delete(agentBotBindings).where(inArray(agentBotBindings.agentId, allAgentIds));
    await db.delete(agents).where(inArray(agents.id, allAgentIds));
    await db.delete(machines).where(inArray(machines.id, [aliceMachineId, bobMachineId, legacyMachineId, aliceRevokedMachineId]));
    await db.delete(feishuApps).where(inArray(feishuApps.id, [aliceAppId, bobAppId, legacyAppId, aliceSharedAppId, bobSharedAppId]));
    await db.delete(slackInstallations).where(inArray(slackInstallations.id, [aliceSlackId, bobSlackId, legacySlackId]));
    await db.delete(chatConfigs).where(inArray(chatConfigs.tenantKey, [aliceTenant, bobTenant, legacyTenant, sharedTenant]));
    await db.delete(agentProfiles).where(inArray(agentProfiles.id, [sharedProfileId, aliceProfileId, builtinProfileId]));
    await db.delete(platformUsers).where(inArray(platformUsers.id, [aliceId, bobId]));
    await db.$client.end({ timeout: 5 });
  });

  it('lists only an owner-scoped user own apps', async () => {
    const aliceApps = await store().listFeishuApps(aliceScope);
    const ids = new Set(aliceApps.map((app) => app.id));
    expect(ids.has(aliceAppId)).toBe(true);
    expect(ids.has(bobAppId)).toBe(false);
    expect(ids.has(legacyAppId)).toBe(false);
  });

  it('lets superadmin see every app including the legacy NULL-owner row', async () => {
    const apps = await store().listFeishuApps(superScope);
    const ids = new Set(apps.map((app) => app.id));
    expect(ids.has(aliceAppId)).toBe(true);
    expect(ids.has(bobAppId)).toBe(true);
    expect(ids.has(legacyAppId)).toBe(true);
  });

  it('scopes agents to the owner and hides legacy rows from plain users', async () => {
    const bobAgents = await store().listAgents(bobScope);
    const ids = new Set(bobAgents.map((agent) => agent.id));
    expect(ids.has(bobAgentId)).toBe(true);
    expect(ids.has(aliceAgentId)).toBe(false);
    expect(ids.has(legacyAgentId)).toBe(false);

    const superAgents = await store().listAgents(superScope);
    const superIds = new Set(superAgents.map((agent) => agent.id));
    expect(superIds.has(legacyAgentId)).toBe(true);
  });

  it('surfaces owner labels to superadmin only', async () => {
    const superApps = await store().listFeishuApps(superScope);
    const aliceApp = superApps.find((app) => app.id === aliceAppId);
    expect(aliceApp?.platformOwner).toMatchObject({ id: aliceId, email: 'alice@example.com' });

    const aliceApps = await store().listFeishuApps(aliceScope);
    expect(aliceApps.find((app) => app.id === aliceAppId)?.platformOwner).toBeNull();
  });

  it('lets only superadmin manage computer access settings', async () => {
    await expect(store().listComputerAccessUsers(aliceScope)).rejects.toMatchObject({
      statusCode: 403,
    });
    await expect(
      store().updateComputerAccessUser(aliceScope, bobId, { computerAccessEnabled: true }),
    ).rejects.toMatchObject({ statusCode: 403 });

    const enabled = await store().updateComputerAccessUser(superScope, aliceId, {
      computerAccessEnabled: true,
    });
    expect(enabled).toMatchObject({ id: aliceId, computerAccessEnabled: true });
    const users = await store().listComputerAccessUsers(superScope);
    expect(users.find((user) => user.id === aliceId)?.computerAccessEnabled).toBe(true);

    await store().updateComputerAccessUser(superScope, aliceId, {
      computerAccessEnabled: false,
    });
  });

  it('forbids patching another user app (404)', async () => {
    await expect(
      store().updateFeishuApp(aliceScope, bobAppId, { status: 'disabled' }),
    ).rejects.toMatchObject({ statusCode: 404 });
    // Bob can patch his own.
    const patched = await store().updateFeishuApp(bobScope, bobAppId, { status: 'disabled' });
    expect(patched.status).toBe('disabled');
    await store().updateFeishuApp(bobScope, bobAppId, { status: 'enabled' });
  });

  it('forbids patching another user agent (404)', async () => {
    await expect(
      store().updateAgent(bobScope, aliceAgentId, { displayName: 'Hijack' }),
    ).rejects.toMatchObject({ statusCode: 404 });
    const patched = await store().updateAgent(aliceScope, aliceAgentId, { displayName: 'Alice Agent v2' });
    expect(patched.displayName).toBe('Alice Agent v2');
  });

  it('deletes only owned agents by archiving them and unbinding bots', async () => {
    const createdApp = await store().createFeishuApp(aliceScope, {
      tenantKey: aliceTenant,
      appId: `cli_delete_agent_${randomUUID().slice(0, 8)}`,
      appSecretRef: 'env:DELETE_AGENT',
      eventMode: 'websocket',
      status: 'enabled',
    });
    const createdAgent = await store().createAgent(aliceScope, {
      tenantKey: aliceTenant,
      scopeType: 'system',
      scopeId: 'default',
      handle: `delete_agent_${randomUUID().slice(0, 8)}`,
      displayName: 'Delete Agent',
      visibility: 'public',
      memoryEnabled: true,
      status: 'active',
    });
    const sessionId = randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      sessionKey: `delete-agent-${sessionId}`,
      chatId: 'oc_delete_agent',
      scope: 'chat',
    });
    const [sessionState] = await db
      .insert(agentSessionStates)
      .values({
        agentId: createdAgent.id,
        sessionId,
        runtimeBackend: 'codex',
        sdkSessionId: 'sdk-delete-agent',
      })
      .returning({ id: agentSessionStates.id });
    const binding = await store().bindBot(aliceScope, {
      agentId: createdAgent.id,
      feishuAppId: createdApp.id,
    });

    await expect(store().deleteAgent(bobScope, createdAgent.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    const deleted = await store().deleteAgent(aliceScope, createdAgent.id);

    expect(deleted.id).toBe(createdAgent.id);
    expect((await store().listAgents(aliceScope)).some((agent) => agent.id === createdAgent.id)).toBe(
      false,
    );
    const [archived] = await db.select().from(agents).where(eq(agents.id, createdAgent.id));
    expect(archived).toMatchObject({ status: 'archived' });
    expect(archived?.handle.startsWith('__deleted__')).toBe(true);
    expect(
      await db.select().from(agentBotBindings).where(eq(agentBotBindings.id, binding.id)),
    ).toHaveLength(0);
    expect(
      await db.select().from(agentSessionStates).where(eq(agentSessionStates.id, sessionState.id)),
    ).toHaveLength(1);

    await db.delete(agentSessionStates).where(eq(agentSessionStates.id, sessionState.id));
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    await db.delete(agents).where(eq(agents.id, createdAgent.id));
    await db.delete(agentProfiles).where(eq(agentProfiles.id, createdAgent.profileId));
    await db.delete(feishuApps).where(eq(feishuApps.id, createdApp.id));
  });

  it('scopes agent name uniqueness to the owner: same owner conflicts (409), different owners coexist', async () => {
    const name = `Shared Name ${randomUUID().slice(0, 8)}`;
    const aliceFirst = await store().createAgent(aliceScope, {
      tenantKey: aliceTenant,
      scopeType: 'system',
      scopeId: 'default',
      displayName: name,
      visibility: 'public',
      memoryEnabled: true,
      status: 'active',
    });

    // Same owner, same name → friendly 409 (not a raw 500 from the DB).
    await expect(
      store().createAgent(aliceScope, {
        tenantKey: aliceTenant,
        scopeType: 'system',
        scopeId: 'default',
        displayName: name,
        visibility: 'public',
        memoryEnabled: true,
        status: 'active',
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
      message: expect.stringContaining(`"${name}"`),
    });

    // Different owner, SAME tenant, same name → allowed. This is the reported
    // bug: "Developer" taken by another user previously blocked creation.
    const bobSame = await store().createAgent(bobScope, {
      tenantKey: aliceTenant,
      scopeType: 'system',
      scopeId: 'default',
      displayName: name,
      visibility: 'public',
      memoryEnabled: true,
      status: 'active',
    });
    expect(bobSame.handle).toBe(aliceFirst.handle);
    expect(bobSame.id).not.toBe(aliceFirst.id);

    // Renaming another of Alice's agents onto the taken name → same 409.
    const aliceOther = await store().createAgent(aliceScope, {
      tenantKey: aliceTenant,
      scopeType: 'system',
      scopeId: 'default',
      displayName: `Other ${randomUUID().slice(0, 8)}`,
      visibility: 'public',
      memoryEnabled: true,
      status: 'active',
    });
    await expect(
      store().updateAgent(aliceScope, aliceOther.id, { displayName: name }),
    ).rejects.toMatchObject({ statusCode: 409 });

    for (const created of [aliceFirst, bobSame, aliceOther]) {
      await db.delete(agents).where(eq(agents.id, created.id));
      await db.delete(agentProfiles).where(eq(agentProfiles.id, created.profileId));
    }
  });

  it('deletes agents while preserving non-terminal task history', async () => {
    const createdAgent = await store().createAgent(aliceScope, {
      tenantKey: aliceTenant,
      scopeType: 'system',
      scopeId: 'default',
      handle: `busy_agent_${randomUUID().slice(0, 8)}`,
      displayName: 'Busy Agent',
      visibility: 'public',
      memoryEnabled: true,
      status: 'active',
    });
    const sessionId = randomUUID();
    const taskId = randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      sessionKey: `busy-agent-${sessionId}`,
      chatId: 'oc_busy_agent',
      scope: 'chat',
    });
    await db.insert(tasks).values({
      id: taskId,
      sessionId,
      agentId: createdAgent.id,
      taskType: 'one_shot',
      goal: 'busy work',
      status: 'queued',
    });

    await expect(store().deleteAgent(aliceScope, createdAgent.id)).resolves.toMatchObject({
      id: createdAgent.id,
    });
    const [preservedTask] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(preservedTask).toMatchObject({
      id: taskId,
      agentId: createdAgent.id,
      status: 'queued',
    });

    await db.delete(tasks).where(eq(tasks.id, taskId));
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    await db.delete(agents).where(eq(agents.id, createdAgent.id));
    await db.delete(agentProfiles).where(eq(agentProfiles.id, createdAgent.profileId));
  });

  it('deletes only owned Feishu apps by disabling them and unbinding bots', async () => {
    const createdApp = await store().createFeishuApp(aliceScope, {
      tenantKey: aliceTenant,
      appId: `cli_delete_app_${randomUUID().slice(0, 8)}`,
      appSecretRef: 'env:DELETE_APP',
      eventMode: 'websocket',
      status: 'enabled',
    });
    const createdAgent = await store().createAgent(aliceScope, {
      tenantKey: aliceTenant,
      scopeType: 'system',
      scopeId: 'default',
      handle: `delete_app_${randomUUID().slice(0, 8)}`,
      displayName: 'Delete App Agent',
      visibility: 'public',
      memoryEnabled: true,
      status: 'active',
    });
    const binding = await store().bindBot(aliceScope, {
      agentId: createdAgent.id,
      feishuAppId: createdApp.id,
    });

    await expect(store().deleteFeishuApp(bobScope, createdApp.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    const deleted = await store().deleteFeishuApp(aliceScope, createdApp.id);

    expect(deleted.id).toBe(createdApp.id);
    expect((await store().listFeishuApps(aliceScope)).some((app) => app.id === createdApp.id)).toBe(
      false,
    );
    const [disabledApp] = await db
      .select()
      .from(feishuApps)
      .where(eq(feishuApps.id, createdApp.id));
    expect(disabledApp).toMatchObject({ status: 'disabled', appSecretRef: 'deleted' });
    expect(disabledApp?.appId.startsWith('__deleted__')).toBe(true);
    expect(
      await db.select().from(agentBotBindings).where(eq(agentBotBindings.id, binding.id)),
    ).toHaveLength(0);

    await db.delete(agents).where(eq(agents.id, createdAgent.id));
    await db.delete(agentProfiles).where(eq(agentProfiles.id, createdAgent.profileId));
    await db.delete(feishuApps).where(eq(feishuApps.id, createdApp.id));
  });

  it('deletes Feishu apps while preserving non-terminal task history', async () => {
    const createdApp = await store().createFeishuApp(aliceScope, {
      tenantKey: aliceTenant,
      appId: `cli_busy_app_${randomUUID().slice(0, 8)}`,
      appSecretRef: 'env:BUSY_APP',
      eventMode: 'websocket',
      status: 'enabled',
    });
    const sessionId = randomUUID();
    const taskId = randomUUID();
    await db.insert(sessions).values({
      id: sessionId,
      sessionKey: `busy-app-${sessionId}`,
      chatId: 'oc_busy_app',
      scope: 'chat',
    });
    await db.insert(tasks).values({
      id: taskId,
      sessionId,
      feishuAppId: createdApp.id,
      taskType: 'one_shot',
      goal: 'busy app work',
      status: 'running',
    });

    await expect(store().deleteFeishuApp(aliceScope, createdApp.id)).resolves.toMatchObject({
      id: createdApp.id,
    });
    const [preservedTask] = await db.select().from(tasks).where(eq(tasks.id, taskId));
    expect(preservedTask).toMatchObject({
      id: taskId,
      feishuAppId: createdApp.id,
      status: 'running',
    });

    await db.delete(tasks).where(eq(tasks.id, taskId));
    await db.delete(sessions).where(eq(sessions.id, sessionId));
    await db.delete(feishuApps).where(eq(feishuApps.id, createdApp.id));
  });

  // ── Slack installations: per-creator ownership, fail-closed, token masking (ADR-0013) ──
  it('lists only an owner-scoped user own Slack installations; superadmin sees all incl. legacy', async () => {
    const aliceInstalls = await store().listSlackInstallations(aliceScope);
    const aliceIds = new Set(aliceInstalls.map((i) => i.id));
    expect(aliceIds.has(aliceSlackId)).toBe(true);
    expect(aliceIds.has(bobSlackId)).toBe(false);
    expect(aliceIds.has(legacySlackId)).toBe(false);

    const superInstalls = await store().listSlackInstallations(superScope);
    const superIds = new Set(superInstalls.map((i) => i.id));
    expect(superIds.has(aliceSlackId)).toBe(true);
    expect(superIds.has(bobSlackId)).toBe(true);
    expect(superIds.has(legacySlackId)).toBe(true);
  });

  it('masks the bot token in the DTO: only hasStoredToken, never the token', async () => {
    const installs = await store().listSlackInstallations(superScope);
    const alice = installs.find((i) => i.id === aliceSlackId);
    expect(alice).toBeTruthy();
    expect(alice).not.toHaveProperty('botToken');
    // Alice's row stores a token; the legacy row carries only an env ref.
    expect(alice?.hasStoredToken).toBe(true);
    const legacy = installs.find((i) => i.id === legacySlackId);
    expect(legacy?.hasStoredToken).toBe(false);
    expect(legacy?.botTokenRef).toBe('env:SLACK_LEGACY');
  });

  it('stamps the creating SSO user as owner and resolves env-ref vs stored token state', async () => {
    const stored = await store().createSlackInstallation(aliceScope, {
      teamId: `TS_created_${randomUUID().slice(0, 8)}`,
      botToken: 'xoxb-created',
      botUserId: 'U_created',
      status: 'enabled',
    });
    expect(stored.platformOwnerId).toBe(aliceId);
    expect(stored.hasStoredToken).toBe(true);
    expect(stored.botTokenRef).toBe('stored');

    const envRef = await store().createSlackInstallation(aliceScope, {
      teamId: `TS_env_${randomUUID().slice(0, 8)}`,
      botTokenRef: 'env:SLACK_CREATED',
      botUserId: 'U_env',
      status: 'enabled',
    });
    expect(envRef.hasStoredToken).toBe(false);
    expect(envRef.botTokenRef).toBe('env:SLACK_CREATED');

    await db.delete(slackInstallations).where(inArray(slackInstallations.id, [stored.id, envRef.id]));
  });

  it('forbids patching another user Slack installation (404), allows own', async () => {
    await expect(
      store().updateSlackInstallation(aliceScope, bobSlackId, { status: 'disabled' }),
    ).rejects.toMatchObject({ statusCode: 404 });
    const patched = await store().updateSlackInstallation(bobScope, bobSlackId, {
      teamName: 'Bob Workspace v2',
    });
    expect(patched.teamName).toBe('Bob Workspace v2');
  });

  it('rejects enabling a Slack installation with no usable token (Codex finding 3)', async () => {
    // Create with an env ref and NO stored token (passes the create refine).
    // There is no clear-token verb in M1a, so this is the only route to a
    // tokenless row: pointing the ref back to 'stored' leaves no resolvable token.
    const created = await store().createSlackInstallation(aliceScope, {
      teamId: `TS_dead_${randomUUID().slice(0, 8)}`,
      botTokenRef: 'env:SLACK_UNSET_TOKEN',
      status: 'disabled',
    });
    expect(created.hasStoredToken).toBe(false);
    // Pointing the ref back to 'stored' (no stored token) while enabling is
    // rejected: an enabled-but-tokenless install would be silently dead.
    await expect(
      store().updateSlackInstallation(aliceScope, created.id, {
        status: 'enabled',
        botTokenRef: 'stored',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    await db.delete(slackInstallations).where(eq(slackInstallations.id, created.id));
  });

  it('soft-deletes only owned Slack installations: frees team_id, wipes the token, disables', async () => {
    const created = await store().createSlackInstallation(aliceScope, {
      teamId: `TS_del_${randomUUID().slice(0, 8)}`,
      botToken: 'xoxb-del',
      botUserId: 'U_del',
      status: 'enabled',
    });

    await expect(store().deleteSlackInstallation(bobScope, created.id)).rejects.toMatchObject({
      statusCode: 404,
    });
    const deleted = await store().deleteSlackInstallation(aliceScope, created.id);
    expect(deleted.id).toBe(created.id);
    expect(
      (await store().listSlackInstallations(aliceScope)).some((i) => i.id === created.id),
    ).toBe(false);

    const [row] = await db
      .select()
      .from(slackInstallations)
      .where(eq(slackInstallations.id, created.id));
    expect(row).toMatchObject({ status: 'disabled', botToken: null, botTokenRef: 'deleted' });
    expect(row?.teamId.startsWith('__deleted__')).toBe(true);

    await db.delete(slackInstallations).where(eq(slackInstallations.id, created.id));
  });

  // ── B5: a duplicate active binding is a 409, not a raw 500 ──
  it('translates the active-binding unique violation (23505) into a 409', async () => {
    const createdApp = await store().createFeishuApp(aliceScope, {
      tenantKey: aliceTenant,
      appId: `cli_dup_bind_${randomUUID().slice(0, 8)}`,
      appSecretRef: 'env:DUP_BIND',
      eventMode: 'websocket',
      status: 'enabled',
    });
    const createdAgent = await store().createAgent(aliceScope, {
      tenantKey: aliceTenant,
      scopeType: 'system',
      scopeId: 'default',
      handle: `dup_bind_${randomUUID().slice(0, 8)}`,
      displayName: 'Dup Bind Agent',
      visibility: 'public',
      memoryEnabled: true,
      status: 'active',
    });

    // Two concurrent binds for the same (agent, app): both run their deactivation
    // (nothing active yet) then both INSERT an active row. The partial unique
    // indexes (idx_agent_bot_bindings_active_agent / _active_app) let exactly one
    // win; the loser's 23505 must surface as a friendly 409, never a raw 500.
    const results = await Promise.allSettled([
      store().bindBot(aliceScope, { agentId: createdAgent.id, feishuAppId: createdApp.id }),
      store().bindBot(aliceScope, { agentId: createdAgent.id, feishuAppId: createdApp.id }),
    ]);
    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({ statusCode: 409 });

    await db.delete(agentBotBindings).where(eq(agentBotBindings.agentId, createdAgent.id));
    await db.delete(agents).where(eq(agents.id, createdAgent.id));
    await db.delete(agentProfiles).where(eq(agentProfiles.id, createdAgent.profileId));
    await db.delete(feishuApps).where(eq(feishuApps.id, createdApp.id));
  });

  // ── R2-1 chat/board scoping by per-agent ownership (NOT tenant) ──
  it('scopes chats to those where the user owns an agent active-in / bound-to', async () => {
    const aliceChats = await store().listChats(aliceScope);
    const chatIds = new Set(aliceChats.map((chat) => chat.chatId));
    // oc_alice: Alice's agent is the bound default; oc_shared_alice: active-in.
    expect(chatIds.has('oc_alice')).toBe(true);
    expect(chatIds.has('oc_shared_alice')).toBe(true);
    // Bob's chats (incl. the one in the SHARED tenant) are NOT visible to Alice.
    expect(chatIds.has('oc_bob')).toBe(false);
    expect(chatIds.has('oc_shared_bob')).toBe(false);
    expect(chatIds.has('oc_legacy')).toBe(false);

    const superChats = await store().listChats(superScope);
    const superChatIds = new Set(superChats.map((chat) => chat.chatId));
    expect(superChatIds.has('oc_alice')).toBe(true);
    expect(superChatIds.has('oc_bob')).toBe(true);
    expect(superChatIds.has('oc_legacy')).toBe(true);
    expect(superChatIds.has('oc_shared_alice')).toBe(true);
    expect(superChatIds.has('oc_shared_bob')).toBe(true);
  });

  it('does NOT leak a same-tenant colleague chat (R2-1 regression)', async () => {
    // Alice and Bob both own apps in `sharedTenant`. Under the rejected tenant-grant
    // model Alice would see Bob's `oc_shared_bob`; under per-agent ownership she must not.
    const bobChats = await store().listChats(bobScope);
    const bobChatIds = new Set(bobChats.map((chat) => chat.chatId));
    expect(bobChatIds.has('oc_shared_bob')).toBe(true);
    expect(bobChatIds.has('oc_shared_alice')).toBe(false);
    expect(bobChatIds.has('oc_alice')).toBe(false);
  });

  it('forbids patching a chat the user owns no agent in (404), incl. same-tenant', async () => {
    // Different tenant.
    await expect(
      store().updateChat(aliceScope, bobTenant, 'oc_bob', { defaultRuntime: 'codex' }),
    ).rejects.toMatchObject({ statusCode: 404 });
    // SAME tenant, colleague's chat — the R2-1 mutation hole.
    await expect(
      store().updateChat(aliceScope, sharedTenant, 'oc_shared_bob', { defaultRuntime: 'codex' }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('lets a user patch a chat they own an agent in, and superadmin patch any', async () => {
    const patched = await store().updateChat(aliceScope, sharedTenant, 'oc_shared_alice', {
      defaultRuntime: 'codex',
    });
    expect(patched.chatId).toBe('oc_shared_alice');
    expect(patched.defaultRuntime).toBe('codex');
    // Superadmin can patch a chat no plain user owns.
    const superPatched = await store().updateChat(superScope, legacyTenant, 'oc_legacy', {
      defaultRuntime: 'claude_code',
    });
    expect(superPatched.defaultRuntime).toBe('claude_code');
  });

  it('lets a user enable chat memory for an owned chat with the chat default agent', async () => {
    const enabled = await store().updateChat(aliceScope, aliceTenant, 'oc_alice', {
      memoryEnabled: true,
    });

    expect(enabled.memoryEnabled).toBe(true);
    expect(enabled.memorySummaryNextRunAt).toBeInstanceOf(Date);

    const [config] = await db
      .select()
      .from(chatConfigs)
      .where(eq(chatConfigs.chatId, 'oc_alice'))
      .limit(1);
    expect(config).toMatchObject({
      memoryEnabled: true,
      memorySummaryAgentId: aliceAgentId,
      memorySummaryTime: DEFAULT_CHAT_MEMORY_SUMMARY_TIME,
      memorySummaryTimezone: DEFAULT_CHAT_MEMORY_SUMMARY_TIMEZONE,
      memorySummaryLastStatus: null,
      memorySummaryLastError: null,
    });
    expect(config?.memorySummaryNextRunAt).toBeInstanceOf(Date);
  });

  it('enables chat memory from the recent owned chat agent when no default exists', async () => {
    await db
      .update(chatConfigs)
      .set({
        memoryEnabled: false,
        memorySummaryAgentId: bobSharedAgentId,
        memorySummaryNextRunAt: null,
      })
      .where(eq(chatConfigs.chatId, 'oc_shared_alice'));

    const enabled = await store().updateChat(aliceScope, sharedTenant, 'oc_shared_alice', {
      memoryEnabled: true,
    });

    expect(enabled.memoryEnabled).toBe(true);
    const [config] = await db
      .select()
      .from(chatConfigs)
      .where(eq(chatConfigs.chatId, 'oc_shared_alice'))
      .limit(1);
    expect(config).toMatchObject({
      defaultAgentId: null,
      memoryEnabled: true,
      memorySummaryAgentId: aliceSharedAgentId,
      memorySummaryTime: DEFAULT_CHAT_MEMORY_SUMMARY_TIME,
      memorySummaryTimezone: DEFAULT_CHAT_MEMORY_SUMMARY_TIMEZONE,
    });
    expect(config?.memorySummaryNextRunAt).toBeInstanceOf(Date);
  });

  it('rejects chat memory enablement when no active chat agent is available', async () => {
    await expect(
      store().updateChat(superScope, legacyTenant, 'oc_legacy', {
        memoryEnabled: true,
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: 'No active chat agent is available for chat memory summary',
    });
  });

  it('disables chat memory and clears pending summary metadata', async () => {
    await db
      .update(chatConfigs)
      .set({
        memoryEnabled: true,
        memorySummaryAgentId: aliceAgentId,
        memorySummaryNextRunAt: new Date('2026-06-24T01:30:00.000Z'),
        memorySummaryLastStatus: 'failed',
        memorySummaryLastError: 'previous failure',
      })
      .where(eq(chatConfigs.chatId, 'oc_alice'));

    const disabled = await store().updateChat(aliceScope, aliceTenant, 'oc_alice', {
      memoryEnabled: false,
    });

    expect(disabled.memoryEnabled).toBe(false);
    const [config] = await db
      .select()
      .from(chatConfigs)
      .where(eq(chatConfigs.chatId, 'oc_alice'))
      .limit(1);
    expect(config).toMatchObject({
      memoryEnabled: false,
      memorySummaryNextRunAt: null,
      memorySummaryLastStatus: null,
      memorySummaryLastError: null,
    });
  });

  // ── B1: chat defaultAgentId is ownership-scoped (mirrors the machine check) ──
  it("rejects setting a chat's defaultAgentId to another user's agent (404, no leak)", async () => {
    // Alice owns oc_shared_alice; bobSharedAgentId lives in the same tenant but is
    // privately owned by Bob. Setting it as the chat default is a cross-user
    // assignment hole — must 404 with the same not-found shape (no foreign agent).
    await expect(
      store().updateChat(aliceScope, sharedTenant, 'oc_shared_alice', {
        defaultAgentId: bobSharedAgentId,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("lets a user set the chat default to an agent they own, and clears it", async () => {
    const bound = await store().updateChat(aliceScope, sharedTenant, 'oc_shared_alice', {
      defaultAgentId: aliceSharedAgentId,
    });
    expect(bound.defaultAgentId).toBe(aliceSharedAgentId);
    const cleared = await store().updateChat(aliceScope, sharedTenant, 'oc_shared_alice', {
      defaultAgentId: null,
    });
    expect(cleared.defaultAgentId).toBeNull();
  });

  it('lets a superadmin set a chat default to any tenant agent (incl. legacy NULL-owner)', async () => {
    const bound = await store().updateChat(superScope, legacyTenant, 'oc_legacy', {
      defaultAgentId: legacyAgentId,
    });
    expect(bound.defaultAgentId).toBe(legacyAgentId);
    await store().updateChat(superScope, legacyTenant, 'oc_legacy', { defaultAgentId: null });
  });

  it('stamps the creating SSO user as owner on app and agent creation', async () => {
    const createdApp = await store().createFeishuApp(aliceScope, {
      tenantKey: aliceTenant,
      appId: `cli_created_${randomUUID().slice(0, 8)}`,
      appSecretRef: 'env:CREATED',
      eventMode: 'websocket',
      status: 'enabled',
    });
    expect(createdApp.platformOwnerId).toBe(aliceId);

    const createdAgent = await store().createAgent(aliceScope, {
      tenantKey: aliceTenant,
      scopeType: 'system',
      scopeId: 'default',
      handle: `created_${randomUUID().slice(0, 8)}`,
      displayName: 'Created Agent',
      runtimeEnv: { a: 'b' },
      visibility: 'public',
      memoryEnabled: true,
      status: 'active',
    });
    expect(createdAgent.platformOwnerId).toBe(aliceId);
    expect(createdAgent.runtimeEnvKeys).toEqual(['a']);

    // Cleanup created rows.
    await db.delete(agents).where(eq(agents.id, createdAgent.id));
    await db.delete(feishuApps).where(eq(feishuApps.id, createdApp.id));
  });

  it('keeps agent runtime env write-only across updates', async () => {
    const createdAgent = await store().createAgent(aliceScope, {
      tenantKey: aliceTenant,
      scopeType: 'system',
      scopeId: 'default',
      handle: `env_${randomUUID().slice(0, 8)}`,
      displayName: 'Env Agent',
      runtimeEnv: { SECRET_TOKEN: 'hidden', FEATURE_FLAG: 'enabled' },
      visibility: 'public',
      memoryEnabled: true,
      status: 'active',
    });
    expect(createdAgent.runtimeEnvKeys).toEqual(['FEATURE_FLAG', 'SECRET_TOKEN']);
    expect(createdAgent).not.toHaveProperty('runtimeEnv');

    const preserved = await store().updateAgent(aliceScope, createdAgent.id, {
      displayName: 'Env Agent v2',
    });
    expect(preserved.runtimeEnvKeys).toEqual(['FEATURE_FLAG', 'SECRET_TOKEN']);

    const anthropicOnly = await store().updateAgent(aliceScope, createdAgent.id, {
      runtimeEnv: { ANTHROPIC_API_KEY: 'sk-non-claude' },
    });
    expect(anthropicOnly.runtimeEnvKeys).toEqual(['ANTHROPIC_API_KEY']);

    const cleared = await store().updateAgent(aliceScope, createdAgent.id, { runtimeEnv: {} });
    expect(cleared.runtimeEnvKeys).toEqual([]);

    await db.delete(agents).where(eq(agents.id, createdAgent.id));
  });

  it('scopes the summary counts to owned resources', async () => {
    const aliceSummary = await store().getSummary(aliceScope);
    // Alice owns two apps (aliceApp + the shared-tenant app) and two agents
    // (aliceAgent + the shared-tenant agent); created rows were cleaned up.
    expect(aliceSummary.feishuApps).toBe(2);
    expect(aliceSummary.agents).toBe(2);
    // R2-1: summary chats are owned-chat scoped (oc_alice + oc_shared_alice), NOT
    // tenant scoped — Bob's oc_shared_bob in the same tenant must not be counted.
    expect(aliceSummary.chats).toBe(2);
    // Two console-owned machines (one online, one revoked) — the summary counts all
    // visible machines regardless of status; only `onlineMachines` filters by status.
    expect(aliceSummary.machines).toBe(2);
    expect(aliceSummary.onlineMachines).toBe(1);

    const superSummary = await store().getSummary(superScope);
    expect(superSummary.feishuApps).toBeGreaterThanOrEqual(3);
    expect(superSummary.agents).toBeGreaterThanOrEqual(3);
    expect(superSummary.machines).toBeGreaterThanOrEqual(3);
  });

  // ── D-A7 console-only machine ownership ──
  it('scopes machine listing to the console platform owner; hides legacy + others', async () => {
    const aliceMachines = await store().listMachines(aliceScope);
    const ids = new Set(aliceMachines.map((m) => m.id));
    expect(ids.has(aliceMachineId)).toBe(true);
    expect(ids.has(bobMachineId)).toBe(false);
    // Legacy NULL-platform-owner machine is hidden from plain users (fail closed).
    expect(ids.has(legacyMachineId)).toBe(false);

    const superMachines = await store().listMachines(superScope);
    const superIds = new Set(superMachines.map((m) => m.id));
    expect(superIds.has(aliceMachineId)).toBe(true);
    expect(superIds.has(bobMachineId)).toBe(true);
    expect(superIds.has(legacyMachineId)).toBe(true);
  });

  it('gates only the server-local execution choice when computer access is disabled', async () => {
    // Machines stay visible and manageable without computer access: ownership is
    // the boundary there. The allowlist gates server-side execution only.
    const summary = await store().getSummary(aliceNoComputerScope);
    expect(summary.machines).toBe(2);
    expect(summary.onlineMachines).toBe(1);
    const visibleMachines = await store().listMachines(aliceNoComputerScope);
    expect(visibleMachines.map((machine) => machine.id)).toContain(aliceMachineId);

    // Machine bindings and execution defaults stay visible in listings.
    await store().updateAgent(aliceScope, aliceAgentId, { machineId: aliceMachineId });
    await store().updateAgent(aliceScope, aliceAgentId, {
      defaultRuntime: 'codex',
      defaultWorkDir: '/srv/open-claude-tag/alice',
    });
    const visibleAgent = (await store().listAgents(aliceNoComputerScope)).find(
      (agent) => agent.id === aliceAgentId,
    );
    expect(visibleAgent?.machineId).toBe(aliceMachineId);
    expect(visibleAgent?.machine?.id).toBe(aliceMachineId);
    expect(visibleAgent?.defaultRuntime).toBe('codex');
    expect(visibleAgent?.defaultWorkDir).toBe('/srv/open-claude-tag/alice');

    // Pairing, disconnecting, re-binding to an OWNED machine, and execution
    // defaults are all open without computer access.
    const issued = await store().issuePairingToken(aliceNoComputerScope, {});
    expect(issued.token).toBeTruthy();
    await db.delete(machinePairingTokens).where(
      eq(machinePairingTokens.tokenHash, hashPairingToken(issued.token)),
    );
    await expect(
      store().disconnectMachine(aliceNoComputerScope, aliceMachineId),
    ).resolves.toMatchObject({ id: aliceMachineId });
    await expect(
      store().updateAgent(aliceNoComputerScope, aliceAgentId, { machineId: aliceMachineId }),
    ).resolves.toBeDefined();
    await expect(
      store().updateAgent(aliceNoComputerScope, aliceAgentId, { defaultRuntime: 'claude_code' }),
    ).resolves.toBeDefined();
    await expect(
      store().updateProfile(aliceNoComputerScope, aliceProfileId, { defaultRuntime: 'codex' }),
    ).resolves.toBeDefined();
    const openProfile = await store().createProfile(aliceNoComputerScope, {
      name: `open-profile-${randomUUID().slice(0, 8)}`,
      displayName: 'Open Profile',
      defaultRuntime: 'codex',
    });
    await db.delete(agentProfiles).where(eq(agentProfiles.id, openProfile.id));

    // Creating an agent bound to an owned machine is open as well.
    const boundAgent = await store().createAgent(aliceNoComputerScope, {
      tenantKey: aliceTenant,
      scopeType: 'system',
      scopeId: 'default',
      handle: `bound_${randomUUID().slice(0, 8)}`,
      displayName: 'Machine-bound Agent',
      machineId: aliceMachineId,
      visibility: 'public',
      memoryEnabled: true,
      status: 'active',
    });
    expect(boundAgent.machineId).toBe(aliceMachineId);
    await db.delete(agents).where(eq(agents.id, boundAgent.id));

    // The ONLY gated choice: server-local execution — creating an agent without
    // a machine binding, or clearing an existing binding back to server-local.
    await expect(
      store().updateAgent(aliceNoComputerScope, aliceAgentId, { machineId: null }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      store().createAgent(aliceNoComputerScope, {
        tenantKey: aliceTenant,
        scopeType: 'system',
        scopeId: 'default',
        handle: `blocked_null_${randomUUID().slice(0, 8)}`,
        displayName: 'Blocked Server-local Agent',
        machineId: null,
        visibility: 'public',
        memoryEnabled: true,
        status: 'active',
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
    await expect(
      store().createAgent(aliceNoComputerScope, {
        tenantKey: aliceTenant,
        scopeType: 'system',
        scopeId: 'default',
        handle: `blocked_omit_${randomUUID().slice(0, 8)}`,
        displayName: 'Blocked Implicit Server-local Agent',
        visibility: 'public',
        memoryEnabled: true,
        status: 'active',
      }),
    ).rejects.toMatchObject({ statusCode: 403 });

    // Chat machine defaults: binding an owned machine and clearing it are both
    // open — server-local capability is anchored at the agent level.
    await store().updateChat(aliceNoComputerScope, sharedTenant, 'oc_shared_alice', {
      defaultMachineId: aliceMachineId,
      defaultRuntime: 'codex',
      defaultWorkDir: '/srv/open-claude-tag/chat',
    });
    const visibleChat = (await store().listChats(aliceNoComputerScope)).find(
      (chat) => chat.chatId === 'oc_shared_alice',
    );
    expect(visibleChat?.defaultMachineId).toBe(aliceMachineId);
    expect(visibleChat?.defaultRuntime).toBe('codex');
    expect(visibleChat?.defaultWorkDir).toBe('/srv/open-claude-tag/chat');
    await store().updateChat(aliceNoComputerScope, sharedTenant, 'oc_shared_alice', {
      defaultMachineId: null,
      defaultRuntime: null,
      defaultWorkDir: null,
    });

    // Restore the fixture agent to its original server-local state.
    await store().updateAgent(aliceScope, aliceAgentId, {
      machineId: null,
      defaultRuntime: null,
      defaultWorkDir: null,
    });
  });

  it('accepts a subscription-mode claude_code agent created via profileId', async () => {
    const claudeProfileId = randomUUID();
    await db.insert(agentProfiles).values({
      id: claudeProfileId,
      name: `prof-claude-${claudeProfileId.slice(0, 8)}`,
      displayName: 'Claude Profile',
      defaultRuntime: 'claude_code',
      platformOwnerId: aliceId,
    });

    const subscription = await store().createAgent(aliceScope, {
      tenantKey: aliceTenant,
      scopeType: 'system',
      scopeId: 'default',
      handle: `claude_subscription_${randomUUID().slice(0, 8)}`,
      displayName: 'Claude Subscription Agent',
      profileId: claudeProfileId,
      visibility: 'public',
      memoryEnabled: true,
      status: 'active',
    });
    expect(subscription.profileId).toBe(claudeProfileId);
    expect(subscription.runtimeEnvKeys).toEqual([]);

    // Mixed payload: a decoy inline profile (codex) must NOT mask the bound
    // EXISTING claude_code profile. When profileId is set, the inline profile is
    // ignored for storage, so the existing profile remains bound.
    const decoy = await store().createAgent(aliceScope, {
      tenantKey: aliceTenant,
      scopeType: 'system',
      scopeId: 'default',
      handle: `claude_decoy_${randomUUID().slice(0, 8)}`,
      displayName: 'Claude Decoy Agent',
      profileId: claudeProfileId,
      profile: { defaultRuntime: 'codex' },
      visibility: 'public',
      memoryEnabled: true,
      status: 'active',
    });
    expect(decoy.profileId).toBe(claudeProfileId);
    expect(decoy.runtimeEnvKeys).toEqual([]);

    await expect(
      store().createAgent(aliceScope, {
        tenantKey: aliceTenant,
        scopeType: 'system',
        scopeId: 'default',
        handle: `claude_partial_${randomUUID().slice(0, 8)}`,
        displayName: 'Claude Partial Agent',
        profileId: claudeProfileId,
        runtimeEnv: { ANTHROPIC_API_KEY: 'sk-secret' },
        visibility: 'public',
        memoryEnabled: true,
        status: 'active',
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('ANTHROPIC_BASE_URL'),
    });

    // Supplying the per-agent credentials makes the same inheritance succeed.
    const ok = await store().createAgent(aliceScope, {
      tenantKey: aliceTenant,
      scopeType: 'system',
      scopeId: 'default',
      handle: `claude_ok_${randomUUID().slice(0, 8)}`,
      displayName: 'Claude OK Agent',
      profileId: claudeProfileId,
      runtimeEnv: {
        ANTHROPIC_BASE_URL: 'https://gw.example/v1',
        ANTHROPIC_API_KEY: 'sk-secret',
      },
      visibility: 'public',
      memoryEnabled: true,
      status: 'active',
    });
    expect(ok.profileId).toBe(claudeProfileId);

    await expect(
      store().updateAgent(aliceScope, subscription.id, {
        runtimeEnv: { ANTHROPIC_API_KEY: 'sk-secret' },
      }),
    ).rejects.toMatchObject({
      statusCode: 400,
      message: expect.stringContaining('ANTHROPIC_BASE_URL'),
    });
    const patched = await store().updateAgent(aliceScope, subscription.id, {
      runtimeEnv: {
        ANTHROPIC_BASE_URL: 'https://gw.example/v1',
        ANTHROPIC_API_KEY: 'sk-secret',
      },
    });
    expect(patched.runtimeEnvKeys).toEqual(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']);

    await db.delete(agents).where(inArray(agents.id, [subscription.id, decoy.id, ok.id]));
    await db.delete(agentProfiles).where(eq(agentProfiles.id, claudeProfileId));
  });

  // ── D-A9 server-initiated machine disconnect ──
  it('owner disconnect stamps disconnect_requested_at without revoking', async () => {
    const before = Date.now();
    const dto = await store().disconnectMachine(aliceScope, aliceMachineId);
    expect(dto.id).toBe(aliceMachineId);
    // Not a revoke: status is unchanged (still online).
    expect(dto.status).toBe('online');
    const [row] = await db
      .select()
      .from(machines)
      .where(eq(machines.id, aliceMachineId))
      .limit(1);
    expect(row.disconnectRequestedAt).toBeInstanceOf(Date);
    expect(row.disconnectRequestedAt!.getTime()).toBeGreaterThanOrEqual(before);
    // Credentials untouched — the secret hash is still present.
    expect(row.secretHash).toBe('h-a');
  });

  it('is idempotent: re-disconnecting an owned machine just re-stamps the time', async () => {
    const first = await store().disconnectMachine(aliceScope, aliceMachineId);
    const second = await store().disconnectMachine(aliceScope, aliceMachineId);
    expect(first.id).toBe(aliceMachineId);
    expect(second.id).toBe(aliceMachineId);
  });

  it("rejects disconnecting another owner's machine with a 404 (existence hidden)", async () => {
    await expect(store().disconnectMachine(aliceScope, bobMachineId)).rejects.toMatchObject({
      statusCode: 404,
    });
    // Bob's machine was NOT stamped.
    const [row] = await db
      .select()
      .from(machines)
      .where(eq(machines.id, bobMachineId))
      .limit(1);
    expect(row.disconnectRequestedAt).toBeNull();
  });

  it('lets a superadmin disconnect any machine including legacy NULL-owner rows', async () => {
    const dto = await store().disconnectMachine(superScope, legacyMachineId);
    expect(dto.id).toBe(legacyMachineId);
    const [row] = await db
      .select()
      .from(machines)
      .where(eq(machines.id, legacyMachineId))
      .limit(1);
    expect(row.disconnectRequestedAt).toBeInstanceOf(Date);
  });

  it('returns 404 for a missing machine id', async () => {
    await expect(store().disconnectMachine(aliceScope, randomUUID())).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it('issues a console pairing token stamped with the platform issuer, no openId/chat', async () => {
    const before = Date.now();
    const issued = await store().issuePairingToken(aliceScope, { name: 'alice-station' });
    expect(typeof issued.token).toBe('string');
    expect(issued.token.length).toBeGreaterThan(20);
    expect(issued.machineName).toBe('alice-station');
    // 10-minute TTL.
    expect(issued.expiresAt.getTime()).toBeGreaterThan(before + 9 * 60_000);
    expect(issued.expiresAt.getTime()).toBeLessThan(before + 11 * 60_000);

    // The stored row carries platform_issuer_id, NULL openId/chat, and only the
    // SHA-256 hash of the token (plaintext is never persisted).
    const [row] = await db
      .select()
      .from(machinePairingTokens)
      .where(eq(machinePairingTokens.tokenHash, hashPairingToken(issued.token)))
      .limit(1);
    expect(row).toBeTruthy();
    expect(row.platformIssuerId).toBe(aliceId);
    expect(row.issuerOpenId).toBeNull();
    expect(row.chatId).toBeNull();
    expect(row.tenantKey).toBe(aliceTenant);
    expect(row.usedAt).toBeNull();
  });

  it('rejects token issuance for a token-admin (no platform user) with a 400', async () => {
    await expect(store().issuePairingToken(superScope, {})).rejects.toMatchObject({
      statusCode: 400,
      message: 'log in as a user to pair a machine',
    });
  });

  // ── D-A8 agent ↔ machine binding ──
  it('creates an agent bound to the owner own machine and surfaces machine info in the DTO', async () => {
    const created = await store().createAgent(aliceScope, {
      tenantKey: aliceTenant,
      scopeType: 'system',
      scopeId: 'default',
      handle: `m_${randomUUID().slice(0, 8)}`,
      displayName: 'Bound Agent',
      machineId: aliceMachineId,
      visibility: 'public',
      memoryEnabled: true,
      status: 'active',
    });
    expect(created.machineId).toBe(aliceMachineId);
    expect(created.machine).toMatchObject({ id: aliceMachineId, name: 'alice-mbp', status: 'online' });

    // listAgents joins the machine label so the console can group by machine.
    const listed = (await store().listAgents(aliceScope)).find((a) => a.id === created.id);
    expect(listed?.machine).toMatchObject({ id: aliceMachineId, name: 'alice-mbp' });

    await db.delete(agents).where(eq(agents.id, created.id));
  });

  it('creates a server-local agent when machineId is null/omitted', async () => {
    const created = await store().createAgent(aliceScope, {
      tenantKey: aliceTenant,
      scopeType: 'system',
      scopeId: 'default',
      handle: `sl_${randomUUID().slice(0, 8)}`,
      displayName: 'Server-local Agent',
      machineId: null,
      visibility: 'public',
      memoryEnabled: true,
      status: 'active',
    });
    expect(created.machineId).toBeNull();
    expect(created.machine).toBeNull();
    await db.delete(agents).where(eq(agents.id, created.id));
  });

  it('rejects creating an agent bound to another user machine (400)', async () => {
    await expect(
      store().createAgent(aliceScope, {
        tenantKey: aliceTenant,
        scopeType: 'system',
        scopeId: 'default',
        handle: `x_${randomUUID().slice(0, 8)}`,
        displayName: 'Cross Agent',
        machineId: bobMachineId,
        visibility: 'public',
        memoryEnabled: true,
        status: 'active',
      }),
    ).rejects.toMatchObject({ statusCode: 400, message: 'Selected machine is not owned by you' });
  });

  it('rejects creating an agent bound to a revoked machine (400)', async () => {
    await expect(
      store().createAgent(aliceScope, {
        tenantKey: aliceTenant,
        scopeType: 'system',
        scopeId: 'default',
        handle: `r_${randomUUID().slice(0, 8)}`,
        displayName: 'Revoked Agent',
        machineId: aliceRevokedMachineId,
        visibility: 'public',
        memoryEnabled: true,
        status: 'active',
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('lets a user bind/clear the machine on their own agent and rejects another user machine', async () => {
    // Bind Alice's agent to her machine.
    const bound = await store().updateAgent(aliceScope, aliceAgentId, { machineId: aliceMachineId });
    expect(bound.machineId).toBe(aliceMachineId);
    // Patching to Bob's machine is rejected (400, not 404 — ownership of the agent
    // is fine, it is the machine that is not bindable).
    await expect(
      store().updateAgent(aliceScope, aliceAgentId, { machineId: bobMachineId }),
    ).rejects.toMatchObject({ statusCode: 400 });
    // Clearing back to server-local (null) is always allowed.
    const cleared = await store().updateAgent(aliceScope, aliceAgentId, { machineId: null });
    expect(cleared.machineId).toBeNull();
  });

  it('lets a superadmin bind any non-revoked machine to a legacy agent', async () => {
    const bound = await store().updateAgent(superScope, legacyAgentId, { machineId: bobMachineId });
    expect(bound.machineId).toBe(bobMachineId);
    await store().updateAgent(superScope, legacyAgentId, { machineId: null });
  });

  // ── R2-2 chat machine-binding respects machine ownership ──
  it("rejects binding a chat to another user's machine (400)", async () => {
    // Alice owns oc_shared_alice; binding it to Bob's machine is a cross-user
    // remote-code-execution path and must be rejected.
    await expect(
      store().updateChat(aliceScope, sharedTenant, 'oc_shared_alice', {
        defaultMachineId: bobMachineId,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('lets a user bind a chat to their OWN machine and clear it', async () => {
    const bound = await store().updateChat(aliceScope, sharedTenant, 'oc_shared_alice', {
      defaultMachineId: aliceMachineId,
    });
    expect(bound.defaultMachineId).toBe(aliceMachineId);
    const cleared = await store().updateChat(aliceScope, sharedTenant, 'oc_shared_alice', {
      defaultMachineId: null,
    });
    expect(cleared.defaultMachineId).toBeNull();
  });

  it('rejects binding a chat to a revoked machine (400)', async () => {
    await expect(
      store().updateChat(aliceScope, sharedTenant, 'oc_shared_alice', {
        defaultMachineId: aliceRevokedMachineId,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it("lets a superadmin bind a chat to any user's machine (operator surface)", async () => {
    const bound = await store().updateChat(superScope, legacyTenant, 'oc_legacy', {
      defaultMachineId: bobMachineId,
    });
    expect(bound.defaultMachineId).toBe(bobMachineId);
    await store().updateChat(superScope, legacyTenant, 'oc_legacy', { defaultMachineId: null });
  });

  // ── R2-1 task-board scoping by per-agent ownership ──
  it('scopes task boards to the owned chat set (R2-1)', async () => {
    const boardId = randomUUID();
    const otherBoardId = randomUUID();
    await db.insert(feishuTaskTrackingSpaces).values([
      {
        id: boardId,
        scopeType: 'chat',
        scopeId: `${sharedTenant}:oc_shared_alice`,
        tasklistGuid: `tl-${boardId}`,
        statusFieldGuid: `sf-${boardId}`,
      },
      {
        id: otherBoardId,
        scopeType: 'chat',
        scopeId: `${sharedTenant}:oc_shared_bob`,
        tasklistGuid: `tl-${otherBoardId}`,
        statusFieldGuid: `sf-${otherBoardId}`,
      },
    ]);
    try {
      const aliceBoards = await store().listTaskBoards(aliceScope);
      const ids = new Set(aliceBoards.map((b) => b.id));
      expect(ids.has(boardId)).toBe(true);
      // Bob's board in the SAME tenant is not visible to Alice (R2-1).
      expect(ids.has(otherBoardId)).toBe(false);

      // Direct read of a board the user does not own a chat-agent in → 404.
      await expect(store().listTaskBoardTasks(aliceScope, otherBoardId)).rejects.toMatchObject({
        statusCode: 404,
      });
      // Own board reads fine.
      await expect(store().listTaskBoardTasks(aliceScope, boardId)).resolves.toBeInstanceOf(Array);

      // Superadmin sees both.
      const superBoards = await store().listTaskBoards(superScope);
      const superIds = new Set(superBoards.map((b) => b.id));
      expect(superIds.has(boardId)).toBe(true);
      expect(superIds.has(otherBoardId)).toBe(true);
    } finally {
      await db
        .delete(feishuTaskTrackingSpaces)
        .where(inArray(feishuTaskTrackingSpaces.id, [boardId, otherBoardId]));
    }
  });

  // ── R2-6 agent profile ownership ──
  it('lists builtin/shared + own profiles for a plain user; superadmin sees all', async () => {
    const aliceProfiles = await store().listProfiles(aliceScope);
    const ids = new Set(aliceProfiles.map((p) => p.id));
    // Alice's own profile + the builtin/shared (NULL owner) profile are visible.
    expect(ids.has(aliceProfileId)).toBe(true);
    expect(ids.has(builtinProfileId)).toBe(true);
    // The shared profile owned by no one (NULL) is visible; profiles owned by Bob
    // are not — Bob owns none here, so assert Bob does not see Alice's owned profile.
    const bobProfiles = await store().listProfiles(bobScope);
    const bobIds = new Set(bobProfiles.map((p) => p.id));
    expect(bobIds.has(aliceProfileId)).toBe(false);
    expect(bobIds.has(builtinProfileId)).toBe(true);

    const superProfiles = await store().listProfiles(superScope);
    const superIds = new Set(superProfiles.map((p) => p.id));
    expect(superIds.has(aliceProfileId)).toBe(true);
    expect(superIds.has(builtinProfileId)).toBe(true);
    // Owner label surfaced to superadmin only.
    expect(superProfiles.find((p) => p.id === aliceProfileId)?.platformOwner).toMatchObject({
      id: aliceId,
    });
    expect(aliceProfiles.find((p) => p.id === aliceProfileId)?.platformOwner).toBeNull();
  });

  it('blocks cross-user profile mutation even when the user owns an agent using it', async () => {
    // Bob attaches the BUILTIN (shared) profile to his own agent...
    await store().updateAgent(bobScope, bobAgentId, { profileId: builtinProfileId });
    try {
      // ...then tries to rewrite the shared profile for everyone. The old loophole
      // ("owns an agent using it") allowed this; R2-6 blocks it (must own the profile).
      await expect(
        store().updateProfile(bobScope, builtinProfileId, { systemPrompt: 'hijacked' }),
      ).rejects.toMatchObject({ statusCode: 404 });
      // Inline edit through the agent form is blocked too.
      await expect(
        store().updateAgent(bobScope, bobAgentId, { profile: { systemPrompt: 'hijacked' } }),
      ).rejects.toMatchObject({ statusCode: 404 });
    } finally {
      await store().updateAgent(bobScope, bobAgentId, { profileId: sharedProfileId });
    }
  });

  it("rejects mutating another user's owned profile (404)", async () => {
    await expect(
      store().updateProfile(bobScope, aliceProfileId, { systemPrompt: 'hijacked' }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('lets the owner mutate their profile and a superadmin mutate any', async () => {
    const updated = await store().updateProfile(aliceScope, aliceProfileId, {
      systemPrompt: 'alice prompt',
    });
    expect(updated.systemPrompt).toBe('alice prompt');
    // Superadmin may mutate the builtin/shared profile.
    const superUpdated = await store().updateProfile(superScope, builtinProfileId, {
      description: 'ops-updated',
    });
    expect(superUpdated.description).toBe('ops-updated');
  });

  // ── B2: agent profileId reassignment is ownership-scoped ──
  it("rejects reassigning an agent's profileId to another user's private profile (404)", async () => {
    // bobAgentId currently uses sharedProfileId. Reassigning it to Alice's PRIVATE
    // profile must 404 (no leak) — owning the agent is not enough to attach a
    // profile you do not own.
    await expect(
      store().updateAgent(bobScope, bobAgentId, { profileId: aliceProfileId }),
    ).rejects.toMatchObject({ statusCode: 404 });
    // The agent's profile is untouched after the rejection.
    const [unchanged] = await db.select().from(agents).where(eq(agents.id, bobAgentId));
    expect(unchanged?.profileId).toBe(sharedProfileId);
  });

  it('lets a user reassign profileId to a builtin/shared (NULL-owner) profile', async () => {
    const patched = await store().updateAgent(bobScope, bobAgentId, {
      profileId: builtinProfileId,
    });
    expect(patched.profileId).toBe(builtinProfileId);
    // Restore so later tests see the original shared profile.
    await store().updateAgent(bobScope, bobAgentId, { profileId: sharedProfileId });
  });

  it('lets a user reassign profileId to a profile they own', async () => {
    const patched = await store().updateAgent(aliceScope, aliceAgentId, {
      profileId: aliceProfileId,
    });
    expect(patched.profileId).toBe(aliceProfileId);
    // Restore so later tests see the original shared profile.
    await store().updateAgent(aliceScope, aliceAgentId, { profileId: sharedProfileId });
  });

  it('404s reassigning profileId to a non-existent profile', async () => {
    await expect(
      store().updateAgent(aliceScope, aliceAgentId, { profileId: randomUUID() }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it('stamps the creating user as profile owner; token-admin creates a shared (NULL) profile', async () => {
    const owned = await store().createProfile(aliceScope, {
      name: `created-${randomUUID().slice(0, 8)}`,
      displayName: 'Created By Alice',
    });
    expect(owned.platformOwnerId).toBe(aliceId);
    const shared = await store().createProfile(superScope, {
      name: `created-shared-${randomUUID().slice(0, 8)}`,
      displayName: 'Created By Ops',
    });
    expect(shared.platformOwnerId).toBeNull();
    await db.delete(agentProfiles).where(inArray(agentProfiles.id, [owned.id, shared.id]));
  });
});
