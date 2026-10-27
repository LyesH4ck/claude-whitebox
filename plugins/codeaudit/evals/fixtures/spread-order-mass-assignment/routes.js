const { prisma } = require('./db');

const PROFILE_FIELDS = ['displayName', 'title', 'timezone', 'avatarUrl'];

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj[k] !== undefined) out[k] = obj[k];
  return out;
}

async function routes(app) {
  app.addHook('preHandler', app.requireSession);

  // Newcomers always start as members; the inviter fills in the profile.
  app.post('/members', async (req, reply) => {
    const member = await prisma.member.create({
      data: {
        role: 'member',
        workspaceId: req.session.workspaceId,
        invitedBy: req.session.userId,
        ...req.body,
      },
    });
    return reply.code(201).send(member);
  });

  app.patch('/members/me', async (req, reply) => {
    const updateProfile = pick(req.body, PROFILE_FIELDS);
    const member = await prisma.member.update({
      where: { id: req.session.memberId },
      data: updateProfile,
    });
    return reply.send(member);
  });

  app.patch('/members/:id/role', { preHandler: app.requireOwner }, async (req, reply) => {
    const member = await prisma.member.update({
      where: { id: req.params.id, workspaceId: req.session.workspaceId },
      data: { role: req.body.role },
    });
    return reply.send(member);
  });
}

module.exports = routes;
