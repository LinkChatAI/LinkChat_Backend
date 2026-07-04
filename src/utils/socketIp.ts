import type { Socket } from 'socket.io';

/** Resolve a socket's client IP, honoring X-Forwarded-For behind a proxy/load balancer. */
export function getSocketClientIp(socket: Socket): string {
  const forwarded = socket.handshake.headers['x-forwarded-for'];
  if (typeof forwarded === 'string' && forwarded.length > 0) {
    const first = forwarded.split(',')[0]?.trim();
    if (first) return first;
  }
  return socket.handshake.address || 'unknown';
}
