import mongoose from 'mongoose';
import { Room as IRoom } from '../types/index.js';
export declare const RoomModel: mongoose.Model<IRoom, {}, {}, {}, mongoose.Document<unknown, {}, IRoom, {}, {}> & IRoom & {
    _id: mongoose.Types.ObjectId;
} & {
    __v: number;
}, any>;
//# sourceMappingURL=Room.d.ts.map