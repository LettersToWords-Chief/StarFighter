const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 3000;

app.use(express.static(path.join(__dirname, 'public')));

// Socket.io placeholder for Phase 1f multiplayer
io.on('connection', (socket) => {
  console.log(`Player connected: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`Player disconnected: ${socket.id}`);
  });
});

server.listen(PORT, () => {
  console.log(`Star Fighter running at http://localhost:${PORT}`);
});
