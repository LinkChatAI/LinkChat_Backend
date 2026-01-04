import { verifyToken } from '../utils/jwt.js';
export const authenticateRoom = (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (!token) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
    }
    const decoded = verifyToken(token);
    if (!decoded) {
        res.status(401).json({ error: 'Invalid token' });
        return;
    }
    req.roomCode = decoded.roomCode;
    next();
};
//# sourceMappingURL=auth.js.map