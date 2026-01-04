export declare const generatePairingCodeForRoom: (roomCode: string, userId: string) => Promise<string>;
export declare const validatePairingCode: (pairingCode: string) => Promise<{
    roomCode: string;
    userId: string;
} | null>;
//# sourceMappingURL=pairingService.d.ts.map