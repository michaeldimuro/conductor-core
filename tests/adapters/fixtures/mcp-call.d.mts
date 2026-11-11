export function callTool(url: string, headers: Record<string, string>, name: string, args: Record<string, unknown>): Promise<string>;
export function readStdin(): Promise<string>;
export function sleep(ms: number): Promise<void>;
