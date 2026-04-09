export class AppError extends Error {
    status;
    constructor(message, status = 500) {
        super(message);
        this.status = status;
    }
}
