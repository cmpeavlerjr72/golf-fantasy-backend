require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');

const authRoutes = require('./routes/auth');
const leagueRoutes = require('./routes/leagues');
const tournamentRoutes = require('./routes/tournaments');
const syncRoutes = require('./routes/sync');
const setupDraftSocket = require('./services/draftSocket');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*', methods: ['GET', 'POST'] },
});

app.use(cors());
app.use(express.json());

// Health check
app.get('/api/health', (req, res) => res.json({ status: 'ok' }));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/leagues', leagueRoutes);
app.use('/api/tournaments', tournamentRoutes);
app.use('/api/sync', syncRoutes);

// WebSocket for draft
setupDraftSocket(io);

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
