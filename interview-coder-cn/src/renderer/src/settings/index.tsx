import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import {
  ArrowLeft,
  SquareTerminal,
  Palette,
  Shield,
  Bot,
  Eye,
  EyeOff,
  Keyboard,
  FolderOpen,
  Mic,
  Plus,
  RotateCcw,
  X,
  FileText,
  Search,
  Trash2,
  Upload
} from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Slider } from '@/components/ui/slider'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { cn } from '@/lib/utils'
import {
  useSettingsStore,
  PRESET_SCENE_PROMPTS,
  OPACITY_MIN,
  OPACITY_MAX,
  OPACITY_STEP
} from '@/lib/store/settings'
import { isMac } from '@/lib/utils/env'
import { SelectModel } from './SelectModel'
import { CustomShortcuts, ResetDefaultShortcuts } from './CustomShortcuts'
import { TriggerDelayInput } from './TriggerDelayInput'
import { TriggerMuteInput } from './TriggerMuteInput'
import { CodeLanguageInput } from './CodeLanguageInput'
import {
  MAX_INTERVIEW_KNOWLEDGE_DOCUMENT_CHARS,
  MAX_INTERVIEW_KNOWLEDGE_DOCUMENTS,
  MAX_INTERVIEW_KNOWLEDGE_TOTAL_CHARS,
  normalizeInterviewKnowledgeDocuments
} from '../../../shared/interview-knowledge'
import {
  MAX_PINNED_PROJECT_KEYWORD_CHARS,
  MAX_PINNED_PROJECT_NAME_CHARS,
  MAX_PINNED_PROJECT_NOTE_CHARS,
  MAX_PINNED_PROJECT_RULES,
  type PinnedProjectRule
} from '../../../shared/pinned-project'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'

/** Sentinel option that switches a rule's project field into free-text mode. */
const MANUAL_PROJECT_OPTION = '__manual__'

export default function SettingsPage() {
  const {
    workMode,
    interviewIncludeScreenshot,
    interviewTriggerDelayMs,
    interviewTriggerMuteMs,
    interviewContext,
    interviewKnowledgeBase,
    interviewKnowledgeBaseEnabled,
    shareInterviewContextWithAI,
    pinnedProjectRules,
    codeLanguage,
    opacity,
    resizable,
    showOverlayToolbar,
    toolbarHoverDelay,
    apiBaseURL,
    apiKey,
    model,
    fallbackModelEnabled,
    fallbackApiBaseURL,
    fallbackApiKey,
    fallbackModel,
    scenes,
    activeSceneId,
    screenshotAutoSave,
    screenshotDir,
    recordDir,
    dashscopeApiKey,
    audioCaptureSource,
    audioInputDeviceId,
    audioOutputDeviceId,
    transcriptionInputGain,
    hideDockIcon,
    updateSetting,
    setActiveScene,
    updateScenePrompt,
    addScene,
    removeScene
  } = useSettingsStore()
  const [showApiKey, setShowApiKey] = useState(false)
  const [showFallbackApiKey, setShowFallbackApiKey] = useState(false)
  const [showDashscopeApiKey, setShowDashscopeApiKey] = useState(false)
  const [addSceneOpen, setAddSceneOpen] = useState(false)
  const [newSceneName, setNewSceneName] = useState('')
  const [sceneToDelete, setSceneToDelete] = useState<string | null>(null)
  const [knowledgeMessage, setKnowledgeMessage] = useState('')
  const [manualProjectRuleIds, setManualProjectRuleIds] = useState<string[]>([])
  const [knowledgePreviewId, setKnowledgePreviewId] = useState<string | null>(null)
  const [knowledgePreviewQuery, setKnowledgePreviewQuery] = useState('')

  const [audioDevices, setAudioDevices] = useState<MediaDeviceInfo[]>([])

  const activeScene = scenes.find((s) => s.id === activeSceneId)
  const deletingScene = scenes.find((s) => s.id === sceneToDelete)
  const knowledgePreviewDocument = interviewKnowledgeBase.find(
    (document) => document.id === knowledgePreviewId
  )
  const normalizedKnowledgePreviewQuery = knowledgePreviewQuery.trim()
  const escapedKnowledgePreviewQuery = normalizedKnowledgePreviewQuery.replace(
    /[.*+?^${}()|[\]\\]/g,
    '\\$&'
  )
  const knowledgePreviewSearchRegex = escapedKnowledgePreviewQuery
    ? new RegExp(`(${escapedKnowledgePreviewQuery})`, 'gi')
    : null
  const knowledgePreviewMatchCount =
    knowledgePreviewDocument && knowledgePreviewSearchRegex
      ? (knowledgePreviewDocument.content.match(knowledgePreviewSearchRegex)?.length ?? 0)
      : 0

  const hasInterviewContext = Boolean(interviewContext.trim())

  /**
   * Candidate projects for the pinned-project dropdown. The app has no separate
   * "project" entity — each project is one knowledge-base document, so the file
   * names (minus the extension) are exactly the set of projects on hand.
   */
  const projectOptions = useMemo(() => {
    const seen = new Set<string>()
    const options: string[] = []
    for (const document of interviewKnowledgeBase) {
      const name = document.name.replace(/\.(md|markdown)$/i, '').trim()
      if (!name || seen.has(name)) continue
      seen.add(name)
      options.push(name)
    }
    return options
  }, [interviewKnowledgeBase])

  const setPinnedRules = (rules: typeof pinnedProjectRules) =>
    updateSetting('pinnedProjectRules', rules)

  const addPinnedRule = () => {
    if (pinnedProjectRules.length >= MAX_PINNED_PROJECT_RULES) return
    setPinnedRules([
      ...pinnedProjectRules,
      { id: `pin-${Date.now()}`, keywords: '', project: '', note: '' }
    ])
  }

  const updatePinnedRule = (id: string, patch: Partial<PinnedProjectRule>) =>
    setPinnedRules(
      pinnedProjectRules.map((rule) => (rule.id === id ? { ...rule, ...patch } : rule))
    )

  const removePinnedRule = (id: string) => {
    setPinnedRules(pinnedProjectRules.filter((rule) => rule.id !== id))
    setManualProjectRuleIds((ids) => ids.filter((item) => item !== id))
  }

  /** Rules whose project was typed by hand instead of picked from the knowledge base. */
  const setManualProject = (id: string, manual: boolean) =>
    setManualProjectRuleIds((ids) =>
      manual ? [...new Set([...ids, id])] : ids.filter((item) => item !== id)
    )

  const handleProjectSelect = (rule: PinnedProjectRule, value: string) => {
    if (value === MANUAL_PROJECT_OPTION) {
      setManualProject(rule.id, true)
      return
    }
    setManualProject(rule.id, false)
    updatePinnedRule(rule.id, { project: value })
  }

  const handleSelectKnowledgeFiles = async () => {
    if (interviewKnowledgeBase.length >= MAX_INTERVIEW_KNOWLEDGE_DOCUMENTS) {
      setKnowledgeMessage(`最多上传 ${MAX_INTERVIEW_KNOWLEDGE_DOCUMENTS} 个 Markdown 文件`)
      return
    }
    try {
      const selected = await window.api.selectInterviewKnowledgeFiles(interviewKnowledgeBase.length)
      if (selected.length === 0) return
      const merged = normalizeInterviewKnowledgeDocuments([...interviewKnowledgeBase, ...selected])
      updateSetting('interviewKnowledgeBase', merged)
      // Newly uploaded files are active by default; the separate switch can pause them.
      updateSetting('interviewKnowledgeBaseEnabled', true)
      setKnowledgeMessage(
        merged.length < interviewKnowledgeBase.length + selected.length
          ? `已保留前 ${MAX_INTERVIEW_KNOWLEDGE_DOCUMENTS} 个文件，单个文件或总内容过长的部分已截取`
          : `已添加 ${selected.length} 个文件，知识库默认启用`
      )
    } catch (error) {
      console.error('Failed to select interview knowledge files:', error)
      setKnowledgeMessage('读取 Markdown 文件失败，请重试')
    }
  }

  const handleRemoveKnowledgeFile = (id: string) => {
    if (knowledgePreviewId === id) {
      setKnowledgePreviewId(null)
      setKnowledgePreviewQuery('')
    }
    updateSetting(
      'interviewKnowledgeBase',
      interviewKnowledgeBase.filter((document) => document.id !== id)
    )
    setKnowledgeMessage('已移除文件；剩余已启用资料仍会优先参与回答')
  }

  const handleClearKnowledgeFiles = () => {
    setKnowledgePreviewId(null)
    setKnowledgePreviewQuery('')
    updateSetting('interviewKnowledgeBase', [])
    updateSetting('interviewKnowledgeBaseEnabled', false)
    setKnowledgeMessage('知识库已清空')
  }

  useEffect(() => {
    return () => {
      document.body.style.opacity = ''
    }
  }, [])

  useEffect(() => {
    const loadDevices = async () => {
      try {
        const devices = await navigator.mediaDevices.enumerateDevices()
        const needsPermission =
          audioCaptureSource === 'microphone' && devices.every((d) => !d.label)
        if (needsPermission) {
          const permissionStream = await navigator.mediaDevices.getUserMedia({
            audio: true,
            video: false
          })
          permissionStream.getTracks().forEach((track) => track.stop())
        }
        const refreshed = await navigator.mediaDevices.enumerateDevices()
        setAudioDevices(refreshed)
      } catch (err) {
        console.error('Failed to enumerate audio devices:', err)
      }
    }
    loadDevices()
  }, [audioCaptureSource])

  const handleAddScene = () => {
    const name = newSceneName.trim()
    if (!name) return
    addScene(name)
    setNewSceneName('')
    setAddSceneOpen(false)
  }

  const handleResetScenePrompt = () => {
    if (!activeScene?.isPreset) return
    updateScenePrompt(activeScene.id, PRESET_SCENE_PROMPTS[activeScene.id] ?? '')
  }

  return (
    <>
      {/* Header */}
      <div id="app-header" className="flex items-center">
        <div className="actions">
          <Button variant="ghost" asChild size="icon" className="w-12 mr-2 rounded-none">
            <Link to="/">
              <ArrowLeft className="h-5 w-5" />
            </Link>
          </Button>
        </div>
        <h1>设置</h1>
      </div>

      {/* Settings Content */}
      <div id="app-content" className="flex flex-col gap-4 p-8">
        {/* Work Mode */}
        <div className="bg-gray-300/80 rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4 flex items-center">
            <SquareTerminal className="h-5 w-5 mr-2" />
            工作模式
          </h2>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">
                当前模式
                <span className="ml-2 text-xs font-light">
                  笔试模式完整解题；面试模式监听语音；双机位模式只截图并显示精简答案
                </span>
              </label>
              <Select
                value={workMode}
                onValueChange={(value: 'written' | 'interview' | 'dual') =>
                  updateSetting('workMode', value)
                }
              >
                <SelectTrigger className="w-60 bg-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="written">笔试（截图解题）</SelectItem>
                  <SelectItem value="interview">面试（自动语音分析）</SelectItem>
                  <SelectItem value="dual">双机位（极简截图答题）</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {workMode === 'interview' && (
              <>
                <div className="flex items-center justify-between pl-4 border-l-2 border-gray-400/70">
                  <label className="text-sm font-medium">
                    自动附带截图
                    <span className="ml-2 text-xs font-light">
                      每次语音触发 AI 时，同时捕获并发送当前屏幕
                    </span>
                  </label>
                  <Switch
                    className="scale-y-90"
                    checked={interviewIncludeScreenshot}
                    onCheckedChange={(checked) =>
                      updateSetting('interviewIncludeScreenshot', checked)
                    }
                  />
                </div>

                <div className="flex flex-col gap-2 pl-4 border-l-2 border-gray-400/70">
                  <label className="text-sm font-medium">
                    面试背景资料
                    <span className="ml-2 text-xs font-light">
                      保存在本机；建议删除电话、邮箱等不影响面试回答的敏感信息
                    </span>
                  </label>
                  <Textarea
                    value={interviewContext}
                    onChange={(event) => {
                      updateSetting('interviewContext', event.target.value)
                      if (shareInterviewContextWithAI) {
                        updateSetting('shareInterviewContextWithAI', false)
                      }
                    }}
                    placeholder="粘贴教育经历、实习职责、项目架构、个人贡献和真实成果。"
                    className="min-h-36 bg-white"
                    maxLength={12000}
                  />
                  <span className="text-right text-xs text-gray-500">
                    {interviewContext.length}/12000
                  </span>
                </div>

                <div className="flex flex-col gap-2 pl-4 border-l-2 border-gray-400/70">
                  <div className="flex items-center justify-between gap-4">
                    <label className="text-sm font-medium">
                      项目知识库（Markdown）
                      <span className="ml-2 text-xs font-light">
                        建议按本场面试上传 3–5 个，最多 {MAX_INTERVIEW_KNOWLEDGE_DOCUMENTS} 个
                        Markdown 文件（单个{' '}
                        {Math.round(MAX_INTERVIEW_KNOWLEDGE_DOCUMENT_CHARS / 10000)} 万字、总计{' '}
                        {Math.round(MAX_INTERVIEW_KNOWLEDGE_TOTAL_CHARS / 10000)}{' '}
                        万字）；仅面试模式使用
                      </span>
                    </label>
                    <div className="flex shrink-0 items-center gap-2">
                      {interviewKnowledgeBase.length > 0 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          onClick={handleClearKnowledgeFiles}
                          className="text-xs text-gray-500 hover:text-red-600"
                        >
                          清空
                        </Button>
                      )}
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void handleSelectKnowledgeFiles()}
                        disabled={
                          interviewKnowledgeBase.length >= MAX_INTERVIEW_KNOWLEDGE_DOCUMENTS
                        }
                        className="bg-white"
                      >
                        <Upload className="mr-1.5 h-4 w-4" />
                        上传 Markdown
                      </Button>
                    </div>
                  </div>

                  {interviewKnowledgeBase.length > 0 && (
                    <div className="space-y-1.5">
                      {interviewKnowledgeBase.map((document) => (
                        <div
                          key={document.id}
                          className="flex items-center justify-between gap-2 rounded-md border border-gray-300 bg-white px-3 py-2 text-sm"
                        >
                          <div className="flex min-w-0 items-center gap-2">
                            <FileText className="h-4 w-4 shrink-0 text-gray-500" />
                            <span className="truncate" title={document.name}>
                              {document.name}
                            </span>
                            <span className="shrink-0 text-xs text-gray-400">
                              {document.content.length.toLocaleString()} 字
                            </span>
                          </div>
                          <div className="flex shrink-0 items-center gap-1">
                            <button
                              type="button"
                              className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 hover:text-blue-600"
                              title="预览 Markdown 内容"
                              onClick={() => {
                                setKnowledgePreviewId(document.id)
                                setKnowledgePreviewQuery('')
                              }}
                            >
                              <Eye className="h-3.5 w-3.5" />
                              预览
                            </button>
                            <Switch
                              className="scale-75"
                              checked={document.enabled !== false}
                              onCheckedChange={(checked) =>
                                updateSetting(
                                  'interviewKnowledgeBase',
                                  interviewKnowledgeBase.map((item) =>
                                    item.id === document.id ? { ...item, enabled: checked } : item
                                  )
                                )
                              }
                              aria-label={`${document.name} ${document.enabled !== false ? '已启用' : '已停用'}`}
                            />
                            <button
                              type="button"
                              className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-red-600"
                              title="移除文件"
                              onClick={() => handleRemoveKnowledgeFile(document.id)}
                            >
                              <Trash2 className="h-4 w-4" />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-4 border-t border-gray-300/70 pt-2">
                    <label className="text-sm font-medium">
                      优先使用知识库
                      <span className="ml-2 text-xs font-light">
                        面试问题涉及项目或经历时，优先依据已启用的 Markdown 资料回答
                      </span>
                    </label>
                    <Switch
                      className="scale-y-90"
                      checked={interviewKnowledgeBaseEnabled && interviewKnowledgeBase.length > 0}
                      disabled={interviewKnowledgeBase.length === 0}
                      onCheckedChange={(checked) =>
                        updateSetting('interviewKnowledgeBaseEnabled', checked)
                      }
                    />
                  </div>
                  <span className="text-xs text-gray-500">
                    开启后，启用的资料会随面试请求发送到当前配置的 AI 接口；资料只保存在本机设置中。
                  </span>
                  {knowledgeMessage && (
                    <span className="text-xs text-gray-500">{knowledgeMessage}</span>
                  )}
                </div>

                <div className="flex flex-col gap-3 pl-4 border-l-2 border-gray-400/70">
                  <div className="flex items-start justify-between gap-4">
                    <label className="text-sm font-medium">
                      固定项目选择
                      <span className="ml-2 text-xs font-light">
                        命中触发说法时强制用指定项目作答；规则原文注入提示词，不受知识库裁剪影响
                      </span>
                    </label>
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={addPinnedRule}
                      disabled={pinnedProjectRules.length >= MAX_PINNED_PROJECT_RULES}
                      className="shrink-0 bg-white"
                    >
                      <Plus className="mr-1.5 h-4 w-4" />
                      新增规则
                    </Button>
                  </div>

                  {pinnedProjectRules.length === 0 ? (
                    <span className="text-xs text-gray-500">
                      未设置。添加规则后，面试官问「最满意的项目」这类问题时，回答会锁定到你从知识库里选的已有项目。
                    </span>
                  ) : (
                    <div className="space-y-2">
                      {interviewKnowledgeBase.length === 0 && (
                        <span className="block text-xs text-amber-600">
                          项目知识库还是空的，先把每个项目各存成一份 Markdown
                          上传，下拉里才会有项目可选。
                        </span>
                      )}
                      {pinnedProjectRules.map((rule) => {
                        const isManual = manualProjectRuleIds.includes(rule.id)
                        const isUnknownProject =
                          !isManual &&
                          Boolean(rule.project.trim()) &&
                          !projectOptions.includes(rule.project)
                        return (
                          <div
                            key={rule.id}
                            className="space-y-2 rounded-md border border-gray-300 bg-white p-3"
                          >
                            <div className="flex items-center gap-2">
                              <Input
                                value={rule.keywords}
                                maxLength={MAX_PINNED_PROJECT_KEYWORD_CHARS}
                                onChange={(event) =>
                                  updatePinnedRule(rule.id, { keywords: event.target.value })
                                }
                                placeholder="触发说法，逗号分隔：最满意, 最有成就感, 最有挑战"
                                className="bg-white text-sm"
                              />
                              <button
                                type="button"
                                className="shrink-0 rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-red-600"
                                title="删除该规则"
                                onClick={() => removePinnedRule(rule.id)}
                              >
                                <Trash2 className="h-4 w-4" />
                              </button>
                            </div>
                            <Select
                              value={isManual ? MANUAL_PROJECT_OPTION : rule.project}
                              onValueChange={(value) => handleProjectSelect(rule, value)}
                            >
                              <SelectTrigger className="w-full bg-white text-sm">
                                <SelectValue placeholder="从知识库里选择项目" />
                              </SelectTrigger>
                              <SelectContent>
                                {projectOptions.map((name) => (
                                  <SelectItem key={name} value={name}>
                                    {name}
                                  </SelectItem>
                                ))}
                                {isUnknownProject && (
                                  <SelectItem value={rule.project}>
                                    {rule.project}（不在知识库中）
                                  </SelectItem>
                                )}
                                <SelectItem value={MANUAL_PROJECT_OPTION}>
                                  手动输入项目名…
                                </SelectItem>
                              </SelectContent>
                            </Select>
                            {isManual && (
                              <Input
                                value={rule.project}
                                maxLength={MAX_PINNED_PROJECT_NAME_CHARS}
                                onChange={(event) =>
                                  updatePinnedRule(rule.id, { project: event.target.value })
                                }
                                placeholder="手动输入项目名，写法要和知识库里一致"
                                className="bg-white text-sm"
                              />
                            )}
                            <Input
                              value={rule.note}
                              maxLength={MAX_PINNED_PROJECT_NOTE_CHARS}
                              onChange={(event) =>
                                updatePinnedRule(rule.id, { note: event.target.value })
                              }
                              placeholder="可选：固定说法，会原样照说"
                              className="bg-white text-sm"
                            />
                            {!rule.project.trim() ? (
                              <span className="text-xs text-amber-600">
                                还没选项目，这条规则不会生效
                              </span>
                            ) : (
                              <>
                                {rule.keywords.trim() ? (
                                  <span className="block text-xs text-gray-500">
                                    听到「{rule.keywords}」时用「{rule.project}」作答
                                  </span>
                                ) : (
                                  <span className="block text-xs text-gray-500">
                                    兜底规则：其他需要挑项目的提问都用「{rule.project}」作答
                                  </span>
                                )}
                                {isUnknownProject && (
                                  <span className="block text-xs text-amber-600">
                                    「{rule.project}
                                    」不在知识库里，回答只会是概括表述；建议把它单独存成一份
                                    Markdown 上传。
                                  </span>
                                )}
                              </>
                            )}
                          </div>
                        )
                      })}
                      <span className="block text-xs text-gray-500">
                        触发说法留空即兜底规则；命中时按填写顺序取最靠前的一条。下拉里的项目来自知识库文档名（已去掉
                        .md 后缀），给目标项目单独上传一份知识库，回答才有细节可讲。
                      </span>
                    </div>
                  )}
                </div>

                <Dialog
                  open={Boolean(knowledgePreviewDocument)}
                  onOpenChange={(open) => {
                    if (!open) {
                      setKnowledgePreviewId(null)
                      setKnowledgePreviewQuery('')
                    }
                  }}
                >
                  <DialogContent className="flex h-[min(80vh,720px)] max-w-[min(900px,calc(100%-2rem))] flex-col gap-3">
                    <DialogHeader>
                      <DialogTitle className="flex items-center gap-2 pr-6">
                        <FileText className="h-4 w-4 text-gray-500" />
                        {knowledgePreviewDocument?.name ?? 'Markdown 预览'}
                      </DialogTitle>
                      <DialogDescription>
                        查看本地保存的原始 Markdown 内容；搜索只在当前文件内进行。
                      </DialogDescription>
                    </DialogHeader>

                    <div className="flex items-center gap-2">
                      <div className="relative flex-1">
                        <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
                        <Input
                          value={knowledgePreviewQuery}
                          onChange={(event) => setKnowledgePreviewQuery(event.target.value)}
                          placeholder="搜索关键词..."
                          className="bg-white pl-8"
                          autoFocus
                        />
                      </div>
                      {normalizedKnowledgePreviewQuery && (
                        <span className="shrink-0 text-xs text-gray-500">
                          {knowledgePreviewMatchCount > 0
                            ? `找到 ${knowledgePreviewMatchCount} 处`
                            : '未找到'}
                        </span>
                      )}
                    </div>

                    <div className="min-h-0 flex-1 overflow-auto rounded-md border border-gray-300 bg-white p-4">
                      <pre className="whitespace-pre-wrap break-words font-mono text-xs leading-5 text-gray-700">
                        {knowledgePreviewDocument
                          ? knowledgePreviewSearchRegex
                            ? knowledgePreviewDocument.content
                                .split(knowledgePreviewSearchRegex)
                                .map((part, index) =>
                                  index % 2 === 1 ? (
                                    <mark
                                      key={`${part}-${index}`}
                                      className="rounded bg-yellow-200 px-0.5 text-gray-900"
                                    >
                                      {part}
                                    </mark>
                                  ) : (
                                    part
                                  )
                                )
                            : knowledgePreviewDocument.content
                          : '未找到该文件'}
                      </pre>
                    </div>
                  </DialogContent>
                </Dialog>

                <div className="flex items-center justify-between pl-4 border-l-2 border-amber-500/70">
                  <label className="text-sm font-medium">
                    允许发送手动背景资料
                    <span className="ml-2 text-xs font-light">
                      开启后，面试请求会将上方粘贴的文字发送到
                      {apiBaseURL ? ` ${apiBaseURL}` : ' OpenAI 默认接口'}；编辑资料后需重新确认
                    </span>
                  </label>
                  <Switch
                    className="scale-y-90"
                    checked={shareInterviewContextWithAI}
                    disabled={!hasInterviewContext}
                    onCheckedChange={(checked) =>
                      updateSetting('shareInterviewContextWithAI', checked)
                    }
                  />
                </div>
              </>
            )}
          </div>
        </div>

        {/* AI Settings */}
        <div className="bg-gray-300/80 rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4 flex items-center">
            <Bot className="h-5 w-5 mr-2" />
            AI 设置
          </h2>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">
                API Base URL
                <span className="ml-2 text-xs font-light">
                  如硅基流动为 https://api.siliconflow.cn/v1
                </span>
              </label>
              <input
                type="text"
                value={apiBaseURL}
                onChange={(e) => {
                  updateSetting('apiBaseURL', e.target.value)
                  if (shareInterviewContextWithAI) {
                    updateSetting('shareInterviewContextWithAI', false)
                  }
                }}
                className="w-60 px-3 py-2 border border-gray-300 rounded-md bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="可为空，默认使用 OpenAI 的 API"
              />
            </div>

            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">API Key</label>
              <div className="flex items-center w-60">
                <input
                  type={showApiKey ? 'text' : 'password'}
                  value={apiKey}
                  onChange={(e) => updateSetting('apiKey', e.target.value)}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-l-md bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="输入 API Key"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setShowApiKey(!showApiKey)}
                  className="border border-l-0 rounded-l-none rounded-r-md h-9 w-9 hover:border-none"
                >
                  {showApiKey ? <Eye className="h-4 w-4" /> : <EyeOff className="h-4 w-4" />}
                </Button>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">
                Model
                <span className="ml-2 text-xs font-light">
                  这里列了几个流行的国内和国外模型，请自行确认你的平台是否支持
                </span>
              </label>
              <SelectModel value={model} onChange={(val) => updateSetting('model', val)} />
            </div>

            <div className="pt-4 border-t border-gray-400/40 space-y-4">
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">
                  备用模型
                  <span className="ml-2 text-xs font-light">
                    首选模型报错、60 秒无响应或返回空内容时自动接管；只在本次回答还没输出时切换
                  </span>
                </label>
                <Switch
                  className="scale-y-90"
                  checked={fallbackModelEnabled}
                  onCheckedChange={(checked) => updateSetting('fallbackModelEnabled', checked)}
                />
              </div>

              {fallbackModelEnabled && (
                <>
                  <div className="flex items-center justify-between pl-4 border-l-2 border-blue-500/70">
                    <label className="text-sm font-medium">
                      备用 API Base URL
                      <span className="ml-2 text-xs font-light">
                        留空沿用首选，填别的平台才能扛住供应商故障
                      </span>
                    </label>
                    <input
                      type="text"
                      value={fallbackApiBaseURL}
                      onChange={(e) => updateSetting('fallbackApiBaseURL', e.target.value)}
                      className="w-60 px-3 py-2 border border-gray-300 rounded-md bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                      placeholder="留空则使用首选接口"
                    />
                  </div>

                  <div className="flex items-center justify-between pl-4 border-l-2 border-blue-500/70">
                    <label className="text-sm font-medium">
                      备用 API Key
                      <span className="ml-2 text-xs font-light">留空沿用首选</span>
                    </label>
                    <div className="flex items-center w-60">
                      <input
                        type={showFallbackApiKey ? 'text' : 'password'}
                        value={fallbackApiKey}
                        onChange={(e) => updateSetting('fallbackApiKey', e.target.value)}
                        className="flex-1 px-3 py-2 border border-gray-300 rounded-l-md bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                        placeholder="留空则使用首选 Key"
                      />
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => setShowFallbackApiKey(!showFallbackApiKey)}
                        className="border border-l-0 rounded-l-none rounded-r-md h-9 w-9 hover:border-none"
                      >
                        {showFallbackApiKey ? (
                          <Eye className="h-4 w-4" />
                        ) : (
                          <EyeOff className="h-4 w-4" />
                        )}
                      </Button>
                    </div>
                  </div>

                  <div className="flex items-center justify-between pl-4 border-l-2 border-blue-500/70">
                    <label className="text-sm font-medium">
                      备用 Model
                      <span className="ml-2 text-xs font-light">不填则不会启用备用</span>
                    </label>
                    <SelectModel
                      value={fallbackModel}
                      onChange={(val) => updateSetting('fallbackModel', val)}
                    />
                  </div>
                </>
              )}
            </div>
          </div>
        </div>
        {/* Transcription Settings */}
        <div className="bg-gray-300/80 rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4 flex items-center">
            <Mic className="h-5 w-5 mr-2" />
            语音转录
          </h2>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">
                百炼平台 API Key
                <span className="ml-2 text-xs font-light">
                  从阿里云
                  <a
                    href="https://bailian.console.aliyun.com/cn-beijing?tab=model#/api-key"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="px-0.5 text-blue-700 hover:underline"
                  >
                    百炼平台
                  </a>
                  获取，如不需要语音转录功能可跳过
                </span>
              </label>
              <div className="flex items-center w-60">
                <input
                  type={showDashscopeApiKey ? 'text' : 'password'}
                  value={dashscopeApiKey}
                  onChange={(e) => updateSetting('dashscopeApiKey', e.target.value)}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-l-md bg-white text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  placeholder="输入百炼平台 API Key"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setShowDashscopeApiKey(!showDashscopeApiKey)}
                  className="border border-l-0 rounded-l-none rounded-r-md h-9 w-9 hover:border-none"
                >
                  {showDashscopeApiKey ? (
                    <Eye className="h-4 w-4" />
                  ) : (
                    <EyeOff className="h-4 w-4" />
                  )}
                </Button>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">
                收音来源
                <span className="ml-2 text-xs font-light">
                  远程面试请选择系统音频；麦克风主要会录到你自己
                </span>
              </label>
              <Select
                value={audioCaptureSource}
                onValueChange={(value: 'system' | 'microphone') =>
                  updateSetting('audioCaptureSource', value)
                }
              >
                <SelectTrigger className="w-60 bg-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="system">系统音频（推荐，识别面试官）</SelectItem>
                  <SelectItem value="microphone">麦克风（识别本机声音）</SelectItem>
                </SelectContent>
              </Select>
            </div>

            {audioCaptureSource === 'microphone' && (
              <div className="flex items-center justify-between pl-4 border-l-2 border-gray-400/70">
                <label className="text-sm font-medium">麦克风设备</label>
                <Select
                  value={audioInputDeviceId || 'default'}
                  onValueChange={(value) =>
                    updateSetting('audioInputDeviceId', value === 'default' ? '' : value)
                  }
                >
                  <SelectTrigger className="w-60 bg-white">
                    <SelectValue placeholder="默认麦克风" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="default">默认麦克风</SelectItem>
                    {audioDevices
                      .filter((device) => device.kind === 'audioinput')
                      .map((device) => (
                        <SelectItem key={device.deviceId} value={device.deviceId}>
                          {device.label || device.deviceId}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">
                识别增益
                <span className="ml-2 text-xs font-light">
                  面试官声音较小时可提高；过高可能放大杂音
                </span>
              </label>
              <Select
                value={String(transcriptionInputGain)}
                onValueChange={(value) => updateSetting('transcriptionInputGain', Number(value))}
              >
                <SelectTrigger className="w-60 bg-white">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="1">1×（原始音量）</SelectItem>
                  <SelectItem value="1.5">1.5×（推荐）</SelectItem>
                  <SelectItem value="2">2×（声音较小）</SelectItem>
                  <SelectItem value="3">3×（声音很小）</SelectItem>
                  <SelectItem value="4">4×（极低音量）</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">
                问题结束判定时间
                <span className="ml-2 text-xs font-light">
                  停顿超过此值才认为问完，默认 2 秒；调小更快、调大更稳
                </span>
              </label>
              <TriggerDelayInput
                valueMs={interviewTriggerDelayMs}
                onChange={(value) => updateSetting('interviewTriggerDelayMs', value)}
              />
            </div>

            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">
                提问后静音
                <span className="ml-2 text-xs font-light">
                  提交问题后暂停识别，避免同一句话的尾音打断回答；0 表示不静音，默认 3 秒
                </span>
              </label>
              <TriggerMuteInput
                valueMs={interviewTriggerMuteMs}
                onChange={(value) => updateSetting('interviewTriggerMuteMs', value)}
              />
            </div>

            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">
                音频输出设备
                <span className="ml-2 text-xs font-light">通常保持默认，不影响收音来源</span>
              </label>
              <Select
                value={audioOutputDeviceId || 'default'}
                onValueChange={(val) =>
                  updateSetting('audioOutputDeviceId', val === 'default' ? '' : val)
                }
              >
                <SelectTrigger className="w-60 bg-white">
                  <SelectValue placeholder="默认设备" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="default">默认设备</SelectItem>
                  {audioDevices
                    .filter((d) => d.kind === 'audiooutput')
                    .map((d) => (
                      <SelectItem key={d.deviceId} value={d.deviceId}>
                        {d.label || d.deviceId}
                      </SelectItem>
                    ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
        <div className="bg-gray-300/80 rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4 flex items-center">
            <SquareTerminal className="h-5 w-5 mr-2" />
            解题设置
          </h2>

          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">
                使用场景
                <span className="ml-2 text-xs font-light">
                  选择场景后可编辑对应的系统提示词，修改会自动保存；也可新增自己的场景
                </span>
              </label>
              <div className="flex flex-wrap items-center gap-2 mt-2">
                {scenes.map((scene) => (
                  <div
                    key={scene.id}
                    className={cn(
                      'group flex items-center rounded-full border text-sm transition-colors cursor-pointer select-none',
                      scene.id === activeSceneId
                        ? 'bg-blue-600 border-blue-600 text-white'
                        : 'bg-white border-gray-300 hover:border-blue-400'
                    )}
                    onClick={() => setActiveScene(scene.id)}
                  >
                    <span className={cn('py-1 pl-3', scene.isPreset ? 'pr-3' : 'pr-1')}>
                      {scene.name}
                    </span>
                    {!scene.isPreset && (
                      <button
                        className="mr-1.5 p-0.5 rounded-full opacity-60 hover:opacity-100 hover:bg-black/10"
                        title="删除该场景"
                        onClick={(e) => {
                          e.stopPropagation()
                          setSceneToDelete(scene.id)
                        }}
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                ))}
                <button
                  className="flex items-center gap-1 rounded-full border border-dashed border-gray-400 bg-transparent px-3 py-1 text-sm text-gray-600 hover:border-blue-500 hover:text-blue-600 transition-colors"
                  onClick={() => setAddSceneOpen(true)}
                >
                  <Plus className="h-3.5 w-3.5" />
                  新增场景
                </button>
              </div>
            </div>

            <div>
              <label className="text-sm font-medium">
                限定代码语言
                <span className="ml-2 text-xs font-light">
                  手撕代码时固定用一种语言作答，避免说「任意语言」时输出你不会的语言
                </span>
              </label>
              <div className="mt-2">
                <CodeLanguageInput
                  value={codeLanguage}
                  onChange={(language) => updateSetting('codeLanguage', language)}
                />
              </div>
              <span className="mt-1 block text-xs text-gray-500">
                题目或面试官明确指定了语言时以题目为准；留空表示不限制。
              </span>
            </div>

            {activeScene && (
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-sm font-medium">
                    系统提示词
                    <span className="ml-2 text-xs font-light">「{activeScene.name}」场景</span>
                  </label>
                  {activeScene.isPreset && (
                    <button
                      className="flex items-center gap-1 text-xs text-gray-600 hover:text-gray-900 transition-colors"
                      title="恢复该场景的默认提示词"
                      onClick={handleResetScenePrompt}
                    >
                      <RotateCcw className="h-3 w-3" />
                      恢复默认
                    </button>
                  )}
                </div>
                <Textarea
                  value={activeScene.prompt}
                  onChange={(e) => updateScenePrompt(activeScene.id, e.target.value)}
                  placeholder="请输入该场景的系统提示词, 示例: 你是一个解题助手, 请根据「截图」和「语音转录内容」给出相关回答。"
                  className="w-full min-h-24 max-h-100 bg-white"
                  rows={6}
                />
              </div>
            )}
          </div>
        </div>

        {/* Add scene dialog */}
        <Dialog open={addSceneOpen} onOpenChange={setAddSceneOpen}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>新增场景</DialogTitle>
              <DialogDescription>创建后可为该场景编写专属的系统提示词</DialogDescription>
            </DialogHeader>
            <Input
              value={newSceneName}
              onChange={(e) => setNewSceneName(e.target.value)}
              placeholder="场景名称，如：数学考试"
              maxLength={20}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Enter') handleAddScene()
              }}
            />
            <DialogFooter>
              <Button variant="outline" onClick={() => setAddSceneOpen(false)}>
                取消
              </Button>
              <Button onClick={handleAddScene} disabled={!newSceneName.trim()}>
                创建
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Delete scene confirm dialog */}
        <Dialog open={!!sceneToDelete} onOpenChange={(open) => !open && setSceneToDelete(null)}>
          <DialogContent className="sm:max-w-sm">
            <DialogHeader>
              <DialogTitle>删除场景</DialogTitle>
              <DialogDescription>
                确定删除场景「{deletingScene?.name}」吗？其提示词内容将一并删除，且无法恢复。
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={() => setSceneToDelete(null)}>
                取消
              </Button>
              <Button
                variant="destructive"
                onClick={() => {
                  if (sceneToDelete) removeScene(sceneToDelete)
                  setSceneToDelete(null)
                }}
              >
                删除
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>

        {/* Appearance Settings */}
        <div className="bg-gray-300/80 rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4 flex items-center">
            <Palette className="h-5 w-5 mr-2" />
            界面设置
          </h2>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">
                窗口透明度
                <span className="ml-2 text-xs font-light">
                  拖动可实时预览效果，也可在主界面用快捷键调节
                </span>
              </label>
              <div className="w-60 flex items-center gap-2">
                <span className="text-xs whitespace-nowrap">透明</span>
                <Slider
                  min={OPACITY_MIN}
                  max={OPACITY_MAX}
                  step={OPACITY_STEP}
                  value={[opacity]}
                  onValueChange={(value) => {
                    updateSetting('opacity', value[0])
                    document.body.style.opacity = value[0].toString()
                  }}
                />
                <span className="text-xs whitespace-nowrap">不透明</span>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">
                允许调整主窗口大小
                <span className="ml-2 text-xs font-light">
                  关闭后鼠标移到窗口边缘不再出现缩放光标
                </span>
              </label>
              <Switch
                className="scale-y-90"
                checked={resizable}
                onCheckedChange={(checked) => updateSetting('resizable', checked)}
              />
            </div>

            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">
                悬浮工具条
                <span className="ml-2 text-xs font-light">
                  在主窗口上方显示一排按钮，鼠标停留即触发，替代快捷键操作，详见帮助中心
                </span>
              </label>
              <Switch
                className="scale-y-90"
                checked={showOverlayToolbar}
                onCheckedChange={(checked) => updateSetting('showOverlayToolbar', checked)}
              />
            </div>

            {showOverlayToolbar && (
              <div className="flex items-center justify-between pl-4 border-l-2 border-gray-400/70">
                <label className="text-sm font-medium">
                  悬停触发
                  <span className="ml-2 text-xs font-light">
                    工具条不接收鼠标点击，停留触发是唯一方式；停留过程中按钮下方有进度条
                  </span>
                </label>
                <Select
                  value={String(toolbarHoverDelay)}
                  onValueChange={(val) => updateSetting('toolbarHoverDelay', Number(val))}
                >
                  <SelectTrigger className="w-60 bg-white">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="500">停留 0.5 秒</SelectItem>
                    <SelectItem value="1000">停留 1 秒</SelectItem>
                    <SelectItem value="2000">停留 2 秒</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            )}
          </div>
        </div>

        {/* Shortcuts Settings */}
        <div className="bg-gray-300/80 rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4 flex items-center">
            <Keyboard className="h-5 w-5 mr-2" />
            快捷键设置
            <div className="text-sm font-light ml-2 mt-1">
              只有在主界面时，快捷键才有效。当前页面仅部分快捷键生效。
            </div>
            <ResetDefaultShortcuts />
          </h2>
          <CustomShortcuts />
        </div>

        {/* Screenshot Save Settings */}
        <div className="bg-gray-300/80 rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4 flex items-center">
            <FolderOpen className="h-5 w-5 mr-2" />
            保存截图
          </h2>

          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">
                保存截图到本地
                <span className="ml-2 text-xs font-light">
                  开启后，每次截图都会自动保存到指定目录
                </span>
              </label>
              <Switch
                className="scale-y-90"
                checked={screenshotAutoSave}
                onCheckedChange={(checked) => updateSetting('screenshotAutoSave', checked)}
              />
            </div>
            {screenshotAutoSave && (
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">
                  保存目录
                  <span className="ml-2 text-xs font-light">
                    可点击右侧内容重新选择保存目录（选择弹窗可能被本窗口遮挡）
                  </span>
                </label>
                <button
                  className="text-xs text-gray-600 max-w-48 truncate hover:text-gray-900 cursor-pointer transition-colors"
                  title="点击选择保存目录"
                  onClick={async () => {
                    const dir = await window.api.selectScreenshotDir()
                    if (dir) updateSetting('screenshotDir', dir)
                  }}
                >
                  {screenshotDir || '默认: 图片/InterviewCoder'}
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Interview Record Settings */}
        <div className="bg-gray-300/80 rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4 flex items-center">
            <FileText className="h-5 w-5 mr-2" />
            保存面试记录
          </h2>

          <div className="space-y-4">
            <p className="text-sm">
              面试模式下每次开启软件产生的问答会单独存成一份 Markdown 记录（同一天多份按 -1、-2
              编号）；关闭软件时可以改文件名，没有问答的会话不会生成文件。
            </p>
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium">
                保存目录
                <span className="ml-2 text-xs font-light">
                  可点击右侧内容重新选择保存目录（选择弹窗可能被本窗口遮挡）
                </span>
              </label>
              <button
                className="text-xs text-gray-600 max-w-48 truncate hover:text-gray-900 cursor-pointer transition-colors"
                title="点击选择保存目录"
                onClick={async () => {
                  const dir = await window.api.selectRecordDir()
                  if (dir) updateSetting('recordDir', dir)
                }}
              >
                {recordDir || '默认: 文档/interview'}
              </button>
            </div>
          </div>
        </div>

        {/* Privacy Settings */}
        <div className="bg-gray-300/80 rounded-lg p-6">
          <h2 className="text-lg font-semibold mb-4 flex items-center">
            <Shield className="h-5 w-5 mr-2" />
            隐私设置
          </h2>

          <div className="space-y-4">
            <p className="text-sm">
              此应用为本地应用，采集的图片直接上传到您配置的 OpenAI
              等大模型公司，不存在隐私泄露风险。
            </p>
            {isMac && (
              <div className="flex items-center justify-between">
                <label className="text-sm font-medium">
                  隐藏 Dock 图标
                  <span className="ml-2 text-xs font-light">
                    开启后不在程序坞和 Cmd+Tab 切换器中显示，仅可通过快捷键唤起窗口
                  </span>
                </label>
                <Switch
                  className="scale-y-90"
                  checked={hideDockIcon}
                  onCheckedChange={(checked) => updateSetting('hideDockIcon', checked)}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  )
}
