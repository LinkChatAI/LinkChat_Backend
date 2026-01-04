import { Storage } from '@google-cloud/storage';
import { logger } from '../utils/logger.js';
import { env } from './env.js';

let storageClient: Storage | null = null;

export const getStorageClient = (): Storage | null => {
  if (!env.GCS_BUCKET) {
    logger.debug('GCS_BUCKET not configured, file uploads disabled');
    return null;
  }

  if (!storageClient) {
    try {
      storageClient = new Storage({
        projectId: env.GCS_PROJECT_ID,
        credentials: {
          client_email: env.GCS_CLIENT_EMAIL,
          private_key: env.GCS_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        },
      });
      logger.info('GCS client initialized');
    } catch (error: any) {
      logger.error('GCS initialization error', { error: error instanceof Error ? error.message : String(error) });
      return null;
    }
  }
  return storageClient;
};

export const getBucket = () => {
  const client = getStorageClient();
  if (!client || !env.GCS_BUCKET) {
    return null;
  }
  return client.bucket(env.GCS_BUCKET);
};

export const isFileUploadAvailable = (): boolean => {
  return !!env.GCS_BUCKET && !!getStorageClient();
};

