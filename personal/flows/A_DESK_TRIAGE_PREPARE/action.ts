import { prepare, type TriageRequest } from "../../src/triage";

export default {
  execute(input: { request: TriageRequest }) {
    return Promise.resolve(prepare(input.request));
  },
};
