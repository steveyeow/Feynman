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

function generateStarters() {
  const selected = [...selectedBooks.values()];

  // ── Books selected in composer → questions about those books ──
  if (selected.length === 1) {
    const t = selected[0].title;
    return [
      `What are the key ideas in "${t}"?`,
      `Summarize the core argument of "${t}"`,
      `What makes "${t}" unique compared to similar books?`,
      `Quiz me on "${t}"`,
    ];
  }
  if (selected.length >= 2) {
    const a = selected[0].title, b = selected[1].title;
    const questions = [
      `Compare the main ideas in "${a}" and "${b}"`,
      `What do "${a}" and "${b}" have in common?`,
      `What are the key ideas in "${a}"?`,
    ];
    if (selected.length > 2) {
      questions.push(`Summarize what these ${selected.length} books cover together`);
    } else {
      questions.push(`What are the key ideas in "${b}"?`);
    }
    return questions;
  }

  // ── No selection → questions from the library ──
  const ready = allBooks.filter(b => b.available);
  const catalog = allBooks.filter(b => b.status === 'catalog');
  const books = ready.length ? ready : catalog;

  if (!books.length) {
    return [
      'I want to learn quantitative trading from scratch',
      'Teach me the fundamentals of philosophy',
      'What are the best books on cognitive psychology?',
      'Help me understand machine learning',
    ];
  }

  const questions = [];
  const shuffled = [...books].sort(() => Math.random() - 0.5);

  if (shuffled[0]) {
    questions.push(`What are the key ideas in "${shuffled[0].title}"?`);
  }
  if (shuffled[1]) {
    questions.push(`Summarize the core argument of "${shuffled[1].title}"`);
  }
  if (shuffled.length >= 2) {
    questions.push(`Compare "${shuffled[0].title}" and "${shuffled[1].title}"`);
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
  if (msgs.length) session.updatedAt = Date.now();
}

function switchToSession(id) {
  if (id === currentSessionId) return;
  saveCurrentSession();
  const session = chatSessions.find(s => s.id === id);
  if (!session) return;
  currentSessionId = id;
  selectedBooks = new Map(session.books);
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
    // Determine whether to suggest based on book or topic
    const suggestBody = {};
    if (bookContext && bookContext.length) {
      suggestBody.book_title = bookContext[0].title;
      suggestBody.book_author = bookContext[0].author || '';
    } else {
      suggestBody.topic = message.slice(0, 100);
    }
    suggestBody.count = 3;

    const suggestions = await api('/api/minds/suggest', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(suggestBody),
    });

    if (!suggestions.minds?.length) return;

    // Ensure minds exist (generate if needed)
    const mindIds = [];
    for (const s of suggestions.minds) {
      try {
        const mind = await api('/api/minds/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ name: s.name, era: s.era || '', domain: s.domain || '' }),
        });
        mindIds.push(mind.id);
      } catch { /* skip failed minds */ }
    }
    if (!mindIds.length) return;

    // Panel chat
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
  // Close all popovers first
  document.querySelectorAll('.composer-popover').forEach(p => p.classList.add('hidden'));
  if (show) {
    pop.classList.remove('hidden');
    renderPopoverBookList(listId, emptyId);
  }
}

function closeAllPopovers() {
  document.querySelectorAll('.composer-popover').forEach(p => p.classList.add('hidden'));
}
// Expose globally so onclick attributes work
window.togglePopover = togglePopover;
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

// Renders chips in BOTH home and chat composers + updates placeholder
function renderSelectedChips() {
  ['home-selected-chips', 'chat-selected-chips'].forEach(cId => {
    const c = document.getElementById(cId);
    if (!c) return;
    if (!selectedBooks.size) { c.innerHTML = ''; return; }
    c.innerHTML = [...selectedBooks.entries()].map(([id, b]) =>
      `<div class="book-chip"><span>${esc(b.title)}</span><button class="chip-remove" data-bid="${id}">&times;</button></div>`
    ).join('');
    c.querySelectorAll('.chip-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        selectedBooks.delete(btn.dataset.bid);
        renderSelectedChips();
        document.querySelectorAll('.composer-popover').forEach(pop => {
          if (!pop.classList.contains('hidden')) {
            const list = pop.querySelector('.popover-book-list');
            const empty = pop.querySelector('.popover-empty');
            if (list && empty) renderPopoverBookList(list.id, empty.id);
          }
        });
      });
    });
  });
  // Update placeholder based on selected books
  const homeInput = document.getElementById('home-input');
  if (homeInput) {
    homeInput.placeholder = selectedBooks.size > 0 ? 'Ask your question...' : 'Ask and learn across one or more books...';
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

function renderMindsPage() {
  const grid = document.getElementById('minds-grid');
  const search = document.getElementById('minds-search');
  if (search) search.value = '';
  _renderMindsGrid('');
}

function _renderMindsGrid(query) {
  const grid = document.getElementById('minds-grid');
  let filtered = [...allMinds];
  if (query) {
    const q = query.toLowerCase();
    filtered = filtered.filter(m =>
      m.name.toLowerCase().includes(q) ||
      (m.domain || '').toLowerCase().includes(q) ||
      (m.era || '').toLowerCase().includes(q)
    );
  }
  if (!filtered.length) {
    grid.innerHTML = filtered.length === 0 && allMinds.length === 0
      ? '<div class="empty-state"><p>Minds are being generated... refresh in a moment.</p></div>'
      : '<div class="empty-state"><p>No minds found.</p></div>';
    return;
  }
  grid.innerHTML = filtered.map(m => {
    const color = mindColor(m.name);
    const initials = mindInitials(m.name);
    const domains = (m.domain || '').split(',').map(d => d.trim()).filter(Boolean);
    const chatLabel = m.chat_count ? `${m.chat_count} discussions` : 'New';
    return `<div class="mind-card" onclick="window.location.hash='#/mind/${esc(m.id)}'">
      <div class="mind-avatar" style="background:${color}">${initials}</div>
      <div class="mind-card-name">${esc(m.name)}</div>
      <div class="mind-card-era">${esc(m.era)}</div>
      <div class="mind-card-domain">${domains.map(d => `<span class="mind-domain-tag">${esc(d)}</span>`).join('')}</div>
      <div class="mind-card-bio">${esc(m.bio_summary)}</div>
      <div class="mind-card-footer">
        <span class="mind-chat-count">${chatLabel}</span>
        <button class="mind-chat-btn" onclick="event.stopPropagation();window.location.hash='#/mind/${esc(m.id)}'">Chat &rarr;</button>
      </div>
    </div>`;
  }).join('');
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
      <h3>Add a Great Mind</h3>
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
      if (getRoute().page === 'minds') _renderMindsGrid('');
    } catch (err) {
      btn.textContent = 'Generate';
      btn.disabled = false;
      alert('Failed: ' + err.message);
    }
  };
  overlay.querySelector('#add-mind-submit').addEventListener('click', submit);
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
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
    window.location.hash = '#/';
  });

  // New Chat → go to homepage
  document.getElementById('new-chat-btn').addEventListener('click', () => {
    saveCurrentSession();
    currentSessionId = null;
    selectedBooks.clear();
    window.location.hash = '#/';
  });

  // Home composer
  const homeInput = document.getElementById('home-input');
  autoResize(homeInput);
  bindEnterSend(homeInput, handleHomeSend);
  document.getElementById('home-send-btn').addEventListener('click', handleHomeSend);

  // Home + button → popover (upload or select from library)
  const uploadBtn = document.getElementById('upload-btn');
  const uploadInput = document.getElementById('upload-file-input');
  uploadBtn.addEventListener('click', e => { e.stopPropagation(); togglePopover('home-popover', 'home-popover-book-list', 'home-popover-no-books'); });
  document.getElementById('home-popover-upload').addEventListener('click', () => { closeAllPopovers(); uploadInput.click(); });
  uploadInput.addEventListener('change', () => { if (uploadInput.files.length) { handleFileUpload(uploadInput.files, 'home-upload-status'); uploadInput.value = ''; } });

  // Chat page composer
  const chatInput = document.getElementById('chat-input');
  autoResize(chatInput);
  bindEnterSend(chatInput, handleChatSend);
  document.getElementById('chat-send-btn').addEventListener('click', handleChatSend);

  // Chat + button → popover
  const chatPlusBtn = document.getElementById('chat-plus-btn');
  const chatUploadInput = document.getElementById('chat-upload-file-input');
  chatPlusBtn.addEventListener('click', e => { e.stopPropagation(); togglePopover('chat-popover', 'popover-book-list', 'popover-no-books'); });
  document.getElementById('popover-upload-action').addEventListener('click', () => { closeAllPopovers(); chatUploadInput.click(); });
  chatUploadInput.addEventListener('change', () => { if (chatUploadInput.files.length) { handleFileUpload(chatUploadInput.files, null); chatUploadInput.value = ''; } });
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
    _renderMindsGrid(e.target.value.trim());
  });
  document.getElementById('minds-add-btn').addEventListener('click', showAddMindDialog);

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
