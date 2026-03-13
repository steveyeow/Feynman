/* ─── Feynman — Learn by asking questions ─── */

function _isDarkMode() {
  const el = document.documentElement;
  if (el.classList.contains('dark')) return true;
  if (el.classList.contains('light')) return false;
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

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
let activeMinds = new Map();
let chatSessions = [];
let currentSessionId = null;
let sessionCounter = 0;

// Topic state
let topicTags = [];
let activeTopics = new Set();   // currently selected as filters
let loadingTopics = new Set();

// Onboarding state
let userName = localStorage.getItem('userName') || '';

// ─── Pro Auth State ───
let proConfig = null;
let supabaseClient = null;
let currentUser = null;
let authToken = null;

async function loadProConfig() {
  try {
    proConfig = await api('/api/pro/config');
    if (proConfig.auth_enabled) {
      window.FEYNMAN_PRO = true;
    }
  } catch { proConfig = { auth_enabled: false }; }
}

async function initSupabase() {
  if (!proConfig?.auth_enabled || !proConfig.supabase_url || !proConfig.supabase_key) return;
  try {
    const { createClient } = window.supabase || {};
    if (!createClient) return;
    supabaseClient = createClient(proConfig.supabase_url, proConfig.supabase_key);
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session) {
      currentUser = session.user;
      authToken = session.access_token;
      userName = session.user.user_metadata?.full_name || session.user.email?.split('@')[0] || userName;
      localStorage.setItem('userName', userName);
    }
    supabaseClient.auth.onAuthStateChange((_event, session) => {
      if (session) {
        currentUser = session.user;
        authToken = session.access_token;
        userName = session.user.user_metadata?.full_name || session.user.email?.split('@')[0] || '';
        localStorage.setItem('userName', userName);
      } else {
        currentUser = null;
        authToken = null;
      }
      updateAuthUI();
    });
  } catch (e) { console.warn('Supabase init failed:', e); }
}

function updateAuthUI() {
  const bottomEl = document.getElementById('sidebar-bottom');
  if (!bottomEl) return;
  if (!window.FEYNMAN_PRO) return;
  const oldProfile = bottomEl.querySelector('.sidebar-profile, .sidebar-profile-row, .sidebar-signin-row');
  const html = currentUser
    ? `<a href="#/subscription" class="sidebar-profile-row" title="Manage subscription">
        <div class="profile-avatar">
          ${currentUser.user_metadata?.avatar_url
            ? `<img src="${esc(currentUser.user_metadata.avatar_url)}" style="width:28px;height:28px;border-radius:50%" />`
            : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`
          }
        </div>
        <div class="sidebar-label profile-info">
          <span class="profile-name">${esc(userName || 'Account')}</span>
          <span class="profile-tier">${esc(currentUser.email || '')}</span>
        </div>
      </a>`
    : `<a href="#/login" class="sidebar-profile-row sidebar-signin-row" title="Sign in">
        <div class="profile-avatar">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
        </div>
        <span class="sidebar-label">Sign in</span>
      </a>`;
  if (oldProfile) {
    oldProfile.outerHTML = html;
  } else {
    bottomEl.insertAdjacentHTML('beforeend', html);
  }
}

async function signInWithEmail(email, password) {
  if (!supabaseClient) return;
  const { error } = await supabaseClient.auth.signInWithPassword({ email, password });
  if (error) throw error;
  window.location.hash = '#/';
}

async function signUpWithEmail(email, password) {
  if (!supabaseClient) return;
  const { data, error } = await supabaseClient.auth.signUp({
    email, password,
    options: { emailRedirectTo: window.location.origin + '/#/' },
  });
  if (error) throw error;
  if (data?.user?.identities?.length === 0) {
    throw new Error('This email is already registered. Please sign in instead.');
  }
  return data;
}

async function signOut() {
  if (!supabaseClient) return;
  await supabaseClient.auth.signOut();
  currentUser = null;
  authToken = null;
  window.location.hash = '#/';
  updateAuthUI();
}
window.signOut = signOut;

function showUpgradeModal(detail) {
  const overlay = document.createElement('div');
  overlay.className = 'mind-add-dialog';
  const msg = detail?.message || 'You\'ve reached the free tier limit. Upgrade to Pro for unlimited access.';
  overlay.innerHTML = `
    <div class="mind-add-form" style="max-width:400px;text-align:center">
      <h3 style="margin-bottom:12px">Upgrade to Pro</h3>
      <p style="font-size:14px;color:var(--text-secondary);margin-bottom:20px;line-height:1.5">${esc(msg)}</p>
      <div style="display:flex;gap:12px;justify-content:center">
        <button class="onboarding-btn" id="upgrade-dismiss">Maybe Later</button>
        <button class="primary-btn" id="upgrade-go" style="padding:10px 24px">Upgrade — $10/mo</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('#upgrade-dismiss').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  overlay.querySelector('#upgrade-go').addEventListener('click', async () => {
    try {
      const data = await api('/api/pro/create-checkout-session', { method: 'POST' });
      if (data.url) window.location.href = data.url;
    } catch (err) {
      alert('Checkout failed: ' + err.message);
    }
    overlay.remove();
  });
}

const MOCK_QUESTIONS = [
  'What is the central thesis of this book?',
  'How does the author support their main argument?',
  'What are the key concepts introduced?',
  'How does this relate to what you already know?',
  'What are the practical implications?',
];

// ─── Pro Pages ───
function renderLoginPage() {
  const el = document.getElementById('page-login');
  if (!el) return;
  el.innerHTML = `
    <div class="home-center" style="max-width:400px">
      <div class="greeting-row" style="justify-content:center;margin-bottom:24px">
        <svg class="greeting-logo" width="40" height="40" viewBox="0 0 56 56" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
          <rect x="24" y="0" width="8" height="4" fill="#FDCB6E"/><rect x="26" y="4" width="4" height="4" fill="#B8B8B8"/>
          <rect x="8" y="8" width="40" height="28" fill="#DA7756"/><rect x="12" y="12" width="32" height="20" fill="#FFF1E0"/>
          <rect x="16" y="16" width="8" height="8" fill="#2D3436"/><rect x="32" y="16" width="8" height="8" fill="#2D3436"/>
          <rect x="18" y="18" width="4" height="4" fill="#fff"/><rect x="34" y="18" width="4" height="4" fill="#fff"/>
          <rect x="22" y="28" width="12" height="2" fill="#C45E3E"/><rect x="18" y="38" width="4" height="8" fill="#B8B8B8"/>
          <rect x="34" y="38" width="4" height="8" fill="#B8B8B8"/>
        </svg>
        <h1 class="greeting">Welcome to Feynman</h1>
      </div>
      <p style="text-align:center;color:var(--text-muted);margin-bottom:32px;font-size:14px">Sign in to save your progress and unlock Pro features</p>
      <form id="auth-form" class="auth-email-form" onsubmit="return false">
        <input id="auth-email" class="onboarding-input" type="email" placeholder="Email" required autocomplete="email" />
        <input id="auth-password" class="onboarding-input" type="password" placeholder="Password" required autocomplete="current-password" minlength="6" />
        <div id="auth-error" class="auth-error"></div>
        <div id="auth-success" class="auth-success"></div>
        <button id="auth-submit-btn" class="onboarding-btn auth-submit-btn" type="submit">Sign in</button>
        <p class="auth-toggle-text"><span id="auth-toggle-label">Don't have an account?</span> <a href="javascript:void(0)" id="auth-toggle-link">Sign up</a></p>
      </form>
      <p style="text-align:center;color:var(--text-muted);margin-top:16px;font-size:12px"><a href="#/" style="color:var(--text-muted);text-decoration:underline">Continue without account</a></p>
    </div>`;
  let isSignUp = false;
  const form = el.querySelector('#auth-form'), emailInput = el.querySelector('#auth-email'), passwordInput = el.querySelector('#auth-password');
  const submitBtn = el.querySelector('#auth-submit-btn'), toggleLink = el.querySelector('#auth-toggle-link'), toggleLabel = el.querySelector('#auth-toggle-label');
  const errorEl = el.querySelector('#auth-error'), successEl = el.querySelector('#auth-success');
  function updateMode() { submitBtn.textContent = isSignUp ? 'Sign up' : 'Sign in'; toggleLabel.textContent = isSignUp ? 'Already have an account?' : "Don't have an account?"; toggleLink.textContent = isSignUp ? 'Sign in' : 'Sign up'; passwordInput.autocomplete = isSignUp ? 'new-password' : 'current-password'; errorEl.textContent = ''; successEl.textContent = ''; }
  toggleLink.addEventListener('click', () => { isSignUp = !isSignUp; updateMode(); });
  form.addEventListener('submit', async (e) => { e.preventDefault(); const email = emailInput.value.trim(), password = passwordInput.value; if (!email || !password) return; errorEl.textContent = ''; successEl.textContent = ''; submitBtn.disabled = true; submitBtn.textContent = isSignUp ? 'Signing up...' : 'Signing in...'; try { if (isSignUp) { await signUpWithEmail(email, password); successEl.textContent = 'Check your email to confirm your account, then sign in.'; isSignUp = false; updateMode(); } else { await signInWithEmail(email, password); } } catch (err) { errorEl.textContent = err.message || 'Something went wrong'; } finally { submitBtn.disabled = false; updateMode(); } });
}

function renderSubscriptionPage() {
  const el = document.getElementById('page-subscription');
  if (!el) return;
  el.innerHTML = '<div class="sub-page"><div class="sub-loading"><span class="loading-dot">Loading...</span></div></div>';
  (async () => {
    let sub = { tier: 'free', subscription: null };
    try { sub = await api('/api/pro/subscription'); } catch {}
    const isPro = sub.tier === 'pro';
    const freeFeatures = [{ icon: '💬', label: 'Chat with Any Book', value: '10 / day' },{ icon: '🧠', label: 'Talk to Great Minds', value: '5 / day' },{ icon: '📚', label: 'Personal Library', value: '5 books' },{ icon: '📤', label: 'Upload Your Own Books', value: '3 / day' },{ icon: '🔍', label: 'AI Book Discovery', value: '3 / day' },{ icon: '✨', label: 'Summon Famous Minds', value: '1 / day' },{ icon: '🎭', label: 'Create Mind from Any Source', value: '1 mind' }];
    const proFeatures = [{ icon: '💬', label: 'Chat with Any Book', value: '100 / day' },{ icon: '🧠', label: 'Talk to Great Minds', value: '50 / day' },{ icon: '📚', label: 'Personal Library', value: '50 books' },{ icon: '📤', label: 'Upload Your Own Books', value: '20 / day' },{ icon: '🔍', label: 'AI Book Discovery', value: '30 / day' },{ icon: '✨', label: 'Summon Famous Minds', value: '20 / day' },{ icon: '🎭', label: 'Create Mind from Any Source', value: '20 minds' }];
    const featureRow = (f, isPro) => `<div class="sub-feature-row"><span class="sub-feature-icon">${f.icon}</span><span class="sub-feature-label">${esc(f.label)}</span><span class="sub-feature-value ${isPro ? 'pro-value' : ''}">${esc(f.value)}</span></div>`;
    el.innerHTML = `<div class="sub-page"><div class="sub-header"><h1 class="sub-title">Subscription</h1><p class="sub-subtitle">Read smarter. Think deeper. Learn from the greatest minds in history.</p></div><div class="sub-cards"><div class="sub-card ${!isPro ? 'sub-card-active' : ''}"><div class="sub-card-head"><div class="sub-plan-name"><span>Free</span>${!isPro ? '<span class="sub-badge">Current</span>' : ''}</div><div class="sub-price">$0<span>/mo</span></div><p class="sub-price-note">Experience the core of Feynman</p></div><div class="sub-card-body"><div class="sub-features-title">What's included</div>${freeFeatures.map(f => featureRow(f, false)).join('')}</div>${!isPro ? '<div class="sub-card-foot"><button class="sub-btn sub-btn-secondary" disabled>Current Plan</button></div>' : ''}</div><div class="sub-card sub-card-pro ${isPro ? 'sub-card-active' : ''}"><div class="sub-card-head"><div class="sub-plan-name"><span>Pro</span>${isPro ? '<span class="sub-badge sub-badge-pro">Current</span>' : '<span class="sub-badge sub-badge-pro">Recommended</span>'}</div><div class="sub-price">$10<span>/mo</span></div><p class="sub-price-note">For serious readers and lifelong learners</p></div><div class="sub-card-body"><div class="sub-features-title">Everything in Free, plus</div>${proFeatures.map(f => featureRow(f, true)).join('')}</div><div class="sub-card-foot">${isPro ? `<button class="sub-btn sub-btn-manage" id="sub-manage-btn">Manage Subscription</button>${sub.subscription?.cancel_at_period_end ? '<p class="sub-cancel-note">Cancels at end of billing period</p>' : ''}` : '<button class="sub-btn sub-btn-primary" id="sub-upgrade-btn">Upgrade to Pro</button>'}</div></div></div><div class="sub-explainer"><div class="sub-explainer-title">What can you do with Feynman?</div><div class="sub-explainer-grid"><div class="sub-explainer-item"><div class="sub-explainer-icon">💬</div><div class="sub-explainer-text"><strong>Chat with Books</strong> — Ask questions, get insights, and have deep conversations with any book in your library</div></div><div class="sub-explainer-item"><div class="sub-explainer-icon">🧠</div><div class="sub-explainer-text"><strong>Talk to Great Minds</strong> — Have conversations with AI-powered personas of history's greatest thinkers</div></div><div class="sub-explainer-item"><div class="sub-explainer-icon">🔍</div><div class="sub-explainer-text"><strong>AI Book Discovery</strong> — Describe a topic and let AI find, index, and add relevant books to your library</div></div><div class="sub-explainer-item"><div class="sub-explainer-icon">✨</div><div class="sub-explainer-text"><strong>Summon Famous Minds</strong> — Generate AI personas of well-known thinkers, synthesized from their life's work</div></div><div class="sub-explainer-item"><div class="sub-explainer-icon">🎭</div><div class="sub-explainer-text"><strong>Create Custom Minds</strong> — Build a mind from any source — a Twitter profile, blog, or pasted text</div></div><div class="sub-explainer-item"><div class="sub-explainer-icon">📤</div><div class="sub-explainer-text"><strong>Upload Your Books</strong> — Bring your own PDFs and documents — AI indexes them for instant conversations</div></div></div></div><div class="sub-footer">${currentUser ? `<p class="sub-email">${esc(currentUser.email || '')}</p><button class="sub-signout-btn" onclick="signOut()">Sign Out</button>` : `<button class="sub-btn sub-btn-signin" onclick="window.location.hash='#/login'">Sign in to manage your account</button>`}</div></div>`;
    const upgradeBtn = document.getElementById('sub-upgrade-btn');
    if (upgradeBtn) { upgradeBtn.addEventListener('click', async () => { if (!currentUser) { window.location.hash = '#/login'; return; } upgradeBtn.textContent = 'Redirecting...'; upgradeBtn.disabled = true; try { const data = await api('/api/pro/create-checkout-session', { method: 'POST' }); if (data.url) window.location.href = data.url; } catch (err) { alert('Checkout failed: ' + err.message); upgradeBtn.textContent = 'Upgrade to Pro'; upgradeBtn.disabled = false; } }); }
    const manageBtn = document.getElementById('sub-manage-btn');
    if (manageBtn) { manageBtn.addEventListener('click', async () => { try { const data = await api('/api/pro/create-portal-session', { method: 'POST' }); if (data.url) window.location.href = data.url; } catch (err) { alert('Portal failed: ' + err.message); } }); }
  })();
}

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
  if (hash === '#/landing') return { page: 'landing' };
  if (hash === '#/' || hash === '#') {
    if (!currentUser && window.FEYNMAN_PRO) return { page: 'landing' };
    if (!window.FEYNMAN_PRO && !localStorage.getItem('feynman-landed')) return { page: 'landing' };
    return { page: 'home' };
  }
  if (hash === '#/chat') return { page: 'chat' };
  if (hash === '#/chats') return { page: 'chats' };
  if (hash === '#/library') return { page: 'library' };
  if (hash === '#/minds') return { page: 'minds' };
  if (hash === '#/login') return { page: 'login' };
  if (hash.startsWith('#/subscription')) return { page: 'subscription' };
  const mm = hash.match(/^#\/mind\/(.+)$/);
  if (mm) return { page: 'mind', id: mm[1] };
  const m = hash.match(/^#\/book\/(.+)$/);
  if (m) return { page: 'book', id: m[1] };
  return { page: 'home' };
}

// ─── Landing Page ───
const _LP_COLORS = ['#6d597a','#355070','#264653','#2a9d8f','#e76f51','#b56576','#0077b6','#588157','#9b2226','#457b9d'];
function _lpColor(name) { let h = 0; for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0; return _LP_COLORS[Math.abs(h) % _LP_COLORS.length]; }

const LP_MINDS = [
  { name: 'Aristotle', domain: 'ancient philosophy, logic, ethics, metaphysics, rhetoric' },
  { name: 'Socrates', domain: 'ancient philosophy, ethics, epistemology, dialectic' },
  { name: 'Plato', domain: 'ancient philosophy, metaphysics, political theory, epistemology' },
  { name: 'Marcus Aurelius', domain: 'stoicism, ancient philosophy, ethics, leadership' },
  { name: 'Confucius', domain: 'eastern philosophy, ethics, governance, education' },
  { name: 'Laozi', domain: 'eastern philosophy, Taoism, metaphysics' },
  { name: 'Sun Tzu', domain: 'eastern philosophy, military strategy, leadership, game theory' },
  { name: 'Friedrich Nietzsche', domain: 'modern philosophy, existentialism, ethics, cultural criticism' },
  { name: 'Niccolò Machiavelli', domain: 'political philosophy, statecraft, power, realism' },
  { name: 'Bertrand Russell', domain: 'analytic philosophy, logic, mathematics, social criticism' },
  { name: 'Michel Foucault', domain: 'modern philosophy, power, social theory, knowledge systems' },
  { name: 'Immanuel Kant', domain: 'modern philosophy, epistemology, ethics, metaphysics' },
  { name: 'Richard Feynman', domain: 'physics, quantum mechanics, science education' },
  { name: 'Albert Einstein', domain: 'physics, relativity, philosophy of science' },
  { name: 'Isaac Newton', domain: 'physics, mathematics, classical mechanics, optics' },
  { name: 'Nikola Tesla', domain: 'physics, electrical engineering, invention' },
  { name: 'Stephen Hawking', domain: 'physics, cosmology, science communication' },
  { name: 'John von Neumann', domain: 'mathematics, computer science, game theory, quantum mechanics' },
  { name: 'Charles Darwin', domain: 'biology, evolution, natural history' },
  { name: 'E.O. Wilson', domain: 'biology, sociobiology, ecology, biodiversity' },
  { name: 'Adam Smith', domain: 'economics, free markets, moral philosophy' },
  { name: 'John Maynard Keynes', domain: 'economics, macroeconomics, fiscal policy' },
  { name: 'Charlie Munger', domain: 'investing, mental models, multidisciplinary thinking' },
  { name: 'Warren Buffett', domain: 'investing, value investing, business analysis' },
  { name: 'Ray Dalio', domain: 'investing, macroeconomics, principles, systems thinking' },
  { name: 'Daniel Kahneman', domain: 'cognitive psychology, behavioral economics, decision-making' },
  { name: 'Carl Jung', domain: 'depth psychology, psychoanalysis, mythology, archetypes' },
  { name: 'Sigmund Freud', domain: 'depth psychology, psychoanalysis, unconscious mind' },
  { name: 'Steven Pinker', domain: 'cognitive psychology, linguistics, human nature, rationality' },
  { name: 'Fyodor Dostoevsky', domain: 'literature, existentialism, human nature' },
  { name: 'Leo Tolstoy', domain: 'literature, moral philosophy, pacifism' },
  { name: 'William Shakespeare', domain: 'literature, drama, human nature, language' },
  { name: 'Jorge Luis Borges', domain: 'literature, metaphysics, philosophy of mind' },
  { name: 'Winston Churchill', domain: 'political leadership, history, wartime strategy, rhetoric' },
  { name: 'Leonardo da Vinci', domain: 'art, engineering, anatomy, invention, polymathy' },
  { name: 'Steve Jobs', domain: 'technology, product design, entrepreneurship, innovation' },
  { name: 'Elon Musk', domain: 'technology, engineering, space, first principles thinking' },
  { name: 'Jensen Huang', domain: 'technology, semiconductors, AI, computing' },
  { name: 'Jeff Bezos', domain: 'technology, business strategy, customer obsession, e-commerce' },
  { name: 'Marc Andreessen', domain: 'venture capital, software, startups, techno-optimism' },
  { name: 'Paul Graham', domain: 'startups, programming, essays, venture capital' },
  { name: 'Peter Thiel', domain: 'venture capital, contrarian thinking, startups, monopoly theory' },
  { name: 'Sam Altman', domain: 'AI, startups, technology, venture capital' },
  { name: 'Peter Drucker', domain: 'management, business strategy, leadership, knowledge work' },
  { name: 'Naval Ravikant', domain: 'startups, personal philosophy, wealth, decision-making' },
  { name: 'Nassim Nicholas Taleb', domain: 'risk, probability, antifragility, epistemology' },
  { name: 'Yuval Noah Harari', domain: 'history, futurism, cognitive science, anthropology' },
  { name: 'Jordan Peterson', domain: 'depth psychology, personal development, mythology, cultural criticism' },
  { name: 'Tim Ferriss', domain: 'productivity, self-optimization, entrepreneurship, podcasting' },
  { name: 'James Clear', domain: 'habits, behavioral psychology, productivity, self-improvement' },
  { name: 'Balaji Srinivasan', domain: 'technology, network state, crypto, futurism' },
  { name: 'Tyler Cowen', domain: 'economics, cultural commentary, innovation, blogging' },
].map(m => ({ ...m, color: _lpColor(m.name) }));

let _lpGraphAnim = null;
let _lpGraphSim = null;
let _landingChatTimer = null;

function _stopLandingAnimations() {
  if (_landingChatTimer) { clearTimeout(_landingChatTimer); _landingChatTimer = null; }
  if (_lpSearchTimer) { clearTimeout(_lpSearchTimer); _lpSearchTimer = null; }
  if (_lpGraphAnim) { cancelAnimationFrame(_lpGraphAnim); _lpGraphAnim = null; }
  if (_lpGraphSim) { _lpGraphSim.stop(); _lpGraphSim = null; }
  _lpHighlightQuery = '';
  _lpDiscoverActive = false;
  _lpDiscoverNode = null;
}

function renderLandingPage() {
  const el = document.getElementById('page-landing');
  if (!el) return;
  _stopLandingAnimations();

  const demoScenes = [
    {
      title: 'Thinking, Fast and Slow',
      bookChip: 'Thinking, Fast and Slow',
      messages: [
        { role: 'user', text: 'What are System 1 and System 2?' },
        { role: 'assistant', text: 'System 1 is fast, automatic intuition. System 2 is slow, deliberate thinking. Most decisions start in System 1, but System 2 kicks in for hard problems.', sources: ['Ch.1 Two Systems'] },
        { role: 'user', text: 'How does this affect our decisions?' },
        { role: 'assistant', text: 'System 1 creates cognitive biases — we jump to conclusions, anchor on first impressions, and confuse "easy to recall" with "likely to happen."', sources: ['Ch.12 Anchoring', 'Ch.13 Availability'] },
        { role: 'join', names: ['Richard Feynman'] },
        { role: 'mind', name: 'Richard Feynman', color: '#e76f51', text: 'The first principle is — you must not fool yourself, and you are the easiest person to fool. That\'s exactly the System 1 trap.' },
      ]
    },
    {
      title: 'General Chat',
      messages: [
        { role: 'user', text: 'How should I think about building a startup?' },
        { role: 'assistant', text: 'Find a real problem you understand deeply. Build for a small group who love it, not a large group who merely like it.' },
        { role: 'user', text: 'What about competition?' },
        { role: 'assistant', text: 'The best strategy is often to avoid direct competition entirely — find an underserved niche and dominate it.' },
        { role: 'join', names: ['Paul Graham'] },
        { role: 'mind', name: 'Paul Graham', color: '#588157', text: 'Make something people want. Talk to users, build fast, iterate. Most startups die from building something nobody needs.' },
      ]
    },
    {
      title: 'The Art of War',
      bookChip: 'The Art of War',
      messages: [
        { role: 'user', text: 'What is the supreme art of war?' },
        { role: 'assistant', text: '"To subdue the enemy without fighting." Sun Tzu argues true mastery is winning through strategy, not force.', sources: ['Ch.3 Strategic Attack'] },
        { role: 'user', text: 'How does this apply today?' },
        { role: 'assistant', text: 'In business, it means building advantages that make competition irrelevant — positioning over confrontation.' },
        { role: 'join', names: ['Charlie Munger'] },
        { role: 'mind', name: 'Charlie Munger', color: '#9b2226', text: 'The best competitive advantage avoids competition entirely. Find a niche where you\'re the only one, not the best one.' },
      ]
    },
  ];

  const hour = new Date().getHours();
  const timeGreeting = hour < 12 ? 'Morning' : hour < 18 ? 'Afternoon' : 'Evening';

  el.innerHTML = `
    <div class="lp-container">
      <nav class="lp-topbar">
        <span class="lp-topbar-brand">Feynman</span>
        <div class="lp-topbar-actions">
          <button class="lp-theme-toggle" id="lp-theme-toggle" title="Toggle dark mode">
            <svg class="lp-icon-sun" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
            <svg class="lp-icon-moon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
          </button>
          <button class="lp-topbar-cta" id="lp-get-started">${window.FEYNMAN_PRO ? 'Get Started Free' : 'Start Exploring'}</button>
        </div>
      </nav>

      <section class="lp-fullscreen">
        <div class="lp-bg-canvas" id="lp-minds-canvas-wrap"></div>

        <div class="lp-minds-toolbar">
          <input type="text" id="lp-minds-search" placeholder="Search minds..." autocomplete="off" readonly />
          <button class="lp-minds-toolbar-btn" disabled>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            Invite a Mind
          </button>
          <button class="lp-minds-toolbar-btn" disabled>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z"/><polyline points="14 2 14 8 20 8"/><path d="m10 13 2 2 4-4" stroke-width="2"/></svg>
            Create Your Mind
          </button>
        </div>

        <div class="lp-fg-center">
          <div class="lp-hero-left">
            <h1 class="lp-hero-headline">Chat with books,<br>great minds<br>will join in.</h1>
            <p class="lp-hero-sub">Read the way Feynman did — turn any book into a conversation, explore beyond what's on the page, or start from a topic to discover the right books and build a knowledge system. Relevant great minds join in along the way.</p>
          </div>
          <div class="lp-chat-card">
            <div class="lp-chat-home" id="lp-chat-home">
              <div class="lp-chat-home-inner">
                <div class="greeting-row">
                  <svg class="greeting-logo" width="28" height="28" viewBox="0 0 56 56" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
                    <rect x="24" y="0" width="8" height="4" fill="#FDCB6E"/>
                    <rect x="26" y="4" width="4" height="4" fill="#B8B8B8"/>
                    <rect x="8" y="8" width="40" height="28" fill="#DA7756"/>
                    <rect x="12" y="12" width="32" height="20" fill="#FFF1E0"/>
                    <rect x="16" y="16" width="8" height="8" fill="#2D3436"/>
                    <rect x="32" y="16" width="8" height="8" fill="#2D3436"/>
                    <rect x="18" y="18" width="4" height="4" fill="#fff"/>
                    <rect x="34" y="18" width="4" height="4" fill="#fff"/>
                    <rect x="22" y="28" width="12" height="2" fill="#C45E3E"/>
                    <rect x="18" y="38" width="4" height="8" fill="#B8B8B8"/>
                    <rect x="34" y="38" width="4" height="8" fill="#B8B8B8"/>
                  </svg>
                  <span class="greeting lp-greeting">${timeGreeting}, Steve</span>
                </div>
                <div class="chat-composer lp-composer">
                  <div class="selected-chips" id="lp-selected-chips"></div>
                  <textarea class="composer-input" id="lp-composer-input" rows="1" placeholder="Ask about books or topics — great minds will join in..." readonly></textarea>
                  <div class="composer-toolbar">
                    <div class="composer-left">
                      <button type="button" class="composer-icon-btn" disabled>
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                      </button>
                      <button type="button" class="composer-icon-btn composer-minds-btn" disabled>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="8" cy="18" r="2.5"/><circle cx="18" cy="18" r="2"/><line x1="8.2" y1="7.2" x2="15.8" y2="7.2"/><line x1="7" y1="8.3" x2="7.5" y2="15.5"/><line x1="10.2" y1="17.2" x2="16" y2="17.8"/><line x1="16.5" y1="10.3" x2="17.5" y2="16"/></svg>
                      </button>
                    </div>
                    <button type="button" class="composer-send-btn" disabled>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>
                    </button>
                  </div>
                </div>
                <div class="home-starters lp-starters-compact" id="lp-starters">
                  <button class="starter-pill" disabled>Key ideas in "Thinking, Fast and Slow"?</button>
                  <button class="starter-pill" disabled>Teach me the fundamentals of philosophy</button>
                </div>
              </div>
            </div>

            <div class="lp-chat-active hidden" id="lp-chat-active">
              <div class="lp-chat-messages" id="lp-chat-body"></div>
              <div class="lp-chat-input-area">
                <div class="chat-composer-inline lp-composer" id="lp-bottom-composer">
                  <div class="selected-chips" id="lp-active-chips"></div>
                  <textarea class="composer-input lp-active-textarea" id="lp-active-input" rows="1" placeholder="Ask a follow-up question..." readonly></textarea>
                  <div class="composer-toolbar">
                    <div class="composer-left">
                      <button type="button" class="composer-icon-btn" disabled><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg></button>
                      <button type="button" class="composer-icon-btn composer-minds-btn" disabled><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="8" r="2.5"/><circle cx="8" cy="18" r="2.5"/><circle cx="18" cy="18" r="2"/><line x1="8.2" y1="7.2" x2="15.8" y2="7.2"/><line x1="7" y1="8.3" x2="7.5" y2="15.5"/><line x1="10.2" y1="17.2" x2="16" y2="17.8"/><line x1="16.5" y1="10.3" x2="17.5" y2="16"/></svg></button>
                    </div>
                    <button type="button" class="composer-send-btn" disabled><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg></button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>`;

  document.getElementById('lp-get-started').addEventListener('click', () => {
    if (window.FEYNMAN_PRO) {
      window.location.hash = currentUser ? '#/' : '#/login';
    } else {
      localStorage.setItem('feynman-landed', '1');
      window.location.hash = '#/';
    }
  });

  document.getElementById('lp-theme-toggle').addEventListener('click', () => {
    const isCurrentlyDark = _isDarkMode();
    if (isCurrentlyDark) {
      document.documentElement.classList.add('light');
      document.documentElement.classList.remove('dark');
      localStorage.setItem('feynman-theme', 'light');
    } else {
      document.documentElement.classList.add('dark');
      document.documentElement.classList.remove('light');
      localStorage.setItem('feynman-theme', 'dark');
    }
  });

  _startLandingChatDemo(demoScenes);
  _renderLandingMindsGraph();
  _startLandingSearchDemo();
}

let _lpHighlightQuery = '';
let _lpSearchTimer = null;
let _lpDiscoverActive = false;
let _lpDiscoverNode = null;

function _startLandingSearchDemo() {
  if (_lpSearchTimer) { clearTimeout(_lpSearchTimer); _lpSearchTimer = null; }

  const input = document.getElementById('lp-minds-search');
  if (!input) return;

  function typeTerm(term, cb) {
    input.value = '';
    _lpHighlightQuery = '';
    let i = 0;
    function typeNext() {
      if (i < term.length) {
        i++;
        input.value = term.slice(0, i);
        _lpHighlightQuery = input.value.toLowerCase();
        _lpSearchTimer = setTimeout(typeNext, 80 + Math.random() * 50);
      } else {
        _lpSearchTimer = setTimeout(cb, 1800);
      }
    }
    typeNext();
  }

  function clearTerm(cb) {
    const term = input.value;
    let i = term.length;
    function delNext() {
      if (i > 0) {
        i--;
        input.value = term.slice(0, i);
        _lpHighlightQuery = input.value.toLowerCase();
        _lpSearchTimer = setTimeout(delNext, 30);
      } else {
        _lpHighlightQuery = '';
        _lpSearchTimer = setTimeout(cb, 400);
      }
    }
    delNext();
  }

  const discoverMinds = [
    { name: 'Galileo Galilei', domain: 'physics, astronomy' },
    { name: 'Ada Lovelace', domain: 'mathematics, computing' },
    { name: 'Marie Curie', domain: 'physics, chemistry, radiation' },
  ];
  let discoverIdx = 0;

  function simulateDiscover(cb) {
    const graphNodes = window._lpGraphNodes;
    const graphLinks = window._lpGraphLinks;
    const graphSim = _lpGraphSim;
    const graphParticles = window._lpGraphParticles;
    if (!graphNodes || !graphSim) { _lpSearchTimer = setTimeout(cb, 500); return; }

    const cz = window._lpClearZone;
    const allCandidates = graphNodes.filter(n => !n._isAdd && n.id !== '__lp_discover__');
    const outsideNodes = cz
      ? allCandidates.filter(n => Math.abs(n.x - cz.cx) > cz.hw || Math.abs(n.y - cz.cy) > cz.hh)
      : allCandidates;
    const visibleNodes = outsideNodes.length > 0 ? outsideNodes : allCandidates;
    if (!visibleNodes.length) { _lpSearchTimer = setTimeout(cb, 500); return; }
    const sourceNode = visibleNodes[Math.floor(Math.random() * visibleNodes.length)];

    sourceNode._expanding = true;

    _lpSearchTimer = setTimeout(() => {
      sourceNode._expanding = false;

      const pick = discoverMinds[discoverIdx % discoverMinds.length];
      discoverIdx++;
      const newMind = { name: pick.name, domain: pick.domain, color: _lpColor(pick.name) };
      const ini = newMind.name.split(/\s+/).slice(0, 2).map(w => w[0]).join('');
      const tok = newMind.domain.split(/[,;\/&]+/).map(d => d.trim()).filter(Boolean);

      const existing = graphNodes.find(n => n.id === '__lp_discover__');
      if (existing) {
        existing.name = newMind.name;
        existing.domain = newMind.domain;
        existing.color = newMind.color;
        existing.initials = ini;
        existing.tokens = tok;
        existing._newAt = performance.now();
        existing.x = sourceNode.x + (Math.random() - 0.5) * 50;
        existing.y = sourceNode.y + (Math.random() - 0.5) * 50;
        existing.vx = 0;
        existing.vy = 0;
      } else {
        const dn = {
          id: '__lp_discover__', name: newMind.name, domain: newMind.domain,
          color: newMind.color, initials: ini, tokens: tok,
          _newAt: performance.now(),
          x: sourceNode.x + (Math.random() - 0.5) * 50,
          y: sourceNode.y + (Math.random() - 0.5) * 50,
          vx: 0, vy: 0,
        };
        graphNodes.push(dn);
        const nl = { source: dn, target: sourceNode, strength: 1 };
        graphLinks.push(nl);
        if (graphParticles) {
          graphParticles.push({ link: nl, t: Math.random(), speed: 0.002, size: 1.5, opacity: 0.5 });
        }
        graphSim.nodes(graphNodes);
        graphSim.force('link').links(graphLinks);
      }
      graphSim.alpha(0.15).restart();

      _lpSearchTimer = setTimeout(cb, 5000);
    }, 2000);
  }

  const searchTerms = ['Feynman', 'Munger', 'Socrates', 'Einstein', 'Paul Graham'];
  let termIdx = 0;
  let cycleCount = 0;

  function runCycle() {
    const term = searchTerms[termIdx % searchTerms.length];
    termIdx++;
    cycleCount++;
    typeTerm(term, () => {
      clearTerm(() => {
        if (cycleCount % 2 === 0) {
          simulateDiscover(() => {
            _lpSearchTimer = setTimeout(runCycle, 1500);
          });
        } else {
          _lpSearchTimer = setTimeout(runCycle, 1000);
        }
      });
    });
  }

  _lpSearchTimer = setTimeout(runCycle, 3000);
}

function _renderLandingMindsGraph() {
  const container = document.getElementById('lp-minds-canvas-wrap');
  if (!container) return;

  const minds = LP_MINDS;
  const tokens = m => (m.domain || '').split(/[,;\/&]+/).map(d => d.trim()).filter(Boolean);
  const nodes = minds.map((m, i) => ({
    id: 'lp_' + i, name: m.name, domain: m.domain,
    color: m.color, initials: m.name.split(/\s+/).slice(0, 2).map(w => w[0]).join(''),
    tokens: tokens(m),
  }));
  const links = [];
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const shared = nodes[i].tokens.filter(t => nodes[j].tokens.some(u => t === u || t.includes(u) || u.includes(t)));
      if (shared.length > 0) links.push({ source: nodes[i].id, target: nodes[j].id, strength: shared.length });
    }
  }
  if (!links.length && nodes.length > 1) {
    for (let i = 1; i < nodes.length; i++) links.push({ source: nodes[0].id, target: nodes[i].id, strength: 0.3 });
  }

  const ADD_R = 18;
  const addNode = { id: '__lp_add__', name: '', domain: '', color: 'none', initials: '+', tokens: [], _isAdd: true };
  nodes.push(addNode);

  const dpr = window.devicePixelRatio || 1;
  const W = container.clientWidth || 800;
  const H = container.clientHeight || 560;
  const BASE_R = Math.max(20, Math.min(30, W / (nodes.length * 2)));

  const canvas = document.createElement('canvas');
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const particles = [];
  links.forEach(l => {
    const count = Math.max(1, Math.round(l.strength * 1.5));
    for (let i = 0; i < count; i++) {
      particles.push({ link: l, t: Math.random(), speed: 0.001 + Math.random() * 0.003, size: 1 + Math.random() * 1.5, opacity: 0.3 + Math.random() * 0.5 });
    }
  });

  addNode.x = W / 2 + 160;
  addNode.y = H / 2 - 100;

  window._lpGraphNodes = nodes;
  window._lpGraphLinks = links;
  window._lpGraphParticles = particles;

  const heroW = 300, heroH = 200;
  const heroCx = W * 0.06 + heroW / 2, heroCy = H / 2;
  const heroHalfW = heroW / 2 + 30, heroHalfH = heroH / 2 + 10;

  const cardW = Math.min(620, W * 0.55);
  const cardH = Math.min(520, H - 120);
  const cardCx = W - W * 0.04 - cardW / 2, cardCy = H / 2;
  const cardHalfW = cardW / 2 + 50, cardHalfH = cardH / 2 + 40;

  window._lpClearZone = { cx: cardCx, cy: cardCy, hw: cardHalfW, hh: cardHalfH };

  const clearZones = [
    { cx: heroCx, cy: heroCy, hw: heroHalfW, hh: heroHalfH },
  ];

  function makeAvoidForce() {
    let ns;
    function force() {
      for (const n of ns) {
        if (n._isAdd) continue;
        for (const z of clearZones) {
          const dx = n.x - z.cx, dy = n.y - z.cy;
          const overlapX = z.hw - Math.abs(dx);
          const overlapY = z.hh - Math.abs(dy);
          if (overlapX > 0 && overlapY > 0) {
            if (overlapX < overlapY) {
              const sign = dx >= 0 ? 1 : -1;
              n.vx += sign * overlapX * 0.08;
              n.vx *= 0.85;
            } else {
              const sign = dy >= 0 ? 1 : -1;
              n.vy += sign * overlapY * 0.08;
              n.vy *= 0.85;
            }
          }
        }
      }
    }
    force.initialize = function(n) { ns = n; };
    return force;
  }

  const PAD = BASE_R + 45;
  function makeBoundsForce() {
    let ns;
    function force() {
      for (const n of ns) {
        if (n._isAdd) continue;
        if (n.x < PAD) { n.vx += (PAD - n.x) * 0.1; n.vx *= 0.8; }
        if (n.x > W - PAD) { n.vx += (W - PAD - n.x) * 0.1; n.vx *= 0.8; }
        if (n.y < PAD) { n.vy += (PAD - n.y) * 0.1; n.vy *= 0.8; }
        if (n.y > H - PAD) { n.vy += (H - PAD - n.y) * 0.1; n.vy *= 0.8; }
      }
    }
    force.initialize = function(n) { ns = n; };
    return force;
  }

  const graphCx = W * 0.55;
  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(d => Math.max(80, 280 - d.strength * 70)).strength(d => 0.08 + d.strength * 0.15))
    .force('charge', d3.forceManyBody().strength(-600).distanceMax(800))
    .force('center', d3.forceCenter(graphCx, H / 2).strength(0.02))
    .force('collision', d3.forceCollide().radius(d => d._isAdd ? ADD_R + 15 : BASE_R + 20))
    .force('x', d3.forceX(graphCx).strength(0.01))
    .force('y', d3.forceY(H / 2).strength(0.01))
    .force('avoid', makeAvoidForce())
    .force('bounds', makeBoundsForce())
    .alphaDecay(0.03)
    .velocityDecay(0.35);
  _lpGraphSim = sim;

  let hoveredNode = null;
  let mousePos = null;
  canvas.addEventListener('mousemove', e => {
    const rect = canvas.getBoundingClientRect();
    const mx = e.clientX - rect.left, my = e.clientY - rect.top;
    mousePos = [mx, my];
    hoveredNode = null;
    for (const n of nodes) {
      let hr = n._isAdd ? ADD_R + 5 : BASE_R + 5;
      if (Math.hypot(n.x - mx, n.y - my) < hr) { hoveredNode = n; break; }
    }
    canvas.style.cursor = hoveredNode ? 'pointer' : 'default';
  });
  canvas.addEventListener('mouseleave', () => { hoveredNode = null; mousePos = null; });

  function draw() {
    const now = performance.now();
    ctx.save();
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--canvas-bg').trim() || '#ffffff';
    ctx.fillRect(0, 0, W, H);

    const q = _lpHighlightQuery;
    const matchIds = new Set();
    if (q) {
      nodes.forEach(n => {
        if (n.name.toLowerCase().includes(q)) matchIds.add(n.id);
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
      ctx.arc(px, py, p.size, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(130,150,200,${p.opacity * 0.45})`;
      ctx.fill();
    }

    if (hoveredNode !== addNode) {
      let cx = 0, cy = 0, cnt = 0;
      for (const n of nodes) { if (!n._isAdd) { cx += n.x; cy += n.y; cnt++; } }
      if (cnt) {
        cx /= cnt; cy /= cnt;
        let maxD = 0;
        for (const n of nodes) { if (!n._isAdd) { const d = Math.hypot(n.x - cx, n.y - cy); if (d > maxD) maxD = d; } }
        const a = now * 0.00015;
        addNode.x = cx + Math.cos(a) * (maxD + BASE_R * 3.5);
        addNode.y = cy + Math.sin(a) * (maxD + BASE_R * 3.5);
      }
    }

    for (const n of nodes) {
      if (n._isAdd) {
        const hov = hoveredNode === n;
        const busy = _lpDiscoverActive;
        const pulse = 1 + Math.sin(now * 0.003) * 0.08;
        const ar = ADD_R * pulse;
        const glow = ctx.createRadialGradient(n.x, n.y, ar * 0.3, n.x, n.y, ar * 2.5);
        glow.addColorStop(0, `rgba(100,130,200,${hov ? 0.12 : 0.04})`);
        glow.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.beginPath(); ctx.arc(n.x, n.y, ar * 2.5, 0, Math.PI * 2);
        ctx.fillStyle = glow; ctx.fill();

        ctx.beginPath(); ctx.arc(n.x, n.y, ar, 0, Math.PI * 2);
        ctx.fillStyle = busy ? 'rgba(90,120,180,0.15)' : 'rgba(140,160,200,0.08)';
        ctx.fill();
        ctx.setLineDash([3, 3]);
        ctx.strokeStyle = `rgba(100,130,180,${busy || hov ? 0.6 : 0.25})`;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.fillStyle = `rgba(80,110,170,${busy || hov ? 0.8 : 0.45})`;
        ctx.font = `300 ${ar * 1.1}px Inter, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(busy ? '…' : '+', n.x, n.y + 1);

        if (!busy) {
          ctx.fillStyle = `rgba(80,110,170,${hov ? 0.6 : 0.3})`;
          ctx.font = '500 9px Inter, sans-serif';
          ctx.fillText('Discover', n.x, n.y + ar + 13);
        } else {
          ctx.fillStyle = 'rgba(80,110,170,0.4)';
          ctx.font = '500 9px Inter, sans-serif';
          const dots = '.'.repeat(Math.floor(now / 500) % 4);
          ctx.fillText('Discovering' + dots, n.x, n.y + ar + 13);
        }
        continue;
      }

      const dimmed = filtering && !matchIds.has(n.id);
      const hovered = hoveredNode === n;
      const highlighted = filtering && matchIds.has(n.id);

      let r = BASE_R;
      if (mousePos) {
        const dx = n.x - mousePos[0], dy = n.y - mousePos[1];
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
      const pulse = 1 + Math.sin(now * 0.002 + n.name.length) * 0.04;
      const rr = r * pulse;
      const [cr, cg, cb] = _hexToRgb(n.color);
      const nodeAlpha = dimmed ? 0.12 : 1;

      if (!dimmed) {
        const glowR = rr * 2.5;
        const grad = ctx.createRadialGradient(n.x, n.y, rr * 0.5, n.x, n.y, glowR);
        grad.addColorStop(0, `rgba(${cr},${cg},${cb},${hovered ? 0.15 : 0.05})`);
        grad.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.beginPath(); ctx.arc(n.x, n.y, glowR, 0, Math.PI * 2);
        ctx.fillStyle = grad; ctx.fill();
      }

      if (n._newAt) {
        const age = (now - n._newAt) / 1000;
        if (age < 12) {
          const fade = Math.max(0, 1 - age / 12);
          const ring = 1 + Math.sin(now * 0.004) * 0.5;
          const outerR = rr + 12 + ring * 10;
          const glowG = ctx.createRadialGradient(n.x, n.y, rr * 0.5, n.x, n.y, outerR);
          glowG.addColorStop(0, `rgba(34,197,94,${fade * 0.25})`);
          glowG.addColorStop(0.6, `rgba(34,197,94,${fade * 0.08})`);
          glowG.addColorStop(1, 'rgba(34,197,94,0)');
          ctx.beginPath(); ctx.arc(n.x, n.y, outerR, 0, Math.PI * 2);
          ctx.fillStyle = glowG; ctx.fill();
          ctx.beginPath(); ctx.arc(n.x, n.y, rr + 4 + ring * 3, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(34,197,94,${fade * 0.8})`;
          ctx.lineWidth = 2.5; ctx.stroke();
          const badgeY = n.y - rr - 16;
          ctx.beginPath(); ctx.roundRect(n.x - 16, badgeY - 8, 32, 16, 8);
          ctx.fillStyle = `rgba(34,197,94,${fade * 0.9})`; ctx.fill();
          ctx.fillStyle = `rgba(255,255,255,${fade * 0.95})`;
          ctx.font = '700 9px Inter, sans-serif';
          ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
          ctx.fillText('NEW', n.x, badgeY);
        } else {
          delete n._newAt;
        }
      }

      if (n._expanding) {
        const spinAngle = (now * 0.003) % (Math.PI * 2);
        const spinR = rr + 10;
        ctx.beginPath();
        ctx.arc(n.x, n.y, spinR, spinAngle, spinAngle + Math.PI * 1.2);
        ctx.strokeStyle = `rgba(${cr},${cg},${cb},0.7)`;
        ctx.lineWidth = 2.5;
        ctx.stroke();
      }

      if (highlighted || hovered) {
        ctx.beginPath(); ctx.arc(n.x, n.y, rr + 3, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(${cr},${cg},${cb},${hovered ? 0.5 : 0.3})`;
        ctx.lineWidth = 2; ctx.stroke();
      }

      ctx.beginPath(); ctx.arc(n.x, n.y, rr, 0, Math.PI * 2);
      ctx.fillStyle = dimmed ? `rgba(${cr},${cg},${cb},${nodeAlpha})` : n.color;
      ctx.fill();
      const dk = _isDarkMode();
      ctx.strokeStyle = dimmed ? (dk ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)') : 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      if (!dimmed) {
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.font = `700 ${rr * 0.6}px Inter, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(n.initials, n.x, n.y);

        ctx.fillStyle = dk ? `rgba(245,245,247,${hovered ? 0.95 : 0.8})` : `rgba(30,35,50,${hovered ? 0.9 : 0.7})`;
        ctx.font = `600 ${hovered ? 12 : 11}px 'Libre Baskerville', Georgia, serif`;
        ctx.fillText(n.name, n.x, n.y + rr + 14);

        ctx.fillStyle = dk ? 'rgba(200,200,210,0.6)' : 'rgba(100,110,130,0.6)';
        ctx.font = '400 9px Inter, sans-serif';
        const domainLabel = n.domain.length > 30 ? n.domain.slice(0, 28) + '…' : n.domain;
        ctx.fillText(domainLabel, n.x, n.y + rr + 27);
      }
    }

    ctx.restore();
    _lpGraphAnim = requestAnimationFrame(draw);
  }

  sim.on('tick', () => {});
  _lpGraphAnim = requestAnimationFrame(draw);
}

function _startLandingChatDemo(scenes) {
  if (_landingChatTimer) { clearTimeout(_landingChatTimer); _landingChatTimer = null; }

  const homeEl = document.getElementById('lp-chat-home');
  const activeEl = document.getElementById('lp-chat-active');
  const bodyEl = document.getElementById('lp-chat-body');
  const homeInputEl = document.getElementById('lp-composer-input');
  const activeChipsEl = document.getElementById('lp-active-chips');
  const startersEl = document.getElementById('lp-starters');
  if (!bodyEl || !homeEl || !activeEl) return;

  let sceneIdx = 0;

  function _animateIn(el) {
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    requestAnimationFrame(() => {
      el.style.transition = 'opacity 0.3s, transform 0.3s';
      el.style.opacity = '1';
      el.style.transform = 'translateY(0)';
    });
  }

  function _typeText(container, el, text, cb) {
    let i = 0;
    function tick() {
      if (i < text.length) {
        el.textContent += text.slice(i, i + 2);
        i += 2;
        container.scrollTop = container.scrollHeight;
        _landingChatTimer = setTimeout(tick, 18);
      } else {
        if (cb) _landingChatTimer = setTimeout(cb, 1000);
      }
    }
    _landingChatTimer = setTimeout(tick, 250);
  }

  function _typeInput(text, cb) {
    if (!homeInputEl) { if (cb) cb(); return; }
    homeInputEl.value = '';
    let i = 0;
    function tick() {
      if (i < text.length) {
        i++;
        homeInputEl.value = text.slice(0, i);
        _landingChatTimer = setTimeout(tick, 40 + Math.random() * 30);
      } else {
        _landingChatTimer = setTimeout(() => {
          homeInputEl.value = '';
          if (cb) cb();
        }, 400);
      }
    }
    _landingChatTimer = setTimeout(tick, 300);
  }

  function _mindAvatar(name, color) {
    const ini = name.split(/\s+/).slice(0, 2).map(w => w[0]).join('');
    return `<span class="lp-mn-avatar" style="background:${color}">${ini}</span>`;
  }

  function switchToChat(scene) {
    homeEl.classList.add('hidden');
    activeEl.classList.remove('hidden');
    if (activeChipsEl) {
      activeChipsEl.innerHTML = scene.bookChip
        ? `<div class="book-chip"><span>${esc(scene.bookChip)}</span></div>`
        : '';
    }
  }

  function switchToHome() {
    activeEl.classList.add('hidden');
    homeEl.classList.remove('hidden');
    bodyEl.innerHTML = '';
    if (activeChipsEl) activeChipsEl.innerHTML = '';
  }

  function playScene() {
    const scene = scenes[sceneIdx % scenes.length];
    sceneIdx++;

    bodyEl.innerHTML = '';
    if (startersEl) startersEl.style.display = 'none';

    const firstUserMsg = scene.messages.find(m => m.role === 'user');
    if (!firstUserMsg) { switchToChat(scene); startMessages(scene, 0); return; }

    _typeInput(firstUserMsg.text, () => {
      switchToChat(scene);
      const div = document.createElement('div');
      div.className = 'lp-msg lp-msg-user';
      div.textContent = firstUserMsg.text;
      _animateIn(div);
      bodyEl.appendChild(div);
      bodyEl.scrollTop = bodyEl.scrollHeight;
      _landingChatTimer = setTimeout(() => startMessages(scene, 1), 800);
    });
  }

  function startMessages(scene, fromIdx) {
    let msgIdx = fromIdx;

    function showNext() {
      if (msgIdx >= scene.messages.length) {
        _landingChatTimer = setTimeout(() => {
          activeEl.style.opacity = '0';
          setTimeout(() => {
            activeEl.style.opacity = '1';
            switchToHome();
            if (startersEl) startersEl.style.display = '';
            playScene();
          }, 400);
        }, 3500);
        return;
      }

      const msg = scene.messages[msgIdx];
      msgIdx++;

      if (msg.role === 'user') {
        const div = document.createElement('div');
        div.className = 'lp-msg lp-msg-user';
        div.textContent = msg.text;
        _animateIn(div);
        bodyEl.appendChild(div);
        bodyEl.scrollTop = bodyEl.scrollHeight;
        _landingChatTimer = setTimeout(showNext, 800);

      } else if (msg.role === 'assistant') {
        const div = document.createElement('div');
        div.className = 'lp-msg lp-msg-assistant';
        const textSpan = document.createElement('span');
        div.appendChild(textSpan);
        _animateIn(div);
        bodyEl.appendChild(div);
        _typeText(bodyEl, textSpan, msg.text, () => {
          if (msg.sources) {
            const srcEl = document.createElement('div');
            srcEl.className = 'lp-msg-sources';
            srcEl.innerHTML = msg.sources.map(s => `<span class="lp-source-tag">${esc(s)}</span>`).join('');
            _animateIn(srcEl);
            div.appendChild(srcEl);
            bodyEl.scrollTop = bodyEl.scrollHeight;
          }
          _landingChatTimer = setTimeout(showNext, 1000);
        });

      } else if (msg.role === 'loading') {
        const div = document.createElement('div');
        div.className = 'lp-system-notice';
        div.innerHTML = `<span class="loading-dot">${esc(msg.text)}</span>`;
        _animateIn(div);
        bodyEl.appendChild(div);
        bodyEl.scrollTop = bodyEl.scrollHeight;
        _landingChatTimer = setTimeout(() => {
          div.remove();
          showNext();
        }, 1500);

      } else if (msg.role === 'join') {
        const div = document.createElement('div');
        div.className = 'lp-system-notice';
        const colors = { 'Richard Feynman': '#e76f51', 'Charlie Munger': '#9b2226', 'Paul Graham': '#588157', 'Elon Musk': '#0077b6', 'Albert Einstein': '#457b9d', 'Socrates': '#264653' };
        const avatars = msg.names.map(n => _mindAvatar(n, colors[n] || '#6d597a')).join('');
        const label = msg.names.length === 1 ? msg.names[0] : msg.names.slice(0, -1).join(', ') + ' and ' + msg.names[msg.names.length - 1];
        div.innerHTML = `<div class="lp-join-inner">${avatars}<span>${esc(label)} joined the discussion</span></div>`;
        _animateIn(div);
        bodyEl.appendChild(div);
        bodyEl.scrollTop = bodyEl.scrollHeight;
        _landingChatTimer = setTimeout(showNext, 800);

      } else if (msg.role === 'mind') {
        const div = document.createElement('div');
        div.className = 'lp-msg lp-msg-mind';
        div.innerHTML = `<div class="lp-mind-header">${_mindAvatar(msg.name, msg.color)}<span class="lp-mn-name">${esc(msg.name)}</span></div><div class="lp-mind-body"></div>`;
        _animateIn(div);
        bodyEl.appendChild(div);
        const bodyDiv = div.querySelector('.lp-mind-body');
        _typeText(bodyEl, bodyDiv, msg.text, () => {
          _landingChatTimer = setTimeout(showNext, 1000);
        });
      }
    }

    showNext();
  }

  playScene();
}

function navigate() {
  const route = getRoute();
  document.querySelectorAll('.page-view').forEach(el => el.classList.add('hidden'));
  const el = document.getElementById('page-' + route.page);
  if (el) el.classList.remove('hidden');

  const appLayout = document.getElementById('app-layout');
  if (route.page === 'landing') {
    appLayout.classList.add('landing-active');
  } else {
    appLayout.classList.remove('landing-active');
  }

  switch (route.page) {
    case 'landing':
      renderLandingPage();
      break;
    case 'home':
      _stopLandingAnimations();
      renderHome();
      renderSelectedChips();
      break;
    case 'chat': onChatPageShow(); break;
    case 'chats': renderChatsPage(); break;
    case 'library': renderLibrary(); break;
    case 'minds': renderMindsPage(); break;
    case 'login': renderLoginPage(); break;
    case 'subscription': renderSubscriptionPage(); break;
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
  if (authToken) {
    opts.headers = { ...(opts.headers || {}), 'Authorization': 'Bearer ' + authToken };
  }
  const r = await fetch(path, opts);
  const d = await r.json();
  if (r.status === 429 && d.detail?.code === 'quota_exceeded') {
    showUpgradeModal(d.detail);
    throw new Error(d.detail.message || 'Quota exceeded');
  }
  if (r.status === 401 && d.code === 'auth_required' && window.FEYNMAN_PRO) {
    window.location.hash = '#/login';
    throw new Error('Please sign in to continue');
  }
  if (!r.ok) throw new Error(d.detail || (typeof d.detail === 'object' ? d.detail.message : '') || 'Request failed');
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

function appendMindMsg(container, mindName, text) {
  const el = document.createElement('div');
  el.className = 'chat-message mind-message';
  el.dataset.raw = text;
  el.dataset.mindName = mindName;
  const color = mindColor(mindName);
  const initials = mindInitials(mindName);
  const header = document.createElement('div');
  header.className = 'mind-msg-header';
  header.innerHTML = `<div class="mind-msg-avatar" style="background:${color}">${initials}</div><span class="mind-msg-name">${esc(mindName)}</span>`;
  el.appendChild(header);
  const content = document.createElement('div');
  content.className = 'msg-content mind-msg-content';
  content.innerHTML = renderMarkdown(text);
  el.appendChild(content);
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function appendJoinNotice(container, mindNames) {
  const el = document.createElement('div');
  el.className = 'chat-system-notice mind-join-notice';
  const avatars = mindNames.map(n => {
    const c = mindColor(n); const i = mindInitials(n);
    return `<span class="join-avatar" style="background:${c}">${i}</span>`;
  }).join('');
  const names = mindNames.length === 1 ? mindNames[0]
    : mindNames.slice(0, -1).join(', ') + ' and ' + mindNames[mindNames.length - 1];
  el.innerHTML = `<div class="join-notice-inner">${avatars}<span>${esc(names)} joined the discussion</span></div>`;
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function showMindsLoading(c) {
  let el = document.getElementById('minds-loading-msg');
  if (el) return;
  el = document.createElement('div');
  el.className = 'chat-system-notice minds-loading-notice';
  el.id = 'minds-loading-msg';
  el.innerHTML = '<div class="join-notice-inner"><span class="loading-dot">Inviting great minds to share their perspectives...</span></div>';
  c.appendChild(el);
  c.scrollTop = c.scrollHeight;
}
function removeMindsLoading() { document.getElementById('minds-loading-msg')?.remove(); }

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
      activeMinds: s.activeMinds instanceof Map ? [...s.activeMinds.entries()] : [],
      updatedAt: s.updatedAt || 0,
      ...(s.mindId ? { mindId: s.mindId } : {}),
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
      activeMinds: new Map(s.activeMinds || []),
      updatedAt: migrated ? (s.updatedAt || 0) : 0,
      mindId: s.mindId || null,
    }));
    if (!migrated) localStorage.setItem('ts_migrated', '1');
    sessionCounter = parseInt(localStorage.getItem('sessionCounter') || '0', 10);
    currentSessionId = localStorage.getItem('currentSessionId') || null;
  } catch {}
}

function createSession() {
  saveCurrentSession();
  const id = 's-' + (++sessionCounter);
  const session = { id, title: 'New chat', messages: [], books: new Map(), activeMinds: new Map(), updatedAt: Date.now() };
  chatSessions.unshift(session);
  currentSessionId = id;
  activeMinds.clear();
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

  if (session.mindId) {
    const mindPage = document.getElementById('page-mind');
    const chatBox = document.getElementById('mind-chat-messages');
    if (chatBox && mindPage && !mindPage.classList.contains('hidden')) _saveMindSession(chatBox);
    return;
  }

  const msgs = [];
  document.querySelectorAll('#chat-messages .chat-message:not(#loading-msg):not(.minds-loading-notice), #chat-messages .mind-join-notice').forEach(el => {
    if (el.classList.contains('mind-join-notice')) {
      const names = [...el.querySelectorAll('.join-avatar')].map(a => a.textContent);
      const fullNames = el.querySelector('span:last-child')?.textContent?.replace(' joined the discussion', '') || '';
      msgs.push({ role: 'system-notice', content: '', mindNames: fullNames.split(/ and |, /).map(s => s.trim()).filter(Boolean) });
    } else if (el.classList.contains('mind-message')) {
      msgs.push({ role: 'mind', content: el.dataset.raw || '', mindName: el.dataset.mindName || '' });
    } else {
      const role = el.classList.contains('user') ? 'user' : 'assistant';
      const msg = { role, content: el.dataset.raw || el.textContent };
      if (el.dataset.sources) try { msg.sources = JSON.parse(el.dataset.sources); } catch {}
      if (el.dataset.opts) try { msg.opts = JSON.parse(el.dataset.opts); } catch {}
      msgs.push(msg);
    }
  });
  session.messages = msgs;
  session.books = new Map(selectedBooks);
  session.minds = new Map(selectedMinds);
  session.activeMinds = new Map(activeMinds);
  if (msgs.length) session.updatedAt = Date.now();
}

function switchToSession(id) {
  if (id === currentSessionId) return;
  saveCurrentSession();
  const session = chatSessions.find(s => s.id === id);
  if (!session) return;
  currentSessionId = id;

  if (session.mindId) {
    window.location.hash = '#/mind/' + session.mindId;
    return;
  }

  selectedBooks = new Map(session.books);
  selectedMinds = new Map(session.minds || []);
  activeMinds = new Map(session.activeMinds || []);
  const chatBox = document.getElementById('chat-messages');
  chatBox.innerHTML = '';
  for (const m of session.messages) {
    if (m.role === 'mind') {
      appendMindMsg(chatBox, m.mindName, m.content);
    } else if (m.role === 'system-notice') {
      appendJoinNotice(chatBox, m.mindNames || []);
    } else {
      appendMsg(chatBox, m.role, m.content, m.sources, m.opts);
    }
  }
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
  const chatIcon = `<svg class="chat-item-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>`;
  const mindIcon = `<svg class="chat-item-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="6" cy="6" r="3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="18" r="3"/><line x1="9" y1="6" x2="15" y2="6"/><line x1="6" y1="9" x2="6" y2="15"/><line x1="18" y1="9" x2="18" y2="15"/><line x1="9" y1="18" x2="15" y2="18"/><line x1="9" y1="8" x2="15" y2="16"/></svg>`;
  listEl.innerHTML = sessions.map(s =>
    `<div class="chats-list-item" data-sid="${s.id}">
      ${s.mindId ? mindIcon : chatIcon}
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

    _inviteMindsToChat(chatBox, message, bookContext, agentIds);
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

async function _inviteMindsToChat(chatBox, message, bookContext, agentIds) {
  try {
    const mindIds = [...activeMinds.keys()];
    for (const [id] of selectedMinds) {
      if (!mindIds.includes(id)) mindIds.push(id);
    }

    const allKnownNames = [...activeMinds.values(), ...selectedMinds.values()].map(m => m.name);
    const suggestBody = { count: 3, exclude: allKnownNames };
    if (bookContext && bookContext.length) {
      suggestBody.book_title = bookContext[0].title;
      suggestBody.book_author = bookContext[0].author || '';
    } else {
      suggestBody.topic = message.slice(0, 100);
    }

    showMindsLoading(chatBox);

    const newJoinedNames = [];
    for (const [id, m] of selectedMinds) {
      if (!activeMinds.has(id)) {
        activeMinds.set(id, m);
        newJoinedNames.push(m.name);
      }
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
          if (!mindIds.includes(mind.id)) {
            mindIds.push(mind.id);
            if (!activeMinds.has(mind.id)) {
              activeMinds.set(mind.id, { id: mind.id, name: mind.name });
              newJoinedNames.push(mind.name);
            }
          }
        } catch { /* skip */ }
      }
    } catch { /* suggestion failed, proceed with existing */ }

    removeMindsLoading();

    if (!mindIds.length) return;

    for (const name of newJoinedNames) {
      appendJoinNotice(chatBox, [name]);
    }

    const history = [];
    chatBox.querySelectorAll('.chat-message:not(#loading-msg):not(.minds-loading-notice)').forEach(el => {
      if (el.classList.contains('mind-message')) {
        history.push({ role: 'assistant', content: `[${el.dataset.mindName}]: ${el.dataset.raw}` });
      } else {
        const role = el.classList.contains('user') ? 'user' : 'assistant';
        history.push({ role, content: el.dataset.raw || el.textContent });
      }
    });

    const panelBody = { message, mind_ids: mindIds, history };
    if (bookContext?.length) panelBody.book_context = bookContext;
    if (agentIds?.length) panelBody.agent_ids = agentIds;

    const panelData = await api('/api/minds/panel-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(panelBody),
    });

    if (panelData.responses?.length) {
      for (const r of panelData.responses) {
        if (r.response && !r.response.startsWith('[')) {
          appendMindMsg(chatBox, r.mind_name, r.response);
        }
      }
      loadMinds();
    }
    _saveMindSession(chatBox);
  } catch (err) {
    removeMindsLoading();
    console.log('Mind chat failed:', err.message);
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
    homeInput.placeholder = (selectedBooks.size || selectedMinds.size) ? 'Ask your question...' : 'Chat with books and great minds — ask anything...';
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
  activeMinds.clear();
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
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--canvas-bg').trim() || '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.k, transform.k);

    const matchIds = new Set();
    if (state.highlightQuery) {
      const q = state.highlightQuery.toLowerCase();
      nodes.forEach(n => {
        if (n.name.toLowerCase().includes(q)) matchIds.add(n.id);
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
      const dk = _isDarkMode();
      ctx.strokeStyle = dimmed ? (dk ? 'rgba(255,255,255,0.03)' : 'rgba(0,0,0,0.03)') : 'rgba(255,255,255,0.25)';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      if (!dimmed) {
        ctx.fillStyle = 'rgba(255,255,255,0.95)';
        ctx.font = `700 ${rr * 0.6}px Inter, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(n.initials, n.x, n.y);

        ctx.fillStyle = dk ? `rgba(245,245,247,${hovered ? 0.95 : 0.8})` : `rgba(30,35,50,${hovered ? 0.9 : 0.7})`;
        ctx.font = `600 ${hovered ? 12 : 11}px 'Libre Baskerville', Georgia, serif`;
        ctx.fillText(n.name, n.x, n.y + rr + 14);

        ctx.fillStyle = dk ? 'rgba(200,200,210,0.6)' : 'rgba(100,110,130,0.6)';
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
  let _hideTimer = null;

  function _cancelHideTimer() { if (_hideTimer) { clearTimeout(_hideTimer); _hideTimer = null; } }

  tooltip.addEventListener('mouseenter', () => { _tooltipInside = true; _cancelHideTimer(); });
  tooltip.addEventListener('mouseleave', () => {
    _tooltipInside = false;
    _hideTimer = setTimeout(() => {
      if (!_tooltipInside) {
        _tooltipNode = null;
        state.hoveredNode = null;
        tooltip.classList.add('hidden');
      }
    }, 100);
  });

  function _showTooltip(n, anchorX, anchorY) {
    _cancelHideTimer();
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
    _cancelHideTimer();
    _hideTimer = setTimeout(() => {
      if (!_tooltipInside) {
        _tooltipNode = null;
        tooltip.classList.add('hidden');
      }
    }, 200);
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
  saveCurrentSession();
  const chatBox = document.getElementById('mind-chat-messages');
  const metaSidebar = document.getElementById('mind-meta-sidebar');
  chatBox.innerHTML = '';
  mindChatHistory = [];
  activeMinds.clear();

  let mind = allMinds.find(m => m.id === mindId);
  if (!mind) {
    try { mind = await api('/api/minds/' + mindId); } catch {}
  }
  if (!mind) {
    metaSidebar.innerHTML = '<p style="padding:20px;color:var(--text-muted)">Mind not found</p>';
    return;
  }

  const existingSession = chatSessions.find(s => s.mindId === mindId);
  if (existingSession) {
    currentSessionId = existingSession.id;
    activeMinds = new Map(existingSession.activeMinds || []);
    for (const m of existingSession.messages) {
      if (m.role === 'mind') {
        appendMindMsg(chatBox, m.mindName, m.content);
        mindChatHistory.push({ role: 'assistant', content: `[${m.mindName}]: ${m.content}` });
      } else if (m.role === 'system-notice') {
        appendJoinNotice(chatBox, m.mindNames || []);
      } else if (m.role === 'user') {
        appendMsg(chatBox, 'user', m.content);
        mindChatHistory.push({ role: 'user', content: m.content });
      } else {
        appendMsg(chatBox, m.role, m.content, m.sources, m.opts);
        mindChatHistory.push({ role: m.role, content: m.content });
      }
    }
  } else {
    saveCurrentSession();
    const id = 's-' + (++sessionCounter);
    const session = { id, title: `Chat with ${mind.name}`, messages: [], books: new Map(), activeMinds: new Map(), mindId, updatedAt: Date.now() };
    chatSessions.unshift(session);
    currentSessionId = id;
    renderChatHistory();
    persistSessions();
  }

  const color = mindColor(mind.name);
  const initials = mindInitials(mind.name);
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

  const bookContext = [];
  const agentIds = [];
  if (selectedBooks.size) {
    body.book_context = [...selectedBooks.values()].map(b => ({ title: b.title, author: b.author || '' }));
    body.agent_ids = [...selectedBooks.values()].map(b => b.agentId);
    bookContext.push(...body.book_context);
    agentIds.push(...body.agent_ids);
  }

  try {
    const data = await api('/api/minds/' + mindId + '/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    removeLoading();

    const mind = allMinds.find(m => m.id === mindId);
    const mindName = mind?.name || 'Mind';
    appendMindMsg(chatBox, mindName, data.response);

    mindChatHistory.push({ role: 'user', content: message });
    mindChatHistory.push({ role: 'assistant', content: `[${mindName}]: ${data.response}` });

    if (!activeMinds.has(mindId) && mind) {
      activeMinds.set(mindId, { id: mindId, name: mind.name });
    }

    _saveMindSession(chatBox);
    _inviteMindsToChat(chatBox, message, bookContext, agentIds);
  } catch (err) {
    removeLoading();
    appendMsg(chatBox, 'assistant', 'Error: ' + err.message);
  }
}

let _mindSaving = false;
function _saveMindSession(chatBox) {
  if (_mindSaving) return;
  if (!currentSessionId) return;
  const session = chatSessions.find(s => s.id === currentSessionId);
  if (!session) return;
  const msgs = [];
  chatBox.querySelectorAll('.chat-message:not(#loading-msg):not(.minds-loading-notice), .mind-join-notice').forEach(el => {
    if (el.classList.contains('mind-join-notice')) {
      const fullNames = el.querySelector('span:last-child')?.textContent?.replace(' joined the discussion', '') || '';
      msgs.push({ role: 'system-notice', content: '', mindNames: fullNames.split(/ and |, /).map(s => s.trim()).filter(Boolean) });
    } else if (el.classList.contains('mind-message')) {
      msgs.push({ role: 'mind', content: el.dataset.raw || '', mindName: el.dataset.mindName || '' });
    } else {
      const role = el.classList.contains('user') ? 'user' : 'assistant';
      msgs.push({ role, content: el.dataset.raw || el.textContent });
    }
  });
  session.messages = msgs;
  session.activeMinds = new Map(activeMinds);
  session.updatedAt = Date.now();
  _mindSaving = true;
  persistSessions();
  _mindSaving = false;
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
      <textarea id="create-mind-content" placeholder="Or paste text content here — tweets, blog posts, notes, markdown..." rows="5" style="margin-top:8px;width:100%;resize:vertical;font-family:inherit;font-size:13px;padding:10px 12px;border-radius:10px;border:1px solid var(--border-strong);background:var(--bg-chat);color:var(--text)"></textarea>
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
/* renderPerspectives removed — minds now render inline as chat messages */

// ─── Init ───
function initTheme() {
  const saved = localStorage.getItem('feynman-theme');
  if (saved === 'dark') {
    document.documentElement.classList.add('dark');
    document.documentElement.classList.remove('light');
  } else if (saved === 'light') {
    document.documentElement.classList.add('light');
    document.documentElement.classList.remove('dark');
  }
}

async function init() {
  initTheme();
  await loadProConfig();
  if (window.FEYNMAN_PRO) await initSupabase();
  await Promise.all([loadAgents(), loadVotes(), loadTopics(), loadMinds()]);
  buildBookList();
  restoreSessions();
  renderChatHistory();
  updateAuthUI();

  document.getElementById('app-layout').classList.add('sidebar-collapsed');

  // Sidebar toggle
  document.getElementById('sidebar-toggle-btn').addEventListener('click', toggleSidebar);
  document.getElementById('sidebar-float-btn').addEventListener('click', toggleSidebar);

  document.getElementById('sidebar-theme-toggle').addEventListener('click', () => {
    const isDark = document.documentElement.classList.toggle('dark');
    document.documentElement.classList.toggle('light', !isDark);
    localStorage.setItem('feynman-theme', isDark ? 'dark' : 'light');
  });

  // Chats page
  document.getElementById('chats-search').addEventListener('input', e => {
    _renderChatsList(e.target.value.trim().toLowerCase());
  });
  document.getElementById('chats-new-btn').addEventListener('click', () => {
    saveCurrentSession();
    currentSessionId = null;
    selectedBooks.clear();
    selectedMinds.clear();
    activeMinds.clear();
    window.location.hash = '#/';
  });

  // New Chat → go to homepage
  document.getElementById('new-chat-btn').addEventListener('click', () => {
    saveCurrentSession();
    currentSessionId = null;
    selectedBooks.clear();
    selectedMinds.clear();
    activeMinds.clear();
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
