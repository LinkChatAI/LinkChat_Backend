import { Router } from 'express';
import { getLinkPreviewHandler } from '../controllers/linkPreviewController.js';

const router = Router();

router.get('/', getLinkPreviewHandler);

export default router;
