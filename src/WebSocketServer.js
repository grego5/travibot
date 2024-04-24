import { WebSocket, WebSocketServer as Server } from "ws";

export default class WebSocketServer {
  constructor(port) {
    const wss = new Server({ port });
    this.clients = wss.clients;
    this.routes = new Map();

    wss.on("connection", (ws) => {
      ws.isAlive = true;
      ws.nextPing = Math.floor(Date.now() / 1000) * 1000 + 30000;
      ws.on("message", (message) => {
        try {
          const { event, payload } = JSON.parse(message);
          const callback = this.routes.get(event);
          callback(payload, ws);
        } catch (error) {
          console.log("Unable to parse websocket message.", error.message);
        }
      });
      ws.on("pong", () => (ws.isAlive = true));
    });
  }

  ping = (now) => {
    this.clients.forEach((ws) => {
      if (ws.nextPing > now) return;
      if (ws.isAlive === false) return ws.terminate();
      ws.nextPing += 30000;
      ws.isAlive = false;
      ws.ping();
    });
  };

  setRoute = (event, callback) => {
    if (this.routes.has(event)) {
      console.log(`WebSocket event name ${event} already exist`);
    } else {
      this.routes.set(event, callback);
    }
  };

  send = (data) => {
    const now = Math.floor(Date.now() / 1000) * 1000;
    data.timestamp = now;

    this.clients.forEach((client) => {
      if (data.callback) {
        const payload = data.callback(client.headers);
        if (payload) data.payload = payload;
        delete data.callback;
      }
      const message = JSON.stringify(data);
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  };
}
