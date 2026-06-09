export declare const ALL_PATTERNED_ROOM_CODES: readonly string[];
/** Returns true if a 4-digit code matches xxxx, xyyy, xxyy, xxxy, or xyxy (x,y ∈ 0-9). */
export declare const matchesRoomCodePattern: (code: string) => boolean;
export declare const generatePatternedRoomCode: () => string;
export declare const generateRoomCode: () => Promise<string>;
//# sourceMappingURL=roomCode.d.ts.map