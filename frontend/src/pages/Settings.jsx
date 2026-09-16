import { useState, useEffect } from 'react';
import AdminLayout from '../components/AdminLayout';
import api from '../utils/api';
import toast from 'react-hot-toast';

const TABS = ['General', 'Billing API', 'Security', 'Notifications'];

const ROLES = [
  { label: 'Super Admin', count: 3, icon: 'shield' },
  { label: 'Resource Manager', count: 12, icon: 'inventory_2' },
  { label: 'View-Only Auditor', count: 7, icon: 'visibility' },
];

export default function Settings() {
  const [activeTab, setActiveTab] = useState('General');
  const [customDomain, setCustomDomain] = useState('');
  const defaultHost = import.meta.env.VITE_PLATFORM_HOST || (window.location.hostname !== 'localhost' ? window.location.hostname : '');
  const [platformHost, setPlatformHost] = useState(defaultHost);
  const [cnameTarget, setCnameTarget] = useState(defaultHost);
  const [webhookUrl] = useState(`${window.location.origin}/api/webhooks/subscription-events`);
  const [webhookActive] = useState(true);
  const [autoRetry, setAutoRetry] = useState(true);
  const [saving, setSaving] = useState(false);

  // Branding state
  const [logoUrl, setLogoUrl] = useState('');
  const [faviconUrl, setFaviconUrl] = useState('');
  const [logoFile, setLogoFile] = useState(null);
  const [faviconFile, setFaviconFile] = useState(null);
  const [uploadingLogo, setUploadingLogo] = useState(false);
  const [uploadingFavicon, setUploadingFavicon] = useState(false);

  useEffect(() => {
    api.get('/tenant/config').then((r) => {
      const ph = r.data?.platformHost;
      const ct = r.data?.cnameTarget || ph;
      if (ph && ph !== 'localhost') setPlatformHost(ph);
      if (ct && ct !== 'localhost') setCnameTarget(ct);
      if (r.data?.tenantId) {
        const cd = (r.data.config && r.data.config.customDomain) || '';
        if (cd) {
          setCustomDomain(cd);
        }
      }
      if (r.data?.logoUrl) setLogoUrl(r.data.logoUrl);
      if (r.data?.faviconUrl) setFaviconUrl(r.data.faviconUrl);
    }).catch(() => {});
  }, []);

  const handleChangePassword = async (e) => {
    e.preventDefault();
    if (!currentPassword || !newPassword) {
      toast.error('Enter your current and new password.');
      return;
    }
    setChangingPassword(true);
    try {
      await api.post('/auth/change-password', { currentPassword, newPassword });
      toast.success('Password updated.');
      setCurrentPassword('');
      setNewPassword('');
    } catch (err) {
      toast.error(err.response?.data?.error || 'Could not update password.');
    } finally {
      setChangingPassword(false);
    }
  };

  // Billing API state
  const [apiKey] = useState('sk_live_TSE3k8fH2s9mX5nR7vL1pQ');
  const [apiKeyVisible, setApiKeyVisible] = useState(false);
  const [rateLimit, setRateLimit] = useState('1000');
  const [billingWebhook, setBillingWebhook] = useState(`${window.location.origin}/api/webhooks/billing`);
  const [apiUsage] = useState({ used: 8472, limit: 10000 });

  // Security state
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [changingPassword, setChangingPassword] = useState(false);
  const [minPasswordLength, setMinPasswordLength] = useState('12');
  const [requireSpecial, setRequireSpecial] = useState(true);
  const [sessionTimeout, setSessionTimeout] = useState('60');
  const [mfaEnabled, setMfaEnabled] = useState(true);
  const [ssoEnabled, setSsoEnabled] = useState(true);
  const [ipWhitelist, setIpWhitelist] = useState('192.168.1.0/24, 10.0.0.0/8');
  const [auditRetention, setAuditRetention] = useState('90');

  // Notifications state
  const [emailAlerts, setEmailAlerts] = useState(true);
  const [slackWebhook, setSlackWebhook] = useState('https://hooks.slack.com/services/TSE/BZQ/9k8fH2s');
  const [slackConnected, setSlackConnected] = useState(true);
  const [digestFreq, setDigestFreq] = useState('daily');
  const [alertThreshold, setAlertThreshold] = useState('warning');
  const [notifyOn, setNotifyOn] = useState({
    userSignup: true,
    paymentFailure: true,
    tenantProvision: true,
    systemDowntime: true,
    planChange: false,
  });

  const handleSave = async () => {
    setSaving(true);
    try {
      // Logo/favicon are NOT sent here - /tenant/logo and /tenant/favicon
      // already save them immediately on upload, and this endpoint is
      // Super-Admin-only, so re-sending them here would just 403 for
      // anyone else and make an already-successful upload look like it failed.
      await api.patch('/tenant/settings', {
        customDomain,
        config: {
          customDomain,
        }
      });
      toast.success('Settings saved successfully');
    } catch {
      toast.error('Failed to save settings');
    }
    setSaving(false);
  };

  const handleLogoUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLogoFile(file);
    setUploadingLogo(true);
    const form = new FormData();
    form.append('logo', file);
    try {
      const res = await api.post('/tenant/logo', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setLogoUrl(res.data.url || res.data.logoUrl || '');
      toast.success('Logo uploaded');
    } catch {
      toast.error('Failed to upload logo');
    } finally {
      setUploadingLogo(false);
    }
  };

  const handleFaviconUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setFaviconFile(file);
    setUploadingFavicon(true);
    const form = new FormData();
    form.append('favicon', file);
    try {
      const res = await api.post('/tenant/favicon', form, {
        headers: { 'Content-Type': 'multipart/form-data' },
      });
      setFaviconUrl(res.data.url || res.data.faviconUrl || '');
      toast.success('Favicon uploaded');
    } catch {
      toast.error('Failed to upload favicon');
    } finally {
      setUploadingFavicon(false);
    }
  };

  return (
    <AdminLayout>
      <div className="space-y-stack-lg">
        {/* Page Header */}
        <div>
          <h1 className="text-headline-xl text-deep-navy">Platform Settings</h1>
          <p className="text-body-md text-on-surface-variant mt-2">
            Configure your institutional workspace, billing preferences, and security protocols.
          </p>
        </div>

        {/* Settings Tabs */}
        <div className="flex gap-1 bg-surface-container-low rounded-xl p-1 w-fit border border-outline-variant/20">
          {TABS.map((tab) => (
            <button
              key={tab}
              onClick={() => setActiveTab(tab)}
              className={`px-5 py-2.5 rounded-lg text-label-md font-bold transition-all ${
                activeTab === tab
                  ? 'bg-pure-white shadow text-deep-navy'
                  : 'text-on-surface-variant hover:text-deep-navy'
              }`}
            >
              {tab}
            </button>
          ))}
        </div>

        {activeTab === 'General' && (
          <div className="grid grid-cols-12 gap-gutter">
            <div className="col-span-12 lg:col-span-8 space-y-stack-md">
              {/* Domain Configuration */}
              <div className="bg-pure-white rounded-xl border border-outline-variant/20 shadow p-6">
                <div className="flex items-center gap-2 mb-6">
                  <span className="material-symbols-outlined text-stem-orange text-[22px]">dns</span>
                  <h2 className="text-label-md text-deep-navy uppercase tracking-wider">Domain Configuration</h2>
                </div>
                <div>
                  <label className="text-body-sm text-on-surface-variant font-medium block mb-2">Custom Domain (CNAME)</label>
                  <input type="text" value={customDomain} onChange={(e) => setCustomDomain(e.target.value)} placeholder="login.yourinstitution.edu" className="w-full px-3 py-2.5 border border-outline-variant/50 rounded-lg text-body-md text-deep-navy focus:outline-none focus:ring-2 focus:ring-stem-orange/40 focus:border-stem-orange transition-all" />
                  <p className="text-body-sm text-on-surface-variant/70 mt-1.5 flex items-center gap-1">
                    <span className="material-symbols-outlined text-[14px]">language</span> Point a CNAME record to <span className="font-mono text-deep-navy">{cnameTarget || 'your-platform-host.com'}</span>
                  </p>
                </div>
              </div>

              {/* Branding */}
              <div className="bg-pure-white rounded-xl border border-outline-variant/20 shadow p-6">
                <div className="flex items-center gap-2 mb-6">
                  <span className="material-symbols-outlined text-stem-orange text-[22px]">palette</span>
                  <h2 className="text-label-md text-deep-navy uppercase tracking-wider">Branding</h2>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
                  <div>
                    <label className="text-body-sm text-on-surface-variant font-medium block mb-2">Logo</label>
                    <div className="flex items-center gap-4">
                      {logoUrl && (
                        <img src={logoUrl} alt="Logo" className="w-12 h-12 object-contain border border-outline-variant/30 rounded-lg bg-surface-container-low p-1" />
                      )}
                      <div className="flex-1">
                        <input type="file" accept="image/*" onChange={handleLogoUpload} className="block w-full text-body-sm text-on-surface-variant file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-body-sm file:font-semibold file:bg-stem-orange/10 file:text-stem-orange hover:file:bg-stem-orange hover:file:text-pure-white transition-all" />
                        <p className="text-label-sm text-on-surface-variant/70 mt-1">PNG, JPG up to 2MB</p>
                      </div>
                    </div>
                    {uploadingLogo && <p className="text-label-sm text-stem-orange mt-2">Uploading logo...</p>}
                  </div>
                  <div>
                    <label className="text-body-sm text-on-surface-variant font-medium block mb-2">Favicon</label>
                    <div className="flex items-center gap-4">
                      {faviconUrl && (
                        <img src={faviconUrl} alt="Favicon" className="w-10 h-10 object-contain border border-outline-variant/30 rounded bg-surface-container-low p-1" />
                      )}
                      <div className="flex-1">
                        <input type="file" accept="image/*" onChange={handleFaviconUpload} className="block w-full text-body-sm text-on-surface-variant file:mr-4 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-body-sm file:font-semibold file:bg-indigo-accent/10 file:text-indigo-accent hover:file:bg-indigo-accent hover:file:text-pure-white transition-all" />
                        <p className="text-label-sm text-on-surface-variant/70 mt-1">PNG, ICO, SVG up to 1MB</p>
                      </div>
                    </div>
                    {uploadingFavicon && <p className="text-label-sm text-indigo-accent mt-2">Uploading favicon...</p>}
                  </div>
                </div>
              </div>

              {/* Webhook Settings */}
              <div className="bg-pure-white rounded-xl border border-outline-variant/20 shadow p-6">
                <div className="flex items-center gap-2 mb-6">
                  <span className="material-symbols-outlined text-stem-orange text-[22px]">webhook</span>
                  <h2 className="text-label-md text-deep-navy uppercase tracking-wider">Webhook Settings</h2>
                </div>
                <div className="p-4 rounded-xl bg-surface-container-low border border-outline-variant/20 mb-5">
                  <div className="flex items-center justify-between mb-3">
                    <div className="flex items-center gap-2">
                      <span className="material-symbols-outlined text-on-surface-variant text-[18px]">sync_alt</span>
                      <span className="text-body-sm text-deep-navy font-medium">Subscription Event Listener</span>
                    </div>
                    {webhookActive && (
                      <span className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-green-50 text-green-700 text-label-sm font-bold">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500" /> Active
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="flex-1 px-3 py-2 bg-pure-white border border-outline-variant/30 rounded-lg text-body-sm font-mono text-deep-navy truncate">{webhookUrl}</code>
                    <button className="p-2 rounded-lg text-on-surface-variant hover:text-error hover:bg-error/5 transition-all" title="Delete webhook">
                      <span className="material-symbols-outlined text-[20px]">delete</span>
                    </button>
                  </div>
                </div>
                <label className="flex items-center gap-3 cursor-pointer mb-5">
                  <div onClick={() => setAutoRetry(!autoRetry)} className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${autoRetry ? 'bg-indigo-accent' : 'bg-outline-variant'}`}>
                    <div className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-pure-white transition-transform ${autoRetry ? 'translate-x-5' : 'translate-x-0'}`} />
                  </div>
                  <div>
                    <span className="text-body-sm text-deep-navy font-medium">Automatically retry</span>
                    <p className="text-body-sm text-on-surface-variant">Retry failed webhook deliveries up to 3 times</p>
                  </div>
                </label>
                <button className="flex items-center gap-2 px-4 py-2.5 border border-dashed border-outline-variant/50 rounded-xl text-label-md text-indigo-accent hover:bg-indigo-accent/5 hover:border-indigo-accent transition-all">
                  <span className="material-symbols-outlined text-[18px]">add</span> Add Endpoint
                </button>
              </div>

              {/* Global Email Templates */}
              <div className="bg-pure-white rounded-xl border border-outline-variant/20 shadow p-6">
                <div className="flex items-center gap-2 mb-6">
                  <span className="material-symbols-outlined text-stem-orange text-[22px]">mail</span>
                  <h2 className="text-label-md text-deep-navy uppercase tracking-wider">Global Email Templates</h2>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  {[
                    { icon: 'school', label: 'Student Welcome', desc: 'Onboarding email for new student accounts', color: 'indigo-accent' },
                    { icon: 'badge', label: 'Faculty Verification', desc: 'Verification email for faculty registration', color: 'stem-orange' },
                    { icon: 'renew', label: 'Subscription Renewal', desc: 'Reminder for upcoming plan renewals', color: 'deep-navy' },
                    { icon: 'warning', label: 'Security Alert', desc: 'Notify admins of suspicious activity', color: 'error' },
                  ].map((t) => (
                    <div key={t.label} className={`p-4 rounded-xl border border-outline-variant/20 hover:border-${t.color}/40 hover:bg-${t.color}/5 transition-all group cursor-pointer`}>
                      <div className="flex items-start justify-between mb-3">
                        <div className={`w-10 h-10 rounded-lg bg-${t.color}/10 flex items-center justify-center text-${t.color} group-hover:bg-${t.color} group-hover:text-pure-white transition-all`}>
                          <span className="material-symbols-outlined text-[22px]">{t.icon}</span>
                        </div>
                        <span className="material-symbols-outlined text-on-surface-variant opacity-0 group-hover:opacity-100 transition-all text-[18px]">edit</span>
                      </div>
                      <p className="text-body-sm text-deep-navy font-bold mb-0.5">{t.label}</p>
                      <p className="text-body-sm text-on-surface-variant">{t.desc}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            <div className="col-span-12 lg:col-span-4 space-y-stack-md">
              {/* Admin Role Management */}
              <div className="bg-pure-white rounded-xl border border-outline-variant/20 shadow p-6">
                <div className="flex items-center gap-2 mb-6">
                  <span className="material-symbols-outlined text-stem-orange text-[22px]">admin_panel_settings</span>
                  <h2 className="text-label-md text-deep-navy uppercase tracking-wider">Admin Role Management</h2>
                </div>
                <div className="space-y-3 mb-6">
                  {ROLES.map((role) => (
                    <div key={role.label} className="flex items-center gap-3 p-3 rounded-xl bg-surface-container-low hover:bg-indigo-accent/5 transition-all cursor-pointer">
                      <div className="w-9 h-9 rounded-lg bg-deep-navy/10 flex items-center justify-center text-deep-navy">
                        <span className="material-symbols-outlined text-[20px]">{role.icon}</span>
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-body-sm text-deep-navy font-bold truncate">{role.label}</p>
                        <p className="text-label-sm text-on-surface-variant">{role.count} user{role.count !== 1 ? 's' : ''}</p>
                      </div>
                      <span className="material-symbols-outlined text-on-surface-variant text-[18px]">chevron_right</span>
                    </div>
                  ))}
                </div>
                <button className="w-full flex items-center justify-center gap-2 px-4 py-2.5 border border-outline-variant/50 rounded-xl text-label-md text-deep-navy hover:bg-surface-container-low transition-all">
                  <span className="material-symbols-outlined text-[18px]">settings_accessibility</span> Manage Permissions
                </button>
              </div>

              {/* Security Score */}
              <div className="bg-pure-white rounded-xl border border-outline-variant/20 shadow overflow-hidden">
                <div className="bg-deep-navy p-5">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="material-symbols-outlined text-stem-orange text-[22px]">security</span>
                    <h2 className="text-label-md text-pure-white uppercase tracking-wider">Security Score</h2>
                  </div>
                  <p className="text-headline-md text-pure-white font-bold mt-3">Security Strength: Excellent</p>
                </div>
                <div className="p-5">
                  <div className="flex items-center justify-between mb-2">
                    <span className="text-body-sm text-deep-navy font-medium">Compliance Score</span>
                    <span className="text-body-sm text-stem-orange font-bold">94%</span>
                  </div>
                  <div className="h-2.5 w-full bg-surface-container-low rounded-full overflow-hidden">
                    <div className="h-full bg-gradient-to-r from-stem-orange to-amber-400 rounded-full transition-all duration-700" style={{ width: '94%' }} />
                  </div>
                  <div className="flex items-center gap-4 mt-4 pt-4 border-t border-outline-variant/20">
                    <div className="flex items-center gap-1.5 text-label-sm text-green-700">
                      <span className="material-symbols-outlined text-[16px]">check_circle</span> SSO Enabled
                    </div>
                    <div className="flex items-center gap-1.5 text-label-sm text-green-700">
                      <span className="material-symbols-outlined text-[16px]">check_circle</span> MFA Active
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'Billing API' && (
          <div className="grid grid-cols-12 gap-gutter">
            <div className="col-span-12 lg:col-span-8 space-y-stack-md">
              {/* API Key */}
              <div className="bg-pure-white rounded-xl border border-outline-variant/20 shadow p-6">
                <div className="flex items-center gap-2 mb-6">
                  <span className="material-symbols-outlined text-stem-orange text-[22px]">vpn_key</span>
                  <h2 className="text-label-md text-deep-navy uppercase tracking-wider">API Credentials</h2>
                </div>
                <div className="mb-5">
                  <label className="text-body-sm text-on-surface-variant font-medium block mb-2">Live Secret Key</label>
                  <div className="flex items-center gap-2">
                    <div className="flex-1 relative">
                      <code className="block w-full px-3 py-2.5 bg-surface-container-low border border-outline-variant/50 rounded-lg text-body-sm font-mono text-deep-navy truncate pr-10">
                        {apiKeyVisible ? apiKey : 'sk_live_••••••••••••••••'}
                      </code>
                      <button onClick={() => setApiKeyVisible(!apiKeyVisible)} className="absolute right-2 top-1/2 -translate-y-1/2 text-on-surface-variant hover:text-deep-navy">
                        <span className="material-symbols-outlined text-[18px]">{apiKeyVisible ? 'visibility_off' : 'visibility'}</span>
                      </button>
                    </div>
                    <button className="px-3 py-2.5 border border-outline-variant/50 rounded-lg text-label-sm text-on-surface-variant hover:bg-surface-container-low transition-all flex items-center gap-1">
                      <span className="material-symbols-outlined text-[16px]">content_copy</span> Copy
                    </button>
                    <button className="px-3 py-2.5 bg-stem-orange/10 text-stem-orange rounded-lg text-label-sm font-bold hover:bg-stem-orange hover:text-pure-white transition-all flex items-center gap-1">
                      <span className="material-symbols-outlined text-[16px]">refresh</span> Rotate
                    </button>
                  </div>
                  <p className="text-body-sm text-on-surface-variant/70 mt-1.5 flex items-center gap-1">
                    <span className="material-symbols-outlined text-[14px]">info</span> Include this key in the <code className="font-mono bg-surface-container-low px-1 rounded">Authorization: Bearer</code> header
                  </p>
                </div>
              </div>

              {/* Rate Limiting */}
              <div className="bg-pure-white rounded-xl border border-outline-variant/20 shadow p-6">
                <div className="flex items-center gap-2 mb-6">
                  <span className="material-symbols-outlined text-stem-orange text-[22px]">speed</span>
                  <h2 className="text-label-md text-deep-navy uppercase tracking-wider">Rate Limiting</h2>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                  <div>
                    <label className="text-body-sm text-on-surface-variant font-medium block mb-2">Requests per Minute</label>
                    <input type="number" value={rateLimit} onChange={(e) => setRateLimit(e.target.value)} className="w-full px-3 py-2.5 border border-outline-variant/50 rounded-lg text-body-md text-deep-navy focus:outline-none focus:ring-2 focus:ring-stem-orange/40 focus:border-stem-orange transition-all" />
                  </div>
                  <div>
                    <label className="text-body-sm text-on-surface-variant font-medium block mb-2">Current Usage</label>
                    <div className="px-3 py-2.5 border border-outline-variant/50 rounded-lg">
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-body-sm text-deep-navy font-bold">{apiUsage.used.toLocaleString()} / {apiUsage.limit.toLocaleString()}</span>
                        <span className="text-label-sm text-stem-orange font-bold">{Math.round(apiUsage.used / apiUsage.limit * 100)}%</span>
                      </div>
                      <div className="h-1.5 w-full bg-surface-container-low rounded-full overflow-hidden">
                        <div className="h-full bg-stem-orange rounded-full" style={{ width: `${apiUsage.used / apiUsage.limit * 100}%` }} />
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Billing Webhook */}
              <div className="bg-pure-white rounded-xl border border-outline-variant/20 shadow p-6">
                <div className="flex items-center gap-2 mb-6">
                  <span className="material-symbols-outlined text-stem-orange text-[22px]">webhook</span>
                  <h2 className="text-label-md text-deep-navy uppercase tracking-wider">Billing Webhook URL</h2>
                </div>
                <div>
                  <label className="text-body-sm text-on-surface-variant font-medium block mb-2">Event Endpoint</label>
                  <div className="flex items-center gap-2">
                    <input type="text" value={billingWebhook} onChange={(e) => setBillingWebhook(e.target.value)} className="flex-1 px-3 py-2.5 border border-outline-variant/50 rounded-lg text-body-sm font-mono text-deep-navy focus:outline-none focus:ring-2 focus:ring-stem-orange/40 focus:border-stem-orange transition-all" />
                    <span className="flex items-center gap-1 px-2.5 py-2 rounded-lg bg-green-50 text-green-700 text-label-sm font-bold whitespace-nowrap">
                      <span className="w-1.5 h-1.5 rounded-full bg-green-500" /> Active
                    </span>
                  </div>
                  <p className="text-body-sm text-on-surface-variant/70 mt-1.5">
                    Receives invoice.paid, subscription.renewed, and plan.changed events
                  </p>
                </div>
              </div>
            </div>

            <div className="col-span-12 lg:col-span-4 space-y-stack-md">
              {/* API Usage Overview */}
              <div className="bg-pure-white rounded-xl border border-outline-variant/20 shadow p-6">
                <div className="flex items-center gap-2 mb-6">
                  <span className="material-symbols-outlined text-stem-orange text-[22px]">bar_chart</span>
                  <h2 className="text-label-md text-deep-navy uppercase tracking-wider">API Overview</h2>
                </div>
                <div className="space-y-4">
                  {[
                    { label: 'Total Endpoints', value: '24', icon: 'api' },
                    { label: 'Avg Latency', value: '42ms', icon: 'timer' },
                    { label: 'Error Rate', value: '0.12%', icon: 'error_outline' },
                    { label: 'Active Keys', value: '3', icon: 'key' },
                  ].map((s) => (
                    <div key={s.label} className="flex items-center gap-3 p-3 rounded-xl bg-surface-container-low">
                      <div className="w-9 h-9 rounded-lg bg-deep-navy/10 flex items-center justify-center text-deep-navy">
                        <span className="material-symbols-outlined text-[20px]">{s.icon}</span>
                      </div>
                      <div>
                        <p className="text-label-sm text-on-surface-variant">{s.label}</p>
                        <p className="text-body-sm text-deep-navy font-bold">{s.value}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* API Documentation */}
              <div className="bg-deep-navy text-pure-white rounded-xl p-6 relative overflow-hidden">
                <div className="absolute -right-6 -bottom-6 opacity-10">
                  <span className="material-symbols-outlined text-[100px]">description</span>
                </div>
                <div className="relative z-10">
                  <h3 className="text-label-md uppercase tracking-wider mb-2">API Documentation</h3>
                  <p className="text-body-sm text-pure-white/70 mb-4">Access the full REST API reference for billing, subscription, and tenant management.</p>
                  <button className="flex items-center gap-2 px-4 py-2 bg-stem-orange text-pure-white rounded-lg text-label-sm font-bold hover:brightness-110 transition-all">
                    <span className="material-symbols-outlined text-[16px]">open_in_new</span> Open API Docs
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'Security' && (
          <div className="grid grid-cols-12 gap-gutter">
            <div className="col-span-12 lg:col-span-8 space-y-stack-md">
              {/* Change Your Password */}
              <div className="bg-pure-white rounded-xl border border-outline-variant/20 shadow p-6">
                <div className="flex items-center gap-2 mb-6">
                  <span className="material-symbols-outlined text-stem-orange text-[22px]">password</span>
                  <h2 className="text-label-md text-deep-navy uppercase tracking-wider">Change Your Password</h2>
                </div>
                <form onSubmit={handleChangePassword} className="grid grid-cols-1 sm:grid-cols-3 gap-5 items-end">
                  <div>
                    <label className="text-body-sm text-on-surface-variant font-medium block mb-2">Current Password</label>
                    <input type="password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} autoComplete="current-password" className="w-full px-3 py-2.5 border border-outline-variant/50 rounded-lg text-body-md text-deep-navy focus:outline-none focus:ring-2 focus:ring-stem-orange/40 focus:border-stem-orange transition-all" />
                  </div>
                  <div>
                    <label className="text-body-sm text-on-surface-variant font-medium block mb-2">New Password</label>
                    <input type="password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} autoComplete="new-password" minLength={8} className="w-full px-3 py-2.5 border border-outline-variant/50 rounded-lg text-body-md text-deep-navy focus:outline-none focus:ring-2 focus:ring-stem-orange/40 focus:border-stem-orange transition-all" />
                  </div>
                  <div>
                    <button type="submit" disabled={changingPassword} className="w-full px-4 py-2.5 rounded-lg bg-stem-orange text-pure-white text-body-md font-semibold hover:opacity-90 transition-opacity disabled:opacity-50">
                      {changingPassword ? 'Updating...' : 'Update Password'}
                    </button>
                  </div>
                </form>
                <p className="text-body-sm text-on-surface-variant/70 mt-2">Minimum 8 characters. Takes effect immediately - you'll stay signed in.</p>
              </div>

              {/* Password Policy */}
              <div className="bg-pure-white rounded-xl border border-outline-variant/20 shadow p-6">
                <div className="flex items-center gap-2 mb-6">
                  <span className="material-symbols-outlined text-stem-orange text-[22px]">lock</span>
                  <h2 className="text-label-md text-deep-navy uppercase tracking-wider">Password Policy</h2>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                  <div>
                    <label className="text-body-sm text-on-surface-variant font-medium block mb-2">Minimum Length</label>
                    <input type="number" value={minPasswordLength} onChange={(e) => setMinPasswordLength(e.target.value)} min="8" max="128" className="w-full px-3 py-2.5 border border-outline-variant/50 rounded-lg text-body-md text-deep-navy focus:outline-none focus:ring-2 focus:ring-stem-orange/40 focus:border-stem-orange transition-all" />
                  </div>
                  <div>
                    <label className="text-body-sm text-on-surface-variant font-medium block mb-2">Session Timeout (minutes)</label>
                    <input type="number" value={sessionTimeout} onChange={(e) => setSessionTimeout(e.target.value)} min="5" max="1440" className="w-full px-3 py-2.5 border border-outline-variant/50 rounded-lg text-body-md text-deep-navy focus:outline-none focus:ring-2 focus:ring-stem-orange/40 focus:border-stem-orange transition-all" />
                  </div>
                </div>
                <div className="mt-5 space-y-3">
                  <label className="flex items-center gap-3 cursor-pointer">
                    <div onClick={() => setRequireSpecial(!requireSpecial)} className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 ${requireSpecial ? 'bg-indigo-accent' : 'bg-outline-variant'}`}>
                      <div className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-pure-white transition-transform ${requireSpecial ? 'translate-x-5' : 'translate-x-0'}`} />
                    </div>
                    <span className="text-body-sm text-deep-navy font-medium">Require special characters and numbers</span>
                  </label>
                </div>
              </div>

              {/* Authentication */}
              <div className="bg-pure-white rounded-xl border border-outline-variant/20 shadow p-6">
                <div className="flex items-center gap-2 mb-6">
                  <span className="material-symbols-outlined text-stem-orange text-[22px]">security</span>
                  <h2 className="text-label-md text-deep-navy uppercase tracking-wider">Authentication</h2>
                </div>
                <div className="space-y-4">
                  <div className="flex items-center justify-between p-4 rounded-xl bg-surface-container-low">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-indigo-accent/10 flex items-center justify-center text-indigo-accent">
                        <span className="material-symbols-outlined text-[22px]">fingerprint</span>
                      </div>
                      <div>
                        <p className="text-body-sm text-deep-navy font-bold">Multi-Factor Authentication (MFA)</p>
                        <p className="text-label-sm text-on-surface-variant">Require OTP verification for admin logins</p>
                      </div>
                    </div>
                    <div onClick={() => setMfaEnabled(!mfaEnabled)} className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 cursor-pointer ${mfaEnabled ? 'bg-indigo-accent' : 'bg-outline-variant'}`}>
                      <div className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-pure-white transition-transform ${mfaEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
                    </div>
                  </div>
                  <div className="flex items-center justify-between p-4 rounded-xl bg-surface-container-low">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-stem-orange/10 flex items-center justify-center text-stem-orange">
                        <span className="material-symbols-outlined text-[22px]">badge</span>
                      </div>
                      <div>
                        <p className="text-body-sm text-deep-navy font-bold">Single Sign-On (SSO)</p>
                        <p className="text-label-sm text-on-surface-variant">SAML 2.0 / OIDC provider integration</p>
                      </div>
                    </div>
                    <div onClick={() => setSsoEnabled(!ssoEnabled)} className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 cursor-pointer ${ssoEnabled ? 'bg-indigo-accent' : 'bg-outline-variant'}`}>
                      <div className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-pure-white transition-transform ${ssoEnabled ? 'translate-x-5' : 'translate-x-0'}`} />
                    </div>
                  </div>
                </div>
              </div>

              {/* IP Whitelist */}
              <div className="bg-pure-white rounded-xl border border-outline-variant/20 shadow p-6">
                <div className="flex items-center gap-2 mb-6">
                  <span className="material-symbols-outlined text-stem-orange text-[22px]">lan</span>
                  <h2 className="text-label-md text-deep-navy uppercase tracking-wider">IP Whitelist</h2>
                </div>
                <div>
                  <label className="text-body-sm text-on-surface-variant font-medium block mb-2">Allowed IP Ranges</label>
                  <textarea value={ipWhitelist} onChange={(e) => setIpWhitelist(e.target.value)} rows={2} className="w-full px-3 py-2.5 border border-outline-variant/50 rounded-lg text-body-sm font-mono text-deep-navy focus:outline-none focus:ring-2 focus:ring-stem-orange/40 focus:border-stem-orange transition-all" />
                  <p className="text-body-sm text-on-surface-variant/70 mt-1.5">Comma-separated CIDR ranges. Leave empty to allow all IPs.</p>
                </div>
              </div>

              {/* Audit Log Retention */}
              <div className="bg-pure-white rounded-xl border border-outline-variant/20 shadow p-6">
                <div className="flex items-center gap-2 mb-6">
                  <span className="material-symbols-outlined text-stem-orange text-[22px]">history</span>
                  <h2 className="text-label-md text-deep-navy uppercase tracking-wider">Audit Log Retention</h2>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                  <div>
                    <label className="text-body-sm text-on-surface-variant font-medium block mb-2">Retention Period (days)</label>
                    <select value={auditRetention} onChange={(e) => setAuditRetention(e.target.value)} className="w-full px-3 py-2.5 border border-outline-variant/50 rounded-lg text-body-md text-deep-navy focus:outline-none focus:ring-2 focus:ring-stem-orange/40 focus:border-stem-orange transition-all">
                      <option value="30">30 days</option>
                      <option value="60">60 days</option>
                      <option value="90">90 days</option>
                      <option value="180">180 days</option>
                      <option value="365">1 year</option>
                    </select>
                  </div>
                  <div className="flex items-end">
                    <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 w-full">
                      <p className="text-label-sm text-amber-700 flex items-center gap-1">
                        <span className="material-symbols-outlined text-[16px]">storage</span> 2.4 GB stored
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            <div className="col-span-12 lg:col-span-4 space-y-stack-md">
              {/* Security Checklist */}
              <div className="bg-pure-white rounded-xl border border-outline-variant/20 shadow p-6">
                <div className="flex items-center gap-2 mb-6">
                  <span className="material-symbols-outlined text-stem-orange text-[22px]">checklist</span>
                  <h2 className="text-label-md text-deep-navy uppercase tracking-wider">Security Checklist</h2>
                </div>
                <div className="space-y-3">
                  {[
                    { label: 'MFA enabled for all admins', done: true },
                    { label: 'SSL certificate valid', done: true },
                    { label: 'Password policy enforced', done: true },
                    { label: 'IP whitelist configured', done: false },
                    { label: 'Audit logging active', done: true },
                    { label: 'API key rotation scheduled', done: false },
                  ].map((item) => (
                    <div key={item.label} className="flex items-center gap-2">
                      <span className={`material-symbols-outlined text-[18px] ${item.done ? 'text-green-600' : 'text-outline-variant'}`}>
                        {item.done ? 'check_circle' : 'radio_button_unchecked'}
                      </span>
                      <span className={`text-body-sm ${item.done ? 'text-deep-navy' : 'text-on-surface-variant'}`}>{item.label}</span>
                    </div>
                  ))}
                </div>
              </div>

              {/* Last Security Scan */}
              <div className="bg-pure-white rounded-xl border border-outline-variant/20 shadow p-6">
                <div className="flex items-center gap-2 mb-4">
                  <span className="material-symbols-outlined text-stem-orange text-[22px]">scan</span>
                  <h2 className="text-label-md text-deep-navy uppercase tracking-wider">Last Scan</h2>
                </div>
                <div className="flex items-center gap-3 p-3 rounded-xl bg-green-50 border border-green-200">
                  <span className="material-symbols-outlined text-green-600 text-[28px]">verified</span>
                  <div>
                    <p className="text-body-sm text-green-800 font-bold">All clear</p>
                    <p className="text-label-sm text-green-600">Completed 2 hours ago</p>
                  </div>
                </div>
                <button className="w-full mt-4 py-2.5 border border-outline-variant/50 rounded-xl text-label-md text-deep-navy hover:bg-surface-container-low transition-all">
                  Run Security Scan
                </button>
              </div>
            </div>
          </div>
        )}

        {activeTab === 'Notifications' && (
          <div className="grid grid-cols-12 gap-gutter">
            <div className="col-span-12 lg:col-span-8 space-y-stack-md">
              {/* Email Notifications */}
              <div className="bg-pure-white rounded-xl border border-outline-variant/20 shadow p-6">
                <div className="flex items-center gap-2 mb-6">
                  <span className="material-symbols-outlined text-stem-orange text-[22px]">notifications</span>
                  <h2 className="text-label-md text-deep-navy uppercase tracking-wider">Email Notifications</h2>
                </div>
                <div className="flex items-center justify-between mb-6">
                  <div>
                    <p className="text-body-sm text-deep-navy font-bold">Enable email alerts</p>
                    <p className="text-body-sm text-on-surface-variant">Receive system notifications via email</p>
                  </div>
                  <div onClick={() => setEmailAlerts(!emailAlerts)} className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 cursor-pointer ${emailAlerts ? 'bg-indigo-accent' : 'bg-outline-variant'}`}>
                    <div className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-pure-white transition-transform ${emailAlerts ? 'translate-x-5' : 'translate-x-0'}`} />
                  </div>
                </div>
                <div className="space-y-3">
                  {Object.entries(notifyOn).map(([key, val]) => (
                    <div key={key} className="flex items-center justify-between p-3 rounded-xl bg-surface-container-low">
                      <span className="text-body-sm text-deep-navy font-medium">
                        {key === 'userSignup' && 'New user signup'}
                        {key === 'paymentFailure' && 'Payment failure'}
                        {key === 'tenantProvision' && 'Tenant provisioned'}
                        {key === 'systemDowntime' && 'System downtime detected'}
                        {key === 'planChange' && 'Plan change requested'}
                      </span>
                      <div onClick={() => setNotifyOn({...notifyOn, [key]: !val})} className={`relative w-10 h-5 rounded-full transition-colors flex-shrink-0 cursor-pointer ${val ? 'bg-indigo-accent' : 'bg-outline-variant'}`}>
                        <div className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-pure-white transition-transform ${val ? 'translate-x-5' : 'translate-x-0'}`} />
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Slack Integration */}
              <div className="bg-pure-white rounded-xl border border-outline-variant/20 shadow p-6">
                <div className="flex items-center gap-2 mb-6">
                  <span className="material-symbols-outlined text-stem-orange text-[22px]">chat</span>
                  <h2 className="text-label-md text-deep-navy uppercase tracking-wider">Slack Integration</h2>
                </div>
                <div className="mb-5">
                  <div className="flex items-center justify-between p-4 rounded-xl bg-surface-container-low mb-4">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 rounded-lg bg-stem-orange/10 flex items-center justify-center text-stem-orange">
                        <span className="material-symbols-outlined text-[22px]">chat</span>
                      </div>
                      <div>
                        <p className="text-body-sm text-deep-navy font-bold">#system-alerts</p>
                        <p className="text-label-sm text-on-surface-variant">STEMOS Workspace</p>
                      </div>
                    </div>
                    {slackConnected && (
                      <span className="flex items-center gap-1 px-2.5 py-1 rounded-full bg-green-50 text-green-700 text-label-sm font-bold">
                        <span className="w-1.5 h-1.5 rounded-full bg-green-500" /> Connected
                      </span>
                    )}
                  </div>
                  <label className="text-body-sm text-on-surface-variant font-medium block mb-2">Webhook URL</label>
                  <div className="flex items-center gap-2">
                    <input type="text" value={slackWebhook} onChange={(e) => setSlackWebhook(e.target.value)} className="flex-1 px-3 py-2.5 border border-outline-variant/50 rounded-lg text-body-sm font-mono text-deep-navy focus:outline-none focus:ring-2 focus:ring-stem-orange/40 focus:border-stem-orange transition-all" />
                    <button onClick={() => setSlackConnected(!slackConnected)} className={`px-4 py-2.5 rounded-lg text-label-sm font-bold transition-all ${slackConnected ? 'bg-error/10 text-error hover:bg-error hover:text-pure-white' : 'bg-indigo-accent/10 text-indigo-accent hover:bg-indigo-accent hover:text-pure-white'}`}>
                      {slackConnected ? 'Disconnect' : 'Connect'}
                    </button>
                  </div>
                </div>
              </div>

              {/* Alert Threshold */}
              <div className="bg-pure-white rounded-xl border border-outline-variant/20 shadow p-6">
                <div className="flex items-center gap-2 mb-6">
                  <span className="material-symbols-outlined text-stem-orange text-[22px]">tune</span>
                  <h2 className="text-label-md text-deep-navy uppercase tracking-wider">Alert Preferences</h2>
                </div>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
                  <div>
                    <label className="text-body-sm text-on-surface-variant font-medium block mb-2">Minimum Alert Severity</label>
                    <select value={alertThreshold} onChange={(e) => setAlertThreshold(e.target.value)} className="w-full px-3 py-2.5 border border-outline-variant/50 rounded-lg text-body-md text-deep-navy focus:outline-none focus:ring-2 focus:ring-stem-orange/40 focus:border-stem-orange transition-all">
                      <option value="critical">Critical only</option>
                      <option value="warning">Warning and above</option>
                      <option value="info">All notifications</option>
                    </select>
                  </div>
                  <div>
                    <label className="text-body-sm text-on-surface-variant font-medium block mb-2">Digest Frequency</label>
                    <select value={digestFreq} onChange={(e) => setDigestFreq(e.target.value)} className="w-full px-3 py-2.5 border border-outline-variant/50 rounded-lg text-body-md text-deep-navy focus:outline-none focus:ring-2 focus:ring-stem-orange/40 focus:border-stem-orange transition-all">
                      <option value="realtime">Real-time</option>
                      <option value="daily">Daily digest</option>
                      <option value="weekly">Weekly digest</option>
                    </select>
                  </div>
                </div>
              </div>
            </div>

            <div className="col-span-12 lg:col-span-4 space-y-stack-md">
              {/* Notification Channels */}
              <div className="bg-pure-white rounded-xl border border-outline-variant/20 shadow p-6">
                <div className="flex items-center gap-2 mb-6">
                  <span className="material-symbols-outlined text-stem-orange text-[22px]">hub</span>
                  <h2 className="text-label-md text-deep-navy uppercase tracking-wider">Channels</h2>
                </div>
                <div className="space-y-3">
                  {[
                    { label: 'Email', icon: 'mail', connected: true },
                    { label: 'Slack', icon: 'chat', connected: true },
                    { label: 'SMS', icon: 'sms', connected: false },
                    { label: 'Webhook', icon: 'webhook', connected: true },
                    { label: 'PagerDuty', icon: 'emergency', connected: false },
                  ].map((ch) => (
                    <div key={ch.label} className="flex items-center justify-between p-3 rounded-xl bg-surface-container-low">
                      <div className="flex items-center gap-2">
                        <span className="material-symbols-outlined text-on-surface-variant text-[18px]">{ch.icon}</span>
                        <span className="text-body-sm text-deep-navy">{ch.label}</span>
                      </div>
                      <span className={`w-2 h-2 rounded-full ${ch.connected ? 'bg-green-500' : 'bg-outline-variant'}`} />
                    </div>
                  ))}
                </div>
              </div>

              {/* Recent Alerts */}
              <div className="bg-pure-white rounded-xl border border-outline-variant/20 shadow p-6">
                <div className="flex items-center gap-2 mb-6">
                  <span className="material-symbols-outlined text-stem-orange text-[22px]">notifications_active</span>
                  <h2 className="text-label-md text-deep-navy uppercase tracking-wider">Recent Alerts</h2>
                </div>
                <div className="space-y-3">
                  {[
                    { msg: 'Invoice #882 payment received', time: '12m ago', color: 'text-green-600', bg: 'bg-green-50' },
                    { msg: 'New tenant provisioned: Lyon Academy', time: '2h ago', color: 'text-indigo-accent', bg: 'bg-indigo-accent/5' },
                    { msg: 'API rate limit at 85%', time: '5h ago', color: 'text-stem-orange', bg: 'bg-stem-orange/5' },
                  ].map((alert, i) => (
                    <div key={i} className={`flex items-start gap-2 p-3 rounded-xl ${alert.bg}`}>
                      <span className={`material-symbols-outlined text-[16px] mt-0.5 ${alert.color}`}>circle</span>
                      <div className="flex-1">
                        <p className="text-body-sm text-deep-navy">{alert.msg}</p>
                        <p className="text-label-sm text-on-surface-variant">{alert.time}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Sticky Save Actions */}
        <div className="sticky bottom-0 bg-pure-white border border-outline-variant/20 shadow-lg rounded-xl px-6 py-4 flex items-center justify-end gap-4">
          <button className="px-6 py-2.5 border border-outline-variant/50 rounded-xl text-label-md text-on-surface-variant hover:bg-surface-container-low hover:text-deep-navy transition-all">Cancel</button>
          <button onClick={handleSave} disabled={saving} className="px-6 py-2.5 bg-deep-navy text-pure-white rounded-xl text-label-md font-bold hover:brightness-125 active:scale-[0.97] disabled:opacity-50 transition-all flex items-center gap-2 shadow">
            <span className="material-symbols-outlined text-[18px]">save</span>
            {saving ? 'Saving…' : 'Save Changes'}
          </button>
        </div>
      </div>
    </AdminLayout>
  );
}
