/**
 * In-memory read receipts per room (per-session userId).
 * Delivered = server saved the message; Seen = other participants loaded it.
 */

type ReceiptEntry = {
  delivered: boolean;
  seenBy: Set<string>;
};

const roomReceipts = new Map<string, Map<string, ReceiptEntry>>();

function getRoomMap(roomCode: string): Map<string, ReceiptEntry> {
  if (!roomReceipts.has(roomCode)) {
    roomReceipts.set(roomCode, new Map());
  }
  return roomReceipts.get(roomCode)!;
}

export function initMessageReceipt(roomCode: string, messageId: string): void {
  const room = getRoomMap(roomCode);
  if (!room.has(messageId)) {
    room.set(messageId, { delivered: true, seenBy: new Set() });
  } else {
    room.get(messageId)!.delivered = true;
  }
}

export function markMessagesSeen(
  roomCode: string,
  messageIds: string[],
  userId: string
): string[] {
  const room = roomReceipts.get(roomCode);
  if (!room) return [];

  const updated: string[] = [];
  for (const messageId of messageIds) {
    const entry = room.get(messageId);
    if (entry && !entry.seenBy.has(userId)) {
      entry.seenBy.add(userId);
      updated.push(messageId);
    }
  }
  return updated;
}

export function getSeenCount(roomCode: string, messageId: string): number {
  return roomReceipts.get(roomCode)?.get(messageId)?.seenBy.size ?? 0;
}

export function isDelivered(roomCode: string, messageId: string): boolean {
  return roomReceipts.get(roomCode)?.get(messageId)?.delivered ?? false;
}

export function clearRoomReceipts(roomCode: string): void {
  roomReceipts.delete(roomCode);
}
