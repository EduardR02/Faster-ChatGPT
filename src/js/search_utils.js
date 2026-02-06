export const normaliseForSearch = (input, { collapseWhitespace = true } = {}) => {
    if (!input) return '';

    const normalized = input
        .toLowerCase()
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .replace(/[\u0000-\u001f]+/g, ' ');

    if (!collapseWhitespace) {
        return normalized.trim();
    }

    return normalized
        .replace(/\s+/g, ' ')
        .trim();
};
