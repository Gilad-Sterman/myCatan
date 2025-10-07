// Building costs for different structures
export const BUILDING_COSTS = {
    SETTLEMENT: {
        wood: 1,
        brick: 1,
        wool: 1,
        grain: 1
    },
    CITY: {
        grain: 2,
        ore: 3
    },
    ROAD: {
        wood: 1,
        brick: 1
    },
    DevelopmentCard: {
        ore: 1,
        grain: 1,
        wool: 1,
    }
};

// Building rules
export const BUILDING_RULES = {
    SETTLEMENT: {
        minDistanceFromSettlement: 2, // Number of vertices away from another settlement
        requiresConnectedRoad: true, // Must be connected to player's road (except during setup)
        maxPerPlayer: 5 // Maximum number of settlements per player
    },
    CITY: {
        requiresSettlement: true, // Must upgrade from settlement
        maxPerPlayer: 4 // Maximum number of cities per player
    },
    ROAD: {
        requiresConnection: true, // Must connect to existing settlement/city/road
        maxPerPlayer: 15 // Maximum number of roads per player
    }
};
