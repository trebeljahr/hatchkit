import type { IncomingMessage, Server, ServerResponse } from "node:http";

/**
 * Stop new HTTP work and let accepted requests finish before closing databases.
 * The caller owns the overall shutdown deadline (including WebSocket/auth/DB
 * cleanup). A request active when close() starts can finish and return its socket
 * to a client's keep-alive pool. Reusing that socket can hold close() open even
 * though the listener is gone. Close subsequent responses and reap sockets as
 * they become idle; neither operation interrupts an accepted request.
 */
export function closeHttpServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    const closeConnection = (_request: IncomingMessage, response: ServerResponse) => {
      if (!response.headersSent) response.setHeader("Connection", "close");
    };
    server.prependListener("request", closeConnection);
    const reapIdle = setInterval(() => server.closeIdleConnections(), 25);
    reapIdle.unref();
    server.close((error?: Error) => {
      clearInterval(reapIdle);
      server.off("request", closeConnection);
      if (error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING")
        reject(error);
      else resolve();
    });
    server.closeIdleConnections();
  });
}
