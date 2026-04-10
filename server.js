const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const crypto = require('crypto');
const fetch = require('node-fetch');

const app = express();
app.use(express.json());

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const MAKE_TAKEOVER_WEBHOOK = process.env.MAKE_TAKEOVER_WEBHOOK_URL;

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

app.post('/api/claim', async (req, res) => {
   const { license_key, mt5_id } = req.body;
  console.log("EA IS SENDING KEY:", license_key, "MT5 ID:", mt5_id);
  if (!license_key || !mt5_id) {
    return res.status(400).json({ error: 'missing fields' });
  }
  license_key = String(license_key).trim();  
  mt5_id = String(mt5_id).trim();

 const { data: row, error } = await supabase
  .from('licenses').select('*').eq('license_key', license_key).single();

if (!row) {
  return res.status(401).json({ error: 'invalid_key' });
}
if (error) {
  console.warn('Supabase warning on licenses lookup:', error);
}

  if (row.status !== 'active') {
    return res.status(403).json({ error: row.status });
  }

  if (row.subscription_end && new Date(row.subscription_end) < new Date()) {
    await supabase.from('licenses').update({ status: 'expired' })
      .eq('license_id', row.license_id);
    return res.status(403).json({ error: 'expired' });
  }

  const lockMs = 60 * 1000;
  const lockUntil = new Date(Date.now() + lockMs).toISOString();

  // CASE A: First claim
  if (!row.current_mt5_id) {
    await supabase.from('licenses').update({
      current_mt5_id: mt5_id,
      last_heartbeat_at: new Date().toISOString(),
      claim_locked_until: lockUntil,
      pending_mt5_id: null,
      pending_expires_at: null
    }).eq('license_id', row.license_id);

    await supabase.from('license_events').insert({
      license_key, event_type: 'CLAIM_FIRST',
      from_mt5_id: null, to_mt5_id: mt5_id, detail: 'first claim'
    });

    return res.json({ status: 'claimed', case: 'first' });
  }

  // CASE B: Same session reattach
if (String(row.current_mt5_id) === String(mt5_id)) {
    await supabase.from('licenses').update({
      last_heartbeat_at: new Date().toISOString(),
      pending_mt5_id: null
    }).eq('license_id', row.license_id);

    return res.json({ status: 'claimed', case: 'reattach' });
  }

  // CASE C: Auto-takeover after 5 minute staleness
  const lastHb = row.last_heartbeat_at ? new Date(row.last_heartbeat_at) : null;
  const staleMs = lastHb ? Date.now() - lastHb.getTime() : Infinity;

  if (staleMs > 5 * 60 * 1000) {
    await supabase.from('licenses').update({
      current_mt5_id: mt5_id,
      last_heartbeat_at: new Date().toISOString(),
      claim_locked_until: lockUntil,
      pending_mt5_id: null,
      pending_expires_at: null
    }).eq('license_id', row.license_id);

    await supabase.from('license_events').insert({
      license_key, event_type: 'CLAIM_AUTO_TAKEOVER',
      from_mt5_id: row.current_mt5_id, to_mt5_id: mt5_id,
      detail: `prev session stale ${Math.round(staleMs / 60000)}min`
    });

    return res.json({ status: 'claimed', case: 'auto_takeover' });
  }

  // CASE D: Pending takeover — email confirmation required
  if (row.claim_locked_until && new Date(row.claim_locked_until) > new Date()) {
    return res.status(429).json({ error: 'rate_limit', retry_after_seconds: 60 });
  }

  const token = crypto.randomBytes(16).toString('hex');
  const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();

  await supabase.from('licenses').update({
    pending_mt5_id: mt5_id,
    pending_expires_at: expiresAt
  }).eq('license_id', row.license_id);

  await supabase.from('license_events').insert({
    license_key, event_type: 'CLAIM_PENDING_TAKEOVER',
    from_mt5_id: row.current_mt5_id, to_mt5_id: mt5_id,
    detail: 'awaiting customer confirmation'
  });

  // Trigger Make.com to send Brevo email
  try {
    await fetch(MAKE_TAKEOVER_WEBHOOK, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        license_key,
        customer_email: row.customer_email,
        customer_name: row.customer_name,
        current_mt5_id: row.current_mt5_id,
        pending_mt5_id: mt5_id,
        token
      })
    });
  } catch (e) {
    console.error('Make webhook failed:', e);
  }

  return res.status(202).json({
    status: 'pending_takeover',
    message: 'Confirmation email sent to ' + row.customer_email
  });
});

app.post('/api/heartbeat', async (req, res) => {
  const p = req.body;
  console.log("HEARTBEAT IS SENDING KEY:", p.license_key, "ID:", p.mt5_id);
  if (!p.license_key || !p.mt5_id) {
    return res.status(400).json({ error: 'missing fields' });
  }
  p.license_key = String(p.license_key).trim();   
  p.mt5_id = String(p.mt5_id).trim();           

  const { data: row, error } = await supabase
  .from('licenses').select('*').eq('license_key', p.license_key).single();

if (!row) return res.status(401).json({ error: 'invalid_key' });
if (error) console.warn('Supabase warning on heartbeat lookup:', error);
  if (row.status !== 'active') return res.status(403).json({ error: row.status });
if (String(row.current_mt5_id) !== String(p.mt5_id)) {
    await supabase.from('license_events').insert({
      license_key: p.license_key, event_type: 'HEARTBEAT_REJECTED',
      from_mt5_id: p.mt5_id, to_mt5_id: row.current_mt5_id,
      detail: 'session was taken over'
    });
    return res.status(401).json({ error: 'revoked', reason: 'session_replaced' });
  }

  await supabase.from('licenses').update({
    last_heartbeat_at: new Date().toISOString()
  }).eq('license_id', row.license_id);

 const { error: stateError } = await supabase.from('shield_state').upsert({
    license_key: p.license_key,
    mt5_id: p.mt5_id,
    profile: p.profile,
    balance: p.balance, equity: p.equity, sod: p.sod,
    pnl_pct: p.pnl_pct, hwm_pct: p.hwm_pct, floor_pct: p.floor_pct,
    heat_pct: p.heat_pct, positions: p.positions, stopped: p.stopped,
    sess_fired: p.sess_fired, session_mode: p.session_mode,
    session_count: p.session_count, wins_today: p.wins_today,
    losses_today: p.losses_today, vel_count: p.vel_count,
    news_halt: p.news_halt, velocity_halt: p.velocity_halt,
    trail_armed: p.trail_armed, ratchet_on: p.ratchet_on,
    last_trigger: p.last_trigger, timestamp: p.timestamp,
    updated_at: new Date().toISOString()
  }, { onConflict: 'license_key' });

  if (stateError) {
    console.error("UPSERT REJECTED:", stateError);
  }

  return res.json({ status: 'ok' });
});

app.get('/api/state', async (req, res) => {
  const { key, email } = req.query;
  if (!key && !email) return res.status(400).json({ error: 'missing key or email' });

  const sel = `license_id, license_key, customer_email, customer_name, current_mt5_id, plan, status, pending_mt5_id, shield_state(*)`;
  let q = supabase.from('licenses').select(sel).eq('status', 'active');
  if (email) q = q.eq('customer_email', email).order('created_at', { ascending: true });
  else q = q.eq('license_key', key).limit(1);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: 'db_error' });

  const flat = (data || []).map(r => {
    const s = (r.shield_state && r.shield_state[0]) || {};
    return { ...r, ...s, account_id: r.current_mt5_id };
  });

  return res.json(flat);
});

app.listen(process.env.PORT || 3000);
