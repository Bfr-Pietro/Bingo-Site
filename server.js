const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public')); // Para servir arquivos estáticos

// Armazenamento em memória das salas
const rooms = new Map();

// Gerar ID único para sala
function generateRoomId() {
    return Math.random().toString(36).substr(2, 8).toUpperCase();
}

// Rotas da API
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Criar nova sala
app.post('/api/room/create', (req, res) => {
    const roomId = generateRoomId();
    const room = {
        id: roomId,
        host: null,
        players: new Map(),
        gameData: {
            calledNumbers: [],
            currentNumber: null,
            isGameActive: false
        },
        createdAt: new Date()
    };
    
    rooms.set(roomId, room);
    
    res.json({
        success: true,
        roomId: roomId,
        message: 'Sala criada com sucesso'
    });
});

// Obter informações da sala
app.get('/api/room/:roomId', (req, res) => {
    const roomId = req.params.roomId.toUpperCase();
    const room = rooms.get(roomId);
    
    if (!room) {
        return res.status(404).json({
            success: false,
            message: 'Sala não encontrada'
        });
    }
    
    res.json({
        success: true,
        room: {
            id: room.id,
            playerCount: room.players.size,
            gameData: room.gameData,
            isActive: room.players.size > 0
        }
    });
});

// Socket.io para comunicação em tempo real
io.on('connection', (socket) => {
    console.log('Usuário conectado:', socket.id);
    
    // Entrar na sala
    socket.on('join-room', (data) => {
        const { roomId, playerName, isHost } = data;
        const room = rooms.get(roomId);
        
        if (!room) {
            socket.emit('error', { message: 'Sala não encontrada' });
            return;
        }
        
        // Adicionar jogador à sala
        const player = {
            id: socket.id,
            name: playerName || (isHost ? 'Host' : `Jogador ${room.players.size + 1}`),
            isHost: isHost || false,
            joinedAt: new Date()
        };
        
        room.players.set(socket.id, player);
        
        if (isHost) {
            room.host = socket.id;
        }
        
        // Entrar no room do Socket.io
        socket.join(roomId);
        socket.roomId = roomId;
        
        // Confirmar entrada
        socket.emit('room-joined', {
            success: true,
            roomId: roomId,
            player: player,
            gameData: room.gameData
        });
        
        // Notificar outros jogadores
        socket.to(roomId).emit('player-joined', {
            player: player,
            playerCount: room.players.size
        });
        
        // Enviar lista atualizada de jogadores
        const playersList = Array.from(room.players.values());
        io.to(roomId).emit('players-updated', {
            players: playersList,
            playerCount: room.players.size
        });
        
        console.log(`${player.name} entrou na sala ${roomId}`);
    });
    
    // Sortear número (apenas host)
    socket.on('draw-number', (data) => {
        const roomId = socket.roomId;
        const room = rooms.get(roomId);
        
        if (!room || room.host !== socket.id) {
            socket.emit('error', { message: 'Apenas o host pode sortear números' });
            return;
        }
        
        // Gerar todos os números possíveis
        const availableNumbers = [];
        const ranges = [
            { letter: 'B', min: 1, max: 15 },
            { letter: 'I', min: 16, max: 30 },
            { letter: 'N', min: 31, max: 45 },
            { letter: 'G', min: 46, max: 60 },
            { letter: 'O', min: 61, max: 75 }
        ];
        
        ranges.forEach(range => {
            for (let i = range.min; i <= range.max; i++) {
                const numberCall = `${range.letter}-${i}`;
                if (!room.gameData.calledNumbers.includes(numberCall)) {
                    availableNumbers.push(numberCall);
                }
            }
        });
        
        if (availableNumbers.length === 0) {
            socket.emit('error', { message: 'Todos os números já foram sorteados!' });
            return;
        }
        
        // Sortear número aleatório
        const randomIndex = Math.floor(Math.random() * availableNumbers.length);
        const drawnNumber = availableNumbers[randomIndex];
        
        room.gameData.calledNumbers.push(drawnNumber);
        room.gameData.currentNumber = drawnNumber;
        room.gameData.isGameActive = true;
        
        // Notificar todos os jogadores da sala
        io.to(roomId).emit('number-drawn', {
            number: drawnNumber,
            calledNumbers: room.gameData.calledNumbers,
            currentNumber: room.gameData.currentNumber
        });
        
        console.log(`Número ${drawnNumber} sorteado na sala ${roomId}`);
    });
    
    // Verificar BINGO
    socket.on('check-bingo', (data) => {
        const roomId = socket.roomId;
        const room = rooms.get(roomId);
        const player = room?.players.get(socket.id);
        
        if (!room || !player) {
            socket.emit('error', { message: 'Jogador não encontrado na sala' });
            return;
        }
        
        // Aqui você pode adicionar validação do BINGO se necessário
        // Por enquanto, vamos confiar no cliente
        
        // Notificar todos os jogadores
        io.to(roomId).emit('bingo-claimed', {
            winner: player.name,
            playerId: socket.id
        });
        
        console.log(`${player.name} declarou BINGO na sala ${roomId}`);
    });
    
    // Resetar jogo (apenas host)
    socket.on('reset-game', (data) => {
        const roomId = socket.roomId;
        const room = rooms.get(roomId);
        
        if (!room || room.host !== socket.id) {
            socket.emit('error', { message: 'Apenas o host pode resetar o jogo' });
            return;
        }
        
        // Resetar dados do jogo
        room.gameData = {
            calledNumbers: [],
            currentNumber: null,
            isGameActive: false
        };
        
        // Notificar todos os jogadores
        io.to(roomId).emit('game-reset', {
            gameData: room.gameData
        });
        
        console.log(`Jogo resetado na sala ${roomId}`);
    });
    
    // Desconexão
    socket.on('disconnect', () => {
        const roomId = socket.roomId;
        if (roomId) {
            const room = rooms.get(roomId);
            if (room) {
                const player = room.players.get(socket.id);
                room.players.delete(socket.id);
                
                // Se era o host, escolher novo host
                if (room.host === socket.id && room.players.size > 0) {
                    const newHost = Array.from(room.players.keys())[0];
                    room.host = newHost;
                    room.players.get(newHost).isHost = true;
                    
                    io.to(roomId).emit('new-host', {
                        newHostId: newHost,
                        newHostName: room.players.get(newHost).name
                    });
                }
                
                // Se não há mais jogadores, deletar sala
                if (room.players.size === 0) {
                    rooms.delete(roomId);
                    console.log(`Sala ${roomId} deletada - sem jogadores`);
                } else {
                    // Notificar jogadores restantes
                    const playersList = Array.from(room.players.values());
                    io.to(roomId).emit('players-updated', {
                        players: playersList,
                        playerCount: room.players.size
                    });
                    
                    if (player) {
                        socket.to(roomId).emit('player-left', {
                            playerName: player.name,
                            playerCount: room.players.size
                        });
                    }
                }
            }
        }
        
        console.log('Usuário desconectado:', socket.id);
    });
});

// Limpeza automática de salas antigas (a cada hora)
setInterval(() => {
    const now = new Date();
    const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);
    
    for (const [roomId, room] of rooms.entries()) {
        if (room.players.size === 0 && room.createdAt < oneHourAgo) {
            rooms.delete(roomId);
            console.log(`Sala antiga ${roomId} removida automaticamente`);
        }
    }
}, 60 * 60 * 1000); // 1 hora

// Status da API
app.get('/api/status', (req, res) => {
    res.json({
        success: true,
        status: 'online',
        rooms: rooms.size,
        uptime: process.uptime()
    });
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`Servidor rodando na porta ${PORT}`);
    console.log(`Acesse: http://localhost:${PORT}`);
});