import { createDb } from './db.js';
import { users, sessions } from './schema.js';
import { seedBuiltInAgentIdentity } from './agent-bootstrap.js';

async function seed() {
  const db = createDb();

  console.log('Seeding database...');

  const builtInAgent = await seedBuiltInAgentIdentity(db, {
    primaryFeishuAppId: process.env.FEISHU_APP_ID,
    primaryFeishuAppSecretRef: 'FEISHU_APP_SECRET',
  });
  console.log(`Seeded built-in agent: ${builtInAgent.agentId}`);

  // Insert test owner user
  const [owner] = await db
    .insert(users)
    .values({
      feishuOpenId: 'ou_seed000000000000000000000000000000',
      feishuUnionId: 'on_seed_owner_001',
      displayName: 'System Owner',
      role: 'owner',
      preferences: { language: 'zh-CN' },
    })
    .onConflictDoUpdate({
      target: users.feishuOpenId,
      set: {
        feishuUnionId: 'on_seed_owner_001',
        displayName: 'System Owner',
        role: 'owner',
        preferences: { language: 'zh-CN' },
        updatedAt: new Date(),
      },
    })
    .returning();

  if (owner) {
    console.log(`Created owner user: ${owner.id}`);

    // Create a default session for testing
    const [session] = await db
      .insert(sessions)
      .values({
        sessionKey: 'feishu:test:p2p:ou_seed_owner_001',
        chatId: 'p2p_test_chat',
        scope: 'p2p',
        status: 'active',
        title: 'Test Session',
        createdBy: owner.id,
      })
      .onConflictDoNothing()
      .returning();

    if (session) {
      console.log(`Created test session: ${session.id}`);
    }
  }

  console.log('Seed completed.');
  process.exit(0);
}

seed().catch((err) => {
  console.error('Seed failed:', err);
  process.exit(1);
});
