import { createServer, type Server } from "node:http";

export const postedBodies = (status = 200) => {
  const bodies: string[] = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(status, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  return { bodies, server };
};

export const listenLoopback = (server: Server) =>
  new Promise<number>((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("The local server did not bind a port."));
        return;
      }
      resolve(address.port);
    });
  });

export const closeServer = (server: Server) =>
  new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
