const store = new Map();
const OTP_TTL_MS = 10 * 60 * 1000;
const MAX_OTP_STORE_ITEMS = 1000;
export const otpStore = {
    set(phone, record) {
        store.set(phone, record);
        setTimeout(() => store.delete(phone), OTP_TTL_MS).unref();
        if (store.size > MAX_OTP_STORE_ITEMS) {
            const firstKey = store.keys().next().value;
            if (firstKey) {
                store.delete(firstKey);
            }
        }
    },
    get(phone) {
        return store.get(phone);
    },
    delete(phone) {
        store.delete(phone);
    },
    clear() {
        store.clear();
    },
};
