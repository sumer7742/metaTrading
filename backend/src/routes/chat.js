const express = require('express');
const c = require('../controllers/chatController');
const { authenticate } = require('../middleware/auth');

const router = express.Router();
router.use(authenticate);

// User-facing: my conversation with my assigned manager.
router.get('/conversation', c.myConversation);

// Manager / SuperAdmin: list conversations (scoped server-side).
router.get('/conversations', c.listConversations);

// Manager / SuperAdmin: start (or reopen) a chat with an assigned user.
router.post('/conversations/open', c.openConversation);

// Shared (authorized inside the service per-conversation).
router.get('/conversations/:id/messages', c.getMessages);
router.post('/conversations/:id/messages', c.postMessage);
router.post('/conversations/:id/seen', c.postSeen);
router.post('/conversations/:id/typing', c.postTyping);

module.exports = router;
