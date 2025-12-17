const express = require('express');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(__dirname));

const ENDOWMENT = 5; 
const THRESHOLD_FACTOR = 2.5; 
const PUNISH_COST = 1;
const PUNISH_FINE = 3;
const COOPERATION_MINIMUM = 3; // Mínim per no ser considerat defector

let adminSocketId = null;
let players = {}; // Objecte: { userId: { ... } }
let punishers = []; // Array d'IDs dels jugadors que volen castigar
let gameState = {
    active: false,
    currentRound: 0,
    maxRounds: 5,
    history: [] 
};

// --- FUNCIONS AUXILIARS ---

// Fisher-Yates Shuffle
function shuffle(array) {
    for (let i = array.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [array[i], array[j]] = [array[j], array[i]];
    }
    return array;
}

// Lògica de Càstig
function executePunishmentLogic() {
    // 1. Cobrar als castigadors
    punishers.forEach(userId => {
        if (players[userId] && players[userId].savings > 0) {
            players[userId].savings -= PUNISH_COST;
        }
    });

    // 2. Identificar defectors (Contribució < 3)
    // Convertim l'objecte players a array per filtrar
    let defectors = Object.values(players).filter(p => p.contribution !== null && p.contribution < COOPERATION_MINIMUM);
    
    let punishmentReportMap = {}; // userId -> quantes vegades castigat

    if (defectors.length > 0 && punishers.length > 0) {
        // 3. Barrejar defectors per aleatorietat
        defectors = shuffle(defectors);

        let totalPunishments = punishers.length;
        let i = 0;

        // 4. Repartir càstigs
        while (totalPunishments > 0) {
            let target = defectors[i % defectors.length];
            
            // Aplicar multa
            target.savings -= PUNISH_FINE;
            
            // Registrar per l'informe
            if (!punishmentReportMap[target.id]) punishmentReportMap[target.id] = 0;
            punishmentReportMap[target.id]++;

            totalPunishments--;
            i++;
        }
    }

    return punishmentReportMap;
}


// --- SOCKETS ---

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

    // Avançar de ronda (Botó "Següent Ronda")
    socket.on('adminNextRound', () => {
        if (gameState.currentRound < gameState.maxRounds) {
            gameState.currentRound++;
            
            // RESET per la nova ronda
            punishers = []; 
            Object.values(players).forEach(p => {
                p.contribution = null; // Ara ho resetegem aquí, no abans
            });

            console.log("Avançant manualment a ronda:", gameState.currentRound);
            io.emit('newRound', { round: gameState.currentRound, maxRounds: gameState.maxRounds });
            
            // Actualitzem display a l'admin
            if (adminSocketId) {
                io.to(adminSocketId).emit('updateGameState', gameState);
                io.to(adminSocketId).emit('updatePlayerList', getPlayerListForAdmin());
            }
        } else {
            triggerGameVictory();
        }
    });

    // EXECUTAR CÀSTIGS (Botó Taronja Admin)
    socket.on('adminExecutePunishments', () => {
        const reportMap = executePunishmentLogic();

        // Informar als estudiants
        Object.values(players).forEach(p => {
            const punishedTimes = reportMap[p.id] || 0;
            io.to(p.socketId).emit('punishmentReport', {
                newSavings: p.savings,
                punishedAmount: punishedTimes
            });
        });

        // Actualitzar llista admin (per veure els nous estalvis)
        if (adminSocketId) io.to(adminSocketId).emit('updatePlayerList', getPlayerListForAdmin());
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
        punishers = [];
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

    // Sol·licitud de càstig (Estudiant)
    socket.on('requestPunish', ({ userId }) => {
        // Evitar duplicats i assegurar que té diners
        if (!punishers.includes(userId) && players[userId] && players[userId].savings >= PUNISH_COST) {
            punishers.push(userId);
            // Actualitzar comptador admin
            if (adminSocketId) io.to(adminSocketId).emit('updatePunishCount', punishers.length);
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
    punishers = [];
    
    Object.values(players).forEach(p => {
        p.savings = 0; 
        p.contribution = null;
        p.history = [];
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
        hasPlayed: p.contribution !== null,
        savings: p.savings // Afegit perquè l'admin vegi els estalvis
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
        // IMPORTANT: NO resetegem p.contribution = null aquí.
        // Ho fem a 'adminNextRound' per permetre els càstigs basats en contribució.
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
        
        io.to(adminSocketId).emit('roundResult', {
            success: isSuccess,
            wasSavedByCoin: wasSavedByCoin,
            round: gameState.currentRound,
            maxRounds: gameState.maxRounds
        });
    }
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

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Servidor funcionant al port ${PORT}`);
});