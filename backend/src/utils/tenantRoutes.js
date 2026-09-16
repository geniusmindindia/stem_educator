const { query } = require('../db/pool');
const { writeAudit, clientIp } = require('../db/init');
const { authRequired } = require('./auth');
const { createCnameRecord, deleteCnameRecord, normalizeHostname, isValidHostname } = require('./dnsManager');

function defaultPlatformHost() {
  try {
    if (process.env.BACKEND_URL) return normalizeHostname(new URL(process.env.BACKEND_URL).hostname);
  } catch (e) {}
  return 'set-PLATFORM_HOST-in-.env';
}

const PLATFORM_HOST = normalizeHostname(process.env.PLATFORM_HOST || defaultPlatformHost());
const PLATFORM_APEX = PLATFORM_HOST.split('.').slice(-2).join('.') || PLATFORM_HOST;

function dnsConfig(record, zoneId, proxied) {
  return {
    dns: record
      ? {
          provider: 'cloudflare',
          zone_id: zoneId,
          record_id: record.recordId,
          record_name: record.recordName,
          target: record.recordContent,
          proxied: !!proxied,
          status: 'created',
          created_at: new Date().toISOString(),
        }
      : { status: 'manual', created_at: new Date().toISOString() },
  };
}

function deepMerge(target, source) {
  const result = { ...target };
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key]) && target[key] && typeof target[key] === 'object') {
      result[key] = deepMerge(target[key], source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

function isSuperAdmin(req) {
  return req.auth?.role === 'Super Admin';
}

function setupTenantRoutes(app) {
  // ===== PUBLIC: Tenant onboarding / signup (custom domain only) =====
  app.post('/api/tenants/register', async (req, res) => {
    try {
      const {
        companyName, email, password, appName,
        customDomain, cloudflareZoneId, cloudflareApiToken, proxied, cnameTarget,
      } = req.body || {};

      if (!companyName || !email || !password) {
        return res.status(400).json({ error: 'companyName, email and password are required' });
      }
      if (String(password).length < 8) {
        return res.status(400).json({ error: 'Password must be at least 8 characters' });
      }
      if (!customDomain) {
        return res.status(400).json({ error: 'customDomain is required' });
      }
      if (!isValidHostname(customDomain)) {
        return res.status(400).json({ error: `Invalid domain: ${customDomain}` });
      }

      const host = normalizeHostname(customDomain);

      // Check domain not already in use
      const { rows: existing } = await query(
        'SELECT id FROM tenants WHERE LOWER(custom_domain) = $1 LIMIT 1',
        [host]
      );
      if (existing.length) {
        return res.status(409).json({ error: `Domain ${host} is already registered` });
      }

      const tid = 'tenant_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);

      // Attempt to auto-create the CNAME only when Cloudflare credentials are provided.
      // If not provided, we record the domain and let the partner set up DNS manually.
      let record = null;
      if (cloudflareApiToken && cloudflareZoneId) {
        try {
          record = await createCnameRecord({
            apiToken: cloudflareApiToken,
            zoneId: cloudflareZoneId,
            name: host,
            content: cnameTarget || PLATFORM_HOST,
            proxied,
          });
        } catch (err) {
          // Non-fatal: domain is still saved, partner sets DNS manually
          console.warn(`[tenants/register] CNAME creation skipped: ${err.message}`);
        }
      }

      await query(
        `INSERT INTO tenants (id, name, company_name, app_name, custom_domain, owner_email, status, plan, config)
         VALUES ($1, $2, $3, $4, $5, $6, 'active', 'trial', $7::jsonb)`,
        [tid, appName || companyName, companyName, appName || companyName, host, email,
         JSON.stringify(dnsConfig(record, cloudflareZoneId, proxied))]
      );

      const bcrypt = require('bcryptjs');
      const hash = await bcrypt.hash(password, 10);

      // username must be unique — use email prefix + random suffix to avoid collisions
      const baseUsername = email.split('@')[0].replace(/[^a-z0-9_]/gi, '').slice(0, 20);
      const username = baseUsername + '_' + Math.random().toString(36).slice(2, 6);

      const { rows } = await query(
        `INSERT INTO users (username, email, password_hash, role, tenant_id, status)
         VALUES ($1, $2, $3, 'Tenant Admin', $4, 'active') RETURNING id, username, email, role, tenant_id`,
        [username, email, hash, tid]
      );

      writeAudit({ tenantId: tid, actionType: 'TENANT_CREATED', details: `Company: ${companyName}, Admin: ${email}, Domain: ${host}` });
      return res.status(201).json({
        tenantId: tid,
        customDomain: host,
        cnameTarget: PLATFORM_HOST,
        cnameAutoCreated: !!record,
        user: rows[0],
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ===== SUPER ADMIN: List all tenants =====
  app.get('/api/admin/tenants', authRequired, async (req, res) => {
    if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Super Admin access required' });
    try {
      const { rows } = await query(
        `SELECT t.*, (SELECT COUNT(*) FROM users u WHERE u.tenant_id = t.id) AS user_count
         FROM tenants t ORDER BY t.created_at DESC`
      );
      return res.json({ tenants: rows });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ===== SUPER ADMIN: Get single tenant =====
  app.get('/api/admin/tenants/:id', authRequired, async (req, res) => {
    if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Super Admin access required' });
    try {
      const { rows } = await query('SELECT * FROM tenants WHERE id = $1', [req.params.id]);
      if (!rows[0]) return res.status(404).json({ error: 'Tenant not found' });
      const { rows: users } = await query('SELECT id, username, email, role, status, created_at FROM users WHERE tenant_id = $1 ORDER BY created_at DESC', [req.params.id]);
      return res.json({ tenant: rows[0], users });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ===== SUPER ADMIN: Update tenant =====
  app.patch('/api/admin/tenants/:id', authRequired, async (req, res) => {
    if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Super Admin access required' });
    try {
      const allowed = ['name', 'company_name', 'app_name', 'subdomain', 'custom_domain', 'logo_url', 'favicon_url', 'primary_color', 'secondary_color', 'plan', 'status', 'owner_email', 'user_limit'];
      const allowedJsonb = ['config'];
      const updates = [];
      const vals = [];
      let i = 1;
      for (const field of allowed) {
        if (req.body[field] !== undefined) {
          updates.push(`${field} = $${i++}`);
          vals.push(req.body[field]);
        }
      }
      for (const field of allowedJsonb) {
        if (req.body[field] !== undefined) {
          updates.push(`${field} = $${i++}::jsonb`);
          vals.push(typeof req.body[field] === 'string' ? req.body[field] : JSON.stringify(req.body[field]));
        }
      }
      if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
      updates.push(`updated_at = NOW()`);
      vals.push(req.params.id);
      await query(`UPDATE tenants SET ${updates.join(', ')} WHERE id = $${i}`, vals);
      writeAudit({ tenantId: req.params.id, userId: req.auth.sub, actorName: req.auth.email, actionType: 'TENANT_UPDATED', details: `Updated: ${updates.join(', ')}`, ip: clientIp(req) });
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ===== SUPER ADMIN: Create tenant =====
  app.post('/api/admin/tenants', authRequired, async (req, res) => {
    if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Super Admin access required' });
    try {
      const {
        name, company_name, app_name, subdomain, custom_domain, plan, status,
        owner_email, user_limit, temp_password,
        cloudflare_zone_id, cloudflare_api_token, proxied, cname_target,
      } = req.body || {};
      if (!name) return res.status(400).json({ error: 'Tenant name is required' });
      if (custom_domain && !isValidHostname(custom_domain)) {
        return res.status(400).json({ error: `Invalid tenant domain: ${custom_domain}` });
      }
      const tid = 'tenant_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const sd = subdomain || name.toLowerCase().replace(/[^a-z0-9]/g, '') + '-' + Math.random().toString(36).slice(2, 6);
      const host = custom_domain ? normalizeHostname(custom_domain) : null;

      // White-label: attempt to auto-create the CNAME only when Cloudflare credentials
      // are provided. Without them, the domain is still saved and DNS is set up manually -
      // matching the behavior of the self-serve /api/tenants/register route. A missing
      // token must not block tenant creation.
      let record = null;
      if (host && cloudflare_api_token && cloudflare_zone_id) {
        try {
          record = await createCnameRecord({
            apiToken: cloudflare_api_token,
            zoneId: cloudflare_zone_id,
            name: host,
            content: cname_target || PLATFORM_HOST,
            proxied,
          });
        } catch (err) {
          console.warn(`[admin/tenants] CNAME creation skipped for ${host}: ${err.message}`);
        }
      }

      await query(
        `INSERT INTO tenants (id, name, company_name, app_name, subdomain, custom_domain, owner_email, plan, status, user_limit, config)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11::jsonb)`,
        [tid, name, company_name || name, app_name || name, sd, host, owner_email || null, plan || 'free', status || 'active', user_limit ?? 10, JSON.stringify(dnsConfig(record, cloudflare_zone_id, proxied))]
      );
      let user = null;
      if (temp_password) {
        const bcrypt = require('bcryptjs');
        const hash = await bcrypt.hash(temp_password, 10);
        const username = (company_name || name).toLowerCase().replace(/[^a-z0-9]/g, '_') + '_admin';
        const email = owner_email || (host ? `${username}@${host}` : `${username}@${sd}.${PLATFORM_APEX}`);
        const { rows: userRows } = await query(
          `INSERT INTO users (username, email, password_hash, role, tenant_id, status)
           VALUES ($1, $2, $3, 'Tenant Admin', $4, 'active') RETURNING id, username, email, role`,
          [username, email, hash, tid]
        );
        user = userRows[0];
      }
      const { rows } = await query('SELECT * FROM tenants WHERE id = $1', [tid]);
      writeAudit({ tenantId: tid, userId: req.auth.sub, actorName: req.auth.email, actionType: 'TENANT_CREATED', details: `Created tenant ${name} (${host || sd})`, ip: clientIp(req) });
      return res.status(201).json({ tenant: rows[0], user, cname: record });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ===== SUPER ADMIN: Delete tenant =====
  app.delete('/api/admin/tenants/:id', authRequired, async (req, res) => {
    if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Super Admin access required' });
    try {
      const { rows: existing } = await query('SELECT config FROM tenants WHERE id = $1', [req.params.id]);
      const { rowCount } = await query('DELETE FROM tenants WHERE id = $1', [req.params.id]);
      if (!rowCount) return res.status(404).json({ error: 'Tenant not found' });
      // Best-effort: remove the white-label CNAME record if credentials were supplied
      const dns = existing[0] && existing[0].config && existing[0].config.dns;
      if (dns && dns.record_id && dns.zone_id && req.body && req.body.cloudflareApiToken) {
        try {
          await deleteCnameRecord({ apiToken: req.body.cloudflareApiToken, zoneId: dns.zone_id, recordId: dns.record_id });
        } catch (err) {
          writeAudit({ tenantId: req.params.id, userId: req.auth.sub, actorName: req.auth.email, actionType: 'TENANT_DELETED', status: 'FAILED', details: `Tenant deleted but CNAME removal failed: ${err.message}`, ip: clientIp(req) });
        }
      }
      writeAudit({ tenantId: req.params.id, userId: req.auth.sub, actorName: req.auth.email, actionType: 'TENANT_DELETED', details: `Deleted tenant ${req.params.id}`, ip: clientIp(req) });
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ===== TENANT ADMIN: Get own tenant settings =====
  app.get('/api/tenant/settings', authRequired, async (req, res) => {
    try {
      const { rows } = await query('SELECT * FROM tenants WHERE id = $1', [req.auth.tenant_id]);
      if (!rows[0]) return res.status(404).json({ error: 'Tenant not found' });
      return res.json({ tenant: rows[0] });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ===== Update tenant branding - Super Admin only (colors/domain/app name stay exclusive; logo/favicon are separate self-service endpoints below) =====
  app.patch('/api/tenant/settings', authRequired, async (req, res) => {
    if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Super Admin access required' });
    try {
      const allowed = ['name', 'company_name', 'app_name', 'logo_url', 'favicon_url', 'primary_color', 'secondary_color'];
      const allowedJsonb = ['config'];
      // Handle config deep-merge with existing to preserve dns etc.
      let mergedConfig = null;
      if (req.body.config !== undefined) {
        let incoming = req.body.config;
        if (typeof incoming === 'string') {
          try { incoming = JSON.parse(incoming); } catch (e) { return res.status(400).json({ error: 'Invalid config JSON' }); }
        }
        const { rows } = await query('SELECT config FROM tenants WHERE id = $1', [req.auth.tenant_id]);
        let existing = {};
        if (rows[0] && rows[0].config) {
          existing = typeof rows[0].config === 'string' ? JSON.parse(rows[0].config) : rows[0].config;
        }
        mergedConfig = deepMerge(existing, incoming);
        // normalize customDomain alias -> custom_domain column side-effect
        // will be handled below
      }

      const updates = [];
      const vals = [];
      let i = 1;
      for (const field of allowed) {
        if (req.body[field] !== undefined) {
          updates.push(`${field} = $${i++}`);
          vals.push(req.body[field]);
        }
      }
      // Sync primary/secondary from designTokens if provided and not explicitly overridden
      if (mergedConfig && mergedConfig.designTokens && mergedConfig.designTokens.colors) {
        const c = mergedConfig.designTokens.colors;
        if (c.primary && req.body.primary_color === undefined) {
          updates.push(`primary_color = $${i++}`);
          vals.push(c.primary);
        }
        if (c.secondary && req.body.secondary_color === undefined) {
          updates.push(`secondary_color = $${i++}`);
          vals.push(c.secondary);
        }
        // also sync logo_url if present in config custom?
      }
      // customDomain inside config -> update custom_domain column for Host resolution
      if (mergedConfig && mergedConfig.customDomain !== undefined) {
        const domain = mergedConfig.customDomain ? normalizeHostname(String(mergedConfig.customDomain)) : null;
        if (domain && !isValidHostname(domain)) {
          return res.status(400).json({ error: `Invalid tenant domain: ${domain}` });
        }
        updates.push(`custom_domain = $${i++}`);
        vals.push(domain);
      }
      if (mergedConfig !== null) {
        updates.push(`config = $${i++}::jsonb`);
        vals.push(JSON.stringify(mergedConfig));
      }
      if (updates.length === 0) return res.status(400).json({ error: 'No fields to update' });
      updates.push(`updated_at = NOW()`);
      vals.push(req.auth.tenant_id);
      await query(`UPDATE tenants SET ${updates.join(', ')} WHERE id = $${i}`, vals);
      writeAudit({ tenantId: req.auth.tenant_id, userId: req.auth.sub, actionType: 'TENANT_BRANDING_UPDATED', details: `Branding updated: ${updates.join(', ')}`, ip: clientIp(req) });
      return res.json({ success: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ===== TENANT: Verify custom domain DNS (real check) =====
  app.get('/api/tenant/verify-domain', authRequired, async (req, res) => {
    try {
      const domain = req.query.domain ? normalizeHostname(String(req.query.domain)) : null;
      if (!domain) return res.status(400).json({ error: 'domain query param required' });
      if (!isValidHostname(domain)) return res.status(400).json({ error: `Invalid domain: ${domain}` });
      const dns = require('dns').promises;
      let records = [];
      let cnameTarget = null;
      try {
        records = await dns.resolveCname(domain);
        cnameTarget = records[0] || null;
      } catch (e) {
        // try resolve any record as fallback
        try {
          const addrs = await dns.resolve(domain);
          cnameTarget = addrs[0] || null;
        } catch (_) {
          return res.json({ verified: false, domain, cnameTarget: null, expectedTarget: PLATFORM_HOST, message: 'No DNS record found. Create a CNAME pointing to ' + PLATFORM_HOST });
        }
      }
      const expected = PLATFORM_HOST.toLowerCase();
      const found = (cnameTarget || '').toLowerCase().replace(/\.$/, '');
      const verified = found === expected || records.map(r => r.toLowerCase().replace(/\.$/, '')).includes(expected);
      return res.json({
        verified,
        domain,
        cnameTarget: cnameTarget,
        cnameRecords: records,
        expectedTarget: PLATFORM_HOST,
        message: verified ? 'CNAME record verified successfully' : `CNAME points to ${cnameTarget || 'nothing'}, expected ${PLATFORM_HOST}`
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ===== TENANT: Upload logo =====
  // Self-service: any tenant admin can upload their own tenant's logo (scoped to req.auth.tenant_id below)
  app.post('/api/tenant/logo', authRequired, async (req, res) => {
    try {
      const multer = require('multer');
      const fs = require('fs');
      const path = require('path');
      const uploadDir = path.join(__dirname, '../../uploads/branding');
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
      const storage = multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadDir),
        filename: (req, file, cb) => {
          const ext = path.extname(file.originalname) || '.png';
          cb(null, `${req.auth.tenant_id}-${Date.now()}${ext}`);
        }
      });
      const upload = multer({
        storage,
        limits: { fileSize: 2 * 1024 * 1024 },
        fileFilter: (req, file, cb) => {
          if (!file.mimetype.startsWith('image/')) return cb(new Error('Only image files allowed'));
          cb(null, true);
        }
      }).single('logo');

      upload(req, res, async (err) => {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded. Use field name "logo"' });
        const publicUrl = `/uploads/branding/${req.file.filename}`;
        await query('UPDATE tenants SET logo_url = $1, updated_at = NOW() WHERE id = $2', [publicUrl, req.auth.tenant_id]);
        try {
          const { rows } = await query('SELECT config FROM tenants WHERE id = $1', [req.auth.tenant_id]);
          let cfg = rows[0] && rows[0].config ? (typeof rows[0].config === 'string' ? JSON.parse(rows[0].config) : rows[0].config) : {};
          cfg.brandingLogoUrl = publicUrl;
          await query('UPDATE tenants SET config = $1::jsonb WHERE id = $2', [JSON.stringify(cfg), req.auth.tenant_id]);
        } catch (_) {}
        return res.json({ success: true, url: publicUrl, logoUrl: publicUrl });
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ===== TENANT: Upload favicon =====
  // Self-service: any tenant admin can upload their own tenant's favicon (scoped to req.auth.tenant_id below)
  app.post('/api/tenant/favicon', authRequired, async (req, res) => {
    try {
      const multer = require('multer');
      const fs = require('fs');
      const path = require('path');
      const uploadDir = path.join(__dirname, '../../uploads/branding');
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
      const storage = multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadDir),
        filename: (req, file, cb) => {
          const ext = path.extname(file.originalname) || '.png';
          cb(null, `favicon-${req.auth.tenant_id}-${Date.now()}${ext}`);
        }
      });
      const upload = multer({
        storage,
        limits: { fileSize: 1 * 1024 * 1024 },
        fileFilter: (req, file, cb) => {
          if (!file.mimetype.startsWith('image/')) return cb(new Error('Only image files allowed'));
          cb(null, true);
        }
      }).single('favicon');

      upload(req, res, async (err) => {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded. Use field name "favicon"' });
        const publicUrl = `/uploads/branding/${req.file.filename}`;
        await query('UPDATE tenants SET favicon_url = $1, updated_at = NOW() WHERE id = $2', [publicUrl, req.auth.tenant_id]);
        try {
          const { rows } = await query('SELECT config FROM tenants WHERE id = $1', [req.auth.tenant_id]);
          let cfg = rows[0] && rows[0].config ? (typeof rows[0].config === 'string' ? JSON.parse(rows[0].config) : rows[0].config) : {};
          cfg.brandingFaviconUrl = publicUrl;
          await query('UPDATE tenants SET config = $1::jsonb WHERE id = $2', [JSON.stringify(cfg), req.auth.tenant_id]);
        } catch (_) {}
        return res.json({ success: true, url: publicUrl, faviconUrl: publicUrl });
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ===== ADMIN: Upload logo for any tenant (for wizard sync) =====
  app.post('/api/admin/tenants/:id/logo', authRequired, async (req, res) => {
    if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Super Admin required' });
    try {
      const multer = require('multer');
      const fs = require('fs');
      const path = require('path');
      const uploadDir = path.join(__dirname, '../../uploads/branding');
      if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
      const storage = multer.diskStorage({
        destination: (req, file, cb) => cb(null, uploadDir),
        filename: (req, file, cb) => {
          const ext = path.extname(file.originalname) || '.png';
          cb(null, `${req.params.id}-${Date.now()}${ext}`);
        }
      });
      const upload = multer({
        storage,
        limits: { fileSize: 2 * 1024 * 1024 },
        fileFilter: (req, file, cb) => {
          if (!file.mimetype.startsWith('image/')) return cb(new Error('Only image files allowed'));
          cb(null, true);
        }
      }).single('logo');
      upload(req, res, async (err) => {
        if (err) return res.status(400).json({ error: err.message });
        if (!req.file) return res.status(400).json({ error: 'No file uploaded. Use field name "logo"' });
        const publicUrl = `/uploads/branding/${req.file.filename}`;
        await query('UPDATE tenants SET logo_url = $1, updated_at = NOW() WHERE id = $2', [publicUrl, req.params.id]);
        try {
          const { rows } = await query('SELECT config FROM tenants WHERE id = $1', [req.params.id]);
          let cfg = rows[0] && rows[0].config ? (typeof rows[0].config === 'string' ? JSON.parse(rows[0].config) : rows[0].config) : {};
          cfg.brandingLogoUrl = publicUrl;
          await query('UPDATE tenants SET config = $1::jsonb WHERE id = $2', [JSON.stringify(cfg), req.params.id]);
        } catch (_) {}
        return res.json({ success: true, url: publicUrl, logoUrl: publicUrl });
      });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ===== EASY: 1-click white-label onboarding (tenant self-serve) =====
  // Body: { customDomain?, subdomain?, appName?, primaryColor?, secondaryColor?, logoUrl? }
  // Does everything in one call: validates domain, updates tenant, syncs branding — self-serve white-label setup
  app.post('/api/tenant/white-label/setup', authRequired, async (req, res) => {
    if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Super Admin access required' });
    try {
      const { customDomain, subdomain, appName, primaryColor, secondaryColor, logoUrl, faviconUrl } = req.body || {};
      const tenantId = req.auth.tenant_id;
      if (!tenantId) return res.status(400).json({ error: 'No tenant associated with this account' });

      const { rows: existingRows } = await query('SELECT * FROM tenants WHERE id = $1', [tenantId]);
      const tenant = existingRows[0];
      if (!tenant) return res.status(404).json({ error: 'Tenant not found' });

      let normalizedDomain = null;
      if (customDomain) {
        normalizedDomain = normalizeHostname(String(customDomain).trim());
        if (!isValidHostname(normalizedDomain)) return res.status(400).json({ error: `Invalid domain: ${normalizedDomain}. Use e.g. lab.yourschool.edu` });
        // Check uniqueness
        const { rows: clash } = await query('SELECT id FROM tenants WHERE custom_domain = $1 AND id != $2', [normalizedDomain, tenantId]);
        if (clash.length) return res.status(409).json({ error: `Domain ${normalizedDomain} already taken` });
      }
      let normalizedSub = null;
      if (subdomain) {
        normalizedSub = String(subdomain).toLowerCase().replace(/[^a-z0-9-]/g, '');
        if (normalizedSub.length < 3) return res.status(400).json({ error: 'Subdomain too short (min 3 chars)' });
        const { rows: clash } = await query('SELECT id FROM tenants WHERE subdomain = $1 AND id != $2', [normalizedSub, tenantId]);
        if (clash.length) return res.status(409).json({ error: `Subdomain ${normalizedSub} already taken` });
      }

      // Load existing config and merge branding
      let cfg = {};
      try { cfg = typeof tenant.config === 'string' ? JSON.parse(tenant.config) : (tenant.config || {}); } catch (e) {}
      const newDesignTokens = { colors: {} };
      if (primaryColor) newDesignTokens.colors.primary = primaryColor;
      if (secondaryColor) newDesignTokens.colors.secondary = secondaryColor;
      const mergedTokens = cfg.designTokens ? deepMerge(cfg.designTokens, newDesignTokens) : newDesignTokens;
      if (Object.keys(mergedTokens.colors).length === 0) delete mergedTokens.colors;

      const newCfg = {
        ...cfg,
        designTokens: Object.keys(mergedTokens).length ? deepMerge(cfg.designTokens || {}, newDesignTokens) : cfg.designTokens,
        customDomain: normalizedDomain !== null ? normalizedDomain : cfg.customDomain,
        onboardingCompletedAt: new Date().toISOString(),
      };

      const updates = [];
      const vals = [];
      let i = 1;
      if (normalizedDomain !== null) { updates.push(`custom_domain = $${i++}`); vals.push(normalizedDomain); }
      if (normalizedSub) { updates.push(`subdomain = $${i++}`); vals.push(normalizedSub); }
      if (appName) { updates.push(`app_name = $${i++}`); vals.push(appName); }
      if (logoUrl) { updates.push(`logo_url = $${i++}`); vals.push(logoUrl); }
      if (faviconUrl) { updates.push(`favicon_url = $${i++}`); vals.push(faviconUrl); }
      if (primaryColor) { updates.push(`primary_color = $${i++}`); vals.push(primaryColor); }
      if (secondaryColor) { updates.push(`secondary_color = $${i++}`); vals.push(secondaryColor); }
      // Always update config and plan to enterprise if setting custom domain
      updates.push(`config = $${i++}::jsonb`); vals.push(JSON.stringify(newCfg));
      if (normalizedDomain) { updates.push(`plan = $${i++}`); vals.push('enterprise'); }
      updates.push(`updated_at = NOW()`);
      vals.push(tenantId);
      await query(`UPDATE tenants SET ${updates.join(', ')} WHERE id = $${i}`, vals);

      const target = PLATFORM_HOST;
      const dnsInstruction = normalizedDomain
        ? { type: 'CNAME', name: normalizedDomain, target, instructions: `Add CNAME: ${normalizedDomain} → ${target} at your DNS provider. Then click Verify.` }
        : normalizedSub ? { type: 'CNAME', name: `${normalizedSub}.${target}`, target, instructions: `Your site will be at https://${normalizedSub}.${target}` } : null;

      writeAudit({ tenantId, userId: req.auth.sub, actorName: req.auth.email, actionType: 'WHITE_LABEL_ONBOARDED', details: `Domain: ${normalizedDomain || normalizedSub || 'branding only'}, app: ${appName || tenant.app_name}`, ip: clientIp(req) });
      const { rows: updated } = await query('SELECT * FROM tenants WHERE id = $1', [tenantId]);
      return res.json({ success: true, tenant: updated[0], dnsInstruction, cnameTarget: target, platformHost: target });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ===== PUBLIC: Check subdomain/domain availability (easy onboarding helper) =====
  app.get('/api/tenant/check-availability', async (req, res) => {
    try {
      const { subdomain, domain } = req.query;
      if (subdomain) {
        const sd = String(subdomain).toLowerCase().replace(/[^a-z0-9-]/g, '');
        if (sd.length < 3) return res.json({ available: false, reason: 'Too short' });
        const { rows } = await query('SELECT id FROM tenants WHERE subdomain = $1', [sd]);
        return res.json({ available: rows.length === 0, subdomain: sd });
      }
      if (domain) {
        const d = normalizeHostname(String(domain));
        if (!isValidHostname(d)) return res.json({ available: false, reason: 'Invalid hostname' });
        const { rows } = await query('SELECT id FROM tenants WHERE custom_domain = $1', [d]);
        return res.json({ available: rows.length === 0, domain: d, cnameTarget: PLATFORM_HOST });
      }
      return res.status(400).json({ error: 'Provide ?subdomain= or ?domain=' });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ===== ADMIN: Bulk fix all existing tenants to new white-label setup =====
  app.post('/api/admin/tenants/white-label/bulk-fix', authRequired, async (req, res) => {
    if (!isSuperAdmin(req)) return res.status(403).json({ error: 'Super Admin required' });
    try {
      const { rows: tenants } = await query('SELECT * FROM tenants');
      let fixed = 0;
      const results = [];
      for (const t of tenants) {
        let cfg = {};
        try { cfg = typeof t.config === 'string' ? JSON.parse(t.config) : (t.config || {}); } catch (e) {}
        let changed = false;
        const updates = [];
        const vals = [];
        let i = 1;

        // Fix https:// prefix in customDomain inside config
        if (cfg.customDomain && cfg.customDomain.includes('://')) {
          const cleaned = normalizeHostname(cfg.customDomain);
          if (isValidHostname(cleaned)) {
            cfg.customDomain = cleaned;
            changed = true;
            // sync to column if column empty
            if (!t.custom_domain) { updates.push(`custom_domain = $${i++}`); vals.push(cleaned); }
          } else {
            delete cfg.customDomain;
            changed = true;
          }
        }
        // Sync customDomain from config to column if column null but config has it
        if (cfg.customDomain && !t.custom_domain && isValidHostname(cfg.customDomain)) {
          updates.push(`custom_domain = $${i++}`); vals.push(cfg.customDomain);
        }
        // Sync primary/secondary from designTokens to columns if columns null
        const dtPrimary = cfg.designTokens?.colors?.primary;
        const dtSecondary = cfg.designTokens?.colors?.secondary;
        if (dtPrimary && !t.primary_color) { updates.push(`primary_color = $${i++}`); vals.push(dtPrimary); changed = true; }
        if (dtSecondary && !t.secondary_color) { updates.push(`secondary_color = $${i++}`); vals.push(dtSecondary); changed = true; }
        // Vice versa: if columns have color but tokens missing, seed tokens
        if (t.primary_color && !dtPrimary) {
          cfg.designTokens = cfg.designTokens || {};
          cfg.designTokens.colors = cfg.designTokens.colors || {};
          cfg.designTokens.colors.primary = t.primary_color;
          changed = true;
        }
        if (t.secondary_color && !dtSecondary) {
          cfg.designTokens = cfg.designTokens || {};
          cfg.designTokens.colors = cfg.designTokens.colors || {};
          cfg.designTokens.colors.secondary = t.secondary_color;
          changed = true;
        }
        if (changed || updates.length) {
          updates.push(`config = $${i++}::jsonb`); vals.push(JSON.stringify(cfg));
          updates.push(`updated_at = NOW()`);
          vals.push(t.id);
          // Use dynamic index for WHERE
          const setClause = updates.join(', ');
          const whereIdx = i;
          await query(`UPDATE tenants SET ${setClause} WHERE id = $${whereIdx}`, vals);
          fixed++;
          results.push({ id: t.id, subdomain: t.subdomain, fixed: true, config: cfg });
        } else {
          results.push({ id: t.id, subdomain: t.subdomain, fixed: false });
        }
      }
      writeAudit({ tenantId: 'system', userId: req.auth.sub, actorName: req.auth.email, actionType: 'WHITE_LABEL_BULK_FIX', details: `Fixed ${fixed}/${tenants.length} tenants`, ip: clientIp(req) });
      return res.json({ success: true, fixed, total: tenants.length, results });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  });

  // ===== PUBLIC: Get tenant config by subdomain/domain =====
  app.get('/api/tenant/config', async (req, res) => {
    try {
      let tenant = req.tenant || null;
      if (!tenant) {
        const host = req.headers.host || '';
        const domain = host.split(':')[0].toLowerCase();
        const { rows } = await query('SELECT * FROM tenants WHERE custom_domain = $1 OR subdomain = $1 LIMIT 1', [domain]);
        tenant = rows[0] || null;
      }
      // Host-header matching only works for real custom domains/subdomains -
      // on localhost (or any host with no matching tenant) it always fell
      // through to 'default', showing the wrong branding no matter who was
      // logged in. Resolve via the caller's own JWT next, same fallback
      // chain /editor.html already uses, before giving up to 'default'.
      if (!tenant) {
        const header = req.headers.authorization || '';
        const token = header.startsWith('Bearer ') ? header.slice(7) : null;
        if (token) {
          try {
            const jwt = require('jsonwebtoken');
            const auth = jwt.verify(token, process.env.JWT_SECRET || 'change-me-in-production');
            if (auth?.tenant_id) {
              const { rows } = await query('SELECT * FROM tenants WHERE id = $1', [auth.tenant_id]);
              tenant = rows[0] || null;
            }
            if (!tenant && auth?.sub) {
              const { rows } = await query('SELECT * FROM users WHERE id = $1 LIMIT 1', [auth.sub]);
              const adminUser = rows[0] || null;
              if (adminUser?.tenant_id) {
                const t = await query('SELECT * FROM tenants WHERE id = $1', [adminUser.tenant_id]);
                tenant = t.rows[0] || null;
              }
              if (!tenant && adminUser?.email) {
                const t = await query('SELECT * FROM tenants WHERE owner_email = $1 LIMIT 1', [adminUser.email]);
                tenant = t.rows[0] || null;
              }
            }
          } catch (_) {}
        }
      }
      if (!tenant) {
        const { rows } = await query("SELECT * FROM tenants WHERE id = 'default' OR instance_id = 'default' LIMIT 1");
        tenant = rows[0] || null;
      }
      if (!tenant) {
        return res.json({ appName: 'STEM Platform', primaryColor: '#00979D', secondaryColor: '#4c97ff', tenantId: null });
      }
      let cfg = {};
      try { cfg = typeof tenant.config === 'string' ? JSON.parse(tenant.config) : (tenant.config || {}); } catch (e) {}
      // Default design tokens — tenants can override via config.designTokens
      const defaultDesignTokens = {
        colors: {
          surface: '#f7f9fb',
          'surface-dim': '#d8dadc',
          'surface-bright': '#f7f9fb',
          'surface-container-lowest': '#ffffff',
          'surface-container-low': '#f2f4f6',
          'surface-container': '#eceef0',
          'surface-container-high': '#e6e8ea',
          'surface-container-highest': '#e0e3e5',
          'on-surface': '#191c1e',
          'on-surface-variant': '#45464d',
          'inverse-surface': '#2d3133',
          'inverse-on-surface': '#eff1f3',
          outline: '#76777d',
          'outline-variant': '#c6c6cd',
          'surface-tint': '#565e74',
          primary: tenant.primary_color || '#000000',
          'on-primary': '#ffffff',
          'primary-container': '#131b2e',
          'on-primary-container': '#7c839b',
          'inverse-primary': '#bec6e0',
          secondary: tenant.secondary_color || '#0058be',
          'on-secondary': '#ffffff',
          'secondary-container': '#2170e4',
          'on-secondary-container': '#fefcff',
          tertiary: '#000000',
          'on-tertiary': '#ffffff',
          'tertiary-container': '#0b1c30',
          'on-tertiary-container': '#75859d',
          error: '#ba1a1a',
          'on-error': '#ffffff',
          'error-container': '#ffdad6',
          'on-error-container': '#93000a',
          'primary-fixed': '#dae2fd',
          'primary-fixed-dim': '#bec6e0',
          'on-primary-fixed': '#131b2e',
          'on-primary-fixed-variant': '#3f465c',
          'secondary-fixed': '#d8e2ff',
          'secondary-fixed-dim': '#adc6ff',
          'on-secondary-fixed': '#001a42',
          'on-secondary-fixed-variant': '#004395',
          'tertiary-fixed': '#d3e4fe',
          'tertiary-fixed-dim': '#b7c8e1',
          'on-tertiary-fixed': '#0b1c30',
          'on-tertiary-fixed-variant': '#38485d',
          background: '#f7f9fb',
          'on-background': '#191c1e',
          'surface-variant': '#e0e3e5',
        },
        typography: {
          'headline-lg': { fontFamily: 'Inter', fontSize: '32px', fontWeight: '700', lineHeight: '40px', letterSpacing: '-0.02em' },
          'headline-lg-mobile': { fontFamily: 'Inter', fontSize: '24px', fontWeight: '700', lineHeight: '32px', letterSpacing: '-0.01em' },
          'headline-md': { fontFamily: 'Inter', fontSize: '24px', fontWeight: '600', lineHeight: '32px', letterSpacing: '-0.01em' },
          'headline-sm': { fontFamily: 'Inter', fontSize: '20px', fontWeight: '600', lineHeight: '28px' },
          'body-lg': { fontFamily: 'Inter', fontSize: '18px', fontWeight: '400', lineHeight: '28px' },
          'body-md': { fontFamily: 'Inter', fontSize: '16px', fontWeight: '400', lineHeight: '24px' },
          'body-sm': { fontFamily: 'Inter', fontSize: '14px', fontWeight: '400', lineHeight: '20px' },
          'label-md': { fontFamily: 'Inter', fontSize: '14px', fontWeight: '600', lineHeight: '20px' },
          'label-sm': { fontFamily: 'Inter', fontSize: '12px', fontWeight: '500', lineHeight: '16px', letterSpacing: '0.01em' },
        },
        rounded: { sm: '0.125rem', DEFAULT: '0.25rem', md: '0.375rem', lg: '0.5rem', xl: '0.75rem', full: '9999px' },
        spacing: { unit: '4px', 'container-max': '1440px', gutter: '24px', 'margin-desktop': '40px', 'margin-tablet': '24px', 'margin-mobile': '16px' },
      };
      // Merge tenant config overrides
      const designTokens = cfg.designTokens
        ? deepMerge(defaultDesignTokens, cfg.designTokens)
        : defaultDesignTokens;
      return res.json({
        appName: tenant.app_name || tenant.name || 'STEM Platform',
        companyName: tenant.company_name || '',
        logoUrl: tenant.logo_url || '',
        faviconUrl: tenant.favicon_url || '',
        primaryColor: tenant.primary_color || '#00979D',
        secondaryColor: tenant.secondary_color || '#4c97ff',
        tenantId: tenant.id,
        platformHost: PLATFORM_HOST,
        cnameTarget: PLATFORM_HOST,
        designTokens,
        config: cfg,
      });
    } catch (err) {
      return res.json({ appName: 'STEM Platform', primaryColor: '#00979D', secondaryColor: '#4c97ff', tenantId: null, platformHost: PLATFORM_HOST, cnameTarget: PLATFORM_HOST });
    }
  });
}

module.exports = { setupTenantRoutes };
