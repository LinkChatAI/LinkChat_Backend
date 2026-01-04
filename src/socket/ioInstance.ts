import { Server } from 'socket.io';

let ioInstance: Server | null = null;

export const setIoInstance = (io: Server): void => {
  ioInstance = io;
};

export const getIoInstance = (): Server | null => {
  return ioInstance;
};

