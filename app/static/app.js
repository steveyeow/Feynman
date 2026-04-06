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
let libraryFilter = 'recent';
let librarySearch = '';
let pollTimer = null;
let booksLoadState = 'idle';
let mindsLoadState = 'idle';
let _composerControlsBound = false;

// Chat state
let selectedBooks = new Map();
let selectedMinds = new Map();
let activeMinds = new Map();
let _mindsJoinedOnce = false;
let chatSessions = [];
let currentSessionId = null;

// Topic state
let topicTags = [];
let activeTopics = new Set();   // currently selected as filters
let loadingTopics = new Set();

// Onboarding state
let userName = localStorage.getItem('userName') || '';

// AI Book Writing state
let _writeBookId = null;
let _writeBookAgentId = null;
let _writeBookOutline = null;
let _writeBookPolling = null;
let _writeBookPollSessionId = null;
let _writeBookGen = 0;
let _writeBookAbort = null;

// ─── Pro Auth State ───
let proConfig = null;
let supabaseClient = null;
let currentUser = null;
let authToken = null;
let userTier = 'free';

function isProUser() {
  if (!window.FEYNMAN_PRO) return true;
  return userTier === 'pro';
}

async function loadUserTier() {
  if (!window.FEYNMAN_PRO || !currentUser) { userTier = 'free'; return; }
  try {
    const sub = await api('/api/pro/subscription');
    userTier = sub.tier || 'free';
  } catch { userTier = 'free'; }
}

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
    supabaseClient.auth.onAuthStateChange(async (event, session) => {
      if (session) {
        currentUser = session.user;
        authToken = session.access_token;
        userName = session.user.user_metadata?.full_name || session.user.email?.split('@')[0] || '';
        localStorage.setItem('userName', userName);
      } else {
        currentUser = null;
        authToken = null;
        userTier = 'free';
      }
      if (event === 'SIGNED_IN' || event === 'INITIAL_SESSION' || event === 'TOKEN_REFRESHED') {
        await loadUserTier();
      }
      updateAuthUI();
      if (event === 'SIGNED_IN' && (window.location.hash === '' || window.location.hash === '#' || window.location.hash === '#/' || window.location.hash === '#/login' || window.location.hash === '#/landing')) {
        window.location.hash = '#/';
        navigate();
      }
    });
  } catch (e) { console.warn('Supabase init failed:', e); }
}

function updateAuthUI() {
  const wrap = document.getElementById('sidebar-user-wrap');
  if (!wrap) return;
  if (!window.FEYNMAN_PRO) return;

  const profileBtn = wrap.querySelector('.sidebar-profile');
  const menuEl = document.getElementById('sidebar-user-menu');

  if (currentUser) {
    const avatarHtml = currentUser.user_metadata?.avatar_url
      ? `<img src="${currentUser.user_metadata.avatar_url}" referrerpolicy="no-referrer" style="width:28px;height:28px;border-radius:50%" />`
      : `<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>`;
    profileBtn.innerHTML = `<div class="profile-avatar">${avatarHtml}</div>
      <div class="sidebar-label profile-info">
        <span class="profile-name">${esc(userName || 'Account')}</span>
      </div>`;
    profileBtn.title = userName || 'Account';

    menuEl.innerHTML = `<div class="user-menu-header">
        <span class="user-menu-name">${esc(userName || 'Account')}</span>
        <span class="user-menu-email">${esc(currentUser.email || '')}</span>
      </div>
      <div class="user-menu-divider"></div>
      <a class="user-menu-item" href="#/subscription">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12V8H6a2 2 0 0 1-2-2c0-1.1.9-2 2-2h12v4"/><path d="M4 6v12c0 1.1.9 2 2 2h14v-4"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/></svg>
        Subscription
      </a>
      <a class="user-menu-item" href="https://discord.gg/XyjUb8nKCD" target="_blank" rel="noopener noreferrer">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
        Join Community
      </a>
      <div class="user-menu-divider"></div>
      <button class="user-menu-item user-menu-signout" onclick="signOut()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
        Sign out
      </button>`;
  } else {
    profileBtn.innerHTML = `<div class="profile-avatar">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
      </div>`;
    profileBtn.title = 'Account';

    menuEl.innerHTML = `<a class="user-menu-item" href="https://discord.gg/XyjUb8nKCD" target="_blank" rel="noopener noreferrer">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
        Join Community
      </a>
      <div class="user-menu-divider"></div>
      <a class="user-menu-item" href="#/login">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
        Sign in
      </a>`;
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
  const menu = document.getElementById('sidebar-user-menu');
  if (menu) menu.classList.remove('open');
  await supabaseClient.auth.signOut();
  currentUser = null;
  authToken = null;
  window.location.hash = '#/';
  updateAuthUI();
}
window.signOut = signOut;


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
    <div class="login-container">
      <div class="login-card">
        <div class="login-brand">
          <div class="greeting-logo-wrap" style="width:40px;height:40px">
            <svg class="greeting-logo" width="40" height="40" viewBox="0 0 56 56" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
              <rect x="24" y="0" width="8" height="4" fill="#FDCB6E"/><rect x="26" y="4" width="4" height="4" fill="#B8B8B8"/>
              <rect x="8" y="8" width="40" height="28" fill="#DA7756"/><rect x="12" y="12" width="32" height="20" fill="#FFF1E0"/>
              <rect x="16" y="16" width="8" height="8" fill="#2D3436"/><rect x="32" y="16" width="8" height="8" fill="#2D3436"/>
              <rect x="18" y="18" width="4" height="4" fill="#fff"/><rect x="34" y="18" width="4" height="4" fill="#fff"/>
              <rect x="22" y="28" width="12" height="2" fill="#C45E3E"/><rect x="18" y="38" width="4" height="8" fill="#B8B8B8"/>
              <rect x="34" y="38" width="4" height="8" fill="#B8B8B8"/>
            </svg>
            <svg class="greeting-feynman-logo" width="40" height="40" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
              <line x1="8" y1="58" x2="32" y2="30" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
              <line x1="56" y1="58" x2="32" y2="30" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
              <circle cx="32" cy="30" r="3.5" fill="currentColor"/>
              <path d="M32,30 C26,24 38,18 32,12 C26,6 38,0 32,-4" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </div>
        </div>
        <h1 class="login-welcome">Welcome to <span class="login-welcome-brand">Feynman</span></h1>
        <p class="login-subtitle">An interactive knowledge network of books, minds, and ideas.</p>
        <button id="google-signin-btn" class="login-google" type="button">
          <svg width="20" height="20" viewBox="0 0 24 24"><path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4"/><path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853"/><path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A10.96 10.96 0 0 0 1 12c0 1.77.42 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05"/><path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335"/></svg>
          Continue with Google
        </button>
        <p class="login-oauth-terms">By continuing, you agree to our <a href="/terms" target="_blank">Terms</a> and <a href="/privacy" target="_blank">Privacy&nbsp;Policy</a>.</p>
        <div id="auth-error" class="auth-error"></div>
        <div id="auth-success" class="auth-success"></div>
        <div class="login-divider"><span>or sign in with email</span></div>
        <div id="email-section" class="login-email-section">
          <form id="auth-form" class="login-form" onsubmit="return false">
            <div class="login-field">
              <input id="auth-email" class="login-input" type="email" placeholder="Email address" required autocomplete="email" />
            </div>
            <div class="login-field">
              <input id="auth-password" class="login-input" type="password" placeholder="Password" required autocomplete="current-password" minlength="6" />
            </div>
            <label id="terms-agree" class="login-terms" style="display:none">
              <input type="checkbox" id="terms-checkbox" />
              I agree to the <a href="/terms" target="_blank">Terms of Service</a> and <a href="/privacy" target="_blank">Privacy Policy</a>
            </label>
            <button id="auth-submit-btn" class="login-submit login-submit-secondary" type="submit">Sign in</button>
          </form>
          <p class="login-toggle"><span id="auth-toggle-label">Don't have an account?</span> <a href="javascript:void(0)" id="auth-toggle-link">Sign up</a></p>
        </div>
      </div>
      <a href="#/landing" class="login-back">&larr; Back</a>
    </div>`;
  let isSignUp = false;
  const form = el.querySelector('#auth-form'), emailInput = el.querySelector('#auth-email'), passwordInput = el.querySelector('#auth-password');
  const submitBtn = el.querySelector('#auth-submit-btn'), toggleLink = el.querySelector('#auth-toggle-link'), toggleLabel = el.querySelector('#auth-toggle-label');
  const emailSection = el.querySelector('#email-section');
  const errorEl = el.querySelector('#auth-error'), successEl = el.querySelector('#auth-success');
  const divider = el.querySelector('.login-divider');
  const termsWrap = el.querySelector('#terms-agree');
  const termsCheckbox = el.querySelector('#terms-checkbox');

  function updateMode() {
    submitBtn.textContent = isSignUp ? 'Create account' : 'Sign in';
    toggleLabel.textContent = isSignUp ? 'Already have an account?' : "Don't have an account?";
    toggleLink.textContent = isSignUp ? 'Sign in' : 'Sign up';
    passwordInput.autocomplete = isSignUp ? 'new-password' : 'current-password';
    termsWrap.style.display = isSignUp ? '' : 'none';
    if (!isSignUp) termsCheckbox.checked = false;
    errorEl.textContent = ''; successEl.textContent = '';
  }

  divider.style.cursor = 'pointer';
  divider.addEventListener('click', () => {
    emailSection.classList.toggle('login-email-collapsed');
    if (!emailSection.classList.contains('login-email-collapsed')) {
      emailInput.focus();
    }
  });

  toggleLink.addEventListener('click', () => {
    isSignUp = !isSignUp;
    updateMode();
    emailSection.classList.remove('login-email-collapsed');
  });

  const googleBtn = el.querySelector('#google-signin-btn');
  googleBtn.addEventListener('click', async () => {
    if (!supabaseClient) {
      errorEl.textContent = 'Authentication is not configured. Please set up Supabase credentials.';
      return;
    }
    errorEl.textContent = '';
    const { error } = await supabaseClient.auth.signInWithOAuth({
      provider: 'google',
      options: { redirectTo: window.location.origin }
    });
    if (error) errorEl.textContent = error.message;
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const email = emailInput.value.trim(), password = passwordInput.value;
    if (!email || !password) return;
    if (!supabaseClient) {
      errorEl.textContent = 'Authentication is not configured. Please set up Supabase credentials.';
      return;
    }
    if (isSignUp && !termsCheckbox.checked) {
      errorEl.textContent = 'Please agree to the Terms of Service and Privacy Policy.';
      return;
    }
    errorEl.textContent = ''; successEl.textContent = '';
    submitBtn.disabled = true;
    submitBtn.textContent = isSignUp ? 'Creating account...' : 'Signing in...';
    try {
      if (isSignUp) {
        await signUpWithEmail(email, password);
        successEl.textContent = 'Check your email to confirm your account, then sign in.';
        isSignUp = false;
        updateMode();
      } else {
        await signInWithEmail(email, password);
      }
    } catch (err) {
      errorEl.textContent = err.message || 'Something went wrong';
    } finally {
      submitBtn.disabled = false;
      updateMode();
    }
  });
}

function renderSubscriptionPage() {
  const el = document.getElementById('page-subscription');
  if (!el) return;
  el.innerHTML = '<div class="sub-page"><div class="sub-loading"><span class="loading-dot">Loading...</span></div></div>';
  (async () => {
    let sub = { tier: 'free', subscription: null };
    try { sub = await api('/api/pro/subscription'); } catch {}
    const isPro = sub.tier === 'pro';
    const freeFeatures = [
      'Chat with any book in your library',
      'Four-layer answers: text, metadata, web, LLM',
      'Great minds join once per chat',
      'Discover books & topics (3/day)',
      'Upload up to 3 books (PDF / EPUB / TXT / MD)',
    ];
    const proFeatures = [
      'Everything in Free',
      'Upload more books',
      'Discover more books in chat & library',
      'Write your own book on any topic',
      'Great minds continuously join chats',
      'Invite great minds into your chats',
      'Upload your own minds or from any source',
      'Discover & expand the minds network',
      'Higher daily usage limits',
      'Priority access',
    ];
    const featureRow = (text, isPro) => `<div class="sub-feature-row"><span class="sub-feature-check ${isPro ? 'pro-check' : ''}">\u2713</span><span class="sub-feature-label">${esc(text)}</span></div>`;
    el.innerHTML = `<div class="sub-page">
      <div class="sub-header">
        <h1 class="sub-title">Plans</h1>
        <p class="sub-subtitle">Read smarter. Think deeper.<br>Learn with the greatest minds in history and today's world.</p>
      </div>
      <div class="sub-cards">
        <div class="sub-card ${!isPro ? 'sub-card-active' : ''}">
          <div class="sub-card-head">
            <div class="sub-plan-name"><span>Free</span>${!isPro ? '<span class="sub-badge">Current</span>' : ''}</div>
            <div class="sub-price">$0<span>/mo</span></div>
            <p class="sub-price-note">Get started, no credit card needed</p>
          </div>
          <div class="sub-card-body">
            ${freeFeatures.map(f => featureRow(f, false)).join('')}
          </div>
          ${!isPro ? '<div class="sub-card-foot"><button class="sub-btn sub-btn-secondary" disabled>Current Plan</button></div>' : ''}
        </div>
        <div class="sub-card sub-card-pro ${isPro ? 'sub-card-active' : ''}">
          <div class="sub-card-head">
            <div class="sub-plan-name"><span>Pro</span>${isPro ? '<span class="sub-badge sub-badge-pro">Current</span>' : ''}</div>
            <div class="sub-price">$9.90<span>/mo</span></div>
            <p class="sub-price-note">For power users who read and learn every day</p>
          </div>
          <div class="sub-card-body">
            ${proFeatures.map(f => featureRow(f, true)).join('')}
          </div>
          <div class="sub-card-foot">
            ${isPro
              ? `<button class="sub-btn sub-btn-manage" id="sub-manage-btn">Manage Subscription</button>${sub.subscription?.cancel_at_period_end ? '<p class="sub-cancel-note">Cancels at end of billing period</p>' : ''}`
              : '<button class="sub-btn sub-btn-primary" id="sub-upgrade-btn">Upgrade to Pro</button>'}
          </div>
        </div>
      </div>
      <div class="sub-footer">
        ${currentUser
          ? `<p class="sub-email">${esc(currentUser.email || '')}</p><button class="sub-signout-btn" onclick="signOut()">Sign Out</button>`
          : `<button class="sub-btn sub-btn-signin" onclick="window.location.hash='#/login'">Sign in to manage your account</button>`}
      </div>
    </div>`;
    const upgradeBtn = document.getElementById('sub-upgrade-btn');
    if (upgradeBtn) {
      upgradeBtn.addEventListener('click', async () => {
        if (!currentUser) { window.location.hash = '#/login'; return; }
        if (!proConfig?.stripe_enabled) {
          alert('Payments are not configured on this server.');
          return;
        }
        upgradeBtn.textContent = 'Redirecting...';
        upgradeBtn.disabled = true;
        try {
          const data = await api('/api/pro/create-checkout-session', { method: 'POST' });
          if (data.url) window.location.href = data.url;
        } catch (err) {
          alert('Checkout failed: ' + err.message);
          upgradeBtn.textContent = 'Upgrade to Pro';
          upgradeBtn.disabled = false;
        }
      });
    }
    const manageBtn = document.getElementById('sub-manage-btn');
    if (manageBtn) {
      manageBtn.addEventListener('click', async () => {
        try {
          const data = await api('/api/pro/create-portal-session', { method: 'POST' });
          if (data.url) window.location.href = data.url;
        } catch (err) { alert('Portal failed: ' + err.message); }
      });
    }
  })();
}

function showProOverlay() {
  const existing = document.getElementById('pro-overlay');
  if (existing) return;
  const overlay = document.createElement('div');
  overlay.id = 'pro-overlay';
  overlay.className = 'pro-overlay';
  const closeBtn = `<button class="pro-overlay-close" id="pro-overlay-close" title="Close">&times;</button>`;
  overlay.innerHTML = `<div class="pro-overlay-inner">${closeBtn}<div class="sub-page"><div class="sub-loading"><span class="loading-dot">Loading...</span></div></div></div>`;
  document.body.appendChild(overlay);
  requestAnimationFrame(() => overlay.classList.add('visible'));
  const close = () => { overlay.classList.remove('visible'); setTimeout(() => overlay.remove(), 200); };
  overlay.addEventListener('click', e => { if (e.target === overlay) close(); });
  document.getElementById('pro-overlay-close').addEventListener('click', close);

  (async () => {
    let sub = { tier: 'free', subscription: null };
    try { sub = await api('/api/pro/subscription'); } catch {}
    const isPro = sub.tier === 'pro';
    const freeFeatures = [
      'Chat with any book in your library',
      'Four-layer answers: text, metadata, web, LLM',
      'Great minds join once per chat',
      'Discover books & topics (3/day)',
      'Upload up to 3 books (PDF / EPUB / TXT / MD)',
    ];
    const proFeatures = [
      'Everything in Free',
      'Upload more books',
      'Discover more books in chat & library',
      'Write your own book on any topic',
      'Great minds continuously join chats',
      'Invite great minds into your chats',
      'Upload your own minds or from any source',
      'Discover & expand the minds network',
      'Higher daily usage limits',
      'Priority access',
    ];
    const featureRow = (text, pro) => `<div class="sub-feature-row"><span class="sub-feature-check ${pro ? 'pro-check' : ''}">\u2713</span><span class="sub-feature-label">${esc(text)}</span></div>`;
    const inner = overlay.querySelector('.pro-overlay-inner');
    inner.innerHTML = `${closeBtn}<div class="sub-page">
      <div class="sub-header">
        <h1 class="sub-title">Plans</h1>
        <p class="sub-subtitle">Read smarter. Think deeper.<br>Learn with the greatest minds in history and today's world.</p>
      </div>
      <div class="sub-cards">
        <div class="sub-card ${!isPro ? 'sub-card-active' : ''}">
          <div class="sub-card-head">
            <div class="sub-plan-name"><span>Free</span>${!isPro ? '<span class="sub-badge">Current</span>' : ''}</div>
            <div class="sub-price">$0<span>/mo</span></div>
            <p class="sub-price-note">Get started, no credit card needed</p>
          </div>
          <div class="sub-card-body">
            ${freeFeatures.map(f => featureRow(f, false)).join('')}
          </div>
          ${!isPro ? '<div class="sub-card-foot"><button class="sub-btn sub-btn-secondary" disabled>Current Plan</button></div>' : ''}
        </div>
        <div class="sub-card sub-card-pro ${isPro ? 'sub-card-active' : ''}">
          <div class="sub-card-head">
            <div class="sub-plan-name"><span>Pro</span>${isPro ? '<span class="sub-badge sub-badge-pro">Current</span>' : ''}</div>
            <div class="sub-price">$9.90<span>/mo</span></div>
            <p class="sub-price-note">For power users who read and learn every day</p>
          </div>
          <div class="sub-card-body">
            ${proFeatures.map(f => featureRow(f, true)).join('')}
          </div>
          <div class="sub-card-foot">
            ${isPro
              ? `<button class="sub-btn sub-btn-manage" id="overlay-manage-btn">Manage Subscription</button>${sub.subscription?.cancel_at_period_end ? '<p class="sub-cancel-note">Cancels at end of billing period</p>' : ''}`
              : '<button class="sub-btn sub-btn-primary" id="overlay-upgrade-btn">Upgrade to Pro</button>'}
          </div>
        </div>
      </div>
    </div>`;
    document.getElementById('pro-overlay-close').addEventListener('click', close);
    const upgradeBtn = document.getElementById('overlay-upgrade-btn');
    if (upgradeBtn) {
      upgradeBtn.addEventListener('click', async () => {
        if (!currentUser) { close(); window.location.hash = '#/login'; return; }
        if (!proConfig?.stripe_enabled) { alert('Payments are not configured on this server.'); return; }
        upgradeBtn.textContent = 'Redirecting...';
        upgradeBtn.disabled = true;
        try {
          const data = await api('/api/pro/create-checkout-session', { method: 'POST' });
          if (data.url) window.location.href = data.url;
        } catch (err) {
          alert('Checkout failed: ' + err.message);
          upgradeBtn.textContent = 'Upgrade to Pro';
          upgradeBtn.disabled = false;
        }
      });
    }
    const manageBtn = document.getElementById('overlay-manage-btn');
    if (manageBtn) {
      manageBtn.addEventListener('click', async () => {
        try {
          const data = await api('/api/pro/create-portal-session', { method: 'POST' });
          if (data.url) window.location.href = data.url;
        } catch (err) { alert('Portal failed: ' + err.message); }
      });
    }
  })();
}

// ─── Greeting ───
function getGreeting() {
  const h = new Date().getHours();
  let g = h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
  if (userName) g += ', ' + userName.split(/\s+/)[0];
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
  const chatRoute = hash.match(/^#\/chat(?:\/([^/?]+))?$/);
  if (chatRoute) return { page: 'chat', sessionId: chatRoute[1] || null };
  if (hash === '#/chats') return { page: 'chats' };
  if (hash === '#/library') return { page: 'library' };
  if (hash === '#/minds') return { page: 'minds' };
  if (hash === '#/login') return { page: 'login' };
  if (hash.startsWith('#/subscription')) return { page: 'subscription' };
  const mm = hash.match(/^#\/mind\/(.+)$/);
  if (mm) return { page: 'mind', id: mm[1] };
  const m = hash.match(/^#\/book\/(.+)$/);
  if (m) return { page: 'book', id: m[1] };
  const rm = hash.match(/^#\/read\/(.+)$/);
  if (rm) return { page: 'read', id: rm[1] };
  return { page: 'home' };
}

/** Update the address bar to #/chat/<sessionId> without firing hashchange (bookmarkable per-thread). */
function _setChatHashForSession(sessionId) {
  if (!sessionId) return;
  const desired = `#/chat/${sessionId}`;
  if ((window.location.hash || '') !== desired) {
    history.replaceState(null, '', desired);
  }
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
        <span class="lp-topbar-brand"><svg width="19" height="19" viewBox="0 0 64 64" fill="none"><line x1="8" y1="58" x2="32" y2="30" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><line x1="56" y1="58" x2="32" y2="30" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="32" cy="30" r="3.5" fill="currentColor"/><path d="M32,30 C26,24 38,18 32,12 C26,6 38,0 32,-4" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>Feynman</span>
        <div class="lp-topbar-actions">
          <a href="https://discord.gg/XyjUb8nKCD" target="_blank" rel="noopener noreferrer" class="lp-discord-link" title="Join our Discord">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z"/></svg>
          </a>
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
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><circle cx="4" cy="6" r="2"/><circle cx="20" cy="6" r="2"/><circle cx="4" cy="18" r="2"/><circle cx="20" cy="18" r="2"/><line x1="9.5" y1="10" x2="5.5" y2="7.5"/><line x1="14.5" y1="10" x2="18.5" y2="7.5"/><line x1="9.5" y1="14" x2="5.5" y2="16.5"/><line x1="14.5" y1="14" x2="18.5" y2="16.5"/></svg>
            Expand Network
          </button>
          <button class="lp-minds-toolbar-btn" disabled>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>
            Upload a Mind
          </button>
        </div>

        <div class="lp-fg-center">
          <div class="lp-hero-left">
            <h1 class="lp-hero-headline">Chat with books.<br>Great minds join in.</h1>
            <p class="lp-hero-sub">An interactive knowledge network built on the world's most important books and great minds. Turn any book into a conversation that goes beyond the page, or start from a topic to learn across a library that grows as you explore or write the book you want to read, with an evolving network of agent-simulated great minds joins your discussion, learn and grow with you.</p>
            <button class="lp-hero-cta" id="lp-hero-cta">${window.FEYNMAN_PRO ? 'Get Started Free' : 'Start Exploring'}<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></button>
          </div>
          <div class="lp-chat-card">
            <div class="lp-chat-home" id="lp-chat-home">
              <div class="lp-chat-home-inner">
                <div class="greeting-row">
                  <div class="greeting-logo-wrap" style="width:28px;height:28px">
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
                    <svg class="greeting-feynman-logo" width="28" height="28" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                      <line x1="8" y1="58" x2="32" y2="30" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                      <line x1="56" y1="58" x2="32" y2="30" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                      <circle cx="32" cy="30" r="3.5" fill="currentColor"/>
                      <path d="M32,30 C26,24 38,18 32,12 C26,6 38,0 32,-4" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
                    </svg>
                  </div>
                  <span class="greeting lp-greeting">${timeGreeting}, ${userName ? userName.split(' ')[0] : 'Steve'}</span>
                </div>
                <div class="chat-composer lp-composer">
                  <div class="selected-chips" id="lp-selected-chips"></div>
                  <textarea class="composer-input" id="lp-composer-input" rows="1" placeholder="Explore books, topics, or ideas — minds join the conversation..." readonly></textarea>
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

  const _lpCtaHandler = () => {
    if (window.FEYNMAN_PRO) {
      window.location.hash = currentUser ? '#/' : '#/login';
    } else {
      localStorage.setItem('feynman-landed', '1');
      window.location.hash = '#/';
    }
  };
  document.getElementById('lp-get-started').addEventListener('click', _lpCtaHandler);
  document.getElementById('lp-hero-cta').addEventListener('click', _lpCtaHandler);

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

  const graphCx = W * 0.55;
  const sim = d3.forceSimulation(nodes)
    .force('link', d3.forceLink(links).id(d => d.id).distance(d => Math.max(80, 280 - d.strength * 70)).strength(d => 0.08 + d.strength * 0.15))
    .force('charge', d3.forceManyBody().strength(-600).distanceMax(800))
    .force('center', d3.forceCenter(graphCx, H / 2).strength(0.02))
    .force('collision', d3.forceCollide().radius(d => d._isAdd ? ADD_R + 15 : BASE_R + 20))
    .force('x', d3.forceX(graphCx).strength(0.01))
    .force('y', d3.forceY(H / 2).strength(0.01))
    .force('avoid', makeAvoidForce())
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
        div.innerHTML = `${_mindAvatar(msg.name, msg.color)}<div class="lp-mind-body-wrap"><div class="lp-mind-header"><span class="lp-mn-name">${esc(msg.name)}</span></div><div class="lp-mind-body"></div></div>`;
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
  // Reader attaches a document-level keydown handler; remove it when leaving #/read
  // or Space/arrow keys keep firing and break typing in composers elsewhere.
  if (route.page !== 'read' && _readerCleanup) {
    _readerCleanup();
    _readerCleanup = null;
  }
  document.querySelectorAll('.page-view').forEach(el => el.classList.add('hidden'));
  const el = document.getElementById('page-' + route.page);
  if (el) el.classList.remove('hidden');

  const appLayout = document.getElementById('app-layout');
  if (route.page === 'landing') {
    appLayout.classList.add('landing-active');
  } else {
    appLayout.classList.remove('landing-active');
  }
  if (route.page === 'login') {
    appLayout.classList.add('login-active');
  } else {
    appLayout.classList.remove('login-active');
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
    case 'chat': void onChatPageShow(); break;
    case 'chats':
      if (window.FEYNMAN_PRO && !currentUser) { window.location.hash = '#/login'; return; }
      renderChatsPage(); break;
    case 'library':
      if (window.FEYNMAN_PRO && !currentUser) { window.location.hash = '#/login'; return; }
      renderLibrary(); break;
    case 'minds': renderMindsPage(); break;
    case 'login': renderLoginPage(); break;
    case 'subscription': renderSubscriptionPage(); break;
    case 'mind':
      if (!isProUser()) {
        showProOverlay();
        window.location.hash = '#/minds';
        return;
      }
      currentMindId = route.id;
      renderMindDetail(route.id);
      break;
    case 'book':
      if (window.FEYNMAN_PRO && !currentUser) { window.location.hash = '#/login'; return; }
      currentBookId = route.id;
      renderBookDetail(route.id);
      break;
    case 'read':
      if (window.FEYNMAN_PRO && !currentUser) { window.location.hash = '#/login'; return; }
      renderReader(route.id);
      break;
  }
}
window.addEventListener('hashchange', navigate);

// ─── Sidebar toggle ───
function toggleSidebar() {
  document.getElementById('app-layout').classList.toggle('sidebar-collapsed');
  const menu = document.getElementById('sidebar-user-menu');
  if (menu) menu.classList.remove('open');
}

// ─── API ───
function _parseApiError(status, d) {
  if (status === 413) return 'File is too large. Maximum upload size is 4 MB.';
  const detail = typeof d.detail === 'string' ? d.detail : (d.detail?.message || '');
  return detail || `Request failed (${status})`;
}

async function api(path, opts = {}) {
  if (authToken) {
    opts.headers = { ...(opts.headers || {}), 'Authorization': 'Bearer ' + authToken };
  }
  let r = await fetch(path, opts);
  let d;
  try { d = await r.json(); } catch { d = { detail: r.statusText || 'Request failed' }; }
  if (r.status === 429 && (d.detail?.code === 'quota_exceeded' || d.detail?.code === 'upload_limit_reached')) {
    showProOverlay();
    throw new Error(d.detail.message || 'Quota exceeded');
  }
  // Token expired or invalid — try refreshing the session before giving up
  if (r.status === 401 && (d.code === 'token_expired' || d.code === 'invalid_token') && supabaseClient) {
    try {
      const { data: { session } } = await supabaseClient.auth.refreshSession();
      if (session) {
        authToken = session.access_token;
        currentUser = session.user;
        opts.headers = { ...(opts.headers || {}), 'Authorization': 'Bearer ' + authToken };
        r = await fetch(path, opts);
        try { d = await r.json(); } catch { d = { detail: r.statusText || 'Request failed' }; }
      }
    } catch {}
  }
  if (r.status === 401 && d.code === 'auth_required' && window.FEYNMAN_PRO) {
    window.location.hash = '#/login';
    throw new Error('Please sign in to continue');
  }
  if (!r.ok) throw new Error(_parseApiError(r.status, d));
  return d;
}

async function loadAgents() {
  booksLoadState = 'loading';
  _refreshOpenPopovers();
  try {
    const data = await api('/api/agents');
    agents = Array.isArray(data) ? data : [];
    booksLoadState = 'ready';
  } catch {
    agents = [];
    booksLoadState = 'error';
  }
  buildBookList();
  _refreshOpenPopovers();
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
  const clearBtn = activeTopics.size
    ? '<button class="topic-tag topic-tag-clear" id="topic-clear-all">Clear all ×</button>'
    : '';
  grid.innerHTML = clearBtn + topicTags.map(topic => {
    const isLoading = loadingTopics.has(topic);
    const isActive = activeTopics.has(topic);
    let cls = 'topic-tag';
    if (isLoading) cls += ' loading';
    else if (isActive) cls += ' active';
    const spinner = isLoading ? '<span class="loading-dot" style="margin-right:5px;font-size:11px">...</span>' : '';
    return `<button class="${cls}" data-topic="${esc(topic)}">${spinner}${esc(topic)}</button>`;
  }).join('');
  grid.querySelectorAll('.topic-tag[data-topic]').forEach(btn => {
    btn.addEventListener('click', () => handleTopicClick(btn.dataset.topic));
  });
  const clearEl = document.getElementById('topic-clear-all');
  if (clearEl) {
    clearEl.addEventListener('click', () => {
      activeTopics.clear();
      renderTopicTags();
      renderLibraryGrid();
    });
  }
  renderDiscoverBar();
}

function renderDiscoverBar() {
  const bar = document.getElementById('library-discover-bar');
  if (!bar) return;
  if (!activeTopics.size || librarySearch) {
    bar.classList.add('hidden');
    bar.innerHTML = '';
    return;
  }
  const topicList = [...activeTopics];
  const label = topicList.length === 1 ? topicList[0] : topicList.join(', ');
  bar.classList.remove('hidden');
  bar.innerHTML = `<span class="discover-bar-text">Want more books on <strong>${esc(label)}</strong>?</span>` +
    `<button class="discover-bar-btn" id="discover-bar-btn">+ Discover 1–3 more</button>`;
  document.getElementById('discover-bar-btn').addEventListener('click', () => {
    discoverMore(topicList);
  });
}

function handleTopicClick(topic) {
  if (loadingTopics.has(topic)) return;
  if (activeTopics.has(topic)) {
    activeTopics.delete(topic);
  } else {
    activeTopics.add(topic);
  }
  renderTopicTags();
  renderLibraryGrid();
}

// ─── Build book list from agents (DB is the single source of truth) ───
function buildBookList() {
  allBooks = agents.filter(a => a.status !== 'error' || a.type === 'ai_book').map(a => {
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
      hasFullText: a.type === 'ai_book'
        ? (a.status === 'ready' || a.status === 'writing')
        : (meta.chunk_count || 0) >= 10,
      skills: meta.skills || {},
      isUploaded: a.type === 'upload',
      isCatalog: a.type === 'catalog',
      isAIGenerated: a.type === 'ai_book',
      creatorName: meta.creator_name || '',
      userId: a.user_id || meta.creator_user_id || '',
      upvotes: 0,
      created_at: a.created_at || '',
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
  }, 15000);
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

  const ready = allBooks.filter(b => b.available || b.hasFullText);
  const books = ready.length ? ready : allBooks.filter(b => b.status !== 'error');

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
    greetingEl.textContent = 'Nice to meet you, ' + userName.split(' ')[0] + '!';
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
function appendMsg(container, role, text, sources, opts, hasMentions, contextMinds) {
  const raw = String(text ?? '');
  const cleaned = raw.replace(/<div\b[^>]*>|<\/div>/gi, '').trim();
  const el = document.createElement('div');
  el.className = 'chat-message ' + role;
  el.setAttribute('dir', 'auto');
  el.dataset.raw = raw;
  if (sources?.length) el.dataset.sources = JSON.stringify(sources);
  if (opts && Object.keys(opts).length) el.dataset.opts = JSON.stringify(opts);
  if (contextMinds?.length) el.dataset.contextMinds = JSON.stringify(contextMinds);
  const webSrcs = opts?.webSources || [];
  const refs = opts?.references || [];
  const refsByIndex = new Map(refs.map(r => [Number(r.index), r]));
  if (role === 'assistant') {
    const avatar = document.createElement('div');
    avatar.className = 'feynman-msg-avatar';
    avatar.innerHTML = `<svg width="18" height="18" viewBox="0 0 64 64" fill="none"><line x1="8" y1="58" x2="32" y2="30" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><line x1="56" y1="58" x2="32" y2="30" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/><circle cx="32" cy="30" r="3.5" fill="currentColor"/><path d="M32,30 C26,24 38,18 32,12 C26,6 38,0 32,-4" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    el.appendChild(avatar);
    const body = document.createElement('div');
    body.className = 'feynman-msg-body';
    body.innerHTML = `<div class="feynman-msg-name">Feynman</div>`;
    const content = document.createElement('div');
    content.className = 'msg-content';
    content.setAttribute('dir', 'auto');
    let html = renderMarkdown(cleaned);
    // Convert [1], [2], [1, 2] etc. to clickable citation superscripts
    if (refs.length || webSrcs.length) {
      html = html.replace(/\[(\d+(?:\s*,\s*\d+)*)\]/g, (match, nums) => {
        const indices = nums.split(/\s*,\s*/).map(n => parseInt(n, 10));
        const links = indices.map(num => {
          const idx = num - 1;
          const ref = refsByIndex.get(num);
          if (ref) {
            return `<a class="cite-link" data-ref="${num}" href="javascript:void(0)" title="${esc(ref.book + ': ' + ref.snippet.slice(0, 60))}"><sup>${num}</sup></a>`;
          } else if (webSrcs.length && idx >= 0 && idx < webSrcs.length) {
            return `<a class="cite-link" href="${esc(webSrcs[idx].url)}" target="_blank" rel="noopener" title="${esc(webSrcs[idx].title || '')}"><sup>${num}</sup></a>`;
          }
          return `<sup>${num}</sup>`;
        });
        return `<span class="cite-group">[${links.join(', ')}]</span>`;
      });
    }
    content.innerHTML = html;
    body.appendChild(content);
    el.appendChild(body);
    content.querySelectorAll('.cite-link[data-ref]').forEach(a => {
      a.addEventListener('click', e => {
        e.preventDefault();
        const refEl = el.querySelector('#ref-' + a.dataset.ref);
        if (refEl) refEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
  } else if (role === 'user') {
    if (contextMinds?.length) {
      const tagsEl = document.createElement('div');
      tagsEl.className = 'msg-context-minds';
      tagsEl.innerHTML = contextMinds.map(m => {
        const c = mindColor(m.name);
        const i = mindInitials(m.name);
        return `<span class="msg-context-mind"><span class="msg-context-avatar" style="background:${c}">${i}</span>${esc(m.name)}</span>`;
      }).join('');
      el.appendChild(tagsEl);
    }
    const textEl = document.createElement('span');
    if (hasMentions) {
      textEl.innerHTML = renderUserMsgWithMentions(cleaned);
    } else {
      textEl.textContent = cleaned;
    }
    el.appendChild(textEl);
  } else {
    el.textContent = cleaned;
  }
  const appendTarget = (role === 'assistant') ? el.querySelector('.feynman-msg-body') || el : el;
  // References (RAG chunk sources), grouped by book to avoid duplicate titles
  if (refs.length) {
    const refsEl = document.createElement('div');
    refsEl.className = 'msg-references';
    const grouped = [];
    const bookMap = new Map();
    for (const r of refs) {
      const key = r.book;
      if (bookMap.has(key)) {
        bookMap.get(key).chunks.push(r);
      } else {
        const entry = { book: r.book, chunks: [r] };
        bookMap.set(key, entry);
        grouped.push(entry);
      }
    }
    const refTextMap = new Map();
    refsEl.innerHTML = '<div class="refs-header">References</div>' +
      grouped.map(g => {
        const nums = g.chunks.map(c => c.index);
        const numsHtml = nums.map(n => `<span class="ref-num">${n}</span>`).join('');
        const multi = g.chunks.length > 1;
        const snippetsHtml = g.chunks.map(c => {
          const hasFullText = c.full_text && c.full_text.length > (c.snippet || '').replace(/\.\.\.$/,'').length;
          if (hasFullText) refTextMap.set(String(c.index), { snippet: c.snippet, full: c.full_text });
          const numTag = multi ? `<span class="ref-snippet-num">${c.index}</span>` : '';
          const expandIcon = hasFullText ? '<span class="ref-expand-icon">&#x25B6;</span>' : '';
          return `<div class="ref-snippet-row${hasFullText ? ' expandable' : ''}" id="ref-${c.index}" data-refidx="${c.index}">${numTag}<span class="ref-snippet">${esc(c.snippet)}</span>${expandIcon}</div>`;
        }).join('');
        return `<div class="ref-group"><div class="ref-group-header">${numsHtml}<span class="ref-book">${esc(g.book)}</span></div><div class="ref-snippets">${snippetsHtml}</div></div>`;
      }).join('');
    refsEl.querySelectorAll('.ref-snippet-row.expandable').forEach(row => {
      row.addEventListener('click', () => {
        const entry = refTextMap.get(row.dataset.refidx);
        if (!entry) return;
        const snippetEl = row.querySelector('.ref-snippet');
        const isExpanded = row.classList.toggle('expanded');
        snippetEl.textContent = isExpanded ? entry.full : entry.snippet;
      });
    });
    appendTarget.appendChild(refsEl);
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
    appendTarget.appendChild(ws);
  }
  // Skill badge
  if (opts?.skillUsed && opts.skillUsed !== 'none') {
    const sb = document.createElement('span');
    sb.className = 'skill-badge skill-' + opts.skillUsed;
    const labels = { rag: 'RAG', content_fetch: 'Web APIs', web_search: 'Web Search', llm_knowledge: 'LLM Knowledge' };
    sb.textContent = labels[opts.skillUsed] || opts.skillUsed;
    appendTarget.appendChild(sb);
  }
  // Token usage
  if (opts?.usage && opts.usage.total_tokens > 0) {
    const u = opts.usage;
    const tu = document.createElement('div');
    tu.className = 'token-usage';
    tu.textContent = `${u.total_tokens} tokens`;
    tu.title = `Input: ${u.input_tokens} · Output: ${u.output_tokens}`;
    appendTarget.appendChild(tu);
  }
  container.appendChild(el);
  container.scrollTop = container.scrollHeight;
}

function appendMindMsg(container, mindName, text) {
  const raw = String(text ?? '');
  const cleaned = raw.replace(/<div\b[^>]*>|<\/div>/gi, '').trim();
  // Strip leading "[Name]: " prefix if LLM echoed it
  const prefixRe = new RegExp(`^\\[${mindName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\]:\\s*`, 'i');
  const strippedRaw = raw.replace(prefixRe, '');
  const el = document.createElement('div');
  el.className = 'chat-message mind-message';
  el.setAttribute('dir', 'auto');
  el.dataset.raw = strippedRaw;
  el.dataset.mindName = mindName;
  const color = mindColor(mindName);
  const initials = mindInitials(mindName);
  const avatar = document.createElement('div');
  avatar.className = 'mind-msg-avatar';
  avatar.style.background = color;
  avatar.textContent = initials;
  el.appendChild(avatar);
  const body = document.createElement('div');
  body.className = 'mind-msg-body';
  body.innerHTML = `<div class="mind-msg-name">${esc(mindName)}</div>`;
  const content = document.createElement('div');
  content.className = 'msg-content mind-msg-content';
  content.setAttribute('dir', 'auto');
  content.innerHTML = renderMarkdown(cleaned.replace(prefixRe, '').trim());
  body.appendChild(content);
  el.appendChild(body);
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

let _loadingInterval = null;
function showLoading(c, stages) {
  const el = document.createElement('div');
  el.className = 'chat-message assistant';
  el.id = 'loading-msg';
  el.innerHTML = '<span class="loading-dot">Thinking...</span>';
  c.appendChild(el);
  c.scrollTop = c.scrollHeight;

  if (_loadingInterval) { clearInterval(_loadingInterval); _loadingInterval = null; }
  if (stages && stages.length > 0) {
    let idx = 0;
    _loadingInterval = setInterval(() => {
      idx++;
      const dot = el.querySelector('.loading-dot');
      if (!dot || idx >= stages.length) { clearInterval(_loadingInterval); _loadingInterval = null; return; }
      dot.textContent = stages[idx];
      c.scrollTop = c.scrollHeight;
    }, 4000);
  }
}
function removeLoading() {
  if (_loadingInterval) { clearInterval(_loadingInterval); _loadingInterval = null; }
  document.getElementById('loading-msg')?.remove();
}

// ─── Chat sessions (DB-backed) ───

async function restoreSessions() {
  try {
    const sessions = await api('/api/sessions');
    chatSessions = sessions.map(s => ({
      id: s.id,
      title: s.title,
      messages: [],
      books: new Map(Object.entries(s.meta?.books || {})),
      minds: new Map(Object.entries(s.meta?.minds || {})),
      activeMinds: new Map(Object.entries(s.meta?.activeMinds || {})),
      updatedAt: new Date(s.updated_at).getTime(),
      mindId: s.mind_id || null,
      sessionType: s.meta?.write_book ? 'write_book' : (s.session_type || 'chat'),
      meta: s.meta || {},
    }));
    // Migrate from localStorage if DB is empty but localStorage has data
    if (!chatSessions.length) {
      const raw = localStorage.getItem('chatSessions');
      if (raw) {
        const localData = JSON.parse(raw);
        for (const s of localData) {
          const books = s.books instanceof Array ? Object.fromEntries(s.books) : {};
          const minds = s.minds instanceof Array ? Object.fromEntries(s.minds) : {};
          const activeMinds = s.activeMinds instanceof Array ? Object.fromEntries(s.activeMinds) : {};
          const created = await api('/api/sessions', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ title: s.title, session_type: s.mindId ? 'mind' : 'chat', mind_id: s.mindId || null, meta: { books, minds, activeMinds } }),
          });
          for (const m of (s.messages || [])) {
            const msgMeta = {};
            if (m.sources) msgMeta.sources = m.sources;
            if (m.opts) msgMeta.opts = m.opts;
            if (m.mindName) msgMeta.mindName = m.mindName;
            if (m.mindNames) msgMeta.mindNames = m.mindNames;
            await api(`/api/sessions/${created.id}/messages`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ role: m.role, content: m.content || '', meta: msgMeta }),
            });
          }
          chatSessions.push({
            id: created.id, title: s.title, messages: s.messages || [],
            books: new Map(s.books || []), minds: new Map(s.minds || []),
            activeMinds: new Map(s.activeMinds || []),
            updatedAt: s.updatedAt || 0, mindId: s.mindId || null,
          });
        }
        localStorage.removeItem('chatSessions');
        localStorage.removeItem('sessionCounter');
        localStorage.removeItem('currentSessionId');
      }
    }
    currentSessionId = localStorage.getItem('currentSessionId') || (chatSessions.length ? chatSessions[0].id : null);
  } catch (e) {
    console.warn('Failed to restore sessions from DB:', e);
  }
}

async function createSession(mindId) {
  const body = { title: 'New chat', session_type: mindId ? 'mind' : 'chat' };
  if (mindId) body.mind_id = mindId;
  const created = await api('/api/sessions', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const session = {
    id: created.id, title: 'New chat', messages: [],
    books: new Map(), minds: new Map(), activeMinds: new Map(),
    updatedAt: Date.now(), mindId: mindId || null,
  };
  chatSessions.unshift(session);
  currentSessionId = session.id;
  localStorage.setItem('currentSessionId', currentSessionId);
  activeMinds.clear();
  _mindsInvitedOnce = false;
  if (!mindId) {
    document.getElementById('chat-messages').innerHTML = '';
    hideChatRightSidebar();
  }
  renderChatHistory();
  if (getRoute().page === 'chat') _setChatHashForSession(session.id);
  return session;
}

function persistSessions() {
  localStorage.setItem('currentSessionId', currentSessionId || '');
}

function saveCurrentSession() {
  // No-op: messages are now saved to DB individually as they're sent/received
}

async function switchToSession(id) {
  const alreadyCurrent = id === currentSessionId;
  const session = chatSessions.find(s => s.id === id);
  if (!session) return;
  currentSessionId = id;
  localStorage.setItem('currentSessionId', currentSessionId);

  if (session.sessionType === 'book') {
    window.location.hash = '#/book/' + session.mindId;
    return;
  }
  if (session.mindId) {
    window.location.hash = '#/mind/' + session.mindId;
    return;
  }

  if (!alreadyCurrent) {
    selectedBooks = new Map(session.books);
    selectedMinds = new Map(session.minds || []);
    activeMinds = new Map(session.activeMinds || []);
    const chatBox = document.getElementById('chat-messages');
    _chatRenderGen++;
    chatBox.innerHTML = '';

    try {
      const msgs = await api(`/api/sessions/${id}/messages`);
      session.messages = msgs.map(m => ({ role: m.role, content: m.content, ...m.meta }));
    } catch (e) {
      console.warn('Failed to load session messages:', e);
    }

    for (const m of session.messages) {
      if (m.role === 'mind') {
        appendMindMsg(chatBox, m.mindName, m.content);
      } else if (m.role === 'system-notice') {
        appendJoinNotice(chatBox, m.mindNames || []);
      } else {
        const cm = m.role === 'user' ? m.contextMinds : undefined;
        appendMsg(chatBox, m.role, m.content, m.sources, m.opts, false, cm);
      }
    }
    renderSelectedChips();
    restoreChatSidebar(session.messages);
    renderChatHistory();

    // Restore write-book state (outline card / writing progress)
    _restoreWriteBookState(session, chatBox);
  } else if (getRoute().page === 'chat') {
    // Same session re-selected — refresh outline panel (e.g. book just finished indexing)
    const chatBox = document.getElementById('chat-messages');
    _restoreWriteBookState(session, chatBox);
  }
  if (getRoute().page !== 'chat') {
    window.location.hash = `#/chat/${id}`;
  } else {
    _setChatHashForSession(id);
  }
}

async function deleteSession(id) {
  chatSessions = chatSessions.filter(s => s.id !== id);
  if (currentSessionId === id) {
    currentSessionId = null;
    localStorage.setItem('currentSessionId', '');
    document.getElementById('chat-messages').innerHTML = '';
    hideChatRightSidebar();
  }
  renderChatHistory();
  if (getRoute().page === 'chats') _renderChatsList(document.getElementById('chats-search')?.value?.trim().toLowerCase() || '');
  try { await api(`/api/sessions/${id}`, { method: 'DELETE' }); } catch (e) { console.warn('Failed to delete session:', e); }
}

function updateSessionTitle(message) {
  const session = chatSessions.find(s => s.id === currentSessionId);
  if (session && session.title === 'New chat') {
    session.title = message.length > 40 ? message.slice(0, 40) + '...' : message;
    renderChatHistory();
    api(`/api/sessions/${session.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: session.title }),
    }).catch(() => {});
  }
}

function renderChatHistory() {
  const list = document.getElementById('chat-history-list');
  if (!list) return;
  list.innerHTML = chatSessions.map(s => {
    const isWriteBook = s.sessionType === 'write_book' || s.meta?.write_book;
    const icon = isWriteBook ? '<svg class="history-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>' : '';
    return `<div class="history-item-wrap ${s.id === currentSessionId ? 'active' : ''}" data-sid="${s.id}">
      <button class="history-item">${icon}${esc(s.title)}</button>
      <button class="history-delete" title="Delete">&times;</button>
    </div>`;
  }).join('');
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
  const bookIcon = `<svg class="chat-item-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>`;
  listEl.innerHTML = sessions.map(s => {
    const icon = s.sessionType === 'book' ? bookIcon : (s.mindId ? mindIcon : chatIcon);
    return `<div class="chats-list-item" data-sid="${s.id}">
      ${icon}
      <div class="chats-item-body">
        <div class="chat-item-title">${esc(s.title)}</div>
        ${s.updatedAt ? `<div class="chats-item-time">Last message ${timeAgo(s.updatedAt)}</div>` : ''}
      </div>
      <button class="chats-delete-btn" title="Delete">&times;</button>
    </div>`;
  }).join('');
  listEl.querySelectorAll('.chats-list-item').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.chats-delete-btn')) return;
      switchToSession(el.dataset.sid);
    });
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
let _inflightSessionId = null;
let _chatRenderGen = 0; // bumped each time onChatPageShow re-renders the chat box
let _globalChatAbort = null;

async function sendGlobalChat(message) {
  const chatBox = document.getElementById('chat-messages');

  if (getRoute().page !== 'chat') {
    pendingHomeMessage = message;
    window.location.hash = '#/chat';
    return;
  }

  // Abort any in-flight global chat request from previous message
  if (_globalChatAbort) { _globalChatAbort.abort(); _globalChatAbort = null; }
  removeLoading();

  // Cancel any in-flight minds invitation from previous message
  _mindsInviteGen++;
  removeMindsLoading();

  const abort = new AbortController();
  _globalChatAbort = abort;

  const mentionedNames = parseMentions(message);
  const contextMinds = [...selectedMinds.values()].filter(m => !mentionedNames.includes(m.name));

  if (!currentSessionId) await createSession();
  updateSessionTitle(message);
  const sentSessionId = currentSessionId;

  appendMsg(chatBox, 'user', message, null, null, mentionedNames.length > 0, contextMinds);
  showLoading(chatBox);

  _queueSessionMessage(sentSessionId, 'user', message, contextMinds.length ? { contextMinds: contextMinds.map(m => ({ name: m.name })) } : undefined);

  _inflightSessionId = sentSessionId;
  const renderGenAtStart = _chatRenderGen;

  try {
    const cleanMessage = mentionedNames.length ? stripMentions(message) : message;
    const agentIds = [];
    const bookContext = [];
    for (const [, book] of selectedBooks) {
      agentIds.push(book.agentId);
      bookContext.push({ title: book.title, author: book.author || '' });
    }

    const skipFeynman = (mentionedNames.length > 0 && activeMinds.size > 0) || selectedMinds.size > 0;

    if (!skipFeynman) {
      const body = { message: cleanMessage };
      if (bookContext.length) {
        body.agent_ids = agentIds;
        body.book_context = bookContext;
      }

      const session = chatSessions.find(s => s.id === sentSessionId);
      const history = (session?.messages || [])
        .filter(m => m.role === 'user' || m.role === 'assistant')
        .map(m => ({ role: m.role, content: m.content }));
      if (history.length) body.history = history;

      const data = await api('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: abort.signal,
      });

      const sources = (data.sources || []).map(s => ({ id: s.agent_id, name: s.agent_name }));
      const msgOpts = {};
      if (data.web_sources?.length) msgOpts.webSources = data.web_sources;
      if (data.grounded) msgOpts.grounded = true;
      if (data.references?.length) msgOpts.references = data.references;
      if (data.usage) msgOpts.usage = data.usage;

      const assistMeta = {};
      if (sources.length) assistMeta.sources = sources;
      if (Object.keys(msgOpts).length) assistMeta.opts = msgOpts;
      _queueSessionMessage(sentSessionId, 'assistant', data.answer, assistMeta);

      _inflightSessionId = null;

      if (currentSessionId !== sentSessionId) return;

      if (_chatRenderGen !== renderGenAtStart) {
        if (getRoute().page === 'chat') onChatPageShow();
        return;
      }

      if (getRoute().page !== 'chat') return;

      removeLoading();
      appendMsg(chatBox, 'assistant', data.answer, sources, msgOpts);
      renderChatSidebar(sources, message);
      if (sources.length) loadAgents();
      ensurePolling();
    } else {
      _inflightSessionId = null;
      if (currentSessionId !== sentSessionId) return;
      if (getRoute().page !== 'chat') return;
      removeLoading();
    }

    _inviteMindsToChat(chatBox, message, bookContext, agentIds, mentionedNames);
  } catch (err) {
    if (err.name === 'AbortError') return;
    _inflightSessionId = null;
    if (currentSessionId !== sentSessionId) return;
    if (_chatRenderGen !== renderGenAtStart) {
      if (getRoute().page === 'chat') onChatPageShow();
      return;
    }
    removeLoading();
    const msg = err.message.includes('No available provider')
      ? 'No LLM API key configured. Please add GEMINI_API_KEY, OPENAI_API_KEY, or KIMI_API_KEY to your .env file and restart the server.'
      : 'Error: ' + err.message;
    appendMsg(chatBox, 'assistant', msg);
  }
}

async function _saveMessageToDB(sessionId, role, content, meta) {
  const body = { role, content: content || '' };
  if (meta && Object.keys(meta).length) body.meta = meta;
  const prev = _sessionSaveChains.get(sessionId) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(async () => {
      try {
        await api(`/api/sessions/${sessionId}/messages`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
      } catch (e) {
        console.warn('Failed to save message:', e);
      }
    });
  _sessionSaveChains.set(sessionId, next);
  next.finally(() => {
    if (_sessionSaveChains.get(sessionId) === next) {
      _sessionSaveChains.delete(sessionId);
    }
  });
  return next;
}

function _queueSessionMessage(sessionId, role, content, meta) {
  if (!sessionId) return;
  const session = chatSessions.find(s => s.id === sessionId);
  if (session) {
    if (!session.messages) session.messages = [];
    session.messages.push({ role, content, ...(meta || {}) });
    session.updatedAt = Date.now();
  }
  _saveMessageToDB(sessionId, role, content, meta);
}

let _mindsInvitedOnce = false;
let _mindsInviteGen = 0;
const _sessionSaveChains = new Map();

/** When the system auto-suggests minds, ask before calling panel-chat. @mentions skip this (user already invited). */
function showMindJoinPrompt(chatBox, mindNames, inviteGen) {
  return new Promise((resolve) => {
    if (_mindsInviteGen !== inviteGen) {
      resolve(false);
      return;
    }
    const wrap = document.createElement('div');
    wrap.className = 'chat-system-notice';
    const names = mindNames.length === 1
      ? esc(mindNames[0])
      : mindNames.slice(0, -1).map(esc).join(', ') + ' and ' + esc(mindNames[mindNames.length - 1]);
    wrap.innerHTML = `<div class="mind-consent-inner">
      <span class="mind-consent-text">${names} wants to join</span>
      <span class="mind-consent-actions">
        <button type="button" class="mind-consent-btn mind-consent-allow">Allow</button>
        <button type="button" class="mind-consent-btn mind-consent-decline">Not now</button>
      </span>
    </div>`;
    const finish = (ok) => {
      wrap.remove();
      resolve(ok);
    };
    wrap.querySelector('.mind-consent-allow').addEventListener('click', () => {
      if (_mindsInviteGen !== inviteGen) {
        finish(false);
        return;
      }
      finish(true);
    });
    wrap.querySelector('.mind-consent-decline').addEventListener('click', () => finish(false));
    chatBox.appendChild(wrap);
    chatBox.scrollTop = chatBox.scrollHeight;
  });
}

async function _inviteMindsToChat(chatBox, message, bookContext, agentIds, targetMindNames, excludeMindId) {
  const sessionId = currentSessionId;
  const renderGenAtStart = _chatRenderGen;
  const inviteGen = ++_mindsInviteGen;
  const autoAddedMindIds = [];
  const onMindPage = getRoute().page === 'mind';

  try {
    const mindIds = [...activeMinds.keys()];
    for (const [id] of selectedMinds) {
      if (!mindIds.includes(id)) mindIds.push(id);
    }

    const hasMentions = targetMindNames && targetMindNames.length > 0;
    const skipSuggest = hasMentions || onMindPage || (!isProUser() && _mindsInvitedOnce);

    const allKnownNames = [...activeMinds.values(), ...selectedMinds.values()].map(m => m.name);
    const suggestCount = Math.floor(Math.random() * 3) + 1;
    const suggestBody = { count: suggestCount, exclude: allKnownNames };
    if (bookContext && bookContext.length) {
      suggestBody.book_title = bookContext[0].title;
      suggestBody.book_author = bookContext[0].author || '';
    } else {
      suggestBody.topic = message.slice(0, 100);
    }

    showMindsLoading(chatBox);

    const newJoinedNames = [];
    const invitedMindIds = [];
    for (const [id, m] of selectedMinds) {
      if (!activeMinds.has(id)) {
        activeMinds.set(id, m);
        newJoinedNames.push(m.name);
        invitedMindIds.push(id);
      }
    }

    if (!skipSuggest) {
      try {
        const suggestions = await api('/api/minds/suggest', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(suggestBody),
        });
        if (_mindsInviteGen !== inviteGen) { removeMindsLoading(); return; }
        for (const s of (suggestions.minds || [])) {
          if (_mindsInviteGen !== inviteGen) { removeMindsLoading(); return; }
          try {
            const mind = await api('/api/minds/generate', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ name: s.name, era: s.era || '', domain: s.domain || '', link_works: false }),
            });
            if (_mindsInviteGen !== inviteGen) { removeMindsLoading(); return; }
            if (!mindIds.includes(mind.id)) {
              mindIds.push(mind.id);
              if (!activeMinds.has(mind.id)) {
                activeMinds.set(mind.id, { id: mind.id, name: mind.name });
                newJoinedNames.push(mind.name);
                autoAddedMindIds.push(mind.id);
              }
            }
          } catch (genErr) { console.warn('[minds] generate failed for', s.name, genErr); }
        }
      } catch (suggestErr) { console.warn('[minds] suggest failed:', suggestErr); }
    }

    if (_mindsInviteGen !== inviteGen) { removeMindsLoading(); return; }

    // Fallback: if suggest/generate yielded no minds, pick from existing seed minds
    if (!mindIds.length && allMinds.length) {
      const topic = (bookContext?.[0]?.title || message || '').toLowerCase();
      const words = topic.split(/\s+/).filter(w => w.length > 3);
      const scored = allMinds.map(m => {
        const hay = ((m.domain || '') + ' ' + (m.era || '') + ' ' + (m.name || '')).toLowerCase();
        const score = words.reduce((s, w) => s + (hay.includes(w) ? 1 : 0), 0);
        return { m, score };
      });
      scored.sort((a, b) => b.score - a.score || Math.random() - 0.5);
      const pickCount = Math.min(2, scored.length);
      for (let i = 0; i < pickCount; i++) {
        const { m } = scored[i];
        mindIds.push(m.id);
        if (!activeMinds.has(m.id)) {
          activeMinds.set(m.id, { id: m.id, name: m.name });
          newJoinedNames.push(m.name);
          autoAddedMindIds.push(m.id);
        }
      }
      console.info('[minds] Used fallback seed minds:', newJoinedNames.join(', '));
    }

    removeMindsLoading();

    if (!mindIds.length) {
      console.warn('[minds] No minds available at all (no seed minds either). skipSuggest=', skipSuggest, 'hasMentions=', hasMentions);
      return;
    }
    if (_mindsInviteGen !== inviteGen) return;

    if (!hasMentions && autoAddedMindIds.length > 0) {
      const consentNames = autoAddedMindIds.map((id) => activeMinds.get(id)?.name).filter(Boolean);
      const allowed = await showMindJoinPrompt(chatBox, consentNames, inviteGen);
      if (_mindsInviteGen !== inviteGen) return;
      if (!allowed) {
        for (const id of autoAddedMindIds) activeMinds.delete(id);
        mindIds.length = 0;
        mindIds.push(...activeMinds.keys());
        for (const [id] of selectedMinds) {
          if (!mindIds.includes(id)) mindIds.push(id);
        }
        loadMinds();
        _updateComposerMentionHint();
        if (!mindIds.length) return;
      }
    }

    if (_mindsInviteGen !== inviteGen) return;

    const history = [];
    chatBox.querySelectorAll('.chat-message:not(#loading-msg):not(.minds-loading-notice)').forEach(el => {
      if (el.classList.contains('mind-message')) {
        history.push({ role: 'assistant', content: `[${el.dataset.mindName}]: ${el.dataset.raw}` });
      } else {
        const role = el.classList.contains('user') ? 'user' : 'assistant';
        history.push({ role, content: el.dataset.raw || el.textContent });
      }
    });

    const cleanMessage = hasMentions ? stripMentions(message) : message;
    const panelMindIds = excludeMindId ? mindIds.filter(id => id !== excludeMindId) : mindIds;
    if (!panelMindIds.length) return;
    const panelBody = { message: cleanMessage, mind_ids: panelMindIds, history };
    if (bookContext?.length) panelBody.book_context = bookContext;
    if (agentIds?.length) panelBody.agent_ids = agentIds;
    if (invitedMindIds.length) panelBody.invited_mind_ids = invitedMindIds;
    if (hasMentions) panelBody.target_minds = targetMindNames;

    const panelData = await api('/api/minds/panel-chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(panelBody),
    });

    if (_mindsInviteGen !== inviteGen) return;

    if (panelData.responses?.length) {
      const respondedNames = new Set();
      for (const r of panelData.responses) {
        if (r.response && !r.response.startsWith('[')) {
          respondedNames.add(r.mind_name);
        }
      }
      // Remove newly added minds that failed to respond
      for (const [id, m] of activeMinds) {
        if (newJoinedNames.includes(m.name) && !respondedNames.has(m.name)) {
          activeMinds.delete(id);
        }
      }

      const joinedRespondedNames = newJoinedNames.filter(name => respondedNames.has(name));

      // Queue persistence even if user navigated away so the session stays recoverable.
      if (joinedRespondedNames.length) {
        _queueSessionMessage(sessionId, 'system-notice', '', { mindNames: joinedRespondedNames });
      }
      for (const r of panelData.responses) {
        if (r.response && !r.response.startsWith('[')) {
          _queueSessionMessage(sessionId, 'mind', r.response, { mindName: r.mind_name });
        }
      }

      const currentPage = getRoute().page;
      const stillOnSamePage = currentSessionId === sessionId
        && _chatRenderGen === renderGenAtStart
        && (currentPage === 'chat' || currentPage === 'mind');

      if (stillOnSamePage) {
        if (joinedRespondedNames.length) {
          appendJoinNotice(chatBox, joinedRespondedNames);
        }
        for (const r of panelData.responses) {
          if (r.response && !r.response.startsWith('[')) {
            appendMindMsg(chatBox, r.mind_name, r.response);
            if (onMindPage) {
              mindChatHistory.push({ role: 'assistant', content: `[${r.mind_name}]: ${r.response}` });
            }
          }
        }
        if (onMindPage) _saveMindSession(chatBox);
      } else if (currentSessionId === sessionId && (currentPage === 'chat' || currentPage === 'mind')) {
        if (currentPage === 'chat') onChatPageShow();
      }
      _mindsInvitedOnce = true;
      loadMinds();
      _updateComposerMentionHint();
    }
  } catch (err) {
    removeMindsLoading();
    console.log('Mind chat failed:', err.message);
  }
}

function handleHomeSend() {
  const input = document.getElementById('home-input');
  const msg = input.value.trim();
  if (!msg) return;
  if (selectedMinds.size && !isProUser()) { showProOverlay(); return; }
  input.value = '';
  input.style.height = 'auto';
  currentSessionId = null;
  sendGlobalChat(msg);
}

function handleChatSend() {
  const input = document.getElementById('chat-input');
  const msg = input.value.trim();
  if (!msg) return;
  input.value = '';
  input.style.height = 'auto';
  if (_isWriteBookSession()) {
    _handleWriteBookMessage(msg);
  } else {
    sendGlobalChat(msg);
  }
}

async function onChatPageShow() {
  const route = getRoute();
  // Only resolve #/chat/<id> after sessions are loaded — init calls navigate() before restoreSessions().
  if (route.page === 'chat' && route.sessionId && chatSessions.length) {
    if (chatSessions.some(s => s.id === route.sessionId)) {
      if (currentSessionId !== route.sessionId) {
        await switchToSession(route.sessionId);
        return;
      }
    } else {
      // Stale bookmark — drop unknown session id from the URL
      if (currentSessionId) _setChatHashForSession(currentSessionId);
      else history.replaceState(null, '', '#/chat');
    }
  }

  renderSelectedChips();
  renderChatHistory();
  _updateComposerMentionHint();

  if (pendingHomeMessage) {
    const msg = pendingHomeMessage;
    pendingHomeMessage = null;
    setTimeout(() => sendGlobalChat(msg), 50);
    return;
  }

  const chatBox = document.getElementById('chat-messages');
  if (!currentSessionId) return;

  const session = chatSessions.find(s => s.id === currentSessionId);

  if (session && !session.messages?.length) {
    try {
      const msgs = await api(`/api/sessions/${currentSessionId}/messages`);
      session.messages = msgs.map(m => ({ role: m.role, content: m.content, ...m.meta }));
    } catch (e) {
      console.warn('Failed to load session messages:', e);
    }
  }

  _chatRenderGen++;
  chatBox.innerHTML = '';
  if (session?.messages?.length) {
    for (const m of session.messages) {
      if (m.role === 'mind') {
        appendMindMsg(chatBox, m.mindName, m.content);
      } else if (m.role === 'system-notice') {
        appendJoinNotice(chatBox, m.mindNames || []);
      } else {
        const cm = m.role === 'user' ? m.contextMinds : undefined;
        appendMsg(chatBox, m.role, m.content, m.sources, m.opts, false, cm);
      }
    }
    restoreChatSidebar(session.messages);
  }

  if (_inflightSessionId === currentSessionId) {
    showLoading(chatBox);
  }

  _restoreWriteBookState(session, chatBox);
  if (currentSessionId) _setChatHashForSession(currentSessionId);
}

// ─── Chat sidebar (right) ───
// Snapshot of books used in the conversation (independent of selectedBooks chips)
let _sidebarBooks = new Map();

function renderChatSidebar(sources, query) {
  _sidebarBooks = new Map(selectedBooks);

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
  if (related.length) {
    relEl.innerHTML = related.map(b => sidebarBookItem(b.agentId || b.id, b.title, b.author, b.isbn)).join('');
    showChatRightSidebar();
  } else {
    relEl.innerHTML = '';
    hideChatRightSidebar();
  }
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
  renderDiscoverBar();
  const c = document.getElementById('library-grid');
  let filtered = [...allBooks];
  if (libraryFilter === 'available') filtered = filtered.filter(b => b.hasFullText);
  else if (libraryFilter === 'recent') filtered.sort((a,b) => (b.created_at||'').localeCompare(a.created_at||''));
  else filtered.sort((a,b) => a.title.localeCompare(b.title));
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
        <span class="loading-dot">Looking up "${esc(librarySearch)}" — will add it if found...</span>
      </div>`;
    } else {
      c.innerHTML = `<div class="search-discover-prompt"><p style="color:var(--text-muted)">Couldn't find "${esc(librarySearch)}" — try a different title or author</p></div>`;
    }
  }
  
  // Show token usage for search/discover inline
  if (_searchUsage && _searchUsage.total_tokens > 0) {
    c.insertAdjacentHTML('beforeend',
      `<div class="token-usage" style="grid-column:1/-1;text-align:center;margin-top:8px" title="Input: ${_searchUsage.input_tokens} · Output: ${_searchUsage.output_tokens}">${_searchUsage.total_tokens} tokens</div>`);
  }
}

async function discoverMore(topics) {
  for (const topic of topics) {
    loadingTopics.add(topic);
  }
  renderTopicTags();
  const barBtn = document.getElementById('discover-bar-btn');
  if (barBtn) { barBtn.textContent = 'Discovering...'; barBtn.disabled = true; }
  try {
    let totalTokens = 0;
    for (const topic of topics) {
      const count = Math.floor(Math.random() * 3) + 1;
      const data = await api('/api/discover', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ topic, count }),
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
  if (!books.length) {
    if (booksLoadState === 'loading' || booksLoadState === 'idle') {
      container.innerHTML = '<div class="empty-state"><span class="loading-dot">Loading books...</span></div>';
      return;
    }
    container.innerHTML = '<div class="empty-state"><p>No books found.</p></div>';
    return;
  }
  container.innerHTML = books.map(b => {
    const coverBg = b.isAIGenerated ? 'background:linear-gradient(135deg,#667eea 0%,#764ba2 100%)' : `background:${coverColor(b.title)}`;
    const cover = `<div class="card-cover-gen" style="${coverBg}"><span>${coverInitials(b.title)}</span></div>`;
    let statusBadge = '';
    if (b.isAIGenerated && b.status === 'failed') {
      statusBadge = '<span class="card-badge" style="background:var(--error-color,#e55);color:#fff">Failed</span>';
    } else if (b.isAIGenerated && b.status === 'error') {
      statusBadge = '<span class="card-badge" style="background:var(--error-color,#e55);color:#fff">Failed</span>';
    } else if (b.isAIGenerated && (b.status === 'writing' || b.status === 'outlining' || b.status === 'confirmed')) {
      statusBadge = '<span class="card-badge indexing">Writing...</span>';
    } else if (b.status === 'indexing') {
      statusBadge = '<span class="card-badge indexing">Indexing...</span>';
    }
    const _alwaysShowDelete = b.isAIGenerated && (b.status === 'failed' || b.status === 'error');
    const deleteBtn = (b.isUploaded || b.isCatalog || b.isAIGenerated) && b.agentId ? `<button class="card-delete-btn" onclick="event.stopPropagation();deleteBook('${esc(b.agentId)}')" title="Delete"${_alwaysShowDelete ? ' style="opacity:1"' : ''}>&times;</button>` : '';
    const canRead = b.hasFullText && b.agentId;
    const canPreview = !b.hasFullText && b.status === 'ready' && b.agentId;
    const overlayLabel = canRead ? 'Read' : (canPreview ? 'Preview' : '');
    const readOverlay = overlayLabel ? `<div class="card-cover-overlay" onclick="event.stopPropagation();window.location.hash='#/read/${esc(b.agentId)}'"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg><span>${overlayLabel}</span></div>` : '';
    return `<div class="book-card" onclick="selectBookForChat('${esc(b.id)}')">
      ${deleteBtn}
      <div class="card-cover-wrap">${cover}${readOverlay}</div>
      <div class="card-body"><h3 class="card-title">${esc(b.title)}</h3><p class="card-author">${b.isAIGenerated ? (b.creatorName ? `by ${esc(b.creatorName)} · AI` : 'AI-generated') : esc(b.author)}</p></div>
      <div class="card-footer">
        <button class="card-chat-btn" onclick="event.stopPropagation();selectBookForChat('${esc(b.id)}')">Chat</button>
        ${statusBadge}
        <button class="upvote-btn" onclick="event.stopPropagation();handleUpvote('${esc(b.title)}')">&#9650;${b.upvotes ? ' ' + b.upvotes : ''}</button>
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

// ─── Rename book (inline edit) ───
function isBookOwner(book) {
  if (!currentUser) return false;
  return book?.userId && book.userId === currentUser.id;
}

async function renameBook(agentId, newName) {
  const trimmed = newName.trim();
  if (!trimmed) return false;
  try {
    await api('/api/agents/' + agentId, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: trimmed }),
    });
    await loadAgents();
    return true;
  } catch (err) {
    _showToast('Rename failed: ' + err.message);
    return false;
  }
}

function makeEditableTitle(el, agentId, currentTitle, onRenamed) {
  el.style.cursor = 'pointer';
  el.title = 'Click to rename';
  el.addEventListener('click', (e) => {
    if (el.querySelector('input')) return;
    e.stopPropagation();
    const input = document.createElement('input');
    input.type = 'text';
    input.value = currentTitle;
    input.className = 'inline-title-input';
    input.style.cssText = `font:inherit;width:100%;background:var(--bg-secondary,#f5f5f5);border:1px solid var(--border-color,#ddd);border-radius:6px;padding:4px 8px;outline:none;color:inherit;`;
    const origHtml = el.innerHTML;
    el.innerHTML = '';
    el.appendChild(input);
    input.focus();
    input.select();
    const finish = async () => {
      const v = input.value.trim();
      if (v && v !== currentTitle) {
        el.innerHTML = esc(v);
        const ok = await renameBook(agentId, v);
        if (!ok) el.innerHTML = origHtml;
        else {
          currentTitle = v;
          if (onRenamed) onRenamed(v);
          if (getRoute().page === 'library') renderLibraryGrid();
        }
      } else {
        el.innerHTML = origHtml;
      }
      makeEditableTitle(el, agentId, currentTitle, onRenamed);
    };
    input.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); finish(); }
      if (ev.key === 'Escape') { el.innerHTML = origHtml; makeEditableTitle(el, agentId, currentTitle, onRenamed); }
    });
    input.addEventListener('blur', finish);
  }, { once: true });
}

// ─── Share book ───
async function shareBook(title, agentId) {
  const url = `${window.location.origin}/share/${agentId}?t=${Math.floor(Date.now()/86400000)}`;
  try {
    await navigator.clipboard.writeText(url);
    _showToast('Link copied');
  } catch (_) {
    prompt('Copy this link:', url);
  }
}

function _showToast(msg) {
  let t = document.getElementById('share-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'share-toast';
    t.className = 'share-toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.remove('show');
  void t.offsetWidth;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2200);
}
window.shareBook = shareBook;

// ─── AI Book Writing ───

function _stopWriteBookPolling() {
  if (_writeBookPolling) {
    clearInterval(_writeBookPolling);
    _writeBookPolling = null;
  }
  _writeBookPollSessionId = null;
}

async function _restoreWriteBookState(session, chatBox) {
  _stopWriteBookPolling();
  const meta = session?.meta || session?.books?.get?.('_meta') || {};
  if (!(session?.sessionType === 'write_book' || meta.write_book)) {
    if (_writeBookAbort) { _writeBookAbort.abort(); _writeBookAbort = null; }
    _writeBookId = null;
    _writeBookOutline = null;
    _hideBookCanvas();
    return;
  }
  const aiBookId = meta.ai_book_id;
  if (!aiBookId) {
    if (_writeBookAbort) { _writeBookAbort.abort(); _writeBookAbort = null; }
    _writeBookId = null;
    _writeBookOutline = null;
    _hideBookCanvas();
    return;
  }
  const restoreSessionId = session?.id;
  _writeBookId = aiBookId;
  _writeBookAgentId = meta.agent_id || null;
  try {
    const book = await api(`/api/ai-books/${aiBookId}`);
    if (restoreSessionId && restoreSessionId !== currentSessionId) return;
    _writeBookOutline = book.outline;
    if (book.status === 'writing') {
      _startWritingPoll(aiBookId, chatBox);
    } else if (book.status === 'completed' || book.status === 'cancelled' || book.status === 'failed') {
      _showBookCanvas(_renderCanvasWritingProgress(book), book);
    } else if (book.status === 'outlining') {
      _showBookCanvas(_renderCanvasOutline(book.outline, aiBookId));
    }
  } catch (e) { console.warn('Failed to restore write-book state:', e); }
}

let _startingWriteBook = false;
async function startWriteBook() {
  if (_startingWriteBook) return;
  if (!currentUser && window.FEYNMAN_PRO) {
    window.location.hash = '#/login';
    return;
  }
  if (window.FEYNMAN_PRO && !isProUser()) {
    showProOverlay();
    return;
  }
  _startingWriteBook = true;
  try {
    await createSession();
    const sessionId = currentSessionId;
    const session = chatSessions.find(s => s.id === sessionId);
    if (session) {
      session.sessionType = 'write_book';
      session.title = 'New book';
    }
    try {
      await api(`/api/sessions/${sessionId}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ meta: { write_book: true } }),
      });
    } catch (e) { console.warn('Failed to update session type:', e); }

    const greeting = "I'd love to help you create a book. Tell me what you're interested in — a person, an idea, a skill, or even a book that doesn't exist yet but you wish it did.\n\nYou can be as specific or broad as you like. For example:\n- *\"A biography of Elon Musk focused on his engineering decisions\"*\n- *\"A beginner's guide to quantum computing in plain language\"*\n- *\"The history of coffee and how it shaped civilization\"*";
    _queueSessionMessage(sessionId, 'assistant', greeting);
    window.location.hash = '#/chat/' + sessionId;
  } finally {
    _startingWriteBook = false;
  }
}
window.startWriteBook = startWriteBook;

function _wireCanvasShareMenus(root, book) {
  if (!book?.agent_id) return;
  const shareUrl = `${window.location.origin}/share/${encodeURIComponent(book.agent_id)}?t=${Math.floor(Date.now()/86400000)}`;
  const _canvasAuthor = book.creator_name || '';
  const twitterText = encodeURIComponent(`${book.title || ''} — by ${_canvasAuthor || 'AI'} on feynman.wiki`);
  const twitterUrl = encodeURIComponent(shareUrl);
  const tweetIntentUrl = `https://twitter.com/intent/tweet?text=${twitterText}&url=${twitterUrl}`;
  const emailSubject = encodeURIComponent(book.title || 'Check out this book');
  const emailBody = encodeURIComponent(`Check out "${book.title || ''}" on feynman.wiki:\n${shareUrl}`);
  const mailtoUrl = `mailto:?subject=${emailSubject}&body=${emailBody}`;

  root.querySelectorAll('.canvas-share-wrap').forEach(wrap => {
    const trigger = wrap.querySelector('.canvas-share-trigger');
    const xBtn = wrap.querySelector('.canvas-share-x');
    const copyBtn = wrap.querySelector('.canvas-share-copy');
    const mailBtn = wrap.querySelector('.canvas-share-mail');
    if (trigger) trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      wrap.classList.toggle('open');
    });
    if (xBtn) xBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.open(tweetIntentUrl, '_blank');
      wrap.classList.remove('open');
    });
    if (copyBtn) copyBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      navigator.clipboard.writeText(shareUrl);
      _showToast('Link copied');
      wrap.classList.remove('open');
    });
    if (mailBtn) mailBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      window.open(mailtoUrl);
      wrap.classList.remove('open');
    });
  });
}

function _showBookCanvas(html, shareWireBook) {
  const canvas = document.getElementById('book-canvas');
  const content = document.getElementById('book-canvas-content');
  if (!canvas || !content) return;
  content.innerHTML = html;
  if (shareWireBook) _wireCanvasShareMenus(content, shareWireBook);
  if (!canvas.classList.contains('visible')) {
    canvas.classList.add('visible');
    document.getElementById('chat-right-sidebar')?.classList.remove('visible');
  }
}

function _hideBookCanvas() {
  const canvas = document.getElementById('book-canvas');
  if (!canvas) return;
  canvas.classList.remove('visible');
  canvas.style.width = '';
  const chatMain = document.querySelector('.chat-with-sidebar .chat-main');
  if (chatMain) { chatMain.style.flex = ''; chatMain.style.width = ''; }
}

// ─── Canvas resize handle ───
(function initCanvasResize() {
  let startX = 0, startChatW = 0, startCanvasW = 0, dragging = false;
  const handle = document.getElementById('book-canvas-resize');
  if (!handle) return;

  handle.addEventListener('mousedown', e => {
    const canvas = document.getElementById('book-canvas');
    const chatMain = document.querySelector('.chat-with-sidebar .chat-main');
    if (!canvas?.classList.contains('visible') || !chatMain) return;
    e.preventDefault();
    dragging = true;
    startX = e.clientX;
    startChatW = chatMain.getBoundingClientRect().width;
    startCanvasW = canvas.getBoundingClientRect().width;
    handle.classList.add('dragging');
    document.body.classList.add('canvas-resizing');
    canvas.style.transition = 'none';
  });

  document.addEventListener('mousemove', e => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const canvas = document.getElementById('book-canvas');
    const chatMain = document.querySelector('.chat-with-sidebar .chat-main');
    if (!canvas || !chatMain) return;
    const newChatW = Math.max(280, startChatW + dx);
    const newCanvasW = Math.max(360, startCanvasW - dx);
    chatMain.style.flex = 'none';
    chatMain.style.width = newChatW + 'px';
    canvas.style.width = newCanvasW + 'px';
  });

  document.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    const handle = document.getElementById('book-canvas-resize');
    handle?.classList.remove('dragging');
    document.body.classList.remove('canvas-resizing');
    const canvas = document.getElementById('book-canvas');
    if (canvas) canvas.style.transition = '';
  });
})();

function _renderCanvasOutline(outline, bookId) {
  const chapters = outline.chapters || [];
  const totalWords = chapters.reduce((s, c) => s + (c.estimated_words || 0), 0);
  const chapterList = chapters.map((c, i) => {
    const points = (c.key_points || []).map(p => `<li>${esc(p)}</li>`).join('');
    const expandedCls = i === 0 ? ' expanded' : '';
    return `<div class="canvas-chapter${expandedCls}" onclick="this.classList.toggle('expanded')">
      <div class="canvas-ch-header">
        <span class="canvas-ch-num">${c.number}</span>
        <span class="canvas-ch-title">${esc(c.title)}</span>
        <svg class="canvas-ch-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>
      </div>
      <div class="canvas-ch-detail">
        <p class="canvas-ch-summary">${esc(c.summary)}</p>
        ${points ? `<ul class="canvas-ch-points">${points}</ul>` : ''}
        <span class="canvas-ch-words">~${(c.estimated_words || 0).toLocaleString()} words</span>
      </div>
    </div>`;
  }).join('');

  return `<div class="canvas-book-header">
    <div class="canvas-book-title">${esc(outline.title || 'Untitled')}</div>
    <div class="canvas-book-subtitle">${esc(outline.subtitle || '')}</div>
    <div class="canvas-book-meta">
      <span class="canvas-book-stats">${chapters.length} chapters · ~${Math.round(totalWords / 1000)}k words</span>
      <button class="canvas-confirm-btn" onclick="_confirmWriteBook('${esc(bookId || '')}')"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>Start Writing</button>
    </div>
  </div>
  <div class="canvas-divider"></div>
  <div class="canvas-chapters">${chapterList}</div>`;
}

function _renderWritingProgress(book) {
  const chapters = book.outline?.chapters || [];
  const total = book.chapters_total || chapters.length;
  const written = book.chapters_written || 0;
  const pct = total > 0 ? Math.round((written / total) * 100) : 0;
  const content = book.content || {};
  const isCancelled = book.status === 'cancelled';
  const isFinished = book.status === 'completed' || book.status === 'failed' || isCancelled;

  const chList = chapters.map(c => {
    const chData = content[String(c.number)];
    let stateClass = 'pending', icon = '—', detail = 'Waiting...', words = '';
    if (chData && chData.content) {
      stateClass = 'done'; icon = '✓'; detail = 'Completed';
      words = `${(chData.word_count || 0).toLocaleString()} words`;
    } else if (c.number <= written) {
      stateClass = 'done'; icon = '✓'; detail = 'Completed';
    } else if (isCancelled) {
      stateClass = 'pending'; icon = '—'; detail = 'Cancelled';
    } else if (written + 1 === c.number || (written === 0 && c.number === 1 && book.status === 'writing')) {
      stateClass = 'active'; icon = '✎'; detail = 'Writing...';
    }
    return `<div class="progress-ch ${stateClass}">
      <div class="progress-ch-icon ${stateClass}">${icon}</div>
      <div class="progress-ch-info">
        <div class="progress-ch-title">Ch.${c.number}: ${esc(c.title)}</div>
        <div class="progress-ch-detail">${detail}</div>
      </div>
      <div class="progress-ch-words">${words}</div>
    </div>`;
  }).join('');

  let statusIcon = '✍️', statusLabel = 'Writing';
  if (book.status === 'completed') { statusIcon = '✓'; statusLabel = 'Completed'; }
  else if (isCancelled) { statusIcon = '⏹'; statusLabel = 'Cancelled'; }
  else if (book.status === 'failed') { statusIcon = '✗'; statusLabel = 'Failed'; }

  const footerMsg = book.status === 'completed'
    ? `<div class="writing-done-msg">
        <span>Your book is ready!</span>
        <button class="writing-library-btn" onclick="window.location.hash='#/read/${esc(book.agent_id)}'">Read Book</button>
        <button class="writing-library-btn secondary" onclick="shareBook('${esc(book.title)}','${esc(book.agent_id)}')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg> Share</button>
        <button class="writing-library-btn secondary" onclick="window.location.hash='#/library'">Library</button>
      </div>`
    : isCancelled
    ? `<div class="writing-done-msg cancelled">
        <span>Writing stopped — ${written} of ${total} chapters written</span>
        ${written > 0 ? `<button class="writing-library-btn" onclick="window.location.hash='#/library'">View Partial Book</button>` : ''}
      </div>`
    : '';

  const cancelBtn = (book.status === 'writing')
    ? `<button class="writing-cancel-btn" onclick="_cancelWriteBook('${esc(book.id)}')">Stop Writing</button>`
    : '';

  return `<div class="writing-progress-card">
    <div class="writing-progress-header">
      <span class="writing-progress-icon">${statusIcon}</span>
      <span class="writing-progress-title">${statusLabel}: ${esc(book.title)}</span>
      ${cancelBtn}
    </div>
    <div class="writing-progress-bar-wrap">
      <div class="writing-progress-label">
        <span>${book.status === 'completed' ? 'All chapters complete' : `Chapter ${Math.min(written + 1, total)} of ${total}`}</span>
        <span>${pct}%</span>
      </div>
      <div class="writing-progress-bar"><div class="writing-progress-fill ${isCancelled ? 'cancelled' : ''}" style="width:${pct}%"></div></div>
    </div>
    <div class="writing-progress-chapters">${chList}</div>
    ${footerMsg}
  </div>`;
}

function _renderCanvasWritingProgress(book) {
  const chapters = book.outline?.chapters || [];
  const total = book.chapters_total || chapters.length;
  const written = book.chapters_written || 0;
  const pct = total > 0 ? Math.round((written / total) * 100) : 0;
  const content = book.content || {};
  const isCancelled = book.status === 'cancelled';

  let statusLabel = 'Writing...';
  if (book.status === 'completed') statusLabel = 'Completed';
  else if (isCancelled) statusLabel = 'Cancelled';
  else if (book.status === 'failed') statusLabel = 'Failed';

  const chList = chapters.map(c => {
    const chData = content[String(c.number)];
    let stateClass = 'pending', icon = '—', detail = 'Waiting...', words = '';
    if (chData && chData.content) {
      stateClass = 'done'; icon = '✓'; detail = 'Completed';
      words = `${(chData.word_count || 0).toLocaleString()} words`;
    } else if (c.number <= written) {
      stateClass = 'done'; icon = '✓'; detail = 'Completed';
    } else if (isCancelled) {
      stateClass = 'pending'; icon = '—'; detail = 'Cancelled';
    } else if (written + 1 === c.number || (written === 0 && c.number === 1 && book.status === 'writing')) {
      stateClass = 'active'; icon = '✎'; detail = 'Writing...';
    }
    return `<div class="progress-ch ${stateClass}">
      <div class="progress-ch-icon ${stateClass}">${icon}</div>
      <div class="progress-ch-info">
        <div class="progress-ch-title">Ch.${c.number}: ${esc(c.title)}</div>
        <div class="progress-ch-detail">${detail}</div>
      </div>
      <div class="progress-ch-words">${words}</div>
    </div>`;
  }).join('');

  const cancelBtn = (book.status === 'writing')
    ? `<button class="canvas-cancel-btn" onclick="_cancelWriteBook('${esc(book.id)}')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>Stop Writing</button>`
    : '';

  let footer = '';
  if (book.status === 'completed') {
    footer = `<div class="canvas-divider"></div>
      <div class="canvas-done-label">Your book is ready!</div>
      <div class="canvas-done-actions">
        <button class="canvas-action-btn" onclick="chatWithBookByAgent('${esc(book.agent_id)}')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          Chat
        </button>
        <button class="canvas-action-btn" onclick="window.location.hash='#/read/${esc(book.agent_id)}'">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
          Read
        </button>
        <div class="canvas-share-wrap">
          <button type="button" class="canvas-action-btn canvas-share-trigger">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
            Share
          </button>
          <div class="canvas-share-popup">
            <button type="button" class="canvas-share-opt canvas-share-x">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
              Share on Twitter
            </button>
            <button type="button" class="canvas-share-opt canvas-share-copy">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
              Copy URL
            </button>
            <button type="button" class="canvas-share-opt canvas-share-mail">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
              Send via Email
            </button>
          </div>
        </div>
      </div>`;
  } else if (book.status === 'failed') {
    footer = `<div class="canvas-divider"></div>
      <div class="canvas-done-label" style="color:var(--error-color,#e55)">Writing failed at chapter ${written + 1} of ${total}</div>
      <div class="canvas-done-actions">
        <button class="canvas-action-btn" style="background:var(--accent-color,#5b8a72);color:#fff" onclick="_retryWriteBook('${esc(book.id)}')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
          Retry
        </button>
      </div>`;
  } else if (isCancelled && written > 0) {
    footer = `<div class="canvas-divider"></div>
      <div class="canvas-done-label" style="color:var(--text-secondary)">Writing stopped — ${written} of ${total} chapters</div>
      <div class="canvas-done-actions">
        <button class="canvas-action-btn" onclick="chatWithBookByAgent('${esc(book.agent_id)}')">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
          Chat
        </button>
        <button class="canvas-action-btn" onclick="window.location.hash='#/read/${esc(book.agent_id)}'">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>
          Read
        </button>
        <div class="canvas-share-wrap">
          <button type="button" class="canvas-action-btn canvas-share-trigger">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
            Share
          </button>
          <div class="canvas-share-popup">
            <button type="button" class="canvas-share-opt canvas-share-x">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
              Share on Twitter
            </button>
            <button type="button" class="canvas-share-opt canvas-share-copy">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
              Copy URL
            </button>
            <button type="button" class="canvas-share-opt canvas-share-mail">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>
              Send via Email
            </button>
          </div>
        </div>
      </div>`;
  }

  return `<div class="canvas-book-header">
    <div class="canvas-book-title">${esc(book.title || book.outline?.title || 'Untitled')}</div>
    <div class="canvas-book-subtitle">${statusLabel}</div>
    <div class="canvas-book-meta">
      <span class="canvas-book-stats">${book.status === 'completed' ? 'All chapters complete' : `Chapter ${Math.min(written + 1, total)} of ${total}`} · ${pct}%</span>
      ${cancelBtn}
    </div>
    <div class="canvas-progress-bar" style="margin-top:12px">
      <div class="writing-progress-bar"><div class="writing-progress-fill ${isCancelled ? 'cancelled' : ''}" style="width:${pct}%"></div></div>
    </div>
  </div>
  <div class="canvas-divider"></div>
  <div class="writing-progress-chapters">${chList}</div>
  ${footer}`;
}

const _OUTLINE_STAGES = [
  'Thinking...',
  'Researching the topic...',
  'Identifying key themes...',
  'Structuring chapters...',
  'Building your book outline...',
  'Almost there...',
];
const _REFINE_STAGES = [
  'Thinking...',
  'Reviewing your feedback...',
  'Updating the outline...',
];

async function _handleWriteBookMessage(message) {
  const chatBox = document.getElementById('chat-messages');
  const sessionId = currentSessionId;

  // Abort any in-flight write-book request and bump generation counter
  if (_writeBookAbort) { _writeBookAbort.abort(); _writeBookAbort = null; }
  _writeBookGen++;
  const gen = _writeBookGen;
  removeLoading();

  const abort = new AbortController();
  _writeBookAbort = abort;

  appendMsg(chatBox, 'user', message);
  _queueSessionMessage(sessionId, 'user', message);

  // Phase 1: No book yet — generate outline
  // NOTE: no abort signal — outline generation takes ~20s and must survive
  // the user navigating to another chat and back.
  if (!_writeBookId) {
    showLoading(chatBox, _OUTLINE_STAGES);
    try {
      const data = await api('/api/ai-books/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ description: message, language: _detectLanguage(message) }),
      });

      // Always persist session meta so _restoreWriteBookState can recover
      _queueSessionMessage(sessionId, 'assistant', data.ai_message);
      try {
        await api(`/api/sessions/${sessionId}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: data.title, meta: { write_book: true, ai_book_id: data.id, agent_id: data.agent_id } }),
        });
        const s = chatSessions.find(x => x.id === sessionId);
        if (s) s.title = data.title;
      } catch (e) { console.warn(e); }

      // Only update in-memory state & UI if user is still on this session
      if (gen !== _writeBookGen) {
        renderChatHistory();
        return;
      }
      _writeBookId = data.id;
      _writeBookAgentId = data.agent_id;
      _writeBookOutline = data.outline;

      removeLoading();
      appendMsg(chatBox, 'assistant', data.ai_message);
      _showBookCanvas(_renderCanvasOutline(data.outline, data.id));
      renderChatHistory();
    } catch (err) {
      if (err.name === 'AbortError' || gen !== _writeBookGen) return;
      removeLoading();
      appendMsg(chatBox, 'assistant', 'Sorry, I couldn\'t generate an outline: ' + err.message);
    }
    return;
  }

  // Phase 2: Outline exists — refine it
  showLoading(chatBox, _REFINE_STAGES);
  try {
    const session = chatSessions.find(s => s.id === sessionId);
    const history = (session?.messages || [])
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(-6)
      .map(m => ({ role: m.role, content: m.content }));

    const data = await api(`/api/ai-books/${_writeBookId}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message, history }),
      signal: abort.signal,
    });
    if (gen !== _writeBookGen) return;

    _writeBookOutline = data.outline;
    removeLoading();
    appendMsg(chatBox, 'assistant', data.response);
    _queueSessionMessage(sessionId, 'assistant', data.response);

    // Update outline in canvas panel
    _showBookCanvas(_renderCanvasOutline(data.outline, _writeBookId));
  } catch (err) {
    if (err.name === 'AbortError' || gen !== _writeBookGen) return;
    removeLoading();
    appendMsg(chatBox, 'assistant', 'Error updating outline: ' + err.message);
  }
}

async function _confirmWriteBook(bookId) {
  if (!bookId) return;
  const chatBox = document.getElementById('chat-messages');

  const btn = document.querySelector('#book-canvas .canvas-confirm-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<span class="btn-spinner"></span>Starting...'; }

  try {
    const data = await api(`/api/ai-books/${bookId}/confirm`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    appendMsg(chatBox, 'assistant', `Great! I'm now writing your book. I'll update you as each chapter is completed. You can leave this chat and come back anytime.`);

    _startWritingPoll(bookId, chatBox);
  } catch (err) {
    if (btn) { btn.disabled = false; btn.innerHTML = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/></svg>Start Writing'; }
    appendMsg(chatBox, 'assistant', 'Error starting writing: ' + err.message);
  }
}
window._confirmWriteBook = _confirmWriteBook;

async function _cancelWriteBook(bookId) {
  if (!bookId || !confirm('Stop writing? Chapters already completed will be kept.')) return;
  try {
    await api(`/api/ai-books/${bookId}/cancel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
  } catch (err) {
    alert('Failed to cancel: ' + err.message);
  }
}
window._cancelWriteBook = _cancelWriteBook;

async function _retryWriteBook(bookId) {
  if (!bookId) return;
  const chatBox = document.getElementById('chat-messages');
  try {
    await api(`/api/ai-books/${bookId}/retry`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (chatBox) appendMsg(chatBox, 'assistant', 'Resuming — I\'ll pick up from the failed chapter.');
    _startWritingPoll(bookId, chatBox);
  } catch (err) {
    if (chatBox) appendMsg(chatBox, 'assistant', 'Retry failed: ' + err.message);
  }
}
window._retryWriteBook = _retryWriteBook;

function _startWritingPoll(bookId, chatBox) {
  _stopWriteBookPolling();
  _writeBookPollSessionId = currentSessionId;

  async function poll() {
    if (_writeBookId !== bookId || currentSessionId !== _writeBookPollSessionId) {
      _stopWriteBookPolling();
      return;
    }
    try {
      const book = await api(`/api/ai-books/${bookId}/status`);
      if (_writeBookId !== bookId || currentSessionId !== _writeBookPollSessionId) {
        _stopWriteBookPolling();
        return;
      }
      _showBookCanvas(_renderCanvasWritingProgress(book), book);

      if (book.status === 'completed' || book.status === 'failed' || book.status === 'cancelled') {
        _stopWriteBookPolling();
        if (book.status === 'completed' || book.status === 'cancelled') {
          await loadAgents();
          buildBookList();
          renderChatHistory();
        }
      }
    } catch (e) {
      console.warn('Poll error:', e);
    }
  }

  poll();
  _writeBookPolling = setInterval(poll, 5000);
}

function _detectLanguage(text) {
  const cjk = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g);
  if (cjk && cjk.length > text.length * 0.1) return 'zh';
  const jp = text.match(/[\u3040-\u309f\u30a0-\u30ff]/g);
  if (jp && jp.length > 3) return 'ja';
  const kr = text.match(/[\uac00-\ud7af]/g);
  if (kr && kr.length > 3) return 'ko';
  return 'en';
}

function _isWriteBookSession() {
  if (!currentSessionId) return false;
  const session = chatSessions.find(s => s.id === currentSessionId);
  return session?.sessionType === 'write_book' || session?.meta?.write_book;
}

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

  const canEdit = isBookOwner(book);
  const editIcon = canEdit ? ' <svg class="editable-hint" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="opacity:0;transition:opacity .15s;vertical-align:middle;margin-left:4px"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>' : '';
  headerEl.innerHTML = `
    ${coverUrl ? `<img class="book-inline-cover" src="${coverUrl}" alt="" onerror="this.style.display='none'" />` : ''}
    <div class="book-inline-info"><h2 id="book-detail-title">${esc(title)}${editIcon}</h2><p>${esc(author)}</p></div>`;
  if (canEdit) {
    const h2 = headerEl.querySelector('#book-detail-title');
    h2.style.cssText = 'cursor:pointer;';
    h2.addEventListener('mouseenter', () => { const svg = h2.querySelector('.editable-hint'); if (svg) svg.style.opacity = '0.5'; });
    h2.addEventListener('mouseleave', () => { const svg = h2.querySelector('.editable-hint'); if (svg) svg.style.opacity = '0'; });
    makeEditableTitle(h2, bookId, title);
  }

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
  _updateComposerMentionHint();
}

async function sendBookChat(bookId, message) {
  const chatBox = document.getElementById('book-chat-messages');
  const input = document.getElementById('book-chat-input');
  const mentionedNames = parseMentions(message);
  const contextMinds = [...selectedMinds.values()].filter(m => !mentionedNames.includes(m.name));
  // Cancel any in-flight minds invitation from previous message
  _mindsInviteGen++;
  removeMindsLoading();
  appendMsg(chatBox, 'user', message, null, null, mentionedNames.length > 0, contextMinds);
  if (input) input.value = '';
  showLoading(chatBox);
  const cleanMessage = mentionedNames.length ? stripMentions(message) : message;
  const skipFeynman = (mentionedNames.length > 0 && activeMinds.size > 0) || selectedMinds.size > 0;
  try {
    if (!skipFeynman) {
      const data = await api('/api/agents/' + bookId + '/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: cleanMessage }),
      });
      removeLoading();
      const msgOpts = {};
      if (data.skill_used) msgOpts.skillUsed = data.skill_used;
      if (data.web_sources?.length) msgOpts.webSources = data.web_sources;
      if (data.grounded) msgOpts.grounded = true;
      if (data.references?.length) msgOpts.references = data.references;
      if (data.usage) msgOpts.usage = data.usage;
      appendMsg(chatBox, 'assistant', data.answer, null, msgOpts);
      ensurePolling();
    } else {
      removeLoading();
    }

    const book = allBooks.find(b => b.agentId === bookId);
    const bookContext = book ? [{ title: book.title, author: book.author || '' }] : [];
    _inviteMindsToChat(chatBox, message, bookContext, [bookId], mentionedNames);
  } catch (err) {
    removeLoading();
    appendMsg(chatBox, 'assistant', 'Error: ' + err.message);
  }
}

// ─── Upload Toast ───
let _uploadToastTimer = null;

function showUploadBanner(text, _unused, { mode = 'progress' } = {}) {
  const el = document.getElementById('upload-toast');
  const txt = document.getElementById('upload-toast-text');
  if (_uploadToastTimer) { clearTimeout(_uploadToastTimer); _uploadToastTimer = null; }
  el.classList.remove('hiding', 'success', 'error');
  txt.textContent = text;
  if (mode === 'success') el.classList.add('success');
  else if (mode === 'error') el.classList.add('error');
  el.classList.add('visible');
}

function hideUploadBanner(delay = 0) {
  const el = document.getElementById('upload-toast');
  const dismiss = () => {
    el.classList.add('hiding');
    setTimeout(() => el.classList.remove('visible', 'hiding', 'success', 'error'), 350);
  };
  if (delay > 0) { _uploadToastTimer = setTimeout(dismiss, delay); }
  else { dismiss(); }
}

// ─── Upload (multi-file) — auto-selects uploaded books as chips ───
const MAX_UPLOAD_SIZE_MB = 4;
async function handleFileUpload(files) {
  const fileList = Array.from(files);
  let uploaded = 0;
  const uploadedAgentIds = [];
  const duplicateNames = [];

  for (const file of fileList) {
    if (file.size > MAX_UPLOAD_SIZE_MB * 1024 * 1024) {
      const sizeMB = (file.size / (1024 * 1024)).toFixed(1);
      showUploadBanner(`File too large (${sizeMB} MB, limit ${MAX_UPLOAD_SIZE_MB} MB)`, null, { mode: 'error' });
      hideUploadBanner(5000);
      return;
    }
    const countLabel = fileList.length > 1 ? ` (${uploaded + 1}/${fileList.length})` : '';
    showUploadBanner(`Uploading "${file.name}"${countLabel}...`, null, { mode: 'progress' });
    const fd = new FormData();
    fd.append('file', file);
    try {
      const result = await api('/api/agents/upload', { method: 'POST', body: fd });
      uploadedAgentIds.push(result.id);
      if (result.duplicate) {
        duplicateNames.push(result.name || file.name);
      } else {
        uploaded++;
      }
    } catch (err) {
      if (err.message && err.message.includes('Upload limit reached')) {
        showUploadBanner(err.message, null, { mode: 'error' });
        hideUploadBanner(6000);
        return;
      }
      showUploadBanner(`Upload failed: ${err.message}`, null, { mode: 'error' });
      hideUploadBanner(5000);
      return;
    }
  }

  if (duplicateNames.length && uploaded === 0) {
    const names = duplicateNames.map(n => `"${n}"`).join(', ');
    showUploadBanner(`${names} already exists in the library — selected for you`, null, { mode: 'success' });
    hideUploadBanner(5000);
  } else if (duplicateNames.length) {
    const dupNames = duplicateNames.map(n => `"${n}"`).join(', ');
    showUploadBanner(`${uploaded} new book(s) uploaded — indexing... (${dupNames} already existed)`, null, { mode: 'success' });
    hideUploadBanner(5000);
  } else {
    const name = uploaded > 1 ? `${uploaded} books` : `"${fileList[0].name}"`;
    showUploadBanner(`${name} uploaded — indexing...`, null, { mode: 'success' });
    hideUploadBanner(4000);
  }

  await loadAgents();
  ensurePolling();

  for (const agentId of uploadedAgentIds) {
    const book = allBooks.find(b => b.agentId === agentId);
    if (book) selectedBooks.set(book.id, book);
  }
  renderSelectedChips();
}

async function handleUploadFromUrl(rawUrl, urlInputEl) {
  const url = (rawUrl || '').trim();
  if (!url) {
    showUploadBanner('Paste a URL first', null, { mode: 'error' });
    hideUploadBanner(4000);
    return;
  }
  showUploadBanner('Fetching page…', null, { mode: 'progress' });
  try {
    const result = await api('/api/agents/upload-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    if (urlInputEl) urlInputEl.value = '';
    document.querySelectorAll('.composer-popover').forEach(p => p.classList.add('hidden'));
    await loadAgents();
    ensurePolling();
    const book = allBooks.find(b => b.agentId === result.id);
    if (book) selectedBooks.set(book.id, book);
    renderSelectedChips();
    if (result.duplicate) {
      showUploadBanner(book ? `"${book.title}" is already in your library — selected` : 'Already in your library — selected', null, { mode: 'success' });
      hideUploadBanner(5000);
    } else {
      showUploadBanner(book ? `"${book.title}" imported — indexing…` : 'Page imported — indexing…', null, { mode: 'success' });
      hideUploadBanner(4000);
    }
  } catch (err) {
    if (err.message && err.message.includes('Upload limit reached')) {
      showUploadBanner(err.message, null, { mode: 'error' });
      hideUploadBanner(6000);
      return;
    }
    showUploadBanner(`Import failed: ${err.message}`, null, { mode: 'error' });
    hideUploadBanner(6000);
  }
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
function collapseBookUrlPanels() {
  document.querySelectorAll('.popover-url-panel').forEach(p => p.classList.add('hidden'));
  document.querySelectorAll('.popover-url-toggle').forEach(t => t.setAttribute('aria-expanded', 'false'));
}

function togglePopover(popId, listId, emptyId) {
  popId = popId || 'chat-popover';
  listId = listId || 'popover-book-list';
  emptyId = emptyId || 'popover-no-books';
  const pop = document.getElementById(popId);
  const show = pop.classList.contains('hidden');
  document.querySelectorAll('.composer-popover').forEach(p => p.classList.add('hidden'));
  if (show) {
    collapseBookUrlPanels();
    pop.classList.remove('hidden');
    renderPopoverBookList(listId, emptyId);
    const search = pop.querySelector('.popover-search');
    if (search) search.focus();
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
    const search = pop.querySelector('.popover-search');
    if (search) search.focus();
  }
}

function closeAllPopovers() {
  document.querySelectorAll('.composer-popover').forEach(p => p.classList.add('hidden'));
}
// Expose globally so onclick attributes work
window.togglePopover = togglePopover;
window.toggleMindPopover = toggleMindPopover;
window.closeAllPopovers = closeAllPopovers;

const _composerBookSearchStates = new Map();
const _composerMindSearchStates = new Map();

function _getComposerSearchState(states, key) {
  if (!states.has(key)) {
    states.set(key, {
      timer: null,
      searchingQuery: null,
      lastQuery: '',
      lastAutoQuery: null,
      discoveredIds: new Set(),
    });
  }
  return states.get(key);
}

function _getPopoverSearchInput(list) {
  const pop = list ? list.closest('.composer-popover') : null;
  return pop ? pop.querySelector('.popover-search') : null;
}

async function _discoverComposerBook(listId, emptyId, query) {
  const state = _getComposerSearchState(_composerBookSearchStates, listId);
  if (state.searchingQuery === query) return;
  state.searchingQuery = query;
  try {
    const data = await api('/api/search-book', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    if (state.searchingQuery !== query) return;
    (data.books || []).forEach(b => { if (b.id) state.discoveredIds.add(b.id); });
    await loadAgents();
    buildBookList();
  } catch (err) {
    if (state.searchingQuery !== query) return;
  } finally {
    if (state.searchingQuery === query) state.searchingQuery = null;
    renderPopoverBookList(listId, emptyId);
  }
}

async function _inviteComposerMind(listId, emptyId, query) {
  const state = _getComposerSearchState(_composerMindSearchStates, listId);
  if (state.searchingQuery === query) return;
  state.searchingQuery = query;
  try {
    let mind = allMinds.find(m => (m.name || '').toLowerCase() === query.toLowerCase());
    if (!mind) {
      mind = await api('/api/minds/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: query, link_works: false }),
      });
      if (!allMinds.some(m => m.id === mind.id)) allMinds.push(mind);
    }
    if (mind && !selectedMinds.has(mind.id)) {
      selectedMinds.set(mind.id, mind);
      renderSelectedChips();
    }
  } catch (err) {
    console.warn('[minds] generate failed for', query, err);
  } finally {
    if (state.searchingQuery === query) state.searchingQuery = null;
    renderPopoverMindList(listId, emptyId);
  }
}

function renderPopoverBookList(listId, emptyId) {
  listId = listId || 'popover-book-list';
  emptyId = emptyId || 'popover-no-books';
  const list = document.getElementById(listId);
  const empty = document.getElementById(emptyId);
  if (!list || !empty) return;
  const searchInput = _getPopoverSearchInput(list);
  const query = (searchInput?.value || '').trim();
  const state = _getComposerSearchState(_composerBookSearchStates, listId);
  if (state.lastQuery !== query) {
    state.lastQuery = query;
    state.lastAutoQuery = null;
    state.discoveredIds.clear();
  }
  const defaultEmptyText = booksLoadState === 'loading'
    ? 'Loading books...'
    : booksLoadState === 'error'
      ? 'Could not load books. Try again.'
      : 'No books in library';
  empty.textContent = defaultEmptyText;
  if (!allBooks.length) { list.innerHTML = ''; empty.classList.remove('hidden'); return; }
  let filtered = allBooks;
  if (query) {
    const q = query.toLowerCase();
    filtered = allBooks.filter(b =>
      b.title.toLowerCase().includes(q) ||
      (b.author || '').toLowerCase().includes(q) ||
      (b.category || '').toLowerCase().includes(q) ||
      state.discoveredIds.has(b.id)
    );
  }
  if (!filtered.length) {
    empty.classList.remove('hidden');
    if (query && state.searchingQuery === query) {
      empty.textContent = `Discovering books about "${query}"...`;
      list.innerHTML = '';
    } else if (query) {
      empty.classList.add('hidden');
      const q = esc(query);
      list.innerHTML = `<button class="popover-action popover-discover-book-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
        Discover books about &ldquo;${q}&rdquo;
      </button>`;
      list.querySelector('.popover-discover-book-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.innerHTML = `<span class="popover-invite-spinner"></span> Discovering books about &ldquo;${q}&rdquo;...`;
        _discoverComposerBook(listId, emptyId, query);
      });
    } else {
      list.innerHTML = '';
    }
    return;
  }
  empty.classList.add('hidden');
  list.innerHTML = filtered.map(b => {
    const sel = selectedBooks.has(b.id);
    return `<div class="popover-book-item ${sel?'selected':''}" data-bid="${b.id}">
      <div class="popover-book-check">${sel?'&#10003;':''}</div>
      <span>${esc(b.title)}</span>
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
  const searchInput = _getPopoverSearchInput(list);
  const query = (searchInput?.value || '').trim();
  const state = _getComposerSearchState(_composerMindSearchStates, listId);
  if (state.lastQuery !== query) {
    state.lastQuery = query;
    state.lastAutoQuery = null;
  }
  const defaultEmptyText = mindsLoadState === 'loading'
    ? 'Loading minds...'
    : mindsLoadState === 'error'
      ? 'Could not load minds. Try again.'
      : 'No minds yet';
  empty.textContent = defaultEmptyText;
  const pro = isProUser();
  document.querySelectorAll('.popover-pro-badge').forEach(b => {
    b.style.display = pro ? 'none' : '';
    b.onclick = () => { closeAllPopovers(); showProOverlay(); };
  });
  if (!allMinds.length) { list.innerHTML = ''; empty.classList.remove('hidden'); return; }
  const sorted = [...allMinds].sort((a, b) => a.name.localeCompare(b.name));
  const filtered = query
    ? sorted.filter(m => {
      const q = query.toLowerCase();
      return (m.name || '').toLowerCase().includes(q) ||
        (m.domain || '').toLowerCase().includes(q) ||
        (m.era || '').toLowerCase().includes(q);
    })
    : sorted;
  if (!filtered.length) {
    empty.classList.remove('hidden');
    if (!pro) {
      empty.textContent = 'Upgrade to Pro to invite minds';
      list.innerHTML = '';
    } else if (query && state.searchingQuery === query) {
      empty.textContent = `Inviting "${query}" to the network...`;
      list.innerHTML = '';
    } else if (query) {
      empty.classList.add('hidden');
      const q = esc(query);
      list.innerHTML = `<button class="popover-action popover-invite-mind-btn">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><circle cx="4" cy="6" r="2"/><circle cx="20" cy="6" r="2"/><circle cx="4" cy="18" r="2"/><circle cx="20" cy="18" r="2"/><line x1="9.5" y1="10" x2="5.5" y2="7.5"/><line x1="14.5" y1="10" x2="18.5" y2="7.5"/><line x1="9.5" y1="14" x2="5.5" y2="16.5"/><line x1="14.5" y1="14" x2="18.5" y2="16.5"/></svg>
        Invite &ldquo;${q}&rdquo; to the network
      </button>`;
      list.querySelector('.popover-invite-mind-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.innerHTML = `<span class="popover-invite-spinner"></span> Inviting &ldquo;${q}&rdquo;...`;
        _inviteComposerMind(listId, emptyId, query);
      });
    } else {
      list.innerHTML = '';
    }
    return;
  }
  empty.classList.add('hidden');
  list.innerHTML = filtered.map(m => {
    const sel = selectedMinds.has(m.id);
    const color = mindColor(m.name);
    const initials = mindInitials(m.name);
    return `<div class="popover-mind-item ${sel ? 'selected' : ''}${!pro ? ' locked' : ''}" data-mid="${m.id}">
      <div class="popover-mind-check">${sel ? '&#10003;' : ''}</div>
      <div class="popover-mind-avatar" style="background:${color}">${initials}</div>
      <span>${esc(m.name)}</span>
    </div>`;
  }).join('');
  list.querySelectorAll('.popover-mind-item').forEach(el => {
    el.addEventListener('click', () => {
      if (!pro) { closeAllPopovers(); showProOverlay(); return; }
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
  ['home-selected-chips', 'chat-selected-chips', 'mind-selected-chips'].forEach(cId => {
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
    const hasContext = selectedBooks.size || selectedMinds.size;
    homeInput.placeholder = hasContext
      ? (selectedMinds.size ? 'Ask your question... Type @ to mention a mind' : 'Ask your question...')
      : 'Ask about books or topics — great minds will join in...';
  }
  const mindInput = document.getElementById('mind-chat-input');
  if (mindInput) {
    const hasContext = selectedBooks.size || selectedMinds.size;
    mindInput.placeholder = hasContext
      ? (selectedMinds.size ? 'Ask this mind a question... Type @ to mention a mind' : 'Ask this mind a question...')
      : 'Ask this mind a question...';
  }
  // Re-render starters to match selected books
  if (getRoute().page === 'home') renderStarters();
}

function _updateComposerMentionHint() {
  const hasMinds = activeMinds.size > 0 || selectedMinds.size > 0;
  const hint = hasMinds ? 'Type @ to mention a mind' : '';
  ['chat-input', 'book-chat-input', 'mind-chat-input'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    const base = id === 'chat-input' ? 'Ask a follow-up question...'
      : id === 'mind-chat-input' ? 'Ask this mind a question...'
      : 'Ask about this book...';
    el.placeholder = hasMinds ? `${base} ${hint}` : base;
  });
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
  _mindsInvitedOnce = false;
  selectedBooks.set(bookId, book);
  window.location.hash = '#/';
}
window.selectBookForChat = selectBookForChat;

async function chatWithBookByAgent(agentId) {
  let book = allBooks.find(b => b.agentId === agentId);
  if (!book) {
    try {
      const agent = await api('/api/agents/' + agentId);
      if (agent) {
        const meta = agent.meta || {};
        book = {
          id: agent.id, title: agent.name, author: meta.author || agent.source || '',
          agentId: agent.id, status: agent.status, category: meta.category || agent.type,
          isAIGenerated: agent.type === 'ai_book', available: true,
        };
      }
    } catch (_) {}
  }
  if (!book) return;
  saveCurrentSession();
  currentSessionId = null;
  selectedBooks.clear();
  selectedMinds.clear();
  activeMinds.clear();
  _mindsInvitedOnce = false;
  selectedBooks.set(book.id, book);
  window.location.hash = '#/';
}
window.chatWithBookByAgent = chatWithBookByAgent;

// ─── Book Reader (paginated, left-right flip) ───

let _readerData = null;
let _readerPages = [];
let _readerPage = 0;
let _readerCleanup = null;

async function renderReader(agentId) {
  if (_readerCleanup) { _readerCleanup(); _readerCleanup = null; }
  const page = document.getElementById('page-read');
  page.innerHTML = `<div class="reader-loading"><span class="loading-dot">Loading book...</span></div>`;

  try {
    _readerData = await api(`/api/agents/${agentId}/read`);
  } catch (err) {
    page.innerHTML = `<div class="reader-empty"><p>Could not load book: ${esc(err.message)}</p><a href="#/library" class="reader-back-link">&larr; Back to Library</a></div>`;
    return;
  }

  const d = _readerData;
  const isAI = d.type === 'ai_book';
  const isFullText = d.content_tier === 'full';
  const isPreview = d.content_tier === 'preview';
  const readTime = Math.max(1, Math.round(d.total_words / 230));

  // Auto-detect chapters from non-AI full-text books
  let detectedChapters = null;
  if (!isAI && isFullText && d.paragraphs?.length) {
    detectedChapters = _detectChapters(d.paragraphs);
  }

  const hasChapters = isAI ? d.chapters?.length > 0 : detectedChapters && detectedChapters.length > 1;

  // TOC — shown for any book with chapters (AI or auto-detected)
  let tocHtml = '';
  if (hasChapters) {
    const chapters = isAI ? d.chapters : detectedChapters;
    tocHtml = `<nav class="reader-toc">
      <a class="reader-toc-item reader-toc-cover" data-ch="0">
        <span class="reader-toc-num"><svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg></span><span class="reader-toc-label">Cover</span>
      </a>
      ${chapters.map(c => `<a class="reader-toc-item" data-ch="${c.number}">
        <span class="reader-toc-num">${c.number}</span><span class="reader-toc-label">${esc(c.title)}</span>
      </a>`).join('')}
    </nav>`;
  }

  // Title page as page 0 — clean cover
  const imprintHtml = isAI ? `
      <div class="reader-cover-imprint">
        <svg class="reader-cover-imprint-logo" width="22" height="22" viewBox="0 0 64 64" fill="none">
          <line x1="8" y1="58" x2="32" y2="30" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
          <line x1="56" y1="58" x2="32" y2="30" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
          <circle cx="32" cy="30" r="3.5" fill="currentColor"/>
          <path d="M32,30 C26,24 38,18 32,12 C26,6 38,0 32,-4" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <span class="reader-cover-imprint-name">Feynman</span>
      </div>` : '';
  const previewLabel = isPreview ? `<span class="reader-cover-preview-label">Preview</span>` : '';
  const chapterCount = isAI ? d.chapters?.length : (detectedChapters?.length || 0);
  const _rShareUrl = `${window.location.origin}/share/${encodeURIComponent(agentId)}?t=${Math.floor(Date.now()/86400000)}`;
  const _rAuthor = d.author?.replace(/ · AI$/, '') || '';
  const _rTweetText = encodeURIComponent(`${d.title} — by ${_rAuthor || 'AI'} on feynman.wiki`);
  const _rTweetUrl = encodeURIComponent(_rShareUrl);
  const _rTweetIntentUrl = `https://twitter.com/intent/tweet?text=${_rTweetText}&url=${_rTweetUrl}`;
  const _rTopbarShareHtml = isAI ? `
      <div class="reader-topbar-share-wrap">
        <button type="button" class="reader-topbar-share-trigger" aria-label="Share" title="Share">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"/><polyline points="16 6 12 2 8 6"/><line x1="12" y1="2" x2="12" y2="15"/></svg>
        </button>
        <div class="reader-topbar-share-popup">
          <button type="button" class="reader-topbar-share-opt reader-share-x">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
            Post on X
          </button>
          <button type="button" class="reader-topbar-share-opt reader-share-copy">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
            Copy link
          </button>
        </div>
      </div>` : '';
  const titlePageHtml = `
    <div class="reader-cover">
      <div class="reader-cover-body">
        <h1 class="reader-cover-title">${esc(d.title)}</h1>
        ${d.subtitle ? `<p class="reader-cover-subtitle">${esc(d.subtitle)}</p>` : ''}
        <p class="reader-cover-author">${esc(d.author)}</p>
        <div class="reader-cover-stats">
          <span>${d.total_words.toLocaleString()} words</span>
          <span class="reader-cover-dot"></span>
          <span>~${readTime} min read</span>
          ${chapterCount > 0 ? `<span class="reader-cover-dot"></span><span>${chapterCount} chapters</span>` : ''}
        </div>
        ${previewLabel}
      </div>
      ${imprintHtml}
    </div>`;

  // Build flat HTML blocks to paginate — header + body merged per chapter
  let allBlocks = [];
  if (isAI && d.chapters?.length) {
    for (const c of d.chapters) {
      const header = `<div class="reader-chapter-header"><span class="reader-chapter-num">Chapter ${c.number}</span><h2 class="reader-chapter-title">${esc(c.title)}</h2></div>`;
      const body = _renderReaderMarkdown(c.content);
      allBlocks.push({ chNum: c.number, html: header + body });
    }
  } else if (detectedChapters && detectedChapters.length > 1) {
    for (const c of detectedChapters) {
      const header = `<div class="reader-chapter-header"><h2 class="reader-chapter-title">${esc(c.title)}</h2></div>`;
      const body = c.paragraphs.map(p => `<p>${esc(p)}</p>`).join('');
      allBlocks.push({ chNum: c.number, html: header + body });
    }
  } else if (d.paragraphs?.length) {
    allBlocks.push({ chNum: 0, html: d.paragraphs.map(p => `<p>${esc(p)}</p>`).join('') });
  }

  page.innerHTML = `
    <div class="reader-topbar">
      <a href="#/library" class="reader-back-btn" title="Back to Library">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
      </a>
      <div class="reader-topbar-title">${esc(d.title)}</div>
      ${_rTopbarShareHtml}
    </div>
    <div class="reader-layout">
      ${tocHtml ? `<aside class="reader-sidebar">${tocHtml}</aside>` : ''}
      <div class="reader-stage">
        <button class="reader-nav reader-nav-prev" id="reader-prev" title="Previous page">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <main class="reader-content" id="reader-content">
          <div class="reader-page-inner" id="reader-page-inner"></div>
          <div class="reader-page-num" id="reader-page-num-bar">
            <span id="reader-page-num">1</span> / <span id="reader-page-total">1</span>
          </div>
        </main>
        <button class="reader-nav reader-nav-next" id="reader-next" title="Next page">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 6 15 12 9 18"/></svg>
        </button>
      </div>
    </div>
    <div class="reader-progress-bar"><div class="reader-progress-fill" id="reader-progress-fill"></div></div>
  `;

  if (isAI) {
    const shareWrap = page.querySelector('.reader-topbar-share-wrap');
    if (shareWrap) {
      const trig = shareWrap.querySelector('.reader-topbar-share-trigger');
      if (trig) trig.addEventListener('click', (e) => {
        e.stopPropagation();
        shareWrap.classList.toggle('open');
      });
      const xBtn = shareWrap.querySelector('.reader-share-x');
      if (xBtn) xBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        window.open(_rTweetIntentUrl, '_blank');
        shareWrap.classList.remove('open');
      });
      const copyBtn = shareWrap.querySelector('.reader-share-copy');
      if (copyBtn) copyBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        navigator.clipboard.writeText(_rShareUrl);
        _showToast('Link copied');
        shareWrap.classList.remove('open');
      });
    }
  }

  // Track ownership for editable title in reader
  const _readerBook = allBooks.find(b => b.agentId === agentId);
  const _readerIsOwner = isBookOwner(_readerBook);
  let _readerCurrentTitle = d.title;

  function _onReaderTitleRenamed(newTitle) {
    _readerCurrentTitle = newTitle;
    const topbar = page.querySelector('.reader-topbar-title');
    if (topbar && !topbar.querySelector('input')) {
      topbar.innerHTML = esc(newTitle);
      makeEditableTitle(topbar, agentId, newTitle, _onReaderTitleRenamed);
    }
  }

  if (_readerIsOwner) {
    const topbarTitle = page.querySelector('.reader-topbar-title');
    if (topbarTitle) makeEditableTitle(topbarTitle, agentId, _readerCurrentTitle, _onReaderTitleRenamed);
  }

  // Paginate: measure content into pages that fit the viewport
  const inner = document.getElementById('reader-page-inner');
  const contentEl = document.getElementById('reader-content');

  function _elFullHeight(el) {
    const s = getComputedStyle(el);
    return el.offsetHeight + parseFloat(s.marginTop) + parseFloat(s.marginBottom);
  }

  function paginate() {
    const containerH = inner.clientHeight;
    if (containerH <= 0) return;
    _readerPages = [];

    // Page 0: title
    _readerPages.push({ html: titlePageHtml, chNum: 0 });

    for (const block of allBlocks) {
      // Measure in-place (same width/padding as real render) for accurate heights
      inner.innerHTML = block.html;
      const elems = Array.from(inner.children);

      if (inner.scrollHeight <= containerH) {
        _readerPages.push({ html: block.html, chNum: block.chNum });
      } else {
        let pageHtml = '';
        let pageH = 0;

        for (const el of elems) {
          const elH = _elFullHeight(el);
          if (pageH > 0 && pageH + elH > containerH) {
            _readerPages.push({ html: pageHtml, chNum: block.chNum });
            pageHtml = '';
            pageH = 0;
          }
          pageHtml += el.outerHTML;
          pageH += elH;
        }
        if (pageHtml) {
          _readerPages.push({ html: pageHtml, chNum: block.chNum });
        }
      }
    }

    // End page
    const endHtml = isPreview
      ? `<div class="reader-end-page reader-end-preview">
          <p>End of preview</p>
          <p class="reader-end-subtitle">Chat with this book to explore further</p>
          <a class="reader-end-chat-btn" href="#/" onclick="chatWithBookByAgent('${esc(agentId)}');return false;">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            Chat
          </a>
        </div>`
      : `<div class="reader-end-page">
          <p>End of book</p>
          ${isAI ? `<p class="reader-end-subtitle">Enjoyed this book? Use the share control in the top bar, or <button type="button" class="reader-end-copy-link">copy link</button></p>` : ''}
        </div>`;
    _readerPages.push({ html: endHtml, chNum: -1 });

    document.getElementById('reader-page-total').textContent = _readerPages.length;
    if (_readerPage >= _readerPages.length) _readerPage = _readerPages.length - 1;
    showReaderPage(_readerPage);
  }

  function showReaderPage(idx) {
    const prev = _readerPage;
    _readerPage = Math.max(0, Math.min(idx, _readerPages.length - 1));
    const pg = _readerPages[_readerPage];
    inner.innerHTML = pg.html;
    inner.scrollTop = 0;

    // Trigger page-flip animation
    if (prev !== _readerPage) {
      const dir = _readerPage > prev ? 'right' : 'left';
      inner.classList.remove('flip-left', 'flip-right');
      void inner.offsetWidth; // reflow to restart animation
      inner.classList.add('flip-' + dir);
    }

    document.getElementById('reader-page-num').textContent = _readerPage + 1;
    const pct = _readerPages.length > 1 ? Math.round((_readerPage / (_readerPages.length - 1)) * 100) : 0;
    document.getElementById('reader-progress-fill').style.width = pct + '%';

    document.getElementById('reader-prev').style.visibility = _readerPage === 0 ? 'hidden' : '';
    document.getElementById('reader-next').style.visibility = _readerPage === _readerPages.length - 1 ? 'hidden' : '';

    // Highlight active TOC item
    document.querySelectorAll('.reader-toc-item').forEach(a => {
      const ch = parseInt(a.dataset.ch);
      a.classList.toggle('active', ch === pg.chNum && pg.chNum >= 0);
    });

    // Re-attach editable title on cover page (page 0) since innerHTML recreates elements
    if (_readerIsOwner && _readerPage === 0) {
      const coverTitle = inner.querySelector('.reader-cover-title');
      if (coverTitle) makeEditableTitle(coverTitle, agentId, _readerCurrentTitle, _onReaderTitleRenamed);
    }
  }

  // Navigation
  document.getElementById('reader-prev').addEventListener('click', () => showReaderPage(_readerPage - 1));
  document.getElementById('reader-next').addEventListener('click', () => showReaderPage(_readerPage + 1));

  function onKey(e) {
    const el = e.target;
    if (el instanceof Element && (el.closest('input, textarea, select, [contenteditable="true"]') || el.isContentEditable)) {
      return;
    }
    if (e.key === 'ArrowRight' || e.key === ' ') { e.preventDefault(); showReaderPage(_readerPage + 1); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); showReaderPage(_readerPage - 1); }
    if (e.key === 'Home') { e.preventDefault(); showReaderPage(0); }
    if (e.key === 'End') { e.preventDefault(); showReaderPage(_readerPages.length - 1); }
  }
  document.addEventListener('keydown', onKey);
  _readerCleanup = () => document.removeEventListener('keydown', onKey);

  // TOC click → jump to chapter
  page.querySelectorAll('.reader-toc-item').forEach(a => {
    a.addEventListener('click', () => {
      const ch = parseInt(a.dataset.ch);
      const idx = _readerPages.findIndex(p => p.chNum === ch);
      if (idx >= 0) showReaderPage(idx);
    });
  });

  // Re-paginate on resize
  let resizeTimer;
  const onResize = () => { clearTimeout(resizeTimer); resizeTimer = setTimeout(paginate, 200); };
  window.addEventListener('resize', onResize);
  const origCleanup = _readerCleanup;
  _readerCleanup = () => { origCleanup(); window.removeEventListener('resize', onResize); };

  function onDocClickShare(e) {
    if (!e.target.closest('.reader-topbar-share-wrap')) {
      page.querySelectorAll('.reader-topbar-share-wrap.open').forEach(w => w.classList.remove('open'));
    }
  }
  document.addEventListener('click', onDocClickShare, true);
  const origCleanup2 = _readerCleanup;
  _readerCleanup = () => { origCleanup2(); document.removeEventListener('click', onDocClickShare, true); };

  function onReaderEndCopyLink(e) {
    const btn = e.target.closest('.reader-end-copy-link');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    navigator.clipboard.writeText(_rShareUrl);
    _showToast('Link copied');
  }
  page.addEventListener('click', onReaderEndCopyLink);
  const origCleanup3 = _readerCleanup;
  _readerCleanup = () => { origCleanup3(); page.removeEventListener('click', onReaderEndCopyLink); };

  paginate();
}

function _detectChapters(paragraphs) {
  if (!paragraphs || paragraphs.length < 5) return null;
  const chapterPatterns = [
    /^chapter\s+(\d+)/i,
    /^CHAPTER\s+(\d+)/,
    /^Part\s+(\d+)/i,
    /^Section\s+(\d+)/i,
    /^(\d+)\.\s+[A-Z]/,
  ];
  const headingPattern = /^[A-Z][A-Z\s:,\-]{4,}$/;
  const chapters = [];
  let currentParagraphs = [];
  let currentTitle = '';
  let chNum = 0;

  for (const p of paragraphs) {
    let isHeading = false;
    for (const pat of chapterPatterns) {
      if (pat.test(p)) { isHeading = true; break; }
    }
    if (!isHeading && headingPattern.test(p.trim()) && p.trim().length < 80) {
      isHeading = true;
    }
    if (isHeading) {
      if (currentParagraphs.length > 0 || chNum > 0) {
        chapters.push({ number: chNum, title: currentTitle || `Section ${chNum}`, paragraphs: currentParagraphs });
      }
      chNum++;
      currentTitle = p.trim();
      currentParagraphs = [];
    } else {
      currentParagraphs.push(p);
    }
  }
  if (currentParagraphs.length > 0) {
    chapters.push({ number: chNum || 1, title: currentTitle || 'Content', paragraphs: currentParagraphs });
  }
  if (chapters.length <= 1) return null;
  return chapters;
}

function _renderReaderMarkdown(text) {
  if (!text) return '';
  const MAX_PARA = 500;
  const out = [];
  for (let block of text.split(/\n{2,}/)) {
    block = block.trim();
    if (!block) continue;
    if (block.startsWith('### ')) { out.push(`<h4>${esc(block.slice(4))}</h4>`); continue; }
    if (block.startsWith('## '))  { out.push(`<h3>${esc(block.slice(3))}</h3>`); continue; }
    if (block.startsWith('# '))   { out.push(`<h2>${esc(block.slice(2))}</h2>`); continue; }
    // Split long paragraphs at sentence boundaries for better pagination
    if (block.length > MAX_PARA) {
      const sentences = block.match(/[^.!?]+[.!?]+[\s]*/g) || [block];
      let chunk = '';
      for (const s of sentences) {
        if (chunk.length + s.length > MAX_PARA && chunk) {
          let h = esc(chunk.trim());
          h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
          h = h.replace(/\*(.+?)\*/g, '<em>$1</em>');
          out.push(`<p>${h}</p>`);
          chunk = '';
        }
        chunk += s;
      }
      if (chunk.trim()) {
        let h = esc(chunk.trim());
        h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
        h = h.replace(/\*(.+?)\*/g, '<em>$1</em>');
        out.push(`<p>${h}</p>`);
      }
    } else {
      let h = esc(block);
      h = h.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
      h = h.replace(/\*(.+?)\*/g, '<em>$1</em>');
      out.push(`<p>${h}</p>`);
    }
  }
  return out.join('');
}
window.renderReader = renderReader;

// ─── Textarea auto-resize ───
function autoResize(textarea) {
  textarea.addEventListener('input', () => {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 200) + 'px';
  });
}

function bindEnterSend(textarea, handler) {
  textarea.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey && !textarea._mentionDropdownOpen) {
      e.preventDefault(); handler();
    }
  });
}

// ─── @mention autocomplete ───

function _getMentionableMinds() {
  const minds = [];
  const seen = new Set();
  for (const [id, m] of activeMinds) {
    if (!seen.has(id)) {
      seen.add(id);
      const full = allMinds.find(x => x.id === id);
      minds.push({ id, name: m.name, domain: full?.domain || '', era: full?.era || '' });
    }
  }
  for (const [id, m] of selectedMinds) {
    if (!seen.has(id)) {
      seen.add(id);
      minds.push({ id, name: m.name, domain: m.domain || '', era: m.era || '' });
    }
  }
  return minds;
}

function bindMentionAutocomplete(textarea) {
  let dropdown = null;
  let items = [];
  let activeIdx = 0;
  let mentionStart = -1;

  function getQuery() {
    const val = textarea.value;
    const cur = textarea.selectionStart;
    const before = val.slice(0, cur);
    const atIdx = before.lastIndexOf('@');
    if (atIdx < 0) return null;
    if (atIdx > 0 && /\S/.test(before[atIdx - 1])) return null;
    const query = before.slice(atIdx + 1);
    if (/\n/.test(query)) return null;
    return { query, atIdx };
  }

  function createDropdown() {
    if (dropdown) return;
    dropdown = document.createElement('div');
    dropdown.className = 'mention-dropdown';
    const wrapper = textarea.closest('.chat-composer-inline') || textarea.parentElement;
    wrapper.style.position = 'relative';
    wrapper.appendChild(dropdown);
  }

  function destroyDropdown() {
    if (dropdown) { dropdown.remove(); dropdown = null; }
    items = [];
    activeIdx = 0;
    mentionStart = -1;
    textarea._mentionDropdownOpen = false;
  }

  function renderDropdown(minds, query) {
    if (!minds.length) { destroyDropdown(); return; }
    createDropdown();
    items = minds;
    activeIdx = 0;
    textarea._mentionDropdownOpen = true;
    dropdown.innerHTML = minds.map((m, i) => {
      const color = mindColor(m.name);
      const initials = mindInitials(m.name);
      const nameHtml = highlightMatch(m.name, query);
      const sub = [m.era, m.domain].filter(Boolean).join(' · ');
      return `<div class="mention-item${i === 0 ? ' active' : ''}" data-idx="${i}">
        <div class="mention-item-avatar" style="background:${color}">${initials}</div>
        <div class="mention-item-info">
          <span class="mention-item-name">${nameHtml}</span>
          ${sub ? `<span class="mention-item-domain">${esc(sub)}</span>` : ''}
        </div>
      </div>`;
    }).join('');
    dropdown.querySelectorAll('.mention-item').forEach(el => {
      el.addEventListener('mousedown', e => {
        e.preventDefault();
        selectItem(parseInt(el.dataset.idx));
      });
      el.addEventListener('mouseenter', () => {
        setActive(parseInt(el.dataset.idx));
      });
    });
  }

  function highlightMatch(name, query) {
    if (!query) return esc(name);
    const lower = name.toLowerCase();
    const qLower = query.toLowerCase();
    const idx = lower.indexOf(qLower);
    if (idx < 0) return esc(name);
    const before = name.slice(0, idx);
    const match = name.slice(idx, idx + query.length);
    const after = name.slice(idx + query.length);
    return esc(before) + '<strong>' + esc(match) + '</strong>' + esc(after);
  }

  function setActive(idx) {
    activeIdx = idx;
    dropdown?.querySelectorAll('.mention-item').forEach((el, i) => {
      el.classList.toggle('active', i === idx);
    });
  }

  function selectItem(idx) {
    const mind = items[idx];
    if (!mind) return;
    const val = textarea.value;
    const cur = textarea.selectionStart;
    const before = val.slice(0, cur);
    const atIdx = before.lastIndexOf('@');
    const newVal = val.slice(0, atIdx) + '@' + mind.name + ' ' + val.slice(cur);
    textarea.value = newVal;
    const newCur = atIdx + mind.name.length + 2;
    textarea.setSelectionRange(newCur, newCur);
    textarea.focus();
    destroyDropdown();
    textarea.dispatchEvent(new Event('input'));
  }

  textarea.addEventListener('input', () => {
    const info = getQuery();
    if (!info) { destroyDropdown(); return; }
    mentionStart = info.atIdx;
    const q = info.query.toLowerCase();
    const minds = _getMentionableMinds().filter(m =>
      m.name.toLowerCase().includes(q)
    ).slice(0, 6);
    renderDropdown(minds, info.query);
  });

  textarea.addEventListener('keydown', e => {
    if (!dropdown) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopImmediatePropagation();
      setActive((activeIdx + 1) % items.length);
      const el = dropdown.querySelectorAll('.mention-item')[activeIdx];
      if (el) el.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopImmediatePropagation();
      setActive((activeIdx - 1 + items.length) % items.length);
      const el = dropdown.querySelectorAll('.mention-item')[activeIdx];
      if (el) el.scrollIntoView({ block: 'nearest' });
    } else if (e.key === 'Enter' || e.key === 'Tab') {
      e.preventDefault();
      e.stopImmediatePropagation();
      selectItem(activeIdx);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      destroyDropdown();
    }
  });

  textarea.addEventListener('blur', () => {
    setTimeout(destroyDropdown, 150);
  });
}

function parseMentions(text) {
  const minds = _getMentionableMinds();
  const mentioned = [];
  const sorted = [...minds].sort((a, b) => b.name.length - a.name.length);
  for (const m of sorted) {
    const pattern = new RegExp('@' + m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=\\s|$)', 'gi');
    if (pattern.test(text)) {
      mentioned.push(m.name);
    }
  }
  return mentioned;
}

function stripMentions(text) {
  const minds = _getMentionableMinds();
  let result = text;
  const sorted = [...minds].sort((a, b) => b.name.length - a.name.length);
  for (const m of sorted) {
    const pattern = new RegExp('@' + m.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?=\\s|$)', 'gi');
    result = result.replace(pattern, m.name);
  }
  return result.trim();
}

function renderUserMsgWithMentions(text) {
  const minds = _getMentionableMinds();
  let html = esc(text);
  const sorted = [...minds].sort((a, b) => b.name.length - a.name.length);
  for (const m of sorted) {
    const escaped = esc(m.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp('@' + escaped + '(?=\\s|$|&)', 'g');
    html = html.replace(pattern, `<span class="mention-tag">@${esc(m.name)}</span>`);
  }
  return html;
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
    t = t.replace(/\[([^\]]+)\]\(([^\s\u0600-\u06FF)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    t = t.replace(/\x00IC(\d+)\x00/g, (_, i) => inlineCodes[+i]);
    return t;
  }
}

// ─── Great Minds ───
const MIND_COLORS = ['#6d597a','#355070','#264653','#2a9d8f','#e76f51','#b56576','#0077b6','#588157','#9b2226','#457b9d'];
function mindColor(name) { let h = 0; for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0; return MIND_COLORS[Math.abs(h) % MIND_COLORS.length]; }
function mindInitials(name) { return name.split(/\s+/).slice(0, 2).map(w => w[0].toUpperCase()).join(''); }

async function loadMinds() {
  mindsLoadState = 'loading';
  _refreshOpenPopovers();
  try {
    const minds = await api('/api/minds');
    allMinds = minds;
    mindsLoadState = 'ready';
  } catch (err) {
    allMinds = [];
    mindsLoadState = 'error';
    console.error('[loadMinds] Failed to fetch minds:', err.message);
  }
  _refreshOpenPopovers();
}

let _graphSim = null;
let _graphAnim = null;
let _graphState = null;
let _graphResizeObserver = null;
let _graphNodePositions = null; // in-memory cache: skip fly-in on same-session revisit

function _domainTokens(m) {
  return (m.domain || '').toLowerCase().split(/[,;\/&]+/).map(d => d.trim()).filter(Boolean);
}

const _STOP_WORDS = new Set(['and','the','of','in','a','an','to','for','on','with','its','or','as','by','at','is','was','are','be','has','had','that','this','from','but','not','it','he','she','they','his','her','their','our','my','all','no','so','if','do','did','will','can','may']);

function _tokenWords(tokens) {
  const words = new Set();
  for (const t of tokens) {
    for (const w of t.split(/\s+/)) {
      const clean = w.replace(/[^a-z0-9]/g, '');
      if (clean.length > 2 && !_STOP_WORDS.has(clean)) words.add(clean);
    }
  }
  return words;
}

function _matchStrength(tokensA, tokensB) {
  let strength = 0;
  for (const t of tokensA) {
    for (const u of tokensB) {
      if (t === u) { strength += 3; }
      else if (t.includes(u) || u.includes(t)) { strength += 2; }
    }
  }
  if (strength === 0) {
    const wordsA = _tokenWords(tokensA);
    const wordsB = _tokenWords(tokensB);
    let wordHits = 0;
    for (const w of wordsA) {
      if (wordsB.has(w)) wordHits++;
    }
    if (wordHits >= 2) strength = wordHits;
  }
  return strength;
}

// ─── Embedding-based layout force ───
// Each node carries _layoutPos {rx, ry} derived from PCA of its embedding vector.
// The force nudges every node toward its own semantic position in 2D space.

function _makeEmbeddingForce(strength, W, H) {
  let ns;
  function force(alpha) {
    for (const n of ns) {
      if (n._isAdd || !n._layoutPos) continue;
      n.vx += (n._layoutPos.rx * W - n.x) * strength * alpha;
      n.vy += (n._layoutPos.ry * H - n.y) * strength * alpha;
    }
  }
  force.initialize = nodes => { ns = nodes; };
  return force;
}

function _buildGraphData(minds, vectorLinks, layoutPositions) {
  const layoutMap = new Map((layoutPositions || []).map(p => [p.id, { rx: p.rx, ry: p.ry }]));
  const now = Date.now();
  const lastVisit = parseInt(localStorage.getItem('minds_last_visit') || '0', 10);
  const NEW_FALLBACK_MS = 24 * 60 * 60 * 1000;
  const threshold = lastVisit > 0 ? lastVisit : (now - NEW_FALLBACK_MS);
  const pendingNew = [];
  const nodes = [];
  for (const m of minds) {
    const node = {
      id: m.id, name: m.name, era: m.era || '',
      domain: m.domain || '', bio: m.bio_summary || '',
      color: mindColor(m.name), initials: mindInitials(m.name),
      chatCount: m.chat_count || 0,
      tokens: _domainTokens(m),
      _layoutPos: layoutMap.get(m.id) || null,
    };
    if (m.created_at) {
      const createdMs = new Date(m.created_at).getTime();
      if (createdMs > threshold) {
        pendingNew.push({ node, createdMs });
        continue;
      }
    }
    nodes.push(node);
  }

  if (pendingNew.length > 0) {
    pendingNew.sort((a, b) => a.createdMs - b.createdMs);
    const STAGGER_MS = Math.min(600, 4000 / pendingNew.length);
    const baseTime = performance.now() + 1200;
    pendingNew.forEach((entry, i) => {
      entry.arriveAt = baseTime + i * STAGGER_MS;
    });
  }

  const nodeIds = new Set(nodes.map(n => n.id));
  const links = [];
  let usedVectorLinks = false;

  if (vectorLinks && vectorLinks.length > 0) {
    for (const vl of vectorLinks) {
      if (!nodeIds.has(vl.source) || !nodeIds.has(vl.target)) continue;
      links.push({ source: vl.source, target: vl.target, strength: Math.max(0.3, (vl.strength - 0.4) * 2.5) });
    }
    if (links.length > 0) usedVectorLinks = true;
  }

  if (!usedVectorLinks) {
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const shared = nodes[i].tokens.filter(t => nodes[j].tokens.some(u => t === u || t.includes(u) || u.includes(t)));
        if (shared.length > 0) {
          links.push({ source: nodes[i].id, target: nodes[j].id, strength: shared.length });
        }
      }
    }
  }

  if (links.length === 0 && nodes.length > 1) {
    for (let i = 1; i < nodes.length; i++) {
      links.push({ source: nodes[0].id, target: nodes[i].id, strength: 0.3 });
    }
  } else {
    const linked = new Set();
    for (const l of links) {
      linked.add(typeof l.source === 'object' ? l.source.id : l.source);
      linked.add(typeof l.target === 'object' ? l.target.id : l.target);
    }
    for (const orphan of nodes) {
      if (linked.has(orphan.id)) continue;
      let best = null, bestStr = 0;
      for (const other of nodes) {
        if (other === orphan) continue;
        const s = _matchStrength(orphan.tokens, other.tokens);
        if (s > bestStr) { bestStr = s; best = other; }
      }
      if (best) {
        links.push({ source: orphan.id, target: best.id, strength: Math.min(bestStr, 2) });
      }
    }
  }
  try {
    const customs = JSON.parse(localStorage.getItem('feynman_custom_links') || '[]');
    const nodeIds = new Set(nodes.map(n => n.id));
    for (const c of customs) {
      if (!nodeIds.has(c.s) || !nodeIds.has(c.t)) continue;
      const exists = links.some(l => {
        const sid = typeof l.source === 'object' ? l.source.id : l.source;
        const tid = typeof l.target === 'object' ? l.target.id : l.target;
        return (sid === c.s && tid === c.t) || (sid === c.t && tid === c.s);
      });
      if (!exists) {
        links.push({ source: c.s, target: c.t, strength: 1 });
      }
    }
  } catch (err) { console.warn('Failed to load custom links:', err); }
  return { nodes, links, pendingNew };
}

function renderMindsPage() {
  const search = document.getElementById('minds-search');
  if (search) search.value = '';
  _renderMindsGraphAsync();
}

let _cachedGraphData = null;
let _graphDataFetchedAt = 0;
const _VECTOR_CACHE_MS = 60000;

async function _fetchGraphData() {
  const now = Date.now();
  if (_cachedGraphData && (now - _graphDataFetchedAt) < _VECTOR_CACHE_MS) {
    return _cachedGraphData;
  }
  try {
    const resp = await api('/api/minds/similarities');
    _cachedGraphData = { links: resp.links || [], layout: resp.layout || [] };
    _graphDataFetchedAt = Date.now();
    return _cachedGraphData;
  } catch (err) {
    console.warn('Failed to fetch graph data, falling back to tag matching', err);
    return { links: [], layout: [] };
  }
}

async function _renderMindsGraphAsync() {
  const { links, layout } = await _fetchGraphData();
  _renderMindsGraph(links, layout);
}

function _hexToRgb(hex) {
  const r = parseInt(hex.slice(1,3),16), g = parseInt(hex.slice(3,5),16), b = parseInt(hex.slice(5,7),16);
  return [r, g, b];
}

function _renderMindsGraph(vectorLinks, layoutPositions) {
  const container = document.getElementById('minds-graph');
  const tooltip = document.getElementById('minds-tooltip');
  if (!container) return;

  // Save current node positions before tearing down, so same-session revisits skip the fly-in.
  if (_graphState && _graphState.nodes) {
    _graphNodePositions = {};
    for (const n of _graphState.nodes) {
      if (!n._isAdd) _graphNodePositions[n.id] = { x: n.x, y: n.y };
    }
  }

  if (_graphAnim) { cancelAnimationFrame(_graphAnim); _graphAnim = null; }
  if (_graphSim) { _graphSim.stop(); _graphSim = null; }
  if (_graphResizeObserver) { _graphResizeObserver.disconnect(); _graphResizeObserver = null; }
  container.innerHTML = '';
  tooltip.classList.add('hidden');

  if (!allMinds.length) {
    container.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;color:rgba(160,180,220,0.5);font-size:14px">Minds are being generated… refresh in a moment.</div>';
    return;
  }

  const { nodes, links, pendingNew } = _buildGraphData(allMinds, vectorLinks, layoutPositions);

  // Restore saved positions for existing nodes — new nodes have no entry and start at origin (fly-in).
  if (_graphNodePositions) {
    for (const n of nodes) {
      const saved = _graphNodePositions[n.id];
      if (saved) { n.x = saved.x; n.y = saved.y; }
    }
  }
  const dpr = window.devicePixelRatio || 1;
  let W = container.clientWidth || 900;
  let H = container.clientHeight || 600;
  const BASE_R = Math.max(20, Math.min(30, W / (nodes.length * 2)));


  const canvas = document.createElement('canvas');
  canvas.width = W * dpr;
  canvas.height = H * dpr;
  canvas.style.width = W + 'px';
  canvas.style.height = H + 'px';
  container.appendChild(canvas);
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  _graphResizeObserver = new ResizeObserver(() => {
    const newW = container.clientWidth || 900;
    const newH = container.clientHeight || 600;
    if (newW === W && newH === H) return;
    W = newW;
    H = newH;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.scale(dpr, dpr);
  });
  _graphResizeObserver.observe(container);

  let transform = d3.zoomIdentity;
  let _isOnNode = false;
  let _isDraggingNode = false;
  let _draggedNode = null;
  let _dragStartPos = null;
  let _suppressClick = false;
  const zoomBehavior = d3.zoom()
    .scaleExtent([0.1, 6])
    .filter((e) => {
      if (e.type === 'wheel') return true;
      if (e.type === 'dblclick') return true;
      if (_isDraggingNode) return false;
      if (_isOnNode) return false;
      return true;
    })
    .on('zoom', (e) => { transform = e.transform; });
  d3.select(canvas).call(zoomBehavior);

  canvas.addEventListener('mousedown', (e) => {
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    const [wx, wy] = transform.invert([cx, cy]);
    const hit = nodes.find(d => {
      if (d._isAdd) return false;
      const dx = wx - d.x, dy = wy - d.y;
      return dx * dx + dy * dy < (BASE_R + 8) * (BASE_R + 8);
    });
    if (hit) {
      _isDraggingNode = true;
      _draggedNode = hit;
      _dragStartPos = { x: hit.x, y: hit.y };
      hit.fx = hit.x;
      hit.fy = hit.y;
      sim.alphaTarget(0.3).restart();
      e.stopPropagation();
      e.preventDefault();
    }
  });

  window.addEventListener('mousemove', (e) => {
    if (!_draggedNode) return;
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    const [wx, wy] = transform.invert([cx, cy]);
    _draggedNode.fx = wx;
    _draggedNode.fy = wy;

    state._dragDropTarget = null;
    let closest = null, closestDist = Infinity;
    for (const n of nodes) {
      if (n === _draggedNode || n._isAdd) continue;
      const dx = n.x - wx, dy = n.y - wy;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < BASE_R * 3.5 && dist < closestDist) {
        closestDist = dist;
        closest = n;
      }
    }
    state._dragDropTarget = closest;
  });

  window.addEventListener('mouseup', (e) => {
    if (!_draggedNode) return;
    const dragged = _draggedNode;
    const dropTarget = state._dragDropTarget;
    state._dragDropTarget = null;

    if (dropTarget && _dragStartPos) {
      const alreadyLinked = links.some(l => {
        const sid = typeof l.source === 'object' ? l.source.id : l.source;
        const tid = typeof l.target === 'object' ? l.target.id : l.target;
        return (sid === dragged.id && tid === dropTarget.id) ||
               (sid === dropTarget.id && tid === dragged.id);
      });
      if (!alreadyLinked) {
        const nl = { source: dragged, target: dropTarget, strength: 1 };
        links.push(nl);
        particles.push({ link: nl, t: Math.random(), speed: 0.001 + Math.random() * 0.003, size: 1.5, opacity: 0.4 });
        sim.force('link').links(links);
        sim.alpha(0.3).restart();
        _saveCustomLink(dragged.id, dropTarget.id);
        showToast(`Connected ${dragged.name} ↔ ${dropTarget.name}`);
        _triggerConnectFlash(dragged, dropTarget, nl);
      } else {
        _triggerConnectFlash(dragged, dropTarget, links.find(l => {
          const sid = typeof l.source === 'object' ? l.source.id : l.source;
          const tid = typeof l.target === 'object' ? l.target.id : l.target;
          return (sid === dragged.id && tid === dropTarget.id) ||
                 (sid === dropTarget.id && tid === dragged.id);
        }));
      }
    }

    dragged.fx = null;
    dragged.fy = null;
    _draggedNode = null;
    _isDraggingNode = false;
    _dragStartPos = null;
    _suppressClick = true;
    sim.alphaTarget(0);
  });

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
    .force('embedding', _makeEmbeddingForce(0.04, W, H))
    .force('collision', d3.forceCollide().radius(d => d._isAdd ? ADD_R + 15 : BASE_R + 20))
    .alphaDecay(0.015);
  _graphSim = sim;

  const time = { now: 0 };

  const _flashNodes = [];
  const _flashLinks = [];
  const FLASH_DURATION = 1500;

  function _triggerConnectFlash(nodeA, nodeB, theLink) {
    const t0 = performance.now();
    _flashNodes.push({ node: nodeA, startAt: t0 });
    _flashNodes.push({ node: nodeB, startAt: t0 });
    _flashLinks.push({ link: theLink, startAt: t0 });
  }

  function draw() {
    time.now = performance.now();

    while (pendingNew.length > 0 && time.now >= pendingNew[0].arriveAt) {
      const entry = pendingNew.shift();
      const m = entry.node;
      m.bio_summary = m.bio;
      const scored = [];
      for (const existing of nodes) {
        if (existing._isAdd) continue;
        const s = _matchStrength(m.tokens, existing.tokens);
        if (s > 0) scored.push({ node: existing, s });
      }
      scored.sort((a, b) => b.s - a.s);
      const nearNode = scored.length > 0 ? scored[0].node : (nodes.find(d => !d._isAdd) || addNode);
      _insertMindNode(m, nearNode);
    }

    ctx.save();
    ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--canvas-bg').trim() || '#ffffff';
    ctx.fillRect(0, 0, W, H);
    ctx.translate(transform.x, transform.y);
    ctx.scale(transform.k, transform.k);

    const matchIds = new Set();
    const hasQuery = !!state.highlightQuery;
    if (hasQuery) {
      const q = state.highlightQuery.toLowerCase();
      nodes.forEach(n => {
        if (n.name.toLowerCase().includes(q)) matchIds.add(n.id);
      });
    }
    const noMatch = hasQuery && matchIds.size === 0;
    const filtering = hasQuery;

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

    for (let fi = _flashLinks.length - 1; fi >= 0; fi--) {
      const fl = _flashLinks[fi];
      const elapsed = time.now - fl.startAt;
      if (elapsed >= FLASH_DURATION) { _flashLinks.splice(fi, 1); continue; }
      const s = fl.link.source, t = fl.link.target;
      if (!s || !t || s.x == null || t.x == null) continue;
      const fade = Math.max(0, 1 - elapsed / FLASH_DURATION);
      const sc = _hexToRgb(s.color || '#6488c8');
      const tc = _hexToRgb(t.color || '#6488c8');
      const mc = [(sc[0]+tc[0])>>1, (sc[1]+tc[1])>>1, (sc[2]+tc[2])>>1];

      ctx.beginPath();
      ctx.moveTo(s.x, s.y);
      ctx.lineTo(t.x, t.y);
      ctx.strokeStyle = `rgba(${mc[0]},${mc[1]},${mc[2]},${fade * 0.6})`;
      ctx.lineWidth = 2;
      ctx.stroke();

      const dotT = (elapsed * 0.0012) % 1;
      const bx = s.x + (t.x - s.x) * dotT;
      const by = s.y + (t.y - s.y) * dotT;
      const dotR = 6;
      const dotGrad = ctx.createRadialGradient(bx, by, 0, bx, by, dotR);
      dotGrad.addColorStop(0, `rgba(255,255,255,${fade * 0.9})`);
      dotGrad.addColorStop(0.5, `rgba(${mc[0]},${mc[1]},${mc[2]},${fade * 0.5})`);
      dotGrad.addColorStop(1, `rgba(${mc[0]},${mc[1]},${mc[2]},0)`);
      ctx.beginPath();
      ctx.arc(bx, by, dotR, 0, Math.PI * 2);
      ctx.fillStyle = dotGrad;
      ctx.fill();
    }

    for (let fi = _flashNodes.length - 1; fi >= 0; fi--) {
      if (time.now - _flashNodes[fi].startAt >= FLASH_DURATION) _flashNodes.splice(fi, 1);
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
        if (noMatch) continue;
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

          const burstPhase = Math.min(1, age / 0.8);
          const burstScale = burstPhase < 1
            ? 1 + (1 - burstPhase) * 0.8
            : 1;

          const outerR = (rr + 12 + ring * 10) * burstScale;
          const glowG = ctx.createRadialGradient(n.x, n.y, rr * 0.5, n.x, n.y, outerR);
          const burstIntensity = burstPhase < 1 ? 0.4 : 0.25;
          glowG.addColorStop(0, `rgba(34,197,94,${fade * burstIntensity})`);
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
        } else if (age >= 12) {
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

      if (state._dragDropTarget === n) {
        const pulseR = rr + 8 + Math.sin(time.now * 0.006) * 3;
        ctx.beginPath();
        ctx.arc(n.x, n.y, pulseR, 0, Math.PI * 2);
        ctx.strokeStyle = `rgba(34,197,94,0.7)`;
        ctx.lineWidth = 2.5;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.setLineDash([]);
      }

      const flashEntry = _flashNodes.find(f => f.node === n);
      if (flashEntry) {
        const elapsed = time.now - flashEntry.startAt;
        if (elapsed >= 0 && elapsed < FLASH_DURATION) {
          const fade = Math.max(0, 1 - elapsed / FLASH_DURATION);
          const expandR = rr + 4 + (1 - fade) * 10;
          const glowGrad = ctx.createRadialGradient(n.x, n.y, rr, n.x, n.y, expandR);
          glowGrad.addColorStop(0, `rgba(${cr},${cg},${cb},${fade * 0.4})`);
          glowGrad.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
          ctx.beginPath();
          ctx.arc(n.x, n.y, expandR, 0, Math.PI * 2);
          ctx.fillStyle = glowGrad;
          ctx.fill();

          ctx.beginPath();
          ctx.arc(n.x, n.y, rr + 2 + (1 - fade) * 4, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${cr},${cg},${cb},${fade * 0.7})`;
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }
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

    if (noMatch) {
      const dk = _isDarkMode();
      const centerX = W / 2;
      const centerY = H / 2;
      const inviteText = `"${state.highlightQuery}" is not in the network yet`;
      const btnText = '+ Invite to Network';

      ctx.font = '500 15px "Libre Baskerville", Georgia, serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = dk ? 'rgba(245,245,247,0.85)' : 'rgba(30,35,50,0.85)';
      ctx.fillText(inviteText, centerX, centerY - 20);

      ctx.font = '600 14px Inter, sans-serif';
      const btnW = ctx.measureText(btnText).width + 36;
      const btnH = 38;
      const btnX = centerX - btnW / 2;
      const btnY = centerY + 10;

      state._inviteBtnRect = { x: btnX, y: btnY, w: btnW, h: btnH };

      const hov = state._inviteBtnHover;
      ctx.beginPath();
      ctx.roundRect(btnX, btnY, btnW, btnH, 10);
      ctx.fillStyle = hov
        ? (dk ? 'rgba(10,132,255,0.95)' : 'rgba(0,113,227,0.95)')
        : (dk ? 'rgba(10,132,255,0.85)' : 'rgba(0,113,227,0.85)');
      ctx.fill();
      if (hov) {
        ctx.shadowColor = 'rgba(0,113,227,0.3)';
        ctx.shadowBlur = 12;
      }
      ctx.fillStyle = '#fff';
      ctx.fillText(btnText, centerX, btnY + btnH / 2);
      ctx.shadowColor = 'transparent';
      ctx.shadowBlur = 0;
    } else {
      state._inviteBtnRect = null;
    }

    _graphAnim = requestAnimationFrame(draw);
  }

  sim.on('tick', () => {});
  draw();

  const pendingCount = pendingNew.length;
  if (pendingCount > 0) {
    showToast(`${pendingCount} new mind${pendingCount > 1 ? 's' : ''} joined the network since your last visit`);
  }
  localStorage.setItem('minds_last_visit', String(Date.now()));

  // Onboarding hint for new users
  if (!localStorage.getItem('graphHintSeen')) {
    const hint = document.createElement('div');
    hint.className = 'graph-onboarding-hint';
    hint.innerHTML = `
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/></svg>
      <span>Click on any mind to <strong>discover nearby thinkers</strong></span>`;
    container.appendChild(hint);
    requestAnimationFrame(() => hint.classList.add('visible'));
    const dismissHint = () => {
      hint.classList.remove('visible');
      setTimeout(() => hint.remove(), 500);
      localStorage.setItem('graphHintSeen', '1');
      canvas.removeEventListener('mousedown', dismissHint);
      canvas.removeEventListener('touchstart', dismissHint);
    };
    canvas.addEventListener('mousedown', dismissHint);
    canvas.addEventListener('touchstart', dismissHint);
    setTimeout(dismissHint, 12000);
  }

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
    const scored = [];
    for (const existing of nodes) {
      if (existing._isAdd || existing === newNode) continue;
      const strength = _matchStrength(newNode.tokens, existing.tokens);
      if (strength > 0) scored.push({ node: existing, strength });
    }
    scored.sort((a, b) => b.strength - a.strength);
    const topMatches = scored.slice(0, 5);
    for (const { node: target, strength } of topMatches) {
      const nl = { source: newNode, target, strength };
      links.push(nl);
      for (let p = 0, c = Math.max(1, Math.round(strength * 0.8)); p < c; p++) {
        particles.push({ link: nl, t: Math.random(), speed: 0.001 + Math.random() * 0.003, size: 1 + Math.random() * 1.5, opacity: 0.3 + Math.random() * 0.5 });
      }
    }
    if (!topMatches.length) {
      const candidates = nodes.filter(d => !d._isAdd && d !== newNode);
      candidates.sort((a, b) => {
        const da = (a.x - newNode.x) ** 2 + (a.y - newNode.y) ** 2;
        const db = (b.x - newNode.x) ** 2 + (b.y - newNode.y) ** 2;
        return da - db;
      });
      for (const target of candidates.slice(0, 2)) {
        const nl = { source: newNode, target, strength: 0.5 };
        links.push(nl);
        particles.push({ link: nl, t: Math.random(), speed: 0.001 + Math.random() * 0.002, size: 1 + Math.random(), opacity: 0.2 + Math.random() * 0.3 });
      }
    }
    sim.nodes(nodes);
    sim.force('link').links(links);
    sim.alpha(0.4).restart();
    return newNode;
  }

  state._insertMindNode = _insertMindNode;
  state._addNode = addNode;
  state._zoomBehavior = zoomBehavior;
  state._canvas = canvas;
  state._W = W;
  state._H = H;
  state._transform = () => transform;
  state._showTooltip = _showTooltip;

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
      _cachedGraphData = null;
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
        <div class="tt-name">Expand the Network</div>
        <div class="tt-bio">Invite great minds from the Noosphere to join your intellectual network.</div>
        <div class="tt-action">Click to expand →</div>`;
    } else {
      const domains = n.tokens.map(t => `<span class="tt-domain-tag">${t}</span>`).join('');
      const discoverBtn = _expandedSet.has(n.id) ? '' : n._expanding
        ? '<div class="tt-action" style="opacity:0.5">Discovering related minds…</div>'
        : `<button class="tt-discover-btn" data-mind-id="${n.id}">Discover nearby minds →</button>`;
      tooltip.innerHTML = `
        <div class="tt-header-row">
          <div>
            <div class="tt-name">${n.name}</div>
            <div class="tt-era">${n.era}</div>
          </div>
          <button class="tt-chat-icon-btn" data-mind-id="${n.id}" title="Chat with ${n.name}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
            <span>Chat</span>
          </button>
        </div>
        <div class="tt-domains">${domains}</div>
        <div class="tt-bio">${n.bio}</div>
        ${discoverBtn}`;
      const chatBtn = tooltip.querySelector('.tt-chat-icon-btn');
      if (chatBtn) {
        chatBtn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          const mindId = chatBtn.dataset.mindId;
          if (!isProUser()) { showProOverlay(); return; }
          tooltip.classList.add('hidden');
          _tooltipNode = null;
          window.location.hash = '#/mind/' + mindId;
        });
      }
      const btn = tooltip.querySelector('.tt-discover-btn');
      if (btn) {
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          if (!isProUser()) { showProOverlay(); return; }
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

    let onInviteBtn = false;
    if (state._inviteBtnRect) {
      const b = state._inviteBtnRect;
      onInviteBtn = cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h;
    }
    state._inviteBtnHover = onInviteBtn;
    _isOnNode = !!n && !n._isAdd;
    canvas.style.cursor = (n || onInviteBtn) ? 'pointer' : 'grab';

    if (n) {
      _showTooltip(n, cx, cy);
    } else if (!_tooltipInside) {
      _hideTooltip();
    }
  });

  canvas.addEventListener('click', async (e) => {
    if (_suppressClick) { _suppressClick = false; return; }
    const rect = canvas.getBoundingClientRect();
    const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
    if (state._inviteBtnRect) {
      const b = state._inviteBtnRect;
      if (cx >= b.x && cx <= b.x + b.w && cy >= b.y && cy <= b.y + b.h) {
        if (!isProUser()) { showProOverlay(); return; }
        showAddMindDialog(state.highlightQuery);
        return;
      }
    }
    const n = _getNodeAt(cx, cy);
    if (!n) return;
    if (n._isAdd) {
      if (!isProUser()) { showProOverlay(); return; }
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
    if (!isProUser()) { showProOverlay(); return; }
    window.location.hash = '#/mind/' + n.id;
  });

  canvas.addEventListener('mouseleave', (e) => {
    if (e.relatedTarget && tooltip.contains(e.relatedTarget)) return;
    state.hoveredNode = null;
    _hideTooltip();
  });

  function _saveCustomLink(sourceId, targetId) {
    try {
      const customs = JSON.parse(localStorage.getItem('feynman_custom_links') || '[]');
      const key = [sourceId, targetId].sort();
      const already = customs.some(c => {
        const ck = [c.s, c.t].sort();
        return ck[0] === key[0] && ck[1] === key[1];
      });
      if (!already) {
        customs.push({ s: key[0], t: key[1] });
        localStorage.setItem('feynman_custom_links', JSON.stringify(customs));
      }
    } catch (err) { console.warn('Failed to save custom link:', err); }
  }
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
  selectedBooks.clear();
  selectedMinds.clear();
  _mindsInvitedOnce = false;
  renderSelectedChips();

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
    localStorage.setItem('currentSessionId', currentSessionId);
    activeMinds = new Map(existingSession.activeMinds || []);
    // Load messages from DB if not cached
    if (!existingSession.messages?.length) {
      try {
        const msgs = await api(`/api/sessions/${existingSession.id}/messages`);
        existingSession.messages = msgs.map(m => ({ role: m.role, content: m.content, ...m.meta }));
      } catch (e) { console.warn('Failed to load mind session messages:', e); }
    }
    for (const m of existingSession.messages) {
      if (m.role === 'mind') {
        appendMindMsg(chatBox, m.mindName, m.content);
        mindChatHistory.push({ role: 'assistant', content: m.content });
      } else if (m.role === 'system-notice') {
        appendJoinNotice(chatBox, m.mindNames || []);
      } else if (m.role === 'user') {
        appendMsg(chatBox, 'user', m.content, null, null, false, m.contextMinds);
        mindChatHistory.push({ role: 'user', content: m.content });
      } else {
        appendMsg(chatBox, m.role, m.content, m.sources, m.opts);
        mindChatHistory.push({ role: m.role, content: m.content });
      }
    }
  } else {
    const session = await createSession(mindId);
    session.title = `Chat with ${mind.name}`;
    api(`/api/sessions/${session.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: session.title }),
    }).catch(() => {});
    renderChatHistory();

    showLoading(chatBox);
    try {
      const greet = await api('/api/minds/' + mindId + '/greet', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      removeLoading();
      if (greet?.response) {
        appendMindMsg(chatBox, mind.name, greet.response);
        mindChatHistory.push({ role: 'assistant', content: greet.response });
        _saveMindSession(chatBox);
      }
    } catch (e) {
      removeLoading();
      console.warn('Mind greeting failed:', e);
    }
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
  const mentionedNames = parseMentions(message);
  const contextMinds = [...selectedMinds.values()].filter(m => !mentionedNames.includes(m.name));
  // Cancel any in-flight minds invitation from previous message
  _mindsInviteGen++;
  removeMindsLoading();
  appendMsg(chatBox, 'user', message, null, null, mentionedNames.length > 0, contextMinds);
  if (input) input.value = '';
  showLoading(chatBox);

  const cleanMessage = mentionedNames.length ? stripMentions(message) : message;
  const body = { message: cleanMessage };
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
    mindChatHistory.push({ role: 'assistant', content: data.response });

    if (!activeMinds.has(mindId) && mind) {
      activeMinds.set(mindId, { id: mindId, name: mind.name });
    }

    _saveMindSession(chatBox);
    const hasExtraMinds = selectedMinds.size > 0 || mentionedNames.length > 0;
    if (hasExtraMinds) {
      _inviteMindsToChat(chatBox, message, bookContext, agentIds, mentionedNames, mindId);
    }
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
      const msg = { role, content: el.dataset.raw || el.textContent };
      if (role === 'user' && el.dataset.contextMinds) {
        try { msg.contextMinds = JSON.parse(el.dataset.contextMinds); } catch {}
      }
      msgs.push(msg);
    }
  });
  session.messages = msgs;
  session.activeMinds = new Map(activeMinds);
  session.updatedAt = Date.now();
  _mindSaving = true;
  persistSessions();
  _mindSaving = false;
}

function showAddMindDialog(prefillName) {
  const overlay = document.createElement('div');
  overlay.className = 'mind-add-dialog';
  overlay.innerHTML = `
    <div class="mind-add-form mind-add-form-rich">
      <div class="mind-add-header">
        <div class="mind-add-neural">
          <svg width="64" height="40" viewBox="0 0 64 40" fill="none">
            <line x1="10" y1="10" x2="32" y2="6" stroke="var(--accent)" stroke-width="1" opacity="0.3"/>
            <line x1="10" y1="30" x2="32" y2="6" stroke="var(--accent)" stroke-width="1" opacity="0.2"/>
            <line x1="10" y1="10" x2="32" y2="20" stroke="var(--accent)" stroke-width="1" opacity="0.25"/>
            <line x1="10" y1="30" x2="32" y2="20" stroke="var(--accent)" stroke-width="1" opacity="0.3"/>
            <line x1="10" y1="10" x2="32" y2="34" stroke="var(--accent)" stroke-width="1" opacity="0.15"/>
            <line x1="10" y1="30" x2="32" y2="34" stroke="var(--accent)" stroke-width="1" opacity="0.25"/>
            <line x1="32" y1="6" x2="54" y2="14" stroke="var(--accent)" stroke-width="1" opacity="0.3"/>
            <line x1="32" y1="20" x2="54" y2="14" stroke="var(--accent)" stroke-width="1" opacity="0.25"/>
            <line x1="32" y1="6" x2="54" y2="28" stroke="var(--accent)" stroke-width="1" opacity="0.2"/>
            <line x1="32" y1="20" x2="54" y2="28" stroke="var(--accent)" stroke-width="1" opacity="0.3"/>
            <line x1="32" y1="34" x2="54" y2="28" stroke="var(--accent)" stroke-width="1" opacity="0.25"/>
            <line x1="32" y1="34" x2="54" y2="14" stroke="var(--accent)" stroke-width="1" opacity="0.15"/>
            <circle cx="10" cy="10" r="3.5" fill="var(--accent)" opacity="0.7"/>
            <circle cx="10" cy="30" r="3.5" fill="var(--accent)" opacity="0.7"/>
            <circle cx="32" cy="6" r="4" fill="var(--accent)" opacity="0.85"/>
            <circle cx="32" cy="20" r="4.5" fill="var(--accent)" opacity="1"/>
            <circle cx="32" cy="34" r="4" fill="var(--accent)" opacity="0.85"/>
            <circle cx="54" cy="14" r="3.5" fill="var(--accent)" opacity="0.7"/>
            <circle cx="54" cy="28" r="3.5" fill="var(--accent)" opacity="0.7"/>
          </svg>
        </div>
        <h3>Expand the Network</h3>
        <p class="mind-add-desc">Invite a great mind from the <strong>Noosphere</strong> — the realm of humanity's collective wisdom.</p>
      </div>
      <input type="text" id="add-mind-name" placeholder="e.g. Socrates, Ada Lovelace, Zhuang Zhou..." autocomplete="off" />
      <div class="mind-add-actions">
        <button id="add-mind-cancel">Cancel</button>
        <button id="add-mind-submit" class="primary-btn">Invite</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const nameInput = overlay.querySelector('#add-mind-name');
  if (prefillName) nameInput.value = prefillName;
  nameInput.focus();
  overlay.querySelector('#add-mind-cancel').addEventListener('click', () => overlay.remove());
  overlay.addEventListener('click', e => { if (e.target === overlay) overlay.remove(); });
  const submit = async () => {
    const name = nameInput.value.trim();
    if (!name) return;
    const btn = overlay.querySelector('#add-mind-submit');
    btn.textContent = 'Inviting...';
    btn.disabled = true;
    try {
      const mind = await api('/api/minds/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      overlay.remove();
      const searchInput = document.getElementById('minds-search');
      if (searchInput) { searchInput.value = ''; _applyGraphHighlight(''); }
      if (!allMinds.some(m => m.id === mind.id)) allMinds.push(mind);
      if (getRoute().page === 'minds' && _graphState && _graphState._insertMindNode) {
        const nearNode = _graphState._addNode || _graphState.nodes[0];
        const newNode = _graphState._insertMindNode(mind, nearNode);
        _panToNewMind(newNode);
        setTimeout(() => {
          if (_graphState && _graphState._showTooltip && newNode) {
            const t = _graphState._transform();
            const sx = t.applyX(newNode.x);
            const sy = t.applyY(newNode.y);
            _graphState._showTooltip(newNode, sx, sy);
          }
        }, 900);
        setTimeout(() => {
          const tooltip = document.getElementById('minds-tooltip');
          if (tooltip && !tooltip.classList.contains('hidden')) {
            tooltip.style.transition = 'opacity 0.6s ease';
            tooltip.style.opacity = '0';
            setTimeout(() => {
              tooltip.style.opacity = '';
              tooltip.style.transition = '';
              tooltip.classList.add('hidden');
            }, 600);
          }
        }, 6000);
      } else {
        await loadMinds();
        if (getRoute().page === 'minds') _renderMindsGraphAsync();
      }
    } catch (err) {
      btn.textContent = 'Invite';
      btn.disabled = false;
      alert('Failed: ' + err.message);
    }
  };
  overlay.querySelector('#add-mind-submit').addEventListener('click', submit);
  nameInput.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
}

function _panToNewMind(newNode) {
  if (!_graphState) return;
  const s = _graphState;
  const canvas = s._canvas;
  const W = s._W;
  const H = s._H;
  const zoomBehavior = s._zoomBehavior;
  if (!canvas || !zoomBehavior) return;
  setTimeout(() => {
    const targetK = Math.min(s._transform().k, 1.5);
    const tx = W / 2 - newNode.x * targetK;
    const ty = H / 2 - newNode.y * targetK;
    d3.select(canvas).transition().duration(1000).ease(d3.easeCubicInOut).call(
      zoomBehavior.transform,
      d3.zoomIdentity.translate(tx, ty).scale(targetK)
    );
  }, 300);
}

function showCreateMindDialog() {
  const overlay = document.createElement('div');
  overlay.className = 'mind-add-dialog';
  overlay.innerHTML = `
    <div class="mind-add-form" style="max-width:460px">
      <h3>Upload a Mind</h3>
      <p style="font-size:13px;color:var(--text-muted);margin:0 0 14px">Upload a Twitter/X profile, blog URL, or text content to connect a new mind to the network.</p>
      <input type="text" id="create-mind-name" placeholder="Name" autocomplete="off" />
      <input type="text" id="create-mind-url" placeholder="Twitter/X profile or blog URL (optional)" autocomplete="off" style="margin-top:8px" />
      <textarea id="create-mind-content" placeholder="Or paste text content here — tweets, blog posts, notes, markdown..." rows="5" style="margin-top:8px;width:100%;resize:vertical;font-family:inherit;font-size:13px;padding:10px 12px;border-radius:10px;border:1px solid var(--border-strong);background:var(--bg-chat);color:var(--text)"></textarea>
      <input type="file" id="create-mind-file" accept=".md,.txt,.markdown" hidden />
      <button type="button" id="create-mind-file-btn" style="margin-top:6px;font-size:12px;color:var(--text-muted);background:none;border:none;cursor:pointer;text-decoration:underline;padding:0">or upload a .md / .txt file</button>
      <div class="mind-add-actions" style="margin-top:14px">
        <button id="create-mind-cancel">Cancel</button>
        <button id="create-mind-submit" class="primary-btn">Upload & Connect</button>
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
    btn.textContent = 'Connecting...';
    btn.disabled = true;
    try {
      await api('/api/minds/create-from-content', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name, source_url: url, content }),
      });
      overlay.remove();
      await loadMinds();
      _cachedGraphData = null;
      if (getRoute().page === 'minds') _renderMindsGraphAsync();
    } catch (err) {
      btn.textContent = 'Upload & Connect';
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
  await loadUserTier();

  // Show the correct page immediately based on URL hash,
  // before async data loading, so refreshing #/minds or #/library
  // doesn't flash the home page.
  navigate();
  bindComposerControls();

  await Promise.allSettled([loadAgents(), loadVotes(), loadTopics(), loadMinds()]);
  buildBookList();
  // Re-render current page now that data is loaded (replaces loading placeholders)
  navigate();
  await restoreSessions();
  renderChatHistory();
  updateAuthUI();

  // Sidebar toggle
  document.getElementById('sidebar-toggle-btn').addEventListener('click', toggleSidebar);
  document.getElementById('sidebar-float-btn').addEventListener('click', toggleSidebar);
  document.querySelector('.sidebar-logo').addEventListener('click', (e) => {
    if (document.getElementById('app-layout').classList.contains('sidebar-collapsed')) {
      e.preventDefault();
      toggleSidebar();
    }
  });

  document.getElementById('sidebar-theme-toggle').addEventListener('click', () => {
    const isDark = document.documentElement.classList.toggle('dark');
    document.documentElement.classList.toggle('light', !isDark);
    localStorage.setItem('feynman-theme', isDark ? 'dark' : 'light');
  });

  // User profile menu toggle
  const profileBtn = document.getElementById('sidebar-profile-btn');
  const userMenu = document.getElementById('sidebar-user-menu');
  if (profileBtn && userMenu) {
    profileBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!userMenu.classList.contains('open')) {
        const rect = profileBtn.getBoundingClientRect();
        userMenu.style.bottom = (window.innerHeight - rect.top + 8) + 'px';
        userMenu.style.left = rect.left + 'px';
      }
      userMenu.classList.toggle('open');
    });
    document.addEventListener('click', (e) => {
      if (!userMenu.contains(e.target) && !profileBtn.contains(e.target)) {
        userMenu.classList.remove('open');
      }
    });
    userMenu.addEventListener('click', (e) => {
      if (e.target.closest('.user-menu-item')) {
        userMenu.classList.remove('open');
      }
    });
  }

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
    _mindsInvitedOnce = false;
    window.location.hash = '#/';
  });

  // New Chat → go to homepage
  document.getElementById('new-chat-btn').addEventListener('click', () => {
    saveCurrentSession();
    currentSessionId = null;
    selectedBooks.clear();
    selectedMinds.clear();
    activeMinds.clear();
    _mindsInvitedOnce = false;
    window.location.hash = '#/';
  });

  navigate();
  ensurePolling();
  startGreetingIconSwap();
}

function bindComposerControls() {
  if (_composerControlsBound) return;
  _composerControlsBound = true;

  // Home composer
  const homeInput = document.getElementById('home-input');
  autoResize(homeInput);
  bindEnterSend(homeInput, handleHomeSend);
  bindMentionAutocomplete(homeInput);
  document.getElementById('home-send-btn').addEventListener('click', handleHomeSend);

  // Home + button → books popover
  const uploadBtn = document.getElementById('upload-btn');
  const uploadInput = document.getElementById('upload-file-input');
  uploadBtn.addEventListener('click', e => { e.stopPropagation(); togglePopover('home-popover', 'home-popover-book-list', 'home-popover-no-books'); });
  document.getElementById('home-popover-upload').addEventListener('click', () => { closeAllPopovers(); uploadInput.click(); });
  uploadInput.addEventListener('change', () => { if (uploadInput.files.length) { handleFileUpload(uploadInput.files); uploadInput.value = ''; } });
  const homeUrlInput = document.getElementById('home-popover-url-input');
  document.getElementById('home-popover-url-import').addEventListener('click', () => handleUploadFromUrl(homeUrlInput.value, homeUrlInput));
  homeUrlInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); handleUploadFromUrl(homeUrlInput.value, homeUrlInput); }
  });
  document.getElementById('home-popover-url-toggle').addEventListener('click', e => {
    e.stopPropagation();
    const panel = document.getElementById('home-popover-url-panel');
    const toggle = document.getElementById('home-popover-url-toggle');
    const willOpen = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !willOpen);
    toggle.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    if (willOpen) requestAnimationFrame(() => homeUrlInput.focus());
  });
  document.getElementById('home-popover-search').addEventListener('input', () => {
    renderPopoverBookList('home-popover-book-list', 'home-popover-no-books');
  });

  // Home minds button → minds popover
  document.getElementById('home-minds-btn').addEventListener('click', e => {
    e.stopPropagation();
    toggleMindPopover('home-minds-popover', 'home-popover-mind-list', 'home-popover-no-minds');
  });
  document.getElementById('home-minds-search').addEventListener('input', () => {
    renderPopoverMindList('home-popover-mind-list', 'home-popover-no-minds');
  });

  // Chat page composer
  const chatInput = document.getElementById('chat-input');
  autoResize(chatInput);
  bindEnterSend(chatInput, handleChatSend);
  bindMentionAutocomplete(chatInput);
  document.getElementById('chat-send-btn').addEventListener('click', handleChatSend);

  // Chat + button → books popover
  const chatPlusBtn = document.getElementById('chat-plus-btn');
  const chatUploadInput = document.getElementById('chat-upload-file-input');
  chatPlusBtn.addEventListener('click', e => { e.stopPropagation(); togglePopover('chat-popover', 'popover-book-list', 'popover-no-books'); });
  document.getElementById('popover-upload-action').addEventListener('click', () => { closeAllPopovers(); chatUploadInput.click(); });
  chatUploadInput.addEventListener('change', () => { if (chatUploadInput.files.length) { handleFileUpload(chatUploadInput.files); chatUploadInput.value = ''; } });
  const chatUrlInput = document.getElementById('chat-popover-url-input');
  document.getElementById('chat-popover-url-import').addEventListener('click', () => handleUploadFromUrl(chatUrlInput.value, chatUrlInput));
  chatUrlInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); handleUploadFromUrl(chatUrlInput.value, chatUrlInput); }
  });
  document.getElementById('chat-popover-url-toggle').addEventListener('click', e => {
    e.stopPropagation();
    const panel = document.getElementById('chat-popover-url-panel');
    const toggle = document.getElementById('chat-popover-url-toggle');
    const willOpen = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !willOpen);
    toggle.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    if (willOpen) requestAnimationFrame(() => chatUrlInput.focus());
  });
  document.getElementById('chat-popover-search').addEventListener('input', () => {
    renderPopoverBookList('popover-book-list', 'popover-no-books');
  });

  // Chat minds button → minds popover
  document.getElementById('chat-minds-btn').addEventListener('click', e => {
    e.stopPropagation();
    toggleMindPopover('chat-minds-popover', 'popover-mind-list', 'popover-no-minds');
  });
  document.getElementById('chat-minds-search').addEventListener('input', () => {
    renderPopoverMindList('popover-mind-list', 'popover-no-minds');
  });
  document.addEventListener('click', e => {
    document.querySelectorAll('.composer-popover').forEach(pop => {
      if (!pop.classList.contains('hidden') && !pop.contains(e.target) && !e.target.closest('.composer-icon-btn')) {
        pop.classList.add('hidden');
      }
    });
    document.querySelectorAll('.canvas-share-wrap.open').forEach(w => {
      if (!w.contains(e.target)) w.classList.remove('open');
    });
  });

  // Book chat
  const bookInput = document.getElementById('book-chat-input');
  autoResize(bookInput);
  bindMentionAutocomplete(bookInput);
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
      if (btn.dataset.filter === 'all') {
        activeTopics.clear();
        renderTopicTags();
      }
      renderLibraryGrid();
    });
  });

  // Minds page
  document.getElementById('minds-search').addEventListener('input', e => {
    _applyGraphHighlight(e.target.value.trim());
  });
  document.getElementById('minds-add-btn').addEventListener('click', () => {
    if (!isProUser()) { showProOverlay(); return; }
    showAddMindDialog();
  });
  document.getElementById('minds-create-btn').addEventListener('click', () => {
    if (!isProUser()) { showProOverlay(); return; }
    showCreateMindDialog();
  });

  // Mind chat
  const mindInput = document.getElementById('mind-chat-input');
  autoResize(mindInput);
  bindMentionAutocomplete(mindInput);
  bindEnterSend(mindInput, () => {
    const msg = mindInput.value.trim();
    if (msg && currentMindId) { mindInput.value = ''; sendMindChat(currentMindId, msg); }
  });
  document.getElementById('mind-send-btn').addEventListener('click', () => {
    const msg = mindInput.value.trim();
    if (msg && currentMindId) { mindInput.value = ''; sendMindChat(currentMindId, msg); }
  });

  // Mind + button → books popover
  const mindPlusBtn = document.getElementById('mind-plus-btn');
  const mindUploadInput = document.getElementById('mind-upload-file-input');
  mindPlusBtn.addEventListener('click', e => { e.stopPropagation(); togglePopover('mind-popover', 'mind-popover-book-list', 'mind-popover-no-books'); });
  document.getElementById('mind-popover-upload').addEventListener('click', () => { closeAllPopovers(); mindUploadInput.click(); });
  mindUploadInput.addEventListener('change', () => { if (mindUploadInput.files.length) { handleFileUpload(mindUploadInput.files); mindUploadInput.value = ''; } });
  const mindUrlInput = document.getElementById('mind-popover-url-input');
  document.getElementById('mind-popover-url-import').addEventListener('click', () => handleUploadFromUrl(mindUrlInput.value, mindUrlInput));
  mindUrlInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); handleUploadFromUrl(mindUrlInput.value, mindUrlInput); }
  });
  document.getElementById('mind-popover-url-toggle').addEventListener('click', e => {
    e.stopPropagation();
    const panel = document.getElementById('mind-popover-url-panel');
    const toggle = document.getElementById('mind-popover-url-toggle');
    const willOpen = panel.classList.contains('hidden');
    panel.classList.toggle('hidden', !willOpen);
    toggle.setAttribute('aria-expanded', willOpen ? 'true' : 'false');
    if (willOpen) requestAnimationFrame(() => mindUrlInput.focus());
  });
  document.getElementById('mind-popover-search').addEventListener('input', () => {
    renderPopoverBookList('mind-popover-book-list', 'mind-popover-no-books');
  });

  // Mind minds button → minds popover
  document.getElementById('mind-minds-btn').addEventListener('click', e => {
    e.stopPropagation();
    toggleMindPopover('mind-minds-popover', 'mind-popover-mind-list', 'mind-popover-no-minds');
  });
  document.getElementById('mind-minds-search').addEventListener('input', () => {
    renderPopoverMindList('mind-popover-mind-list', 'mind-popover-no-minds');
  });
}

function startGreetingIconSwap() {
  const intervals = [2500, 4000, 6000];
  let tick = 0;
  function doSwap() {
    const wraps = document.querySelectorAll('.greeting-logo-wrap');
    wraps.forEach(wrap => {
      if (wrap.offsetParent === null) return;
      wrap.classList.add('bounce');
      setTimeout(() => wrap.classList.toggle('swap'), 200);
      wrap.addEventListener('animationend', () => wrap.classList.remove('bounce'), { once: true });
    });
  }
  function scheduleNext() {
    const delay = tick < intervals.length
      ? intervals[tick++]
      : 8000 + Math.random() * 12000;
    setTimeout(() => { doSwap(); scheduleNext(); }, delay);
  }
  scheduleNext();
}

init();
