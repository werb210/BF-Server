import { vi } from 'vitest'
import { newDb } from 'pg-mem'

// Create in-memory postgres
const db = newDb()

// Basic pool-compatible interface
export const pool = {
  query: async (text?: string, _params?: any[]) => {
    try {
      const result = db.public.query(text || '') as any
      return {
        rows: result.rows || [],
        rowCount: result.rowCount || 0,
      }
    } catch {
      return { rows: [], rowCount: 0 }
    }
  },
  connect: async () => ({
    query: async (text?: string, _params?: any[]) => {
      try {
        const result = db.public.query(text || '') as any
        return {
          rows: result.rows || [],
          rowCount: result.rowCount || 0,
        }
      } catch {
        return { rows: [], rowCount: 0 }
      }
    },
    release: () => {},
  }),
}

// Mock the actual DB module
vi.mock('../db', async () => {
  return {
    pool,
  }
})

console.log('[DB MOCK LOADED]')
