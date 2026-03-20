import { createServer } from '../server/createServer'

export const getTestApp = async () => {
  const app = await createServer({
    config: {
      skipEnvCheck: true,
      skipWarmup: true,
      skipSchemaCheck: true,
      skipSeed: true,
      skipCorsCheck: true,
      skipServicesInit: true,
      startFollowUpJobs: false,
    },
  })

  if (!app) {
    throw new Error('App is undefined — check server export')
  }

  return app
}
