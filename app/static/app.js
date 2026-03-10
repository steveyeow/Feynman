/* ─── Feynman — Learn by asking questions ─── */

// ─── State ───
let agents = [];
let votes = [];
let allBooks = [];
let currentBookId = null;
let libraryFilter = 'all';
let librarySearch = '';
let pollTimer = null;

// Chat state
let selectedBooks = new Map();
let selectedMinds = new Map();
let chatSessions = [];
let currentSessionId = null;
let sessionCounter = 0;

// Topic state
let topicTags = [];
let activeTopics = new Set();   // currently selected as filters
let loadingTopics = new Set();

// Onboarding state
let userName = localStorage.getItem('userName') || '';

const MOCK_QUESTIONS = [
  'What is the central thesis of this book?',
  'How does the author support their main argument?',
  'What are the key concepts introduced?',
  'How does this relate to what you already know?',
  'What are the practical implications?',
];

// ─── Greeting ───
function getGreeting() {
  const h = new Date().getHours();
  let g = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  if (userName) g += ', ' + userName;
  return g;
}

// Minds state
let allMinds = [];
let currentMindId = null;
let mindChatHistory = [];

// ─── Router ───
function getRoute() {
  const hash = window.location.hash || '#/';
  if (hash === '#/' || hash === '#') return { page: 'home' };
  if (hash === '#/chat') return { page: 'chat' };
  if (hash === '#/chats') return { page: 'chats' };
  if (hash === '#/library') return { page: 'library' };
  if (hash === '#/minds') return { page: 'minds' };
  const mm = hash.match(/^#\/mind\/(.+)$/);
  if (mm) return { page: 'mind', id: mm[1] };
  const m = hash.match(/^#\/book\/(.+)$/);
  if (m) return { page: 'book', id: m[1] };
  return { page: 'home' };
}

function navigate() {
  const route = getRoute();
  document.querySelectorAll('.page-view').forEach(el => el.classList.add('hidden'));
  const el = document.getElementById('page-' + route.page);
  if (el) el.classList.remove('hidden');

  switch (route.page) {
    case 'home':
      renderHome();
      renderSelectedChips();
      break;
    case 'chat': onChatPageShow(); break;
    case 'chats': renderChatsPage(); break;
    case 'library': renderLibrary(); break;
    case 'minds': renderMindsPage(); break;
    case 'mind':
      currentMindId = route.id;
      renderMindDetail(route.id);
      break;
    case 'book':
      currentBookId = route.id;
      renderBookDetail(route.id);
      break;
  }
}
window.addEventListener('hashchange', navigate);

// ─── Sidebar toggle ───
function toggleSidebar() {
  document.getElementById('app-layout').classList.toggle('sidebar-collapsed');
}

// ─── API ───
async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  const d = await r.json();
  if (!r.ok) throw new Error(d.detail || 'Request failed');
  return d;
}

async function loadAgents() {
  try { agents = await api('/api/agents'); } catch { agents = []; }
  buildBookList();
}

async function loadVotes() {
  try { votes = await api('/api/votes'); } catch { votes = []; }
}

async function loadTopics() {
  try {
    const data = await api('/api/topics');
    topicTags = data.topics || [];
  } catch { topicTags = []; }
}

function renderTopicTags() {
  const grid = document.getElementById('topic-tags-grid');
  if (!grid || !topicTags.length) return;
  grid.innerHTML = topicTags.map(topic => {
    const isLoading = loadingTopics.has(topic);
    const isActive = activeTopics.has(topic);
    let cls = 'topic-tag';
    if (isLoading) cls += ' loading';
    else if (isActive) cls += ' active';
    const spinner = isLoading ? '<span class="loading-dot" style="margin-right:5px;font-size:11px">...</span>' : '';
    return `<button class="${cls}" data-topic="${esc(topic)}">${spinner}${esc(topic)}</button>`;
  }).join('');
  grid.querySelectorAll('.topic-tag').forEach(btn => {
    btn.addEventListener('click', () => handleTopicClick(btn.dataset.topic));
  });
}

async function handleTopicClick(topic) {
  if (loadingTopics.has(topic)) return;

  // Toggle filter
  if (activeTopics.has(topic)) {
    activeTopics.delete(topic);
    renderTopicTags();
    renderLibraryGrid();
    return;
  }

  activeTopics.add(topic);
  renderTopicTags();

  // Check if any books exist for this topic
  const hasBooks = allBooks.some(b => (b.category || '').toLowerCase() === topic.toLowerCase());
  if (hasBooks) {
    renderLibraryGrid();
    return;
  }

  // No books yet — discover them
  loadingTopics.add(topic);
  renderTopicTags();
  try {
    const data = await api('/api/discover', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic }),
    });
    _searchUsage = data.usage?.total_tokens > 0 ? data.usage : null;
    await loadAgents();
  } catch (err) {
    activeTopics.delete(topic);
    alert('Discovery failed: ' + err.message);
  } finally {
    loadingTopics.delete(topic);
    renderTopicTags();
    renderLibraryGrid();
  }
}

// ─── Build book list from agents (DB is the single source of truth) ───
function buildBookList() {
  allBooks = agents.map(a => {
    const meta = a.meta || {};
    return {
      id: a.id,                // agent ID is the book ID
      title: a.name,
      author: meta.author || a.source || '',
      isbn: meta.isbn || null,
      category: meta.category || a.type,
      description: meta.description || '',
      agentId: a.id,           // all books have agentId
      status: a.status,
      available: a.status === 'ready',
      skills: meta.skills || {},
      isUploaded: a.type === 'upload',
      isCatalog: a.type === 'catalog',
      upvotes: 0,
    };
  });

  // Merge vote counts
  votes.forEach(v => {
    const b = allBooks.find(x => x.title.toLowerCase() === v.title.toLowerCase());
    if (b) b.upvotes = v.count;
  });
}

// ─── Polling (only when indexing) ───
function startPolling() {
  if (pollTimer) return;
  pollTimer = setInterval(async () => {
    const hasIndexing = agents.some(a => a.status === 'indexing');
    if (!hasIndexing) { clearInterval(pollTimer); pollTimer = null; return; }
    await loadAgents();
    const r = getRoute();
    if (r.page === 'library') renderLibraryGrid();
  }, 5000);
}
function ensurePolling() {
  if (agents.some(a => a.status === 'indexing')) startPolling();
}

// ─── Home ───
function renderHome() {
  if (!localStorage.getItem('onboardingDone')) {
    document.getElementById('home-center-main').classList.add('hidden');
    showOnboarding();
    return;
  }
  document.getElementById('onboarding').classList.add('hidden');
  document.getElementById('home-center-main').classList.remove('hidden');
  document.getElementById('greeting').textContent = getGreeting();
  renderStarters();
}

// ─── Starter questions ───
function renderStarters() {
  const container = document.getElementById('home-starters');
  if (!container) return;

  const questions = generateStarters();
  if (!questions.length) { container.innerHTML = ''; return; }

  container.innerHTML = questions.map(q =>
    `<button class="starter-pill">${esc(q)}</button>`
  ).join('');
  container.querySelectorAll('.starter-pill').forEach(btn => {
    btn.addEventListener('click', () => {
      document.getElementById('home-input').value = btn.textContent;
      document.getElementById('home-input').focus();
    });
  });
}

function _short(title, max = 30) {
  return title.length <= max ? title : title.slice(0, max - 1).trimEnd() + '…';
}

function generateStarters() {
  const selected = [...selectedBooks.values()];

  if (selected.length === 1) {
    const t = _short(selected[0].title);
    return [
      `What are the key ideas in "${t}"?`,
      `Summarize the core argument of "${t}"`,
      `What makes "${t}" unique?`,
      `Quiz me on "${t}"`,
    ];
  }
  if (selected.length >= 2) {
    const a = _short(selected[0].title), b = _short(selected[1].title);
    const questions = [
      `Compare "${a}" and "${b}"`,
      `What do "${a}" and "${b}" have in common?`,
      `Key ideas in "${a}"?`,
    ];
    if (selected.length > 2) {
      questions.push(`What do these ${selected.length} books cover together?`);
    } else {
      questions.push(`Key ideas in "${b}"?`);
    }
    return questions;
  }

  const ready = allBooks.filter(b => b.available);
  const catalog = allBooks.filter(b => b.status === 'catalog');
  const books = ready.length ? ready : catalog;

  if (!books.length) {
    return [
      'Learn quantitative trading from scratch',
      'Teach me the fundamentals of philosophy',
      'Best books on cognitive psychology?',
      'Help me understand machine learning',
    ];
  }

  const questions = [];
  const shuffled = [...books].sort(() => Math.random() - 0.5);

  if (shuffled[0]) {
    questions.push(`Key ideas in "${_short(shuffled[0].title)}"?`);
  }
  if (shuffled[1]) {
    questions.push(`Core argument of "${_short(shuffled[1].title)}"?`);
  }
  if (shuffled.length >= 2) {
    questions.push(`Compare "${_short(shuffled[0].title, 24)}" and "${_short(shuffled[1].title, 24)}"`);
  }

  const categories = [...new Set(books.map(b => b.category).filter(Boolean))];
  if (categories.length) {
    const cat = categories[Math.floor(Math.random() * categories.length)];
    questions.push(`What should I learn first about ${cat}?`);
  }

  return questions.slice(0, 4);
}

// ─── Onboarding ───
function showOnboarding() {
  const container = document.getElementById('onboarding');
  const greetingEl = document.getElementById('onboarding-greeting');
  const subtitleEl = document.getElementById('onboarding-subtitle');
  const bodyEl = document.getElementById('onboarding-body');
  container.classList.remove('hidden');
  showStep1();

  function showStep1() {
    greetingEl.textContent = "Hi, I'm Feynman";
    subtitleEl.textContent = 'What should I call you?';
    bodyEl.innerHTML = `
      <input type="text" class="onboarding-input" id="onboarding-name-input" placeholder="Your name" autocomplete="off" />
      <br>
      <button class="onboarding-btn" id="onboarding-continue-btn">Continue</button>
    `;
    const nameInput = document.getElementById('onboarding-name-input');
    const continueBtn = document.getElementById('onboarding-continue-btn');
    nameInput.focus();
    nameInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); proceed(); }
    });
    continueBtn.addEventListener('click', proceed);

    function proceed() {
      const name = nameInput.value.trim();
      if (!name) return;
      userName = name;
      localStorage.setItem('userName', userName);
      showStep2();
    }
  }

  function showStep2() {
    greetingEl.textContent = 'Nice to meet you, ' + userName + '!';
    subtitleEl.textContent = 'Pick topics you\u2019re curious about';
    const selectedTopics = new Set();
    const tags = topicTags.length ? topicTags : ['Philosophy', 'Science', 'History', 'Psychology', 'Economics', 'Literature', 'Technology', 'Mathematics'];
    bodyEl.innerHTML = `
      <div class="onboarding-topics" id="onboarding-topics">
        ${tags.map(t => `<button class="topic-tag" data-topic="${esc(t)}">${esc(t)}</button>`).join('')}
      </div>
      <button class="onboarding-btn" id="onboarding-start-btn">Get Started</button>
    `;
    const topicsContainer = document.getElementById('onboarding-topics');
    topicsContainer.querySelectorAll('.topic-tag').forEach(btn => {
      btn.addEventListener('click', () => {
        const topic = btn.dataset.topic;
        if (selectedTopics.has(topic)) {
          selectedTopics.delete(topic);
          btn.classList.remove('selected');
        } else {
          selectedTopics.add(topic);
          btn.classList.add('selected');
        }
      });
    });
    document.getElementById('onboarding-start-btn').addEventListener('click', () => {
      localStorage.setItem('onboardingDone', '1');
      container.classList.add('hidden');
      document.getElementById('home-center-main').classList.remove('hidden');
      document.getElementById('greeting').textContent = getGreeting();
      if (selectedTopics.size) {
        window.location.hash = '#/library';
        for (const topic of selectedTopics) {
          handleTopicClick(topic);
        }
      }
    });
  }
}

// ─── Chat messages ───
function appendMsg(container, role, text, sources, opts) {
  const el = document.createElement('div');
  el.className = 'chat-message ' + role;
  el.dataset.raw = text;
  if (sources?.length) el.dataset.sources = JSON.stringify(sources);
  if (opts && Object.keys(opts).length) el.dataset.opts = JSON.stringify(opts);
  const webSrcs = opts?.webSources || [];
  const refs = opts?.references || [];
  if (role === 'assistant') {
    const content = document.createElement('div');
    content.className = 'msg-content';
    let html = renderMarkdown(text);
    // Convert [1], [2], [1, 2] etc. to clickable citation superscripts
    if (refs.length || webSrcs.length) {
      html = html.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (match, nums) => {
        const indices = nums.split(/\s*,\s*/).map(n => parseInt(n, 10));
        const links = indices.map(num => {
          const idx = num - 1;
          if (refs.length && idx >= 0 && idx < refs.length) {
            return `<a class="cite-link" data-ref="${num}" href="javascript:void(0)" title="${esc(refs[idx].book + ': ' + refs[idx].snippet.slice(0, 60))}"><sup>${num}</sup></a>`;
          } else if (webSrcs.length && idx >= 0 && idx < webSrcs.length) {
            return `<a class="cite-link" href="${esc(webSrcs[idx].url)}" target="_blank" rel="noopener" title="${esc(webSrcs[idx].title || '')}"><sup>${num}</sup></a>`;
          }
          return `<sup>${num}</sup>`;
        });
        return `<span class="cite-group">[${links.join(', ')}]</span>`;
      });
    }
    content.innerHTML = html;
    el.appendChild(content);
    // Bind cite-link clicks to scroll to reference
    content.querySelectorAll('.cite-link[data-ref]').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        const refEl = el.querySelector('#ref-' + a.dataset.ref);
        if (refEl) refEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
  } else {
    el.textContent = text;
  }
  // References (RAG chunk sources)
  if (refs.length) {
    const refsEl = document.createElement('div');
    refsEl.className = 'msg-references';
    refsEl.innerHTML = '<div class="refs-header">References</div>' +
      refs.map(r =>
        `<div class="ref-item" id="ref-${r.index}"><span class="ref-num">${r.index}</span><div class="ref-body"><span class="ref-book">${esc(r.book)}</span><span class="ref-snippet">${esc(r.snippet)}</span></div></div>`
      ).join('');
    el.appendChild(refsEl);
  }
  // Web sources (grounding citations)
  if (webSrcs.length) {
    const ws = document.createElement('div');
    ws.className = 'web-sources';
    webSrcs.forEach((src, i) => {
      const a = document.createElement('a');
      a.className = 'web-source-link';
      a.href = src.url;
      a.target = '_blank';
      a.rel = 'noopener noreferrer';
      a.innerHTML = `<span class="web-source-num">${i + 1}</span> ${esc(src.title || src.url)}`;
      ws.appendChild(a);
    });
    el.appendChild(ws);
  }
  // Skill badge
  if (opts?.skillUsed && opts.skillUsed !== 'none') {
    const sb = document.createElement('span');
    sb.className = 'skill-badge skill-' + opts.skillUsed;
    const labels = { rag: 'RAG', content_fetch: 'Web APIs', web_search: 'Web Search', llm_knowledge: 'LLM Knowledge' };
    sb.textContent = labels[opts.skillUsed] || opts.skillUsed;
    el.appendChild(sb);
  }
  // Token usage
  if (opts?.usage && opts.usage.total_tokens > 0) {
    const u = opts.usage;
    const tu = document.createElement('div');
    tu.className = 'token-usage';
    tu.textContent = `${u.total_tokens} tokens`;
    tu.title = `Input: ${u.input_tokens} · Output: ${u.output_tokens}`;
    el.appendChild(tu);
  }
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function showLoading(c) {
  const el = document.createElement('div');
  el.className = 'chat-message assistant';
  el.id = 'loading-msg';
  el.innerHTML = '<span class="loading-dot">Thinking...</span>';
  c.appendChild(el);
  c.scrollTop = c.scrollHeight;
}
function removeLoading() { document.getElementById('loading-msg')?.remove(); }

// ─── Chat sessions ───
function persistSessions() {
  saveCurrentSession();
  try {
    const data = chatSessions.map(s => ({
      id: s.id, title: s.title, messages: s.messages,
      books: s.books instanceof Map ? [...s.books.entries()] : [],
      updatedAt: s.updatedAt || 0,
    }));
    localStorage.setItem('chatSessions', JSON.stringify(data));
    localStorage.setItem('sessionCounter', String(sessionCounter));
    localStorage.setItem('currentSessionId', currentSessionId || '');
  } catch {}
}

function restoreSessions() {
  try {
    const raw = localStorage.getItem('chatSessions');
    if (!raw) return;
    const data = JSON.parse(raw);
    // One-time migration: reset polluted updatedAt values
    const migrated = localStorage.getItem('ts_migrated');
    chatSessions = data.map(s => ({
      ...s,
      books: new Map(s.books || []),
      updatedAt: migrated ? (s.updatedAt || 0) : 0,
    }));
    if (!migrated) localStorage.setItem('ts_migrated', '1');
    sessionCounter = parseInt(localStorage.getItem('sessionCounter') || '0', 10);
    currentSessionId = localStorage.getItem('currentSessionId') || null;
  } catch {}
}

function createSession() {
  saveCurrentSession();
  const id = 's-' + (++sessionCounter);
  const session = { id, title: 'New chat', messages: [], books: new Map(), updatedAt: Date.now() };
  chatSessions.unshift(session);
  currentSessionId = id;
  document.getElementById('chat-messages').innerHTML = '';
  hideChatRightSidebar();
  renderChatHistory();
  persistSessions();
  return session;
}

function saveCurrentSession() {
  if (!currentSessionId) return;
  const session = chatSessions.find(s => s.id === currentSessionId);
  if (!session) return;
  const msgs = [];
  document.querySelectorAll('#chat-messages .chat-message:not(#loading-msg)').forEach(el => {
    const role = el.classList.contains('user') ? 'user' : 'assistant';
    const msg = { role, content: el.dataset.raw || el.textContent };
    if (el.dataset.sources) try { msg.sources = JSON.parse(el.dataset.sources); } catch {}
    if (el.dataset.opts) try { msg.opts = JSON.parse(el.dataset.opts); } catch {}
    msgs.push(msg);
  });
  session.messages = msgs;
  session.books = new Map(selectedBooks);
  session.minds = new Map(selectedMinds);
  if (msgs.length) session.updatedAt = Date.now();
}

function switchToSession(id) {
  if (id === currentSessionId) return;
  saveCurrentSession();
  const session = chatSessions.find(s => s.id === id);
  if (!session) return;
  currentSessionId = id;
  selectedBooks = new Map(session.books);
  selectedMinds = new Map(session.minds || []);
  const chatBox = document.getElementById('chat-messages');
  chatBox.innerHTML = '';
  session.messages.forEach(m => appendMsg(chatBox, m.role, m.content, m.sources, m.opts));
  persistSessions();
  renderSelectedChips();
  restoreChatSidebar(session.messages);
  renderChatHistory();
  if (getRoute().page !== 'chat') {
    window.location.hash = '#/chat';
  }
}

function deleteSession(id) {
  chatSessions = chatSessions.filter(s => s.id !== id);
  if (currentSessionId === id) {
    currentSessionId = null;
    document.getElementById('chat-messages').innerHTML = '';
    hideChatRightSidebar();
  }
  persistSessions();
  renderChatHistory();
  if (getRoute().page === 'chats') _renderChatsList(document.getElementById('chats-search')?.value?.trim().toLowerCase() || '');
}

function updateSessionTitle(message) {
  const session = chatSessions.find(s => s.id === currentSessionId);
  if (session && session.title === 'New chat') {
    session.title = message.length > 40 ? message.slice(0, 40) + '...' : message;
    renderChatHistory();
  }
}

function renderChatHistory() {
  const list = document.getElementById('chat-history-list');
  if (!list) return;
  list.innerHTML = chatSessions.map(s =>
    `<div class="history-item-wrap ${s.id === currentSessionId ? 'active' : ''}" data-sid="${s.id}">
      <button class="history-item">${esc(s.title)}</button>
      <button class="history-delete" title="Delete">&times;</button>
    </div>`
  ).join('');
  list.querySelectorAll('.history-item-wrap').forEach(wrap => {
    wrap.querySelector('.history-item').addEventListener('click', () => switchToSession(wrap.dataset.sid));
    wrap.querySelector('.history-delete').addEventListener('click', e => { e.stopPropagation(); deleteSession(wrap.dataset.sid); });
  });
}

// ─── Chats page ───
function renderChatsPage() {
  const listEl = document.getElementById('chats-list');
  const emptyEl = document.getElementById('chats-empty');
  const searchEl = document.getElementById('chats-search');
  searchEl.value = '';
  _renderChatsList('');
}

function _renderChatsList(query) {
  const listEl = document.getElementById('chats-list');
  const emptyEl = document.getElementById('chats-empty');
  let sessions = chatSessions;
  if (query) {
    sessions = sessions.filter(s => s.title.toLowerCase().includes(query));
  }
  if (!sessions.length) {
    listEl.innerHTML = '';
    emptyEl.classList.remove('hidden');
    return;
  }
  emptyEl.classList.add('hidden');
  listEl.innerHTML = sessions.map(s =>
    `<div class="chats-list-item" data-sid="${s.id}">
      <svg class="chat-item-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
      <div class="chats-item-body">
        <div class="chat-item-title">${esc(s.title)}</div>
        ${s.updatedAt ? `<div class="chats-item-time">Last message ${timeAgo(s.updatedAt)}</div>` : ''}
      </div>
      <button class="chats-delete-btn" title="Delete">&times;</button>
    </div>`
  ).join('');
  listEl.querySelectorAll('.chats-list-item').forEach(el => {
    el.querySelector('.chats-item-body').addEventListener('click', () => switchToSession(el.dataset.sid));
    el.querySelector('.chat-item-icon').addEventListener('click', () => switchToSession(el.dataset.sid));
    el.querySelector('.chats-delete-btn').addEventListener('click', e => { e.stopPropagation(); deleteSession(el.dataset.sid); });
  });
}

// ─── Right sidebar visibility ───
function showChatRightSidebar() {
  const el = document.getElementById('chat-right-sidebar');
  if (el) el.classList.add('visible');
}
function hideChatRightSidebar() {
  const el = document.getElementById('chat-right-sidebar');
  if (el) el.classList.remove('visible');
}

// ─── Global chat ───
let pendingHomeMessage = null;

async function sendGlobalChat(message) {
  const chatBox = document.getElementById('chat-messages');

  if (getRoute().page !== 'chat') {
    pendingHomeMessage = message;
    window.location.hash = '#/chat';
    return;
  }

  if (!currentSessionId) createSession();
  updateSessionTitle(message);
  const sentSessionId = currentSessionId;

  appendMsg(chatBox, 'user', message);
  showLoading(chatBox);

  try {
    const body = { message };
    const agentIds = [];
    const bookContext = [];
    for (const [, book] of selectedBooks) {
      agentIds.push(book.agentId);
      bookContext.push({ title: book.title, author: book.author || '' });
    }
    if (bookContext.length) {
      body.agent_ids = agentIds;
      body.book_context = bookContext;
    }

    // Collect conversation history (exclude the message we just appended and loading)
    const history = [];
    chatBox.querySelectorAll('.chat-message:not(#loading-msg)').forEach(el => {
      const role = el.classList.contains('user') ? 'user' : 'assistant';
      const content = el.dataset.raw || el.textContent;
      history.push({ role, content });
    });
    // Remove the last entry (the message we just appended as user)
    if (history.length && history[history.length - 1].role === 'user') {
      history.pop();
    }
    if (history.length) body.history = history;

    const data = await api('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const sources = (data.sources || []).map(s => ({ id: s.agent_id, name: s.agent_name }));
    const msgOpts = {};
    if (data.web_sources?.length) msgOpts.webSources = data.web_sources;
    if (data.grounded) msgOpts.grounded = true;
    if (data.references?.length) msgOpts.references = data.references;
    if (data.usage) msgOpts.usage = data.usage;

    // If user switched sessions while waiting, save to the original session without touching DOM
    if (currentSessionId !== sentSessionId) {
      const session = chatSessions.find(s => s.id === sentSessionId);
      if (session) {
        session.messages.push({ role: 'assistant', content: data.answer, sources, opts: msgOpts });
        persistSessions();
      }
      return;
    }

    removeLoading();
    appendMsg(chatBox, 'assistant', data.answer, sources, msgOpts);
    renderChatSidebar(sources, message);
    showChatRightSidebar();
    persistSessions();
    // Refresh agents if new books were discovered via chat
    if (sources.length) loadAgents();
    // Trigger polling if any catalog books are being learned
    ensurePolling();

    // Fetch mind perspectives in background
    _fetchPerspectives(chatBox, message, bookContext, agentIds);
  } catch (err) {
    if (currentSessionId !== sentSessionId) return;
    removeLoading();
    const msg = err.message.includes('No available provider')
      ? 'No LLM API key configured. Please add GEMINI_API_KEY, OPENAI_API_KEY, or KIMI_API_KEY to your .env file and restart the server.'
      : 'Error: ' + err.message;
    appendMsg(chatBox, 'assistant', msg);
    persistSessions();
  }
}

async function _fetchPerspectives(chatBox, message, bookContext, agentIds) {
  try {
    const mindIds = [...selectedMinds.keys()];

    const existingNames = [...selectedMinds.values()].map(m => m.name);
    const suggestBody = { count: 3, exclude: existingNames };
    if (bookContext && bookContext.length) {
      suggestBody.book_title = bookContext[0].title;
      suggestBody.book_author = bookContext[0].author || '';
    } else {
      suggestBody.topic = message.slice(0, 100);
    }

    try {
      const suggestions = await api('/api/minds/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(suggestBody),
      });
      for (const s of (suggestions.minds || [])) {
        try {
          const mind = await api('/api/minds/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: s.name, era: s.era || '', domain: s.domain || '' }),
          });
          if (!mindIds.includes(mind.id)) mindIds.push(mind.id);
        } catch { /* skip */ }
      }
    } catch { /* suggestion failed, proceed with manually selected */ }

    if (!mindIds.length) return;

    const panelBody = { message, mind_ids: mindIds };
    if (bookContext?.length) panelBody.book_context = bookContext;
    if (agentIds?.length) panelBody.agent_ids = agentIds;

    const panelData = await api('/api/minds/panel-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(panelBody),
    });

    if (panelData.responses?.length) {
      // Find the last assistant message in chatBox and append perspectives after it
      const lastAssistant = chatBox.querySelector('.chat-message.assistant:last-of-type');
      if (lastAssistant) {
        renderPerspectives(lastAssistant, panelData.responses);
      }
      // Refresh minds list in case new ones were generated
      loadMinds();
    }
  } catch (err) {
    // Perspectives are optional — fail silently
    console.log('Perspectives fetch failed:', err.message);
  }
}

function handleHomeSend() {
  const input = document.getElementById('home-input');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  input.style.height = 'auto';
  saveCurrentSession();
  currentSessionId = null;
  sendGlobalChat(msg);
}

function handleChatSend() {
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  input.style.height = 'auto';
  sendGlobalChat(msg);
}

function onChatPageShow() {
  renderSelectedChips();
  renderChatHistory();
  // Restore messages if chat box is empty and we have a current session
  const chatBox = document.getElementById('chat-messages');
  if (currentSessionId && !chatBox.children.length) {
    const session = chatSessions.find(s => s.id === currentSessionId);
    if (session?.messages?.length) {
      session.messages.forEach(m => appendMsg(chatBox, m.role, m.content, m.sources, m.opts));
      restoreChatSidebar(session.messages);
    }
  }
  if (pendingHomeMessage) {
    const msg = pendingHomeMessage;
    pendingHomeMessage = null;
    setTimeout(() => sendGlobalChat(msg), 50);
  }
}

// ─── Chat sidebar (right) ───
// Snapshot of books used in the conversation (independent of selectedBooks chips)
let _sidebarBooks = new Map();

function renderChatSidebar(sources, query) {
  // Snapshot current selectedBooks so sidebar is independent of future chip changes
  _sidebarBooks = new Map(selectedBooks);

  const srcEl = document.getElementById('sidebar-sources');
  if (!sources.length) {
    if (_sidebarBooks.size) {
      srcEl.innerHTML = [..._sidebarBooks.values()].map(b =>
        sidebarBookItem(b.agentId || b.id, b.title, b.author, b.isbn)
      ).join('');
    } else {
      srcEl.innerHTML = '<p style="font-size:12px;color:var(--text-muted)">No specific sources used</p>';
    }
  } else {
    srcEl.innerHTML = sources.map(s => {
      const book = allBooks.find(b => b.id === s.id);
      return sidebarBookItem(s.id, s.name, book?.author || '', book?.isbn);
    }).join('');
  }

  const relEl = document.getElementById('sidebar-related');
  // Collect IDs to exclude (sources + sidebar books)
  const excludeIds = new Set(sources.map(s => s.id));
  for (const [, b] of _sidebarBooks) excludeIds.add(b.agentId || b.id);
  // Collect categories from sources + sidebar books
  const relCategories = new Set();
  sources.forEach(s => {
    const book = allBooks.find(b => b.id === s.id);
    if (book?.category) relCategories.add(book.category.toLowerCase());
  });
  for (const [, b] of _sidebarBooks) {
    const book = allBooks.find(x => (x.agentId || x.id) === (b.agentId || b.id));
    if (book?.category) relCategories.add(book.category.toLowerCase());
  }
  // Related = same category, excluding already shown books
  const related = relCategories.size
    ? allBooks
        .filter(b => !excludeIds.has(b.id) && relCategories.has((b.category || '').toLowerCase()))
        .slice(0, 4)
    : [];
  relEl.innerHTML = related.length ? related.map(b => sidebarBookItem(b.agentId || b.id, b.title, b.author, b.isbn)).join('') : '';
}

function restoreChatSidebar(messages) {
  // Find the last assistant message that has sources
  let lastSources = null;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant' && messages[i].sources?.length) {
      lastSources = messages[i].sources;
      break;
    }
  }
  if (lastSources) {
    renderChatSidebar(lastSources, '');
    showChatRightSidebar();
  } else {
    hideChatRightSidebar();
  }
}

function sidebarBookItem(id, title, author) {
  return `<div class="sidebar-book-item" onclick="selectBookFromSidebar('${esc(id)}')">
    <div class="sidebar-book-info">
      <div class="sidebar-book-title">${esc(title)}</div>
      ${author ? `<div class="sidebar-book-author">${esc(author)}</div>` : ''}
    </div>
  </div>`;
}

function selectBookFromSidebar(bookKey) {
  const book = allBooks.find(b => (b.agentId || b.id) === bookKey);
  if (book && !selectedBooks.has(book.id)) {
    selectedBooks.set(book.id, book);
    renderSelectedChips();
  }
}
window.selectBookFromSidebar = selectBookFromSidebar;

// ─── Library ───
function renderLibrary() { renderTopicTags(); renderLibraryGrid(); }

function renderLibraryGrid() {
  const c = document.getElementById('library-grid');
  let filtered = [...allBooks];
  if (libraryFilter === 'available') filtered = filtered.filter(b => b.available);
  else if (libraryFilter === 'popular') filtered.sort((a,b) => (b.upvotes||0) - (a.upvotes||0));
  if (activeTopics.size) {
    const topics = new Set([...activeTopics].map(t => t.toLowerCase()));
    filtered = filtered.filter(b => topics.has((b.category || '').toLowerCase()));
  }
  if (librarySearch) {
    const q = librarySearch.toLowerCase();
    filtered = filtered.filter(b =>
      b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q) ||
      (b.category||'').toLowerCase().includes(q) || _searchDiscoveredIds.has(b.id)
    );
  }
  renderBookGrid(c, filtered);
  // If searching and no results, show searching indicator (only while actively searching)
  if (librarySearch && librarySearch.length >= 2 && !filtered.length) {
    if (_searchingQuery) {
      c.innerHTML = `<div class="search-discover-prompt" id="search-discover-prompt">
        <span class="loading-dot">Searching for "${esc(librarySearch)}"...</span>
      </div>`;
    } else {
      c.innerHTML = `<div class="search-discover-prompt"><p style="color:var(--text-muted)">No results for "${esc(librarySearch)}"</p></div>`;
    }
  }
  // Show token usage for search/discover inline
  if (_searchUsage && _searchUsage.total_tokens > 0) {
    c.insertAdjacentHTML('beforeend',
      `<div class="token-usage" style="grid-column:1/-1;text-align:center;margin-top:8px" title="Input: ${_searchUsage.input_tokens} · Output: ${_searchUsage.output_tokens}">${_searchUsage.total_tokens} tokens</div>`);
  }
  // Show "Discover more" card when topic filters are active
  if (activeTopics.size && !librarySearch) {
    const topics = [...activeTopics];
    const label = topics.length === 1 ? topics[0] : 'these topics';
    c.insertAdjacentHTML('beforeend',
      `<div class="book-card discover-more-card" id="discover-more-card">
        <div class="card-cover-gen" style="background:var(--bg-sidebar)">
          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="var(--text-muted)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
        </div>
        <div class="card-body"><h3 class="card-title" style="color:var(--text-muted)">Discover more</h3><p class="card-author">${esc(label)}</p></div>
      </div>`);
    document.getElementById('discover-more-card').addEventListener('click', () => discoverMore(topics));
  }
}

async function discoverMore(topics) {
  const card = document.getElementById('discover-more-card');
  if (card) card.innerHTML = '<div class="card-cover-gen" style="background:var(--bg-sidebar)"><span class="loading-dot">...</span></div><div class="card-body"><h3 class="card-title" style="color:var(--text-muted)">Discovering...</h3></div>';
  for (const topic of topics) {
    loadingTopics.add(topic);
  }
  renderTopicTags();
  try {
    let totalTokens = 0;
    for (const topic of topics) {
      const data = await api('/api/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic }),
      });
      if (data.usage?.total_tokens) totalTokens += data.usage.total_tokens;
    }
    await loadAgents();
    if (totalTokens > 0) _searchUsage = { total_tokens: totalTokens, input_tokens: 0, output_tokens: 0 };
  } catch (err) {
    alert('Discovery failed: ' + err.message);
  }
  for (const topic of topics) loadingTopics.delete(topic);
  renderTopicTags();
  renderLibraryGrid();
}

let _searchingQuery = null;
let _searchDiscoveredIds = new Set();
let _searchUsage = null;
async function autoSearchBook(query) {
  if (_searchingQuery === query) return;
  _searchingQuery = query;
  try {
    const data = await api('/api/search-book', {
      method: 'POST', headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ query }),
    });
    if (_searchingQuery !== query) return; // user typed something else
    // Track discovered book IDs so they show even if title doesn't match search text
    (data.books || []).forEach(b => { if (b.id) _searchDiscoveredIds.add(b.id); });
    _searchUsage = data.usage?.total_tokens > 0 ? data.usage : null;
    await loadAgents();
    buildBookList();
    renderLibraryGrid();
  } catch (err) {
    if (_searchingQuery !== query) return;
    const c = document.getElementById('search-discover-prompt');
    if (c) c.innerHTML = `<p style="color:var(--text-muted)">Could not find "${esc(query)}"</p>`;
  } finally {
    if (_searchingQuery === query) _searchingQuery = null;
  }
}

const COVER_COLORS = ['#264653','#2a9d8f','#e76f51','#457b9d','#6d597a','#355070','#b56576','#0077b6','#588157','#9b2226'];
function coverColor(title) { let h = 0; for (let i = 0; i < title.length; i++) h = ((h << 5) - h + title.charCodeAt(i)) | 0; return COVER_COLORS[Math.abs(h) % COVER_COLORS.length]; }
function coverInitials(title) { return title.split(/[\s:—]+/).filter(w => w.length > 2).slice(0, 2).map(w => w[0].toUpperCase()).join(''); }

function renderBookGrid(container, books) {
  if (!books.length) { container.innerHTML = '<div class="empty-state"><p>No books found.</p></div>'; return; }
  container.innerHTML = books.map(b => {
    const cover = `<div class="card-cover-gen" style="background:${coverColor(b.title)}"><span>${coverInitials(b.title)}</span></div>`;
    let statusBadge = '';
    if (b.status === 'indexing') statusBadge = '<span class="card-badge indexing">Indexing...</span>';
    else if (b.status === 'catalog') statusBadge = '<span class="card-badge catalog">Catalog</span>';
    else if (b.status === 'ready') statusBadge = '<span class="card-badge ready">Ready</span>';
    const deleteBtn = (b.isUploaded || b.isCatalog) && b.agentId ? `<button class="card-delete-btn" onclick="event.stopPropagation();deleteBook('${esc(b.agentId)}')" title="Delete">&times;</button>` : '';
    return `<div class="book-card" onclick="selectBookForChat('${esc(b.id)}')">
      ${deleteBtn}
      ${cover}
      <div class="card-body"><h3 class="card-title">${esc(b.title)}</h3><p class="card-author">${esc(b.author)}</p></div>
      <div class="card-footer">
        ${statusBadge}
        <button class="card-chat-btn" onclick="event.stopPropagation();selectBookForChat('${esc(b.id)}')">Chat &rarr;</button>
        <button class="upvote-btn" onclick="event.stopPropagation();handleUpvote('${esc(b.title)}')">&#9650; ${b.upvotes||''}</button>
      </div>
    </div>`;
  }).join('');
}

// ─── Delete book ───
async function deleteBook(agentId) {
  if (!confirm('Delete this book? This cannot be undone.')) return;
  try {
    await api('/api/agents/' + agentId, { method: 'DELETE' });
    // Remove from selectedBooks if present
    for (const [key, book] of selectedBooks) {
      if (book.agentId === agentId) { selectedBooks.delete(key); break; }
    }
    await loadAgents();
    renderSelectedChips();
    if (getRoute().page === 'library') renderLibraryGrid();
  } catch (err) {
    alert('Error deleting: ' + err.message);
  }
}
window.deleteBook = deleteBook;

// ─── Book detail ───
async function renderBookDetail(bookId) {
  const headerEl = document.getElementById('book-header');
  const questionsEl = document.getElementById('book-questions');
  const chatBox = document.getElementById('book-chat-messages');
  const metaSidebar = document.getElementById('book-meta-sidebar');
  chatBox.innerHTML = '';

  let book = allBooks.find(b => b.agentId === bookId);
  let agent = agents.find(a => a.id === bookId);
  if (!agent) { try { agent = await api('/api/agents/' + bookId); } catch {} }

  const title = book?.title || agent?.name || 'Unknown';
  const author = book?.author || agent?.source || '';
  const isbn = book?.isbn;
  const desc = book?.description || '';
  const meta = agent?.meta || {};
  const coverUrl = isbn ? `https://covers.openlibrary.org/b/isbn/${isbn}-M.jpg` : '';

  headerEl.innerHTML = `
    ${coverUrl ? `<img class="book-inline-cover" src="${coverUrl}" alt="" onerror="this.style.display='none'" />` : ''}
    <div class="book-inline-info"><h2>${esc(title)}</h2><p>${esc(author)}</p></div>`;

  metaSidebar.innerHTML = `
    <h3 class="sidebar-title">BOOK INFO</h3>
    ${coverUrl ? `<img style="width:100%;border-radius:8px;margin-bottom:12px" src="${coverUrl}" alt="" onerror="this.style.display='none'" />` : ''}
    <p style="font-size:14px;font-weight:600;margin-bottom:4px">${esc(title)}</p>
    <p style="font-size:12px;color:var(--text-muted);margin-bottom:8px">${esc(author)}</p>
    ${desc ? `<p style="font-size:12px;color:var(--text-secondary);line-height:1.5;margin-bottom:12px">${esc(desc)}</p>` : ''}
    <p style="font-size:11px;color:var(--text-muted)">${meta.chunk_count || '—'} chunks</p>
    <p style="font-size:11px;color:var(--text-muted);margin-top:4px">Status: ${agent?.status || '—'}</p>`;

  let questions = [];
  if (agent) {
    try { const q = await api('/api/agents/' + bookId + '/questions'); questions = q.questions || []; } catch {}
  }
  if (!questions.length) questions = meta.questions || MOCK_QUESTIONS;

  questionsEl.innerHTML = `<h4>TRY ASKING</h4>` +
    questions.map(q => `<button class="sidebar-question" data-q="${esc(q)}">${esc(q)}</button>`).join('');
  questionsEl.querySelectorAll('.sidebar-question').forEach(btn => {
    btn.addEventListener('click', () => sendBookChat(bookId, btn.dataset.q));
  });

  if (agent) {
    try { const msgs = await api('/api/agents/' + bookId + '/messages'); msgs.forEach(m => appendMsg(chatBox, m.role, m.content)); } catch {}
  }
}

async function sendBookChat(bookId, message) {
  const chatBox = document.getElementById('book-chat-messages');
  const input = document.getElementById('book-chat-input');
  appendMsg(chatBox, 'user', message);
  if (input) input.value = '';
  showLoading(chatBox);
  try {
    const data = await api('/api/agents/' + bookId + '/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    removeLoading();
    const msgOpts = {};
    if (data.skill_used) msgOpts.skillUsed = data.skill_used;
    if (data.web_sources?.length) msgOpts.webSources = data.web_sources;
    if (data.grounded) msgOpts.grounded = true;
    if (data.references?.length) msgOpts.references = data.references;
    if (data.usage) msgOpts.usage = data.usage;
    appendMsg(chatBox, 'assistant', data.answer, null, msgOpts);
    // Start polling if the agent started learning
    ensurePolling();
  } catch (err) {
    removeLoading();
    appendMsg(chatBox, 'assistant', 'Error: ' + err.message);
  }
}

// ─── Upload (multi-file) — auto-selects uploaded books as chips ───
async function handleFileUpload(files, statusElId) {
  const statusEl = statusElId ? document.getElementById(statusElId) : null;
  const fileList = Array.from(files);
  let uploaded = 0;
  const uploadedAgentIds = [];

  for (const file of fileList) {
    if (statusEl) statusEl.textContent = `Uploading "${file.name}"${fileList.length > 1 ? ` (${uploaded+1}/${fileList.length})` : ''}...`;
    const fd = new FormData();
    fd.append('file', file);
    try {
      const result = await api('/api/agents/upload', { method: 'POST', body: fd });
      uploadedAgentIds.push(result.id);
      uploaded++;
    } catch (err) {
      if (statusEl) statusEl.textContent = `Error uploading "${file.name}": ${err.message}`;
      return;
    }
  }

  if (statusEl) statusEl.textContent = uploaded > 1 ? `${uploaded} books uploaded — indexing...` : `"${fileList[0].name}" uploaded — indexing...`;

  await loadAgents();
  ensurePolling();

  // Auto-select uploaded books as chips
  for (const agentId of uploadedAgentIds) {
    const book = allBooks.find(b => b.agentId === agentId);
    if (book) selectedBooks.set(book.id, book);
  }
  renderSelectedChips();

  setTimeout(() => { if (statusEl) statusEl.textContent = ''; }, 5000);
}

// ─── Upvote ───
async function handleUpvote(title) {
  try {
    await api('/api/votes', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({title}) });
    await loadVotes(); buildBookList();
  } catch {
    const b = allBooks.find(x => x.title === title);
    if (b) b.upvotes = (b.upvotes||0) + 1;
  }
  if (getRoute().page === 'library') renderLibraryGrid();
}
window.handleUpvote = handleUpvote;

// ─── Popover & book selection ───
function togglePopover(popId, listId, emptyId) {
  popId = popId || 'chat-popover';
  listId = listId || 'popover-book-list';
  emptyId = emptyId || 'popover-no-books';
  const pop = document.getElementById(popId);
  const show = pop.classList.contains('hidden');
  document.querySelectorAll('.composer-popover').forEach(p => p.classList.add('hidden'));
  if (show) {
    pop.classList.remove('hidden');
    renderPopoverBookList(listId, emptyId);
  }
}

function toggleMindPopover(popId, listId, emptyId) {
  popId = popId || 'chat-minds-popover';
  listId = listId || 'popover-mind-list';
  emptyId = emptyId || 'popover-no-minds';
  const pop = document.getElementById(popId);
  const show = pop.classList.contains('hidden');
  document.querySelectorAll('.composer-popover').forEach(p => p.classList.add('hidden'));
  if (show) {
    pop.classList.remove('hidden');
    renderPopoverMindList(listId, emptyId);
  }
}

function closeAllPopovers() {
  document.querySelectorAll('.composer-popover').forEach(p => p.classList.add('hidden'));
}
// Expose globally so onclick attributes work
window.togglePopover = togglePopover;
window.toggleMindPopover = toggleMindPopover;
window.closeAllPopovers = closeAllPopovers;

function renderPopoverBookList(listId, emptyId) {
  listId = listId || 'popover-book-list';
  emptyId = emptyId || 'popover-no-books';
  const list = document.getElementById(listId);
  const empty = document.getElementById(emptyId);
  if (!allBooks.length) { list.innerHTML = ''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  list.innerHTML = allBooks.map(b => {
    const sel = selectedBooks.has(b.id);
    const tag = b.available ? ' (indexed)' : b.status === 'catalog' ? ' (catalog)' : '';
    return `<div class="popover-book-item ${sel?'selected':''}" data-bid="${b.id}">
      <div class="popover-book-check">${sel?'&#10003;':''}</div>
      <span>${esc(b.title)}${tag}</span>
    </div>`;
  }).join('');
  list.querySelectorAll('.popover-book-item').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.bid;
      if (selectedBooks.has(id)) {
        selectedBooks.delete(id);
      } else {
        const book = allBooks.find(x => x.id === id);
        if (book) selectedBooks.set(id, book);
      }
      renderPopoverBookList(listId, emptyId);
      renderSelectedChips();
    });
  });
}

function _refreshOpenPopovers() {
  document.querySelectorAll('.composer-popover').forEach(pop => {
    if (pop.classList.contains('hidden')) return;
    const bl = pop.querySelector('.popover-book-list');
    if (bl) {
      const be = bl.nextElementSibling;
      if (be && be.classList.contains('popover-empty')) renderPopoverBookList(bl.id, be.id);
    }
    const ml = pop.querySelector('.popover-mind-list');
    if (ml) {
      const me = ml.nextElementSibling;
      if (me && me.classList.contains('popover-empty')) renderPopoverMindList(ml.id, me.id);
    }
  });
}

function renderPopoverMindList(listId, emptyId) {
  listId = listId || 'popover-mind-list';
  emptyId = emptyId || 'popover-no-minds';
  const list = document.getElementById(listId);
  const empty = document.getElementById(emptyId);
  if (!list || !empty) return;
  if (!allMinds.length) { list.innerHTML = ''; empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  const sorted = [...allMinds].sort((a, b) => a.name.localeCompare(b.name));
  list.innerHTML = sorted.map(m => {
    const sel = selectedMinds.has(m.id);
    const color = mindColor(m.name);
    const initials = mindInitials(m.name);
    return `<div class="popover-mind-item ${sel ? 'selected' : ''}" data-mid="${m.id}">
      <div class="popover-mind-check">${sel ? '&#10003;' : ''}</div>
      <div class="popover-mind-avatar" style="background:${color}">${initials}</div>
      <span>${esc(m.name)}</span>
    </div>`;
  }).join('');
  list.querySelectorAll('.popover-mind-item').forEach(el => {
    el.addEventListener('click', () => {
      const id = el.dataset.mid;
      if (selectedMinds.has(id)) {
        selectedMinds.delete(id);
      } else {
        const mind = allMinds.find(x => x.id === id);
        if (mind) selectedMinds.set(id, mind);
      }
      renderPopoverMindList(listId, emptyId);
      renderSelectedChips();
    });
  });
}

// Renders chips in BOTH home and chat composers + updates placeholder
function renderSelectedChips() {
  ['home-selected-chips', 'chat-selected-chips'].forEach(cId => {
    const c = document.getElementById(cId);
    if (!c) return;
    if (!selectedBooks.size && !selectedMinds.size) { c.innerHTML = ''; return; }
    const bookChips = [...selectedBooks.entries()].map(([id, b]) =>
      `<div class="book-chip"><span>${esc(b.title)}</span><button class="chip-remove" data-bid="${id}">&times;</button></div>`
    ).join('');
    const mindChips = [...selectedMinds.entries()].map(([id, m]) =>
      `<div class="mind-chip"><span class="mind-chip-avatar" style="background:${mindColor(m.name)}">${mindInitials(m.name)}</span><span>${esc(m.name)}</span><button class="chip-remove" data-mid="${id}">&times;</button></div>`
    ).join('');
    c.innerHTML = bookChips + mindChips;
    c.querySelectorAll('.chip-remove[data-bid]').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedBooks.delete(btn.dataset.bid);
        renderSelectedChips();
        _refreshOpenPopovers();
      });
    });
    c.querySelectorAll('.chip-remove[data-mid]').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedMinds.delete(btn.dataset.mid);
        renderSelectedChips();
        _refreshOpenPopovers();
      });
    });
  });
  const homeInput = document.getElementById('home-input');
  if (homeInput) {
    homeInput.placeholder = (selectedBooks.size || selectedMinds.size) ? 'Ask your question...' : 'Ask about books or topics — great minds will join in...';
  }
  // Re-render starters to match selected books
  if (getRoute().page === 'home') renderStarters();
}

// Select a book and navigate to chat
function selectBookForChat(bookId) {
  const book = allBooks.find(b => b.id === bookId);
  if (!book) return;
  saveCurrentSession();
  currentSessionId = null;
  selectedBooks.clear();
  selectedMinds.clear();
  selectedBooks.set(bookId, book);
  window.location.hash = '#/';
}
window.selectBookForChat = selectBookForChat;

// ─── Textarea auto-resize ───
function autoResize(textarea) {
  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
  });
}

function bindEnterSend(textarea, handler) {
  textarea.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handler(); }
  });
}

// ─── Utility ───
function esc(s) { if (!s) return ''; const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

function timeAgo(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  if (diff < 0 || diff < 30000) return 'Just now';
  const m = Math.floor(diff / 60000);
  if (m < 60) return m + 'm ago';
  const h = Math.floor(m / 60);
  if (h < 24) return h + 'h ago';
  const d = Math.floor(h / 24);
  if (d < 30) return d + 'd ago';
  return new Date(ts).toLocaleDateString();
}

function showToast(msg) {
  const t = document.createElement('div');
  t.className = 'token-toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => { t.classList.add('fade-out'); setTimeout(() => t.remove(), 400); }, 2000);
}

function renderMarkdown(text) {
  if (!text) return '';
  // Protect code blocks first
  const codeBlocks = [];
  let s = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    codeBlocks.push('<pre><code>' + esc(code) + '</code></pre>');
    return '\x00CB' + (codeBlocks.length - 1) + '\x00';
  });
  // Protect inline code
  const inlineCodes = [];
  s = s.replace(/`([^`]+)`/g, (_, code) => {
    inlineCodes.push('<code>' + esc(code) + '</code>');
    return '\x00IC' + (inlineCodes.length - 1) + '\x00';
  });
  // Process line by line
  const lines = s.split('\n');
  const out = [];
  let inList = false;
  for (let line of lines) {
    let trimmed = line.trim();
    // Headers
    if (trimmed.startsWith('### ')) { if (inList) { out.push('</ul>'); inList = false; } out.push('<h4>' + inline(trimmed.slice(4)) + '</h4>'); continue; }
    if (trimmed.startsWith('## ')) { if (inList) { out.push('</ul>'); inList = false; } out.push('<h3>' + inline(trimmed.slice(3)) + '</h3>'); continue; }
    if (trimmed.startsWith('# ')) { if (inList) { out.push('</ul>'); inList = false; } out.push('<h2>' + inline(trimmed.slice(2)) + '</h2>'); continue; }
    // Unordered list
    const ulMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (ulMatch) { if (!inList) { out.push('<ul>'); inList = true; } out.push('<li>' + inline(ulMatch[1]) + '</li>'); continue; }
    // Ordered list
    const olMatch = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (olMatch) { if (!inList) { out.push('<ul>'); inList = true; } out.push('<li>' + inline(olMatch[1]) + '</li>'); continue; }
    // Close list if needed
    if (inList) { out.push('</ul>'); inList = false; }
    // Code block placeholder
    if (trimmed.startsWith('\x00CB')) { out.push(trimmed); continue; }
    // Empty line = paragraph break
    if (!trimmed) { out.push('<br>'); continue; }
    // Normal text
    out.push('<p>' + inline(trimmed) + '</p>');
  }
  if (inList) out.push('</ul>');
  let html = out.join('\n');
  // Restore code blocks and inline code
  html = html.replace(/\x00CB(\d+)\x00/g, (_, i) => codeBlocks[+i]);
  html = html.replace(/\x00IC(\d+)\x00/g, (_, i) => inlineCodes[+i]);
  return html;

  function inline(t) {
    t = esc(t);
    t = t.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/\*(.+?)\*/g, '<em>$1</em>');
    t = t.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    t = t.replace(/\x00IC(\d+)\x00/g, (_, i) => inlineCodes[+i]);
    return t;
  }
}

// ─── Great Minds ───
const MIND_COLORS = ['#6d597a','#355070','#264653','#2a9d8f','#e76f51','#b56576','#0077b6','#588157','#9b2226','#457b9d'];
function mindColor(name) { let h = 0; for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0; return MIND_COLORS[Math.abs(h) % MIND_COLORS.length]; }
function mindInitials(name) { return name.split(/\s+/).slice(0, 2).map(w => w[0].toUpperCase()).join(''); }

async function loadMinds() {
  try { allMinds = await api('/api/minds'); } catch { allMinds = []; }
}

let _graphSim = null;
let _graphAnim = null;
let _graphState = null;

function _domainTokens(m) {
  return (m.domain || '').toLowerCase().split(/[,;\/&]+/).map(d => d.trim()).filter(Boolean);
}

function _buildGraphData(minds) {
  const nodes = minds.map(m => ({
    id: m.id, name: m.name, era: m.era || '',
    domain: m.domain || '', bio: m.bio_summary || '',
    color: mindColor(m.name), initials: mindInitials(m.name),
    chatCount: m.chat_count || 0,
    tokens: _domainTokens(m),
  }));

  const links = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const shared = nodes[i].tokens.filter(t => nodes[j].tokens.some(u => t === u || t.includes(u) || u.includes(t)));
      if (shared.length > 0) {
        links.push({ source: nodes[i].id, target: nodes[j].id, strength: shared.length });
      }
    }
  }
  if (links.length === 0 && nodes.length > 1) {
    for (let i = 1; i < nodes.length; i++) {
      links.push({ source: nodes[0].id, target: nodes[i].id, strength: 0.3 });
    }
  }
  return { nodes, links };
}

function renderMindsPage() {
  const search = document.getElementById('minds-search');
  if (search) search.value = '';
  _renderMindsGraph();
}

function _hexToRgb(hex) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return [r, g, b];
}

function _renderMindsGraph() {
  const container = document.getElementById('minds-graph');
  const tooltip = document.getElementById('minds-tooltip');
  if (!container) return;

  if (_graphAnim) { cancelAnimationFrame(_graphAnim); _graphAnim = null; }
  if (_graphSim) { _graphSim.stop(); _graphSim = null; }
  container.innerHTML = '';
  tooltip.classList.add('hidden');

  if (!allMinds.length) {
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:rgba(160,180,220,0.5);font-size:14px">Minds are being generated… refresh in a moment.</div>';
    return;
  }

  const { nodes, links } = _buildGraphData(allMinds);
  const dpr = window.devicePixelRatio || 1;
  const W = container.clientWidth || 900;
  const H = container.clientHeight || 600;
  const BASE_R = Math.max(20, Math.min(30, W / (nodes.length * 2)));

  const canvas = document.createElement('canvas');
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  let transform = d3.zoomIdentity;
  const zoomBehavior = d3.zoom()
    .scaleExtent([0.1, 6])
    .on('zoom', (e) => { transform = e.transform; });
  d3.select(canvas).call(zoomBehavior);

  const particles = [];
  links.forEach(l => {
    const count = Math.max(1, Math.round(l.strength * 1.5));
    for (let i = 0; i < count; i++) {
      particles.push({
        link: l,
        t: Math.random(),
        speed: 0.001 + Math.random() * 0.003,
        size: 1 + Math.random() * 1.5,
        opacity: 0.3 + Math.random() * 0.5,
      });
    }
  });

  const ADD_R = 18;
  const addNode = {
    id: '__add__', name: '', era: '', domain: '', bio: '', initials: '+',
    color: 'none', tokens: [], _isAdd: true, x: W / 2 + 120, y: H / 2 - 120,
  };
  nodes.push(addNode);

  let hoveredNode = null;
  let highlightQuery = '';
  let addBusy = false;
  let mouseWorld = null;

  const state = { nodes, links, particles, hoveredNode, highlightQuery };
  _graphState = state;

  const linkForce = d3.forceLink(links).id(d => d.id)
    .distance(d => Math.max(80, 280 - d.strength * 70))
    .strength(d => 0.08 + d.strength * 0.15);

  const sim = d3.forceSimulation(nodes)
    .force('link', linkForce)
    .force('charge', d3.forceManyBody().strength(-600).distanceMax(800))
    .force('center', d3.forceCenter(W / 2, H / 2).strength(0.03))
    .force('collision', d3.forceCollide().radius(d => d._isAdd ? ADD_R + 15 : BASE_R + 20))
    .force('x', d3.forceX(W / 2).strength(0.02))
    .force('y', d3.forceY(H / 2).strength(0.02))
    .alphaDecay(0.015);
  _graphSim = sim;

  const time = { now: 0 };

  function draw() {
    time.now = performance.now();
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.k, transform.k);

    const matchIds = new Set();
    if (state.highlightQuery) {
      const q = state.highlightQuery.toLowerCase();
      nodes.forEach(n => {
        if (n.name.toLowerCase().includes(q) || n.domain.toLowerCase().includes(q) || n.era.toLowerCase().includes(q))
          matchIds.add(n.id);
      });
    }
    const filtering = matchIds.size > 0;

    for (const l of links) {
      const s = l.source, t = l.target;
      const dimmed = filtering && !matchIds.has(s.id) && !matchIds.has(t.id);
      const alpha = dimmed ? 0.04 : (0.12 + l.strength * 0.08);
      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(t.x, t.y);
      ctx.strokeStyle = `rgba(160,170,190,${alpha})`;
      ctx.lineWidth = 0.6 + l.strength * 0.4;
      ctx.stroke();
    }

    for (const p of particles) {
      p.t += p.speed;
      if (p.t > 1) p.t -= 1;
      const s = p.link.source, t = p.link.target;
      const dimmed = filtering && !matchIds.has(s.id) && !matchIds.has(t.id);
      if (dimmed) continue;
      const px = s.x + (t.x - s.x) * p.t;
      const py = s.y + (t.y - s.y) * p.t;
      ctx.beginPath();
      ctx.arc(px, py, p.size * transform.k < 0.5 ? 0 : p.size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(130,150,200,${p.opacity * 0.45})`;
      ctx.fill();
    }

    if (state.hoveredNode !== addNode) {
      let cx = 0, cy = 0, cnt = 0;
      for (const n of nodes) { if (!n._isAdd) { cx += n.x; cy += n.y; cnt++; } }
      if (cnt) {
        cx /= cnt; cy /= cnt;
        let maxD = 0;
        for (const n of nodes) { if (!n._isAdd) { const d = Math.hypot(n.x - cx, n.y - cy); if (d > maxD) maxD = d; } }
        const a = time.now * 0.00015;
        addNode.x = cx + Math.cos(a) * (maxD + BASE_R * 3.5);
        addNode.y = cy + Math.sin(a) * (maxD + BASE_R * 3.5);
      }
    }

    for (const n of nodes) {
      if (n._isAdd) {
        const hov = state.hoveredNode === n;
        const pulse = 1 + Math.sin(time.now * 0.003) * 0.08;
        const ar = ADD_R * pulse;
        const glow = ctx.createRadialGradient(n.x, n.y, ar * 0.3, n.x, n.y, ar * 2.5);
        glow.addColorStop(0, `rgba(100,130,200,${hov ? 0.12 : 0.04})`);
        glow.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.beginPath();
        ctx.arc(n.x, n.y, ar * 2.5, 0, Math.PI * 2);
        ctx.fillStyle = glow;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(n.x, n.y, ar, 0, Math.PI * 2);
        ctx.fillStyle = hov ? 'rgba(90,120,180,0.15)' : 'rgba(140,160,200,0.08)';
        ctx.fill();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = `rgba(100,130,180,${hov ? 0.6 : 0.25})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.fillStyle = `rgba(80,110,170,${hov ? 0.8 : 0.45})`;
        ctx.font = `300 ${ar * 1.1}px Inter, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(addBusy ? '…' : '+', n.x, n.y + 1);

        if (!addBusy) {
          ctx.fillStyle = `rgba(80,110,170,${hov ? 0.6 : 0.3})`;
          ctx.font = '500 9px Inter, sans-serif';
          ctx.fillText('Discover', n.x, n.y + ar + 13);
        } else {
          ctx.fillStyle = 'rgba(80,110,170,0.4)';
          ctx.font = '500 9px Inter, sans-serif';
          ctx.fillText('Inviting...', n.x, n.y + ar + 13);
        }
        continue;
      }

      const dimmed = filtering && !matchIds.has(n.id);
      const hovered = state.hoveredNode === n;
      const highlighted = filtering && matchIds.has(n.id);

      let r = BASE_R;
      if (mouseWorld) {
        const dx = n.x - mouseWorld[0], dy = n.y - mouseWorld[1];
        const dist = Math.sqrt(dx * dx + dy * dy);
        const focusRadius = 250;
        if (dist < focusRadius) {
          const t = 1 - dist / focusRadius;
          r = BASE_R * (1 + t * 0.7);
        } else {
          r = BASE_R * 0.75;
        }
      }
      if (hovered) r = Math.max(r, BASE_R * 1.6);
      const pulse = 1 + Math.sin(time.now * 0.002 + n.name.length) * 0.04;
      const rr = r * pulse;
      const [cr, cg, cb] = _hexToRgb(n.color);
      const nodeAlpha = dimmed ? 0.12 : 1;

      if (!dimmed) {
        const glowR = rr * 2.5;
        const grad = ctx.createRadialGradient(n.x, n.y, rr * 0.5, n.x, n.y, glowR);
        grad.addColorStop(0, `rgba(${cr},${cg},${cb},${hovered ? 0.15 : 0.05})`);
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.beginPath();
        ctx.arc(n.x, n.y, glowR, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();
      }

      if (n._newAt) {
        const age = (time.now - n._newAt) / 1000;
        if (age < 12) {
          const fade = Math.max(0, 1 - age / 12);
          const ring = 1 + Math.sin(time.now * 0.004) * 0.5;

          const outerR = rr + 12 + ring * 10;
          const glowG = ctx.createRadialGradient(n.x, n.y, rr * 0.5, n.x, n.y, outerR);
          glowG.addColorStop(0, `rgba(34,197,94,${fade * 0.25})`);
          glowG.addColorStop(0.6, `rgba(34,197,94,${fade * 0.08})`);
          glowG.addColorStop(1, 'rgba(34,197,94,0)');
          ctx.beginPath();
          ctx.arc(n.x, n.y, outerR, 0, Math.PI * 2);
          ctx.fillStyle = glowG;
          ctx.fill();

          ctx.beginPath();
          ctx.arc(n.x, n.y, rr + 4 + ring * 3, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(34,197,94,${fade * 0.8})`;
          ctx.lineWidth = 2.5;
          ctx.stroke();

          const badgeY = n.y - rr - 16;
          const badgeW = 32, badgeH = 16, badgeR = 8;
          ctx.beginPath();
          ctx.roundRect(n.x - badgeW / 2, badgeY - badgeH / 2, badgeW, badgeH, badgeR);
          ctx.fillStyle = `rgba(34,197,94,${fade * 0.9})`;
          ctx.fill();
          ctx.fillStyle = `rgba(255,255,255,${fade * 0.95})`;
          ctx.font = '700 9px Inter, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('NEW', n.x, badgeY);
        } else {
          delete n._newAt;
        }
      }

      if (n._expanding) {
        const spinAngle = (time.now * 0.003) % (Math.PI * 2);
        const spinR = rr + 10;
        ctx.beginPath();
        ctx.arc(n.x, n.y, spinR, spinAngle, spinAngle + Math.PI * 1.2);
        ctx.strokeStyle = 'rgba(99,102,241,0.7)';
        ctx.lineWidth = 3;
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(n.x, n.y, spinR, spinAngle + Math.PI * 1.5, spinAngle + Math.PI * 1.8);
        ctx.strokeStyle = 'rgba(99,102,241,0.35)';
        ctx.lineWidth = 3;
        ctx.stroke();

        const lblY = n.y + rr + 20;
        const lblTxt = 'Discovering' + '.'.repeat(Math.floor(time.now / 500) % 4);
        ctx.font = '600 10px Inter, sans-serif';
        const lblW = ctx.measureText(lblTxt).width + 14;
        ctx.beginPath();
        ctx.roundRect(n.x - lblW / 2, lblY - 8, lblW, 16, 8);
        ctx.fillStyle = 'rgba(99,102,241,0.85)';
        ctx.fill();
        ctx.fillStyle = '#fff';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(lblTxt, n.x, lblY);
      }

      if (highlighted || hovered) {
        ctx.beginPath();
        ctx.arc(n.x, n.y, rr + 3, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${cr},${cg},${cb},${hovered ? 0.5 : 0.3})`;
        ctx.lineWidth = 2;
        ctx.stroke();
      }

      ctx.beginPath();
      ctx.arc(n.x, n.y, rr, 0, Math.PI * 2);
      ctx.fillStyle = dimmed ? `rgba(${cr},${cg},${cb},${nodeAlpha})` : n.color;
      ctx.fill();
      ctx.strokeStyle = dimmed ? 'rgba(0,0,0,0.03)' : 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      if (!dimmed) {
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.font = `700 ${rr * 0.6}px Inter, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(n.initials, n.x, n.y);

        ctx.fillStyle = `rgba(30,35,50,${hovered ? 0.9 : 0.7})`;
        ctx.font = `600 ${hovered ? 12 : 11}px 'Libre Baskerville', Georgia, serif`;
        ctx.fillText(n.name, n.x, n.y + rr + 14);

        ctx.fillStyle = 'rgba(100,110,130,0.6)';
        ctx.font = `400 9px Inter, sans-serif`;
        ctx.fillText(n.era, n.x, n.y + rr + 27);
      }
    }

    ctx.restore();
    _graphAnim = requestAnimationFrame(draw);
  }

  sim.on('tick', () => {});
  draw();

  function _getNodeAt(cx, cy) {
    const [mx, my] = transform.invert([cx, cy]);
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i];
      let hr;
      if (n._isAdd) {
        hr = ADD_R + 5;
      } else {
        hr = BASE_R;
        if (mouseWorld) {
          const dd = Math.sqrt((n.x - mx) * (n.x - mx) + (n.y - my) * (n.y - my));
          if (dd < 250) hr = BASE_R * (1 + (1 - dd / 250) * 0.7);
          else hr = BASE_R * 0.75;
        }
        hr += 5;
      }
      const dx = mx - n.x, dy = my - n.y;
      if (dx * dx + dy * dy < hr * hr) return n;
    }
    return null;
  }

  const _expandedSet = new Set();

  function _insertMindNode(mind, nearNode) {
    const newNode = {
      id: mind.id, name: mind.name, era: mind.era || '',
      domain: mind.domain || '', bio: mind.bio_summary || '',
      color: mindColor(mind.name), initials: mindInitials(mind.name),
      chatCount: 0, tokens: _domainTokens(mind),
      x: nearNode.x + (Math.random() - 0.5) * 100,
      y: nearNode.y + (Math.random() - 0.5) * 100,
      _newAt: performance.now(),
    };
    nodes.splice(nodes.length - 1, 0, newNode);
    for (const existing of nodes) {
      if (existing._isAdd || existing === newNode) continue;
      const shared = newNode.tokens.filter(t => existing.tokens.some(u => t === u || t.includes(u) || u.includes(t)));
      if (shared.length > 0) {
        const nl = { source: newNode, target: existing, strength: shared.length };
        links.push(nl);
        for (let p = 0, c = Math.max(1, Math.round(shared.length * 1.5)); p < c; p++) {
          particles.push({ link: nl, t: Math.random(), speed: 0.001 + Math.random() * 0.003, size: 1 + Math.random() * 1.5, opacity: 0.3 + Math.random() * 0.5 });
        }
      }
    }
    sim.nodes(nodes);
    sim.force('link').links(links);
    sim.alpha(0.4).restart();
    return newNode;
  }

  async function _expandFromNode(node) {
    if (node._isAdd || _expandedSet.has(node.id)) return;
    _expandedSet.add(node.id);
    node._expanding = true;
    showToast(`Inviting minds related to ${node.name}…`);
    let addedCount = 0;
    try {
      const existingNames = nodes.filter(d => !d._isAdd).map(d => d.name);
      const resp = await api('/api/minds/suggest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic: node.domain, count: 3, exclude: existingNames }),
      });
      for (const s of (resp.minds || [])) {
        if (nodes.some(d => d.name.toLowerCase() === s.name.toLowerCase())) continue;
        try {
          const mind = await api('/api/minds/generate', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ name: s.name, era: s.era || '', domain: s.domain || '' }),
          });
          allMinds.push(mind);
          _insertMindNode(mind, node);
          addedCount++;
        } catch (err) { console.warn('Expand: failed to generate', s.name, err); }
      }
    } catch (err) {
      console.warn('Expand: suggest failed', err);
      showToast('Failed to discover minds — please try again.');
    }
    node._expanding = false;

    if (addedCount > 0) {
      showToast(`${addedCount} new mind${addedCount > 1 ? 's' : ''} joined the network!`);
      setTimeout(() => {
        const newNodes = nodes.filter(d => d._newAt);
        if (!newNodes.length) return;
        let cx = node.x, cy = node.y;
        for (const nn of newNodes) { cx += nn.x; cy += nn.y; }
        cx /= (newNodes.length + 1);
        cy /= (newNodes.length + 1);
        const targetK = Math.min(transform.k, 1.2);
        const tx = W / 2 - cx * targetK;
        const ty = H / 2 - cy * targetK;
        d3.select(canvas).transition().duration(800).call(
          zoomBehavior.transform,
          d3.zoomIdentity.translate(tx, ty).scale(targetK)
        );
      }, 500);
    } else {
      showToast('No new minds found nearby.');
    }
  }

  canvas.addEventListener('mouseleave', () => {
    mouseWorld = null;
    state.hoveredNode = null;
  });

  let _tooltipNode = null;
  let _tooltipInside = false;

  tooltip.addEventListener('mouseenter', () => { _tooltipInside = true; });
  tooltip.addEventListener('mouseleave', () => {
    _tooltipInside = false;
    _tooltipNode = null;
    state.hoveredNode = null;
    tooltip.classList.add('hidden');
  });

  function _showTooltip(n, anchorX, anchorY) {
    if (_tooltipNode === n) return;
    _tooltipNode = n;
    if (n._isAdd) {
      tooltip.innerHTML = `
        <div class="tt-name">Discover More Minds</div>
        <div class="tt-bio">Click to invite new great minds related to the current network.</div>
        <div class="tt-action">Click to discover →</div>`;
    } else {
      const domains = n.tokens.map(t => `<span class="tt-domain-tag">${t}</span>`).join('');
      const discoverBtn = _expandedSet.has(n.id) ? '' : n._expanding
        ? '<div class="tt-action" style="opacity:0.5">Discovering related minds…</div>'
        : `<button class="tt-discover-btn" data-mind-id="${n.id}">Discover nearby minds →</button>`;
      tooltip.innerHTML = `
        <div class="tt-name">${n.name}</div>
        <div class="tt-era">${n.era}</div>
        <div class="tt-domains">${domains}</div>
        <div class="tt-bio">${n.bio}</div>
        <div class="tt-action">Click to chat →</div>
        ${discoverBtn}`;
      const btn = tooltip.querySelector('.tt-discover-btn');
      if (btn) {
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          _expandFromNode(n);
          tooltip.classList.add('hidden');
          _tooltipNode = null;
        });
      }
    }
    tooltip.classList.remove('hidden');
    const tx = anchorX + 16;
    tooltip.style.left = (tx + 320 > W ? anchorX - 330 : tx) + 'px';
    tooltip.style.top = (anchorY - 10) + 'px';
  }

  function _hideTooltip() {
    if (_tooltipInside) return;
    _tooltipNode = null;
    tooltip.classList.add('hidden');
  }

  canvas.addEventListener('mousemove', (e) => {
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    mouseWorld = transform.invert([cx, cy]);
    const n = _getNodeAt(cx, cy);
    state.hoveredNode = n;
    canvas.style.cursor = n ? 'pointer' : 'grab';

    if (n) {
      _showTooltip(n, cx, cy);
    } else if (!_tooltipInside) {
      _hideTooltip();
    }
  });

  canvas.addEventListener('click', async (e) => {
    const rect = canvas.getBoundingClientRect();
    const n = _getNodeAt(e.clientX - rect.left, e.clientY - rect.top);
    if (!n) return;
    if (n._isAdd) {
      if (addBusy) return;
      addBusy = true;
      tooltip.classList.add('hidden');
      try {
        const existingNames = nodes.filter(d => !d._isAdd).map(d => d.name);
        const allDomains = [...new Set(nodes.filter(d => !d._isAdd).flatMap(d => d.tokens))];
        const topic = allDomains.slice(0, 8).join(', ');
        const resp = await api('/api/minds/suggest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topic, count: 3, exclude: existingNames }),
        });
        const suggestions = resp.minds || [];
        for (const s of suggestions) {
          if (nodes.some(d => d.name.toLowerCase() === s.name.toLowerCase())) continue;
          try {
            const mind = await api('/api/minds/generate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: s.name, era: s.era || '', domain: s.domain || '' }),
            });
            allMinds.push(mind);
            _insertMindNode(mind, addNode);
          } catch (err) { console.warn('Failed to generate mind:', s.name, err); }
        }
      } catch (err) { console.error('Failed to discover minds:', err); }
      addBusy = false;
      return;
    }
    window.location.hash = '#/mind/' + n.id;
  });

  canvas.addEventListener('mouseleave', (e) => {
    if (e.relatedTarget && tooltip.contains(e.relatedTarget)) return;
    state.hoveredNode = null;
    _hideTooltip();
  });

  d3.select(canvas).call(
    d3.drag()
      .subject((e) => {
        const [mx, my] = transform.invert([e.x, e.y]);
        const n = nodes.find(d => {
          const dx = mx - d.x, dy = my - d.y;
          return dx * dx + dy * dy < (BASE_R + 5) * (BASE_R + 5);
        });
        return n || null;
      })
      .on('start', (e) => {
        if (!e.subject) return;
        if (!e.active) sim.alphaTarget(0.3).restart();
        e.subject.fx = e.subject.x;
        e.subject.fy = e.subject.y;
      })
      .on('drag', (e) => {
        if (!e.subject) return;
        const [mx, my] = transform.invert([e.x, e.y]);
        e.subject.fx = mx;
        e.subject.fy = my;
      })
      .on('end', (e) => {
        if (!e.subject) return;
        if (!e.active) sim.alphaTarget(0);
        e.subject.fx = null;
        e.subject.fy = null;
      })
  );
}

function _applyGraphHighlight(query) {
  if (_graphState) _graphState.highlightQuery = query || '';
}

async function renderMindDetail(mindId) {
  const headerEl = document.getElementById('mind-header');
  const chatBox = document.getElementById('mind-chat-messages');
  const metaSidebar = document.getElementById('mind-meta-sidebar');
  chatBox.innerHTML = '';
  mindChatHistory = [];

  let mind = allMinds.find(m => m.id === mindId);
  if (!mind) {
    try { mind = await api('/api/minds/' + mindId); } catch {}
  }
  if (!mind) {
    headerEl.innerHTML = '<div class="mind-inline-info"><h2>Mind not found</h2></div>';
    return;
  }

  const color = mindColor(mind.name);
  const initials = mindInitials(mind.name);
  headerEl.innerHTML = `
    <div class="mind-avatar" style="background:${color};width:40px;height:40px;font-size:16px">${initials}</div>
    <div class="mind-inline-info"><h2>${esc(mind.name)}</h2><p>${esc(mind.era)} · ${esc(mind.domain)}</p></div>`;

  const domains = (mind.domain || '').split(',').map(d => d.trim()).filter(Boolean);
  const works = mind.works || [];
  metaSidebar.innerHTML = `
    <h3 class="sidebar-title">ABOUT</h3>
    <div class="mind-avatar" style="background:${color};width:64px;height:64px;font-size:28px;margin:0 auto 12px">${initials}</div>
    <p style="font-size:14px;font-weight:600;text-align:center;margin-bottom:4px">${esc(mind.name)}</p>
    <p style="font-size:12px;color:var(--text-muted);text-align:center;margin-bottom:12px">${esc(mind.era)}</p>
    ${mind.bio_summary ? `<p style="font-size:12px;color:var(--text-secondary);line-height:1.5;margin-bottom:12px">${esc(mind.bio_summary)}</p>` : ''}
    ${domains.length ? `<div style="margin-bottom:12px">${domains.map(d => `<span class="mind-domain-tag">${esc(d)}</span> `).join('')}</div>` : ''}
    ${works.length ? `<h3 class="sidebar-title" style="margin-top:16px">WORKS</h3><ul style="font-size:12px;color:var(--text-secondary);padding-left:16px;margin:0">${works.map(w => `<li style="margin-bottom:4px">${esc(w)}</li>`).join('')}</ul>` : ''}
    <p style="font-size:11px;color:var(--text-muted);margin-top:12px">${mind.chat_count || 0} discussions</p>`;
}

async function sendMindChat(mindId, message) {
  const chatBox = document.getElementById('mind-chat-messages');
  const input = document.getElementById('mind-chat-input');
  appendMsg(chatBox, 'user', message);
  if (input) input.value = '';
  showLoading(chatBox);

  const body = { message };
  if (mindChatHistory.length) body.history = mindChatHistory;

  // Add selected books as context
  if (selectedBooks.size) {
    body.book_context = [...selectedBooks.values()].map(b => ({ title: b.title, author: b.author || '' }));
    body.agent_ids = [...selectedBooks.values()].map(b => b.agentId);
  }

  try {
    const data = await api('/api/minds/' + mindId + '/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    removeLoading();
    const msgOpts = {};
    if (data.references?.length) msgOpts.references = data.references;
    if (data.usage) msgOpts.usage = data.usage;
    appendMsg(chatBox, 'assistant', data.response, null, msgOpts);
    mindChatHistory.push({ role: 'user', content: message });
    mindChatHistory.push({ role: 'assistant', content: data.response });
  } catch (err) {
    removeLoading();
    appendMsg(chatBox, 'assistant', 'Error: ' + err.message);
  }
}

function showAddMindDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'mind-add-dialog';
  overlay.innerHTML = `
    <div class="mind-add-form">
      <h3>Invite a Great Mind</h3>
      <input type="text" id="add-mind-name" placeholder="Name (e.g., Socrates, Ada Lovelace)" autocomplete="off" />
      <div class="mind-add-actions">
        <button id="add-mind-cancel">Cancel</button>
        <button id="add-mind-submit" class="primary-btn">Generate</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const nameInput = overlay.querySelector('#add-mind-name');
  nameInput.focus();
  overlay.querySelector('#add-mind-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  const submit = async () => {
    const name = nameInput.value.trim();
    if (!name) return;
    const btn = overlay.querySelector('#add-mind-submit');
    btn.textContent = 'Generating...';
    btn.disabled = true;
    try {
      await api('/api/minds/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      overlay.remove();
      await loadMinds();
      if (getRoute().page === 'minds') _renderMindsGraph();
    } catch (err) {
      btn.textContent = 'Generate';
      btn.disabled = false;
      alert('Failed: ' + err.message);
    }
  };
  overlay.querySelector('#add-mind-submit').addEventListener('click', submit);
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
}

function showCreateMindDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'mind-add-dialog';
  overlay.innerHTML = `
    <div class="mind-add-form" style="max-width:460px">
      <h3>Create Your Mind</h3>
      <p style="font-size:13px;color:var(--text-muted);margin:0 0 14px">Paste a Twitter/X profile link, blog URL, or text content to generate a mind agent.</p>
      <input type="text" id="create-mind-name" placeholder="Name" autocomplete="off" />
      <input type="text" id="create-mind-url" placeholder="Twitter/X profile or blog URL (optional)" autocomplete="off" style="margin-top:8px" />
      <textarea id="create-mind-content" placeholder="Or paste text content here — tweets, blog posts, notes, markdown..." rows="5" style="margin-top:8px;width:100%;resize:vertical;font-family:inherit;font-size:13px;padding:10px 12px;border-radius:10px;border:1px solid var(--border-strong);background:var(--bg-main)"></textarea>
      <input type="file" id="create-mind-file" accept=".md,.txt,.markdown" hidden />
      <button type="button" id="create-mind-file-btn" style="margin-top:6px;font-size:12px;color:var(--text-muted);background:none;border:none;cursor:pointer;text-decoration:underline;padding:0">or upload a .md / .txt file</button>
      <div class="mind-add-actions" style="margin-top:14px">
        <button id="create-mind-cancel">Cancel</button>
        <button id="create-mind-submit" class="primary-btn">Create Mind</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  const nameInput = overlay.querySelector('#create-mind-name');
  const urlInput = overlay.querySelector('#create-mind-url');
  const contentArea = overlay.querySelector('#create-mind-content');
  const fileInput = overlay.querySelector('#create-mind-file');
  const fileBtn = overlay.querySelector('#create-mind-file-btn');

  nameInput.focus();
  overlay.querySelector('#create-mind-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });

  fileBtn.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      contentArea.value = reader.result;
      if (!nameInput.value.trim()) {
        nameInput.value = file.name.replace(/\.(md|txt|markdown)$/i, '');
      }
    };
    reader.readAsText(file);
  });

  const submit = async () => {
    const name = nameInput.value.trim();
    const url = urlInput.value.trim();
    const content = contentArea.value.trim();
    if (!name) { nameInput.focus(); return; }
    if (!url && !content) { urlInput.focus(); return; }

    const btn = overlay.querySelector('#create-mind-submit');
    btn.textContent = 'Creating...';
    btn.disabled = true;
    try {
      await api('/api/minds/create-from-content', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, source_url: url, content }),
      });
      overlay.remove();
      await loadMinds();
      if (getRoute().page === 'minds') _renderMindsGraph();
    } catch (err) {
      btn.textContent = 'Create Mind';
      btn.disabled = false;
      alert('Failed: ' + err.message);
    }
  };
  overlay.querySelector('#create-mind-submit').addEventListener('click', submit);
}

// Perspectives panel rendering (appended to assistant messages)
function renderPerspectives(container, perspectives) {
  if (!perspectives || !perspectives.length) return;
  const panel = document.createElement('div');
  panel.className = 'perspectives-panel';
  let html = '<div class="perspectives-header"><span>Great Minds</span></div>';
  for (const p of perspectives) {
    const color = mindColor(p.mind_name);
    const initials = mindInitials(p.mind_name);
    html += `<div class="perspective-item">
      <div class="perspective-mind-row">
        <div class="perspective-avatar" style="background:${color}">${initials}</div>
        <span class="perspective-name">${esc(p.mind_name)}</span>
      </div>
      <div class="perspective-text">${renderMarkdown(p.response)}</div>
    </div>`;
  }
  panel.innerHTML = html;
  container.appendChild(panel);
  container.scrollTop = container.scrollHeight;
}

// ─── Init ───
async function init() {
  await Promise.all([loadAgents(), loadVotes(), loadTopics(), loadMinds()]);
  buildBookList();
  restoreSessions();
  renderChatHistory();

  document.getElementById('app-layout').classList.add('sidebar-collapsed');

  // Sidebar toggle
  document.getElementById('sidebar-toggle-btn').addEventListener('click', toggleSidebar);
  document.getElementById('sidebar-float-btn').addEventListener('click', toggleSidebar);

  // Chats page
  document.getElementById('chats-search').addEventListener('input', e => {
    _renderChatsList(e.target.value.trim().toLowerCase());
  });
  document.getElementById('chats-new-btn').addEventListener('click', () => {
    saveCurrentSession();
    currentSessionId = null;
    selectedBooks.clear();
    selectedMinds.clear();
    window.location.hash = '#/';
  });

  // New Chat → go to homepage
  document.getElementById('new-chat-btn').addEventListener('click', () => {
    saveCurrentSession();
    currentSessionId = null;
    selectedBooks.clear();
    selectedMinds.clear();
    window.location.hash = '#/';
  });

  // Home composer
  const homeInput = document.getElementById('home-input');
  autoResize(homeInput);
  bindEnterSend(homeInput, handleHomeSend);
  document.getElementById('home-send-btn').addEventListener('click', handleHomeSend);

  // Home + button → books popover
  const uploadBtn = document.getElementById('upload-btn');
  const uploadInput = document.getElementById('upload-file-input');
  uploadBtn.addEventListener('click', e => { e.stopPropagation(); togglePopover('home-popover', 'home-popover-book-list', 'home-popover-no-books'); });
  document.getElementById('home-popover-upload').addEventListener('click', () => { closeAllPopovers(); uploadInput.click(); });
  uploadInput.addEventListener('change', () => { if (uploadInput.files.length) { handleFileUpload(uploadInput.files, 'home-upload-status'); uploadInput.value = ''; } });

  // Home minds button → minds popover
  document.getElementById('home-minds-btn').addEventListener('click', e => { e.stopPropagation(); toggleMindPopover('home-minds-popover', 'home-popover-mind-list', 'home-popover-no-minds'); });

  // Chat page composer
  const chatInput = document.getElementById('chat-input');
  autoResize(chatInput);
  bindEnterSend(chatInput, handleChatSend);
  document.getElementById('chat-send-btn').addEventListener('click', handleChatSend);

  // Chat + button → books popover
  const chatPlusBtn = document.getElementById('chat-plus-btn');
  const chatUploadInput = document.getElementById('chat-upload-file-input');
  chatPlusBtn.addEventListener('click', e => { e.stopPropagation(); togglePopover('chat-popover', 'popover-book-list', 'popover-no-books'); });
  document.getElementById('popover-upload-action').addEventListener('click', () => { closeAllPopovers(); chatUploadInput.click(); });
  chatUploadInput.addEventListener('change', () => { if (chatUploadInput.files.length) { handleFileUpload(chatUploadInput.files, null); chatUploadInput.value = ''; } });

  // Chat minds button → minds popover
  document.getElementById('chat-minds-btn').addEventListener('click', e => { e.stopPropagation(); toggleMindPopover('chat-minds-popover', 'popover-mind-list', 'popover-no-minds'); });
  document.addEventListener('click', e => {
    document.querySelectorAll('.composer-popover').forEach(pop => {
      if (!pop.classList.contains('hidden') && !pop.contains(e.target) && !e.target.closest('.composer-icon-btn')) {
        pop.classList.add('hidden');
      }
    });
  });

  // Book chat
  const bookInput = document.getElementById('book-chat-input');
  autoResize(bookInput);
  bindEnterSend(bookInput, () => {
    const msg = bookInput.value.trim();
    if (msg && currentBookId) { bookInput.value = ''; sendBookChat(currentBookId, msg); }
  });
  document.getElementById('book-send-btn').addEventListener('click', () => {
    const msg = bookInput.value.trim();
    if (msg && currentBookId) { bookInput.value = ''; sendBookChat(currentBookId, msg); }
  });

  // Library controls
  let searchTimer = null;
  document.getElementById('library-search').addEventListener('input', e => {
    librarySearch = e.target.value.trim();
    _searchDiscoveredIds.clear();
    _searchUsage = null;
    renderLibraryGrid();
    clearTimeout(searchTimer);
    if (librarySearch.length >= 2) {
      // Check if local results are empty
      const q = librarySearch.toLowerCase();
      const hasLocal = allBooks.some(b => b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q));
      if (!hasLocal) {
        searchTimer = setTimeout(() => autoSearchBook(librarySearch), 600);
      }
    }
  });
  document.querySelectorAll('.filter-tag').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.filter-tag').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      libraryFilter = btn.dataset.filter;
      renderLibraryGrid();
    });
  });

  // Minds page
  document.getElementById('minds-search').addEventListener('input', e => {
    _applyGraphHighlight(e.target.value.trim());
  });
  document.getElementById('minds-add-btn').addEventListener('click', showAddMindDialog);
  document.getElementById('minds-create-btn').addEventListener('click', showCreateMindDialog);

  // Mind chat
  const mindInput = document.getElementById('mind-chat-input');
  autoResize(mindInput);
  bindEnterSend(mindInput, () => {
    const msg = mindInput.value.trim();
    if (msg && currentMindId) { mindInput.value = ''; sendMindChat(currentMindId, msg); }
  });
  document.getElementById('mind-send-btn').addEventListener('click', () => {
    const msg = mindInput.value.trim();
    if (msg && currentMindId) { mindInput.value = ''; sendMindChat(currentMindId, msg); }
  });

  navigate();
  ensurePolling();
}

init();
