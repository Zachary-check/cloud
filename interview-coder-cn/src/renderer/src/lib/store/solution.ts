import { create } from 'zustand'

interface SolutionState {
  isLoading: boolean
  solutionChunks: string[]
  screenshotData: string | null
  errorMessage: string | null
  /** Knowledge-base files selected for the latest interview request. */
  knowledgeSources: string[]
}

interface SolutionStore extends SolutionState {
  setIsLoading: (isReceiving: boolean) => void
  addSolutionChunk: (chunk: string) => void
  setSolutionChunks: (chunks: string[]) => void
  setScreenshotData: (data: string | null) => void
  setErrorMessage: (message: string | null) => void
  setKnowledgeSources: (sources: string[]) => void
  clearSolution: () => void
  resetState: () => void
}

const defaultState: SolutionState = {
  isLoading: false,
  solutionChunks: [],
  screenshotData: null,
  errorMessage: null,
  knowledgeSources: []
}

export const useSolutionStore = create<SolutionStore>()((set) => ({
  ...defaultState,
  setIsLoading: (isReceiving) => {
    set({ isLoading: isReceiving })
  },
  addSolutionChunk: (chunk) => {
    set((state) => ({
      solutionChunks: [...state.solutionChunks, chunk]
    }))
  },
  setSolutionChunks: (chunks) => {
    set({ solutionChunks: chunks })
  },
  setScreenshotData: (data) => {
    set({ screenshotData: data })
  },
  setErrorMessage: (message) => {
    set({ errorMessage: message })
  },
  setKnowledgeSources: (sources) => {
    set({ knowledgeSources: sources })
  },
  clearSolution: () => {
    set({ solutionChunks: [], isLoading: false, errorMessage: null, knowledgeSources: [] })
  },
  resetState: () => {
    set(defaultState)
  }
}))
