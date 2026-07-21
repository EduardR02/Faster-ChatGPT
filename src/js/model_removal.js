const listModels = (models) => Object.entries(models || {}).flatMap(([provider, providerModels]) =>
    Object.entries(providerModels).map(([apiName, displayName]) => ({ provider, apiName, displayName }))
);

const resolveEnteredModel = (models, displayName, apiName) => {
    const fields = [
        [displayName, model => model.displayName],
        [apiName, model => model.apiName]
    ].filter(([value]) => value);
    let bestScore = -1;
    let matches = [];

    for (const model of listModels(models)) {
        let score = 0;
        let isMatch = true;

        for (const [value, readField] of fields) {
            const storedValue = readField(model);
            if (storedValue.toLocaleLowerCase() !== value.toLocaleLowerCase()) {
                isMatch = false;
                break;
            }
            if (storedValue === value) score++;
        }

        if (!isMatch || score < bestScore) continue;
        if (score > bestScore) {
            bestScore = score;
            matches = [model];
        } else {
            matches.push(model);
        }
    }

    return matches.length === 1 ? matches[0] : null;
};

export const resolveModelRemoval = ({ models, displayName, apiName, mode, selectedModelIds }) => {
    if (displayName || apiName) return resolveEnteredModel(models, displayName, apiName);
    if (mode !== 'normal' || selectedModelIds.length !== 1) return null;

    const selectedId = selectedModelIds[0];
    const matches = listModels(models).filter(model => model.apiName === selectedId);
    return matches.length === 1 ? matches[0] : null;
};
