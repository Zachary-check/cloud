import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import codingPrompt from './prompts/coding.md?raw'
import englishExamPrompt from './prompts/english-exam.md?raw'
import aptitudeTestPrompt from './prompts/aptitude-test.md?raw'
import generalQaPrompt from './prompts/general-qa.md?raw'
import interviewPrompt from './prompts/interview.md?raw'
import {
  MAX_INTERVIEW_KNOWLEDGE_DOCUMENTS,
  normalizeInterviewKnowledgeDocuments,
  type InterviewKnowledgeDocument
} from '../../../../shared/interview-knowledge'
import {
  normalizePinnedProjectRules,
  type PinnedProjectRule
} from '../../../../shared/pinned-project'
import {
  DEFAULT_INTERVIEW_TRIGGER_DELAY_MS,
  DEFAULT_INTERVIEW_TRIGGER_MUTE_MS
} from '../../../../shared/interview-trigger'

export interface PromptScene {
  id: string
  name: string
  prompt: string
  isPreset: boolean
}

export const CODING_SCENE_ID = 'coding'

/** Default prompts for all preset scenes, maintained as Markdown files under ./prompts */
export const PRESET_SCENE_PROMPTS: Record<string, string> = {
  [CODING_SCENE_ID]: codingPrompt,
  'english-exam': englishExamPrompt,
  'aptitude-test': aptitudeTestPrompt,
  'general-qa': generalQaPrompt,
  interview: interviewPrompt
}

const createPresetScenes = (): PromptScene[] => [
  {
    id: CODING_SCENE_ID,
    name: '解算法题',
    prompt: PRESET_SCENE_PROMPTS[CODING_SCENE_ID],
    isPreset: true
  },
  {
    id: 'english-exam',
    name: '英语考试',
    prompt: PRESET_SCENE_PROMPTS['english-exam'],
    isPreset: true
  },
  {
    id: 'aptitude-test',
    name: '能力测评',
    prompt: PRESET_SCENE_PROMPTS['aptitude-test'],
    isPreset: true
  },
  {
    id: 'general-qa',
    name: '通用问答',
    prompt: PRESET_SCENE_PROMPTS['general-qa'],
    isPreset: true
  },
  {
    id: 'interview',
    name: '面试问答',
    prompt: PRESET_SCENE_PROMPTS.interview,
    isPreset: true
  }
]

/** Derive the `customPrompt` (the system prompt used by the main process) from the active scene */
function composeCustomPrompt(scenes: PromptScene[], activeSceneId: string): string {
  const scene = scenes.find((s) => s.id === activeSceneId)
  if (!scene) return PRESET_SCENE_PROMPTS[CODING_SCENE_ID]
  // An emptied preset scene falls back to its default prompt
  return scene.prompt.trim() || PRESET_SCENE_PROMPTS[scene.id] || ''
}

export const OPACITY_MIN = 0.1
export const OPACITY_MAX = 1
export const OPACITY_STEP = 0.05

export type WorkMode = 'written' | 'interview' | 'dual'
export type AudioCaptureSource = 'system' | 'microphone'

interface Settings {
  // theme: 'light' | 'dark'an
  apiBaseURL: string
  apiKey: string
  model: string
  customModels: string[]
  /** Failover endpoint; a blank baseURL/key reuses the primary's. */
  fallbackModelEnabled: boolean
  fallbackApiBaseURL: string
  fallbackApiKey: string
  fallbackModel: string
  customPrompt: string

  /** written: screenshot-driven; interview: voice-driven; dual: compact screenshot-only */
  workMode: WorkMode
  /** Capture the current screen when an interview utterance automatically triggers AI */
  interviewIncludeScreenshot: boolean
  /** Quiet window in ms before a spoken question is submitted; see shared/interview-trigger */
  interviewTriggerDelayMs: number
  /** Recognition suppressed for this long after a question is submitted; 0 = off */
  interviewTriggerMuteMs: number
  /** Resume/project facts stored locally for interview assistance */
  interviewContext: string
  /** Markdown resume/project documents stored locally for interview assistance */
  interviewKnowledgeBase: InterviewKnowledgeDocument[]
  /** Whether enabled knowledge-base documents are included in interview answers */
  interviewKnowledgeBaseEnabled: boolean
  /** Explicit opt-in to send interviewContext to the configured AI endpoint */
  shareInterviewContextWithAI: boolean
  /** Force a specific project for "pick a project" questions */
  pinnedProjectRules: PinnedProjectRule[]
  /** Code language used when the question names none; '' turns the rule off */
  codeLanguage: string

  scenes: PromptScene[]
  activeSceneId: string

  opacity: number
  /** Allow resizing the main window and overlay toolbar */
  resizable: boolean
  /** Show the click-through overlay toolbar above the main window */
  showOverlayToolbar: boolean
  /** Dwell time in ms before hovering a toolbar button fires it; 0 disables hover triggering */
  toolbarHoverDelay: number

  screenshotAutoSave: boolean
  screenshotDir: string
  /** Where the interview Markdown transcript is written; blank = <documents>/interview */
  recordDir: string

  dashscopeApiKey: string

  hideDockIcon: boolean

  audioCaptureSource: AudioCaptureSource
  transcriptionInputGain: number
  audioInputDeviceId: string
  audioOutputDeviceId: string
}

interface SettingsStore extends Settings {
  updateSetting: <K extends keyof Settings>(key: K, value: Settings[K]) => void
  /** Step the window opacity within [OPACITY_MIN, OPACITY_MAX] */
  adjustOpacity: (delta: number) => void
  syncSettings: (settings: Partial<Settings>) => void
  setActiveScene: (id: string) => void
  updateScenePrompt: (id: string, prompt: string) => void
  addScene: (name: string) => string
  removeScene: (id: string) => void
}

const defaultSettings: Settings = {
  apiBaseURL: '',
  apiKey: '',
  model: '',
  customModels: [],
  fallbackModelEnabled: false,
  fallbackApiBaseURL: '',
  fallbackApiKey: '',
  fallbackModel: '',
  customPrompt: PRESET_SCENE_PROMPTS[CODING_SCENE_ID],
  workMode: 'written',
  interviewIncludeScreenshot: false,
  interviewTriggerDelayMs: DEFAULT_INTERVIEW_TRIGGER_DELAY_MS,
  interviewTriggerMuteMs: DEFAULT_INTERVIEW_TRIGGER_MUTE_MS,
  interviewContext: '',
  interviewKnowledgeBase: [],
  interviewKnowledgeBaseEnabled: true,
  shareInterviewContextWithAI: false,
  pinnedProjectRules: [],
  codeLanguage: '',
  scenes: createPresetScenes(),
  activeSceneId: CODING_SCENE_ID,

  opacity: 0.8,
  resizable: true,
  showOverlayToolbar: true,
  toolbarHoverDelay: 1000,

  screenshotAutoSave: false,
  screenshotDir: '',
  // Blank so the main process decides: <documents>/interview.
  recordDir: '',

  dashscopeApiKey: '',

  hideDockIcon: false,

  audioCaptureSource: 'system',
  transcriptionInputGain: 1.5,
  audioInputDeviceId: '',
  audioOutputDeviceId: ''
}

export const useSettingsStore = create<SettingsStore>()(
  persist(
    (set, get) => ({
      ...defaultSettings,
      updateSetting: (key, value) => {
        set({ [key]: value })
      },
      adjustOpacity: (delta) => {
        const raw = get().opacity + delta
        // Round to 2 decimals to avoid float drift across repeated presses
        const opacity = Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, Math.round(raw * 100) / 100))
        set({ opacity })
      },
      syncSettings: (settings) => {
        set(settings)
      },
      setActiveScene: (id) => {
        set((state) => ({
          activeSceneId: id,
          customPrompt: composeCustomPrompt(state.scenes, id)
        }))
      },
      updateScenePrompt: (id, prompt) => {
        set((state) => {
          const scenes = state.scenes.map((s) => (s.id === id ? { ...s, prompt } : s))
          return {
            scenes,
            customPrompt: composeCustomPrompt(scenes, state.activeSceneId)
          }
        })
      },
      addScene: (name) => {
        const id = `custom-${Date.now()}`
        set((state) => {
          const scenes = [...state.scenes, { id, name, prompt: '', isPreset: false }]
          return {
            scenes,
            activeSceneId: id,
            customPrompt: composeCustomPrompt(scenes, id)
          }
        })
        return id
      },
      removeScene: (id) => {
        const scene = get().scenes.find((s) => s.id === id)
        if (!scene || scene.isPreset) return
        set((state) => {
          const scenes = state.scenes.filter((s) => s.id !== id)
          const activeSceneId = state.activeSceneId === id ? CODING_SCENE_ID : state.activeSceneId
          return {
            scenes,
            activeSceneId,
            customPrompt: composeCustomPrompt(scenes, activeSceneId)
          }
        })
      }
    }),
    {
      name: 'interview-coder-settings',
      version: 14,
      migrate: (persisted, version) => {
        const state = persisted as Partial<Settings>
        // Drop the legacy codeLanguage field (language now lives in the prompt text)
        delete (state as Record<string, unknown>).codeLanguage
        if (version < 8) {
          // Hover-delay options are now 0.5s / 1s / 2s; snap the retired ones
          // so the Select still matches an item
          if (state.toolbarHoverDelay === 800 || state.toolbarHoverDelay === 1200) {
            state.toolbarHoverDelay = 1000
          }
        }
        if (version < 12 && state.audioInputDeviceId) {
          // Previously, selecting a microphone implicitly changed the capture source.
          state.audioCaptureSource = 'microphone'
        }
        state.interviewKnowledgeBase = normalizeInterviewKnowledgeDocuments(
          state.interviewKnowledgeBase
        ).slice(0, MAX_INTERVIEW_KNOWLEDGE_DOCUMENTS)
        if (version < 5) {
          // Convert the legacy free-form customPrompt into a custom scene
          const scenes = createPresetScenes()
          let activeSceneId = CODING_SCENE_ID
          const legacyPrompt = (state.customPrompt ?? '').trim()
          if (legacyPrompt) {
            const id = `custom-${Date.now()}`
            scenes.push({ id, name: '自定义场景', prompt: legacyPrompt, isPreset: false })
            activeSceneId = id
          }
          return { ...state, scenes, activeSceneId }
        }
        return state
      },
      merge: (persisted, current) => {
        const state = { ...current, ...(persisted as Partial<Settings>) }
        // Work mode is session-only so every app restart opens in the discoverable full UI.
        state.workMode = 'written'
        // The toolbar window is mouse-transparent, so hovering is its only
        // trigger: a stored "0 = clicks only" would leave it completely inert
        if (!(state.toolbarHoverDelay > 0)) state.toolbarHoverDelay = 1000
        state.interviewKnowledgeBase = normalizeInterviewKnowledgeDocuments(
          state.interviewKnowledgeBase
        )
        state.interviewKnowledgeBaseEnabled = state.interviewKnowledgeBaseEnabled !== false
        // Drop incomplete or oversized rules once, on load, so the injected
        // prompt cannot be poisoned by a half-filled editor row
        state.pinnedProjectRules = normalizePinnedProjectRules(state.pinnedProjectRules)
        // Ensure preset scenes always exist (keep user-edited prompts),
        // so presets added in future versions show up for existing users
        const persistedScenes = Array.isArray(state.scenes) ? state.scenes : []
        state.scenes = [
          ...createPresetScenes().map((p) => {
            const saved = persistedScenes.find((s) => s.id === p.id)
            // Restore the default prompt if a preset scene was left empty
            return saved?.prompt.trim() ? saved : p
          }),
          ...persistedScenes.filter((s) => !s.isPreset)
        ]
        if (!state.scenes.some((s) => s.id === state.activeSceneId)) {
          state.activeSceneId = CODING_SCENE_ID
        }
        state.customPrompt = composeCustomPrompt(state.scenes, state.activeSceneId)
        return state
      }
    }
  )
)
