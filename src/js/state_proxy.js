const resolveState = (stateOrResolver) => {
    if (typeof stateOrResolver === 'function') {
        return stateOrResolver();
    }
    return stateOrResolver;
};

const bindValue = (value, context) => {
    return typeof value === 'function' ? value.bind(context) : value;
};

export const createStateProxy = (tabState, globalState, fallbackState = null) => {
    return new Proxy(globalState, {
        get: (_, prop) => {
            const activeTabState = resolveState(tabState) || fallbackState;

            if (activeTabState && prop in activeTabState) {
                return bindValue(activeTabState[prop], activeTabState);
            }

            if (prop in globalState) {
                return bindValue(globalState[prop], globalState);
            }

            return undefined;
        },

        set: (_, prop, value) => {
            const activeTabState = resolveState(tabState);

            if (activeTabState && prop in activeTabState) {
                activeTabState[prop] = value;
                return true;
            }

            if (prop in globalState) {
                globalState[prop] = value;
                return true;
            }

            if (activeTabState) {
                activeTabState[prop] = value;
            } else {
                globalState[prop] = value;
            }
            return true;
        }
    });
};
