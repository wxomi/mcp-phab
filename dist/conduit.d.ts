import { JsonObject } from "./parsing.js";
export interface ConduitCallOptions {
    conduitUri?: string;
    timeoutMs?: number;
}
export declare function callConduit(method: string, payload: JsonObject, options?: ConduitCallOptions): Promise<JsonObject>;
