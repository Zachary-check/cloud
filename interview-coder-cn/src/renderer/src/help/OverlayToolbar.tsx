import { PanelTop } from 'lucide-react'
import ShortcutRenderer from '@/components/ShortcutRenderer'
import { useSettingsStore } from '@/lib/store/settings'
import { useShortcutsStore } from '@/lib/store/shortcuts'
import { getToolbarActions, resolveToolbarAction } from '@/lib/toolbar-actions'
import { HelpSection } from './components'

export function OverlayToolbarHelp() {
  const { shortcuts } = useShortcutsStore()
  // The mode entry follows the live mode here too, so the list matches the bar
  const workMode = useSettingsStore((state) => state.workMode)
  const actions = getToolbarActions(workMode).map((entry) => resolveToolbarAction(entry, workMode))

  return (
    <HelpSection Icon={PanelTop} title="悬浮工具条" description="鼠标停留即触发，替代快捷键操作">
      <p className="text-gray-700">
        工具条悬浮在主窗口正上方，跟随主窗口移动、随主窗口一起隐藏，透明度也与主窗口保持一致，
        并且和主窗口一样在共享屏幕时对方不可见。它主要用于两种场景：一是快捷键与考试/面试软件冲突或注册失败时，
        二是不希望通过键盘触发操作时。
      </p>
      <div className="overlay-toolbar w-fit">
        {actions.map(({ action, Icon }) => (
          <div key={action} className="flex size-7 items-center justify-center">
            <Icon className="size-4" />
          </div>
        ))}
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
        {actions.map(({ action, Icon, label }) => (
          <div
            key={action}
            className="flex items-center gap-2 rounded border border-gray-400 px-2 py-1"
          >
            <Icon className="h-4 w-4 shrink-0" />
            <span className="text-sm">{label}</span>
            {shortcuts[action] && (
              <ShortcutRenderer shortcut={shortcuts[action].key} className="ml-auto select-none" />
            )}
          </div>
        ))}
      </div>
      <ul className="space-y-1 text-sm text-gray-700 list-disc list-inside">
        <li>
          工具条不接收鼠标：鼠标经过它时光标保持下面页面原本的形状（手型还是手型），
          不会因为这里浮着一个窗口就变回指针——共享屏幕时看不出多了一个窗口。
        </li>
        <li>
          开启「鼠标穿透」后主窗口也不响应鼠标，此时光标完全由下面的页面决定；
          工具条仍可用悬停触发，它也是点不回窗口时的那条退路。
        </li>
        <li>
          因此按钮不能点击，只能悬停触发：鼠标在按钮上停留一段时间即触发，全程不产生点击。
          停留过程中按钮下方会有进度条，中途移开即取消；触发后需移开再移回才会再次触发。
          停留时长在「设置 → 界面设置 → 悬停触发」中调整，它是唯一可调的触发方式。
        </li>
        <li>点击会直接穿透到下面的页面，等于点在你正在做的那道题上——不要在工具条上点击。</li>
        <li>工具条尺寸固定，不能拖动边缘调整。</li>
        <li>隐藏/显示主窗口没有做成按钮：窗口隐藏后工具条也会一起隐藏，只能用快捷键唤回。</li>
        <li>
          双机位模式显示精简工具条：截图、向上滚动、向下滚动、切换鼠标穿透。
          开启穿透后仍可悬停使用；每次触发后移开，再移回可继续滚动。
          其他模式的最后一个按钮在笔试与面试之间切换（麦克风 = 面试，铅笔 = 笔试）。
        </li>
        <li>如不需要，可在「设置 → 界面设置 → 悬浮工具条」中关闭。</li>
      </ul>
    </HelpSection>
  )
}
