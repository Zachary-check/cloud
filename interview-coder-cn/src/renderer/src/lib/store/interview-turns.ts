import { create } from 'zustand'
import {
  addTurn,
  appendChunkToLastTurn,
  finishTurn,
  setLastTurnSources,
  type InterviewTurn,
  type InterviewTurnKind,
  type InterviewTurnStatus
} from '../../../../shared/interview-turn'

export type { InterviewTurn }

interface InterviewTurnsStore {
  turns: InterviewTurn[]
  startTurn: (turn: { id: string; kind: InterviewTurnKind; question: string }) => void
  appendChunk: (chunk: string) => void
  endTurn: (id: string, patch: { answer: string; status: InterviewTurnStatus }) => void
  setSources: (sources: string[]) => void
  clearTurns: () => void
}

/**
 * The transcript of the current interview session. It lives outside React so a
 * trip to the settings page does not throw away answers that are still on screen.
 *
 * All rules are the pure reducers in `shared/interview-turn`; this store only
 * holds the array.
 */
export const useInterviewTurnsStore = create<InterviewTurnsStore>()((set) => ({
  turns: [],

  startTurn: (turn) => set((state) => ({ turns: addTurn(state.turns, turn) })),
  appendChunk: (chunk) => set((state) => ({ turns: appendChunkToLastTurn(state.turns, chunk) })),
  endTurn: (id, patch) => set((state) => ({ turns: finishTurn(state.turns, id, patch) })),
  setSources: (sources) => set((state) => ({ turns: setLastTurnSources(state.turns, sources) })),
  clearTurns: () => set((state) => (state.turns.length ? { turns: [] } : state))
}))
