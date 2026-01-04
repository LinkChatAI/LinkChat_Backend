export declare const generateUploadUrl: (roomCode: string, fileName: string, mimeType: string, fileSize: number) => Promise<{
    uploadUrl: string;
    filePath: string;
    useLocal?: boolean;
}>;
export declare const getFileUrl: (filePath: string) => string;
export declare const getDownloadUrl: (filePath: string, fileName: string) => Promise<string>;
export declare const getImageUrl: (filePath: string) => Promise<string>;
/**
 * Delete files for a specific room from GCS or local storage
 */
export declare const deleteRoomFiles: (roomCode: string) => Promise<void>;
//# sourceMappingURL=gcsService.d.ts.map