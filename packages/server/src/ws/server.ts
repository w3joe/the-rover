import { WebSocketServer, type WebSocket } from 'ws'
import type { WSClientMessage, WSMessage } from '@mars/shared'

const clients = new Set<WebSocket>()

export function createWSServer(port: number): {
  broadcast: (msg: WSMessage) => void
  onClientMessage: (handler: (msg: WSClientMessage) => Promise<void>) => void
  onClientConnect: (handler: (send: (msg: WSMessage) => void) => void) => void
} {
  const wss = new WebSocketServer({ port })
  let messageHandler: ((msg: WSClientMessage) => Promise<void>) | null = null
  let connectHandler: ((send: (msg: WSMessage) => void) => void) | null = null

  wss.on('connection', (ws) => {
    clients.add(ws)
    const sendOne = (msg: WSMessage) => ws.send(JSON.stringify(msg))
    sendOne({ type: 'server_ready' })
    connectHandler?.(sendOne)

    ws.on('message', async (data) => {
      try {
        const msg = JSON.parse(data.toString()) as WSClientMessage
        if (messageHandler) await messageHandler(msg)
      } catch { /* ignore parse errors */ }
    })
    ws.on('close', () => clients.delete(ws))
    ws.on('error', () => clients.delete(ws))
  })

  wss.on('listening', () => {
    console.log(`WS telemetry on ws://localhost:${port}`)
  })

  function broadcast(msg: WSMessage): void {
    const data = JSON.stringify(msg)
    for (const ws of clients) {
      if (ws.readyState === ws.OPEN) ws.send(data)
    }
  }

  function onClientMessage(handler: (msg: WSClientMessage) => Promise<void>): void {
    messageHandler = handler
  }

  function onClientConnect(handler: (send: (msg: WSMessage) => void) => void): void {
    connectHandler = handler
  }

  return { broadcast, onClientMessage, onClientConnect }
}
