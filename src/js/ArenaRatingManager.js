/**
 * Manages the Elo rating system for Arena matches.
 */
export class ArenaRatingManager {
    constructor(dbName = "MatchesDB", storeName = "matches", cacheKey = "elo_ratings") {
        Object.assign(this, { 
            dbName, 
            storeName, 
            cacheKey, 
            db: null, 
            cachedRatings: {},
            ratingsWrite: Promise.resolve(),
            pendingWrite: Promise.resolve(),
            lockName: `arena-ratings:${dbName}:${storeName}:${cacheKey}`
        });
    }

    withWriteLock(callback) {
        return navigator.locks.request(this.lockName, callback);
    }

    async initDB() {
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(this.dbName, 1);

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(this.storeName)) {
                    db.createObjectStore(this.storeName, { 
                        keyPath: "id", 
                        autoIncrement: true 
                    });
                }
            };

            request.onsuccess = (event) => {
                this.db = event.target.result;
                this.loadRatings().then(() => resolve(this.db));
            };

            request.onerror = (event) => reject(event.target.errorCode);
        });
    }

    /**
     * Saves a match result to the database.
     */
    async saveMatch(modelA, modelB, result) {
        const validResults = ["model_a", "model_b", "draw", "draw(bothbad)"];
        if (!validResults.includes(result)) {
            throw new Error(`Attempted to save invalid result: ${result}`);
        }

        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], "readwrite");
            const store = transaction.objectStore(this.storeName);
            
            const matchData = { 
                model_a: modelA, 
                model_b: modelB, 
                result: result, 
                timestamp: Date.now() 
            };
            
            store.add(matchData);
            transaction.oncomplete = () => resolve();
            transaction.onerror = () => reject(transaction.error);
            transaction.onabort = () => reject(transaction.error);
        });
    }

    /**
     * Retrieves all match history.
     */
    async getHistory() {
        return new Promise((resolve, reject) => {
            const transaction = this.db.transaction([this.storeName], "readonly");
            const store = transaction.objectStore(this.storeName);
            
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    /**
     * Updates Elo ratings based on a batch of matches.
     */
    calculateElo(matches, K_FACTOR = 40, SCALE = 400, BASE = 10, INITIAL_RATING = 1000) {
        const ratings = this.normalizeRatings({ ...this.cachedRatings }, INITIAL_RATING);

        matches.forEach(match => {
            const { model_a: modelA, model_b: modelB, result: matchWinner } = match;
            
            // Initialize new models
            [modelA, modelB].forEach(modelId => {
                if (!ratings[modelId]) ratings[modelId] = { rating: INITIAL_RATING, count: 0 };
            });

            if (["draw(bothbad)", "ignored", "reveal"].includes(matchWinner)) return;

            let scoreA;
            switch (matchWinner) {
                case "model_a":
                    scoreA = 1;
                    break;
                case "model_b":
                    scoreA = 0;
                    break;
                case "draw":
                    scoreA = 0.5;
                    break;
                default:
                    throw new Error(`Unexpected result: ${matchWinner}`);
            }
            
            const ratingA = ratings[modelA].rating;
            const ratingB = ratings[modelB].rating;

            // Probability of A winning
            const expectedA = 1 / (1 + Math.pow(BASE, (ratingB - ratingA) / SCALE));
            
            // Dynamic K-factor (lower K for established models)
            const kFactorA = ratings[modelA].count >= 30 ? 20 : K_FACTOR;
            const kFactorB = ratings[modelB].count >= 30 ? 20 : K_FACTOR;

            ratings[modelA].rating += kFactorA * (scoreA - expectedA);
            ratings[modelB].rating += kFactorB * ((1 - scoreA) - (1 - expectedA));

            ratings[modelA].count++;
            ratings[modelB].count++;
        });

        this.cachedRatings = ratings;
        this.pendingWrite = chrome.storage.local.set({ [this.cacheKey]: ratings });
        // The ordering promise must never reject: the triggering operation observes
        // write failures via pendingWrite, but a rejected write must not poison
        // later add/recalculate/wipe calls awaiting ratingsWrite.
        this.ratingsWrite = this.pendingWrite.catch(error => {
            console.error('Failed to persist arena ratings:', error);
        });
        return ratings;
    }

    async loadRatings() {
        const storedRatingsResult = await new Promise(resolve => chrome.storage.local.get([this.cacheKey], resolve));
        const raw = storedRatingsResult[this.cacheKey] || {};
        this.cachedRatings = this.normalizeRatings(raw);
        return this.cachedRatings;
    }

    normalizeRatings(ratings, defaultRating = 1000) {
        Object.values(ratings).forEach(entry => {
            if (!entry || typeof entry !== 'object') return;
            if (typeof entry.rating !== 'number') entry.rating = defaultRating;
            if (typeof entry.count !== 'number') {
                entry.count = typeof entry.matches_count === 'number' ? entry.matches_count : 0;
            }
        });
        return ratings;
    }

    async addMatchAndUpdate(modelA, modelB, result) {
        return this.withWriteLock(async () => {
            await this.ratingsWrite;
            await this.saveMatch(modelA, modelB, result);
            await this.loadRatings();
            const ratings = this.calculateElo([{ model_a: modelA, model_b: modelB, result }]);
            await this.pendingWrite;
            return ratings;
        });
    }

    getModelRating(modelId) {
        return this.cachedRatings[modelId]?.rating || 1000;
    }

    async recalculate() {
        return this.withWriteLock(async () => {
            await this.ratingsWrite;
            const matchHistory = await this.getHistory();
            this.cachedRatings = {};
            const ratings = this.calculateElo(matchHistory);
            await this.pendingWrite;
            return ratings;
        });
    }

    async wipe() {
        return this.withWriteLock(async () => {
            await this.ratingsWrite;
            await chrome.storage.local.remove(this.cacheKey);

            await new Promise((resolve, reject) => {
                const transaction = this.db.transaction([this.storeName], "readwrite");
                transaction.objectStore(this.storeName).clear();
                transaction.oncomplete = () => resolve();
                transaction.onerror = () => reject(transaction.error);
                transaction.onabort = () => reject(transaction.error);
            });

            this.cachedRatings = {};
        });
    }
}
