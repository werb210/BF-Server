export function initMonitoring(connectionString?: string) {
  return {
    setup: () => {
      console.log('Monitoring initialized', connectionString || 'none');
    },
  };
}
