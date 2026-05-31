const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const dotenv = require('dotenv');
const http = require('http');
const socketIo = require('socket.io');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const compression = require('compression');

const authRoutes = require('./routes/auth');
const departmentRoutes = require('./routes/departments');
const machineRoutes = require('./routes/machines');
const sensorRoutes = require('./routes/sensors');
const signalRoutes = require('./routes/signals');
const configRoutes = require('./routes/config');
const analyticsRoutes = require('./routes/analytics');
const userRoutes = require('./routes/users');
const moldRoutes = require('./routes/molds.js');
const reportRoutes = require('./routes/reports');

dotenv.config();

// ── Fail fast on missing required configuration ─────────────────────────────
const REQUIRED_ENV = ['JWT_SECRET', 'MONGODB_URI', 'DAEMON_API_KEY'];
const missingEnv = REQUIRED_ENV.filter((k) => !process.env[k]);
if (missingEnv.length) {
  console.error(`FATAL: missing required environment variables: ${missingEnv.join(', ')}`);
  console.error('See server/.env.example for the full list and how to generate secrets.');
  process.exit(1);
}
const isProd = process.env.NODE_ENV === 'production';
if (isProd && !process.env.RECAPTCHA_SECRET_KEY) {
  console.error('FATAL: RECAPTCHA_SECRET_KEY is required when NODE_ENV=production.');
  process.exit(1);
}

// Allowed browser origins (comma-separated) shared by CORS and Socket.IO.
const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:5173')
  .split(',')
  .map((o) => o.trim())
  .filter(Boolean);

const app = express();
app.set('trust proxy', 1); // sits behind nginx / load balancer in production
const server = http.createServer(app);
const io = socketIo(server, {
  cors: { origin: allowedOrigins, methods: ['GET', 'POST'], credentials: true }
});

const PORT = process.env.PORT || 3001;

// ── Security middleware ──────────────────────────────────────────────────────
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      scriptSrc: ["'self'", 'https://www.google.com', 'https://www.gstatic.com'],
      frameSrc: ['https://www.google.com'],
      imgSrc: ["'self'", 'data:', 'https:'],
      connectSrc: ["'self'", ...allowedOrigins]
    }
  }
}));

app.use(cors({
  origin: allowedOrigins,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'],
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'X-API-Key']
}));
app.use(express.json({ limit: '1mb' }));
app.use(compression());

// ── Rate limiting ────────────────────────────────────────────────────────────
const windowMs = parseInt(process.env.RATE_LIMIT_WINDOW_MS, 10) || 15 * 60 * 1000;
const loginLimiter = rateLimit({
  windowMs,
  max: parseInt(process.env.RATE_LIMIT_AUTH_MAX, 10) || 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { message: 'Too many login attempts, please try again later' }
});
const generalLimiter = rateLimit({
  windowMs,
  max: parseInt(process.env.RATE_LIMIT_GENERAL_MAX, 10) || 300,
  standardHeaders: true,
  legacyHeaders: false,
  // The PLC daemon polls /api/signals frequently (already API-key protected) and
  // the health probe must always answer — exclude both from the general limit.
  skip: (req) => req.path.startsWith('/api/signals') || req.path === '/api/health',
  message: { message: 'Too many requests, please try again later' }
});
app.use(generalLimiter);
app.use('/api/auth/login', loginLimiter); // strict, login only

// Make io available to routes
app.set('io', io);

// ── Socket.IO connection handling ─────────────────────────────────────────────
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });

  // Join machine-specific rooms for targeted updates
  socket.on('join-machine', (machineId) => {
    socket.join(`machine-${machineId}`);
  });

  socket.on('leave-machine', (machineId) => {
    socket.leave(`machine-${machineId}`);
  });
});

// ── Routes ────────────────────────────────────────────────────────────────────
app.use('/api/auth', authRoutes);
app.use('/api/departments', departmentRoutes);
app.use('/api/machines', machineRoutes);
app.use('/api/sensors', sensorRoutes);
app.use('/api/signals', signalRoutes);
app.use('/api/config', configRoutes);
app.use('/api/analytics', analyticsRoutes);
app.use('/api/users', userRoutes);
app.use('/api/molds', moldRoutes);
app.use('/api/reports', reportRoutes);

// Health check — also verifies DB connectivity so orchestrators can act on it.
app.get('/api/health', (req, res) => {
  const dbUp = mongoose.connection.readyState === 1;
  res.status(dbUp ? 200 : 503).json({
    status: dbUp ? 'OK' : 'DEGRADED',
    db: dbUp ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString()
  });
});

// Unknown API routes → clean 404 (instead of falling through to the SPA/host).
app.use('/api', (req, res) => res.status(404).json({ message: 'Not found' }));

// ── Global error handler (must be last) ───────────────────────────────────────
// Logs full detail server-side; returns a generic message so internals/stack
// traces are never leaked to clients.
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ message: 'Internal server error' });
});

// ── MongoDB connection (pooled, with retry + reconnection logging) ────────────
mongoose.connection.on('error', (err) => console.error('MongoDB error:', err.message));
mongoose.connection.on('disconnected', () => console.warn('MongoDB disconnected'));
mongoose.connection.on('reconnected', () => console.log('MongoDB reconnected'));

async function connectWithRetry(attempt = 1) {
  try {
    await mongoose.connect(process.env.MONGODB_URI, {
      serverSelectionTimeoutMS: 5000,
      maxPoolSize: 20
    });
    console.log('Connected to MongoDB');
    signalRoutes.startStoppageMonitor(io); // start the single background monitor
  } catch (err) {
    const delay = Math.min(30000, 1000 * 2 ** attempt);
    console.error(`MongoDB connection failed (attempt ${attempt}): ${err.message}. Retrying in ${delay}ms`);
    setTimeout(() => connectWithRetry(attempt + 1), delay);
  }
}
connectWithRetry();

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// ── Graceful shutdown ─────────────────────────────────────────────────────────
let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`${signal} received, shutting down gracefully...`);
  server.close(() => console.log('HTTP server closed'));
  io.close();
  try { await mongoose.connection.close(); } catch (_) { /* ignore */ }
  process.exit(0);
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => console.error('Unhandled promise rejection:', reason));
