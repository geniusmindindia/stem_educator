/**
 * StemEducatorApp — One-time Setup Wizard
 * Run once on the server machine before first launch.
 */

'use strict';
const { execSync, spawnSync } = require('child_process');
const readline = require('readline');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const ROOT = __dirname;
const ENV_FILE = path.join(ROOT, 'backend', '.env');

// ── reuse previous config on re-run ─────────────────────────────────────────
// Re-running the wizard against a database that already has data (e.g. after
// an uninstall/reinstall that kept the DB, or just re-configuring) must not
// invent a fresh INSTANCE_ID or ADMIN_PASSWORD each time - the old tenant row
// and admin account are still there, and a new random value would silently
// stop matching them (tenant subdomain collision, wrong password at login).
function readOldEnv() {
  try {
    const raw = fs.readFileSync(ENV_FILE, 'utf8');
    const out = {};
    for (const line of raw.split('\n')) {
      const m = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (m) out[m[1]] = m[2];
    }
    return out;
  } catch {
    return null;
  }
}
const oldEnv = readOldEnv();

// ── colours ──────────────────────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  cyan: '\x1b[36m',
  dim: '\x1b[2m',
};
const ok = (s) => console.log(c.green + '  ✔  ' + c.reset + s);
const warn = (s) => console.log(c.yellow + '  ⚠  ' + c.reset + s);
const err = (s) => console.error(c.red + '  ✘  ' + c.reset + s);
const info = (s) => console.log(c.cyan + '  →  ' + c.reset + s);
const header = (s) => {
  console.log('');
  console.log(c.bold + c.cyan + '  ' + s + c.reset);
  console.log(c.dim + '  ' + '─'.repeat(s.length) + c.reset);
};

// ── prompt helper ─────────────────────────────────────────────────────────────
// When stdin is not a TTY (installer [Run], silent, CI) or --yes is passed,
// auto-accept defaults instead of hanging forever waiting for input.
const NON_INTERACTIVE = !process.stdin.isTTY || process.argv.includes('--yes') || process.argv.includes('-y');
if (NON_INTERACTIVE) {
  console.log('  →  Non-interactive mode detected: accepting defaults (use --yes to force).');
}
const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
function ask(question, defaultVal) {
  if (NON_INTERACTIVE) {
    const hint = defaultVal !== undefined && defaultVal !== '' ? ` [${defaultVal}]` : '';
    console.log('    ' + question + hint + ': ' + (defaultVal || '') + '  (auto)');
    return Promise.resolve(defaultVal || '');
  }
  return new Promise((resolve) => {
    const hint = defaultVal !== undefined && defaultVal !== '' ? ` [${defaultVal}]` : '';
    rl.question('    ' + question + hint + ': ', (ans) => {
      resolve(ans.trim() || defaultVal || '');
    });
  });
}
function askSecret(question, fallback) {
  if (NON_INTERACTIVE) {
    // Use the caller-provided fallback (env var or generated default) so unattended
    // installs still end up with a working password instead of an empty one.
    const envPw = fallback !== undefined ? fallback : '';
    console.log('    ' + question + ': ' + (envPw ? '(auto, hidden)' : '(auto: empty - edit backend\\.env later)'));
    return Promise.resolve(envPw);
  }
  return new Promise((resolve) => {
    // Show a default hint (like ask()) so pressing Enter doesn't silently send an
    // empty password - that's exactly what caused "fe_sendauth: no password supplied".
    const hint = fallback ? ` [${fallback}]` : '';
    process.stdout.write('    ' + question + hint + ': ');
    // hide input on unix; on windows readline shows it (no way around in pure Node)
    rl.question('', (ans) => {
      resolve(ans.trim() || fallback || '');
    });
  });
}

// ── prerequisite checks ───────────────────────────────────────────────────────
function checkNode() {
  try {
    const v = process.version.replace('v', '').split('.').map(Number);
    if (v[0] < 18) {
      err('Node.js v18+ required. You have ' + process.version);
      return false;
    }
    ok('Node.js ' + process.version);
    return true;
  } catch (e) {
    err('Node.js not found');
    return false;
  }
}

function findPsql() {
  // 1) PATH
  try {
    const r = spawnSync('psql', ['--version'], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0 && !r.error) return 'psql';
  } catch {}
  // 2) Common Windows install locations
  const candidates = [];
  for (let v = 18; v >= 10; v--) {
    candidates.push(`C:\\Program Files\\PostgreSQL\\${v}\\bin\\psql.exe`);
    candidates.push(`C:\\Program Files (x86)\\PostgreSQL\\${v}\\bin\\psql.exe`);
  }
  for (const p of candidates) { try { if (fs.existsSync(p)) return p; } catch {} }
  return null;
}
let _psqlCmd = null;
function checkPostgres() {
  _psqlCmd = findPsql();
  if (_psqlCmd) {
    try {
      // No shell: Node's spawnSync handles a path with spaces (e.g. "C:\Program
      // Files\...") correctly on its own. Wrapping in quotes + shell:true here
      // used to break it instead - cmd.exe re-tokenized on the space and tried
      // to run "C:\Program" as the executable.
      const r = spawnSync(_psqlCmd, ['--version'], { encoding: 'utf8', windowsHide: true });
      if (r.stdout) { ok('PostgreSQL client: ' + r.stdout.trim()); return true; }
      ok('PostgreSQL client found: ' + _psqlCmd);
      return true;
    } catch {}
  }
  warn('psql not found in PATH — cannot auto-create database.');
  warn('Install PostgreSQL 14+ or add its bin/ folder to PATH, then re-run setup.');
  return false;
}

// ── dependency check / auto-install ───────────────────────────────────────────
function hasBackendDeps() {
  try { return fs.existsSync(path.join(ROOT, 'backend', 'node_modules', 'express', 'package.json')); } catch { return false; }
}
function hasFrontendDeps() {
  try { return fs.existsSync(path.join(ROOT, 'frontend', 'node_modules', 'react', 'package.json')); } catch { return false; }
}
function ensureDeps() {
  // Backend is required — without it `npm start` throws MODULE_NOT_FOUND (express)
  if (!hasBackendDeps()) {
    info('Backend dependencies missing — installing (this may take 2-3 minutes)...');
    try {
      // Use --omit=dev to skip jest/nodemon; fall back to --legacy-peer-deps on failure
      execSync('npm install --omit=dev', { cwd: path.join(ROOT, 'backend'), stdio: 'inherit' });
      ok('Backend dependencies installed');
    } catch (e) {
      warn('First install failed, retrying with --legacy-peer-deps...');
      try {
        execSync('npm install --legacy-peer-deps', { cwd: path.join(ROOT, 'backend'), stdio: 'inherit' });
        ok('Backend dependencies installed (legacy-peer-deps)');
      } catch (e2) {
        err('Backend npm install failed. Run manually:  cd backend && npm install');
        err('Error: ' + (e2.message || e2));
        return false;
      }
    }
  } else {
    ok('Backend dependencies present');
    // Ensure dotenv is present (setup writes .env that backend loads at boot)
    if (!fs.existsSync(path.join(ROOT, 'backend', 'node_modules', 'dotenv', 'package.json'))) {
      info('Installing dotenv...');
      try { execSync('npm install dotenv --save', { cwd: path.join(ROOT, 'backend'), stdio: 'inherit' }); } catch {}
    }
  }
  // Frontend runtime only needs frontend/dist (served statically). Skip heavy
  // 'npm install' when dist already exists - it is not needed to run.
  const distOk = fs.existsSync(path.join(ROOT, 'frontend', 'dist', 'index.html'));
  if (distOk) {
    ok('Frontend build present (frontend/dist) - skipping frontend npm install');
  } else if (fs.existsSync(path.join(ROOT, 'frontend', 'package.json')) && !hasFrontendDeps()) {
    info('Frontend dependencies missing — installing...');
    try {
      execSync('npm install', { cwd: path.join(ROOT, 'frontend'), stdio: 'inherit' });
      ok('Frontend dependencies installed');
    } catch (e) {
      warn('Frontend npm install failed: ' + e.message);
      warn('Run manually:  cd frontend && npm install');
    }
  } else if (fs.existsSync(path.join(ROOT, 'frontend', 'package.json'))) {
    ok('Frontend dependencies present');
  }
  // Ensure logs/ exists so winston doesn't fail on first write
  try { fs.mkdirSync(path.join(ROOT, 'backend', 'logs'), { recursive: true }); } catch {}
  return true;
}

// ── database creation ─────────────────────────────────────────────────────────
// ---- postgres connection test (validates host/port/user/password BEFORE create) ----
function testPgConnection(host, port, user, password) {
  try {
    const psql = _psqlCmd || 'psql';
    const env = Object.assign({}, process.env, { PGPASSWORD: password });
    const r = spawnSync(
      psql,
      ['-h', host, '-p', String(port), '-U', user, '-d', 'postgres', '-w', '-c', 'SELECT 1;'],
      { env, encoding: 'utf8', windowsHide: true, timeout: 10000 }
    );
    if (r.status === 0) return { ok: true };
    if (r.status === null) return { ok: false, error: 'psql timed out (wrong/missing password, or server unreachable)' };
    const out = ((r.stderr || '') + ' ' + (r.stdout || '')).trim();
    return { ok: false, error: out || 'connection failed (exit ' + r.status + ')' };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function dbExists(host, port, user, password, dbName) {
  try {
    const psql = _psqlCmd || 'psql';
    const env = Object.assign({}, process.env, { PGPASSWORD: password });
    const q = "SELECT 1 FROM pg_database WHERE datname='" + dbName.replace(/'/g, "''") + "';";
    const r = spawnSync(
      psql,
      ['-h', host, '-p', String(port), '-U', user, '-d', 'postgres', '-w', '-tAc', q],
      { env, encoding: 'utf8', windowsHide: true, timeout: 10000 }
    );
    return r.status === 0 && (r.stdout || '').indexOf('1') !== -1;
  } catch (e) { return false; }
}

// ---- database creation ----
function createDatabase(host, port, user, password, dbName) {
  try {
    const psql = _psqlCmd || 'psql';
    const env = Object.assign({}, process.env, { PGPASSWORD: password });
    const r = spawnSync(
      psql,
      ['-h', host, '-p', String(port), '-U', user, '-w', '-c', `CREATE DATABASE "${dbName}";`],
      { env, encoding: 'utf8', windowsHide: true, timeout: 10000 }
    );
    if (r.status === 0 || (r.stderr && r.stderr.includes('already exists'))) {
      ok(`Database "${dbName}" ready`);
      return true;
    }
    warn('Database create output: ' + (r.stderr || r.stdout || 'unknown error'));
    return false;
  } catch (e) {
    warn('Could not auto-create database: ' + e.message);
    return false;
  }
}

// ── .env writer ───────────────────────────────────────────────────────────────
function writeEnv(cfg) {
  const content = `# ===== Server =====
PORT=${cfg.port}
BACKEND_URL=${cfg.backendUrl}
FRONTEND_URL=${cfg.backendUrl}

# ===== PostgreSQL =====
PGHOST=${cfg.pgHost}
PGPORT=${cfg.pgPort}
PGUSER=${cfg.pgUser}
PGPASSWORD=${cfg.pgPassword}
PGDATABASE=${cfg.pgDatabase}

# ===== JWT =====
JWT_SECRET=${cfg.jwtSecret}
JWT_EXPIRES_IN=7d

# ===== White-label / Instance =====
INSTANCE_ID=${cfg.instanceId}
APP_NAME=StemEducatorApp
COMPANY_NAME=${cfg.companyName}

# ===== White-label DNS (CNAME target) =====
PLATFORM_HOST=${cfg.platformHost}

# ===== Initial Super Admin =====
ADMIN_EMAIL=${cfg.adminEmail}
ADMIN_PASSWORD=${cfg.adminPassword}
ADMIN_USERNAME=superadmin

# ===== Additional Admin (optional; role 'admin', not Super Admin) =====
ADMIN2_EMAIL=${cfg.admin2Email || ''}
ADMIN2_PASSWORD=${cfg.admin2Password || ''}
ADMIN2_USERNAME=${cfg.admin2Username || ''}

# ===== Google SSO (optional) =====
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# ===== Microsoft SSO (optional) =====
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
MICROSOFT_TENANT=common

# ===== Stripe Billing (optional) =====
STRIPE_SECRET_KEY=
STRIPE_WEBHOOK_SECRET=
`;
  fs.writeFileSync(ENV_FILE, content, 'utf8');
  ok('.env written to backend\\.env');
}

// ── desktop shortcut ──────────────────────────────────────────────────────────
function createShortcut() {
  try {
    const startBat = path.join(ROOT, 'start.bat');
    // Resolve real Desktop (handles OneDrive redirection)
    let desktop = path.join(os.homedir(), 'Desktop');
    try {
      const r = spawnSync('powershell', ['-NoProfile', '-Command', `[Environment]::GetFolderPath('Desktop')`], { encoding: 'utf8', windowsHide: true });
      const p = (r.stdout || '').trim();
      if (p && fs.existsSync(p)) desktop = p;
    } catch {}
    const lnk = path.join(desktop, 'StemEducatorApp.lnk');
    const ps = [
      `$s=New-Object -ComObject WScript.Shell`,
      `$lnk=$s.CreateShortcut('${lnk.replace(/'/g, "''")}')`,
      `$lnk.TargetPath='${startBat.replace(/'/g, "''")}'`,
      `$lnk.WorkingDirectory='${ROOT.replace(/'/g, "''")}'`,
      `$lnk.Description='StemEducatorApp Server'`,
      `$lnk.IconLocation='${startBat.replace(/'/g, "''")},0'`,
      `$lnk.Save()`,
    ].join(';');
    const r2 = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8', windowsHide: true });
    if (r2.status === 0) ok('Desktop shortcut created: ' + lnk);
    else warn('Could not create desktop shortcut: ' + (r2.stderr || r2.error || 'unknown'));
  } catch (e) {
    warn('Could not create desktop shortcut: ' + e.message);
  }
}

// ── firewall rule (Windows) ───────────────────────────────────────────────────
function addFirewallRule(port) {
  try {
    const r = spawnSync('powershell', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      `New-NetFirewallRule -DisplayName 'StemEducatorApp' -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow -ErrorAction SilentlyContinue | Out-Null; if($?) { exit 0 } else { exit 1 }`,
    ], { encoding: 'utf8', windowsHide: true });
    if (r.status === 0) ok(`Firewall: inbound rule for port ${port} added`);
    else warn('Firewall rule not added (run setup as Administrator for LAN access).');
  } catch {
    warn('Could not add firewall rule — add it manually if remote access needed');
  }
}

// ── main ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log('');
  console.log(c.bold + '  ╔══════════════════════════════════════════╗' + c.reset);
  console.log(c.bold + '  ║   StemEducatorApp — Setup Wizard  v1.0   ║' + c.reset);
  console.log(c.bold + '  ╚══════════════════════════════════════════╝' + c.reset);
  console.log('');
  console.log(c.dim + '  This wizard configures the server for first use.' + c.reset);
  console.log(c.dim + '  Press Enter to accept the default shown in brackets.' + c.reset);
  console.log('');

  // ── 1. Prerequisites ───────────────────────────────────────────────────────
  header('Checking prerequisites');
  const nodeOk = checkNode();
  const pgAvailable = checkPostgres();
  if (!nodeOk) {
    err('Install Node.js v18+ from https://nodejs.org and re-run setup.');
    process.exit(1);
  }

  // ── 1b. Dependencies (fix for MODULE_NOT_FOUND: express) ─────────────────
  header('Installing dependencies');
  ensureDeps();

  // ── 2. Server URL ──────────────────────────────────────────────────────────
  header('Server / Domain');
  info('Leave as http://localhost:3001 if you are running locally.');
  const backendUrl = await ask('Server URL (no trailing slash)', (oldEnv && oldEnv.BACKEND_URL) || 'http://localhost:3001');
  const platformHost = backendUrl.replace(/^https?:\/\//, '').split('/')[0];
  const port = parseInt((backendUrl.match(/:(\d+)$/) || [])[1] || '3001', 10);

  // ── 3. Database ────────────────────────────────────────────────────────────
  header('PostgreSQL Database');
  info('PostgreSQL must already be installed and running.');
  const pgHost = await ask('Host', (oldEnv && oldEnv.PGHOST) || 'localhost');
  const pgPort = await ask('Port', (oldEnv && oldEnv.PGPORT) || '5432');
  const pgUser = await ask('Username', (oldEnv && oldEnv.PGUSER) || 'postgres');
  const pgPasswordDefault = process.env.SETUP_PG_PASSWORD || process.env.PGPASSWORD || (oldEnv && oldEnv.PGPASSWORD) || 'postgres';
  let pgPassword = await askSecret('Password (input may be visible)', pgPasswordDefault);
  let pgDatabase = await ask('Database name (will be created if it does not exist)', (oldEnv && oldEnv.PGDATABASE) || 'stemeducatorapp');
  const isReconfigureOfThisInstall = !!(oldEnv && oldEnv.PGDATABASE === pgDatabase);

  if (pgAvailable) {
    let pgPasswordLive = pgPassword;
    let conn = testPgConnection(pgHost, pgPort, pgUser, pgPasswordLive);
    let tries = 1;
    while (!conn.ok && tries < 3 && !NON_INTERACTIVE) {
      err('PostgreSQL connection failed: ' + conn.error);
      info('Check: service running (services.msc -> postgresql), host/port, username, password.');
      pgPasswordLive = await askSecret('Password - try again (input may be visible)');
      conn = testPgConnection(pgHost, pgPort, pgUser, pgPasswordLive);
      tries++;
    }
    if (!conn.ok) {
      err('Cannot connect to PostgreSQL: ' + conn.error);
      err('Fix and re-run: install/start PostgreSQL, verify password, then run Setup.ps1 again.');
      err('Manual fix: CREATE DATABASE ' + pgDatabase + '; then edit backend\\.env (PGPASSWORD).');
      process.exit(1);
    }
    ok('PostgreSQL connection OK');
    if (dbExists(pgHost, pgPort, pgUser, pgPasswordLive, pgDatabase)) {
      if (isReconfigureOfThisInstall) {
        // Re-running setup against this same install's own database - keep using it
        // (that's what makes the previous-password/instance-id reuse above correct).
        ok('Database already exists - reusing it (matches this install\'s previous config)');
      } else {
        // Fresh install / different target, but something with this name already exists
        // (a stray DB, or another app) - don't touch it. Auto-pick a free name instead.
        let candidate = pgDatabase;
        let n = 2;
        while (dbExists(pgHost, pgPort, pgUser, pgPasswordLive, candidate) && n < 100) {
          candidate = `${pgDatabase}_${n}`;
          n++;
        }
        warn(`Database "${pgDatabase}" already exists - using "${candidate}" instead so it is not touched.`);
        pgDatabase = candidate;
        if (!createDatabase(pgHost, pgPort, pgUser, pgPasswordLive, pgDatabase)) {
          err('Could not create database. Create it manually then re-run setup.');
          process.exit(1);
        }
      }
    } else if (!createDatabase(pgHost, pgPort, pgUser, pgPasswordLive, pgDatabase)) {
      err('Could not create database. Create it manually then re-run setup.');
      process.exit(1);
    }
    if (!dbExists(pgHost, pgPort, pgUser, pgPasswordLive, pgDatabase)) {
      err('Database still not found after create. Aborting.');
      process.exit(1);
    }
    pgPassword = pgPasswordLive;
  } else {
    warn(`Create the database manually: CREATE DATABASE "${pgDatabase}";`);
  }

  // ── 4. Admin account ───────────────────────────────────────────────────────
  header('Super-Admin Account');
  info('These credentials let you log in to the admin panel.');
  const adminEmail = await ask('Admin email', (oldEnv && oldEnv.ADMIN_EMAIL) || 'admin@yourdomain.com');
  // Reuse the previous run's password by default - a fresh random one here would
  // stop matching the account already hashed into the (possibly still-existing) DB.
  const reusingOldAdminPassword = !!(oldEnv && oldEnv.ADMIN_PASSWORD);
  const generatedAdminPassword = 'Admin-' + crypto.randomBytes(6).toString('hex');
  const adminPasswordDefault = process.env.SETUP_ADMIN_PASSWORD || (oldEnv && oldEnv.ADMIN_PASSWORD) || generatedAdminPassword;
  const adminPassword = await askSecret('Admin password (min 8 chars, input may be visible)', adminPasswordDefault);
  if (reusingOldAdminPassword && adminPassword === oldEnv.ADMIN_PASSWORD) {
    info('Reusing admin password from the previous backend\\.env (account may already exist in the DB).');
  } else if (NON_INTERACTIVE && adminPassword === generatedAdminPassword) {
    warn('No SETUP_ADMIN_PASSWORD given - generated admin password: ' + adminPassword);
    warn('Write it down now; it is also saved in backend\\.env (ADMIN_PASSWORD).');
  }

  // ── 4b. Additional Admin account (optional) ───────────────────────────────
  // Plain 'admin' role: full admin panel access (Users, Roles, Audit, Dashboard)
  // but NOT the Super Admin-only areas (Tenants, White-Label, Documentation).
  // Useful for day-to-day staff who shouldn't hold the top-level account.
  header('Additional Admin Account (optional)');
  info("Role 'admin' - full admin panel access, without Super Admin-only pages.");
  const wantsExtraAdminDefault = (oldEnv && oldEnv.ADMIN2_EMAIL) || process.env.SETUP_ADMIN2_EMAIL ? 'y' : 'n';
  const wantsExtraAdmin = await ask('Create an additional admin account? [y/N]', wantsExtraAdminDefault);
  let admin2Email = '';
  let admin2Password = '';
  let admin2Username = '';
  if (/^y/i.test(wantsExtraAdmin)) {
    admin2Email = await ask('Admin email', process.env.SETUP_ADMIN2_EMAIL || (oldEnv && oldEnv.ADMIN2_EMAIL) || '');
    admin2Username = await ask('Admin username', process.env.SETUP_ADMIN2_USERNAME || (oldEnv && oldEnv.ADMIN2_USERNAME) || (admin2Email.split('@')[0] || 'admin'));
    const reusingOldAdmin2Password = !!(oldEnv && oldEnv.ADMIN2_PASSWORD);
    const generatedAdmin2Password = 'Admin-' + crypto.randomBytes(6).toString('hex');
    const admin2PasswordDefault = process.env.SETUP_ADMIN2_PASSWORD || (oldEnv && oldEnv.ADMIN2_PASSWORD) || generatedAdmin2Password;
    admin2Password = await askSecret('Admin password (min 8 chars, input may be visible)', admin2PasswordDefault);
    if (!admin2Email) {
      warn('No email given - skipping additional admin account.');
      admin2Password = '';
    } else if (reusingOldAdmin2Password && admin2Password === oldEnv.ADMIN2_PASSWORD) {
      info('Reusing admin password from the previous backend\\.env.');
    } else if (NON_INTERACTIVE && admin2Password === generatedAdmin2Password) {
      warn('No SETUP_ADMIN2_PASSWORD given - generated password: ' + admin2Password);
      warn('Write it down now; it is also saved in backend\\.env (ADMIN2_PASSWORD).');
    }
  }

  // ── 5. Company info ────────────────────────────────────────────────────────
  header('Company / Deployment Info');
  const companyName = await ask('Company name', (oldEnv && oldEnv.COMPANY_NAME) || 'Your Company');
  const instanceId = await ask('Unique instance ID (letters/numbers only)', (oldEnv && oldEnv.INSTANCE_ID) || 'instance-' + crypto.randomBytes(4).toString('hex'));

  // ── 6. Auto-generate JWT secret ───────────────────────────────────────────
  const jwtSecret = crypto.randomBytes(48).toString('hex');

  // ── 7. Write config ────────────────────────────────────────────────────────
  header('Writing configuration');
  writeEnv({
    port,
    backendUrl,
    platformHost,
    pgHost,
    pgPort,
    pgUser,
    pgPassword,
    pgDatabase,
    jwtSecret,
    instanceId,
    companyName,
    adminEmail,
    adminPassword,
    admin2Email,
    admin2Password,
    admin2Username,
  });

  // ── 8. Desktop shortcut ────────────────────────────────────────────────────
  header('Creating shortcuts');
  createShortcut();

  // ── 9. Firewall ────────────────────────────────────────────────────────────
  addFirewallRule(port);

  // ── 10. Done ───────────────────────────────────────────────────────────────
  console.log('');
  console.log(c.bold + c.green + '  ══════════════════════════════════════════' + c.reset);
  console.log(c.bold + c.green + '   Setup complete!' + c.reset);
  console.log(c.bold + c.green + '  ══════════════════════════════════════════' + c.reset);
  console.log('');
  console.log(c.bold + '  Next steps:' + c.reset);
  console.log('    1. Double-click  start.bat  (or the desktop shortcut)');
  console.log('    2. Open browser at: ' + c.cyan + backendUrl + c.reset);
  console.log('    3. Log in with: ' + c.cyan + adminEmail + c.reset + ' (Super Admin)');
  if (admin2Email && admin2Password) {
    console.log('       or:         ' + c.cyan + admin2Email + c.reset + ' (admin)');
  }
  console.log('');
  console.log(c.dim + '  Forgot the admin password? It is saved in backend\\.env (ADMIN_PASSWORD).' + c.reset);
  console.log(c.dim + '  Once logged in, change it from Settings > Security > Change Your Password.' + c.reset);
  console.log(c.dim + '  To re-configure, edit backend\\.env and restart the server.' + c.reset);
  console.log('');

  rl.close();
})();
