import WebSocket from "ws";

export default class WebSocketServer {
  constructor(port) {
    const wss = new WebSocket.Server({ port });
    this.clients = wss.clients;
    this.routes = new Map();

    wss.on("connection", (ws) => {
      ws.onmessage = (message) => {
        try {
          const { event, payload } = JSON.parse(message.data);
          const callback = this.routes.get(event);
          callback(payload, ws);
        } catch (error) {
          console.log("Unable to parse websocket message.", error.message);
        }
      };
    });
  }

  setRoute = (event, callback) => {
    if (this.routes.has(event)) {
      console.log(`WebSocket event name ${event} already exist`);
    } else {
      this.routes.set(event, callback);
    }
  };

  send = (data) => {
    const now = Date.now();
    Array.isArray(data) ? data.forEach((data) => (data.timestamp = now)) : (data.timestamp = now);

    const message = JSON.stringify(data);
    this.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(message);
      }
    });
  };
}
