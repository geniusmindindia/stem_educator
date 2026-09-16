const CONFIG_KEY = 'tenant_branding';

let cachedConfig = null;

function getCached() {
  if (cachedConfig) return cachedConfig;
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) {
      cachedConfig = JSON.parse(raw);
      return cachedConfig;
    }
  } catch (e) { /* ignore */ }
  return null;
}

export async function fetchBranding() {
  try {
    let token = null;
    try { token = localStorage.getItem('auth_token'); } catch (e) { /* ignore */ }
    const res = await fetch('/api/tenant/config', {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    const data = await res.json();
    cachedConfig = data;
    try { localStorage.setItem(CONFIG_KEY, JSON.stringify(data)); } catch (e) { /* ignore */ }
    applyBranding(data);
    updateBrandingLogo();
    return data;
  } catch (e) {
    const cached = getCached();
    if (cached) { applyBranding(cached); updateBrandingLogo(); }
    return cached || null;
  }
}

export function getBranding() {
  return cachedConfig || getCached();
}

function setCSSVar(name, value) {
  if (value !== undefined && value !== null && value !== '') {
    document.documentElement.style.setProperty(name, value);
  }
}

function loadInterFont() {
  if (document.querySelector('#inter-font-link')) return;
  const link = document.createElement('link');
  link.id = 'inter-font-link';
  link.rel = 'stylesheet';
  link.href = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap';
  document.head.appendChild(link);
}

export function applyDesignTokens(tokens) {
  if (!tokens) return;
  loadInterFont();
  const root = document.documentElement;
  root.style.setProperty('--ds-font-family', tokens.fontFamily || "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif");
  root.style.fontFamily = 'var(--ds-font-family)';
  // colors
  if (tokens.colors) {
    for (const [key, val] of Object.entries(tokens.colors)) {
      setCSSVar(`--ds-${key}`, val);
      if (key === 'primary') setCSSVar('--brand-primary', val);
      if (key === 'secondary') setCSSVar('--brand-secondary', val);
      if (key === 'background') setCSSVar('--brand-background', val);
    }
  }
  // typography
  if (tokens.typography) {
    for (const [level, props] of Object.entries(tokens.typography)) {
      if (typeof props === 'object') {
        for (const [prop, val] of Object.entries(props)) {
          const cssProp = `--ds-${level}-${prop}`;
          const cssVal = typeof val === 'string' && val.match(/^\d+px$/) ? val : String(val);
          setCSSVar(cssProp, cssVal);
        }
      }
    }
  }
  // rounded
  if (tokens.rounded) {
    for (const [key, val] of Object.entries(tokens.rounded)) {
      const cssKey = key === 'DEFAULT' ? 'rounded' : `rounded-${key}`;
      setCSSVar(`--ds-${cssKey}`, val);
    }
  }
  // spacing
  if (tokens.spacing) {
    for (const [key, val] of Object.entries(tokens.spacing)) {
      setCSSVar(`--ds-${key}`, typeof val === 'number' ? `${val}px` : val);
    }
  }
}

export function applyBranding(config) {
  if (!config) return;
  const root = document.documentElement;

  if (config.primaryColor) {
    root.style.setProperty('--brand-primary', config.primaryColor);
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', config.primaryColor);
  }
  if (config.secondaryColor) {
    root.style.setProperty('--brand-secondary', config.secondaryColor);
  }
  if (config.appName) {
    document.title = config.appName;
  }
  if (config.logoUrl) {
    root.style.setProperty('--brand-logo', `url(${config.logoUrl})`);
  }
  if (config.faviconUrl) {
    let link = document.querySelector('link[rel="icon"]');
    if (!link) {
      link = document.createElement('link');
      link.rel = 'icon';
      document.head.appendChild(link);
    }
    link.href = config.faviconUrl;
  }
  // Apply design system tokens from tenant config
  if (config.designTokens) {
    applyDesignTokens(config.designTokens);
  }
  applyBrandingLogo(config);
}

export function applyBrandingLogo(config) {
  const logo = document.getElementById('logo_img');
  if (logo && config && config.logoUrl) {
    logo.src = config.logoUrl;
  }
}

export function updateBrandingLogo() {
  const cfg = getBranding();
  if (cfg && cfg.logoUrl) {
    const logo = document.getElementById('logo_img');
    if (logo) { logo.src = cfg.logoUrl; return; }
    // retry for up to 5s in case React hasn't mounted yet
    let attempts = 0;
    const iv = setInterval(() => {
      const el = document.getElementById('logo_img');
      if (el) { el.src = cfg.logoUrl; clearInterval(iv); }
      if (++attempts > 10) clearInterval(iv);
    }, 500);
  }
}
