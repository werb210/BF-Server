export const appInsights = {
    trackRequest: (data) => {
        console.log('trackRequest', data);
    },
    trackDependency: (data) => {
        console.log('trackDependency', data);
    },
    trackException: (data) => {
        console.log('trackException', data);
    },
};
