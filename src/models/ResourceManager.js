const { BUILDING_COSTS } = require('../utils/gameConstants');

class ResourceManager {
    constructor() {
        this.playerResources = new Map();
    }

    initializePlayer(playerId) {
        this.playerResources.set(playerId, {
            wood: 0,
            brick: 0,
            wool: 0,
            grain: 0,
            ore: 0
        });
    }

    addResources(playerId, resources) {
        const currentResources = this.playerResources.get(playerId);
        if (!currentResources) return false;

        Object.entries(resources).forEach(([resource, amount]) => {
            currentResources[resource] = (currentResources[resource] || 0) + amount;
        });

        return true;
    }

    deductResources(playerId, resources) {
        const currentResources = this.playerResources.get(playerId);
        if (!currentResources) return false;

        // Check if player has enough resources
        if (!this.hasEnoughResources(playerId, resources)) {
            return false;
        }

        // Deduct resources
        Object.entries(resources).forEach(([resource, amount]) => {
            currentResources[resource] -= amount;
        });

        return true;
    }

    hasEnoughResources(playerId, resources) {
        const currentResources = this.playerResources.get(playerId);
        if (!currentResources) return false;

        return Object.entries(resources).every(([resource, amount]) => 
            (currentResources[resource] || 0) >= amount
        );
    }

    canAffordBuilding(playerId, buildingType) {
        const cost = BUILDING_COSTS[buildingType];
        if (!cost) return false;
        
        return this.hasEnoughResources(playerId, cost);
    }

    getPlayerResources(playerId) {
        return this.playerResources.get(playerId) || null;
    }
}

module.exports = ResourceManager;
