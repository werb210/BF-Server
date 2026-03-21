import { randomUUID } from 'crypto'
import { Request, Response, NextFunction } from 'express'

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const requestId = req.headers['x-request-id'] || randomUUID()

  ;(req as any).requestId = requestId
  res.setHeader('x-request-id', requestId)

  // REQUIRED FOR TESTS
  console.log('request_started')

  res.on('finish', () => {
    console.log('request_completed')
  })

  next()
}
