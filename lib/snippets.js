// ==================== 文本片段模块 ====================

const crypto = require('crypto');
const { loadSnippets, saveSnippets } = require('./persistence');
const { requireAdmin, csrfCheck } = require('./auth');

function createSnippetHandler(req, res) {
  const { content } = req.body;
  if (!content || !content.trim()) return res.status(400).json({ error: '内容不能为空' });

  const snippets = loadSnippets();
  let snippetKey;
  do { snippetKey = crypto.randomBytes(3).toString('hex'); } while (snippets[snippetKey]);

  snippets[snippetKey] = {
    content,
    createdAt: new Date().toISOString(),
    expiresAt: null
  };

  saveSnippets(snippets);
  res.json({ success: true, key: snippetKey });
}

function getSnippetHandler(req, res) {
  const snippets = loadSnippets();
  const snippet = snippets[req.params.key];
  if (!snippet) return res.status(404).json({ error: '片段不存在或已过期' });
  if (snippet.expiresAt && Date.now() > new Date(snippet.expiresAt).getTime()) {
    delete snippets[req.params.key];
    saveSnippets(snippets);
    return res.status(410).json({ error: '片段已过期' });
  }
  res.json({ success: true, content: snippet.content, createdAt: snippet.createdAt });
}

module.exports = {
  createSnippetHandler,
  getSnippetHandler
};
