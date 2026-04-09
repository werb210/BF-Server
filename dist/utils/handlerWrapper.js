export const wrap = (fn) => {
    return (...args) => fn(...args);
};
