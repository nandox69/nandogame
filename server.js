const express = require('express');
const path = require('path');
const fs = require('fs');
const mqtt = require('mqtt');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const axios = require('axios');

process.on('unhandledRejection', (reason, p) => {
  console.error('[CRASH] Unhandled Rejection:', reason?.message || reason);
});

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
const DB_PATH = path.join(__dirname, 'data.json');

const MQTT_HOST = process.env.MQTT_HOST || 'wss://g71b6171.ala.us-east-1.emqxsl.com:8084/mqtt';
const MQTT_USER = process.env.MQTT_USER || 'nandox69';
const MQTT_PASS = process.env.MQTT_PASS || 'osorno7669';

app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

function readDB() {
  try {
    return JSON.parse(fs.readFileSync(DB_PATH, 'utf8'));
  } catch {
    const def = {
      users: [
        { username: 'nando', password: bcrypt.hashSync('766976', 10), role: 'admin', name: 'Nando', adminPin: '766976' },
        { username: 'demo', password: bcrypt.hashSync('12345', 10), role: 'tecnico', name: 'Demo', trialExpiry: Date.now() + 7 * 24 * 60 * 60 * 1000 },
        { username: 'kata', password: bcrypt.hashSync('12345', 10), role: 'tecnico', name: 'Kata', trialExpiry: Date.now() + 7 * 24 * 60 * 60 * 1000 },
        { username: 'carlos', password: bcrypt.hashSync('12345', 10), role: 'tecnico', name: 'Carlos', trialExpiry: Date.now() + 7 * 24 * 60 * 60 * 1000 },
      ],
      machines: [],
      revenue: [],
      alarms: [],
      loginLog: [],
    };
    writeDB(def);
    return def;
  }
}
function writeDB(data) { fs.writeFileSync(DB_PATH, JSON.stringify(data, null, 2)); }

function auth(roles) {
  return (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'Token requerido' });
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      req.user = decoded;
      if (roles && !roles.includes(decoded.role)) return res.status(403).json({ error: 'Permiso denegado' });
      next();
    } catch { return res.status(401).json({ error: 'Token invalido' }); }
  };
}

function genApiKey() { return 'nk_' + crypto.randomBytes(24).toString('hex'); }
function genMachineId() {
  const db = readDB();
  let n = db.machines.length + 1;
  let id;
  do { id = 'M' + String(n++).padStart(4, '0'); } while (db.machines.find(m => m.id === id));
  return id;
}

function enChile() {
  const now = new Date();
  const opts = { timeZone: 'America/Santiago', hour12: false };
  const parts = now.toLocaleString('en-US', opts).split(', ')[1].split(':');
  return { h: parseInt(parts[0]), m: parseInt(parts[1]), d: now.toLocaleDateString('en-CA', { timeZone: 'America/Santiago' }) };
}

function checkPelucheAlarm(m, db) {
  if (!m.pelucheMax || !m.digitalReadings || typeof m.digitalReadings.win !== 'number') return;
  const restockAt = m.pelucheRestockAt || 0;
  const usados = m.digitalReadings.win - restockAt;
  const restantes = m.pelucheMax - usados;
  const pct = restantes / m.pelucheMax;
  if (pct < 0.3 && restantes < m.pelucheMax) {
    const yaHay = db.alarms.some(a => a.machineId === m.id && a.type === 'peluches_bajos' && !a.resolved);
    if (!yaHay) {
      db.alarms.push({
        machineId: m.id, type: 'peluches_bajos',
        message: `${m.id} peluches bajos (${Math.max(0,restantes)}/${m.pelucheMax}) — rellenar`,
        triggeredAt: new Date().toISOString(), resolved: false
      });
    }
  }
}

function checkAlarms() {
  const db = readDB();
  const now = Date.now();
  const { h } = enChile();
  const dentroHorario = h >= 8 && h < 23;
  db.machines.forEach(m => {
    if (!m.lastSeen || !dentroHorario) return;
    const diff = now - new Date(m.lastSeen).getTime();
    if (diff > 6 * 3600 * 1000 && m.status !== 'alarm') {
      m.status = 'alarm';
      db.alarms.push({
        machineId: m.id, type: 'offline_6h', message: `Maquina ${m.name} lleva mas de 6h sin conexion`,
        triggeredAt: new Date().toISOString(), resolved: false
      });
    }
    // Alarma de peluches bajos (< 30% de capacidad)
    if (m.pelucheMax && m.digitalReadings && typeof m.digitalReadings.win === 'number') {
      const restockAt = m.pelucheRestockAt || 0;
      const usados = m.digitalReadings.win - restockAt;
      const restantes = m.pelucheMax - usados;
      const pct = restantes / m.pelucheMax;
      const yaHayAlarma = db.alarms.some(a => a.machineId === m.id && a.type === 'peluches_bajos' && !a.resolved);
      if (pct < 0.3 && !yaHayAlarma) {
        db.alarms.push({
          machineId: m.id, type: 'peluches_bajos',
          message: `${m.id} peluches bajos (${Math.max(0,restantes)}/${m.pelucheMax}) — rellenar`,
          triggeredAt: new Date().toISOString(), resolved: false
        });
      }
    }
  });
  writeDB(db);
}

// AUTH
app.post('/api/login', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Usuario y contrasena requeridos' });
  const db = readDB();
  const user = db.users.find(u => u.username === username.toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: 'Credenciales incorrectas' });
  if (user.trialExpiry && Date.now() > user.trialExpiry) return res.status(403).json({ error: 'Periodo de prueba expirado' });
  if (user.suspended) return res.status(403).json({ error: 'Has sido suspendido. Contacta a Nando para reactivarte.' });
  db.loginLog.unshift({ user: username, time: new Date().toISOString(), ip: req.ip });
  if (db.loginLog.length > 500) db.loginLog.length = 500;
  writeDB(db);
  const token = jwt.sign({ username: user.username, role: user.role, name: user.name }, JWT_SECRET, { expiresIn: '24h' });
  res.json({ token, user: { username: user.username, role: user.role, name: user.name } });
});

app.get('/api/me', auth(), (req, res) => res.json(req.user));

// USERS (admin only)
app.get('/api/users', auth(['admin']), (req, res) => {
  const db = readDB();
  res.json(db.users.map(u => ({ username: u.username, role: u.role, name: u.name, trialExpiry: u.trialExpiry })));
});

app.post('/api/users', auth(['admin']), (req, res) => {
  const db = readDB();
  const { username, password, role, name, trialDays } = req.body;
  if (!username || !password || !role) return res.status(400).json({ error: 'Faltan campos' });
  if (db.users.find(u => u.username === username.toLowerCase())) return res.status(400).json({ error: 'Usuario ya existe' });
  db.users.push({
    username: username.toLowerCase(), password: bcrypt.hashSync(password, 10), role, name: name || username,
    trialExpiry: role !== 'admin' && trialDays ? Date.now() + trialDays * 24 * 60 * 60 * 1000 : undefined
  });
  writeDB(db);
  res.json({ ok: true });
});

app.delete('/api/users/:username', auth(['admin']), (req, res) => {
  const db = readDB();
  const target = req.params.username;
  if (target === 'nando') {
    // Track delete attempts
    db.deleteAttemptsNando = db.deleteAttemptsNando || [];
    const attempter = req.user.username;
    const attempts = db.deleteAttemptsNando.filter(a => a.user === attempter);
    if (attempts.length >= 1) {
      // Second attempt — suspend the user
      const u = db.users.find(x => x.username === attempter);
      if (u) {
        u.suspended = true;
        u.suspendedBy = 'auto';
        u.suspendedAt = new Date().toISOString();
      }
      db.deleteAttemptsNando.push({ user: attempter, time: new Date().toISOString() });
      writeDB(db);
      return res.status(403).json({ error: 'Has sido suspendido por intentar borrar al creador. Contacta a Nando para reactivarte.' });
    }
    db.deleteAttemptsNando.push({ user: attempter, time: new Date().toISOString() });
    writeDB(db);
    return res.status(403).json({ error: 'Es imposible borrar al creador' });
  }
  db.users = db.users.filter(u => u.username !== target);
  writeDB(db);
  res.json({ ok: true });
});

// Reactivate suspended users (only nando)
app.put('/api/users/:username/reactivate', auth(['admin']), (req, res) => {
  if (req.user.username !== 'nando') return res.status(403).json({ error: 'Solo Nando puede reactivar usuarios' });
  const db = readDB();
  const u = db.users.find(x => x.username === req.params.username);
  if (!u) return res.status(404).json({ error: 'Usuario no encontrado' });
  u.suspended = false;
  u.suspendedBy = undefined;
  u.suspendedAt = undefined;
  // Clear delete attempts for this user
  db.deleteAttemptsNando = (db.deleteAttemptsNando || []).filter(a => a.user !== req.params.username);
  writeDB(db);
  res.json({ ok: true });
});

// MACHINES
app.get('/api/machines', auth(), (req, res) => {
  const db = readDB();
  res.json(db.machines);
});

const DEFAULT_COUNTERS = {
  coin1: { label: 'Moneda 1', valuePerPulse: 500, enabled: true },
  coin2: { label: 'Moneda 2', valuePerPulse: 200, enabled: false },
  bill: { label: 'Billete', valuePerPulse: 1000, enabled: false },
  win: { label: 'Premio', valuePerPulse: 0, enabled: true },
};

app.post('/api/machines', auth(['admin', 'tecnico']), (req, res) => {
  const db = readDB();
  const { name, location, installer, image, counters, initialCounters } = req.body;
  if (!name) return res.status(400).json({ error: 'Nombre requerido' });
  const id = genMachineId();
  const machine = {
    id, name, apiKey: genApiKey(), location: location || '', installer: installer || '',
    image: image || '', created: new Date().toISOString(), lastSeen: null, status: 'unknown',
    observations: [],
    counters: counters || JSON.parse(JSON.stringify(DEFAULT_COUNTERS)),
    initialCounters: initialCounters || { coin: 0, out: 0 },
    counterHistory: [{
      timestamp: new Date().toISOString(),
      user: req.user ? req.user.username : 'system',
      coin: (initialCounters && initialCounters.coin) || 0,
      out: (initialCounters && initialCounters.out) || 0,
    }],
    digitalReadings: { coin1: 0, coin2: 0, bill: 0, win: 0 },
    pelucheMax: req.body.pelucheMax || 30,
    creditValue: req.body.creditValue || 500,
    pelucheRestockAt: 0,
  };
  db.machines.push(machine);
  writeDB(db);
  res.json(machine);
});

app.get('/api/machines/:id', auth(), (req, res) => {
  const db = readDB();
  const m = db.machines.find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'No encontrada' });
  res.json(m);
});

app.get('/api/machines/:id/last-revenue', auth(), (req, res) => {
  const db = readDB();
  const revs = db.revenue.filter(r => r.machineId === req.params.id);
  const last = revs.sort((a, b) => new Date(b.cerradoEn) - new Date(a.cerradoEn))[0] || null;
  res.json(last);
});

app.put('/api/machines/:id', auth(['admin', 'tecnico']), (req, res) => {
  const db = readDB();
  const m = db.machines.find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'No encontrada' });
  if (req.body.name !== undefined) m.name = req.body.name;
  if (req.body.location !== undefined) m.location = req.body.location;
  if (req.body.installer !== undefined) m.installer = req.body.installer;
  if (req.body.image !== undefined) m.image = req.body.image;
  if (req.body.counters !== undefined) m.counters = req.body.counters;
  if (req.body.digitalReadings !== undefined) m.digitalReadings = req.body.digitalReadings;
  if (req.body.pelucheMax !== undefined) m.pelucheMax = req.body.pelucheMax;
  if (req.body.creditValue !== undefined) m.creditValue = req.body.creditValue;
  if (req.body.pelucheRestockAt !== undefined) m.pelucheRestockAt = req.body.pelucheRestockAt;
  if (req.body.initialCounters !== undefined && req.user && req.user.username === 'nando') {
    m.initialCounters = req.body.initialCounters;
    if (!m.counterHistory) m.counterHistory = [];
    m.counterHistory.push({
      timestamp: new Date().toISOString(),
      user: 'nando',
      coin: req.body.initialCounters.coin || 0,
      out: req.body.initialCounters.out || 0,
    });
  }
  writeDB(db);
  res.json(m);
});

app.delete('/api/machines/:id', auth(['admin']), (req, res) => {
  const db = readDB();
  const existed = db.machines.some(x => x.id === req.params.id);
  console.log('[DELETE] machine %s found=%s', req.params.id, existed);
  db.machines = db.machines.filter(x => x.id !== req.params.id);
  writeDB(db);
  res.json({ ok: true });
});

app.post('/api/machines/:id/regenerate-key', auth(['admin', 'tecnico']), (req, res) => {
  const db = readDB();
  const m = db.machines.find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'No encontrada' });
  const admin = db.users.find(u => u.username === 'nando');
  if (admin.adminPin && req.body.pin !== admin.adminPin) return res.status(403).json({ error: 'PIN de administrador incorrecto. Solicita el PIN a Nando.' });
  m.apiKey = genApiKey();
  writeDB(db);
  res.json({ apiKey: m.apiKey });
});

app.post('/api/machines/:id/observation', auth(['tecnico', 'admin']), (req, res) => {
  const db = readDB();
  const m = db.machines.find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'No encontrada' });
  if (!m.observations) m.observations = [];
  m.observations.push({
    text: req.body.text || '', by: req.user.username, at: new Date().toISOString()
  });
  writeDB(db);
  res.json({ ok: true });
});

app.delete('/api/machines/:id/counter-history', auth(), (req, res) => {
  if (req.user.username !== 'nando') return res.status(403).json({ error: 'Solo nando puede eliminar el historial' });
  const db = readDB();
  const m = db.machines.find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'No encontrada' });
  m.counterHistory = [];
  writeDB(db);
  res.json({ ok: true });
});

// REVENUE
app.get('/api/revenue', auth(), (req, res) => {
  const db = readDB();
  let data = db.revenue;
  if (req.user.role === 'tecnico') {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
    data = data.filter(r => r.fecha === today);
  }
  if (req.user.role === 'recaudador') data = data.filter(r => r.cerradoPor === req.user.username);
  res.json(data);
});

app.get('/api/revenue/machine/:id', auth(), (req, res) => {
  const db = readDB();
  const revs = db.revenue.filter(r => r.machineId === req.params.id);
  const total = revs.reduce((s, r) => s + (r.pesos || 0), 0);
  const ultimo = revs.sort((a, b) => new Date(b.cerradoEn) - new Date(a.cerradoEn))[0] || null;
  res.json({ total, count: revs.length, ultimo, records: revs });
});

app.get('/api/revenue/summary', auth(['admin', 'recaudador']), (req, res) => {
  const db = readDB();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Santiago' });
  const hoy = db.revenue.filter(r => r.fecha === today);
  const total = db.revenue.reduce((s, r) => s + (r.pesos || 0), 0);
  res.json({
    total, totalHoy: hoy.reduce((s, r) => s + (r.pesos || 0), 0),
    efectivoHoy: hoy.reduce((s, r) => s + (r.efectivo || 0), 0),
    premiosHoy: hoy.reduce((s, r) => s + (r.premios || 0), 0),
    creditosHoy: hoy.reduce((s, r) => s + (r.creditos || 0), 0),
    cierresHoy: hoy.length, cierresTotal: db.revenue.length,
  });
});

app.post('/api/revenue', auth(['admin', 'recaudador']), (req, res) => {
  const db = readDB();
  const { machineId, efectivo, premios, mercadopago, pesos, observacion, restock, counterCoin, counterOut } = req.body;
  const machine = db.machines.find(m => m.id === machineId);
  const r = {
    id: 'R' + String(db.revenue.length + 1).padStart(5, '0'),
    machineId: machineId || 'unknown', fecha: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Santiago' }),
    efectivo: efectivo || 0, premios: premios || 0, mercadopago: mercadopago || 0,
    pesos: pesos || 0,
    cerradoPor: req.user.username, cerradoEn: new Date().toISOString(), observacion: observacion || '',
    restock: !!restock,
    counterCoin: counterCoin || 0,
    counterOut: counterOut || 0,
  };
  db.revenue.push(r);
  // Store last collection info on the machine
  if (machine) {
    machine.ultimoCierre = { fecha: r.cerradoEn, usuario: r.cerradoPor, efectivo: r.efectivo, premios: r.premios, mp: r.mercadopago, pesos: r.pesos, counterCoin: r.counterCoin, counterOut: r.counterOut };
    if (!machine.counterHistory) machine.counterHistory = [];
    machine.counterHistory.push({ coin: r.counterCoin, out: r.counterOut, timestamp: r.cerradoEn, user: r.cerradoPor });
    if (r.restock) {
      machine.pelucheRestockAt = (machine.digitalReadings && machine.digitalReadings.win) || machine.ultimoCierre.premios || 0;
    }
  }
  writeDB(db);
  res.json(r);
});

// MERCADO PAGO
const MP_API = 'https://api.mercadopago.com';

function getMPToken() {
  const db = readDB();
  return db.mpToken || process.env.MP_ACCESS_TOKEN || '';
}

app.post('/api/machines/:id/credits-sent', auth(), (req, res) => {
  const db = readDB();
  const m = db.machines.find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'No encontrada' });
  const n = parseInt(req.body.credits) || 0;
  m.creditsSent = (m.creditsSent || 0) + n;
  writeDB(db);
  res.json({ creditsSent: m.creditsSent });
});

app.post('/api/mercadopago/token', auth(['admin']), (req, res) => {
  const { token } = req.body;
  if (!token) return res.status(400).json({ error: 'Token requerido' });
  const db = readDB();
  db.mpToken = token;
  writeDB(db);
  res.json({ ok: true });
});

app.get('/api/mercadopago/token', auth(['admin']), (req, res) => {
  const token = getMPToken();
  res.json({ configured: !!token });
});

app.post('/api/mercadopago/pay', auth(['admin', 'recaudador']), (req, res) => {
  const token = getMPToken();
  if (!token) return res.status(400).json({ error: 'Mercado Pago no configurado. Configura el Access Token en Administracion.' });
  const { machineId, amount, credits, description } = req.body;
  if (!amount || amount <= 0) return res.status(400).json({ error: 'Monto invalido' });
  const db = readDB();

  const preference = {
    items: [{
      title: description || 'Recarga de creditos',
      quantity: 1,
      currency_id: 'CLP',
      unit_price: Number(amount),
    }],
    metadata: {
      machineId: machineId || '',
      credits: credits || 0,
      username: req.user.username,
    },
  };

  const uid = crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
  axios.post(`${MP_API}/checkout/preferences`, preference, {
    headers: { Authorization: `Bearer ${token}`, 'X-Idempotency-Key': uid },
  }).then(mpRes => {
    const payment = {
      id: 'MP' + String(db.mpPayments ? db.mpPayments.length + 1 : 1).padStart(5, '0'),
      mpId: mpRes.data.id,
      initPoint: mpRes.data.init_point,
      machineId: machineId || '',
      credits: credits || 0,
      amount: Number(amount),
      status: 'pending',
      createdBy: req.user.username,
      createdAt: new Date().toISOString(),
      description: description || 'Recarga de creditos',
    };
    if (!db.mpPayments) db.mpPayments = [];
    db.mpPayments.push(payment);
    writeDB(db);
    res.json(payment);
  }).catch(err => {
    const detail = err.response?.data || err.message;
    console.error('[MP] Error completo:', JSON.stringify(detail, null, 2));
    console.error('[MP] Status:', err.response?.status);
    res.status(500).json({ error: 'Error al crear pago', detail });
  });
});

app.get('/api/mercadopago/payments', auth(['admin', 'recaudador']), (req, res) => {
  const db = readDB();
  res.json(db.mpPayments || []);
});

app.post('/api/mercadopago/check-payment', auth(['admin', 'recaudador']), (req, res) => {
  const token = getMPToken();
  if (!token) return res.status(400).json({ error: 'MP no configurado' });
  const { preferenceId, localId } = req.body;
  if (!preferenceId) return res.status(400).json({ error: 'preferenceId requerido' });

  axios.get(`${MP_API}/v1/payments/search?preference_id=${preferenceId}`, {
    headers: { Authorization: `Bearer ${token}` },
  }).then(async mpRes => {
    const results = mpRes.data.results || [];
    const paid = results.some(p => p.status === 'approved');
    const db = readDB();
    if (localId) {
      const p = (db.mpPayments || []).find(x => x.id === localId);
      if (p) {
        if (paid && p.status !== 'approved') {
          p.status = 'approved';
          p.paidAt = new Date().toISOString();
          writeDB(db);
          // Crear registro de recaudacion automatico
          const revId = 'R' + String(db.revenue.length + 1).padStart(5, '0');
          const revenue = {
            id: revId,
            machineId: p.machineId || 'unknown',
            fecha: new Date().toLocaleDateString('en-CA', { timeZone: 'America/Santiago' }),
            efectivo: 0,
            mercadopago: p.amount || 0,
            premios: 0,
            creditos: p.credits || 0,
            pesos: p.amount || 0,
            cerradoPor: 'mercadopago',
            cerradoEn: new Date().toISOString(),
            observacion: 'Pago MP: ' + (p.description || ''),
            mpPaymentId: p.id,
          };
          db.revenue.push(revenue);
          // Track credits on machine
          const revMachine = db.machines.find(x => x.id === p.machineId);
          if (revMachine) {
            revMachine.creditsSent = (revMachine.creditsSent || 0) + (p.credits || 0);
          }
          writeDB(db);
          // Enviar creditos via MQTT
          if (p.machineId && p.credits > 0 && mqttClient) {
            mqttClient.publish('peluche/credito', String(p.credits));
            console.log(`[MP] Creditos enviados: ${p.credits} a ${p.machineId}`);
          }
        } else if (!paid) {
          p.status = 'pending';
        }
        writeDB(db);
      }
    }
    res.json({ status: paid ? 'approved' : 'pending', paid });
  }).catch(err => {
    console.error('[MP] Check error:', err.response?.data || err.message);
    res.json({ status: 'pending', paid: false });
  });
});

// ALARMS
app.get('/api/alarms', auth(['admin']), (req, res) => {
  const db = readDB();
  res.json(db.alarms.filter(a => !a.resolved).sort((a, b) => new Date(b.triggeredAt) - new Date(a.triggeredAt)));
});

app.put('/api/alarms/:id/resolve', auth(['admin']), (req, res) => {
  const db = readDB();
  const a = db.alarms.find(x => x.id === req.params.id);
  if (a) a.resolved = true;
  writeDB(db);
  res.json({ ok: true });
});

app.get('/api/alarms/history', auth(['admin']), (req, res) => {
  const db = readDB();
  res.json(db.alarms.sort((a, b) => new Date(b.triggeredAt) - new Date(a.triggeredAt)));
});

// LOGIN LOG
app.get('/api/login-log', auth(['admin']), (req, res) => {
  const db = readDB();
  res.json(db.loginLog.slice(0, 200));
});
app.delete('/api/login-log', auth(['admin']), (req, res) => {
  const db = readDB(); db.loginLog = []; writeDB(db); res.json({ ok: true });
});

// ADMIN PIN
app.get('/api/admin/pin', auth(['admin']), (req, res) => {
  const db = readDB();
  const admin = db.users.find(u => u.username === 'nando');
  res.json({ hasPin: !!admin.adminPin });
});

app.put('/api/admin/pin', auth(['admin']), (req, res) => {
  const { currentPin, newPin } = req.body;
  if (!newPin || newPin.length < 4) return res.status(400).json({ error: 'PIN debe tener al menos 4 caracteres' });
  const db = readDB();
  const admin = db.users.find(u => u.username === 'nando');
  if (admin.adminPin && admin.adminPin !== currentPin) return res.status(403).json({ error: 'PIN actual incorrecto' });
  admin.adminPin = newPin;
  writeDB(db);
  res.json({ ok: true });
});
app.post('/api/admin/pin', auth(['admin']), (req, res) => {
  const { currentPin, newPin } = req.body;
  if (!newPin || newPin.length < 4) return res.status(400).json({ error: 'PIN debe tener al menos 4 caracteres' });
  const db = readDB();
  const admin = db.users.find(u => u.username === 'nando');
  if (admin.adminPin && admin.adminPin !== currentPin) return res.status(403).json({ error: 'PIN actual incorrecto' });
  admin.adminPin = newPin;
  writeDB(db);
  res.json({ ok: true });
});

// ESP ENDPOINT (authenticated by API key)
app.post('/api/esp/status', (req, res) => {
  const apiKey = req.headers['x-api-key'];
  if (!apiKey) return res.status(401).json({ error: 'API key requerida' });
  const db = readDB();
  const machine = db.machines.find(m => m.apiKey === apiKey);
  if (!machine) return res.status(403).json({ error: 'API key invalida' });
  const data = req.body;
  machine.lastSeen = new Date().toISOString();
  machine.status = data.power === 'on' ? 'online' : 'offline';
  if (data.rssi !== undefined) machine.rssi = data.rssi;
  if (data.fw !== undefined) machine.fw = data.fw;
  writeDB(db);
  res.json({ ok: true, schedule: machine.schedule || {}, power: machine.defaultPower || 'auto' });
});

// MQTT
let mqttClient = null;
function connectMQTT() {
  mqttClient = mqtt.connect(MQTT_HOST, {
    clientId: 'nandoserver_' + Date.now(), clean: true,
    username: MQTT_USER, password: MQTT_PASS, connectTimeout: 10000,
  });
  mqttClient.on('connect', () => {
    console.log('[MQTT] Conectado');
    mqttClient.subscribe('peluche/estado');
    mqttClient.subscribe('peluche/moneda');
    mqttClient.subscribe('peluche/premio');
  });
  mqttClient.on('message', (topic, payload) => {
    try {
      const data = payload.toString();
      const db = readDB();
      if (topic === 'peluche/estado') {
        const j = JSON.parse(data);
        const mid = j.machine || '';
        const m = db.machines.find(x => x.id === mid);
        if (!m) return;
        m.lastSeen = new Date().toISOString();
        if (j.rssi !== undefined) m.rssi = j.rssi;
        m.status = j.power === 'on' ? 'online' : 'offline';
        if (j.monedas !== undefined) m.digitalReadings = m.digitalReadings || {};
        if (j.monedas !== undefined) m.digitalReadings.coin1 = j.monedas;
        if (j.premios !== undefined) m.digitalReadings = m.digitalReadings || {};
        if (j.premios !== undefined) m.digitalReadings.win = j.premios;
        if (j.premios !== undefined && m.id) checkPelucheAlarm(m, db);
        writeDB(db);
      }
      if (topic === 'peluche/moneda') {
        const j = JSON.parse(data);
        const mid = j.machine || '';
        const m = db.machines.find(x => x.id === mid);
        if (m && typeof j.value === 'number') {
          m.digitalReadings = m.digitalReadings || {};
          m.digitalReadings.coin1 = j.value;
          m.lastSeen = new Date().toISOString();
          writeDB(db);
        }
      }
      if (topic === 'peluche/premio') {
        const j = JSON.parse(data);
        const mid = j.machine || '';
        const m = db.machines.find(x => x.id === mid);
        if (m && typeof j.value === 'number') {
          m.digitalReadings = m.digitalReadings || {};
          m.digitalReadings.win = j.value;
          m.lastSeen = new Date().toISOString();
          checkPelucheAlarm(m, db);
          writeDB(db);
        }
      }
    } catch {}
  });
  mqttClient.on('error', e => console.error('[MQTT] Error:', e.message));
  mqttClient.on('close', () => setTimeout(connectMQTT, 5000));
}
connectMQTT();

// Alarm check every 60s
setInterval(checkAlarms, 60000);

app.listen(PORT, () => console.log(`[SERVER] NandoGame v3 corriendo en http://localhost:${PORT}`));
