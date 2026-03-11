export interface PromptArgumentSpec {
    name: string;
    description: string;
    required: boolean;
}
export declare function listPromptDefinitions(): Array<{
    name: string;
    description: string;
    arguments: PromptArgumentSpec[];
}>;
export declare function getPromptByName(name: string, args: Record<string, string | undefined>): {
    description: string;
    text: string;
};
