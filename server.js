require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const path = require('path');
const rateLimit = require('express-rate-limit');
const { Server } = require('socket.io');

const authRoutes = require('./routes/auth');
const leagueRoutes = require('./routes/leagues');
const tournamentRoutes = require('./routes/tournaments');
const syncRoutes = require('./routes/sync');
const lineupRoutes = require('./routes/lineups');
const rosterRoutes = require('./routes/rosters');
const tradeRoutes = require('./routes/trades');
const pushRoutes = require('./routes/push');
const setupDraftSocket = require('./services/draftSocket');
const scheduler = require('./services/scheduler');

const app = express();
const server = http.createServer(app);

// --- CORS ---
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : ['*'];

const corsOptions = {
  origin: ALLOWED_ORIGINS.includes('*') ? true : ALLOWED_ORIGINS,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
};

const io = new Server(server, { cors: corsOptions });

app.use(cors(corsOptions));
app.use(express.json({ limit: '1mb' }));

// Trust proxy so rate limiter uses X-Forwarded-For (Render sits behind a proxy)
app.set('trust proxy', 1);

// --- Rate Limiting ---
const globalLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later' },
});

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many auth attempts, please try again later' },
});

const syncLimiter = rateLimit({
  windowMs: 2 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Sync rate limited, please wait' },
});

app.use('/api/', globalLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/register', authLimiter);
app.use('/api/sync', syncLimiter);

// --- Health check ---
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// --- Static pages ---
app.get('/privacy', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy-policy.html'));
});
app.get('/support', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'support.html'));
});

// --- Routes ---
app.use('/api/auth', authRoutes);
app.use('/api/leagues', leagueRoutes);
app.use('/api/tournaments', tournamentRoutes);
app.use('/api/sync', syncRoutes);
app.use('/api/lineups', lineupRoutes);
app.use('/api/rosters', rosterRoutes);
app.use('/api/trades', tradeRoutes);
app.use('/api/push', pushRoutes);

// --- WebSocket ---
setupDraftSocket(io);

// --- Global error handler ---
app.use((err, req, res, _next) => {
  console.error('Unhandled route error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

// --- Unhandled rejection / exception safety net ---
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  // Give time for logs to flush, then exit so the process manager restarts us
  setTimeout(() => process.exit(1), 1000);
});

// --- Graceful shutdown ---
function shutdown(signal) {
  console.log(`${signal} received — shutting down gracefully`);
  scheduler.stop();
  io.close();
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
  // Force exit after 10s if connections haven't drained
  setTimeout(() => process.exit(1), 10_000).unref();
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

// --- Start ---
const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  scheduler.start();
});
