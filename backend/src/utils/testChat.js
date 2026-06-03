/**
 * Helpdesk chat logic test harness — runnable against the dev DB.
 * Throwaway data (emails prefixed `ctest_`), self-cleanup.
 *   node src/utils/testChat.js
 */
require('dotenv').config();
const mongoose = require('mongoose');

let pass = 0, fail = 0;
const ok = (c, m) => { c ? (pass++, console.log('  ✓', m)) : (fail++, console.error('  ✗', m)); };

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
  const User = require('../models/User');
  const { Conversation, ChatMessage } = require('../models/Chat');
  const { ROLES } = require('../config/constants');
  const chat = require('../services/chatService');

  const rc = () => 'CT' + Math.random().toString(36).slice(2, 8).toUpperCase();
  const mk = async (suffix, role = ROLES.USER, managerId = null) =>
    User.create({ email: `ctest_${Date.now()}_${suffix}@ex.com`, passwordHash: 'x', firstName: 'C', lastName: suffix, role, managerId, referralCode: rc() });

  const mgr = await mk('mgr', ROLES.MANAGER);
  const otherMgr = await mk('mgr2', ROLES.MANAGER);
  const usr = await mk('usr', ROLES.USER, mgr._id);
  const ids = [mgr._id, otherMgr._id, usr._id];
  const reqUser = { _id: usr._id, role: ROLES.USER };
  const reqMgr = { _id: mgr._id, role: ROLES.MANAGER };
  const reqOther = { _id: otherMgr._id, role: ROLES.MANAGER };
  const reqSuper = { _id: new mongoose.Types.ObjectId(), role: ROLES.SUPER_ADMIN };

  try {
    console.log('— getOrCreate resolves assigned manager —');
    const conv = await chat.getOrCreateForUser(usr._id);
    ok(String(conv.managerId) === String(mgr._id), 'conversation managerId = assigned manager');

    console.log('— user sends → manager unread +1 —');
    await chat.sendMessage(conv._id, reqUser, { text: 'Hello manager' });
    let c2 = await Conversation.findById(conv._id).lean();
    ok(c2.unreadForManager === 1 && c2.unreadForUser === 0, 'unreadForManager incremented');
    ok(c2.lastMessageText === 'Hello manager', 'lastMessageText updated');

    console.log('— manager replies → user unread +1 —');
    await chat.sendMessage(conv._id, reqMgr, { text: 'Hi, how can I help?' });
    c2 = await Conversation.findById(conv._id).lean();
    ok(c2.unreadForUser === 1, 'unreadForUser incremented after manager reply');

    console.log('— manager marks seen —');
    await chat.markSeen(conv._id, reqMgr);
    c2 = await Conversation.findById(conv._id).lean();
    ok(c2.unreadForManager === 0, 'unreadForManager reset on seen');
    const userMsg = await ChatMessage.findOne({ conversationId: conv._id, senderRole: 'USER' }).lean();
    ok(!!userMsg.seenAt, 'user message marked seen');

    console.log('— authorize —');
    try { chat.authorize(c2, reqOther); ok(false, 'outsider manager should be blocked'); }
    catch (e) { ok(e.statusCode === 403, 'outsider manager blocked (403)'); }
    ok(chat.authorize(c2, reqSuper) === true, 'superadmin authorized');
    ok(chat.authorize(c2, reqUser) === true, 'owning user authorized');

    console.log('— manager list scope —');
    const myList = await chat.listForManager(mgr._id, {});
    ok(myList.items.length === 1 && String(myList.items[0].userId) === String(usr._id), 'manager sees only their conversation');
    const otherList = await chat.listForManager(otherMgr._id, {});
    ok(otherList.items.length === 0, 'other manager sees nothing');

    console.log('— attachment >1MB rejected —');
    const big = 'data:image/png;base64,' + 'A'.repeat(1500000);
    try { await chat.sendMessage(conv._id, reqUser, { attachments: [{ name: 'big.png', mimeType: 'image/png', dataUrl: big }] }); ok(false, 'big attachment should reject'); }
    catch (e) { ok(e.code === 'ATTACH_TOO_LARGE', '>1MB attachment rejected'); }

    console.log('— history oldest-first —');
    const h = await chat.history(conv._id, reqUser, {});
    ok(h.length === 2 && h[0].text === 'Hello manager', 'history oldest-first');

    console.log('— manager initiates (getOrCreateWithUser) —');
    const convM = await chat.getOrCreateWithUser(usr._id, reqMgr);
    ok(String(convM._id) === String(conv._id), 'owning manager opens the same conversation');
    try { await chat.getOrCreateWithUser(usr._id, reqOther); ok(false, 'outsider manager should be blocked from opening'); }
    catch (e) { ok(e.statusCode === 403 && e.code === 'OUT_OF_SCOPE', 'outsider manager blocked from opening (403/OUT_OF_SCOPE)'); }
    const convS = await chat.getOrCreateWithUser(usr._id, reqSuper);
    ok(String(convS._id) === String(conv._id), 'superadmin opens the conversation');

    console.log('— reassign repoints conversation —');
    await User.updateOne({ _id: usr._id }, { managerId: otherMgr._id });
    const conv2 = await chat.getOrCreateForUser(usr._id);
    ok(String(conv2.managerId) === String(otherMgr._id), 'conversation repointed after reassign');
  } catch (e) {
    fail++; console.error('  ✗ UNEXPECTED', e.stack || e.message);
  } finally {
    const convs = await Conversation.find({ userId: { $in: ids } }).select('_id').lean();
    await ChatMessage.deleteMany({ conversationId: { $in: convs.map((c) => c._id) } });
    await Conversation.deleteMany({ userId: { $in: ids } });
    await User.deleteMany({ _id: { $in: ids } });
    console.log(`\nRESULT: ${pass} passed, ${fail} failed`);
    await mongoose.disconnect();
    process.exit(fail ? 1 : 0);
  }
})();
