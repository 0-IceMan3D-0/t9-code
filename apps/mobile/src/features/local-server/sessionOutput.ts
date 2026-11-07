import type { TerminalOutputState } from "@t3tools/client-runtime/state/terminal";

const MAX_CHUNKS = 400;

export const EMPTY_OUTPUT: TerminalOutputState = {
  generation: 1,
  chunks: [],
  retainedBytes: 0,
  resetVersion: 0,
  nextOffset: 0,
};

export function appendOutput(output: TerminalOutputState, data: string): TerminalOutputState {
  const chunk = { startOffset: output.nextOffset, data, byteLength: data.length };
  return {
    ...output,
    chunks: [...output.chunks, chunk].slice(-MAX_CHUNKS),
    retainedBytes: output.retainedBytes + data.length,
    nextOffset: output.nextOffset + data.length,
  };
}
