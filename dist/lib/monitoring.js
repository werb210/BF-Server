export function initMonitoring(connectionString) {
    return {
        setup: () => {
            console.log('Monitoring initialized', connectionString || 'none');
        },
    };
}
