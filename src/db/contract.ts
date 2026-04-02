export type DBContract = {
  runQuery: (query: string, params?: any[]) => Promise<any>;
};
