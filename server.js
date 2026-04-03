const express = require('express');
const http    = require('http');
const { Server } = require('socket.io');
const path    = require('path');
const fs      = require('fs');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server);

const PORT     = 3000;
const DATA_DIR = path.join(__dirname, 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);

app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Dogfight AI data endpoints ─────────────────────────────────────────────

// POST /api/zylon-log — append maneuver records to JSONL
app.post('/api/zylon-log', (req, res) => {
  const { records } = req.body ?? {};
  if (!Array.isArray(records) || records.length === 0) return res.sendStatus(400);
  const lines = records.map(r => JSON.stringify(r)).join('\n') + '\n';
  fs.appendFile(path.join(DATA_DIR, 'zylon_combat_log.jsonl'), lines, err =>
    err ? res.sendStatus(500) : res.sendStatus(200));
});

// POST /api/zylon-weights — merge incoming weights with stored file (90/10 smoothing)
app.post('/api/zylon-weights', (req, res) => {
  const { type, weights } = req.body ?? {};
  if (!type || !Array.isArray(weights) || weights.length !== 225) return res.sendStatus(400);
  const safe = type.replace(/[^a-z_]/g, '');
  const file = path.join(DATA_DIR, `weights_${safe}.json`);
  fs.readFile(file, 'utf8', (err, data) => {
    let merged;
    if (!err && data) {
      try {
        const stored = JSON.parse(data);
        merged = stored.map((v, i) => 0.9 * v + 0.1 * weights[i]);
      } catch { merged = weights; }
    } else {
      merged = weights;
    }
    fs.writeFile(file, JSON.stringify(merged), we => we ? res.sendStatus(500) : res.sendStatus(200));
  });
});

// GET /api/zylon-weights/:type — serve weight file to client
app.get('/api/zylon-weights/:type', (req, res) => {
  const safe = req.params.type.replace(/[^a-z_]/g, '');
  const file = path.join(DATA_DIR, `weights_${safe}.json`);
  fs.readFile(file, 'utf8', (err, data) =>
    err ? res.sendStatus(404) : res.type('json').send(data));
});

// ── Socket.io placeholder for Phase 1f multiplayer ────────────────────────
io.on('connection', socket => {
  console.log(`Player connected: ${socket.id}`);
  socket.on('disconnect', () => console.log(`Player disconnected: ${socket.id}`));
});

server.listen(PORT, () => console.log(`Star Fighter running at http://localhost:${PORT}`));

