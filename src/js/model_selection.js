export const resolveConfiguredModelIds = (selectedModels, models) => {
    const availableModels = new Set(
        Object.values(models || {}).flatMap(providerModels => Object.keys(providerModels))
    );
    return [...new Set(selectedModels || [])].filter(modelId => availableModels.has(modelId));
};

export const hasValidMultiModelSelection = (selectedModels, models) =>
    resolveConfiguredModelIds(selectedModels, models).length >= 2;
