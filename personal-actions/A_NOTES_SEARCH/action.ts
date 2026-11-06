import { readPersonalScope } from "../../src/personal-scope";
export default {
  execute(input: { scopeFile: string; query: string }, ctx: { capabilities: { readFile(path: string): Promise<string> } }) {
    return readPersonalScope(input, path => ctx.capabilities.readFile(path), "notes" );
  },
};
