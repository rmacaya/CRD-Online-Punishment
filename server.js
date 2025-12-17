const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

const ENDOWMENT = 5; 
const THRESHOLD_FACTOR = 2.5; 

let adminSocketId = null;
let players = {}; 
let gameState = {
    active: false,
    currentRound: 0,
    maxRounds: 5,
    history: [] 
};

io.on('connection', (socket) => {
    
    // --- ADMIN ---
    socket.on('adminLogin', () => {
        adminSocketId = socket.id;
        console.log("Admin connectat");
        socket.emit('updatePlayerList', getPlayerListForAdmin());
        socket.emit('updateGameState', gameState);
    });

    socket.on('startGame', (settings) => {
        startNewGame(parseInt(settings.rounds) || 5);
    });

    socket.on('restartGame', (settings) => {
        const rounds = settings && settings.rounds ? parseInt(settings.rounds) : 5;
        startNewGame(rounds); 
    });

    // NOU: L'Admin demana passar de ronda manualment
    socket.on('adminNextRound', () => {
        if (gameState.currentRound < gameState.maxRounds) {
            gameState.currentRound++;
            console.log("Avançant manualment a ronda:", gameState.currentRound);
            io.emit('newRound', { round: gameState.currentRound, maxRounds: gameState.maxRounds });
            
            // Actualitzem display a l'admin també
            if (adminSocketId) io.to(adminSocketId).emit('updateGameState', gameState);
        } else {
            triggerGameVictory();
        }
    });

    socket.on('fullReset', () => {
        console.log("EXECUTANT RESET TOTAL");
        players = {};
        gameState = {
            active: false,
            currentRound: 0,
            maxRounds: 5,
            history: [] 
        };
        io.emit('forceReload');
    });

    // --- JUGADORS ---
    socket.on('joinGame', ({ userId, name }) => {
        if (players[userId]) {
            players[userId].socketId = socket.id;
            players[userId].connected = true;
            players[userId].name = name; 
        } else {
            players[userId] = {
                id: userId,
                name: name,
                socketId: socket.id,
                connected: true,
                contribution: null,
                savings: 0,
                history: [] 
            };
        }

        if (adminSocketId) io.to(adminSocketId).emit('updatePlayerList', getPlayerListForAdmin());

        socket.emit('welcome', { 
            name: players[userId].name, 
            gameState: gameState.active ? 'playing' : 'waiting',
            round: gameState.currentRound,
            maxRounds: gameState.maxRounds, 
            savings: players[userId].savings,
            history: players[userId].history
        });
    });

    socket.on('submitContribution', ({ userId, amount }) => {
        if (!gameState.active) return;
        if (players[userId]) {
            players[userId].contribution = parseInt(amount);
            if (adminSocketId) io.to(adminSocketId).emit('updatePlayerList', getPlayerListForAdmin());
            checkEndOfRound();
        }
    });

    socket.on('disconnect', () => {
        if (socket.id === adminSocketId) {
            adminSocketId = null;
            io.emit('adminLeft'); 
        } else {
            const userId = Object.keys(players).find(key => players[key].socketId === socket.id);
            if (userId) {
                players[userId].connected = false;
                if (adminSocketId) io.to(adminSocketId).emit('updatePlayerList', getPlayerListForAdmin());
            }
        }
    });
});

function startNewGame(rounds) {
    gameState.active = true;
    gameState.currentRound = 1;
    gameState.maxRounds = rounds;
    gameState.history = [];
    
    Object.values(players).forEach(p => {
        p.savings = 0; 
        p.contribution = null;
    });

    io.emit('gameStarted', { round: 1, maxRounds: gameState.maxRounds });
    io.emit('newRound', { round: 1, maxRounds: gameState.maxRounds });
    
    if (adminSocketId) {
        io.to(adminSocketId).emit('updateGameState', gameState);
        io.to(adminSocketId).emit('updatePlayerList', getPlayerListForAdmin());
    }
}

function getPlayerListForAdmin() {
    return Object.values(players).map(p => ({
        id: p.id,
        name: p.name,
        connected: p.connected,
        hasPlayed: p.contribution !== null
    }));
}

function checkEndOfRound() {
    const allPlayers = Object.values(players);
    const allPlayed = allPlayers.every(p => p.contribution !== null);

    if (allPlayed && allPlayers.length > 0) {
        processRoundLogic();
    }
}

function processRoundLogic() {
    let pot = 0;
    const allPlayers = Object.values(players);
    const nPlayers = allPlayers.length;

    allPlayers.forEach(p => { pot += p.contribution; });
    const threshold = nPlayers * THRESHOLD_FACTOR;

    if (pot >= threshold) {
        finalizeRound(true, pot, threshold, nPlayers, false);
    } else {
        io.emit('triggerCoinAnimation', { pot, threshold });

        setTimeout(() => {
            try {
                const isHeads = Math.random() < 0.5; 
                if (isHeads) {
                    finalizeRound(true, pot, threshold, nPlayers, true);
                } else {
                    triggerGameLoss();
                }
            } catch (e) {
                console.error(e);
                triggerGameLoss();
            }
        }, 4000); 
    }
}

function finalizeRound(isSuccess, pot, threshold, nPlayers, wasSavedByCoin) {
    Object.values(players).forEach(p => {
        const kept = ENDOWMENT - p.contribution; 
        p.savings += kept; 

        const socket = io.sockets.sockets.get(p.socketId);
        if (socket) {
            socket.emit('roundResult', {
                kept,
                savings: p.savings,
                round: gameState.currentRound,
                maxRounds: gameState.maxRounds,
                success: isSuccess,
                wasSavedByCoin: wasSavedByCoin
            });
        }
        p.contribution = null;
    });

    gameState.history.push({
        round: gameState.currentRound,
        total: pot,
        max: nPlayers * ENDOWMENT,
        threshold: threshold,
        success: isSuccess
    });

    if (adminSocketId) {
        io.to(adminSocketId).emit('updateGameState', gameState);
        io.to(adminSocketId).emit('updatePlayerList', getPlayerListForAdmin());
        
        // Enviem resultats per l'admin (necessari per activar els botons)
        io.to(adminSocketId).emit('roundResult', {
            success: isSuccess,
            wasSavedByCoin: wasSavedByCoin,
            round: gameState.currentRound,
            maxRounds: gameState.maxRounds
        });
    }

    // MODIFICAT: JA NO AVANÇA AUTOMÀTICAMENT. 
    // Esperem al botó de l'admin.
}

function triggerGameVictory() {
    gameState.active = false;
    
    Object.values(players).forEach(p => {
        p.history.push(p.savings);
        const socket = io.sockets.sockets.get(p.socketId);
        if (socket) {
            socket.emit('playerGameWon', { 
                finalSavings: p.savings,
                history: p.history 
            });
        }
    });

    if (adminSocketId) {
        const leaderboard = Object.values(players)
            .map(p => ({ name: p.name, savings: p.savings }))
            .sort((a, b) => b.savings - a.savings);
        io.to(adminSocketId).emit('adminGameWon', { leaderboard });
    }
}

function triggerGameLoss() {
    gameState.active = false;
    Object.values(players).forEach(p => {
        p.history.push(0); 
        const socket = io.sockets.sockets.get(p.socketId);
        if (socket) {
            socket.emit('updateHistory', p.history);
        }
    });
    io.emit('gameLost'); 
    if (adminSocketId) {
        io.to(adminSocketId).emit('adminGameLost'); 
    }
}

server.listen(3000, () => {
    console.log('Servidor funcionant a http://localhost:3000');
});

// --- AFEGIR AQUESTA LÒGICA AL TEU SERVIDOR (index.js) ---

// Funció per barrejar arrays (Fisher-Yates)
function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// Funció principal de càstig
function processPunishments(players, punishersIds) {
    // 1. Cobrar als castigadors (1 moneda)
    punishersIds.forEach(id => {
        let p = players.find(pl => pl.id === id);
        if (p && p.savings > 0) {
            p.savings -= 1;
        }
    });

    // 2. Identificar els "defectors" (aportació < 3)
    let defectors = players.filter(p => p.lastContribution < 3);
    
    // Si no hi ha ningú a qui castigar, els diners dels castigadors es perden igualment (cost de l'acció)
    // o es podrien tornar, però normalment en jocs econòmics el cost és enfonsat.
    if (defectors.length === 0) return players;

    // 3. Barrejar l'ordre dels defectors per aleatorietat
    defectors = shuffle(defectors);

    // 4. Assignar càstigs
    let totalPunishments = punishersIds.length;
    let punishmentIndex = 0;

    while (totalPunishments > 0) {
        // Seleccionem el defector en ordre circular (Ronda 1, després Ronda 2...)
        let target = defectors[punishmentIndex % defectors.length];
        
        target.savings -= 3; // El càstig és de 3 monedes
        target.receivedPunishments = (target.receivedPunishments || 0) + 1;

        totalPunishments--;
        punishmentIndex++;
    }

    return players;
}