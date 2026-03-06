type Handler = (payload: any) => void

const listeners: Record<string, Handler[]> = {}

export const eventBus = {
  emit(event: string, payload: any) {
    if (!listeners[event]) return
    for (const h of listeners[event]) h(payload)
  },
  on(event: string, handler: Handler) {
    if (!listeners[event]) listeners[event] = []
    listeners[event].push(handler)
  },
}

export function emit(event: string, payload: any) {
  eventBus.emit(event, payload)
}

export function on(event: string, handler: Handler) {
  eventBus.on(event, handler)
}
