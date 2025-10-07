const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const cors = require('cors');
const { BUILDING_COSTS } = require('./utils/gameConstants');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.NODE_ENV === 'production' 
      ? false // In production, no CORS needed since everything is served from same origin
      : ["http://localhost:3000", "http://localhost:5173"],
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? false // In production, no CORS needed since everything is served from same origin
    : ["http://localhost:3000", "http://localhost:5173"],
  methods: ["GET", "POST"]
}));
app.use(express.json());

// Serve static files from the public directory (built frontend)
app.use(express.static(path.join(__dirname, '../public')));

// API routes
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Game state storage
const games = new Map(); // gameId -> game data
const playerSockets = new Map(); // socketId -> player info

// Generate random board state for Catan
function generateBoardState() {
  // Catan tile distribution: 4 forest, 4 pasture, 4 field, 3 hill, 3 mountain, 1 desert
  const tileTypes = [
    'forest', 'forest', 'forest', 'forest',
    'pasture', 'pasture', 'pasture', 'pasture',
    'field', 'field', 'field', 'field',
    'hill', 'hill', 'hill',
    'mountain', 'mountain', 'mountain',
    'desert'
  ];

  // Number tokens (excluding 7 for desert)
  const numberTokens = [2, 3, 3, 4, 4, 5, 5, 6, 6, 8, 8, 9, 9, 10, 10, 11, 11, 12];

  // Shuffle arrays using Fisher-Yates algorithm
  function shuffle(array) {
    const shuffled = [...array];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  const shuffledTiles = shuffle(tileTypes);
  const shuffledNumbers = shuffle(numberTokens);

  // Generate tiles with numbers (desert gets no number and starts with robber)
  const tiles = [];
  let numberIndex = 0;

  for (let i = 0; i < shuffledTiles.length; i++) {
    const tile = {
      id: `tile-${i}`,
      type: shuffledTiles[i],
      number: shuffledTiles[i] === 'desert' ? null : shuffledNumbers[numberIndex],
      hasRobber: shuffledTiles[i] === 'desert'
    };

    if (shuffledTiles[i] !== 'desert') {
      numberIndex++;
    }

    tiles.push(tile);
  }

  const rowTiles = []
  rowTiles[0] = tiles.slice(0, 3)
  rowTiles[1] = tiles.slice(3, 7)
  rowTiles[2] = tiles.slice(7, 12)
  rowTiles[3] = tiles.slice(12, 16)
  rowTiles[4] = tiles.slice(16, 19)


  return {
    rowTiles,
    robberPosition: tiles.findIndex(tile => tile.hasRobber),
    timestamp: Date.now()
  };
}

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  // Handle creating a new game
  socket.on('create-game', (data) => {
    const { playerName } = data;
    const gameId = generateGameId();

    const gameData = {
      id: gameId,
      host: playerName,
      players: [{ name: playerName, socketId: socket.id }],
      maxPlayers: 4,
      status: 'waiting', // waiting, playing, ended
      created: new Date().toISOString(),
      gameState: null // Will store the actual game state when game starts
    };

    games.set(gameId, gameData);
    playerSockets.set(socket.id, { playerName, gameId, isHost: true });

    // Join the game room
    socket.join(gameId);

    // Send game created confirmation
    socket.emit('game-created', { gameId, gameData });

    // Broadcast updated games list to all clients
    broadcastGamesList();

    console.log(`Game ${gameId} created by ${playerName}`);
  });

  // Handle joining an existing game
  socket.on('join-game', (data) => {
    const { gameId, playerName } = data;
    const game = games.get(gameId);

    if (!game) {
      socket.emit('join-error', { message: 'Game not found' });
      return;
    }

    if (game.status !== 'waiting') {
      socket.emit('join-error', { message: 'Game has already started' });
      return;
    }

    if (game.players.length >= game.maxPlayers) {
      socket.emit('join-error', { message: 'Game is full' });
      return;
    }

    if (game.players.some(p => p.name === playerName)) {
      socket.emit('join-error', { message: 'Player name already taken' });
      return;
    }

    // Add player to game
    game.players.push({ name: playerName, socketId: socket.id });
    playerSockets.set(socket.id, { playerName, gameId, isHost: false });

    // Join the game room
    socket.join(gameId);

    // Send success response to the joining player
    socket.emit('join-success', { gameData: game });

    // Notify all players in the game about the new player
    io.to(gameId).emit('player-joined', {
      playerName,
      players: game.players,
      gameData: game
    });

    // Broadcast updated games list to all clients
    broadcastGamesList();

    console.log(`${playerName} joined game ${gameId}`);
  });

  // Handle starting a game
  socket.on('start-game', (data) => {
    const playerInfo = playerSockets.get(socket.id);
    if (!playerInfo || !playerInfo.isHost) {
      socket.emit('start-error', { message: 'Only the host can start the game' });
      return;
    }

    const game = games.get(playerInfo.gameId);
    if (!game) {
      socket.emit('start-error', { message: 'Game not found' });
      return;
    }

    if (game.players.length < 2) {
      socket.emit('start-error', { message: 'Need at least 2 players to start' });
      return;
    }

    // Update game status
    game.status = 'playing';

    // Initialize game state with player names
    const playerNames = game.players.map(p => p.name);

    // Generate shared board state
    const boardState = generateBoardState();
    game.gameState = boardState;

    // Notify all players that the game is starting
    io.to(playerInfo.gameId).emit('game-started', {
      gameId: playerInfo.gameId,
      players: playerNames,
      gameData: game,
      boardState: boardState
    });

    // Broadcast updated games list (game no longer visible in lobby)
    broadcastGamesList();

    console.log(`Game ${playerInfo.gameId} started with players:`, playerNames);

    // Initialize game state tracking for this game
    initializeGameStateTracking(game);
  });

  // Handle game phase update
  socket.on('game-phase-update', (data) => {
    const { gameId, gamePhase } = data;
    const game = games.get(gameId);
    if (!game) return;
    game.gameState.gamePhase = gamePhase;

    io.to(gameId).emit('game-phase-update', {
      gameId: gameId,
      gamePhase: gamePhase
    });
  });

  // Handle leaving a game
  socket.on('leave-game', () => {
    handlePlayerLeave(socket);
  });

  // Handle getting games list
  socket.on('get-games', () => {
    const availableGames = Array.from(games.values())
      .filter(game => game.status === 'waiting')
      .map(game => ({
        id: game.id,
        host: game.host,
        players: game.players.map(p => p.name),
        maxPlayers: game.maxPlayers,
        status: game.status,
        created: game.created
      }));

    socket.emit('games-list', availableGames);
  });

  // Game action handlers
  socket.on('roll-dice', () => {
    const playerInfo = playerSockets.get(socket.id);
    if (!playerInfo) return;

    const game = games.get(playerInfo.gameId);
    if (!game || game.status !== 'playing') return;

    // Generate dice roll
    const dice1 = Math.floor(Math.random() * 6) + 1;
    const dice2 = Math.floor(Math.random() * 6) + 1;
    const total = dice1 + dice2;

    // Handle resource distribution for dice roll
    if (total !== 7) {
      // Find all tiles with this number and distribute resources
      distributeResources(game, total);
    }

    // Broadcast dice roll to all players with updated resources
    io.to(playerInfo.gameId).emit('dice-rolled', {
      playerName: playerInfo.playerName,
      dice1,
      dice2,
      total,
      playerResources: game.gameState.players,
      gamePhase: 'PLAY',
      timestamp: Date.now()
    });

    console.log(`${playerInfo.playerName} rolled ${dice1} + ${dice2} = ${total}`);
  });

  // Helper function to distribute resources based on dice roll
  function distributeResources(game, diceRoll) {
    if (!game.gameState || !game.gameState.rowTiles) return;

    const resourceMap = {
      'forest': 'wood',
      'hill': 'brick',
      'pasture': 'wool',
      'field': 'grain',
      'mountain': 'ore'
    };

    console.log(`Distributing resources for dice roll: ${diceRoll}`);

    // Find all tiles with this number
    game.gameState.rowTiles.forEach(row => {
      row.forEach(tile => {
        if (tile.number === diceRoll && tile.type !== 'desert') {
          // Check if robber is on this tile - if so, no resources are distributed
          if (tile.hasRobber) {
            console.log(`Robber is blocking resources on tile ${tile.id}`);
            return; // Skip this tile
          }

          console.log(`Processing tile ${tile.id} (${tile.type}) for resource distribution`);

          // Find all settlements/cities adjacent to this tile and distribute resources
          if (game.gameState.players) {
            game.gameState.players.forEach(player => {
              // Log player's settlements and cities for debugging
              console.log(`Checking player ${player.name}'s buildings:`, {
                settlements: player.settlements ? player.settlements.length : 0,
                cities: player.cities ? player.cities.length : 0
              });

              // Check settlements
              if (player.settlements) {
                player.settlements.forEach(settlement => {
                  if (settlement.adjacentTiles) {
                    // Convert to string for comparison if needed
                    const tileIdStr = String(tile.id);
                    const includesTile = settlement.adjacentTiles.some(adjTile => {
                      return String(adjTile) === tileIdStr;
                    });

                    if (includesTile) {
                      const resourceType = resourceMap[tile.type];
                      if (resourceType) {
                        player.resources[resourceType] += 1;
                        console.log(`${player.name} received 1 ${resourceType} from settlement at ${settlement.vertexId} adjacent to ${tile.id}`);
                      }
                    }
                  }
                });
              }

              // Check cities
              if (player.cities) {
                player.cities.forEach(city => {
                  if (city.adjacentTiles) {
                    // Convert to string for comparison if needed
                    const tileIdStr = String(tile.id);
                    const includesTile = city.adjacentTiles.some(adjTile => {
                      return String(adjTile) === tileIdStr;
                    });

                    if (includesTile) {
                      const resourceType = resourceMap[tile.type];
                      if (resourceType) {
                        player.resources[resourceType] += 2;
                        console.log(`${player.name} received 2 ${resourceType} from city at ${city.vertexId} adjacent to ${tile.id}`);
                      }
                    }
                  }
                });
              }
            });
          }
        }
      });
    });

    // Log all player resources after distribution
    if (game.gameState && game.gameState.players) {
      console.log('Player resources after distribution:');
      game.gameState.players.forEach(player => {
        console.log(`${player.name}:`, player.resources);
      });
    }
  }

  //Helper function to deduct resources from player
  function deductResources(player, buildingType) {

    if (!player || !BUILDING_COSTS[buildingType]) return false;

    Object.entries(BUILDING_COSTS[buildingType]).forEach(([resource, amount]) => {
      player.resources[resource] -= amount;
    });

    console.log(`Deducted resources from ${player.name} for building ${buildingType}:`, player.resources);
    return true;
  }

  socket.on('build-settlement', (data) => {
    const { vertexId, adjacentTiles } = data;
    const playerInfo = playerSockets.get(socket.id);
    if (!playerInfo) return;

    const game = games.get(playerInfo.gameId);
    if (!game || game.status !== 'playing') return;

    // Find player in game state
    const player = game.gameState.players.find(p => p.name === playerInfo.playerName);
    if (player) {
      // Initialize settlements array if it doesn't exist
      if (!player.settlements) {
        player.settlements = [];
      }

      // Add settlement to player's settlements
      player.settlements.push({
        vertexId,
        adjacentTiles: adjacentTiles || [] // Use provided adjacentTiles or empty array
      });

      if (!game.gameState.gamePhase === 'setup' && !game.gameState.gamePhase === 'SETUP') {
        deductResources(player, 'SETTLEMENT');
      }

      // Update player points (cities = 2 points, settlements = 1 point)
      player.points = (player.settlements ? player.settlements.length : 0) + 
                     (player.cities ? player.cities.length * 2 : 0);

      console.log(`Added settlement for ${playerInfo.playerName} at ${vertexId} with adjacent tiles:`, adjacentTiles || []);
      console.log(`Updated ${playerInfo.playerName} points to ${player.points} (${player.settlements?.length || 0} settlements, ${player.cities?.length || 0} cities)`);

      // If this is the second settlement in setup phase, distribute initial resources
      // Check for both 'setup' and 'SETUP' due to case sensitivity
      if ((game.gameState.gamePhase === 'setup' || game.gameState.gamePhase === 'SETUP') && player.settlements.length === 2) {
        // Get the latest settlement (the one just built)
        const settlement = player.settlements[player.settlements.length - 1];

        console.log(`Processing initial resources for settlement at ${vertexId} with adjacentTiles:`, adjacentTiles);

        // Find all adjacent tiles and distribute one resource for each non-desert tile
        if (adjacentTiles && adjacentTiles.length > 0) {
          const resourceMap = {
            'forest': 'wood',
            'hill': 'brick',
            'pasture': 'wool',
            'field': 'grain',
            'mountain': 'ore'
          };

          // Store the adjacentTiles in the settlement object for future resource distribution
          settlement.adjacentTiles = adjacentTiles;

          // Find each tile in the game state and distribute resources
          adjacentTiles.forEach(tileId => {
            console.log(`Looking for tile ${tileId} in game state`);

            // Find the tile in the game state
            let tile = null;
            if (game.gameState.rowTiles) {
              game.gameState.rowTiles.forEach(row => {
                row.forEach(t => {
                  if (t.id === tileId) {
                    tile = t;
                    console.log(`Found tile ${tileId} with type ${t.type}`);
                  }
                });
              });
            }

            if (tile && tile.type !== 'desert') {
              const resourceType = resourceMap[tile.type];
              if (resourceType) {
                player.resources[resourceType] += 1;
                console.log(`${playerInfo.playerName} received 1 ${resourceType} from initial settlement at ${vertexId} adjacent to ${tileId}`);
              }
            } else {
              console.log(`Could not find tile ${tileId} or it was a desert`);
            }
          });
        }
      }
    }


    // Broadcast settlement built to all players
    io.to(playerInfo.gameId).emit('settlement-built', {
      playerName: playerInfo.playerName,
      vertexId,
      adjacentTiles,
      playerResources: game.gameState.players,
      timestamp: Date.now()
    });

    console.log(`${playerInfo.playerName} built settlement at ${vertexId}`);
  });

  socket.on('build-city', (data) => {
    const { vertexId, adjacentTiles } = data;
    const playerInfo = playerSockets.get(socket.id);
    if (!playerInfo) return;

    const game = games.get(playerInfo.gameId);
    if (!game || game.status !== 'playing') return;

    console.log(`Building city at ${vertexId} with adjacentTiles:`, adjacentTiles);

    // Get adjacentTiles from the settlement if not provided
    let cityAdjacentTiles = adjacentTiles || [];
    
    // Find player in game state
    const player = game.gameState.players.find(p => p.name === playerInfo.playerName);
    if (player) {
      // Initialize cities array if it doesn't exist
      if (!player.cities) {
        player.cities = [];
      }

      // Get adjacentTiles from existing settlement if not provided
      if (!cityAdjacentTiles.length && player.settlements) {
        const settlement = player.settlements.find(s => s.vertexId === vertexId);
        if (settlement && settlement.adjacentTiles) {
          cityAdjacentTiles = settlement.adjacentTiles;
          console.log(`Using adjacentTiles from existing settlement:`, cityAdjacentTiles);
        }
      }

      // Add city to player's cities
      player.cities.push({
        vertexId,
        adjacentTiles: cityAdjacentTiles
      });

      // Remove the settlement that was upgraded to a city
      if (player.settlements) {
        const settlementIndex = player.settlements.findIndex(s => s.vertexId === vertexId);
        if (settlementIndex !== -1) {
          player.settlements.splice(settlementIndex, 1);
          console.log(`Removed settlement at ${vertexId} for ${playerInfo.playerName} (upgraded to city)`);
        }
      }

      // Update player points (cities = 2 points, settlements = 1 point)
      player.points = (player.settlements ? player.settlements.length : 0) + 
                     (player.cities ? player.cities.length * 2 : 0);
      
      console.log(`Updated ${playerInfo.playerName} points to ${player.points} (${player.settlements?.length || 0} settlements, ${player.cities?.length || 0} cities)`);
      console.log(`Added city for ${playerInfo.playerName} at ${vertexId} with adjacent tiles:`, cityAdjacentTiles);
      
      // Deduct resources after successful city building
      deductResources(player, 'CITY');


      // Broadcast city built to all players with updated player data
      io.to(playerInfo.gameId).emit('city-built', {
        playerName: playerInfo.playerName,
        vertexId,
        adjacentTiles: cityAdjacentTiles,
        playerResources: game.gameState.players,
        gameState: {
          players: game.gameState.players // Only send player data, not game phase info
        },
        timestamp: Date.now()
      });
    }

    console.log(`${playerInfo.playerName} built city at ${vertexId}`);
  });

  socket.on('build-road', (data) => {
    const { edgeId, gamePhase } = data;
    const playerInfo = playerSockets.get(socket.id);
    if (!playerInfo) return;

    const game = games.get(playerInfo.gameId);
    if (!game || game.status !== 'playing') return;

    // Find player in game state
    const player = game.gameState.players.find(p => p.name === playerInfo.playerName);
    if (player) {
      // Initialize roads array if it doesn't exist
      if (!player.roads) {
        player.roads = [];
      }

      // Add road to player's roads
      player.roads.push({
        edgeId
      });
      console.log("GamePhase", game.gameState.gamePhase);
      console.log("gamePhase", gamePhase);
      if (gamePhase === 'PLAY') {
        console.log(`Deducting resources for road built by ${playerInfo.playerName}`);
        deductResources(player, 'ROAD');
      }

      console.log(`Added road for ${playerInfo.playerName} at ${edgeId}`);
    }

    // Broadcast road built to all players
    io.to(playerInfo.gameId).emit('road-built', {
      playerName: playerInfo.playerName,
      edgeId,
      playerResources: game.gameState.players,
      timestamp: Date.now()
    });

    console.log(`${playerInfo.playerName} built road at ${edgeId}`);
  });

  socket.on('move-robber', (data) => {
    const { tileId, targetPlayerId } = data;
    const playerInfo = playerSockets.get(socket.id);
    if (!playerInfo) return;

    const game = games.get(playerInfo.gameId);
    if (!game || game.status !== 'playing') return;

    let stolenResource = null;
    let targetPlayerName = null;

    console.log(`Received move-robber from ${playerInfo.playerName} with tileId: ${tileId}, targetPlayerId: ${targetPlayerId}`);

    // Update robber position in game state
    if (game.gameState) {
      // Find old robber position and remove it
      game.gameState.rowTiles.forEach(row => {
        row.forEach(tile => {
          if (tile.hasRobber) {
            tile.hasRobber = false;
          }
        });
      });

      // Set new robber position
      game.gameState.rowTiles.forEach(row => {
        row.forEach(tile => {
          if (tile.id === tileId) {
            tile.hasRobber = true;
          }
        });
      });

      game.gameState.robberPosition = tileId;

      // Handle stealing if targetPlayerId is provided
      if (targetPlayerId) {
        // Find current player by name
        const currentPlayer = game.gameState.players.find(p => p.name === playerInfo.playerName);
        
        // Find target player by ID
        let targetPlayer = null;
        
        // Log all players and their IDs for debugging
        console.log('All players:', game.gameState.players.map(p => ({ name: p.name, id: p.id })));
        
        // First try to find by exact ID match
        targetPlayer = game.gameState.players.find(p => p.id === targetPlayerId);
        
        // If not found, try to find by ID as string
        if (!targetPlayer) {
          targetPlayer = game.gameState.players.find(p => p.id === String(targetPlayerId));
        }
        
        // If still not found and ID is numeric, try to find by index
        if (!targetPlayer && !isNaN(parseInt(targetPlayerId))) {
          const targetIndex = parseInt(targetPlayerId) - 1; // Adjust for 1-based indexing
          if (targetIndex >= 0 && targetIndex < game.gameState.players.length) {
            targetPlayer = game.gameState.players[targetIndex];
          }
        }

        console.log(`Attempting to steal: currentPlayer=${playerInfo.playerName}, targetPlayerId=${targetPlayerId}`);
        console.log('Available players:', game.gameState.players.map(p => ({ name: p.name, id: p.id })));

        // Make sure we're not stealing from ourselves
        if (currentPlayer && targetPlayer && currentPlayer.name !== targetPlayer.name) {
          targetPlayerName = targetPlayer.name;
          console.log(`Found target player: ${targetPlayerName}`);

          // Get all resources the target player has
          const availableResources = [];
          Object.entries(targetPlayer.resources).forEach(([resource, amount]) => {
            for (let i = 0; i < amount; i++) {
              availableResources.push(resource);
            }
          });

          console.log(`Target player ${targetPlayerName} has resources:`, targetPlayer.resources);
          console.log(`Available resources to steal:`, availableResources);

          if (availableResources.length > 0) {
            // Randomly select a resource to steal
            const randomIndex = Math.floor(Math.random() * availableResources.length);
            stolenResource = availableResources[randomIndex];

            console.log(`Selected resource to steal: ${stolenResource}`);

            // Transfer the resource
            if (targetPlayer.resources[stolenResource] > 0) {
              targetPlayer.resources[stolenResource] -= 1;
              currentPlayer.resources[stolenResource] = (currentPlayer.resources[stolenResource] || 0) + 1;
              
              console.log(`${playerInfo.playerName} stole ${stolenResource} from ${targetPlayer.name}`);
              console.log(`Updated player resources:`);
              game.gameState.players.forEach(player => {
                console.log(`${player.name}:`, player.resources);
              });
            }
          } else {
            console.log(`Target player ${targetPlayerName} has no resources to steal`);
          }
        } else if (currentPlayer && targetPlayer && currentPlayer.name === targetPlayer.name) {
          console.error(`Cannot steal from yourself: currentPlayer=${currentPlayer.name}, targetPlayer=${targetPlayer.name}`);
        } else {
          console.error(`Could not find current player or target player. currentPlayer=${!!currentPlayer}, targetPlayer=${!!targetPlayer}`);
        }
      } else {
        console.log('No targetPlayerId provided, skipping stealing phase');
      }
    }

    // Broadcast robber moved to all players with updated player resources
    const eventData = {
      playerName: playerInfo.playerName,
      tileId,
      targetPlayerId,
      targetPlayerName,
      stolenResource,
      playerResources: game.gameState.players, // Include updated player resources
      gameState: game.gameState,
      timestamp: Date.now()
    };
    
    console.log(`Broadcasting robber-moved event with data:`, {
      playerName: eventData.playerName,
      tileId: eventData.tileId,
      targetPlayerName: eventData.targetPlayerName,
      stolenResource: eventData.stolenResource
    });
    
    io.to(playerInfo.gameId).emit('robber-moved', eventData);

    console.log(`${playerInfo.playerName} moved robber to ${tileId}`);
  });

  socket.on('bank-trade', (data) => {
    const playerInfo = playerSockets.get(socket.id);
    if (!playerInfo) return;

    const game = games.get(playerInfo.gameId);
    if (!game || game.status !== 'playing') return;

    // Find the player in the game state
    const player = game.gameState.players.find(p => p.name === playerInfo.playerName);
    if (!player) {
      console.error(`Player ${playerInfo.playerName} not found in game state`);
      return;
    }

    // Extract trading data
    const { tradingAway, receiving } = data;
    
    console.log(`${playerInfo.playerName} trading with bank:`);
    console.log('Trading away:', tradingAway);
    console.log('Receiving:', receiving);
    console.log('Player resources before trade:', {...player.resources});

    // Update player resources in the backend
    try {
      // Deduct resources being traded away
      for (const [resource, amount] of Object.entries(tradingAway)) {
        if (amount > 0) {
          // Calculate trade ratio (simplified - in real game this would check ports)
          const ratio = 4; // Default bank trade ratio
          const requiredAmount = amount * ratio;
          
          // Check if player has enough resources
          if (player.resources[resource] < requiredAmount) {
            throw new Error(`Not enough ${resource}. Need ${requiredAmount}, have ${player.resources[resource]}`);
          }
          
          // Deduct resources
          player.resources[resource] -= requiredAmount;
        }
      }
      
      // Add resources being received
      for (const [resource, amount] of Object.entries(receiving)) {
        if (amount > 0) {
          player.resources[resource] = (player.resources[resource] || 0) + amount;
        }
      }
      
      console.log('Player resources after trade:', {...player.resources});
      
      // Broadcast bank trade to all players with updated player resources
      io.to(playerInfo.gameId).emit('bank-trade-completed', {
        playerName: playerInfo.playerName,
        tradeData: data,
        playerResources: game.gameState.players, // Include updated player resources
        timestamp: Date.now()
      });

      console.log(`${playerInfo.playerName} completed bank trade:`, data);
    } catch (error) {
      console.error(`Error processing bank trade for ${playerInfo.playerName}:`, error.message);
      // Send error back to the client
      socket.emit('action-error', {
        action: 'bank-trade',
        message: error.message
      });
    }
  });

  socket.on('discard-cards', (data) => {
    const playerInfo = playerSockets.get(socket.id);
    if (!playerInfo) return;

    const game = games.get(playerInfo.gameId);
    if (!game || game.status !== 'playing') return;

    // Broadcast cards discarded to all players
    io.to(playerInfo.gameId).emit('cards-discarded', {
      playerName: playerInfo.playerName,
      discardData: data,
      timestamp: Date.now()
    });

    console.log(`${playerInfo.playerName} discarded cards:`, data);
  });

  // Rolling 7 specific handlers
  socket.on('start-discard-phase', (data) => {
    const { playersNeedingToDiscard } = data;
    const playerInfo = playerSockets.get(socket.id);
    if (!playerInfo) return;

    const game = games.get(playerInfo.gameId);
    if (!game || game.status !== 'playing') return;

    // Initialize discard phase tracking
    if (!game.discardPhase) {
      game.discardPhase = {
        active: true,
        playersNeedingToDiscard: [...playersNeedingToDiscard],
        playersCompleted: [],
        rollerName: playerInfo.playerName
      };
    }

    // Log all player resources for debugging
    if (game.gameState && game.gameState.players) {
      game.gameState.players.forEach(player => {
        console.log(`Player ${player.name} resources:`, player.resources);
      });
    }

    // Broadcast discard phase started to all players with current resource state
    io.to(playerInfo.gameId).emit('discard-phase-started', {
      playersNeedingToDiscard,
      rollerName: playerInfo.playerName,
      playerResources: game.gameState.players,
      timestamp: Date.now()
    });

    console.log(`Discard phase started by ${playerInfo.playerName}. Players needing to discard:`, playersNeedingToDiscard);
  });

  socket.on('complete-discard', (data) => {
    const { discardedResources } = data;
    const playerInfo = playerSockets.get(socket.id);
    if (!playerInfo) return;

    const game = games.get(playerInfo.gameId);
    if (!game || game.status !== 'playing' || !game.discardPhase) return;

    // Find the player in game state and validate discard
    const player = game.gameState.players.find(p => p.name === playerInfo.playerName);
    if (!player) return;

    // Log player resources before validation for debugging
    console.log(`Player ${playerInfo.playerName} resources before discard:`, player.resources);
    console.log(`Attempting to discard:`, discardedResources);

    // Validate that player has enough resources to discard
    for (const [resource, amount] of Object.entries(discardedResources)) {
      if (player.resources[resource] < amount) {
        console.error(`Invalid discard: ${playerInfo.playerName} doesn't have enough ${resource} (has ${player.resources[resource]}, trying to discard ${amount})`);

        // Send error back to client
        socket.emit('action-error', {
          action: 'complete-discard',
          message: `You don't have enough ${resource} to discard. Please refresh and try again.`,
          timestamp: Date.now()
        });
        return;
      }
    }

    // Calculate expected discard amount
    const totalResources = Object.values(player.resources).reduce((sum, amount) => sum + amount, 0);
    const expectedDiscard = Math.floor(totalResources / 2);
    const actualDiscard = Object.values(discardedResources).reduce((sum, amount) => sum + amount, 0);

    if (actualDiscard !== expectedDiscard) {
      console.error(`Invalid discard amount: ${playerInfo.playerName} must discard ${expectedDiscard} but tried to discard ${actualDiscard}`);

      // Send error back to client
      socket.emit('action-error', {
        action: 'complete-discard',
        message: `You must discard exactly ${expectedDiscard} resources. Please try again.`,
        timestamp: Date.now()
      });
      return;
    }

    // Perform the discard on backend game state
    for (const [resource, amount] of Object.entries(discardedResources)) {
      player.resources[resource] -= amount;
      // Ensure no negative resources
      if (player.resources[resource] < 0) {
        player.resources[resource] = 0;
      }
    }

    // Log player resources after discard for debugging
    console.log(`Player ${playerInfo.playerName} resources after discard:`, player.resources);

    // Add player to completed list
    if (!game.discardPhase.playersCompleted.includes(playerInfo.playerName)) {
      game.discardPhase.playersCompleted.push(playerInfo.playerName);
    }

    // Broadcast player discarded to all players with updated player resources
    io.to(playerInfo.gameId).emit('player-discarded', {
      playerName: playerInfo.playerName,
      discardedResources,
      playerResources: game.gameState.players, // Include updated player resources
      timestamp: Date.now()
    });

    console.log(`${playerInfo.playerName} completed discard:`, discardedResources);

    // Check if all players have completed discarding
    const allPlayersCompleted = game.discardPhase.playersNeedingToDiscard.every(playerName =>
      game.discardPhase.playersCompleted.includes(playerName)
    );

    if (allPlayersCompleted) {
      // Broadcast discard phase complete with updated player resources
      io.to(playerInfo.gameId).emit('discard-phase-complete', {
        rollerName: game.discardPhase.rollerName,
        playerResources: game.gameState.players, // Include updated player resources
        timestamp: Date.now()
      });

      // Store roller name before cleanup
      const rollerName = game.discardPhase.rollerName;

      // Clean up discard phase
      delete game.discardPhase;

      console.log(`Discard phase complete. ${rollerName} can now move robber.`);
    }
  });

  socket.on('end-turn', (setupPhase) => {
    const playerInfo = playerSockets.get(socket.id);
    if (!playerInfo) return;

    const game = games.get(playerInfo.gameId);
    if (!game || game.status !== 'playing') return;

    // Broadcast turn ended to all players
    io.to(playerInfo.gameId).emit('turn-ended', {
      playerName: playerInfo.playerName,
      timestamp: Date.now()
    });

    console.log(`${playerInfo.playerName} ended their turn`);
  });

  // Handle disconnect
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    handlePlayerLeave(socket);
  });
});

// Helper functions
function generateGameId() {
  return 'GAME' + Math.random().toString(36).substr(2, 6).toUpperCase();
}

function handlePlayerLeave(socket) {
  const playerInfo = playerSockets.get(socket.id);
  if (!playerInfo) return;

  const game = games.get(playerInfo.gameId);
  if (!game) return;

  // Remove player from game
  game.players = game.players.filter(p => p.socketId !== socket.id);

  if (game.players.length === 0 || playerInfo.isHost) {
    // If host leaves or no players left, delete the game
    games.delete(playerInfo.gameId);
    console.log(`Game ${playerInfo.gameId} deleted`);
  } else {
    // If not host, just remove player and notify others
    io.to(playerInfo.gameId).emit('player-left', {
      playerName: playerInfo.playerName,
      players: game.players.map(p => p.name),
      gameData: game
    });
  }

  playerSockets.delete(socket.id);
  broadcastGamesList();
}

function broadcastGamesList() {
  const availableGames = Array.from(games.values())
    .filter(game => game.status === 'waiting')
    .map(game => ({
      id: game.id,
      host: game.host,
      players: game.players.map(p => p.name),
      maxPlayers: game.maxPlayers,
      status: game.status,
      created: game.created
    }));

  io.emit('games-list', availableGames);
}

function initializeGameStateTracking(game) {
  // Initialize extended game state for multiplayer tracking
  if (!game.gameState.players) {
    game.gameState.players = game.players.map((player, index) => ({
      id: String(index + 1), // Add numeric ID as string for each player, starting from 1 to match frontend
      name: player.name,
      resources: { wood: 0, brick: 0, wool: 0, grain: 0, ore: 0 },
      settlements: [],
      cities: [],
      roads: [],
      points: 0,
      developmentCards: []
    }));
    
    console.log('Initialized player IDs:', game.gameState.players.map(p => ({ name: p.name, id: p.id })));
  }

  if (!game.gameState.currentPlayerIndex) {
    game.gameState.currentPlayerIndex = 0;
  }

  if (!game.gameState.gamePhase) {
    game.gameState.gamePhase = 'setup'; // setup, playing, ended
  }

  console.log('Game state tracking initialized for game:', game.id);
}

// Catch-all handler: send back React's index.html file for any non-API routes
app.use((req, res, next) => {
  // Only handle GET requests
  if (req.method !== 'GET') {
    return next();
  }
  
  // Don't serve index.html for API routes
  if (req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) {
    return res.status(404).json({ error: 'API endpoint not found' });
  }
  
  // Check if the request is for a static file that doesn't exist
  // If it's not a file request (no extension), serve index.html for React Router
  const hasExtension = path.extname(req.path) !== '';
  if (hasExtension) {
    // Let static middleware handle it, if it fails, return 404
    return res.status(404).json({ error: 'File not found' });
  }
  
  // Serve index.html for all other routes (React Router will handle them)
  const indexPath = path.join(__dirname, '../public/index.html');
  res.sendFile(indexPath, (err) => {
    if (err) {
      console.error('Error serving index.html:', err);
      res.status(500).json({ error: 'Failed to serve application' });
    }
  });
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Frontend served from: ${path.join(__dirname, '../public')}`);
});
