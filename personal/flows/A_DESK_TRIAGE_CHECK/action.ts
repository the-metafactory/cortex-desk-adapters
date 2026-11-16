import { checkFlowOutput } from "../../src/triage";

export default {
  execute(input: Record<string, unknown>) {
    return Promise.resolve({ triage: checkFlowOutput(input) });
  },
};
