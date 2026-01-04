import mongoose from 'mongoose';
import { Message as IMessage } from '../types/index.js';
export declare const MessageModel: mongoose.Model<IMessage, {}, {}, {}, mongoose.Document<unknown, {}, IMessage, {}, {}> & IMessage & {
    _id: mongoose.Types.ObjectId;
} & {
    __v: number;
}, any>;
//# sourceMappingURL=Message.d.ts.map