export const resolveConfiguredModelIds = (selectedModels, models) => {
    const availableModels = new Set(
        Object.values(models || {}).flatMap(providerModels => Object.keys(providerModels))
    );
    return [...new Set(selectedModels || [])].filter(modelId => availableModels.has(modelId));
};

export const hasValidMultiModelSelection = (selectedModels, models) =>
    resolveConfiguredModelIds(selectedModels, models).length >= 2;

export const findFirstAvailableModel = (models, excludedModel = null) => {
    for (const providerModels of Object.values(models || {})) {
        const modelId = Object.keys(providerModels).find(id => id !== excludedModel);
        if (modelId) return modelId;
    }
    return null;
};
