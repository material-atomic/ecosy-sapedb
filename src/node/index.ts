/**
 * The transport that puts the driver on a real socket, for Node.
 *
 * It is a subpath of its own because it imports `node:tls`, and the driver is
 * meant to run where that does not exist — a worker, an edge runtime, a test
 * with no sockets at all. Importing this from there should fail loudly at the
 * import rather than quietly at the first connection.
 *
 * TLS is the default and turning it off takes saying so. A store speaks a
 * password and a signature on every connection; a transport that falls back to
 * plaintext when a certificate is inconvenient is one that will one day be
 * carrying those in the clear with nothing about it looking different.
 */

import { connect as connectTLS, type ConnectionOptions as TLSOptions } from "node:tls";
import { connect as connectTCP } from "node:net";
import type { Socket } from "node:net";

import type { ConnectionTarget } from "../connection";
import { Unavailable } from "../errors";
import { FrameDecoder, type Frame } from "../protocol";
import type { Connection, Transport } from "../client";

export interface NodeTransportOptions {
  /**
   * Off only where the network is already private and somebody has said so
   * out loud — a container talking to a sidecar, a test. Anywhere else this is
   * how credentials end up on the wire.
   */
  insecure?: boolean;
  /** Passed to `node:tls`: a CA for a private certificate, a client certificate for mTLS. */
  tls?: TLSOptions;
  /** Milliseconds to wait for the socket and, with TLS, the handshake. Default 5000. */
  timeout?: number;
  /**
   * The largest frame to accept. A store that offers more than this is not
   * trusted to be a store; the default matches the protocol's own limit.
   */
  maxPayload?: number;
}

/**
 * Makes a transport. One transport serves any number of connections; the
 * driver decides when to open them.
 */
export function nodeTransport(options: NodeTransportOptions = {}): Transport {
  const timeout = options.timeout ?? 5000;

  return {
    connect(target: ConnectionTarget): Promise<Connection> {
      return new Promise<Connection>((resolve, reject) => {
        const where = `${target.host}:${target.port}`;

        const socket: Socket = options.insecure
          ? connectTCP({ host: target.host, port: target.port })
          : connectTLS({
              host: target.host,
              port: target.port,
              servername: target.host,
              ...options.tls,
            });

        /* One settle, whatever happens first. Without this a socket that
           errors after connecting rejects a promise that already resolved,
           which Node reports as an unhandled rejection somewhere unrelated. */
        let settled = false;

        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          socket.destroy();
          reject(new Unavailable(`connecting to ${where} timed out`));
        }, timeout);
        if (typeof timer.unref === "function") timer.unref();

        socket.once("error", (cause) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          socket.destroy();
          reject(new Unavailable(`could not reach ${where}`, { cause }));
        });

        const ready = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);

          /* Nagle's algorithm holds a small write back waiting for a bigger
             one. Every frame here is small and every one of them is somebody
             waiting for an answer, so the delay it saves bandwidth with is the
             latency this is measured on. */
          socket.setNoDelay(true);

          resolve(wrap(socket, where, options.maxPayload));
        };

        socket.once(options.insecure ? "connect" : "secureConnect", ready);
      });
    },
  };
}

/** wrap turns a connected socket into what the driver expects. */
function wrap(socket: Socket, where: string, maxPayload?: number): Connection {
  const decoder = new FrameDecoder(maxPayload === undefined ? undefined : { maxPayload });

  let onFrame: ((frame: Frame) => void) | undefined;
  let onClose: ((reason?: unknown) => void) | undefined;
  let ended = false;

  const finish = (reason?: unknown) => {
    if (ended) return;
    ended = true;
    onClose?.(reason);
  };

  socket.on("data", (chunk: Buffer) => {
    let frames: Frame[];
    try {
      frames = decoder.push(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength));
    } catch (cause) {
      /* A stream this side cannot read is not a stream to keep reading. It is
         a store speaking a version we do not know, or something that is not a
         store at all. */
      socket.destroy();
      finish(cause);
      return;
    }
    for (const frame of frames) onFrame?.(frame);
  });

  socket.on("error", (cause) => finish(cause));
  socket.on("close", () => finish(new Unavailable(`${where} closed the connection`)));

  return {
    send(bytes: Uint8Array): void {
      if (ended) throw new Unavailable(`${where} is no longer connected`);
      socket.write(bytes);
    },
    onFrame(handler) {
      onFrame = handler;
    },
    onClose(handler) {
      onClose = handler;
    },
    close(): void {
      ended = true;
      socket.end();
      socket.destroy();
    },
  };
}
