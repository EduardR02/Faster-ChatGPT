import { createElementWithClass } from './ui_utils.js';

/**
 * Read-only arena leaderboard: aggregates the stored match history and Elo
 * cache into ranked rows and renders them. All writes stay in
 * ArenaRatingManager; this module only reads.
 */

// Results that affect Elo (mirrors ArenaRatingManager.calculateElo).
// 'reveal', 'ignored' and 'draw(bothbad)' still establish that a model
// participated, but don't count toward the W-D-L record.
const RATED_RESULTS = new Set(['model_a', 'model_b', 'draw']);

const INITIAL_RATING = 1000;

/**
 * Flattens the `models` setting ({ provider: { apiName: displayName } })
 * into { apiName: displayName }.
 */
export const resolveDisplayNames = (modelsSetting = {}) => {
    const names = {};
    Object.values(modelsSetting).forEach(providerMap => {
        Object.entries(providerMap || {}).forEach(([apiName, displayName]) => {
            names[apiName] = displayName;
        });
    });
    return names;
};

/**
 * Aggregates match history and the Elo cache into sorted leaderboard entries.
 * Models appear if they have any stored matches or a cached rating, so a
 * model with only unrated matches still shows up with a 0-0-0 record.
 */
export const computeLeaderboard = (matches = [], ratings = {}) => {
    const stats = new Map();
    const entryFor = (modelId) => {
        let entry = stats.get(modelId);
        if (!entry) {
            entry = { modelId, rating: INITIAL_RATING, matches: 0, wins: 0, draws: 0, losses: 0 };
            stats.set(modelId, entry);
        }
        return entry;
    };

    matches.forEach(({ model_a: modelA, model_b: modelB, result }) => {
        const a = entryFor(modelA);
        const b = entryFor(modelB);
        if (!RATED_RESULTS.has(result)) return;
        a.matches++;
        b.matches++;
        if (result === 'draw') {
            a.draws++;
            b.draws++;
        } else if (result === 'model_a') {
            a.wins++;
            b.losses++;
        } else {
            a.losses++;
            b.wins++;
        }
    });

    Object.entries(ratings).forEach(([modelId, data]) => {
        const entry = entryFor(modelId);
        if (typeof data?.rating === 'number') entry.rating = data.rating;
    });

    return [...stats.values()].sort((x, y) =>
        y.rating - x.rating || y.matches - x.matches || x.modelId.localeCompare(y.modelId)
    );
};

const formatRating = (rating) => Math.round(rating * 10) / 10;

const formatWinRate = ({ wins, draws, matches }) =>
    matches === 0 ? '—' : `${Math.round(((wins + draws / 2) / matches) * 100)}%`;

const HEADERS = ['#', 'Model', 'Elo', 'Matches', 'W-D-L', 'Win%'];

export const renderLeaderboard = (container, entries, displayNames = {}) => {
    container.replaceChildren();

    if (entries.length === 0) {
        container.dataset.state = 'empty';
        container.appendChild(createElementWithClass('div', 'arena-leaderboard-empty', 'No arena matches yet.'));
        return;
    }

    container.dataset.state = 'populated';
    const table = createElementWithClass('table', 'arena-leaderboard-table');

    const headRow = document.createElement('tr');
    HEADERS.forEach(label => headRow.appendChild(createElementWithClass('th', null, label)));
    const thead = document.createElement('thead');
    thead.appendChild(headRow);
    table.appendChild(thead);

    const tbody = document.createElement('tbody');
    entries.forEach((entry, index) => {
        const row = document.createElement('tr');
        row.appendChild(createElementWithClass('td', 'arena-leaderboard-rank', String(index + 1)));
        row.appendChild(createElementWithClass('td', 'arena-leaderboard-model', displayNames[entry.modelId] || entry.modelId));
        row.appendChild(createElementWithClass('td', 'arena-leaderboard-rating', String(formatRating(entry.rating))));
        row.appendChild(createElementWithClass('td', null, String(entry.matches)));
        row.appendChild(createElementWithClass('td', null, `${entry.wins}-${entry.draws}-${entry.losses}`));
        row.appendChild(createElementWithClass('td', null, formatWinRate(entry)));
        tbody.appendChild(row);
    });
    table.appendChild(tbody);

    container.appendChild(table);
};

export const renderLeaderboardError = (container) => {
    container.replaceChildren(createElementWithClass(
        'div',
        'arena-leaderboard-empty',
        'Could not load arena leaderboard.'
    ));
    container.dataset.state = 'error';
};
